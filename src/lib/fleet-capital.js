import { resetEpoch } from "lib/progression-protocol.js";

export function fleetInvestmentTarget(candidate) {
    return `fleet:${candidate.name || "new"}:${candidate.ram}`;
}

// A report is advice, never spending authority. The supervisor arbitrates the goal;
// the fleet manager re-quotes and checks all reserves at the actual transaction.
export function readFleetCapitalRequest(ns, status, now = Date.now()) {
    try {
        const request = status?.cloud?.capitalRequest;
        if (status?.type !== "fleet-status" || !status.cloud.enabled || status.cloud.error ||
            !request || request.version !== 1 || request.resetEpoch !== resetEpoch(ns.getResetInfo()) ||
            request.producerPid !== status.producerPid || request.target !== fleetInvestmentTarget(request.candidate) ||
            !Number.isFinite(request.amount) || request.amount <= 0 || request.priority !== 79 ||
            !Number.isFinite(request.generatedAt) || request.generatedAt > now || now - request.generatedAt > 15000 ||
            !Number.isFinite(status.generatedAt) || status.generatedAt > now || now - status.generatedAt > 15000 ||
            !ns.ps("home").some(p => p.pid === request.producerPid && p.filename === "fleet-manager.js")) return null;
        return request;
    } catch { return null; }
}
