import { PORTS } from "lib/ports.js";
import { dashboardTitle, dashboardSection, dashboardRow } from "lib/dashboard.js";
import { SOLVERS, solveContractAsync } from "contract-solvers.js";
import { contractFiles, contractIdentity, solverRevision, readValidation, readQuarantine, readReceipts, validationBlocker, isContractDummy, contractBoolean, saveContractJson } from "lib/contract-safety.js";

const HOME = "home";
const HEARTBEAT_MS = 5_000;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["fleet-port", PORTS.FLEET_STATUS], ["port", PORTS.CONTRACT_STATUS],
		["interval", 30_000], ["dry-run", false], ["allow-last-try", false],
	]);
	ns.disableLog("ALL");
	if (ns.getHostname() !== HOME || ns.ps(HOME).some(p => p.filename === "contract-manager.js" && p.pid !== ns.pid)) {
		ns.tprint("ERROR: Run only one contract manager, on home."); return;
	}
	const cfg = { fleetPort: Number(flags["fleet-port"]), port: Number(flags.port),
		interval: Math.max(5_000, Number(flags.interval) || 30_000),
		dryRun: contractBoolean(flags["dry-run"]), allowLastTry: contractBoolean(flags["allow-last-try"]) };
	const reserved = Object.values(PORTS).filter(p => p !== PORTS.CONTRACT_STATUS && p !== PORTS.FLEET_STATUS);
	if (![cfg.port, cfg.fleetPort].every(p => Number.isSafeInteger(p) && p > 0) || cfg.port === cfg.fleetPort ||
		reserved.includes(cfg.port) || reserved.includes(cfg.fleetPort) || cfg.port === PORTS.FLEET_STATUS || cfg.fleetPort === PORTS.CONTRACT_STATUS) {
		throw new Error("Contract ports must be distinct and must not overwrite other automation channels");
	}
	const port = ns.getPortHandle(cfg.port);
	const ctx = { seen: new Set(), revision: null, sequence: 0, fatal: "" };
	const state = { producerPid: ns.pid, heartbeatIntervalMs: HEARTBEAT_MS, scans: 0, found: 0, solved: 0,
		unsupported: 0, quarantined: 0, waiting: 0, lastReward: "none", lastAction: "waiting for fleet snapshot",
		lastRun: 0, error: "", contracts: [], blockers: {}, scanning: false };
	let lastPulse = 0;
	const pulse = (force = false) => {
		if (force || Date.now() - lastPulse >= HEARTBEAT_MS) {
			publish(ns, port, state); lastPulse = Date.now();
		}
	};
	pulse(true);
	while (true) {
		try {
			const fleet = ns.getPortHandle(cfg.fleetPort).peek();
			const servers = Array.isArray(fleet?.network?.servers) ? [...new Set(fleet.network.servers)] : [];
			if (servers.length) await scanContracts(ns, servers, cfg, ctx, state, pulse);
			else state.lastAction = "waiting for fleet snapshot";
		} catch (error) {
			state.error = String(error?.message ?? error);
		}
		state.scanning = false;
		state.lastRun = Date.now(); pulse(true);
		const wakeAt = Date.now() + cfg.interval;
		while (Date.now() < wakeAt) {
			await ns.sleep(Math.min(HEARTBEAT_MS, wakeAt - Date.now())); pulse(true);
		}
	}
}

