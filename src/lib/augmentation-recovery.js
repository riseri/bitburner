// Persist only measured, node-scoped recovery. Version-1 state remains readable.
export function migrateResetState(state, reset, epoch) {
    const oldNode = String(state.resetEpoch || "").split(":").slice(0, 2).join(":");
    const sameNode = oldNode === `${reset.currentNode}:${reset.lastNodeReset}`;
    const legacyMs = sameNode && positive(state.recoveryMs) ? state.recoveryMs : null;
    const profile = state.recoveryProfile;
    const samples = sameNode && profile?.nodeReset === reset.lastNodeReset && Array.isArray(profile.samples)
        ? [...new Map(profile.samples.filter(s => validSample(s) && s.at >= reset.lastNodeReset && s.at <= reset.lastAugReset)
            .map(s => [s.at, s])).values()].slice(-3) : [];
    const baseline = state.recoveryBaseline;
    const validBaseline = sameNode && baseline?.nodeReset === reset.lastNodeReset && positive(baseline.income) &&
        Number.isFinite(baseline.at) && baseline.at >= reset.lastNodeReset && baseline.at <= Date.now();
    if (state.resetEpoch !== epoch) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, { resetEpoch: epoch, ownedWork: null });
    }
    state.recoveryProfile = { nodeReset: reset.lastNodeReset, samples };
    state.recoveryBaseline = validBaseline ? baseline : null;
    // Legacy recoveryMs has no provenance; don't use it for new economic decisions.
    // Preserve it only inside a verified node for the existing donation exception.
    if (legacyMs) state.recoveryMs = legacyMs;
    else delete state.recoveryMs;
    if (samples.length) state.recoveryMs = Math.max(...samples.map(s => s.ms));
}

export function observeResetRecovery(state, context, resources, now = Date.now()) {
    const b = state.recoveryBaseline, reset = context.reset;
    if (!b || b.nodeReset !== reset.lastNodeReset || reset.lastAugReset <= b.at) return;
    if (!positive(context.income) || context.income < b.income * .8 || !context.engineStable) {
        delete b.since; delete b.lastSeen; return;
    }
    if (!Number.isFinite(b.since) || b.since > now || !Number.isFinite(b.lastSeen) || now - b.lastSeen > 15000) b.since = now;
    b.lastSeen = now;
    if (now - b.since < 30000) return;
    const sample = { at: reset.lastAugReset, ms: now - reset.lastAugReset, income: b.income, ...resources };
    if (!validSample(sample)) return;
    const samples = state.recoveryProfile.samples.filter(s => s.at !== sample.at);
    state.recoveryProfile.samples = [...samples, sample].slice(-3);
    state.recoveryMs = Math.max(...state.recoveryProfile.samples.map(s => s.ms));
    state.recoveryBaseline = null;
}

export function recoveryEstimate(state, context) {
    const samples = state.recoveryProfile?.samples || [];
    if (!Array.isArray(samples) || samples.length < 2 || state.recoveryProfile.nodeReset !== context.reset.lastNodeReset ||
        samples.some(s => !validSample(s)) || !positive(context.income)) return null;
    const times = samples.map(s => s.ms);
    if (Math.max(...times) / Math.min(...times) > 1.5 || samples.some(s => context.income / s.income < .5 || context.income / s.income > 2)) return null;
    // Credit only half of the smallest observed recovered balance. Everything
    // else is residual progression loss, not another charge for fleet rebuilding.
    const credit = key => Math.min(...samples.map(s => s[key])) * .5;
    return { ms: Math.max(...times), cash: credit("cash"), xp: credit("xp"),
        hacking: Math.min(...samples.map(s => s.hacking)),
        reputation: faction => samples.every(s => Number.isFinite(s.reputation?.[faction]))
            ? Math.min(...samples.map(s => s.reputation[faction])) * .5 : null };
}

function positive(n) { return Number.isFinite(n) && n > 0; }
function validSample(s) {
    return s && positive(s.ms) && s.ms <= 86400000 && positive(s.income) && Number.isFinite(s.at) &&
        [s.cash, s.xp, s.hacking].every(n => Number.isFinite(n) && n >= 0) &&
        s.reputation && typeof s.reputation === "object" && !Array.isArray(s.reputation) &&
        Object.values(s.reputation).every(n => Number.isFinite(n) && n >= 0);
}
