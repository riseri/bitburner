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

	stats.nextHackLanding =
		nextHackLanding;

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

		// Launches are the highest-priority work in the controller. Never do
		// allocator/network/bookkeeping work while a chunk is already due.
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

		// Refresh only one host's non-daemon RAM usage per loop. This keeps the
		// allocator's base-capacity view fresh without issuing dozens of RAM API
		// calls in one latency-sensitive burst.
		foreignUsageCursor = refreshOneForeignUsage(
			ns,
			network.hosts,
			running,
			foreignUsedByHost,
			foreignUsageCursor
		);

		if (
			loopNow -
			lastReap >=
			PROCESS_REAP_MS
		) {
			lastReap =
				loopNow;

			reapRunning(
				ns,
				running
			);
		}

		const fleetStatus =
			fleetPort.peek();

		if (
			fleetStatus &&
			typeof fleetStatus === "object" &&
			fleetStatus.type === "fleet-status" &&
			Number(fleetStatus.generatedAt) >
			lastFleetStatusAt
		) {
			lastFleetStatusAt =
				Number(fleetStatus.generatedAt);

			applyFleetStatus(
				cloudState,
				fleetStatus
			);
		}

		const eventProblem =
			consumeEvents(
				ns,
				port,
				batches,
				stats,
				target,
				runtime,
				cfg
			);

		if (eventProblem) {
			if (
				eventProblem.kind ===
				"drain"
			) {
				const result =
					beginDrain(
						drain,
						eventProblem,
						queue,
						batches,
						stats,
						cfg
					);

				drain =
					result.drain;

				queue =
					result.queue;
			} else if (!maintenance) {
				maintenance =
					eventProblem;
			}
		}

		if (
			!maintenance &&
			!drain &&
			loopNow -
			lastOverdueCheck >=
			OVERDUE_CHECK_MS
		) {
			lastOverdueCheck =
				loopNow;

			const overdue =
				findOverdueBatch(
					batches,
					cfg
				);

			if (overdue) {
				const result =
					beginDrain(
						drain,
						{
							reason:
								overdue,
							kind:
								"drain",
							afterKind:
								"resync",
							bumpGap:
								true,
						},
						queue,
						batches,
						stats,
						cfg
					);

				drain =
					result.drain;

				queue =
					result.queue;
			}
		}

		const now =
			Date.now();

		/*
		 * Cheap fleet snapshot only. Rooting, scp, and cloud economics live in
		 * fleet-manager.js so they can never block a time-critical JIT launch.
		 */
		if (
			!maintenance &&
			now -
			lastNetworkRefresh >=
			NETWORK_REFRESH_MS
		) {
			lastNetworkRefresh =
				now;

			// The background fleet manager owns discovery/rooting/deployment and
			// publishes a ready-to-use worker snapshot. Avoid ns.scan/file checks in
			// the live JIT process entirely.
			const refreshed =
				networkFromFleetStatus(
					fleetStatus,
					minimumWorkerRam
				) ?? network;

			const fleetCapacity =
				workerFleetCapacity(
					refreshed.hosts,
					cfg
				);

			const capacityLost =
				fleetCapacity <
				lastObservedFleetCapacity -
				1;

			const capacityGainRatio =
				tunedFleetCapacity > 0
					? fleetCapacity /
					tunedFleetCapacity
					: Infinity;

			const timingFloor =
				4 * cfg.gap +
				minimumSpacing(cfg);

			const capacityCanHelp =
				runtime.plan.period >
				timingFloor + 5;

			const deferredRetuneReady =
				!drain &&
				capacityCanHelp &&
				capacityGainRatio >=
				CAPACITY_RETUNE_RATIO &&
				now -
				lastCapacityRetune >=
				CAPACITY_RETUNE_COOLDOWN_MS;

			network =
				refreshed;

			syncForeignUsageHosts(
				network.hosts,
				foreignUsedByHost
			);

			if (
				capacityLost &&
				!drain
			) {
				const result =
					beginDrain(
						drain,
						{
							reason:
								`worker fleet RAM decreased ` +
								`${lastObservedFleetCapacity.toFixed(1)}GB -> ` +
								`${fleetCapacity.toFixed(1)}GB`,
							kind:
								"drain",
							afterKind:
								"network",
							resetPeriod:
								true,
						},
						queue,
						batches,
						stats,
						cfg
					);

				drain =
					result.drain;

				queue =
					result.queue;
			} else if (
				deferredRetuneReady
			) {
				const result =
					beginDrain(
						drain,
						{
							reason:
								`deferred RAM-growth retune ` +
								`${tunedFleetCapacity.toFixed(1)}GB -> ` +
								`${fleetCapacity.toFixed(1)}GB ` +
								`(+${((capacityGainRatio - 1) * 100).toFixed(1)}%)`,
							kind:
								"drain",
							afterKind:
								"network",
							resetPeriod:
								true,
						},
						queue,
						batches,
						stats,
						cfg
					);

				drain =
					result.drain;

				queue =
					result.queue;
			}

			lastObservedFleetCapacity =
				fleetCapacity;
		}

		/*
		 * Do not run full target ranking inside the live JIT loop. It is one of
		 * the most CPU-heavy parts of the controller and can delay launches by
		 * seconds. Auto-target analysis is refreshed after the pipeline has been
		 * safely drained for maintenance instead.
		 */

		/*
		 * Retune when hacking level has meaningfully increased, but drain the
		 * current pipeline first so already-landed hacks still get their W/G/W
		 * recovery phases.
		 */
		const hackingLevel =
			ns.getHackingLevel();

		const retuneAt =
			Math.max(
				lastTunedLevel +
				10,

				Math.ceil(
					lastTunedLevel *
					1.10
				)
			);

		if (
			!maintenance &&
			!drain &&
			hackingLevel >=
			retuneAt
		) {
			const result =
				beginDrain(
					drain,
					{
						reason:
							`hacking level ` +
							`${lastTunedLevel} -> ${hackingLevel}`,
						kind:
							"drain",
						afterKind:
							"retune",
						resetPeriod:
							true,
					},
					queue,
					batches,
					stats,
					cfg
				);

			drain =
				result.drain;

			queue =
				result.queue;
		}

		/*
		 * Once every queued/running recovery phase has drained, it is safe to
		 * rebuild. No hack that already landed is abandoned mid-recovery.
		 */
		if (
			drain &&
			queue.length === 0 &&
			running.size === 0
		) {
			maintenance = {
				reason:
					drain.reason,
				kind:
					drain.afterKind,
				resetPeriod:
					drain.resetPeriod,
			};

			drain = null;
		}

		/*
		 * Reconfiguration / recovery.
		 */
		if (maintenance) {
			if (
				maintenance.bumpGap
			) {
				cfg.gap =
					Math.min(
						100,
						cfg.gap + 5
					);
			}

			if (
				maintenance.resetPeriod
			) {
				cfg.periodScale = 1;
			}

			stats.restarts++;

			if (
				maintenance.kind ===
				"resync"
			) {
				stats.resyncs++;
			}

			stats.lastReason =
				maintenance.reason;

			ns.clearLog();

			ns.print(
				"JIT DAEMON :: RECONFIGURE"
			);

			ns.print(
				`Reason  ${maintenance.reason}`
			);

			ns.print(
				`Gap     ${cfg.gap}ms`
			);

			ns.print(
				`Stopping ${running.size} running worker(s)...`
			);

			queue = [];
			reservations = [];

			batches.clear();

			abortWorkers(
				ns,
				network.hosts
			);

			clearRunning(running);

			port.clear();

			await ns.sleep(50);

			network =
				await refreshNetwork(
					ns,
					cfg,
					deployed,
					minimumWorkerRam,
					true
				);

			if (
				maintenance.target
			) {
				target =
					maintenance.target;
			}

			if (
				cfg.requestedTarget ===
				"auto"
			) {
				targetAnalysis =
					rankTargets(
						ns,
						network,
						cfg,
						new Map()
					);

				const best =
					targetAnalysis[0];

				const current =
					targetAnalysis.find(
						entry =>
							entry.name ===
							target
					);

				if (
					!maintenance.target &&
					best &&
					current &&
					best.name !== target &&
					best.score >
					current.score *
					cfg.switchThreshold
				) {
					maintenance.reason +=
						` | better target ${target} -> ${best.name}`;

					target =
						best.name;
				}

				if (
					!target ||
					!ns.hasRootAccess(
						target
					) ||
					ns.getServerRequiredHackingLevel(
						target
					) >
					ns.getHackingLevel()
				) {
					target =
						resolveTarget(
							ns,
							network,
							cfg,
							targetAnalysis
						);
				}
			}

			if (!target) {
				ns.tprint(
					"ERROR: no valid target after reconfiguration."
				);

				return;
			}

			await prepTarget(
				ns,
				target,
				network,
				cfg,
				port,
				stats,
				targetAnalysis
			);

			runtime =
				tuneTarget(
					ns,
					target,
					network.hosts,
					cfg,
					new Map()
				);

			if (!runtime) {
				ns.tprint(
					`ERROR: no plan fits for ${target}`
				);

				return;
			}

			if (
				cfg.requestedTarget ===
				"auto"
			) {
				targetAnalysis =
					rankTargets(
						ns,
						network,
						cfg,
						new Map()
					);
			}

			lastObservedFleetCapacity =
				workerFleetCapacity(
					network.hosts,
					cfg
				);

			tunedFleetCapacity =
				lastObservedFleetCapacity;

			lastCapacityRetune =
				Date.now();

			lastTunedLevel =
				ns.getHackingLevel();

			nextHackLanding =
				Date.now() +
				runtime.plan.times.W +
				cfg.lead +
				STARTUP_BUFFER_MS;

			stats.nextHackLanding =
				nextHackLanding;

			stats.lastHackAt =
				NaN;

			consecutiveAllocationFailures = 0;

			maintenance = null;

			continue;
		}

		/*
		 * Remove finished temporal reservations.
		 */
		if (
			loopNow -
			lastReservationCleanup >=
			RESERVATION_CLEANUP_MS
		) {
			lastReservationCleanup =
				loopNow;

			cleanupReservations(
				reservations,
				Date.now() - 20
			);
		}

		/*
		 * Plan far enough ahead for weaken to start JIT.
		 */
		const horizon =
			Date.now() +
			runtime.plan.times.W +
			Math.max(
				2_000,
				runtime.plan.period *
				2
			);

		let schedulingGuard = 0;
		const planningStarted = Date.now();

		while (
			!drain &&
			nextHackLanding <=
			horizon &&
			schedulingGuard <
			MAX_BATCHES_PLANNED_PER_TICK &&
			Date.now() - planningStarted <
			PLANNING_BUDGET_MS &&
			(
				queue.length === 0 ||
				queue[0].launchAt - Date.now() >
				PLANNING_LAUNCH_GUARD_MS
			)
		) {
			schedulingGuard++;

			const id =
				batchCounter++;

			const result =
				reserveBatch(
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
				enqueueChunks(
					queue,
					result.chunks
				);

				batches.set(
					String(id),
					makeBatchState(
						id,
						result.chunks
					)
				);

				stats.scheduled++;

				/*
				 * A successful reservation proves that the allocator is
				 * making forward progress. Any earlier misses were simply
				 * temporary fragmentation/contention.
				 */
				consecutiveAllocationFailures = 0;
			} else {
				/*
				 * This is intentionally NOT a maintenance event.
				 *
				 * A distributed temporal allocator will occasionally find
				 * that a particular landing slot cannot fit across the
				 * current per-host RAM layout. Skipping that whole batch
				 * period preserves the timing lattice and lets the next
				 * safe slot be tried without destroying a healthy pipeline.
				 */
				stats.allocationFails++;

				consecutiveAllocationFailures++;

				stats.maxConsecutiveAllocationFails =
					Math.max(
						stats.maxConsecutiveAllocationFails,
						consecutiveAllocationFailures
					);
			}

			nextHackLanding +=
				runtime.plan.period;
		}


		/*
		 * Launch again immediately after planning. A newly planned chunk may be
		 * close to its JIT start, so no dashboard/bookkeeping work comes first.
		 */
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

		if (maintenance) {
			continue;
		}

		if (
			Date.now() -
			lastUi >=
			UI_REFRESH_MS
		) {
			lastUi =
				Date.now();

			stats.income =
				stats.income.filter(
					sample =>
						sample.time >=
						lastUi -
						60_000
				);

			stats.batchTimes =
				stats.batchTimes.filter(
					time =>
						time >=
						lastUi -
						60_000
				);

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

		const sleepFor =
			queue.length
				? Math.max(
					1,
					Math.min(
						5,
						queue[0]
							.launchAt -
						Date.now()
					)
				)
				: 5;

		await ns.sleep(
			sleepFor
		);
	}
}

