import { PORTS } from "lib/ports.js";
import { solveServer } from "lib/darknet-solvers.js";
import { darknetFormulaMetrics } from "lib/darknet-formulas.js";

const AGENT = "darknet-agent.js", RUNNER = "darknet-bootstrap.js", PHISHER = "darknet-phish.js", SOLVERS = "lib/darknet-solvers.js", PORTS_FILE = "lib/ports.js", FORMULAS_FILE = "lib/darknet-formulas.js";
const AGENT_VERSION = 5, CRAWLER_RAM = 15.9;
const ACTIONS = { stasis: "darknet-stasis.js", migrate: "darknet-migrate.js", freeze: "darknet-freeze.js", stock: "darknet-stock.js", storm: "darknet-storm.js" };
const DEPLOY_FILES = [RUNNER, AGENT, PHISHER, SOLVERS, PORTS_FILE, FORMULAS_FILE, ...Object.values(ACTIONS)];

/** Roaming, disposable Darknet node. Durable state belongs to darknet-manager.js. @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const cfg = parseConfig(ns.args[0]);
	const host = ns.getHostname();
	const retryAt = new Map();
	emit(ns, cfg, { kind: "agent", host, state: "started" });
	let cycles = 0;
	while (true) {
		try {
			await serviceCurrentHost(ns, cfg);
			const neighbors = orderedNeighbors(ns, ns.dnet.probe());
			await visitNeighbors(neighbors.filter(target => Date.now() >= Number(retryAt.get(target) || 0)), cfg.concurrency, async target => {
				const result = await visitNeighbor(ns, cfg, target);
				if (result?.blocked) retryAt.set(target, Date.now() + (result.retryDelay || cfg.retryDelay));
				else retryAt.delete(target);
			});
			if (cfg.migrate && ++cycles % cfg.migrateEvery === 0 && neighbors.length) await migrateOne(ns, cfg, neighbors);
			emit(ns, cfg, { kind: "agent", host, state: "running", neighbors: neighbors.length, depth: safe(() => ns.dnet.getDepth(host), -1) });
		} catch (error) { emit(ns, cfg, { kind: "error", host, error: String(error?.message ?? error) }); }
		await ns.sleep(cfg.interval);
	}
}

async function visitNeighbor(ns, cfg, target) {
	let details;
	try { details = ns.dnet.getServerDetails(target); } catch { return { blocked: true }; }
	const formulaMetrics = darknetFormulaMetrics(ns, details, runningThreads(ns));
	emit(ns, cfg, { kind: "seen", host: target, from: ns.getHostname(), details: compactDetails(details, formulaMetrics) });
	if (!details.isOnline || !details.isConnectedToCurrentServer) return { blocked: true };
	let password = cluePassword(ns, target);
	let connected = false;
	if (password != null && ns.getServer(target).hasAdminRights) connected = ns.dnet.connectToSession(target, password).success;
	if (!connected && !details.hasSession) {
		emit(ns, cfg, { kind: "cracking", host: target, from: ns.getHostname(), modelId: details.modelId, difficulty: details.difficulty });
		const solved = password != null ? await authenticateKnown(ns, target, password) : await solveServer(ns, target, details, { maxAttempts: cfg.maxAttempts });
		if (!solved.success) { emit(ns, cfg, { kind: "blocked", host: target, modelId: details.modelId, reason: solved.reason, attempts: solved.attempts }); if (cfg.freezeUnknown && details.depth >= cfg.freezeDepth) launchAction(ns, cfg, ACTIONS.freeze, target); return { blocked: true, retryDelay: formulaRetryDelay(formulaMetrics, solved.attempts) }; }
		password = solved.password;
		emit(ns, cfg, { kind: "credential", host: target, password, modelId: details.modelId, attempts: solved.attempts });
	}
	await reclaimTarget(ns, target, details, formulaMetrics);
	await deploy(ns, cfg, target);
	return { blocked: false };
}

async function authenticateKnown(ns, host, password) {
	for (let i = 0; i < 3; i++) { const result = await ns.dnet.authenticate(host, password); if (result.success) return { success: true, password, attempts: i + 1 }; if (result.code !== 408) break; }
	return { success: false, reason: "known-credential-rejected", attempts: 3 };
}

async function reclaimTarget(ns, target, details, metrics = null) {
	const blocked = safe(() => ns.dnet.getBlockedRam(target), Number(details?.blockedRam) || 0);
	metrics ||= darknetFormulaMetrics(ns, details, runningThreads(ns));
	const estimatedCalls = metrics?.ramPerCall > 0 ? Math.ceil(blocked / metrics.ramPerCall) + 2 : 100;
	const maxCalls = Math.max(1, Math.min(100, estimatedCalls));
	for (let i = 0; i < maxCalls && safe(() => ns.dnet.getBlockedRam(target), 0) > 0; i++) {
		const result = await ns.dnet.memoryReallocation(target); if (!result.success && result.code !== 408) break;
	}
}

async function deploy(ns, cfg, target) {
	if (!await ns.scp(DEPLOY_FILES, target, "home")) { emit(ns, cfg, { kind: "blocked", host: target, reason: "scp-failed" }); return; }
	const crawlers = ns.ps(target).filter(p => [AGENT, RUNNER].includes(p.filename));
	if (crawlers.some(process => agentVersion(process) === AGENT_VERSION)) return;
	for (const process of crawlers.filter(p => agentVersion(p) !== AGENT_VERSION)) ns.kill(process.pid);
	const ram = ns.getServerMaxRam(target) - ns.getServerUsedRam(target), agentRam = CRAWLER_RAM;
	if (ram < agentRam) { emit(ns, cfg, { kind: "blocked", host: target, reason: "agent-ram", freeRam: ram, requiredRam: agentRam }); return; }
	const phishReserve = cfg.phish && target !== "darkweb" ? ns.getScriptRam(PHISHER, target) : 0;
	const scalableRam = ram >= agentRam + phishReserve ? ram - phishReserve : ram;
	const threads = Math.max(1, Math.min(cfg.agentThreads, Math.floor(scalableRam / agentRam)));
	const pid = ns.exec(RUNNER, target, { threads, ramOverride: agentRam, preventDuplicates: true, temporary: true }, JSON.stringify(cfg));
	if (!pid) emit(ns, cfg, { kind: "blocked", host: target, reason: "exec-failed", freeRam: ram, requiredRam: agentRam * threads });
	else emit(ns, cfg, { kind: "deployed", host: target, pid, threads });
}

async function serviceCurrentHost(ns, cfg) {
	const host = ns.getHostname();
	if (host !== "home" && host !== "darkweb") {
		for (const file of ns.ls(host, ".cache")) {
			try { const reward = ns.dnet.openCache(file, true); emit(ns, cfg, { kind: "cache", host, file, reward: reward?.message || "opened" }); } catch {}
		}
		if (cfg.stasis && safe(() => ns.dnet.getDepth(host), -1) >= cfg.stasisDepth) launchAction(ns, cfg, ACTIONS.stasis);
		launchPhishing(ns, cfg);
		if (cfg.promoteStock) launchAction(ns, cfg, ACTIONS.stock);
		if (cfg.stormSeed && ns.fileExists("STORM_SEED.exe", host)) launchAction(ns, cfg, ACTIONS.storm);
	}
}

function launchPhishing(ns, cfg) {
	if (!cfg.phish || ns.ps(ns.getHostname()).some(p => p.filename === PHISHER)) return;
	const free = ns.getServerMaxRam(ns.getHostname()) - ns.getServerUsedRam(ns.getHostname()), ram = ns.getScriptRam(PHISHER, ns.getHostname());
	const threads = Math.min(cfg.phishThreads, Math.floor(free / Math.max(ram, 0.01)));
	if (threads > 0) ns.exec(PHISHER, ns.getHostname(), { threads, temporary: true });
}

async function migrateOne(ns, cfg, neighbors) {
	for (const host of neighbors) {
		const details = safe(() => ns.dnet.getServerDetails(host), null);
		if (details?.isOnline && !details.isStationary && details.depth >= cfg.migrateDepth) { launchAction(ns, cfg, ACTIONS.migrate, host); return; }
	}
}

function launchAction(ns, cfg, script, target = "") {
	if (ns.ps(ns.getHostname()).some(p => p.filename === script && String(p.args?.[1] || "") === String(target))) return 0;
	return ns.exec(script, ns.getHostname(), { threads: 1, preventDuplicates: true, temporary: true }, JSON.stringify(cfg), target);
}

export async function visitNeighbors(neighbors, concurrency, visitor) {
	let next = 0;
	const worker = async () => { while (next < neighbors.length) { const index = next++; await visitor(neighbors[index]); } };
	await Promise.all(Array.from({ length: Math.min(neighbors.length, Math.max(1, concurrency)) }, worker));
}

export function orderedNeighbors(ns, neighbors) {
	return [...neighbors].sort((a, b) => neighborRank(ns, a) - neighborRank(ns, b));
}

function neighborRank(ns, host) {
	const d = safe(() => ns.dnet.getServerDetails(host), null);
	if (!d) return Number.MAX_SAFE_INTEGER;
	return (d.hasSession ? -1e12 : 0) + (Number(d.requiredCharismaSkill) || 0) * 1e6 + (Number(d.difficulty) || 0) * 1e3 + (Number(d.depth) || 0);
}

function cluePassword(ns, target) {
	for (const file of ns.ls(ns.getHostname()).filter(name => /\.(txt|lit|msg)$/.test(name))) {
		const text = String(ns.read(file));
		for (const match of text.matchAll(/([^\s:]+):([^\s]+)/g)) if (match[1] === target) return match[2];
		const direct = text.match(new RegExp(`(?:password|passcode|key)(?:\\s+is|:)\\s*["']?([^\\s"']+)`, "i"));
		if (direct && ns.dnet.probe().length === 1 && ns.dnet.probe()[0] === target) return direct[1];
	}
	return null;
}

export function parseConfig(raw) {
	let input = {}; try { input = JSON.parse(String(raw || "{}")); } catch {}
	return { version: AGENT_VERSION, eventPort: Number(input.eventPort) || PORTS.DARKNET_EVENTS, interval: Math.max(1_000, Number(input.interval) || 5_000),
		maxAttempts: Math.max(25, Number(input.maxAttempts) || 600), retryDelay: Math.max(5_000, Number(input.retryDelay) || 60_000),
		concurrency: Math.max(1, Math.min(16, Number(input.concurrency) || 4)), agentThreads: Math.max(1, Number(input.agentThreads) || 4),
		phish: input.phish !== false, phishThreads: Math.max(1, Number(input.phishThreads) || 1024),
		stasis: Boolean(input.stasis), stasisDepth: Math.max(0, Number(input.stasisDepth) || 8), migrate: Boolean(input.migrate),
		migrateDepth: Math.max(0, Number(input.migrateDepth) || 8), migrateEvery: Math.max(1, Number(input.migrateEvery) || 12),
		promoteStock: Boolean(input.promoteStock), stockSymbols: String(input.stockSymbols || "auto").split(",").map(v => v.trim()).filter(Boolean),
		freezeUnknown: Boolean(input.freezeUnknown), freezeDepth: Math.max(0, Number(input.freezeDepth) || 0), stormSeed: Boolean(input.stormSeed) };
}

function agentVersion(process) { try { return Number(JSON.parse(String(process.args?.[0] || "{}")).version) || 0; } catch { return 0; } }

function emit(ns, cfg, event) { try { ns.getPortHandle(cfg.eventPort).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
function compactDetails(d, metrics = null) { return { isOnline: d.isOnline, modelId: d.modelId, depth: d.depth, difficulty: d.difficulty, blockedRam: d.blockedRam, passwordLength: d.passwordLength, passwordFormat: d.passwordFormat, isStationary: d.isStationary,
	formulaMetrics: metrics ? { authenticateMin: metrics.authenticateMin, authenticateMax: metrics.authenticateMax, heartbleed: metrics.heartbleed, ramPerCall: metrics.ramPerCall } : null }; }
function runningThreads(ns) { return Math.max(1, Number(safe(() => ns.getRunningScript()?.threads, 1)) || 1); }
function formulaRetryDelay(metrics, attempts = 1) {
	if (!metrics) return 0;
	const cycle = metrics.authenticateMax + metrics.heartbleed;
	return Math.min(300_000, Math.max(5_000, cycle * Math.max(2, Math.min(10, Number(attempts) || 1))));
}
function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
