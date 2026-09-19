import { buildAugmentationPlan } from "lib/augmentation-plan.js";
import { chooseInvitation, chooseFactionWorkType, matchingFactionWork, queuedAugmentations,
    singularityRecommendation, spendableForAugmentation } from "lib/augmentation-loop.js";
import { readSavings } from "lib/savings.js";
import { PORTS } from "lib/ports.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";

const HOME = "home", STATE_FILE = "data/augmentation-loop-state.json", BOOTSTRAP = "bootstrap.js";

/** Opt-in Singularity augmentation loop. @param {NS} ns */
export async function main(ns) {
    const flags = ns.flags([
        ["port", PORTS.AUGMENTATION_STATUS], ["interval", 5_000], ["focus", "hacking"], ["target", ""],
        ["cash-reserve", 0.10], ["join-factions", true], ["city-faction", ""], ["work", true],
        ["donate", true], ["purchase", true], ["focus-work", false], ["auto-install", false], ["min-install", 5],
    ]);
    ns.disableLog("ALL");
    if (ns.getHostname() !== HOME) throw new Error("Run augmentation-manager.js on home");
    if (ns.ps(HOME).some(process => process.filename === ns.getScriptName() && process.pid !== ns.pid)) {
        throw new Error("Only one augmentation-manager.js may run at a time");
    }
    const cfg = normalizeConfig(flags), port = ns.getPortHandle(cfg.port);
    let state = loadState(ns);

    while (true) {
        let status;
        try {
            const reset = ns.getResetInfo(), epoch = resetEpoch(reset);
            if (state.resetEpoch !== epoch) state = { resetEpoch: epoch, ownedWork: null };
            status = await tickAugmentationLoop(ns, cfg, state);
            await saveState(ns, state);
        } catch (error) {
            status = { state: "ERROR", recommendation: String(error?.message ?? error), error: String(error?.message ?? error) };
        }
        publish(port, ns, cfg, status);
        await ns.sleep(cfg.interval);
    }
}

export async function tickAugmentationLoop(ns, cfg, state) {
    const reset = ns.getResetInfo();
    if (!singularityAvailable(reset)) return { state: "BLOCKED", phase: "UNLOCK", recommendation: singularityRecommendation(), queued: 0 };

    const player = ns.getPlayer(), invitations = ns.singularity.checkFactionInvitations();
    if (cfg.joinFactions) {
        const faction = chooseInvitation(invitations, player.factions, cfg.cityFaction);
        if (faction) {
            const joined = ns.singularity.joinFaction(faction);
            return { state: joined ? "ACTIVE" : "BLOCKED", phase: "JOIN", action: joined ? `Joined ${faction}` : "",
                recommendation: joined ? `Refresh the plan for ${faction}` : `Join ${faction} manually`, queued: queuedCount(ns) };
        }
    }

    const plan = buildAugmentationPlan(ns, { focus: cfg.focus, target: cfg.target, multiplier: 1 });
    if (plan.errors.length) return { state: "BLOCKED", phase: "PLAN", plan,
        recommendation: plan.errors.join("; "), queued: queuedCount(ns) };
    const next = plan.next;
    if (next) return handleNextAugmentation(ns, cfg, state, plan, next);

    const queued = queuedCount(ns);
    let busy = ns.singularity.isBusy();
    let current = ns.singularity.getCurrentWork();
    if (current && ownedCurrentWork(current, state)) {
        ns.singularity.stopAction();
        state.ownedWork = null;
        current = null;
        busy = false;
    }
    if (queued < cfg.minInstall) return { state: "WAITING", phase: "INSTALL", plan, queued,
        recommendation: queued ? `${queued}/${cfg.minInstall} augmentations queued; acquire more before installing`
            : "No matching unowned augmentations from joined factions; unlock or join another faction" };
    if (!cfg.autoInstall) return { state: "READY", phase: "INSTALL", plan, queued,
        recommendation: `${queued} augmentations queued; restart with --auto-install true to install automatically` };
    if (!ns.fileExists(BOOTSTRAP, HOME)) return { state: "BLOCKED", phase: "INSTALL", plan, queued,
        recommendation: `Missing ${BOOTSTRAP}; automatic reset is unsafe` };
    if (busy && !current) return { state: "BLOCKED", phase: "INSTALL", plan, queued,
        recommendation: "Wait for the current Singularity action to finish before automatic installation" };
    if (current && !ownedCurrentWork(current, state)) return { state: "BLOCKED", phase: "INSTALL", plan, queued,
        recommendation: `Finish or stop current ${current.type || "player"} activity before automatic installation` };
    state.ownedWork = null;
    await saveState(ns, state);
    ns.singularity.installAugmentations(BOOTSTRAP);
    return { state: "RESETTING", phase: "INSTALL", action: `Installing ${queued} augmentations`, recommendation: "", queued };
}

