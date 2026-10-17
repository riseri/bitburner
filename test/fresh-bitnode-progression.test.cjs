const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture(node = 4) {
    const clock = new Clock(80_000_000), ports = new Map(), files = new Map(), processes = new Map(), launches = [], purchases = [], copies = [];
    const reset = { currentNode: node, lastNodeReset: 21_366_000, lastAugReset: 21_366_000, ownedSF: new Map([[1, 3], [4, node === 4 ? 2 : 3], [5, 1]]) };
    const hosts = { home: { ram: 128, ports: 0 }, core: { ram: 64, ports: 0 }, foodnstuff: { ram: 16, ports: 0 },
        n00dles: { ram: 4, ports: 0 }, CSEC: { ram: 8, ports: 1 }, 'neo-net': { ram: 32, ports: 2 }, 'netlink': { ram: 32, ports: 3 } };
    const costs = { 'supervisor.js': 7.7, 'daemon.js': 46.05, 'fleet-manager.js': 10.5, 'progression-manager.js': 6.05,
        'augmentation-manager.js': 112.9, 'contract-manager.js': 24.15, 'go-bot.js': 12,
        'home-upgrade.js': 8.05, 'starter-worker.js': 2.5, 'progression-purchase.js': 8.1, 'progression-backdoor.js': 12.05,
        'darknet-manager.js': 18, 'darknet-agent.js': 16 };
    const cfg = { savingsMode: 'auto', progression: true, progressionActions: true, progressionCashReserve: .1,
        augmentationActions: true, augmentationCashReserve: .1, contracts: true, go: true, darknet: false,
        serviceHosts: { 'daemon.js': 'core', 'fleet-manager.js': 'core', 'progression-manager.js': 'core' },
        homeInvestment: { target: 'home:ram', amount: 100.68e6, priority: 90, label: 'Enabled service/helper RAM is blocked', reason: 'Enabled service/helper RAM is blocked' } };
    const world = { cash: 76.27e6, tor: false, owned: new Set(), installed: new Set(), current: 'home' };
    const catalog = loadScript('lib/programs.js', clock).progressionPrograms();
    const parents = { home: null, core: 'home', foodnstuff: 'home', n00dles: 'home', CSEC: 'n00dles', 'neo-net': 'CSEC', netlink: 'neo-net' };
    let nextPid = 10;
    const add = (filename, host = 'home', threads = 1, args = [], pid = nextPid++) => {
        const p = { filename, host, threads, args, pid }; processes.set(pid, p); return p;
    };
    add('supervisor.js', 'home', 1, [], 1);
    for (const file of Object.keys(cfg.serviceHosts)) add(file, 'core');
    const launch = (filename, host, threads, ...args) => {
        if (!(costs[filename] > 0) || costs[filename] * threads > ns.getServerMaxRam(host) - ns.getServerUsedRam(host) + 1e-8) return 0;
        const p = add(filename, host, threads, args); launches.push(p); return p.pid;
    };
    const ns = { pid: 1, args: [], disableLog() {}, print() {}, getHostname: () => 'home',
        getResetInfo: () => reset, ps: host => [...processes.values()].filter(p => p.host === host),
        scan: host => Object.keys(parents).filter(h => parents[h] === host || parents[host] === h),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        read: file => files.get('home:' + file) || '', write: async (file, value) => files.set('home:' + file, value),
        fileExists: (file, host = 'home') => file.endsWith('.exe') ? world.owned.has(file) : Boolean(costs[file] || files.has(host + ':' + file) || file.startsWith('lib/')),
        getScriptRam: file => costs[file] || 0, getServerMaxRam: host => hosts[host].ram,
        getServerUsedRam: host => ns.ps(host).reduce((n, p) => n + costs[p.filename] * p.threads, 0),
        hasTorRouter: () => world.tor, isRunning: pid => processes.has(pid), getServerMoneyAvailable: () => world.cash,
        getPlayer: () => ({ factions: [], skills: { hacking: 266, intelligence: 101 } }), getHackingLevel: () => 266,
        serverExists: host => Boolean(hosts[host]), getServerRequiredHackingLevel: () => 50,
        hasRootAccess: host => hosts[host].ports <= catalog.filter(p => !p.category && world.owned.has(p.name)).length,
        getServer: host => ({ maxRam: hosts[host].ram, hasAdminRights: ns.hasRootAccess(host),
            numOpenPortsRequired: hosts[host].ports, requiredHackingSkill: 50, backdoorInstalled: world.installed.has(host) }),
        run: (file, threads, ...args) => launch(file, 'home', threads, ...args), exec: launch,
        kill: pid => { throw Error('No services or committed workers should be killed: ' + pid); },
        scp: async (entries, host, from = 'home') => {
            copies.push({ entries, host });
            for (const file of Array.isArray(entries) ? entries : [entries])
                if (files.has(from + ':' + file)) files.set(host + ':' + file, files.get(from + ':' + file));
            return true;
        },
        singularity: { getDarkwebPrograms: () => catalog.map(p => p.name), getDarkwebProgramCost: name => catalog.find(p => p.name === name).cost,
            purchaseTor: () => { purchases.push('TOR'); world.tor = true; world.cash -= 200000; return true; },
            purchaseProgram: name => { purchases.push(name); world.owned.add(name); world.cash -= catalog.find(p => p.name === name).cost; return true; },
            getUpgradeHomeRamCost: () => 100.68e6, upgradeHomeRam: () => { purchases.push('home:ram'); world.cash -= 100.68e6; hosts.home.ram *= 2; return true; },
            isBusy: () => false, getCurrentWork: () => null, getCurrentServer: () => world.current,
            connect: host => { world.current = host; return true; }, installBackdoor: async () => world.installed.add(world.current) },
    };
    const supervisor = loadScript('supervisor.js', clock), utilities = loadScript('lib/supervised-utilities.js', clock),
        dispatcher = loadScript('lib/progression-dispatch.js', clock), planner = loadScript('progression-manager.js', clock), actions = dispatcher.createActionState();
    const services = supervisor.createManagedServices(ns, cfg, []);
    const goal = () => JSON.parse(ns.read('data/savings.json'));
    async function setGoal(target = 'home:ram', amount = 100.68e6, priority = 90, owner = 'supervisor') {
        await loadScript('lib/savings.js', clock).writeSavings(ns, amount, 'Protected goal', target, owner, { priority });
    }
    function plan() {
        const fleet = { type: 'fleet-status', generatedAt: clock.now, network: { parents, servers: Object.keys(hosts) } };
        ns.getPortHandle(19).clear(); ns.getPortHandle(19).write(fleet);
        return planner.buildStatus(ns, fleet, { darknet: cfg.darknet });
    }
    async function runActor(p = launches.at(-1)) {
        await loadScript(p.filename, clock).main({ ...ns, pid: p.pid, args: p.args, getHostname: () => p.host,
            read: file => files.get(p.host + ':' + file) || '' });
        processes.delete(p.pid);
    }
    return { ns, clock, cfg, world, reset, costs, hosts, parents, services, processes, launches, purchases, copies, supervisor, utilities, dispatcher, actions, goal, setGoal, plan, runActor, add };
}

