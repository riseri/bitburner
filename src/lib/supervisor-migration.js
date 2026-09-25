// Version-1 bootstrap files used profiles and defaulted to observe. Convert once
// to explicit service overrides. Installation is always enabled in the aug loop.
export function migrateSupervisorArgs(args) {
    args = withoutAutoInstall(args);
    const result = [], explicit = new Set();
    let profile = "observe";
    for (let i = 0; i < args.length; i++) {
        const token = String(args[i]);
        if (token === "--profile") { profile = String(args[++i]); continue; }
        if (token.startsWith("--profile=")) { profile = token.slice("--profile=".length); continue; }
        if (token.startsWith("--")) explicit.add(token.slice(2).split("=", 1)[0]);
        result.push(args[i]);
    }
    if (!["observe", "assist", "hands-off"].includes(profile)) throw new Error(`Unknown saved supervisor profile: ${profile}`);
    const actions = profile !== "observe";
    for (const [flag, value] of [["progression-actions", actions], ["augmentation-actions", actions]]) {
        if (!explicit.has(flag)) result.push(`--${flag}`, value);
    }
    return result;
}

export function withoutAutoInstall(args) {
    const result = [];
    for (let i = 0; i < args.length; i++) {
        const token = String(args[i]);
        if (token === "--auto-install") {
            if (i + 1 < args.length && !String(args[i + 1]).startsWith("--")) i++;
        } else if (!token.startsWith("--auto-install=")) result.push(args[i]);
    }
    return result;
}

export function restoreSupervisorArgs(raw) {
    const saved = JSON.parse(raw || "null");
    if (![1, 2].includes(saved?.version) || !Array.isArray(saved.args) || !saved.args.every(value =>
        typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
        throw new Error("No valid saved supervisor configuration; start supervisor.js first");
    }
    return saved.version === 1 ? migrateSupervisorArgs(saved.args) : withoutAutoInstall(saved.args);
}
