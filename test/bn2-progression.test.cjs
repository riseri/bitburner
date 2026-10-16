const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), ports = new Map();
    const reset = { currentNode: 2, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map([[4, 3]]) };
    const world = { cash: 10e9, rep: 100, hacking: 3000, gang: true, installed: [], purchased: [], buys: [], works: [], donations: [], installs: [],
        factions: ['NiteSec'], invitations: [], current: null, scripts: [], offers: ['The Red Pill', 'BitWire'], finalServer: false, launches: [] };
    const ns = {
        pid: 20, getResetInfo: () => reset,
        getPlayer: () => ({ factions: world.factions, city: 'Sector-12', skills: { hacking: world.hacking, strength: 1, defense: 1, dexterity: 1, agility: 1 }, mults: {} }),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        getServerMoneyAvailable: () => world.cash, getHackingLevel: () => world.hacking,
        serverExists: host => world.finalServer && host === 'w0r1d_d43m0n', getServerRequiredHackingLevel: () => 3000,
        hasRootAccess: () => true, getServerMaxRam: () => 1e6, getServerUsedRam: () => 0, getScriptRam: () => 2,
        ps: () => world.scripts, run: (script, threads, arg) => { world.launches.push({ script, threads, arg }); return 30; },
        read: file => file === 'data/supervisor-bootstrap.json' ? JSON.stringify({ version: 2, args: [] }) : '', write: async () => {},
        fileExists: name => name === 'bootstrap.js', hasTorRouter: () => true, getFavorToDonate: () => 150,
        gang: { inGang: () => world.gang, getGangInformation: () => ({ faction: 'NiteSec', isHacking: true }) },
        singularity: {
            getOwnedAugmentations: all => all ? [...world.installed, ...world.purchased] : world.installed,
            getAugmentationsFromFaction: faction => faction === 'NiteSec' || faction === 'Daedalus' ? world.offers : [],
            getFactionRep: () => world.rep, getFactionFavor: () => 1000,
            getAugmentationPrice: name => name === 'The Red Pill' ? 1e9 : 1000,
            getAugmentationRepReq: name => name === 'The Red Pill' ? 1e6 : 100,
            getAugmentationPrereq: () => [], getAugmentationStats: name => name === 'The Red Pill' ? {} : { hacking: 1.1 },
            getFactionWorkTypes: faction => world.gang && faction === 'NiteSec' ? [] : ['hacking'],
            getCurrentWork: () => world.current, isBusy: () => Boolean(world.current), checkFactionInvitations: () => world.invitations,
            joinFaction: faction => { world.factions.push(faction); return true; },
            workForFaction: (...args) => { world.works.push(args); return true; },
            donateToFaction: (...args) => { world.donations.push(args); return true; },
            purchaseAugmentation: (faction, name) => { world.buys.push({ faction, name }); world.purchased.push(name); return true; },
            installAugmentations: script => { world.installs.push(script); return true; }, stopAction: () => { world.current = null; return true; },
        },
    };
    const cfg = { focus: 'hacking', target: '', route: true, resetPolicy: 'threshold', cashReserve: .1, joinFactions: true,
        work: true, donate: true, purchase: true, focusWork: false, minInstall: 5, programCreation: false, intelligence: false };
    return { clock, ns, world, cfg, reset, state: {}, ports, api: loadScript('augmentation-manager.js', clock),
        contextApi: loadScript('lib/augmentation-context.js', clock), planApi: loadScript('lib/augmentation-plan.js', clock),
        PORTS: loadScript('lib/ports.js', clock).PORTS };
}

test('BN2 buys useful gang upgrades while Red Pill reputation is still accumulating', async () => {
    const f = fixture();
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'PURCHASE');
    assert.deepEqual(f.world.buys, [{ faction: 'NiteSec', name: 'BitWire' }]);
    assert.equal(status.progression.gangRoute, true);
    assert.equal(status.progression.countRequired, 0);
    assert.equal(f.world.works.length + f.world.donations.length, 0);
});

test('ready gang Red Pill bypasses the 30 augmentations, hacking 2500, $100b Daedalus diversion', async () => {
    const f = fixture();
    f.world.installed = Array.from({ length: 30 }, (_, i) => `Installed ${i}`);
    f.world.rep = 1e6;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'PURCHASE');
    assert.equal(f.world.buys[0].name, 'The Red Pill');
    assert.notEqual(status.savings?.target, 'faction:Daedalus');
    assert.equal(status.progression.milestone, 'INSTALL_RED_PILL');
});

test('gang progression neither buys count fillers nor resets just to reach Daedalus count', async () => {
    const f = fixture();
    f.world.installed = Array.from({ length: 29 }, (_, i) => `Installed ${i}`);
    f.world.purchased = ['BitWire'];
    f.world.offers = ['The Red Pill', 'Combat filler'];
    f.ns.singularity.getAugmentationStats = () => ({ strength: 1.1 });
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'REPUTATION');
    assert.equal(status.state, 'WAITING');
    assert.equal(status.plan.next.name, 'The Red Pill');
    assert.equal(status.progression.reputationStrategy, 'PASSIVE');
    assert.equal(status.progression.sharingDemand, 'OFF');
    assert.equal(f.world.installs.length + f.world.buys.length + f.world.works.length, 0);
});

