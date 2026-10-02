const test = require('node:test'), assert = require('node:assert/strict');
const {Clock, Port, loadScript} = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), ports = new Map(), files = new Map(), actions = [], copies = [];
    const reset = {currentNode:4,lastNodeReset:1,lastAugReset:2};
    const world = {cash:6400, names:[], limit:2, unitCost:100};
    const processes = [{pid:9,filename:'fleet-manager.js'},{pid:7,filename:'daemon.js'},{pid:10,filename:'augmentation-manager.js'}];
    const ns = {pid:9,getResetInfo:()=>reset,ps:()=>processes,isRunning:pid=>processes.some(p=>p.pid===pid),
        read:f=>files.get(f)||'',write:async(f,v)=>files.set(f,v),hasTorRouter:()=>true,fileExists:()=>true,
        getPortHandle:n=>{if(!ports.has(n))ports.set(n,new Port());return ports.get(n);},
        getServerMoneyAvailable:()=>world.cash,getServerMaxRam:()=>32,serverExists:name=>world.names.includes(name),
        scp:async(...args)=>copies.push(args),
        cloud:{getServerNames:()=>world.names,getServerLimit:()=>world.limit,getRamLimit:()=>64,
            getServerCost:ram=>ram*world.unitCost,getServerUpgradeCost:(name,ram)=>(ram-32)*world.unitCost,
            purchaseServer:(name,ram)=>{actions.push(['buy',name,ram]);world.names.push(name);world.cash-=ram*world.unitCost;return name;},
            upgradeServer:(name,ram)=>{actions.push(['upgrade',name,ram]);world.cash-=(ram-32)*world.unitCost;return true;}}};
    const cfg = {stockPort:13,cloud:{enabled:true,roi:true,payback:1800,minRam:8,maxAction:.25,cashFloor:0,cashReserve:.1,prefix:'cloud'}};
    const state = {enabled:true,purchases:0,upgrades:0,spent:0};
    const savings = loadScript('lib/savings.js',clock), fleet = loadScript('fleet-manager.js',clock);
    const supervisor = loadScript('lib/supervised-utilities.js',clock), reader=loadScript('lib/fleet-capital.js',clock);
    const status = () => ({type:'fleet-status',producerPid:9,generatedAt:clock.now,cloud:{...state}});
    const policy = {savingsMode:'auto',progression:false,augmentationActions:true,augmentationCashReserve:.1};
    const goal = () => JSON.parse(files.get('data/savings.json'));
    const scheduler = (patch={}) => {const port=ns.getPortHandle(17);port.clear();port.write({type:'jit-status',pid:7,generatedAt:clock.now,
        totalRam:1000,usedRam:900,income60:1000,maxBatchRate:4,maxWorkers:6000,
        pipelines:[{mode:'LIVE',modelBatchRate:1,running:30,queued:20}],...patch});};
    const objective = patch => { const p=ns.getPortHandle(11);p.clear();p.write({type:'augmentation-status',version:1,
        producerPid:10,resetEpoch:'4:1:2',generatedAt:clock.now,progression:{type:'progression-objective',version:1,
            producer:'augmentation-manager.js',producerPid:10,resetEpoch:'4:1:2',generatedAt:clock.now,...patch}}); };
    return {clock,ns,world,cfg,state,savings,fleet,supervisor,reader,status,policy,goal,scheduler,objective,reset,actions,copies};
}

test('first small server competes with ordinary savings, buys the exact goal, then yields priority', async()=>{
    const f=fixture(), plan={errors:[],next:{name:'BitWire',price:10000}};
    await f.savings.writeSavings(f.ns,10000,'Augmentation','augmentation:BitWire','supervisor');
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.actions.length,0);assert.equal(f.state.capitalRequest.target,'fleet:new:8');
    assert.equal(f.state.capitalRequest.amount,3200,'25% action cap included in funding goal');
    await f.supervisor.updateSupervisorSavings(f.ns,f.policy,plan,null,null,f.status());
    assert.equal(f.goal().target,'fleet:new:8');
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy','cloud-00',8]]);assert.equal(f.state.spent,800);
    assert.equal(f.copies[0][1],'cloud-00');assert.equal(f.state.capitalRequest,null);
    await f.supervisor.updateSupervisorSavings(f.ns,f.policy,plan,null,null,f.status());
    assert.equal(f.goal().target,'augmentation:BitWire');
    f.scheduler();await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.state.capitalRequest,null,'ordinary progression gets a three-minute turn');
});

