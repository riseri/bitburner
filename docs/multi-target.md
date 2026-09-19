# Controlled two-target JIT

The money engine now runs a collection of independent target pipelines inside
**one daemon**. The first rollout allows one or two earning targets, default two.
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

If no useful ready target exists, the protected background G/W preparation path
continues. Admission rechecks actual health and builds a **fresh** plan with real
hack chance, thread requirements, timing and shared resource constraints. The
scouting upper bound is never treated as an earning rate. Live tuning yields
between small search steps rather than running the entire search in the hot loop.
The peer keeps earning during tuning and initial warmup. Once both slots are
occupied and both lanes are stable and productive, spare RAM can prepare a third
candidate. A stronger ready candidate replaces the support lane after its owned
work drains; at most two earning lanes remain active.

## Shared limits and priority

The whole controller has one host RAM reservation ledger, one process map and one
worker event port. Each target owns its own queue, batches, stats, epoch, recovery
and running-worker view. Reservations and chunk IDs include target ownership;
chunks use a globally unique owner/slot/epoch/batch identity.

Default combined limits are:

| Limit | Default | Meaning |
| --- | ---: | --- |
| Active targets | 2 | Hard rollout limit, including warming or draining lanes |
| Modeled batch rate | 4 batches/s | Sum of the two tuned batch rates |
| Worker commitments | 6,000 | Queued plus running chunks across both targets |
| Planned worker launches | 32/s | Shared rolling-window admission budget |

The launch ledger uses 250 ms bins and conservatively checks every overlapping
five-bin interval against the one-second budget. Split phases count every worker.
An optional lane retains less of the launch budget than the priority lane. A
bounded launch loop services the earliest committed launches from both queues;
rate limiting rejects **new reservations**, not already-committed due workers.
These are planned-time limits, not a guarantee against an execution burst after
game suspension or a long shared pause.

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
After a successful three-minute post-warmup trial, the higher measured earner
gets priority. The smaller earner becomes optional and remains subject to the
same shared-load/income protections. Retired targets keep their earned-money
history and have a ten-minute readmission cooldown.

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
run supervisor.js --progression-actions true
```

`--dashboard-details true` is still available. To retain prep-only single-target
behavior on the next startup:

```text
run supervisor.js --progression-actions true --max-targets 1
```

The supervisor forwards `--max-targets` to a newly started daemon. Existing
process arguments cannot be changed by starting another supervisor. The rollout
rejects values above two. Advanced daemon-only limits are `--max-batch-rate`,
`--max-workers`, and `--max-launches`; reducing them may reduce income or prevent
second-target admission. `--target` selects the initial target, not necessarily
the only target; combine it with `--max-targets 1` to lock a single earning lane.
`--background-prep false` disables new background preparation, not admission of
an already-ready target. Progression actions remain opt-in and unchanged.

This is not a hot migration of running batches: deployment still requires one
restart and initial warmup. Automatic admission of the next ready target then
happens inside that same daemon, without another manual restart.

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
first live two-target warmup before considering higher concurrency or tighter
timing. This rollout does not implement arbitrary target counts. Stable lanes can scout
and prepare a third candidate for a controlled replacement; promotion waits for
a safe handoff and drains the old support lane before admitting its replacement.
