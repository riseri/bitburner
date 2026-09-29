import { createBackgroundPrep, tickBackgroundPrep, cancelBackgroundPrep, backgroundPrepRam, backgroundPrepJobs, emptySlotIncomeFloor, recentPipelineIncome } from "lib/background-prep.js";
import { createXpPipeline, tickXpPipeline, consumeXpEvent, claimXpTarget, reclaimXpRam, refreshMilestoneEvidence } from "lib/hacking-xp.js";
import { schedulerCapacity } from "lib/scheduler-capacity.js";
import { boundedXpAllocation } from "lib/milestone-balance.js";

// One event loop, one allocation ledger. A pipeline never owns the global ports,
// process map, or reservation array. Changing its epoch cannot erase a peer.
const PRODUCTIVE_MS = 120_000;
const TRIAL_MS = 180_000;
const RETRY_MS = 10 * 60_000;
const UI_MS = 10_000;
const BUCKET_MS = 250;
const IDLE_REPLAN_MS = 5_000;
const IDLE_REPLAN_MAX_BACKOFF_MS = 300_000;
const MAINTENANCE_WAIT_MS = 5_000;
const STALLED_REPLACEMENT_MS = 10 * 60_000;

export function createTargetPipeline(name, cfg, api, ownerPid, ordinal, runtime = null, stats = null) {
	const pipeline = {
		name, ordinal, epochNumber: 1, epoch: `${ownerPid}:${ordinal}:1`,
		generation: 1, generationSerial: 1, generations: new Map(), shadow: null, swap: null,
		hotSwaps: { completed: 0, aborted: 0 }, shadowRetryAt: 0,
		cfg: { ...cfg }, runtime, stats: stats || api.createStats(),
		mode: runtime ? "RUNNING" : "TUNING", queue: [], batches: new Map(),
		running: new Map(), runningRam: 0, recovery: null, drain: null,
		retiring: false, retireReason: "", trial: ordinal > 0, trialUntil: Infinity,
		liveSince: 0, firstLanding: 0, nextLanding: 0, serial: 0, allocationStreak: 0,
		admissionSkips: 0, nextHealth: 0, tunedLevel: 0, tuner: null, tuneStarted: 0,
		repair: null, control: null, note: "", nextRetry: 0, tunedCapacity: 0, lastCapacityRetune: 0,
		idleSince: null, idleRetunes: 0, idleFailures: 0, idleRetryAt: 0, idleReplanning: false,
		admissionReason: "", completedAtIdleReplan: 0, minimumExpected: 0,
		stalledSince: null, tuningWaitSince: null, lastTuneStep: 0, trialNote: "",
	};
	pipeline.cfg.epoch = pipeline.epoch;
	pipeline.cfg.generation = pipeline.generation;
	if (runtime) pipeline.generations.set(1, { number: 1, state: "ACTIVE", runtime, cfg: { ...pipeline.cfg } });
	return pipeline;
}

// The legacy safety helpers write a one-target latch. This adapter updates only
// that target's entry in the single control-port document, without another port.
export function targetControl(pool, pipeline) {
	return {
		clear() {},
		tryWrite(value) {
			pool.controls.set(pipeline.name, { paused: Boolean(value.paused),
				epoch: pipeline.epoch, generations: [...pipeline.generations.keys()], reason: String(value.reason || "") });
			pool.controlPort.clear();
			return pool.controlPort.tryWrite({ type: "jit-control", version: 2,
				ownerPid: pool.ownerPid, targets: Object.fromEntries(pool.controls), generatedAt: Date.now() });
		},
	};
}

export function createPipelinePool(ns, setup, api) {
	const pool = { ...setup, api, ownerPid: ns.pid, started: Date.now(),
		pipelines: new Map(), history: [], controls: new Map(), blocked: new Map(),
		running: new Map(), runningByChunk: new Map(), reservations: [], foreign: new Map(),
		launchBuckets: new Map(), nextOrdinal: 1, planCursor: 0, foreignCursor: 0,
		lastUi: 0, lastNetwork: Date.now(), lastReconcile: 0, lastCleanup: 0, lastMonitor: 0,
		lastLoop: Date.now(), lagMax: 0, slowTicks: [], lastFleetAt: 0,
		shareCursor: 0, lastShare: 0,
		nextForeign: 0, foreignFastUntil: 0, foreignObservations: 0, wakeups: 0, wakeAt: Date.now(), launchDriftMax: 0,
		anchor: setup.target, trialGuard: null, note: "Waiting for productive runtime before admission",
		lastAdmission: 0, nextAdmission: 0, readyScan: null, nextReadyScan: 0,
		nextAdmissionService: 0, pendingAdmission: "", pendingAdmissionFloor: 0,
	};
	pool.xp = createXpPipeline(pool); pool.cfg.xpPipeline = pool.xp;
	const first = createTargetPipeline(setup.target, setup.cfg, api, ns.pid, 0, setup.runtime, setup.stats);
	pool.pipelines.set(first.name, first);
	first.control = targetControl(pool, first);
	pool.cfg.prepStates = [pool.cfg.backgroundPrep];
	first.cfg.prepStates = pool.cfg.prepStates;
	api.seedForeignUsage(ns, pool.network.hosts, pool.running, pool.foreign);
	activatePipeline(ns, pool, first, setup.runtime, false);
	return pool;
}

function activatePipeline(ns, pool, pipeline, runtime, rebuilt) {
	const { api } = pool;
	pipeline.runtime = runtime;
	pipeline.mode = "RUNNING";
	pipeline.tuner = null;
	pipeline.tunedLevel = ns.getHackingLevel();
	pipeline.tunedCapacity = api.workerFleetCapacity(pool.network.hosts, pipeline.cfg);
	pipeline.lastCapacityRetune = Date.now();
	// Activation follows reconciled ownership (initialization or safety recovery).
	pipeline.generations.clear(); pipeline.shadow = null; pipeline.swap = null;
	pipeline.generations.set(pipeline.generation, { number: pipeline.generation, state: "ACTIVE",
		runtime, cfg: { ...pipeline.cfg }, level: pipeline.tunedLevel });
	pipeline.nextLanding = Date.now() + runtime.plan.times.W + pipeline.cfg.lead + 250;
	// Spread startup bursts; every lane still uses the common launch ledger.
	if (pipeline.ordinal > 0) pipeline.nextLanding += pipeline.cfg.gap * 0.5 * pipeline.ordinal;
	pipeline.firstLanding = pipeline.nextLanding;
	pipeline.trialUntil = pipeline.firstLanding + TRIAL_MS;
	pipeline.stats.nextHackLanding = pipeline.nextLanding;
	pipeline.stats.lastHackAt = NaN;
	pipeline.stats.lastW2 = NaN;
	pipeline.stats.lastHackLanding = NaN;
	pipeline.stats.batchTimes = [];
	pipeline.liveSince = 0;
	pipeline.allocationStreak = 0;
	pipeline.idleSince = null;
	pipeline.admissionReason = "";
	if (rebuilt) api.resetPipelineStats(pipeline.stats);
	api.publishHackPause(pipeline.control, 0, "target ready");
	pipeline.note = "Fresh target plan; initial warmup";
}

export async function runTargetPipelines(ns, setup, api) {
	const pool = createPipelinePool(ns, setup, api);
	ns.atExit(() => {
		// Only this controller's recorded workers are touched. No global scriptKill.
		for (const pipeline of pool.pipelines.values()) {
			api.publishHackPause(pipeline.control, Number.MAX_SAFE_INTEGER, "owner stopped");
		}
		for (const pid of pool.running.keys()) ns.kill(pid);
		api.clearFleetShare(ns, pool.network.hosts);
		for (const prep of pool.cfg.prepStates) cancelBackgroundPrep(ns, prep, "owner stopped");
	}, "target-pipelines");
	while (true) {
		const now = Date.now();
		const lag = Math.max(0, now - pool.wakeAt);
		pool.wakeups++;
		pool.lastLoop = now;
		pool.lagMax = Math.max(pool.lagMax, lag);
		if (lag > pool.cfg.gap * 0.6) pool.slowTicks.push(now);
		for (const p of pool.pipelines.values()) {
			p.stats.loopLagSum += lag; p.stats.loopLagCount++;
			p.stats.loopLagMax = Math.max(p.stats.loopLagMax, lag);
			p.stats.pipeline.loopLagMax = Math.max(p.stats.pipeline.loopLagMax, lag);
		}
		observeForeignRam(ns, pool, now);
		dispatchPipelineEvents(ns, pool);
		for (const p of pool.pipelines.values()) servicePipelineSafety(ns, pool, p, now);
		if (pool.port.empty()) launchPipelineChunks(ns, pool);

		if (now - pool.lastNetwork >= 10_000) refreshPipelineNetwork(ns, pool, now);
		serviceHackingPolicy(ns, pool);
		if (now - pool.lastReconcile >= 30_000) {
			pool.lastReconcile = now;
			api.reconcileRunning(ns, pool.running, pool.runningByChunk, 20);
		}
		if (now - pool.lastCleanup >= 500) {
			pool.lastCleanup = now;
			releaseCancelledLaunchBudget(pool);
			api.cleanupReservations(pool.reservations, now - 20);
			for (const slot of pool.launchBuckets.keys()) if (slot < Math.floor((now - 1000) / BUCKET_MS)) pool.launchBuckets.delete(slot);
		}

		// Discovery and quiescent tuning get a bounded opportunity before new
		// batches. Starved maintenance can defer new planning to open a safe gap.
		serviceAdmissionOpportunity(ns, pool);
		const deferPlanning = serviceMaintenanceOpportunity(ns, pool);
		// Budget is shared, not multiplied by the number of targets. Never queue
		// new work in front of an already committed due launch or worker event.
		if (!deferPlanning && pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 20) {
			planPipelineBatch(ns, pool);
		}
		if (pool.port.empty()) launchPipelineChunks(ns, pool);
		if (pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 50) {
			servicePipelineMaintenance(ns, pool);
		}
		if (pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 50) serviceXpPipeline(ns, pool);
		if (now - pool.lastMonitor >= 1000) {
			pool.lastMonitor = now;
			monitorPipelineLoad(ns, pool, now);
		}
		if (now - pool.lastShare >= 1000 && pool.port.empty() && nextPipelineLaunch(pool) - now > 20) {
			pool.lastShare = now;
			pool.shareCursor = api.reconcileFleetShare(ns, pool.network.hosts, pool.cfg, pool.running,
				pool.reservations, pool.foreign, pool.shareCursor);
		}
		if (now - pool.lastUi >= UI_MS && pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 20) {
			pool.lastUi = now;
			for (const p of [...pool.pipelines.values(), ...pool.history]) {
				p.stats.income = p.stats.income.filter(s => s.time >= now - 60_000);
				p.stats.batchTimes = p.stats.batchTimes.filter(t => t >= now - 60_000);
			}
			api.renderSchedulerDashboard(ns, pool);
		}
		const delay = schedulerSleep(pool);
		pool.wakeAt = Date.now() + delay;
		await ns.sleep(delay);
	}
}

