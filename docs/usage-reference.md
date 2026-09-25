# Usage reference

Start with the [README](../README.md) for setup, profiles, dashboard help, and restart instructions. This page keeps the full feature requirements and advanced options in one place.

## BitNode, Source-File, and API requirements

**You do not need Singularity to run the supervisor.** Individual features have
their own requirements. BN means your **current BitNode**; SF means an owned
**Source-File**, which can unlock a feature outside its original BitNode.

| Feature / command option | Required unlock | Behavior without it |
| --- | --- | --- |
| Supervisor, hacking, fleet management, contracts, diagnostics, telemetry | No specific BN or SF gate in this repo; sufficient RAM and the relevant servers/APIs must be available | Normal resource and capability limits still apply |
| Progression status and recommendations | No Singularity requirement | Reports missing programs/backdoors; does not execute actions |
| `--progression-actions true`: TOR/program purchases, DarkscapeNavigator, and faction backdoors | **BN4 or SF4 level 1+** (Singularity) | Actions are blocked; other services continue |
| Darknet exploration | `DarkscapeNavigator.exe`, or BN15/SF15 access that grants it | Coordinator reports `LOCKED`; other services continue |
| Automatic program savings (`--savings auto` or `programs`) | **BN4 or SF4 level 1+**, plus enabled progression and `--progression-actions true` | Waits instead of creating a new automatic program goal |
| Augmentation planning (`--augmentations true`, `--augmentation-focus`, `--augmentation-target`, or standalone planner) | **BN4 or SF4 level 1+** | Planner shows `BLOCKED: Singularity is locked` |
| Augmentation loop (`--augmentation-actions true`) | **BN4 or SF4 level 1+** | Reports how to unlock Singularity and performs no actions |
| Automatic installation (`--auto-install true`) | **BN4 or SF4 level 1+**, augmentation actions, and the configured queued-augmentation threshold | Remains advisory; no reset occurs |
| `--savings augmentations` | **BN4 or SF4 level 1+**, enabled augmentation planning, and a fresh complete plan | Automatic savings waits for a plan; an existing goal is preserved |
| Fixed savings (`--save-amount`, `--save-label`, or standalone `savings.js`) | **No Singularity, BN, or SF requirement** | Cash protection works independently of planning; automatic spending on a program still requires Singularity |
| 4S stock trading, including long positions | **WSE Account + TIX API + 4S Market Data TIX API access**; no specific BN/SF gate for longs | Stock service is blocked until all three are available; it does not buy access automatically |
| Short stock positions | All stock access above, plus **BN8 or SF8 level 2+** | Trader uses long-only entries and leaves existing shorts untouched |
| IPvGO bot | Ordinary `ns.go` API; **no Singularity requirement** | The bot reports API/game errors if unavailable; it does not use the SF14.2-only `go.cheat` APIs |

These are feature gates in this implementation, not a promise of identical income
or server availability in every BitNode. BitNode rules and multipliers still apply.
The hacking daemon does **not** require `Formulas.exe`. It uses a conservative
fallback model when the program is unavailable. Formula availability changes trigger
background tuning; an improved plan is adopted through a safe same-target hot swap
when shared resources permit. The current plan keeps earning while a candidate waits.
See [plan hot swaps](jit-hot-swap.md). Background target admission checks formula
availability on its next candidate evaluation.

SF4 level 1 is enough to unlock Singularity, but outside BN4 its APIs have higher
RAM costs at lower SF4 levels. An unlocked planner or progression actor can still
show `WAITING_RAM`; the supervisor never kills workers to force a helper to fit.

The `assist` and `hands-off` profiles need Singularity for their progression
actions; augmentation savings also needs it for planning. Fixed savings does not.
**Selecting a profile does not unlock the required API.**

## Supervisor controls

No separate utility commands are required. Examples below are alternative startup
commands, not additional supervisors to run concurrently:

```text
run supervisor.js --profile assist
run supervisor.js --profile assist --cloud-payback 3600
run supervisor.js --savings augmentations --augmentation-focus hacking
run supervisor.js --save-amount 1000000000 --save-label "My fund"
```

