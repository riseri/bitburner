import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";

const STATE_FILE = "data/darknet-state.json", AGENT = "darknet-agent.js";
const AGENT_FILES = [AGENT, "darknet-phish.js", "lib/darknet-solvers.js", "lib/ports.js"];

/** Home-owned durable Darknet coordinator. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["port", PORTS.DARKNET_STATUS], ["event-port", PORTS.DARKNET_EVENTS], ["interval", 5_000],
		["phish", true], ["phish-threads", 1024], ["max-attempts", 600], ["stasis", false], ["stasis-depth", 8],
		["migrate", false], ["migrate-depth", 8], ["migrate-every", 12], ["promote-stock", false], ["stock-symbols", "auto"],
		["freeze-unknown", false], ["freeze-depth", 0], ["storm-seed", false]]);
	ns.disableLog("ALL");
	if (ns.getHostname() !== "home") throw new Error("Run darknet-manager.js on home");
	const cfg = managerConfig(flags), statusPort = ns.getPortHandle(cfg.port), eventPort = ns.getPortHandle(cfg.eventPort);
	let state = loadState(ns);
	let lastRestore = 0;
	const epoch = resetEpoch(ns.getResetInfo());
	if (state.resetEpoch !== epoch) state = emptyState(epoch);
	while (true) {
		const unlocked = ns.fileExists("DarkscapeNavigator.exe", "home") || Number(ns.getResetInfo()?.currentNode) === 15;
		if (unlocked) {
			ensureHomeAgent(ns, cfg);
			if (Date.now() - lastRestore >= 30_000) { await restoreAnchors(ns, cfg, state); lastRestore = Date.now(); }
		}
		let dirty = false, event;
		while (!eventPort.empty() && (event = eventPort.read())) { if (event?.type === "darknet-event") { applyEvent(state, event); dirty = true; } }
		if (dirty) { await saveState(ns, state); dirty = false; }
		const now = Date.now();
		for (const [key, agent] of Object.entries(state.agents)) if (now - agent.at > 3_600_000) { delete state.agents[key]; dirty = true; }
		if (dirty) await saveState(ns, state);
		const active = Object.values(state.agents).filter(a => now - a.at < 30_000).length;
		statusPort.clear(); statusPort.write({ type: "darknet-status", version: 1, producerPid: ns.pid, generatedAt: now, heartbeatIntervalMs: cfg.interval,
			state: unlocked ? "ACTIVE" : "LOCKED", unlocked, known: Object.keys(state.servers).length,
			authenticated: Object.values(state.servers).filter(s => s.password != null).length, activeAgents: active,
			caches: state.stats.caches, deployments: state.stats.deployments, blocked: state.stats.blocked,
			stasis: safe(() => ns.dnet.getStasisLinkedServers().length, 0), instability: safe(() => ns.dnet.getDarknetInstability(), null),
			last: state.last, errors: state.stats.errors, risky: { stasis: cfg.stasis, migrate: cfg.migrate, promoteStock: cfg.promoteStock, freezeUnknown: cfg.freezeUnknown, stormSeed: cfg.stormSeed } });
		await ns.sleep(cfg.interval);
	}
}

export function managerConfig(flags) {
	return { port: Number(flags.port), eventPort: Number(flags["event-port"]), interval: Math.max(1_000, Number(flags.interval) || 5_000),
		phish: bool(flags.phish), phishThreads: Number(flags["phish-threads"]), maxAttempts: Number(flags["max-attempts"]), stasis: bool(flags.stasis),
		stasisDepth: Number(flags["stasis-depth"]), migrate: bool(flags.migrate), migrateDepth: Number(flags["migrate-depth"]), migrateEvery: Number(flags["migrate-every"]),
		promoteStock: bool(flags["promote-stock"]), stockSymbols: String(flags["stock-symbols"]), freezeUnknown: bool(flags["freeze-unknown"]),
		freezeDepth: Number(flags["freeze-depth"]), stormSeed: bool(flags["storm-seed"]) };
}

function ensureHomeAgent(ns, cfg) {
	if (ns.ps("home").some(p => p.filename === AGENT)) return;
	const agentCfg = { ...cfg }; delete agentCfg.port;
	ns.run(AGENT, { threads: 1, temporary: true }, JSON.stringify(agentCfg));
}

async function restoreAnchors(ns, cfg, state) {
	for (const host of safe(() => ns.dnet.getStasisLinkedServers(), [])) {
		const password = state.servers[host]?.password;
		if (password == null || safe(() => ns.ps(host).some(p => p.filename === AGENT), false)) continue;
		try {
			if (!ns.dnet.connectToSession(host, password).success) continue;
			if (!await ns.scp(AGENT_FILES, host, "home")) continue;
			const agentCfg = { ...cfg }; delete agentCfg.port;
			ns.exec(AGENT, host, { threads: 1, preventDuplicates: true, temporary: true }, JSON.stringify(agentCfg));
		} catch {}
	}
}

export function applyEvent(state, event) {
	state.last = `${event.kind}: ${event.host || event.symbol || event.error || "event"}`;
	if (event.kind === "agent") state.agents[`${event.host}:${event.pid}`] = { at: event.at, state: event.state, depth: event.depth };
	if (["seen", "credential", "blocked", "deployed", "cache", "stasis", "migration"].includes(event.kind) && event.host) {
		const server = state.servers[event.host] ??= { firstSeen: event.at };
		server.lastSeen = event.at; if (event.details) Object.assign(server, event.details);
		if (event.kind === "credential") { server.password = event.password; server.modelId = event.modelId; server.authenticatedAt = event.at; }
		if (event.kind === "blocked") { server.blocker = event.reason; state.stats.blocked++; }
	}
	if (event.kind === "cache") state.stats.caches++;
	if (event.kind === "deployed" && event.pid) state.stats.deployments++;
	if (event.kind === "error") state.stats.errors++;
}

function emptyState(epoch) { return { version: 1, resetEpoch: epoch, servers: {}, agents: {}, stats: { caches: 0, deployments: 0, blocked: 0, errors: 0 }, last: "Waiting for first probe" }; }
function loadState(ns) { try { const v = JSON.parse(ns.read(STATE_FILE)); return v?.version === 1 ? v : emptyState(""); } catch { return emptyState(""); } }
async function saveState(ns, state) { await ns.write(STATE_FILE, JSON.stringify(state), "w"); }
function bool(value) { return value === true || String(value).toLowerCase() === "true"; }
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
