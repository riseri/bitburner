import { checkBoard, simulateMove } from "lib/go-strategy.js";

export const GO_STATE_FILE = "go-bot-state.txt";
export const GO_OPPONENTS = Object.freeze(["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"]);

export function goConfig(flags) {
	const cfg = { opponent: String(flags.opponent), size: Number(flags.size), games: Number(flags.games),
		interval: Number(flags.interval), thinkMs: Number(flags["think-ms"]), strategy: String(flags.strategy ?? "search"),
		simulations: Number(flags.simulations ?? 2400), takeover: flags.takeover === true || flags.takeover === "true" };
	if (!GO_OPPONENTS.includes(cfg.opponent)) throw new Error(`Choose an ordinary opponent: ${GO_OPPONENTS.join(", ")}`);
	if (![5, 7, 9, 13].includes(cfg.size)) throw new Error("size must be 5, 7, 9, or 13");
	if (!Number.isSafeInteger(cfg.games) || cfg.games < 0) throw new Error("games must be a nonnegative integer (0 means continuous)");
	if (!Number.isFinite(cfg.interval) || cfg.interval < 100 || cfg.interval > 60_000) throw new Error("interval must be 100..60000 ms");
	if (!Number.isFinite(cfg.thinkMs) || cfg.thinkMs < 1 || cfg.thinkMs > 1000) throw new Error("think-ms must be 1..1000");
	if (!["search", "heuristic"].includes(cfg.strategy)) throw new Error("strategy must be search or heuristic");
	if (!Number.isSafeInteger(cfg.simulations) || cfg.simulations < 1 || cfg.simulations > 20000) throw new Error("simulations must be 1..20000");
	return cfg;
}

export function readGoSnapshot(ns) {
	const board = ns.go.getBoardState(), game = ns.go.getGameState(), opponent = ns.go.getOpponent();
	checkBoard(board);
	const history = ns.go.getMoveHistory();
	if (!Array.isArray(history) || history.length > 4096) throw new Error("Invalid or unusually long Go history; leaving the board alone");
	for (const prior of history) {
		checkBoard(prior);
		if (prior.length !== board.length) throw new Error("Inconsistent Go history");
	}
	const reset = ns.getResetInfo();
	if (!reset || !Number.isInteger(reset.currentNode) || reset.currentNode < 1 ||
		![reset.lastNodeReset, reset.lastAugReset].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Invalid reset context");
	if (!["Black", "White", "None"].includes(game.currentPlayer) ||
		![game.blackScore, game.whiteScore, game.komi].every(Number.isFinite) ||
		(game.previousMove !== null && (!Array.isArray(game.previousMove) || game.previousMove.length !== 2 ||
		game.previousMove.some(n => !Number.isInteger(n) || n < 0 || n >= board.length)))) throw new Error("Invalid Go game state");
	return { board, opponent, game, history: history.map(prior => prior.join("")),
		epoch: `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}` };
}

export function snapshotKey(snapshot) {
	const { board, opponent, history, epoch, game } = snapshot;
	return JSON.stringify([epoch, opponent, board, history, game.currentPlayer, game.previousMove, game.komi]);
}

export function readGoRecord(ns) {
	const text = ns.read(GO_STATE_FILE);
	if (!text) return null;
	let record;
	try { record = JSON.parse(text); } catch { throw new Error(`Corrupt ${GO_STATE_FILE}; inspect it before restarting`); }
	if (record?.schema !== 1 || typeof record.key !== "string" ||
		!["ready", "pending", "complete"].includes(record.phase)) throw new Error(`Invalid ${GO_STATE_FILE}`);
	return record;
}

export async function saveGoRecord(ns, snapshot, phase, details = {}) {
	const record = { ...details, schema: 1, phase, key: snapshotKey(snapshot), ownerPid: ns.pid, updatedAt: Date.now() };
	const text = JSON.stringify(record);
	await ns.write(GO_STATE_FILE, text, "w");
	if (ns.read(GO_STATE_FILE) !== text) throw new Error("Go state persistence failed; refusing further moves");
	return record;
}

/** A takeover only authorizes finishing the current game, never resetting it. */
export function mayStartGo(snapshot, record, takeover) {
	if (snapshot.game.currentPlayer === "None") return "new";
	if (!GO_OPPONENTS.includes(snapshot.opponent)) throw new Error("Will not take over No AI or special-opponent games");
	if (record?.phase === "ready" && record.key === snapshotKey(snapshot)) return "resume";
	if (takeover) return "takeover";
	// Even a lone pass is player activity. Only an untouched opening is replaceable.
	if (!snapshot.history.length && snapshot.game.currentPlayer === "Black" &&
		snapshot.game.previousMove === null && !snapshot.board.some(column => column.includes("X"))) return "new";
	throw new Error("Unowned or interrupted game found. Use --takeover true to finish it, or finish it manually first");
}

export function assertSameGo(ns, expected) {
	const current = readGoSnapshot(ns);
	if (snapshotKey(current) !== snapshotKey(expected)) throw new Error("Go board changed outside this bot; stopped without resetting it");
	return current;
}

/**
 * Verify the observed transition, including history, after the API's awaited reply.
 * The game has no exclusive lock/game ID. Identical unobservable interventions
 * cannot be distinguished, so do not run another Go player concurrently.
 */
export function verifyGoReply(before, action, reply, after) {
	if (!reply || !["move", "pass", "gameOver"].includes(reply.type) ||
		before.epoch !== after.epoch || before.opponent !== after.opponent || before.game.komi !== after.game.komi) return false;
	let board = before.board, history = [...before.history];
	if (action && action.x !== null) {
		const own = simulateMove(board, action.x, action.y, "X");
		if (!own) return false;
		history.unshift(board.join("")); board = own.board;
	}
	if (reply.type === "move") {
		if (!Number.isInteger(reply.x) || !Number.isInteger(reply.y)) return false;
		const enemy = simulateMove(board, reply.x, reply.y, "O");
		if (!enemy) return false;
		history.unshift(board.join("")); board = enemy.board;
		if (after.game.currentPlayer !== "Black" || JSON.stringify(after.game.previousMove) !== JSON.stringify([reply.x, reply.y])) return false;
	} else if (reply.type === "gameOver") {
		if (after.game.currentPlayer !== "None" || (action && action.x !== null)) return false;
	} else if (after.game.currentPlayer !== "Black" || (action && action.x === null)) return false;
	return JSON.stringify(board) === JSON.stringify(after.board) && JSON.stringify(history) === JSON.stringify(after.history);
}

/** Infer an already-completed white reply after an awaited state-file write. */
export function inferWhiteReply(before, after) {
	if (before.game.currentPlayer !== "White") return null;
	if (after.history.length === before.history.length + 1) {
		for (let x = 0; x < after.board.length; x++) for (let y = 0; y < after.board.length; y++) {
			if (after.board[x][y] === "O" && before.board[x]?.[y] === ".") return { type: "move", x, y };
		}
	}
	return { type: after.game.currentPlayer === "None" ? "gameOver" : "pass", x: null, y: null };
}
