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

// Presentation regressions live alongside the daemon tests so the existing CI
// exercises the new log schema as well as its supervisor compatibility reader.
function dashboardFixture() {
    const clock = new Clock();
    const api = loadScript('daemon.js', clock, {
        // Rendering needs only the RAM readout, never the prep state machine.
        backgroundPrepFiles: () => ['background-grow.js', 'background-weaken.js'],
        backgroundPrepRam: (s, host) => s?.active && (!host || host === s.active.host) ? s.active.ram : 0,
    });
    const logs = [];
    const ns = {
        clearLog: () => { logs.length = 0; }, print: line => logs.push(String(line)),
        getServerMoneyAvailable: () => 317_880_000, getServerMaxMoney: () => 600_000_000,
        getServerSecurityLevel: () => 7.278, getServerMinSecurityLevel: () => 7,
        getHackingLevel: () => 472, getServerUsedRam: () => 0,
    };
    const stats = api.createStats();
    Object.assign(stats, { started: clock.now - 190_000, money: 65_450_000_000,
        lastHackAt: clock.now - 100, completed: 252, scheduled: 434, profitable: 232,
        income: [{ time: clock.now - 1000, money: 587_740_000 * 60 }],
        batchTimes: Array.from({ length: 136 }, (_, i) => clock.now - i * 441) });
    Object.assign(stats.pipeline, { completed: 252, driftCount: 100, driftSum: 384,
        driftMax: 23.05, minSpacing: 86, loopLagMax: 18 });
    const cfg = { requestedTarget: 'auto', gap: 100, lead: 600, homeReserve: 8,
        cloud: { cashReserve: 0.1 }, backgroundPrep: { enabled: true, status: 'WEAKEN',
            target: 'the-hub', reason: 'Repairing target security',
            health: { money: 4_960_000_000, max: 4_960_000_000, sec: 100, min: 12 },
            candidate: { potential: 3_120_000_000, upperBound: true, prepMs: 2_700_000 },
            horizon: 7_200_000, active: { host: 'cloud-1', ram: 3080, finishAt: clock.now + 2_650_000 },
            failures: 0, preemptions: 0 } };
    const network = { rooted: 53, servers: Array(95).fill('server'),
        hosts: [{ name: 'home', cores: 8, maxRam: 32_768 }, { name: 'cloud-1', cores: 1, maxRam: 26_214_400 }] };
    const runtime = { capacity: 26_247_168, averageCoreBonus: 1.000017, plan: {
        expected: 580_340_000, batchRate: 1000 / 441, period: 441, steal: 0.4973, chance: 0.903,
        H: 147, estimatedG: 587, estimatedW1: 6, estimatedW2: 47, gEffective: 587,
        times: { H: 19_500, G: 62_400, W: 78_000 } } };
    const running = new Map(), batches = new Map();
    api.trackRunning(running, 10, { host: 'cloud-1', ram: 204.83 * 1024 });
    const queue = Array(182).fill({}), reservations = Array(740).fill({});
    const targets = [
        ['phantasy', 504_030_000, 580_340_000, 0],
        ['max-hardware', 157_100_000, 252_300_000, 174_000],
        ['harakiri-sushi', 97_100_000, 109_990_000, 34_800],
        ['zer0', 91_110_000, 194_960_000, 252_000],
        ['iron-gym', 90_410_000, 478_080_000, 384_000],
    ].map(([name, score, steady, prepMs]) => ({ name, score, steady, prepMs }));
    const cloud = { count: 25, limit: 25, totalRam: 26_214_400, minRam: 1_048_576, maxRam: 1_048_576,
        ramLimit: 1_048_576, nextAction: 'fleet maxed', spent: 0, purchases: 0, upgrades: 0 };
    const supervisor = loadScript('supervisor.js', clock);
    function render(options = {}) {
        api.renderDashboard(ns, 'phantasy', runtime, network, { ...cfg, ...options.cfg }, stats,
            queue, running, reservations, batches, targets, cloud, options.drain || null,
            options.recovery || null, new Map());
        return logs.join('\n');
    }
    function read() {
        return supervisor.readDaemonDashboard({ ps: () => [{ filename: 'daemon.js', pid: 1 }],
            getScriptLogs: () => [...logs] });
    }
    return { clock, api, ns, logs, stats, cfg, network, runtime, running, targets, cloud, batches, supervisor, render, read };
}

