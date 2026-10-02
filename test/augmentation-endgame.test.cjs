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
        bootstrap: true, formulas: true, measured: true, producer: true, priceFactor: 1, goBonus: 0, scriptRate: 10000,
        skillMult: 20, xpRate: 10000, xp: null, income: 1000, backgroundPrep: false, suspended: false,
        favor: 0, workRep: 1000, donations: [], workStarts: [], stable: true };
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
            mults: { hacking: world.skillMult }, exp: { hacking: world.xp ?? expFor(world.hacking, world.skillMult) } }),
        getBitNodeMultipliers: () => ({ HackingLevelMultiplier: 1 }), getPortHandle: n => ports.get(n),
        ps: () => world.producer ? [{ filename: 'daemon.js', pid: 20 }] : [],
        getServerMoneyAvailable: () => world.cash, getHackingLevel: () => world.hacking,
        serverExists: () => true, getServerRequiredHackingLevel: () => world.required,
        getServer: () => ({ backdoorInstalled: false }), hasRootAccess: () => true,
        getScriptRam: () => 4, getServerMaxRam: () => 65536, getServerUsedRam: () => 100, getFavorToDonate: () => 150,
        run: () => assert.fail('this fixture must stay below the final hacking requirement'),
        fileExists: name => name === 'Formulas.exe' ? world.formulas : name === 'bootstrap.js' && world.bootstrap,
        read: name => files.get(name) || '', write: async (name, data) => { files.set(name, data); world.onSave?.(); }, print() {},
        formulas: { skills: { calculateExp: expFor },
            reputation: { donationForRep: gap => gap * 1e6 },
            work: { factionGains: () => ({ reputation: world.workRep / 5 }) } },
        go: { analysis: { getStats: () => ({ Illuminati: { bonusPercent: world.goBonus } }) } },
        singularity: { getOwnedAugmentations: all => [...world.installed, ...(all ? world.pending : [])],
            getAugmentationsFromFaction: () => world.offers, getAugmentationStats: stats,
            getAugmentationPrice: price, getAugmentationRepReq: rep, getAugmentationPrereq: () => [], getFactionRep: () => world.rep,
            getFactionFavor: () => world.favor, getFactionWorkTypes: () => ['hacking'],
            isBusy: () => !!world.work, getCurrentWork: () => world.work,
            stopAction: () => { world.stops++; world.work = null; return true; },
            universityCourse: () => { world.work = work; return true; },
            workForFaction: (faction, workType) => {
                world.workStarts.push({ faction, workType });
                world.work = { type: 'FACTION', factionName: faction, factionWorkType: workType }; return true;
            },
            donateToFaction: (faction, amount) => {
                world.cash -= amount; world.rep += amount / 1e6;
                world.donations.push({ faction, amount }); return true;
            },
            purchaseAugmentation: (faction, name) => {
                world.cash -= price(name); world.pending.push(name); world.buys.push({ faction, name }); world.onBuy?.(); return true;
            },
            installAugmentations: script => { world.installs.push(script); return true; },
        } };
    const refresh = () => { ports.get(17).clear(); ports.get(17).write({ type: 'jit-status', version: 2, pid: 20,
        generatedAt: clock.now, income60: world.income,
        pipelines: [{ mode: world.stable ? 'LIVE' : 'PREP' }, ...(world.backgroundPrep ? [{ mode: 'PREP' }] : [])],
        prepRam: world.backgroundPrep ? 8 : 0, policy: { balance: {
            milestone: 'FINAL_SERVER', requiredHacking: world.required, requiredCash: 0, generatedAt: clock.now,
            suspended: world.suspended,
            xpSource: world.measured ? 'measured' : 'UNKNOWN', xpRate: world.xpRate, scriptXpRate: world.scriptRate,
            cashSource: 'UNKNOWN', cashRate: null } } }); };
    const api = loadScript('augmentation-manager.js', clock), planner = loadScript('lib/augmentation-endgame.js', clock);
    const contextApi = loadScript('lib/augmentation-context.js', clock), cfg = { route: true, work: true, purchase: true,
        cashReserve: .1, minInstall: 5, resetPolicy: 'auto', focusWork: false, donate: true };
    const context = () => { refresh(); return contextApi.augmentationContext(ns, state); };
    const tick = async () => { refresh(); return api.tickAugmentationLoop(ns, cfg, state); };
    return { clock, reset, files, world, ns, state, cfg, planner, api, context, tick, work };
}