export function observeForeignRam(ns, pool, now = Date.now()) {
	const failure = Math.max(0, ...[...pool.pipelines.values()].map(p => p.cfg.foreignFailureAt || 0));
	if (failure > (pool.lastForeignFailure || 0)) {
		pool.lastForeignFailure = failure; pool.foreignFastUntil = now + 2000; pool.nextForeign = 0;
	}
	if (now < (pool.nextForeign || 0)) return;
	const hosts = pool.network.hosts;
	const host = hosts[(pool.foreignCursor || 0) % Math.max(1, hosts.length)];
	const before = host ? pool.foreign.get(host.name) : 0;
	pool.foreignCursor = pool.api.refreshOneForeignUsage(ns, hosts, pool.running, pool.foreign, pool.foreignCursor, pool.cfg.prepStates);
	pool.foreignObservations = (pool.foreignObservations || 0) + 1;
	if (host && before !== pool.foreign.get(host.name)) pool.foreignFastUntil = now + 2000;
	const urgent = now < (pool.foreignFastUntil || 0) || [...pool.pipelines.values()].some(p => p.recovery || p.drain);
	pool.nextForeign = now + (urgent ? 25 : 200);
}

// Events have a bounded polling deadline; only committed launches use the guard
// window. Optional maintenance can be late without forcing a permanent 1ms spin.
export function schedulerSleep(pool, now = Date.now()) {
	if (!pool.port.empty()) return 1;
	const launch = nextPipelineLaunch(pool), lanes = [...pool.pipelines.values()];
	const eventCadence = pool.running.size ? Math.max(1, Math.min(25, pool.cfg.gap / 4)) : 100;
	let wake = now + eventCadence;
	const due = time => { if (Number.isFinite(time)) wake = Math.min(wake, time > now ? time : now + 20); };
	due(launch - 2);
	if (launch - now <= 2) return Math.max(1, launch - now);
	for (const [last, interval] of [[pool.lastNetwork,10000],[pool.lastReconcile,30000],[pool.lastCleanup,500],
		[pool.lastMonitor,1000],[pool.lastShare,1000],[pool.lastUi,UI_MS]]) due(last + interval);
	due(pool.nextForeign); due(pool.nextAdmissionService); due(pool.xp?.nextTick); due(pool.cfg.backgroundPrep?.nextTick);
	for (const p of lanes) {
		if (p.mode === "RUNNING") due(p.nextHealth);
		due(p.recovery?.checkAt); due(p.recovery?.deadline);
		if (p.mode === "TUNING") due(Math.max(now + 5, p.nextRetry || 0));
		if (p.shadow?.tuner) due(Math.max(now + 5, p.shadow.retryAt || 0));
		if (p.mode === "RUNNING" && !p.recovery && !p.drain && !p.swap?.restoring && launch - now > 20) {
			const plan = p.runtime.plan;
			const planningAt = p.nextLanding - plan.times.W - Math.max(2000, p.cfg.lead + 250 + plan.period * 2);
			wake = Math.min(wake, Math.max(now + 1, planningAt));
		}
	}
	return Math.max(1, wake - now);
}

export function serviceHackingPolicy(ns, pool) {
	refreshMilestoneEvidence(ns, pool);
	pool.api.refreshHackingPolicy?.(ns, pool.cfg, pool.network);
}

export function serviceXpPipeline(ns, pool) {
	tickXpPipeline(ns, pool, {
		canLaunch() {
			const pending = [...pool.pipelines.values()].reduce((n, p) => n + p.queue.length, pool.running.size);
			return pending + prepWorkerCount(pool) < pool.cfg.maxWorkers - 4 && fitsLaunchBudget(pool.launchBuckets,
				[{ launchAt: Date.now() }], Math.max(0, pool.cfg.maxLaunches - 8));
		},
		record: job => recordLaunchBudget(pool, [job]),
	});
}

function prepWorkerCount(pool) {
	return (pool.cfg.prepStates || [pool.cfg.backgroundPrep]).reduce((n, state) => n + backgroundPrepJobs(state).length, 0);
}

// Prep shares the live scheduler's launch and worker budgets, leaving room for
// income. Check again between exec calls so a large wave cannot block due work.
function prepLaunchHooks(pool) {
	return {
		canPlan: () => pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 50,
		canLaunch() {
			const pending = [...pool.pipelines.values()].reduce((n, p) => n + p.queue.length, pool.running.size) +
				prepWorkerCount(pool);
			return pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 50 &&
				pending < pool.cfg.maxWorkers - 4 && fitsLaunchBudget(pool.launchBuckets,
					[{ launchAt: Date.now() }], Math.max(4, pool.cfg.maxLaunches - 8));
		},
		recordLaunch: job => recordLaunchBudget(pool, [job]),
	};
}

function moneySpareRam(ns, pool, host, cfg) {
	const available = () => pool.api.availableRam(ns, host, cfg, pool.running, pool.reservations,
		Date.now(), Infinity, pool.foreign);
	// Prep/recovery outranks optional XP even when a few GB are already free.
	if (pool.xp?.jobs.size) reclaimXpRam(ns, pool.xp, host.name);
	return available();
}

export function dispatchPipelineEvents(ns, pool) {
	const groups = new Map();
	for (let count = 0; !pool.port.empty() && count < 512; count++) {
		const event = pool.port.read();
		if (!event || typeof event !== "object") continue;
		if (consumeXpEvent(pool, event)) continue;
		const p = pool.pipelines.get(event.target);
		// Batch ids include owner, target slot and epoch. A foreign/stale message
		// cannot release RAM or corrupt another target's timing/earnings counters.
		if (!p || !p.batches.has(String(event.batchId))) continue;
		const batch = p.batches.get(String(event.batchId));
		if (batch.generation != null && (event.epoch !== p.epoch || event.generation !== batch.generation ||
			!p.generations.has(event.generation))) continue;
		if (!groups.has(p)) groups.set(p, []);
		groups.get(p).push(event);
	}
	for (const p of pool.pipelines.values()) {
		const events = groups.get(p) || [];
		let i = 0;
		const inbox = { empty: () => i >= events.length, read: () => events[i++] };
		const problem = pool.api.consumeEvents(ns, inbox, p.batches, p.stats, p.name,
			p.runtime, p.cfg, pool.running, pool.runningByChunk);
		if (Number.isFinite(p.stats.lastHackAt)) p.liveSince ||= p.stats.lastHackAt;
		const transitionFailure = serviceHotSwapHealth(ns, pool, p);
		if (problem && !transitionFailure && p.mode === "RUNNING" && !p.drain) {
			p.recovery = pool.api.beginSoftRecovery(p.recovery, problem, p.control, p.runtime, p.stats);
		}
	}
}

export function beginPipelineDrain(pool, p, issue, retire = false) {
	if (retire) { p.retiring = true; p.retireReason = issue.reason; }
	const result = pool.api.beginDrain(p.drain, issue, p.queue, p.batches, p.stats, p.cfg);
	p.drain = result.drain; p.queue = result.queue; p.recovery = null;
	p.mode = "DRAINING";
	pool.api.publishHackPause(p.control, Number.MAX_SAFE_INTEGER, issue.reason);
	// Cancel in bounded slices of this target's PIDs, not the global running map.
	if (!p.drain.cancelIterator) p.drain.cancelIterator = p.running.entries();
}

function servicePipelineSafety(ns, pool, p, now) {
	const { api } = pool;
	serviceHotSwapHealth(ns, pool, p);
	if (p.mode === "RUNNING" && now >= p.nextHealth) {
		p.nextHealth = now + 250;
		const health = api.targetHealth(ns, p.name);
		const expectedTail = health.sec > health.minSec + 5
			? expectedSecurityTail(ns, pool, p, health, now)
			: null;
		if (health.sec > health.minSec + 5 && !expectedTail) {
			beginPipelineDrain(pool, p, { kind: "drain", hard: true, afterKind: "resync", bumpGap: true,
				reason: `security circuit breaker on ${p.name}: ${health.sec.toFixed(3)}` }, p.trial);
		} else if (!p.recovery && pool.port.empty()) {
			const overdue = api.findOverdueBatch(p.batches, p.cfg);
			if (overdue) {
				const batch = p.batches.get(overdue.batchId), chunk = batch.chunks.get(overdue.chunkId);
				const pid = pool.runningByChunk.get(chunk.chunkId);
				if (pid == null || !ns.isRunning(pid)) {
					api.untrackRunningByChunk(pool.running, pool.runningByChunk, chunk.chunkId);
					api.settleChunk(batch, chunk, { type: "miss", finishedAt: now }, p.stats);
					api.recordPhaseMiss(p.stats, chunk.phase);
					api.cancelPoisonedBatch(ns, batch, pool.running, pool.runningByChunk, p.stats);
				}
				p.recovery = api.beginSoftRecovery(p.recovery, overdue, p.control, p.runtime, p.stats);
			}
		}
	}
	if (p.recovery && !p.drain) {
		api.cancelHackWindow(ns, p.batches, pool.running, pool.runningByChunk, p.stats, p.recovery.pauseUntil);
		const result = api.updateSoftRecovery(ns, p.name, p.recovery, p.control, p.runtime, p.stats);
		p.recovery = result.recovery;
		if (result.problem) beginPipelineDrain(pool, p, result.problem, p.trial);
		else if (!p.recovery) p.nextLanding = Math.max(p.nextLanding,
			now + p.runtime.plan.times.W + p.cfg.lead + 250);
	}
	if ((p.recovery || p.drain) && pool.cfg.backgroundPrep?.active &&
		(p.drain || stalledPromotionSupport(pool, now) !== p)) {
		cancelBackgroundPrep(ns, pool.cfg.backgroundPrep, "earning target recovery has priority");
	}
	if (p.drain) {
		if (p.repair?.active) cancelBackgroundPrep(ns, p.repair, "target is draining");
		api.serviceHardDrain(ns, p.drain, p.batches, pool.running, pool.runningByChunk, p.stats);
	}
}

