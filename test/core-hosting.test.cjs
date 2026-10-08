const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), processes = new Map(), ports = new Map(), copies = [], purchases = [], jobs = [];
    const hosts = { home: { ram: 64, foreign: 7.7 }, n00dles: { ram: 4, foreign: 0 }, foodnstuff: { ram: 16, foreign: 0 } };
    const costs = { 'supervisor.js': 7.7, 'daemon.js': 46.05, 'fleet-manager.js': 10.5,
        'progression-manager.js': 6.05, 'augmentation-manager.js': 112.9, 'home-upgrade.js': 8.05,
        'service-cloud.js': 7.85, 'starter-worker.js': 2.5, 'manual.js': 4 };
    const files = new Map([['home', new Map()]]), cloud = [], killed = [], launches = [];
    let nextPid = 20, money = 1.875e6;
    const source = file => {
        try { return fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'); } catch { return ''; }
    };
    const read = (file, host) => files.get(host)?.get(file) ?? (host === 'home' ? source(file) : '');
    const add = (filename, host = 'home', threads = 1, args = []) => {
        const p = { filename, host, threads, args, pid: nextPid++ }; processes.set(p.pid, p); return p;
    };
    const launch = (filename, host, threads, ...args) => {
        if (costs[filename] * threads > ns.getServerMaxRam(host) - ns.getServerUsedRam(host) + 1e-8) return 0;
        const p = add(filename, host, threads, args); launches.push(p);
        if (filename === 'service-cloud.js') jobs.push(p);
        return p.pid;
    };
    const ns = { pid: 1, args: [], disableLog() {}, print() {}, tprint() {}, clearLog() {}, getHostname: () => 'home',
        scan: host => host === 'home' ? ['n00dles', 'foodnstuff', ...cloud] : ['home'],
        ps: host => [...processes.values()].filter(p => p.host === host),
        getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() }),
        getScriptRam: (file, host = 'home') => read(file, host) ? costs[file] || 0 : 0,
        getServerMaxRam: host => { if (!hosts[host]) throw Error('deleted host'); return hosts[host].ram; },
        getServerUsedRam: host => hosts[host].foreign + ns.ps(host).reduce((n, p) => n + costs[p.filename] * p.threads, 0),
        hasRootAccess: host => Boolean(hosts[host]), hasTorRouter: () => false,
        fileExists: (file, host = 'home') => Boolean(read(file, host)),
        read: file => read(file, 'home'), write: async (file, text) => files.get('home').set(file, text),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        getServerMoneyAvailable: () => money, isRunning: pid => pid === 1 || processes.has(pid),
        nuke() {}, kill: pid => { killed.push(pid); return processes.delete(pid); },
        run: (file, threads, ...args) => launch(file, 'home', threads, ...args), exec: launch,
        scp: async (entries, host, from = 'home') => {
            copies.push([entries, host, from]);
            if (!files.has(host)) files.set(host, new Map());
            for (const file of Array.isArray(entries) ? entries : [entries]) {
                const text = read(file, from); if (!text) return false;
                files.get(host).set(file, text);
            }
            return true;
        },
        cloud: { getServerNames: () => [...cloud], getServerLimit: () => 25, getRamLimit: () => 1048576,
            getServerCost: ram => ram * 55000,
            purchaseServer: (name, ram) => {
                const cost = ram * 55000; if (money < cost) return '';
                purchases.push({ name, ram, cost }); money -= cost; cloud.push(name);
                hosts[name] = { ram, foreign: 0 }; files.set(name, new Map()); return name;
            } },
    };
    const remote = p => ({ ...ns, pid: p.pid, args: p.args, getHostname: () => p.host,
        read: file => read(file, p.host), write: async (file, text) => files.get(p.host).set(file, text) });
    async function pump() {
        for (const p of jobs.splice(0)) { await loadScript('service-cloud.js', clock).main(remote(p)); processes.delete(p.pid); }
    }
    ns.sleep = async ms => { await pump(); clock.now += ms; if (clock.now > 1_200_000) throw Error('fixture deadline'); };
    function goal(amount, owner = 'manual', target = '', host = 'home') {
        if (!files.has(host)) files.set(host, new Map());
        files.get(host).set('data/savings.json', JSON.stringify({ version: 1, amount, owner, target,
            epoch: '4:1:2', label: 'Test goal', updatedAt: clock.now }));
    }
    return { ns, clock, costs, hosts, processes, ports, purchases, copies, cloud, killed, launches, files, add, read,
        goal, pump, remote, money: value => { money = value; } };
}

