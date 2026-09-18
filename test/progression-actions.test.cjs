const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), protocol = loadScript('lib/progression-protocol.js', clock);
    const dispatch = loadScript('lib/progression-dispatch.js', clock), manager = loadScript('progression-manager.js', clock);
    const ports = new Map([14,16,19].map(n=>[n,new Port()])), processes = new Map([[1,{pid:1,filename:'supervisor.js',args:[],threads:1}]]);
    const reset = {currentNode:4,lastNodeReset:100,lastAugReset:200,ownedSF:new Map()};
    const world = {cash:1e9, tor:true, busy:false, skill:200, current:'home', installed:new Set(), owned:new Set(), roots:true, ram:1e6};
    const parents = {home:null,a:'home',b:'a',CSEC:'b',manual:'a'};
    const launched = [], connections = [], purchases = [];
    const ns = {pid:1, args:[], getHostname:()=> 'home', disableLog(){}, print(){},
        getResetInfo:()=>reset, ps:()=>[...processes.values()], getPortHandle:n=>ports.get(n),
        isRunning:pid=>processes.has(pid), getScriptRam:()=>8, getServerMaxRam:()=>world.ram, getServerUsedRam:()=>0,
        getServerMoneyAvailable:()=>world.cash, getHackingLevel:()=>world.skill, hasTorRouter:()=>world.tor,
        fileExists:name=>world.owned.has(name), serverExists:host=>Object.hasOwn(parents,host), hasRootAccess:()=>world.roots,
        getServer:host=>({requiredHackingSkill:100,backdoorInstalled:world.installed.has(host)}),
        run:(filename,threads,...args)=>{const pid=100+launched.length; launched.push({filename,threads,args,pid}); processes.set(pid,{pid,filename,args,threads}); return pid;},
        kill:()=>assert.fail('actions must not kill income workers'),
        singularity:{isBusy:()=>world.busy, getCurrentServer:()=>world.current,
            getDarkwebProgramCost:name=>protocol.progressionPrograms().find(p=>p.name===name)?.cost,
            purchaseTor:()=>{purchases.push('TOR');world.tor=true;world.cash-=200000;return true;},
            purchaseProgram:name=>{purchases.push(name);world.owned.add(name);return true;},
            connect:host=>{connections.push(host); if (parents[host]!==world.current && parents[world.current]!==host) return false; world.current=host;return true;},
            installBackdoor:async()=>{world.installed.add(world.current);},
        },
    };
    const cfg={progression:true,progressionActions:true,progressionCashReserve:.1};
    const plan={type:'progression-status',generatedAt:clock.now,plannedAt:clock.now,planRevision:'7:1000000',resetEpoch:protocol.resetEpoch(reset),
        objectives:[{kind:'program',target:'SQLInject.exe',ready:true,costEstimate:250e6}, {kind:'backdoor',target:'CSEC',ready:true,costEstimate:0}]};
    ports.get(19).write({type:'fleet-status',generatedAt:clock.now,network:{parents}});
    function prepare(kind='backdoor',target='CSEC',overrides={}) {
        const request={...protocol.createRequest(ns,plan,{kind,target},.1,1),...overrides};
        const filename=kind==='backdoor'?'progression-backdoor.js':'progression-purchase.js';
        processes.set(100,{pid:100,filename,args:[JSON.stringify(request)],threads:1});
        ports.get(14).clear();ports.get(14).write({type:'progression-action',request,state:'pending',actorPid:100});
        return {request,actor:{...ns,pid:100,args:[JSON.stringify(request)]},api:loadScript(filename,clock)};
    }
    return {clock,protocol,dispatch,manager,ports,processes,reset,world,parents,launched,connections,purchases,ns,cfg,plan,prepare};
}

test('planner exposes ready backdoor independently of an unaffordable program', () => {
    const f=fixture();
    const objectives=f.manager.planObjectives({torOwned:true, money:1e6, programs:[{name:'SQLInject.exe',cost:250e6,owned:false}],
        backdoors:[{host:'CSEC',faction:'CyberSec',discovered:true,rooted:true,skillReady:true,path:['home','CSEC']}]});
    assert.equal(objectives[0].affordable,false);assert.equal(objectives[1].ready,true);
    f.plan.objectives=objectives;f.world.cash=1e6;
    f.dispatch.tickProgressionActions(f.ns,f.dispatch.createActionState(),f.plan,f.cfg);
    assert.equal(f.launched[0].filename,'progression-backdoor.js');
});

