const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

const clock = new Clock();
const solvers = loadScript('lib/darknet-solvers.js', clock);

test('darknet static solvers decode direct, captcha, binary, xor, base, arithmetic and prime hints', () => {
    const cases = [
        [{modelId:'ZeroLogon'}, ''],
        [{modelId:'DeskMemo_3.1',passwordHint:'The PIN is 428'}, '428'],
        [{modelId:'CloudBlare(tm)',data:'1/[2]╬3'}, '123'],
        [{modelId:'110100100',data:'01000001 00110001'}, 'A1'],
        [{modelId:'PrimeTime 2',data:'13195'}, '29'],
        [{modelId:'OctantVoxel',data:'16,FF'}, '255'],
        [{modelId:'MathML',data:'4 ➕ 5 ҳ ( 6 ➖ 2 )'}, '24'],
        [{modelId:'OrdoXenos',data:`BA;00000011 00000011`}, 'AB'],
        [{modelId:'Pr0verFl0',passwordLength:4}, '■■■■■■■■'],
    ];
    for (const [details, expected] of cases) assert.equal(String(solvers.staticCandidates(details)[0]), expected, details.modelId);
});

test('darknet feedback parser selects the exact attempted password log', () => {
    const logs = ['noise', JSON.stringify({passwordAttempted:'111',data:'Lower'}), JSON.stringify({passwordAttempted:'222',data:'Higher'})];
    assert.equal(solvers.parsePasswordResponse(logs,'222').data,'Higher');
    assert.equal(solvers.parsePasswordResponse(logs,'333'),null);
});

test('darknet numeric oracle solver authenticates a GuessNumber server', async () => {
    const password = '731', logs = [];
    const ns = { dnet: {
        authenticate: async (_host, attempt) => {
            if (attempt === password) return {success:true,code:200};
            logs.unshift(JSON.stringify({passwordAttempted:attempt,data:Number(attempt)>Number(password)?'Lower':'Higher'}));
            return {success:false,code:401};
        },
        heartbleed: async () => ({success:true,logs:[...logs]}),
    }};
    const result = await solvers.solveServer(ns,'target',{modelId:'AccountsManager_4.2',passwordLength:3,passwordFormat:'numeric'});
    assert.equal(result.success,true); assert.equal(result.password,password); assert.ok(result.attempts <= 10);
});

