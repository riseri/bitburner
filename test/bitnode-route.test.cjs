const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function economicFixture() {
    const f = fixture();
    f.world.pending = ['A', 'B', 'C']; f.world.rep = 1000;
    f.world.scripts.push({ filename: 'daemon.js', pid: 20 });
    f.cfg.joinFactions = false; f.cfg.programCreation = false;
    const getPlayer = f.ns.getPlayer;
    f.ns.getPlayer = () => ({ ...getPlayer(), exp: { hacking: 10000, intelligence: 0 } });
    f.ns.fileExists = name => ['Formulas.exe', 'bootstrap.js'].includes(name);
    f.ns.formulas = { work: { factionGains: () => ({ reputation: 2.5 }) } };
    f.ns.singularity.getAugmentationStats = name => ({ faction_rep: name === 'BitWire' ? 1.1 : 1.6 });
    f.ns.singularity.getAugmentationRepReq = () => 9000;
    f.ns.getPortHandle = () => ({ peek: () => ({ type: 'jit-status', version: 2, pid: 20, generatedAt: f.clock.now,
        income60: 1000, pipelines: [{ mode: 'LIVE' }], prepRam: 0, policy: { balance: {
            generatedAt: f.clock.now, milestone: 'AUGMENTATIONS', requiredHacking: null, requiredCash: 1000,
            cashSource: 'measured', cashRate: 1000, xpSource: 'measured', xpRate: 100 } } }) });
    f.state.recoveryProfile = { nodeReset: 1, samples: [100000, 500000].map(at => ({ at, ms: 90000,
        income: 1000, cash: 1e9, xp: 10000, hacking: 600, reputation: { CyberSec: 1000 } })) };
    return f;
}

for (const node of [4, 5]) test(`BN${node} economics installs three strong queued augmentations through the existing safe bootstrap path`, async () => {
    const f = economicFixture(); let status;
    if (node === 5) {
        f.reset.currentNode = node; f.reset.ownedSF.set(4, 3);
        f.state.resetEpoch = `5:${f.reset.lastNodeReset}:${f.reset.lastAugReset}`;
    }
    for (let i = 0; i <= 12; i++) {
        status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        if (i < 12) { assert.equal(status.resetDecision.action, 'WAIT'); f.clock.now += 5000; }
    }
    assert.equal(status.resetDecision.action, 'INSTALL'); assert.equal(status.state, 'RESETTING');
    assert.equal(f.world.calls.filter(c => c[0] === 'install').length, 1);
    const persisted = JSON.parse(f.world.files.get('data/augmentation-loop-state.json'));
    assert.equal(persisted.resetDecision.action, 'INSTALL'); assert.equal(persisted.recoveryBaseline.income, 1000);
    assert.match(status.progression.installDecision, /INSTALL: break-even/);
});

test('economic INSTALL remains visible when bootstrap, saved settings, manual work or busy execution blocks it', async () => {
    for (const reason of ['bootstrap', 'settings', 'manual', 'busy', 'epoch', 'new-activity']) {
        const f = economicFixture(); let status;
        for (let i = 0; i < 12; i++) { await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state); f.clock.now += 5000; }
        if (reason === 'bootstrap') f.ns.fileExists = name => name === 'Formulas.exe';
        if (reason === 'settings') f.world.files.set('data/supervisor-bootstrap.json', '{}');
        if (reason === 'manual') { f.world.work = { type: 'CRIME' }; f.world.calls.length = 0; }
        if (reason === 'busy') { f.world.work = null; f.ns.singularity.isBusy = () => true; }
        if (reason === 'epoch') f.ns.write = async () => { f.reset.lastAugReset++; };
        if (reason === 'new-activity') f.ns.write = async () => { f.world.work = { type: 'CRIME' }; };
        status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.resetDecision.action, 'INSTALL', reason); assert.equal(status.state, 'BLOCKED', reason);
        assert.equal(f.world.calls.filter(c => c[0] === 'install').length, 0, reason);
        if (reason === 'manual') assert.equal(f.world.calls.filter(c => c[0] === 'stop').length, 0);
    }
});

