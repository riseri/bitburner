// Worker dependency revision: dynamic-start-window-v2. Refreshes cached entry RAM after helper changes.
import { runJitWorker } from "lib/jit-worker.js";

/** @param {NS} ns */
export async function main(ns) {
	const budget = Number(ns.args[10]);
	const limit = Number(ns.args[11]);
	const sizeHack = target => {
		if (!(budget > 0) || !(limit > 0)) return {};
		const perThread = ns.hackAnalyze(target);
		const threads = Math.min(limit, Math.floor(budget * 0.95 / perThread));
		return Number.isFinite(threads) && threads > 0 ? { threads } : null;
	};
	await runJitWorker(ns,
		target => ns.getHackTime(target),
		(target, options) => ns.hack(target, options), sizeHack
	);
}
