import { reclaimHomeShare } from "lib/home-share.js";

const HOME = "home", SUPERVISOR = "supervisor.js", BOOTSTRAP = "bootstrap.js";
const CONTROLLERS = ["daemon.js", "fleet-manager.js"];

/** Reload supervisor and its scheduling controllers, preserving saved arguments. @param {NS} ns */
export async function main(ns) {
	if (ns.getHostname() !== HOME) throw new Error("Run supervisor-restart.js on home");
	if (!stopControllers(ns, [SUPERVISOR])) return;
	await ns.sleep(1_000);
	// A new supervisor adopts existing service PIDs. Stop the old scheduling
	// controllers after the supervisor so it cannot respawn them during reload.
	if (!stopControllers(ns, CONTROLLERS)) return;
	reclaimHomeShare(ns, Math.max(ns.getScriptRam(BOOTSTRAP, HOME), ns.getScriptRam(SUPERVISOR, HOME)));
	const pid = ns.run(BOOTSTRAP, { threads: 1, temporary: true });
	if (!pid) { ns.tprint(`ERROR: could not start ${BOOTSTRAP}; inspect home free RAM and script availability`); return; }
	ns.tprint(`Started ${BOOTSTRAP} PID ${pid}; it will restore the saved supervisor arguments`);
	await ns.sleep(2_000);
	const replacement = ns.ps(HOME).find(process => process.filename === SUPERVISOR);
	if (replacement) { ns.tprint(`Supervisor dashboard PID ${replacement.pid}`); ns.ui.openTail(replacement.pid); }
	else ns.tprint("ERROR: supervisor did not restart; run bootstrap.js after checking home RAM");
}

function stopControllers(ns, filenames) {
	for (const process of ns.ps(HOME).filter(p => filenames.includes(p.filename))) {
		const stopped = ns.kill(process.pid);
		if (!stopped && ns.ps(HOME).some(p => p.pid === process.pid)) {
			ns.tprint(`ERROR: could not stop ${process.filename} PID ${process.pid}; reload cancelled to avoid adopting stale code`);
			return false;
		}
		ns.tprint(`Stopped ${process.filename} PID ${process.pid}`);
	}
	return true;
}
