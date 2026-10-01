const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), files = new Map(), ports = new Map(), state = {}, writes = [];
    const world = { name: 'DonationAug', factions: ['BitRunners'], rep: 0, repRequired: 1e6, favor: 150,
        price: 5e9, cash: 8e9, rate: 1e6 / 720, income: 17.8e9 / 180, donationPerRep: 20000,
        formulas: true, current: null, owned: [], works: [], donations: [], purchases: [], quotes: [] };
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    const processes = [{ pid: 10, filename: 'augmentation-manager.js' }, { pid: 7, filename: 'daemon.js' },
        { pid: 1, filename: 'supervisor.js' }, { pid: 9, filename: 'fleet-manager.js' }];
    const ns = { pid: 10, getHostname: () => 'home', getResetInfo: () => reset, ps: () => processes,
        isRunning: pid => processes.some(p => p.pid === pid),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        read: f => files.get(f) || '', write: async (f, value) => { files.set(f, value); writes.push(f); },
        fileExists: f => f !== 'Formulas.exe' || world.formulas, hasTorRouter: () => true, serverExists: () => false,
        getServerMoneyAvailable: () => world.cash, getFavorToDonate: () => 150,
        getPlayer: () => ({ factions: world.factions, skills: { hacking: 500 }, exp: { hacking: 1000 }, mults: { hacking: 1 } }),
        formulas: { work: { factionGains: () => ({ reputation: world.rate / 5 }) },
            reputation: { donationForRep: rep => { world.quotes.push(rep); return rep * world.donationPerRep; } } },
        singularity: { getOwnedAugmentations: purchased => purchased ? world.owned : [],
            getAugmentationsFromFaction: () => [world.name], getAugmentationPrereq: () => [],
            getAugmentationStats: () => ({ hacking: 1.1 }), getAugmentationPrice: () => world.price,
            getAugmentationRepReq: () => world.repRequired, getFactionRep: () => world.rep,
            getFactionFavor: () => world.favor, getFactionWorkTypes: () => ['hacking'],
            getCurrentWork: () => world.current, isFocused: () => true, isBusy: () => !!world.current,
            checkFactionInvitations: () => [],
            workForFaction: (faction, type) => { world.works.push(faction); world.current = { type: 'FACTION', factionName: faction, factionWorkType: type }; return true; },
            donateToFaction: (faction, amount) => { world.donations.push(amount); world.cash -= amount; world.rep += amount / world.donationPerRep; return true; },
            purchaseAugmentation: (faction, name) => { assert.ok(world.rep >= world.repRequired); world.cash -= world.price; world.owned.push(name); world.purchases.push(name); return true; } } };
    const cfg = { focus: 'hacking', target: '', cashReserve: .1, joinFactions: false, route: false, programCreation: false,
        work: true, donate: true, purchase: true, focusWork: true, minInstall: 5, priceMultiplier: 1 };
    const planner = loadScript('lib/augmentation-plan.js', clock), contextApi = loadScript('lib/augmentation-context.js', clock);
    const objectiveApi = loadScript('lib/progression-objective.js', clock), savings = loadScript('lib/savings.js', clock);
    const supervisor = loadScript('lib/supervised-utilities.js', clock), manager = loadScript('augmentation-manager.js', clock);
    const savingsCfg = { savingsMode: 'auto', progression: false, augmentationActions: true, augmentationCashReserve: .1 };
    const refreshIncome = () => { const p = ns.getPortHandle(17); p.clear(); p.write({ type: 'jit-status', version: 2,
        pid: 7, generatedAt: clock.now, income60: world.income, pipelines: [{ mode: 'LIVE' }], prepRam: 0 }); };
    const plan = () => { refreshIncome(); const context = contextApi.augmentationContext(ns, state);
        return planner.buildAugmentationPlan(ns, { context, state, target: cfg.target, cashReserve: cfg.cashReserve,
            donate: cfg.donate, focusWork: cfg.focusWork, multiplier: 1 }); };
    const publish = plan => {
        const context = contextApi.augmentationContext(ns, state), progression = contextApi.makeProgressionSnapshot(ns, context, { plan });
        const status = { type: 'augmentation-status', version: 1, producerPid: 10, resetEpoch: '4:1:2',
            generatedAt: clock.now, plan, progression };
        const port = ns.getPortHandle(11); port.clear(); port.write(status); return status;
    };
    const save = async (plan, extras = {}, fleet = null) => {
        const status = publish(plan);
        await supervisor.updateSupervisorSavings({ ...ns, pid: 1 }, { ...savingsCfg, ...extras }, plan, null, status, fleet);
        return JSON.parse(files.get('data/savings.json'));
    };
    const tick = async () => { refreshIncome(); return manager.tickAugmentationLoop(ns, cfg, state); };
    return { clock, ns, world, cfg, state, files, writes, reset, savingsCfg, savings, planner, objectiveApi, supervisor,
        manager, plan, publish, save, tick, goal: () => JSON.parse(files.get('data/savings.json')) };
}