test('reported BN2 bootstrap joins NiteSec and starts the gang while augmentation waits for home RAM', async () => {
    const f = fixture(2); f.world.cash = 11.1e6; f.world.tor = true;
    f.reset.ownedSF.set(2, 1);
    for (const name of ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'Formulas.exe']) f.world.owned.add(name);
    f.costs['progression-join.js'] = 7.6; f.costs['gang-manager.js'] = 32.1;
    f.costs['augmentation-manager.js'] = 114.9;
    f.add('gang-manager.js');
    f.world.installed.add('CSEC');
    f.hosts['avmnite-02h'] = { ram: 32, ports: 2 }; f.world.installed.add('avmnite-02h');
    f.parents['avmnite-02h'] = 'CSEC';
    const factions = ['CyberSec'], joins = [];
    f.ns.getPlayer = () => ({ factions, skills: { hacking: 266 } });
    f.ns.singularity.checkFactionInvitations = () => ['NiteSec'];
    f.ns.singularity.joinFaction = name => { joins.push(name); factions.push(name); return true; };
    await f.setGoal();
    const blocker = f.supervisor.tickServicePriority(f.ns, f.services, '', 0, 12.05);
    assert.match(blocker, /augmentation-manager.js needs 114.90 GB/);
    assert.ok(f.launches.some(p => p.filename === 'contract-manager.js'), 'contracts can fund admission using idle RAM');
    assert.ok(!f.launches.some(p => p.filename === 'augmentation-manager.js'));
    // The planner uses the fleet's installed-backdoor observations.
    const plan = f.plan();
    f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg);
    assert.equal(f.launches.at(-1).filename, 'progression-join.js');
    await f.runActor(); assert.deepEqual(joins, ['NiteSec']);
    let inGang = false;
    f.ns.gang = { inGang: () => inGang, createGang: name => { assert.equal(name, 'NiteSec'); inGang = true; return true; },
        getGangInformation: () => ({ faction: 'NiteSec', isHacking: true, wantedPenalty: 1, respect: 1, wantedLevel: 1 }),
        getMemberNames: () => [], canRecruitMember: () => false, getTaskNames: () => [], getEquipmentNames: () => [] };
    const gang = loadScript('gang-manager.js', f.clock).gangTick(f.ns, { faction: 'auto', budget: .05, interval: 2000 });
    assert.equal(gang.state, 'ACTIVE'); assert.equal(gang.inGang, true);
    assert.equal(f.world.cash, 11.1e6, 'free bootstrap actions do not consume the home savings');
});

