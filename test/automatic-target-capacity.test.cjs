const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

// Replay the reported six paid lanes, 7.24/8.11 batches/s, 128 launches/s,
// 4,592/6,000 workers and 1.06/25 PB active RAM without any optional game API.
function fixture(targets = 'auto') {
    const clock = new Clock(), api = loadScript('daemon.js', clock);
    const multi = loadScript('lib/target-pipelines.js', clock);
    const scaling = loadScript('lib/scheduler-scaling.js', clock);
    const capacity = loadScript('lib/scheduler-capacity.js', clock);
    const selected = loadScript('lib/target-limit.js', clock).targetLimit(targets);
    const cfg = { maxTargets: selected.limit, targetMode: selected.mode, gap: 100, lead: 600,
        maxWorkers: 6000, maxSteal: .5, switchThreshold: 1.25,
        backgroundPrep: { enabled: false, status: 'DISABLED' }, prepStates: [] };
    const state = scaling.createSchedulerScaling(cfg);
    state.batch = 8.11; state.launches = 128; scaling.applySchedulerLimits(cfg, state);
    const names = ['ecorp', '4sigma', 'b-and-a', 'clarkinc', 'megacorp', 'blade'];
    const rates = [.62, .63, .62, .62, 2.37, 2.38];
    const pool = { cfg, api, ownerPid: 1, anchor: 'megacorp', nextOrdinal: 6,
        pipelines: new Map(), running: new Map(), foreign: new Map(), reservations: [],
        launchBuckets: new Map(), controls: new Map(), controlPort: new Port(), port: new Port(),
        blocked: new Map(), nextReadyScan: 0, nextAdmission: 0,
        targetAnalysis: [{ name: 'nwo', steady: 1e12 }],
        network: { hosts: [{ name: 'cloud', maxRam: 25 * 1024 ** 2 }], servers: [...names, 'nwo'] } };
    for (const [i, name] of names.entries()) {
        const p = multi.createTargetPipeline(name, cfg, api, 1, i, {
            plan: { batchRate: rates[i], period: 1000 / rates[i], expected: .5e12,
                steal: .49, times: { W: 10000 } } });
        p.trial = false; p.stats.started -= 200000; p.stats.pipeline.productiveMs = 200000;
        p.stats.lastHackAt = clock.now; p.stats.income = [{ time: clock.now, money: p.runtime.plan.expected * 60 }];
        p.stats.pipeline.completed = 100; p.firstLanding = clock.now - 200000;
        pool.pipelines.set(name, p); p.control = multi.targetControl(pool, p);
    }
    for (let i = 0; i < 4592; i++) pool.running.set(i, { host: 'cloud', ram: 1.06 * 1024 ** 2 / 4592 });
    const ns = { hasRootAccess: () => true, getServerRequiredHackingLevel: () => 1,
        getHackingLevel: () => 10000, getServerMaxMoney: () => 1e12, hackAnalyzeChance: () => 1 };
    api.targetHealth = () => ({ clean: true });
    function sample() {
        clock.now += 10000;
        for (const p of pool.pipelines.values()) {
            p.stats.lastHackAt = clock.now;
            p.stats.income = [{ time: clock.now, money: p.runtime.plan.expected * 60 }];
        }
        for (const kind of ['loop', 'launch', 'landing'])
            for (let i = 0; i < 20; i++) scaling.recordSchedulerTiming(state, kind, 1, cfg.gap);
        multi.serviceSchedulerScaling(ns, pool, clock.now);
    }
    return { clock, api, multi, scaling, capacity, cfg, state, pool, ns, sample };
}

