import { chooseGoMove } from "lib/go-strategy.js";
import { PORTS } from "lib/ports.js";
import { dashboardTitle, dashboardSection, dashboardRow } from "lib/dashboard.js";
import { GO_STATE_FILE, GO_OPPONENTS, GO_CYCLE_MS, goConfig, readGoSnapshot, snapshotKey, readGoRecord, saveGoRecord, mayStartGo, assertSameGo, verifyGoReply, inferWhiteReply, daedalusPriorityRng, findDaedalusDistractionWindow } from "lib/go-session.js";

/** Supervisor-managed singleton IPvGO player. Never deployed to the hacking fleet. @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["opponent", "Daedalus"], ["size", 5], ["games", 0],
		["takeover", false], ["interval", 25], ["think-ms", 8], ["rng-snipe", false], ["rng-max-wait", 10_000],
		["port", PORTS.GO_STATUS]]);
	ns.disableLog("ALL");

	let status = null;
	let snapshot = null;
	let session = null;
	try {
		if (ns.getHostname() !== "home") throw new Error("Run go-bot.js on home only");
		if (ns.ps("home").some(p => p.filename === ns.getScriptName() && p.pid !== ns.pid)) {
			throw new Error("Only one go-bot.js may play at a time");
		}

		const statusPort = Number(flags.port);
		const reservedPorts = Object.values(PORTS).filter(port => port !== PORTS.GO_STATUS);
		if (!Number.isSafeInteger(statusPort) || statusPort <= 0 || reservedPorts.includes(statusPort)) {
			throw new Error("port must be a positive status port that does not collide with other automation channels");
		}
		status = ns.getPortHandle(statusPort);
		status.clear();

		const cfg = goConfig(flags);
		session = { games: 0, wins: 0, losses: 0, moves: 0, margin: 0, score: 0, gameMs: 0,
			startedAt: Date.now(), gameStartedAt: Date.now(), startBonus: 0, last: "Starting", analysis: null,
			rng: null, rngAttempts: 0, rngSnipes: 0, rngWaitMs: 0 };
		snapshot = readGoSnapshot(ns);
		const decision = mayStartGo(snapshot, readGoRecord(ns), cfg.takeover);
		if (decision === "new") snapshot = await startGame(ns, cfg, snapshot);
		else if (snapshot.game.currentPlayer === "Black") await saveGoRecord(ns, snapshot, "ready");
		session.bonusOpponent = snapshot.opponent;
		session.startBonus = Number(ns.go.analysis.getStats()[snapshot.opponent]?.bonusPercent) || 0;
		session.startedAt = Date.now();
		session.gameStartedAt = Date.now();
		let turns = 0;
		renderGo(ns, snapshot, session, "STARTING", status);

		while (true) {
			if (snapshot.game.currentPlayer !== "White") assertSameGo(ns, snapshot);
			if (snapshot.game.currentPlayer === "None") {
				session.games++;
				const won = snapshot.game.blackScore >= snapshot.game.whiteScore;
				if (won) session.wins++; else session.losses++;
				session.margin += snapshot.game.blackScore - snapshot.game.whiteScore;
				session.score += snapshot.game.blackScore;
				session.gameMs += Math.max(0, Date.now() - session.gameStartedAt);
				session.last = `${won ? "Won" : "Lost"} ${snapshot.game.blackScore} to ${snapshot.game.whiteScore} vs ${snapshot.opponent}`;
				await saveGoRecord(ns, snapshot, "complete", { lastResult: session.last });
				renderGo(ns, snapshot, session, "GAME COMPLETE", status);
				if (cfg.games && session.games >= cfg.games) return;
				await ns.sleep(Math.max(250, cfg.interval));
				snapshot = await startGame(ns, cfg, snapshot);
				if (snapshot.opponent !== session.bonusOpponent) {
					session.bonusOpponent = snapshot.opponent;
					session.startBonus = Number(ns.go.analysis.getStats()[snapshot.opponent]?.bonusPercent) || 0;
					session.startedAt = Date.now();
				}
				session.gameStartedAt = Date.now(); turns = 0;
				continue;
			}
			if (++turns > snapshot.board.length ** 2 * 8) throw new Error("Turn limit reached; leaving the unfinished board intact");
			if (!GO_OPPONENTS.includes(snapshot.opponent)) throw new Error("Opponent changed; refusing to play");
			let action = null, reply;
			if (snapshot.game.currentPlayer === "White") {
				session.last = "Waiting for the opponent's pending move";
				await saveGoRecord(ns, snapshot, "pending");
				renderGo(ns, snapshot, session, "WAITING FOR OPPONENT", status);
				const current = readGoSnapshot(ns);
				reply = snapshotKey(current) === snapshotKey(snapshot)
					? await ns.go.opponentNextTurn(false) : inferWhiteReply(snapshot, current);
			} else {
				await ns.sleep(cfg.interval);
				assertSameGo(ns, snapshot);
				const valid = ns.go.analysis.getValidMoves();
				action = await chooseGoMove(snapshot.board, valid, {
					thinkMs: cfg.thinkMs,
					komi: snapshot.game.komi,
					history: snapshot.history,
					opponentPassed: snapshot.game.previousMove === null && snapshot.history.length > 0,
					yieldControl: () => ns.sleep(1),
				});
				session.analysis = action;
				assertSameGo(ns, snapshot);
				// The local model is not the referee. Recheck the live mask, including superko.
				if (action.x !== null && !ns.go.analysis.getValidMoves()[action.x]?.[action.y]) {
					throw new Error("Selected move is no longer legal; stopped instead of retrying blindly");
				}
				const endingPass = action.x === null && snapshot.game.previousMove === null && snapshot.history.length > 0;
				if (!endingPass && snapshot.opponent === "Daedalus" && cfg.rngSnipe) {
					session.rng = await alignDaedalusRng(ns, snapshot, cfg);
					session.rngAttempts++;
					if (session.rng.armed) session.rngSnipes++;
					session.rngWaitMs += session.rng.waitedMs;
				} else if (snapshot.opponent !== "Daedalus" || !cfg.rngSnipe) session.rng = null;
				assertSameGo(ns, snapshot);
				session.last = action.x === null ? action.reason : `(${action.x}, ${action.y}) ${action.reason}`;
				await saveGoRecord(ns, snapshot, "pending", { action: { x: action.x, y: action.y } });
				assertSameGo(ns, snapshot);
				renderGo(ns, snapshot, session, "PLAYING / AWAITING REPLY", status);
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
			renderGo(ns, snapshot, session, "RUNNING", status);
		}
	} catch (error) {
		const reason = String(error?.message ?? error);
		if (status) publishGoStopped(status, ns, snapshot, session, reason);
		ns.print(`STOPPED: ${reason}`);
		// One terminal message on exit. The supervisor treats STOPPED status as blocked,
		// so it will not blindly restart a game with uncertain ownership.
		ns.tprint(`IPvGO bot stopped: ${reason}`);
	}
}

async function alignDaedalusRng(ns, snapshot, cfg) {
	let waitedMs = 0, attempts = 0, lastPriority = [];
	while (attempts++ < 4 && waitedMs <= cfg.rngMaxWait) {
		const totalPlaytime = Number(ns.getPlayer().totalPlaytime);
		if (!Number.isFinite(totalPlaytime) || totalPlaytime < 0) {
			return { armed: false, waitedMs, priority: [], reason: "playtime unavailable" };
		}
		const remaining = Math.max(0, cfg.rngMaxWait - waitedMs);
		const plan = findDaedalusDistractionWindow(totalPlaytime, remaining);
		if (!plan) return { armed: false, waitedMs, priority: [], reason: "no distraction band" };
		if (plan.waitMs > 0) {
			await ns.sleep(plan.waitMs);
			waitedMs += plan.waitMs;
		}
		assertSameGo(ns, snapshot);
		const actual = Number(ns.getPlayer().totalPlaytime);
		lastPriority = [0, 1, 2].map(index => daedalusPriorityRng(actual + index * GO_CYCLE_MS));
		// Three favorable ticks cover the state write plus the AI's initial 200ms wait.
		if (lastPriority.every(value => value >= 0.9)) {
			return { armed: true, waitedMs, priority: lastPriority, seed: actual, reason: "Daedalus distraction band" };
		}
		if (waitedMs + GO_CYCLE_MS > cfg.rngMaxWait) break;
		await ns.sleep(GO_CYCLE_MS);
		waitedMs += GO_CYCLE_MS;
	}
	return { armed: false, waitedMs, priority: lastPriority, reason: "timing band slipped" };
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

function renderGo(ns, snapshot, session, state, status = null) {
	const stats = ns.go.analysis.getStats()[snapshot.opponent];
	const member = ns.getPlayer().factions.includes(snapshot.opponent);
	const row = (label, value) => dashboardRow(ns, label, value);
	publishGoStatus(status, ns, snapshot, session, state, stats, member);

	ns.clearLog();
	dashboardTitle(ns, "IPvGO BOT");

	dashboardSection(ns, "Game");
	row("State", state);
	row("Opponent", `${snapshot.opponent} | ${snapshot.board.length}x${snapshot.board.length}`);
	row("Score", `you ${snapshot.game.blackScore} | opponent ${snapshot.game.whiteScore} (komi included)`);
	row("Session", `${session.games} games | ${session.wins} wins | ${session.losses} losses | ${session.moves} moves`);
	if (session.games) {
		const avgGameMs = session.gameMs / session.games;
		const scorePerMinute = session.gameMs > 0 ? session.score / (session.gameMs / 60_000) : 0;
		row("Pace", `${(avgGameMs / 1000).toFixed(1)}s/game | ${scorePerMinute.toFixed(1)} score/min | ${(session.margin / session.games).toFixed(2)} avg margin`);
	}
	row("Last action", session.last);

	if (session.analysis) {
		const a = session.analysis;
		dashboardSection(ns, "Decision");
		row("Search", `${a.considered} roots | ${a.nodes ?? a.replies} nodes | ${a.cpuMs.toFixed(1)}ms${a.limited ? " | budget reached" : ""}`);
		row("Projection", `${Number(a.projected ?? 0).toFixed(1)} immediate area margin`);
	}

	if (stats) {
		dashboardSection(ns, "Rewards");
		row("Record", `${stats.wins} wins | ${stats.losses} losses | streak ${stats.winStreak}`);
		row("Actual bonus", `+${Number(stats.bonusPercent).toFixed(3)}% | ${stats.bonusDescription}`);
		const elapsedHours = Math.max(1, Date.now() - session.startedAt) / 3_600_000;
		const bonusRate = (Number(stats.bonusPercent) - session.startBonus) / elapsedHours;
		row("Bonus pace", `${bonusRate >= 0 ? "+" : ""}${bonusRate.toFixed(3)}%/hour this session`);
		row("Membership", member ? "Joined; qualifying win streaks can award favor" : "Not joined; node-power bonus still applies");
	}

	if (session.rngAttempts) {
		dashboardSection(ns, "Daedalus timing");
		const r = session.rng;
		const last = r ? `${r.armed ? "ARMED" : "MISS"} | last wait ${(r.waitedMs / 1000).toFixed(1)}s` : "not needed on final pass";
		row("RNG rig", `${session.rngSnipes}/${session.rngAttempts} armed | ${last} | total wait ${(session.rngWaitMs / 1000).toFixed(1)}s`);
		if (r?.priority?.length) row("Daedalus RNG", `${r.priority.map(value => value.toFixed(3)).join(" / ")} priority samples`);
	}

	dashboardSection(ns, "Safety");
	row("Manual play", `Stop this bot first | resume state: ${GO_STATE_FILE}`);
}

function publishGoStatus(port, ns, snapshot, session, state, stats = null, member = false) {
	if (!port || !snapshot || !session) return;
	port.clear();
	port.write({
		type: "go-status",
		version: 1,
		generatedAt: Date.now(),
		producerPid: ns.pid,
		state,
		terminal: false,
		opponent: snapshot.opponent,
		size: snapshot.board.length,
		currentPlayer: snapshot.game.currentPlayer,
		blackScore: snapshot.game.blackScore,
		whiteScore: snapshot.game.whiteScore,
		games: session.games,
		wins: session.wins,
		losses: session.losses,
		moves: session.moves,
		last: session.last,
		bonusPercent: Number(stats?.bonusPercent) || 0,
		bonusDescription: stats?.bonusDescription || "",
		winStreak: Number(stats?.winStreak) || 0,
		member: Boolean(member),
	});
}

function publishGoStopped(port, ns, snapshot, session, error) {
	port.clear();
	port.write({
		type: "go-status",
		version: 1,
		generatedAt: Date.now(),
		producerPid: ns.pid,
		state: "STOPPED",
		terminal: true,
		error,
		opponent: snapshot?.opponent || "",
		size: snapshot?.board?.length || 0,
		games: session?.games || 0,
		wins: session?.wins || 0,
		losses: session?.losses || 0,
		moves: session?.moves || 0,
		last: session?.last || "Stopped before session initialization",
	});
}


