const test = require('node:test'), assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function tail() {
    const entries = [];
    return { entries, clearLog: () => { entries.length = 0; }, print: entry => {
        if (entries.length > 50) entries.shift(); entries.push(String(entry));
    } };
}

test('a detailed dashboard exceeding the game log cap retains its title and every section', () => {
    const ui = loadScript('lib/dashboard.js', new Clock()), ns = tail();
    for (let refresh = 0; refresh < 3; refresh++) ui.dashboardFrame(ns, frame => {
        frame.clearLog(); ui.dashboardTitle(frame, 'COMPLETE DASHBOARD');
        for (let section = 0; section < 12; section++) {
            ui.dashboardSection(frame, 'Section ' + section);
            for (let row = 0; row < 10; row++) ui.dashboardRow(frame, 'Value ' + row, 'long detail '.repeat(12));
        }
    });
    assert.equal(ns.entries.length, 1);
    assert.match(ns.entries[0], /^╔═ COMPLETE DASHBOARD/);
    for (let section = 0; section < 12; section++) assert.ok(ns.entries[0].includes('SECTION ' + section));
    assert.ok(ns.entries[0].split('\n').every(line => line.length <= 78));
});

test('home-heavy XP dashboard identifies the waiting lane and bounded cloud growth confidence', () => {
    const f=require('./home-xp-fixture.cjs').fixture(),ui=loadScript('lib/dashboard.js',f.clock),ns=tail();
    let c;for(let i=0;i<7;i++)c=f.sample();
    ui.dashboardFrame(ns,frame=>ui.renderSchedulerCapacity(frame,c));
    const output=ns.entries[0];
    assert.match(output,/1 running\/committed \| 1 waiting/);
    assert.match(output,/XP expansion/);assert.match(output,/bounded growth \| MODEL \(warmup\)/);
    assert.ok(output.split('\n').every(line=>line.length<=78));
});

test('supervisor detailed view prints one complete frame with resource and utility headings', () => {
    const api = loadScript('supervisor.js', new Clock()), ns = { ...tail(), ps: () => [],
        getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }), read: () => '',
        getPortHandle: () => ({ peek: () => null }) };
    api.render(ns, { cfg: { dashboardDetails: true, utilityJobs: Array.from({ length: 30 }, () =>
        ({ type: 'diagnostics', state: 'READY', message: 'Completed utility' })) }, services: [] });
    assert.equal(ns.entries.length, 1);
    assert.match(ns.entries[0], /^╔═ BITBURNER AUTOMATION/);
    for (const heading of ['RESOURCES AND SERVICES', 'UTILITY DIAGNOSTICS', 'PROGRESSION', 'AUGMENTATION LOOP', 'SERVICES'])
        assert.ok(ns.entries[0].includes(heading), heading);
});

test('daemon log reader accepts a complete multiline refresh and legacy separate entries', () => {
    const api = loadScript('supervisor.js', new Clock());
    const lines = ['JIT DAEMON :: money :: hacking 731', '  Income 60s     $100/s', '  State          LIVE'];
    for (const logs of [lines, [lines.join('\n')]]) {
        const snapshot = api.readDaemonDashboard({ ps: () => [{ filename: 'daemon.js', pid: 1 }], getScriptLogs: () => logs });
        assert.equal(snapshot.target, 'money'); assert.equal(snapshot.income60, '$100/s');
    }
});

test('capacity display separates next-target batch headroom from recent and future launch budgets',()=>{
    const clock=new Clock(), producer=loadScript('lib/scheduler-capacity.js',clock), ui=loadScript('lib/dashboard.js',clock), ns=tail();
    const pool={cfg:{maxTargets:6,targetMode:'auto',maxBatchRate:4,maxLaunches:32,maxWorkers:6000},
        pipelines:new Map([['a',{runtime:{plan:{batchRate:3.95}},queue:[],stats:{pipeline:{}}}]]),
        network:{hosts:[]},running:new Map(),foreign:new Map(),launchBuckets:new Map(),
        admission:{decision:'HOLD',candidate:'rho-construction',reason:'BATCH_RATE'}};
    const c=producer.schedulerCapacity(pool);
    for(const details of [true,false]) {
        ui.dashboardFrame(ns,frame=>ui.renderSchedulerCapacity(frame,c,details));
        const output=ns.entries[0];
        assert.match(output,/HOLD \| rho-construction \| BATCH_RATE/);
        if(details) {
            assert.match(output,/0\.050\/s free \| next target needs 0\.250\/s/);
            assert.match(output,/peak reserved/);assert.match(output,/32 launches\/s \| 8 per 250ms for secondary targets/);
            assert.match(output,/XP\/prep budget\s+24 launches\/s after money headroom/);
        } else assert.doesNotMatch(output,/peak reserved|Batch headroom/);
        assert.ok(output.split('\n').every(line=>line.length<=78));
    }
});

