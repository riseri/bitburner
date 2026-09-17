import { PORTS } from "lib/ports.js";

const HOME = "home";
const DAEMON = "daemon.js";
const FLEET = "fleet-manager.js";
const CONTRACTS = "contract-manager.js";
const CONTRACT_SELFTEST = "contract-selftest.js";
const HEARTBEAT_STALE_MS = 15_000;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["contracts", true],
		["contract-selftest", false],
		["interval", 5_000],
	]);

	ns.disableLog("ALL");

	const cfg = {
		contracts: asBoolean(flags.contracts),
		contractSelftest: asBoolean(flags["contract-selftest"]),
		interval: Math.max(1_000, Number(flags.interval) || 5_000),
	};

	for (const script of [DAEMON, FLEET, CONTRACTS]) {
		if (!ns.fileExists(script, HOME)) {
			ns.tprint(`ERROR: supervisor missing ${script}`);
			return;
		}
	}

	if (cfg.contractSelftest && ns.fileExists(CONTRACT_SELFTEST, HOME)) {
		await runOnce(ns, CONTRACT_SELFTEST);
	}

	ensureRunning(ns, DAEMON);

	while (true) {
		// daemon.js owns fleet-manager startup today. The supervisor still
		// repairs the fleet process if it disappears after daemon startup.
		ensureRunning(ns, FLEET);

		if (cfg.contracts) {
			ensureRunning(ns, CONTRACTS);
		}

		const fleetHealth = heartbeatHealth(
			ns.getPortHandle(PORTS.FLEET_STATUS).peek(),
			"fleet-status"
		);
		const contractHealth = cfg.contracts
			? heartbeatHealth(
				ns.getPortHandle(PORTS.CONTRACT_STATUS).peek(),
				"contract-status"
			)
			: { healthy: true, age: 0, label: "disabled" };

		if (!fleetHealth.healthy && isRunning(ns, FLEET)) {
			restart(ns, FLEET, `stale fleet heartbeat (${formatAge(fleetHealth.age)})`);
		}

		if (cfg.contracts && !contractHealth.healthy && isRunning(ns, CONTRACTS)) {
			restart(ns, CONTRACTS, `stale contract heartbeat (${formatAge(contractHealth.age)})`);
		}

		render(ns, fleetHealth, contractHealth, cfg);
		await ns.sleep(cfg.interval);
	}
}

function ensureRunning(ns, script) {
	if (isRunning(ns, script)) return;
	const pid = ns.run(script, 1);
	if (!pid) ns.tprint(`WARN: supervisor could not start ${script}`);
}

function restart(ns, script, reason) {
	ns.scriptKill(script, HOME);
	const pid = ns.run(script, 1);
	ns.tprint(`${script} restarted: ${reason}${pid ? ` (pid ${pid})` : " (start failed)"}`);
}

function isRunning(ns, script) {
	return ns.ps(HOME).some(process => process.filename === script);
}

async function runOnce(ns, script) {
	const pid = ns.run(script, 1);
	if (!pid) {
		ns.tprint(`WARN: unable to start ${script}`);
		return;
	}
	while (ns.isRunning(pid, HOME)) await ns.sleep(100);
}

function heartbeatHealth(value, expectedType) {
	if (!value || typeof value !== "object" || value.type !== expectedType) {
		return { healthy: false, age: Infinity, label: "missing" };
	}
	const age = Date.now() - Number(value.generatedAt || 0);
	return {
		healthy: Number.isFinite(age) && age <= HEARTBEAT_STALE_MS,
		age,
		label: age <= HEARTBEAT_STALE_MS ? "healthy" : "stale",
	};
}

function render(ns, fleet, contracts, cfg) {
	ns.clearLog();
	ns.print("AUTOMATION SUPERVISOR");
	ns.print("");
	ns.print(`JIT          ${isRunning(ns, DAEMON) ? "RUNNING" : "DOWN"}`);
	ns.print(`FLEET        ${isRunning(ns, FLEET) ? "RUNNING" : "DOWN"} | ${fleet.label}`);
	ns.print(`CONTRACTS    ${cfg.contracts ? (isRunning(ns, CONTRACTS) ? "RUNNING" : "DOWN") : "DISABLED"} | ${contracts.label}`);
}

function formatAge(age) {
	return Number.isFinite(age) ? `${Math.max(0, age / 1000).toFixed(1)}s` : "missing";
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
