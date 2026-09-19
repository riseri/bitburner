import { createUtilityJob, tickUtilityJob, currentAugmentationPlan, updateSupervisorSavings } from "lib/supervised-utilities.js";
import { readSavings, writeSavings } from "lib/savings.js";
import { loadTelemetry, recordTelemetry, summarizeTelemetry } from "lib/telemetry.js";
import { dashboardSection, dashboardRow, dashboardTargets, dashboardTime } from "lib/dashboard.js";
import { PORTS } from "lib/ports.js";
import { createService, tickService, serviceLabel, readArgument } from "lib/service-lifecycle.js";
import { createActionState, tickProgressionActions, actorProcesses } from "lib/progression-dispatch.js";

const HOME = "home";
const DAEMON = "daemon.js";
const FLEET = "fleet-manager.js";
const CONTRACTS = "contract-manager.js";
const PROGRESSION = "progression-manager.js";
const PROGRESSION_PURCHASE = "progression-purchase.js";
const PROGRESSION_BACKDOOR = "progression-backdoor.js";
const STOCK_TRADER = "stock-trader.js";
const GO_BOT = "go-bot.js";
const CONTRACT_SELFTEST = "contract-selftest.js";

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
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
		["contract-selftest", false],
		["interval", 5_000],
		["telemetry", true],
		["diagnostics", true],
		["augmentations", true],
		["augmentation-focus", "hacking"],
		["augmentation-target", ""],
		["augmentation-price-multiplier", 1],
		["savings", "auto"],
		["save-amount", -1],
		["save-label", "Savings"],
		["save-target", ""],
		["cloud-roi", true],
		["cloud-payback", 1800],
		["home-reserve", 8],
	]);

	ns.disableLog("ALL");
	if (ns.getHostname() !== HOME || ns.ps(HOME).some(process => process.filename === "supervisor.js" && process.pid !== ns.pid)) {
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
		savingsMode: Number(flags["save-amount"]) >= 0 ? "fixed" : String(flags.savings),
		cloudRoi: asBoolean(flags["cloud-roi"]),
		cloudPayback: Number(flags["cloud-payback"]),
		contracts: asBoolean(flags.contracts),
		progression: asBoolean(flags.progression),
		progressionActions: asBoolean(flags["progression-actions"]),
		progressionCashReserve: clampFraction(flags["progression-cash-reserve"]),
		stocks: asBoolean(flags.stocks),
		stockCashReserve: clampFraction(flags["stock-cash-reserve"]),
		go: asBoolean(flags.go),
		contractSelftest: asBoolean(flags["contract-selftest"]),
		interval: Math.max(1_000, Number(flags.interval) || 5_000),
	};

	validateSupervisorOptions(flags, cfg);
	const required = [DAEMON, FLEET];
	if (cfg.contracts) required.push(CONTRACTS);
	if (cfg.progression) required.push(PROGRESSION);
	if (cfg.stocks) required.push(STOCK_TRADER);
	if (cfg.go) required.push(GO_BOT);
	if (cfg.progression && cfg.progressionActions) {
		required.push(PROGRESSION_PURCHASE, PROGRESSION_BACKDOOR);
	}

	for (const script of required) {
		if (!ns.fileExists(script, HOME)) {
			ns.tprint(`ERROR: supervisor missing ${script}`);
			return;
		}
	}

	if (cfg.contractSelftest && ns.fileExists(CONTRACT_SELFTEST, HOME)) {
		await runOnce(ns, CONTRACT_SELFTEST);
	}

	if (![1, 2].includes(Number(flags["max-targets"]))) throw new Error("max-targets must be 1 or 2");
	const daemonArgs = asBoolean(flags["background-prep"]) ? [] : ["--background-prep", false];
	if (Number(flags["max-targets"]) !== 2) daemonArgs.push("--max-targets", Number(flags["max-targets"]));
	if (cfg.dashboardDetails) daemonArgs.push("--dashboard-details", true);
	const utilityReserve = Math.max(0,
		cfg.diagnostics ? ns.getScriptRam("doctor.js", HOME) : 0,
		cfg.augmentations && augmentationAccess(ns) ? ns.getScriptRam("augmentation-planner.js", HOME) : 0,
		cfg.progression && cfg.progressionActions ? ns.getScriptRam(PROGRESSION_PURCHASE, HOME) : 0,
		cfg.progression && cfg.progressionActions ? ns.getScriptRam(PROGRESSION_BACKDOOR, HOME) : 0);
	daemonArgs.push("--home-reserve", Math.max(Number(flags["home-reserve"]), utilityReserve + 8));
	const services = createManagedServices(ns, cfg, daemonArgs);
	const actions = createActionState();
	const jobs = createSupervisorUtilities(cfg);
	if (cfg.savingsMode === "fixed") await writeSavings(ns, Number(flags["save-amount"]), flags["save-label"], flags["save-target"]);
	else if (cfg.savingsMode === "none") await writeSavings(ns, 0, "No savings goal");
	const telemetry = cfg.telemetry ? loadTelemetry(ns) : null;

	while (true) {
		// Keep optional child computations out of the supervisor and serialize their RAM use.
		for (const job of jobs) {
			const other = jobs.find(candidate => candidate !== job && ns.ps(HOME).some(p => p.filename === candidate.script));
			const gate = job.type === "augmentation-plan" && !augmentationAccess(ns) ? "Singularity is locked"
				: other ? `Waiting for ${other.script}` : "";
			tickUtilityJob(ns, job, gate);
		}
		cfg.utilityJobs = jobs;
		cfg.augmentationPlan = currentAugmentationPlan(ns, jobs.find(job => job.type === "augmentation-plan"));
		try { await updateSupervisorSavings(ns, cfg, cfg.augmentationPlan); }
		catch (error) { cfg.savingsStatus = `Savings update failed: ${String(error.message || error)}`; }
		const stockGate = stockAccess(ns);
		for (const service of services) {
			if (service.name === STOCK_TRADER && !stockGate.ok) {
				blockStockService(ns, service, stockGate);
				continue;
			}
			if (service.name === GO_BOT) {
				const stopped = goSafetyStop(ns, service);
				if (stopped) {
					blockGoService(ns, service, stopped);
					continue;
				}
			}
			tickService(ns, service);
		}
		const snapshot = name => {
			const service = services.find(item => item.name === name);
			return service?.port ? ns.getPortHandle(service.port).peek() : null;
		};
		cfg.fleetStatusPort = services.find(service => service.name === FLEET).port;
		const fleetStatus = snapshot(FLEET), contractStatus = snapshot(CONTRACTS),
			progressionStatus = snapshot(PROGRESSION), stockStatus = snapshot(STOCK_TRADER),
			goStatus = snapshot(GO_BOT);
		tickProgressionActions(ns, actions, progressionStatus, cfg);
		if (telemetry) await recordTelemetry(ns, telemetry, cfg.fleetStatusPort);
		cfg.telemetryError = telemetry?.error || "";
		if (telemetry) cfg.telemetrySummary = summarizeTelemetry(telemetry.samples, Date.now() - 3600000);
		render(ns, { cfg, services, actions, fleetStatus, contractStatus, progressionStatus, stockStatus, goStatus, stockAccess: stockGate });
		await ns.sleep(cfg.interval);
	}
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
	const reserved = [PORTS.WORKER_EVENTS, PORTS.CONTRACT_STATUS, PORTS.JIT_STATUS,
		PORTS.PROGRESSION_STATUS, PORTS.JIT_CONTROL, PORTS.PROGRESSION_ACTION, PORTS.STOCK_STATUS, PORTS.GO_STATUS];
	if (!Number.isSafeInteger(fleetPort) || fleetPort <= 0 || reserved.includes(fleetPort)) {
		throw new Error("Fleet status port must not collide with a reserved automation channel");
	}
	if (existingDaemon && Number(readArgument(existingDaemon.args, "--fleet-port", PORTS.FLEET_STATUS)) !== fleetPort) {
		throw new Error("Existing daemon and fleet use different fleet ports; align their arguments explicitly");
	}
	// New dependents follow the adopted fleet; existing dependents retain their own args.
	const launchDaemonArgs = existingDaemon ? daemonArgs : [...daemonArgs, "--fleet-port", fleetPort];
	const services = [createService(FLEET, fleetArgs, "fleet-status", fleetPort),
		createService(DAEMON, launchDaemonArgs)];
	if (cfg.contracts) services.push(createService(CONTRACTS, ["--fleet-port", fleetPort], "contract-status", PORTS.CONTRACT_STATUS));
	if (cfg.progression) services.push(createService(PROGRESSION, ["--fleet-port", fleetPort], "progression-status", PORTS.PROGRESSION_STATUS));
	if (cfg.stocks) services.push(createService(STOCK_TRADER,
		["--port", PORTS.STOCK_STATUS, "--cash-reserve", cfg.stockCashReserve], "stock-status", PORTS.STOCK_STATUS));
	// Go publishes status for the dashboard, but slow opponent API calls are allowed to wait indefinitely.
	// Process liveness owns restart decisions; the generic heartbeat watchdog does not.
	if (cfg.go) services.push(createService(GO_BOT, ["--port", PORTS.GO_STATUS], "go-status", PORTS.GO_STATUS, false));
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
	if (service.lastEvent !== reason) {
		service.lastEvent = reason;
		service.lastEventAt = now;
	}
	return service;
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
	const { cfg, fleetStatus, contractStatus, progressionStatus, stockStatus, goStatus, fleetHealth, contractHealth, progressionHealth } = state;
	const daemon = readDaemonDashboard(ns);
	const fleet = fleetStatus?.type === "fleet-status" ? fleetStatus : null;
	const contracts = contractStatus?.type === "contract-status" ? contractStatus : null;
	const progression = progressionStatus?.type === "progression-status" ? progressionStatus : null;
	const stocks = stockStatus?.type === "stock-status" ? stockStatus : null;
	const go = goStatus?.type === "go-status" ? goStatus : null;

	ns.clearLog();
	ns.print("BITBURNER AUTOMATION");
	const goal = readSavings(ns);
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

	if (!cfg.dashboardDetails) {
		renderOverview(ns, daemon, fleet);
		renderAutomationSummary(ns, { cfg, stocks, contracts, progression, go, actions: state.actions, services: state.services, stockAccess: state.stockAccess });
		renderAttention(ns, { daemon, fleet, contracts, progression, go, services: state.services });
		ns.print("  Details: restart with --dashboard-details true");
		return;
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
	renderGoStatus(ns, go, cfg, state.services);
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

function renderOverview(ns, daemon, fleet) {
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
}

function renderAutomationSummary(ns, { cfg, stocks, contracts, progression, go, actions, services, stockAccess }) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Automation");

	if (!cfg.stocks) row("Stocks", "Disabled");
	else if (!stockAccess?.ok) row("Stocks", `Locked: missing ${stockAccess?.missing?.join(", ") || "market access"}`);
	else if (!stocks) row("Stocks", "Starting / waiting for market snapshot");
	else row("Stocks", `${stocks.state || "running"} | session ${cashSigned(stocks.realized)} realized net | ${Number(stocks.sells) > 0 ? `avg ${cashSigned(stocks.avgTradePnl)} / closed trade` : "no closed trades yet"}`);

	if (!cfg.contracts) row("Contracts", "Disabled");
	else if (!contracts) row("Contracts", "Starting / waiting for scan");
	else row("Contracts", `${Number(contracts.waiting) || 0} waiting | ${Number(contracts.solved) || 0} solved | ${Number(contracts.found) || 0} found`);

	if (!cfg.progression) row("Progression", "Disabled");
	else if (!progression) row("Progression", "Starting / waiting for snapshot");
	else if (progression.error) row("Progression", `Blocked: ${progression.error}`);
	else {
		const next = progression.nextObjective?.label || "No immediate objective";
		row("Progression", `${next} | ${Number(progression.programsOwned) || 0}/${Number(progression.programsTotal) || 0} programs | ${Number(progression.backdoorsInstalled) || 0}/${Number(progression.backdoorsTotal) || 0} backdoors`);
	}

	const goService = services?.find(service => service.name === GO_BOT);
	if (!cfg.go) row("IPvGO", "Disabled");
	else if (go?.terminal) row("IPvGO", `BLOCKED | ${go.error || "board ownership requires review"}`);
	else if (!go) row("IPvGO", `${serviceLabel(goService)} | waiting for game status`);
	else row("IPvGO", `${go.opponent || "unknown"} ${go.size || "?"}x${go.size || "?"} | ${go.state || "RUNNING"} | session ${Number(go.wins) || 0}W/${Number(go.losses) || 0}L | bonus +${Number(go.bonusPercent || 0).toFixed(3)}%`);

	if (actions?.current) row("Active action", `${actions.current.state.toUpperCase()}: ${actions.current.reason}`);
	if (services?.length) {
		const summary = services.map(service => {
			const name = service.name.replace("-manager.js", "").replace(".js", "");
			return `${name} ${serviceLabel(service)}`;
		}).join(" | ");
		row("Services", summary);
	}
}

