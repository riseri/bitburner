const test = require('node:test'), assert = require('node:assert/strict');
const {fixture}=require('./home-xp-fixture.cjs');

test('home-heavy endgame escapes OBSERVE and publishes useful cloud demand with an empty tuning lane', () => {
    const f = fixture(), reservations = [...f.pool.reservations], pids = [...f.pool.running.keys()];
    let c; for (let i = 0; i < 7; i++) c = f.sample();
    assert.equal(c.targets.active, 2); assert.equal(c.targets.admitting, 1); assert.equal(c.targets.waiting, 1);
    assert.equal(c.batchRate.used, 2.36); assert.ok(c.batchRate.remaining > .6);
    assert.ok(!c.constraints.includes('BATCH_RATE'));
    assert.ok(f.cfg.maxLaunches > 40, 'healthy paid work permits automatic launch adaptation');
    assert.equal(f.cfg.maxBatchRate, 3, 'cash-covered final-server work does not need more money batches');
    assert.equal(c.xp.expansion, true); assert.equal(c.xp.confidence, 'MODEL (warmup)');
    assert.equal(c.xp.desiredRam - c.xp.allocatedRam, 13675);
    assert.ok(f.economics.fleetCapacityPolicy({ capacity: c }, f.goal).xp);
    assert.ok(f.economics.evaluateFleetInvestment({ type: 'jit-status', capacity: c, income60: 28.04e9,
        pipelines: [{ mode: 'LIVE' }, { mode: 'TUNING', running: 0, queued: 0 }] }, 16384, 1e12, 1800, f.goal).ok);
    assert.deepEqual(f.pool.reservations, reservations); assert.deepEqual([...f.pool.running.keys()], pids);
    assert.equal(f.idle.mode, 'TUNING'); assert.equal(f.scaler.probe, null);
});

test('read-only shadow planning cannot indefinitely suppress automatic launch adaptation',()=>{
    const f=fixture();f.money.shadow={state:'SHADOW'};
    for(let i=0;i<7;i++)f.sample();
    assert.ok(f.cfg.maxLaunches>40);assert.equal(f.money.shadow.state,'SHADOW');
    assert.equal(f.cfg.maxBatchRate,3);
});

for (const guard of ['idle-remote', 'idle-home', 'no-paid-lane', 'owned-recovery', 'unsafe-timing', 'prep', 'reset', 'zero-XP', 'noisy-XP', 'stale-proof']) {
    test(`home XP warmup cannot justify unusable or unsafe expansion: ${guard}`, () => {
        const f = fixture();
        if (guard === 'idle-remote') for (const h of f.pool.network.hosts) h.maxRam *= 4;
        if (guard === 'idle-home') { f.cfg.homeGw.host.maxRam *= 2; f.ns.getServerMaxRam = () => 131072; }
        if (guard === 'no-paid-lane') f.money.trial = true;
        if (guard === 'owned-recovery') f.money.recovery = {};
        if (guard === 'prep') f.pool.xp.wave.preparing = true;
        if (guard === 'reset') f.goal.resetPending = true;
        if (guard === 'zero-XP') f.pool.xp.samples = [0, 0, 0];
        if (guard === 'noisy-XP') f.pool.xp.samples = [1000, 3000, 1000];
        let c; for (let i = 0; i < 7; i++) {
            if (guard === 'unsafe-timing') f.scaling.recordSchedulerTiming(f.scaler, 'loop', 300, 100);
            c = f.sample();
        }
        if (guard === 'stale-proof') { f.clock.now += 16000; c = f.capacity.schedulerCapacity(f.pool, f.clock.now); }
        assert.equal(c.xp.expansion, false);
    });
}

test('peer tuning charges home placements to home and excludes the empty retained plan', () => {
    const f = fixture(), budget = f.multi.tuningRamBudget(f.pool, f.idle, 2775);
    assert.ok(budget.remote > 1800, JSON.stringify(budget));
    assert.ok(budget.home > 60000 && budget.home < 65536);
    f.idle.queue.push({});
    assert.equal(f.capacity.schedulerCapacity(f.pool).batchRate.used, 3, 'committed peer work stays charged until reconciled');
});

test('adaptive probes compare paid dollars per second rather than the number of earning lanes', () => {
    const f = fixture(); f.cfg.hackingPolicy = { mode: 'MONEY' }; f.cfg.progressionObjective = null;
    f.pool.xp.status = 'DISABLED'; f.money.runtime.plan.batchRate = 3;
    for (let i = 0; i < 7; i++) f.sample();
    assert.equal(f.scaler.probe.baseline, 28.04e9);
});

test('reported 2.25/16 endgame trial restores budgets and can expand full home XP before the trial validates', () => {
    const f = fixture({ trial: true }), reservations = [...f.pool.reservations], pids = [...f.pool.running.keys()];
    let c; for (let i = 0; i < 7; i++) c = f.sample({ moneyAge: 11000, blockedDemand: true });
    assert.equal(f.idle.trial, true); assert.equal(f.idle.mode, 'RUNNING');
    assert.equal(f.cfg.maxBatchRate, 2.75); assert.equal(f.cfg.maxLaunches, 24);
    assert.equal(f.scaler.decision, 'RESTORE'); assert.equal(c.launches.moneyLimit, 24);
    assert.ok(c.constraints.includes('LAUNCH_RATE'), 'a split money batch can need more launches than the currently held eight');
    assert.equal(c.xp.expansion, true); assert.equal(c.xp.launchable, true);
    assert.ok(c.xp.availableRam < 420 && c.xp.availableRam > 400);
    assert.ok(f.economics.fleetCapacityPolicy({ capacity: c }, f.goal).xp,
        'a fresh proof of one usable XP launch is independent of the split money-batch constraint');
    for (let i = 0; i < 21; i++) c = f.sample();
    assert.equal(f.cfg.maxBatchRate, 4); assert.equal(f.cfg.maxLaunches, 32);
    assert.equal(f.scaler.restore, null); assert.equal(f.idle.trial, true);
    assert.deepEqual(f.pool.reservations, reservations); assert.deepEqual([...f.pool.running.keys()], pids);
});
