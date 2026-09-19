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
        read: () => '', write: async () => {}, hasTorRouter: () => true,
        getFavorToDonate: () => 150,
        fileExists: name => name === 'bootstrap.js',
        singularity: {
            checkFactionInvitations: () => world.invitations,
            isBusy: () => world.current !== null,
            joinFaction: faction => { world.joins.push(faction); world.factions.push(faction); return true; },
            getOwnedAugmentations: purchased => purchased ? world.purchased : world.installed,
            getFactionRep: () => world.rep,
            getFactionFavor: () => world.favor,
            getAugmentationsFromFaction: () => world.purchased.includes('BitWire') ? [] : ['BitWire'],
            getAugmentationRepReq: () => 100,
            getAugmentationPrice: () => 1000,
            getAugmentationPrereq: () => [],
            getAugmentationStats: () => ({ hacking: 1.1 }),
            getCurrentWork: () => world.current,
            getFactionWorkTypes: () => ['hacking'],
            workForFaction: (faction, type, focus) => { world.works.push({ faction, type, focus }); world.current = { type: 'FACTION', factionName: faction, factionWorkType: type }; return true; },
            donateToFaction: (faction, amount) => { world.donations.push({ faction, amount }); world.rep = 100; world.cash -= amount; return true; },
            purchaseAugmentation: (faction, name) => { world.buys.push({ faction, name }); world.purchased.push(name); return true; },
            stopAction: () => { world.current = null; return true; },
            installAugmentations: script => world.installs.push(script),
        },
        ...overrides,
    };
    const cfg = { focus: 'hacking', target: '', cashReserve: .1, joinFactions: true, cityFaction: '', work: true, donate: true,
        purchase: true, focusWork: false, autoInstall: false, minInstall: 5 };
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
    f.ns.formulas = { work: { donationForRep: () => 1e6 } };
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.phase, 'DONATE'); assert.equal(f.world.donations.length, 1); assert.equal(f.world.works.length, 0);
});

test('automatic installation requires the threshold and restarts through bootstrap', async () => {
    const f = fixture();
    f.ns.singularity.getAugmentationsFromFaction = () => [];
    f.world.purchased = ['A', 'B', 'C', 'D', 'E'];
    f.cfg.autoInstall = true;
    const status = await f.api.tickAugmentationLoop(f.ns, f.cfg, f.state);
    assert.equal(status.state, 'RESETTING'); assert.deepEqual(f.world.installs, ['bootstrap.js']);
});
