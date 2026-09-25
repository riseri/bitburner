import { createUtilityJob, tickUtilityJob, currentAugmentationPlan, updateSupervisorSavings } from "lib/supervised-utilities.js";
import { readSavings, writeSavings } from "lib/savings.js";
import { loadTelemetry, recordTelemetry, summarizeTelemetry } from "lib/telemetry.js";
import { dashboardTitle, dashboardSection, dashboardRow, dashboardTargets, dashboardTime } from "lib/dashboard.js";
import { PORTS } from "lib/ports.js";
import { createService, tickService, serviceLabel, readArgument } from "lib/service-lifecycle.js";
import { createActionState, tickProgressionActions, actorProcesses } from "lib/progression-dispatch.js";
import { pathFromHome, singularityAvailable } from "lib/progression-protocol.js";
import { serviceDefinition, supervisorFiles, PROFILE_DEFAULTS } from "lib/service-catalog.js";
import { starterHosts, starterWorkers, stopStarterPool, tickStarterPool } from "lib/starter-pool.js";

const HOME = "home";
const SUPERVISOR = "supervisor.js";
const STARTER_WORKER = "starter-worker.js";
const SHARE_WORKER = "share-worker.js";
const DAEMON = "daemon.js";
const FLEET = "fleet-manager.js";
const CONTRACTS = "contract-manager.js";
const PROGRESSION = "progression-manager.js";
const PROGRESSION_PURCHASE = "progression-purchase.js";
const PROGRESSION_BACKDOOR = "progression-backdoor.js";
const STOCK_TRADER = "stock-trader.js";
const GO_BOT = "go-bot.js";
const AUGMENTATION_MANAGER = "augmentation-manager.js";
const DARKNET_MANAGER = "darknet-manager.js";
const CONTRACT_SELFTEST = "contract-selftest.js";

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["profile", "observe"],
		["background-prep", true],
		["max-targets", 2],
		["dashboard-details", false],
		["contracts", true],
		["progression", true],
		["progression-actions", false],
		["progression-cash-reserve", 0.10],
		["stocks", true],
		["stock-cash-reserve", 0.20],
		["go", true],
		["go-takeover", true],
		["darknet", true],
		["darknet-phish", true],
		["darknet-phish-threads", 1024],
		["darknet-max-attempts", 600],
		["darknet-concurrency", 4],
		["darknet-agent-threads", 4],
		["darknet-stasis", false],
		["darknet-stasis-depth", 8],
		["darknet-migrate", false],
		["darknet-migrate-depth", 8],
		["darknet-promote-stock", false],
		["darknet-stock-symbols", "auto"],
		["darknet-freeze-unknown", false],
		["darknet-freeze-depth", 0],
		["darknet-storm-seed", false],
		["contract-selftest", false],
		["interval", 5_000],
		["telemetry", true],
		["diagnostics", true],
		["augmentations", true],
		["augmentation-focus", "hacking"],
		["augmentation-target", ""],
		["augmentation-price-multiplier", 1],
		["augmentation-actions", false],
		["augmentation-cash-reserve", 0.10],
		["augmentation-join-factions", true],
		["augmentation-city-faction", ""],
		["augmentation-work", true],
		["augmentation-donate", true],
		["augmentation-purchase", true],
		["augmentation-focus-work", false],
		["auto-install", false],
		["min-install", 5],
		["savings", "auto"],
		["save-amount", -1],
		["save-label", "Savings"],
		["save-target", ""],
		["cloud-roi", true],
		["cloud-payback", 1800],
		["home-reserve", 8],
		["share", true],
	]);
	applySupervisorProfile(flags, ns.args);

	ns.disableLog("ALL");
	if (ns.getHostname() !== HOME || ns.ps(HOME).some(process => process.filename === SUPERVISOR && process.pid !== ns.pid)) {
		ns.tprint("ERROR: run one supervisor on home; refusing duplicate ownership");
		return;
	}

	const cfg = {
		dashboardDetails: asBoolean(flags["dashboard-details"]),
		telemetry: asBoolean(flags.telemetry),
		diagnostics: asBoolean(flags.diagnostics),
		augmentations: asBoolean(flags.augmentations),
		augmentationFocus: String(flags["augmentation-focus"]),
		augmentationTarget: String(flags["augmentation-target"]),
		augmentationMultiplier: Number(flags["augmentation-price-multiplier"]),
		augmentationActions: asBoolean(flags["augmentation-actions"]),
		augmentationCashReserve: clampFraction(flags["augmentation-cash-reserve"]),
		augmentationJoinFactions: asBoolean(flags["augmentation-join-factions"]),
		augmentationCityFaction: String(flags["augmentation-city-faction"]),
		augmentationWork: asBoolean(flags["augmentation-work"]),
		augmentationDonate: asBoolean(flags["augmentation-donate"]),
		augmentationPurchase: asBoolean(flags["augmentation-purchase"]),
		augmentationFocusWork: asBoolean(flags["augmentation-focus-work"]),
		autoInstall: asBoolean(flags["auto-install"]),
		minInstall: Number(flags["min-install"]),
		savingsMode: Number(flags["save-amount"]) >= 0 ? "fixed" : String(flags.savings),
		cloudRoi: asBoolean(flags["cloud-roi"]),
		cloudPayback: Number(flags["cloud-payback"]),
		// A property named share is charged as the worker API by the RAM analyzer.
		shareEnabled: asBoolean(flags["share"]),
		contracts: asBoolean(flags.contracts),
		progression: asBoolean(flags.progression),
		progressionActions: asBoolean(flags["progression-actions"]),
		progressionCashReserve: clampFraction(flags["progression-cash-reserve"]),
		stocks: asBoolean(flags.stocks),
		stockCashReserve: clampFraction(flags["stock-cash-reserve"]),
		go: asBoolean(flags.go),
		goTakeover: asBoolean(flags["go-takeover"]),
		darknet: asBoolean(flags.darknet),
		darknetPhish: asBoolean(flags["darknet-phish"]),
		darknetPhishThreads: Number(flags["darknet-phish-threads"]),
		darknetMaxAttempts: Number(flags["darknet-max-attempts"]),
		darknetConcurrency: Number(flags["darknet-concurrency"]),
		darknetAgentThreads: Number(flags["darknet-agent-threads"]),
		darknetStasis: asBoolean(flags["darknet-stasis"]),
		darknetStasisDepth: Number(flags["darknet-stasis-depth"]),
		darknetMigrate: asBoolean(flags["darknet-migrate"]),
		darknetMigrateDepth: Number(flags["darknet-migrate-depth"]),
		darknetPromoteStock: asBoolean(flags["darknet-promote-stock"]),
		darknetStockSymbols: String(flags["darknet-stock-symbols"]),
		darknetFreezeUnknown: asBoolean(flags["darknet-freeze-unknown"]),
		darknetFreezeDepth: Number(flags["darknet-freeze-depth"]),
		darknetStormSeed: asBoolean(flags["darknet-storm-seed"]),
		contractSelftest: asBoolean(flags["contract-selftest"]),
		interval: Math.max(1_000, Number(flags.interval) || 5_000),
	};

	validateSupervisorOptions(flags, cfg);
	await saveSupervisorBootstrap(ns);
	const required = supervisorFiles(cfg);

	for (const script of required) {
		if (!ns.fileExists(script, HOME)) {
			ns.tprint(`ERROR: supervisor missing ${script}`);
			return;
		}
	}

	await runStarterMode(ns);

	if (cfg.contractSelftest && ns.fileExists(CONTRACT_SELFTEST, HOME)) {
		await runOnce(ns, CONTRACT_SELFTEST);
	}

	if (![1, 2].includes(Number(flags["max-targets"]))) throw new Error("max-targets must be 1 or 2");
	const daemonArgs = asBoolean(flags["background-prep"]) ? [] : ["--background-prep", false];
	if (Number(flags["max-targets"]) !== 2) daemonArgs.push("--max-targets", Number(flags["max-targets"]));
	if (cfg.dashboardDetails) daemonArgs.push("--dashboard-details", true);
	if (cfg.shareEnabled) daemonArgs.push("--fleet-share", true);
	const utilityReserve = Math.max(0,
		cfg.diagnostics ? ns.getScriptRam("doctor.js", HOME) : 0,
		cfg.augmentations && augmentationAccess(ns) ? ns.getScriptRam("augmentation-planner.js", HOME) : 0,
		cfg.progression && cfg.progressionActions ? ns.getScriptRam(PROGRESSION_PURCHASE, HOME) : 0,
		cfg.progression && cfg.progressionActions ? ns.getScriptRam(PROGRESSION_BACKDOOR, HOME) : 0);
	const optionalServiceReserve = (cfg.augmentationActions ? ns.getScriptRam(AUGMENTATION_MANAGER, HOME) : 0) +
		(cfg.darknet ? ns.getScriptRam(DARKNET_MANAGER, HOME) + ns.getScriptRam("darknet-agent.js", HOME) : 0);
	daemonArgs.push("--home-reserve", Math.max(Number(flags["home-reserve"]), optionalServiceReserve + utilityReserve + 8));
	cfg.shareReserve = Math.max(Number(flags["home-reserve"]), utilityReserve);
	const services = createManagedServices(ns, cfg, daemonArgs);
	const actions = createActionState();
	const jobs = createSupervisorUtilities(cfg);
	if (cfg.savingsMode === "fixed") await writeSavings(ns, Number(flags["save-amount"]), flags["save-label"], flags["save-target"]);
	else if (cfg.savingsMode === "none") await writeSavings(ns, 0, "No savings goal");
	const telemetry = cfg.telemetry ? loadTelemetry(ns) : null;

	while (true) {
		// Reconcile persistent services in priority order. A lower-priority service
		// cannot consume RAM being held for the first higher-priority service that
		// does not fit. Existing processes are always adopted and monitored.
		const stockGate = stockAccess(ns);
		const coreServices = [DAEMON, FLEET].map(name => services.find(service => service.name === name));
		const admittedServices = [...coreServices];
		for (const service of services.filter(service => !coreServices.includes(service))) {
			if (service.name === STOCK_TRADER && !stockGate.ok) {
				blockStockService(ns, service, stockGate);
				continue;
			}
			if (service.name === AUGMENTATION_MANAGER && !augmentationAccess(ns) && !findProcess(ns, service.name)) {
				blockCapabilityService(service, "Singularity is locked");
				continue;
			}
			if (service.name === DARKNET_MANAGER && !darknetAccess(ns) && !findProcess(ns, service.name)) {
				blockCapabilityService(service, "DarkscapeNavigator.exe is locked");
				continue;
			}
			if (service.name === GO_BOT) {
				const stopped = goSafetyStop(ns, service);
				if (stopped) {
					if (!(cfg.goTakeover && recoverableGoOwnershipStop(stopped) && prepareGoTakeoverRetry(ns, service))) {
						blockGoService(ns, service, stopped);
						continue;
					}
				}
			}
			admittedServices.push(service);
		}
		yieldFleetRamToDaemon(ns, coreServices);
		const serviceBlocker = tickServicePriority(ns, admittedServices);

		// Short-lived helpers are lower priority than every enabled persistent service.
		for (const job of jobs) {
			const other = jobs.find(candidate => candidate !== job && ns.ps(HOME).some(p => p.filename === candidate.script));
			const gate = job.type === "augmentation-plan" && !augmentationAccess(ns) ? "Singularity is locked"
				: serviceBlocker || (other ? `Waiting for ${other.script}` : "");
			tickUtilityJob(ns, job, gate);
		}
		cfg.utilityJobs = jobs;
		cfg.augmentationPlan = currentAugmentationPlan(ns, jobs.find(job => job.type === "augmentation-plan"));
		try { await updateSupervisorSavings(ns, cfg, cfg.augmentationPlan); }
		catch (error) { cfg.savingsStatus = `Savings update failed: ${String(error.message || error)}`; }
		const snapshot = name => {
			const service = services.find(item => item.name === name);
			return service?.port ? ns.getPortHandle(service.port).peek() : null;
		};
		cfg.fleetStatusPort = services.find(service => service.name === FLEET).port;
		const fleetStatus = snapshot(FLEET), contractStatus = snapshot(CONTRACTS),
			progressionStatus = snapshot(PROGRESSION), stockStatus = snapshot(STOCK_TRADER),
			goStatus = ownedServiceStatus(ns, services.find(service => service.name === GO_BOT), snapshot(GO_BOT)),
			augmentationStatus = snapshot(AUGMENTATION_MANAGER), darknetStatus = snapshot(DARKNET_MANAGER);
		tickProgressionActions(ns, actions, progressionStatus, cfg);
		reconcileHomeShare(ns, cfg.shareEnabled, cfg.shareReserve);
		cfg.shareStatus = collectSharingStatus(ns, cfg.shareEnabled, fleetStatus, cfg.shareReserve);
		if (telemetry) await recordTelemetry(ns, telemetry, cfg.fleetStatusPort);
		cfg.telemetryError = telemetry?.error || "";
		if (telemetry) cfg.telemetrySummary = summarizeTelemetry(telemetry.samples, Date.now() - 3600000);
		render(ns, { cfg, services, actions, fleetStatus, contractStatus, progressionStatus, stockStatus, goStatus, augmentationStatus, darknetStatus, stockAccess: stockGate });
		await ns.sleep(cfg.interval);
	}
}

