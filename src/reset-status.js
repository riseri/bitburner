/** Read-only reset diagnosis. Run on home after an unexpected timer change. @param {NS} ns */
export async function main(ns) {
    if (ns.getHostname() !== "home") throw new Error("Run reset-status.js on home");
    const now = Date.now(), reset = ns.getResetInfo();
    const stamp = value => Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime())
        ? `${new Date(value).toISOString()} (${Math.round((now - value) / 1000)} seconds ago)` : `unavailable (${value})`;
    ns.tprint(`RESET DIAGNOSIS | BN${reset.currentNode} | owned SF: ${JSON.stringify([...reset.ownedSF])}`);
    ns.tprint(`BitNode reset timestamp: ${stamp(reset.lastNodeReset)}`);
    ns.tprint(`Augmentation reset timestamp: ${stamp(reset.lastAugReset)}`);
    ns.tprint("These are reset timestamps, separate from the Stats page's accumulated playtime counters.");
    const read = path => {
        try { return JSON.parse(ns.read(path) || "null"); }
        catch { ns.tprint(`Cannot parse ${path}`); return null; }
    };
    const samples = read("data/telemetry.json")?.samples;
    const boundaries = [];
    if (Array.isArray(samples)) {
        for (const sample of samples) {
            if (!Number.isFinite(sample?.at) || typeof sample.epoch !== "string") continue;
            const parts = sample.epoch.split(":").map(Number);
            if (parts.length !== 3 || !parts.every(Number.isFinite)) continue;
            if (boundaries.at(-1)?.epoch === sample.epoch) continue;
            boundaries.push({ at: sample.at, epoch: sample.epoch, parts });
        }
    }
    ns.tprint(`Saved telemetry: ${boundaries.length} observed reset epochs (showing last 8).`);
    for (const entry of boundaries.slice(-8)) {
        const [node, nodeReset, augReset] = entry.parts;
        ns.tprint(`Observed ${stamp(entry.at)} | BN${node} | node=${nodeReset} | aug=${augReset}`);
    }
    const sameRun = Array.isArray(samples) ? samples.find(sample => Number.isFinite(sample?.at) &&
        typeof sample.epoch === "string" && sample.epoch.startsWith(`${reset.currentNode}:${reset.lastNodeReset}:`)) : null;
    if (sameRun) ns.tprint(`Current node reset timestamp was already recorded at ${stamp(sameRun.at)}.`);
    const session = read("data/intelligence-session.json");
    if (session) ns.tprint(`INT farming record: ${JSON.stringify({ node: session.node, nodeReset: session.nodeReset,
        startedAt: session.startedAt, lastAugReset: session.lastAugReset, resets: session.resets,
        active: session.active, reason: session.reason })}`);
    ns.tprint("Paste this output alongside the Stats timer. A much older node timestamp points to a playtime-counter discrepancy, not a recent node transition.");
}
