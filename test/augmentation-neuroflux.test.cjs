const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

const NFG = 'NeuroFlux Governor';

function fixture() {
    const clock = new Clock(), events = [], files = new Map();
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    const state = { resetEpoch: '4:1:2', ownedWork: null };
    const world = { cash: 1000, price: 100, priceGrowth: 2, repRequired: 100, repGrowth: 1,
        factions: ['CyberSec'], reputation: { CyberSec: 1e9 }, offerings: { CyberSec: ['BitWire', NFG] },
        installed: [NFG], purchased: ['A', 'B', 'C', 'D', 'E'], current: null,
        buys: [], installs: [], logs: [], priceQuotes: [], repQuotes: [], buyResult: true, installResult: true };
    files.set('data/supervisor-bootstrap.json', JSON.stringify({ version: 2, args: [] }));
    const levels = () => world.purchased.filter(name => name === NFG).length;
    const price = name => name === NFG ? world.price * world.priceGrowth ** levels() : 100;
    const repRequired = name => name === NFG ? world.repRequired * world.repGrowth ** levels() : 100;
    const ns = {
        getResetInfo: () => reset, getServerMoneyAvailable: () => world.cash,
        getPlayer: () => ({ factions: world.factions, skills: { hacking: 500 }, exp: { hacking: 1000 }, mults: { hacking: 1 } }),
        fileExists: file => file === 'bootstrap.js', hasTorRouter: () => true,
        read: file => files.get(file) || '',
        write: async (file, content) => { files.set(file, content); events.push('save'); world.onWrite?.(); },
        print: message => world.logs.push(message), getFavorToDonate: () => 150,
        singularity: {
            getOwnedAugmentations: purchased => purchased ? [...world.installed, ...world.purchased] : [...world.installed],
            getAugmentationsFromFaction: faction => world.offerings[faction] || [],
            getAugmentationPrice: name => { if (name === NFG) world.priceQuotes.push(price(name)); return price(name); },
            getAugmentationRepReq: name => { if (name === NFG) world.repQuotes.push(repRequired(name)); return repRequired(name); },
            getAugmentationPrereq: () => [], getAugmentationStats: () => ({ hacking: 1.1 }),
            getFactionRep: faction => world.reputation[faction], getFactionFavor: () => 0,
            getFactionWorkTypes: () => ['hacking'], checkFactionInvitations: () => [],
            getCurrentWork: () => world.current, isBusy: () => !!world.current,
            stopAction: () => { events.push('stop'); world.current = null; return true; },
            donateToFaction: () => { throw Error('NeuroFlux must not donate'); },
            workForFaction: () => { throw Error('NeuroFlux must not start work'); },
            purchaseAugmentation: (faction, name) => {
                events.push(`buy:${name}`);
                if (world.throwPurchase) throw Error('purchase unavailable');
                if (!world.buyResult) return false;
                assert.ok(world.offerings[faction].includes(name));
                assert.ok(world.reputation[faction] >= repRequired(name));
                assert.ok(world.cash >= price(name));
                world.cash -= price(name); world.purchased.push(name); world.buys.push({ faction, name });
                world.onBuy?.(); return true;
            },
            installAugmentations: script => { events.push('install'); world.installs.push(script); return world.installResult; },
        },
    };
    const cfg = { route: false, focus: 'hacking', target: '', cashReserve: .1, priceMultiplier: 1,
        minInstall: 5, purchase: true, donate: true, work: false, joinFactions: false, programCreation: false };
    const api = loadScript('augmentation-manager.js', clock);
    return { ns, cfg, state, world, reset, events, files, clock, api,
        tick: () => api.tickAugmentationLoop(ns, cfg, state),
        pass: () => api.buyNeuroFluxBeforeInstall(ns, cfg),
        goal: (amount, extra = {}) => files.set('data/savings.json', JSON.stringify({
            version: 1, amount, label: 'Protected goal', target: 'manual', owner: 'manual', epoch: state.resetEpoch, ...extra,
        })) };
}

