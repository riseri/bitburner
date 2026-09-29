import { PORTS } from "lib/ports.js";
import { resetEpoch } from "lib/progression-protocol.js";
import { readProgressionSnapshot } from "lib/progression-objective.js";
import { readSavings } from "lib/savings.js";
import { evaluateHomeInvestment } from "lib/home-economics.js";
import { reclaimHomeShare } from "lib/home-share.js";

export function tickHomeInvestment(ns, cfg, allowed) {
    cfg.homePerformanceInvestments = [];
    if (!allowed) { cfg.homeCapital = { decision: "HOLD", reason: "Services/progression take priority or Singularity unavailable" }; return; }
    const now = Date.now(), epoch = resetEpoch(ns.getResetInfo());
    const quote = ns.getPortHandle(PORTS.HOME_UPGRADE_STATUS).peek();
    const valid = quote?.type === "home-capital-quote" && quote.resetEpoch === epoch && quote.ram === ns.getServerMaxRam("home") &&
        Number.isFinite(quote.generatedAt) && quote.generatedAt <= now && now - quote.generatedAt <= 15000;
    const snapshot = ns.getPortHandle(PORTS.JIT_STATUS).peek(), objective = readProgressionSnapshot(ns);
    if (!snapshot?.capacity?.homeGw?.enabled || !objective) {
        cfg.homeCapital = { decision: "HOLD", reason: "Waiting for scheduler and progression evidence" }; return;
    }
    let best = null, reason = "Waiting for a fresh home quote";
    if (valid && Number.isInteger(snapshot.pid) && ns.isRunning(snapshot.pid)) for (const kind of ["ram", "cores"]) {
        const value = evaluateHomeInvestment(snapshot, quote, kind, objective, now);
        if (value.ok) {
            const request = { amount: value.cost / 0.9, target: kind === "cores" ? "home:cores" : "home:performance-ram", priority: 79,
                label: kind === "cores" ? `Home cores ${quote.cores} -> ${quote.cores + 1}` : `Home RAM ${quote.ram} -> ${quote.ram * 2}`,
                reason: value.reason, economics: value, kind };
            cfg.homePerformanceInvestments.push(request);
            if (!best || value.payback < best.economics.payback) best = request;
        } else reason = value.reason;
    }
    const goal = readSavings(ns), selected = cfg.homePerformanceInvestments.find(r => r.target === goal.target);
    const funded = selected && goal.owner === "supervisor" && !goal.inactive && ns.getServerMoneyAvailable("home") >= goal.amount;
    cfg.homeCapital = { decision: funded ? "BUY" : best && selected ? "SAVE" : "HOLD", best: best?.label,
        cost: best?.economics.cost, gain: best?.economics.gain, payback: best?.economics.payback,
        reason: selected ? selected.reason : best ? `Shared arbitration selected ${goal.target || "another goal"}` : reason };
    if (ns.ps("home").some(p => p.filename === "home-capital.js") || now < (cfg.nextHomeCapitalAt || 0) || valid && !funded) return;
    const ram = ns.getScriptRam("home-capital.js", "home");
    if (!(ram > 0)) return;
    if (!reclaimHomeShare(ns, ram + Math.max(8, cfg.homeReserve || 0))) return;
    const request = funded ? JSON.stringify({ kind: selected.kind, cost: selected.economics.cost, ram: quote.ram, cores: quote.cores,
        generatedAt: quote.generatedAt, resetEpoch: epoch }) : "";
    if (ns.exec("home-capital.js", "home", 1, epoch, request)) cfg.nextHomeCapitalAt = now + 10000;
}