test('manual savings and critical milestones stay ahead of fleet capital requests', async()=>{
    for(const target of ['manual','home:ram','faction:Daedalus','augmentation:The Red Pill']) {
        const f=fixture();await f.savings.writeSavings(f.ns,1e9,'Reserve',target,target==='manual'?'manual':'supervisor');
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        const cfg={...f.policy,homeInvestment:target==='home:ram'?{amount:1e9,target,priority:90,label:'Home',reason:'Blocked core'}:null};
        const controller=target.startsWith('faction:')||target.includes('Red Pill')?
            {type:'augmentation-status',resetEpoch:'4:1:2',generatedAt:f.clock.now,producerPid:10,savings:{amount:1e9,target,label:target}}:null;
        await f.supervisor.updateSupervisorSavings(f.ns,cfg,null,null,controller,f.status());
        assert.equal(f.goal().target,target);assert.equal(f.actions.length,0);
    }
});

for (const name of ['Ordinary donation aug','The Red Pill'])
test(`protected ${name} donation funding blocks surplus cloud spending`,async()=>{
    const f=fixture(),plan={errors:[],next:{name,price:900,repGap:10,donationPlanned:true,donationCost:4500,fundingCost:5400}};
    const objective={limitingResource:'purchase',reputationStrategy:'DONATE',selectedPlan:plan,
        savings:{amount:5400,target:'augmentation:'+name,label:name}};
    f.objective(objective);
    await f.supervisor.updateSupervisorSavings(f.ns,f.policy,plan);
    assert.equal(f.goal().amount,6000);
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.actions.length,0);assert.ok(f.state.capitalRequest);
    if(name==='The Red Pill') {
        await f.supervisor.updateSupervisorSavings(f.ns,f.policy,plan,null,null,f.status());
        assert.equal(f.goal().target,'augmentation:The Red Pill');assert.equal(f.goal().priority,100);
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);assert.equal(f.actions.length,0);
    }
});

test('productive cloud requests can displace ordinary home expansion despite incumbent hysteresis', async()=>{
    const f=fixture();await f.savings.writeSavings(f.ns,1e9,'Optional services','home:ram','supervisor');
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    await f.supervisor.updateSupervisorSavings(f.ns,{...f.policy,homeInvestment:{amount:1e9,target:'home:ram',priority:75,label:'Optional services'}},null,null,null,f.status());
    assert.equal(f.goal().target,'fleet:new:8');
});

test('expansion requests need fresh productive RAM pressure and short payback', async()=>{
    const f=fixture();f.world.names=['cloud-00'];f.world.limit=1;
    await f.savings.writeSavings(f.ns,1e9,'Ordinary','augmentation:BitWire','supervisor');
    for(const patch of [{usedRam:100},{pipelines:[{mode:'RECOVERING'}]},{income60:1},{generatedAt:f.clock.now-16000},{maxBatchRate:1}]) {
        f.scheduler(patch);await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.equal(f.state.capitalRequest,null,JSON.stringify(patch));
    }
    f.scheduler();await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.state.capitalRequest.target,'fleet:cloud-00:64');assert.match(f.state.capitalRequest.reason,/180s payback/);
});

test('fleet request authentication rejects stale epochs, timestamps and producer identity', async()=>{
    const f=fixture();await f.savings.writeSavings(f.ns,1e9,'Goal');await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.ok(f.reader.readFleetCapitalRequest(f.ns,f.status()));
    for(const patch of [{resetEpoch:'4:1:3'},{generatedAt:f.clock.now-16000},{generatedAt:f.clock.now+1},{producerPid:22},{target:'fleet:new:64'}]) {
        const status=f.status();status.cloud.capitalRequest={...status.cloud.capitalRequest,...patch};
        assert.equal(f.reader.readFleetCapitalRequest(f.ns,status),null);
    }
});

test('first purchase and ROI-disabled purchases still respect impending resets', async()=>{
    for(const roi of [true,false]) {
        const f=fixture();f.cfg.cloud.roi=roi;f.objective({redPill:'queued'});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.equal(f.actions.length,0);assert.equal(f.state.capitalRequest,null);assert.match(f.state.investment,/imminent/);
    }
});

