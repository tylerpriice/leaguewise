// Unit tests for the category-coverage model. Open tests/coverage-model.test.html through any static server - green means every assertion held. Every expected number here is hand-computed from the formulas the model is given, and the rate cases are the point of the file: a rate cannot be apportioned, so "share of the team total" - the obvious way to name a driver - is wrong for ERA in a way that is invisible until someone checks the arithmetic. These tests check it.
import {
    rateSpecFor, valueFrom, sumPlayers, idsToSum,
    contributionOf, driversFor, gainFrom, cheapestSwap, coverageBand
} from '../coverage-model.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function assertClose(actual, expected, tol, msg) {
    if (actual === null || !(Math.abs(actual - expected) <= tol)) {
        throw new Error(`${msg}: got ${actual}, expected ${expected} +-${tol}`);
    }
}

// Baseball's real shapes, copied from RATE_COMPONENTS: ERA is earned runs times nine over innings, where id 34 is OUTS, so the scale is 27. AVG is hits over at-bats.
const COMPONENTS = [
    { out: '47', num: ['45'], den: ['34'], scale: 27 },   // ERA = ER*9/IP
    { out: '2', num: ['1'], den: ['0'] },                 // AVG = H/AB
    { out: '18', add: ['2', '9'] }                        // a two-part rate, OPS-shaped
];
const INVERSE = new Set(['47']);
const CTX = { components: COMPONENTS, inverseIds: INVERSE };

// Two pitchers. A: 30 ER in 600 outs (200 innings) = 1.35 ERA. B: 40 ER in 300 outs (100 innings) = 3.60. Together: 70 ER in 900 outs = 70*27/900 = 2.10.
const ACE = { id: 1, name: 'Ace', seasonTotals: { '45': 30, '34': 600, '5': 2 } };
const MID = { id: 2, name: 'Mid', seasonTotals: { '45': 40, '34': 300, '5': 1 } };
const ROSTER = [ACE, MID];

// ==== values ====

test('valueFrom: a counting category is its own sum', () => {
    assertEq(valueFrom({ '5': 31 }, '5', COMPONENTS), 31, 'home runs');
});

test('valueFrom: a rate is RECOMPUTED from components, never summed', () => {
    // 70 earned runs, 900 outs: 70 * 27 / 900 = 2.10 exactly.
    assertClose(valueFrom({ '45': 70, '34': 900 }, '47', COMPONENTS), 2.1, 1e-9, 'team ERA');
});

test('valueFrom: an add-rate sums its parts', () => {
    assertClose(valueFrom({ '1': 50, '0': 200, '9': 0.5 }, '18', COMPONENTS), 0.75, 1e-9, '0.250 + 0.5');
});

test('valueFrom: no denominator is NULL, never zero', () => {
    // A team with no innings has no ERA. Zero would be the best in the league in an inverse category - the exact trap coverageOf documents for absent figures.
    assertEq(valueFrom({ '45': 5, '34': 0 }, '47', COMPONENTS), null, 'zero outs');
    assertEq(valueFrom({ '45': 5 }, '47', COMPONENTS), null, 'no outs at all');
    assertEq(valueFrom({}, '5', COMPONENTS), null, 'no counting figure');
});

test('idsToSum: a rate drags its components in, recursively', () => {
    const ids = idsToSum(['47', '5'], COMPONENTS).sort();
    // String sort, so '47' precedes '5' - the ids are keys, not numbers.
    assertEq(ids.join(','), '34,45,47,5', 'ERA needs 45 and 34');
    const nested = idsToSum(['18'], COMPONENTS).sort();
    assertEq(nested.join(','), '0,1,18,2,9', 'the add-rate drags its parts and THEIR components');
});

test('sumPlayers: adds only finite figures', () => {
    const sums = sumPlayers([ACE, MID, { seasonTotals: { '45': 'x' } }], ['45', '34']);
    assertEq(sums['45'], 70, 'earned runs');
    assertEq(sums['34'], 900, 'outs');
});

// ==== contribution ====

