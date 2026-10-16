const test = require('node:test');
const assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');
const { policyFixture } = require('./go-policy-helpers.cjs');

test('fractional passive reputation is visible without presenting gang gains as player work', () => {
    const api = loadScript('lib/dashboard.js', new Clock()), lines = [];
    const render = rate => api.renderFactionProgression({ print: text => lines.push(text) }, {
        name: 'ADR-V2', faction: 'NiteSec', passiveReputation: true, rate, repGap: 50695, workEtaMs: 211819000,
        price: 550e6, progressionStrategy: 'PASSIVE',
    }, 1.6e9);
    render(.239);
    assert.match(lines.join('\n'), /Gang rep rate\s+0.24 rep\/s/);
    assert.match(lines.join('\n'), /future gang growth is not projected/);
    lines.length = 0; render(.00024);
    assert.match(lines.join('\n'), /0.00024 rep\/s/);
    assert.doesNotMatch(lines.join('\n'), /Work rate/);
});

test('Go credits measured passive gang reputation without requiring active faction work', () => {
    const f = policyFixture().add('Daedalus', .2);
    const objective = { ...f.objective, limitingResource: 'reputation', reputationStrategy: 'PASSIVE', remainingCash: 0,
        selectedPlan: { next: { faction: 'NiteSec', passiveReputation: true, rate: .239, repGap: 50695,
            workActive: false, rateSource: 'measured gang' } } };
    const context = f.policy.goProgressionContext(objective, f.jit, f.clock.now);
    assert.equal(context.repNeeded, true);
    assert.equal(context.repMeasured, true);
    assert.ok(context.repEtaMs > 2e8);
    const choice = f.choose({ objective });
    assert.equal(choice.selectedOpponent, 'Daedalus');
    assert.ok(choice.projectedMilestoneValue > 0);
    assert.match(choice.ranking[0].reason, /gang reputation/);
    objective.selectedPlan.next.rate = null;
    assert.equal(f.choose({ objective }).projectedMilestoneValue, null, 'unknown gang rates must not invent an ETA');
});

const planner = loadScript('lib/augmentation-plan.js', new Clock());
const context = { money: 2e9, income: 3e6, objective: { countRequired: 0, ownedCount: 9, limitingResource: 'reputation' } };
const aug = (name, etaMs, extra = {}) => ({ name, price: 550e6, prerequisites: [], repGap: 100, etaMs,
    stats: { faction_rep: 1.1 }, ...extra });

test('a days-long funded target loses to a useful near-term upgrade even when it is the incumbent', () => {
    const slow = aug('Slow pheromone', 59 * 3600000, { stats: { faction_rep: 1.25 } });
    const fast = aug('Quick hacking', 5 * 60000, { price: 600e6, stats: { hacking: 1.1 } });
    const plan = planner.planAugmentationBasket([slow, fast], [], context, { cash: 1.5e9, previous: slow.name });
    assert.equal(plan.next.name, fast.name);
    assert.equal(plan.order.length, 0);
    assert.equal(planner.planAugmentationBasket([slow, fast], [], context,
        { cash: 1.5e9, target: slow.name }).next.name, slow.name, 'explicit targets remain binding');
});

test('deferred chain ranking includes slow prerequisites and unknown ETA cannot win on a fabricated zero', () => {
    const list = [aug('Base', 59 * 3600000, { price: 1e6, stats: {} }),
        aug('Child', 0, { price: 1e6, prerequisites: ['Base'], repGap: 0, stats: { hacking: 2 } }),
        aug('Unknown', null, { price: 1, stats: { hacking: 3 } }), aug('Fast', 60000)];
    assert.equal(planner.planAugmentationBasket(list, [], context, { cash: 1e9 }).next.name, 'Fast');
    assert.ok(planner.planAugmentationBasket([list[2]], [], context, { cash: 1e9 }).next, 'unknown-only catalogs retain a fallback');
    list.push(aug('Ready', 0, { repGap: 0, price: 100, stats: { hacking: 1.01 } }));
    assert.equal(planner.planAugmentationBasket(list, [], context, { cash: 1e9 }).next.name, 'Ready');
});

test('deferred hysteresis changes the returned target and uses time-adjusted benefit', () => {
    const list = [aug('New', 60000), aug('Old', 65000)];
    assert.equal(planner.planAugmentationBasket(list, [], context, { cash: 1e9, previous: 'Old' }).next.name, 'Old');
    list[1].etaMs = 600000;
    assert.equal(planner.planAugmentationBasket(list, [], context, { cash: 1e9, previous: 'Old' }).next.name, 'New');
});