test('live fleet cost and manual reserves are rechecked before releasing capital', async()=>{
    const f=fixture(), candidate={ram:8,added:8,cost:800};f.world.cash=3200;
    await f.savings.writeSavings(f.ns,3200,'Fleet','fleet:new:8','supervisor');
    f.world.unitCost=110;
    await f.fleet.executeInvestment(f.ns,f.cfg,f.state,candidate);assert.equal(f.actions.length,0,'higher live price exceeds 25% cap');
    f.world.unitCost=100;await f.savings.writeSavings(f.ns,3200,'Manual','fleet:new:8','manual');
    await f.fleet.executeInvestment(f.ns,f.cfg,f.state,candidate);assert.equal(f.actions.length,0,'manual goal cannot be released by fleet');
});

test('supervisor defaults to 8 GB cloud servers and retains explicit sizing',()=>{
    const api=loadScript('supervisor.js',new Clock());
    for(const size of [undefined,32]) {
        const service=api.createManagedServices({ps:()=>[]},{cloudMinRam:size},[]).find(s=>s.name==='fleet-manager.js');
        assert.equal(service.args[service.args.indexOf('--cloud-min-ram')+1],size??8);
    }
});

for(const limitingFactor of ['TARGET_SLOTS','BATCH_RATE','LAUNCH_RATE','WORKER_LIMIT','RECOVERY','NO_PROFITABLE_TARGET']) {
    test(`cloud retains even surplus capital when ${limitingFactor} cannot be solved with RAM`,async()=>{
        const f=fixture();f.world.names=['cloud-00'];f.world.cash=1e9;
        f.scheduler({capacity:{limitingFactor,constraints:[limitingFactor]}});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.equal(f.actions.length,0);assert.equal(f.state.capitalRequest,null);
        assert.match(f.state.investment,new RegExp(limitingFactor));
    });
}
test('RAM telemetry allows a justified cloud investment',async()=>{
    const f=fixture();f.world.names=['cloud-00'];f.world.limit=1;f.world.cash=20000;
    f.scheduler({capacity:{limitingFactor:'RAM',constraints:['RAM']}});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);assert.equal(f.actions.length,1);
});
test('XP RAM pressure funds useful capacity under a cash recovery bound, without exact XP formulas',async()=>{
    const f=fixture();f.world.names=['cloud-00'];f.world.limit=1;f.world.cash=20000;
    f.objective({limitingResource:'hacking',moneyCovered:true});
    const xp={target:'xp-target',desiredRam:128,allocatedRam:32,constrained:true};
    f.scheduler({capacity:{limitingFactor:'XP_RAM',constraints:['XP_RAM'],xp}});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);assert.equal(f.actions.length,1);
    assert.match(f.state.investment,/XP pipeline is RAM constrained/);
    xp.allocatedRam=128;xp.constrained=false;f.clock.now+=180001;
    f.objective({limitingResource:'hacking',moneyCovered:true});
    f.scheduler({capacity:{limitingFactor:'NONE',constraints:[],xp}});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);assert.equal(f.actions.length,1);
    assert.match(f.state.investment,/no usable XP RAM pressure/);
});

for(const moneyLimit of ['BATCH_RATE','TARGET_SLOTS','NO_PROFITABLE_TARGET','PREPARATION']) {
    test(`XP cloud investment bypasses money-only ${moneyLimit} and chooses useful capacity instead of tiny repeated buys`,async()=>{
        const f=fixture();f.world.names=['cloud-00'];f.world.cash=1e6;
        f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true});
        f.scheduler({pipelines:[{mode:'LIVE',modelBatchRate:4,running:30,queued:20}],
            capacity:{limitingFactor:moneyLimit,constraints:[moneyLimit,'XP_RAM'],
                preparation:{constrained:false},xp:{target:'xp',desiredRam:128,allocatedRam:32,constrained:true}}});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.deepEqual(f.actions,[['buy','cloud-01',64]]);
        assert.match(f.state.investment,/XP pipeline is RAM constrained/);
    });
}

for(const sharedLimit of ['LAUNCH_RATE','WORKER_LIMIT','RECOVERY']) {
    test(`XP cloud investment retains shared ${sharedLimit} protection`,async()=>{
        const f=fixture();f.world.names=['cloud-00'];f.world.cash=1e6;
        f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true});
        f.scheduler({capacity:{limitingFactor:sharedLimit,constraints:[sharedLimit,'XP_RAM'],
            xp:{target:'xp',desiredRam:128,allocatedRam:32,constrained:true}}});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.equal(f.actions.length,0);assert.equal(f.state.capitalRequest,null);
        assert.match(f.state.investment,new RegExp(sharedLimit));
    });
}