for (const condition of ['stale','future','wrong-reset','locked','disabled','stale-plan-fresh-heartbeat']) {
    test(`dispatcher does not act on ${condition} state`, () => {
        const f=fixture();
        if(condition==='stale')f.plan.generatedAt-=3600000;
        if(condition==='future')f.plan.generatedAt++;
        if(condition==='wrong-reset')f.plan.resetEpoch='earlier';
        if(condition==='locked')f.reset.currentNode=1;
        if(condition==='disabled')f.cfg.progressionActions=false;
        if(condition==='stale-plan-fresh-heartbeat')f.plan.plannedAt-=60000;
        f.dispatch.tickProgressionActions(f.ns,f.dispatch.createActionState(),f.plan,f.cfg);
        assert.equal(f.launched.length,0);
    });
}

test('RAM shortage is visible, rate-limited, and never causes worker cancellation', () => {
    const f=fixture(),state=f.dispatch.createActionState();f.world.ram=1;
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    assert.match(state.current.reason,/WAITING_RAM/);assert.equal(f.launched.length,0);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);assert.equal(f.launched.length,0);
});

test('live actor blocks another dispatch even when it outlives heartbeat deadlines', () => {
    const f=fixture(),state=f.dispatch.createActionState();f.plan.objectives=f.plan.objectives.slice(1);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    f.clock.now+=300000;f.plan.generatedAt=f.plan.plannedAt=f.clock.now;
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    assert.equal(f.launched.length,1);assert.equal(state.current.state,'pending');
});

test('missing completion becomes a visible failure; no immediate same-objective retry', () => {
    const f=fixture(),state=f.dispatch.createActionState();f.plan.objectives=f.plan.objectives.slice(0,1);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);f.processes.delete(state.active.pid);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    assert.equal(state.lastResult.reason,'actor-exited-without-result');
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);assert.equal(f.launched.length,1);
});

for (const [kind,target,overrides] of [
    ['backdoor','w0r1dd43m0n',{}], ['program','Formulas.exe',{}], ['tor','not-TOR',{}],
    ['backdoor','CSEC',{resetEpoch:'old'}], ['program','SQLInject.exe',{reserve:NaN}],
    ['backdoor','CSEC',{createdAt:1,expiresAt:100}],
]) {
    test(`actor rejects invalid request ${kind}/${target}/${JSON.stringify(overrides)}`, async () => {
        const f=fixture(),job=f.prepare(kind,target,overrides);await job.api.main(job.actor);
        assert.equal(f.purchases.length,0);assert.equal(f.connections.length,0);
        assert.equal(f.ports.get(14).peek().state,'blocked');
    });
}

test('actor checks real Singularity access, not a claimed snapshot flag', async () => {
    const f=fixture();f.reset.currentNode=1;f.plan.resetEpoch=f.protocol.resetEpoch(f.reset);
    const job=f.prepare('program','SQLInject.exe');await job.api.main(job.actor);
    assert.equal(f.purchases.length,0);assert.equal(f.ports.get(14).peek().reason,'singularity-locked');
});

test('actor refuses a request whose owner has exited', async () => {
    const f=fixture(),job=f.prepare();f.processes.delete(1);await job.api.main(job.actor);
    assert.equal(f.connections.length,0);assert.equal(f.ports.get(14).peek().reason,'owner-exited');
});

test('purchase quotes live price and reports required cash without spending the reserve', async () => {
    const f=fixture(),job=f.prepare('program','SQLInject.exe');f.world.cash=260e6;
    await job.api.main(job.actor);const result=f.ports.get(14).peek();
    assert.equal(result.state,'blocked');assert.equal(result.reason,'insufficient-cash');
    assert.equal(result.requiredCash,250e6/.9);assert.equal(f.purchases.length,0);
});

