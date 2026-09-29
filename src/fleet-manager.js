import { readSavings } from "lib/savings.js";
import { readProgressionSnapshot } from "lib/progression-objective.js";
import { evaluateFleetInvestment, fleetCapacityPolicy } from "lib/fleet-economics.js";
import { fleetInvestmentTarget } from "lib/fleet-capital.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { PORTS } from "lib/ports.js";

const HOME = "home";
const HACK = "jit-hack.js";
const GROW = "jit-grow.js";
const WEAKEN = "jit-weaken.js";
const WORKERS = [HACK, GROW, WEAKEN, "share-worker.js", "lib/jit-worker.js", "background-grow.js", "background-weaken.js"];
const SURPLUS_COST_MULTIPLE = 4;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["port", PORTS.FLEET_STATUS],
		["cloud", true],
		["cloud-roi", true],
		["cloud-payback", 1800],
		["cloud-reserve", 0.10],
		["cloud-cash-floor", 0],
		["cloud-max-action", 0.25],
		["cloud-min-ram", 8],
		["cloud-prefix", "cloud"],
		["cloud-interval", 5_000],
		["root-interval", 30_000],
		["stock-port", PORTS.STOCK_STATUS],
	]);

	ns.disableLog("ALL");

	const cfg = {
		port: Number(flags.port),
		cloud: {
			enabled: asBoolean(flags.cloud),
			roi: asBoolean(flags["cloud-roi"]),
			payback: Math.max(1, Number(flags["cloud-payback"]) || 1800),
			cashReserve: clampFraction(flags["cloud-reserve"], 0.95),
			cashFloor: Math.max(0, Number(flags["cloud-cash-floor"]) || 0),
			maxAction: clampFraction(flags["cloud-max-action"], 1),
			minRam: normalizeCloudRam(Number(flags["cloud-min-ram"])),
			prefix: String(flags["cloud-prefix"] ?? "cloud").trim() || "cloud",
		},
		cloudInterval: Math.max(1_000, Number(flags["cloud-interval"]) || 5_000),
		rootInterval: Math.max(10_000, Number(flags["root-interval"]) || 30_000),
		stockPort: Number(flags["stock-port"]),
	};
	if (!Number.isSafeInteger(cfg.stockPort) || cfg.stockPort <= 0 || cfg.stockPort === cfg.port) {
		throw new Error("stock-port must be a positive port distinct from fleet status");
	}

	for (const script of WORKERS) {
		if (!ns.fileExists(script, HOME)) {
			ns.tprint(`ERROR: fleet-manager missing ${script}`);
			return;
		}
	}

	const port = ns.getPortHandle(cfg.port);
	const state = createState(cfg);
	let lastCloudAction = 0;
	let lastRootPass = 0;
	// A heartbeat is not a usable network snapshot. Publish null until discovery
	// completes so the JIT reader retains its previous fleet during startup.
	let networkState = null;
	let lastHeartbeatAt = 0;
	const pulse = (force = false) => {
		if (!force && Date.now() - lastHeartbeatAt < 5_000) return;
		lastHeartbeatAt = Date.now();
		port.clear();
		port.write({ type: "fleet-status", generatedAt: Date.now(), producerPid: ns.pid,
			heartbeatIntervalMs: 5_000, cloud: { ...state }, network: networkState });
	};
	pulse(true);

	while (true) {
		const now = Date.now();

		if (now - lastRootPass >= cfg.rootInterval) {
			lastRootPass = now;
			try {
				networkState = await rootAndDeploy(ns, pulse);
				state.error = "";
			} catch (error) {
				state.error = `root/deploy: ${String(error?.message ?? error)}`;
			}
		}

		if (cfg.cloud.enabled && now - lastCloudAction >= cfg.cloudInterval) {
			lastCloudAction = now;
			try {
				const actionsBefore = state.purchases + state.upgrades;
				await manageOneCloudAction(ns, cfg, state);
				if (networkState && state.purchases + state.upgrades > actionsBefore) {
					networkState = refreshCloudHostsInNetwork(ns, networkState);
				}
			} catch (error) {
				state.error = `cloud: ${String(error?.message ?? error)}`;
			}
		}

		try {
			refreshCloudState(ns, cfg, state);
		} catch (error) {
			state.error = `status: ${String(error?.message ?? error)}`;
		}

		state.lastRun = Date.now();
		pulse(true);

		await ns.sleep(1_000);
	}
}