test('manual Red Pill target remains selected while gang rep grows', async () => {
    const f = fixture(); f.cfg.target = 'The Red Pill';
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.plan.next.name, 'The Red Pill');
    assert.equal(status.phase, 'REPUTATION');
    assert.equal(status.state, 'WAITING');
    assert.equal(f.world.buys.length + f.world.works.length + f.world.donations.length, 0);
});

test('a reputation-ready gang Red Pill is funded ahead of optional upgrades', async () => {
    const f = fixture(); f.world.rep = 1e6; f.world.cash = 1e6;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.plan.next.name, 'The Red Pill');
    assert.equal(status.phase, 'FUND');
    assert.equal(status.progression.savings.target, 'augmentation:The Red Pill');
});

test('Daedalus Red Pill retains its normal hard target priority before reputation is ready', async () => {
    const f = fixture(); f.world.gang = false; f.world.factions = ['Daedalus'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.plan.next.name, 'The Red Pill');
    assert.equal(status.phase, 'REPUTATION');
    assert.equal(f.world.works.length, 1);
    assert.equal(status.progression.countRequired, 30);
});

test('gang Red Pill installs immediately and the existing node transition finishes BN2', async () => {
    const f = fixture(); f.world.purchased = ['The Red Pill'];
    let status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.deepEqual(f.world.installs, ['bootstrap.js']);
    f.world.installed = ['The Red Pill']; f.world.purchased = []; f.world.finalServer = true;
    f.reset.lastAugReset = 3;
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'COMPLETE_NODE');
    assert.equal(f.world.launches[0].script, 'node-complete.js');
    assert.equal(JSON.parse(f.world.launches[0].arg).nextNode, 2);
});

test('gang faction catalog refreshes when a gang forms without changing joined factions', () => {
    const f = fixture(); f.world.gang = false; f.world.offers = ['BitWire'];
    let context = f.contextApi.augmentationContext(f.ns);
    f.planApi.buildAugmentationPlan(f.ns, { context, state: f.state });
    f.world.gang = true; f.world.offers = ['The Red Pill', 'BitWire']; f.world.rep = 1e6;
    context = f.contextApi.augmentationContext(f.ns);
    const plan = f.planApi.buildAugmentationPlan(f.ns, { context, state: f.state });
    assert.equal(plan.next.name, 'The Red Pill');
});

test('gang faction reputation ETA requires two fresh intervals and drops stale or reset samples', () => {
    const f = fixture(); f.world.offers = ['The Red Pill'];
    const plan = () => f.planApi.buildAugmentationPlan(f.ns, { context: f.contextApi.augmentationContext(f.ns), state: f.state });
    assert.equal(plan().next.rate, null);
    f.clock.now += 5000; f.world.rep += 1000;
    assert.equal(plan().next.rate, null);
    f.clock.now += 5000; f.world.rep += 500;
    let next = plan().next;
    assert.equal(next.rate, 80);
    assert.equal(next.rateSource, 'measured gang');
    assert.equal(next.donationEligible, false);
    assert.equal(next.donationPlanned, false);
    assert.equal(next.workEtaMs, next.repGap / 80 * 1000);
    f.clock.now += 20000; f.world.rep += 1000;
    assert.equal(plan().next.rate, null);
    f.reset.lastAugReset = 100; f.clock.now += 5000; f.world.rep += 1000;
    assert.equal(plan().next.rate, null);
});

test('fresh live gang income combines with daemon income and stale telemetry adds nothing', () => {
    const f = fixture(); f.world.scripts = [{ filename: 'gang-manager.js', pid: 9 }, { filename: 'daemon.js', pid: 10 }];
    const gangStatus = { type: 'gang-status', version: 1, generatedAt: f.clock.now, resetEpoch: '2:1:2', producerPid: 9,
        faction: 'NiteSec', isHacking: true, inGang: true, incomePerSecond: 123 };
    f.ns.getPortHandle(f.PORTS.GANG_STATUS).write(gangStatus);
    f.ns.getPortHandle(f.PORTS.JIT_STATUS).write({ type: 'jit-status', version: 2, generatedAt: f.clock.now, pid: 10, income60: 45 });
    assert.equal(f.contextApi.augmentationContext(f.ns).income, 168);
    gangStatus.generatedAt -= 15001;
    const context = f.contextApi.augmentationContext(f.ns);
    assert.equal(context.income, 45);
    assert.equal(context.gang.managed, false);
    assert.equal(context.objective.gangRoute, true);
});

test('locked gang API is never called outside BN2 without SF2', () => {
    const f = fixture(); f.reset.currentNode = 1;
    f.ns.gang = new Proxy({}, { get() { assert.fail('gang API access was not gated'); } });
    const context = f.contextApi.augmentationContext(f.ns);
    assert.equal(context.gang, null);
    assert.equal(context.objective.gangRoute, false);
});

