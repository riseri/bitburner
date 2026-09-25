const HOME = "home", WORKER = "starter-worker.js", TARGET = "n00dles";
const OWNER = "supervisor-starter-v1";

// A stable marker permits adoption after supervisor restarts without touching
// manually launched workers on other targets or other scripts using the host.
export function starterWorkers(ns, host) {
    return ns.ps(host).filter(process => process.filename === WORKER &&
        process.args[0] === TARGET && (process.args[1] === OWNER ||
            (host === HOME && process.args.length === 1)));
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
export async function tickStarterPool(ns, hosts, copied = new Set()) {
    const rooted = rootStarterHost(ns, TARGET);
    const ram = ns.getScriptRam(WORKER, HOME);
    let threads = 0, workers = 0, failures = 0;
    if (!rooted || !(ram > 0)) return { rooted, threads, workers, failures };
    for (const host of hosts) {
        if (!rootStarterHost(ns, host)) continue;
        const maxRam = ns.getServerMaxRam(host);
        if (maxRam < ram) continue;
        const current = starterWorkers(ns, host);
        const used = current.reduce((sum, process) => sum + ram * process.threads, 0);
        const foreignRam = Math.max(0, ns.getServerUsedRam(host) - used);
        const desired = Math.max(0, Math.floor((maxRam - foreignRam) / ram));
        if (current.length === 1 && current[0].threads === desired) {
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
        const pid = host === HOME ? ns.run(WORKER, desired, TARGET, OWNER)
            : ns.exec(WORKER, host, desired, TARGET, OWNER);
        if (pid) { threads += desired; workers++; }
        else { copied.delete(host); failures++; }
    }
    return { rooted, threads, workers, failures };
}
