# Dashboard layout

Both the daemon and supervisor use a plain-text, 78-column layout. The supervisor
opens and arranges the two log windows using supported Netscript UI APIs.
There is no HTML overlay, animation, new status port or faster refresh loop.
Live income appears before forecasts or target rankings.

The shared layout uses a strong title band, separated section bands, whitespace,
and a boxed target-ranking table. Labels remain fixed-width and wrapped values
stay aligned beneath their value column, so the eye can scan vertically without
losing long warnings or recovery reasons.

## Default view

`run supervisor.js` uses detailed mode and forwards it to newly launched daemons.
The supervisor remains the overview across hacking, stocks, contracts, progression,
IPvGO, and managed services. An adopted daemon retains its actual arguments and
display mode. A daemon launched directly still defaults to a compact view with
the current target, live state, measured/model income, target health, pipeline
size, RAM use, and the background/next target.

Current pipeline misses, drift and recovery are separate from session restart
counts. Historical event text is labeled as history, not an active alarm. A
mid-batch target money/security dip is displayed without declaring the pipeline
broken. Warmup, paused recovery and draining take precedence over historical
Hack completions. Normal zero counters are not a claim of universal stability.

Multi-target promotion pauses name the blocking target and state, with elapsed
stall time and tuning retry or scheduler-wait information. Trials show their
observation progress or the incumbent they are waiting on. During tuning,
preparation or draining, saved plan generations are labeled `RETAINED`; they do
not imply that the target is currently earning.

The compact daemon view omits the old four-row `TARGETS / NEXT 10M / PLANNING SNAPSHOT` table. When background preparation is active, that target is shown directly as the actionable next target with ETA, health, potential and held RAM. When background prep is disabled or has no candidate, the daemon shows only the best alternative candidate. The full ranking remains available in details as `AUTO TARGET RANKING / DETAILS`, where the next-ten-minute and steady-state rates are explicitly labeled.

Long reasons and action descriptions wrap instead of running off the right edge.
Table names are shortened to fit their columns; scheduling still uses full names.
The supervisor reads both the previous log schema and the compact table, rejoins
wrapped values, and keeps background health separate from active target health.

## Detailed diagnostics

The normal startup command is unchanged:

```text
run supervisor.js
```

To use compact rendering on the next startup:

```text
run supervisor.js --dashboard-details false
```

The flag is forwarded to a newly started daemon. As with other supervisor flags,
it does not change arguments on a daemon that is already running. A healthy
adopted daemon is never restarted merely to change dashboard details.
The daemon can also accept `--dashboard-details true` when run on its own; do not
start it beside an already-supervised daemon.

Details retain the short income window, completed/paid/recovered batches,
allocator failures, current/session misses and recovery, drift and loop lag,
required spacing, gap/period/lead, thread sizing, operation durations, RAM
reservations, cloud/fleet internals, background-prep diagnostics, and the full
auto-target ranking. This is a presentation setting only: no scheduling or
recovery policy changes with the view.

## Automatic dashboard workspace

The supervisor opens its own tail before entering starter mode, then opens the
managed or adopted daemon's exact PID after service reconciliation. Other managers
and actors do not open automatically. Each PID is attempted once, including failed
attempts: closing or moving a log yourself is respected on later ticks. A daemon
replacement opens once under its new PID and receives its initial layout.

`--dashboard-layout auto` (default) sizes the logs to the viewport through
`ns.ui.windowSize()`, capped at 780 by 720 pixels each. Small displays get smaller
panes; exceptionally narrow displays may overlap to keep title bars reachable.
If viewport information is unavailable, layout assumes 1024 by 768 pixels.
Layout runs once after a short cosmetic delay to let each tail mount.

Use `--dashboard-layout none` to open logs without moving or resizing them.
`--open-dashboards false` disables both opening and layout. Unsupported UI APIs,
disappearing processes, and positioning errors are silently ignored; automation
continues with no retries or warning spam. These options and explicit detail
opt-outs survive the existing version-2 bootstrap argument persistence. Older
saved arguments without these flags receive the current defaults.

Only `ns.ui.openTail`, `ns.ui.windowSize`, `ns.ui.resizeTail`, and `ns.ui.moveTail`
are new Netscript API references in the supervisor dependency tree. All four are
zero-RAM in the [official RAM cost table](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Netscript/RamCostGenerator.ts).
Expected added RAM is 0 GB; no worker APIs or advanced capabilities are added.
The installed game's RAM calculator and live window appearance have not been
measured by the automated tests.

## Tests

`npm test` includes ten dashboard regressions in the existing daemon test suite.
They cover layout order/width, current vs session counters, warmup, recovery,
background isolation, legacy and compact target tables, prep, wrapped errors,
read-only rendering and the supervisor overview. In-game font/layout and
Netscript RAM analysis are not emulated by these tests.


## Standalone dashboards

Standalone automation windows use the same section-and-row presentation helpers:

- `stock-trader.js` groups portfolio state, best 4S signals, and guardrails.
- `go-bot.js` groups the live game, decision search, rewards, Daedalus timing, and safety, while publishing the same state to the supervisor.
- `contract-manager.js` groups scanner status, blockers, and the small set of contracts currently waiting for action.

The intent is to keep the first screen useful at a glance while retaining verbose diagnostics behind explicit detail modes or within the service that owns them.
