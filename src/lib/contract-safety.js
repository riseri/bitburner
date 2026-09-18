// These files have separate writers: self-test owns validation, manager owns
// quarantine and receipts. A failed or interrupted validation fails closed.
export function contractFiles() {
	return { validation: "contract-validation.txt", quarantine: "contract-quarantine.txt", receipts: "contract-attempts.txt" };
}

export function requiredSamples() { return 100; }

export function contractJson(value) {
	return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { $bigint: item.toString() } : item);
}

export function contractIdentity(host, file, type, data) {
	// Keep the full input, not a lossy hash: equal filenames are not equal contracts.
	return contractJson([host, file, type, data]);
}

export function solverRevision(ns) {
	const source = ns.read("contract-solvers.js");
	if (!source) throw new Error("Missing contract-solvers.js source; cannot validate revision");
	// Two independent 32-bit accumulators are a change detector, not a security signature.
	let a = 2166136261, b = 5381;
	for (let i = 0; i < source.length; i++) {
		a = Math.imul(a ^ source.charCodeAt(i), 16777619);
		b = Math.imul(b, 33) ^ source.charCodeAt(i);
	}
	return `v2:${source.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

export function readContractJson(ns, file, fallback) {
	if (!ns.fileExists(file, "home")) return fallback;
	try { return JSON.parse(ns.read(file)); }
	catch { throw new Error(`Invalid ${file}; submissions paused until state is repaired`); }
}

export function readValidation(ns) {
	const value = readContractJson(ns, contractFiles().validation, { schema: 1, status: "missing", types: {}, dummyFiles: [] });
	if (!value || value.schema !== 1 || !value.types || typeof value.types !== "object" || Array.isArray(value.types) ||
		!Array.isArray(value.dummyFiles)) throw new Error("Invalid contract-validation.txt schema");
	return value;
}

export function readQuarantine(ns) {
	const value = readContractJson(ns, contractFiles().quarantine, { schema: 1, types: {} });
	// Preserve existing quarantine decisions. Upgrading is not a pardon.
	if (Array.isArray(value) && value.every(type => typeof type === "string")) {
		return { schema: 1, types: Object.fromEntries(value.map(type => [type, { id: `legacy:${type}`, reason: "legacy quarantine" }])) };
	}
	if (!value || value.schema !== 1 || !value.types || typeof value.types !== "object" || Array.isArray(value.types) ||
		Object.values(value.types).some(record => !record || typeof record.id !== "string")) {
		throw new Error("Invalid contract-quarantine.txt schema");
	}
	return value;
}

export function readReceipts(ns) {
	const value = readContractJson(ns, contractFiles().receipts, { schema: 1, entries: {} });
	if (!value || value.schema !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
		throw new Error("Invalid contract-attempts.txt schema");
	}
	return value;
}

export function validationBlocker(report, quarantine, type, revision) {
	if (report.status === "running") return "self-test-running";
	if (report.status !== "complete" || report.revision !== revision) return "validation-required";
	const certificate = Object.hasOwn(report.types, type) ? report.types[type] : null;
	if (!certificate || certificate.passed !== true || certificate.deterministic !== true ||
		certificate.samples < requiredSamples() || !Number.isSafeInteger(certificate.samples) || certificate.failures !== 0) {
		return certificate?.failures > 0 ? "self-test-failed" : "validation-required";
	}
	const failure = Object.hasOwn(quarantine.types, type) ? quarantine.types[type] : null;
	if (failure && certificate.recoveredFailureId !== failure.id) return "solver-quarantined";
	return "";
}

export function isContractDummy(report, host, file) {
	return report.dummyFiles.some(dummy => dummy.host === host && dummy.file === file);
}

export function contractBoolean(value) {
	return typeof value === "boolean" ? value : !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

export async function saveContractJson(ns, file, value) {
	const text = contractJson(value);
	await ns.write(file, text, "w");
	if (ns.read(file) !== text) throw new Error(`Could not persist ${file}; submissions paused`);
}
