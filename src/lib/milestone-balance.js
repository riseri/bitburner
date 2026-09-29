// Pure control and sampling logic. Rates describe the current allocation, not
// an imagined all-money/all-XP fleet. No additional Netscript API dependencies.
export const MILESTONE_BALANCE = Object.freeze({
    fallback: .40, hackingOnlyFallback: .70, floor: .10, ceiling: .85,
    step: .10, deadband: 1.25, smoothing: .35,
    sampleMs: 20_000, samples: 3, rateTolerance: .25,
    observationMs: 60_000, cooldownMs: 120_000, staleMs: 45_000,
});

export function boundedXpAllocation(value) {
    return Math.min(MILESTONE_BALANCE.ceiling, Math.max(0, Number(value) || 0));
}

export function milestoneKey(objective) {
    return objective ? JSON.stringify([objective.resetEpoch, objective.milestone,
        objective.requiredHacking, objective.requiredCash]) : "";
}

// Non-overlapping samples; a mature noisy/zero series is UNKNOWN, never hidden
// by a positive model. Reset and stale observations discard the entire series.
export function observeMilestoneRates(state, { key, now, xp, income = [], money = null, sampleMs = MILESTONE_BALANCE.sampleMs }) {
    const o = MILESTONE_BALANCE;
    if (state.key !== key || !state.last || now < state.last.at || now - state.seenAt > o.staleMs ||
        !Number.isFinite(xp) || !Number.isFinite(state.last.xp) || xp < state.last.xp ||
        (Number.isFinite(money) && Number.isFinite(state.last.money) && money < state.last.money)) {
        Object.assign(state, { key, seenAt: now, last: { at: now, xp, money }, money: [], xp: [] });
        return;
    }
    state.seenAt = now;
    const elapsed = now - state.last.at;
    if (elapsed < sampleMs) return;
    const earned = Number.isFinite(money) && Number.isFinite(state.last.money) ? money - state.last.money :
        income.filter(s => s.time > state.last.at && s.time <= now).reduce((sum, s) => sum + Math.max(0, s.money), 0);
    state.money.push(earned * 1000 / elapsed);
    state.xp.push((xp - state.last.xp) * 1000 / elapsed);
    state.money = state.money.slice(-o.samples); state.xp = state.xp.slice(-o.samples);
    state.last = { at: now, xp, money };
}

export function milestoneRate(samples = [], model = null) {
    const o = MILESTONE_BALANCE;
    if (samples.length < o.samples) return { rate: Number.isFinite(model) && model > 0 ? model : null,
        source: Number.isFinite(model) && model > 0 ? "model (warming up)" : "UNKNOWN" };
    if (samples.some(r => !Number.isFinite(r) || r <= 0) || Math.max(...samples) / Math.min(...samples) > 1 + o.rateTolerance)
        return { rate: null, source: "UNKNOWN (unstable or zero)" };
    return { rate: samples.reduce((a, b) => a + b, 0) / samples.length, source: "measured" };
}

export function balanceMilestone(state, { objective, level, remainingXp, cash, xp, scriptXpRate = null,
    baseline = 0, safe = false, enabled = false, now = Date.now() }) {
    const o = MILESTONE_BALANCE, key = milestoneKey(objective);
    if (state.key !== key) {
        for (const field of Object.keys(state)) delete state[field];
        Object.assign(state, { key, allocation: boundedXpAllocation(baseline), lastChange: now });
    }
    const previous = state.allocation;
    const remainingCash = Number.isFinite(objective?.remainingCash) ? Math.max(0, objective.remainingCash) : null;
    const eta = (remaining, rate) => {
        if (remaining === 0) return 0;
        const value = Number.isFinite(remaining) && remaining > 0 && Number.isFinite(rate) && rate > 0 ? remaining / rate * 1000 : null;
        return Number.isFinite(value) ? value : null;
    };
    const cashEtaMs = eta(remainingCash, cash?.rate), hackingEtaMs = eta(remainingXp, xp?.rate);
    const active = enabled && remainingXp !== 0 && objective?.requiredHacking > level && ["hacking", "cash"].includes(objective?.limitingResource) &&
        !objective.resetImminent && objective.redPill !== "queued";
    let reason = "UNKNOWN ETA; conservative fallback", confidence = "fallback";
    if (!active || !safe) {
        // Transient recovery/prep suspends application, not the learned balance.
        // It cannot be interpreted as evidence that either ETA is behind.
        if (!active) state.allocation = 0;
        state.lastChange = now;
        state.since = null; state.ratio = null; state.direction = 0;
        reason = !active ? "milestone inactive, complete, or capability unavailable" : "money/bootstrap safety takes priority";
    } else if (cashEtaMs === null || hackingEtaMs === null) {
        // Return gradually to the safe fixed policy. This also restores its
        // initial allocation if cash becomes covered while XP is still unknown.
        const fallback = boundedXpAllocation(baseline);
        if (now - state.lastChange >= o.cooldownMs && previous !== fallback) {
            state.allocation = previous + Math.sign(fallback - previous) * Math.min(o.step, Math.abs(fallback - previous));
            state.lastChange = now;
        }
        state.since = null; state.ratio = null; state.direction = 0;
    } else {
        confidence = cash?.source === "measured" && xp?.source === "measured" ? "measured" : "modeled";
        const ratio = cashEtaMs === 0 ? o.deadband * 2 : hackingEtaMs / cashEtaMs;
        state.ratio = state.ratio == null ? ratio : state.ratio * (1 - o.smoothing) + ratio * o.smoothing;
        const direction = state.ratio > o.deadband ? 1 : state.ratio < 1 / o.deadband ? -1 : 0;
        if (direction !== state.direction || state.since == null) { state.direction = direction; state.since = now; }
        reason = direction > 0 ? cashEtaMs === 0 ? "cash covered; hacking remains" : `hacking behind ${state.ratio.toFixed(2)}x`
            : direction < 0 ? `cash behind ${(1 / state.ratio).toFixed(2)}x` : "ETAs balanced; hold";
        if (direction && now - state.since >= o.observationMs && now - state.lastChange >= o.cooldownMs) {
            // Do not open an XP lane while cash dominates. Once open, keep the
            // small floor so a real hacking bottleneck can still be measured.
            state.allocation = previous === 0 && direction < 0 ? 0 :
                Math.min(o.ceiling, Math.max(o.floor, previous + direction * o.step));
            if (state.allocation !== previous) { state.lastChange = now; state.since = now; }
        } else if (direction) reason += "; observing/cooldown";
    }
    return { milestone: objective?.milestone || "none", requiredHacking: objective?.requiredHacking ?? null,
        currentHacking: level, requiredCash: objective?.requiredCash ?? null,
        currentCash: objective?.availableProgressionCash ?? null, remainingCash, remainingXp,
        cashRate: cash?.rate ?? null, xpRate: xp?.rate ?? null, scriptXpRate,
        cashSource: cash?.source || "UNKNOWN", xpSource: xp?.source || "UNKNOWN",
        cashEtaMs, hackingEtaMs, xpAllocation: active && safe ? state.allocation : 0, previousXpAllocation: previous,
        requestedXpAllocation: state.allocation, suspended: active && !safe,
        reason, confidence, generatedAt: now, lastAdjustmentAt: state.lastChange };
}