test('darknet XOR and Darkscape progression are included in the complete model/unlock surface', () => {
    const protocol = loadScript('lib/progression-protocol.js', new Clock());
    assert.equal(loadScript('lib/programs.js', new Clock()).progressionPrograms().at(-1).name,'DarkscapeNavigator.exe');
    assert.equal(loadScript('lib/programs.js', new Clock()).progressionPrograms().at(-1).cost,50_000_000);
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/lib/darknet-solvers.js'),'utf8');
    for (const model of ['PHP 5.4','DeepGreen','AccountsManager_4.2','BellaCuore','NIL','RateMyPix.Auth','2G_cellular','Factori-Os','BigMo%od','KingOfTheHill','OpenWebAccessPoint','(The Labyrinth)']) assert.match(source,new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('darknet manager persists credentials and counts operational events', () => {
    const manager = loadScript('darknet-manager.js', new Clock());
    const state={servers:{},agents:{},stats:{caches:0,deployments:0,blocked:0,errors:0},last:''};
    manager.applyEvent(state,{kind:'credential',host:'x',password:'secret',modelId:'ZeroLogon',at:1});
    manager.applyEvent(state,{kind:'cache',host:'x',at:2});
    manager.applyEvent(state,{kind:'deployed',host:'x',pid:7,at:3});
    manager.applyEvent(state,{kind:'agent',host:'x',pid:7,state:'running',at:4});
    assert.equal(state.servers.x.password,'secret'); assert.equal(state.stats.caches,1);
    assert.equal(state.stats.deployments,1); assert.equal(state.agents['x:7'].state,'running');
});

test('darknet cracking telemetry can only be created by a lease grant', () => {
    const f = coordinationFixture();
    f.manager.applyEvent(f.state,{kind:'cracking',host:'alpha',from:'darkweb',pid:3,modelId:'ZeroLogon',at:1});
    assert.equal(f.state.cracking.alpha,undefined);
    const grant = f.acquire('alpha',3);
    assert.equal(f.state.cracking.alpha.modelId,'ZeroLogon');
    f.manager.handleRequest(f.state,{kind:'credential',client:'3',seq:2,pid:3,host:'alpha',token:grant.token,password:'',modelId:'ZeroLogon'},f.clock.now);
    assert.equal(f.state.cracking.alpha,undefined);
});

test('darknet crawler heartbeat clears a stale deployment blocker', () => {
    const manager = loadScript('darknet-manager.js', new Clock());
    const state={servers:{alpha:{blocker:'agent-ram',freeRam:0.1,requiredRam:15.9}},agents:{},stats:{caches:0,deployments:0,blocked:1,errors:0},last:''};
    manager.applyEvent(state,{kind:'agent',host:'alpha',pid:4,state:'running',at:3});
    assert.equal(state.servers.alpha.blocker,undefined);
    assert.equal(state.servers.alpha.requiredRam,undefined);
    assert.equal(state.servers.alpha.accessedAt,3);
});

test('darknet crawler keeps high-RAM optional APIs in isolated one-shot workers', () => {
    const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '../src');
    const crawler = fs.readFileSync(path.join(root, 'darknet-agent.js'), 'utf8');
    assert.match(crawler, /lib\/darknet-formulas\.js/);
    assert.doesNotMatch(crawler, /lib\/formulas\.js/);
    for (const api of ['setStasisLink', 'induceServerMigration', 'freezeServer', 'promoteStock', 'unleashStormSeed', 'stock.getSymbols', 'stock.getPosition']) {
        assert.doesNotMatch(crawler, new RegExp(`ns\\.(?:dnet\\.)?${api.replace('.', '\\.')}`), `${api} must not inflate crawler RAM`);
    }
    const workers = {
        'darknet-stasis.js': 'setStasisLink', 'darknet-migrate.js': 'induceServerMigration',
        'darknet-freeze.js': 'freezeServer', 'darknet-stock.js': 'promoteStock', 'darknet-storm.js': 'unleashStormSeed',
    };
    for (const [file, api] of Object.entries(workers)) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), new RegExp(api));
});

test('darknet neighbor visitor uses bounded concurrency without dropping work', async () => {
    const agent = loadScript('darknet-agent.js', new Clock());
    let active = 0, peak = 0;
    const pending = [];
    const run = agent.visitNeighbors(['a','b','c','d','e'], 2, async host => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => pending.push(() => { active--; resolve(host); }));
    });
    for (let completed = 0; completed < 5;) {
        await Promise.resolve();
        const release = pending.shift();
        if (release) { release(); completed++; }
    }
    await run;
    assert.equal(peak, 2);
    assert.equal(active, 0);
});

test('darknet configuration defaults to parallel cracking and scalable child agents', () => {
    const cfg = loadScript('darknet-agent.js', new Clock()).parseConfig('{}');
    assert.equal(cfg.concurrency, 4);
    assert.equal(cfg.agentThreads, 4);
    assert.equal(cfg.version, 7);
});

test('darknet 16 GB bootstrap reserves bounded dynamic RAM before importing the crawler', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/darknet-bootstrap.js'),'utf8');
    assert.match(source,/CRAWLER_RAM = 15\.9/);
    assert.match(source,/ns\.ramOverride\(CRAWLER_RAM\)/);
    assert.match(source,/ns\.dynamicImport\(AGENT\)/);
});

