import { readSavings } from "lib/savings.js";
import { PORTS } from "lib/ports.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { readProgressionSnapshot } from "lib/progression-objective.js";
import { evaluateHomeInvestment } from "lib/home-economics.js";

// One quote snapshot, one upgrade per invocation. No resident Singularity cost.
export async function main(ns) {
    const [epoch, request = ""] = ns.args;
    if (epoch !== resetEpoch(ns.getResetInfo()) || !singularityAvailable(ns.getResetInfo())) return;
    const home = ns.getServer("home");
    const quote = { type: "home-capital-quote", version: 1, producerPid: ns.pid, resetEpoch: epoch, generatedAt: Date.now(),
        ram: home.maxRam, cores: home.cpuCores, ramCost: ns.singularity.getUpgradeHomeRamCost(), coreCost: ns.singularity.getUpgradeHomeCoresCost() };
    const port = ns.getPortHandle(PORTS.HOME_UPGRADE_STATUS); port.clear(); port.write(quote);
    if (!request) return;
    let expected;
    try { expected = JSON.parse(request); } catch { return; }
    if (!expected || typeof expected !== "object") return;
    const kind = expected.kind, target = kind === "cores" ? "home:cores" : "home:performance-ram";
    if (!["cores", "ram"].includes(kind) || !Number.isFinite(expected.generatedAt) || Date.now() < expected.generatedAt ||
        Date.now() - expected.generatedAt > 15000 || expected.resetEpoch !== epoch ||
        expected.ram !== quote.ram || expected.cores !== quote.cores ||
        expected.cost !== (kind === "cores" ? quote.coreCost : quote.ramCost)) return;
    // Copy only when running remotely; savings file is authoritative on home.
    if (ns.getHostname() !== "home" && ns.fileExists("data/savings.json", "home") &&
        !await ns.scp("data/savings.json", ns.getHostname(), "home")) return;
    const goal = readSavings(ns, target), snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek();
    const objective = readProgressionSnapshot(ns);
    const policy = ns.getPortHandle(PORTS.HOME_CAPACITY).peek();
    if (policy?.type !== "home-capacity-policy" || policy.resetEpoch !== epoch || !policy.performanceAllowed ||
        !Number.isFinite(policy.generatedAt) || !Number.isInteger(policy.producerPid) ||
        Date.now() < policy.generatedAt || Date.now() - policy.generatedAt > 15000 || !ns.isRunning(policy.producerPid)) return;
    if (snapshot?.type !== "jit-status" || !Number.isInteger(snapshot.pid) || !ns.isRunning(snapshot.pid)) return;
    if (goal.inactive || goal.error || goal.owner !== "supervisor" || goal.target !== target ||
        ns.getServerMoneyAvailable("home") < goal.amount) return;
    const value = evaluateHomeInvestment(snapshot, quote, kind, objective);
    if (!value.ok || resetEpoch(ns.getResetInfo()) !== epoch) return;
    // No await between final live quote/state/floor checks and the transaction.
    const liveHome = ns.getServer("home"), liveCost = kind === "cores" ? ns.singularity.getUpgradeHomeCoresCost() : ns.singularity.getUpgradeHomeRamCost();
    const liveFloor = readSavings(ns, target).floor;
    if (liveHome.maxRam !== quote.ram || liveHome.cpuCores !== quote.cores || liveCost !== value.cost ||
        ns.getServerMoneyAvailable("home") - liveCost < Math.max(liveFloor, goal.amount - value.cost)) return;
    if (kind === "cores") ns.singularity.upgradeHomeCores();
    else ns.singularity.upgradeHomeRam();
}
