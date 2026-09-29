// Stable upstream ServerHelpers / Singularity mechanics. Costs use live APIs.
export const HOME_MAX_CORES = 8;
export function homeCoreBonus(cores) { return 1 + (Math.max(1, cores || 1) - 1) / 16; }
