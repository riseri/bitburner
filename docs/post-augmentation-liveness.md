# Empty-pipeline recovery after a reset

An augmentation restart uses the normal supervisor entry point. The money pipeline
must not require two productive minutes (secondary-target admission) or fifteen
productive minutes (elective skill retuning) to recover when it has no work left.

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
Batch RAM failures and shared-budget skips are visible in the normal daemon view,
with the current rejection reason. Secondary admission reports actual progress
instead of retaining its initial 'waiting for productive runtime' message forever.
No timing, worker semantics, progression flag, Formulas API or extra target count
is introduced. Start with `run supervisor.js --profile assist` as before.

## Evidence and limits

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
Electron pauses. Inspect `Batch slots`, `Idle replans`, per-target income and
recovery after deploying. A cold deployment still requires one supervisor/daemon
restart and normal warmup; this change is not hot migration of existing workers.
