const test = require('node:test'), assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');
const expFor = (level, mult) => Math.exp((level / mult + 200) / 32) - 534;

function fixture() {
    const clock = new Clock(), api = loadScript('lib/augmentation-grafting.js', clock);
    const manager = loadScript('augmentation-manager.js', clock);
    const reset = { currentNode: 10, lastNodeReset: 1, lastAugReset: 900000, ownedSF: new Map([[4, 3], [5, 3]]) };
    const world = { cash: 1e12, installed: ['The Red Pill'], pending: [], entropy: 0, hacking: 900, mult: 10,
        xp: expFor(900, 10), work: { type: 'CLASS', classType: 'Computer Science', location: 'Rothman University' },
        city: 'Sector-12', price: 1e6, time: 120000, stats: { hacking: 1.2, hacking_exp: 1.5 },
        stops: 0, starts: [], travels: [], installs: [], runs: [], rep: 0, valid: true, offers: [] };
    const files = new Map([['data/supervisor-bootstrap.json', '{"version":2,"args":[]}']]);
    const ports = new Map();
    const ns = { pid: 9, getHostname: () => 'home', getResetInfo: () => reset,
        getPlayer: () => ({ city: world.city, factions: ['Daedalus'], entropy: world.entropy,
            skills: { hacking: world.hacking }, exp: { hacking: world.xp }, mults: { hacking: world.mult } }),
        getBitNodeMultipliers: () => ({ HackingLevelMultiplier: 1 }),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        ps: () => [{ pid: 20, filename: 'daemon.js' }], getServerMoneyAvailable: () => world.cash,
        getHackingLevel: () => world.hacking, serverExists: h => h === 'w0r1d_d43m0n',
        getServerRequiredHackingLevel: () => 1000, getServer: () => ({ backdoorInstalled: false }), hasRootAccess: () => true,
        fileExists: () => true, getScriptRam: () => 4, getServerMaxRam: () => 65536, getServerUsedRam: () => 100,
        read: name => files.get(name) || '', write: async (name, data) => files.set(name, data),
        run: (...args) => { world.runs.push(args); return 123; }, print() {},
        formulas: { skills: { calculateExp: expFor } }, go: { analysis: { getStats: () => ({}) } },
        grafting: { getGraftableAugmentations: () => ['Upgrade'], getAugmentationGraftPrice: () => world.price,
            getAugmentationGraftTime: () => world.time, graftAugmentation: (name, focus) => {
                world.starts.push({ name, focus }); if (!world.valid) return false;
                world.cash -= world.price;
                world.work = { type: 'GRAFTING', augmentation: name, cyclesWorked: 0, nextCompletion: Promise.resolve() };
                return true;
            } },
        singularity: { getOwnedAugmentations: all => [...world.installed, ...(all ? world.pending : [])],
            getCurrentWork: () => world.work, isBusy: () => !!world.work,
            stopAction: () => { world.stops++; world.work = null; return true; },
            travelToCity: city => { world.travels.push(city); world.city = city; world.cash -= 200000; return true; },
            getAugmentationStats: () => world.stats, getAugmentationPrereq: () => [], getAugmentationPrice: () => 1e9,
            getAugmentationsFromFaction: () => world.offers, getAugmentationRepReq: () => 10000,
            getFactionRep: () => world.rep, getFactionFavor: () => 0, getFactionWorkTypes: () => ['hacking'],
            checkFactionInvitations: () => [],
            universityCourse: () => { world.work = { type: 'CLASS', classType: 'Computer Science', location: 'Rothman University' }; return true; },
            purchaseAugmentation: () => assert.fail('unexpected normal purchase'),
            installAugmentations: callback => { world.installs.push(callback); return true; } } };
    const cfg = { grafting: true, route: true, work: true, purchase: true, focusWork: false, resetPolicy: 'auto',
        cashReserve: .1, minInstall: 5, focus: 'hacking', target: '', joinFactions: false, donate: false };
    const state = { resetEpoch: '10:1:900000', ownedClass: { ...world.work }, recoveryProfile: { nodeReset: 1,
        samples: [100000, 500000].map(at => ({ at, ms: 90000, income: 1e6, cash: 1e9, xp: 200, hacking: 800, reputation: { Daedalus: 0 } })) } };
    const refresh = () => {
        const port = ns.getPortHandle(17); port.clear(); port.write({ type: 'jit-status', version: 2, pid: 20,
            generatedAt: clock.now, income60: 1e6, pipelines: [{ mode: 'LIVE' }], prepRam: 0,
            policy: { balance: { milestone: 'FINAL_SERVER', requiredHacking: 1000, requiredCash: 0,
                generatedAt: clock.now, xpSource: 'measured', xpRate: 1, scriptXpRate: 1 } } });
    };
    const context = () => { refresh(); return loadScript('lib/augmentation-context.js', clock).augmentationContext(ns, state); };
    const tick = async () => { refresh(); return manager.tickAugmentationLoop(ns, cfg, state); };
    return { clock, api, manager, ns, cfg, state, world, reset, files, context, tick };
}

