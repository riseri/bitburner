import { PORTS } from "lib/ports.js";
import { homeShareRam, reclaimHomeShare } from "lib/home-share.js";
import { HOME_MAX_CORES, homeCoreBonus } from "lib/home-mechanics.js";
// Home lends only G/W capacity. It never joins network.hosts.

export function gwHosts(hosts, cfg = {}) {
    return [...hosts.filter(h => h.name !== "home"), ...(cfg.homeGw?.host ? [cfg.homeGw.host] : [])];
}

export function homeProtectedRam(cfg) {
    return Math.max(0, cfg.homeReserve || 0, cfg.homeGw?.criticalReserve || 0) + (cfg.homeGw?.requiredShareRam || 0);
}

export function readHomePolicy(ns, cfg) {
    try {
        const p = ns.getPortHandle(PORTS.HOME_CAPACITY).peek(), now = Date.now();
        if (p?.type === "home-capacity-policy" && Number.isFinite(p.reserve) && p.reserve >= 0 &&
            now >= p.generatedAt && now - p.generatedAt <= 15000 && ns.isRunning(p.producerPid) && cfg.homeGw) {
            cfg.homeGw.criticalReserve = p.reserve;
            cfg.homeGw.requiredShareRam = Math.max(0, p.requiredShareRam || 0);
        }
    } catch { /* Standalone daemon retains its configured reserve. */ }
}

// Actual process RAM wins over estimates. Only exact scheduler-owned live PIDs
// are subtracted; an expired worker cannot disguise a new service as owned RAM.
export function observeHomeCapacity(ns, cfg, running = new Map(), prepJobs = [], now = Date.now()) {
    const state = cfg.homeGw;
    if (!state || now < (state.nextObservation || 0)) return state;
    state.nextObservation = now + 1000;
    readHomePolicy(ns, cfg);
    const server = ns.getServer("home"), processes = ns.ps("home"), live = new Set(processes.map(p => p.pid));
    const owned = [...running].filter(([pid, job]) => job.host === "home" && live.has(pid)).map(([, job]) => job);
    const prep = prepJobs.filter(job => job.host === "home" && live.has(job.pid));
    const ownRam = [...owned, ...prep].reduce((n, job) => n + job.ram, 0);
    const shareRam = processes.filter(p => p.filename === "share-worker.js").reduce((n, p) => n + p.threads * ns.getScriptRam(p.filename, "home"), 0);
    const maxRam = ns.getServerMaxRam("home");
    state.host = { name: "home", maxRam, cores: server.cpuCores || 1, allowHack: false, allowGrow: true, allowWeaken: true };
    state.unrelatedRam = Math.max(0, ns.getServerUsedRam("home") - ownRam - shareRam);
    state.reclaimableShareRam = shareRam;
    state.runningRam = ownRam;
    if (state.cores !== state.host.cores || state.maxRam !== maxRam) { state.samples = []; state.recentUsage = null; state.lastSample = now; }
    state.cores = state.host.cores;
    state.coreBonus = homeCoreBonus(state.cores);
    state.maxRam = maxRam;
    state.protectedRam = homeProtectedRam(cfg);
    state.safeRam = Math.max(0, state.maxRam - state.unrelatedRam - state.protectedRam - ownRam);
    state.state = ownRam > 0 ? "ACTIVE" : state.safeRam > 0 ? "NO_GW_DEMAND" : "RESERVED_FOR_SERVICES";
    state.reason = ownRam > 0 ? "Owned G/W work" : state.safeRam > 0 ? "No current G/W demand" : "Service and critical helper RAM protected";
    state.generatedAt = now;
    return state;
}

// Live pre-exec guard: no stale reservation or supervisor estimate may evict
// services or consume their reserve. Share reclamation is performed by caller.
export function homeLaunchFits(ns, cfg, ram) {
    readHomePolicy(ns, cfg);
    const required = cfg.homeGw?.requiredShareRam || 0;
    const shareHeld = required > 0 ? Math.min(required, homeShareRam(ns)) : 0;
    return ns.getServerMaxRam("home") - ns.getServerUsedRam("home") >= ram + homeProtectedRam(cfg) - shareHeld - 1e-9;
}

export function prepareHomeLaunch(ns, cfg, ram) {
    readHomePolicy(ns, cfg);
    if (homeLaunchFits(ns, cfg, ram)) return true;
    // Required faction sharing is not disposable; never kill a whole PID that
    // includes that protected work. Committed work already owns its reservations.
    if (cfg.homeGw?.requiredShareRam > 0) return false;
    return reclaimHomeShare(ns, ram + homeProtectedRam(cfg)) && homeLaunchFits(ns, cfg, ram);
}