/* =========================================================
	 CLOUD FLEET
	 ========================================================= */

function createCloudState() {
	return {
		enabled: true,
		count: 0,
		limit: 0,
		totalRam: 0,
		minRam: 0,
		maxRam: 0,
		ramLimit: 0,
		purchases: 0,
		upgrades: 0,
		spent: 0,
		reserveFloor: 0,
		lastRun: 0,
		lastAction: "none",
		nextAction: "unknown",
		error: "",
	};
}

function startFleetManager(
	ns,
	cfg
) {
	if (
		!ns.fileExists(
			FLEET_MANAGER,
			HOME
		)
	) {
		return;
	}

	// Exactly one background fleet manager should own rooting, deployment, and
	// cloud purchasing. Restarting the daemon restarts the manager with the same
	// configuration, but none of this work happens in the JIT launch loop.
	ns.scriptKill(
		FLEET_MANAGER,
		HOME
	);

	const pid =
		ns.run(
			FLEET_MANAGER,
			1,
			"--port",
			cfg.fleetPort,
			"--cloud",
			cfg.cloud.enabled,
			"--cloud-reserve",
			cfg.cloud.cashReserve,
			"--cloud-min-ram",
			cfg.cloud.minRam,
			"--cloud-prefix",
			cfg.cloud.prefix
		);

	if (!pid) {
		ns.tprint(
			`WARN: unable to start ${FLEET_MANAGER}`
		);
	}
}

function applyFleetStatus(
	state,
	status
) {
	const cloud =
		status.cloud;

	if (
		!cloud ||
		typeof cloud !==
		"object"
	) {
		return;
	}

	for (
		const key
		of [
			"enabled",
			"count",
			"limit",
			"totalRam",
			"minRam",
			"maxRam",
			"ramLimit",
			"purchases",
			"upgrades",
			"spent",
			"reserveFloor",
			"lastRun",
			"lastAction",
			"nextAction",
			"error",
		]
	) {
		if (
			Object.prototype.hasOwnProperty.call(
				cloud,
				key
			)
		) {
			state[key] =
				cloud[key];
		}
	}
}

function refreshCloudState(
	ns,
	cfg,
	state
) {
	state.enabled =
		cfg.cloud.enabled;

	const names =
		ns.cloud.getServerNames();

	const limit =
		ns.cloud.getServerLimit();

	const ramLimit =
		ns.cloud.getRamLimit();

	const servers =
		names.map(
			name => ({
				name,
				ram:
					ns.getServerMaxRam(
						name
					),
			})
		);

	state.count =
		names.length;

	state.limit =
		limit;

	state.ramLimit =
		ramLimit;

	state.totalRam =
		servers.reduce(
			(sum, server) =>
				sum +
				server.ram,
			0
		);

	state.minRam =
		servers.length
			? Math.min(
				...servers.map(
					server =>
						server.ram
				)
			)
			: 0;

	state.maxRam =
		servers.length
			? Math.max(
				...servers.map(
					server =>
						server.ram
				)
			)
			: 0;

	state.nextAction =
		describeNextCloudAction(
			ns,
			cfg,
			servers,
			limit,
			ramLimit
		);
}

function describeNextCloudAction(
	ns,
	cfg,
	servers,
	limit,
	ramLimit
) {
	if (!cfg.cloud.enabled) {
		return "management disabled";
	}

	if (
		servers.length <
		limit
	) {
		const ram =
			Math.min(
				ramLimit,
				cfg.cloud.minRam
			);

		const cost =
			ns.cloud.getServerCost(
				ram
			);

		return (
			`buy ${formatRam(ram)} ` +
			`for ${cash(cost)}`
		);
	}

	const weakest =
		servers
			.filter(
				server =>
					server.ram <
					ramLimit
			)
			.sort(
				(a, b) =>
					(
						a.ram -
						b.ram
					) ||
					a.name.localeCompare(
						b.name
					)
			)[0];

	if (!weakest) {
		return "fleet maxed";
	}

	const targetRam =
		Math.min(
			ramLimit,
			weakest.ram * 2
		);

	const cost =
		ns.cloud.getServerUpgradeCost(
			weakest.name,
			targetRam
		);

	return (
		`upgrade ${weakest.name} -> ` +
		`${formatRam(targetRam)} ` +
		`for ${cash(cost)}`
	);
}


/* =========================================================
	 NETWORK / ROOTING
	 ========================================================= */

async function refreshNetwork(
	ns,
	cfg,
	deployed,
	minimumWorkerRam,
	manage = false
) {
	const servers =
		scanNetwork(ns);

	for (
		const cloudServer
		of ns.cloud.getServerNames()
	) {
		if (
			!servers.includes(
				cloudServer
			)
		) {
			servers.push(
				cloudServer
			);
		}
	}

	if (manage) {
		for (
			const server
			of servers
		) {
			tryRoot(
				ns,
				server
			);
		}
	}

	const hosts = [];

	let rooted = 0;

	for (
		const name
		of servers
	) {
		if (
			!ns.hasRootAccess(
				name
			)
		) {
			continue;
		}

		rooted++;

		const maxRam =
			ns.getServerMaxRam(
				name
			);

		if (
			maxRam <
			minimumWorkerRam
		) {
			continue;
		}

		if (name !== HOME) {
			if (
				manage &&
				!deployed.has(
					name
				)
			) {
				const copied =
					await ns.scp(
						WORKERS,
						name,
						HOME
					);

				if (!copied) {
					continue;
				}

				deployed.add(
					name
				);
			} else if (
				!manage &&
				!ns.fileExists(
					HACK,
					name
				)
			) {
				// The background fleet manager has not finished deploying this host.
				// Skip it for this snapshot instead of risking an exec failure.
				continue;
			}
		}

		let cores = 1;

		try {
			cores =
				Math.max(
					1,
					Number(
						ns.getServer(
							name
						).cpuCores ??
						1
					)
				);
		} catch {
			cores = 1;
		}

		hosts.push({
			name,
			maxRam,
			cores,
		});
	}

	hosts.sort(
		(a, b) =>
			b.maxRam -
			a.maxRam
	);

	return {
		servers,
		hosts,
		rooted,
	};
}

function scanNetwork(ns) {
	const seen =
		new Set([HOME]);

	const queue =
		[HOME];

	for (
		let i = 0;
		i < queue.length;
		i++
	) {
		const host =
			queue[i];

		for (
			const next
			of ns.scan(host)
		) {
			if (
				seen.has(next)
			) {
				continue;
			}

			seen.add(next);

			queue.push(next);
		}
	}

	return [...seen];
}

function tryRoot(
	ns,
	host
) {
	if (
		host === HOME ||
		ns.hasRootAccess(host)
	) {
		return;
	}

	const attempts = [
		[
			"BruteSSH.exe",
			() =>
				ns.brutessh(
					host
				),
		],

		[
			"FTPCrack.exe",
			() =>
				ns.ftpcrack(
					host
				),
		],

		[
			"relaySMTP.exe",
			() =>
				ns.relaysmtp(
					host
				),
		],
		[
			"HTTPWorm.exe",
			() =>
				ns.httpworm(
					host
				),
		],

		[
			"SQLInject.exe",
			() =>
				ns.sqlinject(
					host
				),
		],
	];

	for (
		const [
			file,
			action,
		]
		of attempts
	) {
		if (
			!ns.fileExists(
				file,
				HOME
			)
		) {
			continue;
		}

		try {
			action();
		} catch {
			// Ignore.
		}
	}

	try {
		ns.nuke(host);
	} catch {
		// Not enough ports yet.
	}
}

function killWorkerScripts(
	ns,
	hosts
) {
	for (
		const host
		of hosts
	) {
		for (
			const script
			of WORKERS
		) {
			ns.scriptKill(
				script,
				host.name
			);
		}
	}
}

function abortWorkers(
	ns,
	hosts
) {
	killWorkerScripts(
		ns,
		hosts
	);
}

/* =========================================================
	 TARGET SELECTION
	 ========================================================= */

function resolveTarget(
	ns,
	network,
	cfg,
	ranked = []
) {
	if (
		cfg.requestedTarget !==
		"auto"
	) {
		const target =
			cfg.requestedTarget;

		if (
			!ns.hasRootAccess(
				target
			) ||
			ns.getServerMaxMoney(
				target
			) <= 0 ||
			ns.getServerRequiredHackingLevel(
				target
			) >
			ns.getHackingLevel()
		) {
			ns.tprint(
				`ERROR: invalid target ${target}`
			);

			return null;
		}

		return target;
	}

	if (!ranked.length) {
		return null;
	}

	return ranked[0].name;
}

