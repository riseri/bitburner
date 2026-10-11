const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), api = loadScript('lib/root-unlock-economics.js', clock);
    const cash = 11.66e6, admission = { amount: 31.86e6, target: 'home:ram' };
    const program = { cost: 5e6, amount: 5e6 / .9, addedRam: 128 };
    const snapshot = { type: 'jit-status', generatedAt: clock.now, totalRam: 120, usedRam: 100,
        income60: (admission.amount - cash) / 3471, maxBatchRate: 4, maxWorkers: 6000,
        pipelines: [{ mode: 'LIVE', running: 20, queued: 10, modelBatchRate: 1, warmupMs: 120000 }],
        capacity: { limitingFactor: 'RAM', constraints: ['RAM'], ram: { scalable: true } } };
    return { clock, api, cash, admission, program, snapshot,
        evaluate(objective = null) { return api.evaluateRootUnlock(snapshot, program, admission, this.cash, objective); } };
}

test('the reported relaySMTP budget reaches home RAM sooner when the unlocked workers pay for it', () => {
    const f = fixture(), value = f.evaluate();
    assert.equal(value.ok, true);
    assert.equal(Math.round(value.directSeconds), 3471);
    assert.equal(Math.ceil(value.unlockSeconds), 2947);
    assert.equal(value.activationSeconds, 180);
    assert.ok(value.savedSeconds > 520);
    assert.equal(value.gain, f.snapshot.income60 * .5, 'discounted gain is capped even for a large RAM unlock');
    assert.match(value.reason, /50% discount.*180s activation/);
    const withReserve = f.api.evaluateRootUnlock(f.snapshot, { ...f.program, amount: 10e6 }, f.admission, f.cash);
    assert.equal(withReserve.unlockSeconds, value.unlockSeconds, 'retained reserve is not an additional expense');
});

test('little added RAM and long activation do not justify delaying service admission', () => {
    const f = fixture();
    f.program.addedRam = 32;
    let value = f.evaluate();
    assert.equal(value.ok, false);
    assert.ok(value.unlockSeconds > value.directSeconds);
    f.program.addedRam = 128;
    f.snapshot.pipelines[0].warmupMs = 7200000;
    value = f.evaluate();
    assert.equal(value.ok, false);
    assert.ok(Math.abs(value.unlockSeconds - (f.admission.amount - f.cash + f.program.cost) / f.snapshot.income60) < 1e-9,
        'the goal can finish on existing income before new workers activate');
});

test('switching requires both a 10% improvement and 30 seconds saved', () => {
    const f = fixture();
    f.program.addedRam = 70;
    let value = f.evaluate();
    assert.ok(value.savedSeconds > 30);
    assert.equal(value.ok, false, 'a positive ETA gain below 10% is not enough to switch');
    f.program.addedRam = 128;
    f.snapshot.income60 = 1; f.cash = 1000; f.admission.amount = 1200;
    f.program.cost = 30; f.program.amount = 30 / .9;
    f.snapshot.pipelines[0].warmupMs = 1;
    value = f.evaluate();
    assert.ok(value.unlockSeconds < value.directSeconds * .9);
    assert.ok(value.savedSeconds < 30);
    assert.equal(value.ok, false, 'an improvement below 30 seconds is not enough to switch');
});

test('home G/W contribution and remaining batch rate bound the worker RAM gain', () => {
    const f = fixture();
    f.snapshot.capacity.homeGw = { coreBonus: 2, recentUsage: { averageRam: 100 } };
    assert.equal(f.evaluate().ok, false, 'remote RAM is not the entire income-producing pool');
    delete f.snapshot.capacity.homeGw;
    f.snapshot.maxBatchRate = 1.3;
    const value = f.evaluate();
    assert.equal(value.ok, false);
    assert.ok(Math.abs(value.gain / f.snapshot.income60 - .15) < 1e-9);
});

for (const blocker of ['BATCH_RATE', 'LAUNCH_RATE', 'WORKER_LIMIT', 'RECOVERY', 'TARGET_SLOTS', 'NO_PROFITABLE_TARGET']) {
    test(blocker + ' does not turn raw unlocked RAM into predicted income', () => {
        const f = fixture();
        f.snapshot.capacity.limitingFactor = blocker;
        f.snapshot.capacity.constraints = [blocker];
        assert.equal(f.evaluate().ok, false);
    });
}

for (const condition of ['stale income', 'future income', 'no income', 'no workers', 'no activation timing',
    'recovering lane', 'idle RAM', 'no modeled demand', 'unfunded opener', 'funded home', 'no added RAM', 'invalid price']) {
    test(condition + ' leaves the service RAM goal protected', () => {
        const f = fixture();
        if (condition === 'stale income') f.snapshot.generatedAt -= 15001;
        if (condition === 'future income') f.snapshot.generatedAt++;
        if (condition === 'no income') f.snapshot.income60 = 0;
        if (condition === 'no workers') f.snapshot.pipelines = [];
        if (condition === 'no activation timing') delete f.snapshot.pipelines[0].warmupMs;
        if (condition === 'recovering lane') f.snapshot.pipelines[0].mode = 'RECOVERING';
        if (condition === 'idle RAM') {
            f.snapshot.totalRam = 1000; f.snapshot.capacity.limitingFactor = 'NONE'; f.snapshot.capacity.constraints = [];
        }
        if (condition === 'no modeled demand') {
            f.snapshot.capacity.scaling = { batchMode: 'auto' }; f.snapshot.capacity.ram.scalable = false;
        }
        if (condition === 'unfunded opener') f.cash = 5e6;
        if (condition === 'funded home') f.cash = f.admission.amount;
        if (condition === 'no added RAM') f.program.addedRam = 0;
        if (condition === 'invalid price') f.program.cost = NaN;
        assert.equal(f.evaluate().ok, false);
    });
}

test('installation and XP-only capacity do not justify an admission detour on money grounds', () => {
    const f = fixture();
    assert.equal(f.evaluate({ resetImminent: true }).ok, false);
    assert.equal(f.evaluate({ redPill: 'queued' }).ok, false);
    f.snapshot.capacity.limitingFactor = 'XP_RAM'; f.snapshot.capacity.constraints = ['XP_RAM'];
    f.snapshot.capacity.xp = { constrained: true, desiredRam: 500, allocatedRam: 100, target: 'foodnstuff' };
    assert.equal(f.evaluate({ limitingResource: 'hacking' }).ok, false);
});
