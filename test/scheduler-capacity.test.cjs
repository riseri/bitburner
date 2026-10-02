const test=require('node:test'),assert=require('node:assert/strict');
const {Clock,Port,loadScript}=require('./helpers.cjs');
function fixture() {
    const clock=new Clock(), api=loadScript('lib/target-pipelines.js',clock), capacity=loadScript('lib/scheduler-capacity.js',clock);
    const now=clock.now, p={name:'a',mode:'RUNNING',queue:[],cfg:{lead:600},stats:{pipeline:{}},nextHealth:now+250,
        nextLanding:now+100000,runtime:{plan:{batchRate:1,period:1000,times:{W:4000}}}};
    const pool={cfg:{gap:100,maxTargets:1,maxBatchRate:4,maxLaunches:32,maxWorkers:6000,backgroundPrep:{nextTick:now+500}},
        pipelines:new Map([['a',p]]),running:new Map(),foreign:new Map(),reservations:[],launchBuckets:new Map(),port:new Port(),
        network:{hosts:[{name:'cloud',maxRam:1000}]},lastNetwork:now,lastReconcile:now,lastCleanup:now,lastMonitor:now,lastShare:now,lastUi:now,
        nextAdmissionService:now+100,nextForeign:now+200,targetAnalysis:[{name:'b',steady:1000}]};
    return {clock,api,capacity,pool,p};
}
test('idle scheduler uses bounded long sleeps, while close committed launches retain their guard',()=>{
    const f=fixture();assert.equal(f.api.schedulerSleep(f.pool),100);
    f.p.queue=[{launchAt:f.clock.now+12}];assert.equal(f.api.schedulerSleep(f.pool),10);
    f.clock.now+=10;assert.equal(f.api.schedulerSleep(f.pool),2);
    f.clock.now+=2;assert.equal(f.api.schedulerSleep(f.pool),1);
    f.p.queue.shift();assert.ok(f.api.schedulerSleep(f.pool)>5);
});
test('queued events, recovery and safety deadlines outrank display deadlines',()=>{
    const f=fixture();f.pool.port.write({type:'done'});assert.equal(f.api.schedulerSleep(f.pool),1);f.pool.port.read();
    f.p.recovery={checkAt:f.clock.now+7,deadline:f.clock.now+9};assert.equal(f.api.schedulerSleep(f.pool),7);
    f.p.recovery=null;f.p.nextHealth=f.clock.now+3;assert.equal(f.api.schedulerSleep(f.pool),3);
    f.p.nextHealth+=100;f.pool.lastUi=0;f.p.queue=[{launchAt:f.clock.now+8}];assert.equal(f.api.schedulerSleep(f.pool),6);
});
test('an event arriving during sleep is serviced within the bounded event deadline',async()=>{
    const f=fixture();f.pool.running.set(1,{ram:2});
    f.clock.timer(3,()=>f.pool.port.write({type:'done'}));
    const delay=f.api.schedulerSleep(f.pool);assert.equal(delay,25);
    let resumed=false;f.clock.sleep(delay).then(()=>{resumed=true;assert.equal(f.api.schedulerSleep(f.pool),1);});
    await f.clock.runUntil(f.clock.now+delay);assert.equal(resumed,true);
});
test('foreign inspection runs at 200ms cadence and temporarily accelerates after exec failure',()=>{
    const f=fixture();let scans=0;f.pool.nextForeign=0;f.pool.foreign.set('cloud',0);
    f.pool.api={refreshOneForeignUsage:()=>{scans++;return 0;}};
    for(let i=0;i<1000;i++){f.api.observeForeignRam({},f.pool);f.clock.now++;}
    assert.equal(scans,5);
    f.p.cfg.foreignFailureAt=f.clock.now;f.api.observeForeignRam({},f.pool);
    assert.equal(f.pool.nextForeign,f.clock.now+25);
    f.clock.now+=2100;f.api.observeForeignRam({},f.pool);assert.equal(f.pool.nextForeign,f.clock.now+200);
});
test('capacity identifies real limits independently of low RAM utilization',()=>{
    const f=fixture(), read=()=>f.capacity.schedulerCapacity(f.pool);
    assert.equal(read().limitingFactor,'TARGET_SLOTS');
    f.p.runtime.plan.batchRate=4;assert.equal(read().limitingFactor,'BATCH_RATE');
    f.pool.launchBuckets.set(Math.floor(f.clock.now/250),32);assert.equal(read().limitingFactor,'LAUNCH_RATE');
    f.pool.cfg.maxWorkers=4;f.pool.running.set(1,{ram:2});assert.equal(read().limitingFactor,'WORKER_LIMIT');
    f.p.recovery={};assert.equal(read().limitingFactor,'RECOVERY');
    assert.ok(read().constraints.includes('BATCH_RATE'));
});

