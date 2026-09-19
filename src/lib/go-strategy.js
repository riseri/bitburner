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

/** Local tactical model only. Live root legality (including ko) always comes from the game. */
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

function simpleEye(board, x, y, color) {
	if (board[x]?.[y] !== ".") return false;
	const adjacent = neighbors(board, x, y);
	if (!adjacent.length || adjacent.some(([a, b]) => board[a][b] !== color)) return false;
	const enemy = color === "X" ? "O" : "X";
	const diagonals = [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]];
	const boundary = diagonals.some(([a, b]) => board[a]?.[b] === undefined || board[a][b] === "#");
	const enemyDiagonals = diagonals.filter(([a, b]) => board[a]?.[b] === enemy).length;
	return enemyDiagonals <= (boundary ? 0 : 1);
}

/** Area score with current stones + fully enclosed empty regions. */
export function scoreArea(board, komi = 5.5) {
	checkBoard(board);
	const size = board.length, visited = new Set();
	let black = 0, white = Number(komi) || 0;
	for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
		const value = board[x][y];
		if (value === "X") { black++; continue; }
		if (value === "O") { white++; continue; }
		const key = x * size + y;
		if (value !== "." || visited.has(key)) continue;
		const points = [[x, y]], border = new Set(); visited.add(key);
		for (let i = 0; i < points.length; i++) {
			for (const [a, b] of neighbors(board, ...points[i])) {
				const v = board[a][b], k = a * size + b;
				if (v === "." && !visited.has(k)) { visited.add(k); points.push([a, b]); }
				else if (v === "X" || v === "O") border.add(v);
			}
		}
		if (border.size === 1 && points.length <= size * size - 3) {
			if (border.has("X")) black += points.length;
			else white += points.length;
		}
	}
	return { black, white, margin: black - white };
}

/** Mid-game position value from Black's perspective. */
export function evaluatePosition(board, komi = 5.5) {
	const area = scoreArea(board, komi), { groups } = analyzeBoard(board), size = board.length;
	let value = area.margin * 9;
	const blackStones = [], whiteStones = [];
	for (const group of groups) {
		if (group.color !== "X" && group.color !== "O") continue;
		const sign = group.color === "X" ? 1 : -1, liberties = group.liberties.size, stones = group.points.length;
		if (liberties === 1) value += sign * (-11 - 3 * stones);
		else if (liberties === 2) value += sign * (-2.5 * stones);
		else value += sign * Math.min(6, liberties * 0.75);
		(group.color === "X" ? blackStones : whiteStones).push(...group.points);
	}
	for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
		if (board[x][y] !== ".") continue;
		if (simpleEye(board, x, y, "X")) value += 7;
		if (simpleEye(board, x, y, "O")) value -= 7;
		const blackDistance = nearestDistance(blackStones, x, y);
		const whiteDistance = nearestDistance(whiteStones, x, y);
		if (blackDistance < whiteDistance) value += 0.9;
		else if (whiteDistance < blackDistance) value -= 0.9;
	}
	return value;
}

function nearestDistance(points, x, y) {
	let best = Infinity;
	for (const [a, b] of points) best = Math.min(best, Math.abs(x - a) + Math.abs(y - b));
	return best;
}

function orderedMoves(board, color, history, komi, limit = Infinity, rootMask = null) {
	const before = analyzeBoard(board), enemy = color === "X" ? "O" : "X", seen = new Set(history || []), candidates = [];
	for (let x = 0; x < board.length; x++) for (let y = 0; y < board.length; y++) {
		if (rootMask && !rootMask[x]?.[y]) continue;
		if (board[x][y] !== ".") continue;
		const result = simulateMove(board, x, y, color);
		if (!result || seen.has(result.board.join(""))) continue;
		const around = [...new Set(neighbors(board, x, y).map(([a, b]) => before.ids[a][b]))].map(id => before.groups[id]);
		const friends = around.filter(group => group.color === color), enemies = around.filter(group => group.color === enemy);
		const saved = friends.filter(group => group.liberties.size === 1 && result.own.liberties.size > 1)
			.reduce((sum, group) => sum + group.points.length, 0);
		let threatened = 0;
		for (const group of enemies) {
			const [a, b] = group.points[0];
			if (result.board[a][b] !== enemy) continue;
			const after = result.analysis.groups[result.analysis.ids[a][b]];
			if (group.liberties.size > 1 && after.liberties.size === 1) threatened += group.points.length;
		}
		const ownAtari = result.own.liberties.size === 1 && !result.captured;
		const region = before.groups[before.ids[x][y]];
		if (!result.captured && !saved && !threatened && simpleEye(board, x, y, color)) continue;
		if (!result.captured && !saved && !threatened && region.borders.size === 1 &&
			region.borders.has(color) && region.points.length <= board.length) continue;
		let order = 28 * result.captured + 20 * saved + 8 * threatened + 1.5 * result.own.liberties.size + 3 * Math.max(0, friends.length - 1);
		if (ownAtari) order -= 36 + result.own.points.length * 9;
		const edge = Math.min(x, y, board.length - 1 - x, board.length - 1 - y);
		if (board.length === 5) order += edge === 1 ? 3 : edge === 0 ? -1.5 : 1;
		const reason = result.captured ? `capture ${result.captured}` : saved ? `save ${saved} threatened stones`
			: threatened ? `threaten ${threatened} stones` : friends.length > 1 ? "connect groups" : "expand position";
		candidates.push({ x, y, result, order, reason });
	}
	candidates.sort((a, b) => b.order - a.order || a.x - b.x || a.y - b.y);
	return candidates.slice(0, limit);
}

