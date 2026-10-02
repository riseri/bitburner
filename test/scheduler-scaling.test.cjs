const test=require('node:test'),assert=require('node:assert/strict');
const {Clock,loadScript}=require('./helpers.cjs');

function fixture(batch='auto',launches='auto') {
    const clock=new Clock(),api=loadScript('lib/scheduler-scaling.js',clock);
    const cfg={maxTargets:6,gap:100};
    const state=api.createSchedulerScaling(cfg,batch,launches);
    const input={gap:100,stable:true,income:1000,goal:'MONEY:money',maxActionTime:10000,skillGoal:false,
        faults:[['p:1',0],['peer:1',0]],capacity:{constraints:['LAUNCH_RATE'],targets:{active:2,limit:6,profitableInactive:1},
            ram:{total:4000,used:3000,utilization:.75,scalable:true},batchRate:{used:3.95,limit:4,nextBlocked:true},
            launches:{peakBucket:8,bucketLimit:8,peakReserved:32,limit:32},workers:{committed:200,limit:6000}}};
    function sample(delay=10000,timing={loop:0,launch:0,landing:0}) {
        clock.now+=delay;
        for(const [kind,count] of [['loop',100],['launch',20],['landing',20]])
            for(let i=0;i<count;i++)api.recordSchedulerTiming(state,kind,timing[kind],100);
        const changed=api.tickSchedulerScaling(state,input,clock.now);
        if(changed)api.applySchedulerLimits(cfg,state);
        return changed;
    }
    const observe=()=>{for(let i=0;i<7;i++)sample();};
    return {clock,api,cfg,state,input,sample,observe};
}

test('healthy paid work breaks the 3.95/4 and fragmented 32-launch ceiling without manual flags',()=>{
    const f=fixture();f.observe();
    assert.equal(f.cfg.maxBatchRate,4.5);assert.equal(f.cfg.maxLaunches,40);
    assert.equal(f.state.decision,'INCREASE');assert.ok(f.state.preferTargets);
    assert.ok(f.state.batchCeiling>8,'ceiling follows six-target phase cadence instead of the old fixed batch cap');
    assert.equal(f.cfg.minimumPeriod,1000/4.5);
    f.sample();assert.equal(f.state.decision,'OBSERVE');
    f.input.income=1400;f.input.capacity.batchRate.used=4.45;
    f.input.capacity.launches={peakBucket:10,bucketLimit:10,peakReserved:40,limit:40};
    for(let i=0;i<8;i++)f.sample();
    assert.ok(f.cfg.maxBatchRate>4.5);assert.ok(f.cfg.maxLaunches>40);
});

test('widespread new faults or recent timing pressure lower future admission, with a cooldown',()=>{
    const f=fixture();f.observe();
    f.input.faults=[['p:1',1],['peer:1',1]];f.sample();
    assert.equal(f.state.decision,'BACKOFF');assert.ok(f.cfg.maxBatchRate<4);assert.equal(f.cfg.maxLaunches,28);
    const batch=f.cfg.maxBatchRate,launches=f.cfg.maxLaunches;
    f.sample(10000,{loop:100,launch:100,landing:100});
    assert.equal(f.state.decision,'COOLDOWN');assert.equal(f.cfg.maxBatchRate,batch);assert.equal(f.cfg.maxLaunches,launches);
    f.input.faults=[['p:2',0]];f.sample();
    assert.notEqual(f.state.decision,'BACKOFF','a new epoch does not inherit the previous fault count');
});

test('a single lane fault pauses expansion without changing peer budgets',()=>{
    const f=fixture();f.observe();const before=[f.cfg.maxBatchRate,f.cfg.maxLaunches];
    f.input.faults=[['p:1',1],['peer:1',0]];f.input.recovering=true;f.sample();
    assert.deepEqual([f.cfg.maxBatchRate,f.cfg.maxLaunches],before);assert.equal(f.state.decision,'OBSERVE');
});

test('one old slow tick cannot veto growth after fresh healthy windows',()=>{
    const f=fixture();f.sample(10000,{loop:300,launch:0,landing:0});
    assert.equal(f.state.decision,'BACKOFF');
    f.input.capacity.batchRate.used=2.95;
    for(let i=0;i<14;i++)f.sample();
    assert.ok(f.state.changes>1);assert.equal(f.cfg.maxBatchRate,3.5);
});