function request(f, extra = {}) {
    const value = { type: 'service-hosting-request', version: 1, requestId: '1:1000000', ownerPid: 1,
        resetEpoch: '4:1:2', createdAt: f.clock.now, expiresAt: f.clock.now + 60000,
        services: ['daemon.js', 'fleet-manager.js', 'progression-manager.js'], keepHomeRam: 8.05, ...extra };
    f.ns.args = [JSON.stringify(value)]; const port = f.ns.getPortHandle(4); port.clear(); port.write(value);
    return value;
}

for (const phase of ['UNLOCK', 'INSTALL']) test(`cloud service RAM remains purchasable during an idle ${phase} augmentation status`, async () => {
    const f = fixture();
    const manager = f.add('augmentation-manager.js');
    f.costs['augmentation-manager.js'] = 1;
    f.ns.getPortHandle(11).write({ type: 'augmentation-status', version: 1, producerPid: manager.pid,
        resetEpoch: '4:1:2', generatedAt: f.clock.now, state: 'WAITING', phase, queued: 0,
        progression: { resetImminent: false, redPill: 'none' } });
    request(f);
    await loadScript('service-cloud.js', f.clock).main(f.ns);
    assert.equal(f.ns.getPortHandle(4).peek().state, 'READY');
    assert.deepEqual(f.purchases.map(p => [p.ram, p.cost]), [[32, 1.76e6]]);
});

for (const state of ['BLOCKED', 'RESETTING']) test(`cloud service RAM retains capital for a real ${state} installation`, async () => {
    const f = fixture();
    const manager = f.add('augmentation-manager.js');
    f.costs['augmentation-manager.js'] = 1;
    f.ns.getPortHandle(11).write({ type: 'augmentation-status', version: 1, producerPid: manager.pid,
        resetEpoch: '4:1:2', generatedAt: f.clock.now, state, phase: 'INSTALL', queued: 5 });
    request(f);
    await loadScript('service-cloud.js', f.clock).main(f.ns);
    assert.equal(f.ns.getPortHandle(4).peek().state, 'WAITING');
    assert.match(f.ns.getPortHandle(4).peek().reason, /Reset is imminent/);
    assert.equal(f.purchases.length, 0);
});

test('a 64 GB reset buys 32 GB cloud RAM and admits all three cores without the 128 GB home upgrade', async () => {
    const f = fixture(), api = loadScript('supervisor.js', f.clock);
    const cfg = { cloudServices: true, progression: true, progressionActions: true, augmentationActions: true,
        savingsMode: 'auto', progressionCashReserve: .1, augmentationCashReserve: .1, darknet: false };
    await api.runStarterMode(f.ns, cfg);
    assert.equal(f.hosts.home.ram, 64);
    assert.deepEqual(f.purchases.map(p => [p.ram, p.cost]), [[32, 1.76e6]]);
    assert.equal(cfg.serviceHosts['daemon.js'], 'home');
    assert.equal(cfg.serviceHosts['fleet-manager.js'], f.cloud[0]);
    assert.equal(cfg.serviceHosts['progression-manager.js'], f.cloud[0]);
    assert.ok(f.files.get('home').has('data/service-hosts.json'));
    const services = api.createManagedServices(f.ns, cfg, []);
    api.tickServicePriority(f.ns, services, '', 8.05);
    for (const name of ['daemon.js', 'fleet-manager.js', 'progression-manager.js'])
        assert.equal([...f.processes.values()].filter(p => p.filename === name).length, 1, name);
    assert.equal(f.ns.getServerMaxRam(f.cloud[0]), 32);
    assert.ok(f.ns.getServerUsedRam(f.cloud[0]) < 32);
    assert.ok(![...f.processes.values()].some(p => p.filename === 'starter-worker.js' && p.args[1] === 'supervisor-starter-v1'));
});

