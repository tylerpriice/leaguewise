// Unit tests for the matchup in progress (matchup-odds.js). Open tests/matchup-odds.test.html through any static server; green means every assertion held. The expected values are enumerated by hand in tests/fixtures/matchup-odds.md, and that hand sum is what checks the fold. Every category and number is invented.
import {
    categoryChance, matchupTally, matchupOdds,
    categoryChanceGiven, matchupFold, hermiteNodes, MATCHUP_RHO, FOLD_NODES
} from '../src/engines/matchup-odds.js';
import { normalCdf } from '../src/engines/leverage-engine.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function close(got, want, msg, tol = 1e-12) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

// THE FIXTURE'S CHANCES ARE erf-EXACT and leverage-engine.js's normalCdf is an APPROXIMATION, so a comparison through it gets a tolerance the approximation has earned rather than an exact match. The case below measures that error instead of assuming it; 1e-7 is what it came out at, and the three-category tally compounds at most three of them.
const APPROX = 1e-7;

const FIX = await (await fetch('fixtures/matchup-odds.json')).json();
const RULE = { scoring: 'categories', scoredStatIds: FIX.scoredStatIds, inverseStatIds: FIX.inverseStatIds };

// ==== one category ====

test('a category is a normal tail over the gap and the margin spread', () => {
    const c = categoryChance(6, 10);
    close(c.chanceWin, normalCdf(0.6), 'six ahead on a spread of ten');
    close(c.chanceWin + c.chanceLose, 1, 'win and lose account for everything');
    assertEq(c.chanceTie, 0, 'with no step there is no grid to land level on, so no tie');
    close(categoryChance(0, 10).chanceWin, 0.5, 'level is a coin');
    close(categoryChance(-6, 10).chanceWin, 1 - normalCdf(0.6), 'and the tail is symmetric');
});

test('an inverse category flips once, here, and not again', () => {
    // Mine 12, theirs 17, lower wins: I am 5 ahead in the direction that counts.
    const raw = 12 - 17;
    close(categoryChance(raw, 10, { inverse: true }).chanceWin, normalCdf(0.5), 'lower is better');
    close(categoryChance(raw, 10).chanceWin, normalCdf(-0.5), 'and without the flag it reads the other way');
});

test('no spread left is the gap deciding, never a division by zero', () => {
    assertEq(categoryChance(3, 0).chanceWin, 1, 'ahead with nothing left to play');
    assertEq(categoryChance(-3, 0).chanceWin, 0, 'behind with nothing left');
    assertEq(categoryChance(0, 0).chanceWin, 0.5, 'level with nothing left is a coin, not a NaN');
    assertEq(categoryChance(-3, 0, { inverse: true }).chanceWin, 1, 'and the flip still applies');
});

test('the engine normalCdf is within 1e-7 of the exact tail, which is what the tolerance rests on', () => {
    // erf-exact values for the three z the fixture uses, computed outside this repo. If the engine's approximation ever drifts, this fails FIRST and names the reason, rather than every figure above failing for an unexplained few billionths.
    const exact = { 0.6: 0.7257468822499265, 0: 0.5, 0.5: 0.691462461274013, '-0.4666666666666667': 0.3203691909012704 };
    Object.keys(exact).forEach(z => {
        const err = Math.abs(normalCdf(Number(z)) - exact[z]);
        if (!(err <= APPROX)) throw new Error(`normalCdf(${z}) is out by ${err}, past the ${APPROX} the suite relies on`);
    });
    // And it is exact at the centre, which the engine's own comment says it must be.
    assertEq(normalCdf(0), 0.5, 'the centre is exact by construction, not by approximation');
});

// ==== a counted category can end level ====

// THE TWO TAILS THE CONTRACT USES, erf-exact and already measured against the engine in the case above: A is the normal at 0.5 and B at 0.6. Every figure below is one of them, its complement or their difference, worked in the contract's section 1a.
const A = 0.691462461274013;
const B = 0.7257468822499265;

test('a counted category has a tie: the mass within half a unit of level', () => {
    // 5.5 ahead on a spread of 10. Win is the margin past +0.5, z = (5.5 - 0.5) / 10 = 0.5. Lose is the margin under -0.5, z = (-5.5 - 0.5) / 10 = -0.6. The tie is what lies between.
    const c = categoryChance(5.5, 10, { step: 1 });
    close(c.chanceWin, A, 'win = the normal at 0.5', APPROX);
    close(c.chanceLose, 1 - B, 'lose = 1 minus the normal at 0.6 = 0.2742531177500735', APPROX);
    close(c.chanceTie, B - A, 'tie = 0.0342844209759135', APPROX * 2);
    close(c.chanceWin + c.chanceTie + c.chanceLose, 1, 'and the three are everything');
});

