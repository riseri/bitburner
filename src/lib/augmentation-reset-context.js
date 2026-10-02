import { augmentationPackage } from "lib/augmentation-reset-policy.js";
import { recoveryEstimate } from "lib/augmentation-recovery.js";
import { formulaGroup } from "lib/formulas.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";
import { observeMilestoneRates, milestoneRate, MILESTONE_BALANCE } from "lib/milestone-balance.js";

const FIRST_RECOVERY_MS = 24 * 60 * 60 * 1000;

// Measure actual total player XP independently of the daemon's allocation/prep
// gates. Three stable positive windows are required; models never fill the gap.
export function observeEndgameXp(ns, context, state, now = Date.now()) {
    const objective = context.objective;
    if (objective.milestone !== "FINAL_SERVER" || objective.limitingResource !== "hacking") {
        delete state.endgameXp; return;
    }
    let work = null;
    try { work = ns.singularity.getCurrentWork(); } catch {}
    const key = JSON.stringify([context.resetEpoch, objective.requiredHacking,
        context.player.mults?.hacking, context.player.mults?.hacking_exp,
        work?.type, work?.classType, work?.location, work?.factionName, work?.factionWorkType,
        work?.companyName, work?.crimeType, work?.programName]);
    const series = state.endgameXp || (state.endgameXp = {});
    observeMilestoneRates(series, { key, now, xp: context.player.exp?.hacking });
    const direct = milestoneRate(series.xp), daemon = freshMilestoneBalance(context, now);
    if (direct.source === "measured") {
        // The script share is unknown here. Charge the entire Illuminati loss,
        // rather than crediting a modeled dedicated-worker share as measurement.
        context.balance = { milestone: objective.milestone, requiredHacking: objective.requiredHacking,
            requiredCash: objective.requiredCash, generatedAt: now, xpSource: "measured", xpRate: direct.rate,
            scriptXpRate: null, cashSource: "UNKNOWN", cashRate: null };
        context.endgameXp = { source: "manager measured", rate: direct.rate };
    } else if (daemon?.xpSource === "measured" && Number.isFinite(daemon.xpRate) && daemon.xpRate > 0) {
        context.endgameXp = { source: "daemon measured", rate: daemon.xpRate };
    } else {
        context.endgameXp = { source: direct.source, rate: null, samples: series.xp.length,
            requiredSamples: MILESTONE_BALANCE.samples, sampleMs: MILESTONE_BALANCE.sampleMs };
    }
    const usable = context.endgameXp.rate > 0;
    if (usable && !series.usable) state.nextEndgameQuoteAt = 0;
    series.usable = usable;
}

function freshMilestoneBalance(context, now = Date.now()) {
    const balance = context.balance, objective = context.objective;
    return balance && !balance.suspended && Number.isFinite(balance.generatedAt) &&
        now >= balance.generatedAt && now - balance.generatedAt <= 15000 &&
        balance.generatedAt >= context.reset.lastAugReset && balance.milestone === objective.milestone &&
        balance.requiredHacking === objective.requiredHacking && balance.requiredCash === objective.requiredCash ? balance : null;
}

