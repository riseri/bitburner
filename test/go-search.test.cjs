const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGo, plain, referenceMove, mask, seedRandom } = require('./go-test-helpers.cjs');
const search = loadGo('lib/go-search.js');
const empty = () => Array(5).fill('.....');
const columns = (b,w,open) => Array.from({length:5},(_,x)=>Array.from({length:5},(_,y)=>{
    const bit=1<<(x*5+y);return !(open&bit)?'#':b&bit?'X':w&bit?'O':'.';
}).join(''));
const stateKey = (b,w) => b*33554432+w;

// An independent flood-fill reference validates the optimized bitboard backend.
test('IPvGO search: masks match reference capture, suicide, obstacles and superko across legal games',()=>{
    const random=seedRandom(137);let checked=0;
    for(let game=0;game<40;game++) {
        let board=empty().map(c=>[...c].map(()=>random()<.14?'#':'.').join('')),history=[];
        for(let turn=0;turn<40;turn++) {
            const {b,w,grid}=search.fastBoard(board),color=turn%2?'O':'X',who=turn%2?2:1;
            const prior=new Set(history.map(k=>{const f=search.fastBoard(Array.from({length:5},(_,x)=>k.slice(x*5,x*5+5)));return stateKey(f.b,f.w);}));
            const legal=[];
            for(let p=0;p<25;p++){
                const x=Math.floor(p/5),y=p%5,expected=referenceMove(board,x,y,color,history),actual=search.fastMove(b,w,grid,p,who,prior);checked++;
                assert.equal(Boolean(actual),Boolean(expected),`seeded game ${game}, turn ${turn}, move ${x},${y}`);
                if(actual){assert.deepEqual(columns(actual.b,actual.w,grid.open),expected);legal.push(expected);}
            }
            if(!legal.length)break;
            history.unshift(board.join(''));board=legal[Math.floor(random()*legal.length)];
        }
    }
    assert.ok(checked>10000);
});
test('IPvGO search: native tiny-opening scoring exception and komi are explicit',()=>{
    assert.equal(search.scoreGoPosition(empty(),5.5).margin,-5.5);
    assert.equal(search.scoreGoPosition(['X....','.....','.....','.....','.....'],5.5).black,1);
    assert.equal(search.scoreGoPosition(['XXX..','.....','.....','.....','.....'],5.5).black,25);
    const b=['##.#.','.XXOO','.XOO.','#XXO.','##.##'];
    assert.deepEqual(plain(search.scoreGoPosition(b,5.5)),{black:9,white:13.5,margin:-4.5});
    assert.equal(search.scoreGoPosition(b,.5).margin,.5);
});
test('IPvGO search: accepts a winning opponent pass without pointless eye filling',async()=>{
    const b=['XXXXX','X.X.X','XXXXX','XXXXX','XXXXX'];
    const r=await search.chooseSearchMove(b,mask(b),{komi:5.5,opponentPassed:true});
    assert.equal(r.x,null);assert.equal(r.simulations,0);assert.match(r.reason,/winning/);
});
test('IPvGO search: high komi does not get misclassified as a winning pass',async()=>{
    const b=['XX...','X....','..O..','.....','.....'];
    const r=await search.chooseSearchMove(b,mask(b),{komi:50,opponentPassed:true,simulations:32,now:()=>0});
    assert.ok(r.simulations>0);assert.ok(r.scoreMargin<0);assert.doesNotMatch(r.reason,/winning final score/);
});
test('IPvGO search: no legal move means no simulation and no mutation',async()=>{
    const b=empty(),before=JSON.stringify(b),r=await search.chooseSearchMove(b,Array.from({length:5},()=>Array(5).fill(false)));
    assert.equal(r.x,null);assert.equal(r.considered,0);assert.equal(r.simulations,0);assert.equal(JSON.stringify(b),before);
});
test('IPvGO search: fresh API mask wins over local simulations',async()=>{
    const b=empty(),valid=Array.from({length:5},()=>Array(5).fill(false));valid[3][1]=true;
    const r=await search.chooseSearchMove(b,valid,{simulations:100,now:()=>0});
    assert.ok(r.x===null||(r.x===3&&r.y===1));
});
test('IPvGO search: fixed work quota is deterministic and still yields with a frozen clock',async()=>{
    const b=empty(),legal=mask(b);let yields=0;
    const options={simulations:96,now:()=>0,seed:4242,yieldControl:async()=>{yields++;}};
    const a=await search.chooseSearchMove(b,legal,options),c=await search.chooseSearchMove(b,legal,options);
    assert.deepEqual(plain(a),plain(c));assert.equal(a.simulations,96);assert.ok(yields>0);
    assert.ok(a.rolloutMoves<=96*100);assert.ok(a.replies<=26);
});
test('IPvGO search: CPU budget excludes intentional yield delay',async()=>{
    let clock=0,yields=0;
    const r=await search.chooseSearchMove(empty(),mask(empty()),{simulations:100,thinkMs:5,now:()=>clock++,yieldControl:async()=>{clock+=10000;yields++;}});
    assert.ok(yields>0);assert.ok(r.cpuMs<30);assert.ok(r.cpuMs>=5);assert.equal(r.limited,true);assert.ok(r.simulations<100);
});
test('IPvGO search: larger boards retain the labeled bounded heuristic',async()=>{
    const board=Array(7).fill('.......'),valid=Array.from({length:7},()=>Array(7).fill(false));
    const r=await search.chooseSearchMove(board,valid,{komi:7.5});
    assert.equal(r.algorithm,'tactical-large-board');assert.equal(r.simulations,0);assert.equal(r.scoreMargin,-7.5);
});
test('IPvGO search: malformed options fail before searching',async()=>{
    for(const options of [{komi:NaN},{simulations:0},{simulations:1.5},{thinkMs:NaN},{thinkMs:0},{history:{}},{history:['bad']}]) {
        await assert.rejects(()=>search.chooseSearchMove(empty(),mask(empty()),options));
    }
    const {b,w,grid}=search.fastBoard(empty());assert.equal(search.fastMove(b,w,grid,0,3),null);
});
test('IPvGO search: historical repeated result is forbidden even if root mask lies',async()=>{
    const board=['.....','.....','.....','.....','.....'],after=['X....','.....','.....','.....','.....'];
    const legal=Array.from({length:5},()=>Array(5).fill(false));legal[0][0]=true;
    const r=await search.chooseSearchMove(board,legal,{history:[after.join('')],simulations:10,now:()=>0});assert.equal(r.x,null);
});
