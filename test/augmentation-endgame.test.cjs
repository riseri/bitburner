const test = require('node:test'), assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');
const NFG = 'NeuroFlux Governor';
const expFor = (level, mult) => Math.exp((level / mult + 200) / 32) - 534;

function fixture() {
    const clock = new Clock(), reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 900000, ownedSF: new Map([[5, 1]]) };
    const files = new Map([['data/supervisor-bootstrap.json', '{"version":2,"args":[]}']]);
    const world = { cash: 1e14, hacking: 1000, required: 9000, rep: 1e8, installed: ['The Red Pill', NFG], pending: [],
        work: { type: 'CLASS', classType: 'Computer Science', location: 'Rothman University' },
        buys: [], installs: [], stops: 0, offers: [NFG, 'Neural Accelerator'],
        bootstrap: true, formulas: true, measured: true, producer: true, priceFactor: 1, goBonus: 0, scriptRate: 10000 };
    const stats = name => name === NFG ? { hacking: 1.01, hacking_exp: 1.01 } : { hacking: 1.2, hacking_exp: 1.5 };
    const price = name => (name === NFG ? 1e6 * 1.14 ** world.pending.filter(n => n === NFG).length : 1e9) *
        1.9 ** world.pending.length * world.priceFactor;
    const rep = name => name === NFG ? 1000 * 1.14 ** world.pending.filter(n => n === NFG).length : 10000;
    const work = world.work;
    const state = { resetEpoch: '4:1:900000', ownedClass: { ...work }, recoveryProfile: { nodeReset: 1,
        samples: [100000, 500000].map(at => ({ at, ms: 90000, income: 1000, cash: 1e9, xp: 200,
            hacking: 500, reputation: { Daedalus: 1000 } })) } };
    const ports = new Map([11, 17].map(n => [n, new Port()]));
    const ns = { pid: 9, getHostname: () => 'home', getResetInfo: () => reset,
        getPlayer: () => ({ city: 'Sector-12', factions: ['Daedalus'], skills: { hacking: world.hacking },
            mults: { hacking: 20 }, exp: { hacking: expFor(world.hacking, 20) } }),
        getBitNodeMultipliers: () => ({ HackingLevelMultiplier: 1 }), getPortHandle: n => ports.get(n),
        ps: () => world.producer ? [{ filename: 'daemon.js', pid: 20 }] : [],
        getServerMoneyAvailable: () => world.cash, getHackingLevel: () => world.hacking,
        serverExists: () => true, getServerRequiredHackingLevel: () => world.required,
        getServer: () => ({ backdoorInstalled: false }), hasRootAccess: () => true,
        getScriptRam: () => 4, getServerMaxRam: () => 65536, getServerUsedRam: () => 100,
        run: () => assert.fail('this fixture must stay below the final hacking requirement'),
        fileExists: name => name === 'Formulas.exe' ? world.formulas : name === 'bootstrap.js' && world.bootstrap,
        read: name => files.get(name) || '', write: async (name, data) => { files.set(name, data); world.onSave?.(); }, print() {},
        formulas: { skills: { calculateExp: expFor } },
        go: { analysis: { getStats: () => ({ Illuminati: { bonusPercent: world.goBonus } }) } },
        singularity: { getOwnedAugmentations: all => [...world.installed, ...(all ? world.pending : [])],
            getAugmentationsFromFaction: () => world.offers, getAugmentationStats: stats,
            getAugmentationPrice: price, getAugmentationRepReq: rep, getAugmentationPrereq: () => [], getFactionRep: () => world.rep,
            isBusy: () => !!world.work, getCurrentWork: () => world.work,
            stopAction: () => { world.stops++; world.work = null; return true; },
            universityCourse: () => { world.work = work; return true; },
            purchaseAugmentation: (faction, name) => {
                world.cash -= price(name); world.pending.push(name); world.buys.push({ faction, name }); world.onBuy?.(); return true;
            },
            installAugmentations: script => { world.installs.push(script); return true; },
        } };
    const refresh = () => { ports.get(17).clear(); ports.get(17).write({ type: 'jit-status', version: 2, pid: 20,
        generatedAt: clock.now, income60: 1000, pipelines: [{ mode: 'LIVE' }], prepRam: 0, policy: { balance: {
            milestone: 'FINAL_SERVER', requiredHacking: world.required, requiredCash: 0, generatedAt: clock.now,
            xpSource: world.measured ? 'measured' : 'UNKNOWN', xpRate: 10000, scriptXpRate: world.scriptRate,
            cashSource: 'UNKNOWN', cashRate: null } } }); };
    const api = loadScript('augmentation-manager.js', clock), planner = loadScript('lib/augmentation-endgame.js', clock);
    const contextApi = loadScript('lib/augmentation-context.js', clock), cfg = { route: true, work: true, purchase: true,
        cashReserve: .1, minInstall: 5, resetPolicy: 'auto', focusWork: false };
    const context = () => { refresh(); return contextApi.augmentationContext(ns, state); };
    const tick = async () => { refresh(); return api.tickAugmentationLoop(ns, cfg, state); };
    return { clock, reset, files, world, ns, state, cfg, planner, api, context, tick, work };
}

