import { releaseRouteWork, routeOwnsWork } from "lib/route-actions.js";
import { GANG_KARMA_TARGET } from "lib/sleeve-policy.js";

// Karma is a parallel unlock, never a prerequisite for augmentations/Daedalus.
// One minute in five guarantees progress even when faction work is continuous;
// funding/passive-reputation waits can use the remaining player time too.
export function routeGangKarma(ns, cfg, state, context, plan) {
    const eligible = cfg.gangKarma === true && cfg.work && context.capabilities.gang &&
        context.reset.currentNode !== 2 && !context.gang?.inGang && !context.owned.includes("The Red Pill");
    const karma = eligible ? ns.heart.break() : GANG_KARMA_TARGET;
    const needed = eligible && Number.isFinite(karma) && karma > GANG_KARMA_TARGET;
    const work = ns.singularity.getCurrentWork();
    const slot = (Date.now() - context.reset.lastNodeReset) % 300000 < 60000;
    const spare = plan.next && (!(plan.next.repGap > 0) || plan.next.passiveReputation);
    if (!needed || !slot && !spare) {
        if (state.gangKarmaWork && work?.type === "CRIME" && routeOwnsWork(work, state)) releaseRouteWork(ns, state);
        state.gangKarmaWork = false;
        return null;
    }
    if (work && !routeOwnsWork(work, state) || !work && ns.singularity.isBusy()) return null;
    if (!(work?.type === "CRIME" && work.crimeType === "Homicide" && state.ownedCrime === "Homicide")) {
        if (!releaseRouteWork(ns, state)) return null;
        // In 3.0.1 failed player crimes also give 25% karma. Homicide has the
        // best minimum karma/sec, even at low stats. Sleeves use success-only rates.
        if (!(ns.singularity.commitCrime("Homicide", cfg.focusWork) > 0)) return null;
        state.ownedCrime = "Homicide";
    }
    state.gangKarmaWork = true;
    return { state: "ACTIVE", phase: "GANG_KARMA", karma, karmaTarget: GANG_KARMA_TARGET,
        recommendation: `Gang karma ${Math.round(karma)} / ${GANG_KARMA_TARGET}; bounded player crime plus sleeves; augmentation installs remain enabled` };
}
