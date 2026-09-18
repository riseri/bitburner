import { SOLVERS, solveContractAsync } from "contract-solvers.js";
import { contractFixtures, fixtureMatches } from "lib/contract-fixtures.js";
import { contractFiles, solverRevision, readValidation, readQuarantine, requiredSamples, contractBoolean, saveContractJson } from "lib/contract-safety.js";

const HOME = "home";

/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["samples", 100], ["type", ""], ["retry-quarantined", false]]);
	ns.disableLog("ALL");
	if (ns.getHostname() !== HOME || ns.ps(HOME).some(p => p.filename === "contract-selftest.js" && p.pid !== ns.pid)) {
		ns.tprint("ERROR: Run only one contract self-test, on home."); return;
	}
	const samples = Number(flags.samples), requestedType = String(flags.type);
	if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000) throw new Error("samples must be 1..1000");
	if (requestedType && !Object.hasOwn(SOLVERS, requestedType)) throw new Error(`Unsupported solver: ${requestedType}`);
	const revision = solverRevision(ns), previous = readValidation(ns), quarantine = readQuarantine(ns);
	const types = requestedType ? [requestedType] : Object.keys(SOLVERS);
	const fixtures = contractFixtures();
	const available = new Set(ns.codingcontract.getContractTypes());
	const report = { schema: 1, revision, status: "running", producerPid: ns.pid, startedAt: Date.now(),
		types: previous.revision === revision ? { ...previous.types } : {},
		dummyFiles: previous.dummyFiles.map(dummy => ({ ...dummy })), currentType: "", currentSample: 0 };
	for (const type of types) delete report.types[type];
	let lastPublish = 0;
	const persist = async () => {
		if (solverRevision(ns) !== revision) throw new Error("Solver source changed during validation; restart self-test");
		report.generatedAt = Date.now();
		await saveContractJson(ns, contractFiles().validation, report);
		lastPublish = Date.now();
		ns.clearLog(); ns.print("CONTRACT VALIDATION");
		ns.print(`  ${report.currentType || "Starting"}: ${report.currentSample}/${samples} dummy contracts`);
		ns.print(`  Approval requires deterministic checks and ${requiredSamples()} successful dummy submissions per type.`);
	};
	const yieldControl = async () => {
		if (Date.now() - lastPublish >= 5_000) await persist();
		await ns.sleep(1);
	};
	// Revoke submissions before creating any dummy. Dummy and real filenames are
	// indistinguishable in the game; only explicit ownership records are safe.
	await persist();
	try {
		await cleanupDummies(ns, report); await persist();
		for (const type of types) {
			report.currentType = type; report.currentSample = 0;
			const result = { passed: false, deterministic: false, samples: 0, failures: 0, reason: "" };
			report.types[type] = result;
			if (!available.has(type)) { result.reason = "not available in this game version"; await persist(); continue; }
			try {
				if (!fixtures[type]?.length) throw new Error("Missing deterministic fixtures");
				for (const [data, expected] of fixtures[type]) {
					const solved = await solveContractAsync(type, data, yieldControl);
					if (!solved.supported || !fixtureMatches(type, solved.answer, expected)) throw new Error("Deterministic fixture failed");
				}
				result.deterministic = true;
				for (let sample = 0; sample < samples; sample++) {
					const file = ns.codingcontract.createDummyContract(type, HOME);
					if (!file) throw new Error("Dummy creation returned no filename");
					report.dummyFiles.push({ host: HOME, file });
					await persist();
					try {
						const data = ns.codingcontract.getData(file, HOME);
						const solved = await solveContractAsync(type, data, yieldControl);
						if (solverRevision(ns) !== revision) throw new Error("Solver changed before dummy submission");
						const reward = ns.codingcontract.attempt(solved.answer, file, HOME);
						if (typeof reward !== "string" || !reward.length) throw new Error("Game rejected dummy answer");
						result.samples++; report.currentSample++;
					} finally {
						await cleanupDummies(ns, report); await persist();
					}
					await yieldControl();
				}
				result.passed = result.samples >= requiredSamples();
				result.validatedAt = Date.now();
				if (!result.passed) result.reason = "too few samples for automatic submissions";
				// No automatic pardons. Explicit recovery names the exact old failure;
				// a newer failure cannot be cleared by this older validation result.
				if (result.passed && contractBoolean(flags["retry-quarantined"]) && Object.hasOwn(quarantine.types, type)) {
					result.recoveredFailureId = quarantine.types[type].id;
				}
			} catch (error) {
				result.failures++; result.passed = false; result.reason = String(error?.message ?? error);
			}
			await persist();
		}
		report.status = "complete"; report.completedAt = Date.now();
		await persist();
	} catch (error) {
		// Leave status=running on source/persistence failures. No partial batch of
		// approvals is promoted after an interrupted test run.
		ns.tprint(`Contract validation stopped: ${String(error?.message ?? error)}. Submissions remain paused.`);
		return;
	}
	const passed = types.filter(type => report.types[type]?.passed).length;
	const failed = types.filter(type => report.types[type]?.failures > 0).length;
	ns.tprint(`Contract validation: ${passed} approved, ${failed} failed, ${types.length - passed - failed} unapproved. See contract-validation.txt.`);
}

async function cleanupDummies(ns, report) {
	const keep = [];
	for (const dummy of report.dummyFiles) {
		// Never delete an arbitrary *.cct sweep. Only names returned to this tester.
		if (dummy.host !== HOME || typeof dummy.file !== "string" || !dummy.file.endsWith(".cct")) {
			throw new Error("Invalid dummy ownership record");
		}
		if (ns.ls(HOME, ".cct").includes(dummy.file)) ns.rm(dummy.file, HOME);
		if (ns.ls(HOME, ".cct").includes(dummy.file)) keep.push(dummy);
	}
	report.dummyFiles = keep;
	if (keep.length) throw new Error("Could not remove owned dummy; cleanup required before further validation");
}
