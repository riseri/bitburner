// Background preparation owns one independent G/W process, never a second JIT
// controller. A non-expiring RAM hold protects both current and future batches.
import { formulaGrowThreads, formulaWeakenEffect, preparedHackingModel } from "lib/formulas.js";

const TICK_MS = 500;
const QUIET_MS = 60_000;
const PRODUCTIVE_MS = 120_000;
const RETRY_MS = 30_000;
const SLOT_FILL_HORIZON_MS = 10 * 60_000;
const GROW = "background-grow.js";
const WEAKEN = "background-weaken.js";

export function backgroundPrepFiles() { return [GROW, WEAKEN]; }

export function createBackgroundPrep(options = {}) {
	return {
		enabled: options.enabled !== false,
		maxRam: Math.max(0, Math.min(16_384, Number(options.maxRam ?? 16_384) || 0)),
		fraction: Math.max(0, Math.min(0.05, Number(options.fraction ?? 0.01) || 0)),
		horizon: Math.max(1, Number(options.horizonMinutes ?? 120) || 120) * 60_000,
		status: options.enabled === false ? "DISABLED" : "WAITING",
		reason: "waiting for two productive minutes",
		target: "", candidate: null, active: null, scan: null, hostCursor: 0,
		nextTick: 0, quietUntil: 0, retryAt: 0, trouble: "", waves: 0,
		preemptions: 0, failures: 0, noProgress: 0, readyAt: 0, health: null, error: "",
	};
}

export function backgroundPrepRam(state, host) {
	if (Array.isArray(state)) return state.reduce((ram, item) => ram + backgroundPrepRam(item, host), 0);
	return state?.active && (!host || state.active.host === host) ? state.active.ram : 0;
}

// The switch threshold describes the desired improvement over current income.
// Filling an empty lane is additive, so only the incremental portion is the
// candidate's hurdle. Replacing an occupied lane still uses the full multiplier.
export function emptySlotIncomeFloor(activeRate, switchThreshold) {
	const rate = Math.max(0, Number(activeRate) || 0);
	const threshold = Math.max(1, Number(switchThreshold) || 1);
	return rate * (threshold - 1);
}

// Only the recorded PID is eligible for cancellation. Never scriptKill/killall,
// and never touch JIT events, JIT control, or the active target's batch state.
export function cancelBackgroundPrep(ns, state, reason = "active hacking needs RAM") {
	if (!state) return false;
	const job = state.active;
	if (job) {
		if (ns.isRunning(job.pid) && !ns.kill(job.pid) && ns.isRunning(job.pid)) {
			state.reason = "could not cancel prep worker; retaining its RAM hold";
			return false;
		}
		state.active = null;
		state.preemptions++;
	}
	state.status = state.enabled ? "PAUSED" : "DISABLED";
	state.reason = reason;
	state.retryAt = Date.now() + RETRY_MS;
	state.quietUntil = Date.now() + QUIET_MS;
	return Boolean(job);
}

export function cleanupBackgroundOrphans(ns, hosts) {
	for (const host of hosts) {
		for (const process of ns.ps(host.name)) {
			const owner = Number(process.args[1]);
			if (Number.isSafeInteger(owner) && owner > 0 && backgroundPrepFiles().includes(process.filename) &&
				String(process.args[2] ?? "").startsWith("bgprep-") &&
				!ns.isRunning(owner)) ns.kill(process.pid);
		}
	}
}

function prepHealth(ns, target) {
	const health = {
		money: ns.getServerMoneyAvailable(target), max: ns.getServerMaxMoney(target),
		sec: ns.getServerSecurityLevel(target), min: ns.getServerMinSecurityLevel(target),
	};
	if (![health.money, health.max, health.sec, health.min].every(Number.isFinite) || health.max <= 0) {
		throw new Error(`invalid prep target: ${target}`);
	}
	health.ready = health.money >= health.max * 0.9999 && health.sec <= health.min + 0.001;
	return health;
}

function growthLog(security) {
	return Math.min(Math.log1p(0.03 / Math.max(1, security)), 0.00349388925425578);
}

