// Deliberately conservative heuristic, not a marginal-income guarantee.
export function evaluateFleetInvestment(snapshot, addedRam, cost, maxPayback = 1800, objective = null) {
    if (!snapshot || snapshot.type !== "jit-status" || !Array.isArray(snapshot.pipelines)) return { ok: false, reason: "Waiting for live scheduler evidence" };
    const policy = fleetCapacityPolicy(snapshot, objective);
    if (!policy.ok) return policy;
    if (policy.xp) {
        const unmet = snapshot.capacity.xp.desiredRam - snapshot.capacity.xp.allocatedRam;
        const payback = snapshot.income60 > 0 ? cost / snapshot.income60 : Infinity;
        return { ok: addedRam > 0 && cost > 0 && addedRam <= unmet * 2 && payback <= Math.min(300, maxPayback), payback,
            reason: `XP pipeline is RAM constrained; progression-driven, ${Math.ceil(payback)}s capital recovery bound` };
    }
    const lanes = snapshot.pipelines;
    if (!lanes.length || lanes.some(p => p.mode !== "LIVE")) return { ok: false, reason: "Waiting for stable earning targets" };
    const utilization = snapshot.totalRam > 0 ? snapshot.usedRam / snapshot.totalRam : 0;
    const ramPressure = snapshot.capacity?.limitingFactor === "RAM" || snapshot.capacity?.preparation?.constrained || lanes.some(p => /RAM|allocation/i.test(p.admissionReason || ""));
    const batchRate = lanes.reduce((sum, p) => sum + (p.modelBatchRate || 0), 0);
    const workers = lanes.reduce((sum, p) => sum + (p.running || 0) + (p.queued || 0), 0);
    if ((snapshot.maxBatchRate > 0 && batchRate >= snapshot.maxBatchRate * 0.9) ||
        (snapshot.maxWorkers > 0 && workers >= snapshot.maxWorkers * 0.9) ||
        lanes.some(p => /launch|worker|batch.rate|shared.budget/i.test(p.admissionReason || ""))) {
        return { ok: false, reason: "Scheduler throughput limits take priority over more RAM" };
    }
    if (utilization < 0.8 && !ramPressure) return { ok: false, reason: `RAM utilization ${(utilization * 100).toFixed(0)}%; waiting for RAM pressure` };
    if (!(snapshot.income60 > 0 && snapshot.usedRam > 0 && addedRam > 0 && cost > 0)) return { ok: false, reason: "Insufficient income evidence" };
    const headroom = snapshot.maxBatchRate > 0 && batchRate > 0 ? Math.max(0, snapshot.maxBatchRate / batchRate - 1) : 1;
    const gain = snapshot.income60 * Math.min(addedRam / snapshot.usedRam, headroom, 1) * 0.5;
    const payback = gain > 0 ? cost / gain : Infinity;
    return { ok: Number.isFinite(payback) && payback <= maxPayback, gain, payback,
        reason: `Estimated +${Math.round(gain)}/s, ${Math.ceil(payback)}s payback (50% discount)` };
}

export function fleetCapacityPolicy(snapshot, objective = null) {
    const c = snapshot?.capacity;
    if (!c) return { ok: true, reason: "Legacy scheduler evidence" };
    const limits = [c.limitingFactor, ...(c.constraints || [])];
    const blocker = limits.find(code => ["BATCH_RATE", "LAUNCH_RATE", "WORKER_LIMIT", "RECOVERY"].includes(code) ||
        code === c.limitingFactor && ["TARGET_SLOTS", "NO_PROFITABLE_TARGET"].includes(code));
    if (blocker) return { ok: false, reason: `${blocker}: additional RAM cannot solve the scheduler constraint` };
    if (limits.includes("PREPARATION") && !c.preparation?.constrained) return { ok: false, reason: "PREPARATION: waiting for work, not RAM" };
    if (limits.includes("XP_RAM")) {
        const xp = c.xp;
        const ok = objective?.limitingResource === "hacking" && xp?.constrained === true && xp.target &&
            Number.isFinite(xp.desiredRam) && Number.isFinite(xp.allocatedRam) && xp.desiredRam > xp.allocatedRam;
        return { ok: Boolean(ok), xp: Boolean(ok), reason: ok ? "XP pipeline is RAM constrained" : "XP expansion requires an active skill goal and usable RAM demand" };
    }
    return { ok: true, reason: c.limitingFactor };
}