function coordinationFixture() {
    const clock = new Clock(), manager = loadScript('darknet-manager.js',clock);
    const agent = loadScript('darknet-agent.js',clock), protocol = loadScript('lib/darknet-coordination.js',clock);
    const input = new Port(), status = new Port(), files = new Map(), alive = new Set([2,3,4]);
    const cfg = agent.parseConfig('{}'), calls = [], sessions = new Set(), roots = new Set();
    const f = {clock,manager,agent,protocol,input,status,files,alive,cfg,calls,sessions,roots,state:manager.emptyState('epoch')};
    f.ns = {isRunning:pid=>alive.has(pid),kill:pid=>alive.delete(pid),serverExists:()=>true,
        ps:()=>[...alive].map(pid=>({pid,filename:'darknet-agent.js',args:['{"version":7}']})),
        write:async (file,data)=>files.set(file,data),read:file=>files.get(file)};
    f.publish = () => { status.clear(); status.write({type:'darknet-status',generatedAt:clock.now,coordination:manager.coordinationState(f.state)}); };
    f.tick = async () => { await manager.drainEvents(f.ns,f.state,input,clock.now); f.publish(); };
    f.acquire = (host,pid=2,seq=1) => {
        manager.handleRequest(f.state,{kind:'acquire',client:String(pid),seq,pid,host,from:'darkweb',at:clock.now,modelId:'ZeroLogon'},clock.now);
        return f.state.replies[String(pid)].result;
    };
    f.worker = pid => {
        const ns = {pid,getHostname:()=>`worker-${pid}`,getPortHandle:port=>port===cfg.eventPort?input:status,
            sleep:ms=>clock.sleep(ms),asleep:ms=>clock.sleep(ms),ls:()=>[],dnet:{probe:()=>[],
                connectToSession:(host,password)=>{
                    calls.push(['connect',pid,host,password]);
                    const success = roots.has(host) && password === '';
                    if(success) sessions.add(`${pid}:${host}`);
                    return {success,code:success?200:401};
                },
                authenticate:async (host,password)=>{
                    calls.push(['authenticate',pid,host,password]);
                    roots.add(host); sessions.add(`${pid}:${host}`);
                    return {success:true,code:200};
                }
            }};
        return {ns,client:protocol.createCoordinator(ns,cfg)};
    };
    f.settle = async promise => {
        let done=false,value,error;
        promise.then(v=>{done=true;value=v},e=>{done=true;error=e});
        for(let i=0;i<100&&!done;i++) { await clock.runUntil(clock.now+500); await f.tick(); }
        assert.equal(done,true,'request should settle through real client and manager');
        if(error) throw error;
        return value;
    };
    f.publish();
    return f;
}

test('credential is saved before acknowledgement and reused by a second PID without solving', async () => {
    const f=coordinationFixture(), first=f.worker(2), second=f.worker(3), host='neon::systems';
    const details={modelId:'ZeroLogon',hasSession:false};
    const result=await f.settle(f.agent.establishSession(first.ns,f.cfg,host,details,null,first.client));
    assert.equal(result.ok,true);
    assert.equal(JSON.parse(f.files.get('data/darknet-state.json')).servers[host].password,'');
    assert.equal(f.state.cracking[host],undefined);
    assert.equal(f.status.peek().coordination.credentials[host],'');
    assert.equal((await f.agent.establishSession(second.ns,f.cfg,host,details,null,second.client)).ok,true);
    assert.equal(f.calls.filter(c=>c[0]==='authenticate').length,1);
    assert.ok(f.sessions.has(`2:${host}`)); assert.ok(f.sessions.has(`3:${host}`));
});

test('same target has one owner while separate targets can be cracked concurrently', () => {
    const f=coordinationFixture(), first=f.acquire('x',2), denied=f.acquire('x',3), other=f.acquire('y',4);
    assert.ok(first.token); assert.equal(denied.reason,'leased'); assert.ok(other.token);
    assert.equal(Object.keys(f.state.cracking).length,2);
    assert.equal(f.state.cracking.x.pid,2);
    assert.equal(f.state.stats.leaseContentions,1);
});

test('dead, heartbeat-expired, and progress-stalled leases recover after fencing the PID', () => {
    for(const mode of ['dead','expired','stalled']) {
        const f=coordinationFixture(); f.acquire('x',2); f.acquire('y',2,2);
        if(mode==='dead') f.alive.delete(2);
        else if(mode==='expired') f.clock.now+=60001;
        else { f.state.cracking.x.progressTimeout=100; f.clock.now+=101; }
        f.manager.recoverLeases(f.ns,f.state,f.clock.now);
        assert.equal(f.alive.has(2),false,mode);
        assert.equal(Object.keys(f.state.cracking).length,0,mode);
        assert.ok(f.acquire('x',3).token,mode);
    }
});

test('failed PID fencing cannot free a lease and start a competing solver', () => {
    const f=coordinationFixture(); f.acquire('x'); f.clock.now+=60001;
    f.ns.kill=()=>false;
    f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(f.acquire('x',3).reason,'leased');
});

