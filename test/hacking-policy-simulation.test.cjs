const test = require('node:test');
const assert = require('node:assert/strict');
const { NetscriptSimulation } = require('./simulator.cjs');

// Extend the existing simulator only for policy scenarios. In particular its
// conservative money-batch grow model fortifies even at the cap; XP scenarios
// below implement the current game's no-fortification-at-cap rule.
function policySimulation(multipliers = {}) {
    const sim = new NetscriptSimulation({ target: 'n00dles', weakenTime: 8000, hostCount: 3, levelPerMinute: 0,
        mainServer: { max: 1.75e6, money: 1.75e6, sec: 1, min: 1, required: 1, chance: 1 },
        backgroundTargets: { 'xp-target': { max: 1e6, money: 1e6, sec: 1, min: 1, required: 1, chance: 1 } },
        flags: { 'max-targets': 1, 'background-prep': false } });
    const state = { formulas: false, level: 450, exp: 1e6, cash: 1e12, sf5: true,
        mults: { ScriptHackMoney: .15, ScriptHackMoneyGain: 1, HackExpGain: .5, HackingLevelMultiplier: 1,
            HackingSpeedMultiplier: 1, ServerMaxMoney: 1, ServerStartingMoney: 1, ServerGrowthRate: 1, ServerStartingSecurity: 1, ...multipliers } };
    for (const [host, spec] of sim.hosts) if (host !== 'home') spec.ram = 8192;
    sim.level = () => state.level;
    const original = sim.ns.bind(sim);
    sim.ns = process => {
        const ns = original(process);
        ns.getResetInfo = () => ({ currentNode: 1, ownedSF: new Map(state.sf5 ? [[5, 1]] : []) });
        ns.getBitNodeMultipliers = () => { assert.ok(state.sf5); return state.mults; };
        ns.getPlayer = () => ({ skills: { hacking: state.level }, exp: { hacking: state.exp }, mults: { hacking: 2, hacking_exp: 1 } });
        ns.fileExists = file => file !== 'Formulas.exe' || state.formulas;
        ns.read = () => '';
        const money = ns.getServerMoneyAvailable;
        ns.getServerMoneyAvailable = host => host === 'home' ? state.cash : money(host);
        ns.getServer = host => {
            const s = sim.servers.get(host);
            return { hostname: host, cpuCores: sim.hosts.get(host)?.cores || 1, purchasedByPlayer: !s && host !== 'home',
                hasAdminRights: true, requiredHackingSkill: s?.required || 1, moneyMax: s?.max || 0,
                moneyAvailable: s?.money || 0, hackDifficulty: s?.sec || 1, minDifficulty: s?.min || 1, baseDifficulty: 10 };
        };
        const formulaTime = (phase, s) => sim.duration(phase, s.hostname) * (2.5 * s.requiredHackingSkill * s.hackDifficulty + 500) /
            (2.5 * s.requiredHackingSkill * sim.servers.get(s.hostname).sec + 500);
        ns.formulas = { hacking: {
            hackExp: () => 6, hackChance: () => 1,
            hackPercent: s => state.mults.ScriptHackMoney === 0 ? 0 : sim.perThread(s.hostname) * (100 - s.hackDifficulty) / (100 - sim.servers.get(s.hostname).sec),
            hackTime: s => formulaTime('H', s), growTime: s => formulaTime('G', s), weakenTime: s => formulaTime('W', s),
            weakenEffect: (t, c) => t * .05 * (1 + (c - 1) / 16),
            growThreads: (s, _p, goal, cores = 1) => Math.log(goal / Math.max(1, s.moneyAvailable)) / sim.growthLog(s.hostname) / (1 + (cores - 1) / 16),
        }, skills: { calculateExp: () => 1e10 } };
        if (state.mults.ScriptHackMoney === 0) ns.hackAnalyze = () => 0;
        for (const action of ['grow', 'weaken']) {
            const execute = ns[action];
            ns[action] = async (target, options) => {
                const server = sim.servers.get(target), atCap = server.money >= server.max;
                const result = await execute(target, options);
                if (String(process.args?.[2]).startsWith('bgprep-xp-')) {
                    if (action === 'grow' && atCap) server.sec = server.min;
                    state.exp += 6 * process.threads;
                }
                return result;
            };
        }
        return ns;
    };
    return { sim, state };
}

