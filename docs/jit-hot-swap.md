# Same-target JIT plan hot swaps

Elective formula, skill (at least 10 levels and 10%), and fleet-capacity (25%) changes now build a replacement plan while the target keeps earning. This uses the existing incremental tuner, including a bounded opportunity in dense launch schedules. A new daemon is not started and the active lane is not drained for tuning.

## Identity and state

Each pipeline has a separate ownership `epoch`, admitting `generation`, monotonically increasing `generationSerial`, and map of committed generations. Generation 1 is the initial plan. Epoch changes remain reserved for ownership/recovery; an elective swap retains its epoch. A shadow candidate proposes `generationSerial + 1` but consumes it only when reservations commit. A committed replacement that subsequently aborts retains its consumed number; returning to the old admitting generation never reuses that number.

The path is `SHADOW -> PREFLIGHT -> CUTOVER -> ACTIVE`. On commit the old generation becomes `DRAINING`. At most two generations remain committed. Once a new batch finishes with a valid final W2 money/security snapshot, the new generation becomes active. Old metadata and worker authorization remain until its queue, processes, batches, event inbox and reservation holds are reconciled; then it becomes `RETIRED` and is removed. Failed uncommitted candidates become `ABORTED` without using a number.

Chunks, batches, reservations, worker arguments, completion/start events, and income samples carry generation identity. A batch retains its generation's runtime plan and timing configuration. Duration, landing deadlines, reservation RAM and thread counts remain on the original chunks. Drift, phase spacing and overdue checks use the owning batch's configuration. Workers accept both committed generations but reject unknown/retired generations, mismatched target/epoch, malformed control data, inconsistent owner identity and owners that are no longer running. Existing legacy non-generation test/prep paths remain supported. The daemon sizes allocations using the deployed scripts' measured RAM costs, including the owner-liveness check.

## Tuning, preflight and timing

Inputs include target, hacking level, formula/fallback availability, fleet capacity/topology/cores, peer cadence, phase gap and launch lead. A candidate records creation time, normalized action durations, modeled period and threads. Two seconds of stable inputs coalesce rapid skill jumps. Changes invalidate a yielding search or a pending candidate. Before commitment, the normalized model is checked again for changed durations, hack fraction, chance, money/security limits and actual formula mode. Unsuccessful or non-improving plans retry with a cooldown.

Preflight reserves two **complete HWGW batches** through the real shared allocator. It includes old-generation and peer reservations, running workers, foreign RAM and non-expiring prep holds. It then checks the shared worker commitment limit and conservative rolling launch budget. It uses the pure reservation path, so a probe cannot kill prep or any productive worker. Any rejection rolls back only its newly appended reservations; the old plan continues admitting. Retries back off from one second to 30 seconds, with a diagnostic reason.

Normal admission, idle-plan probes and hot-swap preflight share a placement fallback. If the core-efficient allocation fragments a batch beyond the worker or launch budget, its reservations are rolled back and a second allocation favors hosts that fit a whole Grow/Weaken phase (or the largest effective capacities if splitting is unavoidable). W2 is recalculated from the actual Grow threads. Both attempts obey the same RAM and launch limits; probes never preempt prep. This avoids near-idle pipelines on fleets mixing small higher-core servers with large single-core hosts.

RAM-limited tuning leaves two estimated batches of headroom (capped at half the available capacity) for batch peaks and transitions. A replacement rejected for overlap RAM starts a yielding search that tests smaller candidates with the actual two-batch overlap allocator. Only a plan improving on the active model can commit, and the final preflight still revalidates resources and the restoration boundary. An all-blocked search backs off while the active generation keeps admitting.

The two-minute productivity gate accumulates each safely completed batch's own plan period. A committed generation change preserves this total: faster plans cannot erase earlier progress, and slower plans cannot inflate it. Background preparation, target admission, promotion and displayed progress use the same accumulated value. A recent Hack and a healthy lane are still required; a hard recovery that resets pipeline statistics starts a fresh productivity window.

The first new H is later than the final committed old W2 by at least the larger generation phase gap, and sufficiently far in the future to launch the new actions. A boundary requiring an avoidable action-duration-sized income gap is rejected. The successful preflight reservations are committed atomically, old admissions stop, and new admissions follow that boundary. No old batch is cancelled for a planned swap. New workers can launch before the old generation finishes; their landing times stay after restoration.

