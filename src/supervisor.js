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

		const fleetStatus = ns.getPortHandle(PORTS.FLEET_STATUS).peek();
		const contractStatus = cfg.contracts
			? ns.getPortHandle(PORTS.CONTRACT_STATUS).peek()
			: null;

		const fleetHealth = heartbeatHealth(fleetStatus, "fleet-status");
		const contractHealth = cfg.contracts
			? heartbeatHealth(contractStatus, "contract-status")
			: { healthy: true, age: 0, label: "disabled" };

		if (!fleetHealth.healthy && isRunning(ns, FLEET)) {
			restart(ns, FLEET, `stale fleet heartbeat (${formatAge(fleetHealth.age)})`);
		}

		if (cfg.contracts && !contractHealth.healthy && isRunning(ns, CONTRACTS)) {
			restart(ns, CONTRACTS, `stale contract heartbeat (${formatAge(contractHealth.age)})`);
		}

		render(
			ns,
			fleetStatus,
			contractStatus,
			fleetHealth,
			contractHealth,
			cfg
		);

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

function findProcess(ns, script) {
	return ns.ps(HOME).find(process => process.filename === script) ?? null;
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

function render(ns, fleetStatus, contractStatus, fleetHealth, contractHealth, cfg) {
	const daemon = readDaemonDashboard(ns);
	const fleet = fleetStatus?.type === "fleet-status" ? fleetStatus : null;
	const contracts = contractStatus?.type === "contract-status" ? contractStatus : null;

	ns.clearLog();
	ns.print("BITBURNER AUTOMATION");
	ns.print("====================");
	ns.print("");

	ns.print("SYSTEM");
	ns.print(`  Money engine     ${processStatus(ns, DAEMON)}`);
	ns.print(`  Fleet manager    ${processHealth(ns, FLEET, fleetHealth)}`);
	ns.print(`  Contract hunter  ${cfg.contracts ? processHealth(ns, CONTRACTS, contractHealth) : "Disabled"}`);
	ns.print("");

	if (daemon) {
		renderMoneyEngine(ns, daemon);
		renderTargetAnalysis(ns, daemon.targets);
	} else {
		ns.print("MONEY ENGINE");
		ns.print("  Waiting for daemon status...");
		ns.print("");
	}

	renderFleet(ns, fleet);
	renderContracts(ns, contracts, cfg);

	if (daemon) {
		renderHealth(ns, daemon);
	}
}

function renderMoneyEngine(ns, daemon) {
	ns.print("MONEY ENGINE");

	if (daemon.mode === "prep") {
		ns.print(`  Target           ${daemon.target}`);
		ns.print(`  Status           Preparing target (${daemon.stage || "working"})`);
		if (daemon.money) ns.print(`  Target money     ${daemon.money}`);
		if (daemon.security) ns.print(`  Security         ${daemon.security}`);
		if (daemon.wave) ns.print(`  Prep progress    ${daemon.wave}`);
		ns.print("");
		return;
	}

	if (daemon.mode === "reconfigure") {
		ns.print("  Status           Reconfiguring the hacking pipeline");
		if (daemon.reason) ns.print(`  Reason           ${daemon.reason}`);
		ns.print("");
		return;
	}

	const selection = daemon.targetMode === "AUTO" ? "automatic selection" : "locked target";
	ns.print(`  Target           ${daemon.target} (${selection})`);
	if (daemon.hackingLevel) ns.print(`  Hacking level    ${daemon.hackingLevel}`);
	if (daemon.state) ns.print(`  Status           ${humanState(daemon.state)}`);
	if (daemon.income60 || daemon.income10) {
		ns.print(
			`  Income           ${daemon.income60 || "n/a"} 1m avg` +
			`${daemon.income10 ? ` | ${daemon.income10} recent` : ""}`
		);
	}
	if (daemon.model) ns.print(`  Expected income  ${daemon.model}`);
	if (daemon.runTotal) ns.print(`  Session profit   ${daemon.runTotal}`);
	if (daemon.money) ns.print(`  Target money     ${daemon.money}`);
	if (daemon.security) ns.print(`  Security         ${daemon.security}`);
	if (daemon.steal) ns.print(`  Batch strategy   ${humanSteal(daemon.steal)}`);
	if (daemon.batchRate) ns.print(`  Batch pace       ${humanBatchRate(daemon.batchRate)}`);
	ns.print("");
}

function renderTargetAnalysis(ns, targets) {
	if (!targets?.length) return;

	ns.print("BEST MONEY TARGETS (NEXT 10 MIN)");
	for (const entry of targets) {
		const marker = entry.selected ? ">" : " ";
		const readiness = entry.prep === "0ms" ? "ready now" : `prep ${entry.prep}`;
		ns.print(
			`${marker} ${entry.name.padEnd(18)} ` +
			`${entry.effective.padStart(11)} effective | ` +
			`${entry.steady.padStart(11)} steady | ` +
			`steal ${entry.steal.padStart(5)} | ` +
			`cycle ${entry.period.padStart(6)} | ${readiness}`
		);
	}
	ns.print("");
}

function renderFleet(ns, fleet) {
	ns.print("INFRASTRUCTURE");
	if (!fleet) {
		ns.print("  Waiting for fleet status...");
		ns.print("");
		return;
	}

	const network = fleet.network ?? {};
	const cloud = fleet.cloud ?? {};
	const servers = Array.isArray(network.servers) ? network.servers.length : 0;
	const hosts = Array.isArray(network.hosts) ? network.hosts.length : 0;

	ns.print(`  Root access      ${Number(network.rooted) || 0}/${servers} servers`);
	ns.print(`  Worker servers   ${hosts}`);
	ns.print(
		`  Cloud fleet      ${Number(cloud.count) || 0}/${Number(cloud.limit) || 0} servers` +
		` | ${formatRam(cloud.totalRam)} total RAM`
	);
	if ((Number(cloud.count) || 0) > 0) {
		ns.print(
			`  Server sizes     ${formatRam(cloud.minRam)} smallest | ` +
			`${formatRam(cloud.maxRam)} largest | ${formatRam(cloud.ramLimit)} max`
		);
	}
	if (Number(cloud.spent) > 0) {
		ns.print(`  Cloud invested   ${cash(cloud.spent)}`);
	}
	if (cloud.nextAction) ns.print(`  Next upgrade      ${humanCloudAction(String(cloud.nextAction))}`);
	if (cloud.lastAction && cloud.lastAction !== "none") {
		ns.print(`  Last upgrade      ${humanCloudAction(String(cloud.lastAction))}`);
	}
	if (cloud.error) ns.print(`  Fleet warning     ${cloud.error}`);
	ns.print("");
}

function renderContracts(ns, contracts, cfg) {
	ns.print("CODING CONTRACTS");
	if (!cfg.contracts) {
		ns.print("  Automation       Disabled");
		ns.print("");
		return;
	}
	if (!contracts) {
		ns.print("  Waiting for contract scan...");
		ns.print("");
		return;
	}

	ns.print(`  Solved            ${Number(contracts.solved) || 0}`);
	ns.print(`  Found             ${Number(contracts.found) || 0}`);
	if (Number(contracts.unsupported) > 0) {
		ns.print(`  Unsupported       ${Number(contracts.unsupported)}`);
	}
	if (Number(contracts.quarantined) > 0) {
		ns.print(`  Quarantined       ${Number(contracts.quarantined)} solver type(s)`);
	}
	if (contracts.lastReward && contracts.lastReward !== "none") {
		ns.print(`  Last reward       ${contracts.lastReward}`);
	}
	if (contracts.lastAction) ns.print(`  Current activity  ${humanContractAction(String(contracts.lastAction))}`);
	if (contracts.error) ns.print(`  Contract warning  ${contracts.error}`);
	ns.print("");
}

function renderHealth(ns, daemon) {
	ns.print("PIPELINE HEALTH");
	if (daemon.hackStatus) ns.print(`  Hacking           ${humanHackStatus(daemon.hackStatus)}`);
	if (daemon.pipeline) ns.print(`  Work queue        ${humanPipeline(daemon.pipeline)}`);
	if (daemon.batches) ns.print(`  Batches           ${humanBatches(daemon.batches)}`);
	if (daemon.allocator) ns.print(`  Capacity pressure ${humanAllocator(daemon.allocator)}`);
	if (daemon.pipeDrift) ns.print(`  Current timing    ${humanTiming(daemon.pipeDrift)}`);
	if (daemon.loopLag) ns.print(`  Controller delay  ${humanLoopLag(daemon.loopLag)}`);

	const hasPipelineProblem = hasNonZeroCounters(daemon.pipeMisses);
	const hasLifetimeProblem = hasNonZeroCounters(daemon.misses);
	if (!hasPipelineProblem && !hasLifetimeProblem && daemon.recovery?.startsWith("0 ")) {
		ns.print("  Reliability       Healthy - no misses or recoveries");
	} else {
		if (hasPipelineProblem) ns.print(`  Current misses    ${humanPhaseCounters(daemon.pipeMisses)}`);
		if (hasLifetimeProblem) ns.print(`  Lifetime misses   ${humanPhaseCounters(daemon.misses)}`);
		if (daemon.recovery) ns.print(`  Recovery          ${humanRecovery(daemon.recovery)}`);
	}

	if (daemon.last && daemon.last !== "none") ns.print(`  Last event        ${daemon.last}`);
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
			target: prepHeader.slice(prepHeader.indexOf("JIT DAEMON :: PREP ::") + 22).trim(),
			stage: field(logs, "Stage"),
			money: field(logs, "Money"),
			security: field(logs, "Security"),
			wave: field(logs, "Wave"),
			targets: parseTargets(logs),
		};
	}

	const reconfigureHeader = findLog(logs, "JIT DAEMON :: RECONFIGURE");
	if (reconfigureHeader) {
		return {
			mode: "reconfigure",
			reason: field(logs, "Reason"),
		};
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
	const pattern = /^\s*(>)?\s*([^\s]+)\s+(\$\S+\/s)\s+steady:(\$\S+\/s)\s+S:\s*([\d.]+%)\s+P:\s*(\S+)\s+prep:\s*(\S+)/;

	for (const raw of logs) {
		const line = stripPrefix(raw);
		const match = line.match(pattern);
		if (!match) continue;
		entries.push({
			selected: Boolean(match[1]),
			name: match[2],
			effective: match[3],
			steady: match[4],
			steal: match[5],
			period: match[6],
			prep: match[7],
		});
	}

	return entries;
}

