# Supervision and progression execution

The supervisor owns service lifecycle records, not the JIT scheduler. It adopts
one existing process per service on `home`, retaining its actual arguments and
thread count. An existing daemon is not replaced just to apply new CLI flags.
Duplicate services are shown as `CONFLICT`; they are not broadly killed.
Only one supervisor may run on `home`. Newly launched dependents inherit the
adopted fleet status port. Conflicting existing daemon/fleet port settings fail
startup rather than silently rewriting either process.

## Service lifecycle

New/adopted managers get 60 seconds of startup grace. After that, an old or missing
heartbeat must remain suspect for another 15 seconds before recovery. The normal
stale threshold is 15 seconds, or three advertised heartbeat intervals when longer.
Producer PIDs and publication times distinguish a restarted manager from its old
snapshot. Startup does not reuse a previous process's heartbeat as evidence of life.

A missing service is restarted with its saved arguments after 5 seconds. Repeated
failures back off exponentially to five minutes. Two minutes of healthy operation
reset the failure streak, not the cumulative restart count. Failed PID cancellation
never grants permission to launch a duplicate. Startup/launch failures and the last
recovery remain visible after the dashboard clears its log.

The daemon is checked for process existence only. Preparation, recovery and slow
log refreshes are not heartbeat failures. Its bootstrap now leaves an existing
fleet manager and its budget flags alone. Its startup port validation reserves every supervisor-owned status/action channel, including IPvGO.
Allocation, timing, event consumption and background preparation are unchanged.

Fleet discovery and contract scanning publish lightweight heartbeats while yielding
through their work, not just between passes. This is cooperative liveness reporting;
a synchronous computation that freezes the entire browser cannot independently
publish a heartbeat. No extra heartbeat daemon is added.

## Stock service and shared cash

Port 13 (`PORTS.STOCK_STATUS`) is reserved for the 4S stock trader. When stock
automation is enabled, the supervisor manages `stock-trader.js` as a heartbeat
service and displays its portfolio state. WSE, TIX and 4S TIX access are checked
outside the lifecycle restart loop: missing access puts the service in `BLOCKED`
without accumulating failures or backoff. An active trader that loses access
stops itself without liquidating positions; the supervisor does not immediately
relaunch it while the capability remains unavailable.

The stock heartbeat advertises an absolute cash reserve floor. Fleet cloud
spending preserves the maximum of its own reserve policy and this fresh stock
floor. Dry-run, blocked, malformed and stale stock heartbeats do not reserve cash.
This coordination is budget-only: stocks do not own JIT RAM, fleet allocation,
worker ports or target selection.

## Darknet service

Port 10 carries the singleton `darknet-manager.js` heartbeat and port 9 is a
bounded event queue from disposable Darknet agents. The manager owns the durable,
reset-bound `data/darknet-state.json` record and launches one home agent after
`DarkscapeNavigator.exe` is available. Agents authenticate neighboring servers,
copy themselves and their dependencies, recover blocked RAM, open caches and
launch bounded phishing workers. A lost or moved server therefore affects only
its local disposable processes; surviving neighbors rediscover it.

`Formulas.exe` is a live capability rather than a startup requirement. The JIT
scheduler drains and retunes individual lanes when hacking formulas become
available, while background admission, Darknet agents, and the augmentation loop
re-evaluate formulas during their normal ticks. Every formulas call is guarded and
falls back to the existing approximation if the file or API is unavailable.

Darknet RAM is not admitted to the JIT allocator. Per-PID sessions, topology
mutation and abrupt server deletion are incompatible with precise HWGW landing
reservations. Risky policies—stasis, induced migration, stock promotion, freezing,
and Storm Seed—are independently flagged and default off. Freezing and Storm Seed
remain off in every supervisor profile.

## IPvGO service

Port 12 (`PORTS.GO_STATUS`) is reserved for the singleton IPvGO bot. Go automation
is enabled by default and can be disabled with `--go false`. The supervisor adopts
an existing `go-bot.js` process and its arguments or launches one with continuous
defaults; duplicate Go processes remain a conflict rather than being broadly killed.