for(const existingCloud of [false,true]) {
    test(`productive scheduler XP expansion reaches the cloud purchase actor with existing cloud=${existingCloud}`,async()=>{
        const f=fixture();f.world.names=existingCloud?['cloud-00']:[];f.world.cash=1e6;
        const objective={milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true};
        f.objective(objective);
        const jobs=new Map([[1,{host:'public-worker',ram:900}]]);
        const pool={cfg:{maxTargets:6,maxBatchRate:4,maxLaunches:32,maxWorkers:6000,
                hackingPolicy:{mode:'XP'},progressionObjective:objective},
            pipelines:new Map([['money',{name:'money',mode:'RUNNING',queue:[],
                stats:{pipeline:{}},runtime:{plan:{batchRate:4}}}]]),
            network:{hosts:[{name:'public-worker',maxRam:1000}]},foreign:new Map(),running:jobs,
            launchBuckets:new Map(),xp:{desiredRam:700,ramConstrained:false,status:'RUNNING',
                samples:[1000,1000,1000],choice:{name:'joesguns',action:'G',score:1000},
                wave:{action:'G',preparing:false},jobs}};
        const capacity=loadScript('lib/scheduler-capacity.js',f.clock).schedulerCapacity(pool);
        assert.equal(capacity.limitingFactor,'BATCH_RATE');assert.equal(capacity.xp.expansion,true);
        assert.equal(capacity.xp.desiredRam-capacity.xp.allocatedRam,225);
        f.scheduler({capacity});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.deepEqual(f.actions,[['buy',existingCloud?'cloud-01':'cloud-00',64]]);
    });
}

test('a first cloud server for XP respects useful demand instead of taking the bootstrap sizing shortcut',async()=>{
    const f=fixture();f.world.cash=1e6;
    f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true});
    f.scheduler({capacity:{limitingFactor:'BATCH_RATE',constraints:['BATCH_RATE','XP_RAM'],
        xp:{target:'xp',desiredRam:40,allocatedRam:32,constrained:true}}});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy','cloud-00',16]]);
});

test('endgame cloud stays idle when public RAM is spare and XP is waiting for money work',async()=>{
    const f=fixture();f.world.cash=1e9;
    f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true});
    f.scheduler({totalRam:65536,usedRam:3000,capacity:{limitingFactor:'NONE',constraints:[],
        xp:{target:'joesguns',desiredRam:45000,allocatedRam:0,constrained:false}}});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.actions.length,0);assert.equal(f.state.capitalRequest,null);
    assert.match(f.state.investment,/no usable XP RAM pressure/);
});

test('the reported home-heavy XP stall produces a real cloud purchase while the retained support plan is tuning', async()=>{
    const f=fixture(), producer=require('./home-xp-fixture.cjs').fixture();
    let capacity;for(let i=0;i<7;i++)capacity=producer.sample();
    f.world.cash=476e12;f.ns.cloud.getRamLimit=()=>1048576;
    f.objective(producer.goal);
    f.scheduler({capacity,income60:28.04e9,totalRam:2775,usedRam:2400,maxBatchRate:3,
        pipelines:[{mode:'LIVE',modelBatchRate:2.36,running:278,queued:148},
            {mode:'TUNING',modelBatchRate:2.37,running:0,queued:0}]});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy','cloud-00',16384]]);
    assert.match(f.state.investment,/XP pipeline is RAM constrained/);
    assert.equal(f.state.capitalRequest,null);
});

test('the reported earning trial and money launch constraint do not veto independently launchable home XP expansion', async()=>{
    const f=fixture(),producer=require('./home-xp-fixture.cjs').fixture({trial:true});
    let capacity;for(let i=0;i<7;i++)capacity=producer.sample({moneyAge:11000,blockedDemand:true});
    assert.equal(producer.idle.trial,true);assert.equal(capacity.xp.launchable,true);
    assert.ok(capacity.constraints.includes('LAUNCH_RATE'));
    f.world.cash=476e12;f.ns.cloud.getRamLimit=()=>1048576;f.objective(producer.goal);
    f.scheduler({capacity,income60:26.14e9,totalRam:3317.76,usedRam:2263.04,maxBatchRate:producer.cfg.maxBatchRate,
        pipelines:[{mode:'LIVE',running:101,queued:0},{mode:'LIVE',role:'TRIAL',running:2,queued:0}]});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy','cloud-00',16384]]);
    assert.match(f.state.investment,/XP pipeline is RAM constrained/);
});

