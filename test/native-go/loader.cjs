// Native Go rules/AI are loaded unmodified from the pinned upstream checkout.
// Only non-game services (UI, player progression and timer delays) are shimmed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const crypto = require('node:crypto');
const PIN = 'f02059a6769b6e20c6f1b32178a581801779b1f3';
function rng(seed) { let s=seed>>>0; return () => {s=(s+0x6d2b79f5)>>>0;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;}; }
async function loadNative(root) {
    if (!vm.SourceTextModule) throw new Error('Native benchmark requires node --experimental-vm-modules');
    root=path.resolve(root);
    const expectedHashes=JSON.parse(fs.readFileSync(path.join(__dirname,'hashes.json'),'utf8'));
    const Go={currentGame:null,stats:{},storedCycles:0};
    const Player={totalPlaytime:1, factions:[], hasAugmentation:()=>false,activeSourceFileLvl:()=>0,
        applyEntropy(){},giveAchievement(){}, entropy:0};
    let random=rng(1);
    const math=Object.create(Math);math.random=()=>random();
    const context=vm.createContext({console,Math:math,setTimeout,clearTimeout,structuredClone});
    const mods=new Map(),hashes={};
    function synthetic(id,exports) {
        if(!mods.has(id)) mods.set(id,new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context,identifier:id}));
        return mods.get(id);
    }
    const shims={
        'src/Go/Go.ts': {Go,GoEvents:{emit(){}},getEmptyHighlightedPoints:n=>Array.from({length:n},()=>Array(n).fill(null))},
        'src/utils/Utility.ts': {sleep:async()=>{}},
        'src/utils/helpers/exceptionAlert.ts': {exceptionAlert:error=>{throw error;}},
        'src/Faction/Factions.ts': {Factions:{}},
        'src/utils/EnumHelper.ts': {getEnumHelper:()=>({getMember:value=>value})},
        'src/Faction/formulas/favor.ts': {addRepToFavor:()=>{throw new Error('Benchmark must not grant favor');}},
        'src/BitNode/BitNodeMultipliers.ts': {currentNodeMults:{GoPower:1}},
        'src/PersonObjects/Multipliers.ts': {defaultMultipliers:()=>({}),mergeMultipliers:()=>{throw new Error('unused');}},
        'src/ui/formatNumber.ts': {formatPercent:n=>`${100*n}%`},
        'src/Types/Record.ts': {getRecordEntries:Object.entries,getRecordValues:Object.values},
    };
    function moduleFor(id) {
        if(mods.has(id))return mods.get(id);
        if(id==='@player')return synthetic(id,{Player});
        if(shims[id])return synthetic(id,shims[id]);
        let source;
        if(id==='@enums')source='export * from "./src/Go/Enums.ts"; export { AugmentationName } from "./src/Augmentation/Enums.ts"; export const FactionName={Illuminati:"Illuminati"};';
        else {
            if(!id.startsWith('src/')||id.includes('..'))throw new Error(`Unsupported upstream import ${id}`);
            source=fs.readFileSync(path.join(root,id),'utf8');
            hashes[id]=crypto.createHash('sha256').update(source).digest('hex');
            if(expectedHashes[id]!==hashes[id])throw new Error(`Upstream source mismatch: ${id}; expected pinned ${PIN}`);
            // Match TypeScript's type-only import erasure (Node's stripper is verbatim).
            source=source.replace(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/g,(all,names,spec)=> {
                if(spec.endsWith('/Types'))return '';
                if(spec.endsWith('/Multipliers'))return `import {${names.split(',').filter(n=>n.trim()!=='Multipliers').join(',')}} from "${spec}";`;
                return all;
            });
            source=stripTypeScriptTypes(source,{mode:'transform',sourceUrl:id});
        }
        const mod=new vm.SourceTextModule(source,{context,identifier:id});mods.set(id,mod);return mod;
    }
    function resolve(spec,parent) {
        if(spec.startsWith('@'))return spec;
        let id=path.posix.normalize(path.posix.join(parent==='@enums'?'':path.posix.dirname(parent),spec));
        if(!id.endsWith('.ts'))id+='.ts';
        return id;
    }
    const entry=new vm.SourceTextModule(`export * from './src/Go/boardAnalysis/goAI.ts';export * from './src/Go/boardState/boardState.ts';export * from './src/Go/boardAnalysis/boardAnalysis.ts';export * from './src/Go/boardAnalysis/scoring.ts';export * from './src/Go/effects/effect.ts';`,{context,identifier:'entry'});
    await entry.link((spec,referencing)=>moduleFor(resolve(spec,referencing.identifier)));
    await entry.evaluate();
    const api=entry.namespace;
    return {api,Go,Player,hashes,PIN,shims:Object.keys(shims),
        start(seed,size=5,opponent='Daedalus') {
            Player.totalPlaytime=seed;random=rng(seed);Go.stats={};
            Go.currentGame=api.getNewBoardState(size,opponent,true);api.updateChains(Go.currentGame.board,true);
            return Go.currentGame;
        },
        simple:game=>game.board.map(column=>column.map(p=>!p?'#':p.color==='Black'?'X':p.color==='White'?'O':'.').join('')),
        mask:game=>game.board.map((col,x)=>col.map((_,y)=>api.evaluateIfMoveIsValid(game,x,y,'Black',false)==='Valid move')),
    };
}
module.exports={loadNative,PIN,rng};
