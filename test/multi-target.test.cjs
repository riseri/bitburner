const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), api = loadScript('daemon.js', clock), multi = loadScript('lib/target-pipelines.js', clock);
    const cfg = { gap: 100, lead: 600, homeReserve: 8, port: 20, controlPort: 15,
        maxTargets: 2, maxWorkers: 6000, maxLaunches: 32, maxBatchRate: 4, minimumPeriod: 250 };
    const runtime = { plan: { period: 500, batchRate: 2, expected: 1000, times: { H: 1000, G: 3200, W: 4000 } } };
    const pool = { api, cfg, ownerPid: 1, controls: new Map(), controlPort: new Port(), port: new Port(),
        pipelines: new Map(), running: new Map(), runningByChunk: new Map(), reservations: [],
        launchBuckets: new Map(), anchor: 'alpha', planCursor: 0, slowTicks: [], note: '' };
    const killed = [];
    const ns = { pid: 1, getServerMoneyAvailable: () => 1000, getServerMaxMoney: () => 1000,
        getServerSecurityLevel: () => 12, getServerMinSecurityLevel: () => 12,
        isRunning: pid => pool.running.has(pid), kill: pid => { if (!pool.running.has(pid)) return false; killed.push(pid); return true; } };
    function lane(name, ordinal) {
        const p = multi.createTargetPipeline(name, cfg, api, 1, ordinal, runtime);
        pool.pipelines.set(name, p); p.control = multi.targetControl(pool, p);
        api.publishHackPause(p.control, 0, 'ready');
        return p;
    }
    const a = lane('alpha', 0), b = lane('beta', 1);
    let nextPid = 10;
    function batch(p, suffix = '1') {
        const id = `${p.epoch}:${suffix}`;
        const chunks = ['H','W1','G','W2'].map((phase, i) => ({
            phase, target: p.name, epoch: p.epoch, owner: p, batchId: id, chunkId: `${id}:${i}`,
            host: 'cloud', ram: 2, landAt: clock.now + i * 100, launchAt: clock.now - 1000, duration: 1000,
            script: 'jit-hack.js', threads: 1,
        }));
        const b = api.makeBatchState(id, chunks); b.plan = p.runtime.plan; p.batches.set(id, b);
        for (const c of chunks) { const pid = nextPid++; api.trackRunning(pool.running, pid, c); pool.runningByChunk.set(c.chunkId, pid); c.status = 'running'; }
        return b;
    }
    function event(p, batch, phase, result = 0) {
        const c = [...batch.chunks.values()].find(c => c.phase === phase);
        return { type: 'done', target: p.name, batchId: batch.id, chunkId: c.chunkId, phase, result, finishedAt: c.landAt, drift: 0 };
    }
    return { clock, api, multi, pool, cfg, runtime, ns, killed, a, b, batch, event };
}

test('target latch updates preserve the other target and retain its epoch', () => {
    const f=fixture();
    f.api.publishHackPause(f.b.control, 1000, 'beta repair');
    const doc=f.pool.controlPort.peek();
    assert.equal(doc.version,2); assert.equal(doc.targets.alpha.paused,false);
    assert.equal(doc.targets.beta.paused,true); assert.equal(doc.targets.alpha.epoch,f.a.epoch);
    f.api.publishHackPause(f.a.control,1000,'alpha repair');
    f.api.publishHackPause(f.b.control,0,'beta recovered');
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,true);
    assert.equal(f.pool.controlPort.peek().targets.beta.paused,false);
});

test('interleaved and duplicate events settle only the owning target and RAM once', () => {
    const f=fixture(), a=f.batch(f.a), b=f.batch(f.b);
    const be=f.event(f.b,b,'H',400), ae=f.event(f.a,a,'H',200);
    for(const e of [be,ae,be,...['W1','G','W2'].map(phase=>f.event(f.b,b,phase))]) f.pool.port.tryWrite(e);
    f.multi.dispatchPipelineEvents(f.ns,f.pool);
    assert.equal(f.a.stats.money,200); assert.equal(f.b.stats.money,400);
    assert.equal(f.b.stats.completed,1); assert.equal(f.a.stats.completed,0);
    assert.equal(f.b.stats.pipeline.productiveMs,500); assert.equal(f.a.stats.pipeline.productiveMs,0);
    assert.equal(f.a.running.size,3); assert.equal(f.b.running.size,0);
    assert.equal(f.api.totalRunningRam(f.pool.running),6); assert.equal(f.a.runningRam,6);
});

