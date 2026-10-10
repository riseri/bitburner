# BN5 and BN4 progression

Repeat BN5 through BN5.3 using faction work and augmentations. The supervisor protects
cash for TOR and missing programs even without Singularity; buy them manually.
Fleet purchases and new stock entries respect this floor. Existing stock positions
are liquidated only for an authenticated, urgent cash-only milestone when net
portfolio value can cover it; ordinary program savings do not force sales. Manual goals from `savings.js` take priority.

With SF4, the supervisor can manage augmentation progression in BN5 as well:
compatible faction unlocks, reputation and purchases, completed short batches,
Daedalus count crossings, and bounded reset waits all run automatically. A queue
of four with no remaining reachable basket installs instead of waiting forever
for a fifth. Augmentation resets use the saved bootstrap settings. With Singularity,
the first two completions re-enter the current BitNode automatically:
BNx.1 -> BNx.2 -> BNx.3 for every BitNode x, including BN5. The third run waits
at its exit requirements for your next BitNode choice.

## Milestone inputs in BN5 without SF4

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
compares the supplied milestone price against other investments; urgent Red Pill
and Daedalus requirements take priority over ordinary programs. For another
specific augmentation, use an ordinary manual goal:

```text
run savings.js --amount 1000000000 --label "Next augmentation"
```

Clear or replace manual goals when done. To record The Red Pill purchase:

```text
run progression-state.js --red-pill queued
```

Install manually in BN5 without SF4. All observations expire on augmentation or BitNode reset.
After installation, record `--red-pill installed` if the network has not yet
discovered the final server. The dashboard gives its live hacking requirement,
root status, and route once discovered. In BN5 without SF4, finishing the node and re-entering BN5 remain manual actions.

## Automatic augmentation progression with Singularity

After entering BN4.1, run `supervisor.js` with no
arguments. The augmentation controller is enabled by default when progression
actions are enabled. Its faction and reset policy also runs in other nodes with
SF4. INT farming follows Singularity and INT access across nodes. Automatic
BitNode transitions follow BNx.1 -> BNx.2 -> BNx.3 for every BitNode x;
optional subsystems retain their separate policies.

- The starter pool earns while isolated helpers plan cloud service placement
  and, when needed, home RAM upgrades. Cloud hosting is enabled by default:
  daemon, fleet and enabled progression can use purchased servers instead of
  waiting for a higher home tier. The planner reuses purchased capacity and quotes
  the smallest purchase that makes the core set fit. `--cloud-services false`
  retains home placement for new services. Target checks explain keeping or
  leaving n00dles, and the dashboard shows the cloud quote and assigned hosts.
  An early augmentation manager yields RAM to this core set instead of forcing
  another home upgrade before hacking can start. Augmentation management and
  home-specific actors stay on home; further home upgrades fund their RAM.
  Quotes are cached so
  unaffordable upgrades do not repeatedly interrupt starter workers. The helper runs on free
  rooted remote RAM and only reclaims workers owned by the starter pool. Manual
  savings goals remain protected. Your SF1 normally gives 32 GB on a new node;
  the bootstrap also supports the 8 GB fallback.
- The progression actors install faction backdoors alongside classes, faction
  work, crimes and program creation. They preserve the player's work and respect
  manual connection changes. Infiltration/BitVerse activity still blocks admission.
  Once The Red Pill is installed, obsolete faction backdoors leave the action plan.
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
  minutes of no measurable progress toward the selected objective, with a
  60-minute wait cap even when progress is slow. A valuable purchase with a known
  ETA under two minutes can briefly defer the threshold.
  This is a bounded waiting policy, not a globally optimal reset calculation.
- When faction reputation is not the immediate task, free Computer Science adds
  hacking experience while income workers continue. The controller tracks that
  work and releases it for faction work, installations and completion.
  It does not take over unrelated manual player activity.
- It protects faction invitation cash, joins Daedalus, earns Red Pill reputation,
  buys and immediately installs it, then trains toward the final server's live
  hacking requirement. The fleet roots the final server. Training also evaluates
  another useful hacking/XP augmentation package, including repeated NeuroFlux
  Governor levels, acquiring reputation by donation or owned faction work when
  the package projects a faster finish. See [endgame upgrades](endgame-upgrades.md).

The augmentation manager publishes one versioned progression snapshot containing
installed/queued ownership, live requirements, its selected basket, capabilities,
and savings request. Consumers reject stale, wrong-producer and wrong-reset data.
The standalone planner is an inspection/fallback tool. Capital priorities follow
the milestone, and manual goals are never silently replaced.
See [dynamic planning details](progression-planning.md).

The node transition helper checks ownership, the current reset, installed Red
Pill, root access, hacking, player activity and restart files immediately before
calling Singularity. It re-enters the current node for its first two completions:
BNx.1 -> BNx.2 -> BNx.3 for every BitNode x. Source-File levels record completed
runs, so a BN5 run with SF5.1 completes into BN5.3. The actor rejects a request
for a different node or a repeat beyond the third run. At the third-run exit it
stops with `ROUTE_END` and waits for your next destination. Completing the third
run requires selecting that destination; it never selects a fourth run or the
next numbered BitNode for you.

The callback releases its RAM before starting the supervisor, and the starter
pool rebuilds the new node using the saved supervisor settings. The restart RAM
check includes the Source-File awarded by the completion. Optional services yield RAM while the INT or node
transition helper needs it. Failed node transitions retry after 30 seconds.

