// Unit tests for the trade evaluator (trade.js). Open tests/trade.test.html through any static server; green means every assertion held. The expected values are hand-computed in the fixture's expected block and were checked before being written down. Nothing here is taken from a run of this code. Every player, team and category is invented.
import { evaluateTrade, fairness } from '../src/engines/trade.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const FIX = await (await fetch('fixtures/trade.json')).json();
const CTX = {
    components: null,
    inverseIds: new Set(FIX.inverseIds),
    categoryIds: FIX.categoryIds,
    sumsByTeam: FIX.sumsByTeam,
    myTeamId: FIX.myTeamId,
    theirTeamId: FIX.theirTeamId,
    slots: FIX.slots
};
const RESULT = evaluateTrade({ mine: FIX.mine, theirs: FIX.theirs, give: FIX.give, get: FIX.get }, CTX);

// ==== both sides ====

test('my side is the hand-computed one, category by category', () => {
    assertJson(RESULT.mine.perCategory, FIX.expected.mine.perCategory, 'three rows');
});

test('their side likewise', () => {
    assertJson(RESULT.theirs.perCategory, FIX.expected.theirs.perCategory, 'three rows');
});

test('BOTH SIDES MOVE AT ONCE, which is the case that proves the implementation', () => {
    // My "20" falls to 32. Against their AFTER row of 34 that is 3rd; against their BEFORE row of 31 it would be 2nd. An evaluator reading a static opponent gets this wrong and looks right.
    const mine20 = RESULT.mine.perCategory.find(c => c.statId === '20');
    assertEq(mine20.after, 32, 'my total falls to 32');
    assertEq(mine20.rankBefore, 1, 'first before the trade');
    assertEq(mine20.rankAfter, 3, 'and THIRD after it, because their 31 became 34');
    const theirs20 = RESULT.theirs.perCategory.find(c => c.statId === '20');
    assertEq(theirs20.rankAfter, 1, 'they take the category I gave up');
});

test('an unchanged category is genuinely unchanged', () => {
    const mine10 = RESULT.mine.perCategory.find(c => c.statId === '10');
    assertEq(mine10.before, 35, 'thirty-five either way');
    assertEq(mine10.after, 35, 'the two out and the one in cancel exactly');
    assertEq(mine10.delta, 0, 'so the delta is zero');
    assertEq(mine10.rankBefore, mine10.rankAfter, 'and the rank does not move');
});

test('an inverse category improves by falling, and the delta stays raw', () => {
    const mine30 = RESULT.mine.perCategory.find(c => c.statId === '30');
    assertEq(mine30.after, 15, 'seventeen down to fifteen');
    assertEq(mine30.delta, -2, 'the RAW after-minus-before, direction not folded in');
    assertEq(mine30.rankAfter < mine30.rankBefore, true, 'while the RANK improves, 2 to 1');
});

test('the verdict counts ranks, not deltas', () => {
    assertJson(RESULT.mine.verdict, FIX.expected.mine.verdict, 'up 1, down 1, net -1');
    assertJson(RESULT.theirs.verdict, FIX.expected.theirs.verdict, 'up 1, down 0, net +2');
    // "30" moved 2 in raw total for them and did not move their rank at all, which is the whole reason the verdict is about the standing.
    const theirs30 = RESULT.theirs.perCategory.find(c => c.statId === '30');
    assertEq(theirs30.delta, 2, 'a raw change');
    assertEq(theirs30.rankBefore, theirs30.rankAfter, 'and no change where it counts');
});

test('netRankPlaces is places GAINED, so positive is better', () => {
    assertEq(RESULT.theirs.verdict.netRankPlaces, 2, 'they gain two places');
    assertEq(RESULT.mine.verdict.netRankPlaces, -1, 'and I lose one');
});

// ==== the seats ====

test('the seats are counted per group, with the league own shape beside them', () => {
    assertJson(RESULT.mine.seats, FIX.expected.mine.seats, 'mine');
    assertJson(RESULT.theirs.seats, FIX.expected.theirs.seats, 'theirs');
});