test('auto can wait beyond five while threshold mode resets and uncertain auto evidence falls back', async () => {
    for (const mode of ['auto', 'threshold', 'missing-recovery', 'forged-producer']) {
        const f = economicFixture(); f.world.pending.push('D', 'E'); f.cfg.resetPolicy = mode === 'threshold' ? mode : 'auto';
        f.ns.singularity.getAugmentationRepReq = () => 1450; // 45 seconds to purchase
        if (mode === 'missing-recovery') f.state.recoveryProfile.samples = [];
        if (mode === 'forged-producer') f.world.scripts[0].filename = 'manual.js';
        // Legacy short-wait grace has expired; economics may still choose WAIT.
        f.state.progress = { key: 'BitWire', since: f.clock.now - 180000, lastProgressAt: f.clock.now,
            cash: f.world.cash, rep: f.world.rep, owned: 5, level: f.world.hacking };
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        if (mode === 'auto') {
            assert.equal(status.resetDecision.action, 'WAIT'); assert.notEqual(status.state, 'RESETTING');
        } else {
            assert.equal(status.resetDecision.action, 'FALLBACK', mode); assert.equal(status.state, 'RESETTING', mode);
        }
    }
});

test('Daedalus count crossing installs before invitation handling even below the fallback threshold', async () => {
    const f = fixture(); f.world.installed = Array.from({ length: 29 }, (_, i) => 'Old' + i);
    f.world.pending = ['A', 'B']; f.world.invites = ['NiteSec'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING'); assert.match(status.resetDecision.reason, /Daedalus/);
    assert.equal(f.world.calls.filter(c => c[0] === 'join').length, 0);
});

function fixture() {
    const clock = new Clock();
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: clock.now, ownedSF: new Map([[5, 1]]) };
    const world = { cash: 1e9, city: 'Sector-12', hacking: 500, int: 50, factions: ['CyberSec'],
        installed: [], pending: [], invites: [], work: null, rep: 100, readyBackdoor: false,
        catalog: { CyberSec: ['BitWire'], 'Tian Di Hui': ['FocusWire'], 'Sector-12': [], Aevum: [] },
        scripts: [], calls: [], files: new Map([['data/supervisor-bootstrap.json', '{"version":2,"args":[]}']]) };
    const ns = { pid: 10, getResetInfo: () => reset, getHostname: () => 'home',
        getPlayer: () => ({ city: world.city, factions: [...world.factions], skills: { hacking: world.hacking, intelligence: world.int }, exp: { intelligence: 0 } }),
        getServerMoneyAvailable: () => world.cash, getHackingLevel: () => world.hacking,
        serverExists: h => h === 'CSEC' && world.readyBackdoor, hasRootAccess: () => true,
        getServer: () => ({ backdoorInstalled: false }), getServerRequiredHackingLevel: () => 50,
        read: file => world.files.get(file) || '', write: async (file, content) => world.files.set(file, content),
        fileExists: file => file === 'bootstrap.js', getScriptRam: () => 40, getServerMaxRam: () => 1024, getServerUsedRam: () => 100,
        ps: () => world.scripts, run: (...args) => { world.calls.push(['run', ...args]); return 99; }, tprint: msg => world.calls.push(['log', msg]),
        getFavorToDonate: () => 150, hasTorRouter: () => true,
        singularity: {
            getOwnedAugmentations: pending => pending ? [...world.installed, ...world.pending] : [...world.installed],
            checkFactionInvitations: () => world.invites,
            joinFaction: faction => { world.factions.push(faction); world.invites = world.invites.filter(f => f !== faction); world.calls.push(['join', faction]); return true; },
            getCurrentWork: () => world.work, isBusy: () => !!world.work,
            stopAction: () => { world.calls.push(['stop']); world.work = null; return true; },
            getFactionRep: () => world.rep, getFactionFavor: () => 0,
            getAugmentationsFromFaction: f => world.catalog[f] || [], getAugmentationRepReq: () => 100,
            getAugmentationPrice: () => 1000, getAugmentationPrereq: () => [], getAugmentationStats: () => ({ hacking: 1.1 }),
            getFactionWorkTypes: () => ['hacking'], isFocused: () => false,
            workForFaction: (faction, type) => { world.work = { type: 'FACTION', factionName: faction, factionWorkType: type }; world.calls.push(['work', faction]); return true; },
            purchaseAugmentation: (f, a) => { world.pending.push(a); world.calls.push(['buy', a]); return true; },
            installAugmentations: cb => { world.calls.push(['install', cb]); },
            travelToCity: city => { world.cash -= 200000; world.city = city; world.calls.push(['travel', city]); return true; },
            universityCourse: (location, classType) => { world.work = { type: 'CLASS', location, classType }; world.calls.push(['study', location]); return true; },
        } };
    const cfg = { route: true, focus: 'hacking', target: '', cashReserve: .1, minInstall: 5,
        joinFactions: true, cityFaction: '', work: true, donate: true, purchase: true, focusWork: false };
    return { clock, reset, world, ns, cfg, state: { resetEpoch: '4:1:1000000', ownedWork: null },
        api: loadScript('augmentation-manager.js', clock), actions: loadScript('lib/route-actions.js', clock),
        policy: loadScript('lib/bitnode-route.js', clock) };
}

