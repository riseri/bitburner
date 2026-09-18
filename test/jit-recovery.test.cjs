const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { Clock, Port, loadScript, root } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock();
    const api = loadScript('daemon.js', clock);
    const port = new Port(), control = new Port();
    const cfg = { gap: 100, lead: 600, port: 20, controlPort: 15, homeReserve: 8 };
    const runtime = { plan: { period: 420, times: { H: 90_000, G: 288_000, W: 360_000 } } };
    const stats = api.createStats();
    const batches = new Map(), running = new Map(), byChunk = new Map();
    const health = { money: 500, max: 1000, sec: 13, min: 12 };
    const killed = [];
    const ns = {
        getServerMoneyAvailable: () => health.money, getServerMaxMoney: () => health.max,
        getServerSecurityLevel: () => health.sec, getServerMinSecurityLevel: () => health.min,
        kill: pid => { killed.push(pid); return running.has(pid); },
        isRunning: pid => running.has(pid),
    };
    function batch(id = '1', landing = clock.now + 1000, splitW2 = false) {
        const chunks = ['H', 'W1', 'G', 'W2', ...(splitW2 ? ['W2'] : [])].map((phase, i) => ({
            phase, batchId: id, chunkId: `${id}-${phase}-${i}`, host: 'cloud-00',
            landAt: landing + ({ H: 0, W1: 100, G: 200, W2: 300 }[phase]),
            launchAt: clock.now - 10, threads: 1, ram: 2, script: `jit-${phase}.js`, duration: 1000,
        }));
        const state = api.makeBatchState(id, chunks); batches.set(id, state); return state;
    }
    function track(state) {
        for (const chunk of state.chunks.values()) {
            const pid = running.size + 100;
            api.trackRunning(running, pid, chunk); byChunk.set(chunk.chunkId, pid); chunk.status = 'called';
        }
    }
    function done(state, phase, result = 0, overrides = {}) {
        const chunk = [...state.chunks.values()].find(c => c.phase === phase && !api.isTerminalChunk(c));
        port.tryWrite({ type: 'done', target: 'the-hub', phase, batchId: state.id,
            chunkId: chunk.chunkId, finishedAt: chunk.landAt, result, drift: 0, ...overrides });
    }
    function consume() { return api.consumeEvents(ns, port, batches, stats, 'the-hub', runtime, cfg, running, byChunk); }
    return { clock, api, port, control, cfg, runtime, stats, batches, running, byChunk, health, killed, ns, batch, track, done, consume };
}

test('recovery deadline cannot slide under continuous misses', () => {
    const f = fixture();
    let recovery = f.api.beginSoftRecovery(null, { reason: 'first' }, f.control, f.runtime, f.stats);
    const start = f.clock.now;
    let escalated = null;
    for (let elapsed = 100; elapsed <= 16_000; elapsed += 100) {
        f.clock.now = start + elapsed;
        recovery = f.api.beginSoftRecovery(recovery, { reason: 'another miss' }, f.control, f.runtime, f.stats);
        const result = f.api.updateSoftRecovery(f.ns, 'the-hub', recovery, f.control, f.runtime, f.stats);
        recovery = result.recovery;
        if (result.problem) { escalated = { elapsed, problem: result.problem }; break; }
    }
    assert.ok(escalated, 'must escalate, not keep resetting checkAt forever');
    assert.equal(escalated.elapsed, 15_000);
    assert.equal(escalated.problem.hard, true);
    assert.equal(f.control.peek().paused, true, 'timeout must not reopen the hack gate');
});

test('security 100 trips the circuit breaker without waiting for a deadline', () => {
    const f = fixture(); f.health.sec = 100;
    const r = f.api.beginSoftRecovery(null, { reason: 'inflated duration' }, f.control, f.runtime, f.stats);
    assert.equal(f.api.updateSoftRecovery(f.ns, 'the-hub', r, f.control, f.runtime, f.stats).problem.hard, true);
});

test('a local repair cancels already-invoked imminent H, not its G/W tails or far-future H', () => {
    const f = fixture(); const first = f.batch(); f.track(first); const later = f.batch('2', f.clock.now + 90_000); f.track(later);
    f.api.cancelHackWindow(f.ns, f.batches, f.running, f.byChunk, f.stats, f.clock.now + 2000);
    assert.equal(f.killed.length, 1); assert.equal(first.phases.H.skipped, true);
    assert.equal(later.phases.H.skipped, false);
    assert.equal(f.running.size, 7);
    assert.equal(f.api.totalRunningRam(f.running), 14);
    assert.equal(f.stats.suppressedHackChunks, 1);
});

