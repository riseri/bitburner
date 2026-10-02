# Scheduler capacity, adaptive budgets and deadlines

Home G/W is now reported separately in `capacity.homeGw`; it is never included
in generic fleet RAM. See [home execution and capital](home-gw.md) for protection,
rolling usage evidence, asymmetric planning and infrastructure arbitration.

The JIT status has a versioned `capacity` projection of existing ledgers: usable,
occupied and foreign worker RAM; active/available lanes and modeled candidates;
aggregate batch rate; recent launch buckets; running, queued and prep commitments;
XP desired/allocated RAM; prep/recovery state; and loop/launch/landing drift.
`limitingFactor`, `constraints`, and `reasons` distinguish RAM from throughput and
progression pressure. RAM utilization alone is not evidence of a bottleneck.
Inactive target values are model evidence, not a promise of achievable income.

The dashboard renderer is shared by supervisor and daemon. It presents compact
capacity rows, with secondary explanations behind dashboard details. Capacity
collection performs no extra network scan or optional API calls.

Detailed capacity includes `batchRate.nextRequired` (0.25/s with an open target
slot), `nextBlocked` and remaining rate. This admission requirement is separate
from a global BATCH_RATE ceiling, so it does not create a new fleet-spending veto.
`launches.peakReserved` and `peakBucket` show current/future committed launch
pressure. All money lanes use the same full global budget. XP/prep leave a
quarter of the budget, capped at eight launches/s, for money headroom; a minimum
four-launch allowance keeps one optional worker bin usable. Recent launches below 32/s can
still coexist with a rejected whole batch or a full future bucket. The Admission
row includes both candidate identity and its reason, rather than hiding the gate
when a candidate is present.
`launches.requiredLimit` and `Launch demand` describe a recent rejected whole
batch, including its placement beside existing reservations. A burst of split
workers can exceed the per-bin limit even with a low total held count. This
structured demand expires after 15 seconds and clears on successful admission;
old rejection text cannot permanently label a healthy ledger LAUNCH_RATE.

## Adaptive budgets and coordinated RAM

Both `--max-batch-rate` and `--max-launches` default to `auto` in the daemon and
supervisor. They start at up to 4 batches/s and 32 launches/s. Numeric overrides
remain fixed (batch rate in (0,8], launches integer 4..128); mixed AUTO/fixed
settings are supported. AUTO values and fixed overrides survive reset bootstrap.
An adopted running daemon keeps its own settings and code until restarted.

`lib/scheduler-scaling.js` evaluates fresh 10-second timing windows. Growth needs
productive lanes with running or committed work, recent paid income, no active trial/cutover/prep,
and 60 seconds of stable timing observations. Lifetime lag/drift maxima do not
veto growth. A bounded read-only scout checks at most eight known servers per
sample, including while admission is blocked, to calculate the batch headroom
needed for a candidate to clear the existing marginal-income floor.
An empty retained TUNING plan consumes no batch budget and cannot prevent the
healthy earner from establishing timing evidence. Target work rows distinguish
running/committed lanes from waiting lanes. Tuning accounts for home and remote
peer placements separately, preserving the remote hack ceiling and whole-batch
reservation checks. Income probes compare actual dollars per second.

Batch budget steps use useful candidate demand, bounded to 25% (minimum 0.5/s).
Launch steps add at least 8/s, ordinarily 25%, including coordinated batch
increases. The automatic batch ceiling follows target count and phase cadence:
`min(128 / 4, maxTargets * 1000 / (4 * gap + 20))`. The launch safety envelope is
128/s; the shared 6,000 worker ceiling and actual whole-batch RAM/launch placement
remain authoritative. This is bounded adaptation, not a claim of an exact optimum.

The controller waits for increased-budget work to land and compares measured
income, or stable completed-wave XP rates for cash-covered FINAL_SERVER hacking.
No measured gain of at least 3% returns to the earlier budgets with a 10-minute
hold. Multiple bounded steps can be needed to obtain a whole candidate's modeled
headroom; those retain the original comparison baseline. Recent timing pressure
or new faults across multiple lanes reduce automatic budgets by 25% with a
two-minute cooldown. A fault confined to one target uses local recovery and
pauses expansion. Only future admissions are paced; committed worker deadlines,
PIDs, plans and HWGW restoration remain owned by the existing scheduler.
Recovery of the pre-backoff budgets is separate from speculative expansion.
After the cooldown and healthy observation window, a productive incumbent and
fresh global timing permit bounded `RESTORE` steps even while a current trial
validates. Recovery, active prep, unsafe timing and pending resets still prevent
restoration. New growth beyond those prior budgets requires validated lanes.
`Recover budget` shows the prior budgets that remain to be restored.
Recent-Hack checks use the actual interval after XP allocation and global pacing,
including slower batches still committed before restoration. Completed batches
credit that immutable admitted interval. Trial income comparisons account only
for shared budget/XP policy changes and the policies of recent paid batches;
admitting a trial or stealing a peer's throughput does not lower its hurdle.

