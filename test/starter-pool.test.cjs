const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
    const clock = new Clock(), api = loadScript('lib/starter-pool.js', clock);
    const hosts = {
        home: { ram: 8, foreign: 7.7, root: true, ports: 0 },
        n00dles: { ram: 4, foreign: 0, root: false, ports: 0 },
        foodnstuff: { ram: 16, foreign: 3, root: false, ports: 0 },
        locked: { ram: 32, foreign: 0, root: false, ports: 1 },
    };
    const files = new Set(), processes = new Map(), launches = [], copies = [], killed = [];
    let nextPid = 10;
    const costs = { 'supervisor.js': 7.7, 'daemon.js': 15.75, 'fleet-manager.js': 10.25, 'starter-worker.js': 2.5 };
    function launch(filename, host, threads, ...args) {
        assert.ok(hosts[host].root);
        assert.ok(threads * costs[filename] <= ns.getServerMaxRam(host) - ns.getServerUsedRam(host));
        const process = { filename, host, threads, args, pid: nextPid++ };
        processes.set(process.pid, process); launches.push(process); return process.pid;
    }
    const ns = {
        scan: host => host === 'home' ? ['n00dles', 'foodnstuff'] : host === 'foodnstuff' ? ['home', 'locked'] : ['home'],
        hasRootAccess: host => hosts[host].root,
        fileExists: file => files.has(file),
        brutessh: host => { hosts[host].opened = 1; },
        nuke: host => { if (hosts[host].ports > (hosts[host].opened || 0)) throw Error('ports'); hosts[host].root = true; },
        getScriptRam: file => costs[file] || 0,
        getServerMaxRam: host => hosts[host].ram,
        getServerUsedRam: host => hosts[host].foreign + [...processes.values()].filter(p => p.host === host)
            .reduce((sum, p) => sum + costs[p.filename] * p.threads, 0),
        ps: host => [...processes.values()].filter(p => p.host === host),
        scp: async (...args) => { copies.push(args); return true; },
        exec: launch, run: (file, threads, ...args) => launch(file, 'home', threads, ...args),
        kill: pid => { killed.push(pid); return processes.delete(pid); },
        print() {}, tprint() {}, clearLog() {},
    };
    return { clock, api, ns, hosts, files, processes, launches, copies, killed, costs };
}

test('8 GB starter uses free remote RAM without Formulas, Singularity or home worker space', async () => {
    const f = fixture(), hosts = f.api.starterHosts(f.ns);
    assert.equal(new Set(hosts).size, 4);
    const result = await f.api.tickStarterPool(f.ns, hosts);
    assert.equal(result.threads, 6);
    assert.equal(result.workers, 2);
    assert.deepEqual(f.launches.map(p => [p.host, p.threads]), [['n00dles', 1], ['foodnstuff', 5]]);
    assert.equal(f.hosts.foodnstuff.foreign, 3);
    assert.equal(f.copies.length, 2);
    assert.equal(f.hosts.locked.root, false);
});

test('starter adopts its pool on restart and expands when a port opener becomes available', async () => {
    const f = fixture(), hosts = f.api.starterHosts(f.ns);
    await f.api.tickStarterPool(f.ns, hosts);
    await f.api.tickStarterPool(f.ns, hosts); // Fresh copy cache, stable process marker.
    assert.equal(f.launches.length, 2);
    assert.equal(f.killed.length, 0);
    f.files.add('BruteSSH.exe');
    const result = await f.api.tickStarterPool(f.ns, hosts);
    assert.equal(result.threads, 18);
    assert.equal(f.launches.at(-1).host, 'locked');
});

test('copy and exec failures retry without claiming income or killing unrelated processes', async () => {
    const f = fixture(), hosts = f.api.starterHosts(f.ns), copied = new Set();
    f.ns.scp = async () => false;
    assert.equal((await f.api.tickStarterPool(f.ns, hosts, copied)).workers, 0);
    f.ns.scp = async () => true;
    const exec = f.ns.exec;
    f.ns.exec = () => 0;
    assert.equal((await f.api.tickStarterPool(f.ns, hosts, copied)).threads, 0);
    assert.equal(copied.size, 0);
    f.ns.exec = exec;
    assert.equal((await f.api.tickStarterPool(f.ns, hosts, copied)).threads, 6);
    assert.equal(f.killed.length, 0);
});

