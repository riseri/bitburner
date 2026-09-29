const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture(cores = 4) {
    const clock = new Clock(), d = loadScript('daemon.js', clock), h = loadScript('lib/home-capacity.js', clock);
    const processes = new Map([[1,{pid:1,filename:'supervisor.js',host:'home',ram:48,threads:1}],
        [2,{pid:2,filename:'manual.js',host:'home',ram:16,threads:1}],
        [3,{pid:3,filename:'share-worker.js',host:'home',ram:40,threads:20}]]);
    const killed = [], launched = [], ports = new Map(); let pid = 10;
    const hosts = [{name:'remote',maxRam:64,cores:1}];
    const ns = { pid:9, getServer: () => ({maxRam:128,cpuCores:cores}), getServerMaxRam: name => name==='home'?128:64,
        getServerUsedRam: name => [...processes.values()].filter(p=>p.host===name).reduce((n,p)=>n+p.ram,0),
        ps: name => [...processes.values()].filter(p=>p.host===name), isRunning:id=>processes.has(id),
        getScriptRam:()=>2, getPortHandle:id=>{if(!ports.has(id))ports.set(id,new Port());return ports.get(id);},
        weakenAnalyze:(n,c=1)=>n*.05*(1+(c-1)/16), growthAnalyzeSecurity:n=>n*.004,
        growthAnalyze:(_name,m,c=1)=>Math.log(m)/.01/(1+(c-1)/16),
        getHackTime:()=>250,getWeakenTime:()=>1000,getGrowTime:()=>800,fileExists:()=>false,
        kill:id=>{killed.push(id);return processes.delete(id);},
        exec:(filename,host,threads,...args)=>{
            if(threads*2>ns.getServerMaxRam(host)-ns.getServerUsedRam(host))return 0;
            const p={pid:pid++,filename,host,threads,ram:threads*2,args};processes.set(p.pid,p);launched.push(p);return p.pid;
        }};
    const cfg={homeReserve:24,homeGw:{},ram:{H:2,G:2,W:2},lead:100,gap:50,port:20,controlPort:15};
    h.observeHomeCapacity(ns,cfg);
    return {clock,d,h,ns,cfg,hosts,processes,killed,launched};
}
function alloc(f, action, need, reservations=[], running=new Map()) {
    return action==='G'?f.d.allocateGrow(f.ns,f.hosts,f.cfg,running,reservations,need,f.clock.now+2000,1000,'G','batch'):
        action==='W'?f.d.allocateWeaken(f.ns,f.hosts,f.cfg,running,reservations,need,f.clock.now+2000,1000,'W2','batch',false):
        f.d.allocateHack(f.ns,f.hosts,f.cfg,running,reservations,need,f.clock.now+2000,1000,'H','batch');
}
test('home is a separate G/W capability; 40 safe GB includes disposable share and protects real services',()=>{
    const f=fixture();assert.equal(f.cfg.homeGw.safeRam,40);assert.equal(f.cfg.homeGw.unrelatedRam,64);
    assert.equal(f.cfg.homeGw.reclaimableShareRam,40);assert.equal(f.hosts.length,1);
    assert.equal(f.d.workerFleetCapacity(f.hosts,f.cfg),64);
    assert.equal(f.d.poolProfile(f.ns,f.hosts,f.cfg,new Map()).capacity,64);
});
test('Hack rejects home even if accidentally passed as enormous generic RAM',()=>{
    const f=fixture();f.hosts.unshift({name:'home',maxRam:1e12,cores:8});
    const result=alloc(f,'H',33);assert.equal(result.complete,false);assert.ok(result.chunks.every(c=>c.host!=='home'));
});
for (const action of ['G','W']) test(`${action} prefers actual high-core home and retains remote hosts`,()=>{
    const f=fixture(), result=alloc(f,action,action==='G'?30:2);
    assert.equal(result.complete,true);assert.equal(result.chunks[0].host,'home');
    assert.ok(result.chunks.some(c=>c.host==='remote'));
    const one=fixture(1), a=alloc(f,action,action==='G'?19:.95), b=alloc(one,action,action==='G'?19:.95);
    assert.ok(a.chunks.reduce((n,c)=>n+c.threads,0)<b.chunks.reduce((n,c)=>n+c.threads,0));
});
test('whole batch fails and rolls back when remote Hack RAM is insufficient',()=>{
    const f=fixture(), rs=[];f.cfg.homeGw.host.maxRam=1e12;
    const plan={H:33,gEffective:1,hackSecurity:.066,steal:.1,times:{H:1000,G:1000,W:1000}};
    assert.equal(f.d.reserveBatch(f.ns,'food','b',f.clock.now+2000,plan,f.hosts,f.cfg,rs,new Map()),null);
    assert.equal(rs.length,0);
});
test('home honors overlapping temporal holds and configured reserve',()=>{
    const f=fixture(), rs=[];alloc(f,'G',19,rs);
    assert.equal(f.d.availableRam(f.ns,f.cfg.homeGw.host,f.cfg,new Map(),rs,f.clock.now+1000,f.clock.now+2000),8);
    f.cfg.homeReserve=64;assert.equal(alloc(f,'G',10).chunks[0].host,'remote');
});
test('live launch reclaims share only, preserves reserve, and never kills unrelated processes',()=>{
    const f=fixture(), chunk=alloc(f,'G',19).chunks[0];chunk.launchAt=f.clock.now;
    const batch=f.d.makeBatchState('batch',[chunk],{}), stats=f.d.createStats();
    f.d.launchDueChunks(f.ns,[chunk],'food',f.cfg,new Map([['batch',batch]]),stats,new Map(),new Map(),null);
    assert.ok(f.launched.some(p=>p.host==='home'));assert.deepEqual(f.killed,[3]);
    assert.ok(f.processes.has(1)&&f.processes.has(2));assert.ok(128-f.ns.getServerUsedRam('home')>=24);
    assert.equal(f.launched.filter(p=>p.filename==='share-worker.js').length,0);
});
test('a late unrelated service prevents a committed home launch without eviction',()=>{
    const f=fixture(), chunk=alloc(f,'G',19).chunks[0];chunk.launchAt=f.clock.now;
    f.processes.set(4,{pid:4,host:'home',filename:'utility.js',ram:20,threads:1});
    const batch=f.d.makeBatchState('batch',[chunk],{});
    f.d.launchDueChunks(f.ns,[chunk],'food',f.cfg,new Map([['batch',batch]]),f.d.createStats(),new Map(),new Map(),null);
    assert.equal(f.launched.length,0);assert.ok(f.processes.has(4));assert.ok(f.killed.every(id=>id===3));
});
test('dead scheduler PIDs do not hide unrelated home service usage',()=>{
    const f=fixture();f.clock.now+=1000;
    f.h.observeHomeCapacity(f.ns,f.cfg,new Map([[900,{host:'home',ram:100}]]));
    assert.equal(f.cfg.homeGw.unrelatedRam,64);
});
for (const phase of ['G','W']) test(`background ${phase} uses protected home capacity with no Formulas and remains cancellable`,()=>{
    const f=fixture(), prep=loadScript('lib/background-prep.js',f.clock), state=prep.createBackgroundPrep({fraction:.9});state.target='food';
    const ctx={state,cfg:f.cfg,network:{hosts:f.hosts},spareRam:host=>f.d.availableRam(f.ns,host,f.cfg,new Map(),[],f.clock.now,Infinity),
        reclaimShare:host=>f.d.reclaimFleetShare(f.ns,host)};
    const gen=prep.planBackgroundWave(f.ns,ctx,{sec:phase==='W'?6:1,min:1,money:100,max:1000});let result;do{result=gen.next();}while(!result.done);
    const wave=result.value;assert.equal(wave.chunks[0].host,'home');assert.ok(wave.chunks[0].ram<=40);
    state.active={...wave,id:'bgprep-9-1',pending:wave.chunks,jobs:[],launched:0};state.diagnostics=wave.diagnostics;
    prep.launchPrepWave(f.ns,ctx);assert.ok(state.active.jobs.some(j=>j.host==='home'));
    prep.cancelBackgroundPrep(f.ns,state);assert.ok(f.processes.has(1)&&f.processes.has(2));
});
for (const action of ['H','G','W']) test(`XP ${action} respects home capability and money can reclaim its exact PID`,()=>{
    const f=fixture(), xp=loadScript('lib/hacking-xp.js',f.clock);
    f.ns.getServer=()=>({maxRam:128,cpuCores:4,hackDifficulty:1,minDifficulty:1,moneyAvailable:100,moneyMax:100});
    const running=new Map(), hosts=[{...f.cfg.homeGw.host,free:40,ram:{H:2,G:2,W:2}}];
    xp.launchXpWave(f.ns,{cfg:f.cfg},{name:'food',action,host:'home',threads:20},hosts,running,1,true,{tickMs:100});
    assert.equal(running.size,action==='H'?0:1);
    const state={jobs:running,samples:[],preemptRetryMs:1000,release:pid=>running.delete(pid)};xp.reclaimXpRam(f.ns,state,'home');
    assert.equal(running.size,0);assert.ok(f.processes.has(1)&&f.processes.has(2));
});
test('8 GB home has no safe G/W while remote bootstrap capacity remains',()=>{
    const f=fixture();f.ns.getServerMaxRam=name=>name==='home'?8:64;f.clock.now+=1000;f.h.observeHomeCapacity(f.ns,f.cfg);
    assert.equal(f.cfg.homeGw.safeRam,0);assert.ok(alloc(f,'W',1).chunks.every(c=>c.host==='remote'));
});
test('rolling evidence excludes XP, accounts for integer next-core savings, and expires',()=>{
    const f=fixture(), pool={cfg:f.cfg,running:new Map([[11,{host:'home',phase:'G',threads:20,ram:40,batchId:'a'}],
        [12,{host:'home',phase:'XP-W',threads:1000,ram:2000}], [13,{host:'remote',phase:'W2',threads:20,ram:40,batchId:'a'}]]),pipelines:new Map(),reservations:[]};
    for(let i=0;i<61;i++){f.h.sampleHomeUsage(pool);f.clock.now+=1000;}
    assert.equal(f.cfg.homeGw.recentUsage.averageRam,40);assert.equal(f.cfg.homeGw.recentUsage.nextCoreReleasedRam,2);
    assert.equal(f.cfg.homeGw.recentUsage.remoteGwAverageRam,40);assert.equal(f.cfg.homeGw.recentUsage.ramSeconds,2400);
    assert.equal(f.cfg.homeGw.samples.length,60);pool.running.clear();
    for(let i=0;i<61;i++){f.h.sampleHomeUsage(pool);f.clock.now+=1000;}
    assert.equal(f.cfg.homeGw.recentUsage.averageRam,0);
});
test('critical supervisor reserve cancels only owned optional home prep',()=>{
    const f=fixture(), multi=loadScript('lib/target-pipelines.js',f.clock), prep=loadScript('lib/background-prep.js',f.clock);
    f.processes.delete(3);f.processes.set(10,{pid:10,host:'home',filename:'background-grow.js',ram:40,threads:20});
    const state=prep.createBackgroundPrep();state.active={jobs:[{pid:10,host:'home',ram:40}],pending:[]};
    f.cfg.backgroundPrep=state;f.cfg.prepStates=[state];
    f.ns.getPortHandle(6).write({type:'home-capacity-policy',producerPid:1,generatedAt:f.clock.now,reserve:64});
    f.clock.now+=1000;
    multi.observeForeignRam(f.ns,{cfg:f.cfg,running:new Map(),pipelines:new Map(),xp:null,nextForeign:Infinity});
    assert.deepEqual(f.killed,[10]);assert.ok(f.processes.has(1)&&f.processes.has(2));
});
test('required faction share is retained and stale policy cannot overwrite a live reserve',()=>{
    const f=fixture();f.ns.getPortHandle(6).write({type:'home-capacity-policy',producerPid:1,generatedAt:f.clock.now,reserve:24,requiredShareRam:40});
    assert.equal(f.h.prepareHomeLaunch(f.ns,f.cfg,20),false);assert.deepEqual(f.killed,[]);
    f.ns.getPortHandle(6).clear();f.ns.getPortHandle(6).write({type:'home-capacity-policy',producerPid:1,generatedAt:f.clock.now-16000,reserve:0});
    f.h.readHomePolicy(f.ns,f.cfg);assert.equal(f.h.homeProtectedRam(f.cfg),64);
});
test('whole-batch home placement succeeds where the same remote-only batch cannot',()=>{
    const f=fixture(), plan={H:20,gEffective:19,hackSecurity:.04,steal:.1,times:{H:1000,G:1000,W:1000}};
    const batch=f.d.reserveBatch(f.ns,'food','b',f.clock.now+2000,plan,f.hosts,f.cfg,[],new Map());
    assert.ok(batch);assert.ok(batch.chunks.some(j=>j.host==='home'));assert.ok(batch.chunks.filter(j=>j.phase==='H').every(j=>j.host==='remote'));
    const cfg={...f.cfg,homeGw:null};
    assert.equal(f.d.reserveBatch(f.ns,'food','b',f.clock.now+2000,plan,f.hosts,cfg,[],new Map()),null);
});
test('home share waits for upcoming G/W and resumes through the normal supervisor reconciler',()=>{
    const f=fixture(), supervisor=loadScript('supervisor.js',f.clock);
    f.processes.set(9,{pid:9,host:'home',filename:'daemon.js',ram:0,threads:1});
    f.ns.run=(file,threads)=>f.ns.exec(file,'home',threads);
    const status={generatedAt:f.clock.now,pid:9,capacity:{homeGw:{enabled:true,protectedRam:24,pendingRam:40}}};
    f.ns.getPortHandle(17).write(status);supervisor.reconcileHomeShare(f.ns,true,24);
    assert.deepEqual(f.killed,[3]);assert.equal(f.launched.length,0);
    status.capacity.homeGw.pendingRam=0;supervisor.reconcileHomeShare(f.ns,true,24);
    assert.equal(f.launched.length,1);assert.equal(f.launched[0].filename,'share-worker.js');assert.equal(f.launched[0].threads,20);
});
