import { augmentationFundingCost, augmentationReputationStrategy } from "lib/augmentation-funding.js";

// Text-only presentation helpers. No ports, timers, process control or game state.
// Keep the same bounded width on Windows and in the supervisor's log window.
const DASHBOARD_WIDTH = 78;
const LABEL_WIDTH = 14;

export function renderFactionProgression(ns, next, currentCash) {
    if (!next) return;
    const row = (label, value) => dashboardRow(ns, label, value);
    const number = n => Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "unknown";
    const money = n => Number.isFinite(n) ? "$" + number(n) : "unknown";
    const funding = next.fundingCost ?? augmentationFundingCost(next);
    dashboardSection(ns, "Faction progression");
    row("Augmentation", next.name); row("Faction", next.faction);
    row("Strategy", next.progressionStrategy || augmentationReputationStrategy(next));
    row("Rep remaining", number(next.repGap));
    row("Work rate", next.rate > 0 ? number(next.rate) + " rep/s" : "unknown");
    row("Work ETA", dashboardTime(next.workEtaMs));
    row("Donation", money(next.donationCost)); row("Donation ETA", dashboardTime(next.donationEtaMs));
    row("Purchase", money(next.price));
    if (next.chainCost) row("Chain purchase", money(next.chainCost));
    row("Funding goal", money(funding)); row("Funding", money(currentCash) + " / " + money(funding));
    row("Reason", next.explanation || "Selected augmentation acquisition");
}

export function renderSchedulerCapacity(ns, capacity, details = false) {
    if (!capacity) return;
    const c = capacity, ram = n => n >= 1048576 ? `${(n/1048576).toFixed(2)} PB` : n >= 1024 ? `${(n/1024).toFixed(2)} TB` : `${n.toFixed(2)} GB`;
    dashboardSection(ns, "Scheduler capacity");
    dashboardRow(ns, "Limit", c.limitingFactor);
    dashboardRow(ns, "Targets", `${c.targets.active} / ${c.targets.mode === "auto" ? `AUTO (max ${c.targets.limit})` : c.targets.limit}`);
    dashboardRow(ns, "Worker RAM", `${ram(c.ram.used)} / ${ram(c.ram.total)} (${(100*c.ram.utilization).toFixed(1)}%)`);
    dashboardRow(ns, "Batch / launch", `${c.batchRate.used.toFixed(2)} / ${c.batchRate.limit.toFixed(2)} | ${c.launches.recent} / ${c.launches.limit}`);
    dashboardRow(ns, "Workers", `${c.workers.committed} / ${c.workers.limit}`);
    dashboardRow(ns, "XP pressure", c.xp.constrained ? `${ram(c.xp.allocatedRam)} / ${ram(c.xp.desiredRam)} desired` : "none");
    if (c.targets.next) dashboardRow(ns, "Next candidate", c.targets.next.name);
    if (c.admission) {
        dashboardRow(ns, "Admission", `${c.admission.decision} | ${c.admission.candidate || c.admission.reason}`);
        if (c.admission.marginalIncome > 0) dashboardRow(ns, "Marginal model", `+$${Math.round(c.admission.marginalIncome).toLocaleString()}/s | ${c.admission.expectedLanes} lanes`);
    }
    if (details) for (const reason of c.reasons) dashboardRow(ns, "Constraint", reason);
    if (details && c.homeGw) {
        const h = c.homeGw;
        dashboardSection(ns, "Home G/W");
        dashboardRow(ns, "State", `${h.state} | ${h.reason}`);
        if (h.enabled) {
            dashboardRow(ns, "Cores", `${h.cores} / ${h.maxCores} | ${h.coreBonus.toFixed(3)}x`);
            dashboardRow(ns, "G/W RAM", `${ram(h.runningRam)} active | ${ram(h.safeRam)} safe free`);
            dashboardRow(ns, "Protected", `${ram(h.unrelatedRam)} services/other | ${ram(h.protectedRam)} reserve`);
            dashboardRow(ns, "Share", `${ram(h.reclaimableShareRam)} reclaimable`);
            dashboardRow(ns, "Held", `${ram(h.temporalRam)} temporal reservations`);
            dashboardRow(ns, "Usage", `${((h.recentUsage?.batchFraction || 0)*100).toFixed(1)}% recent active batches | ${(h.recentUsage?.ramSeconds || 0).toFixed(0)} GB-seconds`);
            dashboardRow(ns, "Effect", `${(h.threadsSaved || 0).toFixed(1)} equivalent remote threads saved`);
        }
    }
}

export function dashboardFit(value, width) {
	const text = String(value ?? "n/a").replace(/\x1b\[[0-9;]*m/g, "");
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 3))}...`;
}

export function dashboardTitle(ns, title) {
	// Preserve identifiers/casing in titles because the supervisor also consumes daemon logs.
	const heading = ` ${String(title)} `;
	ns.print(`╔═${heading}${"═".repeat(Math.max(0, DASHBOARD_WIDTH - heading.length - 3))}╗`);
}

export function dashboardSection(ns, title) {
	const heading = ` ${String(title).toUpperCase()} `;
	// A breathing line matters more than another ornament in Bitburner's dense log windows.
	ns.print("");
	ns.print(`╟─${heading}${"─".repeat(Math.max(0, DASHBOARD_WIDTH - heading.length - 3))}╢`);
}

export function dashboardRow(ns, label, value) {
	// Keep the row schema deliberately simple: the supervisor and simulation tools
	// consume these same logs, while the title/section bands provide visual structure.
	const prefix = `  ${dashboardFit(label, LABEL_WIDTH).padEnd(LABEL_WIDTH)} `;
	const continuation = " ".repeat(prefix.length);
	const width = DASHBOARD_WIDTH - prefix.length;
	// Continuations retain the full message instead of hiding the cause of a fault.
	let rest = String(value ?? "n/a").replace(/\s+/g, " ").trim() || "n/a";
	let first = true;
	while (rest.length) {
		let end = Math.min(rest.length, width);
		if (end < rest.length) {
			const space = rest.lastIndexOf(" ", end);
			if (space > 0) end = space;
		}
		ns.print((first ? prefix : continuation) + rest.slice(0, end));
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
	dashboardSection(ns, "Auto target ranking / details");
	ns.print(`║ ${"Target".padEnd(22)} ${"Next 10m/s".padStart(13)} ${"Steady/s".padStart(13)} ${"Prep".padStart(9)} ║`);
	for (const entry of targets.slice(0, limit)) {
		const rate = value => dashboardFit(String(value ?? "n/a").replace(/\/s$/, ""), 13).padStart(13);
		const prep = entry.prep === "0ms" ? "ready" : entry.prep;
		ns.print(`║${entry.selected ? ">" : " "} ${dashboardFit(entry.name, 22).padEnd(22)} ` +
			`${rate(entry.effective)} ${rate(entry.steady)} ${dashboardFit(prep, 9).padStart(9)} ║`);
	}
}
