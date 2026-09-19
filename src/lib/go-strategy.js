// IPvGO uses board[x][y], not row/column order. These helpers never call Netscript.
export function checkBoard(board) {
	if (!Array.isArray(board) || ![5, 7, 9, 13].includes(board.length) ||
		board.some(column => typeof column !== "string" || column.length !== board.length || /[^XO.#]/.test(column))) {
		throw new Error("Expected a 5, 7, 9, or 13 square IPvGO board");
	}
}

export function neighbors(board, x, y) {
	return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
		.filter(([a, b]) => board[a]?.[b] !== undefined && board[a][b] !== "#");
}

export function analyzeBoard(board) {
	checkBoard(board);
	const size = board.length, ids = Array.from({ length: size }, () => Array(size).fill(-1));
	const groups = [];
	for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
		if (board[x][y] === "#" || ids[x][y] !== -1) continue;
		const color = board[x][y], id = groups.length, points = [[x, y]], liberties = new Set(), borders = new Set();
		ids[x][y] = id;
		for (let i = 0; i < points.length; i++) {
			for (const [a, b] of neighbors(board, ...points[i])) {
				if (board[a][b] === color && ids[a][b] === -1) {
					ids[a][b] = id; points.push([a, b]);
				} else if (board[a][b] !== color) {
					borders.add(board[a][b]);
					if (board[a][b] === ".") liberties.add(a * size + b);
				}
			}
		}
		groups.push({ id, color, points, liberties, borders });
	}
	return { ids, groups };
}

/** Local tactical model only. Live legality (including ko) always comes from the game. */
export function simulateMove(board, x, y, color = "X") {
	if (board[x]?.[y] !== "." || !["X", "O"].includes(color)) return null;
	const next = board.map(column => [...column]), enemy = color === "X" ? "O" : "X";
	next[x][y] = color;
	let strings = next.map(column => column.join(""));
	let analysis = analyzeBoard(strings), captured = 0;
	const adjacent = new Set(neighbors(strings, x, y).map(([a, b]) => analysis.ids[a][b]));
	for (const id of adjacent) {
		const group = analysis.groups[id];
		if (group.color !== enemy || group.liberties.size) continue;
		captured += group.points.length;
		for (const [a, b] of group.points) next[a][b] = ".";
	}
	strings = next.map(column => column.join(""));
	analysis = analyzeBoard(strings);
	const own = analysis.groups[analysis.ids[x][y]];
	return own.liberties.size ? { board: strings, analysis, own, captured } : null;
}

function isEye(board, x, y) {
	const adjacent = neighbors(board, x, y);
	if (!adjacent.length || adjacent.some(([a, b]) => board[a][b] !== "X")) return false;
	const diagonals = [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]];
	const boundary = diagonals.some(([a, b]) => board[a]?.[b] === undefined || board[a][b] === "#");
	const bad = diagonals.filter(([a, b]) => board[a]?.[b] === "O").length;
	return bad <= (boundary ? 0 : 1);
}

function candidateValue(board, before, x, y, result) {
	const around = [...new Set(neighbors(board, x, y).map(([a, b]) => before.ids[a][b]))]
		.map(id => before.groups[id]);
	const friends = around.filter(g => g.color === "X"), enemies = around.filter(g => g.color === "O");
	const rescued = friends.filter(g => g.liberties.size === 1 && result.own.liberties.size > 1)
		.reduce((sum, g) => sum + g.points.length, 0);
	const region = before.groups[before.ids[x][y]];
	// Do not pave over a living group's eyes just because the move is legal.
	if (!result.captured && !rescued && isEye(board, x, y)) return null;
	if (!result.captured && !rescued && region.borders.size === 1 && region.borders.has("X") &&
		region.points.length <= board.length && friends.length <= 1) return null;

	const selfAtari = result.own.liberties.size === 1;
	let score = 18 * result.captured + 15 * rescued;
	if (selfAtari) score -= 22 + 18 * result.own.points.length;
	let threats = 0;
	for (const enemy of enemies) {
		const [a, b] = enemy.points[0];
		if (result.board[a][b] !== "O") continue;
		const remaining = result.analysis.groups[result.analysis.ids[a][b]].liberties.size;
		if (enemy.liberties.size > 1 && remaining === 1) threats += 4 + Math.min(8, enemy.points.length);
	}
	score += threats + 2 * Math.max(0, friends.length - 1) + Math.min(4, result.own.liberties.size);
	const edge = Math.min(x, y, board.length - 1 - x, board.length - 1 - y);
	score += edge === (board.length === 5 ? 1 : 2) ? 2 : edge === 0 ? -2 : 1;
	let nearest = Infinity;
	for (const g of before.groups) if (g.color === "X") for (const [a, b] of g.points) {
		nearest = Math.min(nearest, Math.abs(x - a) + Math.abs(y - b));
	}
	score += nearest === 2 ? 2.5 : nearest === 3 ? 1 : nearest === 1 ? 0 : 0.5;
	const reason = result.captured ? `capture ${result.captured}` : rescued ? `save ${rescued} threatened stones`
		: threats ? "threaten capture" : friends.length > 1 ? "connect groups" : "expand safely";
	return { x, y, score, reason, result };
}

