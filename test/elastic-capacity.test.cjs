const test=require('node:test'),assert=require('node:assert/strict');
const {Clock,Port,loadScript}=require('./helpers.cjs');
function fixture() {
    const clock=new Clock(),api=loadScript('daemon.js',clock),multi=loadScript('lib/target-pipelines.js',clock);
    const cfg={maxTargets:6,targetMode:'auto',maxBatchRate:4,maxWorkers:100,maxLaunches:32,gap:100,lead:600,switchThreshold:1.25,
        backgroundPrep:{enabled:false,status:'DISABLED'},prepStates:[]};
    const pool={cfg,api,pipelines:new Map(),network:{hosts:[{name:'cloud',maxRam:10000}],servers:[]},foreign:new Map(),running:new Map(),reservations:[],
        launchBuckets:new Map(),port:new Port(),controls:new Map(),controlPort:new Port(),blocked:new Map(),nextReadyScan:0};
    for(let i=0;i<3;i++){
        const p=multi.createTargetPipeline('lane'+i,cfg,api,1,i,{plan:{batchRate:1,period:1000,expected:1000*(3-i),times:{W:4000}}});
        p.trial=false;p.stats.pipeline.productiveMs=200000;p.stats.lastHackAt=clock.now;
        p.control=multi.targetControl(pool,p);pool.pipelines.set(p.name,p);
    }
    pool.anchor='lane0';return {clock,api,multi,pool};
}
test('explicit 1/2 remain supported; automatic limit is a ceiling rather than a minimum',()=>{
    const api=loadScript('lib/target-limit.js',new Clock());
    for(const n of [1,2,3,4,5,6])assert.equal(api.targetLimit(n).limit,n);
    assert.equal(api.targetLimit('auto').limit,6);
    for(const n of [0,7,1.5,'bad'])assert.throws(()=>api.targetLimit(n));
});
test('remaining global rate counts all lanes; replacement releases only the selected lane',()=>{
    const f=fixture();assert.equal(f.multi.remainingBatchRate(f.pool),1);
    assert.equal(f.multi.remainingBatchRate(f.pool,f.pool.pipelines.get('lane1')),2);
    assert.equal(f.multi.elasticAdmissionBlocker(f.pool),'');
    f.pool.cfg.maxBatchRate=3;assert.equal(f.multi.elasticAdmissionBlocker(f.pool),'BATCH_RATE');
});

test('batch-bound AUTO scouts a replacement and clears stale handoff status despite empty slots',()=>{
    const f=fixture();f.pool.pipelines.delete('lane2');
    f.pool.pipelines.get('lane0').runtime.plan.batchRate=2.36;
    f.pool.pipelines.get('lane1').runtime.plan.batchRate=1.59;
    f.pool.pipelines.get('lane1').admissionReason='shared launch budget / fragmented batch';
    f.pool.cfg.backgroundPrep=loadScript('lib/background-prep.js',f.clock).createBackgroundPrep();
    Object.assign(f.pool.cfg.backgroundPrep,{status:'ADMITTED',target:'',candidate:null,active:null,
        reason:'handed off to an independent target pipeline'});
    f.multi.serviceBackgroundAndAdmission({},f.pool);
    assert.equal(f.pool.pipelines.size,2);assert.equal(f.pool.admission.decision,'PREP REPLACEMENT');
    assert.equal(f.pool.admission.replacing,'lane1');assert.equal(f.pool.cfg.backgroundPrep.status,'IDLE');
    assert.match(f.pool.admission.reason,/shared batch budget full/);
    assert.doesNotMatch(f.pool.cfg.backgroundPrep.reason,/handed off/);
});

test('a batch-bound AUTO replacement still waits for validated earnings and a safe transition',()=>{
    const f=fixture();f.pool.pipelines.delete('lane2');f.pool.cfg.maxBatchRate=2;
    const weak=f.pool.pipelines.get('lane1');
    assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now),weak);
    for(const state of [{trial:true},{recovery:{}},{shadow:{state:'PREFLIGHT'}},{swap:{state:'CUTOVER'}}]){
        Object.assign(weak,state);assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now),null);
        weak.trial=false;weak.recovery=null;weak.shadow=null;weak.swap=null;
    }
    weak.shadow={state:'SHADOW'};assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now),weak);
});

test('cash-covered final-server AUTO may replace bootstrap lanes while ordinary AUTO can grow the batch budget',()=>{
    const f=fixture();f.pool.pipelines.delete('lane2');f.pool.cfg.maxBatchRate=2;
    f.pool.cfg.schedulerScaling={batchMode:'auto',batch:2,batchCeiling:14};
    assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now),null);
    f.pool.cfg.progressionObjective={milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true};
    assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now).name,'lane1');
});

test('a successful handoff returns prep to waiting rather than labeling an empty candidate admitted',()=>{
    const f=fixture();f.pool.pendingAdmission='candidate';f.pool.pendingAdmissionFloor=1500;f.pool.nextOrdinal=3;
    f.pool.api={...f.api,targetHealth:()=>({clean:true})};
    Object.assign(f.pool.cfg.backgroundPrep,{enabled:true,status:'READY',target:'candidate',
        candidate:{name:'candidate',minimumExpected:1500},active:null});
    f.multi.serviceBackgroundAndAdmission({getHackingLevel:()=>100},f.pool);
    assert.ok(f.pool.pipelines.has('candidate'));assert.equal(f.pool.cfg.backgroundPrep.target,'');
    assert.equal(f.pool.cfg.backgroundPrep.status,'WAITING');
    assert.match(f.pool.cfg.backgroundPrep.reason,/candidate handed off/);
    assert.equal(f.pool.pendingAdmission,'');
});

