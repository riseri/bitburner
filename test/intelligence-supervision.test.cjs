const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

const AUTO = 'data/intelligence-auto.json', SESSION = 'data/intelligence-session.json';

function fixture(node = 5, args = []) {
    const clock = new Clock(), reset = { currentNode: node, lastNodeReset: 1, lastAugReset: 2,
        ownedSF: new Map([[1, 3], [4, 3], [5, 1]]), ownedAugs: new Map([['Old', 1]]) };
    const files = new Map([['data/supervisor-bootstrap.json', JSON.stringify({ version: 2, args })]]);
    const world = { installed: ['Old'], pending: ['A', 'B', 'C', 'D', 'E'], factions: ['CyberSec'],
        invitations: ['Shadows of Anarchy', 'ECorp', 'MegaCorp'], int: 109, exp: 15085, work: null,
        processes: [{ filename: 'supervisor.js', pid: 2 }, { filename: 'augmentation-manager.js', pid: 10 }],
        installs: [], resets: [], joins: [], spawns: [], logs: [], kills: [], args: [], failInstall: false };
    const { readArgument } = loadScript('lib/service-lifecycle.js', clock);
    const { intelligenceFactions } = loadScript('lib/intelligence-session.js', clock);
    function resetWorld() {
        clock.now += 500; reset.lastAugReset = clock.now;
        world.invitations = Array.from(intelligenceFactions(world.factions, world.invitations));
        world.factions = []; world.work = null; world.processes = []; world.args = [];
    }
    const ns = { pid: 10, getHostname: () => 'home', getResetInfo: () => reset,
        flags: defaults => Object.fromEntries(defaults.map(([key, value]) => [key, readArgument(world.args, `--${key}`, value)])),
        getPlayer: () => ({ factions: [...world.factions], skills: { intelligence: world.int }, exp: { intelligence: world.exp } }),
        read: file => files.get(file) || '', write: async (file, value) => files.set(file, value),
        fileExists: () => true, getScriptRam: () => 32, getServerMaxRam: () => 256, ps: () => world.processes,
        spawn: (...args) => world.spawns.push(args), print: value => world.logs.push(value), tprint: value => world.logs.push(value),
        kill: pid => { world.kills.push(pid); return true; },
        singularity: { isBusy: () => Boolean(world.work), getCurrentWork: () => world.work,
            getOwnedAugmentations: pending => pending ? [...world.installed, ...world.pending] : [...world.installed],
            checkFactionInvitations: () => [...world.invitations],
            joinFaction: faction => {
                world.joins.push(faction); world.factions.push(faction);
                world.invitations = world.invitations.filter(name => name !== faction); world.exp += 7.5; return true;
            },
            installAugmentations: callback => {
                world.installs.push(callback); if (world.failInstall) return false;
                for (const name of world.pending) reset.ownedAugs.set(name,
                    name === 'NeuroFlux Governor' ? (reset.ownedAugs.get(name) || 0) + 1 : 1);
                world.installed = [...new Set([...world.installed, ...world.pending])]; world.pending = []; resetWorld();
            },
            softReset: callback => { world.resets.push(callback); resetWorld(); },
        } };
    const cfg = { route: true, intelligence: true, joinFactions: true, purchase: false, minInstall: 5 };
    const state = { resetEpoch: `${node}:1:2`, ownedWork: null };
    const manager = loadScript('augmentation-manager.js', clock), handoff = loadScript('intelligence-handoff.js', clock);
    const farmer = loadScript('intelligence-farm.js', clock), automation = loadScript('lib/intelligence-automation.js', clock);
    async function install() { state.resetEpoch = `${reset.currentNode}:${reset.lastNodeReset}:${reset.lastAugReset}`;
        return manager.handleInstallation(ns, cfg, state, null, world.pending.length, true); }
    async function enter() { ns.pid = 100; await handoff.main(ns); }
    async function farm() {
        const launch = world.spawns.at(-1); assert.equal(launch[0], 'intelligence-farm.js');
        world.args = launch.slice(2); ns.pid = 101; await farmer.main(ns);
    }
    return { clock, reset, files, world, ns, cfg, state, manager, handoff, farmer, automation, install, enter, farm,
        session: () => JSON.parse(files.get(SESSION)), request: () => JSON.parse(files.get(AUTO)) };
}