test('contributionOf: a counting category gives exactly the player own figure', () => {
    assertClose(contributionOf(ACE, '5', ROSTER, CTX), 2, 1e-9, 'the two home runs');
});

test('contributionOf: a RATE is measured by removal, and share-of-total would be wrong', () => {
    // With both: 2.10. Without the ace: 40*27/300 = 3.60. So the ace is worth 1.50 of ERA, and because ERA is inverse the sign flips to POSITIVE - the ace makes the team better. The naive "share of the team total" reading would have credited 30/70 = 43% of the earned runs, i.e. blamed the best pitcher on the staff for the most damage.
    assertClose(contributionOf(ACE, '47', ROSTER, CTX), 1.5, 1e-9, 'the ace lowers ERA by 1.50');
    // The weaker arm RAISES it: without that arm the team is at 1.35, with it 2.10, so -0.75.
    assertClose(contributionOf(MID, '47', ROSTER, CTX), -0.75, 1e-9, 'the mid arm costs 0.75');
});

test('contributionOf: the last contributor has no measurable delta, and says so', () => {
    // Remove that player and the category has no figure at all - the contribution is the whole thing, which is not a delta. Null rather than the team total wearing a delta's clothes.
    assertEq(contributionOf(ACE, '47', [ACE], CTX), null, 'the only pitcher');
});

test('driversFor: biggest first, and only real positive contributors', () => {
    const drivers = driversFor(ROSTER, '47', CTX, 2);
    assertEq(drivers.length, 1, 'only the ace helps ERA');
    assertEq(drivers[0].player.name, 'Ace', 'and the ace leads');
    const hr = driversFor(ROSTER, '5', CTX, 2);
    assertEq(hr.map(d => d.player.name).join(','), 'Ace,Mid', 'counting drivers in order');
});

// ==== gains and swaps ====

test('gainFrom: an add is measured the same way a contribution is', () => {
    // Adding a 0.00-ERA arm with 270 outs: 70 ER over 1170 outs = 1.615..., from 2.10, so it improves ERA by 0.4846 and reads positive because the category is inverse.
    const arm = { id: 9, name: 'Closer', seasonTotals: { '45': 0, '34': 270 } };
    assertClose(gainFrom(arm, '47', ROSTER, CTX), 2.1 - (70 * 27 / 1170), 1e-9, 'the closer helps');
    assertClose(gainFrom({ seasonTotals: { '5': 12 } }, '5', ROSTER, CTX), 12, 1e-9, 'twelve home runs');
});

test('gainFrom: a candidate who cannot be measured yields null, not zero', () => {
    assertEq(gainFrom({ seasonTotals: {} }, '47', [], CTX), null, 'no roster to compare against');
});

test('cheapestSwap: the player who costs least in the categories being WON', () => {
    // Strong category is home runs. The ace has 2 of the team's 3, the mid arm 1 - so the mid arm is the cheap one. Naming "the worst player" would have picked differently.
    const swap = cheapestSwap(ROSTER, ['5'], CTX);
    assertEq(swap.player.name, 'Mid', 'the cheaper player');
    assertClose(swap.cost, 1 / 3, 1e-9, 'one of the three home runs');
});

test('cheapestSwap: the SOLE holder of a strong category is never named as free to drop', () => {
    // The flaw this guards, found by reading a generated fixture rather than the code: a bat contributes nothing to ERA, so that cost is a true zero - and if the batting average the bat ALONE holds is skipped for being unmeasurable, it sorts to the front as the cheapest player on the roster while being the only reason the team has an average at all. The instrument read zero because it could not measure; zero is the one answer that cannot be right.
    const bat = { id: 3, name: 'Only Hitter', seasonTotals: { '1': 120, '0': 400 } };
    const roster = [ACE, MID, bat];
    const swap = cheapestSwap(roster, ['47', '2'], CTX);
    assert(swap === null || swap.player.name !== 'Only Hitter', `named the sole hitter: ${swap && swap.player.name}`);
});

