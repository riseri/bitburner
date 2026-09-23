const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

test('target discovery advances inside a tight JIT launch lattice', () => {
    const clock = new Clock(1_000_000);
    const api = loadScript('lib/target-pipelines.js', clock);
    const anchor = {
        name: 'phantasy',
        mode: 'RUNNING',
        recovery: null,
        drain: null,
        runtime: { plan: { period: 500, batchRate: 2.3, expected: 100 } },
        stats: { pipeline: { completed: 300, productiveMs: 150000 }, lastHackAt: clock.now },
        queue: [{ launchAt: clock.now + 20 }],
    };
    const names = Array.from({ length: 95 }, (_, i) => `host-${i}`);
    const pool = {
        port: { empty: () => true },
        pipelines: new Map([[anchor.name, anchor]]),
        anchor: anchor.name,
        cfg: {
            maxTargets: 2,
            maxBatchRate: 4,
            maxSteal: 0.5,
            backgroundPrep: { status: 'WAITING', active: null, target: '' },
        },
        network: { servers: names, hosts: [] },
        blocked: new Map(),
        nextAdmission: 0,
        nextReadyScan: 0,
        nextAdmissionService: 0,
        readyScan: null,
        pendingAdmission: '',
        api: {
            targetHealth: () => ({ clean: false }),
        },
    };
    const ns = {
        hasRootAccess: () => true,
        getServerMaxMoney: () => 1e9,
        getServerRequiredHackingLevel: () => 1,
        getHackingLevel: () => 606,
        hackAnalyzeChance: () => 1,
    };

    assert.equal(api.serviceAdmissionOpportunity(ns, pool), true);
    assert.equal(pool.readyScan.index, 8);
    assert.equal(pool.nextAdmission, clock.now + 500);
});

test('target discovery refuses to run inside the final 5ms before a launch', () => {
    const clock = new Clock(1_000_000);
    const api = loadScript('lib/target-pipelines.js', clock);
    const anchor = {
        name: 'phantasy',
        mode: 'RUNNING',
        recovery: null,
        drain: null,
        runtime: { plan: { period: 500, batchRate: 2.3, expected: 100 } },
        stats: { pipeline: { completed: 300, productiveMs: 150000 }, lastHackAt: clock.now },
        queue: [{ launchAt: clock.now + 5 }],
    };
    const pool = {
        port: { empty: () => true },
        pipelines: new Map([[anchor.name, anchor]]),
        anchor: anchor.name,
        cfg: { maxTargets: 2, maxBatchRate: 4, maxSteal: 0.5, backgroundPrep: { status: 'WAITING' } },
        network: { servers: ['host-0'], hosts: [] },
        blocked: new Map(),
        nextAdmission: 0, nextReadyScan: 0, nextAdmissionService: 0, readyScan: null, pendingAdmission: '',
        api: { targetHealth: () => ({ clean: false }) },
    };
    assert.equal(api.serviceAdmissionOpportunity({}, pool), false);
    assert.equal(pool.readyScan, null);
});

test('background prep can select work in a tight window without exec', () => {
    const clock = new Clock(1_000_000);
    const api = loadScript('lib/background-prep.js', clock);
    const state = api.createBackgroundPrep({ enabled: true });
    state.target = 'max-hardware';
    state.quietUntil = 0;
    let execs = 0;
    const ns = {
        getServerMoneyAvailable: () => 100,
        getServerMaxMoney: () => 1_000,
        getServerSecurityLevel: () => 5,
        getServerMinSecurityLevel: () => 5,
        hasRootAccess: () => true,
        getServerRequiredHackingLevel: () => 1,
        getHackingLevel: () => 606,
        getScriptRam: () => 2,
        getServerMaxRam: () => 1024,
        getServerUsedRam: () => 0,
        growthAnalyze: () => 10,
        growthAnalyzeSecurity: () => 0.04,
        weakenAnalyze: () => 0.05,
        getGrowTime: () => 1_000,
        getWeakenTime: () => 1_250,
        isRunning: () => false,
        exec: () => { execs++; return 123; },
    };
    const stats = {
        restarts: 0, recoveries: 0, softRecoveries: 0, allocationFails: 0, expiredSlots: 0,
        misses: { H: 0, W1: 0, G: 0, W2: 0 },
        pipeline: { completed: 300, productiveMs: 150000 },
        lastHackAt: clock.now,
    };
    api.tickBackgroundPrep(ns, {
        state,
        target: 'phantasy',
        activeTargets: new Set(['phantasy']),
        network: { servers: ['max-hardware'], hosts: [{ name: 'cloud-00', maxRam: 1024, cores: 1 }] },
        cfg: {},
        runtime: { plan: { period: 500, expected: 100 } },
        stats,
        healthy: true,
        allowLaunch: false,
        spareRam: () => 1024,
    });
    assert.equal(state.status, 'WAITING_SCHEDULER');
    assert.match(state.reason, /safe scheduler window/);
    assert.equal(execs, 0);
});


test('only initial trial tuning gets the pre-planning liveness lane', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/lib/target-pipelines.js'), 'utf8');
    const loopStart = source.indexOf('while (true) {');
    const admission = source.indexOf('serviceAdmissionOpportunity(ns, pool);', loopStart);
    const planning = source.indexOf('planPipelineBatch(ns, pool);', loopStart);
    const maintenance = source.indexOf('servicePipelineMaintenance(ns, pool);', loopStart);
    assert.ok(loopStart >= 0 && admission > loopStart && planning > admission && maintenance > planning,
        'admission liveness should run before planning while recovery maintenance keeps original ordering');
    const service = source.slice(source.indexOf('export function serviceAdmissionOpportunity'),
        source.indexOf('function serviceBackgroundAndAdmission'));
    assert.match(service, /p\.trial && p\.mode === "TUNING"/);
    assert.doesNotMatch(service, /p\.mode === "PREPARING"/);
});


test('multi dashboard exposes second-target prep instead of mislabeling it as repair RAM', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const daemon = fs.readFileSync(path.join(__dirname, '../src/daemon.js'), 'utf8');
    assert.match(daemon, /dashboardSection\(ns, "Next target"\)/);
    assert.match(daemon, /formatRam\(backgroundRam\).*held/);
    assert.match(daemon, /backgroundPrep: background \?/);
    assert.match(daemon, /repairRam = Math\.max\(0, prepRam - backgroundRam\)/);
    assert.doesNotMatch(daemon, /row\("Repair RAM", `\$\{formatRam\(prepRam\)\} held separately`\)/);
});

test('admission status reports the active background-prep target and phase', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/lib/target-pipelines.js'), 'utf8');
    assert.match(source, /pool\.note = `Background prep\$\{target\}: \$\{prep\.status \|\| "WAITING"\}`/);
    assert.match(source, /prep\.reason \? ` \| \$\{prep\.reason\}` : ""/);
});
