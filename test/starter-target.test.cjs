const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, Port, loadScript } = require('./helpers.cjs');

function fixture(overrides = {}) {
    const clock = new Clock(), api = loadScript('starter-target.js', clock), port = new Port();
    const servers = {
        n00dles: { hasAdminRights: true, moneyMax: 1e6, moneyAvailable: 1e6,
            requiredHackingSkill: 1, minDifficulty: 1, hackDifficulty: 1, serverGrowth: 3000, hackMs: 1000 },
        foodnstuff: { hasAdminRights: true, moneyMax: 50e6, moneyAvailable: 50e6,
            requiredHackingSkill: 1, minDifficulty: 1, hackDifficulty: 1, serverGrowth: 50, hackMs: 1000 },
        ...overrides,
    };
    const request = { type: 'starter-target-request', version: 1, requestId: '1:1000000', ownerPid: 1,
        resetEpoch: '4:1:2', createdAt: clock.now, expiresAt: clock.now + 15000,
        hosts: ['home', ...Object.keys(servers)], threads: 57, target: 'n00dles' };
    port.write(request);
    const ns = { args: [JSON.stringify(request)], getPortHandle: () => port,
        getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }),
        getHackingLevel: () => 246, getHackingMultipliers: () => ({ chance: 1.38, money: 1.38, growth: 1.38 }),
        getServer: host => servers[host], getHackTime: host => servers[host].hackMs,
        isRunning: () => true };
    return { clock, api, ns, port, request, servers };
}

test('57-thread starter at hacking 246 replaces n00dles with a profitable accessible target', async () => {
    const f = fixture();
    await f.api.main(f.ns);
    assert.equal(f.port.peek().type, 'starter-target-result');
    assert.equal(f.port.peek().target, 'foodnstuff');
    assert.equal(f.port.peek().resetEpoch, '4:1:2');
});

test('target selection excludes unrooted, unhackable, moneyless and malformed servers', async () => {
    const base = fixture().servers.foodnstuff;
    const f = fixture({
        unrooted: { ...base, moneyMax: 1e12, hasAdminRights: false },
        highLevel: { ...base, moneyMax: 1e12, requiredHackingSkill: 500 },
        empty: { ...base, moneyMax: 0 },
        malformed: { ...base, serverGrowth: NaN },
    });
    await f.api.main(f.ns);
    assert.equal(f.port.peek().target, 'foodnstuff');
});

test('starter ranking weighs hack time and growth instead of only maximum money', async () => {
    const base = fixture().servers.foodnstuff;
    const f = fixture({ hugeSlow: { ...base, moneyMax: 100e6, moneyAvailable: 100e6, hackMs: 600000, serverGrowth: 5 } });
    await f.api.main(f.ns);
    assert.equal(f.port.peek().target, 'foodnstuff');
});

test('an empty high-security target with long preparation cannot interrupt ready income', async () => {
    const base = fixture().servers.foodnstuff;
    const f = fixture({ foodnstuff: { ...base, moneyAvailable: 0, hackDifficulty: 80, hackMs: 30000, serverGrowth: 5 } });
    await f.api.main(f.ns);
    assert.equal(f.port.peek().target, 'n00dles');
});

test('the live growth multiplier reduces modeled preparation and improves income ranking', () => {
    const f = fixture(), server = { ...f.servers.foodnstuff, moneyAvailable: 1e6 };
    const base = f.api.starterCandidate(server, 246, 1000, 57, { growth: 1 });
    const boosted = f.api.starterCandidate(server, 246, 1000, 57, { growth: 2 });
    assert.ok(boosted.prepMs < base.prepMs);
    assert.ok(boosted.steady > base.steady);
});

test('a much more profitable target with fourteen minutes of preparation is no longer assigned a zero score', async () => {
    const base = fixture().servers.foodnstuff;
    const f = fixture({ foodnstuff: { ...base, moneyMax: 1e9, moneyAvailable: 1e7, hackMs: 10000 } });
    f.request.threads = 108; f.ns.args = [JSON.stringify(f.request)];
    await f.api.main(f.ns);
    const result = f.port.peek();
    assert.equal(result.target, 'foodnstuff'); assert.ok(result.prepMs > 600000);
    assert.match(result.reason, /estimated prep/);
});

