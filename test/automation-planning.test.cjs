const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function savingsFixture() {
    const clock = new Clock(), api = loadScript('lib/savings.js', clock), files = new Map();
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2 };
    const ns = { read: f => files.get(f) || '', write: async (f, data) => files.set(f, data),
        getResetInfo: () => reset, hasTorRouter: () => false, fileExists: () => false };
    return { clock, api, files, reset, ns };
}

test('savings persists, protects unrelated spending, and releases only its named program', async () => {
    const f = savingsFixture();
    await f.api.writeSavings(f.ns, 5e6, 'Ports', 'BruteSSH.exe');
    assert.equal(f.api.readSavings(f.ns).floor, 5e6);
    assert.equal(f.api.readSavings(f.ns, 'FTPCrack.exe').floor, 5e6);
    assert.equal(f.api.readSavings(f.ns, 'BruteSSH.exe').floor, 0);
    f.ns.fileExists = () => true;
    assert.equal(f.api.readSavings(f.ns).floor, 0);
});

test('old-reset savings is inactive and corrupt savings blocks spending', async () => {
    const f = savingsFixture();
    await f.api.writeSavings(f.ns, 500, 'Goal');
    f.reset.lastAugReset++;
    assert.equal(f.api.readSavings(f.ns).floor, 0);
    f.files.set('data/savings.json', '{broken');
    assert.equal(f.api.readSavings(f.ns).floor, Infinity);
    await f.api.writeSavings(f.ns, 0, 'Cleared');
    assert.equal(f.api.readSavings(f.ns).floor, 0);
    await assert.rejects(f.api.writeSavings(f.ns, NaN, 'bad'));
});

function scheduler() {
    return { type: 'jit-status', pid: 7, generatedAt: 1e6, income60: 1000, usedRam: 900, totalRam: 1000,
        maxBatchRate: 4, maxWorkers: 6000,
        pipelines: [{ target: 'n00dles', mode: 'LIVE', modelBatchRate: 1, running: 30, queued: 20 }] };
}

test('fleet economics rejects idle RAM, recovery, throughput saturation and bad payback', () => {
    const api = loadScript('lib/fleet-economics.js', new Clock());
    assert.equal(api.evaluateFleetInvestment(scheduler(), 100, 1000).ok, true);
    assert.equal(api.evaluateFleetInvestment({ ...scheduler(), usedRam: 100 }, 100, 1000).ok, false);
    assert.equal(api.evaluateFleetInvestment({ ...scheduler(), pipelines: [{ mode: 'RECOVERING' }] }, 100, 1000).ok, false);
    assert.equal(api.evaluateFleetInvestment({ ...scheduler(), maxBatchRate: 1 }, 100, 1000).ok, false);
    assert.equal(api.evaluateFleetInvestment(scheduler(), 100, 1e12).ok, false);
    assert.equal(api.evaluateFleetInvestment(null, 100, 1000).ok, false);
});

test('fleet chooses a better-value existing upgrade over a new server and honors savings', async () => {
    const f = savingsFixture(), api = loadScript('fleet-manager.js', f.clock), ports = new Map([[17, new Port()], [13, new Port()]]);
    ports.get(17).write(scheduler());
    const actions = [];
    Object.assign(f.ns, { getPortHandle: p => ports.get(p), isRunning: () => true, getServerMoneyAvailable: () => 1e6,
        getServerMaxRam: () => 32, serverExists: () => false, scp: async () => {},
        cloud: { getServerNames: () => ['cloud-00'], getServerLimit: () => 2, getRamLimit: () => 64,
            getServerCost: ram => ram * 100, getServerUpgradeCost: () => 100,
            upgradeServer: (name, ram) => { actions.push([name, ram]); return true; }, purchaseServer: () => assert.fail('worse value') } });
    const cfg = { stockPort: 13, cloud: { roi: true, payback: 1800, minRam: 32, maxAction: 1, cashFloor: 0, cashReserve: 0, prefix: 'cloud' } };
    const state = { purchases: 0, upgrades: 0, spent: 0 };
    await f.api.writeSavings(f.ns, 1e6, 'Save it all');
    await api.manageOneCloudAction(f.ns, cfg, state);
    assert.equal(actions.length, 0);
    await f.api.writeSavings(f.ns, 0, 'Clear');
    await api.manageOneCloudAction(f.ns, cfg, state);
    assert.deepEqual(actions, [['cloud-00', 64]]);
    assert.equal(state.spent, 100);
    ports.get(17).peek().generatedAt -= 16000;
    await api.manageOneCloudAction(f.ns, cfg, state);
    assert.equal(actions.length, 1);
    assert.match(state.investment, /fresh/);
});

