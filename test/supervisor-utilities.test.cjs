const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture() {
    const clock = new Clock(), files = new Map(), processes = new Map(), launched = [], logs = [];
    const reset = { currentNode: 4, lastNodeReset: 1, lastAugReset: 2, ownedSF: new Map() };
    let pid = 10, free = 10000;
    const ns = { pid: 1, flags: pairs => Object.fromEntries(pairs), getHostname: () => 'home', disableLog() {},
        ps: () => [...processes.values()], getResetInfo: () => reset, read: f => files.get(f) || '',
        write: async (f, value) => files.set(f, value), fileExists: () => true,
        getScriptRam: () => 10, getServerMaxRam: () => free, getServerUsedRam: () => 0,
        isRunning: id => processes.has(id), getPortHandle: () => new Port(), getServerMoneyAvailable: () => 1e6,
        run: (filename, threads, ...args) => { const process = { pid: ++pid, filename, threads, args }; processes.set(pid, process); launched.push(process); return pid; },
        print: text => logs.push(text), tprint: text => logs.push(text), clearLog() {},
        kill: () => assert.fail('must not kill anything'), hasTorRouter: () => false };
    return { clock, files, processes, launched, logs, reset, ns, ram: value => { free = value; },
        api: loadScript('lib/supervised-utilities.js', clock) };
}

function publish(f, job, overrides = {}) {
    f.files.set(job.reportFile, JSON.stringify({ version: 1, type: job.type, producerPid: job.pid,
        generatedAt: f.clock.now, resetEpoch: '4:1:2', state: 'READY', summary: 'Ready', ...overrides }));
}

test('one-shot diagnostics completes once; planner runs periodically with no duplicates', () => {
    const f = fixture(), job = f.api.createUtilityJob('doctor.js', 'diag', 'diagnostics', [], 0);
    f.api.tickUtilityJob(f.ns, job);
    f.api.tickUtilityJob(f.ns, job);
    assert.equal(f.launched.length, 1);
    publish(f, job); f.processes.clear(); f.api.tickUtilityJob(f.ns, job);
    assert.equal(job.state, 'READY');
    f.clock.now += 600000; f.api.tickUtilityJob(f.ns, job);
    assert.equal(f.launched.length, 1);
    f.api.tickUtilityJob(f.ns, job, 'Waiting for another helper');
    assert.equal(job.state, 'READY');
    const planner = f.api.createUtilityJob('augmentation-planner.js', 'aug', 'augmentation-plan');
    f.api.tickUtilityJob(f.ns, planner); publish(f, planner); f.processes.clear(); f.api.tickUtilityJob(f.ns, planner);
    f.clock.now += 59999; f.api.tickUtilityJob(f.ns, planner); assert.equal(f.launched.length, 2);
    f.clock.now++; f.api.tickUtilityJob(f.ns, planner); assert.equal(f.launched.length, 3);
});

test('utilities wait for RAM or capabilities without killing workers or launching duplicates', () => {
    const f = fixture(), job = f.api.createUtilityJob('augmentation-planner.js', 'aug', 'augmentation-plan');
    f.api.tickUtilityJob(f.ns, job, 'Singularity is locked'); assert.equal(job.state, 'BLOCKED');
    f.ram(1); f.api.tickUtilityJob(f.ns, job); assert.equal(job.state, 'WAITING_RAM');
    assert.equal(f.launched.length, 0);
    f.ram(10000); f.clock.now += 15000; f.api.tickUtilityJob(f.ns, job);
    f.processes.set(99, { pid: 99, filename: job.script, args: [] });
    f.api.tickUtilityJob(f.ns, job); assert.equal(job.state, 'CONFLICT');
    assert.equal(f.launched.length, 1);
});

test('utility report authentication rejects old PID, old timestamps and wrong reset; failures back off', () => {
    for (const overrides of [{ producerPid: 999 }, { generatedAt: 1 }, { resetEpoch: 'old' }]) {
        const f = fixture(), job = f.api.createUtilityJob('doctor.js', 'diag', 'diagnostics', [], 0);
        f.api.tickUtilityJob(f.ns, job); publish(f, job, overrides); f.processes.clear();
        f.api.tickUtilityJob(f.ns, job); assert.equal(job.state, 'ERROR');
        f.api.tickUtilityJob(f.ns, job); assert.equal(f.launched.length, 1);
        f.clock.now += 15000; f.api.tickUtilityJob(f.ns, job); assert.equal(f.launched.length, 2);
    }
});

test('fresh augmentation advice expires and never crosses reset boundaries', () => {
    const f = fixture(), job = f.api.createUtilityJob('augmentation-planner.js', 'aug', 'augmentation-plan');
    job.report = { type: 'augmentation-plan', state: 'READY', generatedAt: f.clock.now, resetEpoch: '4:1:2', plan: { next: { name: 'BitWire' } } };
    assert.equal(f.api.currentAugmentationPlan(f.ns, job).next.name, 'BitWire');
    f.clock.now += 120001; assert.equal(f.api.currentAugmentationPlan(f.ns, job), null);
    job.report.generatedAt = f.clock.now; f.reset.lastAugReset++; assert.equal(f.api.currentAugmentationPlan(f.ns, job), null);
});