test('BN10 blocked services retain contract income, protect actor RAM and recover admission automatically', async () => {
    const f = fixture(10); f.reset.ownedSF.set(2, 1);
    Object.assign(f.cfg, { sleeves: true, sleeveBudget: .02, gangs: true, gangKarma: true });
    Object.assign(f.costs, { 'supervisor.js': 8.2, 'sleeve-manager.js': 42.55, 'gang-manager.js': 31.6, 'progression-join.js': 9.35,
        'augmentation-manager.js': 134.9, 'sleeve-upgrades.js': 35.6 });
    const services = f.supervisor.createManagedServices(f.ns, f.cfg, []);
    const capabilities = { singularity: true, route: true, sleeves: true, gang: true };
    const budget = loadScript('lib/service-catalog.js', f.clock).supervisorRamBudget(f.ns, f.cfg, capabilities);
    assert.equal(budget.actorRam, 12.05);
    const blocker = f.supervisor.tickServicePriority(f.ns, services, '', 0, budget.actorRam);
    assert.match(blocker, /augmentation-manager/);
    for (const file of ['sleeve-manager.js', 'gang-manager.js', 'contract-manager.js']) assert.ok(f.launches.some(p => p.filename === file), file);
    assert.ok(f.ns.getServerMaxRam('home') - f.ns.getServerUsedRam('home') >= budget.actorRam);
    assert.ok(!f.launches.some(p => p.filename === 'sleeve-upgrades.js'));
    f.world.cash = 101e6; await f.setGoal();
    const hosts = loadScript('lib/starter-pool.js', f.clock).starterHosts(f.ns);
    await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities, services, [], f.actions, hosts);
    await f.runActor(); assert.equal(f.hosts.home.ram, 256);
    f.supervisor.tickServicePriority(f.ns, services, '', 0, budget.actorRam);
    assert.ok(f.launches.some(p => p.filename === 'augmentation-manager.js'));
    assert.equal(f.purchases.filter(p => p === 'home:ram').length, 1);
});

test('a contract scan borrows unused RAM even when sleeve admission is the first blocked service', () => {
    const f = fixture(10); f.cfg.sleeves = true;
    f.costs['sleeve-manager.js'] = 42.55;
    f.hosts.home.ram = 64;
    f.costs['manual.js'] = 8; f.add('manual.js');
    const services = f.supervisor.createManagedServices(f.ns, f.cfg, []);
    const blocker = f.supervisor.tickServicePriority(f.ns, services, '', 0, 12.05);
    assert.match(blocker, /sleeve-manager.js/);
    assert.ok(f.launches.some(p => p.filename === 'contract-manager.js'));
    assert.ok(!f.launches.some(p => p.filename === 'sleeve-manager.js'));
});

test('the reported BN5 empty augmentation queue buys TOR and programs, then permits a funded home upgrade', async () => {
    const f = fixture(5), augmentation = loadScript('augmentation-manager.js', f.clock);
    delete f.cfg.homeInvestment;
    f.hosts.home.ram = 256;
    for (const p of f.processes.values()) p.host = 'home';
    const manager = f.add('augmentation-manager.js');
    f.world.cash = 1.35e9; f.world.owned.add('Formulas.exe');
    f.ns.getPlayer = () => ({ factions: [], skills: { hacking: 256, intelligence: 101 } });
    f.ns.getHackingLevel = () => 256;
    f.ns.getServerRequiredHackingLevel = () => 344;
    const installed = ['A', 'B', 'C', 'D', 'E'];
    Object.assign(f.ns.singularity, { getOwnedAugmentations: () => installed, checkFactionInvitations: () => [],
        getAugmentationsFromFaction: () => [] });
    const cfg = { minInstall: 5, route: true, focus: 'hacking', cashReserve: .1, joinFactions: true, interval: 5000 };
    const producer = { ...f.ns, pid: manager.pid };
    const status = await augmentation.tickAugmentationLoop(producer, cfg, {});
    augmentation.publish(f.ns.getPortHandle(11), producer, cfg, status);
    assert.equal(status.queued, 0);
    assert.equal(status.progression.installedCount, 5);
    assert.equal(status.progression.milestone, 'FACTION_UNLOCK');
    assert.equal(status.progression.requiredHacking, 344);
    assert.equal(status.progression.resetImminent, false);

    for (const target of ['TOR', 'BruteSSH.exe']) {
        const plan = f.plan();
        await f.utilities.updateSupervisorSavings(f.ns, f.cfg, status.plan, plan, f.ns.getPortHandle(11).peek());
        assert.equal(f.goal().target, target);
        f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
        assert.equal(f.actions.active?.request.target, target, 'idle augmentation state must not block the real purchase actor');
        await f.runActor();
        assert.equal(f.ns.getPortHandle(14).peek().state, 'succeeded');
        f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
        f.clock.now += 5000;
    }
    await f.setGoal('home:ram');
    const epoch = [f.reset.currentNode, f.reset.lastNodeReset, f.reset.lastAugReset].join(':');
    await loadScript('home-upgrade.js', f.clock).main({ ...f.ns, args: [epoch, 512, 0, false] });
    assert.equal(f.hosts.home.ram, 512);
    assert.deepEqual(f.purchases, ['TOR', 'BruteSSH.exe', 'home:ram']);
});

