import { readProgressionSnapshot } from "lib/progression-objective.js";
import { readSavings } from "lib/savings.js";
import { stockAccessInvestment } from "lib/investment-policy.js";
import { writeUtilityReport } from "lib/utility-report.js";

/** Deliberate full-access investment; no partial access spending without a funded basket. */
export async function main(ns) {
    const flags=ns.flags([["report",false]]);
    const objective=readProgressionSnapshot(ns), savings=readSavings(ns);
    let summary="Stock access requires current progression and multiplier evidence", state="WAITING";
    try {
        if(objective?.multipliers) {
            const constants=ns.stock.getConstants(), multiplier=objective.multipliers.FourSigmaMarketDataApiCost;
            const steps=[{has:()=>ns.stock.hasWseAccount(),cost:constants.WseAccountCost,buy:()=>ns.stock.purchaseWseAccount()},
                {has:()=>ns.stock.hasTixApiAccess(),cost:constants.TixApiCost,buy:()=>ns.stock.purchaseTixApi()},
                {has:()=>ns.stock.has4SDataTixApi(),cost:constants.MarketDataTixApi4SCost*multiplier,buy:()=>ns.stock.purchase4SMarketDataTixApi()}];
            const missing=steps.filter(s=>!s.has()), cost=missing.reduce((n,s)=>n+s.cost,0);
            if(!missing.length) {state="READY";summary="Stock access owned";}
            else {
                const decision=stockAccessInvestment({cost,cash:ns.getServerMoneyAvailable("home")-savings.floor,
                    income:objective.incomePerSecond,resetImminent:objective.resetImminent || objective.queuedDistinct.length>0,
                    higherPriority:objective.limitingResource === "cash" || objective.redPill!=="none"});
                summary=decision.reason;
                if(decision.ok) for(const step of missing) {
                    const live=readProgressionSnapshot(ns);
                    if(!live || live.resetEpoch!==objective.resetEpoch || live.resetImminent ||
                        ns.getServerMoneyAvailable("home")-step.cost<readSavings(ns).floor) break;
                    if(!step.buy() || !step.has()) {summary="Stock access unavailable or purchase rejected; retry later";break;}
                    summary="Purchased justified stock access; trading starts when all requirements are owned";state="READY";
                }
            }
        }
    } catch(error) {state="BLOCKED";summary=String(error.message||error);}
    if(flags.report) await writeUtilityReport(ns,"data/stock-access.json","stock-access",{state,summary});
    else ns.tprint(summary);
}
