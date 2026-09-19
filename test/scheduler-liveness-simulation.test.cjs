const test=require('node:test');
const assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');
const {loadScript}=require('./helpers.cjs');

function boot(options={}) {
    const sim=new NetscriptSimulation({target:'foodnstuff',hostCount:0,weakenTime:8000,levelPerMinute:30,
        mainServer:{max:50e6,money:50e6,sec:3,min:3,required:1},flags:{'max-targets':1},...options});
    sim.hosts.set('home',{ram:131072,cores:6});
    const run=loadScript('lib/target-pipelines.js',sim.clock).runTargetPipelines;
    sim.daemon=loadScript('daemon.js',sim.clock,{runTargetPipelines:async(ns,setup,api)=>{
        const render=api.renderSchedulerDashboard;
        api.renderSchedulerDashboard=(ns,pool)=>{sim.pool=pool;render(ns,pool);};
        return run(ns,setup,api);
    }});
    return sim;
}

test('post-reset sized fleet resumes an idle infeasible plan before productive-time gates are met',{timeout:60000},async()=>{
    const sim=boot();sim.run();await sim.clock.runUntil(sim.start+30000);
    const p=sim.pool.pipelines.get('foodnstuff');
    assert.ok(sim.paid.length>0);assert.ok(p.stats.pipeline.completed*p.runtime.plan.period<120000);
    const before=p.stats.money;
    // Deliberate stale-plan fault injection, not a claim that an augmentation
    // directly writes this field. It yields the reported clean/empty/no-miss state.
    p.runtime.plan={...p.runtime.plan,gEffective:1e9};
    await sim.clock.runUntil(sim.start+120000);
    assert.deepEqual(sim.errors.map(String),[]);
    assert.ok(p.idleRetunes>=1,'stale plan must not wait forever for income it can no longer earn');
    assert.ok(p.runtime.plan.gEffective<1e9);assert.ok(p.stats.money>before);
    assert.ok(sim.summary().income60>1e6,'income must resume, not just change the state label');
    assert.equal(p.stats.restarts,0);assert.equal(p.stats.recoveries,0);
    assert.equal(Object.values(p.stats.misses).reduce((n,v)=>n+v,0),0);
    assert.ok(p.running.size>0);assert.equal(sim.killed.length,0);
    console.log(JSON.stringify({idleRetunes:p.idleRetunes,income60:sim.summary().income60,misses:p.stats.misses}));
});

test('home-heavy fleet with rapid skill growth and cloud expansion keeps earning without idle retunes',{timeout:60000},async()=>{
    const sim=boot();
    for(let i=1;i<=12;i++)sim.clock.timer(i*15000,()=>{
        sim.hosts.set('cloud-'+i,{ram:1024,cores:1});
        const hosts=[...sim.hosts].map(([name,h])=>({name,maxRam:h.ram,cores:h.cores}));
        sim.getPort(19).clear();sim.getPort(19).tryWrite({type:'fleet-status',generatedAt:sim.clock.now,
            network:{hosts,servers:[...sim.hosts.keys(),sim.target],rooted:hosts.length+1}});
    });
    sim.run();await sim.clock.runUntil(sim.start+300000);
    const p=sim.pool.pipelines.get('foodnstuff');
    assert.deepEqual(sim.errors.map(String),[]);assert.equal(p.idleRetunes,0);
    assert.ok(sim.summary().income60>1e6);assert.equal(p.stats.restarts,0);
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
});

test('idle replanning an established support target does not reset or pause its earning peer',{timeout:90000},async()=>{
    const sim=boot({levelPerMinute:0,flags:{'max-targets':2},backgroundTargets:{
        rich:{max:200e6,money:200e6,sec:12,min:12,required:1,weakenTime:12000}
    }});
    sim.run();await sim.clock.runUntil(sim.start+420000);
    assert.equal(sim.pool.pipelines.size,2);
    const support=sim.pool.pipelines.get('foodnstuff'), peer=sim.pool.pipelines.get('rich');
    assert.equal(support.trial,false);assert.equal(peer.trial,false);
    const peerEpoch=peer.epoch, peerIncome=peer.stats.money;
    support.runtime.plan={...support.runtime.plan,gEffective:1e9};
    const faultAt=sim.clock.now;
    await sim.clock.runUntil(sim.start+540000);
    assert.deepEqual(sim.errors.map(String),[]);assert.ok(support.idleRetunes>=1);
    assert.equal(peer.epoch,peerEpoch);assert.equal(peer.stats.restarts,0);assert.equal(peer.stats.softRecoveries,0);
    assert.ok(peer.stats.money>peerIncome);assert.equal(sim.killed.filter(k=>k.target==='rich').length,0);
    assert.ok(sim.paid.some(p=>p.target==='foodnstuff'&&p.at>=sim.clock.now-60000));
    for(let t=faultAt;t<sim.clock.now;t+=30000) assert.ok(sim.paid.some(p=>p.target==='rich'&&p.at>=t&&p.at<t+30000));
});
