const test=require('node:test'), assert=require('node:assert/strict');
const {Clock,Port,loadScript}=require('./helpers.cjs');
const clock=new Clock(), objective=loadScript('lib/progression-objective.js',clock), planner=loadScript('lib/augmentation-plan.js',clock);
const names=n=>Array.from({length:n},(_,i)=>'Aug'+i);
function context(extra={}) {return {money:1000,income:10,objective:{countRequired:30,ownedCount:30,limitingResource:'cash'},...extra};}
function aug(name,price,prerequisites=[],extra={}) {return {name,price,prerequisites,repGap:0,repRequired:10,faction:'A',stats:{hacking:1.2},etaMs:0,...extra};}

test('distinct Daedalus requirements follow multipliers and NFG counts once',()=>{
  const p=objective.progressionObjective({currentNode:4,installed:[...names(28),'NeuroFlux Governor','NeuroFlux Governor'],owned:[...names(28),'NeuroFlux Governor','Next'],player:{skills:{hacking:2500}},money:1e11});
  assert.equal(p.installedCount,29);assert.equal(p.ownedCount,30);assert.equal(p.limitingResource,'installation');
  const other=objective.progressionObjective({currentNode:12,installed:names(30),owned:names(30),multipliers:{DaedalusAugsRequirement:40},player:{skills:{hacking:3000}}});
  assert.equal(other.countRequired,40);assert.equal(other.milestone,'AUGMENTATIONS');
});
test('Red Pill targets the live final requirement and queued Pill requests installation',()=>{
  const input={currentNode:4,installed:['The Red Pill'],owned:['The Red Pill'],player:{skills:{hacking:3000}},finalRequirement:9000};
  const p=objective.progressionObjective(input);assert.equal(p.requiredHacking,9000);assert.equal(p.moneyCovered,true);assert.equal(p.limitingResource,'hacking');
  assert.equal(objective.progressionObjective({...input,installed:[]}).milestone,'INSTALL_RED_PILL');
  assert.equal(objective.progressionObjective({...input,finalRequirement:null}).limitingResource,'discovery');
});
test('faction unlock chooses the next live server requirement',()=>{
  const p=objective.progressionObjective({currentNode:4,player:{skills:{hacking:100}},backdoors:[{requiredHacking:800},{requiredHacking:350},{requiredHacking:200,installed:true}]});
  assert.equal(p.requiredHacking,350);assert.equal(p.milestone,'FACTION_UNLOCK');
});
test('shared observation rejects stale future wrong epoch version and wrong producer',()=>{
  const port=new Port(), reset={currentNode:4,lastNodeReset:1,lastAugReset:2};
  const ns={getPortHandle:()=>port,getResetInfo:()=>reset,ps:()=>[{pid:9,filename:'augmentation-manager.js'}]};
  const good={type:'augmentation-status',version:1,producerPid:9,resetEpoch:'4:1:2',generatedAt:clock.now,progression:{type:'progression-objective',version:1,producer:'augmentation-manager.js',producerPid:9,resetEpoch:'4:1:2',generatedAt:clock.now}};
  port.write(good);assert.ok(objective.readProgressionSnapshot(ns));
  for(const patch of [{generatedAt:clock.now-15001},{generatedAt:clock.now+1},{resetEpoch:'4:1:3'},{version:2},{producerPid:10},{producer:'fake.js'}]) {
    port.clear();port.write({...good,progression:{...good.progression,...patch}});assert.equal(objective.readProgressionSnapshot(ns),null);
  }
});
test('whole prerequisite chains include inflation and select useful affordable alternatives',()=>{
  const catalog=[aug('Expensive',10000),aug('Child',50,['Base']),aug('Base',100),aug('Useful',80)];
  const p=planner.planAugmentationBasket(catalog,[],context(),{cash:300,multiplier:2});
  assert.notEqual(p.next.name,'Expensive');assert.ok(p.total<=300);
  for(const [i,a] of p.order.entries()) for(const req of a.prerequisites) assert.ok(p.order.slice(0,i).some(v=>v.name===req));
  const explicit=planner.planAugmentationBasket(catalog,[],context(),{cash:300,multiplier:2,target:'Child'});
  assert.deepEqual(Array.from(explicit.order,a=>a.name),['Base','Child']);assert.equal(explicit.total,200);
  assert.equal(explicit.order[0].benefitNow,0);
});
test('explicit unaffordable chain is retained and missing/cyclic chains cannot be purchased',()=>{
  const p=planner.planAugmentationBasket([aug('A',100,['B']),aug('B',100)],[],context(),{cash:150,multiplier:2,target:'A'});
  assert.equal(p.order.length,0);assert.equal(p.next.name,'B');assert.equal(p.next.chainTarget,'A');assert.equal(p.next.chainCost,300);
  const broken=planner.planAugmentationBasket([aug('A',1,['B']),aug('B',1,['A'])],[],context(),{cash:1e6,target:'A'});
  assert.equal(broken.next,null);assert.equal(broken.errors.length,1);
});
test('seller ETA includes work rate donation cost favor eligibility and income',()=>{
  const sellers=[{faction:'Slow',repGap:10,rate:1,favor:0},{faction:'Fast',repGap:100,rate:100,favor:0}];
  assert.equal(planner.chooseAugmentationSeller(sellers,{price:100,cash:100,income:1}).faction,'Fast');
  sellers.push({faction:'Donor',repGap:500,rate:1,favor:150,donationEligible:true,donationCost:50});
  assert.equal(planner.chooseAugmentationSeller(sellers,{price:100,cash:200,income:1}).faction,'Donor');
  assert.equal(planner.chooseAugmentationSeller(sellers,{price:100,cash:100,income:1,donate:false}).faction,'Fast');
  assert.equal(planner.chooseAugmentationSeller([{faction:'Unknown',repGap:5,favor:10}],{price:100,cash:0}).etaMs,null);
});
test('seller and plan hysteresis retain similar decisions without blocking affordable alternatives',()=>{
  const sellers=[{faction:'Old',repGap:105,rate:10,favor:0},{faction:'New',repGap:100,rate:10,favor:0}];
  assert.equal(planner.chooseAugmentationSeller(sellers,{price:0,cash:0,previous:'Old'}).faction,'Old');
  const p=planner.planAugmentationBasket([aug('Old',10000),aug('New',100)],[],context(),{cash:100,previous:'Old'});
  assert.equal(p.next.name,'New');
});
test('multipliers change benefit scoring and SF11 changes sequential inflation',()=>{
  const money=aug('Money',1,[],{stats:{hacking_money:2}}),xp=aug('XP',1,[],{stats:{hacking_exp:2}});
  assert.ok(planner.augmentationValue(money,context())>planner.augmentationValue(xp,context()));
  const hostile=context({multipliers:{ScriptHackMoney:0},objective:{limitingResource:'hacking',ownedCount:30,countRequired:30}});
  assert.equal(planner.augmentationValue(money,hostile),0);assert.ok(planner.augmentationValue(xp,hostile)>0);
  assert.equal(planner.purchaseInflation({currentNode:4,ownedSF:new Map()}),1.9);
  assert.equal(planner.purchaseInflation({currentNode:4,ownedSF:new Map([[11,3]])}),1.9*.93);
});
test('real stalled progress differs from reset age and cash oscillation',()=>{
  const state={}, facts={key:'A',cash:100,rep:0,owned:1,level:1};
  objective.observeProgress(state,facts,1000);objective.observeProgress(state,{...facts,cash:50},2000);
  assert.equal(objective.observeProgress(state,facts,3000).stalledMs,2000);
  assert.equal(objective.observeProgress(state,{...facts,rep:10},4000).stalledMs,0);
});
test('installation waits briefly for valuable purchase, bounds stalls, and uses favor evidence',()=>{
  const route=loadScript('lib/bitnode-route.js',clock), input={installed:[],pending:names(5),minInstall:5,money:100,lastAugReset:0,progress:{waitingMs:100,stalledMs:0},plan:{next:aug('A',100,[],{etaMs:30000,benefitAfterInstall:1}),errors:[]}};
  assert.equal(route.routeInstallation(input),'');
  assert.match(route.routeInstallation({...input,progress:{waitingMs:120000,stalledMs:0}}),/threshold/);
  assert.match(route.routeInstallation({...input,pending:['A'],plan:{next:aug('B',1e6,[],{repGap:100}),errors:[]},progress:{waitingMs:1800000,stalledMs:1800000}}),/stalled/);
  assert.match(route.routeInstallation({...input,plan:{next:{etaMs:1e7,favorUnlockEtaMs:1e6},errors:[]}}),/donations/);
});
test('progression XP works without multiplier access, honors money gates and handles >2500',()=>{
  const policy=loadScript('lib/hacking-policy.js',clock), args={capabilities:{formulas:true,bitNodeMultipliers:false,multipliers:null,currentNode:4},level:3000,objective:{requiredHacking:8000,limitingResource:'hacking',moneyCovered:true,redPill:'installed',milestone:'FINAL_SERVER'}};
  let p=policy.evaluateHackingPolicy(args);assert.equal(p.mode,'XP');assert.equal(p.targetLevel,8000);assert.equal(p.xpAllocation,.7);
  assert.equal(policy.evaluateHackingPolicy({...args,objective:{...args.objective,moneyCovered:false}}).xpAllocation,0);
  assert.equal(policy.evaluateHackingPolicy({...args,capabilities:{...args.capabilities,formulas:false}}).mode,'NORMAL');
  assert.equal(policy.evaluateHackingPolicy({...args,level:8000}).xpAllocation,0);
});
test('program ranking unlocks Navigator before costly SQL when RAM fits, and defers Formulas',()=>{
  const api=loadScript('lib/programs.js',clock), programs=Array.from(api.progressionPrograms(),p=>({...p,owned:p.cost<5e7}));
  let ranked=api.rankPrograms(programs,{homeRam:128,darknetRam:32,money:1e8});assert.equal(ranked[0].name,'DarkscapeNavigator.exe');
  assert.equal(ranked.find(p=>p.name==='Formulas.exe').useful,false);
  ranked=api.rankPrograms(programs,{homeRam:8,darknetRam:32,money:1e8});assert.equal(ranked[0].name,'DarkscapeNavigator.exe');
  assert.equal(ranked[0].useful,true);assert.equal(ranked[0].activationReady,false);
  assert.equal(api.rankPrograms(programs,{homeRam:128,money:2e10}).find(p=>p.name==='Formulas.exe').useful,true);
});
test('program creation requires eligibility and a better bounded ETA than purchase',()=>{
  const api=loadScript('lib/programs.js',clock), p=api.progressionPrograms()[0];
  assert.equal(api.programCreationEstimate(p,{skills:{hacking:1}},1,0),null);
  assert.equal(api.programCreationEstimate(p,{skills:{hacking:100}},1,0).create,true);
  assert.equal(api.programCreationEstimate(p,{skills:{hacking:100}},1e6,0).create,false);
  assert.equal(api.programCreationEstimate(p,{skills:{hacking:100}},null,0).create,false);
});
test('capital arbitration prioritizes Red Pill and preserves stable near ties',()=>{
  const api=loadScript('lib/investment-policy.js',clock), requests=[{target:'SQLInject.exe',amount:250e6,priority:50},{target:'augmentation:The Red Pill',amount:1e9,priority:100}];
  assert.equal(api.chooseInvestment(requests,'SQLInject.exe').chosen.target,'augmentation:The Red Pill');
  assert.equal(api.chooseInvestment([{target:'A',amount:10,priority:70},{target:'B',amount:10,priority:72}],'A').chosen.target,'A');
  assert.equal(api.stockAccessInvestment({cost:100,cash:500,income:10}).ok,true);
  assert.equal(api.stockAccessInvestment({cost:100,cash:500,income:null}).ok,false);
});
test('home upgrade quotes avoid repeated worker disruption while unaffordable',async()=>{
  const api=loadScript('supervisor.js',clock), quote=new Port(), state={}, calls=[];
  quote.write({type:'home-upgrade-quote',version:1,producerPid:3,resetEpoch:'4:1:2',generatedAt:clock.now,ram:8,cost:1e9});
  const ns={getScriptRam:()=>8,ps:()=>[{filename:'starter-worker.js',pid:5,args:['n00dles','supervisor-starter-v1'],threads:2}],getResetInfo:()=>({currentNode:4,lastNodeReset:1,lastAugReset:2}),getServerMaxRam:()=>8,getServerMoneyAvailable:()=>100,read:()=>'',getPortHandle:()=>quote,kill:p=>calls.push(p),exec:()=>calls.push('exec')};
  await api.tickStarterHomeUpgrade(ns,['home'],64,state);await api.tickStarterHomeUpgrade(ns,['home'],64,state);
  assert.equal(calls.length,0);assert.equal(state.homeInvestment.amount,1e9);
});
test('service admission ignores disabled and unavailable services',()=>{
  const api=loadScript('supervisor.js',clock), catalog=loadScript('lib/service-catalog.js',clock), seen=[];
  const ns={getScriptRam:name=>{seen.push(name);return 10;},getServerMaxRam:()=>8};
  assert.equal(api.starterAdmissionRam(ns),30);assert.deepEqual(seen,['supervisor.js','daemon.js','fleet-manager.js']);
  assert.equal(api.starterAdmissionRam(ns,{progression:true},7.25),47.25);
  const selected=catalog.selectedServices({contracts:false,stocks:false,augmentationActions:true},{singularity:false});
  assert.deepEqual(Array.from(selected,s=>s.name),['daemon.js','fleet-manager.js']);
});
test('stock liquidity rejects old resets/stale requests and sizes partial sales including commission',()=>{
  const api=loadScript('lib/stock-liquidity.js',clock), goal={version:1,amount:1000,label:'Pill',target:'augmentation:The Red Pill',owner:'supervisor',epoch:'4:1:2',updatedAt:clock.now,producerPid:9,priority:100,liquidity:true};
  const ns={read:()=>JSON.stringify(goal),getResetInfo:()=>({currentNode:4,lastNodeReset:1,lastAugReset:2}),ps:()=>[{pid:9,filename:'supervisor.js'}]};
  assert.ok(api.readLiquidityRequest(ns));goal.updatedAt-=16000;assert.equal(api.readLiquidityRequest(ns),null);
  assert.equal(api.liquidationShares(100,150,n=>n*10-100),25);
  assert.equal(api.liquidationShares(100,150,()=>null),0);
});
test('Darknet unavailable reward telemetry stays unknown and Go auto choices follow bottlenecks',()=>{
  const d=loadScript('darknet-manager.js',clock), g=loadScript('go-bot.js',clock);
  const telemetry=d.darknetValue({isRunning:()=>true,getRunningScript:()=>({ramUsage:2,threads:3})},{agents:{one:{pid:1}},servers:{a:{password:'x'}},stats:{}});
  assert.equal(telemetry.ramGb,6);assert.equal(telemetry.cash,null);assert.equal(telemetry.hackingXp,null);
  assert.equal(g.progressionGoOpponent({limitingResource:'hacking'}),'Illuminati');assert.equal(g.progressionGoOpponent({limitingResource:'reputation'}),'Daedalus');
});

