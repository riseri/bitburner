import { resetEpoch, singularityAvailable, progressionBackdoors } from "lib/progression-protocol.js";
import { progressionObjective, sharingDemand } from "lib/progression-objective.js";
import { PORTS } from "lib/ports.js";

export function augmentationContext(ns, state = {}) {
    const reset = ns.getResetInfo(), epoch = resetEpoch(reset), player = ns.getPlayer();
    let multipliers = null;
    if (reset.currentNode === 5 || Number(reset.ownedSF?.get?.(5)) > 0) {
        try { multipliers = ns.getBitNodeMultipliers(); } catch {}
    }
    const installed = ns.singularity.getOwnedAugmentations(false), owned = ns.singularity.getOwnedAugmentations(true);
    const backdoors = progressionBackdoors().flatMap(b => {
        try { return ns.serverExists(b.host) ? [{ ...b, requiredHacking: ns.getServerRequiredHackingLevel(b.host), installed: ns.getServer(b.host).backdoorInstalled }] : []; } catch { return []; }
    });
    let finalRequirement = null;
    try { if (ns.serverExists("w0r1d_d43m0n")) finalRequirement = ns.getServerRequiredHackingLevel("w0r1d_d43m0n"); } catch {}
    const money = ns.getServerMoneyAvailable("home");
    let income = null;
    try {
        const s = ns.getPortHandle(PORTS.JIT_STATUS).peek();
        if (s?.type === "jit-status" && s.generatedAt <= Date.now() && Date.now() - s.generatedAt < 15000 &&
            s.generatedAt >= reset.lastAugReset && ns.isRunning(s.pid) && s.income60 > 0) income = s.income60;
    } catch {}
    const capabilities = { singularity: singularityAvailable(reset), formulas: ns.fileExists("Formulas.exe", "home"),
        multipliers: !!multipliers, sleeves: reset.currentNode === 10 || Number(reset.ownedSF?.get?.(10)) > 0,
        gang: reset.currentNode === 2 || Number(reset.ownedSF?.get?.(2)) > 0,
        corporation: reset.currentNode === 3 || Number(reset.ownedSF?.get?.(3)) >= 3,
        optionalSystems: "Access hints only; no sleeve, gang, or corporation manager" };
    return { reset, resetEpoch: epoch, installed, owned, player, money, multipliers, backdoors, finalRequirement, income, capabilities,
        objective: progressionObjective({ plan: state.previousPlan, currentNode: reset.currentNode, installed, owned, player, money, multipliers, backdoors, finalRequirement }) };
}

export function makeProgressionSnapshot(ns, context, status) {
    const objective = progressionObjective({ ...context, currentNode: context.reset.currentNode, plan: status.plan });
    let work = null;
    try { work = ns.singularity.getCurrentWork(); } catch {}
    return { ...objective, type: "progression-objective", version: 1, generatedAt: Date.now(), producer: "augmentation-manager.js",
        producerPid: ns.pid, resetEpoch: context.resetEpoch, capabilities: context.capabilities, multipliers: context.multipliers,
        incomePerSecond: context.income, savings: status.savings || objective.savings,
        installDecision: status.installDecision || status.plan?.installDecision || null,
        resetImminent: status.phase === "INSTALL", recommendation: status.recommendation,
        sharingDemand: sharingDemand({ ...objective, resetImminent: status.phase === "INSTALL" }, work),
        missingInformation: [!context.income && "measured income", !context.capabilities.formulas && "Formulas work/donation rates",
            !context.multipliers && "BitNode multipliers"].filter(Boolean) };
}
