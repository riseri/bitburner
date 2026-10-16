import { resetEpoch, singularityAvailable, progressionBackdoors, augmentationInstallationPending } from "lib/progression-protocol.js";
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
    let income = null, balance = null, xpCycleMs = null, engineStable = false, engineProductive = false;
    try {
        const s = ns.getPortHandle(PORTS.JIT_STATUS).peek();
        if (s?.type === "jit-status" && s.version === 2 && Number.isFinite(s.generatedAt) && s.generatedAt <= Date.now() && Date.now() - s.generatedAt < 15000 &&
            s.generatedAt >= reset.lastAugReset && ns.ps(typeof s.host === "string" ? s.host : "home").some(p => p.pid === s.pid && p.filename === "daemon.js")) {
            if (Number.isFinite(s.income60) && s.income60 > 0) income = s.income60;
            balance = s.policy?.balance || null;
            const cycle = s.policy?.xp?.cycleMs;
            if (Number.isFinite(cycle) && cycle > 0) xpCycleMs = cycle;
            engineStable = Array.isArray(s.pipelines) && s.pipelines.length > 0 && s.pipelines.every(p => p.mode === "LIVE") && !(s.prepRam > 0);
            engineProductive = Array.isArray(s.pipelines) && s.pipelines.some(p => p.mode === "LIVE") && income > 0;
        }
    } catch {}
    const gang = readAugmentationGang(ns, reset, player);
    if (gang?.incomePerSecond > 0) income = (income || 0) + gang.incomePerSecond;
    const capabilities = { singularity: singularityAvailable(reset), formulas: ns.fileExists("Formulas.exe", "home"),
        multipliers: !!multipliers, sleeves: reset.currentNode === 10 || Number(reset.ownedSF?.get?.(10)) > 0,
        gang: reset.currentNode === 2 || Number(reset.ownedSF?.get?.(2)) > 0,
        corporation: reset.currentNode === 3 || Number(reset.ownedSF?.get?.(3)) >= 3,
        optionalSystems: "Gang and sleeve automation available; corporation flag is an access hint only" };
    return { reset, resetEpoch: epoch, installed, owned, player, money, multipliers, backdoors, finalRequirement, income, balance, xpCycleMs, engineStable, engineProductive, capabilities, gang,
        objective: progressionObjective({ plan: state.previousPlan, currentNode: reset.currentNode, installed, owned, player, money, multipliers, backdoors, finalRequirement, gang }) };
}

// Gang APIs remain confined to the Singularity producer. A persisted gang can
// provide the route even before its manager publishes the first fresh heartbeat.
export function readAugmentationGang(ns, reset = ns.getResetInfo(), player = ns.getPlayer()) {
    if (reset.currentNode !== 2 && !(Number(reset.ownedSF?.get?.(2)) > 0)) return null;
    let gang = null;
    try {
        const status = ns.getPortHandle(PORTS.GANG_STATUS).peek(), now = Date.now();
        if (status?.type === "gang-status" && status.version === 1 && !status.error && status.inGang &&
            status.resetEpoch === resetEpoch(reset) && Number.isFinite(status.generatedAt) &&
            status.generatedAt <= now && now - status.generatedAt < 15000 &&
            ns.ps("home").some(p => p.filename === "gang-manager.js" && p.pid === status.producerPid)) {
            gang = { inGang: true, faction: status.faction, isHacking: status.isHacking, managed: true,
                incomePerSecond: Number.isFinite(status.incomePerSecond) && status.incomePerSecond > 0 ? status.incomePerSecond : null };
        }
    } catch {}
    if (!gang) {
        try {
            if (ns.gang.inGang()) {
                const info = ns.gang.getGangInformation();
                gang = { inGang: true, faction: info.faction, isHacking: info.isHacking, managed: false, incomePerSecond: null };
            }
        } catch {}
    }
    if (!gang || typeof gang.faction !== "string" || !player.factions.includes(gang.faction)) return null;
    try { gang.offersRedPill = ns.singularity.getAugmentationsFromFaction(gang.faction).includes("The Red Pill"); }
    catch { gang.offersRedPill = false; }
    return gang;
}

export function makeProgressionSnapshot(ns, context, status) {
    const objective = progressionObjective({ ...context, currentNode: context.reset.currentNode, plan: status.plan });
    let work = null;
    try { work = ns.singularity.getCurrentWork(); } catch {}
    const funding = status.endgame?.funding;
    const shareObjective = funding?.strategy === "WORK" ? { ...objective, limitingResource: "reputation",
        selectedPlan: { next: { faction: funding.faction, repGap: funding.repGap } } } : objective;
    const resetImminent = augmentationInstallationPending(status);
    return { ...objective, type: "progression-objective", version: 1, generatedAt: Date.now(), producer: "augmentation-manager.js",
        producerPid: ns.pid, resetEpoch: context.resetEpoch, capabilities: context.capabilities, multipliers: context.multipliers,
        incomePerSecond: context.income, savings: status.savings || objective.savings,
        installDecision: status.installDecision || status.plan?.installDecision || null,
        resetImminent,
        resetPending: Boolean(status.resetDecision?.completionGoal && status.resetDecision.advantage), recommendation: status.recommendation,
        sharingDemand: sharingDemand({ ...shareObjective, resetImminent }, work),
        missingInformation: [!context.income && "measured income", !context.capabilities.formulas && "Formulas work/donation rates",
            !context.multipliers && "BitNode multipliers"].filter(Boolean) };
}
