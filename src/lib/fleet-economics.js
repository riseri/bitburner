// Deliberately conservative heuristic, not a marginal-income guarantee.
export function evaluateFleetInvestment(snapshot, addedRam, cost, maxPayback = 1800) {
    if (!snapshot || snapshot.type !== "jit-status" || !Array.isArray(snapshot.pipelines)) return { ok: false, reason: "Waiting for live scheduler evidence" };
    const lanes = snapshot.pipelines;
    if (!lanes.length || lanes.some(p => p.mode !== "LIVE")) return { ok: false, reason: "Waiting for stable earning targets" };
    const utilization = snapshot.totalRam > 0 ? snapshot.usedRam / snapshot.totalRam : 0;
    const ramPressure = lanes.some(p => /RAM|allocation/i.test(p.admissionReason || ""));
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
