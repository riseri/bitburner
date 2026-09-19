const test=require('node:test');
const assert=require('node:assert/strict');
const {loadGo}=require('./go-test-helpers.cjs');
const api=loadGo('lib/go-session.js');

test('IPvGO WHRNG predictor matches the game algorithm at known seeds',()=>{
    const values=api.whrngValues(123456789,4);
    const expected=[0.5265703110056097,0.28187257450457937,0.9559357419176924,0.5868954020029188];
    for(let i=0;i<expected.length;i++)assert.ok(Math.abs(values[i]-expected[i])<1e-12,i+': '+values[i]);
    assert.equal(api.daedalusPriorityRng(123456789),expected[2]);
});

test('IPvGO finds a four-cycle Daedalus distraction window within ten seconds',()=>{
    for(const start of [0,200,12345,100000,123456789,555555400,9876543210]){
        const plan=api.findDaedalusDistractionWindow(start,10000);
        assert.ok(plan,'missing window from '+start);
        assert.ok(plan.waitMs>=0&&plan.waitMs<=8800,'unexpected wait '+plan.waitMs);
        assert.equal(plan.priority.length,4);
        assert.ok(plan.priority.every(v=>v>=0.9),JSON.stringify(plan.priority));
        for(let i=0;i<4;i++){
            assert.equal(plan.priority[i],api.daedalusPriorityRng(plan.seedStart+i*200));
        }
    }
});

test('IPvGO RNG window planner fails closed on invalid or too-small input',()=>{
    assert.equal(api.findDaedalusDistractionWindow(NaN,10000),null);
    assert.equal(api.findDaedalusDistractionWindow(-1,10000),null);
    assert.equal(api.findDaedalusDistractionWindow(0,-1),null);
    const plan=api.findDaedalusDistractionWindow(0,1000);
    assert.equal(plan,null);
});
