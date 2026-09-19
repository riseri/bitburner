const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function loadGo(file = 'go-bot.js', extra = {}) {
    const sandbox = { console, Date, ...extra };
    vm.createContext(sandbox);
    let all = '';
    for (const item of ['lib/go-strategy.js', 'lib/go-search.js', 'lib/go-session.js', 'go-bot.js']) {
        all += fs.readFileSync(path.join(root, 'src', item), 'utf8')
            .replace(/^import .*;\s*$/gm, '').replace(/\bexport (?=(?:async )?function|const )/g, '') + '\n';
        if (file === item) break;
    }
    const names = [...all.matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map(m => m[1]);
    new vm.Script(all + `\n;globalThis.api={${names.join(',')}}`).runInContext(sandbox);
    return sandbox.api;
}
const plain = value => JSON.parse(JSON.stringify(value));

// Independent row-major reference rules: not the production tactical evaluator.
function referenceMove(columns, x, y, color, history = []) {
    const n = columns.length, rows = Array.from({length:n}, (_,r)=>Array.from({length:n}, (_,c)=>columns[c][r]));
    if (rows[y]?.[x] !== '.') return null;
    rows[y][x] = color;
    const adjacent = (r,c) => [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].filter(([a,b])=>rows[a]?.[b] !== undefined && rows[a][b] !== '#');
    function components(who) {
        const seen = new Set(), result = [];
        for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(rows[r][c]===who && !seen.has(r*n+c)) {
            const todo = [[r,c]], points = [], liberties = new Set(); seen.add(r*n+c);
            while(todo.length) {
                const [a,b]=todo.pop(); points.push([a,b]);
                for(const [i,j] of adjacent(a,b)) {
                    if(rows[i][j]==='.') liberties.add(i*n+j);
                    if(rows[i][j]===who && !seen.has(i*n+j)) {seen.add(i*n+j);todo.push([i,j]);}
                }
            }
            result.push({points,liberties});
        }
        return result;
    }
    for(const group of components(color==='X'?'O':'X')) if(!group.liberties.size) {
        for(const [r,c] of group.points) rows[r][c]='.';
    }
    if(components(color).some(g=>!g.liberties.size)) return null;
    const after=Array.from({length:n},(_,c)=>rows.map(row=>row[c]).join(''));
    return history.includes(after.join('')) ? null : after;
}
function mask(board, color='X', history=[]) {
    return board.map((column,x)=>[...column].map((_,y)=>Boolean(referenceMove(board,x,y,color,history))));
}
function seedRandom(seed=1) {
    return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
}
function areaScore(board, komi=0) {
    const n=board.length, visited=new Set(); let black=0,white=komi;
    for(let x=0;x<n;x++) for(let y=0;y<n;y++) {
        if(board[x][y]==='X') black++;
        if(board[x][y]==='O') white++;
        if(board[x][y]!=='.'||visited.has(x*n+y)) continue;
        const queue=[[x,y]],border=new Set();visited.add(x*n+y);
        for(let h=0;h<queue.length;h++) {
            const [a,b]=queue[h];
            for(const [i,j] of [[a-1,b],[a+1,b],[a,b-1],[a,b+1]]) {
                const v=board[i]?.[j];
                if(v==='.'&&!visited.has(i*n+j)){visited.add(i*n+j);queue.push([i,j]);}
                if(v==='X'||v==='O')border.add(v);
            }
        }
        if(border.size===1&&queue.length<=n*n-3) {
            if(border.has('X'))black+=queue.length;else white+=queue.length;
        }
    }
    return {blackScore:black,whiteScore:white};
}
module.exports={loadGo,plain,referenceMove,mask,seedRandom,areaScore};
