const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function tasks(hacking = true) {
    const weights = hacking ? { hackWeight: 100 } : { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25 };
    const task = (name, values = {}) => ({ name, difficulty: 1, baseMoney: 0, baseRespect: 0, baseWanted: 0,
        territory: { money: 1, respect: 1, wanted: 1 }, ...weights, ...values });
    return [task('Unassigned'), task('Train Hacking', { difficulty: 45, hackWeight: 100 }),
        task('Train Combat', { difficulty: 100 }), task('Train Charisma'), task('Territory Warfare'),
        task(hacking ? 'Ransomware' : 'Mug People', { baseMoney: 3, baseRespect: .00005, baseWanted: .0001 }),
        task(hacking ? 'Money Laundering' : 'Traffick Illegal Arms', { baseMoney: 360, baseRespect: .001, baseWanted: 1.25, difficulty: 25 }),
        task(hacking ? 'Cyberterrorism' : 'Terrorism', { baseRespect: .01, baseWanted: 6, difficulty: 36 }),
        task(hacking ? 'Ethical Hacking' : 'Vigilante Justice', { baseWanted: -.001 })];
}
function member(name, level = 1) {
    return { name, task: 'Unassigned', hack: level, str: level, def: level, dex: level, agi: level, cha: level,
        hack_asc_mult: 1, str_asc_mult: 1, def_asc_mult: 1, dex_asc_mult: 1, agi_asc_mult: 1, upgrades: [], augmentations: [] };
}
function fixture(options = {}) {
    const clock = new Clock(), api = loadScript('gang-manager.js', clock), policy = loadScript('lib/gang-policy.js', clock);
    const world = { reset: { currentNode: 2, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() }, factions: ['NiteSec'], cash: 1e6,
        inGang: false, members: [], gang: { faction: 'NiteSec', isHacking: true, respect: 1, wantedLevel: 1, wantedPenalty: .5,
            territory: .14, territoryWarfareEngaged: false, territoryClashChance: 0, moneyGainRate: 12, respectGainRate: 2, wantedLevelGainRate: 0 },
        ascensions: {}, equipment: {}, calls: [], files: {}, ...options };
    const ports = new Map();
    const ns = { pid: 33, getHostname: () => 'home', getScriptName: () => 'gang-manager.js',
        ps: () => [{ pid: 33, filename: 'gang-manager.js' }, { pid: 44, filename: 'augmentation-manager.js' }],
        getResetInfo: () => world.reset, getPlayer: () => ({ factions: world.factions }), getServerMoneyAvailable: () => world.cash,
        getPortHandle: p => { if (!ports.has(p)) ports.set(p, new Port()); return ports.get(p); },
        read: p => world.files[p] || '', fileExists: () => false, hasTorRouter: () => false,
        flags: defaults => ({ ...Object.fromEntries(defaults), ticks: 1 }), disableLog() {}, clearLog() {}, print() {},
        tprint: text => world.calls.push(['print', text]), sleep: async ms => { clock.now += ms; },
        gang: { inGang: () => world.inGang, createGang: faction => { world.calls.push(['create', faction]); world.inGang = true; world.gang.faction = faction; return true; },
            getGangInformation: () => ({ ...world.gang }), getMemberNames: () => world.members.map(m => m.name),
            getMemberInformation: name => ({ ...world.members.find(m => m.name === name) }),
            setTerritoryWarfare: value => { world.calls.push(['warfare', value]); world.gang.territoryWarfareEngaged = value; },
            canRecruitMember: () => world.members.length < 12 && (world.members.length < 3 || world.gang.respect >= 5 ** (world.members.length - 2)),
            recruitMember: name => { world.calls.push(['recruit', name]); world.members.push(member(name)); return true; },
            getTaskNames: () => tasks(world.gang.isHacking).map(t => t.name), getTaskStats: name => tasks(world.gang.isHacking).find(t => t.name === name),
            setMemberTask: (name, task) => { world.calls.push(['task', name, task]); world.members.find(m => m.name === name).task = task; return true; },
            getAscensionResult: name => world.ascensions[name] || null,
            ascendMember: name => { world.calls.push(['ascend', name]); const m = world.members.find(m => m.name === name), result = world.ascensions[name];
                world.gang.respect -= result.respect; m.hack = 1; m.hack_asc_mult *= result.hack; return result; },
            getEquipmentNames: () => Object.keys(world.equipment), getEquipmentStats: name => world.equipment[name].stats,
            getEquipmentCost: name => world.equipment[name].cost,
            purchaseEquipment: (name, item) => { world.calls.push(['buy', name, item]); world.cash -= world.equipment[item].cost;
                world.members.find(m => m.name === name).upgrades.push(item); return true; } } };
    return { ns, api, policy, world, clock, ports, cfg: policy.normalizeGangConfig(), state: {} };
}
function active(f, count = 12, level = 500) {
    f.world.inGang = true; f.world.members = Array.from({ length: count }, (_, i) => member(`member-${String(i + 1).padStart(2, '0')}`, level));
    Object.assign(f.world.gang, { respect: 1e8, wantedLevel: 1, wantedPenalty: .999999 });
}
function tick(f) { return f.api.gangTick(f.ns, f.cfg, f.state); }

