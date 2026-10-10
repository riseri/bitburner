const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture(node = 4, sourceFiles = [[5, 1]]) {
    const clock = new Clock(), files = new Map([['data/supervisor-bootstrap.json', JSON.stringify({ version: 2, args: [] })]]);
    const reset = { currentNode: node, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map(sourceFiles) };
    const world = { exp: 100, int: 1, member: false, invited: true, busy: false, pending: [], installed: [], processes: [],
        factions: [], invitations: [], flags: { start: true, minutes: 10, target: 3 },
        resets: [], spawns: [], joins: 0, joinedFactions: [], logs: [] };
    const ns = { pid: 10, getHostname: () => 'home', getResetInfo: () => reset,
        flags: defaults => ({ ...Object.fromEntries(defaults), ...world.flags }),
        getPlayer: () => ({ exp: { intelligence: world.exp }, skills: { intelligence: world.int },
            factions: [...world.factions, ...(world.member ? ['Shadows of Anarchy'] : [])] }),
        read: f => files.get(f) || '', write: async (f, v) => files.set(f, v), ps: () => world.processes,
        fileExists: () => true, getScriptRam: () => 32, getServerMaxRam: () => 64,
        spawn: (...args) => world.spawns.push(args), tprint: v => world.logs.push(v),
        singularity: { isBusy: () => world.busy, getOwnedAugmentations: pending => pending ? [...world.installed, ...world.pending] : world.installed,
            checkFactionInvitations: () => [...world.invitations, ...(world.invited ? ['Shadows of Anarchy'] : [])],
            joinFaction: faction => {
                world.joins++; world.joinedFactions.push(faction);
                if (faction === 'Shadows of Anarchy') world.member = true;
                else { world.factions.push(faction); world.invitations = world.invitations.filter(name => name !== faction); }
                world.exp += 7.5; world.int++; return true;
            },
            softReset: script => { world.resets.push(script); } } };
    const api = loadScript('intelligence-farm.js', clock);
    function callback() {
        clock.now += 500; reset.lastAugReset = clock.now; world.member = false; world.flags = {};
        world.invitations = [...new Set([...world.invitations, ...world.factions])]; world.factions = [];
    }
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
    for (const reason of ['singularity', 'sf5', 'invitation', 'busy', 'queued', 'red-pill', 'supervisor', 'settings', 'script', 'ram', 'no-xp']) {
        const f = fixture();
        if (reason === 'singularity') { f.reset.currentNode = 5; f.ns.singularity = new Proxy({}, { get() { throw new Error('Locked Singularity API touched'); } }); }
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
    for (const flags of [{ minutes: 0 }, { minutes: Infinity }, { minutes: 61 }, { target: -1 }, { target: Infinity }]) {
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

test('BN5 SF4.3/SF5.1 runs above INT 109 with no default level cap and rejoins every persistent faction', async () => {
    const f = fixture(5, [[1, 3], [4, 3], [5, 1]]);
    f.world.int = 109;
    f.world.flags = { start: true, minutes: 10 };
    f.world.invitations = ['ECorp', 'MegaCorp', 'CyberSec', 'Daedalus', 'Volhaven', 'ECorp'];
    await f.api.main(f.ns);
    assert.equal(f.session().target, 0);
    assert.deepEqual(f.world.joinedFactions, ['Shadows of Anarchy', 'ECorp', 'MegaCorp']);
    assert.equal(f.session().joins, 3);
    assert.equal(f.session().metrics.gained, 22.5);
    assert.equal(f.world.spawns.length, 0);
    const deadline = f.session().deadline;
    f.callback(); await f.api.main(f.ns);
    assert.equal(f.session().deadline, deadline);
    assert.equal(f.session().joins, 6);
    assert.equal(f.session().metrics.gained, 45);
    assert.equal(f.session().metrics.xpPerHour, 324000);
    assert.equal(f.world.resets.length, 2);
    assert.deepEqual(f.session().factions, ['Shadows of Anarchy', 'ECorp', 'MegaCorp']);
    f.callback(); f.clock.now = deadline; await f.api.main(f.ns);
    assert.equal(f.session().reason, 'Time budget reached');
    assert.equal(f.world.joins, 6);
    assert.equal(f.session().resets, 2);
    assert.equal(f.world.spawns[0][0], 'bootstrap.js');
});

test('INT farming follows capabilities across every BitNode, including future node numbers', async () => {
    for (const node of [...Array.from({ length: 15 }, (_, index) => index + 1), 99]) {
        const f = fixture(node, [[4, 3], [5, 1]]);
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 1, `BN${node}`);
        f.callback(); await f.api.main(f.ns);
        assert.equal(f.session().reason, 'Target reached', `BN${node}`);
        assert.equal(f.world.spawns[0][0], 'bootstrap.js', `BN${node}`);
    }
});

test('BN5 itself unlocks INT when SF4 is owned; other nodes need both capabilities', async () => {
    const f = fixture(5, [[4, 3]]); await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1);
    for (const sourceFiles of [[], [[4, 3]], [[5, 1]]]) {
        const blocked = fixture(12, sourceFiles);
        blocked.ns.singularity = new Proxy({}, { get() { throw new Error('Capability gate failed'); } });
        await blocked.api.main(blocked.ns);
        assert.equal(blocked.world.resets.length, 0);
        assert.match(blocked.world.logs[0], /Singularity access|Intelligence unlocked/);
    }
});

test('corporate membership or invitations work without Shadows of Anarchy', async () => {
    for (const alreadyJoined of [false, true]) {
        const f = fixture(8, [[4, 1], [5, 1]]);
        f.world.invited = false; f.world.flags.target = 100;
        f.world[alreadyJoined ? 'factions' : 'invitations'] = ['ECorp', 'Fulcrum Secret Technologies'];
        await f.api.main(f.ns);
        assert.equal(f.world.joins, alreadyJoined ? 0 : 2);
        assert.equal(f.world.resets.length, 1);
        f.callback(); await f.api.main(f.ns);
        assert.deepEqual(f.world.joinedFactions.slice(-2), ['ECorp', 'Fulcrum Secret Technologies']);
        assert.equal(f.world.resets.length, 2);
    }
});

test('all eleven eligible factions can be rejoined in a single reset cycle', async () => {
    const f = fixture(12, [[4, 3], [5, 1]]);
    f.world.flags.target = 100;
    f.world.invitations = ['ECorp', 'MegaCorp', 'Bachman & Associates', 'Blade Industries', 'NWO',
        'Clarke Incorporated', 'OmniTek Incorporated', 'Four Sigma', 'KuaiGong International', 'Fulcrum Secret Technologies'];
    await f.api.main(f.ns);
    assert.equal(f.world.joins, 11);
    assert.equal(f.session().metrics.gained, 82.5);
    assert.equal(f.world.resets.length, 1);
    f.callback(); await f.api.main(f.ns);
    assert.equal(f.world.joins, 22);
    assert.equal(f.session().metrics.gained, 165);
    assert.equal(f.world.resets.length, 2);
});

test('explicit INT target stops between faction joins without an extra reset', async () => {
    const f = fixture(5, [[4, 3], [5, 1]]);
    f.world.int = 109; f.world.flags.target = 110;
    f.world.invitations = ['ECorp', 'MegaCorp'];
    await f.api.main(f.ns);
    assert.deepEqual(f.world.joinedFactions, ['Shadows of Anarchy']);
    assert.equal(f.world.resets.length, 0);
    assert.equal(f.session().reason, 'Target reached');
    assert.equal(f.session().metrics.gained, 7.5);
    assert.equal(f.world.spawns[0][0], 'bootstrap.js');
});

test('deadline reached during a faction group prevents remaining joins and resets', async () => {
    const f = fixture(); f.world.flags.target = 100; f.world.invitations = ['ECorp'];
    const join = f.ns.singularity.joinFaction;
    f.ns.singularity.joinFaction = faction => { const joined = join(faction); f.clock.now += 600000; return joined; };
    await f.api.main(f.ns);
    assert.equal(f.world.joins, 1);
    assert.equal(f.world.resets.length, 0);
    assert.equal(f.session().reason, 'Time budget reached');
});

test('failed or unrewarded joins stop the whole group before a reset', async () => {
    for (const failWith of [false, 'throw', 'no-xp']) {
        const f = fixture(); f.world.flags.target = 100; f.world.invitations = ['ECorp'];
        const join = f.ns.singularity.joinFaction;
        f.ns.singularity.joinFaction = faction => {
            if (faction !== 'ECorp') return join(faction);
            if (failWith === 'throw') throw new Error('Singularity unavailable');
            return failWith === 'no-xp';
        };
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 0);
        assert.equal(f.session().active, false);
        assert.match(f.session().reason, /failed|No measured INT XP/);
    }
});

