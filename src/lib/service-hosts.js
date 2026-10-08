import { resetEpoch } from "lib/progression-protocol.js";

export const CLOUD_SERVICES = Object.freeze(["daemon.js", "fleet-manager.js", "progression-manager.js"]);
export const SERVICE_HOSTS_FILE = "data/service-hosts.json";
const SAVED_SERVICE_SETTINGS = [...CLOUD_SERVICES, "augmentation-manager.js"];

// Purchased servers are direct neighbours of home. Optional services and actors
// retain home ownership; only these three controllers may be adopted remotely.
export function serviceProcesses(ns, name) {
    const hosts = CLOUD_SERVICES.includes(name) && typeof ns.scan === "function"
        ? ["home", ...ns.scan("home")] : ["home"];
    const found = new Map();
    for (const host of new Set(hosts)) {
        try {
            for (const process of ns.ps(host)) if (process.filename === name && !found.has(process.pid))
                found.set(process.pid, { ...process, host });
        } catch { /* A server may have been deleted between scan and ps. */ }
    }
    return [...found.values()];
}

export function readServiceHosts(ns) {
    try {
        const saved = JSON.parse(ns.read(SERVICE_HOSTS_FILE));
        if (saved.version !== 1 || saved.resetEpoch !== resetEpoch(ns.getResetInfo())) return {};
        const neighbours = new Set(["home", ...ns.scan("home")]);
        return Object.fromEntries(Object.entries(saved.hosts).filter(([name, host]) =>
            CLOUD_SERVICES.includes(name) && typeof host === "string" && neighbours.has(host) && ns.hasRootAccess(host)));
    } catch { return {}; }
}

export function readServiceSettings(ns) {
    try {
        const saved = JSON.parse(ns.read(SERVICE_HOSTS_FILE));
        if (saved.version !== 1 || saved.resetEpoch !== resetEpoch(ns.getResetInfo())) return {};
        return Object.fromEntries(Object.entries(saved.settings || {}).filter(([name, value]) =>
            SAVED_SERVICE_SETTINGS.includes(name) && Array.isArray(value?.args) &&
            value.args.every(arg => ["string", "boolean"].includes(typeof arg) || typeof arg === "number" && Number.isFinite(arg)) &&
            Number.isSafeInteger(value.threads) && value.threads > 0));
    } catch { return {}; }
}

export async function saveServiceHosts(ns, hosts, settings = {}) {
    await ns.write(SERVICE_HOSTS_FILE, JSON.stringify({ version: 1,
        resetEpoch: resetEpoch(ns.getResetInfo()), hosts, settings, updatedAt: Date.now() }), "w");
}

// Resolve actual imports, including libraries several levels below an entry
// point. Read from home before copying; never ship unrelated user scripts.
export function serviceBundle(ns, entries) {
    const files = [], seen = new Set();
    function visit(file) {
        if (seen.has(file)) return;
        seen.add(file);
        if (!ns.fileExists(file, "home")) throw new Error(`Missing dependency: ${file}`);
        files.push(file);
        const source = ns.read(file);
        const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|^\s*(?:import\s*(?:(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*)?|export\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*)["']([^"'\r\n]+)["']|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gm;
        for (const match of source.matchAll(tokens)) if (match[1]) visit(match[1]);
    }
    for (const file of entries) visit(file);
    return files;
}

/** Small exhaustive packing problem: three controllers, current bins, one new server. */
export function planServicePlacement(services, bins, purchases = []) {
    if (!services.length || services.some(s => !CLOUD_SERVICES.includes(s.name) || !(s.ram > 0) || !Number.isFinite(s.ram))) return null;
    let best = null;
    const jobs = [...services].sort((a, b) => b.ram - a.ram);
    for (const purchase of [null, ...purchases]) {
        const choices = bins.map(b => ({ ...b, remaining: Math.max(0, b.capacity) }));
        if (purchase && purchase.ram > 0 && purchase.cost > 0 && Number.isFinite(purchase.cost))
            choices.push({ host: "@purchase", capacity: purchase.ram, remaining: purchase.ram });
        const hosts = {};
        function pack(index) {
            if (index === jobs.length) {
                const bought = Object.values(hosts).includes("@purchase") ? purchase : null;
                const cost = bought?.cost || 0;
                const homeRam = jobs.filter(s => hosts[s.name] === "home").reduce((n, s) => n + s.ram, 0);
                const remoteCount = new Set(Object.values(hosts).filter(h => h !== "home")).size;
                if (!best || cost < best.cost || cost === best.cost && (homeRam < best.homeRam ||
                    homeRam === best.homeRam && remoteCount < best.remoteCount))
                    best = { hosts: { ...hosts }, purchase: bought, cost, homeRam, remoteCount };
                return;
            }
            const job = jobs[index];
            for (const bin of choices) {
                if (job.host && job.host !== bin.host || bin.remaining + 1e-8 < job.ram) continue;
                bin.remaining -= job.ram; hosts[job.name] = bin.host;
                pack(index + 1);
                bin.remaining += job.ram; delete hosts[job.name];
            }
        }
        pack(0);
    }
    return best;
}
