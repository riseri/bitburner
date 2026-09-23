const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), api = loadScript('daemon.js', clock), multi = loadScript('lib/target-pipelines.js', clock);
    const cfg = { gap:100, lead:600, homeReserve:0, port:20, controlPort:15, maxTargets:1,
        maxWorkers:6000, maxLaunches:64, maxBatchRate:4, minimumPeriod:420, ram:{H:2,G:2.2,W:2.2} };
    const plan = { period:500, batchRate:2, expected:1000, H:4, gEffective:10, steal:.1, hackSecurity:.008,
        times:{H:1000,G:3200,W:4000}, ramTime:100000 };
    const runtime = {plan, capacity:10000, formulas:false};
    const pool = {api,cfg,ownerPid:1,controls:new Map(),controlPort:new Port(),port:new Port(),
        pipelines:new Map(),running:new Map(),runningByChunk:new Map(),reservations:[],foreign:new Map(),
        launchBuckets:new Map(),anchor:'alpha',planCursor:0,network:{hosts:[{name:'cloud',maxRam:10000,cores:1}]}};
    let level=10, formulas=false, calls=0;
    const killed=[];
    const ns = {pid:1,getHackingLevel:()=>level,getServerUsedRam:()=>0,
        getServerMoneyAvailable:()=>10000,getServerMaxMoney:()=>10000,
        getServerSecurityLevel:()=>1,getServerMinSecurityLevel:()=>1,
        growthAnalyzeSecurity:t=>t*.004,weakenAnalyze:t=>t*.05,
        kill:pid=>{killed.push(pid);return true;},isRunning:pid=>pool.running.has(pid)};
    const p=multi.createTargetPipeline('alpha',cfg,api,1,0,runtime);
    p.tunedLevel=10;p.tunedCapacity=10000;p.stats.lastHackAt=clock.now;
    p.generations.get(1).level=10;
    pool.pipelines.set(p.name,p);p.control=multi.targetControl(pool,p);api.publishHackPause(p.control,0,'ready');
    const replacement={...runtime,plan:{...plan,expected:2000,times:{H:250,G:800,W:1000}}};
    api.hackingFormulasAvailable=()=>formulas;
    api.createPreppedModel=()=>({times:replacement.plan.times});
    api.poolProfile=()=>({capacity:10000});
    api.tuneTargetSteps=function*(){calls++;yield;yield;return {...replacement,formulas};};
    function batch(landing=clock.now+7000) {
        const id=`${p.epoch}:old:${++p.serial}`;
        const result=api.reserveBatch(ns,p.name,id,landing,plan,pool.network.hosts,p.cfg,pool.reservations,pool.running,pool.foreign);
        assert.ok(result);multi.commitGenerationBatch(pool,p,id,result.chunks,p.generations.get(1));
        p.nextLanding=landing+plan.period;
        return p.batches.get(id);
    }
    const old=batch();
    function tune() { multi.serviceShadowTune(ns,pool,p);clock.now+=2001;for(let i=0;i<4;i++)multi.serviceShadowTune(ns,pool,p); }
    function event(b,c,extra={}) {return {type:'done',target:p.name,epoch:p.epoch,generation:b.generation,
        batchId:b.id,chunkId:c.chunkId,phase:c.phase,finishedAt:c.landAt,drift:0,result:c.phase==='H'?100:0,
        ...(c.phase==='W2'?{moneyAfter:10000,securityAfter:1}:{}),...extra};}
    function finish(b) {for(const phase of ['H','W1','G','W2'])for(const c of b.chunks.values())if(c.phase===phase)pool.port.tryWrite(event(b,c));multi.dispatchPipelineEvents(ns,pool);}
    return {clock,api,multi,pool,p,ns,old,batch,tune,event,finish,killed,replacement,
        setLevel:n=>level=n,setFormulas:n=>formulas=n,get calls(){return calls;}};
}

