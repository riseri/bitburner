/** One-shot high-RAM stasis operation, isolated from the 16 GB crawler. @param {NS} ns */
export async function main(ns) {
	const cfg = config(ns.args[0]), host = ns.getHostname();
	try {
		const linked = ns.dnet.getStasisLinkedServers(), limit = ns.dnet.getStasisLinkLimit();
		if (!linked.includes(host) && linked.length < limit) {
			const result = await ns.dnet.setStasisLink(true);
			if (result.success) emit(ns, cfg, { kind: "stasis", host });
		}
	} catch (error) { emit(ns, cfg, { kind: "error", host, error: `stasis: ${String(error?.message ?? error)}` }); }
}
function config(raw) { try { return JSON.parse(String(raw || "{}")); } catch { return {}; } }
function emit(ns, cfg, event) { try { ns.getPortHandle(Number(cfg.eventPort) || 9).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
