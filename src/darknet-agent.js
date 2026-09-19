import { PORTS } from "lib/ports.js";
import { solveServer } from "lib/darknet-solvers.js";

const AGENT = "darknet-agent.js", PHISHER = "darknet-phish.js", SOLVERS = "lib/darknet-solvers.js", PORTS_FILE = "lib/ports.js";

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
			const neighbors = ns.dnet.probe();
			for (const target of neighbors) {
				if (Date.now() < Number(retryAt.get(target) || 0)) continue;
				const result = await visitNeighbor(ns, cfg, target);
				if (result?.blocked) retryAt.set(target, Date.now() + cfg.retryDelay);
				else retryAt.delete(target);
			}
			if (cfg.migrate && ++cycles % cfg.migrateEvery === 0 && neighbors.length) await migrateOne(ns, cfg, neighbors);
			emit(ns, cfg, { kind: "agent", host, state: "running", neighbors: neighbors.length, depth: safe(() => ns.dnet.getDepth(host), -1) });
		} catch (error) { emit(ns, cfg, { kind: "error", host, error: String(error?.message ?? error) }); }
		await ns.sleep(cfg.interval);
	}
}

async function visitNeighbor(ns, cfg, target) {
	let details;
	try { details = ns.dnet.getServerDetails(target); } catch { return { blocked: true }; }
	emit(ns, cfg, { kind: "seen", host: target, from: ns.getHostname(), details: compactDetails(details) });
	if (!details.isOnline || !details.isConnectedToCurrentServer) return { blocked: true };
	let password = cluePassword(ns, target);
	let connected = false;
	if (password != null && ns.getServer(target).hasAdminRights) connected = ns.dnet.connectToSession(target, password).success;
	if (!connected && !details.hasSession) {
		const solved = password != null ? await authenticateKnown(ns, target, password) : await solveServer(ns, target, details, { maxAttempts: cfg.maxAttempts });
		if (!solved.success) { emit(ns, cfg, { kind: "blocked", host: target, modelId: details.modelId, reason: solved.reason, attempts: solved.attempts }); if (cfg.freezeUnknown && details.depth >= cfg.freezeDepth) safe(() => ns.dnet.freezeServer(target)); return { blocked: true }; }
		password = solved.password;
		emit(ns, cfg, { kind: "credential", host: target, password, modelId: details.modelId, attempts: solved.attempts });
	}
	await reclaimTarget(ns, target);
	await deploy(ns, cfg, target);
	return { blocked: false };
}

async function authenticateKnown(ns, host, password) {
	for (let i = 0; i < 3; i++) { const result = await ns.dnet.authenticate(host, password); if (result.success) return { success: true, password, attempts: i + 1 }; if (result.code !== 408) break; }
	return { success: false, reason: "known-credential-rejected", attempts: 3 };
}

async function reclaimTarget(ns, target) {
	for (let i = 0; i < 100 && safe(() => ns.dnet.getBlockedRam(target), 0) > 0; i++) {
		const result = await ns.dnet.memoryReallocation(target); if (!result.success && result.code !== 408) break;
	}
}

async function deploy(ns, cfg, target) {
	const files = [AGENT, PHISHER, SOLVERS, PORTS_FILE];
	if (!await ns.scp(files, target, "home")) { emit(ns, cfg, { kind: "blocked", host: target, reason: "scp-failed" }); return; }
	const ram = ns.getServerMaxRam(target) - ns.getServerUsedRam(target), agentRam = ns.getScriptRam(AGENT, target);
	if (ram < agentRam) { emit(ns, cfg, { kind: "blocked", host: target, reason: "agent-ram" }); return; }
	const pid = ns.exec(AGENT, target, { threads: 1, preventDuplicates: true, temporary: true }, JSON.stringify(cfg));
	emit(ns, cfg, { kind: "deployed", host: target, pid });
}