function tickServicePriority(ns, services, blockedBy = "") {
	let blocker = blockedBy;
	for (let index = 0; index < services.length; index++) {
		const service = services[index];
		const process = findProcess(ns, service.name);
		if (process) {
			service.waitReason = "";
			tickService(ns, service);
			continue;
		}
		if (blocker) {
			service.state = "WAITING_PRIORITY";
			service.waitReason = blocker;
			continue;
		}
		// Let lifecycle accounting observe exits and honor retry backoff before
		// displacing healthy lower-priority processes for a launch attempt.
		if (service.pid || Date.now() < service.nextStartAt) {
			service.waitReason = "";
			tickService(ns, service);
			continue;
		}
		const needed = ns.getScriptRam(service.name, HOME) * Math.max(1, service.threads || 1);
		let free = ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
		if (needed > free) {
			yieldHomeShare(ns);
			free = ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
		}
		if (needed > free) {
			preemptLowerPriorityServices(ns, service, services.slice(index + 1), needed - free);
			free = ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
		}
		if (needed > 0 && needed > free) {
			service.state = "WAITING_RAM";
			service.waitReason = `needs ${needed.toFixed(2)} GB; ${Math.max(0, free).toFixed(2)} GB free`;
			blocker = `${service.name} ${service.waitReason}`;
			continue;
		}
		service.waitReason = "";
		tickService(ns, service);
	}
	return blocker;
}

function yieldHomeShare(ns) {
	for (const process of ns.ps(HOME).filter(item => item.filename === SHARE_WORKER)) ns.kill(process.pid);
}

function reconcileHomeShare(ns, enabled, reserve = 0) {
	const processes = ns.ps(HOME).filter(process => process.filename === SHARE_WORKER);
	const ramPerThread = ns.getScriptRam(SHARE_WORKER, HOME);
	if (!enabled || !(ramPerThread > 0)) {
		for (const process of processes) ns.kill(process.pid);
		return enabled ? "WAITING (missing worker or invalid RAM cost)" : "Disabled";
	}
	const currentRam = processes.reduce((sum, process) =>
		sum + ramPerThread * Math.max(1, process.threads || 1), 0);
	const usedWithoutShare = Math.max(0, ns.getServerUsedRam(HOME) - currentRam);
	const desiredThreads = Math.max(0, Math.floor((ns.getServerMaxRam(HOME) - usedWithoutShare - reserve) / ramPerThread));
	if (processes.length === 1 && processes[0].threads === desiredThreads) {
		return `${desiredThreads} threads | ${formatRam(currentRam)} | ${formatRam(reserve)} reserved`;
	}
	for (const process of processes) ns.kill(process.pid);
	const pid = desiredThreads > 0 ? ns.run(SHARE_WORKER, desiredThreads) : 0;
	return pid
		? `${desiredThreads} threads | ${formatRam(desiredThreads * ramPerThread)} | ${formatRam(reserve)} reserved`
		: `WAITING | ${formatRam(reserve)} reserved`;
}

function collectSharingStatus(ns, enabled, fleetStatus, reserve = 0) {
	let power = 1;
	try { power = Math.max(1, Number(ns.getSharePower()) || 1); } catch {}
	if (!enabled) return { enabled: false, power, threads: 0, ram: 0, hosts: 0, reserve };
	const names = new Set([HOME]);
	for (const host of fleetStatus?.network?.hosts || []) {
		const name = String(host?.name || "");
		if (name) names.add(name);
	}
	let threads = 0, ram = 0, hosts = 0;
	for (const host of names) {
		let hostThreads = 0;
		try {
			for (const process of ns.ps(host)) {
				if (process.filename === SHARE_WORKER) hostThreads += Math.max(1, process.threads || 1);
			}
			if (hostThreads > 0) {
				hosts++;
				threads += hostThreads;
				ram += hostThreads * Math.max(0, Number(ns.getScriptRam(SHARE_WORKER, host)) || 0);
			}
		} catch {}
	}
	return { enabled: true, power, threads, ram, hosts, reserve };
}

function sharingLabel(status) {
	if (!status?.enabled) return "OFF";
	const power = `${Math.max(1, Number(status.power) || 1).toFixed(3)}x faction rep`;
	if (!(status.threads > 0)) return `${power} | waiting for spare RAM`;
	return `${power} | ${status.threads} threads | ${formatRam(status.ram)} on ${status.hosts} host${status.hosts === 1 ? "" : "s"}`;
}

function preemptLowerPriorityServices(ns, owner, lowerServices, shortfall) {
	const victims = lowerServices.map(service => ({service, process: findProcess(ns, service.name)}))
		.filter(item => item.process)
		.reverse();
	const reclaimable = victims.reduce((sum, item) =>
		sum + ns.getScriptRam(item.process.filename, HOME) * Math.max(1, item.process.threads || 1), 0);
	if (reclaimable < shortfall) return false;
	let reclaimed = 0;
	for (const {service, process} of victims) {
		if (!ns.kill(process.pid)) continue;
		reclaimed += ns.getScriptRam(process.filename, HOME) * Math.max(1, process.threads || 1);
		service.pid = 0;
		service.state = "WAITING_PRIORITY";
		service.waitReason = `yielded RAM to ${owner.name}`;
		service.healthySince = null;
		service.staleSince = null;
		if (reclaimed >= shortfall) break;
	}
	return reclaimed >= shortfall;
}

