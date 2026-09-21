// Worker dependency revision: generation-control-v3. Refreshes cached entry RAM after helper changes.
import { runJitWorker } from "lib/jit-worker.js";

/** @param {NS} ns */
export async function main(ns) {
	await runJitWorker(ns,
		target => ns.getWeakenTime(target),
		(target, options) => ns.weaken(target, options)
	);
}
