# Controlled multi-target JIT

The money engine now runs a collection of independent target pipelines inside
**one daemon**. Automatic mode admits up to six earning targets, one trial at a
time. Explicit limits 1 through 6 are supported; 1 and 2 retain their established
admission behavior. See [elastic throughput](elastic-throughput.md) for global
capacity, marginal-value and cloud-investment policy.
This is concurrent hacking, not merely background preparation and not shotgun
batching. Each phase still starts JIT, using the existing clean-security worker
and `additionalMsec`. The defaults remain a 100 ms phase gap and a 600 ms launch
cushion. Each target can independently back off on a hard recovery.

## Startup and admission

The initial target is selected and prepared as before. After two minutes of
productive completed batches and a recent Hack completion, the scheduler can
admit one more target. It checks already-ready targets first, including the
background-prepared candidate. A newly started process does not inherit the old
process's prepared-candidate state, so the ready scan also supports starting on
the richer target and adding a useful smaller target later.

Productive time is the sum of each safely completed batch's actual admitted
interval, including XP allocation and global pacing.
Generation changes preserve that progress, including old-generation batches
finishing during a swap. Failed or skipped batches receive no credit. Background
prep and admission use this same total; recent-Hack and health checks still apply.

If no useful ready target exists, the protected background G/W preparation path
continues. An empty second slot accepts a candidate that provides the incremental
income improvement implied by the switch threshold, even when that candidate earns
less than the priority lane. Replacing an occupied support lane still requires the
candidate to beat that lane by the full switch threshold. Admission rechecks actual
health and builds a **fresh** plan with real hack chance, thread requirements,
timing and shared resource constraints. The scouting upper bound is never treated
as an earning rate. Live tuning yields
between small search steps rather than running the entire search in the hot loop.
Peers keep earning during tuning and initial warmup. Once the configured slots
are full and all lanes are stable and productive, spare RAM can prepare a
replacement candidate. The same applies below AUTO's six-target ceiling when
the shared batch budget is full and fixed, at its safety ceiling, or held for
the final-server XP goal. Cheap bootstrap lanes must not prevent a richer target
from being compared. Ordinary money AUTO can grow the rate budget first.
A stronger ready candidate replaces the weakest lane
after its owned work drains; unrelated lanes continue earning.

A target that has stopped earning for ten minutes can also be replaced when its
peer is validated and productive. Initial warmup is allowed to finish first.
This replacement uses the empty-slot marginal income floor instead of requiring
a candidate to beat the stalled target's old model. Preparation uses spare RAM
and the healthy peer's health checks; the old target still drains owned work
before the replacement is admitted. If the old target recovers, normal promotion
requirements apply again.

Quiescent established targets receive the same incremental tuning opportunities
as new trials, including scheduler gaps above 20 ms. If maintenance cannot get a
window for five seconds, new batch planning is deferred until a gap above 50 ms
opens. Committed launches continue to run. Maintenance rotates between targets
so one target's preparation cannot monopolize the available windows.

Formula, skill, and capacity retunes are elective. The daemon never drains its only
productive lane for one of those optimizations; it waits until another fully
productive lane can cover income. Safety recovery may still pause the affected
target. Pipeline health treats income as recent for at least two planned batch
periods, so a valid low-rate plan does not falsely block background preparation.

## Shared limits and priority

The whole controller has one host RAM reservation ledger, one process map and one
worker event port. Each target owns its own queue, batches, stats, epoch, recovery
and running-worker view. Reservations and chunk IDs include target ownership;
chunks use a globally unique owner/slot/epoch/batch identity.

Default combined limits are:

| Limit | Default | Meaning |
| --- | ---: | --- |
| Active targets | AUTO, max 6 | Ceiling including warming or draining lanes; admission still needs capacity |
| Admission batch rate | AUTO, starts at up to 4/s | Shared rate; automatically paced when budgets decrease |
| Worker commitments | 6,000 | Queued plus running chunks across all targets |
| Planned worker launches | AUTO, starts at 32/s | Shared rolling-window admission budget; bounded at 128/s |