test('blocked cracks release ownership and apply a global retry delay', () => {
    const f=coordinationFixture(), grant=f.acquire('x');
    f.manager.handleRequest(f.state,{client:'2',seq:2,pid:2,kind:'blocked',host:'x',token:grant.token,reason:'feedback-unavailable',retryDelay:5000},f.clock.now);
    assert.equal(f.state.cracking.x,undefined);
    assert.equal(f.acquire('x',3).reason,'retry-backoff');
    f.clock.now+=5001;
    assert.ok(f.acquire('x',3,2).token);
});

test('late completion or unrelated deployment cannot clear a replacement lease', () => {
    const f=coordinationFixture(), old=f.acquire('x');
    f.alive.delete(2); f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    const replacement=f.acquire('x',3);
    f.manager.handleRequest(f.state,{client:'2',seq:2,pid:2,kind:'credential',host:'x',token:old.token,password:'stale'},f.clock.now);
    f.manager.applyEvent(f.state,{kind:'deployed',pid:4,host:'x',at:f.clock.now});
    assert.equal(f.state.cracking.x.token,replacement.token);
    assert.equal(f.state.servers.x.password,undefined);
});

test('dead agents disappear immediately from lease telemetry and bounded reply storage', () => {
    const f=coordinationFixture(); f.acquire('x');
    f.manager.applyPulse(f.state,{pid:2,from:'neon::systems',at:f.clock.now,leases:[]},f.clock.now);
    f.alive.delete(2); f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(Object.keys(f.state.agents).length,0);
    assert.equal(Object.keys(f.state.cracking).length,0);
    f.clock.now+=60001; f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(Object.keys(f.state.replies).length,0);
});

test('heartbeats preserve real long work but cannot revive an expired lease', () => {
    const f=coordinationFixture(), grant=f.acquire('x');
    f.clock.now+=50000;
    const pulse={pid:2,from:'darkweb',at:f.clock.now,leases:[{host:'x',token:grant.token,progressAt:f.clock.now}]};
    f.manager.applyPulse(f.state,pulse,f.clock.now);
    f.clock.now+=50000; f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.ok(f.state.cracking.x);
    f.clock.now+=10001;
    f.manager.applyPulse(f.state,{...pulse,at:f.clock.now},f.clock.now);
    f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(f.state.cracking.x,undefined);
});

test('full request port retries, manager restart preserves ownership, and duplicate deliveries count once', async () => {
    const f=coordinationFixture(), worker=f.worker(2);
    f.input.limit=1; f.input.write({type:'unrelated'});
    const grant=await f.settle(worker.client.acquire('x',{modelId:'ZeroLogon'},null));
    assert.ok(grant.token);
    f.state=f.manager.loadState(f.ns); f.publish();
    assert.equal(f.acquire('x',3).reason,'leased');
    const event={client:'cache-test',seq:1,pid:2,from:'darkweb',kind:'cache',host:'x',at:f.clock.now,type:'darknet-request'};
    f.input.write(event); await f.tick();
    f.state=f.manager.loadState(f.ns);
    f.input.write(event); await f.tick();
    assert.equal(f.state.stats.caches,1);
    await f.settle(worker.client.finish({kind:'credential',host:'x',token:grant.token,password:'secret'}));
    assert.equal(JSON.parse(f.files.get('data/darknet-state.json')).servers.x.password,'secret');
});

test('manager publishes no grants until the durable write completes, and snapshots do not mutate', async () => {
    const f=coordinationFixture(); let saved;
    f.ns.write=()=>new Promise(resolve=>{saved=resolve});
    f.input.write({type:'darknet-request',kind:'acquire',client:'2',seq:1,pid:2,host:'x',at:f.clock.now});
    const pass=f.tick(); await Promise.resolve();
    assert.equal(f.status.peek().coordination.leases.x,undefined);
    saved(); await pass;
    const snapshot=f.status.peek();
    assert.ok(snapshot.coordination.leases.x.token);
    f.state.cracking.x.expiresAt++;
    assert.notEqual(snapshot.coordination.leases.x.expiresAt,f.state.cracking.x.expiresAt);
});

