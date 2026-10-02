import { boundedXpAllocation } from "lib/milestone-balance.js";

// Capacity control changes future admission only. Committed worker deadlines and
// ownership are handled by the scheduler, independently of these budgets.
const SAMPLE_MS = 10_000;
const OBSERVE_MS = 60_000;
const COOLDOWN_MS = 120_000;
const LAUNCH_ENVELOPE = 128;

export function schedulerLimit(value, kind) {
    if (String(value).trim().toLowerCase() === "auto") return "auto";
    const n = Number(value);
    if (kind === "batch" ? !(Number.isFinite(n) && n > 0 && n <= 8) :
        !(Number.isSafeInteger(n) && n >= 4 && n <= LAUNCH_ENVELOPE))
        throw new Error(kind === "batch" ? "max-batch-rate must be auto or a number in (0,8]" :
            "max-launches must be auto or an integer from 4 to 128");
    return n;
}

export function createSchedulerScaling(cfg, batch = "auto", launches = "auto", now = Date.now()) {
    const requestedBatch = schedulerLimit(batch, "batch"), requestedLaunches = schedulerLimit(launches, "launch");
    const batchMode = requestedBatch === "auto" ? "auto" : "fixed";
    const launchMode = requestedLaunches === "auto" ? "auto" : "fixed";
    // At least four phase launches per batch; each target also has its own safe
    // landing cadence. Extra split processes consume the actual launch ledger.
    const batchCeiling = batchMode === "auto" ? Math.min(LAUNCH_ENVELOPE / 4,
        cfg.maxTargets * 1000 / (4 * cfg.gap + 20)) : requestedBatch;
    if (!(Number.isFinite(batchCeiling) && batchCeiling > 0)) throw new Error("Require a finite positive gap and target limit");
    const state = { enabled: batchMode === "auto" || launchMode === "auto", batchMode, launchMode,
        batchCeiling, launchCeiling: launchMode === "auto" ? LAUNCH_ENVELOPE : requestedLaunches,
        batch: batchMode === "auto" ? Math.min(4, batchCeiling) : requestedBatch,
        launches: launchMode === "auto" ? 32 : requestedLaunches,
        nextSample: now + SAMPLE_MS, healthySince: null, cooldownUntil: 0, changes: 0,
        faults: new Map(), window: timingWindow(), sample: null, probe: null, ramRequest: null,
        preferTargets: false, restore: null, decision: batchMode === "fixed" && launchMode === "fixed" ? "FIXED" : "OBSERVE",
        reason: batchMode === "fixed" && launchMode === "fixed" ? "Explicit scheduler budgets" : "Waiting for productive work and recent timing evidence" };
    applySchedulerLimits(cfg, state);
    cfg.schedulerScaling = state;
    return state;
}

export function applySchedulerLimits(cfg, state) {
    cfg.maxBatchRate = state.batch; cfg.maxLaunches = state.launches;
    cfg.minimumPeriod = 1000 / cfg.maxBatchRate;
}

function timingWindow() {
    return { loop: { count: 0, sum: 0, max: 0, late: 0 },
        launch: { count: 0, sum: 0, max: 0, late: 0 }, landing: { count: 0, sum: 0, max: 0, late: 0 } };
}

export function recordSchedulerTiming(state, kind, delay, gap) {
    if (!state?.enabled || !Number.isFinite(delay) || !state.window[kind]) return;
    const w = state.window[kind], value = Math.abs(delay);
    w.count++; w.sum += value; w.max = Math.max(w.max, value);
    if (value > gap * .35) w.late++;
}

export function governedBatchScale(pool) {
    if (pool.cfg.schedulerScaling?.batchMode !== "auto") return 1;
    const model = [...pool.pipelines.values()].filter(pipelineUsesBudget).reduce((n, p) => n + (p.runtime?.plan.batchRate || 0), 0);
    return model > 0 ? Math.min(1, pool.cfg.maxBatchRate / model) : 1;
}