test('failed cancellation never launches a duplicate, and handoff retries until the pool is gone', async () => {
    const f = fixture(), hosts = f.api.starterHosts(f.ns);
    await f.api.tickStarterPool(f.ns, hosts);
    f.hosts.foodnstuff.ram = 32;
    const kill = f.ns.kill;
    f.ns.kill = () => false;
    assert.equal((await f.api.tickStarterPool(f.ns, hosts)).failures, 1);
    assert.equal(f.launches.length, 2);
    assert.equal(f.api.stopStarterPool(f.ns, hosts), false);
    f.ns.kill = kill;
    // Same script, explicitly launched by the user on a different target.
    f.processes.set(999, { pid: 999, filename: 'starter-worker.js', args: ['foodnstuff'], host: 'foodnstuff', threads: 1 });
    assert.equal(f.api.stopStarterPool(f.ns, hosts), true);
    assert.deepEqual([...f.processes.keys()], [999]);
});

test('graduation frees owned remote workers and waits for genuinely available home RAM', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    let cycle = 0;
    f.ns.sleep = async () => {
        cycle++;
        if (cycle === 1) { f.hosts.home.ram = 64; f.hosts.home.foreign = 60; }
        else if (cycle === 2) f.hosts.home.foreign = 7.7;
        else throw Error('failed to graduate');
    };
    f.ns.getResetInfo = () => ({ currentNode: 1 });
    await supervisor.runStarterMode(f.ns);
    assert.equal(cycle, 2);
    assert.ok(f.launches.some(p => p.host === 'foodnstuff'));
    assert.equal(f.processes.size, 0);
    assert.equal(f.killed.length, f.launches.length);
});

test('legacy home worker is adopted for migration, while unmarked remote workers are left alone', () => {
    const f = fixture();
    f.processes.set(1, { pid: 1, filename: 'starter-worker.js', args: ['n00dles'], host: 'home', threads: 1 });
    f.processes.set(2, { pid: 2, filename: 'starter-worker.js', args: ['n00dles'], host: 'n00dles', threads: 1 });
    assert.equal(f.api.stopStarterPool(f.ns, f.api.starterHosts(f.ns)), true);
    assert.deepEqual([...f.processes.keys()], [2]);
});

