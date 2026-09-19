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
        eligible.sort((a, b) => Number(b.repGap === 0) - Number(a.repGap === 0) || b.price - a.price || a.name.localeCompare(b.name));
        const item = eligible[0];
        if (!item) { errors.push(`Unresolved prerequisites: ${[...remaining].join(", ")}`); break; }
        const estimatedPrice = item.price * multiplier ** order.length;
        order.push({ ...item, estimatedPrice }); have.add(item.name); remaining.delete(item.name);
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
    if (!Number.isFinite(multiplier) || multiplier < 1) throw new Error("price-multiplier must be finite and at least 1");
    if (!["hacking", "all"].includes(focus)) throw new Error("focus must be hacking or all");
    const { catalog, owned } = readAugmentationCatalog(ns);
    const targets = target ? [target] : catalog.filter(a => focus === "all" ||
        Object.entries(a.stats).some(([key, value]) => key.startsWith("hacking") && value > 1)).map(a => a.name);
    return planAugmentations(catalog, owned, targets, multiplier);
}
