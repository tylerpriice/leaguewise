// Unit tests for the pure leverage engine. Open tests/leverage-engine.test.html through any static server (python -m http.server is a zero-dependency option) - green means every assertion held. Every expected value is hand-computed from the rules written on the functions; the normal-CDF figures are the standard published values, so a failure means the engine changed, not the maths.
import {
    normalCdf, MEDIAN_Z, weeklyMoments, projectedMoments, poolMoments, teamTotalMoments,
    marginSd, rateMarginSd, reach, flipChance, categoryFlip, flipsPerWeek,
    countingShift, rateShift
} from '../leverage-engine.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: got ${a}, expected ${b}`);
}
// Every probability here is a float, so equality is to a tolerance. 1e-9 is far tighter than the CDF approximation's own 7.5e-8 for the closed-form cases and is the right bar for arithmetic.
function assertClose(actual, expected, tol, msg) {
    if (!(Math.abs(actual - expected) <= tol)) {
        throw new Error(`${msg}: got ${actual}, expected ${expected} +-${tol}`);
    }
}

// The published values of the standard normal CDF. Nothing in this file derives them.
const PHI_0_5 = 0.6914624612740131;
const PHI_1 = 0.8413447460685429;
const PHI_1_5 = 0.9331927987311419;
// The CDF approximation is good to 7.5e-8. A REACH is two-sided - 2*Phi(z) - 1 - so it carries that error twice, and asserting a reach to 1e-7 fails on a correct engine. The tolerance is the documented bound, not a number chosen because the test passed at it.
const CDF_ERR = 7.5e-8;
const REACH_ERR = 2 * CDF_ERR;

test('normalCdf: the published values, inside the approximation error', () => {
    assertEq(normalCdf(0), 0.5, 'zero is exactly half');
    assertClose(normalCdf(1), PHI_1, CDF_ERR, 'one sigma');
    assertClose(normalCdf(-1), 1 - PHI_1, CDF_ERR, 'symmetric about zero');
    assertClose(normalCdf(1.959963985), 0.975, CDF_ERR, 'the 95% two-sided point');
    assertClose(normalCdf(0.5), PHI_0_5, CDF_ERR, 'half a sigma');
    assertClose(normalCdf(1.5), PHI_1_5, CDF_ERR, 'one and a half');
    assertEq(normalCdf(Infinity), 1, 'the far tail');
    assertEq(normalCdf(-Infinity), 0, 'the other one');
    // 0.6745 sigma is the median half-width: it holds exactly half the mass.
    assertClose(2 * normalCdf(MEDIAN_Z) - 1, 0.5, REACH_ERR, 'the median z');
});

test('weeklyMoments: the mean, and the UNBIASED weekly variance', () => {
    // [2,4,6]: mean 4, deviations -2/0/+2, sum of squares 8, divided by n-1 = 2 -> 4.
    assertEq(weeklyMoments([2, 4, 6]), { mean: 4, variance: 4, n: 3 }, 'three weeks');
    // A player who does the same thing every week has no weekly variance.
    assertEq(weeklyMoments([3, 3, 3, 3]), { mean: 3, variance: 0, n: 4 }, 'no spread at all');
    // One week is a mean and no evidence about spread. Zero, not a divide by zero.
    assertEq(weeklyMoments([5]), { mean: 5, variance: 0, n: 1 }, 'a single week');
    assertEq(weeklyMoments([]), null, 'no weeks is null, not zero');
    assertEq(weeklyMoments(null), null, 'no samples at all');
    // A missing week is not a zero week - it is dropped, not counted as a shutout.
    assertEq(weeklyMoments([2, null, 6, undefined, NaN]), { mean: 4, variance: 8, n: 2 }, 'gaps are dropped');
});

test('projectedMoments: a season line over the league\'s matchups, Poisson spread', () => {
    // 42 home runs across 21 matchups is 2 a week, and Poisson puts the variance at the mean.
    assertEq(projectedMoments(42, 21), { mean: 2, variance: 2, n: 0 }, 'two a week');
    assertEq(projectedMoments(0, 21), { mean: 0, variance: 0, n: 0 }, 'a projection of nothing');
    assertEq(projectedMoments(42, 0), null, 'no matchups is null, not a divide by zero');
    assertEq(projectedMoments(null, 21), null, 'no projection is null');
});