test('credentials wait through a coordinator outage and no API starts on stale permission', async () => {
    const f=coordinationFixture(), worker=f.worker(2);
    const grant=await f.settle(worker.client.acquire('x',{modelId:'ZeroLogon'},null));
    f.clock.now+=16000;
    assert.throws(()=>worker.client.progress('x',grant.token),/lease lost/);
    const done=worker.client.finish({kind:'credential',host:'x',token:grant.token,password:''});
    await f.clock.runUntil(f.clock.now+10000);
    assert.equal(f.state.servers.x.password,undefined);
    await f.settle(done);
    assert.equal(f.state.servers.x.password,'');
});

test('host-aware clues preserve punctuation, quoted spaces and empty passwords', () => {
    const {passwordFromClue:parse}=loadScript('darknet-agent.js',new Clock());
    for(const host of ['neon::systems','hacker;tech','net_genesis','a-b','x.y+[z]']) {
        assert.equal(parse(`${host}:pa:ss;word`,host),'pa:ss;word');
        assert.equal(parse(`Server: ${host} Password: "Republic of Cyprus"`,host),'Republic of Cyprus');
        assert.equal(parse(`Server: ${host} Password: ""`,host),'');
        assert.equal(parse(`${host}:wrong`,'different'),null);
    }
    assert.equal(parse('neon::systems:secret','systems'),null);
    assert.equal(parse('Remember this password: Republic of Cyprus','x',true),'Republic of Cyprus');
    assert.equal(parse('Server: other Password: "wrong"','x',true),null);
});

test('home crawler threading respects actual RAM, caps, reserves, and low-RAM launch failures', () => {
    const manager=loadScript('darknet-manager.js',new Clock());
    for(const [free,expected] of [[0,0],[16,0],[23.9,1],[32,1],[64,3],[128,4]])
        assert.equal(manager.homeAgentThreads(free,15.9,4,8),expected,`free=${free}`);
    const launches=[],ns={ps:()=>[],getScriptRam:()=>15.9,getServerMaxRam:()=>64,getServerUsedRam:()=>24,
        run:(...args)=>{launches.push(args);return 42}};
    assert.equal(manager.ensureHomeAgent(ns,{agentThreads:4,homeReserve:8,port:10}).ok,true);
    assert.equal(launches[0][1].threads,2);
    assert.equal(JSON.parse(launches[0][2]).coordinationPort,10);
});

test('Labyrinth repeats movement commands and returns the actual session password', async () => {
    let east=0, attempted='', logs=[];
    const ns={dnet:{authenticate:async (_host,attempt)=>{
        attempted=attempt;
        if(attempt==='go east') east++;
        if(east===2) return {success:true,code:200,data:'maze-password'};
        logs=[JSON.stringify({passwordAttempted:attempt,message:`at ${east*2},0`,data:'###\n#  \n###'})];
        return {success:false,code:401};
    },heartbleed:async ()=>({success:true,logs})}};
    const result=await solvers.solveServer(ns,'lab',{modelId:'(The Labyrinth)'});
    assert.equal(result.success,true); assert.equal(result.password,'maze-password');
    assert.equal(east,2); assert.equal(attempted,'go east'); assert.equal(result.attempts,3);
});

test('dynamic NIL and timing responses reuse earlier feedback without duplicate authentication', async () => {
    for(const modelId of ['NIL','2G_cellular']) {
        const password='120', attempted=new Set(); let log;
        const ns={dnet:{authenticate:async (_host,attempt)=>{
            assert.ok(!attempted.has(attempt),`repeated ${attempt}`); attempted.add(attempt);
            if(attempt===password) return {success:true,code:200};
            const mismatch=[...password].findIndex((c,i)=>c!==attempt[i]);
            log={passwordAttempted:attempt,message:`Found a mismatch (${mismatch})`,data:[...attempt].map((c,i)=>c===password[i]?'yes':"yesn't").join(',')};
            return {success:false,code:401};
        },heartbleed:async ()=>({success:true,logs:[log]})}};
        const result=await solvers.solveServer(ns,'x',{modelId,passwordLength:3,passwordFormat:'numeric'});
        assert.equal(result.password,password,modelId);
    }
});

test('timed-out credentials remain queued beyond lease expiry and publish before recovery', async () => {
    const f=coordinationFixture(), worker=f.worker(2);
    const grant=await f.settle(worker.client.acquire('x',{modelId:'ZeroLogon'},null));
    const result=worker.client.finish({kind:'credential',host:'x',token:grant.token,password:'saved'});
    await f.clock.runUntil(f.clock.now+90000);
    await f.settle(result);
    assert.equal(f.state.servers.x.password,'saved');
    assert.equal(f.alive.has(2),true);
});