test('endgame buys useful hacking augmentation and repeated NeuroFlux while training, then installs after sustained advantage', async () => {
    const f = fixture(), first = await f.tick();
    assert.equal(first.phase, 'HACKING'); assert.equal(first.progression.milestone, 'FINAL_SERVER');
    assert.ok(f.world.buys.some(b => b.name === 'Neural Accelerator'));
    assert.ok(f.world.buys.filter(b => b.name === NFG).length > 1);
    assert.equal(f.world.work, f.work); assert.equal(f.world.stops, 0); assert.equal(f.world.installs.length, 0);
    assert.ok(first.endgame.resetEtaMs < first.endgame.continueEtaMs * .8);
    const count = f.world.buys.length;
    for (let i = 1; i <= 12; i++) {
        f.clock.now += 5000; const status = await f.tick();
        if (i < 12) { assert.equal(status.resetDecision.action, 'WAIT'); assert.equal(f.world.buys.length, count); }
        else { assert.equal(status.state, 'RESETTING'); assert.equal(status.resetDecision.action, 'INSTALL'); }
    }
    assert.deepEqual(f.world.installs, ['bootstrap.js']); assert.equal(f.world.stops, 1);
});

test('NeuroFlux alone can justify an endgame cycle; it is not excluded because already installed', async () => {
    const f = fixture(); f.world.offers = [NFG];
    const status = await f.tick();
    assert.ok(status.queued > 5); assert.ok(f.world.buys.every(b => b.name === NFG));
    assert.equal(status.resetDecision.advantage, true);
});

test('near the final hacking requirement, preserve progress and do not buy a speculative reset package', async () => {
    const f = fixture(); f.world.hacking = 8995;
    const status = await f.tick();
    assert.equal(status.phase, 'HACKING'); assert.equal(f.world.buys.length, 0); assert.equal(f.world.installs.length, 0);
    assert.match(status.endgame.reason, /current multipliers/);
});

test('endgame prices loss of current Illuminati speed on script XP, while preserving player-work XP', async () => {
    const scripts = fixture(); scripts.world.goBonus = 1000;
    assert.equal((await scripts.tick()).phase, 'HACKING'); assert.equal(scripts.world.buys.length, 0);
    const classes = fixture(); classes.world.goBonus = 1000; classes.world.scriptRate = 0;
    assert.equal((await classes.tick()).resetDecision.advantage, true);
    assert.ok(classes.world.buys.length > 0);
});

test('endgame rejoins available factions after an augmentation reset while training continues', async () => {
    const f = fixture(); let factions = [];
    const getPlayer = f.ns.getPlayer;
    f.ns.getPlayer = () => ({ ...getPlayer(), factions });
    f.ns.singularity.checkFactionInvitations = () => ['Daedalus'];
    f.ns.singularity.joinFaction = faction => { factions.push(faction); return true; };
    f.cfg.joinFactions = true;
    const status = await f.tick();
    assert.ok(f.world.buys.length > 0); assert.equal(status.phase, 'HACKING'); assert.equal(f.world.work, f.work);
});

test('unused IPvGO opponents have no reset bonus loss and do not prevent endgame upgrades', async () => {
    const f = fixture(); f.ns.go.analysis.getStats = () => ({});
    assert.equal((await f.tick()).resetDecision.advantage, true);
    assert.ok(f.world.buys.length > 0);
});

for (const missing of ['recovery', 'formulas', 'rate', 'producer', 'multipliers']) {
    test(`endgame with missing ${missing} explains uncertainty without shopping or resetting`, async () => {
        const f = fixture();
        if (missing === 'recovery') f.state.recoveryProfile.samples = [];
        if (missing === 'formulas') f.world.formulas = false;
        if (missing === 'rate') f.world.measured = false;
        if (missing === 'producer') f.world.producer = false;
        if (missing === 'multipliers') f.reset.ownedSF.clear();
        const status = await f.tick();
        assert.equal(status.phase, 'HACKING'); assert.equal(f.world.buys.length + f.world.installs.length, 0);
        assert.match(status.endgame.reason, /unavailable|not available|Formulas/);
    });
}

