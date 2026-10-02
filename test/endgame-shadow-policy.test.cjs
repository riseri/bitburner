const test=require('node:test'),assert=require('node:assert/strict');
const {Clock,Port,loadScript}=require('./helpers.cjs');

function fixture(){
    const clock=new Clock(),api=loadScript('daemon.js',clock),multi=loadScript('lib/target-pipelines.js',clock);
    api.refreshHackingPolicy=loadScript('lib/hacking-policy.js',clock).refreshHackingPolicy;
    const xp=loadScript('lib/hacking-xp.js',clock),ports=new Map(),processes=new Map(),launches=[],killed=[];
    const home={name:'home',maxRam:65536,cores:5},remote={name:'remote',maxRam:2348,cores:1};
    const goal={type:'progression-objective',version:1,producer:'augmentation-manager.js',producerPid:7,
        generatedAt:clock.now,resetEpoch:'4:1:2',milestone:'FINAL_SERVER',limitingResource:'hacking',
        requiredHacking:9000,currentHacking:7814,requiredCash:0,remainingCash:0,moneyCovered:true,redPill:'installed'};
    const cfg={gap:100,lead:600,homeReserve:161.75,port:20,controlPort:15,maxTargets:6,maxBatchRate:3,maxLaunches:52,
        maxWorkers:6000,maxSteal:.5,ram:{H:2,G:2.2,W:2.2},prepStates:[],progressionObjective:goal,
        homeGw:{host:home,maxRam:home.maxRam,cores:5,protectedRam:161.75,criticalReserve:161.75,unrelatedRam:366.95}};
    const pool={api,cfg,ownerPid:1,controls:new Map(),controlPort:new Port(),port:new Port(),anchor:'joesguns',planCursor:0,
        network:{hosts:[remote],servers:['joesguns','nectar-net','neo-net']},pipelines:new Map(),history:[],
        running:new Map(),runningByChunk:new Map(),reservations:[],foreign:new Map(),launchBuckets:new Map()};
    let pid=100;
    const ns={pid:1,fileExists:()=>true,read:()=>'',getHackingLevel:()=>7814,
        getResetInfo:()=>({currentNode:4,lastNodeReset:1,lastAugReset:2,ownedSF:new Map([[5,1]])}),
        getBitNodeMultipliers:()=>({ScriptHackMoney:.2,ScriptHackMoneyGain:1,HackExpGain:.4,HackingLevelMultiplier:1,
            HackingSpeedMultiplier:1,ServerMaxMoney:.1125,ServerStartingMoney:.75,ServerGrowthRate:1,ServerStartingSecurity:1}),
        getPlayer:()=>({skills:{hacking:7814},exp:{hacking:3.37e10},mults:{hacking:13.6}}),
        getPortHandle:n=>{if(!ports.has(n))ports.set(n,new Port());return ports.get(n);},
        getServerMaxRam:name=>name==='home'?home.maxRam:remote.maxRam,
        getServerUsedRam:name=>(name==='home'?366.95:0)+[...processes.values()].filter(p=>p.host===name).reduce((n,p)=>n+p.ram,0),
        getScriptRam:file=>file==='jit-hack.js'?2:2.2,
        getServerMoneyAvailable:name=>name==='home'?154.99e9:1e6,getServerMaxMoney:()=>1e6,
        getServerSecurityLevel:()=>1,getServerMinSecurityLevel:()=>1,
        getServer:name=>({hostname:name,cpuCores:name==='home'?5:1,hasAdminRights:true,requiredHackingSkill:1,
            minDifficulty:1,hackDifficulty:1,moneyAvailable:1e6,moneyMax:1e6,baseDifficulty:10}),
        getGrowTime:()=>3200,getWeakenTime:()=>4000,getHackTime:()=>1000,
        hackAnalyzeSecurity:t=>t*.002,growthAnalyzeSecurity:t=>t*.004,weakenAnalyze:t=>t*.05,
        isRunning:id=>id===1||id===7||processes.has(id),
        ps:name=>[...(name==='home'?[{pid:7,filename:'augmentation-manager.js',threads:1,args:[]}]:[]),
            ...[...processes.values()].filter(p=>p.host===name).map(p=>({...p,filename:p.file}))],
        kill:id=>{killed.push(id);return processes.delete(id);},
        exec(file,host,threads,...args){
            const ram=threads*ns.getScriptRam(file);assert.ok(ns.getServerUsedRam(host)+ram<=ns.getServerMaxRam(host)+1e-9);
            const p={pid:++pid,file,host,threads,args,ram};processes.set(pid,p);launches.push(p);return pid;
        },
        formulas:{skills:{calculateExp:()=>5.17e11},hacking:{hackExp:()=>6,hackChance:()=>1,hackPercent:()=>.01,
            hackTime:()=>1000,growTime:()=>3200,weakenTime:()=>4000,growThreads:()=>10,weakenEffect:t=>t*.05}}};
    const names=['joesguns','nectar-net'];
    for(let i=0;i<names.length;i++){
        const plan={period:i?864:543,batchRate:1000/(i?864:543),expected:i?4.20e6:6.01e6,H:4,gEffective:10,
            steal:.1,hackSecurity:.008,times:{H:1000,G:3200,W:4000},ramTime:100000};
        const p=multi.createTargetPipeline(names[i],cfg,api,1,i,{plan,formulas:true});
        p.trial=false;p.shadow={state:'SHADOW'};p.stats.pipeline.completed=100;p.stats.pipeline.productiveMs=180000;
        p.stats.lastHackAt=clock.now;p.stats.money=50e9;p.tunedLevel=4691;
        p.control=multi.targetControl(pool,p);pool.pipelines.set(p.name,p);
        const landing=clock.now+5000+i*50;
        const result=api.reserveBatch(ns,p.name,p.name+':old',landing,plan,[remote],p.cfg,pool.reservations,pool.running,pool.foreign);
        assert.ok(result);multi.commitGenerationBatch(pool,p,p.name+':old',result.chunks,p.generations.get(1));
        p.nextLanding=landing+plan.period;
    }
    pool.xp=xp.createXpPipeline(pool);cfg.xpPipeline=pool.xp;
    const status=ns.getPortHandle(loadScript('lib/ports.js',clock).PORTS.AUGMENTATION_STATUS);
    status.write({type:'augmentation-status',version:1,producerPid:7,generatedAt:clock.now,resetEpoch:goal.resetEpoch,progression:goal});
    return {clock,api,multi,xp,ns,pool,cfg,launches,killed};
}

