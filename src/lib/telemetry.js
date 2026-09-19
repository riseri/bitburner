import { PORTS } from "lib/ports.js";

const TELEMETRY_FILE = "data/telemetry.json";
const TELEMETRY_LIMIT = 1440;

export function loadTelemetry(ns) {
    let samples = [], error = "";
    try {
        const raw = ns.read(TELEMETRY_FILE);
        if (raw) {
            const stored = JSON.parse(raw);
            if (stored.version !== 1 || !Array.isArray(stored.samples)) throw new Error("Unrecognized telemetry format");
            samples = stored.samples.filter(s => Number.isFinite(s.at)).slice(-TELEMETRY_LIMIT);
        }
    } catch (e) { error = String(e.message || e); }
    return { samples, nextAt: 0, error };
}

export function telemetrySnapshot(ns, fleetPort = PORTS.FLEET_STATUS, now = Date.now()) {
    const read = (port, type) => {
        const value = ns.getPortHandle(port).peek();
        return value?.type === type && Number.isFinite(value.generatedAt) && now >= value.generatedAt &&
            now - value.generatedAt <= 15000 && ns.isRunning(value.producerPid || value.pid) ? value : null;
    };
    const jit = read(PORTS.JIT_STATUS, "jit-status"), fleet = read(fleetPort, "fleet-status"), stock = read(PORTS.STOCK_STATUS, "stock-status");
    const reset = ns.getResetInfo();
    return { at: now, epoch: `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}`,
        cash: ns.getServerMoneyAvailable("home"),
        jit: jit ? { pid: jit.pid, income: jit.income60, earned: jit.earned, usedRam: jit.usedRam, totalRam: jit.totalRam,
            lag: jit.loopLag, note: jit.note,
            targets: (jit.pipelines || []).map(p => ({ name: p.target, mode: p.mode, income: p.income60,
                allocationFails: p.allocationFails, admissionSkips: p.admissionSkips, recoveries: p.fallback,
                local: p.local, idleRetunes: p.idleRetunes, reason: p.admissionReason || p.note })),
            retired: (jit.retired || []).slice(-4) } : null,
        fleet: fleet ? { pid: fleet.producerPid, spent: fleet.cloud?.spent, ram: fleet.cloud?.totalRam,
            action: fleet.cloud?.lastAction, investment: fleet.cloud?.investment } : null,
        stock: stock ? { pid: stock.producerPid, equity: stock.equity, realized: stock.realized, fees: stock.fees } : null };
}

export async function recordTelemetry(ns, state, fleetPort, now = Date.now()) {
    if (now < state.nextAt) return;
    state.nextAt = now + 60000;
    try {
        const sample = telemetrySnapshot(ns, fleetPort, now);
        const samples = [...state.samples, sample].slice(-TELEMETRY_LIMIT);
        await ns.write(TELEMETRY_FILE, JSON.stringify({ version: 1, samples }), "w");
        state.samples = samples; state.error = "";
    } catch (e) { state.error = String(e.message || e); }
}

export function summarizeTelemetry(samples, since) {
    const rows = samples.filter(s => s.at >= since);
    let earnings = 0, spending = 0, recoveries = 0, observedSeconds = 0;
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.epoch !== b.epoch) continue;
        if (a.jit && b.jit && a.jit.pid === b.jit.pid && b.jit.earned >= a.jit.earned) {
            earnings += b.jit.earned - a.jit.earned;
            observedSeconds += Math.max(0, b.at - a.at) / 1000;
            for (const t of b.jit.targets || []) {
                const previous = a.jit.targets?.find(p => p.name === t.name);
                if (previous) recoveries += Math.max(0, (t.recoveries || 0) - (previous.recoveries || 0));
            }
        }
        if (a.fleet && b.fleet && a.fleet.pid === b.fleet.pid) spending += Math.max(0, (b.fleet.spent || 0) - (a.fleet.spent || 0));
    }
    return { count: rows.length, earnings, spending, recoveries, observedSeconds, latest: rows.at(-1) };
}
