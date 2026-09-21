const HOME = "home", SUPERVISOR = "supervisor.js", BOOTSTRAP = "bootstrap.js";

/** Reload supervisor code while preserving its saved arguments. @param {NS} ns */
export async function main(ns) {
	if (ns.getHostname() !== HOME) throw new Error("Run supervisor-restart.js on home");
	const supervisors = ns.ps(HOME).filter(process => process.filename === SUPERVISOR);
	for (const process of supervisors) {
		const stopped = ns.kill(process.pid);
		ns.tprint(`${stopped ? "Stopped" : "Could not stop"} ${SUPERVISOR} PID ${process.pid}`);
	}
	await ns.sleep(1_000);
	const pid = ns.run(BOOTSTRAP, { threads: 1, temporary: true });
	if (!pid) { ns.tprint(`ERROR: could not start ${BOOTSTRAP}; inspect home free RAM and script availability`); return; }
	ns.tprint(`Started ${BOOTSTRAP} PID ${pid}; it will restore the saved supervisor arguments`);
	await ns.sleep(2_000);
	const replacement = ns.ps(HOME).find(process => process.filename === SUPERVISOR);
	if (replacement) { ns.tprint(`Supervisor dashboard PID ${replacement.pid}`); ns.ui.openTail(replacement.pid); }
	else ns.tprint("ERROR: supervisor did not restart; run bootstrap.js after checking home RAM");
}
