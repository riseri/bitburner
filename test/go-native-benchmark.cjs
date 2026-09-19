const fs=require('node:fs');
const assert=require('node:assert/strict');
const {loadNative,PIN}=require('./native-go/loader.cjs');
const {loadProduction}=require('./native-go/production.cjs');
function argument(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];}
async function play(native,choose,seed,options={}) {
    const game=native.start(seed,options.size||5),cpu=[];let blackTurns=0,simulations=0;
    const opening=native.simple(game);
    for(let turn=0;turn<game.board.length**2*8;turn++) {
        if(game.previousPlayer===null)break;
        if(game.previousPlayer==='White') {
            const board=native.simple(game),mask=native.mask(game),start=performance.now();
            const result=await choose(board,mask,{...options,komi:native.api.getKomi(game),history:[...game.previousBoards],
                opponentPassed:game.passCount>0,now:options.fixed?()=>0:()=>performance.now()});
            cpu.push(performance.now()-start);blackTurns++;simulations+=result.simulations||0;
            if(result.x===null)native.api.passTurn(game,'Black');
            else if(!native.api.makeMove(game,result.x,result.y,'Black'))throw new Error(`Illegal black move ${result.x},${result.y}`);
        } else {
            const reply=await native.api.getMove(game,'White','Daedalus',false,seed+turn*104729);
            if(reply.type==='pass')native.api.passTurn(game,'White');
            else if(!native.api.makeMove(game,reply.x,reply.y,'White'))throw new Error('Illegal native AI move');
        }
    }
    const score=native.api.getScore(game),margin=score.Black.sum-score.White.sum;
    const record={seed,opening,finished:game.previousPlayer===null,won:margin>=0,black:score.Black.sum,white:score.White.sum,margin,
        blackTurns,simulations,nodePower:native.Go.stats.Daedalus?.nodePower??0,meanCpuMs:cpu.reduce((a,b)=>a+b,0)/cpu.length,maxCpuMs:Math.max(...cpu)};
    return record;
}
async function verifyRules(native,engine) {
    let checked=0;
    for(let match=0;match<8;match++) {
        const game=native.start(913217+match*7879);
        for(let turn=0;turn<32;turn++) {
            const board=native.simple(game),f=engine.fastBoard(board),who=game.previousPlayer==='White'?1:2;
            const history=new Set(game.previousBoards.map(k=>{
                const state=engine.fastBoard(Array.from({length:5},(_,x)=>k.slice(x*5,x*5+5)));return state.b*33554432+state.w;
            }));
            const score=native.api.getScore(game),fast=engine.fastScore(f.b,f.w,f.grid,native.api.getKomi(game));
            assert.equal(fast.black,score.Black.sum);assert.equal(fast.white,score.White.sum);
            const moves=[];
            for(let p=0;p<25;p++) {
                const x=Math.floor(p/5),y=p%5,color=who===1?'Black':'White';
                const valid=native.api.evaluateIfMoveIsValid(game,x,y,color,false)==='Valid move';
                const actual=engine.fastMove(f.b,f.w,f.grid,p,who,history);checked++;
                assert.equal(Boolean(actual),valid,'fast model disagrees with native legality');
                if(!valid)continue;
                const expected=native.simple({board:native.api.evaluateMoveResult(game.board,x,y,color,true)});
                const got=Array.from({length:5},(_,a)=>Array.from({length:5},(_,c)=>{const bit=1<<(a*5+c);return !(f.grid.open&bit)?'#':actual.b&bit?'X':actual.w&bit?'O':'.';}).join(''));
                assert.deepEqual(got,expected);moves.push([x,y]);
            }
            if(!moves.length)break;
            const [x,y]=moves[(match*7+turn*13)%moves.length];
            assert.ok(native.api.makeMove(game,x,y,who===1?'Black':'White'));
        }
    }
    return checked;
}
function summarize(games) {
    return {wins:games.filter(g=>g.won&&g.finished).length,games:games.length,
        unfinished:games.filter(g=>!g.finished).length,
        meanMargin:games.reduce((s,g)=>s+g.margin,0)/games.length,
        meanCpuMsPerTurn:games.reduce((s,g)=>s+g.meanCpuMs,0)/games.length};
}
async function main(){
    const count=Number(argument('--games','40')),seed=Number(argument('--seed','17000003'));
    if(!Number.isSafeInteger(count)||count<1||count>200||!Number.isSafeInteger(seed)||seed<1)throw new Error('Invalid benchmark count/seed');
    const native=await loadNative(argument('--upstream','native-upstream'));
    const legacy=await loadProduction('lib/go-strategy.js'),search=await loadProduction('lib/go-search.js');
    const checked=await verifyRules(native,search);
    const mode=process.argv.includes('--capped')?'cpu-capped':'fixed-work';
    const result={schema:1,upstream:PIN,mode,seed,count,simulationLimit:2400,cpuBudgetMs:250,
        nativeRuleComparisons:checked,shims:native.shims,sourceHashes:native.hashes,
        note:'Native Go rules, obstacle generation, Daedalus policy and scoring. Timer sleeps removed; no UI, player progression or real in-game timing. Each match starts with fresh opponent statistics.',
        baseline:[],search:[]};
    const output=argument('--output','go-benchmark.json');
    for(let i=0;i<count;i++) {
        const gameSeed=seed+i*7919;
        const a=await play(native,legacy.chooseGoMove,gameSeed,{thinkMs:15,fixed:mode==='fixed-work'});
        const b=await play(native,search.chooseSearchMove,gameSeed,{thinkMs:250,simulations:2400,fixed:mode==='fixed-work'});
        assert.deepEqual(a.opening,b.opening,'paired layouts differ');
        assert.ok(a.finished&&b.finished,'a game hit its safety turn cap');
        result.baseline.push(a);result.search.push(b);
        result.summary={baseline:summarize(result.baseline),search:summarize(result.search)};
        fs.writeFileSync(output,JSON.stringify(result,null,2));
        console.log(`${i+1}/${count}: baseline ${a.won?'W':'L'} (${a.margin}), search ${b.won?'W':'L'} (${b.margin}); total ${result.summary.baseline.wins}:${result.summary.search.wins}`);
    }
    console.log(result.summary);
    // Deterministic regression gate, not a claimed native live-game win rate.
    if(mode==='fixed-work'&&seed===17000003&&count===40)assert.ok(result.summary.search.wins>=result.summary.baseline.wins+4,'search must materially beat the old policy on the locked seed set');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={play,verifyRules,summarize};
