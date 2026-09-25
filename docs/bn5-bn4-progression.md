# BN5.1 to BN4 progression

Finish BN5.1 through faction work and augmentations. The supervisor now protects
cash for TOR and missing programs even without Singularity; buy them manually.
Fleet purchases and new stock entries respect this floor. Existing stock positions
are not forcibly liquidated. Manual goals from `savings.js` take priority.

## Milestone inputs in BN5

Singularity is unavailable in BN5 without SF4, so scripts cannot read installed
augmentations or faction reputation there. Record the missing facts on home:

```text
run progression-state.js --installed-count 24
```

Replace 24 with your actual installed count, counting NeuroFlux Governor once.
The advisor reads current skills, faction membership, and cash directly. It
reserves $100b for Daedalus only after 30 installed augmentations and either
hacking 2500 or all four combat skills 1500. Before then, it recommends the
missing augmentation or skill requirement without tying up the invitation money.

After joining Daedalus, optionally enter the current values from its faction menu:

```text
run progression-state.js --daedalus-rep 1000000 --red-pill-rep 2500000 --red-pill-price 1000000000
```

These numbers are examples, not assumed BN5 prices or reputation requirements.
Update the quote after other purchases and the reputation as you work. The advisor
protects the supplied price after program purchases are complete. For another
specific augmentation, use an ordinary manual goal:

```text
run savings.js --amount 1000000000 --label "Next augmentation"
```

Clear or replace manual goals when done. To record The Red Pill purchase:

```text
run progression-state.js --red-pill queued
```

Install manually in BN5. All observations expire on augmentation or BitNode reset.
After installation, record `--red-pill installed` if the network has not yet
discovered the final server. The dashboard gives its live hacking requirement,
root status, and route once discovered. In BN5 without SF4, finishing the node and selecting BN4 remain manual actions.

## Automatic behavior in BN4

After manually finishing BN5.1 and entering BN4.1, run `supervisor.js` with no
arguments. The BN4 route controller is enabled by default through the augmentation
manager when progression actions are enabled. It is scoped to BN4.1, BN4.2 and
BN4.3; it is not a strategy for every BitNode or every optional subsystem.

- The starter pool earns money while a small helper upgrades home RAM until the
  controller, hacking stack and required helpers fit. The helper runs on free
  rooted remote RAM and only reclaims workers owned by the starter pool. Manual
  savings goals remain protected. Your SF1 normally gives 32 GB on a new node;
  the bootstrap also supports the 8 GB fallback.
- The controller yields its faction/class work when hacker-faction backdoors
  are ready. The existing progression actors install those backdoors.
- It pursues Tian Di Hui and compatible city factions when they offer unowned
  augmentations. By default it uses Sector-12 and Aevum; existing eastern or
  Volhaven memberships are respected. An explicit city preference is retained.
- The BN4 plan prioritizes reputation support, Neuroreceptor Management Implant
  and hacking benefits. Before 30 distinct augmentations, it also buys other
  reachable augmentations to meet Daedalus's count. Low-priority count fillers
  favor lower reputation requirements and prices. Unavailable prerequisites do
  not prevent buying other reachable items.
- It earns faction reputation, donates when the existing affordability/formula
  checks permit, and purchases automatically. Ordinary batches install at five,
  or sooner when the reachable batch is exhausted or installation reaches 30
  distinct augmentations. A nonempty batch also installs after at least 30
  minutes since the last reset if its next item is still reputation/cash blocked.
  This is a bounded waiting policy, not a globally optimal reset calculation.
- When faction reputation is not the immediate task, free Computer Science adds
  hacking experience while income workers continue. The controller tracks that
  work and releases it for faction work, backdoors, installations and completion.
  It does not take over unrelated manual player activity.
- It protects faction invitation cash, joins Daedalus, earns Red Pill reputation,
  buys and immediately installs it, then trains toward the final server's live
  hacking requirement. The fleet roots the final server.