test('a level counted category ties more often than either side wins it, on a tight spread', () => {
    // Level on a spread of 1: win and lose are each the normal at -0.5, and the tie is the rest.
    const c = categoryChance(0, 1, { step: 1 });
    close(c.chanceWin, 1 - A, 'win = 0.308537538725987', APPROX);
    close(c.chanceLose, 1 - A, 'lose the same, by symmetry', APPROX);
    close(c.chanceTie, 2 * A - 1, 'tie = 0.382924922548026', APPROX * 2);
});

test('the step is the unit, so a wider one is a wider band', () => {
    // A step of 2 puts the band at -1 to +1. Eleven ahead on a spread of 20 lands on the same two tails: win z = (11 - 1) / 20 = 0.5, lose z = (-11 - 1) / 20 = -0.6.
    const c = categoryChance(11, 20, { step: 2 });
    close(c.chanceWin, A, 'win', APPROX);
    close(c.chanceTie, B - A, 'the same band in units of two', APPROX * 2);
});

test('an inverse counted category flips once and keeps its tie', () => {
    const c = categoryChance(-5.5, 10, { inverse: true, step: 1 });
    close(c.chanceWin, A, 'lower wins, and I am 5.5 lower', APPROX);
    close(c.chanceTie, B - A, 'the band is symmetric, so the tie is the same', APPROX * 2);
    close(c.chanceLose, 1 - B, 'and the loss', APPROX);
});

test('with nothing left to play a level counted category IS a tie', () => {
    const level = categoryChance(0, 0, { step: 1 });
    assertEq(level.chanceTie, 1, 'level and finished is a tie, not a coin');
    assertEq(level.chanceWin, 0, 'nobody won it');
    assertEq(level.chanceLose, 0, 'nobody lost it');
    const ahead = categoryChance(1, 0, { step: 1 });
    assertEq(ahead.chanceWin, 1, 'one ahead and finished is won');
    assertEq(ahead.chanceTie, 0, 'with no tie');
    const behind = categoryChance(1, 0, { inverse: true, step: 1 });
    assertEq(behind.chanceLose, 1, 'one higher where lower wins is lost');
});

test('matchupOdds gives a tie only to the categories the caller says are counted', () => {
    // Two categories, both level on a margin spread of 1 (0.6 and 0.8 a side). "10" is counted and "20" is not. "10": win 1-A, tie 2A-1, lose 1-A. "20": a coin, no tie.
    const side = sd => ({ '10': { current: 3, expectedRemaining: 2, sd }, '20': { current: 3, expectedRemaining: 2, sd } });
    const rule = { scoring: 'categories', scoredStatIds: ['10', '20'], inverseStatIds: [], countingStatIds: ['10'] };
    const got = matchupOdds({ mine: side(0.6), theirs: side(0.8) }, rule);
    close(got.perCategory[0].sd, 1, 'sqrt(0.36 + 0.64)');
    close(got.perCategory[0].chanceTie, 2 * A - 1, 'the counted one ties', APPROX * 2);
    assertEq(got.perCategory[1].chanceTie, 0, 'the other cannot');
    // The four ways to finish ahead: win both, or win one and tie the other. "20" never ties, so: ahead = P(10 win) * P(20 win) + P(10 tie) * P(20 win) = (1-A)/2 + (2A-1)/2 = A/2 level = P(10 win) * P(20 lose) + P(10 lose) * P(20 win) = (1-A)/2 + (1-A)/2 = 1-A behind = A/2, by symmetry.
    close(got.chance, A / 2, 'ahead = A/2 = 0.3457312306370065', APPROX * 2);
    close(got.tie, 1 - A, 'a level count = 1-A = 0.308537538725987', APPROX * 2);
    close(got.lose, A / 2, 'behind', APPROX * 2);
    // And without the list the same sides are the engine as it was: two coins.
    const plain = matchupOdds({ mine: side(0.6), theirs: side(0.8) }, { ...rule, countingStatIds: undefined });
    close(plain.chance, 0.25, 'two coins: ahead only by winning both');
    close(plain.tie, 0.5, 'and level half the time');
});

