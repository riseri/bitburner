import { PORTS } from "lib/ports.js";

const HOME = "home";
const TOR_COST = 200_000;

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["status-port", PORTS.PROGRESSION_STATUS],
		["cash-reserve", 0.10],
	]);

	ns.disableLog("ALL");

	const reserve = clampFraction(flags["cash-reserve"]);
	const status = ns.getPortHandle(Number(flags["status-port"])).peek();

	if (
		!status ||
		typeof status !== "object" ||
		status.type !== "progression-status" ||
		!status.singularity?.available
	) {
		return;
	}

	const objective = status.nextObjective;
	if (!objective || typeof objective !== "object") return;

	// One purchase per invocation. The shopping cart has parental controls.
	if (objective.kind === "tor") {
		if (ns.hasTorRouter()) return;

		// We are automating progression, not reenacting the 2008 financial crisis.
		if (!canSpend(ns, TOR_COST, reserve)) {
			ns.print(`Waiting for TOR budget while preserving ${(reserve * 100).toFixed(0)}% cash reserve`);
			return;
		}

		const purchased = ns.singularity.purchaseTor();
		ns.print(purchased ? "Purchased TOR router" : "TOR purchase was not available yet");
		return;
	}

	if (objective.kind !== "program") return;
	if (!ns.hasTorRouter()) return;

	const program = String(objective.program ?? "");
	if (!program || ns.fileExists(program, HOME)) return;

	const cost = Number(ns.singularity.getDarkwebProgramCost(program));
	if (!Number.isFinite(cost) || cost <= 0) {
		ns.print(`No valid darkweb price for ${program}`);
		return;
	}

	if (!canSpend(ns, cost, reserve)) {
		ns.print(
			`Waiting for ${program} budget while preserving ${(reserve * 100).toFixed(0)}% cash reserve`
		);
		return;
	}

	const purchased = ns.singularity.purchaseProgram(program);
	ns.print(
		purchased
			? `Purchased ${program}`
			: `${program} purchase was not available yet`
	);
}

function canSpend(ns, cost, reserve) {
	const cash = ns.getServerMoneyAvailable(HOME);
	const reserveFloor = cash * reserve;
	return cash >= cost && cash - cost >= reserveFloor;
}

function clampFraction(value) {
	const n = Number(value);
	const fraction = n > 1 ? n / 100 : n;
	return Math.min(0.95, Math.max(0, Number.isFinite(fraction) ? fraction : 0.10));
}
