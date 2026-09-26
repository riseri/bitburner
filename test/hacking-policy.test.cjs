const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');
const clock = new Clock();
const policy = loadScript('lib/hacking-policy.js', clock);
const xp = loadScript('lib/hacking-xp.js', clock);
const normal = { ScriptHackMoney: 1, ScriptHackMoneyGain: 1, HackExpGain: 1, HackingLevelMultiplier: 1,
    HackingSpeedMultiplier: 1, ServerMaxMoney: 1, ServerStartingMoney: 1, ServerGrowthRate: 1, ServerStartingSecurity: 1 };
const penalized = { ...normal, ScriptHackMoney: .15, HackExpGain: .5 };
const cfg = () => ({ requestedTarget: 'auto', maxSteal: .5, maxLaunches: 32, maxWorkers: 6000, gap: 100, port: 20 });
const capabilities = (multipliers = normal, formulas = true) => ({ currentNode: 99, formulas, bitNodeMultipliers: !!multipliers, multipliers });
const evaluate = (multipliers, extra = {}) => policy.evaluateHackingPolicy({ capabilities: capabilities(multipliers), level: 731, ...extra });

test('policy derives modes and explicit viability from multipliers, independently of node number', () => {
    assert.equal(evaluate(normal).mode, 'NORMAL');
    assert.equal(evaluate({ ...normal, ScriptHackMoney: 2 }).mode, 'MONEY');
    assert.equal(evaluate(penalized).mode, 'XP');
    assert.equal(evaluate({ ...normal, ScriptHackMoneyGain: 0 }).mode, 'XP');
    assert.equal(evaluate({ ...normal, ServerMaxMoney: .1 }).mode, 'XP');
    assert.equal(evaluate({ ...normal, ServerGrowthRate: .1 }).mode, 'XP');
    const hostile = evaluate({ ...normal, ScriptHackMoney: .1, HackExpGain: .05, HackingLevelMultiplier: .3 });
    assert.equal(hostile.mode, 'HOSTILE'); assert.equal(hostile.operationalMode, 'NORMAL');
    assert.equal(hostile.moneyViability, 'POOR'); assert.equal(hostile.xpViability, 'POOR');
    assert.match(hostile.reason, /money=0.1.*XP=0.05.*level=0.3/);
    assert.equal(evaluate({ ...penalized, HackingLevelMultiplier: .1 }).mode, 'HOSTILE');
    assert.equal(evaluate({ ...normal, HackingSpeedMultiplier: .01 }).mode, 'HOSTILE');
    assert.equal(evaluate(penalized, { level: 2500 }).mode, 'NORMAL');
    assert.equal(evaluate(penalized, { bootstrap: ['small fleet'] }).mode, 'NORMAL');
    assert.equal(evaluate(penalized, { capabilities: capabilities(penalized, false) }).mode, 'NORMAL');
    assert.equal(evaluate(null).mode, 'NORMAL');
});

test('fresh BN1 never invokes SF5 or Formulas APIs; denied and partial capabilities fail safely', () => {
    let calls = 0;
    const ns = { getResetInfo: () => ({ currentNode: 1, ownedSF: new Map() }), fileExists: () => false,
        getBitNodeMultipliers() { calls++; throw new Error('locked'); },
        get formulas() { throw new Error('must not access formulas'); } };
    assert.equal(policy.detectHackingCapabilities(ns).formulas, false);
    assert.equal(calls, 0);
    ns.getResetInfo = () => ({ currentNode: 5, ownedSF: new Map() });
    assert.equal(policy.detectHackingCapabilities(ns).bitNodeMultipliers, false);
    assert.equal(calls, 1);
    ns.getBitNodeMultipliers = () => ({ ScriptHackMoney: 1 });
    assert.equal(policy.detectHackingCapabilities(ns).bitNodeMultipliers, false);
});

