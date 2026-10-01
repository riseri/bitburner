const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { policyFixture, Clock, Port, loadScript } = require('./go-policy-helpers.cjs');
const { referenceMove, mask, areaScore } = require('./go-test-helpers.cjs');
const POLICY_FILE = 'data/go-opponent-policy.json';
const opening = n => Array.from({ length: n }, (_, x) => Array.from({ length: n }, (_, y) =>
    (x === 0 && y === 0 || x === 1 && y === 1 || x === n - 1 && y === n - 1) ? '#' : '.').join(''));

function fixture(flags = {}) {
    const source = policyFixture(), clock = new Clock(source.clock.now), files = new Map(), ports = new Map(), logs = [], terminal = [], calls = [], writes = [];
    for (const port of [11, 12, 17]) ports.set(port, new Port());
    const world = { board: opening(5), opponent: 'Netburners', currentPlayer: 'Black', previousMove: null,
        history: [], passes: 0, stats: {}, reset: source.reset };
    const f = { world, files, ports, logs, terminal, calls, writes, clock, objective: source.objective,
        jit: source.jit, onAction: null, onSleep: null, onWrite: null };
    function publish() {
        const progression = { ...f.objective, type: 'progression-objective', version: 1,
            generatedAt: clock.now, producer: 'augmentation-manager.js', producerPid: 7, resetEpoch: '4:100:200' };
        ports.get(11).clear(); ports.get(11).write({ type: 'augmentation-status', version: 1,
            producerPid: 7, generatedAt: clock.now, resetEpoch: '4:100:200', progression });
        ports.get(17).clear(); ports.get(17).write({ ...f.jit, generatedAt: clock.now });
    }
    function play(color, x = null, y = null) {
        if (x === null) { world.passes++; world.previousMove = null; }
        else {
            const after = referenceMove(world.board, x, y, color, world.history);
            assert.ok(after, 'independent model rejects fixture action');
            world.history.unshift(world.board.join('')); world.board = after; world.passes = 0; world.previousMove = [x, y];
        }
        world.currentPlayer = world.passes >= 2 ? 'None' : color === 'X' ? 'White' : 'Black';
        if (world.currentPlayer === 'None') {
            const score = areaScore(world.board, 5.5), won = score.blackScore >= score.whiteScore;
            const s = world.stats[world.opponent] ||= { wins: 0, losses: 0, winStreak: 0, bonusPercent: 0, rep: 0 };
            if (won) { s.wins++; s.winStreak = s.winStreak < 0 ? 1 : s.winStreak + 1; }
            else { s.losses++; s.winStreak = s.winStreak > 0 ? -1 : s.winStreak - 1; }
            s.bonusPercent += .2;
            if (won && s.winStreak % 2 === 0) s.rep += 500;
        }
    }
    async function action(x = null, y = null) {
        assert.equal(world.currentPlayer, 'Black'); calls.push(x === null ? 'pass' : 'move');
        play('X', x, y); clock.now += 200;
        if (world.currentPlayer === 'None') return { type: 'gameOver', x: null, y: null };
        if (f.onAction) await f.onAction();
        play('O'); return { type: world.currentPlayer === 'None' ? 'gameOver' : 'pass', x: null, y: null };
    }
    const origin = clock.now;
    const ns = { pid: 42, getHostname: () => 'home', getScriptName: () => 'go-bot.js', disableLog() {},
        flags: defaults => ({ ...Object.fromEntries(defaults), opponent: 'auto', games: 1, ...flags }),
        ps: () => [{ pid: 42, filename: 'go-bot.js' }, { pid: 7, filename: 'augmentation-manager.js' }, { pid: 9, filename: 'daemon.js' }],
        getResetInfo: () => world.reset, getPlayer: () => ({ factions: ['Daedalus'], totalPlaytime: Math.floor((clock.now - origin) / 200) * 200 }),
        getPortHandle: port => { assert.ok(ports.has(port), `unexpected port ${port}`); return ports.get(port); },
        read: file => files.get(file) || '',
        write: async (file, value) => { files.set(file, value); writes.push(file); if (f.onWrite) await f.onWrite(file); },
        sleep: async ms => { clock.now += ms; if (f.onSleep) await f.onSleep(ms); },
        clearLog: () => { logs.length = 0; }, print: value => logs.push(String(value)), tprint: value => terminal.push(String(value)),
        go: { getBoardState: () => [...world.board], getOpponent: () => world.opponent,
            getMoveHistory: () => world.history.map(s => Array.from({ length: world.board.length }, (_, i) => s.slice(i * world.board.length, (i + 1) * world.board.length))),
            getGameState: () => ({ ...areaScore(world.board, 5.5), currentPlayer: world.currentPlayer, previousMove: world.previousMove, komi: 5.5 }),
            resetBoardState: (opponent, size) => {
                calls.push(['reset', opponent, size, world.currentPlayer]);
                world.board = opening(size); world.opponent = opponent; world.history = []; world.currentPlayer = 'Black'; world.previousMove = null; world.passes = 0;
            }, makeMove: action, passTurn: () => action(), opponentNextTurn: async () => {
                calls.push('wait'); clock.now += 200; play('O');
                return { type: world.currentPlayer === 'None' ? 'gameOver' : 'pass', x: null, y: null };
            }, analysis: { getValidMoves: () => mask(world.board, 'X', world.history),
                getStats: () => Object.fromEntries(Object.entries(world.stats).map(([name, s]) => [name, { ...s, bonusDescription: 'fixture bonus' }])) } } };
    const api = loadScript('go-bot.js', clock, { chooseGoMove: async (_board, _valid, opts) => ({
        x: opts.history.length ? null : 2, y: opts.history.length ? null : 2, reason: 'fixture choice',
        considered: 1, replies: 1, cpuMs: 0, projected: 0 }) });
    Object.assign(f, { ns, api, ownership: loadScript('lib/go-session.js', clock), play, publish, status: ports.get(12) }); publish();
    return f;
}

