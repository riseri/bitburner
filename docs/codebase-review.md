# Codebase review: fresh players through BN5, BN4, BN10 and BN2

Original assessment of commit `5eec74c` on 2026-09-24. Findings below describe that
baseline; the follow-up implementation addresses them as summarized here.

## Implementation status

The six findings below have been addressed: reset thresholds, augmentation
selection, work/favor formulas, program savings and feature filtering, reserved
ports, and capability-aware RAM diagnostics. Confirmed unused helpers and the
duplicate Darknet formula implementation have been removed. Program definitions
and service metadata now have shared catalogs. The test loader resolves actual
named imports, with a check covering every source module.

The 8 GB starter, no-Formulas fallback, worker ownership, scheduler recovery and
active log compatibility remain in place. Remote starter expansion, home-RAM
purchasing, a larger scheduler/display split, and new sleeve/gang services remain
future feature work; they are not required to correct the findings in this pass.

The hacking foundation is worth keeping. It already supports operation without Formulas, live adoption of Formulas, limited RAM, shared scheduling, recovery, and augmentation resets. The highest-value work is correcting progression policy and reducing duplicated orchestration. A scheduler rewrite would introduce more risk than the identified cleanup requires.

## Findings to fix first

### 1. Automatic installation can wait indefinitely behind another augmentation

**Priority: high for BN4 hands-off use.** `src/augmentation-manager.js:58` returns to purchase/reputation handling whenever `plan.next` exists. Installation and `min-install` are only evaluated after the entire available plan is exhausted.

Reproduction: with five augmentations queued, `minInstall = 5`, automatic installation enabled, and one remaining expensive augmentation needing reputation, the loop returns `REPUTATION` and never evaluates installation. A joined faction with a distant upgrade can therefore postpone the advertised threshold for a long time. Conversely, an exhausted early catalog containing fewer than five upgrades leaves the loop waiting for more factions indefinitely.

Extract an explicit reset decision that runs independently of catalog exhaustion. Keep the existing manual-action ownership checks. Specify whether to buy immediately affordable upgrades before resetting, and support an optional stalled-progress/time policy for small early catalogs. Add behavioral coverage for a nonempty remaining plan; the current installation test empties the catalog first.

### 2. The hacking-only plan excludes important progression and reputation upgrades

**Priority: high before relying on BN4 automation.** `src/lib/augmentation-plan.js:55` selects only multipliers whose names begin with `hacking`, unless a target or `all` is selected. This excludes The Red Pill and reputation-only upgrades. The Red Pill has no stat multiplier in the [official augmentation catalog](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Augmentation/Augmentations.ts).


Use an explicit progression priority alongside the chosen stat focus: progression unlocks, useful reputation upgrades, and then ordinary hacking upgrades. Preserve prerequisites and faction availability. Keep explicit targeting as an override. This is a policy improvement, not a reason to select every augmentation by default. The current manager also only plans from joined factions; acquiring invitations and meeting faction requirements remain separate gaps in full automation.

### 3. Work estimates double-count sharing; projected favor is also incorrect

**Priority: medium; affects Formulas-backed faction automation.** `src/lib/formulas.js:80` multiplies hacking reputation by share power after calling `factionGains`. The upstream calculation already includes sharing. A returned rate of 3 reputation/cycle with share power 2 becomes 30/s locally instead of 15/s. This can choose the wrong work type and understate ETA. The test currently expects the doubled value.