for(const trigger of ['skill','formulas','capacity']) test(`${trigger} tunes in the background while the sole lane admits old-plan batches`,()=>{
    const f=fixture();if(trigger==='skill')f.setLevel(3000);if(trigger==='formulas')f.setFormulas(true);
    if(trigger==='capacity')f.p.tunedCapacity=1000;
    f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.equal(f.p.shadow.trigger,trigger);assert.equal(f.p.mode,'RUNNING');assert.equal(f.p.drain,null);
    f.clock.now+=1600;f.multi.planPipelineBatch(f.ns,f.pool);assert.ok(f.p.stats.scheduled>=2);
    assert.equal(f.p.generation,1);assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
    f.finish(f.old);assert.equal(f.p.stats.money,100);
});

test('level 10 to 3000 is debounced and fingerprint invalidation consumes no number',()=>{
    const f=fixture();for(const level of [100,1000,3000]){f.setLevel(level);f.multi.serviceShadowTune(f.ns,f.pool,f.p);f.clock.now+=500;}
    assert.equal(f.calls,0);assert.equal(f.p.generationSerial,1);
    f.clock.now+=2000;for(let i=0;i<4;i++)f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.equal(f.calls,1);assert.equal(f.p.generation,2);assert.equal(f.p.generationSerial,2);
    assert.equal(f.p.swap.newLevel,3000);assert.equal(f.p.swap.firstH,f.p.swap.finalOldW2+100);
    assert.equal(f.p.generations.size,2);assert.equal(f.p.epoch,'1:0:1');assert.deepEqual(f.killed,[]);
});

test('faster generation preserves earned time and old completions retain their original period',()=>{
    const f=fixture();
    f.old.plan.period=6000;f.p.stats.pipeline.completed=19;f.p.stats.pipeline.productiveMs=114000;
    f.replacement.plan.period=2000;
    f.setLevel(3000);f.tune();
    assert.equal(f.p.generation,2);assert.equal(f.p.runtime.plan.period,2000);
    assert.equal(f.p.stats.pipeline.productiveMs,114000);
    assert.equal(f.multi.productive(f.p,f.clock.now),false);
    f.finish(f.old);
    assert.equal(f.p.stats.pipeline.productiveMs,120000);
    assert.equal(f.multi.productive(f.p,f.clock.now),true);
    f.finish(f.old); // duplicate old-generation events cannot credit it twice
    assert.equal(f.p.stats.pipeline.productiveMs,120000);
    const next=[...f.p.batches.values()].find(b=>b.generation===2);
    f.finish(next);assert.equal(f.p.stats.pipeline.productiveMs,122000);
    f.p.stats.lastHackAt=f.clock.now-60000;
    assert.equal(f.multi.productive(f.p,f.clock.now),false,'earned time does not bypass the recent-Hack gate');
    assert.equal(f.p.stats.pipeline.productiveMs,122000);
});

test('slower generation cannot retroactively turn unfinished productive time into two minutes',()=>{
    const f=fixture();
    f.p.stats.pipeline.completed=20;f.p.stats.pipeline.productiveMs=10000;
    f.replacement.plan.period=10000;
    f.setLevel(3000);f.tune();
    assert.equal(f.p.generation,2);assert.equal(f.p.runtime.plan.period,10000);
    assert.equal(f.p.stats.pipeline.productiveMs,10000);
    assert.equal(f.multi.productive(f.p,f.clock.now),false);
    f.finish(f.old);
    const next=[...f.p.batches.values()].find(b=>b.generation===2);
    f.finish(next);
    assert.equal(f.p.stats.pipeline.productiveMs,20500);
    assert.equal(f.multi.productive(f.p,f.clock.now),false);
});

