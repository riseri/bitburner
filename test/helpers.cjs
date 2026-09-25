const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.JIT_TEST_ROOT || path.join(__dirname, '..');

class Clock {
    constructor(now = 1_000_000) { this.now = now; this.heap = []; this.seq = 0; this.steps = 0; }
    timer(delay, callback) {
        const item = { at: this.now + Math.max(0, delay), callback, seq: this.seq++ };
        const heap = this.heap; heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.before(heap[p], item)) break;
            heap[i] = heap[p]; i = p;
        }
        heap[i] = item;
    }
    before(a, b) { return a.at < b.at || (a.at === b.at && a.seq <= b.seq); }
    pop() {
        const heap = this.heap, first = heap[0], last = heap.pop();
        if (!heap.length) return first;
        let i = 0;
        while (true) {
            let c = i * 2 + 1;
            if (c >= heap.length) break;
            if (c + 1 < heap.length && this.before(heap[c + 1], heap[c])) c++;
            if (this.before(last, heap[c])) break;
            heap[i] = heap[c]; i = c;
        }
        heap[i] = last;
        return first;
    }
    sleep(ms, active = () => true) {
        return new Promise(resolve => this.timer(ms, () => { if (active()) resolve(); }));
    }
    async runUntil(end, maxSteps = 2_000_000) {
        for (let i = 0; i < 512; i++) await Promise.resolve();
        while (this.heap.length && this.heap[0].at <= end) {
            const event = this.pop();
            this.now = Math.max(this.now, event.at);
            event.callback();
            this.steps++;
            if (this.steps > maxSteps) throw new Error('virtual clock step limit');
            // Complete all promise continuations before moving to the next timer.
            for (let i = 0; i < 8; i++) await Promise.resolve();
        }
        this.now = end;
        for (let i = 0; i < 512; i++) await Promise.resolve();
    }
}

class Port {
    constructor(limit = 1000) { this.items = []; this.limit = limit; }
    clear() { this.items.length = 0; }
    empty() { return this.items.length === 0; }
    peek() { return this.items[0] ?? 'NULL PORT DATA'; }
    read() { return this.items.shift() ?? 'NULL PORT DATA'; }
    tryWrite(value) { if (this.items.length >= this.limit) return false; this.items.push(value); return true; }
    write(value) { if (!this.tryWrite(value)) { this.items.shift(); this.items.push(value); } }
}

// Resolve the real named imports so tests cannot silently invent missing exports.
// Private functions remain exposed for the focused state-machine tests.
function loadScript(file, clock, extra = {}) {
    const modules = new Map();
    function load(filename) {
        if (modules.has(filename)) return modules.get(filename);
        const original = fs.readFileSync(path.join(root, 'src', filename), 'utf8');
        const imports = {};
        const source = original.replace(/^import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];[ \t]*\r?$/gm,
            (_statement, bindings, dependency) => {
                const loaded = load(dependency);
                for (const binding of bindings.split(',').map(s => s.trim()).filter(Boolean)) {
                    const [name, local = name] = binding.split(/\s+as\s+/);
                    if (!Object.hasOwn(loaded.exports, name)) throw new Error(filename + ': missing export ' + name + ' from ' + dependency);
                    imports[local] = loaded.exports[name];
                }
                return '';
            }).replace(/\bexport (?=(?:async )?function|const )/g, '');
        const names = [...source.matchAll(/^(?:async )?function\*? (\w+)\s*\(/gm)].map(m => m[1]);
        const exported = [...original.matchAll(/^export (?:(?:async )?function\*? |const )(\w+)/gm)].map(m => m[1]);
        const sandbox = {
            console, Date: class extends Date { static now() { return clock.now; } },
            setTimeout: (fn, ms) => clock.timer(ms, fn),
            ...imports, ...extra,
        };
        vm.createContext(sandbox);
        new vm.Script(source + '\n;globalThis.result={api:{' + [...new Set([...names, ...exported])].join(',') +
            '},exports:{' + exported.join(',') + '}};', { filename }).runInContext(sandbox);
        modules.set(filename, sandbox.result);
        return sandbox.result;
    }
    return load(file).api;
}

module.exports = { Clock, Port, loadScript, root };