function rankTargets(
	ns,
	network,
	cfg,
	running = new Map()
) {
	const results = [];

	for (
		const target
		of network.servers
	) {
		if (
			target === HOME ||
			!ns.hasRootAccess(
				target
			) ||
			ns.getServerMaxMoney(
				target
			) <= 0 ||
			ns.getServerRequiredHackingLevel(
				target
			) >
			ns.getHackingLevel()
		) {
			continue;
		}

		const model =
			createPreppedModel(
				ns,
				target
			);

		if (!model) {
			continue;
		}

		const runtime =
			tuneTarget(
				ns,
				target,
				network.hosts,
				cfg,
				running,
				model
			);

		if (!runtime) {
			continue;
		}

		const prepMs =
			estimatePrepTime(
				ns,
				target,
				network.hosts,
				cfg,
				runtime
			);

		const amortization =
			TARGET_HORIZON_MS /
			(
				TARGET_HORIZON_MS +
				prepMs
			);

		const steady =
			runtime.plan.expected;

		const score =
			steady *
			amortization;

		results.push({
			name:
				target,

			score,

			steady,

			prepMs,

			steal:
				runtime.plan.steal,

			period:
				runtime.plan.period,

			chance:
				runtime.plan.chance,

			runtime,
		});
	}

	return results.sort(
		(a, b) =>
			b.score -
			a.score
	);
}

function createPreppedModel(
	ns,
	target
) {
	const currentSecurity =
		ns.getServerSecurityLevel(
			target
		);

	const minSecurity =
		ns.getServerMinSecurityLevel(
			target
		);

	const required =
		ns.getServerRequiredHackingLevel(
			target
		);

	const maxMoney =
		ns.getServerMaxMoney(
			target
		);

	if (
		currentSecurity >= 100 ||
		minSecurity >= 100 ||
		maxMoney <= 0
	) {
		return null;
	}

	const difficultyScale =
		(
			100 -
			minSecurity
		) /
		(
			100 -
			currentSecurity
		);

	const hackPercent =
		Math.min(
			1,
			Math.max(
				0,
				ns.hackAnalyze(
					target
				) *
				difficultyScale
			)
		);

	let chance =
		ns.hackAnalyzeChance(
			target
		);

	if (
		chance < 1
	) {
		chance =
			Math.min(
				1,
				Math.max(
					0,
					chance *
					difficultyScale
				)
			);
	}

	const currentTimeFactor =
		2.5 *
		required *
		currentSecurity +
		500;

	const minimumTimeFactor =
		2.5 *
		required *
		minSecurity +
		500;

	const hackTime =
		ns.getHackTime(
			target
		) *
		(
			minimumTimeFactor /
			currentTimeFactor
		);

	const growTime =
		hackTime *
		3.2;

	const weakenTime =
		hackTime *
		4;

	const currentGrowthLog =
		growthSecurityLog(
			currentSecurity
		);

	const minGrowthLog =
		growthSecurityLog(
			minSecurity
		);

	const growthThreadScale =
		currentGrowthLog /
		minGrowthLog;

	return {
		maxMoney,
		minSecurity,
		hackPercent,
		chance,

		times: {
			H:
				hackTime,

			G:
				growTime,

			W:
				weakenTime,
		},

		growthAnalyze(multiplier) {
			if (
				multiplier <= 1
			) {
				return 0;
			}

			return (
				ns.growthAnalyze(
					target,
					multiplier,
					1
				) *
				growthThreadScale
			);
		},
	};
}

function growthSecurityLog(
	security
) {
	return Math.min(
		Math.log1p(
			SERVER_BASE_GROWTH_INCR /
			Math.max(
				1,
				security
			)
		),

		SERVER_MAX_GROWTH_LOG
	);
}

function estimatePrepTime(
	ns,
	target,
	hosts,
	cfg,
	runtime
) {
	const capacity =
		runtime.capacity;

	if (
		capacity <= 0
	) {
		return Infinity;
	}

	const currentSecurity =
		ns.getServerSecurityLevel(
			target
		);

	const minSecurity =
		ns.getServerMinSecurityLevel(
			target
		);

	const money =
		ns.getServerMoneyAvailable(
			target
		);

	const maxMoney =
		ns.getServerMaxMoney(
			target
		);

	const model =
		createPreppedModel(
			ns,
			target
		);

	if (!model) {
		return Infinity;
	}

	const averageBonus =
		Math.max(
			1,
			runtime.averageCoreBonus
		);

	const weakenEffect =
		ns.weakenAnalyze(
			1,
			1
		) *
		averageBonus;

	const maxWeakenThreads =
		Math.max(
			1,
			Math.floor(
				capacity /
				cfg.ram.W
			)
		);

	const securityNeeded =
		Math.max(
			0,
			currentSecurity -
			minSecurity
		);

	const weakenThreadsNeeded =
		Math.ceil(
			securityNeeded /
			weakenEffect
		);

	const weakenWaves =
		weakenThreadsNeeded >
			0
			? Math.ceil(
				weakenThreadsNeeded /
				maxWeakenThreads
			)
			: 0;

	let securityPrepMs = 0;

	if (
		weakenWaves > 0
	) {
		securityPrepMs +=
			ns.getWeakenTime(
				target
			);

		if (
			weakenWaves > 1
		) {
			securityPrepMs +=
				(
					weakenWaves -
					1
				) *
				model.times.W;
		}
	}

	let growPrepMs = 0;

	if (
		money <
		maxMoney *
		0.9999
	) {
		const multiplier =
			maxMoney /
			Math.max(
				1,
				money
			);

		const effectiveGrowThreads =
			Math.max(
				1,
				Math.ceil(
					model.growthAnalyze(
						multiplier
					)
				)
			);

		const actualGrowThreads =
			effectiveGrowThreads /
			averageBonus;

		const growSecurityPerThread =
			ns.growthAnalyzeSecurity(
				1
			);

		const weakenPerGrowThread =
			growSecurityPerThread /
			weakenEffect;

		const pairedRamPerGrowThread =
			cfg.ram.G +
			weakenPerGrowThread *
			cfg.ram.W;

		const growThreadsPerWave =
			Math.max(
				1,
				Math.floor(
					capacity /
					pairedRamPerGrowThread
				)
			);

		const growWaves =
			Math.ceil(
				actualGrowThreads /
				growThreadsPerWave
			);

		growPrepMs =
			growWaves *
			(
				model.times.W +
				cfg.gap
			);
	}

	return (
		securityPrepMs +
		growPrepMs
	);
}

/* =========================================================
	 TARGET PREP
	 ========================================================= */

async function prepTarget(
	ns,
	target,
	network,
	cfg,
	port,
	stats,
	targetAnalysis = []
) {
	port.clear();

	let wave = 0;

	while (true) {
		const minSec =
			ns.getServerMinSecurityLevel(
				target
			);

		const sec =
			ns.getServerSecurityLevel(
				target
			);

		const maxMoney =
			ns.getServerMaxMoney(
				target
			);

		const money =
			ns.getServerMoneyAvailable(
				target
			);

		if (
			sec <=
			minSec +
			0.001 &&
			money >=
			maxMoney *
			0.9999
		) {
			renderPrep(
				ns,
				target,
				network,
				cfg,
				wave,
				"READY",
				[],
				0,
				0,
				0,
				0,
				1,
				targetAnalysis
			);

			await ns.sleep(
				100
			);

			port.clear();

			return;
		}

		wave++;

		/*
		 * Security first.
		 */
		if (
			sec >
			minSec +
			0.001
		) {
			const need =
				sec -
				minSec;

			const duration =
				ns.getWeakenTime(
					target
				);

			const landAt =
				Date.now() +
				duration +
				cfg.lead +
				PREP_BUFFER_MS;

			const reservations =
				[];

			const result =
				allocateWeaken(
					ns,
					network.hosts,
					cfg,
					new Map(),
					reservations,

					need,

					landAt,
					duration,

					"PREP-W",
					`prep-w-${Date.now()}`,

					true
				);

			if (
				!result ||
				result.chunks.length ===
				0
			) {
				await ns.sleep(
					100
				);

				continue;
			}

			await launchPrepWave(
				ns,
				target,
				network,
				cfg,
				port,
				wave,
				"WEAKEN",
				result.chunks,
				0,
				0,
				0,
				1,
				targetAnalysis
			);

			port.clear();

			continue;
		}

		/*
		 * Money prep.
		 */
		const multiplier =
			maxMoney /
			Math.max(
				1,
				money
			);

		let requiredEffective =
			ns.growthAnalyze(
				target,
				multiplier,
				1
			);

		if (
			!Number.isFinite(
				requiredEffective
			)
		) {
			requiredEffective =
				Number.MAX_SAFE_INTEGER;
		}

		requiredEffective =
			Math.max(
				1,
				Math.ceil(
					requiredEffective
				)
			);

		const plan =
			buildPrepGrowWave(
				ns,
				target,
				network.hosts,
				cfg,
				requiredEffective
			);

		if (!plan) {
			await ns.sleep(
				100
			);

			continue;
		}

		const wavesLeft =
			Math.max(
				1,
				Math.ceil(
					requiredEffective /
					plan.effectiveGrow
				)
			);

		const growth2x =
			ns.growthAnalyze(
				target,
				2,
				1
			);

		const projectedMultiplier =
			Number.isFinite(
				growth2x
			) &&
				growth2x > 0
				? Math.exp(
					Math.log(2) *
					plan.effectiveGrow /
					growth2x
				)
				: 1;

		await launchPrepWave(
			ns,
			target,
			network,
			cfg,
			port,
			wave,
			"GROW + WEAKEN",
			plan.chunks,
			requiredEffective,
			plan.effectiveGrow,
			wavesLeft,
			projectedMultiplier,
			targetAnalysis
		);

		port.clear();
	}
}

function buildPrepGrowWave(
	ns,
	target,
	hosts,
	cfg,
	requiredEffective
) {
	const gTime =
		ns.getGrowTime(
			target
		);

	const wTime =
		ns.getWeakenTime(
			target
		);

	const wLand =
		Date.now() +
		wTime +
		cfg.lead +
		PREP_BUFFER_MS +
		cfg.gap;

	const gLand =
		wLand -
		cfg.gap;

	let low = 1;

	let high =
		Math.ceil(
			requiredEffective
		);

	let best = null;

	while (
		low <= high
	) {
		const test =
			Math.floor(
				(low + high) /
				2
			);

		const reservations =
			[];

		const running =
			new Map();

		const id =
			`prep-gw-${Date.now()}-${test}`;

		const grow =
			allocateGrow(
				ns,
				hosts,
				cfg,
				running,
				reservations,

				test,

				gLand,
				gTime,

				"PREP-G",
				id
			);

		if (
			!grow ||
			!grow.complete
		) {
			high =
				test - 1;

			continue;
		}

		const security =
			ns.growthAnalyzeSecurity(
				grow.actualThreads
			);

		const weaken =
			allocateWeaken(
				ns,
				hosts,
				cfg,
				running,
				reservations,

				security,

				wLand,
				wTime,

				"PREP-W",
				id,

				false
			);

		if (
			!weaken ||
			!weaken.complete
		) {
			high =
				test - 1;

			continue;
		}

		best = {
			effectiveGrow:
				test,

			chunks: [
				...grow.chunks,
				...weaken.chunks,
			],
		};

		low =
			test + 1;
	}

	return best;
}

