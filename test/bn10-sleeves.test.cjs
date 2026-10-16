const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(1_000_001), ports = new Map(), processes = [{ filename: 'sleeve-manager.js', pid: 10 }];
    const reset = { currentNode: 10, lastNodeReset: 1, lastAugReset: 1, ownedSF: new Map([[1, 3], [2, 1], [4, 3], [5, 3]]) };
    const crimes = [{ name: 'Homicide', difficulty: 1, time: 3000, karma: 3, money: 45000, strength_success_weight: 2, defense_success_weight: 2, dexterity_success_weight: .5, agility_success_weight: .5 },
        { name: 'Shoplift', difficulty: .05, time: 2000, karma: .1, money: 15000, dexterity_success_weight: 1, agility_success_weight: 1 }];
    const person = () => ({ skills: { hacking: 100, strength: 1, defense: 1, dexterity: 10, agility: 10, charisma: 1, intelligence: 0 }, mults: { crime_success: 1 }, city: 'Sector-12', shock: 100, sync: 1, memory: 1 });
    const world = { sleeves: [person()], tasks: [null], karma: 0, cash: 1e12, factions: ['NiteSec', 'Daedalus'], work: null, calls: [], taskError: false, files: new Map(), sleeveCost: Infinity };
    const set = (index, task) => { world.calls.push(['task', index, task]); world.tasks[index] = task; return true; };
    const ns = { pid: 10, args: [], getHostname: () => 'home', getResetInfo: () => reset, ps: () => processes,
        heart: { break: () => world.karma }, getPlayer: () => ({ factions: world.factions }),
        getPortHandle: n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); },
        getBitNodeMultipliers: () => ({ CrimeSuccessRate: 1 }), enums: { CrimeType: Object.fromEntries(crimes.map(c => [c.name, c.name])) },
        getServerMoneyAvailable: () => world.cash, getServerMaxRam: () => 64, getServerUsedRam: () => 40, getScriptRam: () => 60,
        read: f => world.files.get(f) || '', tprint() {},
        run: (...args) => { world.calls.push(['run', ...args]); return 99; },
        sleeve: { getNumSleeves: () => world.sleeves.length, getSleeve: i => world.sleeves[i],
            getTask: i => world.tasks[i] ? { ...world.tasks[i], nextCompletion: Promise.resolve() } : null,
            setToSynchronize: i => set(i, { type: 'SYNCHRO' }), setToShockRecovery: i => set(i, { type: 'RECOVERY' }),
            setToCommitCrime: (i, crimeType) => set(i, { type: 'CRIME', crimeType }),
            setToUniversityCourse: (i, location, classType) => set(i, { type: 'CLASS', location, classType }),
            setToFactionWork: (i, factionName, factionWorkType) => { if (world.taskError) return false; return set(i, { type: 'FACTION', factionName, factionWorkType }); },
            getSleeveCost: () => world.sleeveCost, purchaseSleeve: () => { world.calls.push(['buy-sleeve']); return { success: true }; },
            getMemoryUpgradeCost: () => 1e12, upgradeMemory: () => { world.calls.push(['memory']); return { success: true }; },
            getSleevePurchasableAugs: () => [{ name: 'Neurotrainer I', cost: 1e6 }],
            purchaseSleeveAug: (i, name) => { world.calls.push(['buy-aug', i, name]); world.cash -= 1e6; return true; } },
        singularity: { getCrimeStats: name => crimes.find(c => c.name === name), getFactionWorkTypes: () => ['hacking'], getCurrentWork: () => world.work,
            isBusy: () => !!world.work, stopAction: () => { world.calls.push(['stop']); world.work = null; return true; },
            commitCrime: name => { world.calls.push(['crime', name]); world.work = { type: 'CRIME', crimeType: name }; return 3000; } } };
    const api = loadScript('sleeve-manager.js', clock), policy = loadScript('lib/sleeve-policy.js', clock), state = {}, cfg = { karma: true, budget: .02 };
    const publish = (port, type, filename, extra) => {
        const p = { filename, pid: port + 100 }; if (!processes.some(row => row.pid === p.pid)) processes.push(p);
        ns.getPortHandle(port).clear(); ns.getPortHandle(port).write({ type, generatedAt: clock.now, producerPid: p.pid,
            resetEpoch: `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}`, ...extra });
    };
    return { clock, ns, reset, world, api, policy, cfg, state, processes, person, publish, crimes };
}