test('failed PID cancellation waits for real completion instead of inventing a skip', () => {
    const f = fixture(), b = f.batch(); f.track(b); f.ns.kill = () => false;
    f.api.cancelHackWindow(f.ns, f.batches, f.running, f.byChunk, f.stats, f.clock.now + 2000);
    assert.equal(b.phases.H.complete, false);
    f.done(b, 'H', 250); f.consume(); assert.equal(f.stats.money, 250);
});

test('missed future W2 cancels that batch H/G and preserves weaken work', () => {
    const f = fixture(), b = f.batch('1', f.clock.now + 300_000); f.track(b);
    const w2 = [...b.chunks.values()].find(c => c.phase === 'W2');
    f.port.tryWrite({ type: 'miss', phase: 'W2', batchId: b.id, chunkId: w2.chunkId,
        target: 'the-hub', code: 'dirty-start', durationDelta: 2_348_795, launchLag: 4 });
    assert.equal(f.consume().kind, 'recover');
    assert.equal(b.phases.H.skipped, true); assert.equal(b.phases.G.skipped, true);
    assert.equal(b.phases.W1.complete, false); assert.equal(f.running.size, 1);
    assert.match(f.stats.lastReason, /duration delta 2348795/);
});

test('started and unknown events do not release worker RAM; terminal events are idempotent', () => {
    const f = fixture(), b = f.batch(); f.track(b);
    const h = [...b.chunks.values()][0];
    for (const type of ['started', 'unrecognized']) {
        f.port.tryWrite({ type, target: 'the-hub', phase: 'H', batchId: b.id, chunkId: h.chunkId, startedAt: f.clock.now });
        f.consume(); assert.equal(f.running.size, 4);
    }
    const e = { type: 'done', target: 'the-hub', phase: 'H', batchId: b.id, chunkId: h.chunkId, finishedAt: h.landAt, result: 250 };
    f.port.tryWrite(e); f.port.tryWrite(e); f.consume();
    assert.equal(f.running.size, 3); assert.equal(f.api.totalRunningRam(f.running), 6);
    assert.equal(f.stats.money, 250); assert.equal(b.phases.H.count, 1); assert.equal(f.stats.profitable, 1);
});

test('out-of-order delivery and split W2 finalize only after every chunk is terminal', () => {
    const f = fixture(), b = f.batch('1', f.clock.now + 1000, true); f.track(b);
    f.done(b, 'W2'); f.consume(); assert.equal(f.batches.size, 1);
    f.done(b, 'W2'); f.consume(); assert.equal(f.batches.size, 1);
    f.done(b, 'H', 250); f.consume();
    f.done(b, 'G'); f.consume();
    f.done(b, 'W1'); f.consume();
    assert.equal(f.batches.size, 0); assert.equal(f.stats.completed, 1);
    assert.equal(f.stats.profitable, 1); assert.equal(f.running.size, 0);
});

test('a W2 safety fault still finalizes the batch instead of creating an overdue ghost', () => {
    const f = fixture(), b = f.batch(); f.track(b);
    for (const phase of ['H', 'W1', 'G']) { f.done(b, phase, phase === 'H' ? 250 : 0); f.consume(); }
    f.done(b, 'W2', 0, { finishedAt: b.landing.G + 1 });
    assert.equal(f.consume().kind, 'recover');
    assert.equal(f.batches.size, 0); assert.equal(f.stats.recovered, 1);
    assert.equal(f.stats.profitable, 1); assert.equal(f.stats.money, 250);
});

test('the event consumer processes a miss burst without stopping at the first error', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) {
        const b = f.batch(String(i), f.clock.now + 300_000 + i * 500);
        const w = [...b.chunks.values()].find(c => c.phase === 'W2');
        f.port.tryWrite({ type: 'miss', target: 'the-hub', phase: 'W2', batchId: b.id, chunkId: w.chunkId });
    }
    f.consume(); assert.equal(f.port.empty(), true); assert.equal(f.stats.misses.W2, 100);
});

