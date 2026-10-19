// Unit tests for the category-coverage model. Open tests/coverage-model.test.html through any static server; green means every assertion held. Every expected number is hand-computed from the formulas the model is given. The rate cases are the point of the file: a rate cannot be apportioned, so a share of the team total, the obvious way to name a driver, is wrong for ERA.
import {
    rateSpecFor, valueFrom, sumPlayers, idsToSum,
    contributionOf, driversFor, gainFrom, cheapestSwap, coverageBand, swapPair, rankAdds,
    dropLedger, ledgerFor
} from '../src/engines/coverage-model.js';

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
    // A team with no innings has no ERA. Zero would be the best in the league in a lower-is-better category.
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
    // With both: 2.10. Without the ace: 40*27/300 = 3.60. So the ace is worth 1.50 of ERA, and because lower ERA is better the sign turns positive: the ace makes the team better. A share of the team total would have credited the ace with 30/70 = 43% of the earned runs, blaming the best pitcher on the staff for the most damage.
    assertClose(contributionOf(ACE, '47', ROSTER, CTX), 1.5, 1e-9, 'the ace lowers ERA by 1.50');
    // The weaker arm RAISES it: without that arm the team is at 1.35, with it 2.10, so -0.75.
    assertClose(contributionOf(MID, '47', ROSTER, CTX), -0.75, 1e-9, 'the mid arm costs 0.75');
});