test('XP runs on spare RAM alongside continuous money batches, then exits without restarting money', async () => {
    const { sim, state } = policySimulation();
    state.formulas = true; state.mults.ScriptHackMoney = 1;
    sim.clock.timer(30000, () => state.mults.ScriptHackMoney = .15);
    sim.clock.timer(90000, () => state.level = 2500);
    sim.run(); await sim.clock.runUntil(sim.start + 135000);
    assert.deepEqual(sim.errors.map(String), []);
    assert.ok(sim.snapshots.some(s => s.policy?.mode === 'NORMAL'));
    assert.ok(sim.snapshots.some(s => s.policy?.mode === 'XP' && s.policy?.xp?.target === 'xp-target'));
    assert.ok(!sim.snapshots.some(s => s.mode === 'experience'));
    const xpActions = sim.actions.filter(a => a.phase === 'BG-G');
    assert.ok(xpActions.length > 0);
    assert.ok(xpActions.every(a => a.target === 'xp-target'));
    assert.ok(xpActions.some(a => sim.actions.some(b => ['H', 'G', 'W1', 'W2'].includes(b.phase) &&
        b.at < a.finish && b.finish > a.at)), 'money and XP must overlap on independent targets');
    assert.ok(sim.paid.some(p => p.at < sim.start + 30000));
    assert.ok(sim.paid.some(p => p.at > sim.start + 45000 && p.at < sim.start + 85000));
    assert.ok(sim.paid.some(p => p.at > sim.start + 95000));
    assert.equal(sim.getPort(17).peek().policy.mode, 'NORMAL');
    assert.ok(sim.killed.every(p => p.target === 'xp-target'), 'only optional XP workers may be preempted');
    assert.deepEqual(sim.misses, []);
    for (const [host, peak] of sim.peakRam) assert.ok(peak <= sim.hosts.get(host).ram, host);
});

for (const change of ['formulas lost', 'cash reserve needed']) {
    test(`money keeps earning and XP finishes its wave when ${change}`, async () => {
        const { sim, state } = policySimulation(); state.formulas = true;
        sim.clock.timer(40000, () => {
            if (change === 'formulas lost') state.formulas = false;
            else state.cash = 0;
        });
        sim.run(); await sim.clock.runUntil(sim.start + 95000);
        assert.deepEqual(sim.errors.map(String), []);
        assert.ok(sim.actions.some(a => a.phase === 'BG-G'));
        assert.ok(sim.paid.some(p => p.at > sim.start + 80000));
        assert.equal(sim.getPort(17).peek().policy.mode, 'NORMAL');
        assert.equal(sim.getPort(17).peek().policy.xp.workers, 0);
        assert.ok(sim.killed.every(p => p.target === 'xp-target'));
    });
}

test('hostile zero-hack-money environment keeps RAM working through the safe fallback', async () => {
    const { sim, state } = policySimulation({ ScriptHackMoney: 0, HackExpGain: .05, HackingLevelMultiplier: .3 });
    state.formulas = true; sim.options.flags.target = 'auto';
    sim.run(); await sim.clock.runUntil(sim.start + 22000);
    assert.deepEqual(sim.errors.map(String), []);
    const status = sim.getPort(17).peek();
    assert.equal(status.policy.mode, 'HOSTILE'); assert.equal(status.policy.operationalMode, 'NORMAL');
    assert.ok(status.usedRam > 0); assert.ok(sim.actions.some(a => a.phase === 'BG-W'));
    assert.ok(!sim.snapshots.some(s => s.policy?.mode === 'XP'));
});

test('an XP request with no possible money batch uses bounded fallback retries rather than an exclusive XP loop', async () => {
    const { sim, state } = policySimulation({ ScriptHackMoney: 0 });
    state.formulas = true; sim.options.flags.target = 'auto';
    sim.run(); await sim.clock.runUntil(sim.start + 65000);
    assert.deepEqual(sim.errors.map(String), []);
    const status = sim.getPort(17).peek();
    assert.equal(status.mode, 'fallback'); assert.equal(status.policy.mode, 'XP');
    assert.ok(sim.actions.some(a => a.phase === 'BG-W' && a.at > sim.start + 40000));
    assert.ok(!sim.snapshots.some(s => s.mode === 'experience'));
});

test('no SF5 or formulas preserves deployed money workers and normal target selection', async () => {
    const { sim, state } = policySimulation(); state.sf5 = false; sim.options.flags.target = 'auto';
    sim.run(); await sim.clock.runUntil(sim.start + 25000);
    assert.deepEqual(sim.errors.map(String), []); assert.ok(sim.paid.length > 0);
    assert.equal(sim.getPort(17).peek().policy.mode, 'NORMAL');
    assert.ok(!sim.actions.some(a => a.phase.startsWith('BG-')));
});

test('HOSTILE retains ordinary paid batching when a money plan remains possible', async () => {
    const { sim, state } = policySimulation({ ScriptHackMoney: .1, HackExpGain: .05, HackingLevelMultiplier: .3 });
    state.formulas = true;
    sim.run(); await sim.clock.runUntil(sim.start + 25000);
    assert.deepEqual(sim.errors.map(String), []); assert.ok(sim.paid.length > 0);
    assert.equal(sim.getPort(17).peek().policy.mode, 'HOSTILE');
    assert.equal(sim.getPort(17).peek().policy.operationalMode, 'NORMAL');
    assert.ok(!sim.actions.some(a => a.phase.startsWith('BG-')));
});
