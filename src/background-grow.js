// Dedicated background worker. No JIT ports or active-target recovery hooks.
/** @param {NS} ns */
export async function main(ns) {
	const target = String(ns.args[0]);
	await ns.grow(target);
}
