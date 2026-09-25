const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), files = new Map();
    const reset = { currentNode: 5, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    const ns = { getResetInfo: () => reset, read: f => files.get(f) || '', write: async (f, v) => files.set(f, v),
        hasTorRouter: () => true, fileExists: () => true, getHostname: () => 'home', tprint() {},
        singularity: new Proxy({}, { get: () => assert.fail('BN5 path must not use Singularity') }) };
    return { clock, files, reset, ns, api: loadScript('lib/progression-milestones.js', clock) };
}

test('BN5 milestones request missing facts and defer the $100b reserve until other requirements are met', () => {
    const f = fixture(), input = { currentNode: 5, money: 1e9, player: { factions: [], skills: { hacking: 2500 } } };
    assert.equal(f.api.planMilestone(input).stage, 'AUGMENTATIONS_UNKNOWN');
    input.observation = { installedCount: 29 };
    assert.equal(f.api.planMilestone(input).savings, null);
    assert.match(f.api.planMilestone(input).label, /1 more/);
    input.observation.installedCount = 30; input.player.skills.hacking = 2499;
    assert.equal(f.api.planMilestone(input).stage, 'DAEDALUS_SKILL');
    assert.equal(f.api.planMilestone(input).savings, null);
    input.player.skills.hacking = 2500;
    assert.equal(f.api.planMilestone(input).savings.amount, 100e9);
    input.money = 100e9;
    assert.match(f.api.planMilestone(input).label, /Accept/);
    input.player.factions = ['Daedalus'];
    assert.equal(f.api.planMilestone(input).stage, 'RED_PILL');
    assert.equal(f.api.planMilestone(input).savings, null);
    input.observation = { daedalusRep: 100, redPillRepRequired: 1000, redPillPrice: 1e9 };
    assert.match(f.api.planMilestone(input).label, /900 reputation/);
    assert.equal(f.api.planMilestone(input).savings.target, 'augmentation:The Red Pill');
});

test('Red Pill installation and the final server use current hacking and root requirements', () => {
    const f = fixture(), input = { currentNode: 4, player: { skills: { hacking: 3000 } }, observation: { redPill: 'queued' } };
    assert.equal(f.api.planMilestone(input).stage, 'INSTALL');
    input.observation.redPill = 'installed';
    assert.equal(f.api.planMilestone(input).stage, 'DAEMON');
    input.worldDaemon = { discovered: true, requiredHacking: 4000, rooted: false, path: ['home', 'cave', 'w0r1d_d43m0n'] };
    assert.equal(f.api.planMilestone(input).stage, 'DAEMON_SKILL');
    input.player.skills.hacking = 4000;
    assert.equal(f.api.planMilestone(input).stage, 'DAEMON_ROOT');
    input.worldDaemon.rooted = true;
    assert.equal(f.api.planMilestone(input).stage, 'FINISH');
    assert.match(f.api.planMilestone(input).label, /home -> cave/);
});

test('manual observations expire on reset and fresh automatic reports take precedence', async () => {
    const f = fixture();
    f.ns.flags = defaults => ({ ...Object.fromEntries(defaults), 'installed-count': 30, 'red-pill': 'none' });
    await loadScript('progression-state.js', f.clock).main(f.ns);
    assert.equal(f.api.readProgressionObservation(f.ns).installedCount, 30);
    const report = { type: 'augmentation-plan', version: 1, generatedAt: f.clock.now, resetEpoch: '5:1:2', progression: { installedCount: 31 } };
    f.files.set('data/augmentation-plan.json', JSON.stringify(report));
    assert.equal(f.api.readProgressionObservation(f.ns).installedCount, 31);
    f.clock.now += 120001;
    assert.equal(f.api.readProgressionObservation(f.ns).installedCount, 30);
    f.reset.lastAugReset++;
    assert.equal(f.api.readProgressionObservation(f.ns).installedCount, undefined);
    f.files.set('data/progression-input.json', '{broken');
    assert.equal(f.api.readProgressionObservation(f.ns).installedCount, undefined);
});

test('milestone savings protect invitation cash, release it on joining, and preserve manual goals', async () => {
    const f = fixture(), utility = loadScript('lib/supervised-utilities.js', f.clock);
    const cfg = { savingsMode: 'auto', progression: true, progressionActions: true, augmentationActions: true, augmentationCashReserve: .1 };
    const status = { type: 'progression-status', generatedAt: f.clock.now, resetEpoch: '5:1:2', milestone: {
        label: 'Save for Daedalus', savings: { amount: 100e9, label: 'Daedalus', target: 'faction:Daedalus' } } };
    await utility.updateSupervisorSavings(f.ns, cfg, null, { ...status, resetEpoch: 'old' });
    assert.equal(f.files.has('data/savings.json'), false);
    await utility.updateSupervisorSavings(f.ns, cfg, null, status);
    assert.equal(JSON.parse(f.files.get('data/savings.json')).amount, 100e9);
    status.milestone = { label: 'Work for Daedalus', savings: null };
    await utility.updateSupervisorSavings(f.ns, cfg, null, status);
    assert.equal(JSON.parse(f.files.get('data/savings.json')).amount, 0);
    await loadScript('lib/savings.js', f.clock).writeSavings(f.ns, 123, 'My next augmentation');
    status.milestone.savings = { amount: 100e9, target: 'faction:Daedalus' };
    await utility.updateSupervisorSavings(f.ns, cfg, null, status);
    assert.equal(JSON.parse(f.files.get('data/savings.json')).amount, 123);
});

test('BN4 augmentation reports read unique installed counts and Red Pill quotes automatically', () => {
    const f = fixture();
    f.ns.getPlayer = () => ({ factions: ['Daedalus'] });
    f.ns.singularity = { getOwnedAugmentations: queued => queued
        ? ['BitWire', 'NeuroFlux Governor', 'NeuroFlux Governor', 'The Red Pill']
        : ['BitWire', 'NeuroFlux Governor', 'NeuroFlux Governor'],
        getFactionRep: () => 20, getAugmentationPrice: () => 1e9, getAugmentationRepReq: () => 50 };
    const result = loadScript('augmentation-planner.js', f.clock).progressionObservation(f.ns);
    assert.equal(result.installedCount, 2);
    assert.equal(result.redPill, 'queued');
    assert.equal(result.redPillPrice, 1e9);
    assert.equal(result.redPillRepRequired - result.daedalusRep, 30);
});