test('authoritative funding adds the selected donation once and ignores acquisitionCost', () => {
    const api = loadScript('lib/augmentation-funding.js', new Clock());
    const next = { price: 5e9, donationCost: 20e9, donationPlanned: true, acquisitionCost: 25e9, repGap: 1 };
    assert.equal(api.augmentationFundingCost(next), 25e9);
    assert.equal(api.augmentationFundingCost({ ...next, donationPlanned: false }), 5e9);
    assert.equal(api.augmentationFundingCost({ ...next, chainCost: 30e9, donationCost: 5e9 }), 35e9);
    assert.equal(api.augmentationFundingCost(null), 0);
    assert.equal(api.augmentationReputationStrategy({ ...next, repGap: 0 }), 'NONE');
});

test('selected plan publishes authenticated work-rate provenance without treating a donation as work', () => {
    const f = fixture(); f.cfg.donate = false;
    assert.equal(f.plan().next.rateSource, 'model');
    assert.equal(f.plan().next.workActive, false);
    f.world.current = { type: 'FACTION', factionName: 'BitRunners' };
    f.plan(); f.clock.now += 1000; f.world.rep += 200;
    const measured = f.plan(), p = f.publish(measured).progression;
    assert.equal(measured.next.rate, 200); assert.equal(p.selectedPlan.next.rateSource, 'measured');
    assert.equal(p.selectedPlan.next.workActive, true);
    f.state.lastDonation = { faction: 'BitRunners', at: f.clock.now };
    f.clock.now += 1000; f.world.rep += 500;
    assert.equal(f.plan().next.rateSource, 'model');
    f.world.current = null; f.world.formulas = false;
    const unknown = f.plan().next;
    assert.equal(unknown.rateSource, 'unknown'); assert.equal(unknown.workActive, false);
});

for (const [workSeconds, donationSeconds, donate] of [[720, 180, true], [120, 420, false], [180, 180, false]]) {
    test(`seller retains ${donate ? 'donation' : 'work'} for work ${workSeconds}s vs donation ${donationSeconds}s`, () => {
        const f = fixture(), selected = f.planner.chooseAugmentationSeller([{ faction: 'BitRunners', repGap: 720,
            rate: 720 / workSeconds, donationCost: 180, donationEligible: true, favor: 150 }],
            { price: 0, cash: 0, income: 180 / donationSeconds });
        assert.equal(selected.donationPlanned, donate); assert.equal(selected.workEtaMs, workSeconds * 1000);
        assert.equal(selected.donationEtaMs, donationSeconds * 1000);
        assert.equal(selected.fundingCost, donate ? 180 : 0);
    });
}