test('cheapestSwap: with a second hitter the guard lifts, and the lighter bat is named', () => {
    // Two hitters, so neither is the sole holder. Team average is 140/500 =.280. Dropping A (.300 on 400 at-bats) leaves.200, a swing of.080; dropping B (.200 on 100) leaves.300, a swing of.020. B costs least and is the one to move.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', seasonTotals: { '1': 20, '0': 100 } };
    const swap = cheapestSwap([a, b], ['2'], CTX);
    assert(swap !== null, 'somebody is nameable now');
    assertEq(swap.player.name, 'Hitter B', 'the lighter bat');
    assertClose(swap.cost, 0.02 / 0.28, 1e-9, 'that share of the average');
});

test('cheapestSwap: a player who cannot touch a strong category costs nothing IN IT', () => {
    // Not a bug and worth pinning: with batting average the only category being won, the pitcher is genuinely the cheapest player to lose, contributing nothing to it. The band's job is to answer the question asked, not to rank players overall.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', seasonTotals: { '1': 20, '0': 100 } };
    assertEq(cheapestSwap([ACE, a, b], ['2'], CTX).player.name, 'Ace', 'the pitcher');
});

test('cheapestSwap: nothing measurable yields null rather than an arbitrary name', () => {
    assertEq(cheapestSwap(ROSTER, [], CTX), null, 'no strong categories');
    assertEq(cheapestSwap([], ['5'], CTX), null, 'no roster');
});

// ==== the band ====

const SUMS = {
    1: { '5': 3, '45': 70, '34': 900 },     // this team: 3 HR, 2.10 ERA
    2: { '5': 10, '45': 50, '34': 900 },    // more HR, better ERA (1.50)
    3: { '5': 8, '45': 90, '34': 900 }      // more HR, worse ERA (2.70)
};

test('coverageBand: standing, drivers, and a shopping list only where it is losing', () => {
    const band = coverageBand({
        sumsByTeam: SUMS, teamId: 1, roster: ROSTER,
        available: [{ id: 7, name: 'Slugger', seasonTotals: { '5': 20 } }],
        categoryIds: ['5', '47'], components: COMPONENTS, inverseIds: INVERSE
    });
    const hr = band.categories.find(c => c.id === '5');
    const era = band.categories.find(c => c.id === '47');
    // Home runs: 3 against 10 and 8 - beaten by both, share 0.
    assertEq(hr.share, 0, 'losing home runs outright');
    assertEq(hr.weak, true, 'so it is a hole');
    assertEq(hr.adds[0].player.name, 'Slugger', 'and the shopping list names them');
    assertClose(hr.adds[0].gain, 20, 1e-9, 'twenty home runs');
    // ERA 2.10 beats 2.70 and loses to 1.50 - one of two, share 0.5, not a hole.
    assertEq(era.share, 0.5, 'middle of the league in ERA');
    assertEq(era.weak, false, 'not a hole');
    assertEq(era.adds.length, 0, 'and no shopping list for a category being held');
    assertEq(era.inverse, true, 'flagged inverse');
    // RATE-NESS IS SAID, NOT INFERRED. A surface reading this cannot tell the two apart from the values: 3 home runs and a 3.00 ERA are both integers, and a.276 average and a.5 share are both fractions. Only the league's own components answer it.
    assertEq(hr.rate, false, 'home runs are counted');
    assertEq(era.rate, true, 'ERA is recomputed');
});

test('coverageBand: a category the team has no figure in keeps its row and says nothing', () => {
    const band = coverageBand({
        sumsByTeam: { 1: {}, 2: { '5': 4 } }, teamId: 1, roster: [],
        categoryIds: ['5'], components: COMPONENTS, inverseIds: INVERSE
    });
    assertEq(band.categories.length, 1, 'the row survives');
    assertEq(band.categories[0].share, null, 'with no share');
    assertEq(band.categories[0].drivers.length, 0, 'and nobody driving it');
});


