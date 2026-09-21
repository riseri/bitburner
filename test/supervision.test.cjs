const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture(name = 'fleet-manager.js', args = [], heartbeat = 'fleet-status') {
    const clock = new Clock(), api = loadScript('lib/service-lifecycle.js', clock);
    const processes = new Map(), port = new Port(), launched = [], killed = [];
    let nextPid = 20;
    const ns = { ps: () => [...processes.values()], fileExists: () => true,
        getPortHandle: () => port, isRunning: pid => processes.has(pid),
        run: (filename, threads, ...args) => {
            const pid = nextPid++; launched.push({filename, threads, args, pid});
            processes.set(pid, {filename, threads, args, pid}); return pid;
        },
        kill: pid => { killed.push(pid); return processes.delete(pid); },
        scriptKill: () => { throw new Error('broad kills prohibited'); },
    };
    const service = api.createService(name, args, heartbeat, 19);
    const tick = delta => { clock.now += delta || 0; return api.tickService(ns, service); };
    return { clock, api, ns, processes, port, launched, killed, service, tick };
}

test('new service receives startup grace before missing heartbeats can trigger recovery', () => {
    const f = fixture(); f.tick();
    assert.equal(f.service.state, 'STARTING');
    for (let i = 0; i < 14; i++) f.tick(5000);
    assert.equal(f.killed.length, 0);
    f.tick(5000); assert.equal(f.killed.length, 1);
    assert.equal(f.service.state, 'BACKOFF');
    f.tick(4999); assert.equal(f.launched.length, 1);
    f.tick(1); assert.equal(f.launched.length, 2);
});

test('adopted cloud flags and thread count survive a process crash', () => {
    const f = fixture();
    const args = ['--cloud', false, '--cloud-cash-floor', 1e9, '--cloud-max-action', .07, '--port', 12];
    f.processes.set(7, {pid:7, filename:'fleet-manager.js', threads:2, args});
    f.tick(); assert.equal(f.launched.length, 0); assert.equal(f.service.port, 12);
    f.processes.delete(7); f.tick(1); f.tick(5000);
    assert.deepEqual(f.launched[0].args, args); assert.equal(f.launched[0].threads, 2);
});

test('backoff caps at five minutes and does not retry each supervisor tick', () => {
    const f = fixture(); let attempts = 0;
    f.ns.run = () => { attempts++; return 0; };
    for (let failure = 0; failure < 12; failure++) {
        f.tick(); const expected = Math.min(300000, 5000 * 2 ** failure);
        assert.equal(f.service.nextStartAt - f.clock.now, expected);
        f.tick(expected - 1); assert.equal(attempts, failure + 1);
        f.clock.now++;
    }
});

test('healthy daemon is never killed for stale display logs; exited daemon recovers once', () => {
    const f = fixture('daemon.js', ['--background-prep', false, '--gap', 100], '');
    f.tick(); f.tick(900000);
    assert.equal(f.service.state, 'RUNNING'); assert.equal(f.killed.length, 0);
    f.processes.clear(); f.tick(); f.tick(5000); f.tick();
    assert.equal(f.launched.length, 2); assert.equal(f.processes.size, 1);
    assert.deepEqual(f.launched[1].args, f.launched[0].args);
});

test('old producer heartbeat cannot authenticate a new process', () => {
    const f = fixture(); f.tick();
    f.port.write({type:'fleet-status', producerPid:999, generatedAt:f.clock.now});
    f.tick(1); assert.equal(f.service.state, 'STARTING');
    f.port.clear(); f.port.write({type:'fleet-status', producerPid:f.service.pid, generatedAt:f.clock.now});
    f.tick(); assert.equal(f.service.state, 'RUNNING');
});

test('single late heartbeat is not an immediate kill; fresh progress clears suspicion', () => {
    const f = fixture(); f.tick();
    f.port.write({type:'fleet-status', producerPid:f.service.pid, generatedAt:f.clock.now});
    f.tick(); f.tick(61000); assert.equal(f.killed.length, 0);
    f.port.clear(); f.port.write({type:'fleet-status', producerPid:f.service.pid, generatedAt:f.clock.now});
    f.tick(1000); assert.equal(f.service.state, 'RUNNING'); assert.equal(f.killed.length, 0);
});

