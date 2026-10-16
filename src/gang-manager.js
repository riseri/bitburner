import { PORTS } from "lib/ports.js";
import { readSavings } from "lib/savings.js";
import { resetEpoch, freshStatus, augmentationInstallationPending } from "lib/progression-protocol.js";
import { gangAvailable, normalizeGangConfig, gangCreationFaction, planGangTasks, gangAscensionCandidate, gangGrowthMembers, usefulGangEquipment } from "lib/gang-policy.js";

/** Home service for BN2/SF2 gangs; joining factions belongs to progression. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    let cfg;
    try {
        cfg = normalizeGangConfig(ns.flags([["faction", "auto"], ["budget", .05], ["interval", 2000], ["ticks", 0], ["port", PORTS.GANG_STATUS]]));
        if (ns.getHostname() !== "home") throw new Error("Run gang-manager.js on home only");
        if (ns.ps("home").some(process => process.filename === ns.getScriptName() && process.pid !== ns.pid)) throw new Error("Only one gang-manager.js may run at a time");
    } catch (error) { ns.tprint(`Gang manager stopped: ${String(error?.message || error)}`); return; }
    const state = {}, port = ns.getPortHandle(cfg.port);
    for (let tick = 0; !cfg.ticks || tick < cfg.ticks; tick++) {
        let status;
        try { status = gangTick(ns, cfg, state); }
        catch (error) { status = { state: "ERROR", inGang: false, error: String(error?.message || error), recommendation: "Retrying gang management on the next cycle" }; }
        const report = { ...status, type: "gang-status", version: 1, producerPid: ns.pid, generatedAt: Date.now(),
            heartbeatIntervalMs: cfg.interval, resetEpoch: resetEpoch(ns.getResetInfo()) };
        port.clear(); port.write(report);
        ns.clearLog(); ns.print(`GANG ${report.state} | ${report.faction || "No gang"} | ${report.memberCount || 0}/12 members`);
        ns.print(report.recommendation || "Recruiting, training, and earning faction reputation");
        if (report.error) ns.print(report.error);
        if (!cfg.ticks || tick + 1 < cfg.ticks) await ns.sleep(cfg.interval);
    }
}

export function gangTick(ns, cfg, state = {}) {
    const reset = ns.getResetInfo(), epoch = resetEpoch(reset), now = Date.now();
    if (state.epoch !== epoch) { state.epoch = epoch; delete state.lastAscensionAt; delete state.equipmentBudget; delete state.equipmentBudgetAt; }
    if (!gangAvailable(reset)) return { state: "LOCKED", inGang: false, recommendation: "Gang automation requires BN2 or Source-File 2" };
    if (!ns.gang.inGang()) {
        const faction = gangCreationFaction(ns.getPlayer().factions, cfg.faction);
        if (!faction) return { state: "WAITING", inGang: false, recommendation: cfg.faction === "auto"
            ? "Waiting to join NiteSec or The Black Hand through progression" : `Waiting to join ${cfg.faction}` };
        const karma = reset.currentNode !== 2 && typeof ns.heart?.break === "function" ? ns.heart.break() : null;
        if (Number.isFinite(karma) && karma > -54000) return { state: "WAITING", inGang: false, karma, karmaRemaining: 54000 + karma,
            recommendation: `Gang karma ${Math.round(karma)} / -54000; sleeves and bounded player crime build access while augmentations continue` };
        if (!ns.gang.createGang(faction)) return { state: "WAITING", inGang: false, recommendation: `Waiting for ${faction} gang access${reset.currentNode === 2 ? "" : " (outside BN2, karma must be at most -54000)"}` };
    }
    let gang = ns.gang.getGangInformation();
    if (gang.territoryWarfareEngaged) ns.gang.setTerritoryWarfare(false);
    let members = ns.gang.getMemberNames().map(name => ns.gang.getMemberInformation(name));
    // Remove existing warfare assignments immediately: clash chance takes time to decay.
    for (const member of members) if (member.task === "Territory Warfare") {
        ns.gang.setMemberTask(member.name, gang.isHacking ? "Train Hacking" : "Train Combat");
    }
    const actions = [];
    for (let count = 0; count < 12 && members.length < 12 && ns.gang.canRecruitMember(); count++) {
        const used = new Set(members.map(member => member.name));
        let index = 1; while (used.has(`member-${String(index).padStart(2, "0")}`)) index++;
        const name = `member-${String(index).padStart(2, "0")}`;
        if (!ns.gang.recruitMember(name)) break;
        members.push(ns.gang.getMemberInformation(name)); actions.push(`Recruited ${name}`);
    }
    const augmentation = liveAugmentationStatus(ns, epoch, now);
    const installing = augmentationInstallationPending(augmentation);
    const reputationGoal = augmentation?.next?.faction === gang.faction && Number(augmentation?.next?.repGap) > 0 ||
        augmentation?.plan?.next?.faction === gang.faction && Number(augmentation?.plan?.next?.repGap) > 0;
    const next = augmentation?.plan?.next || augmentation?.next;
    const closeToPurchase = next?.faction === gang.faction && next.repGap > 0 && next.rate > 0 && next.repGap / next.rate <= 120;
    if (!installing) {
        const results = Object.fromEntries(members.map(member => [member.name, ns.gang.getAscensionResult(member.name)]));
        const candidate = !closeToPurchase && gangAscensionCandidate(gang, members, results, state.lastAscensionAt, now);
        if (candidate && ns.gang.ascendMember(candidate.name)) { state.lastAscensionAt = now; actions.push(`Ascended ${candidate.name}`); }
        gang = ns.gang.getGangInformation();
        members = ns.gang.getMemberNames().map(name => ns.gang.getMemberInformation(name));
        buyEquipment(ns, cfg, gang, members, actions, state, now);
        members = ns.gang.getMemberNames().map(name => ns.gang.getMemberInformation(name));
    }
    const tasks = ns.gang.getTaskNames().map(name => ns.gang.getTaskStats(name));
    const production = planGangTasks(gang, members, tasks, reputationGoal);
    const growth = installing || closeToPurchase ? [] : gangGrowthMembers(gang, members,
        Object.fromEntries(members.map(member => [member.name, ns.gang.getAscensionResult(member.name)])), tasks, production);
    const assignments = growth.length ? planGangTasks(gang, members, tasks, reputationGoal, 1, growth) : production;
    for (const assignment of assignments) {
        const member = members.find(row => row.name === assignment.name);
        if (member.task !== assignment.task && !ns.gang.setMemberTask(assignment.name, assignment.task)) throw new Error(`Could not assign ${assignment.name} to ${assignment.task}`);
    }
    gang = ns.gang.getGangInformation();
    const taskCounts = {};
    for (const assignment of assignments) taskCounts[assignment.task] = (taskCounts[assignment.task] || 0) + 1;
    const ascensions = members.map(member => gang.isHacking ? Number(member.hack_asc_mult) || 1 :
        Math.pow(["str", "def", "dex", "agi"].reduce((n, stat) => n * (Number(member[stat + "_asc_mult"]) || 1), 1), .25));
    return { state: installing ? "INSTALLING" : "ACTIVE", inGang: true, faction: gang.faction, isHacking: gang.isHacking,
        memberCount: members.length, respect: gang.respect, wantedLevel: gang.wantedLevel, wantedPenalty: gang.wantedPenalty,
        incomePerSecond: Math.max(0, Number(gang.moneyGainRate) || 0) * 5,
        respectPerSecond: Math.max(0, Number(gang.respectGainRate) || 0) * 5,
        wantedPerSecond: (Number(gang.wantedLevelGainRate) || 0) * 5,
        territory: gang.territory, warfare: false, clashChance: gang.territoryClashChance,
        tasks: taskCounts, actions, growthMembers: growth, equipmentBudget: state.equipmentBudget || 0,
        ascensionRange: ascensions.length ? [Math.min(...ascensions), Math.max(...ascensions)] : [],
        growthReason: installing ? "Installation pending" : closeToPurchase ? "Finishing a reputation goal within two minutes" : "Up to one third training for ascension; remaining members produce",
        savingsFloor: readSavings(ns).floor,
        recommendation: installing ? "Preparing augmentation installation; equipment and ascensions paused"
            : `${gang.isHacking ? "Hacking" : "Combat"} gang earning money and faction reputation; warfare disabled` };
}

function liveAugmentationStatus(ns, epoch, now) {
    const status = ns.getPortHandle(PORTS.AUGMENTATION_STATUS).peek();
    if (!freshStatus(status, "augmentation-status", now) || status.resetEpoch !== epoch ||
        !ns.ps("home").some(process => process.pid === status.producerPid && process.filename === "augmentation-manager.js")) return null;
    return status;
}

function buyEquipment(ns, cfg, gang, members, actions, state, now) {
    const spare = Math.max(0, ns.getServerMoneyAvailable("home") - readSavings(ns).floor);
    const elapsed = state.equipmentBudgetAt == null ? 1 : Math.max(0, Math.min(1, (now - state.equipmentBudgetAt) / cfg.interval));
    let budget = cfg.budget > 0 ? Math.min(spare, (state.equipmentBudget || 0) + spare * cfg.budget * elapsed) : 0;
    state.equipmentBudget = budget; state.equipmentBudgetAt = now;
    if (!(budget > 0)) return;
    const equipment = ns.gang.getEquipmentNames().filter(name => usefulGangEquipment(ns.gang.getEquipmentStats(name), gang.isHacking))
        .map(name => ({ name, cost: ns.gang.getEquipmentCost(name) })).sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
    let purchases = 0;
    for (const item of equipment) for (const member of members) {
        if (purchases >= 12) return;
        if (member.upgrades.includes(item.name) || member.augmentations.includes(item.name)) continue;
        const cost = ns.gang.getEquipmentCost(item.name), cash = ns.getServerMoneyAvailable("home");
        if (!Number.isFinite(cost) || cost < 0 || cost > budget || cost > cash - readSavings(ns).floor) continue;
        // Re-read reset-scoped installation intent before every irreversible purchase.
        if (augmentationInstallationPending(liveAugmentationStatus(ns, resetEpoch(ns.getResetInfo()), Date.now()))) return;
        if (ns.gang.purchaseEquipment(member.name, item.name)) { budget -= cost; state.equipmentBudget = budget; purchases++; actions.push(`Bought ${item.name} for ${member.name}`); }
    }
}
