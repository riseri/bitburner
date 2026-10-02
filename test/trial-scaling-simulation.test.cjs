const test = require('node:test'), assert = require('node:assert/strict');
const { NetscriptSimulation } = require('./simulator.cjs');
const { loadScript } = require('./helpers.cjs');

test('AUTO replaces cheap bootstrap targets at a full batch budget before reaching six slots', {timeout:180000}, async()=>{
    const sim=new NetscriptSimulation({target:'joesguns',weakenTime:8000,levelPerMinute:0,hostCount:0,
        mainServer:{max:10e6,money:10e6,sec:1,min:1,required:1},
        flags:{target:'joesguns','max-targets':'auto','max-batch-rate':3,'max-launches':52,gap:100},
        backgroundTargets:{'nectar-net':{max:12e6,money:12e6,weakenTime:12000},
            rich:{max:200e9,money:20e9,sec:9,min:3,required:999999,weakenTime:40000}}});
    sim.hosts.set('home',{ram:65536,cores:5});sim.hosts.set('public-ram',{ram:2348,cores:1});
    sim.baseLevel=7814;
    sim.perThread=target=>{const s=sim.servers.get(target);return .025*(100-s.sec)/(100-s.min);};
    const multi=loadScript('lib/target-pipelines.js',sim.clock);
    sim.daemon=loadScript('daemon.js',sim.clock,{runTargetPipelines:async(ns,setup,api)=>{
        const render=api.renderSchedulerDashboard;api.renderSchedulerDashboard=(ns,pool)=>{sim.pool=pool;render(ns,pool);};
        return multi.runTargetPipelines(ns,setup,api);
    }});
    sim.run();await sim.clock.runUntil(sim.start+5*60000);
    assert.deepEqual(sim.errors.map(String),[]);assert.equal(sim.pool.pipelines.size,2);
    assert.ok(multi.remainingBatchRate(sim.pool)<.25,'bootstrap lanes consume the fixed combined rate');
    const before=sim.summary().income60,old=[...sim.pool.pipelines.values()];
    const survivor=old.reduce((a,b)=>a.runtime.plan.expected>b.runtime.plan.expected?a:b),epoch=survivor.epoch;
    const unlocked=sim.clock.now;sim.servers.get('rich').required=100;
    await sim.clock.runUntil(sim.start+18*60000);
    assert.deepEqual(sim.errors.map(String),[]);
    const status=sim.getPort(17).peek();
    assert.ok(status.pipelines.some(p=>p.target==='rich'&&p.income60>0),JSON.stringify(status));
    assert.ok(sim.pool.history.some(p=>p.name!==survivor.name&&/steady-state promotion/.test(p.retireReason)));
    assert.equal(sim.pool.pipelines.get(survivor.name).epoch,epoch);assert.equal(survivor.stats.restarts,0);
    for(let at=unlocked;at+60000<sim.clock.now;at+=60000)
        assert.ok(sim.paid.some(p=>p.target===survivor.name&&p.at>=at&&p.at<at+60000),'surviving lane keeps paying');
    assert.ok(sim.summary().income60>before*50,'richer replacement restores actual income, not just modeled ranking');
    assert.ok(sim.snapshots.every(s=>s.pipelines.length<=2&&(s.capacity?.batchRate.used||0)<=3.001));
    assert.equal(sim.killed.filter(p=>p.target===survivor.name&&p.phase==='H').length,0);
    assert.ok(sim.actions.filter(a=>['H','G','W1','W2'].includes(a.phase))
        .every(a=>a.startSec<=sim.servers.get(a.target).min+.001));
    for(const [host,ram]of sim.peakRam)assert.ok(ram<=sim.hosts.get(host).ram+1e-6,host);
    console.log(JSON.stringify({replacement:status.pipelines.map(p=>p.target),incomeBefore:before,
        incomeAfter:sim.summary().income60,batchLimit:status.maxBatchRate,launchLimit:status.maxLaunches}));
});

