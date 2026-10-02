import { routeInstallation } from "lib/bitnode-route.js";

// Only multiplicative player fields. Special augmentation effects are deliberately
// not converted into throughput (including focus, programs and starting money).
const FIELDS = ["hacking", "hacking_exp", "hacking_money", "hacking_grow", "hacking_speed",
    "hacking_chance", "faction_rep", "company_rep", "work_money", "strength", "defense", "dexterity", "agility"];
export const RESET_POLICY = Object.freeze({ observationMs: 60000, staleMs: 15000,
    margin: .20, minSavingMs: 30000, minBenefit: 1.15, rateTolerance: .25 });

export function augmentationPackage(installed, pending, stats) {
    const multipliers = Object.fromEntries(FIELDS.map(k => [k, 1])), names = [], missing = [];
    const seen = new Set(installed);
    for (const name of pending) {
        // NFG API stats are per level; each queued occurrence is one extra level.
        if (name !== "NeuroFlux Governor" && seen.has(name)) continue;
        seen.add(name); names.push(name);
        const value = stats[name];
        if (!value || typeof value !== "object") { missing.push(name); continue; }
        for (const field of FIELDS) {
            const n = value[field] ?? 1;
            if (!Number.isFinite(n) || n <= 0) { missing.push(name + ":" + field); continue; }
            multipliers[field] *= n;
            if (!Number.isFinite(multipliers[field])) missing.push(field);
        }
    }
    return { names, multipliers, complete: !missing.length, missing };
}