test('poolMoments: BOTH sources of spread, by the law of total variance', () => {
    // Two players: means 2 and 4, own weekly variances 1 and 3. mean = (2+4)/2 = 3 within = (1+3)/2 = 2 (each player's own week-to-week swing) between = ((2-3)^2 + (4-3)^2)/2 = 1 (population, not sample: this IS the pool) variance = 2 + 1 = 3
    assertEq(poolMoments([{ mean: 2, variance: 1 }, { mean: 4, variance: 3 }]),
        { mean: 3, variance: 3, n: 2 }, 'within plus between');
    // Dropping the between term is the mistake this test exists to catch: identical players still have a pool variance, and it is their own weekly swing.
    assertEq(poolMoments([{ mean: 3, variance: 2 }, { mean: 3, variance: 2 }]),
        { mean: 3, variance: 2, n: 2 }, 'identical players still vary week to week');
    // And players who never vary still make a pool that varies, because they differ from each other.
    assertEq(poolMoments([{ mean: 1, variance: 0 }, { mean: 3, variance: 0 }]),
        { mean: 2, variance: 1, n: 2 }, 'metronomes who are not the same metronome');
    assertEq(poolMoments([]), null, 'an empty pool');
});

test('teamTotalMoments and marginSd: seats, then two teams', () => {
    // 4 seats drawn from a pool of {mean 3, variance 3}: mean 12, variance 12.
    assertEq(teamTotalMoments({ mean: 3, variance: 3 }, 4), { mean: 12, variance: 12 }, 'four seats');
    // The margin is the difference of two such teams: variance doubles, so sd = sqrt(2*12).
    assertClose(marginSd({ mean: 12, variance: 12 }), Math.sqrt(24), 1e-12, 'two independent teams');
    assertEq(teamTotalMoments({ mean: 3, variance: 3 }, 0), null, 'a category with no seats');
    assertEq(teamTotalMoments(null, 4), null, 'no pool');
    // 2 seats on a pool variance of 3 -> team variance 6 -> margin sd sqrt(12).
    assertClose(marginSd(teamTotalMoments({ mean: 3, variance: 3 }, 2)), Math.sqrt(12), 1e-12, 'the chain');
});

test('reach and flipChance: within the week, versus turned by it', () => {
    // A shift of exactly one sigma. Reach is the two-sided mass; the flip is half of it, because only the margins that were going the other way are worth anything.
    assertClose(reach(3, 3), 2 * PHI_1 - 1, REACH_ERR, 'one sigma of reach');
    assertClose(flipChance(3, 3), PHI_1 - 0.5, REACH_ERR, 'and half of it flips');
    assertClose(reach(1.5, 3), 2 * PHI_0_5 - 1, REACH_ERR, 'half a sigma');
    assertClose(reach(4.5, 3), 2 * PHI_1_5 - 1, REACH_ERR, 'one and a half sigma');
    // Magnitude only - a shift of -2 reaches exactly as far as a shift of +2. The direction is categoryFlip's business, not reach's.
    assertClose(reach(-3, 3), reach(3, 3), 1e-12, 'reach is a distance');
    assertEq(reach(0, 3), 0, 'a player who does nothing reaches nothing');
    assertEq(reach(3, 0), null, 'a category with no spread is not a probability');
    assertEq(flipChance(3, -1), null, 'a negative sd is not a distribution');
});

test('categoryFlip: the sign is the direction the player moves it, not the category\'s polarity', () => {
    const good = categoryFlip(2, 2, { inverse: false });
    assertClose(good.flip, PHI_1 - 0.5, REACH_ERR, 'a home run helps');
    assertEq(good.direction, 1, 'positive');
    // The same two-a-week in an inverse category is two of a thing that LOSES it.
    const caught = categoryFlip(2, 2, { inverse: true });
    assertClose(caught.flip, -(PHI_1 - 0.5), REACH_ERR, 'being caught stealing costs the same amount');
    assertEq(caught.direction, -1, 'negative');
    // A rate is the case the naive rule gets backwards: a pitcher pulls the team's ERA DOWN, and down is how an inverse category is won.
    const era = categoryFlip(-1, 2, { inverse: true });
    assertClose(era.flip, PHI_0_5 - 0.5, REACH_ERR, 'a good pitcher helps an inverse rate');
    assertEq(era.direction, 1, 'two negatives');
    assertEq(categoryFlip(2, 0), null, 'no distribution, no leverage');
});