The augmentation planner publishes installed counts, ownership and Daedalus
quotes automatically; no `progression-state.js` inputs are needed in BN4. Fresh
controller goals and quotes feed the shared savings policy. Program purchases
retain priority, and manual goals are never silently replaced.

The node transition helper checks ownership, the current reset, installed Red
Pill, root access, hacking, player activity and restart files immediately before
calling Singularity. **Its only allowed destination is BN4:** completing BN4.1
enters BN4.2; completing BN4.2 enters BN4.3. At the BN4.3 exit requirements it stops
with `ROUTE_END`. You must choose the subsequent node yourself; the game cannot
award the completion and enter an unspecified next node. Nothing is random.

The callback releases its RAM before starting the supervisor, and the starter
pool rebuilds the new node. Optional services yield RAM while the INT or node
transition helper needs it. Failed node transitions retry after 30 seconds.

`--augmentation-actions false` disables this controller's supervision;
`--progression-actions false` disables the route behavior. Already-running
processes must be restarted to load different arguments. The standalone
augmentation manager's `--route false` keeps its generic augmentation loop.

## Bounded Intelligence session

The controller automatically hands off to one early INT session when SF5 is
owned, INT is below 50, no augmentations are installed/queued, and Shadows of
Anarchy membership or its invitation exists. It stops at INT 50 or ten minutes,
then restores supervision. A session already attempted manually or automatically
in this node is not silently renewed.

**Complete one infiltration manually to obtain that invitation.** Singularity
cannot play the infiltration minigame. Without the invitation, ordinary node
progression continues instead of waiting. Do the infiltration early if you want
the automatic handoff before the first augmentation batch. Existing membership
also works: the first reset restores the invitation.

For a separate manually requested session, the following command remains available:

Start the supervisor once to save valid restart settings. Stop `supervisor.js`
and `augmentation-manager.js` before farming, let progression helpers finish,
and stop any player work. The farmer prints a blocker if any prerequisite is
missing. It does not take over those activities.

```text
run intelligence-farm.js --start --minutes 10 --target 50
```

The session joins Shadows of Anarchy and soft-resets using itself as the callback.
**Each reset loses current cash, normal skills, faction reputation, purchased
servers, and running scripts.** INT, installed augmentations, and home upgrades
persist. Queued augmentations must be installed first. Do this before rebuilding
the economy; the farmer refuses to run with The Red Pill installed.

The first reached limit ends farming: the target INT level or the absolute wall
clock deadline. `--minutes` must be greater than zero and at most 60. No argument
invocation shows the last result/setup guidance, or resumes an active reset
callback. Active sessions cannot silently renew their budget. Gains are measured
from player XP and stored with reset count and XP/hour in
`data/intelligence-session.json`; no assumed rate is used.

On normal completion the farmer releases its RAM and launches `bootstrap.js`,
which restores the supervisor settings. A blocked/failed session stops with a
reason. To cancel and resume normal play manually:

```text
run intelligence-farm.js --stop
run bootstrap.js
```

The supervisor refuses to start during an active farming session. Automatic
handoff validates prerequisites before stopping its owning supervisor and
augmentation manager. Sessions are
bound to their BitNode reset and cannot carry into the next node. Killing the
farmer alone does not clear its saved session; use `--stop`. This is a tested
callback workflow in mocks, not a live-game throughput benchmark.

## Updating an existing run

Sync all `src` files, including `lib`. Restart the supervisor, progression manager,
and augmentation manager so they load the changes. Let active backdoor helpers
finish first. The short-lived augmentation planner loads new code on its next run.

## Mechanics references

The implementation follows upstream stable sources checked on 2026-09-24:

- [Faction eligibility and persistent invitations](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionInfo.tsx).
- [Installed augmentation counting](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionJoinCondition.ts).
- [Join XP, soft reset, and reset callback launch](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts).
- [Invitation preservation across augmentation resets](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Prestige.ts).