test('approved install buys repeated owned NeuroFlux levels with live prices, then installs the whole queue', async () => {
    const f = fixture(), status = await f.tick();
    assert.equal(status.state, 'RESETTING');
    assert.equal(status.neuroflux.purchased, 3); assert.equal(status.neuroflux.spent, 700);
    assert.equal(status.queued, 8); assert.match(status.action, /8 augmentations/);
    assert.deepEqual(f.world.buys, Array(3).fill({ faction: 'CyberSec', name: NFG }));
    assert.deepEqual(f.world.priceQuotes, [100, 200, 400, 800]);
    assert.deepEqual(f.events, ['save', `buy:${NFG}`, `buy:${NFG}`, `buy:${NFG}`, 'install']);
    assert.deepEqual(f.world.installs, ['bootstrap.js']); assert.equal(f.world.cash, 300);
    assert.match(f.world.logs[0], /bought 3 levels for 700/);
});

test('ordinary purchase completes before the final NeuroFlux pass', async () => {
    const f = fixture(); f.world.purchased = []; f.cfg.minInstall = 1;
    assert.equal((await f.tick()).phase, 'PURCHASE');
    assert.deepEqual(f.world.buys, [{ faction: 'CyberSec', name: 'BitWire' }]);
    assert.equal((await f.tick()).state, 'RESETTING');
    assert.equal(f.world.buys[0].name, 'BitWire');
    assert.ok(f.world.buys.slice(1).every(buy => buy.name === NFG));
});

test('NeuroFlux preserves the starting cash reserve across all purchases', () => {
    const f = fixture(); f.world.price = 90; f.world.priceGrowth = 1;
    assert.equal(f.pass().purchased, 10); assert.equal(f.world.cash, 100);
});

for (const [name, extra] of [
    ['manual reserve', {}],
    ['manual NeuroFlux goal', { target: `augmentation:${NFG}` }],
    ['supervisor NeuroFlux goal', { owner: 'supervisor', target: `augmentation:${NFG}` }],
    ['critical supervisor goal', { owner: 'supervisor', target: 'augmentation:The Red Pill', priority: 100 }],
]) {
    test(`final purchases preserve ${name}`, () => {
        const f = fixture(); f.goal(850, extra);
        const result = f.pass(); assert.equal(result.purchased, 1); assert.equal(f.world.cash, 900);
        assert.match(result.reason, /protected/);
    });
}

test('the pass re-reads protected savings after each purchase', () => {
    const f = fixture(); f.world.onBuy = () => f.goal(850);
    assert.equal(f.pass().purchased, 1); assert.equal(f.world.cash, 900);
});

test('a savings goal from an old epoch does not protect current cash', () => {
    const f = fixture(); f.goal(1000, { epoch: '4:1:0' });
    assert.equal(f.pass().purchased, 3);
});

test('malformed savings prevent optional spending and the installation still proceeds', async () => {
    const f = fixture(); f.files.set('data/savings.json', '{broken');
    const status = await f.tick(); assert.equal(status.state, 'RESETTING');
    assert.equal(status.neuroflux.purchased, 0); assert.equal(f.world.buys.length, 0);
});

test('each new level uses its live reputation requirement', () => {
    const f = fixture(); f.world.repGrowth = 2; f.world.reputation.CyberSec = 150;
    const result = f.pass(); assert.equal(result.purchased, 1);
    assert.deepEqual(f.world.repQuotes, [100, 200]); assert.match(result.reason, /reputation/);
});

test('only joined factions offering NeuroFlux are sellers, with the greatest existing reputation preferred', () => {
    const f = fixture(); f.world.factions = ['Gang faction', 'CyberSec', 'BitRunners'];
    f.world.offerings['Gang faction'] = ['OtherAug']; f.world.offerings.BitRunners = [NFG];
    f.world.reputation = { 'Gang faction': 1e12, CyberSec: 200, BitRunners: 1000, Daedalus: 1e12 };
    f.world.repGrowth = 2;
    assert.equal(f.pass().purchased, 3);
    assert.ok(f.world.buys.every(buy => buy.faction === 'BitRunners'));
});

test('membership, offerings and faction reputation are refreshed between purchases', () => {
    for (const change of ['membership', 'offering', 'reputation']) {
        const f = fixture(); f.world.onBuy = () => {
            if (change === 'membership') f.world.factions = [];
            if (change === 'offering') f.world.offerings.CyberSec = ['BitWire'];
            if (change === 'reputation') f.world.reputation.CyberSec = 0;
        };
        assert.equal(f.pass().purchased, 1, change);
    }
});

