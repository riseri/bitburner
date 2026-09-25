import { readSavings, writeSavings } from "lib/savings.js";
import { resetEpoch, singularityAvailable } from "lib/progression-protocol.js";
import { progressionPrograms } from "lib/programs.js";

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
            job.nextAt = job.interval === 0 ? Infinity : now + job.interval;
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
    const report = job?.report;
    if (report?.state !== "READY" || report.type !== "augmentation-plan" || report.resetEpoch !== resetEpoch(ns.getResetInfo()) ||
        report.generatedAt > now || now - report.generatedAt > 120000) return null;
    return report.plan;
}

export async function updateSupervisorSavings(ns, cfg, plan, progression = null, augmentation = null) {
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
    if (cfg.savingsMode === "auto" || cfg.savingsMode === "programs") {
        const program = !ns.hasTorRouter() ? { name: "TOR", cost: 200000 } : progressionPrograms({ darknet: cfg.darknet !== false }).find(p => !ns.fileExists(p.name, "home"));
        if (program && (!cfg.progression || (singularity && !cfg.progressionActions))) { cfg.savingsStatus = "Program savings waits for progression actions"; return; }
        if (program) {
            desired = { amount: program.cost / (1 - (singularity ? cfg.progressionCashReserve : 0)), label: `Buy ${program.name}`, target: program.name };
            cfg.savingsStatus = `Saving for ${program.name}${singularity ? "" : "; purchase manually"}`;
        }
        else if (cfg.savingsMode === "auto" && controller?.savings) {
            desired = controller.savings;
            cfg.savingsStatus = controller.recommendation;
        }
        else if (cfg.savingsMode === "auto" && milestone?.savings) {
            const goal = milestone.savings;
            desired = { ...goal, amount: goal.amount / (1 - (singularity && goal.target.startsWith("augmentation:") ? cfg.augmentationCashReserve : 0)) };
            cfg.savingsStatus = milestone.label;
        }
        else if (cfg.savingsMode === "auto" && singularity && cfg.augmentationActions) {
            if (!plan || plan.errors?.length) { cfg.savingsStatus = "Programs complete; waiting for a fresh augmentation plan"; return; }
            if (plan.next) desired = { amount: plan.next.price / (1 - cfg.augmentationCashReserve),
                label: `Augmentation: ${plan.next.name}`, target: `augmentation:${plan.next.name}` };
            cfg.savingsStatus = plan.next ? `Programs complete; saving for ${plan.next.name}` : "Programs and planned augmentations complete";
        } else cfg.savingsStatus = "All automatic program unlocks owned";
    } else if (cfg.savingsMode === "augmentations") {
        if (!plan || plan.errors?.length) { cfg.savingsStatus = "Waiting for a fresh, complete augmentation plan"; return; }
        if (plan.next) desired = { amount: plan.next.price, label: `Augmentation: ${plan.next.name}`, target: `augmentation:${plan.next.name}` };
        cfg.savingsStatus = plan.next ? `Saving for ${plan.next.name}; purchase manually` : "No matching unowned augmentations";
    }
    if (desired && (current.inactive || current.amount !== desired.amount || current.target !== desired.target || current.owner !== "supervisor")) {
        await writeSavings(ns, desired.amount, desired.label, desired.target, "supervisor");
    } else if (!desired && current.owner === "supervisor" && current.amount > 0) {
        await writeSavings(ns, 0, "No pending automatic savings goal", "", "supervisor");
    }
}
