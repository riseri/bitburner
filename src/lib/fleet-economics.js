// Deliberately conservative heuristic, not a marginal-income guarantee.
export function evaluateFleetInvestment(snapshot, addedRam, cost, maxPayback = 1800, objective = null) {
    if (!snapshot || snapshot.type !== "jit-status" || !Array.isArray(snapshot.pipelines)) return { ok: false, reason: "Waiting for live scheduler evidence" };
    const policy = fleetCapacityPolicy(snapshot, objective);
    if (!policy.ok) return policy;
    if (policy.xp) {
        const unmet = snapshot.capacity.xp.desiredRam - snapshot.capacity.xp.allocatedRam;
        const payback = Number.isFinite(snapshot.income60) && snapshot.income60 > 0 ? cost / snapshot.income60 : Infinity;
        return { ok: addedRam > 0 && cost > 0 && addedRam <= unmet * 2 && payback <= Math.min(300, maxPayback), payback,
            reason: `XP pipeline is RAM constrained; progression-driven, ${Math.ceil(payback)}s capital recovery bound` };
    }
    const lanes = snapshot.pipelines.filter(p => p.mode === "LIVE" || p.running > 0 || p.queued > 0);
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
    if (policy.scaling && addedRam > snapshot.capacity.scaling.ramRequest.addedRam * 2)
        return { ok: false, reason: "Cloud quote exceeds the bounded adaptive RAM request" };
    const headroom = snapshot.maxBatchRate > 0 && batchRate > 0 ? Math.max(0, snapshot.maxBatchRate / batchRate - 1) : 1;
    // Home remains absent from generic RAM telemetry. Count only its measured
    // productive contribution in the ROI denominator, shared with home quotes.
    const home = snapshot.capacity?.homeGw;
    const homeWork = Math.max(0, home?.recentUsage?.averageRam || 0) * (home?.coreBonus || 1);
    const gain = snapshot.income60 * Math.min(addedRam / (snapshot.usedRam + homeWork), headroom, 1) * 0.5;
    const payback = gain > 0 ? cost / gain : Infinity;
    return { ok: Number.isFinite(payback) && payback <= maxPayback, gain, payback,
        reason: `Estimated +${Math.round(gain)}/s, ${Math.ceil(payback)}s payback (50% discount)` };
}

export function fleetCapacityPolicy(snapshot, objective = null) {
    const c = snapshot?.capacity;
    if (!c) return { ok: true, reason: "Legacy scheduler evidence" };
    const limits = [c.limitingFactor, ...(c.constraints || [])];
    // A fragmented money batch can require many launches while a new G/W XP
    // host needs one. Only a fresh allocator/timing proof can distinguish them.
    const xpLaunchable = limits.includes("XP_RAM") && c.xp?.expansion && c.xp.launchable === true;
    const sharedBlocker = limits.find(code => ["LAUNCH_RATE", "WORKER_LIMIT", "RECOVERY"].includes(code) && !(code === "LAUNCH_RATE" && xpLaunchable));
    if (sharedBlocker) return { ok: false, reason: `${sharedBlocker}: additional RAM cannot solve the scheduler constraint` };
    // XP G/W thread capacity is independent of money batch rate and money target
    // slots. A money-only ceiling must not veto an otherwise usable XP request.
    if (limits.includes("XP_RAM")) {
        const xp = c.xp;
        const ok = objective?.limitingResource === "hacking" && xp?.constrained === true && xp.target &&
            Number.isFinite(xp.desiredRam) && Number.isFinite(xp.allocatedRam) && xp.desiredRam > xp.allocatedRam;
        return { ok: Boolean(ok), xp: Boolean(ok), reason: ok ? "XP pipeline is RAM constrained" +
            (xp.confidence === "MODEL (warmup)" ? "; bounded prepared G/W capacity probe while XP measurements warm up" : "") : "XP expansion requires an active skill goal and usable RAM demand" };
    }
    if ([c.scaling?.batchMode, c.scaling?.launchMode].includes("auto") && c.ram?.scalable === false)
        return { ok: false, reason: "No modeled RAM gain: existing plans reach cadence/steal limits and no useful additional lane needs memory" };
    const scaling = usableScalingRam(c);
    const moneyBlocker = limits.find(code => code === "BATCH_RATE" ||
        !scaling && code === c.limitingFactor && ["TARGET_SLOTS", "NO_PROFITABLE_TARGET"].includes(code));
    if (moneyBlocker) return { ok: false, reason: `${moneyBlocker}: additional RAM cannot solve the scheduler constraint` };
    if (limits.includes("PREPARATION") && !c.preparation?.constrained) return { ok: false, reason: "PREPARATION: waiting for work, not RAM" };
    return { ok: true, scaling, reason: scaling ? "Measured adaptive RAM expansion" : c.limitingFactor };
}

function usableScalingRam(c) {
    const s = c.scaling, r = s?.ramRequest;
    return Boolean(r && [s.batchMode, s.launchMode].includes("auto") && r.confidence === "MEASURED" && r.observedMs >= 60_000 &&
        Number.isFinite(r.addedRam) && r.addedRam > 0 && c.batchRate?.used < c.batchRate?.limit * .9 &&
        c.launches?.peakReserved < c.launches?.limit * .8 && c.workers?.committed < c.workers?.limit * .8 &&
        c.ram?.scalable === true && (c.ram?.utilization >= .85 || c.constraints?.includes("RAM")));
}