test('BN10.1 uses its first sleeve without SF10 and changes tasks without resetting repeated crimes', () => {
    const f = fixture(); let s = f.api.sleeveTick(f.ns, f.cfg, f.state);
    assert.equal(s.count, 1); assert.equal(f.world.tasks[0].type, 'SYNCHRO');
    f.world.sleeves[0].sync = 10;
    s = f.api.sleeveTick(f.ns, f.cfg, f.state);
    assert.equal(f.world.tasks[0].crimeType, 'Shoplift'); assert.ok(s.karmaPerSecond > 0, 'shock must not zero karma');
    const calls = f.world.calls.length;
    for (let i = 0; i < 20; i++) { f.clock.now += 5000; f.api.sleeveTick(f.ns, f.cfg, f.state); }
    assert.equal(f.world.calls.length, calls, 'do not restart a crime every service tick');
    Object.assign(f.world.sleeves[0].skills, { strength: 300, defense: 300 });
    f.api.sleeveTick(f.ns, f.cfg, f.state);
    assert.equal(f.world.tasks[0].crimeType, 'Homicide');
    assert.ok(!f.world.calls.some(c => c[0] === 'run'), 'optional upgrades cannot consume bootstrap RAM');
});

test('crime model uses success, synchronization, intelligence and node multiplier; shock only affects money', () => {
    const f = fixture(), sleeve = f.person(); sleeve.sync = 100;
    let low = f.policy.sleeveCrimeChoice(sleeve, f.crimes, true, .5);
    let full = f.policy.sleeveCrimeChoice(sleeve, f.crimes, true, 1);
    assert.equal(low.rate * 2, full.rate);
    assert.equal(f.policy.sleeveCrimeChoice(sleeve, f.crimes, false).rate, 0);
    sleeve.shock = 0; assert.ok(f.policy.sleeveCrimeChoice(sleeve, f.crimes, false).rate > 0);
});

test('the actual manager loop publishes cloneable heartbeats when live task objects contain Promises', async () => {
    const f = fixture(); f.world.sleeves[0].sync = 10;
    f.ns.disableLog = f.ns.clearLog = f.ns.print = () => {};
    f.ns.flags = defaults => ({ ...Object.fromEntries(defaults), ticks: 2 });
    f.ns.sleep = async ms => { f.clock.now += ms; };
    const port = f.ns.getPortHandle(2), originalWrite = port.write.bind(port);
    port.write = value => originalWrite(structuredClone(value));
    await f.api.main(f.ns);
    const report = port.peek();
    assert.equal(report.state, 'ACTIVE'); assert.equal(report.sleeves[0].task.type, 'CRIME');
    assert.equal(report.sleeves[0].task.nextCompletion, undefined);
    assert.equal(f.world.calls.filter(c => c[0] === 'task').length, 1);
});

test('karma reaching target releases sleeves to milestone work without waiting for zero shock/full sync', () => {
    const f = fixture(); Object.assign(f.world.sleeves[0], { shock: 80, sync: 20 });
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.tasks[0].type, 'CRIME');
    f.world.karma = -54000;
    f.publish(11, 'augmentation-status', 'augmentation-manager.js', { plan: { next: { faction: 'Daedalus', repGap: 10000 } } });
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.tasks[0].factionName, 'Daedalus');
    const count = f.world.calls.length; f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.calls.length, count);
    f.publish(11, 'augmentation-status', 'augmentation-manager.js', { progression: { limitingResource: 'hacking' } });
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.tasks[0].classType, 'Computer Science');
});

test('only one sleeve works a faction; a gang faction is excluded; failures back off and do productive work', () => {
    const f = fixture(); f.world.karma = -54000;
    f.world.sleeves = [f.person(), f.person()]; f.world.sleeves.forEach(s => Object.assign(s, { shock: 0, sync: 100 }));
    f.publish(11, 'augmentation-status', 'augmentation-manager.js', { plan: { next: { faction: 'Daedalus', repGap: 10000 } } });
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.tasks.filter(t => t.type === 'FACTION').length, 1);
    f.world.tasks = [null, null]; f.world.taskError = true;
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.tasks[0].type, 'CRIME');
    const count = f.world.calls.length; f.api.sleeveTick(f.ns, f.cfg, f.state); assert.equal(f.world.calls.length, count);
    f.publish(3, 'gang-status', 'gang-manager.js', { inGang: true, faction: 'Daedalus' });
    f.api.sleeveTick(f.ns, f.cfg, f.state); assert.ok(f.world.tasks.every(t => t.type !== 'FACTION'));
});

