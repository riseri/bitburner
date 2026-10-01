import { PORTS } from "lib/ports.js";
import { GO_OPPONENTS } from "lib/go-session.js";
import { goStatsSnapshot, summarizeGoOpponent } from "lib/go-opponent-telemetry.js";

// Stable semantics, independent of translated UI descriptions and hidden power.
export const GO_OPPONENT_EFFECTS = Object.freeze({
    "Netburners": "HACKNET", "Slum Snakes": "CRIME", "The Black Hand": "HACKING_MONEY",
    "Tetrads": "COMBAT", "Daedalus": "REPUTATION", "Illuminati": "HACKING_SPEED",
});
export const GO_EFFECT_LABELS = Object.freeze({ HACKNET: "hacknet production", CRIME: "crime success",
    HACKING_MONEY: "hacking money", COMBAT: "combat stats", REPUTATION: "faction/company reputation", HACKING_SPEED: "hacking speed" });
export const GO_POLICY_MIN_SAMPLES = 3;
export const GO_POLICY_SWITCH_ADVANTAGE = 1.20;

function goNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function goPositive(value) { return Number.isFinite(value) && value > 0 ? value : null; }
function goFresh(at, now, maxAge = 15_000) { return Number.isFinite(at) && at <= now && now - at <= maxAge; }

export function readGoStats(ns) {
    try {
        const stats = ns.go.analysis.getStats();
        return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : null;
    } catch { return null; }
}

/** Ports are hints only until their producer, version and reset age are authenticated. */
export function readGoJitStatus(ns, now = Date.now()) {
    try {
        const s = ns.getPortHandle(PORTS.JIT_STATUS).peek(), reset = ns.getResetInfo();
        if (s?.type !== "jit-status" || s.version !== 2 || !goFresh(s.generatedAt, now) ||
            s.generatedAt < Math.max(reset.lastAugReset, reset.lastNodeReset) ||
            !Number.isSafeInteger(s.pid) || s.pid <= 0 ||
            !ns.ps("home").some(p => p.pid === s.pid && p.filename === "daemon.js")) return null;
        return s;
    } catch { return null; }
}

/** The old semantic choice remains a prior, including donation funding at RED_PILL. */
export function progressionGoPrior(objective) {
    if (objective?.reputationStrategy === "DONATE" && objective.limitingResource === "cash") return "The Black Hand";
    if (objective?.limitingResource === "hacking") return "Illuminati";
    if (objective?.limitingResource === "cash") return "The Black Hand";
    return "Daedalus";
}

function goCapacity(jit) {
    const c = jit?.capacity;
    if (c?.version !== 1 || typeof c.limitingFactor !== "string" || !Array.isArray(c.constraints) ||
        c.constraints.length > 20 || c.constraints.some(v => typeof v !== "string") ||
        ![c.ram?.utilization, c.batchRate?.used, c.batchRate?.remaining, c.launches?.recent, c.workers?.committed]
            .every(n => goNonnegative(n) !== null) ||
        ![c.batchRate?.limit, c.launches?.limit, c.workers?.limit].every(n => goPositive(n) !== null) ||
        c.ram.utilization > 1.01 || c.batchRate.remaining > c.batchRate.limit ||
        Math.abs(c.batchRate.remaining - Math.max(0, c.batchRate.limit - c.batchRate.used)) > .01) return null;
    return c;
}

/** Speed can release temporal RAM, but cannot lift configured scheduler ceilings. */
export function goCashSpeedCapacity(jit) {
    const c = goCapacity(jit);
    if (!c) return { usable: false, known: false, headroom: 0, reason: "scheduler capacity unavailable" };
    const limits = new Set([c.limitingFactor, ...c.constraints]);
    const ceiling = ["BATCH_RATE", "LAUNCH_RATE", "WORKER_LIMIT", "TARGET_SLOTS", "NO_PROFITABLE_TARGET", "RECOVERY", "PREPARATION"]
        .find(code => limits.has(code));
    if (ceiling) return { usable: false, known: true, headroom: 0, reason: `${ceiling} limits cash throughput` };
    const headroom = Math.max(0, Math.min(
        c.batchRate.remaining / Math.max(c.batchRate.used, .001),
        (c.launches.limit - c.launches.recent) / Math.max(c.launches.recent, 1),
        (c.workers.limit - c.workers.committed) / Math.max(c.workers.committed, 1)));
    const occupancy = limits.has("RAM") || c.ram.utilization >= .8;
    return { usable: occupancy && headroom > 0 && c.batchRate.used > 0, known: true, headroom,
        reason: occupancy ? "temporal RAM occupancy with scheduler headroom" : "no measured action-time pressure" };
}

