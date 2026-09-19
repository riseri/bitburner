const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function load(){
  const files=['lib/ports.js','lib/stock-strategy.js','stock-trader.js'];
  let all='';
  for(const item of files){
    all+=fs.readFileSync(path.join(__dirname,'../src',item),'utf8')
      .replace(/^import .*;\s*$/gm,'')
      .replace(/\bexport (?=(?:async )?function|const )/g,'')+'\n';
  }
  const names=[...all.matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map(m=>m[1]);
  const sandbox={Date};vm.createContext(sandbox);
  new vm.Script(all+`\n;globalThis.api={${names.join(',')}}`).runInContext(sandbox);
  return sandbox.api;
}
const api=load();

function fixture(overrides={}){
  const logs=[],terminal=[],calls=[];
  const status={items:[],clear(){this.items.length=0;},write(v){this.items=[v];},peek(){return this.items[0]??'NULL PORT DATA';}};
  const access={wse:true,tix:true,fourS:true,...overrides.access};
  let cash=overrides.cash??1e12;
  const commission=100_000;
  const stocks={
    AAA:{forecast:0.70,volatility:0.04,ask:100,bid:99,maxShares:5e9,pos:[0,0,0,0]},
    BBB:{forecast:0.62,volatility:0.02,ask:200,bid:199,maxShares:5e9,pos:[0,0,0,0]},
    CCC:{forecast:0.52,volatility:0.03,ask:50,bid:49,maxShares:5e9,pos:[0,0,0,0]},
    ...(overrides.stocks||{}),
  };
  let updates=0;
  const flags={ticks:1,'max-buys-per-tick':1,...overrides.flags};
  const ns={
    pid:42,
    getHostname:()=>overrides.host||'home',
    getScriptName:()=> 'stock-trader.js',
    flags:pairs=>({...Object.fromEntries(pairs),...flags}),
    disableLog(){},
    ps:()=>overrides.duplicate?[{pid:7,filename:'stock-trader.js'}]:[{pid:42,filename:'stock-trader.js'}],
    tprint:s=>terminal.push(s),
    print:s=>logs.push(s),
    clearLog:()=>{logs.length=0;},
    getServerMoneyAvailable:()=>cash,
    getPortHandle:()=>status,
    stock:{
      hasWseAccount:()=>access.wse,
      hasTixApiAccess:()=>access.tix,
      has4SDataTixApi:()=>access.fourS,
      getConstants:()=>({StockMarketCommission:commission,msPerStockUpdate:6000}),
      getSymbols:()=>Object.keys(stocks),
      getPosition:s=>[...stocks[s].pos],
      getForecast:s=>stocks[s].forecast,
      getVolatility:s=>stocks[s].volatility,
      getAskPrice:s=>stocks[s].ask,
      getBidPrice:s=>stocks[s].bid,
      getMaxShares:s=>stocks[s].maxShares,
      nextUpdate:async()=>{
        updates++;calls.push('nextUpdate');
        if(overrides.onUpdate)await overrides.onUpdate({access,stocks,updates});
        return 6000;
      },
      buyStock:(s,shares)=>{
        calls.push('buy:'+s);
        shares=Math.round(shares);
        const stock=stocks[s],cost=shares*stock.ask+commission;
        if(shares<=0||cash<cost||shares+stock.pos[0]+stock.pos[2]>stock.maxShares)return 0;
        const prior=stock.pos[0]*stock.pos[1];
        cash-=cost;
        stock.pos[0]+=shares;
        stock.pos[1]=(prior+shares*stock.ask)/stock.pos[0];
        return stock.ask;
      },
      sellStock:(s,shares)=>{
        calls.push('sell:'+s);
        const stock=stocks[s];shares=Math.min(Math.round(shares),stock.pos[0]);
        if(shares<=0)return 0;
        cash+=shares*stock.bid-commission;
        stock.pos[0]-=shares;
        if(!stock.pos[0])stock.pos[1]=0;
        return stock.bid;
      },
    },
  };
  return {ns,access,stocks,logs,terminal,calls,status,get cash(){return cash;},get updates(){return updates;}};
}

test('stock trader publishes supervisor heartbeat and capital floor',async()=>{
  const f=fixture({flags:{ticks:1}});
  await api.main(f.ns);
  const status=f.status.peek();
  assert.equal(status.type,'stock-status');
  assert.equal(status.version,1);
  assert.equal(status.producerPid,42);
  assert.equal(status.access.ok,true);
  assert.ok(status.reserveFloor>0);
  assert.ok(status.equity>=status.cash);
});

test('stock trader refuses to start without required market access',async()=>{
  for(const missing of ['wse','tix','fourS']){
    const f=fixture({access:{[missing]:false}});
    await api.main(f.ns);
    assert.equal(f.calls.length,0,missing);
    assert.equal(f.updates,0,missing);
    assert.match(f.terminal[0],/disabled/);
  }
});

test('stock trader freezes without liquidation if access disappears mid-run',async()=>{
  const f=fixture({
    stocks:{AAA:{forecast:0.70,volatility:0.04,ask:100,bid:99,maxShares:5e9,pos:[1e6,80,0,0]}},
    onUpdate:async({access})=>{access.fourS=false;},
  });
  const before=[...f.stocks.AAA.pos];
  await api.main(f.ns);
  assert.deepEqual(f.stocks.AAA.pos,before);
  assert.ok(!f.calls.some(c=>c.startsWith('sell:')||c.startsWith('buy:')));
  assert.match(f.terminal[0],/Existing positions were left untouched/);
});

test('stock trader buys the strongest 4S signal while preserving reserve and position cap',async()=>{
  const f=fixture();
  await api.main(f.ns);
  assert.ok(f.stocks.AAA.pos[0]>0,'AAA should be bought');
  assert.equal(f.stocks.BBB.pos[0],0,'max one buy this tick');
  assert.ok(f.cash>=1.99e11,'20% reserve should remain liquid');
  const aaaValue=f.stocks.AAA.pos[0]*f.stocks.AAA.bid;
  assert.ok(aaaValue<=2.51e11,'position should stay near/below 25% of equity');
  assert.ok(f.calls.includes('nextUpdate'));
  assert.ok(f.calls.includes('buy:AAA'));
});

test('stock trader exits weak longs before allocating new capital',async()=>{
  const f=fixture({
    stocks:{
      CCC:{forecast:0.52,volatility:0.03,ask:50,bid:49,maxShares:5e9,pos:[1e6,60,0,0]},
      AAA:{forecast:0.70,volatility:0.04,ask:100,bid:99,maxShares:5e9,pos:[0,0,0,0]},
    },
  });
  await api.main(f.ns);
  assert.equal(f.stocks.CCC.pos[0],0);
  assert.ok(f.stocks.AAA.pos[0]>0);
  assert.ok(f.calls.indexOf('sell:CCC')<f.calls.indexOf('buy:AAA'));
});

test('stock trader dry-run never mutates cash or positions',async()=>{
  const f=fixture({flags:{'dry-run':true}});
  const before=f.cash;
  await api.main(f.ns);
  assert.equal(f.cash,before);
  assert.equal(f.stocks.AAA.pos[0],0);
  assert.ok(!f.calls.some(c=>c.startsWith('buy:')||c.startsWith('sell:')));
  assert.match(f.logs.join('\n'),/WOULD BUY/);
});

test('stock trader finite tick mode exits after requested updates',async()=>{
  const f=fixture({flags:{ticks:2}});
  await api.main(f.ns);
  assert.equal(f.updates,2);
});

test('stock trader duplicate and remote instances do not touch the market',async()=>{
  for(const opts of [{duplicate:true},{host:'cloud-00'}]){
    const f=fixture(opts);await api.main(f.ns);
    assert.ok(!f.calls.some(c=>c.startsWith('buy:')||c.startsWith('sell:')||c==='nextUpdate'));
    assert.equal(f.terminal.length,1);
  }
});

test('stock trader never auto-buys access, shorts, or mutates unrelated services',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/stock-trader.js'),'utf8');
  for(const re of [
    /purchaseWseAccount\s*\(/,
    /purchaseTixApi\s*\(/,
    /purchase4SMarketData/,
    /buyShort\s*\(/,
    /sellShort\s*\(/,
    /ns\.(run|exec|kill|scriptKill|killall|getPortHandle)\s*\(/,
    /ns\.singularity/,
  ]) assert.doesNotMatch(source,re);
});
