const CITY_FACTIONS = new Set(["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"]);

export function chooseInvitation(invitations, joined, cityFaction = "") {
    const members = new Set(joined || []), selectedCity = String(cityFaction || "").trim();
    for (const faction of invitations || []) {
        if (members.has(faction)) continue;
        if (!CITY_FACTIONS.has(faction) || faction === selectedCity) return faction;
    }
    return "";
}

export function chooseFactionWorkType(types, player = {}, focus = "hacking") {
    const available = new Set(types || []);
    if (!available.size) return "";
    const skills = player.skills || player;
    const hacking = Number(skills.hacking) || 0;
    const combat = ["strength", "defense", "dexterity", "agility"].reduce((sum, key) => sum + (Number(skills[key]) || 0), 0) / 4;
    const charisma = Number(skills.charisma) || 0;
    const order = focus === "hacking" || hacking >= Math.max(combat, charisma)
        ? ["hacking", "field", "security"]
        : combat >= charisma ? ["security", "field", "hacking"] : ["field", "hacking", "security"];
    return order.find(type => available.has(type)) || [...available][0];
}

export function matchingFactionWork(work, faction, workType = "") {
    return Boolean(work?.type === "FACTION" && work.factionName === faction &&
        (!workType || work.factionWorkType === workType));
}

export function spendableForAugmentation(cash, price, reserve, savings, augmentation) {
    const funds = Number(cash), cost = Number(price), fraction = Number(reserve);
    if (![funds, cost, fraction].every(Number.isFinite) || funds < 0 || cost < 0 || fraction < 0 || fraction > 0.95) return false;
    const matchingGoal = savings?.target === `augmentation:${augmentation}`;
    const protectedFloor = matchingGoal || savings?.inactive ? 0 : Math.max(0, Number(savings?.floor) || 0);
    return funds - cost >= Math.max(funds * fraction, protectedFloor);
}

export function queuedAugmentations(installed, purchased) {
    const have = new Set(installed || []);
    return (purchased || []).filter(name => !have.has(name));
}

export function singularityRecommendation() {
    return "Unlock Singularity by completing BitNode 4, or earn Source-File 4 and return to this BitNode";
}
