import { PORTS } from "lib/ports.js";
import { resetEpoch, augmentationInstallationPending } from "lib/progression-protocol.js";
import { CLOUD_SERVICES, planServicePlacement, serviceProcesses } from "lib/service-hosts.js";
import { starterWorkers } from "lib/starter-pool.js";
import { readSavings, refreshRemoteSavings } from "lib/savings.js";

// Cloud APIs stay outside the supervisor's small resident RAM budget.
/** @param {NS} ns */
export async function main(ns) {
    let request;
    try { request = JSON.parse(String(ns.args[0])); } catch { return; }
    const port = ns.getPortHandle(PORTS.SERVICE_HOSTING);
    const live = () => request?.type === "service-hosting-request" && request.version === 1 &&
        request.resetEpoch === resetEpoch(ns.getResetInfo()) && request.requestId === port.peek()?.requestId &&
        Number.isFinite(request.createdAt) && Number.isFinite(request.expiresAt) &&
        request.expiresAt > request.createdAt && request.expiresAt - request.createdAt <= 60000 &&
        Date.now() >= request.createdAt && Date.now() < request.expiresAt && ns.isRunning(request.ownerPid);
    if (!live() || !Array.isArray(request.services) || !request.services.length || request.services.length > 3 ||
        new Set(request.services).size !== request.services.length ||
        request.services.some(name => !CLOUD_SERVICES.includes(name)) ||
        !Number.isFinite(request.keepHomeRam) || request.keepHomeRam < 0) return;
    const publish = (state, reason, extra = {}) => {
        if (!live()) return;
        port.clear(); port.write({ type: "service-hosting-result", version: 1,
            requestId: request.requestId, resetEpoch: request.resetEpoch, generatedAt: Date.now(), state, reason, ...extra });
    };
    try {
        const services = request.services.map(name => {
            const matches = serviceProcesses(ns, name);
            if (matches.length > 1) throw new Error(`Multiple ${name} processes; resolve duplicate ownership first`);
            const movable = Array.isArray(request.movablePids) && request.movablePids.includes(matches[0]?.pid);
            return { name, ram: ns.getScriptRam(name, "home") * Math.max(1, matches[0]?.threads || 1), host: movable ? "" : matches[0]?.host || "" };
        });
        const servers = ns.cloud.getServerNames(), workerRam = ns.getScriptRam("starter-worker.js", "home");
        const bins = ["home", ...servers].map(host => {
            const processes = ns.ps(host);
            const reclaim = starterWorkers(ns, host).reduce((n, p) => n + workerRam * p.threads, 0) +
                processes.filter(p => p.pid === ns.pid || request.services.includes(p.filename) ||
                    host === "home" && request.reclaimAugmentation && p.filename === "augmentation-manager.js")
                    .reduce((n, p) => n + ns.getScriptRam(p.filename, host) * Math.max(1, p.threads || 1), 0);
            return { host, capacity: Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host) + reclaim -
                (host === "home" ? request.keepHomeRam : 0)) };
        });
        const purchases = [], limit = ns.cloud.getServerLimit(), ramLimit = ns.cloud.getRamLimit();
        const total = services.reduce((n, s) => n + s.ram, 0);
        if (servers.length < limit) for (let ram = 2; ram <= ramLimit && ram < total * 2; ram *= 2)
            purchases.push({ ram, cost: ns.cloud.getServerCost(ram) });
        const plan = planServicePlacement(services, bins, purchases);
        if (!plan) { publish("UNAVAILABLE", servers.length >= limit ? "Cloud server slots are full" : "No placement fits current RAM limits and pinned services"); return; }
        if (!plan.purchase) { publish("READY", "Using existing capacity", { hosts: plan.hosts, cost: 0 }); return; }
        // Refresh home savings immediately before buying. A stale local copy is
        // never permission to spend on cloud hosting.
        if (!await refreshRemoteSavings(ns) || !live()) { publish("WAITING", "Could not refresh home savings", { cost: plan.cost }); return; }
        const goal = readSavings(ns, "services:cloud"), cash = ns.getServerMoneyAvailable("home");
        const stocks = ns.getPortHandle(PORTS.STOCK_STATUS).peek();
        const stockFloor = stocks?.type === "stock-status" && stocks.generatedAt <= Date.now() &&
            Date.now() - stocks.generatedAt < 30000 && ns.isRunning(stocks.producerPid) ? Math.max(0, Number(stocks.reserveFloor) || 0) : 0;
        const floor = Math.max(goal.floor, stockFloor);
        const augmentation = ns.getPortHandle(PORTS.AUGMENTATION_STATUS).peek();
        if (augmentation?.resetEpoch === request.resetEpoch && augmentation.generatedAt <= Date.now() &&
            Date.now() - augmentation.generatedAt < 15000 && ns.isRunning(augmentation.producerPid) &&
            (augmentation.progression?.resetImminent || augmentation.progression?.redPill === "queued" ||
                augmentationInstallationPending(augmentation) || ["RESET", "COMPLETE_NODE"].includes(augmentation.phase))) {
            publish("WAITING", "Reset is imminent; retaining cash", { cost: plan.cost }); return;
        }
        if (cash - plan.cost < floor || goal.owner === "supervisor" && !goal.inactive && goal.target !== "services:cloud" ||
            goal.target === "services:cloud" && cash < goal.amount) {
            publish("WAITING", "Saving for cloud service RAM; cash goal protected", { cost: plan.cost, ram: plan.purchase.ram, floor }); return;
        }
        if (!live() || ns.cloud.getServerNames().length >= ns.cloud.getServerLimit() ||
            ns.cloud.getServerCost(plan.purchase.ram) !== plan.cost) { publish("WAITING", "Cloud quote changed; retrying", { cost: plan.cost }); return; }
        const name = `core-${request.ownerPid}-${Date.now()}`;
        const host = ns.cloud.purchaseServer(name, plan.purchase.ram);
        if (!host) { publish("WAITING", "Cloud purchase failed; retrying", { cost: plan.cost }); return; }
        const hosts = Object.fromEntries(Object.entries(plan.hosts).map(([script, target]) => [script, target === "@purchase" ? host : target]));
        publish("READY", `Bought ${host} (${plan.purchase.ram} GB)`, { hosts, cost: plan.cost, ram: plan.purchase.ram });
    } catch (error) { publish("ERROR", String(error?.message || error)); }
}
