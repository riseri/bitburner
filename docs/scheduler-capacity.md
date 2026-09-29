# Scheduler capacity and deadlines (PR2)

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

XP demand is the existing progression allocation applied to worker RAM. Pressure
requires an independent selected XP target and insufficient allocatable RAM;
missing Formulas/candidate evidence cannot invent pressure. Its scheduling and
reclamation rules are unchanged.

## Verification

Files: `lib/target-pipelines.js`, `lib/scheduler-capacity.js`, `lib/hacking-xp.js`,
`lib/dashboard.js`, `daemon.js`, `supervisor.js`, `scheduler-capacity.test.cjs`,
and the capacity-display assertion in `scheduler-liveness.test.cjs`.
Nine focused tests cover idle wake counts, close launches, event arrival, observation cadence, limiting
factors, XP pressure, and small-fleet/missing-capability behavior. Existing timing,
ownership, recovery, hot-swap, background-prep, XP, one- and two-target simulations
remain in the complete suite. Full results are recorded in the PR description.

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

Capacity telemetry describes observed constraints; it does not change fleet
investment yet. Elastic lane admission and capital consumption follow in PR3.
Adaptive rate tuning and temporal-reservation optimization remain deferred.
