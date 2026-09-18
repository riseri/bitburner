import { PORTS } from "lib/ports.js";
import { claimAction, publishAction, validateRequest, freshStatus, routeBetween, resetEpoch } from "lib/progression-protocol.js";

/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const request = claimAction(ns, ["backdoor"]);
	if (!request) return;
	let original = "", lastReached = "", parents = {};
	let outcome = { state: "failed", reason: "backdoor-not-confirmed" };
	let restoration = "not-needed";
	try {
		const error = backdoorBlocker(ns, request);
		if (error) { outcome = { state: error === "already-installed" ? "succeeded" : "blocked", reason: error }; return; }
		const fleet = ns.getPortHandle((request.fleetPort ?? PORTS.FLEET_STATUS)).peek();
		if (!freshStatus(fleet, "fleet-status")) { outcome = { state: "blocked", reason: "stale-network" }; return; }
		parents = fleet.network?.parents ?? {};
		original = lastReached = ns.singularity.getCurrentServer();
		const route = routeBetween(parents, original, request.target);
		if (!route.length) { outcome = { state: "blocked", reason: "invalid-route" }; return; }
		for (const host of route.slice(1)) {
			if (ns.singularity.getCurrentServer() !== lastReached || ns.singularity.isBusy()) {
				outcome = { state: "blocked", reason: "player-took-control" }; return;
			}
			if (!ns.singularity.connect(host)) { outcome = { state: "failed", reason: `connection-failed: ${host}` }; return; }
			lastReached = host;
		}
		// Recheck after navigation, immediately before starting the costly action.
		const beforeInstall = backdoorBlocker(ns, request);
		if (beforeInstall) { outcome = { state: beforeInstall === "already-installed" ? "succeeded" : "blocked", reason: beforeInstall }; return; }
		publishAction(ns, request, "running", `Installing backdoor on ${request.target}`);
		await ns.singularity.installBackdoor();
		// Expiry guards admission, not the duration of an already-started backdoor.
		if (resetEpoch(ns.getResetInfo()) !== request.resetEpoch) {
			outcome = { state: "failed", reason: "reset-changed" }; return;
		}
		const installed = ns.getServer(request.target).backdoorInstalled === true;
		outcome = { state: installed ? "succeeded" : "failed", reason: installed ? `Installed ${request.target} backdoor` : "backdoor-not-confirmed" };
	} catch (error) {
		outcome = { state: "failed", reason: String(error?.message ?? error) };
	} finally {
		try {
			if (original && lastReached !== original && resetEpoch(ns.getResetInfo()) === request.resetEpoch) {
				// Human touched the wheel. Do not fight them for the aux cable.
				if (ns.singularity.getCurrentServer() !== lastReached || ns.singularity.isBusy()) restoration = "manual-control-preserved";
				else {
					const route = routeBetween(parents, lastReached, original);
					restoration = route.length ? "restored" : "restore-route-missing";
					for (const host of route.slice(1)) {
						if (!ns.singularity.connect(host)) { restoration = `restore-failed: ${host}`; break; }
					}
				}
			}
		} catch (error) { restoration = `restore-failed: ${String(error?.message ?? error)}`; }
		publishAction(ns, request, outcome.state, outcome.reason, { restoration });
	}
}

function backdoorBlocker(ns, request) {
	const error = validateRequest(request, ns.getResetInfo());
	if (error) return error;
	if (!ns.serverExists(request.target)) return "server-missing";
	const server = ns.getServer(request.target);
	if (server.backdoorInstalled) return "already-installed";
	if (!ns.hasRootAccess(request.target)) return "root-required";
	if (!Number.isFinite(server.requiredHackingSkill)) return "invalid-server-state";
	if (ns.getHackingLevel() < server.requiredHackingSkill) return "hacking-level-required";
	if (ns.singularity.isBusy()) return "player-busy";
	return "";
}
