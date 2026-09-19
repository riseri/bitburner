# Standalone IPvGO bot

`go-bot.js` plays ordinary black-side IPvGO games through the supported `ns.go`
API. It does not need Singularity or use `go.cheat`. It is deliberately NOT a
supervisor service: nothing in the JIT scheduler, fleet allocation, progression
actors, contract validation or existing ports changes.

## Start with a finite trial

Sync these three files to `home`, preserving the `lib` directory:

```text
go-bot.js
lib/go-strategy.js
lib/go-session.js
```

Run a five-game trial:

```text
run go-bot.js --games 5
```

Default opponent is **Daedalus**, default board size is **5**. Open the bot's log
in Active Scripts to see scores, selected moves, session results, cumulative
opponent statistics and the actual bonus reported by the game. No hacking or
fleet restart is necessary. Stop the trial before starting another copy.

For continuous play, run just:

```text
run go-bot.js
```

This repeats completed games until you stop the script or a safety check fails.
It is not auto-restarted by the supervisor. Kill only this bot's PID to stop it;
there is no exit hook that resets the board or kills unrelated scripts.

## Existing games and restarts

An untouched opening or a completed board can be replaced. A manually started,
unfinished game is left alone. To explicitly finish that game with the bot:

```text
run go-bot.js --takeover true --games 1
```

Takeover **finishes the current opponent/size**. It does not forfeit/reset the
game. The requested opponent and size apply only to subsequent new games.
Takeover only grants permission at startup, not to override later interventions.
No AI and special-opponent games are not supported or taken over.

`go-bot-state.txt` stores a reset-bound position/history fingerprint. An exact
recorded idle position can be resumed automatically. An interrupted API action
or a changed board requires explicit takeover or manual completion. A corrupt
record stops the bot; inspect/back it up before removing it. Deleting it does not
provide permission to reset an unfinished game.

Before each move, the bot checks that its position is unchanged. After awaiting
the opponent, it verifies the resulting board and move history against its own
move plus the reported response. A mismatch stops the bot instead of blindly
continuing or resetting the board. A white response that finishes during a state
write is reconciled as an ordinary opponent move, not mistaken for takeover.

The API exposes neither an exclusive game lock nor a unique game identifier.
Identical, unobservable resets or interventions cannot be detected. **Stop the
bot before playing manually, and do not run a second Go bot under another name
or on another host.** Go errors produce one terminal message on exit; there is
no automatic error/restart loop. Slow AI responses are awaited, not forcefully
reset by a heartbeat timer. An unusual game exceeding eight turns per board
point stops with its board intact rather than looping indefinitely.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--opponent` | `Daedalus` | Ordinary opponent for new games |
| `--size` | `5` | New board size: 5, 7, 9, or 13 |
| `--games` | `0` | Verified game completions before exit; 0 = continuous |
| `--takeover` | `false` | Explicitly adopt the unfinished starting game |
| `--interval` | `500` | Delay between player turns, 100..60000 ms |
| `--think-ms` | `15` | Cooperative tactical evaluation budget, 1..100 ms |

Other supported opponents are `Netburners`, `Slum Snakes`, `The Black Hand`,
`Tetrads`, and `Illuminati`. For example, an easier-opponent shakedown:

```text
run go-bot.js --opponent Netburners --games 5
```

Or target the Black Hand hacking-money bonus:

```text
run go-bot.js --opponent "The Black Hand" --size 5
```

## What the rewards mean

The **Daedalus node-power bonus** affects faction and company reputation gain.
That bonus does not require joining Daedalus. Direct faction favor is different:
current upstream awards limited rep-equivalent favor credit on qualifying win
streaks only when you belong to that particular opponent faction.

The log reads `bonusPercent`, `bonusDescription`, wins, losses, streak and `rep`
from `ns.go.analysis.getStats()`. The `rep` field is labeled **cumulative
rep-equivalent favor credit**, NOT your spendable/current faction reputation and
NOT the faction's actual favor number. Current faction membership comes from
`ns.getPlayer().factions`. It does not fabricate a favor payout per game or call
Singularity to retrieve favor. Session outcomes count only completions verified
by this bot; game-wide records may also include games played elsewhere.

## Strategy and runtime limits

The strategy is a bounded heuristic, not a Go solver or a guaranteed winning
policy. It ranks captures, escapes from atari, threats, connections and expansion;
it avoids simple self-atari and filling its own eyes. It checks immediate capture
replies for at most six finalists, with at most eight reply points per finalist.
It passes when no worthwhile safe move remains. The live valid-move mask is the
final authority, including the game's superko rule; the local model is used for
tactics and transition verification, never to bypass that mask.

Candidate evaluation yields with `ns.sleep(5)` after each candidate/reply. The
reported CPU estimate sums tactical evaluation slices and excludes intentional
sleeps; board reads, mask calculation, snapshot setup, sorting, persistence and
rendering are outside that estimate. The limit is cooperative: one board
operation, GC, or the game API's own opponent/validator work can exceed it.
Larger boards cost more. Separate scripts share the game's JavaScript runtime,
so this is NOT a guarantee of zero impact on hacking timing. The default small
board and pacing are intentional. Measure actual JIT income/timing during the
trial and stop only the Go bot if it has an adverse effect.

Netscript static RAM cost has not been measured by the Node tests. Inspect the
in-game script RAM before starting on a constrained `home`. The bot never kills
income workers or steals scheduler reservations to make space.

## Validation

`npm test` discovers the new Go tests through the existing test glob. Targeted:

```text
node --test test/go-strategy.test.cjs test/go-runtime.test.cjs
```

Tests cover board orientation, offline nodes, independent capture/suicide rules,
API legality masks, eye protection, passing, bounded cooperative evaluation,
owned/foreign/unfinished games, interrupted requests, manual moves and resets,
state-write failures, duplicate processes, changed reset epochs and completed
game accounting. Seeded games use an independent **random legal reference
opponent**, not the native Daedalus AI. Those results are a smoke test, not a
claimed production win rate. An initial five-game live trial is still necessary.

Official references checked on 2026-09-18:
- [Go API](https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.go.md)
- [API implementation and stats fields](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/effects/netscriptGoImplementation.ts)
- [Move/history and pass semantics](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/boardState/boardState.ts)
- [Reward multipliers](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/effects/effect.ts)
- [Win/favor scoring](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Go/boardAnalysis/scoring.ts)
