# Conservative augmentation reset timing

The BN4 automatic route defaults to `--reset-policy auto`. `--min-install` remains
5 by default, but is a fallback when economics is unknown. Generic/non-route runs
keep their existing count behavior. `--reset-policy threshold` preserves the old
route count/stall policy, including the two-minute valuable-purchase grace. Both
the supervisor and standalone augmentation manager accept the flag; the supervisor
forwards it and its existing saved arguments restore it through bootstrap.

## Ownership and safety

`lib/augmentation-reset-policy.js` is pure. `lib/augmentation-reset-context.js`
collects evidence in the augmentation process, and `lib/augmentation-recovery.js`
maintains a small recovery history. Selection still uses the existing planner;
its `benefitAfterInstall` utility score is never an economic benefit multiplier.
The existing planner, capital/savings arbitration, scheduler and XP allocation
remain responsible for their existing jobs. The daemon has no reset authority.

Queued Red Pill, crossing the installed distinct Daedalus count, a completed
reachable batch, the measured favor/donation exception, and the existing 30-minute
stall/60-minute per-objective bounds override economic WAIT. Auto additionally
limits any nonempty queue to one hour even if its selected objective changes.
An empty queue never installs. Installed Red Pill continues toward node completion.

Every INSTALL uses the existing bootstrap file/settings verification, owned-work
release, unrelated-work protection, busy-action checks and state-before-reset
write. Epoch and activity are rechecked after the asynchronous write. The dashboard
can therefore say Decision INSTALL and Execution BLOCKED simultaneously.

## Verified mechanics

The official stable game source was inspected on 2026-09-29:

- [Singularity stats](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts)
  return augmentation multiplier fields.
- [Multiplier merging](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Multipliers.ts)
  multiplies the modeled player fields. Speed is a player multiplier, not a
  proportional fleet-income promise.
- [Applying augmentations](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Augmentation/AugmentationHelpers.ts)
  applies every queued NeuroFlux level separately.
- [Player reset](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts),
  [prestige](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Prestige.ts),
  and [factions](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/Faction.ts)
  reset ordinary cash, skill/XP, servers, memberships and reputation; favor and
  permanent augmentation benefits persist. Starting resources and special effects
  can alter this, so measured recovered resources are preferred to fixed constants.

The package aggregates hacking, hacking_exp, hacking_money, hacking_grow,
hacking_speed, hacking_chance, faction_rep, company_rep, work_money and combat
attributes. Ordinary names are deduplicated and installed names excluded. Each
queued NeuroFlux occurrence contributes once. The ordinary planner excludes
repeatable purchases; the manager can buy NeuroFlux in the final installation pass
described below. Prerequisites and multiple sellers are not added twice.
Missing/invalid stats cause fallback. Non-multiplier effects such as focus immunity,
programs and starting money are not assigned speculative throughput gains.

## NeuroFlux before installation

After an existing reset policy approves installation, the manager verifies
bootstrap/restart settings, releases its own work, checks player activity and the
reset epoch, saves state, and checks them again. Only then does it run a synchronous
NeuroFlux purchase pass and install through `bootstrap.js` in the same tick.
Ordinary basket purchases retain their existing order and reset timing. An empty
or waiting queue cannot buy NeuroFlux to initiate a reset, and installed Red Pill
continues toward node completion without another augmentation reset.

The pass honors `--purchase`, uses only joined factions whose live offerings include
NeuroFlux, and chooses an eligible seller with the highest current reputation.
Membership, offerings, price, rep requirement, faction reputation, cash and savings
are refreshed for every level. It uses existing reputation only: no donations,
work, faction invitations, stock liquidation or waiting for more funds.

The configured cash-reserve fraction of the pass's starting cash remains protected
throughout the pass. Every active savings floor remains protected, including a
supervisor goal matching NeuroFlux; optional purchases never release a goal.
Corrupt savings or invalid quotes prevent optional spending. Insufficient funds,
reputation, a failed purchase or an unavailable optional API stops the pass and
installation proceeds. A hard limit of 100 purchases also ends the pass immediately.
Epoch/activity changes stop spending and block installation for a fresh decision.