function goLiveBalance(objective, jit, now) {
    const b = jit?.policy?.balance;
    if (!objective || !b || !goFresh(b.generatedAt, now, 45_000) || b.generatedAt > jit.generatedAt ||
        b.generatedAt < Number(objective.resetEpoch?.split(":")[2] || 0) ||
        b.milestone !== objective?.milestone || b.requiredHacking !== (objective.requiredHacking ?? null) ||
        b.requiredCash !== (objective.requiredCash ?? null) || b.suspended) return null;
    return b;
}

export function goProgressionContext(objective, jit, now = Date.now()) {
    const prior = progressionGoPrior(objective), b = goLiveBalance(objective, jit, now), next = objective?.selectedPlan?.next;
    const active = !!objective && !objective.resetImminent && !["installation", "completion", "purchase", "invitation", "discovery"].includes(objective.limitingResource);
    const cashNeeded = active && (objective.limitingResource === "cash" || goPositive(objective.remainingCash) !== null);
    const hackingNeeded = active && (objective.limitingResource === "hacking" ||
        (goPositive(objective.requiredHacking) !== null && goNonnegative(objective.currentHacking) !== null && objective.currentHacking < objective.requiredHacking));
    const repNeeded = active && objective.reputationStrategy === "WORK" && objective.limitingResource === "reputation";
    const income = goPositive(jit?.income60), cashRate = goPositive(b?.cashRate) || income;
    const cashEtaMs = !cashNeeded ? 0 : goNonnegative(b?.cashEtaMs) ??
        (goNonnegative(objective?.remainingCash) !== null && income ? objective.remainingCash / income * 1000 : null);
    const hackingEtaMs = !hackingNeeded ? 0 : goNonnegative(b?.hackingEtaMs);
    // Total measured player XP includes university work; only this modeled script
    // fraction responds to Go speed. Warming-up script-only totals are not proof.
    const scriptFraction = b?.xpSource === "measured" && goPositive(b.xpRate) && goNonnegative(b.scriptXpRate) !== null
        ? Math.min(1, b.scriptXpRate / b.xpRate) : null;
    const repRate = goPositive(next?.rate), repGap = goNonnegative(next?.repGap);
    const repEtaMs = !repNeeded ? 0 : repRate && repGap !== null && next.workActive !== false ? repGap / repRate * 1000 : null;
    const speed = goCashSpeedCapacity(jit);
    const scriptRunning = jit?.policy?.xp?.state === "RUNNING";
    const c = goCapacity(jit);
    const xpCeiling = c && [c.limitingFactor, ...c.constraints].some(code => ["LAUNCH_RATE", "WORKER_LIMIT", "RECOVERY"].includes(code));
    const baselineKnown = [cashEtaMs, hackingEtaMs, repEtaMs].every(n => goNonnegative(n) !== null);
    const candidates = [];
    if (cashNeeded) candidates.push("The Black Hand");
    if (hackingNeeded || cashNeeded && (!speed.known || speed.usable)) candidates.push("Illuminati");
    if (repNeeded) candidates.push("Daedalus");
    if (!candidates.length) candidates.push(prior);
    return { objective, prior, active, cashNeeded, hackingNeeded, repNeeded, income, cashRate,
        cashEtaMs, hackingEtaMs, repEtaMs, scriptFraction, scriptRunning, xpCeiling, speed, candidates,
        baselineMs: baselineKnown ? Math.max(cashEtaMs, hackingEtaMs, repEtaMs) : null,
        cashIncomeShare: income && cashRate ? Math.min(1, income / cashRate) : null,
        repMeasured: next?.rateSource === "measured" && next.workActive === true,
        balanceMeasured: b?.cashSource === "measured" && b?.xpSource === "measured" };
}

