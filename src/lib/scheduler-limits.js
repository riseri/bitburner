// Shared resource bounds, independent of game APIs and resident controllers.
export const LAUNCH_ENVELOPE = 128;
export const BATCH_PHASES = 4;
export const MIN_TARGET_RATE = .25;

// A useful new lane needs at least .25 batches/s and every batch has four
// phases. The launch envelope, rather than an arbitrary lane count, bounds AUTO.
export const MAX_TARGETS = Math.floor(LAUNCH_ENVELOPE / (BATCH_PHASES * MIN_TARGET_RATE));

export function cadenceBatchRate(gap) {
    return 1000 / (BATCH_PHASES * gap + 20);
}