// Borrow free network RAM while home cannot yet hold the full money engine.
async function runStarterMode(ns) {
	const copied = new Set();
	while (true) {
		const hosts = starterHosts(ns);
		const maxRam = ns.getServerMaxRam(HOME);
		const coreRam = ns.getScriptRam(SUPERVISOR, HOME) + ns.getScriptRam(DAEMON, HOME) + ns.getScriptRam(FLEET, HOME);
		const workerRam = ns.getScriptRam(STARTER_WORKER, HOME);
		const homeWorkerRam = starterWorkers(ns, HOME).reduce((sum, process) => sum + workerRam * process.threads, 0);
		const missingCore = [DAEMON, FLEET].filter(file => !findProcess(ns, file))
			.reduce((sum, file) => sum + ns.getScriptRam(file, HOME), 0);
		const ready = coreRam > 0 && maxRam >= coreRam &&
			maxRam - ns.getServerUsedRam(HOME) + homeWorkerRam >= missingCore;
		if (ready && stopStarterPool(ns, hosts)) {
			ns.tprint(`Starter mode complete at ${maxRam.toFixed(2)} GB home RAM; launching the full automation stack`);
			return;
		}
		const pool = ready ? { rooted: true, threads: 0, workers: 0, failures: 1 }
			: await tickStarterPool(ns, hosts, copied);

		ns.clearLog();
		dashboardTitle(ns, "BITBURNER AUTOMATION :: STARTER MODE");
		dashboardSection(ns, "Income bootstrap");
		dashboardRow(ns, "Target", "n00dles");
		dashboardRow(ns, "Workers", !pool.rooted ? "WAITING FOR ROOT on n00dles" : pool.threads
			? `${pool.threads} threads across ${pool.workers} servers` : "WAITING FOR RAM on home and rooted servers");
		if (pool.failures) dashboardRow(ns, "Retry", ready ? "Waiting for starter workers to stop before handoff" : `${pool.failures} deployment(s) will retry`);
		dashboardSection(ns, "Upgrade path");
		dashboardRow(ns, "Home RAM", `${formatRam(maxRam)} / ${formatRam(coreRam)} needed for supervisor + daemon + fleet`);
		dashboardRow(ns, "Next", "Upgrade home RAM manually; full automation starts when enough RAM is free");
		await ns.sleep(5_000);
	}
}

// The daemon can discover and use the current fleet without the background fleet
// manager, but the fleet manager cannot produce income without the daemon. On a
// low-RAM reset, yield only the exact fleet PID when doing so is sufficient to let
// the daemon start. Remote workers and unrelated processes are never touched.
function yieldFleetRamToDaemon(ns, coreServices, now = Date.now()) {
	const daemon = coreServices.find(service => service.name === DAEMON);
	const fleet = coreServices.find(service => service.name === FLEET);
	if (!daemon || !fleet || findProcess(ns, DAEMON)) return false;
	const fleetProcess = findProcess(ns, FLEET);
	if (!fleetProcess) return false;
	const free = ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
	const daemonRam = ns.getScriptRam(DAEMON, HOME) * Math.max(1, daemon.threads || 1);
	const fleetRam = ns.getScriptRam(FLEET, HOME) * Math.max(1, fleetProcess.threads || 1);
	if (!(daemonRam > free && daemonRam <= free + fleetRam)) return false;
	if (!ns.kill(fleetProcess.pid)) return false;
	fleet.pid = 0;
	fleet.state = "BACKOFF";
	fleet.nextStartAt = now + 5_000;
	fleet.healthySince = null;
	fleet.staleSince = null;
	fleet.lastEvent = "Yielded home RAM to restore the money engine";
	fleet.lastEventAt = now;
	return true;
}

function ownedServiceStatus(ns, service, status) {
	if (!service || !status || !status.producerPid) return null;
	const process = findProcess(ns, service.name);
	const ownerPid = process?.pid || service.pid;
	return ownerPid && status.producerPid === ownerPid ? status : null;
}

// Resolve dependencies once at startup; adopting a process never rewrites its arguments.
function createManagedServices(ns, cfg, daemonArgs) {
	const processes = ns.ps(HOME);
	const existingDaemon = processes.find(process => process.filename === DAEMON);
	const existingFleet = processes.find(process => process.filename === FLEET);
	const managedDaemonArgs = existingDaemon?.args ?? daemonArgs;
	const fleetArgs = ["--port", readArgument(managedDaemonArgs, "--fleet-port", PORTS.FLEET_STATUS),
		"--stock-port", PORTS.STOCK_STATUS,
		"--cloud-roi", cfg.cloudRoi ?? true,
		"--cloud-payback", cfg.cloudPayback ?? 1800,
		"--cloud", readArgument(managedDaemonArgs, "--cloud", true),
		"--cloud-reserve", readArgument(managedDaemonArgs, "--cloud-reserve", 0.10),
		"--cloud-min-ram", readArgument(managedDaemonArgs, "--cloud-min-ram", 32),
		"--cloud-prefix", readArgument(managedDaemonArgs, "--cloud-prefix", "cloud")];
	const fleetPort = Number(readArgument(existingFleet?.args ?? fleetArgs, "--port", PORTS.FLEET_STATUS));
	const reserved = Object.values(PORTS).filter(port => port !== PORTS.FLEET_STATUS);
	if (!Number.isSafeInteger(fleetPort) || fleetPort <= 0 || reserved.includes(fleetPort)) {
		throw new Error("Fleet status port must not collide with a reserved automation channel");
	}
	if (existingDaemon && Number(readArgument(existingDaemon.args, "--fleet-port", PORTS.FLEET_STATUS)) !== fleetPort) {
		throw new Error("Existing daemon and fleet use different fleet ports; align their arguments explicitly");
	}
	// New dependents follow the adopted fleet; existing dependents retain their own args.
	const launchDaemonArgs = existingDaemon ? daemonArgs : [...daemonArgs, "--fleet-port", fleetPort];
	const managed = (name, args, port = null) => {
		const definition = serviceDefinition(name);
		return createService(name, args, definition.type, port ?? definition.port, definition.heartbeatRequired ?? true);
	};
	const services = [managed(DAEMON, launchDaemonArgs), managed(FLEET, fleetArgs, fleetPort)];
	if (cfg.progression) services.push(managed(PROGRESSION, ["--fleet-port", fleetPort, "--darknet", cfg.darknet !== false]));
	if (cfg.contracts) services.push(managed(CONTRACTS, ["--fleet-port", fleetPort]));
	if (cfg.augmentationActions) services.push(managed(AUGMENTATION_MANAGER,
		["--port", PORTS.AUGMENTATION_STATUS, "--focus", cfg.augmentationFocus, "--target", cfg.augmentationTarget,
			"--cash-reserve", cfg.augmentationCashReserve, "--join-factions", cfg.augmentationJoinFactions,
			"--city-faction", cfg.augmentationCityFaction, "--work", cfg.augmentationWork,
			"--donate", cfg.augmentationDonate ?? true,
			"--purchase", cfg.augmentationPurchase, "--focus-work", cfg.augmentationFocusWork,
			"--auto-install", cfg.autoInstall, "--min-install", cfg.minInstall]));
	if (cfg.stocks) services.push(managed(STOCK_TRADER,
		["--port", PORTS.STOCK_STATUS, "--cash-reserve", cfg.stockCashReserve]));
	// Go publishes status for the dashboard, but slow opponent API calls are allowed to wait indefinitely.
	// Process liveness owns restart decisions; the generic heartbeat watchdog does not.
	if (cfg.go) services.push(managed(GO_BOT,
		["--port", PORTS.GO_STATUS, "--takeover", cfg.goTakeover ?? true]));
	if (cfg.darknet) services.push(managed(DARKNET_MANAGER,
		["--port", PORTS.DARKNET_STATUS, "--event-port", PORTS.DARKNET_EVENTS,
			"--phish", cfg.darknetPhish, "--phish-threads", cfg.darknetPhishThreads, "--max-attempts", cfg.darknetMaxAttempts,
			"--concurrency", cfg.darknetConcurrency, "--agent-threads", cfg.darknetAgentThreads,
			"--stasis", cfg.darknetStasis, "--stasis-depth", cfg.darknetStasisDepth,
			"--migrate", cfg.darknetMigrate, "--migrate-depth", cfg.darknetMigrateDepth,
			"--promote-stock", cfg.darknetPromoteStock, "--stock-symbols", cfg.darknetStockSymbols,
			"--freeze-unknown", cfg.darknetFreezeUnknown, "--freeze-depth", cfg.darknetFreezeDepth,
			"--storm-seed", cfg.darknetStormSeed]));
	return services;
}

function stockAccess(ns) {
	const checks = [
		["WSE Account", () => ns.stock?.hasWseAccount?.()],
		["TIX API", () => ns.stock?.hasTixApiAccess?.()],
		["4S TIX API", () => ns.stock?.has4SDataTixApi?.()],
	];
	const missing = [];
	for (const [name, check] of checks) {
		let ok = false;
		try { ok = check() === true; } catch { ok = false; }
		if (!ok) missing.push(name);
	}
	return { ok: missing.length === 0, missing };
}

function blockStockService(ns, service, access, now = Date.now()) {
	const process = findProcess(ns, STOCK_TRADER);
	if (process) {
		service.pid = process.pid;
		service.args = [...process.args];
		service.threads = process.threads || 1;
	} else {
		service.pid = 0;
		service.nextStartAt = 0;
		service.failures = 0;
		try { ns.getPortHandle(service.port).clear(); } catch {}
	}
	service.state = "BLOCKED";
	service.healthySince = null;
	service.staleSince = null;
	const reason = `Market access unavailable: ${access.missing.join(", ")}`;
	service.waitReason = reason;
	if (service.lastEvent !== reason) {
		service.lastEvent = reason;
		service.lastEventAt = now;
	}
	return service;
}

function blockCapabilityService(service, reason) {
	service.pid = 0;
	service.state = "BLOCKED";
	service.nextStartAt = 0;
	service.failures = 0;
	service.healthySince = null;
	service.staleSince = null;
	service.waitReason = reason;
	return service;
}

function darknetAccess(ns) {
	try {
		return ns.fileExists("DarkscapeNavigator.exe", HOME) || Number(ns.getResetInfo()?.currentNode) === 15;
	} catch {
		return false;
	}
}

function goSafetyStop(ns, service) {
	if (!service?.port) return null;
	const status = ns.getPortHandle(service.port).peek();
	if (status?.type !== "go-status" || status.terminal !== true || !status.producerPid) return null;
	const process = findProcess(ns, GO_BOT);
	const ownerPid = process?.pid || service.pid;
	return ownerPid && status.producerPid === ownerPid ? status : null;
}

