import { withoutAutoInstall } from "lib/supervisor-migration.js";

const STARTUP_GRACE_MS = 60_000;
const STALE_CONFIRM_MS = 15_000;
const STABLE_MS = 120_000;

/** One record per service, including adopted process arguments and restart history. */
export function createService(name, args = [], heartbeatType = "", port = 0, heartbeatRequired = true) {
	return { name, args: [...args], threads: 1, heartbeatType, port, heartbeatRequired, pid: 0,
		state: "STOPPED", startedAt: 0, healthySince: null, staleSince: null,
		nextStartAt: 0, failures: 0, restarts: 0, lastEvent: "", adopted: false };
}

function backoff(service, now, reason) {
	service.failures++;
	service.nextStartAt = now + Math.min(300_000, 5_000 * 2 ** Math.min(6, service.failures - 1));
	service.lastEvent = reason;
	service.lastEventAt = now;
	service.state = "BACKOFF";
	service.healthySince = null;
	service.staleSince = null;
}

/** Check liveness with startup grace; never use dashboard age as daemon health. */
export function tickService(ns, service, now = Date.now()) {
	const matches = ns.ps("home").filter(process => process.filename === service.name);
	if (matches.length > 1) {
		service.state = "CONFLICT";
		service.lastEvent = "Multiple matching processes; refusing to kill or start another";
		return service;
	}

	const process = matches[0];
	if (process && service.pid !== process.pid) {
		// Adopt the command line; only the removed augmentation install switch is discarded.
		service.pid = process.pid;
		service.args = service.name === "augmentation-manager.js" ? withoutAutoInstall(process.args) : [...process.args];
		if (service.port) service.port = Number(readArgument(service.args, "--port", service.port));
		service.threads = process.threads || 1;
		service.adopted = true;
		service.startedAt = now;
		service.healthySince = null;
		service.staleSince = null;
		service.state = "STARTING";
	}

	if (!process) {
		if (service.pid) {
			service.pid = 0;
			backoff(service, now, "Process exited; restart scheduled with preserved arguments");
		}
		if (now < service.nextStartAt) return service;
		if (!ns.fileExists(service.name, "home")) {
			backoff(service, now, `Missing script: ${service.name}`);
			return service;
		}
		// No worker cancellation to make room for a supervisor child.
		let pid = 0;
		try { pid = ns.run(service.name, service.threads, ...service.args); }
		catch (error) { backoff(service, now, `Start failed: ${String(error?.message ?? error)}`); return service; }
		if (!pid) {
			backoff(service, now, "Start failed (check free RAM and script imports)");
			return service;
		}
		service.pid = pid;
		if (service.port) service.port = Number(readArgument(service.args, "--port", service.port));
		service.startedAt = now;
		service.staleSince = null;
		service.healthySince = null;
		if (service.failures) service.restarts++;
		service.state = "STARTING";
		return service; // Give the process an event-loop turn to publish its first heartbeat.
	}

	const status = service.heartbeatType ? ns.getPortHandle(service.port).peek() : null;
	const age = now - status?.generatedAt;
	const interval = Number(status?.heartbeatIntervalMs);
	const timeout = Math.max(15_000, Number.isFinite(interval) && interval > 0 ? interval * 3 : 0);
	const healthy = !service.heartbeatType || !service.heartbeatRequired || (status?.type === service.heartbeatType &&
		Number.isFinite(status.generatedAt) && status.generatedAt >= service.startedAt &&
		(!status.producerPid || status.producerPid === service.pid) && age >= 0 && age <= timeout);
	if (healthy) {
		service.state = "RUNNING";
		service.staleSince = null;
		service.healthySince ??= now;
		if (now - service.healthySince >= STABLE_MS) service.failures = 0;
		return service;
	}
	if (now - service.startedAt < STARTUP_GRACE_MS) {
		service.state = "STARTING";
		return service;
	}
	service.healthySince = null;
	service.staleSince ??= now;
	service.state = "UNRESPONSIVE";
	if (now - service.staleSince < STALE_CONFIRM_MS || now < service.nextStartAt) return service;

	// Exact PID only. A failed kill is not permission to spawn a replacement.
	if (!ns.kill(service.pid) && ns.isRunning(service.pid)) {
		service.nextStartAt = now + 30_000;
		service.lastEvent = "Could not stop unresponsive PID; no duplicate started";
		return service;
	}
	service.pid = 0;
	backoff(service, now, "Heartbeat stopped advancing; bounded restart scheduled");
	return service;
}

export function serviceLabel(service, now = Date.now()) {
	if (!service) return "Disabled";
	if (service.state === "BACKOFF") return `BACKOFF (${Math.max(0, Math.ceil((service.nextStartAt - now) / 1000))}s)`;
	if (["WAITING_RAM", "WAITING_PRIORITY"].includes(service.state)) return `${service.state.replace("WAITING_", "WAITING ")} (${service.waitReason || "admission deferred"})`;
	if (service.state === "BLOCKED" && service.waitReason) return `BLOCKED (${service.waitReason})`;
	return service.state;
}

export function readArgument(args, flag, fallback) {
	let value = fallback;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === flag) value = index + 1 < args.length && !String(args[index + 1]).startsWith("--") ? args[index + 1] : true;
		else if (String(args[index]).startsWith(`${flag}=`)) value = String(args[index]).slice(flag.length + 1);
	}
	return value;
}
