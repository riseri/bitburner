import { factionWorkAnalysis, formulaDonationForRep, formulaFavorProjection } from "lib/formulas.js";
import { readSavings } from "lib/savings.js";
import { augmentationFundingCost, augmentationReputationStrategy } from "lib/augmentation-funding.js";

// Orders expensive eligible purchases first, while always buying prerequisites first.
// This is a heuristic, not a claim of globally optimal ordering.
export function planAugmentations(catalog, owned, targets, multiplier = 1) {
    const byName = new Map(catalog.map(a => [a.name, a])), have = new Set(owned), wanted = new Set(), errors = [];
    const visit = (name, stack = new Set()) => {
        if (have.has(name) || wanted.has(name)) return;
        if (stack.has(name)) { errors.push(`Prerequisite cycle: ${name}`); return; }
        const item = byName.get(name);
        if (!item) { errors.push(`Unavailable prerequisite or target: ${name}`); return; }
        const next = new Set(stack); next.add(name);
        for (const prerequisite of item.prerequisites) visit(prerequisite, next);
        wanted.add(name);
    };
    for (const name of targets) visit(name);
    const order = [], remaining = new Set(wanted);
    while (remaining.size) {
        const eligible = [...remaining].map(name => byName.get(name)).filter(a => a.prerequisites.every(p => have.has(p)));
        // Prefer purchases we can make now; otherwise show the reputation work needed next.
        eligible.sort((a, b) => Number(b.repGap === 0) - Number(a.repGap === 0) ||
            (b.routePriority ?? augmentationPriority(b)) - (a.routePriority ?? augmentationPriority(a)) || (a.routePriority === 0 && b.routePriority === 0 ? a.repRequired - b.repRequired || a.price - b.price : b.price - a.price) || a.name.localeCompare(b.name));
        const item = eligible[0];
        if (!item) { errors.push(`Unresolved prerequisites: ${[...remaining].join(", ")}`); break; }
        const estimatedPrice = item.price * multiplier ** order.length;
        order.push({ ...item, estimatedPrice, fundingCost: augmentationFundingCost(item),
            progressionStrategy: augmentationReputationStrategy(item) }); have.add(item.name); remaining.delete(item.name);
    }
    return { order, errors, total: order.reduce((sum, a) => sum + a.estimatedPrice, 0), multiplier,
        next: order[0] || null };
}

export function readAugmentationCatalog(ns) {
    const owned = ns.singularity.getOwnedAugmentations(true);
    const factions = ns.getPlayer().factions;
    const catalog = new Map();
    for (const faction of factions) {
        const rep = ns.singularity.getFactionRep(faction);
        for (const name of ns.singularity.getAugmentationsFromFaction(faction)) {
            if (owned.includes(name) || name === "NeuroFlux Governor") continue;
            const repRequired = ns.singularity.getAugmentationRepReq(name);
            const repGap = Math.max(0, repRequired - rep);
            const previous = catalog.get(name);
            if (!previous || repGap < previous.repGap) catalog.set(name, {
                name, faction, repRequired, repGap, price: ns.singularity.getAugmentationPrice(name),
                prerequisites: ns.singularity.getAugmentationPrereq(name), stats: ns.singularity.getAugmentationStats(name),
            });
        }
    }
    return { catalog: [...catalog.values()], owned };
}

export function buildAugmentationPlan(ns, options = {}) {
    const focus = String(options.focus ?? "hacking"), target = String(options.target ?? "");
    const multiplier = Number(options.multiplier ?? options["price-multiplier"] ?? 1);
    if (!Number.isFinite(multiplier) || multiplier !== 0 && multiplier < 1) throw new Error("price-multiplier must be 0 (automatic), or finite and at least 1");
    if (!["hacking", "all"].includes(focus)) throw new Error("focus must be hacking or all");
    if (options.context) return buildDynamicPlan(ns, options);
    const { catalog, owned } = readAugmentationCatalog(ns);
    if (options.route && !target) {
        for (const a of catalog) a.routePriority = augmentationPriority(a) > 0 ? 100 + augmentationPriority(a)
            : Object.entries(a.stats).reduce((score, [key, value]) => score + (key.startsWith("hacking") && value > 1 ? Math.log(value) * 10 : 0), 0);
    }
    const available = new Map(catalog.map(a => [a.name, a]));
    const reachable = (name, seen = new Set()) => {
        if (owned.includes(name)) return true;
        if (seen.has(name) || !available.has(name)) return false;
        const next = new Set(seen); next.add(name);
        return available.get(name).prerequisites.every(p => reachable(p, next));
    };
    const candidates = options.route ? catalog.filter(a => reachable(a.name)) : catalog;
    const countFillers = options.route && new Set(owned).size < 30;
    const endgameTarget = !target && catalog.some(a => a.name === "The Red Pill") ? "The Red Pill" : target;
    const targets = !target && owned.includes("The Red Pill") ? [] : endgameTarget ? [endgameTarget] : candidates.filter(a => countFillers || focus === "all" || augmentationPriority(a) > 0 ||
        Object.entries(a.stats).some(([key, value]) => key.startsWith("hacking") && value > 1)).map(a => a.name);
    return planAugmentations(catalog, owned, targets, multiplier || 1.9);
}

