const test=require('node:test'), assert=require('node:assert/strict');
const {Clock,Port,loadScript}=require('./helpers.cjs');
function fixture(){
 const clock=new Clock(),api=loadScript('lib/home-economics.js',clock),policy=loadScript('lib/investment-policy.js',clock);
 const home={enabled:true,generatedAt:clock.now,cores:4,maxRam:256,safeRam:0,recentUsage:{seconds:60,averageRam:160,nextCoreReleasedRam:8,remoteGwAverageRam:800}};
 const snapshot={type:'jit-status',pid:9,generatedAt:clock.now,usedRam:1000,income60:1e8,maxBatchRate:4,
  pipelines:[{mode:'LIVE',modelBatchRate:1}],capacity:{homeGw:home,limitingFactor:'RAM',constraints:['RAM'],xp:{}}};
 const quote={type:'home-capital-quote',version:1,resetEpoch:'4:1:2',generatedAt:clock.now,ram:256,cores:4,ramCost:1e8,coreCost:1e7};
 const objective={version:1,type:'progression-objective',producer:'augmentation-manager.js',producerPid:8,resetEpoch:'4:1:2',generatedAt:clock.now,limitingResource:'cash'};
 return {clock,api,policy,home,snapshot,quote,objective,value(kind='cores'){return api.evaluateHomeInvestment(snapshot,quote,kind,objective);}};
}
test('measured home G/W RAM pressure independently justifies a core and performance RAM',()=>{
 const f=fixture();assert.equal(f.value().ok,true);assert.equal(f.value('ram').ok,true);
 assert.ok(f.value().releasedRam<10);assert.equal(f.value('ram').releasedRam,160);
 f.quote.coreCost*=100;assert.equal(f.value().ok,false);
});
for(const blocker of ['BATCH_RATE','LAUNCH_RATE','TARGET_SLOTS','NO_PROFITABLE_TARGET','WORKER_LIMIT','RECOVERY'])
 test(`${blocker} blocks speculative home infrastructure`,()=>{const f=fixture();f.snapshot.capacity.limitingFactor=blocker;f.snapshot.capacity.constraints=[blocker];assert.equal(f.value().ok,false);assert.equal(f.value('ram').ok,false);});
for(const problem of ['no utilization','short sample','idle home','stale scheduler','stale home','stale quote','future quote','missing timestamp','max cores','install','missing progression'])
 test(`${problem} cannot authorize core investment`,()=>{
  const f=fixture();
  if(problem==='no utilization')f.home.recentUsage.averageRam=0;
  if(problem==='short sample')f.home.recentUsage.seconds=10;
  if(problem==='idle home')f.home.safeRam=80;
  if(problem==='stale scheduler')f.snapshot.generatedAt-=16000;
  if(problem==='stale home')f.home.generatedAt-=16000;
  if(problem==='stale quote')f.quote.generatedAt-=16000;
  if(problem==='future quote')f.quote.generatedAt++;
  if(problem==='missing timestamp')delete f.quote.generatedAt;
  if(problem==='max cores')f.quote.cores=f.home.cores=8;
  if(problem==='install')f.objective.resetImminent=true;
  if(problem==='missing progression')f.objective=null;
  assert.equal(f.api.evaluateHomeInvestment(f.snapshot,f.quote,'cores',f.objective).ok,false);
 });
