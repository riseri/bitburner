const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');
const clock = new Clock(), api = loadScript('lib/augmentation-reset-policy.js', clock);
const recovery = loadScript('lib/augmentation-recovery.js', clock);
const adapter = loadScript('lib/augmentation-reset-context.js', clock);

function facts() {
    return { installed: [], pending: ['A', 'B', 'C'], plan: { errors: [], next: { name: 'Next',
        etaMs: 840000, repGap: 100, price: 1e9, stats: { faction_rep: 1.2 }, benefitAfterInstall: 1 } },
        money: 1e6, minInstall: 5, lastAugReset: 0, now: 1000000, resetEpoch: '4:1:2', objectiveKey: 'REP:Next',
        progress: { stalledMs: 0, waitingMs: 0 }, package: { complete: true },
        evidence: { reliable: true, acquisitionGoal: true, recoveryMs: 90000, benefit: 1.8, nextBenefit: 1.2,
            lanes: [{ resource: 'reputation', remainingMs: 840000, lostMs: 60000, benefit: 1.8, nextBenefit: 1.2 }] } };
}
function observed(f) {
    let d;
    for (let t = 0; t <= 60000; t += 5000) { d = api.decideAugmentationReset({ ...f, now: f.now + t, history: d?.history }); }
    return d;
}

test('economic reset pays two recovery costs to reach the same installed reputation target', () => {
    const f = facts(), d = observed(f);
    assert.equal(d.action, 'INSTALL'); assert.equal(d.confidence, 'MEDIUM');
    assert.equal(d.installNow.etaMs, 680000); assert.equal(d.wait.totalMs, 930000);
    assert.equal(d.installNow.additionalRecoveryMs, 90000);
    assert.ok(d.installNow.breakEvenMs < d.wait.etaMs);
    assert.match(api.resetDecisionSummary(d), /INSTALL: break-even/);
});

function completionFacts() {
    const day = 86400000;
    return { completionGoal: true, pending: ['NeuroFlux Governor'], package: { complete: true }, mode: 'auto',
        now: clock.now, resetEpoch: '4:1:900000', objectiveKey: 'FINAL_SERVER:9000', acquisitionMs: 0,
        evidence: { reliable: true, recoveryMs: day, recoverySource: 'conservative', benefit: 4,
            lanes: [{ remainingMs: day * 10, lostMs: 0, benefit: 4 }] } };
}

test('conservative endgame recovery requires a sustained 50 percent advantage and remains LOW confidence', () => {
    const f = completionFacts(), d = observed(f);
    assert.equal(d.action, 'INSTALL'); assert.equal(d.confidence, 'LOW');
    assert.equal(d.recoverySource, 'conservative'); assert.match(d.reason, /conservative 24h/);
    assert.equal(d.installNow.etaMs, 86400000 * 3.5);
    f.evidence.benefit = f.evidence.lanes[0].benefit = 2;
    assert.equal(observed(f).action, 'WAIT');
});

test('first-reset allowance refuses a short horizon and charges reputation acquisition time', () => {
    const f = completionFacts(); f.evidence.lanes[0].remainingMs = 86400000 * 3;
    assert.equal(observed(f).action, 'WAIT');
    f.evidence.lanes[0].remainingMs = 86400000 * 10; f.acquisitionMs = 86400000 * 2;
    assert.equal(observed(f).action, 'WAIT');
    for (const invalid of [NaN, Infinity, -1]) {
        f.acquisitionMs = invalid; const d = observed(f);
        assert.equal(d.action, 'WAIT'); assert.match(d.reason, /acquisition time unavailable/);
    }
});

test('changing from assumed to measured recovery restarts endgame observation', () => {
    const f = completionFacts(), d = observed(f);
    f.evidence.recoverySource = 'measured'; f.now += 65000;
    const fresh = api.decideCompletionReset({ ...f, history: { ...d.history, at: f.now } });
    assert.equal(fresh.action, 'WAIT'); assert.equal(fresh.history.since, f.now);
    assert.equal(fresh.confidence, 'MEDIUM');
});