| Flag | Default | Behavior |
| --- | --- | --- |
| `--profile` | `observe` | `observe`, `assist`, or `hands-off`; explicit flags override profile settings |
| `--max-targets` | `2` | Maximum simultaneous earning targets: 1 or 2; does not guarantee both slots are occupied |
| `--background-prep` | `true` | Prepare promising targets while the current target earns, subject to health and resource gates |
| `--dashboard-details` | `false` | Show detailed diagnostics; forwarded to a newly started daemon |
| `--go-takeover` | `true` | Finish an existing ordinary IPvGO board on startup; set false when playing manually |
| `--diagnostics` | `true` | Run `doctor.js` once at startup; show warnings |
| `--augmentations` | `true` | Refresh advice about once a minute; requires BN4 or SF4 level 1+ |
| `--augmentation-focus` | `hacking` | `hacking` or `all` |
| `--augmentation-target` | empty | Plan for one named augmentation and its prerequisites |
| `--augmentation-price-multiplier` | `1` | Assumed price growth per purchase; 1 gives a lower bound |
| `--augmentation-actions` | `false` | Join safe invitations, work for reputation, and purchase the planned augmentations |
| `--augmentation-cash-reserve` | `0.10` | Cash fraction retained after an automatic augmentation purchase |
| `--augmentation-city-faction` | empty | The only city faction the loop may auto-join; city invitations are skipped when empty |
| `--augmentation-join-factions` / `--augmentation-work` / `--augmentation-donate` / `--augmentation-purchase` | `true` | Individual action gates within an enabled loop; donations also require favor and `Formulas.exe` |
| `--augmentation-focus-work` | `false` | Whether automatic faction work takes focus |
| `--auto-install` | `false` | Install queued augmentations and restart through `bootstrap.js`; requires augmentation actions |
| `--min-install` | `5` | Install at this queued count before another purchase/join; remaining catalog items do not delay it. Requires auto-install. |
| `--savings` | `auto` | Automatic program/augmentation modes require Singularity; see [requirements above](#bitnode-source-file-and-api-requirements) |
| `--save-amount` | unset | Set a fixed manual goal instead of automatic savings; no Singularity required |
| `--save-label` / `--save-target` | `Savings` / empty | Label and optional allowed program purchase for a fixed goal |
| `--cloud-roi` / `--cloud-payback` | `true` / `1800` | Fleet investment policy for newly started fleet managers |
| `--telemetry` | `true` | Record history and show a rolling one-hour summary |
| `--home-reserve` | `8` | Minimum home RAM kept out of sharing for utilities and service starts |
| `--share` | `true` | Fill spare home and unreserved remote RAM with elastic faction-share workers |
| `--darknet` / `--darknet-phish` | `true` / `true` | Supervise exploration and idle phishing; disabling Darknet also skips automatic navigator purchases/savings |
| `--darknet-phish-threads` / `--darknet-max-attempts` | `1024` / `600` | Bound per-server phishing workers and password attempts |
| `--darknet-concurrency` / `--darknet-agent-threads` | `4` / `4` | Crack several visible neighbors concurrently and scale roaming calls when a server has spare RAM |
| `--darknet-stasis` / `--darknet-stasis-depth` | `false` / `8` | Opt in to scarce stasis links on sufficiently deep servers |
| `--darknet-migrate` / `--darknet-migrate-depth` | `false` / `8` | Opt in to induced migration of deep movable neighbors |
| `--darknet-promote-stock` / `--darknet-stock-symbols` | `false` / `auto` | Opt in to volatility promotion for held or explicitly listed symbols |
| `--darknet-freeze-unknown` / `--darknet-freeze-depth` | `false` / `0` | Destructively freeze unsolved servers; they lose all RAM and experience |
| `--darknet-storm-seed` | `false` | Execute a discovered `STORM_SEED.exe`; catastrophic and deliberately never profile-enabled |

Savings modes: `auto` advances through TOR, missing port openers, and `DarkscapeNavigator.exe`, then follows
the augmentation loop when it is enabled; `programs` stops after the Darknet unlock;
`augmentations` follows the next fresh, complete augmentation recommendation;
`keep` preserves the current goal without automatic updates; `none` clears it at
startup and disables automatic updates. Active manual goals are preserved by
automatic modes. Use `--savings none` for a startup that clears the current goal,
or set a new fixed amount explicitly. Augmentation savings does not buy or reset.

Diagnostics and planning run as short-lived children, one at a time, with bounded
retry delays. Their Singularity calls stay out of the supervisor's imports. A newly
launched daemon leaves extra home RAM for helpers; an adopted daemon keeps its old
reserve, so restart it if the dashboard reports `WAITING_RAM`. Reports are in
`data/diagnostics.json` and `data/augmentation-plan.json`. PID, timestamp, and reset
checks reject old reports. Augmentation advice expires after two minutes without
refreshing. Enable `--dashboard-details true` for the shopping list and more warnings.

## Save for a goal

The `assist` and `hands-off` profiles manage this automatically.
These standalone commands remain available for changing goals while it runs:

```text
run savings.js --next-program
run savings.js --amount 1000000000 --label "Augmentation fund"
run savings.js
run savings.js --clear
```

One goal at a time, stored in `data/savings.json` on home. Setting a goal replaces
the previous one. Fleet, stock entries and progression purchases preserve its
absolute cash floor in addition to their own reserve policies. Stock exits and
free backdoors remain allowed. `--next-program` saves for TOR or the next missing
program unlock, including the default 10% progression reserve. It is a one-time goal,
not automatic advancement through every program. The matching actor may spend
the protected funds; once owned, that goal becomes inactive. Other goals stay
protected until manually cleared/replaced. Goals become inactive after an
augmentation or BitNode reset. Corrupt configuration blocks spending until fixed.
Manual purchases and scripts outside this repo do not obey this policy.

The dashboard shows protected cash and an approximate ETA using gross hacking
income. It excludes future stock returns and other spending. This does not force
stock liquidation to fund a goal. A fresh stock heartbeat can retain the previous
floor briefly after a goal is cleared.

## Explore the Darknet

Darknet automation starts automatically once `DarkscapeNavigator.exe` is owned. The
home coordinator keeps reset-bound discoveries and credentials in
`data/darknet-state.json`; disposable agents spread neighbor-to-neighbor because
Darknet probing and execution are local and servers can move, restart, or disappear.
Agents solve every current upstream server-model family, traverse the Labyrinth,
reclaim blocked RAM, open caches, and use otherwise-idle RAM for phishing. Darknet
RAM is intentionally separate from the timing-sensitive JIT allocator.

The roaming crawler enters through a 15.90 GB dynamic-RAM bootstrap, below the
16 GB `darkweb` limit; the game still enforces every API actually called. Expensive
optional calls (stasis, migration, stock promotion, freezing, and Storm Seed) run
as isolated one-shot workers so enabling their code cannot prevent exploration.
Neighbor authentication is bounded-concurrent, preventing one slow server from
stalling every other visible route.

To restart a supervisor-launched coordinator without reproducing its arguments,
use `run darknet-restart.js` on home while the supervisor is running. It stops the
manager by PID and gives the supervisor time to replace it with its saved arguments.
If no replacement appears, the helper starts the manager directly with default arguments.
Use `run darknet-status.js` for a one-shot activity report, or
`run darknet-status.js --watch` for a live tail window showing coverage, agents,
deployments, caches, blockers, and the most recent event.
After syncing dashboard changes, use `run supervisor-restart.js` to reload the
supervisor while preserving its saved profile and command-line flags.

When `Formulas.exe` becomes available, active agents immediately use Darknet
formulas to estimate authentication and Heartbleed timing, retry cooldowns, and
the number of memory-reallocation calls. The coordinator and dashboard expose the
active mode; no Darknet service restart is needed.

The ordinary `observe`, `assist`, and `hands-off` profiles enable exploration,
loot, and phishing but do not enable consequential topology mutations. Stasis,
migration, stock promotion, freezing, and Storm Seed each require their explicit
flag. Freezing destroys the target's RAM and experience; Storm Seed can catastrophically
alter the network. To change these policies, stop the supervisor and the existing Darknet manager, then
start the supervisor with the new flags. Existing services retain their original
arguments when adopted; see [changing settings](../README.md#changing-settings).


## Buy RAM when it can help

Fleet's `--cloud-roi true` default compares affordable new servers and upgrades
by estimated payback. After bootstrapping the first cloud server, it requires a
fresh live scheduler snapshot, productive lanes, and RAM pressure. It defers when
batch/worker/launch pressure suggests a throughput bottleneck. Estimated marginal
income uses current income per used GB, a 50% discount, and batch-rate headroom;
it is a heuristic, not a guarantee. Default maximum payback is 1800 seconds. If
the available action budget is at least four times the cheapest RAM improvement,
a surplus-cash override buys the affordable candidate adding the most RAM even
when conservative scheduler/ROI evidence is unavailable or rejects every candidate.
Savings, stock, percentage and per-action cash limits still apply.

Configure it directly at supervisor startup:

```text
run supervisor.js --profile assist --cloud-payback 3600
```

`--cloud-roi false` restores unconditional affordability-based purchases. The
default surplus override prevents large unprotected balances from stalling fleet
growth while retaining ROI discipline at smaller balances. Existing managers must be
restarted to change flags. The dashboard's `RAM investment` row explains decisions.

## Plan augmentations

The supervisor refreshes advice and shows the next purchase automatically. The
standalone commands are optional ways to print the full plan:

```text
run augmentation-planner.js
run augmentation-planner.js --focus all
run augmentation-planner.js --target "BitWire" --save-goal
```

**Requires BN4 or SF4 level 1+ (Singularity).** Looks at joined factions, removes owned/purchased items,
expands prerequisite chains, selects the faction with the smallest reputation gap,
and prefers reputation-ready purchases. Within that group it prioritizes The Red
Pill, faction reputation upgrades and Neuroreceptor Management Implant, then
expensive eligible purchases. Those progression/support upgrades are included in
the default hacking focus; `--target` remains an explicit override. NeuroFlux is
excluded from automatic purchasing. Missing prerequisites
from unjoined factions are reported. This is a useful ordering heuristic, not a
global optimization over every faction, donation, or unlock.

Current quotes are live; the default basket total is a lower bound before future
purchase inflation. `--price-multiplier N` projects a user-specified per-purchase
multiplier. Re-run after purchases. The next purchase's cash target uses its live
quote. `--save-goal` explicitly replaces the shared savings goal with that amount.
The standalone planner never buys, works for a faction, donates, installs
augmentations or resets. The separately gated augmentation loop can join invited
non-city factions, perform faction work, donate when favor and `Formulas.exe` make
the exact reputation cost available, and buy its next planned item. It never
interrupts unrelated player activity. City factions require
`--augmentation-city-faction`, and installation additionally requires
`--auto-install true` plus the queued-augmentation threshold. Donations retain
enough cash for the planned purchase, the percentage reserve, and unrelated goals.

Automatic installation checks `--min-install` before another purchase or faction
join, even if the plan still contains items. Queued NeuroFlux levels purchased
manually count toward the threshold. Small exhausted catalogs remain manual until
you lower the threshold or unlock additional factions. Faction-work ETAs include
the game's existing sharing bonus once, plus the actual/configured focus penalty;
only an installed Neuroreceptor Management Implant removes that penalty.

`progression-manager.js --darknet false` omits the navigator from its plan.
The supervisor passes this flag and also filters adopted older plans before
dispatch. For manual savings without Singularity, use
`run savings.js --next-program --darknet false` to reserve for port programs only.

## Record and diagnose

Startup diagnostics and the one-hour history summary are already in the supervisor.
For an on-demand report or a remote worker RAM check:

```text
run telemetry.js --minutes 60
run doctor.js
run worker-ram-check.js cloud-00
```

Supervisor telemetry is enabled by default (`--telemetry false` disables it).
It samples once per minute, outside the daemon, and keeps the latest 1440 samples
in `data/telemetry.json` (about 24 hours of continuous runtime). It records income,
RAM, admission failures, recoveries, target state, recent retirements, stock
results, and fleet purchases. History survives service restarts; summaries never
subtract cumulative counters across process or reset boundaries. Stale/missing
status is recorded as unavailable, not zero income. Export the JSON for longer
analysis. Writes are bounded; errors appear on the supervisor dashboard.

`doctor.js` inspects controller imports, script RAM, home headroom, duplicate
services, port collisions, snapshot ownership, savings and API access. It changes
nothing. It reads the live supervisor's profile and explicit flags (observe
defaults if no supervisor is running). RAM advice separates the core, enabled
unlocked services, and the largest enabled helper; locked/disabled actors are not
budgeted. The separate worker checker compares worker RAM on home and a chosen
remote host. No Node test substitutes for the game's static RAM analyzer or a
live soak after deployment.
