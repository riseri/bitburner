# Adaptive hacking policy

`daemon.js` remains the only full hacking controller. Its existing startup scanner,
rooting/deployment pass, money scorer, prep, HWGW allocator, multi-target scheduler,
generation swaps and recovery remain in use. `fleet-manager.js` still owns ongoing
discovery, deployment and purchased-server spending. `supervisor.js` still owns
service admission/restarts and the lightweight `starter-worker.js` pool.

The policy affects hacking only. It neither chooses nor operates another BitNode
progression system. Stocks, Go, progression, augmentations, Darknet and sharing
retain their existing service configuration. There are no new processes, workers,
ports, CLI flags or persistent configuration files.

## Decisions

`lib/hacking-policy.js` detects capabilities and makes explainable decisions.
`lib/hacking-xp.js` scores XP actions and runs a secondary pipeline inside the
same daemon. The primary money scheduler continues in every policy mode. XP
borrows only spare RAM; no fixed percentage is reserved for it.

| Mode | Rule | Operation |
| --- | --- | --- |
| NORMAL | Capabilities missing, bootstrap incomplete, ordinary multipliers, or XP goal reached | Existing money targeting and HWGW |
| MONEY | Healthy infrastructure and a favorable money multiplier | Existing money targeting and HWGW |
| XP | Money impaired, XP and level scaling viable, formulas available, bootstrap complete, below XP goal | Existing money pipelines plus spare-RAM XP on a separate target |
| HOSTILE | Both money and XP/level/speed are badly impaired | NORMAL money fallback; diagnostic for future controllers |

Multiplier access is attempted only in BN5 or with owned SF5, guarded by `try/catch`.
This is the API access rule, not a BitNode strategy table. Current node information
comes from `getResetInfo()`. Missing or incomplete multiplier data means UNKNOWN
viability and NORMAL operation; missing formulas also preserves money behavior.

Money is classified POOR if `ScriptHackMoney`, `ScriptHackMoneyGain`,
`ServerMaxMoney` or `ServerGrowthRate` is at most 0.25. XP progression is POOR if
`HackExpGain <= 0.15` or `HackingLevelMultiplier <= 0.40`. A speed multiplier at
most 0.25 impairs both. Otherwise categories are VIABLE or STRONG. Money gets the
STRONG category at a money, cash-gain or max-money multiplier of at least 1.25.
These are explicit bottleneck categories, not normalized income predictions.

Starting money and security multipliers are reported; their effects already live
in actual server balances/security and existing preparation estimates. Formulas
include game multipliers themselves, so XP is not multiplied a second time.
Money estimates now also include the distinct `ScriptHackMoneyGain` payout factor;
the batch allocation algorithm is unchanged.

## Bootstrap protection and configuration

The exported `HACKING_POLICY` constants in `lib/hacking-policy.js` centralize the
defaults. They can be edited and synced like the repo's other tuning constants.
Existing daemon flags, including `--target`, launch/worker limits, batch steal
limits and fleet settings retain their meanings. An explicit `--target` pins the
money target; the XP lane independently selects another server. `--max-targets`
still limits money pipelines; XP does not replace an earning target slot.
Tests may supply `cfg.policyOptions` to exercise other thresholds.

| Setting | Default |
| --- | --- |
| Hacking XP goal | Level 2500 |
| Severe money / XP / level / speed thresholds | 0.25 / 0.15 / 0.40 / 0.25 |
| Favorable multiplier threshold | 1.25 |
| Minimum home / remote worker RAM for XP | 64 GB / 1024 GB |
| Minimum cash floor | $100 million |
| XP entry cash buffer | 1.25 times the applicable floor |
| Policy and target rescoring | 30 seconds, between finite waves for target changes |
| Goal-level check / XP scheduler tick | 1 second / 250 ms |
| Target improvement / simpler-action tie margin | 5% / 5% |
| Dashboard cadence | 10 seconds |
| ETA stability | 3 completed cycles, total player XP rates within 25% |
| XP ETA forecast horizon (`xpEtaHorizonDays`) | 7 days |
| XP retry after money preemption | 30 seconds |