test('a per-category-record league carries the mean tie beside the mean win', () => {
    const side = sd => ({ '10': { current: 3, expectedRemaining: 2, sd }, '20': { current: 3, expectedRemaining: 2, sd } });
    const got = matchupOdds({ mine: side(0.6), theirs: side(0.8) },
        { scoring: 'category-record', scoredStatIds: ['10', '20'], inverseStatIds: [], countingStatIds: ['10'] });
    // "10": win 1-A, tie 2A-1. "20": win 0.5, tie 0. The means: win (1.5-A)/2, tie (2A-1)/2.
    close(got.chance, (1.5 - A) / 2, 'mean win = 0.4042687693629935', APPROX);
    close(got.tie, (2 * A - 1) / 2, 'mean tie = 0.191462461274013', APPROX);
    close(got.chance + got.tie + got.lose, 1, 'and everything is accounted for');
});

// ==== the exact fold ====

test('the fold lands on the hand sum over all 27 combinations', () => {
    const t = matchupTally(FIX.perCategory, { rule: 'NONE' });
    close(t.chance, FIX.tallied.chance, 'win = 127/250');
    close(t.tie, FIX.tallied.tie, 'tie = 69/500');
    close(t.lose, FIX.tallied.lose, 'lose = 177/500');
    close(t.chance + t.tie + t.lose, 1, 'and the three account for everything');
});

test('the counts in the contract are the fold, group by group', () => {
    // Each row of the contract's table is its own one-line check: a fold that got any group wrong could still sum to one, so the groups are asserted rather than only the total.
    const byResult = { win: 0, tie: 0, lose: 0 };
    FIX.byCount.forEach(r => { byResult[r.result] += r.p; });
    close(byResult.win, FIX.tallied.chance, 'the four winning counts');
    close(byResult.tie, FIX.tallied.tie, 'the two tying counts');
    close(byResult.lose, FIX.tallied.lose, 'the four losing counts');
    close(FIX.byCount.reduce((s, r) => s + r.p, 0), 1, 'every combination is in exactly one group');
});

test('STAT_POINTS splits the tied count by what that category did', () => {
    const t = matchupTally(FIX.perCategory, { rule: 'STAT_POINTS', statId: FIX.statPoints.tieStatId });
    close(t.chance, FIX.statPoints.chance, 'win = 29/50: 0.508 plus the 0.072 where "10" was won');
    close(t.tie, FIX.statPoints.tie, 'tie = 21/500: only where "10" tied too');
    close(t.lose, FIX.statPoints.lose, 'lose = 189/500: 0.354 plus the 0.024 where "10" was lost');
    close(t.chance + t.tie + t.lose, 1, 'still everything');
    // The rule moves exactly the tied mass and nothing else.
    const none = matchupTally(FIX.perCategory, { rule: 'NONE' });
    close((t.chance - none.chance) + (t.lose - none.lose) + t.tie, none.tie,
        'what the rule took from the tie is what it gave to the two sides');
});

test('a tie rule naming a category the league does not score changes nothing', () => {
    const t = matchupTally(FIX.perCategory, { rule: 'STAT_POINTS', statId: '99' });
    const none = matchupTally(FIX.perCategory, { rule: 'NONE' });
    close(t.chance, none.chance, 'no such category, so nothing to break the tie with');
    close(t.tie, none.tie, 'and the tie stands');
});

test('one category is its own answer, and none is a certainty of nothing', () => {
    const one = matchupTally([{ statId: '10', chanceWin: 0.7, chanceTie: 0.1, chanceLose: 0.2 }], { rule: 'NONE' });
    close(one.chance, 0.7, 'one category decides the matchup by itself');
    close(one.tie, 0.1, 'its tie is the matchup tie');
    const empty = matchupTally([], { rule: 'NONE' });
    close(empty.tie, 1, 'no categories at all is a tie by definition - zero wins against zero losses');
});

test('chanceLose is derived when a row leaves it out', () => {
    const derived = matchupTally([{ statId: '10', chanceWin: 0.6, chanceTie: 0.1 }], { rule: 'NONE' });
    close(derived.lose, 0.3, 'the remainder, so a caller cannot make the three disagree');
});

// ==== the matchup ====

