import { GO_OPPONENTS } from "lib/go-session.js";

export const GO_POLICY_FILE = "data/go-opponent-policy.json";
export const GO_POLICY_VERSION = 1;
export const GO_POLICY_WINDOW = 24;
export const GO_REWARD_MAX_AGE_MS = 3_600_000;
const GO_POLICY_MAX_BYTES = 1_000_000;

function goFinite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Number.isFinite(value) && value >= min && value <= max;
}

/** Reward identity deliberately includes installs: stable Go clears power on augmentation. */
export function goRewardEpoch(reset) {
    if (!Number.isSafeInteger(reset?.currentNode) || reset.currentNode < 1 ||
        ![reset.lastNodeReset, reset.lastAugReset].every(n => goFinite(n))) return "";
    const sf = reset.ownedSF?.get?.(14) ?? 0;
    return `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}:${Number.isSafeInteger(sf) && sf >= 0 ? sf : 0}`;
}

/** Missing opponents in getStats are unplayed, with zero accumulated rewards. */
export function goStatsSnapshot(stats, opponent) {
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
    const s = stats?.[opponent] ?? { wins: 0, losses: 0, winStreak: 0, bonusPercent: 0, rep: 0 };
    if (![s.wins, s.losses].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isSafeInteger(s.winStreak) || !goFinite(s.bonusPercent)) return null;
    return { wins: s.wins, losses: s.losses, winStreak: s.winStreak,
        bonusPercent: s.bonusPercent, rep: goFinite(s.rep) ? s.rep : null };
}

export function beginGoObservation({ opponent, size, epoch, stats, member, now = Date.now() }) {
    if (!GO_OPPONENTS.includes(opponent) || ![5, 7, 9, 13].includes(size) || !epoch || !goFinite(now)) return null;
    const before = goStatsSnapshot(stats, opponent);
    return before ? { opponent, size, epoch, startedAt: now, before, memberBefore: Boolean(member) } : null;
}

/** Caller must first prove the full game's ownership and its final transition. */
export function finishGoObservation(start, { snapshot, stats, member, rngWaitMs = 0, now = Date.now() }) {
    if (!start || snapshot?.game?.currentPlayer !== "None" || snapshot.opponent !== start.opponent ||
        snapshot.board.length !== start.size || snapshot.epoch && snapshot.epoch !== start.epoch.split(":").slice(0, 3).join(":") ||
        !goFinite(now) || now <= start.startedAt ||
        !goFinite(rngWaitMs, 0, now - start.startedAt) || !stats?.[start.opponent]) return null;
    const after = goStatsSnapshot(stats, start.opponent), before = start.before;
    const score = snapshot.game.blackScore, margin = score - snapshot.game.whiteScore;
    const won = margin >= 0;
    if (!after || !goFinite(score, 0, start.size ** 2) || !goFinite(margin, -1000, 1000) ||
        after.wins - before.wins !== (won ? 1 : 0) || after.losses - before.losses !== (won ? 0 : 1) ||
        after.bonusPercent < before.bonusPercent ||
        (before.rep !== null && after.rep !== null && after.rep < before.rep)) return null;
    const durationMs = now - start.startedAt, bonusDelta = after.bonusPercent - before.bonusPercent;
    return { opponent: start.opponent, size: start.size, epoch: start.epoch, startedAt: start.startedAt,
        finishedAt: now, durationMs, won, score, margin, before, after, bonusDelta,
        bonusPerMinute: bonusDelta * 60_000 / durationMs,
        repDelta: before.rep !== null && after.rep !== null ? after.rep - before.rep : null,
        memberBefore: start.memberBefore, memberAfter: Boolean(member), rngWaitMs };
}

function validGoSample(s, opponent, size, now) {
    if (!s || s.opponent !== opponent || s.size !== size || typeof s.epoch !== "string" ||
        !/^\d+:\d+(?:\.\d+)?:\d+(?:\.\d+)?:\d+$/.test(s.epoch) || s.epoch.length > 100 ||
        !goFinite(s.startedAt) || !goFinite(s.finishedAt, s.startedAt + 1, now) ||
        !goFinite(s.durationMs, 1) || s.durationMs !== s.finishedAt - s.startedAt ||
        typeof s.won !== "boolean" || typeof s.memberBefore !== "boolean" || typeof s.memberAfter !== "boolean" ||
        !goFinite(s.score, 0, size ** 2) || !goFinite(s.margin, -1000, 1000) ||
        !goFinite(s.rngWaitMs, 0, s.durationMs) || !goFinite(s.bonusDelta) || !goFinite(s.bonusPerMinute) ||
        !(s.repDelta === null || goFinite(s.repDelta))) return null;
    for (const stat of [s.before, s.after]) {
        if (!stat || !(stat.rep === null || goFinite(stat.rep)) || !goStatsSnapshot({ [opponent]: stat }, opponent)) return null;
    }
    // Recompute every derived field; an edited file cannot inject synthetic reward rates.
    const measured = finishGoObservation({ opponent, size, epoch: s.epoch, startedAt: s.startedAt,
        before: s.before, memberBefore: s.memberBefore }, { snapshot: { opponent, board: Array(size),
            game: { currentPlayer: "None", blackScore: s.score, whiteScore: s.score - s.margin } },
        stats: { [opponent]: s.after }, member: s.memberAfter, rngWaitMs: s.rngWaitMs, now: s.finishedAt });
    if (!measured || Math.abs(measured.bonusDelta - s.bonusDelta) > 1e-9 ||
        Math.abs(measured.bonusPerMinute - s.bonusPerMinute) > 1e-9 || measured.repDelta !== s.repDelta || measured.won !== s.won) return null;
    return measured;
}

