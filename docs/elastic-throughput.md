# Elastic throughput and fleet capital (PR3)

`--max-targets auto` is the default, with a hard ceiling of six. Explicit 1..6
limits are supported. One and two retain the existing admission behavior; auto
and larger limits admit only one trial at a time, after all incumbents are
productive. Free RAM alone is not sufficient. Small fleets can remain at one
lane indefinitely. Models continue to use the existing no-Formulas approximation.

Shared batch and launch budgets now default to AUTO, starting at up to 4 batches/s
and 32 planned launches/s. Stable timing and paid work permit bounded increases;
measured throughput validates them, and timing pressure or widespread faults back
off. Each new target still needs at least 0.25 batches/s remaining. A 3.95/4.00
budget blocks admission until capacity grows; bounded scouting continues through
that block to calculate profitable candidate headroom. Explicit numeric budgets
remain fixed and settings persist through reset bootstrap. More capacity permits
a trial; it does not guarantee that six targets will be useful. See
[adaptive budgets and RAM](scheduler-capacity.md#adaptive-budgets-and-coordinated-ram).

Running lanes and still-owned work count toward batch rate, launch commitments,
worker limits and temporal reservations. An empty retained tuning plan has no
batch-rate charge and cannot veto the healthy earner's scaling evidence.
An earning trial cannot prevent healthy timing from restoring pre-backoff
budgets; new speculative growth still waits for trial validation. Payout freshness
and productive-time credit use the interval after XP allocation and global
pacing. Income baselines follow shared pacing changes and their actual payouts,
so recovery does not blame the trial for income from older, slower admissions.
Candidate tuning uses a conservative RAM slice minus
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
The capacity can be a full fixed batch budget or the cash-covered final-server
money budget while AUTO still has open target slots. Those states compare richer
replacements instead of retaining two cheap bootstrap lanes indefinitely.
Ordinary money AUTO keeps its bounded rate-growth path before reaching its ceiling.

## Fleet decisions

The fleet consumes PR2's capacity snapshot. Dominant TARGET_SLOTS or
NO_PROFITABLE_TARGET and BATCH_RATE block speculative money expansion, including
surplus purchases. WORKER_LIMIT and RECOVERY constraints block both money and XP
expansion. LAUNCH_RATE also blocks expansion unless fresh whole-fleet XP proof
and the current optional launch ledger establish that an additional G/W worker
fits despite a money-specific split-batch rejection.
A secondary target ceiling does not prevent RAM from helping an existing
RAM-starved lane. PREPARATION permits evaluation only with RAM
pressure. RAM uses ordinary conservative ROI. NONE retains ROI/surplus policy.
Measured adaptive RAM requests can also justify growing existing lanes at their
target-count ceiling. These requests require productive remote RAM pressure and
actual throughput headroom; they do not bypass batch/launch/process/recovery
limits. Incumbents must have modeled room to improve steal/cadence or a useful
additional lane must need memory. Quotes add at most twice the bounded 25% request, select useful server
sizes, and retain live ROI, named savings, action caps and reset protection.
Secondary shared constraints can veto spending too. A usable XP_RAM request is
independent of money batch rate, target slots and unconstrained preparation.

XP_RAM requires an active hacking progression goal, an independent usable XP
target, and desired RAM above actual allocation. A candidate may add at most
twice the unmet demand, and its cost must be recoverable from current income
within 300 seconds or the configured shorter payback horizon. This is a capital
recovery bound for progression spending, not a fabricated monetary XP ROI.
Missing Formulas or insufficient XP evidence preserves capital safely.

At the cash-covered final-server hacking goal, prepared G/W XP can request 25%
more RAM when the remote fleet is filled and three positive completed-wave
observations agree within 25%, or when fresh allocator evidence shows home and
remote capacity filled for 60 seconds of healthy paid work and timing. The latter
can fund a bounded model-based warmup step without waiting for long waves to
complete; it does not override mature zero/noisy XP measurements. A positive
script model is required. Idle eligible RAM, player-work-only XP, XP prep or H
thread caps do not justify expansion. The fleet chooses the largest candidate within the
unmet-demand and recovery bounds, including when buying its first server for XP.
Qualified augmentation resets hold this spending during their observation window.
New/upgraded cloud capacity joins prepared G/W work without restarting the
current wave, subject to its existing money reservations and shared budgets.
Trial validation is independent of this prepared XP proof: one healthy paid
incumbent, safe global timing and full usable XP capacity can justify the step
while another money target collects its trial evidence.

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
Two further 22-minute simulations with the same candidates and a 100 ms gap
retain two healthy targets at 4 batches/s and 32 launches/s, then reach three
at explicitly configured 6 batches/s and 64 launches/s. Both stay within their
configured rate ceiling and preserve clean-security action starts. These numeric
budgets remain fixed user settings. A further 22-minute default-AUTO simulation
starts at 4/32 and reaches three healthy earning lanes with higher measured
income than fixed 4/32 in the same model (about $4.14b/s versus $2.90b/s, at
5.971/52 in the current model). This validates
adaptive scaling in the deterministic model, not live income.
A separate regression reproduces a 64 TB home, 2.71 TB remote fleet, empty
retained support plan and mostly-home XP allocation. After healthy observations
it publishes a 13.35 TB bounded XP demand and reaches the actual cloud actor's
16 TB purchase. Prepared XP also adopts new memory while keeping existing PIDs;
future money reservations and launch/process ceilings prevent unsafe adoption.
A second home-heavy regression reproduces the earning megacorp trial, 2.25/16
backoff, 3.24 TB remote RAM and 59.61 TB prepared XP, with only about 412 GB still
allocatable. It restores budgets before trial completion and reaches the cloud
actor's 16 TB purchase despite a fragmented money-batch launch constraint.
A complete-loop simulation with two injected global backoffs restores capacity
while a long-action trial validates, then reaches three paid lanes at 5.984/52
and about $4.82b/s. It preserves HWGW order and worker ownership.
The final-server policy regression at level 7814 retains 70% XP pacing through
read-only shadow searches, launches over 63 TB of home XP, and preserves money
reservations. A separate full-loop model at fixed 3/52 replaces a cheap bootstrap
lane below AUTO's ceiling, raising measured income from about $7.44m/s to $24.01b/s
while the survivor keeps paying. A continuously changing-duration model completes
three real retunes with no phase misses. These are deterministic regressions,
not predictions of the user's income or a live in-game verification.
An adaptive two-lane cutover with an injected hard secondary fault reconciles
once, restores earning, and preserves the peer's minute-by-minute income. A
stale generation failure cannot reopen recovery during the rebuilt epoch's prep.
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

The adaptive controller consumes live `capacity` observations to coordinate rate
budgets and productive RAM expansion. Timing and process constraints remain
authoritative. Home-core purchasing and opportunistic home-core G/W now have
their own execution and investment evidence; see [home G/W](home-gw.md).
