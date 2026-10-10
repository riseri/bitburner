const test = require('node:test');
const assert = require('node:assert/strict');
const { NetscriptSimulation } = require('./simulator.cjs');

async function run(targetLimit) {
    const backgroundTargets = {};
    for (let i = 1; i <= 6; i++) backgroundTargets[`lane-${i}`] = {
        max: 1e9 * (1 + i * .25), money: 1e9 * (1 + i * .25), required: 5000,
    };
    const sim = new NetscriptSimulation({ target: 'alpha', weakenTime: 12000, levelPerMinute: 0, hostCount: 25,
        mainServer: { max: 1e9, money: 1e9, sec: 3, min: 3, required: 10 }, backgroundTargets,
        flags: { target: 'alpha', 'max-targets': targetLimit, gap: 100 } });
    for (const [name, host] of sim.hosts) if (name !== 'home') host.ram = 1024 ** 3;
    // Richer targets become available after each preceding paid trial validates.
    for (let i = 1; i <= 6; i++) sim.clock.timer(i * 4 * 60000, () => {
        sim.servers.get(`lane-${i}`).required = 10;
    });
    sim.run();
    await sim.clock.runUntil(sim.start + 45 * 60000);
    return { sim, status: sim.getPort(17).peek() };
}

test('AUTO earns on seven targets and beats the six-target replacement policy without weakening shared limits',
    { timeout: 180000 }, async () => {
        const automatic = await run('auto'), fixed = await run(6);
        for (const { sim, status } of [automatic, fixed]) {
            assert.deepEqual(sim.errors.map(String), []);
            assert.equal(sim.misses.length, 0);
            assert.ok(sim.actions.filter(a => ['H', 'G', 'W1', 'W2'].includes(a.phase))
                .every(a => a.startSec <= sim.servers.get(a.target).min + .001));
            assert.ok(sim.snapshots.every(s => s.capacity.batchRate.used <= s.maxBatchRate + .001));
            assert.ok(sim.snapshots.every(s => s.capacity.workers.committed <= s.maxWorkers));
            assert.ok(sim.snapshots.every(s => s.capacity.launches.peakBucket <= s.capacity.launches.bucketLimit));
            for (const [host, ram] of sim.peakRam) assert.ok(ram <= sim.hosts.get(host).ram + 1e-6, host);
            for (const p of status.pipelines) {
                assert.equal(p.mode, 'LIVE', JSON.stringify(p));
                assert.notEqual(p.role, 'TRIAL', JSON.stringify(p));
                assert.ok(p.income60 > 0);
                assert.equal(p.restarts, 0);
            }
        }
        const { status, sim } = automatic;
        console.log(JSON.stringify({ automatic: { lanes: status.pipelines.length, income60: status.income60,
            budgets: [status.maxBatchRate, status.maxLaunches], scaling: status.capacity.scaling,
            admission: status.capacity.admission, batch: status.capacity.batchRate,
            targets: status.capacity.targets, pipelines: status.pipelines.map(p => ({ target: p.target,
                rate: p.modelBatchRate, income: p.income60, model: p.model, shadow: p.shadow?.state,
                swap: p.cutover?.state, lastSwap: p.lastSwap?.reason })) },
            explicitSix: { lanes: fixed.status.pipelines.length, income60: fixed.status.income60 } }));
        assert.equal(status.pipelines.length, 7, JSON.stringify(status));
        assert.ok(status.income60 > fixed.status.income60 * 1.03);
        assert.equal(sim.killed.filter(p => p.phase === 'H').length, 0);
        assert.ok(!status.capacity.constraints.includes('TARGET_SLOTS'));
    });
