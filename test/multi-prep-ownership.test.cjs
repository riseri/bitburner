const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

test('a hard target recovery cancels optional scouting prep, not a peer or an owned repair', () => {
    const clock = new Clock(), api = loadScript('lib/target-pipelines.js', clock);
    const killed = [];
    const ns = { isRunning: () => true, kill: pid => { killed.push(pid); return true; } };
    const prep = { enabled: true, active: { pid: 17, ram: 40 }, preemptions: 0 };
    const p = { name: 'alpha', mode: 'DRAINING', recovery: null, drain: { hard: false } };
    const peerRepair = { active: { pid: 18, ram: 80 } };
    const pool = { cfg: { backgroundPrep: prep, prepStates: [prep, peerRepair] },
        api: { serviceHardDrain() {} } };
    api.servicePipelineSafety(ns, pool, p, clock.now);
    assert.deepEqual(killed, [17]);
    assert.equal(prep.active, null);
    assert.equal(peerRepair.active.pid, 18);
});
