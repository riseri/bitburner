import { claimAction, publishAction, validateRequest } from "lib/progression-protocol.js";
import { readProgressionSnapshot } from "lib/progression-objective.js";

/** Small bootstrap actor: accept a compatible hacking-faction invitation. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const request = claimAction(ns, ["join-faction"]);
    if (!request) return;
    try {
        if (ns.getPlayer().factions.includes(request.target)) {
            publishAction(ns, request, "succeeded", "already-joined"); return;
        }
        const objective = readProgressionSnapshot(ns);
        if (objective?.resetImminent || objective?.redPill === "queued") {
            publishAction(ns, request, "blocked", "installation-imminent"); return;
        }
        if (!ns.singularity.checkFactionInvitations().includes(request.target)) {
            publishAction(ns, request, "blocked", "invitation-pending"); return;
        }
        const error = validateRequest(request, ns.getResetInfo());
        if (error) { publishAction(ns, request, "blocked", error); return; }
        const joined = ns.singularity.joinFaction(request.target) && ns.getPlayer().factions.includes(request.target);
        publishAction(ns, request, joined ? "succeeded" : "failed", joined ? `Joined ${request.target}` : "join-not-confirmed");
    } catch (error) { publishAction(ns, request, "failed", String(error?.message ?? error)); }
}
