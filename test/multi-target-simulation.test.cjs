const test=require('node:test');
const assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');

const profile={target:'phantasy',weakenTime:78000,levelPerMinute:0,
    mainServer:{max:600e6,money:600e6,sec:7,min:7,required:30},
    flags:{target:'phantasy','max-targets':2},
    backgroundTargets:{'the-hub':{max:4.96e9,money:4.96e9,sec:12,min:12,required:300,weakenTime:180000}}};
function state(sim){return sim.getPort(17).peek();}
function lane(sim,name){return state(sim).pipelines.find(p=>p.target===name);}
function count(sim,target,through=Infinity){return sim.actions.filter(a=>a.phase==='H'&&a.target===target&&a.at<=through).length;}
function income(sim,target){return sim.paid.filter(p=>p.target===target&&p.at>=sim.clock.now-60000).reduce((n,p)=>n+p.money,0)/60;}
function assertSound(sim){
    assert.deepEqual(sim.errors.map(String),[]);
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    assert.ok(sim.snapshots.every(s=>s.pipelines.length<=2));
    assert.ok(sim.actions.filter(a=>['H','G','W1','W2'].includes(a.phase)).every(a=>a.startSec<=sim.servers.get(a.target).min+.001));
}
function paidEveryMinute(sim,target,from,to){
    for(let t=from;t+60000<to;t+=60000)assert.ok(sim.paid.some(p=>p.target===target&&p.at>=t&&p.at<t+60000),`${target} income absent at ${t}`);
}

test('18 virtual minutes: two earning targets keep the incumbent productive through admission and warmup',{timeout:180000},async()=>{
    const baseline=new NetscriptSimulation({...profile,flags:{target:'phantasy','max-targets':1}});
    baseline.run();await baseline.clock.runUntil(baseline.start+18*60000);assertSound(baseline);
    const sim=new NetscriptSimulation(profile);
    sim.clock.timer(600000,()=>{sim.clock.now+=70;});
    sim.run();await sim.clock.runUntil(sim.start+18*60000);assertSound(sim);
    assert.equal(state(sim).pipelines.length,2);
    for(const name of ['phantasy','the-hub']){
        const p=lane(sim,name);assert.equal(p.mode,'LIVE');assert.equal(p.restarts,0);assert.equal(p.fallback,0);
        assert.equal(Object.values(p.misses).reduce((n,v)=>n+v,0),0);
        assert.ok(income(sim,name)>1e8);
    }
    const firstOther=sim.paid.find(p=>p.target==='the-hub').at;
    paidEveryMinute(sim,'phantasy',sim.start+120000,firstOther+60000);
    // After validation the richer target may receive scheduling priority. Before
    // that handoff the incumbent retains its original cadence, within one slot.
    const cutoff=firstOther+60000;
    assert.ok(Math.abs(count(sim,'phantasy',cutoff)-count(baseline,'phantasy',cutoff))<=2);
    assert.ok(count(sim,'phantasy')>=count(baseline,'phantasy')*.97);
    assert.ok(sim.summary().income60>baseline.summary().income60*2);
    assert.equal(sim.killed.filter(p=>p.target==='phantasy'&&p.phase==='H').length,0);
    assert.equal(state(sim).priority,'the-hub');
    console.log(JSON.stringify({baseline:baseline.summary().income60,combined:sim.summary().income60,
        incumbent:income(sim,'phantasy'),added:income(sim,'the-hub'),starts:[count(sim,'phantasy'),count(sim,'the-hub')]}));
});

