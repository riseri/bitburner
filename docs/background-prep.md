# Protected background target preparation

This is preparation only, not multi-target hacking. The existing daemon continues
running its active JIT target with the same 100ms gap and 600ms launch cushion.
A cooperative side task prepares at most one richer target and stops at `READY`.
No second daemon, additional Hack operation, or automatic promotion is started.

## Default behavior

`run supervisor.js` starts the daemon normally. Background prep is enabled, but
waits for two minutes of completed, productive batches and a recent H completion.
New misses, expired landing slots, allocator failures or recovery reset a 60s
quiet period. An active recovery cancels the prep PID, not the income workers.
Instantaneous money/security between normal HWGW landings is not used to decide
that the active pipeline is unhealthy.

Candidate evaluation visits one network entry per 500ms tick. It uses a separate
120-minute opportunity estimate, without changing the existing ten-minute active
target ranking. Potential income uses the current cadence, a 5% steal headroom
and estimated minimum-security hack chance, not an exhaustive target tune. It
requires potential income above the active model by the existing switch threshold.
Prep and eventual warmup reduce the opportunity score. An estimate is not a
promise of future income: actual threads, placement, chance and period must be
re-tuned before a later promotion.

A target at security 100 is not divided by zero or silently ignored. It is an
exploration candidate with a **chance=1 income upper bound**, labeled on the daemon
dashboard. This can overestimate its value. Preparation may be long because it
still has to execute weaken at its current security; spare RAM cannot shorten a
single action's duration. Once selected, the one candidate stays pinned.

## Isolation and RAM ownership

- At most one `background-grow.js` or `background-weaken.js` PID exists per daemon.
  Each worker immediately executes only its named action against the prep target.
- Total prep RAM is limited to the smaller of **1% of fleet RAM and 16,384 GB
  (16 TB)** by default. The fraction is capped at 5% and the absolute limit at
  16 TB. Home is never used for background workers.
- Before admission, the daemon checks both actual free RAM and the peak of **all
  existing future JIT reservations** on the selected host. It examines only one
  host per tick, after servicing JIT launches, with an empty event queue and at
  least 50ms until the next queued launch.
- The resulting RAM hold remains until the PID exits or is successfully cancelled.
  It does not expire at the predicted finish. Active allocation subtracts the hold
  for every future reservation; prep is counted once, not again as foreign RAM.
- A failed income reservation preempts the prep worker and retries the **same
  landing slot** before recording a skipped slot. A same-host failed JIT exec
  likewise retries after reclaiming prep RAM. A failed PID kill never fabricates
  free RAM.
- No background worker reads/writes JIT event/control ports. Prep cancellation
  uses only its recorded PID, never `scriptKill` or `killall`.
- A daemon exit cancels its prep child. Startup orphan cleanup matches the two
  dedicated filenames, a positive dead owner PID and the `bgprep-` ownership tag.
- Prep errors disable only this optional feature and remain visible. Three waves
  without progress disable it rather than spinning. Exec failures retry after 30s.

The stage sequence is deliberately simple: weaken to minimum, grow toward maximum,
then weaken again. Large repairs can use multiple bounded waves. No simultaneous
prep batch train or JIT worker timer changes are introduced.

`READY` means money is at least 99.99% and security is within +0.001 of minimum,
with no prep worker left. The daemon's normal elective selection excludes this
session's background candidate, so preparing it does not silently replace the
money target. Existing safety/level/network maintenance is otherwise unchanged.
A deliberate later restart can select the prepared target; simultaneous hacking
of both targets is a separate feature. Do not run a second daemon manually.

## Dashboard and controls

Both daemon and supervisor show separate background status and prep RAM:

```text
Background  the-hub | WEAKEN | ETA ... | money ... | sec ...
Prep model  .../s potential estimate | horizon 120m | initial prep est ...
Prep RAM    ... held | preemptions ... | failures ...
```

The daemon `Worker RAM`, batch counts and income remain JIT-only. `RAM online`
includes both. `Prep model` says `upper bound` for a security-100 probe. Estimates
are initial snapshots; the current stage ETA follows the running prep operation.

Disable background prep at startup with:

```text
run supervisor.js --background-prep false
```

The supervisor does not replace an already-running daemon to change its arguments.
Stop the existing supervisor and daemon first; use their actual PIDs from `ps` if
they have arguments. Default startup remains `run supervisor.js`.

Advanced daemon-only flags: `--background-prep`, `--prep-max-ram` (GB),
`--prep-ram-fraction` (fraction, not percent), and `--prep-horizon` (minutes).
Do not start a second daemon to supply flags while the supervisor's daemon runs.

## Validation and rollout

Run `npm test` with Node 22. The original recovery tests remain, plus deterministic
prep-isolation/RAM tests and concurrent simulations of the actual daemon and
background workers. The simulator now supports distinct money/security state for
multiple targets. Tests compare enabled/disabled throughput, repair a security-100
secondary target, and inject a dead prep worker and parent shutdown.

These simulations do not model Netscript's RAM analyzer, Electron GC, real API
execution cost, external scripts or suspended/offline time. They are evidence of
ownership and scheduling invariants, not a guarantee of zero impact in-game.

After merging and pulling, sync the whole `src` directory, including
`lib/background-prep.js` and both new standalone background workers. Restart the
supervisor/daemon once. Watch sustained active `Income 60s`, misses, recovery and
restart counts while the separate prep status advances. A prepared target must
reach `READY` without launching a second H pipeline or resetting the first merely
because prep completed. Higher throughput and multi-target hacking are not part
of this change.
