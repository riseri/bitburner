# Dashboard layout

Both the daemon and supervisor use a plain-text, 78-column layout. There is no
HTML overlay, log-window resizing, animation, new status port or faster refresh
loop. Live income appears before forecasts or target rankings.

## Default view

The daemon groups income, the active target and current pipeline, fleet capacity,
background preparation, and four ranked targets. The supervisor is a compact
overview of income, current pipeline health, background prep, fleet, contracts,
progression and service health. Its target table is in the details view.

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

After merging, sync all of `src`, including the new `lib/dashboard.js`, before the
usual one-time supervisor/daemon restart. The helper is imported only by the two
home controllers; remote HGW and background workers are unchanged.

## Tests

`npm test` includes ten dashboard regressions in the existing daemon test suite.
They cover layout order/width, current vs session counters, warmup, recovery,
background isolation, legacy and compact target tables, prep, wrapped errors,
read-only rendering and the supervisor overview. In-game font/layout and
Netscript RAM analysis are not emulated by these tests.
