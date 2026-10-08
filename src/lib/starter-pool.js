import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";

const HOME = "home", WORKER = "starter-worker.js", TARGET = "n00dles", SELECTOR = "starter-target.js";
const OWNER = "supervisor-starter-v1";

// A stable marker permits adoption after supervisor restarts without touching
// manually launched workers on other targets or other scripts using the host.
export function starterWorkers(ns, host) {
    return ns.ps(host).filter(process => process.filename === WORKER &&
        (process.args[1] === OWNER ||
            (host === HOME && process.args[0] === TARGET && process.args.length === 1)));
}

export function starterHosts(ns) {
    const hosts = [HOME], seen = new Set(hosts);
    for (let i = 0; i < hosts.length; i++) {
        for (const next of ns.scan(hosts[i])) {
            if (!seen.has(next)) { seen.add(next); hosts.push(next); }
        }
    }
    return hosts;
}

function rootStarterHost(ns, host) {
    if (ns.hasRootAccess(host)) return true;
    for (const [file, open] of [
        ["BruteSSH.exe", () => ns.brutessh(host)],
        ["FTPCrack.exe", () => ns.ftpcrack(host)],
        ["relaySMTP.exe", () => ns.relaysmtp(host)],
        ["HTTPWorm.exe", () => ns.httpworm(host)],
        ["SQLInject.exe", () => ns.sqlinject(host)],
    ]) {
        if (ns.fileExists(file, HOME)) {
            try { open(); } catch { /* Other hosts can still earn. */ }
        }
    }
    try { ns.nuke(host); } catch { /* More port-opening programs may be needed. */ }
    return ns.hasRootAccess(host);
}

export function stopStarterPool(ns, hosts) {
    let remaining = 0;
    for (const host of hosts) {
        for (const process of starterWorkers(ns, host)) ns.kill(process.pid);
        remaining += starterWorkers(ns, host).length;
    }
    return remaining === 0;
}

/** Deploy only into free RAM; retain running actions unless their allocation changes. */
export async function tickStarterPool(ns, hosts, copied = new Set(), state = {}) {
    if (!state.target) {
        const targets = new Map();
        for (const host of hosts) for (const process of starterWorkers(ns, host))
            targets.set(process.args[0], (targets.get(process.args[0]) || 0) + process.threads);
        state.target = [...targets].sort((a, b) => b[1] - a[1])[0]?.[0] || TARGET;
    }
    const ram = ns.getScriptRam(WORKER, HOME);
    let threads = 0, workers = 0, failures = 0;
    const rootedHosts = hosts.filter(host => rootStarterHost(ns, host));
    const capacity = ram > 0 ? rootedHosts.reduce((sum, host) => {
        const owned = starterWorkers(ns, host).reduce((n, process) => n + ram * process.threads, 0);
        return sum + Math.max(0, Math.floor((ns.getServerMaxRam(host) - ns.getServerUsedRam(host) + owned) / ram));
    }, 0) : 0;
    await tickStarterTarget(ns, rootedHosts, state, capacity);
    const target = state.target, rooted = rootStarterHost(ns, target);
    if (!rooted || !(ram > 0)) return { rooted, threads, workers, failures, target };
    for (const host of rootedHosts) {
        const maxRam = ns.getServerMaxRam(host);
        if (maxRam < ram) continue;
        const current = starterWorkers(ns, host);
        const used = current.reduce((sum, process) => sum + ram * process.threads, 0);
        const foreignRam = Math.max(0, ns.getServerUsedRam(host) - used);
        const desired = Math.max(0, Math.floor((maxRam - foreignRam) / ram));
        if (current.length === 1 && current[0].threads === desired && current[0].args[0] === target) {
            threads += desired; workers++; continue;
        }
        let stopped = true;
        for (const process of current) if (!ns.kill(process.pid)) stopped = false;
        if (!stopped) { failures++; continue; }
        if (!desired) continue;
        if (host !== HOME && !copied.has(host)) {
            if (!await ns.scp(WORKER, host, HOME)) { failures++; continue; }
            copied.add(host);
        }
        const pid = host === HOME ? ns.run(WORKER, desired, target, OWNER)
            : ns.exec(WORKER, host, desired, target, OWNER);
        if (pid) { threads += desired; workers++; }
        else { copied.delete(host); failures++; }
    }
    return { rooted, threads, workers, failures, target };
}