test('daemon default dashboard is summary-first and hides the ranking spreadsheet', () => {
    const f = dashboardFixture(), text = f.render();
    assert.match(text, /CURRENT RUN/);
    assert.match(text, /Income 60s\s+\$587\.74m\/s/);
    assert.match(text, /Money\s+53\.0% \| \$317\.88m \/ \$600\.00m/);
    assert.match(text, /Pipeline\s+1 running \| 182 queued \| 2\.267 batches\/s/);
    assert.match(text, /NEXT TARGET/);
    assert.match(text, /Background\s+the-hub \| WEAKEN \| ETA 44m 10s/);
    assert.doesNotMatch(text, /AUTO TARGET RANKING|Run total|Batch rate|Pipe drift|Core bonus/);
    assert.ok(f.logs.length <= 22, `normal view grew to ${f.logs.length} lines`);
    assert.ok(f.logs.every(line => line.length <= 78));
    assert.doesNotMatch(text, /\bNaN\b|\bInfinity\b|\bundefined\b/);
});

test('daemon details restores session telemetry and the full auto-target ranking', () => {
    const f = dashboardFixture();
    f.stats.misses.G = 999; f.stats.driftMax = 60.82; f.stats.restarts = 2;
    const compact = f.render();
    assert.doesNotMatch(compact, /G:999|Pipe drift|AUTO TARGET RANKING/);
    const detailed = f.render({ cfg: { dashboardDetails: true } });
    assert.match(detailed, /SESSION DIAGNOSTICS/);
    assert.match(detailed, /G:999/);
    assert.match(detailed, /max 60\.82ms/);
    assert.match(detailed, /2\.267\/s actual \| 2\.268\/s model/);
    assert.match(detailed, /232 paid batches/);
    assert.match(detailed, /gap 100ms \| period 441ms \| lead 600ms/);
    assert.match(detailed, /required 20ms/);
    assert.match(detailed, /AUTO TARGET RANKING \/ DETAILS/);
    assert.match(detailed, /home 8 \(1\.438x\) \| fleet 1\.000x RAM-weighted/);
    const status = f.read();
    assert.equal(status.targets.length, 5);
    assert.equal(status.targets[0].name, 'phantasy');
    assert.equal(status.targets[0].selected, true);
    assert.equal(status.targets[0].effective, '$504.03m/s');
    assert.equal(status.targets[1].prep, '2m 54s');
    assert.ok(f.logs.every(line => line.length <= 78));
});

test('dashboard recovery overrides historical LIVE and preserves a wrapped fault reason', () => {
    const f = dashboardFixture();
    const reason = 'G invocation rejected: the target security is above the planned minimum; waiting for remaining weaken work before retrying';
    const text = f.render({ recovery: { deadline: f.clock.now + 4000, reason } });
    assert.match(text, /State\s+RECOVERING/);
    assert.match(text, /Hack status\s+PAUSED/);
    assert.doesNotMatch(text, /Hack status\s+LIVE/);
    assert.equal(f.read().reason, reason);
    assert.ok(f.logs.every(line => line.length <= 78));
    f.render({ drain: { reason } });
    assert.match(f.read().hackStatus, /^DRAINING/);
});

test('dashboard warmup stays human-readable and moves timing jargon to details', () => {
    const f = dashboardFixture();
    f.stats.lastHackAt = NaN; f.stats.pipeline.minSpacing = Infinity;
    f.stats.pipeline.driftCount = 0; f.stats.pipeline.driftSum = 0; f.stats.pipeline.driftMax = 0;
    f.batches.set('1', { phases: { H: { complete: false, skipped: false } }, landing: { H: f.clock.now + 78_000 } });
    const compact = f.render();
    assert.match(compact, /Hack status\s+ETA 1m 18s/);
    assert.doesNotMatch(compact, /Pipe drift|spacing n\/a|\bLIVE\b|\bInfinity\b|\bNaN\b/);
    const detailed = f.render({ cfg: { dashboardDetails: true } });
    assert.match(detailed, /spacing n\/a/);
});

test('background prep becomes the actionable next-target view instead of a ranking table', () => {
    const f = dashboardFixture(), text = f.render(), status = f.read();
    assert.equal(status.target, 'phantasy');
    assert.equal(status.state, 'RUNNING');
    assert.equal(status.background, 'the-hub | WEAKEN | ETA 44m 10s');
    assert.match(status.prepHealth, /security \+88\.000/);
    assert.match(status.security, /^\+0\.278 \| 7\.278 \/ 7\.000/);
    assert.match(status.ramOnline, /^207\.84 TB \/ 25\.03 PB/);
    assert.match(text, /Potential\s+\$3\.12b\/s upper bound/);
    assert.doesNotMatch(text, /AUTO TARGET RANKING/);

    f.cfg.backgroundPrep = { enabled: false, status: 'DISABLED', reason: 'disabled' };
    const noPrep = f.render();
    assert.match(noPrep, /NEXT TARGET/);
    assert.match(noPrep, /Candidate\s+max-hardware \| \$157\.10m\/s next 10m/);
    assert.doesNotMatch(noPrep, /Background\s+none \| DISABLED/);
});