test('simple donation funding flows through the authenticated snapshot and reserve-adjusted savings exactly once', async () => {
    const f = fixture(), plan = f.plan(), p = f.publish(plan).progression;
    assert.equal(plan.next.fundingCost, 25e9); assert.equal(plan.next.acquisitionCost, 25e9);
    assert.equal(plan.next.progressionStrategy, 'DONATE'); assert.equal(plan.next.workEtaMs, 720000);
    assert.ok(Math.abs(plan.next.donationEtaMs - 180000) < 1e-8);
    assert.equal(p.requiredCash, 25e9); assert.equal(p.currentCash, 8e9); assert.equal(p.remainingCash, 17e9);
    assert.equal(p.availableProgressionCash, 8e9); assert.equal(p.requiredReputation, 1e6);
    assert.equal(p.reputationStrategy, 'DONATE'); assert.equal(p.limitingResource, 'cash');
    assert.deepEqual(JSON.parse(JSON.stringify(p.donation)), { planned: true, eligible: true, faction: 'BitRunners',
        reputationRemaining: 1e6, cost: 20e9, workEtaMs: 720000, donationEtaMs: plan.next.donationEtaMs,
        fundingRequired: 25e9, fundingRemaining: 17e9 });
    const goal = await f.save(plan, { augmentationCashReserve: .2 });
    assert.equal(goal.amount, 31.25e9); assert.equal(goal.target, 'augmentation:DonationAug');
    assert.equal(goal.priority, 72); assert.equal(goal.liquidity, false);
    assert.equal(loadScript('lib/stock-liquidity.js', f.clock).readLiquidityRequest(f.ns), null);
    assert.equal(f.savings.readSavings(f.ns).floor, 31.25e9);
});

test('funded donation is an executable purchase state while reputation remains the requirement', () => {
    const f = fixture(); f.world.cash = 25e9;
    const p = f.publish(f.plan()).progression;
    assert.equal(p.requiredReputation, 1e6); assert.equal(p.reputationStrategy, 'DONATE');
    assert.equal(p.limitingResource, 'purchase'); assert.equal(p.moneyCovered, true);
    assert.equal(p.remainingCash, 0); assert.equal(p.donation.fundingRemaining, 0);
});

test('work strategy retains reputation and sharing with no donation funding', async () => {
    const f = fixture(); f.cfg.donate = false;
    const status = await f.tick(), goal = await f.save(status.plan);
    assert.equal(status.progression.reputationStrategy, 'WORK'); assert.equal(status.progression.limitingResource, 'reputation');
    assert.equal(status.progression.sharingDemand, 'SPARE_ONLY'); assert.equal(goal.amount, 5e9 / .9);
    assert.equal(status.plan.next.donationPlanned, false); assert.equal(status.plan.next.fundingCost, 5e9);
});

for (const unavailable of ['disabled', 'favor', 'work types', 'favor API', 'favor read', 'Formulas.exe', 'formula missing', 'formula throws', 'null quote', 'NaN quote', 'infinite quote', 'negative quote']) {
    test(`unavailable donation (${unavailable}) falls back to ordinary work funding`, async () => {
        const f = fixture();
        if (unavailable === 'disabled') f.cfg.donate = false;
        if (unavailable === 'favor') f.world.favor = 149;
        if (unavailable === 'work types') f.ns.singularity.getFactionWorkTypes = () => [];
        if (unavailable === 'favor API') delete f.ns.getFavorToDonate;
        if (unavailable === 'favor read') f.ns.singularity.getFactionFavor = () => { throw Error('locked'); };
        if (unavailable === 'Formulas.exe') f.world.formulas = false;
        if (unavailable === 'formula missing') delete f.ns.formulas.reputation.donationForRep;
        if (unavailable === 'formula throws') f.ns.formulas.reputation.donationForRep = () => { throw Error('unavailable'); };
        if (unavailable.endsWith('quote')) f.ns.formulas.reputation.donationForRep = () =>
            ({ 'null quote': null, 'NaN quote': NaN, 'infinite quote': Infinity, 'negative quote': -1 })[unavailable];
        const plan = f.plan(), p = f.publish(plan).progression, goal = await f.save(plan);
        assert.equal(plan.next.donationPlanned, false); assert.equal(p.reputationStrategy, 'WORK');
        assert.equal(p.limitingResource, 'reputation'); assert.equal(p.requiredCash, 5e9);
        assert.equal(goal.amount, 5e9 / .9); assert.equal(goal.liquidity, false);
    });
}

