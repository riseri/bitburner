const test = require('node:test'), assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');
const clock = new Clock(), catalog = loadScript('lib/service-catalog.js', clock);
function home({max=256, used=240, sharing=90, owned=false, threads=0}={}) {
    const processes = [{pid:1,filename:'unrelated.js',threads:1},
        ...(sharing ? [{pid:2,filename:'share-worker.js',threads:sharing/2}] : []),
        ...(threads ? [{pid:3,filename:'darknet-manager.js',threads:1},{pid:4,filename:'darknet-agent.js',threads}] : [])];
    return {getServerMaxRam:()=>max,getServerUsedRam:()=>used,ps:()=>processes,
        getScriptRam:f=>f==='share-worker.js'?2:f==='darknet-agent.js'?16:18,
        fileExists:()=>owned,getResetInfo:()=>({currentNode:4}),kill:()=>assert.fail('read-only planning')};
}
test('Navigator unlock is useful before activation fits; sharing is reclaimable',()=>{
    const programs=loadScript('lib/programs.js',clock);
    for (const input of [{max:8,used:7,sharing:0},{max:128,used:20,sharing:0},{max:256,used:240,sharing:90}]) {
        const activation=catalog.darknetActivation(home(input));
        const p=programs.rankPrograms(programs.progressionPrograms().filter(p=>p.category==='darknet'),{
            homeRam:input.max,darknetAvailableRam:activation.availableRam,darknetRam:activation.minimumRam})[0];
        assert.equal(p.useful,true);assert.equal(activation.activation,'LOCKED');
        assert.equal(p.activationReady,input.max!==8);
    }
    const a=catalog.darknetActivation(home());
    assert.equal(a.availableRam,106);assert.equal(a.minimumRam,42);assert.equal(a.requiredHomeRam,256);
});
test('purchase then expansion reaches minimum crawler without requiring configured maximum',()=>{
    const before=catalog.darknetActivation(home({max:32,used:20,sharing:0}));
    const purchased=catalog.darknetActivation(home({max:32,used:20,sharing:0,owned:true}));
    assert.equal(before.activation,'LOCKED');assert.equal(purchased.activation,'NEED_HOME_RAM');
    assert.equal(purchased.requiredHomeRam,62);
    assert.equal(catalog.darknetActivation(home({max:64,used:20,sharing:0,owned:true})).activation,'READY');
    assert.equal(catalog.darknetActivation(home({max:64,used:54,sharing:0,owned:true,threads:1})).activation,'ACTIVE');
    assert.equal(loadScript('darknet-manager.js',clock).homeAgentThreads(24,16,1024,8),1);
});
test('disabled Darknet queries no optional capability or RAM and makes no request',()=>{
    const a=catalog.darknetActivation({}, {enabled:false});
    assert.equal(a.requiredHomeRam,0);assert.equal(a.activation,'DISABLED');
    assert.ok(!loadScript('lib/programs.js',clock).progressionPrograms({darknet:false}).some(p=>p.category==='darknet'));
});
test('prospective home RAM is planned before Navigator and still needed after purchase',()=>{
    const supervisor=loadScript('supervisor.js',clock), cfg={darknet:true};
    for (const owned of [false,true]) {
        const ns=home({max:32,used:20,sharing:0,owned});
        assert.equal(supervisor.ongoingHomeTarget(ns,cfg,{singularity:false,darknet:owned},[],[]),62);
    }
    assert.equal(supervisor.ongoingHomeTarget(home({max:32,used:20,sharing:0}),{darknet:false},{},[],[]),32);
});

