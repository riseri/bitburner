# Endgame augmentation decisions

Installing The Red Pill makes the live `w0r1d_d43m0n` hacking requirement the
completion goal. A requirement of 9000 comes from that server, not a fixed
training target. The controller keeps free Computer Science and income workers
running while it evaluates further upgrades.

With the default automatic reset policy, the controller quotes affordable,
prerequisite-ready hacking-level/XP augmentations and repeatable NeuroFlux
Governor levels from joined factions. It preserves the initial cash reserve
through reputation funding, purchases and the pre-install fill pass, plus every
active savings floor. It can rejoin available factions after a reset. Each
package has a 100-purchase bound.

When existing reputation is insufficient, the quote includes donation cash
and the time needed for faction work. Donation requires live faction favor
eligibility, Formulas and enough unreserved cash for both rep and purchases.
Otherwise, enabled automatic work can temporarily replace the manager's own
training with faction work; unrelated manual work remains protected. The target
package stays fixed while earning rep, so rising income cannot move the goal.
Spare RAM may share for this work. Hacking training resumes after the purchases.
`--donate false`, `--work false` and `--purchase false` retain their meaning.

Funding starts only after the acquisition time plus reset projection beats
continuing. If a slow ordinary augmentation or an oversized NeuroFlux target
prevents that advantage, the controller tries NeuroFlux alone and smaller
bounded lots. A qualified queue stops further acquisition while its reset
advantage is observed. A partial purchase can be retried if the queue still
needs more benefit. After installation, the new epoch permits another cycle.
The shared progression snapshot marks this qualified reset as `resetPending`;
the fleet retains cloud capital throughout the observation window. XP work can
continue using existing capacity while the reset evidence matures.

The projection prefers the economic policy's two comparable recovery observations,
and uses measured total player XP rate, live BitNode/player multipliers, skill
Formulas, half-credit for recovered XP, conservative multiplier haircut and
4x benefit ceiling. A package qualifies only when recovery plus rebuilding the
lost hacking progress projects at least 20% and 30 seconds faster completion than
continuing with current multipliers. Installation then requires 60 seconds of
stable evidence and the existing bootstrap, reset-epoch and player-work guards.
Missing live XP, Formulas or multiplier evidence leaves training active and
reports the missing input.

The augmentation manager measures player XP independently of the daemon's
allocation and preparation gates. It requires three positive 20-second windows
with at most 25% rate variation. Changing the reset epoch, multiplier, goal or
player work, decreasing XP, or losing observations for 45 seconds discards the
series. Until it matures, fresh authenticated measured daemon XP can be used;
a potential XP-worker model cannot qualify a purchase or reset. Newly usable XP
triggers an immediate package evaluation. Ordinary background prep therefore
cannot hide steady actual XP gains from the endgame controller.

Without comparable recovery history, the final-server policy can use a declared
**24-hour recovery allowance**, with zero recovered XP and **LOW confidence**.
This is a policy assumption, not a measured recovery or a guaranteed upper
bound. It requires fresh authenticated income with at least one live income
pipeline, live XP evidence, valid restart
settings and permanent home RAM sufficient for bootstrap, supervisor and the
augmentation manager. The continued finish must be at least four days away,
and acquisition plus rebuilding must project at least **50% faster** completion.
The 60-second stability check still applies. No synthetic sample is written;
actual subsequent recoveries are recorded and preferred when comparable.

An empty shopping quote reports its actual blocker: faction access, existing
reputation, prerequisites, protected cash or invalid live quotes. It does not
replace that explanation with “No queued endgame upgrades.” Recovery evidence
counts augmentation-reset samples; the telemetry history's worker/pipeline
recovery events are separate observations.

Augmentation installation also clears IPvGO speed power. The endgame projection
prices the loss of the current Illuminati bonus against script XP only, before
applying the conservative haircut and benefit ceiling. Capping the gain before
charging the Go loss could incorrectly veto every first reset at 100% or higher
Go power, however many NeuroFlux levels were in the package. Player work XP
keeps its rate; unavailable script share (including independent manager samples)
is conservatively treated as all script XP. Speed benefits from new augmentations
remain unpriced. The reported reset ETA uses the capped conservative benefit;
it is not a prediction that the full multiplier gain is limited to 4x.

An old or complete queue does not force an automatic endgame reset. The
alternative being compared is finishing the node, not buying another item.
Explicit `--reset-policy threshold` still permits the configured queue threshold.
The pre-install NeuroFlux fill pass remains available after a reset is approved.

NeuroFlux quotes use the live current price/reputation and then account for both
global queued-purchase inflation and its 1.14 per-level cost/reputation growth.
Actual purchases re-read price, reputation, prerequisites, faction membership,
reset state and protected savings before every spend. Donation rechecks favor,
membership and the live combined funding quote before spending. The stable mechanics are
defined in [augmentation costs](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Augmentation/AugmentationHelpers.ts)
and [constants](https://github.com/bitburner-official/bitburner-src/blob/stable/src/Constants.ts);
[Singularity](https://github.com/bitburner-official/bitburner-src/blob/stable/src/NetscriptFunctions/Singularity.ts)
defines faction-work and donation eligibility.

The augmentation dashboard reports the endgame policy reason and both finish
ETAs when projections are available, plus the measured XP source or sampling
progress, proposed NeuroFlux count, actually queued NeuroFlux count, funding
target, and whether recovery is measured or uses the conservative allowance.
Missing skill Formulas, BitNode multipliers, XP measurements and restart
readiness have separate blocker messages. The progression dashboard labels
a faction connection suggestion as **Backdoor path**, and omits it at the final
server milestone. A running service or suggested connection path alone does not
establish progress toward the node's hacking requirement.