async function launchPrepWave(
	ns,
	target,
	network,
	cfg,
	port,
	wave,
	stage,
	chunks,
	requiredEffective = 0,
	waveEffective = 0,
	wavesLeft = 0,
	projectedMultiplier = 1,
	targetAnalysis = []
) {
	const pending =
		[...chunks].sort(
			(a, b) =>
				a.launchAt -
				b.launchAt
		);

	const running =
		new Map();

	const end =
		Math.max(
			...chunks.map(
				chunk =>
					chunk.landAt
			)
		);

	let lastUi = 0;

	while (
		pending.length ||
		running.size
	) {
		reapRunning(
			ns,
			running
		);

		while (
			!port.empty()
		) {
			port.read();
		}

		const now =
			Date.now();

		while (
			pending.length &&
			pending[0].launchAt <=
			now
		) {
			const chunk =
				pending.shift();

			const pid =
				ns.exec(
					chunk.script,
					chunk.host,
					chunk.threads,

					target,
					chunk.landAt,
					chunk.batchId,
					cfg.port,
					chunk.phase,
					chunk.chunkId,
					250
				);

			if (!pid) {
				for (
					const runningPid
					of running.keys()
				) {
					ns.kill(
						runningPid
					);
				}

				throw new Error(
					`Prep exec failed: ` +
					`${chunk.phase} on ${chunk.host}`
				);
			}

			trackRunning(
				running,
				pid,
				chunk
			);
		}

		if (
			Date.now() -
			lastUi >
			250
		) {
			lastUi =
				Date.now();

			renderPrep(
				ns,
				target,
				network,
				cfg,
				wave,
				stage,
				chunks,
				end,
				requiredEffective,
				waveEffective,
				wavesLeft,
				projectedMultiplier,
				targetAnalysis
			);
		}

		if (
			pending.length ||
			running.size
		) {
			await ns.sleep(
				25
			);
		}
	}
}

/* =========================================================
	 BATCH TUNER
	 ========================================================= */

function tuneTarget(
	ns,
	target,
	hosts,
	cfg,
	running,
	model = null
) {
	const profile =
		poolProfile(
			ns,
			hosts,
			cfg,
			running
		);

	if (
		profile.capacity <= 0
	) {
		return null;
	}

	const hackPerThread =
		model
			? model.hackPercent
			: ns.hackAnalyze(
				target
			);

	if (
		!Number.isFinite(
			hackPerThread
		) ||
		hackPerThread <= 0
	) {
		return null;
	}

	const maxMoney =
		model
			? model.maxMoney
			: ns.getServerMaxMoney(
				target
			);

	const chance =
		model
			? model.chance
			: ns.hackAnalyzeChance(
				target
			);

	const times =
		model
			? model.times
			: {
				H:
					ns.getHackTime(
						target
					),

				G:
					ns.getGrowTime(
						target
					),

				W:
					ns.getWeakenTime(
						target
					),
			};

	const baseWeak =
		ns.weakenAnalyze(
			1,
			1
		);

	const averageBonus =
		Math.max(
			1,
			profile.averageCoreBonus
		);

	const averageWeak =
		baseWeak *
		averageBonus;

	let best = null;

	let lastHackThreads =
		-1;

	for (
		let requested =
			cfg.minSteal;

		requested <=
		cfg.maxSteal +
		1e-9;

		requested +=
		0.005
	) {
		const H =
			Math.max(
				1,
				Math.floor(
					requested /
					hackPerThread
				)
			);

		if (
			H ===
			lastHackThreads
		) {
			continue;
		}

		lastHackThreads =
			H;

		const steal =
			H *
			hackPerThread;

		if (
			steal <= 0 ||
			steal >= 0.90
		) {
			continue;
		}

		const multiplier =
			1 /
			(
				1 -
				steal
			);

		const gEffective =
			Math.max(
				1,
				Math.ceil(
					model
						? model.growthAnalyze(
							multiplier
						)
						: ns.growthAnalyze(
							target,
							multiplier,
							1
						)
				)
			);

		const estimatedG =
			Math.max(
				1,
				Math.ceil(
					gEffective /
					averageBonus
				)
			);

		const hackSecurity =
			ns.hackAnalyzeSecurity(
				H
			);

		const estimatedW1 =
			Math.max(
				1,
				Math.ceil(
					hackSecurity /
					averageWeak
				)
			);

		const growSecurity =
			ns.growthAnalyzeSecurity(
				estimatedG
			);

		const estimatedW2 =
			Math.max(
				1,
				Math.ceil(
					growSecurity /
					averageWeak
				)
			);

		const ramTime =
			H *
			cfg.ram.H *
			(
				times.H +
				cfg.lead +
				RELEASE_MS
			) +

			estimatedG *
			cfg.ram.G *
			(
				times.G +
				cfg.lead +
				RELEASE_MS
			) +

			estimatedW1 *
			cfg.ram.W *
			(
				times.W +
				cfg.lead +
				RELEASE_MS
			) +

			estimatedW2 *
			cfg.ram.W *
			(
				times.W +
				cfg.lead +
				RELEASE_MS
			);

		const ramLimitedPeriod =
			ramTime /
			profile.capacity;

		const minimumPeriod =
			Math.max(
				4 *
				cfg.gap +
				minimumSpacing(
					cfg
				),

				ramLimitedPeriod *
				cfg.periodScale
			);

		const period =
			chooseSafePeriod(
				times,
				cfg.gap,
				minimumPeriod
			);

		if (!period) {
			continue;
		}

		const batchRate =
			1000 /
			period;

		const expected =
			maxMoney *
			steal *
			chance *
			batchRate;

		if (
			!best ||
			expected >
			best.expected
		) {
			best = {
				H,

				gEffective,

				estimatedG,

				estimatedW1,

				estimatedW2,

				hackSecurity,

				steal,

				chance,

				times,

				period,

				expected,

				batchRate,

				ramTime,
			};
		}
	}

	if (!best) {
		return null;
	}

	return {
		capacity:
			profile.capacity,

		averageCoreBonus:
			profile.averageCoreBonus,

		plan:
			best,
	};
}

function chooseSafePeriod(
	times,
	gap,
	minimum
) {
	const margin =
		Math.max(
			3,
			Math.min(
				8,
				gap *
				0.20
			)
		);

	const start =
		Math.max(
			Math.ceil(
				minimum
			),

			Math.ceil(
				4 *
				gap +
				margin
			)
		);

	const limit =
		start +
		Math.max(
			10_000,
			gap *
			100
		);

	for (
		let period =
			start;

		period <=
		limit;

		period++
	) {
		const phases = [
			mod(
				-times.H,
				period
			),

			mod(
				gap -
				times.W,
				period
			),

			mod(
				2 *
				gap -
				times.G,
				period
			),

			mod(
				3 *
				gap -
				times.W,
				period
			),
		];

		const safe =
			phases.every(
				phase =>
					!isDirtyPhase(
						phase,
						period,
						gap,
						margin
					)
			);

		if (safe) {
			return period;
		}
	}

	return null;
}

function isDirtyPhase(
	phase,
	period,
	gap,
	margin
) {
	if (
		phase <=
		gap +
		margin
	) {
		return true;
	}

	if (
		phase >=
		period -
		margin
	) {
		return true;
	}

	if (
		phase >=
		2 *
		gap -
		margin &&
		phase <=
		3 *
		gap +
		margin
	) {
		return true;
	}

	return false;
}

/* =========================================================
	 DISTRIBUTED BATCH RESERVATION
	 ========================================================= */

function reserveBatch(
	ns,
	target,
	batchId,
	hackLanding,
	plan,
	hosts,
	cfg,
	reservations,
	running,
	foreignUsedByHost = null
) {
	const snapshot =
		reservations.length;

	const chunks = [];

	const HLand =
		hackLanding;

	const W1Land =
		hackLanding +
		cfg.gap;

	const GLand =
		hackLanding +
		2 *
		cfg.gap;

	const W2Land =
		hackLanding +
		3 *
		cfg.gap;

	/*
	 * Grow usually requires the most RAM,
	 * so place it first.
	 */
	const grow =
		allocateGrow(
			ns,
			hosts,
			cfg,
			running,
			reservations,

			plan.gEffective,

			GLand,
			plan.times.G,

			"G",
			batchId,
			foreignUsedByHost
		);

	if (
		!grow ||
		!grow.complete
	) {
		rollbackReservations(
			reservations,
			snapshot
		);

		return null;
	}

	chunks.push(
		...grow.chunks
	);

	const W1 =
		allocateWeaken(
			ns,
			hosts,
			cfg,
			running,
			reservations,

			plan.hackSecurity,

			W1Land,
			plan.times.W,

			"W1",
			batchId,

			false,
			foreignUsedByHost
		);

	if (
		!W1 ||
		!W1.complete
	) {
		rollbackReservations(
			reservations,
			snapshot
		);

		return null;
	}

	chunks.push(
		...W1.chunks
	);

	const hack =
		allocateHack(
			ns,
			hosts,
			cfg,
			running,
			reservations,

			plan.H,

			HLand,
			plan.times.H,

			"H",
			batchId,
			foreignUsedByHost
		);

	if (
		!hack ||
		!hack.complete
	) {
		rollbackReservations(
			reservations,
			snapshot
		);

		return null;
	}

	chunks.push(
		...hack.chunks
	);

	/*
	 * Security increase depends on actual grow threads,
	 * not one-core-equivalent grow units.
	 */
	const growSecurity =
		ns.growthAnalyzeSecurity(
			grow.actualThreads
		);

	const W2 =
		allocateWeaken(
			ns,
			hosts,
			cfg,
			running,
			reservations,

			growSecurity,

			W2Land,
			plan.times.W,

			"W2",
			batchId,

			false,
			foreignUsedByHost
		);

	if (
		!W2 ||
		!W2.complete
	) {
		rollbackReservations(
			reservations,
			snapshot
		);

		return null;
	}

	chunks.push(
		...W2.chunks
	);

	return {
		chunks,
	};
}

/* =========================================================
	 HOST ALLOCATORS
	 ========================================================= */

