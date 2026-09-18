const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.JIT_TEST_ROOT || path.join(__dirname, '..');
function load(file, globals = {}, cache = new Map()) {
    if (cache.has(file)) return cache.get(file);
    const imports = {};
    let source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    source = source.replace(/^import\s*\{([^}]+)\}\s*from\s*"([^"]+)";?\s*$/gm, (_, names, specifier) => {
        const module = load(specifier, globals, cache);
        for (const name of names.split(',').map(s => s.trim())) imports[name] = module[name];
        return '';
    });
    const exports = [...source.matchAll(/export (?:async )?(?:function\*?|const)\s+(\w+)/g)].map(m => m[1]);
    source = source.replace(/\bexport /g, '');
    const context = vm.createContext({console, structuredClone, ...imports, ...globals});
    const api = new vm.Script(`${source}\n;({${exports.join(',')}})`, {filename: file}).runInContext(context);
    cache.set(file, api);
    return api;
}
function rng(seed = 13579) {
    return n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
}
const plain = x => JSON.parse(JSON.stringify(x));
module.exports = {load, rng, plain, root};