function fixture() {
    const player = { skills: { hacking: 731 }, exp: { hacking: 1000 }, mults: { hacking: 2, hacking_exp: 1 } };
    const server = { hostname: 'alpha', requiredHackingSkill: 1, hasAdminRights: true, purchasedByPlayer: false,
        baseDifficulty: 10, moneyMax: 1e6, moneyAvailable: 1e5, hackDifficulty: 20, minDifficulty: 1 };
    const state = { formulas: true, cash: 1e10, homeRam: 128, missing: '', multiplierCalls: 0 };
    const ports = new Map();
    const api = { hackExp: s => 3 + .3 * s.baseDifficulty, hackChance: () => .2, hackPercent: () => .01,
        hackTime: () => 1000, growTime: () => 3200, weakenTime: () => 4000,
        growThreads: s => (s.moneyMax - s.moneyAvailable) / 20000,
        weakenEffect: (t, c) => t * .05 * (1 + (c - 1) / 16) };
    const ns = { getResetInfo: () => ({ currentNode: 5, ownedSF: new Map(), lastNodeReset: 1, lastAugReset: 2 }),
        fileExists: file => file === 'Formulas.exe' ? state.formulas : file !== state.missing,
        getBitNodeMultipliers: () => { state.multiplierCalls++; return penalized; },
        getPlayer: () => player, getHackingLevel: () => player.skills.hacking, getServer: () => server,
        getServerMaxRam: () => state.homeRam, getServerMoneyAvailable: () => state.cash, read: () => '',
        getServerUsedRam: () => 0, getScriptRam: () => 2, isRunning: () => true,
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        hackAnalyzeSecurity: t => t * .002, growthAnalyzeSecurity: t => t * .004,
        formulas: { hacking: api, skills: { calculateExp: (_skill, mult) => 10000 / mult } } };
    const network = { hosts: [{ name: 'remote', maxRam: 2048, cores: 1 }], servers: ['alpha'] };
    return { ns, api, state, server, player, network };
}

test('bootstrap checks actual infrastructure, programs, shared savings and stock reserves with cash hysteresis', () => {
    const f = fixture(), c = cfg();
    const refresh = () => policy.refreshHackingPolicy(f.ns, c, f.network, true);
    assert.equal(refresh().mode, 'XP');
    f.state.homeRam = 8; assert.match(refresh().reason, /home RAM/); f.state.homeRam = 128;
    f.network.hosts[0].maxRam = 128; assert.match(refresh().reason, /worker RAM/); f.network.hosts[0].maxRam = 2048;
    f.state.missing = 'SQLInject.exe'; assert.match(refresh().reason, /programs missing/); f.state.missing = '';
    f.state.cash = 110e6; assert.equal(refresh().mode, 'NORMAL'); // entry buffer
    f.state.cash = 130e6; assert.equal(refresh().mode, 'XP');
    f.state.cash = 110e6; assert.equal(refresh().mode, 'XP'); // exit floor
    f.state.cash = 90e6; assert.equal(refresh().mode, 'NORMAL');
    f.state.cash = 1e10;
    f.ns.read = () => JSON.stringify({ version: 1, epoch: '5:1:2', amount: 1e12, target: '', label: 'next purchase' });
    assert.match(refresh().reason, /cash below/); f.ns.read = () => '';
    f.ns.getPortHandle(13).tryWrite({ type: 'stock-status', access: { ok: true }, producerPid: 42,
        generatedAt: clock.now, reserveFloor: 1e12 });
    assert.match(refresh().reason, /cash below/);
});

test('policy rescoring is bounded, capabilities refresh, and the XP target exits without a 30s wait', () => {
    const f = fixture(), c = cfg();
    assert.equal(policy.refreshHackingPolicy(f.ns, c, f.network).mode, 'XP');
    const calls = f.state.multiplierCalls;
    for (let i = 0; i < 100; i++) policy.refreshHackingPolicy(f.ns, c, f.network);
    assert.equal(f.state.multiplierCalls, calls);
    clock.now += 1001; f.player.skills.hacking = 2500;
    assert.equal(policy.refreshHackingPolicy(f.ns, c, f.network).mode, 'NORMAL');
    clock.now += 30001; f.player.skills.hacking = 731; f.state.formulas = false;
    assert.equal(policy.refreshHackingPolicy(f.ns, c, f.network).mode, 'NORMAL');
    clock.now += 30001; f.state.formulas = true;
    assert.equal(policy.refreshHackingPolicy(f.ns, c, f.network).mode, 'XP');
});