test('owned Navigator startup RAM outranks fleet capital and honors the configured home reserve', () => {
    const supervisor = loadScript('supervisor.js', clock), investments = loadScript('lib/investment-policy.js', clock);
    const cfg = { darknet: true, homeReserve: 24 };
    const ns = home({ max: 64, used: 20, sharing: 0, owned: true });
    assert.equal(supervisor.ongoingHomeTarget(ns, cfg, { singularity: false, darknet: true }, [], []), 78);
    assert.equal(cfg.homeUpgradePriority, 83);
    assert.equal(investments.chooseInvestment([{ target: 'home:ram', priority: cfg.homeUpgradePriority, amount: 100 },
        { target: 'fleet:new', priority: 79, amount: 1 }], 'fleet:new').chosen.target, 'home:ram');
    cfg.homeUpgradeCritical = true;
    supervisor.ongoingHomeTarget(ns, cfg, { singularity: false, darknet: true }, [], []);
    assert.equal(cfg.homeUpgradePriority, 90);
    cfg.homeUpgradeCritical = false;
    supervisor.ongoingHomeTarget(home({ max: 128, used: 20, sharing: 0 }), cfg, { singularity: false }, [], []);
    assert.equal(cfg.homeUpgradePriority, 75);
});
test('Navigator 84 beats ordinary cloud 79 including hysteresis; critical goals still win',()=>{
    const api=loadScript('lib/investment-policy.js',clock), programs=loadScript('lib/programs.js',clock);
    const nav=programs.rankPrograms(programs.progressionPrograms().filter(p=>p.category==='darknet'))[0];
    const requests=[{target:nav.name,priority:nav.priority,amount:nav.cost},{target:'fleet:new',priority:79,amount:1}];
    assert.equal(api.chooseInvestment(requests,'fleet:new').chosen.target,nav.name);
    for (const [target,priority] of [['home:ram',90],['faction:Daedalus',95],['augmentation:The Red Pill',100]])
        assert.equal(api.chooseInvestment([...requests,{target,priority,amount:1}],nav.name).chosen.target,target);
});
test('one sharing demand requires active relevant faction work and a reputation bottleneck',()=>{
    const api=loadScript('lib/progression-objective.js',clock), work={type:'FACTION',factionName:'Daedalus'};
    const objective={limitingResource:'reputation',milestone:'AUGMENTATIONS',selectedPlan:{next:{name:'Aug',faction:'Daedalus',repGap:10}}};
    assert.equal(api.sharingDemand(objective,work),'SPARE_ONLY');
    for (const limitingResource of ['cash','hacking','purchase','installation','invitation','completion','discovery','other'])
        assert.equal(api.sharingDemand({...objective,limitingResource},work),'OFF');
    assert.equal(api.sharingDemand(objective,null),'OFF');
    assert.equal(api.sharingDemand(objective,{...work,factionName:'CyberSec'}),'OFF');
    assert.equal(api.sharingDemand({...objective,milestone:'RED_PILL'},work),'SPARE_ONLY');
    objective.selectedPlan.next.name='The Red Pill';
    assert.equal(api.sharingDemand({...objective,milestone:'RED_PILL'},work),'AGGRESSIVE');
    assert.equal(api.sharingDemand({...objective,resetImminent:true},work),'OFF');
    assert.equal(api.readSharingDemand({}),'OFF');
});
test('home and fleet use the same authenticated demand; stale/no Singularity clears only sharing',()=>{
    const api=loadScript('lib/progression-objective.js',clock), daemon=loadScript('daemon.js',clock), supervisor=loadScript('supervisor.js',clock);
    const port=new Port(), killed=[], ns={...home(),getResetInfo:()=>({currentNode:4,lastNodeReset:1,lastAugReset:2}),
        getPortHandle:()=>port,ps:()=>[{pid:9,filename:'augmentation-manager.js'},{pid:20,filename:'share-worker.js',threads:1},{pid:21,filename:'other.js'}],
        kill:pid=>{killed.push(pid);return true;}};
    for (const demand of ['OFF','SPARE_ONLY','AGGRESSIVE']) {
        port.clear();port.write({type:'augmentation-status',version:1,producerPid:9,generatedAt:clock.now,resetEpoch:'4:1:2',
            progression:{type:'progression-objective',version:1,producer:'augmentation-manager.js',producerPid:9,generatedAt:clock.now,resetEpoch:'4:1:2',sharingDemand:demand}});
        assert.equal(api.readSharingDemand(ns),demand);
    }
    port.clear();
    supervisor.reconcileHomeShare(ns,api.readSharingDemand(ns)!=='OFF',8);
    daemon.reconcileFleetShare(ns,[{name:'remote',maxRam:64}],{fleetShare:true},new Map(),[],new Map());
    assert.ok(killed.length>0);assert.ok(killed.every(pid=>pid===20));
});
