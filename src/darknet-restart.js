import { reclaimHomeShare } from "lib/home-share.js";

const HOME = "home", MANAGER = "darknet-manager.js";

/** Restart the Darknet coordinator without needing to reproduce its supervisor arguments. @param {NS} ns */
export async function main(ns) {
	if (ns.getHostname() !== HOME) throw new Error("Run darknet-restart.js on home");
	const managers = ns.ps(HOME).filter(process => process.filename === MANAGER);
	const args = managers[0]?.args || [];
	for (const process of managers) {
		const stopped = ns.kill(process.pid);
		ns.tprint(`${stopped ? "Stopped" : "Could not stop"} ${MANAGER} PID ${process.pid}`);
	}
	await ns.sleep(6_000);
	const replacement = ns.ps(HOME).find(process => process.filename === MANAGER);
	if (replacement) {
		ns.tprint(`Supervisor restarted ${MANAGER} as PID ${replacement.pid}`);
		return;
	}
	// The supervisor can still be in restart backoff. Reclaim immediately before
	// the fallback launch so its next sharing tick cannot take this RAM first.
	const required = ns.getScriptRam(MANAGER, HOME);
	reclaimHomeShare(ns, required);
	const pid = ns.run(MANAGER, { threads: 1, temporary: true }, ...args);
	if (pid) ns.tprint(`Started ${MANAGER} directly as PID ${pid}`);
	else ns.tprint(`ERROR: could not start ${MANAGER}; ${(ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME)).toFixed(2)} GB free after reclaiming home sharing; ${required.toFixed(2)} GB required. Check script availability if RAM is sufficient.`);
}