test('contributionOf: the last contributor has no measurable delta, and says so', () => {
    // Remove that player and the category has no figure at all. The contribution is the whole of it, which is not a difference, so it is null and not the team total presented as one.
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

test('cheapestSwap: the player who costs least across the scored categories', () => {
    // One scored category, home runs. The ace has 2 of the team's 3, the mid arm 1 - so the mid arm is the cheap one. Naming "the worst player" would have picked differently.
    const swap = cheapestSwap(ROSTER, ['5'], CTX);
    assertEq(swap.player.name, 'Mid', 'the cheaper player');
    assertClose(swap.cost, 1 / 3, 1e-9, 'one of the three home runs');
});

test('cheapestSwap: the SOLE holder of a category is never named as free to drop', () => {
    // A bat contributes nothing to ERA, so that cost is a true zero. If the batting average the bat alone holds were skipped for being unmeasurable, the bat would sort to the front as the cheapest player on the roster while being the only reason the team has an average. Zero is the one answer that cannot be right for a player who is the whole of a category.
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

test('cheapestSwap: a player who cannot touch the scored set costs nothing in it', () => {
    // In a league that scores batting average and nothing else, a pitcher is the cheapest player to lose, since there is nothing else for the model to charge. The set being priced has to be every category the league scores, so a pitcher in a league that also scores strikeouts is charged for the strikeouts.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', seasonTotals: { '1': 20, '0': 100 } };
    assertEq(cheapestSwap([ACE, a, b], ['2'], CTX).player.name, 'Ace', 'the pitcher');
});

test('cheapestSwap: a player in the INJURED-RESERVE slot is never the cheapest to lose', () => {
    // The same two hitters as the case above, where B costs 0.02/0.28 and A costs 0.08/0.28, so B is the cheapest by the arithmetic. Dropping B frees nothing, because B's seat is the injured-list slot. The next cheapest is the answer.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', irSlot: true, seasonTotals: { '1': 20, '0': 100 } };
    const swap = cheapestSwap([a, b], ['2'], CTX);
    assertEq(swap.player.name, 'Hitter A', 'the reserved seat is skipped');
    assertClose(swap.cost, 0.08 / 0.28, 1e-9, "and the named player's own cost is unchanged");
});

test('cheapestSwap: an injured player in a BENCH slot is still named', () => {
    // The test is the slot, never the injury. A player on the ten-day list who still occupies a bench or an active seat can be dropped for a real spot, and who can be spared is the question an injury makes easy to answer.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', out: true, injuryStatus: 'OUT', seasonTotals: { '1': 20, '0': 100 } };
    assertEq(cheapestSwap([a, b], ['2'], CTX).player.name, 'Hitter B', 'injured, benched, droppable');
});

test('cheapestSwap: a reserved player still counts toward the team they are measured against', () => {
    // The filter is on who is NAMED, not on what the roster is worth. Hitter A's cost is a share of the team average, and the team average includes the reserved bat: 140/500 =.280, and without A it is 20/100 =.200, a swing of.080. If the reserved player had been dropped from the roster before summing, A would have been the sole holder and the guard would have returned null instead.
    const a = { id: 3, name: 'Hitter A', seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', irSlot: true, seasonTotals: { '1': 20, '0': 100 } };
    assertClose(cheapestSwap([a, b], ['2'], CTX).cost, 0.08 / 0.28, 1e-9, 'measured against both bats');
});

test('cheapestSwap: a roster of nothing but reserved players names nobody', () => {
    // Null, not an arbitrary name. Every candidate is unnameable for the same reason, and the strip reads that as "no swap to offer" exactly as it does for a roster with nothing measurable.
    const a = { id: 3, name: 'Hitter A', irSlot: true, seasonTotals: { '1': 120, '0': 400 } };
    const b = { id: 4, name: 'Hitter B', irSlot: true, seasonTotals: { '1': 20, '0': 100 } };
    assertEq(cheapestSwap([a, b], ['2'], CTX), null, 'nobody frees a spot');
});

test('cheapestSwap: nothing measurable yields null rather than an arbitrary name', () => {
    assertEq(cheapestSwap(ROSTER, [], CTX), null, 'no scored categories');
    assertEq(cheapestSwap([], ['5'], CTX), null, 'no roster');
});

/**
 * Priced on every category, with the veto for a driver of a losing category.
 *
 * Three winning counting categories and one losing one: home runs (5), runs (20) and RBI (21)
 * against strikeouts (48). No rates among them, so every figure below is a plain share.
 *
 *   team   HR 35, R 100, RBI 100, K 100
 *   Bat1   20/35 + 50/100 + 50/100            = 1.571428...
 *   Bat2   10/35 + 30/100 + 30/100            = 0.885714...
 *   Bat3    5/35 + 20/100 + 20/100            = 0.542857...
 *   Arm1                            60/100    = 0.60
 *   Arm2                            40/100    = 0.40
 *
 * Priced on the winning set alone, both arms cost a flat zero and the first of them is named. Priced
 * on everything, Arm2 is cheapest at 0.40, and Arm2 is the second-biggest driver of the one category
 * the team is losing.
 */
const WIN_LOSE_CATS = ['5', '20', '21', '48'];
const Bat1 = { id: 11, name: 'Bat1', seasonTotals: { '5': 20, '20': 50, '21': 50 } };
const Bat2 = { id: 12, name: 'Bat2', seasonTotals: { '5': 10, '20': 30, '21': 30 } };
const Bat3 = { id: 13, name: 'Bat3', seasonTotals: { '5': 5, '20': 20, '21': 20 } };
const Arm1 = { id: 14, name: 'Arm1', seasonTotals: { '48': 60 } };
const Arm2 = { id: 15, name: 'Arm2', seasonTotals: { '48': 40 } };
const WIN_LOSE_ROSTER = [Bat1, Bat2, Bat3, Arm1, Arm2];

test('cheapestSwap: the cost is summed over EVERY scored category, not the winning set', () => {
    // No veto passed, so this is the pricing change on its own. Arm2 wins on 0.40, and the point of the case is what it beats: on the winning set alone (HR, R, RBI) both arms are zero and Arm1, being first in roster order, would have been named while carrying 60 of the team's 100 strikeouts.
    const swap = cheapestSwap(WIN_LOSE_ROSTER, WIN_LOSE_CATS, CTX);
    assertEq(swap.player.name, 'Arm2', 'the arm with the smaller strikeout line');
    assertClose(swap.cost, 0.4, 1e-9, '40 of the team 100 strikeouts, and nothing else charged');
});

test('cheapestSwap: a top-two driver of a LOSING category is never named', () => {
    // Strikeouts are what this team is losing, and its two drivers are Arm1 (60) and Arm2 (40). The arithmetic still says Arm2 is cheapest; the veto says a player the band is about to list as carrying a losing category cannot be the one it offers up in the same breath. The cheapest of what is left is Bat3, at 5/35 + 0.20 + 0.20.
    const swap = cheapestSwap(WIN_LOSE_ROSTER, WIN_LOSE_CATS, CTX, { losingIds: ['48'] });
    assertEq(swap.player.name, 'Bat3', 'the lightest bat, the arms being spoken for');
    assertClose(swap.cost, 5 / 35 + 0.4, 1e-9, 'the home-run share plus a fifth each of runs and RBI');
});

test('cheapestSwap: the veto reads the driver limit it is given', () => {
    // A limit of one vetoes Arm1 alone, so Arm2 is nameable again at its own 0.40 - the same number the unvetoed case computes. The limit is the band's own driverLimit so that what is suppressed is exactly what the reader is shown under "who carries it", never a wider set.
    const swap = cheapestSwap(WIN_LOSE_ROSTER, WIN_LOSE_CATS, CTX, { losingIds: ['48'], driverLimit: 1 });
    assertEq(swap.player.name, 'Arm2', 'only the top driver is spoken for');
    assertClose(swap.cost, 0.4, 1e-9, 'and the cost itself is untouched by the veto');
});

test('cheapestSwap: the veto suppresses the drivers of the category it is given, nobody else', () => {
    // Naming home runs as the losing category speaks for Bat1 and Bat2, its two drivers. The arms carry none of it, are not vetoed, and Arm2 is still the cheapest on the full set.
    const swap = cheapestSwap(WIN_LOSE_ROSTER, WIN_LOSE_CATS, CTX, { losingIds: ['5'] });
    assertEq(swap.player.name, 'Arm2', 'the home-run drivers are the ones spoken for');
});

test('cheapestSwap: nobody left after the veto is null, not the least-vetoed player', () => {
    // Two arms, one category, both of them its drivers. There is genuinely nobody to spare, and the strip draws that the same way it draws a roster with nothing measurable.
    assertEq(cheapestSwap([Arm1, Arm2], ['48'], CTX, { losingIds: ['48'] }), null, 'both spoken for');
});

// The swap pair. Errors (72) are the lower-is-better counting category. ERA (47) stays a lower-is-better rate and is untouched by any of this. Home runs (5) are the one category this team is winning.
const INV_CTX = {
    components: COMPONENTS,
    inverseIds: new Set(['47', '72']),
    slotsOf: (p) => new Set(p.slots || [])
};
// SS charging five errors, a clean second baseman, and an ace who charges none because a pitcher cannot commit a fielding error at all.
const GLOVE = { id: 21, name: 'Iron Glove', slot: 4, seasonTotals: { '5': 6, '72': 5 } };
const HANDS = { id: 22, name: 'Sure Hands', slot: 2, seasonTotals: { '5': 3, '72': 1 } };
const ARM = { id: 23, name: 'Rotation Arm', slot: 14, seasonTotals: { '5': 0, '72': 0 } };
const INV_ROSTER = [GLOVE, HANDS, ARM];
// The free agents. Big Arm is the better player by the winning category and charges nothing, and is a starting pitcher: the pair must refuse that arm.
const FA_GLOVE = { id: 31, name: 'Better Glove', slots: [4, 6], seasonTotals: { '5': 7, '72': 2 } };
const FA_ARM = { id: 32, name: 'Big Arm', slots: [14], seasonTotals: { '5': 20, '72': 0 } };
const FA_BUTTER = { id: 33, name: 'Butterfingers', slots: [4], seasonTotals: { '5': 9, '72': 8 } };

test('swapPair: the top charger, and a free agent who does the winning set as well for less', () => {
    // Team home runs are 6 + 3 = 9. Dropping Iron Glove leaves 3, so Iron Glove is 6 of the 9 - a contribution of 6/9 = 0.667. Better Glove joins a roster of 3 home runs and adds 7, which is 7/3 = 2.333, comfortably past the bar, and charges 2 errors against Iron Glove's 5.
    const pair = swapPair('72', INV_ROSTER, ['5'], [FA_GLOVE, FA_ARM, FA_BUTTER], INV_CTX);
    assertEq(pair.drop.name, 'Iron Glove', 'the roster charges most errors here');
    assertEq(pair.add.name, 'Better Glove', 'and this is the shortstop who charges fewer');
    assertClose(pair.saving, 3, 1e-9, 'five errors down to two');
    assertClose(pair.ratio, (7 / 3) / (6 / 9), 1e-9, 'the ratio achieved, not a bar applied');
    assertEq(pair.matched.join(','), '5', 'measured on the one category being won');
});

test('swapPair: the pitcher is REFUSED despite being the best answer on every other test', () => {
    // Big Arm charges a flat zero, because a starting pitcher cannot commit a fielding error, and is worth twenty home runs against Better Glove's seven. Unconstrained, Big Arm wins every time, and a manager would be told to drop a shortstop for a starter. The proof is that widening Big Arm's eligibility, and changing nothing else, hands over the pair.
    const strict = swapPair('72', INV_ROSTER, ['5'], [FA_ARM, FA_GLOVE], INV_CTX);
    assertEq(strict.add.name, 'Better Glove', 'the eligible one');
    const loose = swapPair('72', INV_ROSTER, ['5'], [FA_ARM, FA_GLOVE], {
        ...INV_CTX, slotsOf: () => new Set([2, 4, 14])
    });
    assertEq(loose.add.name, 'Big Arm', 'so the constraint is what was refusing the arm');
});

test('swapPair: a candidate who charges MORE is never the answer', () => {
    // Butterfingers is eligible and is worth more home runs than Better Glove, and charges eight errors against Iron Glove's five. The whole point of the pair is charging less.
    const pair = swapPair('72', INV_ROSTER, ['5'], [FA_BUTTER, FA_GLOVE], INV_CTX);
    assertEq(pair.add.name, 'Better Glove', 'nine home runs do not buy three more errors');
});

test('swapPair: no slot table, no pair', () => {
    // A chip that cannot check the move is legal is worse than no chip, so the refusal is the default rather than an unconstrained answer.
    const { slotsOf, ...noSlots } = INV_CTX;
    assertEq(swapPair('72', INV_ROSTER, ['5'], [FA_GLOVE], noSlots), null, 'refused outright');
});

test('swapPair: a reserved seat is never the drop', () => {
    // The same rule as the cheapest to lose (amendment 10): dropping a reserved player frees no roster spot, so the pair moves to the next charger down and prices against that one instead.
    const roster = [{ ...GLOVE, irSlot: true }, HANDS, ARM];
    const pair = swapPair('72', roster, ['5'], [{ id: 34, name: 'Steady', slots: [2], seasonTotals: { '5': 5, '72': 0 } }], INV_CTX);
    assertEq(pair.drop.name, 'Sure Hands', 'the charger who actually occupies a seat');
});

test('swapPair: nobody charges anything, so there is nothing to swap', () => {
    assertEq(swapPair('72', [ARM], ['5'], [FA_GLOVE], INV_CTX), null, 'a staff commits no errors');
});

test('coverageBand: an inverse counting HOLE carries the pair and an empty shopping list', () => {
    const sums = { 1: { '5': 9, '72': 6 }, 2: { '5': 4, '72': 1 } };
    const band = coverageBand({
        sumsByTeam: sums, teamId: 1, roster: INV_ROSTER, available: [FA_GLOVE, FA_ARM],
        categoryIds: ['5', '72'], components: COMPONENTS, inverseIds: INV_CTX.inverseIds,
        slotsOf: INV_CTX.slotsOf
    });
    const errors = band.categories.find(c => c.id === '72');
    assert(errors.weak, 'six errors against one is a hole');
    assertEq(errors.adds.length, 0, 'nobody is added FOR errors');
    assertEq(errors.pair.add.name, 'Better Glove', 'the pair has its own field');
    // Both fields are populated on the same row and they are different objects: `swap` is the band-level cheapest-to-lose repeated on every hole, `pair` is this category's own.
    assert(errors.swap && errors.swap.player, 'swap still carries the band-level answer');
    assertEq(errors.swap.add, undefined, 'and it never grew the pair shape');
});

test('coverageBand: an inverse counting category the team is WINNING draws nothing', () => {
    // The strip only asks about its losing set, and this is why that gate matters more here than elsewhere: MEASURED on a live league, a team winning an inverse category has its top charger come out with a NEGATIVE contribution to the winning set, because that set contains the category that charger charges in. There is no sensible pair for a player who is already a free drop.
    const sums = { 1: { '5': 9, '72': 1 }, 2: { '5': 20, '72': 9 } };
    const band = coverageBand({
        sumsByTeam: sums, teamId: 1, roster: INV_ROSTER, available: [FA_GLOVE],
        categoryIds: ['5', '72'], components: COMPONENTS, inverseIds: INV_CTX.inverseIds,
        slotsOf: INV_CTX.slotsOf
    });
    const errors = band.categories.find(c => c.id === '72');
    assertEq(errors.weak, false, 'fewer errors than the other team');
    assertEq(errors.pair, null, 'and no pair chip at all');
});

test('coverageBand: an inverse RATE keeps its shopping list', () => {
    // ERA is inverse and it is a rate, so a pitcher who lowers it is a real add and already reads as one. Only the COUNTING half loses its list.
    const sums = { 1: { '45': 70, '34': 900 }, 2: { '45': 30, '34': 900 } };
    const band = coverageBand({
        sumsByTeam: sums, teamId: 1, roster: [ACE, MID], available: [{ id: 41, name: 'Reliever', seasonTotals: { '45': 1, '34': 300 } }],
        categoryIds: ['47'], components: COMPONENTS, inverseIds: INV_CTX.inverseIds,
        slotsOf: INV_CTX.slotsOf
    });
    const era = band.categories.find(c => c.id === '47');
    assert(era.weak, 'the worse ERA');
    assert(era.adds.length > 0, 'and an arm to fix it');
});

// rankAdds. The league's own range, category by category, is the unit. This roster is short of home runs, 2 against a league best of 8, and rich in runs, which is the shape that breaks the obvious unit.
const RANK_SUMS = { 1: { '5': 2, '20': 100 }, 2: { '5': 8, '20': 40 }, 3: { '5': 5, '20': 70 } };
const RANK_CTX = { components: COMPONENTS, inverseIds: new Set(['47', '72']), sumsByTeam: RANK_SUMS };
const RANK_ROSTER = [{ id: 51, name: 'Incumbent', seasonTotals: { '5': 2, '20': 100 } }];
const BAT_A = { id: 52, name: 'Slugger', seasonTotals: { '5': 3, '20': 0 } };
const BAT_B = { id: 53, name: 'Table Setter', seasonTotals: { '5': 0, '20': 36 } };

test('rankAdds: the unit is the league RANGE, and it changes the order', () => {
    // Home runs range 8 - 2 = 6 across the league, and runs 100 - 40 = 60. Slugger's 3 home runs are 3/6 = 0.500 of the range, and Table Setter's 36 runs are 36/60 = 0.600, so Table Setter leads. As a share of the team's own total, Slugger's 3 against 2 reads 1.500 and Table Setter's 36 against 100 reads 0.360, and the order reverses. A share is largest where the roster has least.
    const rows = rankAdds([BAT_A, BAT_B], RANK_ROSTER, ['5', '20'], RANK_CTX);
    assertEq(rows.map(r => r.player.name).join(','), 'Table Setter,Slugger', 'the range decides');
    assertClose(rows[0].composite, 0.6, 1e-9, 'thirty-six of a sixty-run range');
    assertClose(rows[1].composite, 0.5, 1e-9, 'three of a six-home-run range');
});

test('rankAdds: the raw per-category gains ride along beside the composite', () => {
    const rows = rankAdds([BAT_A], RANK_ROSTER, ['5', '20'], RANK_CTX);
    assertClose(rows[0].gains['5'], 3, 1e-9, 'three home runs, in home runs');
    assertClose(rows[0].gains['20'], 0, 1e-9, 'and no runs');
});

test('rankAdds: a category every team is level in contributes zero and never divides', () => {
    // A zero range is a category no add can win, not an infinite opportunity. Dividing by it would put whoever touches it at the top of every mode for ever.
    const level = { 1: { '5': 2, '20': 50 }, 2: { '5': 8, '20': 50 } };
    const rows = rankAdds([BAT_B], RANK_ROSTER, ['5', '20'], { ...RANK_CTX, sumsByTeam: level });
    assert(Number.isFinite(rows[0].composite), 'a real number');
    assertClose(rows[0].composite, 0, 1e-9, 'thirty-six runs into a level league buys nothing');
    assertClose(rows[0].gains['20'], 36, 1e-9, 'though the gain itself is still reported');
});

test('rankAdds: an inverse COUNTING category is dropped from whatever set asked for it', () => {
    // Every mode. Errors have no add, which is what the pair exists for, and leaving them in would let a composite reward a player for the errors they do not commit.
    const sums = { 1: { '5': 2, '72': 6 }, 2: { '5': 8, '72': 1 } };
    const rows = rankAdds([BAT_A], RANK_ROSTER, ['5', '72'], { ...RANK_CTX, sumsByTeam: sums });
    assertEq(Object.keys(rows[0].gains).join(','), '5', 'home runs only');
});

test('rankAdds: an inverse RATE stays in the set', () => {
    const sums = { 1: { '45': 70, '34': 900 }, 2: { '45': 30, '34': 900 } };
    const rows = rankAdds([{ id: 61, name: 'Arm', seasonTotals: { '45': 1, '34': 300 } }],
        [ACE], ['47'], { ...RANK_CTX, sumsByTeam: sums });
    assertEq(Object.keys(rows[0].gains).join(','), '47', 'ERA is an add like any other');
    assert(rows[0].gains['47'] > 0, 'and lowering it is a positive gain');
});

test('rankAdds: a player marked out is never ranked, and an empty set returns nothing', () => {
    assertEq(rankAdds([{ ...BAT_A, out: true }], RANK_ROSTER, ['5'], RANK_CTX).length, 0, 'not named');
    assertEq(rankAdds([BAT_A], RANK_ROSTER, [], RANK_CTX).length, 0, 'nothing asked, nothing answered');
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


// The projected basis. These cases are built so the actuals and the forward basis give different answers, and they fail if the two are ever read as one. In the roster, Banked has nearly all of its home runs already recorded, and Steady has fewer recorded and more to come.
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
    // On the actuals Banked leads 40 to 10. On the forward basis Steady leads 9 to 6. Naming Banked as the driver of what is coming would be the error.
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

/**
 * A roster of four for the swap cases. Banked and Steady between them carry the whole of home runs,
 * the category this team is losing, so both are protected. Role A and Role B carry runs and no home
 * runs at all, so either may be named, and whether the basis changes who is cheapest can still be
 * asked. The roster sums match TWO_TEAM_SUMS, 50 home runs and 100 runs, so the standings the band
 * computes are the ones the other cases read.
 *
 *   actuals    HR      R          remainder    HR      R
 *   Banked     40     60          Banked        6      2
 *   Steady     10     20          Steady        9     20
 *   Role A      0     15          Role A        0      3
 *   Role B      0      5          Role B        0     12
 *   team       50    100          team         15     37
 */
const SP_BANKED = { id: 11, name: 'Banked', seasonTotals: { '5': 40, '20': 60 } };
const SP_STEADY = { id: 12, name: 'Steady', seasonTotals: { '5': 10, '20': 20 } };
const SP_ROLE_A = { id: 13, name: 'Role A', seasonTotals: { '20': 15 } };
const SP_ROLE_B = { id: 14, name: 'Role B', seasonTotals: { '20': 5 } };
const SP_BANKED_AHEAD = { id: 11, name: 'Banked', seasonTotals: { '5': 6, '20': 2 } };
const SP_STEADY_AHEAD = { id: 12, name: 'Steady', seasonTotals: { '5': 9, '20': 20 } };
const SP_ROLE_A_AHEAD = { id: 13, name: 'Role A', seasonTotals: { '20': 3 } };
const SP_ROLE_B_AHEAD = { id: 14, name: 'Role B', seasonTotals: { '20': 12 } };
const SPARE_ROSTER = [SP_BANKED, SP_STEADY, SP_ROLE_A, SP_ROLE_B];
const SPARE_AHEAD = [SP_BANKED_AHEAD, SP_STEADY_AHEAD, SP_ROLE_A_AHEAD, SP_ROLE_B_AHEAD];
const spareActuals = (extra = {}) => coverageBand({ ...BASE_BAND, roster: SPARE_ROSTER, ...extra });
const spareBand = (extra = {}) => coverageBand({
    ...BASE_BAND,
    roster: SPARE_ROSTER,
    projectedRoster: SPARE_AHEAD,
    projectedAvailable: [CLOSER_AHEAD, ROOKIE_AHEAD],
    window: { kind: 'rest', label: 'the rest of the way', matchup: null, periods: [163, 164], asOf: 162 },
    ...extra
});

test('the swap is costed on the remainder, over every category and not the winning set', () => {
    // Runs is the strong category on the actuals, 100 to 80, and home runs is the hole. Banked and Steady drive the hole on either basis, so neither can be named. Of the two left the answer changes with the basis: on the actuals Role B is cheapest, 5 of the 100 runs against Role A's 15, and on the forward basis Role A is, 3 of the 37 against Role B's 12.
    const actualsOnly = spareActuals();
    assertEq(actualsOnly.strongIds.join(), '20', 'runs is what the team is winning');
    const actualsSwap = actualsOnly.categories.find(c => c.id === '5').swap;
    assertEq(actualsSwap.player.name, 'Role B', 'actuals spare Role B');
    assertClose(actualsSwap.cost, 5 / 100, 1e-9, 'five of the hundred runs, and no home runs at all');
    const band = spareBand();
    assertEq(band.strongIds.join(), '20', 'the strong category is unchanged - it is an actuals fact');
    const swap = band.categories.find(c => c.id === '5').swap;
    assertEq(swap.player.name, 'Role A', 'the remainder spares Role A instead');
    assertClose(swap.cost, 3 / 37, 1e-9, 'three of the thirty-seven runs still to come');
});

test('the drivers of a LOSING category are never the ones offered up as spare', () => {
    // Banked has 6 of the 15 home runs still to come in the category this team is losing, and only 2 of the 37 runs. Priced on the winning set alone, Banked would be the cheapest player on the roster while being the second largest holder of what the team most needs. The veto refuses that.
    const band = spareBand();
    const hr = band.categories.find(c => c.id === '5');
    assertEq(hr.weak, true, 'home runs is the hole');
    assertEq(hr.drivers.map(d => d.player.name).join(), 'Steady,Banked', 'and these two carry it');
    assert(hr.swap.player.name !== 'Banked' && hr.swap.player.name !== 'Steady',
        `named a driver of the hole: ${hr.swap.player.name}`);
});

test('a roster whose every player drives the hole has nobody to spare', () => {
    // Banked and Steady are the whole of the home runs between them, so on a roster of the two of them alone there is nobody the band can offer. Null, and the strip draws that the same way it draws a roster with nothing measurable.
    assertEq(projectedBand().categories.find(c => c.id === '5').swap, null, 'nobody is spare');
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
    // Copied, not aliased: a caller changing its own array must not reach into the band.
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

// A player marked out is never named as an add. ESPN's projection for the rest of the season does not discount an injured player, so the forward line handed to this model is untrue for such a player. The model declines to name the player and does not adjust the player's worth.

test('an `out` candidate is never named as an add, however large its gain', () => {
    // On the forward basis the rookie leads home runs and the closer does not, which is what this pair of fixtures exists to show. So the rookie is the one to mark, and the closer takes the row.
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
    // The counterpart rule. The adds answer who to pick up, where an injured name is bad advice. The swap answers who can be spared, where an injured name is often the right one. Marking a roster player out must not change who is named there.
    const plain = spareBand().categories.find(c => c.swap);
    assertEq(plain.swap.player.name, 'Role A', 'the player this roster names');
    // Marked on the very player who is named, which is the case that would break first if `out` ever reached this filter: Role A is the cheapest to lose and is now also flagged injured.
    const marked = spareBand({
        projectedRoster: [SP_BANKED_AHEAD, SP_STEADY_AHEAD, { ...SP_ROLE_A_AHEAD, out: true }, SP_ROLE_B_AHEAD]
    }).categories.find(c => c.swap);
    assertEq(marked.swap.player.name, plain.swap.player.name, 'the same player is still the cheapest to lose');
});


// A category the roster holds none of. sumPlayers creates a key only for an id some roster player carries, so a team with no starting pitcher has no wins key at all. The roster holds none of the category, so the baseline is zero and the candidate's own line is the gain.

const BULLPEN = [
    { id: 41, name: 'Reliever A', seasonTotals: { '48': 60, '57': 20 } },
    { id: 42, name: 'Reliever B', seasonTotals: { '48': 55, '57': 15 } }
];
const STARTER = { id: 49, name: 'Starter', seasonTotals: { '48': 33, '53': 2, '63': 4 } };

test('a candidate gains its FULL line in a category the roster holds none of', () => {
    // The roster carries strikeouts and saves; it carries no wins and no quality starts at all.
    assertEq(sumPlayers(BULLPEN, ['48', '53', '63'])['53'], undefined, 'no wins key on the roster');
    assertEq(gainFrom(STARTER, '53', BULLPEN, CTX), 2, 'the whole of the starter wins is the gain');
    assertEq(gainFrom(STARTER, '63', BULLPEN, CTX), 4, 'and the whole of the quality starts');
});

test('a category the roster DOES hold still measures the difference, unchanged', () => {
    // The guard must not change the ordinary case: 115 + 33 - 115.
    assertEq(gainFrom(STARTER, '48', BULLPEN, CTX), 33, 'strikeouts are still a delta');
});

test('an EMPTY roster is the same case, not a special one', () => {
    assertEq(gainFrom(STARTER, '53', [], CTX), 2, 'a team with nobody holds none of everything');
});

test('an inverse counting category keeps its sign when the roster holds none', () => {
    // Errors are lower-is-better, so a candidate who commits them is a negative gain even when the roster has recorded none. The sign rule must survive the zero baseline.
    const clumsy = { id: 50, name: 'Clumsy', seasonTotals: { '72': 6 } };
    // This suite's fixture inverts only ERA, so the id is declared inverse here. The rule under test is the sign, not which ids carry it.
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
    assertEq(w.adds[0].gain, 2, 'for the whole of that line');
});


// searchIds: a list of adds for a category the caller calls losing. The caller ranks by its own list of losing categories and this model marks holes by share, and the two differ. searchIds lets the caller say which rows to look in. It adds to the holes and does not replace them, since the holes are computed here.

// Team 1 is ahead in runs, 100 to 80, so runs is not a hole, but a caller may still rank it as losing and want an add for it.
const RUNS_ID = '20';
// The fixture's two free agents carry no runs at all, so a search of that row would find nothing to name and prove nothing. This one carries runs, and is the candidate the runs row should surface.
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
    // swap is one band-level fact repeated on the holes for the renderer; widening the shopping list must not change what `.find(r => r.swap)` picks up. On the four-player roster, where somebody survives the veto and there is a swap to place.
    const band = spareBand({ searchIds: new Set([RUNS_ID]) });
    const r = band.categories.find(c => c.id === RUNS_ID);
    assertEq(r.swap, null, 'a searched-but-not-weak row carries no swap');
    assert(band.categories.some(c => c.weak && c.swap), 'and the holes still carry it');
});

/**
 * The drop ledger.
 *
 * Three teams and four scored categories chosen to cover every shape the ledger has to handle: home
 * runs (5) counting, batting average (2) a rate, ERA (47) an inverse rate, errors (72) an inverse
 * counting stat. Every figure below is hand-computed from the formulas, and the roster is on one
 * basis throughout.
 *
 * My roster, before the move:
 *   Slugger  HR 20   H  60 / AB 200                        E 8
 *   Utility  HR  5   H  40 / AB 200                        E 3
 *   Arm              ER 30 / outs 540  (own ERA 1.50)
 *   Arm2             ER 20 / outs 270  (own ERA 2.00)
 *   team     HR 25   AVG 100/400 = .250   ERA 50*27/810 = 1.666...   E 11
 *
 * Drop Utility, add Candidate (HR 12, H 30 / AB 100, E 1):
 *   team     HR 32   AVG  90/300 = .300   ERA unchanged               E 9
 *
 * The other two teams, on the same basis:
 *   team 2   HR 30   AVG 110/400 = .275   ERA 40*27/810 = 1.333...    E 6
 *   team 3   HR 22   AVG  90/400 = .225   ERA 60*27/810 = 2.000       E 14
 */
const LED_CATS = ['5', '2', '47', '72'];
const LED_SLUGGER = { id: 101, name: 'Slugger', seasonTotals: { '5': 20, '1': 60, '0': 200, '72': 8 } };
const LED_UTILITY = { id: 102, name: 'Utility', seasonTotals: { '5': 5, '1': 40, '0': 200, '72': 3 } };
const LED_ARM = { id: 103, name: 'Arm', seasonTotals: { '45': 30, '34': 540 } };
const LED_ARM2 = { id: 104, name: 'Arm2', seasonTotals: { '45': 20, '34': 270 } };
const LED_CANDIDATE = { id: 201, name: 'Candidate', seasonTotals: { '5': 12, '1': 30, '0': 100, '72': 1 } };
const LED_ROSTER = [LED_SLUGGER, LED_UTILITY, LED_ARM, LED_ARM2];
const LED_CTX = { components: COMPONENTS, inverseIds: new Set(['47', '72']) };
const LED_STANDINGS = {
    categoryIds: LED_CATS,
    teamId: '1',
    sumsByTeam: {
        1: { '5': 25, '1': 100, '0': 400, '45': 50, '34': 810, '72': 11 },
        2: { '5': 30, '1': 110, '0': 400, '45': 40, '34': 810, '72': 6 },
        3: { '5': 22, '1': 90, '0': 400, '45': 60, '34': 810, '72': 14 }
    }
};
const ledger = (extra = {}) =>
    dropLedger(LED_ROSTER, 102, LED_CANDIDATE, LED_CTX, { ...LED_STANDINGS, ...extra });
const ledRow = (id, extra) => ledger(extra).categories.find(c => c.id === id);

test('dropLedger: a COUNTING category, both lines and the team figure either side', () => {
    const hr = ledRow('5');
    assertEq(hr.before, 25, 'twenty-five before');
    assertEq(hr.after, 32, 'thirty-two after: twenty-five less five plus twelve');
    assertEq(hr.dropLine, 5, "the dropped player's own five");
    assertEq(hr.addLine, 12, "the candidate's own twelve");
    assertEq(hr.change, 7, 'seven to the good');
});

test('dropLedger: a RATE is rebuilt on both sides and for each player alone', () => {
    // The trap this case exists for:.200 and.300 do not average to the team's.300, and the dropped player's own average is not a share of the team's. Each is its own hits over its own at-bats. Team before 100/400 =.250; after 90/300 =.300.
    const avg = ledRow('2');
    assertClose(avg.before, 0.25, 1e-9, 'a hundred hits in four hundred at-bats');
    assertClose(avg.after, 0.3, 1e-9, 'ninety in three hundred');
    assertClose(avg.dropLine, 0.2, 1e-9, "the dropped player's own forty in two hundred");
    assertClose(avg.addLine, 0.3, 1e-9, "the candidate's own thirty in a hundred");
    assertClose(avg.change, 0.05, 1e-9, 'fifty points of average');
});

test('dropLedger: an INVERSE rate is signed in the direction it is scored', () => {
    // Neither player throws, so the staff ERA is untouched: 50 earned runs over 810 outs either way. The change is zero rather than null, and the dropped player has no ERA at all.
    const era = ledRow('47');
    assertClose(era.before, 50 * 27 / 810, 1e-9, 'the staff ERA');
    assertClose(era.after, 50 * 27 / 810, 1e-9, 'unchanged by a move between bats');
    assertEq(era.dropLine, null, 'a bat has no ERA, and that is null rather than zero');
    assertEq(era.addLine, null, 'nor does the candidate');
    assertClose(era.change, 0, 1e-9, 'no change');
});

test('dropLedger: an INVERSE counting category improves when the figure FALLS', () => {
    // Eleven errors become nine, which is better, so the change is POSITIVE. Reading the raw delta would call the best row on the ledger a loss.
    const e = ledRow('72');
    assertEq(e.before, 11, 'eleven errors');
    assertEq(e.after, 9, 'nine after: eleven less three plus one');
    assertEq(e.change, 2, 'two fewer errors reads as plus two');
    assertEq(e.dropLine, 3, 'the dropped three');
    assertEq(e.addLine, 1, "the candidate's one");
});

test('dropLedger: the standing either side, and the margin signed by which way it faces', () => {
    // Home runs: 25 is second of three behind team 2's 30, so the margin is the deficit, negative. 32 is first, so the margin becomes the cushion over the nearest team behind, positive.
    const hr = ledRow('5');
    assertEq(hr.rankBefore, 2, 'second before');
    assertEq(hr.rankAfter, 1, 'first after');
    assertEq(hr.margin.teamId, '2', 'the nearest team is the same one either way');
    assertEq(hr.margin.gap, 2, 'two clear of the thirty, and positive because it is a lead');
    // ERA: unmoved at 1.666..., second behind team 2's 1.333..., so still a deficit.
    const era = ledRow('47');
    assertEq(era.rankBefore, 2, 'second in ERA');
    assertEq(era.rankAfter, 2, 'and still second');
    assertClose(era.margin.gap, -(50 * 27 / 810 - 40 * 27 / 810), 1e-9, 'the deficit, negative');
    assertEq(era.margin.teamId, '2', 'to the team in front');
});

test('dropLedger: gained and lost are about the STANDING, not the figure', () => {
    // Errors improve by two and the standing does not move: still second, because team 3 is on fourteen and team 2 on six either way. A ledger that called that a gain would promise a manager something that cannot be spent.
    const led = ledger();
    assertEq(led.summary.gained.join(), '5,2', 'home runs and average both pass a team');
    assertEq(led.summary.lost.join(), '', 'nothing goes backwards');
    assertEq(led.summary.unchanged, 2, 'ERA and errors hold their place');
    const e = led.categories.find(c => c.id === '72');
    assertEq(e.change > 0, true, 'the figure improved');
    assertEq(e.rankBefore, e.rankAfter, 'and the standing did not');
});

test('dropLedger: the raw delta is carried beside the scored change, for the inverse rows', () => {
    // Frame X1 prints "-1" for an error saved and colours it as a gain. `delta` is what it prints, `change` is what decides the colour, and on a non-inverse row the two are the same number.
    const e = ledRow('72');
    assertEq(e.delta, -2, 'two fewer errors, raw');
    assertEq(e.change, 2, 'and two to the good, scored');
    const hr = ledRow('5');
    assertEq(hr.delta, 7, 'a counting category reads the same either way');
    assertEq(hr.change, 7, 'both plus seven');
});

test('dropLedger: the margin either side, so a lead can be said to grow or shrink', () => {
    // A lead that grows and a lead that shrinks are comparisons, so both margins are carried. Home runs go from a deficit of 5 behind team 2 to a lead of 2 over the same team, which is the one case where the sign itself changes.
    const hr = ledRow('5');
    assertEq(hr.marginBefore.teamId, '2', 'behind team 2 before');
    assertEq(hr.marginBefore.gap, -5, 'by five');
    assertEq(hr.margin.gap, 2, 'and two clear of them after');
    // Errors: second either side, the deficit to team 2 narrowing from five to three.
    const e = ledRow('72');
    assertEq(e.marginBefore.gap, -5, 'five errors adrift');
    assertEq(e.margin.gap, -3, 'three after, still second');
});

test('dropLedger: the place is the caller rule, and null when none is supplied', () => {
    assertEq(ledger().summary.placeBefore, null, 'not asked is null');
    assertEq(ledger().summary.placeAfter, null, 'on both sides');
    // A stand-in rule: place by home runs alone. Before the move this team is second of three on 25, after it is first on 32 - so the ledger carries the rule's answer straight through.
    const placeFrom = (valuesByTeam, teamId) => {
        const order = Object.keys(valuesByTeam).sort((a, b) => valuesByTeam[b]['5'] - valuesByTeam[a]['5']);
        return order.indexOf(String(teamId)) + 1;
    };
    const led = ledger({ placeFrom });
    assertEq(led.summary.placeBefore, 2, 'second before');
    assertEq(led.summary.placeAfter, 1, 'first after');
});

test('dropLedger: a drop with no candidate is the same ledger with nothing added', () => {
    // The state a manager is in before they have picked anybody up. Home runs fall from 25 to 20.
    const led = dropLedger(LED_ROSTER, 102, null, LED_CTX, LED_STANDINGS);
    const hr = led.categories.find(c => c.id === '5');
    assertEq(hr.after, 20, 'twenty-five less the dropped five');
    assertEq(hr.addLine, null, 'nobody is being added, which is null and not zero');
    assertEq(hr.change, -5, 'five to the bad');
    assertEq(hr.rankAfter, 3, 'and last of the three');
    assertEq(led.summary.lost.join(), '5', 'home runs is what the drop costs');
});

/**
 * The standing is where the season ends.
 *
 * The same move as above, Utility out and Candidate in on the same forward lines, now with this
 * team's own season so far supplied as banked, and every team's sums on the banked-plus-forward
 * basis. Two categories: errors (72), the inverse counting case, and batting average (2), a rate.
 *
 *                 banked          forward roster        season end
 *   mine before   E 20            E 11                   E 31
 *                 H 300 / AB 1200 H 100 / AB 400        400/1600 = .2500
 *   mine after    E 20            E  9  (11 - 3 + 1)     E 29
 *                 H 300 / AB 1200 H  90 / AB 300        390/1500 = .2600
 *   team 2                                               E 30    420/1600 = .2625
 *   team 3                                               E 33    380/1600 = .2375
 */
const BANKED_CATS = ['2', '72'];
const BANKED_STANDINGS = {
    categoryIds: BANKED_CATS,
    teamId: '1',
    banked: { '1': 300, '0': 1200, '72': 20 },
    sumsByTeam: {
        1: { '1': 400, '0': 1600, '72': 31 },
        2: { '1': 420, '0': 1600, '72': 30 },
        3: { '1': 380, '0': 1600, '72': 33 }
    }
};
const bankedLedger = () => dropLedger(LED_ROSTER, 102, LED_CANDIDATE, LED_CTX, BANKED_STANDINGS);
const bankedRow = (id) => bankedLedger().categories.find(c => c.id === id);

test('dropLedger: banked plus forward, an INVERSE counting category', () => {
    // Thirty-one errors on the season become twenty-nine. Team 2 sits on thirty, so the move passes them: second becomes first, a deficit of one becomes a lead of one.
    const e = bankedRow('72');
    assertEq(e.before, 31, 'twenty banked and eleven to come');
    assertEq(e.after, 29, 'the banked twenty untouched, nine to come');
    assertEq(e.change, 2, 'two to the good, scored');
    assertEq(e.delta, -2, 'and minus two, raw');
    assertEq(e.rankBefore, 2, 'second, a single error behind team 2');
    assertEq(e.rankAfter, 1, 'first');
    assertEq(e.marginBefore.gap, -1, 'one error adrift of team 2');
    assertEq(e.margin.teamId, '2', 'and one clear of the same team');
    assertEq(e.margin.gap, 1, 'a lead, so positive');
});

test('dropLedger: the lines traded are still the FORWARD lines, never the banked ones', () => {
    // What a dropped player already produced stays this team's, and what a candidate produced before arriving never was. The part of each that changes hands is what is still to come.
    const e = bankedRow('72');
    assertEq(e.dropLine, 3, "the dropped player's three to come");
    assertEq(e.addLine, 1, "the candidate's one");
});

test('dropLedger: banked plus forward, a RATE rebuilt from both sets of components', () => {
    // The forward-only ledger calls this move.250 to.300, fifty points. On the season it is 400/1600 to 390/1500, ten points: the forward line is a hundred at-bats against twelve hundred banked, and the rate is rebuilt from the components and not averaged across the two.
    const avg = bankedRow('2');
    assertClose(avg.before, 0.25, 1e-9, 'four hundred hits in sixteen hundred at-bats');
    assertClose(avg.after, 0.26, 1e-9, 'three ninety in fifteen hundred');
    assertClose(avg.change, 0.01, 1e-9, 'ten points, not fifty');
    assertClose(avg.dropLine, 0.2, 1e-9, "the dropped player's own forward .200");
    assertClose(avg.addLine, 0.3, 1e-9, "the candidate's own forward .300");
    // And it moves the standing less than the forward line would have claimed: still second, the deficit to team 2's.2625 closing from.0125 to.0025.
    assertEq(avg.rankBefore, 2, 'second before');
    assertEq(avg.rankAfter, 2, 'still second');
    assertClose(avg.marginBefore.gap, -0.0125, 1e-9, 'twelve and a half points adrift');
    assertClose(avg.margin.gap, -0.0025, 1e-9, 'two and a half after');
});

test('dropLedger: the basis decides the answer - the same move, ranked two ways', () => {
    // On the forward line alone the errors row holds at second; on the season it takes first. Neither reading is a fault in the arithmetic. They are two questions, and banked is how the caller says which one it is asking.
    const forwardOnly = ledRow('72');
    assertEq(forwardOnly.rankBefore, 2, 'forward alone, second');
    assertEq(forwardOnly.rankAfter, 2, 'and still second');
    const season = bankedRow('72');
    assertEq(season.rankAfter, 1, 'on the season, first');
    assertEq(bankedLedger().summary.gained.join(), '72', 'so the season ledger counts it gained');
});

test('dropLedger: a category banked but with nothing still to come still has a figure', () => {
    // A roster whose forward line carries no errors at all, over a season that has banked some. Absent from the forward sums is not zero on the season: twenty banked is twenty.
    const bats = [
        { id: 301, name: 'A', seasonTotals: { '1': 10, '0': 40 } },
        { id: 302, name: 'B', seasonTotals: { '1': 10, '0': 40 } }
    ];
    const led = dropLedger(bats, 302, null, LED_CTX, BANKED_STANDINGS);
    const e = led.categories.find(c => c.id === '72');
    assertEq(e.before, 20, 'the banked twenty, with nothing added to it');
    assertEq(e.after, 20, 'and unmoved by dropping a player who carries none');
});

test('dropLedger: an unknown player or an empty category set is null, not a guess', () => {
    assertEq(dropLedger(LED_ROSTER, 999, LED_CANDIDATE, LED_CTX, LED_STANDINGS), null, 'nobody by that id');
    assertEq(dropLedger(LED_ROSTER, 102, LED_CANDIDATE, LED_CTX, { ...LED_STANDINGS, categoryIds: [] }),
        null, 'nothing scored');
});

test('dropLedger: with no other teams the figures stand and the standing is null', () => {
    // The ledger still answers what a manager gains and loses. It cannot say where that puts the team. The rank is null and not one, which would claim a standing that was never computed, and those rows are then in none of gained, lost or unchanged.
    const led = dropLedger(LED_ROSTER, 102, LED_CANDIDATE, LED_CTX,
        { ...LED_STANDINGS, sumsByTeam: { 1: LED_STANDINGS.sumsByTeam[1] } });
    const hr = led.categories.find(c => c.id === '5');
    assertEq(hr.after, 32, 'the figure is unaffected');
    assertEq(hr.rankBefore, null, 'no standing to compute');
    assertEq(hr.margin, null, 'and no margin');
    assertEq(led.summary.unchanged, 0, 'nothing was ranked, so nothing held its place');
});

// ==== ledgerFor, the general form dropLedger is ledgerFor passing one and one, so the eighty-eight cases above ARE the wrapper's proof. These cover only what the general form adds: more than one player each way. ====

test('ledgerFor: dropLedger is exactly this function, one and one', () => {
    const viaWrapper = dropLedger(LED_ROSTER, 102, LED_CANDIDATE, LED_CTX, LED_STANDINGS);
    const direct = ledgerFor(LED_ROSTER, { out: [102], in: [LED_CANDIDATE] }, LED_CTX, LED_STANDINGS);
    assertEq(JSON.stringify(direct), JSON.stringify(viaWrapper), 'the same object, field for field');
});

test('ledgerFor: two out and one in moves both lines', () => {
    // Utility (5: 5) and Arm2 (no home runs) leave; the candidate (5: 12) arrives.
    const two = ledgerFor(LED_ROSTER, { out: [102, 104], in: [LED_CANDIDATE] }, LED_CTX, LED_STANDINGS);
    const hr = two.categories.find(c => c.id === '5');
    assertEq(hr.before, 25, 'twenty-five before, as ever');
    // 25 - 5 (Utility) + 12 (Candidate) = 32.
    assertEq(hr.after, 32, 'the utility out and the candidate in');
    assertEq(hr.dropLine, 5, 'the COMBINED line of everyone going out - only Utility has home runs');
    assertEq(hr.addLine, 12, 'and of everyone coming in');
});

test('ledgerFor: a rate is rebuilt from the combined components, not averaged', () => {
    // Both arms leave: ER 30+20 = 50 over outs 540+270 = 810, which is an ERA of 50*27/810.
    const two = ledgerFor(LED_ROSTER, { out: [103, 104], in: [] }, LED_CTX, LED_STANDINGS);
    const era = two.categories.find(c => c.id === '47');
    assertEq(Math.round(era.dropLine * 1000) / 1000, Math.round((50 * 27 / 810) * 1000) / 1000,
        'the two arms as one line, rebuilt through valueFrom');
});

test('ledgerFor: two in as well, which is the trade case', () => {
    const second = { id: 202, name: 'Second', seasonTotals: { '5': 3, '1': 10, '0': 40 } };
    const swap = ledgerFor(LED_ROSTER, { out: [101], in: [LED_CANDIDATE, second] }, LED_CTX, LED_STANDINGS);
    const hr = swap.categories.find(c => c.id === '5');
    assertEq(hr.addLine, 15, 'twelve and three');
    assertEq(hr.dropLine, 20, "the slugger's own twenty");
    assertEq(hr.after, 25 - 20 + 15, 'and the team figure follows both');
});

test('ledgerFor: an id naming nobody is not out', () => {
    const ghost = ledgerFor(LED_ROSTER, { out: [102, 999], in: [] }, LED_CTX, LED_STANDINGS);
    const one = ledgerFor(LED_ROSTER, { out: [102], in: [] }, LED_CTX, LED_STANDINGS);
    assertEq(JSON.stringify(ghost), JSON.stringify(one), 'the 999 changes nothing');
});

test('ledgerFor: nobody out at all is null, as it always was', () => {
    assertEq(ledgerFor(LED_ROSTER, { out: [], in: [LED_CANDIDATE] }, LED_CTX, LED_STANDINGS), null,
        'a ledger of no move is not a ledger');
    assertEq(ledgerFor(LED_ROSTER, { out: [999], in: [] }, LED_CTX, LED_STANDINGS), null, 'nor of nobody');
    assertEq(ledgerFor(LED_ROSTER, {}, LED_CTX, LED_STANDINGS), null, 'nor of nothing');
});

test('ledgerFor: a player object may be given instead of an id', () => {
    const byObject = ledgerFor(LED_ROSTER, { out: [LED_UTILITY], in: [] }, LED_CTX, LED_STANDINGS);
    const byId = ledgerFor(LED_ROSTER, { out: [102], in: [] }, LED_CTX, LED_STANDINGS);
    assertEq(JSON.stringify(byObject), JSON.stringify(byId), 'the same either way');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
