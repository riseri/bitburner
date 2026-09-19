const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture(options = {}) {
    const clock = new Clock();
    const prep = loadScript('lib/background-prep.js', clock);
    const daemon = loadScript('daemon.js', clock);
    const state = prep.createBackgroundPrep(options);
    const servers = {
        phantasy: { max: 1e6, money: 1e6, min: 5, sec: 5, required: 30 },
        rich: { max: 10e6, money: 1e6, min: 5, sec: 20, required: 80 },
    };
    const hosts = [{ name: 'cloud-a', maxRam: 65536, cores: 1 }, { name: 'home', maxRam: 128, cores: 4 }];
    const processes = new Map([[99, { pid: 99, host: 'home', ram: 16, filename: 'jit-hack.js', args: ['phantasy'] }]]);
    const launches = [], kills = []; let nextPid = 100;
    const ram = new Map([['home', 16]]);
    const ns = {
        pid: 1, getHackingLevel: () => 200, hasRootAccess: () => true,
        getServerMaxMoney: h => servers[h]?.max || 0,
        getServerMoneyAvailable: h => servers[h]?.money || 0,
        getServerSecurityLevel: h => servers[h].sec,
        getServerMinSecurityLevel: h => servers[h].min,
        getServerRequiredHackingLevel: h => servers[h]?.required || 1,
        getScriptRam: () => 2, getServerUsedRam: h => ram.get(h) || 0,
        getServerMaxRam: h => hosts.find(x => x.name === h)?.maxRam || 0,
        getWeakenTime: h => 100 * servers[h].sec, getGrowTime: h => 80 * servers[h].sec,
        hackAnalyzeChance: h => .7 * (100 - servers[h].sec) / (100 - servers[h].min),
        weakenAnalyze: (n, cores = 1) => .05 * n * (1 + (cores - 1) / 16),
        growthAnalyze: (_h, mult, cores = 1) => Math.log(mult) / .01 / (1 + (cores - 1) / 16),
        growthAnalyzeSecurity: n => n * .004, hackAnalyzeSecurity: n => n * .002,
        ps: h => [...processes.values()].filter(p => p.host === h),
        isRunning: pid => pid === 1 || processes.has(pid),
        kill: pid => {
            kills.push(pid); const p = processes.get(pid);
            if (!p) return false;
            ram.set(p.host, (ram.get(p.host) || 0) - p.ram); return processes.delete(pid);
        },
        exec: (filename, host, threads, ...args) => {
            const need = threads * 2;
            if (need > ns.getServerMaxRam(host) - ns.getServerUsedRam(host)) return 0;
            const pid = nextPid++;
            const p = { pid, filename, host, ram: need, threads, args };
            processes.set(pid, p); ram.set(host, ns.getServerUsedRam(host) + need); launches.push(p);
            const duration = filename.includes('weaken') ? ns.getWeakenTime(args[0]) : ns.getGrowTime(args[0]);
            clock.timer(duration, () => {
                if (!processes.has(pid)) return;
                const s = servers[args[0]];
                if (filename.includes('weaken')) s.sec = Math.max(s.min, s.sec - ns.weakenAnalyze(threads));
                else { s.money = Math.min(s.max, (s.money + threads) * Math.exp(threads * .01)); s.sec += threads * .004; }
                processes.delete(pid); ram.set(host, ns.getServerUsedRam(host) - need);
            });
            return pid;
        },
    };
    const cfg = { backgroundPrep: state, gap: 100, lead: 600, maxSteal: .5, switchThreshold: 1.25,
        homeReserve: 8, ram: { H: 2, G: 2, W: 2 } };
    const stats = daemon.createStats(); stats.pipeline.completed = 1000; stats.lastHackAt = clock.now;
    const running = new Map(), reservations = [], foreign = new Map([['home', 16], ['cloud-a', 0]]);
    const ctx = { state, target: 'phantasy', network: { hosts, servers: Object.keys(servers) }, cfg, stats,
        runtime: { plan: { period: 500, expected: 1e6, times: { W: 500, G: 400, H: 125 } } }, healthy: true,
        spareRam: host => daemon.availableRam(ns, host, cfg, running, reservations, clock.now, Infinity, foreign),
    };
    async function step(ms = 500) {
        await clock.runUntil(clock.now + ms); stats.lastHackAt = clock.now;
        prep.tickBackgroundPrep(ns, ctx);
    }
    function select() { state.target = 'rich'; state.candidate = { name: 'rich' }; }
    return { clock, prep, daemon, state, servers, hosts, processes, launches, kills, ram, ns, cfg, stats, running, reservations, foreign, ctx, step, select };
}

