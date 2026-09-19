const test=require('node:test');
const assert=require('node:assert/strict');
const {loadGo,mask,seedRandom,areaScore}=require('./go-test-helpers.cjs');
const api=loadGo('lib/go-strategy.js');
const empty=n=>Array(n).fill('.'.repeat(n));

function neighbors(board,x,y){
    return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
        .filter(([a,b])=>board[a]?.[b]!==undefined&&board[a][b]!=='#');
}
function simpleEye(board,x,y,color){
    if(board[x]?.[y]!=='.')return false;
    const around=neighbors(board,x,y);
    if(!around.length||around.some(([a,b])=>board[a][b]!==color))return false;
    const enemy=color==='X'?'O':'X',n=board.length;
    const diag=[[x-1,y-1],[x+1,y-1],[x-1,y+1],[x+1,y+1]];
    const edge=diag.some(([a,b])=>board[a]?.[b]===undefined||board[a][b]==='#');
    const bad=diag.filter(([a,b])=>board[a]?.[b]===enemy).length;
    return bad<=(edge?0:1);
}
function legalMoves(board,color,history){
    const out=[];
    for(let x=0;x<board.length;x++)for(let y=0;y<board.length;y++){
        const r=api.simulateMove(board,x,y,color);
        if(r&&!history.includes(r.board.join('')))out.push({x,y,r});
    }
    return out;
}
/*
 * Deliberately independent policy shaped around current Daedalus priorities:
 * captures, atari defense, eye creation/blocking, pressure, corners, expansion.
 * It is NOT copied native AI and is NOT an in-game win-rate claim.
 */
function daedalusShapedMove(board,history,random){
    const moves=legalMoves(board,'O',history);
    if(!moves.length)return null;
    const captures=moves.filter(m=>m.r.captured>0);
    if(captures.length){
        const best=Math.max(...captures.map(m=>m.r.captured));
        const options=captures.filter(m=>m.r.captured===best);
        return options[Math.floor(random()*options.length)];
    }
    const before=api.analyzeBoard(board),saves=[];
    for(const move of moves){
        const ids=[...new Set(neighbors(board,move.x,move.y).map(([a,b])=>before.ids[a][b]))];
        const saved=ids.map(id=>before.groups[id])
            .filter(g=>g.color==='O'&&g.liberties.size===1&&move.r.own.liberties.size>1)
            .reduce((sum,g)=>sum+g.points.length,0);
        if(saved)saves.push({...move,saved});
    }
    if(saves.length){
        const best=Math.max(...saves.map(m=>m.saved));
        const options=saves.filter(m=>m.saved===best);
        return options[Math.floor(random()*options.length)];
    }
    let currentBlackEyes=0;
    for(let x=0;x<board.length;x++)for(let y=0;y<board.length;y++)if(simpleEye(board,x,y,'X'))currentBlackEyes++;
    const ranked=moves.map(move=>{
        const next=move.r.board,analysis=api.analyzeBoard(next);
        let whiteEyes=0,blackEyes=0,pressure=0;
        for(let x=0;x<next.length;x++)for(let y=0;y<next.length;y++){
            if(simpleEye(next,x,y,'O'))whiteEyes++;
            if(simpleEye(next,x,y,'X'))blackEyes++;
        }
        for(const group of analysis.groups)if(group.color==='X'&&group.liberties.size===1)pressure+=4+group.points.length;
        const edge=Math.min(move.x,move.y,next.length-1-move.x,next.length-1-move.y);
        const corner=edge===1?3:0;
        const territory=-api.scoreArea(next,5.5).margin;
        return {...move,score:12*whiteEyes+9*(currentBlackEyes-blackEyes)+5*pressure+corner+territory};
    }).sort((a,b)=>b.score-a.score||a.x-b.x||a.y-b.y);
    const width=random()<0.9?3:Math.min(8,ranked.length);
    return ranked[Math.floor(random()*Math.min(width,ranked.length))];
}
async function play(seed,holes){
    const random=seedRandom(seed),n=5,columns=empty(n).map(s=>[...s]);
    if(holes){
        const count=Math.floor(random()*5);
        for(let i=0;i<count;i++)columns[Math.floor(random()*n)][Math.floor(random()*n)]='#';
    }
    let board=columns.map(c=>c.join('')),history=[],passes=0;
    for(let turn=0;turn<100;turn++){
        if(turn%2===0){
            const valid=mask(board,'X',history);
            const action=await api.chooseGoMove(board,valid,{thinkMs:35,now:()=>0,komi:5.5,history,opponentPassed:passes===1});
            if(action.x===null)passes++;
            else{
                const next=api.simulateMove(board,action.x,action.y,'X');
                assert.ok(next);history.unshift(board.join(''));board=next.board;passes=0;
            }
        }else{
            const move=daedalusShapedMove(board,history,random);
            if(!move)passes++;
            else{history.unshift(board.join(''));board=move.r.board;passes=0;}
        }
        if(passes>=2)break;
    }
    const score=areaScore(board,5.5);
    return {win:score.blackScore>=score.whiteScore,margin:score.blackScore-score.whiteScore};
}

test('IPvGO search dominates the deterministic Daedalus-shaped 5x5 benchmark',async()=>{
    const results=[];
    for(let game=0;game<12;game++)results.push(await play(9000+game,game%2===1));
    const wins=results.filter(r=>r.win).length;
    const average=results.reduce((sum,r)=>sum+r.margin,0)/results.length;
    console.log(`Daedalus-shaped benchmark: ${wins}/${results.length} wins, ${average.toFixed(2)} avg margin; not native AI`);
    assert.ok(wins>=9,`expected at least 9/12 wins, got ${wins}`);
    assert.ok(average>2,`expected positive average margin, got ${average}`);
});