test('entropy applies to every affected multiplier, stacks incrementally, and Congruity removes or prevents it', () => {
    const f = fixture();
    const e = f.api.graftMultipliers({ hacking: 1.1 }, [], 12, 'Upgrade');
    assert.equal(e.factor, .98); assert.equal(e.stacksAfter, 13);
    assert.equal(e.net.hacking, 1.1 * .98); assert.equal(e.net.faction_rep, .98);
    assert.equal(e.net.crime_success, .98); assert.equal(e.net.hacknet_node_ram_cost, 1 / .98);
    const congruity = 'violet Congruity Implant';
    assert.equal(f.api.graftMultipliers({}, [congruity], 0, 'Upgrade').factor, 1);
    assert.equal(f.api.graftMultipliers({}, [], 12, congruity).factor, .98 ** -12);
    assert.equal(f.api.graftMultipliers({}, [], 12, congruity).stacksAfter, 0);
    assert.equal(f.api.graftMultipliers({}, [], NaN, 'Upgrade'), null);
});

test('cost, work time, entropy, normal reset and continuing can each veto a graft', () => {
    const f = fixture(), entropy = f.api.graftMultipliers({ hacking: 1.2 }, [], 0, 'Upgrade');
    const base = { price: 1e6, timeMs: 120000, cash: 1e12, floor: 1e11, income: 1e6,
        continueMs: 1e7, afterGraftMs: 100000, normalMs: 8e6, resetMs: 7e6, entropy, net: entropy.net };
    const good = f.api.compareGraft(base); assert.equal(good.selected, true);
    assert.ok(good.capitalMs > 1000, 'capital includes compounded money entropy');
    for (const change of [{ price: 1e15 }, { timeMs: 1e8 }, { normalMs: 100000 }, { resetMs: 100000 },
        { continueMs: 100000 }, { income: 0 }, { afterGraftMs: NaN }, { floor: Infinity }])
        assert.equal(f.api.compareGraft({ ...base, ...change }).selected, false, JSON.stringify(change));
});

test('BN10 manager starts a faster graft and publishes cloneable status without interrupting it for six hours', async () => {
    const f = fixture(), started = await f.tick();
    assert.equal(started.phase, 'GRAFTING'); assert.equal(f.world.starts.length, 1);
    assert.equal(started.grafting.timeMs, 150000, 'unfocused work is 25% slower');
    assert.equal(f.world.stops, 1); assert.deepEqual(f.world.travels, ['New Tokyo']);
    // Simulate a manual long-running graft and manager restarts. Ownership is
    // not required to protect already-paid work; queued RP must not cancel it.
    f.state.graftActive = null; f.world.pending = ['The Red Pill'];
    for (let i = 0; i < 2160; i++) {
        f.clock.now += 10000;
        const status = await f.tick(); structuredClone(status);
        assert.equal(status.phase, 'GRAFTING');
    }
    assert.equal(f.world.starts.length, 1); assert.equal(f.world.stops, 1); assert.equal(f.world.installs.length, 0);
});