function firstEndgame() {
    const f = fixture(); f.state.recoveryProfile.samples = [];
    Object.assign(f.world, { hacking: 4134, skillMult: 7, xpRate: 9.69e6, scriptRate: 9.69e6,
        goBonus: 88.769, cash: 271.8e12, rep: 0, priceFactor: 1000, offers: [NFG] });
    return f;
}

async function finishObservation(f) {
    let status;
    for (let i = 0; i < 12; i++) { f.clock.now += 5000; status = await f.tick(); }
    return status;
}

async function observeActualXp(f, seconds, rate = f.world.xpRate) {
    let status;
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
        f.clock.now += 5000; f.world.xp += rate * 5;
        if (Number.isFinite(f.world.xp)) f.world.hacking = Math.max(1, Math.floor(f.world.skillMult * (32 * Math.log(f.world.xp + 534) - 200)));
        status = await f.tick();
    }
    return status;
}

for (const goBonus of [100, 300, 1000]) {
    test(`4288 hacking and 476t fund and install NeuroFlux using actual XP despite suspended daemon evidence and ${goBonus}% Go power`, async () => {
        const f = firstEndgame();
        Object.assign(f.world, { hacking: 4288, cash: 476e12, favor: 235, goBonus,
            measured: false, suspended: true, backgroundPrep: true });
        f.world.xp = expFor(f.world.hacking, f.world.skillMult);
        const start = await f.tick();
        assert.match(start.endgame.reason, /observing actual player XP \(0\/3 stable 20s windows\)/);
        assert.ok(start.endgame.quote.neurofluxLevels > 5);
        assert.equal(f.world.donations.length + f.world.buys.length + f.world.installs.length, 0);
        await observeActualXp(f, 55);
        assert.equal(f.world.donations.length + f.world.buys.length, 0, 'models must not bypass measurement warmup');
        const funded = await observeActualXp(f, 5);
        assert.equal(funded.phase, 'DONATE'); assert.equal(f.world.donations.length, 1);
        assert.equal(funded.endgame.xp.source, 'manager measured');
        assert.ok(Math.abs(funded.endgame.xp.rate - f.world.xpRate) < 1);
        assert.ok(funded.endgame.resetEtaMs <= funded.endgame.continueEtaMs * .5);
        const bought = await observeActualXp(f, 5);
        assert.ok(bought.queued > 5); assert.equal(bought.endgame.neurofluxQueued, bought.queued);
        assert.ok(f.world.buys.every(b => b.name === NFG));
        assert.equal(f.world.installs.length, 0);
        const installed = await observeActualXp(f, 60);
        assert.equal(installed.state, 'RESETTING'); assert.deepEqual(f.world.installs, ['bootstrap.js']);
        assert.equal(f.state.recoveryProfile.samples.length, 0, 'actual XP samples must not invent recovery history');
    });
}

for (const changed of ['zero', 'noisy', 'stale', 'reset', 'multiplier', 'work', 'goal', 'invalid-xp']) {
    test(`actual XP cannot admit purchases with ${changed} observations`, async () => {
        const f = firstEndgame(); f.world.favor = 235; f.world.measured = false;
        f.world.xp = expFor(f.world.hacking, f.world.skillMult);
        await f.tick(); await observeActualXp(f, 40);
        if (changed === 'stale') f.clock.now += 60000;
        if (changed === 'reset') f.reset.lastAugReset = f.clock.now;
        if (changed === 'multiplier') f.world.skillMult *= 1.01;
        if (changed === 'work') f.world.work = { type: 'CRIME', crimeType: 'Heist' };
        if (changed === 'goal') f.world.required++;
        if (changed === 'invalid-xp') f.world.xp = NaN;
        const status = await observeActualXp(f, 20, changed === 'zero' ? 0 : changed === 'noisy' ? f.world.xpRate * 10 : f.world.xpRate);
        assert.equal(f.world.donations.length + f.world.buys.length + f.world.installs.length, 0);
        assert.equal(status.endgame.xp.rate, null); assert.match(status.endgame.reason, /Measured hacking XP rate unavailable/);
    });
}

