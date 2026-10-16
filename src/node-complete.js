import { nextRouteNode, routeStopsAfterClear } from "lib/bitnode-route.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

/** Short-lived, RAM-isolated node transition. @param {NS} ns */
export async function main(ns) {
    const request = JSON.parse(String(ns.args[0] || "null")), reset = ns.getResetInfo();
    const nextNode = nextRouteNode(reset);
    const refuse = reason => ns.tprint(`Node transition blocked: ${reason}`);
    if (ns.getHostname() !== "home" || !request || !singularityAvailable(reset) || nextNode === null ||
        request.nextNode !== nextNode || request.resetEpoch !== resetEpoch(reset) ||
        !Number.isFinite(request.createdAt) || Date.now() < request.createdAt || Date.now() - request.createdAt > 30000) {
        return refuse("not a fresh authorized same-BitNode route transition");
    }
    if (!ns.ps("home").some(p => p.pid === request.ownerPid && p.filename === "augmentation-manager.js")) return refuse("controller is no longer running");
    if (ns.ps("home").some(p => p.pid !== ns.pid && p.filename === "node-complete.js")) return refuse("duplicate transition");
    if (!ns.singularity.getOwnedAugmentations(false).includes("The Red Pill")) return refuse("The Red Pill is not installed");
    if (!ns.serverExists("w0r1d_d43m0n") || !ns.hasRootAccess("w0r1d_d43m0n") ||
        ns.getHackingLevel() < ns.getServerRequiredHackingLevel("w0r1d_d43m0n")) return refuse("final server requirements are not met");
    if (ns.singularity.isBusy()) return refuse("player is busy");
    if (routeStopsAfterClear(reset)) {
        ns.tprint("BN10.3 complete: awarding SF10.3 and parking in BN10 with all scripts stopped.");
        ns.singularity.destroyW0r1dD43m0n(nextNode);
        return;
    }
    try { restoreSupervisorArgs(ns.read("data/supervisor-bootstrap.json")); }
    catch { return refuse("invalid restart settings"); }
    for (const file of ["bootstrap.js", "supervisor.js"]) {
        if (!ns.fileExists(file, "home") || !(ns.getScriptRam(file, "home") > 0)) return refuse(`missing script/import: ${file}`);
    }
    // The completion awards its Source-File before the callback starts.
    const nextSf1 = Number(reset.ownedSF?.get(1) || 0) + Number(reset.currentNode === 1);
    const nextSf9 = Number(reset.ownedSF?.get(9) || 0) + Number(reset.currentNode === 9);
    const startingRam = nextSf9 >= 2 ? 128 : nextSf1 > 0 ? 32 : 8;
    if (ns.getScriptRam("bootstrap.js", "home") > startingRam || ns.getScriptRam("supervisor.js", "home") > startingRam) return refuse(`startup scripts must fit the next node's ${startingRam} GB home`);
    ns.singularity.destroyW0r1dD43m0n(nextNode, "bootstrap.js");
}