test('credential 408/offline failures preserve the registry, while 401 invalidates only the rejected value', async () => {
    for(const code of [408,404,401]) {
        const f=coordinationFixture(), worker=f.worker(2);
        f.state.servers.x={password:'obsolete'}; f.publish();
        worker.ns.dnet.authenticate=async ()=>({success:false,code});
        const result=await f.settle(f.agent.establishSession(worker.ns,f.cfg,'x',{modelId:'ZeroLogon',hasSession:false},null,worker.client));
        assert.equal(result.ok,false);
        assert.equal(f.state.cracking.x,undefined);
        assert.equal(f.state.servers.x.password,code===401?undefined:'obsolete');
    }
});

test('saved ownership never kills an unrelated process that reused the PID', () => {
    const f=coordinationFixture(); f.acquire('x');
    f.ns.ps=()=>{throw Error('process query failed')};
    f.manager.recoverLeases(f.ns,f.state,f.clock.now+60001);
    assert.equal(f.state.cracking.x.pid,2,'uncertain live ownership must stay exclusive');
    f.ns.ps=()=>[{pid:2,filename:'manual-script.js',args:[]}];
    f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(f.alive.has(2),true);
    assert.equal(f.state.cracking.x,undefined);
});

test('old credentials are retained for existing servers and removed only for deleted hosts', () => {
    const f=coordinationFixture();
    f.state.servers={kept:{password:'a',lastSeen:f.clock.now-3600001},gone:{password:'b',lastSeen:f.clock.now-3600001}};
    f.ns.serverExists=host=>host==='kept';
    f.manager.recoverLeases(f.ns,f.state,f.clock.now);
    assert.equal(f.state.servers.kept.password,'a'); assert.equal(f.state.servers.gone,undefined);
});

test('manager main publishes live lease telemetry for both navigator unlock and BN15', async () => {
    for(const node of [1,15]) {
        const f=coordinationFixture(), reset={currentNode:node,lastNodeReset:1,lastAugReset:2};
        f.state.resetEpoch=`${node}:1:2`;
        f.state.servers.rooted={password:'shared',depth:8};
        f.acquire('cracking',2); f.manager.applyPulse(f.state,{pid:2,from:'home',at:f.clock.now},f.clock.now);
        await f.manager.saveState(f.ns,f.state);
        const ns={...f.ns,pid:1,flags:pairs=>Object.fromEntries(pairs),disableLog(){},getHostname:()=> 'home',
            getResetInfo:()=>reset,fileExists:()=>node===1,getPortHandle:port=>port===9?f.input:f.status,
            dnet:{getStasisLinkedServers:()=>[],getDarknetInstability:()=>({})},sleep:async ()=>{throw Error('test-stop')}};
        await assert.rejects(f.manager.main(ns),/test-stop/);
        const status=f.status.peek();
        assert.equal(status.state,'ACTIVE'); assert.equal(status.credentials,1);
        assert.equal(status.activeAgents,1); assert.equal(status.cracking.length,1);
        assert.equal(status.cracking[0].pid,2); assert.equal(status.deepest,8);
    }
});

test('Darknet displays credential counts and lease duration, never a global session count', () => {
    const f=coordinationFixture(), lines=[], status={type:'darknet-status',unlocked:true,state:'ACTIVE',credentials:8,known:14,
        activeAgents:7,generatedAt:f.clock.now,cracking:[{host:'neon::systems',modelId:'NIL',pid:2,since:f.clock.now-12000}],deepest:9};
    const supervisor=loadScript('supervisor.js',f.clock);
    supervisor.renderAutomationSummary({print:line=>lines.push(String(line))},{
        cfg:{darknet:true,utilityJobs:[]},darknet:status,services:[],stockAccess:{ok:false,missing:[]}});
    assert.match(lines.join('\n'),/8 creds \/ 14 known/); assert.match(lines.join('\n'),/1 cracking/);
    assert.doesNotMatch(lines.join('\n'),/authenticated/);
    f.status.clear(); f.status.write(status);
    const report=loadScript('darknet-status.js',f.clock).report({ps:()=>[{filename:'darknet-manager.js',pid:1}],getPortHandle:()=>f.status,read:()=>''});
    assert.match(report.join('\n'),/neon::systems \(NIL, PID 2, 12s\)/);
    assert.match(report.join('\n'),/deepest 9/);
});