function allocateHack(
	ns,
	hosts,
	cfg,
	running,
	reservations,
	neededThreads,
	landAt,
	duration,
	phase,
	batchId,
	foreignUsedByHost = null
) {
	let remaining =
		neededThreads;

	const chunks = [];

	const candidates =
		hosts
			.map(
				host => ({
					host,

					capacity:
						Math.floor(
							availableRam(
								ns,
								host,
								cfg,
								running,
								reservations,

								landAt -
								duration -
								cfg.lead,

								landAt +
								RELEASE_MS,
								foreignUsedByHost
							) /
							cfg.ram.H
						),
				})
			)
			.filter(
				item =>
					item.capacity >
					0
			);

	/*
	 * Prefer fitting all hack threads on one host.
	 */
	const whole =
		candidates
			.filter(
				item =>
					item.capacity >=
					remaining
			)
			.sort(
				(a, b) =>
					(
						a.host.cores -
						b.host.cores
					) ||
					(
						a.capacity -
						remaining -
						(
							b.capacity -
							remaining
						)
					)
			)[0];

	if (whole) {
		const chunk =
			createChunk(
				whole.host,
				HACK,
				phase,
				neededThreads,
				landAt,
				duration,
				cfg.ram.H,
				batchId,
				cfg
			);

		reserveChunk(
			reservations,
			chunk
		);

		chunks.push(
			chunk
		);

		return {
			chunks,

			complete:
				true,

			actualThreads:
				neededThreads,
		};
	}

	/*
	 * Save high-core hosts for G/W when possible.
	 */
	candidates.sort(
		(a, b) =>
			(
				a.host.cores -
				b.host.cores
			) ||
			(
				b.capacity -
				a.capacity
			)
	);

	for (
		const item
		of candidates
	) {
		if (
			remaining <= 0
		) {
			break;
		}

		const threads =
			Math.min(
				remaining,
				item.capacity
			);

		if (
			threads <= 0
		) {
			continue;
		}

		const chunk =
			createChunk(
				item.host,
				HACK,
				phase,
				threads,
				landAt,
				duration,
				cfg.ram.H,
				batchId,
				cfg
			);

		reserveChunk(
			reservations,
			chunk
		);

		chunks.push(
			chunk
		);

		remaining -=
			threads;
	}

	return {
		chunks,

		complete:
			remaining <= 0,

		actualThreads:
			neededThreads -
			Math.max(
				0,
				remaining
			),
	};
}

function allocateGrow(
	ns,
	hosts,
	cfg,
	running,
	reservations,
	effectiveThreads,
	landAt,
	duration,
	phase,
	batchId,
	foreignUsedByHost = null
) {
	let remaining =
		effectiveThreads;

	const chunks = [];

	let actualThreads = 0;

	const candidates =
		hosts
			.map(
				host => {
					const start =
						landAt -
						duration -
						cfg.lead;

					const end =
						landAt +
						RELEASE_MS;

					const capacity =
						Math.floor(
							availableRam(
								ns,
								host,
								cfg,
								running,
								reservations,
								start,
								end,
								foreignUsedByHost
							) /
							cfg.ram.G
						);

					return {
						host,

						capacity,

						bonus:
							coreBonus(
								host.cores
							),
					};
				}
			)
			.filter(
				item =>
					item.capacity >
					0
			)
			.sort(
				(a, b) =>
					(
						b.bonus -
						a.bonus
					) ||
					(
						b.capacity -
						a.capacity
					)
			);

	for (
		const item
		of candidates
	) {
		if (
			remaining <=
			1e-9
		) {
			break;
		}

		const threads =
			Math.min(
				item.capacity,

				Math.max(
					1,
					Math.ceil(
						remaining /
						item.bonus
					)
				)
			);

		if (
			threads <= 0
		) {
			continue;
		}

		const chunk =
			createChunk(
				item.host,
				GROW,
				phase,
				threads,
				landAt,
				duration,
				cfg.ram.G,
				batchId,
				cfg
			);

		reserveChunk(
			reservations,
			chunk
		);

		chunks.push(
			chunk
		);

		actualThreads +=
			threads;

		remaining -=
			threads *
			item.bonus;
	}

	return {
		chunks,

		complete:
			remaining <=
			1e-9,

		actualThreads,

		delivered:
			effectiveThreads -
			Math.max(
				0,
				remaining
			),
	};
}

function allocateWeaken(
	ns,
	hosts,
	cfg,
	running,
	reservations,
	securityNeeded,
	landAt,
	duration,
	phase,
	batchId,
	allowPartial,
	foreignUsedByHost = null
) {
	let remaining =
		Math.max(
			0,
			securityNeeded
		);

	const chunks = [];

	let delivered = 0;

	const candidates =
		hosts
			.map(
				host => {
					const start =
						landAt -
						duration -
						cfg.lead;

					const end =
						landAt +
						RELEASE_MS;

					return {
						host,

						capacity:
							Math.floor(
								availableRam(
									ns,
									host,
									cfg,
									running,
									reservations,
									start,
									end,
									foreignUsedByHost
								) /
								cfg.ram.W
							),

						effect:
							ns.weakenAnalyze(
								1,
								host.cores
							),
					};
				}
			)
			.filter(
				item =>
					item.capacity >
					0
			)
			.sort(
				(a, b) =>
					(
						b.effect -
						a.effect
					) ||
					(
						b.capacity -
						a.capacity
					)
			);

	for (
		const item
		of candidates
	) {
		if (
			remaining <=
			1e-9
		) {
			break;
		}

		const threads =
			Math.min(
				item.capacity,

				Math.max(
					1,
					Math.ceil(
						remaining /
						item.effect
					)
				)
			);

		if (
			threads <= 0
		) {
			continue;
		}

		const chunk =
			createChunk(
				item.host,
				WEAKEN,
				phase,
				threads,
				landAt,
				duration,
				cfg.ram.W,
				batchId,
				cfg
			);

		reserveChunk(
			reservations,
			chunk
		);

		chunks.push(
			chunk
		);

		const effect =
			threads *
			item.effect;

		delivered +=
			effect;

		remaining -=
			effect;
	}

	const complete =
		remaining <=
		1e-9;

	if (
		!complete &&
		!allowPartial
	) {
		return {
			chunks,

			complete:
				false,

			delivered,
		};
	}

	return {
		chunks,
		complete,
		delivered,
	};
}

function createChunk(
	host,
	script,
	phase,
	threads,
	landAt,
	duration,
	ramPerThread,
	batchId,
	cfg
) {
	return {
		host:
			host.name,

		cores:
			host.cores,

		script,
		phase,
		threads,

		landAt,

		launchAt:
			landAt -
			duration -
			cfg.lead,

		ram:
			threads *
			ramPerThread,

		batchId:
			String(
				batchId
			),

		chunkId:
			`${batchId}-${phase}-${host.name}`,
	};
}

const reservationIndexes = new WeakMap();
const runningRamIndexes = new WeakMap();

function reservationIndex(reservations) {
	let index =
		reservationIndexes.get(
			reservations
		);

	if (!index) {
		index = new Map();
		reservationIndexes.set(
			reservations,
			index
		);
	}

	return index;
}

function rebuildReservationIndex(reservations) {
	const index = new Map();

	for (const reservation of reservations) {
		let hostReservations =
			index.get(
				reservation.host
			);

		if (!hostReservations) {
			hostReservations = [];
			index.set(
				reservation.host,
				hostReservations
			);
		}

		hostReservations.push(
			reservation
		);
	}

	reservationIndexes.set(
		reservations,
		index
	);

	return index;
}

function reserveChunk(
	reservations,
	chunk
) {
	const reservation = {
		host:
			chunk.host,
		start:
			chunk.launchAt,
		end:
			chunk.landAt +
			RELEASE_MS,
		ram:
			chunk.ram,
		batchId:
			chunk.batchId,
		phase:
			chunk.phase,
	};

	reservations.push(
		reservation
	);

	const index =
		reservationIndex(
			reservations
		);

	let hostReservations =
		index.get(
			reservation.host
		);

	if (!hostReservations) {
		hostReservations = [];
		index.set(
			reservation.host,
			hostReservations
		);
	}

	hostReservations.push(
		reservation
	);
}

function rollbackReservations(
	reservations,
	snapshot
) {
	if (
		reservations.length <=
		snapshot
	) {
		return;
	}

	reservations.length =
		snapshot;

	rebuildReservationIndex(
		reservations
	);
}

function cleanupReservations(
	reservations,
	cutoff
) {
	let write = 0;

	for (
		let read = 0;
		read < reservations.length;
		read++
	) {
		const reservation =
			reservations[read];

		if (
			reservation.end <=
			cutoff
		) {
			continue;
		}

		reservations[write++] =
			reservation;
	}

	reservations.length =
		write;

	rebuildReservationIndex(
		reservations
	);
}

function runningRamIndex(running) {
	let index =
		runningRamIndexes.get(
			running
		);

	if (!index) {
		index = new Map();
		runningRamIndexes.set(
			running,
			index
		);
	}

	return index;
}

function trackRunning(
	running,
	pid,
	chunk
) {
	running.set(
		pid,
		chunk
	);

	const index =
		runningRamIndex(
			running
		);

	index.set(
		chunk.host,
		(index.get(chunk.host) ?? 0) +
		chunk.ram
	);
}

function untrackRunning(
	running,
	pid,
	chunk
) {
	running.delete(
		pid
	);

	const index =
		runningRamIndex(
			running
		);

	const next =
		Math.max(
			0,
			(index.get(chunk.host) ?? 0) -
			chunk.ram
		);

	if (next <= 1e-9) {
		index.delete(
			chunk.host
		);
	} else {
		index.set(
			chunk.host,
			next
		);
	}
}

function clearRunning(running) {
	running.clear();
	runningRamIndex(
		running
	).clear();
}

function runningRamForHost(
	running,
	host
) {
	return (
		runningRamIndex(
			running
		).get(host) ??
		0
	);
}

function totalRunningRam(running) {
	let total = 0;

	for (
		const ram
		of runningRamIndex(
			running
		).values()
	) {
		total += ram;
	}

	return total;
}

/* =========================================================
	 TEMPORAL RAM
	 ========================================================= */

function availableRam(
	ns,
	host,
	cfg,
	running,
	reservations,
	start,
	end,
	foreignUsedByHost = null
) {
	const base =
		baseHostCapacity(
			ns,
			host,
			cfg,
			running,
			foreignUsedByHost
		);

	const hostReservations =
		reservationIndex(
			reservations
		).get(host.name) ??
		[];

	const peak =
		peakReservation(
			hostReservations,
			start,
			end
		);

	return Math.max(
		0,
		base -
		peak
	);
}