test('stale/forged/reset status cannot change tasks or authorize an installation pause', () => {
    for (const reason of ['stale', 'owner', 'epoch']) {
        const f = fixture(); f.world.sleeves[0].sync = 10;
        f.publish(11, 'augmentation-status', 'augmentation-manager.js', { phase: 'INSTALL', state: 'RESETTING', queued: 1 });
        if (reason === 'stale') f.clock.now += 16000;
        if (reason === 'owner') f.processes.pop();
        if (reason === 'epoch') f.reset.lastAugReset++;
        assert.equal(f.api.sleeveTick(f.ns, f.cfg, f.state).state, 'ACTIVE', reason);
    }
    const f = fixture(); f.publish(11, 'augmentation-status', 'augmentation-manager.js', { phase: 'INSTALL', state: 'RESETTING', queued: 1 });
    assert.equal(f.api.sleeveTick(f.ns, f.cfg, f.state).state, 'INSTALLING'); assert.equal(f.world.calls.length, 0);
});

test('capability and opt-out guard locked APIs; augmentation reset reuses persistent sleeves and gang access', () => {
    const f = fixture(); f.reset.currentNode = 1; f.ns.sleeve = new Proxy({}, { get() { assert.fail('locked'); } });
    assert.equal(f.api.sleeveTick(f.ns, f.cfg, f.state).state, 'LOCKED');
    const g = fixture(); g.cfg.karma = false; g.world.sleeves[0].sync = 10;
    g.api.sleeveTick(g.ns, g.cfg, g.state); assert.equal(g.world.tasks[0].type, 'RECOVERY');
    g.reset.lastAugReset = ++g.clock.now; g.world.karma = -54000; g.cfg.karma = true;
    g.api.sleeveTick(g.ns, g.cfg, g.state); assert.equal(g.world.tasks[0].type, 'RECOVERY');
});

test('player karma is bounded, yields to manual work, stops at target, and does not restart the same crime', () => {
    const f = fixture(), api = loadScript('lib/gang-karma.js', f.clock), cfg = { gangKarma: true, work: true }, state = {};
    const context = { reset: f.reset, capabilities: { gang: true }, owned: [], gang: null }, plan = { next: { repGap: 1000 } };
    f.clock.now = f.reset.lastNodeReset + 300000;
    assert.equal(api.routeGangKarma(f.ns, cfg, state, context, plan).phase, 'GANG_KARMA');
    for (let i = 0; i < 11; i++) { f.clock.now += 5000; api.routeGangKarma(f.ns, cfg, state, context, plan); }
    assert.equal(f.world.calls.filter(c => c[0] === 'crime').length, 1);
    f.clock.now += 5000; assert.equal(api.routeGangKarma(f.ns, cfg, state, context, plan), null); assert.equal(f.world.work, null);
    f.clock.now += 240000; f.world.work = { type: 'COMPANY', companyName: 'ECorp' };
    assert.equal(api.routeGangKarma(f.ns, cfg, state, context, plan), null); assert.equal(f.world.work.type, 'COMPANY');
    f.world.work = null; api.routeGangKarma(f.ns, cfg, state, context, plan); f.world.karma = -54000;
    assert.equal(api.routeGangKarma(f.ns, cfg, state, context, plan), null); assert.equal(f.world.work, null);
});

test('sleeve purchases respect savings, shock, fresh owner and reset; Covenant purchases never gate progress', async () => {
    for (const reason of ['ok', 'savings', 'shock', 'owner', 'stale', 'epoch', 'install', 'locked']) {
        const f = fixture(); f.world.sleeves[0].shock = reason === 'shock' ? 1 : 0;
        f.ns.args = [JSON.stringify({ ownerPid: 10, createdAt: f.clock.now, resetEpoch: '10:1:1', budget: .02 })];
        if (reason === 'savings') await loadScript('lib/savings.js', f.clock).writeSavings({ ...f.ns, write: async (file, value) => f.world.files.set(file, value) }, f.world.cash, 'reserved');
        if (reason === 'owner') f.processes.length = 0;
        if (reason === 'stale') f.clock.now += 30001;
        if (reason === 'epoch') f.reset.lastAugReset++;
        if (reason === 'install') f.publish(11, 'augmentation-status', 'augmentation-manager.js', { phase: 'INSTALL', state: 'RESETTING', queued: 1 });
        if (reason === 'locked') f.reset.currentNode = 1;
        await loadScript('sleeve-upgrades.js', f.clock).main(f.ns);
        assert.equal(f.world.calls.filter(c => c[0] === 'buy-aug').length, Number(reason === 'ok'), reason);
    }
    const f = fixture(); f.world.factions.push('The Covenant'); f.world.cash = 1e15; f.world.sleeveCost = 1e13;
    f.ns.args = [JSON.stringify({ ownerPid: 10, createdAt: f.clock.now, resetEpoch: '10:1:1', budget: .02 })];
    await loadScript('sleeve-upgrades.js', f.clock).main(f.ns);
    assert.deepEqual(f.world.calls, [['buy-sleeve']]);
});
