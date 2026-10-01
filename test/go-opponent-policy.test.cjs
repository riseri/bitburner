const test = require('node:test');
const assert = require('node:assert/strict');
const { policyFixture } = require('./go-policy-helpers.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .00001, `${actual} != ${expected}`);

test('ordinary Go effects have centralized stable semantics and exclude the secret opponent', () => {
    const f = policyFixture();
    assert.deepEqual(plain(f.policy.GO_OPPONENT_EFFECTS), { Netburners: 'HACKNET', 'Slum Snakes': 'CRIME',
        'The Black Hand': 'HACKING_MONEY', Tetrads: 'COMBAT', Daedalus: 'REPUTATION', Illuminati: 'HACKING_SPEED' });
    assert.equal(f.policy.GO_OPPONENT_EFFECTS.w0r1d_d43m0n, undefined);
});

for (const [objective, expected] of [
    [{ limitingResource: 'hacking' }, 'Illuminati'], [{ limitingResource: 'cash' }, 'The Black Hand'],
    [{ limitingResource: 'reputation', reputationStrategy: 'WORK' }, 'Daedalus'], [null, 'Daedalus'],
    [{ milestone: 'RED_PILL', limitingResource: 'cash', reputationStrategy: 'DONATE' }, 'The Black Hand'],
]) test(`Go cold start uses a PRIOR for ${JSON.stringify(objective)}`, () => {
    const f = policyFixture(), result = f.choose({ objective, jit: null });
    assert.equal(result.selectedOpponent, expected);
    assert.equal(result.selectionConfidence, 'PRIOR');
    assert.equal(result.projectedMilestoneValue, null);
    assert.ok(result.ranking.every(r => !['Netburners', 'Slum Snakes', 'Tetrads', 'w0r1d_d43m0n'].includes(r.opponent)));
});

test('Go game measurement records wall time, outcome, score, bonus, streak and favor evidence', () => {
    const f = policyFixture(), m = f.measurement;
    const before = { wins: 2, losses: 1, winStreak: -1, bonusPercent: 5, rep: 100 };
    const after = { wins: 3, losses: 1, winStreak: 1, bonusPercent: 5.3, rep: 600 };
    const started = m.beginGoObservation({ opponent: 'Daedalus', size: 5, epoch: f.epoch,
        stats: { Daedalus: before }, member: true, now: 1000 });
    const sample = m.finishGoObservation(started, { snapshot: { opponent: 'Daedalus', board: Array(5),
        game: { currentPlayer: 'None', blackScore: 15, whiteScore: 9.5 } }, stats: { Daedalus: after },
        member: true, rngWaitMs: 30_000, now: 121_000 });
    assert.equal(sample.durationMs, 120_000); assert.equal(sample.startedAt, 1000); assert.equal(sample.finishedAt, 121_000);
    assert.equal(sample.won, true); assert.equal(sample.score, 15); assert.equal(sample.margin, 5.5);
    close(sample.bonusDelta, .3); close(sample.bonusPerMinute, .15);
    assert.equal(sample.before.winStreak, -1); assert.equal(sample.after.winStreak, 1);
    assert.equal(sample.repDelta, 500); assert.equal(sample.memberBefore, true); assert.equal(sample.rngWaitMs, 30_000);
});

test('losses also accrue measured bonuses; invalid outcome counters produce no sample', () => {
    const f = policyFixture(), m = f.measurement;
    const before = { wins: 2, losses: 1, winStreak: 2, bonusPercent: 5, rep: 0 };
    const after = { ...before, losses: 2, winStreak: -1, bonusPercent: 5.1 };
    const start = m.beginGoObservation({ opponent: 'Illuminati', size: 5, epoch: f.epoch,
        stats: { Illuminati: before }, now: 1000 });
    const end = { snapshot: { opponent: 'Illuminati', board: Array(5), game: { currentPlayer: 'None', blackScore: 8, whiteScore: 12.5 } },
        stats: { Illuminati: after }, now: 61_000 };
    const s = m.finishGoObservation(start, end);
    assert.equal(s.won, false); close(s.bonusPerMinute, .1); assert.equal(s.margin, -4.5);
    end.stats.Illuminati = before;
    assert.equal(m.finishGoObservation(start, end), null);
    assert.equal(m.finishGoObservation(start, { ...end, snapshot: { ...end.snapshot, opponent: 'Daedalus' } }), null);
    assert.equal(m.finishGoObservation(start, { ...end, snapshot: { ...end.snapshot, game: { ...end.snapshot.game, currentPlayer: 'White' } } }), null);
});

test('missing stats are zero only before an unplayed opponent; malformed present stats are rejected', () => {
    const m = policyFixture().measurement;
    assert.equal(m.goStatsSnapshot({}, 'Illuminati').bonusPercent, 0);
    assert.equal(m.goStatsSnapshot(null, 'Illuminati'), null);
    for (const s of [{ wins: NaN }, { wins: 0, losses: -1, winStreak: 0, bonusPercent: 0 },
        { wins: 0, losses: 0, winStreak: 0, bonusPercent: Infinity }]) assert.equal(m.goStatsSnapshot({ Illuminati: s }, 'Illuminati'), null);
});

test('Daedalus RNG waits reduce measured productivity with no synthetic reward premium', () => {
    const fast = policyFixture().add('Daedalus', .3, 6, 5, { durationMs: 60_000 });
    const slow = policyFixture().add('Daedalus', .15, 6, 5, { durationMs: 120_000, rngWaitMs: 60_000 });
    const summarize = f => f.measurement.summarizeGoOpponent(f.telemetry, 'Daedalus', 5, f.epoch,
        f.stats.Daedalus.bonusPercent, f.clock.now);
    close(summarize(fast).bonusPerMinute, .3); close(summarize(slow).bonusPerMinute, .15);
    close(summarize(slow).rngWaitMs, 60_000);
});

test('Go persistence is bounded, round trips every observed field, and ignores duplicate games', () => {
    const f = policyFixture().add('The Black Hand', .1, 40), m = f.measurement;
    const b = f.telemetry.opponents['The Black Hand']['5'];
    assert.equal(b.games, 40); assert.equal(b.samples.length, m.GO_POLICY_WINDOW);
    assert.equal(m.recordGoObservation(f.telemetry, b.samples.at(-1)), false);
    const clean = m.parseGoTelemetry(JSON.stringify(f.telemetry), f.clock.now);
    assert.deepEqual(plain(clean), plain(f.telemetry));
    assert.equal(JSON.stringify(clean).includes('nodePower'), false);
});

test('missing, legacy, future-schema and corrupt optimizer files recover to cold start', () => {
    const f = policyFixture(), m = f.measurement;
    for (const raw of ['', '{', 'null', JSON.stringify({ version: 0, opponents: {} }),
        JSON.stringify({ type: 'go-opponent-policy', version: 2, opponents: {} }), 'x'.repeat(1_000_001)])
        assert.deepEqual(plain(m.parseGoTelemetry(raw, f.clock.now)), plain(m.emptyGoTelemetry()));
    assert.deepEqual(plain(m.readGoTelemetry({ read() { throw Error('bad disk'); } })), plain(m.emptyGoTelemetry()));
});

test('telemetry sanitizes all numeric observation fields without losing other opponents', () => {
    const f = policyFixture().add('Illuminati', .1, 1).add('Daedalus', .1, 1), m = f.measurement;
    const original = plain(f.telemetry);
    for (const key of ['size', 'startedAt', 'finishedAt', 'durationMs', 'score', 'margin', 'bonusDelta', 'bonusPerMinute', 'repDelta', 'rngWaitMs']) {
        const data = plain(original); data.opponents.Illuminati['5'].samples[0][key] = 'invalid';
        const clean = m.parseGoTelemetry(JSON.stringify(data), f.clock.now);
        assert.equal(clean.opponents.Illuminati['5'].samples.length, 0, key);
        assert.equal(clean.opponents.Daedalus['5'].samples.length, 1);
    }
    for (const side of ['before', 'after']) for (const key of ['wins', 'losses', 'winStreak', 'bonusPercent', 'rep']) {
        const data = plain(original); data.opponents.Illuminati['5'].samples[0][side][key] = 'invalid';
        assert.equal(m.parseGoTelemetry(JSON.stringify(data), f.clock.now).opponents.Illuminati['5'].samples.length, 0, side + key);
    }
    const forged = plain(original); forged.opponents.Illuminati['5'].samples[0].bonusPerMinute = 999;
    assert.equal(m.parseGoTelemetry(JSON.stringify(forged), f.clock.now).opponents.Illuminati['5'].samples.length, 0);
});

test('reward evidence expires on BitNode, node restart, SF14 or install changes; gameplay priors survive', () => {
    const f = policyFixture().add('Illuminati', .1), m = f.measurement;
    const summarize = (epoch = f.epoch, now = f.clock.now, bonus = f.stats.Illuminati.bonusPercent) =>
        m.summarizeGoOpponent(f.telemetry, 'Illuminati', 5, epoch, bonus, now);
    assert.equal(summarize().rewardSamples, 6);
    for (const patch of [{ currentNode: 5 }, { lastNodeReset: 101 }, { lastAugReset: 201 }, { ownedSF: new Map([[14, 1]]) }]) {
        const s = summarize(m.goRewardEpoch({ ...f.reset, ...patch }));
        assert.equal(s.rewardSamples, 0); assert.equal(s.gameplaySamples, 6); assert.equal(s.winRate, 1);
    }
    assert.equal(summarize(f.epoch, f.clock.now + m.GO_REWARD_MAX_AGE_MS + 1).bonusPerMinute, null);
    assert.equal(summarize(f.epoch, f.clock.now, 0).rewardSamples, 0);
    assert.equal(summarize(f.epoch, f.clock.now, 50).rewardSamples, 0, 'manual farming invalidates obsolete rates');
});

test('Go aggregates weight recent gains by actual duration, including zero gains and losses', () => {
    const f = policyFixture().add('Illuminati', .3, 3);
    const b = f.telemetry.opponents.Illuminati['5'];
    const s = b.samples.at(-1); s.after.bonusPercent = s.before.bonusPercent; s.bonusDelta = 0; s.bonusPerMinute = 0;
    f.stats.Illuminati = s.after;
    const summary = f.measurement.summarizeGoOpponent(f.telemetry, 'Illuminati', 5, f.epoch, s.after.bonusPercent, f.clock.now);
    assert.ok(summary.bonusPerMinute < summary.averageBonusPerMinute);
    assert.equal(summary.averageGameMs, 60_000); assert.equal(summary.averageScore, 15); assert.equal(summary.averageMargin, 7.5);
});

test('worked example: hacking dominates and university supplies 80% of XP', () => {
    const f = policyFixture().balance().add('Illuminati', .2).add('The Black Hand', .3);
    const r = f.choose({ incumbent: 'The Black Hand' });
    assert.equal(r.selectedOpponent, 'Illuminati'); assert.equal(r.selectionConfidence, 'HIGH');
    const expected = 2_100_000 - 2_100_000 / (1 + .2 / (100 + f.stats.Illuminati.bonusPercent) * .8 * .2);
    close(r.projectedMilestoneValue, expected); assert.match(r.selectionReason, /20.0%/);
    assert.equal(r.ranking.find(v => v.opponent === 'The Black Hand').projectedMilestoneValue, 0);
    const onlyScripts = f.choose({ jit: { ...f.jit, policy: { ...f.jit.policy, balance: { ...f.jit.policy.balance, scriptXpRate: 500e3 } } } });
    assert.ok(onlyScripts.projectedMilestoneValue > r.projectedMilestoneValue * 4.9);
    console.log(`Hacking/university: ${(r.projectedMilestoneValue / 1000).toFixed(3)}s saved/Go min`);
});

test('hacking XP never treats warming-up script models as total university-inclusive XP', () => {
    const f = policyFixture().balance({ xpSource: 'model (warming up)' }).add('Illuminati', .2);
    const r = f.choose(); assert.equal(r.selectionConfidence, 'PRIOR'); assert.equal(r.projectedMilestoneValue, null);
    f.jit.policy.balance.xpSource = 'measured'; f.jit.policy.balance.scriptXpRate = 0;
    assert.equal(f.choose().ranking[0].projectedMilestoneValue, 0);
});

test('a shorter hacking ETA cannot justify exploration when cash speed has no headroom', () => {
    const f = policyFixture().balance({ cashEtaMs: 2_400_000, hackingEtaMs: 300_000 });
    f.jit.capacity.limitingFactor = 'BATCH_RATE'; f.jit.capacity.constraints = ['BATCH_RATE'];
    f.add('The Black Hand', .1);
    const r = f.choose({ incumbent: 'The Black Hand' });
    assert.equal(r.selectedOpponent, 'The Black Hand'); assert.doesNotMatch(r.selectionReason, /targeted sample/);
});

test('worked example: timing headroom compares measured cash effects; either can win', () => {
    const f = policyFixture().add('The Black Hand', .12).add('Illuminati', .18);
    const r = f.choose({ incumbent: 'The Black Hand' });
    assert.equal(r.selectedOpponent, 'Illuminati'); assert.ok(r.projectedMilestoneValue > 0);
    const h = r.ranking.find(v => v.opponent === 'The Black Hand');
    assert.ok(r.projectedMilestoneValue > h.projectedMilestoneValue * 1.2);
    console.log(`Cash headroom: Illuminati ${(r.projectedMilestoneValue / 1000).toFixed(3)}s/min; Black Hand ${(h.projectedMilestoneValue / 1000).toFixed(3)}s/min`);
    const other = policyFixture().add('The Black Hand', .4).add('Illuminati', .1);
    assert.equal(other.choose({ incumbent: 'Illuminati' }).selectedOpponent, 'The Black Hand');
});

for (const ceiling of ['BATCH_RATE', 'LAUNCH_RATE', 'WORKER_LIMIT', 'TARGET_SLOTS', 'NO_PROFITABLE_TARGET'])
    test(`Illuminati cannot lift the cash scheduler ceiling ${ceiling}`, () => {
        const f = policyFixture().add('The Black Hand', .1).add('Illuminati', 1);
        f.jit.capacity.limitingFactor = ceiling; f.jit.capacity.constraints = ['RAM', ceiling];
        assert.equal(f.policy.goCashSpeedCapacity(f.jit).usable, false);
        const context = f.policy.goProgressionContext(f.objective, f.jit, f.clock.now);
        assert.equal(f.policy.projectGoMilestoneValue('HACKING_SPEED', 4, 1, context).value, 0);
        assert.equal(f.choose({ incumbent: 'Illuminati' }).selectedOpponent, 'The Black Hand');
    });

test('cash speed requires measured occupancy and caps gain to batch/worker/launch headroom', () => {
    const f = policyFixture();
    f.jit.capacity.constraints = []; f.jit.capacity.limitingFactor = 'NONE'; f.jit.capacity.ram.utilization = .1;
    assert.equal(f.policy.goCashSpeedCapacity(f.jit).usable, false);
    f.jit.capacity.ram.utilization = .95; f.jit.capacity.batchRate.limit = 2.001; f.jit.capacity.batchRate.remaining = .001;
    const context = f.policy.goProgressionContext(f.objective, f.jit, f.clock.now);
    close(f.policy.projectGoMilestoneValue('HACKING_SPEED', 0, 10, context).cashGain, .0005);
});

test('worked example: measured WORK reputation favors Daedalus without monetizing favor', () => {
    const f = policyFixture().add('Daedalus', .2);
    f.objective = { ...f.objective, milestone: 'RED_PILL', limitingResource: 'reputation', reputationStrategy: 'WORK',
        remainingCash: 0, selectedPlan: { next: { faction: 'Daedalus', repGap: 1e6, rate: 100,
            rateSource: 'measured', workActive: true, workEtaMs: 10e6 } } };
    const r = f.choose({ incumbent: 'The Black Hand' });
    assert.equal(r.selectedOpponent, 'Daedalus'); assert.equal(r.selectionConfidence, 'HIGH');
    close(r.projectedMilestoneValue, 10e6 - 10e6 / (1 + .2 / 105.2));
    assert.equal(r.ranking.length, 1); assert.match(r.selectionReason, /faction-work ETA/);
    console.log(`WORK reputation: ${(r.projectedMilestoneValue / 1000).toFixed(3)}s saved/Go min`);
    f.objective.selectedPlan.next.workActive = false;
    assert.equal(f.choose().projectedMilestoneValue, null);
});

test('worked example: DONATE Red Pill uses cash effects despite an underlying rep gap', () => {
    const f = policyFixture().add('The Black Hand', .3).add('Illuminati', .1).add('Daedalus', 3);
    f.objective = { ...f.objective, milestone: 'RED_PILL', reputationStrategy: 'DONATE',
        selectedPlan: { next: { faction: 'Daedalus', repGap: 2e6, rate: 100, workActive: true } } };
    const r = f.choose({ incumbent: 'Daedalus' });
    assert.equal(r.selectedOpponent, 'The Black Hand'); assert.match(r.selectionReason, /donation funding/);
    assert.ok(r.ranking.every(c => c.opponent !== 'Daedalus'));
    console.log(`DONATE cash: Black Hand ${(r.projectedMilestoneValue / 1000).toFixed(3)}s saved/Go min`);
});

test('Go multiplier ratios use 100 plus current bonus and never total bonus as utility', () => {
    const f = policyFixture(), context = f.policy.goProgressionContext(f.objective, f.jit, f.clock.now);
    const a = f.policy.projectGoMilestoneValue('HACKING_MONEY', 0, 1, context);
    const b = f.policy.projectGoMilestoneValue('HACKING_MONEY', 100, 1, context);
    close(a.cashGain, .005); close(b.cashGain, .0025); assert.ok(a.value > b.value);
    assert.equal(f.policy.projectGoMilestoneValue('HACKING_MONEY', 100, 0, context).value, 0);
});

for (const effect of ['COMBAT', 'CRIME', 'HACKNET']) test(`${effect} has zero value without an authenticated route model`, () => {
    const f = policyFixture(), context = f.policy.goProgressionContext({ ...f.objective, limitingResource: effect.toLowerCase() }, f.jit, f.clock.now);
    assert.equal(f.policy.projectGoMilestoneValue(effect, 0, 999, context).value, 0);
});

test('Go exploration deliberately fills three-game blocks only for plausible effects', () => {
    const f = policyFixture();
    assert.equal(f.choose().selectedOpponent, 'The Black Hand');
    assert.equal(f.choose({ incumbent: 'Illuminati' }).selectedOpponent, 'The Black Hand', 'unmeasured incumbent cannot override the cold-start prior');
    f.add('The Black Hand', .1, 2);
    assert.equal(f.choose({ incumbent: 'The Black Hand' }).selectedOpponent, 'The Black Hand');
    const warmed = policyFixture().add('The Black Hand', .1, 3);
    const next = warmed.choose({ incumbent: 'The Black Hand' });
    assert.equal(next.selectedOpponent, 'Illuminati'); assert.match(next.selectionReason, /targeted sample 1\/3/);
    const missing = f.choose({ jit: null, incumbent: 'The Black Hand' });
    assert.equal(missing.selectedOpponent, 'The Black Hand'); assert.equal(missing.selectionConfidence, 'PRIOR');
});

test('known milestone balance steers cold-start sampling away from a shorter irrelevant requirement', () => {
    const cash = policyFixture().balance({ cashEtaMs: 2_400_000, hackingEtaMs: 300_000 });
    cash.jit.capacity.limitingFactor = 'BATCH_RATE'; cash.jit.capacity.constraints = ['BATCH_RATE'];
    const c = cash.choose({ incumbent: 'Illuminati' });
    assert.equal(c.selectedOpponent, 'The Black Hand'); assert.match(c.selectionReason, /milestone balance/);
    const hack = policyFixture().balance(); hack.objective.limitingResource = 'cash';
    assert.equal(hack.choose({ incumbent: 'The Black Hand' }).selectedOpponent, 'Illuminati');
});

test('Go hysteresis holds a 5% challenger and switches for a material measured advantage', () => {
    // Account for cash response discounts and different current Go bonus baselines.
    const f = policyFixture().add('The Black Hand', .1).add('Illuminati', .07);
    const r = f.choose({ incumbent: 'The Black Hand' });
    const a = r.ranking.find(c => c.opponent === 'The Black Hand'), b = r.ranking.find(c => c.opponent === 'Illuminati');
    assert.ok(b.projectedMilestoneValue / a.projectedMilestoneValue > 1.04);
    assert.ok(b.projectedMilestoneValue / a.projectedMilestoneValue < 1.06);
    assert.equal(r.selectedOpponent, 'The Black Hand'); assert.match(r.selectionReason, /below 20%/);
    const better = policyFixture().add('The Black Hand', .1).add('Illuminati', .2);
    assert.equal(better.choose({ incumbent: 'The Black Hand' }).selectedOpponent, 'Illuminati');
});

test('configured size isolates observations and avoids simultaneous board-size optimization', () => {
    const f = policyFixture().add('The Black Hand', 2, 6, 7).add('Illuminati', .1);
    f.jit = null;
    const r = f.choose();
    assert.equal(r.selectedOpponent, 'The Black Hand'); assert.equal(r.telemetryGames, 0); assert.equal(r.bonusPerMinute, null);
});

test('fresh JIT evidence authenticates version, timestamp, PID and actual daemon ownership', () => {
    const f = policyFixture(); assert.equal(f.policy.readGoJitStatus(f.ns, f.clock.now), f.jit);
    const original = f.jit;
    for (const patch of [{ type: 'wrong' }, { version: 1 }, { generatedAt: f.clock.now + 1 },
        { generatedAt: f.clock.now - 15001 }, { generatedAt: 199 }, { pid: '9' }, { pid: 0 }]) {
        f.jit = { ...original, ...patch }; assert.equal(f.policy.readGoJitStatus(f.ns, f.clock.now), null, JSON.stringify(patch));
    }
    f.jit = original; f.ns.ps = () => [{ pid: 9, filename: 'another.js' }];
    assert.equal(f.policy.readGoJitStatus(f.ns, f.clock.now), null);
    f.ns.getPortHandle = () => { throw Error('unavailable'); };
    assert.equal(f.policy.readGoJitStatus(f.ns, f.clock.now), null);
});

test('stale or mismatched milestone balance cannot drive hacking valuation', () => {
    const f = policyFixture().balance().add('Illuminati', .2), original = f.jit.policy.balance;
    for (const patch of [{ generatedAt: f.clock.now + 1 }, { generatedAt: f.clock.now - 45001 },
        { milestone: 'OLD' }, { requiredHacking: 3000 }, { requiredCash: 1e9 }, { suspended: true }]) {
        f.jit.policy.balance = { ...original, ...patch };
        assert.equal(f.choose().projectedMilestoneValue, null, JSON.stringify(patch));
    }
});

test('missing JIT or invalid numeric capacity evidence keeps auto play on a clearly labeled prior', () => {
    const f = policyFixture().add('Illuminati', .5).add('The Black Hand', .1);
    const r = f.choose({ jit: null });
    assert.equal(r.selectedOpponent, 'The Black Hand'); assert.equal(r.selectionConfidence, 'PRIOR');
    assert.equal(r.projectedMilestoneValue, null);
    for (const value of [NaN, Infinity, -1, '0.95']) {
        f.jit.capacity.ram.utilization = value;
        assert.equal(f.policy.goCashSpeedCapacity(f.jit).known, false);
    }
});

test('optimizer persistence failure is an analytics limitation, never a play-safety exception', async () => {
    const f = policyFixture();
    assert.equal(await f.measurement.saveGoTelemetry({ write() { throw Error('disk'); } }, f.telemetry), false);
    assert.equal(await f.measurement.saveGoTelemetry({ write: async () => {}, read: () => 'truncated' }, f.telemetry), false);
});
