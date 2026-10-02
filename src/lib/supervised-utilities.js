import { chooseInvestment } from "lib/investment-policy.js";
import { readFleetCapitalRequest } from "lib/fleet-capital.js";
import { readProgressionSnapshot } from "lib/progression-objective.js";
import { readSavings, writeSavings } from "lib/savings.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { progressionPrograms } from "lib/programs.js";
import { augmentationFundingCost, augmentationReputationStrategy } from "lib/augmentation-funding.js";

export function createUtilityJob(script, reportFile, type, args = [], interval = 60000) {
    return { script, reportFile, type, args: ["--report", true, ...args], interval,
        pid: 0, startedAt: 0, nextAt: 0, failures: 0, state: "WAITING", message: "Waiting to start", report: null };
}

// Short-lived utilities release their RAM after publishing a report. Never wait
// on them in the supervisor loop or kill workers to make space for them.
export function tickUtilityJob(ns, job, gate = "", now = Date.now()) {
    const processes = ns.ps("home").filter(p => p.filename === job.script);
    if (processes.length > 1) { job.state = "CONFLICT"; job.message = "Multiple utility processes; resolve manually"; return; }
    const process = processes[0];
    if (process && process.pid !== job.pid) { job.pid = process.pid; job.startedAt = now; }
    if (job.pid) {
        let report;
        try { report = JSON.parse(ns.read(job.reportFile) || "null"); } catch { report = null; }
        if (report?.version === 1 && report.type === job.type && report.producerPid === job.pid &&
            Number.isFinite(report.generatedAt) && report.generatedAt >= job.startedAt && report.generatedAt <= now &&
            report.resetEpoch === resetEpoch(ns.getResetInfo())) job.report = report;
        if (process) { job.state = "RUNNING"; job.message = "Refreshing report"; return; }
        const complete = job.report?.producerPid === job.pid && job.report.generatedAt >= job.startedAt;
        job.pid = 0;
        if (complete && job.report.state !== "ERROR") {
            job.state = job.report.state; job.message = job.report.summary; job.failures = 0;
            // A startup race must not leave a PID warning on the dashboard for
            // the whole session. Successful startup checks still run only once.
            job.nextAt = job.interval === 0 ? Infinity : now + job.interval;
            if (job.interval === 0 && job.type === "diagnostics" && job.report.state === "WARN") job.nextAt = now + 60000;
        } else {
            job.state = "ERROR"; job.message = complete ? job.report.summary : "Exited without a valid report";
            job.failures++; job.nextAt = now + Math.min(300000, 15000 * 2 ** Math.min(5, job.failures - 1));
        }
        return;
    }
    if (job.nextAt === Infinity) return; // A completed startup check stays completed while peers run.
    if (gate) { job.state = "BLOCKED"; job.message = gate; return; }
    if (now < job.nextAt) return;
    const cost = ns.getScriptRam(job.script, "home"), free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    if (!(cost > 0) || cost > free) {
        job.state = "WAITING_RAM"; job.message = cost > 0 ? `Needs ${cost.toFixed(2)} GB free on home` : `Missing script/import: ${job.script}`;
        job.nextAt = now + 15000; return;
    }
    try { job.pid = ns.run(job.script, 1, ...job.args); }
    catch (error) { job.message = String(error.message || error); }
    if (!job.pid) {
        job.state = "ERROR"; job.message = "Launch failed; check home RAM and imports";
        job.failures++; job.nextAt = now + Math.min(300000, 15000 * 2 ** Math.min(5, job.failures - 1)); return;
    }
    job.startedAt = now; job.state = "RUNNING"; job.message = "Refreshing report";
}

export function currentAugmentationPlan(ns, job, now = Date.now()) {
    const shared = readProgressionSnapshot(ns, now);
    if (shared?.selectedPlan) return shared.selectedPlan;
    const report = job?.report;
    if (report?.state !== "READY" || report.type !== "augmentation-plan" || report.resetEpoch !== resetEpoch(ns.getResetInfo()) ||
        report.generatedAt > now || now - report.generatedAt > 120000) return null;
    return report.plan;
}

