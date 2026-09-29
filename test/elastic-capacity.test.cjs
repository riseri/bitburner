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

test('replacing a weak lane uses its replacement hurdle rather than the whole-pool additive floor',()=>{
    const f=fixture();
    assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,false),1500);
    assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,true),1250);
    f.pool.cfg.maxTargets=2;assert.equal(f.multi.admissionIncomeFloor(f.pool,1250,false),1250);
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