test('completion replans and reaches the final server; interrupted graft resumes training with backoff', async () => {
    for (const complete of [true, false]) {
        const f = fixture(); await f.tick(); f.world.work = null; f.clock.now += 155000;
        if (complete) { f.world.installed.push('Upgrade'); f.world.hacking = 1100; f.world.mult *= 1.2 * .98; }
        const status = await f.tick();
        assert.notEqual(status.phase, 'GRAFTING'); assert.equal(f.state.graftActive, null);
        assert.equal(status.grafting.state, complete ? 'COMPLETED' : 'INTERRUPTED');
        if (complete) assert.equal(f.world.runs[0][0], 'node-complete.js');
        else {
            assert.ok(['HACKING', 'TRAVEL'].includes(status.phase));
            for (let i = 0; i < 50; i++) { f.clock.now += 5000; await f.tick(); }
            assert.equal(f.world.starts.length, 1, 'cancelled graft does not hot-loop');
        }
    }
});

test('six hours of unavailable graft quotes leave ordinary progression ticking without a savings hold', async () => {
    const f = fixture(); let scans = 0;
    f.ns.grafting.getGraftableAugmentations = () => { scans++; throw new Error('API unavailable'); };
    for (let i = 0; i < 4320; i++) {
        f.clock.now += 5000; const status = await f.tick();
        assert.equal(status.phase, 'HACKING'); assert.notEqual(status.state, 'ERROR');
    }
    assert.equal(scans, 360); assert.equal(f.world.starts.length, 0); assert.equal(f.world.stops, 0);
    assert.equal(f.files.has('data/savings.json'), false);
});

test('unavailable grafting does not prevent measured XP from reaching the final server unattended', async () => {
    const f = fixture();
    f.ns.grafting.getGraftableAugmentations = () => { throw new Error('API unavailable'); };
    for (let elapsed = 0; elapsed < 7200000 && !f.world.runs.length; elapsed += 5000) {
        f.clock.now += 5000; f.world.xp += 5;
        f.world.hacking = Math.floor(f.world.mult * (32 * Math.log(f.world.xp + 534) - 200));
        await f.tick();
    }
    assert.ok(f.world.hacking >= 1000); assert.equal(f.world.runs[0][0], 'node-complete.js');
    assert.equal(f.world.starts.length, 0); assert.equal(f.world.installs.length, 0);
});

test('failed travel and rejected graft starts resume ordinary work in the same tick', async () => {
    for (const failure of ['travel', 'start']) {
        const f = fixture();
        if (failure === 'travel') f.ns.singularity.travelToCity = () => false;
        else f.world.valid = false;
        const status = await f.tick();
        assert.notEqual(status.phase, 'GRAFTING'); assert.equal(status.grafting.state, 'FAILED');
        assert.ok(f.state.graftRetryAt >= f.clock.now + 300000);
        assert.equal(f.state.graftActive, undefined);
    }
});

for (const reason of ['disabled', 'work', 'purchase', 'route', 'target', 'threshold', 'other-node', 'owned', 'prerequisite', 'entropy', 'cash', 'stale-xp', 'manual']) {
    test(`grafting preserves normal/manual progression when blocked by ${reason}`, async () => {
        const f = fixture();
        if (reason === 'disabled') f.cfg.grafting = false;
        if (['work', 'purchase', 'route'].includes(reason)) f.cfg[reason] = false;
        if (reason === 'target') f.cfg.target = 'Manual target';
        if (reason === 'threshold') f.cfg.resetPolicy = 'threshold';
        if (reason === 'other-node') f.reset.currentNode = 2;
        if (reason === 'owned') f.world.pending.push('Upgrade');
        if (reason === 'prerequisite') f.ns.singularity.getAugmentationPrereq = () => ['Missing'];
        if (reason === 'entropy') f.world.stats = { hacking: 1.01 };
        if (reason === 'cash') f.world.cash = 1e6;
        if (reason === 'manual') f.world.work = { type: 'CRIME', crimeType: 'Heist' };
        const context = f.context();
        if (reason === 'stale-xp') context.balance.generatedAt -= 16000;
        const choice = f.api.planGrafting(f.ns, f.cfg, f.state, context, { next: null, errors: [] });
        f.api.startGraft(f.ns, f.cfg, f.state, context, choice);
        assert.equal(f.world.starts.length, 0); assert.equal(f.world.stops, 0);
    });
}

