import { readSavings } from "lib/savings.js";
import { releaseRouteWork } from "lib/route-actions.js";
import { formulaGroup } from "lib/formulas.js";
import { resetEconomics } from "lib/augmentation-reset-context.js";

const CONGRUITY = ["violet Congruity Implant", "nickofolas Congruity Implant"];
const FIELDS = ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow", "hacking", "strength", "defense",
    "dexterity", "agility", "charisma", "hacking_exp", "strength_exp", "defense_exp", "dexterity_exp", "agility_exp",
    "charisma_exp", "company_rep", "faction_rep", "crime_money", "crime_success", "dnet_money", "hacknet_node_money",
    "work_money", "bladeburner_max_stamina", "bladeburner_stamina_gain", "bladeburner_analysis", "bladeburner_success_chance"];
const COSTS = ["hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost"];

// Installed 3.0.1: one additional stack penalizes ALL these multipliers by 2%.
// Congruity removes existing stacks as well as preventing future ones.
export function graftMultipliers(stats, installed, entropy, name) {
    if (!Number.isFinite(entropy) || entropy < 0) return null;
    const immune = installed.some(name => CONGRUITY.includes(name)), removes = CONGRUITY.includes(name);
    const factor = immune ? 1 : removes ? .98 ** -entropy : .98;
    if (!Number.isFinite(factor) || factor <= 0) return null;
    const net = {};
    for (const key of [...FIELDS, ...COSTS]) {
        const value = stats[key] ?? 1;
        if (!Number.isFinite(value) || value <= 0) return null;
        net[key] = value * (COSTS.includes(key) ? 1 / factor : factor);
        if (!Number.isFinite(net[key]) || net[key] <= 0) return null;
    }
    return { factor, net, stacksAfter: immune || removes ? 0 : entropy + 1 };
}

// A time-to-the-same-goal comparison. No progress during grafting is credited,
// including script income/XP that will actually continue in the background.
export function compareGraft({ price, timeMs, travelCost = 0, cash, floor, income, continueMs, afterGraftMs,
    normalMs, normalCost, resetMs, entropy, net }) {
    const result = { price, timeMs, travelCost, normalCost, normalMs, resetMs, continueMs, entropy, net,
        selected: false, reason: "Grafting estimates unavailable; ordinary progression continues" };
    if (![price, timeMs, travelCost, cash, floor, continueMs, afterGraftMs].every(Number.isFinite) ||
        price <= 0 || timeMs <= 0 || floor < 0 || continueMs <= 0 || afterGraftMs < 0 || !(income > 0)) return result;
    if (cash - price - travelCost < floor) return { ...result, reason: "Graft not funded above protected cash; no savings hold" };
    // Charge full capital replacement, and compounded entropy loss on the money
    // engine. Never turn positive cash multipliers into assumed scheduler gains.
    const retention = Math.min(1, net.hacking_money) * Math.min(1, net.hacking_grow) *
        Math.min(1, net.hacking_speed) * Math.min(1, net.hacking_chance);
    const capitalMs = (price + travelCost) / (income * retention) * 1000;
    const graftMs = timeMs + afterGraftMs + capitalMs;
    const alternatives = [continueMs, normalMs, resetMs].filter(n => Number.isFinite(n) && n >= 0);
    const best = Math.min(...alternatives);
    const selected = Number.isFinite(graftMs) && graftMs <= best * .8 && best - graftMs >= 60000;
    return { ...result, graftMs, capitalMs, savingMs: best - graftMs, selected,
        reason: selected ? "Graft beats continuing, normal purchase and quoted resets by at least 20% and 60s"
            : "Time, capital replacement and entropy outweigh grafting; ordinary progression continues" };
}

