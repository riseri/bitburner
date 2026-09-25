import { readSavings, writeSavings } from "lib/savings.js";
import { progressionPrograms } from "lib/programs.js";
import { PORTS } from "lib/ports.js";

/** @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run savings.js on home");
    const f = ns.flags([["amount", -1], ["label", "Savings"], ["target", ""], ["next-program", false], ["darknet", true], ["clear", false]]);
    if (f.clear) await writeSavings(ns, 0, "No savings goal");
    else if (f["next-program"]) {
        const darknet = ![false, "false", "0", "off", "no"].includes(f.darknet);
        const p = !ns.hasTorRouter() ? { name: "TOR", cost: 200000 } : progressionPrograms({ darknet }).find(p => !ns.fileExists(p.name, "home"));
        if (!p) { ns.tprint("All automatic program unlocks owned; existing savings goal unchanged."); return; }
        // Include the default progression reserve; the purchase actor rechecks the live price.
        await writeSavings(ns, p.cost / 0.9, `Buy ${p.name}`, p.name);
    } else if (Number(f.amount) !== -1) await writeSavings(ns, Number(f.amount), f.label, f.target);
    const goal = readSavings(ns), cash = ns.getServerMoneyAvailable("home");
    const jit = ns.getPortHandle(PORTS.JIT_STATUS).peek();
    const fresh = jit?.type === "jit-status" && Date.now() >= jit.generatedAt && Date.now() - jit.generatedAt < 15000 && ns.isRunning(jit.pid);
    const seconds = fresh && jit.income60 > 0 ? Math.max(0, goal.floor - cash) / jit.income60 : null;
    ns.tprint(`${goal.label}: protected ${ns.format.number(goal.floor)}, cash ${ns.format.number(cash)}${goal.inactive ? ` | ${goal.inactive}` : ""}`);
    ns.tprint(goal.error || (goal.floor <= cash ? "Funded (cash stays protected until spent on its target or cleared)." : `ETA from current gross hacking income: ${seconds === null ? "unknown" : `${Math.ceil(seconds)}s`}; other spending can extend this.`));
}
