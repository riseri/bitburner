// Text-only presentation helpers. No ports, timers, process control or game state.
// Keep the same bounded width on Windows and in the supervisor's log window.
export function dashboardFit(value, width) {
	const text = String(value ?? "n/a").replace(/\x1b\[[0-9;]*m/g, "");
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 3))}...`;
}

export function dashboardSection(ns, title) {
	const heading = ` ${String(title).toUpperCase()} `;
	ns.print(heading + "─".repeat(Math.max(0, 78 - heading.length)));
}

export function dashboardRow(ns, label, value) {
	const prefix = `  ${dashboardFit(label, 14).padEnd(14)} `;
	const width = 78 - prefix.length;
	// Continuations retain the full message instead of hiding the cause of a fault.
	let rest = String(value ?? "n/a").replace(/\s+/g, " ").trim() || "n/a";
	let first = true;
	while (rest.length) {
		let end = Math.min(rest.length, width);
		if (end < rest.length) {
			const space = rest.lastIndexOf(" ", end);
			if (space > 0) end = space;
		}
		ns.print((first ? prefix : " ".repeat(prefix.length)) + rest.slice(0, end));
		rest = rest.slice(end).trimStart();
		first = false;
	}
}

export function dashboardTime(ms) {
	if (!Number.isFinite(ms)) return "n/a";
	const n = Math.max(0, ms);
	if (n < 1_000) return `${Math.round(n)}ms`;
	if (n < 60_000) return `${(n / 1_000).toFixed(1)}s`;
	const seconds = Math.floor(n / 1_000);
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3_600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

export function dashboardCounters(counters = {}) {
	return ["H", "W1", "G", "W2"].map(phase => `${phase}:${Number(counters[phase]) || 0}`).join("  ");
}

export function dashboardTargets(ns, targets, limit = 4) {
	if (!targets?.length) return;
	dashboardSection(ns, "Startup target ranking snapshot");
	ns.print(`  ${"Host".padEnd(22)} ${"10m avg/s".padStart(13)} ${"Steady/s".padStart(13)} ${"Prep".padStart(9)}`);
	for (const entry of targets.slice(0, limit)) {
		const rate = value => dashboardFit(String(value ?? "n/a").replace(/\/s$/, ""), 13).padStart(13);
		const prep = entry.prep === "0ms" ? "ready" : entry.prep;
		ns.print(`${entry.selected ? ">" : " "} ${dashboardFit(entry.name, 22).padEnd(22)} ` +
			`${rate(entry.effective)} ${rate(entry.steady)} ${dashboardFit(prep, 9).padStart(9)}`);
	}
}