test('drain timing backoff does not mutate the active reservation lattice', () => {
    const f = fixture(); f.stats.pipeline.loopLagMax = 140;
    const b = f.batch();
    const d = f.api.beginDrain(null, { reason: 'bad timing', bumpGap: true }, [...b.chunks.values()], f.batches, f.stats, f.cfg);
    assert.equal(f.cfg.gap, 100); assert.ok(d.drain.nextGap >= 305);
    assert.equal(d.queue.some(c => c.phase === 'H'), false);
});

test('hard drain cancels damaging workers in bounded slices and leaves active W alone', () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) { const b = f.batch(String(i), f.clock.now + i * 500); f.track(b); }
    const { drain } = f.api.beginDrain(null, { reason: 'catastrophic', hard: true }, [], f.batches, f.stats, f.cfg);
    f.api.serviceHardDrain(f.ns, drain, f.batches, f.running, f.byChunk, f.stats);
    assert.ok(f.killed.length <= 32);
    for (let i = 0; i < 10; i++) f.api.serviceHardDrain(f.ns, drain, f.batches, f.running, f.byChunk, f.stats);
    assert.equal(drain.cancelDone, true);
    assert.equal([...f.running.values()].some(c => c.phase === 'H' || c.phase === 'G'), false);
    assert.equal(f.running.size, 60);
});

test('repaired health opens the latch without resetting the pipeline', () => {
    const f = fixture(); f.health.money = f.health.max; f.health.sec = f.health.min;
    let recovery = f.api.beginSoftRecovery(null, { reason: 'one miss' }, f.control, f.runtime, f.stats);
    const start = f.clock.now;
    for (let time = start; time <= start + 500; time += 25) {
        f.clock.now = time;
        recovery = f.api.updateSoftRecovery(f.ns, 'the-hub', recovery, f.control, f.runtime, f.stats).recovery;
    }
    assert.equal(recovery, null); assert.equal(f.control.peek().paused, false);
    assert.equal(f.stats.softRecoverySuccesses, 1); assert.equal(f.stats.restarts, 0);
});

async function runWorker(phase, { dirtyUntil = 0, dirtyForever = false, paused = false, late = false, prep = false, duration = 1000 } = {}) {
    const clock = new Clock();
    const start = clock.now, port = new Port(), control = new Port();
    control.write({ type: 'jit-control', paused, hackPauseUntil: start + 2000 });
    const helper = loadScript('lib/jit-worker.js', clock);
    const calls = [];
    const ns = {
        args: ['the-hub', start + (late ? 500 : duration + 600), '1', 20, prep ? 'PREP-W' : phase, 'chunk', 30, 15, duration, start],
        disableLog() {}, getPortHandle: n => n === 20 ? port : control,
        getServerMinSecurityLevel: () => 12,
        getServerSecurityLevel: () => dirtyForever || clock.now < start + dirtyUntil ? 100 : 12,
        getServerMoneyAvailable: () => 1000,
        sleep: ms => clock.sleep(ms),
    };
    const getDuration = () => ns.getServerSecurityLevel() === 100 ? duration + 2_348_795 : duration;
    let ended = false;
    const work = helper.runJitWorker(ns, getDuration, async (_t, opts) => {
        calls.push({ started: clock.now, options: opts });
        await clock.sleep(getDuration() + opts.additionalMsec);
        return 1;
    }).then(() => ended = true);
    await clock.runUntil(start + duration + 3000);
    return { clock, start, ns, port, control, calls, work, ended };
}

test('worker starts while clean with additionalMsec rather than sleeping to the deadline', async () => {
    const f = await runWorker('W1');
    assert.equal(f.calls[0].started, f.start); assert.equal(f.calls[0].options.additionalMsec, 600);
    assert.equal(f.ended, true);
    assert.equal(f.port.items.find(e => e.type === 'done').drift, 0);
});

test('worker waits through a dirty interval and starts only after security is clean', async () => {
    const f = await runWorker('G', { dirtyUntil: 200 });
    assert.equal(f.calls[0].started, f.start + 200);
    assert.equal(f.calls[0].options.additionalMsec, 400);
    assert.equal(f.port.items.find(e => e.type === 'done').drift, 0);
});

test('39 minute duration inflation is classified, without invoking the invalid action', async () => {
    const f = await runWorker('W1', { dirtyForever: true });
    assert.equal(f.calls.length, 0);
    const miss = f.port.items.find(e => e.type === 'miss');
    assert.equal(miss.code, 'dirty-start'); assert.equal(miss.durationDelta, 2_348_795);
    assert.ok(miss.launchLag <= 600); assert.equal(f.ended, true);
});