test('supervisor sharing settings do not add the unused 2.4 GB share API to its RAM bill', () => {
    for (const file of ['supervisor.js', 'lib/service-catalog.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
        assert.doesNotMatch(source, /\.share\b/, `${file}: a named share property is charged by Netscript`);
    }
    const catalog = loadScript('lib/service-catalog.js', new Clock());
    assert.ok(catalog.supervisorFiles(catalog.supervisorServiceConfig([])).includes('share-worker.js'));
    assert.ok(!catalog.supervisorFiles(catalog.supervisorServiceConfig(['--share', false])).includes('share-worker.js'));
});

test('distributed starter workers increase early income in a shared-target simulation', async () => {
    async function simulate(allocations) {
        const clock = new Clock(), worker = loadScript('starter-worker.js', clock);
        let money = 1e6, security = 1, earned = 0;
        for (const threads of allocations) {
            const ns = { args: ['n00dles'], disableLog() {}, hasRootAccess: () => true,
                getServerMoneyAvailable: () => money, getServerMaxMoney: () => 1e6,
                getServerSecurityLevel: () => security, getServerMinSecurityLevel: () => 1,
                hack: async () => { await clock.sleep(1000); const amount = money * Math.min(1, 0.004 * threads); money -= amount; earned += amount; security += 0.002 * threads; },
                grow: async () => { await clock.sleep(3200); money = Math.min(1e6, (money + threads) * 1.03 ** threads); security += 0.004 * threads; },
                weaken: async () => { await clock.sleep(4000); security = Math.max(1, security - 0.05 * threads); },
            };
            void worker.main(ns);
        }
        await clock.runUntil(clock.now + 300000);
        return earned;
    }
    const f = fixture();
    await f.api.tickStarterPool(f.ns, f.api.starterHosts(f.ns));
    const before = await simulate([1]);
    const after = await simulate(f.launches.map(p => p.threads));
    assert.ok(after > before * 2, `model income: single worker ${before}, remote pool ${after}`);
});


test('BN4 starter buys its own home RAM remotely and graduates without user upgrades', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock), upgrade = loadScript('home-upgrade.js', f.clock);
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2 };
    Object.assign(f.costs, { 'home-upgrade.js': 7.25, 'augmentation-manager.js': 110, 'progression-manager.js': 5,
        'node-complete.js': 42, 'intelligence-handoff.js': 35, 'progression-backdoor.js': 11, 'augmentation-planner.js': 35 });
    f.ns.getResetInfo = () => reset; f.ns.read = () => ''; f.ns.getServerMoneyAvailable = () => 1e12;
    f.ns.singularity = { getUpgradeHomeRamCost: () => 1e6, upgradeHomeRam: () => { f.hosts.home.ram *= 2; return true; } };
    let cycles = 0;
    f.ns.sleep = async () => {
        assert.ok(++cycles < 10, 'must graduate with automatic upgrades');
        const helper = [...f.processes.values()].find(p => p.filename === 'home-upgrade.js');
        assert.ok(helper, 'a rooted remote host must run the helper');
        await upgrade.main({ ...f.ns, args: helper.args });
        f.processes.delete(helper.pid);
    };
    await supervisor.runStarterMode(f.ns, { augmentationActions: true, progression: true, progressionActions: true });
    assert.equal(f.hosts.home.ram, 64);
    assert.equal(cycles, 3);
    assert.notEqual(f.launches.find(p => p.filename === 'home-upgrade.js').host, 'home', 'initial 8 GB upgrade uses remote RAM');
    assert.equal(f.hosts.foodnstuff.foreign, 3);
    assert.equal(f.processes.size, 0);
});

test('fresh 32 GB BN4 keeps starter income until fleet, progression and upgrade headroom fit', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock), upgrade = loadScript('home-upgrade.js', f.clock);
    Object.assign(f.costs, { 'supervisor.js': 12.75, 'daemon.js': 15.75, 'fleet-manager.js': 10.45,
        'progression-manager.js': 6, 'augmentation-manager.js': 110, 'home-upgrade.js': 7.25 });
    f.hosts.home.ram = 32; f.hosts.home.foreign = 12.75;
    f.files.add('progression-manager.js');
    const ports = new Map(), reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2 };
    f.ns.getPortHandle = n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); };
    f.ns.getResetInfo = () => reset; f.ns.read = () => ''; f.ns.getServerMoneyAvailable = () => 1e12;
    f.ns.singularity = { getUpgradeHomeRamCost: () => 1e6, upgradeHomeRam: () => { f.hosts.home.ram *= 2; return true; } };
    let cycles = 0;
    f.ns.sleep = async () => {
        assert.equal(++cycles, 1, 'must upgrade from 32 GB before handing off');
        assert.ok(f.launches.some(p => p.filename === 'starter-worker.js' && p.host !== 'home'), 'remote income continues');
        assert.ok(f.launches.some(p => p.filename === 'progression-manager.js'), 'progression starts when it fits');
        assert.ok(!f.launches.some(p => p.filename === 'daemon.js'), 'no premature daemon-only handoff');
        const helper = [...f.processes.values()].find(p => p.filename === 'home-upgrade.js');
        assert.ok(helper, 'upgrade must have somewhere to run');
        await upgrade.main({ ...f.ns, args: helper.args, getHostname: () => helper.host });
        f.processes.delete(helper.pid); f.clock.now += 5000;
    };
    const cfg = { augmentationActions: true, progression: true, progressionActions: true, savingsMode: 'keep' };
    await supervisor.runStarterMode(f.ns, cfg);
    assert.equal(f.hosts.home.ram, 64); assert.equal(cycles, 1);
    const free = 64 - f.ns.getServerUsedRam('home');
    assert.ok(free >= f.costs['daemon.js'] + f.costs['fleet-manager.js'] + f.costs['home-upgrade.js']);
    assert.equal(f.hosts.foodnstuff.foreign, 3, 'unrelated RAM untouched');
});

