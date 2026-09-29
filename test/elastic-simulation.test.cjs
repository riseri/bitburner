const test=require('node:test'),assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');
function profile(limit) {
    return {target:'alpha',weakenTime:12000,levelPerMinute:0,hostCount:12,
        mainServer:{max:1e9,money:1e9,sec:3,min:3,required:10},
        flags:{target:'alpha','max-targets':limit,'max-batch-rate':8,'max-launches':128,gap:200},
        backgroundTargets:{beta:{max:2e9,money:2e9},gamma:{max:3e9,money:3e9},delta:{max:4e9,money:4e9}}};
}
for(const limit of [3,4,'auto']) test(`elastic ${limit}: multiple lanes earn without harming ownership or HWGW order`,{timeout:180000},async()=>{
    const sim=new NetscriptSimulation(profile(limit));sim.run();await sim.clock.runUntil(sim.start+22*60000);
    assert.deepEqual(sim.errors.map(String),[]);
    const status=sim.getPort(17).peek();
    assert.equal(status.pipelines.length,limit==='auto'?4:limit,JSON.stringify(status));
    for(const lane of status.pipelines){assert.equal(lane.mode,'LIVE',JSON.stringify(lane));assert.notEqual(lane.role,'TRIAL',JSON.stringify(lane));assert.ok(lane.income60>0);assert.equal(lane.restarts,0);}
    assert.ok(sim.actions.filter(a=>['H','G','W1','W2'].includes(a.phase)).every(a=>a.startSec<=sim.servers.get(a.target).min+.001));
    assert.ok(sim.snapshots.every(s=>(s.capacity?.batchRate.used||0)<=8.001));
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    const outsider={pid:999999,script:'manual.js',host:'home',ram:1,threads:1,args:[],active:true};
    sim.processes.set(outsider.pid,outsider);sim.used.set('home',sim.used.get('home')+1);
    sim.controller.active=false;for(const hook of sim.exitHandlers)hook();
    assert.ok(sim.processes.has(outsider.pid));
    console.log(JSON.stringify({limit,lanes:status.pipelines.length,income60:status.income60,capacity:status.capacity.limitingFactor,steps:sim.clock.steps}));
});

test('automatic scheduling stays on one useful lane on a tiny no-Formulas fleet',{timeout:60000},async()=>{
    const sim=new NetscriptSimulation({target:'alpha',weakenTime:4000,levelPerMinute:0,hostCount:2,
        mainServer:{max:1e6,money:1e6,sec:1,min:1,required:1},flags:{'max-targets':'auto'},
        backgroundTargets:{weak:{max:1,money:1}}});
    for(const [name,host]of sim.hosts)if(name!=='home')host.ram=32;
    assert.equal(sim.ns(sim.controller).formulas,undefined);
    sim.run();await sim.clock.runUntil(sim.start+12*60000);
    assert.deepEqual(sim.errors.map(String),[]);
    const status=sim.getPort(17).peek();assert.equal(status.pipelines.length,1);assert.ok(status.income60>0);
});

test('four lanes isolate hard recovery and prepare a later replacement for the weakest lane',{timeout:180000},async()=>{
    const spec=profile(4);
    spec.backgroundTargets.richer={max:8e9,money:0,sec:8,required:5000};
    const sim=new NetscriptSimulation(spec);
    sim.clock.timer(22*60000,()=>{sim.servers.get('beta').sec=100;});
    sim.clock.timer(25*60000,()=>{sim.servers.get('richer').required=10;});
    sim.run();await sim.clock.runUntil(sim.start+38*60000);
    assert.deepEqual(sim.errors.map(String),[]);
    const status=sim.getPort(17).peek();assert.equal(status.pipelines.length,4,JSON.stringify(status));
    assert.ok(status.pipelines.some(p=>p.target==='richer'&&p.income60>0),JSON.stringify(status));
    assert.ok(status.retired.some(p=>p.target==='alpha'),JSON.stringify(status));
    for(const target of ['gamma','delta']) {
        assert.equal(sim.killed.filter(p=>p.target===target&&p.phase==='H').length,0,target);
        for(let t=sim.start+21*60000;t<sim.start+37*60000;t+=60000)
            assert.ok(sim.paid.some(p=>p.target===target&&p.at>=t&&p.at<t+60000),`${target} stopped earning`);
    }
    assert.ok(sim.launches.some(p=>p.target==='richer'&&p.phase.startsWith('background-')), 'replacement uses background preparation');
});