// H/W1 and G/W2 deliberately land one gap apart. Large phases can therefore
// cross the hard security threshold briefly even though their matching Weaken
// is already running. Defer the breaker only when completed damaging chunks
// explain the entire excursion and their own nonterminal tail is still within
// the ordinary overdue grace. An unrelated or oversized security jump remains
// an immediate hard fault, and a missing tail stops qualifying at its deadline.
function expectedSecurityTail(ns, pool, p, health, now) {
	let explained = 0;
	for (const batch of p.batches.values()) {
		const gap = (batch.cfg || p.cfg).gap, grace = Math.max(500, gap * 3);
		for (const [damage, weaken] of [["H", "W1"], ["G", "W2"]]) {
			const source = batch.phases[damage], tail = batch.phases[weaken];
			const tailLanding = Number(batch.landing[weaken]);
			if (!source || !tail || source.skipped || source.count === 0 || tail.skipped || tail.complete ||
				!Number.isFinite(tailLanding) || now < tailLanding - gap - grace ||
				now > tailLanding + grace) continue;
			const chunks = [...batch.chunks.values()];
			if (!chunks.some(chunk => chunk.phase === weaken && !pool.api.isTerminalChunk(chunk))) continue;
			const threads = chunks.reduce((sum, chunk) => sum +
				(chunk.phase === damage && chunk.status === "done" ? Math.max(0, Number(chunk.threads) || 0) : 0), 0);
			if (!(threads > 0)) continue;
			explained += damage === "H"
				? Math.max(0, Number(ns.hackAnalyzeSecurity(threads, p.name)) || 0)
				: Math.max(0, Number(ns.growthAnalyzeSecurity(threads, p.name)) || 0);
		}
	}
	return health.sec - health.minSec <= explained + 0.02 ? { explained } : null;
}

export function nextPipelineLaunch(pool) {
	let next = Infinity;
	for (const p of pool.pipelines.values()) next = Math.min(next, p.queue[0]?.launchAt ?? Infinity);
	return next;
}

function launchPipelineChunks(ns, pool) {
	const start = Date.now();
	// Launches already admitted must not be delayed by a second rate limiter.
	// Limit admission instead. This bound only shares CPU fairly across callbacks.
	for (let count = 0; count < 8 && Date.now() - start < 3; count++) {
		let next = null;
		for (const p of pool.pipelines.values()) {
			if (p.queue.length && p.queue[0].launchAt <= Date.now() &&
				(!next || p.queue[0].launchAt < next.queue[0].launchAt)) next = p;
		}
		if (!next) return;
		pool.launchDriftMax = Math.max(pool.launchDriftMax || 0, Date.now() - next.queue[0].launchAt);
		const r = pool.api.launchDueChunks(ns, next.queue, next.name, next.cfg, next.batches,
			next.stats, pool.running, pool.runningByChunk, next.drain, 1);
		next.queue = r.queue; next.drain = r.drain;
	}
}

// Admission bins are conservative: 4 bins/sec, each at most floor(limit / 4).
// Split phases count as multiple processes. Both targets consume this ledger.
export function fitsLaunchBudget(buckets, chunks, maxLaunches) {
	const proposed = new Map();
	for (const chunk of chunks) {
		const slot = Math.floor(chunk.launchAt / BUCKET_MS);
		proposed.set(slot, (proposed.get(slot) || 0) + 1);
		if (proposed.get(slot) + (buckets.get(slot) || 0) > Math.floor(maxLaunches / 4)) return false;
	}
	// Any rolling 1s interval can intersect five 250ms buckets. Counting the
	// whole five is conservative and also covers bursts at bucket boundaries.
	for (const slot of proposed.keys()) {
		for (let start = slot - 4; start <= slot; start++) {
			let count = 0;
			for (let i = start; i <= start + 4; i++) count += (buckets.get(i) || 0) + (proposed.get(i) || 0);
			if (count > maxLaunches) return false;
		}
	}
	return true;
}

function recordLaunchBudget(pool, chunks) {
	for (const c of chunks) {
		const slot = Math.floor(c.launchAt / BUCKET_MS);
		c.launchBudgetSlot = slot;
		pool.launchBuckets.set(slot, (pool.launchBuckets.get(slot) || 0) + 1);
	}
}

function releaseCancelledLaunchBudget(pool) {
	for (const r of pool.reservations) {
		const c = r.chunk;
		if (!c || c.launchIssued || c.launchBudgetReleased || c.launchBudgetSlot == null || !pool.api.isTerminalChunk(c)) continue;
		const slot = c.launchBudgetSlot;
		pool.launchBuckets.set(slot, Math.max(0, (pool.launchBuckets.get(slot) || 0) - 1));
		c.launchBudgetReleased = true;
	}
}

// Try the efficient core-aware placement first, then a bounded whole-phase
// alternative. A rejected probe must not leave RAM or launch-budget entries.
// The same admission proof is used by normal work, idle tuning and cutover.
function reserveBudgetedBatch(ns, pool, p, id, landing, plan, cfg, priorChunks = [], income = false) {
	const { api } = pool, mark = pool.reservations.length;
	const pending = [...pool.pipelines.values()].reduce((n, lane) => n + lane.queue.length, pool.running.size);
	const limit = p.name === pool.anchor ? pool.cfg.maxLaunches : Math.max(4, pool.cfg.maxLaunches - 8);
	let reason = "", ramFailure = false;
	for (const compact of [false, true]) {
		const placement = compact ? { ...cfg, compactPlacement: true } : cfg;
		const reserve = income && !compact ? api.reserveIncomeBatch : api.reserveBatch;
		const result = reserve(ns, p.name, id, landing, plan, pool.network.hosts,
			placement, pool.reservations, pool.running, pool.foreign);
		if (!result) {
			pool.foreignFastUntil = Date.now() + 2000; pool.nextForeign = 0;
			api.rollbackReservations(pool.reservations, mark);
			if (!reason) { reason = "no whole HWGW batch fits host RAM reservations"; ramFailure = true; }
			break;
		}
		const chunks = [...priorChunks, ...result.chunks];
		// Money can reclaim optional prep process slots as well as RAM. Owned
		// recovery workers remain protected and count toward the shared limit.
		if (income && pending + chunks.length + prepWorkerCount(pool) > pool.cfg.maxWorkers)
			cancelBackgroundPrep(ns, pool.cfg.backgroundPrep, "active hacking needs worker slots");
		if (pending + chunks.length + prepWorkerCount(pool) > pool.cfg.maxWorkers) reason = "shared worker-commitment limit";
		else if (!fitsLaunchBudget(pool.launchBuckets, chunks, limit)) reason = "shared launch budget / fragmented batch";
		else return { ...result, compact, reason: "", ramFailure: false };
		api.rollbackReservations(pool.reservations, mark);
	}
	return { chunks: null, reason, ramFailure };
}

export function planPipelineBatch(ns, pool) {
	const candidates = [...pool.pipelines.values()];
	for (let checked = 0; checked < candidates.length; checked++) {
		const p = candidates[pool.planCursor++ % candidates.length];
		if (p.mode !== "RUNNING" || p.recovery || p.drain || p.swap?.restoring) continue;
		const now = Date.now(), plan = p.runtime.plan;
		const earliest = now + plan.times.W + p.cfg.lead + 250;
		if (p.nextLanding < earliest) {
			const count = Math.ceil((earliest - p.nextLanding) / plan.period);
			p.nextLanding += count * plan.period; p.stats.expiredSlots += count;
		}
		const horizon = now + plan.times.W + Math.max(2000, p.cfg.lead + 250 + plan.period * 2);
		if (p.nextLanding > horizon) continue;
		const id = `${p.epoch}:${++p.serial}`;
		const result = reserveBudgetedBatch(ns, pool, p, id, p.nextLanding, plan, p.cfg, [], true);
		if (result.chunks) {
			commitGenerationBatch(pool, p, id, result.chunks, p.generations.get(p.generation));
			p.allocationStreak = 0;
			p.idleSince = null; p.admissionReason = "";
		} else if (!result.ramFailure) {
			p.admissionSkips++; p.admissionReason = result.reason;
			p.note = `Batch admission blocked: ${p.admissionReason}`;
		} else {
			p.stats.allocationFails++; p.allocationStreak++;
			p.admissionReason = "no whole HWGW batch fits host RAM reservations";
			p.note = `Batch admission blocked: ${p.admissionReason}`;
			p.stats.maxConsecutiveAllocationFails = Math.max(p.stats.maxConsecutiveAllocationFails, p.allocationStreak);
			// Optional work yields instead of letting a RAM-constrained peer harm
			// the current earner. Nothing changes that earner's queued reservations.
			if (p.trial && p.allocationStreak >= 8) beginPipelineDrain(pool, p,
				{ reason: "new target cannot fit shared RAM", kind: "drain", hard: false }, true);
		}
        // Change only future admission spacing. Existing reservations, HWGW timing,
        // ownership, repairs and hot swaps retain their safety rules.
        const xpAllocation = boundedXpAllocation(pool.cfg.hackingPolicy?.xpAllocation);
        p.nextLanding += plan.period / (1 - xpAllocation);
		return; // exactly one batch admission attempt per controller tick
	}
}

function refreshPipelineNetwork(ns, pool, now) {
	pool.lastNetwork = now;
	const status = pool.fleetPort.peek();
	if (status?.type !== "fleet-status" || Number(status.generatedAt) <= pool.lastFleetAt) return;
	pool.lastFleetAt = Number(status.generatedAt);
	pool.api.applyFleetStatus(pool.cloudState, status);
	const network = pool.api.networkFromFleetStatus(status, pool.minimumWorkerRam);
	if (!network) return;
	const old = new Map(pool.network.hosts.map(h => [h.name, h.maxRam]));
	const next = new Map(network.hosts.map(h => [h.name, h.maxRam]));
	const lost = new Set([...old].filter(([name, ram]) => (next.get(name) || 0) < ram).map(([name]) => name));
	pool.network = network;
	if (old.size !== next.size || [...old].some(([name, ram]) => next.get(name) !== ram)) {
		pool.foreignFastUntil = now + 2000; pool.nextForeign = 0;
	}
	pool.api.syncForeignUsageHosts(network.hosts, pool.foreign);
	if (!lost.size) return;
	for (const p of pool.pipelines.values()) {
		if ([...p.batches.values()].some(b => [...b.chunks.values()].some(c => !pool.api.isTerminalChunk(c) && lost.has(c.host)))) {
			beginPipelineDrain(pool, p, { kind: "drain", hard: true, afterKind: "network", reason: "owned worker host lost capacity" }, p.trial);
		}
	}
}