test('cloud planner packs services by RAM and keeps manual placements pinned', () => {
    const api = loadScript('lib/service-hosts.js', new Clock());
    const jobs = [{ name: 'daemon.js', ram: 46 }, { name: 'fleet-manager.js', ram: 10.5 }, { name: 'progression-manager.js', ram: 6 }];
    const quotes = [{ ram: 16, cost: 880000 }, { ram: 32, cost: 1760000 }, { ram: 64, cost: 3520000 }];
    let plan = api.planServicePlacement(jobs, [{ host: 'home', capacity: 48 }], quotes);
    assert.equal(plan.purchase.ram, 32);
    assert.equal(plan.hosts['daemon.js'], 'home');
    jobs[2].host = 'home';
    plan = api.planServicePlacement(jobs, [{ host: 'home', capacity: 48 }], quotes);
    assert.equal(plan.purchase.ram, 64);
    assert.equal(plan.hosts['progression-manager.js'], 'home');
});

test('an adopted early progression reader relocates with its command line and threads preserved through reload', async () => {
    const f = fixture(), api = loadScript('supervisor.js', f.clock);
    const args = ['--interval', 1234, '--darknet', false];
    const prior = f.add('progression-manager.js', 'home', 2, args);
    const cfg = { cloudServices: true, progression: true, progressionActions: true, augmentationActions: true,
        savingsMode: 'auto', progressionCashReserve: .1, augmentationCashReserve: .1, darknet: false };
    await api.runStarterMode(f.ns, cfg);
    assert.deepEqual(f.purchases.map(p => p.ram), [32]); assert.ok(f.killed.includes(prior.pid));
    const hosts = loadScript('lib/service-hosts.js', f.clock);
    const restored = { ...cfg, serviceHosts: hosts.readServiceHosts(f.ns), serviceSettings: hosts.readServiceSettings(f.ns) };
    const services = api.createManagedServices(f.ns, restored, []);
    api.tickServicePriority(f.ns, services, '', 8.05);
    const reader = [...f.processes.values()].find(p => p.filename === 'progression-manager.js');
    assert.equal(reader.host, f.cloud[0]); assert.equal(reader.threads, 2); assert.deepEqual(Array.from(reader.args), args);
});

test('already purchased capacity is reused and unrelated processes are neither stopped nor overwritten', async () => {
    const f = fixture();
    f.cloud.push('my-cloud'); f.hosts['my-cloud'] = { ram: 32, foreign: 0 };
    const manual = f.add('manual.js', 'my-cloud');
    request(f); await loadScript('service-cloud.js', f.clock).main(f.ns);
    assert.equal(f.ns.getPortHandle(4).peek().state, 'READY');
    assert.equal(f.purchases.length, 0); assert.ok(f.processes.has(manual.pid)); assert.equal(f.killed.length, 0);
});

test('remote buyer refreshes a changed manual savings floor before spending', async () => {
    const f = fixture(); f.money(2e6); f.goal(500000);
    const p = f.add('service-cloud.js', 'foodnstuff');
    f.goal(0, 'manual', '', 'foodnstuff');
    p.args = [JSON.stringify(request(f))];
    await loadScript('service-cloud.js', f.clock).main(f.remote(p));
    assert.equal(f.purchases.length, 0);
    assert.equal(f.ns.getPortHandle(4).peek().state, 'WAITING');
    assert.equal(f.ns.getPortHandle(4).peek().floor, 500000);
    assert.ok(f.copies.some(([entries, host]) => entries === 'data/savings.json' && host === 'foodnstuff'));
});