export function governedPeerRate(pool, excluded = null) {
    return governedBatchScale(pool) * [...pool.pipelines.values()].filter(p => p !== excluded && pipelineUsesBudget(p))
        .reduce((n, p) => n + (p.runtime?.plan.batchRate || 0), 0);
}

// An old plan retained for a quiescent retune is not a future admission. Work
// still owned by a draining/recovering lane remains charged until reconciled.
export function pipelineUsesBudget(p) {
    return Boolean(p.runtime?.plan && (p.mode === "RUNNING" || !p.mode ||
        p.queue?.length || p.running?.size || p.batches?.size));
}

export function pipelineAdmissionPeriod(pool, p) {
    return (p.runtime?.plan.period || 0) / (1 - boundedXpAllocation(pool.cfg.hackingPolicy?.xpAllocation)) / governedBatchScale(pool);
}

export function refreshAdmissionCadence(pool) {
    const now = Date.now(), key = `${pool.cfg.maxBatchRate}:${boundedXpAllocation(pool.cfg.hackingPolicy?.xpAllocation)}:${pool.pipelines.size}`;
    // The event loop can wake for every worker launch. Scan owned batches at
    // most once a second, or immediately when the global pacing changes.
    if (pool.admissionCadenceKey === key && now - pool.admissionCadenceAt < 1000) return;
    pool.admissionCadenceKey = key; pool.admissionCadenceAt = now;
    for (const p of pool.pipelines.values()) if (p.stats && p.runtime) {
        let period = pipelineAdmissionPeriod(pool, p);
        for (const b of p.batches?.values() || []) period = Math.max(period, b.admissionPeriod || 0);
        p.stats.admissionPeriod = period;
    }
}

