import { homeCoreBonus, HOME_MAX_CORES } from "lib/home-mechanics.js";
import { fleetCapacityPolicy } from "lib/fleet-economics.js";

export function evaluateHomeInvestment(snapshot, quote, kind, objective, now = Date.now()) {
    const hold = reason => ({ ok: false, reason });
    const home = snapshot?.capacity?.homeGw, usage = home?.recentUsage;
    if (!snapshot || snapshot.type !== "jit-status" || !Number.isFinite(snapshot.generatedAt) ||
        now < snapshot.generatedAt || now - snapshot.generatedAt > 15000 || !home?.enabled ||
        !Number.isFinite(home.generatedAt) || now < home.generatedAt || now - home.generatedAt > 15000)
        return hold("Waiting for fresh home G/W evidence");
    if (!quote || quote.type !== "home-capital-quote" || !Number.isFinite(quote.generatedAt) || now < quote.generatedAt || now - quote.generatedAt > 15000 ||
        quote.ram !== home.maxRam || quote.cores !== home.cores) return hold("Home quote is stale");
    if (!objective || objective.resetImminent || objective.redPill === "queued" ||
        ["installation", "completion"].includes(objective.limitingResource)) return hold("Progression policy retains capital");
    const policy = fleetCapacityPolicy(snapshot, objective);
    if (!policy.ok) return policy;
    const limits = [snapshot.capacity.limitingFactor, ...(snapshot.capacity.constraints || [])];
    if (!limits.includes("RAM") && !(limits.includes("PREPARATION") && snapshot.capacity.preparation?.constrained) && !policy.xp)
        return hold("No productive G/W RAM pressure");
    if (policy.xp && !["G", "W"].includes(snapshot.capacity.xp?.action)) return hold("XP Hack cannot use home");
    // Full-XP G/W spam at a prepared target does not gain XP from cores. Only
    // measured money/recovery G/W can justify cores; RAM may serve script XP.
    if (!usage || usage.seconds < 30 || !(usage.averageRam > 0)) return hold("Need sustained measured home G/W utilization");
    if (home.safeRam > Math.max(2, usage.averageRam * 0.25)) return hold("Existing home G/W slack is not exhausted");
    if (!snapshot.pipelines?.length || snapshot.pipelines.some(p => p.mode !== "LIVE")) return hold("Waiting for stable earning lanes");
    if (kind === "cores" && home.cores >= HOME_MAX_CORES) return hold("Home cores are at maximum");
    const cost = kind === "cores" ? quote.coreCost : quote.ramCost;
    const released = kind === "cores" ? Math.min(usage.nextCoreReleasedRam || 0, usage.averageRam * (1 - homeCoreBonus(home.cores) / homeCoreBonus(home.cores + 1)))
        : Math.min(quote.ram, usage.averageRam); // demand bounded, never all doubled RAM
    // Only displace observed remote G/W. Extra home capacity cannot relieve a
    // remote pool occupied entirely by Hack, even under generic RAM pressure.
    const effectiveRam = Math.min(released * homeCoreBonus(home.cores), usage.remoteGwAverageRam || 0);
    const productiveRam = snapshot.usedRam + usage.averageRam * homeCoreBonus(home.cores);
    const rate = snapshot.pipelines.reduce((n, p) => n + (p.modelBatchRate || 0), 0);
    const rateHeadroom = snapshot.maxBatchRate > 0 && rate > 0 ? Math.max(0, snapshot.maxBatchRate / rate - 1) : 0;
    const gain = snapshot.income60 * Math.min(effectiveRam / productiveRam, rateHeadroom, 1) * 0.5;
    const payback = gain > 0 ? cost / gain : Infinity;
    const ok = cost > 0 && Number.isFinite(cost) && Number.isFinite(payback) && payback <= 300;
    return { ok, cost, gain, payback, effectiveRam, releasedRam: released, confidence: "conservative", resource: `home-${kind}`,
        reason: `${kind === "cores" ? "Measured G/W efficiency" : "Productive home G/W capacity"}: +${Math.round(gain)}/s, ${Math.ceil(payback)}s payback (50% discount)` };
}