// ==== THE PROJECTED BASIS. The band used to answer every question with the season's actuals, so a player added today read as having produced a season's worth for this roster and a free agent's "would add" counted production that had already happened. These cases are built so the two bases give DIFFERENT answers - if the seam ever collapses back to one basis, they fail. The roster, hand-built to mirror the owner's own report. BANKED is Schwarber, with nearly all of those home runs already behind. STEADY has fewer banked and more to come. ====
const BANKED = { id: 11, name: 'Banked', seasonTotals: { '5': 40, '20': 70 } };
const STEADY = { id: 12, name: 'Steady', seasonTotals: { '5': 10, '20': 30 } };
const BANKED_AHEAD = { id: 11, name: 'Banked', seasonTotals: { '5': 6, '20': 2 } };
const STEADY_AHEAD = { id: 12, name: 'Steady', seasonTotals: { '5': 9, '20': 30 } };
// Two free agents whose order REVERSES between the bases: the closer has banked those saves, the rookie has them still to come.
const CLOSER = { id: 21, name: 'Closer', seasonTotals: { '5': 25, '20': 0 } };
const ROOKIE = { id: 22, name: 'Rookie', seasonTotals: { '5': 1, '20': 0 } };
const CLOSER_AHEAD = { id: 21, name: 'Closer', seasonTotals: { '5': 2, '20': 0 } };
const ROOKIE_AHEAD = { id: 22, name: 'Rookie', seasonTotals: { '5': 8, '20': 0 } };
// Team 1 is behind in home runs (50 to 60) and ahead in runs (100 to 80).
const TWO_TEAM_SUMS = { 1: { '5': 50, '20': 100 }, 2: { '5': 60, '20': 80 } };
const BASE_BAND = {
    sumsByTeam: TWO_TEAM_SUMS, teamId: 1, roster: [BANKED, STEADY],
    available: [CLOSER, ROOKIE], categoryIds: ['5', '20'],
    components: COMPONENTS, inverseIds: INVERSE
};
const projectedBand = (extra = {}) => coverageBand({
    ...BASE_BAND,
    projectedRoster: [BANKED_AHEAD, STEADY_AHEAD],
    projectedAvailable: [CLOSER_AHEAD, ROOKIE_AHEAD],
    window: { kind: 'rest', label: 'the rest of the way', matchup: null, periods: [163, 164], asOf: 162 },
    ...extra
});

test('the standing stays on the ACTUALS while the figure becomes the remainder', () => {
    const hr = projectedBand().categories.find(c => c.id === '5');
    // value is unchanged and still the actuals total the standing is computed from: 40 + 10.
    assertEq(hr.value, 50, 'value is still the season total');
    assertEq(hr.share, 0, 'and the standing is still last of two');
    assertEq(hr.weak, true, 'still a hole by the actual standing');
    // The remainder is 6 + 9, which is a different number and a different question.
    assertEq(hr.projected, 15, 'the roster projects fifteen more');
});

test('the drivers flip when the basis does - the whole point of the amendment', () => {
    // On the actuals Banked leads 40 to 10. On the remainder Steady leads 9 to 6. Naming Banked as the driver of what is COMING is the error the owner reported.
    const actualsOnly = coverageBand(BASE_BAND).categories.find(c => c.id === '5');
    assertEq(actualsOnly.drivers[0].player.name, 'Banked', 'the actuals name the banked player');
    const hr = projectedBand().categories.find(c => c.id === '5');
    assertEq(hr.drivers[0].player.name, 'Steady', 'the remainder names the one still producing');
    assertClose(hr.drivers[0].contribution, 9, 1e-9, 'and the contribution is what is left, not what is banked');
});

test('an add is what a player would add FROM HERE, not what was already recorded', () => {
    const actualsOnly = coverageBand(BASE_BAND).categories.find(c => c.id === '5');
    assertEq(actualsOnly.adds[0].player.name, 'Closer', 'the actuals name the closer');
    assertClose(actualsOnly.adds[0].gain, 25, 1e-9, 'crediting twenty-five already banked');
    const hr = projectedBand().categories.find(c => c.id === '5');
    assertEq(hr.adds[0].player.name, 'Rookie', 'the remainder names the rookie instead');
    assertClose(hr.adds[0].gain, 8, 1e-9, 'eight to come beats the closer, who has two');
    assertEq(hr.adds[1].player.name, 'Closer', 'and the closer drops to second');
});

