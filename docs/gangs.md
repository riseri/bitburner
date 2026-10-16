# Gang automation and BN2

`run supervisor.js` enables gang management by default in BN2 or with SF2. The
gang manager stays on home and waits for enough RAM like other optional services.
It reports prerequisites and progress on reserved port 3 and the supervisor
dashboard. Port 7 remains available for custom fleet status.

## Getting established

The default `--gang-faction auto` creates a hacking gang from joined NiteSec,
then The Black Hand. The ordinary hacking/backdoor progression route and automatic
faction joining can supply that membership. In BN2 those player actions require
SF4 level 1+ and enabled progression/augmentation actions. The gang manager itself
uses no Singularity player-work APIs, so it can manage an existing gang without
SF4. Fully unattended augmentation purchases, installations and BitNode
transitions still require SF4 in BN2.

When the augmentation manager cannot fit on home, the progression dispatcher
uses the small `progression-join.js` actor to accept available invitations from
the four hacking-backdoor factions. This lets the NiteSec/Black Hand gang start
before a home RAM upgrade. The actor spends nothing, leaves player work alone,
and respects disabled progression actions or automatic faction joining.

To create a gang with a specific eligible faction, choose it explicitly:

```text
run supervisor.js --gang-faction "Slum Snakes" --gang-budget 0.05
```

This is an alternative supervisor startup command; run only one supervisor.
You must already belong to the chosen faction. The manager always retains an
existing gang, including a combat gang, regardless of the creation preference.
Outside BN2, creation also requires karma at or below -54,000. The gang manager
waits for that prerequisite; the augmentation manager and available sleeves
build karma in parallel with progression. Player crime receives a bounded minute
in five plus funding waits, preserving faction work, purchases and installs.
Use `--gang-karma false` to disable that policy. See [BN10 automation](bn10.md).

## Member and spending policy

Each management pass, normally every two seconds, checks recruitment and live
member information. Members train the gang's main skills and charisma before
productive tasks. After basic training, up to one third of members rotate through
main-skill training until their next useful ascension is ready. Novice training
uses these slots first, and optional growth keeps at least two members outside
the rotation. This prevents equipment-boosted skill levels from stranding members
on low-XP jobs before they have enough experience to ascend. Productive tasks
already providing at least half the main-skill training XP rate need no optional
training rotation. Wanted recovery,
installation, and a measured reputation goal within two minutes pause optional
growth. Task selection emphasizes respect while recruiting and when
gang reputation is needed, then allows income work. Wanted suppression retains a
productive member where possible; a new gang's minimum wanted level of 1 does not
trap every member in permanent suppression. The wanted budget considers lower-risk
productive tasks as well as suppression instead of only replacing producers with
Ethical Hacking or Vigilante Justice.

Ascension is limited to one member per minute and requires enough trained members
to keep producing, a useful main-skill multiplier increase, and a bounded respect
loss. The required gain declines from 1.5x for new members toward 1.1x for mature
members. Respect loss is capped at 25% while recruiting and 15% at twelve members;
enough respect must remain to retain at least 95% production. The manager disables territory warfare and removes existing warfare task
assignments. This matters because the game's clash chance declines gradually
after warfare is turned off.

`--gang-budget 0.05` adds 5% of cash above the shared savings floor to the equipment
allowance per management interval. Unused allowance accumulates, capped at current
surplus, so an item need not fit inside a single interval's allowance. At most
twelve purchases occur per pass. Live cash and savings are checked again before
each purchase; accumulated allowance cannot release protected savings. Allowance
resets when the manager restarts or the reset epoch changes. `--gang-budget 0` disables
equipment purchases. Invalid savings records prevent spending. A fresh approved
augmentation-reset status defers equipment and ascension until restart.

The standalone equivalent, when the supervisor is not managing this service, is:

```text
run gang-manager.js --faction auto --budget 0.05 --interval 2000 --port 3
```

The manager also accepts `--ticks N` for a bounded number of passes; 0 runs
continuously. Do not run a second gang manager alongside the supervised instance.

## Red Pill and resets

When a joined gang offers The Red Pill, progression can use that seller without
first meeting Daedalus's augmentation count or saving its $100b invitation fund.
Low gang reputation does not force the automatic plan to skip useful upgrades.
The Red Pill takes priority once its reputation requirement is met; explicit
augmentation targets remain binding. Gang reputation is earned through member
tasks, so the augmentation manager waits for that progress instead of requesting
ordinary faction work or donations from the gang faction.

A zero-cost Red Pill purchase can proceed through an unfunded automatic savings
goal. Manual savings restrictions and invalid savings records still block it;
paid upgrades continue to respect the shared reserve.

The existing installation and final-server checks remain in effect. A gang
survives augmentation installation, including its members and equipment, and the
restarted manager reads its live state. BitNode completion clears it; the next
run creates a new gang after faction access is restored.

The detailed dashboard shows task counts, respect rate, main-skill ascension range,
growth trainees, and accumulated equipment allowance. Passive faction reputation
rates retain fractional precision; their conservative ETA assumes today's rate
and does not predict future growth. Daedalus Go bonuses are modeled for passive
gang reputation as well as ordinary faction work.

After syncing changes, `run supervisor-restart.js` reloads the supervisor,
gang manager, augmentation manager, and Go bot while preserving their current settings. To change gang settings,
stop the supervisor first, then the gang manager, and start the supervisor with
the desired flags. `--gangs false` disables supervision; it does not stop a
manager that you left running manually.

These policies are bounded heuristics, not an income or completion-time promise.
Repository tests use simulated APIs; actual script RAM and live reset recovery
still depend on the installed game version and save.

Mechanics references: [gang API](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Gang.ts),
[gang gains and warfare](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Gang/Gang.ts),
[augmentation and BitNode reset lifecycle](https://github.com/bitburner-official/bitburner-src/blob/stable/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts).
