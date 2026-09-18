const test = require('node:test');
const assert = require('node:assert/strict');
const {load, rng, plain} = require('./contract-test-helpers.cjs');
const api = load('contract-solvers.js'), fixtures = load('lib/contract-fixtures.js');
const solve = (type, data) => api.solveContract(type, data).answer;
const cases = fixtures.contractFixtures();
for (const [type, examples] of Object.entries(cases)) test(`contracts: deterministic ${type}`, () => {
    for (const [data, expected] of examples) {
        const before = structuredClone(data), actual = solve(type, data);
        assert.ok(fixtures.fixtureMatches(type, actual, expected), `${type}: ${JSON.stringify(actual)}`);
        assert.deepEqual(structuredClone(data), before, 'solver must not mutate caller input');
    }
});
test('contracts: every supported type has deterministic fixtures; unknown names are inert', () => {
    assert.equal(Object.keys(api.SOLVERS).length, 30);
    assert.deepEqual(Object.keys(api.SOLVERS).sort(), Object.keys(cases).sort());
    assert.equal(api.solveContract('toString', null).supported, false);
    assert.equal(api.solveContract('future-game-type', null).supported, false);
});

test('contracts: Square Root rounds correctly at thousands of large integer boundaries', () => {
    const random = rng();
    for (let i = 0; i < 250; i++) {
        const r = 10n ** BigInt(random(101) + 1) + BigInt(random(1000000));
        for (const [n, expected] of [[r*r-r, r-1n], [r*r-r+1n, r], [r*r+r, r], [r*r+r+1n, r+1n]]) {
            assert.equal(solve('Square Root', n), expected.toString());
        }
    }
    for (let n = 0; n < 1000; n++) assert.equal(solve('Square Root', BigInt(n)), String(Math.round(Math.sqrt(n))));
});

test('contracts: Hamming corrects every single-bit corruption including padded codewords', () => {
    const random = rng();
    for (const n of [0, 1, 8, 21, 2 ** 40 + 1, 2 ** 55, ...Array.from({length:100}, () => random(100000))]) {
        const text = solve('HammingCodes: Integer to Encoded Binary', n);
        assert.equal(solve('HammingCodes: Encoded Binary to Integer', text), n);
        for (let bit = 0; bit < text.length; bit++) {
            const broken = text.slice(0,bit) + (text[bit] === '0' ? '1' : '0') + text.slice(bit+1);
            assert.equal(solve('HammingCodes: Encoded Binary to Integer', broken), n);
        }
    }
    // Independent full 2^m block encoder: data is left-padded, as upstream decode inputs are.
    for (const n of [3, 8, 21, 1000, 2**55]) {
        let m = 1;
        while (2 ** (2 ** m - m - 1) - 1 < n) m++;
        const length = 2**m, digits = n.toString(2).padStart(length-m-1,'0'), bits = Array(length).fill(0);
        for (let i=1,j=0;i<length;i++) if ((i & (i-1)) !== 0) bits[i]=Number(digits[j++]);
        for (let p=1;p<length;p*=2) for(let i=p;i<length;i++) if(i!==p && i&p) bits[p]^=bits[i];
        bits[0]=bits.reduce((a,b)=>a^b,0);
        for(let i=0;i<length;i++) { bits[i]^=1; assert.equal(solve('HammingCodes: Encoded Binary to Integer',bits.join('')),n); bits[i]^=1; }
    }
});

// Independent shortest-encoding oracle: Dijkstra over prefixes and chunk kinds.
function minLzLength(text) {
    const dist = new Map([['0:0',0]]), queue = [[0,0,0]];
    while (queue.length) {
        queue.sort((a,b)=>a[2]-b[2]); const [i,kind,cost] = queue.shift();
        if (dist.get(`${i}:${kind}`)!==cost) continue;
        if(i===text.length) return cost;
        const add = (j,k,w) => {const key=`${j}:${k}`, d=cost+w; if(d<(dist.get(key)??Infinity)){dist.set(key,d);queue.push([j,k,d]);}};
        add(i,1-kind,1);
        for(let n=1;n<=9 && i+n<=text.length;n++) {
            if(kind===0) add(i+n,1,n+1);
            else for(let off=1;off<=9 && off<=i;off++) {
                let ok=true;
                for(let j=0;j<n;j++) if(text[i+j]!==text[i+j-off]) ok=false;
                if(ok) add(i+n,0,2);
            }
        }
    }
}
test('contracts: LZ is globally shortest, not just round-trip valid', () => {
    const random=rng();
    const words=['', 'a'.repeat(40), 'abcdefghijklmnop', 'mississippi'];
    for(let n=0;n<=8;n++) for(let mask=0;mask<2**n;mask++) words.push(mask.toString(2).padStart(n,'0').slice(0,n));
    for(let i=0;i<150;i++) words.push(Array.from({length:random(40)+1},()=> 'aAbB012'[random(7)]).join(''));
    for(const text of words) {
        const encoded=solve('Compression III: LZ Compression', text);
        assert.equal(solve('Compression II: LZ Decompression',encoded),text);
        assert.equal(encoded.length,minLzLength(text),text);
    }
});