test('saving for donation keeps player faction work active and turns off sharing', async () => {
    const f = fixture(), first = await f.tick();
    assert.equal(first.phase, 'REPUTATION'); assert.equal(first.plan.next.donationPlanned, true);
    assert.equal(first.progression.limitingResource, 'cash'); assert.equal(first.progression.sharingDemand, 'OFF');
    assert.deepEqual(f.world.works, ['BitRunners']); assert.equal(f.world.donations.length, 0);
    assert.match(first.recommendation, /Working.*saving for donation/);
    const second = await f.tick(); assert.equal(f.world.works.length, 1);
    assert.match(second.recommendation, /Working.*saving for donation/);
});

test('faction work dynamically shrinks the donation quote, full funding, and savings target', async () => {
    const f = fixture(); f.world.donationPerRep = 25000;
    const first = await f.tick(); await f.save(first.plan);
    assert.equal(first.plan.next.donationCost, 25e9); assert.equal(f.goal().amount, 30e9 / .9);
    f.clock.now += 432000; f.world.rep = 600000;
    const second = await f.tick(); await f.save(second.plan);
    assert.equal(second.plan.next.donationPlanned, true); assert.equal(second.plan.next.donationCost, 10e9);
    assert.equal(second.plan.next.fundingCost, 15e9); assert.equal(second.progression.remainingCash, 7e9);
    assert.equal(f.goal().amount, 15e9 / .9); assert.equal(f.world.works.length, 1);
    assert.equal(f.goal().target, 'augmentation:DonationAug');
});

test('strategy reversal removes donation funding immediately and a fresh controller overrides old advice', async () => {
    const f = fixture(), old = f.plan(); await f.save(old);
    f.world.rate = 1e6 / 120; f.world.income = 17.8e9 / 420;
    const plan = f.plan(), status = f.publish(plan);
    await f.supervisor.updateSupervisorSavings({ ...f.ns, pid: 1 }, f.savingsCfg, old, null, status);
    assert.equal(plan.next.donationPlanned, false); assert.equal(plan.next.progressionStrategy, 'WORK');
    assert.equal(status.progression.requiredCash, 5e9); assert.equal(status.progression.limitingResource, 'reputation');
    assert.equal(f.goal().amount, 5e9 / .9); assert.equal(f.goal().liquidity, false);
});

test('microscopic quote changes avoid savings writes and accumulated material changes update the goal', async () => {
    const f = fixture(); await f.save(f.plan());
    const count = () => f.writes.filter(file => file === 'data/savings.json').length;
    f.world.donationPerRep += .000001; await f.save(f.plan()); assert.equal(count(), 1);
    f.world.donationPerRep += 100; const latest = f.plan(); await f.save(latest);
    assert.equal(count(), 2); assert.equal(f.goal().amount, latest.next.fundingCost / .9);
});

test('strategy reversal removes even a donation smaller than the monetary write threshold', async () => {
    const f = fixture(); f.world.rep = 999999; f.world.donationPerRep = 100; f.world.rate = .00001;
    const plan = f.plan(); assert.equal(plan.next.donationPlanned, true); await f.save(plan);
    assert.equal(f.goal().amount, (5e9 + 100) / .9);
    f.cfg.donate = false; await f.save(f.plan());
    assert.equal(f.goal().amount, 5e9 / .9); assert.equal(f.goal().reputationStrategy, 'WORK');
});

test('selected augmentation changes replace the single funding goal', async () => {
    const f = fixture(); await f.save(f.plan());
    f.world.name = 'OtherAug'; f.cfg.target = 'OtherAug'; f.world.donationPerRep = 10000;
    await f.save(f.plan()); assert.equal(f.goal().target, 'augmentation:OtherAug');
    assert.equal(f.goal().amount, 15e9 / .9); assert.equal(f.files.size, 1);
});

