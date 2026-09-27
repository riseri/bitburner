const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

test('pipeline income freshness scales with the planned payout period',()=>{
    const clock=new Clock(),api=loadScript('lib/background-prep.js',clock);
    assert.equal(api.recentPipelineIncome({lastHackAt:clock.now-15000},{plan:{period:20000}},clock.now),true);
    assert.equal(api.recentPipelineIncome({lastHackAt:clock.now-50000},{plan:{period:20000}},clock.now),false);
});

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
                if (filename.includes('weaken')) s.sec = Math.max(s.min, s.sec - ns.weakenAnalyze(threads, hosts.find(h => h.name === host).cores));
                else { s.money = Math.min(s.max, (s.money + threads) * Math.exp(threads * .01 * (1 + (hosts.find(h => h.name === host).cores - 1) / 16))); s.sec += threads * .004; }
                processes.delete(pid); ram.set(host, ns.getServerUsedRam(host) - need);
            });
            return pid;
        },
    };
    const cfg = { backgroundPrep: state, gap: 100, lead: 600, maxSteal: .5, switchThreshold: 1.25,
        homeReserve: 8, ram: { H: 2, G: 2, W: 2 } };
    const stats = daemon.createStats(); stats.pipeline.completed = 1000; stats.pipeline.productiveMs = 500000; stats.lastHackAt = clock.now;
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


test('empty second-slot acquisition accepts useful additive lanes below the anchor income', () => {
    const f = fixture();
    f.servers.tiny = { max: 0.5e6, money: 0.45e6, min: 5, sec: 5, required: 60 };
    f.servers.megacorp = { max: 1.5e6, money: 1.35e6, min: 5, sec: 5, required: 60 };

    f.ctx.slotFill = true;
    f.ctx.availableBatchRate = 1;
    assert.equal(f.prep.estimateBackgroundCandidate(f.ns, 'tiny', f.ctx), null,
        'a lane below the marginal improvement floor must still be rejected');

    const candidate = f.prep.estimateBackgroundCandidate(f.ns, 'megacorp', f.ctx);
    assert.ok(candidate, 'a useful second target should fill otherwise idle capacity');
    assert.equal(candidate.slotFill, true);
    assert.ok(candidate.potential < f.ctx.runtime.plan.expected,
        'the additive lane need not outperform the anchor');
    assert.ok(candidate.potential > candidate.minimumExpected);
    assert.equal(candidate.minimumExpected,
        f.ctx.runtime.plan.expected * (f.cfg.switchThreshold - 1));
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
    f.state.enabled = true; f.stats.pipeline.completed = 0; f.stats.pipeline.productiveMs = 0; await f.step(); assert.equal(f.launches.length, 0);
    f.stats.pipeline.completed = 1000; f.stats.pipeline.productiveMs = 500000; f.ctx.healthy = false; await f.step(); assert.equal(f.launches.length, 0);
    f.ctx.healthy = true; await f.step(); assert.equal(f.launches.length, 1);
    f.ctx.healthy = false; await f.step(); assert.equal(f.state.active, null); assert.ok(f.processes.has(99));
});

test('background prep uses earned batch periods across plan changes',async()=>{
    const f=fixture();f.select();
    f.stats.pipeline.completed=20;f.stats.pipeline.productiveMs=119000;
    f.ctx.runtime.plan.period=10000; // the old calculation falsely grants 200s
    await f.step();assert.equal(f.state.status,'WAITING');assert.equal(f.launches.length,0);
    f.stats.pipeline.productiveMs=120000;
    f.ctx.runtime.plan.period=500; // the old calculation incorrectly falls to 10s
    await f.step();assert.equal(f.launches.length,1);
    f.ctx.runtime.plan.period=250;
    await f.step();assert.equal(f.state.status,'WEAKEN');assert.equal(f.kills.length,0);
});