test('ordinary adaptive money RAM growth can fund memory while an empty retained lane is tuning', async()=>{
    const f=fixture(), producer=require('./home-xp-fixture.cjs').fixture();
    producer.cfg.hackingPolicy={mode:'MONEY'};producer.cfg.progressionObjective=null;
    producer.pool.xp.status='DISABLED';producer.pool.targetAnalysis=[{name:'clarkinc',steady:50e9}];
    let capacity;for(let i=0;i<14;i++)capacity=producer.sample();
    assert.ok(capacity.scaling.ramRequest);
    f.world.cash=1e12;f.ns.cloud.getRamLimit=()=>1048576;
    f.scheduler({capacity,income60:28.04e9,totalRam:2775,usedRam:2400,maxBatchRate:producer.cfg.maxBatchRate,
        pipelines:[{mode:'LIVE',modelBatchRate:2.36,running:278,queued:148},
            {mode:'TUNING',modelBatchRate:2.37,running:0,queued:0}]});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy','cloud-00',1024]]);
});

for(const guard of ['reset-pending','manual-reserve','overpriced','invalid-income']) {
    test(`XP growth rechecks capital protection: ${guard}`,async()=>{
        const f=fixture();f.world.names=['cloud-00'];f.world.cash=1e6;
        f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true,resetPending:guard==='reset-pending'});
        if(guard==='manual-reserve')await f.savings.writeSavings(f.ns,f.world.cash,'Manual','manual','manual');
        if(guard==='overpriced')f.world.unitCost=1e9;
        f.scheduler({income60:guard==='invalid-income'?Infinity:1000,
            capacity:{limitingFactor:'BATCH_RATE',constraints:['BATCH_RATE','XP_RAM'],
                xp:{target:'xp',desiredRam:128,allocatedRam:32,constrained:true}}});
        await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
        assert.equal(f.actions.length,0);
        if(guard==='reset-pending')assert.match(f.state.investment,/reset advantage is being observed/);
    });
}

test('an approved reset arriving at the live cloud quote defers an otherwise useful XP purchase',async()=>{
    const f=fixture();f.world.names=['cloud-00'];f.world.cash=20000;
    f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true});
    f.scheduler({capacity:{limitingFactor:'XP_RAM',constraints:['XP_RAM'],
        xp:{target:'xp',desiredRam:128,allocatedRam:32,constrained:true}}});
    const quote=f.ns.cloud.getServerUpgradeCost;
    f.ns.cloud.getServerUpgradeCost=(...args)=>{
        f.objective({milestone:'FINAL_SERVER',limitingResource:'hacking',moneyCovered:true,resetPending:true});
        return quote(...args);
    };
    await f.fleet.executeInvestment(f.ns,f.cfg,f.state,{name:'cloud-00',ram:64,added:32,cost:3200});
    assert.equal(f.actions.length,0);assert.match(f.state.investment,/reset advantage is being observed/);
});
test('prepared capacity alone does not justify cloud RAM unless preparation is constrained',()=>{
    const api=loadScript('lib/fleet-economics.js',new Clock());
    assert.equal(api.fleetCapacityPolicy({capacity:{limitingFactor:'PREPARATION',preparation:{constrained:false}}}).ok,false);
    assert.equal(api.fleetCapacityPolicy({capacity:{limitingFactor:'PREPARATION',preparation:{constrained:true}}}).ok,true);
    assert.equal(api.fleetCapacityPolicy({capacity:{limitingFactor:'RAM',constraints:['RAM','TARGET_SLOTS']}}).ok,true,
        'a target ceiling does not prevent RAM from helping existing RAM-starved lanes');
    assert.equal(api.fleetCapacityPolicy({capacity:{limitingFactor:'RAM',constraints:['RAM','NO_PROFITABLE_TARGET']}}).ok,true,
        'an existing lane can need RAM even without another profitable candidate');
});
test('purchase rechecks scheduler and installation after the live cost quote',async()=>{
    for(const reset of [false,true]) {
        const f=fixture();f.world.names=['cloud-00'];f.world.cash=20000;f.scheduler({capacity:{limitingFactor:'RAM'}});
        const quote=f.ns.cloud.getServerUpgradeCost;
        f.ns.cloud.getServerUpgradeCost=(...args)=>{
            if(reset) f.objective({resetImminent:true});
            else f.scheduler({capacity:{limitingFactor:'TARGET_SLOTS'}});
            return quote(...args);
        };
        await f.fleet.executeInvestment(f.ns,f.cfg,f.state,{name:'cloud-00',ram:64,added:32,cost:3200});
        assert.equal(f.actions.length,0);assert.match(f.state.investment,reset?/imminent/:/TARGET_SLOTS/);
    }
});

