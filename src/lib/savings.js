import { isProgressionProgram } from "lib/programs.js";

export const SAVINGS_FILE = "data/savings.json";

// A durable goal is shared by all home spenders. No port or heartbeat is needed.
export function savingsEpoch(ns) {
    const r = ns.getResetInfo();
    return `${r.currentNode}:${r.lastNodeReset}:${r.lastAugReset}`;
}

export function readSavings(ns, spendingTarget = "") {
    try {
        const raw = ns.read(SAVINGS_FILE);
        if (!raw) return { amount: 0, floor: 0, label: "No savings goal" };
        const goal = JSON.parse(raw);
        if (goal.version !== 1 || !Number.isFinite(goal.amount) || goal.amount < 0 ||
            typeof goal.epoch !== "string" || typeof goal.label !== "string" || typeof goal.target !== "string") {
            throw new Error("Invalid savings goal; clear or replace it with savings.js");
        }
        if (goal.epoch !== savingsEpoch(ns)) return { ...goal, floor: 0, inactive: "Goal belongs to a previous reset" };
        const program = isProgressionProgram(goal.target);
        if ((goal.target === "TOR" && ns.hasTorRouter()) || (program && ns.fileExists(goal.target, "home"))) {
            return { ...goal, floor: 0, inactive: "Goal purchased" };
        }
        const authorizedPurchase = (program || goal.target === "TOR") && spendingTarget === goal.target;
        return { ...goal, floor: authorizedPurchase ? 0 : goal.amount };
    } catch (error) {
        // Test/legacy hosts without file APIs have no configured goal.
        if (typeof ns.read !== "function") return { amount: 0, floor: 0, label: "No savings goal" };
        return { amount: 0, floor: Infinity, label: "Savings configuration error", error: String(error.message || error) };
    }
}

export async function writeSavings(ns, amount, label, target = "", owner = "manual") {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Savings amount must be a finite nonnegative number");
    const goal = { version: 1, amount, label: String(label), target: String(target), owner, epoch: savingsEpoch(ns), updatedAt: Date.now() };
    await ns.write(SAVINGS_FILE, JSON.stringify(goal), "w");
    return goal;
}