test('the swap is costed on the remainder against the categories the actuals call strong', () => {
    // Runs is the strong category by the ACTUALS (100 to 80). On the actuals Steady is cheapest (30 of 100 against Banked's 70 of 100); on the remainder Banked is cheapest (2 of 32 against Steady's 30 of 32), because that production is already behind them.
    const actualsOnly = coverageBand(BASE_BAND);
    assertEq(actualsOnly.strongIds.join(), '20', 'runs is what the team is winning');
    assertEq(actualsOnly.categories.find(c => c.id === '5').swap.player.name, 'Steady', 'actuals spare Steady');
    const band = projectedBand();
    assertEq(band.strongIds.join(), '20', 'the strong category is unchanged - it is an actuals fact');
    assertEq(band.categories.find(c => c.id === '5').swap.player.name, 'Banked', 'the remainder spares Banked');
});

test('a projected RATE is rebuilt from its components, never summed or averaged', () => {
    // Two pitchers ahead: 5 ER in 270 outs is a 0.50 ERA, 10 ER in 90 outs is 3.00. The mean of those is 1.75 and it is wrong; the staff is 15 ER over 360 outs = 15*27/360 = 1.125.
    const AHEAD_A = { id: 31, name: 'A', seasonTotals: { '45': 5, '34': 270 } };
    const AHEAD_B = { id: 32, name: 'B', seasonTotals: { '45': 10, '34': 90 } };
    const band = coverageBand({
        sumsByTeam: { 1: { '45': 70, '34': 900 }, 2: { '45': 40, '34': 900 } },
        teamId: 1, roster: [ACE, MID], categoryIds: ['47'],
        components: COMPONENTS, inverseIds: INVERSE,
        projectedRoster: [AHEAD_A, AHEAD_B]
    });
    const era = band.categories[0];
    assertClose(era.projected, 1.125, 1e-9, 'the staff ERA of the innings still to be thrown');
    assert(Math.abs(era.projected - 1.75) > 0.5, 'and not the mean of the two, which is the trap');
});

test('a category the projected basis cannot measure reads null, never zero', () => {
    // Nobody left with at-bats: an average with no denominator is not.000, it is no figure.
    const band = coverageBand({
        sumsByTeam: { 1: { '1': 50, '0': 200 }, 2: { '1': 40, '0': 200 } },
        teamId: 1, roster: [{ id: 41, name: 'Bat', seasonTotals: { '1': 50, '0': 200 } }],
        categoryIds: ['2'], components: COMPONENTS, inverseIds: INVERSE,
        projectedRoster: [{ id: 41, name: 'Bat', seasonTotals: { '1': 0, '0': 0 } }]
    });
    assertClose(band.categories[0].value, 0.25, 1e-9, 'the actual average is real');
    assertEq(band.categories[0].projected, null, 'the projected one has no denominator');
});

test('the window travels on the band so the copy never infers a horizon', () => {
    const band = projectedBand();
    assertEq(band.window.kind, 'rest', 'the horizon is stated');
    assertEq(band.window.label, 'the rest of the way', 'pre-formatted, as team-compare does it');
    assertEq(band.window.periods.join(), '163,164', 'the days it spans');
    // Copied, not aliased - a caller mutating its own array must not reach into the band.
    const periods = [163, 164];
    const b2 = projectedBand({ window: { kind: 'matchup', label: 'this matchup', matchup: 22, periods, asOf: 162 } });
    periods.push(999);
    assertEq(b2.window.periods.length, 2, 'the band kept its own copy');
    assertEq(b2.window.kind, 'matchup', 'a matchup window says so');
    assertEq(b2.window.matchup, 22, 'and names the matchup');
});