test('explicit Illuminati pins every new board despite cash/reputation objective changes', async () => {
    const f = fixture({ opponent: 'Illuminati', games: 2 });
    f.onAction = async () => { f.objective = { ...f.objective, limitingResource: 'reputation', reputationStrategy: 'WORK', remainingCash: 0 }; f.publish(); };
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []);
    assert.deepEqual(f.calls.filter(Array.isArray).map(c => c[1]), ['Illuminati', 'Illuminati']);
    assert.equal(f.status.peek().autoOpponent, false); assert.equal(f.status.peek().selectedOpponent, 'Illuminati');
    assert.equal(f.status.peek().selectionConfidence, 'PRIOR');
});

test('auto objective changes during a pending reply select only after verified completion', async () => {
    const f = fixture({ games: 2 }); let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    f.onAction = async () => {
        f.onAction = null;
        f.objective = { ...f.objective, limitingResource: 'reputation', reputationStrategy: 'WORK', remainingCash: 0,
            selectedPlan: { next: { repGap: 1e6, rate: 100, rateSource: 'measured', workActive: true } } };
        f.publish(); entered(); await new Promise(resolve => { release = resolve; });
    };
    const running = f.api.main(f.ns); await reached;
    assert.equal(f.world.currentPlayer, 'White'); assert.equal(f.world.opponent, 'The Black Hand');
    assert.equal(f.calls.filter(Array.isArray).length, 1); assert.equal(f.files.has(POLICY_FILE), false);
    assert.equal(f.status.peek().selectedOpponent, 'The Black Hand');
    release(); await running;
    assert.deepEqual(f.terminal, []);
    assert.deepEqual(f.calls.filter(Array.isArray).map(c => c[1]), ['The Black Hand', 'Daedalus']);
    assert.equal(f.calls.filter(Array.isArray)[1][3], 'None');
    assert.equal(f.status.peek().selectedOpponent, 'Daedalus');
});

test('takeover keeps the unfinished opponent and excludes its partial productivity observation', async () => {
    const f = fixture({ takeover: true }); f.play('X', 2, 2); f.play('O');
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.world.currentPlayer, 'None');
    assert.equal(f.world.opponent, 'Netburners'); assert.equal(f.calls.filter(Array.isArray).length, 0);
    assert.equal(f.files.has(POLICY_FILE), false); assert.match(f.status.peek().selectionReason, /existing board/);
});

test('resuming a verified owned game never resets it to optimize or invents the full start time', async () => {
    const f = fixture(); f.play('X', 2, 2); f.play('O');
    await f.ownership.saveGoRecord(f.ns, f.ownership.readGoSnapshot(f.ns), 'ready');
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.calls.filter(Array.isArray).length, 0); assert.equal(f.files.has(POLICY_FILE), false);
});

