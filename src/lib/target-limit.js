// Pure configuration shared by supervisor and daemon; no scheduler/API imports.
export function targetLimit(value = "auto") {
    if (String(value).toLowerCase() === "auto") return { limit: 6, mode: "auto" };
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6) throw new Error("max-targets must be auto or an integer from 1 to 6");
    return { limit, mode: "explicit" };
}