test('flipsPerWeek: unknown categories contribute NOTHING - not zero, not a penalty', () => {
    const out = flipsPerWeek([
        { categoryId: '5', flip: 0.3 },
        { categoryId: '24', flip: -0.1 },
        { categoryId: '69', flip: null }
    ]);
    assertClose(out.total, 0.2, 1e-12, 'the two that can be measured');
    assertEq(out.counted, 2, 'the third is absent, not zero');
    assertEq(out.byCategory, { 5: 0.3, 24: -0.1 }, 'and it is absent from the breakdown too');
    assertEq(flipsPerWeek([{ categoryId: '5', flip: null }]), null, 'nothing measurable anywhere');
    assertEq(flipsPerWeek([]), null, 'no categories at all');
});

test('countingShift and rateShift: what a player actually moves', () => {
    // The seat was not empty. 2.5 a week in place of the 1.0 a week it was giving is worth 1.5, not 2.5.
    assertEq(countingShift(2.5, 1), 1.5, 'above the player displaced');
    assertEq(countingShift(2.5, 0), 2.5, 'baseline zero is the raw contribution');
    assertEq(countingShift(2.5), 2.5, 'and is the default');
    assertEq(countingShift(null, 1), null, 'no production');
    // A rate is a pull, weighted by the share of the denominator owned: a quarter of the at-bats moves the team a quarter of the way from its rate to that one.
    assertEq(rateShift({ playerRate: 0.5, teamRate: 0.25, playerWeight: 25, teamWeight: 100 }),
        0.0625, 'a quarter of the way');
    // A part-timer with a spectacular rate moves almost nothing, which is the whole point of the weighting.
    assertClose(rateShift({ playerRate: 1, teamRate: 0.25, playerWeight: 1, teamWeight: 100 }),
        0.0075, 1e-12, 'one at-bat of brilliance');
    assertEq(rateShift({ playerRate: 0.5, teamRate: 0.25, playerWeight: 25, teamWeight: 0 }),
        null, 'a team with no at-bats has no batting average');
});

test('rateMarginSd: the delta method, with the covariance that is not optional', () => {
    // AVG = H/AB, hand-computed end to end. per player-week: H mean 2, AB mean 8; Var(H) 2, Var(AB) 4, Cov 2 4 seats -> team H 8, AB 32, team AVG 0.25 gradient: d/dH = 1/32 = 0.03125; d/dAB = -H/AB^2 = -8/1024 = -0.0078125 team covariance = 4 x the per-player-week figures = Var(H) 8, Var(AB) 16, Cov 8 Var(AVG) = 0.03125^2*8 + 2*0.03125*(-0.0078125)*8 + 0.0078125^2*16 = 0.0078125 - 0.00390625 + 0.0009765625 = 0.0048828125 margin sd = sqrt(2 * 0.0048828125) = sqrt(0.009765625)
    const specs = [{ out: '2', num: ['1'], den: ['0'] }];
    const withCov = rateMarginSd({
        categoryId: '2', rateSpecs: specs, componentIds: ['1', '0'],
        componentMeans: { '1': 2, '0': 8 },
        componentCov: { '1': { '1': 2, '0': 2 }, '0': { '1': 2, '0': 4 } },
        seats: 4
    });
    assertClose(withCov, Math.sqrt(0.009765625), 1e-9, 'hits and at-bats move together');

    // Drop the covariance and the answer changes, which is the proof it is being used: Var = 0.0078125 + 0.0009765625 = 0.0087890625, sd = sqrt(0.017578125)
    const noCov = rateMarginSd({
        categoryId: '2', rateSpecs: specs, componentIds: ['1', '0'],
        componentMeans: { '1': 2, '0': 8 },
        componentCov: { '1': { '1': 2, '0': 0 }, '0': { '1': 0, '0': 4 } },
        seats: 4
    });
    assertClose(noCov, Math.sqrt(0.017578125), 1e-9, 'pretending they are independent widens it');
    assert(noCov > withCov, 'and widens it, specifically');

    // A composite rate resolves through its parts. Two identical halves make a rate that moves exactly twice as far, which is a fact about the gradient of a sum and needs no new arithmetic.
    const composite = [
        { out: '9', num: ['1'], den: ['0'] },
        { out: '17', num: ['1'], den: ['0'] },
        { out: '18', add: ['17', '9'] }
    ];
    const doubled = rateMarginSd({
        categoryId: '18', rateSpecs: composite, componentIds: ['1', '0'],
        componentMeans: { '1': 2, '0': 8 },
        componentCov: { '1': { '1': 2, '0': 2 }, '0': { '1': 2, '0': 4 } },
        seats: 4
    });
    assertClose(doubled, 2 * withCov, 1e-9, 'OPS is OBP plus SLG, and its spread adds the same way');

    // A denominator of zero is no rate at all, and must not be a zero rate.
    assertEq(rateMarginSd({
        categoryId: '2', rateSpecs: specs, componentIds: ['1', '0'],
        componentMeans: { '1': 2, '0': 0 },
        componentCov: { '1': { '1': 2, '0': 0 }, '0': { '1': 0, '0': 0 } },
        seats: 4
    }), null, 'no at-bats, no average');
    assertEq(rateMarginSd({
        categoryId: '2', rateSpecs: specs, componentIds: [],
        componentMeans: {}, componentCov: {}, seats: 4
    }), null, 'no components');
});