test('home upgrade helper rechecks its reset, cost, goal floor, and RAM target', async () => {
    const api = loadScript('home-upgrade.js', new Clock());
    for (const reason of ['ok', 'node', 'epoch', 'cash', 'floor', 'target']) {
        let upgrades = 0;
        const ns = { args: [reason === 'epoch' ? 'old' : '4:1:2', 256, reason === 'floor' ? 101 : 0],
            getResetInfo: () => ({ currentNode: reason === 'node' ? 5 : 4, lastNodeReset: 1, lastAugReset: 2 }),
            getServerMaxRam: () => reason === 'target' ? 256 : 32,
            getServerMoneyAvailable: () => reason === 'cash' ? 99 : 200,
            singularity: { getUpgradeHomeRamCost: () => 100, upgradeHomeRam: () => upgrades++ } };
        await api.main(ns);
        assert.equal(upgrades, reason === 'ok' ? 1 : 0, reason);
    }
});

test('target analysis runs remotely on an 8 GB home and safely retargets marked workers', async () => {
    const f = fixture(), selector = loadScript('starter-target.js', f.clock), state = {}, ports = new Map();
    f.costs['starter-target.js'] = 5.35;
    const stats = host => ({ hasAdminRights: f.hosts[host].root, moneyMax: host === 'foodnstuff' ? 50e6 : 1e6,
        moneyAvailable: host === 'foodnstuff' ? 50e6 : 1e6, requiredHackingSkill: 1,
        minDifficulty: 1, hackDifficulty: 1, serverGrowth: host === 'n00dles' ? 3000 : 50 });
    Object.assign(f.ns, { pid: 1, getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        getHackingLevel: () => 246, getHackingMultipliers: () => ({ chance: 1, money: 1, growth: 1 }),
        getServer: stats, getHackTime: () => 1000, isRunning: () => true });
    f.processes.set(999, { pid: 999, host: 'foodnstuff', filename: 'starter-worker.js', threads: 1, args: ['foodnstuff'] });
    const hosts = f.api.starterHosts(f.ns), copied = new Set();
    await f.api.tickStarterPool(f.ns, hosts, copied, state);
    const helper = f.launches.find(process => process.filename === 'starter-target.js');
    assert.equal(helper.host, 'foodnstuff');
    assert.equal(f.hosts.home.ram, 8);
    await selector.main({ ...f.ns, args: helper.args });
    f.processes.delete(helper.pid); f.clock.now += 5000;
    const pool = await f.api.tickStarterPool(f.ns, hosts, copied, state);
    assert.equal(pool.target, 'foodnstuff');
    for (const host of hosts) for (const process of f.api.starterWorkers(f.ns, host)) assert.equal(process.args[0], pool.target);
    assert.ok(f.processes.has(999), 'manually launched worker retained');
    const launches = f.launches.length, kills = f.killed.length;
    f.clock.now += 60000;
    await f.api.tickStarterPool(f.ns, hosts, copied, state);
    assert.equal(f.launches.length, launches, 'cooldown avoids extra helpers and worker restarts');
    assert.equal(f.killed.length, kills);
    assert.ok(f.api.stopStarterPool(f.ns, hosts));
    assert.deepEqual([...f.processes.keys()], [999]);
});

