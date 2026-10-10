export const INTELLIGENCE_SESSION = "data/intelligence-session.json";
export const INTELLIGENCE_AUTO = "data/intelligence-auto.json";

// Upstream v3.0.1 keepOnInstall factions that can be rejoined for INT XP.
// Church of the Machine God rejoins automatically and cannot supply join XP.
const PERSISTENT_FACTIONS = Object.freeze([
    "Shadows of Anarchy", "ECorp", "MegaCorp", "Bachman & Associates", "Blade Industries",
    "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma", "KuaiGong International",
    "Fulcrum Secret Technologies",
]);

export function intelligenceAvailable(reset) {
    return reset?.currentNode === 5 || Number(reset?.ownedSF?.get?.(5) ?? 0) > 0;
}

export function intelligenceFactions(members = [], invitations = []) {
    const available = new Set([...members, ...invitations]);
    return PERSISTENT_FACTIONS.filter(faction => available.has(faction));
}

export function intelligencePolicy(cfg = {}) {
    const minutes = Number(cfg.intelligenceMinutes ?? 10), target = Number(cfg.intelligenceTarget ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error("intelligence-minutes must be greater than 0 and at most 60");
    if (!Number.isFinite(target) || target < 0) throw new Error("intelligence-target must be nonnegative (0 means time only)");
    return { enabled: cfg.intelligence !== false, minutes, target };
}

export function automaticIntelligenceEnabled(cfg) {
    return intelligencePolicy(cfg).enabled && Boolean(cfg.augmentationActions && cfg.progression && cfg.progressionActions) &&
        cfg.augmentationJoinFactions !== false;
}

export function readIntelligenceSession(ns) {
    try {
        const s = JSON.parse(ns.read(INTELLIGENCE_SESSION) || "null");
        if (![1, 2].includes(s?.version) || !Number.isFinite(s.startedAt) || !Number.isFinite(s.deadline) ||
            s.deadline <= s.startedAt || !Number.isFinite(s.target) || s.target < (s.version === 1 ? 1 : 0) ||
            !Number.isFinite(s.startExp) || !Number.isFinite(s.startInt) ||
            !Number.isSafeInteger(s.resets) || s.resets < 0) return null;
        if (s.version === 2 && (s.deadline - s.startedAt > 60 * 60000 ||
            !Number.isSafeInteger(s.joins) || s.joins < 0 || !Array.isArray(s.factions) ||
            !s.factions.every(faction => PERSISTENT_FACTIONS.includes(faction)) ||
            new Set(s.factions).size !== s.factions.length)) return null;
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
    const exp = Number.isFinite(player.exp?.intelligence) ? player.exp.intelligence : session.startExp;
    const gained = Math.max(0, exp - session.startExp);
    return { intelligence: Number.isFinite(player.skills?.intelligence) ? player.skills.intelligence : session.startInt, gained, elapsed,
        xpPerHour: elapsed > 0 ? gained * 3600000 / elapsed : 0, resets: session.resets,
        joins: session.joins || 0, factions: session.factions || [] };
}
