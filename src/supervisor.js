import { dashboardSection, dashboardRow, dashboardTargets } from "lib/dashboard.js";
import { PORTS } from "lib/ports.js";

const HOME = "home";
const DAEMON = "daemon.js";
const FLEET = "fleet-manager.js";
const CONTRACTS = "contract-manager.js";
const PROGRESSION = "progression-manager.js";
const PROGRESSION_PURCHASE = "progression-purchase.js";
const PROGRESSION_BACKDOOR = "progression-backdoor.js";
const CONTRACT_SELFTEST = "contract-selftest.js";
const HEARTBEAT_STALE_MS = 15_000;
const PROGRESSION_ACTION_RETRY_MS = 30_000;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["background-prep", true],
		["dashboard-details", false],
		["contracts", true],
		["progression", true],
		["progression-actions", false],
		["progression-cash-reserve", 0.10],
		["contract-selftest", false],
		["interval", 5_000],
	]);

	ns.disableLog("ALL");

	const cfg = {
		dashboardDetails: asBoolean(flags["dashboard-details"]),
		contracts: asBoolean(flags.contracts),
		progression: asBoolean(flags.progression),
		progressionActions: asBoolean(flags["progression-actions"]),
		progressionCashReserve: clampFraction(flags["progression-cash-reserve"]),
		contractSelftest: asBoolean(flags["contract-selftest"]),
		interval: Math.max(1_000, Number(flags.interval) || 5_000),
	};

	const required = [DAEMON, FLEET];
	if (cfg.contracts) required.push(CONTRACTS);
	if (cfg.progression) required.push(PROGRESSION);
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

	const daemonArgs = asBoolean(flags["background-prep"]) ? [] : ["--background-prep", false];
	if (cfg.dashboardDetails) daemonArgs.push("--dashboard-details", true);
	ensureRunning(ns, DAEMON, daemonArgs);

	let lastProgressionActionAt = 0;

	while (true) {
		// daemon.js still owns initial fleet-manager startup. Supervisor repairs
		// background managers if one exits or stops publishing heartbeats.
		ensureRunning(ns, FLEET);
		if (cfg.contracts) ensureRunning(ns, CONTRACTS);
		if (cfg.progression) ensureRunning(ns, PROGRESSION);

		const fleetStatus = ns.getPortHandle(PORTS.FLEET_STATUS).peek();
		const contractStatus = cfg.contracts
			? ns.getPortHandle(PORTS.CONTRACT_STATUS).peek()
			: null;
		const progressionStatus = cfg.progression
			? ns.getPortHandle(PORTS.PROGRESSION_STATUS).peek()
			: null;

		if (cfg.progression && cfg.progressionActions) {
			lastProgressionActionAt = maybeStartProgressionAction(
				ns,
				progressionStatus,
				cfg,
				lastProgressionActionAt
			);
		}

		const fleetHealth = heartbeatHealth(fleetStatus, "fleet-status");
		const contractHealth = cfg.contracts
			? heartbeatHealth(contractStatus, "contract-status")
			: disabledHealth();
		const progressionHealth = cfg.progression
			? heartbeatHealth(progressionStatus, "progression-status")
			: disabledHealth();

		if (!fleetHealth.healthy && isRunning(ns, FLEET)) {
			restart(ns, FLEET, `stale fleet heartbeat (${formatAge(fleetHealth.age)})`);
		}
		if (cfg.contracts && !contractHealth.healthy && isRunning(ns, CONTRACTS)) {
			restart(ns, CONTRACTS, `stale contract heartbeat (${formatAge(contractHealth.age)})`);
		}
		if (cfg.progression && !progressionHealth.healthy && isRunning(ns, PROGRESSION)) {
			restart(ns, PROGRESSION, `stale progression heartbeat (${formatAge(progressionHealth.age)})`);
		}

		render(ns, {
			cfg,
			fleetStatus,
			contractStatus,
			progressionStatus,
			fleetHealth,
			contractHealth,
			progressionHealth,
		});

		await ns.sleep(cfg.interval);
	}
}

function ensureRunning(ns, script, args = []) {
	if (isRunning(ns, script)) return;
	const pid = ns.run(script, 1, ...args);
	if (!pid) ns.print(`WARN: supervisor could not start ${script}`);
}

function restart(ns, script, reason) {
	ns.scriptKill(script, HOME);
	const pid = ns.run(script, 1);
	// Keep recovery chatter in the supervisor log. Do not spam the terminal.
	ns.print(`${script} restarted: ${reason}${pid ? ` (pid ${pid})` : " (start failed)"}`);
}

function isRunning(ns, script) {
	return ns.ps(HOME).some(process => process.filename === script);
}

function findProcess(ns, script) {
	return ns.ps(HOME).find(process => process.filename === script) ?? null;
}

