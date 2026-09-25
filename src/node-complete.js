import { bn4Route, nextRouteNode } from "lib/bitnode-route.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

/** Short-lived, RAM-isolated node transition. @param {NS} ns */
export async function main(ns) {
    const request = JSON.parse(String(ns.args[0] || "null")), reset = ns.getResetInfo();
    const refuse = reason => ns.tprint(`Node transition blocked: ${reason}`);
    if (ns.getHostname() !== "home" || !request || !bn4Route(reset) || nextRouteNode(reset) !== 4 ||
        request.nextNode !== 4 || request.resetEpoch !== resetEpoch(reset) ||
        !Number.isFinite(request.createdAt) || Date.now() < request.createdAt || Date.now() - request.createdAt > 30000) {
        return refuse("not a fresh authorized BN4.1/BN4.2 transition");
    }
    if (!ns.ps("home").some(p => p.pid === request.ownerPid && p.filename === "augmentation-manager.js")) return refuse("controller is no longer running");
    if (ns.ps("home").some(p => p.pid !== ns.pid && p.filename === "node-complete.js")) return refuse("duplicate transition");
    if (!ns.singularity.getOwnedAugmentations(false).includes("The Red Pill")) return refuse("The Red Pill is not installed");
    if (!ns.serverExists("w0r1d_d43m0n") || !ns.hasRootAccess("w0r1d_d43m0n") ||
        ns.getHackingLevel() < ns.getServerRequiredHackingLevel("w0r1d_d43m0n")) return refuse("final server requirements are not met");
    if (ns.singularity.isBusy()) return refuse("player is busy");
    try { restoreSupervisorArgs(ns.read("data/supervisor-bootstrap.json")); }
    catch { return refuse("invalid restart settings"); }
    for (const file of ["bootstrap.js", "supervisor.js"]) {
        if (!ns.fileExists(file, "home") || !(ns.getScriptRam(file, "home") > 0)) return refuse(`missing script/import: ${file}`);
    }
    const startingRam = Number(reset.ownedSF?.get(9)) >= 2 ? 128 : Number(reset.ownedSF?.get(1)) > 0 ? 32 : 8;
    if (ns.getScriptRam("bootstrap.js", "home") > startingRam || ns.getScriptRam("supervisor.js", "home") > startingRam) return refuse(`startup scripts must fit the next node's ${startingRam} GB home`);
    ns.singularity.destroyW0r1dD43m0n(4, "bootstrap.js");
}