test('white-turn takeover awaits the opponent and records no partial game', async () => {
    const f = fixture({ takeover: true }); f.play('X', 2, 2);
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.calls[0], 'wait');
    assert.equal(f.calls.filter(Array.isArray).length, 0); assert.equal(f.files.has(POLICY_FILE), false);
});

test('auto refuses a manually touched game without takeover and creates no policy sample', async () => {
    const f = fixture(); f.play('X', 2, 2); f.play('O');
    await f.api.main(f.ns);
    assert.match(f.terminal[0], /Unowned/); assert.equal(f.calls.length, 0); assert.equal(f.files.has(POLICY_FILE), false);
});

for (const phase of ['thinking', 'reply', 'completion-write']) test(`manual interference during ${phase} creates no optimizer sample`, async () => {
    const f = fixture();
    if (phase === 'thinking') f.onSleep = async () => { f.world.reset.lastAugReset++; f.onSleep = null; };
    if (phase === 'reply') f.onAction = async () => { f.world.opponent = 'Daedalus'; };
    if (phase === 'completion-write') f.onWrite = async file => {
        if (file === 'go-bot-state.txt' && JSON.parse(f.files.get(file)).phase === 'complete') f.world.reset.lastAugReset++;
    };
    await f.api.main(f.ns);
    assert.equal(f.terminal.length, 1); assert.equal(f.files.has(POLICY_FILE), false);
    assert.equal(f.calls.filter(Array.isArray).length, 1);
});

test('a killed/throwing Go action and failed ownership persistence never produce optimizer samples', async () => {
    for (const mode of ['action', 'ownership']) {
        const f = fixture();
        if (mode === 'action') f.ns.go.makeMove = async () => { throw Error('NS instance killed'); };
        else f.onWrite = async file => { if (file === 'go-bot-state.txt') f.files.delete(file); };
        await f.api.main(f.ns);
        assert.equal(f.terminal.length, 1); assert.equal(f.files.has(POLICY_FILE), false);
    }
});

test('verified fresh game records bonus snapshots and writes policy only once per completion', async () => {
    const f = fixture({ games: 2 }); await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []);
    assert.equal(f.writes.filter(file => file === POLICY_FILE).length, 2);
    const t = JSON.parse(f.files.get(POLICY_FILE));
    const samples = Object.values(t.opponents).flatMap(sizes => Object.values(sizes).flatMap(b => b.samples));
    assert.equal(samples.length, 2);
    for (const s of samples) {
        assert.equal(s.durationMs, s.finishedAt - s.startedAt); assert.ok(s.durationMs >= 400);
        assert.ok(Math.abs(s.bonusDelta - .2) < 1e-9);
        assert.ok(Math.abs(s.bonusPerMinute - .2 * 60_000 / s.durationMs) < 1e-9);
        assert.equal(s.won, true); assert.equal(s.score, 22); assert.equal(s.margin, 16.5);
        assert.equal(s.after.wins - s.before.wins, 1); assert.equal(s.after.winStreak, s.before.winStreak + 1);
        assert.ok(s.epoch.startsWith('4:100:200:'));
    }
});

test('runtime Daedalus observation includes actual RNG waits in its duration and bonus pace', async () => {
    const fast = fixture({ opponent: 'Daedalus' }), slow = fixture({ opponent: 'Daedalus', 'rng-snipe': true });
    await fast.api.main(fast.ns); await slow.api.main(slow.ns);
    assert.deepEqual(fast.terminal, []); assert.deepEqual(slow.terminal, []);
    const sample = f => JSON.parse(f.files.get(POLICY_FILE)).opponents.Daedalus['5'].samples[0];
    const a = sample(fast), b = sample(slow);
    assert.ok(b.rngWaitMs > 0); assert.ok(b.durationMs >= a.durationMs + b.rngWaitMs);
    assert.ok(b.bonusPerMinute < a.bonusPerMinute);
});