test('scoring uses prepped local copies, base difficulty, failure XP, measured worker costs and repair time', () => {
    const f = fixture(), original = JSON.stringify(f.server), c = cfg();
    const hosts = [{ name: 'remote', cores: 1, free: 64, ram: { H: 2, G: 2, W: 2 } }];
    const oldExp = f.api.hackExp;
    f.api.hackExp = s => { assert.equal(s.hackDifficulty, 1); assert.equal(s.moneyAvailable, s.moneyMax); return oldExp(s); };
    const ranked = xp.scoreXpTargets(f.ns, ['alpha'], hosts, c);
    assert.equal(JSON.stringify(f.server), original);
    assert.equal(xp.selectXpTarget(ranked).action, 'G');
    const hack = ranked.find(r => r.action === 'H');
    assert.equal(hack.rawXpPerSecond, 6 * 32 * (.25 + .75 * .2));
    assert.ok(hack.score < hack.rawXpPerSecond, 'raw H throughput must pay for repairs');
    assert.equal(ranked.find(r => r.action === 'G').xpPerGb, (6 * 32 / 3.45) / 64);
    hosts[0].ram.G = 16;
    assert.equal(xp.selectXpTarget(xp.scoreXpTargets(f.ns, ['alpha'], hosts, c)).action, 'W');
    f.api.hackChance = () => 1; f.api.hackPercent = () => .0001; f.api.growThreads = () => 1;
    hosts[0] = { name: 'remote', cores: 1, free: 1024, ram: { H: 1, G: 10, W: 5 } };
    assert.equal(xp.selectXpTarget(xp.scoreXpTargets(f.ns, ['alpha'], hosts, c)).action, 'H');
});

test('candidate filtering honors root, level, purchased hosts, home, money and explicit target', () => {
    const f = fixture(), c = cfg(), host = [{ name: 'remote', cores: 1, free: 64, ram: { H: 2, G: 2, W: 2 } }];
    for (const patch of [{ hostname: 'home' }, { hasAdminRights: false }, { purchasedByPlayer: true },
        { requiredHackingSkill: 1000 }, { moneyMax: 0 }, { minDifficulty: 100 }]) {
        f.ns.getServer = () => ({ ...f.server, ...patch });
        assert.equal(xp.scoreXpTargets(f.ns, ['alpha'], host, c).length, 0);
    }
    f.ns.getServer = () => f.server; c.requestedTarget = 'beta';
    assert.equal(xp.scoreXpTargets(f.ns, ['alpha'], host, c).length, 0);
    c.requestedTarget = 'auto'; f.state.formulas = false;
    f.ns.formulas = new Proxy({}, { get() { throw new Error('locked API'); } });
    assert.equal(xp.scoreXpTargets(f.ns, ['alpha'], host, c).length, 0);
});

test('capacity uses per-host script prices, excludes home/foreign RAM, and does not lose owned RAM on rescore', () => {
    const f = fixture(); f.ns.getServerUsedRam = () => 100; f.ns.getScriptRam = (_file, host) => host === 'remote' ? 7 : 999;
    f.network.hosts.push({ name: 'home', maxRam: 1024 });
    const hosts = xp.xpCapacity(f.ns, f.network, cfg(), new Map([[20, { host: 'remote', ram: 50 }]]));
    assert.equal(hosts.length, 1); assert.equal(hosts[0].free, 1998); assert.equal(hosts[0].ram.G, 7);
});