test('seller hysteresis retains an incumbent within ten percent and funding follows a material seller change', () => {
    const f = fixture(), sellers = [{ faction: 'Old', repGap: 1000, rate: 1, favor: 150, donationEligible: true, donationCost: 850 },
        { faction: 'New', repGap: 1000, rate: 1, favor: 150, donationEligible: true, donationCost: 800 }];
    const choose = () => f.planner.chooseAugmentationSeller(sellers, { price: 100, cash: 0, income: 100, previous: 'Old' });
    const old = choose(); assert.equal(old.faction, 'Old'); assert.equal(old.fundingCost, 950);
    sellers[1].donationCost = 700;
    const selected = choose(); assert.equal(selected.faction, 'New'); assert.equal(selected.fundingCost, 800);
    assert.equal(selected.donationPlanned, true);
});

test('prerequisite chain funds its whole purchase cost and only the actionable donation', async () => {
    const f = fixture(), item = (name, price, prerequisites, donationCost) => ({ name, price, prerequisites,
        faction: 'BitRunners', stats: { hacking: 1.1 }, repRequired: 1e6, repGap: 1e6, etaMs: 1000,
        donationPlanned: true, donationEligible: true, donationCost, acquisitionCost: price + donationCost });
    const catalog = [item('Target', 15e9, ['A'], 80e9), item('A', 10e9, ['B'], 70e9), item('B', 5e9, [], 5e9)];
    const context = { money: 0, income: 1e9, objective: {} };
    const plan = f.planner.planAugmentationBasket(catalog, [], context, { cash: 0, multiplier: 1, target: 'Target' });
    assert.equal(plan.next.name, 'B'); assert.equal(plan.next.chainCost, 30e9);
    assert.equal(plan.next.acquisitionCost, 10e9); assert.equal(plan.next.fundingCost, 35e9);
    assert.equal(f.publish(plan).progression.requiredCash, 35e9); assert.equal((await f.save(plan)).amount, 35e9 / .9);
    catalog[1].donationPlanned = false; catalog[1].repGap = 0;
    const after = f.planner.planAugmentationBasket(catalog, ['B'], context, { cash: 0, multiplier: 1, target: 'Target' });
    assert.equal(after.next.name, 'A'); assert.equal(after.next.fundingCost, 25e9);
    assert.equal((await f.save(after)).amount, 25e9 / .9); assert.equal(f.goal().target, 'augmentation:A');
});

test('selected donation and purchase can consume their own complete savings goal without retaining donation twice', async () => {
    const f = fixture(); f.cfg.cashReserve = .2; f.world.cash = 31.25e9;
    await f.save(f.plan(), { augmentationCashReserve: .2 });
    const donated = await f.tick();
    assert.deepEqual(f.world.donations, [20e9]); assert.equal(f.world.purchases.length, 0);
    assert.equal(donated.phase, 'DONATE'); assert.equal(donated.plan.next.repGap, 0);
    assert.equal(donated.plan.next.donationPlanned, false); assert.equal(donated.plan.next.fundingCost, 5e9);
    assert.equal(donated.progression.reputationStrategy, 'NONE'); assert.equal(donated.progression.limitingResource, 'purchase');
    // Leave the old $31.25b savings file in place: the selected action owns it.
    assert.equal(f.goal().amount, 31.25e9);
    const bought = await f.tick(); assert.equal(bought.phase, 'PURCHASE');
    assert.deepEqual(f.world.purchases, ['DonationAug']); assert.equal(f.world.cash, 6.25e9);
});