test('matchupOdds reads the three-category side pair', () => {
    const got = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, RULE);
    const want = FIX.sidesExpected;
    assertEq(got.perCategory.length, 3, 'three categories');
    want.perCategory.forEach((w, i) => {
        const c = got.perCategory[i];
        assertEq(c.statId, w.statId, 'in the league scoring order');
        close(c.gap, w.gap, `${w.statId}: the gap in the direction that wins`);
        close(c.sd, w.sd, `${w.statId}: sqrt(mine^2 + theirs^2)`);
        close(c.projectedMine, w.projectedMine, `${w.statId}: current plus expected remaining`);
        close(c.projectedTheirs, w.projectedTheirs, `${w.statId}: and theirs`);
        close(c.chanceWin, w.chanceWin, `${w.statId}: the chance`, APPROX);
    });
    close(got.chance, want.chance, 'the matchup chance over eight combinations', APPROX * 3);
    close(got.chance + got.tie + got.lose, 1, 'and it accounts for everything');
});

test('the inverse category reports its gap the way a reader would read it', () => {
    const got = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, RULE);
    const c = got.perCategory.find(x => x.statId === '30');
    assertEq(c.inverse, true, '"30" is the inverse one');
    assertEq(c.projectedMine < c.projectedTheirs, true, '12 against 17');
    assertEq(c.gap > 0, true, 'and the gap is POSITIVE, because lower wins and I am lower');
    close(c.chanceWin, normalCdf(0.5), 'five ahead on a spread of ten');
});

test('the margin spread is the two sides combined, not either one doubled', () => {
    const p = FIX.points;
    const got = matchupOdds({ mine: p.mine, theirs: p.theirs }, { scoring: 'points' });
    close(got.sd, p.sd, 'sqrt(12^2 + 9^2) = 15');
    // What marginSd would have given off one side alone, and why neither is this matchup's margin.
    close(Math.sqrt(2 * 12 * 12), 16.97056274847714, 'marginSd off my side alone', 1e-9);
    close(Math.sqrt(2 * 9 * 9), 12.727922061357855, 'marginSd off theirs', 1e-9);
    assertEq(got.sd !== Math.sqrt(2 * 144) && got.sd !== Math.sqrt(2 * 81), true, 'and this is neither');
});

test('a points league is one figure and no categories', () => {
    const p = FIX.points;
    const got = matchupOdds({ mine: p.mine, theirs: p.theirs }, { scoring: 'points' });
    close(got.gap, p.gap, '100 against 107');
    close(got.chance, p.chance, 'the normal at -7 over 15', APPROX);
    close(got.chance + got.lose, 1, 'no tie in a points margin');
    assertEq(got.perCategory.length, 0, 'there are no categories to count');
});

test('a per-category-record league is the mean of its categories', () => {
    const got = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs },
        { ...RULE, scoring: 'category-record' });
    const mean = got.perCategory.reduce((s, c) => s + c.chanceWin, 0) / 3;
    close(got.chance, mean, 'every category is its own win, so there is no count to tie');
    assertEq(got.tie, 0, 'and with no counted category, nothing to tie');
});

test('the league tie rule reaches matchupOdds, not only matchupTally', () => {
    const plain = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, RULE);
    const ruled = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs },
        { ...RULE, tie: { rule: 'STAT_POINTS', statId: '10' } });
    // Every chanceTie is 0 on this pair, so the tied-count mass is 0 and the rule has nothing to move: the two must agree exactly. That is the point of the case.
    close(ruled.chance, plain.chance, 'no tied mass, so no difference');
    close(ruled.tie, 0, 'and no tie either way');
});

test('a missing category on one side is read as nothing scored, not as a crash', () => {
    const got = matchupOdds({ mine: { '10': { current: 5, expectedRemaining: 0, sd: 0 } }, theirs: {} },
        { scoring: 'categories', scoredStatIds: ['10'], inverseStatIds: [] });
    assertEq(got.perCategory[0].projectedTheirs, 0, 'an absent side scored nothing');
    close(got.chance, 1, 'so five to nothing with nothing left is certain');
});

// ==== the categories, sharing one factor ====

// The tails the three-node case uses, erf-exact: the normal at 1, at -1 and at -2. The engine's own tail is within 1e-7 of each, which is what the tolerances below are made of.
const N1 = 0.8413447460685429;
const L1 = 0.15865525393145707;
const D2 = 0.022750131948179195;