test('target analysis explains keeping n00dles and reports unavailable analysis instead of silently exiting', async () => {
    const f = fixture({ foodnstuff: { ...fixture().servers.foodnstuff, hasAdminRights: false } });
    await f.api.main(f.ns); assert.match(f.port.peek().reason, /Keeping n00dles/);
    const broken = fixture(); broken.ns.getServer = () => { throw Error('server lookup failed'); };
    await broken.api.main(broken.ns);
    assert.equal(broken.port.peek().type, 'starter-target-result'); assert.match(broken.port.peek().reason, /server lookup failed/);
});

test('live analysis carries a reduced BitNode hack fraction and growth into the prepared estimate', async () => {
    const f = fixture(); let analyzed = 0;
    f.ns.hackAnalyze = () => { analyzed++; return .0005; };
    f.ns.growthAnalyze = host => Math.log1p(.01) / (Math.log1p(.0035) * f.servers[host].serverGrowth / 100 * .5);
    await f.api.main(f.ns);
    const selected = f.port.peek();
    const expected = f.api.starterCandidate(f.servers[selected.target], 246, 1000, 57, f.ns.getHackingMultipliers(),
        { fraction: .0005, growthLog: Math.log1p(.0035) * f.servers[selected.target].serverGrowth / 100 * .5 });
    assert.equal(analyzed, 2); assert.equal(selected.steady, expected.steady);
    assert.equal(selected.target, 'foodnstuff');
});

test('a 20 percent improvement cannot churn targets, even while the incumbent is growing', async () => {
    const base = fixture().servers.n00dles;
    for (const moneyAvailable of [base.moneyMax, 10000]) {
        const f = fixture({ n00dles: { ...base, moneyAvailable },
            foodnstuff: { ...base, moneyMax: base.moneyMax * 1.2, moneyAvailable: base.moneyMax * 1.2 } });
        await f.api.main(f.ns);
        assert.equal(f.port.peek().target, 'n00dles');
    }
});

for (const reason of ['epoch', 'expired', 'superseded', 'owner-exited']) {
    test(`selector cannot publish a result after ${reason}`, async () => {
        const f = fixture();
        if (reason === 'epoch') f.ns.getResetInfo = () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 3 });
        if (reason === 'expired') f.clock.now += 15000;
        if (reason === 'superseded') { f.port.clear(); f.port.write({ requestId: 'new' }); }
        if (reason === 'owner-exited') f.ns.isRunning = () => false;
        await f.api.main(f.ns);
        assert.notEqual(f.port.peek().type, 'starter-target-result');
    });
}

test('the selected richer target increases starter income in the worker simulation', async () => {
    const f = fixture();
    await f.api.main(f.ns);
    async function simulate(target) {
        const clock = new Clock(), worker = loadScript('starter-worker.js', clock), server = f.servers[target];
        const max = server.moneyMax, groups = [1, 5, 6, 6, 6, 6, 13, 14];
        let money = max, security = 1, earned = 0;
        for (const threads of groups) {
            void worker.main({ args: [target], disableLog() {}, hasRootAccess: () => true,
                getServerMoneyAvailable: () => money, getServerMaxMoney: () => max,
                getServerSecurityLevel: () => security, getServerMinSecurityLevel: () => 1,
                hack: async () => { await clock.sleep(server.hackMs); const cash = money * .001 * threads;
                    money -= cash; earned += cash; security += .002 * threads; },
                grow: async () => { await clock.sleep(server.hackMs * 3.2);
                    money = Math.min(max, (money + threads) * 1.0035 ** (threads * server.serverGrowth / 100));
                    security += .004 * threads; },
                weaken: async () => { await clock.sleep(server.hackMs * 4); security = Math.max(1, security - .05 * threads); },
            });
        }
        await clock.runUntil(clock.now + 300000);
        return earned;
    }
    const before = await simulate('n00dles'), after = await simulate(f.port.peek().target);
    assert.ok(after > before * 2, `five-minute model income: n00dles ${before}; selected target ${after}`);
});
