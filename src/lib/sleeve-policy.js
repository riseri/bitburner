export const GANG_KARMA_TARGET = -54000;

export function sleevesAvailable(reset) {
    return reset.currentNode === 10 || Number(reset.ownedSF?.get?.(10)) > 0;
}

// Exact success formula from the installed game's Crime.successRate (3.0.1).
// Stats and rewards come from the live API; shock reduces income/XP, not karma.
export function sleeveCrimeChoice(sleeve, crimes, karma = true, nodeSuccess = 1) {
    const skills = sleeve.skills, intelligence = Math.max(0, skills.intelligence || 0);
    return crimes.map(crime => {
        const weighted = ["hacking", "strength", "defense", "dexterity", "agility", "charisma"]
            .reduce((sum, key) => sum + (skills[key] || 0) * (crime[key + "_success_weight"] || 0), .025 * intelligence);
        const chance = Math.min(1, Math.max(0, weighted / 975 / crime.difficulty *
            (sleeve.mults.crime_success || 1) * nodeSuccess * (1 + intelligence ** .8 / 600)));
        const rate = chance * (karma ? crime.karma * sleeve.sync / 100 : crime.money * (100 - sleeve.shock) / 100) / (crime.time / 1000);
        return { name: crime.name, chance, rate };
    }).filter(row => Number.isFinite(row.rate)).sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name))[0] || null;
}

export function sameSleeveTask(task, wanted) {
    return task?.type === wanted.type && (wanted.type !== "CRIME" || task.crimeType === wanted.crimeType) &&
        (wanted.type !== "FACTION" || task.factionName === wanted.factionName && task.factionWorkType === wanted.factionWorkType) &&
        (wanted.type !== "CLASS" || task.classType === wanted.classType && task.location === wanted.location);
}

export function sleeveTaskPlan(sleeve, { karmaNeeded, crime, faction = null, factionWorkType = "hacking", hacking = false, support = false }) {
    // Don't demand 100 sync or zero shock before karma: either can take hours.
    if (sleeve.sync < 10) return { type: "SYNCHRO" };
    if (karmaNeeded) return { type: "CRIME", crimeType: crime?.name || "Homicide" };
    if (support && sleeve.shock < 90) {
        if (faction && factionWorkType) return { type: "FACTION", factionName: faction, factionWorkType };
        const university = { "Sector-12": "Rothman University", Aevum: "Summit University", Volhaven: "ZB Institute of Technology" }[sleeve.city];
        if (hacking && university) return { type: "CLASS", classType: "Computer Science", location: university };
    }
    if (sleeve.shock >= 90) return { type: "RECOVERY" };
    if (sleeve.sync < 100) return { type: "SYNCHRO" };
    if (sleeve.shock > 0) return { type: "RECOVERY" };
    return { type: "CRIME", crimeType: crime?.name || "Mug" };
}
