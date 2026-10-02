import { homeCapacityStatus } from "lib/home-capacity.js";
import { backgroundPrepJobs, backgroundPrepRam } from "lib/background-prep.js";
import { governedPeerRate, schedulerScalingStatus, pipelineUsesBudget } from "lib/scheduler-scaling.js";
import { launchBudgetDemand, optionalLaunchLimit } from "lib/launch-budget.js";

export const MIN_TARGET_BATCH_RATE = .25;

// Pure projection of the scheduler's ledgers. No fleet scan or expensive APIs.
export function schedulerCapacity(pool, now = Date.now()) {
    const lanes = [...pool.pipelines.values()], active = lanes.filter(pipelineUsesBudget), cfg = pool.cfg;
    const prep = cfg.backgroundPrep, prepStates = cfg.prepStates || [prep];
    const physical = pool.network.hosts.reduce((n, h) => n + h.maxRam, 0);
    const foreign = [...pool.foreign.values()].reduce((n, ram) => n + ram, 0);
    const total = Math.max(0, physical - foreign);
    const running = [...pool.running.values()].filter(j => j.host !== "home").reduce((n, c) => n + (c.ram || 0), 0);
    const used = running + backgroundPrepRam(prepStates) - backgroundPrepRam(prepStates, "home");
    const queued = lanes.reduce((n, p) => n + p.queue.length, 0);
    const prepWorkers = prepStates.reduce((n, s) => n + backgroundPrepJobs(s).length, 0);
    const committed = pool.running.size + queued + prepWorkers;
    const modelRate = active.reduce((n, p) => n + (p.runtime?.plan.batchRate || 0), 0);
    const rate = governedPeerRate(pool);
    const remainingRate = Math.max(0, cfg.maxBatchRate - rate);
    const nextRequired = lanes.length < cfg.maxTargets ? MIN_TARGET_BATCH_RATE : 0;
    const slot = Math.floor(now / 250);
    const recent = [...pool.launchBuckets].reduce((n, [s, count]) => n + (s >= slot - 4 && s <= slot ? count : 0), 0);
    const futureSlots = [...pool.launchBuckets.keys()].filter(s => s >= slot);
    const peakBucket = Math.max(0, ...futureSlots.map(s => pool.launchBuckets.get(s) || 0));
    let peakReserved = recent;
    for (const s of futureSlots) {
        let reserved = 0;
        for (let i = s - 4; i <= s; i++) reserved += pool.launchBuckets.get(i) || 0;
        peakReserved = Math.max(peakReserved, reserved);
    }
    const candidates = new Map();
    const requiredRates = new Map(), modelIncome = active.reduce((n, p) => n + (p.runtime?.plan.expected || 0), 0);
    for (const [name, model] of pool.scalingCandidates || []) {
        if (pool.pipelines.has(name) || (pool.blocked?.get(name) || 0) > now) continue;
        const needed = Math.max(MIN_TARGET_BATCH_RATE, modelIncome * (cfg.switchThreshold - 1) / model.perBatch);
        if (needed + modelRate <= cfg.schedulerScaling.batchCeiling) {
            candidates.set(name, model.perBatch * (cfg.schedulerScaling.batchCeiling - modelRate)); requiredRates.set(name, needed);
        }
    }
    for (const c of pool.targetAnalysis || []) if (!pool.pipelines.has(c.name) && c.steady > 0 && (pool.blocked?.get(c.name) || 0) <= now)
        candidates.set(c.name, c.steady);
    if (pool.readyScan?.best) candidates.set(pool.readyScan.best.name, pool.readyScan.best.potential);
    if (prep?.candidate?.potential > 0 && prep.target && !pool.pipelines.has(prep.target)) candidates.set(prep.target, prep.candidate.potential);
    if (pool.pendingAdmission && !candidates.has(pool.pendingAdmission)) candidates.set(pool.pendingAdmission, 0);
    const next = [...candidates].sort((a, b) => b[1] - a[1])[0];
    const ramScalable = active.some(p => {
        const plan = p.runtime?.plan;
        if (!plan) return false;
        const freeRate = Math.max(.001, cfg.maxBatchRate - governedPeerRate(pool, p));
        const cadence = Math.max(4 * (p.cfg?.gap || cfg.gap) + 20, 1000 / freeRate);
        return Number.isFinite(plan.period) && plan.period > cadence * 1.1 ||
            Number.isFinite(plan.steal) && plan.steal < cfg.maxSteal * .9;
    }) || lanes.length < cfg.maxTargets && candidates.size > 0 && remainingRate >= MIN_TARGET_BATCH_RATE;
    const xpJobs = [...(pool.xp?.jobs.values() || [])];
    const allocated = xpJobs.reduce((n, job) => n + job.ram, 0);
    const remoteXp = xpJobs.filter(job => job.host !== "home").reduce((n, job) => n + job.ram, 0);
    const samples = (pool.xp?.samples || []).slice(-3);
    const stableXp = samples.length === 3 && samples.every(value => Number.isFinite(value) && value > 0) &&
        Math.max(...samples) / Math.min(...samples) <= 1.25;
    const goal = cfg.progressionObjective;
    const launchDemands = active.filter(p => p.admissionDemand && now >= p.admissionDemand.at && now - p.admissionDemand.at <= 15000)
        .map(p => ({ target: p.name, ...p.admissionDemand }));
    const requestedLaunches = Math.max(0, ...launchDemands.map(d => d.requiredLimit));
    const optionalLimit = optionalLaunchLimit(cfg.maxLaunches);
    const xpLaunchable = launchBudgetDemand(pool.launchBuckets, [{ launchAt: now }]).requiredLimit <= optionalLimit && committed < cfg.maxWorkers - 4;
    const xpCapacity = pool.xp?.capacity;
    const fullCapacity = Boolean(xpCapacity?.safe && now >= xpCapacity.generatedAt && now - xpCapacity.generatedAt <= 15000 &&
        xpCapacity.observedMs >= 60000 && xpCapacity.availableRam <= Math.max(1, allocated * .02));
    // A mature failed/noisy measurement cannot be replaced by a warmup model.
    const warmupProof = samples.length < 3 && fullCapacity;
    // A fraction of existing RAM cannot request the next server once satisfied.
    // Proven G/W work filling allocatable home/remote RAM may ask for 25% more.
    // Player-only XP, idle RAM, prep, H thread caps and an approved reset cannot.
    const xpExpansion = Boolean(cfg.hackingPolicy?.mode === "XP" && goal?.milestone === "FINAL_SERVER" &&
        goal.limitingResource === "hacking" && goal.moneyCovered && !goal.resetImminent && !goal.resetPending &&
        pool.xp?.status === "RUNNING" && pool.xp.wave && !pool.xp.wave.preparing &&
        ["G", "W"].includes(pool.xp.wave.action) && pool.xp.choice?.score > 0 && allocated > 0 &&
        physical > 0 && (stableXp && (fullCapacity || remoteXp > 0 && remoteXp >= total * .8) || warmupProof));
    const desired = cfg.hackingPolicy?.mode === "XP" ? Math.max(0, pool.xp?.desiredRam || 0,
        xpExpansion ? allocated * 1.25 : 0) : 0;
    const xpConstrained = desired > allocated + 1 && (pool.xp?.ramConstrained === true || xpExpansion);
    const constraints = [], reasons = [];
    const add = (code, reason) => { if (!constraints.includes(code)) { constraints.push(code); reasons.push(reason); } };
    if (lanes.some(p => p.recovery || p.drain)) add("RECOVERY", "earning lane recovery/drain takes priority");
    if (committed + 4 > cfg.maxWorkers || lanes.some(p => /worker-commitment/.test(p.admissionReason))) add("WORKER_LIMIT", "shared worker commitments leave no batch headroom");
    if (recent + 4 > cfg.maxLaunches || requestedLaunches > cfg.maxLaunches || lanes.some(p => p.admissionDemand === undefined && /launch budget/.test(p.admissionReason)))
        add("LAUNCH_RATE", requestedLaunches > cfg.maxLaunches ? `proposed whole money batch requires ${requestedLaunches} launches/s; budget ${cfg.maxLaunches}` : "shared launch budget is saturated or fragmented");
    if (rate >= cfg.maxBatchRate - 0.001) add("BATCH_RATE", "modeled lanes consume the global batch rate");
    if (lanes.some(p => /RAM|allocation/.test(p.admissionReason))) add("RAM", "whole batch cannot fit temporal RAM reservations");
    if (xpConstrained) add("XP_RAM", xpExpansion ? "productive endgame XP fills home/remote RAM; bounded expansion requested" : "XP demand exceeds allocatable RAM");
    if (lanes.length >= cfg.maxTargets && candidates.size) add("TARGET_SLOTS", `${lanes.length}/${cfg.maxTargets} target lanes occupied; ${candidates.size} modeled inactive candidates`);
    if (lanes.some(p => p.mode === "PREPARING") || prep?.active) add("PREPARATION", "target preparation is in progress");
    if (!candidates.size && pool.nextReadyScan > now && !prep?.active && !pool.readyScan && rate < cfg.maxBatchRate)
        add("NO_PROFITABLE_TARGET", "latest ready-target scan found no additional profitable candidate");
    return { version: 1, limitingFactor: constraints[0] || "NONE", constraints, reasons, admission: pool.admission || null,
        homeGw: homeCapacityStatus(pool),
        ram: { used, total, physical, foreign, utilization: total > 0 ? used / total : 0, scalable: Boolean(ramScalable) },
        targets: { active: lanes.length, limit: cfg.maxTargets, mode: cfg.targetMode || "explicit", profitableInactive: candidates.size,
            admitting: active.length, waiting: lanes.length - active.length,
            next: next ? { name: next[0], expected: next[1], requiredRate: requiredRates.get(next[0]) || MIN_TARGET_BATCH_RATE } : null },
        scaling: schedulerScalingStatus(cfg.schedulerScaling),
        batchRate: { used: rate, modeled: modelRate, limit: cfg.maxBatchRate, remaining: remainingRate, nextRequired,
            nextBlocked: remainingRate < nextRequired },
        launches: { recent, limit: cfg.maxLaunches, peakReserved, peakBucket,
            bucketLimit: Math.floor(cfg.maxLaunches / 4), optionalLimit, moneyLimit: cfg.maxLaunches,
            requiredLimit: requestedLaunches, demands: launchDemands },
        workers: { committed, running: pool.running.size, queued, preparation: prepWorkers, limit: cfg.maxWorkers },
        xp: { action: pool.xp?.choice?.action || "", desiredRam: desired, allocatedRam: allocated, constrained: xpConstrained,
            expansion: Boolean(xpExpansion), target: pool.xp?.choice?.name || "",
            confidence: xpExpansion ? stableXp ? "MEASURED" : "MODEL (warmup)" : "UNKNOWN",
            launchable: Boolean(fullCapacity && xpLaunchable),
            availableRam: xpCapacity?.availableRam ?? null, observedMs: xpCapacity?.observedMs || 0 },
        preparation: { state: prep?.status || "DISABLED", ram: backgroundPrepRam(prep),
            constrained: prep?.status === "WAITING_RAM" || /RAM/.test(prep?.reason || "") },
        recovery: { lanes: lanes.filter(p => p.recovery || p.drain).length, ram: backgroundPrepRam(prepStates) - backgroundPrepRam(prep) },
        timing: { loopLag: pool.lagMax || 0, landingDrift: Math.max(0, ...lanes.map(p => p.stats.pipeline.driftMax || 0)),
            launchDrift: pool.launchDriftMax || 0, wakeups: pool.wakeups || 0, foreignObservations: pool.foreignObservations || 0 } };
}
