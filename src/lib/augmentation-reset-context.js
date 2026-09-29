import { augmentationPackage } from "lib/augmentation-reset-policy.js";
import { recoveryEstimate } from "lib/augmentation-recovery.js";
import { formulaGroup } from "lib/formulas.js";

// This adapter stays on the Singularity side. The daemon only supplies its
// existing authenticated milestone rates; it has no reset-policy ownership.
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
    const recovery = recoveryEstimate(state, context), objective = context.objective, next = plan.next;
    if (!recovery) return result;
    evidence.recoveryMs = recovery.ms;
    if (!next || !nextPack.complete || !Number.isFinite(next.etaMs) || next.etaMs < 0) {
        evidence.reason = "Next augmentation ETA or stats unavailable"; return result;
    }
    const balance = context.balance;
    const freshBalance = balance && !balance.suspended && Number.isFinite(balance.generatedAt) &&
        Date.now() >= balance.generatedAt && Date.now() - balance.generatedAt <= 15000 &&
        balance.generatedAt >= context.reset.lastAugReset && balance.milestone === objective.milestone &&
        balance.requiredHacking === objective.requiredHacking && balance.requiredCash === objective.requiredCash;
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
        if (!freshBalance || balance.xpSource !== "measured" || balance.cashSource !== "measured" ||
            !positive(balance.xpRate) || !positive(balance.cashRate) || !skills || !context.multipliers) {
            evidence.reason = "Measured milestone cash/XP rates or skill Formulas unavailable"; return result;
        }
        const mult = context.player.mults?.hacking * context.multipliers.HackingLevelMultiplier;
        try {
            const target = skills.calculateExp(objective.requiredHacking, mult);
            const queuedTarget = skills.calculateExp(objective.requiredHacking, mult * q.hacking);
            const largerTarget = skills.calculateExp(objective.requiredHacking, mult * q.hacking * n.hacking);
            if (![target, queuedTarget, largerTarget].every(v => Number.isFinite(v) && v > 0)) throw new Error("invalid skill target");
            // Exact inverse skill curve + direct XP multiplier; only half the
            // implied gain is credited, with a 4x ceiling. Speed is left unpriced.
            evidence.benefit = haircut(target / queuedTarget * q.hacking_exp);
            evidence.nextBenefit = haircut(queuedTarget / largerTarget * n.hacking_exp);
            evidence.lanes.push(lane("hacking XP", target, context.player.exp?.hacking, recovery.xp,
                balance.xpRate * .8, evidence.benefit, evidence.nextBenefit));
            if (objective.requiredCash > 0) evidence.lanes.push(lane("cash", objective.requiredCash, context.money,
                recovery.cash, balance.cashRate * .8, 1, 1));
        } catch { evidence.reason = "Reset XP loss cannot be projected"; return result; }
    } else {
        evidence.confidence = "LOW";
        evidence.reason = objective.limitingResource === "cash"
            ? "Cash multipliers do not establish post-reset scheduler throughput (LOW confidence)"
            : "Current objective has no reliable resource projection";
        return result;
    }
    evidence.reliable = pack.complete;
    evidence.reason = "Measured recovery and resource rates; conservative multiplier projection";
    return result;
}

export function recoveryResources(ns, context) {
    const reputation = {};
    for (const faction of context.player.factions || []) {
        try { reputation[faction] = ns.singularity.getFactionRep(faction); } catch {}
    }
    return { cash: context.money, xp: context.player.exp?.hacking, hacking: context.player.skills?.hacking, reputation };
}