test('manager XP measurements survive neither an augmentation reset nor stale daemon fallback', async () => {
    const f = firstEndgame(); f.world.favor = 235; f.world.measured = false;
    f.world.xp = expFor(f.world.hacking, f.world.skillMult);
    await f.tick(); await observeActualXp(f, 60); await observeActualXp(f, 5); await observeActualXp(f, 60);
    assert.equal(f.world.installs.length, 1);
    f.world.installed.push(...f.world.pending); f.world.pending = []; f.world.rep = 0;
    f.world.skillMult *= 1.01 ** f.world.buys.length; f.world.xp = 0; f.world.hacking = 1; f.world.cash = 476e12;
    f.clock.now += 5000; f.reset.lastAugReset = f.clock.now;
    const reset = await f.tick(), boughtBefore = f.world.buys.length;
    assert.equal(reset.endgame.xp.rate, null); assert.equal(reset.endgame.xp.samples, 0);
    assert.equal(f.state.endgameXp.xp.length, 0);
    assert.match(reset.endgame.reason, /observing actual player XP/);
    await observeActualXp(f, 55);
    assert.equal(f.world.buys.length, boughtBefore); assert.equal(f.world.installs.length, 1);
    const funded = await observeActualXp(f, 10);
    assert.equal(funded.phase, 'DONATE'); assert.equal(f.world.donations.length, 2);
    assert.equal(funded.endgame.xp.source, 'manager measured');
});

test('first endgame cycle donates from zero rep, buys repeatable NeuroFlux and installs without historical recovery samples', async () => {
    const f = firstEndgame(); f.world.favor = 200;
    const funded = await f.tick();
    assert.equal(funded.phase, 'DONATE'); assert.equal(f.world.donations.length, 1);
    assert.equal(f.world.work, f.work); assert.equal(f.world.buys.length, 0);
    f.clock.now += 5000; const bought = await f.tick();
    assert.ok(bought.queued > 5); assert.ok(f.world.buys.every(b => b.name === NFG));
    assert.equal(bought.resetDecision.confidence, 'LOW'); assert.equal(bought.resetDecision.recoverySource, 'conservative');
    assert.equal(bought.resetDecision.recoveryMs, 86400000);
    assert.equal(bought.progression.resetPending, true, 'fleet must hold capital during the approved reset observation');
    assert.ok(bought.endgame.resetEtaMs <= bought.endgame.continueEtaMs * .5);
    assert.equal(f.state.recoveryProfile.samples.length, 0, 'an allowance must not become measured history');
    assert.equal(f.world.installs.length, 0);
    const status = await finishObservation(f);
    assert.equal(status.state, 'RESETTING'); assert.deepEqual(f.world.installs, ['bootstrap.js']);
    assert.equal(f.world.stops, 1);
});

test('first endgame cycle earns rep with owned faction work, keeps a fixed package target and resumes hacking before installation', async () => {
    const f = firstEndgame(); const start = await f.tick();
    assert.equal(start.phase, 'REPUTATION'); assert.equal(start.endgame.funding.strategy, 'WORK');
    assert.equal(start.progression.sharingDemand, 'SPARE_ONLY');
    assert.equal(f.world.work.factionName, 'Daedalus'); assert.equal(f.world.workStarts.length, 1);
    const target = start.endgame.funding.requiredRep, count = start.endgame.funding.purchaseLimit;
    f.world.cash *= 1000; f.clock.now += 30000;
    const working = await f.tick();
    assert.equal(working.endgame.funding.requiredRep, target, 'income growth must not move the reputation goal');
    assert.equal(working.endgame.funding.purchaseLimit, count); assert.equal(f.world.workStarts.length, 1);
    f.world.rep = target; f.clock.now += 5000; const bought = await f.tick();
    assert.equal(bought.phase, 'HACKING'); assert.equal(f.world.buys.length, count);
    assert.equal(bought.progression.sharingDemand, 'OFF');
    assert.equal(f.world.work, f.work); assert.equal(f.state.ownedWork, null);
    assert.equal((await finishObservation(f)).state, 'RESETTING');
});