function renderAttention(ns, { daemon, fleet, contracts, progression, go, services }) {
	const notices = [];
	if (daemon?.reason && ["RECOVERING", "DRAINING"].includes(String(daemon.state).toUpperCase())) notices.push(["Money engine", daemon.reason]);
	if (daemon?.mode === "reconfigure" && daemon.reason) notices.push(["Money engine", daemon.reason]);
	if (fleet?.cloud?.error) notices.push(["Fleet", fleet.cloud.error]);
	if (contracts?.error) notices.push(["Contracts", contracts.error]);
	if (progression?.error) notices.push(["Progression", progression.error]);
	if (go?.terminal && go.error) notices.push(["IPvGO", go.error]);

	const recentService = services?.filter(service => service.lastEvent)
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
	row("Unlocks", `${Number(progression.programsOwned) || 0}/${Number(progression.programsTotal) || 0} port programs | ` +
		`${Number(progression.backdoorsInstalled) || 0}/${Number(progression.backdoorsTotal) || 0} faction backdoors`);
	if (cfg.dashboardDetails) {
		row("BitNode", `BN${Number(progression.currentNode) || "?"}`);
		row("Singularity", progression.singularity?.available ? `Available (${progression.singularity.source})` : "Locked; requires BN4 or Source-File 4");
		row("Source Files", formatSourceFiles(progression.sourceFiles));
		row("TOR router", progression.torOwned ? "Owned" : "Not owned");
		const ready = progression.backdoors?.find(target => target.ready);
		if (ready?.path?.length) row("Route", ready.path.join(" -> "));
	}
	if (cfg.progressionActions) {
		const actor = progressionActorProcess(ns);
		if (actor) row("Action", actor.filename === PROGRESSION_BACKDOOR ? "Installing faction backdoor" : "Buying TOR / port program");
	}
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
		for (let j = i + 1; j < logs.length && /^ {17}\S/.test(logs[j]); j++) {
			value += ` ${logs[j].trim()}`;
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
	for (const marker of ["JIT DAEMON ::", "TARGET ANALYSIS ::"]) {
		const index = line.indexOf(marker);
		if (index >= 0) return line.slice(index);
	}
	return line.trimStart();
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

function humanSteal(value) {
	return value.replace("| chance", "per batch | success chance");
}

function humanBatchRate(value) {
	return value
		.replace("/s actual", " batches/sec")
		.replace("/s model", " batches/sec expected");
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

function humanBatches(value) {
	return value.replace("recovered", "safely recovered");
}

function humanAllocator(value) {
	return value
		.replace("skipped slots", "batch slots skipped")
		.replace("worst streak", "longest streak");
}

function humanTiming(value) {
	return value
		.replace("avg", "average drift")
		.replace("| max", "| worst drift")
		.replace("| spacing", "| closest spacing");
}

function humanLoopLag(value) {
	return value
		.replace("max", "worst")
		.replace("current", "current pipeline")
		.replace("lifetime", "all-time");
}

function humanRecovery(value) {
	return value
		.replace("drain(s)", "safe pipeline drains")
		.replace("cancelled H chunks", "cancelled hack jobs");
}

function humanPhaseCounters(value) {
	return value
		.replace(/H:/g, "hack ")
		.replace(/W1:/g, "weaken-1 ")
		.replace(/G:/g, "grow ")
		.replace(/W2:/g, "weaken-2 ");
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

function hasNonZeroCounters(value) {
	if (!value) return false;
	// Read values after the colon, not the digits in the phase names W1/W2.
	const counters = [...value.matchAll(/(?:H|W1|G|W2):\s*(\d+)/g)];
	return counters.some(match => Number(match[1]) > 0);
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
		const reset = ns.getResetInfo();
		return reset.currentNode === 4 || Number(reset.ownedSF?.get?.(4)) > 0;
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
	if (!["auto", "keep", "programs", "augmentations", "none"].includes(String(flags.savings))) throw new Error("savings must be auto, keep, programs, augmentations, or none");
	const amount = Number(flags["save-amount"]);
	if (!Number.isFinite(amount) || amount < -1 || (amount < 0 && amount !== -1)) throw new Error("save-amount must be nonnegative or -1 (unset)");
	if (amount >= 0 && !["auto", "keep"].includes(String(flags.savings))) throw new Error("Use save-amount or an automatic savings mode, not both");
	if (!["hacking", "all"].includes(cfg.augmentationFocus)) throw new Error("augmentation-focus must be hacking or all");
	if (!Number.isFinite(cfg.augmentationMultiplier) || cfg.augmentationMultiplier < 1) throw new Error("augmentation-price-multiplier must be at least 1");
	if (!Number.isFinite(cfg.cloudPayback) || cfg.cloudPayback <= 0) throw new Error("cloud-payback must be positive");
	if (!Number.isFinite(Number(flags["home-reserve"])) || Number(flags["home-reserve"]) < 0) throw new Error("home-reserve must be nonnegative");
	if (cfg.savingsMode === "augmentations" && !cfg.augmentations) throw new Error("Augmentation savings requires augmentation planning");
}