The launch ledger uses 250 ms bins and conservatively checks every overlapping
five-bin interval against the one-second budget. Split phases count every worker.
All money lanes share the full global launch ledger. Optional XP/prep leave a
quarter of the budget, capped at eight launches/s, for money, while keeping a
minimum four-launch allowance so prep can progress at explicit tiny limits. A
bounded launch loop services the earliest committed launches from both queues;
rate limiting rejects **new reservations**, not already-committed due workers.
These are planned-time limits, not a guarantee against an execution burst after
game suspension or a long shared pause.

Target AUTO sets the target-count ceiling. Rate budgets independently default
to AUTO and adapt to measured timing and usable demand. New admission still
requires at least 0.25 batches/s remaining. At a current 4/s budget, two plans
totaling 3.95/s leave only 0.05/s; the controller can test a larger budget after
stable paid work, using bounded scouting to calculate useful candidate headroom.
Detailed capacity rows show this batch headroom separately from recent launches,
future reserved launch peaks, shared money budget and current whole-batch demand. A modeled
`Next candidate` is a scouting result, not a selected or admitted pipeline.

The supervisor accepts `--max-batch-rate auto` and `--max-launches auto` by
default, with fixed numeric overrides (batch rate in (0,8], launches in 4..128).
It forwards settings to a new daemon and preserves AUTO and explicit values
for reset bootstrap. Automatic budget decreases pace future admissions across
lanes without cancelling their committed workers or changing their plans.
Raising them permits further admission only when RAM, launch placement, income
and trial health checks pass. An adopted daemon keeps its original arguments;
stop the old supervisor and daemon before starting with changed settings.
See [adaptive budgets and RAM](scheduler-capacity.md#adaptive-budgets-and-coordinated-ram).

A new trial is initially sized against at most 25% of schedulable fleet RAM and
the remaining batch/process budgets. The real shared allocator is still the final
admission check. No target can allocate a private copy of all the RAM. Background
and repair RAM holds are also subtracted exactly once and can be reclaimed by an
income reservation. A reservation for a late, still-running worker does not
vanish merely because its predicted completion passed.

## Independent recovery and bounded withdrawal

One versioned control document contains a pause latch and epoch **per target**.
Workers fail closed on a missing/stale epoch. Pausing one target neither replaces
its peer's entry nor suppresses the peer's Hack calls. The existing local-repair
policy, immutable 15-second deadline and security circuit breaker remain.

A hard fault cancels only that target's damaging actions in bounded slices and
retains its useful Weaken tails. When those finish, only its reservation/batch
state is cleared. Required G/W preparation proceeds asynchronously through owned
repair workers; the healthy peer is not blocked by a call to `prepTarget()`.
A fault during a new trial can withdraw that trial rather than repeatedly reset
it. Skill/capacity retunes are target-local and deferred while a peer is in a
trial, warmup or recovery. Capacity gains only trigger a retune when the current
plan is materially RAM-limited, after a cooldown and productive runtime.

The initial earner is protected while its new peer is evaluated. A shared-load
guard withdraws the optional lane for repeated large controller lags, misses on
both lanes, or repeated resource admission failures on the protected lane. A
single target-local hard fault is not, by itself, blamed on the healthy peer.

After the second lane has a full income window, the measured-income guard checks
that it earns, that the incumbent retains at least 70% of its admission baseline,
and that combined income remains at least 95% of that baseline. Sustained failure
for 60 seconds winds down the optional target. These thresholds allow stochastic
hack results; they are heuristics, not a mathematically optimal portfolio selector.
Shared budget backoff or deliberate XP allocation adjusts the baseline to the
same money pacing, with restoration following recent paid work rather than
assuming an immediate income gain. A trial's own contention or weaker plan does
not lower its admission baseline. Recent income checks also use the actual
admission interval, avoiding false WARMUP labels between deliberately slow payouts.
After a successful three-minute post-warmup trial, the higher measured earner
gets priority. The smaller earner becomes optional and remains subject to the
same shared-load/income protections. Retired targets keep their earned-money
history and have a ten-minute readmission cooldown.

If the incumbent stops earning or is tuning/recovering, a trial can validate
independently. It must finish its original observation period, accumulate two
productive minutes, and then sustain three minutes of recent income with new
successful batches. Measured income must reach either 95% of the incumbent's
admission income baseline or 70% of the trial's own modeled income, so a failed
richer incumbent cannot permanently block a viable smaller successor.
A new worker miss or income gap resets that independent evidence window. Shared
overload checks still apply. The incumbent's rebuild cycles do not erase the
healthy trial's own evidence. On success the earning trial gets priority while
the stalled incumbent continues recovery or becomes eligible for replacement.

A normal retirement stops new admissions and queued Hacks, lets committed repair
tails settle, then releases only owned state. Catastrophic retirement cancels
owned damaging actions too. A controller shutdown explicitly cancels its own
recorded workers and prep children, but not unrelated PIDs. Initial startup still
cleans legacy JIT worker filenames, so **do not run multiple daemons together**.

## Dashboard

The daemon shows combined *measured* income separately from summed active plan
estimates, then per-target state, role, income, batch pace and recovery. Warmup,
local recovery, drain, asynchronous prep, tuning and retired states are explicit.
Session earnings include money from retired targets, without counting it twice.
After handing a candidate to a pipeline, background prep returns to WAITING.
When admission is held with no selected preparation target, it reports PAUSED
and the current gate; it does not retain an old ADMITTED label on an empty target.
The supervisor reads a versioned, PID-matched status snapshot on the existing JIT
status port and falls back to legacy single-target log parsing when appropriate.
Home cores, fleet capacity, progression and contract status remain available.

No previous prep potential is added to actual or model income. The first target
is still displayed in the older compact view while it is the only normal lane.

## Deployment and controls

After the PR is approved and merged:

```sh
git switch main
git pull
```

Let Filesync synchronize **all of src**, including `lib/target-pipelines.js`, the
updated `lib/jit-worker.js`, daemon, supervisor and background-prep helper. On
home, use `ps` to find and stop the old supervisor PID first, then the daemon PID.
The normal startup preserving progression actions is:

```text
run supervisor.js
```

`--dashboard-details true` is still available. To retain prep-only single-target
behavior on the next startup:

```text
run supervisor.js --max-targets 1
```

The supervisor forwards `--max-targets`, `--max-batch-rate` and `--max-launches`
to a newly started daemon. Existing process arguments cannot be changed by
starting another supervisor. Target limits support AUTO and explicit 1..6;
`--max-workers` remains a daemon-only setting. Reducing shared budgets may reduce
income or prevent another target's admission. `--target` selects the initial target, not necessarily
the only target; combine it with `--max-targets 1` to lock a single earning lane.
`--background-prep false` disables new background preparation, not admission of
an already-ready target. Existing progression action settings remain preserved.

This is not a hot migration of running batches: deployment still requires one
restart and initial warmup. Automatic admission of the next ready target then
happens inside that same daemon, without another manual restart.

After syncing code, `run supervisor-restart.js` reloads the supervisor, daemon,
and fleet manager using the saved supervisor settings. This stops the existing
scheduler before its replacement starts; already-running other services are
adopted as usual.

## Validation

Run `npm test` with Node 22. Tests execute the actual daemon, worker and scheduler
source against virtual time, per-target server state, processes, ports and RAM.
In addition to the existing suites, multi-target tests cover mixed/stale events,
idempotent accounting, per-target pause/epoch isolation, shared RAM, rolling
launch budgets, retained late-worker reservations, bounded withdrawal and typed
supervisor status.

The concurrent scenarios compare against a one-target baseline, inject a shared
70 ms hiccup, deliberately miss the secondary W2 call, force security to 100 on
each target in turn, refuse new-target Hack execution, and test startup on the
richer ready target plus shutdown ownership. They assert actual income from both
lanes, uninterrupted peer income windows, no unrelated worker cancellation and
RAM below each host's capacity.

Simulation is **not a live in-game soak**. It does not emulate Netscript static
RAM analysis, real API execution cost, Electron garbage collection, external
scripts or suspended/offline time. Passing tests supports the tested ownership,
resource and recovery invariants, not guaranteed dollars/second or universal
stability. Monitor per-target income, combined income and recovery after the
first live multi-target warmup before considering tighter timing. The hard limit
is six. Promotion waits for a safe handoff and drains only the replaced lane.