test('the two-category toy: margins by hand, flips exact, inverse and unknown included', () => {
    // A DRAFTABLE RANGE OF FOUR, TWO SEATS PER TEAM, TWO SCORED CATEGORIES. Category A, a counting category (home runs, say). The four players produce 1, 1, 3, 3 a week and never vary: pool mean 2; within 0; between = ((1-2)^2 x2 + (3-2)^2 x2)/4 = 1; pool variance 1 2 seats -> team variance 2 -> margin sd = sqrt(2 x 2) = 2 EXACTLY
    const A = poolMoments([
        { mean: 1, variance: 0 }, { mean: 1, variance: 0 },
        { mean: 3, variance: 0 }, { mean: 3, variance: 0 }
    ]);
    assertEq(A, { mean: 2, variance: 1, n: 4 }, 'category A pool');
    const sdA = marginSd(teamTotalMoments(A, 2));
    assertEq(sdA, 2, 'category A margins have sd 2');

    // Category B, an INVERSE counting category (caught stealing). Two players are never caught, two are caught once a week: pool mean 0.5; within 0; between = 0.25; pool variance 0.25 2 seats -> team variance 0.5 -> margin sd = sqrt(2 x 0.5) = 1 EXACTLY
    const B = poolMoments([
        { mean: 0, variance: 0 }, { mean: 0, variance: 0 },
        { mean: 1, variance: 0 }, { mean: 1, variance: 0 }
    ]);
    assertEq(B, { mean: 0.5, variance: 0.25, n: 4 }, 'category B pool');
    const sdB = marginSd(teamTotalMoments(B, 2));
    assertEq(sdB, 1, 'category B margins have sd 1');

    // THE RAW READING, which is the form a hand measurement takes: a whole week against the league's margins. 3 home runs against sd 2 is 1.5 sigma; 1 caught stealing against sd 1 is one sigma, and it is a category the team LOSES by that presence.
    const rawA = categoryFlip(countingShift(3, 0), sdA, { inverse: false });
    const rawB = categoryFlip(countingShift(1, 0), sdB, { inverse: true });
    assertClose(rawA.reach, 2 * PHI_1_5 - 1, REACH_ERR, 'A is within reach 86.6% of the time');
    assertClose(rawA.flip, PHI_1_5 - 0.5, REACH_ERR, 'and it turns in half of those');
    assertClose(rawB.reach, 2 * PHI_1 - 1, REACH_ERR, 'B is within reach 68.3% of the time');
    assertClose(rawB.flip, -(PHI_1 - 0.5), REACH_ERR, 'and it costs the team, so it is negative');
    assertClose(flipsPerWeek([
        { categoryId: 'A', flip: rawA.flip }, { categoryId: 'B', flip: rawB.flip }
    ]).total, (PHI_1_5 - 0.5) - (PHI_1 - 0.5), REACH_ERR, 'raw: the good outweighs the bad');

    // THE VALUE READING, against the player displaced: 1 above the pool in A and 0.5 above it in B, which is half a sigma in BOTH - so the running is a wash, and the total is exactly zero. Nothing about the two categories' different scales survives except through the sigmas, which is the entire point of measuring leverage instead of percentiles.
    const valA = categoryFlip(countingShift(3, A.mean), sdA, { inverse: false });
    const valB = categoryFlip(countingShift(1, B.mean), sdB, { inverse: true });
    assertClose(valA.flip, PHI_0_5 - 0.5, REACH_ERR, 'half a sigma of A');
    assertClose(valB.flip, -(PHI_0_5 - 0.5), REACH_ERR, 'half a sigma of B, against the player');
    const value = flipsPerWeek([
        { categoryId: 'A', flip: valA.flip },
        { categoryId: 'B', flip: valB.flip },
        // A third scored category with no figures in it at all. It must not count as a zero.
        { categoryId: 'C', flip: categoryFlip(countingShift(null), 4) && null }
    ]);
    assertClose(value.total, 0, 1e-12, 'above the pool by the same sigma in both: a wash');
    assertEq(value.counted, 2, 'the unknown category contributed nothing');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