test('live price increases and shared savings changes invalidate a selected graft before spending', () => {
    for (const reason of ['price', 'savings']) {
        const f = fixture(), context = f.context();
        const choice = f.api.planGrafting(f.ns, f.cfg, f.state, context, { next: null, errors: [] });
        assert.ok(choice);
        if (reason === 'price') f.world.price *= 2;
        else f.files.set('data/savings.json', JSON.stringify({ version: 1, epoch: '10:1:900000', amount: 1e12, target: 'home:ram', label: 'Critical RAM' }));
        assert.equal(f.api.startGraft(f.ns, f.cfg, f.state, context, choice), null);
        assert.equal(f.world.starts.length, 0); assert.equal(f.world.stops, 0);
    }
});

test('reputation planner compares an inflated normal purchase and its rep wait against a direct graft', () => {
    const f = fixture(), context = f.context();
    context.installed = []; context.owned = []; context.player.entropy = 3;
    context.objective = { milestone: 'AUGMENTATIONS', limitingResource: 'reputation', requiredCash: 1e9 };
    f.world.stats = { faction_rep: 1.5 }; f.world.time = 600000;
    const next = { name: 'Upgrade', price: 1e9, repGap: 200000, repRequired: 200000, rate: 10,
        etaMs: 20000000, faction: 'Daedalus', stats: f.world.stats };
    const plan = { next, deferred: [next], errors: [] };
    const choice = f.api.planGrafting(f.ns, f.cfg, f.state, context, plan);
    assert.ok(choice); assert.equal(choice.normalCost, 1e9); assert.equal(choice.price, 1e6);
    assert.equal(choice.entropy.stacksAfter, 4); assert.ok(choice.normalMs >= next.etaMs);
    assert.ok(choice.graftMs < choice.normalMs * .8);
    // A quick normal acquisition with unknown recovery must win, not be
    // assigned infinite ETA to justify an expensive detour.
    f.state.graftRetryAt = 0; f.state.recoveryProfile.samples = [];
    next.etaMs = 1000; next.repGap = 10;
    assert.equal(f.api.planGrafting(f.ns, f.cfg, f.state, context, plan), null);
});

test('queued Red Pill and an already-ready final server take priority over starting another graft', async () => {
    for (const goal of ['pill', 'clear']) {
        const f = fixture();
        if (goal === 'pill') { f.world.installed = []; f.world.pending = ['The Red Pill']; }
        else f.world.hacking = 1100;
        await f.tick(); assert.equal(f.world.starts.length, 0);
        if (goal === 'pill') assert.equal(f.world.installs.length, 1);
        else assert.equal(f.world.runs[0][0], 'node-complete.js');
    }
});

test('saved graft state restores across manager reload and notices installed ownership after reload', async () => {
    const f = fixture(); await f.tick();
    const saved = JSON.parse(JSON.stringify(f.state));
    const reload = loadScript('lib/augmentation-grafting.js', f.clock);
    assert.equal(reload.activeGraft(f.ns, saved).phase, 'GRAFTING');
    f.world.installed.push('Upgrade'); f.world.work = null;
    assert.equal(reload.activeGraft(f.ns, saved), null);
    assert.equal(saved.grafting.state, 'COMPLETED'); assert.equal(f.world.starts.length, 1);
});
