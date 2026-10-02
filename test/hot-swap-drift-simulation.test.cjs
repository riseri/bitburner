const test=require('node:test'),assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');
const {loadScript}=require('./helpers.cjs');

test('real yielding retunes commit while live action durations keep improving', {timeout:120000}, async()=>{
    const sim=new NetscriptSimulation({target:'joesguns',weakenTime:16000,levelPerMinute:50,hostCount:0,
        mainServer:{max:600e6,money:600e6,sec:3,min:3,required:1},
        flags:{target:'joesguns','max-targets':1,'max-batch-rate':4,'max-launches':64,gap:100}});
    sim.hosts.set('home',{ram:65536,cores:5});sim.hosts.set('public-ram',{ram:4096,cores:1});
    const duration=sim.duration.bind(sim);
    // Model a continuously increasing speed bonus in both API observations and
    // actual worker calls. The old exact-equality preflight can never commit it.
    sim.duration=(phase,target)=>duration(phase,target)/(1+(sim.clock.now-sim.start)/1800000);
    const run=loadScript('lib/target-pipelines.js',sim.clock).runTargetPipelines;
    sim.daemon=loadScript('daemon.js',sim.clock,{runTargetPipelines:async(ns,setup,api)=>{
        const render=api.renderSchedulerDashboard;api.renderSchedulerDashboard=(ns,pool)=>{sim.pool=pool;render(ns,pool);};
        return run(ns,setup,api);
    }});
    sim.run();await sim.clock.runUntil(sim.start+10*60000);
    assert.deepEqual(sim.errors.map(String),[]);
    const p=sim.pool.pipelines.get('joesguns');
    assert.ok(p.hotSwaps.completed>=1,JSON.stringify({swaps:p.hotSwaps,last:p.lastSwap,shadow:p.shadow?.reason}));
    assert.ok(p.hotSwaps.aborted<30,'small ongoing duration changes must not cause a permanent two-second abort loop');
    assert.ok(p.tunedLevel>450);assert.equal(p.stats.restarts,0);
    assert.equal(Object.values(p.stats.misses).reduce((n,x)=>n+x,0),0);
    assert.equal(sim.killed.filter(k=>k.phase==='H').length,0);
    for(let at=sim.start+60000;at+30000<sim.clock.now;at+=30000)
        assert.ok(sim.paid.some(p=>p.at>=at&&p.at<at+30000),'retuning keeps earning through every observation window');
    assert.ok(sim.actions.filter(a=>['H','G','W1','W2'].includes(a.phase))
        .every(a=>a.startSec<=sim.servers.get(a.target).min+.001));
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    console.log(JSON.stringify({swaps:p.hotSwaps,tunedLevel:p.tunedLevel,income60:sim.summary().income60}));
});
