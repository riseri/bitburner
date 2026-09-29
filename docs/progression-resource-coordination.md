# Progression resource coordination (PR1)

Navigator is useful whenever Darknet is enabled. Activation is a separate decision:
one manager, one crawler thread, and at least 8 GB of reserve (the supervisor uses
its larger helper reserve when needed). Existing home sharing is reclaimable.
Missing scripts produce a diagnostic rather than an infinite RAM savings goal.
The crawler's configured thread count remains a ceiling, not a prerequisite.

The program catalog assigns Navigator priority 84. This clears ordinary cloud's
79 even with the arbiter's three-point hysteresis. Critical home RAM (90),
Daedalus (95), and Red Pill (100) still win. Prospective Darknet RAM is included
in home planning before ownership; ordinary home expansion (75) follows the
unlock. Purchase actors defer to imminent installation and reclaim only share
workers when they need RAM. No new unilateral spending path is introduced.

The augmentation producer publishes `sharingDemand`. Both consumers use the
same authenticated, reset-scoped, expiring reader. OFF is the default, including
missing Singularity or producer status. SPARE_ONLY requires a reputation gap and
active faction work for the selected seller. AGGRESSIVE additionally requires
the Red Pill reputation gate. Both modes currently fill only disposable spare
RAM; neither may evict committed work or services. The distinction records value
without promising an unmeasured benefit from displacing money production.

## Verification and compatibility

Baseline: 661 tests passed, zero failed. Added seven resource-coordination tests
and updated two assertions that explicitly encoded the replaced policies.
Focused resource/planning/sharing run: 36 passed. Action/resource run: 55 passed.
Full-suite result is recorded in the PR description. All scheduler simulations
are included in `npm test`; PR1 leaves the JIT algorithm unchanged.

Implementation files: `lib/programs.js`, `lib/service-catalog.js`,
`lib/progression-objective.js`, `lib/augmentation-context.js`,
`lib/progression-dispatch.js`, `progression-manager.js`,
`progression-purchase.js`, `supervisor.js`, and `daemon.js`.
Tests: `resource-coordination.test.cjs`, `progression-planning.test.cjs`,
and `share-workers.test.cjs`.

| Supported state | Result |
| --- | --- |
| 8 GB / starter path | PASS |
| Small home RAM | PASS |
| No SF4 | PASS |
| No Singularity | PASS |
| No SF5 | UNCHANGED |
| No Formulas | PASS |
| No DarkscapeNavigator | PASS |
| Darknet disabled | PASS |
| No stock access | PASS |
| max-targets=1 | PASS |
| max-targets=2 | PASS |
| Manual progression fallback | PASS |

Source API/import comparison against b174418 finds no additional Netscript APIs
in supervisor, daemon, starter worker, fleet manager, or purchase actor. The
progression manager now imports service-catalog lifecycle code; the conservative
whole-module inventory adds run/kill/isRunning, although activation never calls
them. No expensive API is added to a resident controller. Exact game RAM is not
measured by the Node harness; verify installed-game costs with the existing
doctor/worker RAM diagnostics. Starter tests retain the supported 8 GB fixture.

The detailed Darknet dashboard shows unlock state, activation, minimum and
reclaimable available RAM, crawler threads, and existing agent/work statistics.
Automatic home purchasing retains its existing route/capability gate; other
players receive the RAM requirement and continue manual progression. Missing
capabilities do not make core services depend on Darknet or faction work.

No new scheduling algorithm, stock access policy, or advanced API dependency is
introduced. Aggressive sharing does not yet trade earning capacity for faction
work because that would require measured marginal reputation value.
