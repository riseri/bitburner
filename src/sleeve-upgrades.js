import { readSavings } from "lib/savings.js";
import { sleevesAvailable } from "lib/sleeve-policy.js";
import { resetEpoch, freshStatus, augmentationInstallationPending } from "lib/progression-protocol.js";
import { PORTS } from "lib/ports.js";

/** Optional, bounded purchases; never a reason to postpone a node clear. @param {NS} ns */
export async function main(ns) {
    const request = JSON.parse(String(ns.args[0] || "null")), reset = ns.getResetInfo();
    if (ns.getHostname() !== "home" || !sleevesAvailable(reset) || !request ||
        request.resetEpoch !== resetEpoch(reset) || !Number.isFinite(request.createdAt) ||
        Date.now() < request.createdAt || Date.now() - request.createdAt > 30000 ||
        !(request.budget > 0 && request.budget <= .1) ||
        !ns.ps("home").some(p => p.pid === request.ownerPid && p.filename === "sleeve-manager.js")) return;
    const augmentation = ns.getPortHandle(PORTS.AUGMENTATION_STATUS).peek();
    if (freshStatus(augmentation, "augmentation-status") && augmentation.resetEpoch === request.resetEpoch &&
        ns.ps("home").some(p => p.filename === "augmentation-manager.js" && p.pid === augmentation.producerPid) &&
        augmentationInstallationPending(augmentation)) return;
    const budget = Math.max(0, ns.getServerMoneyAvailable("home") - readSavings(ns).floor) * request.budget;
    const affordable = cost => Number.isFinite(cost) && cost > 0 && cost <= budget &&
        ns.getServerMoneyAvailable("home") - cost >= readSavings(ns).floor;
    // These purchases persist through BitNodes, but access requires The Covenant.
    // Never save for them or make that faction a prerequisite for completion.
    if (reset.currentNode === 10 && ns.getPlayer().factions.includes("The Covenant")) {
        if (typeof ns.sleeve.getSleeveCost === "function" && typeof ns.sleeve.purchaseSleeve === "function" && affordable(ns.sleeve.getSleeveCost())) {
            if (ns.sleeve.purchaseSleeve().success) return;
        }
        if (typeof ns.sleeve.getMemoryUpgradeCost === "function" && typeof ns.sleeve.upgradeMemory === "function") {
            for (let index = 0; index < ns.sleeve.getNumSleeves(); index++) {
                if (ns.sleeve.getSleeve(index).memory < 100 && affordable(ns.sleeve.getMemoryUpgradeCost(index, 1))) {
                    if (ns.sleeve.upgradeMemory(index, 1).success) return;
                }
            }
        }
    }
    // One augmentation per pass: sleeve purchases reset its skills, so rapid
    // repeated purchases would constantly erase useful training.
    for (let index = 0; index < ns.sleeve.getNumSleeves(); index++) {
        if (ns.sleeve.getSleeve(index).shock > 0) continue;
        const candidates = ns.sleeve.getSleevePurchasableAugs(index).filter(aug => affordable(aug.cost)).sort((a, b) => a.cost - b.cost);
        for (const aug of candidates) if (ns.sleeve.purchaseSleeveAug(index, aug.name)) return;
    }
}
