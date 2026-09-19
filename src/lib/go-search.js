import { checkBoard, analyzeBoard, chooseGoMove } from "lib/go-strategy.js";
// 5x5 fits in two exact 25-bit masks. No game internals, DOM, or cheat APIs.
// Index = x * 5 + y. Two 25-bit masks fit exactly in a 50-bit Number key.
const ALL = 0x1ffffff, BASE = 0x2000000;
const LOW_Y = 0x108421, HIGH_Y = 0x1084210;
function pop(bits) { bits -= (bits >>> 1) & 0x55555555; bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333); return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
function index(bit) { return 31 - Math.clz32(bit); }
function adjacent(bits, grid) { return (((bits & ~LOW_Y) >>> 1) | ((bits & ~HIGH_Y) << 1) | (bits >>> 5) | (bits << 5)) & grid.open; }
function flood(seed, allowed, grid) { let group = seed, next; while ((next = (group | adjacent(group, grid) & allowed)) !== group)
    group = next; return group; }
function key(b, w) { return b * BASE + w; }
export function fastBoard(columns) {
    checkBoard(columns);
    if (columns.length !== 5)
        throw new Error('Bitboard backend requires 5x5');
    let b = 0, w = 0, open = 0;
    for (let p = 0; p < 25; p++) {
        const c = columns[Math.floor(p / 5)][p % 5], bit = 1 << p;
        if (c !== '#')
            open |= bit;
        if (c === 'X')
            b |= bit;
        if (c === 'O')
            w |= bit;
    }
    const grid = { open, diagonals: [], boundary: [] };
    for (let p = 0; p < 25; p++) {
        const x = Math.floor(p / 5), y = p % 5;
        let d = 0, boundary = false;
        for (const [a, c] of [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]]) {
            if (a < 0 || c < 0 || a >= 5 || c >= 5 || !(open & (1 << (a * 5 + c))))
                boundary = true;
            else
                d |= 1 << (a * 5 + c);
        }
        grid.diagonals[p] = d;
        grid.boundary[p] = boundary;
    }
    return { b, w, grid };
}
export function fastMove(b, w, grid, p, who, history = null) {
    if (!Number.isInteger(p) || p < 0 || p >= 25 || ![1, 2].includes(who))
        return null;
    const bit = 1 << p;
    if (!(grid.open & bit) || ((b | w) & bit))
        return null;
    let own = (who === 1 ? b : w) | bit, enemy = who === 1 ? w : b, captured = 0;
    let neighboring = adjacent(bit, grid) & enemy;
    while (neighboring) {
        const first = neighboring & -neighboring, group = flood(first, enemy, grid);
        neighboring &= ~group;
        if (!(adjacent(group, grid) & ~(own | enemy))) {
            enemy &= ~group;
            captured |= group;
        }
    }
    const group = flood(bit, own, grid), libs = adjacent(group, grid) & ~(own | enemy);
    if (!libs)
        return null;
    const nb = who === 1 ? own : enemy, nw = who === 1 ? enemy : own, k = key(nb, nw);
    if (history?.has(k))
        return null;
    return { b: nb, w: nw, key: k, captured: pop(captured), libs: pop(libs), stones: pop(group) };
}
export function fastScore(b, w, grid, komi = 5.5) {
    let black = pop(b), white = pop(w) + komi, empty = grid.open & ~(b | w);
    while (empty) {
        const region = flood(empty & -empty, empty, grid), n = pop(region), border = adjacent(region, grid);
        empty &= ~region;
        // Match native scoring's tiny-opening exception exactly.
        if (n <= 22) {
            if ((border & b) && !(border & w))
                black += n;
            else if ((border & w) && !(border & b))
                white += n;
        }
    }
    return { black, white, margin: black - white };
}
function eye(b, w, grid, p, who) { const own = who === 1 ? b : w, enemy = who === 1 ? w : b, a = adjacent(1 << p, grid); return a !== 0 && (a & own) === a && pop(grid.diagonals[p] & enemy) <= (grid.boundary[p] ? 0 : 1); }
function groupInfo(b, w, grid) {
    const ids = new Int8Array(25).fill(-1), groups = [];
    const empty = grid.open & ~(b | w);
    for (const [color, pieces] of [[1, b], [2, w]]) {
        let remain = pieces;
        while (remain) {
            const group = flood(remain & -remain, pieces, grid), libs = adjacent(group, grid) & empty, id = groups.length;
            remain &= ~group;
            let points = group;
            while (points) {
                const bit = points & -points;
                ids[index(bit)] = id;
                points &= ~bit;
            }
            groups.push({ color, group, libs, n: pop(group), libCount: pop(libs) });
        }
    }
    return { ids, groups };
}
function movesFor(b, w, grid, who, history, mask = ALL) {
    const { ids, groups } = groupInfo(b, w, grid), candidates = [];
    let remaining = grid.open & ~(b | w) & mask;
    while (remaining) {
        const bit = remaining & -remaining, p = index(bit);
        remaining &= ~bit;
        const move = fastMove(b, w, grid, p, who, history);
        if (!move)
            continue;
        let saved = 0, threat = 0, friends = 0, around = adjacent(bit, grid) & (b | w), seen = 0;
        while (around) {
            const a = around & -around, id = ids[index(a)];
            around &= ~a;
            if (seen & (1 << id))
                continue;
            seen |= 1 << id;
            const g = groups[id];
            if (g.color === who) {
                friends++;
                if (g.libCount === 1 && move.libs > 1)
                    saved += g.n;
            }
            else if (g.libCount === 2)
                threat += g.n;
        }
        if (!move.captured && !saved && eye(b, w, grid, p, who))
            continue;
        let prior = 0.3 + Math.min(4, move.libs) * 0.1 + 0.08 * friends + Math.min(10, move.captured) * 1.5 + Math.min(10, saved) * 1.1 + Math.min(6, threat) * 0.25;
        if (move.libs === 1)
            prior -= 2 + move.stones;
        candidates.push({ p, ...move, prior, reason: move.captured ? `capture ${move.captured}` : saved ? `save ${saved} threatened stones` : threat ? 'pressure enemy group' : 'search territory and life' });
    }
    candidates.sort((a, c) => c.prior - a.prior || a.p - c.p);
    return candidates;
}
function seededRandom(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function node(b, w, turn, passes, move = -1, prior = 0, reason = 'pass') { return { b, w, turn, passes, move, prior, reason, n: 0, wins: 0, children: [], untried: null, raveN: new Uint32Array(25), raveW: new Float64Array(25) }; }
function randomBit(bits, random) { let n = Math.floor(random() * pop(bits)); while (n-- > 0)
    bits &= bits - 1; return bits & -bits; }
function rolloutMove(b, w, grid, who, history, random) {
    const empty = grid.open & ~(b | w);
    let capture = 0, save = 0;
    for (const [color, pieces] of [[1, b], [2, w]]) {
        let remain = pieces;
        while (remain) {
            const group = flood(remain & -remain, pieces, grid), libs = adjacent(group, grid) & empty;
            remain &= ~group;
            if (libs && !(libs & (libs - 1))) {
                if (color === who)
                    save |= libs;
                else
                    capture |= libs;
            }
        }
    }
    for (let options of [capture, save & ~capture, empty & ~(save | capture)])
        while (options) {
            const bit = randomBit(options, random), p = index(bit);
            options &= ~bit;
            if (eye(b, w, grid, p, who))
                continue;
            const move = fastMove(b, w, grid, p, who, history);
            if (move && (move.libs > 1 || move.captured))
                return { p, ...move };
        }
    return null;
}
// Each tree edge alternates the maximizing player. RAVE shares rollout evidence
// for later same-color moves, with diminishing influence as direct visits grow.
function* simulate(root, grid, baseHistory, komi, random, counters) {
    const history = new Set(baseHistory), path = [], played = [];
    let at = root;
    for (let depth = 0; at.passes < 2 && depth < 100; depth++) {
        path.push({ at, from: played.length });
        if (at.untried === null)
            at.untried = [...movesFor(at.b, at.w, grid, at.turn, history), { p: -1, prior: -1, reason: 'pass' }];
        if (at.untried.length) {
            const move = at.untried.shift(), child = node(move.p < 0 ? at.b : move.b, move.p < 0 ? at.w : move.w, 3 - at.turn, move.p < 0 ? at.passes + 1 : 0, move.p, move.prior, move.reason);
            at.children.push(child);
            if (move.p >= 0) {
                history.add(move.key);
                played.push([at.turn, move.p]);
            }
            at = child;
            break;
        }
        let best = null, value = -Infinity;
        const log = Math.log(at.n + 1);
        for (const child of at.children) {
            const own = at.turn === 1 ? child.wins / child.n : 1 - child.wins / child.n;
            const rn = child.move >= 0 ? at.raveN[child.move] : 0;
            const rave = rn ? (at.turn === 1 ? at.raveW[child.move] / rn : 1 - at.raveW[child.move] / rn) : own;
            const beta = rn / (rn + child.n + rn * child.n / 200 || 1);
            const u = (1 - beta) * own + beta * rave + 0.7 * Math.sqrt(log / child.n) + 0.15 * Math.max(0, child.prior) / (child.n + 1);
            if (u > value) {
                value = u;
                best = child;
            }
        }
        if (!best)
            break;
        if (best.move >= 0) {
            history.add(key(best.b, best.w));
            played.push([at.turn, best.move]);
        }
        at = best;
    }
    if (path[path.length - 1]?.at !== at)
        path.push({ at, from: played.length });
    let { b, w, turn: who, passes } = at;
    for (let i = 0; passes < 2 && i < 100; i++) {
        const move = rolloutMove(b, w, grid, who, history, random);
        if (move) {
            b = move.b;
            w = move.w;
            history.add(move.key);
            played.push([who, move.p]);
            passes = 0;
        }
        else
            passes++;
        who = 3 - who;
        counters.rolloutMoves++;
        if (i % 16 === 15)
            yield;
    }
    if (passes < 2)
        counters.truncated++;
    const margin = fastScore(b, w, grid, komi).margin;
    // Prefer winning over a larger losing score; margin only breaks close choices.
    const reward = 0.9 * (margin >= 0 ? 1 : 0) + 0.1 * (0.5 + 0.5 * Math.tanh(margin / 10));
    for (const { at, from } of path) {
        at.n++;
        at.wins += reward;
        let seen = 0;
        for (let i = from; i < played.length; i++) {
            const [who, p] = played[i], bit = 1 << p;
            if (who !== at.turn || (seen & bit) || ((at.b | at.w) & bit))
                continue;
            seen |= bit;
            at.raveN[p]++;
            at.raveW[p] += reward;
        }
    }
}
export function scoreGoPosition(board, komi = 5.5) {
    checkBoard(board);
    if (!Number.isFinite(komi))
        throw new Error('Invalid komi');
    if (board.length === 5) {
        const { b, w, grid } = fastBoard(board);
        return fastScore(b, w, grid, komi);
    }
    const { groups } = analyzeBoard(board);
    let black = 0, white = komi;
    for (const g of groups) {
        if (g.color === 'X')
            black += g.points.length;
        else if (g.color === 'O')
            white += g.points.length;
        else if (g.points.length <= board.length ** 2 - 3 && g.borders.size === 1) {
            if (g.borders.has('X'))
                black += g.points.length;
            if (g.borders.has('O'))
                white += g.points.length;
        }
    }
    return { black, white, margin: black - white };
}
/**
 * RAVE-assisted adversarial MCTS for 5x5. Other supported sizes retain the original
 * bounded tactical policy. Wall-clock limits are cooperative, not hard RT guarantees.
 */
export async function chooseSearchMove(board, valid, options = {}) {
    checkBoard(board);
    const n = board.length;
    if (!Array.isArray(valid) || valid.length !== n || valid.some(col => !Array.isArray(col) || col.length !== n || col.some(v => typeof v !== 'boolean')))
        throw new Error('Malformed legal-move mask');
    const komi = options.komi ?? 5.5;
    if (!Number.isFinite(komi))
        throw new Error('Invalid komi');
    if (n !== 5)
        return { ...await chooseGoMove(board, valid, options), algorithm: 'tactical-large-board', simulations: 0, scoreMargin: scoreGoPosition(board, komi).margin };
    const now = options.now || Date.now, yieldControl = options.yieldControl || (async () => { });
    const budget = options.thinkMs ?? 250, limit = options.simulations ?? 2400;
    if (!Number.isFinite(budget) || budget < 1 || budget > 1000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000)
        throw new Error('Invalid search budget');
    if (options.history != null && (!Array.isArray(options.history) || options.history.length > 4096))
        throw new Error('Invalid search history');
    // Current/history keys enforce positional superko throughout search, not only at the root.
    const start = now(), { b, w, grid } = fastBoard(board), root = node(b, w, 1, options.opponentPassed ? 1 : 0), history = new Set();
    for (const k of options.history || []) {
        if (typeof k !== 'string' || k.length !== 25 || /[^XO.#]/.test(k))
            throw new Error('Invalid search history');
        let hb = 0, hw = 0;
        for (let p = 0; p < 25; p++) {
            if (k[p] === 'X')
                hb |= 1 << p;
            if (k[p] === 'O')
                hw |= 1 << p;
        }
        history.add(key(hb, hw));
    }
    history.add(key(b, w));
    const score = fastScore(b, w, grid, komi), base = { algorithm: 'mcts-5x5', considered: 0, replies: 0, cpuMs: 0, limited: false, simulations: 0, rolloutMoves: 0, truncated: 0, scoreMargin: score.margin };
    if (options.opponentPassed && score.margin >= 0)
        return { ...base, x: null, y: null, reason: 'pass: accept a winning final score' };
    let mask = 0;
    for (let p = 0; p < 25; p++)
        if (valid[Math.floor(p / 5)][p % 5])
            mask |= 1 << p;
    const candidates = movesFor(b, w, grid, 1, history, mask);
    if (!candidates.length)
        return { ...base, x: null, y: null, reason: 'pass: no worthwhile safe move' };
    root.untried = [...candidates, { p: -1, prior: -1, reason: 'pass' }];
    let seed = options.seed ?? 0x91e10da5;
    seed ^= b;
    seed = Math.imul(seed, 16777619) ^ w;
    const random = seededRandom(seed), counters = { rolloutMoves: 0, truncated: 0 };
    let cpuMs = Math.max(0, now() - start), sliceStart = now(), simulations = 0, stepsSinceYield = 0;
    for (; simulations < limit && cpuMs < budget; simulations++) {
        const iterator = simulate(root, grid, history, komi, random, counters);
        while (true) {
            const tick = now(), step = iterator.next();
            cpuMs += Math.max(0, now() - tick);
            stepsSinceYield++;
            // The work counter also yields when clock resolution hides elapsed time.
            if (stepsSinceYield >= 32 || now() - sliceStart >= 2) {
                await yieldControl();
                sliceStart = now();
                stepsSinceYield = 0;
            }
            if (step.done)
                break;
        }
    }
    const best = [...root.children].sort((a, c) => c.n - a.n || c.wins / (c.n || 1) - a.wins / (a.n || 1))[0];
    const p = best?.move ?? candidates[0].p;
    return { ...base, ...counters, x: p < 0 ? null : Math.floor(p / 5), y: p < 0 ? null : p % 5, reason: p < 0 ? 'pass: search favors settling' : best?.reason ?? candidates[0].reason,
        considered: candidates.length, replies: root.children.length, simulations, cpuMs, limited: cpuMs >= budget, searchValue: best ? best.wins / best.n : null };
}
