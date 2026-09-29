import { PORTS } from "lib/ports.js";
import { solveServer } from "lib/darknet-solvers.js";
import { darknetFormulaMetrics } from "lib/darknet-formulas.js";
import { createCoordinator } from "lib/darknet-coordination.js";

const AGENT = "darknet-agent.js", RUNNER = "darknet-bootstrap.js", PHISHER = "darknet-phish.js", SOLVERS = "lib/darknet-solvers.js", PORTS_FILE = "lib/ports.js", FORMULAS_FILE = "lib/darknet-formulas.js";
const AGENT_VERSION = 7, CRAWLER_RAM = 15.9;
const ACTIONS = { stasis: "darknet-stasis.js", migrate: "darknet-migrate.js", freeze: "darknet-freeze.js", stock: "darknet-stock.js", storm: "darknet-storm.js" };
const DEPLOY_FILES = [RUNNER, AGENT, PHISHER, SOLVERS, PORTS_FILE, FORMULAS_FILE, "lib/darknet-coordination.js", ...Object.values(ACTIONS)];

/** Roaming, disposable Darknet node. Durable state belongs to darknet-manager.js. @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const cfg = parseConfig(ns.args[0]);
	const coordinator = createCoordinator(ns, cfg);
	await Promise.all([crawl(ns, cfg, coordinator), heartbeat(ns, coordinator)]);
}

async function heartbeat(ns, coordinator) {
	while (true) { coordinator.pulse(); await ns.asleep(5_000); }
}

async function crawl(ns, cfg, coordinator) {
	const host = ns.getHostname();
	const retryAt = new Map();
	emit(ns, cfg, { kind: "agent", host, state: "started" });
	let cycles = 0;
	while (true) {
		try {
			await serviceCurrentHost(ns, cfg, coordinator);
			const neighbors = orderedNeighbors(ns, ns.dnet.probe());
			for (const target of retryAt.keys()) if (!neighbors.includes(target)) retryAt.delete(target);
			await visitNeighbors(neighbors.filter(target => Date.now() >= Number(retryAt.get(target) || 0)), cfg.concurrency, async target => {
				const result = await visitNeighbor(ns, cfg, target, coordinator);
				if (result?.blocked) retryAt.set(target, Date.now() + (result.retryDelay || cfg.retryDelay));
				else retryAt.delete(target);
			});
			if (cfg.migrate && ++cycles % cfg.migrateEvery === 0 && neighbors.length) await migrateOne(ns, cfg, neighbors);
			emit(ns, cfg, { kind: "agent", host, state: "running", neighbors: neighbors.length, depth: safe(() => ns.dnet.getDepth(host), -1) });
		} catch (error) { emit(ns, cfg, { kind: "error", host, error: String(error?.message ?? error) }); }
		await ns.sleep(cfg.interval);
	}
}

export async function visitNeighbor(ns, cfg, target, coordinator) {
	let details, formulaMetrics;
	try {
		await coordinator.withApi(() => {
			details = ns.dnet.getServerDetails(target);
			formulaMetrics = darknetFormulaMetrics(ns, details, runningThreads(ns));
			emit(ns, cfg, { kind: "seen", host: target, from: ns.getHostname(), details: compactDetails(details, formulaMetrics) });
		});
	} catch { return { blocked: true }; }
	if (!details.isOnline || !details.isConnectedToCurrentServer) return { blocked: true };
	const access = await establishSession(ns, cfg, target, details, formulaMetrics, coordinator);
	if (!access.ok) return { blocked: true, retryDelay: access.retryDelay || 5_000 };
	await reclaimTarget(ns, target, details, formulaMetrics, coordinator);
	await coordinator.withApi(() => deploy(ns, cfg, target, coordinator));
	return { blocked: false };
}

export async function establishSession(ns, cfg, target, details, metrics, coordinator) {
	if (details.hasSession) return { ok: true };
	const connect = password => coordinator.withApi(() => ns.dnet.connectToSession(target, password));
	let password = coordinator.credential(target);
	if (password != null && (await connect(password)).success) return { ok: true };
	let grant = await coordinator.acquire(target, compactDetails(details, metrics), metrics, password != null);
	// The registry may have been updated between our snapshot read and the grant request.
	if (!grant.token && grant.password != null) {
		password = grant.password;
		if ((await connect(password)).success) return { ok: true };
		grant = await coordinator.acquire(target, compactDetails(details, metrics), metrics, true);
	}
	if (!grant.token) return { ok: false, retryDelay: 5_000 };
	const token = grant.token, progress = () => coordinator.progress(target, token);
	// Recheck the lease when the call actually starts, after waiting in the PID queue.
	const solverNs = { dnet: {
		authenticate: (...args) => coordinator.withApi(() => { progress(); return ns.dnet.authenticate(...args); }),
		heartbleed: (...args) => coordinator.withApi(() => { progress(); return ns.dnet.heartbleed(...args); }),
	} };
	try {
		password = grant.password ?? password ?? await coordinator.withApi(() => cluePassword(ns, target));
		let solved;
		if (password != null) {
			progress();
			solved = (await connect(password)).success ? { success: true, password, attempts: 0 } : await authenticateKnown(solverNs, target, password);
			// A bad local clue is only a hint. Try the actual model under the same lease.
			if (!solved.success && grant.password == null && solved.code === 401) password = null;
		}
		if (password == null) solved = await solveServer(solverNs, target, details, { maxAttempts: cfg.maxAttempts });
		if (solved.success) {
			const result = await coordinator.finish({ kind: "credential", host: target, token, password: solved.password, modelId: details.modelId, attempts: solved.attempts });
			return { ok: result.ok };
		}
		const retryDelay = formulaRetryDelay(metrics, solved.attempts) || cfg.retryDelay;
		await coordinator.finish({ kind: "blocked", host: target, token, modelId: details.modelId, reason: solved.reason, attempts: solved.attempts, retryDelay,
			rejectedPassword: solved.code === 401 ? grant.password : null });
		if (cfg.freezeUnknown && details.depth >= cfg.freezeDepth) await coordinator.withApi(() => launchAction(ns, cfg, ACTIONS.freeze, target));
		return { ok: false, retryDelay };
	} catch (error) {
		await coordinator.finish({ kind: "blocked", host: target, token, reason: String(error?.message ?? error), retryDelay: cfg.retryDelay });
		return { ok: false, retryDelay: cfg.retryDelay };
	}
}

async function authenticateKnown(ns, host, password, beforeCall = () => {}) {
	let result;
	for (let i = 0; i < 3; i++) {
		beforeCall(); result = await ns.dnet.authenticate(host, password);
		if (result.success) return { success: true, password, attempts: i + 1 };
		if (result.code !== 408) return { success: false, code: result.code, reason: `known-credential-${result.code}`, attempts: i + 1 };
	}
	return { success: false, code: result.code, reason: "known-credential-timeout", attempts: 3 };
}

async function reclaimTarget(ns, target, details, metrics, coordinator) {
	const blocked = await coordinator.withApi(() => {
		metrics ||= darknetFormulaMetrics(ns, details, runningThreads(ns));
		return safe(() => ns.dnet.getBlockedRam(target), Number(details?.blockedRam) || 0);
	});
	const estimatedCalls = metrics?.ramPerCall > 0 ? Math.ceil(blocked / metrics.ramPerCall) + 2 : 100;
	const maxCalls = Math.max(1, Math.min(100, estimatedCalls));
	for (let i = 0; i < maxCalls; i++) {
		const result = await coordinator.withApi(() => safe(() => ns.dnet.getBlockedRam(target), 0) > 0 ? ns.dnet.memoryReallocation(target) : null);
		if (!result || (!result.success && result.code !== 408)) break;
	}
}

async function deploy(ns, cfg, target, coordinator) {
	const crawlers = ns.ps(target).filter(p => [AGENT, RUNNER].includes(p.filename));
	if (crawlers.some(process => agentVersion(process) === AGENT_VERSION)) return;
	if (!await ns.scp(DEPLOY_FILES, target, "home")) { await coordinator.request({ kind: "blocked", host: target, reason: "scp-failed" }); return; }
	for (const process of crawlers.filter(p => agentVersion(p) !== AGENT_VERSION)) ns.kill(process.pid);
	const ram = ns.getServerMaxRam(target) - ns.getServerUsedRam(target), agentRam = CRAWLER_RAM;
	if (ram < agentRam) { await coordinator.request({ kind: "blocked", host: target, reason: "agent-ram", freeRam: ram, requiredRam: agentRam }); return; }
	const phishReserve = cfg.phish && target !== "darkweb" ? ns.getScriptRam(PHISHER, target) : 0;
	const scalableRam = ram >= agentRam + phishReserve ? ram - phishReserve : ram;
	const threads = Math.max(1, Math.min(cfg.agentThreads, Math.floor(scalableRam / agentRam)));
	const pid = ns.exec(RUNNER, target, { threads, ramOverride: agentRam, preventDuplicates: true, temporary: true }, JSON.stringify(cfg));
	if (!pid) await coordinator.request({ kind: "blocked", host: target, reason: "exec-failed", freeRam: ram, requiredRam: agentRam * threads });
	else await coordinator.request({ kind: "deployed", host: target, deployedPid: pid, threads });
}

async function serviceCurrentHost(ns, cfg, coordinator) {
	const host = ns.getHostname();
	if (host !== "home" && host !== "darkweb") {
		for (const file of ns.ls(host, ".cache")) {
			try { const reward = ns.dnet.openCache(file, true); await coordinator.request({ kind: "cache", host, file, reward: reward?.message || "opened", cacheResult: reward }); } catch {}
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
	// Drain every worker before returning to crawl's unqueued API calls, even if
	// one visit fails while another still has an authentication in flight.
	const results = await Promise.allSettled(Array.from({ length: Math.min(neighbors.length, Math.max(1, concurrency)) }, worker));
	const failed = results.find(result => result.status === "rejected");
	if (failed) throw failed.reason;
}

export function orderedNeighbors(ns, neighbors) {
	return [...neighbors].sort((a, b) => neighborRank(ns, a) - neighborRank(ns, b));
}

function neighborRank(ns, host) {
	const d = safe(() => ns.dnet.getServerDetails(host), null);
	if (!d) return Number.MAX_SAFE_INTEGER;
	return (d.hasSession ? -1e12 : 0) + (Number(d.requiredCharismaSkill) || 0) * 1e6 + (Number(d.difficulty) || 0) * 1e3 + (Number(d.depth) || 0);
}

export function cluePassword(ns, target) {
	const neighbors = ns.dnet.probe();
	for (const file of ns.ls(ns.getHostname()).filter(name => /\.(txt|lit|msg)$/.test(name))) {
		const text = String(ns.read(file));
		const password = passwordFromClue(text, target, neighbors.length === 1 && neighbors[0] === target);
		if (password != null) return password;
	}
	return null;
}

export function passwordFromClue(text, target, onlyNeighbor = false) {
	const host = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const named = text.match(new RegExp(`(?:^|\\s)Server:\\s*${host}\\s+Password:\\s*"([^"]*)"`, "i"));
	if (named) return named[1];
	const pair = text.match(new RegExp(`(?:^|\\s)${host}:(?:"([^"]*)"|'([^']*)'|([^\\s]+))(?=\\s|$)`));
	if (pair) return pair[1] ?? pair[2] ?? pair[3];
	// A named clue for some other host must never become an unnamed local hint.
	if (!onlyNeighbor || /Server:/i.test(text)) return null;
	const direct = text.match(/(?:password|passcode|key)(?:\s+is|:)\s*(?:"([^"]*)"|'([^']*)'|([^\r\n]+))/i);
	return direct ? (direct[1] ?? direct[2] ?? direct[3].trim()) : null;
}

export function parseConfig(raw) {
	let input = {}; try { input = JSON.parse(String(raw || "{}")); } catch {}
	return { version: AGENT_VERSION, eventPort: Number(input.eventPort) || PORTS.DARKNET_EVENTS, coordinationPort: Number(input.coordinationPort) || PORTS.DARKNET_STATUS, interval: Math.max(1_000, Number(input.interval) || 5_000),
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