test('live AUTO trials recover from two global backoffs and continue admitting profitable targets', { timeout: 180000 }, async () => {
    const sim = new NetscriptSimulation({ target: 'alpha', weakenTime: 12000, levelPerMinute: 0, hostCount: 12,
        mainServer: { max: 1e9, money: 1e9, sec: 3, min: 3, required: 10 },
        flags: { target: 'alpha', 'max-targets': 'auto', gap: 100 },
        backgroundTargets: { beta: { max: 2e9, money: 2e9, weakenTime: 120000 },
            gamma: { max: 3e9, money: 3e9, weakenTime: 120000 }, delta: { max: 4e9, money: 4e9, weakenTime: 120000 } } });
    const multi = loadScript('lib/target-pipelines.js', sim.clock), scaling = loadScript('lib/scheduler-scaling.js', sim.clock);
    const restores = [], faults = [];
    sim.daemon = loadScript('daemon.js', sim.clock, { runTargetPipelines: async (ns, setup, api) => {
        const render = api.renderSchedulerDashboard;
        api.renderSchedulerDashboard = (ns, pool) => {
            sim.pool = pool;
            if (pool.cfg.schedulerScaling.decision === 'RESTORE') restores.push({
                at: sim.clock.now, trial: [...pool.pipelines.values()].some(p => p.trial),
                budgets: [pool.cfg.maxBatchRate, pool.cfg.maxLaunches] });
            render(ns, pool);
        };
        return multi.runTargetPipelines(ns, setup, api);
    } });
    function overload() {
        const pool = sim.pool, state = pool.cfg.schedulerScaling;
        // Inject a global timing sample, not a worker failure. Real workers,
        // payouts, reservations, cadence and trial evaluation keep running.
        scaling.recordSchedulerTiming(state, 'loop', 300, pool.cfg.gap);
        state.nextSample = sim.clock.now;
        multi.serviceSchedulerScaling(sim.ns(sim.controller), pool, sim.clock.now);
        faults.push({ at: sim.clock.now, budgets: [pool.cfg.maxBatchRate, pool.cfg.maxLaunches],
            trial: [...pool.pipelines.values()].some(p => p.trial) });
    }
    function waitForTrial() {
        if ([...(sim.pool?.pipelines.values() || [])].some(p => p.trial && p.mode === 'RUNNING')) {
            overload(); sim.clock.timer(120001, overload);
        } else sim.clock.timer(1000, waitForTrial);
    }
    sim.clock.timer(1000, waitForTrial);
    sim.run(); await sim.clock.runUntil(sim.start + 22 * 60000);
    assert.deepEqual(sim.errors.map(String), []);
    assert.equal(faults.length, 2); assert.ok(faults.every(f => f.trial), JSON.stringify(faults));
    assert.deepEqual(faults[1].budgets, [2.25, 16]);
    assert.ok(restores.some(r => r.trial && r.budgets[0] > 2.25 && r.budgets[1] > 16), JSON.stringify(restores));
    const status = sim.getPort(17).peek();
    assert.ok(status.pipelines.length > 2, JSON.stringify(status));
    for (const lane of status.pipelines) {
        assert.equal(lane.mode, 'LIVE'); assert.ok(lane.income60 > 0); assert.equal(lane.restarts, 0);
        assert.equal(Object.values(lane.misses).reduce((n, v) => n + v, 0), 0);
    }
    assert.equal(sim.killed.filter(p => p.phase === 'H').length, 0);
    assert.ok(sim.actions.filter(a => ['H', 'G', 'W1', 'W2'].includes(a.phase))
        .every(a => a.startSec <= sim.servers.get(a.target).min + .001));
    for (const [host, ram] of sim.peakRam) assert.ok(ram <= sim.hosts.get(host).ram + 1e-6, host);
    console.log(JSON.stringify({ faults, restores, lanes: status.pipelines.length, income60: status.income60,
        budgets: [status.maxBatchRate, status.maxLaunches] }));
});