export async function updateSupervisorSavings(ns, cfg, plan, progression = null, augmentation = null, fleet = null) {
    if (cfg.savingsMode === "keep" || cfg.savingsMode === "none" || cfg.savingsMode === "fixed") return;
    const current = readSavings(ns);
    if (current.error) { cfg.savingsStatus = current.error; return; }
    if (current.floor > 0 && current.owner !== "supervisor") { cfg.savingsStatus = "Preserving your existing savings goal"; return; }
    let desired = null;
    const reset = ns.getResetInfo(), singularity = singularityAvailable(reset);
    const controller = cfg.augmentationActions && augmentation?.type === "augmentation-status" &&
        augmentation.resetEpoch === resetEpoch(reset) && augmentation.generatedAt <= Date.now() &&
        Date.now() - augmentation.generatedAt <= 15000 && ns.isRunning(augmentation.producerPid) ? augmentation : null;
    if (controller?.plan) plan = controller.plan;
    const milestone = cfg.progression && progression?.type === "progression-status" &&
        progression.resetEpoch === resetEpoch(reset) && progression.generatedAt <= Date.now() &&
        Date.now() - progression.generatedAt <= 15000 ? progression.milestone : null;
    if (cfg.savingsMode === "auto") {
        const shared=readProgressionSnapshot(ns), requests=[];
        const program=progression?.objectives?.find(o=>["tor","program"].includes(o.kind));
        if (milestone && cfg.progression && (!singularity || cfg.progressionActions) && program)
            requests.push({amount:program.costEstimate/(1-(singularity ? cfg.progressionCashReserve : 0)), target:program.target,
                label:program.label,priority:program.priority || (program.kind === "tor" ? 85 : 50),reason:program.reason || "Program unlock"});
        // Old/manual observations still work if no authoritative manager is available.
        if (!progression?.objectives && cfg.progression && (!singularity || cfg.progressionActions)) {
            const p=!ns.hasTorRouter()?{name:"TOR",cost:200000}:progressionPrograms({darknet:cfg.darknet!==false,formulas:false}).find(p=>!ns.fileExists(p.name,"home"));
            if(p) requests.push({amount:p.cost/(1-(singularity?cfg.progressionCashReserve:0)),target:p.name,label:"Buy "+p.name,priority:85,reason:singularity ? "Fallback program bootstrap" : "Fallback program bootstrap; purchase manually"});
        }
        const goal=controller?.savings || shared?.savings || milestone?.savings;
        const selectedGoal = goal && plan?.next && goal.target === "augmentation:" + plan.next.name;
        if(goal) requests.push({...goal,amount:(selectedGoal ? augmentationFundingCost(plan.next) : goal.amount)/(1-(goal.target.startsWith("augmentation:") ? cfg.augmentationCashReserve : 0)),
            priority:goal.target.includes("The Red Pill") || selectedGoal && plan.next.chainTarget === "The Red Pill" ? 100 : goal.target === "faction:Daedalus" ? 95 : 72,reason:controller?.recommendation || milestone?.label || "Progression requirement",
            reputationStrategy:selectedGoal ? augmentationReputationStrategy(plan.next) : "NONE",
            liquidity:shared?.limitingResource === "cash" || controller?.phase === "FUND"});
        else if(plan?.next && cfg.augmentationActions && !plan.errors?.length) requests.push({amount:augmentationFundingCost(plan.next)/(1-cfg.augmentationCashReserve),
            target:"augmentation:"+plan.next.name,label:plan.next.name,priority:plan.next.name === "The Red Pill" || plan.next.chainTarget === "The Red Pill"?100:70,
            reputationStrategy:augmentationReputationStrategy(plan.next),
            liquidity:plan.next.repGap===0,reason:"Selected achievable augmentation chain"});
        if(cfg.homeInvestment) requests.push(cfg.homeInvestment);
        // Service admission is evaluated before performance candidates exist.
        if(!cfg.homeInvestment) requests.push(...(cfg.homePerformanceInvestments || []));
        const cloud = readFleetCapitalRequest(ns, fleet);
        if (cloud) requests.push(cloud);
        const decision=chooseInvestment(requests,current.target); desired=decision.chosen;
        cfg.savingsStatus=desired ? desired.reason + (decision.deferred.length ? "; deferred " + decision.deferred.join(", ") : "") : "No justified capital request";
    } else if (cfg.savingsMode === "programs") {
        const program = !ns.hasTorRouter() ? { name: "TOR", cost: 200000 } : progressionPrograms({ darknet: cfg.darknet !== false }).find(p => !ns.fileExists(p.name, "home"));
        if (program && (!cfg.progression || (singularity && !cfg.progressionActions))) { cfg.savingsStatus = "Program savings waits for progression actions"; return; }
        if (program) {
            desired = { amount: program.cost / (1 - (singularity ? cfg.progressionCashReserve : 0)), label: `Buy ${program.name}`, target: program.name };
            cfg.savingsStatus = `Saving for ${program.name}${singularity ? "" : "; purchase manually"}`;
        }
        else cfg.savingsStatus = "All automatic program unlocks owned";
    } else if (cfg.savingsMode === "augmentations") {
        if (!plan || plan.errors?.length) { cfg.savingsStatus = "Waiting for a fresh, complete augmentation plan"; return; }
        if (plan.next) desired = { amount: augmentationFundingCost(plan.next), label: `Augmentation: ${plan.next.name}`,
            target: `augmentation:${plan.next.name}`, reputationStrategy: augmentationReputationStrategy(plan.next) };
        cfg.savingsStatus = plan.next ? `Saving for ${plan.next.name}; purchase manually` : "No matching unowned augmentations";
    }
    const liquidity = Boolean(desired?.liquidity && desired.priority >= 80);
    const reputationStrategy = desired?.reputationStrategy || "NONE";
    // Reprice materially shrinking goals without writing floating-point noise.
    // High-priority liquidity still needs a fresh heartbeat for the stock reader.
    const repriced = desired && Math.abs((current.amount || 0) - desired.amount) > Math.max(1, desired.amount * 1e-6);
    if (desired && (current.inactive || repriced || current.target !== desired.target || current.owner !== "supervisor" ||
        current.label !== desired.label || (current.priority || 0) !== (desired.priority || 0) || Boolean(current.liquidity) !== liquidity ||
        (current.reputationStrategy || "NONE") !== reputationStrategy ||
        liquidity && Date.now() - current.updatedAt >= 10000)) {
        await writeSavings(ns, desired.amount, desired.label, desired.target, "supervisor", { priority: desired.priority || 0,
            liquidity, reputationStrategy, producerPid: ns.pid });
    } else if (!desired && current.owner === "supervisor" && current.amount > 0) {
        await writeSavings(ns, 0, "No pending automatic savings goal", "", "supervisor");
    }
}
