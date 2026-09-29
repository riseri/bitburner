import { homeCapacityStatus } from "lib/home-capacity.js";
import { backgroundPrepJobs, backgroundPrepRam } from "lib/background-prep.js";

// Pure projection of the scheduler's ledgers. No fleet scan or expensive APIs.
export function schedulerCapacity(pool, now = Date.now()) {
    const lanes = [...pool.pipelines.values()], cfg = pool.cfg;
    const prep = cfg.backgroundPrep, prepStates = cfg.prepStates || [prep];
    const physical = pool.network.hosts.reduce((n, h) => n + h.maxRam, 0);
    const foreign = [...pool.foreign.values()].reduce((n, ram) => n + ram, 0);
    const total = Math.max(0, physical - foreign);
    const running = [...pool.running.values()].filter(j => j.host !== "home").reduce((n, c) => n + (c.ram || 0), 0);
    const used = running + backgroundPrepRam(prepStates) - backgroundPrepRam(prepStates, "home");
    const queued = lanes.reduce((n, p) => n + p.queue.length, 0);
    const prepWorkers = prepStates.reduce((n, s) => n + backgroundPrepJobs(s).length, 0);
    const committed = pool.running.size + queued + prepWorkers;
    const rate = lanes.reduce((n, p) => n + (p.runtime?.plan.batchRate || 0), 0);
    const slot = Math.floor(now / 250);
    const recent = [...pool.launchBuckets].reduce((n, [s, count]) => n + (s >= slot - 4 && s <= slot ? count : 0), 0);
    const candidates = new Map();
    for (const c of pool.targetAnalysis || []) if (!pool.pipelines.has(c.name) && c.steady > 0 && (pool.blocked?.get(c.name) || 0) <= now)
        candidates.set(c.name, c.steady);
    if (pool.readyScan?.best) candidates.set(pool.readyScan.best.name, pool.readyScan.best.potential);
    if (prep?.candidate?.potential > 0 && prep.target && !pool.pipelines.has(prep.target)) candidates.set(prep.target, prep.candidate.potential);
    if (pool.pendingAdmission && !candidates.has(pool.pendingAdmission)) candidates.set(pool.pendingAdmission, 0);
    const next = [...candidates].sort((a, b) => b[1] - a[1])[0];
    const allocated = [...(pool.xp?.jobs.values() || [])].reduce((n, job) => n + job.ram, 0);
    const desired = cfg.hackingPolicy?.mode === "XP" ? Math.max(0, pool.xp?.desiredRam || 0) : 0;
    const xpConstrained = desired > allocated + 1 && pool.xp?.ramConstrained === true;
    const constraints = [], reasons = [];
    const add = (code, reason) => { if (!constraints.includes(code)) { constraints.push(code); reasons.push(reason); } };
    if (lanes.some(p => p.recovery || p.drain)) add("RECOVERY", "earning lane recovery/drain takes priority");
    if (committed + 4 > cfg.maxWorkers || lanes.some(p => /worker-commitment/.test(p.admissionReason))) add("WORKER_LIMIT", "shared worker commitments leave no batch headroom");
    if (recent + 4 > cfg.maxLaunches || lanes.some(p => /launch budget/.test(p.admissionReason))) add("LAUNCH_RATE", "shared launch budget is saturated or fragmented");
    if (rate >= cfg.maxBatchRate - 0.001) add("BATCH_RATE", "modeled lanes consume the global batch rate");
    if (lanes.some(p => /RAM|allocation/.test(p.admissionReason))) add("RAM", "whole batch cannot fit temporal RAM reservations");
    if (xpConstrained) add("XP_RAM", "XP demand exceeds allocatable RAM");
    if (lanes.length >= cfg.maxTargets && candidates.size) add("TARGET_SLOTS", `${lanes.length}/${cfg.maxTargets} target lanes occupied; ${candidates.size} modeled inactive candidates`);
    if (lanes.some(p => p.mode === "PREPARING") || prep?.active) add("PREPARATION", "target preparation is in progress");
    if (!candidates.size && pool.nextReadyScan > now && !prep?.active && !pool.readyScan && rate < cfg.maxBatchRate)
        add("NO_PROFITABLE_TARGET", "latest ready-target scan found no additional profitable candidate");
    return { version: 1, limitingFactor: constraints[0] || "NONE", constraints, reasons, admission: pool.admission || null,
        homeGw: homeCapacityStatus(pool),
        ram: { used, total, physical, foreign, utilization: total > 0 ? used / total : 0 },
        targets: { active: lanes.length, limit: cfg.maxTargets, mode: cfg.targetMode || "explicit", profitableInactive: candidates.size,
            next: next ? { name: next[0], expected: next[1] } : null },
        batchRate: { used: rate, limit: cfg.maxBatchRate, remaining: Math.max(0, cfg.maxBatchRate - rate) },
        launches: { recent, limit: cfg.maxLaunches },
        workers: { committed, running: pool.running.size, queued, preparation: prepWorkers, limit: cfg.maxWorkers },
        xp: { action: pool.xp?.choice?.action || "", desiredRam: desired, allocatedRam: allocated, constrained: xpConstrained, target: pool.xp?.choice?.name || "" },
        preparation: { state: prep?.status || "DISABLED", ram: backgroundPrepRam(prep),
            constrained: prep?.status === "WAITING_RAM" || /RAM/.test(prep?.reason || "") },
        recovery: { lanes: lanes.filter(p => p.recovery || p.drain).length, ram: backgroundPrepRam(prepStates) - backgroundPrepRam(prep) },
        timing: { loopLag: pool.lagMax || 0, landingDrift: Math.max(0, ...lanes.map(p => p.stats.pipeline.driftMax || 0)),
            launchDrift: pool.launchDriftMax || 0, wakeups: pool.wakeups || 0, foreignObservations: pool.foreignObservations || 0 } };
}