test('contracts: rectangle coordinates match exhaustive zero-rectangle search', () => {
    const random=rng();
    for(let sample=0;sample<250;sample++) {
        const rows=random(5)+1,cols=random(5)+1;
        const g=Array.from({length:rows},()=>Array.from({length:cols},()=>random(2)));g[0][0]=0;
        let best=0;
        for(let a=0;a<rows;a++)for(let b=0;b<cols;b++)for(let c=a;c<rows;c++)for(let d=b;d<cols;d++) {
            let ok=true;for(let r=a;r<=c;r++)for(let col=b;col<=d;col++)if(g[r][col])ok=false;
            if(ok) best=Math.max(best,(c-a+1)*(d-b+1));
        }
        const [[a,b],[c,d]]=solve('Largest Rectangle in a Matrix',g);
        assert.equal((c-a+1)*(d-b+1),best);
        for(let r=a;r<=c;r++)for(let col=b;col<=d;col++)assert.equal(g[r][col],0);
    }
});

test('contracts: inclusive prime ranges match independent trial division', () => {
    const random=rng();
    const prime=n=>{if(n<2)return false;for(let p=2;p*p<=n;p++)if(n%p===0)return false;return true;};
    for(let i=0;i<200;i++) {
        const a=random(10000),b=a+random(150);let total=0;for(let n=a;n<=b;n++)total+=Number(prime(n));
        assert.equal(solve('Total Number of Primes',[a,b]),total);
    }
    assert.equal(solve('Total Number of Primes',[0,1000000]),78498);
});

function validParentheses(s) {let b=0;for(const c of s){if(c==='(')b++;if(c===')' && --b<0)return false;}return b===0;}
test('contracts: parentheses return all and only minimally edited solutions', () => {
    const random=rng();
    for(let sample=0;sample<150;sample++) {
        const text=Array.from({length:random(9)},()=> '()a'[random(3)]).join('');
        let best=Infinity;const expected=new Set();
        for(let mask=0;mask<2**text.length;mask++) {
            let value='',removed=0,ok=true;
            for(let i=0;i<text.length;i++) if(mask&(1<<i)){if(text[i]==='a'){ok=false;break;}removed++;}else value+=text[i];
            if(!ok || removed>best || !validParentheses(value))continue;
            if(removed<best){best=removed;expected.clear();}expected.add(value);
        }
        assert.deepEqual([...solve('Sanitize Parentheses in Expression',text)].sort(),[...expected].sort());
    }
});

test('contracts: async solvers yield repeatedly and preserve sync results', async () => {
    for(const [type,data] of [['Find Largest Prime Factor',9999999967],['Find All Valid Math Expressions',['1234567',42]],
        ['Total Number of Primes',[0,10000]],['Compression III: LZ Compression','ab'.repeat(25)]]) {
        let yields=0;const result=await api.solveContractAsync(type,data,async()=>{yields++;});
        assert.deepEqual(plain(result.answer),plain(solve(type,data)));assert.ok(yields>1,type);
    }
});