test('BN5 with SF4.3 funds blocked home services before SQLInject and resumes program savings after admission', async () => {
    const f = fixture(5), catalog = loadScript('lib/service-catalog.js', f.clock);
    const capabilities = { singularity: true, route: false, darknet: true, stocks: false };
    delete f.cfg.homeInvestment;
    f.cfg.darknet = true;
    f.costs['supervisor.js'] = 8.2;
    f.world.cash = 54.21e6;
    f.world.tor = true;
    for (const p of loadScript('lib/programs.js', f.clock).progressionPrograms())
        if (p.name !== 'SQLInject.exe') f.world.owned.add(p.name);
    const plan = f.plan(), services = f.supervisor.createManagedServices(f.ns, f.cfg, []);
    const hosts = loadScript('lib/starter-pool.js', f.clock).starterHosts(f.ns);
    const budget = catalog.supervisorRamBudget(f.ns, f.cfg, capabilities);
    assert.ok(catalog.supervisorFiles(f.cfg, capabilities).includes('home-upgrade.js'), 'BN5 with SF4 needs the home RAM helper');
    assert.ok(!catalog.supervisorFiles(f.cfg, capabilities).includes('node-complete.js'), 'node transition policy stays separate from RAM recovery');
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    assert.equal(f.goal().target, 'SQLInject.exe');
    const blocker = f.supervisor.tickServicePriority(f.ns, services, '', 0, budget.actorRam);
    assert.match(blocker, /112.90 GB; 107.75 GB free on home after 12.05 GB helper reserve/);
    const before = [...f.processes.keys()];

    await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities, services, [], f.actions, hosts);
    assert.equal(f.launches.at(-1)?.filename, 'home-upgrade.js', 'SF4 access must enable automatic RAM recovery outside the BN4 route');
    await f.runActor();
    assert.equal(f.hosts.home.ram, 128, 'quoting does not spend through the existing program goal');
    await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities, services, [], f.actions, hosts);
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    assert.equal(f.goal().target, 'home:ram');
    assert.equal(f.goal().priority, 90);
    assert.equal(f.purchases.length, 0, 'unfunded SQLInject does not take priority over blocked services');

    f.world.cash = 100.9e6;
    await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities, services, [], f.actions, hosts);
    await f.runActor();
    assert.equal(f.hosts.home.ram, 256);
    f.supervisor.tickServicePriority(f.ns, services, '', 0, budget.actorRam);
    for (const filename of ['augmentation-manager.js', 'contract-manager.js', 'go-bot.js', 'darknet-manager.js'])
        assert.ok(f.launches.some(p => p.filename === filename), filename + ' should start after the RAM upgrade');
    assert.ok(before.every(pid => f.processes.has(pid)), 'the income engine and unrelated processes keep running');
    await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities, services, [], f.actions, hosts);
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    assert.equal(f.goal().target, 'SQLInject.exe', 'program savings resumes once the admission shortage is resolved');
});

for (const condition of ['no SF4', 'augmentation disabled', 'progression disabled', 'actions disabled']) {
    test('automatic home RAM recovery honors ' + condition + ' outside BN4', async () => {
        const f = fixture(5), capabilities = { singularity: condition !== 'no SF4', route: false, darknet: false };
        delete f.cfg.homeInvestment;
        if (condition === 'no SF4') f.reset.ownedSF.delete(4);
        if (condition === 'augmentation disabled') f.cfg.augmentationActions = false;
        if (condition === 'progression disabled') f.cfg.progression = false;
        if (condition === 'actions disabled') f.cfg.progressionActions = false;
        await f.supervisor.tickHomeServiceUpgrade(f.ns, f.cfg, capabilities,
            [{ name: 'augmentation-manager.js', state: 'WAITING_RAM' }], [], f.actions, ['home']);
        assert.equal(f.launches.length, 0);
        assert.equal(f.cfg.homeInvestment, undefined);
    });
}

