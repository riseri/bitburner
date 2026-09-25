const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');
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
    return { clock, api, ns, hosts, files, processes, launches, copies, killed };
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