test('failed PID cancellation never spawns another service', () => {
    const f = fixture(); f.tick(); f.ns.kill = () => false;
    f.tick(60000); f.tick(15000); f.tick(30000);
    assert.equal(f.launched.length, 1); assert.equal(f.processes.size, 1);
    assert.match(f.service.lastEvent, /Could not stop/);
});

test('duplicate manually started services cause a visible conflict, not broad cleanup', () => {
    const f = fixture();
    for (const pid of [1, 2]) f.processes.set(pid, {pid, filename:'fleet-manager.js', args:[], threads:1});
    f.tick(); assert.equal(f.service.state, 'CONFLICT');
    assert.equal(f.launched.length, 0); assert.equal(f.killed.length, 0);
});

test('custom daemon bootstrap leaves an existing fleet process and its flags untouched', () => {
    const clock = new Clock(), api = loadScript('daemon.js', clock);
    api.startFleetManager({fileExists:()=>true, ps:()=>[{pid:5, filename:'fleet-manager.js', args:['--cloud', false]}],
        scriptKill:()=>assert.fail('must not erase fleet configuration'), run:()=>assert.fail('must not launch another fleet')}, {});
});

test('second supervisor exits before starting services', async () => {
    const clock = new Clock(), api = loadScript('supervisor.js', clock), lines = [];
    await api.main({pid:2, flags:pairs=>Object.fromEntries(pairs), disableLog(){}, getHostname:()=> 'home',
        ps:()=>[{filename:'supervisor.js',pid:1}], tprint:value=>lines.push(value), run:()=>assert.fail('no duplicate manager')});
    assert.match(lines[0], /one supervisor/);
});

test('contract manager emits heartbeats during a scan longer than the old stale timeout', async () => {
    const clock = new Clock(), status = new Port(), fleet = new Port();
    fleet.write({network:{servers:['home']}});
    const api = loadScript('contract-manager.js', clock, {SOLVERS:{}, ...loadScript('lib/contract-safety.js', clock)});
    const publications = []; const write = status.write.bind(status);
    status.write = value => { publications.push(value.generatedAt); write(value); };
    api.main({pid:8, flags:pairs=>Object.fromEntries(pairs), disableLog(){}, fileExists:()=>false,
        getHostname:()=> 'home', ps:()=>[], read:()=> 'test solver source', clearLog(){}, print(){},
        getPortHandle:n=>n===18?status:fleet, ls:()=>Array.from({length:100},(_,i)=>`${i}.cct`),
        codingcontract:{getContractType:()=> 'not implemented'}, sleep:()=>clock.sleep(1000)});
    await clock.runUntil(clock.now + 40000);
    assert.ok(publications.length >= 8); assert.ok(clock.now - status.peek().generatedAt <= 5000);
    assert.equal(status.peek().producerPid, 8); assert.equal(status.peek().scans, 1);
});

test('fleet manager publishes while the initial network scan is still in progress', async () => {
    const clock = new Clock(), status = new Port(), api = loadScript('fleet-manager.js', clock);
    api.main({pid:9, flags:pairs=>Object.fromEntries(pairs), disableLog(){}, fileExists:()=>true,
        getPortHandle:()=>status, scan:host=>host==='home'?['n0']:[`n${Number(host.slice(1))+1}`], sleep:()=>clock.sleep(1000)});
    await clock.runUntil(clock.now + 20000);
    assert.ok(clock.now - status.peek().generatedAt <= 5000);
    assert.equal(status.peek().producerPid, 9);
});

test('thrown launch failures enter backoff without crashing the caller', () => {
    const f=fixture();f.ns.run=()=>{throw new Error('import unavailable');};
    assert.doesNotThrow(()=>f.tick());assert.equal(f.service.state,'BACKOFF');assert.match(f.service.lastEvent,/import unavailable/);
});

test('custom service heartbeat interval is respected independently of scan cadence', () => {
    const f=fixture();f.tick();
    f.port.write({type:'fleet-status',producerPid:f.service.pid,generatedAt:f.clock.now,heartbeatIntervalMs:30000});
    f.tick(60000);assert.equal(f.service.state,'RUNNING');assert.equal(f.killed.length,0);
});