function field(logs, label) {
	for (let i = logs.length - 1; i >= 0; i--) {
		const line = stripPrefix(logs[i]);
		if (!line.startsWith(label)) continue;
		return line.slice(label.length).trim();
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
	// Timestamped logs can prefix each print with text such as "12:34:56".
	// Locate the known dashboard content instead of depending on a timestamp format.
	const markers = ["JIT DAEMON ::", "TARGET ANALYSIS ::"];
	for (const marker of markers) {
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

function humanState(value) {
	if (value.startsWith("DRAINING ::")) {
		return `Recovering safely - ${value.slice(11).trim()}`;
	}
	return value === "RUNNING" ? "Running normally" : value;
}

function humanSteal(value) {
	return value
		.replace("| chance", "per batch | success chance")
		.replace(/^(\S+%)/, "$1");
}

function humanBatchRate(value) {
	return value
		.replace("/s actual", " batches/sec")
		.replace("|", "|")
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
	return value
		.replace("scheduled", "scheduled")
		.replace("completed", "completed")
		.replace("recovered", "safely recovered");
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
		.replace(/W2:/g, "weaken-2 ")
		.replace("| recoveries", "| recoveries");
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
		.replace(/^quarantined /, "Skipped quarantined solver: ")
		.replace(/^dry-run solved /, "Dry-run validated ");
}

function hasNonZeroCounters(value) {
	if (!value) return false;
	const numbers = value.match(/\d+/g)?.map(Number) ?? [];
	return numbers.some(number => number > 0);
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
	const units = [
		[1e18, "Q"],
		[1e15, "q"],
		[1e12, "t"],
		[1e9, "b"],
		[1e6, "m"],
		[1e3, "k"],
	];
	for (const [threshold, suffix] of units) {
		if (Math.abs(n) >= threshold) return `$${(n / threshold).toFixed(2)}${suffix}`;
	}
	return `$${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