XP requires all five port-opening programs. The cash floor is the maximum of the
simple minimum, existing shared savings, fleet reserve and fresh active stock
reserve. Entry requires an extra 25% buffer; remaining in XP only requires the
floor. Rooted public RAM counts toward infrastructure, so purchased servers are
not mandatory where an adequate public fleet is available. Home RAM remains for
the existing services and supervisor-managed sharing.

The 8 GB starter path imports none of the policy modules and keeps earning as
before. SF5, Formulas, purchased servers, port openers and market APIs are not
required. The full daemon carries the optional API's normal static RAM cost; the
supervisor continues checking real script costs before graduating from starter.

## XP scoring and execution

Candidates reuse the existing discovered network: rooted normal money servers,
required skill at or below the player, excluding home and purchased servers.
Active money targets, pending admissions and background-prep targets are excluded.
Each candidate uses a local server copy at minimum security and maximum money,
the current player, `hackExp`, `hackChance`, all three action times,
`growThreads` and core-aware `weakenEffect`. The base difficulty remains intact.

The scorer reads the actual script RAM on each worker host. It subtracts foreign
RAM and the peak of all future money reservations, rounds threads down per host,
respects the existing shared process/launch limits, and compares total sustainable
XP/second and XP/second/GB of usable fleet RAM.
This last metric includes capacity left idle by a sequential strategy.

* **Grow** gives full XP even at maximum money. At the cap it causes no security
  increase, making repeated grow stable. At comparable G/W RAM costs it usually
  wins: grow takes 3.2 times hack time, weaken takes 4.
* **Weaken** gives full XP even at minimum security. It wins when its cheaper
  worker permits enough extra threads, or within the small stability tie margin.
* **Hack** uses `hackExp * (0.25 + 0.75 * chance)`. Raw H speed is insufficient:
  the comparison includes success-weighted grow and both weaken repairs, their
  XP, inflated repair durations and available RAM. One bounded hack process avoids
  racing other hacks. Hack can win when its worker is substantially cheaper and
  repairs fit, but ordinary deployments usually favor grow. Zero-drain hacks
  only earn failure XP and are excluded from this sustained-money model.

This follows the current official [action implementations](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions.ts),
[hack implementation](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Netscript/NetscriptHelpers.tsx),
[growth fortification rule](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Server/ServerHelpers.ts),
and [XP/time formulas](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Hacking.ts).

The daemon reuses `background-grow.js`, `background-weaken.js` and the existing
`jit-hack.js` PREP protocol. Workers contain no new policy or formulas. Dirty XP
targets are weakened, filled, and weakened again as needed before grinding.
Targets switch only at wave boundaries after a material improvement. XP workers
enter the same running-PID map, RAM reservation ledger and launch budget as money
workers. Their RAM holds do not expire until the PID finishes or cancellation is
confirmed. Money admission and exec reclaim optional XP RAM and retry immediately;
XP then waits 30 seconds before trying again. Failed cancellation retains ownership.
Money preparation/admission can also claim an XP target before using it.
Configured fleet sharing is disposable filler: XP can reclaim that RAM after
checking money reservations; home sharing remains untouched.

Policy changes let the current XP wave finish without restarting or draining money.
Money tuning and recovery take priority over XP. Candidate scoring is incremental
and runs only between due money launches. New XP G/W jobs use the existing
owner-tagged background orphan cleanup. An XP lane may report `WAITING_RAM` or
`WAITING_TARGET` indefinitely when money needs all resources or no independent
target exists; money continues normally.

HOSTILE does not stop the scheduler. If no money batch can be built (including a
zero hack-money multiplier), existing weaken workers keep usable remote RAM
working and the daemon retries money planning after at least 30 seconds. This
fallback may include zero-money normal servers; it does not become XP mode or
claim useful XP when the multipliers make XP worthless.

## Status and future integration

The daemon dashboard reports policy and reason at its existing cadence. The
supervisor understands the new XP status. Illustrative output:

```text
Hacking policy  XP | operational MONEY+XP
Policy reason   ... spare-RAM XP below level 2500; money stays primary
XP pipeline     <selected host> | G | RUNNING | spare RAM only
XP level        731 / 2500
XP model        <estimated XP>/s | <borrowed RAM> GB
XP ETA          unavailable (prep, warmup or unstable rate)
```

