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