function bn5Fixture() {
    const f = fixture();
    f.reset.currentNode = 5; f.reset.ownedSF.set(4, 3);
    f.state.resetEpoch = `5:${f.reset.lastNodeReset}:${f.reset.lastAugReset}`;
    f.cfg.resetPolicy = 'auto';
    return f;
}

test('the reported BN5 20-hour stall installs four queued augmentations after its reachable basket is exhausted', async () => {
    const f = bn5Fixture();
    f.world.cash = 176.03e12;
    f.world.installed = Array.from({ length: 21 }, (_, i) => 'Installed' + i);
    f.world.pending = ['Queued A', 'Queued B', 'Queued C', 'Queued D'];
    f.world.catalog.CyberSec = [...f.world.installed, ...f.world.pending];
    f.state.queuedSince = f.clock.now;
    f.clock.now += 20 * 60 * 60 * 1000;
    await f.api.saveState(f.ns, f.state);
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.api.loadState(f.ns));
    assert.equal(status.state, 'RESETTING');
    assert.equal(status.queued, 4);
    assert.equal(status.progression.installedCount, 21);
    assert.equal(status.progression.queuedDistinct.length, 4);
    assert.match(status.resetDecision.reason, /batch is complete/);
    assert.equal(status.progression.resetImminent, true);
    assert.deepEqual(f.world.calls.filter(c => c[0] === 'install'), [['install', 'bootstrap.js']]);
});

test('BN5 keeps advancing after a short reset by joining another faction and installing count fillers for Daedalus', async () => {
    const f = bn5Fixture();
    f.world.installed = Array.from({ length: 21 }, (_, i) => 'Installed' + i);
    f.world.pending = ['A', 'B', 'C', 'D'];
    f.world.catalog = { CyberSec: [...f.world.installed, ...f.world.pending],
        'Tian Di Hui': Array.from({ length: 5 }, (_, i) => 'Count filler ' + i) };
    f.ns.singularity.getAugmentationStats = name => name.startsWith('Count filler') ? { strength: 1.1 } : { hacking: 1.1 };
    const reset = async () => {
        f.world.installed.push(...f.world.pending); f.world.pending = [];
        f.world.factions = []; f.world.work = null;
        f.reset.lastAugReset = ++f.clock.now;
        await f.api.saveState(f.ns, f.state);
        f.state = f.api.loadState(f.ns);
    };
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).state, 'RESETTING');
    await reset();
    let status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'TRAVEL');
    assert.equal(f.world.city, 'Chongqing');
    f.world.invites = ['Tian Di Hui'];
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'JOIN');
    for (let i = 0; i < 5; i++) {
        status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'PURCHASE');
    }
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.match(status.resetDecision.reason, /Daedalus/);
    assert.equal(status.progression.ownedCount, 30);
    await reset();
    f.world.hacking = 2500; f.world.cash = 100e9;
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'DAEDALUS');
    assert.equal(status.savings.target, 'faction:Daedalus');
    assert.equal(status.progression.installedCount, 30);
    f.world.invites = ['Daedalus'];
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'JOIN');
    assert.ok(f.world.factions.includes('Daedalus'));
    assert.equal(f.world.calls.filter(c => c[0] === 'run').length, 0, 'BN5 never launches a node transition or INT helper');
});

