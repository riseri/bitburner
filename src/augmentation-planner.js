import { writeUtilityReport } from "lib/utility-report.js";
import { buildAugmentationPlan } from "lib/augmentation-plan.js";
import { writeSavings } from "lib/savings.js";

/** Read-only purchasing advice; --save-goal only writes a cash reserve. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run augmentation-planner.js on home");
    const f = ns.flags([["focus", "hacking"], ["target", ""], ["price-multiplier", 1], ["save-goal", false], ["report", false]]);
    if (f.report) {
        let report;
        try {
            const reset = ns.getResetInfo();
            if (reset.currentNode !== 4 && !(Number(reset.ownedSF?.get(4)) > 0)) {
                report = { state: "BLOCKED", summary: "Singularity is locked" };
            } else {
                const plan = buildAugmentationPlan(ns, f);
                report = { state: plan.errors.length ? "BLOCKED" : "READY", plan,
                    summary: plan.errors.length ? plan.errors.join("; ") : plan.next
                        ? `${plan.next.name} | ${plan.next.faction} | rep gap ${Math.ceil(plan.next.repGap)} | cash ${Math.ceil(plan.next.price)}`
                        : "No matching unowned augmentations" };
            }
        } catch (error) { report = { state: "ERROR", summary: String(error.message || error) }; }
        await writeUtilityReport(ns, "data/augmentation-plan.json", "augmentation-plan", report);
        return;
    }
    const reset = ns.getResetInfo();
    if (reset.currentNode !== 4 && !(Number(reset.ownedSF?.get(4)) > 0)) {
        ns.tprint("Augmentation planning needs Singularity (BN4 or SF4). No purchases or resets performed."); return;
    }
    const plan = buildAugmentationPlan(ns, f), multiplier = plan.multiplier;
    ns.tprint(`AUGMENTATION PLAN | joined factions only | ${plan.order.length} purchases`);
    for (const [index, a] of plan.order.entries()) ns.tprint(`${index + 1}. ${a.name} from ${a.faction} | quote ${ns.format.number(a.price)} | projected ${ns.format.number(a.estimatedPrice)} | rep gap ${ns.format.number(a.repGap)} | prerequisites: ${a.prerequisites.join(", ") || "none"}`);
    for (const error of plan.errors) ns.tprint(`BLOCKED: ${error}`);
    ns.tprint(`Basket ${ns.format.number(plan.total)} (${multiplier === 1 ? "current-price lower bound; excludes future purchase inflation" : `estimate assuming ${multiplier}x price growth per purchase`}). Re-run after purchases or reputation changes.`);
    if (plan.next) {
        ns.tprint(`Next: ${plan.next.repGap > 0 ? `earn ${ns.format.number(plan.next.repGap)} reputation with ${plan.next.faction}, then buy` : "buy"} ${plan.next.name}; cash target ${ns.format.number(plan.next.price)}.`);
        if (f["save-goal"]) {
            if (plan.errors.length) throw new Error("Resolve unavailable prerequisites before replacing the savings goal");
            await writeSavings(ns, plan.next.price, `Augmentation: ${plan.next.name}`);
            ns.tprint("Saved the next purchase's cash goal. Buy manually, then clear or replace it with savings.js.");
        }
    } else ns.tprint("No matching unowned augmentations in joined factions; existing savings goal unchanged.");
}