// Pure decision: callers supply resource durations, never purchase utility scores.
// Hacking/cash goals compare readiness at the SAME milestone after either reset.
// Reputation goals compare owning the next augmentation INSTALLED: resetting now
// requires reacquiring it from reset reputation and a second recovery. WAIT has
// already acquired it, so we must not charge that reputation workload twice.
export function decideAugmentationReset(input) {
    if (input.completionGoal) return decideCompletionReset(input);
    const { pending = [], installed = [], plan = { errors: [] }, evidence, history,
        now = Date.now(), mode = "auto", minInstall = 5, progress = {} } = input;
    const legacy = routeInstallation({ ...input, installed, pending, plan, minInstall, progress, now });
    const hard = routeInstallation({ ...input, installed, pending, plan, minInstall: Infinity, progress, now });
    const result = { action: "FALLBACK", confidence: "UNKNOWN", reason: "Economic evidence unavailable",
        queued: pending.length, recoveryMs: evidence?.recoveryMs ?? null, package: input.package,
        installNow: { packageBenefit: evidence?.benefit ?? null, breakEvenMs: null, etaMs: null },
        wait: { nextAugmentation: plan.next?.name || null, etaMs: plan.next?.etaMs ?? null,
            incrementalBenefit: evidence?.nextBenefit ?? null, totalMs: null },
        fallback: { minInstall, stalledMs: progress.stalledMs || 0, waitingMs: progress.waitingMs || 0,
            action: legacy ? "INSTALL" : "WAIT", reason: legacy || "Below threshold or short purchase wait" }, history: null };
    if (!pending.length) return { ...result, action: "WAIT", reason: "No queued augmentations" };
    if (hard) return { ...result, action: "INSTALL", confidence: "HIGH", reason: hard };
    if (mode === "threshold") return { ...result, reason: "Threshold policy selected" };
    if (Number.isFinite(input.queuedSince) && now >= input.queuedSince && now - input.queuedSince >= 3600000)
        return { ...result, action: "INSTALL", confidence: "HIGH", reason: "Nonempty queue reached the 60-minute absolute waiting limit" };
    const fallback = reason => ({ ...result, reason });
    if (!input.package?.complete) return fallback("Queued augmentation stats unavailable");
    if (!evidence?.reliable) return { ...fallback(evidence?.reason || "Recovery or resource rates are not stable"), confidence: evidence?.confidence || "UNKNOWN" };
    const eta = plan.next?.etaMs, r = evidence.recoveryMs, b = evidence.benefit;
    if (![eta, r, b, evidence.nextBenefit].every(Number.isFinite) || eta < 0 || r <= 0 || b <= 0 || evidence.nextBenefit <= 0)
        return fallback("Recovery or next augmentation ETA is unknown");
    const lanes = evidence.lanes || [];
    if (!lanes.length || lanes.some(l => ![l.remainingMs, l.lostMs, l.benefit, l.nextBenefit].every(Number.isFinite) ||
        l.remainingMs < 0 || l.lostMs < 0 || l.benefit <= 0 || l.nextBenefit <= 0)) return fallback("Reset losses cannot be estimated");
    const loss = Math.max(...lanes.map(l => l.lostMs / l.benefit));
    const postNow = Math.max(...lanes.map(l => (l.lostMs + l.remainingMs) / l.benefit));
    const postWait = evidence.acquisitionGoal ? 0 : Math.max(...lanes.map(l =>
        (l.lostMs + l.remainingMs) / (l.benefit * l.nextBenefit)));
    const installMs = r + postNow + (evidence.acquisitionGoal ? r : 0), waitMs = eta + r + postWait;
    const breakEvenMs = b > 1 ? (r + loss) / (1 - 1 / b) : null;
    Object.assign(result.installNow, { etaMs: installMs, breakEvenMs, lostProgressMs: loss,
        progressionMs: postNow, additionalRecoveryMs: evidence.acquisitionGoal ? r : 0, resources: lanes });
    result.wait.totalMs = waitMs;
    result.confidence = "MEDIUM"; // Exact multipliers do not make future throughput exact.
    if (![installMs, waitMs].every(Number.isFinite)) return fallback("Projection is outside a finite horizon");
    if (b < RESET_POLICY.minBenefit) return { ...result, action: "WAIT", reason: "Package benefit is too small for an economic reset" };
    const decisive = installMs <= waitMs * (1 - RESET_POLICY.margin) && waitMs - installMs >= RESET_POLICY.minSavingMs &&
        breakEvenMs != null && breakEvenMs * (1 + RESET_POLICY.margin) < eta;
    if (!decisive) return { ...result, action: "WAIT", reason: "Next augmentation or retained progress outweighs resetting now" };
    const key = JSON.stringify([input.resetEpoch, input.objectiveKey, [...pending].sort(), plan.next?.name, mode]);
    const values = [eta, r, ...lanes.flatMap(l => [l.remainingMs + l.lostMs, l.benefit, l.nextBenefit])];
    const stable = history?.key === key && Number.isFinite(history.since) && Number.isFinite(history.at) &&
        history.since <= history.at && history.at <= now && now - history.at <= RESET_POLICY.staleMs &&
        Array.isArray(history.values) && history.values.length === values.length && values.every((v, i) =>
            Number.isFinite(history.values[i]) && Math.abs(v - history.values[i]) <= Math.max(1, Math.abs(history.values[i])) * RESET_POLICY.rateTolerance);
    result.history = { key, since: stable ? history.since : now, at: now, values: stable ? history.values : values };
    const ready = now - result.history.since >= RESET_POLICY.observationMs;
    return { ...result, action: ready ? "INSTALL" : "WAIT", reason: ready
        ? "Current package pays back before the next useful augmentation with a sustained time advantage"
        : "Observing the economic installation advantage for 60 seconds" };
}