for(const block of ['RAM','launch','workers','foreign','prep']) test(`${block} preflight rejection leaves old admission and reservations intact`,()=>{
    const f=fixture();f.setLevel(3000);
    if(block==='RAM')f.pool.network.hosts[0].maxRam=10;
    if(block==='launch')f.pool.cfg.maxLaunches=1;
    if(block==='workers')f.pool.cfg.maxWorkers=1;
    if(block==='foreign')f.pool.foreign.set('cloud',9999);
    if(block==='prep')f.p.cfg.prepStates=[{active:{host:'cloud',ram:9999}}];
    const before=[...f.pool.reservations];f.tune();
    assert.equal(f.p.generation,1);assert.equal(f.p.mode,'RUNNING');assert.equal(f.p.drain,null);
    assert.match(f.p.shadow.reason,/RAM|launch|worker/);assert.deepEqual(f.pool.reservations,before);
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);assert.deepEqual(f.killed,[]);
    f.finish(f.old);assert.equal(f.p.stats.money,100);
});

test('interleaved generations retain plan metadata, reject wrong identity, and retire only after reconciliation',()=>{
    const f=fixture();f.setLevel(3000);f.tune();
    const next=[...f.p.batches.values()].find(b=>b.generation===2);
    assert.equal(f.old.plan.times.W,4000);assert.equal(next.plan.times.W,1000);
    const c=[...next.chunks.values()][0];
    for(const bad of [{generation:99},{generation:1},{epoch:'wrong'},{target:'peer'}])f.pool.port.tryWrite(f.event(next,c,bad));
    f.multi.dispatchPipelineEvents(f.ns,f.pool);assert.equal(c.status,'queued');
    f.finish(f.old);assert.equal(f.p.batches.has(next.id),true);
    f.finish(next);assert.equal(f.p.generations.get(2).state,'ACTIVE');
    assert.deepEqual([...f.pool.controlPort.peek().targets.alpha.generations],[1,2]);
    const peer={host:'peer',start:0,end:Infinity,ram:1,chunk:{owner:{},status:'running'},generation:1};
    f.pool.reservations.push(peer);
    f.pool.running.set(999,peer.chunk);
    f.p.queue=f.p.queue.filter(c=>!f.api.isTerminalChunk(c));
    f.clock.now=f.p.swap.firstH+2000;f.api.cleanupReservations(f.pool.reservations,f.clock.now);
    f.multi.serviceHotSwapHealth(f.ns,f.pool,f.p);
    assert.deepEqual([...f.p.generations.keys()],[2]);assert.ok(f.pool.reservations.includes(peer));
    assert.equal(f.pool.running.get(999),peer.chunk);
    assert.equal(f.p.hotSwaps.completed,1);assert.deepEqual(f.killed,[]);
});

test('hot-swap preflight uses compact placement for both complete overlapping batches',()=>{
    const f=fixture();f.pool.cfg.maxLaunches=32;
    f.pool.network.hosts.push(...Array.from({length:20},(_,i)=>({name:'small-'+i,maxRam:64,cores:8})));
    f.replacement.plan.gEffective=500;
    f.api.reserveIncomeBatch=()=>{throw new Error('preflight must never preempt prep');};
    f.setLevel(3000);f.tune();
    assert.equal(f.p.generation,2);assert.equal(f.p.generations.size,2);
    const batches=[...f.p.batches.values()].filter(b=>b.generation===2);
    assert.equal(batches.length,2);
    for(const b of batches) {
        assert.deepEqual([...new Set([...b.chunks.values()].map(c=>c.phase))].sort(),['G','H','W1','W2']);
        const grow=[...b.chunks.values()].filter(c=>c.phase==='G');
        assert.equal(grow.length,1);assert.equal(grow[0].host,'cloud');
    }
    assert.equal(f.p.batches.has(f.old.id),true);assert.deepEqual(f.killed,[]);
    assert.ok([...f.pool.launchBuckets.values()].every(n=>n<=8));
});