test('selective company unlock requires better offerings, live requirements, and owned player work',()=>{
  const api=loadScript('lib/route-actions.js',clock), calls=[], state={}, ctx=context({owned:[],player:{factions:[],jobs:{ECorp:'Software'},skills:{hacking:100}},objective:{ownedCount:0,countRequired:30}});
  let work={type:'CLASS',location:'Manual'};
  const ns={singularity:{getFactionInviteRequirements:()=>[{type:'employedBy',company:'ECorp'},{type:'companyReputation',company:'ECorp',reputation:200000}],
    getAugmentationsFromFaction:f=>f==='ECorp'?['CompanyAug']:[],getAugmentationStats:()=>({hacking:2}),getAugmentationPrereq:()=>[],getAugmentationPrice:()=>100,
    getCompanyRep:()=>100,getCurrentWork:()=>work,isBusy:()=>!!work,workForCompany:name=>{calls.push(name);return true;}}};
  const cfg={work:true,joinFactions:true};
  assert.equal(api.routeSelectiveFaction(ns,cfg,state,ctx,{order:[],next:null}),null);assert.equal(calls.length,0);
  work=null;assert.equal(api.routeSelectiveFaction(ns,cfg,state,ctx,{order:[],next:null}).phase,'COMPANY');assert.equal(state.ownedCompany,'ECorp');
  assert.equal(api.routeSelectiveFaction(ns,cfg,{},ctx,{order:[aug('BuyNow',1)],next:aug('BuyNow',1)}),null);
});

