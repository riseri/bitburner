import { formulaGroup } from "lib/formulas.js";
import { HACKING_POLICY, refreshHackingPolicy, hackingXpProgress, renderHackingPolicy } from "lib/hacking-policy.js";
import { PORTS } from "lib/ports.js";
import { dashboardTitle, dashboardRow } from "lib/dashboard.js";

// Reuse deployed executors. H uses the existing one-shot PREP protocol; G/W
// already have cheaper one-shot workers with owner-tagged orphan cleanup.
export const XP_WORKERS = Object.freeze({ H: "jit-hack.js", G: "background-grow.js", W: "background-weaken.js" });

export function xpCapacity(ns, network, cfg, running = new Map()) {
	return network.hosts.filter(h => h.name !== "home").map(host => {
		try {
			const owned = [...running.values()].filter(job => job.host === host.name).reduce((n, job) => n + job.ram, 0);
			const shareRam = cfg.fleetShare ? ns.ps(host.name).filter(p => p.filename === "share-worker.js")
				.reduce((sum, p) => sum + p.threads * ns.getScriptRam(p.filename, host.name), 0) : 0;
			const free = Math.max(0, Math.min(host.maxRam, host.maxRam - ns.getServerUsedRam(host.name) + owned + shareRam));
			const ram = Object.fromEntries(Object.entries(XP_WORKERS).map(([action, file]) => [action, ns.getScriptRam(file, host.name)]));
			return { ...host, free, ram };
		} catch { return null; } // Fleet removal can race the last published network.
	}).filter(h => h && h.free > 0).sort((a, b) => b.free - a.free || a.name.localeCompare(b.name))
		.slice(0, Math.min(cfg.maxLaunches, cfg.maxWorkers));
}

function slots(host, action) {
	return Number.isFinite(host.ram[action]) && host.ram[action] > 0 ? Math.floor(host.free / host.ram[action]) : 0;
}

export function validXpServer(server, level, allowEmpty = false) {
	return server.hostname !== "home" && !server.purchasedByPlayer && server.hasAdminRights &&
		Number.isFinite(server.requiredHackingSkill) && server.requiredHackingSkill <= level &&
		Number.isFinite(server.minDifficulty) && server.minDifficulty < 100 &&
		Number.isFinite(server.moneyMax) && (allowEmpty ? server.moneyMax >= 0 : server.moneyMax > 0);
}

/** Rates for sustainable, sequential cycles, including integer placement and repair.
 * Growth at moneyMax gives full XP and does not fortify; weaken at min also gives
 * full XP. A hack cycle includes success-weighted W/G/W time and XP, not just H.
 */
