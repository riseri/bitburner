import { INTELLIGENCE_SESSION, readIntelligenceSession, intelligenceMetrics, intelligenceAvailable, intelligenceFactions } from "lib/intelligence-session.js";
import { singularityAvailable } from "lib/progression-protocol.js";
import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

const SCRIPT = "intelligence-farm.js";
const CONFIG = "data/supervisor-bootstrap.json";

/** Bounded join/reset session in any BitNode with Singularity and INT access. @param {NS} ns */
export async function main(ns) {
    const f = ns.flags([["start", false], ["stop", false], ["minutes", 10], ["target", 0], ["automatic", false]]);
    if (ns.getHostname() !== "home") throw new Error(`Run ${SCRIPT} on home`);
    let session = readIntelligenceSession(ns);
    if (f.stop) {
        if (session) await finish(ns, session, "Stopped manually", false);
        if (!session?.automatic) ns.tprint("INT farming stopped. Run bootstrap.js to resume the supervisor.");
        return;
    }
    if (ns.ps("home").some(p => p.filename === SCRIPT && p.pid !== ns.pid)) throw new Error("An INT farmer is already running");
    const reset = ns.getResetInfo(), player = ns.getPlayer();
    const unavailable = !singularityAvailable(reset) ? "INT farming needs Singularity access: BitNode 4 or Source-File 4"
        : !intelligenceAvailable(reset) ? "INT farming needs Intelligence unlocked: BitNode 5 or Source-File 5" : "";
    if (unavailable) {
        if (session?.active) await finish(ns, session, unavailable, false);
        else { ns.tprint(unavailable); if (f.automatic) ns.spawn("bootstrap.js", { threads: 1, spawnDelay: 0 }); }
        return;
    }
    if (!Number.isFinite(player.exp?.intelligence) || !Number.isFinite(player.skills?.intelligence)) {
        if (session?.automatic) return finish(ns, session, "INT stats unavailable", false);
        if (!f.automatic) throw new Error("INT stats unavailable");
        ns.tprint("INT stats unavailable; resuming supervision");
        ns.spawn("bootstrap.js", { threads: 1, spawnDelay: 0 }); return;
    }
    if (f.start) {
        const minutes = Number(f.minutes), target = Number(f.target);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 || !Number.isFinite(target) || target < 0) {
            throw new Error("Use --minutes in (0, 60] and a positive --target INT level, or 0 for time only");
        }
        if (session?.active && session.deadline > Date.now()) throw new Error("A session is active; use --stop before starting another");
        session = { version: 2, active: true, node: reset.currentNode, nodeReset: reset.lastNodeReset,
            startedAt: Date.now(), deadline: Date.now() + minutes * 60000, target,
            startExp: player.exp.intelligence, startInt: player.skills.intelligence, resets: 0, joins: 0, factions: [],
            automatic: Boolean(f.automatic),
            lastAugReset: reset.lastAugReset, awaitingReset: false };
    } else if (!session?.active) {
        ns.tprint(session ? JSON.stringify({ reason: session.reason, ...intelligenceMetrics(session, player) })
            : "Complete one infiltration for a Shadows of Anarchy invitation, or unlock a corporate faction. Then run intelligence-farm.js --start --minutes 10 (optional --target INT). Each cycle resets cash, faction reputation, normal skills, servers and scripts.");
        return;
    }
    try { await cycle(ns, session, reset, player, Boolean(f.start)); }
    catch (error) { await finish(ns, session, `INT farming failed: ${String(error?.message || error)}`, false); }
}

