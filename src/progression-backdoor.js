import { PORTS } from "lib/ports.js";

const HOME = "home";

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["status-port", PORTS.PROGRESSION_STATUS],
		["fleet-port", PORTS.FLEET_STATUS],
	]);

	ns.disableLog("ALL");

	const status = ns.getPortHandle(Number(flags["status-port"])).peek();
	const fleet = ns.getPortHandle(Number(flags["fleet-port"])).peek();

	if (
		!status ||
		typeof status !== "object" ||
		status.type !== "progression-status" ||
		!status.singularity?.available
	) {
		return;
	}

	const objective = status.nextObjective;
	if (objective?.kind !== "backdoor") return;

	if (ns.singularity.isBusy()) {
		// The player is doing something. We are not the main character.
		ns.print("Player is busy; leaving the backdoor objective alone");
		return;
	}

	const target = String(objective.host ?? "");
	const parents =
		fleet?.type === "fleet-status" &&
		fleet.network?.parents &&
		typeof fleet.network.parents === "object"
			? fleet.network.parents
			: {};

	if (!target || !ns.serverExists(target)) return;

	const current = String(ns.singularity.getCurrentServer());
	const outbound = routeBetween(parents, current, target);
	const restore = routeBetween(parents, target, current);

	if (!outbound.length || !restore.length) {
		ns.print(`No safe route available from ${current} to ${target}; refusing to teleport by vibes`);
		return;
	}

	// We touch the player's terminal session, so put the furniture back exactly where we found it.
	let reachedTarget = false;
	try {
		if (!connectRoute(ns, outbound)) {
			ns.print(`Unable to reach ${target}; aborting backdoor action`);
			return;
		}

		reachedTarget = true;

		if (ns.singularity.isBusy()) {
			ns.print("Player became busy before backdoor install; aborting");
			return;
		}

		await ns.singularity.installBackdoor();
		ns.print(`Installed backdoor on ${target}`);
	} finally {
		if (reachedTarget && !connectRoute(ns, restore)) {
			// If this ever fires, the network tree changed mid-action. Extremely normal browser game behavior.
			ns.print(`WARN: could not restore previous connection to ${current}`);
		}
	}
}

function connectRoute(ns, route) {
	for (const host of route.slice(1)) {
		if (!ns.singularity.connect(host)) return false;
	}
	return true;
}

function routeBetween(parents, from, to) {
	if (from === to) return [from];

	const fromPath = pathFromHome(parents, from);
	const toPath = pathFromHome(parents, to);
	if (!fromPath.length || !toPath.length) return [];

	let common = 0;
	while (
		common < fromPath.length &&
		common < toPath.length &&
		fromPath[common] === toPath[common]
	) {
		common++;
	}

	if (common === 0) return [];

	const lcaIndex = common - 1;
	const up = fromPath.slice(lcaIndex).reverse();
	const down = toPath.slice(lcaIndex + 1);
	return [...up, ...down];
}

function pathFromHome(parents, target) {
	if (target === HOME) return [HOME];

	const reversed = [];
	const seen = new Set();
	let current = target;

	while (current != null && !seen.has(current)) {
		seen.add(current);
		reversed.push(current);
		if (current === HOME) break;
		current = parents[current];
	}

	if (reversed[reversed.length - 1] !== HOME) return [];
	return reversed.reverse();
}