test('execution re-quotes the live rep gap and price rather than the cached donation or acquisition cost', () => {
    const f = fixture(), next = f.plan().next; f.cfg.cashReserve = .2;
    f.world.rep = 600000; f.world.price = 6e9; f.world.cash = 17.5e9;
    assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 8e9);
    assert.equal(next.repGap, 400000); assert.equal(next.price, 6e9); assert.equal(next.chainCost, 6e9);
    assert.equal(next.donationCost, 8e9); assert.equal(next.fundingCost, 14e9);
    assert.equal(f.world.quotes.at(-1), 400000);
    f.world.cash -= 100; assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 0);
});

test('chain donation execution protects the entire chain and authorizes its own goal', async () => {
    const f = fixture(); f.world.donationPerRep = 5000; f.cfg.cashReserve = .2;
    const next = { ...f.plan().next, chainCost: 30e9 };
    f.world.cash = 30e9; assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 0);
    f.world.cash = 43.75e9;
    await f.savings.writeSavings(f.ns, 43.75e9, 'Chain', 'augmentation:DonationAug', 'supervisor');
    assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 5e9); assert.equal(next.fundingCost, 35e9);
});

for (const guard of ['disabled', 'reversed plan', 'favor lost', 'work lost', 'formula lost', 'invalid quote', 'cash spent', 'price increased', 'unknown price', 'rep complete', 'corrupt savings']) {
    test(`execution-time donation guard preserves ${guard}`, () => {
        const f = fixture(), next = f.plan().next; f.cfg.cashReserve = .2; f.world.cash = 31.25e9;
        if (guard === 'disabled') f.cfg.donate = false;
        if (guard === 'reversed plan') next.donationPlanned = false;
        if (guard === 'favor lost') f.world.favor = 149;
        if (guard === 'work lost') f.ns.singularity.getFactionWorkTypes = () => [];
        if (guard === 'formula lost') f.world.formulas = false;
        if (guard === 'invalid quote') f.ns.formulas.reputation.donationForRep = () => Infinity;
        if (guard === 'cash spent') f.world.cash = 24e9;
        if (guard === 'price increased') f.world.price = 20e9;
        if (guard === 'unknown price') f.world.price = NaN;
        if (guard === 'rep complete') f.world.rep = 1e6;
        if (guard === 'corrupt savings') f.files.set('data/savings.json', '{');
        assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 0);
        assert.equal(f.world.donations.length, 0);
    });
}

for (const [owner, target] of [['manual', 'augmentation:DonationAug'], ['manual', 'other'], ['supervisor', 'augmentation:OtherAug']]) {
    test(`${owner} savings for ${target} remain protected by donation and purchase`, async () => {
        const f = fixture(); f.world.cash = 31.25e9; f.cfg.cashReserve = .2;
        await f.savings.writeSavings(f.ns, 30e9, 'Protected', target, owner);
        const next = f.plan().next; assert.equal(f.manager.affordableDonation(f.ns, f.cfg, next), 0);
        if (owner === 'manual') { await f.save(next ? { next, errors: [] } : null); assert.equal(f.goal().owner, 'manual'); }
        f.world.rep = 1e6;
        const status = await f.tick(); assert.equal(status.phase, 'FUND'); assert.equal(f.world.purchases.length, 0);
    });
}

test('successful donation replans actual remaining rep rather than assuming full reputation', async () => {
    const f = fixture(); f.world.cash = 31.25e9; f.cfg.cashReserve = .2;
    f.ns.singularity.donateToFaction = (faction, amount) => { f.world.cash -= amount; f.world.rep = 999900; return true; };
    const status = await f.tick(); assert.equal(status.phase, 'DONATE'); assert.equal(status.plan.next.repGap, 100);
    assert.equal(status.plan.next.donationCost, 2e6); assert.equal(status.plan.next.fundingCost, 5.002e9);
    assert.equal(status.progression.requiredReputation, 1e6); assert.equal(f.world.purchases.length, 0);
});