test('XP_RAM requires useful G/W work and script evidence, never university XP',()=>{
 const f=fixture();f.snapshot.capacity.limitingFactor='XP_RAM';f.snapshot.capacity.constraints=['XP_RAM'];f.objective.limitingResource='hacking';
 f.snapshot.capacity.xp={constrained:true,desiredRam:100,allocatedRam:20,target:'food',action:'H'};
 assert.equal(f.value().ok,false);f.snapshot.capacity.xp.action='W';assert.equal(f.value().ok,true);
 f.home.recentUsage.averageRam=0;f.snapshot.capacity.xp.playerXpRate=1e12;assert.equal(f.value().ok,false);
});
test('PREPARATION needs RAM pressure and stable throughput evidence',()=>{
 const f=fixture();f.snapshot.capacity.limitingFactor='PREPARATION';f.snapshot.capacity.constraints=['PREPARATION'];
 f.snapshot.capacity.preparation={constrained:false};assert.equal(f.value().ok,false);
 f.snapshot.capacity.preparation.constrained=true;assert.equal(f.value().ok,true);
});
test('integer thread rounding and remote Hack-only pressure provide no core ROI',()=>{
 const f=fixture();f.home.recentUsage.nextCoreReleasedRam=0;assert.equal(f.value().ok,false);
 f.home.recentUsage.nextCoreReleasedRam=8;f.home.recentUsage.remoteGwAverageRam=0;
 assert.equal(f.value().ok,false);assert.equal(f.value('ram').ok,false);
});
for(const winner of ['cloud','ram','cores']) test(`${winner} wins infrastructure arbitration by productive payback`,()=>{
 const f=fixture();const req=['cloud','ram','cores'].map((kind,i)=>({target:kind,priority:79,amount:100+i, economics:{payback:kind===winner?10:200}}));
 assert.equal(f.policy.chooseInvestment(req).chosen.target,winner);
 assert.equal(f.policy.chooseInvestment([...req,{target:'The Red Pill',amount:1e12,priority:100}],winner).chosen.target,'The Red Pill');
 assert.equal(f.policy.chooseInvestment([...req,{target:'services',amount:1e10,priority:90}],winner).chosen.target,'services');
});
test('20% infrastructure hysteresis preserves stability but permits a materially better alternative',()=>{
 const f=fixture(),a={target:'a',priority:79,amount:1,economics:{payback:100}},b={target:'b',priority:79,amount:2,economics:{payback:95}};
 assert.equal(f.policy.chooseInvestment([a,b],'a').chosen.target,'a');b.economics.payback=50;
 assert.equal(f.policy.chooseInvestment([a,b],'a').chosen.target,'b');
});
function actorFixture(){
 const f=fixture(),ports=new Map(),reset={currentNode:4,lastNodeReset:1,lastAugReset:2},goal={version:1,epoch:'4:1:2',amount:f.quote.coreCost/.9,
  target:'home:cores',owner:'supervisor',label:'cores'};
 let purchases=0,cash=1e12;
 const ns={pid:12,args:[],getResetInfo:()=>reset,getServer:()=>({maxRam:f.quote.ram,cpuCores:f.quote.cores}),
  getHostname:()=> 'home',getPortHandle:id=>{if(!ports.has(id))ports.set(id,new Port());return ports.get(id);},
  ps:()=>[{pid:8,filename:'augmentation-manager.js'}],isRunning:id=>[1,8,9].includes(id),read:()=>JSON.stringify(goal),
  getServerMoneyAvailable:()=>cash,singularity:{getUpgradeHomeRamCost:()=>f.quote.ramCost,getUpgradeHomeCoresCost:()=>f.quote.coreCost,
  upgradeHomeRam:()=>purchases++,upgradeHomeCores:()=>purchases++}};
 ns.getPortHandle(17).write(f.snapshot);ns.getPortHandle(11).write({type:'augmentation-status',version:1,producerPid:8,resetEpoch:'4:1:2',generatedAt:f.clock.now,progression:f.objective});
 const auth={type:'home-capacity-policy',producerPid:1,generatedAt:f.clock.now,resetEpoch:'4:1:2',performanceAllowed:true};ns.getPortHandle(6).write(auth);
 const expected={kind:'cores',cost:f.quote.coreCost,ram:256,cores:4,generatedAt:f.clock.now,resetEpoch:'4:1:2'};
 return {...f,ns,reset,goal,auth,expected,cash:n=>cash=n,count:()=>purchases,run:async()=>{
  ns.args=['4:1:2',JSON.stringify(expected)];await loadScript('home-capital.js',f.clock).main(ns);
 }};
}
test('short-lived helper quotes RAM and cores together, buys exactly one independently justified upgrade',async()=>{
 const f=actorFixture();await f.run();assert.equal(f.count(),1);const q=f.ns.getPortHandle(8).peek();assert.equal(q.ramCost,1e8);assert.equal(q.coreCost,1e7);
 f.quote.cores++;await f.run();assert.equal(f.count(),1,'old authorization cannot buy next core');
});
test('performance RAM uses the same funded arbitration and transaction checks',async()=>{
 const f=actorFixture();f.expected.kind='ram';f.expected.cost=f.quote.ramCost;
 f.goal.target='home:performance-ram';f.goal.amount=f.quote.ramCost/.9;
 await f.run();assert.equal(f.count(),1);
 f.objective.resetImminent=true;await f.run();assert.equal(f.count(),1);
});
for(const reason of ['cost changed','RAM changed','quote expired','unfunded','other goal','manual savings','reset changed','install','policy disabled','policy expired','telemetry expired','no SF4','floor'])
 test(`purchase-time ${reason} prevents spending`,async()=>{
  const f=actorFixture();
  if(reason==='cost changed')f.quote.coreCost++;
  if(reason==='RAM changed')f.quote.ram*=2;
  if(reason==='quote expired')f.expected.generatedAt-=16000;
  if(reason==='unfunded')f.cash(1);
  if(reason==='other goal')f.goal.target='augmentation:The Red Pill';
  if(reason==='manual savings')f.goal.owner='manual';
  if(reason==='reset changed')f.reset.lastAugReset++;
  if(reason==='install')f.objective.resetImminent=true;
  if(reason==='policy disabled')f.auth.performanceAllowed=false;
  if(reason==='policy expired')f.auth.generatedAt-=16000;
  if(reason==='telemetry expired')f.snapshot.generatedAt-=16000;
  if(reason==='no SF4')f.reset.currentNode=5;
  if(reason==='floor'){f.goal.amount=1e13;f.cash(1e12);}
  await f.run();assert.equal(f.count(),0);
 });
test('no-Singularity helper exits normally without touching expensive APIs',async()=>{
 const f=actorFixture();f.reset.currentNode=1;f.ns.args=['1:1:2',''];delete f.ns.singularity;
 await loadScript('home-capital.js',f.clock).main(f.ns);assert.equal(f.count(),0);
});