test('BN5 applies the absolute queue wait limit despite a fresh objective and unavailable economic evidence', async () => {
    const f = bn5Fixture();
    f.world.pending = ['A', 'B', 'C', 'D']; f.cfg.joinFactions = false;
    f.state.queuedSince = f.clock.now;
    f.clock.now += 20 * 60 * 60 * 1000;
    f.ns.singularity.getAugmentationRepReq = () => 1e9;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.equal(status.resetDecision.fallback.waitingMs, 0);
    assert.match(status.resetDecision.reason, /60-minute absolute/);
});

test('BN5 short-batch resets retain bootstrap, manual activity, busy action and reset-epoch checks', async () => {
    for (const reason of ['bootstrap', 'settings', 'manual', 'busy', 'epoch', 'new-activity']) {
        const f = bn5Fixture();
        f.world.pending = ['A', 'B', 'C', 'D']; f.world.catalog.CyberSec = [];
        if (reason === 'bootstrap') f.ns.fileExists = () => false;
        if (reason === 'settings') f.world.files.set('data/supervisor-bootstrap.json', '{}');
        if (reason === 'manual') f.world.work = { type: 'CRIME' };
        if (reason === 'busy') f.ns.singularity.isBusy = () => true;
        if (reason === 'epoch') f.ns.write = async () => { f.reset.lastAugReset++; };
        if (reason === 'new-activity') f.ns.write = async () => { f.world.work = { type: 'CRIME' }; };
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.resetDecision.action, 'INSTALL', reason);
        assert.equal(status.state, 'BLOCKED', reason);
        assert.equal(f.world.calls.filter(c => c[0] === 'install').length, 0, reason);
        if (reason === 'manual') assert.equal(f.world.calls.filter(c => c[0] === 'stop').length, 0);
    }
});

test('BN5 progression protects empty queues, unavailable SF4 and an explicit route opt-out', async () => {
    for (const reason of ['empty', 'locked', 'disabled']) {
        const f = bn5Fixture(); f.world.catalog = {};
        if (reason === 'locked') {
            f.reset.ownedSF.delete(4);
            f.ns.singularity = new Proxy({}, { get() { throw Error('Singularity unavailable'); } });
        }
        if (reason === 'disabled') { f.cfg.route = false; f.world.pending = ['A', 'B', 'C', 'D']; }
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.notEqual(status.state, 'RESETTING', reason);
        assert.equal(f.world.calls.filter(c => ['install', 'travel', 'join'].includes(c[0])).length, 0, reason);
        if (reason === 'empty') assert.equal(status.progression.resetImminent, false);
        if (reason === 'locked') assert.equal(status.phase, 'UNLOCK');
        if (reason === 'disabled') assert.equal(status.phase, 'QUEUE');
    }
});

test('the ready BN5.2 run dispatches BN5.3 with the saved bootstrap instead of stopping at ROUTE_END', async () => {
    const f = bn5Fixture();
    f.world.installed = ['The Red Pill']; f.world.hacking = 9000;
    f.ns.serverExists = host => host === 'w0r1d_d43m0n';
    f.ns.getServerRequiredHackingLevel = () => 9000;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'COMPLETE_NODE');
    assert.match(status.recommendation, /BN5\.3/);
    const launches = f.world.calls.filter(c => c[0] === 'run');
    assert.equal(launches.length, 1);
    assert.equal(launches[0][1], 'node-complete.js');
    assert.equal(JSON.parse(launches[0][3]).nextNode, 5);
});

test('every BitNode repeats through its third run and does not invent a destination beyond it', () => {
    const f = fixture();
    for (const node of [...Array.from({ length: 15 }, (_, i) => i + 1), 100]) {
        f.reset.currentNode = node;
        for (const [level, next] of [[0, node], [1, node], [2, null], [3, null]]) {
            f.reset.ownedSF.set(node, level); assert.equal(f.policy.nextRouteNode(f.reset), next);
        }
    }
    f.reset.currentNode = 0;
    assert.equal(f.policy.nextRouteNode(f.reset), null);
    assert.deepEqual([...f.policy.routeCities([])], ['Sector-12', 'Aevum']);
    assert.deepEqual([...f.policy.routeCities(['Chongqing'])], ['Chongqing', 'New Tokyo', 'Ishima']);
    assert.deepEqual([...f.policy.routeCities(['Volhaven'])], ['Volhaven']);
});

