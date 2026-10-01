# Dynamic progression policy

This extends the existing controllers. The supported automatic route remains
BN4.1 → BN4.2 → BN4.3, stopping at the existing route boundary. It uses explainable
heuristics, not an optimality claim. No sleeve, gang, or corporation manager was
found or added. Capability fields describe access hints, not running systems.

## Shared objective and decisions

The augmentation manager publishes a version-1 progression objective inside its
existing status on port 11. It includes producer name/PID, timestamp/reset epoch,
capabilities and accessible multipliers, distinct installed and owned lists,
queued distinct additions, Red Pill state, milestone/bottleneck, requirements,
selected basket, savings and install-versus-wait explanation. Purchases update
ownership before publication. Advice, savings, hacking policy, Go, fleet and the
dashboard consume this snapshot. Consumers require a matching live home producer
and reject snapshots older than 15 seconds, future timestamps, and wrong epochs.
The standalone planner and manual observations remain fallback paths.

Static augmentation metadata is cached for 60 seconds and invalidated by faction,
target or epoch changes. Prices, ownership and reputation are live each decision.
Catalogs omit repeatable NeuroFlux purchases from ordinary baskets. Once an
installation is approved and its execution checks pass, the augmentation manager
buys affordable NeuroFlux levels with existing reputation immediately before
installing. Extra levels count toward the existing installation threshold but add
no distinct augmentation; this pre-install pass never triggers or delays that
installation decision. After The Red Pill is installed, a separate
[endgame upgrade policy](endgame-upgrades.md) can acquire hacking augments and
NeuroFlux when measured completion and recovery estimates justify another reset.
Shadows of Anarchy's separate inflation system is excluded from default baskets;
an explicit single augmentation target from that faction is supported.

BN4 scoring favors economy and faction reputation early, skill/XP when limited
by hacking, and low-cost distinct additions before Daedalus. Current multipliers
discount impaired hacking-money benefits. Combat/company benefits need a relevant
strategy or an explicit target; this is not a general combat strategy. Queued
upgrades have zero immediate benefit and a separate post-install score.

Sellers are compared by concurrent cash/work ETA and, when allowed, donation cost
and favor. Measured work rates exclude this manager's donation spikes. Missing
rates are reported as unknown; fallback uses reputation gap and favor. Similar
sellers/plans keep their incumbent within a 10% margin. Purchase baskets evaluate
entire prerequisite chains, spendable cash, live rep and sequential inflation.
Affordable useful alternatives can outrank a currently unaffordable preferred
chain; explicit targets remain binding. A deferred chain reserves its full
estimated cost. Every actual purchase rechecks price, prerequisites, ownership,
reputation and savings. Standard inflation defaults to 1.9 adjusted for SF11.
Price-multiplier flags now default to 0 (automatic); a positive override is an
inspection/model assumption, never a spending authorization.

Five queued augmentations remains the default threshold. In the BN4 route a
valuable purchase within two minutes can briefly delay it. Completed batches,
Daedalus-count crossings and queued Red Pill retain their reset behavior. Progress
uses cash/reputation/ownership/skill high-water marks, not reset age. A blocked
batch can install after 30 minutes stalled or 60 minutes waiting on one objective.
Recovery evidence measures time to regain half the previous observed hacking
income after installation. When that evidence exists, a favor/donation unlock can
beat continuing faction work. Unknown recovery time is explicitly heuristic.
Red Pill installs immediately, with restart/manual-work checks intact; no further
automatic augmentation reset occurs after it is installed.

## Donation funding coordination

The selected seller still compares concurrent faction-work and cash ETAs against
donation plus purchase. Donation requires current favor eligibility, offered faction
work, a valid Formulas quote, and enabled donation settings. Seller hysteresis keeps
an incumbent within 10% of the best ETA. Missing donation formulas use the ordinary
work path. The supervisor forwards `--augmentation-donate`, work focus, and the cash
reserve to its read-only planner as well as its augmentation manager.

`lib/augmentation-funding.js` defines the authoritative current-run funding amount:

```js
(next.chainCost || next.price)
    + (next.donationPlanned ? next.donationCost : 0)
```

