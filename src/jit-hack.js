const FINAL_WINDOW_MS = 3;

/** @param {NS} ns */
export async function main(ns) {
	const target = String(ns.args[0]);
	const landAt = Number(ns.args[1]);
	const batchId = String(ns.args[2]);
	const portNumber = Number(ns.args[3]);
	const phase = String(ns.args[4] ?? "H");
	const chunkId = String(ns.args[5] ?? "");
	const maxLate = Number(ns.args[6] ?? 30);
	const controlPortNumber = Number(ns.args[7] ?? 0);

	const port = ns.getPortHandle(portNumber);
	const controlPort = controlPortNumber > 0 ? ns.getPortHandle(controlPortNumber) : null;

	while (true) {
		const duration = ns.getHackTime(target);
		const untilCall = landAt - Date.now() - duration;

		if (untilCall > FINAL_WINDOW_MS) {
			await ns.sleep(
				Math.max(
					1,
					untilCall - FINAL_WINDOW_MS
				)
			);
			continue;
		}

		const control = controlPort ? controlPort.peek() : null;
		if (
			control &&
			typeof control === "object" &&
			control.type === "jit-control" &&
			Number(control.hackPauseUntil) >= landAt
		) {
			await report(port, {
				type: "skip", phase, batchId, chunkId, target, time: Date.now(),
				reason: `H suppressed for local recovery until ${Number(control.hackPauseUntil)}`,
			});
			return;
		}

		if (untilCall < -maxLate) {
			await report(port, {
				type: "miss",
				phase,
				batchId,
				chunkId,
				target,
				lateBy: -untilCall,
				time: Date.now(),
			});

			return;
		}

		const finalDuration =
			ns.getHackTime(target);

		const correction =
			Math.max(
				0,
				landAt -
				Date.now() -
				finalDuration
			);

		const result =
			await ns.hack(target, {
				additionalMsec:
					Math.ceil(correction),
			});

		const finishedAt =
			Date.now();

		await report(port, {
			type: "done",
			phase,
			batchId,
			chunkId,
			target,
			result,
			landAt,
			finishedAt,
			drift:
				finishedAt -
				landAt,
		});

		return;
	}
}

async function report(port, message) {
	while (
		!port.tryWrite(message)
	) {
		await new Promise(
			resolve =>
				setTimeout(resolve, 1)
		);
	}
}