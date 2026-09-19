/** Disposable worker. It deliberately owns no durable state. @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	while (true) {
		try {
			for (const file of ns.ls(ns.getHostname(), ".cache")) ns.dnet.openCache(file, true);
			await ns.dnet.phishingAttack();
		} catch { await ns.sleep(5_000); }
	}
}

