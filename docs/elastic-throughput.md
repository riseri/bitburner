# Elastic throughput and fleet capital (PR3)

`--max-targets auto` is the default, with a hard ceiling of six. Explicit 1..6
limits are supported. One and two retain the existing admission behavior; auto
and larger limits admit only one trial at a time, after all incumbents are
productive. Free RAM alone is not sufficient. Small fleets can remain at one
lane indefinitely. Models continue to use the existing no-Formulas approximation.

All lanes count toward remaining batch rate, launch commitments, worker limits,
and temporal reservations. Candidate tuning uses a conservative RAM slice minus
incumbent and XP needs and probes actual whole-batch placement. It does not retune
incumbents to manufacture room. The minimum candidate model is the configured
switch improvement times aggregate incumbent income (25% at the default 1.25).
Measured trials protect every incumbent and require aggregate improvement, with
the existing sustained-evidence and cooldown rules. A peer's independent recovery
does not justify retiring a healthy established lane.

At full capacity, one background-prep candidate can replace the weakest useful
lane after clearing the replacement threshold. Remaining rate subtracts every
surviving lane. Existing anchor priority is retained unless the anchor itself
is replaced. Only the replaced lane drains; committed workers, unrelated PIDs,
recovery and XP ownership retain their existing rules.

## Fleet decisions

The fleet consumes PR2's capacity snapshot. Dominant TARGET_SLOTS or
NO_PROFITABLE_TARGET, and shared BATCH_RATE, LAUNCH_RATE, WORKER_LIMIT or RECOVERY
constraints block speculative expansion, including surplus purchases.
A secondary target ceiling does not prevent RAM from helping an existing
RAM-starved lane. PREPARATION permits evaluation only with RAM
pressure. RAM uses ordinary conservative ROI. NONE retains ROI/surplus policy.
Secondary non-RAM constraints can veto spending too.

XP_RAM requires an active hacking progression goal, an independent usable XP
target, and desired RAM above actual allocation. A candidate may add at most
twice the unmet demand, and its cost must be recoverable from current income
within 300 seconds or the configured shorter payback horizon. This is a capital
recovery bound for progression spending, not a fabricated monetary XP ROI.
Missing Formulas or insufficient XP evidence preserves capital safely.

The first small cloud server retains telemetry-free bootstrap. Existing legacy
JIT snapshots can still support conservative ROI during upgrades; stale or missing
snapshots no longer authorize subsequent automatic surplus purchases. Explicit
sizing and ROI opt-out remain available, but known hard capacity constraints and
reset/savings protections still apply.

The manager publishes the existing authenticated capital request. The supervisor
arbitrates it at priority 79, below Navigator 84 and critical progression. Before
spending, the fleet rechecks cash, named savings, action limits, live cost,
installation state and scheduler evidence. Protected reserves are never released
unilaterally. Dashboard capacity rows expose AUTO bounds and trial/replacement
decisions; fleet capital shows why spending is held or justified.

## Engineering and compatibility report

Implementation: `lib/target-limit.js`, `lib/target-pipelines.js`,
`lib/scheduler-capacity.js`, `lib/hacking-xp.js`, `lib/fleet-economics.js`,
`lib/dashboard.js`, `daemon.js`, `supervisor.js`, and `fleet-manager.js`.
Tests: `elastic-capacity.test.cjs`, `elastic-simulation.test.cjs`, additions to
`fleet-capital.test.cjs`, and the intentionally changed stale-surplus assertion
in `automation-planning.test.cjs`. README, multi-target and usage docs are updated.

Tests cover explicit limits, aggregate accounting, worker/launch/RAM/XP/recovery
backpressure, profitable-candidate requirements, three/four automatic lanes,
tiny no-Formulas operation, weakest-lane promotion, independent recovery,
background preparation, unrelated process ownership, cloud bootstrap, each
non-RAM spending veto, useful RAM/XP purchases, and changing evidence at the quote.
The complete suite includes all existing one/two-target, hot-swap, starter,
capability and savings tests. Exact final counts are in the PR description.

The 22-minute no-Formulas model produces three or four validated earning lanes;
auto reaches four when four worthwhile candidates exist. These are intentionally
expanded earning behaviors, while explicit one/two-target safety remains intact.
The extended four-lane scenario recovers one lane and later prepares/replaces the
weakest without cancelling healthy peers' Hacks or interrupting their minute-by-
minute income. No live BN4 soak or completion-time measurement was performed.

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

Resident source/API inventory against PR2 adds no Netscript API references to
supervisor, daemon, starter, fleet, progression or purchase actor. New numeric
accounting uses the existing ledgers. Actual installed-game RAM is unmeasured;
this is a source audit plus deterministic starter regression coverage.

The next optimization should follow live `capacity` observations: sustained
BATCH_RATE/LAUNCH_RATE with spare RAM and low measured drift is evidence to
investigate adaptive rate tuning. If RAM dominates, compare allocation pressure
and recovery before buying further capacity. Home-core purchasing, opportunistic
home-core G/W and reservation-query redesign remain intentionally deferred.
