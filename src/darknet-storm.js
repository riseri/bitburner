/** One-shot endgame storm action. @param {NS} ns */
export async function main(ns) {
	const cfg = config(ns.args[0]), host = ns.getHostname();
	try { emit(ns, cfg, { kind: "storm", host, state: "armed" }); ns.dnet.unleashStormSeed(); }
	catch (error) { emit(ns, cfg, { kind: "error", host, error: `storm: ${String(error?.message ?? error)}` }); }
}
function config(raw) { try { return JSON.parse(String(raw || "{}")); } catch { return {}; } }
function emit(ns, cfg, event) { try { ns.getPortHandle(Number(cfg.eventPort) || 9).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
