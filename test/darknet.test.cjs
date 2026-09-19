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