function createState(cfg) {
	return {
		enabled: cfg.cloud.enabled,
		count: 0,
		limit: 0,
		totalRam: 0,
		minRam: 0,
		maxRam: 0,
		ramLimit: 0,
		purchases: 0,
		upgrades: 0,
		spent: 0,
		reserveFloor: 0,
		stockReserveFloor: 0,
		actionBudget: 0,
		lastRun: 0,
		lastAction: "none",
		nextAction: "unknown",
		error: "",
	};
}

async function manageOneCloudAction(ns, cfg, state) {
	const limit = ns.cloud.getServerLimit();
	const ramLimit = ns.cloud.getRamLimit();
	const names = ns.cloud.getServerNames();
    state.capitalRequest = null;
    const objective = readProgressionSnapshot(ns), blocker = fleetProgressionBlocker(objective, liveScheduler(ns));
    if (blocker) { state.investment = blocker; return; }
    state.capitalRequest = planFleetCapital(ns, cfg, state, names, limit, ramLimit, objective);
	const cashAvailable = ns.getServerMoneyAvailable(HOME);
	const stockReserveFloor = readStockReserveFloor(ns, cfg.stockPort);
    const goal = readSavings(ns), funded = goal.owner === "supervisor" && state.capitalRequest?.target === goal.target;
	const reserveFloor = Math.max(
		cfg.cloud.cashFloor, funded ? readSavings(ns, goal.target).floor : goal.floor,
		cashAvailable * cfg.cloud.cashReserve,
		stockReserveFloor
	);
	const spendable = Math.max(0, cashAvailable - reserveFloor);
	const actionBudget = Math.min(
		spendable,
		cashAvailable * cfg.cloud.maxAction
	);

	state.reserveFloor = reserveFloor;
	state.stockReserveFloor = stockReserveFloor;
	state.actionBudget = actionBudget;

    if (funded) {
        const candidate = state.capitalRequest.candidate;
        state.investment = `Prioritized ${formatRam(candidate.added)} cloud RAM; ${cash(actionBudget)} / ${cash(candidate.cost)} available`;
        if (candidate.cost <= actionBudget) await executeInvestment(ns, cfg, state, candidate);
        return;
    }

	if (actionBudget <= 0) { state.investment = "Saving cash / reserve protected"; return; }

	if (cfg.cloud.roi && names.length > 0) {
		await buyBestInvestment(ns, cfg, state, names, limit, ramLimit, actionBudget);
		return;
	}
	state.investment = cfg.cloud.roi ? "Bootstrap: first cloud server" : "ROI guard disabled";

	if (names.length < limit) {
		const purchaseRam = largestAffordablePurchaseRam(
			ns,
			cfg.cloud.minRam,
			ramLimit,
			actionBudget
		);
		if (!purchaseRam) return;

		const cost = ns.cloud.getServerCost(purchaseRam);
		await executeInvestment(ns, cfg, state, { ram: purchaseRam, added: purchaseRam, cost });
		return;
	}

	const weakest = names
		.map(name => ({ name, ram: ns.getServerMaxRam(name) }))
		.filter(server => server.ram < ramLimit)
		.sort((a, b) => (a.ram - b.ram) || a.name.localeCompare(b.name))[0];

	if (!weakest) return;

	const targetRam = largestAffordableUpgradeRam(
		ns,
		weakest,
		ramLimit,
		actionBudget
	);
	if (!targetRam || targetRam <= weakest.ram) return;

	const cost = ns.cloud.getServerUpgradeCost(weakest.name, targetRam);
	await executeInvestment(ns, cfg, state, { name: weakest.name, ram: targetRam, added: targetRam - weakest.ram, cost });
}

function fleetProgressionBlocker(objective, snapshot = null) {
    if (objective?.resetImminent || objective?.redPill === "queued") return "Augmentation installation is imminent; fleet capital retained";
    if (objective?.limitingResource === "hacking" && objective.moneyCovered && !fleetCapacityPolicy(snapshot, objective).xp)
        return "Skill bottleneck: retain capital; no usable XP RAM pressure";
    return "";
}

function liveScheduler(ns) {
    const snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek(), now = Date.now();
    return snapshot?.type === "jit-status" && Number.isFinite(snapshot.generatedAt) && snapshot.generatedAt <= now &&
        now - snapshot.generatedAt <= 15000 && ns.isRunning(snapshot.pid) ? snapshot : null;
}