for (const condition of ['no SF4', 'stale reset', 'manual goal', 'unfunded', 'reset imminent']) {
    test('home upgrade actor preserves ' + condition + ' in BN5 with SF4', async () => {
        const f = fixture(5);
        f.world.cash = 100.9e6;
        await f.setGoal('home:ram');
        const epoch = [f.reset.currentNode, f.reset.lastNodeReset, f.reset.lastAugReset].join(':');
        if (condition === 'no SF4') f.reset.ownedSF.delete(4);
        if (condition === 'stale reset') f.reset.lastAugReset++;
        if (condition === 'manual goal') await f.setGoal('manual:fund', f.world.cash, 0, 'manual');
        if (condition === 'unfunded') f.world.cash = 54.21e6;
        if (condition === 'reset imminent') f.ns.getPortHandle(11).write({ resetEpoch: epoch, progression: { resetImminent: true } });
        await loadScript('home-upgrade.js', f.clock).main({ ...f.ns, args: [epoch, 256, 0, false] });
        assert.equal(f.hosts.home.ram, 128);
        assert.deepEqual(f.purchases, []);
    });
}

for (const state of ['WAITING', 'BLOCKED', 'RESETTING']) test(`home RAM distinguishes idle queue waiting from a ${state} installation`, async () => {
    const f = fixture(5);
    f.world.cash = 100.9e6;
    await f.setGoal('home:ram');
    const epoch = [f.reset.currentNode, f.reset.lastNodeReset, f.reset.lastAugReset].join(':');
    f.ns.getPortHandle(11).write({ resetEpoch: epoch, phase: 'INSTALL', state, queued: state === 'WAITING' ? 1 : 5 });
    await loadScript('home-upgrade.js', f.clock).main({ ...f.ns, args: [epoch, 256, 0, false] });
    assert.equal(f.hosts.home.ram, state === 'WAITING' ? 256 : 128);
    assert.deepEqual(f.purchases, state === 'WAITING' ? ['home:ram'] : []);
});

test('the reported 128 GB BN4 stall buys root unlocks and installs a backdoor before funding augmentation service RAM', async () => {
    const f = fixture();
    await f.setGoal();
    f.supervisor.tickServicePriority(f.ns, f.services, '', 8.05);
    assert.equal(f.services.find(s => s.name === 'augmentation-manager.js').state, 'WAITING_RAM');
    const hosts = loadScript('lib/starter-pool.js', f.clock).starterHosts(f.ns);
    const reserve = f.supervisor.homeUpgradeReserve(f.ns, hosts, f.costs['home-upgrade.js']);
    assert.equal(reserve, 0, 'free rooted network RAM runs the upgrade helper');
    const actorRam = loadScript('lib/service-catalog.js', f.clock).supervisorRamBudget(f.ns, f.cfg, { singularity: true, route: true }).actorRam;
    f.supervisor.tickServicePriority(f.ns, f.services, '', reserve, actorRam);
    assert.equal(f.services.find(s => s.name === 'augmentation-manager.js').state, 'WAITING_RAM');
    assert.match(f.services.find(s => s.name === 'augmentation-manager.js').waitReason, /12.05 GB helper reserve/);
    f.cfg.darknet = true;

    for (const target of ['TOR', 'BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe']) {
        const plan = f.plan();
        assert.ok(plan.programs.some(p => p.name === 'DarkscapeNavigator.exe'), 'default Darknet stays enabled');
        await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
        assert.equal(f.goal().target, target, 'the existing critical RAM goal must yield to ' + target);
        assert.equal(f.goal().priority, 94);
        f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
        assert.equal(f.actions.active?.request.target, target);
        await f.runActor();
        assert.equal(f.ns.getPortHandle(14).peek().state, 'succeeded');
        f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
        f.clock.now += 5000;
    }
    assert.deepEqual(f.purchases, ['TOR', 'BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe']);
    assert.ok(f.ns.hasRootAccess('CSEC') && f.ns.hasRootAccess('neo-net') && f.ns.hasRootAccess('netlink'));

    const plan = f.plan();
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    assert.equal(f.goal().target, 'home:ram', 'substantial program spending waits for RAM admission');
    f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
    assert.equal(f.actions.active?.request.target, 'CSEC');
    await f.runActor();
    assert.ok(f.world.installed.has('CSEC'), 'independent faction unlock does not wait for the home upgrade');
    assert.equal(f.world.current, 'home');
    f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg, f.clock.now);
    f.cfg.homeUpgradeCritical = f.supervisor.progressionRamBlocked(f.services, f.actions);
    assert.equal(f.cfg.homeUpgradeCritical, true);
    const targetRam = f.supervisor.ongoingHomeTarget(f.ns, f.cfg, { singularity: true, route: true }, f.services, []);
    assert.ok(targetRam > 128);
    assert.equal(f.cfg.homeUpgradePriority, 90);

    f.world.cash = 100.9e6;
    await f.supervisor.tickStarterHomeUpgrade(f.ns, hosts, targetRam, f.cfg);
    const helper = f.launches.at(-1);
    assert.equal(helper.filename, 'home-upgrade.js');
    await f.runActor(helper);
    assert.equal(f.hosts.home.ram, 256);
    f.supervisor.tickServicePriority(f.ns, f.services, '', reserve, actorRam);
    assert.ok(f.launches.some(p => p.filename === 'augmentation-manager.js'));
    assert.ok(f.ns.getServerMaxRam('home') - f.ns.getServerUsedRam('home') >= actorRam);
});