test('supervisor target parsing remains available when detailed ranking is requested', () => {
    const f = dashboardFixture();
    f.render({ cfg: { dashboardDetails: true } });
    const compact = f.read();
    assert.equal(compact.targets.length, 5);
    assert.equal(compact.targets[0].steady, '$580.34m/s');
    const legacy = f.supervisor.parseTargets(['> phantasy $504.03m/s steady:  $580.34m/s S:49.7% P:441ms prep:0ms']);
    assert.equal(legacy[0].name, 'phantasy'); assert.equal(legacy[0].steady, '$580.34m/s');
    assert.equal(legacy[0].prep, '0ms');
});

test('prep dashboard focuses on preparation and keeps ranking in details only', () => {
    const f = dashboardFixture();
    f.api.renderPrep(f.ns, 'the-hub', f.network, f.cfg, 1, 'WEAKEN',
        [{phase:'PREP-W', threads:14}], f.clock.now + 264_000, 0, 0, 0, 1, f.targets);
    let text = f.logs.join('\n');
    let status = f.read();
    assert.equal(status.mode, 'prep'); assert.equal(status.target, 'the-hub');
    assert.equal(status.stage, 'WEAKEN'); assert.match(status.wave, /4m 24s/);
    assert.match(text, /PREPARING TARGET/);
    assert.doesNotMatch(text, /AUTO TARGET RANKING/);
    assert.ok(f.logs.length <= 14);

    f.api.renderPrep(f.ns, 'the-hub', f.network, {...f.cfg, dashboardDetails:true}, 1, 'WEAKEN',
        [{phase:'PREP-W', threads:14}], f.clock.now + 264_000, 0, 0, 0, 1, f.targets);
    text = f.logs.join('\n');
    assert.match(text, /AUTO TARGET RANKING \/ DETAILS/);
    assert.ok(f.logs.every(line => line.length <= 78));
});

test('dashboard helper wraps errors and keeps the detailed ranking bounded', () => {
    const f = dashboardFixture(), ui = loadScript('lib/dashboard.js', f.clock);
    f.logs.length = 0; ui.dashboardRow(f.ns, 'Reason', 'X'.repeat(250));
    assert.ok(f.logs.every(line => line.length <= 78));
    assert.equal(f.logs.join('').replace(/Reason| /g, ''), 'X'.repeat(250));
    f.logs.length = 0;
    ui.dashboardTargets(f.ns, [{name:'a'.repeat(100), effective:'$504.03m/s', steady:'$580.34m/s', prep:'ready'}]);
    assert.match(f.logs[0], /AUTO TARGET RANKING \/ DETAILS/);
    assert.ok(f.logs.every(line => line.length <= 78));
    assert.equal(ui.dashboardTime(Infinity), 'n/a');
    assert.equal(ui.dashboardTime(NaN), 'n/a');
    assert.equal(ui.dashboardTime(3_900_000), '1h 05m');
});

test('dashboard rendering is read-only and supervisor overview consumes the compact schema', () => {
    const f = dashboardFixture();
    const before = JSON.stringify({stats:f.stats, cfg:f.cfg, runtime:f.runtime, network:f.network});
    f.render();
    assert.equal(JSON.stringify({stats:f.stats, cfg:f.cfg, runtime:f.runtime, network:f.network}), before);
    const daemonLogs = [...f.logs];
    f.supervisor.render({...f.ns, ps:()=>[{filename:'daemon.js',pid:1}], getScriptLogs:()=>daemonLogs}, {
        cfg:{contracts:false, progression:false, stocks:false, go:false, dashboardDetails:false},
        fleetStatus:{type:'fleet-status', network:f.network, cloud:f.cloud},
        services:[], actions:null, stockAccess:{ok:false,missing:[]},
        fleetHealth:{healthy:true}, contractHealth:{healthy:true}, progressionHealth:{healthy:true},
    });
    assert.match(f.logs.join('\n'), /Income 60s\s+\$587\.74m\/s/);
    assert.match(f.logs.join('\n'), /the-hub \| WEAKEN/);
    assert.ok(f.logs.every(line=>line.length<=78));
});

test('dashboard phase counter parsing ignores the digits in W1 and W2 labels', () => {
    const f = dashboardFixture();
    assert.equal(f.supervisor.hasNonZeroCounters('H:0 W1:0 G:0 W2:0'), false);
    assert.equal(f.supervisor.hasNonZeroCounters('H:0 W1:2 G:0 W2:0'), true);
});