test('invalid BitNode numbers and Source-File levels cannot authorize a reset', () => {
    const f = fixture();
    for (const node of [0, -1, 1.5, NaN, '5']) {
        f.reset.currentNode = node; assert.equal(f.policy.nextRouteNode(f.reset), null);
    }
    f.reset.currentNode = 5;
    for (const level of [-1, 1.5, NaN]) {
        f.reset.ownedSF.set(5, level); assert.equal(f.policy.nextRouteNode(f.reset), null);
    }
});

for (let node = 1; node <= 15; node++) test(`BN${node}.1 -> BN${node}.2 -> BN${node}.3 restores automation and waits at the final exit`, async () => {
    const f = fixture(), transitions = [];
    f.reset.currentNode = node; f.reset.ownedSF.set(4, 3);
    f.ns.serverExists = host => host === 'w0r1d_d43m0n'; f.ns.getServerRequiredHackingLevel = () => 9000;
    f.ns.getScriptRam = () => 7.8;
    f.ns.singularity.destroyW0r1dD43m0n = (...args) => transitions.push(args);
    for (const level of [0, 1]) {
        f.reset.ownedSF.set(node, level); f.reset.lastNodeReset = ++f.clock.now; f.reset.lastAugReset = f.clock.now;
        f.ns.pid = 10; f.ns.fileExists = file => file === 'bootstrap.js';
        f.world.work = null; f.world.installed = []; f.world.calls.length = 0;
        const fresh = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.notEqual(fresh.phase, 'COMPLETE_NODE', 'the restarted run must earn its own completion');
        assert.equal(f.world.calls.filter(c => c[0] === 'run' && c[1] === 'node-complete.js').length, 0);
        f.world.installed = ['The Red Pill']; f.world.hacking = 9000;
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'COMPLETE_NODE'); assert.match(status.recommendation, new RegExp(`BN${node}\\.${level + 2}`));
        const launch = f.world.calls.find(c => c[0] === 'run' && c[1] === 'node-complete.js');
        assert.equal(JSON.parse(launch[3]).nextNode, node);
        f.ns.args = [launch[3]]; f.ns.pid = 99;
        f.world.scripts = [{ pid: 10, filename: 'augmentation-manager.js' }]; f.ns.fileExists = () => true;
        await loadScript('node-complete.js', f.clock).main(f.ns);
        assert.equal(transitions.length, level + 1);
    }
    assert.deepEqual(transitions, [[node, 'bootstrap.js'], [node, 'bootstrap.js']]);
    f.reset.ownedSF.set(node, 2);
    await loadScript('node-complete.js', f.clock).main(f.ns);
    assert.equal(transitions.length, 2, 'the same actor cannot cross the third-run route boundary');
    f.ns.pid = 10; f.ns.fileExists = file => file === 'bootstrap.js'; f.world.calls.length = 0;
    const final = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(final.phase, 'ROUTE_END'); assert.match(final.recommendation, /choose the next BitNode manually/);
    assert.equal(f.world.calls.filter(c => c[0] === 'run').length, 0);
});

test('installation policy handles short batches, Daedalus counts, bounded waits, and avoids empty resets', () => {
    const f = fixture(), input = { installed: [], pending: ['A'], plan: { next: null, errors: [] }, money: 1e6, minInstall: 5, lastAugReset: f.clock.now };
    assert.match(f.policy.routeInstallation(input), /batch is complete/);
    input.pending = []; assert.equal(f.policy.routeInstallation(input), '');
    input.installed = Array.from({ length: 29 }, (_, i) => `A${i}`); input.pending = ['B'];
    assert.match(f.policy.routeInstallation(input), /Daedalus/);
    input.installed = []; input.plan.next = { price: 1e9, repGap: 0 };
    assert.equal(f.policy.routeInstallation(input), '');
    f.clock.now += 1800000; assert.match(f.policy.routeInstallation(input), /30 minutes/);
});