function blockGoService(ns, service, status) {
	const process = findProcess(ns, GO_BOT);
	if (process && process.pid !== status.producerPid) return service;
	if (process) {
		service.pid = process.pid;
		service.args = [...process.args];
		service.threads = process.threads || 1;
	}
	service.state = "BLOCKED";
	service.nextStartAt = Infinity;
	service.healthySince = null;
	service.staleSince = null;
	service.lastEvent = `Go safety stop: ${status.error || "board ownership requires review"}`;
	service.lastEventAt = Number(status.generatedAt) || Date.now();
	return service;
}

function isRunning(ns, script) {
	return ns.ps(HOME).some(process => process.filename === script);
}

function findProcess(ns, script) {
	return ns.ps(HOME).find(process => process.filename === script) ?? null;
}

// One-shot startup only; long-running services use tickService and its history.
function ensureRunning(ns, script, args = []) {
	return findProcess(ns, script)?.pid ?? ns.run(script, 1, ...args);
}

async function runOnce(ns, script) {
	const pid = ensureRunning(ns, script);
	if (!pid) { ns.print(`WARN: unable to start ${script}`); return; }
	while (ns.isRunning(pid)) await ns.sleep(100);
}

function progressionActorProcess(ns) { return actorProcesses(ns)[0] ?? null; }

function render(ns, state) {
	const { cfg, fleetStatus, contractStatus, progressionStatus, stockStatus, goStatus, augmentationStatus, darknetStatus, fleetHealth, contractHealth, progressionHealth } = state;
	const daemon = readDaemonDashboard(ns);
	const fleet = fleetStatus?.type === "fleet-status" ? fleetStatus : null;
	const contracts = contractStatus?.type === "contract-status" ? contractStatus : null;
	const progression = progressionStatus?.type === "progression-status"
		? withWorldDaemonRoute(progressionStatus, fleet)
		: null;
	const stocks = stockStatus?.type === "stock-status" ? stockStatus : null;
	const go = goStatus?.type === "go-status" ? goStatus : null;
	const augmentation = augmentationStatus?.type === "augmentation-status" ? augmentationStatus : null;
	const darknet = darknetStatus?.type === "darknet-status" ? darknetStatus : null;

	ns.clearLog();
	dashboardTitle(ns, "BITBURNER AUTOMATION");
	const goal = readSavings(ns);
	if (!cfg.dashboardDetails) {
		renderAttention(ns, { cfg, goal, daemon, fleet, contracts, progression, go, augmentation,
			services: state.services, stockAccess: state.stockAccess });
		renderOverview(ns, daemon, fleet, cfg.shareStatus);
		renderNextSteps(ns, { cfg, goal, progression, augmentation, actions: state.actions });
		renderAutomationSummary(ns, { cfg, daemon, fleet, stocks, contracts, progression, go, augmentation, darknet,
			actions: state.actions, services: state.services, stockAccess: state.stockAccess });
		ns.print("  More detail: restart with --dashboard-details true");
		return;
	}
	if (goal.floor > 0 || goal.error) {
		const funds = ns.getServerMoneyAvailable(HOME);
		const snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek();
		const fresh = snapshot?.type === "jit-status" && Number.isFinite(snapshot.generatedAt) && Date.now() >= snapshot.generatedAt && Date.now() - snapshot.generatedAt < 15000 && ns.isRunning(snapshot.pid);
		const eta = fresh && snapshot.income60 > 0 ? Math.max(0, goal.floor - funds) / snapshot.income60 : null;
		dashboardRow(ns, "Savings", goal.error || `${goal.label}: ${cash(funds)} / ${cash(goal.floor)} | ${funds >= goal.floor ? "FUNDED" : eta === null ? "ETA unknown" : `~${Math.ceil(eta)}s at gross hack income`}`);
	}
	if (fleet?.cloud?.investment) dashboardRow(ns, "RAM investment", fleet.cloud.investment);
	if (cfg.telemetryError) dashboardRow(ns, "Telemetry", cfg.telemetryError);
	else if (cfg.telemetrySummary) {
		const report = cfg.telemetrySummary;
		dashboardRow(ns, "History 1h", `${cash(report.earnings)} hacked | ${cash(report.spending)} RAM spending | ${report.recoveries} recoveries | ${report.count} samples`);
	}
	if (cfg.savingsStatus) dashboardRow(ns, "Savings policy", cfg.savingsStatus);
	if (cfg.shareStatus) dashboardRow(ns, "Sharing", sharingLabel(cfg.shareStatus));
	for (const job of cfg.utilityJobs || []) {
		const stale = job.type === "augmentation-plan" && job.report && Date.now() - job.report.generatedAt > 120000;
		dashboardRow(ns, job.type === "diagnostics" ? "Diagnostics" : "Augmentations", `${stale ? "STALE / " : ""}${job.state}: ${job.message}`);
		if (job.type === "diagnostics") {
			for (const issue of (job.report?.issues || []).slice(0, cfg.dashboardDetails ? 10 : 2)) dashboardRow(ns, "Warning", issue);
		}
	}
	if (cfg.dashboardDetails && cfg.augmentationPlan) {
		dashboardSection(ns, "Augmentation shopping plan");
		for (const item of cfg.augmentationPlan.order.slice(0, 8)) dashboardRow(ns, item.name,
			`${item.faction} | ${cash(item.price)} | rep gap ${Math.ceil(item.repGap)} | prerequisites ${item.prerequisites.join(", ") || "none"}`);
		dashboardRow(ns, "Basket", `${cash(cfg.augmentationPlan.total)} | ${cfg.augmentationPlan.multiplier === 1 ? "current-price lower bound" : `estimated at ${cfg.augmentationPlan.multiplier}x purchase inflation`}`);
	}

	if (daemon) {
		renderMoneyEngine(ns, daemon, true);
		if (daemon.mode === "running") renderHealth(ns, daemon, true);
		if (daemon.background) {
			dashboardSection(ns, "Background prep / separate target");
			dashboardRow(ns, "Background", daemon.background);
			if (daemon.prepHealth) dashboardRow(ns, "Prep health", daemon.prepHealth);
			if (daemon.prepModel) dashboardRow(ns, "Prep model", daemon.prepModel);
			if (daemon.prepRam) dashboardRow(ns, "Prep RAM", daemon.prepRam);
			if (daemon.prepNote) dashboardRow(ns, "Prep note", daemon.prepNote);
		}
	} else {
		dashboardSection(ns, "Income");
		dashboardRow(ns, "Money engine", processStatus(ns, DAEMON));
		dashboardRow(ns, "Status", "Waiting for daemon dashboard");
	}

	renderFleet(ns, fleet, true, daemon);
	renderStocks(ns, stocks, cfg, state.stockAccess);
	renderContracts(ns, contracts, cfg);
	renderProgression(ns, progression, cfg, state.actions);
	renderAugmentationLoop(ns, augmentation, cfg);
	renderGoStatus(ns, go, cfg, state.services);
	renderDarknet(ns, darknet, cfg);
	dashboardSection(ns, "Services");
	if (state.services) {
		for (const service of state.services) {
			dashboardRow(ns, service.name.replace("-manager.js", "").replace(".js", ""),
				`${serviceLabel(service)} | ${service.restarts} restarts`);
		}
		const last = [...state.services].filter(service => service.lastEvent).sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
		if (last) dashboardRow(ns, "Last recovery", `${last.name}: ${last.lastEvent}`);
	} else {
		dashboardRow(ns, "Money engine", processStatus(ns, DAEMON));
		dashboardRow(ns, "Managers", `Fleet: ${processHealth(ns, FLEET, fleetHealth)} | ` +
			`Contracts: ${cfg.contracts ? processHealth(ns, CONTRACTS, contractHealth) : "Disabled"} | ` +
			`Progression: ${cfg.progression ? processHealth(ns, PROGRESSION, progressionHealth) : "Disabled"}`);
	}
	if (daemon) renderTargetAnalysis(ns, daemon.targets);
}

function recoverableGoOwnershipStop(status) {
	return status?.terminal === true && /Unowned or interrupted game found/i.test(String(status.error || ""));
}

function prepareGoTakeoverRetry(ns, service, now = Date.now()) {
	const process = findProcess(ns, GO_BOT);
	if (process && !ns.kill(process.pid)) return false;
	const args = [...service.args];
	const index = args.findIndex(value => value === "--takeover" || String(value).startsWith("--takeover="));
	if (index < 0) args.push("--takeover", true);
	else if (String(args[index]).startsWith("--takeover=")) args[index] = "--takeover=true";
	else if (index + 1 < args.length && !String(args[index + 1]).startsWith("--")) args[index + 1] = true;
	else args.splice(index + 1, 0, true);
	service.args = args;
	service.pid = 0;
	service.state = "STOPPED";
	service.nextStartAt = 0;
	service.healthySince = null;
	service.staleSince = null;
	service.lastEvent = "Adopting the unfinished IPvGO board under takeover policy";
	service.lastEventAt = now;
	try { ns.getPortHandle(service.port).clear(); } catch {}
	return true;
}

function withWorldDaemonRoute(progression, fleet) {
	if (progression?.worldDaemon?.path?.length) return progression;
	const network = fleet?.network;
	const servers = Array.isArray(network?.servers) ? network.servers : [];
	const discovered = servers.includes("w0r1d_d43m0n");
	const path = discovered ? pathFromHome(network?.parents, "w0r1d_d43m0n") : [];
	return {
		...progression,
		worldDaemon: { host: "w0r1d_d43m0n", discovered, path },
	};
}