function baseHostCapacity(
	ns,
	host,
	cfg,
	running,
	foreignUsedByHost = null
) {
	const ownRunning =
		runningRamForHost(
			running,
			host.name
		);

	const staticUsed =
		foreignUsedByHost &&
			foreignUsedByHost.has(
				host.name
			)
			? Math.max(
				0,
				foreignUsedByHost.get(
					host.name
				) ?? 0
			)
			: Math.max(
				0,
				ns.getServerUsedRam(
					host.name
				) -
				ownRunning
			);

	const reserve =
		host.name === HOME
			? cfg.homeReserve
			: 0;

	return Math.max(
		0,
		host.maxRam -
		reserve -
		staticUsed
	);
}

function peakReservation(
	hostReservations,
	start,
	end
) {
	let active = 0;
	const events = [];

	for (
		const r
		of hostReservations
	) {
		if (
			r.end <= start ||
			r.start >= end
		) {
			continue;
		}

		if (
			r.start <= start &&
			r.end > start
		) {
			active +=
				r.ram;
		}

		if (
			r.start > start &&
			r.start < end
		) {
			events.push([
				r.start,
				r.ram,
			]);
		}

		if (
			r.end > start &&
			r.end < end
		) {
			events.push([
				r.end,
				-r.ram,
			]);
		}
	}

	events.sort(
		(a, b) =>
			(a[0] - b[0]) ||
			(a[1] - b[1])
	);

	let peak = active;

	for (
		const [, delta]
		of events
	) {
		active += delta;
		peak = Math.max(
			peak,
			active
		);
	}

	return peak;
}

function seedForeignUsage(
	ns,
	hosts,
	running,
	foreignUsedByHost
) {
	foreignUsedByHost.clear();

	for (const host of hosts) {
		const own =
			runningRamForHost(
				running,
				host.name
			);

		foreignUsedByHost.set(
			host.name,
			Math.max(
				0,
				ns.getServerUsedRam(
					host.name
				) - own
			)
		);
	}
}

function syncForeignUsageHosts(
	hosts,
	foreignUsedByHost
) {
	const names =
		new Set(
			hosts.map(
				host => host.name
			)
		);

	for (
		const name
		of foreignUsedByHost.keys()
	) {
		if (!names.has(name)) {
			foreignUsedByHost.delete(
				name
			);
		}
	}

	for (const host of hosts) {
		if (
			!foreignUsedByHost.has(
				host.name
			)
		) {
			foreignUsedByHost.set(
				host.name,
				0
			);
		}
	}
}

function refreshOneForeignUsage(
	ns,
	hosts,
	running,
	foreignUsedByHost,
	cursor
) {
	if (!hosts.length) {
		return 0;
	}

	const index =
		Math.abs(
			Number(cursor) || 0
		) % hosts.length;

	const host =
		hosts[index];

	const own =
		runningRamForHost(
			running,
			host.name
		);

	const actual =
		ns.getServerUsedRam(
			host.name
		);

	const previous =
		foreignUsedByHost.get(
			host.name
		) ?? 0;

	// A worker may have exited before the 1s PID reap. In that brief window
	// ownRunning can exceed actual used RAM; keep the previous foreign-use
	// estimate rather than incorrectly dropping it to zero.
	const measured =
		actual + 1e-9 >= own
			? Math.max(
				0,
				actual - own
			)
			: previous;

	foreignUsedByHost.set(
		host.name,
		measured
	);

	return (
		index + 1
	) % hosts.length;
}

function workerFleetCapacity(
	hosts,
	cfg
) {
	return hosts.reduce(
		(sum, host) =>
			sum +
			Math.max(
				0,
				host.maxRam -
				(host.name === HOME
					? cfg.homeReserve
					: 0)
			),
		0
	);
}

function poolProfile(
	ns,
	hosts,
	cfg,
	running
) {
	let capacity = 0;

	let weightedBonus = 0;

	for (
		const host
		of hosts
	) {
		const available =
			baseHostCapacity(
				ns,
				host,
				cfg,
				running
			);

		capacity +=
			available;

		weightedBonus +=
			available *
			coreBonus(
				host.cores
			);
	}

	return {
		capacity,

		averageCoreBonus:
			capacity > 0
				? weightedBonus /
				capacity
				: 1,
	};
}

function coreBonus(
	cores
) {
	return (
		1 +
		(
			Math.max(
				1,
				cores
			) -
			1
		) /
		16
	);
}

/* =========================================================
	 WORKER EVENTS / SAFETY
	 ========================================================= */

function makeBatchState(
	id,
	chunks
) {
	const expected = {
		H: 0,
		W1: 0,
		G: 0,
		W2: 0,
	};

	const landing = {};

	for (
		const chunk
		of chunks
	) {
		expected[
			chunk.phase
		]++;

		landing[
			chunk.phase
		] =
			chunk.landAt;
	}

	return {
		id:
			String(id),

		expected,
		landing,

		moneyEarned: 0,

		phases: {
			H:
				phaseState(),

			W1:
				phaseState(),

			G:
				phaseState(),

			W2:
				phaseState(),
		},
	};
}

function phaseState() {
	return {
		count: 0,

		min:
			Infinity,

		max:
			-Infinity,

		complete:
			false,

		skipped:
			false,
	};
}

function recordPhaseMiss(
	stats,
	phase,
	execFailure = false
) {
	if (
		Object.prototype.hasOwnProperty.call(
			stats.misses,
			phase
		)
	) {
		stats.misses[phase]++;

		if (execFailure) {
			stats.execFails[phase]++;
		}
	}
}

function markBatchPhaseSkipped(
	batches,
	batchId,
	phase
) {
	const batch =
		batches.get(
			String(batchId)
		);

	if (!batch) {
		return;
	}

	const state =
		batch.phases[phase];

	if (!state) {
		return;
	}

	state.skipped = true;
	state.complete = true;
	state.count =
		batch.expected[phase];

	const landing =
		Number(
			batch.landing[phase] ??
			Date.now()
		);

	state.min = landing;
	state.max = landing;
}

function beginDrain(
	current,
	issue,
	queue,
	batches,
	stats,
	cfg
) {
	if (current) {
		return {
			drain: current,
			queue,
		};
	}

	if (issue.bumpGap) {
		cfg.gap =
			Math.min(
				100,
				cfg.gap + 5
			);
	}

	stats.recoveries++;
	stats.lastReason =
		`draining: ${issue.reason}`;

	const kept = [];

	for (const chunk of queue) {
		if (chunk.phase === "H") {
			markBatchPhaseSkipped(
				batches,
				chunk.batchId,
				"H"
			);

			stats.cancelledHackChunks++;
			continue;
		}

		kept.push(chunk);
	}

	return {
		drain: {
			reason:
				issue.reason,
			afterKind:
				issue.afterKind ??
				"resync",
			resetPeriod:
				Boolean(
					issue.resetPeriod
				),
			started:
				Date.now(),
		},
		queue: kept,
	};
}

function consumeEvents(
	ns,
	port,
	batches,
	stats,
	target,
	runtime,
	cfg
) {
	while (
		!port.empty()
	) {
		const event =
			port.read();

		if (
			!event ||
			typeof event !==
			"object"
		) {
			continue;
		}

		if (
			String(
				event.phase ??
				""
			).startsWith(
				"PREP"
			)
		) {
			continue;
		}

		if (
			event.type ===
			"miss"
		) {
			const missedPhase =
				String(
					event.phase ??
					""
				);

			recordPhaseMiss(
				stats,
				missedPhase
			);

			markBatchPhaseSkipped(
				batches,
				event.batchId,
				missedPhase
			);

			const reason =
				`${missedPhase} missed by ` +
				`${Number(
					event.lateBy
				).toFixed(1)}ms`;

			if (missedPhase === "H") {
				// A skipped hack leaves the target cleaner than planned. Let the
				// corresponding W/G/W phases finish; they safely over-recover.
				stats.lastReason = reason;
				continue;
			}

			return {
				reason,
				kind:
					"drain",
				afterKind:
					"resync",
				bumpGap:
					true,
			};
		}

		if (
			event.type !==
			"done"
		) {
			continue;
		}

		const batch =
			batches.get(
				String(
					event.batchId
				)
			);

		if (!batch) {
			continue;
		}

		const phase =
			String(
				event.phase
			);

		const state =
			batch.phases[
			phase
			];

		if (!state) {
			continue;
		}

		const finished =
			Number(
				event.finishedAt
			);

		state.count++;

		state.min =
			Math.min(
				state.min,
				finished
			);

		state.max =
			Math.max(
				state.max,
				finished
			);

		const drift =
			Math.abs(
				Number(
					event.drift ??
					0
				)
			);

		stats.driftSum +=
			drift;

		stats.driftCount++;

		stats.driftMax =
			Math.max(
				stats.driftMax,
				drift
			);

		if (
			phase ===
			"H"
		) {
			const earned =
				Math.max(
					0,
					Number(
						event.result ??
						0
					)
				);

			stats.money +=
				earned;

			batch.moneyEarned +=
				earned;

			stats.lastHackAt =
				finished;

			stats.income.push({
				time:
					finished,

				money:
					earned,
			});
		}

		if (state.skipped) {
			continue;
		}

		if (
			state.count <
			batch.expected[
			phase
			]
		) {
			continue;
		}

		state.complete =
			true;

		const order = [
			"H",
			"W1",
			"G",
			"W2",
		];

		const index =
			order.indexOf(
				phase
			);

		const requiredSpacing =
			minimumSpacing(
				cfg
			);

		/*
		 * Previous batch W2 -> next H.
		 */
		if (
			phase ===
			"H" &&
			Number.isFinite(
				stats.lastW2
			)
		) {
			const spacing =
				state.min -
				stats.lastW2;

			stats.minSpacing =
				Math.min(
					stats.minSpacing,
					spacing
				);

			if (
				spacing <
				requiredSpacing
			) {
				return {
					reason:
						`unsafe W2 -> H spacing ` +
						`${spacing.toFixed(1)}ms`,

					kind:
						"drain",

					bumpGap:
						true,
				};
			}
		}

		/*
		 * H -> W1 -> G -> W2 ordering.
		 */
		if (
			index > 0
		) {
			const previous =
				batch.phases[
				order[
				index -
				1
				]
				];

			if (!previous.skipped) {
				if (
					!previous.complete
				) {
					return {
						reason:
							`${phase} completed before ` +
							`${order[index - 1]}`,

						kind:
							"drain",

						bumpGap:
							true,
					};
				}

				const spacing =
					state.min -
					previous.max;

				stats.minSpacing =
					Math.min(
						stats.minSpacing,
						spacing
					);

				if (
					spacing <
					requiredSpacing
				) {
					return {
						reason:
							`unsafe ` +
							`${order[index - 1]} -> ${phase} ` +
							`${spacing.toFixed(1)}ms`,

						kind:
							"drain",

						bumpGap:
							true,
					};
				}
			}
		}

		if (
			phase ===
			"W2"
		) {
			if (
				batch.phases.H.skipped
			) {
				stats.recovered++;
			} else {
				stats.completed++;

				if (
					batch.moneyEarned >
					0
				) {
					stats.profitable++;
				}

				stats.batchTimes.push(
					state.max
				);
			}

			stats.lastW2 =
				state.max;

			const cleanWindow =
				runtime.plan.period -
				3 *
				cfg.gap -
				requiredSpacing;

			if (
				Date.now() -
				state.max <
				cleanWindow
			) {
				const maxMoney =
					ns.getServerMaxMoney(
						target
					);

				const money =
					ns.getServerMoneyAvailable(
						target
					);

				const minSec =
					ns.getServerMinSecurityLevel(
						target
					);

				const sec =
					ns.getServerSecurityLevel(
						target
					);

				if (
					money <
					maxMoney *
					0.995
				) {
					return {
						reason:
							`money recovery failed ` +
							`${(
								money /
								maxMoney *
								100
							).toFixed(2)}%`,

						kind:
							"drain",
					};
				}

				if (
					sec >
					minSec +
					0.02
				) {
					return {
						reason:
							`security recovery failed ` +
							`${sec.toFixed(3)} / ` +
							`${minSec.toFixed(3)}`,

						kind:
							"drain",
					};
				}
			}

			batches.delete(
				batch.id
			);
		}
	}

	return null;
}