test('supervised BN5 installation farms above INT 109, returns through bootstrap, and never repeats the node budget', async () => {
    const args = ['--go', false, '--darknet', false, '--min-install', 4, '--max-batch-rate', 2];
    const f = fixture(5, args);
    assert.equal((await f.install()).state, 'RESETTING');
    assert.deepEqual(f.world.installs, ['intelligence-handoff.js']);
    assert.equal(f.world.joins.length, 0); // Augmentations install before any INT reset.
    assert.equal(f.world.installed.length, 6); assert.equal(f.world.pending.length, 0);
    await f.enter(); await f.farm();
    assert.equal(f.session().automatic, true); assert.equal(f.session().target, 0);
    assert.equal(f.session().startInt, 109); assert.equal(f.session().metrics.gained, 22.5);
    assert.deepEqual(f.world.joins, ['Shadows of Anarchy', 'ECorp', 'MegaCorp']);
    assert.equal(f.request().status, 'started'); assert.equal(f.world.kills.length, 0);
    const deadline = f.session().deadline;
    await f.farmer.main(f.ns);
    assert.equal(f.session().joins, 6); assert.equal(f.session().deadline, deadline);
    f.clock.now = deadline; await f.farmer.main(f.ns);
    assert.equal(f.session().active, false); assert.equal(f.session().reason, 'Time budget reached');
    assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js');
    await loadScript('bootstrap.js', f.clock).main(f.ns);
    assert.equal(f.world.spawns.at(-1)[0], 'supervisor.js');
    assert.deepEqual(f.world.spawns.at(-1).slice(2), args);
    f.world.pending = ['F', 'G', 'H', 'I', 'J'];
    await f.install();
    assert.equal(f.world.installs.at(-1), 'bootstrap.js');
    assert.equal(f.session().deadline, deadline);
});

test('automatic reset callbacks support every BitNode using SF4/SF5 capabilities', async () => {
    for (const node of [...Array.from({ length: 15 }, (_, index) => index + 1), 99]) {
        const f = fixture(node); await f.install(); await f.enter(); await f.farm();
        assert.equal(f.session().node, node); assert.equal(f.session().automatic, true);
        assert.equal(f.world.joins.length, 3); assert.equal(f.world.resets.length, 1);
    }
});

test('the next BitNode receives a new budget only after it acquires a persistent faction again', async () => {
    const f = fixture(); await f.install(); await f.enter(); await f.farm();
    f.clock.now = f.session().deadline; await f.farmer.main(f.ns);
    f.reset.currentNode = 12; f.reset.lastNodeReset = ++f.clock.now; f.reset.lastAugReset = f.clock.now;
    f.world.installed = []; f.world.pending = ['New']; f.world.invitations = []; f.world.factions = [];
    await f.install(); assert.equal(f.world.installs.at(-1), 'bootstrap.js');
    f.world.invitations = ['ECorp']; f.world.pending = ['Newer'];
    await f.install(); assert.equal(f.world.installs.at(-1), 'intelligence-handoff.js');
    await f.enter(); await f.farm();
    assert.equal(f.session().node, 12); assert.equal(f.session().nodeReset, f.reset.lastNodeReset);
    assert.deepEqual(f.session().factions, ['ECorp']);
});

test('optional INT prerequisites never postpone an approved augmentation installation', async () => {
    for (const reason of ['disabled', 'saved-disabled', 'progression-disabled', 'join-disabled', 'route-disabled',
        'no-int', 'no-faction', 'target-met', 'red-pill-queued', 'red-pill-installed', 'missing', 'ram', 'manual-budget', 'legacy-budget']) {
        const f = fixture();
        if (reason === 'disabled') f.cfg.intelligence = false;
        if (reason === 'saved-disabled') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence",false]}');
        if (reason === 'progression-disabled') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--progression-actions",false]}');
        if (reason === 'join-disabled') f.cfg.joinFactions = false;
        if (reason === 'route-disabled') f.cfg.route = false;
        if (reason === 'no-int') { f.reset.currentNode = 1; f.reset.ownedSF.delete(5); }
        if (reason === 'no-faction') f.world.invitations = ['CyberSec', 'Daedalus', 'Volhaven'];
        if (reason === 'target-met') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence-target",100]}');
        if (reason === 'red-pill-queued') f.world.pending.push('The Red Pill');
        if (reason === 'red-pill-installed') f.world.installed.push('The Red Pill');
        if (reason === 'missing') f.ns.fileExists = file => file !== 'intelligence-farm.js';
        if (reason === 'ram') f.ns.getScriptRam = file => file === 'intelligence-handoff.js' ? 512 : 32;
        if (reason === 'manual-budget') f.files.set(SESSION, JSON.stringify({ version: 1, active: false,
            node: 5, nodeReset: 1, startedAt: 1, deadline: 1000, target: 50, startExp: 0, startInt: 1, resets: 1 }));
        if (reason === 'legacy-budget') f.files.set(AUTO, '{"version":1,"nodeReset":1,"startedAt":1}');
        assert.equal((await f.install()).state, 'RESETTING', reason);
        assert.equal(f.world.installs[0], 'bootstrap.js', reason);
        assert.equal(f.world.pending.length, 0, reason);
        assert.equal(f.world.resets.length, 0, reason);
    }
});