async function tickStarterTarget(ns, hosts, state, threads) {
    const cost = ns.getScriptRam(SELECTOR, HOME), now = Date.now();
    if (!(cost > 0)) { state.targetStatus = "Missing starter-target.js or RAM analysis failed"; return; }
    if (!threads || typeof ns.getPortHandle !== "function") return;
    const epoch = resetEpoch(ns.getResetInfo());
    if (!epoch) return;
    const port = ns.getPortHandle(PORTS.STARTER_TARGET), result = port.peek();
    if (result?.type === "starter-target-result" && result.version === 1 &&
        result.requestId === state.targetRequestId && result.resetEpoch === epoch &&
        Number.isFinite(result.generatedAt) && result.generatedAt <= now && now - result.generatedAt < 15000 &&
        typeof result.reason === "string") {
        state.targetStatus = result.reason;
        if (hosts.includes(result.target) && ns.hasRootAccess(result.target) &&
            Number.isFinite(result.prepMs) && result.prepMs >= 0 && Number.isFinite(result.cycleMs) && result.cycleMs > 0 &&
            result.target !== state.target) {
            state.target = result.target;
            state.nextTargetAt = now + Math.max(120000, result.prepMs + result.cycleMs);
        }
        state.targetRequestId = "";
    }
    if (state.targetRequestId && now >= state.targetRequestedAt + 15000) {
        state.targetStatus = "Target helper returned no usable result; retry pending";
        state.targetRequestId = "";
        state.nextTargetAt = now + 15000;
    }
    if (now < (state.nextTargetAt || 0) || hosts.some(host => ns.ps(host).some(p => p.filename === SELECTOR))) return;
    // Prefer spare RAM, then the smallest reclaimable worker allocation. Target
    // checks cannot displace services, manual workers, or the home upgrade actor.
    const options = hosts.map(host => {
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host), owned = starterWorkers(ns, host);
        const reclaim = owned.reduce((sum, process) => sum + process.threads * ns.getScriptRam(WORKER, HOME), 0);
        return { host, free, owned, reclaim };
    }).filter(option => option.free + option.reclaim >= cost)
        .sort((a, b) => Number(b.free >= cost) - Number(a.free >= cost) || a.reclaim - b.reclaim);
    for (const { host, owned } of options) {
        if (host !== HOME && !await ns.scp([SELECTOR, "lib/ports.js", "lib/progression-protocol.js", "lib/programs.js"], host, HOME)) continue;
        if (ns.getServerMaxRam(host) - ns.getServerUsedRam(host) < cost) {
            for (const process of owned) ns.kill(process.pid);
        }
        if (ns.getServerMaxRam(host) - ns.getServerUsedRam(host) < cost) continue;
        const request = { type: "starter-target-request", version: 1, requestId: `${ns.pid}:${now}`,
            ownerPid: ns.pid, resetEpoch: epoch, createdAt: now, expiresAt: now + 15000,
            hosts, threads, target: state.target };
        port.clear(); port.write(request);
        const pid = ns.exec(SELECTOR, host, 1, JSON.stringify(request));
        state.targetRequestId = pid ? request.requestId : "";
        state.targetRequestedAt = now;
        state.targetStatus = pid ? `Analyzing rooted targets on ${host}` : "Target helper launch failed; retry pending";
        state.nextTargetAt = now + (pid ? 60000 : 15000);
        return;
    }
    state.targetStatus = `Waiting for ${cost.toFixed(2)} GB to analyze targets`;
}