// This adapter stays on the Singularity side. The daemon can supply authenticated
// measured rates too, but has no reset-policy ownership.
export function resetEconomics(ns, context, plan, state, pending) {
    const stats = {};
    for (const name of new Set(pending)) {
        try { stats[name] = ns.singularity.getAugmentationStats(name); } catch {}
    }
    const pack = augmentationPackage(context.installed, pending, stats);
    const nextPack = augmentationPackage(context.owned, plan.next ? [plan.next.name] : [],
        plan.next ? { [plan.next.name]: plan.next.stats } : {});
    const evidence = { reliable: false, reason: "Stable recovery history is not available", lanes: [] };
    const result = { package: pack, evidence };
    let recovery = recoveryEstimate(state, context);
    const objective = context.objective, next = plan.next;
    const completionGoal = objective.milestone === "FINAL_SERVER";
    result.completionGoal = completionGoal;
    if (!recovery && completionGoal) {
        const allowance = conservativeEndgameRecovery(ns, context);
        if (!allowance.recovery) {
            evidence.reason = `Measured augmentation-reset recovery unavailable: ${Array.isArray(state.recoveryProfile?.samples) ? state.recoveryProfile.samples.length : 0}/2 samples; conservative allowance blocked: ${allowance.reason}`;
            return result;
        }
        recovery = allowance.recovery;
    }
    if (!recovery) {
        return result;
    }
    evidence.recoveryMs = recovery.ms;
    evidence.recoverySource = recovery.source || "measured";
    evidence.confidence = recovery.source === "conservative" ? "LOW" : "MEDIUM";
    if (!completionGoal && (!next || !nextPack.complete || !Number.isFinite(next.etaMs) || next.etaMs < 0)) {
        evidence.reason = "Next augmentation ETA or stats unavailable"; return result;
    }
    const balance = freshMilestoneBalance(context), freshBalance = !!balance;
    const q = pack.multipliers, n = nextPack.multipliers;
    const positive = value => Number.isFinite(value) && value > 0;
    const haircut = v => v > 1 ? Math.min(4, 1 + (v - 1) * .5) : v;
    const lane = (resource, target, current, credit, rate, benefit, nextBenefit) => ({ resource,
        remainingMs: Math.max(0, target - current) / rate * 1000,
        lostMs: Math.max(0, Math.min(current, target) - credit) / rate * 1000,
        benefit, nextBenefit });
    if (objective.limitingResource === "reputation") {
        // Same endpoint: the selected augmentation installed. Historical recovery
        // must have rejoined this faction AND rebuilt at least today's hacking
        // skill; otherwise faction access/work-rate recovery is speculative.
        const repCredit = recovery.reputation(next.faction);
        if (!(next.rate > 0) || !Number.isFinite(next.rate) || next.donationPlanned || repCredit == null ||
            recovery.hacking < context.player.skills?.hacking || next.chainTarget && next.chainTarget !== next.name) {
            evidence.reason = "Faction access, work recovery or prerequisite-chain losses are uncertain"; return result;
        }
        evidence.acquisitionGoal = true;
        evidence.benefit = haircut(q.faction_rep); evidence.nextBenefit = n.faction_rep;
        evidence.lanes.push(lane("reputation", next.repRequired, next.repRequired - next.repGap,
            repCredit, next.rate * .8, evidence.benefit, n.faction_rep));
        // Live inflated price is a conservative upper bound after installation.
        // Do not translate hacking_money/grow/chance into a fictional cash gain.
        if (!freshBalance || balance.cashSource !== "measured" || !positive(balance.cashRate)) {
            evidence.reason = "Measured cash rate is unavailable for post-reset reacquisition"; return result;
        }
        evidence.lanes.push(lane("cash", (next.chainCost || next.price) + Math.max(0, plan.reserve || 0), context.money, recovery.cash,
            balance.cashRate * .8, 1, 1));
    } else if (objective.limitingResource === "hacking" && objective.requiredHacking > 0) {
        const skills = formulaGroup(ns, "skills", ["calculateExp"]);
        if (!skills) { evidence.reason = "Skill Formulas unavailable: need Formulas.exe and skills.calculateExp"; return result; }
        if (!context.multipliers) { evidence.reason = "BitNode hacking multiplier unavailable: need Source-File 5 or BitNode 5"; return result; }
        if (!freshBalance || balance.xpSource !== "measured" || !positive(balance.xpRate)) {
            const xp = context.endgameXp;
            evidence.reason = xp?.source?.includes("unstable") ? "Measured hacking XP rate unavailable: actual XP gains are unstable or zero"
                : xp ? `Measured hacking XP rate unavailable: observing actual player XP (${xp.samples}/${xp.requiredSamples} stable ${xp.sampleMs / 1000}s windows)`
                : "Measured hacking XP rate unavailable: daemon evidence is missing, stale or suspended";
            return result;
        }
        if (objective.requiredCash > 0 && (balance.cashSource !== "measured" || !positive(balance.cashRate))) {
            evidence.reason = "Measured milestone cash rate unavailable"; return result;
        }
        if (!Number.isFinite(context.player.exp?.hacking) || context.player.exp.hacking < 0) {
            evidence.reason = "Current player hacking XP unavailable"; return result;
        }
        const mult = context.player.mults?.hacking * context.multipliers.HackingLevelMultiplier;
        if (!positive(mult)) { evidence.reason = "Player or BitNode hacking multiplier is invalid"; return result; }
        try {
            const target = skills.calculateExp(objective.requiredHacking, mult);
            const queuedTarget = skills.calculateExp(objective.requiredHacking, mult * q.hacking);
            const largerTarget = skills.calculateExp(objective.requiredHacking, mult * q.hacking * n.hacking);
            if (![target, queuedTarget, largerTarget].every(v => Number.isFinite(v) && v > 0)) throw new Error("invalid skill target");
            // Exact inverse skill curve + direct XP multiplier. Price physical
            // reset losses BEFORE the conservative haircut and 4x ceiling, or
            // high Go power can veto every package regardless of its true gain.
            let benefit = target / queuedTarget * q.hacking_exp;
            if (completionGoal) {
                // Augmentation installation clears IPvGO speed power. Price that
                // loss only on script XP; university/player XP keeps its rate.
                const goStats = ns.go.analysis.getStats();
                if (!goStats || typeof goStats !== "object") throw new Error("unknown Go reset loss");
                const bonus = goStats.Illuminati?.bonusPercent ?? 0;
                if (!Number.isFinite(bonus) || bonus < 0) throw new Error("unknown Go reset loss");
                const share = Number.isFinite(balance.scriptXpRate) && balance.scriptXpRate >= 0
                    ? Math.min(1, balance.scriptXpRate / balance.xpRate) : 1;
                evidence.xpRetention = 1 - share * (1 - 100 / (100 + bonus));
                benefit *= evidence.xpRetention;
            }
            evidence.benefit = haircut(benefit);
            evidence.nextBenefit = haircut(queuedTarget / largerTarget * n.hacking_exp);
            evidence.lanes.push(lane("hacking XP", target, context.player.exp?.hacking, recovery.xp,
                balance.xpRate * .8, evidence.benefit, evidence.nextBenefit));
            if (objective.requiredCash > 0) evidence.lanes.push(lane("cash", objective.requiredCash, context.money,
                recovery.cash, balance.cashRate * .8, 1, 1));
        } catch { evidence.reason = "Reset XP or IPvGO loss cannot be projected"; return result; }
    } else {
        evidence.confidence = "LOW";
        evidence.reason = objective.limitingResource === "cash"
            ? "Cash multipliers do not establish post-reset scheduler throughput (LOW confidence)"
            : "Current objective has no reliable resource projection";
        return result;
    }
    evidence.reliable = pack.complete;
    evidence.reason = recovery.source === "conservative"
        ? "Conservative 24h recovery allowance, zero recovered XP; measured current XP rate (LOW confidence)"
        : "Measured recovery and resource rates; conservative multiplier projection";
    return result;
}

