import { readSavings } from "lib/savings.js";
import { PORTS } from "lib/ports.js";

/** Quotes are cheap to consume; expensive Singularity stays in this short-lived helper. */
export async function main(ns) {
    const [epoch,target,floor,quoteOnly=false]=ns.args, r=ns.getResetInfo();
    if(r.currentNode!==4 || [r.currentNode,r.lastNodeReset,r.lastAugReset].join(":")!==epoch ||
        !Number.isFinite(target) || target<8 || !Number.isFinite(floor) || floor<0) return;
    const ram=ns.getServerMaxRam("home");
    if(ram>=target) return;
    const cost=ns.singularity.getUpgradeHomeRamCost();
    const publish=()=>{ const port=ns.getPortHandle(PORTS.HOME_UPGRADE_STATUS); port.clear();
        port.write({type:"home-upgrade-quote",version:1,producerPid:ns.pid,resetEpoch:epoch,generatedAt:Date.now(),ram,cost,target}); };
    if(typeof ns.getPortHandle === "function") publish();
    if(quoteOnly || !(cost>0) || !Number.isFinite(cost)) return;
    // Remote actors refresh the durable shared floor immediately before spending.
    if(typeof ns.getHostname === "function" && ns.getHostname()!=="home" && ns.fileExists("data/savings.json","home")) {
        if(!await ns.scp("data/savings.json",ns.getHostname(),"home")) return;
    }
    const goal=readSavings(ns,"home:ram");
    const protectedFloor=Math.max(floor,goal.floor);
    if (goal.owner === "supervisor" && !goal.inactive && goal.target !== "home:ram") return;
    if (goal.target === "home:ram" && ns.getServerMoneyAvailable("home") < goal.amount) return;
    if (typeof ns.getPortHandle === "function") {
        const status=ns.getPortHandle(PORTS.AUGMENTATION_STATUS).peek();
        if (status?.resetEpoch === epoch && (status.progression?.resetImminent || status.progression?.redPill === "queued" ||
            ["INSTALL", "RESET", "COMPLETE_NODE"].includes(status.phase))) return;
    }
    const current=ns.getResetInfo();
    if([current.currentNode,current.lastNodeReset,current.lastAugReset].join(":")!==epoch) return;
    const live=ns.singularity.getUpgradeHomeRamCost();
    if(ns.getServerMaxRam("home")===ram && live===cost && live>0 && Number.isFinite(live) &&
        ns.getServerMoneyAvailable("home")-live>=protectedFloor) ns.singularity.upgradeHomeRam();
}