test('a call-time pause suppresses H even when its landing is 90 seconds away', async () => {
    const f = await runWorker('H', { paused: true, duration: 90_000 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.port.items[0].type, 'skip'); assert.equal(f.ended, true);
});

test('late workers do not execute out-of-order actions', async () => {
    const f = await runWorker('G', { late: true });
    assert.equal(f.calls.length, 0); assert.equal(f.port.items[0].code, 'start-deadline');
});

test('prep weaken is allowed to run against high security', async () => {
    const f = await runWorker('W1', { dirtyForever: true, prep: true });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].started, f.start);
});

test('prep reaper exists and releases only exited prep PIDs', () => {
    const f = fixture(); const b = f.batch(); f.track(b);
    f.ns.isRunning = pid => pid !== 100;
    f.api.reapRunning(f.ns, f.running);
    assert.equal(f.running.size, 3); assert.equal(f.api.totalRunningRam(f.running), 6);
});

test('new worker dependencies are included in both deployment paths', () => {
    for (const file of ['daemon.js', 'fleet-manager.js']) {
        const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
        assert.match(source, /"lib\/jit-worker\.js"/);
    }
});

test('every JavaScript module parses in module mode', () => {
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (file.endsWith('.js')) {
                const result = cp.spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file), encoding: 'utf8' });
                assert.equal(result.status, 0, `${file}: ${result.stderr}`);
            }
        }
    }
    walk(path.join(root, 'src'));
});

test('PID reconciliation rotates beyond the first still-running page', () => {
    const f = fixture();
    for (let i = 0; i < 50; i++) {
        const c = { host: 'cloud-0', chunkId: `c${i}`, ram: 2, phase: 'W1' };
        f.api.trackRunning(f.running, i, c); f.byChunk.set(c.chunkId, i);
    }
    f.ns.isRunning = pid => pid !== 49;
    for (let i = 0; i < 3; i++) f.api.reconcileRunning(f.ns, f.running, f.byChunk, 20);
    assert.equal(f.running.has(49), false); assert.equal(f.running.size, 49);
    assert.equal(f.api.totalRunningRam(f.running), 98);
});

test('reserved and duplicate port configurations fail before workers start', () => {
    const f = fixture();
    f.cfg.fleetPort = 19;
    assert.doesNotThrow(() => f.api.validateDaemonPorts(f.cfg));
    assert.throws(() => f.api.validateDaemonPorts({ ...f.cfg, controlPort: 18 }), /reserved/);
    assert.throws(() => f.api.validateDaemonPorts({ ...f.cfg, controlPort: 20 }), /distinct/);
    assert.throws(() => f.api.validateDaemonPorts({ ...f.cfg, controlPort: NaN }), /integer/);
});

test('near-term target ranking does not prefer a long prep over a ready money target', () => {
    const f = fixture();
    const ns = {
        hasRootAccess: () => true, getHackingLevel: () => 450,
        getServerMaxMoney: t => t === 'slow' ? 100e9 : 1e9,
        getServerMoneyAvailable: t => t === 'slow' ? 1e9 : 1e9,
        getServerRequiredHackingLevel: () => 1,
        getServerSecurityLevel: t => t === 'slow' ? 20 : 1,
        getServerMinSecurityLevel: () => 1,
        getHackTime: t => t === 'slow' ? 1e6 : 1000,
        getWeakenTime: t => t === 'slow' ? 4e6 : 4000,
        getServerUsedRam: () => 0,
        hackAnalyze: () => .01, hackAnalyzeChance: () => 1,
        hackAnalyzeSecurity: t => .002 * t, growthAnalyzeSecurity: t => .004 * t,
        weakenAnalyze: t => .05 * t, growthAnalyze: (_t, mult) => Math.log(mult) * 10,
    };
    const cfg = { ...f.cfg, minSteal: .1, maxSteal: .5, periodScale: 1, ram: { H: 1.7, G: 1.75, W: 1.75 } };
    const ranked = f.api.rankTargets(ns, { servers: ['slow', 'ready'], hosts: [{ name: 'cloud', maxRam: 2 ** 24, cores: 1 }] }, cfg);
    assert.equal(ranked[0].name, 'ready');
    assert.equal(ranked.find(t => t.name === 'slow').score, 0);
});