test('RAM-blocked shadow searches a smaller improving plan using pure overlap reservations',()=>{
    const f=fixture();f.pool.network.hosts[0].maxRam=100;
    const large={...f.replacement.plan,gEffective:100};
    const small={...f.replacement.plan,gEffective:4,expected:1500};
    let filtered=0;
    f.api.tuneTargetSteps=function*(ns,target,hosts,cfg,running,model,accept){
        yield;
        for(const plan of [large,small]) {
            yield;
            if(accept)filtered++;
            if(!accept||accept(plan))return {...f.replacement,plan};
        }
        return null;
    };
    f.api.reserveIncomeBatch=()=>{throw new Error('shadow probe cannot preempt any worker');};
    const before=[...f.pool.reservations];
    f.setLevel(3000);f.tune();
    assert.equal(f.p.generation,1);assert.equal(f.p.shadow.fitOverlap,true);
    assert.deepEqual(f.pool.reservations,before);assert.equal(f.p.drain,null);
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
    f.clock.now=f.p.shadow.retryAt;
    for(let i=0;i<8&&f.p.generation===1;i++)f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.ok(filtered>=2);assert.equal(f.p.generation,2);
    assert.equal(f.p.runtime.plan.expected,1500);assert.equal(f.p.runtime.plan.gEffective,4);
    assert.ok(f.p.batches.has(f.old.id));assert.deepEqual(f.killed,[]);
    assert.equal(f.pool.reservations.length,before.length+8,'failed and successful probes leave no duplicates');
});

test('fingerprint changes during a yielding search discard its intermediate model without committing',()=>{
    const f=fixture();f.setLevel(100);f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    f.clock.now+=2001;f.multi.serviceShadowTune(f.ns,f.pool,f.p);assert.equal(f.calls,1);
    f.setLevel(3000);f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.equal(f.p.generationSerial,1);assert.equal(f.p.shadow.inputs.level,3000);
    f.clock.now+=2001;for(let i=0;i<4;i++)f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.equal(f.calls,2);assert.equal(f.p.generationSerial,2);assert.equal(f.p.swap.newLevel,3000);
});

test('old completion spacing uses the old batch configuration after the displayed runtime changes',()=>{
    const f=fixture();f.setLevel(3000);f.tune();
    f.p.cfg.gap=1000; // would make the old 100ms phase lattice fail a global-cfg check
    f.finish(f.old);
    assert.equal(f.p.stats.completed,1);assert.equal(f.p.recovery,null);
    assert.equal(f.p.generations.get(1).failed,undefined);
    assert.equal(f.old.cfg.gap,100);assert.equal(f.old.plan.times.W,4000);
});

test('timing changes before preflight and tuner exceptions never consume a generation or pause income',()=>{
    const f=fixture();f.setLevel(3000);f.multi.serviceShadowTune(f.ns,f.pool,f.p);f.clock.now+=2001;
    for(let i=0;i<2;i++)f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    f.api.createPreppedModel=()=>({times:{H:251,G:803,W:1004}});
    f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    assert.equal(f.p.shadow,null);assert.equal(f.p.generationSerial,1);assert.equal(f.p.drain,null);
    f.clock.now+=3000;f.api.tuneTargetSteps=function*(){throw new Error('tuner fault');};f.tune();
    assert.equal(f.p.generationSerial,1);assert.match(f.p.lastSwap.reason,/tuner fault/);
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
});

test('a hard safety drain takes precedence over candidate rollback and keeps the gate closed',()=>{
    const f=fixture();f.setLevel(3000);f.tune();f.p.generations.get(2).failed=true;
    f.multi.beginPipelineDrain(f.pool,f.p,{kind:'drain',hard:true,reason:'host lost'});
    f.multi.serviceHotSwapHealth(f.ns,f.pool,f.p);
    assert.equal(f.p.generation,2);assert.equal(f.pool.controlPort.peek().targets.alpha.paused,true);
});

test('a failed candidate before its first H resumes the old plan and preserves old work',()=>{
    const f=fixture();f.setLevel(3000);f.tune();
    f.p.generations.get(2).failed=true;f.multi.serviceHotSwapHealth(f.ns,f.pool,f.p);
    assert.equal(f.p.generation,1);assert.equal(f.p.generationSerial,2);
    assert.equal(f.p.swap.state,'ABORTED');assert.equal(f.p.runtime.plan,f.old.plan);
    assert.ok([...f.old.chunks.values()].every(c=>c.status==='queued'));
    assert.equal(f.pool.controlPort.peek().targets.alpha.paused,false);
});

