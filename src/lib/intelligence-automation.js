import { INTELLIGENCE_AUTO, readIntelligenceSession, intelligenceAvailable, intelligenceFactions, intelligencePolicy, automaticIntelligenceEnabled } from "lib/intelligence-session.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";
import { supervisorServiceConfig } from "lib/service-catalog.js";

export const INTELLIGENCE_HANDOFF = "intelligence-handoff.js";
const CONFIG = "data/supervisor-bootstrap.json";
const NEUROFLUX = "NeuroFlux Governor";

export function savedIntelligencePolicy(ns) {
    const cfg = supervisorServiceConfig(restoreSupervisorArgs(ns.read(CONFIG)));
    return { ...intelligencePolicy(cfg), enabled: automaticIntelligenceEnabled(cfg) };
}

export function intelligenceAttempted(ns) {
    if (readIntelligenceSession(ns)) return true;
    const reset = ns.getResetInfo(), prior = JSON.parse(ns.read(INTELLIGENCE_AUTO) || "null");
    return Boolean(prior?.nodeReset === reset.lastNodeReset && (prior.node == null || prior.node === reset.currentNode) &&
        (prior.version !== 2 || prior.status === "started"));
}

export function intelligenceCallbackFits(ns) {
    return [INTELLIGENCE_HANDOFF, "intelligence-farm.js", "bootstrap.js", "supervisor.js"].every(file => {
        const ram = ns.getScriptRam(file, "home");
        return ns.fileExists(file, "home") && ram > 0 && ram <= ns.getServerMaxRam("home");
    });
}

// Arm only a real augmentation installation. The callback checks that those
// augmentations are installed before it can start the one node-scoped budget.
export async function prepareIntelligenceInstallation(ns, cfg, epoch) {
    try {
        const reset = ns.getResetInfo();
        if (!cfg.route || !cfg.joinFactions || cfg.intelligence === false || !singularityAvailable(reset) ||
            !intelligenceAvailable(reset) || resetEpoch(reset) !== epoch || intelligenceAttempted(ns)) return "bootstrap.js";
        // The saved supervisor policy also governs already-adopted managers.
        const policy = savedIntelligencePolicy(ns), player = ns.getPlayer();
        if (!policy.enabled || !Number.isFinite(player.skills?.intelligence) ||
            policy.target > 0 && player.skills.intelligence >= policy.target) return "bootstrap.js";
        const installed = ns.singularity.getOwnedAugmentations(false), expected = ns.singularity.getOwnedAugmentations(true);
        if (expected.length <= installed.length || expected.includes("The Red Pill") ||
            !intelligenceFactions(player.factions, ns.singularity.checkFactionInvitations()).length || !intelligenceCallbackFits(ns)) return "bootstrap.js";
        // NeuroFlux purchases merge into one installed entry; verify its level,
        // rather than requiring duplicate names to survive the installation.
        const queuedNeuroflux = expected.filter(name => name === NEUROFLUX).length - installed.filter(name => name === NEUROFLUX).length;
        const neurofluxLevel = Number(reset.ownedAugs?.get?.(NEUROFLUX) ?? 0) + queuedNeuroflux;
        const request = { version: 2, status: "pending", node: reset.currentNode, nodeReset: reset.lastNodeReset,
            sourceAugReset: reset.lastAugReset, sourceEpoch: epoch, createdAt: Date.now(), expiresAt: Date.now() + 30000,
            id: `${epoch}:${ns.pid}:${Date.now()}`, expected: [...new Set(expected)], neurofluxLevel, policy };
        await ns.write(INTELLIGENCE_AUTO, JSON.stringify(request), "w");
        return INTELLIGENCE_HANDOFF;
    } catch (error) {
        ns.print?.(`INT session skipped before installation: ${String(error?.message || error)}`);
        return "bootstrap.js";
    }
}

export function readIntelligenceRequest(ns) {
    const request = JSON.parse(ns.read(INTELLIGENCE_AUTO) || "null"), reset = ns.getResetInfo(), now = Date.now();
    if (request?.version !== 2 || request.status !== "pending" || typeof request.id !== "string" || !request.id ||
        request.node !== reset.currentNode || request.nodeReset !== reset.lastNodeReset ||
        !Number.isFinite(request.sourceAugReset) || request.sourceEpoch !== `${request.node}:${request.nodeReset}:${request.sourceAugReset}` ||
        !Number.isFinite(request.createdAt) || !Number.isFinite(request.expiresAt) ||
        request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > 30000 ||
        now < request.createdAt || now >= request.expiresAt || reset.lastAugReset < request.createdAt ||
        reset.lastAugReset <= request.sourceAugReset || !Array.isArray(request.expected) || !request.expected.length ||
        !request.expected.every(name => typeof name === "string" && name.length > 0) || request.expected.includes("The Red Pill") ||
        !Number.isSafeInteger(request.neurofluxLevel) || request.neurofluxLevel < 0 ||
        !request.policy?.enabled) return null;
    intelligencePolicy({ intelligenceMinutes: request.policy.minutes, intelligenceTarget: request.policy.target });
    return request;
}

export function installedIntelligencePackage(ns, request) {
    const installed = ns.singularity.getOwnedAugmentations(false), owned = ns.singularity.getOwnedAugmentations(true);
    if (owned.length !== installed.length || owned.includes("The Red Pill")) return false;
    if (request.neurofluxLevel > 0 && Number(ns.getResetInfo().ownedAugs?.get?.(NEUROFLUX) ?? 0) < request.neurofluxLevel) return false;
    return request.expected.every(name => installed.includes(name));
}
