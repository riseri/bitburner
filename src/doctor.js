import { writeUtilityReport } from "lib/utility-report.js";
import { PORTS } from "lib/ports.js";
import { readSavings } from "lib/savings.js";

/** Read-only startup diagnostics; --report publishes for the supervisor. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run doctor.js on home");
    const flags = ns.flags([["report", false]]);
    let report;
    try { report = diagnoseAutomation(ns); }
    catch (error) { report = { state: "ERROR", summary: String(error.message || error), lines: [], issues: [] }; }
    if (flags.report) await writeUtilityReport(ns, "data/diagnostics.json", "diagnostics", report);
    else {
        for (const line of report.lines) ns.tprint(line);
        if (report.state === "ERROR") ns.tprint(`ERROR: ${report.summary}`);
    }
}

export function diagnoseAutomation(ns) {
    const lines = [];
    const processes = ns.ps("home"), issues = [], visited = new Set();
    const entries = ["supervisor.js", "daemon.js", "fleet-manager.js", "contract-manager.js", "progression-manager.js",
        "stock-trader.js", "go-bot.js", "augmentation-manager.js", "augmentation-planner.js", "bootstrap.js",
        "progression-purchase.js", "progression-backdoor.js", "darknet-manager.js", "darknet-bootstrap.js", "darknet-agent.js", "darknet-phish.js",
        "darknet-stasis.js", "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js",
        "jit-hack.js", "jit-grow.js", "jit-weaken.js"];
    const inspect = file => {
        if (visited.has(file)) return;
        visited.add(file);
        if (!ns.fileExists(file, "home")) { issues.push(`Missing ${file}`); return; }
        const source = ns.read(file);
        for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) inspect(match[1]);
    };
    for (const file of entries) inspect(file);
    lines.push(`AUTOMATION DOCTOR | inspected ${visited.size} entry points/dependencies`);
    let additionalRam = 0;
    for (const file of entries) {
        const active = processes.filter(p => p.filename === file);
        const ram = ns.getScriptRam(file, "home");
        if (!ram) issues.push(`RAM analysis failed or missing: ${file}`);
        if (active.length > 1 && !file.startsWith("jit-")) issues.push(`Duplicate ${file}: PIDs ${active.map(p => p.pid).join(", ")}`);
        if (!active.length && !file.startsWith("jit-") && !["progression-purchase.js", "progression-backdoor.js",
            "augmentation-manager.js", "augmentation-planner.js", "bootstrap.js", "darknet-bootstrap.js", "darknet-agent.js", "darknet-phish.js",
            "darknet-stasis.js", "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js"].includes(file)) additionalRam += ram;
        lines.push(`${file}: ${ram.toFixed(2)} GB | ${active.length ? active.map(p => `PID ${p.pid} ${JSON.stringify(p.args)}`).join("; ") : "stopped"}`);
    }
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    const actorRam = Math.max(ns.getScriptRam("progression-purchase.js", "home"), ns.getScriptRam("progression-backdoor.js", "home"));
    lines.push(`Home free ${free.toFixed(2)} GB | stopped default controllers ${additionalRam.toFixed(2)} GB | largest optional actor ${actorRam.toFixed(2)} GB`);
    if (free < additionalRam + actorRam) issues.push("Insufficient headroom for all stopped controllers plus one progression actor; disable unused services or free home RAM");
    const customPort = process => {
        const key = process.filename === "daemon.js" ? "--fleet-port" : "--port";
        const index = process.args.indexOf(key);
        return index >= 0 ? Number(process.args[index + 1]) : PORTS.FLEET_STATUS;
    };
    const fleet = processes.find(p => p.filename === "fleet-manager.js"), daemon = processes.find(p => p.filename === "daemon.js");
    if (fleet && daemon && customPort(fleet) !== customPort(daemon)) issues.push("Daemon and fleet manager disagree on fleet port");
    const servicePorts = { "fleet-manager.js": 19, "contract-manager.js": 18, "progression-manager.js": 16, "stock-trader.js": 13, "go-bot.js": 12, "augmentation-manager.js": 11, "darknet-manager.js": 10 };
    const argument = (process, flag, fallback) => {
        const index = process?.args.indexOf(flag) ?? -1;
        return index >= 0 ? Number(process.args[index + 1]) : fallback;
    };
    const claims = new Map();
    for (const [port, owner] of [[argument(daemon, "--port", 20), "worker events"], [17, "JIT status"],
        [argument(daemon, "--control-port", 15), "JIT control"], [14, "progression actions"], [9, "darknet events"]]) {
        if (!Number.isSafeInteger(port) || port <= 0) issues.push(`${owner}: invalid port ${port}`);
        if (claims.has(port)) issues.push(`Port ${port} collision: ${owner} and ${claims.get(port)}`);
        claims.set(port, owner);
        lines.push(`Port ${port}: ${owner}`);
    }
    for (const process of processes.filter(p => ["contract-manager.js", "progression-manager.js"].includes(p.filename))) {
        if (fleet && argument(process, "--fleet-port", 19) !== customPort(fleet)) issues.push(`${process.filename}: fleet input port differs from the fleet manager`);
    }
    for (const [script, defaultPort] of Object.entries(servicePorts)) {
        const process = processes.find(p => p.filename === script);
        const index = process?.args.indexOf("--port") ?? -1;
        const port = index >= 0 ? Number(process.args[index + 1]) : defaultPort;
        if (!Number.isSafeInteger(port) || port <= 0) { issues.push(`${script}: invalid port ${port}`); continue; }
        if (claims.has(port)) issues.push(`Port ${port} collision: ${script} and ${claims.get(port)}`);
        claims.set(port, script);
        const snapshot = ns.getPortHandle(port).peek();
        lines.push(`Port ${port}: ${script} | ${typeof snapshot === "object" && snapshot ? `${snapshot.type}, age ${Math.round((Date.now() - snapshot.generatedAt) / 1000)}s` : "empty"}`);
        if (process && snapshot?.producerPid && snapshot.producerPid !== process.pid) issues.push(`${script}: snapshot belongs to another PID`);
    }
    const reset = ns.getResetInfo();
    lines.push(`Singularity: ${reset.currentNode === 4 || Number(reset.ownedSF?.get(4)) > 0 ? "available" : "locked"}; Formulas.exe: ${ns.fileExists("Formulas.exe", "home")}`);
    for (const [label, check] of [["WSE", () => ns.stock.hasWseAccount()], ["TIX", () => ns.stock.hasTixApiAccess()], ["4S TIX", () => ns.stock.has4SDataTixApi()]]) {
        try { lines.push(`${label}: ${check() ? "available" : "locked"}`); } catch { lines.push(`${label}: unavailable`); }
    }
    const savings = readSavings(ns);
    lines.push(`Savings: ${savings.label} | ${savings.inactive || savings.error || `floor ${savings.floor}`}`);
    if (savings.error) issues.push(savings.error);
    for (const issue of issues) lines.push(`WARN: ${issue}`);
    lines.push(`${issues.length} diagnostic warning(s). No processes, ports or purchases changed.`);
    return { state: issues.length ? "WARN" : "READY", summary: `${issues.length} warning(s); ${visited.size} files checked`, issues, lines };
}