test('cheap openers without additional worker RAM retain their ordinary rank behind Navigator', () => {
    const f = fixture(), api = loadScript('lib/programs.js', f.clock);
    const programs = api.progressionPrograms().map(p => ({ ...p, owned: p.name === 'BruteSSH.exe' }));
    const ranked = api.rankPrograms(programs, { homeRam: 128, darknetRam: 42.1 });
    assert.equal(ranked[0].name, 'DarkscapeNavigator.exe');
    assert.ok(ranked.find(p => p.name === 'FTPCrack.exe').priority < 85);
});

function relayBudgetFixture() {
    const f = fixture();
    f.world.cash = 11.66e6; f.world.tor = true;
    f.world.owned.add('BruteSSH.exe'); f.world.owned.add('FTPCrack.exe');
    f.hosts.netlink.ram = 128;
    f.cfg.homeInvestment.amount = 31.86e6;
    const daemon = [...f.processes.values()].find(p => p.filename === 'daemon.js');
    const snapshot = { type: 'jit-status', pid: daemon.pid, generatedAt: f.clock.now,
        totalRam: 120, usedRam: 100, income60: 20.2e6 / 3471, maxBatchRate: 4, maxWorkers: 6000,
        pipelines: [{ mode: 'LIVE', running: 20, queued: 10, modelBatchRate: 1, warmupMs: 120000 }],
        capacity: { limitingFactor: 'RAM', constraints: ['RAM'], ram: { scalable: true } } };
    f.ns.getPortHandle(17).write(snapshot);
    return { ...f, snapshot, daemon };
}

test('the $11.66m/$31.86m stall buys relaySMTP when its worker RAM shortens service funding', async () => {
    const f = relayBudgetFixture();
    await f.setGoal('home:ram', 31.86e6);
    const plan = f.plan(), objective = plan.objectives.find(o => o.target === 'relaySMTP.exe');
    assert.equal(objective.addedRam, 128, 'the planner carries the actual newly rootable RAM');
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    assert.equal(f.goal().target, 'relaySMTP.exe');
    assert.equal(f.goal().priority, 94, 'economic proof clears critical-home hysteresis');
    assert.equal(f.goal().amount, 5e6 / .9, 'the normal reserve remains required');
    assert.match(f.cfg.rootUnlockStatus, /3471s -> 2947s/);
    f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg);
    assert.equal(f.actions.active?.request.target, 'relaySMTP.exe');
    await f.runActor();
    assert.deepEqual(f.purchases, ['relaySMTP.exe']);
    assert.equal(f.world.cash, 6.66e6);
    assert.ok(f.ns.hasRootAccess('netlink'));
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, f.plan());
    assert.equal(f.goal().target, 'home:ram', 'service RAM savings resumes immediately after the opener');
});

for (const condition of ['little unlocked RAM', 'stale scheduler', 'dead scheduler', 'no timing', 'manual goal',
    'Red Pill', 'purchase RAM', 'actions disabled']) {
    test('economic root unlock arbitration preserves ' + condition, async () => {
        const f = relayBudgetFixture();
        await f.setGoal(condition === 'manual goal' ? 'manual:fund' : 'home:ram', 31.86e6, 90,
            condition === 'manual goal' ? 'manual' : 'supervisor');
        if (condition === 'little unlocked RAM') f.hosts.netlink.ram = 32;
        if (condition === 'stale scheduler') f.snapshot.generatedAt -= 15001;
        if (condition === 'dead scheduler') f.processes.delete(f.daemon.pid);
        if (condition === 'no timing') delete f.snapshot.pipelines[0].warmupMs;
        if (condition === 'purchase RAM') f.costs['progression-purchase.js'] = 129;
        if (condition === 'actions disabled') f.cfg.progressionActions = false;
        const plan = f.plan();
        if (condition === 'Red Pill') plan.milestone.savings = { target: 'augmentation:The Red Pill', amount: 100e9, label: 'Red Pill' };
        await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
        const expected = condition === 'manual goal' ? 'manual:fund' : condition === 'Red Pill' ? 'augmentation:The Red Pill' : 'home:ram';
        assert.equal(f.goal().target, expected);
    });
}