test('successful and already-owned purchases are confirmed and idempotent', async () => {
    const f=fixture();const first=f.prepare('program','SQLInject.exe');await first.api.main(first.actor);
    assert.equal(f.ports.get(14).peek().state,'succeeded');
    const second=f.prepare('program','SQLInject.exe');await second.api.main(second.actor);
    assert.equal(f.purchases.length,1);assert.equal(f.ports.get(14).peek().reason,'already-owned');
});

for (const [condition,reason] of [['busy','player-busy'],['roots','root-required'],['skill','hacking-level-required'],['installed','already-installed'],['network','stale-network']]) {
    test(`backdoor rechecks ${condition} before touching the connection`, async () => {
        const f=fixture(),job=f.prepare();
        if(condition==='busy')f.world.busy=true;
        if(condition==='roots')f.world.roots=false;
        if(condition==='skill')f.world.skill=1;
        if(condition==='installed')f.world.installed.add('CSEC');
        if(condition==='network')f.ports.get(19).peek().generatedAt-=60000;
        await job.api.main(job.actor);
        assert.equal(f.connections.length,0);assert.equal(f.ports.get(14).peek().reason,reason);
    });
}

test('backdoor restores from the last successful intermediate hop after routing fails', async () => {
    const f=fixture(),job=f.prepare(),connect=f.ns.singularity.connect;
    f.ns.singularity.connect=host=>host==='b'?false:connect(host);
    await job.api.main(job.actor);
    assert.equal(f.world.current,'home');assert.deepEqual(f.connections,['a','home']);
    assert.equal(f.ports.get(14).peek().state,'failed');assert.equal(f.ports.get(14).peek().restoration,'restored');
});

test('installed backdoor is confirmed and previous terminal location is restored', async () => {
    const f=fixture(),job=f.prepare();f.world.current='a';await job.api.main(job.actor);
    assert.equal(f.world.current,'a');assert.equal(f.world.installed.has('CSEC'),true);
    assert.equal(f.ports.get(14).peek().state,'succeeded');
});

test('manual movement during a long installation is not overwritten by restoration', async () => {
    const f=fixture(),job=f.prepare();
    f.ns.singularity.installBackdoor=async()=>{await f.clock.sleep(60000);f.world.installed.add('CSEC');};
    const task=job.api.main(job.actor);
    f.clock.timer(30000,()=>f.world.current='manual');
    await f.clock.runUntil(f.clock.now+65000);await task;
    assert.equal(f.world.current,'manual');assert.equal(f.ports.get(14).peek().state,'succeeded');
    assert.equal(f.ports.get(14).peek().restoration,'manual-control-preserved');
});

test('late actor result cannot overwrite a newer request', async () => {
    const f=fixture(),job=f.prepare();
    f.ns.singularity.installBackdoor=async()=>{await f.clock.sleep(20000);f.world.installed.add('CSEC');};
    const task=job.api.main(job.actor);
    f.clock.timer(10000,()=>{f.ports.get(14).clear();f.ports.get(14).write({type:'progression-action',request:{requestId:'newer'},state:'pending',actorPid:500});});
    await f.clock.runUntil(f.clock.now+25000);await task;
    assert.equal(f.ports.get(14).peek().request.requestId,'newer');assert.equal(f.ports.get(14).peek().state,'pending');
});

test('malformed or cyclic network routes fail closed', () => {
    const f=fixture();assert.equal(f.protocol.pathFromHome({a:'b',b:'a'},'a').length,0);
    assert.equal(f.protocol.routeBetween({},'home','CSEC').length,0);
});

test('supervisor retains a result after the actor exits and across dashboard redraws', () => {
    const f=fixture(),state=f.dispatch.createActionState();f.plan.objectives=f.plan.objectives.slice(0,1);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    const active=state.active,actor={...f.ns,pid:active.pid};
    f.protocol.publishAction(actor,active.request,'succeeded','Purchased SQLInject.exe');f.processes.delete(active.pid);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    const supervisor=loadScript('supervisor.js',f.clock),logs=[];
    supervisor.renderProgression({...f.ns,print:line=>logs.push(line)},null,f.cfg,state);
    assert.match(logs.join('\n'),/Purchased SQLInject.exe/);
    const restarted=f.dispatch.createActionState();f.dispatch.tickProgressionActions(f.ns,restarted,null,{...f.cfg,progressionActions:false});
    assert.equal(restarted.lastResult.reason,'Purchased SQLInject.exe');
});