/** Expected milestone milliseconds saved by one real minute of this Go effect. */
export function projectGoMilestoneValue(effect, bonusPercent, bonusPerMinute, context) {
    if (![bonusPercent, bonusPerMinute].every(n => goNonnegative(n) !== null)) return { value: null, reason: "collecting opponent reward evidence" };
    if (!["HACKING_MONEY", "HACKING_SPEED", "REPUTATION"].includes(effect)) return { value: 0, reason: "no authenticated objective for this effect" };
    const p = context;
    if (!p.active) return { value: 0, reason: "no active progression requirement" };
    if (p.baselineMs === null) return { value: null, reason: "milestone ETA evidence unavailable" };
    const relative = bonusPerMinute / (100 + bonusPercent); // (1+(b+delta)/100)/(1+b/100) - 1
    let cashGain = 0, xpGain = 0, repGain = 0, reason = "effect does not advance the current bottleneck";
    if (effect === "HACKING_MONEY" && p.cashNeeded) {
        if (p.cashIncomeShare === null) return { value: null, reason: "fresh JIT cash income unavailable" };
        cashGain = relative * .5 * p.cashIncomeShare;
        reason = p.objective.reputationStrategy === "DONATE" ? "donation funding is a cash requirement" : "discounted hacking-money income benefit";
    }
    if (effect === "HACKING_SPEED") {
        if (p.cashNeeded && p.speed.usable) cashGain = Math.min(relative * .75, p.speed.headroom) * (p.cashIncomeShare ?? 0);
        if (p.hackingNeeded) {
            if (p.scriptFraction === null || !p.scriptRunning) return { value: null, reason: "total/script XP evidence unavailable" };
            xpGain = p.xpCeiling ? 0 : relative * .8 * p.scriptFraction;
        }
        reason = p.hackingNeeded ? `script-attributable XP ${(100 * (p.scriptFraction ?? 0)).toFixed(1)}% of total`
            : p.speed.reason;
    }
    if (effect === "REPUTATION" && p.repNeeded) {
        repGain = relative;
        reason = "direct faction-work ETA reduction";
    }
    const afterMs = Math.max(p.cashEtaMs / (1 + cashGain), p.hackingEtaMs / (1 + xpGain), p.repEtaMs / (1 + repGain));
    const value = Math.max(0, p.baselineMs - afterMs);
    return { value, reason: value === 0 && (cashGain > 0 || xpGain > 0 || repGain > 0) ? "a longer milestone requirement remains unchanged" : reason,
        baselineMs: p.baselineMs, afterMs, cashGain, xpGain, repGain };
}

function goCandidateConfidence(samples, projection, context, effect) {
    if (!samples) return "PRIOR";
    if (samples < GO_POLICY_MIN_SAMPLES) return "LOW";
    const modeled = projection.value === null || effect === "REPUTATION" && !context.repMeasured ||
        context.hackingNeeded && !context.balanceMeasured;
    return samples >= 6 && !modeled ? "HIGH" : "MEDIUM";
}

