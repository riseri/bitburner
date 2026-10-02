const { Clock, Port, loadScript } = require('./helpers.cjs');

// Reproduce the reported topology: 64 TB home, 2.71 TB remote, a paid priority
// lane, an empty old TUNING plan, and 53 TB of prepared XP mostly on home.
function fixture({ trial = false } = {}) {
    const clock = new Clock(), api = loadScript('daemon.js', clock);
    const multi = loadScript('lib/target-pipelines.js', clock), scaling = loadScript('lib/scheduler-scaling.js', clock);
    const capacity = loadScript('lib/scheduler-capacity.js', clock), economics = loadScript('lib/fleet-economics.js', clock);
    const goal = { milestone: 'FINAL_SERVER', limitingResource: 'hacking', moneyCovered: true };
    const cfg = { gap: 100, lead: 600, maxTargets: 6, targetMode: 'auto', maxWorkers: 6000, maxSteal: .5,
        homeReserve: trial ? 195.85 : 161.75, homeGw: { host: { name: 'home', maxRam: 65536, cores: 5 }, maxRam: 65536,
            cores: 5, maxCores: 8, coreBonus: 1.25, runningRam: trial ? 64971.85 : 64360, reclaimableShareRam: 0,
            protectedRam: trial ? 195.85 : 161.75, requiredShareRam: 0, state: 'ACTIVE', reason: 'Owned G/W work',
            unrelatedRam: 366.95, criticalReserve: trial ? 195.85 : 161.75 },
        hackingPolicy: { mode: 'XP', xpAllocation: trial ? .85 : .7 }, progressionObjective: goal, prepStates: [],
        backgroundPrep: { status: 'WAITING' }, switchThreshold: 1.25 };
    const scaler = scaling.createSchedulerScaling(cfg);
    // The reported automatic controller had backed off to these budgets.
    scaler.batch = trial ? 2.25 : 3; scaler.launches = trial ? 16 : 40; scaling.applySchedulerLimits(cfg, scaler);
    if (trial) scaler.restore = { batch: 4, launches: 32 };
    const pool = { cfg, api, running: new Map(), runningByChunk: new Map(), reservations: [],
        foreign: new Map([['public-a', 0], ['public-b', 0]]), blocked: new Map(), launchBuckets: new Map(),
        network: { hosts: ['public-a', 'public-b'].map(name => ({ name, maxRam: trial ? 1658.88 : 1387.5, cores: 1 })), servers: [] },
        pipelines: new Map(), port: new Port() };
    const money = multi.createTargetPipeline('b-and-a', cfg, api, 7, 0,
        { plan: { batchRate: 2.36, period: 423, expected: 32.24e9, ramTime: 5e6, times: { W: 60000 } } });
    const idle = multi.createTargetPipeline(trial ? 'megacorp' : 'joesguns', cfg, api, 7, 1,
        { plan: { batchRate: 2.37, period: 422, expected: 1e9, ramTime: 4e6, times: { W: 60000 } } });
    idle.mode = trial ? 'RUNNING' : 'TUNING'; idle.trial = trial;
    idle.admissionReason = trial ? 'shared launch budget / fragmented batch' : 'no whole HWGW batch fits host RAM reservations';
    money.trial = false; money.stats.pipeline.productiveMs = 1800000; money.stats.pipeline.completed = 240;
    pool.pipelines.set(money.name, money); pool.pipelines.set(idle.name, idle);
    const jobs = new Map(); let pid = 100;
    function running(host, ram, xp = false) {
        const id = ++pid, chunk = { host, ram, phase: xp ? 'XP-G' : 'G', action: 'G', threads: ram / 2,
            owner: xp ? undefined : money, status: 'running', launchAt: clock.now, landAt: clock.now + 60000 };
        chunk.reservation = api.reserveChunk(pool.reservations, chunk);
        if (xp) { chunk.reservation.end = Infinity; jobs.set(id, chunk); }
        else money.running.set(id, chunk);
        api.trackRunning(pool.running, id, chunk); return chunk;
    }
    const placed = [running('home', trial ? 4331.21 : 10060), running('public-a', trial ? 931.52 : 1000), running('public-b', trial ? 931.52 : 1000)];
    money.batches.set('placed', { chunks: new Map(placed.map((c, i) => [i, c])),
        admissionPeriod: trial ? scaling.pipelineAdmissionPeriod(pool, money) : undefined });
    running('home', trial ? 60640.64 : 54300, true); running('public-a', 200, true); running('public-b', 200, true);
    const pending = (trial ? [['public-a', 321.36], ['public-b', 321.36]] : [['home', 622], ['public-a', 175], ['public-b', 175]]).map(([host, ram]) => {
        const chunk = { host, ram, owner: money, status: 'queued', launchAt: clock.now + 20000, landAt: clock.now + 60000 };
        chunk.reservation = api.reserveChunk(pool.reservations, chunk); money.queue.push(chunk); return chunk;
    });
    pool.xp = { status: 'RUNNING', desiredRam: 1942.5, ramConstrained: false, jobs, samples: [],
        choice: { name: 'nectar-net', action: 'G', score: 2.14e6 }, wave: { action: 'G', preparing: false, duration: 60000 } };
    const ns = { getServerUsedRam: host => [...pool.running.values()].filter(c => c.host === host).reduce((n, c) => n + c.ram, 0) +
            (host === 'home' ? 366.95 : 0), getServerMaxRam: () => 65536 };
    function sample({ moneyAge = 0, blockedDemand = false } = {}) {
        clock.now += 10000;
        money.stats.lastHackAt = clock.now - moneyAge; money.stats.income = [{ time: clock.now - moneyAge, money: 28.04e9 * 60 }];
        if (trial) { idle.stats.lastHackAt = clock.now - moneyAge; idle.stats.income = [{ time: clock.now - moneyAge, money: 16.26e9 * 60 }]; }
        for (const c of placed) { c.reservation.start = clock.now - 1; c.reservation.end = clock.now + 60000; }
        for (const c of pending) { c.reservation.start = clock.now + 20000; c.reservation.end = clock.now + 60000; }
        const slot = Math.floor(clock.now / 250);
        pool.launchBuckets = trial ? new Map([[slot + 40, 1], [slot + 41, 3], [slot + 42, 4]]) : new Map([[slot + 40, 10], [slot + 41, 6]]);
        if (blockedDemand) idle.admissionDemand = { at: clock.now, requiredLimit: 36, peakBucket: 9, peakReserved: 12, limit: cfg.maxLaunches };
        for (const [kind, count] of [['loop', 100], ['launch', 20], ['landing', 20]])
            for (let i = 0; i < count; i++) scaling.recordSchedulerTiming(scaler, kind, 0, cfg.gap);
        multi.serviceSchedulerScaling(ns, pool, clock.now);
        return capacity.schedulerCapacity(pool, clock.now);
    }
    return { clock, api, multi, scaling, capacity, economics, cfg, scaler, pool, money, idle, goal, ns, sample };
}

module.exports = {fixture};