Productive remote RAM pressure (a real RAM placement blocker or at least 85%
utilization) with batch/launch/process headroom can request one 25% RAM step.
`ram.scalable` also requires modeled room to improve an incumbent's steal size or
period, or memory for a useful additional lane. Plans already at their safe
cadence and configured steal cap do not justify more memory on utilization alone.
If a rate probe needs this memory before its benefit can appear, it retains its
baseline while funding the step, then measures after the new work lands. Cloud
quotes may add at most twice the request, must pass the existing conservative
ROI, and are rechecked against live scheduler demand, prices, reserves, action
caps and resets at the transaction. A disappeared request cannot fall back to
the first-server bootstrap shortcut. Cash-covered endgame skill goals use the
existing productive XP expansion proof instead of expanding money workloads.

`capacity.scaling` publishes the modes, cadence/safety ceilings, decision, reason,
fresh timing window and bounded RAM request. Both dashboards show the current
decision and its reason. `batchRate.modeled` retains raw plan rates while `used`
reports the shared governed admission rate after an automatic decrease.

The single scheduler loop computes its next wake from committed launches (2 ms
guard), event servicing, health/recovery, admission, planning horizon, yielding
tuners, XP/prep, cleanup, observation and UI deadlines. Events already queued are
serviced immediately; arrivals during sleep wait at most 25 ms with running
workers (less for narrow gaps), or 100 ms without workers. This uses bounded
event polling rather than accumulating uncancellable port-wait promises.
Intentional sleep is excluded from loop-lag telemetry.

Foreign RAM inspection normally rotates one host every 200 ms. Allocation/exec
failure, host churn and changed foreign use accelerate observation for two
seconds; recovery uses 25 ms. Existing live `exec` admission and failure recovery
remain authoritative if foreign usage changes between observations. There is
no second scheduling loop and no change to worker landing instructions.

XP demand normally uses the progression allocation applied to worker RAM.
Pressure requires an independent selected XP target and insufficient allocatable
RAM. At a cash-covered FINAL_SERVER hacking goal, `xp.expansion` can request 25%
more RAM for prepared G/W XP work. Three stable positive completed-wave rates
support measured expansion on a filled remote fleet. Fresh allocator evidence
also recognizes a fleet whose home XP and money reservations fill usable RAM:
60 seconds of healthy paid work and timing with at most 2% of current XP RAM
still allocatable permit a bounded `MODEL (warmup)` request before long waves
finish. Three mature zero/noisy samples cannot be replaced by that warmup model.
An earning target trial does not invalidate independently prepared XP capacity
when the incumbent and global timing are healthy. A money-specific split-batch
launch constraint can coexist with a usable single XP launch. Fresh whole-fleet
proof and actual optional launch/process headroom are required for that exception;
worker/recovery/reset limits still veto spending.
`XP expansion` reports the amount and confidence; `XP capital` reports the
observation window. Idle eligible RAM, university-only XP, prep, H thread caps,
missing models and pending/imminent resets do not qualify. New/upgraded remote
RAM can join a running prepared G/W wave without restarting existing workers.
Money reservations and actual preemption retain priority;
see [XP execution and capital rules](hacking-policy.md).

## Verification

Files: `lib/target-pipelines.js`, `lib/scheduler-capacity.js`, `lib/scheduler-scaling.js`, `lib/hacking-xp.js`,
`lib/dashboard.js`, `daemon.js`, `supervisor.js`, `scheduler-capacity.test.cjs`,
and the capacity-display assertion in `scheduler-liveness.test.cjs`.
Tests cover idle wake counts, close launches, event arrival, observation cadence, limiting
factors, XP pressure, adaptive rate growth/backoff, coordinated RAM quotes, fixed
limits, reset restoration and small-fleet/missing-capability behavior. Existing timing,
ownership, recovery, hot-swap, background-prep, XP, one- and two-target simulations
remain in the complete suite. Full results are recorded in the PR description.
The trial simulation injects two global timing backoffs to 2.25/16 while real
workers continue. It restores capacity before trial completion and reaches three
earning lanes, with clean-security action starts, no phase misses, no cancelled
Hacks and RAM within host limits. This is a deterministic model, not a live-game
soak or a browser timing measurement.

Stable long-target simulation: 1,175 paid hacks and the same final income;
263,547 -> 100,912 virtual-clock events (about 62% fewer). Short-target simulation:
1,227 paid hacks unchanged; 201,260 -> 78,150 events. Dirty-start simulation:
135 paid hacks unchanged; 24,407 -> 9,675 events. Fault recovery remains safe but
is not timestamp-identical: isolated-W2 paid count 1,134 -> 1,190; catastrophic
fault 525 -> 529. Final rolling-income windows can differ after those faults.
These are deterministic simulator measurements, not live BN4 income guarantees.

Source import/API comparison against PR1 shows no new Netscript APIs in
supervisor, daemon, starter, fleet, progression, or purchase actor. Telemetry uses
ordinary JS data already maintained by the scheduler. Exact installed-game RAM
has not been measured; no new resident capability requirement is introduced.

| Supported state | Result |
| --- | --- |
| 8 GB / starter path | PASS |
| Small home RAM | PASS |
| No SF4 | PASS |
| No Singularity | PASS |
| No SF5 | PASS |
| No Formulas | PASS |
| No DarkscapeNavigator | PASS |
| Darknet disabled | PASS |
| No stock access | PASS |
| max-targets=1 | PASS |
| max-targets=2 | PASS |
| Manual progression fallback | PASS |

Capacity telemetry now drives adaptive budgets, elastic lane admission and
bounded fleet capital requests. Temporal-reservation optimization remains a
separate concern. New controller, cloud actor and bootstrap tests accompany the
existing timing, ownership and recovery simulations.