test('lost invitations and autojoined-only factions cannot create empty reset loops', async () => {
    for (const factions of [[], ['Shadows of Anarchy']]) {
        const f = fixture(); f.world.flags.target = 100;
        await f.api.main(f.ns); f.callback();
        f.world.invited = false; f.world.factions = factions;
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 1);
        assert.equal(f.session().active, false);
        assert.match(f.session().reason, /No persistent faction|No productive faction joins/);
    }
    const f = fixture(); f.world.invited = false;
    f.world.invitations = ['CyberSec', 'Church of the Machine God', 'Daedalus'];
    await f.api.main(f.ns);
    assert.equal(f.world.joins, 0); assert.equal(f.world.resets.length, 0);
});

test('legacy level-50 sessions still resume without renewing their target or deadline', async () => {
    const f = fixture(); f.world.flags.target = 50;
    await f.api.main(f.ns);
    const session = f.session(); session.version = 1; delete session.joins; delete session.factions;
    f.files.set('data/intelligence-session.json', JSON.stringify(session));
    f.callback(); await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 2);
    assert.equal(f.session().target, 50);
    assert.equal(f.session().deadline, session.deadline);
});

test('a running budget cannot be renewed, and manual stop survives a pending session write', async () => {
    const f = fixture(); f.world.flags.target = 100;
    await f.api.main(f.ns); const deadline = f.session().deadline;
    await assert.rejects(f.api.main(f.ns), /session is active/);
    assert.equal(f.session().deadline, deadline);
    f.callback();
    const write = f.ns.write; let stopping = false;
    f.ns.write = async (file, value) => {
        await write(file, value);
        if (!stopping && JSON.parse(value).active) {
            stopping = true; f.world.flags = { stop: true }; await f.api.main(f.ns);
        }
    };
    await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1);
    assert.equal(f.session().active, false);
    assert.equal(f.session().reason, 'Stopped manually');
});

