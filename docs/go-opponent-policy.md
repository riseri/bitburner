# Measured IPvGO opponent policy

`--opponent auto` chooses an ordinary opponent for the configured board size by
estimated milestone milliseconds saved per real minute of Go. The supervisor
still defaults to `auto`; a directly launched bot still defaults to pinned
Daedalus. Explicit `--opponent <name>` values and `--size` are unchanged.

Previously, `progressionGoOpponent()` chose Illuminati for hacking, Black Hand
for cash except at RED_PILL, and Daedalus otherwise. That rule is now a bootstrap
prior. Cash at RED_PILL also uses cash effects, including donation funding.
Unknown objectives still start with Daedalus.

## Official stable mechanics

Verified on **2026-09-29** at official stable commit
`1da7316ffd9d281b45a86c4c54ec532276557892` (current stable tip, dated 2026-05-17).

The [effect implementation](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Go/effects/effect.ts)
maps opponents as follows:

| Opponent | Policy effect | Player multiplier |
| --- | --- | --- |
| Netburners | HACKNET | `hacknet_node_money` |
| Slum Snakes | CRIME | `crime_success` |
| The Black Hand | HACKING_MONEY | `hacking_money` |
| Tetrads | COMBAT | strength, defense, dexterity, agility |
| Daedalus | REPUTATION | faction and company reputation |
| Illuminati | HACKING_SPEED | `hacking_speed` |

The special world-daemon opponent affects hacking level and is excluded from
ordinary play and automatic candidates. Reward strength depends on accumulated
node power, opponent power, BitNode GoPower and active SF14. Difficulty and
streaks affect power gains, with special treatment of 5x5 Illuminati and broken
losing streaks. These constants are not copied into the policy. Live bonus
deltas incorporate these effects and changing marginal returns.

The [scoring implementation](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Go/boardAnalysis/scoring.ts)
adds score-derived power even on normal losses, with a lower streak multiplier.
Ties count as wins. Joined factions can award favor on positive even win streaks,
subject to an SF14-dependent cap. `stats.rep` measures the converted-reputation
budget spent on favor; it is not ordinary augmentation reputation. Forced ends
can add losses without a normal power reward.

The [Netscript implementation](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Go/effects/netscriptGoImplementation.ts)
exposes wins, losses, streak, bonusPercent and rep through `getStats()`, but not
nodePower. Missing opponents are unplayed entries with zero initial rewards.
Failed/malformed API reads are unknown rather than zero. Resetting an unfinished
board can incur a loss; the bot's stricter ownership rules guard every reset.

The [Go reset implementation](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Go/Go.ts)
clears wins, losses, power and streaks on augmentation installs while retaining
favor-budget rep. BitNode resets clear Go stats entirely. Reward evidence thus
expires on both resets and installs; game duration/score/win priors survive.

[Hacking action times](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Hacking.ts)
are inversely proportional to hacking speed; Grow and Weaken scale from hack
time. Hacking-money multipliers affect the capped steal fraction. Neither effect
automatically produces an identical improvement in total system income.

## Architecture and safety

- `lib/go-opponent-telemetry.js`: validation, measurement, persistence and aggregates.
- `lib/go-opponent-policy.js`: effect mapping, cheap JIT reader, pure valuation,
  targeted exploration and hysteresis.
- `go-bot.js`: authenticated consumers at safe board starts and observations
  after verified finishes.
- The existing augmentation plan adds optional `rateSource` and `workActive`
  metadata to its existing faction-rate evidence, without new API calls or
  progression protocol versions.

Ordering: verify game-over transition, persist ownership, recheck the exact
snapshot, measure, persist analytics, then select and safely reset the next
board. Objective changes during play or a pending response cannot trigger
selection. Singleton checks, takeover rules, live legality/superko checks,
awaited actions, pending-state writes and exact board/history/reset verification
remain in force. There is no watchdog reset or move-strategy rewrite.

Resumed and takeover games finish their actual opponent and size but generate
no productivity sample: their full elapsed time and starting reward are unknown.
A completed starting board is replaced without learning it again. Ownership
errors and unexpected transitions cannot become samples.

## Persistent telemetry

`data/go-opponent-policy.json` is independent of `go-bot-state.txt`:

```json
{
  "type": "go-opponent-policy",
  "version": 1,
  "opponents": {
    "Illuminati": {
      "5": { "games": 42, "samples": [] }
    }
  }
}
```

Each opponent/size bucket retains at most **24** observations and a lifetime
count. Each sample stores opponent, size, reward epoch, start/finish wall times,
duration, won/lost, black score, margin, before/after wins/losses/streak/
bonusPercent/rep, bonus delta, bonus/minute, rep delta, before/after membership
and actual Daedalus RNG wait time. Favor is recorded and displayed without
assigning speculative future cash value.

