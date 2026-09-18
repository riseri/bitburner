const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {load, plain, root} = require('./contract-test-helpers.cjs');

function fixture() {
    let now = 1000000, serial = 0;
    const files = new Map([['contract-solvers.js',fs.readFileSync(path.join(root,'src/contract-solvers.js'),'utf8')]]);
    const contracts = new Map(), attempts = [], removed = [], writes = [], printed = [];
    const globals = {Date: class extends Date {static now(){return now;}}};
    const safety = load('lib/contract-safety.js',globals), manager=load('contract-manager.js',globals), tester=load('contract-selftest.js',globals);
    const ns = {pid:55,getHostname:()=> 'home',ps:()=>[],disableLog(){},clearLog(){},print:s=>printed.push(s),tprint:s=>printed.push(s),
        flags:pairs=>({...Object.fromEntries(pairs)}),fileExists:file=>files.has(file),read:file=>files.get(file)||'',
        write:async(file,text)=>{writes.push(file);files.set(file,text);},ls:(host)=>[...contracts.values()].filter(c=>c.host===host).map(c=>c.file),
        rm:(file,host)=>{removed.push([host,file]);return contracts.delete(`${host}/${file}`);},
        sleep:async()=>{now+=1;},
        codingcontract:{
            getContractType:(f,h)=>get(f,h).type,
            getData:(f,h)=>structuredClone(get(f,h).data),
            getNumTriesRemaining:(f,h)=>get(f,h).tries,
            attempt:(answer,file,host)=>{
                const c=get(file,host);attempts.push({host,file,answer});
                assert.ok(c.dummy || files.has(safety.contractFiles().receipts),'intent persisted before real submission');
                if(c.error)throw new Error(c.error);
                if(c.good!==false){contracts.delete(`${host}/${file}`);return c.dummy?'No reward for this contract':'Gained $5m';}
                if(--c.tries===0)contracts.delete(`${host}/${file}`);return '';
            },
            getContractTypes:()=>['Find Largest Prime Factor'],
            createDummyContract:type=>{const file=`dummy-${++serial}.cct`;add(file,{type,data:21,dummy:true});return file;},
        },
    };
    function get(file,host){const value=contracts.get(`${host}/${file}`);if(!value)throw new Error('missing contract');return value;}
    function add(file='a.cct',props={}){const c={host:'home',file,type:'Find Largest Prime Factor',data:21,tries:10,good:true,...props};contracts.set(`${c.host}/${file}`,c);return c;}
    const revision=safety.solverRevision(ns);
    function certificate(type='Find Largest Prime Factor',override={}){
        const old=files.has(safety.contractFiles().validation)?JSON.parse(files.get(safety.contractFiles().validation)):{schema:1,status:'complete',revision,types:{},dummyFiles:[]};
        old.types[type]={passed:true,deterministic:true,samples:100,failures:0,...override};
        files.set(safety.contractFiles().validation,JSON.stringify(old));return old;
    }
    function state(){return {scans:0,found:0,solved:0,unsupported:0,quarantined:0,waiting:0,error:'',lastReward:'none'};}
    const ctx=()=>({seen:new Set(),revision:null,sequence:0,fatal:''});
    async function scan(config={},context=ctx(),status=state(),pulse=()=>{}){
        await manager.scanContracts(ns,['home'],{dryRun:false,allowLastTry:false,...config},context,status,pulse);
        return {ctx:context,state:status};
    }
    return {ns,safety,manager,tester,files,contracts,attempts,writes,removed,printed,add,certificate,revision,state,ctx,scan,advance:ms=>now+=ms};
}

