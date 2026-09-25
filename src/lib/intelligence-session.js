export const INTELLIGENCE_SESSION = "data/intelligence-session.json";

export function readIntelligenceSession(ns) {
    try {
        const s = JSON.parse(ns.read(INTELLIGENCE_SESSION) || "null");
        if (s?.version !== 1 || !Number.isFinite(s.startedAt) || !Number.isFinite(s.deadline) ||
            s.deadline <= s.startedAt || !Number.isFinite(s.target) || s.target < 1 ||
            !Number.isFinite(s.startExp) || !Number.isFinite(s.startInt) ||
            !Number.isSafeInteger(s.resets) || s.resets < 0) return null;
        const r = ns.getResetInfo();
        return s.node === r.currentNode && s.nodeReset === r.lastNodeReset ? s : null;
    } catch { return null; }
}

export function intelligenceSessionActive(ns) {
    const s = readIntelligenceSession(ns);
    return Boolean(s?.active && s.deadline > Date.now());
}

export function intelligenceMetrics(session, player, now = Date.now()) {
    const elapsed = Math.max(0, now - session.startedAt);
    const gained = Math.max(0, player.exp.intelligence - session.startExp);
    return { intelligence: player.skills.intelligence, gained, elapsed,
        xpPerHour: elapsed > 0 ? gained * 3600000 / elapsed : 0, resets: session.resets };
}
