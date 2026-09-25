import { PORTS } from "lib/ports.js";
import { isProgressionProgram } from "lib/programs.js";

const REQUEST_TTL_MS = 15_000;
const BACKDOORS = Object.freeze([
	{ host: "CSEC", faction: "CyberSec" },
	{ host: "avmnite-02h", faction: "NiteSec" },
	{ host: "I.I.I.I", faction: "The Black Hand" },
	{ host: "run4theh111z", faction: "BitRunners" },
]);

export function progressionBackdoors() { return BACKDOORS.map(target => ({ ...target })); }

export function resetEpoch(reset) {
	if (!reset || !Number.isInteger(reset.currentNode) || reset.currentNode < 1 ||
		![reset.lastNodeReset, reset.lastAugReset].every(value => Number.isFinite(value) && value >= 0)) return "";
	return `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}`;
}

export function singularityAvailable(reset) {
	return reset?.currentNode === 4 || Number(reset?.ownedSF?.get?.(4) ?? 0) > 0;
}

export function freshStatus(value, type, now = Date.now()) {
	return Boolean(value && typeof value === "object" && value.type === type && !value.error &&
		(type !== "progression-status" || (Number.isFinite(value.plannedAt) && value.plannedAt <= now && now - value.plannedAt <= REQUEST_TTL_MS)) &&
		Number.isFinite(value.generatedAt) && value.generatedAt <= now && now - value.generatedAt <= REQUEST_TTL_MS);
}

export function actionKey(objective) { return `${objective.kind}:${objective.target}`; }
export function terminalAction(state) { return ["succeeded", "blocked", "failed"].includes(state); }

export function validateRequest(request, reset, now = Date.now()) {
	if (!request || request.version !== 1 || request.type !== "progression-request" ||
		typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 150 ||
		typeof request.planRevision !== "string" || !request.planRevision ||
		!Number.isSafeInteger(request.ownerPid) || request.ownerPid <= 0 ||
		!Number.isFinite(request.createdAt) || !Number.isFinite(request.expiresAt) ||
		request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > REQUEST_TTL_MS ||
		!Number.isFinite(request.reserve) || request.reserve < 0 || request.reserve > 0.95 ||
		(request.fleetPort != null && (!Number.isInteger(request.fleetPort) || request.fleetPort < 1 || request.fleetPort === PORTS.PROGRESSION_ACTION))) return "invalid-request";
	if (now < request.createdAt || now >= request.expiresAt) return "expired-request";
	if (!resetEpoch(reset) || request.resetEpoch !== resetEpoch(reset)) return "reset-changed";
	if (!singularityAvailable(reset)) return "singularity-locked";
	if (request.kind === "tor" && request.target === "TOR") return "";
	if (request.kind === "program" && isProgressionProgram(request.target)) return "";
	if (request.kind === "backdoor" && BACKDOORS.some(target => target.host === request.target)) return "";
	return "target-not-allowed";
}

export function createRequest(ns, plan, objective, reserve, sequence, now = Date.now()) {
	return { type: "progression-request", version: 1,
		requestId: `${ns.pid}:${now}:${sequence}`, ownerPid: ns.pid,
		kind: objective.kind, target: objective.target, planRevision: plan.planRevision,
		createdAt: now, expiresAt: now + REQUEST_TTL_MS, resetEpoch: plan.resetEpoch, reserve };
}

/** CAS-like publication: a late actor cannot clobber a newer request or final result. */
export function publishAction(ns, request, state, reason, details = {}) {
	const port = ns.getPortHandle(PORTS.PROGRESSION_ACTION);
	const previous = port.peek();
	if (previous?.type !== "progression-action" || previous.request?.requestId !== request?.requestId ||
		(previous.actorPid && previous.actorPid !== ns.pid) || terminalAction(previous.state)) return false;
	port.clear();
	port.write({ ...previous, ...details, type: "progression-action", request: previous.request,
		actorPid: ns.pid, state, reason, updatedAt: Date.now(),
		finishedAt: terminalAction(state) ? Date.now() : null });
	return true;
}

/** Actors accept an immutable request, not whichever objective happens to be on port 16. */
export function claimAction(ns, kinds) {
	let request;
	try { request = JSON.parse(String(ns.args[0] ?? "")); }
	catch { ns.print("Invalid action request; launch through supervisor.js"); return null; }
	const board = ns.getPortHandle(PORTS.PROGRESSION_ACTION).peek();
	if (ns.getHostname() !== "home" || board?.type !== "progression-action" ||
		board.state !== "pending" || JSON.stringify(board.request) !== JSON.stringify(request) ||
		(board.actorPid && board.actorPid !== ns.pid)) return null;
	const error = validateRequest(request, ns.getResetInfo()) ||
		(!kinds.includes(request.kind) ? "wrong-actor" : "") ||
		(!ns.ps("home").some(process => process.pid === request.ownerPid && process.filename === "supervisor.js")
			? "owner-exited" : "");
	if (error) { publishAction(ns, request, "blocked", error); return null; }
	return publishAction(ns, request, "running", `Starting ${request.target}`) ? request : null;
}

export function routeBetween(parents, from, to) {
	const left = pathFromHome(parents, from), right = pathFromHome(parents, to);
	if (!left.length || !right.length) return [];
	let common = 0;
	while (common < left.length && common < right.length && left[common] === right[common]) common++;
	return [...left.slice(common - 1).reverse(), ...right.slice(common)];
}

export function pathFromHome(parents, target) {
	const reversed = [], seen = new Set();
	let current = target;
	while (typeof current === "string" && current && !seen.has(current)) {
		seen.add(current); reversed.push(current);
		if (current === "home") return reversed.reverse();
		if (!parents || !Object.prototype.hasOwnProperty.call(parents, current)) break;
		current = parents[current];
	}
	return [];
}
