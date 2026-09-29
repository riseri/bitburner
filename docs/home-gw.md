# Opportunistic home Grow/Weaken and capital

Home stays outside `network.hosts`, including both direct network discovery and
fleet status consumption. Previously all money, prep and XP execution used remote
workers. Now `cfg.homeGw.host` is a separate capability with `allowHack: false`.
Only the G/W allocators and action-aware prep/XP paths append it to candidates.
Generic fleet capacity, remote RAM utilization and cloud host counts exclude home.

## Execution and ownership

`lib/home-capacity.js` centralizes accounting. At most once per second, the
existing scheduler maintenance pass observes home processes and its actual cores.
Only live PIDs recorded in the scheduler/prep ownership ledgers count as owned.
Everything else, including manual copies of worker scripts, counts as unrelated
RAM. Actual `getServerUsedRam` remains authoritative at every launch.

For an interval, available G/W capacity is home maximum RAM minus unrelated
usage, the protected reserve, owned prep holds and peak temporal reservations.
Running JIT/XP work is represented by the existing temporal ledger rather than
subtracted twice. Home never uses the remote foreign-RAM cache. A live pre-exec
check leaves the protected reserve free even if a service appeared after planning.
An allocation that becomes impossible fails through existing batch recovery.

The protected reserve is the greater of `--home-reserve` and the supervisor's
service/helper admission requirement. The existing daemon startup reserve remains
a conservative floor. The supervisor publishes missing-service and helper
headroom on **port 6**; port 8 continues to carry short-lived home upgrade quotes.
Required aggressive faction sharing is protected separately. Ordinary sharing
remains disposable. Stale policy cannot lower an already observed reserve.

Grow retains the existing core-adjusted growth math, including the no-Formulas
fallback. Weaken uses `ns.weakenAnalyze(1, actualCores)`. Hack explicitly rejects
home in its allocator, XP thread scoring and final launch guard. Whole-batch
placement rolls back all reservations if remote Hack cannot fit. The tuner uses
separate remote Hack capacity and home G/W capacity, then probes the real batch
allocator. Trials, transitions and replacement lanes use that same allocator.
RAM/core changes participate in shadow tuning and invalidate stale plan inputs.

JIT, prep and XP reclaim only disposable home share PIDs when a real launch needs
space. They never evict services or unrelated scripts. Required faction share is
not killed to make opportunistic work fit. Sharing restarts only through the
normal supervisor reconciler; its reserve includes near-term queued home chunks,
so it does not immediately refill space held for the next launch.

Background prep considers home through the same capacity policy and existing
`spareRam` temporal query. It does not kill home shares while merely planning.
Its existing exact-PID cancellation remains intact. If the supervisor raises its
critical requirement, maintenance reclaims owned home XP and optional background
prep; unrelated work and committed money workers are preserved. Recovery and
money reservations retain priority over optional XP. XP Hack never gets home
capacity, while Grow/Weaken and no-Formulas fallback Weaken can borrow it.

## Evidence and economics

`capacity.homeGw` contains cores, bonus, maximum RAM, unrelated usage, protected
reserve, active G/W RAM, temporal and upcoming holds, share RAM, safe free RAM,
state/reason and utilization. Detailed dashboards display this section; compact
mode gains no extra section. Detailed supervisor next steps also show the best
home candidate, cost, estimated income gain, payback, BUY/SAVE/HOLD and reason.

A bounded 60-second ledger sample tracks home money G/W RAM-seconds, Grow and
Weaken thread-seconds, core-adjusted thread-seconds, sampled active-batch share,
remote G/W usage and next-core whole-thread savings. At least 30 measured seconds
are required. RAM/core changes clear accumulated evidence. The batch percentage
is a fraction of sampled active batches, not a count of distinct completed
batches. XP spam, university XP and share reputation are excluded from core ROI.

Performance requests require fresh scheduler/home/quote snapshots (15 seconds),
stable earning lanes, sustained home use, little remaining home slack and RAM,
G/W-capable XP_RAM, or RAM-constrained preparation pressure. Throughput limits,
recovery, dominant target-slot limits and no profitable target block purchases.
Missing evidence holds capital; it never disables safe execution.

The next core's released RAM is the smaller of the continuous marginal core
effect and measured integer-thread savings. Performance RAM is bounded by
observed home G/W demand, rather than assuming all newly doubled RAM is useful.
Both are converted to one-core-equivalent G/W capacity and capped by observed
remote G/W that could move to home. Thus a Hack-only remote pool cannot justify
more home capacity. Estimated gains use current script income, available batch
rate headroom and a 50% discount. Maximum accepted payback is 300 seconds.
These are conservative estimates, not a guarantee of added income.

Cloud and home use the same productive-RAM income denominator, including only
measured home work. Cloud reports economic metadata alongside its existing
request; among cloud options it selects the lowest justified payback. Shared
arbitration compares finite productive paybacks within infrastructure priority
**79**. The incumbent survives unless an alternative improves payback by more
than 20%. Existing priority/hysteresis rules outside that class remain intact.
Bootstrap cloud requests without ROI retain their existing priority behavior.

Critical service RAM stays at priority **90**, ordinary service expansion **75**.
Blocked service admission suppresses performance home candidates entirely.
The Red Pill, Daedalus capital and required higher-priority program goals remain
above infrastructure. Manual savings are preserved. Home performance requests
retain a 10% cash cushion. Required sharing's reputation upside is not valued.

