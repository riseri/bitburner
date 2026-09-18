// Worker dependency revision: ram-safe-control-v1. Refreshes cached entry RAM after helper changes.
import { runJitWorker } from "lib/jit-worker.js";

/** @param {NS} ns */
export async function main(ns) {
	await runJitWorker(ns,
		target => ns.getGrowTime(target),
		(target, options) => ns.grow(target, options)
	);
}