test('the reported healthy six-lane state grows useful budget and admits a seventh AUTO target', () => {
    const f = fixture();
    for (let i = 0; i < 7; i++) f.sample();
    const c = f.capacity.schedulerCapacity(f.pool);
    assert.equal(c.targets.active, 6);
    assert.ok(!c.constraints.includes('TARGET_SLOTS'), JSON.stringify(c));
    assert.equal(c.targets.next.name, 'nwo');
    assert.ok(f.cfg.maxBatchRate > 8.11, f.state.reason);
    assert.equal(f.cfg.maxLaunches, 128);
    assert.equal(f.state.ramRequest, null, 'idle RAM does not justify more purchases');
    const peerEpochs = [...f.pool.pipelines.values()].map(p => p.epoch);
    f.multi.serviceBackgroundAndAdmission(f.ns, f.pool);
    assert.equal(f.pool.pipelines.size, 7, f.pool.note);
    assert.ok(f.pool.pipelines.get('nwo').trial);
    assert.deepEqual([...f.pool.pipelines.values()].slice(0, 6).map(p => p.epoch), peerEpochs);
    assert.equal(f.pool.running.size, 4592, 'admission preserves every recorded worker');
});

test('an explicit six-target limit still compares replacements at six', () => {
    const f = fixture(6);
    const c = f.capacity.schedulerCapacity(f.pool);
    // Existing explicit-limit behavior remains authoritative.
    assert.equal(c.targets.limit, 6);
    assert.equal(f.multi.steadyPromotionSupport(f.pool, f.clock.now).name, 'ecorp');
});

for (const guard of ['workers', 'timing', 'trial', 'reset']) {
    test(`AUTO cannot expand the reported state through a real ${guard} constraint`, () => {
        const f = fixture();
        if (guard === 'workers') f.cfg.maxWorkers = 4592;
        if (guard === 'trial') f.pool.pipelines.get('blade').trial = true;
        if (guard === 'reset') f.cfg.progressionObjective = { resetPending: true };
        for (let i = 0; i < 7; i++) {
            if (guard === 'timing') f.scaling.recordSchedulerTiming(f.state, 'loop', 300, 100);
            f.sample();
        }
        assert.ok(f.cfg.maxBatchRate <= 8.11);
        assert.equal(f.state.ramRequest, null);
        assert.equal(f.pool.pipelines.size, 6);
    });
}

test('candidate headroom cannot assign one target more than its own safe landing cadence', () => {
    const f = fixture();
    f.cfg.maxTargets = 128; f.state.batchCeiling = 32;
    f.pool.targetAnalysis = [{ name: 'tiny', steady: 1e12 }];
    // Looks profitable only if the scout incorrectly grants all spare global rate.
    f.pool.scalingCandidates = new Map([['tiny', { perBatch: 1e11 }]]);
    const c = f.capacity.schedulerCapacity(f.pool);
    assert.equal(c.targets.profitableInactive, 0);
    assert.equal(c.targets.next, null);
});

for (const guard of ['WORKER_LIMIT', 'LAUNCH_RATE', 'RECOVERY']) {
    test(`the seventh target still needs actual admission headroom: ${guard}`, () => {
        const f = fixture(); f.cfg.maxBatchRate = 16;
        if (guard === 'WORKER_LIMIT') f.cfg.maxWorkers = 4592;
        if (guard === 'LAUNCH_RATE') f.pool.launchBuckets.set(Math.floor(f.clock.now / 250), 128);
        if (guard === 'RECOVERY') f.pool.pipelines.get('blade').recovery = {};
        f.multi.serviceBackgroundAndAdmission(f.ns, f.pool);
        assert.equal(f.pool.pipelines.size, 6);
        assert.equal(f.pool.admission.reason, guard);
        assert.equal(f.pool.running.size, 4592);
    });
}

test('restored admission headroom clears an old BATCH_RATE hold even when no new target is worthwhile', () => {
    const f = fixture(); f.cfg.maxBatchRate = 7.24;
    f.multi.serviceBackgroundAndAdmission(f.ns, f.pool);
    assert.equal(f.pool.admission.reason, 'BATCH_RATE');
    f.cfg.maxBatchRate = 16; f.ns.getServerMaxMoney = () => 1;
    f.multi.serviceBackgroundAndAdmission(f.ns, f.pool);
    assert.equal(f.pool.admission.decision, 'SCOUT');
    assert.doesNotMatch(f.pool.admission.reason, /BATCH_RATE/);
    assert.equal(f.pool.pipelines.size, 6);
});