function searchReply(board, history, komi, widths, context) {
	const whiteMoves = orderedMoves(board, "O", history, komi, widths.white);
	if (!whiteMoves.length) return evaluatePosition(board, komi);
	let worst = Infinity;
	for (const white of whiteMoves) {
		if (budgetExceeded(context)) break;
		context.nodes++;
		const whiteBoard = white.result.board, whiteHistory = [board.join(""), ...history];
		const blackMoves = orderedMoves(whiteBoard, "X", whiteHistory, komi, widths.black);
		let response = evaluatePosition(whiteBoard, komi);
		if (blackMoves.length) {
			response = -Infinity;
			for (const black of blackMoves) {
				context.nodes++;
				response = Math.max(response, evaluatePosition(black.result.board, komi));
				if (budgetExceeded(context)) break;
			}
		}
		worst = Math.min(worst, response);
	}
	return Number.isFinite(worst) ? worst : evaluatePosition(board, komi);
}

function budgetExceeded(context) {
	if ((context.nodes & 15) !== 0) return false;
	const now = context.now(), delta = Math.max(0, now - context.lastNow);
	context.cpuMs += delta; context.lastNow = now;
	return context.cpuMs >= context.budget;
}

/**
 * Bounded adversarial search. On 5x5 it searches our move -> strong white reply ->
 * our counter. Larger boards intentionally use narrower widths to stay cooperative
 * with the rest of the game.
 */
export async function chooseGoMove(board, valid, options = {}) {
	checkBoard(board);
	if (!Array.isArray(valid) || valid.length !== board.length || valid.some(column =>
		!Array.isArray(column) || column.length !== board.length || column.some(value => typeof value !== "boolean"))) {
		throw new Error("Malformed legal-move mask");
	}
	const now = options.now || Date.now, yieldControl = options.yieldControl || (async () => {});
	const budget = Math.min(120, Math.max(1, options.thinkMs ?? 35));
	const komi = Number.isFinite(options.komi) ? options.komi : 5.5;
	const history = Array.isArray(options.history) ? options.history.map(String).slice(0, 128) : [];
	const opponentPassed = Boolean(options.opponentPassed);
	const widths = board.length === 5 ? { root: 10, white: 6, black: 5 }
		: board.length === 7 ? { root: 8, white: 5, black: 4 }
			: { root: 6, white: 4, black: 3 };
	const roots = orderedMoves(board, "X", history, komi, widths.root, valid);
	if (!roots.length) return { x: null, y: null, reason: "pass: no legal move", considered: 0, replies: 0, nodes: 0, cpuMs: 0, limited: false, projected: scoreArea(board, komi).margin };

	const currentArea = scoreArea(board, komi);
	if (opponentPassed && currentArea.margin >= 0) {
		return { x: null, y: null, reason: `pass: winning by ${currentArea.margin.toFixed(1)} after opponent pass`,
			considered: 0, replies: 0, nodes: 0, cpuMs: 0, limited: false, projected: currentArea.margin };
	}

	const start = now(), context = { now, lastNow: start, budget, cpuMs: 0, nodes: 0 };
	let best = null, considered = 0, replies = 0;
	for (const root of roots) {
		const nextHistory = [board.join(""), ...history];
		const beforeNodes = context.nodes;
		const value = searchReply(root.result.board, nextHistory, komi, widths, context);
		replies += context.nodes - beforeNodes;
		considered++;
		const projected = scoreArea(root.result.board, komi).margin;
		if (!best || value > best.value || (value === best.value && root.order > best.root.order)) best = { root, value, projected };
		await yieldControl();
		const stamp = now(); context.cpuMs += Math.max(0, stamp - context.lastNow); context.lastNow = stamp;
		if (context.cpuMs >= budget) break;
	}
	if (!best) return { x: null, y: null, reason: "pass: analysis budget exhausted", considered, replies, nodes: context.nodes, cpuMs: context.cpuMs, limited: true, projected: currentArea.margin };
	const reason = `${best.root.reason}; search ${best.value.toFixed(1)}`;
	return { x: best.root.x, y: best.root.y, reason, considered, replies, nodes: context.nodes,
		cpuMs: context.cpuMs, limited: considered < roots.length || context.cpuMs >= budget, projected: best.projected };
}