test('no seller or insufficient reputation skips NeuroFlux and installs without work or donations', async () => {
    for (const reason of ['no seller', 'reputation', 'unknown reputation']) {
        const f = fixture();
        if (reason === 'no seller') f.world.offerings.CyberSec = ['BitWire'];
        if (reason === 'reputation') f.world.reputation.CyberSec = 0;
        if (reason === 'unknown reputation') f.world.reputation.CyberSec = NaN;
        assert.equal((await f.tick()).state, 'RESETTING', reason);
        assert.equal(f.world.buys.length, 0, reason);
    }
});

test('purchase=false skips optional levels while preserving the existing installation policy', async () => {
    const f = fixture(); f.cfg.purchase = false;
    const status = await f.tick(); assert.equal(status.state, 'RESETTING');
    assert.equal(status.neuroflux.purchased, 0); assert.equal(f.world.buys.length, 0);
});

test('invalid live prices, rep requirements or cash reserves cannot authorize optional spending', () => {
    for (const [field, value] of [
        ['price', NaN], ['price', Infinity], ['price', 0], ['price', -1],
        ['repRequired', NaN], ['repRequired', Infinity], ['repRequired', -1],
        ['cash', NaN], ['cash', Infinity], ['cash', -1], ['cashReserve', NaN], ['cashReserve', 1],
    ]) {
        const f = fixture();
        if (field === 'cashReserve') f.cfg.cashReserve = value; else f.world[field] = value;
        assert.equal(f.pass().purchased, 0, `${field}=${value}`);
        assert.equal(f.world.buys.length, 0);
    }
});

test('a failed purchase or unavailable optional API stops the pass and still installs', async () => {
    for (const failure of ['false', 'purchase throws', 'quote throws']) {
        const f = fixture();
        if (failure === 'false') f.world.buyResult = false;
        if (failure === 'purchase throws') f.world.throwPurchase = true;
        if (failure === 'quote throws') f.ns.singularity.getAugmentationPrice = () => { throw Error('quote unavailable'); };
        const status = await f.tick(); assert.equal(status.state, 'RESETTING', failure);
        assert.equal(status.neuroflux.purchased, 0, failure);
    }
});

test('a failure after a successful level retains its count and does not delay installation', async () => {
    const f = fixture(); f.world.onBuy = () => { f.world.buyResult = false; };
    const status = await f.tick(); assert.equal(status.state, 'RESETTING');
    assert.equal(status.queued, 6); assert.equal(status.neuroflux.purchased, 1);
});

test('the synchronous pass has a hard purchase bound and installs immediately at that bound', async () => {
    const f = fixture(); f.world.cash = 1e9; f.world.price = 1; f.world.priceGrowth = 1;
    const status = await f.tick(); assert.equal(status.state, 'RESETTING');
    assert.equal(status.neuroflux.purchased, 100); assert.equal(status.queued, 105);
    assert.match(status.neuroflux.reason, /100-level purchase limit/);
    assert.equal(f.events.at(-1), 'install');
});

test('bootstrap, settings, unrelated activity and failed owned-work release block spending before install', async () => {
    for (const reason of ['bootstrap', 'settings', 'manual', 'busy', 'stop']) {
        const f = fixture();
        if (reason === 'bootstrap') f.ns.fileExists = () => false;
        if (reason === 'settings') f.files.set('data/supervisor-bootstrap.json', '{}');
        if (reason === 'manual') f.world.current = { type: 'CRIME' };
        if (reason === 'busy') f.ns.singularity.isBusy = () => true;
        if (reason === 'stop') {
            f.world.current = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' };
            f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' }; f.ns.singularity.stopAction = () => false;
        }
        assert.equal((await f.tick()).state, 'BLOCKED', reason);
        assert.equal(f.world.buys.length + f.world.installs.length, 0, reason);
    }
});

test('owned faction work is released before any NeuroFlux purchase', async () => {
    const f = fixture();
    f.world.current = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' };
    f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' };
    assert.equal((await f.tick()).state, 'RESETTING'); assert.equal(f.events[0], 'stop');
    assert.equal(f.world.buys.length, 3); assert.equal(f.state.ownedWork, null);
});

test('epoch or player activity changes during state saving prevent the final purchases', async () => {
    for (const change of ['epoch', 'activity']) {
        const f = fixture(); f.world.onWrite = () => {
            if (change === 'epoch') f.reset.lastAugReset++;
            else f.world.current = { type: 'CLASS' };
        };
        assert.equal((await f.tick()).state, 'BLOCKED', change);
        assert.equal(f.world.buys.length + f.world.installs.length, 0, change);
    }
});

