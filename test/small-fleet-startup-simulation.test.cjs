const test=require('node:test');
const assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');

for(const homeReserve of [8,96]) test(`356 GB reset startup coalesces rising skill and keeps paying with ${homeReserve} GB reserved`,async()=>{
    const sim=new NetscriptSimulation({target:'n00dles',weakenTime:78000,hostCount:7,levelPerMinute:0,
        mainServer:{max:1.75e6,money:1.75e6,sec:1,min:1,required:1,chance:1},
        flags:{'max-targets':1,'home-reserve':homeReserve}});
    sim.baseLevel=10;
    let level=10;sim.level=()=>level;
    // Isolate scheduling continuity from failed-Hack payout randomness.
    sim.random=()=>.1;
    for(const [name,host]of sim.hosts)if(name!=='home')host.ram=32;
    sim.hosts.set('rooted',{ram:4,cores:1});
    for(const [at,value]of [[15000,30],[30000,50],[45000,66]])sim.clock.timer(at,()=>level=value);
    sim.run();await sim.clock.runUntil(sim.start+360000);
    assert.deepEqual(sim.errors.map(String),[]);assert.deepEqual(sim.misses,[]);assert.deepEqual(sim.killed,[]);
    const lane=sim.getPort(17).peek().pipelines[0];
    assert.equal(lane.generation,2);assert.equal(lane.hotSwaps.completed,1);
    assert.equal(lane.lastSwap.newLevel,66);assert.equal(lane.generations.length,1);
    assert.equal(lane.shadow,null);assert.equal(lane.admissionReason,'');
    assert.equal(lane.restarts,0);assert.equal(lane.fallback,0);assert.equal(lane.idleRetunes,0);
    assert.ok(lane.allocationFails<=2,'occasional transition pressure must not become persistent starvation');
    assert.ok(lane.income60>2000);assert.ok(Math.abs(lane.batchRate-lane.modelBatchRate)<.02);
    assert.ok(sim.paid[0].at-sim.start<81000,'first payout follows one initial action warmup');
    for(let i=1;i<sim.paid.length;i++)assert.ok(sim.paid[i].at-sim.paid[i-1].at<15000,'no minute-long income holes');
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    const finalW2=new Map();for(const e of sim.completions)if(e.phase==='W2')finalW2.set(e.batchId,e);
    assert.ok([...finalW2.values()].every(e=>e.moneyAfter>=sim.server.max*.995&&e.securityAfter<=sim.server.min+.02));
});
