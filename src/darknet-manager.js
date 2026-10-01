import { readProgressionSnapshot } from "lib/progression-objective.js";
import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { LEASE_MS } from "lib/darknet-coordination.js";
import { homeShareRam, reclaimHomeShare } from "lib/home-share.js";

const STATE_FILE = "data/darknet-state.json", AGENT = "darknet-agent.js", RUNNER = "darknet-bootstrap.js", AGENT_VERSION = 7, CRAWLER_RAM = 15.9;
const AGENT_FILES = [RUNNER, AGENT, "darknet-phish.js", "darknet-stasis.js", "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js", "lib/darknet-solvers.js", "lib/darknet-formulas.js", "lib/darknet-coordination.js", "lib/ports.js"];

/** Home-owned durable Darknet coordinator. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["port", PORTS.DARKNET_STATUS], ["event-port", PORTS.DARKNET_EVENTS], ["interval", 5_000],
		["phish", true], ["phish-threads", 1024], ["max-attempts", 600], ["concurrency", 4], ["agent-threads", 4], ["home-reserve", 8], ["stasis", false], ["stasis-depth", 8],
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
	const homeWatch = { pid: 0, since: 0, exits: 0, lastExit: 0 };
	const epoch = resetEpoch(ns.getResetInfo());
	if (state.resetEpoch !== epoch) state = emptyState(epoch);
	// Old workers have no lease protocol. Retire them before admitting coordinated work.
	for (const host of new Set(["home", "darkweb", ...Object.keys(state.servers), ...Object.keys(state.agents).map(key => key.slice(0, key.lastIndexOf(":")))])) {
		for (const process of safe(() => ns.ps(host), [])) if ([AGENT, RUNNER].includes(process.filename) && agentVersion(process) !== AGENT_VERSION) ns.kill(process.pid);
	}
	while (true) {
		const unlocked = ns.fileExists("DarkscapeNavigator.exe", "home") || Number(ns.getResetInfo()?.currentNode) === 15;
		let homeAgent = { ok: false, reason: "Darknet locked" };
		if (unlocked) {
			homeAgent = ensureHomeAgent(ns, cfg, readProgressionSnapshot(ns));
			if (Date.now() - lastRestore >= 30_000) { await restoreAnchors(ns, cfg, state); lastRestore = Date.now(); }
		}
		const now = Date.now();
		await drainEvents(ns, state, eventPort, now);
		const active = Object.values(state.agents).filter(a => ns.isRunning(a.pid) && now - a.at < 15_000).length;
		const health = unlocked ? homeAgentHealth(ns, state, homeAgent, homeWatch, now) : { state: "LOCKED", blocker: "Darknet locked" };
		statusPort.clear(); statusPort.write({ type: "darknet-status", version: 1, producerPid: ns.pid, generatedAt: now, heartbeatIntervalMs: cfg.interval,
			...health, resetEpoch: epoch, value: darknetValue(ns,state), homeAgentPid: homeAgent.pid || 0, homeAgentRestarts: homeWatch.exits, unlocked, formulas: ns.fileExists("Formulas.exe", "home"), known: Object.keys(state.servers).length,
			credentials: Object.values(state.servers).filter(s => s.password != null).length, activeAgents: active,
			cracking: Object.entries(state.cracking).map(([host, activity]) => ({ host, modelId: activity.modelId, since: activity.at, pid: activity.pid, expiresAt: activity.expiresAt })),
			coordination: coordinationState(state), leaseRecoveries: state.stats.leaseRecoveries || 0, leaseContentions: state.stats.leaseContentions || 0,
			deepest: Math.max(0, ...Object.values(state.servers).map(s => Number(s.depth) || 0)),
			currentBlockers: Object.entries(state.servers).filter(([, server]) => server.blocker).map(([host, server]) => ({ host, reason: server.blocker, freeRam: server.freeRam, requiredRam: server.requiredRam })),
			caches: state.stats.caches, deployments: state.stats.deployments, blocked: state.stats.blocked,
			stasis: safe(() => ns.dnet.getStasisLinkedServers().length, 0), instability: safe(() => ns.dnet.getDarknetInstability(), null),
			last: state.last, lastError: state.lastError, errors: state.stats.errors, risky: { stasis: cfg.stasis, migrate: cfg.migrate, promoteStock: cfg.promoteStock, freezeUnknown: cfg.freezeUnknown, stormSeed: cfg.stormSeed } });
		await ns.sleep(Math.min(cfg.interval, 1_000));
	}
}

function homeAgentHealth(ns, state, agent, watch, now) {
	if (watch.pid && !ns.isRunning(watch.pid)) {
		watch.exits++; watch.lastExit = now; watch.pid = 0;
	}
	if (!agent.ok) return { state: "BLOCKED", blocker: agent.reason };
	if (watch.pid !== agent.pid) { watch.pid = agent.pid; watch.since = now; }
	if (!ns.isRunning(agent.pid)) return { state: "BLOCKED", blocker: `home crawler PID ${agent.pid} exited; inspect its script log` };
	const heartbeat = state.agents[`home:${agent.pid}`];
	if (heartbeat?.state === "running" && now - heartbeat.at < 15_000) return { state: "ACTIVE", blocker: "" };
	if (watch.exits && now - watch.lastExit < 30_000) return { state: "BLOCKED", blocker: `home crawler exited (${watch.exits} restarts); waiting for PID ${agent.pid} heartbeat` };
	if (now - watch.since >= 15_000) return { state: "BLOCKED", blocker: `home crawler PID ${agent.pid} has no recent heartbeat; inspect its script log` };
	return { state: "STARTING", blocker: `waiting for home crawler PID ${agent.pid} heartbeat` };
}

export function managerConfig(flags) {
	return { port: Number(flags.port), eventPort: Number(flags["event-port"]), interval: Math.max(1_000, Number(flags.interval) || 5_000),
		phish: bool(flags.phish), phishThreads: Number(flags["phish-threads"]), maxAttempts: Number(flags["max-attempts"]), concurrency: Number(flags.concurrency), agentThreads: Math.max(1, Math.floor(Number(flags["agent-threads"]) || 4)), homeReserve: Math.max(0, Number(flags["home-reserve"]) || 0), stasis: bool(flags.stasis),
		stasisDepth: Number(flags["stasis-depth"]), migrate: bool(flags.migrate), migrateDepth: Number(flags["migrate-depth"]), migrateEvery: Number(flags["migrate-every"]),
		promoteStock: bool(flags["promote-stock"]), stockSymbols: String(flags["stock-symbols"]), freezeUnknown: bool(flags["freeze-unknown"]),
		freezeDepth: Number(flags["freeze-depth"]), stormSeed: bool(flags["storm-seed"]) };
}

function ensureHomeAgent(ns, cfg, objective = null) {
	const agents = ns.ps("home").filter(p => p.filename === AGENT);
	const existing = agents.find(p => agentVersion(p) === AGENT_VERSION);
	if (existing) return { ok: true, pid: existing.pid };
	for (const process of agents) ns.kill(process.pid);
	const agentCfg = { ...cfg, coordinationPort: cfg.port, version: AGENT_VERSION }; delete agentCfg.port;
	const required = ns.getScriptRam(AGENT, "home");
	// Bound the crawler's allocation, not the whole machine's free RAM. Keeping
	// 75% completely idle prevented startup despite the planner reporting READY.
	const cap = objective && ["hacking", "reputation"].includes(objective.limitingResource)
		? Math.min(cfg.agentThreads, Math.max(1, Math.floor(ns.getServerMaxRam("home") * .25 / required))) : cfg.agentThreads;
	let free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
	const desired = homeAgentThreads(free + homeShareRam(ns), required, cap, cfg.homeReserve);
	if (desired > 0) {
		reclaimHomeShare(ns, desired * required + cfg.homeReserve);
		free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
	}
	const threads = homeAgentThreads(free, required, cap, cfg.homeReserve);
	const pid = threads > 0 ? ns.run(AGENT, { threads, temporary: true }, JSON.stringify(agentCfg)) : 0;
	if (pid) return { ok: true, pid };
	return { ok: false, reason: `home agent launch failed (${free.toFixed(2)} GB free; ${required.toFixed(2)} GB + ${cfg.homeReserve.toFixed(2)} GB reserve required)` };
}

export function homeAgentThreads(free, perThread, cap, reserve = 8) {
	if (!(perThread > 0)) return 0;
	return Math.max(0, Math.min(Math.floor(cap), Math.floor((Math.max(0, free - reserve) + 1e-9) / perThread)));
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
			const agentCfg = { ...cfg, coordinationPort: cfg.port, version: AGENT_VERSION }; delete agentCfg.port;
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
		state.agents[`${event.host}:${event.pid}`] = { pid: event.pid, at: event.at, state: event.state, depth: event.depth };
		if (state.servers[event.host]) { state.servers[event.host].accessedAt ??= event.at; delete state.servers[event.host].blocker; delete state.servers[event.host].freeRam; delete state.servers[event.host].requiredRam; }
	}
	state.cracking ??= {};
	const lease = state.cracking[event.host];
	if (["credential", "blocked", "deployed", "completed"].includes(event.kind) && lease?.token === event.token && lease?.pid === event.pid) delete state.cracking[event.host];
	if (["seen", "cracking", "credential", "blocked", "deployed", "cache", "stasis", "migration", "freeze"].includes(event.kind) && event.host) {
		const server = state.servers[event.host] ??= { firstSeen: event.at };
		server.lastSeen = event.at; if (event.details) Object.assign(server, event.details);
		if (event.kind === "credential") { server.password = event.password; server.modelId = event.modelId; server.authenticatedAt = event.at; }
		if (event.kind === "deployed") server.accessedAt = event.at;
		if (event.kind === "blocked") { server.blocker = event.reason; server.freeRam = event.freeRam; server.requiredRam = event.requiredRam; state.stats.blocked++; }
		if (["credential", "deployed"].includes(event.kind)) { delete server.blocker; delete server.freeRam; delete server.requiredRam; }
	}
	if (event.kind === "cache") {
        state.stats.caches++;
        state.stats.rewardReports=(state.stats.rewardReports||0)+1;
        state.stats.lastCacheResult=event.cacheResult || null;
    }
	if (event.kind === "deployed" && event.pid) state.stats.deployments++;
	if (event.kind === "error") { state.stats.errors++; state.lastError = `${event.host || "agent"}: ${event.error || event.reason || "unknown error"}`; }
}

export function handleRequest(state, request, now = Date.now()) {
	const { client, seq, pid, host } = request;
	state.replies ??= {};
	if (!client || !Number.isSafeInteger(seq) || !Number.isSafeInteger(pid)) return;
	if (state.replies[client]?.seq >= seq) return;
	let result = { ok: true };
	if (request.kind === "acquire") {
		const server = state.servers[host] ??= { firstSeen: now };
		Object.assign(server, request.details || {}, { lastSeen: now });
		const lease = state.cracking[host];
		if (now - request.at > 30_000) result = { ok: false, reason: "request-expired" };
		else if (server.password != null && !request.reconnect) result = { ok: true, password: server.password };
		else if (lease || server.retryAt > now) {
			if (lease) state.stats.leaseContentions = (state.stats.leaseContentions || 0) + 1;
			result = { ok: false, reason: lease ? "leased" : "retry-backoff", retryAt: server.retryAt };
		} else {
			const token = `${client}:${seq}`;
			state.cracking[host] = { token, pid, from: request.from, modelId: request.modelId, at: now, expiresAt: now + LEASE_MS,
				progressAt: now, progressTimeout: Math.max(120_000, Number(request.progressTimeout) || 1_800_000) };
			result = { ok: true, token, password: server.password };
		}
	} else {
		const lease = state.cracking[host];
		if (request.token && (!lease || lease.token !== request.token || lease.pid !== pid)) result = { ok: false, reason: "lease-lost" };
		else {
			if (request.kind === "blocked" && request.token) {
				state.servers[host].retryAt = now + Math.max(5_000, Number(request.retryDelay) || 60_000);
				// Only an explicit authentication rejection invalidates a credential; timeouts/offline do not.
				if (request.rejectedPassword != null && state.servers[host].password === request.rejectedPassword) delete state.servers[host].password;
			}
			applyEvent(state, { ...request, at: now });
		}
	}
	state.replies[client] = { seq, pid, at: now, result };
}

export function applyPulse(state, event, now = Date.now()) {
	if (now - event.at > LEASE_MS) return;
	applyEvent(state, { kind: "agent", host: event.from, pid: event.pid, state: "running", at: now });
	for (const update of event.leases || []) {
		const lease = state.cracking[update.host];
		if (lease?.pid !== event.pid || lease.token !== update.token || lease.expiresAt <= now) continue;
		lease.expiresAt = now + LEASE_MS;
		lease.progressAt = Math.max(lease.progressAt, Math.min(now, Number(update.progressAt) || 0));
	}
}

export function recoverLeases(ns, state, now = Date.now()) {
	let dirty = false;
	for (const [host, lease] of Object.entries(state.cracking)) {
		// A saved PID can be reused after loading a game. Never stop an unrelated script.
		const running = ns.isRunning(lease.pid), processes = running ? safe(() => ns.ps(lease.from), null) : [];
		if (running && processes === null) continue; // Uncertain ownership cannot authorize reassignment.
		const owner = processes.find(p => p.pid === lease.pid && [AGENT, RUNNER].includes(p.filename) && agentVersion(p) === AGENT_VERSION);
		const alive = Boolean(owner) && running;
		if (alive && now < lease.expiresAt && now - lease.progressAt < lease.progressTimeout) continue;
		// An awaited Netscript call cannot be cancelled with Promise.race. Fence the PID
		// before reassigning, including other targets that this disposable PID owned.
		if (alive) ns.kill(lease.pid);
		if (alive && ns.isRunning(lease.pid)) continue;
		delete state.cracking[host];
		state.stats.leaseRecoveries = (state.stats.leaseRecoveries || 0) + 1;
		dirty = true;
	}
	for (const [key, agent] of Object.entries(state.agents)) if (!agent.pid || !ns.isRunning(agent.pid)) { delete state.agents[key]; dirty = true; }
	for (const [key, reply] of Object.entries(state.replies)) if (!ns.isRunning(reply.pid) && now - reply.at > LEASE_MS) { delete state.replies[key]; dirty = true; }
	// Moving/offline hosts may return. Only prune old records once the game has
	// actually removed the server, keeping the registry bounded across mutations.
	for (const [host, server] of Object.entries(state.servers)) {
		if (!state.cracking[host] && now - Number(server.lastSeen ?? server.firstSeen ?? now) > 3_600_000 && !ns.serverExists(host)) {
			delete state.servers[host]; dirty = true;
		}
	}
	return dirty;
}

export async function drainEvents(ns, state, port, now = Date.now()) {
	let dirty = false;
	// Bound a pass even under a noisy producer. Authoritative producers retry until acked.
	for (let count = 0; count < 1_000 && !port.empty(); count++) {
		const event = port.read();
		if (event?.type === "darknet-request") handleRequest(state, event, now);
		else if (event?.type === "darknet-pulse") applyPulse(state, event, now);
		else if (event?.type === "darknet-event") {
			// Legacy optional workers only report observations, never grants or credentials.
			if (["cracking", "credential"].includes(event.kind)) continue;
			applyEvent(state, event);
		} else continue;
		dirty = true;
	}
	// Consume queued completions before recovery, so a solved credential survives a
	// coordinator outage. Acquires never replace an existing lease, even an expired one.
	dirty = recoverLeases(ns, state, now) || dirty;
	// This must finish BEFORE publishing replies, credentials, or granted leases.
	if (dirty) await saveState(ns, state);
}

export function coordinationState(state) {
	// Port payloads must not expose mutable manager objects before the next save completes.
	return JSON.parse(JSON.stringify({ credentials: Object.fromEntries(Object.entries(state.servers).filter(([, s]) => s.password != null).map(([host, s]) => [host, s.password])),
		leases: state.cracking, replies: state.replies }));
}

function emptyState(epoch) { return { version: 2, resetEpoch: epoch, servers: {}, agents: {}, cracking: {}, replies: {}, stats: { caches: 0, deployments: 0, blocked: 0, errors: 0 }, last: "Waiting for first probe" }; }
function loadState(ns) {
	try {
		const v = JSON.parse(ns.read(STATE_FILE));
		if (![1, 2].includes(v?.version)) return emptyState("");
		if (v.version === 1) { v.cracking = {}; v.replies = {}; v.version = 2; }
		return v;
	} catch { return emptyState(""); }
}
async function saveState(ns, state) { await ns.write(STATE_FILE, JSON.stringify(state), "w"); }
function bool(value) { return value === true || String(value).toLowerCase() === "true"; }
function agentVersion(process) { try { return Number(JSON.parse(String(process.args?.[0] || "{}")).version) || 0; } catch { return 0; } }
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

export function darknetValue(ns,state) {
    const agents=Object.values(state.agents).filter(a=>ns.isRunning(a.pid));
    let ram=0,unknown=0;
    for(const agent of agents) { try { const p=ns.getRunningScript(agent.pid); if(p) ram+=p.ramUsage*p.threads; else unknown++; } catch { unknown++; } }
    return {ramGb:ram,ramComplete:false,crawlerRamComplete:unknown===0,cash:null,hackingXp:null,rewardKind:"unavailable aggregate",
        cacheReports:state.stats.rewardReports||0,lastCacheResult:state.stats.lastCacheResult||null,
        usefulUnlocks:Object.values(state.servers).filter(s=>s.password!=null).length,
        note:"Crawler RAM lower bound; raw cache API results retained; cash/XP totals unavailable from current typed API"};
}