function beginPipelineTuning(ns, pool, p) {
	const { api } = pool;
	const peers = [...pool.pipelines.values()].filter(other => other !== p && other.mode !== "RETIRED");
	const peerRate = peers.reduce((n, other) => n + (other.runtime?.plan.batchRate || 0), 0);
	const freeRate = pool.cfg.maxBatchRate - peerRate;
	if (freeRate <= 0) { p.note = "Waiting for shared batch-rate capacity"; p.nextRetry = Date.now() + 30_000; return; }
	const model = api.createPreppedModel(ns, p.name);
	if (!model) { p.note = "Target is not modelable yet"; p.nextRetry = Date.now() + 30_000; return; }
	const profile = api.poolProfile(ns, pool.network.hosts, pool.cfg, pool.running);
	p.cfg.minimumPeriod = Math.max(1000 / freeRate, pool.cfg.minimumPeriod);
	if (p.trial) {
		// A trial is sized against a conservative capacity slice and a worst-case
		// pending-chunk estimate, then admitted by the real shared allocator.
		p.cfg.ramBudget = profile.capacity * 0.25;
		if (pool.cfg.maxTargets > 2) p.cfg.ramBudget = Math.min(p.cfg.ramBudget, Math.max(0, profile.capacity -
			peers.reduce((n, peer) => n + (peer.runtime?.plan.ramTime || 0) / (peer.runtime?.plan.period || 1) * 1.25, 0) -
			(pool.xp?.desiredRam || 0)));
		const usedSlots = peers.reduce((n, peer) => n + 4 * (peer.runtime?.plan.times.W || 0) /
			(peer.runtime?.plan.period || 1), 0);
		p.cfg.minimumPeriod = Math.max(p.cfg.minimumPeriod, 4 * (model.times.W + p.cfg.lead + 1250) /
			Math.max(4, pool.cfg.maxWorkers - usedSlots));
	} else p.cfg.ramBudget = Math.max(0, profile.capacity - peers.reduce((n, peer) =>
		n + (peer.runtime?.plan.ramTime || 0) / (peer.runtime?.plan.period || 1) * 1.25, 0));
	const acceptPlan = p.idleReplanning || p.trial && pool.cfg.maxTargets > 2 ? plan => idlePlanFits(ns, pool, p, plan) : null;
	p.tuner = api.tuneTargetSteps(ns, p.name, pool.network.hosts, p.cfg, pool.running, model, acceptPlan);
	p.tuneStarted = Date.now();
	p.note = "Building a fresh plan with actual chance and shared capacity";
}

// Probe one candidate at a time during the yielding tuner. Use the pure allocator,
// not reserveIncomeBatch: a planning probe must never preempt another process.
function idlePlanFits(ns, pool, p, plan) {
	const boundary = pool.reservations.length;
	try {
		const landing = Date.now() + plan.times.W + p.cfg.lead + 250;
		return Boolean(reserveBudgetedBatch(ns, pool, p, `probe:${p.epoch}`, landing, plan, p.cfg).chunks);
	} finally {
		pool.api.rollbackReservations(pool.reservations, boundary);
	}
}

// Productive-time gates are for elective optimizations, not liveness. A lane with
// no remaining work cannot earn its way out of a stale/infeasible plan. Only
// quiescent ownership can be retuned here: never erase a live PID or peer state.
function replanIdlePipeline(ns, pool, p, now) {
	if (p.mode !== "RUNNING" || p.retiring || p.recovery || p.drain || p.repair?.active ||
		p.queue.length || p.running.size || p.batches.size) {
		p.idleSince = null;
		return false;
	}
	p.idleSince ??= now;
	if (now - p.idleSince < IDLE_REPLAN_MS || now < p.idleRetryAt) return false;
	if ([...pool.running.values()].some(c => c.owner === p)) return false;
	if (pool.reservations.some(r => r.chunk?.owner === p && !pool.api.isTerminalChunk(r.chunk))) {
		p.admissionReason = "waiting for owned reservation accounting";
		return false;
	}
	// Reset retry backoff only after genuine batch completions, not one accepted
	// reservation. A persistently impossible plan must not retune every five seconds.
	if (p.stats.pipeline.completed > p.completedAtIdleReplan) p.idleFailures = 0;
	p.completedAtIdleReplan = p.stats.pipeline.completed;
	p.idleFailures++; p.idleRetunes++;
	p.idleRetryAt = now + Math.min(IDLE_REPLAN_MAX_BACKOFF_MS, IDLE_REPLAN_MS * 2 ** Math.min(6, p.idleFailures - 1));
	p.idleReplanning = true;
	p.tuner = null; p.nextRetry = 0;
	p.epoch = `${pool.ownerPid}:${p.ordinal}:${++p.epochNumber}`; p.cfg.epoch = p.epoch;
	pool.api.publishHackPause(p.control, Number.MAX_SAFE_INTEGER, "idle pipeline replanning");
	pool.api.finishReadyBatches(p.batches, p.stats, p.cfg);
	let write = 0;
	for (const r of pool.reservations) if (r.chunk?.owner !== p) pool.reservations[write++] = r;
	pool.reservations.length = write;
	pool.api.rebuildReservationIndex(pool.reservations);
	p.mode = pool.api.targetHealth(ns, p.name).clean ? "TUNING" : "PREPARING";
	p.note = `Idle replan: ${p.admissionReason || "no queued or running work"}`;
	pool.note = `${p.name}: rebuilding an empty pipeline, not waiting for more earnings`;
	return true;
}

function servicePipelineTuning(ns, pool, p) {
	const { api } = pool;
	if (p.mode !== "TUNING" || Date.now() < p.nextRetry) return false;
	p.lastTuneStep = Date.now(); p.tuningWaitSince = null;
	if (!api.targetHealth(ns, p.name).clean) {
		p.tuner = null;
		if (p.trial) beginPipelineDrain(pool, p,
			{ kind: "drain", hard: true, reason: "prepared candidate became dirty before admission" }, true);
		else p.mode = "PREPARING";
		return true;
	}
	if (!p.tuner) beginPipelineTuning(ns, pool, p);
	if (!p.tuner) return true;
	const step = p.tuner.next(); // at most 32 candidate periods per step
	if (step.done) {
		p.tuner = null;
		if (!step.value) {
			p.note = "No plan fits shared limits; retrying later";
			p.nextRetry = Date.now() + (p.idleReplanning ? Math.min(IDLE_REPLAN_MAX_BACKOFF_MS,
				30_000 * 2 ** Math.min(4, p.idleFailures++)) : 30_000);
		} else if (p.trial && p.minimumExpected > 0 &&
			(step.value.plan?.expected || 0) < p.minimumExpected) {
			const expected = step.value.plan?.expected || 0;
			beginPipelineDrain(pool, p, { kind: "drain", hard: false,
				reason: `candidate model ${expected.toFixed(0)}/s below admission floor ${p.minimumExpected.toFixed(0)}/s` }, true);
			pool.note = `Rejected ${p.name}: tuned income would be below the lane it was meant to improve`;
		} else {
			if (p.trial) pool.admission = { decision: "ADD TARGET", candidate: p.name,
				marginalIncome: step.value.plan.expected - (p.replacedExpected || 0), expectedLanes: pool.pipelines.size,
				reason: "candidate fits remaining capacity without replanning incumbents; measured trial follows" };
			activatePipeline(ns, pool, p, step.value, p.stats.restarts > 0);
		}
	}
	return true;
}

// The fingerprint excludes transient target security and live worker RAM: the
// model normalizes security, and the real allocator validates transient usage.
function planningInputs(ns, pool, p) {
	return { target: p.name, level: ns.getHackingLevel(),
		formulas: pool.api.hackingFormulasAvailable ? pool.api.hackingFormulasAvailable(ns) : Boolean(p.runtime.formulas),
		capacity: pool.api.workerFleetCapacity(pool.network.hosts, p.cfg),
		gap: p.cfg.gap, lead: p.cfg.lead,
		fleet: pool.network.hosts.map(h => `${h.name}:${h.maxRam}:${h.cores}`).join("|"),
		peerRate: [...pool.pipelines.values()].filter(q => q !== p).reduce((n, q) => n + (q.runtime?.plan.batchRate || 0), 0) };
}

function commitGenerationBatch(pool, p, id, chunks, generation) {
	for (const c of chunks) { c.owner = p; c.generation = generation.number; }
	pool.api.enqueueChunks(p.queue, chunks);
	const batch = pool.api.makeBatchState(id, chunks);
	batch.plan = generation.runtime.plan; batch.cfg = generation.cfg; batch.generationState = generation;
	p.batches.set(id, batch); p.stats.scheduled++;
	recordLaunchBudget(pool, chunks);
}

export function serviceShadowTune(ns, pool, p) {
	const mark = pool.reservations.length, serial = p.generationSerial;
	try { serviceShadowTuneStep(ns, pool, p); }
	catch (error) {
		if (p.generationSerial !== serial) throw error;
		pool.api.rollbackReservations(pool.reservations, mark);
		p.lastSwap = { state: "ABORTED", trigger: p.shadow?.trigger,
			reason: `shadow planning failed: ${String(error?.message || error)}` };
		p.hotSwaps.aborted++; p.shadow = null; p.shadowRetryAt = Date.now() + 30_000;
	}
}

