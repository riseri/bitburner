const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

test('startup heartbeat never advertises an empty fleet to the live JIT reader', async () => {
    const clock = new Clock(), status = new Port();
    const fleet = loadScript('fleet-manager.js', clock), daemon = loadScript('daemon.js', clock);
    const snapshots = [], write = status.write.bind(status);
    status.write = value => { snapshots.push(value); write(value); };
    fleet.main({pid:9, flags:pairs=>Object.fromEntries(pairs), disableLog(){}, fileExists:()=>true,
        getPortHandle:()=>status, scan:host=>host==='home'?['n0']:[`n${Number(host.slice(1))+1}`],
        sleep:()=>clock.sleep(1000)});
    await clock.runUntil(clock.now + 20000);
    assert.ok(snapshots.length >= 4);
    for (const snapshot of snapshots) {
        assert.equal(snapshot.network, null, 'startup liveness must not remove known worker hosts');
        assert.equal(daemon.networkFromFleetStatus(snapshot, 1.75), null, 'live JIT keeps its prior fleet');
    }
    assert.ok(clock.now - status.peek().generatedAt <= 5000);
});

test('cloud purchase after failed first discovery cannot publish a partial replacement fleet', async () => {
    const clock = new Clock(), status = new Port(), names = [];
    const fleet = loadScript('fleet-manager.js', clock);
    fleet.main({pid:9, flags:pairs=>Object.fromEntries(pairs), disableLog(){}, fileExists:()=>true,
        getPortHandle:()=>status, scan:()=>{throw new Error('discovery unavailable');},
        getServerMoneyAvailable:()=>1e6, getServerMaxRam:()=>64, serverExists:()=>false,
        scp:async()=>true, sleep:ms=>clock.sleep(ms),
        cloud:{getServerLimit:()=>1, getRamLimit:()=>64, getServerNames:()=>[...names],
            getServerCost:()=>1, purchaseServer:name=>{names.push(name);return name;}},
    });
    await clock.runUntil(clock.now + 1100);
    assert.equal(status.peek().cloud.purchases, 1);
    assert.equal(status.peek().network, null);
    assert.match(status.peek().cloud.error, /discovery unavailable/);
});
