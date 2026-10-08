import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { CLOUD_SERVICES, serviceProcesses, serviceBundle, saveServiceHosts } from "lib/service-hosts.js";
import { starterWorkers } from "lib/starter-pool.js";

/** Copy complete imports before admission. Retry failed copies without launching children. */
export async function prepareCoreHosts(ns, cfg, files = CLOUD_SERVICES) {
    cfg.hostingCopies ||= new Set();
    cfg.hostingBlocked ||= new Set();
    let ready = true;
    for (const file of files) {
        cfg.hostingBlocked.delete(file);
        const host = cfg.serviceHosts?.[file] || "home";
        if (host === "home") continue;
        const key = `${host}:${file}`;
        try {
            if (cfg.hostingCopies.has(key) && ns.getScriptRam(file, host) > 0) continue;
            const bundle = serviceBundle(ns, [file]);
            if (ns.fileExists("data/savings.json", "home")) bundle.push("data/savings.json");
            if (!await ns.scp(bundle, host, "home") || !(ns.getScriptRam(file, host) > 0))
                throw new Error(`Copy or RAM analysis failed on ${host}`);
            cfg.hostingCopies.add(key);
        } catch (error) {
            ready = false;
            cfg.hostingBlocked.add(file);
            cfg.hostingStatus = `${file}: ${String(error?.message || error)}; retry pending`;
        }
    }
    // The daemon reads cash goals for strategy decisions. The fleet additionally
    // refreshes this file itself immediately before any transaction.
    for (const host of new Set(files.map(file => cfg.serviceHosts?.[file]).filter(host => host && host !== "home"))) {
        try {
            if (ns.fileExists("data/savings.json", "home") && !await ns.scp("data/savings.json", host, "home"))
                throw new Error("Savings copy failed");
        } catch (error) {
            ready = false;
            for (const file of files.filter(file => cfg.serviceHosts?.[file] === host)) cfg.hostingBlocked.add(file);
            cfg.hostingStatus = `${host}: ${String(error?.message || error)}; retry pending`;
        }
    }
    return ready;
}