export function homeFreeNow(ns, cfg, includeShare = false) {
    readHomePolicy(ns, cfg);
    return Math.max(0, ns.getServerMaxRam("home") - ns.getServerUsedRam("home") - homeProtectedRam(cfg) + (includeShare ? homeShareRam(ns) : 0));
}

// Bounded rolling evidence, sampled on the existing maintenance cadence. Pure
// scheduler state: no new process scan. XP at a prepared target gains XP/thread,
// not XP/core, so it is explicitly excluded from core ROI evidence.
export function sampleHomeUsage(pool, now = Date.now()) {
    const state = pool.cfg.homeGw;
    if (!state?.host || now < (state.nextSample || 0)) return;
    state.nextSample = now + 1000;
    const jobs = [...pool.running.values()].filter(j => j.host === "home");
    const money = jobs.filter(j => !j.phase?.startsWith("XP-") && /^(G|W)/.test(j.phase));
    const grow = money.filter(j => j.phase === "G"), weak = money.filter(j => j.phase?.startsWith("W"));
    const sum = (a, k) => a.reduce((n, j) => n + (j[k] || 0), 0);
    const all = [...pool.running.values()].filter(j => !j.phase?.startsWith("XP-"));
    const remoteGw = all.filter(j => j.host !== "home" && /^(G|W)/.test(j.phase));
    const nextBonus = homeCoreBonus(state.cores + 1);
    const nextCoreRam = money.reduce((n, j) => n + (j.threads > 0 ?
        (j.threads - Math.ceil(j.threads * state.coreBonus / nextBonus)) * j.ram / j.threads : 0), 0);
    const batches = new Set(all.map(j => j.batchId)), homeBatches = new Set(money.map(j => j.batchId));
    const dt = Math.min(2, Math.max(0, (now - (state.lastSample || now)) / 1000));
    state.lastSample = now;
    state.samples ||= [];
    state.samples.push({ at: now, seconds: dt, ramSeconds: sum(money, "ram") * dt,
        grow: sum(grow, "threads") * dt, weaken: sum(weak, "threads") * dt,
        nextCoreRamSeconds: nextCoreRam * dt, remoteGwRamSeconds: sum(remoteGw, "ram") * dt,
        batches: batches.size, homeBatches: homeBatches.size });
    state.samples = state.samples.filter(s => now - s.at < 60000);
    const seconds = sum(state.samples, "seconds"), ramSeconds = sum(state.samples, "ramSeconds");
    state.recentUsage = { seconds, ramSeconds, averageRam: seconds > 0 ? ramSeconds / seconds : 0,
        nextCoreReleasedRam: seconds > 0 ? sum(state.samples, "nextCoreRamSeconds") / seconds : 0,
        remoteGwAverageRam: seconds > 0 ? sum(state.samples, "remoteGwRamSeconds") / seconds : 0,
        growThreadSeconds: sum(state.samples, "grow"), weakenThreadSeconds: sum(state.samples, "weaken"),
        coreAdjustedThreadSeconds: (sum(state.samples, "grow") + sum(state.samples, "weaken")) * state.coreBonus,
        batchFraction: sum(state.samples, "batches") > 0 ? sum(state.samples, "homeBatches") / sum(state.samples, "batches") : 0 };
    state.growRam = sum(grow, "ram"); state.weakenRam = sum(weak, "ram");
    state.threadsSaved = (sum(grow, "threads") + sum(weak, "threads")) * (state.coreBonus - 1);
}

export function homeCapacityStatus(pool) {
    const state = pool.cfg.homeGw;
    if (!state?.host) return { enabled: false, state: "DISABLED", reason: "Home capability unavailable" };
    const { samples, host, ...status } = state;
    const now = Date.now();
    const temporalRam = pool.reservations.filter(r => r.host === "home" && r.start <= now && r.end > now).reduce((n, r) => n + r.ram, 0);
    const pendingRam = [...pool.pipelines.values()].flatMap(p => p.queue).filter(j => j.host === "home" && j.launchAt < now + 15000).reduce((n,j) => n + j.ram, 0);
    const safeRam = Math.max(0, state.maxRam - state.unrelatedRam - state.protectedRam - Math.max(temporalRam, state.runningRam));
    const constrained = safeRam < 2 && (state.recentUsage?.averageRam || 0) > 0;
    return { ...status, enabled: true, temporalRam, pendingRam, maxCores: HOME_MAX_CORES, safeRam, constrained,
        utilization: state.maxRam > state.unrelatedRam + state.protectedRam ? state.runningRam / (state.maxRam - state.unrelatedRam - state.protectedRam) : 0,
        state: !state.runningRam && state.requiredShareRam > 0 ? "RESERVED_FOR_PROGRESSION" : state.state,
        reason: !state.runningRam && state.requiredShareRam > 0 ? "Required faction sharing protected" : state.reason };
}
