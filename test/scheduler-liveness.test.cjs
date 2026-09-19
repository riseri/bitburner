const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), api = loadScript('daemon.js', clock);
    const multi = loadScript('lib/target-pipelines.js', clock);
    const cfg = { gap:100, lead:600, homeReserve:8, port:20, controlPort:15,
        maxTargets:2, maxWorkers:6000, maxLaunches:32, maxBatchRate:4, minimumPeriod:250,
        minSteal:.01, maxSteal:.5, periodScale:1, ram:{H:2,G:2.2,W:2.2} };
    const plan = { period:500, batchRate:2, expected:1000, times:{H:1000,G:3200,W:4000} };
    const pool = {api,cfg,ownerPid:1,controls:new Map(),controlPort:new Port(),port:new Port(),
        pipelines:new Map(),running:new Map(),runningByChunk:new Map(),reservations:[],foreign:new Map(),
        launchBuckets:new Map(),anchor:'foodnstuff',planCursor:0,history:[],note:'',network:{hosts:[]}};
    const p = multi.createTargetPipeline('foodnstuff',cfg,api,1,0,{plan});
    const peer = multi.createTargetPipeline('peer',cfg,api,1,1,{plan});
    for(const item of [p,peer]) {pool.pipelines.set(item.name,item);item.control=multi.targetControl(pool,item);api.publishHackPause(item.control,0,'ready');}
    const ns = { getServerMaxMoney:()=>50e6,getServerMoneyAvailable:()=>50e6,
        getServerSecurityLevel:()=>3,getServerMinSecurityLevel:()=>3 };
    return {clock,api,multi,pool,p,peer,ns,cfg};
}

function idle(f) {
    f.multi.replanIdlePipeline(f.ns,f.pool,f.p,f.clock.now);
    f.clock.now += 5001;
    return f.multi.replanIdlePipeline(f.ns,f.pool,f.p,f.clock.now);
}

test('empty pipeline replans without two productive minutes or a recent Hack',()=>{
    const f=fixture(); f.p.stats.pipeline.completed=20;f.p.stats.money=3.1e9;
    assert.equal(idle(f),true);assert.equal(f.p.mode,'TUNING');
    assert.equal(f.p.idleRetunes,1);assert.equal(f.p.stats.money,3.1e9);
    assert.equal(f.p.stats.restarts,0);assert.equal(f.p.stats.resyncs,0);
    assert.equal(f.p.cfg.gap,100);assert.equal(f.p.cfg.lead,600);
    assert.equal(f.peer.epoch,'1:1:1');assert.equal(f.pool.controlPort.peek().targets.peer.paused,false);
});

for(const state of ['queued','running','batches','repair','recovering','draining','retiring']) {
    test(`idle recovery does not disturb ${state} work`,()=>{
        const f=fixture();
        if(state==='queued') f.p.queue.push({});
        if(state==='running') f.p.running.set(99,{});
        if(state==='batches') f.p.batches.set('inflight',{});
        if(state==='repair') f.p.repair={active:{pid:99}};
        if(state==='recovering') f.p.recovery={};
        if(state==='draining') f.p.drain={};
        if(state==='retiring') f.p.retiring=true;
        assert.equal(idle(f),false);assert.equal(f.p.idleRetunes,0);assert.equal(f.p.epoch,'1:0:1');
    });
}

test('global ownership check refuses to clear an untracked live worker or live reservation',()=>{
    const f=fixture(); f.pool.running.set(99,{owner:f.p});
    assert.equal(idle(f),false); f.pool.running.clear();
    f.pool.reservations.push({chunk:{owner:f.p,status:'called'}});
    assert.equal(idle(f),false);assert.equal(f.pool.reservations.length,1);
});

test('idle cleanup releases only terminal reservations from its target and preserves peer accounting',()=>{
    const f=fixture();const peer={host:'cloud',chunk:{owner:f.peer,status:'called'}};
    f.pool.reservations.push({host:'home',chunk:{owner:f.p,status:'done'}},peer);
    assert.equal(idle(f),true);assert.deepEqual(f.pool.reservations,[peer]);
    assert.equal(f.api.reservationIndex(f.pool.reservations).get('cloud')[0],peer);
});

test('dirty idle target prepares instead of starting an unprepared hacking plan',()=>{
    const f=fixture();f.ns.getServerSecurityLevel=()=>8;
    assert.equal(idle(f),true);assert.equal(f.p.mode,'PREPARING');
});