function handleNextAugmentation(ns, cfg, state, plan, next) {
    const queued = queuedCount(ns), current = ns.singularity.getCurrentWork(), busy = ns.singularity.isBusy();
    if (next.repGap > 0) {
        const donation = affordableDonation(ns, cfg, next);
        if (donation > 0) {
            const donated = ns.singularity.donateToFaction(next.faction, donation);
            return { state: donated ? "ACTIVE" : "BLOCKED", phase: "DONATE", plan, queued,
                action: donated ? `Donated ${Math.ceil(donation)} to ${next.faction}` : "",
                recommendation: donated ? `Refreshing reputation for ${next.name}` : `Donation to ${next.faction} failed; continuing with faction work` };
        }
        if (!cfg.work) return { state: "WAITING", phase: "REPUTATION", plan, queued,
            recommendation: `Earn ${Math.ceil(next.repGap)} reputation with ${next.faction} for ${next.name}` };
        const types = ns.singularity.getFactionWorkTypes(next.faction);
        const workType = chooseFactionWorkType(types, ns.getPlayer(), cfg.focus);
        if (!workType) return { state: "BLOCKED", phase: "REPUTATION", plan, queued,
            recommendation: `${next.faction} offers no available faction work` };
        if (matchingFactionWork(current, next.faction, workType)) {
            return { state: "ACTIVE", phase: "REPUTATION", plan, queued,
                recommendation: `Working ${workType} for ${next.faction}; ${Math.ceil(next.repGap)} reputation remaining` };
        }
        if (busy && !current) return { state: "BLOCKED", phase: "REPUTATION", plan, queued,
            recommendation: `Wait for the current Singularity action to finish, then work for ${next.faction}` };
        if (current && !ownedCurrentWork(current, state)) return { state: "BLOCKED", phase: "REPUTATION", plan, queued,
            recommendation: `Finish or stop current ${current.type || "player"} activity, then work for ${next.faction}` };
        const started = ns.singularity.workForFaction(next.faction, workType, cfg.focusWork);
        if (started) state.ownedWork = { faction: next.faction, workType };
        return { state: started ? "ACTIVE" : "BLOCKED", phase: "REPUTATION", plan, queued,
            action: started ? `Started ${workType} work for ${next.faction}` : "",
            recommendation: started ? `Earn ${Math.ceil(next.repGap)} reputation for ${next.name}` : `Start ${workType} work for ${next.faction} manually` };
    }

    if (!cfg.purchase) return { state: "READY", phase: "PURCHASE", plan, queued,
        recommendation: `Buy ${next.name} from ${next.faction} for ${Math.ceil(next.price)}` };
    const cash = ns.getServerMoneyAvailable(HOME), savings = readSavings(ns, `augmentation:${next.name}`);
    if (!spendableForAugmentation(cash, next.price, cfg.cashReserve, savings, next.name)) {
        return { state: "WAITING", phase: "FUND", plan, queued,
            recommendation: `Save for ${next.name}: ${Math.ceil(cash)} / ${Math.ceil(next.price)} cash before reserve` };
    }
    const bought = ns.singularity.purchaseAugmentation(next.faction, next.name);
    return { state: bought ? "ACTIVE" : "BLOCKED", phase: "PURCHASE", plan, queued: queued + Number(bought),
        action: bought ? `Purchased ${next.name} from ${next.faction}` : "",
        recommendation: bought ? "Refreshing plan for the next augmentation" : `Purchase of ${next.name} failed; live price or reputation changed` };
}