test('supervisor restart adopts marked workers on an advanced target without restarting them', async () => {
    const f = fixture(), hosts = f.api.starterHosts(f.ns);
    await f.api.tickStarterPool(f.ns, hosts);
    for (const process of f.processes.values()) process.args[0] = 'foodnstuff';
    const state = {}, launches = f.launches.length;
    const pool = await f.api.tickStarterPool(f.ns, hosts, new Set(), state);
    assert.equal(state.target, 'foodnstuff');
    assert.equal(pool.target, 'foodnstuff');
    assert.equal(f.launches.length, launches);
    assert.equal(f.killed.length, 0);
});

test('64 GB starter yields early augmentation RAM and hands off without a 128 GB upgrade', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    Object.assign(f.costs, { 'supervisor.js': 12.75, 'daemon.js': 15.75, 'fleet-manager.js': 10.45,
        'progression-manager.js': 6, 'augmentation-manager.js': 25.8, 'home-upgrade.js': 7.25 });
    f.hosts.home.ram = 64; f.hosts.home.foreign = 12.75;
    f.processes.set(31, { pid: 31, host: 'home', filename: 'progression-manager.js', threads: 1, args: [] });
    f.processes.set(32, { pid: 32, host: 'home', filename: 'augmentation-manager.js', threads: 1, args: [] });
    f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 });
    f.ns.sleep = async () => { throw Error('should not wait for another RAM tier'); };
    const cfg = { augmentationActions: true, progression: true, progressionActions: true };
    assert.ok(supervisor.starterAdmissionRam(f.ns, cfg, f.costs['home-upgrade.js']) + f.costs['augmentation-manager.js'] > 64);
    await supervisor.runStarterMode(f.ns, cfg);
    assert.equal(f.hosts.home.ram, 64);
    assert.deepEqual(f.killed, [32]);
    assert.ok(f.processes.has(31), 'progression remains running');
    assert.ok(64 - f.ns.getServerUsedRam('home') >= f.costs['daemon.js'] + f.costs['fleet-manager.js'] + f.costs['home-upgrade.js']);
    assert.equal(f.launches.length, 0, 'no unnecessary upgrade or new workers');
});

test('failed augmentation cancellation retains starter income and retries handoff', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    Object.assign(f.costs, { 'supervisor.js': 12.75, 'daemon.js': 15.75, 'fleet-manager.js': 10.45,
        'progression-manager.js': 6, 'augmentation-manager.js': 25.8 });
    f.hosts.home.ram = 64; f.hosts.home.foreign = 12.75;
    f.processes.set(31, { pid: 31, host: 'home', filename: 'progression-manager.js', threads: 1, args: [] });
    f.processes.set(32, { pid: 32, host: 'home', filename: 'augmentation-manager.js', threads: 1, args: [] });
    f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 });
    const kill = f.ns.kill;
    f.ns.kill = pid => pid === 32 ? false : kill(pid);
    let sleeps = 0;
    f.ns.sleep = async () => {
        assert.equal(++sleeps, 1);
        assert.ok(f.launches.some(process => process.filename === 'starter-worker.js' && process.host !== 'home'));
        assert.ok(f.processes.has(32));
        f.ns.kill = kill;
    };
    await supervisor.runStarterMode(f.ns, { augmentationActions: true, progression: true, progressionActions: false });
    assert.equal(sleeps, 1);
    assert.ok(!f.processes.has(32));
    assert.equal(f.api.starterHosts(f.ns).flatMap(host => f.api.starterWorkers(f.ns, host)).length, 0);
});

test('augmentation action opt-out preserves a manually running augmentation manager', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    Object.assign(f.costs, { 'progression-manager.js': 6, 'augmentation-manager.js': 40 });
    f.hosts.home.ram = 64;
    f.processes.set(32, { pid: 32, host: 'home', filename: 'augmentation-manager.js', threads: 1, args: [] });
    f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 });
    f.ns.sleep = async () => { throw Error('end fixture'); };
    await assert.rejects(supervisor.runStarterMode(f.ns, { progression: true, augmentationActions: false }), /end fixture/);
    assert.ok(f.processes.has(32));
    assert.ok(!f.killed.includes(32));
    assert.ok(f.launches.some(process => process.filename === 'starter-worker.js' && process.host !== 'home'));
});
