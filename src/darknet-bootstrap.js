const AGENT = "darknet-agent.js", CRAWLER_RAM = 15.9;

/** 16 GB Darknet entrypoint. Dynamic RAM enforcement still covers every API used. @param {NS} ns */
export async function main(ns) {
	const reserved = ns.ramOverride(CRAWLER_RAM);
	if (reserved < CRAWLER_RAM) throw new Error(`Darknet crawler needs ${CRAWLER_RAM.toFixed(2)} GB; reserved ${reserved.toFixed(2)} GB`);
	const crawler = await ns.dynamicImport(AGENT);
	await crawler.main(ns);
}