export async function scanContracts(ns, servers, cfg, ctx, state, pulse = () => {}) {
	state.scans++; state.scanning = true; state.error = ctx.fatal;
	const inventory = [];
	state.contracts = inventory;
	ctx.revision ??= solverRevision(ns);
	// Corrupt state is not equivalent to an empty quarantine or approval list.
	const report = readValidation(ns);
	ctx.quarantine = readQuarantine(ns);
	ctx.receipts = readReceipts(ns);
	state.quarantinedTypes = Object.keys(ctx.quarantine.types).filter(type =>
		validationBlocker(report, ctx.quarantine, type, ctx.revision) !== "");
	for (const [type, result] of Object.entries(report.types)) {
		if (report.revision === ctx.revision && result.failures > 0 && !state.quarantinedTypes.includes(type)) state.quarantinedTypes.push(type);
	}
	for (const host of servers) {
		pulse();
		let files;
		try { files = ns.ls(host, ".cct").filter(file => file.endsWith(".cct")); }
		catch (error) { state.error = `Scan ${host}: ${String(error?.message ?? error)}`; continue; }
		for (const file of files) {
			pulse(); await ns.sleep(1);
			if (isContractDummy(readValidation(ns), host, file)) continue;
			const entry = { host, file, type: "unknown", status: "waiting", reason: "" };
			inventory.push(entry);
			try {
				entry.type = ns.codingcontract.getContractType(file, host);
				const location = `${host}/${file}`;
				if (!ctx.seen.has(location)) { ctx.seen.add(location); state.found++; }
				if (!Object.hasOwn(SOLVERS, entry.type)) entry.reason = "unsupported-type";
				else await processContract(ns, entry, cfg, ctx, state, pulse);
			} catch (error) {
				entry.reason = `error: ${String(error?.message ?? error)}`;
				state.error = entry.reason;
			}
			state.lastAction = `${entry.status}: ${entry.type} @ ${host}/${file}${entry.reason ? ` (${entry.reason})` : ""}`;
			updateCounts(state, inventory); pulse();
		}
		await ns.sleep(1);
	}
	updateCounts(state, inventory);
	state.scanning = false;
	if (!inventory.length) state.lastAction = "no contracts found";
}

function submissionBlocker(ns, entry, cfg, ctx, id, ignoreOwnIntent = false) {
	if (ctx.fatal) return ctx.fatal;
	if (solverRevision(ns) !== ctx.revision) return "solver-source-changed: restart contract manager";
	const report = readValidation(ns);
	if (isContractDummy(report, entry.host, entry.file)) return "self-test-dummy";
	const quarantine = readQuarantine(ns);
	const approval = validationBlocker(report, quarantine, entry.type, ctx.revision);
	if (approval) return approval;
	if (!ignoreOwnIntent && id && Object.hasOwn(ctx.receipts.entries, id)) return "already-attempted: manual review required";
	// An uncertain API result or interrupted submission must not silently retry
	// on another contract of the same type after the manager restarts.
	if (Object.entries(ctx.receipts.entries).some(([key, r]) => !(ignoreOwnIntent && key === id) && r.type === entry.type && ["in-flight", "uncertain"].includes(r.status))) {
		return "uncertain-submission: manual review required";
	}
	const tries = ns.codingcontract.getNumTriesRemaining(entry.file, entry.host);
	entry.tries = tries;
	if (!Number.isSafeInteger(tries) || tries < 1) return "no-attempts-remaining";
	if (tries === 1 && !cfg.allowLastTry) return "last-attempt-protected";
	return "";
}

async function processContract(ns, entry, cfg, ctx, state, pulse) {
	const { host, file, type } = entry;
	const data = ns.codingcontract.getData(file, host);
	const id = contractIdentity(host, file, type, data);
	// Dry-run may inspect an unvalidated solver, but never submits or changes its quarantine.
	if (!cfg.dryRun) {
		entry.reason = submissionBlocker(ns, entry, cfg, ctx, id);
		if (entry.reason) return;
	} else if (readValidation(ns).status === "running") { entry.reason = "self-test-running"; return; }
	let solved;
	try {
		solved = await solveContractAsync(type, data, async () => { pulse(); await ns.sleep(1); });
	} catch (error) {
		entry.reason = `solver-error: ${String(error?.message ?? error)}`;
		if (!cfg.dryRun) await quarantineType(ns, ctx, type, entry.reason);
		return;
	}
	if (!solved.supported) { entry.reason = "unsupported-type"; return; }
	if (cfg.dryRun) { entry.status = "dry-run"; entry.reason = "computed only; not game-validated"; return; }
	entry.reason = submissionBlocker(ns, entry, cfg, ctx, id);
	if (entry.reason) return;
	if (Object.keys(ctx.receipts.entries).length >= 10_000) { entry.reason = "receipt-limit: archive after manual review"; return; }
	// Write intent BEFORE the side effect. A script crash is not permission to guess twice.
	const receipt = { host, file, type, revision: ctx.revision, status: "in-flight", startedAt: Date.now() };
	ctx.receipts.entries[id] = receipt;
	await persistReceipts(ns, ctx);
	// Re-read policy after the asynchronous write, and verify that this exact input still exists.
	entry.reason = submissionBlocker(ns, entry, cfg, ctx, id, true);
	if (!entry.reason && (ns.codingcontract.getContractType(file, host) !== type ||
		contractIdentity(host, file, type, ns.codingcontract.getData(file, host)) !== id)) entry.reason = "contract-changed";
	if (entry.reason) { delete ctx.receipts.entries[id]; await persistReceipts(ns, ctx); return; }
	ctx.receipts.entries[id] = receipt;
	let reward;
	try {
		reward = ns.codingcontract.attempt(solved.answer, file, host);
		receipt.status = typeof reward === "string" && reward.length > 0 ? "succeeded" : "failed";
	} catch (error) {
		receipt.status = "uncertain";
		entry.reason = `submission-error: ${String(error?.message ?? error)}`;
	}
	receipt.finishedAt = Date.now();
	if (receipt.status === "succeeded") {
		entry.status = "solved"; state.solved++; state.lastReward = reward;
	} else {
		entry.reason ||= "incorrect-answer: solver quarantined";
		await quarantineType(ns, ctx, type, entry.reason);
	}
	await persistReceipts(ns, ctx);
}

