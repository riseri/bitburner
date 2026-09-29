const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture(extra = {}) {
    const clock = new Clock(), api = loadScript('lib/milestone-balance.js', clock), state = {};
    const objective = { resetEpoch: '4:1:2', milestone: 'DAEDALUS', limitingResource: 'hacking',
        requiredHacking: 2500, currentHacking: 410, requiredCash: 100e9, availableProgressionCash: 15e9,
        remainingCash: 85e9, moneyCovered: false };
    const input = { objective, level: 410, remainingXp: 85e6, cash: { rate: 50e6, source: 'measured' },
        xp: { rate: 50e3, source: 'measured' }, baseline: .4, enabled: true, safe: true, ...extra };
    const tick = (ms = 0) => { clock.now += ms; return api.balanceMilestone(state, { ...input, now: clock.now }); };
    return { api, clock, state, objective, input, tick };
}

test('balanced cash and hacking ETAs hold allocation and report normalized cash only once', () => {
    const f = fixture(); f.tick(); const result = f.tick(120000);
    assert.equal(result.cashEtaMs, 1700000); assert.equal(result.hackingEtaMs, 1700000);
    assert.equal(result.xpAllocation, .4); assert.match(result.reason, /balanced/);
});

for (const [name, xpRate, expected] of [['hacking behind', 20000, .5], ['cash behind', 200000, .3]]) {
    test(`${name} moves at most ten percentage points after sustained observation and cooldown`, () => {
        const f = fixture(); f.input.xp.rate = xpRate; f.tick();
        assert.equal(f.tick(60000).xpAllocation, .4);
        assert.ok(Math.abs(f.tick(60000).xpAllocation - expected) < 1e-9);
        assert.ok(Math.abs(f.tick(1000).xpAllocation - expected) < 1e-9);
    });
}

test('uncovered cash can open an XP lane only when hacking is behind', () => {
    const f = fixture({ baseline: 0 }); f.input.xp.rate = 20000;
    f.tick(); assert.equal(f.tick(120000).xpAllocation, .1);
    assert.equal(f.objective.moneyCovered, false);
    const money = fixture({ baseline: 0 }); money.input.xp.rate = 200000;
    money.tick(); assert.equal(money.tick(120000).xpAllocation, 0);
});

test('bootstrap, tiny fleets, recovery and reset/install safety suppress dynamic allocation', () => {
    for (const extra of [{ safe: false }, { enabled: false }, { level: 2500 }, { remainingXp: 0 }]) {
        const f = fixture(extra); f.input.xp.rate = 1; f.tick();
        assert.equal(f.tick(120000).xpAllocation, 0);
    }
    const f = fixture(); f.objective.resetImminent = true;
    assert.equal(f.tick().xpAllocation, 0);
});

test('generic hacking-only milestone can rise above the old fallback but never to 100%', () => {
    const f = fixture({ baseline: .7 }); Object.assign(f.objective, { milestone: 'GENERIC_HACK', requiredCash: 0, remainingCash: 0 });
    f.input.cash.rate = null; f.tick();
    assert.ok(Math.abs(f.tick(120000).xpAllocation - .8) < 1e-9);
    for (let i = 0; i < 10; i++) f.tick(120000);
    assert.equal(f.state.allocation, .85);
});

for (const field of ['cash', 'xp']) test(`unknown ${field} ETA retains conservative fallback`, () => {
    const f = fixture(); f.input[field] = { rate: null, source: 'UNKNOWN' };
    f.tick(); const result = f.tick(120000);
    assert.equal(result.xpAllocation, .4); assert.equal(result.confidence, 'fallback');
    assert.equal(result[field === 'cash' ? 'cashEtaMs' : 'hackingEtaMs'], null);
});

test('short direction reversals and noisy measured rates cannot flap allocation or be concealed by a model', () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) { f.input.xp.rate = i % 2 ? 200000 : 20000; assert.equal(f.tick(10000).xpAllocation, .4); }
    assert.equal(f.api.milestoneRate([1, 100, 1], 50).rate, null);
    assert.equal(f.api.milestoneRate([0, 0, 0], 50).rate, null);
    assert.equal(f.api.milestoneRate([], 50).rate, 50);
    assert.equal(f.api.milestoneRate([40, 40, 40], 50).rate, 40);
});

test('objective and augmentation/BitNode reset identities clear allocation history', () => {
    for (const change of [{ milestone: 'NEXT' }, { resetEpoch: '4:1:3' }, { resetEpoch: '5:4:4' }, { requiredHacking: 3000 }]) {
        const f = fixture(); f.input.xp.rate = 20000; f.tick(); f.tick(120000);
        assert.equal(f.state.allocation, .5);
        Object.assign(f.objective, change); assert.equal(f.tick(1).xpAllocation, .4);
        assert.equal(f.tick(60000).xpAllocation, .4);
    }
});

