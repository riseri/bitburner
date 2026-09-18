const test = require('node:test');
const assert = require('node:assert/strict');
const { NetscriptSimulation } = require('./simulator.cjs');

for (const scenario of [
    { name: 'long the-hub profile with skill growth and a shared 70ms timer stall', weakenTime: 354_000, minutes: 20, stall: true },
    { name: 'isolated W2 invocation miss recovers and keeps the same pipeline', weakenTime: 354_000, minutes: 20, delayOneW2: true },
    { name: 'short target profile with fast skill growth', weakenTime: 25_000, minutes: 15, levelPerMinute: 5 },
    { name: 'dirty target prep reaches live income without helper errors', weakenTime: 5000, minutes: 2, sec: 14, money: 2.48e9 },
    { name: 'catastrophic security change quiesces and returns to earning', weakenTime: 60_000, minutes: 12, catastrophic: true },
]) {
    test(scenario.name, { timeout: 120_000 }, async () => {
        const sim = new NetscriptSimulation({ ...scenario, flags: { ...scenario.flags, 'dashboard-details': true } });
        if (scenario.stall) sim.clock.timer(600_000, () => { sim.clock.now += 70; });
        if (scenario.catastrophic) sim.clock.timer(300_000, () => { sim.server.sec = 100; });
        sim.run();
        await sim.clock.runUntil(sim.start + scenario.minutes * 60_000);
        const summary = sim.summary();
    summary.logs = summary.logs.map(line => line.trimStart());
        assert.deepEqual(summary.errors, [], JSON.stringify(summary));
        assert.ok(summary.paid > 50, JSON.stringify(summary));
        assert.ok(summary.income60 > 1e8, JSON.stringify(summary));
        assert.ok(summary.security < 17, JSON.stringify(summary));
        if (!scenario.catastrophic) {
            assert.match(summary.logs.find(l => l.startsWith('Restarts')), /Restarts\s+0 session\s+\| 0 safety resyncs/);
            assert.match(summary.logs.find(l => l.startsWith('Fallback')), /0 drain/);
        }
        if (scenario.delayOneW2) {
            assert.equal(sim.dropped, true);
            assert.ok(sim.misses.some(m => m.chunkId === sim.delayedChunk), 'the injected W2 must actually miss');
            assert.ok(sim.killed.some(k => k.phase === 'H'));
        }
        if (scenario.catastrophic) {
            assert.match(summary.logs.find(l => l.startsWith('Fallback')), /1 drain/);
            assert.match(summary.logs.find(l => l.startsWith('Restarts')), /Restarts\s+1 session\s+\| 1 safety resyncs/);
        } else if (!scenario.delayOneW2) {
            assert.match(summary.logs.find(l => l.startsWith('Recovery')), /Recovery\s+0 local/);
        }
        // No worker starts a normal HGW action at inflated security.
        assert.ok(sim.actions.filter(a => !a.phase.startsWith('PREP')).every(a => a.startSec <= 12.001));
        console.log(`${scenario.name}: ${JSON.stringify({ paid: summary.paid, income60: summary.income60, security: summary.security, steps: summary.steps })}`);
    });
}
