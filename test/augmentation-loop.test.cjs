const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

const clock = new Clock();
const policy = loadScript('lib/augmentation-loop.js', clock);

test('invitation policy joins non-city factions and only the selected city faction', () => {
    assert.equal(policy.chooseInvitation(['Aevum', 'CyberSec'], [], ''), 'CyberSec');
    assert.equal(policy.chooseInvitation(['Aevum', 'CyberSec'], [], 'Aevum'), 'Aevum');
    assert.equal(policy.chooseInvitation(['CyberSec'], ['CyberSec'], ''), '');
});

test('faction work selection follows the configured focus and available work', () => {
    const player = { skills: { hacking: 500, strength: 10, defense: 10, dexterity: 10, agility: 10, charisma: 1 } };
    assert.equal(policy.chooseFactionWorkType(['security', 'hacking'], player, 'hacking'), 'hacking');
    assert.equal(policy.chooseFactionWorkType(['security'], player, 'hacking'), 'security');
});

test('augmentation spending honors reserves and unrelated savings but releases its matching goal', () => {
    assert.equal(policy.spendableForAugmentation(1000, 800, .1, { floor: 500, target: 'manual' }, 'BitWire'), false);
    assert.equal(policy.spendableForAugmentation(1000, 800, .1, { floor: 800, target: 'augmentation:BitWire' }, 'BitWire'), true);
    assert.equal(policy.spendableForAugmentation(1000, 950, .1, { floor: 0 }, 'BitWire'), false);
});

function fixture(overrides = {}) {
    const state = { resetEpoch: '4:1:2', ownedWork: null };
    const world = { rep: 0, favor: 0, cash: 1e9, current: null, factions: ['CyberSec'], invitations: [], installed: [], purchased: [], buys: [], joins: [], works: [], donations: [], installs: [] };
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    const ns = {
        getResetInfo: () => reset,
        getPlayer: () => ({ factions: world.factions, skills: { hacking: 500, strength: 10, defense: 10, dexterity: 10, agility: 10, charisma: 1 } }),
        getServerMoneyAvailable: () => world.cash,
        read: file => file === 'data/supervisor-bootstrap.json' ? JSON.stringify({ version: 2, args: [] }) : '', write: async () => {}, hasTorRouter: () => true,
        getFavorToDonate: () => 150,
        fileExists: name => name === 'bootstrap.js',
        singularity: {
            checkFactionInvitations: () => world.invitations,
            isBusy: () => world.current !== null,
            joinFaction: faction => { world.joins.push(faction); world.factions.push(faction); return true; },
            getOwnedAugmentations: purchased => purchased ? [...world.installed, ...world.purchased] : world.installed,
            getFactionRep: () => world.rep,
            getFactionFavor: () => world.favor,
            getAugmentationsFromFaction: () => world.purchased.includes('BitWire') ? [] : ['BitWire'],
            getAugmentationRepReq: () => 100,
            getAugmentationPrice: () => 1000,
            getAugmentationPrereq: () => [],
            getAugmentationStats: () => ({ hacking: 1.1 }),
            getCurrentWork: () => world.current,
            isFocused: () => false,
            getFactionWorkTypes: () => ['hacking'],
            workForFaction: (faction, type, focus) => { world.works.push({ faction, type, focus }); world.current = { type: 'FACTION', factionName: faction, factionWorkType: type }; return true; },
            donateToFaction: (faction, amount) => { world.donations.push({ faction, amount }); world.rep = 100; world.cash -= amount; return true; },
            purchaseAugmentation: (faction, name) => { world.buys.push({ faction, name }); world.purchased.push(name); return true; },
            stopAction: () => { world.current = null; return true; },
            installAugmentations: script => { world.installs.push(script); },
        },
        ...overrides,
    };
    const cfg = { focus: 'hacking', target: '', cashReserve: .1, joinFactions: true, cityFaction: '', work: true, donate: true,
        purchase: true, focusWork: false, minInstall: 5 };
    return { ns, cfg, state, world, reset, api: loadScript('augmentation-manager.js', clock) };
}

test('locked loop gives an actionable Singularity recommendation without calling the API', async () => {
    const f = fixture(); f.reset.currentNode = 1;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'UNLOCK');
    assert.match(status.recommendation, /BitNode 4/);
});

test('loop joins safe invitations, works for reputation, then purchases the augmentation', async () => {
    const f = fixture(); f.world.factions = []; f.world.invitations = ['CyberSec'];
    let status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'JOIN'); assert.deepEqual(f.world.joins, ['CyberSec']);
    f.world.invitations = [];
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'REPUTATION'); assert.equal(f.world.works.length, 1);
    assert.equal(f.state.ownedWork.faction, 'CyberSec'); assert.equal(f.state.ownedWork.workType, 'hacking');
    f.world.rep = 100;
    status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'PURCHASE'); assert.equal(f.world.buys[0].name, 'BitWire');
});

test('loop preserves unrelated manual activity and will not claim or interrupt it', async () => {
    const f = fixture();
    f.world.current = { type: 'CRIME', crimeType: 'Homicide' };
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'BLOCKED'); assert.match(status.recommendation, /current CRIME/);
    assert.equal(f.world.works.length, 0); assert.equal(f.state.ownedWork, null);
});

test('loop does not interrupt a busy Singularity action that has no current-work record', async () => {
    const f = fixture(); f.ns.singularity.isBusy = () => true;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'BLOCKED'); assert.match(status.recommendation, /Singularity action/);
    assert.equal(f.world.works.length, 0);
});