test('SF2 gang without a Red Pill offer retains the ordinary Daedalus route', () => {
    const f = fixture(); f.reset.currentNode = 1; f.reset.ownedSF.set(2, 1); f.world.offers = ['BitWire'];
    f.world.installed = Array.from({ length: 30 }, (_, i) => `Installed ${i}`);
    const context = f.contextApi.augmentationContext(f.ns);
    assert.equal(context.gang.faction, 'NiteSec');
    assert.equal(context.objective.gangRoute, false);
    assert.equal(context.objective.milestone, 'DAEDALUS');
    assert.equal(context.objective.requiredCash, 100e9);
});

test('post-Red Pill endgame waits for gang rep, quotes ready gang upgrades, and sources NeuroFlux elsewhere', () => {
    const f = fixture(), api = loadScript('lib/augmentation-endgame.js', f.clock);
    f.world.installed = ['The Red Pill']; f.world.factions = ['NiteSec', 'CyberSec']; f.world.rep = 0;
    f.ns.singularity.getAugmentationsFromFaction = faction => faction === 'NiteSec'
        ? ['The Red Pill', 'GangHacking'] : ['NeuroFlux Governor'];
    f.ns.singularity.getFactionRep = faction => faction === 'NiteSec' ? f.world.rep : 1000;
    f.ns.fileExists = () => true;
    f.ns.formulas = { reputation: { donationForRep: () => 1000 }, work: { factionGains: () => ({ reputation: 1 }) } };
    const quote = () => api.quoteEndgamePackage(f.ns, f.cfg, f.contextApi.augmentationContext(f.ns),
        { fundReputation: true, maxPurchases: 3 });
    let proposal = quote();
    assert.ok(proposal.purchases.length > 0);
    assert.ok(proposal.purchases.every(item => item.name === 'NeuroFlux Governor' && item.faction === 'CyberSec'));
    assert.ok(proposal.funding.every(goal => goal.faction !== 'NiteSec'));
    f.world.rep = 1000;
    proposal = quote();
    assert.equal(proposal.purchases[0].name, 'GangHacking');
    assert.equal(proposal.purchases[0].faction, 'NiteSec');
    const neuroflux = proposal.purchases.filter(item => item.name === 'NeuroFlux Governor');
    assert.ok(neuroflux.length > 0);
    assert.ok(neuroflux.every(item => item.faction === 'CyberSec'));
    assert.ok(proposal.funding.every(goal => goal.faction !== 'NiteSec'));
    assert.equal(f.world.works.length + f.world.donations.length, 0);
});

function freeRedPillFixture({ owner = 'supervisor', target = 'home:ram', malformed = false } = {}) {
    const f = fixture();
    f.world.cash = 10e6; f.world.rep = 2.5e6;
    f.ns.singularity.getAugmentationPrice = name => name === 'The Red Pill' ? 0 : 1000;
    f.ns.singularity.getAugmentationRepReq = name => name === 'The Red Pill' ? 2.5e6 : 100;
    const read = f.ns.read;
    f.ns.read = file => file === 'data/savings.json' ? malformed ? '{' : JSON.stringify({ version: 1,
        epoch: '2:1:2', amount: 100e9, label: 'Unfunded savings goal', target, owner }) : read(file);
    return f;
}

for (const target of ['home:ram', 'BruteSSH.exe', 'faction:Daedalus']) {
    test(`free gang Red Pill is purchased despite an unfunded automatic ${target} reserve`, async () => {
        const f = freeRedPillFixture({ target });
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'PURCHASE');
        assert.equal(status.state, 'ACTIVE');
        assert.deepEqual(f.world.buys, [{ faction: 'NiteSec', name: 'The Red Pill' }]);
        assert.equal(status.plan.next.fundingCost, 0);
        assert.equal(f.world.cash, 10e6);
    });
}

for (const options of [{ owner: 'manual' }, { malformed: true }]) {
    test(`free gang Red Pill preserves ${options.malformed ? 'malformed savings' : 'manual savings'} restrictions`, async () => {
        const f = freeRedPillFixture(options);
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.phase, 'FUND');
        assert.equal(f.world.buys.length, 0);
    });
}

test('free Red Pill reserve exception preserves disabled purchasing and manual activity installation guards', async () => {
    const f = freeRedPillFixture(); f.cfg.purchase = false;
    let status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'READY');
    assert.equal(f.world.buys.length, 0);
    f.cfg.purchase = true; f.world.current = { type: 'CRIME', crimeType: 'Homicide' };
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'PURCHASE');
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'BLOCKED');
    assert.equal(status.phase, 'INSTALL');
    assert.equal(f.world.current.type, 'CRIME');
    assert.equal(f.world.installs.length, 0);
});

test('positive augmentation costs still honor unfunded automatic reserves', async () => {
    const f = freeRedPillFixture();
    f.ns.singularity.getAugmentationPrice = () => 1;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'FUND');
    assert.equal(f.world.buys.length, 0);
});