test('an unrecognised window kind reads as rest rather than passing through', () => {
    const band = projectedBand({ window: { kind: 'something-else', label: 'x', periods: [1] } });
    assertEq(band.window.kind, 'rest', 'one of two states, never a third');
});

test('one basis in, todays behaviour out - the un-updated caller is unchanged', () => {
    // The whole compatibility promise in one case: omit both projected arguments and every figure is what it was before the amendment, with projected null for the renderer to fall back on.
    const before = coverageBand(BASE_BAND);
    const hr = before.categories.find(c => c.id === '5');
    assertEq(hr.value, 50, 'the same value');
    assertEq(hr.projected, null, 'no remainder claimed');
    assertEq(hr.drivers[0].player.name, 'Banked', 'the same drivers');
    assertEq(hr.adds[0].player.name, 'Closer', 'the same adds');
    assertEq(before.window, null, 'and no window');
});

// ==== A player marked `out` is never named as an add ESPN's rest-of-season projection does NOT discount an injured player - measured on the owner's league, a closer on the fifteen-day list projects the same six saves over ten innings as four healthy closers, and the highest projected save-getter in the whole pool is on the SIXTY-day list, credited with 69 innings he cannot throw. The remainder handed to this model is untrue for those players, so the model declines to NAME them. It does not adjust what they are worth: the remainder stays ESPN's, unscaled. ====

test('an `out` candidate is never named as an add, however large its gain', () => {
    // ON THE REMAINDER the rookie leads home runs, not the closer - that reversal is what this fixture pair exists to show. So the rookie is the one to mark, and the closer takes the row.
    const open = projectedBand().categories.find(c => c.id === '5');
    assertEq(open.adds[0].player.name, 'Rookie', 'unmarked, the rookie leads on the remainder');
    const shut = projectedBand({
        projectedAvailable: [CLOSER_AHEAD, { ...ROOKIE_AHEAD, out: true }]
    }).categories.find(c => c.id === '5');
    assertEq(shut.adds.length, 1, 'one candidate left');
    assertEq(shut.adds[0].player.name, 'Closer', 'and the healthy one is named instead');
});

test('marking every candidate `out` leaves the shopping list EMPTY, never a bad name', () => {
    const none = projectedBand({
        projectedAvailable: [{ ...CLOSER_AHEAD, out: true }, { ...ROOKIE_AHEAD, out: true }]
    }).categories.find(c => c.id === '5');
    assertEq(none.adds.length, 0, 'a losing category with nobody to name says nothing');
    assertEq(none.weak, true, 'and is still reported as a hole');
});

test('`out` is only ever a filter on WHO IS NAMED, never on what they are worth', () => {
    // The surviving candidate's gain is identical either way: no rescaling, no discount.
    const open = projectedBand().categories.find(c => c.id === '5');
    const shut = projectedBand({
        projectedAvailable: [CLOSER_AHEAD, { ...ROOKIE_AHEAD, out: true }]
    }).categories.find(c => c.id === '5');
    const closerOpen = open.adds.find(a => a.player.name === 'Closer');
    assertClose(shut.adds[0].gain, closerOpen.gain, 1e-12, 'the remainder is untouched');
});

test('an absent or false `out` behaves exactly as before', () => {
    const a = projectedBand().categories.find(c => c.id === '5');
    const b = projectedBand({
        projectedAvailable: [{ ...CLOSER_AHEAD, out: false }, { ...ROOKIE_AHEAD, out: false }]
    }).categories.find(c => c.id === '5');
    assertEq(b.adds.map(x => x.player.name).join(), a.adds.map(x => x.player.name).join(), 'same names');
});