function serviceShadowTuneStep(ns, pool, p) {
	if (p.mode !== "RUNNING" || p.recovery || p.drain || p.retiring || p.swap || p.generations.size > 1) return;
	if (!Number.isFinite(p.stats.lastHackAt)) return;
	const now = Date.now(), inputs = planningInputs(ns, pool, p), fingerprint = JSON.stringify(inputs);
	const trigger = inputs.formulas !== Boolean(p.runtime.formulas) ? "formulas" :
		inputs.level >= Math.max(p.tunedLevel + 10, Math.ceil(p.tunedLevel * 1.10)) ? "skill" :
		inputs.capacity >= Math.max(1, p.tunedCapacity) * 1.25 ? "capacity" : "";
	if (p.shadow && p.shadow.fingerprint !== fingerprint) {
		p.shadow.state = "ABORTED"; p.hotSwaps.aborted++; p.shadow = null;
	}
	if (!p.shadow) {
		if (!trigger || now < p.shadowRetryAt) return;
		p.shadow = { state: "SHADOW", number: p.generationSerial + 1, trigger, inputs, fingerprint,
			createdAt: now, stableAt: now + 2000, retryAt: 0, attempts: 0, reason: "" };
		return;
	}
	const s = p.shadow;
	if (now < s.stableAt || now < s.retryAt) return;
	if (!s.tuner && !s.runtime) {
		const freeRate = pool.cfg.maxBatchRate - inputs.peerRate;
		const model = pool.api.createPreppedModel(ns, p.name);
		if (!model || freeRate <= 0) { s.reason = "waiting for model/shared batch rate"; s.retryAt = now + 5000; return; }
		s.inputs.times = { ...model.times };
		s.modelInputs = modelAssumptions(model);
		// Never mutate active cfg while the incremental search yields.
		s.cfg = { ...p.cfg, generation: s.number,
			minimumPeriod: Math.max(1000 / freeRate, pool.cfg.minimumPeriod),
			ramBudget: Math.max(0, pool.api.poolProfile(ns, pool.network.hosts, pool.cfg, pool.running).capacity -
				[...pool.pipelines.values()].filter(q => q !== p).reduce((n, q) => n +
					(q.runtime?.plan.ramTime || 0) / (q.runtime?.plan.period || 1) * 1.25, 0)) };
		const accept = s.fitOverlap ? plan => transitionPlanFits(ns, pool, p, plan, s.cfg) : null;
		s.tuner = pool.api.tuneTargetSteps(ns, p.name, pool.network.hosts, s.cfg, pool.running, model, accept);
	}
	if (s.tuner) {
		const step = s.tuner.next();
		if (!step.done) return;
		s.tuner = null; s.runtime = step.value;
		if (!s.runtime) {
			if (s.fitOverlap) {
				s.state = "PREFLIGHT";
				s.reason = "insufficient overlap RAM for complete HWGW batches; searching smaller plans";
				s.retryAt = now + Math.min(30_000, 1000 * 2 ** Math.min(5, s.attempts++));
				return;
			}
			s.state = "ABORTED"; p.hotSwaps.aborted++; p.shadowRetryAt = now + 30_000;
			p.lastSwap = { state: "ABORTED", trigger: s.trigger, reason: "no replacement plan fits" }; p.shadow = null; return;
		}
		if (!(s.runtime.plan.expected > p.runtime.plan.expected * 1.001)) {
			p.lastSwap = { state: "ABORTED", trigger: s.trigger, reason: "candidate does not improve modeled income" };
			p.hotSwaps.aborted++; p.shadow = null; p.shadowRetryAt = now + 30_000; return;
		}
		s.state = "PREFLIGHT";
	}
	preflightHotSwap(ns, pool, p);
}

export function preflightHotSwap(ns, pool, p) {
	const s = p.shadow, now = Date.now(), api = pool.api;
	if (!s?.runtime || p.swap || p.recovery || p.drain || !pool.port.empty()) return false;
	if (s.fingerprint !== JSON.stringify(planningInputs(ns, pool, p))) return false;
	const latestModel = api.createPreppedModel(ns, p.name);
	if (!latestModel || JSON.stringify(modelAssumptions(latestModel)) !== JSON.stringify(s.modelInputs)) {
		s.state = "ABORTED"; p.hotSwaps.aborted++; p.shadow = null;
		p.shadowRetryAt = now + 2000; return false;
	}
	const old = p.generations.get(p.generation), plan = s.runtime.plan;
	const finalOldW2 = Math.max(p.stats.lastW2 || 0, ...[...p.batches.values()].map(b => b.landing.W2 || 0));
	const firstH = Math.max(finalOldW2 + Math.max(old.cfg.gap, s.cfg.gap),
		now + plan.times.W + s.cfg.lead + 250);
	// If longer new actions cannot reach the next ordinary payout slot, keep
	// earning and retry. Elective optimization may not purchase a duration gap.
	if (!Number.isFinite(finalOldW2) || firstH > finalOldW2 + Math.max(old.runtime.plan.period, 4 * s.cfg.gap) + 1) {
		s.reason = "cutover would leave an income gap; waiting for a future restoration boundary";
		s.retryAt = now + 2000; return false;
	}
	const { batches, reason } = reserveTransitionBatches(ns, pool, p, plan, s.cfg, firstH);
	if (reason) {
		s.reason = reason; s.retryAt = now + Math.min(30_000, 1000 * 2 ** Math.min(5, s.attempts++));
		// A steady-state winner may never fit alongside the old generation.
		// Search smaller, genuinely admissible candidates instead of repeatedly
		// trying the same oversized plan. Old admissions remain open throughout.
		if (reason.includes("overlap RAM")) { s.fitOverlap = true; s.runtime = null; s.tuner = null; }
		return false;
	}
	// No yields between successful preflight and commit. The reservations being
	// committed are the reservations just proven, not a second allocation attempt.
	const generation = { number: ++p.generationSerial, state: "CUTOVER", runtime: s.runtime,
		cfg: s.cfg, level: s.inputs.level, confirmed: false, failed: false, hackLanded: false };
	old.state = "DRAINING"; p.generations.set(generation.number, generation);
	p.swap = { state: "CUTOVER", old: old.number, next: generation.number, trigger: s.trigger,
		oldLevel: old.level ?? p.tunedLevel, newLevel: s.inputs.level,
		oldCapacity: p.tunedCapacity,
		oldIncome: old.runtime.plan.expected, newIncome: plan.expected,
		oldRate: old.runtime.plan.batchRate, newRate: plan.batchRate,
		finalOldW2, firstH, boundary: firstH, overlapRam: transitionPeakRam(pool, now), reason: "" };
	p.generation = generation.number; p.runtime = generation.runtime; p.cfg = generation.cfg;
	p.tunedLevel = s.inputs.level; p.tunedCapacity = s.inputs.capacity; p.lastCapacityRetune = now;
	p.shadow = null; p.serial += batches.length;
	for (const b of batches) commitGenerationBatch(pool, p, b.id, b.chunks, generation);
	p.nextLanding = firstH + batches.length * plan.period;
	p.stats.nextHackLanding = firstH;
	api.publishHackPause(p.control, 0, "plan cutover");
	return true;
}

function reserveTransitionBatches(ns, pool, p, plan, cfg, firstH) {
	const mark = pool.reservations.length, batches = [], chunks = [];
	for (let i = 0; i < 2; i++) {
		const id = `${p.epoch}:g${cfg.generation}:${p.serial + i + 1}`;
		const result = reserveBudgetedBatch(ns, pool, p, id, firstH + i * plan.period, plan, cfg, chunks);
		if (!result.chunks) {
			pool.api.rollbackReservations(pool.reservations, mark);
			return { batches: [], reason: result.ramFailure
				? "insufficient overlap RAM for complete HWGW batches" : result.reason };
		}
		batches.push({ id, chunks: result.chunks }); chunks.push(...result.chunks);
	}
	return { batches, reason: "" };
}

function transitionPlanFits(ns, pool, p, plan, cfg) {
	const mark = pool.reservations.length;
	try {
		const finalOldW2 = Math.max(p.stats.lastW2 || 0, ...[...p.batches.values()].map(b => b.landing.W2 || 0));
		const firstH = Math.max(finalOldW2 + Math.max(p.cfg.gap, cfg.gap),
			Date.now() + plan.times.W + cfg.lead + 250);
		return !reserveTransitionBatches(ns, pool, p, plan, cfg, firstH).reason;
	} finally {
		pool.api.rollbackReservations(pool.reservations, mark);
	}
}

function modelAssumptions(model) {
	// Ignore insignificant floating-point noise from security normalization.
	const rounded = n => Number.isFinite(n) ? Number(n.toPrecision(6)) : null;
	return { times: [model.times.H, model.times.G, model.times.W].map(rounded),
		hackPercent: rounded(model.hackPercent), chance: rounded(model.chance),
		maxMoney: model.maxMoney, minSecurity: model.minSecurity, formulas: Boolean(model.formulas) };
}

function transitionPeakRam(pool, now) {
	const events = [];
	for (const r of pool.reservations) {
		if (r.end < now || pool.api.isTerminalChunk(r.chunk)) continue;
		events.push([Math.max(now, r.start), r.ram], [r.end, -r.ram]);
	}
	events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let held = backgroundPrepRam(pool.cfg.prepStates) + [...pool.foreign.values()].reduce((n, r) => n + r, 0), peak = held;
	for (const [, delta] of events) { held += delta; peak = Math.max(peak, held); }
	return peak;
}

function generationTerminal(pool, p, number) {
	return !p.queue.some(c => c.generation === number) &&
		![...p.running.values()].some(c => c.generation === number) &&
		![...p.batches.values()].some(b => b.generation === number) &&
		!pool.reservations.some(r => r.chunk?.owner === p && r.generation === number) && pool.port.empty();
}

export function serviceHotSwapHealth(ns, pool, p) {
	const swap = p.swap;
	if (!swap || p.drain) return false;
	const next = p.generations.get(swap.next), old = p.generations.get(swap.old), api = pool.api;
	if (next.failed && !swap.aborted && !swap.restoring) {
		const batches = [...p.batches.values()].filter(b => b.generation === next.number);
		// A missing terminal event is not proof that a Hack did not affect money.
		const safeToAbort = !next.hackLanded && Date.now() < swap.firstH && pool.port.empty();
		if (safeToAbort) {
			let cancelled = true;
			for (const b of batches) for (const c of b.chunks.values()) {
				if (!api.cancelChunk(ns, b, c, pool.running, pool.runningByChunk, p.stats)) cancelled = false;
			}
			if (!cancelled) return true; // reconcile pending completions before resuming
			next.state = "ABORTED"; old.state = "ACTIVE"; swap.aborted = true; swap.state = "ABORTED";
			p.hotSwaps.aborted++; p.generation = old.number; p.runtime = old.runtime; p.cfg = old.cfg;
			p.tunedLevel = swap.oldLevel;
			p.tunedCapacity = swap.oldCapacity;
			p.nextLanding = Math.max(swap.finalOldW2 + Math.max(old.cfg.gap, old.runtime.plan.period - 3 * old.cfg.gap),
				Date.now() + old.runtime.plan.times.W + old.cfg.lead + 250);
			api.finishReadyBatches(p.batches, p.stats, p.cfg);
			p.queue = p.queue.filter(c => !api.isTerminalChunk(c));
			api.publishHackPause(p.control, 0, "candidate aborted; previous plan resumed");
		} else {
			swap.restoring = true; swap.state = "RESTORING";
			swap.failed = true; p.hotSwaps.aborted++;
			swap.reason = "new generation failed; waiting for committed restoration tails";
			api.publishHackPause(p.control, Number.MAX_SAFE_INTEGER, swap.reason);
			for (const b of batches) for (const c of b.chunks.values()) if (c.phase === "H")
				api.cancelChunk(ns, b, c, pool.running, pool.runningByChunk, p.stats);
		}
	}
	if (swap.restoring && !swap.recovering && ![...p.batches.values()].some(b => b.generation === next.number)) {
		swap.recovering = true; swap.state = "RECOVERING";
		p.recovery = api.beginSoftRecovery(p.recovery, { reason: swap.reason }, p.control, p.runtime, p.stats);
		return true;
	}
	if (swap.recovering && !p.recovery && !p.drain && api.targetHealth(ns, p.name).clean) {
		// Recovery can reopen admission, but only a subsequently completed W2
		// may certify this plan. A clean health poll is not a generation commit.
		next.failed = false; next.confirmed = false; next.state = "CUTOVER";
		swap.restoring = false; swap.recovering = false; swap.state = "CUTOVER";
	}
	if (next.confirmed && !next.failed) { next.state = "ACTIVE"; swap.state = "ACTIVE"; }
	const retired = swap.aborted ? next : old;
	if ((swap.aborted || next.confirmed) && generationTerminal(pool, p, retired.number)) {
		retired.state = "RETIRED"; p.generations.delete(retired.number);
		if (!swap.aborted && !swap.failed) p.hotSwaps.completed++;
		p.lastSwap = { ...swap }; p.swap = null; p.shadowRetryAt = Date.now() + 30_000;
		api.publishHackPause(p.control, p.recovery ? Number.MAX_SAFE_INTEGER : 0, "generation reconciled");
	}
	return Boolean(next.failed);
}