test('after a new H, failure pauses admissions, retains restoration tails, then enters bounded recovery',()=>{
    const f=fixture();f.setLevel(3000);f.tune();f.finish(f.old);
    const next=[...f.p.batches.values()].filter(b=>b.generation===2), first=next[0];
    const h=[...first.chunks.values()].find(c=>c.phase==='H');
    f.clock.now=h.landAt;f.pool.port.tryWrite(f.event(first,h));f.multi.dispatchPipelineEvents(f.ns,f.pool);
    f.p.generations.get(2).failed=true;f.multi.serviceHotSwapHealth(f.ns,f.pool,f.p);
    assert.equal(f.p.swap.restoring,true);assert.equal(f.p.generation,2);assert.equal(f.p.recovery,null);
    assert.ok([...first.chunks.values()].filter(c=>c.phase!=='H').every(c=>c.status==='queued'));
    const scheduled=f.p.stats.scheduled;f.multi.planPipelineBatch(f.ns,f.pool);assert.equal(f.p.stats.scheduled,scheduled);
    for(const b of next)f.finish(b);
    assert.ok(f.p.recovery);assert.equal(f.p.generation,2);
    f.p.recovery=null;f.multi.serviceHotSwapHealth(f.ns,f.pool,f.p);
    assert.equal(f.p.generations.get(2).confirmed,false);
    assert.equal(f.p.generations.get(2).state,'CUTOVER');
    assert.equal(f.p.swap.restoring,false);assert.equal(f.p.generations.size,2);
});

test('worker gate accepts both committed generations and rejects unknown, retired, wrong epoch and owner',async()=>{
    for(const [generation,epoch,accepted,live=true,generations=[1,2]] of [
        [1,'1:0:1',true],[2,'1:0:1',true],[3,'1:0:1',false],[1,'old',false],[1,'2:0:1',false],
        [1,'1:0:1',false,false],[1,'1:0:1',false,true,[2]],[1,'1:0:1',false,true,{}]]) {
        const clock=new Clock(), worker=loadScript('lib/jit-worker.js',clock), port=new Port(), control=new Port();
        control.tryWrite({type:'jit-control',version:2,ownerPid:1,targets:{alpha:{epoch:'1:0:1',generations,paused:false}}});
        let called=false;
        const ns={args:['alpha',clock.now+1000,'batch',20,'H','chunk',100,15,100,clock.now,0,1,epoch,generation],
            disableLog(){},isRunning:()=>live,getPortHandle:n=>n===20?port:control,getServerMinSecurityLevel:()=>1,getServerSecurityLevel:()=>1,sleep:ms=>clock.sleep(ms)};
        await worker.runJitWorker(ns,()=>100,async()=>{called=true;return 1;});
        assert.equal(called,accepted);assert.ok(port.items.every(e=>e.generation===generation&&e.epoch===epoch));
    }
});

test('status and dashboard expose shadow and cutover without reporting normal planning as Attention',()=>{
    const f=fixture(),logs=[];f.setLevel(3000);f.multi.serviceShadowTune(f.ns,f.pool,f.p);
    f.api.renderGenerationStatus({print:s=>logs.push(s)}, {generations:[{number:1,state:'ACTIVE'}],shadow:f.p.shadow,hotSwaps:f.p.hotSwaps},false);
    assert.match(logs.join('\n'),/gen 1 ACTIVE.*gen 2 SHADOW/);assert.doesNotMatch(logs.join('\n'),/ATTENTION/);
    f.tune();logs.length=0;
    f.api.renderGenerationStatus({print:s=>logs.push(s)}, {generations:[{number:1,state:'DRAINING'},{number:2,state:'CUTOVER'}],cutover:{...f.p.swap,eta:7000},hotSwaps:f.p.hotSwaps},true);
    assert.match(logs.join('\n'),/DRAINING -> gen 2 CUTOVER/);assert.match(logs.join('\n'),/first new Hack ETA/);
});