function ownedCurrentWork(current, state) {
    return Boolean(state.ownedWork && matchingFactionWork(current, state.ownedWork.faction, state.ownedWork.workType));
}

function queuedCount(ns) {
    return queuedAugmentations(ns.singularity.getOwnedAugmentations(false), ns.singularity.getOwnedAugmentations(true)).length;
}

function affordableDonation(ns, cfg, next) {
    if (!cfg.donate || !ns.fileExists("Formulas.exe", HOME) || typeof ns.formulas?.work?.donationForRep !== "function" ||
        typeof ns.getFavorToDonate !== "function") return 0;
    const favor = ns.singularity.getFactionFavor(next.faction);
    if (favor < ns.getFavorToDonate()) return 0;
    const amount = Number(ns.formulas.work.donationForRep(next.repGap, ns.getPlayer()));
    if (!(amount > 0) || !Number.isFinite(amount)) return 0;
    const cash = ns.getServerMoneyAvailable(HOME), savings = readSavings(ns);
    const floor = Math.max(cash * cfg.cashReserve, Math.max(0, Number(savings.floor) || 0));
    return cash - amount - next.price >= floor ? amount : 0;
}

function normalizeConfig(flags) {
    const cfg = {
        port: Number(flags.port), interval: Math.max(1_000, Number(flags.interval) || 5_000),
        focus: String(flags.focus), target: String(flags.target), cashReserve: fraction(flags["cash-reserve"]),
        joinFactions: bool(flags["join-factions"]), cityFaction: String(flags["city-faction"]), work: bool(flags.work), donate: bool(flags.donate),
        purchase: bool(flags.purchase), focusWork: bool(flags["focus-work"]), autoInstall: bool(flags["auto-install"]),
        minInstall: Number(flags["min-install"]),
    };
    if (!Number.isSafeInteger(cfg.port) || cfg.port <= 0 || Object.values(PORTS).filter(p => p !== PORTS.AUGMENTATION_STATUS).includes(cfg.port)) throw new Error("Invalid or reserved augmentation status port");
    if (!["hacking", "all"].includes(cfg.focus)) throw new Error("focus must be hacking or all");
    if (!Number.isSafeInteger(cfg.minInstall) || cfg.minInstall < 1) throw new Error("min-install must be a positive integer");
    return cfg;
}

function publish(port, ns, cfg, status) {
    port.clear();
    port.write({ type: "augmentation-status", version: 1, producerPid: ns.pid, generatedAt: Date.now(),
        heartbeatIntervalMs: cfg.interval, ...status });
}

function loadState(ns) {
    try {
        const value = JSON.parse(ns.read(STATE_FILE) || "null");
        if (value?.version === 1 && typeof value.resetEpoch === "string") return { resetEpoch: value.resetEpoch, ownedWork: value.ownedWork || null };
    } catch {}
    return { resetEpoch: "", ownedWork: null };
}

async function saveState(ns, state) {
    await ns.write(STATE_FILE, JSON.stringify({ version: 1, ...state }), "w");
}

function bool(value) { return typeof value === "boolean" ? value : !["false", "0", "no", "off"].includes(String(value).toLowerCase()); }
function fraction(value) { const n = Number(value), f = n > 1 ? n / 100 : n; return Math.min(.95, Math.max(0, Number.isFinite(f) ? f : .1)); }