test('home upgrade reserve retains its fallback unless a rooted host has free or owned starter RAM', () => {
    const f = fixture(), hosts = ['home', 'foodnstuff', 'n00dles', 'CSEC'];
    const worker = f.add('starter-worker.js', 'foodnstuff', 6, ['n00dles', 'manual']);
    assert.equal(f.supervisor.homeUpgradeReserve(f.ns, hosts, 8.05), 8.05, 'unrooted CSEC and a 4 GB host cannot run it');
    worker.args = ['n00dles', 'supervisor-starter-v1'];
    assert.equal(f.supervisor.homeUpgradeReserve(f.ns, hosts, 8.05), 0, 'owned starter work is reclaimable');
    worker.args = ['n00dles', 'manual'];
    assert.equal(f.supervisor.homeUpgradeReserve(f.ns, hosts, 8.05), 8.05, 'manual workers must keep their RAM');
    assert.equal(f.supervisor.homeUpgradeReserve(f.ns, hosts, 0), 0);
});

for (const condition of ['unfunded', 'purchase RAM', 'large opener', 'Navigator', 'manual goal', 'Daedalus', 'Red Pill', 'actions disabled']) {
    test('root unlock arbitration preserves ' + condition, async () => {
        const f = fixture();
        await f.setGoal(condition === 'manual goal' ? 'manual:fund' : 'home:ram', 100.68e6, 90, condition === 'manual goal' ? 'manual' : 'supervisor');
        const plan = f.plan();
        if (condition === 'unfunded') f.world.cash = 100000;
        if (condition === 'purchase RAM') f.costs['progression-purchase.js'] = 129;
        if (condition === 'large opener' || condition === 'Navigator') {
            const target = condition === 'Navigator' ? 'DarkscapeNavigator.exe' : 'HTTPWorm.exe';
            plan.objectives = [{ kind: 'program', target, priority: 84, costEstimate: condition === 'Navigator' ? 50e6 : 30e6 }];
        }
        if (condition === 'Daedalus' || condition === 'Red Pill') {
            await f.setGoal('TOR', 200000 / .9, 94);
            plan.milestone.savings = { target: condition === 'Daedalus' ? 'faction:Daedalus' : 'augmentation:The Red Pill', amount: 100e9, label: condition };
        }
        if (condition === 'actions disabled') f.cfg.progressionActions = false;
        await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
        const expected = condition === 'manual goal' ? 'manual:fund' : condition === 'Daedalus' ? 'faction:Daedalus'
            : condition === 'Red Pill' ? 'augmentation:The Red Pill' : 'home:ram';
        assert.equal(f.goal().target, expected);
    });
}

test('stale RAM diagnostics do not request a critical upgrade while an actor is running or progression is blocked', () => {
    const f = fixture(), diagnostics = [{ state: 'waiting', reason: 'CSEC: WAITING_RAM (need 12.05 GB)' }];
    const services = [{ name: 'augmentation-manager.js', state: 'RUNNING' }];
    assert.equal(f.supervisor.progressionRamBlocked(services, { diagnostics, current: { state: 'waiting' } }), true);
    assert.equal(f.supervisor.progressionRamBlocked(services, { diagnostics, current: { state: 'running' }, active: {} }), false);
    assert.equal(f.supervisor.progressionRamBlocked(services, { diagnostics, current: { state: 'blocked' } }), false);
});

test('progression actor reserves never prevent the initial money engine from starting on a 64 GB home', async () => {
    const f = fixture();
    f.hosts.home.ram = 64;
    f.cfg.serviceHosts['daemon.js'] = 'home';
    f.processes.delete([...f.processes.values()].find(p => p.filename === 'daemon.js').pid);
    const services = f.supervisor.createManagedServices(f.ns, f.cfg, []);
    f.supervisor.tickServicePriority(f.ns, services, '', 0, 12.05);
    assert.ok(f.launches.some(p => p.filename === 'daemon.js' && p.host === 'home'));
    assert.equal(services.find(s => s.name === 'augmentation-manager.js').state, 'WAITING_RAM');
    const plan = f.plan();
    await f.utilities.updateSupervisorSavings(f.ns, f.cfg, null, plan);
    f.dispatcher.tickProgressionActions(f.ns, f.actions, plan, f.cfg);
    assert.equal(f.actions.active?.request.target, 'TOR');
    await f.runActor();
    assert.equal(f.world.tor, true);
});

test('early starter services also preserve the full progression actor reserve', async () => {
    const f = fixture();
    f.hosts.home.ram = 32;
    f.costs['augmentation-manager.js'] = 15;
    await f.supervisor.tickStarterProgression(f.ns, f.cfg, 8.05);
    assert.ok(!f.launches.some(p => p.filename === 'augmentation-manager.js'), 'upgrade helper RAM alone would wrongly admit the manager');
    assert.ok(f.ns.getServerMaxRam('home') - f.ns.getServerUsedRam('home') >= 12.05);
    assert.ok(f.processes.values().some(p => p.filename === 'progression-manager.js'));
});