`home-capital.js` is a short-lived Singularity actor. It quotes both RAM and
cores in one snapshot. The resident supervisor evaluates and arbitrates requests;
the daemon neither imports Singularity nor spends capital. Before a purchase,
the actor checks reset identity, live RAM/cores/cost, quote age, durable selected
savings, funding, current supervisor permission, fresh scheduler evidence and
current progression/reset policy. It rechecks cost/state/floor immediately before
the synchronous purchase and buys at most one upgrade. Every next core needs new
evidence and a new authorization. `home-upgrade.js` retains the small remote
starter/service helper, with additional live state and reset-install checks.

## Mechanics and compatibility

Verified against official **stable** source on 2026-09-29:

- [Core bonus and Weaken](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Server/ServerHelpers.ts): `1 + (cores - 1) / 16`.
- [Grow](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Server/formulas/grow.ts) uses the same bonus.
- [Singularity](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts) caps home at eight cores.
- [Core cost](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Player/PlayerObjectServerMethods.ts): `1e9 * 7.5^currentCores`.

Only the bonus and maximum are centralized in `lib/home-mechanics.js`; all
purchase costs come from live APIs. Eight cores is a cap, never a purchase goal.

The 8 GB starter still uses its remote pool and small service-RAM helper. No home
worker is required for admission. No SF4/Singularity means no automatic home
capital, but safe home G/W still works. No SF5/Formulas retains core-aware API
fallback execution. Darknet/stock opt-outs, target limits and existing reset
policies retain their original behavior. No scheduler or reservation structure
was replaced.

## Worked examples

All RAM costs and quote inputs below are illustrative. Core prices follow stable
mechanics; actual decisions use live quotes and measured evidence.

1. **Four-core home, 40 GB safe RAM.** With 1.75 GB G/W workers, a demand of
   14.25 one-core Grow units takes 12 home threads (21 GB), versus 15 one-core
   threads (26.25 GB). Removing 0.59375 security at the standard Weaken multiplier
   takes 10 home threads (17.5 GB), versus 12 one-core threads (21 GB). Together
   they fit in 38.5 GB on home and save five threads/8.75 GB. Hack stays remote;
   larger or overlapping G/W demand uses the normal remote pool as needed.

2. **Expensive next core versus cheap cloud.** Four cores, 160 GB average home
   G/W, 1,000 GB remote work, $100m/s measured income, and spare batch-rate
   headroom. A fifth core costs $3.1640625t. Assuming integer placement can save
   8 GB, that is 9.5 GB equivalent G/W and about $399,160/s discounted gain:
   roughly 7.93 million seconds payback, so HOLD. A live quote offering 64 GB
   cloud RAM for $3.52m yields about $2.689m/s and 1.31 seconds payback. Cloud wins.

3. **A heavily used home makes the next core worthwhile.** This deliberately
   large late-game example has three cores, 268 million GB average home G/W,
   20 million GB remote work (15 million G/W), $100b/s measured script income,
   little safe slack and spare rate headroom. The fourth core costs $421.875b.
   With sufficiently large chunks, it releases about 14.105 million home GB;
   its equivalent value is conservatively capped at the 15 million remote G/W
   GB available to move. Estimated gain is $2.333b/s and payback 180.84 seconds.
   If the competing live cloud quote adds 524,288 GB for $24b, its estimated
   gain is $81.54m/s and payback 294.34 seconds. Both qualify, but the core wins
   even against an incumbent cloud goal because its payback improves by more
   than 20%. A cheaper cloud quote could reverse that decision.

## Changed files and verification

- Execution and planning: `src/daemon.js`, `src/lib/home-capacity.js`,
  `src/lib/home-mechanics.js`, `src/lib/target-pipelines.js`,
  `src/lib/background-prep.js`, `src/lib/hacking-xp.js`.
- Economics and transactions: `src/home-capital.js`, `src/home-upgrade.js`,
  `src/lib/home-economics.js`, `src/lib/home-investment.js`,
  `src/lib/fleet-economics.js`, `src/fleet-manager.js`,
  `src/lib/investment-policy.js`, `src/lib/savings.js`,
  `src/lib/supervised-utilities.js`.
- Coordination/dashboard: `src/supervisor.js`, `src/lib/ports.js`,
  `src/lib/scheduler-capacity.js`, `src/lib/dashboard.js`.
- Tests: `test/home-gw.test.cjs`, `test/home-capital.test.cjs`, plus fixture updates
  in `test/jit-recovery.test.cjs`, `test/scheduler-liveness.test.cjs` and
  `test/share-workers.test.cjs`. Existing safety assertions are retained; the old
  blanket home-execution ban becomes explicit home-Hack exclusion, useful G/W,
  reserve preservation and continued generic-fleet exclusion.
- Documentation: this file, `docs/scheduler-capacity.md`, `docs/usage-reference.md`.

The repository source/API audit against `ee01676` reports **no added resident API
references** for daemon, supervisor, starter worker, fleet manager, progression
manager or progression purchaser. Singularity quote/purchase APIs reside only in
the short-lived capital actor. This static import-closure audit does not measure
the installed game's script RAM; installed-game RAM was unavailable in this
session. Existing `worker-ram-check.js` remains the in-game diagnostic.

New deterministic tests cover G/W preference and integer efficiency; explicit
Hack exclusion; whole-batch feasibility and rollback; live services/reserve and
temporal holds; safe share reclamation and reconciliation; preemptible prep/XP;
tiny home; rolling evidence; economic blockers, arbitration and hysteresis;
stale quotes/telemetry, funding, reset/install policy and each individual core.
Final `npm test`: **825 passed, 0 failed, 0 skipped** (95.94 seconds), including
61 new home execution/capital tests. The normal subprocess-isolated suite and
its module syntax checks ran successfully. `git diff --check` also passed.
