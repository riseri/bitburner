import { readSavings } from "lib/savings.js";
import { PORTS } from "lib/ports.js";
import { progressionPrograms } from "lib/programs.js";
import { freshStatus, resetEpoch, singularityAvailable, actionKey, createRequest, terminalAction, validateRequest } from "lib/progression-protocol.js";

const PURCHASE = "progression-purchase.js", BACKDOOR = "progression-backdoor.js";

export function createActionState() {
	return { active: null, lastResult: null, current: { state: "idle", reason: "Waiting for progression" },
		sequence: 0, blocked: new Map() };
}

export function actorProcesses(ns) {
	return ns.ps("home").filter(process => process.filename === PURCHASE || process.filename === BACKDOOR);
}

/** Collect outcomes before dispatching. One-shot actors have no heartbeat timeout. */
export function tickProgressionActions(ns, state, plan, cfg, now = Date.now()) {
	const port = ns.getPortHandle(PORTS.PROGRESSION_ACTION);
	let board = port.peek();
	const actors = actorProcesses(ns);
	if (actors.length > 1) {
		state.current = { state: "conflict", reason: "Multiple action actors; resolve manually" };
		return;
	}
	if (!state.active && actors.length) {
		const process = actors[0];
		// Adopt a surviving actor only when its command line matches its request.
		if (board?.type === "progression-action" && board.actorPid === process.pid &&
			process.args[0] === JSON.stringify(board.request)) state.active = { request: board.request, pid: process.pid };
		else { state.current = { state: "running", reason: "Existing actor running; not starting another" }; return; }
	}
	if (!state.active && !actors.length && board?.type === "progression-action" &&
		board.request?.requestId && Number.isSafeInteger(board.actorPid) && board.actorPid > 0 &&
		!terminalAction(board.state)) state.active = { request: board.request, pid: board.actorPid };
	if (state.active) {
		const active = state.active;
		const matches = board?.type === "progression-action" && board.request?.requestId === active.request.requestId &&
			board.actorPid === active.pid;
		if (matches && terminalAction(board.state)) state.lastResult = board;
		if (ns.isRunning(active.pid)) {
			state.current = matches ? board : { state: "running", reason: `Waiting for ${active.request.target}` };
			return;
		}
		if (!matches || !terminalAction(board.state)) {
			board = { type: "progression-action", request: active.request, actorPid: active.pid,
				state: "failed", reason: "actor-exited-without-result", updatedAt: now, finishedAt: now };
			// Do not overwrite a newer request from another supervisor.
			if (port.peek()?.request?.requestId === active.request.requestId) { port.clear(); port.write(board); }
		}
		state.lastResult = board;
		if (board.state !== "succeeded") state.blocked.set(actionKey(active.request), {
			until: now + 30_000, reason: board.reason, requiredCash: board.requiredCash });
		state.active = null;
		state.current = board;
		return; // Keep a completed outcome visible for at least one dashboard refresh.
	}
	if (!state.lastResult && board?.type === "progression-action" && terminalAction(board.state)) state.lastResult = board;

	if (!cfg.progression || !cfg.progressionActions) {
		state.current = { state: "disabled", reason: "Planner only; actions disabled" }; return;
	}
	const reset = ns.getResetInfo();
	if (!freshStatus(plan, "progression-status", now) || !plan.planRevision || !resetEpoch(reset) ||
		plan.resetEpoch !== resetEpoch(reset)) {
		state.current = { state: "blocked", reason: "Waiting for a fresh plan from this reset" }; return;
	}
	if (!singularityAvailable(reset)) {
		state.current = { state: "blocked", reason: "Singularity is locked" }; return;
	}
	const reserve = cfg.progressionCashReserve;
	if (!Number.isFinite(reserve) || reserve < 0 || reserve > 0.95) {
		state.current = { state: "blocked", reason: "Invalid progression cash reserve" }; return;
	}
	const cash = ns.getServerMoneyAvailable("home");
	const objectives = Array.isArray(plan.objectives) ? plan.objectives : [];
	let blockedReason = "No runnable progression objectives";
	for (const objective of objectives) {
		// An adopted planner can still carry its previous feature flags.
		if (objective.kind === "program" && !progressionPrograms({ darknet: cfg.darknet !== false }).some(program => program.name === objective.target)) continue;
		if (!objective.ready) { blockedReason = `${objective.target}: ${objective.blocker}`; continue; }
		const key = actionKey(objective), cached = state.blocked.get(key);
		if (cached && now < cached.until && !(cached.reason === "insufficient-cash" && cash >= cached.requiredCash)) {
			blockedReason = `${objective.target}: ${cached.reason} (retry cooling down)`; continue;
		}
		const estimate = objective.costEstimate || 0;
		if (estimate > 0 && (cash * (1 - reserve) < estimate || cash - estimate < readSavings(ns, objective.target).floor)) {
			blockedReason = `${objective.target}: waiting for cash reserve`; continue;
		}
		const request = { ...createRequest(ns, plan, objective, reserve, ++state.sequence, now),
			fleetPort: cfg.fleetStatusPort ?? PORTS.FLEET_STATUS };
		if (validateRequest(request, reset, now)) { blockedReason = "Invalid objective in plan"; continue; }
		const script = objective.kind === "backdoor" ? BACKDOOR : PURCHASE;
		const ram = ns.getScriptRam(script, "home");
		const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
		if (!Number.isFinite(ram) || ram <= 0 || !Number.isFinite(free) || ram > free) {
			blockedReason = `${objective.target}: WAITING_RAM (need ${ram > 0 ? ram.toFixed(2) : "valid script"} GB)`;
			state.blocked.set(key, { until: now + 30_000, reason: "WAITING_RAM" }); continue;
		}
		const pending = { type: "progression-action", request, actorPid: 0, state: "pending", reason: `Starting ${objective.target}`, updatedAt: now };
		port.clear(); port.write(pending);
		let pid = 0;
		try { pid = ns.run(script, 1, JSON.stringify(request)); }
		catch (error) { pending.reason = String(error?.message ?? error); }
		if (!pid) {
			const failed = { ...pending, state: "failed", reason: `start-failed: ${pending.reason}`, finishedAt: now };
			port.clear(); port.write(failed); state.lastResult = state.current = failed;
			state.blocked.set(key, { until: now + 30_000, reason: "start-failed" }); return;
		}
		board = port.peek();
		if (board?.request?.requestId === request.requestId && !board.actorPid) {
			port.clear(); port.write({ ...board, actorPid: pid });
		}
		state.active = { request, pid };
		state.current = { state: "running", reason: `Executing ${objective.target}`, request };
		return;
	}
	state.current = { state: "blocked", reason: blockedReason };
}