test('an adopted manager that fills home triggers a remote upgrade when its backdoor actor cannot fit', async () => {
    const f = fixture();
    f.cfg.contracts = false; f.cfg.go = false;
    f.world.tor = true;
    for (const name of ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe']) f.world.owned.add(name);
    const manager = f.add('augmentation-manager.js');
    const services = f.supervisor.createManagedServices(f.ns, f.cfg, []);
    f.supervisor.tickServicePriority(f.ns, services, '', 0, 12.05);
    await f.setGoal();
    f.dispatcher.tickProgressionActions(f.ns, f.actions, f.plan(), f.cfg);
    assert.ok(f.actions.diagnostics.some(d => d.target === 'CSEC' && /WAITING_RAM/.test(d.reason)));
    f.cfg.homeUpgradeCritical = f.supervisor.progressionRamBlocked(services, f.actions);
    const target = f.supervisor.ongoingHomeTarget(f.ns, f.cfg, { singularity: true, route: true }, services, []);
    assert.ok(target > 128, 'a running manager does not hide the actor RAM requirement');
    assert.equal(f.cfg.homeUpgradePriority, 90);
    f.world.cash = 100.9e6;
    const hosts = loadScript('lib/starter-pool.js', f.clock).starterHosts(f.ns);
    await f.supervisor.tickStarterHomeUpgrade(f.ns, hosts, target, f.cfg);
    const helper = f.launches.at(-1);
    assert.equal(helper.filename, 'home-upgrade.js');
    assert.notEqual(helper.host, 'home');
    await f.runActor(helper);
    assert.equal(f.hosts.home.ram, 256);
    assert.ok(f.processes.has(manager.pid));
    f.clock.now += 31000;
    f.dispatcher.tickProgressionActions(f.ns, f.actions, f.plan(), f.cfg);
    assert.equal(f.actions.active?.request.target, 'CSEC');
    await f.runActor();
    assert.ok(f.world.installed.has('CSEC'));
    assert.ok(f.processes.has(manager.pid));
});

test('restart reloads progression and augmentation managers with their arguments and threads preserved', async () => {
    const f = fixture(), killed = [];
    const readers = loadScript('lib/service-hosts.js', f.clock);
    await readers.saveServiceHosts(f.ns, f.cfg.serviceHosts);
    const progression = [...f.processes.values()].find(p => p.filename === 'progression-manager.js');
    f.hosts.core.ram = 128;
    progression.threads = 2;
    progression.args = ['--fleet-port', 19, '--interval', 12000, '--darknet', true];
    f.hosts.home.ram = 256;
    const augmentation = f.add('augmentation-manager.js', 'home', 2, ['--min-install', 3, '--purchase', false, '--route', false]);
    const before = [...f.processes.values()].map(p => p.pid);
    f.costs['bootstrap.js'] = 1.6;
    f.costs['manual.js'] = 4;
    const manual = f.add('manual.js');
    f.ns.kill = pid => { killed.push(pid); return f.processes.delete(pid); };
    f.ns.tprint = () => {};
    f.ns.ui = { openTail() {} };
    f.ns.sleep = async () => {};
    const run = f.ns.run;
    f.ns.run = (file, threads, ...args) => file === 'bootstrap.js'
        ? f.add('supervisor.js').pid : run(file, threads, ...args);
    await loadScript('supervisor-restart.js', f.clock).main({ ...f.ns, pid: 100 });
    assert.deepEqual(killed, before, 'supervisor stops first, then core controllers and the augmentation manager');
    assert.ok(f.processes.has(manual.pid));
    const saved = JSON.parse(f.ns.read('data/service-hosts.json'));
    assert.equal(saved.hosts['progression-manager.js'], 'core');
    assert.deepEqual(saved.settings['progression-manager.js'].args, progression.args);
    assert.equal(saved.settings['progression-manager.js'].threads, 2);
    assert.deepEqual(saved.settings['augmentation-manager.js'].args, augmentation.args);
    assert.equal(saved.settings['augmentation-manager.js'].threads, 2);
    const services = f.supervisor.createManagedServices(f.ns, { ...f.cfg, serviceHosts: readers.readServiceHosts(f.ns),
        serviceSettings: readers.readServiceSettings(f.ns) }, []);
    f.supervisor.tickServicePriority(f.ns, services, '', 0);
    const replacement = [...f.processes.values()].find(p => p.filename === 'augmentation-manager.js');
    assert.ok(replacement);
    assert.notEqual(replacement.pid, augmentation.pid);
    assert.deepEqual(Array.from(replacement.args), augmentation.args);
    assert.equal(replacement.threads, 2);
});