function renderOverview(ns, daemon, fleet, shareStatus = null) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Overview");

	if (!daemon) {
		row("Money engine", processStatus(ns, DAEMON));
		row("Status", "Waiting for daemon dashboard");
	} else if (daemon.mode === "multi") {
		row("Income 60s", `${cash(daemon.income60)}/s | model ${cash(daemon.model)}/s`);
		row("Targets", daemon.pipelines?.length
			? daemon.pipelines.map(p => `${p.target} ${p.mode}`).join(" | ")
			: "No active earning targets");
		if (Number.isFinite(Number(daemon.usedRam)) && Number.isFinite(Number(daemon.totalRam))) {
			const pctUsed = 100 * Number(daemon.usedRam) / Math.max(1, Number(daemon.totalRam));
			row("RAM online", `${formatRam(daemon.usedRam)} / ${formatRam(daemon.totalRam)} (${pctUsed.toFixed(1)}%)`);
		}
		const bg = daemon.backgroundPrep;
		if (bg?.target) row("Background", `${bg.target} | ${bg.status || "PREPARING"}${bg.eta ? ` | ETA ${dashboardTime(bg.eta)}` : ""}`);
	} else if (daemon.mode === "prep") {
		row("Target", `${daemon.target} | PREPARING`);
		row("Stage", `${daemon.stage || "working"}${daemon.wave ? ` | ${daemon.wave}` : ""}`);
		if (daemon.money) row("Money", daemon.money);
		if (daemon.security) row("Security", daemon.security);
	} else if (daemon.mode === "reconfigure") {
		row("Status", "RECONFIGURING");
		if (daemon.reason) row("Reason", daemon.reason);
	} else {
		const status = [daemon.state ? humanState(daemon.state) : "", daemon.hackStatus ? humanHackStatus(daemon.hackStatus) : ""]
			.filter(Boolean).join(" | ");
		row("Income 60s", `${daemon.income60 || "n/a"}${daemon.model ? ` | model ${daemon.model}` : ""}`);
		row("Target", `${daemon.target}${daemon.targetMode ? ` | ${daemon.targetMode}` : ""}${status ? ` | ${status}` : ""}`);
		if (daemon.money || daemon.security) row("Target health",
			`${daemon.money ? `money ${daemon.money}` : ""}${daemon.money && daemon.security ? " | " : ""}${daemon.security ? `security ${daemon.security}` : ""}`);
		if (daemon.pipeline) row("Pipeline", humanPipeline(daemon.pipeline));
		if (daemon.ramOnline) row("RAM online", daemon.ramOnline);
		if (daemon.background) row("Background", daemon.background);
	}

	if (fleet) {
		const network = fleet.network ?? {};
		const cloud = fleet.cloud ?? {};
		row("Fleet", `${Number(network.rooted) || 0}/${network.servers?.length || 0} rooted | ${network.hosts?.length || 0} workers | cloud ${Number(cloud.count) || 0}/${Number(cloud.limit) || 0}`);
	}
	if (shareStatus) row("Sharing", sharingLabel(shareStatus));
}

function renderNextSteps(ns, { cfg, goal, progression, augmentation, actions }) {
	const row = (label, value) => dashboardRow(ns, label, value);
	const entries = [];
	if (actions?.current) entries.push(["In progress", actions.current.reason]);
	const progressionAdvice = [progression?.nextObjective?.label, ...(progression?.recommendations || [])]
		.filter((value, index, all) => value && all.indexOf(value) === index && value !== actions?.current?.reason)
		.slice(0, cfg.dashboardDetails ? 4 : 2);
	for (const advice of progressionAdvice) entries.push(["Recommended", advice]);
	const bitRunners = progression?.backdoors?.find(target => target.host === "run4theh111z");
	if (bitRunners?.path?.length) entries.push(["BitRunners", bitRunners.path.join(" -> ")]);
	if (progression?.worldDaemon?.path?.length) entries.push(["World daemon", progression.worldDaemon.path.join(" -> ")]);
	if (cfg.augmentationActions && augmentation?.recommendation) entries.push(["Augmentation", augmentation.recommendation]);
	else if (cfg.augmentationPlan?.order?.length) {
		const next = cfg.augmentationPlan.order[0];
		entries.push(["Next augment", `${next.name} from ${next.faction} | ${cash(next.price)}`]);
	}
	if (goal?.error) entries.push(["Savings", goal.error]);
	else if (Number(goal?.floor) > 0) entries.push(["Savings", `${goal.label} | target ${cash(goal.floor)}`]);
	if (!entries.length) entries.push(["Status", "No player action needed right now"]);
	dashboardSection(ns, "Next up");
	for (const [label, value] of entries) row(label, value);
}

function renderAutomationSummary(ns, { cfg, daemon, fleet, stocks, contracts, progression, go, augmentation, darknet, actions, services, stockAccess }) {
	const row = (label, value) => dashboardRow(ns, label, value);
	const status = (state, value) => `[${state}] ${value}`;
	const managed = name => services?.find(service => service.name === name);
	const waiting = (name, message) => status("WAIT", `${serviceLabel(managed(name))}; ${message}`);
	dashboardSection(ns, "Automation priority");

	row("1 Money engine", daemon
		? status("OK", `${daemon.target || "scheduler active"}${daemon.state ? ` | ${humanState(daemon.state)}` : ""}`)
		: waiting(DAEMON, "waiting for daemon dashboard"));
	row("2 Fleet", fleet
		? status("OK", `${Number(fleet.network?.rooted) || 0}/${fleet.network?.servers?.length || 0} rooted | ${fleet.network?.hosts?.length || 0} workers`)
		: waiting(FLEET, "waiting for fleet status"));

	if (!cfg.progression) row("3 Progression", status("OFF", "disabled by profile"));
	else if (!progression) row("3 Progression", waiting(PROGRESSION, "waiting for snapshot"));
	else if (progression.error) row("3 Progression", status("BLOCKED", progression.error));
	else {
		row("3 Progression", status("OK", `${Number(progression.programsOwned) || 0}/${Number(progression.programsTotal) || 0} programs | ${Number(progression.backdoorsInstalled) || 0}/${Number(progression.backdoorsTotal) || 0} backdoors`));
	}

	if (!cfg.contracts) row("4 Contracts", status("OFF", "disabled by profile"));
	else if (!contracts) row("4 Contracts", waiting(CONTRACTS, "waiting for scan"));
	else if (contracts.error) row("4 Contracts", status("BLOCKED", contracts.error));
	else row("4 Contracts", status("OK", `${Number(contracts.waiting) || 0} waiting | ${Number(contracts.solved) || 0} solved`));

	if (cfg.augmentationActions) row("5 Aug loop", augmentation
		? status(augmentation.error ? "BLOCKED" : "OK", `${augmentation.state} / ${augmentation.phase || "WAIT"} | ${augmentation.action || augmentation.recommendation || "waiting"}`)
		: waiting(AUGMENTATION_MANAGER, "waiting for status"));
	else row("5 Aug loop", status("OFF", "disabled by profile"));

	if (!cfg.stocks) row("6 Stocks", status("OFF", "disabled by profile"));
	else if (!stockAccess?.ok) row("6 Stocks", status("LOCKED", `missing ${stockAccess?.missing?.join(", ") || "market access"}`));
	else if (!stocks) row("6 Stocks", waiting(STOCK_TRADER, "waiting for market snapshot"));
	else row("6 Stocks", status("OK", `session ${cashSigned(stocks.realized)} net | ${Number(stocks.sells) > 0 ? `avg ${cashSigned(stocks.avgTradePnl)} per trade` : "no closed trades"}`));

	const goService = services?.find(service => service.name === GO_BOT);
	if (!cfg.go) row("7 IPvGO", status("OFF", "disabled by profile"));
	else if (go?.terminal) row("7 IPvGO", status("BLOCKED", `${go.error || "board ownership requires review"}${cfg.goTakeover ? "" : "; enable --go-takeover true to adopt it"}`));
	else if (!go) row("7 IPvGO", status("WAIT", `${serviceLabel(goService)}; waiting for game status`));
	else row("7 IPvGO", status("OK", `${go.opponent || "unknown"} ${go.size || "?"}x${go.size || "?"} | ${Number(go.wins) || 0}W/${Number(go.losses) || 0}L | +${Number(go.bonusPercent || 0).toFixed(3)}% | takeover ${cfg.goTakeover ? "ON" : "OFF"}`));
	if (!cfg.darknet) row("8 Darknet", status("OFF", "disabled by profile"));
	else if (!darknet) row("8 Darknet", waiting(DARKNET_MANAGER, "waiting for status"));
	else if (!darknet.unlocked) row("8 Darknet", status("LOCKED", "saving for DarkscapeNavigator.exe"));
	else if (darknet.state === "BLOCKED" || (darknet.currentBlockers?.length && !Number(darknet.deployments))) row("8 Darknet", status("BLOCKED", darknet.blocker || formatDarknetBlocker(darknet.currentBlockers[0]) || darknet.last || "crawler could not start"));
	else {
		const cracking = Array.isArray(darknet.cracking) ? darknet.cracking : [];
		const activity = cracking.length ? `cracking ${cracking.slice(0, 3).map(item => item.host).join(", ")}${cracking.length > 3 ? ` +${cracking.length - 3}` : ""}` : (darknet.last || "waiting for probe");
		row("8 Darknet", status(cracking.length ? "RUN" : "OK", `${darknet.authenticated}/${darknet.known} authenticated | ${darknet.activeAgents} agents | ${activity}`));
		row("Darknet results", `${Number(darknet.deployments) || 0} deployments | ${Number(darknet.caches) || 0} caches | ${Number(darknet.blocked) || 0} blocked | ${Number(darknet.errors) || 0} errors`);
	}

	if (actions?.current) row("Active action", status("RUN", actions.current.reason));
	const diagnostics = cfg.utilityJobs?.find(job => job.type === "diagnostics");
	if (diagnostics) {
		const state = ["ERROR", "CONFLICT"].includes(diagnostics.state) ? "BLOCKED"
			: diagnostics.state === "READY" ? "OK" : "WAIT";
		row("9 Diagnostics", status(state, diagnostics.message));
	}
	else if (cfg.diagnostics) row("9 Diagnostics", status("WAIT", "not started"));
	else row("9 Diagnostics", status("OFF", "disabled by profile"));
	const planner = cfg.utilityJobs?.find(job => job.type === "augmentation-plan");
	if (planner) {
		const state = ["ERROR", "CONFLICT"].includes(planner.state) ? "BLOCKED"
			: planner.state === "READY" ? "OK" : "WAIT";
		row("10 Aug plan", status(state, planner.message));
	}
	else if (cfg.augmentations) row("10 Aug plan", status("WAIT", "not started"));
	else row("10 Aug plan", status("OFF", "disabled by profile"));
	if (services?.length) {
		const ready = services.filter(service => service.state === "RUNNING").length;
		const pending = services.filter(service => service.state !== "RUNNING")
			.map(service => `${service.name.replace("-manager.js", "").replace(".js", "")} ${serviceLabel(service)}`);
		row("Services", pending.length
			? status("WAIT", `${ready}/${services.length} running | ${pending.join(" | ")}`)
			: status("OK", `all ${services.length} running`));
	}
}