test('secondary W2 invocation miss recovers locally without pausing or cancelling incumbent hacks',{timeout:180000},async()=>{
    const sim=new NetscriptSimulation({...profile,delayOneW2:true,delayTarget:'the-hub',delayAt:500000});
    sim.run();await sim.clock.runUntil(sim.start+16*60000);assertSound(sim);
    assert.equal(sim.dropped,true);assert.ok(sim.misses.some(m=>m.target==='the-hub'&&m.chunkId===sim.delayedChunk));
    const a=lane(sim,'phantasy'),b=lane(sim,'the-hub');
    assert.ok(a&&b,JSON.stringify(state(sim)));assert.equal(a.local,0);assert.equal(a.fallback,0);assert.equal(a.restarts,0);
    assert.ok(b.local>=1);assert.equal(b.fallback,0);assert.equal(b.restarts,0);
    assert.equal(sim.killed.filter(p=>p.target==='phantasy'&&p.phase==='H').length,0);
    paidEveryMinute(sim,'phantasy',sim.start+120000,sim.clock.now);
    assert.ok(income(sim,'the-hub')>1e8);
});

test('a hard secondary fault rebuilds only that target while peer income continues',{timeout:180000},async()=>{
    const sim=new NetscriptSimulation(profile);
    sim.clock.timer(720000,()=>{sim.servers.get('the-hub').sec=100;});
    sim.run();await sim.clock.runUntil(sim.start+20*60000);assertSound(sim);
    const a=lane(sim,'phantasy'),b=lane(sim,'the-hub');
    assert.ok(a&&b,JSON.stringify(state(sim)));assert.equal(a.restarts,0);assert.equal(a.fallback,0);
    assert.equal(b.restarts,1);assert.equal(b.resyncs,1);assert.ok(income(sim,'the-hub')>1e8);
    assert.equal(sim.killed.filter(p=>p.target==='phantasy'&&p.phase==='H').length,0);
    paidEveryMinute(sim,'phantasy',sim.start+650000,sim.clock.now);
});

test('an incumbent hard fault is repaired asynchronously without shutting down the other target',{timeout:180000},async()=>{
    const sim=new NetscriptSimulation(profile);
    sim.clock.timer(720000,()=>{sim.server.sec=100;});
    sim.run();await sim.clock.runUntil(sim.start+18*60000);assertSound(sim);
    const a=lane(sim,'phantasy'),b=lane(sim,'the-hub');
    assert.ok(a&&b,JSON.stringify(state(sim)));assert.equal(a.restarts,1);assert.equal(b.restarts,0);assert.equal(b.fallback,0);
    assert.equal(sim.killed.filter(p=>p.target==='the-hub'&&p.phase==='H').length,0);
    paidEveryMinute(sim,'the-hub',sim.start+650000,sim.clock.now);
    assert.ok(income(sim,'phantasy')>1e8);
});

test('a non-earning trial retires instead of resetting the productive target or immediately readmitting itself',{timeout:180000},async()=>{
    const sim=new NetscriptSimulation({...profile,refuseTarget:'the-hub'});
    sim.run();await sim.clock.runUntil(sim.start+14*60000);assertSound(sim);
    assert.ok(state(sim).retired.some(p=>p.target==='the-hub'),JSON.stringify(state(sim)));
    assert.equal(state(sim).pipelines.length,1);assert.equal(lane(sim,'phantasy').restarts,0);
    assert.equal(sim.killed.filter(p=>p.target==='phantasy'&&p.phase==='H').length,0);
    assert.ok(income(sim,'phantasy')>1e8);
    assert.equal(sim.paid.filter(p=>p.target==='the-hub').length,0);
});

test('an upgrade-quality ready target can fill slot two and owner shutdown leaves unrelated workers alone',{timeout:180000},async()=>{
    // Pin the bootstrap target so the already-ready second target is a genuine
    // upgrade rather than an intentional downgrade.
    const sim=new NetscriptSimulation({...profile,flags:{target:'phantasy','max-targets':2},
        backgroundTargets:{'the-hub':{...profile.backgroundTargets['the-hub'],weakenTime:60000}}});
    sim.run();await sim.clock.runUntil(sim.start+12*60000);assertSound(sim);
    assert.equal(state(sim).pipelines.length,2,JSON.stringify(state(sim)));assert.ok(income(sim,'phantasy')>0);assert.ok(income(sim,'the-hub')>0);
    const owned=[...sim.processes.keys()];
    const outsider={pid:999999,script:'jit-hack.js',host:'home',ram:1,threads:1,args:['unrelated'],active:true};
    sim.processes.set(outsider.pid,outsider);sim.used.set('home',sim.used.get('home')+1);
    sim.controller.active=false;for(const hook of sim.exitHandlers)hook();
    assert.ok(owned.every(pid=>!sim.processes.has(pid)));
    assert.ok(sim.processes.has(outsider.pid));
});


