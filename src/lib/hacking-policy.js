import { readProgressionSnapshot } from "lib/progression-objective.js";
import { formulaGroup } from "lib/formulas.js";
import { readSavings } from "lib/savings.js";
import { progressionPrograms } from "lib/programs.js";
import { PORTS } from "lib/ports.js";
import { dashboardRow, dashboardTime, dashboardSection } from "lib/dashboard.js";
import { MILESTONE_BALANCE, balanceMilestone, milestoneKey } from "lib/milestone-balance.js";

// Hacking objectives only. No progression service is started/stopped here.
export const HACKING_POLICY = Object.freeze({
	xpTargetLevel: 2500,
	xpEtaHorizonDays: 7,
	severeMoney: 0.25, severeExp: 0.15, severeLevel: 0.40, severeSpeed: 0.25,
	friendly: 1.25,
	minHomeRam: 64, minWorkerRam: 1024, minCash: 100_000_000, cashEntryBuffer: 1.25,
	rescoreMs: 30_000, checkMs: 1000, switchImprovement: 0.05,
	xpPreemptRetryMs: 30_000,
	actionTie: 0.05, tickMs: 250, uiMs: 10_000,
	stableSamples: 3, rateTolerance: 0.25,
});

const MULTIPLIERS = ["ScriptHackMoney", "ScriptHackMoneyGain", "HackExpGain", "HackingLevelMultiplier",
	"HackingSpeedMultiplier", "ServerMaxMoney", "ServerStartingMoney", "ServerGrowthRate", "ServerStartingSecurity"];

export function detectHackingCapabilities(ns) {
	let reset = null, multipliers = null;
	try { reset = ns.getResetInfo(); } catch {}
	// This node check is the API's access rule, never a strategy selection rule.
	if (reset && (reset.currentNode === 5 || Number(reset.ownedSF?.get?.(5)) > 0)) {
		try {
			const values = ns.getBitNodeMultipliers();
			if (MULTIPLIERS.every(key => Number.isFinite(values[key]) && values[key] >= 0)) {
				multipliers = Object.fromEntries(MULTIPLIERS.map(key => [key, values[key]]));
			}
		} catch { /* SF5 is optional, including on older game versions. */ }
	}
	const hacking = formulaGroup(ns, "hacking", ["hackExp", "hackChance", "hackPercent", "hackTime",
		"growTime", "weakenTime", "weakenEffect", "growThreads"]);
	return { currentNode: reset?.currentNode ?? null, formulas: Boolean(hacking),
		bitNodeMultipliers: Boolean(multipliers), multipliers };
}