async function serviceCurrentHost(ns, cfg) {
	const host = ns.getHostname();
	if (host !== "home" && host !== "darkweb") {
		for (const file of ns.ls(host, ".cache")) {
			try { const reward = ns.dnet.openCache(file, true); emit(ns, cfg, { kind: "cache", host, file, reward: reward?.message || "opened" }); } catch {}
		}
		if (cfg.stasis && safe(() => ns.dnet.getDepth(host), -1) >= cfg.stasisDepth) {
			const linked = safe(() => ns.dnet.getStasisLinkedServers(), []), limit = safe(() => ns.dnet.getStasisLinkLimit(), 0);
			if (!linked.includes(host) && linked.length < limit) { const r = ns.dnet.setStasisLink(true); if (r.success) emit(ns, cfg, { kind: "stasis", host }); }
		}
		launchPhishing(ns, cfg);
		if (cfg.promoteStock) await promoteStock(ns, cfg);
		if (cfg.stormSeed && ns.fileExists("STORM_SEED.exe", host)) { emit(ns, cfg, { kind: "storm", host, state: "armed" }); ns.dnet.unleashStormSeed(); }
	}
}

function launchPhishing(ns, cfg) {
	if (!cfg.phish || ns.ps(ns.getHostname()).some(p => p.filename === PHISHER)) return;
	const free = ns.getServerMaxRam(ns.getHostname()) - ns.getServerUsedRam(ns.getHostname()), ram = ns.getScriptRam(PHISHER, ns.getHostname());
	const threads = Math.min(cfg.phishThreads, Math.floor(free / Math.max(ram, 0.01)));
	if (threads > 0) ns.exec(PHISHER, ns.getHostname(), { threads, temporary: true });
}

async function promoteStock(ns, cfg) {
	let symbols = cfg.stockSymbols;
	if (symbols.includes("auto")) {
		try { symbols = ns.stock.getSymbols().filter(symbol => { const [long,,,short] = ns.stock.getPosition(symbol); return long > 0 || short > 0; }); } catch { return; }
	}
	if (!symbols.length) return;
	const symbol = symbols[Math.floor(Date.now() / 60_000) % symbols.length];
	try { await ns.dnet.promoteStock(symbol); emit(ns, cfg, { kind: "stock", host: ns.getHostname(), symbol }); } catch {}
}

async function migrateOne(ns, cfg, neighbors) {
	for (const host of neighbors) {
		const details = safe(() => ns.dnet.getServerDetails(host), null);
		if (details?.isOnline && !details.isStationary && details.depth >= cfg.migrateDepth) { try { await ns.dnet.induceServerMigration(host); emit(ns, cfg, { kind: "migration", host, from: ns.getHostname() }); } catch {} return; }
	}
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
	return { eventPort: Number(input.eventPort) || PORTS.DARKNET_EVENTS, interval: Math.max(1_000, Number(input.interval) || 5_000),
		maxAttempts: Math.max(25, Number(input.maxAttempts) || 600), retryDelay: Math.max(5_000, Number(input.retryDelay) || 60_000),
		phish: input.phish !== false, phishThreads: Math.max(1, Number(input.phishThreads) || 1024),
		stasis: Boolean(input.stasis), stasisDepth: Math.max(0, Number(input.stasisDepth) || 8), migrate: Boolean(input.migrate),
		migrateDepth: Math.max(0, Number(input.migrateDepth) || 8), migrateEvery: Math.max(1, Number(input.migrateEvery) || 12),
		promoteStock: Boolean(input.promoteStock), stockSymbols: String(input.stockSymbols || "auto").split(",").map(v => v.trim()).filter(Boolean),
		freezeUnknown: Boolean(input.freezeUnknown), freezeDepth: Math.max(0, Number(input.freezeDepth) || 0), stormSeed: Boolean(input.stormSeed) };
}

function emit(ns, cfg, event) { try { ns.getPortHandle(cfg.eventPort).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
function compactDetails(d) { return { isOnline: d.isOnline, modelId: d.modelId, depth: d.depth, difficulty: d.difficulty, blockedRam: d.blockedRam, passwordLength: d.passwordLength, passwordFormat: d.passwordFormat, isStationary: d.isStationary }; }
function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