test('XP and income delta sampling rejects reset, negative, stale, and invalid observations', () => {
    const f = fixture(), state = {};
    const observe = (now, xp, key = 'a') => f.api.observeMilestoneRates(state, { key, now, xp,
        income: [{ time: now, money: 1000 }] });
    observe(0, 0); observe(20000, 200); observe(40000, 400); observe(60000, 600);
    assert.equal(f.api.milestoneRate(state.xp).rate, 10);
    assert.equal(f.api.milestoneRate(state.money).rate, 50);
    observe(80000, 10); assert.equal(state.xp.length, 0);
    observe(100000, 100, 'reset'); assert.equal(state.xp.length, 0);
    observe(200000, 10000, 'reset'); assert.equal(state.xp.length, 0);
    observe(220000, NaN, 'reset'); observe(240000, 20000, 'reset'); assert.equal(state.xp.length, 0);
});

test('long action bins use cumulative income without mistaking regular polling for stale samples', () => {
    const f = fixture(), state = {};
    for (let now = 0; now <= 360000; now += 10000)
        f.api.observeMilestoneRates(state, { key: 'a', now, xp: now, money: now * 10, sampleMs: 120000 });
    assert.equal(f.api.milestoneRate(state.money).rate, 10000);
    assert.equal(f.api.milestoneRate(state.xp).rate, 1000);
});

test('university increases milestone XP rate without changing the script RAM model', () => {
    const f = fixture(), xp = loadScript('lib/hacking-xp.js', f.clock);
    let totalXp = 0;
    const lane = { name: 'money', generation: 1, mode: 'RUNNING', stats: { pipeline: { completed: 1 }, money: 0, lastHackAt: f.clock.now },
        runtime: { plan: { expected: 100, times: { W: 1000 } } } };
    const pool = { cfg: { progressionObjective: f.objective, prepStates: [] }, pipelines: new Map([['money', lane]]),
        xp: { samples: [], status: 'RUNNING', choice: { score: 100, ram: 10 }, jobs: new Map([[1, { ram: 10 }]]) } };
    for (let i = 0; i <= 6; i++) {
        xp.refreshMilestoneEvidence({ getPlayer: () => ({ exp: { hacking: totalXp } }) }, pool);
        totalXp += 10000; lane.stats.money += 1000; f.clock.now += 10000; lane.stats.lastHackAt = f.clock.now;
    }
    assert.equal(pool.cfg.milestoneEvidence.xp.rate, 1000);
    assert.equal(pool.cfg.milestoneEvidence.scriptXpRate, 100);
    assert.equal(pool.cfg.milestoneEvidence.cash.rate, 100);
});

function livePolicyFixture() {
    const f = fixture(), api = loadScript('lib/hacking-policy.js', f.clock), ports = new Map();
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map([[5, 1]]) };
    const mults = { ScriptHackMoney: 1, ScriptHackMoneyGain: 1, HackExpGain: 1, HackingLevelMultiplier: 1,
        HackingSpeedMultiplier: 1, ServerMaxMoney: 1, ServerStartingMoney: 1, ServerGrowthRate: 1, ServerStartingSecurity: 1 };
    let homeRam = 128, workerRam = 2048, cash = 15e9, formulas = true;
    const ns = { getResetInfo: () => reset, getHackingLevel: () => 410,
        getPlayer: () => ({ skills: { hacking: 410 }, exp: { hacking: 1000 }, mults: { hacking: 1 } }),
        getServerMaxRam: () => homeRam, getServerMoneyAvailable: () => cash, getBitNodeMultipliers: () => mults,
        fileExists: file => file !== 'Formulas.exe' || formulas, read: () => '', isRunning: () => true,
        ps: () => [{ pid: 7, filename: 'augmentation-manager.js' }],
        getPortHandle: port => { if (!ports.has(port)) ports.set(port, new Port()); return ports.get(port); },
        formulas: { hacking: Object.fromEntries(['hackExp','hackChance','hackPercent','hackTime','growTime','weakenTime','weakenEffect','growThreads'].map(k => [k, () => 1])),
            skills: { calculateExp: () => 85e6 + 1000 } } };
    const cfg = {};
    const refresh = () => {
        const objective = { ...f.objective, type: 'progression-objective', version: 1, generatedAt: f.clock.now,
            producer: 'augmentation-manager.js', producerPid: 7 };
        const portApi = loadScript('lib/ports.js', f.clock);
        const status = ns.getPortHandle(portApi.PORTS.AUGMENTATION_STATUS);
        status.clear(); status.write({ type: 'augmentation-status', version: 1, producerPid: 7,
            generatedAt: f.clock.now, resetEpoch: objective.resetEpoch, progression: objective });
        cfg.milestoneEvidence = { key: f.api.milestoneKey(objective), generatedAt: f.clock.now, safe: true,
            cash: f.input.cash, xp: { rate: 20000, source: 'measured' }, scriptXpRate: 5000 };
        return api.refreshHackingPolicy(ns, cfg, { hosts: [{ name: 'worker', maxRam: workerRam }] }, true);
    };
    return { ...f, ns, cfg, refresh, set: options => { homeRam = options.homeRam ?? homeRam; workerRam = options.workerRam ?? workerRam;
        cash = options.cash ?? cash; formulas = options.formulas ?? formulas; } };
}