function renderAttention(ns, { cfg, goal, daemon, fleet, contracts, progression, go, augmentation, services }) {
	const notices = [];
	if (goal?.error) notices.push(["Savings", goal.error]);
	if (cfg?.telemetryError) notices.push(["Telemetry", cfg.telemetryError]);
	if (daemon?.reason && ["RECOVERING", "DRAINING"].includes(String(daemon.state).toUpperCase())) notices.push(["Money engine", daemon.reason]);
	if (daemon?.mode === "reconfigure" && daemon.reason) notices.push(["Money engine", daemon.reason]);
	if (fleet?.cloud?.error) notices.push(["Fleet", fleet.cloud.error]);
	if (contracts?.error) notices.push(["Contracts", contracts.error]);
	if (progression?.error) notices.push(["Progression", progression.error]);
	if (go?.terminal && go.error) notices.push(["IPvGO", go.error]);
	if (augmentation?.error) notices.push(["Aug loop", augmentation.error]);
	for (const job of cfg?.utilityJobs || []) {
		if (["ERROR", "CONFLICT"].includes(job.state)) notices.push([job.type === "diagnostics" ? "Diagnostics" : "Augmentations", job.message]);
		if (job.type === "diagnostics") {
			for (const issue of (job.report?.issues || []).slice(0, 2)) notices.push(["Warning", issue]);
		}
	}

	const recentService = services?.filter(service => service.lastEvent && !["RUNNING", "STARTING"].includes(service.state))
		.sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
	if (recentService && !(recentService.name === GO_BOT && go?.terminal) && Date.now() - Number(recentService.lastEventAt || 0) < 60_000) {
		notices.push(["Recovery", `${recentService.name}: ${recentService.lastEvent}`]);
	}

	if (!notices.length) return;
	dashboardSection(ns, "Attention");
	for (const [label, value] of notices) dashboardRow(ns, label, value);
}

function renderMoneyEngine(ns, daemon, details = false) {
	const row = (label, value) => dashboardRow(ns, label, value);
	if (daemon.mode === "multi") {
		dashboardSection(ns, "Combined income");
		row("Income 60s", `${cash(daemon.income60)}/s`);
		row("Model", `${cash(daemon.model)}/s estimate`);
		row("Run total", `${cash(daemon.earned)} earned`);
		row("Target slots", `${daemon.pipelines.length}/${daemon.limit} | priority ${daemon.priority}`);
		dashboardSection(ns, "Earning targets / independent recovery");
		for (const p of daemon.pipelines) {
			row(p.target, `${p.mode} | ${p.role} | ${cash(p.income60)}/s`);
			row("Pipe health", `${Object.values(p.misses).reduce((n, v) => n + v, 0)} misses | ${p.local} local | ${p.fallback} fallback`);
			if (p.mode === "WARMUP") row("First hack", `ETA ${Math.ceil(p.eta / 1000)}s`);
			if (details || !["LIVE", "WARMUP"].includes(p.mode)) row("Target note", p.note);
		}
		row("Admission", daemon.note);
		return;
	}
	dashboardSection(ns, "Income");
	if (daemon.mode === "reconfigure") {
		row("Status", "RECONFIGURING");
		if (daemon.reason) row("Reason", daemon.reason);
		return;
	}
	row("Target", `${daemon.target} | ${daemon.mode === "prep" ? "PREPARING" : daemon.targetMode || "unknown"}`);
	if (daemon.mode === "prep") {
		row("Stage", daemon.stage || "working");
		if (daemon.wave) row("Wave", daemon.wave);
		row("Income", "Preparing the active target; initial warmup follows");
	} else {
		if (daemon.state) row("State", daemon.state);
		if (daemon.hackStatus) row("Hack status", daemon.hackStatus);
		if (daemon.reason) row("Reason", daemon.reason);
		row("Income 60s", daemon.income60 || "n/a");
		if (daemon.model) row("Model", daemon.model);
		if (daemon.runTotal) row("Run total", daemon.runTotal);
		if (daemon.batchRate) row("Batch rate", daemon.batchRate);
		if (details && daemon.income10) row("Income 10s", daemon.income10);
	}
	if (daemon.money) row("Money", daemon.money);
	if (daemon.security) row("Security", daemon.security);
	if (details && daemon.steal) row("Steal", daemon.steal);
}

function renderTargetAnalysis(ns, targets) {
	dashboardTargets(ns, targets, 6);
}

function renderFleet(ns, fleet, details = false, daemon = null) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Fleet");
	if (!fleet) { row("Status", "Waiting for fleet snapshot"); return; }
	const network = fleet.network ?? {};
	const cloud = fleet.cloud ?? {};
	row("Network", `${Number(network.rooted) || 0}/${network.servers?.length || 0} rooted | ${network.hosts?.length || 0} worker hosts`);
	if (daemon?.ramOnline) row("RAM online", daemon.ramOnline);
	row("Cloud", `${Number(cloud.count) || 0}/${Number(cloud.limit) || 0} servers | ${formatRam(cloud.totalRam)}` +
		`${cloud.nextAction === "fleet maxed" ? " | MAXED" : ""}`);
	if (Number(cloud.stockReserveFloor) > 0) row("Stock reserve", `${cash(cloud.stockReserveFloor)} protected from cloud spend`);
	if (cloud.error) row("Cloud error", cloud.error);
	else if (cloud.nextAction && cloud.nextAction !== "fleet maxed") row("Cloud next", humanCloudAction(String(cloud.nextAction)));
	if (details) {
		row("Server sizes", `${formatRam(cloud.minRam)} min | ${formatRam(cloud.maxRam)} max | ${formatRam(cloud.ramLimit)} cap`);
		row("Cloud spend", cash(cloud.spent));
		if (daemon?.coreBonus) row("Core bonus", daemon.coreBonus);
		if (cloud.lastAction && cloud.lastAction !== "none") row("Last upgrade", humanCloudAction(String(cloud.lastAction)));
	}
}

function renderStocks(ns, stocks, cfg, access) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Stocks");
	if (!cfg.stocks) { row("Status", "Disabled"); return; }
	if (!access?.ok) { row("Status", `Locked: missing ${access?.missing?.join(", ") || "market access"}`); return; }
	if (!stocks) { row("Status", "Waiting for stock snapshot"); return; }
	row("State", stocks.state || "unknown");
	row("Portfolio", `${cash(stocks.equity)} equity | ${cash(stocks.exposure)} invested`);
	row("Cash", `${cash(stocks.cash)} | shared floor ${cash(stocks.reserveFloor)}`);
	row("Open P/L", `${cashSigned(stocks.openPnl)} unrealized`);
	row("Profit total", `${cashSigned(stocks.realized)} realized net this session | ${Number(stocks.sells) || 0} closed trades`);
	row("Per trade", Number(stocks.sells) > 0
		? `avg ${cashSigned(stocks.avgTradePnl)} | last ${cashSigned(stocks.lastTradePnl)} | ${Number(stocks.winningTrades) || 0}W/${Number(stocks.losingTrades) || 0}L`
		: "No closed trades yet");
	if (stocks.last) row("Last", stocks.last);
	if (cfg.dashboardDetails) {
		row("Trades", `${Number(stocks.buys) || 0} buys | ${Number(stocks.sells) || 0} sells | fees ${cash(stocks.fees)}`);
		row("Positions", String(Number(stocks.positions) || 0));
	}
}

function renderContracts(ns, contracts, cfg) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Coding contracts");
	if (!cfg.contracts) { row("Status", "Disabled"); return; }
	if (!contracts) { row("Status", "Waiting for contract scan"); return; }
	row("Results", `${Number(contracts.solved) || 0} solved | ${Number(contracts.found) || 0} found (session)`);
	if (contracts.error) row("Warning", contracts.error);
	if (Number(contracts.quarantined) || Number(contracts.unsupported)) {
		row("Skipped", `${Number(contracts.quarantined) || 0} quarantined | ${Number(contracts.unsupported) || 0} unsupported`);
	}
	if (contracts.lastReward && contracts.lastReward !== "none") row("Last reward", contracts.lastReward);
	if (cfg.dashboardDetails && contracts.lastAction) row("Last action", humanContractAction(contracts.lastAction));
}