test('loop donates for reputation only when favor, formulas, purchase cash, and reserve are available', async () => {
    const f = fixture(); f.world.favor = 200;
    f.ns.fileExists = name => ['bootstrap.js', 'Formulas.exe'].includes(name);
    f.ns.formulas = { reputation: { donationForRep: () => 1e6 } };
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'DONATE'); assert.equal(f.world.donations.length, 1); assert.equal(f.world.works.length, 0);
});

test('automatic installation requires the threshold and restarts through bootstrap', async () => {
    const f = fixture();
    f.ns.singularity.getAugmentationsFromFaction = () => [];
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];

    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING'); assert.deepEqual(f.world.installs, ['bootstrap.js']);
});

test('the loop installs at the threshold with expensive upgrades and invitations still pending', async () => {
    const f = fixture();
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
    f.world.invitations = ['NiteSec'];

    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.deepEqual(f.world.installs, ['bootstrap.js']);
    assert.equal(f.world.works.length + f.world.joins.length + f.world.buys.length, 0);
});

test('an obsolete autoInstall field cannot disable threshold installation', async () => {
    const f = fixture(); f.world.rep = 100; f.cfg.autoInstall = false;
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.deepEqual(f.world.installs, ['bootstrap.js']);
});

test('queued counts include additional NeuroFlux levels when one is already installed', () => {
    assert.deepEqual(Array.from(policy.queuedAugmentations(['BitWire', 'NeuroFlux Governor'],
        ['BitWire', 'NeuroFlux Governor', 'NeuroFlux Governor', 'NeuroFlux Governor'])),
        ['NeuroFlux Governor', 'NeuroFlux Governor']);
});

test('automatic reset still respects manual work, busy actions, bootstrap and failed stop/install', async () => {
    for (const reason of ['manual', 'busy', 'bootstrap', 'settings', 'stop', 'install']) {
        const f = fixture();
        f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
        if (reason === 'manual') f.world.current = { type: 'CRIME' };
        if (reason === 'busy') f.ns.singularity.isBusy = () => true;
        if (reason === 'bootstrap') f.ns.fileExists = () => false;
        if (reason === 'settings') f.ns.read = () => '{broken';
        if (reason === 'stop') {
            f.world.current = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' };
            f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' };
            f.ns.singularity.stopAction = () => false;
        }
        if (reason === 'install') f.ns.singularity.installAugmentations = () => false;
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        assert.equal(status.state, 'BLOCKED', reason);
        assert.equal(f.world.installs.length, 0, reason);
    }
});

test('threshold reset can stop owned work, while a small exhausted catalog stays manual', async () => {
    const f = fixture();
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
    f.world.current = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' };
    f.state.ownedWork = { faction: 'CyberSec', workType: 'hacking' };
    assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).state, 'RESETTING');
    assert.equal(f.world.current, null);
    const small = fixture(); small.world.purchased = ['BitWire'];
    const status = await small.api.tickAugmentationLoop(small.ns, small.cfg, small.state);
    assert.equal(status.state, 'WAITING');
    assert.match(status.recommendation, /lower --min-install to 1/);
    assert.equal(small.world.installs.length, 0);
});

test('faction ETA applies unfocused penalty and reads focus of already-running work', async () => {
    for (const mode of ['unfocused', 'configured-focus', 'manual-focus', 'implant', 'queued-implant']) {
        const f = fixture(); f.cfg.donate = false;
        f.ns.fileExists = () => true;
        f.ns.formulas = { work: { factionGains: () => ({ reputation: 3 }) } };
        if (mode === 'configured-focus') f.cfg.focusWork = true;
        if (mode === 'manual-focus') {
            f.world.current = { type: 'FACTION', factionName: 'CyberSec', factionWorkType: 'hacking' };
            f.ns.singularity.isFocused = () => true;
        }
        if (mode === 'implant') f.world.installed = ['Neuroreceptor Management Implant'];
        if (mode === 'queued-implant') f.world.purchased = ['Neuroreceptor Management Implant'];
        const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
        const rate = ['unfocused', 'queued-implant'].includes(mode) ? 12 : 15;
        assert.equal(status.reputationPerSecond, rate, mode);
        assert.equal(status.etaMs, 100 / rate * 1000, mode);
    }
});


test('a single queued Red Pill installs before invitations or shopping', async () => {
    const f = fixture(); f.world.purchased = ['The Red Pill']; f.world.invitations = ['NiteSec'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING');
    assert.deepEqual(f.world.installs, ['bootstrap.js']);
    assert.equal(f.world.joins.length + f.world.buys.length + f.world.works.length, 0);
});

test('Red Pill threshold bypass preserves installation checks', async () => {
    for (const reason of ['manual', 'bootstrap', 'settings', 'busy']) {
        const f = fixture(); f.world.purchased = ['The Red Pill'];
        if (reason === 'manual') f.world.current = { type: 'CLASS' };
        if (reason === 'bootstrap') f.ns.fileExists = () => false;
        if (reason === 'settings') f.ns.read = () => '{}';
        if (reason === 'busy') f.ns.singularity.isBusy = () => true;
        assert.equal((await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state)).state, 'BLOCKED', reason);
        assert.equal(f.world.installs.length, 0);
    }
});

test('installed Red Pill prevents another augmentation reset while completing the node', async () => {
    const f = fixture(); f.world.installed = ['The Red Pill'];
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'COMPLETE_NODE');
    assert.equal(f.world.installs.length + f.world.buys.length + f.world.works.length, 0);
});