test('five queued wait for a valuable augmentation 45 seconds away; utility score is irrelevant', () => {
    const f = facts(); f.pending.push('D', 'E'); f.plan.next.etaMs = 45000;
    f.plan.next.benefitAfterInstall = 1e99;
    f.evidence.nextBenefit = 1.8;
    f.evidence.lanes[0].remainingMs = 56250; // 45s at the observed rate, derated to 80%
    assert.equal(observed(f).action, 'WAIT');
});

test('weak packages avoid tiny economic resets and large lost progress can veto strong packages', () => {
    const f = facts(); f.evidence.benefit = 1.02;
    assert.equal(observed(f).action, 'WAIT');
    f.evidence.benefit = 1.8; f.evidence.lanes[0].lostMs = 3600000;
    assert.equal(observed(f).action, 'WAIT');
});

test('hard route decisions beat economics and empty queues never install', () => {
    for (const kind of ['pill', 'count', 'complete', 'favor', 'stall', 'bound']) {
        const f = facts(); f.evidence = null;
        if (kind === 'pill') f.pending = ['The Red Pill'];
        if (kind === 'count') { f.installed = Array.from({ length: 29 }, (_, i) => String(i)); f.pending = ['A']; }
        if (kind === 'complete') f.plan.next = null;
        if (kind === 'favor') f.plan.next.favorUnlockEtaMs = 100000;
        if (kind === 'stall') f.progress.stalledMs = 1800000;
        if (kind === 'bound') f.progress.waitingMs = 3600000;
        assert.equal(api.decideAugmentationReset(f).action, 'INSTALL', kind);
        f.pending = [];
        assert.equal(api.decideAugmentationReset(f).action, 'WAIT', kind);
    }
});

test('unknown recovery, ETA, stats and malformed projections fall back to legacy policy', () => {
    for (const kind of ['recovery', 'eta', 'stats', 'loss', 'rate']) {
        const f = facts(); f.pending.push('D', 'E');
        if (kind === 'recovery') f.evidence.recoveryMs = null;
        if (kind === 'eta') f.plan.next.etaMs = null;
        if (kind === 'stats') f.package.complete = false;
        if (kind === 'loss') f.evidence.lanes[0].lostMs = NaN;
        if (kind === 'rate') f.evidence.reliable = false;
        const d = api.decideAugmentationReset(f);
        assert.equal(d.action, 'FALLBACK', kind); assert.equal(d.fallback.action, 'INSTALL', kind);
    }
});

test('threshold mode retains the two-minute short purchase exception and count/stall behavior', () => {
    const f = facts(); f.mode = 'threshold';
    assert.equal(observed(f).fallback.action, 'WAIT');
    f.pending.push('D', 'E');
    assert.equal(observed(f).fallback.action, 'INSTALL');
    f.plan.next.etaMs = 45000;
    assert.equal(observed(f).fallback.action, 'WAIT');
    f.progress.waitingMs = 120000;
    assert.equal(observed(f).fallback.action, 'INSTALL');
});

test('hysteresis discards noisy, stale, objective, queue and reset identities', () => {
    const f = facts(), first = api.decideAugmentationReset(f);
    assert.equal(first.action, 'WAIT');
    for (const changed of [{ objectiveKey: 'cash' }, { resetEpoch: '4:1:3' }, { pending: ['D'] },
        { plan: { ...f.plan, next: { ...f.plan.next, name: 'Another' } } }, { now: f.now + 16000 }]) {
        const d = api.decideAugmentationReset({ ...f, history: first.history, now: f.now + 5000, ...changed });
        assert.equal(d.action, 'WAIT'); assert.equal(d.history.since, changed.now || f.now + 5000);
    }
    f.evidence.lanes[0].lostMs = 400000;
    const changed = api.decideAugmentationReset({ ...f, history: first.history, now: f.now + 5000 });
    assert.equal(changed.action, 'WAIT');
    assert.equal(changed.history, null);
});

test('changing shiny objectives cannot extend an auto queue beyond one hour', () => {
    const f = facts(); f.now = 5000000; f.queuedSince = 1000000; f.evidence = null;
    f.plan.next.etaMs = null; f.progress = { waitingMs: 0, stalledMs: 0 };
    assert.equal(api.decideAugmentationReset(f).action, 'INSTALL');
    f.mode = 'threshold'; assert.equal(api.decideAugmentationReset(f).fallback.action, 'WAIT');
});