The manager logs successful level purchases and includes purchased count, quoted
spend and the stopping reason in its installation status. A reset-scoped pass
record prevents failed installation retries from spending again. Existing version-1
state migration clears that record on a new reset. Its Singularity calls reuse APIs
already present in the augmentation process; daemon/worker imports and APIs are unchanged.
Actual in-game RAM accounting has not been measured here.

Tests cover repeated owned levels, live quotes/sellers, savings and fixed reserves,
ordinary-purchase order, disabled purchases, bounded execution, optional failures,
installation guards, failed retries, empty/waiting queues and Red Pill behavior.

## Recovery and reset losses

Recovery means reaching at least 80% of the saved pre-reset money-engine income
for 30 continuous seconds, with live money lanes and no preparation RAM. A stale
or interrupted observation restarts that interval. The last three valid records
include recovery duration, baseline income, cash, hacking XP/level and reputation
with factions actually joined at recovery.

Economics requires at least two records from this BitNode. Their durations must
be within 1.5x, and current income within 0.5–2x each baseline. Use the slowest
recovery, not an optimistic average. Legacy `recoveryMs` can still support the
existing donation exception inside the same verified node, but does not qualify
as reliable economic history. The first installations therefore use fallback.

Recovery covers rebuilding the engine, purchased servers, programs and access.
Residual progression loss is separate: current objective-relevant cash, XP or
reputation that must still be rebuilt after recovery. Only half the smallest
historically recovered resource balance is credited; this avoids charging its
full loss again after already charging recovery. Excess cash beyond a goal is
not assigned a fictional time value. Resource durations use 80% of current
rates (measured cash/XP and the planner's measured or Formulas-backed faction-work
rate). Cash and work/XP accrue concurrently, so their maximum ETA is
used rather than summing them into a universal score.

Faction projections also require that both historical recoveries had rejoined
the selected faction and rebuilt at least today's hacking level. Otherwise
access and work-rate losses are unknown. Donation-selected candidates and
multi-augmentation prerequisite-chain targets fall back.

## Two explicit choices

For a reputation bottleneck, the shared endpoint is **the selected next
augmentation installed**:

```
INSTALL_NOW = recovery + max(post-reset reputation ETA, post-reset cash ETA)
              + another recovery after purchasing the next augmentation
WAIT        = planner acquisition ETA + recovery
```

Post-reset acquisition uses the current queue's faction-reputation multiplier.
The live inflated price plus the planner's current reserve is retained as a
conservative funding bound; reset timing cannot assume access to protected cash. Favor
improvements are not speculatively priced here. The next augmentation's own rep
multiplier cannot speed up buying itself; its larger package is available at the
shared endpoint. This avoids falsely charging WAIT for rep it already spent.

For a hacking milestone (such as Daedalus), the endpoint is the same required
hacking level and cash balance after installation:

```
INSTALL_NOW = recovery + max(residual XP/XP rate with queue, residual cash/cash rate)
WAIT        = planner acquisition ETA + recovery
              + max(residual XP/XP rate with larger package, residual cash/cash rate)
```

The manager recomputes its own authenticated producer objective from the live plan.
It consumes the existing JIT milestone balance only with the correct daemon PID
and filename, current reset timestamp, fresh timestamps, matching milestone and
requirements, measured rates, and no suspended evidence. There is no additional
money/XP sampling loop. Hacking level benefits use Formulas' inverse skill curve,
with the player's and BitNode's actual multipliers. XP multipliers change XP
acquisition directly; speed benefits are displayed but left unpriced.

Positive implied gains are halved and capped at 4x. A faction-rep multiplier of
2.6x therefore contributes 1.8x to the decision. Debuffs are not discounted away.
Cash-only, company and combat bottlenecks fall back at LOW confidence: their
package stats are visible, but these signals cannot establish future fleet or
work throughput. In particular `hacking_money * hacking_grow * hacking_speed`
is never claimed to equal an income multiplier.

