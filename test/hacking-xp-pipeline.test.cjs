const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), api = loadScript('daemon.js', clock);
    const xp = loadScript('lib/hacking-xp.js', clock), scheduler = loadScript('lib/target-pipelines.js', clock);
    const processes = new Map(), kills = [], launches = [];
    const host = { name: 'remote', maxRam: 64, cores: 1 };
    const cfg = { requestedTarget: 'money', maxSteal: .5, maxLaunches: 32, maxWorkers: 100, gap: 100, lead: 600,
        homeReserve: 8, port: 20, ram: { H: 2, G: 2, W: 2 }, prepStates: [], hackingPolicy: { mode: 'XP' } };
    let pid = 40;
    const ns = { pid: 1, fileExists: () => true,
        getPlayer: () => ({ skills: { hacking: 731 }, exp: { hacking: 1000 }, mults: { hacking: 2 } }),
        getHackingLevel: () => 731, getScriptRam: () => 2,
        getServerUsedRam: name => [...processes.values()].filter(p => p.host === name).reduce((sum, p) => sum + p.ram, 0),
        getServer: name => ({ hostname: name, hasAdminRights: true, requiredHackingSkill: 1, minDifficulty: 1,
            hackDifficulty: 1, moneyAvailable: 1e6, moneyMax: 1e6, baseDifficulty: 10 }),
        getGrowTime: () => 3200, getWeakenTime: () => 4000, getHackTime: () => 1000,
        hackAnalyzeSecurity: t => .002 * t, growthAnalyzeSecurity: t => .004 * t,
        weakenAnalyze: t => .05 * t, getServerMaxRam: () => host.maxRam,
        isRunning: pid => processes.has(pid), ps: () => [],
        kill(pid) { kills.push(pid); return processes.delete(pid); },
        exec(file, host, threads, ...args) {
            assert.ok(ns.getServerUsedRam(host) + threads * 2 <= 64);
            const process = { pid: ++pid, file, host, threads, ram: threads * 2, args };
            processes.set(pid, process); launches.push(process); return pid;
        },
        formulas: { hacking: { hackExp: () => 6, hackChance: () => .2, hackPercent: () => .01,
            hackTime: () => 1000, growTime: () => 3200, weakenTime: () => 4000,
            growThreads: () => 10, weakenEffect: t => .05 * t } } };
    const pool = { cfg, api, port: new Port(), network: { hosts: [host], servers: ['money', 'alpha'] },
        pipelines: new Map([['money', { mode: 'RUNNING', queue: [] }]]),
        running: new Map(), runningByChunk: new Map(), reservations: [], foreign: new Map([['remote', 0]]), launchBuckets: new Map() };
    pool.xp = xp.createXpPipeline(pool); cfg.xpPipeline = pool.xp;
    const tick = () => { scheduler.serviceXpPipeline(ns, pool); clock.now += 251; };
    const available = () => api.availableRam(ns, host, cfg, pool.running, pool.reservations, clock.now, Infinity, pool.foreign);
    return { clock, api, xp, scheduler, ns, pool, cfg, host, processes, kills, launches, tick, available };
}

test('XP borrows only RAM outside future money reservations and keeps the shared event port intact', () => {
    const f = fixture();
    f.api.reserveChunk(f.pool.reservations, { host: 'remote', ram: 40, launchAt: f.clock.now + 5000,
        landAt: f.clock.now + 10000, status: 'queued', phase: 'G' });
    const event = { type: 'done', phase: 'H', batchId: 'money-batch' }; f.pool.port.tryWrite(event);
    f.tick();
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0].threads, 12);
    assert.equal(f.launches[0].args[0], 'alpha', 'explicit money target cannot be used by XP');
    assert.equal(f.pool.port.peek(), event, 'XP must not clear money completions');
    assert.equal(f.api.totalRunningRam(f.pool.running), 24); assert.equal(f.available(), 0);
    f.api.refreshOneForeignUsage(f.ns, [f.host], f.pool.running, f.pool.foreign, 0);
    assert.equal(f.pool.foreign.get('remote'), 0, 'owned XP is not foreign RAM');
    assert.equal(f.xp.xpPipelineStatus(f.ns, f.pool).operationalMode, 'MONEY+XP');
});

test('money admission reclaims XP RAM and reserves the same batch without touching other processes', () => {
    const f = fixture(); f.tick(); assert.equal(f.available(), 0);
    const xpPid = f.launches[0].pid;
    f.processes.set(99, { host: 'elsewhere', ram: 1 });
    const plan = { H: 4, gEffective: 4, hackSecurity: .1, steal: .5, times: { H: 100, G: 320, W: 400 } };
    const result = f.api.reserveIncomeBatch(f.ns, 'money', 'batch', f.clock.now + 2000,
        plan, [f.host], f.cfg, f.pool.reservations, f.pool.running, f.pool.foreign);
    assert.ok(result); assert.ok(result.chunks.every(c => c.batchId === 'batch'));
    assert.deepEqual(f.kills, [xpPid]); assert.ok(f.processes.has(99));
    assert.equal(f.pool.xp.jobs.size, 0); assert.equal(f.api.totalRunningRam(f.pool.running), 0);
    f.tick(); assert.equal(f.launches.length, 1, 'preempted XP waits instead of immediately refilling RAM');
});