test('package aggregation deduplicates ordinary names, excludes installed and counts NFG per queued level', () => {
    const p = api.augmentationPackage(['Old', 'NeuroFlux Governor'], ['Old', 'A', 'A', 'B', 'NeuroFlux Governor', 'NeuroFlux Governor'],
        { A: { faction_rep: 1.2, hacking_speed: 1.1 }, B: { faction_rep: 1.3, work_money: 1.4 },
            'NeuroFlux Governor': { faction_rep: 1.01 }, Old: { faction_rep: 100 } });
    assert.equal(p.names.length, 4); assert.ok(Math.abs(p.multipliers.faction_rep - 1.2 * 1.3 * 1.01 ** 2) < 1e-10);
    assert.equal(p.multipliers.hacking_speed, 1.1); assert.equal(p.multipliers.work_money, 1.4);
    assert.equal(api.augmentationPackage([], ['Missing'], {}).complete, false);
    assert.equal(api.augmentationPackage([], ['Bad'], { Bad: { hacking: -1 } }).complete, false);
});

function historyState() {
    return { resetEpoch: '4:1:900000', resetHistory: { key: 'old' }, recoveryMs: 95000,
        recoveryProfile: { nodeReset: 1, samples: [100000, 500000].map(at => ({ at, ms: 90000, income: 1000,
            cash: 100000, xp: 200, hacking: 600, reputation: { CyberSec: 100 } })) } };
}

test('migration retains node-scoped samples across augmentation resets, clears decisions and discards foreign node history', () => {
    const s = historyState(); s.ownedWork = { faction: 'CyberSec' };
    recovery.migrateResetState(s, { currentNode: 4, lastNodeReset: 1, lastAugReset: 950000 }, '4:1:950000');
    assert.equal(s.resetHistory, undefined); assert.equal(s.ownedWork, null); assert.equal(s.recoveryProfile.samples.length, 2);
    recovery.migrateResetState(s, { currentNode: 4, lastNodeReset: 960000, lastAugReset: 960000 }, '4:960000:960000');
    assert.equal(s.recoveryMs, undefined); assert.equal(s.recoveryProfile.samples.length, 0);
    const old = { resetEpoch: '4:1:2', recoveryMs: 123000, recoveryProfile: { samples: 'corrupt' } };
    recovery.migrateResetState(old, { currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }, '4:1:2');
    assert.equal(old.recoveryMs, 123000); assert.equal(old.recoveryProfile.samples.length, 0);
    assert.equal(recovery.recoveryEstimate(old, { reset: { lastNodeReset: 1 }, income: 1000 }), null);
    const duplicate = historyState(); duplicate.recoveryProfile.samples[1] = duplicate.recoveryProfile.samples[0];
    recovery.migrateResetState(duplicate, { currentNode: 4, lastNodeReset: 1, lastAugReset: 900000 }, '4:1:900000');
    assert.equal(duplicate.recoveryProfile.samples.length, 1);
});

test('recovery requires sustained 80 percent income, live lanes and two comparable samples', () => {
    const s = historyState(); s.recoveryBaseline = { at: 800000, income: 1000, nodeReset: 1 };
    const c = { reset: { lastAugReset: 900000, lastNodeReset: 1 }, income: 800, engineStable: true };
    const resources = { cash: 100000, xp: 200, hacking: 600, reputation: { CyberSec: 100 } };
    recovery.observeResetRecovery(s, c, resources, 950000);
    recovery.observeResetRecovery(s, { ...c, income: 799 }, resources, 955000);
    for (let t = 960000; t <= 985000; t += 5000) recovery.observeResetRecovery(s, c, resources, t);
    assert.ok(s.recoveryBaseline);
    recovery.observeResetRecovery(s, c, resources, 990000);
    assert.equal(s.recoveryBaseline, null);
    assert.equal(s.recoveryProfile.samples.length, 3);
    const e = recovery.recoveryEstimate(s, c); assert.equal(e.ms, 90000); assert.equal(e.xp, 100);
    assert.equal(e.reputation('CyberSec'), 50); assert.equal(e.reputation('Daedalus'), null);
    s.recoveryProfile.samples[0].ms = 500000;
    assert.equal(recovery.recoveryEstimate(s, c), null);
});