test('the endgame trial dashboard shows restoration, full peer budget, actual demand and independent XP expansion',()=>{
    const f=require('./home-xp-fixture.cjs').fixture({trial:true}),ui=loadScript('lib/dashboard.js',f.clock),ns=tail();
    let c;for(let i=0;i<7;i++)c=f.sample({moneyAge:11000,blockedDemand:true});
    ui.dashboardFrame(ns,frame=>ui.renderSchedulerCapacity(frame,c,true));
    const output=ns.entries[0];
    assert.match(output,/AUTO launches \| RESTORE/);
    assert.match(output,/Recover budget\s+4\.00 batches\/s \| 32 launches\/s/);
    assert.match(output,/Peer budget\s+24 launches\/s \| 6 per 250ms/);
    assert.match(output,/Launch demand\s+36 launches\/s/);
    assert.match(output,/XP expansion/);assert.match(output,/MODEL \(warmup\)/);
    assert.ok(output.split('\n').every(line=>line.length<=78));
});

test('dashboard labels managed augmentation advice and stock access without calling them blocked augments', () => {
    const api = loadScript('supervisor.js', new Clock()), ns = { ...tail(), ps: () => [],
        getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }), read: () => '',
        getPortHandle: () => ({ peek: () => null }) };
    api.render(ns, { cfg: { dashboardDetails: true, utilityJobs: [
        { type: 'augmentation-plan', state: 'BLOCKED', message: 'Manager publishes the live plan' },
        { type: 'stock-access', state: 'READY', message: 'Stock access owned' },
    ] }, services: [] });
    assert.match(ns.entries[0], /Augmentations\s+MANAGED: Manager publishes/);
    assert.match(ns.entries[0], /Stock access\s+READY: Stock access owned/);
});

test('waiting XP display reports its blocker, unreserved capacity and potential-only model', () => {
    const api = loadScript('supervisor.js', new Clock()), ns = tail();
    api.renderExperienceStatus(ns, { policy: { mode: 'XP', xp: { target: 'joesguns', action: 'G', state: 'WAITING_WORKERS',
        reason: 'shared worker commitments leave no XP worker slot', availableRam: 524288, ram: 0, workers: 0, estimatedXpPerSecond: 9.69e6 } } });
    const output = ns.entries.join('\n');
    assert.match(output, /WAITING_WORKERS/); assert.match(output, /worker commitments/);
    assert.match(output, /512\.00 TB unreserved/); assert.match(output, /potential; no XP workers running/);
});

test('endgame dashboard distinguishes measured reset XP, proposed upgrades and queued NeuroFlux', () => {
    const api = loadScript('supervisor.js', new Clock()), ns = tail();
    api.renderAugmentationLoop(ns, { state: 'ACTIVE', phase: 'HACKING', queued: 21,
        endgame: { reason: 'Observing reset advantage', xp: { source: 'manager measured', rate: 9.69e6 },
            quote: { neurofluxLevels: 20, augmentations: ['Core V3'], cost: 2e12 }, neurofluxQueued: 20 } },
        { augmentationActions: true, minInstall: 5 });
    const output = ns.entries.join('\n');
    assert.match(output, /Reset XP rate\s+9\.69e\+6\/s \| manager measured/);
    assert.match(output, /Upgrade quote\s+20 NeuroFlux levels \| 1 other upgrades/);
    assert.match(output, /NeuroFlux\s+20 queued levels/);
    assert.match(output, /Queued\s+21 augmentation\(s\)/);
});
