export const LAUNCH_BUCKET_MS = 250;

// Project the whole proposed batch beside existing commitments. A rejection
// describes demand, not how many launches are currently reserved.
export function launchBudgetDemand(buckets, chunks) {
    const proposed = new Map();
    for (const c of chunks) {
        const slot = Math.floor(c.launchAt / LAUNCH_BUCKET_MS);
        proposed.set(slot, (proposed.get(slot) || 0) + 1);
    }
    let peakBucket = 0, peakReserved = 0;
    for (const slot of proposed.keys()) {
        peakBucket = Math.max(peakBucket, (buckets.get(slot) || 0) + proposed.get(slot));
        for (let start = slot - 4; start <= slot; start++) {
            let count = 0;
            for (let i = start; i <= start + 4; i++) count += (buckets.get(i) || 0) + (proposed.get(i) || 0);
            peakReserved = Math.max(peakReserved, count);
        }
    }
    return { peakBucket, peakReserved, requiredLimit: Math.max(peakBucket * 4, peakReserved) };
}

export function optionalLaunchLimit(limit) {
    // A 250ms bin needs a budget of four even for one worker. Explicit tiny
    // budgets must still permit prep to make progress when the ledger is empty.
    return Math.max(4, limit - Math.min(8, Math.max(1, Math.floor(limit / 4))));
}
