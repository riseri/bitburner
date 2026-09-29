// Shared planning estimates; purchase actors obtain a live quote before spending.
const PROGRAMS = Object.freeze([
    { name: "BruteSSH.exe", cost: 500_000, level: 50, creationMs: 600000 },
    { name: "FTPCrack.exe", cost: 1_500_000, level: 100, creationMs: 1800000 },
    { name: "relaySMTP.exe", cost: 5_000_000, level: 250, creationMs: 7200000 },
    { name: "HTTPWorm.exe", cost: 30_000_000, level: 500, creationMs: 14400000 },
    { name: "SQLInject.exe", cost: 250_000_000, level: 750, creationMs: 28800000 },
    { name: "DarkscapeNavigator.exe", cost: 50_000_000, category: "darknet" },
    { name: "Formulas.exe", cost: 5_000_000_000, category: "formulas", level: 1000, creationMs: 14400000 },
]);

export function progressionPrograms({ darknet = true, formulas = true } = {}) {
    return PROGRAMS.filter(program => (program.category !== "darknet" || darknet) && (program.category !== "formulas" || formulas))
        .map(program => ({ ...program }));
}

export function isProgressionProgram(name) {
    return PROGRAMS.some(program => program.name === name);
}

export function rankPrograms(programs, { servers = [], homeRam = 0, darknetRam = Infinity, money = 0, income = null, objective = null } = {}) {
    const openers = programs.filter(p=>!p.category && p.owned).length;
    return programs.filter(p=>!p.owned).map(p=>{
        const unlocked = !p.category ? servers.filter(s=>!s.hasAdminRights && s.numOpenPortsRequired <= openers+1 && s.numOpenPortsRequired > openers) : [];
        const addedRam = unlocked.reduce((n,s)=>n+(s.maxRam||0),0);
        let priority = !p.category ? openers===0 ? 85 : 50 + Math.min(20, Math.log2(1+addedRam)) : p.category === "darknet" ? 55 : 45;
        let useful = true, reason = !p.category ? unlocked.length + " newly rootable servers / " + addedRam + " GB" : "";
        if (p.category === "darknet") { useful = homeRam >= darknetRam; reason = useful ? "Navigator unlock fits available subsystem RAM" : "Deferred: insufficient home RAM for Darknet"; }
        if (p.category === "formulas") {
            useful = homeRam >= 64 && (money >= p.cost*4 || income>0 && p.cost/income <= 1800 || objective?.redPill === "installed" && money >= p.cost);
            reason = useful ? "Formulas improves hacking and faction estimates" : "Deferred: Formulas cost not justified by cash/rate evidence";
            if (objective?.redPill === "installed") priority=80;
        }
        return {...p,priority,useful,reason,addedRam,unlocked:unlocked.length,score:priority/Math.max(1,Math.log10(p.cost))};
    }).sort((a,b)=>Number(b.useful)-Number(a.useful) || b.score-a.score || a.cost-b.cost || a.name.localeCompare(b.name));
}

export function programCreationEstimate(program, player, income, cash) {
    const level = Number(player.skills?.hacking)||0, intelligence=Number(player.skills?.intelligence)||0;
    if (!program.creationMs || level < Math.max(1,program.level-intelligence/2)) return null;
    // Conservative upper estimate: ignore positive INT speed bonus, allow unfocused work.
    const creationMs=program.creationMs / Math.max(.2,1+(level/program.level-1)/5) / .8;
    const purchaseMs=income>0 ? Math.max(0,program.cost-cash)/income*1000 : null;
    return {creationMs,purchaseMs,create:purchaseMs!=null && creationMs < purchaseMs*.8};
}
