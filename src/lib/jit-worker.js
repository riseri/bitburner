// Operations are still launched JIT, shortly before their individual start times.
// Use a clean-security window and lock the duration immediately with additionalMsec.
// Do not sleep until the last millisecond and then discover a different duration.
export async function runJitWorker(ns, getDuration, execute, hackOptions = null) {
	ns.disableLog("ALL");
	const [targetArg, landingArg, batchArg, portArg, phaseArg, chunkArg] = ns.args;
	const target = String(targetArg);
	const landAt = Number(landingArg);
	const batchId = String(batchArg);
	const phase = String(phaseArg);
	const chunkId = String(chunkArg);
	const controlNumber = Number(ns.args[7] ?? 0);
	const plannedDuration = Number(ns.args[8] ?? getDuration(target));
	const plannedLaunch = Number(ns.args[9] ?? Date.now());
	const prep = phase.startsWith("PREP-");
	const epoch = String(ns.args[12] ?? "");
	const port = ns.getPortHandle(Number(portArg));
	const controlPort = controlNumber > 0 ? ns.getPortHandle(controlNumber) : null;
	const minSecurity = ns.getServerMinSecurityLevel(target);
	if (!Number.isFinite(landAt) || !Number.isFinite(plannedDuration) || plannedDuration <= 0) {
		throw new Error("Invalid JIT worker deadline/duration");
	}

	while (true) {
		const now = Date.now();
		const controlSnapshot = controlPort?.peek();
		const control = controlSnapshot?.version === 2 ? controlSnapshot.targets?.[target] : controlSnapshot;
		if (!prep && epoch && (controlSnapshot?.version !== 2 || control?.epoch !== epoch)) {
			await report(ns, port, { type: "skip", phase, batchId, chunkId, target,
				finishedAt: now, reason: "stale or missing target epoch" });
			return;
		}
		// A call-time latch, not a comparison of a 2s pause with a landing 90s away.
		// The controller separately cancels hacks which have already called ns.hack.
		if (!prep && phase === "H" && (controlSnapshot?.type === "jit-control") && control?.paused) {
			await report(ns, port, { type: "skip", phase, batchId, chunkId, target,
				finishedAt: now, reason: "H call suppressed during recovery" });
			return;
		}

		const security = ns.getServerSecurityLevel(target);
		const duration = getDuration(target);
		const delay = landAt - Date.now() - duration;
		if (!prep && security > minSecurity + 0.001) {
			// A fresh run can gain many hacking levels while this worker is alive,
			// making the clean action shorter than planned. Preserve that new wait
			// headroom, but never let security-inflated duration shorten the original
			// clean-start window while the target is temporarily dirty.
			const latestStart = landAt - Math.min(plannedDuration, duration);
			if (now < latestStart) {
				await ns.sleep(Math.max(1, Math.min(20, latestStart - now)));
				continue;
			}
			await reportMiss("dirty-start", duration, security);
			return;
		}
		if (!prep && delay < 0) {
			await reportMiss("start-deadline", duration, security);
			return;
		}

		const options = hackOptions ? hackOptions(target) : {};
		if (options === null) {
			await report(ns, port, { type: "skip", phase, batchId, chunkId, target,
				finishedAt: Date.now(), reason: "H no longer fits the planned steal budget" });
			return;
		}
		// No await between the final measurement and the HGW invocation.
		const actualDuration = getDuration(target);
		const startedAt = Date.now();
		const additionalMsec = Math.ceil(Math.max(0, landAt - startedAt - actualDuration));
		if (!prep && startedAt + actualDuration > landAt) {
			await reportMiss("start-deadline", actualDuration, security);
			return;
		}
		// Start notifications are optional telemetry. Terminal notifications are reliable.
		port.tryWrite({ type: "started", phase, batchId, chunkId, target, startedAt,
			duration: actualDuration, plannedDuration, landAt, security });
		const result = await execute(target, { ...options, additionalMsec });
		const finishedAt = Date.now();
		await report(ns, port, { type: "done", phase, batchId, chunkId, target, result,
			landAt, startedAt, finishedAt, drift: finishedAt - landAt,
			duration: actualDuration, plannedDuration, security,
			...(phase === "W2" ? { moneyAfter: ns.getServerMoneyAvailable(target),
				securityAfter: ns.getServerSecurityLevel(target) } : {}),
		});
		return;
	}

	async function reportMiss(code, duration, security) {
		const now = Date.now();
		await report(ns, port, {
			type: "miss", code, phase, batchId, chunkId, target, landAt,
			finishedAt: now,
			// Separate actual launch lateness from duration inflation due to security.
			lateBy: Math.max(0, now + duration - landAt),
			launchLag: Math.max(0, now - plannedLaunch),
			durationDelta: duration - plannedDuration,
			duration, plannedDuration, security, minSecurity,
		});
	}
}

async function report(ns, port, message) {
	while (!port.tryWrite(message)) await ns.sleep(1);
}