test('new supervisor adopts a still-running actor without cancelling or duplicating it', async () => {
    const f=fixture(),state=f.dispatch.createActionState();f.plan.objectives=f.plan.objectives.slice(1);
    f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    const active=state.active,process=f.processes.get(active.pid),actor={...f.ns,pid:active.pid,args:process.args};
    f.ns.singularity.installBackdoor=async()=>{await f.clock.sleep(60000);f.world.installed.add('CSEC');};
    const task=loadScript('progression-backdoor.js',f.clock).main(actor);
    f.processes.delete(1);f.processes.set(2,{pid:2,filename:'supervisor.js',args:[],threads:1});
    const replacement=f.dispatch.createActionState();
    f.dispatch.tickProgressionActions({...f.ns,pid:2},replacement,f.plan,f.cfg);
    assert.equal(replacement.active.pid,active.pid);assert.equal(f.launched.length,1);
    await f.clock.runUntil(f.clock.now+65000);await task;
    f.processes.delete(active.pid);f.dispatch.tickProgressionActions({...f.ns,pid:2},replacement,f.plan,f.cfg);
    assert.equal(replacement.lastResult.state,'succeeded');
});

test('new supervisor diagnoses an abandoned actor record instead of silently losing it', () => {
    const f=fixture(),job=f.prepare();f.processes.delete(100);
    const state=f.dispatch.createActionState();f.dispatch.tickProgressionActions(f.ns,state,f.plan,f.cfg);
    assert.equal(state.lastResult.request.requestId,job.request.requestId);
    assert.equal(state.lastResult.reason,'actor-exited-without-result');assert.equal(f.launched.length,0);
});

test('an actor cannot claim the same request twice', () => {
    const f=fixture(),job=f.prepare();
    assert.ok(f.protocol.claimAction(job.actor,['backdoor']));
    assert.equal(f.protocol.claimAction(job.actor,['backdoor']),null);
    assert.equal(f.protocol.claimAction({...job.actor,pid:101},['backdoor']),null);
});

test('backdoor install exception retains its real error and restores the connection', async () => {
    const f=fixture(),job=f.prepare();f.ns.singularity.installBackdoor=async()=>{throw new Error('test install failure');};
    await job.api.main(job.actor);
    assert.equal(f.world.current,'home');assert.equal(f.ports.get(14).peek().reason,'test install failure');
});

test('a failed restoration is visible rather than reported as successfully restored', async () => {
    const f=fixture(),job=f.prepare(),connect=f.ns.singularity.connect;
    f.ns.singularity.connect=host=>f.world.installed.has('CSEC')?false:connect(host);
    await job.api.main(job.actor);
    assert.equal(f.ports.get(14).peek().state,'succeeded');assert.match(f.ports.get(14).peek().restoration,/restore-failed/);
});

test('actor rechecks eligibility at the destination before installing', async () => {
    const f=fixture(),job=f.prepare(),connect=f.ns.singularity.connect;
    f.ns.singularity.connect=host=>{const result=connect(host);if(host==='CSEC')f.world.roots=false;return result;};
    await job.api.main(job.actor);
    assert.equal(f.world.installed.size,0);assert.equal(f.ports.get(14).peek().reason,'root-required');
});

test('source-file access works outside BN4 and rejects an inactive source file', () => {
    const f=fixture();f.reset.currentNode=1;f.reset.ownedSF.set(4,1);
    assert.equal(f.protocol.singularityAvailable(f.reset),true);f.reset.ownedSF.set(4,0);
    assert.equal(f.protocol.singularityAvailable(f.reset),false);
});

test('fresh heartbeat cannot make an old progression plan actionable', async () => {
    const f=fixture();const api=loadScript('progression-manager.js',f.clock);
    const status=f.ports.get(16);
    f.ports.get(19).peek().network.servers=['home'];
    api.main({...f.ns,pid:7,flags:pairs=>({...Object.fromEntries(pairs),interval:60000}),sleep:ms=>f.clock.sleep(ms)});
    await f.clock.runUntil(f.clock.now+30000);
    assert.ok(f.clock.now-status.peek().generatedAt<=5000);
    assert.equal(f.protocol.freshStatus(status.peek(),'progression-status'),false);
});
