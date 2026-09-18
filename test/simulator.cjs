const { Clock, Port, loadScript } = require('./helpers.cjs');

// A deterministic single-event-loop Netscript model. HGW duration is sampled at
// invocation; money/security effects are sampled/applied at completion. This is
// not the game engine and does not model RAM analysis, browser GC or offline time.
class NetscriptSimulation {
    constructor(options = {}) {
        this.options = options;
        this.clock = new Clock(); this.start = this.clock.now;
        this.nextPid = 10; this.processes = new Map(); this.ports = new Map();
        this.used = new Map(); this.errors = []; this.logs = []; this.paid = [];
        this.actions = []; this.misses = []; this.killed = []; this.launches = []; this.dropped = false;
        this.hosts = new Map([['home', { ram: 128, cores: 4 }]]);
        for (let i = 0; i < (options.hostCount ?? 25); i++) this.hosts.set(`cloud-${i}`, { ram: 2 ** 20, cores: 1 });
        this.target = options.target || 'the-hub';
        this.server = { money: options.money ?? 4.96e9, max: 4.96e9, sec: options.sec ?? 12, min: 12, required: 300 };
        this.baseLevel = 450;
        this.baseW = options.weakenTime ?? 354_000;
        this.seed = 42;
        this.workerHelper = loadScript('lib/jit-worker.js', this.clock);
        this.workers = new Map(['hack', 'grow', 'weaken'].map(name => [
            `jit-${name}.js`, loadScript(`jit-${name}.js`, this.clock, this.workerHelper).main,
        ]));
        this.daemon = loadScript('daemon.js', this.clock);
        this.controller = { pid: 1, script: 'daemon.js', host: 'home', active: true, threads: 1, ram: 55 };
        this.used.set('home', 55);
        this.getPort(20); this.getPort(15); this.getPort(19);
    }
    random() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 2 ** 32; }
    getPort(n) {
        if (!this.ports.has(n)) {
            const port = new Port();
            const write = port.tryWrite.bind(port);
            port.tryWrite = value => {
                const accepted = write(value);
                if (accepted && value?.type === 'miss') this.misses.push(value);
                return accepted;
            };
            this.ports.set(n, port);
        }
        return this.ports.get(n);
    }
    level() { return this.baseLevel + Math.floor((this.clock.now - this.start) / 60_000) * (this.options.levelPerMinute ?? 1); }
    bonus(host) { return 1 + (this.hosts.get(host).cores - 1) / 16; }
    perThread() {
        const factor = level => (level - this.server.required + 1) / level;
        return 0.0013 * factor(this.level()) / factor(this.baseLevel) * (100 - this.server.sec) / (100 - this.server.min);
    }
    duration(phase) {
        const { sec, min, required } = this.server;
        const securityScale = (2.5 * required * sec + 500) / (2.5 * required * min + 500);
        return this.baseW * ({ H: .25, G: .8, W: 1 }[phase]) * securityScale * (this.baseLevel + 50) / (this.level() + 50);
    }
    growthLog() {
        const log = sec => Math.min(Math.log1p(.03 / sec), .00349388925425578);
        return Math.log(2) / 546 * log(this.server.sec) / log(this.server.min);
    }
    stop(pid) {
        const p = this.processes.get(pid);
        if (!p || !p.active) return false;
        p.active = false; this.processes.delete(pid);
        this.used.set(p.host, (this.used.get(p.host) || 0) - p.ram);
        this.killed.push({ at: this.clock.now, phase: p.args[4], pid });
        return true;
    }
    finish(p) { if (p.active) { this.processes.delete(p.pid); p.active = false; this.used.set(p.host, (this.used.get(p.host) || 0) - p.ram); } }
    run() {
        this.daemon.main(this.ns(this.controller)).catch(error => this.errors.push(error));
    }
    ns(process) {
        const sim = this;
        const ns = {
            pid: process.pid, args: process.args || [],
            disableLog() {}, print: (...args) => sim.logs.push(args.join(' ')), tprint: (...args) => sim.logs.push(args.join(' ')),
            clearLog: () => { sim.logs = []; },
            flags: defaults => ({ ...Object.fromEntries(defaults), target: sim.target, cloud: false }),
            fileExists: () => true, getScriptRam: file => file.includes('hack') ? 2 : 2.2,
            getPortHandle: n => sim.getPort(n),
            getHackingLevel: () => sim.level(),
            getServerMaxMoney: h => h === sim.target ? sim.server.max : 0,
            getServerMoneyAvailable: h => h === sim.target ? sim.server.money : 1e15,
            getServerSecurityLevel: () => sim.server.sec,
            getServerMinSecurityLevel: () => sim.server.min,
            getServerRequiredHackingLevel: () => sim.server.required,
            hasRootAccess: () => true,
            getServerMaxRam: h => sim.hosts.get(h)?.ram || 0,
            getServerUsedRam: h => Math.max(0, sim.used.get(h) || 0),
            getServer: h => ({ cpuCores: sim.hosts.get(h)?.cores || 1 }),
            scan: h => h === 'home' ? [...sim.hosts.keys()].filter(n => n !== 'home').concat(sim.target) : ['home'],
            scp: async () => true,
            hackAnalyze: () => sim.perThread(), hackAnalyzeChance: () => .60,
            hackAnalyzeSecurity: threads => threads * .002,
            growthAnalyzeSecurity: threads => threads * .004,
            growthAnalyze: (_h, mult, cores = 1) => Math.log(mult) / sim.growthLog() / (1 + (cores - 1) / 16),
            weakenAnalyze: (threads, cores = 1) => threads * .05 * (1 + (cores - 1) / 16),
            getHackTime: () => sim.duration('H'), getGrowTime: () => sim.duration('G'), getWeakenTime: () => sim.duration('W'),
            sleep: ms => sim.clock.sleep(ms, () => process.active),
            run: () => 987654, // isolate the money engine from actual fleet/contract services
            isRunning: pid => sim.processes.has(pid),
            kill: pid => sim.stop(pid),
            scriptKill: (file, host) => { for (const p of sim.processes.values()) if (p.host === host && p.script === file) sim.stop(p.pid); },
            cloud: {
                getServerNames: () => [...sim.hosts.keys()].filter(n => n !== 'home'),
                getServerLimit: () => 25, getRamLimit: () => 2 ** 20,
                getServerCost: ram => ram * 55000, getServerUpgradeCost: () => 1e15,
            },
            brutessh() {}, ftpcrack() {}, relaysmtp() {}, httpworm() {}, sqlinject() {}, nuke() {},
        };
        ns.exec = (file, host, threads, ...args) => {
            const fn = sim.workers.get(file);
            if (!fn) throw new Error(`Unknown worker: ${file}`);
            const ram = ns.getScriptRam(file) * threads;
            if (ram + ns.getServerUsedRam(host) > ns.getServerMaxRam(host) + 1e-6) return 0;
            const p = { pid: sim.nextPid++, script: file, host, threads, ram, args, active: true };
            sim.processes.set(p.pid, p); sim.used.set(host, (sim.used.get(host) || 0) + ram);
            let startDelay = 1 + sim.random() * 3;
            if (sim.options.delayOneW2 && !sim.dropped && args[4] === 'W2' && sim.clock.now - sim.start > 500_000) {
                sim.dropped = true;
                sim.delayedChunk = args[5];
                startDelay = Math.max(1000, args[1] - sim.clock.now - sim.duration('W') + 5000);
            }
            sim.launches.push({ at: sim.clock.now, phase: args[4], landAt: args[1] });
            sim.clock.timer(startDelay, () => {
                if (!p.active) return;
                fn(sim.ns(p)).then(() => sim.finish(p), error => { sim.errors.push(error); sim.finish(p); });
            });
            return p.pid;
        };
        for (const [name, phase] of [['hack', 'H'], ['grow', 'G'], ['weaken', 'W']]) {
            ns[name] = (_target, opts = {}) => {
                const duration = sim.duration(phase) + (opts.additionalMsec || 0);
                const threads = opts.threads ?? process.threads;
                if (!(threads > 0) || threads > process.threads || opts.additionalMsec < 0) throw new Error('Invalid HGW options');
                sim.actions.push({ phase: process.args[4], at: sim.clock.now, finish: sim.clock.now + duration, startSec: sim.server.sec });
                return new Promise(resolve => sim.clock.timer(duration, () => {
                    if (!process.active) return;
                    const s = sim.server;
                    let result = 0;
                    if (phase === 'H' && sim.random() < .60) {
                        result = s.money * Math.min(1, sim.perThread() * threads);
                        s.money -= result; s.sec = Math.min(100, s.sec + .002 * threads);
                        if (result > 0) sim.paid.push({ at: sim.clock.now, money: result });
                    } else if (phase === 'G') {
                        const before = s.money;
                        s.money = Math.min(s.max, (s.money + threads) * Math.exp(sim.growthLog() * threads * sim.bonus(process.host)));
                        // Conservatively charge full grow fortification, even at the money cap.
                        s.sec = Math.min(100, s.sec + .004 * threads);
                        result = s.money / Math.max(1, before);
                    } else if (phase === 'W') {
                        result = Math.min(s.sec - s.min, threads * .05 * sim.bonus(process.host));
                        s.sec = Math.max(s.min, s.sec - result);
                    }
                    resolve(result);
                }));
            };
        }
        return ns;
    }
    summary() {
        const last = this.clock.now - 60_000;
        return { actions: this.actions.length, paid: this.paid.length,
            income60: this.paid.filter(p => p.at >= last).reduce((s, p) => s + p.money, 0) / 60,
            money: this.server.money, security: this.server.sec, errors: this.errors.map(String),
            logs: this.logs, steps: this.clock.steps, processes: this.processes.size };
    }
}
module.exports = { NetscriptSimulation };
