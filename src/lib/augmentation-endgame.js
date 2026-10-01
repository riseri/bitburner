import { purchaseInflation } from "lib/augmentation-plan.js";
import { spendableForAugmentation } from "lib/augmentation-loop.js";
import { readSavings } from "lib/savings.js";
import { resetEpoch } from "lib/progression-protocol.js";

const NFG = "NeuroFlux Governor", NFG_LEVEL_COST = 1.14, MAX_PURCHASES = 100;

// Existing reputation and surplus cash only: no faction-work/donation detour
// while the final hacking goal is active. Every purchase is re-quoted below.
export function quoteEndgamePackage(ns, cfg, context) {
    const savings = readSavings(ns), floor = Math.max(context.money * cfg.cashReserve, savings.floor);
    if (savings.error || !Number.isFinite(floor) || floor < 0) return { purchases: [], floor, cost: 0 };
    const held = new Set(context.owned), offers = new Map(), inflation = purchaseInflation(context.reset);
    for (const faction of context.player.factions || []) {
        const rep = ns.singularity.getFactionRep(faction);
        if (!Number.isFinite(rep)) continue;
        for (const name of ns.singularity.getAugmentationsFromFaction(faction)) {
            if (name !== NFG && held.has(name) || faction === "Shadows of Anarchy") continue;
            const previous = offers.get(name);
            if (!previous || rep > previous.rep) offers.set(name, { name, faction, rep });
        }
    }
    const items = [...offers.values()].map(item => ({ ...item,
        price: ns.singularity.getAugmentationPrice(item.name), requiredRep: ns.singularity.getAugmentationRepReq(item.name),
        stats: ns.singularity.getAugmentationStats(item.name), prerequisites: ns.singularity.getAugmentationPrereq(item.name) }));
    const valid = item => Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.requiredRep) &&
        item.requiredRep >= 0 && item.rep >= item.requiredRep;
    const candidates = items.filter(item => item.name !== NFG && valid(item) &&
        (item.stats?.hacking > 1 || item.stats?.hacking_exp > 1)).sort((a, b) =>
        (Math.log(b.stats.hacking || 1) + Math.log(b.stats.hacking_exp || 1)) / Math.sqrt(b.price) -
        (Math.log(a.stats.hacking || 1) + Math.log(a.stats.hacking_exp || 1)) / Math.sqrt(a.price));
    let cost = 0;
    const purchases = [];
    for (let pass = 0; pass < candidates.length && purchases.length < MAX_PURCHASES; pass++) {
        const candidate = candidates.find(item => !held.has(item.name) && item.prerequisites.every(name => held.has(name)) &&
            cost + item.price * inflation ** purchases.length <= context.money - floor);
        if (!candidate) break;
        cost += candidate.price * inflation ** purchases.length;
        purchases.push(candidate); held.add(candidate.name);
    }
    const nfg = items.find(item => item.name === NFG && valid(item));
    for (let level = 0; nfg && purchases.length < MAX_PURCHASES; level++) {
        const price = nfg.price * inflation ** purchases.length * NFG_LEVEL_COST ** level;
        const rep = nfg.requiredRep * NFG_LEVEL_COST ** level;
        if (!Number.isFinite(price) || cost + price > context.money - floor || nfg.rep < rep) break;
        cost += price; purchases.push(nfg);
    }
    return { purchases, cost, floor };
}

export function purchaseEndgamePackage(ns, cfg, context, proposal) {
    let purchased = 0, spent = 0, reason = "Quoted endgame package purchased";
    for (const item of proposal.purchases.slice(0, MAX_PURCHASES)) {
        if (resetEpoch(ns.getResetInfo()) !== context.resetEpoch || ns.getHackingLevel() >= context.finalRequirement) {
            reason = "Final-server/reset state changed"; break;
        }
        if (ns.singularity.isBusy() && !ns.singularity.getCurrentWork()) { reason = "Exclusive player activity"; break; }
        const owned = ns.singularity.getOwnedAugmentations(true);
        if (item.name !== NFG && owned.includes(item.name)) continue;
        const price = ns.singularity.getAugmentationPrice(item.name), rep = ns.singularity.getAugmentationRepReq(item.name);
        const cash = ns.getServerMoneyAvailable("home"), liveSavings = readSavings(ns);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(rep) || rep < 0 ||
            !ns.getPlayer().factions.includes(item.faction) || !ns.singularity.getAugmentationsFromFaction(item.faction).includes(item.name) ||
            ns.singularity.getFactionRep(item.faction) < rep || !ns.singularity.getAugmentationPrereq(item.name).every(name => owned.includes(name))) {
            reason = "Live price, reputation, faction or prerequisites changed"; break;
        }
        if (liveSavings.error || cash - price < proposal.floor || !spendableForAugmentation(cash, price, cfg.cashReserve, liveSavings, item.name, false)) {
            reason = "Remaining cash is reserved or protected"; break;
        }
        if (!ns.singularity.purchaseAugmentation(item.faction, item.name)) { reason = "Endgame purchase failed"; break; }
        purchased++; spent += price;
    }
    return { purchased, spent, reason };
}