function planFleetCapital(ns, cfg, state, names, limit, ramLimit, objective) {
    if (cfg.cloud.enabled === false || !(cfg.cloud.maxAction > 0) || Date.now() < (state.nextCapitalAt || 0)) return null;
    const candidates = [];
    if (names.length < limit && cfg.cloud.minRam <= ramLimit) {
        candidates.push({ram:cfg.cloud.minRam, added:cfg.cloud.minRam, cost:ns.cloud.getServerCost(cfg.cloud.minRam)});
    }
    for (const name of names) {
        const current = ns.getServerMaxRam(name), ram = current * 2;
        if (current > 0 && ram <= ramLimit) candidates.push({name, ram, added:current, cost:ns.cloud.getServerUpgradeCost(name, ram)});
    }
    const available = candidates.filter(c => Number.isFinite(c.cost) && c.cost > 0).sort((a,b) => a.cost-b.cost);
    let selected = null, reason = "", economics = null;
    if (!names.length && !objective?.queuedDistinct?.length) {
        selected = available[0]; reason = "Bootstrap the first small cloud server";
    } else {
        const snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek(), now = Date.now();
        if (snapshot?.type !== "jit-status" || !Number.isFinite(snapshot.generatedAt) || snapshot.generatedAt > now ||
            now-snapshot.generatedAt > 15000 || !ns.isRunning(snapshot.pid)) return null;
        for (const candidate of available) {
            const evidence = evaluateFleetInvestment(snapshot,candidate.added,candidate.cost,Math.min(cfg.cloud.payback || 1800,300),objective);
            if (evidence.ok && (!selected || evidence.payback < economics.payback)) { selected=candidate; economics={...evidence, resource:"cloud-ram", confidence:"conservative"}; reason=`Productive cloud expansion: ${evidence.reason}`; }
        }
    }
    if (!selected) return null;
    // Reserve enough to honor the existing per-action cap and independent floors.
    const amount = Math.max(selected.cost/cfg.cloud.maxAction, selected.cost/(1-cfg.cloud.cashReserve),
        selected.cost + cfg.cloud.cashFloor, selected.cost + readStockReserveFloor(ns,cfg.stockPort));
    let epoch = "";
    try { epoch=resetEpoch(ns.getResetInfo()); } catch { return null; }
    if (!epoch || !Number.isFinite(amount)) return null;
    return {version:1, producerPid:ns.pid, resetEpoch:epoch, generatedAt:Date.now(),
        target:fleetInvestmentTarget(selected), amount, priority:79, liquidity:false,
        label:`Cloud RAM: ${formatRam(selected.added)}`, reason, economics, candidate:selected};
}

function largestAffordablePurchaseRam(ns, minRam, ramLimit, budget) {
	let best = 0;
	for (let ram = minRam; ram <= ramLimit; ram *= 2) {
		const cost = ns.cloud.getServerCost(ram);
		if (!Number.isFinite(cost) || cost < 0 || cost > budget) break;
		best = ram;
		if (ram === ramLimit) break;
	}
	return best;
}

function largestAffordableUpgradeRam(ns, server, ramLimit, budget) {
	let best = server.ram;
	for (let ram = server.ram * 2; ram <= ramLimit; ram *= 2) {
		const cost = ns.cloud.getServerUpgradeCost(server.name, ram);
		if (!Number.isFinite(cost) || cost < 0 || cost > budget) break;
		best = ram;
		if (ram === ramLimit) break;
	}
	return best;
}

async function rootAndDeploy(ns, pulse = () => {}) {
	const discovered = await scanNetwork(ns, pulse);
	const servers = discovered.servers;
	const parents = discovered.parents;

	for (const cloud of ns.cloud.getServerNames()) {
		if (!servers.includes(cloud)) {
			servers.push(cloud);
			parents[cloud] = HOME;
		}
	}

	const hosts = [];
	let rooted = 0;

	for (const host of servers) {
		pulse();
		tryRoot(ns, host);

		if (!ns.hasRootAccess(host)) {
			await ns.sleep(1);
			continue;
		}

		rooted++;
		const maxRam = ns.getServerMaxRam(host);
		if (maxRam <= 0) {
			await ns.sleep(1);
			continue;
		}

		if (host !== HOME && WORKERS.some(file => !ns.fileExists(file, host))) {
			const copied = await ns.scp(WORKERS, host, HOME);
			if (!copied) {
				await ns.sleep(1);
				continue;
			}
		}

		let cores = 1;
		try {
			cores = Math.max(1, Number(ns.getServer(host).cpuCores ?? 1));
		} catch {
			cores = 1;
		}

		hosts.push({ name: host, maxRam, cores });
		await ns.sleep(1);
	}

	hosts.sort((a, b) => b.maxRam - a.maxRam);
	return {
		servers,
		hosts,
		parents,
		rooted,
		updatedAt: Date.now(),
	};
}