test('a queue emptied during state saving cannot be replaced by a NeuroFlux-triggered reset', async () => {
    const f = fixture(); f.world.onWrite = () => { f.world.purchased = []; };
    assert.equal((await f.tick()).state, 'WAITING'); assert.equal(f.world.buys.length + f.world.installs.length, 0);
});

test('epoch and activity are checked again after the optional pass', async () => {
    for (const change of ['epoch', 'activity']) {
        const f = fixture(); f.world.onBuy = () => {
            if (change === 'epoch') f.reset.lastAugReset++;
            else f.world.current = { type: 'CLASS' };
        };
        assert.equal((await f.tick()).state, 'BLOCKED', change);
        assert.equal(f.world.buys.length, 1, change);
        assert.equal(f.world.installs.length, 0, change);
    }
});

test('a failed installation retry cannot run another NeuroFlux spending pass', async () => {
    const f = fixture(); f.world.price = 90; f.world.priceGrowth = 1; f.world.installResult = false;
    assert.equal((await f.tick()).state, 'BLOCKED'); assert.equal(f.world.buys.length, 10);
    // main persists the returned state even when installAugmentations fails.
    await f.api.saveState(f.ns, f.state);
    const restartedState = f.api.loadState(f.ns);
    f.world.cash = 1000; f.world.installResult = true;
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, restartedState)).state, 'RESETTING');
    assert.equal(f.world.buys.length, 10);
    assert.equal(f.world.cash, 1000);
});

test('a new augmentation reset clears the pass record and allows the next approved batch', async () => {
    const f = fixture(); await f.tick(); assert.equal(f.world.buys.length, 3);
    f.reset.lastAugReset++; f.world.purchased = ['A', 'B', 'C', 'D', 'E']; f.world.cash = 1000;
    assert.equal((await f.tick()).state, 'RESETTING'); assert.equal(f.world.buys.length, 6);
    assert.equal(f.state.neurofluxPass.epoch, '4:1:3');
});

test('route WAIT finishes the ordinary basket, then the approved complete-batch reset buys NeuroFlux', async () => {
    const f = fixture(); f.cfg.route = true;
    f.ns.getHackingLevel = () => 500; f.ns.serverExists = () => false;
    const waiting = await f.tick();
    assert.equal(waiting.resetDecision.fallback.action, 'WAIT'); assert.equal(waiting.phase, 'PURCHASE');
    assert.deepEqual(f.world.buys, [{ faction: 'CyberSec', name: 'BitWire' }]);
    assert.equal(f.world.priceQuotes.length + f.world.installs.length, 0);
    const installing = await f.tick(); assert.equal(installing.state, 'RESETTING');
    assert.equal(installing.resetDecision.action, 'INSTALL'); assert.equal(installing.neuroflux.purchased, 3);
});

test('a distinct Daedalus-count installation buys optional levels without changing its approval', async () => {
    const f = fixture(); f.cfg.route = true;
    f.world.installed = Array.from({ length: 29 }, (_, i) => `Old${i}`); f.world.purchased = ['New'];
    const status = await f.tick(); assert.equal(status.state, 'RESETTING');
    assert.match(status.resetDecision.reason, /Daedalus/); assert.equal(status.neuroflux.purchased, 3);
});

test('below-threshold and empty queues never buy NeuroFlux to cause installation', async () => {
    for (const purchased of [[], ['A', 'B', 'C', 'D']]) {
        const f = fixture(); f.world.purchased = purchased;
        assert.notEqual((await f.tick()).state, 'RESETTING');
        assert.ok(f.world.buys.every(buy => buy.name !== NFG)); assert.equal(f.world.installs.length, 0);
    }
});

test('queued Red Pill gets a bounded pass and installs; installed Red Pill buys no more levels', async () => {
    const f = fixture(); f.world.purchased = ['The Red Pill'];
    assert.equal((await f.tick()).state, 'RESETTING'); assert.equal(f.world.buys.length, 3);
    const done = fixture(); done.world.installed.push('The Red Pill');
    assert.equal((await done.tick()).phase, 'COMPLETE_NODE');
    assert.equal(done.world.buys.length + done.world.installs.length, 0);
});

test('a locked Singularity capability never calls NeuroFlux APIs', async () => {
    const f = fixture(); f.reset.currentNode = 1;
    f.ns.singularity = new Proxy({}, { get() { throw Error('Singularity unavailable'); } });
    assert.equal((await f.tick()).phase, 'UNLOCK'); assert.equal(f.world.buys.length, 0);
});