test('informational status channels never restart a live service for stale status', () => {
    const f=fixture('go-bot.js',['--port',12],'go-status');
    f.service.heartbeatRequired=false;
    f.tick();
    f.port.write({type:'go-status',producerPid:f.service.pid,generatedAt:f.clock.now,state:'WAITING FOR OPPONENT'});
    f.tick(900000);
    assert.equal(f.service.state,'RUNNING');
    assert.equal(f.killed.length,0);
});



test('new dependent managers and daemon follow an adopted custom fleet port', () => {
    const api=loadScript('supervisor.js',new Clock());
    const services=api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',8,'--cloud',false]}]},
        {contracts:true,progression:true},['--background-prep',false]);
    for(const name of ['daemon.js','contract-manager.js','progression-manager.js']) {
        const args=services.find(s=>s.name===name).args;
        assert.equal(args[args.indexOf('--fleet-port')+1],8,name);
    }
});

test('supervisor wires stock trader to the dedicated status port', () => {
    const api=loadScript('supervisor.js',new Clock());
    const services=api.createManagedServices({ps:()=>[]},
        {contracts:false,progression:false,stocks:true,stockCashReserve:0.20},[]);
    const stock=services.find(s=>s.name==='stock-trader.js');
    assert.ok(stock);
    assert.equal(stock.port,13);
    assert.equal(stock.heartbeatType,'stock-status');
    assert.equal(stock.args[stock.args.indexOf('--cash-reserve')+1],0.20);
    const fleet=services.find(s=>s.name==='fleet-manager.js');
    assert.equal(fleet.args[fleet.args.indexOf('--stock-port')+1],13);
});

test('supervisor makes realized stock profit and per-trade profit explicit', () => {
    const api=loadScript('supervisor.js',new Clock()), logs=[];
    const ns={print:value=>logs.push(String(value))};
    const stocks={state:'ACTIVE',equity:1.2e12,exposure:4e11,cash:8e11,reserveFloor:2e11,
        openPnl:12e6,realized:42e6,lastTradePnl:9e6,avgTradePnl:7e6,
        winningTrades:5,losingTrades:1,buys:8,sells:6,fees:1.4e6,positions:2,last:'SELL AAA'};
    const cfg={stocks:true,contracts:false,progression:false,go:false,dashboardDetails:true};
    api.renderAutomationSummary(ns,{cfg,stocks,contracts:null,progression:null,go:null,
        actions:null,services:[],stockAccess:{ok:true,missing:[]}});
    let text=logs.join('\n');
    assert.match(text,/Stocks\s+\[OK\] session \+\$42\.00m net/);
    assert.match(text,/avg \+\$7\.00m per trade/);

    logs.length=0;
    api.renderStocks(ns,stocks,cfg,{ok:true,missing:[]});
    text=logs.join('\n');
    assert.match(text,/Profit total\s+\+\$42\.00m realized net this session/);
    assert.match(text,/Per trade\s+avg \+\$7\.00m \| last \+\$9\.00m \| 5W\/1L/);
});

test('compact automation dashboard follows the service admission priority', () => {
    const api=loadScript('supervisor.js',new Clock()),logs=[];
    api.renderAutomationSummary({print:value=>logs.push(String(value))},{
        cfg:{progression:false,contracts:false,augmentationActions:false,stocks:false,go:false,darknet:false,
            diagnostics:false,augmentations:false,utilityJobs:[]},
        daemon:null,fleet:null,stocks:null,contracts:null,progression:null,go:null,augmentation:null,darknet:null,
        actions:null,services:[],stockAccess:{ok:false,missing:[]},
    });
    const text=logs.join('\n');
    const labels=['1 Money engine','2 Fleet','3 Progression','4 Contracts','5 Aug loop','6 Stocks',
        '7 IPvGO','8 Darknet','9 Diagnostics','10 Aug plan'];
    for(let index=1;index<labels.length;index++) assert.ok(text.indexOf(labels[index-1])<text.indexOf(labels[index]));
});