test('THE SWAP IS NOT FILTERED: an injured player is exactly who you can spare', () => {
    // The counterpart rule, and the reason it is a rule. `adds` answers "who should you pick up", where an injured name is bad advice; `swap` answers "who can you spare", where it is often the right one. Measured on the owner's league: one team's swap names a player on the ten-day list. Marking a roster player `out` must not change who is named.
    const plain = projectedBand().categories.find(c => c.swap);
    const marked = coverageBand({
        ...BASE_BAND,
        roster: [BANKED, { ...STEADY, out: true }],
        projectedRoster: [BANKED_AHEAD, { ...STEADY_AHEAD, out: true }],
        projectedAvailable: [CLOSER_AHEAD, ROOKIE_AHEAD],
        window: { kind: 'rest', label: 'the rest of the way', matchup: null, periods: [163, 164], asOf: 162 }
    }).categories.find(c => c.swap);
    assertEq(marked.swap.player.name, plain.swap.player.name, 'the same player is still the cheapest to lose');
});


// ==== A category the roster holds NONE of sumPlayers only creates a key for an id some roster player carries, so a team with no starting pitcher has no wins key at all. gainFrom used to return null for every candidate in that state, and the shopping list came back EMPTY exactly when the first starting pitcher would have been the most valuable add available. An unmeasurable baseline is not a refusal to answer: the roster holds none of the category, so the baseline is zero and the candidate's own line is the gain. ====

const BULLPEN = [
    { id: 41, name: 'Reliever A', seasonTotals: { '48': 60, '57': 20 } },
    { id: 42, name: 'Reliever B', seasonTotals: { '48': 55, '57': 15 } }
];
const STARTER = { id: 49, name: 'Starter', seasonTotals: { '48': 33, '53': 2, '63': 4 } };

test('a candidate gains its FULL line in a category the roster holds none of', () => {
    // The roster carries strikeouts and saves; it carries no wins and no quality starts at all.
    assertEq(sumPlayers(BULLPEN, ['48', '53', '63'])['53'], undefined, 'no wins key on the roster');
    assertEq(gainFrom(STARTER, '53', BULLPEN, CTX), 2, 'the whole of his wins is the gain');
    assertEq(gainFrom(STARTER, '63', BULLPEN, CTX), 4, 'and the whole of his quality starts');
});

test('a category the roster DOES hold still measures the difference, unchanged', () => {
    // The guard must not change the ordinary case: 115 + 33 - 115.
    assertEq(gainFrom(STARTER, '48', BULLPEN, CTX), 33, 'strikeouts are still a delta');
});

test('an EMPTY roster is the same case, not a special one', () => {
    assertEq(gainFrom(STARTER, '53', [], CTX), 2, 'a team with nobody holds none of everything');
});

test('an inverse counting category keeps its sign when the roster holds none', () => {
    // Errors are lower-is-better, so a candidate who commits them is a NEGATIVE gain even when the roster has recorded none - the sign rule must survive the zero baseline.
    const clumsy = { id: 50, name: 'Clumsy', seasonTotals: { '72': 6 } };
    // This suite's fixture inverts only ERA, so the id is declared inverse here rather than assuming the league's own table - the rule under test is the sign, not which ids carry it.
    const ctx = { components: COMPONENTS, inverseIds: new Set(['47', '72']) };
    assertEq(gainFrom(clumsy, '72', BULLPEN, ctx), -6, 'six errors added is six against you');
});

test('a RATE the roster cannot measure stays null, deliberately', () => {
    // There is no honest zero for a rate: "your ERA is 0.00 before this pitcher" is a worse claim than saying nothing, because a rate with no denominator has no baseline at all.
    const noRateRoster = [{ id: 43, name: 'Bat', seasonTotals: { '5': 10 } }];
    const pitcher = { id: 44, name: 'Arm', seasonTotals: { '45': 20, '34': 180 } };
    assertEq(gainFrom(pitcher, '47', noRateRoster, CTX), null, 'ERA has no zero to start from');
});

test('the shopping list is no longer empty for a category the roster holds none of', () => {
    // The whole point, at the band level rather than the function's: this is the case that printed "no add found" while the best add in the pool sat in the list.
    const sums = { 1: { '48': 115, '53': 0 }, 2: { '48': 200, '53': 40 } };
    const band = coverageBand({
        sumsByTeam: sums, teamId: 1, roster: BULLPEN, available: [STARTER],
        categoryIds: ['48', '53'], components: COMPONENTS, inverseIds: INVERSE
    });
    const w = band.categories.find(c => c.id === '53');
    assertEq(w.weak, true, 'wins is a hole');
    assertEq(w.adds.length, 1, 'and the starter is named');
    assertEq(w.adds[0].gain, 2, 'for the whole of his line');
});


