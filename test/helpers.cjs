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

function loadScript(file, clock, extra = {}) {
    if (['progression-manager.js', 'augmentation-manager.js'].includes(file)) extra = { ...loadScript('lib/augmentation-loop.js', clock), ...extra };
    if (file === 'augmentation-manager.js') extra = { ...loadScript('lib/augmentation-plan.js', clock), ...extra };
    if (file === 'lib/supervised-utilities.js') extra = { ...loadScript('lib/savings.js', clock), ...loadScript('lib/progression-protocol.js', clock), ...extra };
    if (file === 'lib/utility-report.js') extra = { ...loadScript('lib/progression-protocol.js', clock), ...extra };
    if (['doctor.js', 'augmentation-planner.js'].includes(file)) extra = { ...loadScript('lib/utility-report.js', clock), ...extra };
    if (file === 'supervisor.js') extra = { ...loadScript('lib/supervised-utilities.js', clock), ...extra };
    if (['supervisor.js', 'fleet-manager.js', 'stock-trader.js', 'progression-purchase.js', 'lib/progression-dispatch.js', 'savings.js', 'doctor.js', 'augmentation-planner.js', 'augmentation-manager.js'].includes(file)) {
        extra = { ...loadScript('lib/savings.js', clock), ...extra };
    }
    if (file === 'fleet-manager.js') extra = { ...loadScript('lib/fleet-economics.js', clock), ...extra };
    if (['supervisor.js', 'telemetry.js'].includes(file)) extra = { ...loadScript('lib/telemetry.js', clock), ...extra };
    if (file === 'augmentation-planner.js') extra = { ...loadScript('lib/augmentation-plan.js', clock), ...extra };
    if (['daemon.js', 'supervisor.js', 'contract-manager.js', 'stock-trader.js'].includes(file)) {
        extra = { ...loadScript('lib/dashboard.js', clock), ...extra };
    }
    if (['daemon.js', 'lib/target-pipelines.js'].includes(file) && fs.existsSync(path.join(root, 'src/lib/background-prep.js'))) {
        extra = { ...loadScript('lib/background-prep.js', clock), ...extra };
    }
    if (['supervisor.js', 'progression-manager.js', 'progression-purchase.js', 'augmentation-manager.js',
        'progression-backdoor.js', 'lib/progression-dispatch.js'].includes(file)) {
        extra = { ...loadScript('lib/progression-protocol.js', clock), ...extra };
    }
    if (file === 'supervisor.js') {
        extra = { ...loadScript('lib/service-lifecycle.js', clock), ...loadScript('lib/progression-dispatch.js', clock), ...extra };
    }
    if (file === 'daemon.js') extra = { ...loadScript('lib/target-pipelines.js', clock), ...extra };
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8')
        .replace(/^import\s[\s\S]*?;[ \t]*\r?$/gm, '')
        .replace(/\bexport (?=(?:async )?function|const )/g, '');
    const names = [...source.matchAll(/^(?:async )?function\*? (\w+)\s*\(/gm)].map(m => m[1]);
    const sandbox = {
        console, Date: class extends Date { static now() { return clock.now; } },
        setTimeout: (fn, ms) => clock.timer(ms, fn),
        PORTS: { WORKER_EVENTS: 20, FLEET_STATUS: 19, CONTRACT_STATUS: 18, JIT_STATUS: 17, PROGRESSION_STATUS: 16, JIT_CONTROL: 15, PROGRESSION_ACTION: 14, STOCK_STATUS: 13, GO_STATUS: 12, AUGMENTATION_STATUS: 11 },
        ...extra,
    };
    vm.createContext(sandbox);
    new vm.Script(`${source}\n;globalThis.api={${names.join(',')}};`, { filename: file }).runInContext(sandbox);
    return sandbox.api;
}

module.exports = { Clock, Port, loadScript, root };