// Always protect real graft work, including manual work and work surviving a
// manager restart. Never serialize getCurrentWork's nextCompletion Promise.
export function activeGraft(ns, state) {
    const work = ns.singularity.getCurrentWork();
    if (work?.type === "GRAFTING") {
        state.resetDecision = null;
        const own = state.graftActive?.name === work.augmentation;
        state.grafting = { ...(own ? state.graftActive : {}), name: work.augmentation, state: "ACTIVE",
            reason: "Grafting in progress; player work and resets are deferred; income and sleeves continue" };
        return { state: "ACTIVE", phase: "GRAFTING", recommendation: state.grafting.reason,
            grafting: state.grafting, queued: ns.singularity.getOwnedAugmentations(true).length - ns.singularity.getOwnedAugmentations(false).length };
    }
    if (state.graftActive) {
        const completed = ns.singularity.getOwnedAugmentations(false).includes(state.graftActive.name);
        state.grafting = { name: state.graftActive.name, state: completed ? "COMPLETED" : "INTERRUPTED",
            reason: completed ? "Graft installed; replanning progression" : "Graft no longer running; ordinary progression resumed" };
        state.graftActive = null;
        state.graftRetryAt = Date.now() + (completed ? 30000 : 300000);
        state.catalog = null; state.nextEndgameQuoteAt = 0;
    }
    return null;
}

export function planGrafting(ns, cfg, state, context, plan, resetMs = null) {
    if (cfg.grafting !== true || !cfg.route || !cfg.work || !cfg.purchase || cfg.resetPolicy === "threshold" || context.reset.currentNode !== 10 || cfg.target) return null;
    if (Date.now() < (state.graftRetryAt || 0)) return null;
    // Bounded scanning, never a WAIT result. Ordinary planning runs on every tick.
    state.graftRetryAt = Date.now() + 30000;
    state.grafting = { state: "SKIPPED", reason: "No beneficial graft with reliable milestone estimates" };
    try {
        const objective = context.objective, next = plan.next;
        const balance = context.balance;
        const measured = balance && !balance.suspended && balance.milestone === objective.milestone &&
            balance.requiredHacking === objective.requiredHacking && balance.requiredCash === objective.requiredCash &&
            Number.isFinite(balance.generatedAt) && balance.generatedAt <= Date.now() && Date.now() - balance.generatedAt <= 15000;
        const skills = formulaGroup(ns, "skills", ["calculateExp"]);
        const mult = context.player.mults?.hacking * context.multipliers?.HackingLevelMultiplier;
        const xp = context.player.exp?.hacking;
        const hacking = objective.limitingResource === "hacking" && measured && balance.xpSource === "measured" &&
            balance.xpRate > 0 && skills && mult > 0 && Number.isFinite(xp) && objective.requiredHacking > context.player.skills?.hacking;
        const reputation = objective.limitingResource === "reputation" && next?.repGap > 0 && next.rate > 0 &&
            !next.passiveReputation && !next.donationPlanned;
        if (!hacking && !reputation) return null;
        const savings = readSavings(ns);
        // Protect even automatic normal-purchase savings. Grafts never publish
        // their own savings target or consume essential bootstrap capital.
        const floor = Math.max(savings.floor, context.money * (cfg.cashReserve ?? .1), objective.requiredCash || 0);
        const travelCost = context.player.city === "New Tokyo" ? 0 : 200000;
        const targetXp = hacking ? skills.calculateExp(objective.requiredHacking, mult) : null;
        const continueMs = hacking ? Math.max(0, targetXp - xp) / balance.xpRate * 1000 : next.repGap / next.rate * 1000;
        const normalItems = [...(plan.order || []), ...(plan.deferred || [])];
        const candidates = [];
        for (const name of ns.grafting.getGraftableAugmentations()) {
            if (context.owned.includes(name) || !ns.singularity.getAugmentationPrereq(name).every(p => context.installed.includes(p))) continue;
            const stats = ns.singularity.getAugmentationStats(name);
            const entropy = graftMultipliers(stats, context.installed, context.player.entropy, name);
            if (!entropy) continue;
            const net = entropy.net;
            const effective = hacking ? net.hacking * net.hacking_exp : net.faction_rep * Math.min(1, net.hacking);
            if (effective <= 1.02) continue;
            const price = ns.grafting.getAugmentationGraftPrice(name);
            const timeMs = ns.grafting.getAugmentationGraftTime(name) /
                (cfg.focusWork || context.installed.includes("Neuroreceptor Management Implant") ? 1 : .8);
            const afterGraftMs = hacking ? Math.max(0, skills.calculateExp(objective.requiredHacking, mult * net.hacking) - xp) /
                (balance.xpRate * net.hacking_exp * Math.min(1, net.hacking_speed)) * 1000 : name === next.name ? 0 : continueMs / effective;
            const normal = normalItems.find(a => a.name === name);
            const economics = resetEconomics(ns, context, plan, state, [name]);
            const e = economics.evidence;
            // Unknown acquisition time is optimistically zero for the normal
            // alternative, never Infinity used to make grafting look attractive.
            const normalCost = normal?.price ?? ns.singularity.getAugmentationPrice(name);
            const acquisition = Number.isFinite(normal?.etaMs) ? normal.etaMs : 0;
            const normalMs = e.reliable && !CONGRUITY.includes(name) ? acquisition + e.recoveryMs +
                (reputation && name === next.name ? 0 : Math.max(...e.lanes.map(l => (l.remainingMs + l.lostMs) / l.benefit))) : null;
            // Without a comparable reset projection, compare against an optimistic
            // instant normal install, losing XP/rep but charging no recovery.
            const removal = CONGRUITY.includes(name) ? entropy.factor : 1;
            const optimisticNormal = acquisition + (hacking ? skills.calculateExp(objective.requiredHacking, mult * (stats.hacking || 1) * removal) /
                (balance.xpRate * (stats.hacking_exp || 1) * removal) * 1000 : name === next.name ? 0 :
                next.repRequired / (next.rate * (stats.faction_rep || 1) * removal) * 1000);
            const result = compareGraft({ price, timeMs, travelCost, cash: context.money, floor, income: context.income,
                continueMs, afterGraftMs, normalMs: normalMs ?? optimisticNormal, normalCost, resetMs, entropy, net });
            candidates.push({ ...result, name, normalEstimate: normalMs == null ? "Optimistic normal install; zero recovery allowance" : e.recoverySource || "measured recovery" });
        }
        candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || (b.savingMs ?? -Infinity) - (a.savingMs ?? -Infinity));
        if (!candidates.length) return null;
        const best = candidates[0];
        state.grafting = { ...best, state: best.selected ? "READY" : "SKIPPED" };
        plan.grafting = state.grafting;
        return best.selected ? { ...best, floor } : null;
    } catch (error) {
        state.grafting = { state: "UNAVAILABLE", reason: `Graft estimate unavailable; ordinary progression continues: ${String(error?.message || error)}` };
        state.graftRetryAt = Date.now() + 60000;
        return null;
    }
}

