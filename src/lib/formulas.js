const HOME = "home", FORMULAS = "Formulas.exe", CYCLES_PER_SECOND = 5;

/** Return a live Formulas namespace only while Formulas.exe is available. */
export function formulaGroup(ns, group, methods = []) {
	try {
		if (!ns.fileExists(FORMULAS, HOME)) return null;
		const api = ns.formulas?.[group];
		if (!api || methods.some(method => typeof api[method] !== "function")) return null;
		return api;
	} catch { return null; }
}

export function hackingFormulasAvailable(ns) {
	return Boolean(formulaGroup(ns, "hacking", ["hackPercent", "hackChance", "hackTime", "growTime", "weakenTime", "growThreads"]));
}

/** Exact model of a fully prepared target, or null when formulas are unavailable. */
export function preparedHackingModel(ns, target) {
	const api = formulaGroup(ns, "hacking", ["hackPercent", "hackChance", "hackTime", "growTime", "weakenTime", "growThreads"]);
	if (!api) return null;
	try {
		const player = ns.getPlayer(), server = { ...ns.getServer(target) };
		const maxMoney = Number(server.moneyMax), minSecurity = Number(server.minDifficulty);
		if (!(maxMoney > 0) || !Number.isFinite(minSecurity) || minSecurity >= 100) return null;
		server.moneyAvailable = maxMoney;
		server.hackDifficulty = minSecurity;
		const hackPercent = Number(api.hackPercent(server, player));
		const chance = Number(api.hackChance(server, player));
		const times = { H: Number(api.hackTime(server, player)), G: Number(api.growTime(server, player)), W: Number(api.weakenTime(server, player)) };
		if (![hackPercent, chance, ...Object.values(times)].every(Number.isFinite) || hackPercent <= 0 || times.W <= 0) return null;
		return {
			maxMoney, minSecurity, hackPercent: clamp(hackPercent, 0, 1), chance: clamp(chance, 0, 1), times, formulas: true,
			growthAnalyze(multiplier, cores = 1) {
				if (!(multiplier > 1)) return 0;
				try {
					const future = { ...server, moneyAvailable: Math.max(0, maxMoney / multiplier) };
					const threads = Number(api.growThreads(future, player, maxMoney, Math.max(1, Number(cores) || 1)));
					return Number.isFinite(threads) && threads >= 0 ? threads : Infinity;
				} catch { return Infinity; }
			},
		};
	} catch { return null; }
}

/** Exact grow threads at minimum security for a hypothetical balance. */
export function formulaGrowThreads(ns, target, startingMoney, targetMoney, cores = 1) {
	const api = formulaGroup(ns, "hacking", ["growThreads"]);
	if (!api) return null;
	try {
		const server = { ...ns.getServer(target) };
		server.hackDifficulty = Number(server.minDifficulty);
		server.moneyAvailable = Math.max(0, Number(startingMoney) || 0);
		const value = Number(api.growThreads(server, ns.getPlayer(), Number(targetMoney), Math.max(1, Number(cores) || 1)));
		return Number.isFinite(value) && value >= 0 ? value : null;
	} catch { return null; }
}

export function formulaWeakenEffect(ns, threads = 1, cores = 1) {
	const api = formulaGroup(ns, "hacking", ["weakenEffect"]);
	if (!api) return null;
	try {
		const value = Number(api.weakenEffect(Number(threads), Math.max(1, Number(cores) || 1)));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch { return null; }
}

/** Rank offered faction work and estimate base reputation gain. */
export function factionWorkAnalysis(ns, faction, types, player = null) {
	const api = formulaGroup(ns, "work", ["factionGains"]);
	if (!api) return null;
	try {
		const person = player || ns.getPlayer(), favor = Number(ns.singularity.getFactionFavor(faction)) || 0;
		const sharePower = Math.max(1, Number(typeof ns.getSharePower === "function" ? ns.getSharePower() : 1) || 1);
		const options = types.map(workType => {
			const gains = api.factionGains(person, workType, favor);
			// factionGains already includes the live sharing bonus for every work type.
			const reputationPerSecond = Number(gains?.reputation) * CYCLES_PER_SECOND;
			return { workType, reputationPerSecond };
		}).filter(option => Number.isFinite(option.reputationPerSecond) && option.reputationPerSecond >= 0)
			.sort((a, b) => b.reputationPerSecond - a.reputationPerSecond);
		return options.length ? { ...options[0], options, sharePower, formulas: true } : null;
	} catch { return null; }
}

/** Current API uses formulas.reputation; work is retained for older game versions. */
export function formulaDonationForRep(ns, reputation, player = null) {
	for (const group of ["reputation", "work"]) {
		const api = formulaGroup(ns, group, ["donationForRep"]);
		if (!api) continue;
		try {
			const value = Number(api.donationForRep(Number(reputation), player || ns.getPlayer()));
			if (Number.isFinite(value) && value > 0) return value;
		} catch {}
	}
	return null;
}

export function formulaFavorProjection(ns, faction) {
	const api = formulaGroup(ns, "reputation", ["calculateRepToFavor", "calculateFavorToRep"]);
	if (!api) return null;
	try {
		const current = Number(ns.singularity.getFactionFavor(faction)) || 0;
		const totalRep = Number(api.calculateFavorToRep(current)) + Number(ns.singularity.getFactionRep(faction));
		const projected = Number(api.calculateRepToFavor(totalRep));
		return Number.isFinite(projected) ? projected : null;
	} catch { return null; }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
