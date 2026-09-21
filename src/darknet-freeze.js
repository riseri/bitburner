/** One-shot defensive freeze operation. @param {NS} ns */
export async function main(ns) {
	const cfg = config(ns.args[0]), target = String(ns.args[1] || ""), from = ns.getHostname();
	try { const result = ns.dnet.freezeServer(target); if (result.success) emit(ns, cfg, { kind: "freeze", host: target, from }); }
	catch (error) { emit(ns, cfg, { kind: "error", host: target || from, error: `freeze: ${String(error?.message ?? error)}` }); }
}
function config(raw) { try { return JSON.parse(String(raw || "{}")); } catch { return {}; } }
function emit(ns, cfg, event) { try { ns.getPortHandle(Number(cfg.eventPort) || 9).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
