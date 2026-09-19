# IPvGO: score-aware search and measured results

The standalone bot now uses **Monte Carlo tree search with RAVE on 5x5 boards**.
It evaluates complete simulated continuations with the actual area score and
komi, rather than just checking immediate captures. Other supported board sizes
(7, 9, 13) deliberately retain the original bounded tactical policy. The log
labels that fallback; the 5x5 benchmark is not a claim about larger boards.

No Singularity, cheat APIs, native game internals or DOM access are used in the
running bot. Native game source is used only by the offline benchmark. The
supervisor, JIT daemon, workers, fleet allocator and contract system are unchanged.

## Deploy and try it

Stop only the old Go bot, or let its finite trial finish. Sync these files to
`home` together, keeping the `lib` directory:

```text
go-bot.js
lib/go-strategy.js
lib/go-search.js
lib/go-session.js
```

The strategy helper is unchanged but must still be present. Do not restart the
hacking daemon, fleet, supervisor, or contracts for this update.

```text
run go-bot.js --games 20
```

Defaults: Daedalus, 5x5, `search`, up to 2,400 simulations and 250 ms of estimated
search CPU time per move. After a finite trial finishes, continuous play is:

```text
run go-bot.js
```

For a comparison with the previous policy, finish/stop the current bot and run:

```text
run go-bot.js --strategy heuristic --think-ms 15 --games 20
```

There is no promised production win rate. Check the bot's results and the JIT
controller's actual income/misses during the first live trial.

## Runtime cost and limits

Search is intentionally more expensive than the old heuristic. It stops after
its simulation quota or CPU budget, whichever is reached first. It cooperatively
yields with `ns.sleep(5)` about every 2 ms of search work or 32 search chunks;
the work counter still yields when clock resolution hides elapsed time. The
budget is checked between complete simulations. One chunk, final simulation,
or garbage collection can overshoot a deadline. There are at most 100 tree
levels and 100 rollout moves per simulation on the optimized board.

The 250 ms default is **total search CPU budget per move**, not an intentional
250 ms continuous block. Sleep time is excluded. Native API work, opponent
thinking, logging and file writes are outside the search estimate. Separate
scripts share the game's JavaScript runtime, so neither the budget nor a 2 ms
yield target guarantees zero JIT impact. Reduce `--think-ms` and/or
`--simulations` to trade strength for lower cost, or return to `--strategy
heuristic`. Increasing the delay between turns with `--interval` also reduces
average load. No income worker is ever killed to make room.

