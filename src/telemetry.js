import { loadTelemetry, summarizeTelemetry } from "lib/telemetry.js";

/** @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run telemetry.js on home");
    const f = ns.flags([["minutes", 60]]);
    const minutes = Number(f.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("minutes must be positive");
    const state = loadTelemetry(ns), report = summarizeTelemetry(state.samples, Date.now() - minutes * 60000);
    if (state.error) ns.tprint(`Telemetry read error: ${state.error}`);
    ns.tprint(`${report.count} samples | measured hacking earnings ${ns.format.number(report.earnings)} | fleet spent ${ns.format.number(report.spending)} | hard recoveries ${report.recoveries}`);
    ns.tprint(`Matched-session coverage ${Math.round(report.observedSeconds)}s; restarts/reset boundaries and missing samples are not counted as earnings.`);
    for (const sample of state.samples.filter(s => s.at >= Date.now() - minutes * 60000).slice(-10)) {
        ns.tprint(`${new Date(sample.at).toISOString()} | hack/s ${sample.jit ? ns.format.number(sample.jit.income) : "unavailable"} | RAM ${sample.jit ? `${Math.round(sample.jit.usedRam)}/${Math.round(sample.jit.totalRam)} GB` : "?"} | ${sample.fleet?.action || ""}`);
        if (sample.jit?.note) ns.tprint(`  Scheduler: ${sample.jit.note} | peak loop lag ${sample.jit.lag || 0}ms`);
        for (const t of sample.jit?.targets || []) ns.tprint(`  ${t.name} ${t.mode}: ${t.reason || "earning"} | RAM failures ${t.allocationFails || 0}, budget skips ${t.admissionSkips || 0}, recoveries ${t.recoveries || 0}`);
        if (sample.stock) ns.tprint(`  Stocks: equity ${ns.format.number(sample.stock.equity)}, session realized ${ns.format.number(sample.stock.realized)}`);
    }
    ns.tprint("Full bounded history: data/telemetry.json (1440 samples, one per minute while supervisor runs).");
}
