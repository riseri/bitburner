const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

// Independent game evolution from Bitburner 3.0.1 GangMember.ts and Gang.ts:
// skill = floor(mult * (32*ln(exp+534.5)-200)), XP uses task difficulty^.9,
// ascension points = max(exp-1000,0), reputation = respect/75.
// Fixed 3x permanent equipment, 1x player reputation, no bonus time or purchases.
// This isolates growth policy; it is not a forecast for a live save.
const policy = loadScript('lib/gang-policy.js', new Clock());
const task = (name, hackWeight, chaWeight, difficulty, baseRespect = 0, baseWanted = 0, baseMoney = 0) => ({
    name, hackWeight, chaWeight, difficulty, baseRespect, baseWanted, baseMoney, isHacking: true,
    territory: { money: 1, respect: 1, wanted: 1 },
});
const tasks = [task('Ransomware', 100, 0, 1, .00005, .0001, 3),
    task('Phishing', 85, 15, 3.5, .00008, .003, 7.5),
    task('Identity Theft', 80, 20, 5, .0001, .075, 18),
    task('DDoS Attacks', 100, 0, 8, .0004, .2), task('Plant Virus', 100, 0, 12, .0006, .4),
    task('Fraud & Counterfeiting', 80, 20, 20, .0004, .3, 45),
    task('Money Laundering', 75, 25, 25, .001, 1.25, 360), task('Cyberterrorism', 80, 20, 36, .01, 6),
    task('Ethical Hacking', 90, 10, 1, 0, -.001, 3),
    task('Train Hacking', 100, 0, 45), task('Train Charisma', 0, 100, 8)];
const byName = new Map(tasks.map(t => [t.name, t]));
const mult = points => Math.max(1, Math.sqrt(points / 2000));
const skill = (xp, multiplier) => Math.max(1, Math.floor(multiplier * (32 * Math.log(xp + 534.5) - 200)));
function member(index, established = false) {
    return { name: 'member-' + String(index).padStart(2, '0'), hack_exp: established ? 1000 : 0,
        cha_exp: established ? Math.exp(230 / 32) - 534.5 : 0, hack_asc_points: 0, cha_asc_points: 0,
        hack_mult: 3, cha_mult: 1, earnedRespect: established ? 15625 / 9 : 0, task: 'Unassigned' };
}
function update(m) {
    for (const stat of ['hack', 'cha']) {
        m[stat + '_asc_mult'] = mult(m[stat + '_asc_points']);
        m[stat] = skill(m[stat + '_exp'], m[stat + '_mult'] * m[stat + '_asc_mult']);
    }
}
function gains(g, m, t) {
    const weight = (t.hackWeight * m.hack + t.chaWeight * m.cha) / 100;
    const respect = t.baseRespect && weight > 4 * t.difficulty
        ? (11 * t.baseRespect * (weight - 4 * t.difficulty) * g.territory * g.wantedPenalty) ** (.8 + .2 * g.territory) : 0;
    const wantedStat = weight - 3.5 * t.difficulty;
    const wanted = wantedStat <= 0 ? 0 : t.baseWanted < 0 ? .4 * t.baseWanted * wantedStat * g.territory
        : Math.min(100, 7 * t.baseWanted / (3 * wantedStat * g.territory) ** .8);
    return { respect, wanted };
}
function simulate(growth, seconds = 7200) {
    const members = Array.from({ length: 9 }, (_, i) => member(i + 1, true));
    const gang = { isHacking: true, respect: 15625, wantedLevel: 1, territory: 1 / 7, wantedPenalty: 1 };
    let lastAscensionAt = null, reputation = 0, ascensions = 0;
    for (let now = 0; now < seconds * 1000; now += 2000) {
        while (members.length < 12 && gang.respect >= 5 ** (members.length - 2)) members.push(member(members.length + 1));
        members.forEach(update);
        const results = () => Object.fromEntries(members.map(m => [m.name, { respect: m.earnedRespect,
            hack: mult(m.hack_asc_points + Math.max(0, m.hack_exp - 1000)) / m.hack_asc_mult }]));
        const candidate = policy.gangAscensionCandidate(gang, members, results(), lastAscensionAt, now);
        if (candidate) {
            const m = members.find(m => m.name === candidate.name);
            gang.respect = Math.max(1, gang.respect - m.earnedRespect); m.earnedRespect = 0;
            for (const stat of ['hack', 'cha']) { m[stat + '_asc_points'] += Math.max(0, m[stat + '_exp'] - 1000); m[stat + '_exp'] = 0; }
            update(m); lastAscensionAt = now; ascensions++;
        }
        gang.wantedPenalty = gang.respect / (gang.respect + gang.wantedLevel);
        const productive = policy.planGangTasks(gang, members, tasks, true);
        const trainees = growth ? policy.gangGrowthMembers(gang, members, results(), tasks, productive) : [];
        const plan = policy.planGangTasks(gang, members, tasks, true, 1, trainees);
        let respect = 0, wanted = 0;
        for (let i = 0; i < members.length; i++) {
            const m = members[i], t = byName.get(plan[i].task), gain = gains(gang, m, t);
            assert.ok(t, plan[i].task);
            respect += gain.respect * 10; wanted += gain.wanted * 10; m.earnedRespect += gain.respect * 10;
            for (const stat of ['hack', 'cha']) m[stat + '_exp'] += t[stat + 'Weight'] / 1500 * t.difficulty ** .9 * 10 *
                ((m[stat + '_mult'] - 1) / 4 + 1) * m[stat + '_asc_mult'];
        }
        gang.respect += respect; gang.wantedLevel = Math.max(1, gang.wantedLevel + wanted);
        reputation += respect / 75;
    }
    return { reputation, ascensions, members: members.length, wantedPenalty: gang.respect / (gang.respect + gang.wantedLevel),
        meanAscension: members.reduce((n, m) => n + m.hack_asc_mult, 0) / members.length };
}

test('two-hour equipped BN2 gang benchmark: growth rotation breaks low-XP production stalls', t => {
    const withoutGrowth = simulate(false), withGrowth = simulate(true);
    t.diagnostic(JSON.stringify({ withoutGrowth, withGrowth }));
    assert.ok(withGrowth.ascensions > withoutGrowth.ascensions);
    assert.ok(withGrowth.reputation > withoutGrowth.reputation * 2);
    assert.ok(withGrowth.meanAscension > 2);
    assert.ok(withGrowth.wantedPenalty >= .94);
});
