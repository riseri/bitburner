# Startup and recovery after an augmentation reset

An augmentation restart uses the normal supervisor entry point. The money pipeline
must not require two productive minutes (secondary-target admission) to recover
when it has no work left. Skill changes use background plan tuning.

## Small-fleet startup

On a few hundred GB, average RAM usage can hide batch peaks and leave too little
room to change plans. The tuner now reserves headroom for two estimated complete
HWGW batches before choosing the RAM-limited period. This allowance is capped at
half the available capacity so tiny fleets can still run larger minimum batches;
a single estimated batch must fit available capacity. Home reserves and other
processes are deducted before this calculation. Large fleets whose cadence is
already limited by timing or launch budgets generally retain the same cadence.

If a replacement fails the real overlap RAM check, the yielding tuner searches
for a smaller improving plan whose two transition batches fit beside committed
work. Probes include peer, foreign and prep RAM and worker/launch limits, roll
back their temporary reservations, and never cancel a worker. Commitment checks
the selected plan again. When nothing improving fits, existing work continues
and searches retry with backoff.

These changes reduce repeated deferrals and stale-plan waits after installation.
They cannot remove target preparation or the first action warmup after a cold
restart. An empty second slot can also remain empty until there is a prepared,
worthwhile target and spare shared capacity. Leave the supervisor running; no
special reset flags or increased launch limits are required.

A `RUNNING` target with a clean server, no workers and no queued operations is not
necessarily warming up. Batch reservation and shared workload admission can fail
without any worker phase missing its deadline. The previous compact dashboard hid
those failures, and the previous scheduler had no idle replanning path.

## Recovery

After five seconds with no queue, tracked workers, batches or active repair, the
controller can rebuild that target's plan with its current player/server/fleet
state. This path does not require previous earnings or a recent Hack completion.
It never clears an outstanding batch, live owned reservation or globally tracked
worker. Only terminal reservations owned by the idle target are removed; the
other target's state and control latch remain intact.

A clean target goes directly to incremental tuning, not full grow/weaken prep.
A dirty target uses its existing target-local preparation path. Earnings remain
in the session totals. The target epoch changes, and `Idle replans` counts these
attempts separately from fallback drains and process restarts.

Idle tuning tests candidate batches against the actual shared RAM allocator,
worker-count limit and launch budget. These probes never execute or cancel a
worker and always roll back their temporary reservations. Infeasible candidates
can be replaced by smaller plans. Persistent failure retries with exponential
backoff capped at five minutes, rather than pretending to be earning. One feasible
batch is not a proof of steady-state feasibility; ongoing admission still checks
every batch. A permanently insufficient fleet can remain blocked pending capacity.

## Visibility

The scheduler/supervisor status distinguishes an empty overdue lane as `IDLE`.
Current batch admission waits are visible as `Scheduler capacity` in the normal
daemon view, with the current reason. Historical RAM and rate-limit deferrals stay
in the detailed diagnostics and do not keep an attention banner visible after the
scheduler is accepting again. Secondary admission reports actual progress
instead of retaining its initial 'waiting for productive runtime' message forever.
No timing, worker semantics, progression flag, Formulas API or extra target count
is introduced. Start with `run supervisor.js --profile assist` as before.

## Evidence and limits

`test/small-fleet-startup-simulation.test.cjs` uses a 356 GB fleet, a level-10 to
level-66 startup, and both 8 GB and 96 GB home reserves. It verifies first income
after one initial warmup, one successful plan change, continuing payouts,
measured cadence, restored money/security and host RAM limits. Successful Hacks
are deterministic here to separate scheduler gaps from random failed payouts.
Hot-swap tests also cover choosing a smaller feasible candidate and bounded,
yielding searches when all replacements remain blocked.

Tests deliberately make a previously earning plan infeasible on a 128 TB,
six-core-home fixture, before its productive-time gates are satisfied. The old
source remains idle; the new source replans and resumes measured income without
cancelling workers or counting a fallback. Another simulation combines that
home-heavy fleet with rapid skill growth and incremental cloud expansion.
Deterministic tests cover quiescent ownership, peer preservation, dirty targets,
retry backoff, candidate feasibility and pure reservation rollback.

The injected infeasible plan reproduces the *class* of clean/empty starvation,
not the exact unobserved trigger in the user's save. The original screenshot lacks
admission counters and does not establish why its first admission failure occurred.
These simulations do not emulate Netscript RAM analysis, real API CPU cost or
Electron pauses. Inspect `Batch admission`, `Idle replans`, per-target income and
recovery after deploying. A cold deployment still requires one supervisor/daemon
restart and normal warmup; this change is not hot migration of existing workers.
