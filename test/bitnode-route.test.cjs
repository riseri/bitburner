const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

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

test('route selects BN4 for the first two completions and never invents the node after BN4.3', () => {
    const f = fixture();
    for (const [level, next] of [[0, 4], [1, 4], [2, null], [3, null]]) {
        f.reset.ownedSF.set(4, level); assert.equal(f.policy.nextRouteNode(f.reset), next);
    }
    f.reset.currentNode = 5; f.reset.ownedSF.delete(4);
    assert.equal(f.policy.nextRouteNode(f.reset), null);
    assert.deepEqual([...f.policy.routeCities([])], ['Sector-12', 'Aevum']);
    assert.deepEqual([...f.policy.routeCities(['Chongqing'])], ['Chongqing', 'New Tokyo', 'Ishima']);
    assert.deepEqual([...f.policy.routeCities(['Volhaven'])], ['Volhaven']);
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

test('faction backdoors preempt owned faction or class work but preserve manual work', async () => {
    for (const kind of ['faction', 'class', 'manual']) {
        const f = fixture(); f.world.readyBackdoor = true;
        if (kind === 'faction') { f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' }; f.world.work = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' }; }
        else { f.world.work = { type: 'CLASS', location: 'Rothman University', classType: 'Computer Science' }; if (kind === 'class') f.state.ownedClass = { ...f.world.work }; }
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'BACKDOOR');
        assert.equal(f.world.work === null, kind !== 'manual');
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

test('early INT farming requires a persistent invitation, empty augmentation run and one attempt per node', () => {
    const f = fixture(); f.world.int = 1;
    assert.equal(f.actions.routeIntelligence(f.ns, f.state, [], [], []), null);
    assert.equal(f.actions.routeIntelligence(f.ns, f.state, [], [], ['Shadows of Anarchy']).phase, 'INT');
    assert.equal(f.world.calls.filter(c => c[0] === 'run').length, 1);
    assert.equal(f.actions.routeIntelligence(f.ns, f.state, ['BitWire'], [], ['Shadows of Anarchy']), null);
    f.world.files.set('data/intelligence-auto.json', JSON.stringify({ nodeReset: 1 }));
    assert.equal(f.actions.routeIntelligence(f.ns, f.state, [], [], ['Shadows of Anarchy']), null);
});

test('INT handoff validates prerequisites before stopping owners, and does not repeat after completion', async () => {
    const f = fixture(), killed = [], spawned = [];
    f.world.int = 1; f.world.invites = ['Shadows of Anarchy'];
    f.world.scripts = [{ pid: 10, filename: 'augmentation-manager.js' }, { pid: 2, filename: 'supervisor.js' }];
    f.ns.pid = 99; f.ns.args = [JSON.stringify({ ownerPid: 10, resetEpoch: '4:1:1000000', createdAt: f.clock.now })];
    f.ns.kill = id => { killed.push(id); return true; }; f.ns.spawn = (...args) => spawned.push(args);
    const handoff = loadScript('intelligence-handoff.js', f.clock);
    f.world.pending = ['BitWire']; await handoff.main(f.ns); assert.equal(killed.length, 0);
    f.world.pending = []; await handoff.main(f.ns);
    assert.deepEqual(killed, [10, 2]); assert.equal(spawned[0][0], 'intelligence-farm.js');
    await handoff.main(f.ns); assert.equal(spawned.length, 1);
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


test('a manually completed INT budget is not automatically renewed by the route controller', () => {
    const f = fixture(); f.world.int = 1;
    f.world.files.set('data/intelligence-session.json', JSON.stringify({ version: 1, node: 4, nodeReset: 1,
        active: false, startedAt: 1, deadline: 1000, target: 50, startExp: 0, startInt: 1, resets: 3 }));
    assert.equal(f.actions.routeIntelligence(f.ns, f.state, [], [], ['Shadows of Anarchy']), null);
    assert.equal(f.world.calls.length, 0);
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

test('route helper files and RAM are excluded outside the planned BN4 runs', () => {
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