Bitburner samples duration when an action is invoked. Its [upstream Netscript implementation](https://github.com/bitburner-official/bitburner-src/blob/dev/src/NetscriptFunctions.ts) constructs the action delay before awaiting it. Already invoked old workers retain their timers after a skill jump. New workers use their current action duration plus `additionalMsec` to reach the safe boundary. A 10-to-3000 jump therefore does not require waiting through another old-duration warmup.

## Failure behavior and limits

Before the first new H's scheduled landing, and only after pending events are reconciled, a failed committed replacement can cancel its own work by exact PID and resume the previous plan. A failed kill does not fabricate terminal state. Old and peer work remain owned. Uncommitted tune/preflight failures simply leave the old plan running.

At or after the first new H, missing telemetry is treated conservatively: stop new admissions and Hacks, retain committed restoration tails, and use the existing bounded local/hard recovery once those tails settle. Never blindly return to the old plan after possible target damage. A hard safety drain takes precedence over transition handling.

This protects planned continuity, not arbitrary future resource or game changes. Foreign RAM changes after preflight, worker/host loss, scheduler stalls, dirty-target safety faults, or a committed replacement failing too late to relaunch old-duration actions can still cause payout gaps. Hacks also fail probabilistically. If a safe overlap or an improved plan is unavailable, the old plan remains in use. New processes still have initial warmup; switching to another target uses background prep and lane promotion, not a generation of the former target.

## Dashboard and status

Compact dashboards show `gen 1 ACTIVE | gen 2 SHADOW` or `gen 1 DRAINING -> gen 2 CUTOVER` and first-new-H ETA. Details include trigger, levels, modeled income/cadence, final old W2, first new H, peak reserved overlap RAM, retries, and completed/aborted counts. Normal shadow tuning is not a recovery or Attention condition. Existing actual versus planned throughput remains separate.

The version-2 JIT status schema gains additive `generation`, `generations`, `shadow`, `cutover`, `lastSwap`, and `hotSwaps` fields on each pipeline. Telemetry preserves these fields; existing supervisor readers remain compatible. Aborted counts include discarded shadows as well as failed committed transitions.

## Why a second lane can be n00dles

An empty second slot is currently an **additive income** opportunity. `emptySlotIncomeFloor` uses `primary modeled income * (switchThreshold - 1)`: with the default `--switch-threshold 1.25`, the new lane needs a model at least 25% of the primary model. It need not beat the primary target. Admission also validates the tuned model against that floor; actual income may differ because of chance and launch deferrals.

The fast ready-target scan considers only rooted, hackable, already-prepared servers. It ranks their potential with the unused batch-rate budget; an existing READY preparation candidate gets first opportunity. Richer dirty servers require background preparation. While a new lane is `TRIAL`, full-slot promotion scouting waits for both lanes to be stable and productive. After the trial, promotion scouts a replacement that beats the weaker lane by the full switch threshold. Thus n00dles can earn as a temporary support target even when a richer server exists. The current status screenshot alone cannot identify which other servers were rooted/prepared or their models at the admission instant. This change preserves that target-selection policy.

## Verification

`test/hot-swap.test.cjs` covers coalescing, admissions while tuning, generation/epoch gates, plan ownership, peer-safe retirement, real RAM/foreign/prep/worker/launch-budget rejection, and rollback on either side of first H. `test/hot-swap-simulation.test.cjs` runs a paying level-10 lane through a level-3000 replacement, asserting one commit, no cancellations/corruption/recovery, bounded payout spacing, new model/measured cadence, and host RAM limits. A second simulation injects persistent allocator refusal to verify retry liveness and continued old-plan income; actual insufficient-capacity checks are exercised in the unit scenarios.

`test/launch-fragmentation-simulation.test.cjs` covers mixed-core placement with supervisor arguments and default budgets, then reproduces a sparse pipeline under the former placement policy and enables the fallback in place. It verifies restored cadence and income, completion of a waiting hot swap, target restoration, host RAM limits, and the unchanged rolling launch cap.

Run the focused tests and `npm test`; simulations use deterministic virtual time, not the browser game engine. Synchronize the daemon, target-pipelines module, helper and all three worker entry files together; the worker dependency revision is `generation-control-v3`.
