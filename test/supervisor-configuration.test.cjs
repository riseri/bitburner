const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

test('default configuration enables actions; explicit service opt-outs remain available', () => {
    const api = loadScript('lib/service-catalog.js', new Clock());
    const cfg = api.supervisorServiceConfig();
    assert.equal(cfg.progressionActions, true);
    assert.equal(cfg.augmentationActions, true);
    const limited = api.supervisorServiceConfig(['--augmentation-actions=false', '--progression-actions', false]);
    assert.equal(limited.augmentationActions, false);
    assert.equal(limited.progressionActions, false);
});

test('locked services need no files or RAM reservations; unlocks and opt-outs change the budget', () => {
    const api = loadScript('lib/service-catalog.js', new Clock());
    const cfg = api.supervisorServiceConfig(), queried = [];
    const costs = { 'doctor.js': 2, 'augmentation-planner.js': 100, 'progression-purchase.js': 50,
        'progression-backdoor.js': 80, 'augmentation-manager.js': 200, 'darknet-manager.js': 30, 'darknet-agent.js': 10 };
    const ns = { getScriptRam: file => { queried.push(file); return costs[file]; } };
    const locked = { singularity: false, darknet: false, stocks: false };
    assert.deepEqual(JSON.parse(JSON.stringify(api.supervisorRamBudget(ns, cfg, locked))),
        { actorRam: 0, utilityRam: 2, optionalRam: 0 });
    assert.deepEqual(queried, ['doctor.js']);
    assert.ok(api.selectedServices(cfg, locked).every(service => !service.capability));
    assert.ok(api.supervisorFiles(cfg, locked).every(file => !/augmentation|progression-(purchase|backdoor)|stock|darknet|bootstrap/.test(file)));
    const unlocked = { singularity: true, darknet: true, stocks: true };
    assert.deepEqual(JSON.parse(JSON.stringify(api.supervisorRamBudget(ns, cfg, unlocked))),
        { actorRam: 80, utilityRam: 100, optionalRam: 240 });
    assert.ok(api.supervisorFiles(cfg, unlocked).includes('bootstrap.js'));
    Object.assign(cfg, { augmentationActions: false, augmentations: false, progressionActions: false, darknet: false });
    assert.deepEqual(JSON.parse(JSON.stringify(api.supervisorRamBudget(ns, cfg, unlocked))),
        { actorRam: 0, utilityRam: 2, optionalRam: 0 });
});

test('old saved profiles become explicit service choices and obsolete installation toggles disappear', () => {
    const api = loadScript('lib/supervisor-migration.js', new Clock());
    for (const profile of ['observe', 'assist', 'hands-off']) {
        const args = Array.from(api.restoreSupervisorArgs(JSON.stringify({ version: 1,
            args: [`--profile=${profile}`, '--auto-install', false, '--min-install', 8] })));
        assert.deepEqual(args, ['--min-install', 8, '--progression-actions', profile !== 'observe',
            '--augmentation-actions', profile !== 'observe']);
    }
    assert.deepEqual(Array.from(api.restoreSupervisorArgs(JSON.stringify({ version: 1, args: [] }))),
        ['--progression-actions', false, '--augmentation-actions', false]);
    assert.deepEqual(Array.from(api.migrateSupervisorArgs(['--profile', 'assist', '--augmentation-actions=false', '--auto-install=false'])),
        ['--augmentation-actions=false', '--progression-actions', true]);
    assert.deepEqual(Array.from(api.restoreSupervisorArgs(JSON.stringify({ version: 2, args: [] }))), []);
    for (const raw of ['', '{', '{"version":9,"args":[]}', '{"version":2,"args":[{}]}']) {
        assert.throws(() => api.restoreSupervisorArgs(raw));
    }
    assert.throws(() => api.migrateSupervisorArgs(['--profile', 'typo']), /Unknown saved/);
});

test('bootstrap restores migrated settings and refuses corrupt settings before launching', async () => {
    const api = loadScript('bootstrap.js', new Clock()), launches = [];
    const ns = { getHostname: () => 'home', read: () => JSON.stringify({ version: 1, args: ['--profile', 'hands-off'] }),
        tprint() {}, spawn: (...args) => { launches.push(args); } };
    await api.main(ns);
    assert.deepEqual(JSON.parse(JSON.stringify(launches[0])), ['supervisor.js', { threads: 1, spawnDelay: 0 }, '--progression-actions', true, '--augmentation-actions', true]);
    ns.read = () => '';
    await api.main(ns);
    assert.equal(launches.length, 1);
});