// One cheap candidate estimate per tick, not a full steal/period search inside
// the live scheduler. Potential uses the active cadence and is not a tuned plan.
// At security 100 the API's chance is zero; label a chance=1 upper bound instead
// of dividing by zero or permanently excluding a recoverable rich target.
export function estimateBackgroundCandidate(ns, name, ctx) {
	if (name === "home" || name === ctx.target || ctx.activeTargets?.has(name) ||
		(ctx.blockedTargets?.get(name) || 0) > Date.now() || !ns.hasRootAccess(name) ||
		ns.getServerMaxMoney(name) <= 0) return null;
	const required = ns.getServerRequiredHackingLevel(name);
	if (required > ns.getHackingLevel()) return null;
	const h = prepHealth(ns, name);
	if (h.min >= 100) return null;
	const currentW = ns.getWeakenTime(name);
	const factor = sec => 2.5 * required * sec + 500;
	const exact = preparedHackingModel(ns, name);
	const minW = exact?.times.W ?? currentW * factor(h.min) / factor(h.sec);
	const upperBound = h.sec >= 100;
	const chance = exact?.chance ?? (upperBound ? 1 : Math.min(1,
		ns.hackAnalyzeChance(name) * (100 - h.min) / (100 - h.sec)));
	const slotFill = Boolean(ctx.slotFill);
	const promotion = Boolean(ctx.promotion);
	const activeRate = ctx.runtime.plan.expected;
	const replacementRate = Number(ctx.replacementRate) || activeRate;
	const freeRate = Number(ctx.availableBatchRate);
	const replacementBatchRate = Number(ctx.replacementBatchRate);
	const period = slotFill
		? Math.max(4 * ctx.cfg.gap + 20, 1000 / Math.max(0.25,
			Number.isFinite(freeRate) && freeRate > 0 ? freeRate : 1000 / ctx.runtime.plan.period))
		: promotion
			? Math.max(4 * ctx.cfg.gap + 20, 1000 / Math.max(0.25,
				Number.isFinite(replacementBatchRate) && replacementBatchRate > 0
					? replacementBatchRate : 1000 / ctx.runtime.plan.period))
			: Math.max(ctx.runtime.plan.period, 4 * ctx.cfg.gap + 20);
	const potential = h.max * ctx.cfg.maxSteal * 0.95 * chance * 1000 / period;
	const requiredPotential = slotFill
		? emptySlotIncomeFloor(activeRate, ctx.cfg.switchThreshold)
		: promotion ? replacementRate * ctx.cfg.switchThreshold : activeRate * ctx.cfg.switchThreshold;
	// Filling an empty second lane is additive: require enough marginal income
	// to clear the configured improvement hurdle, not enough to beat the anchor.
	// Promotion is different because it replaces an already-earning lane.
	if (!(potential > requiredPotential)) return null;

	const budget = prepBudget(ctx);
	const wSlots = Math.floor(budget / ns.getScriptRam(WEAKEN, "home"));
	const gSlots = Math.floor(budget / ns.getScriptRam(GROW, "home"));
	if (!(wSlots > 0 && gSlots > 0)) return null;
	const effect = formulaWeakenEffect(ns, 1, 1) ?? ns.weakenAnalyze(1, 1);
	const wThreads = Math.ceil(Math.max(0, h.sec - h.min) / effect);
	const wWaves = Math.ceil(wThreads / wSlots);
	let prepMs = wWaves ? currentW + (wWaves - 1) * minW : 0;
	if (h.money < h.max * 0.9999) {
		const growth = formulaGrowThreads(ns, name, h.money, h.max, 1) ??
			ns.growthAnalyze(name, h.max / Math.max(1, h.money), 1) * growthLog(h.sec) / growthLog(h.min);
		if (!Number.isFinite(growth)) return null;
		const gThreads = Math.max(1, Math.ceil(growth * 1.05));
		const waves = Math.ceil(gThreads / gSlots);
		const security = ns.growthAnalyzeSecurity(Math.min(gThreads, gSlots));
		const repairWaves = Math.max(1, Math.ceil(security / effect / wSlots));
		prepMs += waves * (minW * 0.8 + minW * factor(h.min + security) / factor(h.min) +
			(repairWaves - 1) * minW);
	}
	const warmupMs = minW + ctx.cfg.lead + 250;
	let score;
	if (slotFill) {
		// Acquisition should optimize money available soon, not the best two-hour
		// replacement. Prefer candidates that start paying inside ten minutes.
		// If every candidate is slower, retain a tiny fallback score so the
		// fastest meaningful option can still make progress.
		const horizon = Math.min(ctx.state.horizon, SLOT_FILL_HORIZON_MS);
		const earningMs = horizon - prepMs - warmupMs;
		score = earningMs > 0
			? potential * earningMs / horizon
			: potential * 0.01 / (1 + (prepMs + warmupMs) / horizon);
	} else if (promotion) {
		// Once both earning lanes are healthy, prep happens off to the side.
		// Rank promotion candidates by prepped steady earning power, not by how
		// quickly the prep cost amortizes. The current lanes keep paying meanwhile.
		score = potential;
	} else {
		score = (potential - activeRate) *
			Math.max(0, ctx.state.horizon - prepMs - warmupMs) / ctx.state.horizon;
	}
	if (!(score > 0) || !Number.isFinite(score)) return null;
	const minimumExpected = slotFill || promotion ? requiredPotential : 0;
	return { name, potential, score, prepMs, warmupMs, upperBound, slotFill, promotion, minimumExpected,
		formulas: Boolean(exact) };
}