test('sustained external recovery does not repeatedly shrink the budgets',()=>{
    const f=fixture();f.input.recovering=true;f.input.stable=false;f.sample();
    const batch=f.cfg.maxBatchRate,launches=f.cfg.maxLaunches;
    for(let i=0;i<30;i++)f.sample();
    assert.equal(f.cfg.maxBatchRate,batch);assert.equal(f.cfg.maxLaunches,launches);
    assert.equal(f.state.ramRequest,null);
});

for(const mode of ['both-fixed','fixed-batch','fixed-launch'])test(`explicit ceilings survive adaptation and backoff: ${mode}`,()=>{
    const f=fixture(mode==='fixed-launch'?'auto':4,mode==='fixed-batch'?'auto':32);
    f.observe();f.sample(10000,{loop:120,launch:80,landing:80});
    if(mode!=='fixed-launch')assert.equal(f.cfg.maxBatchRate,4);
    if(mode!=='fixed-batch')assert.equal(f.cfg.maxLaunches,32);
    if(mode==='both-fixed')assert.equal(f.state.decision,'FIXED');
});

for(const guard of ['warmup','trial','reset','missing-timing','no-income','processes'])test(`no speculative growth while ${guard}`,()=>{
    const f=fixture();
    if(['warmup','trial'].includes(guard))f.input.stable=false;
    if(guard==='reset')f.input.resetPending=true;
    if(guard==='no-income')f.input.income=0;
    if(guard==='processes')f.input.capacity.workers.committed=5000;
    if(guard==='missing-timing') {
        for(let i=0;i<10;i++){f.clock.now+=10000;f.api.tickSchedulerScaling(f.state,f.input,f.clock.now);}
    } else f.observe();
    assert.equal(f.cfg.maxBatchRate,4);assert.equal(f.cfg.maxLaunches,32);assert.equal(f.state.ramRequest,null);
});

test('a higher ceiling that earns no additional throughput is rolled back instead of growing indefinitely',()=>{
    const f=fixture();f.observe();
    f.input.capacity.constraints=[];
    Object.assign(f.input.capacity.launches,{peakBucket:2,peakReserved:10});
    f.input.capacity.batchRate.nextBlocked=false;
    for(let i=0;i<9;i++)f.sample();
    assert.equal(f.cfg.maxBatchRate,4);assert.equal(f.cfg.maxLaunches,32);
    assert.equal(f.state.decision,'COOLDOWN');assert.match(f.state.reason,/did not improve/);
    assert.ok(f.state.cooldownUntil>f.clock.now+500000);
});

test('rate and RAM expansion are coordinated rather than rejecting the rate probe before memory can be funded',()=>{
    const f=fixture();f.input.capacity.constraints=['RAM'];
    Object.assign(f.input.capacity.ram,{used:3800,utilization:.95});
    Object.assign(f.input.capacity.launches,{peakReserved:30});
    f.observe();assert.equal(f.cfg.maxBatchRate,4.5);assert.equal(f.cfg.maxLaunches,40);
    Object.assign(f.input.capacity.batchRate,{limit:4.5,remaining:.55,nextBlocked:false});
    for(let i=0;i<7;i++)f.sample();
    assert.equal(f.state.decision,'RAM');assert.equal(f.state.ramRequest.addedRam,1000);
    assert.equal(f.cfg.maxBatchRate,4.5,'more budget waits for funded RAM instead of being rolled back');
    Object.assign(f.input.capacity.ram,{total:5000,utilization:.76});f.input.capacity.constraints=[];
    Object.assign(f.input.capacity.launches,{peakBucket:2,bucketLimit:10,peakReserved:10,limit:40});
    f.sample();assert.equal(f.state.ramRequest,null);assert.equal(f.state.decision,'VERIFY');
    f.input.income=1500;for(let i=0;i<9;i++)f.sample();
    assert.equal(f.state.probe,null);assert.equal(f.cfg.maxBatchRate,4.5);
});