test('steady promotion replaces the weaker bootstrap lane with a richer prepped target', { timeout: 180_000 }, async () => {
    const sim = new NetscriptSimulation({
        target: 'phantasy', weakenTime: 78_000, levelPerMinute: 0,
        mainServer: { max: 600e6, money: 600e6, sec: 7, min: 7, required: 30, chance: .8 },
        flags: { target: 'phantasy', 'max-targets': 2 },
        backgroundTargets: {
            'fast-lane': { max: 1.5e9, money: 1.35e9, sec: 8, min: 7, required: 80, weakenTime: 40_000, chance: .8 },
            'slow-whale': { max: 4.96e9, money: 250e6, sec: 20, min: 12, required: 300, weakenTime: 120_000, chance: .8 },
        },
    });
    sim.run();
    await sim.clock.runUntil(sim.start + 28 * 60_000);
    assertSound(sim);
    const final = state(sim);
    assert.equal(final.pipelines.length, 2, JSON.stringify(final));
    assert.ok(final.pipelines.some(p => p.target === 'fast-lane'), JSON.stringify(final));
    assert.ok(final.pipelines.some(p => p.target === 'slow-whale'), JSON.stringify(final));
    assert.ok(!final.pipelines.some(p => p.target === 'phantasy'), JSON.stringify(final));
    assert.ok(final.retired.some(p => p.target === 'phantasy' && /steady-state promotion/.test(p.reason)),
        JSON.stringify(final.retired));
    assert.ok(sim.paid.some(p => p.target === 'slow-whale'),
        'the promoted whale should contribute paid income');
    assert.ok(sim.snapshots.every(s => s.pipelines.length <= 2),
        'promotion must never create a third JIT pipeline');
    assert.ok(sim.paid.some(p => p.target === 'fast-lane' && p.at >= sim.clock.now - 120_000),
        'the surviving lane should keep earning through the promotion handoff');
});


test('a negligible ready server is skipped while a worthwhile second target is prepared and admitted', { timeout: 180_000 }, async () => {
    const sim = new NetscriptSimulation({
        target: 'phantasy', weakenTime: 78_000, levelPerMinute: 0,
        mainServer: { max: 600e6, money: 600e6, sec: 7, min: 7, required: 30, chance: .8 },
        flags: { target: 'phantasy', 'max-targets': 2 },
        backgroundTargets: {
            'inferior-ready': { max: 50e6, money: 50e6, sec: 6, min: 6, required: 80, weakenTime: 40_000, chance: .8 },
            'rich-upgrade': { max: 4.96e9, money: 3.5e9, sec: 14, min: 12, required: 300, weakenTime: 60_000, chance: .8 },
        },
    });
    sim.run();
    await sim.clock.runUntil(sim.start + 12 * 60_000);
    assertSound(sim);
    const final = state(sim);
    assert.equal(final.pipelines.length, 2, JSON.stringify(final));
    assert.ok(final.pipelines.some(p => p.target === 'phantasy'), JSON.stringify(final));
    assert.ok(final.pipelines.some(p => p.target === 'rich-upgrade'), JSON.stringify(final));
    assert.ok(!final.pipelines.some(p => p.target === 'inferior-ready'), JSON.stringify(final));
    assert.ok(sim.snapshots.every(snapshot =>
        !snapshot.pipelines?.some(p => p.target === 'inferior-ready' && ['LIVE','WARMUP'].includes(p.mode))),
        'a candidate below the marginal improvement floor must never become an earning lane');
    assert.ok(sim.paid.some(p => p.target === 'rich-upgrade'),
        'the richer admitted target should contribute paid income');
});
