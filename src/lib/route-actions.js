import { augmentationValue } from "lib/augmentation-plan.js";
import { progressionPrograms, programCreationEstimate } from "lib/programs.js";
import { readIntelligenceSession } from "lib/intelligence-session.js";
import { readSavings } from "lib/savings.js";
import { nextRouteNode, routeCities } from "lib/bitnode-route.js";
import { resetEpoch, progressionBackdoors } from "lib/progression-protocol.js";
import { matchingFactionWork } from "lib/augmentation-loop.js";

export function routeOwnsWork(current, state) {
    if (!current) return false;
    if (state.ownedCompany) return current.type === "COMPANY" && current.companyName === state.ownedCompany;
    if (state.ownedCrime) return current.type === "CRIME" && current.crimeType === state.ownedCrime;
    if (state.ownedProgram) return current.type === "CREATE_PROGRAM" && current.programName === state.ownedProgram;
    if (state.ownedClass) return current.type === "CLASS" && current.classType === state.ownedClass.classType && current.location === state.ownedClass.location;
    return Boolean(state.ownedWork && matchingFactionWork(current, state.ownedWork.faction, state.ownedWork.workType));
}

export function releaseRouteWork(ns, state) {
    const current = ns.singularity.getCurrentWork();
    if (current && !routeOwnsWork(current, state)) return false;
    if (!current && ns.singularity.isBusy()) return false;
    if (current && !ns.singularity.stopAction()) return false;
    state.ownedWork = null; state.ownedClass = null; state.ownedProgram = null; state.ownedCompany = null; state.ownedCrime = null;
    return true;
}

export function routeIntelligence(ns, state, installed, pending, invitations) {
    const reset = ns.getResetInfo(), player = ns.getPlayer();
    if (installed.length || pending.length || !(reset.ownedSF?.get(5) > 0) || player.skills.intelligence >= 50 ||
        (!player.factions.includes("Shadows of Anarchy") && !invitations.includes("Shadows of Anarchy"))) return null;
    let prior;
    try { prior = JSON.parse(ns.read("data/intelligence-auto.json") || "null"); } catch { return null; }
    if (prior?.nodeReset === reset.lastNodeReset || readIntelligenceSession(ns)) return null;
    const script = "intelligence-handoff.js";
    if (ns.ps("home").some(p => p.filename === script)) return status("WAITING", "INT", "Handing off to bounded INT farming");
    if (!releaseRouteWork(ns, state)) return status("BLOCKED", "INT", "Waiting for unrelated player work before the early INT session");
    const cost = ns.getScriptRam(script, "home");
    if (!(cost > 0) || cost > ns.getServerMaxRam("home") - ns.getServerUsedRam("home")) return status("WAITING_RAM", "INT", "Waiting for early INT farming helper RAM");
    if (Date.now() < (state.nextIntAttempt || 0)) return status("WAITING", "INT", "INT handoff retry cooling down");
    state.nextIntAttempt = Date.now() + 30000;
    const pid = ns.run(script, 1, JSON.stringify({ ownerPid: ns.pid, createdAt: Date.now(), resetEpoch: resetEpoch(reset) }));
    return status(pid ? "ACTIVE" : "BLOCKED", "INT", pid ? "Starting one early INT session: level 50 or 10 minutes" : "INT handoff launch failed");
}

export function routeBackdoorYield(ns, state) {
    const skill = ns.getHackingLevel();
    const ready = progressionBackdoors().find(t => ns.serverExists(t.host) && ns.hasRootAccess(t.host) &&
        skill >= ns.getServerRequiredHackingLevel(t.host) && !ns.getServer(t.host).backdoorInstalled);
    if (!ready) return null;
    const released = releaseRouteWork(ns, state);
    return status(released ? "WAITING" : "BLOCKED", "BACKDOOR", released
        ? `Yielding player work so the progression actor can backdoor ${ready.host}` : "Waiting for current player activity before faction backdoors");
}