export function selectGoOpponent({ objective = null, jit = null, telemetry, stats = {}, size = 5, epoch = "", incumbent = "", now = Date.now() }) {
    const context = goProgressionContext(objective, jit, now);
    const ranking = context.candidates.filter(opponent => GO_OPPONENTS.includes(opponent)).map(opponent => {
        const effect = GO_OPPONENT_EFFECTS[opponent], bonus = goStatsSnapshot(stats, opponent)?.bonusPercent ?? null;
        const evidence = summarizeGoOpponent(telemetry, opponent, size, epoch, bonus, now);
        const projection = projectGoMilestoneValue(effect, bonus, evidence.bonusPerMinute, context);
        return { opponent, effect, bonusPercent: bonus, bonusPerMinute: evidence.bonusPerMinute,
            projectedMilestoneValue: projection.value, confidence: goCandidateConfidence(evidence.rewardSamples, projection, context, effect),
            telemetryGames: evidence.games, rewardSamples: evidence.rewardSamples, reason: projection.reason };
    }).sort((a, b) => (b.projectedMilestoneValue ?? -1) - (a.projectedMilestoneValue ?? -1) ||
        Number(b.opponent === context.prior) - Number(a.opponent === context.prior) || a.opponent.localeCompare(b.opponent));
    let prior = ranking.find(r => r.opponent === context.prior) || ranking[0];
    const potential = r => projectGoMilestoneValue(r.effect, r.bonusPercent, 1, context).value;
    // An authenticated longer requirement can make the label's effect irrelevant,
    // even before reward sampling. Do not bootstrap by farming that shorter ETA.
    if (potential(prior) === 0) prior = ranking.find(r => potential(r) > 0) || prior;
    const old = ranking.find(r => r.opponent === incumbent);
    let selected = prior, reason, confidence;
    // Explore in three-game blocks, only with evidence that the effect can help.
    // Missing JIT/ETA evidence stays with the semantic prior, never random farming.
    const plausible = ranking.filter(r => ["HACKING_MONEY", "HACKING_SPEED"].includes(r.effect) &&
        potential(r) > 0);
    const exploring = plausible.find(r => r.opponent === incumbent && r.rewardSamples > 0 && r.rewardSamples < GO_POLICY_MIN_SAMPLES) ||
        plausible.find(r => r.opponent === prior.opponent && r.rewardSamples < GO_POLICY_MIN_SAMPLES) ||
        plausible.find(r => r.rewardSamples < GO_POLICY_MIN_SAMPLES);
    const best = ranking.find(r => r.rewardSamples >= GO_POLICY_MIN_SAMPLES && r.projectedMilestoneValue > 0);
    if (exploring && plausible.length > 1) {
        selected = exploring; reason = `targeted sample ${selected.rewardSamples + 1}/${GO_POLICY_MIN_SAMPLES}; ${selected.reason}`;
        confidence = selected.confidence;
    } else if (best) {
        selected = best;
        if (old && old !== best && old.rewardSamples >= GO_POLICY_MIN_SAMPLES && old.projectedMilestoneValue > 0 &&
            best.projectedMilestoneValue < old.projectedMilestoneValue * GO_POLICY_SWITCH_ADVANTAGE) {
            selected = old; reason = "incumbent retained; challenger advantage below 20%";
        } else reason = `${selected.reason}; best measured milestone benefit`;
        confidence = selected.confidence;
    } else {
        reason = `${objective?.reputationStrategy === "DONATE" ? "donation funding; " : ""}` +
            (prior.opponent !== context.prior ? `milestone balance favors ${GO_EFFECT_LABELS[prior.effect]}; ` : `${objective?.limitingResource || "unknown"} bottleneck; `) +
            (prior.bonusPerMinute === null ? "collecting opponent evidence" : `${prior.reason}; semantic prior`);
        confidence = "PRIOR";
    }
    return { autoOpponent: true, policyGeneratedAt: now, selectedOpponent: selected.opponent, selectionReason: reason,
        selectionConfidence: confidence, objective: objective ? { milestone: objective.milestone || "unknown",
            limitingResource: objective.limitingResource || "unknown", reputationStrategy: objective.reputationStrategy || "NONE",
            balance: context.baselineMs === null ? "ETAs unknown" : context.repNeeded && context.repEtaMs === context.baselineMs ? "reputation work"
                : context.hackingEtaMs > context.cashEtaMs ? "hacking behind" : context.cashEtaMs > context.hackingEtaMs ? "cash behind" : "ETAs balanced" } : null,
        effect: selected.effect, bonusPerMinute: selected.bonusPerMinute, projectedMilestoneValue: selected.projectedMilestoneValue,
        telemetryGames: selected.telemetryGames, ranking: ranking.slice(0, 3) };
}

export function pinnedGoPolicy(opponent, autoOpponent = false, reason = "explicit --opponent pins new games") {
    return { autoOpponent, policyGeneratedAt: Date.now(), selectedOpponent: opponent, effect: GO_OPPONENT_EFFECTS[opponent] || "UNKNOWN",
        selectionReason: reason, selectionConfidence: "PRIOR", bonusPerMinute: null, projectedMilestoneValue: null,
        telemetryGames: 0, objective: null, ranking: [] };
}
