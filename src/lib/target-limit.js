import { MAX_TARGETS } from "lib/scheduler-limits.js";

// Pure configuration shared by supervisor and daemon; no scheduler/API imports.
export function targetLimit(value = "auto") {
    if (String(value).trim().toLowerCase() === "auto") return { limit: MAX_TARGETS, mode: "auto" };
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TARGETS)
        throw new Error(`max-targets must be auto or an integer from 1 to ${MAX_TARGETS}`);
    return { limit, mode: "explicit" };
}
