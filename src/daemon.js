const HOME = "home";

const HACK = "jit-hack.js";
const GROW = "jit-grow.js";
const WEAKEN = "jit-weaken.js";

const WORKERS = [HACK, GROW, WEAKEN];
const FLEET_MANAGER = "fleet-manager.js";

const RELEASE_MS = 5;
const STARTUP_BUFFER_MS = 250;
const PREP_BUFFER_MS = 150;

const NETWORK_REFRESH_MS = 10_000;
const UI_REFRESH_MS = 10_000;
const PROCESS_REAP_MS = 1_000;
const OVERDUE_CHECK_MS = 250;
const RESERVATION_CLEANUP_MS = 500;
const MAX_BATCHES_PLANNED_PER_TICK = 1;
const PLANNING_BUDGET_MS = 4;
const PLANNING_LAUNCH_GUARD_MS = 20;

// RAM gains do not invalidate existing reservations, so batch them into an
// occasional retune instead of destroying the pipeline on every cloud upgrade.
const CAPACITY_RETUNE_COOLDOWN_MS = 10 * 60 * 1000;
const CAPACITY_RETUNE_RATIO = 1.25;

// Target ranking amortizes prep cost over this much future runtime.
const TARGET_HORIZON_MS = 10 * 60 * 1000;