test('supervisor manages exactly one Go bot on its informational status port', () => {
    const api=loadScript('supervisor.js',new Clock());
    const services=api.createManagedServices({ps:()=>[]},
        {contracts:false,progression:false,stocks:false,go:true},[]);
    const go=services.filter(s=>s.name==='go-bot.js');
    assert.equal(go.length,1);
    assert.equal(go[0].port,12);
    assert.equal(go[0].heartbeatType,'go-status');
    assert.equal(go[0].heartbeatRequired,false);
    assert.deepEqual(Array.from(go[0].args),['--port',12,'--takeover',true]);
	const manual=api.createManagedServices({ps:()=>[]},
		{contracts:false,progression:false,stocks:false,go:true,goTakeover:false},[])
		.find(s=>s.name==='go-bot.js');
	assert.equal(manual.args[manual.args.indexOf('--takeover')+1],false);
});

test('supervisor wires the opt-in augmentation loop and reset safety gates', () => {
    const api=loadScript('supervisor.js',new Clock());
    const services=api.createManagedServices({ps:()=>[]}, {
        contracts:false,progression:false,stocks:false,go:false,augmentationActions:true,
        augmentationFocus:'hacking',augmentationTarget:'',augmentationCashReserve:.15,
        augmentationJoinFactions:true,augmentationCityFaction:'Aevum',augmentationWork:true,
        augmentationDonate:true,augmentationPurchase:true,augmentationFocusWork:false,autoInstall:true,minInstall:7,
    },[]);
    const manager=services.find(s=>s.name==='augmentation-manager.js');
    assert.ok(manager); assert.equal(manager.port,11); assert.equal(manager.heartbeatType,'augmentation-status');
    assert.equal(manager.args[manager.args.indexOf('--city-faction')+1],'Aevum');
    assert.equal(manager.args[manager.args.indexOf('--auto-install')+1],true);
    assert.equal(manager.args[manager.args.indexOf('--min-install')+1],7);
});

test('supervisor profiles collapse common action flags while explicit overrides win', () => {
    const api=loadScript('supervisor.js',new Clock());
    const assist={profile:'assist','progression-actions':false,'augmentation-actions':false,'auto-install':true};
    api.applySupervisorProfile(assist,['--profile','assist']);
    assert.equal(assist['progression-actions'],true); assert.equal(assist['augmentation-actions'],true);
    assert.equal(assist['auto-install'],false);
    const handsOff={profile:'hands-off','progression-actions':false,'augmentation-actions':false,'auto-install':false,'go-takeover':false};
    api.applySupervisorProfile(handsOff,['--profile=hands-off','--auto-install',false,'--go-takeover=false']);
    assert.equal(handsOff['progression-actions'],true); assert.equal(handsOff['augmentation-actions'],true);
    assert.equal(handsOff['auto-install'],false);
	assert.equal(handsOff['go-takeover'],false);
});

test('supervisor takeover policy retries only the recoverable IPvGO ownership stop', () => {
    const clock=new Clock(),api=loadScript('supervisor.js',clock),status=new Port(),killed=[];
    const process={pid:42,filename:'go-bot.js',threads:1,args:['--port',12,'--takeover',false]};
    const service=api.createManagedServices({ps:()=>[process]},
        {contracts:false,progression:false,stocks:false,go:true,goTakeover:true},[])
        .find(item=>item.name==='go-bot.js');
    service.pid=42;service.args=[...process.args];
    const ns={ps:()=>[process],kill:pid=>{killed.push(pid);return true;},getPortHandle:()=>status};
    const recoverable={terminal:true,error:'Unowned or interrupted game found. Use --takeover true to finish it'};
    assert.equal(api.recoverableGoOwnershipStop(recoverable),true);
    assert.equal(api.prepareGoTakeoverRetry(ns,service,1234),true);
    assert.deepEqual(killed,[42]);
    assert.equal(service.args[service.args.indexOf('--takeover')+1],true);
    assert.equal(service.state,'STOPPED');
    assert.equal(api.recoverableGoOwnershipStop({terminal:true,error:'Go board changed outside this bot'}),false);
});

