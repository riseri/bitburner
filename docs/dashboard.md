# Dashboard layout

Both the daemon and supervisor use a plain-text, 78-column layout. There is no
HTML overlay, log-window resizing, animation, new status port or faster refresh
loop. Live income appears before forecasts or target rankings.

## Default view

The daemon keeps its parser-compatible operational telemetry for recovery and supervisor reads. The supervisor is the human-facing default: a compact Overview with income, target state, RAM, background prep and fleet capacity, followed by a single Automation summary for stocks, contracts, progression and managed services. An Attention section appears only when something needs intervention. Target rankings and low-level counters remain in the details view.

Current pipeline misses, drift and recovery are separate from session restart
counts. Historical event text is labeled as history, not an active alarm. A
mid-batch target money/security dip is displayed without declaring the pipeline
broken. Warmup, paused recovery and draining take precedence over historical
Hack completions. Normal zero counters are not a claim of universal stability.

The target table distinguishes the estimated next-ten-minute average from the
steady rate. It is a planning snapshot, not a continually recomputed ranking.
The background candidate's potential/upper bound is labeled separately and is
not added to current income. Core bonus shows home separately from the
RAM-weighted fleet estimate so home upgrades are visible.

Long reasons and action descriptions wrap instead of running off the right edge.
Table names are shortened to fit their columns; scheduling still uses full names.
The supervisor reads both the previous log schema and the compact table, rejoins
wrapped values, and keeps background health separate from active target health.

## Detailed diagnostics

The normal startup command is unchanged:

```text
run supervisor.js
```

To include detailed diagnostics on the next startup:

```text
run supervisor.js --dashboard-details true
```

The flag is forwarded to a newly started daemon. As with other supervisor flags,
it does not change arguments on a daemon that is already running. Stop the
existing supervisor/daemon first, using PIDs from `ps` when they have arguments.
The daemon can also accept `--dashboard-details true` when run on its own; do not
start it beside an already-supervised daemon.

Details retain the short income window, completed/paid/recovered batches,
allocator failures, session misses and recovery, loop lag, required spacing,
gap/period/lead, thread sizing, operation durations, RAM reservations and cloud
spending. This is a presentation setting only: no scheduling or recovery policy
changes with the view.

After merging, sync all of `src`, including `lib/dashboard.js`, before the usual
one-time supervisor/daemon restart. Dashboard helpers are used by the supervisor,
daemon and human-facing standalone/service panels; remote HGW and background workers
are unchanged.

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