// Match upstream checkEnvFlags/netscriptDelay: even synchronous NS calls kill
// a busy PID. Only asleep and methods on already-acquired port handles are safe.
function guardedNetscript(api, violations, path = '', env = {running:''}) {
    return Object.fromEntries(Object.entries(api).map(([key, value]) => {
        const name = path + key;
        if (typeof value === 'object' && value !== null && !Array.isArray(value))
            return [key, guardedNetscript(value, violations, name + '.', env)];
        if (typeof value !== 'function') return [key, value];
        return [key, (...args) => {
            if (env.running && name !== 'asleep') {
                const message = `CONCURRENCY: ${env.running} overlaps ${name}`;
                violations.push(message);
                throw Error(message);
            }
            const result = value(...args);
            if (!['sleep','dnet.authenticate','dnet.heartbleed','dnet.memoryReallocation'].includes(name)) return result;
            env.running = name;
            return Promise.resolve(result).finally(() => { env.running = ''; });
        }];
    }));
}

test('runtime guard rejects the old heartbeat sleep and calls made during authentication', async () => {
    const clock = new Clock(), violations = [];
    const ns = guardedNetscript({sleep:ms=>clock.sleep(ms),asleep:ms=>clock.sleep(ms),getHostname:()=> 'home',
        getPortHandle:()=>new Port(),dnet:{authenticate:()=>clock.sleep(1000),probe:()=>[]}},violations);
    const sleeping = ns.sleep(5000);
    assert.throws(()=>ns.dnet.probe(),/CONCURRENCY/);
    await clock.runUntil(clock.now+5000); await sleeping;
    const authenticating = ns.dnet.authenticate();
    assert.throws(()=>ns.getPortHandle(),/CONCURRENCY/);
    assert.throws(()=>ns.getHostname(),/CONCURRENCY/);
    const asleep = ns.asleep(500);
    await clock.runUntil(clock.now+1000); await Promise.all([authenticating,asleep]);
    assert.equal(violations.length,3);
});

test('real crawler loops survive long authentication, interleave neighbors, deploy, and keep separate PIDs parallel', async () => {
    const f = coordinationFixture(), violations = [], failures = [], calls = [], deployed = new Map(), blocked = new Map();
    const attempts = new Map(), logs = new Map();
    let activeCalls = 0, peakCalls = 0, peakLeases = 0;
    for (const pid of [2,3]) {
        const hostname = pid === 2 ? 'home' : 'darkweb';
        const neighbors = pid === 2 ? ['a','b','c'] : ['other'];
        for (const host of neighbors) blocked.set(host,1);
        const ns = guardedNetscript({pid,args:[JSON.stringify({concurrency:2,phish:false})],disableLog(){},
            getHostname:()=>hostname,getPortHandle:port=>port===f.cfg.eventPort?f.input:f.status,
            sleep:ms=>f.clock.sleep(ms),asleep:ms=>f.clock.sleep(ms),ls:()=>[],fileExists:()=>false,
            getRunningScript:()=>({threads:4}),getServerMaxRam:()=>16,getServerUsedRam:()=>0,getScriptRam:()=>15.9,
            ps:host=>deployed.has(host)?[{pid:deployed.get(host),filename:'darknet-bootstrap.js',args:['{"version":7}']}]:[],
            scp:async ()=>true,exec:(_script,host)=>{const child=100+deployed.size; deployed.set(host,child);return child;},
            dnet:{probe:()=>neighbors,getDepth:()=>1,
                getServerDetails:host=>({modelId:'AccountsManager_4.2',passwordLength:1,passwordFormat:'numeric',
                    isOnline:true,isConnectedToCurrentServer:true,hasSession:f.sessions.has(`${pid}:${host}`),depth:1}),
                connectToSession:(host,password)=>({success:f.sessions.has(`${pid}:${host}`)&&password==='3'}),
                authenticate:async (host,password)=>{
                    calls.push([pid,host,password]); activeCalls++; peakCalls=Math.max(peakCalls,activeCalls);
                    const count=(attempts.get(host)||0)+1; attempts.set(host,count);
                    await f.clock.sleep(host==='a'&&count===1?65000:1000); activeCalls--;
                    const success=password==='3';
                    logs.set(host,[{passwordAttempted:password,data:Number(password)>3?'Lower':'Higher'}]);
                    if(success) f.sessions.add(`${pid}:${host}`);
                    return {success,code:success?200:401};
                },
                heartbleed:async host=>{await f.clock.sleep(1000);return {success:true,logs:logs.get(host)};},
                getBlockedRam:host=>blocked.get(host),
                memoryReallocation:async host=>{await f.clock.sleep(1500);blocked.set(host,0);return {success:true};},
            }},violations);
        f.agent.main(ns).catch(error=>failures.push(error));
    }
    for(let step=0;step<360;step++) {
        await f.clock.runUntil(f.clock.now+500); await f.tick();
        peakLeases=Math.max(peakLeases,Object.keys(f.state.cracking).length);
    }
    assert.deepEqual(violations,[]);
    assert.deepEqual(failures,[]);
    assert.equal(deployed.size,4);
    assert.equal(Object.values(f.state.servers).filter(server=>server.password==='3').length,4);
    assert.equal(peakCalls,2,'different PIDs must authenticate simultaneously');
    assert.ok(peakLeases>=3,'bounded neighbor workflows should remain in flight within each PID');
    const ownCalls=calls.filter(([pid])=>pid===2).map(([,host])=>host);
    assert.ok(ownCalls.indexOf('b')<ownCalls.lastIndexOf('a'),'another neighbor progresses between solver attempts');
    assert.equal(Object.keys(f.state.cracking).length,0);
    assert.equal(f.state.stats.leaseRecoveries||0,0,'heartbeats must protect the 65-second API call');
    assert.equal(f.state.stats.errors,0);
    assert.equal(Object.keys(f.state.agents).length,2);
    assert.ok(Object.values(f.state.agents).every(agent=>f.clock.now-agent.at<6000));
});

