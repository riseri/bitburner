const test = require('node:test');
const assert = require('node:assert/strict');
const { NetscriptSimulation } = require('./simulator.cjs');

function assertHealthy(sim) {
    const summary = sim.summary();
    summary.logs = summary.logs.map(line => line.trimStart());
    assert.deepEqual(summary.errors, [], JSON.stringify(summary));
    assert.ok(summary.income60 > 1e8, JSON.stringify(summary));
    assert.match(summary.logs.find(l => l.startsWith('Restarts')), /Restarts\s+0 session\s+\| 0 safety resyncs/);
    assert.match(summary.logs.find(l => l.startsWith('Fallback')), /0 drain/);
    for (const [host, ram] of sim.peakRam) assert.ok(ram <= sim.hosts.get(host).ram + 1e-6, host);
    assert.ok(sim.actions.filter(a => a.phase === 'H').every(a => a.target === 'phantasy'));
    return summary;
}

const profile = {
    target: 'phantasy', weakenTime: 78_000, levelPerMinute: 0,
    mainServer: { max: 600e6, money: 600e6, sec: 7, min: 7, required: 30 },
    flags: { target: 'auto', 'dashboard-details': true, 'max-targets': 1 },
    backgroundTargets: { 'the-hub': { max: 4.96e9, money: 198.4e6, sec: 24, min: 12, required: 300, weakenTime: 180_000 } },
};

test('18-minute concurrent prep reaches READY while active income matches prep-disabled baseline', { timeout: 120_000 }, async () => {
    const baseline = new NetscriptSimulation({ ...profile, flags: { target: 'auto', 'background-prep': false, 'dashboard-details': true, 'max-targets': 1 } });
    baseline.run(); await baseline.clock.runUntil(baseline.start + 18 * 60_000);
    const before = assertHealthy(baseline);
    const sim = new NetscriptSimulation(profile);
    // A shared timer hiccup while the secondary target is preparing.
    sim.clock.timer(300_000, () => { sim.clock.now += 70; });
    sim.run(); await sim.clock.runUntil(sim.start + 18 * 60_000);
    const after = assertHealthy(sim);
    const candidate = sim.servers.get('the-hub');
    assert.ok(candidate.money >= candidate.max * .9999 && candidate.sec <= candidate.min + .001);
    assert.match(after.logs.find(l => l.startsWith('Background')), /the-hub \| READY/);
    const bg = sim.actions.filter(a => a.phase.startsWith('BG-'));
    assert.ok(bg.some(a => a.phase === 'BG-G')); assert.ok(bg.some(a => a.phase === 'BG-W'));
    const firstPrep = bg[0].at, lastPrep = Math.max(...bg.map(a => a.finish));
    for (let at = firstPrep; at + 60_000 < lastPrep; at += 60_000) {
        assert.ok(sim.paid.some(p => p.at >= at && p.at < at + 60_000), 'active income must continue throughout prep');
    }
    const count = world => world.actions.filter(a => a.phase === 'H' && a.target === 'phantasy').length;
    assert.ok(Math.abs(count(sim) - count(baseline)) <= 2, 'background work must not consume income landing slots');
    assert.ok(after.income60 >= before.income60 * .85, 'allow stochastic hack success, not a lost minute of income');
    assert.ok(sim.launches.filter(l => l.phase.startsWith('background-')).every(l => l.ram <= 16_384));
    assert.equal(sim.killed.filter(k => k.phase === 'H').length, 0);
    console.log(JSON.stringify({ baselineIncome60: before.income60, withPrepIncome60: after.income60,
        baselineH: count(baseline), withPrepH: count(sim), prepActions: bg.length, background: candidate }));
});

test('a security-100 background target can recover without resetting the healthy money target', { timeout: 60_000 }, async () => {
    const sim = new NetscriptSimulation({ ...profile, backgroundTargets: {
        'the-hub': { max: 4.96e9, money: 4.96e9, sec: 100, min: 12, required: 300, weakenTime: 20_000 },
    } });
    sim.run(); await sim.clock.runUntil(sim.start + 10 * 60_000);
    const summary = assertHealthy(sim);
    assert.match(summary.logs.find(l => l.startsWith('Background')), /the-hub \| READY/);
    assert.equal(sim.servers.get('the-hub').sec, 12);
    assert.ok(sim.actions.some(a => a.phase === 'BG-W' && a.startSec === 100));
    assert.ok(sim.actions.filter(a => !a.phase.startsWith('BG-') && !a.phase.startsWith('PREP')).every(a => a.startSec <= 7.001));
});

test('a dead prep worker retries in isolation and daemon exit cancels only its owned prep PID', { timeout: 60_000 }, async () => {
    const sim = new NetscriptSimulation(profile);
    sim.run(); await sim.clock.runUntil(sim.start + 260_000);
    const child = [...sim.processes.values()].find(p => p.script.startsWith('background-'));
    assert.ok(child, 'test must reach a real running background worker');
    sim.stop(child.pid);
    await sim.clock.runUntil(sim.start + 20 * 60_000);
    const summary = assertHealthy(sim);
    assert.match(summary.logs.find(l => l.startsWith('Background')), /the-hub \| READY/);
    assert.equal(sim.killed.filter(k => k.phase === 'H').length, 0);

    const exit = new NetscriptSimulation(profile);
    exit.run(); await exit.clock.runUntil(exit.start + 260_000);
    const owned = [...exit.processes.values()].find(p => p.script.startsWith('background-'));
    assert.ok(owned);
    const jit = [...exit.processes.values()].filter(p => p.script.startsWith('jit-')).map(p => p.pid);
    exit.controller.active = false;
    exit.exitHandlers[0](); // isolate the prep hook; owner shutdown is covered by multi-target tests
    assert.ok(!exit.processes.has(owned.pid));
    assert.ok(jit.every(pid => exit.processes.has(pid)), 'prep exit hook must not kill JIT workers');
});


test('post-reset empty second slot chooses a fast-paying target instead of a long-prep whale', { timeout: 120_000 }, async () => {
    const sim = new NetscriptSimulation({
        target: 'phantasy', weakenTime: 78_000, levelPerMinute: 0,
        mainServer: { max: 600e6, money: 600e6, sec: 7, min: 7, required: 30 },
        flags: { target: 'phantasy', 'max-targets': 2 },
        backgroundTargets: {
            'fast-lane': { max: 1.5e9, money: 1.35e9, sec: 8, min: 7, required: 80, weakenTime: 40_000, chance: .8 },
            'slow-whale': { max: 4.96e9, money: 100e6, sec: 50, min: 12, required: 300, weakenTime: 300_000, chance: .8 },
        },
    });
    sim.run();
    await sim.clock.runUntil(sim.start + 8 * 60_000);
    const status = sim.getPort(17).peek();
    assert.equal(status.type, 'jit-status');
    assert.equal(status.pipelines.length, 2, JSON.stringify(status));
    assert.ok(status.pipelines.some(p => p.target === 'fast-lane'), JSON.stringify(status));
    assert.ok(!status.pipelines.some(p => p.target === 'slow-whale'), JSON.stringify(status));
    assert.ok(sim.paid.some(p => p.target === 'fast-lane'),
        'the acquired second target should already be contributing income inside eight minutes');
    assert.ok(sim.paid.some(p => p.target === 'phantasy'),
        'the incumbent must keep earning while the second slot is acquired');
});