// Bitburner server growth constants.
const SERVER_BASE_GROWTH_INCR = 0.03;
const SERVER_MAX_GROWTH_LOG = 0.00349388925425578;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["target", "auto"],
		["gap", 30],
		["lead", 25],
		["home-reserve", 8],
		["min-steal", 0.01],
		["max-steal", 0.50],
		["switch-threshold", 1.25],
		["port", 20],
		["cloud", true],
		["cloud-reserve", 0.10],
		["cloud-min-ram", 32],
		["cloud-prefix", "cloud"],
		["fleet-port", 19],
	]);

	ns.disableLog("ALL");

	const cfg = {
		requestedTarget: String(flags.target ?? "auto"),
		gap: Math.max(15, Number(flags.gap)),
		lead: Math.max(10, Number(flags.lead)),
		homeReserve: Math.max(
			0,
			Number(flags["home-reserve"])
		),
		minSteal: asFraction(
			Number(flags["min-steal"])
		),
		maxSteal: asFraction(
			Number(flags["max-steal"])
		),
		switchThreshold: Math.max(
			1.05,
			Number(flags["switch-threshold"])
		),
		port: Number(flags.port),
		fleetPort: Number(flags["fleet-port"]),
		periodScale: 1,
		ram: {},
		cloud: {
			enabled: asBoolean(flags.cloud),
			cashReserve: Math.min(
				0.95,
				Math.max(
					0,
					asFraction(
						Number(flags["cloud-reserve"])
					)
				)
			),
			minRam: normalizeCloudRam(
				Number(flags["cloud-min-ram"])
			),
			prefix:
				String(
					flags["cloud-prefix"] ??
					"cloud"
				).trim() ||
				"cloud",
		},
	};

	if (
		!(cfg.minSteal > 0) ||
		cfg.maxSteal < cfg.minSteal ||
		cfg.maxSteal >= 0.90
	) {
		ns.tprint(
			"ERROR: require 0 < min-steal <= max-steal < 0.90"
		);
		return;
	}

	for (const script of WORKERS) {
		if (!ns.fileExists(script, HOME)) {
			ns.tprint(`ERROR: missing ${script}`);
			return;
		}
	}

	if (!ns.fileExists(FLEET_MANAGER, HOME)) {
		ns.tprint(
			`WARN: missing ${FLEET_MANAGER}; cloud upgrades/rooting will not run in the background.`
		);
	}

	cfg.ram = {
		H: ns.getScriptRam(HACK, HOME),
		G: ns.getScriptRam(GROW, HOME),
		W: ns.getScriptRam(WEAKEN, HOME),
	};

	const minimumWorkerRam = Math.min(
		cfg.ram.H,
		cfg.ram.G,
		cfg.ram.W
	);

	const port = ns.getPortHandle(cfg.port);
	port.clear();

	const fleetPort = ns.getPortHandle(cfg.fleetPort);
	fleetPort.clear();

	// Stop the old single-host controller if it exists.
	ns.scriptKill("jit.js", HOME);

	const deployed = new Set([HOME]);

	const cloudState =
		createCloudState();

	refreshCloudState(
		ns,
		cfg,
		cloudState
	);

	startFleetManager(
		ns,
		cfg
	);

	// Startup is not latency-sensitive, so do one synchronous root/deploy pass.
	// After this point fleet management runs in fleet-manager.js.
	let network = await refreshNetwork(
		ns,
		cfg,
		deployed,
		minimumWorkerRam,
		true
	);

	// Kill orphan workers left from a previous daemon run.
	killWorkerScripts(ns, network.hosts);

	await ns.sleep(50);

	port.clear();

	let targetAnalysis =
		cfg.requestedTarget === "auto"
			? rankTargets(
				ns,
				network,
				cfg,
				new Map()
			)
			: [];

	let target = resolveTarget(
		ns,
		network,
		cfg,
		targetAnalysis
	);

	if (!target) {
		ns.tprint(
			"ERROR: no hackable money target found."
		);
		return;
	}

	const stats = createStats();

	await prepTarget(
		ns,
		target,
		network,
		cfg,
		port,
		stats,
		targetAnalysis
	);

	// Prep changes the selected target's economics.
	if (cfg.requestedTarget === "auto") {
		targetAnalysis = rankTargets(
			ns,
			network,
			cfg,
			new Map()
		);
	}

	let runtime = tuneTarget(
		ns,
		target,
		network.hosts,
		cfg,
		new Map()
	);

	if (!runtime) {
		ns.tprint(
			`ERROR: unable to build a batch plan for ${target}`
		);
		return;
	}

	let queue = [];
	let reservations = [];

	const running = new Map();
	const batches = new Map();
	const foreignUsedByHost = new Map();

	seedForeignUsage(
		ns,
		network.hosts,
		running,
		foreignUsedByHost
	);

	let foreignUsageCursor = 0;

	let batchCounter = 0;

	let nextHackLanding =
		Date.now() +
		runtime.plan.times.W +
		cfg.lead +
		STARTUP_BUFFER_MS;

	// Placement misses are expected in a fragmented distributed RAM pool.
	// They are telemetry only and never trigger a pipeline restart by themselves.
	let consecutiveAllocationFailures = 0;

	let lastUi = 0;
	let lastReap = 0;
	let lastOverdueCheck = 0;
	let lastReservationCleanup = 0;
	let lastNetworkRefresh = Date.now();
	let lastFleetStatusAt = 0;

	let lastTunedLevel =
		ns.getHackingLevel();

	let lastObservedFleetCapacity =
		workerFleetCapacity(
			network.hosts,
			cfg
		);

	let tunedFleetCapacity =
		lastObservedFleetCapacity;

	let lastCapacityRetune =
		Date.now();

	let maintenance = null;
	let drain = null;

	stats.started = Date.now();

	while (true) {
		const loopNow =
			Date.now();

		{
			const launched = launchDueChunks(
				ns,
				queue,
				target,
				cfg,
				batches,
				stats,
				running,
				drain
			);

			queue = launched.queue;
			drain = launched.drain;
		}

		foreignUsageCursor = refreshOneForeignUsage(
			ns,
			network.hosts,
			running,
			foreignUsedByHost,
			foreignUsageCursor
		);

		if (loopNow - lastReap >= PROCESS_REAP_MS) {
			lastReap = loopNow;
			reapRunning(ns, running);
		}

		const fleetStatus = fleetPort.peek();
		if (
			fleetStatus &&
			typeof fleetStatus === "object" &&
			fleetStatus.type === "fleet-status" &&
			Number(fleetStatus.generatedAt) > lastFleetStatusAt
		) {
			lastFleetStatusAt = Number(fleetStatus.generatedAt);
			applyFleetStatus(cloudState, fleetStatus);
		}

		const eventProblem = consumeEvents(
			ns,
			port,
			batches,
			stats,
			target,
			runtime,
			cfg
		);

		if (eventProblem) {
			if (eventProblem.kind === "drain") {
				const result = beginDrain(
					drain,
					eventProblem,
					queue,
					batches,
					stats,
					cfg
				);
				drain = result.drain;
				queue = result.queue;
			} else if (!maintenance) {
				maintenance = eventProblem;
			}
		}

		if (
			!maintenance &&
			!drain &&
			loopNow - lastOverdueCheck >= OVERDUE_CHECK_MS
		) {
			lastOverdueCheck = loopNow;
			const overdue = findOverdueBatch(batches, cfg);
			if (overdue) {
				const result = beginDrain(
					drain,
					{ reason: overdue, kind: "drain", afterKind: "resync", bumpGap: true },
					queue,
					batches,
					stats,
					cfg
				);
				drain = result.drain;
				queue = result.queue;
			}
		}

		const now = Date.now();

		if (
			!maintenance &&
			now - lastNetworkRefresh >= NETWORK_REFRESH_MS
		) {
			lastNetworkRefresh = now;
			const refreshed = networkFromFleetStatus(fleetStatus, minimumWorkerRam) ?? network;
			const fleetCapacity = workerFleetCapacity(refreshed.hosts, cfg);
			const capacityLost = fleetCapacity < lastObservedFleetCapacity - 1;
			const capacityGainRatio = tunedFleetCapacity > 0 ? fleetCapacity / tunedFleetCapacity : Infinity;
			const timingFloor = 4 * cfg.gap + minimumSpacing(cfg);
			const capacityCanHelp = runtime.plan.period > timingFloor + 5;
			const deferredRetuneReady =
				!drain &&
				capacityCanHelp &&
				capacityGainRatio >= CAPACITY_RETUNE_RATIO &&
				now - lastCapacityRetune >= CAPACITY_RETUNE_COOLDOWN_MS;

			network = refreshed;
			syncForeignUsageHosts(network.hosts, foreignUsedByHost);

			if (capacityLost && !drain) {
				const result = beginDrain(
					drain,
					{
						reason: `worker fleet RAM decreased ${lastObservedFleetCapacity.toFixed(1)}GB -> ${fleetCapacity.toFixed(1)}GB`,
						kind: "drain",
						afterKind: "network",
						resetPeriod: true,
					},
					queue,
					batches,
					stats,
					cfg
				);
				drain = result.drain;
				queue = result.queue;
			} else if (deferredRetuneReady) {
				const result = beginDrain(
					drain,
					{
						reason: `deferred RAM-growth retune ${tunedFleetCapacity.toFixed(1)}GB -> ${fleetCapacity.toFixed(1)}GB (+${((capacityGainRatio - 1) * 100).toFixed(1)}%)`,
						kind: "drain",
						afterKind: "network",
						resetPeriod: true,
					},
					queue,
					batches,
					stats,
					cfg
				);
				drain = result.drain;
				queue = result.queue;
			}
			lastObservedFleetCapacity = fleetCapacity;
		}

		const hackingLevel = ns.getHackingLevel();
		const retuneAt = Math.max(lastTunedLevel + 10, Math.ceil(lastTunedLevel * 1.10));
		if (!maintenance && !drain && hackingLevel >= retuneAt) {
			const result = beginDrain(
				drain,
				{
					reason: `hacking level ${lastTunedLevel} -> ${hackingLevel}`,
					kind: "drain",
					afterKind: "retune",
					resetPeriod: true,
				},
				queue,
				batches,
				stats,
				cfg
			);
			drain = result.drain;
			queue = result.queue;
		}

		if (drain && queue.length === 0 && running.size === 0) {
			maintenance = {
				reason: drain.reason,
				kind: drain.afterKind,
				resetPeriod: drain.resetPeriod,
			};
			drain = null;
		}

		if (maintenance) {
			if (maintenance.bumpGap) cfg.gap = Math.min(100, cfg.gap + 5);
			if (maintenance.resetPeriod) cfg.periodScale = 1;
			stats.restarts++;
			if (maintenance.kind === "resync") stats.resyncs++;
			stats.lastReason = maintenance.reason;
			ns.clearLog();
			ns.print("JIT DAEMON :: RECONFIGURE");
			ns.print(`Reason  ${maintenance.reason}`);
			ns.print(`Gap     ${cfg.gap}ms`);
			ns.print(`Stopping ${running.size} running worker(s)...`);
			queue = [];
			reservations = [];
			batches.clear();
			abortWorkers(ns, network.hosts);
			clearRunning(running);
			port.clear();
			await ns.sleep(50);
			network = await refreshNetwork(ns, cfg, deployed, minimumWorkerRam, true);
			if (maintenance.target) target = maintenance.target;
			if (cfg.requestedTarget === "auto") {
				targetAnalysis = rankTargets(ns, network, cfg, new Map());
				const best = targetAnalysis[0];
				const current = targetAnalysis.find(entry => entry.name === target);
				if (!maintenance.target && best && current && best.name !== target && best.score > current.score * cfg.switchThreshold) {
					maintenance.reason += ` | better target ${target} -> ${best.name}`;
					target = best.name;
				}
				if (!target || !ns.hasRootAccess(target) || ns.getServerRequiredHackingLevel(target) > ns.getHackingLevel()) {
					target = resolveTarget(ns, network, cfg, targetAnalysis);
				}
			}
			if (!target) {
				ns.tprint("ERROR: no valid target after reconfiguration.");
				return;
			}
			await prepTarget(ns, target, network, cfg, port, stats, targetAnalysis);
			runtime = tuneTarget(ns, target, network.hosts, cfg, new Map());
			if (!runtime) {
				ns.tprint(`ERROR: no plan fits for ${target}`);
				return;
			}
			if (cfg.requestedTarget === "auto") targetAnalysis = rankTargets(ns, network, cfg, new Map());
			lastObservedFleetCapacity = workerFleetCapacity(network.hosts, cfg);
			tunedFleetCapacity = lastObservedFleetCapacity;
			lastCapacityRetune = Date.now();
			lastTunedLevel = ns.getHackingLevel();
			nextHackLanding = Date.now() + runtime.plan.times.W + cfg.lead + STARTUP_BUFFER_MS;
			consecutiveAllocationFailures = 0;
			maintenance = null;
			continue;
		}

		if (loopNow - lastReservationCleanup >= RESERVATION_CLEANUP_MS) {
			lastReservationCleanup = loopNow;
			cleanupReservations(reservations, Date.now() - 20);
		}

		const horizon = Date.now() + runtime.plan.times.W + Math.max(2_000, runtime.plan.period * 2);
		let schedulingGuard = 0;
		const planningStarted = Date.now();
		while (
			!drain &&
			nextHackLanding <= horizon &&
			schedulingGuard < MAX_BATCHES_PLANNED_PER_TICK &&
			Date.now() - planningStarted < PLANNING_BUDGET_MS &&
			(queue.length === 0 || queue[0].launchAt - Date.now() > PLANNING_LAUNCH_GUARD_MS)
		) {
			schedulingGuard++;
			const id = batchCounter++;
			const result = reserveBatch(
				ns,
				target,
				id,
				nextHackLanding,
				runtime.plan,
				network.hosts,
				cfg,
				reservations,
				running,
				foreignUsedByHost
			);
			if (result) {
				enqueueChunks(queue, result.chunks);
				batches.set(String(id), makeBatchState(id, result.chunks));
				stats.scheduled++;
				consecutiveAllocationFailures = 0;
			} else {
				stats.allocationFails++;
				consecutiveAllocationFailures++;
				stats.maxConsecutiveAllocationFails = Math.max(stats.maxConsecutiveAllocationFails, consecutiveAllocationFailures);
			}
			nextHackLanding += runtime.plan.period;
		}

		{
			const launched = launchDueChunks(ns, queue, target, cfg, batches, stats, running, drain);
			queue = launched.queue;
			drain = launched.drain;
		}

		if (maintenance) continue;

		if (Date.now() - lastUi >= UI_REFRESH_MS) {
			lastUi = Date.now();
			stats.income = stats.income.filter(sample => sample.time >= lastUi - 60_000);
			stats.batchTimes = stats.batchTimes.filter(time => time >= lastUi - 60_000);
			renderDashboard(
				ns,
				target,
				runtime,
				network,
				cfg,
				stats,
				queue,
				running,
				reservations,
				targetAnalysis,
				cloudState,
				drain,
				foreignUsedByHost
			);
		}

		const sleepFor = queue.length ? Math.max(1, Math.min(5, queue[0].launchAt - Date.now())) : 5;
		await ns.sleep(sleepFor);
	}
}

/* The rest of the file remains unchanged from the current optimized daemon implementation. */
