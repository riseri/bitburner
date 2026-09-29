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
test('tiny fleet and missing candidate evidence need no advanced APIs',()=>{
    const f=fixture();f.pool.network.hosts[0].maxRam=8;f.pool.targetAnalysis=[];
    assert.equal(f.capacity.schedulerCapacity(f.pool).limitingFactor,'NONE');
    f.pool.nextReadyScan=f.clock.now+100;assert.equal(f.capacity.schedulerCapacity(f.pool).limitingFactor,'NO_PROFITABLE_TARGET');
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