test('a manual stop or expired budget at the final checkpoint prevents softReset', async () => {
    for (const action of ['stop', 'deadline']) {
        const f = fixture(); f.world.flags.target = 100;
        const write = f.ns.write; let writes = 0;
        f.ns.write = async (file, value) => {
            await write(file, value);
            if (++writes !== 2) return;
            if (action === 'deadline') f.clock.now = JSON.parse(value).deadline;
            else { f.world.flags = { stop: true }; await f.api.main(f.ns); }
        };
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 0, action);
        assert.equal(f.session().active, false, action);
        assert.equal(f.session().reason, action === 'stop' ? 'Stopped manually' : 'Time budget reached');
        assert.equal(f.world.spawns.length, action === 'stop' ? 0 : 1);
    }
});

test('stale BN5 callbacks cannot continue a session in a later BitNode', async () => {
    const f = fixture(5, [[4, 3], [5, 1]]);
    f.world.flags = { start: true }; await f.api.main(f.ns);
    f.callback(); f.reset.currentNode = 12; f.reset.lastNodeReset++;
    await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 1);
    assert.equal(f.world.spawns.length, 0);
    assert.equal(loadScript('lib/intelligence-session.js', f.clock).readIntelligenceSession(f.ns), null);
});

test('normal completion preserves the supervisor service choices through bootstrap', async () => {
    const f = fixture(5, [[4, 3], [5, 1]]);
    const args = ['--go', false, '--darknet', false, '--min-install', 4, '--max-batch-rate', 2];
    f.files.set('data/supervisor-bootstrap.json', JSON.stringify({ version: 2, args }));
    f.world.flags.target = 2;
    await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 0);
    assert.equal(f.session().reason, 'Target reached');
    await loadScript('bootstrap.js', f.clock).main(f.ns);
    assert.equal(f.world.spawns[1][0], 'supervisor.js');
    assert.deepEqual(f.world.spawns[1].slice(2), args);
});

test('reset callback RAM, restart RAM and reset epoch are checked before destructive work', async () => {
    for (const file of ['intelligence-farm.js', 'bootstrap.js', 'supervisor.js']) {
        const f = fixture(); f.ns.getScriptRam = name => name === file ? 128 : 32;
        await f.api.main(f.ns);
        assert.equal(f.world.resets.length, 0, file); assert.equal(f.world.joins, 0, file);
    }
    const f = fixture(); f.world.flags.target = 100;
    const write = f.ns.write;
    f.ns.write = async (file, value) => { await write(file, value); f.reset.lastNodeReset++; };
    await f.api.main(f.ns);
    assert.equal(f.world.resets.length, 0);
});

test('new session validation supports time-only budgets and rejects invalid faction or join records', async () => {
    const f = fixture(); f.world.flags = { start: true };
    await f.api.main(f.ns);
    const reader = loadScript('lib/intelligence-session.js', f.clock), valid = f.session();
    assert.equal(reader.readIntelligenceSession(f.ns).target, 0);
    for (const changes of [{ joins: -1 }, { joins: 0.5 }, { factions: ['CyberSec'] },
        { factions: ['ECorp', 'ECorp'] }, { deadline: valid.startedAt + 3600001 }]) {
        f.files.set('data/intelligence-session.json', JSON.stringify({ ...valid, ...changes }));
        assert.equal(reader.readIntelligenceSession(f.ns), null);
    }
});