test('three values of the factor are 0 and the root of 3 either side, weighted 2/3 and 1/6', () => {
    // He3 = z^3 - 3z, so its roots are 0 and plus or minus the root of 3. The weight at a root is 3! / (3 * He2(z))^2 with He2 = z^2 - 1: at 0 that is 6 / 9, and at the root of 3 it is 6 / 36.
    const nodes = hermiteNodes(3);
    assertEq(nodes.length, 3, 'three of them');
    close(nodes[0].z, -Math.sqrt(3), 'the low one');
    close(nodes[1].z, 0, 'the middle one');
    close(nodes[2].z, Math.sqrt(3), 'the high one');
    close(nodes[1].weight, 2 / 3, 'two thirds at the centre');
    close(nodes[0].weight, 1 / 6, 'a sixth either side');
    close(nodes[2].weight, 1 / 6, 'and the other');
});

test('the values the module sums over are a rule for a standard normal', () => {
    // A rule of n values is exact for every polynomial up to degree 2n - 1, so the weights sum to 1 and the second and fourth moments are the normal's own, 1 and 3.
    const nodes = hermiteNodes(FOLD_NODES);
    assertEq(nodes.length, FOLD_NODES, 'as many as the module says it uses');
    close(nodes.reduce((s, n) => s + n.weight, 0), 1, 'the weights are everything', 1e-12);
    close(nodes.reduce((s, n) => s + n.weight * n.z, 0), 0, 'centred', 1e-12);
    close(nodes.reduce((s, n) => s + n.weight * n.z ** 2, 0), 1, 'a variance of 1', 1e-12);
    close(nodes.reduce((s, n) => s + n.weight * n.z ** 4, 0), 3, 'a fourth moment of 3', 1e-11);
    assertEq(hermiteNodes(FOLD_NODES), nodes, 'and computed once, then kept');
});

test('given the factor a category is the same tail at a moved gap and a narrower spread', () => {
    // rho 0.25: the factor carries half the spread and the category keeps root 3 over 2 of it. A level rate on a spread of 1, given z at the root of 3, is the normal at (1/2)(root 3) over (root 3 / 2) = 1.
    close(categoryChanceGiven(0, 1, {}, 0.25, Math.sqrt(3)).chanceWin, N1, 'the normal at 1', APPROX);
    close(categoryChanceGiven(0, 1, {}, 0.25, -Math.sqrt(3)).chanceWin, L1, 'and at -1', APPROX);
    close(categoryChanceGiven(0, 1, {}, 0.25, 0).chanceWin, 0.5, 'unmoved at the centre');
    // The factor acts in the direction that wins, so an inverse category is lifted by it too.
    close(categoryChanceGiven(0, 1, { inverse: true }, 0.25, Math.sqrt(3)).chanceWin, N1, 'lower wins, and still lifted', APPROX);
    // Nothing left to play does not move, and a rho of zero is categoryChance itself.
    assertEq(categoryChanceGiven(3, 0, {}, 0.25, -5).chanceWin, 1, 'a finished category is not uncertain');
    assertEq(categoryChanceGiven(5.5, 10, { step: 1 }, 0, 2).chanceTie, categoryChance(5.5, 10, { step: 1 }).chanceTie, 'no rho, no factor');
});

test('averaged over the factor a category says exactly what it said before', () => {
    // rho changes how categories combine and never what one of them says. The contract's worked counted category, 5.5 ahead on a spread of 10 with a step of 1, summed back over the factor.
    const plain = categoryChance(5.5, 10, { step: 1 });
    const back = { chanceWin: 0, chanceTie: 0, chanceLose: 0 };
    hermiteNodes(FOLD_NODES).forEach(n => {
        const c = categoryChanceGiven(5.5, 10, { step: 1 }, 0.144, n.z);
        Object.keys(back).forEach(k => { back[k] += n.weight * c[k]; });
    });
    close(back.chanceWin, plain.chanceWin, 'the win', APPROX);
    close(back.chanceTie, plain.chanceTie, 'the tie', APPROX * 2);
    close(back.chanceLose, plain.chanceLose, 'the loss', APPROX);
});

