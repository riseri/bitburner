// Dedicated background worker. The daemon retains RAM until this PID exits.
/** @param {NS} ns */
export async function main(ns) {
	const target = String(ns.args[0]);
	await ns.weaken(target);
}