function adaptiveCapacity(f) {
    const scaler=loadScript('lib/scheduler-scaling.js',f.clock),reader=loadScript('lib/scheduler-capacity.js',f.clock);
    const cfg={maxTargets:6,gap:100,maxWorkers:6000,maxSteal:.5,switchThreshold:1.25};
    const state=scaler.createSchedulerScaling(cfg);
    const pool={cfg,pipelines:new Map([['money',{name:'money',mode:'RUNNING',queue:[],stats:{pipeline:{}},
            runtime:{plan:{batchRate:1,period:1000,expected:1000}}}]]),
        network:{hosts:[{name:'public-worker',maxRam:1000}]},foreign:new Map(),
        running:new Map([[1,{host:'public-worker',ram:900}]]),launchBuckets:new Map()};
    for(let i=0;i<7;i++) {
        f.clock.now+=10000;
        for(const kind of ['loop','launch','landing'])for(let j=0;j<20;j++)scaler.recordSchedulerTiming(state,kind,1,100);
        scaler.tickSchedulerScaling(state,{gap:100,income:1000,stable:true,goal:'MONEY',maxActionTime:10000,
            faults:[['money:1',0]],capacity:reader.schedulerCapacity(pool)},f.clock.now);
    }
    return reader.schedulerCapacity(pool);
}

for(const existingCloud of [false,true])test(`measured adaptive RAM request reaches the purchase actor, existing cloud=${existingCloud}`,async()=>{
    const f=fixture();f.world.names=existingCloud?['cloud-00']:[];f.world.cash=1e6;
    const capacity=adaptiveCapacity(f);
    assert.equal(capacity.scaling.ramRequest.addedRam,250);
    f.scheduler({capacity});await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.deepEqual(f.actions,[['buy',existingCloud?'cloud-01':'cloud-00',64]],'productive sizing replaces tiny bootstrap/ROI quotes');
});

for(const guard of ['manual-reserve','reset-pending','stale-snapshot','overpriced','shared-limit'])test(`adaptive RAM growth respects ${guard}`,async()=>{
    const f=fixture();f.world.names=['cloud-00'];f.world.cash=1e6;
    const capacity=adaptiveCapacity(f);
    if(guard==='manual-reserve')await f.savings.writeSavings(f.ns,f.world.cash,'Manual','manual','manual');
    if(guard==='reset-pending')f.objective({resetPending:true});
    if(guard==='overpriced')f.world.unitCost=1e9;
    if(guard==='shared-limit'){capacity.constraints=['LAUNCH_RATE'];capacity.limitingFactor='LAUNCH_RATE';}
    f.scheduler({capacity,generatedAt:f.clock.now-(guard==='stale-snapshot'?16000:0)});
    await f.fleet.manageOneCloudAction(f.ns,f.cfg,f.state);
    assert.equal(f.actions.length,0);
});

test('a disappearing adaptive RAM request at the live quote cannot take the first-server bootstrap shortcut',async()=>{
    const f=fixture();f.world.cash=1e6;const capacity=adaptiveCapacity(f);f.scheduler({capacity});
    const quote=f.ns.cloud.getServerCost;
    f.ns.cloud.getServerCost=ram=>{f.scheduler({capacity:{...capacity,scaling:{...capacity.scaling,ramRequest:null}}});return quote(ram);};
    await f.fleet.executeInvestment(f.ns,f.cfg,f.state,{ram:64,added:64,cost:6400,adaptiveRam:true});
    assert.equal(f.actions.length,0);assert.match(f.state.investment,/Adaptive RAM demand changed/);
});
