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

test('dynamic XP ceiling still preserves tiny-fleet money reservations and publishes unmet RAM demand', () => {
    const f = fixture(); f.cfg.hackingPolicy.xpAllocation = .85;
    f.api.reserveChunk(f.pool.reservations, { host: 'remote', ram: 60, launchAt: f.clock.now + 5000,
        landAt: f.clock.now + 10000, status: 'queued', phase: 'G' });
    f.tick();
    assert.equal(f.launches[0].threads, 2);
    assert.equal(f.pool.xp.desiredRam, 64 * .85);
    assert.equal(f.pool.xp.ramConstrained, true);
    const lane = f.pool.pipelines.get('money');
    lane.stats = { pipeline: { driftMax: 0 } };
    f.cfg.maxBatchRate = 4; f.cfg.maxTargets = 1;
    const capacity = loadScript('lib/scheduler-capacity.js', f.clock).schedulerCapacity(f.pool, f.clock.now);
    assert.ok(capacity.constraints.includes('XP_RAM'));
    assert.equal(capacity.xp.allocatedRam, 4);
});

test('read-only shadow tuning keeps XP running; actual cutover preflight still gets RAM priority', () => {
    const f = fixture(), lane = f.pool.pipelines.get('money');
    lane.name = 'money'; lane.shadow = { state: 'SHADOW' };
    f.tick(); assert.equal(f.pool.xp.status, 'RUNNING'); assert.equal(f.launches.length, 1);
    f.tick(); assert.deepEqual(f.kills, []);
    lane.shadow.state = 'PREFLIGHT'; f.tick();
    assert.equal(f.pool.xp.status, 'WAITING_MONEY'); assert.equal(f.kills.length, 1);
    assert.match(f.pool.xp.reason, /money CUTOVER_PREFLIGHT/);
});

for (const mode of ['PREPARING', 'TUNING', 'RECOVERING', 'DRAINING']) {
    test(`endgame XP uses unreserved RAM during peer ${mode} while a healthy money lane earns`, () => {
        const f = fixture(), lane = f.pool.pipelines.get('money');
        f.cfg.progressionObjective = { milestone: 'FINAL_SERVER', limitingResource: 'hacking', moneyCovered: true };
        Object.assign(lane, { name: 'money', stats: { pipeline: { completed: 1 }, money: 1000, lastHackAt: f.clock.now } });
        const peer = { name: 'clarkinc', mode, queue: [] };
        if (mode === 'RECOVERING') { peer.mode = 'RUNNING'; peer.recovery = {}; }
        if (mode === 'DRAINING') peer.drain = {};
        f.pool.pipelines.set(peer.name, peer);
        f.api.reserveChunk(f.pool.reservations, { host: 'remote', ram: 20, launchAt: f.clock.now + 5000,
            landAt: f.clock.now + 10000, status: 'queued', phase: 'W' });
        f.tick(); assert.equal(f.pool.xp.status, 'RUNNING'); assert.equal(f.launches[0].ram, 44);
        assert.equal(f.available(), 0); assert.equal(f.launches[0].args[0], 'alpha');
        f.tick(); assert.deepEqual(f.kills, [], 'a busy peer alone must not cancel independent XP');
    });
}

for (const guard of ['ordinary-goal', 'cash', 'no-payout', 'stale-income', 'future-income', 'anchor-recovery', 'cutover']) {
    test(`endgame borrowing still waits for money with ${guard}`, () => {
        const f = fixture(), lane = f.pool.pipelines.get('money');
        f.cfg.progressionObjective = { milestone: 'FINAL_SERVER', limitingResource: 'hacking', moneyCovered: true };
        Object.assign(lane, { name: 'money', stats: { pipeline: { completed: 1 }, money: 1000, lastHackAt: f.clock.now } });
        f.pool.pipelines.set('clarkinc', { name: 'clarkinc', mode: 'PREPARING', queue: [] });
        if (guard === 'ordinary-goal') f.cfg.progressionObjective.milestone = 'DAEDALUS';
        if (guard === 'cash') f.cfg.progressionObjective.moneyCovered = false;
        if (guard === 'no-payout') lane.stats.money = 0;
        if (guard === 'stale-income') lane.stats.lastHackAt -= 120001;
        if (guard === 'future-income') lane.stats.lastHackAt++;
        if (guard === 'anchor-recovery') lane.recovery = {};
        if (guard === 'cutover') lane.shadow = { state: 'PREFLIGHT' };
        f.tick(); assert.equal(f.pool.xp.status, 'WAITING_MONEY'); assert.equal(f.launches.length, 0);
        assert.match(f.pool.xp.reason, /clarkinc PREPARING/);
    });
}

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