function prepBudget(ctx) {
	const total = ctx.network.hosts.reduce((sum, h) => sum + h.maxRam, 0);
	return Math.min(ctx.state.maxRam, total * ctx.state.fraction);
}

export function tickBackgroundPrep(ns, ctx) {
	const state = ctx.state;
	const now = Date.now();
	if (now < state.nextTick) return;
	state.nextTick = now + TICK_MS;
	try {
		stepPrep(ns, ctx, now);
	} catch (error) {
		// An optional feature must not take down the income controller.
		cancelBackgroundPrep(ns, state, "background prep error");
		state.enabled = false;
		state.status = "ERROR";
		state.error = state.reason = String(error?.message ?? error);
		state.failures++;
	}
}

function stepPrep(ns, ctx, now) {
	const { state, stats, runtime } = ctx;
	const trouble = [stats.restarts, stats.recoveries, stats.softRecoveries,
		stats.allocationFails, stats.expiredSlots, ...Object.values(stats.misses)].join(":");
	if (state.trouble && trouble !== state.trouble) state.quietUntil = now + QUIET_MS;
	state.trouble = trouble;
	const productive = stats.pipeline.completed * runtime.plan.period >= PRODUCTIVE_MS;
	const recentIncome = Number.isFinite(stats.lastHackAt) && now - stats.lastHackAt < 10_000;
	const healthy = ctx.healthy && productive && recentIncome && now >= state.quietUntil;

	if (!state.enabled || (!ctx.repair && (!healthy || state.target === ctx.target || ctx.activeTargets?.has(state.target)))) {
		if (state.active) cancelBackgroundPrep(ns, state, "active pipeline has priority");
		state.status = !state.enabled ? (state.error ? "ERROR" : "DISABLED") : !productive ? "WAITING" : "PAUSED";
		state.reason = !state.enabled ? state.error || "disabled" : !productive ? "waiting for two productive minutes"
			: "waiting for a healthy active pipeline";
		if (!ctx.repair && (state.target === ctx.target || ctx.activeTargets?.has(state.target))) {
			state.target = ""; state.candidate = null; state.scan = null; state.readyAt = 0;
		}
		return;
	}

	if (state.active) {
		const job = state.active;
		if (ns.isRunning(job.pid)) {
			if (now > job.deadline) {
				cancelBackgroundPrep(ns, state, "prep worker exceeded its deadline");
				state.failures++;
			}
			return;
		}
		// A hold expires on confirmed process exit, never its predicted finish.
		state.active = null;
		const after = prepHealth(ns, state.target);
		state.health = after;
		const progressed = job.phase === "W" ? after.sec < job.before.sec : after.money > job.before.money;
		state.noProgress = progressed || after.ready ? 0 : state.noProgress + 1;
		if (state.noProgress >= 3) {
			state.enabled = false; state.status = "ERROR";
			state.error = state.reason = "three prep waves made no progress; leaving active hacking alone";
			return;
		}
	}
	if (now < state.retryAt) return;

	if (!state.target) {
		if (!state.scan) state.scan = { names: [...ctx.network.servers], index: 0, best: null };
		state.status = "SCANNING";
		const scan = state.scan;
		if (scan.index < scan.names.length) {
			const candidate = estimateBackgroundCandidate(ns, scan.names[scan.index++], ctx);
			if (candidate && (!scan.best || candidate.score > scan.best.score)) scan.best = candidate;
			state.reason = `${scan.index}/${scan.names.length} candidates; ${state.horizon / 60_000}m horizon`;
			return;
		}
		state.scan = null;
		if (!scan.best) {
			state.status = "IDLE"; state.reason = "no worthwhile background candidate";
			state.retryAt = now + 60_000;
			return;
		}
		state.target = scan.best.name; state.candidate = scan.best;
	}

	if (!ns.hasRootAccess(state.target) || ns.getServerRequiredHackingLevel(state.target) > ns.getHackingLevel()) {
		throw new Error(`prep target is no longer accessible: ${state.target}`);
	}
	const h = prepHealth(ns, state.target);
	state.health = h;
	if (h.ready) {
		state.status = "READY";
		state.reason = ctx.promotion ? "prepared for steady-state promotion"
			: ctx.slotFill ? "prepared for empty target slot" : "prepared only";
		state.readyAt ||= now;
		return;
	}
	state.readyAt = 0;
	if (ctx.allowLaunch === false) {
		state.status = "WAITING_SCHEDULER";
		state.reason = "candidate selected; waiting for a safe scheduler window";
		return;
	}
	state.status = "WAITING_RAM";
	state.reason = "waiting for unreserved capacity";
	if (!ctx.network.hosts.length) return;
	// One host capacity query per tick bounds reservation-index work. Never use
	// home: leave its controller space and upgraded cores to active income.
	const host = ctx.network.hosts[state.hostCursor++ % ctx.network.hosts.length];
	if (host.name === "home") return;
	const phase = h.sec > h.min + 0.001 ? "W" : "G";
	const script = phase === "W" ? WEAKEN : GROW;
	const perThread = ns.getScriptRam(script, "home");
	const liveFree = Math.max(0, ns.getServerMaxRam(host.name) - ns.getServerUsedRam(host.name));
	const ram = Math.min(prepBudget(ctx), ctx.spareRam(host), liveFree);
	const slots = Math.floor(ram / perThread);
	if (!(slots > 0) || !Number.isFinite(slots)) return;
	const needed = phase === "W"
		? Math.ceil((h.sec - h.min) / ns.weakenAnalyze(1, host.cores))
		: Math.ceil(ns.growthAnalyze(state.target, h.max / Math.max(1, h.money), host.cores) * 1.05);
	if (!Number.isFinite(needed)) throw new Error("non-finite prep thread estimate");
	const threads = Math.max(1, Math.min(slots, needed));
	const duration = phase === "W" ? ns.getWeakenTime(state.target) : ns.getGrowTime(state.target);
	if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("invalid prep action duration");
	const id = `bgprep-${ns.pid}-${++state.waves}`;
	const pid = ns.exec(script, host.name, threads, state.target, ns.pid, id);
	if (!pid) {
		state.failures++; state.retryAt = now + RETRY_MS;
		state.reason = "prep launch declined; active pipeline untouched";
		return;
	}
	state.active = { pid, host: host.name, ram: threads * perThread, phase, target: state.target,
		before: h, id, finishAt: now + duration, deadline: now + duration + Math.max(10_000, duration * 0.1) };
	state.status = phase === "W" ? "WEAKEN" : "GROW";
	state.reason = `${threads} threads on ${host.name}`;
}

export function backgroundPrepSummary(state) {
	if (!state) return "DISABLED";
	const eta = state.active ? ` | ETA ${Math.max(0, (state.active.finishAt - Date.now()) / 1000).toFixed(0)}s` : "";
	const health = state.health ? ` | money ${(100 * state.health.money / state.health.max).toFixed(1)}%` +
		` | sec +${Math.max(0, state.health.sec - state.health.min).toFixed(3)}` : "";
	return `${state.target || "none"} | ${state.status}${eta}${health} | ${state.reason}`;
}