test('authenticated uncovered milestone reaches the real policy; no Formulas and tiny fleet stay safe', () => {
    const f = livePolicyFixture(); assert.equal(f.refresh().xpAllocation, 0);
    f.clock.now += 120000; const p = f.refresh(); assert.equal(p.mode, 'XP'); assert.equal(p.xpAllocation, .1);
    for (const options of [{ formulas: false }, { formulas: true, workerRam: 8 }, { workerRam: 2048, homeRam: 8 }, { homeRam: 128, cash: 1 }]) {
        f.set(options); assert.equal(f.refresh().xpAllocation, 0);
    }
});

test('reserve floors prevent pre-cash XP even with favorable milestone ETAs', () => {
    const f = livePolicyFixture(); f.ns.read = () => JSON.stringify({ version: 1, epoch: '4:1:2', amount: 20e9, target: 'critical', label: 'Critical purchase' });
    f.refresh(); f.clock.now += 120000; assert.equal(f.refresh().xpAllocation, 0);
    f.ns.read = () => ''; f.cfg.cloudState = { reserveFloor: 20e9 }; assert.equal(f.refresh().xpAllocation, 0);
    f.cfg.cloudState.reserveFloor = 0;
    f.ns.getPortHandle(13).write({ type: 'stock-status', access: { ok: true }, producerPid: 8, generatedAt: f.clock.now, reserveFloor: 20e9 });
    assert.equal(f.refresh().xpAllocation, 0);
});

test('compact balance rendering is one summary; details expose requirements and evidence', () => {
    const f = fixture(), policy = loadScript('lib/hacking-policy.js', f.clock), lines = [];
    policy.renderMilestoneBalance({ print: s => lines.push(s) }, f.tick(), false);
    assert.match(lines.join('\n'), /Milestone ETA.*DAEDALUS/); assert.doesNotMatch(lines.join('\n'), /Cash goal/);
    policy.renderMilestoneBalance({ print: s => lines.push(s) }, f.tick(), true);
    assert.match(lines.join('\n'), /Cash goal/); assert.match(lines.join('\n'), /ETA evidence/);
});

test('temporary preparation suspends application without learning a false ETA imbalance', () => {
    const f = fixture(); f.input.xp.rate = 20000; f.tick(); f.tick(120000);
    f.input.safe = false; const suspended = f.tick(1000);
    assert.equal(suspended.xpAllocation, 0); assert.equal(suspended.requestedXpAllocation, .5);
    f.input.safe = true; assert.equal(f.tick(1000).xpAllocation, .5);
    assert.equal(f.tick(30000).xpAllocation, .5);
});

test('lost evidence decays toward fallback in bounded steps instead of flipping allocation', () => {
    const f = fixture(); f.input.xp.rate = 10000; f.tick(); f.tick(120000); f.tick(120000); f.tick(120000);
    f.input.xp.rate = null;
    assert.ok(Math.abs(f.tick(120000).xpAllocation - .6) < 1e-9);
    assert.ok(Math.abs(f.tick(1000).xpAllocation - .6) < 1e-9);
    assert.ok(Math.abs(f.tick(120000).xpAllocation - .5) < 1e-9);
});

test('newly covered cash restores conservative XP while measurement warms up', () => {
    const f = fixture({ baseline: 0 }); f.input.xp.rate = null; f.tick();
    f.objective.moneyCovered = true; f.objective.remainingCash = 0; f.input.baseline = .4;
    assert.equal(f.tick(120000).xpAllocation, .1);
    assert.equal(f.tick(120000).xpAllocation, .2);
});
