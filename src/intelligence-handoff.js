import { readIntelligenceSession } from "lib/intelligence-session.js";
import { bn4Route } from "lib/bitnode-route.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

/** Transfer a fresh BN4 run to its one bounded INT session. @param {NS} ns */
export async function main(ns) {
    const request = JSON.parse(String(ns.args[0] || "null")), reset = ns.getResetInfo();
    if (ns.getHostname() !== "home" || !request || request.resetEpoch !== resetEpoch(reset) ||
        !Number.isFinite(request.createdAt) || Date.now() < request.createdAt || Date.now() - request.createdAt > 30000 ||
        !bn4Route(reset) || !(reset.ownedSF?.get(5) > 0)) return;
    const processes = ns.ps("home"), manager = processes.find(p => p.pid === request.ownerPid && p.filename === "augmentation-manager.js");
    const supervisors = processes.filter(p => p.filename === "supervisor.js");
    if (!manager || supervisors.length !== 1 || processes.some(p => ["progression-purchase.js", "progression-backdoor.js", "intelligence-farm.js"].includes(p.filename))) return;
    const player = ns.getPlayer();
    if (player.skills.intelligence >= 50 || ns.singularity.isBusy() || ns.singularity.getOwnedAugmentations(true).length) return;
    if (!player.factions.includes("Shadows of Anarchy") && !ns.singularity.checkFactionInvitations().includes("Shadows of Anarchy")) return;
    try { restoreSupervisorArgs(ns.read("data/supervisor-bootstrap.json")); }
    catch { return; }
    if (!(ns.getScriptRam("intelligence-farm.js", "home") > 0) || ns.getScriptRam("intelligence-farm.js", "home") > ns.getServerMaxRam("home")) return;
    let prior;
    try { prior = JSON.parse(ns.read("data/intelligence-auto.json") || "null"); } catch { return; }
    if (prior?.nodeReset === reset.lastNodeReset || readIntelligenceSession(ns)) return;
    await ns.write("data/intelligence-auto.json", JSON.stringify({ version: 1, nodeReset: reset.lastNodeReset, startedAt: Date.now() }), "w");
    if (!ns.kill(manager.pid) || !ns.kill(supervisors[0].pid)) {
        ns.tprint("INT handoff stopped: could not release automation ownership. Restart supervisor.js."); return;
    }
    ns.spawn("intelligence-farm.js", { threads: 1, spawnDelay: 0 }, "--start", "--minutes", 10, "--target", 50);
}