test('active-target changes cancel only background ownership and cannot prep that target', async () => {
    const f = fixture(); f.select(); await f.step(); const pid = f.state.active.jobs[0].pid;
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


function distributedFixture(sizes = [128, 128, 128, 128], options = {}) {
    const f = fixture(options);
    f.hosts.splice(0, f.hosts.length, ...sizes.map((maxRam, i) => ({ name: `worker-${i}`, maxRam, cores: 1 })));
    f.select(); f.servers.rich.sec = f.servers.rich.min; f.servers.rich.money = f.servers.rich.max * .028;
    return f;
}

test('grow deficit uses max/current money and distributes a requirement larger than any host', async () => {
    const f = distributedFixture();
    const calls = [], analyze = f.ns.growthAnalyze;
    f.ns.growthAnalyze = (target, ratio, cores) => { calls.push({ target, ratio, cores }); return analyze(target, ratio, cores); };
    await f.step();
    assert.ok(calls.every(c => Math.abs(c.ratio - 1 / .028) < 1e-9));
    assert.ok(f.state.diagnostics.requiredThreads > 64);
    assert.ok(f.launches.length > 1);
    assert.equal(f.launches.reduce((n, p) => n + p.ram, 0), f.prep.backgroundPrepRam(f.state));
    assert.equal(f.state.diagnostics.allocatedRam, 256, 'half of genuinely spare RAM');
    assert.equal(f.state.diagnostics.reasonForPartialAllocation, 'prep budget');
    for (const host of f.hosts) assert.ok(f.prep.backgroundPrepRam(f.state, host.name) <= host.maxRam);
});

test('a large idle fleet bypasses a tiny first worker and has no implicit 16 TB ceiling', async () => {
    const f = distributedFixture([16, 262144, 262144, 262144, 262144]);
    f.ns.growthAnalyze = (_target, ratio, cores = 1) => Math.log(ratio) / .00001 / (1 + (cores - 1) / 16);
    await f.step();
    assert.ok(f.state.diagnostics.allocatedThreads > 100000);
    assert.ok(f.state.diagnostics.allocatedRam > 16384);
    assert.ok(f.launches.length > 1);
    assert.ok(f.state.active.ram <= f.hosts.reduce((n, h) => n + h.maxRam, 0) / 2);
});

test('full distributed growth is followed by API-sized weaken compensation before READY', async () => {
    const f = distributedFixture([256, 256, 256, 256], { fraction: .9 });
    f.hosts[1].cores = 8;
    const securityCalls = [];
    f.ns.growthAnalyzeSecurity = (threads, target, cores) => {
        securityCalls.push({ threads, target, cores }); return threads * .004;
    };
    await f.step();
    const grows = [...f.launches];
    assert.ok(grows.length > 1);
    assert.ok(grows.reduce((n, p) => n + p.threads, 0) < f.state.diagnostics.requiredThreads, 'extra cores save threads');
    assert.equal(f.state.diagnostics.growSecurity, grows.reduce((n, p) => n + p.threads * .004, 0));
    assert.ok(securityCalls.some(c => c.target === 'rich' && c.cores === 8));
    await f.step();
    const weakens = f.launches.filter(p => p.filename.includes('weaken'));
    const repair = weakens.reduce((n, p) => n + f.ns.weakenAnalyze(p.threads, f.hosts.find(h => h.name === p.host).cores), 0);
    assert.ok(repair >= grows.reduce((n, p) => n + p.threads * .004, 0) - .001);
    for (let i = 0; i < 10 && f.state.status !== 'READY'; i++) await f.step();
    assert.equal(f.state.status, 'READY');
    assert.equal(f.servers.rich.sec, f.servers.rich.min);
});

test('distributed RAM accounting protects future income reservations and foreign services', async () => {
    const f = distributedFixture([128, 128, 128, 128]);
    f.reservations.push({ host: 'worker-0', start: f.clock.now + 20000, end: f.clock.now + 40000, ram: 124 });
    f.daemon.rebuildReservationIndex(f.reservations);
    f.ram.set('worker-1', 120); f.foreign.set('worker-1', 120);
    await f.step();
    assert.ok(f.prep.backgroundPrepRam(f.state, 'worker-0') <= 4);
    assert.ok(f.prep.backgroundPrepRam(f.state, 'worker-1') <= 8);
    for (let i = 0; i < f.hosts.length; i++) {
        const host = f.hosts[i];
        f.daemon.refreshOneForeignUsage(f.ns, f.hosts, f.running, f.foreign, i, f.state);
        assert.equal(f.foreign.get(host.name), host.name === 'worker-1' ? 120 : 0);
        assert.ok(f.daemon.availableRam(f.ns, host, f.cfg, f.running, f.reservations,
            f.clock.now + 20000, f.clock.now + 21000, f.foreign) >= 0);
    }
});

test('a +0.036 security deficit still needs only one weaken thread', async () => {
    const f = distributedFixture(); f.servers.rich.sec += .036;
    await f.step();
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0].threads, 1);
    assert.equal(f.launches[0].filename, 'background-weaken.js');
});

for (const size of [8, 16, 32, 128, 2048]) {
    test(`partial prep progresses on a ${size} GB fleet while leaving service RAM intact`, async () => {
        const f = distributedFixture([size]);
        f.ram.set('worker-0', size - 2); f.foreign.set('worker-0', size - 2);
        await f.step();
        assert.equal(f.launches.length, 1); assert.equal(f.launches[0].threads, 1);
        assert.equal(f.prep.backgroundPrepRam(f.state), 2);
        await f.step();
        assert.ok(f.servers.rich.money > f.servers.rich.max * .028);
        assert.ok(f.ns.getServerUsedRam('worker-0') <= size);
    });
}

