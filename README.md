# Bitburner automation

Start one supervisor to manage hacking, server purchases, contracts, stocks,
IPvGO, and Darknet exploration. It also shows progression and augmentation advice,
with optional automatic purchases and resets.

**Start with `run supervisor.js` on `home`.** You do not need Singularity or
`Formulas.exe` for the hacking system. Features you have not unlocked wait while
available services keep running.

[Quick start](#quick-start) · [Profiles](#choose-a-profile) ·
[Dashboard help](#understand-the-dashboard) · [Updating](#update-without-killing-everything) ·
[Useful commands](#useful-commands) · [Full reference](docs/usage-reference.md)

## Quick start

### 1. Sync the files from your computer

Install Node.js 22, then open a terminal **in this repository** and run:

```sh
npm ci
npm run dev
```

Keep that terminal open. In Bitburner, connect the game's **Remote File API** to
Filesync on port **12525**. Wait for the upload to finish. The sync includes
all of `src`, including its `lib` folder.

### 2. Start automation in the game

In **Bitburner's terminal on `home`**, run:

```text
run supervisor.js
```

Run only one supervisor. It starts and monitors the other services, so you do not
need to launch `daemon.js` or the individual managers yourself. Open the
supervisor's script log for the overall dashboard; the daemon's log shows the
hacking dashboard.

### 3. Let it get established

- **New 8 GB home:** starter mode roots accessible servers and fills their free
  RAM with n00dles workers. It also uses spare home RAM and expands when you obtain
  port-opening programs. You can earn even when home cannot fit a worker beside
  the supervisor. Upgrade home RAM manually; the supervisor clears its starter
  pool and switches to the full hacking stack when enough home RAM is free.
- **Full hacking stack:** a target may need preparation, followed by an initial
  warmup before the first Hack lands. A startup income gap is normal.
- **Spare RAM:** JIT and preparation workers run only on rooted remote servers.
  The supervisor uses otherwise-idle home RAM for `share`, and the JIT controller
  fills currently idle remote RAM with reclaimable share workers. The home
  reserve remains available for utilities and service starts. Use `--share false`
  to disable sharing. The regular supervisor dashboard reports the live faction
  reputation multiplier and total sharing threads, RAM, and host count.
- **After an augmentation reset:** the scheduler leaves RAM headroom for batch
  peaks and plan changes. As hacking skill recovers, it can choose a smaller
  replacement that fits beside running work. Keep the supervisor running; an
  overlap wait does not call for `killall` or higher launch limits.
- **Locked features:** `BLOCKED` or `LOCKED` usually means an API or program is
  missing. It does not mean all automation has stopped.

## Choose a profile

Use **one** of these startup commands:

| Profile | In-game command | Behavior |
| --- | --- | --- |
| **Observe — default** | `run supervisor.js` | Runs the money engine and available side services; gives progression and augmentation advice. No Singularity actions or automatic resets. |
| **Assist** | `run supervisor.js --profile assist` | Also buys programs, installs faction backdoors, joins eligible factions, works for reputation, donates, and buys augmentations when allowed. Installation stays manual. |
| **Hands-off** | `run supervisor.js --profile hands-off` | Adds automatic augmentation installation at the configured threshold and restarts the saved profile afterward. |

`assist` and `hands-off` require **BitNode 4 or Source-File 4 level 1+** for their
Singularity actions. Selecting a profile does not unlock an API. `observe` is
**not a dry run**: enabled fleet and stock services can still spend money.

Explicit flags override profile defaults. For example, on a new startup:

```text
run supervisor.js --profile hands-off --min-install 8 --augmentation-city-faction Aevum
```

This allows installation after eight queued augmentations and permits the loop
to join Aevum when eligible. The default installation threshold is five; city
factions are skipped unless explicitly selected.

Hands-off checks that threshold before its next purchase or faction join, even
when expensive upgrades remain in the plan. It still waits for unrelated manual
activity to finish. If an early faction offers fewer upgrades than the threshold,
install manually or lower `--min-install`; the loop does not lower it for you.
The default hacking plan also includes The Red Pill, faction reputation upgrades,
and Neuroreceptor Management Implant.

Already running? Follow [Changing settings](#changing-settings) instead of
starting a second supervisor.

## Understand the dashboard

Read **Income 60s**, target health, and current waiting reasons together. A large
model estimate or a mostly empty RAM bar does not by itself mean the scheduler
can launch more work.

| What you see | What it means |
| --- | --- |
| `Income 60s` | Measured hacking income over the recent window. Use this to judge actual earnings. |
| `Model` | Estimated income from current plans. Warmup, Hack chance, rejected batches, and recovery can reduce actual income. |
| `Potential` | An estimate for a candidate after preparation; it is not income being earned now. |
| `Target slots 1/2` | One target is admitted, with room for **up to two**. The second needs to be worthwhile, prepared, and able to fit shared limits. Two slots are not guaranteed to stay occupied. |
| `LIVE` / `WARMUP` / `TRIAL` | Recent Hacks are completing / waiting for initial landings / evaluating a newly admitted second target. |
| `waiting for two productive minutes` | Adds each safely completed batch's own plan period until it reaches 120 seconds, and requires a recent Hack. Generation swaps preserve earned progress; deferrals can make this take longer than two wall-clock minutes. |
| `shared launch budget / fragmented batch` | A complete batch still exceeds the process-launch budget after retrying placement on fewer hosts. Free RAM does not remove this limit. |
| `WAITING_RAM` | A service or helper cannot fit its required RAM yet. |
| `gen 1 ACTIVE` and `gen 2 SHADOW` | The current plan keeps earning while a replacement is being built. |
| `PREFLIGHT` / `insufficient overlap RAM` | The replacement cannot yet fit beside committed batches. The scheduler searches smaller improving plans while existing work continues. |
| `DRAINING -> CUTOVER` in the Plan row | Old committed batches are finishing while the new generation takes over at a safe landing boundary. |
| Rebuild or deferral counts | Cumulative history. Check the current reason and whether the counts are still increasing. |

**Why might n00dles be the second target?** An empty slot seeks additional income.
With the default threshold, its candidate model needs to reach 25% of the primary
target's model; it does not have to beat the primary. Already-prepared targets can
start sooner. Once both targets are stable, promotion can replace the weaker one
with a better prepared target. See [target selection and hot swaps](docs/jit-hot-swap.md).

Formula, skill, and fleet-capacity changes use background plan tuning. If a safe
overlap cannot fit, the old plan continues earning. Safety faults can still pause
a target. A **plan** hot swap does not reload changed JavaScript files.

If the actual batch rate stays near zero with thousands of launch deferrals and
mostly unused RAM, update and restart the daemon as described below. Older
versions could spread Grow/Weaken across too many small, higher-core servers and
reject nearly every batch. The scheduler now retries with fewer worker processes
before deferring a batch; no launch-limit flag change is needed for this fix.

For more information, see [dashboard details](docs/dashboard.md),
[multi-target scheduling](docs/multi-target.md), [reset startup](docs/post-augmentation-liveness.md),
and [recovery](docs/jit-recovery.md).

## Update without killing everything

**Sync first, then restart the affected process. You do not need `killall`.**
Running scripts retain their loaded code even after Filesync updates the files.

On an 8 GB starter, a restart helper may not fit alongside the supervisor. After
syncing, use `ps` and `kill <PID>` to stop the old supervisor, then run
`supervisor.js` again with your usual flags. If a legacy home starter worker
leaves too little space, stop that worker's PID too. Remote starter workers are
adopted when the supervisor returns.

### Hacking or hot-swap updates

1. Wait for Filesync to finish uploading all changed files, including `lib` and
   the three `jit-*` workers.
2. Leave the supervisor running. On `home`, run `ps` and find the PID for `daemon.js`.
3. Run `kill <PID>`, replacing `<PID>` with that number.
4. Let the supervisor restart the daemon with its existing arguments. There is a
   restart delay; repeated failures increase that delay.

The daemon cleans up old JIT workers and deploys updated worker files. There will
be a one-time preparation/warmup period. With the hot-swap version loaded, the
daemon dashboard includes a `Plan` row with a generation number.

### Supervisor dashboard or telemetry updates

On `home`, run:

```text
run supervisor-restart.js
```

This reloads the supervisor with its saved arguments. Existing managers keep
running and are adopted again; this does **not** reload their code or change their
arguments. If you updated both daemon and supervisor helpers, restart both using
the steps above.

For Darknet coordinator updates, use `run darknet-restart.js` while the supervisor
is running. For other manager updates, stop that manager's PID and let the
supervisor replace it. Let an active backdoor actor finish before a broader restart.

### Changing settings

New supervisor flags apply to newly started services. Existing services keep
their original arguments.

1. Use `ps` to find the relevant PIDs.
2. Stop the supervisor first, then the manager(s) whose settings you are changing.
3. Start one supervisor with your desired profile and flags.

For example, detailed hacking diagnostics require a newly started daemon. After
stopping the supervisor and daemon, restart with your usual flags plus
`--dashboard-details true`:

```text
run supervisor.js --profile observe --dashboard-details true
```

Use your own profile in place of `observe`. See the
[full option reference](docs/usage-reference.md#supervisor-controls) for defaults
and the services each option affects.

## Useful commands

Run these in **Bitburner's terminal on `home`**. Reporting commands can run
alongside the supervisor.

| Task | Command |
| --- | --- |
| Inspect running scripts and their PIDs | `ps` |
| Run read-only diagnostics | `run doctor.js` |
| Show the last hour of recorded telemetry | `run telemetry.js --minutes 60` |
| Compare worker RAM costs on a remote host | `run worker-ram-check.js HOSTNAME` — replace `HOSTNAME` with a worker server |
| Show Darknet activity | `run darknet-status.js` |
| Watch Darknet activity | `run darknet-status.js --watch` |
| Show augmentation advice | `run augmentation-planner.js` — requires Singularity |
| Plan for one augmentation | `run augmentation-planner.js --target "BitWire"` |
| Show the current savings goal | `run savings.js` |
| Save $1 billion for a named goal | `run savings.js --amount 1000000000 --label "Augmentation fund"` |
| Save for the next program unlock | `run savings.js --next-program` |
| Clear the savings goal | `run savings.js --clear` |

There is one shared savings goal at a time. Setting a new one replaces the old
one. Participating fleet, stock, and progression services respect its cash floor;
manual purchases and unrelated scripts do not. Saving does not itself buy an
augmentation or trigger a reset.

Before Singularity, `run savings.js --next-program` can protect cash for a manual
program purchase. Add `--darknet false` to that command to skip the navigator.
The supervisor's `--darknet false` also skips automatic navigator purchases and
savings, while preserving any goal you set manually.

## Feature requirements and advanced options

The core hacking system works without Singularity or `Formulas.exe`. Other
features have their own unlocks:

| Feature | Main requirement |
| --- | --- |
| Program purchases, faction backdoors, augmentation advice/actions | Singularity: current BN4 or SF4 level 1+. Lower SF4 levels outside BN4 have higher API RAM costs. |
| Stock trading | WSE Account, TIX API, and 4S Market Data TIX API access. Short entries additionally need BN8 or SF8 level 2+. |
| Darknet exploration | `DarkscapeNavigator.exe`, or BN15/SF15 access that grants it. |
| IPvGO | The ordinary `ns.go` API; no Singularity requirement. |
| Fixed savings goals | No Singularity requirement. |

BN means your current **BitNode**; SF means an owned **Source-File**. Missing
unlocks are reported per feature, and unlocked services still need enough RAM.

Use the [usage reference](docs/usage-reference.md) for complete requirements,
all supervisor flags, savings behavior, fleet investment settings, augmentation
rules, and advanced Darknet options. Destructive Darknet operations are explicitly
opt-in and are not enabled by any standard profile.

## Development and further reading

On your computer, in this repository:

```sh
npm test
```

CI uses Node 22. Tests include deterministic hacking simulations, worker ownership,
hot swaps, recovery, service restarts, spending, solvers, and telemetry. These do
not replace the game's RAM analyzer or checking a live run after deployment.

- [Full usage and option reference](docs/usage-reference.md)
- [Supervisor and service lifecycle](docs/supervision.md)
- [Multi-target scheduling](docs/multi-target.md)
- [Plan hot swaps](docs/jit-hot-swap.md)
- [Background target preparation](docs/background-prep.md)
- [Recovery and validation](docs/jit-recovery.md)
- [Stocks](docs/stocks.md), [contracts](docs/contracts.md), and [IPvGO](docs/ipvgo.md)
