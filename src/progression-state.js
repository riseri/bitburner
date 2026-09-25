import { PROGRESSION_INPUT, readProgressionInput } from "lib/progression-milestones.js";
import { resetEpoch } from "lib/progression-protocol.js";

/** Record facts unavailable to scripts before Singularity. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run progression-state.js on home");
    const f = ns.flags([["installed-count", -1], ["red-pill", ""], ["daedalus-rep", -1],
        ["red-pill-rep", -1], ["red-pill-price", -1], ["clear", false]]);
    const value = f.clear ? {} : readProgressionInput(ns);
    for (const [flag, key] of [["installed-count", "installedCount"], ["daedalus-rep", "daedalusRep"],
        ["red-pill-rep", "redPillRepRequired"], ["red-pill-price", "redPillPrice"]]) {
        const n = Number(f[flag]);
        if (n === -1) continue;
        if (!Number.isFinite(n) || n < 0 || (flag === "installed-count" && !Number.isSafeInteger(n))) throw new Error(`Invalid --${flag}`);
        value[key] = n;
    }
    if (f["red-pill"]) {
        if (!["none", "queued", "installed"].includes(f["red-pill"])) throw new Error("red-pill must be none, queued, or installed");
        value.redPill = f["red-pill"];
    }
    await ns.write(PROGRESSION_INPUT, JSON.stringify({ ...value, version: 1, resetEpoch: resetEpoch(ns.getResetInfo()), updatedAt: Date.now() }), "w");
    ns.tprint(`Progression observations saved: ${JSON.stringify(value)}. Update after purchases; these expire on reset. Use savings.js for any specific augmentation cash goal.`);
}