test('augmentation ordering includes prerequisites, avoids owned items and reports gaps', () => {
    const api = loadScript('lib/augmentation-plan.js', new Clock());
    const catalog = [
        { name: 'A', prerequisites: [], price: 100, repGap: 0 },
        { name: 'B', prerequisites: ['A'], price: 1000, repGap: 10 },
        { name: 'C', prerequisites: [], price: 200, repGap: 0 },
    ];
    const plan = api.planAugmentations(catalog, [], ['B', 'C'], 2);
    assert.equal(plan.order.map(a => a.name).join(','), 'C,A,B');
    assert.equal(plan.total, 4400);
    assert.equal(api.planAugmentations(catalog, ['A'], ['B']).next.name, 'B');
    assert.match(api.planAugmentations(catalog, [], ['missing']).errors.join(), /Unavailable/);
    assert.match(api.planAugmentations([{ name: 'loop', prerequisites: ['loop'], price: 1 }], [], ['loop']).errors.join(), /cycle/);
});

test('augmentation catalog selects the faction with the smallest rep gap and excludes purchased items', () => {
    const api = loadScript('lib/augmentation-plan.js', new Clock());
    const ns = { getPlayer: () => ({ factions: ['A', 'B'] }), singularity: {
        getOwnedAugmentations: purchased => { assert.equal(purchased, true); return ['Owned']; },
        getFactionRep: faction => faction === 'A' ? 5 : 25,
        getAugmentationsFromFaction: () => ['Owned', 'New', 'NeuroFlux Governor'],
        getAugmentationRepReq: () => 20, getAugmentationPrice: () => 100,
        getAugmentationPrereq: () => [], getAugmentationStats: () => ({ hacking: 1.1 }) } };
    const { catalog } = api.readAugmentationCatalog(ns);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].faction, 'B');
    assert.equal(catalog[0].repGap, 0);
});

test('telemetry is bounded, rate limited, ignores stale producers and survives restarts', async () => {
    const f = savingsFixture(), api = loadScript('lib/telemetry.js', f.clock), ports = new Map([17, 19, 13].map(p => [p, new Port()]));
    ports.get(17).write({ ...scheduler(), earned: 100 });
    Object.assign(f.ns, { getPortHandle: p => ports.get(p), isRunning: pid => pid === 7, getServerMoneyAvailable: () => 99 });
    const state = api.loadTelemetry(f.ns);
    state.samples = Array.from({ length: 1440 }, (_, at) => ({ at }));
    await api.recordTelemetry(f.ns, state, 19);
    assert.equal(state.samples.length, 1440);
    const stored = f.files.get('data/telemetry.json');
    await api.recordTelemetry(f.ns, state, 19);
    assert.equal(f.files.get('data/telemetry.json'), stored);
    const restored = api.loadTelemetry(f.ns);
    assert.equal(restored.samples.at(-1).jit.earned, 100);
    ports.get(17).peek().pid = 99;
    assert.equal(api.telemetrySnapshot(f.ns).jit, null);
    ports.get(17).peek().pid = 7;
    f.clock.now += 16000;
    assert.equal(api.telemetrySnapshot(f.ns).jit, null);
});

test('telemetry does not invent earnings across PID or reset boundaries, and write failure is recoverable', async () => {
    const f = savingsFixture(), api = loadScript('lib/telemetry.js', f.clock);
    const row = (at, epoch, pid, earned) => ({ at, epoch, jit: { pid, earned, targets: [] } });
    const report = api.summarizeTelemetry([row(0, 'A', 1, 10), row(1000, 'A', 1, 30), row(2000, 'A', 2, 100), row(3000, 'B', 2, 500)], 0);
    assert.equal(report.earnings, 20);
    assert.equal(report.observedSeconds, 1);
    Object.assign(f.ns, { getPortHandle: () => new Port(), getServerMoneyAvailable: () => 0, write: async () => { throw new Error('disk full'); } });
    const state = api.loadTelemetry(f.ns);
    await api.recordTelemetry(f.ns, state, 19);
    assert.match(state.error, /disk full/);
    assert.equal(state.samples.length, 0);
});

test('doctor reports missing imports, duplicate services and port conflicts without mutation', async () => {
    const api = loadScript('doctor.js', new Clock()), logs = [];
    const ns = { flags: pairs => Object.fromEntries(pairs), getHostname: () => 'home', ps: () => [
        { pid: 1, filename: 'fleet-manager.js', args: ['--port', 20] },
        { pid: 2, filename: 'fleet-manager.js', args: [] }],
        fileExists: file => file !== 'lib/missing.js', read: file => file === 'daemon.js' ? 'import { x } from "lib/missing.js";' : '',
        getScriptRam: () => 2, getServerMaxRam: () => 100, getServerUsedRam: () => 0,
        getPortHandle: () => new Port(), getResetInfo: () => ({ currentNode: 1, ownedSF: new Map() }), stock: {}, tprint: text => logs.push(text) };
    await api.main(ns);
    assert.ok(logs.some(s => s.includes('Missing lib/missing.js')));
    assert.ok(logs.some(s => s.includes('Duplicate fleet-manager')));
    assert.ok(logs.some(s => s.includes('Port 20 collision')));
});