function augmentationPriority(augmentation) {
    if (augmentation.name === "The Red Pill") return 2;
    if (augmentation.name === "Neuroreceptor Management Implant" || Number(augmentation.stats?.faction_rep) > 1) return 1;
    return 0;
}

export function purchaseInflation(reset) {
    const sf = reset.currentNode === 11 ? 3 : Math.min(3, Math.max(0, Number(reset.ownedSF?.get?.(11)) || 0));
    return 1.9 * [1, .96, .94, .93][sf];
}

export function augmentationValue(item, context) {
    if (item.name === "The Red Pill") return 1000;
    const objective = context.objective || {}, m = context.multipliers;
    const xp = objective.limitingResource === "hacking", rep = objective.limitingResource === "reputation";
    const economy = m ? Math.min(1, Math.max(0, Number(m.ScriptHackMoney ?? 1)), Math.max(0, Number(m.ScriptHackMoneyGain ?? 1))) : 1;
    const weights = { hacking: xp ? 12 : 4, hacking_exp: xp ? 10 : 3, hacking_money: 5 * economy,
        hacking_grow: 4 * economy, hacking_speed: 6, hacking_chance: 2 * economy, faction_rep: rep ? 12 : 9,
        company_rep: context.companyStrategy ? 5 : 0, work_money: 1,
        strength: context.combatStrategy ? 4 : 0, defense: context.combatStrategy ? 4 : 0,
        dexterity: context.combatStrategy ? 4 : 0, agility: context.combatStrategy ? 4 : 0 };
    let score = item.name === "Neuroreceptor Management Implant" ? 2 : 0;
    for (const [key, weight] of Object.entries(weights)) score += Math.log(Math.max(1, Number(item.stats?.[key]) || 1)) * weight;
    if (objective.ownedCount < objective.countRequired && item.name !== "NeuroFlux Governor") score += .5;
    return score + (context.includeAll ? .01 : 0);
}

export function chooseAugmentationSeller(sellers, { price, cash, income, donate = true, previous = "" }) {
    const eta = amount => amount <= 0 ? 0 : income > 0 ? amount / income * 1000 : null;
    const ranked = sellers.map(s => {
        const workEta = s.repGap === 0 ? 0 : s.rate > 0 ? s.repGap / s.rate * 1000 : null;
        const moneyEta = eta(price - cash);
        const directEta = workEta != null && moneyEta != null ? Math.max(workEta, moneyEta) : null;
        const donationEta = donate && s.repGap > 0 && s.donationEligible && Number.isFinite(s.donationCost) && s.donationCost > 0
            ? eta(augmentationFundingCost({ ...s, price, donationPlanned: true }) - cash) : null;
        const donation = donationEta != null && (directEta == null || donationEta < directEta);
        const selected = { ...s, price, donationPlanned: donation };
        return { ...s, etaMs: donation ? donationEta : directEta, donationPlanned: donation,
            workEtaMs: workEta, donationEtaMs: donationEta,
            fundingCost: augmentationFundingCost(selected), progressionStrategy: augmentationReputationStrategy(selected),
            acquisitionCost: augmentationFundingCost({ ...selected, chainCost: 0 }),
            explanation: donation ? "Donation + purchase beats faction-work ETA" : workEta == null ? "work rate unknown; reputation/favor fallback" : "work and cash can accrue together" };
    }).sort((a,b) => (a.etaMs ?? Infinity) - (b.etaMs ?? Infinity) || a.repGap - b.repGap || b.favor - a.favor || a.faction.localeCompare(b.faction));
    const best = ranked[0], old = ranked.find(s => s.faction === previous);
    // Keep an incumbent within 10%; never hide an immediately eligible seller.
    return old && old.etaMs != null && best?.etaMs > 0 && old.etaMs <= best.etaMs * 1.1 ? old : best;
}