export function evaluateHackingPolicy({ capabilities, level, bootstrap = [], objective = null, options = HACKING_POLICY }) {
	const m = capabilities.multipliers;
	const result = { mode: "NORMAL", operationalMode: "NORMAL", moneyViability: "UNKNOWN",
		xpViability: "UNKNOWN", overallViability: "UNKNOWN", reason: "BitNode multipliers unavailable",
		capabilities: { formulas: capabilities.formulas, bitNodeMultipliers: capabilities.bitNodeMultipliers },
		currentNode: capabilities.currentNode, multipliers: m, level, targetLevel: options.xpTargetLevel, bootstrap };
    result.targetLevel = Number.isFinite(objective?.requiredHacking) && objective.requiredHacking > 0 ? objective.requiredHacking : options.xpTargetLevel;
    result.objective = objective?.milestone || "capability fallback";
    result.xpAllocation = 0;
    if (capabilities.formulas && objective?.limitingResource === "hacking" && objective.moneyCovered &&
        level < result.targetLevel && !bootstrap.length && (!m || m.HackExpGain > 0)) {
        result.mode = "XP"; result.operationalMode = "MONEY+XP";
        result.xpAllocation = objective.requiredCash === 0 || objective.redPill === "installed" ? MILESTONE_BALANCE.hackingOnlyFallback : MILESTONE_BALANCE.fallback;
        result.reason = objective.milestone + ": hacking " + level + "/" + result.targetLevel + "; cash covered; reduce new money batches to leave XP capacity";
        return result;
    }
	if (!m) return result;
	// These categories describe explicit bottlenecks, not a synthetic throughput score.
	const slow = m.HackingSpeedMultiplier <= options.severeSpeed;
	const weakMoney = m.ScriptHackMoney <= options.severeMoney || m.ScriptHackMoneyGain <= options.severeMoney ||
		m.ServerMaxMoney <= options.severeMoney || m.ServerGrowthRate <= options.severeMoney || slow;
	const weakXp = m.HackExpGain <= options.severeExp || m.HackingLevelMultiplier <= options.severeLevel || slow;
	const friendlyMoney = !weakMoney && (m.ScriptHackMoney >= options.friendly ||
		m.ScriptHackMoneyGain >= options.friendly || m.ServerMaxMoney >= options.friendly);
	result.moneyViability = weakMoney ? "POOR" : friendlyMoney ? "STRONG" : "VIABLE";
	result.xpViability = weakXp ? "POOR" : m.HackExpGain >= options.friendly ? "STRONG" : "VIABLE";
	result.overallViability = weakMoney ? weakXp ? "HOSTILE" : "XP_USEFUL" : "MONEY_USEFUL";
	const evidence = `money=${m.ScriptHackMoney}, cash gain=${m.ScriptHackMoneyGain}, XP=${m.HackExpGain}, level=${m.HackingLevelMultiplier}, speed=${m.HackingSpeedMultiplier}, max money=${m.ServerMaxMoney}, growth=${m.ServerGrowthRate}`;
	if (weakMoney && weakXp) {
		result.mode = "HOSTILE";
		result.reason = `${evidence}; both hacking objectives impaired; NORMAL fallback`;
	} else if (!capabilities.formulas) result.reason = `Formulas.exe unavailable; ${evidence}`;
	else if (bootstrap.length) result.reason = `Bootstrap: ${bootstrap.join("; ")}`;
	else if (weakMoney && !weakXp && level < result.targetLevel) {
		result.mode = "XP"; result.operationalMode = "MONEY+XP";
		result.reason = `${evidence}; spare-RAM XP below level ${result.targetLevel}; money stays primary`;
	} else if (friendlyMoney) {
		result.mode = result.operationalMode = "MONEY";
		result.reason = `Favorable hacking economy; ${evidence}`;
	} else result.reason = `${level >= result.targetLevel ? "XP target reached" : "Preserving money batches"}; ${evidence}`;
	return result;
}

function bootstrapReasons(ns, network, cfg, options, objective = null) {
	const reasons = [];
	if (ns.getServerMaxRam("home") < options.minHomeRam) reasons.push(`home RAM below ${options.minHomeRam} GB`);
	const remoteRam = network.hosts.filter(h => h.name !== "home").reduce((sum, h) => sum + h.maxRam, 0);
	const requiredWorkerRam = objective ? 64 : options.minWorkerRam;
	if (remoteRam < requiredWorkerRam) reasons.push(`worker RAM below ${requiredWorkerRam} GB`);
	const missing = progressionPrograms({ darknet: false, formulas: false }).filter(p => !ns.fileExists(p.name, "home"));
	if (missing.length && !objective) reasons.push(`programs missing: ${missing.map(p => p.name).join(", ")}`);
	let stockFloor = 0;
	const stocks = ns.getPortHandle(PORTS.STOCK_STATUS).peek();
	if (stocks?.type === "stock-status" && stocks.access?.ok && !stocks.dryRun &&
		Date.now() >= stocks.generatedAt && Date.now() - stocks.generatedAt < 30_000 &&
		ns.isRunning(stocks.producerPid)) stockFloor = Math.max(0, Number(stocks.reserveFloor) || 0);
	const floor = Math.max(options.minCash, readSavings(ns).floor, cfg.cloudState?.reserveFloor || 0, stockFloor);
	const required = floor * (cfg.hackingPolicy?.mode === "XP" ? 1 : options.cashEntryBuffer);
	if (ns.getServerMoneyAvailable("home") < required) reasons.push(`cash below reserve/buffer ${required}`);
	return reasons;
}