test('BN2 creates a joined hacking gang, recruits all free members, and trains them without Singularity', () => {
    const f = fixture(), status = tick(f);
    assert.equal(status.faction, 'NiteSec'); assert.equal(status.memberCount, 3);
    assert.equal(status.tasks['Train Hacking'], 3); assert.equal(status.incomePerSecond, 60);
    assert.equal(status.respectPerSecond, 10); assert.equal(f.ns.singularity, undefined);
});
test('auto creation waits for hacking faction and explicitly configured combat creation is allowed', () => {
    const f = fixture({ factions: ['Slum Snakes'] });
    assert.equal(tick(f).state, 'WAITING'); assert.equal(f.world.calls.length, 0);
    f.cfg.faction = 'Slum Snakes'; tick(f); assert.deepEqual(f.world.calls[0], ['create', 'Slum Snakes']);
});
test('gang capability gates access and SF2 creation failure remains a non-crime wait', () => {
    const f = fixture(); f.world.reset.currentNode = 1;
    f.ns.gang.inGang = () => { throw new Error('must not access locked API'); };
    assert.equal(tick(f).state, 'LOCKED'); f.world.reset.ownedSF.set(2, 1);
    f.ns.gang.inGang = () => false; f.ns.gang.createGang = () => false;
    assert.match(tick(f).recommendation, /-54000/);
});
test('fresh wanted floor cannot trap the gang in suppression: respect earns the fourth recruit', () => {
    const f = fixture(); tick(f); f.world.members.forEach(m => Object.assign(m, member(m.name, 100)));
    let earned = 0;
    for (let cycle = 0; cycle < 3000 && f.world.members.length < 4; cycle++) {
        const status = tick(f), g = f.world.gang;
        let respect = 0, wanted = 0;
        for (const m of f.world.members) {
            const gain = f.policy.gangTaskGains(g, m, f.ns.gang.getTaskStats(m.task)); respect += gain.respect; wanted += gain.wanted;
        }
        earned += respect; g.respect += respect * 10; g.wantedLevel = Math.max(1, g.wantedLevel + wanted * 10);
        g.wantedPenalty = g.respect / (g.respect + g.wantedLevel); f.clock.now += 2000;
        assert.ok(Object.keys(status.tasks).every(task => task !== 'Territory Warfare'));
    }
    assert.ok(earned > 0); assert.ok(f.world.members.length >= 4, 'respect should unlock recruitment');
});
test('wanted crisis assigns suppression, then returns to production at the wanted floor', () => {
    const f = fixture(); active(f); Object.assign(f.world.gang, { respect: 50, wantedLevel: 500, wantedPenalty: 50 / 550 });
    const crisis = tick(f); assert.ok(crisis.tasks['Ethical Hacking'] > 0);
    const plan = f.policy.planGangTasks(f.world.gang, f.world.members, tasks());
    assert.ok(plan.reduce((sum, row) => sum + row.wanted, 0) <= 0);
    Object.assign(f.world.gang, { wantedLevel: 1, wantedPenalty: 50 / 51 });
    tick(f); assert.ok(f.world.members.some(m => f.ns.gang.getTaskStats(m.task).baseRespect > 0));
});
test('adopted combat gang disables warfare and evacuates warfare members before other operations', () => {
    const f = fixture(); active(f); f.world.gang.isHacking = false; f.world.gang.faction = 'Slum Snakes';
    f.world.gang.territoryWarfareEngaged = true; f.world.gang.territoryClashChance = .99;
    f.world.members[0].task = 'Territory Warfare';
    const status = tick(f); assert.deepEqual(f.world.calls[0], ['warfare', false]);
    assert.deepEqual(f.world.calls[1], ['task', 'member-01', 'Train Combat']);
    assert.equal(status.isHacking, false); assert.equal(status.clashChance, .99);
    assert.ok(f.world.members.every(m => m.task !== 'Territory Warfare'));
});
test('ascension preserves respect, keeps producing members, and allows only one per minute', () => {
    const f = fixture(); active(f);
    for (const m of f.world.members) f.world.ascensions[m.name] = { hack: 2, respect: 1e5 };
    f.world.ascensions['member-01'].respect = 9e7;
    tick(f); assert.deepEqual(f.world.calls.filter(c => c[0] === 'ascend'), [['ascend', 'member-02']]);
    tick(f); assert.equal(f.world.calls.filter(c => c[0] === 'ascend').length, 1);
    f.clock.now += 60000; tick(f); assert.equal(f.world.calls.filter(c => c[0] === 'ascend').length, 2);
});
test('equipment budget protects savings and buys only useful unowned equipment', () => {
    const f = fixture(); active(f); f.world.cash = 1e6;
    f.world.files['data/savings.json'] = JSON.stringify({ version: 1, amount: 900000, epoch: '2:1:2', label: 'augmentation', target: 'augmentation:x', owner: 'manual' });
    f.world.equipment = { laptop: { cost: 1000, stats: { hack: 1.1 } }, gun: { cost: 1, stats: { str: 2 } } };
    f.world.members[0].upgrades.push('laptop'); tick(f);
    const purchases = f.world.calls.filter(c => c[0] === 'buy');
    assert.equal(purchases.length, 5); assert.ok(purchases.every(c => c[2] === 'laptop' && c[1] !== 'member-01'));
    assert.equal(f.world.cash, 995000);
});
test('malformed savings fails closed without stopping productive task assignment', () => {
    const f = fixture(); active(f); f.world.files['data/savings.json'] = 'bad json';
    f.world.equipment = { laptop: { cost: 1, stats: { hack: 2 } } };
    assert.equal(tick(f).state, 'ACTIVE'); assert.equal(f.world.calls.filter(c => c[0] === 'buy').length, 0);
    assert.ok(f.world.calls.some(c => c[0] === 'task'));
});
test('fresh owned install intent pauses purchases and ascensions while stale or old-reset intent does not', () => {
    for (const variant of ['live', 'stale', 'epoch', 'dead']) {
        const f = fixture(); active(f); f.world.equipment = { laptop: { cost: 1000, stats: { hack: 2 } } };
        f.world.ascensions['member-01'] = { hack: 2, respect: 0 };
        f.ns.getPortHandle(11).write({ type: 'augmentation-status', phase: 'INSTALL', state: 'RESETTING', queued: 1,
            producerPid: variant === 'dead' ? 1234 : 44, generatedAt: f.clock.now - (variant === 'stale' ? 20000 : 0), resetEpoch: variant === 'epoch' ? '2:1:1' : '2:1:2' });
        const status = tick(f), mutations = f.world.calls.filter(c => ['buy', 'ascend'].includes(c[0]));
        if (variant === 'live') { assert.equal(status.state, 'INSTALLING'); assert.equal(mutations.length, 0); }
        else assert.ok(mutations.length > 0, variant);
    }
});
test('runtime publishes reset-scoped ownership heartbeat and retries failed cycles', async () => {
    const f = fixture(); f.ns.flags = defaults => ({ ...Object.fromEntries(defaults), ticks: 2 });
    const original = f.ns.gang.inGang; let calls = 0; f.ns.gang.inGang = () => { if (!calls++) throw new Error('transient'); return original(); };
    await f.api.main(f.ns); const report = f.ns.getPortHandle(3).peek();
    assert.equal(report.state, 'ACTIVE'); assert.equal(report.type, 'gang-status'); assert.equal(report.producerPid, 33);
    assert.equal(report.resetEpoch, '2:1:2'); assert.equal(report.generatedAt, f.clock.now);
});
test('remote or duplicate invocation cannot mutate gang state or overwrite telemetry', async () => {
    for (const variant of ['remote', 'duplicate']) {
        const f = fixture(); if (variant === 'remote') f.ns.getHostname = () => 'n00dles';
        else f.ns.ps = () => [{ filename: 'gang-manager.js', pid: 99 }];
        await f.api.main(f.ns); assert.ok(f.world.calls.every(c => c[0] === 'print')); assert.equal(f.ports.size, 0);
    }
});
test('configuration rejects unsafe numbers and unknown factions', () => {
    const f = fixture(); for (const cfg of [{ budget: -1 }, { budget: Infinity }, { budget: 2 }, { interval: 0 }, { ticks: -.1 }, { port: 0 }, { port: 11 }, { port: 19 }, { faction: 'Daedalus' }])
        assert.throws(() => f.policy.normalizeGangConfig(cfg));
});