test('replacing a weak lane uses its replacement hurdle rather than the whole-pool additive floor',()=>{
    const f=fixture();
    assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,false),1500);
    assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,true),1250);
    f.pool.cfg.maxTargets=2;assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,false),1250);
});

for(const cause of ['governor','XP','contention'])test(`the paid trial compares a consistent income baseline after ${cause}`,()=>{
    const f=fixture(),p=f.pool.pipelines.get('lane0'),trial=f.pool.pipelines.get('lane1');
    f.pool.pipelines.delete('lane2');f.pool.cfg.hackingPolicy={mode:'MONEY',xpAllocation:0};
    function paid(lane,rate){lane.stats.income=[{time:f.clock.now,money:rate*60}];lane.stats.lastHackAt=f.clock.now;}
    paid(p,1000);paid(trial,0);trial.trial=true;
    trial.stats.pipeline.completed=200;trial.firstLanding=p.firstLanding=f.clock.now-120000;
    trial.trialUntil=f.clock.now;f.pool.slowTicks=[];
    f.pool.trialGuard=f.multi.incomeGuard(f.pool,p,trial,f.clock.now);
    if(cause==='governor')f.pool.cfg.maxBatchRate=2;
    if(cause==='XP')f.pool.cfg.hackingPolicy.xpAllocation=.5;
    paid(p,500);paid(trial,200);
    f.multi.monitorPipelineLoad({},f.pool,f.clock.now);
    if(cause==='contention') {
        assert.equal(trial.trial,true);assert.ok(f.pool.trialGuard.badSince);
        f.clock.now+=60001;paid(p,500);paid(trial,200);
        f.multi.monitorPipelineLoad({},f.pool,f.clock.now);
        assert.equal(trial.retiring,true,'real incumbent harm still rejects the trial');
    } else {
        assert.equal(trial.trial,false,'a common policy reduction is not charged as trial damage');
        assert.equal(trial.retiring,false);assert.equal(f.pool.trialGuard,null);
    }
});

test('restored budgets cannot raise the trial income hurdle before slower admitted work pays out',()=>{
    const f=fixture(),p=f.pool.pipelines.get('lane0'),trial=f.pool.pipelines.get('lane1');
    f.pool.pipelines.delete('lane2');f.pool.cfg.hackingPolicy={mode:'MONEY',xpAllocation:0};
    p.stats.income=[{time:f.clock.now,money:1000*60}];
    const guard=f.multi.incomeGuard(f.pool,p,trial,f.clock.now);
    p.stats.income=[{time:f.clock.now,money:500*60,admissionPolicy:{batchLimit:2,moneyAllocation:1}}];
    assert.equal(f.multi.trialBaselineScale(f.pool,guard,p,f.clock.now),.5);
    f.clock.now+=60001;
    p.stats.income=[{time:f.clock.now,money:1000*60,admissionPolicy:{batchLimit:4,moneyAllocation:1}}];
    assert.equal(f.multi.trialBaselineScale(f.pool,guard,p,f.clock.now),1);
});
for(const constraint of ['RAM','WORKER_LIMIT','LAUNCH_RATE','XP_RAM','RECOVERY','WAITING_STABLE_LANES'])test(`${constraint} blocks elastic admission before another trial starts`,()=>{
    const f=fixture(),p=f.pool.pipelines.get('lane1');
    if(constraint==='RAM')p.admissionReason='host RAM reservations';
    if(constraint==='WORKER_LIMIT')f.pool.cfg.maxWorkers=3;
    if(constraint==='LAUNCH_RATE')f.pool.launchBuckets.set(Math.floor(f.clock.now/250),32);
    if(constraint==='XP_RAM'){f.pool.cfg.hackingPolicy={mode:'XP'};f.pool.xp={desiredRam:100,ramConstrained:true,jobs:new Map()};}
    if(constraint==='RECOVERY')p.recovery={};
    if(constraint==='WAITING_STABLE_LANES')p.trial=true;
    assert.equal(f.multi.elasticAdmissionBlocker(f.pool),constraint);
});
test('weakest-lane selection handles four targets and does not select the healthy anchor',()=>{
    const f=fixture();f.pool.cfg.maxTargets=3;
    assert.equal(f.multi.steadyPromotionSupport(f.pool,f.clock.now).name,'lane2');
    const support=f.pool.pipelines.get('lane2');support.mode='TUNING';support.stalledSince=f.clock.now-700000;support.firstLanding=f.clock.now-800000;
    assert.equal(f.multi.stalledPromotionSupport(f.pool,f.clock.now).name,'lane2');
});
test('no profitable candidate is admitted just because RAM is free, without Formulas APIs',()=>{
    const f=fixture();f.pool.network.servers=['bad'];f.pool.cfg.maxSteal=.5;
    const ns={hasRootAccess:()=>true,getServerMaxMoney:()=>0,getServerRequiredHackingLevel:()=>1,getHackingLevel:()=>100};
    assert.equal(f.multi.nextReadyCandidate(ns,f.pool,f.pool.pipelines.get('lane0'),f.clock.now),'');
    assert.equal(f.pool.pipelines.size,3);
});