test('hacking endgame scales launch capacity for XP without expanding unnecessary money work',()=>{
    const f=fixture();f.input.skillGoal=true;f.input.goal='FINAL_SERVER:hacking';f.input.xpRate=100;f.input.xpWaitingLaunch=true;
    f.observe();assert.equal(f.cfg.maxBatchRate,4);assert.equal(f.cfg.maxLaunches,40);
    f.input.xpRate=160;for(let i=0;i<9;i++)f.sample();
    assert.ok(f.cfg.maxLaunches>40);assert.equal(f.cfg.maxBatchRate,4);
});

test('productive remote RAM pressure requests one bounded step only with real throughput headroom',()=>{
    const f=fixture();f.input.capacity.constraints=['RAM'];
    Object.assign(f.input.capacity.ram,{used:3800,utilization:.95});
    Object.assign(f.input.capacity.batchRate,{used:2,nextBlocked:false});
    Object.assign(f.input.capacity.launches,{peakBucket:2,peakReserved:10});
    f.observe();assert.equal(f.state.decision,'RAM');
    assert.equal(f.state.ramRequest.addedRam,1000);assert.equal(f.state.ramRequest.confidence,'MEASURED');
    f.input.resetPending=true;f.sample();assert.equal(f.state.ramRequest,null);
});

test('RAM pressure cannot fund capacity that no money plan or additional lane can use',()=>{
    const f=fixture();f.input.capacity.constraints=['RAM'];
    Object.assign(f.input.capacity.ram,{used:3800,utilization:.95,scalable:false});
    Object.assign(f.input.capacity.batchRate,{used:2,nextBlocked:false});
    Object.assign(f.input.capacity.launches,{peakBucket:2,peakReserved:10});
    f.observe();assert.equal(f.state.ramRequest,null);assert.equal(f.cfg.maxBatchRate,4);
});

test('downscaling fairly paces all lanes while preserving their modeled plans',()=>{
    const f=fixture();f.cfg.maxBatchRate=3;
    const pool={cfg:f.cfg,pipelines:new Map([['a',{runtime:{plan:{batchRate:2}}}],['b',{runtime:{plan:{batchRate:2}}}]])};
    assert.equal(f.api.governedBatchScale(pool),.75);assert.equal(f.api.governedPeerRate(pool),3);
    assert.equal(f.api.governedPeerRate(pool,pool.pipelines.get('a')),1.5);
    assert.equal(pool.pipelines.get('a').runtime.plan.batchRate,2);
});

test('a validating trial cannot strand the previous budgets after two measured backoffs',()=>{
    const f=fixture();f.input.stable=false;f.input.earningStable=true;
    f.sample(10000,{loop:300,launch:0,landing:0});
    f.sample(120000,{loop:300,launch:0,landing:0});
    assert.equal(f.cfg.maxBatchRate,2.25);assert.equal(f.cfg.maxLaunches,16);
    assert.deepEqual({...f.state.restore},{batch:4,launches:32});
    for(let i=0;i<12;i++)f.sample();
    assert.equal(f.state.decision,'RESTORE');assert.equal(f.cfg.maxBatchRate,2.75);assert.equal(f.cfg.maxLaunches,24);
    for(let i=0;i<21;i++)f.sample();
    assert.equal(f.cfg.maxBatchRate,4);assert.equal(f.cfg.maxLaunches,32);assert.equal(f.state.restore,null);
    for(let i=0;i<14;i++)f.sample();
    assert.equal(f.cfg.maxBatchRate,4,'restoration is not speculative expansion beyond the previous budgets');
});

for(const guard of ['no-incumbent','late-timing','recovery','reset'])test(`trial budget recovery retains ${guard} protection`,()=>{
    const f=fixture();f.input.stable=false;f.input.earningStable=true;
    f.sample(10000,{loop:300,launch:0,landing:0});
    if(guard==='no-incumbent')f.input.earningStable=false;
    if(guard==='recovery')f.input.recovering=true;
    if(guard==='reset')f.input.resetPending=true;
    for(let i=0;i<14;i++)f.sample(10000,guard==='late-timing'?{loop:300,launch:0,landing:0}:undefined);
    assert.ok(f.cfg.maxBatchRate<=3);assert.ok(f.cfg.maxLaunches<=24);
});
