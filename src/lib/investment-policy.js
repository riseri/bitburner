// One explainable priority policy, shared by cash consumers. Manual goals win in savings.js.
export function chooseInvestment(requests, previous = "") {
    const ranked = requests.filter(r=>r && r.target && Number.isFinite(r.amount) && r.amount>0 && r.available!==false)
        .sort((a,b)=>b.priority-a.priority || infrastructureOrder(a,b) || a.amount-b.amount || a.target.localeCompare(b.target));
    const best=ranked[0], old=ranked.find(r=>r.target===previous);
    const economicSwitch = old && best && old.priority === 79 && best.priority === 79 &&
        old.economics?.payback > best.economics?.payback * 1.2;
    const chosen=old && best && old.priority>=best.priority-3 && !economicSwitch ? old : best;
    return {chosen:chosen||null,deferred:ranked.filter(r=>r!==chosen).map(r=>r.target+": lower priority than "+chosen.target)};
}

function infrastructureOrder(a, b) {
    if (a.priority !== 79 || b.priority !== 79) return 0;
    const x = a.economics?.payback, y = b.economics?.payback;
    return Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0 ? x - y : 0;
}

export function stockAccessInvestment({cost,cash,income,resetImminent=false,higherPriority=false}) {
    const ok=!resetImminent && !higherPriority && Number.isFinite(cost) && cost>0 && cash>=cost*4 && income>0 && cost/income<=1800;
    return {ok,reason:ok ? "Access costs covered with trading capital retained" : "Stock access deferred: needs surplus capital and measured recovery evidence"};
}