test('program creation never interrupts unrelated player work and tracks only its own program',()=>{
  const api=loadScript('lib/route-actions.js',clock),state={},ctx=context({money:0,income:1,owned:[],player:{skills:{hacking:100}}});
  let work={type:'FACTION',factionName:'Manual'},created=0;
  const ns={fileExists:()=>false,singularity:{getCurrentWork:()=>work,isBusy:()=>!!work,createProgram:()=>{created++;return true;}}};
  const cfg={work:true,programCreation:true};
  assert.equal(api.routeProgramCreation(ns,cfg,state,ctx,{next:null}),null);assert.equal(created,0);
  work=null;assert.equal(api.routeProgramCreation(ns,cfg,state,ctx,{next:null}).phase,'PROGRAM_CREATE');assert.equal(state.ownedProgram,'BruteSSH.exe');
  assert.equal(api.routeOwnsWork({type:'CREATE_PROGRAM',programName:'Formulas.exe'},state),false);
});

test('stock access helper waits without multiplier evidence',async()=>{
  const api=loadScript('stock-access.js',clock),port=new Port(),calls=[];
  const ns={flags:p=>Object.fromEntries(p),tprint:s=>calls.push(s),read:()=>'',getPortHandle:()=>port,getResetInfo:()=>({currentNode:4,lastNodeReset:1,lastAugReset:2}),ps:()=>[]};
  await api.main(ns);assert.match(calls[0],/evidence/);
});

