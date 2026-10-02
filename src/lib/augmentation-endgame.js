import { purchaseInflation } from "lib/augmentation-plan.js";
import { spendableForAugmentation } from "lib/augmentation-loop.js";
import { readSavings } from "lib/savings.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { factionWorkAnalysis, formulaDonationForRep } from "lib/formulas.js";

const NFG = "NeuroFlux Governor", NFG_LEVEL_COST = 1.14, MAX_PURCHASES = 100;

// Funding is hypothetical until the controller verifies a faster finish. Include
// donation cash and faction-work time in the quote, with one target per faction.
export function quoteEndgamePackage(ns, cfg, context,
    { fundReputation = false, maxPurchases = MAX_PURCHASES, reserveFloor = 0, neurofluxOnly = false } = {}) {
    const limit = Number.isSafeInteger(maxPurchases) && maxPurchases > 0 ? Math.min(MAX_PURCHASES, maxPurchases) : MAX_PURCHASES;
    const savings = readSavings(ns), floor = Math.max(context.money * cfg.cashReserve, savings.floor, reserveFloor);
    if (savings.error || !Number.isFinite(floor) || floor < 0) return { purchases: [], floor, cost: 0,
        reason: savings.error ? `Protected savings unavailable: ${savings.error}` : "Invalid endgame cash reserve" };
    const held = new Set(context.owned), offers = new Map(), sellers = new Map(), inflation = purchaseInflation(context.reset);
    for (const faction of context.player.factions || []) {
        const rep = ns.singularity.getFactionRep(faction);
        if (!Number.isFinite(rep)) continue;
        for (const name of ns.singularity.getAugmentationsFromFaction(faction)) {
            if (name !== NFG && held.has(name) || faction === "Shadows of Anarchy") continue;
            const previous = offers.get(name);
            if (!previous) offers.set(name, { name, faction, rep, sellers: [] });
            const offer = offers.get(name);
            offer.sellers.push({ faction, rep });
            if (rep > offer.rep) { offer.faction = faction; offer.rep = rep; }
        }
    }
    const items = [...offers.values()].map(item => ({ ...item,
        price: ns.singularity.getAugmentationPrice(item.name), requiredRep: ns.singularity.getAugmentationRepReq(item.name),
        stats: ns.singularity.getAugmentationStats(item.name), prerequisites: ns.singularity.getAugmentationPrereq(item.name) }));
    const valid = item => Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.requiredRep) &&
        item.requiredRep >= 0 && (fundReputation || item.rep >= item.requiredRep);
    const candidates = items.filter(item => !neurofluxOnly && item.name !== NFG && valid(item) &&
        (item.stats?.hacking > 1 || item.stats?.hacking_exp > 1)).sort((a, b) =>
        (Math.log(b.stats.hacking || 1) + Math.log(b.stats.hacking_exp || 1)) / Math.sqrt(b.price) -
        (Math.log(a.stats.hacking || 1) + Math.log(a.stats.hacking_exp || 1)) / Math.sqrt(a.price));
    let cost = 0, funding = [];
    const purchases = [], targets = new Map(), budget = context.money - floor;
    const quotePurchase = (item, price, requiredRep) => {
        if (!Number.isFinite(price) || cost + price > budget) return null;
        const options = [];
        for (const seller of item.sellers) {
            if (!fundReputation && seller.rep < requiredRep) continue;
            const goals = new Map(targets);
            goals.set(seller.faction, Math.max(goals.get(seller.faction) || 0, requiredRep));
            const quote = quoteFunding(ns, cfg, context, goals, budget - cost - price, fundReputation, sellers);
            if (quote) options.push({ item: { ...item, faction: seller.faction, rep: seller.rep }, goals, ...quote });
        }
        return options.sort((a, b) => a.acquisitionMs - b.acquisitionMs || a.donationCost - b.donationCost || b.item.rep - a.item.rep)[0] || null;
    };
    const add = (quote, price) => {
        cost += price; purchases.push(quote.item); funding = quote.funding;
        targets.clear(); for (const [faction, requiredRep] of quote.goals) targets.set(faction, requiredRep);
    };
    for (let pass = 0; pass < candidates.length && purchases.length < limit; pass++) {
        let quote = null;
        const candidate = candidates.find(item => !held.has(item.name) && item.prerequisites.every(name => held.has(name)) &&
            (quote = quotePurchase(item, item.price * inflation ** purchases.length, item.requiredRep)));
        if (!candidate) break;
        add(quote, candidate.price * inflation ** purchases.length); held.add(candidate.name);
    }
    const nfg = items.find(item => item.name === NFG && valid(item));
    for (let level = 0; nfg && purchases.length < limit; level++) {
        const price = nfg.price * inflation ** purchases.length * NFG_LEVEL_COST ** level;
        const rep = nfg.requiredRep * NFG_LEVEL_COST ** level;
        const quote = quotePurchase(nfg, price, rep);
        if (!quote) break;
        add(quote, price);
    }
    const donationCost = funding.reduce((sum, goal) => sum + goal.donationCost, 0);
    return { purchases, cost: cost + donationCost, purchaseCost: cost, donationCost, funding, neurofluxOnly,
        acquisitionMs: funding.reduce((sum, goal) => sum + goal.etaMs, 0), floor,
        reason: purchases.length ? `${purchases.length} affordable endgame upgrades quoted` :
        emptyQuoteReason(items, held, context.money - floor) };
}

