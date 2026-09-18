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


test('new dependent managers and daemon follow an adopted custom fleet port', () => {
    const api=loadScript('supervisor.js',new Clock());
    const services=api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',12,'--cloud',false]}]},
        {contracts:true,progression:true},['--background-prep',false]);
    for(const name of ['daemon.js','contract-manager.js','progression-manager.js']) {
        const args=services.find(s=>s.name===name).args;
        assert.equal(args[args.indexOf('--fleet-port')+1],12,name);
    }
});

test('an inconsistent existing daemon/fleet pair fails before starting dependents', () => {
    const api=loadScript('supervisor.js',new Clock());
    assert.throws(()=>api.createManagedServices({ps:()=>[
        {filename:'fleet-manager.js',pid:9,args:['--port',12]},
        {filename:'daemon.js',pid:10,args:[]},
    ]},{contracts:true,progression:true},[]),/different fleet ports/);
});

test('action channel is reserved from fleet and daemon configuration', () => {
    const clock=new Clock(),api=loadScript('supervisor.js',clock),daemon=loadScript('daemon.js',clock);
    assert.throws(()=>api.createManagedServices({ps:()=>[{filename:'fleet-manager.js',pid:9,args:['--port',14]}]}, {}, []),/reserved/);
    for(const config of [{port:14,fleetPort:19,controlPort:15},{port:20,fleetPort:14,controlPort:15},{port:20,fleetPort:19,controlPort:14}]) {
        assert.throws(()=>daemon.validateDaemonPorts(config),/reserved/);
    }
});