test('a subsequent augmentation reset clears funding ownership and runs another NeuroFlux cycle from zero reputation', async () => {
    const f = firstEndgame(); f.world.favor = 200;
    await f.tick(); f.clock.now += 5000; await f.tick(); await finishObservation(f);
    const firstCount = f.world.buys.length;
    f.world.skillMult *= 1.01 ** firstCount;
    f.world.installed.push(...f.world.pending); f.world.pending = []; f.world.rep = 0;
    f.world.hacking = 2500; f.world.cash = 271.8e12;
    f.clock.now += 5000; f.reset.lastAugReset = f.clock.now;
    const funded = await f.tick();
    assert.equal(funded.phase, 'DONATE'); assert.equal(f.world.donations.length, 2);
    assert.equal(f.state.resetEpoch, `4:1:${f.reset.lastAugReset}`);
    f.clock.now += 5000; const bought = await f.tick();
    assert.ok(f.world.buys.length > firstCount); assert.ok(bought.queued > 0);
    assert.equal((await finishObservation(f)).state, 'RESETTING');
    assert.equal(f.world.installs.length, 2);
});

test('endgame reputation acquisition preserves unrelated manual work', async () => {
    const f = firstEndgame(); f.world.work = { type: 'CRIME', crimeType: 'Heist' };
    const current = f.world.work, status = await f.tick();
    assert.equal(status.state, 'BLOCKED'); assert.equal(status.phase, 'REPUTATION');
    assert.match(status.recommendation, /Preserving current CRIME/);
    assert.equal(f.world.work, current); assert.equal(f.world.workStarts.length + f.world.stops, 0);
    assert.equal(f.world.donations.length + f.world.buys.length + f.world.installs.length, 0);
});

test('disabled donations use faction work; disabled work still allows eligible donations', async () => {
    const work = firstEndgame(); work.world.favor = 200; work.cfg.donate = false;
    assert.equal((await work.tick()).phase, 'REPUTATION'); assert.equal(work.world.donations.length, 0);
    const donate = firstEndgame(); donate.world.favor = 200; donate.cfg.work = false;
    assert.equal((await donate.tick()).phase, 'DONATE'); assert.equal(donate.world.workStarts.length, 0);
});

test('a long reputation detour cannot justify funding an otherwise useful package', async () => {
    const f = firstEndgame(); f.world.workRep = 1e-12;
    const status = await f.tick();
    assert.equal(status.phase, 'HACKING'); assert.match(status.endgame.reason, /current multipliers/);
    assert.equal(f.world.workStarts.length + f.world.donations.length + f.world.buys.length, 0);
});

test('an ordinary augmentation with excessive rep time cannot hide a useful NeuroFlux package', async () => {
    const f = firstEndgame(), repReq = f.ns.singularity.getAugmentationRepReq;
    f.world.offers.push('Neural Accelerator');
    f.ns.singularity.getAugmentationRepReq = name => name === 'Neural Accelerator' ? 1e20 : repReq(name);
    const funded = await f.tick();
    assert.equal(funded.phase, 'REPUTATION'); assert.equal(funded.endgame.funding.neurofluxOnly, true);
    assert.ok(funded.endgame.funding.requiredRep < 1e8);
    f.world.rep = funded.endgame.funding.requiredRep; f.clock.now += 5000;
    assert.ok((await f.tick()).queued > 5); assert.ok(f.world.buys.every(b => b.name === NFG));
});

test('an oversized NeuroFlux rep target is reduced when a smaller package finishes sooner', async () => {
    const f = firstEndgame(); f.world.workRep = 1e-9;
    const largest = f.planner.quoteEndgamePackage(f.ns, f.cfg, f.context(), { fundReputation: true });
    const funded = await f.tick();
    assert.equal(funded.phase, 'REPUTATION');
    assert.ok(funded.endgame.funding.purchaseLimit < largest.purchases.length);
    assert.ok(funded.endgame.resetEtaMs <= funded.endgame.continueEtaMs * .5);
});