test('task gains match independently calculated stable formula fixtures and stat difficulty cutoffs', () => {
    const f = fixture(), g = { respect: 900, wantedLevel: 100, territory: 1 };
    // At full territory and GangSoftcap=1, the exponent and all territory multipliers
    // are one: respect=11*.00005*(100-4)*.9=.04752, money=5*3*(100-3.2)*.9=1306.8.
    const ransomware = tasks().find(t => t.name === 'Ransomware');
    const gain = f.policy.gangTaskGains(g, member('a', 100), ransomware);
    assert.ok(Math.abs(gain.respect - .04752) < 1e-12);
    assert.ok(Math.abs(gain.money - 1306.8) < 1e-9);
    // 7*.0001 / (3*(100-3.5))^.8, independently precomputed.
    assert.ok(Math.abs(gain.wanted - 0.00000751240832981624) < 1e-12);
    const ethical = { ...ransomware, baseRespect: 0, baseWanted: -.001 };
    assert.ok(Math.abs(f.policy.gangTaskGains(g, member('a', 100), ethical).wanted - (-.0386)) < 1e-12);
    const novice = f.policy.gangTaskGains(g, member('a', 1), ransomware);
    assert.equal(novice.money, 0); assert.equal(novice.respect, 0); assert.equal(novice.wanted, 0);
});