export function emptyGoTelemetry() {
    return { type: "go-opponent-policy", version: GO_POLICY_VERSION, opponents: {} };
}

/** Unknown schemas are a safe cold start; valid buckets survive partial corruption. */
export function parseGoTelemetry(text, now = Date.now()) {
    const clean = emptyGoTelemetry();
    if (!text) return clean;
    try {
        if (typeof text !== "string" || text.length > GO_POLICY_MAX_BYTES) return clean;
        const value = JSON.parse(text);
        if (value?.type !== clean.type || value.version !== GO_POLICY_VERSION || !value.opponents) return clean;
        for (const opponent of GO_OPPONENTS) for (const size of [5, 7, 9, 13]) {
            const bucket = value.opponents[opponent]?.[size];
            if (!bucket || !Number.isSafeInteger(bucket.games) || bucket.games < 0 || !Array.isArray(bucket.samples)) continue;
            const samples = bucket.samples.slice(-GO_POLICY_WINDOW).map(s => validGoSample(s, opponent, size, now)).filter(Boolean)
                .sort((a, b) => a.finishedAt - b.finishedAt);
            clean.opponents[opponent] ||= {};
            clean.opponents[opponent][size] = { games: Math.max(bucket.games, samples.length), samples };
        }
    } catch { /* Analytics corruption must never grant or deny board ownership. */ }
    return clean;
}

export function readGoTelemetry(ns, now = Date.now()) {
    try { return parseGoTelemetry(ns.read(GO_POLICY_FILE), now); } catch { return emptyGoTelemetry(); }
}

export function recordGoObservation(telemetry, sample) {
    const valid = validGoSample(sample, sample?.opponent, sample?.size, sample?.finishedAt);
    if (!valid || !GO_OPPONENTS.includes(valid.opponent) || ![5, 7, 9, 13].includes(valid.size)) return false;
    telemetry.opponents[valid.opponent] ||= {};
    const bucket = telemetry.opponents[valid.opponent][valid.size] ||= { games: 0, samples: [] };
    if (bucket.samples.some(s => s.epoch === valid.epoch && s.startedAt === valid.startedAt && s.finishedAt === valid.finishedAt)) return false;
    bucket.games = Math.min(Number.MAX_SAFE_INTEGER, bucket.games + 1);
    bucket.samples = [...bucket.samples, valid].slice(-GO_POLICY_WINDOW);
    return true;
}

export async function saveGoTelemetry(ns, telemetry) {
    try {
        const text = JSON.stringify(telemetry);
        await ns.write(GO_POLICY_FILE, text, "w");
        return ns.read(GO_POLICY_FILE) === text;
    } catch { return false; }
}

export function summarizeGoOpponent(telemetry, opponent, size, epoch, currentBonus, now = Date.now()) {
    const bucket = telemetry?.opponents?.[opponent]?.[size], samples = bucket?.samples || [];
    // A live bonus moving far beyond our observations (e.g. manual farming) makes
    // those marginal returns obsolete. Do not reconstruct hidden node power.
    const current = samples.filter(s => s.epoch === epoch && now >= s.finishedAt && now - s.finishedAt <= GO_REWARD_MAX_AGE_MS);
    const latestBonus = current.at(-1)?.after.bonusPercent;
    const comparable = goFinite(currentBonus) && goFinite(latestBonus) && currentBonus + 1e-9 >= latestBonus &&
        currentBonus - latestBonus <= Math.max(.25, latestBonus * .10);
    const rewards = comparable ? current.filter(s => s.after.bonusPercent <= currentBonus + 1e-9) : [];
    const sum = field => samples.reduce((n, s) => n + s[field], 0);
    const average = field => samples.length ? sum(field) / samples.length : null;
    const weighted = rewards.slice(-6).reduce((out, s, i, list) => {
        const weight = .7 ** (list.length - 1 - i);
        out.bonus += s.bonusDelta * weight; out.ms += s.durationMs * weight;
        return out;
    }, { bonus: 0, ms: 0 });
    return { games: bucket?.games || 0, gameplaySamples: samples.length, rewardSamples: rewards.length,
        winRate: samples.length ? samples.filter(s => s.won).length / samples.length : null,
        averageGameMs: average("durationMs"), averageScore: average("score"), averageMargin: average("margin"),
        averageBonus: rewards.length ? rewards.reduce((n, s) => n + s.bonusDelta, 0) / rewards.length : null,
        averageBonusPerMinute: rewards.length ? rewards.reduce((n, s) => n + s.bonusDelta, 0) * 60_000 /
            rewards.reduce((n, s) => n + s.durationMs, 0) : null,
        bonusPerMinute: weighted.ms > 0 ? weighted.bonus * 60_000 / weighted.ms : null,
        repDelta: samples.at(-1)?.repDelta ?? null, member: samples.at(-1)?.memberAfter ?? null,
        rngWaitMs: average("rngWaitMs") };
}