test('a current split-batch demand explains launch pressure and expires instead of retaining stale text',()=>{
    const f=fixture();f.pool.cfg.maxLaunches=16;
    f.p.admissionReason='shared launch budget / fragmented batch';
    f.p.admissionDemand={at:f.clock.now,requiredLimit:24,peakBucket:6,peakReserved:12,limit:16};
    f.pool.launchBuckets.set(Math.floor(f.clock.now/250)+40,1);
    let c=f.capacity.schedulerCapacity(f.pool);
    assert.ok(c.constraints.includes('LAUNCH_RATE'));assert.equal(c.launches.requiredLimit,24);
    assert.match(c.reasons.join(' '),/requires 24 launches\/s; budget 16/);
    assert.equal(c.launches.moneyLimit,16);assert.equal(c.launches.optionalLimit,12);
    f.clock.now+=15001;c=f.capacity.schedulerCapacity(f.pool);
    assert.ok(!c.constraints.includes('LAUNCH_RATE'));assert.equal(c.launches.requiredLimit,0);
    assert.equal(f.p.admissionReason,'shared launch budget / fragmented batch');
});

test('two lanes at 3.95 of 4 report the batch budget that blocks a third even with recent launches below the cap',()=>{
    const f=fixture();f.pool.cfg.maxTargets=6;
    f.p.runtime.plan.batchRate=2.36;
    f.pool.pipelines.set('peer',{...f.p,name:'peer',runtime:{plan:{batchRate:1.59}},
        admissionReason:'shared launch budget / fragmented batch'});
    const slot=Math.floor(f.clock.now/250);
    f.pool.launchBuckets=new Map([[slot-3,5],[slot-2,5],[slot-1,5],[slot,4],
        [slot+40,8],[slot+41,8],[slot+42,8],[slot+43,8]]);
    const c=f.capacity.schedulerCapacity(f.pool);
    assert.equal(c.targets.active,2);assert.equal(c.targets.limit,6);
    assert.equal(c.launches.recent,19);assert.equal(c.launches.peakReserved,32);
    assert.equal(c.launches.peakBucket,8);assert.equal(c.launches.bucketLimit,8);
    assert.equal(c.launches.optionalLimit,24);
    assert.ok(Math.abs(c.batchRate.remaining-.05)<1e-9);assert.equal(c.batchRate.nextRequired,.25);
    assert.equal(c.batchRate.nextBlocked,true);assert.ok(c.constraints.includes('LAUNCH_RATE'));
    assert.ok(!c.constraints.includes('BATCH_RATE'),'next-target headroom must not invent a global money ceiling for fleet investment');
    assert.equal(f.api.elasticAdmissionBlocker(f.pool),'BATCH_RATE');
});
test('RAM, preparation and proven XP pressure are distinct from missing capabilities',()=>{
    const f=fixture(), read=()=>f.capacity.schedulerCapacity(f.pool);f.pool.cfg.maxTargets=2;
    f.p.admissionReason='no whole HWGW batch fits host RAM reservations';assert.equal(read().limitingFactor,'RAM');
    f.p.admissionReason='';f.pool.cfg.hackingPolicy={mode:'XP'};
    f.pool.xp={desiredRam:640,jobs:new Map([[1,{ram:180}]]),ramConstrained:true,choice:{name:'xp'}};
    assert.equal(read().limitingFactor,'XP_RAM');assert.equal(read().xp.allocatedRam,180);
    f.pool.cfg.hackingPolicy=null;assert.equal(read().xp.constrained,false);
    f.pool.cfg.backgroundPrep.active={jobs:[{ram:30}]};assert.equal(read().limitingFactor,'PREPARATION');
    assert.equal(read().workers.preparation,1);assert.equal(read().ram.used,30);
});

function endgameXpFixture() {
    const f=fixture();f.pool.cfg.hackingPolicy={mode:'XP'};
    f.pool.cfg.progressionObjective={milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true};
    f.pool.xp={desiredRam:700,ramConstrained:false,status:'RUNNING',samples:[1000,1000,1000],
        choice:{name:'xp',action:'G',score:1000},wave:{action:'G',preparing:false},
        jobs:new Map([[1,{host:'cloud',ram:900}]])};
    return f;
}

test('fully utilized endgame XP requests bounded cloud growth after stable productive waves',()=>{
    const f=endgameXpFixture(), c=f.capacity.schedulerCapacity(f.pool);
    assert.equal(c.xp.allocatedRam,900);assert.equal(c.xp.desiredRam,1125);
    assert.equal(c.xp.expansion,true);assert.equal(c.xp.constrained,true);assert.ok(c.constraints.includes('XP_RAM'));
    assert.ok(c.reasons.some(reason=>reason.includes('bounded expansion')));
});