function evidenceFixture(resource = 'reputation') {
    const context = { installed: [], owned: ['A'], money: 10000, income: 1000, reset: { lastAugReset: 900000, lastNodeReset: 1 },
        player: { skills: { hacking: 500 }, exp: { hacking: 1000 }, mults: { hacking: 1 } },
        multipliers: { HackingLevelMultiplier: 1 },
        objective: { limitingResource: resource, milestone: 'TEST', requiredHacking: 1000, requiredCash: 1e6 },
        balance: { generatedAt: clock.now, milestone: 'TEST', requiredHacking: 1000, requiredCash: 1e6,
            cashSource: 'measured', xpSource: 'measured', cashRate: 1000, xpRate: 100 } };
    const ns = { fileExists: () => true, formulas: { skills: { calculateExp: (level, mult) => level * 100 / mult } },
        singularity: { getAugmentationStats: () => ({ faction_rep: 2.6, hacking_exp: 2, hacking: 1.2, hacking_money: 3 }) } };
    const plan = { next: { name: 'Next', faction: 'CyberSec', rate: 10, etaMs: 900000, repRequired: 9000, repGap: 8000,
        price: 1e6, stats: { faction_rep: 1.2, hacking_exp: 1.2 } } };
    return { ns, context, plan, state: historyState() };
}

test('adapter separates objective-relevant benefits and uses measured parallel cash/XP lanes', () => {
    const f = evidenceFixture(), read = () => adapter.resetEconomics(f.ns, f.context, f.plan, f.state, ['A']);
    const rep = read(); assert.equal(rep.evidence.benefit, 1.8); assert.equal(rep.evidence.reliable, true);
    assert.equal(rep.evidence.lanes[1].benefit, 1);
    f.context.objective.limitingResource = 'hacking';
    const xp = read(); assert.equal(xp.evidence.reliable, true); assert.ok(xp.evidence.benefit > 1.15);
    assert.equal(xp.evidence.lanes[1].benefit, 1);
    f.context.objective.limitingResource = 'cash';
    const cash = read(); assert.equal(cash.evidence.reliable, false); assert.equal(cash.evidence.confidence, 'LOW');
    assert.equal(cash.package.multipliers.hacking_money, 3);
});

test('missing Formulas, unstable or mismatched milestone evidence and lost faction access are conservative', () => {
    for (const kind of ['formulas', 'unstable', 'stale', 'objective', 'faction', 'skill', 'chain', 'donation', 'infinite-rate']) {
        const f = evidenceFixture(['faction', 'skill', 'chain', 'donation'].includes(kind) ? 'reputation' : 'hacking');
        if (kind === 'formulas') f.ns.fileExists = () => false;
        if (kind === 'unstable') f.context.balance.xpSource = 'UNKNOWN (unstable or zero)';
        if (kind === 'stale') f.context.balance.generatedAt -= 16000;
        if (kind === 'objective') f.context.balance.requiredHacking = 999;
        if (kind === 'faction') f.plan.next.faction = 'New faction';
        if (kind === 'skill') f.context.player.skills.hacking = 700;
        if (kind === 'chain') f.plan.next.chainTarget = 'Other';
        if (kind === 'donation') f.plan.next.donationPlanned = true;
        if (kind === 'infinite-rate') f.context.balance.xpRate = Infinity;
        assert.equal(adapter.resetEconomics(f.ns, f.context, f.plan, f.state, ['A']).evidence.reliable, false, kind);
    }
});

test('donation funding as the effective cash bottleneck retains conservative reset economics', () => {
    const f = evidenceFixture('cash'); f.plan.next.donationPlanned = true;
    f.plan.next.donationCost = 20e9; f.plan.next.fundingCost = 20e9 + f.plan.next.price;
    f.context.objective.reputationStrategy = 'DONATE';
    const result = adapter.resetEconomics(f.ns, f.context, f.plan, f.state, ['A']);
    assert.equal(result.evidence.reliable, false); assert.equal(result.evidence.confidence, 'LOW');
    assert.equal(result.evidence.lanes.length, 0);
    assert.match(result.evidence.reason, /post-reset.*LOW confidence/);
});