function refreshCloudHostsInNetwork(ns, network) {
	const servers = new Set(network?.servers ?? []);
	const parents = { ...(network?.parents ?? {}) };
	const byName = new Map((network?.hosts ?? []).map(host => [host.name, { ...host }]));

	for (const name of ns.cloud.getServerNames()) {
		servers.add(name);
		parents[name] = HOME;
		if (!ns.hasRootAccess(name) || !ns.fileExists(HACK, name)) continue;

		let cores = 1;
		try {
			cores = Math.max(1, Number(ns.getServer(name).cpuCores ?? 1));
		} catch {
			cores = 1;
		}

		byName.set(name, {
			name,
			maxRam: ns.getServerMaxRam(name),
			cores,
		});
	}

	const hosts = [...byName.values()].sort((a, b) => b.maxRam - a.maxRam);
	return {
		servers: [...servers],
		hosts,
		parents,
		rooted: Number(network?.rooted) || 0,
		updatedAt: Date.now(),
	};
}

async function scanNetwork(ns, pulse = () => {}) {
	const seen = new Set([HOME]);
	const queue = [HOME];
	const parents = { [HOME]: null };

	for (let i = 0; i < queue.length; i++) {
		pulse();
		const host = queue[i];
		for (const next of ns.scan(host)) {
			if (seen.has(next)) continue;
			seen.add(next);
			parents[next] = host;
			queue.push(next);
		}
		await ns.sleep(1);
	}

	return { servers: [...seen], parents };
}

function tryRoot(ns, host) {
	if (host === HOME || ns.hasRootAccess(host)) return;

	const attempts = [
		["BruteSSH.exe", () => ns.brutessh(host)],
		["FTPCrack.exe", () => ns.ftpcrack(host)],
		["relaySMTP.exe", () => ns.relaysmtp(host)],
		["HTTPWorm.exe", () => ns.httpworm(host)],
		["SQLInject.exe", () => ns.sqlinject(host)],
	];

	for (const [file, action] of attempts) {
		if (!ns.fileExists(file, HOME)) continue;
		try {
			action();
		} catch {
			// Ignore unavailable/invalid port openers.
		}
	}

	try {
		ns.nuke(host);
	} catch {
		// Not enough ports yet.
	}
}

function refreshCloudState(ns, cfg, state) {
	state.enabled = cfg.cloud.enabled;
	const names = ns.cloud.getServerNames();
	const limit = ns.cloud.getServerLimit();
	const ramLimit = ns.cloud.getRamLimit();
	const servers = names.map(name => ({ name, ram: ns.getServerMaxRam(name) }));

	state.count = names.length;
	state.limit = limit;
	state.ramLimit = ramLimit;
	state.totalRam = servers.reduce((sum, server) => sum + server.ram, 0);
	state.minRam = servers.length ? Math.min(...servers.map(server => server.ram)) : 0;
	state.maxRam = servers.length ? Math.max(...servers.map(server => server.ram)) : 0;
	state.nextAction = cfg.cloud.enabled && cfg.cloud.roi && state.investment
		? state.investment : describeNextCloudAction(ns, cfg, servers, limit, ramLimit);
}

