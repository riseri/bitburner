const HOME = "home", FORMULAS = "Formulas.exe";

/** Live Darknet timing/capacity estimates without importing unrelated formula APIs. */
export function darknetFormulaMetrics(ns, details, threads = 1) {
	try {
		if (!ns.fileExists(FORMULAS, HOME)) return null;
		const api = ns.formulas?.dnet;
		if (!api || ["getAuthenticateTime", "getHeartbleedTime", "getExpectedRamBlockRemoved"].some(method => typeof api[method] !== "function")) return null;
		const count = Math.max(1, Number(threads) || 1), player = ns.getPlayer();
		const length = Math.max(0, Number(details.passwordLength) || 0);
		const authenticateMin = Number(api.getAuthenticateTime(details, count, player, 0));
		const authenticateMax = Number(api.getAuthenticateTime(details, count, player, length));
		const heartbleed = Number(api.getHeartbleedTime(details, count, player));
		const ramPerCall = Number(api.getExpectedRamBlockRemoved(details, count, player));
		if (![authenticateMin, authenticateMax, heartbleed, ramPerCall].every(Number.isFinite)) return null;
		return { authenticateMin: Math.max(0, authenticateMin), authenticateMax: Math.max(0, authenticateMax),
			heartbleed: Math.max(0, heartbleed), ramPerCall: Math.max(0, ramPerCall), formulas: true };
	} catch { return null; }
}