// If committed launches leave no maintenance window, stop adding batches until
// one opens. Existing workers and queued launches always keep their deadlines.
export function serviceMaintenanceOpportunity(ns, pool) {
	const now = Date.now(), prep = pool.cfg.backgroundPrep;
	const readyHandoff = prep?.status === "READY" && pool.cfg.maxTargets > 1 &&
		(pool.pipelines.size < pool.cfg.maxTargets || steadyPromotionSupport(pool, now) || stalledPromotionSupport(pool, now));
	const needed = [...pool.pipelines.values()].some(p =>
		p.mode === "TUNING" ? now >= p.nextRetry : p.mode === "PREPARING" || p.mode === "DRAINING" ||
		p.mode === "RUNNING" && !p.recovery && !p.queue.length && !p.running.size && !p.batches.size &&
			!recentPipelineIncome(p.stats, p.runtime, now)) ||
		readyHandoff || prep?.status === "WAITING_SCHEDULER";
	if (!needed) { pool.maintenanceWaitSince = null; return false; }
	pool.maintenanceWaitSince ??= Date.now();
	if (Date.now() - pool.maintenanceWaitSince < MAINTENANCE_WAIT_MS) return false;
	if (!pool.port.empty() || nextPipelineLaunch(pool) - Date.now() <= 50) return true;
	servicePipelineMaintenance(ns, pool);
	if (pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 50)
		serviceBackgroundAndAdmission(ns, pool);
	return true;
}

function servicePipelineMaintenance(ns, pool) {
	const { api } = pool;
	pool.maintenanceWaitSince = null;
	const lanes = [...pool.pipelines.values()];
	const start = (pool.maintenanceCursor || 0) % Math.max(1, lanes.length);
	for (let i = 0; i < lanes.length; i++) {
		const index = (start + i) % lanes.length, p = lanes[index];
		pool.maintenanceCursor = (index + 1) % lanes.length;
		replanIdlePipeline(ns, pool, p, Date.now());
		if (p.mode === "DRAINING" && p.queue.length === 0 && p.running.size === 0 && !p.repair?.active && pool.port.empty()) {
			api.finishReadyBatches(p.batches, p.stats, p.cfg);
			if (p.batches.size) continue;
			// Filter only this epoch. An unrelated target retains its reservations.
			let write = 0;
			for (const r of pool.reservations) if (r.chunk?.owner !== p) pool.reservations[write++] = r;
			pool.reservations.length = write; api.rebuildReservationIndex(pool.reservations);
			if (p.retiring) {
				p.mode = "RETIRED"; p.note = p.retireReason;
				pool.history.push(p); pool.pipelines.delete(p.name);
				pool.blocked.set(p.name, Date.now() + RETRY_MS);
				if (pool.anchor === p.name) pool.anchor = pool.pipelines.keys().next().value;
				if (pool.trialGuard?.trial === p.name) pool.trialGuard = null;
				pool.note = `Retired ${p.name}: ${p.retireReason}`;
				continue;
			}
			p.stats.restarts++;
			if (p.drain.afterKind === "resync") p.stats.resyncs++;
			p.cfg.gap = p.drain.nextGap; p.cfg.lead = Math.max(p.cfg.lead, p.cfg.gap * 6);
			p.epoch = `${pool.ownerPid}:${p.ordinal}:${++p.epochNumber}`; p.cfg.epoch = p.epoch;
			p.drain = null; p.recovery = null;
			api.publishHackPause(p.control, Number.MAX_SAFE_INTEGER, "target reconfiguration");
			p.mode = api.targetHealth(ns, p.name).clean ? "TUNING" : "PREPARING";
			p.nextRetry = 0;
		}
		if (p.mode === "PREPARING") {
			if (!p.repair) {
				p.repair = createBackgroundPrep({ enabled: true, maxRam: 16_384, fraction: 0.05 });
				p.repair.target = p.name;
				pool.cfg.prepStates.push(p.repair);
			}
			tickBackgroundPrep(ns, { ...prepLaunchHooks(pool), state: p.repair, repair: true, target: p.name,
				network: pool.network, cfg: p.cfg, runtime: p.runtime, stats: p.stats, healthy: true,
				reclaimShare: host => api.reclaimFleetShare(ns, host),
				claimTarget: target => claimXpTarget(ns, pool, target),
				spareRam: host => moneySpareRam(ns, pool, host, p.cfg) });
			p.note = `Target repair: ${p.repair.status} ${p.repair.reason}`;
			if (p.repair.status === "READY" && !p.repair.active) {
				p.mode = "TUNING"; p.nextRetry = 0;
			} else if (p.repair.status === "ERROR") p.note = `Repair stopped: ${p.repair.error}`;
			return;
		}
		if (servicePipelineTuning(ns, pool, p)) return;
		serviceShadowTune(ns, pool, p);
	}
}

function productive(p, now) {
	return p?.mode === "RUNNING" && !p.recovery && !p.drain &&
		(p.stats.pipeline.productiveMs || 0) >= PRODUCTIVE_MS &&
		recentPipelineIncome(p.stats, p.runtime, now);
}

function updatePipelineProgress(pool, now) {
	for (const p of pool.pipelines.values()) {
		if (p.mode === "RUNNING" && !p.recovery && !p.drain && recentPipelineIncome(p.stats, p.runtime, now))
			p.stalledSince = null;
		else p.stalledSince ??= now;
		if (p.mode === "TUNING" && now >= p.nextRetry) p.tuningWaitSince ??= now;
		else p.tuningWaitSince = null;
	}
}

function stalledPromotionSupport(pool, now) {
	const lanes = [...pool.pipelines.values()];
	if (pool.cfg.maxTargets <= 1 || lanes.length < pool.cfg.maxTargets ||
		lanes.some(p => p.retiring || p.drain)) return null;
	const survivor = lanes.find(p => !p.trial && productive(p, now));
	if (!survivor) return null;
	return lanes.find(p => p !== survivor && p.stalledSince != null &&
		now - p.stalledSince >= STALLED_REPLACEMENT_MS &&
		now >= (p.firstLanding || 0) + TRIAL_MS) || null;
}

function promotionBlockers(pool, now) {
	return [...pool.pipelines.values()].flatMap(p => {
		const age = p.stalledSince == null ? "" : ` for ${Math.floor((now - p.stalledSince) / 1000)}s`;
		if (p.mode !== "RUNNING" || p.recovery || p.drain) {
			const reason = p.recovery ? "recovering" : p.drain ? "draining" : p.mode.toLowerCase();
			const tuning = p.mode === "TUNING" ? now < p.nextRetry
				? `; retry in ${Math.ceil((p.nextRetry - now) / 1000)}s: ${p.note}`
				: p.tuningWaitSince != null && now - p.tuningWaitSince >= 1000
					? "; waiting for scheduler window" : "; plan search advancing" : "";
			return [`${p.name} ${reason}${age}${tuning}`];
		}
		if (p.trial) return [`${p.name} trial: ${p.trialNote || "collecting productive income"}`];
		if (!productive(p, now)) return [`${p.name} waiting for productive income${age}`];
		return [];
	}).join(" | ");
}

function steadyPromotionSupport(pool, now) {
	if (pool.cfg.maxTargets <= 1 || pool.pipelines.size < pool.cfg.maxTargets) return null;
	const lanes = [...pool.pipelines.values()];
	if (lanes.some(p => p.retiring || p.trial || p.mode !== "RUNNING" || p.recovery || p.drain ||
		!productive(p, now))) return null;
	return lanes.reduce((weakest, p) =>
		!weakest || (p.runtime?.plan.expected || Infinity) < (weakest.runtime?.plan.expected || Infinity)
			? p : weakest, null);
}

function resetPreparedCandidate(prep, reason) {
	prep.target = ""; prep.candidate = null; prep.health = null; prep.readyAt = 0; prep.scan = null;
	prep.retryAt = 0; prep.status = "SCANNING"; prep.reason = reason;
}

export function remainingBatchRate(pool, excluded = null) {
	return Math.max(0, pool.cfg.maxBatchRate - [...pool.pipelines.values()]
		.filter(p => p !== excluded).reduce((n, p) => n + (p.runtime?.plan.batchRate || 0), 0));
}

export function admissionIncomeFloor(pool, minimumExpected, replacing = false) {
	if (pool.cfg.maxTargets <= 2 || replacing) return minimumExpected;
	return Math.max(minimumExpected, emptySlotIncomeFloor([...pool.pipelines.values()]
		.reduce((n, lane) => n + (lane.runtime?.plan.expected || 0), 0), pool.cfg.switchThreshold));
}

export function elasticAdmissionBlocker(pool, now = Date.now()) {
	const capacity = schedulerCapacity(pool, now);
	const blocked = capacity.constraints.find(c => ["RECOVERY", "WORKER_LIMIT", "LAUNCH_RATE", "RAM", "XP_RAM"].includes(c));
	if (blocked) return blocked;
	if (remainingBatchRate(pool) < .25) return "BATCH_RATE";
	if ([...pool.pipelines.values()].some(p => p.trial || !productive(p, now))) return "WAITING_STABLE_LANES";
	return "";
}

