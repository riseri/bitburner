import { chooseGoMove } from "lib/go-strategy.js";
import { GO_STATE_FILE, GO_OPPONENTS, goConfig, readGoSnapshot, snapshotKey, readGoRecord, saveGoRecord, mayStartGo, assertSameGo, verifyGoReply, inferWhiteReply } from "lib/go-session.js";

/** Standalone IPvGO player. Never launched by the supervisor or deployed to the fleet. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["opponent", "Daedalus"], ["size", 5], ["games", 0],
		["takeover", false], ["interval", 500], ["think-ms", 15]]);
	ns.disableLog("ALL");
	try {
		if (ns.getHostname() !== "home") throw new Error("Run go-bot.js on home only");
		if (ns.ps("home").some(p => p.filename === ns.getScriptName() && p.pid !== ns.pid)) {
			throw new Error("Only one go-bot.js may play at a time");
		}
		const cfg = goConfig(flags), session = { games: 0, wins: 0, losses: 0, moves: 0, last: "Starting", analysis: null };
		let snapshot = readGoSnapshot(ns);
		const decision = mayStartGo(snapshot, readGoRecord(ns), cfg.takeover);
		if (decision === "new") snapshot = await startGame(ns, cfg, snapshot);
		else if (snapshot.game.currentPlayer === "Black") await saveGoRecord(ns, snapshot, "ready");
		let turns = 0;

		while (true) {
			if (snapshot.game.currentPlayer !== "White") assertSameGo(ns, snapshot);
			if (snapshot.game.currentPlayer === "None") {
				session.games++;
				const won = snapshot.game.blackScore >= snapshot.game.whiteScore;
				if (won) session.wins++; else session.losses++;
				session.last = `${won ? "Won" : "Lost"} ${snapshot.game.blackScore} to ${snapshot.game.whiteScore} vs ${snapshot.opponent}`;
				await saveGoRecord(ns, snapshot, "complete", { lastResult: session.last });
				renderGo(ns, snapshot, session, "GAME COMPLETE");
				if (cfg.games && session.games >= cfg.games) return;
				await ns.sleep(Math.max(1_000, cfg.interval));
				snapshot = await startGame(ns, cfg, snapshot); turns = 0;
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
				action = await chooseGoMove(snapshot.board, valid, { thinkMs: cfg.thinkMs,
					yieldControl: () => ns.sleep(5) });
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
		ns.print(`  Analysis       ${a.considered} candidates, ${a.replies} capture replies | ${a.cpuMs.toFixed(1)}ms CPU estimate${a.limited ? " | budget reached" : ""}`);
	}
	if (stats) {
		ns.print(`  Game records   ${stats.wins} wins | ${stats.losses} losses | streak ${stats.winStreak}`);
		ns.print(`  Actual bonus   +${Number(stats.bonusPercent).toFixed(3)}% ${stats.bonusDescription}`);
		ns.print(`  Favor credit   ${stats.rep} rep-equivalent (game-reported cumulative credit, not current faction rep)`);
	}
	ns.print(`  Membership     ${member ? "Joined opponent faction; qualifying win streaks can award favor" : "Not joined; node-power bonus still applies, direct faction favor does not"}`);
	ns.print(`  Safety         Stop this bot before playing manually. Resume record: ${GO_STATE_FILE}`);
}
