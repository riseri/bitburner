const test=require('node:test');
const assert=require('node:assert/strict');
const {loadGo,plain,referenceMove,mask,seedRandom,areaScore}=require('./go-test-helpers.cjs');
const api=loadGo('lib/go-strategy.js');
const empty=n=>Array(n).fill('.'.repeat(n));
function pieces(list) {const b=empty(5).map(s=>[...s]);for(const [x,y,c] of list)b[x][y]=c;return b.map(s=>s.join(''));}

test('Go coordinates are columns, offline nodes are excluded, and inputs remain unchanged',()=>{
    const b=pieces([[0,1,'#'],[2,3,'X']]),copy=JSON.stringify(b);
    const a=api.analyzeBoard(b);
    assert.equal(a.groups[a.ids[2][3]].liberties.size,4);
    const moved=api.simulateMove(b,3,1);
    assert.equal(moved.board[3][1],'X');assert.equal(moved.board[1][3],'.');
    assert.equal(api.simulateMove(b,0,1),null);assert.equal(JSON.stringify(b),copy);
});
test('Go captures a surrounded enemy and permits capture that opens liberties',()=>{
    const b=pieces([[1,1,'O'],[0,1,'X'],[1,0,'X'],[2,1,'X']]);
    const r=api.simulateMove(b,1,2);
    assert.equal(r.captured,1);assert.equal(r.board[1][1],'.');
    const box=pieces([[0,0,'O'],[0,1,'X'],[2,0,'O'],[1,1,'O']]);
    assert.ok(api.simulateMove(box,1,0));
});
test('Go rejects suicide and occupied cells',()=>{
    const b=pieces([[0,1,'O'],[1,0,'O'],[2,1,'O'],[1,2,'O']]);
    assert.equal(api.simulateMove(b,1,1),null);assert.equal(api.simulateMove(b,0,1),null);
});
test('Go chooses an available tactical capture',async()=>{
    const b=pieces([[1,1,'O'],[0,1,'X'],[1,0,'X'],[2,1,'X']]);
    const r=await api.chooseGoMove(b,mask(b),{now:()=>0});
    assert.deepEqual([r.x,r.y],[1,2]);assert.match(r.reason,/capture/);
});
test('Go saves an atari group rather than opening elsewhere',async()=>{
    const b=pieces([[1,1,'X'],[0,1,'O'],[1,0,'O'],[2,1,'O']]);
    const r=await api.chooseGoMove(b,mask(b),{now:()=>0});
    assert.deepEqual([r.x,r.y],[1,2]);assert.match(r.reason,/save/);
});
test('Go preserves eyes and passes when the only legal moves fill its living group',async()=>{
    const b=['XXXXX','X.X.X','XXXXX','XXXXX','XXXXX'];
    const r=await api.chooseGoMove(b,mask(b),{now:()=>0});
    assert.equal(r.x,null);assert.match(r.reason,/pass/);
});
test('Go obeys the API mask even when local rules would allow a ko capture',async()=>{
    const b=pieces([[1,1,'O'],[0,1,'X'],[1,0,'X'],[2,1,'X']]);
    const legal=mask(b);legal[1][2]=false;
    const r=await api.chooseGoMove(b,legal,{now:()=>0});
    assert.notDeepEqual([r.x,r.y],[1,2]);
    if(r.x!==null)assert.equal(legal[r.x][r.y],true);
});
test('Go passes when no legal points exist',async()=>{
    const r=await api.chooseGoMove(empty(5),Array.from({length:5},()=>Array(5).fill(false)));
    assert.equal(r.x,null);assert.equal(r.considered,0);
});
test('Go bounds CPU work and yields without charging deliberate sleep against budget',async()=>{
    let t=0,yields=0;
    const r=await api.chooseGoMove(empty(13),mask(empty(13)),{thinkMs:2,now:()=>t++,yieldControl:async()=>{yields++;t+=1000;}});
    assert.ok(r.considered>=1);assert.ok(r.cpuMs>=2);assert.ok(yields>=1);assert.equal(r.limited,true);
    const full=await api.chooseGoMove(empty(5),mask(empty(5)),{now:()=>0,yieldControl:async()=>{yields++;}});
    assert.ok(full.considered<=10);assert.ok(full.nodes>0);assert.equal(full.limited,false);
});
test('Go area scoring includes komi and enclosed territory',()=>{
    const b=['XXXXX','X...X','X...X','X...X','XXXXX'];
    const score=api.scoreArea(b,5.5);
    assert.equal(score.black,25);assert.equal(score.white,5.5);assert.equal(score.margin,19.5);
});
test('Go takes a winning pass after the opponent passes instead of reopening the game',async()=>{
    const b=pieces([[0,0,'X'],[0,1,'X'],[1,0,'X'],[1,1,'X'],[2,0,'X'],[2,1,'X'],[3,0,'X'],[3,1,'X'],[4,0,'X'],[4,1,'X'],[4,4,'O']]);
    const r=await api.chooseGoMove(b,mask(b),{now:()=>0,komi:5.5,history:['X'.repeat(25)],opponentPassed:true});
    assert.equal(r.x,null);assert.match(r.reason,/winning by/);
});
test('Go rejects malformed boards and malformed masks',async()=>{
    for(const b of [[],['.'],Array(5).fill('?????'),['.....','.....']])assert.throws(()=>api.analyzeBoard(b));
    await assert.rejects(()=>api.chooseGoMove(empty(5),[]));
});
test('Go tactical model matches independent rules across seeded legal games and sizes',()=>{
    const random=seedRandom(2026);
    for(const n of [5,7,9,13]) {
        let b=empty(n),history=[];
        for(let turn=0;turn<60;turn++) {
            const who=turn%2?'O':'X',legal=mask(b,who,history),moves=[];
            for(let x=0;x<n;x++)for(let y=0;y<n;y++)if(legal[x][y])moves.push([x,y]);
            if(!moves.length)break;
            const [x,y]=moves[Math.floor(random()*moves.length)];
            const expected=referenceMove(b,x,y,who,history),actual=api.simulateMove(b,x,y,who);
            assert.deepEqual(plain(actual.board),expected);history.unshift(b.join(''));b=expected;
        }
    }
});
test('Go completes seeded games against a random legal reference opponent',async()=>{
    const random=seedRandom(5);let wins=0;
    for(let game=0;game<12;game++) {
        let b=empty(5),history=[],passes=0,done=false;
        for(let turn=0;turn<160;turn++) {
            const black=turn%2===0,legal=mask(b,black?'X':'O',history);let move;
            if(black) {const r=await api.chooseGoMove(b,legal,{now:()=>0});move=r.x===null?null:[r.x,r.y];}
            else {
                const options=[];for(let x=0;x<5;x++)for(let y=0;y<5;y++)if(legal[x][y])options.push([x,y]);
                move=options.length?options[Math.floor(random()*options.length)]:null;
            }
            if(!move)passes++;else{const next=referenceMove(b,...move,black?'X':'O',history);assert.ok(next);history.unshift(b.join(''));b=next;passes=0;}
            if(passes===2){done=true;break;}
        }
        assert.ok(done,'game must terminate without reset spam');
        const score=areaScore(b,5.5);if(score.blackScore>=score.whiteScore)wins++;
    }
    console.log(`Reference random opponent only: ${wins}/12 wins; not an in-game Daedalus benchmark`);
    assert.ok(wins>=6,'strategy should beat a random smoke-test baseline');
});