test('route travels for useful factions, joins, earns reputation, buys, and installs a short batch', async () => {
    const f = fixture();
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'TRAVEL');
    assert.equal(f.world.city, 'Chongqing');
    f.world.invites = ['Tian Di Hui'];
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'JOIN');
    f.world.rep = 0;
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'REPUTATION');
    f.world.rep = 100;
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'PURCHASE');
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'PURCHASE');
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).state, 'RESETTING');
    assert.equal(f.world.pending.length, 2);
    assert.ok(f.world.calls.some(c => c[0] === 'stop'));
});

test('faction backdoors preserve both managed and manual work while the actor installs', async () => {
    for (const kind of ['faction', 'class', 'manual']) {
        const f = fixture(); f.world.readyBackdoor = true;
        if (kind === 'faction') { f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' }; f.world.work = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' }; }
        else { f.world.work = { type: 'CLASS', location: 'Rothman University', classType: 'Computer Science' }; if (kind === 'class') f.state.ownedClass = { ...f.world.work }; }
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'BACKDOOR');
        assert.notEqual(f.world.work, null);
        assert.equal(f.world.calls.some(c => c[0] === 'stop'), false);
        assert.equal(f.world.calls.some(c => c[0] === 'buy'), false);
    }
});

test('30 installed augmentations and sufficient hacking focus the controller on Daedalus cash', async () => {
    const f = fixture(); f.world.installed = Array.from({ length: 30 }, (_, i) => `A${i}`); f.world.hacking = 2500;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'DAEDALUS'); assert.equal(status.savings.amount, 100e9);
    f.world.invites = ['Aevum', 'Daedalus'];
    await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.deepEqual(f.world.calls.at(-1), ['join', 'Daedalus']);
});

test('route trains hacking when no purchases or faction unlocks are available, then yields to reputation', async () => {
    const f = fixture(); f.world.catalog = {};
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'HACKING');
    assert.ok(f.state.ownedClass);
    f.world.catalog.CyberSec = ['BitWire']; f.world.rep = 0;
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).phase, 'REPUTATION');
    assert.equal(f.state.ownedClass, null);
});

test('endgame trains to the live requirement, dispatches only the planned node, and stops at the route boundary', () => {
    const f = fixture(); f.ns.serverExists = () => true; f.ns.getServerRequiredHackingLevel = () => 3000;
    assert.equal(f.actions.routeEndgame(f.ns, f.cfg, f.state).phase, 'HACKING');
    f.world.hacking = 3000;
    assert.equal(f.actions.routeEndgame(f.ns, f.cfg, f.state).phase, 'COMPLETE_NODE');
    const launch = f.world.calls.find(c => c[0] === 'run');
    assert.equal(JSON.parse(launch[3]).nextNode, 4);
    f.reset.ownedSF.set(4, 2);
    assert.equal(f.actions.routeEndgame(f.ns, f.cfg, f.state).phase, 'ROUTE_END');
    assert.equal(f.world.calls.filter(c => c[0] === 'run').length, 1);
});

test('node transition actor revalidates epoch, route boundary, ownership, manual work and callback RAM', async () => {
    for (const reason of ['ok', 'stale', 'final', 'owner', 'busy', 'pill', 'ram', 'settings']) {
        const f = fixture(), calls = [];
        f.ns.args = [JSON.stringify({ ownerPid: 10, nextNode: 4, resetEpoch: '4:1:1000000', createdAt: f.clock.now })];
        f.world.installed = ['The Red Pill']; f.world.scripts = [{ pid: 10, filename: 'augmentation-manager.js' }];
        f.ns.pid = 99; f.ns.serverExists = () => true; f.ns.fileExists = () => true; f.ns.getScriptRam = () => 7.8;
        f.ns.singularity.destroyW0r1dD43m0n = (...args) => calls.push(args);
        if (reason === 'stale') f.clock.now += 30001;
        if (reason === 'final') f.reset.ownedSF.set(4, 2);
        if (reason === 'owner') f.world.scripts = [];
        if (reason === 'busy') f.world.work = { type: 'CRIME' };
        if (reason === 'pill') f.world.installed = [];
        if (reason === 'ram') f.ns.getScriptRam = () => 9;
        if (reason === 'settings') f.world.files.clear();
        await loadScript('node-complete.js', f.clock).main(f.ns);
        assert.equal(calls.length, reason === 'ok' ? 1 : 0, reason);
        if (calls.length) assert.deepEqual(calls[0], [4, 'bootstrap.js']);
    }
});