// Called at a bounded cadence by the existing controller, including while XP work runs.
export function refreshHackingPolicy(ns, cfg, network, force = false) {
	const now = Date.now(), options = cfg.policyOptions || HACKING_POLICY;
	if (!force && now < (cfg.nextPolicyCheck || 0)) return cfg.hackingPolicy;
	cfg.nextPolicyCheck = now + options.checkMs;
	const level = ns.getHackingLevel(), objective = readProgressionSnapshot(ns);
    cfg.progressionObjective = objective;
    const signature = JSON.stringify([milestoneKey(objective), objective?.limitingResource, objective?.moneyCovered, objective?.resetImminent]);
    if (cfg.objectiveSignature !== signature) { force = true; cfg.objectiveSignature = signature; }
	const targetReached = cfg.hackingPolicy?.mode === "XP" && level >= (cfg.hackingPolicy?.targetLevel ?? options.xpTargetLevel);
	if (force || targetReached || !cfg.hackingBaseline || now >= (cfg.nextPolicyScore || 0)) {
		cfg.nextPolicyScore = now + options.rescoreMs;
		const capabilities = detectHackingCapabilities(ns);
		const bootstrap = capabilities.formulas && (capabilities.bitNodeMultipliers || objective) ? bootstrapReasons(ns, network, cfg, options, objective) : [];
		cfg.hackingBaseline = evaluateHackingPolicy({ capabilities, level, bootstrap, objective, options });
	}
	// Capability scoring is slow-cadence; measured rates and their producer
	// timestamps must refresh on every policy tick, including between rescoring.
	cfg.hackingPolicy = { ...cfg.hackingBaseline, generatedAt: now };
	const capabilities = cfg.hackingPolicy.capabilities, bootstrap = cfg.hackingPolicy.bootstrap;
	if (objective && cfg.milestoneEvidence) {
		const policy = cfg.hackingPolicy, evidence = cfg.milestoneEvidence;
		const fresh = evidence.key === milestoneKey(objective) && now >= evidence.generatedAt && now - evidence.generatedAt <= MILESTONE_BALANCE.staleMs;
		const progress = hackingXpProgress(ns, policy, null, options);
		const balance = balanceMilestone(cfg.milestoneController ||= {}, { objective, level,
			remainingXp: progress?.remaining ?? null, cash: fresh ? evidence.cash : null, xp: fresh ? evidence.xp : null,
			scriptXpRate: fresh ? evidence.scriptXpRate : null, baseline: policy.xpAllocation,
			safe: !bootstrap.length && fresh && evidence.safe,
			enabled: capabilities.formulas && (!policy.multipliers || policy.multipliers.HackExpGain > 0),
			now });
		policy.balance = balance;
		policy.xpAllocation = balance.xpAllocation;
		if (balance.xpAllocation > 0) {
			policy.mode = "XP"; policy.operationalMode = "MONEY+XP";
			policy.reason = `${objective.milestone}: ${balance.reason}`;
		} else if (policy.mode === "XP" && balance.requestedXpAllocation > 0) {
			policy.reason = `${objective.milestone}: XP allocation suspended; ${balance.reason}`;
		}
	} else if (!objective) cfg.milestoneController = null;
	if (objective?.resetImminent || objective?.redPill === "queued") {
		cfg.hackingPolicy.mode = cfg.hackingPolicy.operationalMode = "NORMAL";
		cfg.hackingPolicy.xpAllocation = 0;
	}
	return cfg.hackingPolicy;
}

export function hackingXpProgress(ns, policy, rate = null, options = HACKING_POLICY) {
	const api = formulaGroup(ns, "skills", ["calculateExp"]);
	if (!api || !policy?.multipliers) return null;
	try {
		const player = ns.getPlayer();
		const mult = player.mults.hacking * policy.multipliers.HackingLevelMultiplier;
		if (!Number.isFinite(mult) || !(mult > 0)) return null;
		const required = api.calculateExp(policy.targetLevel, mult), current = player.exp.hacking;
		if (![required, current].every(Number.isFinite) || required < 0 || current < 0) return null;
		const remaining = Math.max(0, required - current);
		const eta = remaining === 0 ? 0 : Number.isFinite(rate) && rate > 0 ? remaining / rate * 1000 : null;
		// The inverse skill curve is exponential. A finite result can still be an
		// astronomical projection that assumes today's multipliers forever.
		const horizonDays = options.xpEtaHorizonDays ?? HACKING_POLICY.xpEtaHorizonDays;
		const beyondHorizon = eta !== null && eta > horizonDays * 86_400_000;
		return { level: player.skills.hacking, targetLevel: policy.targetLevel, current, required, remaining,
			skillMultiplier: mult, etaMs: !beyondHorizon && Number.isFinite(eta) ? eta : null,
			etaReason: beyondHorizon ? `beyond ${horizonDays}d forecast at current stats` :
				eta === null ? "unavailable (prep, warmup or unstable rate)" : null };
	} catch { return null; }
}

