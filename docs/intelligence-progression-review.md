# Intelligence progression review

Reviewed local commit `d6a0cca` for BN1.3 -> BN5.1 -> BN4.1 -> BN4.2 -> BN4.3.
Mechanics below were checked against upstream `stable`, whose Constants.ts reports
3.0.1, on 2026-09-24. This is a code review and implementation recommendation;
the player's live save, game version, cash, augmentations, and INT were not inspected.

Subsequent supervisor cleanup removes profiles and makes installation always
automatic in the augmentation service. The implementation order below is the
original assessment; finish BN5.1 progression before dedicating time to INT.

The milestone advisor, pre-Singularity savings, Red Pill installation exception,
and bounded INT farmer are now implemented. See [current usage](bn5-bn4-progression.md).
The roadmap below remains the historical review.

## Recommended progression

Keep the planned route. Intelligence can already gain experience **inside BN5**;
owning SF5 makes that ability available afterward. The source checks either
condition and records persistent experience. Finish BN5.1 rather than delaying
Singularity for a large manual INT grind.
[Unlock and persistence implementation](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Person.ts).

Singularity is available immediately inside BN4, at base RAM costs. SF4.1 and
SF4.2 have 16x and 4x Singularity API RAM costs outside BN4; SF4.3 removes that
penalty. There is no need to finish BN4.3 before building an INT trainer.
[RAM calculation](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Netscript/RamCostGenerator.ts).

### During the current BN5.1 run

- Keep the supervisor's money engine running. Its normal `ns.hack` workers do not
  produce INT experience; successful Singularity manual hacks receive 0.005 per
  completion, not per worker thread. More JIT RAM is an income investment.
  [Hacking implementation](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Netscript/NetscriptHelpers.tsx).
- Create useful missing programs manually when that fits progression. Successful
  creation pays 0.1 INT XP per second spent working, credited on completion.
  Cancelling does not pay that completion reward. Avoid delaying an important
  port opener just to train INT; buying it may unlock much more income.
  [Program work](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Work/CreateProgramWork.ts).
- When otherwise idle, manually study Computer Science. It is free and all
  university courses have the same base INT component. Algorithms improves
  hacking training, not the base INT rate.
  [Course definitions](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Work/ClassWork.tsx).
- With no study hash upgrades, the source-derived university rates are Rothman
  0.02, Summit 0.03, and ZB Institute 0.04 INT XP/s. ZB therefore gives 144 XP/hour.
  Travel there when affordable; studying locally can start immediately. These
  are calculated rates, not a measurement of the user's save.
  [Work formulas](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Work/Formulas.ts),
  [university multipliers](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Locations/data/LocationsMetadata.ts).
- Continue faction reputation and augmentation progress when those block BN
  completion. University occupies the same player-work slot. Keep contracts
  enabled for their money/reputation; verify their in-game solver certificate
  with `run contract-selftest.js` if necessary.

### Early BN4.1: dedicated farming opportunity

A promising fast, repeatable strategy is joining a persistent faction invitation,
soft-resetting, and rejoining. A successful Singularity join grants 7.5 INT XP.
The reset itself grants no INT. Travel grants only 0.00003 XP for $200,000, so a
cash-burning travel loop is a poor first investment. Backdoor installation itself
has no INT award in the checked implementation.
[Singularity actions](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts).

The early setup is **one successful infiltration in BN4.1**, which unlocks
Shadows of Anarchy. Its invitation is retained across augmentation/soft resets.
Corporate factions also retain invitations, but require more setup. Do not assume
CyberSec, city factions, or every other invitation survives a reset. Invitations
must be reacquired after entering another BitNode.
[Faction definitions](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionInfo.tsx),
[reset preservation](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Prestige.ts).

This should be a separate farming session before building up the BN4 economy:
soft resets stop scripts and reset cash, reputation, ordinary skills, and purchased
servers. Installed augmentations, home upgrades, and INT persist under ordinary
augmentation reset rules. A farmer needs its own restart callback, a persistent
deadline/target, an escape switch, and a return to the saved supervisor profile.
It must stop if an expected invitation disappears or XP stops increasing.

For scale, **if measured throughput is one successful join per second**, one
retained faction gives 7.5 XP/s: about 188 times unboosted ZB study. From zero XP,
INT 50 takes approximately 4.3 minutes and INT 100 about 25 minutes at that
assumed rate. Reset/restart overhead determines actual throughput; these are
illustrations, not benchmarks or a claim of the globally fastest possible farm.

INT 50-100 is a reasonable initial checkpoint. The weight-1 bonus is roughly
3.8%-6.6%, while higher levels require exponentially more experience. Some actions
use other weights, so this is not a universal income multiplier.
[Skill curve](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/formulas/skill.ts),
[INT bonus](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/formulas/intelligence.ts).

## Code findings and implementation order

1. **Add INT observation first.** `src/lib/telemetry.js:19` records cash and
   service economics but no player INT. Record `skills.intelligence`,
   `exp.intelligence`, measured XP/s, next-level ETA, and training mode. Preserve
   useful totals across augmentation resets while segmenting rate samples by
   activity and reset. A read-only observer can run now without Singularity.

2. **Fix the Red Pill installation policy before relying on hands-off BN4.**
   `src/lib/augmentation-plan.js:62` correctly prioritizes The Red Pill, but
   `src/augmentation-manager.js:48` and `:70` still apply the normal minimum
   queue size. With only The Red Pill queued and a threshold of five, installation
   waits or pursues other upgrades. Add a queued-Red-Pill reset condition under
   the existing auto-install opt-in, preserving manual-work checks. Until then,
   install it manually once purchased.

3. **Coordinate training with existing activity ownership.**
   `src/augmentation-manager.js:88` and `:123` refuse to interrupt work they do
   not own. A continuously running university trainer would consequently block
   reputation work and automatic installation. `src/progression-backdoor.js`
   also waits while the player is busy. Introduce shared ownership/yield rules:
   manual activity takes priority; owned idle training yields to progression,
   reputation, and resets. Do not fix this by indiscriminately calling stopAction.
   Program creation also needs coordination with program purchases, which can
   cancel the same in-progress program.

4. **Implement the bounded reset farmer as an explicit mode.** Keep it separate
   from `bootstrap.js`, which currently restarts the full supervisor. Avoid
   rebuilding the income fleet between every farming reset. Measure the first
   few cycles and enforce the stop conditions above. Do not silently add reset
   farming to assist or hands-off profiles.

5. **Improve BN4 completion automation.** Home RAM still requires manual purchases
   (`src/supervisor.js:398`), and progression objectives cover TOR, programs, and
   four hacker backdoors (`src/progression-manager.js:177`). Add home RAM buying
   that respects savings, plus explicit Daedalus eligibility and remaining
   augmentation-count planning. The current augmentation catalog only examines
   joined factions; selecting The Red Pill cannot itself obtain a Daedalus invite.

The existing hacking scheduler, savings protocol, reset bootstrap, and capability
gating are useful foundations. No scheduler rewrite is needed for this plan.

## Validation

The six focused test files covering augmentation loops, planning, progression
actions, formulas, supervisor utilities, and module imports passed all 91 tests
using Node's `--experimental-test-isolation=none` mode. The ordinary test command
could not spawn test subprocesses in this sandbox (`EPERM`). No game actions or
runtime source changes were made as part of this review. A broader simulation
run in the same no-isolation mode was stopped after the focused checks completed;
this review does not claim a full-suite pass.