test('reported 7814/9000 state retains XP pacing through passive shadows and launches on 63 TB of idle home RAM',()=>{
    const f=fixture(),old=[...f.pool.reservations];
    f.multi.serviceHackingPolicy(f.ns,f.pool);
    assert.equal(f.cfg.milestoneEvidence.safe,true);assert.equal(f.cfg.hackingPolicy.xpAllocation,.7);
    assert.equal(f.cfg.hackingPolicy.balance.xpAllocation,.7);
    for(let i=0;i<2;i++)f.multi.planPipelineBatch(f.ns,f.pool);
    for(const p of f.pool.pipelines.values()){
        const next=[...p.batches.values()].find(b=>b.id!==p.name+':old');assert.ok(next);
        assert.ok(Math.abs(next.admissionPeriod-p.runtime.plan.period/.3)<1e-6);
        assert.ok(p.batches.has(p.name+':old'));
    }
    f.multi.serviceXpPipeline(f.ns,f.pool);
    assert.equal(f.pool.xp.status,'RUNNING',f.pool.xp.reason);
    assert.ok([...f.pool.xp.jobs.values()].some(j=>j.host==='home'&&j.ram>63000));
    assert.ok(f.launches.every(p=>p.args[0]==='neo-net'));assert.deepEqual(f.killed,[]);
    for(const r of old)assert.ok(f.pool.reservations.includes(r),'money reservations remain protected');
    console.log(JSON.stringify({allocation:f.cfg.hackingPolicy.xpAllocation,xpWorkers:f.pool.xp.jobs.size,
        xpRam:[...f.pool.xp.jobs.values()].reduce((n,j)=>n+j.ram,0)}));
});

test('actual cutover preflight still suspends XP pacing and releases only optional XP workers',()=>{
    const f=fixture();f.multi.serviceHackingPolicy(f.ns,f.pool);f.multi.serviceXpPipeline(f.ns,f.pool);
    const old=[...f.pool.reservations].filter(r=>!r.chunk.phase?.startsWith('XP-'));
    f.pool.pipelines.get('joesguns').shadow.state='PREFLIGHT';f.clock.now+=1001;
    f.multi.serviceHackingPolicy(f.ns,f.pool);f.multi.serviceXpPipeline(f.ns,f.pool);
    assert.equal(f.cfg.milestoneEvidence.safe,false);assert.equal(f.cfg.hackingPolicy.xpAllocation,0);
    assert.match(f.cfg.hackingPolicy.reason,/XP allocation suspended/);
    assert.equal(f.pool.xp.status,'WAITING_MONEY');assert.equal(f.pool.xp.jobs.size,0);
    assert.ok(f.killed.length>0);for(const r of old)assert.ok(f.pool.reservations.includes(r));
});