test('explicit RAM caps and a disabled fraction override the tiny-fleet floor', async () => {
    for (const options of [{ maxRam: 1 }, { fraction: 0 }]) {
        const f = distributedFixture([8], options); await f.step();
        assert.equal(f.launches.length, 0);
    }
});

for (const money of [0, Number.MIN_VALUE, .001]) {
    test(`zero/very low money (${money}) produces finite useful threads`, async () => {
        const f = distributedFixture([4096]); f.servers.rich.money = money;
        await f.step();
        assert.ok(Number.isFinite(f.state.diagnostics.requiredThreads));
        assert.ok(f.launches[0].threads > 0);
        await f.step(); assert.ok(f.servers.rich.money > money);
    });
}

test('formulas receive current money, target stats, player and worker cores', () => {
    const f = distributedFixture(); const calls = [];
    f.ns.fileExists = () => true;
    f.ns.getServer = () => ({ moneyAvailable: 0, moneyMax: 1e7, minDifficulty: 5, hackDifficulty: 5, serverGrowth: 70 });
    f.ns.getPlayer = () => ({ mults: { hacking_grow: 2 } });
    f.ns.formulas = { hacking: { growThreads: (server, player, money, cores) => {
        calls.push({ server, player, money, cores }); return 100 / cores;
    } } };
    f.ns.growthAnalyze = () => { throw new Error('formulas should be used'); };
    assert.equal(f.prep.prepGrowThreads(f.ns, 'rich', { money: 0, max: 1e7, sec: 5, min: 5 }, 4), 27);
    assert.equal(calls[0].server.moneyAvailable, 0); assert.equal(calls[0].server.serverGrowth, 70);
    assert.equal(calls[0].player.mults.hacking_grow, 2); assert.equal(calls[0].money, 1e7); assert.equal(calls[0].cores, 4);
});

test('at or above the prep threshold no unnecessary grow work launches', async () => {
    for (const fraction of [.9999, 1]) {
        const f = distributedFixture(); f.servers.rich.money = f.servers.rich.max * fraction;
        await f.step(); assert.equal(f.launches.length, 0); assert.equal(f.state.status, 'READY');
    }
});

test('wave cancellation retains only failed-kill holds and never cancels income PIDs', async () => {
    const f = distributedFixture(); await f.step();
    const stuck = f.launches[0], kill = f.ns.kill;
    f.ns.kill = pid => pid === stuck.pid ? false : kill(pid);
    assert.equal(f.prep.cancelBackgroundPrep(f.ns, f.state), false);
    assert.equal(f.prep.backgroundPrepRam(f.state), stuck.ram);
    assert.equal(f.state.active.jobs.length, 1);
    assert.ok(f.processes.has(99));
    f.ns.kill = kill;
    assert.equal(f.prep.cancelBackgroundPrep(f.ns, f.state), true);
    assert.equal(f.prep.backgroundPrepRam(f.state), 0);
});

test('pending distributed chunks resume at the next safe tick, before the grow finishes', async () => {
    const f = distributedFixture();
    f.ns.getGrowTime = () => 300000;
    let slots = 1;
    f.ctx.canLaunch = () => slots > 0;
    f.ctx.recordLaunch = () => slots--;
    await f.step(); assert.equal(f.launches.length, 1);
    assert.ok(f.state.active.pending.length > 0);
    slots = 2; await f.step();
    assert.equal(f.launches.length, 2);
    assert.ok(f.processes.has(f.launches[0].pid));
    assert.equal(f.state.active.pending.length, 0);
    assert.equal(f.state.active.finishAt, f.clock.now + 300000);
});

test('completed chunks release only their own holds and abort stale pending growth', async () => {
    const f = distributedFixture();
    f.ctx.canLaunch = () => f.launches.length < 1;
    await f.step();
    assert.ok(f.state.active.pending.length > 0);
    await f.step();
    assert.equal(f.prep.backgroundPrepRam(f.state), 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.state.status, 'WAITING_SCHEDULER');
});

test('an exec failure holds only successful chunks; same-host income can reclaim the entire wave', async () => {
    const f = distributedFixture(); const exec = f.ns.exec; let first = true;
    f.ns.exec = (...args) => { if (first) { first = false; return 0; } return exec(...args); };
    await f.step();
    assert.equal(f.state.failures, 1); assert.ok(f.launches.length > 0);
    assert.equal(f.prep.backgroundPrepRam(f.state), f.launches.reduce((n, p) => n + p.ram, 0));
    const host = f.launches.at(-1).host;
    assert.equal(f.daemon.reclaimPrepRam(f.ns, f.cfg, host), true);
    assert.equal(f.prep.backgroundPrepRam(f.state), 0); assert.ok(f.processes.has(99));
});