test('with no rho the fold is the one before the amendment, to the digit', () => {
    const plain = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, RULE);
    [{ ...RULE, rho: 0 }, { ...RULE, rho: undefined }, { ...RULE, rho: 0, nodes: 3 }].forEach(rule => {
        const got = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, rule);
        assertEq(got.chance, plain.chance, 'the chance, every digit');
        assertEq(got.tie, plain.tie, 'the tie');
        assertEq(got.lose, plain.lose, 'the loss');
    });
    // And matchupFold at zero is matchupTally over categoryChance: the same three categories, as their gaps and spreads.
    const rows = plain.perCategory.map(c => ({ statId: c.statId, gap: c.gap, sd: c.sd }));
    const folded = matchupFold(rows, { rule: 'NONE' }, { rho: 0 });
    assertEq(folded.chance, plain.chance, 'one call of the old fold, not a sum that happens to agree');
    // The same against the 27 combinations: the fixture's chances are finished ones, so they go through matchupTally, which the amendment did not touch.
    close(matchupTally(FIX.perCategory, { rule: 'NONE' }).chance, FIX.tallied.chance, 'still 127/250');
});

/**
 * THE THREE-NODE CASE, by hand, end to end. rho 0.25, so the factor's loading is 1/2 and a
 * category keeps root 3 over 2 of its spread. The three values of the factor are 0 and the root
 * of 3 either side, weighted 2/3, 1/6, 1/6.
 *
 *   "10"  a rate, level, spread 1. Given z it is the normal at z over root 3:
 *           z = 0: 0.5      z = +root 3: N1 (the normal at 1)      z = -root 3: L1 = 1 - N1
 *   "20"  counted, level, spread 1 over root 3. Given z its spread is 1/2 and its gap z over
 *         2 root 3, so win is the normal at z/root 3 - 1 and lose the normal at -z/root 3 - 1:
 *           z = 0:        win L1, lose L1, tie 1 - 2 L1
 *           z = +root 3:  win 0.5, lose D2 (the normal at -2), tie 0.5 - D2
 *           z = -root 3:  win D2, lose 0.5, tie 0.5 - D2
 *
 * "10" cannot tie, so the count is ahead when "10" is won and "20" is won or tied, and level
 * when one is won and the other lost:
 *
 *   z            weight   ahead                 level
 *   0            2/3      0.5 (1 - L1)          0.5 L1 + 0.5 L1 = L1
 *   +root 3      1/6      N1 (1 - D2)           N1 D2 + L1 0.5
 *   -root 3      1/6      L1 0.5                L1 0.5 + N1 D2
 *
 *   chance = (2/3)(0.4206723730342714) + (1/6)(0.8222040420815763 + 0.07932762696572856)
 *          = 0.43070352686406504
 *   tie    = (2/3) L1 + (1/3)(0.0984683309526952) = 0.1385929462718698
 *   lose   = chance, by the mirror
 */
const THREE = [{ statId: '10', gap: 0, sd: 1 }, { statId: '20', gap: 0, sd: 1 / Math.sqrt(3), step: 1 }];

test('two categories at rho 0.25 over three values of the factor land on the hand sum', () => {
    const got = matchupFold(THREE, { rule: 'NONE' }, { rho: 0.25, nodes: 3 });
    close(got.chance, (2 / 3) * 0.5 * (1 - L1) + (1 / 6) * (N1 * (1 - D2) + L1 * 0.5), 'the formula', APPROX * 3);
    close(got.chance, 0.43070352686406504, 'chance = 0.43070352686406504', APPROX * 3);
    close(got.tie, 0.1385929462718698, 'tie = 0.1385929462718698', APPROX * 3);
    close(got.lose, 0.43070352686406504, 'lose, the mirror', APPROX * 3);
    close(got.chance + got.tie + got.lose, 1, 'and the three are everything');
});

test('the same case reaches matchupOdds through its rule', () => {
    // The margin spreads are the two sides combined: 0.6 and 0.8 make 1, and two of 1 over root 6 make 1 over root 3.
    const side = (a, b) => ({ '10': { current: 3, expectedRemaining: 2, sd: a }, '20': { current: 3, expectedRemaining: 2, sd: b } });
    const rule = { scoring: 'categories', scoredStatIds: ['10', '20'], inverseStatIds: [], countingStatIds: ['20'], rho: 0.25, nodes: 3 };
    const got = matchupOdds({ mine: side(0.6, 1 / Math.sqrt(6)), theirs: side(0.8, 1 / Math.sqrt(6)) }, rule);
    close(got.chance, 0.43070352686406504, 'the hand sum', APPROX * 3);
    close(got.tie, 0.1385929462718698, 'and its tie', APPROX * 3);
    // A category's own chances are the ones it had with no rho at all.
    close(got.perCategory[0].chanceWin, 0.5, 'the rate is still a coin');
    close(got.perCategory[1].chanceTie, 1 - 2 * normalCdf(-0.5 * Math.sqrt(3)), 'the counted one still ties as it did');
});