test('the original percentage reserve survives donations, purchases and the optional pre-install fill', async () => {
    const f = firstEndgame(); f.world.favor = 200; f.world.cash = 1e11; f.cfg.work = false;
    // Make rep expensive enough that donation shrinks the bank balance materially.
    f.ns.formulas.reputation.donationForRep = gap => gap * 1e7;
    f.ns.singularity.donateToFaction = (faction, amount) => {
        f.world.cash -= amount; f.world.rep += amount / 1e7;
        f.world.donations.push({ faction, amount }); return true;
    };
    const floor = f.world.cash * f.cfg.cashReserve;
    await f.tick(); f.clock.now += 5000; const status = await f.tick();
    assert.ok(status.queued > 0); assert.equal(f.state.endgameFundingFloor, floor);
    assert.ok(f.world.cash >= floor); await finishObservation(f); assert.ok(f.world.cash >= floor);
});

test('reputation funding selects a donation-eligible seller instead of only the faction with most current rep', () => {
    const f = firstEndgame(), getPlayer = f.ns.getPlayer;
    f.ns.getPlayer = () => ({ ...getPlayer(), factions: ['Daedalus', 'NiteSec'] });
    f.ns.singularity.getFactionRep = faction => faction === 'Daedalus' ? 1000 : 0;
    f.ns.singularity.getFactionFavor = faction => faction === 'NiteSec' ? 200 : 0;
    const q = f.planner.quoteEndgamePackage(f.ns, f.cfg, f.context(), { fundReputation: true });
    assert.ok(q.purchases.length > 5); assert.equal(q.funding.length, 1);
    assert.equal(q.funding[0].faction, 'NiteSec'); assert.equal(q.funding[0].strategy, 'DONATE');
});

test('donation and purchase quote reserves their combined cost and keeps existing savings locked', async () => {
    const f = firstEndgame(); f.world.favor = 200;
    const floor = f.world.cash * .6;
    f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual', amount: floor,
        target: 'manual', label: 'Reserved', epoch: f.state.resetEpoch }));
    const q = f.planner.quoteEndgamePackage(f.ns, f.cfg, f.context(), { fundReputation: true });
    assert.ok(q.donationCost > 0); assert.equal(q.cost, q.purchaseCost + q.donationCost);
    assert.ok(f.world.cash - q.cost >= floor);
    await f.tick(); f.clock.now += 5000; await f.tick();
    assert.ok(f.world.cash >= floor); assert.ok(f.world.buys.length > 0);
});

for (const changed of ['price', 'favor', 'factions', 'savings', 'epoch', 'completed', 'exclusive', 'disabled', 'formulas']) {
    test(`endgame donation rechecks changed ${changed} before spending`, () => {
        const f = firstEndgame(); f.world.favor = 200;
        const context = f.context(), q = f.planner.quoteEndgamePackage(f.ns, f.cfg, context, { fundReputation: true });
        assert.equal(q.funding[0].strategy, 'DONATE');
        if (changed === 'price') f.world.priceFactor *= 10000;
        if (changed === 'favor') f.world.favor = 0;
        if (changed === 'factions') f.ns.getPlayer = () => ({ ...context.player, factions: [] });
        if (changed === 'savings') f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual',
            amount: f.world.cash, target: 'manual', label: 'Reserved', epoch: f.state.resetEpoch }));
        if (changed === 'epoch') f.reset.lastAugReset++;
        if (changed === 'completed') f.world.hacking = 9000;
        if (changed === 'exclusive') { f.world.work = null; f.ns.singularity.isBusy = () => true; }
        if (changed === 'disabled') f.cfg.donate = false;
        if (changed === 'formulas') f.world.formulas = false;
        const result = f.planner.donateEndgameReputation(f.ns, f.cfg, context, q, q.funding[0]);
        assert.equal(result.donated, false); assert.equal(f.world.donations.length, 0);
    });
}

test('failed endgame donations cool down without repeated spending attempts', async () => {
    const f = firstEndgame(); f.world.favor = 200; let attempts = 0;
    f.ns.singularity.donateToFaction = () => { attempts++; return false; };
    assert.equal((await f.tick()).state, 'BLOCKED');
    for (let i = 0; i < 11; i++) { f.clock.now += 5000; await f.tick(); }
    assert.equal(attempts, 1);
    f.clock.now += 5000; await f.tick(); assert.equal(attempts, 2);
    assert.equal(f.world.workStarts.length + f.world.buys.length, 0);
});

