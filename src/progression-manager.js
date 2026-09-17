import { PORTS } from "lib/ports.js";

const HOME = "home";
const DEFAULT_INTERVAL_MS = 5_000;

const PORT_PROGRAMS = Object.freeze([
	{ name: "BruteSSH.exe", ports: 1 },
	{ name: "FTPCrack.exe", ports: 2 },
	{ name: "relaySMTP.exe", ports: 3 },
	{ name: "HTTPWorm.exe", ports: 4 },
	{ name: "SQLInject.exe", ports: 5 },
]);

const BACKDOOR_TARGETS = Object.freeze([
	{ host: "CSEC", faction: "CyberSec" },
	{ host: "avmnite-02h", faction: "NiteSec" },
	{ host: "I.I.I.I", faction: "The Black Hand" },
	{ host: "run4theh111z", faction: "BitRunners" },
]);

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["port", PORTS.PROGRESSION_STATUS],
		["fleet-port", PORTS.FLEET_STATUS],
		["interval", DEFAULT_INTERVAL_MS],
	]);

	ns.disableLog("ALL");

	const cfg = {
		port: Number(flags.port),
		fleetPort: Number(flags["fleet-port"]),
		interval: Math.max(1_000, Number(flags.interval) || DEFAULT_INTERVAL_MS),
	};

	const statusPort = ns.getPortHandle(cfg.port);
	const fleetPort = ns.getPortHandle(cfg.fleetPort);

	while (true) {
		let status;
		try {
			status = buildStatus(ns, fleetPort.peek());
		} catch (error) {
			status = {
				type: "progression-status",
				generatedAt: Date.now(),
				automationMode: "planner",
				error: String(error?.message ?? error),
			};
		}

		statusPort.clear();
		statusPort.write(status);
		await ns.sleep(cfg.interval);
	}
}

function buildStatus(ns, fleetStatus) {
	const reset = ns.getResetInfo();
	const currentNode = Number(reset.currentNode) || 0;
	const sourceFiles = sourceFileEntries(reset.ownedSF);
	const sf4Level = Number(reset.ownedSF?.get?.(4) ?? 0);
	const singularityAvailable = currentNode === 4 || sf4Level > 0;
	const torOwned = Boolean(ns.hasTorRouter());
	const hackingLevel = ns.getHackingLevel();
	const money = ns.getServerMoneyAvailable(HOME);

	const programs = PORT_PROGRAMS.map(program => ({
		...program,
		owned: ns.fileExists(program.name, HOME),
	}));

	const network = fleetStatus?.type === "fleet-status"
		? fleetStatus.network ?? {}
		: {};
	const discovered = new Set(
		Array.isArray(network.servers) ? network.servers.map(String) : []
	);
	const parents = network.parents && typeof network.parents === "object"
		? network.parents
		: {};

	const backdoors = BACKDOOR_TARGETS.map(target =>
		analyzeBackdoor(ns, target, discovered, parents, hackingLevel)
	);

	return {
		type: "progression-status",
		generatedAt: Date.now(),
		automationMode: "planner",
		currentNode,
		sourceFiles,
		singularity: {
			available: singularityAvailable,
			sf4Level,
			source: currentNode === 4
				? "BitNode 4"
				: sf4Level > 0
					? `Source-File 4.${sf4Level}`
					: "locked",
		},
		torOwned,
		programs,
		programsOwned: programs.filter(program => program.owned).length,
		programsTotal: programs.length,
		hackingLevel,
		money,
		backdoors,
		backdoorsInstalled: backdoors.filter(target => target.installed).length,
		backdoorsTotal: backdoors.length,
		nextObjective: chooseNextObjective({
			torOwned,
			programs,
			backdoors,
			singularityAvailable,
		}),
		error: "",
	};
}

