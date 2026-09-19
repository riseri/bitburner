const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function load(){
  const file=fs.readFileSync(path.join(__dirname,'../src/lib/stock-strategy.js'),'utf8')
    .replace(/\bexport (?=(?:async )?function|const )/g,'');
  const names=[...file.matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map(m=>m[1]);
  const sandbox={};vm.createContext(sandbox);
  new vm.Script(file+`\n;globalThis.api={${names.join(',')}}`).runInContext(sandbox);
  return sandbox.api;
}
const api=load();

test('stock strategy normalizes safe defaults',()=>{
  const cfg=api.normalizeStockConfig({});
  assert.equal(cfg.cashReserve,0.20);
  assert.equal(cfg.maxExposure,0.80);
  assert.equal(cfg.maxPosition,0.25);
  assert.equal(cfg.entryForecast,0.60);
  assert.equal(cfg.exitForecast,0.55);
  assert.equal(cfg.dryRun,false);
});

test('stock strategy ranks stronger 4S long edges first',()=>{
  const cfg=api.normalizeStockConfig({});
  const rows=[
    {symbol:'AAA',forecast:0.61,volatility:0.02,shortShares:0,longShares:0,maxShares:1e6},
    {symbol:'BBB',forecast:0.64,volatility:0.01,shortShares:0,longShares:0,maxShares:1e6},
    {symbol:'CCC',forecast:0.70,volatility:0.03,shortShares:1,longShares:0,maxShares:1e6},
    {symbol:'DDD',forecast:0.59,volatility:0.05,shortShares:0,longShares:0,maxShares:1e6},
  ];
  const ranked=api.rankLongCandidates(rows,cfg);
  assert.deepEqual(Array.from(ranked,r=>r.symbol),['AAA','BBB']);
  assert.ok(ranked[0].edge>ranked[1].edge);
});

test('stock strategy uses hysteresis for exits',()=>{
  const cfg=api.normalizeStockConfig({});
  assert.equal(api.shouldExitLong({longShares:100,forecast:0.549},cfg),true);
  assert.equal(api.shouldExitLong({longShares:100,forecast:0.551},cfg),false);
  assert.equal(api.shouldExitLong({longShares:0,forecast:0.1},cfg),false);
});

test('stock strategy share sizing respects budget and capacity',()=>{
  const row={ask:100,longShares:100,shortShares:50,maxShares:1000};
  assert.equal(api.sharesForBudget(row,50100,100),500);
  assert.equal(api.sharesForBudget(row,1e9,100),850);
  assert.equal(api.sharesForBudget(row,50,100),0);
});

test('stock strategy rejects trades whose expected edge cannot beat spread and fees',()=>{
  const cfg=api.normalizeStockConfig({'min-hold-ticks':6,'min-profit-multiple':1.15});
  const strong={forecast:0.70,volatility:0.04,ask:100,bid:99};
  const weak={forecast:0.60,volatility:0.005,ask:100,bid:99};
  assert.equal(api.tradeHasEnoughEdge(strong,1_000_000,100_000,cfg),true);
  assert.equal(api.tradeHasEnoughEdge(weak,10_000,100_000,cfg),false);
});

test('stock portfolio metrics preserve cash and mark long/short positions',()=>{
  const rows=[
    {longShares:1000,longAvg:80,bid:100,shortShares:0,shortAvg:0,ask:101},
    {longShares:0,longAvg:0,bid:100,shortShares:1000,shortAvg:120,ask:100},
  ];
  const m=api.portfolioMetrics(1_000_000,rows,100);
  assert.equal(m.longValue,99_900);
  assert.equal(m.shortValue,139_900);
  assert.equal(m.exposure,239_800);
  assert.equal(m.equity,1_239_800);
  assert.equal(m.openPnl,39_800);
});

test('stock config rejects dangerous or contradictory limits',()=>{
  for(const flags of [
    {'cash-reserve':1},
    {'max-exposure':0},
    {'max-position':0.9,'max-exposure':0.8},
    {'entry-forecast':0.5},
    {'exit-forecast':0.61},
    {'min-hold-ticks':0},
    {'max-buys-per-tick':0},
  ]) assert.throws(()=>api.normalizeStockConfig(flags));
});