test('XP distinguishes RAM reservations, worker commitments, launch budgets and failed execution', () => {
    for (const blocker of ['RAM', 'workers', 'launches', 'exec']) {
        const f = fixture();
        if (blocker === 'RAM') f.api.reserveChunk(f.pool.reservations, { host: 'remote', ram: 64,
            launchAt: f.clock.now + 5000, landAt: f.clock.now + 10000, status: 'queued', phase: 'G' });
        if (blocker === 'workers') { f.cfg.maxWorkers = 16; f.pool.pipelines.get('money').queue = Array(12).fill({}); }
        if (blocker === 'launches') f.pool.launchBuckets.set(Math.floor(f.clock.now / 250), 8);
        if (blocker === 'exec') f.ns.exec = () => 0;
        f.tick();
        const status = f.xp.xpPipelineStatus(f.ns, f.pool).xp;
        assert.equal(status.state, { RAM: 'WAITING_RAM', workers: 'WAITING_WORKERS', launches: 'WAITING_LAUNCH', exec: 'WAITING_EXEC' }[blocker]);
        assert.equal(status.availableRam, blocker === 'RAM' ? 0 : 64);
        assert.match(status.reason, { RAM: /money reservations/, workers: /worker commitments/, launches: /launch budget/, exec: /launch failed/ }[blocker]);
        assert.equal(status.workers, 0); assert.equal(f.launches.length, 0);
    }
});

test('waiting XP work can report a fresh measured total XP ETA from income and university work', () => {
    const f = fixture(), balance = loadScript('lib/milestone-balance.js', f.clock);
    const objective = { resetEpoch: '4:1:2', milestone: 'FINAL_SERVER', requiredHacking: 9000, requiredCash: 0 };
    f.cfg.progressionObjective = objective;
    f.cfg.hackingPolicy = { mode: 'XP', targetLevel: 9000, multipliers: { HackingLevelMultiplier: 1 } };
    f.ns.formulas.skills = { calculateExp: () => 101000 };
    f.pool.xp.status = 'WAITING_RAM';
    f.cfg.milestoneEvidence = { key: balance.milestoneKey(objective), safe: true, generatedAt: f.clock.now,
        xp: { source: 'measured', rate: 1000 } };
    const status = f.xp.xpPipelineStatus(f.ns, f.pool);
    assert.equal(status.xp.observedTotalXpPerSecond, 1000);
    assert.equal(status.progress.etaMs, 100000); assert.equal(status.xp.workers, 0);
    // No positive wave model may disguise unsafe, stale or noisy total evidence.
    f.pool.xp.status = 'RUNNING'; f.pool.xp.samples = [1000, 1000, 1000];
    for (const change of ['unsafe', 'stale', 'noisy']) {
        f.cfg.milestoneEvidence.safe = change !== 'unsafe';
        f.cfg.milestoneEvidence.generatedAt = f.clock.now - (change === 'stale' ? 15001 : 0);
        f.cfg.milestoneEvidence.xp.source = change === 'noisy' ? 'UNKNOWN (unstable or zero)' : 'measured';
        assert.equal(f.xp.xpPipelineStatus(f.ns, f.pool).progress.etaMs, null, change);
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

for(const guard of ['available','future-money','launch-limit','worker-limit']) test(`new cloud RAM joins prepared XP without restarting the wave: ${guard}`, () => {
    const f=fixture();f.tick();const originalPid=f.launches[0].pid;
    f.pool.network.hosts.push({name:'new-cloud',maxRam:64,cores:1});
    f.pool.foreign.set('new-cloud',0);
    if(guard==='future-money')f.api.reserveChunk(f.pool.reservations,{host:'new-cloud',ram:64,
        launchAt:f.clock.now+1000,landAt:f.clock.now+10000,status:'queued',phase:'G'});
    if(guard==='launch-limit')f.pool.launchBuckets.set(Math.floor(f.clock.now/250),8);
    if(guard==='worker-limit')f.cfg.maxWorkers=4;
    f.tick();
    assert.ok(f.processes.has(originalPid));assert.deepEqual(f.kills,[]);
    assert.equal(f.launches.length,guard==='available'?2:1);
    if(guard==='available'){
        const added=f.launches[1];assert.equal(added.host,'new-cloud');assert.equal(added.threads,32);
        assert.ok(f.pool.running.has(added.pid));assert.equal(f.pool.xp.jobs.size,2);
        assert.equal(f.api.availableRam(f.ns,f.pool.network.hosts[1],f.cfg,f.pool.running,
            f.pool.reservations,f.clock.now,Infinity,f.pool.foreign),0);
        f.tick();assert.equal(f.launches.length,2,'unchanged capacity cannot launch duplicate workers');
    }
});