test('target hysteresis keeps small improvements, switches material improvements and drops invalid incumbents', () => {
    const old = { name: 'alpha', action: 'G', score: 100 };
    assert.equal(xp.selectXpTarget([{ name: 'beta', action: 'G', score: 104 }, old], old).name, 'alpha');
    assert.equal(xp.selectXpTarget([{ name: 'beta', action: 'G', score: 110 }, old], old).name, 'beta');
    assert.equal(xp.selectXpTarget([{ name: 'beta', action: 'W', score: 50 }], old).name, 'beta');
    assert.equal(xp.selectXpTarget([{ name: 'alpha', action: 'H', score: 101 }, { name: 'alpha', action: 'G', score: 100 }]).action, 'G');
});

test('ETA uses player hacking multiplier times BitNode level multiplier and rejects unreliable rates', () => {
    const f = fixture(); let used;
    f.ns.formulas.skills.calculateExp = (level, mult) => { used = { level, mult }; return 10000; };
    const p = evaluate({ ...penalized, HackingLevelMultiplier: .5 });
    const progress = policy.hackingXpProgress(f.ns, p, 100);
    assert.deepEqual(used, { level: 2500, mult: 1 }); assert.equal(progress.remaining, 9000); assert.equal(progress.etaMs, 90000);
    for (const rate of [0, null, Infinity, NaN]) assert.equal(policy.hackingXpProgress(f.ns, p, rate).etaMs, null);
    assert.equal(xp.stableXpRate([100, 101], 100), null);
    assert.equal(xp.stableXpRate([100, 101, 99], 100), 100);
    assert.equal(xp.stableXpRate([100, 1000, 99], 100), null);
    assert.equal(xp.stableXpRate([500, 500, 500], 100), null);
    f.ns.formulas.skills.calculateExp = () => Infinity;
    assert.equal(policy.hackingXpProgress(f.ns, p, 100), null);
});

test('real exponential skill requirements produce a forecast warning in both dashboards, not astronomical hours', () => {
    const f = fixture(), p = evaluate(penalized), supervisor = loadScript('supervisor.js', clock);
    // The game's inverse skill curve, rather than the small linear fixture.
    f.ns.formulas.skills.calculateExp = (level, mult) => Math.max(0, Math.exp((level / mult + 200) / 32) - 534.6);
    f.player.mults.hacking = 1;
    f.player.exp.hacking = f.ns.formulas.skills.calculateExp(f.player.skills.hacking, 1);
    const progress = policy.hackingXpProgress(f.ns, p, 1e6);
    assert.ok(progress.required > 4e36);
    assert.equal(progress.skillMultiplier, 1);
    assert.equal(progress.etaMs, null);
    assert.equal(progress.etaReason, 'beyond 7d forecast at current stats');
    for (const render of [ns => policy.renderHackingPolicy(ns, { ...p, progress }),
        ns => supervisor.renderExperienceStatus(ns, { policy: { ...p, progress } })]) {
        const logs = []; render({ print: line => logs.push(line) });
        assert.match(logs.find(line => /XP ETA/.test(line)), /beyond 7d forecast at current stats/);
        assert.match(logs.find(line => /XP skill mult/.test(line)), /1\.00x/);
    }
    // New multipliers must recalculate the target rather than retaining the warning.
    f.player.mults.hacking = 5;
    f.player.exp.hacking = f.ns.formulas.skills.calculateExp(f.player.skills.hacking, 5);
    const upgraded = policy.hackingXpProgress(f.ns, p, 1e6);
    assert.ok(upgraded.etaMs > 0 && upgraded.etaMs < 3_600_000);
    assert.equal(upgraded.etaReason, null);
});

test('ETA horizon is configurable and distinguishes slow progress, warmup, overflow and completion', () => {
    const f = fixture(), p = evaluate(penalized), options = { ...policy.HACKING_POLICY, xpEtaHorizonDays: 1 };
    f.ns.formulas.skills.calculateExp = () => f.player.exp.hacking + 86400;
    const progress = rate => policy.hackingXpProgress(f.ns, p, rate, options);
    assert.equal(progress(1).etaMs, 86_400_000);
    assert.equal(progress(.5).etaReason, 'beyond 1d forecast at current stats');
    assert.equal(progress(Number.MIN_VALUE).etaReason, 'beyond 1d forecast at current stats');
    assert.equal(progress(null).etaReason, 'unavailable (prep, warmup or unstable rate)');
    f.ns.formulas.skills.calculateExp = () => f.player.exp.hacking;
    assert.equal(progress(null).etaMs, 0);
    assert.equal(progress(null).etaReason, null);
    f.player.mults.hacking = Infinity;
    assert.equal(progress(1), null);
});

