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
quiet period. An active recovery cancels the owned prep wave, not the income workers.
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

- The optional task owns one target and a distributed wave of `background-grow.js`
  or `background-weaken.js` processes. Target-local repairs can own separate waves;
  every PID's RAM hold is visible to the existing shared allocator.
- By default a wave may use **50% of eligible spare RAM**, after checking live RAM
  and all future JIT reservations. Home is excluded. The existing
  `--prep-ram-fraction` setting now applies to spare capacity, defaults to `0.5`,
  and is capped at `0.9`. This leaves headroom and scales with the fleet.
- `--prep-max-ram` remains an optional absolute GB limit; its new default `0` means
  no additional absolute cap. Set a positive value to enforce one. There is no
  implicit 16 TB ceiling. A zero fraction prevents allocations.
- On a tiny fleet, a positive fraction allows at least one worker thread when it
  fits, even if that exceeds the fraction. Actual capacity and an explicit absolute
  cap still win. A home-only fleet retains the existing no-background-on-home rule.
- The planner uses the daemon's `availableRam(now, Infinity)` callback, including
  foreign/service usage, other prep holds and all committed future reservations.
  Optional XP and configured share filler yield to prep. Core-efficient hosts,
  then larger available hosts, are preferred; remaining work spans more hosts.
- Capacity scanning yields between hosts, and every exec rechecks capacity and
  the shared launch/worker limits. Pending chunks resume in safe scheduler windows
  while the wave runs, rather than waiting a whole grow duration per host. If a
  chunk exits before pending work launches, the remainder is recalculated after
  the live workers finish, since target security may have changed.
- Each RAM hold survives until that PID exits or is successfully cancelled. The
  ETA is the latest predicted finish of live workers, not a RAM release timer.
  Foreign RAM measurement subtracts every owned prep PID exactly once.
- A failed income reservation preempts prep and retries the **same landing slot**.
  A same-host JIT exec failure can likewise reclaim a distributed wave. A failed
  kill retains that worker's hold; successfully stopped peers release theirs. Prep
  workers also count toward the shared process limit, and income can reclaim
  optional prep slots before rejecting a batch for worker pressure.
- No background worker reads/writes JIT event/control ports. Prep cancellation
  uses only its recorded PIDs, never `scriptKill` or `killall`.
- A daemon exit cancels all its owned prep children. Startup orphan cleanup matches the two
  dedicated filenames, a positive dead owner PID and the `bgprep-` ownership tag.
- Prep errors disable only this optional feature and remain visible. Three waves
  without progress disable prep rather than spinning. If no chunk launches, exec
  failures retry after 30s; successful chunks retain their holds and finish first.

The stage sequence is deliberately simple: weaken to minimum, grow toward maximum,
then weaken again. Growth sizing shares one helper between candidate estimation
and execution: use `formulas.hacking.growThreads` when available, otherwise
`growthAnalyze(target, maxMoney / max(1, currentMoney), cores)`, with the existing 5%
margin. Formulas include additive growth from zero money; the fallback uses a
one-dollar seed. Calls retain the game's player, BitNode and server modifiers.
Each host contributes a fraction of its core-aware full requirement; weaken
threads use `weakenAnalyze(1, cores)` to remove the actual security deficit.

The planner records grow security with `growthAnalyzeSecurity(threads, target,
cores)` for each launched chunk, following the [game API](https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.ns.growthanalyzesecurity.md). After growth exits, the next stage always repairs
measured security before another grow or READY. This deliberately reuses the
sequential G/W architecture instead of reserving a simultaneous compensation
batch. Distributed growth can encounter increasing security at completion, so
partial results are remeasured and may need another wave. Long action durations
are unchanged; each cycle can now do fleet-sized work.

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
Prep RAM    ... held
Prep note   481 grow threads across 6 hosts
```

The daemon `Worker RAM`, batch counts and income remain JIT-only. `RAM online`
includes both. `Prep model` says `upper bound` for a security-100 probe. Estimates
are initial snapshots; the current stage ETA follows the running prep operation.
Thread/host counts and held RAM aggregate live workers. `--dashboard-details true`
shows per-host allocations and the last plan's diagnostic record, including target,
action, current/desired money, required one-core threads/RAM, planned and launched
threads/RAM, free and protected capacity, budget, pending hosts, grow security and
any partial-allocation reason. The status port exposes the same diagnostics. This
uses the existing optional detailed dashboard rather than INFO spam each tick.

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

## Investigation: tiny grow chunks on a large fleet

The old `stepPrep` rotated through one host per 500ms tick, bounded slots by that
host's free/unreserved RAM, and launched `min(slots, needed)` threads. Its
`state.active` branch returned until that single PID exited. Thus a 16 GB host
running a 1.75 GB grow worker supplied only `floor(16 / 1.75) = 9` threads,
regardless of idle RAM elsewhere. The dashboard described the entire allocation,
not one hidden part of a larger wave. `growthAnalyze` already received the correct
max/current multiplier and worker cores. The independent 1% / 16 TB cap also
limited scaling, but cannot itself explain only 16 GB on a 1.42 PB fleet.

Lifecycle map:

1. `serviceBackgroundAndAdmission` gates scouting on lane health, policy priorities
   and scheduler windows; `estimateBackgroundCandidate` scans one server per tick
   and preserves additive-slot versus promotion scoring.
2. `prepHealth` selects minimum-security weaken, then grow, then security repair,
   stopping at 99.99% money and minimum security +0.001.
3. `prepGrowThreads` sizes growth; `planBackgroundWave` sizes core-aware weaken
   and distributed placements through the shared temporal-capacity callback.
4. `launchPrepWave` revalidates every placement and records successful PIDs.
   `backgroundPrepRam` exposes per-host holds to income reservations and foreign
   usage accounting. No independent fleet reservation ledger is introduced.
5. `stepPrep` confirms exits, measures progress and selects the next stage.
   `cancelBackgroundPrep` handles recovery, same-slot income preemption and exit.
6. `renderDashboard` / `renderSchedulerDashboard` use aggregate RAM, the wave's
   aggregate reason and latest ETA; detailed diagnostics show individual workers.

Regression tests cover distributed/full/partial waves, low-RAM progress, large
idle fleets, mixed cores, formulas and API fallback, zero/near-max money, security
compensation, reservation protection, per-PID release/cancellation, launch-window
resumption and dashboard aggregates. Existing concurrent income and MONEY/XP/
NORMAL simulations remain part of the full suite.