export function startGraft(ns, cfg, state, context, choice) {
    if (!choice) return null;
    const defer = reason => { state.grafting = { ...state.grafting, state: "DEFERRED", reason }; return null; };
    try {
        // All checks and mutations are synchronous: no stale request or helper
        // can start after a reset or overwrite newly acquired manual work.
        const price = ns.grafting.getAugmentationGraftPrice(choice.name);
        const player = ns.getPlayer(), travel = player.city === "New Tokyo" ? 0 : 200000;
        const floor = Math.max(choice.floor, readSavings(ns).floor);
        if (!Number.isFinite(price) || price <= 0 || price > choice.price || ns.getServerMoneyAvailable("home") - price - travel < floor ||
            ns.singularity.getOwnedAugmentations(true).includes(choice.name) ||
            !ns.singularity.getAugmentationPrereq(choice.name).every(p => ns.singularity.getOwnedAugmentations(false).includes(p)))
            return defer("Live price, ownership or protected cash changed; ordinary progression continues");
        if (!releaseRouteWork(ns, state)) return defer("Unrelated player activity preserved; grafting deferred");
        if (travel && !ns.singularity.travelToCity("New Tokyo")) throw new Error("New Tokyo travel failed");
        if (!ns.grafting.graftAugmentation(choice.name, cfg.focusWork)) throw new Error("Graft start rejected");
        state.graftActive = { ...choice, startedAt: Date.now() };
        return activeGraft(ns, state);
    } catch (error) {
        state.grafting = { state: "FAILED", reason: `Graft failed; ordinary progression resumes: ${String(error?.message || error)}` };
        state.graftRetryAt = Date.now() + 300000;
        return null;
    }
}