test('failed neighbor visits drain pending API work before crawl resumes', async () => {
    const agent=loadScript('darknet-agent.js',new Clock());
    let release,finished=false;
    const result=agent.visitNeighbors(['bad','slow'],2,host=>host==='bad'?Promise.reject(Error('failed')):
        new Promise(resolve=>{release=resolve}));
    result.catch(()=>{finished=true});
    for(let i=0;i<10;i++) await Promise.resolve();
    assert.equal(finished,false);
    release(); await assert.rejects(result,/failed/);
});

test('home health requires a fresh heartbeat and exposes restart loops and hung crawlers', () => {
    const f=coordinationFixture(),watch={pid:0,since:0,exits:0,lastExit:0};
    const health=(pid=2)=>f.manager.homeAgentHealth(f.ns,f.state,{ok:true,pid},watch,f.clock.now);
    assert.equal(health().state,'STARTING');
    f.clock.now+=15000; assert.equal(health().state,'BLOCKED');
    f.manager.applyPulse(f.state,{pid:2,from:'home',at:f.clock.now},f.clock.now);
    assert.equal(health().state,'ACTIVE');
    f.alive.delete(2);
    assert.equal(health(3).state,'BLOCKED'); assert.equal(watch.exits,1);
    f.manager.applyPulse(f.state,{pid:3,from:'home',at:f.clock.now},f.clock.now);
    assert.equal(health(3).state,'ACTIVE');
    f.clock.now+=15000; assert.equal(health(3).state,'BLOCKED');
});

test('compact dashboard cannot label zero agents as OK, including legacy ACTIVE snapshots', () => {
    const f=coordinationFixture(),supervisor=loadScript('supervisor.js',f.clock);
    for(const state of ['ACTIVE','STARTING','BLOCKED']) {
        const lines=[];
        supervisor.renderAutomationSummary({print:line=>lines.push(String(line))},{
            cfg:{darknet:true,utilityJobs:[]},darknet:{unlocked:true,state,activeAgents:0},services:[],stockAccess:{ok:false,missing:[]}});
        const row=lines.find(line=>line.includes('8 Darknet'));
        assert.doesNotMatch(row,/\[OK\]/);
        assert.match(row,state==='STARTING'?/\[WAIT\]/:/\[BLOCKED\]/);
    }
});