test('augmentation reset adopts the persistent gang and node reset creates a new gang', () => {
    const f = fixture(); active(f); f.state.epoch = '2:1:2'; f.state.lastAscensionAt = f.clock.now;
    f.world.members[0].hack_asc_mult = 5; f.world.reset.lastAugReset = 3;
    const afterInstall = tick(f);
    assert.equal(afterInstall.memberCount, 12); assert.equal(f.world.members[0].hack_asc_mult, 5);
    assert.ok(f.world.calls.every(c => c[0] !== 'create')); assert.equal(f.state.lastAscensionAt, undefined);
    f.world.reset = { ...f.world.reset, lastNodeReset: 4, lastAugReset: 4 };
    f.world.inGang = false; f.world.members = []; f.world.factions = [];
    assert.equal(tick(f).state, 'WAITING'); f.world.factions.push('NiteSec');
    Object.assign(f.world.gang, { respect: 1, wantedLevel: 1, wantedPenalty: .5 });
    assert.equal(tick(f).memberCount, 3); assert.equal(f.world.calls.filter(c => c[0] === 'create').length, 1);
});

test('equipment-boosted members keep a bounded ascension training rotation after passing basic skill thresholds', () => {
    const f = fixture(); active(f);
    for (const m of f.world.members) Object.assign(m, { hack_exp: 500, hack_mult: 4 });
    let status = tick(f);
    assert.equal(status.growthMembers.length, 4);
    assert.equal(status.tasks['Train Hacking'], 4);
    assert.equal(f.world.members.filter(m => !m.task.startsWith('Train ')).length, 8);
    assert.ok(f.world.members.some(m => f.ns.gang.getTaskStats(m.task).baseRespect > 0));
    f.world.members[11].hack = 1;
    status = tick(f);
    assert.equal(status.growthMembers.length, 3, 'mandatory novice training shares the growth budget');
    assert.equal(status.tasks['Train Hacking'], 4);
    Object.assign(f.world.gang, { wantedPenalty: .8, wantedLevel: 2.5e7 });
    assert.equal(tick(f).growthMembers.length, 0, 'wanted recovery takes priority over optional growth');
});

