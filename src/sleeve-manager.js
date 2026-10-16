import { PORTS } from "lib/ports.js";
import { sleevesAvailable, sleeveCrimeChoice, sameSleeveTask, sleeveTaskPlan, GANG_KARMA_TARGET } from "lib/sleeve-policy.js";
import { resetEpoch, freshStatus, singularityAvailable, augmentationInstallationPending } from "lib/progression-protocol.js";
import { chooseFactionWorkType } from "lib/augmentation-loop.js";

/** Sleeve tasks; expensive optional purchases live in a separate helper. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const flags = ns.flags([["interval", 5000], ["karma", true], ["budget", .02], ["port", PORTS.SLEEVE_STATUS], ["ticks", 0]]);
    const cfg = normalizeSleeveConfig(flags);
    if (ns.getHostname() !== "home") throw new Error("Run sleeve-manager.js on home");
    if (ns.ps("home").some(p => p.filename === "sleeve-manager.js" && p.pid !== ns.pid)) throw new Error("Sleeve manager already running");
    const state = {}, port = ns.getPortHandle(cfg.port);
    for (let tick = 0; !cfg.ticks || tick < cfg.ticks; tick++) {
        let status;
        try { status = sleeveTick(ns, cfg, state); }
        catch (error) { status = { state: "ERROR", recommendation: String(error?.message || error) }; }
        port.clear(); port.write({ ...status, type: "sleeve-status", version: 1, producerPid: ns.pid,
            generatedAt: Date.now(), heartbeatIntervalMs: cfg.interval, resetEpoch: resetEpoch(ns.getResetInfo()) });
        ns.clearLog(); ns.print(`SLEEVES ${status.state} | ${status.recommendation}`);
        if (!cfg.ticks || tick + 1 < cfg.ticks) await ns.sleep(cfg.interval);
    }
}

export function normalizeSleeveConfig(flags) {
    const cfg = { interval: Number(flags.interval), karma: ![false, "false", 0, "0"].includes(flags.karma),
        budget: Number(flags.budget), port: Number(flags.port), ticks: Number(flags.ticks) };
    if (!Number.isFinite(cfg.interval) || cfg.interval < 1000 || !Number.isFinite(cfg.budget) || cfg.budget < 0 || cfg.budget > .1 ||
        !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 20 || !Number.isInteger(cfg.ticks) || cfg.ticks < 0)
        throw new Error("Sleeves require interval >=1000, budget 0..0.1, port 1..20, and nonnegative integer ticks");
    return cfg;
}

export function sleeveTick(ns, cfg, state = {}) {
    const reset = ns.getResetInfo(), epoch = resetEpoch(reset);
    if (!sleevesAvailable(reset)) return { state: "LOCKED", recommendation: "Sleeves require BN10 or SF10" };
    if (state.epoch !== epoch) { state.epoch = epoch; state.crimes = null; state.retry = {}; state.nextUpgrade = 0; }
    const augmentation = sleeveServiceStatus(ns, PORTS.AUGMENTATION_STATUS, "augmentation-status", "augmentation-manager.js");
    if (augmentationInstallationPending(augmentation)) return { state: "INSTALLING", recommendation: "Augmentation installation pending; sleeve changes paused" };
    const gang = sleeveServiceStatus(ns, PORTS.GANG_STATUS, "gang-status", "gang-manager.js");
    const karma = ns.heart.break();
    const karmaNeeded = cfg.karma && reset.currentNode !== 2 && Number(reset.ownedSF?.get?.(2)) > 0 && !gang?.inGang && karma > GANG_KARMA_TARGET;
    if (!state.crimes) {
        state.crimes = singularityAvailable(reset) ? Object.values(ns.enums.CrimeType).map(name => ({ ...ns.singularity.getCrimeStats(name), name })) : [];
    }
    // Reuse the authenticated producer's multiplier instead of charging another
    // 4 GB during bootstrap. Standard BN10 has a 1x crime-success multiplier;
    // BN14 is the only standard node with a different default in game 3.0.1.
    const nodeSuccess = augmentation?.progression?.multipliers?.CrimeSuccessRate ?? (reset.currentNode === 14 ? .4 : 1);
    const count = ns.sleeve.getNumSleeves(), rows = Array.from({ length: count }, (_, index) => ({ index, sleeve: ns.sleeve.getSleeve(index) }));
    const best = [...rows].sort((a, b) => b.sleeve.sync * (100 - b.sleeve.shock) - a.sleeve.sync * (100 - a.sleeve.shock))[0]?.index;
    const next = augmentation?.plan?.next;
    const faction = next?.repGap > 0 && !next.passiveReputation && next.faction !== gang?.faction && ns.getPlayer().factions.includes(next.faction) ? next.faction : null;
    const factionTypes = faction && singularityAvailable(reset) ? ns.singularity.getFactionWorkTypes(faction) : ["hacking"];
    const hacking = augmentation?.progression?.limitingResource === "hacking";
    const reports = [];
    for (const { index, sleeve } of rows) {
        const crime = sleeveCrimeChoice(sleeve, state.crimes, karmaNeeded, nodeSuccess);
        const factionWorkType = chooseFactionWorkType(factionTypes, sleeve, "all");
        const wanted = sleeveTaskPlan(sleeve, { karmaNeeded, crime, faction, factionWorkType, hacking, support: index === best });
        const current = ns.sleeve.getTask(index), key = JSON.stringify(wanted);
        let error = state.retry[index]?.key === key ? state.retry[index].error || "" : "";
        if (!sameSleeveTask(current, wanted) && !(state.retry[index]?.key === key && Date.now() < state.retry[index].at)) {
            try {
                if (!assignSleeve(ns, index, wanted)) throw new Error("Task rejected by game");
                delete state.retry[index];
                error = "";
            } catch (failure) {
                error = String(failure?.message || failure);
                state.retry[index] = { key, at: Date.now() + 60000, error };
                // An unavailable faction task must not leave a sleeve idle forever.
                ns.sleeve.setToCommitCrime(index, crime?.name || "Mug");
            }
        }
        const task = ns.sleeve.getTask(index);
        // Game 3.0.1 tasks include a nextCompletion Promise. Ports use
        // structuredClone, so publish only scalar task data, never the API object.
        const taskReport = task ? { type: task.type, crimeType: task.crimeType, factionName: task.factionName,
            factionWorkType: task.factionWorkType, classType: task.classType, location: task.location,
            cyclesWorked: task.cyclesWorked, cyclesNeeded: task.cyclesNeeded, tasksCompleted: task.tasksCompleted } : null;
        reports.push({ index, shock: sleeve.shock, sync: sleeve.sync, memory: sleeve.memory, task: taskReport,
            karmaPerSecond: karmaNeeded && task?.type === "CRIME" && task.crimeType === crime?.name ? crime.rate : 0, error });
    }
    if (cfg.budget > 0 && Date.now() >= state.nextUpgrade) {
        state.nextUpgrade = Date.now() + 60000;
        const helper = "sleeve-upgrades.js", cost = ns.getScriptRam(helper, "home");
        const policy = ns.getPortHandle(PORTS.HOME_CAPACITY).peek();
        const reserve = policy?.resetEpoch === epoch && policy?.type === "home-capacity-policy" ? Math.max(32, Number(policy.reserve) || 0) : 32;
        if (cost > 0 && !ns.ps("home").some(p => p.filename === helper) && ns.getServerMaxRam("home") - ns.getServerUsedRam("home") >= cost + reserve)
            ns.run(helper, 1, JSON.stringify({ ownerPid: ns.pid, resetEpoch: epoch, createdAt: Date.now(), budget: cfg.budget }));
    }
    const rate = reports.reduce((sum, row) => sum + row.karmaPerSecond, 0);
    return { state: "ACTIVE", count, sleeves: reports, karma, karmaNeeded, karmaPerSecond: rate,
        karmaEtaMs: karmaNeeded && rate > 0 ? (karma - GANG_KARMA_TARGET) / rate * 1000 : null,
        recommendation: karmaNeeded ? "Building gang karma; synchronization below 10 first, then success-weighted crimes"
            : "Supporting the current milestone; remaining sleeves synchronize, recover shock, then earn money" };
}

function assignSleeve(ns, index, task) {
    if (task.type === "SYNCHRO") return ns.sleeve.setToSynchronize(index);
    if (task.type === "RECOVERY") return ns.sleeve.setToShockRecovery(index);
    if (task.type === "FACTION") return ns.sleeve.setToFactionWork(index, task.factionName, task.factionWorkType);
    if (task.type === "CLASS") return ns.sleeve.setToUniversityCourse(index, task.location, task.classType);
    return ns.sleeve.setToCommitCrime(index, task.crimeType);
}

export function sleeveServiceStatus(ns, port, type, script) {
    const status = ns.getPortHandle(port).peek();
    return freshStatus(status, type) && status.resetEpoch === resetEpoch(ns.getResetInfo()) &&
        ns.ps("home").some(p => p.filename === script && p.pid === status.producerPid) ? status : null;
}