function evaluateExpression(expression) {
    // Independent parser: sum signed products, without eval or solver bookkeeping.
    const terms = expression.match(/[+-]?[^+-]+/g) || [];
    return terms.reduce((sum,term)=>sum+term.split('*').reduce((product,value)=>product*Number(value),1),0);
}
test('contracts: math expressions match exhaustive operator insertion and reject leading zeros', () => {
    const random=rng();
    for(let trial=0;trial<90;trial++) {
        const digits=Array.from({length:random(5)+1},()=>String(random(5))).join(''),target=random(41)-20;
        const expected=[];
        for(let code=0;code<4**(digits.length-1);code++) {
            let n=code,expression=digits[0];
            for(let j=1;j<digits.length;j++){expression+=['','+','-','*'][n%4]+digits[j];n=Math.floor(n/4);}
            if(expression.split(/[+*-]/).some(n=>n.length>1&&n[0]==='0'))continue;
            if(evaluateExpression(expression)===target)expected.push(expression);
        }
        assert.deepEqual([...solve('Find All Valid Math Expressions',[digits,target])].sort(),expected.sort());
    }
});
test('contracts: legacy arithmetic and jump solvers match small exhaustive oracles', () => {
    const random=rng();
    for(let trial=0;trial<150;trial++) {
        const values=Array.from({length:random(8)+1},()=>random(21)-10);
        let best=-Infinity;
        for(let i=0;i<values.length;i++){let sum=0;for(let j=i;j<values.length;j++){sum+=values[j];best=Math.max(best,sum);}}
        assert.equal(solve('Subarray with Maximum Sum',values),best);
        const jumps=values.map(n=>Math.abs(n)%4),dist=Array(jumps.length).fill(Infinity);dist[0]=0;
        for(let i=0;i<jumps.length;i++)for(let j=i+1;j<=i+jumps[i]&&j<jumps.length;j++)dist[j]=Math.min(dist[j],dist[i]+1);
        assert.equal(solve('Array Jumping Game',jumps),Number(Number.isFinite(dist.at(-1))));
        assert.equal(solve('Array Jumping Game II',jumps),Number.isFinite(dist.at(-1))?dist.at(-1):0);
        const n=random(100000)+2;let remainder=n,largest=1;
        for(let p=2;p<=remainder;p++)while(remainder%p===0){largest=p;remainder/=p;}
        assert.equal(solve('Find Largest Prime Factor',n),largest);
    }
});
test('contracts: all stock variants match brute-force buy/sell schedules', () => {
    const random=rng();
    function profit(prices,k,day=0,holding=false) {
        if(day===prices.length)return holding?-Infinity:0;
        const skip=profit(prices,k,day+1,holding);
        if(holding&&k)return Math.max(skip,prices[day]+profit(prices,k-1,day+1,false));
        if(!holding&&k)return Math.max(skip,-prices[day]+profit(prices,k,day+1,true));
        return skip;
    }
    for(let trial=0;trial<120;trial++) {
        const prices=Array.from({length:random(8)+1},()=>random(20)),k=random(4);
        assert.equal(solve('Algorithmic Stock Trader I',prices),profit(prices,1));
        assert.equal(solve('Algorithmic Stock Trader II',prices),profit(prices,prices.length));
        assert.equal(solve('Algorithmic Stock Trader III',prices),profit(prices,2));
        assert.equal(solve('Algorithmic Stock Trader IV',[k,prices]),profit(prices,k));
    }
});
test('contracts: grid routes are legal and shortest against distance relaxation', () => {
    const random=rng();
    for(let trial=0;trial<150;trial++) {
        const rows=random(5)+1,cols=random(5)+1,g=Array.from({length:rows},()=>Array.from({length:cols},()=>random(4)===0?1:0));
        g[0][0]=0;g[rows-1][cols-1]=0;
        const dist=Array.from({length:rows},()=>Array(cols).fill(Infinity));dist[0][0]=0;
        for(let pass=0;pass<rows*cols;pass++)for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)if(!g[r][c]) {
            for(const [a,b] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]])if(a>=0&&b>=0&&a<rows&&b<cols&&!g[a][b])dist[r][c]=Math.min(dist[r][c],dist[a][b]+1);
        }
        const result=solve('Shortest Path in a Grid',g),min=dist[rows-1][cols-1];
        assert.equal(result.length,Number.isFinite(min)?min:0);
        if(result.length || min===0) {
            let r=0,c=0;for(const m of result){const [dr,dc]={U:[-1,0],D:[1,0],L:[0,-1],R:[0,1]}[m];r+=dr;c+=dc;assert.equal(g[r]?.[c],0);}
            assert.equal(r,rows-1);assert.equal(c,cols-1);
        }
    }
});
