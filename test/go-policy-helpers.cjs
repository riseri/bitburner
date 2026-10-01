const { Clock, Port, loadScript } = require('./helpers.cjs');

function policyFixture() {
    const clock = new Clock(10_000_000), policy = loadScript('lib/go-opponent-policy.js', clock);
    const measurement = loadScript('lib/go-opponent-telemetry.js', clock);
    const reset = { currentNode: 4, lastNodeReset: 100, lastAugReset: 200, ownedSF: new Map() };
    const epoch = measurement.goRewardEpoch(reset), telemetry = measurement.emptyGoTelemetry(), stats = {};
    const objective = { milestone: 'AUGMENTATIONS', limitingResource: 'cash', reputationStrategy: 'NONE',
        requiredCash: 100e9, remainingCash: 100e9, requiredHacking: null, currentHacking: 1200, resetEpoch: '4:100:200' };
    const jit = { type: 'jit-status', version: 2, generatedAt: clock.now, pid: 9, income60: 100e6,
        capacity: { version: 1, limitingFactor: 'RAM', constraints: ['RAM'], ram: { utilization: .95 },
            batchRate: { used: 2, limit: 10, remaining: 8 }, launches: { recent: 8, limit: 1000 },
            workers: { committed: 100, limit: 5000 } }, policy: { xp: { state: 'RUNNING' } } };
    const f = { clock, policy, measurement, reset, epoch, telemetry, stats, objective, jit };
    f.choose = (patch = {}) => policy.selectGoOpponent({ objective: f.objective, jit: f.jit,
        telemetry, stats, size: 5, epoch: f.epoch, now: clock.now, ...patch });
    f.add = (opponent, pace, count = 6, size = 5, options = {}) => {
        for (let i = 0; i < count; i++) {
            const durationMs = options.durationMs || 60_000, finishedAt = clock.now - (count - 1 - i) * (durationMs + 1);
            const bonusDelta = pace * durationMs / 60_000, bonus = (options.bonus ?? 4) + bonusDelta * i;
            const before = { wins: i, losses: 0, winStreak: i, bonusPercent: bonus, rep: 0 };
            const after = { ...before, wins: i + 1, winStreak: i + 1, bonusPercent: bonus + bonusDelta };
            const start = measurement.beginGoObservation({ opponent, size, epoch: f.epoch,
                stats: { [opponent]: before }, member: false, now: finishedAt - durationMs });
            const sample = measurement.finishGoObservation(start, { snapshot: { opponent, board: Array(size),
                game: { currentPlayer: 'None', blackScore: 15, whiteScore: 7.5 } }, stats: { [opponent]: after },
                member: false, rngWaitMs: options.rngWaitMs || 0, now: finishedAt });
            if (!sample || !measurement.recordGoObservation(telemetry, sample)) throw new Error('invalid test observation');
            stats[opponent] = after;
        }
        return f;
    };
    f.balance = (patch = {}) => {
        f.objective = { ...f.objective, milestone: 'DAEDALUS', limitingResource: 'hacking',
            requiredHacking: 2500, currentHacking: 2000, requiredCash: 100e9, remainingCash: 48e9 };
        f.jit.policy.balance = { milestone: 'DAEDALUS', requiredHacking: 2500, requiredCash: 100e9,
            generatedAt: clock.now, cashEtaMs: 480_000, hackingEtaMs: 2_100_000,
            cashRate: 100e6, xpRate: 500e3, scriptXpRate: 100e3, cashSource: 'measured', xpSource: 'measured',
            ...patch };
        return f;
    };
    f.ns = { getResetInfo: () => f.reset, ps: () => [{ pid: 9, filename: 'daemon.js' }],
        getPortHandle: () => ({ peek: () => f.jit }) };
    return f;
}

module.exports = { policyFixture, Clock, Port, loadScript };