function renderProgression(ns, progression, cfg, actions = null) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Progression");
	if (actions?.current) row("Action", `${actions.current.state.toUpperCase()}: ${actions.current.reason}`);
	if (actions?.lastResult) {
		const result = actions.lastResult;
		row("Last result", `${result.request.target}: ${result.state} / ${result.reason}`);
		if (result.restoration && !["restored", "not-needed"].includes(result.restoration)) row("Connection", result.restoration);
	}
	if (!cfg.progression) { row("Status", "Disabled"); return; }
	if (!progression) { row("Status", "Waiting for progression snapshot"); return; }
	if (progression.error) { row("Warning", progression.error); return; }
	row("Mode", cfg.progressionActions ? "Safe actions enabled" : "Planner only; no automatic actions");
	if (progression.nextObjective?.label) row("Next", progression.nextObjective.label);
	for (const recommendation of (progression.recommendations || []).slice(0, cfg.dashboardDetails ? 4 : 1)) row("Recommendation", recommendation);
	row("Unlocks", `${Number(progression.programsOwned) || 0}/${Number(progression.programsTotal) || 0} program unlocks | ` +
		`${Number(progression.backdoorsInstalled) || 0}/${Number(progression.backdoorsTotal) || 0} faction backdoors`);
	const bitRunners = progression.backdoors?.find(target => target.host === "run4theh111z");
	if (bitRunners?.path?.length) row("BitRunners", bitRunners.path.join(" -> "));
	if (progression.worldDaemon?.path?.length) row("World daemon", progression.worldDaemon.path.join(" -> "));
	if (cfg.dashboardDetails) {
		row("BitNode", `BN${Number(progression.currentNode) || "?"}`);
		row("Singularity", progression.singularity?.available ? `Available (${progression.singularity.source})` : "Locked; requires BN4 or Source-File 4");
		row("Source Files", formatSourceFiles(progression.sourceFiles));
		row("TOR router", progression.torOwned ? "Owned" : "Not owned");
		const ready = progression.backdoors?.find(target => target.ready);
		if (ready?.path?.length && ready.host !== bitRunners?.host) row("Route", ready.path.join(" -> "));
	}
	if (cfg.progressionActions) {
		const actor = progressionActorProcess(ns);
		if (actor) row("Action", actor.filename === PROGRESSION_BACKDOOR ? "Installing faction backdoor" : "Buying TOR / program unlock");
	}
}

function renderAugmentationLoop(ns, augmentation, cfg) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Augmentation loop");
	if (!cfg.augmentationActions) { row("Status", "Disabled; planning and recommendations remain active"); return; }
	if (!augmentation) { row("Status", "Starting / waiting for augmentation manager"); return; }
	row("Status", `${augmentation.state || "UNKNOWN"}${augmentation.phase ? ` | ${augmentation.phase}` : ""}`);
	if (augmentation.action) row("Last action", augmentation.action);
	if (augmentation.recommendation) row("Next", augmentation.recommendation);
	if (augmentation.formulas) row("Work model", `Exact Formulas | ${Number(augmentation.reputationPerSecond || 0).toFixed(3)} rep/s | share ${Number(augmentation.sharePower || 1).toFixed(3)}x${Number.isFinite(Number(augmentation.projectedFavor)) ? ` | projected favor ${Number(augmentation.projectedFavor).toFixed(2)}` : ""}`);
	row("Queued", `${Number(augmentation.queued) || 0} augmentation(s) | auto-install ${cfg.autoInstall ? `armed at ${cfg.minInstall}` : "disabled"}`);
}

function renderGoStatus(ns, go, cfg, services) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "IPvGO");
	if (!cfg.go) { row("Status", "Disabled"); return; }
	const service = services?.find(item => item.name === GO_BOT);
	if (!go) {
		row("Status", `${serviceLabel(service)} | waiting for game status`);
		return;
	}
	if (go.terminal) {
		row("Status", "BLOCKED");
		row("Reason", go.error || "Board ownership requires review");
		return;
	}
	row("Game", `${go.opponent || "unknown"} | ${go.size || "?"}x${go.size || "?"} | ${go.state || "RUNNING"}`);
	row("Session", `${Number(go.games) || 0} games | ${Number(go.wins) || 0} wins | ${Number(go.losses) || 0} losses | ${Number(go.moves) || 0} moves`);
	if (Number.isFinite(Number(go.blackScore)) && Number.isFinite(Number(go.whiteScore))) {
		row("Score", `you ${Number(go.blackScore)} | opponent ${Number(go.whiteScore)}`);
	}
	row("Bonus", `+${Number(go.bonusPercent || 0).toFixed(3)}% | streak ${Number(go.winStreak) || 0}`);
	if (go.last) row("Last action", go.last);
}

function renderHealth(ns, daemon, details = false) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Current pipeline");
	row("Planning model", ns.fileExists("Formulas.exe", "home") ? "Exact Formulas (live adoption)" : "Adaptive fallback");
	if (daemon.pipeline) row("Workers", daemon.pipeline);
	if (daemon.pipeMisses) row("Misses", daemon.pipeMisses);
	if (daemon.pipeDrift) row("Timing", daemon.pipeDrift);
	if (daemon.pipeRecovery) row("Recovery", daemon.pipeRecovery);
	if (daemon.restarts) row("Restarts", daemon.restarts);
	if (daemon.last && daemon.last !== "none") row("Last event", daemon.last);
	if (details) {
		dashboardSection(ns, "Session diagnostics");
		if (daemon.batches) row("Batches", daemon.batches);
		if (daemon.allocator) row("Allocator", daemon.allocator);
		if (daemon.misses) row("Misses", daemon.misses);
		if (daemon.recovery) row("Recovery", daemon.recovery);
		if (daemon.fallback) row("Fallback", daemon.fallback);
		if (daemon.loopLag) row("Loop lag", daemon.loopLag);
	}
}

function readDaemonDashboard(ns) {
	const process = findProcess(ns, DAEMON);
	if (!process) return null;
	const snapshot = typeof ns.getPortHandle === "function" ? ns.getPortHandle(PORTS.JIT_STATUS).peek() : null;
	if (snapshot?.type === "jit-status" && snapshot.version === 2 && snapshot.pid === process.pid &&
		Date.now() - snapshot.generatedAt <= 30_000 && snapshot.mode === "multi" && Array.isArray(snapshot.pipelines)) {
		return snapshot;
	}

	let logs;
	try { logs = ns.getScriptLogs(process.pid).map(String); }
	catch { return null; }
	if (!logs.length) return null;

	const prepHeader = findLog(logs, "JIT DAEMON :: PREP ::");
	if (prepHeader) {
		return {
			mode: "prep",
			target: prepHeader.split("JIT DAEMON :: PREP ::")[1].trim(),
			stage: field(logs, "Stage"),
			money: field(logs, "Money"),
			security: field(logs, "Security"),
			wave: field(logs, "Wave"),
			targets: parseTargets(logs),
		};
	}

	if (findLog(logs, "JIT DAEMON :: RECONFIGURE")) {
		return { mode: "reconfigure", reason: field(logs, "Reason") };
	}

	const header = findLog(logs, "JIT DAEMON ::");
	if (!header) return null;

	const headerMatch = header.match(/JIT DAEMON ::\s*(.*?)\s*:: hacking\s+(\d+)/);
	return {
		mode: "running",
		target: headerMatch?.[1] ?? "unknown",
		hackingLevel: headerMatch?.[2] ?? "",
		targetMode: field(logs, "Selection") || field(logs, "Target"),
		state: field(logs, "State"),
		money: field(logs, "Money"),
		security: field(logs, "Security"),
		income10: field(logs, "Income 10s"),
		income60: field(logs, "Income 60s"),
		runTotal: field(logs, "Run total"),
		model: field(logs, "Model"),
		steal: field(logs, "Steal"),
		background: field(logs, "Background"),
		prepRam: field(logs, "Prep RAM"),
		prepHealth: field(logs, "Prep health"),
		prepModel: field(logs, "Prep model"),
		prepNote: field(logs, "Prep note"),
		ramOnline: field(logs, "RAM online"),
		coreBonus: field(logs, "Core bonus"),
		pipeRecovery: field(logs, "Pipe recovery"),
		restarts: field(logs, "Restarts"),
		fallback: field(logs, "Fallback"),
		reason: field(logs, "Reason"),
		batchRate: field(logs, "Batch rate"),
		pipeline: field(logs, "Pipeline"),
		batches: field(logs, "Batches"),
		hackStatus: field(logs, "Hack status"),
		allocator: field(logs, "Allocator"),
		pipeMisses: field(logs, "Pipe misses"),
		pipeDrift: field(logs, "Pipe drift"),
		loopLag: field(logs, "Loop lag"),
		misses: field(logs, "Misses"),
		recovery: field(logs, "Recovery"),
		last: field(logs, "Last"),
		targets: parseTargets(logs),
	};
}

function parseTargets(logs) {
	const entries = [];
	// Accept the previous daemon while Filesync is updating the controller.
	const legacy = /^\s*(>)?\s*([^\s]+)\s+(\$\S+\/s)\s+steady:\s*(\$\S+\/s)\s+S:\s*([\d.]+%)\s+P:\s*(\S+)\s+prep:\s*(\S+)/;
	const compact = /^\s*(>)?\s*(\S+)\s+(\$\S+)\s+(\$\S+)\s+(.+)$/;
	for (const raw of logs) {
		const line = stripPrefix(raw);
		const old = line.match(legacy);
		if (old) {
			entries.push({ selected: Boolean(old[1]), name: old[2], effective: old[3],
				steady: old[4], steal: old[5], period: old[6], prep: old[7] });
			continue;
		}
		const match = line.match(compact);
		if (match) entries.push({ selected: Boolean(match[1]), name: match[2],
			effective: `${match[3]}/s`, steady: `${match[4]}/s`,
			prep: match[5].trim() === "ready" ? "0ms" : match[5].trim() });
	}
	return entries;
}

function field(logs, label) {
	for (let i = logs.length - 1; i >= 0; i--) {
		const line = stripPrefix(logs[i]);
		if (!line.startsWith(`${label} `)) continue;
		let value = line.slice(label.length).trim();
		// New dashboards wrap long values at 78 columns. Rejoin only their
		// dedicated continuation indent, never the next labeled field or table.
		for (let j = i + 1; j < logs.length && (/^ {17}\S/.test(logs[j]) || /^[║│] {17}\S/.test(logs[j])); j++) {
			value += ` ${stripPrefix(logs[j]).trim()}`;
		}
		return value;
	}
	return "";
}

function findLog(logs, text) {
	for (let i = logs.length - 1; i >= 0; i--) {
		const line = stripPrefix(logs[i]);
		if (line.includes(text)) return line;
	}
	return "";
}