/**
 * Rank one-ply tactics, then inspect immediate capture replies on up to 6 finalists.
 * CPU accounting excludes deliberate sleeps. One board evaluation is indivisible;
 * the deadline is cooperative, not a hard guarantee against GC or API latency.
 */
export async function chooseGoMove(board, valid, options = {}) {
	checkBoard(board);
	if (!Array.isArray(valid) || valid.length !== board.length || valid.some(column =>
		!Array.isArray(column) || column.length !== board.length || column.some(v => typeof v !== "boolean"))) {
		throw new Error("Malformed legal-move mask");
	}
	const now = options.now || Date.now, yieldControl = options.yieldControl || (async () => {});
	const budget = Math.min(100, Math.max(1, options.thinkMs ?? 15));
	const before = analyzeBoard(board), candidates = [], ranked = [];
	let cpuMs = 0, considered = 0, replies = 0;
	for (let x = 0; x < board.length; x++) for (let y = 0; y < board.length; y++) {
		if (!valid[x][y] || board[x][y] !== ".") continue;
		const adjacent = new Set(neighbors(board, x, y).map(([a, b]) => before.ids[a][b]));
		let urgency = Math.min(x, y, board.length - 1 - x, board.length - 1 - y);
		for (const id of adjacent) {
			const g = before.groups[id];
			if (g.color !== "." && g.liberties.size === 1) urgency += 100 + g.points.length;
		}
		candidates.push({ x, y, urgency });
	}
	candidates.sort((a, b) => b.urgency - a.urgency || a.x - b.x || a.y - b.y);
	for (const { x, y } of candidates) {
		const start = now(), result = simulateMove(board, x, y);
		if (result) {
			const candidate = candidateValue(board, before, x, y, result);
			if (candidate) ranked.push(candidate);
		}
		considered++; cpuMs += Math.max(0, now() - start);
		await yieldControl();
		if (cpuMs >= budget) break;
	}
	ranked.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
	const finalists = ranked.slice(0, 6);
	for (const candidate of finalists) {
		let worst = 0;
		const vulnerable = new Set();
		for (const g of candidate.result.analysis.groups) if (g.color === "X" && g.liberties.size === 1) {
			vulnerable.add([...g.liberties][0]);
		}
		for (const point of [...vulnerable].slice(0, 8)) {
			if (cpuMs >= budget) break;
			const start = now();
			const reply = simulateMove(candidate.result.board, Math.floor(point / board.length), point % board.length, "O");
			if (reply && reply.board.join("") !== board.join("")) worst = Math.max(worst, reply.captured);
			replies++; cpuMs += Math.max(0, now() - start);
			await yieldControl();
		}
		candidate.score -= 20 * worst;
	}
	// Do not favor an unexamined runner-up over a finalist whose risk was checked.
	finalists.sort((a, b) => b.score - a.score || a.x - b.x || a.y - b.y);
	const best = finalists[0];
	return { x: best && best.score > 0 ? best.x : null, y: best && best.score > 0 ? best.y : null,
		reason: best && best.score > 0 ? best.reason : "pass: no worthwhile safe move",
		considered, replies, cpuMs, limited: considered < candidates.length || cpuMs >= budget };
}