test('donation metadata leaves Daedalus, installation, and final-server cash milestones intact', () => {
    const f = fixture(), plan = f.plan(), names = Array.from({ length: 30 }, (_, i) => 'Aug' + i);
    const objective = extra => f.objectiveApi.progressionObjective({ currentNode: 4, money: 8e9, plan,
        player: { skills: { hacking: 3000 } }, ...extra });
    const daedalus = objective({ installed: names, owned: names });
    assert.equal(daedalus.milestone, 'DAEDALUS'); assert.equal(daedalus.requiredCash, 100e9);
    for (const p of [objective({ owned: ['The Red Pill'] }), objective({ installed: ['The Red Pill'], owned: ['The Red Pill'], finalRequirement: 9000 })]) {
        assert.equal(p.requiredCash, 0); assert.equal(p.reputationStrategy, 'NONE'); assert.equal(p.donation, null);
    }
    assert.equal(daedalus.reputationStrategy, 'NONE'); assert.equal(daedalus.donation, null);
});

test('milestone ETA balancing sees donation cash behind and reduces XP allocation through the generic snapshot', () => {
    const f = fixture(), plan = f.plan();
    const objective = f.objectiveApi.progressionObjective({ currentNode: 4, plan, money: 8e9,
        player: { skills: { hacking: 500 } }, backdoors: [{ requiredHacking: 1000, installed: false }] });
    const api = loadScript('lib/milestone-balance.js', f.clock), state = {};
    const input = { objective, level: 500, remainingXp: 120000, cash: { rate: 50e6, source: 'measured' },
        xp: { rate: 1000, source: 'measured' }, baseline: .4, safe: true, enabled: true };
    api.balanceMilestone(state, { ...input, now: f.clock.now });
    const result = api.balanceMilestone(state, { ...input, now: f.clock.now + 120000 });
    assert.equal(result.requiredCash, 25e9); assert.equal(result.remainingCash, 17e9);
    assert.equal(result.cashEtaMs, 340000); assert.match(result.reason, /cash behind/);
    assert.ok(Math.abs(result.xpAllocation - .3) < 1e-9);
});

test('Red Pill donation funding retains priority, beats performance capital, and keeps authenticated liquidity', async () => {
    const f = fixture(); f.world.name = 'The Red Pill'; f.world.factions = ['Daedalus'];
    const plan = f.plan(), requests = ['home:cores', 'home:performance-ram'].map(target => ({ target,
        amount: 1e8, label: target, reason: 'Measured performance', priority: 79 }));
    const fleet = { type: 'fleet-status', producerPid: 9, generatedAt: f.clock.now, cloud: { enabled: true,
        capitalRequest: { version: 1, producerPid: 9, resetEpoch: '4:1:2', generatedAt: f.clock.now,
            target: 'fleet:new:8', candidate: { ram: 8 }, amount: 1e8, priority: 79 } } };
    const goal = await f.save(plan, { homePerformanceInvestments: requests }, fleet);
    assert.equal(goal.target, 'augmentation:The Red Pill'); assert.equal(goal.priority, 100);
    assert.equal(goal.amount, 25e9 / .9); assert.equal(goal.liquidity, true);
    const reader = loadScript('lib/stock-liquidity.js', f.clock);
    assert.equal(reader.readLiquidityRequest(f.ns).target, goal.target);
    const writes = f.writes.length; f.clock.now += 5000; await f.save(plan); assert.equal(f.writes.length, writes);
    f.clock.now += 5000; await f.save(plan); assert.ok(f.writes.length > writes);
    assert.ok(reader.readLiquidityRequest(f.ns));
    f.clock.now += 15001; assert.equal(reader.readLiquidityRequest(f.ns), null);
});