`--augmentation-actions false` disables this controller's supervision;
`--progression-actions false` disables the route behavior. Already-running
processes must be restarted to load different arguments. The standalone
augmentation manager's `--route false` keeps its generic augmentation loop.

## Bounded Intelligence session

INT farming works in any BitNode with Singularity access (BN4 or SF4) and
Intelligence unlocked (BN5 or SF5). This includes BN5 with SF4.3/SF5.1 and later
BitNodes with those Source-Files; it does not require a particular node number.
Without either capability, it prints the missing prerequisite before touching
Singularity APIs.

The supervisor enables automatic INT farming by default. Once per BitNode, an
eligible augmentation installation uses `intelligence-handoff.js` as its reset
callback. The newly installed augmentations remain installed while the farmer
runs; normal supervision and economy rebuilding start afterward. The old
BN4-only, below-50 startup handoff has been replaced by this reset-boundary policy.

The default is ten minutes with no INT level cap, including when INT is already
109 or higher. Supervisor flags `--intelligence-minutes N` (greater than zero, at
most 60), `--intelligence-target N` (0 means no level limit), and
`--intelligence false` configure or disable it. Settings survive resets. Both
augmentation and progression actions, including faction joining, must be enabled.
Saved supervisor settings remain authoritative when services are adopted.

Missing persistent factions, missing callback files, insufficient home RAM and
an already-reached target skip farming while the approved installation proceeds.
Red Pill installations always skip it. The callback rechecks its fresh,
node-bound request, installed augmentation package, settings, player work,
conflicting processes, and RAM before starting. It never stops a live economy or
another player's activity to make room. Automatic sessions return to supervision
on completion, cancellation or failure. A manual or automatic budget already
attempted in this node is not silently renewed, including after `--stop`.

**Complete one infiltration manually to obtain that invitation.** Singularity
cannot play the infiltration minigame. A persistent corporate faction also
qualifies. Without either, ordinary progression continues; the next eligible
installation can use a faction unlocked later. Existing membership works because
the augmentation installation restores its invitation.

For a separate manually requested session in any supported node:

Start the supervisor once to save valid restart settings. Stop `supervisor.js`
and `augmentation-manager.js` before farming, let progression helpers finish,
and stop any player work. The farmer prints a blocker if any prerequisite is
missing. It does not take over those activities.

```text
run intelligence-farm.js --start --minutes 10
```

The default manual session runs for ten minutes with no INT level cap, so it
continues to be useful above INT 50 or 109. Add `--target 150`, for example, to
stop when INT reaches 150 or the time budget expires. `--target 0` explicitly
selects time-only farming.

The session joins every available persistent faction and soft-resets using
itself as the callback. Eligible factions are Shadows of Anarchy, ECorp,
MegaCorp, Bachman & Associates, Blade Industries, NWO, Clarke Incorporated,
OmniTek Incorporated, Four Sigma, KuaiGong International, and Fulcrum Secret
Technologies. Already-joined factions work too: one initial reset restores their
invitations. A corporate invitation or membership is sufficient without Shadows
of Anarchy or an infiltration. Ordinary hacker/city factions are excluded because
their invitations do not persist. Church of the Machine God rejoins automatically
and cannot supply join XP. Each join must measurably increase INT XP; no remaining
persistent factions, failed joins and unproductive callbacks stop the session.

**Each reset loses current cash, normal skills, faction reputation, purchased
servers, and running scripts.** INT, installed augmentations, and home upgrades
persist. Queued augmentations must be installed first. Do this before rebuilding
the economy; the farmer refuses to run with The Red Pill installed.

The first reached limit ends farming: an optional target INT level or the absolute
wall clock deadline. Limits are checked between faction joins and before resetting.
`--minutes` must be greater than zero and at most 60. No argument
invocation shows the last result/setup guidance, or resumes an active reset
callback. Active sessions cannot silently renew their budget. Gains are measured
from player XP and stored with reset count, successful joins, participating
factions and XP/hour in `data/intelligence-session.json`; no assumed rate is used.
Existing level-50 sessions keep their saved target and deadline after an update.

On normal completion the farmer releases its RAM and launches `bootstrap.js`,
which restores the supervisor settings. Automatic sessions also return after a
failure or manual cancellation. Stop an automatic session with:

```text
run intelligence-farm.js --stop
```

A blocked/failed manual session stops with a reason. To cancel and resume a manual
session:

```text
run intelligence-farm.js --stop
run bootstrap.js
```

The supervisor refuses to start during an active farming session. The automatic
handoff runs after installation has already stopped the old scripts. Sessions are
bound to their BitNode reset and cannot carry into the next node. Killing the
farmer alone does not clear its saved session; use `--stop`. This is a tested
callback workflow in mocks, not a live-game throughput benchmark.

## Updating an existing run

Sync all `src` files, including `lib`, then run `supervisor-restart.js` to reload
the supervisor and augmentation/progression managers with saved arguments. Let
active backdoor helpers finish first. Automatic farming starts at the next
eligible augmentation installation; it does not reset the current economy just
because the code was updated. The short-lived augmentation planner loads new
code on its next run.

## Mechanics references

The implementation follows upstream stable sources checked on 2026-09-24:

- [Faction eligibility and persistent invitations](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionInfo.tsx).
- [Installed augmentation counting](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Faction/FactionJoinCondition.ts).
- [Join XP, soft reset, and reset callback launch](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts).
- [Invitation preservation across augmentation resets](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Prestige.ts).