function describeNextCloudAction(ns, cfg, servers, limit, ramLimit) {
	if (!cfg.cloud.enabled) return "management disabled";

	const cashAvailable = ns.getServerMoneyAvailable(HOME);
	const stockReserveFloor = readStockReserveFloor(ns, cfg.stockPort);
	const reserveFloor = Math.max(cfg.cloud.cashFloor, readSavings(ns).floor, cashAvailable * cfg.cloud.cashReserve, stockReserveFloor);
	const spendable = Math.max(0, cashAvailable - reserveFloor);
	const budget = Math.min(spendable, cashAvailable * cfg.cloud.maxAction);

	if (servers.length < limit) {
		const ram = largestAffordablePurchaseRam(ns, cfg.cloud.minRam, ramLimit, budget);
		if (!ram) return `waiting for ${formatRam(cfg.cloud.minRam)} purchase budget`;
		return `buy ${formatRam(ram)} for ${cash(ns.cloud.getServerCost(ram))}`;
	}

	const weakest = servers
		.filter(server => server.ram < ramLimit)
		.sort((a, b) => (a.ram - b.ram) || a.name.localeCompare(b.name))[0];
	if (!weakest) return "fleet maxed";

	const targetRam = largestAffordableUpgradeRam(ns, weakest, ramLimit, budget);
	if (targetRam <= weakest.ram) return `waiting to upgrade ${weakest.name}`;
	return `upgrade ${weakest.name} -> ${formatRam(targetRam)} for ${cash(ns.cloud.getServerUpgradeCost(weakest.name, targetRam))}`;
}

function readStockReserveFloor(ns, portNumber, now = Date.now()) {
	try {
		const status = ns.getPortHandle(portNumber).peek();
		if (status?.type !== "stock-status" || status.version !== 1) return 0;
		if (!Number.isFinite(status.generatedAt) || now - status.generatedAt < 0 || now - status.generatedAt > 30_000) return 0;
		if (status.access?.ok !== true || status.dryRun === true) return 0;
		const floor = Number(status.reserveFloor);
		return Number.isFinite(floor) && floor > 0 ? floor : 0;
	} catch {
		return 0;
	}
}

function nextCloudServerName(ns, prefix) {
	for (let index = 0; index < 100_000; index++) {
		const name = `${prefix}-${String(index).padStart(2, "0")}`;
		if (!ns.serverExists(name)) return name;
	}
	return `${prefix}-${Date.now()}`;
}

function normalizeCloudRam(value) {
	const requested = Math.max(2, Number(value) || 2);
	return 2 ** Math.ceil(Math.log2(requested));
}

