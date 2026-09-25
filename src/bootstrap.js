import { restoreSupervisorArgs } from "lib/supervisor-migration.js";

const CONFIG = "data/supervisor-bootstrap.json";

/** Restart the supervisor after an augmentation installation. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run bootstrap.js on home");
    let args = [];
    try {
        args = restoreSupervisorArgs(ns.read(CONFIG));
    } catch (error) { ns.tprint(`ERROR: cannot restore supervisor settings: ${String(error?.message || error)}`); return; }
    // Release callback RAM before the next node's 8 GB supervisor starts.
    ns.spawn("supervisor.js", { threads: 1, spawnDelay: 0 }, ...args);
}
