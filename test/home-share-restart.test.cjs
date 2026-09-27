const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function fixture(maxRam = 128) {
    const clock = new Clock(), processes = new Map(), killed = [], launches = [], logs = [];
    const costs = { 'share-worker.js': 4, 'manual.js': 24, 'darknet-manager.js': 16,
        'darknet-agent.js': 15.9, 'bootstrap.js': 4, 'supervisor.js': 32 };
    let nextPid = 10;
    const add = (filename, threads = 1, args = [], host = 'home') => {
        const process = { filename, threads, args, host, pid: nextPid++ };
        processes.set(process.pid, process); return process;
    };
    const ns = {
        getHostname: () => 'home', ps: host => [...processes.values()].filter(p => p.host === host),
        getScriptRam: file => costs[file] || 0, getServerMaxRam: () => maxRam,
        getServerUsedRam: () => [...processes.values()].filter(p => p.host === 'home').reduce((sum,p) => sum + costs[p.filename] * p.threads, 0),
        kill: pid => { killed.push(pid); return processes.delete(pid); },
        run: (filename, options, ...args) => {
            const threads = typeof options === 'number' ? options : options.threads;
            if (ns.getServerUsedRam() + costs[filename] * threads > maxRam) return 0;
            const process = add(filename, threads, args); launches.push(process); return process.pid;
        },
        sleep: async ms => { clock.now += ms; }, tprint: line => logs.push(line), ui: { openTail() {} },
    };
    return { clock, ns, processes, killed, launches, logs, costs, add };
}

test('home share reclamation frees real RAM without touching manual or remote workers', () => {
    const f = fixture(), manual = f.add('manual.js'), share = f.add('share-worker.js',25), remote = f.add('share-worker.js',10,[],'cloud-0');
    const api = loadScript('lib/home-share.js',f.clock);
    assert.equal(api.homeShareRam(f.ns),100);
    assert.equal(api.reclaimHomeShare(f.ns,4),true); assert.equal(f.killed.length,0);
    assert.equal(api.reclaimHomeShare(f.ns,24),true);
    assert.deepEqual(f.killed,[share.pid]);
    assert.ok(f.processes.has(manual.pid)); assert.ok(f.processes.has(remote.pid));
});

test('failed share kills cannot claim that RAM was reclaimed', () => {
    const f = fixture(); f.add('manual.js'); f.add('share-worker.js',25);
    f.ns.kill = () => false;
    assert.equal(loadScript('lib/home-share.js',f.clock).reclaimHomeShare(f.ns,24),false);
    assert.equal(f.ns.getServerUsedRam(),124);
});

test('Darknet restart reclaims sharing refilled during backoff and preserves original arguments', async () => {
    const f = fixture(), args = ['--phish',false,'--agent-threads',2,'--home-reserve',12];
    const manual = f.add('manual.js'), manager = f.add('darknet-manager.js',1,args), share = f.add('share-worker.js',21);
    f.ns.sleep = async () => { share.threads = 26; }; // Old supervisor refills the manager's released RAM.
    await loadScript('darknet-restart.js',f.clock).main(f.ns);
    assert.deepEqual(f.killed,[manager.pid,share.pid]); assert.ok(f.processes.has(manual.pid));
    assert.equal(f.launches[0].filename,'darknet-manager.js');
    assert.deepEqual(f.launches[0].args,args);
    assert.ok(!f.logs.some(line => line.startsWith('ERROR')));
});

test('Darknet restart accepts a supervisor replacement without killing shares or launching duplicates', async () => {
    const f = fixture(); f.add('manual.js'); const share = f.add('share-worker.js',21);
    f.ns.sleep = async () => { f.add('darknet-manager.js'); };
    await loadScript('darknet-restart.js',f.clock).main(f.ns);
    assert.equal(f.launches.length,0); assert.equal(f.killed.length,0); assert.ok(f.processes.has(share.pid));
});

test('Darknet home crawler reclaims disposable sharing, scales threads, and preserves its reserve', () => {
    const f = fixture(), manual = f.add('manual.js'), share = f.add('share-worker.js',25);
    const result = loadScript('darknet-manager.js',f.clock).ensureHomeAgent(f.ns,{agentThreads:4,homeReserve:8,port:10});
    assert.equal(result.ok,true); assert.equal(f.launches[0].threads,4);
    assert.deepEqual(f.killed,[share.pid]); assert.ok(f.processes.has(manual.pid));
    assert.ok(f.ns.getServerMaxRam() - f.ns.getServerUsedRam() >= 8);
});

test('home crawler cannot spend protected RAM or displace other services when sharing is insufficient', () => {
    const f = fixture(); f.costs['manual.js'] = 112; f.add('manual.js'); f.add('share-worker.js',3);
    const result = loadScript('darknet-manager.js',f.clock).ensureHomeAgent(f.ns,{agentThreads:4,homeReserve:8,port:10});
    assert.equal(result.ok,false); assert.equal(f.killed.length,0); assert.equal(f.launches.length,0);
});

test('supervisor restart reserves enough sharing RAM for both bootstrap and restored supervisor', async () => {
    const f = fixture(), manual = f.add('manual.js'), share = f.add('share-worker.js',25);
    f.ns.sleep = async ms => {
        if (ms !== 2000) return;
        const bootstrap = [...f.processes.values()].find(p => p.filename === 'bootstrap.js');
        f.processes.delete(bootstrap.pid); // spawn releases bootstrap before launching supervisor.
        assert.ok(f.ns.run('supervisor.js',{threads:1}));
    };
    await loadScript('supervisor-restart.js',f.clock).main(f.ns);
    assert.deepEqual(f.killed,[share.pid]); assert.ok(f.processes.has(manual.pid));
    assert.deepEqual(f.launches.map(p => p.filename),['bootstrap.js','supervisor.js']);
    assert.ok(!f.logs.some(line => line.startsWith('ERROR')));
});