// ==== searchIds: a shopping list for a category the CALLER calls losing The strip ranks by its own losingIds, this model marks holes by share, and the two genuinely differ. A category listed as losing that the model had never searched came out with no adds, and the renderer reported "no add found" - naming a search that never ran. searchIds lets the caller say which rows to look in; it ADDS to the holes rather than replacing them, because `weak` is computed in here and a caller cannot pass a union with something that does not exist yet. ====

// Team 1 is AHEAD in runs (100 to 80), so runs is not a hole - but a caller may still rank it as losing and want an add for it.
const RUNS_ID = '20';
// The fixture's two free agents carry no runs at all, so a search of that row would find nothing to name and prove nothing. This one does - it is the candidate the runs row should surface.
const RUNNER_AHEAD = { id: 23, name: 'Runner', seasonTotals: { '5': 0, '20': 15 } };
const withRunner = (extra = {}) => projectedBand({
    projectedAvailable: [CLOSER_AHEAD, ROOKIE_AHEAD, RUNNER_AHEAD], ...extra
});

test('by default only the holes are searched, exactly as before', () => {
    const band = projectedBand();
    const hr = band.categories.find(c => c.id === '5');
    const r = band.categories.find(c => c.id === RUNS_ID);
    assertEq(hr.weak, true, 'home runs is the hole');
    assert(hr.adds.length > 0, 'and it has a shopping list');
    assertEq(r.weak, false, 'runs is not a hole');
    assertEq(r.adds.length, 0, 'and gets no list, which is the unchanged default');
});

test('a row named in searchIds is searched even though it is NOT weak', () => {
    const band = withRunner({ searchIds: new Set([RUNS_ID]) });
    const r = band.categories.find(c => c.id === RUNS_ID);
    assertEq(r.weak, false, 'still not a hole - searchIds does not change the standing');
    assert(r.adds.length > 0, 'but it now has a shopping list');
    assertEq(r.adds[0].player.name, 'Runner', 'named from the same pool as any other row');
    assertEq(r.adds[0].gain, 15, 'and scored the ordinary way');
});

test('a row NOT named in searchIds still gets none', () => {
    // The widening is exactly as wide as the caller asked, never wider.
    const band = withRunner({ searchIds: new Set([RUNS_ID]) });
    const others = band.categories.filter(c => !c.weak && c.id !== RUNS_ID);
    assertEq(others.every(c => c.adds.length === 0), true, 'no unlisted row was searched');
});

test('searchIds ADDS to the holes, it does not replace them', () => {
    // Naming only runs must not silence home runs, which is the hole the model found itself.
    const band = withRunner({ searchIds: new Set([RUNS_ID]) });
    const hr = band.categories.find(c => c.id === '5');
    assertEq(hr.weak, true, 'home runs is still a hole');
    assert(hr.adds.length > 0, 'and still has its list');
});

test('an empty or absent searchIds is the default, not a silencing', () => {
    const base = projectedBand().categories.find(c => c.id === '5');
    const empty = projectedBand({ searchIds: new Set() }).categories.find(c => c.id === '5');
    assertEq(empty.adds.length, base.adds.length, 'the holes are searched either way');
});

test('swap stays on the WEAK rows alone, unwidened', () => {
    // swap is one band-level fact repeated on the holes for the renderer; widening the shopping list must not change what `.find(r => r.swap)` picks up.
    const band = withRunner({ searchIds: new Set([RUNS_ID]) });
    const r = band.categories.find(c => c.id === RUNS_ID);
    assertEq(r.swap, null, 'a searched-but-not-weak row carries no swap');
    assert(band.categories.some(c => c.weak && c.swap), 'and the holes still carry it');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