function quoteFunding(ns, cfg, context, targets, budget, enabled, sellers) {
    const funding = [];
    let donationCost = 0, acquisitionMs = 0;
    for (const [faction, requiredRep] of targets) {
        const rep = ns.singularity.getFactionRep(faction), repGap = Math.max(0, requiredRep - rep);
        if (!Number.isFinite(rep) || !Number.isFinite(requiredRep)) return null;
        if (!repGap) continue;
        if (!enabled) return null;
        if (!sellers.has(faction)) {
            let eligible = false, analysis = null;
            try {
                const types = ns.singularity.getFactionWorkTypes(faction);
                analysis = factionWorkAnalysis(ns, faction, types, context.player);
                const favor = ns.singularity.getFactionFavor(faction), threshold = ns.getFavorToDonate();
                eligible = types.length > 0 && Number.isFinite(favor) && Number.isFinite(threshold) && favor >= threshold;
            } catch {}
            // Price unfocused work conservatively, even if the player currently focuses it.
            const focus = cfg.focusWork || context.installed.includes("Neuroreceptor Management Implant") ? 1 : .8;
            sellers.set(faction, { eligible, workType: analysis?.workType, rate: (analysis?.reputationPerSecond || 0) * focus * .8 });
        }
        const seller = sellers.get(faction);
        const amount = cfg.donate && seller.eligible ? donationQuote(ns, repGap, context.player) : null;
        const donate = Number.isFinite(amount) && amount > 0 && donationCost + amount <= budget;
        if (!donate && (!cfg.work || !seller.workType || !(seller.rate > 0) || !Number.isFinite(seller.rate))) return null;
        const goal = { faction, requiredRep, repGap, strategy: donate ? "DONATE" : "WORK",
            donationCost: donate ? amount : 0, workType: seller.workType, rate: seller.rate,
            etaMs: donate ? 0 : repGap / seller.rate * 1000 };
        if (!Number.isFinite(goal.etaMs)) return null;
        funding.push(goal); donationCost += goal.donationCost; acquisitionMs += goal.etaMs;
    }
    return { funding, donationCost, acquisitionMs };
}

function donationQuote(ns, gap, player) {
    const amount = formulaDonationForRep(ns, gap, player);
    // Avoid falling just short of the live requirement through floating-point rounding.
    return amount == null ? null : Math.ceil(amount * 1.000001);
}

export function donateEndgameReputation(ns, cfg, context, proposal, goal) {
    const stop = reason => ({ donated: false, spent: 0, reason });
    if (!cfg.donate || !cfg.purchase) return stop("Endgame donations/purchases disabled");
    if (resetEpoch(ns.getResetInfo()) !== context.resetEpoch || ns.getHackingLevel() >= context.finalRequirement)
        return stop("Final-server/reset state changed");
    if (ns.singularity.isBusy() && !ns.singularity.getCurrentWork()) return stop("Exclusive player activity");
    const player = ns.getPlayer();
    if (!player.factions.includes(goal.faction) || !ns.singularity.getFactionWorkTypes(goal.faction).length ||
        ns.singularity.getFactionFavor(goal.faction) < ns.getFavorToDonate()) return stop("Donation eligibility changed");
    // Re-quote the entire acquisition at live prices before paying for reputation.
    // This also prevents a stale donation from using cash needed by the purchases.
    const live = quoteEndgamePackage(ns, cfg, { ...context, player, money: ns.getServerMoneyAvailable("home") },
        { fundReputation: true, maxPurchases: proposal.purchases.length, reserveFloor: proposal.floor, neurofluxOnly: proposal.neurofluxOnly });
    const liveGoal = live.funding?.find(g => g.faction === goal.faction && g.strategy === "DONATE");
    if (!liveGoal || liveGoal.requiredRep < goal.requiredRep ||
        live.purchases.length < proposal.purchases.length || liveGoal.donationCost > goal.donationCost)
        return stop("Live endgame funding quote changed; replanning");
    const cash = ns.getServerMoneyAvailable("home"), savings = readSavings(ns);
    if (savings.error || cash - live.cost < proposal.floor ||
        !spendableForAugmentation(cash, live.cost, cfg.cashReserve, savings, NFG, false))
        return stop("Donation and purchases exceed unreserved cash");
    if (!ns.singularity.donateToFaction(goal.faction, liveGoal.donationCost)) return stop("Endgame donation failed; retry cooling down");
    return { donated: true, spent: liveGoal.donationCost,
        reason: `Donated for ${Math.ceil(liveGoal.requiredRep)} reputation with ${goal.faction}` };
}

function emptyQuoteReason(items, held, budget) {
    const useful = items.filter(item => item.name === NFG || item.stats?.hacking > 1 || item.stats?.hacking_exp > 1);
    if (!useful.length) return "No joined faction offers an available hacking/XP augmentation or NeuroFlux";
    const quoted = useful.filter(item => Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.requiredRep) && item.requiredRep >= 0);
    if (!quoted.length) return "Live endgame augmentation quotes unavailable";
    const eligible = quoted.filter(item => item.rep >= item.requiredRep);
    if (!eligible.length) {
        const item = quoted.find(item => item.name === NFG) || quoted[0];
        return `Existing reputation insufficient: ${item.name} needs ${Math.ceil(item.requiredRep)} rep; ${item.faction} has ${Math.floor(item.rep)}`;
    }
    const ready = eligible.filter(item => item.prerequisites.every(name => held.has(name)));
    if (!ready.length) return `Endgame prerequisites missing: ${eligible[0].name}`;
    const cheapest = ready.reduce((a, b) => a.price < b.price ? a : b);
    return `Insufficient unreserved cash: ${cheapest.name} costs $${cheapest.price.toPrecision(3)}; $${Math.max(0, budget).toPrecision(3)} spendable`;
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
