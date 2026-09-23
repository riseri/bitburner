const test=require('node:test');
const assert=require('node:assert/strict');
const {NetscriptSimulation}=require('./simulator.cjs');
const {loadScript}=require('./helpers.cjs');

function simulation() {
    const sim=new NetscriptSimulation({target:'n00dles',weakenTime:78000,hostCount:2,levelPerMinute:0,
        mainServer:{max:5e6,money:5e6,sec:1,min:1,required:1},
        flags:{'max-targets':1,'background-prep':false}});
    sim.baseLevel=10;
    let level=10;sim.level=()=>level;
    // Deterministic successful Hacks let this test measure scheduling gaps,
    // independently of the game's random failed-Hack payout gaps.
    sim.random=()=>.1;
    for(const h of sim.hosts.values())if(h.ram>128)h.ram=65536;
    for(const [at,value]of [[180000,100],[180500,1000],[181000,3000]])sim.clock.timer(at,()=>level=value);
    return sim;
}
function sound(sim) {
    assert.deepEqual(sim.errors.map(String),[]);assert.deepEqual(sim.misses,[]);assert.deepEqual(sim.killed,[]);
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,`${host}: ${ram}`);
    const finalW2=new Map();
    for(const e of sim.completions)if(e.phase==='W2')finalW2.set(e.batchId,e);
    assert.ok([...finalW2.values()].every(e=>e.moneyAfter>=sim.server.max*.995&&e.securityAfter<=sim.server.min+.02));
    assert.ok(sim.snapshots.every(s=>s.pipelines.every(p=>p.local===0&&p.fallback===0&&p.restarts===0)));
}

test('earning level-10 lane hot-swaps exactly once at level 3000 with a normal-spacing payout gap',async()=>{
    const sim=simulation();sim.run();await sim.clock.runUntil(sim.start+400000);sound(sim);
    const lane=sim.getPort(17).peek().pipelines[0],swap=lane.lastSwap;
    assert.equal(lane.generation,2);assert.equal(lane.hotSwaps.completed,1);assert.equal(lane.generations.length,1);
    assert.equal(swap.oldLevel,10);assert.equal(swap.newLevel,3000);
    assert.ok(sim.snapshots.some(s=>s.pipelines[0].generations.length===2));
    assert.ok(sim.snapshots.some(s=>s.pipelines[0].shadow?.state==='SHADOW'&&s.pipelines[0].income60>0));
    const old=sim.completions.filter(e=>e.phase==='H'&&e.generation===1).at(-1);
    const first=sim.completions.find(e=>e.phase==='H'&&e.generation===2);
    assert.ok(first.finishedAt-old.finishedAt<=1000/swap.oldRate+4*lane.gap+2);
    assert.ok(first.finishedAt>swap.finalOldW2);
    assert.ok(sim.completions.some(e=>e.generation===1&&e.startedAt<sim.start+180000&&e.finishedAt>sim.start+181000&&e.duration>10000));
    assert.ok(sim.completions.filter(e=>e.generation===2).every(e=>e.duration<2000));
    assert.equal(lane.model,swap.newIncome);assert.ok(swap.newIncome>swap.oldIncome);
    // This run deliberately succeeds every Hack; convert observed payouts back
    // to the tuner's 60% chance and allow thread-flooring/60s-window rounding.
    assert.ok(Math.abs(lane.income60*.6/lane.model-1)<.1);
    assert.ok(Math.abs(lane.batchRate-lane.modelBatchRate)<.05);
    let earned=0;
    for(const snapshot of sim.snapshots) {
        const p=snapshot.pipelines[0];
        assert.ok(p.productiveMs>=earned,'generation changes cannot reduce productive-time progress');
        earned=p.productiveMs;
    }
    const finalW2=new Map();
    for(const e of sim.completions)if(e.phase==='W2')finalW2.set(e.batchId,e);
    // Snapshot publication may precede the final simulation tick, so compare
    // completed batches through that snapshot's timestamp rather than wall time.
    const at=sim.snapshots.at(-1).generatedAt;
    const expected=[...finalW2.values()].filter(e=>e.finishedAt<=at).reduce((n,e)=>n+
        (e.generation===1?1000/swap.oldRate:1000/swap.newRate),0);
    assert.ok(Math.abs(lane.productiveMs-expected)<1e-6);
    for(let at=sim.start+100000;at<sim.start+390000;at+=10000)
        assert.ok(sim.paid.some(p=>p.at>=at&&p.at<at+10000),`income missing at ${at}`);
});

test('persistent overlap allocator refusal never drains the sole earner or consumes a generation',async()=>{
    const sim=simulation(),multi=loadScript('lib/target-pipelines.js',sim.clock);
    let attempts=0;const searches=[],callsPerTick=new Map();
    // Inject the allocator's insufficient-overlap result. Unit tests exercise
    // that result with actual RAM, foreign, and prep reservations; this verifies
    // repeated scheduler retries over an entire earning run.
    sim.daemon=loadScript('daemon.js',sim.clock,{runTargetPipelines:(ns,setup,api)=>{
        const reserve=api.reserveBatch;
        const tune=api.tuneTargetSteps;
        api.tuneTargetSteps=(...args)=>{if(args[6])searches.push(sim.clock.now);return tune(...args);};
        api.reserveBatch=(...args)=>{if(args[6].generation>1){
            attempts++;callsPerTick.set(sim.clock.now,(callsPerTick.get(sim.clock.now)||0)+1);return null;
        }return reserve(...args);};
        return multi.runTargetPipelines(ns,setup,api);
    }});
    sim.run();await sim.clock.runUntil(sim.start+350000);sound(sim);
    const lane=sim.getPort(17).peek().pipelines[0];
    assert.equal(lane.generation,1);assert.equal(lane.hotSwaps.completed,0);assert.equal(lane.cutover,null);
    assert.match(lane.shadow.reason,/overlap RAM/);assert.ok(attempts>=3);
    // Retries now search several smaller candidates, but every search yields
    // between candidates and whole searches still use bounded retry backoff.
    assert.ok(searches.length>=3&&searches.length<15);
    assert.ok([...callsPerTick.values()].every(n=>n<=2));
    assert.ok(lane.income60>0);assert.equal(lane.mode,'LIVE');
    for(let at=sim.start+180000;at<sim.start+340000;at+=10000)
        assert.ok(sim.paid.some(p=>p.at>=at&&p.at<at+10000));
});