test('unknown target, forged owner and old-epoch events cannot touch live worker accounting', () => {
    const f=fixture(), a=f.batch(f.a), b=f.batch(f.b);
    const e=f.event(f.b,b,'H',999);
    f.pool.port.tryWrite({...e,target:'alpha'});
    f.pool.port.tryWrite({...e,target:'unknown'});
    f.pool.port.tryWrite({...e,batchId:'previous-owner:1:1:1'});
    f.multi.dispatchPipelineEvents(f.ns,f.pool);
    assert.equal(f.api.totalRunningRam(f.pool.running),16);
    assert.equal(f.a.stats.money,0); assert.equal(f.b.stats.money,0);
    assert.equal(f.a.batches.size,1); assert.equal(f.b.batches.size,1);
});

test('local cancellation and hard target drain never kill peer H/G or clear peer reservations', () => {
    const f=fixture(), a=f.batch(f.a), b=f.batch(f.b);
    const owned=[...f.b.running.keys()], peers=[...f.a.running.keys()];
    f.pool.reservations.push({batchId:a.id,host:'cloud',ram:8}, {batchId:b.id,host:'cloud',ram:8});
    f.api.cancelHackWindow(f.ns,f.b.batches,f.pool.running,f.pool.runningByChunk,f.b.stats,f.clock.now+2000);
    assert.deepEqual(f.killed,[owned[0]]);
    f.multi.beginPipelineDrain(f.pool,f.b,{kind:'drain',hard:true,reason:'beta security 100'},true);
    f.api.serviceHardDrain(f.ns,f.b.drain,f.b.batches,f.pool.running,f.pool.runningByChunk,f.b.stats);
    assert.ok(f.killed.every(pid=>owned.includes(pid)));
    assert.ok(peers.every(pid=>f.pool.running.has(pid)));
    assert.equal(f.pool.reservations[0].batchId,a.id);
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
});

test('combined launch budget counts split chunks, including same-time chunks from different targets', () => {
    const m=loadScript('lib/target-pipelines.js',new Clock());
    const buckets=new Map([[4,6]]);
    assert.equal(m.fitsLaunchBudget(buckets,[{launchAt:1000},{launchAt:1100}],32),true);
    assert.equal(m.fitsLaunchBudget(buckets,[{launchAt:1000},{launchAt:1100},{launchAt:1200}],32),false);
    assert.equal(m.fitsLaunchBudget(buckets,[{launchAt:1250}],32),true);
});

test('expired reservations remain held while a worker is still live', () => {
    const f=fixture(), b=f.batch(f.a), c=[...b.chunks.values()][0];
    const reservations=[]; f.api.reserveChunk(reservations,c);
    const oldEnd=reservations[0].end;
    f.api.cleanupReservations(reservations,oldEnd+10000);
    assert.equal(reservations.length,1); assert.ok(reservations[0].end>oldEnd);
    c.status='done'; f.api.cleanupReservations(reservations,reservations[0].end+1);
    assert.equal(reservations.length,0);
});

async function workerCase(target, epoch, states) {
    const clock=new Clock(), start=clock.now;
    const worker=loadScript('lib/jit-worker.js',clock), events=new Port(), control=new Port();
    control.tryWrite({type:'jit-control',version:2,targets:states});
    const calls=[];
    const ns={ args:[target,start+1600,'batch',20,'H','chunk',100,15,1000,start,0,1,epoch],
        disableLog(){}, getServerMinSecurityLevel:()=>12,getServerSecurityLevel:()=>12,
        getPortHandle:n=>n===20?events:control,sleep:ms=>clock.sleep(ms)};
    const done=worker.runJitWorker(ns,()=>1000,async (_t,opts)=>{calls.push(opts);await clock.sleep(1000+opts.additionalMsec);return 200;});
    await clock.runUntil(start+3000);await done;
    return {calls,events:events.items};
}

test('a beta recovery gate does not suppress alpha workers',async()=>{
    const states={alpha:{epoch:'owner:0:1',paused:false},beta:{epoch:'owner:1:1',paused:true}};
    const a=await workerCase('alpha','owner:0:1',states),b=await workerCase('beta','owner:1:1',states);
    assert.equal(a.calls.length,1);assert.equal(b.calls.length,0);
    assert.ok(b.events.some(e=>e.type==='skip'));
});

