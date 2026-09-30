import { augmentationContext } from "lib/augmentation-context.js";
import { bn4Route } from "lib/bitnode-route.js";
import { writeUtilityReport } from "lib/utility-report.js";
import { buildAugmentationPlan } from "lib/augmentation-plan.js";
import { writeSavings } from "lib/savings.js";
import { augmentationFundingCost } from "lib/augmentation-funding.js";
import { renderFactionProgression } from "lib/dashboard.js";

/** Read-only purchasing advice; --save-goal only writes a cash reserve. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run augmentation-planner.js on home");
    const f = ns.flags([["focus", "hacking"], ["target", ""], ["route", true], ["price-multiplier", 0], ["save-goal", false], ["report", false],
        ["donate", true], ["focus-work", false], ["cash-reserve", .1]]);
    const options = { ...f, donate: bool(f.donate), focusWork: bool(f["focus-work"]), cashReserve: Number(f["cash-reserve"]) };
    if (!Number.isFinite(options.cashReserve) || options.cashReserve < 0 || options.cashReserve > .95)
        throw new Error("cash-reserve must be a fraction between 0 and 0.95");
    if (f.report) {
        let report;
        try {
            const reset = ns.getResetInfo();
            if (reset.currentNode !== 4 && !(Number(reset.ownedSF?.get(4)) > 0)) {
                report = { state: "BLOCKED", summary: "Singularity is locked" };
            } else {
                const plan = buildAugmentationPlan(ns, { ...options, context: augmentationContext(ns), route: ![false, "false", "0", "off", "no"].includes(f.route) && bn4Route(ns.getResetInfo()) });
                report = { state: plan.errors.length ? "BLOCKED" : "READY", plan, progression: progressionObservation(ns),
                    summary: plan.errors.length ? plan.errors.join("; ") : plan.next
                        ? `${plan.next.name} | ${plan.next.faction} | ${plan.next.progressionStrategy} | rep gap ${Math.ceil(plan.next.repGap)} | funding ${Math.ceil(plan.next.fundingCost)}`
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
    const context = augmentationContext(ns);
    const plan = buildAugmentationPlan(ns, { ...options, context, route: ![false, "false", "0", "off", "no"].includes(f.route) && bn4Route(ns.getResetInfo()) }), multiplier = plan.multiplier;
    ns.tprint(`AUGMENTATION PLAN | joined factions only | ${plan.order.length} purchases`);
    for (const [index, a] of plan.order.entries()) ns.tprint(`${index + 1}. ${a.name} from ${a.faction} | quote ${ns.format.number(a.price)} | projected ${ns.format.number(a.estimatedPrice)} | rep gap ${ns.format.number(a.repGap)} | prerequisites: ${a.prerequisites.join(", ") || "none"}`);
    for (const error of plan.errors) ns.tprint(`BLOCKED: ${error}`);
    ns.tprint(`Basket ${ns.format.number(plan.total)} (${multiplier === 1 ? "current-price lower bound; excludes future purchase inflation" : `estimate assuming ${multiplier}x price growth per purchase`}). Re-run after purchases or reputation changes.`);
    if (plan.next) {
        ns.tprint(`Next: ${plan.next.progressionStrategy} | ${plan.next.name} from ${plan.next.faction}; funding target ${ns.format.number(plan.next.fundingCost)}.`);
        renderFactionProgression({ print: line => ns.tprint(line) }, plan.next, context.money);
        if (f["save-goal"]) {
            if (plan.errors.length) throw new Error("Resolve unavailable prerequisites before replacing the savings goal");
            await writeSavings(ns, augmentationFundingCost(plan.next), `Augmentation: ${plan.next.name}`);
            ns.tprint("Saved the selected acquisition's cash goal. Acquire manually, then clear or replace it with savings.js.");
        }
    } else ns.tprint("No matching unowned augmentations in joined factions; existing savings goal unchanged.");
}

function bool(value) { return typeof value === "boolean" ? value : !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase()); }

// Runs in the existing short-lived Singularity helper, never in the BN5 advisor.
function progressionObservation(ns) {
    const installed = ns.singularity.getOwnedAugmentations(false);
    const owned = ns.singularity.getOwnedAugmentations(true);
    const daedalus = ns.getPlayer().factions.includes("Daedalus");
    return { installedCount: new Set(installed).size,
        redPill: installed.includes("The Red Pill") ? "installed" : owned.includes("The Red Pill") ? "queued" : "none",
        ...(daedalus ? { daedalusRep: ns.singularity.getFactionRep("Daedalus"),
            redPillPrice: ns.singularity.getAugmentationPrice("The Red Pill"),
            redPillRepRequired: ns.singularity.getAugmentationRepReq("The Red Pill") } : {}) };
}
