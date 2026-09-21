const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

const api = loadScript('lib/formulas.js', new Clock());

function fixture() {
    const state = { unlocked: false };
    const server = { moneyMax: 1e9, moneyAvailable: 2e8, minDifficulty: 2, hackDifficulty: 20 };
    const hacking = {
        hackPercent: s => 0.01 / s.hackDifficulty,
        hackChance: s => s.hackDifficulty === 2 ? 0.95 : 0.5,
        hackTime: s => s.hackDifficulty * 100,
        growTime: s => s.hackDifficulty * 320,
        weakenTime: s => s.hackDifficulty * 400,
        growThreads: s => (1e9 - s.moneyAvailable) / 1e7,
        weakenEffect: (threads, cores) => threads * 0.05 * (1 + (cores - 1) / 16),
    };
    const ns = {
        fileExists: name => name === 'Formulas.exe' && state.unlocked,
        getServer: () => ({ ...server }), getPlayer: () => ({ skills: { hacking: 500 } }), getSharePower: () => 2,
        singularity: { getFactionFavor: () => 100, getFactionRep: () => 400 },
        formulas: {
            hacking,
            work: { factionGains: (_player, type) => ({ reputation: type === 'hacking' ? 3 : 5 }), donationForRep: () => 999 },
            reputation: { donationForRep: rep => rep * 10, calculateRepToFavor: rep => rep / 100 },
            dnet: {
                getAuthenticateTime: (_details, threads, _player, correct) => (1000 + correct * 100) / threads,
                getHeartbleedTime: (_details, threads) => 2000 / threads,
                getExpectedRamBlockRemoved: (_details, threads) => 4 * threads,
            },
        },
    };
    return { ns, state };
}

test('hacking models switch from unavailable to exact formulas without recreating the caller', () => {
    const f = fixture();
    assert.equal(api.preparedHackingModel(f.ns, 'foodnstuff'), null);
    f.state.unlocked = true;
    const model = api.preparedHackingModel(f.ns, 'foodnstuff');
    assert.equal(model.formulas, true);
    assert.equal(model.chance, 0.95);
    assert.equal(model.times.W, 800);
    assert.equal(model.growthAnalyze(2), 50);
    assert.equal(api.formulaWeakenEffect(f.ns, 2, 1), 0.1);
});

test('work formulas rank live faction work, include hacking share power, donation, ETA inputs, and favor', () => {
    const f = fixture(); f.state.unlocked = true;
    const work = api.factionWorkAnalysis(f.ns, 'CyberSec', ['security', 'hacking']);
    assert.equal(work.workType, 'hacking');
    assert.equal(work.reputationPerSecond, 30);
    assert.equal(work.sharePower, 2);
    assert.equal(api.formulaDonationForRep(f.ns, 123), 1230);
    assert.equal(api.formulaFavorProjection(f.ns, 'CyberSec'), 104);
});

test('darknet formulas expose thread-aware authentication, heartbleed, and RAM recovery estimates', () => {
    const f = fixture(); f.state.unlocked = true;
    const metrics = api.darknetFormulaMetrics(f.ns, { passwordLength: 6 }, 2);
    assert.equal(metrics.authenticateMin, 500);
    assert.equal(metrics.authenticateMax, 800);
    assert.equal(metrics.heartbleed, 1000);
    assert.equal(metrics.ramPerCall, 8);
    assert.equal(metrics.formulas, true);
});

test('live formula availability starts shadow tuning without draining an earning lane', () => {
    const f=fixture(),clock=new Clock(),daemon=loadScript('daemon.js',clock),multi=loadScript('lib/target-pipelines.js',clock);
    const cfg={gap:100,lead:600,homeReserve:0,maxBatchRate:4};
    const p=multi.createTargetPipeline('alpha',cfg,daemon,1,0,{formulas:false,plan:{batchRate:2,expected:1000}});
    p.tunedLevel=500;p.tunedCapacity=1024;p.stats.lastHackAt=clock.now;
    const pool={api:{...daemon,hackingFormulasAvailable:api.hackingFormulasAvailable},cfg,
        network:{hosts:[{name:'cloud',maxRam:1024,cores:1}]},pipelines:new Map([['alpha',p]]),reservations:[]};
    f.state.unlocked=true;
    multi.serviceShadowTune({...f.ns,getHackingLevel:()=>500},pool,p);
    assert.equal(p.shadow.trigger,'formulas');assert.equal(p.shadow.state,'SHADOW');
    assert.equal(p.mode,'RUNNING');assert.equal(p.drain,null);assert.equal(p.generationSerial,1);
});
