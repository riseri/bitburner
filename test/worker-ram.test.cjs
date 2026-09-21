const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'src/lib/jit-worker.js'), 'utf8');

function domIdentifiers(source) {
    // A narrow source regression guard, not a replacement for the game RAM analyzer.
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').match(/\b(?:document|window)\b/g) || [];
}
function load(source, clock) {
    const context = { Date: class extends Date { static now() { return clock.now; } } };
    vm.createContext(context);
    new vm.Script(source.replace(/\bexport (?=(?:async )?function)/g, '') + '\nthis.run = runJitWorker;').runInContext(context);
    return context.run;
}
async function scenario(options = {}, source = helper) {
    const clock = { now: 1000 };
    const events = [], calls = [];
    const target = options.target || 'the-hub';
    const phase = options.phase || 'H';
    const landAt = options.late ? 1050 : 1200;
    const epoch = options.stale ? 'old' : 'owner:0:1';
    const control = { type: 'jit-control', version: 2, targets: {
        'the-hub': { paused: !!options.paused, epoch: 'owner:0:1' },
        phantasy: { paused: true, epoch: 'other' },
    } };
    const ns = {
        args: [target, landAt, 'batch', 20, phase, 'chunk', 100, 15, 100, 1000, 0.5, 100, epoch],
        disableLog() {},
        getPortHandle(n) { return n === 15 ? { peek: () => control } : { tryWrite: e => { events.push(e); return true; } }; },
        getServerMinSecurityLevel: () => 12,
        getServerSecurityLevel: () => options.dirty ? 100 : 12,
        getServerMoneyAvailable: () => 4.96e9,
        sleep: async ms => { clock.now += ms; },
    };
    await load(source, clock)(ns, () => 100, async (name, actionOptions) => {
        calls.push({ name, actionOptions }); clock.now = landAt + 2; return 123;
    });
    return JSON.parse(JSON.stringify({ calls, events }));
}

test('worker source avoids DOM-reserved identifiers, including the imported helper', () => {
    for (const file of ['jit-hack.js', 'jit-grow.js', 'jit-weaken.js', 'lib/jit-worker.js']) {
        assert.deepEqual(domIdentifiers(fs.readFileSync(path.join(root, 'src', file), 'utf8')), [], file);
    }
    // Ensure this guard detects the exact pre-fix defect instead of passing vacuously.
    assert.ok(domIdentifiers(helper.replace(/controlSnapshot/g, 'document')).length > 0);
});

test('all three entry files carry the dependency revision to invalidate cached costs on sync', () => {
    for (const file of ['jit-hack.js', 'jit-grow.js', 'jit-weaken.js']) {
        assert.match(fs.readFileSync(path.join(root, 'src', file), 'utf8'), /dynamic-start-window-v2/);
    }
});

test('daemon source avoids DOM-reserved identifiers that add a 25 GB RAM penalty', () => {
    const daemon = fs.readFileSync(path.join(root, 'src', 'daemon.js'), 'utf8');
    assert.deepEqual(domIdentifiers(daemon), []);
    assert.ok(domIdentifiers(daemon.replace(/windowMs/g, 'window')).length > 0);
    assert.doesNotMatch(daemon, /ns\.cloud\./);
    assert.doesNotMatch(daemon, /ns\.scriptKill\s*\(/);
});

for (const [name, options] of [
    ['clean Hack invocation and completion', {}],
    ['own-target pause latch', { paused: true }],
    ['stale epoch rejection', { stale: true }],
    ['missed start deadline', { late: true }],
    ['dirty start rejection', { dirty: true }],
    ['W2 completion health reporting', { phase: 'W2' }],
]) {
    test(`renaming the control snapshot preserves ${name}`, async () => {
        const prior = helper.replace(/controlSnapshot/g, 'document');
        const before = await scenario(options, prior);
        const after = await scenario(options);
        assert.deepEqual(after, before);
        if (options.paused || options.stale || options.late || options.dirty) assert.equal(after.calls.length, 0);
        else {
            assert.equal(after.calls.length, 1);
            assert.equal(after.calls[0].actionOptions.additionalMsec, 100);
            assert.equal(after.events.at(-1).type, 'done');
        }
    });
}

test('RAM diagnostics use only read-only APIs and warn on home/host price mismatch', async () => {
    const source = fs.readFileSync(path.join(root, 'src/worker-ram-check.js'), 'utf8');
    const context = {}; vm.createContext(context);
    new vm.Script(source.replace('export async function main', 'async function main') + '\nthis.run = main;').runInContext(context);
    const lines = [];
    await context.run({
        args: ['cloud-04'], disableLog() {}, tprint: text => lines.push(text),
        getServer: () => ({ maxRam: 1024, ramUsed: 1000, hasAdminRights: true }),
        getScriptRam: (_file, host) => host === 'home' ? 2.2 : 27.2,
        format: { ram: n => `${n} GB` },
    });
    assert.ok(lines.some(line => line.includes('free 24 GB')));
    assert.equal(lines.filter(line => line.includes('RAM prices differ')).length, 3);
});