test('complete/old endgame queue does not force a reset without a faster finish', async () => {
    const f = fixture(); f.world.hacking = 8995; f.world.pending = Array(6).fill(NFG);
    f.state.queuedSince = f.clock.now - 7200000;
    const status = await f.tick();
    assert.equal(status.resetDecision.action, 'WAIT'); assert.equal(f.world.installs.length, 0);
});

for (const reason of ['bootstrap', 'settings', 'manual-work', 'new-activity']) {
    test(`endgame economic reset preserves existing ${reason} installation guard`, async () => {
        const f = fixture(); await f.tick();
        for (let i = 0; i < 11; i++) { f.clock.now += 5000; await f.tick(); }
        if (reason === 'bootstrap') f.world.bootstrap = false;
        if (reason === 'settings') f.files.set('data/supervisor-bootstrap.json', '{}');
        if (reason === 'manual-work') f.world.work = { type: 'CRIME', crimeType: 'Heist' };
        if (reason === 'new-activity') f.world.onSave = () => { f.world.work = { type: 'CRIME' }; };
        f.clock.now += 5000; const status = await f.tick();
        assert.equal(status.resetDecision.action, 'INSTALL'); assert.equal(status.state, 'BLOCKED');
        assert.equal(f.world.installs.length, 0);
        if (reason === 'manual-work') assert.equal(f.world.stops, 0);
    });
}

test('endgame quote models global inflation and NeuroFlux level cost/reputation, then live purchases match the quote', () => {
    const f = fixture(), context = f.context(), quote = f.planner.quoteEndgamePackage(f.ns, f.cfg, context);
    const result = f.planner.purchaseEndgamePackage(f.ns, f.cfg, context, quote);
    assert.equal(result.purchased, quote.purchases.length);
    assert.ok(Math.abs(result.spent - quote.cost) < quote.cost * 1e-12);
    assert.ok(f.world.cash >= quote.floor);
});

test('endgame keeps existing savings locked and excludes upgrades needing more reputation', () => {
    const f = fixture(); f.world.rep = 1000;
    f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual', amount: f.world.cash - 500000,
        target: 'fleet:new', label: 'Reserved', epoch: f.state.resetEpoch }));
    assert.equal(f.planner.quoteEndgamePackage(f.ns, f.cfg, f.context()).purchases.length, 0);
    f.files.delete('data/savings.json');
    const quote = f.planner.quoteEndgamePackage(f.ns, f.cfg, f.context());
    assert.deepEqual(Array.from(quote.purchases, p => p.name), [NFG]);
});

for (const changed of ['price', 'reputation', 'savings', 'epoch', 'completed', 'exclusive']) {
    test(`endgame purchases recheck changed ${changed} before spending`, () => {
        const f = fixture(), context = f.context(), quote = f.planner.quoteEndgamePackage(f.ns, f.cfg, context);
        if (changed === 'price') f.world.priceFactor = 1e9;
        if (changed === 'reputation') f.world.rep = 0;
        if (changed === 'savings') f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual', amount: f.world.cash,
            target: 'manual', label: 'Reserved', epoch: f.state.resetEpoch }));
        if (changed === 'epoch') f.reset.lastAugReset++;
        if (changed === 'completed') f.world.hacking = 9000;
        if (changed === 'exclusive') { f.world.work = null; f.ns.singularity.isBusy = () => true; }
        const result = f.planner.purchaseEndgamePackage(f.ns, f.cfg, context, quote);
        assert.equal(result.purchased, 0); assert.equal(f.world.buys.length, 0);
    });
}

test('new savings during an endgame purchase pass stop further purchases without touching player work', () => {
    const f = fixture(), context = f.context(), quote = f.planner.quoteEndgamePackage(f.ns, f.cfg, context);
    f.world.onBuy = () => f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual', amount: f.world.cash,
        target: 'manual', label: 'Reserved', epoch: f.state.resetEpoch }));
    assert.equal(f.planner.purchaseEndgamePackage(f.ns, f.cfg, context, quote).purchased, 1);
    assert.equal(f.world.work, f.work);
});

test('disabled purchases keep training and cannot start an endgame shopping pass', async () => {
    const f = fixture(); f.cfg.purchase = false;
    assert.equal((await f.tick()).phase, 'HACKING'); assert.equal(f.world.buys.length, 0);
});