test('candidate scoring is incremental, long-horizon, and excludes the active target', async () => {
    const f = fixture();
    assert.equal(f.prep.estimateBackgroundCandidate(f.ns, 'phantasy', f.ctx), null);
    const richer = f.prep.estimateBackgroundCandidate(f.ns, 'rich', f.ctx);
    assert.ok(richer.score > 0); assert.equal(richer.upperBound, false);
    await f.step(); assert.equal(f.state.scan.index, 1); assert.equal(f.launches.length, 0);
    await f.step(); assert.equal(f.state.scan.index, 2); assert.equal(f.launches.length, 0);
    await f.step(); assert.equal(f.state.target, 'rich'); assert.equal(f.launches.length, 1);
});

test('security 100 is an explicitly labeled finite upper-bound candidate', () => {
    const f = fixture(); f.servers.rich.sec = 100;
    const candidate = f.prep.estimateBackgroundCandidate(f.ns, 'rich', f.ctx);
    assert.equal(candidate.upperBound, true); assert.ok(Number.isFinite(candidate.score));
    assert.ok(candidate.prepMs > 0);
});


test('empty second-slot acquisition accepts additive income below the replacement threshold', () => {
    const f = fixture();
    f.servers.modest = { max: 1.5e6, money: 1.35e6, min: 5, sec: 5, required: 60 };
    const replacement = f.prep.estimateBackgroundCandidate(f.ns, 'modest', f.ctx);
    assert.equal(replacement, null, 'ordinary replacement scoring still requires switch-threshold upside');

    f.ctx.slotFill = true;
    f.ctx.availableBatchRate = 1;
    const additive = f.prep.estimateBackgroundCandidate(f.ns, 'modest', f.ctx);
    assert.ok(additive, 'a useful additive second earner should be eligible');
    assert.equal(additive.slotFill, true);
    assert.ok(additive.potential > f.ctx.runtime.plan.expected * 0.05);
    assert.ok(additive.potential < f.ctx.runtime.plan.expected * f.cfg.switchThreshold);
});

test('empty second-slot scoring prefers near-term earnings over a slow two-hour whale', () => {
    const f = fixture();
    f.servers.fast = { max: 4e6, money: 3.6e6, min: 5, sec: 5, required: 60 };
    f.servers.whale = { max: 30e6, money: 1e6, min: 5, sec: 20, required: 80 };
    const oldW = f.ns.getWeakenTime, oldG = f.ns.getGrowTime;
    f.ns.getWeakenTime = h => h === 'whale' ? 900_000 : oldW(h);
    f.ns.getGrowTime = h => h === 'whale' ? 720_000 : oldG(h);

    const replacementFast = f.prep.estimateBackgroundCandidate(f.ns, 'fast', f.ctx);
    const replacementWhale = f.prep.estimateBackgroundCandidate(f.ns, 'whale', f.ctx);
    assert.ok(replacementWhale.score > replacementFast.score,
        'long-horizon replacement scoring should still prefer the whale');

    f.ctx.slotFill = true;
    f.ctx.availableBatchRate = 1;
    const fillFast = f.prep.estimateBackgroundCandidate(f.ns, 'fast', f.ctx);
    const fillWhale = f.prep.estimateBackgroundCandidate(f.ns, 'whale', f.ctx);
    assert.ok(fillFast.score > fillWhale.score,
        'empty-slot acquisition should prefer the target that starts paying inside the short horizon');
});


test('steady promotion ignores prep amortization and ranks by prepped earning power', () => {
    const f = fixture();
    f.servers.fast = { max: 4e6, money: 4e6, min: 5, sec: 5, required: 60 };
    f.servers.whale = { max: 30e6, money: 1e6, min: 5, sec: 20, required: 80 };
    const oldW = f.ns.getWeakenTime, oldG = f.ns.getGrowTime;
    f.ns.getWeakenTime = h => h === 'whale' ? 900_000 : oldW(h);
    f.ns.getGrowTime = h => h === 'whale' ? 720_000 : oldG(h);

    f.ctx.promotion = true;
    f.ctx.replacementRate = 1e6;
    f.ctx.replacementBatchRate = 2;
    const fast = f.prep.estimateBackgroundCandidate(f.ns, 'fast', f.ctx);
    const whale = f.prep.estimateBackgroundCandidate(f.ns, 'whale', f.ctx);
    assert.ok(fast && whale);
    assert.equal(fast.promotion, true); assert.equal(whale.promotion, true);
    assert.ok(whale.prepMs > fast.prepMs);
    assert.ok(whale.potential > fast.potential);
    assert.ok(whale.score > fast.score,
        'promotion should prefer higher prepped steady income even when prep takes much longer');
});