test('NeuroFlux purchases merge into one installed name without preventing automatic INT farming', async () => {
    for (const onlyNeuroflux of [false, true]) {
        const f = fixture(), nfg = 'NeuroFlux Governor';
        f.world.installed.push(nfg); f.reset.ownedAugs.set(nfg, 5);
        f.world.pending = [...(onlyNeuroflux ? [] : f.world.pending), nfg, nfg];
        await f.install();
        assert.equal(f.request().neurofluxLevel, 7);
        assert.equal(f.request().expected.filter(name => name === nfg).length, 1);
        assert.equal(f.world.installed.filter(name => name === nfg).length, 1);
        await f.enter(); await f.farm();
        assert.equal(f.session().automatic, true);
        assert.equal(f.world.joins.length, 3);
    }
});

test('a reset without the requested NeuroFlux levels cannot authorize the INT budget', async () => {
    const f = fixture(), nfg = 'NeuroFlux Governor';
    f.world.installed.push(nfg); f.reset.ownedAugs.set(nfg, 5); f.world.pending = [nfg, nfg];
    await f.install(); f.reset.ownedAugs.set(nfg, 5);
    await f.enter();
    assert.deepEqual(f.world.spawns.map(launch => launch[0]), ['bootstrap.js']);
    assert.equal(f.world.resets.length, 0);
});

test('the handoff rechecks its request, installed package, policy and player ownership after reset', async () => {
    for (const reason of ['expired', 'node', 'epoch', 'corrupt', 'policy', 'budget-policy', 'busy', 'package', 'queued', 'pill',
        'faction', 'ram', 'supervisor', 'actor', 'missing']) {
        const f = fixture(); await f.install();
        if (reason === 'expired') f.clock.now = f.request().expiresAt;
        if (reason === 'node') f.reset.lastNodeReset++;
        if (reason === 'epoch') f.reset.lastAugReset = f.request().sourceAugReset;
        if (reason === 'corrupt') f.files.set(AUTO, '{');
        if (reason === 'policy') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence",false]}');
        if (reason === 'budget-policy') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence-minutes",1]}');
        if (reason === 'busy') f.world.work = { type: 'CRIME' };
        if (reason === 'package') f.world.installed.pop();
        if (reason === 'queued') f.world.pending.push('F');
        if (reason === 'pill') f.world.installed.push('The Red Pill');
        if (reason === 'faction') f.world.invitations = [];
        if (reason === 'ram') f.ns.getServerMaxRam = () => 16;
        if (reason === 'supervisor') f.world.processes = [{ filename: 'supervisor.js', pid: 2 }];
        if (reason === 'actor') f.world.processes = [{ filename: 'progression-backdoor.js', pid: 3 }];
        if (reason === 'missing') f.ns.fileExists = () => false;
        await f.enter();
        assert.ok(!f.world.spawns.some(launch => launch[0] === 'intelligence-farm.js'), reason);
        assert.equal(f.world.kills.length, 0, reason);
        if (reason !== 'supervisor') assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js', reason);
    }
});

test('failed installations cannot authorize INT farming, and an old pending request expires', async () => {
    const f = fixture(); f.world.failInstall = true;
    assert.equal((await f.install()).state, 'BLOCKED');
    assert.equal(f.request().status, 'pending');
    await f.enter();
    assert.equal(f.world.spawns.length, 0); assert.equal(f.world.resets.length, 0);
    f.clock.now += 30000;
    assert.equal(f.automation.readIntelligenceRequest(f.ns), null);
});

test('new player activity while arming the callback blocks installation and preserves the queue', async () => {
    const f = fixture(), write = f.ns.write;
    f.ns.write = async (file, value) => { await write(file, value); if (file === AUTO) f.world.work = { type: 'CRIME' }; };
    const status = await f.install();
    assert.equal(status.state, 'BLOCKED'); assert.equal(f.world.installs.length, 0);
    assert.equal(f.world.pending.length, 5);
});