// Scouting is incremental. A prepared target can fill any vacant lane.
function nextReadyCandidate(ns, pool, anchor, now) {
	const emptySlotFloor = emptySlotIncomeFloor(anchor.runtime.plan.expected, pool.cfg.switchThreshold);
	const prepared = pool.cfg.backgroundPrep;
	if (prepared.status === "READY" && !prepared.active && prepared.target &&
		!pool.pipelines.has(prepared.target) && (pool.blocked.get(prepared.target) || 0) <= now) {
		pool.pendingAdmissionFloor = Number(prepared.candidate?.minimumExpected) || emptySlotFloor;
		return prepared.target;
	}
	if (now < pool.nextReadyScan) return "";
	pool.readyScan ||= { names: [...pool.network.servers], index: 0, best: null };
	const scan = pool.readyScan;
	// Discovery is read-only and cheap. Examine a small bounded slice per tick so
	// a dense JIT launch lattice cannot turn a 95-host scan into an hours-long job.
	for (let checked = 0; checked < 8 && scan.index < scan.names.length; checked++) {
		const name = scan.names[scan.index++];
		if (name === "home" || pool.pipelines.has(name) || (pool.blocked.get(name) || 0) > now ||
			!ns.hasRootAccess(name) || ns.getServerMaxMoney(name) <= 0 ||
			ns.getServerRequiredHackingLevel(name) > ns.getHackingLevel()) continue;
		if (!pool.api.targetHealth(ns, name).clean) continue;
		const rate = remainingBatchRate(pool);
		const potential = ns.getServerMaxMoney(name) * pool.cfg.maxSteal * 0.95 * ns.hackAnalyzeChance(name) * rate;
		if (potential > emptySlotFloor && (!scan.best || potential > scan.best.potential)) {
			scan.best = { name, potential };
		}
	}
	if (scan.index < scan.names.length) return "";
	pool.readyScan = null; pool.nextReadyScan = now + 60_000;
	return scan.best?.name || "";
}

export function serviceAdmissionOpportunity(ns, pool) {
	const now = Date.now();
	updatePipelineProgress(pool, now);
	if (!pool.port.empty() || now < (pool.nextAdmissionService || 0)) return false;
	const slack = nextPipelineLaunch(pool) - now;
	if (slack <= 5) return false;
	pool.nextAdmissionService = now + 100;
	serviceBackgroundAndAdmission(ns, pool, slack > 50);
	// Recheck after scouting: it can consume part of the original launch window.
	// Quiescent established targets need the same yielding search as new trials.
	if (pool.port.empty() && nextPipelineLaunch(pool) - Date.now() > 20) {
		const tuning = [...pool.pipelines.values()].filter(p => p.mode === "TUNING" &&
			!p.retiring && !p.recovery && !p.drain && !p.repair?.active && now >= p.nextRetry &&
			!p.queue.length && !p.running.size && !p.batches.size)
			.sort((a, b) => (a.lastTuneStep || 0) - (b.lastTuneStep || 0))[0];
		if (tuning) servicePipelineTuning(ns, pool, tuning);
		else {
			// A dense launch lattice may never offer the maintenance lane's 50ms
			// window. Give one yielding shadow step the same bounded opportunity.
			const lanes = [...pool.pipelines.values()];
			pool.shadowCursor = (pool.shadowCursor || 0) % lanes.length;
			if (lanes.length) serviceShadowTune(ns, pool, lanes[pool.shadowCursor++]);
		}
	}
	return true;
}

function serviceBackgroundAndAdmission(ns, pool, allowPrepLaunch = true) {
	const { api, cfg } = pool, now = Date.now();
	updatePipelineProgress(pool, now);
	const anchor = pool.pipelines.get(pool.anchor);
	const full = pool.pipelines.size >= cfg.maxTargets;
	if (cfg.maxTargets > 1 && full) {
		const lanes = [...pool.pipelines.values()];
		const retiring = lanes.find(p => p.retiring || p.mode === "DRAINING");
		if (retiring) {
			pool.note = `Promotion handoff: draining ${retiring.name} before admitting ${cfg.backgroundPrep.target || "prepared target"}`;
			return;
		}
		const steady = steadyPromotionSupport(pool, now);
		const support = steady || stalledPromotionSupport(pool, now);
		if (!support) {
			const reason = `Promotion paused: ${promotionBlockers(pool, now)}`;
			if (cfg.backgroundPrep.active) cancelBackgroundPrep(ns, cfg.backgroundPrep,
				reason);
			else {
				if (cfg.backgroundPrep.status !== "READY")
					cfg.backgroundPrep.status = cfg.backgroundPrep.enabled ? "PAUSED" : "DISABLED";
				cfg.backgroundPrep.reason = cfg.backgroundPrep.enabled
					? reason : "disabled";
			}
			pool.note = reason;
			return;
		}
		const activeTargets = new Set(pool.pipelines.keys());
		const survivor = lanes.find(p => p !== support && p.name === pool.anchor && !p.retiring) ||
			lanes.filter(p => p !== support && !p.retiring).sort((a, b) => (b.runtime?.plan.expected || 0) - (a.runtime?.plan.expected || 0))[0];
		const healthSource = steady ? support : survivor;
		const threshold = steady ? support.runtime.plan.expected * cfg.switchThreshold
			: emptySlotIncomeFloor(survivor.runtime.plan.expected, cfg.switchThreshold);
		tickBackgroundPrep(ns, { ...prepLaunchHooks(pool), state: cfg.backgroundPrep, target: healthSource.name, activeTargets,
			blockedTargets: pool.blocked, network: pool.network, cfg, runtime: healthSource.runtime, stats: healthSource.stats,
			healthy: true, allowLaunch: allowPrepLaunch, promotion: Boolean(steady), slotFill: !steady,
			availableBatchRate: remainingBatchRate(pool, support),
			replacementRate: support.runtime?.plan.expected,
			replacementBatchRate: support.runtime?.plan.batchRate,
			reclaimShare: host => api.reclaimFleetShare(ns, host),
			claimTarget: target => claimXpTarget(ns, pool, target),
			spareRam: host => moneySpareRam(ns, pool, host, cfg) });
		const prep = cfg.backgroundPrep;
		const target = prep.target ? ` ${prep.target}` : "";
		pool.note = `${steady ? "Promotion" : "Stalled target replacement"} prep${target} over ${support.name}: ${prep.status || "WAITING"}` +
			(prep.reason ? ` | ${prep.reason}` : "");
		if (prep.status !== "READY" || prep.active || !prep.target) return;
		const candidatePotential = Number(prep.candidate?.potential) || 0;
		if (!(candidatePotential > threshold)) {
			resetPreparedCandidate(prep,
				`promotion candidate no longer clears ${support.name} by switch threshold`);
			return;
		}
		if (!allowPrepLaunch) {
			pool.note = `Promotion target ${prep.target} ready; waiting for a safe drain window`;
			return;
		}
		prep.candidate.minimumExpected = threshold;
		prep.candidate.replacing = support.name;
		prep.candidate.replacedExpected = support.runtime?.plan.expected || 0;
		pool.admission = { decision: "REPLACE TARGET", candidate: prep.target, replacing: support.name,
			marginalIncome: candidatePotential - (support.runtime?.plan.expected || 0), expectedLanes: lanes.length,
			reason: "candidate clears replacement hysteresis; only weakest lane drains" };
		if (survivor) pool.anchor = survivor.name;
		pool.trialGuard = null;
		prep.reason = `ready to replace ${support.name}; waiting for slot handoff`;
		beginPipelineDrain(pool, support, {
			kind: "drain", hard: false,
			reason: `${steady ? "steady-state promotion" : "stalled target replacement"} to ${prep.target} over ${support.name}`,
		}, true);
		pool.note = `Promoting ${prep.target}; retiring ${support.name} after owned work drains`;
		return;
	}
	if (!anchor || anchor.mode !== "RUNNING") return;
	if (cfg.maxTargets > 2 && !full) {
		const blocker = elasticAdmissionBlocker(pool, now);
		if (blocker) {
			const trial = [...pool.pipelines.values()].find(p => p.trial);
			pool.admission = { decision: trial ? "TRIAL" : "HOLD", reason: blocker, candidate: trial?.name,
				marginalIncome: (trial?.runtime?.plan.expected || 0) - (trial?.replacedExpected || 0), expectedLanes: pool.pipelines.size };
			pool.note = `Admission waiting: ${blocker}`;
			return;
		}
	}
	if (!productive(anchor, now)) {
		const seconds = Math.floor((anchor.stats.pipeline.productiveMs || 0) / 1000);
		pool.note = anchor.admissionReason ? `${anchor.name}: ${anchor.admissionReason}`
			: `Waiting for productive runtime: ${seconds}/120 seconds; recent Hack required`;
	} else if (!full) {
		pool.note = pool.readyScan ? `Scanning ready targets: ${pool.readyScan.index}/${pool.readyScan.names.length}`
			: "Looking for a ready target; background prep may be needed";
	}
	const activeTargets = new Set(pool.pipelines.keys());
	let name = pool.pendingAdmission || "";
	if (!name && cfg.maxTargets > 1 && !full && now >= pool.nextAdmission && productive(anchor, now)) {
		pool.nextAdmission = now + 500;
		name = nextReadyCandidate(ns, pool, anchor, now);
		if (name) {
			pool.pendingAdmission = name;
			pool.pendingAdmissionFloor ||= emptySlotIncomeFloor(anchor.runtime.plan.expected, cfg.switchThreshold);
		}
	}
	// Read-only scouting is allowed in small launch gaps. Background preparation
	// may also scan/select a candidate there, but it cannot exec a prep worker
	// until a >50ms scheduler window is available.
	if (!pool.readyScan && !name) {
		tickBackgroundPrep(ns, { ...prepLaunchHooks(pool), state: cfg.backgroundPrep, target: anchor.name, activeTargets,
			blockedTargets: pool.blocked, network: pool.network, cfg, runtime: anchor.runtime, stats: anchor.stats,
			healthy: productive(anchor, now), allowLaunch: allowPrepLaunch,
			slotFill: cfg.maxTargets > 1 && !full,
			availableBatchRate: remainingBatchRate(pool),
			reclaimShare: host => api.reclaimFleetShare(ns, host),
			claimTarget: target => claimXpTarget(ns, pool, target),
			spareRam: host => moneySpareRam(ns, pool, host, cfg) });
		const prep = cfg.backgroundPrep;
		const target = prep.target ? ` ${prep.target}` : "";
		pool.note = `Background prep${target}: ${prep.status || "WAITING"}` +
			(prep.reason ? ` | ${prep.reason}` : "");
	}
	if (!name || cfg.maxTargets === 1 || full || !productive(anchor, now)) return;
	if (!claimXpTarget(ns, pool, name)) return;
	if (!api.targetHealth(ns, name).clean) {
		pool.pendingAdmission = "";
		return;
	}
	if (remainingBatchRate(pool) < 0.25) {
		pool.note = "No spare combined batch-rate budget; prepared target remains READY"; return;
	}
	if (cfg.backgroundPrep.active && !allowPrepLaunch) {
		pool.note = `Ready target ${name}; waiting for a safe admission window`;
		return;
	}
	if (cfg.backgroundPrep.active && !cancelBackgroundPrep(ns, cfg.backgroundPrep, "admitting an earning target")) return;
	pool.pendingAdmission = "";
	const minimumExpected = pool.pendingAdmissionFloor ||
		emptySlotIncomeFloor(anchor.runtime.plan.expected, cfg.switchThreshold);
	pool.pendingAdmissionFloor = 0;
	const p = createTargetPipeline(name, cfg, api, ns.pid, pool.nextOrdinal++);
	p.replacing = cfg.backgroundPrep.candidate?.replacing || "";
	p.replacedExpected = cfg.backgroundPrep.candidate?.replacedExpected || 0;
	p.minimumExpected = admissionIncomeFloor(pool, minimumExpected, Boolean(p.replacing));
	p.control = targetControl(pool, p); p.cfg.prepStates = cfg.prepStates;
	pool.pipelines.set(p.name, p);
	api.publishHackPause(p.control, Number.MAX_SAFE_INTEGER, "tuning prepared target");
	pool.trialGuard = incomeGuard(pool, anchor, p, now);
	pool.lastAdmission = now;
	pool.note = `Admitting ${p.name}; ${anchor.name} keeps earning`;
	const prep = cfg.backgroundPrep;
	prep.status = "ADMITTED"; prep.reason = "handed off to an independent target pipeline";
	prep.target = ""; prep.candidate = null; prep.health = null; prep.readyAt = 0; prep.scan = null;
}