test('steady promotion still requires switch-threshold upside over the weaker lane', () => {
    const f = fixture();
    f.servers.small = { max: 1.5e6, money: 1.5e6, min: 5, sec: 5, required: 60 };
    f.ctx.promotion = true;
    f.ctx.replacementRate = 1.5e6;
    f.ctx.replacementBatchRate = 2;
    assert.equal(f.prep.estimateBackgroundCandidate(f.ns, 'small', f.ctx), null);
});

test('one background worker reaches READY without hacking or touching active PIDs', async () => {
    const f = fixture(); f.select();
    for (let i = 0; i < 40 && f.state.status !== 'READY'; i++) {
        await f.step();
        assert.ok([...f.processes.values()].filter(p => p.filename.startsWith('background')).length <= 1);
    }
    assert.equal(f.state.status, 'READY'); assert.equal(f.state.target, 'rich');
    assert.ok(f.servers.rich.sec <= 5.001); assert.ok(f.servers.rich.money >= f.servers.rich.max * .9999);
    assert.equal(f.prep.backgroundPrepRam(f.state), 0);
    assert.ok(f.launches.some(p => p.filename === 'background-grow.js'));
    assert.ok(f.launches.every(p => p.args[0] === 'rich' && p.args[1] === 1 && p.args[2].startsWith('bgprep-')));
    assert.ok(f.processes.has(99)); assert.deepEqual(f.kills, []);
    const count = f.launches.length;
    await f.step(30_000); assert.equal(f.launches.length, count, 'READY does not launch another pipeline');
});

test('prep obeys fraction, absolute limit, existing future reservations and live RAM', async () => {
    const f = fixture({ maxRam: 100, fraction: .0005 }); f.select();
    // The host is currently empty, but a future active batch owns almost all RAM.
    f.reservations.push({ host: 'cloud-a', start: f.clock.now + 20_000, end: f.clock.now + 40_000, ram: 65530 });
    f.daemon.rebuildReservationIndex(f.reservations);
    await f.step();
    assert.ok(f.state.active.ram <= 6, 'future reservation survives prep admission');
    assert.ok(f.state.active.ram <= (65536 + 128) * .0005);
    assert.equal(f.daemon.availableRam(f.ns, f.hosts[0], f.cfg, f.running, f.reservations,
        f.clock.now + 20_000, f.clock.now + 21_000, f.foreign), 65536 - 65530 - f.state.active.ram);
});

test('prep RAM is never double-counted as foreign usage', async () => {
    const f = fixture(); f.select(); await f.step(); const held = f.state.active.ram;
    f.daemon.refreshOneForeignUsage(f.ns, f.hosts, f.running, f.foreign, 0, f.state);
    assert.equal(f.foreign.get('cloud-a'), 0);
    assert.equal(f.daemon.baseHostCapacity(f.ns, f.hosts[0], f.cfg, f.running, f.foreign), 65536 - held);
    assert.equal(f.daemon.baseHostCapacity(f.ns, f.hosts[0], f.cfg, f.running), 65536 - held);
});

test('RAM holds survive estimated finish, and a failed kill cannot free live RAM', async () => {
    const f = fixture(); f.select(); await f.step(); const held = f.state.active.ram;
    f.state.active.finishAt = f.clock.now - 1;
    assert.equal(f.prep.backgroundPrepRam(f.state), held);
    f.ns.kill = () => false;
    assert.equal(f.prep.cancelBackgroundPrep(f.ns, f.state), false);
    assert.equal(f.prep.backgroundPrepRam(f.state), held);
});

test('active reservations reclaim prep RAM and retry the same batch without a skipped slot', () => {
    const f = fixture(); const host = { name: 'cloud-a', maxRam: 32, cores: 1 };
    f.hosts[0] = host;
    f.processes.set(55, { pid: 55, host: 'cloud-a', ram: 24 }); f.ram.set('cloud-a', 24);
    f.state.active = { pid: 55, host: 'cloud-a', ram: 24 };
    const plan = { H: 4, gEffective: 4, hackSecurity: .1, steal: .5, times: { H: 100, G: 320, W: 400 } };
    const result = f.daemon.reserveIncomeBatch(f.ns, 'phantasy', 123, f.clock.now + 2000,
        plan, [host], f.cfg, f.reservations, f.running, f.foreign);
    assert.ok(result, 'preemption must rescue this exact slot');
    assert.ok(result.chunks.every(c => c.batchId === '123'));
    assert.deepEqual(f.kills, [55]); assert.equal(f.state.active, null); assert.ok(f.processes.has(99));
    assert.equal(f.stats.allocationFails, 0);
});

