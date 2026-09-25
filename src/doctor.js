import { writeUtilityReport } from "lib/utility-report.js";
import { PORTS } from "lib/ports.js";
import { readSavings } from "lib/savings.js";
import { singularityAvailable } from "lib/progression-protocol.js";
import { SERVICES, selectedServices, supervisorServiceConfig, supervisorFiles } from "lib/service-catalog.js";
import { readArgument } from "lib/service-lifecycle.js";

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
    const supervisor = processes.find(process => process.filename === "supervisor.js");
    const cfg = supervisorServiceConfig(supervisor?.args || []);
    const reset = ns.getResetInfo();
    const capabilities = { singularity: singularityAvailable(reset),
        darknet: ns.fileExists("DarkscapeNavigator.exe", "home") || reset.currentNode === 15, stocks: false };
    try { capabilities.stocks = ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess() && ns.stock.has4SDataTixApi(); } catch {}
    const enabled = selectedServices(cfg);
    const available = enabled.filter(service => !service.capability || capabilities[service.capability]);
    const entries = [...new Set(["supervisor.js", ...supervisorFiles(cfg),
        ...SERVICES.filter(service => processes.some(process => process.filename === service.name)).map(service => service.name)])];
    const inspect = file => {
        if (visited.has(file)) return;
        visited.add(file);
        if (!ns.fileExists(file, "home")) { issues.push(`Missing ${file}`); return; }
        const source = ns.read(file);
        for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) inspect(match[1]);
    };
    for (const file of entries) inspect(file);
    lines.push(`AUTOMATION DOCTOR | inspected ${visited.size} entry points/dependencies`);
    for (const file of entries) {
        const active = processes.filter(p => p.filename === file);
        const ram = ns.getScriptRam(file, "home");
        if (!ram) issues.push(`RAM analysis failed or missing: ${file}`);
        if (active.length > 1 && !file.startsWith("jit-")) issues.push(`Duplicate ${file}: PIDs ${active.map(p => p.pid).join(", ")}`);
        lines.push(`${file}: ${ram.toFixed(2)} GB | ${active.length ? active.map(p => `PID ${p.pid} ${JSON.stringify(p.args)}`).join("; ") : "stopped"}`);
    }
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    const missingRam = services => services.filter(service => !processes.some(process => process.filename === service.name))
        .reduce((sum, service) => sum + ns.getScriptRam(service.name, "home"), 0);
    const coreRam = missingRam(available.filter(service => service.core)) + (supervisor ? 0 : ns.getScriptRam("supervisor.js", "home"));
    const optionalRam = missingRam(available.filter(service => !service.core));
    const actorRam = capabilities.singularity && cfg.progression && cfg.progressionActions
        ? Math.max(ns.getScriptRam("progression-purchase.js", "home"), ns.getScriptRam("progression-backdoor.js", "home")) : 0;
    const helperRam = Math.max(actorRam, capabilities.singularity && cfg.augmentations ? ns.getScriptRam("augmentation-planner.js", "home") : 0,
        cfg.diagnostics ? ns.getScriptRam("doctor.js", "home") : 0);
    const doctor = processes.find(process => process.pid === ns.pid && process.filename === "doctor.js");
    const afterReport = free + (doctor ? ns.getScriptRam("doctor.js", "home") * doctor.threads : 0);
    lines.push(`Home free ${free.toFixed(2)} GB | missing core ${coreRam.toFixed(2)} GB | enabled optional services ${optionalRam.toFixed(2)} GB | largest enabled helper ${helperRam.toFixed(2)} GB`);
    lines.push(`Progression actor allowance: ${actorRam.toFixed(2)} GB`);
    for (const service of SERVICES.filter(service => !available.includes(service))) {
        lines.push(`${service.name}: ${enabled.includes(service) ? `LOCKED (${service.capability})` : "DISABLED"}; excluded from launch RAM budget`);
    }
    if (afterReport < coreRam) issues.push("Full hacking stack needs more home RAM; starter mode can keep earning until it fits");
    else if (afterReport < coreRam + optionalRam + helperRam) issues.push("Enabled services/helpers need more home RAM; lower-priority services will wait while hacking continues");
    const customPort = process => Number(readArgument(process.args || [], process.filename === "daemon.js" ? "--fleet-port" : "--port", PORTS.FLEET_STATUS));
    const fleet = processes.find(p => p.filename === "fleet-manager.js"), daemon = processes.find(p => p.filename === "daemon.js");
    if (fleet && daemon && customPort(fleet) !== customPort(daemon)) issues.push("Daemon and fleet manager disagree on fleet port");
    const servicePorts = Object.fromEntries(SERVICES.filter(service => service.port).map(service => [service.name, service.port]));
    const argument = (process, flag, fallback) => Number(readArgument(process?.args || [], flag, fallback));
    const claims = new Map();
    for (const [port, owner] of [[argument(daemon, "--port", PORTS.WORKER_EVENTS), "worker events"], [PORTS.JIT_STATUS, "JIT status"],
        [argument(daemon, "--control-port", PORTS.JIT_CONTROL), "JIT control"], [PORTS.PROGRESSION_ACTION, "progression actions"], [PORTS.DARKNET_EVENTS, "darknet events"]]) {
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
        const port = argument(process, "--port", defaultPort);
        if (!Number.isSafeInteger(port) || port <= 0) { issues.push(`${script}: invalid port ${port}`); continue; }
        if (claims.has(port)) issues.push(`Port ${port} collision: ${script} and ${claims.get(port)}`);
        claims.set(port, script);
        const snapshot = ns.getPortHandle(port).peek();
        lines.push(`Port ${port}: ${script} | ${typeof snapshot === "object" && snapshot ? `${snapshot.type}, age ${Math.round((Date.now() - snapshot.generatedAt) / 1000)}s` : "empty"}`);
        if (process && snapshot?.producerPid && snapshot.producerPid !== process.pid) issues.push(`${script}: snapshot belongs to another PID`);
    }
    lines.push(`Singularity: ${capabilities.singularity ? "available" : "locked"}; Formulas.exe: ${ns.fileExists("Formulas.exe", "home")}`);
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