/** Schedule the isolated cloud buyer only when core placement needs extra capacity. */
export async function tickCoreHosting(ns, cfg, hosts, files, keepHomeRam = 0) {
    if (!cfg.cloudServices) return false;
    cfg.hosting ||= {};
    const state = cfg.hosting, now = Date.now(), epoch = resetEpoch(ns.getResetInfo());
    if (cfg.serviceInvestment && now - (state.quotedAt || 0) > 60000) cfg.serviceInvestment = null;
    const port = ns.getPortHandle(PORTS.SERVICE_HOSTING), result = port.peek();
    if (result?.type === "service-hosting-result" && result.version === 1 &&
        result.requestId === state.requestId && result.resetEpoch === epoch &&
        Number.isFinite(result.generatedAt) && result.generatedAt <= now && now - result.generatedAt <= 60000) {
        state.requestId = "";
        cfg.hostingStatus = result.reason;
        state.quotedAt = now;
        cfg.serviceInvestment = result.cost > 0 && result.state === "WAITING" ? {
            target: "services:cloud", amount: result.cost, priority: 90,
            label: `Cloud service RAM${result.ram ? ` (${result.ram} GB)` : ""}`,
            reason: "Start core services without an expensive home RAM upgrade",
        } : null;
        if (result.state === "READY" && result.hosts && files.every(file => typeof result.hosts[file] === "string" &&
            ["home", ...ns.scan("home")].includes(result.hosts[file]) && ns.hasRootAccess(result.hosts[file]))) {
            for (const file of files) {
                const process = serviceProcesses(ns, file)[0];
                if (!process || process.host === result.hosts[file]) continue;
                // The progression reader has no action ownership or transactions.
                // Relocate its unique PID even when adopted from an earlier
                // supervisor, retaining its exact command line and threads.
                const owned = cfg.starterServices?.find(service => service.name === file && service.pid === process.pid);
                if (file !== "progression-manager.js" || !ns.kill(process.pid) && ns.isRunning(process.pid)) {
                    cfg.hostingStatus = `Cannot move ${file}; retaining its current PID and retrying placement`;
                    state.nextCheckAt = now + 15000;
                    return false;
                }
                (cfg.serviceSettings ||= {})[file] = { args: [...process.args], threads: Math.max(1, process.threads || 1) };
                if (owned) { owned.pid = 0; owned.host = result.hosts[file]; owned.state = "WAITING_PRIORITY"; }
            }
            cfg.serviceHosts = Object.fromEntries(files.map(file => [file, result.hosts[file]]));
            await saveServiceHosts(ns, cfg.serviceHosts, cfg.serviceSettings);
            return await prepareCoreHosts(ns, cfg, files);
        }
        state.nextCheckAt = now + (result.state === "UNAVAILABLE" ? 60000 : 15000);
    }
    const neighbours = new Set(["home", ...ns.scan("home")]);
    for (const file of files) {
        const process = serviceProcesses(ns, file)[0];
        if (process) (cfg.serviceHosts ||= {})[file] = process.host;
        else if (cfg.serviceHosts?.[file] && !neighbours.has(cfg.serviceHosts[file])) delete cfg.serviceHosts[file];
    }
    const workerRam = ns.getScriptRam("starter-worker.js", "home");
    const ownedRam = starterWorkers(ns, "home").reduce((n, p) => n + p.threads * workerRam, 0);
    const residentRam = ns.ps("home").filter(p => files.includes(p.filename) ||
        cfg.augmentationActions && p.filename === "augmentation-manager.js")
        .reduce((n, p) => n + ns.getScriptRam(p.filename, "home") * Math.max(1, p.threads || 1), 0);
    const needed = files.filter(file => (cfg.serviceHosts?.[file] || "home") === "home")
        .reduce((n, file) => n + ns.getScriptRam(file, "home"), 0);
    const available = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + ownedRam + residentRam;
    const remoteFits = [...new Set(files.map(file => cfg.serviceHosts?.[file]).filter(host => host && host !== "home"))].every(host => {
        try {
            const required = files.filter(file => cfg.serviceHosts[file] === host).reduce((n, file) => n + ns.getScriptRam(file, "home"), 0);
            const reclaim = ns.ps(host).filter(p => files.includes(p.filename)).reduce((n, p) => n + ns.getScriptRam(p.filename, "home") * Math.max(1, p.threads || 1), 0) +
                starterWorkers(ns, host).reduce((n, p) => n + p.threads * workerRam, 0);
            return ns.hasRootAccess(host) && required <= ns.getServerMaxRam(host) - ns.getServerUsedRam(host) + reclaim;
        } catch { return false; }
    });
    if (needed + keepHomeRam <= available && remoteFits) {
        cfg.serviceInvestment = null;
        return await prepareCoreHosts(ns, cfg, files);
    }
    if (state.requestId) {
        if (now < state.expiresAt && ns.isRunning(state.pid)) return false;
        // The helper can exit before the supervisor's next tick. Allow its
        // result one tick to arrive; never leave an unanswered request invisible.
        if (now < state.createdAt + 5000) return false;
        state.requestId = "";
        cfg.hostingStatus = "Cloud helper returned no usable result; retry pending";
        state.nextCheckAt = now + 15000;
    }
    if (now < (state.nextCheckAt || 0)) return false;
    const helper = "service-cloud.js", cost = ns.getScriptRam(helper, "home");
    if (!(cost > 0) || !epoch) { cfg.hostingStatus = "Missing service-cloud.js or invalid reset information"; return false; }
    const options = hosts.filter(host => ns.hasRootAccess(host)).map(host => {
        const owned = starterWorkers(ns, host), free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        return { host, owned, free, reclaim: owned.reduce((n, p) => n + workerRam * p.threads, 0) };
    }).filter(o => o.free + o.reclaim >= cost)
        .sort((a, b) => Number(b.free >= cost) - Number(a.free >= cost) || a.reclaim - b.reclaim);
    for (const { host, owned } of options) {
        try {
            if (host !== "home" && !await ns.scp(serviceBundle(ns, [helper]), host, "home")) continue;
            if (ns.getServerMaxRam(host) - ns.getServerUsedRam(host) < cost) for (const process of owned) ns.kill(process.pid);
            if (ns.getServerMaxRam(host) - ns.getServerUsedRam(host) < cost) continue;
            const request = { type: "service-hosting-request", version: 1, requestId: `${ns.pid}:${now}`,
                ownerPid: ns.pid, resetEpoch: epoch, createdAt: now, expiresAt: now + 60000,
                services: files, keepHomeRam, reclaimAugmentation: Boolean(cfg.augmentationActions),
                movablePids: files.includes("progression-manager.js") ? serviceProcesses(ns, "progression-manager.js").map(process => process.pid) : [] };
            port.clear(); port.write(request);
            const pid = ns.exec(helper, host, 1, JSON.stringify(request));
            Object.assign(state, { requestId: pid ? request.requestId : "", pid,
                createdAt: now, expiresAt: request.expiresAt, nextCheckAt: now + 15000 });
            cfg.hostingStatus = pid ? `Checking cloud service placement on ${host}` : "Cloud helper launch failed; retry pending";
            return false;
        } catch (error) { cfg.hostingStatus = String(error?.message || error); }
    }
    cfg.hostingStatus = `Waiting for ${cost.toFixed(2)} GB helper space on a rooted server`;
    state.nextCheckAt = now + 15000;
    return false;
}