test('Go safety stops block automatic restart instead of replaying uncertain state', () => {
    const clock=new Clock(),api=loadScript('supervisor.js',clock),status=new Port();
    const service=api.createManagedServices({ps:()=>[]},
        {contracts:false,progression:false,stocks:false,go:true},[])
        .find(s=>s.name==='go-bot.js');
    service.pid=42;
    status.write({type:'go-status',terminal:true,producerPid:42,generatedAt:clock.now,error:'interrupted request'});
    const ns={ps:()=>[],getPortHandle:()=>status};
    const stopped=api.goSafetyStop(ns,service);
    assert.equal(stopped.error,'interrupted request');
    api.blockGoService(ns,service,stopped);
    assert.equal(service.state,'BLOCKED');
    assert.equal(service.pid,42);
    assert.equal(service.nextStartAt,Infinity);
    assert.match(service.lastEvent,/interrupted request/);
});


test('missing market access blocks stock service without restart backoff', () => {
    const clock=new Clock(),api=loadScript('supervisor.js',clock),status=new Port();
    const service=api.createManagedServices({ps:()=>[]},
        {contracts:false,progression:false,stocks:true,stockCashReserve:0.20},[])
        .find(s=>s.name==='stock-trader.js');
    const ns={ps:()=>[],getPortHandle:()=>status};
    api.blockStockService(ns,service,{ok:false,missing:['4S TIX API']},clock.now);
    assert.equal(service.state,'BLOCKED');
    assert.equal(service.pid,0);
    assert.equal(service.failures,0);
    assert.equal(service.nextStartAt,0);
    assert.match(service.lastEvent,/4S TIX API/);
});

test('an inconsistent existing daemon/fleet pair fails before starting dependents', () => {
    const api=loadScript('supervisor.js',new Clock());
    assert.throws(()=>api.createManagedServices({ps:()=>[
        {filename:'fleet-manager.js',pid:9,args:['--port',8]},
        {filename:'daemon.js',pid:10,args:[]},
    ]},{contracts:true,progression:true},[]),/different fleet ports/);
});

