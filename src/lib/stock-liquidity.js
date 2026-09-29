import { readSavings } from "lib/savings.js";

export function readLiquidityRequest(ns,now=Date.now()) {
    const goal=readSavings(ns);
    if(goal.error || goal.inactive || goal.owner!=="supervisor" || !goal.liquidity || !(goal.priority>=80) ||
        !(goal.amount>0) || !Number.isFinite(goal.updatedAt) || now<goal.updatedAt || now-goal.updatedAt>15000) return null;
    try { if(!ns.ps("home").some(p=>p.pid===goal.producerPid && p.filename === "supervisor.js")) return null; } catch { return null; }
    return goal;
}

export function liquidationShares(available,needed,saleGain) {
    if(!(available>0) || !(needed>0)) return 0;
    const total=saleGain(available);
    if(!Number.isFinite(total) || total<=0) return 0;
    if(total<=needed) return available;
    let low=1,high=available;
    while(low<high) {const mid=Math.floor((low+high)/2); if(saleGain(mid)>=needed) high=mid; else low=mid+1;}
    return low;
}
