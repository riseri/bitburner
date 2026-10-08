import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";

const HORIZON_MS = 900_000;

// Keep analysis APIs in this short-lived helper, outside the 8 GB supervisor.
/** @param {NS} ns */
export async function main(ns) {
    let request;
    try { request = JSON.parse(String(ns.args[0])); } catch { return; }
    const port = ns.getPortHandle(PORTS.STARTER_TARGET), now = Date.now();
    if (request?.type !== "starter-target-request" || request.version !== 1 ||
        !Array.isArray(request.hosts) || !(request.threads > 0) || !request.resetEpoch ||
        !Number.isFinite(request.createdAt) || !Number.isFinite(request.expiresAt) ||
        request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > 15000 ||
        request.resetEpoch !== resetEpoch(ns.getResetInfo()) ||
        now < request.createdAt || now >= request.expiresAt ||
        port.peek()?.requestId !== request.requestId || !ns.isRunning(request.ownerPid)) return;
    const candidates = [];
    let level, mults, error = "";
    try { level = ns.getHackingLevel(); mults = ns.getHackingMultipliers(); }
    catch (failure) { error = String(failure?.message || failure); }
    for (const host of request.hosts) {
        if (host === "home") continue;
        try {
            const server = ns.getServer(host);
            if (!server.hasAdminRights || !(server.moneyMax > 0) || server.requiredHackingSkill > level) continue;
            const analysis = {};
            // Use the game's actual hack/growth multipliers when available.
            // Common money modifiers also change the relative grow/repair cost,
            // so omitting them can incorrectly favour high-growth n00dles.
            if (typeof ns.hackAnalyze === "function" && server.hackDifficulty < 100)
                analysis.fraction = ns.hackAnalyze(host) * (100 - server.minDifficulty) / (100 - server.hackDifficulty);
            if (typeof ns.growthAnalyze === "function") {
                const liveLog = Math.min(Math.log1p(.03 / server.hackDifficulty), Math.log1p(.0035));
                const preparedLog = Math.min(Math.log1p(.03 / server.minDifficulty), Math.log1p(.0035));
                analysis.growthLog = Math.log1p(.01) / ns.growthAnalyze(host, 1.01, 1) * preparedLog / liveLog;
            }
            const candidate = starterCandidate(server, level, ns.getHackTime(host), request.threads, mults, analysis);
            if (candidate) candidates.push({ target: host, ...candidate });
        } catch (failure) { error ||= String(failure?.message || failure); }
    }
    const current = candidates.find(candidate => candidate.target === request.target);
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    // Compare against the incumbent's steady score: temporary grow/weaken debt
    // must not cause the pool to abandon a target it is already preparing.
    const chosen = best && (!current || best.target === current.target || best.score > current.steady * 1.25)
        ? best : current;
    if (Date.now() >= request.expiresAt || port.peek()?.requestId !== request.requestId ||
        request.resetEpoch !== resetEpoch(ns.getResetInfo()) || !ns.isRunning(request.ownerPid)) return;
    const alternative = candidates.find(candidate => candidate.target !== (chosen?.target || request.target));
    const reason = !chosen ? error ? `Analysis failed: ${error}` : "No eligible money targets; keeping current workers"
        : chosen.target !== request.target ? `Selected ${chosen.target}; estimated prep ${Math.ceil(chosen.prepMs / 60000)} min`
        : alternative ? `Keeping ${chosen.target}; best alternative ${alternative.target} needs ~${Math.ceil(alternative.prepMs / 60000)} min prep or lacks a 25% gain`
        : `Keeping ${chosen.target}; no better rooted, hackable target`;
    port.clear();
    port.write({ type: "starter-target-result", version: 1, requestId: request.requestId,
        resetEpoch: request.resetEpoch, generatedAt: Date.now(), candidates: candidates.length, reason, ...(chosen || {}) });
}

/** Relative income estimate, including repair and initial preparation costs. */
export function starterCandidate(server, level, liveHackMs, threads, mults = {}, analysis = {}) {
    const maxMoney = Number(server.moneyMax), required = Number(server.requiredHackingSkill);
    const min = Number(server.minDifficulty), security = Number(server.hackDifficulty);
    const growth = Number(server.serverGrowth), money = Number(server.moneyAvailable);
    if (!server.hasAdminRights || !(maxMoney > 0) || !(required <= level) || !(level > 0) ||
        !(min >= 1 && min < 100) || !(security >= min) || !(growth > 0) ||
        !(liveHackMs > 0) || !(threads > 0) ||
        ![maxMoney, required, min, security, growth, money, liveHackMs, threads].every(Number.isFinite)) return null;
    const difficulty = (100 - min) / 100;
    const chance = Math.max(0, Math.min(1, (1 - required / (1.75 * level)) * difficulty * (mults.chance || 1)));
    const fraction = Math.min(.90, Number.isFinite(analysis.fraction) && analysis.fraction > 0 ? analysis.fraction
        : difficulty * (level - required + 1) / level * (mults.money || 1) / 240);
    const growthLog = Number.isFinite(analysis.growthLog) && analysis.growthLog > 0 ? analysis.growthLog
        : Math.min(Math.log1p(.03 / min), Math.log1p(.0035)) * growth / 100 * (mults.growth || 1);
    const hackMs = liveHackMs * (500 + 2.5 * required * min) / (500 + 2.5 * required * security);
    const growPerHack = -Math.log1p(-fraction * chance) / growthLog;
    const weakenPerHack = (.002 + .004 * growPerHack) / .05;
    // This remains a relative ranking heuristic, not a measured dollar rate.
    const steady = maxMoney * fraction * chance / (hackMs * (1 + 3.2 * growPerHack + 4 * weakenPerHack));
    const growThreads = Math.max(0, Math.log(Math.max(1, maxMoney * .90 / Math.max(1, money))) / growthLog);
    const weakenWaves = security > min + 3 ? Math.ceil((security - min) / (.05 * threads)) : 0;
    const growWaves = Math.ceil(growThreads / threads);
    const repairWaves = growThreads * .004 > 3 ? Math.ceil(growThreads * .004 / (.05 * threads)) : 0;
    const prepMs = weakenWaves * liveHackMs * 4 + (growWaves * 3.2 + repairWaves * 4) * hackMs;
    // Amortize preparation instead of zeroing every target beyond ten minutes.
    // Retain a bounded maximum so hours of repair cannot hijack starter income.
    const score = prepMs > HORIZON_MS * 2 ? 0 : steady / (1 + prepMs / HORIZON_MS);
    if (![steady, score, prepMs].every(Number.isFinite) || !(steady > 0)) return null;
    return { score, steady, prepMs, cycleMs: hackMs * 4 };
}