test('reserved automation channels are rejected by fleet and daemon configuration', () => {
    const clock=new Clock(),api=loadScript('supervisor.js',clock),daemon=loadScript('daemon.js',clock);
    assert.throws(()=>api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',14]}]}, {}, []),/reserved/);
    assert.throws(()=>api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',13]}]}, {}, []),/reserved/);
    assert.throws(()=>api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',12]}]}, {}, []),/reserved/);
    for(const config of [{port:14,fleetPort:19,controlPort:15},{port:20,fleetPort:14,controlPort:15},{port:20,fleetPort:19,controlPort:14},{port:13,fleetPort:19,controlPort:15},{port:12,fleetPort:19,controlPort:15}]) {
        assert.throws(()=>daemon.validateDaemonPorts(config),/reserved/);
    }
});

test('supervisor yields only the fleet manager when that RAM can restore a missing daemon', () => {
    const api=loadScript('supervisor.js',new Clock()), killed=[];
    const processes=new Map([[9,{filename:'fleet-manager.js',pid:9,args:[],threads:1}]]);
    const ns={ps:()=>[...processes.values()],getServerMaxRam:()=>64,getServerUsedRam:()=>58,
        getScriptRam:file=>file==='daemon.js'?10:8,
        kill:pid=>{killed.push(pid);return processes.delete(pid);}};
    const services=api.createManagedServices(ns,{contracts:false,progression:false,stocks:false,go:false},[]);
    const core=['daemon.js','fleet-manager.js'].map(name=>services.find(service=>service.name===name));
    assert.equal(api.yieldFleetRamToDaemon(ns,core,1234),true);
    assert.deepEqual(killed,[9]);
    const fleet=core.find(service=>service.name==='fleet-manager.js');
    assert.equal(fleet.state,'BACKOFF');
    assert.match(fleet.lastEvent,/money engine/);
});

test('stale Go terminal status from a dead reset process is not displayed as current', () => {
    const api=loadScript('supervisor.js',new Clock());
    const service=api.createManagedServices({ps:()=>[]},
        {contracts:false,progression:false,stocks:false,go:true},[])
        .find(item=>item.name==='go-bot.js');
    const stale={type:'go-status',terminal:true,producerPid:1,error:'NS instance has already been killed'};
    assert.equal(api.ownedServiceStatus({ps:()=>[]},service,stale),null);
    service.pid=42;
    assert.equal(api.ownedServiceStatus({ps:()=>[]},service,{...stale,producerPid:42}).producerPid,42);
});

test('8 GB starter mode scales its worker and graduates automatically at core capacity', async () => {
    const api=loadScript('supervisor.js',new Clock()), processes=new Map(),launched=[],killed=[],logs=[];
    let homeRam=8, nextPid=10;
    const costs={'supervisor.js':5.05,'daemon.js':15.75,'fleet-manager.js':10.25,'starter-worker.js':2.4};
    const ns={getServerMaxRam:()=>homeRam,getScriptRam:file=>costs[file]||0,
        getServerUsedRam:()=>5.05+[...processes.values()].reduce((sum,p)=>sum+2.4*p.threads,0),
        ps:()=>[...processes.values()],run:(filename,threads,...args)=>{const p={pid:nextPid++,filename,threads,args};processes.set(p.pid,p);launched.push(p);return p.pid;},
        kill:pid=>{killed.push(pid);return processes.delete(pid);},clearLog(){},print:text=>logs.push(text),tprint:text=>logs.push(text),
        sleep:async()=>{homeRam=processes.values().next().value?.threads===1?16:32;}};
    await api.runStarterMode(ns);
    assert.deepEqual(launched.map(p=>[p.filename,p.threads,p.args[0]]),[
        ['starter-worker.js',1,'n00dles'],['starter-worker.js',4,'n00dles']]);
    assert.equal(killed.length,2);
    assert.ok(logs.some(line=>String(line).includes('STARTER MODE')));
});

test('starter worker chooses weaken, grow, then hack from target health', () => {
    const api=loadScript('starter-worker.js',new Clock());
    assert.equal(api.starterAction(1e6,1e6,8,1),'weaken');
    assert.equal(api.starterAction(1e5,1e6,1,1),'grow');
    assert.equal(api.starterAction(1e6,1e6,1,1),'hack');
});

test('priority admission holds RAM for important services and preempts exact lower PIDs', () => {
    const clock=new Clock(),supervisor=loadScript('supervisor.js',clock);
    const lifecycle=loadScript('lib/service-lifecycle.js',clock);
    const costs={'high.js':12,'medium.js':10,'low.js':5};
    const processes=new Map(),launched=[],killed=[];
    let maxRam=20,nextPid=10;
    const ns={ps:()=>[...processes.values()],fileExists:()=>true,isRunning:pid=>processes.has(pid),
        getScriptRam:file=>costs[file]||0,getServerMaxRam:()=>maxRam,
        getServerUsedRam:()=>[...processes.values()].reduce((sum,p)=>sum+costs[p.filename]*p.threads,0),
        run:(filename,threads,...args)=>{const p={pid:nextPid++,filename,threads,args};processes.set(p.pid,p);launched.push(p);return p.pid;},
        kill:pid=>{killed.push(pid);return processes.delete(pid);}};
    const services=['high.js','medium.js','low.js'].map(name=>lifecycle.createService(name));

    assert.match(supervisor.tickServicePriority(ns,services),/medium\.js/);
    assert.deepEqual(launched.map(p=>p.filename),['high.js']);
    assert.equal(services[1].state,'WAITING_RAM');
    assert.equal(services[2].state,'WAITING_PRIORITY');

    maxRam=27;
    supervisor.tickServicePriority(ns,services);
    assert.deepEqual(launched.map(p=>p.filename),['high.js','medium.js','low.js']);

    const high=processes.values().find(p=>p.filename==='high.js');
    processes.delete(high.pid);
    maxRam=20;
    supervisor.tickServicePriority(ns,services);
	clock.now+=5000;
	supervisor.tickServicePriority(ns,services);
    assert.deepEqual(killed.map(pid=>launched.find(p=>p.pid===pid).filename),['low.js','medium.js']);
    assert.equal([...processes.values()].some(p=>p.filename==='high.js'),true);
});
