import { PORTS } from "lib/ports.js";

export const GANG_FACTIONS = Object.freeze(["NiteSec", "The Black Hand", "Slum Snakes", "Tetrads", "The Syndicate", "The Dark Army", "Speakers for the Dead"]);
const STATS = ["hack", "str", "def", "dex", "agi", "cha"];

export function gangAvailable(reset) {
    return reset?.currentNode === 2 || Number(reset?.ownedSF?.get?.(2) ?? reset?.ownedSF?.[2] ?? 0) > 0;
}

export function normalizeGangConfig(flags = {}) {
    const cfg = { faction: String(flags.faction ?? "auto"), budget: Number(flags.budget ?? .05),
        interval: Number(flags.interval ?? 2000), ticks: Number(flags.ticks ?? 0), port: Number(flags.port ?? PORTS.GANG_STATUS) };
    if (cfg.faction !== "auto" && !GANG_FACTIONS.includes(cfg.faction)) throw new Error("Unknown gang faction");
    if (!Number.isFinite(cfg.budget) || cfg.budget < 0 || cfg.budget > 1) throw new Error("budget must be between 0 and 1");
    if (!Number.isFinite(cfg.interval) || cfg.interval < 1000 || cfg.interval > 10000) throw new Error("interval must be 1000–10000ms");
    if (!Number.isSafeInteger(cfg.ticks) || cfg.ticks < 0) throw new Error("ticks must be a nonnegative integer");
    if (!Number.isSafeInteger(cfg.port) || cfg.port < 1 || cfg.port > 20 ||
        Object.values(PORTS).filter(port => port !== PORTS.GANG_STATUS).includes(cfg.port)) throw new Error("port must be an unreserved port or GANG_STATUS");
    return cfg;
}

export function gangCreationFaction(factions, requested = "auto") {
    return (requested === "auto" ? GANG_FACTIONS.slice(0, 2) : [requested]).find(name => factions.includes(name)) || "";
}

export function gangTrainingTask(member, hacking) {
    const core = hacking ? ["hack"] : ["str", "def", "dex", "agi"];
    const trained = core.every(stat => Number(member[stat]) >= Math.min(1000, 100 * Math.sqrt(Number(member[stat + "_asc_mult"]) || 1)));
    if (!trained) return hacking ? "Train Hacking" : "Train Combat";
    if (Number(member.cha) < 30) return "Train Charisma";
    return "";
}

// Per-200ms-cycle estimates using the public task weights and live member stats.
// Verified against official stable src/Gang/formulas/formulas.ts. GangSoftcap is
// 1 in BN2; callers may calibrate it from live gains in other BitNodes.
export function gangTaskGains(gang, member, task, softcap = 1) {
    const weight = STATS.reduce((sum, stat) => sum + (Number(task[stat + "Weight"]) || 0) * (Number(member[stat]) || 0) / 100, 0);
    const difficulty = Number(task.difficulty) || 0, territory = Math.max(0, Number(gang.territory) || 0);
    const penalty = Math.max(0, Number(gang.respect) || 0) / Math.max(1, (Number(gang.respect) || 0) + (Number(gang.wantedLevel) || 0));
    const exponent = (.8 + .2 * territory) * softcap;
    const territoryFor = kind => Math.max(.005, Math.pow(territory * 100, Number(task.territory?.[kind] ?? 1)) / 100);
    const gain = (kind, coefficient, difficultyWeight) => {
        const base = Number(task[kind === "money" ? "baseMoney" : "baseRespect"]) || 0;
        const stat = weight - difficultyWeight * difficulty;
        return base > 0 && stat > 0 ? Math.pow(coefficient * base * stat * territoryFor(kind) * penalty, exponent) : 0;
    };
    const wantedStat = weight - 3.5 * difficulty, baseWanted = Number(task.baseWanted) || 0;
    const wanted = wantedStat <= 0 || baseWanted === 0 ? 0 : baseWanted < 0
        ? .4 * baseWanted * wantedStat * territoryFor("wanted")
        : Math.min(100, 7 * baseWanted / Math.pow(3 * wantedStat * territoryFor("wanted"), .8));
    return { money: gain("money", 5, 3.2), respect: gain("respect", 11, 4), wanted };
}

