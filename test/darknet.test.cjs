const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

const clock = new Clock();
const solvers = loadScript('lib/darknet-solvers.js', clock);

test('darknet static solvers decode direct, captcha, binary, xor, base, arithmetic and prime hints', () => {
    const cases = [
        [{modelId:'ZeroLogon'}, ''],
        [{modelId:'DeskMemo_3.1',passwordHint:'The PIN is 428'}, '428'],
        [{modelId:'CloudBlare(tm)',data:'1/[2]╬3'}, '123'],
        [{modelId:'110100100',data:'01000001 00110001'}, 'A1'],
        [{modelId:'PrimeTime 2',data:'13195'}, '29'],
        [{modelId:'OctantVoxel',data:'16,FF'}, '255'],
        [{modelId:'MathML',data:'4 ➕ 5 ҳ ( 6 ➖ 2 )'}, '24'],
        [{modelId:'OrdoXenos',data:`BA;00000011 00000011`}, 'AB'],
        [{modelId:'Pr0verFl0',passwordLength:4}, '■■■■■■■■'],
    ];
    for (const [details, expected] of cases) assert.equal(String(solvers.staticCandidates(details)[0]), expected, details.modelId);
});

test('darknet feedback parser selects the exact attempted password log', () => {
    const logs = ['noise', JSON.stringify({passwordAttempted:'111',data:'Lower'}), JSON.stringify({passwordAttempted:'222',data:'Higher'})];
    assert.equal(solvers.parsePasswordResponse(logs,'222').data,'Higher');
    assert.equal(solvers.parsePasswordResponse(logs,'333'),null);
});

test('darknet numeric oracle solver authenticates a GuessNumber server', async () => {
    const password = '731', logs = [];
    const ns = { dnet: {
        authenticate: async (_host, attempt) => {
            if (attempt === password) return {success:true,code:200};
            logs.unshift(JSON.stringify({passwordAttempted:attempt,data:Number(attempt)>Number(password)?'Lower':'Higher'}));
            return {success:false,code:401};
        },
        heartbleed: async () => ({success:true,logs:[...logs]}),
    }};
    const result = await solvers.solveServer(ns,'target',{modelId:'AccountsManager_4.2',passwordLength:3,passwordFormat:'numeric'});
    assert.equal(result.success,true); assert.equal(result.password,password); assert.ok(result.attempts <= 10);
});

test('darknet XOR and Darkscape progression are included in the complete model/unlock surface', () => {
    const protocol = loadScript('lib/progression-protocol.js', new Clock());
    assert.equal(protocol.progressionPrograms().at(-1).name,'DarkscapeNavigator.exe');
    assert.equal(protocol.progressionPrograms().at(-1).cost,50_000_000);
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/lib/darknet-solvers.js'),'utf8');
    for (const model of ['PHP 5.4','DeepGreen','AccountsManager_4.2','BellaCuore','NIL','RateMyPix.Auth','2G_cellular','Factori-Os','BigMo%od','KingOfTheHill','OpenWebAccessPoint','(The Labyrinth)']) assert.match(source,new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('darknet manager persists credentials and counts operational events', () => {
    const manager = loadScript('darknet-manager.js', new Clock());
    const state={servers:{},agents:{},stats:{caches:0,deployments:0,blocked:0,errors:0},last:''};
    manager.applyEvent(state,{kind:'credential',host:'x',password:'secret',modelId:'ZeroLogon',at:1});
    manager.applyEvent(state,{kind:'cache',host:'x',at:2});
    manager.applyEvent(state,{kind:'deployed',host:'x',pid:7,at:3});
    manager.applyEvent(state,{kind:'agent',host:'x',pid:7,state:'running',at:4});
    assert.equal(state.servers.x.password,'secret'); assert.equal(state.stats.caches,1);
    assert.equal(state.stats.deployments,1); assert.equal(state.agents['x:7'].state,'running');
});

test('darknet manager exposes authentication work in flight until it resolves', () => {
    const manager = loadScript('darknet-manager.js', new Clock());
    const state={servers:{},agents:{},stats:{caches:0,deployments:0,blocked:0,errors:0},last:''};
    manager.applyEvent(state,{kind:'cracking',host:'alpha',from:'darkweb',pid:3,modelId:'ZeroLogon',at:1});
    assert.equal(state.cracking.alpha.modelId,'ZeroLogon');
    assert.equal(state.agents['darkweb:3'].state,'cracking');
    manager.applyEvent(state,{kind:'credential',host:'alpha',password:'',modelId:'ZeroLogon',at:2});
    assert.equal(state.cracking.alpha,undefined);
});

test('darknet crawler heartbeat clears a stale deployment blocker', () => {
    const manager = loadScript('darknet-manager.js', new Clock());
    const state={servers:{alpha:{blocker:'agent-ram',freeRam:0.1,requiredRam:15.9}},agents:{},stats:{caches:0,deployments:0,blocked:1,errors:0},last:''};
    manager.applyEvent(state,{kind:'agent',host:'alpha',pid:4,state:'running',at:3});
    assert.equal(state.servers.alpha.blocker,undefined);
    assert.equal(state.servers.alpha.requiredRam,undefined);
    assert.equal(state.servers.alpha.accessedAt,3);
});

test('darknet crawler keeps high-RAM optional APIs in isolated one-shot workers', () => {
    const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '../src');
    const crawler = fs.readFileSync(path.join(root, 'darknet-agent.js'), 'utf8');
    assert.match(crawler, /lib\/darknet-formulas\.js/);
    assert.doesNotMatch(crawler, /lib\/formulas\.js/);
    for (const api of ['setStasisLink', 'induceServerMigration', 'freezeServer', 'promoteStock', 'unleashStormSeed', 'stock.getSymbols', 'stock.getPosition']) {
        assert.doesNotMatch(crawler, new RegExp(`ns\\.(?:dnet\\.)?${api.replace('.', '\\.')}`), `${api} must not inflate crawler RAM`);
    }
    const workers = {
        'darknet-stasis.js': 'setStasisLink', 'darknet-migrate.js': 'induceServerMigration',
        'darknet-freeze.js': 'freezeServer', 'darknet-stock.js': 'promoteStock', 'darknet-storm.js': 'unleashStormSeed',
    };
    for (const [file, api] of Object.entries(workers)) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), new RegExp(api));
});

test('darknet neighbor visitor uses bounded concurrency without dropping work', async () => {
    const agent = loadScript('darknet-agent.js', new Clock());
    let active = 0, peak = 0;
    const pending = [];
    const run = agent.visitNeighbors(['a','b','c','d','e'], 2, async host => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => pending.push(() => { active--; resolve(host); }));
    });
    for (let completed = 0; completed < 5;) {
        await Promise.resolve();
        const release = pending.shift();
        if (release) { release(); completed++; }
    }
    await run;
    assert.equal(peak, 2);
    assert.equal(active, 0);
});

test('darknet configuration defaults to parallel cracking and scalable child agents', () => {
    const cfg = loadScript('darknet-agent.js', new Clock()).parseConfig('{}');
    assert.equal(cfg.concurrency, 4);
    assert.equal(cfg.agentThreads, 4);
    assert.equal(cfg.version, 5);
});

test('darknet 16 GB bootstrap reserves bounded dynamic RAM before importing the crawler', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/darknet-bootstrap.js'),'utf8');
    assert.match(source,/CRAWLER_RAM = 15\.9/);
    assert.match(source,/ns\.ramOverride\(CRAWLER_RAM\)/);
    assert.match(source,/ns\.dynamicImport\(AGENT\)/);
});
