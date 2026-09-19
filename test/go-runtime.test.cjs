const test=require('node:test');
const assert=require('node:assert/strict');
const {loadGo,plain,referenceMove,mask,areaScore,seedRandom}=require('./go-test-helpers.cjs');
const api=loadGo();
const empty=n=>Array(n).fill('.'.repeat(n));

function fixture(flags={}) {
    const files=new Map(),logs=[],terminal=[],calls=[],random=seedRandom(20);
    const world={board:empty(5),opponent:'Netburners',history:[],currentPlayer:'Black',previousMove:null,
        passes:0,blackTurns:0,wins:0,losses:0,reset:{currentNode:1,lastNodeReset:100,lastAugReset:200}};
    let writes=0,sleeps=0;
    function play(color,x=null,y=null) {
        if(x===null) {
            world.passes++;world.previousMove=null;
        } else {
            const next=referenceMove(world.board,x,y,color,world.history);
            assert.ok(next,`reference rejects ${color} ${x},${y}`);
            world.history.unshift(world.board.join(''));world.board=next;world.passes=0;world.previousMove=[x,y];
        }
        world.currentPlayer=world.passes>=2?'None':color==='X'?'White':'Black';
        if(world.currentPlayer==='None') {
            const s=areaScore(world.board,5.5);if(s.blackScore>=s.whiteScore)world.wins++;else world.losses++;
        }
    }
    function white() {
        if(world.currentPlayer==='None')return {type:'gameOver',x:null,y:null};
        const valid=mask(world.board,'O',world.history),options=[];
        for(let x=0;x<world.board.length;x++)for(let y=0;y<world.board.length;y++)if(valid[x][y])options.push([x,y]);
        if(!options.length||world.blackTurns>45) {
            play('O');return {type:world.currentPlayer==='None'?'gameOver':'pass',x:null,y:null};
        }
        const [x,y]=options[Math.floor(random()*options.length)];play('O',x,y);return {type:'move',x,y};
    }
    async function action(x=null,y=null) {
        assert.equal(world.currentPlayer,'Black');world.blackTurns++;calls.push(x===null?'pass':'move');
        play('X',x,y);if(world.currentPlayer==='None')return {type:'gameOver',x:null,y:null};
        if(f.onAction)await f.onAction();
        return white();
    }
    const ns={pid:42,getHostname:()=> 'home',getScriptName:()=> 'go-bot.js',
        flags:pairs=>({...Object.fromEntries(pairs),games:1,...flags}),disableLog(){},
        ps:()=>[{pid:42,filename:'go-bot.js'},{pid:9,filename:'daemon.js'}],
        read:p=>files.get(p)||'',write:async(p,text)=>{files.set(p,text);writes++;if(f.onWrite)await f.onWrite(writes);},
        sleep:async ms=>{if(++sleeps>10000)throw new Error('test runaway');if(f.onSleep)await f.onSleep(ms,sleeps);},
        clearLog:()=>{logs.length=0;},print:s=>logs.push(s),tprint:s=>terminal.push(s),
        getResetInfo:()=>({...world.reset}),getPlayer:()=>({factions:['The Black Hand']}),
        go:{getBoardState:()=>[...world.board],getOpponent:()=>world.opponent,
            getMoveHistory:()=>world.history.map(s=>Array.from({length:world.board.length},(_,i)=>s.slice(i*world.board.length,(i+1)*world.board.length))),
            getGameState:()=>({...areaScore(world.board,5.5),currentPlayer:world.currentPlayer,
                previousMove:world.previousMove,komi:5.5,bonusCycles:0}),
            resetBoardState:(opponent,n)=>{calls.push('reset');world.board=empty(n);world.opponent=opponent;
                world.history=[];world.currentPlayer='Black';world.previousMove=null;world.passes=0;world.blackTurns=0;return world.board;},
            makeMove:action,passTurn:()=>action(),opponentNextTurn:async()=>{calls.push('wait');return white();},
            analysis:{getValidMoves:()=>mask(world.board,'X',world.history),getStats:()=>({[world.opponent]:{
                wins:world.wins,losses:world.losses,winStreak:world.wins-world.losses,
                bonusPercent:1.234,bonusDescription:'faction and company reputation',rep:0}})}}};
    const f={ns,world,files,logs,terminal,calls,play,white,onWrite:null,onSleep:null,onAction:null};
    return f;
}