async function runOnce(ns, script) {
	const pid = ns.run(script, 1);
	if (!pid) {
		ns.print(`WARN: unable to start ${script}`);
		return;
	}
	while (ns.isRunning(pid, HOME)) await ns.sleep(100);
}

function maybeStartProgressionAction(ns, progression, cfg, lastAttempt) {
	if (
		!progression ||
		typeof progression !== "object" ||
		progression.type !== "progression-status" ||
		progression.error ||
		!progression.singularity?.available ||
		Date.now() - lastAttempt < PROGRESSION_ACTION_RETRY_MS ||
		progressionActorProcess(ns)
	) {
		return lastAttempt;
	}

	const kind = progression.nextObjective?.kind;
	const script =
		kind === "tor" || kind === "program"
			? PROGRESSION_PURCHASE
			: kind === "backdoor"
				? PROGRESSION_BACKDOOR
				: "";

	if (!script) return lastAttempt;

	const args =
		script === PROGRESSION_PURCHASE
			? [
				"--status-port",
				PORTS.PROGRESSION_STATUS,
				"--cash-reserve",
				cfg.progressionCashReserve,
			]
			: [
				"--status-port",
				PORTS.PROGRESSION_STATUS,
				"--fleet-port",
				PORTS.FLEET_STATUS,
			];

	// One-shot actors only. No daemon hydra, no heartbeat sequel, no cinematic universe.
	const pid = ns.run(script, 1, ...args);
	if (!pid) ns.print(`WARN: unable to start ${script}`);
	return Date.now();
}

function progressionActorProcess(ns) {
	return ns
		.ps(HOME)
		.find(
			process =>
				process.filename === PROGRESSION_PURCHASE ||
				process.filename === PROGRESSION_BACKDOOR
		) ?? null;
}

function disabledHealth() {
	return { healthy: true, age: 0, label: "disabled" };
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

function render(ns, state) {
	const { cfg, fleetStatus, contractStatus, progressionStatus, fleetHealth, contractHealth, progressionHealth } = state;
	const daemon = readDaemonDashboard(ns);
	const fleet = fleetStatus?.type === "fleet-status" ? fleetStatus : null;
	const contracts = contractStatus?.type === "contract-status" ? contractStatus : null;
	const progression = progressionStatus?.type === "progression-status" ? progressionStatus : null;
	ns.clearLog();
	ns.print("BITBURNER AUTOMATION");
	if (daemon) {
		renderMoneyEngine(ns, daemon, cfg.dashboardDetails);
		if (daemon.mode === "running") renderHealth(ns, daemon, cfg.dashboardDetails);
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
	renderFleet(ns, fleet, cfg.dashboardDetails, daemon);
	renderContracts(ns, contracts, cfg);
	renderProgression(ns, progression, cfg);
	dashboardSection(ns, "Services");
	dashboardRow(ns, "Money engine", processStatus(ns, DAEMON));
	dashboardRow(ns, "Managers", `Fleet: ${processHealth(ns, FLEET, fleetHealth)} | ` +
		`Contracts: ${cfg.contracts ? processHealth(ns, CONTRACTS, contractHealth) : "Disabled"} | ` +
		`Progression: ${cfg.progression ? processHealth(ns, PROGRESSION, progressionHealth) : "Disabled"}`);
	if (cfg.dashboardDetails && daemon) renderTargetAnalysis(ns, daemon.targets);
	if (!cfg.dashboardDetails) ns.print("  More diagnostics: --dashboard-details true");
}

function renderMoneyEngine(ns, daemon, details = false) {
	const row = (label, value) => dashboardRow(ns, label, value);
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
	if (cloud.error) row("Cloud error", cloud.error);
	else if (cloud.nextAction && cloud.nextAction !== "fleet maxed") row("Cloud next", humanCloudAction(String(cloud.nextAction)));
	if (details) {
		row("Server sizes", `${formatRam(cloud.minRam)} min | ${formatRam(cloud.maxRam)} max | ${formatRam(cloud.ramLimit)} cap`);
		row("Cloud spend", cash(cloud.spent));
		if (daemon?.coreBonus) row("Core bonus", daemon.coreBonus);
		if (cloud.lastAction && cloud.lastAction !== "none") row("Last upgrade", humanCloudAction(String(cloud.lastAction)));
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

function renderProgression(ns, progression, cfg) {
	const row = (label, value) => dashboardRow(ns, label, value);
	dashboardSection(ns, "Progression");
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

	const logs = ns.getScriptLogs(process.pid).map(String);
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
		targetMode: field(logs, "Target"),
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
	if (health.healthy) return "Healthy";
	return health.label === "missing" ? "Starting" : `Stale (${formatAge(health.age)})`;
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
