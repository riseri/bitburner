const HOME = "home", STATUS_PORT = 10, STATE_FILE = "data/darknet-state.json";

/** One-shot or live Darknet diagnostics. Use --watch for a tail window. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["watch", false], ["interval", 2_000]]);
	if (ns.getHostname() !== HOME) throw new Error("Run darknet-status.js on home");
	if (flags.watch) ns.ui.openTail(ns.pid);
	do {
		const lines = report(ns);
		if (flags.watch) { ns.clearLog(); for (const line of lines) ns.print(line); }
		else for (const line of lines) ns.tprint(line);
		if (!flags.watch) return;
		await ns.sleep(Math.max(500, Number(flags.interval) || 2_000));
	} while (true);
}

export function report(ns) {
	const processes = ns.ps(HOME), manager = processes.find(p => p.filename === "darknet-manager.js"), agent = processes.find(p => p.filename === "darknet-agent.js");
	const snapshot = ns.getPortHandle(STATUS_PORT).peek();
	let saved = null;
	try { saved = JSON.parse(ns.read(STATE_FILE)); } catch {}
	const lines = ["DARKNET STATUS"];
	lines.push(`Manager: ${manager ? `RUNNING PID ${manager.pid}` : "NOT RUNNING"}`);
	lines.push(`Home crawler: ${agent ? `RUNNING PID ${agent.pid}` : "NOT RUNNING"}`);
	if (!snapshot || typeof snapshot !== "object" || snapshot.type !== "darknet-status") {
		lines.push(`Heartbeat: MISSING on port ${STATUS_PORT}`);
		if (saved?.last) lines.push(`Saved last event: ${saved.last}`);
		return lines;
	}
	const age = Math.max(0, Date.now() - Number(snapshot.generatedAt || 0));
	lines.push(`Heartbeat: ${snapshot.state} | age ${(age / 1000).toFixed(1)}s | Formulas ${snapshot.formulas ? "ON" : "OFF"}`);
	lines.push(`Coverage: ${Number(snapshot.authenticated) || 0}/${Number(snapshot.known) || 0} authenticated | ${Number(snapshot.activeAgents) || 0} active agents`);
	const cracking = Array.isArray(snapshot.cracking) ? snapshot.cracking : [];
	lines.push(`Activity: ${cracking.length ? `cracking ${cracking.map(item => `${item.host} (${item.modelId || "unknown"})`).join(", ")}` : "no authentication calls in flight"}`);
	lines.push(`Results: ${Number(snapshot.deployments) || 0} deployments | ${Number(snapshot.caches) || 0} caches | ${Number(snapshot.blocked) || 0} blocked attempts | ${Number(snapshot.errors) || 0} errors`);
	if (snapshot.blocker) lines.push(`BLOCKER: ${snapshot.blocker}`);
	lines.push(`Last event: ${snapshot.last || "none"}`);
	const blocked = Array.isArray(snapshot.currentBlockers) ? snapshot.currentBlockers.slice(0, 8) : [];
	if (blocked.length) lines.push(`Current server blockers: ${blocked.map(item => `${item.host}=${item.reason}${Number.isFinite(item.freeRam) ? ` (${Number(item.freeRam).toFixed(2)}/${Number(item.requiredRam).toFixed(2)} GB)` : ""}`).join(" | ")}`);
	return lines;
}