The Go status channel is informational, not a heartbeat watchdog. Opponent API calls
can legitimately wait for an unbounded amount of time, so stale Go status never
causes the supervisor to kill a live game. Ordinary process exits still use bounded
service restart/backoff. Safety exits are different: the bot publishes terminal
`go-status` before exiting, and the supervisor marks that exact PID `BLOCKED`
instead of starting another bot against an uncertain board. Restarting the supervisor
or explicitly starting a new Go bot is therefore a conscious retry boundary.


## Action protocol

Port 14 (`PORTS.PROGRESSION_ACTION`) is a single request/result slot, separate from
JIT events (20), fleet status (19), contract status (18), JIT status (17), progression
status (16), JIT control (15), stock status (13) and Go status (12). Do not reuse it for unrelated scripts.

The planner publishes independent `objectives`, a `planRevision`, and a reset epoch
made from current BitNode, last BitNode reset and last augmentation reset. Its
`plannedAt` is separate from the heartbeat's `generatedAt`; refreshing liveness does
not make an old plan fresh. Plans older than 15 seconds are not actionable.

The supervisor passes the chosen request as a JSON script argument. Requests include
an ID, owner PID, kind, target, reserve, plan revision, creation/expiry times and reset
epoch. Actors reject malformed, expired, mismatched-reset and non-allowlisted requests,
verify real BN4/SF4 access, and claim only the pending request that matches their
command line. Direct unbound launches of the actor scripts do nothing.

Only TOR, the five port-opening programs, `DarkscapeNavigator.exe`, and the four faction backdoors are admitted.
`w0r1dd43m0n`, faction work, arbitrary program purchases and augmentation/reset actions
are not supported. The request expiry limits admission, not an installation already
in progress. A long-running backdoor is tracked by PID and is not heartbeat-killed.

Actors report `running`, `succeeded`, `blocked` or `failed`, with a reason and matching
request ID. A late result cannot overwrite a newer request. A process that exits
without a final result is shown as failed. The last result survives actor exit and
dashboard redraws; a replacement supervisor can adopt a surviving actor. Existing
legacy actors without the new protocol are left alone until they exit.

## Dependencies, budget and manual control

An unaffordable program does not block an independent ready backdoor. Program order
is retained for purchases. Planner prices are upstream estimates, while the purchase
actor gets the live darkweb quote and checks actual cash and ownership immediately
before buying. TOR's current price is 200,000. A 10% reserve is retained by default;
the shared `savings.js` floor is checked in addition to this percentage by fleet,
stock entries and progression purchases. Only the goal's named TOR/program
purchase may consume that floor. External scripts do not participate.

No worker is killed to make space for a progression actor. Insufficient `home` RAM
is displayed as `WAITING_RAM`; retries are bounded. Leave sufficient controller/actor
RAM available when enabling Singularity operations. They still incur their normal
in-game RAM costs even though the scripts are short-lived.

Backdoors are allowlisted to CSEC, avmnite-02h, I.I.I.I and run4theh111z. Actors recheck
root, skill, installed state and `isBusy()` before navigating and before installation.
Normal completion and exceptions attempt restoration from the last successfully
reached hop. Observable manual connection changes or a newly busy player take
priority over restoration. A failed restoration is reported separately from the
installation result. No `stopAction()` or forced takeover is used. These guards use
the observable APIs; they do not claim to detect all UI activity or Bladeburner work.
Forced script termination is not a guarantee that JavaScript `finally` executes.

## Rollout

Sync the entire `src` directory, including the three new library modules. Stop the
old supervisor first. Use `ps` and the actual PIDs to restart fleet, contract and
progression managers so they load the updated code. Let any old backdoor actor finish.
The active hacking daemon does not need to be stopped for this migration; its small
bootstrap change takes effect the next time it starts.

Planner-only startup remains:

