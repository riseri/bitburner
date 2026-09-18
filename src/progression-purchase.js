import { claimAction, publishAction, validateRequest } from "lib/progression-protocol.js";

/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const request = claimAction(ns, ["tor", "program"]);
	if (!request) return;
	try {
		const tor = request.kind === "tor";
		if (tor ? ns.hasTorRouter() : ns.fileExists(request.target, "home")) {
			publishAction(ns, request, "succeeded", "already-owned"); return;
		}
		if (!tor && !ns.hasTorRouter()) { publishAction(ns, request, "blocked", "tor-required"); return; }
		const cost = tor ? 200_000 : ns.singularity.getDarkwebProgramCost(request.target);
		if (!Number.isFinite(cost) || cost <= 0) { publishAction(ns, request, "blocked", "invalid-price"); return; }
		const cash = ns.getServerMoneyAvailable("home");
		const requiredCash = cost / (1 - request.reserve);
		if (!Number.isFinite(cash) || cash < requiredCash) {
			// The shopping cart still has parental controls.
			publishAction(ns, request, "blocked", "insufficient-cash", { cost, requiredCash }); return;
		}
		const error = validateRequest(request, ns.getResetInfo());
		if (error) { publishAction(ns, request, "blocked", error); return; }
		const purchased = tor ? ns.singularity.purchaseTor() : ns.singularity.purchaseProgram(request.target);
		const owned = tor ? ns.hasTorRouter() : ns.fileExists(request.target, "home");
		publishAction(ns, request, purchased && owned ? "succeeded" : "failed",
			purchased && owned ? `Purchased ${request.target}` : "purchase-not-confirmed", { cost });
	} catch (error) {
		publishAction(ns, request, "failed", String(error?.message ?? error));
	}
}