test('an adopted augmentation manager restarts without obsolete installation arguments', () => {
    const api = loadScript('lib/service-lifecycle.js', new Clock()), launches = [];
    let processes = [{ filename: 'augmentation-manager.js', pid: 42, threads: 1,
        args: ['--auto-install', false, '--port', 11, '--min-install', 8] }];
    const ns = { ps: () => processes, getPortHandle: () => new Port(), fileExists: () => true,
        run: (...args) => { launches.push(args); return 43; } };
    const service = api.createService('augmentation-manager.js', [], '', 11, false);
    api.tickService(ns, service, 1000);
    assert.deepEqual(Array.from(service.args), ['--port', 11, '--min-install', 8]);
    processes = [];
    api.tickService(ns, service, 2000);
    api.tickService(ns, service, 12000);
    assert.deepEqual(launches[0], ['augmentation-manager.js', 1, '--port', 11, '--min-install', 8]);
});

function supervisorFixture(node) {
    const clock = new Clock(), api = loadScript('supervisor.js', clock), processes = new Map(), ports = new Map();
    const files = new Map(), launches = [], reads = [], logs = [], killed = [], uiCalls = [], reset = { currentNode: node, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    const { readArgument } = loadScript('lib/service-lifecycle.js', clock);
    let pid = 10, navigator = false;
    const ns = { args: [], pid: 1, flags: pairs => Object.fromEntries(pairs.map(([name, value]) => [name, readArgument(ns.args, `--${name}`, value)])), getHostname: () => 'home',
        disableLog() {}, clearLog() {}, print: line => logs.push(String(line)), tprint() {}, scan: () => [], ps: () => [...processes.values()],
        ui: { openTail: id => uiCalls.push(['open', id]), windowSize: () => [1024, 768],
            moveTail: (...args) => uiCalls.push(['move', ...args]), resizeTail: (...args) => uiCalls.push(['resize', ...args]) },
        getResetInfo: () => reset, hasTorRouter: () => false, getServerMoneyAvailable: () => 1e6,
        fileExists: file => file === 'DarkscapeNavigator.exe' ? navigator : true,
        getScriptRam: file => { reads.push(file); return /augmentation|progression-(purchase|backdoor)/.test(file) ? 100 : 2; },
        getServerMaxRam: () => 4096, getServerUsedRam: () => 0, isRunning: id => processes.has(id),
        read: file => files.get(file) || '', write: async (file, value) => files.set(file, value),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        kill: id => { killed.push(id); return processes.delete(id); },
        run: (filename, threads, ...args) => { const p = { filename, threads, args, pid: ++pid }; processes.set(pid, p); launches.push(p); return pid; },
        sleep: async () => { throw new Error('end fixture'); } };
    return { ns, api, clock, processes, launches, files, reads, logs, killed, uiCalls, unlockDarknet: () => { navigator = true; } };
}

test('plain supervisor startup in BN5 excludes locked helpers and persists new defaults', async () => {
    const f = supervisorFixture(5);
    await assert.rejects(f.api.main(f.ns), /end fixture/);
    assert.ok(f.launches.some(p => p.filename === 'daemon.js'));
    assert.ok(f.launches.some(p => p.filename === 'progression-manager.js'));
    assert.ok(!f.launches.some(p => /augmentation|darknet|stock/.test(p.filename)));
    assert.ok(!f.reads.some(file => /augmentation|progression-(purchase|backdoor)|darknet/.test(file)));
    const daemon = f.launches.find(p => p.filename === 'daemon.js');
    assert.equal(daemon.args[daemon.args.indexOf('--home-reserve') + 1], 10);
    assert.deepEqual(JSON.parse(f.files.get('data/supervisor-bootstrap.json')).args, []);
    assert.equal(JSON.parse(f.files.get('data/supervisor-bootstrap.json')).version, 2);
});

test('plain supervisor startup in BN4 enables the augmentation loop without an installation switch', async () => {
    const f = supervisorFixture(4);
    await assert.rejects(f.api.main(f.ns), /end fixture/);
    const aug = f.launches.find(p => p.filename === 'augmentation-manager.js');
    assert.ok(aug);
    assert.equal(aug.args.includes('--auto-install'), false);
    assert.equal(aug.args[aug.args.indexOf('--min-install') + 1], 5);
});

test('a Darknet unlock admits the service without restarting the supervisor', async () => {
    const f = supervisorFixture(5);
    let ticks = 0;
    f.ns.sleep = async () => {
        if (++ticks === 2) throw new Error('end fixture');
        assert.ok(!f.launches.some(p => p.filename === 'darknet-manager.js'));
        f.unlockDarknet();
    };
    await assert.rejects(f.api.main(f.ns), /end fixture/);
    assert.equal(f.launches.filter(p => p.filename === 'darknet-manager.js').length, 1);
});


test('supervisor does not compete with an active INT session and resumes after it ends', async () => {
    const f = supervisorFixture(4), logs = [];
    f.ns.tprint = text => logs.push(text);
    const session = { version: 1, active: true, node: 4, nodeReset: 1, startedAt: 1000000,
        deadline: 1600000, target: 50, startExp: 0, startInt: 1, resets: 0 };
    f.files.set('data/intelligence-session.json', JSON.stringify(session));
    await f.api.main(f.ns);
    assert.equal(f.launches.length, 0);
    assert.match(logs[0], /INT farming session active/);
    session.active = false;
    f.files.set('data/intelligence-session.json', JSON.stringify(session));
    await assert.rejects(f.api.main(f.ns), /end fixture/);
    assert.ok(f.launches.some(p => p.filename === 'daemon.js'));
});

async function dashboardTicks(f, count = 3, afterTick = () => {}) {
    let ticks = 0;
    f.ns.sleep = async ms => {
        await f.clock.runUntil(f.clock.now + ms);
        afterTick(++ticks);
        if (ticks >= count) throw new Error('end fixture');
    };
    await assert.rejects(f.api.main(f.ns), /end fixture/);
}

test('plain startup renders details, forwards details and opens only supervisor and daemon once', async () => {
    const f = supervisorFixture(5);
    await dashboardTicks(f);
    const daemon = f.launches.find(p => p.filename === 'daemon.js');
    assert.equal(daemon.args[daemon.args.indexOf('--dashboard-details') + 1], true);
    assert.ok(!f.logs.some(line => line.includes('More detail:')));
    assert.deepEqual(f.uiCalls.filter(c => c[0] === 'open'), [['open', 1], ['open', daemon.pid]]);
    assert.equal(f.uiCalls.filter(c => c[0] === 'resize').length, 2);
    assert.equal(f.uiCalls.filter(c => c[0] === 'move').length, 2);
});

test('explicit string false keeps both newly launched dashboards compact', async () => {
    const f = supervisorFixture(5);
    f.ns.args = ['--dashboard-details', 'false'];
    await dashboardTicks(f);
    const daemon = f.launches.find(p => p.filename === 'daemon.js');
    assert.equal(daemon.args[daemon.args.indexOf('--dashboard-details') + 1], false);
    assert.ok(f.logs.some(line => line.includes('More detail:')));
});

test('open-dashboards false disables all UI calls without changing service startup', async () => {
    const f = supervisorFixture(5);
    f.ns.args = ['--open-dashboards', 'false'];
    f.ns.ui = new Proxy({}, { get() { assert.fail('UI must not be accessed'); } });
    await dashboardTicks(f);
    assert.ok(f.launches.some(p => p.filename === 'daemon.js'));
    assert.deepEqual(f.uiCalls, []);
    assert.equal(f.clock.steps, 0, 'no layout timer');
});

test('dashboard-layout none opens tails but never reads viewport, moves or resizes', async () => {
    const f = supervisorFixture(5);
    f.ns.args = ['--dashboard-layout', 'none'];
    f.ns.ui.windowSize = () => assert.fail('no layout queries');
    await dashboardTicks(f);
    assert.equal(f.uiCalls.length, 2);
    assert.ok(f.uiCalls.every(c => c[0] === 'open'));
    assert.equal(f.clock.steps, 0);
});

for (const args of [[], ['--dashboard-details', false]]) {
    test(`adopted daemon keeps ${JSON.stringify(args)} and is never restarted for UI preferences`, async () => {
        const f = supervisorFixture(5);
        f.processes.set(42, { filename: 'daemon.js', pid: 42, threads: 1, args: [...args] });
        await dashboardTicks(f);
        assert.deepEqual(f.processes.get(42).args, args);
        assert.ok(!f.launches.some(p => p.filename === 'daemon.js'));
        assert.deepEqual(f.killed, []);
        assert.deepEqual(f.uiCalls.filter(c => c[0] === 'open'), [['open', 1], ['open', 42]]);
        assert.ok(!f.logs.some(line => line.includes('More detail:')), 'supervisor uses its own detailed default');
    });
}

test('crashed adopted daemon retains compact args and opens replacement PID once after backoff', async () => {
    const f = supervisorFixture(5), args = ['--dashboard-details', false];
    f.processes.set(42, { filename: 'daemon.js', pid: 42, threads: 1, args });
    await dashboardTicks(f, 5, tick => { if (tick === 1) f.processes.delete(42); });
    const replacements = f.launches.filter(p => p.filename === 'daemon.js');
    assert.equal(replacements.length, 1);
    assert.deepEqual(replacements[0].args, args);
    assert.deepEqual(f.uiCalls.filter(c => c[0] === 'open'), [['open', 1], ['open', 42], ['open', replacements[0].pid]]);
    assert.deepEqual(f.killed, []);
});

test('supervisor tail opens in 8 GB starter mode before a daemon can fit', async () => {
    const f = supervisorFixture(5);
    f.ns.args = ['--progression', false];
    f.ns.getServerMaxRam = () => 8;
    f.ns.getServerUsedRam = () => 7.7;
    f.ns.getScriptRam = file => file === 'supervisor.js' ? 7.7 : 16;
    f.ns.hasRootAccess = () => true;
    await dashboardTicks(f);
    assert.deepEqual(f.uiCalls.filter(c => c[0] === 'open'), [['open', 1]]);
    assert.ok(f.logs.some(line => line.includes('STARTER MODE')));
    assert.equal(f.launches.length, 0);
});

for (const failure of ['missing-ui', 'openTail', 'windowSize', 'resizeTail', 'moveTail']) {
    test(`UI failure (${failure}) neither interrupts services nor retries every tick`, async () => {
        const f = supervisorFixture(5);
        let attempts = 0;
        if (failure === 'missing-ui') delete f.ns.ui;
        else f.ns.ui[failure] = () => { attempts++; throw new Error('UI unavailable'); };
        await dashboardTicks(f);
        assert.equal(f.launches.filter(p => p.filename === 'daemon.js').length, 1);
        assert.ok(f.launches.some(p => p.filename === 'progression-manager.js'));
        assert.deepEqual(f.killed, []);
        assert.equal(attempts, failure === 'missing-ui' ? 0 : 2);
        if (failure === 'windowSize') assert.equal(f.uiCalls.filter(c => c[0] === 'resize').length, 2);
    });
}

test('dashboard initialization is idempotent and layout waits for mounting, then fits small screens', async () => {
    const f = supervisorFixture(5), cfg = { openDashboards: true, dashboardLayout: 'auto' }, state = { opened: new Set() };
    f.ns.ui.windowSize = () => [640, 480];
    for (let tick = 0; tick < 3; tick++) {
        f.api.openDashboard(f.ns, cfg, state, 1, 0);
        f.api.openDashboard(f.ns, cfg, state, 42, 1);
    }
    assert.deepEqual(f.uiCalls, [['open', 1], ['open', 42]], 'layout is deferred');
    await f.clock.runUntil(f.clock.now + 50);
    const sizes = f.uiCalls.filter(c => c[0] === 'resize');
    const positions = f.uiCalls.filter(c => c[0] === 'move');
    assert.equal(sizes.length, 2);
    assert.equal(positions.length, 2);
    for (let i = 0; i < 2; i++) {
        assert.ok(positions[i][1] + sizes[i][1] <= 640);
        assert.ok(positions[i][2] + sizes[i][2] + 40 <= 480);
    }
    assert.ok(positions[0][1] + sizes[0][1] <= positions[1][1]);
});

for (const args of [[], ['--open-dashboards', false, '--dashboard-details', false, '--dashboard-layout', 'none']]) {
    test(`bootstrap round trip preserves dashboard preferences ${JSON.stringify(args)}`, async () => {
        const f = supervisorFixture(5);
        f.ns.args = args;
        await dashboardTicks(f, 1);
        const raw = f.files.get('data/supervisor-bootstrap.json');
        assert.deepEqual(JSON.parse(raw), { version: 2, args, updatedAt: 1000000 });
        const restored = supervisorFixture(5), bootstrap = loadScript('bootstrap.js', restored.clock);
        await bootstrap.main({ getHostname: () => 'home', read: () => raw, tprint() {},
            spawn: (file, opts, ...saved) => { assert.equal(file, 'supervisor.js'); restored.ns.args = saved; } });
        await dashboardTicks(restored, 1);
        assert.deepEqual(restored.ns.args, args);
        assert.equal(restored.uiCalls.filter(c => c[0] === 'open').length, args.length ? 0 : 2);
        const daemon = restored.launches.find(p => p.filename === 'daemon.js');
        assert.equal(daemon.args[daemon.args.indexOf('--dashboard-details') + 1], args.length === 0);
    });
}

test('legacy saved arguments lacking UI flags receive current dashboard defaults', async () => {
    const f = supervisorFixture(5), bootstrap = loadScript('bootstrap.js', f.clock);
    await bootstrap.main({ getHostname: () => 'home', read: () => JSON.stringify({ version: 1, args: ['--profile', 'observe'] }),
        tprint() {}, spawn: (file, opts, ...args) => { f.ns.args = args; } });
    await dashboardTicks(f, 1);
    assert.equal(f.uiCalls.filter(c => c[0] === 'open').length, 2);
    const daemon = f.launches.find(p => p.filename === 'daemon.js');
    assert.equal(daemon.args[daemon.args.indexOf('--dashboard-details') + 1], true);
});
