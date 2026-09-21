# Protected background target preparation

This component is preparation only: its dedicated G/W workers never hack.
It prepares at most one target and stops at `READY`, using the same 100ms JIT gap
and 600ms launch cushion for the existing earning pipeline.

The two-target scheduler now consumes that READY result and may automatically
admit it as a second independent earning pipeline. It first builds a fresh plan;
the prep estimate is not the admitted income forecast. See [Controlled two-target
JIT](multi-target.md) for shared limits, admission and target-local recovery.
Use `--max-targets 1` to retain the prep-only behavior described below, including
waiting at READY without automatic promotion. Never start a second daemon.

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
and estimated minimum-security hack chance, not an exhaustive target tune. When
filling an empty second slot, the candidate must add the incremental improvement
implied by the switch threshold; it need not outperform the priority lane. Replacing
an occupied support lane still requires the full switch-threshold improvement.
Prep and eventual warmup reduce the opportunity score. An estimate is not a
promise of future income: actual threads, placement, chance and period must be
re-tuned before a later promotion.

A target at security 100 is not divided by zero or silently ignored. It is an
exploration candidate with a **chance=1 income upper bound**, labeled on the daemon
dashboard. This can overestimate its value. Preparation may be long because it
still has to execute weaken at its current security; spare RAM cannot shorten a
single action's duration. Once selected, the one candidate stays pinned.

## Isolation and RAM ownership

- The optional background-prep task owns at most one `background-grow.js` or
  `background-weaken.js` PID. Target-local hard repairs can own separate bounded
  G/W workers; all their RAM holds share the allocator. Each worker executes only
  its named action against its owned target.
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
  without progress disable prep rather than spinning. Exec failures retry after 30s.

The stage sequence is deliberately simple: weaken to minimum, grow toward maximum,
then weaken again. Large repairs can use multiple bounded waves. No simultaneous
prep batch train or JIT worker timer changes are introduced.

`READY` means money is at least 99.99% and security is within +0.001 of minimum,
with no prep worker left. In single-target mode, the candidate remains prepared
without automatically replacing the earner. In default two-target mode, the scheduler can claim the
candidate and set it to TUNING, then WARMUP, then LIVE alongside the existing
earner. It clears prep ownership before issuing normal JIT work for that target.
A deliberate later restart can also select an already-prepared target. Do not
run a second daemon manually.

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
restart counts while the separate prep status advances. In `--max-targets 1`
mode a candidate must reach READY without another H pipeline.
In default two-target mode, follow the additional admission and concurrent-income
checks in `docs/multi-target.md`; preparation itself must never reset the earner.
