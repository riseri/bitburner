import { resetEpoch } from "lib/progression-protocol.js";

export const PROGRESSION_INPUT = "data/progression-input.json";

// No Singularity imports here: the BN5 advisor must remain inexpensive.
export function readProgressionInput(ns) {
    try {
        const value = JSON.parse(ns.read(PROGRESSION_INPUT) || "null");
        return value?.version === 1 && value.resetEpoch === resetEpoch(ns.getResetInfo()) ? value : {};
    } catch { return {}; }
}

export function readProgressionObservation(ns, now = Date.now()) {
    try {
        const report = JSON.parse(ns.read("data/augmentation-plan.json") || "null");
        if (report?.type === "augmentation-plan" && report.version === 1 &&
            report.resetEpoch === resetEpoch(ns.getResetInfo()) && report.generatedAt <= now &&
            now - report.generatedAt <= 120000 && report.progression) return report.progression;
    } catch {}
    return readProgressionInput(ns);
}

export function planMilestone({ currentNode, player = {}, money, observation = {}, worldDaemon = {} }) {
    const result = (stage, label, savings = null) => ({ stage, label, savings });
    if (![4, 5].includes(currentNode)) return result("GENERAL", "Continue faction work and install augmentations");
    if (observation.redPill === "queued") return result("INSTALL", "Install The Red Pill now; no need to wait for more augmentations");
    if (observation.redPill === "installed" || worldDaemon.discovered) {
        if (!worldDaemon.discovered) return result("DAEMON", "Discover w0r1d_d43m0n after installing The Red Pill");
        if (Number(player.skills?.hacking) < worldDaemon.requiredHacking) return result("DAEMON_SKILL",
            `Raise hacking to ${worldDaemon.requiredHacking} for w0r1d_d43m0n`);
        if (!worldDaemon.rooted) return result("DAEMON_ROOT", "Gain root access on w0r1d_d43m0n");
        return result("FINISH", `Backdoor w0r1d_d43m0n to finish this BitNode${currentNode === 5 ? "; then enter BitNode 4" : ""}${worldDaemon.path?.length ? ` | ${worldDaemon.path.join(" -> ")}` : ""}`);
    }
    if (player.factions?.includes("Daedalus")) {
        const price = observation.redPillPrice;
        const savings = Number.isFinite(price) && price > 0
            ? { amount: price, label: "Buy The Red Pill", target: "augmentation:The Red Pill" } : null;
        const gap = Number.isFinite(observation.redPillRepRequired) && Number.isFinite(observation.daedalusRep)
            ? Math.max(0, observation.redPillRepRequired - observation.daedalusRep) : null;
        return result("RED_PILL", gap === null ? "Work for Daedalus; check The Red Pill reputation and price in the faction menu"
            : gap > 0 ? `Work for Daedalus: ${Math.ceil(gap)} reputation remaining for The Red Pill`
                : `Buy The Red Pill${price > 0 ? ` for ${Math.ceil(price)}` : ""}, then install immediately`, savings);
    }
    // 30 installed augmentations in BN4/BN5; extra NeuroFlux levels count once.
    const count = observation.installedCount;
    if (!Number.isSafeInteger(count) || count < 0) return result("AUGMENTATIONS_UNKNOWN",
        "Record installed augmentation count: run progression-state.js --installed-count N (NeuroFlux counts once)");
    if (count < 30) return result("AUGMENTATIONS", `Install ${30 - count} more distinct augmentations for Daedalus (${count}/30); prioritize faction work`);
    const skills = player.skills || {};
    const skillReady = skills.hacking >= 2500 || ["strength", "defense", "dexterity", "agility"].every(key => skills[key] >= 1500);
    if (!skillReady) return result("DAEDALUS_SKILL", "Raise hacking to 2500 for Daedalus (or all four combat skills to 1500)");
    // Reserve the large invitation balance only when other requirements are met.
    return result("DAEDALUS_CASH", money < 100e9 ? "Save $100b cash for the Daedalus invitation; fleet and new stock entries yield to this goal"
        : "Accept the Daedalus invitation (wait for it to arrive if necessary)",
        { amount: 100e9, label: "Daedalus invitation", target: "faction:Daedalus" });
}