test('failed savings refresh defers both isolated hosting and remote fleet spending', async () => {
    const f = fixture(); f.goal(0); f.ns.scp = async () => false;
    const p = f.add('service-cloud.js', 'foodnstuff'); p.args = [JSON.stringify(request(f))];
    await loadScript('service-cloud.js', f.clock).main(f.remote(p));
    assert.equal(f.purchases.length, 0);
    const state = {};
    await loadScript('fleet-manager.js', f.clock).executeInvestment(f.remote(p), {}, state, {});
    assert.match(state.investment, /savings refresh failed/);
});

for (const reason of ['expired', 'reset', 'owner', 'superseded']) test(`cloud buyer rejects a ${reason} request before any transaction`, async () => {
    const f = fixture(); request(f);
    if (reason === 'expired') f.clock.now += 60000;
    if (reason === 'reset') f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 3 });
    if (reason === 'owner') f.ns.isRunning = () => false;
    if (reason === 'superseded') { f.ns.getPortHandle(4).clear(); f.ns.getPortHandle(4).write({ requestId: 'new' }); }
    await loadScript('service-cloud.js', f.clock).main(f.ns);
    assert.equal(f.purchases.length, 0); assert.notEqual(f.ns.getPortHandle(4).peek().type, 'service-hosting-result');
});

test('cloud slots exhausted produces a visible fallback rather than spending or deleting a server', async () => {
    const f = fixture(); f.ns.cloud.getServerLimit = () => 0;
    request(f); await loadScript('service-cloud.js', f.clock).main(f.ns);
    assert.equal(f.ns.getPortHandle(4).peek().state, 'UNAVAILABLE');
    assert.match(f.ns.getPortHandle(4).peek().reason, /slots are full/); assert.equal(f.purchases.length, 0);
});

test('a failed service copy retries on the same purchased host before handoff', async () => {
    const f = fixture(), api = loadScript('supervisor.js', f.clock), scp = f.ns.scp;
    let failed = false;
    f.ns.scp = async (files, host, from) => {
        if (!failed && f.cloud.includes(host) && Array.isArray(files) && files.includes('fleet-manager.js')) { failed = true; return false; }
        return scp(files, host, from);
    };
    await api.runStarterMode(f.ns, { cloudServices: true, progression: true, augmentationActions: true, progressionActions: true,
        savingsMode: 'auto', progressionCashReserve: .1, augmentationCashReserve: .1, darknet: false });
    assert.equal(failed, true); assert.equal(f.purchases.length, 1);
    assert.ok(f.read('fleet-manager.js', f.cloud[0]));
});

test('remote lifecycle adopts arguments, restarts on its assigned host, and refuses cross-host duplicates', () => {
    const f = fixture(), api = loadScript('lib/service-lifecycle.js', f.clock);
    f.cloud.push('core-test'); f.hosts['core-test'] = { ram: 64, foreign: 0 };
    f.files.set('core-test', new Map([['fleet-manager.js', f.read('fleet-manager.js', 'home')]]));
    const p = f.add('fleet-manager.js', 'core-test', 2, ['--cloud', false, '--port', 7]);
    const service = api.createService('fleet-manager.js');
    api.tickService(f.ns, service); assert.equal(service.host, 'core-test');
    f.processes.delete(p.pid); api.tickService(f.ns, service); f.clock.now += 5000; api.tickService(f.ns, service);
    assert.equal(f.launches.at(-1).host, 'core-test'); assert.equal(f.launches.at(-1).threads, 2);
    assert.deepEqual(f.launches.at(-1).args, p.args);
    f.add('fleet-manager.js', 'home'); api.tickService(f.ns, service);
    assert.equal(service.state, 'CONFLICT'); assert.equal(f.launches.length, 1);
});