test('dashboard summary and detailed diagnostics aggregate all live workers', async () => {
    const f = distributedFixture(); await f.step();
    const threads = f.launches.reduce((n, p) => n + p.threads, 0);
    assert.equal(f.state.reason, `${threads} grow threads across ${f.launches.length} hosts`);
    assert.match(f.prep.backgroundPrepSummary(f.state), new RegExp(`${threads} grow threads across`));
    assert.equal(f.state.active.ram, f.launches.reduce((n, p) => n + p.ram, 0));
    const lines = []; f.daemon.renderPrepDiagnostics({ print: line => lines.push(line) }, f.state);
    assert.ok(lines.some(line => line.includes('allocatedRam')));
    for (const host of f.launches.map(p => p.host)) assert.ok(lines.some(line => line.includes(host)));
});


test('capacity scanning yields before due income work and resumes without shrinking the wave', async () => {
    const f = distributedFixture(); let queries = 0, permitted = 1;
    const spare = f.ctx.spareRam;
    f.ctx.spareRam = host => { queries++; return spare(host); };
    f.ctx.canPlan = () => queries < permitted;
    await f.step();
    assert.equal(queries, 1); assert.equal(f.launches.length, 0);
    assert.equal(f.state.status, 'WAITING_SCHEDULER');
    permitted = 100; await f.step();
    assert.ok(f.launches.length > 1); assert.equal(f.state.diagnostics.allocatedRam, 256);
});

test('partial cancellation lets the income allocator retry using confirmed released RAM', async () => {
    const f = distributedFixture(); await f.step();
    const stuck = f.launches[0], kill = f.ns.kill;
    f.ns.kill = pid => pid === stuck.pid ? false : kill(pid);
    assert.equal(f.daemon.reclaimPrepRam(f.ns, f.cfg), true);
    assert.equal(f.prep.backgroundPrepRam(f.state), stuck.ram);
    assert.ok(f.processes.has(stuck.pid)); assert.ok(f.processes.has(99));
});

test('prep uses shared worker and rolling launch limits even at minimum configured limits', () => {
    const f = fixture(), api = loadScript('lib/target-pipelines.js', f.clock);
    const lane = { queue: [] };
    const pool = { cfg: { maxWorkers: 16, maxLaunches: 4, prepStates: [] },
        pipelines: new Map([['active', lane]]), running: new Map(), launchBuckets: new Map(), port: { empty: () => true } };
    const hooks = api.prepLaunchHooks(pool);
    assert.equal(hooks.canLaunch(), true);
    hooks.recordLaunch({ launchAt: f.clock.now });
    assert.equal(hooks.canLaunch(), false, 'one launch fills a 250ms bucket at four/sec');
    pool.launchBuckets.clear();
    pool.cfg.prepStates = [{ active: { jobs: Array.from({ length: 12 }, (_, pid) => ({ pid })) } }];
    assert.equal(hooks.canLaunch(), false, 'prep must leave worker slots for income');
    pool.cfg.prepStates = [];
    lane.queue.push({ launchAt: f.clock.now + 40 });
    assert.equal(hooks.canLaunch(), false); assert.equal(hooks.canPlan(), false);
});

test('optional XP yields its host to prep even when several prep threads already fit', () => {
    const f = fixture(), api = loadScript('lib/target-pipelines.js', f.clock);
    const jobs = new Map([[10, { host: 'cloud-a' }]]), released = [];
    const pool = { api: { availableRam: () => jobs.size ? 10 : 100 },
        xp: { jobs, samples: [], preemptRetryMs: 0, release: pid => { released.push(pid); jobs.delete(pid); } } };
    const ram = api.moneySpareRam({ isRunning: () => true, kill: () => true }, pool, f.hosts[0], f.cfg);
    assert.equal(ram, 100); assert.deepEqual(released, [10]);
});


test('income can reclaim distributed prep worker slots without waiting for RAM exhaustion', async () => {
    const f = distributedFixture(); await f.step();
    const api = loadScript('lib/target-pipelines.js', f.clock);
    const chunks = Array.from({ length: 4 }, (_, i) => ({ launchAt: f.clock.now + i * 250 }));
    const pool = { cfg: { ...f.cfg, maxWorkers: 16, maxLaunches: 32, prepStates: [f.state] },
        api: { reserveIncomeBatch: () => ({ chunks }), rollbackReservations() {} },
        pipelines: new Map(), running: new Map(Array.from({ length: 12 }, (_, i) => [i, {}])),
        reservations: [], launchBuckets: new Map(), network: { hosts: f.hosts }, anchor: 'phantasy' };
    const result = api.reserveBudgetedBatch(f.ns, pool, { name: 'phantasy' }, 'batch', f.clock.now + 2000,
        {}, f.cfg, [], true);
    assert.ok(result.chunks); assert.equal(f.state.active, null);
    assert.ok(f.processes.has(99));
});
