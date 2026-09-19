import { resetEpoch } from "lib/progression-protocol.js";

export async function writeUtilityReport(ns, file, type, data) {
    await ns.write(file, JSON.stringify({ ...data, type, version: 1, producerPid: ns.pid,
        generatedAt: Date.now(), resetEpoch: resetEpoch(ns.getResetInfo()) }), "w");
}