test('a home RAM blocker does not block a controller assigned to independent cloud RAM', () => {
    const f = fixture(), api = loadScript('supervisor.js', f.clock), life = loadScript('lib/service-lifecycle.js', f.clock);
    f.cloud.push('core-test'); f.hosts['core-test'] = { ram: 64, foreign: 0 };
    f.files.set('core-test', new Map([['daemon.js', f.read('daemon.js', 'home')]]));
    const home = life.createService('augmentation-manager.js'), remote = life.createService('daemon.js'); remote.host = 'core-test';
    const blocker = api.tickServicePriority(f.ns, [home, remote], '', 8.05);
    assert.match(blocker, /augmentation-manager/); assert.equal(home.state, 'WAITING_RAM'); assert.ok(remote.pid);
    assert.equal(f.launches.at(-1).host, 'core-test');
});

test('remote services wait for a complete copy even when an old entry point already exists', async () => {
    const f = fixture(), api = loadScript('supervisor.js', f.clock), hosting = loadScript('lib/core-hosting.js', f.clock);
    f.cloud.push('core-test'); f.hosts['core-test'] = { ram: 32, foreign: 0 };
    f.files.set('core-test', new Map([['fleet-manager.js', f.read('fleet-manager.js', 'home')]]));
    const cfg = { serviceHosts: { 'fleet-manager.js': 'core-test' } };
    f.ns.scp = async () => false;
    assert.equal(await hosting.prepareCoreHosts(f.ns, cfg, ['fleet-manager.js']), false);
    const service = api.createManagedServices(f.ns, cfg, []).find(s => s.name === 'fleet-manager.js');
    service.filesReady = !cfg.hostingBlocked.has(service.name);
    api.tickServicePriority(f.ns, [service]);
    assert.equal(service.state, 'WAITING_FILES'); assert.equal(f.launches.length, 0);
});

test('dependency copying includes the actual recursive daemon imports and skips quoted fake imports', () => {
    const f = fixture(), api = loadScript('lib/service-hosts.js', f.clock);
    const files = Array.from(api.serviceBundle(f.ns, ['daemon.js']));
    for (const name of ['lib/formulas.js', 'lib/target-pipelines.js', 'lib/progression-objective.js', 'lib/savings.js']) assert.ok(files.includes(name), name);
    assert.ok(!files.includes('manual.js')); assert.equal(new Set(files).size, files.length);
});

test('saved placements survive a supervisor restart and expire across augmentation resets or deleted hosts', () => {
    const f = fixture(), api = loadScript('lib/service-hosts.js', f.clock);
    f.cloud.push('core-test'); f.hosts['core-test'] = { ram: 64, foreign: 0 };
    f.files.get('home').set('data/service-hosts.json', JSON.stringify({ version: 1, resetEpoch: '4:1:2', hosts: { 'daemon.js': 'core-test' } }));
    assert.equal(api.readServiceHosts(f.ns)['daemon.js'], 'core-test');
    f.cloud.length = 0; assert.equal(Object.keys(api.readServiceHosts(f.ns)).length, 0);
    f.cloud.push('core-test'); f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 3 });
    assert.equal(Object.keys(api.readServiceHosts(f.ns)).length, 0);
});

test('supervisor reload stops remote controllers by exact PID and never starts a second fleet from a managed daemon', () => {
    const f = fixture(); f.cloud.push('core-test'); f.hosts['core-test'] = { ram: 64, foreign: 0 };
    const daemon = f.add('daemon.js', 'core-test'), fleet = f.add('fleet-manager.js', 'core-test'), manual = f.add('manual.js');
    assert.equal(loadScript('supervisor-restart.js', f.clock).stopControllers(f.ns, ['daemon.js', 'fleet-manager.js']), true);
    assert.deepEqual(f.killed, [daemon.pid, fleet.pid]); assert.ok(f.processes.has(manual.pid));
    loadScript('daemon.js', f.clock).startFleetManager({ run: () => assert.fail('supervisor owns the fleet') }, { managedServices: true });
});