An absent selected item requires no funding; invalid quotes cannot authorize spending.
The chain already includes the current purchase. `acquisitionCost` is not added to
it. Only the actionable step's planned donation is funded; later chain donations
are quoted when those steps become actionable. Selected items expose `fundingCost`,
`progressionStrategy`, `workEtaMs`, and `donationEtaMs`. Fresh plans reprice cash,
reputation, and the selected seller while retaining the existing static catalog cache.

The version-1 progression snapshot keeps `requiredReputation` as the augmentation
requirement and adds `reputationStrategy` (`DONATE`, `WORK`, or `NONE`) plus `donation`
metadata: eligibility, faction, remaining reputation, quote, work/donation ETAs, and
required/remaining funding. `requiredCash` and `remainingCash` include the selected
donation. An unfunded donation path is limited by `cash`; a funded package is in the
`purchase` state. Work retains the `reputation` bottleneck. Daedalus, queued Red Pill
installation, and final-server milestone requirements keep their existing semantics.
The daemon consumes these generic fields through its existing reader and ETA policy.

Automatic savings use one `augmentation:<name>` target for the complete package,
divided by `1 - augmentationCashReserve` exactly once. Manual augmentation savings
mode retains its existing purchase-manually reserve semantics and uses the same
funding amount. Material quote changes update the durable goal; changes below the
larger of $1 or one part per million of the desired goal avoid file writes. Strategy
changes bypass that threshold, so even a tiny old donation reserve disappears when
work becomes preferable. Priority, target, and liquidity changes also update promptly.
High-priority liquidity goals retain a fresh heartbeat for the stock reader.

The donation inherits its augmentation's priority. Ordinary plans retain 70–72 and
cannot request stock liquidity. Red Pill, including a selected prerequisite for its
chain, retains 100 and existing authenticated liquidity eligibility. Daedalus (95)
and critical service RAM (90) still outrank ordinary augmentations. Authorized
performance/cloud requests at 79 can still outrank ordinary augmentation requests;
the shared arbiter decides. Spenders reread the complete selected savings floor, so
unapproved infrastructure and stock access cannot consume protected acquisition cash.

Player faction work continues while saving for donation, reducing the remaining
quote. Normal share RAM is off for the donation cash bottleneck; the work strategy
retains spare-only sharing and Red Pill's existing aggressive demand. Detailed
supervisor and standalone augmentation output show the selected strategy, rep gap,
work rate/ETA, donation quote/ETA, purchase/chain cost, and full funding progress.
Compact output adds the strategy to the existing selected/recommendation rows.

Immediately before donation the manager rereads live reputation, price, eligibility,
formula quote, cash, reserve, and savings. Donation and purchase can consume only
their matching supervisor goal; manual and unrelated savings remain protected.
Successful donation immediately rebuilds the plan from actual reputation and cash,
and purchase waits for the refreshed decision. Existing conservative reset economics
for donation-selected candidates remain unchanged.

| Worked example | Strategy and funding |
| --- | --- |
| Work 12m; donation path 3m; purchase $5b; donation $20b; cash $8b | DONATE; `requiredCash` $25b, remaining $17b; automatic goal $27.78b at a 10% reserve |
| Work 2m; donation path 7m; purchase $5b | WORK; funding $5b; automatic goal $5.56b at a 10% reserve; no donation reserve |
| Donation remains best as work reduces the rep gap from 1m to 400k; purchase $5b; quote drops $25b to $10b | Funding falls $30b to $15b; automatic goal falls $33.33b to $16.67b at a 10% reserve, with the same target |

Against baseline `1352836d861dfee41357e77fcecb3dc84f92465d`, recursive source/import
inventories add no Netscript API references to daemon, fleet manager, starter worker,
supervisor, progression manager, or augmentation producer/helper. Resident snapshot
and dashboard consumers gain only the pure funding module; starter worker imports
do not change. The standalone planner additionally imports the existing text-only
dashboard module. Actual installed-game RAM is not measured by the Node harness.

Donation-coordination validation (2026-09-29): 61 new regression tests and a stronger
matching-goal/manual-savings assertion. The focused planning, loop, progression,
milestone balance, supervisor, capital, reset-policy, and import run passed 245 tests.
The final `npm test` passed all 886 tests in 100.1 seconds, with zero failures,
skips, or cancellations. It includes all progression actions/milestones, savings,
stock liquidity, home/cloud investment, starter compatibility, and scheduler
simulations. `git diff --check` passed. Tests use repository mocks and simulations.

## Hacking, programs and home