// Greedy whole-chain utility/cost baskets; live quotes already include queued inflation.
export function planAugmentationBasket(catalog, owned, context, { cash = 0, multiplier = 1.9, target = "", previous = "" } = {}) {
    const available = new Map(catalog.map(a => [a.name,a])), initial = new Set(owned), have = new Set(owned);
    const errors = [], order = [], deferred = [], max = catalog.length;
    const chain = (name, held, stack = new Set()) => {
        if (held.has(name)) return [];
        if (stack.has(name) || !available.has(name)) return null;
        const item = available.get(name), next = new Set(stack); next.add(name);
        const result = [], seen = new Set(held);
        for (const p of item.prerequisites || []) {
            const values = chain(p, seen, next); if (!values) return null;
            for (const value of values) { if (!seen.has(value.name)) result.push(value); seen.add(value.name); }
        }
        return [...result,item];
    };
    const estimate = (items, offset) => items.reduce((sum,a,i) => sum + a.price * multiplier ** (offset+i),0);
    let remainingCash = cash;
    for (let iteration=0; iteration<max; iteration++) {
        const candidates = catalog.filter(a => !have.has(a.name) && (!target || a.name === target)).map(a => {
            const items = chain(a.name,have); if (!items) return null;
            const cost = estimate(items,order.length), value = items.reduce((n,v) => n + augmentationValue(v,context),0);
            const fundingCost = augmentationFundingCost({ ...items[0], chainCost: cost });
            const eligible = items.every(v => v.repGap === 0), affordable = eligible && cost <= remainingCash;
            return { item:a, items, cost, value, affordable, utility: value / Math.max(1,Math.sqrt(cost)),
                fundingCost,
                etaMs: items.every(v => v.etaMs != null) ? Math.max(...items.map(v => v.etaMs), context.income > 0 ? Math.max(0,fundingCost-remainingCash)/context.income*1000 : fundingCost<=remainingCash ? 0 : Infinity) : null };
        }).filter(c => c && (target || c.value > 0));
        candidates.sort((a,b) => Number(b.affordable)-Number(a.affordable) || b.utility-a.utility || a.cost-b.cost || a.item.name.localeCompare(b.item.name));
        if (!candidates.length) break;
        let best = candidates[0];
        const old = candidates.find(c => c.item.name === previous);
        if (old && old.affordable === best.affordable && old.utility >= best.utility*.9) best = old;
        if (!best.affordable) { deferred.push(...candidates.map(c => ({ ...c.items[0], chainTarget:c.item.name, chainCost:c.cost,
            fundingCost:c.fundingCost, progressionStrategy:augmentationReputationStrategy(c.items[0]),
            benefitNow:0, benefitAfterInstall:augmentationValue(c.items[0],context), etaMs:Number.isFinite(c.etaMs)?c.etaMs:null }))); break; }
        for (const item of best.items) {
            const estimatedPrice = item.price * multiplier ** order.length;
            order.push({ ...item, estimatedPrice, fundingCost:augmentationFundingCost(item), progressionStrategy:augmentationReputationStrategy(item),
                benefitAfterInstall: augmentationValue(item,context), benefitNow: 0 });
            remainingCash -= estimatedPrice; have.add(item.name);
        }
        if (target) break;
    }
    if (target && !initial.has(target) && !chain(target,initial)) errors.push("Unavailable prerequisite or target: " + target);
    const next = order[0] || deferred[0] || null;
    return { order, deferred, next, errors, multiplier, total:order.reduce((n,a)=>n+a.estimatedPrice,0),
        availableCash:cash, reserve:context.money-cash, strategy:context.objective?.strategy,
        explanation: order.length ? "Achievable prerequisite-complete basket; benefits begin after installation" : "No achievable basket; work/save for the selected chain",
        missingInformation: catalog.some(a=>a.etaMs==null) ? ["Some work or income rates are unavailable"] : [] };
}

