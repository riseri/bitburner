import { evaluateFleetInvestment } from "lib/fleet-economics.js";

// Compare reaching the same admission goal with and without a funded opener.
// Reuse the fleet's discounted worker-RAM estimate; new hacking targets are
// deliberately not credited before they have produced income.
export function evaluateRootUnlock(snapshot, program, admission, cash, objective = null, now = Date.now()) {
    const hold = reason => ({ ok: false, reason });
    if (objective?.resetImminent || objective?.redPill === "queued") return hold("Installation retains capital");
    if (!Number.isFinite(cash) || cash < 0 || !Number.isFinite(admission?.amount) || admission.amount <= 0)
        return hold("Waiting for a valid service RAM goal");
    if (cash >= admission.amount) return hold("Service RAM is already funded");
    if (!Number.isFinite(program?.cost) || program.cost <= 0 || !Number.isFinite(program.amount) ||
        program.amount < program.cost || program.amount > cash) return hold("Root unlock is not funded with its reserve");
    if (!Number.isFinite(program.addedRam) || program.addedRam <= 0) return hold("No newly unlocked worker RAM");
    if (snapshot?.type !== "jit-status" || !Number.isFinite(snapshot.generatedAt) ||
        snapshot.generatedAt > now || now - snapshot.generatedAt > 15000 ||
        !Number.isFinite(snapshot.income60) || snapshot.income60 <= 0 || !Array.isArray(snapshot.pipelines) || !snapshot.pipelines.length)
        return hold("Waiting for fresh measured hacking income");
    const lanes = snapshot.pipelines.filter(p => p.mode === "LIVE" || p.running > 0 || p.queued > 0);
    if (!lanes.length || lanes.some(p => !Number.isFinite(p.warmupMs) || p.warmupMs <= 0))
        return hold("Waiting for worker activation timing");
    const economics = evaluateFleetInvestment(snapshot, program.addedRam, program.cost, Infinity, objective);
    if (!economics.ok) return hold(economics.reason);
    if (!Number.isFinite(economics.gain) || economics.gain <= 0) return hold("No measured money gain from extra worker RAM");
    // Allow a minute for rooting/network refresh, then a full batch warmup.
    // Existing workers keep earning while the added RAM comes online.
    const activationSeconds = 60 + Math.max(...lanes.map(p => p.warmupMs)) / 1000;
    const income = snapshot.income60, deficit = admission.amount - cash;
    const directSeconds = deficit / income, afterPurchase = deficit + program.cost;
    const warmupSeconds = Math.min(activationSeconds, afterPurchase / income);
    const unlockSeconds = warmupSeconds + (afterPurchase - income * warmupSeconds) / (income + economics.gain);
    const savedSeconds = directSeconds - unlockSeconds;
    // A useful margin avoids switching goals for noisy, negligible gains.
    const ok = savedSeconds >= 30 && unlockSeconds <= directSeconds * .9;
    return { ...economics, ok, directSeconds, unlockSeconds, savedSeconds, activationSeconds,
        reason: `Service RAM ETA ${Math.ceil(directSeconds)}s -> ${Math.ceil(unlockSeconds)}s after opener; ` +
            `estimated +${Math.round(economics.gain)}/s from ${program.addedRam} GB (50% discount, ${Math.ceil(activationSeconds)}s activation)` +
            (ok ? "" : "; needs at least 10% and 30s saved") };
}
