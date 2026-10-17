// Optional integration check against the user's installed game. No game/save
// mutation or Netscript execution: only its RAM calculator and cost table run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Clock, loadScript } = require('./helpers.cjs');
const { stripTypeScriptTypes } = require('node:module');
const mapPath = process.env.BITBURNER_SOURCE_MAP || 'C:/Program Files (x86)/Steam/steamapps/common/Bitburner/resources/app/dist/main.bundle.js.map';

test('graft entropy and focus assumptions match the installed game, including its actual Congruity name', {
    skip: !fs.existsSync(mapPath),
}, () => {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const source = map.sourcesContent.filter(Boolean).join('\n');
    const name = source.match(/CongruityImplant = "([^"]+)"/)[1];
    const effect = Number(source.match(/EntropyEffect: ([\d.]+)/)[1]);
    const focus = Number(source.match(/BaseFocusBonus: ([\d.]+)/)[1]);
    const policy = loadScript('lib/augmentation-grafting.js', new Clock());
    assert.equal(effect, .98); assert.equal(focus, .8);
    assert.equal(policy.graftMultipliers({}, [], 12, name).factor, effect ** -12);
    assert.equal(policy.graftMultipliers({}, [name], 0, 'Upgrade').factor, 1);
});

test('installed game RAM calculator: BN10 bootstrap fits 32 GB and sleeve tasks fit the first 64 GB home upgrade', {
    skip: !fs.existsSync(mapPath) || !stripTypeScriptTypes,
}, t => {
    const natives = process.binding('natives');
    const moduleFrom = key => {
        assert.ok(natives[key], 'Node parser fixture unavailable');
        const exports = {}; vm.runInNewContext(natives[key], { exports, module: { exports } }); return exports;
    };
    const acorn = moduleFrom('internal/deps/acorn/acorn/dist/acorn');
    const walk = moduleFrom('internal/deps/acorn/acorn-walk/dist/walk');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const source = suffix => {
        const index = map.sources.findIndex(s => s.endsWith('./src/' + suffix));
        assert.ok(index >= 0, 'Missing installed source: ' + suffix);
        return stripTypeScriptTypes(map.sourcesContent[index].replace(/^import[\s\S]*?;\r?\n/gm, ''), { mode: 'transform' }).replace(/\bexport /g, '');
    };
    const costs = new Function('Player', source('Netscript/RamCostGenerator.ts') + ';return {RamCosts,RamCostConstants};')({ bitNodeN: 10, activeSourceFileLvl: () => 3 });
    const root = path.join(__dirname, '..', 'src'), scripts = new Map();
    const add = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) add(file);
            else if (file.endsWith('.js')) {
                const filename = path.relative(root, file).replaceAll('\\', '/');
                scripts.set(filename, { filename, code: fs.readFileSync(file, 'utf8'), server: 'home' });
            }
        }
    };
    add(root);
    class ModuleResolutionError extends Error {}
    const env = { ...costs, walk, extendAcornWalkForTypeScriptNodes() {}, extendAcornWalkForJsxNodes() {},
        RamCalculationErrorCode: { ImportError: -1, SyntaxError: -2 }, roundToTwo: n => Math.round(n * 100) / 100,
        getFileType: () => 'js', getFileTypeFeature: () => ({ isTypeScript: false }), ModuleResolutionError,
        parseAST: (_file, _server, code) => acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest' }),
        getModuleScript: (name, from, other) => {
            const resolved = name.startsWith('.') ? path.posix.join(path.posix.dirname(from), name) : name.replace(/^\//, '');
            if (!other.has(resolved)) throw new ModuleResolutionError(resolved);
            return other.get(resolved);
        } };
    const calculate = new Function(...Object.keys(env), source('Script/RamCalculations.ts') + ';return calculateRamUsage;')(...Object.values(env));
    const ram = file => {
        const result = calculate(scripts.get(file).code, file, 'home', scripts);
        assert.equal(result.errorCode, undefined, file + ': ' + result.errorMessage);
        return Math.round(result.cost * 100) / 100;
    };
    const actual = Object.fromEntries(['bootstrap.js', 'supervisor.js', 'sleeve-manager.js', 'sleeve-upgrades.js', 'gang-manager.js',
        'augmentation-manager.js', 'progression-backdoor.js', 'progression-purchase.js', 'progression-join.js'].map(file => [file, ram(file)]));
    t.diagnostic(JSON.stringify(actual));
    assert.ok(actual['bootstrap.js'] <= 32); assert.ok(actual['supervisor.js'] <= 32);
    const actors = Math.max(...['progression-backdoor.js', 'progression-purchase.js', 'progression-join.js'].map(f => actual[f]));
    assert.ok(actual['supervisor.js'] + actual['sleeve-manager.js'] + actors <= 64, 'sleeves must fit with supervisor and helper reserve at 64 GB');
    assert.ok(actual['supervisor.js'] + actual['sleeve-manager.js'] + actual['gang-manager.js'] + actual['augmentation-manager.js'] + actors <= 256,
        'all progression services must fit 256 GB once core controllers are hosted remotely');
});