test('policy changes never drain or cancel the primary money pipeline', () => {
    const multi = loadScript('lib/target-pipelines.js', clock);
    const p = { queue: [1], running: new Map([[2, {}]]), batches: new Map([['b', {}]]) };
    const pool = { api: { refreshHackingPolicy: () => ({ mode: 'XP' }) }, cfg: { prepStates: [] }, network: {},
        pipelines: new Map([['alpha', p]]), port: new Port(), running: new Map([[2, {}]]) };
    multi.serviceHackingPolicy({}, pool); assert.equal(pool.policyDraining, undefined);
    assert.equal(p.queue.length, 1, 'do not cancel committed work just to change objectives');
    assert.equal(p.running.size, 1); assert.equal(p.batches.size, 1);
});

test('a partial XP launch failure preserves already-launched PID ownership', () => {
    const f = fixture(), running = new Map(); f.server.hackDifficulty = 1; f.server.moneyAvailable = f.server.moneyMax;
    f.ns.getGrowTime = () => 3200; f.ns.pid = 1;
    f.ns.exec = (_file, host) => { if (host === 'removed') throw new Error('host removed'); return 42; };
    const hosts = ['remote', 'removed'].map(name => ({ name, free: 32, cores: 1, ram: { H: 2, G: 2, W: 2 } }));
    const wave = xp.launchXpWave(f.ns, { cfg: cfg(), port: new Port() }, { name: 'alpha', action: 'G' }, hosts, running, 1, false, policy.HACKING_POLICY);
    assert.equal(wave.launched, 1); assert.equal(running.get(42).host, 'remote'); assert.equal(running.get(42).ram, 32);
});

test('supervisor displays current XP status without treating it as a money pipeline', () => {
    const supervisor = loadScript('supervisor.js', clock), logs = [];
    const snapshot = { type: 'jit-status', version: 2, pid: 42, generatedAt: clock.now, mode: 'experience', pipelines: [],
        policy: { mode: 'XP', reason: 'viable XP', xp: { target: 'alpha', action: 'G', state: 'RUNNING', estimatedXpPerSecond: 100 } } };
    const ns = { ps: () => [{ filename: 'daemon.js', pid: 42 }], getPortHandle: () => ({ peek: () => snapshot }), print: line => logs.push(line) };
    assert.equal(supervisor.readDaemonDashboard(ns), snapshot);
    supervisor.renderMoneyEngine(ns, snapshot);
    assert.ok(logs.some(line => /XP work.*alpha.*G/.test(line)));
});

test('supervisor keeps both money and XP information when the primary uses the single-target dashboard', () => {
    const supervisor = loadScript('supervisor.js', clock), logs = [];
    const snapshot = { type: 'jit-status', version: 2, pid: 42, generatedAt: clock.now, mode: 'running', pipelines: [],
        policy: { mode: 'XP', reason: 'spare RAM', xp: { target: 'alpha', action: 'G', state: 'RUNNING' } } };
    const ns = { ps: () => [{ filename: 'daemon.js', pid: 42 }], getPortHandle: () => ({ peek: () => snapshot }),
        getScriptLogs: () => ['JIT DAEMON :: money :: hacking 731', 'Income 60s $100/s'], print: line => logs.push(line) };
    const dashboard = supervisor.readDaemonDashboard(ns);
    assert.equal(dashboard.policy, snapshot.policy);
    supervisor.renderMoneyEngine(ns, dashboard);
    assert.ok(logs.some(line => /Income 60s.*\$100\/s/.test(line)));
    assert.ok(logs.some(line => /XP work.*alpha.*G/.test(line)));
});

