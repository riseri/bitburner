// The user's route is BN5.1 -> BN4.1 -> BN4.2 -> BN4.3. Never invent a next node.
export function bn4Route(reset) {
    const level = Number(reset.ownedSF?.get?.(4) ?? 0);
    return reset.currentNode === 4 && level < 3;
}

export function nextRouteNode(reset) {
    return bn4Route(reset) && Number(reset.ownedSF?.get?.(4) ?? 0) < 2 ? 4 : null;
}

export function routeCities(factions, selected = "") {
    if (selected) {
        const groups = [["Sector-12", "Aevum"], ["Chongqing", "New Tokyo", "Ishima"], ["Volhaven"]];
        const group = groups.find(g => g.includes(selected));
        if (group && factions.some(f => groups.some(g => g.includes(f)) && !group.includes(f))) return [];
        return [selected];
    }
    if (factions.includes("Volhaven")) return ["Volhaven"];
    const east = ["Chongqing", "New Tokyo", "Ishima"];
    return factions.some(f => east.includes(f)) ? east : ["Sector-12", "Aevum"];
}

export function routeInstallation({ installed, pending, plan, money, minInstall, lastAugReset, now = Date.now() }) {
    if (!pending.length) return "";
    if (pending.includes("The Red Pill")) return "The Red Pill is queued";
    if (new Set(installed).size < 30 && new Set([...installed, ...pending]).size >= 30) return "Install to meet Daedalus's augmentation requirement";
    if (pending.length >= minInstall) return "Batch threshold reached";
    if (!plan.next && !plan.errors.length) return "Available augmentation batch is complete";
    // Bound waiting on an unaffordable or reputation-locked next item. No empty resets.
    if (now - lastAugReset >= 30 * 60_000 && plan.next &&
        (plan.next.repGap > 0 || plan.next.price > money * .9)) return "Install the current batch after 30 minutes instead of stalling";
    return "";
}