The initial stats snapshot precedes the new board. Duration runs through the
verified final API response and includes player/search sleeps, opponent thinking,
ownership writes and RNG waits. Ending ownership/analytics writes and the
inter-game pause are outside that game interval. RNG wait uses the wall clock
around the unchanged sniping function; it is neither subtracted nor awarded
a synthetic scoring premium.

```
bonusPerMinute = (after.bonusPercent - before.bonusPercent) * 60000 / durationMs
```

The finish must agree with opponent, size, reset and exactly one win/loss
increment. Missing final stats, regressing rewards, bad numbers and mismatched
outcomes are rejected. Normal losses and zero deltas remain real evidence.

Epoch: `currentNode:lastNodeReset:lastAugReset:ownedSF14`. Reward observations
require an identical epoch and a finish within one hour. A live bonus regression
or large unexplained advance beyond the latest observation invalidates that
bucket's reward rates. Ordinary sequential gains do not continuously erase the
window. No hidden power reconstruction is used.

The newest six comparable samples determine pace with weights
`0.7^ageInSamples`. Weighted bonus / weighted elapsed time avoids overweighting
short games. Summaries also expose win rate, average duration/score/margin,
bonus/game and aggregate bonus/minute. Retained gameplay priors cannot invent
new-epoch reward rates.

Every schema number is checked, derived values are recomputed, arrays and file
size are bounded, and unknown opponents/sizes are omitted. Corrupt buckets are
discarded independently; missing, legacy and unsupported schemas become a cold
start. Optimizer writes happen once per valid completion, never per move. Write
failures keep in-memory evidence and do not stop play. Malformed ownership
remains fatal even with takeover enabled.

## Progression value

For current bonus `b` and measured additional percentage points/minute `d`:

```
relative = (1 + (b + d)/100) / (1 + b/100) - 1 = d / (100 + b)
```

Accumulated bonus is a denominator, not a farming score. Compare baseline and
improved **maximum remaining requirement ETA**. Improving a shorter requirement
without changing the maximum has zero immediate milestone value. Unknown
necessary ETAs stay unknown instead of becoming zero.

**Cash:** use fresh measured JIT `income60`. Prefer the existing milestone
balance cash ETA/rate; otherwise compute remaining cash / JIT income for a
cash-only requirement. Cap the hacking-income share of the baseline at one.
Black Hand applies a **0.5** response discount for fixed target/batch geometry,
other income and steal-fraction caps.

**Cash speed:** Illuminati gets a **0.75** response discount only with RAM
pressure or at least 80% RAM utilization, active batching and positive
batch/launch/worker headroom. The smallest headroom caps estimated improvement.
BATCH_RATE, LAUNCH_RATE, WORKER_LIMIT, TARGET_SLOTS, NO_PROFITABLE_TARGET,
RECOVERY and PREPARATION prevent cash speed value. Missing capacity cannot
establish timing pressure. This estimates benefit usable through existing
replanning; it is not a scheduler command or guaranteed immediate income gain.
The policy does not change batch rates or reservations.

**Hacking XP:** reuse `policy.balance.hackingEtaMs`, measured total `xpRate`
and its script-attributable `scriptXpRate` model. Affected fraction:
`min(1, scriptXpRate / totalXpRate)`. A **0.8** response discount applies to
running script XP work. Launch/worker ceilings or recovery suppress that gain.
University XP is unaffected. Warming-up script-only totals cannot establish
this fraction and use the prior.

**WORK reputation:** selected plan rep gap / rep/sec, improved directly by the
Daedalus multiplier ratio. Active measured work supports HIGH confidence after
enough Go samples. Modeled/unmarked rates cap it at MEDIUM; explicitly inactive
work supplies no ETA. Remaining purchase cash still participates in the maximum.

**DONATE:** the objective includes donation plus purchase funding. Evaluate
Black Hand and usable Illuminati speed as cash effects. The underlying rep gap
does not create Daedalus value.

**Unsupported effects:** no current authenticated crime, combat or Hacknet
marginal-value model exists. Keep their mappings, but assign zero value and do
not explore them for unrelated objectives. Favor is recorded without monetization.

JIT authentication requires type `jit-status`, version 2, a timestamp within
15s and after the current reset, and a numeric PID owned by a live `daemon.js`
on home. Capacity version/numbers and milestone balance timestamp/requirement
identity are checked. Progression uses only `readProgressionSnapshot()` and its
existing type/version/reset/PID/process authentication. Missing or stale evidence
reduces confidence and uses semantic fallback; it never disables play.

## Exploration and hysteresis

Cold start: hacking → Illuminati; cash → Black Hand; WORK reputation →
Daedalus; otherwise → Daedalus. An authenticated milestone balance can redirect
that prior when its effect cannot shorten the longer remaining requirement.
An unmeasured incumbent cannot override the prior. If evidence establishes positive
potential for both cash effects, collect deterministic **three-game blocks**:
finish a relevant under-sampled incumbent, then the prior, then a relevant
under-sampled challenger. A shorter requirement or blocked speed effect is not
explored merely to complete a table.