Netscript's static RAM analyzer has not been exercised by these Node tests.
Check the actual script RAM in your game, especially on a small `home`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--opponent` | `Daedalus` | Ordinary opponent for the next new board |
| `--size` | `5` | 5, 7, 9, 13; new search backend is optimized for 5 only |
| `--strategy` | `search` | `search` or the original `heuristic` |
| `--simulations` | `2400` | Simulation quota, 1..20000; search backend only |
| `--think-ms` | `250` | Search CPU budget, 1..1000; old heuristic retains its 100 ms internal cap |
| `--games` | `0` | Completed games before exiting; 0 means continuous |
| `--interval` | `500` | Delay between player turns, 100..60000 ms |
| `--takeover` | `false` | Explicitly finish an existing unfinished board |

Ordinary opponents: Netburners, Slum Snakes, The Black Hand, Tetrads, Daedalus,
Illuminati. There is no automation for No AI or the special opponent.

## What the search does

The optimized backend represents Black and White with separate 25-bit masks.
Their combined board key is an exact 50-bit integer, not a probabilistic hash.
The search enforces positional superko using real history and simulated history.
It models captures, suicide, offline nodes and area scoring, including the game's
tiny-opening scoring exception. The live API legality mask is still the final
referee before a real move.

Tree selection alternates the maximizing player. It explores normal opponent
replies as well as immediate captures. RAVE reuses evidence from later same-color
moves in a rollout, with decreasing weight as direct visits accumulate. Tactical
priors and playouts favor captures and rescuing groups in atari; simple own eyes
are protected. These are heuristics, not a perfect life-and-death solver.

The reward favors winning; margin is a small tie-breaker. When the opponent has
passed and the exact current score already wins, the bot accepts the win by
passing. Merely subtracting a constant komi from an old heuristic was not the
upgrade. Komi participates in simulated game outcomes and final pass decisions.
A losing position can still be lost; the bot does not keep filling its own eyes
just to avoid admitting that.

## Saved results

`go-bot-state.txt` remains the safety/resume record. It is compatible with old
ready-position records. Do not delete it to force takeover.

`go-bot-results.txt` stores the last 200 verified completions, including:

- strategy version, opponent, opening/final board, score margin and win/loss;
- configured budgets, simulations actually performed, search CPU estimates and budget hits;
- timestamps and elapsed time, with `partial: true` for a taken-over/resumed game;
- game-reported bonus before/after and the change in **percentage points**;
- game-reported cumulative favor-credit before/after, not current faction reputation.

A resumed game's elapsed time covers only this bot invocation's portion, not an
invented original start time. Missing bonus data is `null`, not a fabricated zero.
The API does not directly expose node power in `getStats()`, so live telemetry
records observed bonus changes instead of inventing a node-power measurement.
Corrupt result files stop startup; failed result persistence leaves the completed
board intact instead of starting another game. Back up and inspect damaged files.

## Existing-game safety is unchanged

An untouched opening or a completed game can be replaced. Otherwise the bot
needs its exact recorded ready position, or explicit permission:

```text
run go-bot.js --takeover true --games 1
```

Takeover finishes the current opponent and size. New settings apply to later
boards. It never means permission to override subsequent manual intervention.
An interrupted pending operation still requires takeover or manual completion.

Board, history and reset context are checked before moves; the awaited response
is verified against the full expected transition. The final legality mask is
rechecked immediately before committing. Unexpected changes, duplicate processes,
uncertain API outcomes, corrupt state and unusually long games stop execution.
There is no destructive watchdog, board-reset loop or per-move terminal spam.

The API has no exclusive game lock or unique game ID. Identical unobservable
interventions cannot be detected. Stop this bot before manual play or another
Go bot, including one started under another filename or on another host.

## Reproducible native benchmark

Native Bitburner source is pinned to
`f02059a6769b6e20c6f1b32178a581801779b1f3`. The loader verifies SHA-256 hashes
for every evaluated source file. It runs the unmodified native Daedalus policy,
obstacle generator, capture/suicide/superko rules and scoring. TypeScript types
are erased using Node 22's TypeScript support. No new package dependency is needed.

The adapter replaces UI events, player progression services and timer waits.
Player faction membership/Source Files/Red Pill are absent. Native timers resolve
immediately, and both native RNG sources are seeded. Native rules are also
compared directly against the bitboard backend before benchmarking.

Both policies receive identical initial boards and per-turn RNG seed rules.
The fixed-work mode runs 2,400 simulations without a wall-clock cutoff, isolating
algorithm decisions from machine speed. A separate CPU-capped mode uses the
production 250 ms budget. Neither mode is concurrent with a live JIT game.

Local locked-seed benchmark (40 Daedalus 5x5 games, seed `17000003 + i * 7919`):

| Policy | Wins | Mean score margin |
| --- | ---: | ---: |
| Original heuristic | 7 / 40 | -10.75 |
| Search, fixed 2,400 simulations | 38 / 40 | +3.10 |

On the first 20 paired boards with the production CPU cap, the local result was
18/20 for search versus 4/20 for the old heuristic. This capped run is machine-
sensitive; it is reported, not used as a flaky CI pass/fail threshold.

These seeds were reserved after development runs, before the final comparison;
no per-board opening book or recorded opponent replies are used by the bot.
This result is not a promise of a 95% live win rate. Board distribution, game
version, RNG/timers, browser load and the CPU cutoff affect real outcomes.
Reports retain every seed, opening, score, compute time and unfinished-game flag.

To reproduce, check out the pinned upstream revision into a separate directory,
then from this repository (Node 22):

```sh
node --experimental-vm-modules --disable-warning=ExperimentalWarning test/go-native-benchmark.cjs --upstream /path/to/bitburner-src --output go-benchmark.json
node --experimental-vm-modules --disable-warning=ExperimentalWarning test/go-native-benchmark.cjs --upstream /path/to/bitburner-src --games 20 --capped --output go-capped.json
```

The dedicated read-only GitHub workflow runs both modes and uploads the JSON
reports. The existing test workflow is unchanged. Offline tests:

```sh
node --test test/go-strategy.test.cjs test/go-search.test.cjs test/go-runtime.test.cjs
```

The broader tests cover state ownership, source isolation, result persistence,
legal move masks, timer/work bounds, deterministic searches and independent
reference rules. Native AI wins, not wins against a random bot, are the strength
benchmark. Tests still cannot guarantee perfect gameplay or live timing.