function findOverdueBatch(
	batches,
	cfg
) {
	const now =
		Date.now();

	const grace =
		Math.max(
			250,
			cfg.gap *
			3
		);

	for (
		const batch
		of batches.values()
	) {
		for (
			const phase
			of [
				"H",
				"W1",
				"G",
				"W2",
			]
		) {
			if (
				batch.phases[
					phase
				].complete
			) {
				continue;
			}

			if (
				now >
				batch.landing[
				phase
				] +
				grace
			) {
				return (
					`${phase} completion event overdue`
				);
			}
		}
	}

	return null;
}

function minimumSpacing(
	cfg
) {
	return Math.max(
		5,
		Math.floor(
			cfg.gap *
			0.20
		)
	);
}

/* =========================================================
	 PROCESS MANAGEMENT
	 ========================================================= */

function enqueueChunks(
	queue,
	chunks
) {
	for (const chunk of chunks) {
		let low = 0;
		let high = queue.length;

		while (low < high) {
			const mid =
				(low + high) >>> 1;

			if (
				queue[mid].launchAt <=
				chunk.launchAt
			) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}

		queue.splice(
			low,
			0,
			chunk
		);
	}
}

function launchDueChunks(
	ns,
	queue,
	target,
	cfg,
	batches,
	stats,
	running,
	drain
) {
	while (
		queue.length &&
		queue[0].launchAt <=
		Date.now()
	) {
		const chunk =
			queue.shift();

		const maxLate =
			Math.max(
				20,
				cfg.gap
			);

		const pid =
			ns.exec(
				chunk.script,
				chunk.host,
				chunk.threads,
				target,
				chunk.landAt,
				chunk.batchId,
				cfg.port,
				chunk.phase,
				chunk.chunkId,
				maxLate
			);

		if (!pid) {
			recordPhaseMiss(
				stats,
				chunk.phase,
				true
			);

			markBatchPhaseSkipped(
				batches,
				chunk.batchId,
				chunk.phase
			);

			if (
				chunk.phase ===
				"H"
			) {
				stats.lastReason =
					`H exec skipped on ${chunk.host}`;
				continue;
			}

			const result =
				beginDrain(
					drain,
					{
						reason:
							`exec failed: ${chunk.phase} on ${chunk.host}`,
						kind:
							"drain",
						afterKind:
							"resync",
						bumpGap:
							true,
					},
					queue,
					batches,
					stats,
					cfg
				);

			drain =
				result.drain;
			queue =
				result.queue;
			break;
		}

		trackRunning(
			running,
			pid,
			chunk
		);
	}

	return {
		queue,
		drain,
	};
}

function networkFromFleetStatus(
	status,
	minimumWorkerRam
) {
	const snapshot =
		status?.network;

	if (
		!snapshot ||
		!Array.isArray(snapshot.hosts) ||
		!Array.isArray(snapshot.servers)
	) {
		return null;
	}

	const hosts =
		snapshot.hosts
			.map(host => ({
				name:
					String(host.name ?? ""),
				maxRam:
					Number(host.maxRam) || 0,
				cores:
					Math.max(
						1,
						Number(host.cores) || 1
					),
			}))
			.filter(host =>
				host.name &&
				host.maxRam >=
				minimumWorkerRam
			)
			.sort((a, b) =>
				b.maxRam - a.maxRam
			);

	return {
		servers:
			snapshot.servers.map(String),
		hosts,
		rooted:
			Math.max(
				0,
				Number(snapshot.rooted) || 0
			),
	};
}

function reapRunning(
	ns,
	running
) {
	for (
		const [
			pid,
			chunk,
		]
		of running
	) {
		if (
			!ns.isRunning(
				pid
			)
		) {
			untrackRunning(
				running,
				pid,
				chunk
			);
		}
	}
}

/* =========================================================
	 DASHBOARD
	 ========================================================= */

function createStats() {
	return {
		started:
			Date.now(),

		money: 0,

		income: [],

		batchTimes: [],

		scheduled: 0,

		completed: 0,

		recovered: 0,

		profitable: 0,

		nextHackLanding:
			NaN,

		lastHackAt:
			NaN,

		// Total number of safe batch landing slots skipped because the
		// distributed allocator could not place the whole batch.
		allocationFails: 0,

		// Useful telemetry for seeing whether fragmentation is transient
		// or occurring in long streaks. This does not trigger maintenance.
		maxConsecutiveAllocationFails: 0,

		driftSum: 0,

		driftCount: 0,

		driftMax: 0,

		minSpacing:
			Infinity,

		lastW2:
			NaN,

		restarts: 0,

		resyncs: 0,

		recoveries: 0,

		cancelledHackChunks: 0,

		misses: {
			H: 0,
			W1: 0,
			G: 0,
			W2: 0,
		},

		execFails: {
			H: 0,
			W1: 0,
			G: 0,
			W2: 0,
		},

		lastReason:
			"none",
	};
}

function renderTargetAnalysis(
	ns,
	target,
	targetAnalysis,
	limit = 6
) {
	if (
		!targetAnalysis.length
	) {
		return;
	}

	ns.print("");

	ns.print(
		"TARGET ANALYSIS :: 10m horizon"
	);

	for (
		const entry
		of targetAnalysis.slice(
			0,
			limit
		)
	) {
		const selected =
			entry.name ===
				target
				? ">"
				: " ";

		ns.print(
			`${selected} ` +
			`${entry.name.padEnd(18)} ` +
			`${cash(entry.score).padStart(9)}/s ` +
			`steady:${cash(entry.steady).padStart(9)}/s ` +
			`S:${(
				entry.steal *
				100
			)
				.toFixed(1)
				.padStart(4)}% ` +
			`P:${formatTime(
				entry.period
			).padStart(6)} ` +
			`prep:${formatTime(
				entry.prepMs
			).padStart(6)}`
		);
	}
}

