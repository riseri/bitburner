from pathlib import Path
import hashlib

# Exact, locally tested edits. Refuse an unexpected base or modified result.
def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

changes = {
'src/daemon.js': ('00cec98109a3e0c9994be37458e103d81ce12244', '751ba973ee8f1836a90466b75a0796ff1b247274', [
(9,9,'''const WORKER_FILES = [...WORKERS, "lib/jit-worker.js"];
'''),
(11,12,'''const RELEASE_MS = 1_000; // reserve space for callback/reporting jitter
'''),
(32,33,'''// Target ranking estimates earning time inside this horizon, including prep and warmup.
'''),
(43,45,'''		["gap", 100],
		["lead", 600],
'''),
(106,106,'''	validateDaemonPorts(cfg);
	cfg.lead = Math.max(cfg.lead, cfg.gap * 6);

'''),
(117,118,'''	for (const script of WORKER_FILES) {
'''),
(335,354,''),
(412,417,'''		if (eventProblem && !maintenance) {
			if (eventProblem.kind === "recover") {
				if (!drain) recovery = beginSoftRecovery(recovery, eventProblem, controlPort, runtime, stats);
'''),
(418,437,'''				const result = beginDrain(drain, eventProblem, queue, batches, stats, cfg);
'''),
(442,452,'''		if (!maintenance && !drain && loopNow - lastOverdueCheck >= OVERDUE_CHECK_MS) {
			lastOverdueCheck = loopNow;
			const health = targetHealth(ns, target);
			if (health.sec > health.minSec + 5) {
				const result = beginDrain(null, {
					kind: "drain", hard: true, afterKind: "resync", bumpGap: true,
					reason: `security circuit breaker: ${health.sec.toFixed(3)} / ${health.minSec.toFixed(3)}`,
				}, queue, batches, stats, cfg);
				drain = result.drain;
				queue = result.queue;
				recovery = null;
			} else if (!recovery && port.empty()) {
				const overdue = findOverdueBatch(batches, cfg);
				if (overdue) {
					const batch = batches.get(overdue.batchId);
					const chunk = batch.chunks.get(overdue.chunkId);
					const pid = runningByChunk.get(chunk.chunkId);
					if (pid == null || !ns.isRunning(pid)) {
						untrackRunningByChunk(running, runningByChunk, chunk.chunkId);
						settleChunk(batch, chunk, { type: "miss", finishedAt: loopNow }, stats);
						recordPhaseMiss(stats, chunk.phase);
						cancelPoisonedBatch(ns, batch, running, runningByChunk, stats);
					}
					recovery = beginSoftRecovery(recovery, overdue, controlPort, runtime, stats);
				}
			}
		}
'''),
(453,458,'''		if (recovery && !drain && !maintenance) {
			cancelHackWindow(ns, batches, running, runningByChunk, stats, recovery.pauseUntil);
			const local = updateSoftRecovery(ns, target, recovery, controlPort, runtime, stats);
			recovery = local.recovery;
			if (local.problem) {
				const result = beginDrain(drain, local.problem, queue, batches, stats, cfg);
				drain = result.drain;
				queue = result.queue;
			} else if (!recovery) {
				// Drop stale unplanned slots instead of generating past-due work after a pause.
				nextHackLanding = Math.max(nextHackLanding,
					Date.now() + runtime.plan.times.W + cfg.lead + STARTUP_BUFFER_MS);
			}
		}
'''),
(459,474,'''		if (drain) {
			recovery = null;
			if (!drain.stopPublished) {
				publishHackPause(controlPort, Number.MAX_SAFE_INTEGER, drain.reason);
				drain.stopPublished = true;
			}
			serviceHardDrain(ns, drain, batches, running, runningByChunk, stats);
		}
'''),
(475,481,'''		// Healthy launches still have priority over allocator/UI work, but never over
		// a known safety fault. There is enough lead to consume a bounded event burst.
		if (port.empty()) {
			const launched = launchDueChunks(ns, queue, target, cfg, batches, stats, running, runningByChunk, drain);
			queue = launched.queue;
			drain = launched.drain;
'''),
(537,537,'''				stats.pipeline.completed * runtime.plan.period >= 10 * 60_000 &&
'''),
(647,647,'''			stats.pipeline.completed * runtime.plan.period >= 15 * 60_000 &&
'''),
(682,685,'''			drain && (
				(queue.length === 0 && running.size === 0) ||
				(drain.hard && drain.cancelDone && !hasHarmfulRunning(running) && port.empty() && targetHealth(ns, target).clean)
			)
'''),
(686,686,'''			cfg.gap = drain.nextGap;
			cfg.lead = Math.max(cfg.lead, cfg.gap * 6);
'''),
(703,704,'''			publishHackPause(controlPort, Number.MAX_SAFE_INTEGER, "maintenance");
'''),
(918,918,'''			stats.lastW2 = NaN;
			stats.lastHackLanding = NaN;
			stats.finishedBatches.clear();
			stats.batchTimes = [];
			lastLoopAt = Date.now();
			publishHackPause(controlPort, 0, "ready");
'''),
(946,946,'''		const earliestNewLanding = Date.now() + runtime.plan.times.W + cfg.lead + STARTUP_BUFFER_MS;
		if (!drain && !recovery && nextHackLanding < earliestNewLanding) {
			const skipped = Math.ceil((earliestNewLanding - nextHackLanding) / runtime.plan.period);
			nextHackLanding += skipped * runtime.plan.period;
			stats.expiredSlots += skipped;
		}
'''),
(951,953,'''				cfg.lead + STARTUP_BUFFER_MS + runtime.plan.period * 2
'''),
(960,960,'''			!recovery &&
			port.empty() &&
'''),
(1043,1044,'''		if (port.empty()) {
'''),
(1123,1123,'''	}
}

function validateDaemonPorts(cfg) {
	const selected = [cfg.port, cfg.fleetPort, cfg.controlPort];
	if (selected.some(port => !Number.isSafeInteger(port) || port <= 0) || new Set(selected).size !== 3) {
		throw new Error("Worker events, fleet status and JIT control need distinct positive integer ports");
	}
	const reserved = [PORTS.CONTRACT_STATUS, PORTS.JIT_STATUS, PORTS.PROGRESSION_STATUS];
	if (selected.some(port => reserved.includes(port))) {
		throw new Error("Daemon port conflicts with a reserved supervisor/contract/progression channel");
'''),
(1470,1471,'''						WORKER_FILES,
'''),
(1785,1791,'''		const warmupMs = runtime.plan.times.W + cfg.lead + STARTUP_BUFFER_MS;
		const amortization = Math.max(0, TARGET_HORIZON_MS - prepMs - warmupMs) / TARGET_HORIZON_MS;
'''),
(2840,2841,'''				Math.min(0.89, steal * 1.10)
'''),
(2962,2963,'''			steal * 0.95 *
'''),
(3288,3288,'''	for (const chunk of hack.chunks) {
		chunk.stealBudget = plan.steal * chunk.threads / plan.H;
	}
'''),
(3881,3881,'''		duration,
'''),
(4514,4525,'''function makeBatchState(id, chunks) {
	const expected = { H: 0, W1: 0, G: 0, W2: 0 };
'''),
(4526,4539,'''	for (const chunk of chunks) {
		expected[chunk.phase]++;
		landing[chunk.phase] = chunk.landAt;
		chunk.status = "queued";
'''),
(4540,4565,'''	return { id: String(id), expected, landing,
		chunks: new Map(chunks.map(chunk => [chunk.chunkId, chunk])),
		moneyEarned: 0, poisoned: false, paidCounted: false,
		phases: { H: phaseState(), W1: phaseState(), G: phaseState(), W2: phaseState() } };
'''),
(4568,4583,'''	return { count: 0, min: Infinity, max: -Infinity, complete: false, skipped: false };
'''),
(4585,4603,'''function isTerminalChunk(chunk) {
	return ["done", "miss", "skip", "error"].includes(chunk.status);
'''),
(4605,4614,'''function recordPhaseMiss(stats, phase, execFailure = false) {
	if (!Object.hasOwn(stats.misses, phase)) return;
	stats.misses[phase]++;
	stats.pipeline.misses[phase]++;
	if (execFailure) stats.execFails[phase]++;
}
'''),
(4615,4617,'''// Each chunk can become terminal exactly once, including cancellations and split phases.
function settleChunk(batch, chunk, event, stats) {
	if (isTerminalChunk(chunk)) return false;
	chunk.status = event.type;
	const state = batch.phases[chunk.phase];
	state.count++;
	if (event.type === "done") {
		const finished = Number(event.finishedAt);
		state.min = Math.min(state.min, finished);
		state.max = Math.max(state.max, finished);
		if (chunk.phase === "H") {
			const earned = Math.max(0, Number(event.result) || 0);
			stats.money += earned;
			batch.moneyEarned += earned;
			stats.lastHackAt = finished;
			stats.lastHackLanding = chunk.landAt;
			stats.income.push({ time: finished, money: earned });
		}
	} else {
		state.skipped = true;
		if (chunk.phase !== "H") batch.poisoned = true;
'''),
(4618,4618,'''	state.complete = state.count === batch.expected[chunk.phase];
	if (batch.phases.H.complete && batch.moneyEarned > 0 && !batch.paidCounted) {
		stats.profitable++;
		batch.paidCounted = true;
	}
	if (Object.values(batch.phases).every(p => p.complete)) stats.finishedBatches.add(batch.id);
	return true;
}
'''),
(4619,4621,'''function finishReadyBatches(batches, stats, cfg) {
	let problem = null;
	for (const id of stats.finishedBatches) {
		const batch = batches.get(id);
		if (!batch) continue;
		const order = ["H", "W1", "G", "W2"];
		for (let i = 1; i < order.length; i++) {
			const a = batch.phases[order[i - 1]];
			const b = batch.phases[order[i]];
			if (a.skipped || b.skipped) continue;
			const spacing = b.min - a.max;
			stats.minSpacing = Math.min(stats.minSpacing, spacing);
			stats.pipeline.minSpacing = Math.min(stats.pipeline.minSpacing, spacing);
			if (spacing < minimumSpacing(cfg)) {
				batch.poisoned = true;
				problem ??= { kind: "recover", reason: `unsafe ${order[i - 1]} -> ${order[i]} spacing ${spacing.toFixed(1)}ms` };
			}
		}
		if (batch.poisoned || batch.phases.H.skipped) {
			stats.recovered++;
		} else {
			stats.completed++;
			stats.pipeline.completed++;
			stats.batchTimes.push(batch.phases.W2.max);
		}
		// Finalize even when a safety check fails. No early-return orphan batch.
		batches.delete(id);
	}
	stats.finishedBatches.clear();
	return problem;
}
'''),
(4622,4625,''),
(4626,4644,''),
(4649,4650,'''		paused: pauseUntil > 0,
		hackPauseUntil: pauseUntil,
'''),
(4657,4660,''),
(4664,4666,'''			deadline: now + SOFT_RECOVERY_MAX_MS,
			pauseUntil: now + Math.max(SOFT_RECOVERY_MS, runtime.plan.period * 4),
			checkAt: now,
			cleanSince: null,
'''),
(4671,4673,''),
(4674,4674,'''		// A stream of faults must NOT move the hard deadline or defer health checks.
		current.pauseUntil = Math.min(current.deadline, Math.max(current.pauseUntil, now + SOFT_RECOVERY_MS));
'''),
(4675,4675,'''	stats.lastReason = `recovering: ${current.reason}`;
	publishHackPause(controlPort, current.deadline, current.reason);
	return current;
}
'''),
(4676,4679,'''function targetHealth(ns, target) {
	const maxMoney = ns.getServerMaxMoney(target);
	const money = ns.getServerMoneyAvailable(target);
	const minSec = ns.getServerMinSecurityLevel(target);
	const sec = ns.getServerSecurityLevel(target);
	return { money, maxMoney, sec, minSec,
		clean: money >= maxMoney * 0.9999 && sec <= minSec + 0.001 };
'''),
(4683,4684,''),
(4685,4685,'''	// Check the immutable deadline BEFORE checkAt and independently of incoming faults.
	if (now >= current.deadline) {
		return { recovery: null, problem: {
			kind: "drain", afterKind: "resync", hard: true, bumpGap: true,
			reason: `local recovery exceeded ${SOFT_RECOVERY_MAX_MS / 1000}s: ${current.reason}`,
		} };
	}
'''),
(4686,4698,'''	current.checkAt = now + 25;
	const health = targetHealth(ns, target);
	if (health.sec > health.minSec + 5) {
		return { recovery: null, problem: {
			kind: "drain", afterKind: "resync", hard: true, bumpGap: true,
			reason: `security circuit breaker: ${health.sec.toFixed(3)} / ${health.minSec.toFixed(3)}`,
		} };
'''),
(4699,4702,'''	if (!health.clean) {
		current.cleanSince = null;
		current.pauseUntil = Math.min(current.deadline, Math.max(current.pauseUntil, now + SOFT_RECOVERY_MS));
'''),
(4704,4716,'''	current.cleanSince ??= now;
	if (now - current.cleanSince < 100 || now < current.started + 500) {
		return { recovery: current, problem: null };
'''),
(4717,4725,'''	publishHackPause(controlPort, 0, "recovered");
	stats.softRecoverySuccesses++;
	stats.lastReason = `recovered locally: ${current.reason}`;
	return { recovery: null, problem: null };
'''),
(4727,4735,'''// Stop only imminent in-flight hacks during a local repair. Calling ns.hack already
// committed a timer; updating a port cannot retract it. Keep G/W repair tails alive.
function cancelHackWindow(ns, batches, running, runningByChunk, stats, through) {
	for (const batch of batches.values()) {
		if (batch.landing.H > through) break; // batches are inserted in landing order
		for (const chunk of batch.chunks.values()) {
			if (chunk.phase !== "H" || isTerminalChunk(chunk)) continue;
			cancelChunk(ns, batch, chunk, running, runningByChunk, stats);
		}
	}
}

function cancelChunk(ns, batch, chunk, running, runningByChunk, stats) {
	if (isTerminalChunk(chunk)) return true;
	const pid = runningByChunk.get(chunk.chunkId);
	// A failed kill may mean completion is already in the event port. Do not invent
	// a skipped completion or lose the earned money; consume the real event first.
	if (pid != null && !ns.kill(pid)) return false;
	if (pid != null) untrackRunningByChunk(running, runningByChunk, chunk.chunkId);
	settleChunk(batch, chunk, { type: "skip", finishedAt: Date.now() }, stats);
	if (chunk.phase === "H") {
		stats.suppressedHackChunks++;
		stats.pipeline.suppressedHackChunks++;
	}
	return true;
}

function cancelPoisonedBatch(ns, batch, running, runningByChunk, stats) {
	for (const chunk of batch.chunks.values()) {
		if (chunk.phase === "H") cancelChunk(ns, batch, chunk, running, runningByChunk, stats);
	}
	// If any hack already landed, retain grows to restore its money. Otherwise
	// cancel grows too: growing a batch without W2 causes the security avalanche.
	if (batch.moneyEarned === 0 && batch.phases.H.complete) {
		for (const chunk of batch.chunks.values()) {
			if (chunk.phase === "G") cancelChunk(ns, batch, chunk, running, runningByChunk, stats);
		}
	}
}

function beginDrain(current, issue, queue, batches, stats, cfg) {
'''),
(4736,4740,'''		current.hard ||= Boolean(issue.hard);
		return { drain: current, queue };
'''),
(4741,4750,'''	// Never mutate the gap of already-reserved batches. Apply it at reconfiguration.
	const nextGap = issue.bumpGap ? Math.min(500, Math.max(cfg.gap + 25,
		Math.ceil(Math.max(stats.pipeline.loopLagMax, stats.pipeline.driftMax) * 2 + 25))) : cfg.gap;
'''),
(4752,4757,'''	stats.lastReason = `draining: ${issue.reason}`;
	const drain = {
		reason: issue.reason, afterKind: issue.afterKind ?? "resync",
		resetPeriod: Boolean(issue.resetPeriod), started: Date.now(), nextGap,
		hard: Boolean(issue.hard), cancelIterator: null, cancelDone: false,
	};
'''),
(4758,4767,'''		if (chunk.phase !== "H" && !(drain.hard && chunk.phase === "G")) continue;
		const batch = batches.get(chunk.batchId);
		if (batch && !isTerminalChunk(chunk)) {
			settleChunk(batch, chunk, { type: "skip", finishedAt: Date.now() }, stats);
			if (chunk.phase === "H") stats.cancelledHackChunks++;
'''),
(4768,4770,''),
(4771,4788,'''	return { drain, queue: queue.filter(chunk => !isTerminalChunk(chunk)) };
'''),
(4790,4806,'''// A catastrophic repair is not allowed to keep growing at security 100. Cancel
// damaging in-flight actions in bounded slices, preserving already-started W tails.
function serviceHardDrain(ns, drain, batches, running, runningByChunk, stats) {
	if (!drain.hard || drain.cancelDone) return;
	drain.cancelIterator ??= running.entries();
	for (let checked = 0; checked < 32; checked++) {
		const item = drain.cancelIterator.next();
		if (item.done) { drain.cancelDone = true; break; }
		const [, chunk] = item.value;
		if (chunk.phase !== "H" && chunk.phase !== "G") continue;
		const batch = batches.get(chunk.batchId);
		if (batch) cancelChunk(ns, batch, chunk, running, runningByChunk, stats);
	}
}
'''),
(4807,4813,'''
function consumeEvents(ns, port, batches, stats, target, runtime, cfg, running, runningByChunk) {
	let problem = null;
	let processed = 0;
	while (!port.empty() && processed++ < 512) {
		const event = port.read();
		if (!event || typeof event !== "object" || event.target !== target) continue;
		const batch = batches.get(String(event.batchId));
		const chunk = batch?.chunks.get(String(event.chunkId));
		if (!chunk || chunk.phase !== event.phase || isTerminalChunk(chunk)) continue;
		if (event.type === "started") {
			chunk.status = "called";
			chunk.startedAt = Number(event.startedAt);
			continue; // a start notification must never release RAM/PID ownership
'''),
(4814,4831,'''		if (!["done", "miss", "skip", "error"].includes(event.type)) continue;
		if (event.type === "done" && !Number.isFinite(Number(event.finishedAt))) continue;
		untrackRunningByChunk(running, runningByChunk, chunk.chunkId);
		if (!settleChunk(batch, chunk, event, stats)) continue;
'''),
(4833,4872,'''			if (chunk.phase === "H") {
				stats.suppressedHackChunks++;
				stats.pipeline.suppressedHackChunks++;
'''),
(4873,4878,'''		} else if (event.type === "miss" || event.type === "error") {
			recordPhaseMiss(stats, chunk.phase);
			const reason = `${chunk.phase} ${event.code ?? event.type}: ` +
				`launch +${(Number(event.launchLag) || 0).toFixed(1)}ms; ` +
				`duration delta ${(Number(event.durationDelta) || 0).toFixed(1)}ms`;
			stats.lastReason = reason;
			if (chunk.phase !== "H") {
				batch.poisoned = true;
				cancelPoisonedBatch(ns, batch, running, runningByChunk, stats);
				problem ??= { kind: "recover", reason };
'''),
(4879,5068,'''		} else {
			const drift = Math.abs(Number(event.drift) || 0);
			stats.driftSum += drift;
			stats.driftCount++;
			stats.driftMax = Math.max(stats.driftMax, drift);
			stats.pipeline.driftSum += drift;
			stats.pipeline.driftCount++;
			stats.pipeline.driftMax = Math.max(stats.pipeline.driftMax, drift);
			if (drift >= cfg.gap - minimumSpacing(cfg)) {
				problem ??= { kind: "recover", reason: `${chunk.phase} completion drift ${drift.toFixed(1)}ms` };
'''),
(5069,5100,'''			if (chunk.phase === "H" && Number.isFinite(stats.lastW2)) {
				const spacing = Number(event.finishedAt) - stats.lastW2;
				stats.minSpacing = Math.min(stats.minSpacing, spacing);
				stats.pipeline.minSpacing = Math.min(stats.pipeline.minSpacing, spacing);
				if (spacing < minimumSpacing(cfg)) {
					problem ??= { kind: "recover", reason: `unsafe W2 -> H spacing ${spacing.toFixed(1)}ms` };
'''),
(5101,5133,'''			}
			if (chunk.phase === "W2") {
				stats.lastW2 = Number(event.finishedAt);
				// Use the worker's completion snapshot, not potentially newer dirty
				// state sampled by a controller consuming a delayed event.
				if (Number.isFinite(event.moneyAfter) && Number.isFinite(event.securityAfter)) {
					if (event.moneyAfter < ns.getServerMaxMoney(target) * 0.995 ||
						event.securityAfter > ns.getServerMinSecurityLevel(target) + 0.02) {
						problem ??= { kind: "recover", reason: "target not restored at W2 completion" };
					}
'''),
(5136,5136,'''	}
	const completionProblem = finishReadyBatches(batches, stats, cfg);
	return problem ?? completionProblem;
}
'''),
(5137,5234,'''function findOverdueBatch(batches, cfg) {
	const now = Date.now();
	const grace = Math.max(500, cfg.gap * 3);
	for (const batch of batches.values()) {
		if (batch.landing.H > now) break;
		for (const chunk of batch.chunks.values()) {
			if (isTerminalChunk(chunk) || now <= chunk.landAt + grace) continue;
			return { kind: "recover", reason: `${chunk.phase} completion overdue`,
				batchId: batch.id, chunkId: chunk.chunkId };
'''),
(5236,5237,''),
(5240,5291,''),
(5338,5356,'''function launchDueChunks(ns, queue, target, cfg, batches, stats, running, runningByChunk, drain) {
	let launched = 0;
	while (queue.length && queue[0].launchAt <= Date.now() && launched++ < 32) {
		const chunk = queue.shift();
		const batch = batches.get(chunk.batchId);
		if (!batch || isTerminalChunk(chunk)) continue;
		if (batch.poisoned && (chunk.phase === "H" || (chunk.phase === "G" && batch.moneyEarned === 0))) {
			settleChunk(batch, chunk, { type: "skip", finishedAt: Date.now() }, stats);
			continue;
		}
		if (drain && (chunk.phase === "H" || (drain.hard && chunk.phase === "G"))) {
			settleChunk(batch, chunk, { type: "skip", finishedAt: Date.now() }, stats);
			continue;
		}
		const pid = ns.exec(chunk.script, chunk.host, chunk.threads,
			target, chunk.landAt, chunk.batchId, cfg.port, chunk.phase, chunk.chunkId,
			Math.max(20, cfg.gap), cfg.controlPort, chunk.duration, chunk.launchAt,
			chunk.stealBudget ?? 0, chunk.threads);
		if (!pid) {
			recordPhaseMiss(stats, chunk.phase, true);
			settleChunk(batch, chunk, { type: "miss", finishedAt: Date.now() }, stats);
			batch.poisoned = true;
			cancelPoisonedBatch(ns, batch, running, runningByChunk, stats);
			// This batch is unusable, but a single exec failure need not erase other batches.
			stats.lastReason = `exec failed: ${chunk.phase} on ${chunk.host}`;
			continue;
		}
		chunk.status = "running";
		trackRunning(running, pid, chunk);
		runningByChunk.set(chunk.chunkId, pid);
	}
	return { queue, drain };
}
'''),
(5357,5443,''),
(5547,5554,'''function hasHarmfulRunning(running) {
	for (const chunk of running.values()) {
		if (chunk.phase === "H" || chunk.phase === "G") return true;
	}
	return false;
}
'''),
(5555,5560,'''const reconcileCursors = new WeakMap();

function reconcileRunning(ns, running, runningByChunk, limit) {
	let cursor = reconcileCursors.get(running);
	if (!cursor) {
		cursor = running.entries();
		reconcileCursors.set(running, cursor);
	}
	for (let checked = 0; checked < limit; checked++) {
		const next = cursor.next();
		if (next.done) {
			reconcileCursors.delete(running);
'''),
(5562,5576,'''		const [pid, chunk] = next.value;
		if (!running.has(pid) || ns.isRunning(pid)) continue;
		untrackRunning(running, pid, chunk);
		runningByChunk.delete(chunk.chunkId);
'''),
(5593,5593,'''		expiredSlots: 0,
		finishedBatches: new Set(),
		lastHackLanding: NaN,
'''),
(5669,5669,'''		completed: 0,
'''),
(5902,5918,'''	const hackStatus = drain ? `DRAINING | ${running.size} workers left`
		: recovery ? `PAUSED | deadline ${formatTime(Math.max(0, recovery.deadline - now))}`
		: Number.isFinite(stats.lastHackAt) && now - stats.lastHackAt < 10_000 ? "LIVE"
		: Number.isFinite(pendingHackLanding)
			? pendingHackLanding > now ? `ETA ${formatTime(pendingHackLanding - now)}`
				: `DUE +${formatTime(now - pendingHackLanding)}`
			: "WAITING";
'''),
(6134,6135,'''		`| worst streak ${stats.maxConsecutiveAllocationFails} ` +
		`| expired slots ${stats.expiredSlots}`
'''),
]),
'src/fleet-manager.js': ('95424769ceccbb46cf9b719323992c9a5fe0c781', 'dfcdb05d3b70b3ad211b3eeed4151b3ad6ac0666', [
(6,7,'''const WORKERS = [HACK, GROW, WEAKEN, "lib/jit-worker.js"];
'''),
(250,251,'''		if (host !== HOME && WORKERS.some(file => !ns.fileExists(file, host))) {
'''),
]),
}

for filename, (before, after, edits) in changes.items():
    path = Path(filename)
    original = path.read_bytes()
    if blob(original) != before:
        raise SystemExit(f'{filename}: unexpected base {blob(original)}')
    lines = original.decode().splitlines(keepends=True)
    for start, end, content in reversed(edits):
        lines[start:end] = content.splitlines(keepends=True)
    result = ''.join(lines).encode()
    if blob(result) != after:
        raise SystemExit(f'{filename}: result mismatch {blob(result)} != {after}')
    path.write_bytes(result)
    print(f'{filename}: verified {after}')