test('workers fail closed on stale or absent target epochs',async()=>{
    for(const states of [{alpha:{epoch:'new',paused:false}},{}]) {
        const result=await workerCase('alpha','old',states);
        assert.equal(result.calls.length,0);assert.match(result.events[0].reason,/epoch/);
    }
});

test('shared overload winds down the trial instead of cancelling the incumbent',()=>{
    const f=fixture();f.batch(f.a);f.batch(f.b);
    f.pool.trialGuard={incumbent:'alpha',trial:'beta',admitted:f.clock.now-10000,baseline:1000,misses:0,trialMisses:0,
        fallbacks:0,allocationFails:0,admissionSkips:0,badSince:0};
    f.pool.slowTicks=Array(8).fill(f.clock.now);
    f.multi.monitorPipelineLoad(f.ns,f.pool,f.clock.now);
    assert.equal(f.b.retiring,true);assert.equal(f.a.drain,null);
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
});


test('launch-budget admission skips alone do not retire a healthy trial',()=>{
    const f=fixture();
    f.a.admissionSkips=100;
    f.pool.trialGuard={incumbent:'alpha',trial:'beta',admitted:f.clock.now-10000,baseline:1000,misses:0,trialMisses:0,
        fallbacks:0,allocationFails:0,badSince:0};
    f.pool.slowTicks=[];
    f.multi.monitorPipelineLoad(f.ns,f.pool,f.clock.now);
    assert.equal(f.b.retiring,false);
    assert.equal(f.b.drain,null);
    assert.equal(f.a.drain,null);
});

test('real allocator pressure still retires the trial before measured-income damage compounds',()=>{
    const f=fixture();
    f.a.stats.allocationFails=4;
    f.pool.trialGuard={incumbent:'alpha',trial:'beta',admitted:f.clock.now-10000,baseline:1000,misses:0,trialMisses:0,
        fallbacks:0,allocationFails:0,badSince:0};
    f.multi.monitorPipelineLoad(f.ns,f.pool,f.clock.now);
    assert.equal(f.b.retiring,true);
    assert.match(f.b.retireReason,/shared-load guard/);
});

test('a target-local circuit breaker is not misclassified as shared overload',()=>{
    const f=fixture();f.a.mode='DRAINING';f.a.stats.recoveries=1;
    f.pool.trialGuard={incumbent:'alpha',trial:'beta',admitted:f.clock.now-10000,baseline:1000,misses:0,trialMisses:0,
        fallbacks:0,allocationFails:0,admissionSkips:0,badSince:0};
    f.multi.monitorPipelineLoad(f.ns,f.pool,f.clock.now);
    assert.equal(f.b.retiring,false);assert.equal(f.b.drain,null);
});

test('a planned grow spike waits for its imminent W2 instead of rebuilding the target',()=>{
    const f=fixture(), batch=f.batch(f.a);
    const grow=[...batch.chunks.values()].find(c=>c.phase==='G');
    grow.threads=2000;
    f.clock.now=grow.landAt;
    f.pool.port.tryWrite(f.event(f.a,batch,'G'));
    f.multi.dispatchPipelineEvents(f.ns,f.pool);
    const ns={...f.ns,
        getServerSecurityLevel:()=>20,getServerMinSecurityLevel:()=>12,
        hackAnalyzeSecurity:threads=>threads*.002,growthAnalyzeSecurity:threads=>threads*.004};
    f.a.nextHealth=0;
    f.multi.servicePipelineSafety(ns,f.pool,f.a,f.clock.now);
    assert.equal(f.a.drain,null,'the matching live W2 covers the temporary +8 security');

    f.clock.now=batch.landing.W2+Math.max(500,f.a.cfg.gap*3)+1;
    f.a.nextHealth=0;
    f.multi.servicePipelineSafety(ns,f.pool,f.a,f.clock.now);
    assert.match(f.a.drain.reason,/security circuit breaker/,'an overdue W2 no longer masks the fault');
});

test('an unexplained security spike still trips the circuit breaker immediately',()=>{
    const f=fixture();
    const ns={...f.ns,getServerSecurityLevel:()=>100,getServerMinSecurityLevel:()=>12,
        hackAnalyzeSecurity:threads=>threads*.002,growthAnalyzeSecurity:threads=>threads*.004};
    f.a.nextHealth=0;
    f.multi.servicePipelineSafety(ns,f.pool,f.a,f.clock.now);
    assert.match(f.a.drain.reason,/security circuit breaker/);
});

