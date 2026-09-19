import { chooseGoMove } from "lib/go-strategy.js";
import { chooseSearchMove } from "lib/go-search.js";
import { GO_STATE_FILE, GO_OPPONENTS, goConfig, readGoSnapshot, snapshotKey, readGoRecord, saveGoRecord, mayStartGo, assertSameGo, verifyGoReply, inferWhiteReply } from "lib/go-session.js";

/** Standalone IPvGO player. Never launched by the supervisor or deployed to the fleet. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["opponent", "Daedalus"], ["size", 5], ["games", 0],
		["takeover", false], ["interval", 500], ["think-ms", 250], ["simulations", 2400], ["strategy", "search"]]);
	ns.disableLog("ALL");
	try {
		if (ns.getHostname() !== "home") throw new Error("Run go-bot.js on home only");
		if (ns.ps("home").some(p => p.filename === ns.getScriptName() && p.pid !== ns.pid)) {
			throw new Error("Only one go-bot.js may play at a time");
		}
		const cfg = goConfig(flags), session = { games: 0, wins: 0, losses: 0, moves: 0, last: "Starting", analysis: null };
		let snapshot = readGoSnapshot(ns);
		const decision = mayStartGo(snapshot, readGoRecord(ns), cfg.takeover);
		const results = readGoResults(ns);
		if (decision === "new") snapshot = await startGame(ns, cfg, snapshot);
		else if (snapshot.game.currentPlayer === "Black") await saveGoRecord(ns, snapshot, "ready");
		let turns = 0;
		let gameMetrics = beginGoMetrics(ns, snapshot, cfg, decision !== "new");

		while (true) {
			if (snapshot.game.currentPlayer !== "White") assertSameGo(ns, snapshot);
			if (snapshot.game.currentPlayer === "None") {
				session.games++;
				const won = snapshot.game.blackScore >= snapshot.game.whiteScore;
				if (won) session.wins++; else session.losses++;
				session.last = `${won ? "Won" : "Lost"} ${snapshot.game.blackScore} to ${snapshot.game.whiteScore} vs ${snapshot.opponent}`;
				await saveGoRecord(ns, snapshot, "complete", { lastResult: session.last });
				await recordGoResult(ns, results, snapshot, gameMetrics);
				renderGo(ns, snapshot, session, "GAME COMPLETE");
				if (cfg.games && session.games >= cfg.games) return;
				await ns.sleep(Math.max(1_000, cfg.interval));
				snapshot = await startGame(ns, cfg, snapshot); turns = 0;
				gameMetrics = beginGoMetrics(ns, snapshot, cfg, false);
				continue;
			}
			if (++turns > snapshot.board.length ** 2 * 8) throw new Error("Turn limit reached; leaving the unfinished board intact");
			if (!GO_OPPONENTS.includes(snapshot.opponent)) throw new Error("Opponent changed; refusing to play");
			let action = null, reply;
			if (snapshot.game.currentPlayer === "White") {
				session.last = "Waiting for the opponent's pending move";
				await saveGoRecord(ns, snapshot, "pending");
				renderGo(ns, snapshot, session, "WAITING FOR OPPONENT");
				const current = readGoSnapshot(ns);
				reply = snapshotKey(current) === snapshotKey(snapshot)
					? await ns.go.opponentNextTurn(false) : inferWhiteReply(snapshot, current);
			} else {
				await ns.sleep(cfg.interval);
				assertSameGo(ns, snapshot);
				const valid = ns.go.analysis.getValidMoves();
				const choose = cfg.strategy === "search" ? chooseSearchMove : chooseGoMove;
				action = await choose(snapshot.board, valid, { thinkMs: cfg.thinkMs,
					simulations: cfg.simulations, komi: snapshot.game.komi, history: snapshot.history,
					opponentPassed: snapshot.game.previousMove === null && snapshot.history.length > 0,
					yieldControl: () => ns.sleep(5) });
				gameMetrics.searches++;
				gameMetrics.cpuMs += action.cpuMs;
				gameMetrics.maxCpuMs = Math.max(gameMetrics.maxCpuMs, action.cpuMs);
				gameMetrics.simulations += action.simulations || 0;
				gameMetrics.budgetHits += Number(Boolean(action.limited));
				session.analysis = action;
				assertSameGo(ns, snapshot);
				// The local model is not the referee. Recheck the live mask, including superko.
				if (action.x !== null && !ns.go.analysis.getValidMoves()[action.x]?.[action.y]) {
					throw new Error("Selected move is no longer legal; stopped instead of retrying blindly");
				}
				session.last = action.x === null ? action.reason : `(${action.x}, ${action.y}) ${action.reason}`;
				await saveGoRecord(ns, snapshot, "pending", { action: { x: action.x, y: action.y } });
				assertSameGo(ns, snapshot);
				renderGo(ns, snapshot, session, "PLAYING / AWAITING REPLY");
				// One awaited API action at a time. No timer watchdog resets a slow opponent.
				reply = action.x === null ? await ns.go.passTurn() : await ns.go.makeMove(action.x, action.y);
				session.moves++;
			}
			const after = readGoSnapshot(ns);
			if (!verifyGoReply(snapshot, action, reply, after)) {
				throw new Error("Unexpected Go transition or manual intervention; board preserved, use --takeover true to resume");
			}
			snapshot = after;
			await saveGoRecord(ns, snapshot, "ready");
			renderGo(ns, snapshot, session, "RUNNING");
		}
	} catch (error) {
		const reason = String(error?.message ?? error);
		ns.print(`STOPPED: ${reason}`);
		// One terminal message on exit, not a terminal-shaped machine gun.
		ns.tprint(`IPvGO bot stopped: ${reason}`);
	}
}

async function startGame(ns, cfg, previous) {
	assertSameGo(ns, previous);
	if (previous.game.currentPlayer !== "None" &&
		(previous.history.length || previous.game.currentPlayer !== "Black" || previous.game.previousMove !== null ||
		previous.board.some(column => column.includes("X")))) throw new Error("Refusing to reset an unfinished game");
	await saveGoRecord(ns, previous, "pending", { resetTo: cfg.opponent });
	assertSameGo(ns, previous);
	ns.go.resetBoardState(cfg.opponent, cfg.size);
	const snapshot = readGoSnapshot(ns);
	if (snapshot.opponent !== cfg.opponent || snapshot.board.length !== cfg.size || snapshot.history.length ||
		snapshot.game.currentPlayer !== "Black") throw new Error("Could not confirm new Go board");
	await saveGoRecord(ns, snapshot, "ready");
	return snapshot;
}

function renderGo(ns, snapshot, session, state) {
	const stats = ns.go.analysis.getStats()[snapshot.opponent];
	const member = ns.getPlayer().factions.includes(snapshot.opponent);
	ns.clearLog();
	ns.print("IPvGO BOT");
	ns.print(`  State          ${state}`);
	ns.print(`  Opponent       ${snapshot.opponent} | ${snapshot.board.length}x${snapshot.board.length}`);
	ns.print(`  Score          You ${snapshot.game.blackScore} | Opponent ${snapshot.game.whiteScore} (includes komi)`);
	ns.print(`  This session   ${session.games} games | ${session.wins} wins | ${session.losses} losses | ${session.moves} turns played`);
	ns.print(`  Last action    ${session.last}`);
	if (session.analysis) {
		const a = session.analysis;
		const method = a.algorithm === "mcts-5x5" ? `MCTS | ${a.simulations} simulations`
			: `${a.considered} candidates, ${a.replies} capture replies${a.algorithm ? " | large-board fallback" : " | heuristic"}`;
		ns.print(`  Analysis       ${method} | ${a.cpuMs.toFixed(1)}ms CPU estimate${a.limited ? " | budget reached" : ""}`);
		if (Number.isFinite(a.scoreMargin)) ns.print(`  Search start   ${a.scoreMargin.toFixed(1)} margin on last analyzed board (includes komi; not a final-score prediction)`);
	}
	if (stats) {
		ns.print(`  Game records   ${stats.wins} wins | ${stats.losses} losses | streak ${stats.winStreak}`);
		ns.print(`  Actual bonus   +${Number(stats.bonusPercent).toFixed(3)}% ${stats.bonusDescription}`);
		ns.print(`  Favor credit   ${stats.rep} rep-equivalent (game-reported cumulative credit, not current faction rep)`);
	}
	ns.print(`  Membership     ${member ? "Joined opponent faction; qualifying win streaks can award favor" : "Not joined; node-power bonus still applies, direct faction favor does not"}`);
	ns.print("  Game history   go-bot-results.txt (last 200 verified completions)");
	ns.print(`  Safety         Stop this bot before playing manually. Resume record: ${GO_STATE_FILE}`);
}


const GO_RESULTS_FILE = "go-bot-results.txt";

function readGoResults(ns) {
	const text = ns.read(GO_RESULTS_FILE);
	if (!text) return { schema: 1, games: [] };
	let value;
	try { value = JSON.parse(text); } catch { throw new Error(`Corrupt ${GO_RESULTS_FILE}; inspect before restarting`); }
	if (value?.schema !== 1 || !Array.isArray(value.games) || value.games.length > 200) {
		throw new Error(`Invalid ${GO_RESULTS_FILE}`);
	}
	return value;
}

function beginGoMetrics(ns, snapshot, cfg, partial) {
	const stats = ns.go.analysis.getStats()[snapshot.opponent];
	return { strategy: cfg.strategy === "search" && snapshot.board.length === 5 ? "mcts-rave-v1" : "heuristic-v1",
		opening: snapshot.board.slice(), thinkMs: cfg.thinkMs, simulationLimit: cfg.simulations, startedAt: Date.now(), partial,
		bonusBefore: Number.isFinite(stats?.bonusPercent) ? stats.bonusPercent : null,
		favorCreditBefore: Number.isFinite(stats?.rep) ? stats.rep : null,
		searches: 0, cpuMs: 0, maxCpuMs: 0, simulations: 0, budgetHits: 0 };
}

async function recordGoResult(ns, results, snapshot, metrics) {
	const stats = ns.go.analysis.getStats()[snapshot.opponent], finishedAt = Date.now();
	const bonusAfter = Number.isFinite(stats?.bonusPercent) ? stats.bonusPercent : null;
	const favorCreditAfter = Number.isFinite(stats?.rep) ? stats.rep : null;
	const result = { ...metrics, finishedAt, elapsedMs: finishedAt - metrics.startedAt,
		epoch: snapshot.epoch, opponent: snapshot.opponent, size: snapshot.board.length, finalBoard: snapshot.board.slice(),
		blackScore: snapshot.game.blackScore, whiteScore: snapshot.game.whiteScore, komi: snapshot.game.komi,
		margin: snapshot.game.blackScore - snapshot.game.whiteScore,
		won: snapshot.game.blackScore >= snapshot.game.whiteScore,
		bonusAfter, bonusDeltaPercentagePoints: metrics.bonusBefore === null || bonusAfter === null ? null : bonusAfter - metrics.bonusBefore,
		favorCreditAfter, favorCreditDelta: metrics.favorCreditBefore === null || favorCreditAfter === null ? null : favorCreditAfter - metrics.favorCreditBefore };
	results.games.push(result);
	results.games = results.games.slice(-200);
	const text = JSON.stringify(results);
	await ns.write(GO_RESULTS_FILE, text, "w");
	if (ns.read(GO_RESULTS_FILE) !== text) throw new Error("Go result persistence failed; final board preserved");
}