function buildDynamicPlan(ns, options) {
    const context = { ...options.context, includeAll: options.focus === "all" }, state = options.state || {}, now = Date.now();
    const factions = context.player.factions, key = context.resetEpoch + ":" + [...factions].sort().join("|") + ":" + (options.target || "");
    // Cache only static metadata. Quotes, ownership, reputation and spending limits are live.
    if (state.catalog?.key !== key || !state.catalog.items.length || now-state.catalog.at >= 60000) {
        const items = new Map();
        for (const faction of factions) for (const name of ns.singularity.getAugmentationsFromFaction(faction)) {
            if (name === "NeuroFlux Governor" || faction === "Shadows of Anarchy" && options.target !== name) continue;
            if (!items.has(name)) items.set(name,{name, factions:[], prerequisites:ns.singularity.getAugmentationPrereq(name), stats:ns.singularity.getAugmentationStats(name)});
            items.get(name).factions.push(faction);
        }
        state.catalog = {key,at:now,items:[...items.values()]};
    }
    const savings = readSavings(ns), reserve = Math.max(context.money*(options.cashReserve ?? .1),
        savings.owner === "supervisor" && savings.target?.startsWith("augmentation:") ? 0 : savings.floor);
    const cash = Math.max(0,context.money-reserve), factionData = new Map();
    for (const faction of factions) {
        let rate = null, rateSource = "unknown", favor = 0, projectedFavor = null, workAvailable = false;
        try {
            favor = ns.singularity.getFactionFavor(faction);
            const types = ns.singularity.getFactionWorkTypes(faction); workAvailable = types.length > 0;
            const analysis = factionWorkAnalysis(ns,faction,types,context.player);
            rate = analysis?.reputationPerSecond * (options.focusWork || context.installed.includes("Neuroreceptor Management Implant") ? 1 : .8) || null;
            if (rate > 0) rateSource = "model";
            projectedFavor = formulaFavorProjection(ns,faction);
        } catch {}
        const rep = ns.singularity.getFactionRep(faction), prior = state.repSamples?.[faction];
        const current = ns.singularity.getCurrentWork?.();
        if (!(state.lastDonation?.faction === faction && state.lastDonation.at >= prior?.at) && prior && prior.epoch === context.resetEpoch && now>prior.at && now-prior.at<=15000 && rep>prior.rep && current?.type === "FACTION" && current.factionName === faction && prior.working)
            { rate = (rep-prior.rep)*1000/(now-prior.at); rateSource = "measured"; }
        state.repSamples ||= {}; state.repSamples[faction] = {epoch:context.resetEpoch,at:now,rep,working:current?.type === "FACTION" && current.factionName === faction};
        factionData.set(faction,{faction,rep,rate,rateSource,workActive:current?.type === "FACTION" && current.factionName === faction,
            favor,projectedFavor,donationEligible:workAvailable && favor >= (ns.getFavorToDonate?.() ?? Infinity)});
    }
    const catalog = state.catalog.items.filter(a=>!context.owned.includes(a.name)).map(a=>{
        const price=ns.singularity.getAugmentationPrice(a.name), repRequired=ns.singularity.getAugmentationRepReq(a.name);
        const sellers=a.factions.map(f=>{ const s=factionData.get(f), repGap=Math.max(0,repRequired-s.rep);
            return {...s,repGap,donationCost:s.donationEligible ? formulaDonationForRep(ns,repGap,context.player) : null}; });
        const seller=chooseAugmentationSeller(sellers,{price,cash,income:context.income,donate:options.donate,previous:state.selectedSellers?.[a.name]});
        const fullDonation=formulaDonationForRep(ns,repRequired,context.player);
        const favorUnlockEtaMs=seller.projectedFavor >= (ns.getFavorToDonate?.() ?? Infinity) && !seller.donationEligible &&
            fullDonation>0 && context.income>0 && state.recoveryMs>0 ? state.recoveryMs + (price+fullDonation)/context.income*1000 : null;
        return {...a,price,repRequired,...seller,sellers,favorUnlockEtaMs};
    });
    state.selectedSellers=Object.fromEntries(catalog.map(a=>[a.name,a.faction]));
    const target = options.target || (context.owned.includes("The Red Pill") ? "" : catalog.some(a=>a.name === "The Red Pill") ? "The Red Pill" : "");
    if (!options.target && context.owned.includes("The Red Pill")) return {order:[],next:null,errors:[],total:0,multiplier:purchaseInflation(context.reset)};
    const selected = catalog;
    const plan=planAugmentationBasket(selected,context.owned,context,{cash,multiplier:Number(options.multiplier || options["price-multiplier"]) || purchaseInflation(context.reset),target,previous:state.selectedAugmentation});
    state.selectedAugmentation=plan.next?.name;
    return plan;
}