export function routeUnlock(ns, cfg, state, owned, onlyAffordable = false) {
    const player = ns.getPlayer(), cash = ns.getServerMoneyAvailable("home");
    const cities = routeCities(player.factions, cfg.cityFaction);
    const money = { "Sector-12": 15e6, Aevum: 40e6, Chongqing: 20e6, "New Tokyo": 20e6, Ishima: 30e6, Volhaven: 50e6 };
    const candidates = [{ faction: "Tian Di Hui", city: "Chongqing", cash: 1e6, hacking: 50 },
        ...cities.map(city => ({ faction: city, city, cash: money[city], hacking: 0 }))];
    for (const goal of candidates) {
        if (player.factions.includes(goal.faction) || !Number.isFinite(goal.cash)) continue;
        const wanted = ns.singularity.getAugmentationsFromFaction(goal.faction).some(name => name !== "NeuroFlux Governor" && !owned.includes(name));
        if (!wanted) continue;
        if (goal.hacking > player.skills.hacking) {
            if (onlyAffordable) continue;
            return trainHacking(ns, cfg, state, goal.hacking);
        }
        const travel = player.city === goal.city ? 0 : 200000;
        if (cash < goal.cash + travel) {
            if (onlyAffordable) continue;
            return status("WAITING", "FACTION_CASH", `Saving to unlock ${goal.faction}`, {
                savings: { amount: goal.cash + travel, label: `Unlock ${goal.faction}`, target: `faction:${goal.faction}` } });
        }
        if (travel) {
            const savings = readSavings(ns);
            const floor = savings.owner === "supervisor" && savings.target === `faction:${goal.faction}` ? 0 : savings.floor;
            if (cash - travel < floor) {
                if (savings.owner !== "supervisor") continue;
                return status("WAITING", "FACTION_CASH", `Reserve travel and invitation cash for ${goal.faction}`, {
                    savings: { amount: goal.cash + travel, label: `Unlock ${goal.faction}`, target: `faction:${goal.faction}` } });
            }
            if (!releaseRouteWork(ns, state)) return status("BLOCKED", "TRAVEL", "Finish or stop unrelated player work before faction travel");
            const moved = ns.singularity.travelToCity(goal.city);
            return status(moved ? "ACTIVE" : "BLOCKED", "TRAVEL", `${moved ? "Travelled to" : "Could not travel to"} ${goal.city} for ${goal.faction}`);
        }
        return status("WAITING", "INVITATION", `Waiting for ${goal.faction}'s invitation`, {
            savings: { amount: goal.cash, label: `Unlock ${goal.faction}`, target: `faction:${goal.faction}` } });
    }
    return null;
}

export function trainHacking(ns, cfg, state, target) {
    if (!cfg.work) return status("WAITING", "HACKING", `Raise hacking to ${target}; automatic player work is disabled`);
    const player = ns.getPlayer(), current = ns.singularity.getCurrentWork();
    if (current && !routeOwnsWork(current, state)) return status("BLOCKED", "HACKING", "Finish or stop unrelated player work before training");
    if (!current && ns.singularity.isBusy()) return status("BLOCKED", "HACKING", "Waiting for the current Singularity action");
    const universities = { "Sector-12": "Rothman University", Aevum: "Summit University", Volhaven: "ZB Institute of Technology" };
    if (!universities[player.city]) {
        if (ns.getServerMoneyAvailable("home") - 200000 < readSavings(ns).floor) return status("WAITING", "HACKING", `Hacking workers are raising skill toward ${target}; waiting for university travel cash`);
        if (!releaseRouteWork(ns, state)) return status("BLOCKED", "HACKING", "Could not release owned work");
        if (!ns.singularity.travelToCity("Sector-12")) return status("BLOCKED", "HACKING", "University travel failed");
        return status("ACTIVE", "HACKING", "Travelled to Sector-12 for hacking training");
    }
    if (state.ownedClass && routeOwnsWork(current, state)) return status("ACTIVE", "HACKING", `Training hacking toward ${target}; income workers continue`);
    if (!releaseRouteWork(ns, state)) return status("BLOCKED", "HACKING", "Could not release owned work");
    const started = ns.singularity.universityCourse(universities[player.city], "Computer Science", cfg.focusWork);
    if (started) {
        const work = ns.singularity.getCurrentWork();
        state.ownedClass = work?.type === "CLASS" ? { classType: work.classType, location: work.location } : null;
    }
    return status(started ? "ACTIVE" : "BLOCKED", "HACKING", `Free Computer Science for hacking ${target}; faction reputation takes priority when needed`);
}

