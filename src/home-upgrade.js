/** Small remote-capable helper for the 8 GB BN4 bootstrap. @param {NS} ns */
export async function main(ns) {
    const [epoch, target, floor] = ns.args, r = ns.getResetInfo();
    if (r.currentNode !== 4 || `${r.currentNode}:${r.lastNodeReset}:${r.lastAugReset}` !== epoch ||
        !Number.isFinite(target) || target < 8 || !Number.isFinite(floor) || floor < 0) return;
    if (ns.getServerMaxRam("home") >= target) return;
    const cost = ns.singularity.getUpgradeHomeRamCost();
    if (Number.isFinite(cost) && cost > 0 && ns.getServerMoneyAvailable("home") - cost >= floor) ns.singularity.upgradeHomeRam();
}
