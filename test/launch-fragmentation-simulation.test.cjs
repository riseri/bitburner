const test=require('node:test');
const assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');
const {loadScript}=require('./helpers.cjs');

function fleet(flags={'max-targets':1}) {
    const sim=new NetscriptSimulation({target:'phantasy',weakenTime:78000,hostCount:25,levelPerMinute:1,
        mainServer:{max:600e6,money:600e6,sec:7,min:7,required:30,chance:1},flags});
    sim.baseLevel=409;
    for(const h of sim.hosts.values())if(h.ram>128)h.ram=16384;
    // Small upgraded Hacknet servers can have better cores than purchased hosts.
    for(let i=0;i<20;i++)sim.hosts.set('hacknet-'+i,{ram:64,cores:2});
    return sim;
}

function sound(sim) {
    assert.deepEqual(sim.errors.map(String),[]);assert.deepEqual(sim.misses,[]);assert.deepEqual(sim.killed,[]);
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    let left=0;
    for(let right=0;right<sim.launches.length;right++) {
        while(sim.launches[left].at<=sim.launches[right].at-1000)left++;
        assert.ok(right-left+1<=32,'actual rolling launch rate must retain the default cap');
    }
    const finalW2=new Map();
    for(const e of sim.completions)if(e.phase==='W2')finalW2.set(e.batchId,e);
    assert.ok(finalW2.size>100);
    assert.ok([...finalW2.values()].every(e=>e.moneyAfter>=sim.server.max*.995&&e.securityAfter<=sim.server.min+.02));
}

test('mixed-core fleet earns at planned cadence with supervisor arguments and default launch limits',async()=>{
    const sim=fleet({'home-reserve':1017.55,'fleet-port':19});
    sim.hosts.set('home',{ram:1024,cores:8});
    sim.run();await sim.clock.runUntil(sim.start+240000);sound(sim);
    const lane=sim.getPort(17).peek().pipelines[0];
    assert.ok(lane.income60>200e6);assert.ok(lane.batchRate>2);
    assert.ok(Math.abs(lane.batchRate-lane.modelBatchRate)<.05);
    assert.equal(lane.idleRetunes,0);assert.equal(lane.admissionSkips,0);
    assert.equal(lane.restarts,0);assert.equal(lane.fallback,0);
});

test('sparse fragmented lane and waiting hot swap recover when compact placement becomes available',async()=>{
    const sim=fleet(),multi=loadScript('lib/target-pipelines.js',sim.clock);
    for(let i=20;i<60;i++)sim.hosts.set('hacknet-'+i,{ram:64,cores:2});
    let compactEnabled=false;
    // Reproduce the previous placement policy in the same running controller,
    // then enable the fallback. This exercises recovery, not just clean startup.
    sim.daemon=loadScript('daemon.js',sim.clock,{runTargetPipelines:(ns,setup,api)=>{
        const reserve=api.reserveBatch;
        api.reserveBatch=(...args)=>{
            if(!compactEnabled&&args[6].compactPlacement)args[6]={...args[6],compactPlacement:false};
            return reserve(...args);
        };
        return multi.runTargetPipelines(ns,setup,api);
    }});
    sim.run();await sim.clock.runUntil(sim.start+180000);
    const stalled=sim.getPort(17).peek().pipelines[0];
    assert.ok(stalled.batchRate<.2);assert.ok(stalled.workerRam<5000);
    assert.ok(stalled.admissionSkips>300);assert.equal(stalled.allocationFails,0);
    sim.level=()=>600;
    await sim.clock.runUntil(sim.start+210000);
    assert.equal(sim.getPort(17).peek().pipelines[0].shadow.state,'PREFLIGHT');
    assert.ok(sim.snapshots.some(s=>s.pipelines[0].shadow?.reason.includes('income gap')));
    compactEnabled=true;
    await sim.clock.runUntil(sim.start+430000);sound(sim);
    const lane=sim.getPort(17).peek().pipelines[0];
    assert.equal(lane.epoch,stalled.epoch);assert.equal(lane.idleRetunes,stalled.idleRetunes);
    assert.equal(lane.generation,2);assert.equal(lane.hotSwaps.completed,1);assert.equal(lane.shadow,null);
    assert.equal(lane.restarts,0);assert.equal(lane.fallback,0);assert.equal(lane.admissionReason,'');
    assert.ok(lane.income60>200e6);assert.ok(Math.abs(lane.batchRate-lane.modelBatchRate)<.05);
    for(let at=sim.start+300000;at<sim.start+420000;at+=10000)
        assert.ok(sim.paid.some(p=>p.at>=at&&p.at<at+10000),'restored income must continue');
});