for(const guard of ['idle-RAM','no-workers','home-only','unknown-model','zero-XP','noisy-XP','warmup','prep','hack','waiting','ordinary-goal','uncovered-cash','reset-pending','installing']) {
    test(`XP cloud growth requires useful endgame capacity: ${guard}`,()=>{
        const f=endgameXpFixture(),xp=f.pool.xp,goal=f.pool.cfg.progressionObjective;
        if(guard==='idle-RAM')xp.jobs.get(1).ram=600;
        if(guard==='no-workers')xp.jobs.clear();
        if(guard==='home-only')xp.jobs.get(1).host='home';
        if(guard==='unknown-model')xp.choice.score=0;
        if(guard==='zero-XP')xp.samples=[0,0,0];
        if(guard==='noisy-XP')xp.samples=[1000,2000,1000];
        if(guard==='warmup')xp.samples=[1000,1000];
        if(guard==='prep')xp.wave.preparing=true;
        if(guard==='hack')xp.wave.action='H';
        if(guard==='waiting')xp.status='WAITING_MONEY';
        if(guard==='ordinary-goal')goal.milestone='DAEDALUS';
        if(guard==='uncovered-cash')goal.moneyCovered=false;
        if(guard==='reset-pending')goal.resetPending=true;
        if(guard==='installing')goal.resetImminent=true;
        const c=f.capacity.schedulerCapacity(f.pool);
        assert.equal(c.xp.expansion,false);assert.equal(c.xp.constrained,false);assert.equal(c.xp.desiredRam,700);
    });
}
test('tiny fleet and missing candidate evidence need no advanced APIs',()=>{
    const f=fixture();f.pool.network.hosts[0].maxRam=8;f.pool.targetAnalysis=[];
    assert.equal(f.capacity.schedulerCapacity(f.pool).limitingFactor,'NONE');
    f.pool.nextReadyScan=f.clock.now+100;assert.equal(f.capacity.schedulerCapacity(f.pool).limitingFactor,'NO_PROFITABLE_TARGET');
});

test('automatic cloud demand distinguishes useful RAM from cadence and steal saturation',()=>{
    const f=fixture();f.pool.cfg.maxTargets=6;f.pool.cfg.maxSteal=.5;f.pool.targetAnalysis=[];
    const scaler=loadScript('lib/scheduler-scaling.js',f.clock);scaler.createSchedulerScaling(f.pool.cfg);
    Object.assign(f.p.runtime.plan,{batchRate:1000/423,period:423,steal:.4988});
    f.pool.running.set(1,{host:'cloud',ram:900});
    assert.equal(f.capacity.schedulerCapacity(f.pool).ram.scalable,false);
    const economics=loadScript('lib/fleet-economics.js',f.clock);
    assert.equal(economics.fleetCapacityPolicy({capacity:f.capacity.schedulerCapacity(f.pool)}).ok,false);
    f.p.runtime.plan.steal=.25;assert.equal(f.capacity.schedulerCapacity(f.pool).ram.scalable,true);
    f.p.runtime.plan.steal=.4988;f.p.runtime.plan.period=1000;f.p.runtime.plan.batchRate=1;
    assert.equal(f.capacity.schedulerCapacity(f.pool).ram.scalable,true);
    f.p.runtime.plan.period=423;f.p.runtime.plan.batchRate=1000/423;
    f.pool.targetAnalysis=[{name:'b',steady:1000}];
    assert.equal(f.capacity.schedulerCapacity(f.pool).ram.scalable,true,'useful open lane may need memory even when incumbent is capped');
});

test('multiple close launches are ordered across lanes without a UI sleep crossing them',()=>{
    const f=fixture(), fired=[];f.pool.api={launchDueChunks:(ns,queue,name)=>{fired.push([name,f.clock.now]);return {queue:queue.slice(1),drain:null};}};
    f.p.queue=[{launchAt:f.clock.now+10}];
    const peer={...f.p,name:'b',queue:[{launchAt:f.clock.now+12}]};f.pool.pipelines.set('b',peer);
    const end=f.clock.now+13;
    while(f.clock.now<end){f.clock.now+=f.api.schedulerSleep(f.pool);f.api.launchPipelineChunks({},f.pool);}
    assert.deepEqual(fired,[['a',1000010],['b',1000012]]);
});

test('ten idle seconds avoid the old 2000 scheduler wakeups',()=>{
    const f=fixture(),end=f.clock.now+10000;let wakes=0;
    while(f.clock.now<end){
        for(const key of ['lastNetwork','lastReconcile','lastCleanup','lastMonitor','lastShare','lastUi'])f.pool[key]=f.clock.now;
        f.pool.nextAdmissionService=f.clock.now+100;f.pool.nextForeign=f.clock.now+200;
        f.pool.cfg.backgroundPrep.nextTick=f.clock.now+500;f.p.nextHealth=f.clock.now+250;
        f.clock.now+=f.api.schedulerSleep(f.pool);wakes++;
    }
    assert.equal(wakes,100);
});