NORMAL reports missing capabilities or bootstrap needs. HOSTILE reports the
penalties and NORMAL fallback. The operational mode is `MONEY+XP` while secondary
workers exist and NORMAL/MONEY otherwise. The secondary lane reports its own
preparation, borrowing, draining or waiting state independently of money health.

The existing `PORTS.JIT_STATUS` (17) v2 snapshot now includes `policy` with `mode`,
`operationalMode`, `moneyViability`, `xpViability`, `overallViability`, `reason`,
capabilities and relevant multipliers. Money snapshots retain their pipelines and
add secondary XP target/action, borrowed RAM, modeled XP rate, stable total-player
XP rate (`observedTotalXpPerSecond`) and progress. A future progression
controller can read this status without launching another scanner or modifying
workers. Verify `type`, `version`, owner PID and timestamp before consuming it.

Required XP uses `formulas.skills.calculateExp(goal,
player.mults.hacking * multipliers.HackingLevelMultiplier)`, matching the
[game's skill update](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Person.ts).
ETA uses stable observed total player XP over completed cycles, including XP from
the primary money pipeline. It is not labeled as XP-lane-only throughput. Zero,
nonfinite or bursty rates, prep, preemption and inactive XP suppress
ETA. The inverse skill curve is exponential: level 2500 takes roughly 4.40e36 XP
at a combined skill multiplier of 1, but 3.16e9 XP at a multiplier of 5. Both
dashboards show the combined player/BitNode skill multiplier used in the estimate.
Projections beyond `xpEtaHorizonDays` report `beyond 7d forecast at current stats`
with `etaMs: null` and an explicit `etaReason`, instead of printing astronomical
hour counts or labeling a valid but very slow rate unstable. This is a display
horizon, not a claim that the goal will finish in seven days or a mode-selection
rule. The estimate assumes the recent rate and current multipliers continue;
upgrades, speed and other activities can change it. Outside XP operation no XP
ETA is promised.

## Validation and in-game checks

Run `npm test`. For the focused policy checks in environments that disallow child
processes, use `node --test --test-isolation=none test/hacking-*.test.cjs` on
a Node version supporting that option. The full suite includes a syntax test
that launches Node subprocesses and needs permission to do so.
The focused policy tests and existing event-loop simulator cover capability
fallbacks, bootstrap and reserves, hostile multipliers, actual worker costs,
scoring, local server copies, hysteresis, ETA, concurrent money/XP without target
overlap, shared RAM and launch limits, preemption, failed cancellation, continuous
money income across policy changes, and safe work with zero hack money.

For fresh BN1, sync all of `src` and run `supervisor.js` on an 8 GB home without
SF5 or Formulas. Confirm starter workers root/deploy on accessible public hosts
and earn money. After home upgrades, confirm the existing full stack starts and
the daemon reports NORMAL. The existing starter/root/deployment/recovery tests
also cover this route with mocked Netscript APIs.

For BN5, leave the supervisor's usual service settings in place. With Formulas,
all port openers, at least 64 GB home, 1024 GB remote worker RAM, and cash above
the applicable entry buffer, inspect the daemon log below level 2500. If live
multipliers satisfy the XP rule, expect a secondary XP lane when spare RAM and a
separate target are available. Money batches must keep paying throughout.
Compare the selected action and borrowed worker RAM, let several cycles complete,
and check whether an ETA becomes available. Setting a higher shared savings goal
must return the policy to NORMAL; clear the test savings goal afterward. Reaching
2500 must stop new XP waves while money continues. The tests exercise this exit
without requiring a long in-game grind. Severe money *and* XP/level penalties must
show HOSTILE and continued money/fallback workers.

After syncing an update, stop only the old daemon PID and let the supervisor
restart it; reload the supervisor too to display XP in its dashboard, following
the README's saved-settings restart procedure. A daemon restart retains existing
worker orphan cleanup and fleet adoption. Other services can continue running.

The automated simulation cannot verify the game's static RAM analyzer, offline
execution, browser timer stalls or your save's actual state. The simple XP engine
uses sequential repair waves, not an overlapping XP batch optimizer. H candidates
whose repair cannot fit one host are conservatively excluded. Long-running waves
delay elective XP target/policy changes until their work completes; money can
preempt them sooner. Viability is hacking-only and does not claim which alternate
subsystem is best for a BitNode.
