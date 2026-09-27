// No filesystem or expensive Netscript APIs: only the home manager owns durable state.
export const LEASE_MS = 60_000;
export const SNAPSHOT_MS = 15_000;

function coordinationSnapshot(port) {
	const value = port.peek();
	return value?.type === "darknet-status" && Date.now() - value.generatedAt < SNAPSHOT_MS ? value.coordination : null;
}

export function createCoordinator(ns, cfg) {
	// Cache handles before any timed API starts. Even getPortHandle/getHostname
	// would kill this PID if called while authenticate/heartbleed is pending.
	const pid = ns.pid, from = ns.getHostname(), events = ns.getPortHandle(cfg.eventPort), status = ns.getPortHandle(cfg.coordinationPort);
	const client = `${pid}:${Date.now()}`, owned = new Map();
	let sequence = 0, pending = Promise.resolve();
	let apiPending = Promise.resolve();
	// Netscript permits one blocking call per PID. Neighbor workflows interleave
	// between calls; each independent agent has its own queue.
	const withApi = operation => {
		const run = apiPending.then(operation);
		apiPending = run.catch(() => {});
		return run;
	};
	// One outstanding request per PID means one durable reply is enough for deduplication.
	// Request/ack waits are independent of the API queue and cannot block heartbeats.
	const request = data => {
		const run = pending.then(async () => {
			const message = { ...data, type: "darknet-request", client, seq: ++sequence, pid, from, at: Date.now() };
			let lastSent = -Infinity;
			while (true) {
				const reply = coordinationSnapshot(status)?.replies?.[client];
				if (reply?.seq === message.seq) return reply.result;
				// Backpressure and retries cover full ports and manager restarts. Never discard a credential.
				if (Date.now() - lastSent >= 2_000 && events.tryWrite(message)) lastSent = Date.now();
				await ns.asleep(500);
			}
		});
		pending = run.catch(() => {});
		return run;
	};
	return {
		request, withApi,
		credential: host => coordinationSnapshot(status)?.credentials?.[host] ?? null,
		async acquire(host, details, metrics, reconnect = false) {
			const progressTimeout = (metrics ? Math.max(120_000, 3 * Math.max(metrics.authenticateMax, metrics.heartbleed)) : 1_800_000) * Math.max(1, cfg.concurrency || 1);
			const result = await request({ kind: "acquire", host, modelId: details.modelId, details, reconnect, progressTimeout });
			if (result.token) owned.set(host, { token: result.token, progressAt: Date.now() });
			return result;
		},
		progress(host, token) {
			const lease = coordinationSnapshot(status)?.leases?.[host];
			if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) throw new Error(`Darknet lease lost: ${host}`);
			const activity = owned.get(host);
			if (activity) activity.progressAt = Date.now();
		},
		async finish(event) {
			try { return await request(event); }
			finally { if (owned.get(event.host)?.token === event.token) owned.delete(event.host); }
		},
		pulse() {
			events.tryWrite({ type: "darknet-pulse", pid, from, at: Date.now(),
				leases: [...owned].map(([host, activity]) => ({ host, ...activity })) });
		},
	};
}