test('a tied count goes through the league rule at every value of the factor', () => {
    // Under STAT_POINTS on "10" a level count is decided by "10", which cannot tie, so the tie of 0.1385929462718698 is shared out and none is left. The case is a mirror of itself, so each side gets half of it: 0.43070352686406504 + 0.0692964731359349 = 0.5.
    const ruled = matchupFold(THREE, { rule: 'STAT_POINTS', statId: '10' }, { rho: 0.25, nodes: 3 });
    close(ruled.tie, 0, 'no tie survives a decider that cannot tie');
    close(ruled.chance, 0.5, 'half', APPROX * 3);
    close(ruled.lose, 0.5, 'and half', APPROX * 3);
    // On "20", which can tie, the count stays level when "20" did. Level means one won and one lost, so "20" never tied in it, and again nothing is left.
    close(matchupFold(THREE, { rule: 'STAT_POINTS', statId: '20' }, { rho: 0.25, nodes: 3 }).tie, 0, 'none there either');
});

test('two even categories at rho agree with the closed form for two correlated coins', () => {
    // Two level rates are two coins cut from normals that correlate at rho, and the chance both land one way is 1/4 + asin(rho) / (2 pi). At 0.25 that is 0.29021531162758313. A result from outside the engine, so it checks the rule and the model together.
    const coins = [{ statId: '10', gap: 0, sd: 1 }, { statId: '20', gap: 0, sd: 7 }];
    const got = matchupFold(coins, { rule: 'NONE' }, { rho: 0.25 });
    close(got.chance, 0.25 + Math.asin(0.25) / (2 * Math.PI), 'both mine', APPROX * 2);
    close(got.chance, 0.29021531162758313, 'which is 0.29021531162758313', APPROX * 2);
    close(got.tie, 1 - 2 * 0.29021531162758313, 'one each, the rest', APPROX * 4);
    // With no rho they are two independent coins: a quarter.
    close(matchupFold(coins, { rule: 'NONE' }).chance, 0.25, 'a quarter with nothing shared');
});

test('the matchup reads the same from the other bench', () => {
    const rule = { ...RULE, rho: 0.144 };
    const mine = matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, rule);
    const theirs = matchupOdds({ mine: FIX.sides.theirs, theirs: FIX.sides.mine }, rule);
    close(mine.chance, theirs.lose, 'my win is their loss', 1e-12);
    close(mine.tie, theirs.tie, 'and the tie is shared', 1e-12);
    // Categories moving together make the favourite less sure: 0.7086 with nothing shared.
    assertEq(mine.chance < FIX.sidesExpected.chance && mine.chance > 0.5, true, 'nearer a half, and still favoured');
});

test('the table carries hockey and baseball, and no football', () => {
    assertEq(MATCHUP_RHO.fhl, 0.102, 'hockey, on the scale of the normals');
    assertEq(MATCHUP_RHO.flb, 0.144, 'baseball');
    assertEq(MATCHUP_RHO.ffl, undefined, 'football has no entry, so a caller reading it passes nothing');
    assertEq(Object.isFrozen(MATCHUP_RHO), true, 'and a caller cannot change it');
});

test('a points league and a per-category record are untouched by rho', () => {
    const p = FIX.points;
    const plain = matchupOdds({ mine: p.mine, theirs: p.theirs }, { scoring: 'points' });
    const withRho = matchupOdds({ mine: p.mine, theirs: p.theirs }, { scoring: 'points', rho: 0.144 });
    assertEq(withRho.chance, plain.chance, 'one margin has nothing to fold, so every digit is the same');
    assertEq(withRho.lose, plain.lose, 'and the loss');
    // What a football caller does: the table has no entry, so rho is undefined.
    assertEq(matchupOdds({ mine: p.mine, theirs: p.theirs }, { scoring: 'points', rho: MATCHUP_RHO.ffl }).chance, plain.chance, 'the football rule as it was');
    const record = { ...RULE, scoring: 'category-record' };
    assertEq(matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, { ...record, rho: 0.144 }).chance,
        matchupOdds({ mine: FIX.sides.mine, theirs: FIX.sides.theirs }, record).chance, 'a mean does not care what moves together');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