test('active exec can reclaim a same-host prep worker without poisoning its batch', () => {
    const f = fixture();
    f.processes.set(55, { pid: 55, host: 'cloud-a', ram: 24 }); f.ram.set('cloud-a', 24);
    f.state.active = { pid: 55, host: 'cloud-a', ram: 24 };
    const chunk = { phase: 'H', chunkId: 'b-H', batchId: 'b', host: 'cloud-a', threads: 1,
        script: 'jit-hack.js', ram: 2, launchAt: f.clock.now - 1, landAt: f.clock.now + 1000, duration: 500 };
    const batch = f.daemon.makeBatchState('b', [chunk]);
    const batches = new Map([['b', batch]]), byChunk = new Map();
    let calls = 0;
    f.ns.exec = () => { calls++; return f.processes.has(55) ? 0 : 200; };
    f.daemon.launchDueChunks(f.ns, [chunk], 'phantasy', f.cfg, batches, f.stats, f.running, byChunk, null);
    assert.equal(calls, 2); assert.equal(f.stats.execFails.H, 0); assert.equal(batch.poisoned, false);
    assert.equal(byChunk.get('b-H'), 200); assert.deepEqual(f.kills, [55]);
});

test('disabled, warmup and active recovery do not start prep', async () => {
    const f = fixture({ enabled: false }); f.select(); await f.step(); assert.equal(f.launches.length, 0);
    f.state.enabled = true; f.stats.pipeline.completed = 0; await f.step(); assert.equal(f.launches.length, 0);
    f.stats.pipeline.completed = 1000; f.ctx.healthy = false; await f.step(); assert.equal(f.launches.length, 0);
    f.ctx.healthy = true; await f.step(); assert.equal(f.launches.length, 1);
    f.ctx.healthy = false; await f.step(); assert.equal(f.state.active, null); assert.ok(f.processes.has(99));
});

test('active-target changes cancel only background ownership and cannot prep that target', async () => {
    const f = fixture(); f.select(); await f.step(); const pid = f.state.active.pid;
    f.ctx.target = 'rich'; await f.step();
    assert.equal(f.state.target, ''); assert.equal(f.state.active, null); assert.deepEqual(f.kills, [pid]);
    assert.ok(f.processes.has(99));
});

test('prep API and launch failures stay isolated from the income controller', async () => {
    const f = fixture(); f.select(); f.ns.exec = () => 0; await f.step();
    assert.equal(f.state.active, null); assert.equal(f.state.failures, 1); assert.ok(f.processes.has(99));
    f.state.retryAt = 0; f.ns.getServerSecurityLevel = () => { throw new Error('target removed'); };
    await f.step(); assert.equal(f.state.status, 'ERROR'); assert.equal(f.state.enabled, false);
    assert.ok(f.processes.has(99));
    await f.step(); assert.equal(f.state.status, 'ERROR'); assert.match(f.state.reason, /target removed/);
});

test('orphan cleanup ignores live owners, other scripts, and untagged prep workers', () => {
    const f = fixture();
    f.processes.set(11, { pid: 11, filename: 'background-grow.js', host: 'cloud-a', ram: 0, args: ['rich', 500, 'bgprep-500-1'] });
    f.processes.set(12, { pid: 12, filename: 'background-grow.js', host: 'cloud-a', ram: 0, args: ['rich', 1, 'bgprep-1-1'] });
    f.processes.set(13, { pid: 13, filename: 'background-grow.js', host: 'cloud-a', ram: 0, args: ['rich'] });
    f.prep.cleanupBackgroundOrphans(f.ns, f.hosts);
    assert.deepEqual(f.kills, [11]); assert.ok(f.processes.has(12)); assert.ok(f.processes.has(13)); assert.ok(f.processes.has(99));
});

test('supervisor forwards the disable flag and displays background prep separately', () => {
    const clock = new Clock(), api = loadScript('supervisor.js', clock); const launches = [];
    api.ensureRunning({ ps: () => [], run: (...args) => { launches.push(args); return 123; } }, 'daemon.js', ['--background-prep', false]);
    assert.deepEqual(launches, [['daemon.js', 1, '--background-prep', false]]);
    const status = api.readDaemonDashboard({ ps: () => [{filename:'daemon.js', pid:1}], getScriptLogs: () => [
        'JIT DAEMON :: phantasy :: hacking 472', 'Background  rich | WEAKEN', 'Prep RAM    600 GB held',
    ] });
    assert.equal(status.target, 'phantasy'); assert.equal(status.background, 'rich | WEAKEN'); assert.equal(status.prepRam, '600 GB held');
});