function renderDashboard(
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
) {
	const now =
		Date.now();

	const maxMoney =
		ns.getServerMaxMoney(
			target
		);

	const money =
		ns.getServerMoneyAvailable(
			target
		);

	const minSec =
		ns.getServerMinSecurityLevel(
			target
		);

	const sec =
		ns.getServerSecurityLevel(
			target
		);

	const totalRam =
		network.hosts.reduce(
			(sum, host) =>
				sum +
				host.maxRam,
			0
		);

	const workerRam =
		totalRunningRam(
			running
		);

	const usedRam =
		network.hosts.reduce(
			(sum, host) =>
				sum +
				(foreignUsedByHost.get(
					host.name
				) ?? 0) +
				runningRamForHost(
					running,
					host.name
				),
			0
		);

	const income10 =
		incomeRate(
			stats,
			10_000,
			now
		);

	const income60 =
		incomeRate(
			stats,
			60_000,
			now
		);

	const batch60 =
		countRate(
			stats.batchTimes,
			60_000,
			stats.started,
			now
		);

	const avgDrift =
		stats.driftCount
			? stats.driftSum /
			stats.driftCount
			: 0;

	const minSpacing =
		Number.isFinite(
			stats.minSpacing
		)
			? `${stats.minSpacing.toFixed(1)}ms`
			: "n/a";

	const currentProfile =
		poolProfile(
			ns,
			network.hosts,
			cfg,
			running
		);

	const p =
		runtime.plan;

	const hackStatus =
		Number.isFinite(
			stats.lastHackAt
		)
			? "LIVE"
			: Number.isFinite(
				stats.nextHackLanding
			)
				? `ETA ${formatTime(
					Math.max(
						0,
						stats.nextHackLanding -
						now
					)
				)}`
				: "n/a";

	ns.clearLog();

	ns.print(
		`JIT DAEMON :: ${target} :: hacking ${ns.getHackingLevel()}`
	);

	ns.print(
		`Target      ` +
		`${cfg.requestedTarget ===
			"auto"
			? "AUTO"
			: "LOCKED"
		}`
	);

	ns.print(
		`State       ` +
		`${drain
			? `DRAINING :: ${drain.reason}`
			: "RUNNING"}`
	);

	if (
		cfg.requestedTarget ===
		"auto"
	) {
		renderTargetAnalysis(
			ns,
			target,
			targetAnalysis,
			6
		);
	}

	ns.print("");

	ns.print(
		`Money       ${bar(
			money /
			Math.max(
				1,
				maxMoney
			)
		)} ` +
		`${cash(money)} / ${cash(maxMoney)}`
	);

	ns.print(
		`Security    ` +
		`${sec.toFixed(3)} / ` +
		`${minSec.toFixed(3)} ` +
		`(+${Math.max(
			0,
			sec -
			minSec
		).toFixed(3)})`
	);

	ns.print("");

	ns.print(
		`Network     ` +
		`${network.rooted}/${network.servers.length} rooted ` +
		`| ${network.hosts.length} worker hosts`
	);

	ns.print(
		`Cloud       ` +
		`${cloudState.count}/${cloudState.limit} servers ` +
		`| ${formatRam(cloudState.totalRam)} ` +
		`| ${cloudState.enabled ? "AUTO" : "MANUAL"}`
	);

	if (cloudState.count > 0) {
		ns.print(
			`Cloud RAM   ` +
			`min ${formatRam(cloudState.minRam)} ` +
			`| max ${formatRam(cloudState.maxRam)} ` +
			`| cap ${formatRam(cloudState.ramLimit)}`
		);
	}

	ns.print(
		`Cloud spend ` +
		`${cash(cloudState.spent)} ` +
		`| buy ${cloudState.purchases} ` +
		`| up ${cloudState.upgrades} ` +
		`| reserve ${(cfg.cloud.cashReserve * 100).toFixed(0)}%`
	);

	ns.print(
		`Cloud next  ${cloudState.nextAction}`
	);

	if (
		cloudState.error
	) {
		ns.print(
			`Cloud error ${cloudState.error}`
		);
	}

	ns.print(
		`RAM online  ` +
		`${formatRam(usedRam)} / ${formatRam(totalRam)} ` +
		`(${(
			usedRam /
			Math.max(1, totalRam) *
			100
		).toFixed(1)}%)`
	);

	ns.print(
		`Worker RAM  ${formatRam(workerRam)} running`
	);

	ns.print(
		`Capacity    ` +
		`${formatRam(currentProfile.capacity)} now | ` +
		`${formatRam(runtime.capacity)} tuned`
	);

	ns.print(
		`Core bonus  ${runtime.averageCoreBonus.toFixed(3)}x avg`
	);

	ns.print("");

	ns.print(
		`Income 10s  ${cash(income10)}/s`
	);

	ns.print(
		`Income 60s  ${cash(income60)}/s`
	);

	ns.print(
		`Run total   ${cash(stats.money)}`
	);

	ns.print(
		`Model       ${cash(p.expected)}/s`
	);

	ns.print("");

	ns.print(
		`Steal       ` +
		`${(
			p.steal *
			100
		).toFixed(2)}% ` +
		`| chance ${(
			p.chance *
			100
		).toFixed(1)}%`
	);

	ns.print(
		`Threads     ` +
		`H:${p.H} ` +
		`G~:${p.estimatedG} ` +
		`W1~:${p.estimatedW1} ` +
		`W2~:${p.estimatedW2}`
	);

	ns.print(
		`Grow eq     ${p.gEffective} one-core equivalent thread(s)`
	);

	ns.print(
		`Times       ` +
		`H:${formatTime(p.times.H)} ` +
		`G:${formatTime(p.times.G)} ` +
		`W:${formatTime(p.times.W)}`
	);

	ns.print(
		`Timing      ` +
		`gap ${cfg.gap}ms ` +
		`| period ${formatTime(p.period)}`
	);

	ns.print(
		`Batch rate  ` +
		`${batch60.toFixed(3)}/s actual ` +
		`| ${p.batchRate.toFixed(3)}/s model`
	);

	ns.print("");

	ns.print(
		`Pipeline    ` +
		`${running.size} running ` +
		`| ${queue.length} queued ` +
		`| ${reservations.length} reservations`
	);

	ns.print(
		`Batches     ` +
		`${stats.scheduled} scheduled ` +
		`| ${stats.completed} completed ` +
		`| ${stats.recovered} recovered`
	);

	ns.print(
		`Hack status ${hackStatus} ` +
		`| ${stats.profitable} paid batch(es)`
	);

	ns.print(
		`Allocator   ` +
		`${stats.allocationFails} skipped slots ` +
		`| worst streak ${stats.maxConsecutiveAllocationFails}`
	);

	ns.print(
		`Misses      ` +
		`H:${stats.misses.H} ` +
		`W1:${stats.misses.W1} ` +
		`G:${stats.misses.G} ` +
		`W2:${stats.misses.W2} ` +
		`| exec H:${stats.execFails.H} ` +
		`W1:${stats.execFails.W1} ` +
		`G:${stats.execFails.G} ` +
		`W2:${stats.execFails.W2}`
	);

	ns.print(
		`Recovery    ` +
		`${stats.recoveries} drain(s) ` +
		`| cancelled H chunks ${stats.cancelledHackChunks}`
	);

	ns.print(
		`Drift       ` +
		`avg ${avgDrift.toFixed(2)}ms ` +
		`| max ${stats.driftMax.toFixed(2)}ms`
	);

	ns.print(
		`Spacing     ` +
		`min ${minSpacing} ` +
		`| required ${minimumSpacing(cfg)}ms`
	);

	ns.print(
		`Restarts    ` +
		`${stats.restarts} ` +
		`| safety resyncs ${stats.resyncs}`
	);

	ns.print(
		`Last        ${stats.lastReason}`
	);
}

function renderPrep(
	ns,
	target,
	network,
	cfg,
	wave,
	stage,
	chunks,
	end = 0,
	requiredEffective = 0,
	waveEffective = 0,
	wavesLeft = 0,
	projectedMultiplier = 1,
	targetAnalysis = []
) {
	const maxMoney =
		ns.getServerMaxMoney(
			target
		);

	const money =
		ns.getServerMoneyAvailable(
			target
		);

	const minSec =
		ns.getServerMinSecurityLevel(
			target
		);

	const sec =
		ns.getServerSecurityLevel(
			target
		);

	const totalRam =
		network.hosts.reduce(
			(sum, host) =>
				sum +
				host.maxRam,
			0
		);

	const usedRam =
		network.hosts.reduce(
			(sum, host) =>
				sum +
				ns.getServerUsedRam(
					host.name
				),
			0
		);

	const byPhase =
		new Map();

	for (
		const chunk
		of chunks
	) {
		byPhase.set(
			chunk.phase,

			(
				byPhase.get(
					chunk.phase
				) ??
				0
			) +
			chunk.threads
		);
	}

	ns.clearLog();

	ns.print(
		`JIT DAEMON :: PREP :: ${target}`
	);

	ns.print(
		`Stage       ${stage}`
	);

	if (
		cfg.requestedTarget ===
		"auto"
	) {
		renderTargetAnalysis(
			ns,
			target,
			targetAnalysis,
			6
		);
	}

	ns.print("");

	ns.print(
		`Money       ${bar(
			money /
			Math.max(
				1,
				maxMoney
			)
		)} ` +
		`${cash(money)} / ${cash(maxMoney)}`
	);

	ns.print(
		`Security    ` +
		`${sec.toFixed(3)} / ` +
		`${minSec.toFixed(3)} ` +
		`(+${Math.max(
			0,
			sec -
			minSec
		).toFixed(3)})`
	);

	ns.print(
		`Network     ` +
		`${network.rooted}/${network.servers.length} rooted ` +
		`| ${network.hosts.length} hosts`
	);

	ns.print(
		`RAM         ` +
		`${formatRam(usedRam)} / ${formatRam(totalRam)}`
	);

	ns.print(
		`Wave        #${wave} ` +
		`| ETA ${end
			? formatTime(
				Math.max(
					0,
					end -
					Date.now()
				)
			)
			: "0ms"
		}`
	);

	if (
		byPhase.size
	) {
		ns.print(
			`Threads     ` +
			[...byPhase.entries()]
				.map(
					([
						phase,
						threads,
					]) =>
						`${phase.replace(
							"PREP-",
							""
						)}:${threads}`
				)
				.join(
					"  "
				)
		);
	}

	if (
		requiredEffective >
		0
	) {
		ns.print(
			`Grow need   ${Math.ceil(requiredEffective)} eq threads`
		);

		ns.print(
			`This wave   ${Math.ceil(waveEffective)} eq threads`
		);

		ns.print(
			`Wave grow   ~${projectedMultiplier.toFixed(2)}x`
		);

		ns.print(
			`Waves left  ~${wavesLeft}`
		);
	}
}

/* =========================================================
	 METRICS / FORMATTING
	 ========================================================= */

function incomeRate(
	stats,
	window,
	now
) {
	const cutoff =
		now -
		window;

	const money =
		stats.income.reduce(
			(sum, sample) =>
				sum +
				(
					sample.time >=
						cutoff
						? sample.money
						: 0
				),
			0
		);

	const elapsed =
		Math.max(
			1,
			Math.min(
				window,
				now -
				stats.started
			)
		);

	return (
		money /
		(
			elapsed /
			1000
		)
	);
}

function countRate(
	samples,
	window,
	started,
	now
) {
	const cutoff =
		now -
		window;

	const count =
		samples.filter(
			time =>
				time >=
				cutoff
		).length;

	const elapsed =
		Math.max(
			1,
			Math.min(
				window,
				now -
				started
			)
		);

	return (
		count /
		(
			elapsed /
			1000
		)
	);
}

function asFraction(
	value
) {
	return (
		value > 1
			? value /
			100
			: value
	);
}

function asBoolean(
	value
) {
	if (
		typeof value ===
		"boolean"
	) {
		return value;
	}

	const text =
		String(value)
			.trim()
			.toLowerCase();

	return ![
		"false",
		"0",
		"no",
		"off",
	].includes(
		text
	);
}

function normalizeCloudRam(
	value
) {
	const requested =
		Math.max(
			2,
			Number(value) ||
			2
		);

	return 2 **
		Math.ceil(
			Math.log2(
				requested
			)
		);
}

function formatRam(
	gb
) {
	const value =
		Math.max(
			0,
			Number(gb) ||
			0
		);

	if (
		value >=
		1024 * 1024
	) {
		return (
			`${(
				value /
				(1024 * 1024)
			).toFixed(2)} PB`
		);
	}

	if (
		value >=
		1024
	) {
		return (
			`${(
				value /
				1024
			).toFixed(2)} TB`
		);
	}

	return (
		`${value.toFixed(0)} GB`
	);
}

function mod(
	value,
	modulus
) {
	return (
		(
			value %
			modulus
		) +
		modulus
	) %
		modulus;
}

function cash(
	value
) {
	const n =
		Number(value) ||
		0;

	const units = [
		[1e18, "Q"],
		[1e15, "q"],
		[1e12, "t"],
		[1e9, "b"],
		[1e6, "m"],
		[1e3, "k"],
	];

	for (
		const [
			threshold,
			suffix,
		]
		of units
	) {
		if (
			Math.abs(
				n
			) >=
			threshold
		) {
			return (
				`$${(
					n /
					threshold
				).toFixed(2)}` +
				suffix
			);
		}
	}

	return (
		`$${n.toFixed(
			Math.abs(
				n
			) >=
				100
				? 0
				: 2
		)}`
	);
}

function formatTime(
	ms
) {
	const n =
		Math.max(
			0,
			Number(ms) ||
			0
		);

	if (
		n <
		1000
	) {
		return (
			`${n.toFixed(0)}ms`
		);
	}

	if (
		n <
		60_000
	) {
		return (
			`${(
				n /
				1000
			).toFixed(1)}s`
		);
	}

	return (
		`${(
			n /
			60_000
		).toFixed(1)}m`
	);
}

function bar(
	value,
	width = 18
) {
	const fraction =
		Math.max(
			0,
			Math.min(
				1,
				Number(value) ||
				0
			)
		);

	const filled =
		Math.round(
			fraction *
			width
		);

	return (
		`[${"█".repeat(
			filled
		)}` +
		`${"░".repeat(
			width -
			filled
		)}] ` +
		`${(
			fraction *
			100
		).toFixed(1)}%`
	);
}