test('filled is counted raw and open comes from openNeeds, which is why both are reported', () => {
    // openNeeds stops at zero, so it reports nothing open for three centres in two seats. That is right, and it cannot say three of two. The count says it, and the open figure stays the strip's.
    assertEq(RESULT.mine.seats.C.before, 3, 'three centres');
    assertEq(RESULT.mine.seats.C.slots, 2, 'in two seats');
    assertEq(RESULT.mine.seats.C.openBefore, 0, 'with nothing open, which is a different fact');
    assertEq(RESULT.mine.seats.G.openAfter, 1, 'and the goalie seat opens up');
});

test('the goalie is the consequence the category table cannot show', () => {
    assertEq(RESULT.mine.seats.G.before, 1, 'I had one');
    assertEq(RESULT.mine.seats.G.after, 0, 'and I have none');
    assertEq(RESULT.mine.seats.G.slots, 1, 'against a league that starts one');
    assertEq(RESULT.theirs.seats.G.after, 2, 'while they now have two');
});

// ==== the words ====

test('fairness says what moved, in words', () => {
    const f = fairness(RESULT);
    assertEq(f.summary, FIX.expected.fairness.summary, 'the categories');
    assertEq(f.places, FIX.expected.fairness.places, 'the places');
});

test('a seat falling below what the league starts is a warning, and it is a fact', () => {
    const f = fairness(RESULT);
    assertJson(f.warnings, FIX.expected.fairness.warnings, 'one warning, about the goalie');
    assertEq(f.warnings[0].includes('do not'), false, 'never advice');
    assertEq(f.warnings[0].includes('%'), false, 'and never a number it cannot know');
});

test('there is no percentage anywhere in the words', () => {
    const f = fairness(RESULT);
    const all = [f.summary, f.places, ...f.warnings].join(' ');
    assertEq(all.includes('%'), false, 'a trade is not 63% fair');
    assertEq(/\bfair\b|\bunfair\b|\bwin\b|\blose the trade\b/i.test(all), false, 'and it is not graded');
});

test('a side that gains nothing reads as losing none rather than as a blank', () => {
    const f = fairness(RESULT);
    assertEq(f.summary.includes('lose none'), true, 'they lose no categories, and it says so');
});

// ==== refusals ====

test('a trade with nobody in it is null', () => {
    assertEq(evaluateTrade({ mine: FIX.mine, theirs: FIX.theirs, give: [], get: [] }, CTX), null,
        'no move is not a trade');
    assertEq(evaluateTrade({}, CTX), null, 'nor is nothing at all');
});

test('an id naming nobody on that roster is not in the trade', () => {
    const ghost = evaluateTrade(
        { mine: FIX.mine, theirs: FIX.theirs, give: [...FIX.give, 'nobody'], get: FIX.get }, CTX);
    assertJson(ghost.mine.perCategory, RESULT.mine.perCategory, 'the same trade');
});

test('a one-way move prices the side that gives, and says nothing it cannot', () => {
    // Giving with nothing back, which is what a manager sees before the other side has offered anything.
    const oneWay = evaluateTrade({ mine: FIX.mine, theirs: FIX.theirs, give: ['m1'], get: [] }, CTX);
    const hr = oneWay.mine.perCategory.find(c => c.statId === '10');
    assertEq(hr.after, 25, 'thirty-five less the ten m1 carries');
    // The receiving side has no ledger, because ledgerFor refuses a move with nobody out. So the rows are empty and not invented, and the seats still move, because the roster did.
    assertJson(oneWay.theirs.perCategory, [], 'no rows for a side that sends nothing');
    assertEq(oneWay.theirs.seats.C.before, 3, 'three centres');
    assertEq(oneWay.theirs.seats.C.after, 4, 'and four once m1 arrives');
    assertJson(oneWay.theirs.verdict, { categoriesUp: 0, categoriesDown: 0, netRankPlaces: 0 },
        'a verdict of nothing, not a verdict of zero improvement');
});

test('fairness of nothing is null, not an empty sentence', () => {
    assertEq(fairness(null), null, 'no result');
    assertEq(fairness({}), null, 'nor half a one');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