export function routeEndgame(ns, cfg, state) {
    const reset = ns.getResetInfo(), daemon = "w0r1d_d43m0n";
    if (!ns.serverExists(daemon)) return status("WAITING", "DAEMON", "Waiting for the final server to appear");
    const required = ns.getServerRequiredHackingLevel(daemon);
    if (ns.getHackingLevel() < required) return trainHacking(ns, cfg, state, required);
    if (!ns.hasRootAccess(daemon)) return status("WAITING", "DAEMON", "Waiting for the fleet to root the final server");
    if (!releaseRouteWork(ns, state)) return status("BLOCKED", "COMPLETE_NODE", "Finish or stop unrelated player work before completing the node");
    if (nextRouteNode(reset) === null) return status("READY", "ROUTE_END", "BN4.3 exit requirements met. Choose the next BitNode manually; no further node is configured");
    const script = "node-complete.js", cost = ns.getScriptRam(script, "home");
    if (ns.ps("home").some(p => p.filename === script) || Date.now() < (state.nextNodeAttempt || 0)) return status("WAITING", "COMPLETE_NODE", "Waiting for node transition; failed attempts retry after 30 seconds");
    if (!(cost > 0) || cost > ns.getServerMaxRam("home") - ns.getServerUsedRam("home")) return status("WAITING_RAM", "COMPLETE_NODE", "Waiting for node-complete.js RAM");
    state.nextNodeAttempt = Date.now() + 30000;
    const pid = ns.run(script, 1, JSON.stringify({ nextNode: 4, ownerPid: ns.pid, resetEpoch: resetEpoch(reset), createdAt: Date.now() }));
    return status(pid ? "ACTIVE" : "BLOCKED", "COMPLETE_NODE", pid ? "Completing this node and entering the next BN4 run" : "Node transition helper failed to launch");
}

export function routeDaedalus(ns, cfg, state, installed, countRequired = 30) {
    const player = ns.getPlayer();
    if (player.factions.includes("Daedalus") || new Set(installed).size < countRequired) return null;
    if (player.skills.hacking < 2500) return trainHacking(ns, cfg, state, 2500);
    return status("WAITING", "DAEDALUS", "Preserving $100b for the Daedalus invitation", {
        savings: { amount: 100e9, label: "Daedalus invitation", target: "faction:Daedalus" } });
}

function status(state, phase, recommendation, extra = {}) { return { state, phase, recommendation, ...extra }; }

export function routeProgramCreation(ns,cfg,state,context,plan) {
    if(!cfg.work || !cfg.programCreation || context.owned.includes("The Red Pill") || plan.next?.repGap>0) return null;
    const current=ns.singularity.getCurrentWork();
    if(state.ownedProgram && current?.type === "CREATE_PROGRAM" && current.programName === state.ownedProgram)
        return status("ACTIVE","PROGRAM_CREATE","Creating "+state.ownedProgram+"; owned work will yield to reputation or a milestone");
    state.ownedProgram=null;
    if(current || ns.singularity.isBusy()) return null; // Do not displace even owned useful work for an estimated saving.
    const candidates=progressionPrograms({darknet:false}).filter(p=>!ns.fileExists(p.name,"home")).map(p=>({p,estimate:programCreationEstimate(p,context.player,context.income,context.money)}))
        .filter(c=>c.estimate?.create).sort((a,b)=>a.estimate.creationMs-b.estimate.creationMs);
    const candidate=candidates[0];
    if(!candidate || candidate.estimate.creationMs>1800000 || plan.next?.etaMs!=null && plan.next.etaMs<candidate.estimate.creationMs) return null;
    if(!ns.singularity.createProgram(candidate.p.name,cfg.focusWork)) return null;
    state.ownedProgram=candidate.p.name;
    return status("ACTIVE","PROGRAM_CREATE","Creating "+candidate.p.name+"; conservative ETA "+Math.ceil(candidate.estimate.creationMs/1000)+"s beats purchase ETA");
}