test('automatic savings advances through programs, respects the configured reserve, and preserves manual goals', async () => {
    const f = fixture(), owned = new Set(); let tor = false;
    f.ns.fileExists = name => owned.has(name); f.ns.hasTorRouter = () => tor;
    const cfg = { savingsMode: 'auto', progression: true, progressionActions: true, progressionCashReserve: 0.2 };
    await f.api.updateSupervisorSavings(f.ns, cfg, null);
    let goal = JSON.parse(f.files.get('data/savings.json'));
    assert.equal(goal.target, 'TOR'); assert.equal(goal.amount, 250000);
    tor = true; await f.api.updateSupervisorSavings(f.ns, cfg, null);
    goal = JSON.parse(f.files.get('data/savings.json')); assert.equal(goal.target, 'BruteSSH.exe');
    owned.add('BruteSSH.exe'); await f.api.updateSupervisorSavings(f.ns, cfg, null);
    goal = JSON.parse(f.files.get('data/savings.json')); assert.equal(goal.target, 'FTPCrack.exe');
    const savings = loadScript('lib/savings.js', f.clock);
    await savings.writeSavings(f.ns, 1e9, 'My fund');
    await f.api.updateSupervisorSavings(f.ns, cfg, null);
    assert.equal(JSON.parse(f.files.get('data/savings.json')).label, 'My fund');
});

test('automatic savings never reserves for inaccessible or disabled progression; augmentation goals follow complete plans', async () => {
    const f = fixture(), cfg = { savingsMode: 'auto', progression: true, progressionActions: false, progressionCashReserve: 0.1 };
    await f.api.updateSupervisorSavings(f.ns, cfg, null); assert.equal(f.files.size, 0);
    cfg.progressionActions = true; f.reset.currentNode = 1;
    await f.api.updateSupervisorSavings(f.ns, cfg, null); assert.equal(f.files.size, 0);
    f.reset.currentNode = 4; cfg.savingsMode = 'augmentations';
    await f.api.updateSupervisorSavings(f.ns, cfg, null); assert.equal(f.files.size, 0);
    await f.api.updateSupervisorSavings(f.ns, cfg, { errors: [], next: { name: 'BitWire', price: 10 } });
    assert.equal(JSON.parse(f.files.get('data/savings.json')).amount, 10);
    await f.api.updateSupervisorSavings(f.ns, cfg, { errors: [], next: null });
    assert.equal(JSON.parse(f.files.get('data/savings.json')).amount, 0);
});

test('automatic savings moves from completed programs into the enabled augmentation loop', async () => {
    const f=fixture();
    f.ns.hasTorRouter=()=>true; f.ns.fileExists=name=>name.endsWith('.exe');
    const cfg={savingsMode:'auto',progression:true,progressionActions:true,progressionCashReserve:.1,
        augmentationActions:true,augmentationCashReserve:.2};
    await f.api.updateSupervisorSavings(f.ns,cfg,{errors:[],next:{name:'BitWire',price:800}});
    const goal=JSON.parse(f.files.get('data/savings.json'));
    assert.equal(goal.target,'augmentation:BitWire'); assert.equal(goal.amount,1000);
});

test('one supervisor command starts diagnostics, services, automatic savings, and then the planner', async () => {
    const f = fixture(), supervisor = loadScript('supervisor.js', f.clock);
    const ports = new Map();
    f.ns.getPortHandle = n => { if (!ports.has(n)) ports.set(n, new Port()); return ports.get(n); };
    f.ns.flags = pairs => ({ ...Object.fromEntries(pairs), 'progression-actions': true, 'cloud-payback': 900 });
    let loops = 0;
    f.ns.sleep = async () => {
        if (++loops === 2) throw new Error('end fixture');
        const doctor = f.launched.find(p => p.filename === 'doctor.js');
        assert.ok(doctor);
        f.files.set('data/diagnostics.json', JSON.stringify({ version: 1, type: 'diagnostics', producerPid: doctor.pid,
            generatedAt: f.clock.now, resetEpoch: '4:1:2', state: 'READY', summary: 'All good', issues: [] }));
        f.processes.delete(doctor.pid); f.clock.now += 5000;
    };
    await assert.rejects(supervisor.main(f.ns), /end fixture/);
    for (const filename of ['doctor.js', 'daemon.js', 'fleet-manager.js', 'progression-manager.js', 'augmentation-planner.js']) {
        assert.equal(f.launched.filter(p => p.filename === filename).length, 1, filename);
    }
    assert.equal(JSON.parse(f.files.get('data/savings.json')).target, 'TOR');
    const fleet = f.launched.find(p => p.filename === 'fleet-manager.js');
    assert.equal(fleet.args[fleet.args.indexOf('--cloud-payback') + 1], 900);
    const daemon = f.launched.find(p => p.filename === 'daemon.js');
    assert.ok(daemon.args[daemon.args.indexOf('--home-reserve') + 1] >= 18);
    assert.ok(f.logs.some(line => line.includes('Diagnostics')));
    assert.ok(f.files.has('data/telemetry.json'));
});

test('supervised planner publishes advice but cannot execute a purchase or silently overwrite a savings goal', async () => {
    const f = fixture(), planner = loadScript('augmentation-planner.js', f.clock);
    f.ns.flags = pairs => ({ ...Object.fromEntries(pairs), report: true, 'save-goal': true });
    f.ns.getPlayer = () => ({ factions: ['CyberSec'] });
    f.ns.singularity = { getOwnedAugmentations: () => [], getFactionRep: () => 0,
        getAugmentationsFromFaction: () => ['BitWire'], getAugmentationRepReq: () => 100,
        getAugmentationPrice: () => 1000, getAugmentationPrereq: () => [], getAugmentationStats: () => ({ hacking: 1.1 }),
        purchaseAugmentation: () => assert.fail('read-only'), installAugmentations: () => assert.fail('read-only') };
    await planner.main(f.ns);
    const report = JSON.parse(f.files.get('data/augmentation-plan.json'));
    assert.equal(report.plan.next.name, 'BitWire'); assert.equal(report.producerPid, 1);
    assert.equal(f.files.has('data/savings.json'), false);
});