for (const guard of ['bootstrap', 'settings', 'permanent-ram', 'productive-engine', 'income']) {
    test(`first reset projection needs verified ${guard}`, async () => {
        const f = firstEndgame(); f.world.rep = 1e8;
        if (guard === 'bootstrap') f.world.bootstrap = false;
        if (guard === 'settings') f.files.set('data/supervisor-bootstrap.json', '{}');
        if (guard === 'permanent-ram') f.ns.getServerMaxRam = () => 8;
        if (guard === 'productive-engine') f.world.stable = false;
        if (guard === 'income') f.world.income = 0;
        const status = await f.tick();
        assert.equal(f.world.buys.length + f.world.installs.length, 0); assert.equal(status.resetDecision.advantage, undefined);
        assert.match(status.endgame.reason, /recovery unavailable/i);
    });
}

test('measured recovery is preferred to the first-reset allowance', async () => {
    const f = fixture(), status = await f.tick();
    assert.equal(status.resetDecision.recoverySource, 'measured');
    assert.equal(status.resetDecision.recoveryMs, 90000); assert.equal(status.resetDecision.confidence, 'MEDIUM');
});

test('a weak or nearly completed first endgame queue cannot trigger a blind threshold reset', async () => {
    for (const nearGoal of [false, true]) {
        const f = firstEndgame(); f.cfg.purchase = false;
        f.world.pending = Array(nearGoal ? 30 : 1).fill(NFG);
        if (nearGoal) f.world.hacking = 8995;
        f.state.queuedSince = f.clock.now - 7200000;
        assert.equal((await finishObservation(f)).resetDecision.action, 'WAIT');
        assert.equal(f.world.installs.length, 0);
    }
});

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
    const scripts = fixture(); Object.assign(scripts.world, { goBonus: 1000, cash: 1e7, offers: [NFG] });
    assert.equal((await scripts.tick()).phase, 'HACKING'); assert.equal(scripts.world.buys.length, 0);
    const classes = fixture(); Object.assign(classes.world, { goBonus: 1000, cash: 1e7, offers: [NFG], scriptRate: 0 });
    assert.equal((await classes.tick()).resetDecision.advantage, true);
    assert.ok(classes.world.buys.length > 0);
});

test('a strong hacking package can outweigh high Go reset loss before its conservative benefit is capped', async () => {
    const f = fixture(); f.world.goBonus = 1000;
    const status = await f.tick();
    assert.equal(status.resetDecision.advantage, true); assert.ok(f.world.buys.length > 5);
    assert.equal(status.resetDecision.installNow.packageBenefit, 4);
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

for (const missing of ['formulas', 'rate', 'producer', 'multipliers']) {
    test(`endgame with missing ${missing} explains uncertainty without shopping or resetting`, async () => {
        const f = fixture();
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
    const status = await f.tick();
    assert.equal(status.phase, 'HACKING'); assert.equal(f.world.buys.length, 0);
    assert.match(status.endgame.reason, /disabled/i);
});

for (const blocker of ['reputation', 'cash', 'factions', 'prerequisites']) {
    test(`empty endgame quote identifies ${blocker} instead of merely saying the queue is empty`, async () => {
        const f = fixture();
        if (blocker === 'reputation') { f.world.rep = 0; f.cfg.work = false; f.cfg.donate = false; }
        if (blocker === 'cash') f.files.set('data/savings.json', JSON.stringify({ version: 1, owner: 'manual', amount: f.world.cash - 500000,
            target: 'manual', label: 'Reserved', epoch: f.state.resetEpoch }));
        if (blocker === 'factions') f.world.offers = [];
        if (blocker === 'prerequisites') {
            f.world.offers = ['Neural Accelerator']; f.ns.singularity.getAugmentationPrereq = () => ['Missing predecessor'];
        }
        const status = await f.tick();
        const patterns = { reputation: /reputation insufficient.*NeuroFlux.*Daedalus/i, cash: /unreserved cash/i,
            factions: /No joined faction/i, prerequisites: /prerequisites missing/i };
        assert.match(status.endgame.reason, patterns[blocker]);
        assert.equal(status.resetDecision.reason, status.endgame.reason);
        assert.equal(status.phase, 'HACKING'); assert.equal(f.world.buys.length + f.world.installs.length, 0);
    });
}