async function cycle(ns, session, reset, player, starting) {
    if (!starting && session.awaitingReset) {
        if (!(reset.lastAugReset > session.lastAugReset)) return finish(ns, session, "Reset did not complete; stopping", false);
        session.resets++;
        session.awaitingReset = false;
    }
    session.joins ??= 0;
    const limit = limitReason(session, player);
    if (limit) return finish(ns, session, limit, true);
    const conflicts = ns.ps("home").filter(p => ["supervisor.js", "augmentation-manager.js", "progression-purchase.js", "progression-backdoor.js"].includes(p.filename));
    if (conflicts.length) return finish(ns, session, `Stop these before farming: ${conflicts.map(p => p.filename).join(", ")}`, false);
    if (ns.singularity.isBusy()) return finish(ns, session, "Finish or stop current player activity before farming", false);
    const installed = ns.singularity.getOwnedAugmentations(false), owned = ns.singularity.getOwnedAugmentations(true);
    if (owned.length > installed.length) return finish(ns, session, "Install queued augmentations before farming", false);
    if (installed.includes("The Red Pill")) return finish(ns, session, "The Red Pill is installed; finish this node first", false);
    const maxRam = ns.getServerMaxRam("home");
    for (const file of [SCRIPT, "bootstrap.js", "supervisor.js"]) {
        if (!ns.fileExists(file, "home") || !(ns.getScriptRam(file, "home") > 0)) return finish(ns, session, `Missing script/import: ${file}`, false);
        if (ns.getScriptRam(file, "home") > maxRam) return finish(ns, session, `Home RAM cannot run the reset callback: ${file}`, false);
    }
    try { restoreSupervisorArgs(ns.read(CONFIG)); }
    catch { return finish(ns, session, "Start supervisor.js once to save valid restart settings, then stop it before farming", false); }
    const invitations = ns.singularity.checkFactionInvitations(), members = new Set(ns.getPlayer().factions);
    session.factions = intelligenceFactions([...members], invitations);
    if (!session.factions.length) return finish(ns, session, "No persistent faction available; complete one infiltration for Shadows of Anarchy or unlock a corporate faction", false);
    let joined = 0;
    for (const faction of session.factions) {
        const limit = limitReason(session, ns.getPlayer());
        if (limit) return finish(ns, session, limit, true);
        if (members.has(faction)) continue;
        const before = ns.getPlayer().exp.intelligence;
        if (!ns.singularity.joinFaction(faction)) return finish(ns, session, `Faction join failed: ${faction}; stopping`, false);
        if (!(ns.getPlayer().exp.intelligence > before)) return finish(ns, session, `No measured INT XP from joining ${faction}; stopping`, false);
        session.joins++;
        joined++;
    }
    // An existing member needs one reset to regain its invitation. Later cycles
    // must actually produce XP, even if a faction stops preserving invitations.
    if (!joined && session.resets > 0) return finish(ns, session, "No productive faction joins after reset; stopping", false);
    // A stop command can arrive while an asynchronous file write is pending.
    await save(ns, session);
    const saved = readIntelligenceSession(ns);
    if (!saved?.active) return;
    const reached = limitReason(session, ns.getPlayer());
    if (reached) return finish(ns, session, reached, true);
    session.awaitingReset = true;
    session.lastAugReset = reset.lastAugReset;
    session.metrics = intelligenceMetrics(session, ns.getPlayer());
    const report = !Number.isFinite(session.lastReportAt) || Date.now() - session.lastReportAt >= 10000;
    if (report) session.lastReportAt = Date.now();
    await save(ns, session);
    if (!readIntelligenceSession(ns)?.active) return;
    const finalLimit = limitReason(session, ns.getPlayer());
    if (finalLimit) return finish(ns, session, finalLimit, true);
    if (report) ns.tprint(`INT ${session.metrics.intelligence} | +${session.metrics.gained.toFixed(2)} XP | ${session.metrics.xpPerHour.toFixed(1)} XP/hour | ${session.factions.length} factions | joins ${session.joins} | resets ${session.resets}`);
    try {
        if (ns.singularity.softReset(SCRIPT) === false) return finish(ns, session, "Soft reset failed", false);
    } catch (error) { return finish(ns, session, `Soft reset failed: ${String(error.message || error)}`, false); }
}

function limitReason(session, player) {
    if (session.target > 0 && player.skills.intelligence >= session.target) return "Target reached";
    return Date.now() >= session.deadline ? "Time budget reached" : "";
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
    if (resume || session.automatic) ns.spawn("bootstrap.js", { threads: 1, spawnDelay: 0 });
}