## Confidence, break-even and hysteresis

- HIGH: route requirements or bounded waiting give a hard decision.
- MEDIUM: measured recovery/rates plus conservative projections qualify.
- LOW/UNKNOWN: explain the missing projection and use legacy threshold/stall.

An economic INSTALL needs at least 1.15x relevant benefit, at least 20% projected
time advantage, and at least 30 seconds saved. Approximate break-even is
`(recovery + residual rebuilding ETA) / (1 - 1 / benefit)` and must be at least
20% inside the next acquisition ETA. This is an additional guard, not a separate
claim of exact future income.

All installation conditions must remain true for 60 seconds. Evidence may drift
by at most 25% from the observation anchor, with at most 15 seconds between ticks.
Any non-decisive result discards the installation observation. Objective, seller,
queue, candidate, mode or epoch changes invalidate it. After that observation,
INSTALL proceeds immediately through the safety path; blocked execution is
re-evaluated on subsequent ticks rather than latching stale approval.

## Examples (pure-policy fixtures)

1. **Three strong queued augmentations, next 14 minutes away.** Relevant benefit
   1.8x, recovery 90 seconds, unboosted remaining rep work 840 seconds and residual
   lost rep 60 seconds. INSTALL_NOW costs `90 + (840+60)/1.8 + 90 = 680s` (11m20s).
   WAIT costs `840+90 = 930s` (15m30s). Savings are 250s, about 27%; break-even is
   about 278s. After 60 seconds of stable evidence, INSTALL wins below five.
2. **Five queued, useful next augmentation 45 seconds away.** Derating the observed
   work rate to 80% gives 56.25s remaining work, plus 60s residual loss. With 1.8x
   benefit, INSTALL_NOW costs `90 + (56.25+60)/1.8 + 90 = 244.6s`.
   WAIT costs `45+90 = 135s`. Even a strong next faction-rep bonus only starts after installation.
   Auto selects WAIT past the legacy two-minute grace; hard stall/queue bounds
   still apply.
3. **Incomplete or unstable evidence.** Missing comparable recovery records, an
   unknown next ETA, or an unstable milestone rate yields FALLBACK. Four queued
   with no hard override wait below `min-install=5`; five install unless the
   legacy near-term-purchase grace applies. Hard overrides and bounded waiting
   continue to work without any economic data.

## Compatibility, migration and visibility

State remains version 1 in `data/augmentation-loop-state.json`. No deletion is
required. New fields are defensively validated; augmentation resets discard
decision/observation/work ownership while retaining verified same-node recovery.
BitNode resets discard recovery and policy history, including a return to BN4.
Malformed or unproven legacy history does not enable economics.

The compact Install / wait row reports action, break-even, next ETA and recovery,
or the fallback threshold/reason. Detailed Reset decision shows both projections,
package multipliers, residual loss, confidence, bounded-wait progress and execution
blocks. No serialized policy objects are printed.

No daemon or worker source/imports changed, so daemon resident Netscript RAM has
no new API dependencies. New logic runs only in the existing augmentation process;
it reuses Singularity/Formulas APIs already used by that process. Actual in-game
RAM accounting has not been measured here. Starter admission, no-Singularity
manual behavior, optional systems and capital arbitration are unchanged. No
Formulas/SF5 means hacking economics falls back; measured rep economics can still
work without Formulas if all its evidence exists.

Tests cover the pure model, aggregation, reset migration/recovery, live manager
integration, bootstrap and manual-work safety, CLI round trips, and compact/detail
dashboard rendering. Repository verification uses `npm test`, including all
existing scheduler, progression and savings/capital tests. Node needs child-process
permission for its runner and the existing module-syntax check. Non-isolated mode
works for focused checks, but cannot avoid that syntax check's process requirement.
