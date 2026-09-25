const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), files = new Map([['data/supervisor-bootstrap.json', JSON.stringify({ version: 2, args: [] })]]);
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map([[5, 1]]) };
    const world = { exp: 100, int: 1, member: false, invited: true, busy: false, pending: [], installed: [], processes: [],
        flags: { start: true, minutes: 10, target: 3 }, resets: [], spawns: [], joins: 0, logs: [] };
    const ns = { pid: 10, getHostname: () => 'home', getResetInfo: () => reset,
        flags: defaults => ({ ...Object.fromEntries(defaults), ...world.flags }),
        getPlayer: () => ({ exp: { intelligence: world.exp }, skills: { intelligence: world.int }, factions: world.member ? ['Shadows of Anarchy'] : [] }),
        read: f => files.get(f) || '', write: async (f, v) => files.set(f, v), ps: () => world.processes,
        fileExists: () => true, getScriptRam: () => 32, getServerMaxRam: () => 64,
        spawn: (...args) => world.spawns.push(args), tprint: v => world.logs.push(v),
        singularity: { isBusy: () => world.busy, getOwnedAugmentations: pending => pending ? [...world.installed, ...world.pending] : world.installed,
            checkFactionInvitations: () => world.invited ? ['Shadows of Anarchy'] : [],
            joinFaction: () => { world.joins++; world.member = true; world.exp += 7.5; world.int++; return true; },
            softReset: script => { world.resets.push(script); } } };
    const api = loadScript('intelligence-farm.js', clock);
    function callback() { clock.now += 500; reset.lastAugReset = clock.now; world.member = false; world.flags = {}; }
    return { clock, files, reset, ns, world, api, callback, session: () => JSON.parse(files.get('data/intelligence-session.json')) };
}

test('INT farmer resumes across resets, measures gains, stops at target and restarts bootstrap', async () => {
    const f = fixture(); await f.api.main(f.ns);
    assert.deepEqual(f.world.resets, ['intelligence-farm.js']);
    assert.equal(f.session().awaitingReset, true);
    assert.equal(f.session().startExp, 100);
    f.callback(); await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1);
    assert.equal(f.world.joins, 2);
    assert.equal(f.session().active, false);
    assert.equal(f.session().metrics.gained, 15);
    assert.equal(f.session().metrics.resets, 1);
    assert.equal(f.session().metrics.xpPerHour, 108000);
    assert.equal(f.world.spawns[0][0], 'bootstrap.js');
});

test('INT deadline is absolute across callbacks and stops before another join/reset', async () => {
    const f = fixture(); f.world.flags.minutes = 1; f.world.flags.target = 100;
    await f.api.main(f.ns); const deadline = f.session().deadline;
    f.callback(); f.clock.now = deadline; await f.api.main(f.ns);
    assert.equal(f.session().deadline, deadline);
    assert.equal(f.session().reason, 'Time budget reached');
    assert.equal(f.world.joins, 1); assert.equal(f.world.resets.length, 1);
    assert.equal(f.world.spawns.length, 1);
});

test('INT farm can bootstrap an already-joined persistent faction', async () => {
    const f = fixture(); f.world.member = true; f.world.invited = false;
    await f.api.main(f.ns);
    assert.equal(f.world.joins, 0); assert.equal(f.world.resets.length, 1);
    f.callback(); f.world.invited = true; await f.api.main(f.ns);
    assert.equal(f.world.joins, 1); assert.equal(f.world.resets.length, 2);
});

test('manual stop survives callbacks; sessions never cross BitNodes', async () => {
    const f = fixture(); await f.api.main(f.ns);
    f.world.flags = { stop: true }; await f.api.main(f.ns);
    f.callback(); await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1); assert.equal(f.world.spawns.length, 0);
    assert.equal(f.session().active, false);
    f.reset.lastNodeReset++;
    assert.equal(loadScript('lib/intelligence-session.js', f.clock).readIntelligenceSession(f.ns), null);
});

test('farmer blocks unsafe starts and missing prerequisites without resetting', async () => {
    for (const reason of ['node', 'sf5', 'invitation', 'busy', 'queued', 'red-pill', 'supervisor', 'settings', 'script', 'ram', 'no-xp']) {
        const f = fixture();
        if (reason === 'node') f.reset.currentNode = 5;
        if (reason === 'sf5') f.reset.ownedSF.clear();
        if (reason === 'invitation') f.world.invited = false;
        if (reason === 'busy') f.world.busy = true;
        if (reason === 'queued') f.world.pending = ['BitWire'];
        if (reason === 'red-pill') f.world.installed = ['The Red Pill'];
        if (reason === 'supervisor') f.world.processes = [{ filename: 'supervisor.js', pid: 2 }];
        if (reason === 'settings') f.files.set('data/supervisor-bootstrap.json', '{}');
        if (reason === 'script') f.ns.getScriptRam = () => 0;
        if (reason === 'ram') f.ns.getServerMaxRam = () => 16;
        if (reason === 'no-xp') f.ns.singularity.joinFaction = () => true;
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 0, reason);
        assert.equal(f.world.spawns.length, 0, reason);
    }
});

test('unchanged reset epoch and failed softReset cannot form an unproductive retry loop', async () => {
    const f = fixture(); await f.api.main(f.ns);
    f.world.flags = {}; await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1);
    assert.equal(f.session().active, false);
    assert.match(f.session().reason, /did not complete/);
    const failed = fixture(); failed.ns.singularity.softReset = () => false;
    await failed.api.main(failed.ns);
    assert.equal(failed.session().active, false);
    assert.equal(failed.session().reason, 'Soft reset failed');
});

test('INT farmer validates budgets and refuses duplicates; no-argument invocation starts nothing', async () => {
    for (const flags of [{ minutes: 0 }, { minutes: Infinity }, { minutes: 61 }, { target: -1 }]) {
        const f = fixture(); Object.assign(f.world.flags, flags);
        await assert.rejects(f.api.main(f.ns), /minutes/);
        assert.equal(f.world.resets.length, 0);
    }
    const f = fixture(); f.world.processes = [{ filename: 'intelligence-farm.js', pid: 999 }];
    await assert.rejects(f.api.main(f.ns), /already running/);
    f.world.processes = []; f.world.flags = {}; await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 0);
    assert.match(f.world.logs[0], /Complete one infiltration/);
});
