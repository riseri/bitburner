import { normalizeStockConfig, expectedLongEdge, rankLongCandidates, shouldExitLong, sharesForBudget, tradeHasEnoughEdge, portfolioMetrics } from "lib/stock-strategy.js";
import { PORTS } from "lib/ports.js";
import { dashboardSection, dashboardRow } from "lib/dashboard.js";

const HOME = "home";
const LONG = "L";

/** Standalone 4S long-only stock trader. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([
		["cash-reserve", 0.20],
		["cash-floor", 0],
		["max-exposure", 0.80],
		["max-position", 0.25],
		["entry-forecast", 0.60],
		["exit-forecast", 0.55],
		["min-trade", 25e6],
		["min-hold-ticks", 6],
		["min-profit-multiple", 1.15],
		["max-buys-per-tick", 4],
		["ticks", 0],
		["dry-run", false],
		["port", PORTS.STOCK_STATUS],
	]);
	ns.disableLog("ALL");

	try {
		if (ns.getHostname() !== HOME) throw new Error("Run stock-trader.js on home only");
		if (ns.ps(HOME).some(process => process.filename === ns.getScriptName() && process.pid !== ns.pid)) {
			throw new Error("Only one stock-trader.js may trade at a time");
		}

		const cfg = normalizeStockConfig(flags);
		const statusPort = Number(flags.port);
		if (!Number.isSafeInteger(statusPort) || statusPort <= 0) throw new Error("port must be a positive integer");
		const tickLimit = Number(flags.ticks);
		if (!Number.isSafeInteger(tickLimit) || tickLimit < 0) throw new Error("ticks must be a nonnegative integer");

		const access = stockAccess(ns);
		if (!access.ok) {
			ns.tprint(`STOCK TRADER disabled: missing ${access.missing.join(", ")}. No trades were made.`);
			return;
		}

		const port = ns.getPortHandle(statusPort);
		port.clear();

		const constants = ns.stock.getConstants();
		const commission = Number(constants?.StockMarketCommission);
		if (!(commission >= 0) || !Number.isFinite(commission)) throw new Error("Invalid stock-market commission");
		const symbols = ns.stock.getSymbols();
		if (!Array.isArray(symbols) || !symbols.length) throw new Error("No stock symbols available");

		const session = {
			startedAt: Date.now(),
			ticks: 0,
			buys: 0,
			sells: 0,
			fees: 0,
			realized: 0,
			lastTradePnl: 0,
			winningTrades: 0,
			losingTrades: 0,
			// Buy commissions are not included in Bitburner's longAvg basis.
			// Track them per symbol so realized profit is genuinely net of both sides.
			entryFees: {},
			last: "Waiting for the first stock update",
		};

		let market = readMarket(ns, symbols);
		render(ns, market, cfg, session, commission, "WAITING FOR STOCK TICK");
		publishStatus(port, ns, market, cfg, session, commission, "WAITING");

		while (true) {
			const beforeWait = stockAccess(ns);
			if (!beforeWait.ok) {
				publishStatus(port, ns, market, cfg, session, commission, "BLOCKED", beforeWait.missing);
				ns.tprint(`STOCK TRADER stopped: lost ${beforeWait.missing.join(", ")}. Existing positions were left untouched.`);
				return;
			}

			await ns.stock.nextUpdate();

			const afterWait = stockAccess(ns);
			if (!afterWait.ok) {
				publishStatus(port, ns, market, cfg, session, commission, "BLOCKED", afterWait.missing);
				ns.tprint(`STOCK TRADER stopped: lost ${afterWait.missing.join(", ")}. Existing positions were left untouched.`);
				return;
			}

			session.ticks++;
			market = await tradeTick(ns, symbols, cfg, session, commission);
			const state = cfg.dryRun ? "DRY RUN" : "ACTIVE";
			render(ns, market, cfg, session, commission, state);
			publishStatus(port, ns, market, cfg, session, commission, state);

			if (tickLimit && session.ticks >= tickLimit) return;
		}
	} catch (error) {
		const reason = String(error?.message ?? error);
		ns.print(`STOPPED: ${reason}`);
		ns.tprint(`Stock trader stopped: ${reason}`);
	}
}

function stockAccess(ns) {
	const checks = [
		["WSE Account", () => ns.stock.hasWseAccount()],
		["TIX API", () => ns.stock.hasTixApiAccess()],
		["4S Market Data TIX API", () => ns.stock.has4SDataTixApi()],
	];
	const missing = [];
	for (const [name, check] of checks) {
		let present = false;
		try { present = check() === true; } catch { present = false; }
		if (!present) missing.push(name);
	}
	return { ok: missing.length === 0, missing };
}

async function tradeTick(ns, symbols, cfg, session, commission) {
	let rows = readMarket(ns, symbols);
	const actions = [];

	// Exit weak longs first so stale positions cannot block better opportunities.
	for (const row of rows) {
		if (!shouldExitLong(row, cfg)) continue;
		const shares = row.longShares;
		if (cfg.dryRun) {
			actions.push(`WOULD SELL ${row.symbol} ${formatShares(shares)} @ f=${pct(row.forecast)}`);
			continue;
		}
		const soldAt = ns.stock.sellStock(row.symbol, shares);
		if (!(soldAt > 0)) continue;
		const entryFees = Number(session.entryFees[row.symbol]) || 0;
		const realized = shares * (soldAt - row.longAvg) - commission - entryFees;
		session.sells++;
		session.fees += commission;
		session.realized += realized;
		session.lastTradePnl = realized;
		if (realized >= 0) session.winningTrades++;
		else session.losingTrades++;
		delete session.entryFees[row.symbol];
		actions.push(`SELL ${row.symbol} ${formatShares(shares)} | net ${signedCash(realized)}`);
	}

	if (!cfg.dryRun) rows = readMarket(ns, symbols);
	let metrics = portfolioMetrics(ns.getServerMoneyAvailable(HOME), rows, commission);
	let cash = metrics.cash, exposure = metrics.exposure, equity = metrics.equity;
	const reserveFloor = Math.max(cfg.cashFloor, equity * cfg.cashReserve);
	const exposureCap = equity * cfg.maxExposure;
	const positionCap = equity * cfg.maxPosition;
	let buysThisTick = 0;

	for (const row of rankLongCandidates(rows, cfg)) {
		if (buysThisTick >= cfg.maxBuysPerTick) break;
		const currentLongValue = row.longShares > 0 ? Math.max(0, row.longShares * row.bid - commission) : 0;
		const cashBudget = Math.max(0, cash - reserveFloor);
		const exposureBudget = Math.max(0, exposureCap - exposure);
		const positionBudget = Math.max(0, positionCap - currentLongValue);
		const budget = Math.min(cashBudget, exposureBudget, positionBudget);
		if (budget < cfg.minTrade) continue;

		let shares = sharesForBudget(row, budget, commission);
		if (!shares) continue;
		let cost = shares * row.ask + commission;
		if (cost > budget) {
			shares = Math.max(0, shares - Math.ceil((cost - budget) / row.ask));
			cost = shares * row.ask + commission;
		}
		if (!(shares > 0) || cost < cfg.minTrade) continue;
		if (!tradeHasEnoughEdge(row, shares, commission, cfg)) continue;

		const edge = expectedLongEdge(row.forecast, row.volatility);
		if (cfg.dryRun) {
			actions.push(`WOULD BUY ${row.symbol} ${formatShares(shares)} | f=${pct(row.forecast)} edge=${pct(edge)}`);
			buysThisTick++;
			continue;
		}

		const boughtAt = ns.stock.buyStock(row.symbol, shares);
		if (!(boughtAt > 0)) continue;
		session.buys++;
		session.fees += commission;
		session.entryFees[row.symbol] = (Number(session.entryFees[row.symbol]) || 0) + commission;
		buysThisTick++;
		cash -= cost;
		exposure += Math.max(0, shares * row.bid - commission);
		actions.push(`BUY ${row.symbol} ${formatShares(shares)} | f=${pct(row.forecast)} edge=${pct(edge)}`);
	}

	rows = readMarket(ns, symbols);
	metrics = portfolioMetrics(ns.getServerMoneyAvailable(HOME), rows, commission);
	session.last = summarizeActions(actions);
	return { rows, metrics };
}

function readMarket(ns, symbols) {
	return symbols.map(symbol => {
		const position = ns.stock.getPosition(symbol);
		if (!Array.isArray(position) || position.length !== 4) throw new Error(`Invalid position for ${symbol}`);
		const [longShares, longAvg, shortShares, shortAvg] = position.map(Number);
		const row = {
			symbol,
			forecast: Number(ns.stock.getForecast(symbol)),
			volatility: Number(ns.stock.getVolatility(symbol)),
			ask: Number(ns.stock.getAskPrice(symbol)),
			bid: Number(ns.stock.getBidPrice(symbol)),
			maxShares: Number(ns.stock.getMaxShares(symbol)),
			longShares,
			longAvg,
			shortShares,
			shortAvg,
		};
		if (![row.forecast, row.volatility, row.ask, row.bid, row.maxShares, longShares, longAvg, shortShares, shortAvg]
			.every(Number.isFinite) || row.ask <= 0 || row.bid <= 0 || row.maxShares < 0) {
			throw new Error(`Invalid market data for ${symbol}`);
		}
		return row;
	});
}

function render(ns, market, cfg, session, commission, state) {
	const rows = market.rows ?? market;
	const metrics = market.metrics ?? portfolioMetrics(ns.getServerMoneyAvailable(HOME), rows, commission);
	const reserveFloor = Math.max(cfg.cashFloor, metrics.equity * cfg.cashReserve);
	const elapsedMin = Math.max(1, Date.now() - session.startedAt) / 60_000;
	const candidates = rankLongCandidates(rows, cfg).slice(0, 5);
	const positions = rows.filter(row => row.longShares > 0 || row.shortShares > 0).length;
	const row = (label, value) => dashboardRow(ns, label, value);

	ns.clearLog();
	ns.print("STOCK TRADER :: 4S LONG");

	dashboardSection(ns, "Portfolio");
	row("State", `${state} | tick ${session.ticks}`);
	row("Equity", `${cash(metrics.equity)} | ${cash(metrics.exposure)} invested (${pct(metrics.equity > 0 ? metrics.exposure / metrics.equity : 0)})`);
	row("Cash", `${cash(metrics.cash)} | reserve ${cash(reserveFloor)}`);
	row("Open P/L", `${signedCash(metrics.openPnl)} unrealized`);
	row("Profit total", `${signedCash(session.realized)} realized net | ${session.sells} closed trades`);
	row("Per trade", session.sells
		? `avg ${signedCash(session.realized / session.sells)} | last ${signedCash(session.lastTradePnl)} | ${session.winningTrades}W/${session.losingTrades}L`
		: "No closed trades yet");
	row("Positions", `${positions} open | ${session.buys} buys | ${session.sells} sells`);
	if (session.last && session.last !== "none") row("Last action", session.last);

	dashboardSection(ns, "Best signals");
	if (!candidates.length) row("Status", "No symbols above the entry threshold");
	for (const candidate of candidates) {
		const edge = expectedLongEdge(candidate.forecast, candidate.volatility);
		const held = candidate.longShares > 0 ? ` | held ${formatShares(candidate.longShares)}` : "";
		row(candidate.symbol, `forecast ${pct(candidate.forecast)} | volatility ${pct(candidate.volatility)} | edge ${pct(edge)}/tick${held}`);
	}

	dashboardSection(ns, "Guardrails");
	row("Exposure", `max ${pct(cfg.maxExposure)} | reserve ${pct(cfg.cashReserve)} minimum`);
	row("Access", "WSE + TIX + 4S TIX required; missing access stops trading safely");
}

function publishStatus(port, ns, market, cfg, session, commission, state, missing = []) {
	const rows = market.rows ?? market;
	const metrics = market.metrics ?? portfolioMetrics(ns.getServerMoneyAvailable(HOME), rows, commission);
	const reserveFloor = Math.max(cfg.cashFloor, metrics.equity * cfg.cashReserve);
	const positions = rows.filter(row => row.longShares > 0 || row.shortShares > 0).length;
	port.clear();
	port.write({
		type: "stock-status",
		version: 1,
		producerPid: ns.pid,
		generatedAt: Date.now(),
		heartbeatIntervalMs: 10_000,
		state,
		dryRun: cfg.dryRun,
		access: missing.length ? { ok: false, missing: [...missing] } : { ok: true, missing: [] },
		cash: metrics.cash,
		equity: metrics.equity,
		exposure: metrics.exposure,
		reserveFloor,
		openPnl: metrics.openPnl,
		realized: session.realized,
		lastTradePnl: session.lastTradePnl,
		avgTradePnl: session.sells ? session.realized / session.sells : 0,
		winningTrades: session.winningTrades,
		losingTrades: session.losingTrades,
		fees: session.fees,
		buys: session.buys,
		sells: session.sells,
		positions,
		ticks: session.ticks,
		last: session.last,
	});
}

function summarizeActions(actions) {
	if (!actions.length) return "No trades this tick";
	if (actions.length <= 3) return actions.join(" | ");
	return `${actions.slice(0, 3).join(" | ")} | +${actions.length - 3} more`;
}

function pct(value) {
	return `${(100 * Number(value || 0)).toFixed(2)}%`;
}

function cash(value) {
	const n = Number(value) || 0;
	const units = [[1e18, "Q"], [1e15, "q"], [1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
	for (const [threshold, suffix] of units) if (Math.abs(n) >= threshold) return `$${(n / threshold).toFixed(2)}${suffix}`;
	return `$${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}`;
}

function signedCash(value) {
	const n = Number(value) || 0;
	return `${n >= 0 ? "+" : "-"}${cash(Math.abs(n))}`;
}

function formatShares(value) {
	const n = Math.max(0, Number(value) || 0);
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return Math.round(n).toString();
}