// A declared allowance, not a synthetic history sample. Only use it for the
// final server with productive live income and a verified restart on permanent RAM.
// The decision policy demands twice the projected finish speed for this case.
function conservativeEndgameRecovery(ns, context) {
    if (!(context.income > 0)) return { reason: "fresh authenticated daemon income unavailable" };
    if (!context.engineProductive) return { reason: "no live income pipeline" };
    try {
        if (!ns.fileExists("bootstrap.js", "home")) return { reason: "bootstrap.js missing" };
        try { restoreSupervisorArgs(ns.read("data/supervisor-bootstrap.json")); }
        catch { return { reason: "supervisor restart settings invalid or missing" }; }
        const costs = ["bootstrap.js", "supervisor.js", "augmentation-manager.js"].map(name => ns.getScriptRam(name, "home"));
        const homeRam = ns.getServerMaxRam("home");
        if (!costs.every(cost => Number.isFinite(cost) && cost > 0)) return { reason: "restart script RAM quotes unavailable" };
        if (!Number.isFinite(homeRam) || homeRam < costs.reduce((a, b) => a + b, 0)) return { reason: "permanent home RAM cannot run the restart scripts" };
        return { recovery: { source: "conservative", ms: FIRST_RECOVERY_MS, cash: 0, xp: 0, hacking: 0, reputation: () => null } };
    } catch { return { reason: "restart readiness checks unavailable" }; }
}

export function recoveryResources(ns, context) {
    const reputation = {};
    for (const faction of context.player.factions || []) {
        try { reputation[faction] = ns.singularity.getFactionRep(faction); } catch {}
    }
    return { cash: context.money, xp: context.player.exp?.hacking, hacking: context.player.skills?.hacking, reputation };
}