test('BN5 transition revalidates the requested destination, route boundary and Singularity capability', async () => {
    for (const reason of ['ok', 'wrong-node', 'final', 'epoch', 'owner', 'busy', 'locked', 'duplicate']) {
        const f = bn5Fixture(), calls = [];
        f.ns.args = [JSON.stringify({ ownerPid: 10, nextNode: reason === 'wrong-node' ? 4 : 5,
            resetEpoch: f.state.resetEpoch, createdAt: f.clock.now })];
        f.world.installed = ['The Red Pill']; f.world.scripts = [{ pid: 10, filename: 'augmentation-manager.js' }];
        f.ns.pid = 99; f.ns.serverExists = () => true; f.ns.fileExists = () => true; f.ns.getScriptRam = () => 7.8;
        f.ns.singularity.destroyW0r1dD43m0n = (...args) => calls.push(args);
        if (reason === 'final') f.reset.ownedSF.set(5, 2);
        if (reason === 'epoch') f.reset.lastAugReset++;
        if (reason === 'owner') f.world.scripts = [];
        if (reason === 'busy') f.world.work = { type: 'CRIME' };
        if (reason === 'locked') {
            f.reset.ownedSF.delete(4);
            f.ns.singularity = new Proxy({}, { get() { assert.fail('locked Singularity must not be accessed'); } });
        }
        if (reason === 'duplicate') f.world.scripts.push({ pid: 98, filename: 'node-complete.js' });
        await loadScript('node-complete.js', f.clock).main(f.ns);
        assert.equal(calls.length, reason === 'ok' ? 1 : 0, reason);
        if (calls.length) assert.deepEqual(calls[0], [5, 'bootstrap.js']);
    }
});

test('callback RAM includes Source-File rewards from the completion being performed', async () => {
    for (const [node, level, ram, allowed] of [[1, 0, 31, true], [1, 0, 33, false], [9, 1, 127, true], [9, 1, 129, false]]) {
        const f = bn5Fixture(), calls = [];
        f.reset.currentNode = node; f.reset.ownedSF.set(node, level);
        f.ns.args = [JSON.stringify({ ownerPid: 10, nextNode: node,
            resetEpoch: `${node}:${f.reset.lastNodeReset}:${f.reset.lastAugReset}`, createdAt: f.clock.now })];
        f.world.installed = ['The Red Pill']; f.world.scripts = [{ pid: 10, filename: 'augmentation-manager.js' }];
        f.ns.pid = 99; f.ns.serverExists = () => true; f.ns.fileExists = () => true; f.ns.getScriptRam = () => ram;
        f.ns.singularity.destroyW0r1dD43m0n = (...args) => calls.push(args);
        await loadScript('node-complete.js', f.clock).main(f.ns);
        assert.equal(calls.length, allowed ? 1 : 0, `BN${node}.${level + 1}, ${ram} GB callback`);
    }
});

