import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";

// Consumers import this cheap reader, never the Singularity producer.
export function readProgressionSnapshot(ns, now = Date.now()) {
    try {
        const status = ns.getPortHandle(PORTS.AUGMENTATION_STATUS).peek(), value = status?.progression;
        if (status?.type !== "augmentation-status" || status.version !== 1 || status.error ||
            !value || value.version !== 1 || value.type !== "progression-objective" ||
            value.producer !== "augmentation-manager.js" || value.producerPid !== status.producerPid ||
            value.resetEpoch !== resetEpoch(ns.getResetInfo()) || value.resetEpoch !== status.resetEpoch ||
            !Number.isFinite(value.generatedAt) || now < value.generatedAt || now - value.generatedAt > 15000 ||
            !Number.isFinite(status.generatedAt) || now < status.generatedAt || now - status.generatedAt > 15000 ||
            !ns.ps("home").some(p => p.pid === value.producerPid && p.filename === value.producer)) return null;
        return value;
    } catch { return null; }
}

export function distinctAugmentations(names = []) { return [...new Set(names)]; }

export function sharingDemand(objective, work) {
    const next = objective?.selectedPlan?.next;
    if (objective?.limitingResource !== "reputation" || objective.resetImminent || !(next?.repGap > 0) ||
        work?.type !== "FACTION" || work.factionName !== next.faction) return "OFF";
    return objective.milestone === "RED_PILL" && (next.name === "The Red Pill" || next.chainTarget === "The Red Pill")
        ? "AGGRESSIVE" : "SPARE_ONLY";
}

export function readSharingDemand(ns) {
    const demand = readProgressionSnapshot(ns)?.sharingDemand;
    return ["SPARE_ONLY", "AGGRESSIVE"].includes(demand) ? demand : "OFF";
}

export function progressionObjective({ currentNode, installed = [], owned = [], player = {}, money = 0,
    multipliers = null, finalRequirement = null, backdoors = [], plan = null }) {
    const installedCount = distinctAugmentations(installed).length;
    const ownedCount = distinctAugmentations(owned).length;
    const countRequired = Number.isFinite(multipliers?.DaedalusAugsRequirement) ? multipliers.DaedalusAugsRequirement : 30;
    const redPill = installed.includes("The Red Pill") ? "installed" : owned.includes("The Red Pill") ? "queued" : "none";
    const level = Number(player.skills?.hacking) || 0, next = plan?.next;
    let milestone = "AUGMENTATIONS", limitingResource = next?.repGap > 0 ? "reputation" : "cash";
    let requiredHacking = null, requiredCash = next?.chainCost || next?.price || 0, requiredReputation = next?.repRequired || null;
    if (redPill === "installed") {
        milestone = "FINAL_SERVER"; requiredHacking = finalRequirement; requiredCash = 0;
        limitingResource = finalRequirement == null ? "discovery" : level < finalRequirement ? "hacking" : "completion";
    } else if (redPill === "queued") { milestone = "INSTALL_RED_PILL"; limitingResource = "installation"; requiredCash = 0; }
    else if (player.factions?.includes("Daedalus")) { milestone = "RED_PILL"; }
    else if (installedCount >= countRequired) {
        milestone = "DAEDALUS"; requiredHacking = 2500; requiredCash = 100e9;
        const combatReady = ["strength", "defense", "dexterity", "agility"].every(k => player.skills?.[k] >= 1500);
        limitingResource = level < 2500 && !combatReady ? "hacking" : money < requiredCash ? "cash" : "invitation";
    } else {
        const unlock = backdoors.filter(b => !b.installed && b.requiredHacking > level).sort((a,b) => a.requiredHacking - b.requiredHacking)[0];
        if (unlock) requiredHacking = unlock.requiredHacking;
        if (!next && unlock) { milestone = "FACTION_UNLOCK"; limitingResource = "hacking"; }
        else if (ownedCount >= countRequired) limitingResource = "installation";
    }
    if (next && next.repGap === 0 && money >= requiredCash && limitingResource === "cash") limitingResource = "purchase";
    const savings = requiredCash > 0 && !(milestone === "DAEDALUS" && limitingResource === "hacking") ? { amount: requiredCash,
        target: milestone === "DAEDALUS" ? "faction:Daedalus" : next ? "augmentation:" + next.name : "",
        label: milestone === "DAEDALUS" ? "Daedalus invitation" : next?.name || milestone } : null;
    return { currentNode, strategy: currentNode === 4 ? "BN4 hacking and distinct augmentations" : "Generic capability-aware hacking/faction strategy",
        installed: distinctAugmentations(installed), owned: distinctAugmentations(owned), installedCount, ownedCount,
        queuedDistinct: distinctAugmentations(owned).filter(name => !installed.includes(name)), countRequired, redPill,
        milestone, limitingResource, requiredHacking, requiredReputation, requiredCash, moneyCovered: money >= requiredCash,
        selectedPlan: plan, savings, benefits: "Queued upgrades take effect only after installation" };
}

// Absolute high-water marks avoid treating spending, oscillation, or reset age as progress.
export function observeProgress(state, facts, now = Date.now()) {
    const key = facts.key;
    if (!state.progress || state.progress.key !== key) state.progress = { key, since: now, lastProgressAt: now, cash: 0, rep: 0, owned: 0, level: 0 };
    const p = state.progress;
    for (const field of ["cash", "rep", "owned", "level"]) {
        const value = Number(facts[field]) || 0;
        if (value > p[field] + Math.max(field === "cash" ? 1 : 0, p[field] * .001)) { p[field] = value; p.lastProgressAt = now; }
    }
    return { ...p, stalledMs: now - p.lastProgressAt, waitingMs: now - p.since };
}
