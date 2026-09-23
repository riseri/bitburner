/** Low-priority faction sharing, sized by the supervisor or JIT controller. */
/** @param {NS} ns */
export async function main(ns) {
	while (true) await ns.share();
}