async function persistReceipts(ns, ctx) {
	try { await saveContractJson(ns, contractFiles().receipts, ctx.receipts); }
	catch (error) { ctx.fatal = String(error?.message ?? error); throw error; }
}

async function quarantineType(ns, ctx, type, reason) {
	ctx.quarantine = readQuarantine(ns);
	ctx.quarantine.types[type] = { id: `${ns.pid}:${Date.now()}:${++ctx.sequence}`, reason, revision: ctx.revision, at: Date.now() };
	try { await saveContractJson(ns, contractFiles().quarantine, ctx.quarantine); }
	catch (error) { ctx.fatal = String(error?.message ?? error); throw error; }
}

function updateCounts(state, inventory) {
	state.waiting = inventory.filter(e => e.status === "waiting").length;
	state.unsupported = inventory.filter(e => e.reason === "unsupported-type").length;
	state.quarantined = new Set([...(state.quarantinedTypes || []), ...inventory.filter(e => /quarantin|self-test-failed/.test(e.reason)).map(e => e.type)]).size;
	state.blockers = {};
	for (const entry of inventory) if (entry.status === "waiting") {
		state.blockers[entry.reason] = (state.blockers[entry.reason] || 0) + 1;
	}
}

function publish(ns, port, state) {
	port.clear();
	port.write({ type: "contract-status", generatedAt: Date.now(), ...state,
		contracts: state.contracts.map(entry => ({ ...entry })), blockers: { ...state.blockers } });

	const row = (label, value) => dashboardRow(ns, label, value);
	ns.clearLog();
	dashboardTitle(ns, "CODING CONTRACTS");

	dashboardSection(ns, "Status");
	row("Scanner", `${state.scanning ? "SCANNING" : "IDLE"} | ${state.scans} scans`);
	row("Contracts", `${state.waiting} waiting | ${state.solved} solved | ${state.found} found this session`);
	row("Safety", "Solvers must be validated before submissions");
	if (state.lastReward && state.lastReward !== "none") row("Last reward", state.lastReward);
	if (state.error) row("Warning", state.error);

	const blockers = Object.entries(state.blockers).filter(([, count]) => Number(count) > 0);
	if (blockers.length) {
		dashboardSection(ns, "Blocked");
		for (const [reason, count] of blockers) row(String(count), reason || "checking");
	}

	const waiting = state.contracts.filter(entry => entry.status === "waiting").slice(0, 6);
	if (waiting.length) {
		dashboardSection(ns, "Waiting contracts");
		for (const entry of waiting) row(entry.host, `${entry.file} | ${entry.type} | ${entry.reason || "checking"}`);
		const hidden = state.waiting - waiting.length;
		if (hidden > 0) row("More", `${hidden} additional waiting contract${hidden === 1 ? "" : "s"}`);
	}
}

