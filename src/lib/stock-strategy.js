export function normalizeStockConfig(flags = {}) {
	const cfg = {
		cashReserve: fraction(flags["cash-reserve"] ?? 0.20),
		cashFloor: Math.max(0, Number(flags["cash-floor"]) || 0),
		maxExposure: fraction(flags["max-exposure"] ?? 0.80),
		maxPosition: fraction(flags["max-position"] ?? 0.25),
		entryForecast: Number(flags["entry-forecast"] ?? 0.60),
		exitForecast: Number(flags["exit-forecast"] ?? 0.55),
		minTrade: Math.max(0, Number(flags["min-trade"]) || 25e6),
		minHoldTicks: Number(flags["min-hold-ticks"] ?? 6),
		minProfitMultiple: Number(flags["min-profit-multiple"] ?? 1.15),
		maxBuysPerTick: Number(flags["max-buys-per-tick"] ?? 4),
		dryRun: asBoolean(flags["dry-run"] ?? false),
	};
	if (!(cfg.cashReserve >= 0 && cfg.cashReserve < 1)) throw new Error("cash-reserve must be in [0,1)");
	if (!(cfg.maxExposure > 0 && cfg.maxExposure <= 1)) throw new Error("max-exposure must be in (0,1]");
	if (!(cfg.maxPosition > 0 && cfg.maxPosition <= cfg.maxExposure)) throw new Error("max-position must be in (0,max-exposure]");
	if (!(cfg.entryForecast > 0.5 && cfg.entryForecast < 1)) throw new Error("entry-forecast must be in (0.5,1)");
	if (!(cfg.exitForecast >= 0.5 && cfg.exitForecast < cfg.entryForecast)) throw new Error("exit-forecast must be >=0.5 and below entry-forecast");
	if (!Number.isSafeInteger(cfg.minHoldTicks) || cfg.minHoldTicks < 1 || cfg.minHoldTicks > 100) throw new Error("min-hold-ticks must be 1..100");
	if (!(cfg.minProfitMultiple >= 1 && cfg.minProfitMultiple <= 10)) throw new Error("min-profit-multiple must be 1..10");
	if (!Number.isSafeInteger(cfg.maxBuysPerTick) || cfg.maxBuysPerTick < 1 || cfg.maxBuysPerTick > 20) throw new Error("max-buys-per-tick must be 1..20");
	return cfg;
}

export function expectedLongEdge(forecast, volatility) {
	const f = Number(forecast), v = Number(volatility);
	if (!Number.isFinite(f) || !Number.isFinite(v) || f < 0 || f > 1 || v < 0) return -Infinity;
	// The native market samples a move magnitude uniformly from 0..volatility.
	// This is the small-move expected directional return per tick.
	return (2 * f - 1) * v * 0.5;
}

export function rankLongCandidates(rows, cfg) {
	return rows
		.filter(row => row.shortShares === 0 && row.forecast >= cfg.entryForecast && row.longShares < row.maxShares)
		.map(row => ({ ...row, edge: expectedLongEdge(row.forecast, row.volatility) }))
		.filter(row => row.edge > 0)
		.sort((a, b) => (b.edge - a.edge) || (b.forecast - a.forecast) || a.symbol.localeCompare(b.symbol));
}

export function shouldExitLong(row, cfg) {
	return row.longShares > 0 && row.forecast <= cfg.exitForecast;
}

export function sharesForBudget(row, budget, commission) {
	const availableShares = Math.max(0, Math.floor(row.maxShares - row.longShares - row.shortShares));
	const spend = Math.max(0, Number(budget) - commission);
	if (!availableShares || spend <= 0 || !(row.ask > 0)) return 0;
	return Math.max(0, Math.min(availableShares, Math.floor(spend / row.ask)));
}

export function tradeHasEnoughEdge(row, shares, commission, cfg) {
	if (!(shares > 0)) return false;
	const edge = expectedLongEdge(row.forecast, row.volatility);
	if (!(edge > 0)) return false;
	const expectedMoveProfit = shares * row.ask * edge * cfg.minHoldTicks;
	const roundTripFriction = shares * Math.max(0, row.ask - row.bid) + 2 * commission;
	return expectedMoveProfit >= roundTripFriction * cfg.minProfitMultiple;
}

export function portfolioMetrics(cash, rows, commission) {
	let longValue = 0, shortValue = 0, openPnl = 0;
	for (const row of rows) {
		if (row.longShares > 0) {
			const value = Math.max(0, row.longShares * row.bid - commission);
			longValue += value;
			openPnl += value - row.longShares * row.longAvg;
		}
		if (row.shortShares > 0) {
			const value = Math.max(0, row.shortShares * (2 * row.shortAvg - row.ask) - commission);
			shortValue += value;
			openPnl += value - row.shortShares * row.shortAvg;
		}
	}
	const exposure = longValue + shortValue;
	return { cash, longValue, shortValue, exposure, equity: cash + exposure, openPnl };
}

function fraction(value) {
	const n = Number(value);
	const parsed = n > 1 ? n / 100 : n;
	return Number.isFinite(parsed) ? parsed : NaN;
}

function asBoolean(value) {
	if (typeof value === "boolean") return value;
	return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
