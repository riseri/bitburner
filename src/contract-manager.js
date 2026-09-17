import { PORTS } from "lib/ports.js";
import { SOLVERS, solveContract } from "contract-solvers.js";

const HOME = "home";
const QUARANTINE_FILE = "contract-quarantine.txt";
const DEFAULT_SCAN_MS = 30_000;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["fleet-port", PORTS.FLEET_STATUS],
		["port", PORTS.CONTRACT_STATUS],
		["interval", DEFAULT_SCAN_MS],
		["dry-run", false],
	]);

	ns.disableLog("ALL");

	const cfg = {
		fleetPort: Number(flags["fleet-port"]),
		port: Number(flags.port),
		interval: Math.max(5_000, Number(flags.interval) || DEFAULT_SCAN_MS),
		dryRun: asBoolean(flags["dry-run"]),
	};

	const quarantine = loadQuarantine(ns);
	const statusPort = ns.getPortHandle(cfg.port);
	const fleetPort = ns.getPortHandle(cfg.fleetPort);
	const state = {
		scans: 0,
		found: 0,
		solved: 0,
		unsupported: 0,
		quarantined: quarantine.size,
		lastReward: "none",
		lastAction: "waiting for fleet snapshot",
		lastRun: 0,
		error: "",
	};

	while (true) {
		try {
			const fleet = fleetPort.peek();
			const servers = Array.isArray(fleet?.network?.servers)
				? fleet.network.servers
				: [];

			if (servers.length > 0) {
				await scanContracts(ns, servers, cfg, quarantine, state);
			} else {
				state.lastAction = "waiting for fleet snapshot";
			}
			state.error = "";
		} catch (error) {
			state.error = String(error?.message ?? error);
		}

		state.lastRun = Date.now();
		state.quarantined = quarantine.size;
		publish(statusPort, state);
		await ns.sleep(cfg.interval);
	}
}

async function scanContracts(ns, servers, cfg, quarantine, state) {
	state.scans++;
	let foundThisPass = 0;

	for (const host of servers) {
		const files = ns.ls(host, ".cct");
		for (const file of files) {
			foundThisPass++;
			state.found++;
			const type = ns.codingcontract.getContractType(file, host);

			if (!SOLVERS[type]) {
				state.unsupported++;
				state.lastAction = `unsupported ${type} @ ${host}/${file}`;
				continue;
			}

			if (quarantine.has(type)) {
				state.lastAction = `quarantined ${type}`;
				continue;
			}

			const tries = ns.codingcontract.getNumTriesRemaining(file, host);
			if (tries <= 1) {
				state.lastAction = `skipped last try ${type} @ ${host}/${file}`;
				continue;
			}

			const data = ns.codingcontract.getData(file, host);
			let solved;
			try {
				solved = solveContract(type, data);
			} catch (error) {
				quarantineType(ns, quarantine, type);
				state.lastAction = `solver error; quarantined ${type}: ${String(error?.message ?? error)}`;
				continue;
			}

			if (!solved.supported) {
				state.unsupported++;
				continue;
			}

			if (cfg.dryRun) {
				state.lastAction = `dry-run solved ${type} @ ${host}/${file}`;
				continue;
			}

			const reward = ns.codingcontract.attempt(solved.answer, file, host);
			if (!reward) {
				quarantineType(ns, quarantine, type);
				state.lastAction = `FAILED; quarantined ${type}`;
				continue;
			}

			state.solved++;
			state.lastReward = reward;
			state.lastAction = `solved ${type} @ ${host}/${file}`;
			await ns.sleep(1);
		}
		await ns.sleep(1);
	}

	if (foundThisPass === 0) {
		state.lastAction = "no contracts found";
	}
}

function quarantineType(ns, quarantine, type) {
	quarantine.add(type);
	ns.write(QUARANTINE_FILE, JSON.stringify([...quarantine].sort()), "w");
}

function loadQuarantine(ns) {
	if (!ns.fileExists(QUARANTINE_FILE, HOME)) return new Set();
	try {
		const value = JSON.parse(ns.read(QUARANTINE_FILE));
		return new Set(Array.isArray(value) ? value : []);
	} catch {
		return new Set();
	}
}

function publish(port, state) {
	port.clear();
	port.write({
		type: "contract-status",
		generatedAt: Date.now(),
		...state,
	});
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