test('persistent idle failures back off without erasing session income',()=>{
    const f=fixture(); assert.equal(idle(f),true);
    f.p.mode='RUNNING';assert.equal(idle(f),true);
    f.p.mode='RUNNING';assert.equal(idle(f),false);
    f.clock.now=f.p.idleRetryAt;assert.equal(f.multi.replanIdlePipeline(f.ns,f.pool,f.p,f.clock.now),true);
    assert.equal(f.p.idleRetunes,3);assert.ok(f.p.idleRetryAt-f.clock.now>=20000);
});

test('probe rejects fragmented launch bursts and rolls back without touching peer reservations',()=>{
    const f=fixture(), sentinel={host:'cloud',chunk:{owner:f.peer,status:'called'}};
    f.pool.reservations.push(sentinel);f.api.rebuildReservationIndex(f.pool.reservations);
    f.api.reserveBatch=(ns,name,id,landing)=>{
        const chunks=Array.from({length:9},(_,i)=>({host:'home',ram:2,launchAt:landing-4000,landAt:landing,chunkId:id+':'+i}));
        for(const c of chunks)f.api.reserveChunk(f.pool.reservations,c);
        return {chunks};
    };
    assert.equal(f.multi.idlePlanFits(f.ns,f.pool,f.p,f.p.runtime.plan),false);
    assert.deepEqual(f.pool.reservations,[sentinel]);
    assert.equal(f.api.reservationIndex(f.pool.reservations).get('cloud')[0],sentinel);
    assert.equal(f.pool.launchBuckets.size,0);
});

test('yielding tuner can choose a smaller genuinely admissible plan and rejects all-impossible cases',()=>{
    const f=fixture();const host={name:'home',maxRam:131072,cores:6};
    const ns={getServerUsedRam:()=>0,weakenAnalyze:(t,c=1)=>t*.05*(1+(c-1)/16),
        hackAnalyzeSecurity:t=>t*.002,growthAnalyzeSecurity:t=>t*.004};
    const model={maxMoney:50e6,chance:1,hackPercent:.001,times:{H:1000,G:3200,W:4000},growthAnalyze:m=>Math.log(m)*100};
    const tune = accept=>{const it=f.api.tuneTargetSteps(ns,'foodnstuff',[host],f.cfg,new Map(),model,accept);let s;do{s=it.next();}while(!s.done);return s.value;};
    const ordinary=tune(null), restricted=tune(p=>p.H<=50);
    assert.ok(ordinary.plan.H>50);assert.ok(restricted.plan.H<=50);assert.ok(restricted.plan.expected>0);
    assert.equal(tune(()=>false),null);
});

test('an idle tuner with no feasible candidate waits before retrying instead of claiming RUNNING',()=>{
    const f=fixture(); assert.equal(idle(f),true);
    f.p.tuner={next:()=>({done:true,value:null})};
    f.multi.servicePipelineMaintenance(f.ns,f.pool);
    assert.equal(f.p.mode,'TUNING');assert.ok(f.p.nextRetry>f.clock.now);
    assert.match(f.p.note,/No plan fits/);assert.equal(f.p.stats.restarts,0);
    assert.equal(f.pool.controlPort.peek().targets.peer.paused,false);
});

test('normal dashboard exposes an empty lane and its admission failure without details mode',()=>{
    const f=fixture(), logs=[],status=new Port();
    f.pool.started=f.clock.now-60000;f.pool.targetAnalysis=[];f.pool.cloudState={count:0,limit:25,totalRam:0};
    f.pool.network={hosts:[],servers:[],rooted:0};f.pool.lagMax=0;
    f.p.admissionReason='shared launch budget / fragmented batch';f.p.admissionSkips=12;
    f.api.renderSchedulerDashboard({...f.ns,pid:1,getHackingLevel:()=>510,getPortHandle:()=>status,
        clearLog(){},print:text=>logs.push(text)},f.pool);
    assert.equal(status.peek().pipelines[0].mode,'IDLE');
    assert.ok(logs.some(line=>line.includes('Pressure')));
    assert.ok(logs.some(line=>line.includes('fragmented batch')));
    assert.ok(!logs.some(line=>line.includes('budget skips')),
        'budget-skip telemetry belongs in details mode, not the operator view');
});