Convert the returned cycle rate to seconds once and account for the actual work focus when presenting an ETA. See the [official work calculations](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Work/Formulas.ts) and [reputation calculations](https://github.com/bitburner-official/bitburner-src/blob/dev/src/PersonObjects/formulas/reputation.ts).

`src/lib/formulas.js:106` adds `repToFavor(currentRep)` to existing favor. Favor conversion is nonlinear: convert existing favor to reputation, add earned reputation, then convert the total back. With favor 100 and reputation 400, the current code predicts about 100.802 rather than 100.111 before display rounding. See the [official favor conversion](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Faction/formulas/favor.ts).

### 4. Darknet purchases and savings use inconsistent program definitions

**Priority: medium.** `src/lib/progression-protocol.js:4` includes `DarkscapeNavigator.exe`, but `src/lib/savings.js:19` recognizes only the five port-opening programs. Its matching purchase cannot release its own savings floor.

At the configured $50m estimate and 10% reserve, automatic savings requests about $55.56m. The purchase actually requires about $105.56m because it preserves the same goal in addition to paying the price. Manual purchase also fails to mark that goal inactive immediately through the program-ownership check.

Use one program catalog for planning, purchase authorization, savings completion, and feature eligibility. Also filter optional programs by enabled features: `updateSupervisorSavings` selects the navigator even with Darknet disabled, and progression planning has no Darknet-enable input. Disabling that service should be able to skip its program and advance to augmentation savings.

### 5. Port validation is already drifting between services

**Priority: medium for custom configurations.** `src/daemon.js:292` omits augmentation status and both Darknet channels from its reserved-port checks. Direct validation accepts worker-event ports 9, 10 and 11, even though those belong to other services. This can mix events or erase status when configured directly.

Derive reservations from `PORTS` and declare each service's permitted input/output channels. Keep defaults unchanged. Tests should enumerate every reserved channel instead of checking a partial hardcoded list.

### 6. Diagnostics overstate RAM requirements for fresh players

**Priority: medium for onboarding.** `src/doctor.js:36` totals stopped controllers and always adds the largest progression actor, regardless of feature availability or the selected profile. An observe-mode player without Singularity can receive a RAM warning for an actor they cannot use.

Report core requirements, enabled/unlocked services, and optional features separately. Reuse the supervisor's capability and service definitions so diagnostics describe the configuration actually running.

## What can be removed

Repository-wide source-reference checks found these functions have no production callers:

| Location | Removal candidates |
| --- | --- |
| `src/daemon.js` | `abortWorkers`, `chooseSafePeriod` (the synchronous wrapper), `clearRunning`, `hasHarmfulRunning`, `formatTime`, `bar` |
| `src/supervisor.js` | `humanSteal`, `humanBatchRate`, `humanBatches`, `humanAllocator`, `humanTiming`, `humanLoopLag`, `humanRecovery`, `humanPhaseCounters`, `hasNonZeroCounters` |
| `src/lib/formulas.js` | `formulasAvailable`; duplicate `darknetFormulaMetrics` |

Keep `chooseSafePeriodSteps`, which is active. The Darknet agent imports the separate `lib/darknet-formulas.js` implementation; move its formula test to that module before removing the duplicate. `hasNonZeroCounters` has a test-only reference; remove that obsolete test with the helper. These are small internal removals, not justification to remove entire services.

Other compatibility cleanup needs a declared minimum game/repository version. Examples are the ancient `jit.js` process cleanup, old dashboard text syntax, the donation API fallback to `formulas.work`, and the savings fallback for test doubles without `ns.read`. Prefer complete mocks over production branches added just for tests. Preserve persisted quarantine migration unless its replacement carries existing quarantine decisions forward.

**Do not delete the entire daemon log parser yet.** The current supervisor only consumes structured JIT status when its mode is `multi`; a single healthy pipeline still falls back to parsing logs. Initial preparation also produces text without the regular scheduler snapshot. Publish one structured status schema for preparation, single-target and multi-target operation, migrate consumers, then remove parsing and redundant rendering paths.

## Refactoring order

1. Fix the progression, formula, savings and port findings with focused behavioral tests.
2. Remove the unused functions and duplicate formula implementation in a separate, small change.
3. Define a shared service catalog: script, capability requirement, default arguments, status channel, priority and dependencies. Use it in supervisor setup and diagnostics. Share pure capability checks based on reset metadata, without importing expensive APIs into the supervisor.
4. Unify structured status publication before moving the supervisor dashboard into its own module. Keep display formatting out of runtime state transitions.
5. Split `daemon.js` by responsibility: network discovery/deployment, target modeling/tuning, reservations/placement, worker lifecycle/recovery, and status rendering. Preserve one reservation ledger and event owner. Moving code is for maintainability; it does not itself prove lower in-game RAM cost.
6. Replace the test loader's growing file-specific import injection with a loader that resolves the actual module graph, or add import/export integration checks alongside it. Keep the deterministic scheduler simulations.

The project contains 60 source JavaScript files and approximately 13.3k lines. `daemon.js` has about 5,044 lines, `supervisor.js` 1,481, and `lib/target-pipelines.js` 1,103. The daemon's unusually expanded formatting contributes to its size; normalize formatting separately from scheduler changes to keep diffs reviewable.

## Fresh-player improvements to preserve and add

- Keep the 8 GB starter, no-Formulas model, capability gating, manual controls, separate small workers, and one-shot Singularity actors. They remain necessary even after your own unlocks improve.
- Add a middle startup tier that can use zero-port remote hosts before the full resident stack fits on home. Currently `runStarterMode` waits for supervisor + daemon + fleet RAM and runs only a home n00dles worker in the meantime. Gate each tier by measured script RAM and available capacity.
- Add actionable manual program/home-RAM advice before SF4. Automatic program saving currently deliberately waits for Singularity actions; a fresh player should still have an easy way to protect cash for a manual unlock. Keep that opt-in or explicitly visible, since it competes with fleet growth.
- Once Singularity is available, consider a small home-RAM purchase actor with a budget and a concrete objective: fit the next useful service. There is currently no home-RAM upgrade automation. Avoid buying home cores solely for hacking while the scheduler excludes home workers.
- Keep observe as the default and clearly explain that fleet/stock services may spend. Optional features should neither become required dependencies of a minimal install nor consume unlock savings when disabled.
- Verify actual game RAM at 8/16/32/64 GB, without SF4/SF5 and with Formulas present. The starter test currently supplies fixed costs rather than measuring Netscript's analyzer.

## Applying this to your progression

| Stage | Codebase priority |
| --- | --- |
| Fresh player / BN1 | Starter throughput, clear manual next steps, accurate diagnostics, no-Formulas support |
| BN5.1–BN5.3 | Preserve automatic adoption of exact hacking formulas; fix formula semantics and add realistic integration fixtures |
| BN4.1–BN4.3 | Reset policy, useful augmentation selection, faction requirements, home RAM, and savings coordination |
| BN10 | Add a separate sleeve service with capability gating, shock/synchronization handling, task assignment and a purchase budget |
| BN2 | Add a separate gang service for recruitment, training, wanted management, ascension and spending; add entry/prerequisite advice |

There are currently no sleeve or gang API calls in `src`, so BN10/BN2 automation would be new functionality, not something a refactor can unlock.

SF4.1 already grants Singularity access outside BN4. Levels 2 and 3 reduce its RAM multiplier from 16x to 4x to 1x; inside BN4 the APIs use normal cost. SF5's hacking bonuses are 8%, 12% and 14%, with Intelligence and permanent Formulas access coming with the source file. Thus your route is supported, but you can use the assist profile during your first BN4 run; SF4.3 is not an API-feature prerequisite. See the [official BitNode and Source-File definitions](https://github.com/bitburner-official/bitburner-src/blob/dev/src/BitNode/BitNode.tsx).

## Validation and limits

- Follow-up implementation: `npm test` passed all 469 tests, including syntax/import checks and deterministic scheduler simulations. The Node test runner required subprocess access outside the sandbox.
- Regression coverage includes installation with an unfinished plan, manual-action protection, queued NeuroFlux levels, progression/support augmentation selection, navigator savings, disabled features, sharing/favor/focus calculations, reserved ports, and fresh-player diagnostics.
- The stock runtime tests now use the shared import-aware loader, replacing a second hardcoded dependency list.
- Baseline assessment: all 457 existing tests passed across two runs; temporary reproductions exposed the policy and formula gaps that those tests did not cover.
- No live game execution or Netscript RAM measurement was performed. Mechanical comparisons use official upstream `dev` source; deployment should check the installed game's version and actual script RAM.
