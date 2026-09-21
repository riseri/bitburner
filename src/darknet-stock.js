/** One-shot stock promotion, kept out of the crawler's static RAM bill. @param {NS} ns */
export async function main(ns) {
	const cfg = config(ns.args[0]), host = ns.getHostname();
	try {
		let symbols = Array.isArray(cfg.stockSymbols) ? cfg.stockSymbols : String(cfg.stockSymbols || "auto").split(",").map(v => v.trim()).filter(Boolean);
		if (symbols.includes("auto")) symbols = ns.stock.getSymbols().filter(symbol => { const [long,,,short] = ns.stock.getPosition(symbol); return long > 0 || short > 0; });
		if (!symbols.length) return;
		const symbol = symbols[Math.floor(Date.now() / 60_000) % symbols.length];
		const result = await ns.dnet.promoteStock(symbol);
		if (result.success) emit(ns, cfg, { kind: "stock", host, symbol });
	} catch (error) { emit(ns, cfg, { kind: "error", host, error: `stock: ${String(error?.message ?? error)}` }); }
}
function config(raw) { try { return JSON.parse(String(raw || "{}")); } catch { return {}; } }
function emit(ns, cfg, event) { try { ns.getPortHandle(Number(cfg.eventPort) || 9).tryWrite({ type: "darknet-event", at: Date.now(), pid: ns.pid, ...event }); } catch {} }