function clampFraction(value, max) {
	const n = Number(value);
	const fraction = n > 1 ? n / 100 : n;
	return Math.min(max, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function formatRam(gb) {
	const value = Math.max(0, Number(gb) || 0);
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} PB`;
	if (value >= 1024) return `${(value / 1024).toFixed(2)} TB`;
	return `${value.toFixed(0)} GB`;
}

function cash(value) {
	const n = Number(value) || 0;
	const units = [
		[1e18, "Q"],
		[1e15, "q"],
		[1e12, "t"],
		[1e9, "b"],
		[1e6, "m"],
		[1e3, "k"],
	];
	for (const [threshold, suffix] of units) {
		if (Math.abs(n) >= threshold) return `$${(n / threshold).toFixed(2)}${suffix}`;
	}
	return `$${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

async function buyBestInvestment(ns, cfg, state, names, limit, ramLimit, budget) {
    const objective=readProgressionSnapshot(ns);
    if(objective?.resetImminent || objective?.redPill === "queued") {state.investment="Augmentation installation is imminent; fleet capital retained";return;}
    const live = liveScheduler(ns), policy = fleetCapacityPolicy(live, objective);
    const blocker = fleetProgressionBlocker(objective, live);
    if (blocker || !policy.ok) { state.investment = blocker || policy.reason; return; }
    const candidates = [];
    if (names.length < limit) {
        for (let ram = cfg.cloud.minRam; ram <= ramLimit; ram *= 2) {
            const cost = ns.cloud.getServerCost(ram);
            if (Number.isFinite(cost) && cost > 0 && cost <= budget) candidates.push({ ram, added: ram, cost });
        }
    }
    for (const name of names) {
        const current = ns.getServerMaxRam(name);
        if (!(current > 0)) continue;
        for (let ram = current * 2; ram <= ramLimit; ram *= 2) {
            const cost = ns.cloud.getServerUpgradeCost(name, ram);
            if (Number.isFinite(cost) && cost > 0 && cost <= budget) candidates.push({ name, ram, added: ram - current, cost });
        }
    }
    const surplus = objective?.queuedDistinct?.length || policy.xp ? null : chooseSurplusInvestment(candidates, budget);
    const snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek();
    const now = Date.now();
    if (snapshot?.type !== "jit-status" || !Number.isFinite(snapshot.generatedAt) || now < snapshot.generatedAt ||
        now - snapshot.generatedAt > 15000 || !ns.isRunning(snapshot.pid)) {
        state.investment = "Waiting for fresh live scheduler evidence";
        return;
    }
    const scored = candidates.map(c => ({ ...c, ...evaluateFleetInvestment(snapshot, c.added, c.cost, objective?.queuedDistinct?.length ? Math.min(cfg.cloud.payback, 300) : cfg.cloud.payback, objective) }));
    const roiBest = scored.filter(c => c.ok).sort((a, b) => a.payback - b.payback || a.cost - b.cost)[0];
    const best = roiBest || surplus;
    state.investment = roiBest?.reason || (surplus
        ? `Surplus cash override: ${formatRam(surplus.added)} added for ${cash(surplus.cost)}`
        : scored[0]?.reason || "Waiting for an affordable RAM upgrade");
    if (!best) return;
    await executeInvestment(ns, cfg, state, best);
}

function chooseSurplusInvestment(candidates, budget) {
    if (!candidates.length) return null;
    const cheapest = Math.min(...candidates.map(candidate => candidate.cost));
    if (!(cheapest > 0) || budget < cheapest * SURPLUS_COST_MULTIPLE) return null;
    return [...candidates].sort((a, b) => b.added - a.added || a.cost - b.cost)[0];
}

async function executeInvestment(ns, cfg, state, best) {
    const objective=readProgressionSnapshot(ns);
    const snapshot = liveScheduler(ns), blocker = fleetProgressionBlocker(objective, snapshot);
    if(blocker) { state.investment=blocker; return; }
    // Read current cash and the goal again immediately before the transaction.
    const cashNow = ns.getServerMoneyAvailable(HOME);
    const target = fleetInvestmentTarget(best), goal = readSavings(ns);
    const floor = Math.max(cfg.cloud.cashFloor, cashNow * cfg.cloud.cashReserve, readSavings(ns,target).floor, readStockReserveFloor(ns, cfg.stockPort));
    const cost = best.name ? ns.cloud.getServerUpgradeCost(best.name,best.ram) : ns.cloud.getServerCost(best.ram);
    if (!(cost > 0) || !Number.isFinite(cost) || cashNow-cost < floor || cost > cashNow*cfg.cloud.maxAction) {
        state.investment = "Live cost, cash goal or action budget changed; purchase deferred"; return;
    }
    const currentObjective = readProgressionSnapshot(ns);
    const currentBlocker = fleetProgressionBlocker(currentObjective, liveScheduler(ns));
    if (currentBlocker) { state.investment = currentBlocker; return; }
    // Re-read evidence at the transaction. Bootstrap keeps its capability-free
    // path; subsequent purchases cannot bypass a known throughput ceiling.
    if (ns.cloud.getServerNames().length) {
        const latest = liveScheduler(ns), policy = fleetCapacityPolicy(latest, currentObjective);
        if (!policy.ok || cfg.cloud.roi && !latest) {
            state.investment = policy.ok ? "Waiting for fresh live scheduler evidence" : policy.reason; return;
        }
        if (policy.xp && !evaluateFleetInvestment(latest, best.added, cost, cfg.cloud.payback, currentObjective).ok) {
            state.investment = "XP demand or capital recovery evidence changed"; return;
        }
        if (goal.owner === "supervisor" && goal.target === target && cfg.cloud.roi &&
            !evaluateFleetInvestment(latest, best.added, cost, Math.min(cfg.cloud.payback || 1800,300), currentObjective).ok) {
            state.investment = "Funded expansion no longer meets live scheduler ROI"; return;
        }
    }
    const host = best.name || nextCloudServerName(ns, cfg.cloud.prefix);
    const ok = best.name ? ns.cloud.upgradeServer(host, best.ram) : ns.cloud.purchaseServer(host, best.ram);
    if (!ok) { state.lastAction = `investment failed: ${host}`; return; }
    if (best.name) state.upgrades++; else state.purchases++;
    state.spent += cost;
    state.lastAction = `${best.name ? "upgraded" : "bought"} ${host} ${formatRam(best.ram)} for ${cash(cost)}`;
    if (goal.owner === "supervisor" && goal.target === target) state.nextCapitalAt = Date.now()+180000;
    state.capitalRequest = null;
    if (!best.name) await ns.scp(WORKERS, host, HOME);
}