Live backdoor requirements guide faction skill targets. Daedalus uses 2500 hacking
(or existing eligible combat stats); the final server uses its actual requirement,
including values above 2500. With Formulas, a measured milestone controller spaces
new money batches to balance cash and hacking ETAs, including before cash is fully
covered when hacking is behind. The 40% / 70% covered-cash and hacking-only values
remain conservative fallbacks; dynamic allocation uses bounded steps, a deadband
and cooldown within 10%–85%. See [Milestone ETA balancing](hacking-policy.md#milestone-eta-balancing)
for evidence rules and tuning. These are admission heuristics, not hard RAM
guarantees. Existing reservations, worker/launch
accounting, target separation, repairs and hot swaps remain unchanged. Money
continues; without Formulas the existing money/fallback behavior remains. Missing
BitNode multipliers do not suppress a valid progression target, but prevent an
exact XP ETA. A stale manager observation restores the conservative policy.

Program priorities consider newly rootable servers/RAM, subsystem RAM and cost.
Navigator can precede SQLInject when it enables a usable subsystem. Formulas is
considered deliberately when home has at least 64 GB and either cash is at least
four times its cost, measured income can recover its cost within 30 minutes, or
Red Pill is installed and the purchase is affordable. A purchase actor checks
live availability/price. Idle eligible program creation uses a conservative time
estimate only when it beats measured purchase ETA by 20%, takes at most 30 minutes,
and does not displace useful work. Disable it on the standalone manager with
`--program-creation false`; `--augmentation-work false` disables player work.

Starter graduation requires the supervisor, daemon, fleet, enabled progression,
and upgrade-helper headroom. This prevents a fresh 32 GB BN4.1 home from handing
off to a daemon that leaves fleet and progression unable to start. Optional
augmentation/stock/Go/Darknet services are still admitted later. Once the core fits,
the augmentation manager is admitted ahead of the contract solver: joining factions,
working for reputation and publishing the shared objective must not wait for optional
contract solving. Enabled progression
services can start earlier if they leave room for the upgrade helper. Subsequent home upgrades serve enabled,
available blocked services/helpers. The supervisor uses game-provided script RAM
quotes; expensive upgrade calls stay in a helper. Port 8 caches a quote by reset
and current RAM for five minutes. Unknown/failed quotes retry at most once a
minute; known unaffordable quotes do not kill workers. Actors copy the current
durable savings goal before remote spending. Only owned starter workers are
reclaimed. No automatic core upgrades were added.

For an existing 32 GB run already stuck after the old daemon-only handoff, sync
the corrected supervisor, stop the supervisor PID first and then the daemon PID,
and run `bootstrap.js` to restore the saved settings. This lets starter mode use
home for its upgrade helper again. A supervisor-only restart preserves the old
daemon and may leave the same RAM shortage. No augmentation or BitNode reset is
needed; other processes and remote workers can remain in place.

## Capital and optional systems

Manual savings remain authoritative. Automatic requests use stable priorities:
Red Pill 100, Daedalus invitation 95, TOR/first opener 85, blocked home services 75,
ordinary augmentation/faction plans about 70–72, ordinary programs about 50–70,
and Formulas normally 45 (80 at the final-server stage). Close requests retain the
existing choice. Home RAM takes priority 90 during bootstrap or when fleet/progression/augmentation automation
cannot start, so a program goal cannot hold up the RAM needed to execute it.
The main supervisor also reserves helper space when admitting new services;
existing daemon workers retain their ownership. These values intentionally favor near-term progression over
speculative income; dashboard output names deferred competitors. Fleet ROI checks
remain, with no surplus override when a batch is queued and a five-minute payback
cap then; imminent resets and cash-covered skill bottlenecks defer money-focused
fleet investment. All actual spenders reread the shared floor.

Cloud growth now participates in this arbitration through an authenticated fleet
capital request (priority 79), rather than receiving only whatever cash remains
after every automatic goal. The first server starts at an 8 GB minimum; later
priority requests require RAM pressure and estimated payback within five minutes.
Priority yields for three minutes after an approved purchase. The existing 25%
transaction limit and protected reserves still apply. Explicit cloud sizing is
preserved; use `--cloud-min-ram` on the supervisor for newly started managers.
Cloud capacity runs hacking workers and does not substitute for home controller RAM.

Only high-priority cash-barrier goals request stock liquidity. The trader validates
the supervisor/epoch/age, checks commission-inclusive sale quotes and net portfolio
coverage, sells only enough shares, and blocks immediate re-entry for 30 seconds.
Ordinary exits continue. Unknown sale quotes or insufficient portfolio value defer
forced liquidation. A separate short-lived stock-access utility uses the same
investment policy, requiring known multipliers, measured recovery within 30 minutes,
four times the full access cost, reserves, and no impending reset or urgent cash
objective. Access is never bought unconditionally by the trader. Advanced BitNode
options can still reject purchases; that blocker is reported.

Selective faction prerequisites are limited to already-employed companies whose
faction names match, and Slum Snakes when combat/cash prerequisites are already met.
Offerings must materially improve the plan, and an immediately achievable basket
takes precedence. Live invitation requirements are used; unknown shapes are skipped.
Company/crime work uses the same ownership records and a bounded 30-minute attempt.
No job search, general combat training or infiltration automation was added.

Supervisor Go defaults to `--go-opponent auto`: Daedalus for reputation, The Black
Hand for cash, Illuminati for skill. Choices change only between games. An explicit
ordinary opponent stays fixed; standalone go-bot retains its Daedalus default.
Home sharing yields at skill bottlenecks; remote sharing remains disposable filler
behind actual money/XP allocations. Explicit sharing disable flags are respected.

Darknet telemetry records cache API results, useful credentials, blockers and a
crawler-RAM lower bound. The current typed cache/phishing results do not supply
numeric cash/XP rewards: these aggregates remain null, not inferred from unrelated
player balance changes. Existing destructive-action opt-ins are unchanged. New home
crawler admission reserves more home RAM when hacking/reputation is limiting;
existing crawlers retain ownership. Phishing/helper RAM is not included in the
crawler-only lower bound. Telemetry is groundwork for future measured ROI, not a
claim that Navigator has proven income payback.

## Boundaries and validation

The first infiltration for the existing bounded INT workflow remains manual.
Outside the BN4 route, generic augmentation/capability behavior and existing user
preferences remain; no next BitNode or unsupported subsystem strategy is invented.
No source files were synced to a running game and no live game APIs were operated
during implementation. An isolated checkout was used because process inspection
could not rule out a Filesync watcher in the original workspace.

Baseline: all 620 existing tests passed, including the full simulation suite.
Validation after the 32 GB bootstrap correction: `npm test` passed all 651
tests, with zero failures, skips or cancellations (124.5 seconds). The regression
covers starter income, early progression, automatic 32-to-64 GB upgrading and
helper headroom at handoff. `git diff --check` passed. These tests execute
repository mocks and simulations, not a live save.
Cloud-priority validation: the full suite passed 658 tests (106.8 seconds).
The final priority/hysteresis adjustment and its added regression passed all 33
focused fleet-capital, supervisor-utilities, and automation-planning checks.
New deterministic tests cover objective stages/multipliers, chain inflation,
affordable alternatives, sellers/donations, stale observations, reserves, stalls,
dynamic targets, staged admission, quotes, liquidity and unknown telemetry.
The repository does not bundle the game's RAM analyzer. Mock RAM costs establish
admission behavior only, not actual game RAM. Before deployment, measure the changed
manager, supervisor and helpers with the game's analyzer, check the 8 GB bootstrap,
and observe a full reset recovery cycle and post-Red-Pill XP allocation. This task
does not deploy or start Filesync to perform those checks.

## Official mechanics checked 2026-09-27

- [Faction requirements](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionInfo.tsx) and [distinct installed counting](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionJoinCondition.ts).
- [Augmentation inflation and SF11](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Augmentation/AugmentationHelpers.ts).
- [Programs and creation eligibility](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Programs/Programs.ts), [creation speed](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Work/CreateProgramWork.ts), and [darkweb costs](https://github.com/bitburner-official/bitburner-src/blob/stable/src/DarkWeb/DarkWebItems.ts).
- [Stock purchase/sale APIs](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/StockMarket.ts) and [access multipliers](https://github.com/bitburner-official/bitburner-src/blob/stable/src/StockMarket/StockMarketCosts.ts).
- [Go opponent bonuses](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Go/Constants.ts), [typed work and Darknet results](https://github.com/bitburner-official/bitburner-src/blob/stable/src/ScriptEditor/NetscriptDefinitions.d.ts).