test('supervisor reads current multi-target status but rejects another daemon owner',()=>{
    const f=fixture(), supervisor=loadScript('supervisor.js',f.clock);
    const snapshot={type:'jit-status',version:2,pid:123,generatedAt:f.clock.now,mode:'multi',pipelines:[{target:'alpha'},{target:'beta'}]};
    const ns={ps:()=>[{filename:'daemon.js',pid:123}],getPortHandle:()=>({peek:()=>snapshot}),getScriptLogs:()=>[]};
    assert.equal(supervisor.readDaemonDashboard(ns).pipelines.length,2);
    snapshot.pid=321; assert.equal(supervisor.readDaemonDashboard(ns),null);
});

test('launch admission bounds bursts across rolling one-second bucket boundaries',()=>{
    const api=loadScript('lib/target-pipelines.js',new Clock());
    const buckets=new Map([[0,7],[1,7],[2,7],[3,7]]);
    // Per-bin space alone is insufficient: these five bins would contain 35.
    assert.equal(api.fitsLaunchBudget(buckets,Array.from({length:7},()=>({launchAt:1001})),32),false);
    assert.equal(api.fitsLaunchBudget(buckets,Array.from({length:4},()=>({launchAt:1001})),32),true);
});

test('two target reservations share the same constrained host rather than double-spending its RAM',()=>{
    const f=fixture();
    const host={name:'cloud',maxRam:100,cores:1};
    const ns={...f.ns,getServerMaxRam:()=>100,getServerUsedRam:()=>0};
    const used=new Map([['cloud',0]]);
    f.api.reserveChunk(f.pool.reservations,{host:'cloud',ram:70,launchAt:f.clock.now,
        landAt:f.clock.now+10000,batchId:'alpha:batch',phase:'G',chunkId:'a'});
    const available=f.api.availableRam(ns,host,f.cfg,f.pool.running,f.pool.reservations,
        f.clock.now+100,f.clock.now+9000,used);
    assert.equal(available,30);
    f.api.reserveChunk(f.pool.reservations,{host:'cloud',ram:25,launchAt:f.clock.now+100,
        landAt:f.clock.now+9000,batchId:'beta:batch',phase:'G',chunkId:'b'});
    assert.equal(f.api.availableRam(ns,host,f.cfg,f.pool.running,f.pool.reservations,
        f.clock.now+200,f.clock.now+8000,used),5);
});

test('one target cannot electively retune while its peer is warming up',()=>{
    const f=fixture();
    f.a.stats.pipeline.completed=2000;f.a.stats.pipeline.productiveMs=1000000;f.a.tunedLevel=400;f.a.runtime.capacity=10000;
    f.a.runtime.plan.ramTime=0;f.a.tunedCapacity=10000;f.a.lastCapacityRetune=f.clock.now;
    f.b.trial=false;f.b.stats.pipeline.completed=0;
    f.pool.network={hosts:[{name:'cloud',maxRam:10000,cores:1}]};
    f.multi.servicePipelineMaintenance({...f.ns,getHackingLevel:()=>500},f.pool);
    assert.equal(f.a.drain,null);assert.equal(f.b.drain,null);
});

test('the sole earning target is never drained for an elective retune',()=>{
    const f=fixture();f.pool.pipelines.delete('beta');
    f.a.stats.pipeline.completed=2000;f.a.stats.pipeline.productiveMs=1000000;f.a.stats.lastHackAt=f.clock.now;
    f.a.tunedLevel=1;f.a.runtime.capacity=100;f.a.runtime.plan.ramTime=100000;
    f.a.tunedCapacity=100;f.a.lastCapacityRetune=f.clock.now-20*60*1000;
    f.pool.network={hosts:[{name:'cloud',maxRam:10000,cores:1}]};
    f.multi.servicePipelineMaintenance({...f.ns,getHackingLevel:()=>500},f.pool);
    assert.equal(f.a.drain,null);
    assert.equal(f.a.mode,'RUNNING');
});