export function scoreXpTargets(ns, names, hosts, cfg, options = HACKING_POLICY) {
	const api = formulaGroup(ns, "hacking", ["hackExp", "hackChance", "hackPercent", "hackTime",
		"growTime", "weakenTime", "weakenEffect", "growThreads"]);
	if (!api) return [];
	const player = ns.getPlayer(), results = [], capacity = hosts.reduce((n, h) => n + h.free, 0);
	if (!(capacity > 0)) return [];
	for (const name of names) {
		if (cfg.requestedTarget !== "auto" && cfg.requestedTarget !== name) continue;
		try {
			const live = ns.getServer(name);
			if (!validXpServer(live, player.skills.hacking)) continue;
			const server = { ...live, hackDifficulty: live.minDifficulty, moneyAvailable: live.moneyMax };
			const exp = api.hackExp(server, player), chance = Math.max(0, Math.min(1, api.hackChance(server, player)));
			const times = { H: api.hackTime(server, player), G: api.growTime(server, player), W: api.weakenTime(server, player) };
			if (!(exp > 0) || ![exp, chance, ...Object.values(times)].every(Number.isFinite) || Object.values(times).some(t => t <= 0)) continue;
			for (const action of ["W", "G"]) {
				const threads = hosts.reduce((n, h) => n + slots(h, action), 0);
				const ram = hosts.reduce((n, h) => n + slots(h, action) * (h.ram[action] || 0), 0);
				const score = exp * threads * 1000 / (times[action] + options.tickMs);
				if (score > 0) results.push({ name, action, score, xpPerSecond: score, xpPerGb: score / capacity,
					rawXpPerSecond: score, threads, ram, duration: times[action], exp, chance });
			}
			const percent = api.hackPercent(server, player);
			if (!(percent > 0) || !Number.isFinite(percent)) continue; // zero-money hacks award only 25% XP
			for (const host of hosts) {
				const threads = Math.min(slots(host, "H"), Math.floor(cfg.maxSteal / percent));
				if (!(threads > 0)) continue;
				const cores = host.cores || 1, effect = api.weakenEffect(1, cores);
				const hSec = ns.hackAnalyzeSecurity(threads);
				const afterHack = { ...server, moneyAvailable: server.moneyMax * (1 - threads * percent) };
				const grow = Math.ceil(api.growThreads(afterHack, player, server.moneyMax, cores));
				const gSec = ns.growthAnalyzeSecurity(grow);
				const w1 = Math.ceil(hSec / effect), w2 = Math.ceil(gSec / effect);
				if (!(effect > 0) || ![grow, w1, w2].every(Number.isFinite) || grow < 0 ||
					grow > slots(host, "G") || Math.max(w1, w2) > slots(host, "W")) continue;
				const repairTime = api.weakenTime({ ...server, hackDifficulty: server.minDifficulty + hSec }, player) +
					times.G + api.weakenTime({ ...server, hackDifficulty: server.minDifficulty + gSec }, player) + 3 * options.tickMs;
				const rawXp = exp * threads * (0.25 + 0.75 * chance);
				const score = (rawXp + chance * exp * (grow + w1 + w2)) * 1000 /
					(times.H + options.tickMs + chance * repairTime);
				if (Number.isFinite(score) && score > 0) results.push({ name, action: "H", host: host.name,
					score, xpPerSecond: score, xpPerGb: score / capacity, rawXpPerSecond: rawXp * 1000 / times.H,
					threads, ram: threads * host.ram.H, duration: times.H, exp, chance, repair: { grow, w1, w2 } });
			}
		} catch { /* An unavailable formula or newly inaccessible host cannot stop the daemon. */ }
	}
	return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function selectXpTarget(ranked, current = null, options = HACKING_POLICY) {
	if (!ranked.length) return null;
	// Within a small margin prefer the executor that never damages the target.
	const near = ranked.filter(c => c.score * (1 + options.actionTie) >= ranked[0].score);
	const best = near.sort((a, b) => "WGH".indexOf(a.action) - "WGH".indexOf(b.action) || b.score - a.score)[0];
	const incumbent = current && ranked.find(c => c.name === current.name && c.action === current.action && c.host === current.host);
	return incumbent && best.score <= incumbent.score * (1 + options.switchImprovement) ? incumbent : best;
}

export function stableXpRate(samples, expected, options = HACKING_POLICY) {
	const rates = samples.slice(-options.stableSamples);
	if (rates.length < options.stableSamples || rates.some(r => !Number.isFinite(r) || r <= 0) ||
		(expected !== null && !(expected > 0))) return null;
	const rate = rates.reduce((a, b) => a + b, 0) / rates.length;
	// An optional model check is useful in isolation. Parallel lanes use the
	// player's combined observed rate, which already includes both objectives.
	return Math.max(...rates) / Math.min(...rates) <= 1 + options.rateTolerance &&
		(expected === null || Math.abs(rate / expected - 1) <= options.rateTolerance) ? rate : null;
}

function fallbackTarget(ns, network, cfg) {
	const targets = [];
	for (const name of network.servers) {
		if (cfg.requestedTarget !== "auto" && cfg.requestedTarget !== name) continue;
		try {
			if (validXpServer(ns.getServer(name), ns.getHackingLevel(), true)) targets.push({ name, action: "W", score: 0, duration: ns.getWeakenTime(name) });
		} catch {}
	}
	return targets.filter(t => Number.isFinite(t.duration) && t.duration > 0).sort((a, b) => a.duration - b.duration)[0] || null;
}

function launchXpWave(ns, ctx, choice, hosts, running, serial, fallback, options) {
	const { cfg } = ctx, server = ns.getServer(choice.name);
	const dirty = server.hackDifficulty > server.minDifficulty + 0.001;
	const needsMoney = server.moneyAvailable < server.moneyMax;
	const action = dirty ? "W" : !fallback && needsMoney ? "G" : choice.action;
	const preparing = dirty || needsMoney;
	const duration = action === "H" ? ns.getHackTime(choice.name) : action === "G" ? ns.getGrowTime(choice.name) : ns.getWeakenTime(choice.name);
	if (!Number.isFinite(duration) || duration <= 0) return null;
	const api = !fallback ? formulaGroup(ns, "hacking", ["growThreads", "weakenEffect"]) : null;
	if (!fallback && !api) return null;
	let launched = 0;
	for (const host of hosts) {
		if (choice.action === "H" && host.name !== choice.host) continue;
		let threads = slots(host, action);
		if (action === "H") threads = Math.min(threads, choice.threads);
		else if (choice.action === "H") {
			const need = action === "W" ? Math.ceil((server.hackDifficulty - server.minDifficulty) / api.weakenEffect(1, host.cores || 1))
				: Math.ceil(api.growThreads({ ...server }, ns.getPlayer(), server.moneyMax, host.cores || 1));
			threads = Math.min(threads, need);
		}
		if (!Number.isSafeInteger(threads) || threads <= 0) continue;
		if (ctx.canLaunch && !ctx.canLaunch()) break;
		const id = `bgprep-xp-${ns.pid}-${serial}-${host.name}`, now = Date.now();
		const args = action === "H" ? [choice.name, now + duration + options.tickMs, id, cfg.port, "PREP-H", id,
			cfg.gap, 0, duration, now, 0, threads] : [choice.name, ns.pid, id];
		ctx.reclaimShare?.(host.name);
		let pid = 0;
		try { pid = ns.exec(XP_WORKERS[action], host.name, threads, ...args); }
		catch { /* A removed worker host does not cancel work already launched elsewhere. */ }
		if (pid) {
			const job = { id, host: host.name, ram: threads * host.ram[action], target: choice.name, action, threads };
			running.set(pid, job); ctx.onLaunch?.(pid, job); launched++;
		}
	}
	return launched ? { action, preparing, duration, launched } : null;
}

// The optional XP lane borrows only capacity not committed to money. Its PIDs,
// non-expiring reservations and launch slots live in the money scheduler's ledger.
export function createXpPipeline(pool) {
	const state = { jobs: new Map(), choice: null, wave: null, samples: [], cycle: null,
		nextTick: 0, nextScore: 0, retryAt: 0, serial: 0, scan: null,
		status: "DISABLED", reason: "money pipeline remains primary", earned: 0, income: [],
		preemptRetryMs: (pool.cfg.policyOptions || HACKING_POLICY).xpPreemptRetryMs };
	state.release = (pid, status = "done") => {
		const job = state.jobs.get(pid);
		if (!job) return;
		job.status = status; job.reservation.end = Date.now();
		if (pool.running.has(pid)) pool.api.untrackRunning(pool.running, pid, job);
		pool.runningByChunk.delete(job.chunkId); state.jobs.delete(pid);
	};
	return state;
}

export function reclaimXpRam(ns, state, host = null) {
	if (!state?.jobs.size) return false;
	let released = false;
	for (const [pid, job] of state.jobs) {
		if (host && job.host !== host) continue;
		if (ns.isRunning(pid) && !ns.kill(pid) && ns.isRunning(pid)) continue;
		state.release(pid, "skip"); released = true;
	}
	state.samples.length = 0; state.cycle = null; state.scan = null;
	state.nextScore = 0; state.retryAt = Date.now() + state.preemptRetryMs;
	state.status = "WAITING_RAM"; state.reason = "money work has priority; waiting for spare RAM";
	return released;
}

export function claimXpTarget(ns, pool, target) {
	if (![...(pool.xp?.jobs.values() || [])].some(job => job.target === target)) return true;
	reclaimXpRam(ns, pool.xp);
	return ![...pool.xp.jobs.values()].some(job => job.target === target);
}

export function consumeXpEvent(pool, event) {
	if (event?.phase !== "PREP-H") return false;
	const state = pool.xp;
	const job = [...(state?.jobs.values() || [])].find(job => job.id === event.batchId && job.id === event.chunkId && job.target === event.target);
	if (!job || job.action !== "H") return false;
	if (event.type === "done" && event.result > 0 && !job.paid) {
		job.paid = true; state.earned += event.result;
		state.income.push({ time: Date.now(), money: event.result });
	}
	return true;
}

function xpExcludedTargets(pool) {
	return new Set([...pool.pipelines.keys(), pool.pendingAdmission,
		...(pool.cfg.prepStates || []).map(p => p?.target)].filter(Boolean));
}

export function tickXpPipeline(ns, pool, launchBudget) {
	const state = pool.xp, now = Date.now(), options = pool.cfg.policyOptions || HACKING_POLICY;
	if (!state || now < state.nextTick) return;
	state.nextTick = now + options.tickMs;
	for (const [pid] of state.jobs) if (!ns.isRunning(pid)) state.release(pid);
	state.income = state.income.filter(s => s.time >= now - 60_000);
	const enabled = pool.cfg.hackingPolicy?.mode === "XP", excluded = xpExcludedTargets(pool);
	if ([...state.jobs.values()].some(job => excluded.has(job.target)) ||
		[...pool.pipelines.values()].some(p => p.mode !== "RUNNING" || p.recovery || p.drain || p.shadow)) {
		reclaimXpRam(ns, state);
		state.status = enabled ? "WAITING_MONEY" : "DISABLED";
		state.reason = "money preparation, tuning or recovery has priority";
		return;
	}
	if (!enabled) {
		state.status = state.jobs.size ? "DRAINING" : "DISABLED";
		state.reason = state.jobs.size ? "finishing XP wave; money continues" : "XP not requested by policy";
		state.samples.length = 0; state.cycle = null; state.scan = null; state.nextScore = 0;
		return;
	}
	if (state.jobs.size) return;
	if (now < state.retryAt) return;
	// The explicit --target flag pins the money lane. XP needs a separate target.
	const cfg = { ...pool.cfg, requestedTarget: "auto" };
	const hosts = xpCapacity(ns, pool.network, cfg).map(host => ({ ...host,
		free: Math.min(host.free, pool.api.availableRam(ns, host, cfg, pool.running,
			pool.reservations, now, Infinity, pool.foreign)) })).filter(h => h.free > 0);
	if (!hosts.length) {
		state.status = "WAITING_RAM"; state.reason = "no RAM left after money reservations";
		state.samples.length = 0; state.cycle = null; return;
	}
	if (state.choice && excluded.has(state.choice.name)) { state.choice = null; state.nextScore = 0; }
	if (now >= state.nextScore) state.scan ||= { names: pool.network.servers.filter(n => !excluded.has(n)), index: 0, ranked: [] };
	if (state.scan) {
		const scan = state.scan, started = Date.now();
		// Bound formula work between due money launches, including on large networks.
		for (let count = 0; count < 4 && scan.index < scan.names.length && Date.now() - started < 3; count++) {
			const name = scan.names[scan.index++];
			if (!excluded.has(name)) scan.ranked.push(...scoreXpTargets(ns, [name], hosts, cfg, options));
		}
		if (scan.index < scan.names.length) {
			state.status = "SCORING"; state.reason = "scanning independent XP targets"; return;
		}
		const ranked = scan.ranked.filter(c => !excluded.has(c.name)).sort((a, b) => b.score - a.score);
		const selected = selectXpTarget(ranked, state.choice, options);
		if (selected?.name !== state.choice?.name || selected?.action !== state.choice?.action || selected?.host !== state.choice?.host) {
			state.samples.length = 0; state.cycle = null;
		}
		state.choice = selected; state.scan = null; state.nextScore = now + options.rescoreMs;
	}
	if (!state.choice) { state.status = "WAITING_TARGET"; state.reason = "no independent, usable XP target"; return; }
	let server;
	try { server = ns.getServer(state.choice.name); } catch { server = null; }
	if (!server || !validXpServer(server, ns.getHackingLevel())) {
		state.choice = null; state.nextScore = 0; return;
	}
	const clean = server.hackDifficulty <= server.minDifficulty + 0.001 && server.moneyAvailable >= server.moneyMax;
	if (clean) {
		const exp = ns.getPlayer().exp.hacking;
		if (state.cycle && now > state.cycle.at) state.samples.push((exp - state.cycle.exp) * 1000 / (now - state.cycle.at));
		if (state.samples.length > options.stableSamples) state.samples.shift();
		state.cycle = { at: now, exp };
	}
	const context = { cfg,
		reclaimShare: host => pool.api.reclaimFleetShare(ns, host),
		canLaunch: () => launchBudget.canLaunch(),
		onLaunch(pid, job) {
			Object.assign(job, { chunkId: job.id, batchId: job.id, phase: `XP-${job.action}`,
				launchAt: Date.now(), landAt: Infinity, status: "running", launchIssued: true });
			job.reservation = pool.api.reserveChunk(pool.reservations, job);
			pool.api.trackRunning(pool.running, pid, job); pool.runningByChunk.set(job.id, pid);
			launchBudget.record(job);
		} };
	try { state.wave = launchXpWave(ns, context, state.choice, hosts, state.jobs, ++state.serial, false, options); }
	catch { state.wave = null; state.nextScore = 0; }
	state.status = state.jobs.size ? state.wave?.preparing ? "PREPARING" : "RUNNING" : "WAITING_RAM";
	state.reason = state.jobs.size ? "borrowing unreserved RAM; yields to money" : "waiting for spare RAM or worker/launch slots";
	if (!state.jobs.size) { state.samples.length = 0; state.cycle = null; }
}

export function xpPipelineStatus(ns, pool) {
	const state = pool.xp;
	if (!state) return {};
	// Both lanes contribute to the player's level: use the stable combined rate,
	// never present money-lane XP as XP-lane-only throughput.
	const rate = state.status === "RUNNING" ? stableXpRate(state.samples, null, pool.cfg.policyOptions || HACKING_POLICY) : null;
	return { operationalMode: state.jobs.size ? "MONEY+XP" : pool.cfg.hackingPolicy?.mode === "MONEY" ? "MONEY" : "NORMAL",
		progress: pool.cfg.hackingPolicy?.mode === "XP" ? hackingXpProgress(ns, pool.cfg.hackingPolicy, rate, pool.cfg.policyOptions || HACKING_POLICY) : null,
		xp: { target: state.choice?.name || "", action: state.wave?.action || state.choice?.action || "",
			state: state.status, reason: state.reason, ram: [...state.jobs.values()].reduce((n, j) => n + j.ram, 0),
			workers: state.jobs.size, estimatedXpPerSecond: state.choice?.score || null,
			observedTotalXpPerSecond: rate, samples: state.samples.length, allocation: "spare" } };
}

function publishFallbackStatus(ns, ctx, choice, running) {
	const policy = { ...ctx.cfg.hackingPolicy, operationalMode: "NORMAL",
		transition: "no batch fits; safe weaken fallback while retrying money planning" };
	const snapshot = { type: "jit-status", version: 2, pid: ns.pid, generatedAt: Date.now(), mode: "fallback",
		policy, income60: 0, target: choice?.name || "",
		earned: ctx.earned || 0, model: 0, pipelines: [],
		usedRam: [...running.values()].reduce((n, job) => n + job.ram, 0),
		totalRam: ctx.network.hosts.reduce((n, h) => n + h.maxRam, 0), note: policy.reason };
	const port = ns.getPortHandle(PORTS.JIT_STATUS); port.clear(); port.tryWrite(snapshot);
	ns.clearLog(); dashboardTitle(ns, `JIT DAEMON :: FALLBACK :: hacking ${ns.getHackingLevel()}`);
	renderHackingPolicy(ns, policy, ctx.cfg.dashboardDetails);
	dashboardRow(ns, "Fallback", `${choice?.name || "waiting for rooted target"} | W | ${running.size} workers`);
}

// Only used when no money plan exists at all. Retry money every rescore interval;
// this is not an exclusive XP mode and never displaces a runnable money pipeline.
export async function runHackingFallback(ns, ctx, api) {
	const { cfg } = ctx, options = cfg.policyOptions || HACKING_POLICY;
	const running = new Map();
	let choice = null, nextUi = 0, nextNetwork = 0, serial = 0;
	const retryAt = Date.now() + options.rescoreMs;
	api.clearFleetShare(ns, ctx.network.hosts);
	ns.atExit(() => { for (const pid of running.keys()) ns.kill(pid); }, "hacking-xp");
	while (true) {
		const now = Date.now();
		for (const pid of running.keys()) if (!ns.isRunning(pid)) running.delete(pid);
		if (now >= nextNetwork) {
			nextNetwork = now + options.uiMs;
			const fleet = ctx.fleetPort.peek();
			if (fleet?.type === "fleet-status") {
				api.applyFleetStatus(ctx.cloudState, fleet);
				ctx.network = api.networkFromFleetStatus(fleet, ctx.minimumWorkerRam) || ctx.network;
			}
		}
		refreshHackingPolicy(ns, cfg, ctx.network);
		if (!running.size) {
			if (now >= retryAt) return ctx.network;
			const hosts = xpCapacity(ns, ctx.network, cfg);
			choice = fallbackTarget(ns, ctx.network, cfg);
			if (choice) {
				let server;
				try { server = ns.getServer(choice.name); } catch { server = null; }
				if (!server || !validXpServer(server, ns.getHackingLevel(), true)) {
					choice = null; await ns.sleep(options.tickMs); continue;
				}
				try { launchXpWave(ns, ctx, choice, hosts, running, ++serial, true, options); }
				catch { /* Retry with the next fleet snapshot. */ }
			}
		}
		if (now >= nextUi) {
			nextUi = now + options.uiMs;
			publishFallbackStatus(ns, ctx, choice, running);
		}
		await ns.sleep(options.tickMs);
	}
}
