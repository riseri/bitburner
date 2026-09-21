import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";

const STATE_FILE = "data/darknet-state.json", AGENT = "darknet-agent.js", RUNNER = "darknet-bootstrap.js", AGENT_VERSION = 5, CRAWLER_RAM = 15.9;
const AGENT_FILES = [RUNNER, AGENT, "darknet-phish.js", "darknet-stasis.js", "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js", "lib/darknet-solvers.js", "lib/darknet-formulas.js", "lib/ports.js"];

/** Home-owned durable Darknet coordinator. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["port", PORTS.DARKNET_STATUS], ["event-port", PORTS.DARKNET_EVENTS], ["interval", 5_000],
		["phish", true], ["phish-threads", 1024], ["max-attempts", 600], ["concurrency", 4], ["agent-threads", 4], ["stasis", false], ["stasis-depth", 8],
		["migrate", false], ["migrate-depth", 8], ["migrate-every", 12], ["promote-stock", false], ["stock-symbols", "auto"],
		["freeze-unknown", false], ["freeze-depth", 0], ["storm-seed", false]]);
	ns.disableLog("ALL");
	if (ns.getHostname() !== "home") throw new Error("Run darknet-manager.js on home");
	const otherManager = ns.ps("home").find(process => process.filename === "darknet-manager.js" && process.pid !== ns.pid);
	if (otherManager) {
		ns.tprint(`ERROR: darknet-manager.js PID ${otherManager.pid} is already running on home; refusing duplicate ownership`);
		return;
	}
	const cfg = managerConfig(flags), statusPort = ns.getPortHandle(cfg.port), eventPort = ns.getPortHandle(cfg.eventPort);
	let state = loadState(ns);
	let lastRestore = 0;
	const epoch = resetEpoch(ns.getResetInfo());
	if (state.resetEpoch !== epoch) state = emptyState(epoch);
	while (true) {
		const unlocked = ns.fileExists("DarkscapeNavigator.exe", "home") || Number(ns.getResetInfo()?.currentNode) === 15;
		let homeAgent = { ok: false, reason: "Darknet locked" };
		if (unlocked) {
			homeAgent = ensureHomeAgent(ns, cfg);
			if (Date.now() - lastRestore >= 30_000) { await restoreAnchors(ns, cfg, state); lastRestore = Date.now(); }
		}
		let dirty = false, event;
		while (!eventPort.empty() && (event = eventPort.read())) { if (event?.type === "darknet-event") { applyEvent(state, event); dirty = true; } }
		if (dirty) { await saveState(ns, state); dirty = false; }
		const now = Date.now();
		for (const [key, agent] of Object.entries(state.agents)) if (now - agent.at > 3_600_000) { delete state.agents[key]; dirty = true; }
		state.cracking ??= {};
		for (const [host, activity] of Object.entries(state.cracking)) if (now - activity.at > 1_800_000) { delete state.cracking[host]; dirty = true; }
		if (dirty) await saveState(ns, state);
		const active = Object.values(state.agents).filter(a => now - a.at < 30_000).length;
		statusPort.clear(); statusPort.write({ type: "darknet-status", version: 1, producerPid: ns.pid, generatedAt: now, heartbeatIntervalMs: cfg.interval,
			state: unlocked ? (homeAgent.ok ? "ACTIVE" : "BLOCKED") : "LOCKED", blocker: homeAgent.ok ? "" : homeAgent.reason, unlocked, formulas: ns.fileExists("Formulas.exe", "home"), known: Object.keys(state.servers).length,
			authenticated: Object.values(state.servers).filter(s => s.password != null || s.accessedAt != null).length, activeAgents: active,
			cracking: Object.entries(state.cracking).map(([host, activity]) => ({ host, modelId: activity.modelId, since: activity.at })),
			currentBlockers: Object.entries(state.servers).filter(([, server]) => server.blocker).map(([host, server]) => ({ host, reason: server.blocker, freeRam: server.freeRam, requiredRam: server.requiredRam })),
			caches: state.stats.caches, deployments: state.stats.deployments, blocked: state.stats.blocked,
			stasis: safe(() => ns.dnet.getStasisLinkedServers().length, 0), instability: safe(() => ns.dnet.getDarknetInstability(), null),
			last: state.last, errors: state.stats.errors, risky: { stasis: cfg.stasis, migrate: cfg.migrate, promoteStock: cfg.promoteStock, freezeUnknown: cfg.freezeUnknown, stormSeed: cfg.stormSeed } });
		await ns.sleep(cfg.interval);
	}
}

export function managerConfig(flags) {
	return { port: Number(flags.port), eventPort: Number(flags["event-port"]), interval: Math.max(1_000, Number(flags.interval) || 5_000),
		phish: bool(flags.phish), phishThreads: Number(flags["phish-threads"]), maxAttempts: Number(flags["max-attempts"]), concurrency: Number(flags.concurrency), agentThreads: Number(flags["agent-threads"]), stasis: bool(flags.stasis),
		stasisDepth: Number(flags["stasis-depth"]), migrate: bool(flags.migrate), migrateDepth: Number(flags["migrate-depth"]), migrateEvery: Number(flags["migrate-every"]),
		promoteStock: bool(flags["promote-stock"]), stockSymbols: String(flags["stock-symbols"]), freezeUnknown: bool(flags["freeze-unknown"]),
		freezeDepth: Number(flags["freeze-depth"]), stormSeed: bool(flags["storm-seed"]) };
}

function ensureHomeAgent(ns, cfg) {
	const agents = ns.ps("home").filter(p => p.filename === AGENT);
	const existing = agents.find(p => agentVersion(p) === AGENT_VERSION);
	if (existing) return { ok: true, pid: existing.pid };
	for (const process of agents) ns.kill(process.pid);
	const agentCfg = { ...cfg, version: AGENT_VERSION }; delete agentCfg.port;
	const pid = ns.run(AGENT, { threads: 1, temporary: true }, JSON.stringify(agentCfg));
	if (pid) return { ok: true, pid };
	const required = ns.getScriptRam(AGENT, "home"), free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
	return { ok: false, reason: `home agent launch failed (${free.toFixed(2)} GB free; ${required.toFixed(2)} GB required)` };
}

async function restoreAnchors(ns, cfg, state) {
	for (const host of safe(() => ns.dnet.getStasisLinkedServers(), [])) {
		const password = state.servers[host]?.password;
		const agents = safe(() => ns.ps(host).filter(p => [AGENT, RUNNER].includes(p.filename)), []);
		if (password == null || agents.some(p => agentVersion(p) === AGENT_VERSION)) continue;
		try {
			for (const process of agents) ns.kill(process.pid);
			if (!ns.dnet.connectToSession(host, password).success) continue;
			if (!await ns.scp(AGENT_FILES, host, "home")) continue;
			const agentCfg = { ...cfg, version: AGENT_VERSION }; delete agentCfg.port;
			const ram = ns.getServerMaxRam(host) - ns.getServerUsedRam(host), perThread = CRAWLER_RAM;
			const threads = Math.max(1, Math.min(cfg.agentThreads, Math.floor(ram / Math.max(perThread, 0.01))));
			ns.exec(RUNNER, host, { threads, ramOverride: perThread, preventDuplicates: true, temporary: true }, JSON.stringify(agentCfg));
		} catch {}
	}
}

export function applyEvent(state, event) {
	const detail = event.reason ? ` (${event.reason}${Number.isFinite(event.freeRam) ? `; ${Number(event.freeRam).toFixed(2)}/${Number(event.requiredRam).toFixed(2)} GB` : ""})` : "";
	state.last = `${event.kind}: ${event.host || event.symbol || event.error || "event"}${detail}`;
	if (event.kind === "agent") {
		state.agents[`${event.host}:${event.pid}`] = { at: event.at, state: event.state, depth: event.depth };
		if (state.servers[event.host]) { state.servers[event.host].accessedAt ??= event.at; delete state.servers[event.host].blocker; delete state.servers[event.host].freeRam; delete state.servers[event.host].requiredRam; }
	}
	else if (event.from && event.pid) state.agents[`${event.from}:${event.pid}`] = { ...(state.agents[`${event.from}:${event.pid}`] || {}), at: event.at, state: event.kind };
	state.cracking ??= {};
	if (event.kind === "cracking" && event.host) state.cracking[event.host] = { at: event.at, modelId: event.modelId };
	if (["credential", "blocked", "deployed"].includes(event.kind) && event.host) delete state.cracking[event.host];
	if (["seen", "cracking", "credential", "blocked", "deployed", "cache", "stasis", "migration", "freeze"].includes(event.kind) && event.host) {
		const server = state.servers[event.host] ??= { firstSeen: event.at };
		server.lastSeen = event.at; if (event.details) Object.assign(server, event.details);
		if (event.kind === "credential") { server.password = event.password; server.modelId = event.modelId; server.authenticatedAt = event.at; }
		if (event.kind === "deployed") server.accessedAt = event.at;
		if (event.kind === "blocked") { server.blocker = event.reason; server.freeRam = event.freeRam; server.requiredRam = event.requiredRam; state.stats.blocked++; }
		if (["credential", "deployed"].includes(event.kind)) { delete server.blocker; delete server.freeRam; delete server.requiredRam; }
	}
	if (event.kind === "cache") state.stats.caches++;
	if (event.kind === "deployed" && event.pid) state.stats.deployments++;
	if (event.kind === "error") state.stats.errors++;
}

function emptyState(epoch) { return { version: 1, resetEpoch: epoch, servers: {}, agents: {}, cracking: {}, stats: { caches: 0, deployments: 0, blocked: 0, errors: 0 }, last: "Waiting for first probe" }; }
function loadState(ns) { try { const v = JSON.parse(ns.read(STATE_FILE)); return v?.version === 1 ? v : emptyState(""); } catch { return emptyState(""); } }
async function saveState(ns, state) { await ns.write(STATE_FILE, JSON.stringify(state), "w"); }
function bool(value) { return value === true || String(value).toLowerCase() === "true"; }
function agentVersion(process) { try { return Number(JSON.parse(String(process.args?.[0] || "{}")).version) || 0; } catch { return 0; } }
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