test('changed epochs or activity while claiming a session resume automation without starting the farmer', async () => {
    for (const change of ['epoch', 'activity', 'queue', 'policy', 'budget', 'expiry']) {
        const f = fixture(); await f.install(); const write = f.ns.write;
        f.ns.write = async (file, value) => {
            await write(file, value);
            if (file !== AUTO) return;
            if (change === 'epoch') f.reset.lastAugReset++;
            if (change === 'activity') f.world.work = { type: 'CRIME' };
            if (change === 'queue') f.world.pending.push('Late');
            if (change === 'policy') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence",false]}');
            if (change === 'budget') f.files.set('data/supervisor-bootstrap.json', '{"version":2,"args":["--intelligence-minutes",1]}');
            if (change === 'expiry') f.clock.now = JSON.parse(value).expiresAt;
        };
        await f.enter();
        assert.deepEqual(f.world.spawns.map(launch => launch[0]), ['bootstrap.js'], change);
    }
});

test('an expired saved session cannot prevent supervision from returning', async () => {
    const f = fixture(); await f.install();
    f.files.set(SESSION, JSON.stringify({ version: 1, active: true, node: 5, nodeReset: 1,
        startedAt: 1, deadline: 1000, target: 50, startExp: 0, startInt: 1, resets: 0 }));
    await f.enter();
    assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js');
});

test('another live handoff or farmer retains ownership instead of spawning a competing supervisor', async () => {
    for (const filename of ['intelligence-handoff.js', 'intelligence-farm.js']) {
        const f = fixture(); await f.install();
        const request = { ...f.request(), status: 'started', consumerPid: 200 };
        f.files.set(AUTO, JSON.stringify(request)); f.world.processes = [{ filename, pid: 200 }];
        await f.enter(); assert.equal(f.world.spawns.length, 0, filename);
    }
});

test('unavailable INT stats in an automatic callback end its budget and restore supervision', async () => {
    const f = fixture(); await f.install(); await f.enter(); await f.farm();
    const player = f.ns.getPlayer;
    f.ns.getPlayer = () => ({ ...player(), exp: {} });
    await f.farmer.main(f.ns);
    assert.equal(f.session().active, false);
    assert.equal(f.session().reason, 'INT stats unavailable');
    assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js');
});

test('automatic farming failures and manual cancellation return to supervision without renewing the budget', async () => {
    for (const reason of ['join', 'no-xp', 'reset', 'stop']) {
        const f = fixture(); await f.install(); await f.enter();
        if (reason === 'join') f.ns.singularity.joinFaction = () => false;
        if (reason === 'no-xp') f.ns.singularity.joinFaction = () => true;
        if (reason === 'reset') f.ns.singularity.softReset = () => false;
        await f.farm();
        if (reason === 'stop') { f.world.args = ['--stop']; await f.farmer.main(f.ns); }
        assert.equal(f.session().active, false, reason);
        assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js', reason);
        f.world.pending = ['Next']; await f.install();
        assert.equal(f.world.installs.at(-1), 'bootstrap.js', reason);
    }
});

test('custom automatic limits are taken from the saved supervisor configuration', async () => {
    const f = fixture(5, ['--intelligence-minutes', 1, '--intelligence-target', 150]);
    await f.install(); await f.enter(); await f.farm();
    assert.equal(f.session().target, 150);
    assert.equal(f.session().deadline - f.session().startedAt, 60000);
    const deadline = f.session().deadline;
    f.clock.now = deadline; await f.farmer.main(f.ns);
    assert.equal(f.session().reason, 'Time budget reached');
    assert.equal(f.world.spawns.at(-1)[0], 'bootstrap.js');
});

test('automatic cancellation during a saved callback prevents the reset and restores supervision once', async () => {
    const f = fixture(); await f.install(); await f.enter();
    const write = f.ns.write; let stopped = false;
    f.ns.write = async (file, value) => {
        await write(file, value);
        if (file !== SESSION || stopped || !JSON.parse(value).active) return;
        stopped = true;
        const args = f.world.args; f.world.args = ['--stop']; await f.farmer.main(f.ns); f.world.args = args;
    };
    await f.farm();
    assert.equal(f.world.resets.length, 0);
    assert.equal(f.session().reason, 'Stopped manually');
    assert.deepEqual(f.world.spawns.map(launch => launch[0]), ['intelligence-farm.js', 'bootstrap.js']);
});

test('INT telemetry is measured every cycle without flooding the terminal on every reset', async () => {
    const f = fixture(); await f.install(); await f.enter(); await f.farm();
    await f.farmer.main(f.ns);
    assert.equal(f.world.logs.filter(line => line.startsWith('INT 109')).length, 1);
    assert.equal(f.session().metrics.gained, 45);
    f.clock.now += 10000; await f.farmer.main(f.ns);
    assert.equal(f.world.logs.filter(line => line.startsWith('INT 109')).length, 2);
    assert.equal(f.session().metrics.gained, 67.5);
});