```text
run supervisor.js
```

To opt into only the original program/backdoor actions explicitly:

```text
run supervisor.js --progression-actions true --progression-cash-reserve 0.10
```

The common action combinations use profiles:

```text
run supervisor.js --profile observe
run supervisor.js --profile assist
run supervisor.js --profile hands-off
```

`observe` is read-only for Singularity actions, `assist` enables progression and
augmentation actions without installing, and `hands-off` also enables automatic
installation. Explicit flags override profile values, so exceptional runs can
still adjust one setting without restating the whole configuration.

It joins invited non-city factions, selects available faction work, donates for an
exact reputation gap when favor and `Formulas.exe` permit it, purchases the next
reputation-ready and funded planned augmentation, and records which faction work
it owns. Donations preserve the planned purchase, percentage reserve, and unrelated
savings floor. Unrelated player work is never stopped or replaced. City invitations
are ignored unless one is selected with `--augmentation-city-faction`. When
Singularity is locked, status recommends BN4/SF4 and makes no calls through the
locked API.

Installation remains disarmed unless `--auto-install true` is supplied. It also
requires `--min-install N` queued augmentations, no remaining matching plan item,
no unrelated player activity, and a present `bootstrap.js`. Before resetting, the
supervisor arguments are persisted; `bootstrap.js` restores that exact command
after installation. The default threshold is five.

To change an existing daemon's launch settings deliberately, stop the supervisor and
that daemon first. The supervisor will not silently replace live processes to force
new settings. Service argument history is session-local; after a full shutdown,
relaunch with the intended flags. To pause auto-recovery, stop the supervisor first.

## Validation

`npm test` uses Node's built-in test runner to discover every `test/*.test.cjs` file.
Coverage includes startup grace, real PID ownership, argument preservation, capped
backoff, long scans, stale/reset-bound plans, actor admission, blocked purchases,
RAM shortage, partial routing failures, manual control, long actions, supervisor
replacement and late results. Existing JIT and background-prep simulations remain.

These are deterministic mocked Netscript tests, not an in-game execution test or a
replacement for the Netscript RAM analyzer. Smoke-test planner-only mode first, then
opt in and watch `Action`, `Last result`, `Connection` and the service recovery rows.
The heartbeat cinematic universe has been replaced by regression tests.

## Savings and telemetry

The supervisor displays the shared savings goal and the fleet investment decision.
It writes one bounded telemetry sample per minute by default, outside the JIT loop.
Use `--telemetry false` to disable recording. See the root README for the savings,
augmentation planner, telemetry report, and read-only `doctor.js` commands.

## One-command utility management

`run supervisor.js --profile assist` includes automatic program and augmentation
savings, one startup diagnostic pass, periodic read-only augmentation advice,
telemetry recording, and a rolling one-hour history summary. Standalone utility
commands are optional. Use `--savings augmentations` to reserve for the next
augmentation recommendation, `--save-amount N` for a fixed manual goal, or
`--savings keep` to disable automatic goal updates. Automatic policies preserve
active manually configured goals. Program savings uses the configured progression
reserve and waits for Singularity and enabled progression actions.

With augmentation actions enabled, `--savings auto` advances from completed port
programs to the next augmentation. Fleet and stock entries protect that goal; only
the matching augmentation purchase may consume it. The augmentation manager has
its own percentage reserve and rechecks the live price, reputation and queued
ownership immediately before each mutation.

`--cloud-roi` and `--cloud-payback` are forwarded to newly launched fleet managers.
The diagnostic/planner children are serialized, never heartbeat-killed, and retry
RAM shortages or failed runs with bounded delays. Planner capability is checked
before launch. Reports use files rather than new reserved ports, and are bound to
the child PID, publication time and current reset. Stale advice is not used for
savings. Diagnostics runs once per supervisor session; planning repeats about once
per minute. New daemons reserve helper RAM automatically; adopted daemons retain
their old arguments. Use the root README for all flags and deployment instructions.