function stripPrefix(line) {
	let text = String(line);
	for (const marker of ["JIT DAEMON ::", "TARGET ANALYSIS ::"]) {
		const index = text.indexOf(marker);
		if (index >= 0) {
			text = text.slice(index);
			break;
		}
	}
	return text.trimStart()
		.replace(/^[║│]\s?/, "")
		.replace(/\s*║$/, "")
		.replace(/\s*[═─]+[╗╢]$/, "")
		.trimStart();
}

function renderDarknet(ns, darknet, cfg) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Darknet");
	if (!cfg.darknet) { row("Status", "Disabled"); return; }
	if (!darknet) { row("Status", "Starting / waiting for coordinator"); return; }
	if (!darknet.unlocked) { row("Status", "Locked; DarkscapeNavigator.exe is the next Darknet prerequisite"); return; }
	if (darknet.state === "BLOCKED") row("Status", `Blocked: ${darknet.blocker || "crawler could not start"}`);
	row("Coverage", `${Number(darknet.authenticated) || 0}/${Number(darknet.known) || 0} authenticated | ${Number(darknet.activeAgents) || 0} active agents`);
	const cracking = Array.isArray(darknet.cracking) ? darknet.cracking : [];
	row("Activity", cracking.length ? `Cracking ${cracking.map(item => `${item.host} (${item.modelId || "unknown"})`).join(", ")}` : (darknet.last || "Waiting for probe"));
	row("Planning", darknet.formulas ? "Exact Darknet Formulas" : "Adaptive fallback; switches live when Formulas.exe appears");
	row("Loot", `${Number(darknet.caches) || 0} caches | ${Number(darknet.deployments) || 0} deployments | ${Number(darknet.blocked) || 0} blocked attempts`);
	row("Stability", `${Number(darknet.stasis) || 0} stasis links | auth +${(100 * Number(darknet.instability?.authenticationDurationMultiplier - 1 || 0)).toFixed(1)}% | timeout ${(100 * Number(darknet.instability?.authenticationTimeoutChance || 0)).toFixed(1)}%`);
	if (darknet.last) row("Last event", darknet.last);
	for (const blocker of (darknet.currentBlockers || []).slice(0, 5)) row("Blocker", formatDarknetBlocker(blocker));
	const risky = Object.entries(darknet.risky || {}).filter(([, enabled]) => enabled).map(([name]) => name);
	row("Risky policies", risky.length ? risky.join(", ") : "All disabled");
}

function formatDarknetBlocker(blocker) {
	if (!blocker) return "";
	const ram = Number.isFinite(blocker.freeRam) && Number.isFinite(blocker.requiredRam) ? ` | ${Number(blocker.freeRam).toFixed(2)}/${Number(blocker.requiredRam).toFixed(2)} GB` : "";
	return `${blocker.host || "server"}: ${blocker.reason || "blocked"}${ram}`;
}

function processStatus(ns, script) {
	return isRunning(ns, script) ? "Running" : "DOWN";
}

function processHealth(ns, script, health) {
	if (!isRunning(ns, script)) return "DOWN";
	if (health?.healthy) return "Healthy";
	return health?.label === "missing" ? "Starting" : `Stale (${formatAge(health?.age)})`;
}

function formatSourceFiles(sourceFiles) {
	if (!Array.isArray(sourceFiles) || !sourceFiles.length) return "None active";
	return sourceFiles.map(sf => `SF${sf.number}.${sf.level}`).join(", ");
}

function humanState(value) {
	if (value.startsWith("DRAINING ::")) return `Recovering safely - ${value.slice(11).trim()}`;
	return value === "RUNNING" ? "Running normally" : value;
}

function humanHackStatus(value) {
	return value
		.replace(/^LIVE/, "Live")
		.replace(/^WAITING/, "Waiting for first batch")
		.replace(/^ETA /, "First payout in ")
		.replace(/^DUE \+/, "Payout overdue by ")
		.replace("paid batch(es)", "profitable batches");
}

function humanPipeline(value) {
	return value
		.replace("running", "running workers")
		.replace("queued", "queued jobs")
		.replace("reservations", "RAM reservations");
}

function humanCloudAction(value) {
	return value
		.replace(/^buy /, "Buy ")
		.replace(/^bought /, "Bought ")
		.replace(/^upgrade /, "Upgrade ")
		.replace(/^upgraded /, "Upgraded ")
		.replace(/^waiting /, "Waiting ")
		.replace("fleet maxed", "Fleet is fully upgraded");
}

function humanContractAction(value) {
	return value
		.replace(/^no contracts found$/, "No contracts waiting")
		.replace(/^waiting for fleet snapshot$/, "Waiting for network scan")
		.replace(/^solved /, "Solved ")
		.replace(/^unsupported /, "Found unsupported contract: ")
		.replace(/^manual /, "Manual contract: ")
		.replace(/^quarantined /, "Skipped quarantined solver: ")
		.replace(/^dry-run solved /, "Dry-run validated ");
}

function formatAge(age) {
	return Number.isFinite(age) ? `${Math.max(0, age / 1000).toFixed(1)}s` : "missing";
}

function formatRam(gb) {
	const value = Math.max(0, Number(gb) || 0);
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} PB`;
	if (value >= 1024) return `${(value / 1024).toFixed(2)} TB`;
	return `${value.toFixed(0)} GB`;
}

function cashSigned(value) {
	const n = Number(value) || 0;
	return `${n >= 0 ? "+" : "-"}${cash(Math.abs(n))}`;
}

function cash(value) {
	const n = Number(value) || 0;
	for (const [threshold, suffix] of [
		[1e18, "Q"],
		[1e15, "q"],
		[1e12, "t"],
		[1e9, "b"],
		[1e6, "m"],
		[1e3, "k"],
	]) {
		if (Math.abs(n) >= threshold) return `$${(n / threshold).toFixed(2)}${suffix}`;
	}
	return `$${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

function clampFraction(value) {
	const n = Number(value);
	const fraction = n > 1 ? n / 100 : n;
	return Math.min(0.95, Math.max(0, Number.isFinite(fraction) ? fraction : 0.10));
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function augmentationAccess(ns) {
	try {
		return singularityAvailable(ns.getResetInfo());
	} catch { return false; }
}

function createSupervisorUtilities(cfg) {
	const jobs = [];
	if (cfg.diagnostics) jobs.push(createUtilityJob("doctor.js", "data/diagnostics.json", "diagnostics", [], 0));
	if (cfg.augmentations) jobs.push(createUtilityJob("augmentation-planner.js", "data/augmentation-plan.json", "augmentation-plan",
		["--focus", cfg.augmentationFocus, "--target", cfg.augmentationTarget, "--price-multiplier", cfg.augmentationMultiplier]));
	return jobs;
}

function validateSupervisorOptions(flags, cfg) {
	if (!["observe", "assist", "hands-off"].includes(String(flags.profile))) throw new Error("profile must be observe, assist, or hands-off");
	if (!["auto", "keep", "programs", "augmentations", "none"].includes(String(flags.savings))) throw new Error("savings must be auto, keep, programs, augmentations, or none");
	const amount = Number(flags["save-amount"]);
	if (!Number.isFinite(amount) || amount < -1 || (amount < 0 && amount !== -1)) throw new Error("save-amount must be nonnegative or -1 (unset)");
	if (amount >= 0 && !["auto", "keep"].includes(String(flags.savings))) throw new Error("Use save-amount or an automatic savings mode, not both");
	if (!["hacking", "all"].includes(cfg.augmentationFocus)) throw new Error("augmentation-focus must be hacking or all");
	if (!Number.isFinite(cfg.augmentationMultiplier) || cfg.augmentationMultiplier < 1) throw new Error("augmentation-price-multiplier must be at least 1");
	if (!Number.isFinite(cfg.cloudPayback) || cfg.cloudPayback <= 0) throw new Error("cloud-payback must be positive");
	if (!Number.isFinite(Number(flags["home-reserve"])) || Number(flags["home-reserve"]) < 0) throw new Error("home-reserve must be nonnegative");
	if (!Number.isSafeInteger(cfg.minInstall) || cfg.minInstall < 1) throw new Error("min-install must be a positive integer");
	if (!Number.isSafeInteger(cfg.darknetMaxAttempts) || cfg.darknetMaxAttempts < 25) throw new Error("darknet-max-attempts must be an integer of at least 25");
	if (!Number.isSafeInteger(cfg.darknetPhishThreads) || cfg.darknetPhishThreads < 1) throw new Error("darknet-phish-threads must be positive");
	if (!Number.isSafeInteger(cfg.darknetConcurrency) || cfg.darknetConcurrency < 1 || cfg.darknetConcurrency > 16) throw new Error("darknet-concurrency must be an integer from 1 to 16");
	if (!Number.isSafeInteger(cfg.darknetAgentThreads) || cfg.darknetAgentThreads < 1) throw new Error("darknet-agent-threads must be positive");
	if (cfg.autoInstall && !cfg.augmentationActions) throw new Error("auto-install requires augmentation-actions");
	if (cfg.savingsMode === "augmentations" && !cfg.augmentations) throw new Error("Augmentation savings requires augmentation planning");
}

function applySupervisorProfile(flags, args = []) {
	const profile = String(flags.profile || "observe"), explicit = new Set();
	for (const value of args || []) {
		const token = String(value);
		if (token.startsWith("--")) explicit.add(token.slice(2).split("=", 1)[0]);
	}
	const presets = PROFILE_DEFAULTS;
	if (!Object.hasOwn(presets, profile)) return flags;
	for (const [key, value] of Object.entries(presets[profile])) if (!explicit.has(key)) flags[key] = value;
	return flags;
}

async function saveSupervisorBootstrap(ns) {
	const args = Array.isArray(ns.args) ? [...ns.args] : [];
	if (!args.every(value => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
		throw new Error("Cannot persist invalid supervisor arguments for reset bootstrap");
	}
	await ns.write("data/supervisor-bootstrap.json", JSON.stringify({ version: 1, args, updatedAt: Date.now() }), "w");
}