test('ordinary donation keeps existing augmentation priority below critical service and Daedalus requirements', async () => {
    const f = fixture(), plan = f.plan();
    const home = { amount: 1e9, target: 'home:ram', label: 'Critical services', priority: 90 };
    assert.equal((await f.save(plan, { homeInvestment: home })).target, 'home:ram');
    const status = f.publish(plan); status.savings = { amount: 100e9, target: 'faction:Daedalus', label: 'Daedalus' };
    await f.supervisor.updateSupervisorSavings({ ...f.ns, pid: 1 }, f.savingsCfg, plan, null, status);
    assert.equal(f.goal().target, 'faction:Daedalus'); assert.equal(f.goal().priority, 95);
    const perf = { amount: 1e9, target: 'home:cores', label: 'Measured cores', priority: 79 };
    assert.equal((await f.save(plan, { homePerformanceInvestments: [perf] })).target, perf.target);
});

test('a donation-backed Red Pill prerequisite inherits the chain target priority and funding', async () => {
    const f = fixture(), plan = f.plan(); plan.next.chainTarget = 'The Red Pill'; plan.next.chainCost = 30e9;
    const goal = await f.save(plan, { homePerformanceInvestments: [{ target: 'home:cores', priority: 79, amount: 1e8 }] });
    assert.equal(goal.target, 'augmentation:DonationAug'); assert.equal(goal.priority, 100);
    assert.equal(goal.amount, 50e9 / .9); assert.equal(goal.liquidity, true);
});

test('funded donation savings prevent stock access from consuming acquisition capital', async () => {
    const f = fixture(); f.world.cash = 25e9 / .9; const plan = f.plan(); await f.save(plan);
    const status = f.publish(plan); status.progression.multipliers = { FourSigmaMarketDataApiCost: 1 };
    let buys = 0; f.ns.flags = pairs => Object.fromEntries(pairs); f.ns.tprint = () => {};
    f.ns.stock = { getConstants: () => ({ WseAccountCost: 1e8, TixApiCost: 2e8, MarketDataTixApi4SCost: 3e8 }),
        hasWseAccount: () => false, hasTixApiAccess: () => false, has4SDataTixApi: () => false,
        purchaseWseAccount: () => { buys++; return true; } };
    await loadScript('stock-access.js', f.clock).main(f.ns); assert.equal(buys, 0);
    assert.equal(f.goal().amount, 25e9 / .9);
});

test('detailed dashboard exposes the strategy and full funding while compact output stays concise', async () => {
    const f = fixture(), status = await f.tick(), lines = [], api = loadScript('supervisor.js', f.clock);
    const ns = { print: line => lines.push(line) };
    for (const detailed of [false, true]) {
        lines.length = 0;
        api.renderAugmentationLoop(ns, status, { augmentationActions: true, dashboardDetails: detailed, minInstall: 5 });
        const output = lines.join('\n'); assert.match(output, /DONATE/); assert.match(output, /saving for donation/);
        assert.equal(output.includes('FACTION PROGRESSION'), detailed);
        if (detailed) {
            for (const label of ['Rep remaining', 'Work rate', 'Work ETA', 'Donation ETA', 'Funding goal', 'Funding']) assert.ok(output.includes(label), label);
            assert.match(output, /\$25,000,000,000/); assert.match(output, /\$8,000,000,000/);
        }
        assert.doesNotMatch(output, /\[object Object\]/);
    }
    f.cfg.donate = false; const work = await f.tick(); lines.length = 0;
    api.renderAugmentationLoop(ns, work, { augmentationActions: true, dashboardDetails: true, minInstall: 5 });
    assert.match(lines.join('\n'), /Strategy\s+WORK/);
    assert.match(lines.join('\n'), /Funding goal\s+\$5,000,000,000/);
});

test('standalone donation opt-out and manual savings mode use the same work funding', async () => {
    const f = fixture(); f.ns.flags = pairs => ({ ...Object.fromEntries(pairs), report: true, donate: 'false' });
    await loadScript('augmentation-planner.js', f.clock).main(f.ns);
    const report = JSON.parse(f.files.get('data/augmentation-plan.json'));
    assert.equal(report.plan.next.progressionStrategy, 'WORK'); assert.equal(report.plan.next.fundingCost, 5e9);
    assert.equal((await f.save(report.plan, { savingsMode: 'augmentations' })).amount, 5e9);
});