test('contracts: missing certificate blocks real attempts while recording an actionable reason',async()=>{
    const f=fixture();f.add();const r=await f.scan();assert.equal(f.attempts.length,0);
    assert.equal(r.state.contracts[0].reason,'validation-required');
});
for(const patch of [{samples:99},{passed:false},{failures:1},{deterministic:false}])test(`contracts: incomplete validation fails closed ${JSON.stringify(patch)}`,async()=>{
    const f=fixture();f.add();f.certificate(undefined,patch);await f.scan();assert.equal(f.attempts.length,0);
});
test('contracts: certificates for another source revision do not authorize submissions',async()=>{
    const f=fixture();f.add();f.certificate();f.files.set('contract-solvers.js',f.files.get('contract-solvers.js')+'\n// changed');
    const r=await f.scan();assert.equal(f.attempts.length,0);assert.equal(r.state.contracts[0].reason,'validation-required');
});
test('contracts: validated single-attempt contracts require explicit opt-in',async()=>{
    const f=fixture();f.add('a.cct',{tries:1});f.certificate();let r=await f.scan();
    assert.equal(f.attempts.length,0);assert.equal(r.state.contracts[0].reason,'last-attempt-protected');
    r=await f.scan({allowLastTry:true});assert.equal(f.attempts.length,1);assert.equal(r.state.solved,1);
});
test('contracts: opt-in does not bypass validation',async()=>{
    const f=fixture();f.add('a.cct',{tries:1});await f.scan({allowLastTry:true});assert.equal(f.attempts.length,0);
});
test('contracts: failures quarantine the whole type immediately and across restarts',async()=>{
    const f=fixture();f.certificate();f.add('a.cct',{good:false});f.add('b.cct',{data:35});
    const r=await f.scan();assert.equal(f.attempts.length,1);assert.equal(r.state.quarantined,1);
    await f.scan();assert.equal(f.attempts.length,1);
    assert.match(f.safety.readQuarantine(f.ns).types['Find Largest Prime Factor'].reason,/incorrect-answer/);
});
test('contracts: legacy quarantine is preserved, not silently cleared by validation',async()=>{
    const f=fixture();f.add();f.certificate();f.files.set('contract-quarantine.txt',JSON.stringify(['Find Largest Prime Factor']));
    const r=await f.scan();assert.equal(f.attempts.length,0);assert.equal(r.state.contracts[0].reason,'solver-quarantined');
});
test('contracts: explicit revalidation only pardons the named failure, never a newer one',async()=>{
    const f=fixture();f.add();f.files.set('contract-quarantine.txt',JSON.stringify(['Find Largest Prime Factor']));
    f.certificate(undefined,{recoveredFailureId:'legacy:Find Largest Prime Factor'});await f.scan();assert.equal(f.attempts.length,1);
    f.add('b.cct',{data:35});f.files.set('contract-quarantine.txt',JSON.stringify({schema:1,types:{'Find Largest Prime Factor':{id:'new',reason:'later'}}}));
    await f.scan();assert.equal(f.attempts.length,1);
});
for(const file of ['contract-validation.txt','contract-quarantine.txt','contract-attempts.txt'])test(`contracts: corrupt ${file} never authorizes a submission`,async()=>{
    const f=fixture();f.add();f.certificate();f.files.set(file,'{bad');await assert.rejects(f.scan(),/Invalid/);assert.equal(f.attempts.length,0);
});
test('contracts: source changes during cooperative solving prevent submission',async()=>{
    const f=fixture();f.add();f.certificate();let changed=false;
    const r=await f.scan({},f.ctx(),f.state(),()=>{if(!changed){changed=true;f.files.set('contract-solvers.js','changed');}});
    assert.equal(f.attempts.length,0);assert.match(r.state.contracts[0].reason,/source-changed/);
});
test('contracts: validation revoked during intent write is rechecked before side effect',async()=>{
    const f=fixture();f.add();f.certificate();const write=f.ns.write;
    f.ns.write=async(file,text)=>{await write(file,text);if(file==='contract-attempts.txt'){
        const report=JSON.parse(f.files.get('contract-validation.txt'));report.status='running';f.files.set('contract-validation.txt',JSON.stringify(report));
    }};
    await f.scan();assert.equal(f.attempts.length,0);assert.equal(Object.keys(f.safety.readReceipts(f.ns).entries).length,0);
});
test('contracts: failed intent persistence stops submissions',async()=>{
    const f=fixture();f.add();f.add('b.cct',{data:35});f.certificate();f.ns.write=async()=>{};
    const r=await f.scan();assert.equal(f.attempts.length,0);assert.match(r.ctx.fatal,/persist/);
});
test('contracts: interrupted intent and uncertain API results never get automatic retries',async()=>{
    const f=fixture();f.add();f.certificate();const id=f.safety.contractIdentity('home','a.cct','Find Largest Prime Factor',21);
    f.files.set('contract-attempts.txt',JSON.stringify({schema:1,entries:{[id]:{type:'Find Largest Prime Factor',status:'in-flight'}}}));
    f.add('b.cct',{data:35});await f.scan();assert.equal(f.attempts.length,0);
    const g=fixture();g.certificate();g.add('a.cct',{error:'ambiguous API failure'});await g.scan();await g.scan();assert.equal(g.attempts.length,1);
});
test('contracts: dry-run never submits or writes approval, quarantine, or receipt state',async()=>{
    const f=fixture();f.add();const r=await f.scan({dryRun:true});assert.equal(f.attempts.length,0);assert.equal(f.writes.length,0);
    assert.equal(r.state.contracts[0].status,'dry-run');
});
test('contracts: repeated scans count unique files and remove disappeared inventory',async()=>{
    const f=fixture();f.add('a.cct',{type:'future type'});const c=f.ctx(),s=f.state();
    await f.scan({},c,s);await f.scan({},c,s);assert.equal(s.found,1);assert.equal(s.unsupported,1);assert.equal(s.waiting,1);
    f.contracts.clear();await f.scan({},c,s);assert.equal(s.found,1);assert.equal(s.waiting,0);assert.equal(s.unsupported,0);
});
test('contracts: only a .cct suffix is treated as a contract',async()=>{
    const f=fixture();f.add('notes.cct.txt');const r=await f.scan();assert.equal(r.state.found,0);assert.equal(f.attempts.length,0);
});
test('contracts: malformed/gone file does not abort unrelated contracts in the pass',async()=>{
    const f=fixture();f.certificate();f.add();f.add('b.cct',{data:35});const old=f.ns.codingcontract.getData;
    f.ns.codingcontract.getData=(file,host)=>{if(file==='a.cct')throw new Error('removed by player');return old(file,host);};
    const r=await f.scan();assert.equal(f.attempts.length,1);assert.equal(r.state.solved,1);
});
test('contracts: same location with a different payload has a different receipt identity',()=>{
    const f=fixture();assert.notEqual(f.safety.contractIdentity('home','a.cct','Square Root',10n),f.safety.contractIdentity('home','a.cct','Square Root',11n));
});
test('contracts: self-test creates 100 dummies and approves only after all pass',async()=>{
    const f=fixture();f.add('real.cct');f.ns.flags=p=>({...Object.fromEntries(p),type:'Find Largest Prime Factor'});
    await f.tester.main(f.ns);const report=f.safety.readValidation(f.ns);
    assert.equal(report.status,'complete');assert.equal(report.types['Find Largest Prime Factor'].samples,100);
    assert.equal(report.types['Find Largest Prime Factor'].passed,true);assert.equal(f.attempts.length,100);
    assert.ok(f.attempts.every(a=>a.file!=='real.cct'));assert.equal(f.contracts.size,1);assert.equal(report.dummyFiles.length,0);
});
test('contracts: self-test failure revokes approval and cleans only its own dummy',async()=>{
    const f=fixture();f.certificate();f.add('real.cct');f.ns.flags=p=>({...Object.fromEntries(p),type:'Find Largest Prime Factor'});
    const create=f.ns.codingcontract.createDummyContract;
    f.ns.codingcontract.createDummyContract=type=>{const file=create(type);f.contracts.get(`home/${file}`).good=false;return file;};
    await f.tester.main(f.ns);const report=f.safety.readValidation(f.ns);
    assert.equal(report.types['Find Largest Prime Factor'].passed,false);assert.equal(report.types['Find Largest Prime Factor'].failures,1);
    assert.equal(f.attempts.length,1);assert.ok(f.contracts.has('home/real.cct'));assert.equal(f.contracts.size,1);
});
test('contracts: fewer than 100 dummy samples is diagnostic only',async()=>{
    const f=fixture();f.ns.flags=p=>({...Object.fromEntries(p),type:'Find Largest Prime Factor',samples:1});
    await f.tester.main(f.ns);assert.equal(f.safety.readValidation(f.ns).types['Find Largest Prime Factor'].passed,false);
});
test('contracts: unavailable game types are reported and not approved',async()=>{
    const f=fixture();f.ns.flags=p=>({...Object.fromEntries(p),type:'Square Root'});
    await f.tester.main(f.ns);assert.equal(f.attempts.length,0);assert.match(f.safety.readValidation(f.ns).types['Square Root'].reason,/not available/);
});
test('contracts: manager never submits during concurrent self-test or consumes owned dummy files',async()=>{
    const f=fixture();f.certificate();f.add('real.cct');f.add('test.cct',{dummy:true});
    const report=JSON.parse(f.files.get('contract-validation.txt'));report.status='running';report.dummyFiles=[{host:'home',file:'test.cct'}];
    f.files.set('contract-validation.txt',JSON.stringify(report));const r=await f.scan();
    assert.equal(f.attempts.length,0);assert.equal(r.state.found,1);assert.equal(r.state.contracts[0].reason,'self-test-running');
});
test('contracts: explicit recovery flag records legacy failure ID only after successful validation',async()=>{
    const f=fixture();f.files.set('contract-quarantine.txt',JSON.stringify(['Find Largest Prime Factor']));
    f.ns.flags=p=>({...Object.fromEntries(p),type:'Find Largest Prime Factor','retry-quarantined':true});await f.tester.main(f.ns);
    assert.equal(f.safety.readValidation(f.ns).types['Find Largest Prime Factor'].recoveredFailureId,'legacy:Find Largest Prime Factor');
    assert.ok(Array.isArray(JSON.parse(f.files.get('contract-quarantine.txt'))),'self-test does not write manager quarantine file');
});
test('contracts: failures are never retried on the same input even after an explicit type recovery',async()=>{
    const f=fixture();f.certificate();f.add('a.cct',{good:false});await f.scan();
    const failure=f.safety.readQuarantine(f.ns).types['Find Largest Prime Factor'];f.certificate(undefined,{recoveredFailureId:failure.id});
    await f.scan();assert.equal(f.attempts.length,1);
});
test('contracts: self-test source change leaves submissions paused',async()=>{
    const f=fixture();f.ns.flags=p=>({...Object.fromEntries(p),type:'Find Largest Prime Factor'});let changed=false;
    f.ns.sleep=async()=>{if(!changed){changed=true;f.files.set('contract-solvers.js','edited during validation');}};
    await f.tester.main(f.ns);assert.equal(f.safety.readValidation(f.ns).status,'running');assert.equal(f.attempts.length,0);
});
test('contracts: duplicate managers and validators exit without modifying contracts',async()=>{
    for(const script of ['contract-manager.js','contract-selftest.js']) {
        const f=fixture();f.ns.ps=()=>[{pid:77,filename:script}];await (script==='contract-manager.js'?f.manager:f.tester).main(f.ns);
        assert.equal(f.attempts.length,0);assert.equal(f.writes.length,0);assert.match(f.printed[0],/only one/);
    }
});
