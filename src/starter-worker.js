/** Early-game worker; supervisor.js fills free home and rooted network RAM. @param {NS} ns */
export async function main(ns) {
	const target = String(ns.args[0] || "n00dles");
	ns.disableLog("ALL");
	while (true) {
		if (!ns.hasRootAccess(target)) {
			try { ns.nuke(target); } catch { /* Wait until the server can be rooted. */ }
			if (!ns.hasRootAccess(target)) {
				await ns.sleep(5_000);
				continue;
			}
		}
		const action = starterAction(ns.getServerMoneyAvailable(target), ns.getServerMaxMoney(target),
			ns.getServerSecurityLevel(target), ns.getServerMinSecurityLevel(target));
		if (action === "weaken") await ns.weaken(target);
		else if (action === "grow") await ns.grow(target);
		else await ns.hack(target);
	}
}

export function starterAction(money, maxMoney, security, minSecurity) {
	if (security > minSecurity + 3) return "weaken";
	if (money < maxMoney * 0.90) return "grow";
	return "hack";
}
