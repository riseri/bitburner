const CONFIG = "data/supervisor-bootstrap.json";

/** Restart the supervisor after an augmentation installation. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run bootstrap.js on home");
    let args = [];
    try {
        const saved = JSON.parse(ns.read(CONFIG) || "null");
        if (saved?.version === 1 && Array.isArray(saved.args) && saved.args.every(validArgument)) args = saved.args;
        else ns.tprint("WARN: no valid saved supervisor configuration; starting safe defaults");
    } catch { ns.tprint("WARN: unreadable supervisor bootstrap configuration; starting safe defaults"); }
    const pid = ns.run("supervisor.js", 1, ...args);
    if (!pid) ns.tprint("ERROR: could not restart supervisor.js after augmentation installation");
}

function validArgument(value) {
    return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