test('retiring a repairing lane retains its RAM until its owned prep PID is confirmed gone',()=>{
    const f=fixture();
    f.b.repair={enabled:true,active:{pid:999,host:'cloud',ram:40},preemptions:0};
    f.pool.blocked=new Map();f.pool.history=[];
    f.multi.beginPipelineDrain(f.pool,f.b,{kind:'drain',reason:'withdraw repair'},true);
    f.multi.servicePipelineMaintenance(f.ns,f.pool);
    assert.equal(f.pool.pipelines.has('beta'),true);
    f.multi.servicePipelineSafety({...f.ns,isRunning:()=>true,kill:()=>false},f.pool,f.b,f.clock.now);
    assert.ok(f.b.repair.active,'failed kill must retain repair ownership');
    f.multi.servicePipelineSafety({...f.ns,isRunning:()=>true,kill:()=>true},f.pool,f.b,f.clock.now);
    assert.equal(f.b.repair.active,null);
    f.multi.servicePipelineMaintenance(f.ns,f.pool);
    assert.equal(f.pool.pipelines.has('beta'),false);
    assert.equal(f.pool.pipelines.has('alpha'),true);
});


test('steady promotion selects only the weaker stable lane and pauses for trial or recovery', () => {
    const f = fixture();
    for (const p of [f.a, f.b]) {
        p.mode = 'RUNNING'; p.trial = false; p.recovery = null; p.drain = null; p.retiring = false;
        p.stats.pipeline.completed = 300; p.stats.pipeline.productiveMs = 150000; p.stats.lastHackAt = f.clock.now;
    }
    f.a.runtime = { ...f.a.runtime, plan: { ...f.a.runtime.plan, expected: 1000 } };
    f.b.runtime = { ...f.b.runtime, plan: { ...f.b.runtime.plan, expected: 500 } };
    assert.equal(f.multi.steadyPromotionSupport(f.pool, f.clock.now), f.b);

    f.b.trial = true;
    assert.equal(f.multi.steadyPromotionSupport(f.pool, f.clock.now), null);
    f.b.trial = false; f.a.recovery = { reason: 'local recovery' };
    assert.equal(f.multi.steadyPromotionSupport(f.pool, f.clock.now), null);
    f.a.recovery = null; f.b.drain = { reason: 'target drain' };
    assert.equal(f.multi.steadyPromotionSupport(f.pool, f.clock.now), null);
});

test('waiting progress reports accumulated time rather than revaluing completed batches',()=>{
    const f=fixture();f.pool.pipelines.delete('beta');f.pool.cfg.maxTargets=1;
    f.pool.readyScan={}; // leave scouting in progress so its note cannot overwrite this one
    f.a.stats.pipeline.completed=100;f.a.stats.pipeline.productiveMs=60000;
    f.a.stats.lastHackAt=f.clock.now;
    for(const period of [2000,250]) {
        f.a.runtime.plan.period=period;
        f.multi.serviceBackgroundAndAdmission(f.ns,f.pool);
        assert.match(f.pool.note,/60\/120 seconds/);
        assert.equal(f.multi.productive(f.a,f.clock.now),false);
    }
});

test('ready scan admits an additive lane below the anchor but above the marginal floor', () => {
    const f = fixture();
    f.pool.pipelines = new Map([['alpha', f.a]]);
    f.pool.blocked = new Map();
    f.pool.network = { servers: ['beta'] };
    f.pool.cfg.backgroundPrep = { status: 'IDLE', active: null, target: '' };
    f.pool.cfg.switchThreshold = 1.25;
    f.pool.cfg.maxSteal = 0.5;
    f.pool.nextReadyScan = 0;
    const ns = { ...f.ns,
        hasRootAccess: () => true,
        getServerRequiredHackingLevel: () => 1,
        getHackingLevel: () => 100,
        getServerMaxMoney: () => 500,
        hackAnalyzeChance: () => 1,
    };
    const candidate = f.multi.nextReadyCandidate(ns, f.pool, f.a, f.clock.now);
    const potential = 500 * 0.5 * 0.95 * (f.cfg.maxBatchRate - f.a.runtime.plan.batchRate);
    assert.ok(potential < f.a.runtime.plan.expected);
    assert.ok(potential > f.a.runtime.plan.expected * (f.pool.cfg.switchThreshold - 1));
    assert.equal(candidate, 'beta');
});


test('an inferior tuned trial is retired before it can become a LIVE second lane', () => {
    const f = fixture();
    f.b.mode = 'TUNING';
    f.b.trial = true;
    f.b.minimumExpected = 1000;
    f.b.tuner = { next: () => ({ done: true, value: { plan: { expected: 500 } } }) };
    f.multi.servicePipelineTuning(f.ns, f.pool, f.b);
    assert.equal(f.b.retiring, true);
    assert.equal(f.b.mode, 'DRAINING');
    assert.match(f.b.retireReason, /below admission floor/);
    assert.equal(f.a.mode, 'RUNNING');
    assert.equal(f.a.drain, null);
});