// Selective extensions only: existing company employment, or Slum Snakes when
// combat requirements are already satisfied. Unknown requirement shapes fail closed.
export function routeSelectiveFaction(ns,cfg,state,context,plan) {
    if(!cfg.work || !cfg.joinFactions || context.owned.includes("The Red Pill") ||
        typeof ns.singularity.getFactionInviteRequirements!=="function") return null;
    const player=context.player, now=Date.now();
    if(now<(state.factionRetryAt||0)) return null;
    if(state.factionAttempt && now-state.factionAttempt.at>=1800000) {
        releaseRouteWork(ns,state);state.factionAttempt=null;state.factionRetryAt=now+1800000;return null;
    }
    const companies=Object.keys(player.jobs||{}), candidates=[...companies,"Slum Snakes"].filter(f=>!player.factions.includes(f));
    const baseline=plan.next ? augmentationValue(plan.next,context)/Math.sqrt(Math.max(1,plan.next.price)) : 0;
    let selected=null;
    if(!state.unlockCatalog || now-state.unlockCatalog.at>=60000) {
        const items=[];
        for(const faction of candidates) {
            try { for(const name of ns.singularity.getAugmentationsFromFaction(faction)) {
                if(context.owned.includes(name) || name === "NeuroFlux Governor" || cfg.target && name!==cfg.target) continue;
                items.push({name,faction,stats:ns.singularity.getAugmentationStats(name),prerequisites:ns.singularity.getAugmentationPrereq(name)});
            } } catch {}
        }
        state.unlockCatalog={at:now,items};
    }
    for(const item of state.unlockCatalog.items) {
        if(!candidates.includes(item.faction) || context.owned.includes(item.name) || !item.prerequisites.every(p=>context.owned.includes(p))) continue;
        const score=augmentationValue(item,context)/Math.sqrt(Math.max(1,ns.singularity.getAugmentationPrice(item.name)));
        if(score>baseline*1.5 && (!selected || score>selected.score)) selected={...item,score};
    }
    if(!selected || plan.order?.length) return null;
    const requirements=ns.singularity.getFactionInviteRequirements(selected.faction), pending=[];
    for(const r of requirements) {
        if(r.type === "skills") { if(Object.entries(r.skills).some(([k,v])=>!(player.skills[k]>=v))) return null; }
        else if(r.type === "money") { if(context.money<r.money) return null; }
        else if(r.type === "employedBy") { if(!player.jobs?.[r.company]) return null; }
        else if(r.type === "companyReputation") { if(ns.singularity.getCompanyRep(r.company)<r.reputation) pending.push(r); }
        else if(r.type === "karma") { if(ns.heart.break()>r.karma) pending.push(r); }
        else return null;
    }
    if(!pending.length) return null; // Invitation poll in the existing loop will join.
    if(!state.factionAttempt || state.factionAttempt.faction!==selected.faction) state.factionAttempt={faction:selected.faction,at:now};
    const current=ns.singularity.getCurrentWork();
    if(current && !routeOwnsWork(current,state) || !current && ns.singularity.isBusy()) return null;
    const requirement=pending[0];
    if(requirement.type === "companyReputation") {
        if(state.ownedCompany===requirement.company && routeOwnsWork(current,state))
            return status("ACTIVE","COMPANY","Working for "+requirement.company+" to unlock "+selected.name+"; invitation reputation "+requirement.reputation);
        if(!releaseRouteWork(ns,state)) return null;
        if(!ns.singularity.workForCompany(requirement.company,cfg.focusWork)) return null;
        state.ownedCompany=requirement.company;
        return status("ACTIVE","COMPANY","Company offerings improve the plan: "+selected.name+"; work bounded to 30 minutes");
    }
    if(requirement.type === "karma") {
        if(state.ownedCrime && routeOwnsWork(current,state)) return status("ACTIVE","FACTION_KARMA","Completing owned crime for "+selected.name);
        const choices=["Shoplift","Mug","Homicide"].map(name=>{const stats=ns.singularity.getCrimeStats(name);return {name,rate:Math.abs(stats.karma)*ns.singularity.getCrimeChance(name)/stats.time};}).sort((a,b)=>b.rate-a.rate);
        if(!(choices[0]?.rate>0) || !releaseRouteWork(ns,state)) return null;
        if(!(ns.singularity.commitCrime(choices[0].name,cfg.focusWork)>0)) return null;
        state.ownedCrime=choices[0].name;
        return status("ACTIVE","FACTION_KARMA","Reducing karma for Slum Snakes offering "+selected.name+"; combat requirements already met");
    }
    return null;
}