function incomeGuard(pool, incumbent, trial, now) {
	return { incumbent: incumbent.name, trial: trial.name, admitted: now,
		peers: [...pool.pipelines.values()].filter(p => p !== trial).map(p => ({ name: p.name,
			baseline: pool.api.incomeRate(p.stats, 60_000, now), allocationFails: p.stats.allocationFails })),
		baseline: pool.api.incomeRate(incumbent.stats, 60_000, now),
		misses: sumMisses(incumbent.stats), trialMisses: sumMisses(trial.stats), fallbacks: incumbent.stats.recoveries,
		allocationFails: incumbent.stats.allocationFails, badSince: 0 };
}

function sumMisses(stats) { return Object.values(stats.misses).reduce((n, value) => n + value, 0); }

export function monitorPipelineLoad(ns, pool, now) {
	updatePipelineProgress(pool, now);
	pool.slowTicks = pool.slowTicks.filter(time => time >= now - 60_000);
	const guard = pool.trialGuard;
	if (!guard) return;
	const trial = pool.pipelines.get(guard.trial), incumbent = pool.pipelines.get(guard.incumbent);
	if (!trial || !incumbent || trial.retiring) return;
	// Admission skips are scheduler backpressure, not evidence that a trial is
	// damaging the incumbent. Near the global launch budget, a healthy incumbent
	// can accumulate skips while still matching its income model. Kill a trial
	// early only for concrete overload symptoms; measured income below handles
	// sustained economic harm after warmup.
	const overloaded = pool.slowTicks.filter(time => time >= guard.admitted).length >= 8 ||
		(sumMisses(incumbent.stats) - guard.misses >= 3 && sumMisses(trial.stats) - guard.trialMisses >= 3) ||
		incumbent.stats.allocationFails - guard.allocationFails >= 4 || pool.cfg.maxTargets > 2 &&
		(guard.peers || []).some(before => (pool.pipelines.get(before.name)?.stats.allocationFails || 0) - before.allocationFails >= 4);
	if (overloaded) {
		beginPipelineDrain(pool, trial, { kind: "drain", reason: "shared-load guard protecting incumbent income" }, true);
		return;
	}
	if (trial.trial && trial.mode === "TUNING" && now - guard.admitted > 60_000) {
		beginPipelineDrain(pool, trial, { kind: "drain", reason: "new target plan could not be admitted" }, true);
		return;
	}
	const incumbentUnavailable = incumbent.mode !== "RUNNING" || incumbent.recovery || incumbent.drain ||
		!recentPipelineIncome(incumbent.stats, incumbent.runtime, now);
	// A peer's independent repair is not evidence that an established lane has
	// become harmful. Pause an N-lane trial's economics while that peer recovers.
	if (pool.cfg.maxTargets > 2 && (guard.peers || []).some(before => {
		const peer = pool.pipelines.get(before.name);
		return peer && (peer.recovery || peer.drain || peer.mode !== "RUNNING");
	})) { guard.badSince = 0; return; }
	const incumbentWarming = now < incumbent.firstLanding + 60_000;
	if (trial.trial) {
		if (incumbentUnavailable || incumbentWarming) guard.suspendedSince ??= now;
		else guard.suspendedSince = null;
		const income = pool.api.incomeRate(trial.stats, 60_000, now);
		const misses = sumMisses(trial.stats);
		// A failed incumbent cannot veto a healthy successor forever. Require a
		// continuous earning window, successful batches and enough measured income
		// to replace the admission baseline or sustain its own model. Any new miss
		// restarts the evidence; a dead richer incumbent cannot set an unreachable floor.
		const incomeFloor = Math.min(guard.baseline * 0.95, trial.runtime?.plan.expected * 0.70);
		const healthy = productive(trial, now) && !trial.repair?.active &&
			Number.isFinite(income) && income > 0 && income >= incomeFloor;
		if (!healthy || guard.takeoverMisses !== misses) {
			guard.takeoverSince = null;
			guard.takeoverCompleted = trial.stats.pipeline.completed;
		}
		guard.takeoverMisses = misses;
		if (healthy) guard.takeoverSince ??= now;
		trial.trialNote = guard.suspendedSince == null ? "" :
			`waiting on ${incumbent.name} for ${Math.floor((now - guard.suspendedSince) / 1000)}s; ` +
			(healthy ? `independent validation ${Math.floor((now - guard.takeoverSince) / 1000)}/${TRIAL_MS / 1000}s`
				: "waiting for sustained replacement income");
		// Keep the trial's own evidence through the incumbent's rebuild cycles.
		// A briefly restored incumbent must not restart its peer's observation.
		if ((incumbentUnavailable || incumbentWarming) && healthy &&
			now >= trial.trialUntil && now - guard.takeoverSince >= TRIAL_MS &&
			trial.stats.pipeline.completed > guard.takeoverCompleted) {
			trial.trial = false; trial.trialNote = "";
			pool.anchor = trial.name;
			pool.trialGuard = incomeGuard(pool, trial, incumbent, now);
			pool.note = `${trial.name} validated independently; ${incumbent.name} continues recovery`;
			return;
		}
	} else {
		guard.suspendedSince = null; guard.takeoverSince = null; guard.takeoverMisses = null;
		trial.trialNote = "";
	}
	if (trial.mode !== "RUNNING" || incumbentUnavailable ||
		now < Math.max(trial.firstLanding, incumbent.firstLanding) + 60_000) {
		guard.badSince = 0;
		return; // a target's own repair/warmup is not evidence against its peer
	}
	const a = pool.api.incomeRate(incumbent.stats, 60_000, now);
	const b = pool.api.incomeRate(trial.stats, 60_000, now);
	const peers = (guard.peers || []).map(before => ({ before, p: pool.pipelines.get(before.name) })).filter(v => v.p);
	const peerBaseline = peers.reduce((n, v) => n + v.before.baseline, 0);
	const peerIncome = peers.reduce((n, v) => n + pool.api.incomeRate(v.p.stats, 60_000, now), 0);
	const minimumGain = trial.replacing ? trial.minimumExpected * .70 : peerBaseline * .05;
	const peersPoor = pool.cfg.maxTargets > 2 && (peerIncome + b < peerBaseline + minimumGain || peers.some(({before,p}) =>
		productive(p, now) && pool.api.incomeRate(p.stats, 60_000, now) < before.baseline * .70));
	const poor = !(b > 0) || !Number.isFinite(b) || a < guard.baseline * 0.70 || a + b < guard.baseline * 0.95 || peersPoor;
	if (poor) guard.badSince ||= now;
	else guard.badSince = 0;
	if (trial.trial) trial.trialNote = poor ? "measured income below admission baseline"
		: now < trial.trialUntil ? `observation window: ${Math.ceil((trial.trialUntil - now) / 1000)}s remaining`
			: "waiting for two productive minutes and recent income";
	if (guard.badSince && now - guard.badSince >= 60_000) {
		beginPipelineDrain(pool, trial, { kind: "drain", reason: "additional target failed measured-income trial" }, true);
		return;
	}
	if (trial.trial && now >= trial.trialUntil && productive(trial, now) && !poor) {
		trial.trial = false;
		trial.trialNote = "";
		pool.anchor = [...pool.pipelines.values()].filter(p => productive(p, now))
			.sort((p, q) => pool.api.incomeRate(q.stats, 60_000, now) - pool.api.incomeRate(p.stats, 60_000, now))[0]?.name || incumbent.name;
		pool.note = `${pool.pipelines.size} productive targets; ${pool.anchor} has priority`;
		// Once validated, protect the higher earner. The small target is not given
		// a permanent seat merely because it happened to start first.
		const preferred = pool.pipelines.get(pool.anchor);
		const support = preferred === trial ? incumbent : trial;
		pool.trialGuard = pool.cfg.maxTargets > 2 ? null : incomeGuard(pool, preferred, support, now);
		return;
	}
	if (!trial.trial && now - guard.admitted >= 10 * 60_000 && !poor) {
		guard.admitted = now; guard.baseline = a;
		guard.misses = sumMisses(incumbent.stats); guard.trialMisses = sumMisses(trial.stats); guard.fallbacks = incumbent.stats.recoveries;
		guard.allocationFails = incumbent.stats.allocationFails;
	}
}