test('IPvGO default run completes a Daedalus game and leaves the final board intact',async()=>{
    const f=fixture();await api.main(f.ns);
    assert.deepEqual(f.terminal,[]);assert.equal(f.world.currentPlayer,'None');
    assert.equal(f.calls.filter(v=>v==='reset').length,1);
    assert.match(f.logs.join('\n'),/GAME COMPLETE/);assert.match(f.logs.join('\n'),/1 games/);
    assert.match(f.logs.join('\n'),/Actual bonus\s+\+1.234%/);
    assert.match(f.logs.join('\n'),/Not joined/);
    assert.equal(JSON.parse(f.files.get('go-bot-state.txt')).phase,'complete');
});
test('IPvGO repeat mode resets only after verified completion',async()=>{
    const f=fixture({games:2});let resets=0;
    const reset=f.ns.go.resetBoardState;f.ns.go.resetBoardState=(...args)=>{
        if(resets++)assert.equal(f.world.currentPlayer,'None');return reset(...args);
    };
    await api.main(f.ns);assert.deepEqual(f.terminal,[]);assert.equal(resets,2);
    assert.match(f.logs.join('\n'),/2 games/);
});
test('IPvGO refuses an unowned manual game by default',async()=>{
    const f=fixture();f.play('X',2,2);f.white();const board=[...f.world.board];
    await api.main(f.ns);assert.deepEqual(f.calls,[]);assert.deepEqual(f.world.board,board);
    assert.match(f.terminal[0],/takeover/);assert.equal(f.files.size,0);
});
test('IPvGO explicit takeover finishes the existing opponent rather than resetting it',async()=>{
    const f=fixture({takeover:true});f.play('X',2,2);f.white();
    await api.main(f.ns);assert.deepEqual(f.terminal,[]);assert.ok(!f.calls.includes('reset'));
    assert.equal(f.world.opponent,'Netburners');assert.equal(f.world.currentPlayer,'None');
});
test('IPvGO resumes an exact recorded idle position without takeover',async()=>{
    const f=fixture();f.play('X',2,2);f.white();
    await api.saveGoRecord(f.ns,api.readGoSnapshot(f.ns),'ready');
    await api.main(f.ns);assert.deepEqual(f.terminal,[]);assert.ok(!f.calls.includes('reset'));
});
test('IPvGO interrupted requests do not authorize silent replay',async()=>{
    const f=fixture();f.play('X',2,2);f.white();
    await api.saveGoRecord(f.ns,api.readGoSnapshot(f.ns),'pending');
    await api.main(f.ns);assert.deepEqual(f.calls,[]);assert.match(f.terminal[0],/interrupted/);
});
test('IPvGO records from a previous augmentation reset do not authorize takeover',async()=>{
    const f=fixture();f.play('X',2,2);f.white();await api.saveGoRecord(f.ns,api.readGoSnapshot(f.ns),'ready');
    f.world.reset.lastAugReset++;await api.main(f.ns);assert.deepEqual(f.calls,[]);assert.match(f.terminal[0],/Unowned/);
});
test('IPvGO waits rather than making a black move on the white turn',async()=>{
    const f=fixture({takeover:true});f.play('X',2,2);await api.main(f.ns);
    assert.equal(f.calls[0],'wait');assert.deepEqual(f.terminal,[]);
});
test('IPvGO accepts a legitimate white reply that completes during a state write',async()=>{
    const f=fixture({takeover:true});f.play('X',2,2);
    f.onWrite=async()=>{f.onWrite=null;f.white();};
    await api.main(f.ns);assert.deepEqual(f.terminal,[]);assert.ok(!f.calls.includes('wait'));
});
for(const event of ['move','reset','epoch'])test(`IPvGO stops on external ${event} during move analysis`,async()=>{
    const f=fixture();let changed=false;
    f.onSleep=async ms=>{if(ms!==5||changed)return;changed=true;
        if(event==='move'){const [x,y]=[0,0];f.play('X',x,y);f.white();}
        if(event==='reset'){f.ns.go.resetBoardState('The Black Hand',5);}
        if(event==='epoch')f.world.reset.lastAugReset++;
    };
    await api.main(f.ns);assert.ok(changed);assert.match(f.terminal[0],/outside this bot/);
    assert.ok(!f.calls.includes('move'));assert.ok(!f.calls.includes('pass'));
});
test('IPvGO detects an unexpected reset while awaiting an AI reply',async()=>{
    const f=fixture();f.onAction=async()=>{f.world.opponent='The Black Hand';};
    await api.main(f.ns);assert.match(f.terminal[0],/Unexpected Go transition/);
    assert.equal(f.calls.filter(c=>c==='move').length,1);assert.equal(f.calls.filter(c=>c==='reset').length,1);
    assert.equal(JSON.parse(f.files.get('go-bot-state.txt')).phase,'pending');
});
test('IPvGO validates the live legality mask again immediately before committing a move',async()=>{
    const f=fixture();let checks=0;const valid=f.ns.go.analysis.getValidMoves;
    f.ns.go.analysis.getValidMoves=()=>++checks===1?valid():Array.from({length:5},()=>Array(5).fill(false));
    await api.main(f.ns);assert.match(f.terminal[0],/no longer legal/);assert.ok(!f.calls.includes('move'));
});
test('IPvGO does not play if persisting the pending move fails',async()=>{
    const f=fixture();f.onWrite=async()=>{const r=JSON.parse(f.files.get('go-bot-state.txt'));
        if(r.action)f.files.delete('go-bot-state.txt');};
    await api.main(f.ns);assert.match(f.terminal[0],/persistence failed/);assert.ok(!f.calls.includes('move'));
});
test('IPvGO move API exceptions stop once without retry or destructive reset',async()=>{
    const f=fixture();f.ns.go.makeMove=async()=>{f.calls.push('broken');throw new Error('API unavailable');};
    await api.main(f.ns);assert.equal(f.calls.filter(c=>c==='broken').length,1);
    assert.equal(f.terminal.length,1);assert.match(f.terminal[0],/API unavailable/);
    assert.equal(JSON.parse(f.files.get('go-bot-state.txt')).phase,'pending');
});
for(const flags of [{opponent:'w0r1d_d43m0n'},{opponent:'No AI'},{size:19},{games:-1},{interval:0},{'think-ms':NaN}]) {
    test(`IPvGO invalid configuration fails before any Go mutations ${JSON.stringify(flags)}`,async()=>{
        const f=fixture(flags);await api.main(f.ns);assert.equal(f.terminal.length,1);assert.deepEqual(f.calls,[]);
    });
}
test('IPvGO duplicate or remote processes exit without mutations',async()=>{
    for(const kind of ['duplicate','remote']) {
        const f=fixture();if(kind==='duplicate')f.ns.ps=()=>[{filename:'go-bot.js',pid:7}];else f.ns.getHostname=()=> 'cloud-00';
        await api.main(f.ns);assert.equal(f.terminal.length,1);assert.deepEqual(f.calls,[]);
    }
});
test('IPvGO corrupt records are not silently discarded even with takeover enabled',async()=>{
    const f=fixture({takeover:true});f.files.set('go-bot-state.txt','{"broken');
    await api.main(f.ns);assert.match(f.terminal[0],/Corrupt/);assert.deepEqual(f.calls,[]);
});
test('IPvGO does not take over No AI even when explicitly requested',async()=>{
    const f=fixture({takeover:true});f.play('X',2,2);f.world.opponent='No AI';
    await api.main(f.ns);assert.deepEqual(f.calls,[]);assert.match(f.terminal[0],/No AI/);
});
test('IPvGO verifies full history, not only the visible board',()=>{
    const f=fixture(),before=api.readGoSnapshot(f.ns);
    f.play('X',2,2);const reply=f.white(),after=api.readGoSnapshot(f.ns);
    assert.equal(api.verifyGoReply(before,{x:2,y:2},reply,after),true);
    const changed=plain(after);changed.history.push('X'.repeat(25));
    assert.equal(api.verifyGoReply(before,{x:2,y:2},reply,changed),false);
});
test('IPvGO runtime contains no scheduler, cheat, reset-stats, or testing-board mutations',()=>{
    const fs=require('node:fs'),path=require('node:path');
    const sources=['go-bot.js','lib/go-session.js','lib/go-strategy.js'].map(p=>fs.readFileSync(path.join(__dirname,'../src',p),'utf8')).join('\n');
    for(const re of [/ns\.singularity/,/ns\.go\.cheat/,/ns\.(kill|scriptKill|killall|exec|run|getPortHandle)\s*\(/,/setTestingBoardState\s*\(/,/resetStats\s*\(/,/\b(document|window)\b/])assert.doesNotMatch(sources,re);
});

test('IPvGO manual changes during pending-write persistence prevent the next move',async()=>{
    const f=fixture();f.onWrite=async()=>{
        const record=JSON.parse(f.files.get('go-bot-state.txt'));
        if(record.action){f.world.reset.lastAugReset++;f.onWrite=null;}
    };
    await api.main(f.ns);assert.match(f.terminal[0],/outside this bot/);assert.ok(!f.calls.includes('move'));
});
test('IPvGO changing only history while thinking still invalidates ownership',async()=>{
    const f=fixture();f.onSleep=async ms=>{if(ms===5){f.world.history.push(f.world.board.join(''));f.onSleep=null;}};
    await api.main(f.ns);assert.match(f.terminal[0],/outside this bot/);assert.ok(!f.calls.includes('move'));
});
test('IPvGO a slow opponent is awaited once with no heartbeat-triggered restart',async()=>{
    const f=fixture();let release,entered;
    const reached=new Promise(resolve=>entered=resolve);
    f.onAction=async()=>{f.onAction=null;entered();await new Promise(resolve=>release=resolve);};
    const running=api.main(f.ns);await reached;
    const actions=f.calls.length;for(let i=0;i<100;i++)await Promise.resolve();
    assert.equal(f.calls.length,actions);assert.equal(f.world.currentPlayer,'White');
    assert.equal(JSON.parse(f.files.get('go-bot-state.txt')).phase,'pending');
    release();await running;assert.deepEqual(f.terminal,[]);
});
test('IPvGO completed boards are not counted a second time when a new run starts',async()=>{
    const f=fixture();f.play('X');f.play('O');
    await api.main(f.ns);assert.deepEqual(f.terminal,[]);assert.equal(f.calls.filter(c=>c==='reset').length,1);
    assert.match(f.logs.join('\n'),/1 games/);
});
test('IPvGO an invalid observed reply cannot cause another move',async()=>{
    const f=fixture();f.ns.go.makeMove=async()=>({type:'surprise',x:null,y:null});
    await api.main(f.ns);assert.match(f.terminal[0],/Unexpected Go transition/);assert.equal(f.terminal.length,1);
});
test('IPvGO a passed manual turn is not mistaken for an untouched opening',()=>{
    const f=fixture();f.play('X');
    assert.throws(()=>api.mayStartGo(api.readGoSnapshot(f.ns),null,false),/Unowned/);
});
test('IPvGO arms a Daedalus distraction window before committing moves',async()=>{
    const f=fixture();let playtime=0;
    const getPlayer=f.ns.getPlayer,baseSleep=f.ns.sleep;
    f.ns.getPlayer=()=>({...getPlayer(),totalPlaytime:playtime});
    f.ns.sleep=async ms=>{if(ms>=200)playtime+=Math.floor(ms/200)*200;return baseSleep(ms);};
    await api.main(f.ns);
    assert.deepEqual(f.terminal,[]);
    const log=f.logs.join('\n');
    assert.match(log,/RNG rig\s+\d+\/\d+ armed/);
    assert.match(log,/Daedalus RNG\s+0\.9/);
});

test('IPvGO validates every requested ordinary board size with a mocked complete game',async()=>{
    for(const size of [7,9,13]) {
        const f=fixture({size});await api.main(f.ns);
        assert.deepEqual(f.terminal,[],`size ${size}`);assert.equal(f.world.currentPlayer,'None');
    }
});
