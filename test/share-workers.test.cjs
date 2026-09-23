const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');
const { NetscriptSimulation } = require('./simulator.cjs');

test('home is never admitted to the JIT worker fleet', async () => {
	const sim = new NetscriptSimulation({ hostCount: 3, flags: { 'max-targets': 1 } });
	sim.run();
	await sim.clock.runUntil(sim.start + 180_000);
	assert.deepEqual(sim.errors.map(String), []);
	assert.ok(sim.launches.length > 0);
	assert.ok(sim.launches.every(launch => launch.host !== 'home'));
	const network = sim.daemon.networkFromFleetStatus({ network: {
		servers: ['home', 'cloud-0'], rooted: 2,
		hosts: [{ name: 'home', maxRam: 1024, cores: 8 }, { name: 'cloud-0', maxRam: 64, cores: 1 }],
	} }, 2);
	assert.deepEqual(network.hosts.map(host => host.name), ['cloud-0']);
});

test('remote share workers use spare RAM and remain reclaimable', () => {
	const api = loadScript('daemon.js', new Clock());
	const processes = [];
	let nextPid = 1;
	const ns = {
		ps: host => processes.filter(process => process.host === host),
		getScriptRam: () => 4,
		getServerUsedRam: host => processes.filter(process => process.host === host)
			.reduce((sum, process) => sum + process.threads * 4, 0),
		exec: (filename, host, threads) => {
			processes.push({ pid: nextPid, filename, host, threads });
			return nextPid++;
		},
		kill: pid => {
			const index = processes.findIndex(process => process.pid === pid);
			if (index < 0) return false;
			processes.splice(index, 1);
			return true;
		},
	};
	const hosts = [{ name: 'cloud-0', maxRam: 64, cores: 1 }];
	const cfg = { fleetShare: true, homeReserve: 0 };
	// Even a future full-host reservation must not suppress disposable sharing now.
	api.reconcileFleetShare(ns, hosts, cfg, new Map(), [
		{ host: 'cloud-0', start: Date.now() + 60_000, end: Date.now() + 120_000, ram: 64 },
	], new Map([['cloud-0', 0]]));
	assert.equal(processes[0].filename, 'share-worker.js');
	assert.equal(processes[0].threads, 16);
	assert.equal(api.reclaimFleetShare(ns, 'cloud-0'), true);
	assert.equal(processes.length, 0);
});

test('home sharing fills only RAM above the service reserve', () => {
	const api = loadScript('supervisor.js', new Clock());
	const processes = [];
	let nextPid = 1;
	const ns = {
		ps: () => processes,
		getScriptRam: () => 4,
		getServerMaxRam: () => 64,
		getServerUsedRam: () => 16 + processes.reduce((sum, process) => sum + process.threads * 4, 0),
		run: (filename, threads) => {
			processes.push({ pid: nextPid, filename, threads });
			return nextPid++;
		},
		kill: pid => {
			const index = processes.findIndex(process => process.pid === pid);
			if (index < 0) return false;
			processes.splice(index, 1);
			return true;
		},
	};
	assert.match(api.reconcileHomeShare(ns, true, 8), /10 threads/);
	assert.equal(processes[0].threads, 10);
	api.yieldHomeShare(ns);
	assert.equal(processes.length, 0);
});

test('sharing status aggregates home and remote RAM with the live faction multiplier', () => {
	const api = loadScript('supervisor.js', new Clock());
	const processes = new Map([
		['home', [{ filename: 'share-worker.js', threads: 5 }]],
		['cloud-0', [{ filename: 'share-worker.js', threads: 12 }]],
		['cloud-1', [{ filename: 'jit-grow.js', threads: 20 }]],
	]);
	const ns = {
		getSharePower: () => 1.23456,
		ps: host => processes.get(host) || [],
		getScriptRam: () => 4,
	};
	const status = api.collectSharingStatus(ns, true, { network: { hosts: [
		{ name: 'home' }, { name: 'cloud-0' }, { name: 'cloud-1' },
	] } }, 8);
	assert.deepEqual(JSON.parse(JSON.stringify(status)), {
		enabled: true, power: 1.23456, threads: 17, ram: 68, hosts: 2, reserve: 8,
	});
	assert.equal(api.sharingLabel(status), '1.235x faction rep | 17 threads | 68 GB on 2 hosts');
	const logs = [];
	api.renderOverview({ print: line => logs.push(String(line)) },
		{ mode: 'multi', income60: 0, model: 0, pipelines: [] }, null, status);
	assert.ok(logs.some(line => line.includes('Sharing') && line.includes('1.235x faction rep')));
	assert.ok(logs.some(line => line.includes('68 GB on 2 hosts')));
});
