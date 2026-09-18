/** Read-only RAM/deployment check. Run on home: run worker-ram-check.js cloud-04 */
/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const host = String(ns.args[0] ?? "cloud-04");
    const server = ns.getServer(host);
    const free = Math.max(0, server.maxRam - server.ramUsed);
    ns.tprint(`WORKER RAM CHECK :: ${host}`);
    ns.tprint(`Root: ${server.hasAdminRights} | used ${ns.format.ram(server.ramUsed)} / ${ns.format.ram(server.maxRam)} | free ${ns.format.ram(free)}`);
    ns.tprint("Script             home GB/thread  host GB/thread  host fits (threads)");
    for (const script of ["jit-hack.js", "jit-grow.js", "jit-weaken.js"]) {
        const homeCost = ns.getScriptRam(script, "home");
        const hostCost = ns.getScriptRam(script, host);
        const capacity = hostCost > 0 ? Math.floor(free / hostCost) : 0;
        ns.tprint(`${script.padEnd(19)}${homeCost.toFixed(2).padStart(14)}${hostCost.toFixed(2).padStart(16)}${String(capacity).padStart(21)}`);
        if (homeCost <= 0 || hostCost <= 0) ns.tprint(`WARN: ${script} is missing or its RAM could not be calculated.`);
        else if (Math.abs(homeCost - hostCost) > 0.001) ns.tprint(`WARN: ${script} home and host RAM prices differ.`);
    }
    ns.tprint("File prices are current cached estimates. Existing processes can retain older allocations.");
    ns.tprint("This does not read the daemon's startup price or sample a failed launch; it changes no workers or ports.");
}