Measured comparisons require three current reward samples. Retain a positive
incumbent unless a measured challenger is at least **20%** better. Newly
irrelevant or zero-value incumbents may change immediately at the next safe
board boundary. Initial relevant exploration deliberately precedes hysteresis
and ends when both candidates have sufficient evidence.

- PRIOR: semantic fallback or no current reward observations.
- LOW: sparse measured evidence, including initial targeted exploration.
- MEDIUM: at least three observations or incomplete modeling evidence.
- HIGH: at least six observations and adequate current progression evidence.

## Dashboards, fresh players and RAM

Optional `go-status` fields preserve version 1 compatibility: `autoOpponent`,
`selectedOpponent`, `policyGeneratedAt`, reason/confidence, small objective,
effect, bonus/minute, projected milliseconds saved per Go minute, recorded games
and at most three candidates. Decisions describe the board start; their
timestamp distinguishes them from heartbeat time. Latest pace, duration,
rep delta and RNG wait remain observable at completion. The full database is
never published through the port.

The Go log adds Opponent policy with scalar values and candidates.
`--details false` hides it. Supervisor detailed mode adds only policy, reason,
confidence and pace; compact `7 IPvGO [OK]` is unchanged.

No new resident Netscript API names are introduced. Go uses existing `getStats`
(zero RAM in the [stable RAM table](https://github.com/bitburner-official/bitburner-src/blob/1da7316ffd9d281b45a86c4c54ec532276557892/src/Netscript/RamCostGenerator.ts)),
reset/player/process readers, ports and file I/O. There are no Singularity,
Formulas or BitNode multiplier calls in the new Go modules. Incremental static
API RAM is **0 GB**; absolute script RAM has not been measured in game here.
Memory is bounded by six opponents × four sizes × 24 samples. Modeling happens
at board boundaries, not during move search. RNG logic is unchanged.

No progression snapshot, no SF4/SF5, no Formulas, unavailable multiplier access,
no history and the first ever Go game are supported. Missing stats entries have
zero initial rewards; an unavailable stats API skips measurement without stopping
safe play.

## Four worked examples

Deterministic assertions in `go-opponent-policy.test.cjs`; illustrative estimates
at current rates, not promised income. Each measured pace uses six 5x5 games.

1. **Hacking dominates, university supplies 80% of XP.** Cash ETA 8m, hacking
   ETA 35m, total XP 500k/s, scripts 100k/s. Illuminati +0.2 points/min at +5.2%
   affects only 20% of XP. Improvement:
   `0.2 / 105.2 × 0.8 × 0.2 = 0.03042%`, or **0.639s saved/min**.
   Treating all XP as scripts would overstate this by almost five times.

2. **Cash, temporal occupancy and headroom.** Remaining cash 100b, JIT income
   100m/s, ETA 1000s. Black Hand +0.12 points/min at +4.72% yields **0.573s/min**;
   Illuminati +0.18 points/min at +5.08% yields **1.283s/min** and wins.
   BATCH_RATE makes speed's cash value zero, so Black Hand wins. Stronger
   measured Black Hand productivity can also win with timing headroom.

3. **Faction WORK.** Rep gap 1m at 100 rep/s gives a 10,000s ETA; cash is covered.
   Daedalus +0.2 points/min at +5.2% saves **18.975s/min** through direct rep-rate
   improvement and wins. Favor is evidence only and does not inflate that value.

4. **Donation-selected Red Pill.** The underlying 2m rep gap is donation-funded,
   with 100b remaining donation/purchase cash and 100m/s JIT income.
   Black Hand +0.3 points/min at +5.8% saves **1.416s/min** and beats Illuminati
   +0.1 points/min. Even Daedalus +3 points/min has no value to this cash strategy
   and is excluded.

## Tests and scope

The new policy tests cover mappings, priors, donation, outcomes/streaks/bonuses/
favor, RNG cost, bounded/corrupt/legacy persistence, reset expiry, recency,
multiplier ratios, worked examples, ceilings, XP attribution, reputation,
unsupported resources, exploration, hysteresis, size isolation, producer
authentication and stale evidence.

The runtime tests cover pinning, objective changes during pending replies,
takeover/resume/white-turn safety, manual and failed-state transitions,
completion-only writes, elapsed time, actual RNG waits, fresh-player fallback,
strict ownership corruption, analytics-write recovery and detailed/compact
rendering. Existing Go safety and strategy tests remain intact. Run the entire
repository suite with `npm test`.

Final validation: **976 tests passed, 0 failed, 0 skipped/cancelled** using the
normal `npm test` runner (87.8s). This includes 58 new Go policy/runtime cases
and one real-producer work-rate provenance regression. `git diff --check` is clean.

There is no board-size optimizer, special-opponent farming, move/Monte Carlo
rewrite, new RNG exploit, resource manager, scheduler tuning/reservation change,
progression protocol redesign, donation redesign or augmentation-reset redesign.