test('stock access cannot spend a manual reserve even with favorable income',async()=>{
  const api=loadScript('stock-access.js',clock),port=new Port(),calls=[];
  const reset={currentNode:4,lastNodeReset:1,lastAugReset:2},snapshot={type:'progression-objective',version:1,producer:'augmentation-manager.js',producerPid:9,resetEpoch:'4:1:2',generatedAt:clock.now,multipliers:{FourSigmaMarketDataApiCost:1},queuedDistinct:[],incomePerSecond:1000,redPill:'none'};
  port.write({type:'augmentation-status',version:1,producerPid:9,resetEpoch:'4:1:2',generatedAt:clock.now,progression:snapshot});
  const ns={flags:p=>Object.fromEntries(p),tprint:s=>calls.push(s),getPortHandle:()=>port,getResetInfo:()=>reset,ps:()=>[{pid:9,filename:'augmentation-manager.js'}],
    read:()=>JSON.stringify({version:1,amount:1000,label:'Manual goal',target:'manual',owner:'manual',epoch:'4:1:2'}),getServerMoneyAvailable:()=>1000,
    stock:{getConstants:()=>({WseAccountCost:10,TixApiCost:20,MarketDataTixApi4SCost:30}),hasWseAccount:()=>false,hasTixApiAccess:()=>false,has4SDataTixApi:()=>false,
      purchaseWseAccount:()=>{throw Error('must not spend');}}};
  await api.main(ns);assert.match(calls[0],/capital/);
});

test('donations honor a dynamic plan that prefers working',()=>{
  const api=loadScript('augmentation-manager.js',clock);
  assert.equal(api.affordableDonation({}, {donate:true}, {donationPlanned:false}),0);
});
test('installation uses the observed distinct count requirement',()=>{
  const api=loadScript('lib/bitnode-route.js',clock);
  const input={installed:names(29),pending:['New'],minInstall:5,money:0,lastAugReset:clock.now,plan:{next:{price:1e9,repGap:1},errors:[]},countRequired:40};
  assert.equal(api.routeInstallation(input),'');
  assert.match(api.routeInstallation({...input,countRequired:30}),/Daedalus/);
});
