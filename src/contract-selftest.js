import { SOLVERS, solveContract } from "contract-solvers.js";

const HOME = "home";
const QUARANTINE_FILE = "contract-quarantine.txt";

/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const quarantine = loadQuarantine(ns);
	let passed = 0;
	let failed = 0;
	let skipped = 0;

	for (const type of Object.keys(SOLVERS)) {
		const filename = ns.codingcontract.createDummyContract(type, HOME);
		if (!filename) {
			skipped++;
			ns.tprint(`SKIP ${type}: unable to create dummy contract`);
			continue;
		}

		try {
			const data = ns.codingcontract.getData(filename, HOME);
			const solved = solveContract(type, data);
			const reward = solved.supported
				? ns.codingcontract.attempt(solved.answer, filename, HOME)
				: "";

			if (reward) {
				passed++;
				quarantine.delete(type);
				ns.tprint(`PASS ${type}`);
			} else {
				failed++;
				quarantine.add(type);
				ns.tprint(`FAIL ${type} -> quarantined`);
			}
		} catch (error) {
			failed++;
			quarantine.add(type);
			ns.tprint(`FAIL ${type}: ${String(error?.message ?? error)} -> quarantined`);
		}

		await ns.sleep(1);
	}

	ns.write(QUARANTINE_FILE, JSON.stringify([...quarantine].sort()), "w");
	ns.tprint(`Contract self-test: ${passed} passed, ${failed} failed, ${skipped} skipped, ${quarantine.size} quarantined.`);
}

function loadQuarantine(ns) {
	if (!ns.fileExists(QUARANTINE_FILE, HOME)) return new Set();
	try {
		const value = JSON.parse(ns.read(QUARANTINE_FILE));
		return new Set(Array.isArray(value) ? value : []);
	} catch {
		return new Set();
	}
}