// After The Red Pill, compare another reset with finishing this node using
// today's multipliers. Basket completion and queue age cannot justify a reset.
export function decideCompletionReset(input) {
    const { pending = [], now = Date.now(), history } = input, evidence = input.evidence || {};
    const result = { action: "WAIT", confidence: "UNKNOWN", reason: "Endgame recovery/XP evidence unavailable",
        completionGoal: true, queued: pending.length, recoveryMs: evidence.recoveryMs ?? null, package: input.package,
        recoverySource: evidence.recoverySource || null, acquisitionMs: input.acquisitionMs ?? 0,
        installNow: { packageBenefit: evidence.benefit ?? null, breakEvenMs: null, etaMs: null },
        wait: { nextAugmentation: null, etaMs: null, incrementalBenefit: null, totalMs: null },
        fallback: { action: "WAIT", minInstall: input.minInstall, reason: "Preserve final-server progress" }, history: null };
    if (!pending.length) return { ...result, reason: "No queued endgame upgrades" };
    if (input.mode === "threshold") return { ...result, action: pending.length >= input.minInstall ? "INSTALL" : "WAIT",
        confidence: "HIGH", reason: "Explicit endgame threshold policy" };
    const lanes = evidence.lanes || [], recovery = evidence.recoveryMs;
    if (!input.package?.complete || !evidence.reliable || !Number.isFinite(recovery) || recovery <= 0 ||
        !lanes.length || lanes.some(l => ![l.remainingMs, l.lostMs, l.benefit].every(Number.isFinite) ||
            l.remainingMs < 0 || l.lostMs < 0 || l.benefit <= 0))
        return { ...result, reason: evidence.reason || result.reason };
    const continued = Math.max(...lanes.map(l => l.remainingMs));
    const acquisition = input.acquisitionMs ?? 0;
    if (!Number.isFinite(acquisition) || acquisition < 0) return { ...result, reason: "Endgame reputation acquisition time unavailable" };
    const reset = acquisition + recovery + Math.max(...lanes.map(l => (l.remainingMs + l.lostMs) / l.benefit));
    result.wait.etaMs = result.wait.totalMs = continued;
    result.installNow.etaMs = reset;
    result.installNow.resources = lanes;
    const conservative = evidence.recoverySource === "conservative";
    result.confidence = conservative ? "LOW" : "MEDIUM";
    const benefit = evidence.benefit;
    const loss = Math.max(...lanes.map(l => l.lostMs / l.benefit));
    result.installNow.lostProgressMs = loss;
    result.installNow.breakEvenMs = benefit > 1 ? (acquisition + recovery + loss) / (1 - 1 / benefit) : null;
    const margin = conservative ? .50 : RESET_POLICY.margin;
    result.advantage = Number.isFinite(reset) && Number.isFinite(continued) && benefit >= RESET_POLICY.minBenefit &&
        (!conservative || continued >= recovery * 4) &&
        reset <= continued * (1 - margin) && continued - reset >= RESET_POLICY.minSavingMs;
    if (!result.advantage) return { ...result, reason: "Finishing with current multipliers beats rebuilding after a reset" };
    const key = JSON.stringify([input.resetEpoch, input.objectiveKey, [...pending].sort(), "FINAL_SERVER", evidence.recoverySource]);
    const values = [recovery, acquisition, ...lanes.flatMap(l => [l.remainingMs + l.lostMs, l.benefit])];
    const stable = history?.key === key && Number.isFinite(history.since) && history.since <= history.at &&
        history.at <= now && now - history.at <= RESET_POLICY.staleMs && Array.isArray(history.values) &&
        history.values.length === values.length && values.every((v, i) => Number.isFinite(history.values[i]) &&
            Math.abs(v - history.values[i]) <= Math.max(1, Math.abs(history.values[i])) * RESET_POLICY.rateTolerance);
    result.history = { key, since: stable ? history.since : now, at: now, values: stable ? history.values : values };
    const ready = now - result.history.since >= RESET_POLICY.observationMs;
    return { ...result, action: ready ? "INSTALL" : "WAIT", reason: ready
        ? conservative ? "Endgame upgrades project at least 50% faster completion with a conservative 24h recovery allowance"
            : "Endgame upgrades finish the node sooner after accounting for lost hacking and measured recovery"
        : `Observing the endgame reset advantage for 60 seconds${conservative ? "; conservative 24h recovery allowance (LOW confidence)" : ""}` };
}

export function resetDecisionSummary(d) {
    const time = ms => Number.isFinite(ms) ? `~${Math.ceil(ms / 1000)}s` : "unknown";
    if (d.action === "FALLBACK") return `FALLBACK ${d.fallback.action}: ${d.queued}/${d.fallback.minInstall}; ${d.reason}`;
    if (d.confidence === "HIGH") return `${d.action}: ${d.reason}`;
    if (d.completionGoal) return `${d.action}: continue ${time(d.wait.totalMs)}; reset ${time(d.installNow.etaMs)}; ${d.reason}`;
    return `${d.action}: break-even ${time(d.installNow.breakEvenMs)}; next ${time(d.wait.etaMs)}; recovery ${time(d.recoveryMs)}; ${d.reason}`;
}