test('corrupt optimizer telemetry and unavailable JIT do not stop fresh-player auto play', async () => {
    const f = fixture(); f.files.set(POLICY_FILE, '{corrupt'); f.ports.get(17).clear(); f.ports.get(11).clear();
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.world.opponent, 'Daedalus'); assert.equal(f.status.peek().selectionConfidence, 'PRIOR');
    assert.equal(JSON.parse(f.files.get(POLICY_FILE)).version, 1);
    assert.ok(!Object.keys(f.ns).some(v => ['singularity', 'formulas', 'getBitNodeMultipliers'].includes(v)));
});

test('corrupt ownership remains fatal even when corrupt analytics would recover and takeover is allowed', async () => {
    const f = fixture({ takeover: true }); f.files.set(POLICY_FILE, '{corrupt'); f.files.set('go-bot-state.txt', '{corrupt');
    await f.api.main(f.ns);
    assert.match(f.terminal[0], /Corrupt go-bot-state/); assert.equal(f.calls.length, 0);
    assert.equal(f.files.get(POLICY_FILE), '{corrupt');
});

test('an unavailable stats baseline never fabricates productivity when the API recovers', async () => {
    const f = fixture(), getStats = f.ns.go.analysis.getStats; let first = true;
    f.ns.go.analysis.getStats = () => { if (first) { first = false; throw Error('temporarily unavailable'); } return getStats(); };
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.world.currentPlayer, 'None'); assert.equal(f.files.has(POLICY_FILE), false);
});

test('policy write failure leaves a verified game complete and safely starts the next board', async () => {
    const f = fixture({ games: 2 });
    const write = f.ns.write; f.ns.write = async (file, value) => { if (file === POLICY_FILE) throw Error('analytics unavailable'); return write(file, value); };
    await f.api.main(f.ns);
    assert.deepEqual(f.terminal, []); assert.equal(f.world.currentPlayer, 'None');
    assert.equal(f.calls.filter(Array.isArray).length, 2); assert.match(f.logs.join(' '), /continuing with in-memory\s+evidence/);
});

test('a completed starting board is not learned twice and automatic rotation always stays ordinary', async () => {
    const f = fixture(); f.play('X', 2, 2); f.play('O'); f.play('X');
    await f.api.main(f.ns);
    const t = JSON.parse(f.files.get(POLICY_FILE));
    assert.equal(Object.values(t.opponents).flatMap(sizes => Object.values(sizes)).reduce((n, b) => n + b.games, 0), 1);
    assert.ok(f.calls.filter(Array.isArray).every(c => ['The Black Hand', 'Illuminati', 'Daedalus'].includes(c[1])));
});

test('status and detailed dashboards expose bounded scalar policy evidence without object noise', async () => {
    const f = fixture(); await f.api.main(f.ns); const go = f.status.peek();
    assert.ok(go.ranking.length <= 3); assert.equal(go.selectedOpponent, 'The Black Hand');
    assert.ok(Number.isFinite(go.bonusPerMinute)); assert.equal(go.objective.limitingResource, 'cash');
    const text = f.logs.join('\n'); assert.match(text, /OPPONENT POLICY/); assert.match(text, /hacking money/); assert.doesNotMatch(text, /\[object Object\]/);
    const supervisor = loadScript('supervisor.js', f.clock), logs = [], ns = { print: v => logs.push(String(v)) };
    supervisor.renderGoStatus(ns, go, { go: true, dashboardDetails: false }, []);
    assert.doesNotMatch(logs.join('\n'), /Policy|Confidence|Bonus pace/);
    logs.length = 0; supervisor.renderGoStatus(ns, go, { go: true, dashboardDetails: true }, []);
    assert.match(logs.join('\n'), /Policy\s+AUTO/); assert.match(logs.join('\n'), /Confidence\s+PRIOR/);
    assert.doesNotMatch(logs.join('\n'), /\[object Object\]/);
    const compact = fixture({ details: false }); await compact.api.main(compact.ns);
    assert.doesNotMatch(compact.logs.join('\n'), /OPPONENT POLICY|Progress value|Candidates/);
});

test('Go policy modules add no expensive progression APIs or board/scheduler mutations', () => {
    const files = ['lib/go-opponent-policy.js', 'lib/go-opponent-telemetry.js'];
    const text = files.map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')).join('\n');
    assert.doesNotMatch(text, /ns\.(singularity|formulas|go\.cheat|getBitNodeMultipliers|run|exec|kill|killall|scriptKill)\b/);
    assert.doesNotMatch(text, /resetBoardState|resetStats|setTestingBoardState/);
});