test('failed XP cancellation retains its reservation and prevents a money target takeover', () => {
    const f = fixture(); f.tick(); f.ns.kill = () => false;
    assert.equal(f.xp.reclaimXpRam(f.ns, f.pool.xp), false);
    assert.equal(f.available(), 0); assert.equal(f.pool.running.size, 1);
    assert.equal(f.xp.claimXpTarget(f.ns, f.pool, 'alpha'), false);
    f.processes.clear(); f.tick();
    assert.equal(f.pool.xp.jobs.size, 0); assert.equal(f.available(), 64);
    assert.equal(f.xp.claimXpTarget(f.ns, f.pool, 'alpha'), true);
});

test('XP cannot use active, preparing or pending money targets, nor exceed shared process/launch limits', () => {
    for (const block of ['active', 'preparing', 'pending', 'workers', 'launches', 'RAM']) {
        const f = fixture();
        if (block === 'active') f.pool.pipelines.set('alpha', { mode: 'RUNNING', queue: [] });
        if (block === 'preparing') f.cfg.prepStates.push({ target: 'alpha' });
        if (block === 'pending') f.pool.pendingAdmission = 'alpha';
        if (block === 'workers') f.cfg.maxWorkers = 4;
        if (block === 'launches') f.pool.launchBuckets.set(Math.floor(f.clock.now / 250), 8);
        if (block === 'RAM') f.api.reserveChunk(f.pool.reservations, { host: 'remote', ram: 64,
            launchAt: f.clock.now + 5000, landAt: f.clock.now + 10000, status: 'queued', phase: 'G' });
        f.tick(); assert.equal(f.launches.length, 0, block);
    }
});

test('disabling XP lets its current wave finish while preserving primary money work', () => {
    const f = fixture(); f.tick(); f.cfg.hackingPolicy.mode = 'NORMAL';
    f.tick(); assert.equal(f.pool.xp.status, 'DRAINING'); assert.deepEqual(f.kills, []);
    f.processes.clear(); f.tick();
    assert.equal(f.pool.xp.status, 'DISABLED'); assert.equal(f.available(), 64);
    assert.equal(f.pool.pipelines.get('money').mode, 'RUNNING'); assert.equal(f.launches.length, 1);
});

test('an owned XP hack completion is routed independently and credited only once', () => {
    const f = fixture(); f.tick(); const job = f.pool.xp.jobs.values().next().value;
    job.action = 'H';
    const event = { phase: 'PREP-H', type: 'done', batchId: job.id, chunkId: job.id, target: job.target, result: 25 };
    assert.equal(f.xp.consumeXpEvent(f.pool, { ...event, target: 'money' }), false);
    assert.equal(f.xp.consumeXpEvent(f.pool, event), true);
    assert.equal(f.xp.consumeXpEvent(f.pool, event), true);
    assert.equal(f.pool.xp.earned, 25); assert.equal(f.pool.xp.income.length, 1);
});

test('XP can reclaim configured fleet-share filler after checking future money reservations', () => {
    const f = fixture(); f.cfg.fleetShare = true;
    f.processes.set(5, { host: 'remote', ram: 64, filename: 'share-worker.js', threads: 32 });
    f.ns.ps = host => [...f.processes].filter(([, p]) => p.host === host).map(([pid, p]) => ({ pid, ...p }));
    f.tick();
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0].ram, 64);
    assert.deepEqual(f.kills, [5]); assert.equal(f.pool.xp.status, 'RUNNING');
});

test('a due money launch can reclaim same-host XP RAM without poisoning the batch', () => {
    const f = fixture(); f.tick(); const xpPid = f.launches[0].pid;
    const chunk = { phase: 'H', chunkId: 'money-H', batchId: 'money', host: 'remote', threads: 1,
        script: 'jit-hack.js', ram: 2, launchAt: f.clock.now - 1, landAt: f.clock.now + 1000, duration: 500 };
    const batch = f.api.makeBatchState('money', [chunk]), stats = f.api.createStats();
    const execute = f.ns.exec; f.ns.exec = (...args) => f.processes.has(xpPid) ? 0 : execute(...args);
    f.api.launchDueChunks(f.ns, [chunk], 'money', f.cfg, new Map([['money', batch]]), stats,
        f.pool.running, f.pool.runningByChunk, null);
    assert.deepEqual(f.kills, [xpPid]); assert.equal(batch.poisoned, false); assert.equal(stats.execFails.H, 0);
    assert.ok(f.pool.runningByChunk.has('money-H'));
});
