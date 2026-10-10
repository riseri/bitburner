import { INTELLIGENCE_AUTO, readIntelligenceSession, intelligenceSessionActive, intelligenceAvailable, intelligenceFactions } from "lib/intelligence-session.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { readIntelligenceRequest, savedIntelligencePolicy, intelligenceAttempted, intelligenceCallbackFits, installedIntelligencePackage } from "lib/intelligence-automation.js";

/** Enter INT farming directly after an approved augmentation installation. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run intelligence-handoff.js on home");
    try {
        const reset = ns.getResetInfo(), epoch = resetEpoch(reset), request = readIntelligenceRequest(ns);
        if (!request || !singularityAvailable(reset) || !intelligenceAvailable(reset) || intelligenceAttempted(ns)) return resume(ns);
        const policy = savedIntelligencePolicy(ns), player = ns.getPlayer();
        if (!policy.enabled || policy.minutes !== request.policy.minutes || policy.target !== request.policy.target ||
            !Number.isFinite(player.exp?.intelligence) || !Number.isFinite(player.skills?.intelligence) ||
            policy.target > 0 && player.skills.intelligence >= policy.target ||
            ns.singularity.isBusy() || !installedIntelligencePackage(ns, request) ||
            !intelligenceFactions(player.factions, ns.singularity.checkFactionInvitations()).length ||
            !intelligenceCallbackFits(ns) || conflicts(ns)) return resume(ns);
        await ns.write(INTELLIGENCE_AUTO, JSON.stringify({ ...request, status: "started", startedAt: Date.now(), consumerPid: ns.pid }), "w");
        const claimed = JSON.parse(ns.read(INTELLIGENCE_AUTO) || "null");
        const currentPolicy = savedIntelligencePolicy(ns);
        if (resetEpoch(ns.getResetInfo()) !== epoch || Date.now() >= request.expiresAt || claimed?.id !== request.id || claimed.status !== "started" ||
            claimed.consumerPid !== ns.pid || readIntelligenceSession(ns) || conflicts(ns) || ns.singularity.isBusy() ||
            !installedIntelligencePackage(ns, request) || !currentPolicy.enabled ||
            currentPolicy.minutes !== policy.minutes || currentPolicy.target !== policy.target) return resume(ns);
        ns.tprint(`Starting automatic INT farming: ${policy.minutes} minutes${policy.target ? ` or INT ${policy.target}` : ""}; supervision resumes afterward`);
        ns.spawn("intelligence-farm.js", { threads: 1, spawnDelay: 0 }, "--start", "--automatic", "--minutes", policy.minutes, "--target", policy.target);
    } catch (error) {
        ns.tprint(`Automatic INT session skipped: ${String(error?.message || error)}`);
        resume(ns);
    }
}

function conflicts(ns) {
    return ns.ps("home").some(process => ["supervisor.js", "augmentation-manager.js", "progression-purchase.js",
        "progression-backdoor.js", "intelligence-farm.js"].includes(process.filename));
}

function resume(ns) {
    if (ns.ps("home").some(process => ["supervisor.js", "intelligence-farm.js"].includes(process.filename))) return;
    if (intelligenceSessionActive(ns)) return;
    try {
        const request = JSON.parse(ns.read(INTELLIGENCE_AUTO) || "null");
        if (request?.status === "started" && ns.ps("home").some(process => process.pid === request.consumerPid &&
            process.pid !== ns.pid && process.filename === "intelligence-handoff.js")) return;
    } catch { /* A corrupt optional request must not prevent supervision. */ }
    ns.spawn("bootstrap.js", { threads: 1, spawnDelay: 0 });
}