// Inputs come from owned scheduler counters/ledgers, not lifetime maxima or an
// assumption that all installed RAM can be used by every batch phase.
export function tickSchedulerScaling(state, input, now = Date.now()) {
    if (!state?.enabled || now < state.nextSample) return false;
    state.nextSample = now + SAMPLE_MS;
    const w = state.window; state.window = timingWindow(); state.sample = w;
    state.ramRequest = null;
    let faultedLanes = 0;
    const faults = new Map();
    for (const [epoch, count] of input.faults || []) {
        if (state.faults.has(epoch) && count > state.faults.get(epoch)) faultedLanes++;
        faults.set(epoch, count);
    }
    state.faults = faults;
    // Security or a lost worker on one target already has local recovery. Only
    // widespread faults or measured scheduler timing justify slowing its peers.
    const overloaded = faultedLanes >= 2 || [w.loop, w.launch, w.landing]
        .some(s => s.count > 0 && (s.late / s.count > .05 || s.max > input.gap * 2));
    if (overloaded) {
        state.healthySince = null;
        if (now < state.cooldownUntil) { state.decision = "COOLDOWN"; state.reason = "Waiting for timing/recovery to settle"; return false; }
        const before = [state.batch, state.launches];
        state.restore = { batch: Math.max(state.restore?.batch || 0, state.batch),
            launches: Math.max(state.restore?.launches || 0, state.launches) };
        if (state.batchMode === "auto") state.batch = Math.max(Math.min(.25, state.batchCeiling), state.batch * .75);
        if (state.launchMode === "auto") state.launches = Math.max(8, Math.floor(state.launches * .75 / 4) * 4);
        state.probe = null; state.cooldownUntil = now + COOLDOWN_MS;
        state.cooldownReason = "Recent timing pressure or new worker faults; reduced future admissions";
        state.decision = "BACKOFF"; state.reason = "Recent timing pressure or new worker faults; reduce future admissions";
        state.changes++;
        return before[0] !== state.batch || before[1] !== state.launches;
    }
    const restoring = state.restore && input.earningStable;
    const evidenced = w.loop.count >= 10 && w.landing.count >= 4 && (input.stable || restoring) && !input.recovering && Number.isFinite(input.income) && input.income > 0;
    if (!evidenced || input.resetPending) {
        state.healthySince = null; state.decision = "OBSERVE";
        state.reason = input.resetPending ? "Reset pending; retain capacity and capital" :
            input.blocker || "Waiting for stable paid lanes and recent timing samples";
        return false;
    }
    state.healthySince ??= now;
    if (now < state.cooldownUntil || now - state.healthySince < OBSERVE_MS) {
        state.decision = now < state.cooldownUntil ? "COOLDOWN" : "OBSERVE";
        state.reason = now < state.cooldownUntil ? state.cooldownReason : "Observing 60 seconds of stable timing and paid work";
        return false;
    }
    const c = input.capacity, limits = c.constraints;
    if (state.restore) {
        const target = state.restore;
        const before = [state.batch, state.launches];
        if (state.batchMode === "auto") state.batch = Math.min(target.batch, state.batch + Math.max(.5, state.batch * .125));
        if (state.launchMode === "auto") state.launches = Math.min(target.launches, state.launches + Math.max(8, Math.ceil(state.launches * .25 / 4) * 4));
        if (state.batch >= target.batch && state.launches >= target.launches) state.restore = null;
        state.probe = null; state.healthySince = null; state.changes++;
        state.decision = "RESTORE"; state.reason = "Healthy timing and paid work; restore pre-backoff budgets while the current trial validates";
        return before[0] !== state.batch || before[1] !== state.launches;
    }
    state.preferTargets = c.targets.active < c.targets.limit && c.targets.profitableInactive > 0;
    const ramRequest = adaptiveRamRequest(state, input, now - state.healthySince);
    let incompleteProbe = null;
    if (state.probe) {
        const probe = state.probe;
        if (probe.goal !== input.goal) state.probe = null;
        else {
            if (probe.ramBase != null && c.ram.total > probe.ramBase + 1) {
                probe.ramBase = null; probe.ramGranted = true;
                probe.settleAt = now + input.maxActionTime * 2 + OBSERVE_MS;
            }
            // More budget cannot produce its gain until a RAM-bound fleet gets
            // memory. Fund one bounded step, then measure after its work lands.
            if (ramRequest && !probe.ramGranted) {
                probe.ramBase ??= c.ram.total; state.ramRequest = ramRequest;
                state.decision = "RAM"; state.reason = "Measured RAM pressure prevents using the higher budgets; request one bounded cloud step";
                return false;
            }
        }
        if (state.probe && now < probe.settleAt) {
            state.decision = "VERIFY"; state.reason = "Waiting for higher-budget work to land before comparing measured throughput"; return false;
        } else if (state.probe) {
            const metric = input.skillGoal ? input.xpRate : input.income;
            if (!(metric > 0)) { state.decision = "VERIFY"; state.reason = "Waiting for a measured throughput comparison"; return false; }
            state.probe = null;
            // A whole target can require more than one bounded budget step.
            // Flat throughput during an incomplete step is not evidence that
            // the modeled next target is unprofitable. Keep the original
            // baseline until its calculated admission headroom is available.
            const incomplete = (state.batchMode === "auto" && state.preferTargets && state.batch < state.batchCeiling &&
                c.targets.next?.requiredRate > c.batchRate.remaining || state.launchMode === "auto" &&
                limits.includes("LAUNCH_RATE") && state.launches < state.launchCeiling) && metric >= probe.baseline * .95 &&
                !limits.some(code => ["RAM", "RECOVERY", "WORKER_LIMIT"].includes(code));
            if (metric < probe.baseline * 1.03 && incomplete) incompleteProbe = probe;
            else if (metric < probe.baseline * 1.03) {
                if (state.batchMode === "auto") state.batch = probe.batch;
                if (state.launchMode === "auto") state.launches = probe.launches;
                state.cooldownUntil = now + 5 * COOLDOWN_MS; state.healthySince = null;
                state.decision = "HOLD"; state.reason = "Higher budgets did not improve measured throughput; keep the previous budgets for 10 minutes";
                state.cooldownReason = state.reason;
                state.changes++; return true;
            }
        }
    }
    if (c.workers.committed >= c.workers.limit * .8) {
        state.decision = "HOLD"; state.reason = "Worker commitments leave insufficient process headroom"; return false;
    }
    const batchPressure = !input.skillGoal && (c.batchRate.used >= state.batch * .9 || state.preferTargets &&
        (c.batchRate.nextBlocked || c.batchRate.remaining < c.targets.next?.requiredRate * 1.1));
    const launchPressure = limits.includes("LAUNCH_RATE") || input.xpWaitingLaunch || c.launches.peakBucket >= c.launches.bucketLimit * .8;
    const before = { batch: state.batch, launches: state.launches };
    if (state.batchMode === "auto" && batchPressure) {
        const usefulBudget = (c.batchRate.modeled || c.batchRate.used) + (c.targets.next?.requiredRate || .25) * 1.1;
        const step = Math.max(.5, state.batch * .125, Math.min(state.batch * .25, usefulBudget - state.batch));
        state.batch = Math.min(state.batchCeiling, Number((state.batch + step).toFixed(3)));
    }
    if (state.launchMode === "auto" && (launchPressure || state.batch > before.batch))
        state.launches = Math.min(state.launchCeiling, state.launches + Math.max(8, Math.ceil(state.launches * .25 / 4) * 4));
    if (before.batch !== state.batch || before.launches !== state.launches) {
        const baseline = input.skillGoal ? input.xpRate : input.income;
        if (baseline > 0) state.probe = { ...(incompleteProbe || { ...before, baseline, goal: input.goal }),
            settleAt: now + Math.max(OBSERVE_MS, input.maxActionTime * 2 + OBSERVE_MS) };
        state.healthySince = null; state.changes++; state.decision = "INCREASE";
        state.reason = "Stable timing with usable demand; test higher shared budgets";
        return true;
    }
    // Ask for one bounded RAM step only after throughput limits have headroom.
    // Endgame XP has its own productive-wave expansion proof in capacity.xp.
    if (ramRequest) {
        state.ramRequest = ramRequest;
        state.decision = "RAM"; state.reason = "Request bounded cloud RAM growth; purchase remains subject to live ROI and savings";
    } else {
        state.decision = "HOLD"; state.reason = batchPressure || launchPressure ? "Reached the cadence/launch safety envelope or an explicit limit" :
            input.skillGoal ? "Prioritize productive XP; money budget expansion is unnecessary" : "Current budgets have headroom; no useful expansion demand";
    }
    return false;
}

function adaptiveRamRequest(state, input, observedMs) {
    const c = input.capacity, limits = c.constraints;
    const ramPressure = limits.includes("RAM") || c.ram.utilization >= .85;
    const cpuHeadroom = !limits.some(code => ["LAUNCH_RATE", "WORKER_LIMIT", "RECOVERY", "BATCH_RATE"].includes(code)) &&
        c.batchRate.used < state.batch * .9 && c.launches.peakReserved < state.launches * .8 && c.workers.committed < c.workers.limit * .8;
    return !input.skillGoal && c.ram.scalable === true && ramPressure && cpuHeadroom && c.ram.total > 0 ?
        { addedRam: c.ram.total * .25, confidence: "MEASURED", observedMs,
            reason: "Productive remote RAM pressure with measured scheduler headroom" } : null;
}

export function schedulerScalingStatus(state) {
    if (!state) return null;
    return { batchMode: state.batchMode, launchMode: state.launchMode, batchCeiling: state.batchCeiling,
        launchCeiling: state.launchCeiling, decision: state.decision, reason: state.reason, changes: state.changes,
        restore: state.restore ? { ...state.restore } : null,
        ramRequest: state.ramRequest, recentTiming: state.sample, cooldownUntil: state.cooldownUntil };
}
