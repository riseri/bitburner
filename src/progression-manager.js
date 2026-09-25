import { PORTS } from "lib/ports.js";
import { progressionBackdoors, resetEpoch, pathFromHome, freshStatus } from "lib/progression-protocol.js";
import { progressionPrograms } from "lib/programs.js";
import { singularityRecommendation } from "lib/augmentation-loop.js";

const HOME = "home";
const WORLD_DAEMON = "w0r1d_d43m0n";
const DEFAULT_INTERVAL_MS = 5_000;

const BACKDOOR_TARGETS = progressionBackdoors();

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["port", PORTS.PROGRESSION_STATUS],
		["fleet-port", PORTS.FLEET_STATUS],
		["interval", DEFAULT_INTERVAL_MS],
		["darknet", true],
	]);

	ns.disableLog("ALL");

	const cfg = {
		port: Number(flags.port),
		fleetPort: Number(flags["fleet-port"]),
		interval: Math.max(1_000, Number(flags.interval) || DEFAULT_INTERVAL_MS),
		darknet: ![false, "false", "0", "off", "no"].includes(flags.darknet),
	};

	const statusPort = ns.getPortHandle(cfg.port);
	const fleetPort = ns.getPortHandle(cfg.fleetPort);

	while (true) {
		let status;
		try {
			status = buildStatus(ns, fleetPort.peek(), cfg);
		} catch (error) {
			status = {
				type: "progression-status",
				generatedAt: Date.now(),
				automationMode: "planner",
				error: String(error?.message ?? error),
			};
		}

		statusPort.clear();
		statusPort.write({ ...status, producerPid: ns.pid, heartbeatIntervalMs: 5_000 });
		const wakeAt = Date.now() + cfg.interval;
		while (Date.now() < wakeAt) {
			await ns.sleep(Math.min(5_000, wakeAt - Date.now()));
			statusPort.clear();
			statusPort.write({ ...status, producerPid: ns.pid, heartbeatIntervalMs: 5_000, generatedAt: Date.now() });
		}
	}
}

function buildStatus(ns, fleetStatus, options = {}) {
	const reset = ns.getResetInfo();
	const currentNode = Number(reset.currentNode) || 0;
	const sourceFiles = sourceFileEntries(reset.ownedSF);
	const sf4Level = Number(reset.ownedSF?.get?.(4) ?? 0);
	const singularityAvailable = currentNode === 4 || sf4Level > 0;
	const torOwned = Boolean(ns.hasTorRouter());
	const hackingLevel = ns.getHackingLevel();
	const money = ns.getServerMoneyAvailable(HOME);

	const programs = progressionPrograms(options).map(program => ({
		...program,
		owned: ns.fileExists(program.name, HOME),
	}));

	const network = freshStatus(fleetStatus, "fleet-status")
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
	const worldDaemon = analyzeNetworkRoute(ns, WORLD_DAEMON, discovered, parents);

	const objectives = planObjectives({ torOwned, programs, backdoors, money });
	return {
		type: "progression-status",
		generatedAt: Date.now(),
		plannedAt: Date.now(),
		planRevision: `${ns.pid}:${Date.now()}`,
		resetEpoch: resetEpoch(reset),
		objectives,
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
		recommendations: singularityAvailable ? [] : [singularityRecommendation(),
			"Keep the money engine, fleet, contracts, stocks, and IPvGO running; perform faction work and augmentation purchases manually"],
		torOwned,
		programs,
		programsOwned: programs.filter(program => program.owned).length,
		programsTotal: programs.length,
		hackingLevel,
		money,
		backdoors,
		backdoorsInstalled: backdoors.filter(target => target.installed).length,
		backdoorsTotal: backdoors.length,
		worldDaemon,
		nextObjective: objectives.find(objective => objective.ready && objective.affordable !== false) ||
			objectives[0] || { kind: "faction-progress", label: "Faction backdoors complete; continue faction and augmentation progression" },
		error: "",
	};
}

function analyzeNetworkRoute(ns, host, discovered, parents) {
	const exists = discovered.has(host) && ns.serverExists(host);
	return {
		host,
		discovered: exists,
		path: exists ? pathFromHome(parents, host) : [],
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
	const path = pathFromHome(parents, target.host);

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

// Independent backdoors do not sit behind an unaffordable shopping cart.
export function planObjectives({ torOwned, programs, backdoors, money }) {
	const objectives = [];
	if (!torOwned) objectives.push({ kind: "tor", target: "TOR", label: "Get a TOR router",
		ready: true, costEstimate: 200_000, affordable: money >= 200_000, blocker: money >= 200_000 ? "" : "insufficient-cash" });
	const missing = programs.find(program => !program.owned);
	if (missing) objectives.push({ kind: "program", target: missing.name, program: missing.name,
		label: `Acquire ${missing.name}`, ready: torOwned, costEstimate: missing.cost,
		affordable: money >= missing.cost, blocker: !torOwned ? "tor-required" : money >= missing.cost ? "" : "insufficient-cash" });
	for (const target of backdoors) {
		if (target.installed) continue;
		const blocker = !target.discovered ? "not-discovered" : !target.rooted ? "root-required"
			: !target.skillReady ? `hacking-level-${target.requiredHacking}-required` : !target.path.length ? "route-required" : "";
		objectives.push({ kind: "backdoor", target: target.host, host: target.host, faction: target.faction,
			label: `Backdoor ${target.host} for ${target.faction}`, ready: !blocker, blocker,
			affordable: true, costEstimate: 0, path: target.path });
	}
	return objectives;
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
