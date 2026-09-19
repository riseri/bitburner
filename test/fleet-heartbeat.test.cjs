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


test('cloud spending respects a fresh stock cash floor', async () => {
    const clock = new Clock(), stock = new Port(), fleetStatus = new Port(), api = loadScript('fleet-manager.js', clock);
    stock.write({type:'stock-status',version:1,generatedAt:clock.now,access:{ok:true},dryRun:false,reserveFloor:900});
    let purchased=0;
    const ns={
        getPortHandle:n=>n===13?stock:fleetStatus,
        getServerMoneyAvailable:()=>1000,
        cloud:{getServerLimit:()=>1,getRamLimit:()=>64,getServerNames:()=>[],getServerCost:()=>200,
            purchaseServer:()=>{purchased++;return 'cloud-00';}},
    };
    const cfg={stockPort:13,cloud:{cashFloor:0,cashReserve:0.10,maxAction:0.25,minRam:32,prefix:'cloud'}};
    const state={purchases:0,upgrades:0,spent:0,reserveFloor:0,stockReserveFloor:0,actionBudget:0,lastAction:'none'};
    await api.manageOneCloudAction(ns,cfg,state);
    assert.equal(purchased,0);
    assert.equal(state.stockReserveFloor,900);
    assert.equal(state.reserveFloor,900);
    assert.equal(state.actionBudget,100);
});
