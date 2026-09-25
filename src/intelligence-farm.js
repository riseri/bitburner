import { INTELLIGENCE_SESSION, readIntelligenceSession, intelligenceMetrics } from "lib/intelligence-session.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

const FACTION = "Shadows of Anarchy", SCRIPT = "intelligence-farm.js";
const CONFIG = "data/supervisor-bootstrap.json";

/** Explicit, bounded BN4 join/reset session. No supervisor starts this automatically. @param {NS} ns */
export async function main(ns) {
    const f = ns.flags([["start", false], ["stop", false], ["minutes", 10], ["target", 50]]);
    if (ns.getHostname() !== "home") throw new Error(`Run ${SCRIPT} on home`);
    let session = readIntelligenceSession(ns);
    if (f.stop) {
        if (session) { session.active = false; session.reason = "Stopped manually"; await save(ns, session); }
        ns.tprint("INT farming stopped. Run bootstrap.js to resume the supervisor.");
        return;
    }
    if (ns.ps("home").some(p => p.filename === SCRIPT && p.pid !== ns.pid)) throw new Error("An INT farmer is already running");
    const reset = ns.getResetInfo(), player = ns.getPlayer();
    if (reset.currentNode !== 4 || !(reset.ownedSF?.get(5) > 0)) {
        ns.tprint("INT reset farming requires BitNode 4 and completed Source-File 5. Finish BN5.1 first."); return;
    }
    if (f.start) {
        const minutes = Number(f.minutes), target = Number(f.target);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 || !Number.isFinite(target) || target < 1) {
            throw new Error("Use --minutes in (0, 60] and a positive --target INT level");
        }
        if (session?.active && session.deadline > Date.now()) throw new Error("A session is active; use --stop before starting another");
        session = { version: 1, active: true, node: reset.currentNode, nodeReset: reset.lastNodeReset,
            startedAt: Date.now(), deadline: Date.now() + minutes * 60000, target,
            startExp: player.exp.intelligence, startInt: player.skills.intelligence, resets: 0,
            lastAugReset: reset.lastAugReset, awaitingReset: false };
    } else if (!session?.active) {
        ns.tprint(session ? JSON.stringify({ reason: session.reason, ...intelligenceMetrics(session, player) })
            : "Complete one infiltration for a Shadows of Anarchy invitation. Then run intelligence-farm.js --start --minutes 10 --target 50. Each cycle resets cash, faction reputation, normal skills, servers and scripts.");
        return;
    }
    if (!Number.isFinite(player.exp?.intelligence) || !Number.isFinite(player.skills?.intelligence)) throw new Error("INT stats unavailable");
    if (!f.start && session.awaitingReset) {
        if (reset.lastAugReset === session.lastAugReset) return finish(ns, session, "Reset did not complete; stopping", false);
        session.resets++;
        session.awaitingReset = false;
    }
    if (player.skills.intelligence >= session.target || Date.now() >= session.deadline) {
        return finish(ns, session, player.skills.intelligence >= session.target ? "Target reached" : "Time budget reached", true);
    }
    const conflicts = ns.ps("home").filter(p => ["supervisor.js", "augmentation-manager.js", "progression-purchase.js", "progression-backdoor.js"].includes(p.filename));
    if (conflicts.length) return finish(ns, session, `Stop these before farming: ${conflicts.map(p => p.filename).join(", ")}`, false);
    if (ns.singularity.isBusy()) return finish(ns, session, "Finish or stop current player activity before farming", false);
    const installed = ns.singularity.getOwnedAugmentations(false), owned = ns.singularity.getOwnedAugmentations(true);
    if (owned.length > installed.length) return finish(ns, session, "Install queued augmentations before farming", false);
    if (installed.includes("The Red Pill")) return finish(ns, session, "The Red Pill is installed; finish this node first", false);
    for (const file of [SCRIPT, "bootstrap.js", "supervisor.js"]) {
        if (!ns.fileExists(file, "home") || !(ns.getScriptRam(file, "home") > 0)) return finish(ns, session, `Missing script/import: ${file}`, false);
    }
    if (ns.getScriptRam(SCRIPT, "home") > ns.getServerMaxRam("home")) return finish(ns, session, "Home RAM cannot run the reset callback", false);
    try { restoreSupervisorArgs(ns.read(CONFIG)); }
    catch { return finish(ns, session, "Start supervisor.js once to save valid restart settings, then stop it before farming", false); }
    const member = player.factions.includes(FACTION);
    if (!member) {
        if (!ns.singularity.checkFactionInvitations().includes(FACTION)) return finish(ns, session, "Complete one infiltration to obtain the Shadows of Anarchy invitation", false);
        if (!ns.singularity.joinFaction(FACTION)) return finish(ns, session, "Faction join failed; stopping", false);
        if (!(ns.getPlayer().exp.intelligence > player.exp.intelligence)) return finish(ns, session, "No measured INT XP from joining; stopping", false);
    }
    // A stop command can arrive while an asynchronous file write is pending.
    await save(ns, session);
    const saved = readIntelligenceSession(ns);
    if (!saved?.active) return;
    if (ns.getPlayer().skills.intelligence >= session.target || Date.now() >= session.deadline) return finish(ns, session, "Session limit reached", true);
    session.awaitingReset = true;
    session.lastAugReset = reset.lastAugReset;
    session.metrics = intelligenceMetrics(session, ns.getPlayer());
    await save(ns, session);
    if (!readIntelligenceSession(ns)?.active) return;
    ns.tprint(`INT ${session.metrics.intelligence} | +${session.metrics.gained.toFixed(2)} XP | ${session.metrics.xpPerHour.toFixed(1)} XP/hour | resets ${session.resets}`);
    try {
        if (ns.singularity.softReset(SCRIPT) === false) return finish(ns, session, "Soft reset failed", false);
    } catch (error) { return finish(ns, session, `Soft reset failed: ${String(error.message || error)}`, false); }
}

async function save(ns, session) {
    await ns.write(INTELLIGENCE_SESSION, JSON.stringify(session), "w");
}

async function finish(ns, session, reason, resume) {
    session.active = false;
    session.reason = reason;
    session.metrics = intelligenceMetrics(session, ns.getPlayer());
    await save(ns, session);
    ns.tprint(`${reason}. ${JSON.stringify(session.metrics)}`);
    if (resume) ns.spawn("bootstrap.js", { threads: 1, spawnDelay: 0 });
}
