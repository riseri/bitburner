const HOME = "home", SHARE_WORKER = "share-worker.js";

export function homeShareRam(ns) {
	const workers = ns.ps(HOME).filter(process => process.filename === SHARE_WORKER);
	if (!workers.length) return 0;
	return ns.getScriptRam(SHARE_WORKER, HOME) * workers.reduce((sum, process) => sum + Math.max(1, process.threads || 1), 0);
}

/** Sharing is disposable. Recheck real free RAM after each exact home share PID. */
export function reclaimHomeShare(ns, requiredFree) {
	const free = () => ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME);
	if (free() >= requiredFree) return true;
	for (const process of ns.ps(HOME).filter(process => process.filename === SHARE_WORKER)) {
		ns.kill(process.pid);
		if (free() >= requiredFree) return true;
	}
	return false;
}