test('early BN4 progression continues normally; INT farming waits for an augmentation installation', async () => {
    const f = fixture(); f.world.int = 1; f.world.invites = ['Shadows of Anarchy'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.notEqual(status.phase, 'INT');
    assert.equal(f.world.calls.filter(c => c[0] === 'run' && c[1] === 'intelligence-handoff.js').length, 0);
    assert.equal(f.world.files.has('data/intelligence-auto.json'), false);
});

test('route augmentation candidates include count fillers and skip inaccessible prerequisites', () => {
    const f = fixture(); f.world.catalog.CyberSec = ['Hacking', 'Combat', 'Unavailable'];
    f.ns.singularity.getAugmentationStats = n => n === 'Hacking' ? { hacking: 1.1 } : { strength: 1.1 };
    f.ns.singularity.getAugmentationPrereq = n => n === 'Unavailable' ? ['Unjoined faction prerequisite'] : [];
    const api = loadScript('lib/augmentation-plan.js', f.clock);
    const plan = api.buildAugmentationPlan(f.ns, { route: true });
    assert.equal(plan.errors.length, 0);
    assert.deepEqual([...plan.order.map(a => a.name)], ['Hacking', 'Combat']);
    f.world.installed = Array.from({ length: 30 }, (_, i) => `A${i}`);
    assert.deepEqual([...api.buildAugmentationPlan(f.ns, { route: true }).order.map(a => a.name)], ['Hacking']);
});


test('a manually completed INT budget is not automatically renewed at installation', async () => {
    const f = fixture(); f.world.int = 1;
    f.world.files.set('data/intelligence-session.json', JSON.stringify({ version: 1, node: 4, nodeReset: 1,
        active: false, startedAt: 1, deadline: 1000, target: 50, startExp: 0, startInt: 1, resets: 3 }));
    f.world.invites = ['Shadows of Anarchy']; f.world.pending = ['A', 'B', 'C', 'D', 'E'];
    const status = await f.api.handleInstallation(f.ns, f.cfg, f.state, null, 5);
    assert.equal(status.state, 'RESETTING');
    assert.deepEqual(f.world.calls.filter(c => c[0] === 'install'), [['install', 'bootstrap.js']]);
});

test('route helpers reclaim optional service RAM without stopping the income engine or unrelated scripts', () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    const services = [{ name: 'daemon.js', pid: 1 }, { name: 'augmentation-manager.js', port: 11, pid: 10 }, { name: 'stock-trader.js', pid: 20 }];
    f.world.scripts = [{ filename: 'daemon.js', pid: 1 }, { filename: 'augmentation-manager.js', pid: 10 },
        { filename: 'stock-trader.js', pid: 20 }, { filename: 'manual.js', pid: 30 }];
    const costs = { 'daemon.js': 40, 'augmentation-manager.js': 60, 'stock-trader.js': 30, 'manual.js': 20, 'node-complete.js': 40 };
    const status = { type: 'augmentation-status', producerPid: 10, resetEpoch: '4:1:1000000', generatedAt: f.clock.now,
        state: 'WAITING_RAM', phase: 'COMPLETE_NODE' };
    f.ns.getPortHandle = () => ({ peek: () => status });
    f.ns.getScriptRam = file => costs[file] || 0;
    f.ns.getServerMaxRam = () => 160;
    f.ns.getServerUsedRam = () => f.world.scripts.reduce((sum, p) => sum + costs[p.filename], 0);
    f.ns.kill = pid => { f.world.scripts = f.world.scripts.filter(p => p.pid !== pid); return true; };
    const admitted = supervisor.reserveRouteHelper(f.ns, services, services);
    assert.deepEqual([...admitted.map(s => s.name)], ['daemon.js', 'augmentation-manager.js']);
    assert.deepEqual(f.world.scripts.map(p => p.pid), [1, 10, 30]);
    status.generatedAt -= 15001;
    assert.equal(supervisor.reserveRouteHelper(f.ns, services, services), services);
});

test('route helper files and RAM are excluded outside authorized transition routes', () => {
    const catalog = loadScript('lib/service-catalog.js', new Clock()), cfg = catalog.supervisorServiceConfig();
    const costs = [];
    const ns = { getScriptRam: file => { costs.push(file); return file === 'node-complete.js' ? 80 : 1; } };
    const capabilities = { singularity: true, route: false, darknet: false, stocks: false };
    assert.ok(!catalog.supervisorFiles(cfg, capabilities).includes('node-complete.js'));
    catalog.supervisorRamBudget(ns, cfg, capabilities);
    assert.ok(!costs.includes('node-complete.js'));
    capabilities.route = true;
    assert.ok(catalog.supervisorFiles(cfg, capabilities).includes('node-complete.js'));
    assert.equal(catalog.supervisorRamBudget(ns, cfg, capabilities).utilityRam, 80);
});