export function renderHackingPolicy(ns, policy, details = false) {
	if (!policy) return;
	dashboardRow(ns, "Hacking policy", `${policy.mode} | operational ${policy.operationalMode}`);
	dashboardRow(ns, "Policy reason", policy.reason);
	if (policy.transition) dashboardRow(ns, "Policy transition", policy.transition);
	if (policy.balance) renderMilestoneBalance(ns, policy.balance, details);
	if (policy.xp) {
		const xp = policy.xp;
		dashboardRow(ns, "XP pipeline", `${xp.target || "waiting"} | ${xp.action || "-"} | ${xp.state} | unreserved RAM`);
		if (xp.reason) dashboardRow(ns, "XP note", xp.reason);
		if (Number.isFinite(xp.availableRam)) dashboardRow(ns, "XP capacity", `${xp.availableRam.toFixed(1)} GB unreserved | ${xp.workers} workers`);
		if (xp.estimatedXpPerSecond > 0) dashboardRow(ns, "XP model", `${xp.estimatedXpPerSecond.toPrecision(3)}/s | ${xp.ram.toFixed(1)} GB${xp.workers ? "" : " | potential only"}`);
		if (xp.observedTotalXpPerSecond > 0) dashboardRow(ns, "Total XP rate", `${xp.observedTotalXpPerSecond.toPrecision(3)}/s observed from scripts and player work`);
	}
	if (details) {
		dashboardRow(ns, "Viability", `money ${policy.moneyViability} | XP ${policy.xpViability} | ${policy.overallViability}`);
		dashboardRow(ns, "Capabilities", `BN ${policy.currentNode ?? "?"} | Formulas ${policy.capabilities.formulas} | multipliers ${policy.capabilities.bitNodeMultipliers}`);
		if (policy.multipliers) dashboardRow(ns, "Multipliers", JSON.stringify(policy.multipliers));
	}
	if (policy.progress) {
		const p = policy.progress;
		dashboardRow(ns, "XP level", `${p.level} / ${p.targetLevel}`);
		if (Number.isFinite(p.skillMultiplier)) dashboardRow(ns, "XP skill mult", `${p.skillMultiplier.toPrecision(3)}x (player x BitNode)`);
		dashboardRow(ns, "XP progress", `${p.current.toPrecision(3)} / ${p.required.toPrecision(3)} | remaining ${p.remaining.toPrecision(3)}`);
		dashboardRow(ns, "XP ETA", p.etaReason || (Number.isFinite(p.etaMs) ? `~${dashboardTime(p.etaMs)} at recent rate` : "unavailable"));
	}
}

export function renderMilestoneBalance(ns, balance, details = false) {
	const eta = value => Number.isFinite(value) ? `~${dashboardTime(value)}` : "UNKNOWN";
	const amount = value => Number.isFinite(value) ? value.toPrecision(3) : "UNKNOWN";
	dashboardRow(ns, "Milestone ETA", `${balance.milestone} | cash ${eta(balance.cashEtaMs)} | hack ${eta(balance.hackingEtaMs)} | XP ${(balance.xpAllocation * 100).toFixed(0)}%`);
	if (!details) return;
	dashboardSection(ns, "Milestone balance");
	dashboardRow(ns, "Cash goal", `$${amount(balance.currentCash)} / $${amount(balance.requiredCash)} | remaining $${amount(balance.remainingCash)}`);
	dashboardRow(ns, "Hacking goal", `${balance.currentHacking} / ${balance.requiredHacking} | XP remaining ${amount(balance.remainingXp)}`);
	dashboardRow(ns, "Milestone rates", `$${amount(balance.cashRate)}/s | total XP ${amount(balance.xpRate)}/s | script model ${amount(balance.scriptXpRate)}/s`);
	dashboardRow(ns, "XP allocation", `${(balance.previousXpAllocation * 100).toFixed(0)}% -> ${(balance.xpAllocation * 100).toFixed(0)}% | ${balance.reason}`);
	dashboardRow(ns, "ETA evidence", `${balance.confidence} | cash ${balance.cashSource} | XP ${balance.xpSource}`);
}