function analyzeBackdoor(ns, target, discovered, parents, hackingLevel) {
	if (!discovered.has(target.host) || !ns.serverExists(target.host)) {
		return {
			...target,
			discovered: false,
			rooted: false,
			installed: false,
			skillReady: false,
			ready: false,
			requiredHacking: 0,
			path: [],
		};
	}

	const server = ns.getServer(target.host);
	const rooted = ns.hasRootAccess(target.host);
	const installed = Boolean(server.backdoorInstalled);
	const requiredHacking = ns.getServerRequiredHackingLevel(target.host);
	const skillReady = hackingLevel >= requiredHacking;
	const path = buildPath(parents, target.host);

	return {
		...target,
		discovered: true,
		rooted,
		installed,
		skillReady,
		ready:
			!installed &&
			rooted &&
			skillReady &&
			path.length > 0,
		requiredHacking,
		path,
	};
}

function buildPath(parents, target) {
	const path = [];
	const seen = new Set();
	let current = target;

	while (current != null && !seen.has(current)) {
		seen.add(current);
		path.push(current);
		if (current === HOME) break;
		current = parents[current];
	}

	if (path[path.length - 1] !== HOME) return [];
	return path.reverse();
}

function chooseNextObjective({ torOwned, programs, backdoors, singularityAvailable }) {
	const actorHint = singularityAvailable ? "automation can handle this later" : "manual for now";

	if (!torOwned) {
		return {
			kind: "tor",
			label: `Get a TOR router (${actorHint})`,
		};
	}

	const missingProgram = programs.find(program => !program.owned);
	if (missingProgram) {
		return {
			kind: "program",
			program: missingProgram.name,
			label: `Acquire ${missingProgram.name} (${actorHint})`,
		};
	}

	const readyBackdoor = backdoors.find(target => target.ready);
	if (readyBackdoor) {
		return {
			kind: "backdoor",
			host: readyBackdoor.host,
			faction: readyBackdoor.faction,
			path: readyBackdoor.path,
			label: `Backdoor ${readyBackdoor.host} for ${readyBackdoor.faction} (${actorHint})`,
		};
	}

	const hackingBlocked = backdoors
		.filter(target => target.discovered && target.rooted && !target.installed && !target.skillReady)
		.sort((a, b) => a.requiredHacking - b.requiredHacking)[0];
	if (hackingBlocked) {
		return {
			kind: "hacking-level",
			host: hackingBlocked.host,
			requiredHacking: hackingBlocked.requiredHacking,
			label: `Raise hacking to ${hackingBlocked.requiredHacking} for ${hackingBlocked.host}`,
		};
	}

	const rootingBlocked = backdoors.find(
		target => target.discovered && !target.rooted && !target.installed
	);
	if (rootingBlocked) {
		return {
			kind: "root",
			host: rootingBlocked.host,
			label: `Wait for fleet rooting on ${rootingBlocked.host}`,
		};
	}

	const routeBlocked = backdoors.find(
		target =>
			target.discovered &&
			target.rooted &&
			target.skillReady &&
			!target.installed &&
			target.path.length === 0
	);
	if (routeBlocked) {
		return {
			kind: "route",
			host: routeBlocked.host,
			label: `Waiting for network route data for ${routeBlocked.host}`,
		};
	}

	const undiscovered = backdoors.find(target => !target.discovered);
	if (undiscovered) {
		return {
			kind: "discover",
			host: undiscovered.host,
			label: `Keep expanding the network until ${undiscovered.host} is discovered`,
		};
	}

	return {
		kind: "faction-progress",
		label: "Faction backdoors are complete; continue faction and augmentation progression",
	};
}

function sourceFileEntries(ownedSF) {
	if (!ownedSF || typeof ownedSF.entries !== "function") return [];
	return [...ownedSF.entries()]
		.map(([number, level]) => ({
			number: Number(number),
			level: Number(level),
		}))
		.filter(entry => entry.number > 0 && entry.level > 0)
		.sort((a, b) => a.number - b.number);
}