test('ascension targets diminish as multipliers grow while protecting high-contribution members', () => {
    const f = fixture(); active(f);
    for (const m of f.world.members) Object.assign(m, { hack_asc_mult: 16, hack: 2000 });
    f.world.ascensions['member-01'] = { hack: 1.2, respect: 1e5 };
    tick(f);
    assert.ok(f.world.calls.some(c => c[0] === 'ascend'));
    assert.equal(f.policy.gangAscensionThreshold({ hack_asc_mult: 1 }, true), 1.5);
    assert.equal(f.policy.gangAscensionThreshold({ hack_asc_mult: 100 }, true), 1.1);
});

test('unused gear allowance accumulates for larger items and never consumes protected savings', () => {
    const f = fixture(); active(f); f.world.cash = 1e6;
    f.world.files['data/savings.json'] = JSON.stringify({ version: 1, amount: 900000, epoch: '2:1:2',
        label: 'manual', target: 'manual', owner: 'manual' });
    f.world.equipment = { laptop: { cost: 20000, stats: { hack: 1.1 } } };
    tick(f); tick(f);
    assert.equal(f.state.equipmentBudget, 5000, 'repeated calls at the same time cannot manufacture allowance');
    for (let i = 0; i < 3; i++) { f.clock.now += 2000; tick(f); }
    assert.equal(f.world.calls.filter(c => c[0] === 'buy').length, 1);
    assert.equal(f.world.cash, 980000);
    for (let i = 0; i < 100; i++) { f.clock.now += 2000; tick(f); }
    assert.ok(f.world.cash >= 900000);
    f.cfg.budget = 0; f.clock.now += 2000; tick(f);
    assert.equal(f.state.equipmentBudget, 0);
});

test('a nearly finished gang rep goal temporarily pauses growth and ascension', () => {
    const f = fixture(); active(f);
    for (const m of f.world.members) m.hack_exp = 500;
    f.world.ascensions['member-01'] = { hack: 2, respect: 0 };
    const status = { type: 'augmentation-status', producerPid: 44, generatedAt: f.clock.now, resetEpoch: '2:1:2',
        plan: { next: { faction: 'NiteSec', passiveReputation: true, repGap: 10, rate: 1 } } };
    f.ns.getPortHandle(11).write(status);
    assert.equal(tick(f).growthMembers.length, 0);
    assert.ok(f.world.calls.every(c => c[0] !== 'ascend'));
    status.plan.next.repGap = 10000;
    tick(f);
    assert.ok(f.world.calls.some(c => c[0] === 'ascend'));
});

test('wanted repair downgrades the last risky producer instead of leaving an unsustainable crime running', () => {
    const f = fixture();
    const gang = { isHacking: true, respect: 1000, wantedLevel: 1, wantedPenalty: 1000 / 1001, territory: .14 };
    const crew = Array.from({ length: 3 }, (_, i) => member('m' + i, 500));
    const plan = f.policy.planGangTasks(gang, crew, tasks(), true);
    const wanted = plan.reduce((n, r) => n + r.wanted, 0), respect = plan.reduce((n, r) => n + r.respect, 0);
    assert.ok(respect > 0);
    assert.ok(wanted <= respect * .05 / .95 + 1e-9, 'do not enter a wanted/suppression oscillation');
});

test('high-tier productive work can supply ascension XP without an unnecessary training tax', () => {
    const f = fixture(); active(f);
    for (const m of f.world.members) m.hack_exp = 500;
    const production = f.world.members.map(m => ({ name: m.name, task: 'Cyberterrorism' }));
    assert.equal(f.policy.gangGrowthMembers(f.world.gang, f.world.members, {}, tasks(), production).length, 0);
    for (const row of production) row.task = 'Ransomware';
    assert.equal(f.policy.gangGrowthMembers(f.world.gang, f.world.members, {}, tasks(), production).length, 4);
});