export function planGangTasks(gang, members, tasks, reputationGoal = false, softcap = 1, growth = []) {
    tasks = tasks.filter(task => gang.isHacking ? task.isHacking !== false : task.isCombat !== false);
    const productive = tasks.filter(task => task.baseMoney > 0 || task.baseRespect > 0);
    const reducing = tasks.filter(task => task.baseWanted < 0);
    const respectWeight = members.length < 12 || reputationGoal ? .85 : .35;
    const rows = members.map(member => {
        const training = gangTrainingTask(member, gang.isHacking) || (growth.includes(member.name) ? gang.isHacking ? "Train Hacking" : "Train Combat" : "");
        const jobs = productive.map(task => ({ task: task.name, ...gangTaskGains(gang, member, task, softcap) }));
        const justice = reducing.map(task => ({ task: task.name, ...gangTaskGains(gang, member, task, softcap) })).sort((a, b) => a.wanted - b.wanted)[0];
        const bestMoney = Math.max(1e-12, ...jobs.map(job => job.money)), bestRespect = Math.max(1e-12, ...jobs.map(job => job.respect));
        for (const job of jobs) {
            job.score = respectWeight * job.respect / bestRespect + (1 - respectWeight) * job.money / bestMoney;
        }
        jobs.sort((a, b) => b.score - a.score || b.respect - a.respect);
        const selected = !training && jobs.find(job => job.respect > 0 || job.money > 0);
        const alternatives = jobs.filter(job => job.respect > 0 || job.money > 0);
        if (justice && !alternatives.some(job => job.task === justice.task)) alternatives.push({ ...justice, score: 0 });
        return { name: member.name, ...(selected || { task: training || (gang.isHacking ? "Train Hacking" : "Train Combat"), money: 0, respect: 0, wanted: 0, score: 0 }), alternatives, training: Boolean(training) };
    });
    const recovering = gang.wantedLevel > 1 && gang.wantedPenalty < .95;
    const pressure = row => row.wanted - (recovering ? 0 : row.respect * (.05 / .95));
    // Allow wanted to grow only while respect keeps its penalty below 5%.
    // At the wanted floor of one we must keep earning respect, even with a .5 penalty.
    // Downgrade expensive crimes before using suppression. Replacing every
    // unsuitable producer with justice can strand almost the entire gang there.
    for (let i = 0; i < rows.length * (tasks.length + 1); i++) {
        if (rows.reduce((sum, row) => sum + pressure(row), 0) <= 1e-10) break;
        const producers = rows.filter(row => row.respect > 0).length;
        const options = rows.flatMap(row => row.training ? [] : row.alternatives.filter(job =>
            pressure(job) < pressure(row) - 1e-10 && (recovering || producers > 1 || row.respect <= 0 || job.respect > 0))
            .map(job => ({ row, job, cost: (row.score - job.score) / (pressure(row) - pressure(job)) })));
        options.sort((a, b) => a.cost - b.cost || b.job.respect - a.job.respect);
        if (!options.length) break;
        Object.assign(options[0].row, options[0].job);
    }
    return rows.map(({ alternatives, score, ...row }) => row);
}

export function gangAscensionCandidate(gang, members, results, lastAscensionAt, now) {
    if (members.length < 3 || (lastAscensionAt != null && now - lastAscensionAt < 60000) || gang.wantedPenalty < .95) return null;
    if (members.filter(member => !gangTrainingTask(member, gang.isHacking)).length < 3) return null;
    const stats = gang.isHacking ? ["hack"] : ["str", "def", "dex", "agi"];
    return members.map(member => {
        const result = results[member.name];
        const multiplier = result ? Math.pow(stats.reduce((n, stat) => n * (Number(result[stat]) || 1), 1), 1 / stats.length) : 0;
        const lost = Number(result?.respect);
        return { name: member.name, multiplier, lost, threshold: gangAscensionThreshold(member, gang.isHacking) };
    }).filter(row => row.multiplier >= row.threshold && Number.isFinite(row.lost) && row.lost >= 0 && row.lost <= gang.respect * (members.length < 12 ? .25 : .15) &&
        gang.respect - row.lost >= Math.max(1, gang.wantedLevel * 19))
        .sort((a, b) => b.multiplier - a.multiplier || a.lost - b.lost)[0] || null;
}

export function gangAscensionThreshold(member, hacking) {
    const stats = hacking ? ["hack"] : ["str", "def", "dex", "agi"];
    const current = Math.pow(stats.reduce((n, stat) => n * Math.max(1, Number(member[stat + "_asc_mult"]) || 1), 1), 1 / stats.length);
    return Math.max(1.1, 1 + .5 / Math.sqrt(current));
}

// Equipment raises displayed skills without adding ascension experience. Keep a
// bounded growth rotation after basic training instead of parking those members
// on low-XP jobs indefinitely. Novice training counts against the same slots.
export function gangGrowthMembers(gang, members, results, tasks = [], production = []) {
    if (members.length < 3 || gang.wantedPenalty < .95) return [];
    const basic = members.filter(member => gangTrainingTask(member, gang.isHacking)).length;
    const slots = Math.max(0, Math.min(Math.floor(members.length / 3), members.length - 2) - basic);
    const stats = gang.isHacking ? ["hack"] : ["str", "def", "dex", "agi"];
    const geometric = values => Math.pow(values.reduce((n, v) => n * v, 1), 1 / values.length);
    const training = tasks.find(task => task.name === (gang.isHacking ? "Train Hacking" : "Train Combat"));
    const xpWeight = task => task ? stats.reduce((sum, stat) => sum + (Number(task[stat + "Weight"]) || 0), 0) * Math.pow(task.difficulty, .9) : 0;
    return members.filter(member => !gangTrainingTask(member, gang.isHacking) &&
        stats.every(stat => Number.isFinite(member[stat + "_exp"])) &&
        // Productive high-tier crimes already build ascension XP. Do not tax
        // their reputation output for a marginal training-speed improvement.
        (!training || xpWeight(training) > 2 * xpWeight(tasks.find(task => task.name === production.find(row => row.name === member.name)?.task))))
        .map(member => {
        const result = results[member.name];
        return { name: member.name, current: geometric(stats.map(stat => Math.max(1, Number(member[stat + "_asc_mult"]) || 1))),
            ready: result && geometric(stats.map(stat => Number(result[stat]) || 1)) >= gangAscensionThreshold(member, gang.isHacking) };
    }).filter(member => !member.ready).sort((a, b) => a.current - b.current || a.name.localeCompare(b.name))
        .slice(0, slots).map(member => member.name);
}

export function usefulGangEquipment(stats, hacking) {
    return (hacking ? ["hack"] : ["str", "def", "dex", "agi"]).some(stat => Number(stats?.[stat]) > 1);
}
