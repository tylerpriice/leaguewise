// Unit tests for the pure rank engine. Open tests/rank-engine.test.html through any static server; file:// will not work, since browsers block ES module imports without a real origin, and python -m http.server will do.Green means every assertion held. Every expected value here is hand-computed from the documented formulas, so a failure means the engine changed behavior, not that a snapshot went stale.
import {
    MIN_PLAYING_TIME_FRACTION, MIN_OPPORTUNITY_FRACTION,
    countLessThan, countGreaterThan, percentileFor,
    inningsPitchedOf, statValueForRanking, opportunityGateFor,
    computeRotoRanks, computePointsRanks, computeCategoryBreakdown, computeStatRankInPool,
    buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis, scoreWeekByCategory,
    rotoPointsForCategory, scoreRotoWeek, competitionRanks, formatRank, comparePlayerCategories,
    comparePlayerGroup, groupMatchupSeries,
    perDayAverages, scoreDayAgainstSelf, dayVerdict, typicalDayScore, presentDayScore, DAY_SCORE_TYPICAL, DAY_SCORE_CAP,
    DAY_SIGNATURE_RATIO, DAY_ORDINARY_BAND,
    windowProjectedLine, windowLineRanks
} from '../src/engines/rank-engine.js';
import { buildRosterTimeline, ownerTeamIdsByPlayer, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod, buildStartedSeats, creditedStats, rosterDaysOf, dayBucketScope, startedDaySums, weightedTotal, needsEveryDay } from '../src/engines/roster-timeline.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// Deep-compares by JSON, the same helper the other suites carry. The group comparison's answers are arrays and objects, not single numbers.
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg}: got ${a}, expected ${e}`);
}
function assertClose(actual, expected, msg, tol = 1e-9) {
    if (actual === null || actual === undefined || Math.abs(actual - expected) > tol) {
        throw new Error(`${msg}: got ${actual}, expected ${expected}`);
    }
}

// Player factory: the engine only ever needs id and seasonTotals.
const P = (id, totals) => ({ id, seasonTotals: totals });

// Baseline ctx for batter-style pools: one workload measure for both shrinkage and threshold (games played, id '81'), no inverse stats unless a test says so.
const ctx = (over = {}) => ({
    // Every id in this file is a baseball id, so the ctx says so. The engine's opportunity gates and its RP per-nine rule are keyed by sport, and a ctx without one gets neither, which is the point: another sport's id numbered 57 must not inherit a save-chances gate.
    sport: 'flb',
    relevantStatIds: ['5'],
    inverseStatIds: new Set(),
    // Empty by default, so every scored cat is treated as counting, so a missing value zero-fills. Rate tests opt in a stat (e.g. rateStatIds: new Set(['47'])) to keep the undefined-skip.
    rateStatIds: new Set(),
    isRpPool: false,
    requireMinPlayingTime: true,
    workloadOf: p => p.seasonTotals['81'] || 0,
    thresholdWorkloadOf: p => p.seasonTotals['81'] || 0,
    statMap: { '5': 'HR', '47': 'ERA', '48': 'K', '57': 'SV', '63': 'QS' },
    ...over
});

// ==== Percentile primitives ====

test('countLessThan / countGreaterThan handle ties and bounds', () => {
    const arr = [1, 2, 2, 3];
    assertClose(countLessThan(arr, 2), 1, 'less than 2');
    assertClose(countGreaterThan(arr, 2), 1, 'greater than 2');
    assertClose(countLessThan(arr, 0), 0, 'less than min');
    assertClose(countGreaterThan(arr, 4), 0, 'greater than max');
    assertClose(countLessThan(arr, 10), 4, 'less than above-max');
});

test('percentileFor: basic, midrank ties, inverse, clamp at 100', () => {
    const basis = [10, 20, 30, 40];
    assertClose(percentileFor(basis, 25, false), (2 / 3) * 100, 'mid value: beats 10,20 of the other 3');
    assertClose(percentileFor(basis, 10, false), 0, 'unique worst basis member');
    assertClose(percentileFor(basis, 40, false), 100, 'unique best basis member');
    assertClose(percentileFor(basis, 50, false), 100, 'outsider beating all clamps to 100 (raw 133)');
    assertClose(percentileFor(basis, 25, true), (2 / 3) * 100, 'inverse mid (beats 30,40)');
    // Midrank: the two 20s occupy worse-positions 1 and 2 (below=1, equal=2), mean 1.5 of 3 = 50, not the block's worse edge (33.3). They split the block's percentile instead of both sinking to the bottom of it.
    const tied = [10, 20, 20, 40];
    assertClose(percentileFor(tied, 20, false), 50, 'tied values take the block average (midrank)');
    // The min value in a big bottom tie is the case that motivated midrank: four 0s and one 5, a zero is tied with the whole 0-cohort. below=0, equal=4, mean position (4-1)/2=1.5 of 4 = 37.5, NOT 0th percentile. The lone 5 beats all four zeros -> 4/4 = 100.
    const bottomTie = [0, 0, 0, 0, 5];
    assertClose(percentileFor(bottomTie, 0, false), 37.5, 'bottom-tied zero sits mid-cohort, not at 0');
    assertClose(percentileFor(bottomTie, 5, false), 100, 'the one value above the whole zero-cohort tops out');
    assertClose(percentileFor([7], 7, false), 100, 'single-member basis');
});

test('inningsPitchedOf: outs divided by 3, missing stat -> 0', () => {
    assertClose(inningsPitchedOf(P(1, { '34': 586 })), 586 / 3, 'Skubal validation line: 586 outs');
    assertClose(inningsPitchedOf(P(2, { '34': 216 })), 72, 'exact whole-inning total');
    assertClose(inningsPitchedOf(P(3, {})), 0, 'no outs recorded -> 0');
});

test('statValueForRanking: raw normally, K as K/9 in RP pools', () => {
    const p = P(1, { '48': 80, '34': 180 }); // 60 IP
    assertClose(statValueForRanking(p, '48', false, 'flb'), 80, 'raw K outside RP pool');
    assertClose(statValueForRanking(p, '48', true, 'flb'), 12, 'K/9 inside RP pool (80/60*9)');
    // A hockey id numbered 48 is not strikeouts per nine innings.
    assertClose(statValueForRanking(p, '48', true, 'fhl'), 80, 'no per-nine substitution outside baseball');
    assert(statValueForRanking(P(2, {}), '48', true, 'flb') === undefined, 'undefined stays undefined');
    assertClose(statValueForRanking(P(3, { '48': 5 }), '48', true, 'flb'), 0, 'zero IP -> 0, not Infinity');
});

test('opportunityGateFor: SV ungated only in RP pools, QS gated everywhere', () => {
    assert(opportunityGateFor('57', false, 'flb') !== null && opportunityGateFor('57', false, 'flb') !== undefined, 'SV gated outside RP');
    assert(opportunityGateFor('57', true, 'flb') === null, 'SV NOT gated inside RP');
    assert(!!opportunityGateFor('63', true, 'flb'), 'QS gated inside RP');
    assert(!!opportunityGateFor('63', false, 'flb'), 'QS gated outside RP');
    // AND THE WHOLE POINT OF KEYING THEM: another sport's id numbered 57 or 63 inherits nothing.
    assert(!opportunityGateFor('57', false, 'fhl'), 'no save-chances gate in hockey');
    assert(!opportunityGateFor('63', false, 'fhl'), 'no quality-start gate in hockey');
    assert(!opportunityGateFor('57', false, 'ffl'), 'nor in a sport nobody has validated');
    assert(!opportunityGateFor('57', false, undefined), 'nor with no sport at all');
});

// ==== Single-stat ranking (stat chips) ====

test('computeStatRankInPool: competition ranking 1-2-2-4', () => {
    const pool = [P(1, { '5': 40 }), P(2, { '5': 30 }), P(3, { '5': 30 }), P(4, { '5': 25 })];
    assertClose(computeStatRankInPool(pool, 1, '5', false).rank, 1, 'leader rank');
    assertClose(computeStatRankInPool(pool, 2, '5', false).rank, 2, 'first tied rank');
    assertClose(computeStatRankInPool(pool, 3, '5', false).rank, 2, 'second tied rank shares');
    assertClose(computeStatRankInPool(pool, 4, '5', false).rank, 4, 'after ties resumes true position');
    assertClose(computeStatRankInPool(pool, 2, '5', false).percentile, (2 / 3) * 100, 'tied percentile');
    assert(computeStatRankInPool(pool, 99, '5', false) === null, 'missing player -> null');
    assert(computeStatRankInPool([], 1, '5', false) === null, 'empty pool -> null');
});

test('computeStatRankInPool: inverse puts the LOWEST value first', () => {
    const pool = [P(1, { '47': 2.5 }), P(2, { '47': 3.5 })];
    assertClose(computeStatRankInPool(pool, 1, '47', true).rank, 1, 'lower ERA ranks first');
    assertClose(computeStatRankInPool(pool, 2, '47', true).rank, 2, 'higher ERA ranks second');
});

// ==== Roto pool ranking ====

test('computeRotoRanks: equal workloads rank purely by percentile', () => {
    const players = [P(1, { '5': 30, '81': 100 }), P(2, { '5': 20, '81': 100 }), P(3, { '5': 10, '81': 100 })];
    const r = computeRotoRanks(players, ctx());
    assertClose(r.scores.get(1), 100, 'leader score');
    assertClose(r.scores.get(2), 50, 'middle score');
    assertClose(r.scores.get(3), 0, 'trailer score');
    assertClose(r.ranks.get(1), 1, 'leader rank');
    assertClose(r.total, 3, 'all ranked');
});

test('computeRotoRanks: shrinkage pulls a half-workload player exactly halfway to 50', () => {
    const players = [P(1, { '5': 30, '81': 100 }), P(2, { '5': 29, '81': 50 })];
    const r = computeRotoRanks(players, ctx());
    // B's raw percentile in basis [29,30] is 0; shrink 50/100 -> 50 + (0-50)*0.5 = 25
    assertClose(r.scores.get(2), 25, 'shrunk score');
    assertClose(r.scores.get(1), 100, 'full-workload leader untouched');
});

test('computeRotoRanks: min-games toggle: exclusion when on, stable basis when off', () => {
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const callup = P(3, { '5': 40, '81': 10 }); // 10 games < 20% of 100
    const on = computeRotoRanks([A, B, callup], ctx({ requireMinPlayingTime: true }));
    assert(!on.ranks.has(3), 'call-up unranked with toggle on');
    const off = computeRotoRanks([A, B, callup], ctx({ requireMinPlayingTime: false }));
    assert(off.ranks.has(3), 'call-up ranked with toggle off');
    // Basis stability. Qualified players' scores must be IDENTICAL either way
    assertClose(off.scores.get(1), on.scores.get(1), 'A score unchanged by toggle');
    assertClose(off.scores.get(2), on.scores.get(2), 'B score unchanged by toggle');
    // Call-up beats the whole 2-member basis -> clamped raw 100, shrink 10/100 -> 50+50*0.1
    assertClose(off.scores.get(3), 55, 'call-up score = clamped percentile, heavily shrunk');
    assertClose(off.ranks.get(3), 2, 'call-up slots between A and B');
});

test('computeRotoRanks: a 0-GP player is never ranked with the toggle OFF', () => {
    // Shrinkage pulls a percentile toward 50 by workload share, so a never-played player would score EXACTLY 50 in every category (shrink 0) and land above every real player having a below-average season. Zero games means zero evidence: unranked in both toggle states.
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 10, '81': 100 });
    const zero = P(3, { '5': 0 }); // no '81' key at all -> 0 games
    const r = computeRotoRanks([A, B, zero], ctx({ requireMinPlayingTime: false }));
    // Basis is the qualified pool [A, B] (zero is under the 20-game threshold either way). '5' basis [10, 30], both at full shrink (100 of 100 games): A 100, B 0.
    assertClose(r.total, 2, 'only the two who played are ranked');
    assert(!r.ranks.has(3), 'the 0-GP player is unranked with the toggle off');
    assert(!r.scores.has(3), 'and carries no score at all, not a 50');
    assertClose(r.scores.get(1), 100, 'A unchanged');
    assertClose(r.scores.get(2), 0, 'B unchanged');
    // The regression this pins. Unfixed, zero scores 50 and takes this slot, pushing B to 3rd.
    assertClose(r.ranks.get(2), 2, 'B stays second, nothing floats in above it');
});

test('computeRotoRanks: the 0-GP exclusion also holds with the toggle ON', () => {
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 10, '81': 100 });
    const zero = P(3, { '5': 0 });
    const r = computeRotoRanks([A, B, zero], ctx({ requireMinPlayingTime: true }));
    // Identical outcome to the toggle-off case above. With the toggle on, the min-games threshold already excluded the zero, so the floor is a no-op here and this state is unchanged.
    assertClose(r.total, 2, 'same two ranked');
    assert(!r.ranks.has(3), 'the 0-GP player is unranked with the toggle on too');
    assertClose(r.scores.get(1), 100, 'A unchanged');
    assertClose(r.scores.get(2), 0, 'B unchanged');
});

test('computeRotoRanks: the zero floor does not empty a pool where nobody has played', () => {
    // Preseason / brand-new league. Every thresholdWorkload is 0, so there is no real cohort for the floor to protect and blanking the board would be worse than ranking on what's there.
    const A = P(1, { '5': 30 });
    const B = P(2, { '5': 10 });
    const r = computeRotoRanks([A, B], ctx({ requireMinPlayingTime: false }));
    // maxWorkload is 0 too, so shrinkFactor falls back to 1: '5' basis [10, 30] -> A 100, B 0.
    assertClose(r.total, 2, 'both still ranked');
    assertClose(r.scores.get(1), 100, 'A tops the board');
    assertClose(r.scores.get(2), 0, 'B below it');
});

test('computeRotoRanks: SV opportunity gate protects zero-chance players outside RP', () => {
    const closer = P(1, { '5': 10, '57': 30, '58': 5, '81': 60 });   // 35 chances
    const setup = P(2, { '5': 20, '57': 2, '58': 3, '81': 60 });     // 5 chances < 15% of 35
    const starter = P(3, { '5': 30, '57': 0, '58': 0, '81': 60 });   // 0 chances
    const r = computeRotoRanks([closer, setup, starter], ctx({ relevantStatIds: ['5', '57'] }));
    // HR percentiles: 0 / 50 / 100. SV: only the closer has real opportunity -> single-member basis -> 100 for that closer; setup and starter skip the category instead of eating a zero.
    assertClose(r.scores.get(1), 50, 'closer averages HR 0 + SV 100');
    assertClose(r.scores.get(2), 50, 'setup scored on HR only');
    assertClose(r.scores.get(3), 100, 'starter scored on HR only, tops the pool');
    assertClose(r.ranks.get(3), 1, 'starter #1');
});

test('computeRotoRanks: RP pool: no shrinkage, K as K/9, SV ungated', () => {
    // K/9: R1 = 80K/60IP = 12.0, R2 = 90K/100IP = 8.1 -> raw K would rank R2 first, K/9 ranks R1 first
    const R1 = P(1, { '48': 80, '34': 180, '57': 0, '58': 0, '81': 60 });
    const R2 = P(2, { '48': 90, '34': 300, '57': 30, '58': 4, '81': 40 });
    const rpCtx = ctx({ relevantStatIds: ['48', '57'], isRpPool: true, workloadOf: p => (p.seasonTotals['34'] || 0) / 3 });
    const r = computeRotoRanks([R1, R2], rpCtx);
    // K/9: R1 100, R2 0. SV ungated in RP: R1 (0 saves) 0, R2 100. Both average 50 - and crucially NO shrinkage applied despite very different workloads (60 vs 100 IP).
    assertClose(r.scores.get(1), 50, 'R1: K/9 win + SV loss, unshrunk');
    assertClose(r.scores.get(2), 50, 'R2: K/9 loss + SV win, unshrunk');
});

test('computeRotoRanks: QS stays gated inside RP pools', () => {
    const trueRp = P(1, { '63': 0, '33': 0, '81': 60 });
    const swing = P(2, { '63': 5, '33': 8, '81': 60 });
    const r = computeRotoRanks([trueRp, swing], ctx({ relevantStatIds: ['63'], isRpPool: true }));
    assert(!r.ranks.has(1), 'zero-start reliever has no scoreable category at all');
    assertClose(r.scores.get(2), 100, 'swingman scored against himself only');
});

test('computeRotoRanks: inverse stat ranks the LOWER value first', () => {
    const A = P(1, { '47': 2.5, '81': 100 });
    const B = P(2, { '47': 3.5, '81': 100 });
    const r = computeRotoRanks([A, B], ctx({ sport: 'flb', relevantStatIds: ['47'], inverseStatIds: new Set(['47']) }));
    assertClose(r.scores.get(1), 100, 'lower ERA scores 100');
    assertClose(r.ranks.get(1), 1, 'lower ERA ranks #1');
});

test('computeRotoRanks: hockey goalie pool: inverse GAA, games-played workload, backup shrinkage', () => {
    // Validates that the engine handles a hockey-shaped ctx end to end: W(1) counting, GAA(10) inverse and lower-is-better, games played (id 30) as both the shrinkage and the threshold workload. Two full-season starters plus a small-sample backup whose elite 1.00 GAA must be shrunk.
    const A = P(1, { '1': 30, '10': 2.00, '30': 60 }); // starter, best record
    const B = P(2, { '1': 20, '10': 2.50, '30': 60 }); // starter, worst rate
    const C = P(3, { '1': 5, '10': 1.00, '30': 12 });  // backup: elite rate, 12 games = 20% of 60
    const hCtx = {
        relevantStatIds: ['1', '10'],
        inverseStatIds: new Set(['10']),
        isRpPool: false,
        requireMinPlayingTime: true,
        workloadOf: p => p.seasonTotals['30'] || 0,
        thresholdWorkloadOf: p => p.seasonTotals['30'] || 0,
        statMap: { '1': 'W', '10': 'GAA' }
    };
    const r = computeRotoRanks([A, B, C], hCtx);
    // W basis [5,20,30]: A 100, B 50, C 0. GAA basis [1,2,2.5] inverse: A 50, B 0, C 100. Shrink 1.0 for A/B (60 of 60 games), 0.2 for C (12 of 60). Per-category pull to 50 then avg: A (100,50)->75; B (50,0)->25; C W 50+(0-50)*0.2=40, GAA 50+(100-50)*0.2=60 -> 50.
    assertClose(r.scores.get(1), 75, 'starter A: best record, mid rate');
    assertClose(r.scores.get(2), 25, 'starter B: mid record, worst rate');
    assertClose(r.scores.get(3), 50, 'backup C: elite GAA shrunk toward 50 by a 12-game sample');
    assertClose(r.ranks.get(1), 1, 'A ranks first');
    assertClose(r.ranks.get(3), 2, 'C ranks second, ahead of B despite far fewer games');
    assertClose(r.ranks.get(2), 3, 'B ranks third');
});

test('computeRotoRanks: a missing COUNTING stat is a real 0, ranked not skipped', () => {
    // ESPN omits a zero-valued sparse counting stat entirely, so B has no '20' key. Under the zero-fill rule B is ranked in '20' at 0 (not skipped) and enters the '20' basis at 0, so having zero costs a real bottom percentile instead of nothing.
    const A = P(1, { '5': 10, '20': 5, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const r = computeRotoRanks([A, B], ctx({ relevantStatIds: ['5', '20'] }));
    // '5' basis [10,20]: A 0, B 100. '20' basis [0(B),5(A)]: A 100, B 0. Equal workloads, no shrink.
    assertClose(r.scores.get(1), 50, 'A: worst HR (0) + best on stat 20 (100)');
    assertClose(r.scores.get(2), 50, 'B: best HR (100) + zero-filled stat 20 (0)');
    assertClose(r.categoryCount, 2, 'both categories count for both players');
});

test('computeRotoRanks: sparse stats: counting zero-fills, rate stays absent', () => {
    // '5' counting, '47' a rate (inverse). C has neither key: its missing '5' becomes 0 and is ranked; its missing '47' is genuinely absent (a rate never posted is not a 0.00 ERA) and is skipped, so C is scored on the one counting cat only.
    const A = P(1, { '5': 10, '47': 3.00, '81': 100 });
    const B = P(2, { '5': 20, '47': 4.00, '81': 100 });
    const C = P(3, { '81': 100 });
    const r = computeRotoRanks([A, B, C], ctx({
        relevantStatIds: ['5', '47'], inverseStatIds: new Set(['47']), rateStatIds: new Set(['47'])
    }));
    // '5' basis [0(C),10(A),20(B)] (n=3): A 50, B 100, C 0. '47' basis [3,4] (A,B only; C absent), inverse: A 100, B 0. C skipped.
    assertClose(r.scores.get(1), 75, 'A: HR 50, ERA 100');
    assertClose(r.scores.get(2), 50, 'B: HR 100, ERA 0');
    assertClose(r.scores.get(3), 0, 'C: HR zero-filled to 0; ERA skipped as a rate never posted');
    assertClose(r.ranks.get(3), 3, 'C last, ranked only on the counting cat it zero-filled into');
});

test('computeRotoRanks: a zero cohort scores the midrank block average, not 0', () => {
    // The real-league case in miniature. One player has the counting stat, three don't (no key). The three zeros form a tie block; midrank puts each at the block's mean, not rock bottom.
    const A = P(1, { '5': 20, '81': 100 });
    const B = P(2, { '81': 100 }); // no '5' -> 0
    const C = P(3, { '81': 100 }); // no '5' -> 0
    const D = P(4, { '81': 100 }); // no '5' -> 0
    const r = computeRotoRanks([A, B, C, D], ctx({ relevantStatIds: ['5'] }));
    // '5' basis [0,0,0,20] (n=4). The three zeros: below=0, equal=3, worse=(3-1)/2=1 -> 1/3*100 = 33.33. A(20): below=3, equal=1, worse=3 -> 3/3*100 = 100.
    assertClose(r.scores.get(1), 100, 'the lone producer beats the whole zero cohort');
    assertClose(r.scores.get(2), 100 / 3, 'a zero sits at the middle of the 3-zero block (33.33), not 0');
    assertClose(r.scores.get(3), 100 / 3, 'every zero-cohort member gets the same block average');
    assertClose(r.scores.get(4), 100 / 3, 'and the third');
    assertClose(r.ranks.get(1), 1, 'producer ranks first');
});

test('computeRotoRanks: a dense mid-pool tie splits the block percentile (midrank)', () => {
    // Two players tied at 20 in a non-sparse category both take the block average, not the worse edge. It is the same midrank rule and has nothing to do with zero-fill.
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const C = P(3, { '5': 20, '81': 100 });
    const D = P(4, { '5': 10, '81': 100 });
    const r = computeRotoRanks([A, B, C, D], ctx({ relevantStatIds: ['5'] }));
    // basis [10,20,20,30] (n=4). B,C at 20: below=1, equal=2, worse=1+(2-1)/2=1.5 -> 1.5/3*100 = 50.
    assertClose(r.scores.get(1), 100, 'A (30) unique top');
    assertClose(r.scores.get(2), 50, 'B: tied at 20 takes the block average (50), not 33.3');
    assertClose(r.scores.get(3), 50, 'C: same block average as its tie partner');
    assertClose(r.scores.get(4), 0, 'D (10) unique bottom');
});

test('computeRotoRanks: empty pool returns an empty, well-formed result', () => {
    const r = computeRotoRanks([], ctx());
    assertClose(r.total, 0, 'nothing ranked');
    assertClose(r.scores.size, 0, 'no scores');
    assertClose(r.ranked.length, 0, 'no ranked list entries');
});

test('computeRotoRanks: zero workloads everywhere still produce a sane ranking', () => {
    const r = computeRotoRanks([P(1, { '5': 10 }), P(2, { '5': 5 })], ctx());
    assertClose(r.total, 2, 'both ranked despite no games-played data');
    assertClose(r.scores.get(1), 100, 'still percentile-ranked');
});

// ==== Breakdown consistency ====

test('computeCategoryBreakdown: avg reproduces the roto score exactly', () => {
    const players = [P(1, { '5': 30, '81': 100 }), P(2, { '5': 29, '81': 50 })];
    const c = ctx();
    const roto = computeRotoRanks(players, c);
    const bd = computeCategoryBreakdown(players[1], players, c);
    assertClose(bd.avg, roto.scores.get(2), 'breakdown avg === leaderboard score');
    assertClose(bd.shrink, 0.5, 'playing-time factor');
    assertClose(bd.rows.length, 1, 'one scored category row');
    assertClose(bd.rows[0].rawPct, 0, 'raw percentile');
    assertClose(bd.rows[0].adjPct, 25, 'adjusted percentile');
});

test('computeCategoryBreakdown: zero-fills a missing counting cat and reports the qualified pool size', () => {
    // B lacks '20'. D is unqualified (10 games is under 20% of 100), so the qualified basis is {A, B}. B's breakdown must include a '20' row, zero-filled, ranked against that basis, and report the qualified size (2) and not the full 3-player group the score is not computed against.
    const A = P(1, { '5': 10, '20': 5, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const D = P(3, { '5': 40, '20': 9, '81': 10 });
    const c = ctx({ relevantStatIds: ['5', '20'] });
    const bd = computeCategoryBreakdown(B, [A, B, D], c);
    const row20 = bd.rows.find(r => r.id === '20');
    assert(row20 !== undefined, 'stat 20 is a scored row for B even though B has no key for it');
    assertClose(row20.value, 0, 'the missing counting value shows as a real 0');
    assertClose(row20.rawPct, 0, 'zero is the shared bottom of the {A=5, B=0} basis');
    assertClose(bd.qualifiedCount, 2, 'qualified pool size is A and B, not the 3-player group');
    // avg still reconstructs the leaderboard score for a zero-filled player.
    const roto = computeRotoRanks([A, B, D], c);
    assertClose(bd.avg, roto.scores.get(2), 'breakdown avg === leaderboard score with a zero-fill row');
});

test('computeCategoryBreakdown: unqualified player reproduces the toggle-off roto score', () => {
    // The drill-down must show the same number the leaderboard shows when Minimum Games Played is off. The call-up scored against the FIXED qualified basis, never inserted into it.
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const callup = P(3, { '5': 40, '81': 10 });
    const c = ctx({ requireMinPlayingTime: false });
    const roto = computeRotoRanks([A, B, callup], c);
    const bd = computeCategoryBreakdown(callup, [A, B, callup], c);
    assertClose(bd.avg, roto.scores.get(3), 'breakdown avg === toggle-off leaderboard score');
    assertClose(bd.shrink, 0.1, 'shrink factor from 10 of 100 games');
    assertClose(bd.rows[0].rawPct, 100, 'raw percentile clamped at 100 vs the 2-member basis');
    assertClose(bd.rows[0].adjPct, 55, 'adjusted percentile');
});

test('computeCategoryBreakdown: gated categories land in excluded, with labels', () => {
    const closer = P(1, { '57': 30, '58': 5, '81': 60 });
    const starter = P(2, { '57': 0, '58': 0, '81': 60 });
    const bd = computeCategoryBreakdown(starter, [closer, starter], ctx({ relevantStatIds: ['57'] }));
    assertClose(bd.rows.length, 0, 'no scored rows');
    assertClose(bd.excluded.length, 1, 'one excluded row');
    assert(bd.excluded[0].name === 'SV', 'excluded row carries the display name');
});

test('computeCategoryBreakdown: RP K row is labeled "(as K/9)" and valued as a rate', () => {
    const R1 = P(1, { '48': 80, '34': 180, '81': 60 });
    const R2 = P(2, { '48': 90, '34': 300, '81': 60 });
    const bd = computeCategoryBreakdown(R1, [R1, R2], ctx({ relevantStatIds: ['48'], isRpPool: true }));
    assert(bd.rows[0].name === 'K (as K/9)', 'row label flags the substitution');
    assertClose(bd.rows[0].value, 12, 'row value is the K/9 rate, not raw K');
});

test('computeCategoryBreakdown: a true full-precision rate tie yields equal percentiles', () => {
    // Rate rows carry display decimals so two SV% that round to.912 (.9118 and.9123) stop looking like an engine fault. That is only sound because the engine ties by value and not by rounded display. Two rates equal at full precision must score the same percentile, so the drill-down's precision only reveals differences and never invents them.
    const A = P(1, { '47': 0.9200, '81': 100 });
    const B = P(2, { '47': 0.9100, '81': 100 }); // identical full-precision rate...
    const C = P(3, { '47': 0.9100, '81': 100 }); // ...as B
    const D = P(4, { '47': 0.9000, '81': 100 });
    const c = ctx({ relevantStatIds: ['47'], rateStatIds: new Set(['47']) });
    const rowB = computeCategoryBreakdown(B, [A, B, C, D], c).rows.find(r => r.id === '47');
    const rowC = computeCategoryBreakdown(C, [A, B, C, D], c).rows.find(r => r.id === '47');
    // basis [0.90, 0.91, 0.91, 0.92] (n=4). The two at 0.91: below=1, equal=2, worse=1.5 -> 50.
    assertClose(rowB.value, rowC.value, 'the two tied values are genuinely equal');
    assertClose(rowB.rawPct, rowC.rawPct, 'and midrank gives them the same percentile');
    assertClose(rowB.rawPct, 50, 'the shared block average, not one edge above the other');
});

// ==== Weekly Matchup Score basis + scoring ====

test('buildCategoryRateBasis: counting stats divide by weeks, rate stats never do', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const basis = buildCategoryRateBasis(pool, {
        sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    const hr = basis.find(c => c.id === '5');
    const avg = basis.find(c => c.id === '2');
    assert(JSON.stringify(hr.rates) === '[1,2]', `HR rates divided by weeks: ${JSON.stringify(hr.rates)}`);
    assert(JSON.stringify(avg.rates) === '[0.25,0.3]', `AVG rates undivided: ${JSON.stringify(avg.rates)}`);
});

test('buildCategoryRateBasis: opportunity gate filters the rate pool', () => {
    const pool = [P(1, { '57': 30, '58': 5 }), P(2, { '57': 1, '58': 0 })]; // chances 35 vs 1; min = 5.25
    const basis = buildCategoryRateBasis(pool, {
        sport: 'flb', relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: 10
    });
    assertClose(basis[0].rates.length, 1, 'no-chance reliever excluded from the SV basis');
});

test('buildCategoryRateBasis: categories with no data in the pool are dropped entirely', () => {
    const pool = [P(1, { '2': 0.300 }), P(2, { '2': 0.250 })]; // nobody has stat '5'
    const basis = buildCategoryRateBasis(pool, {
        sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    assertClose(basis.length, 1, 'empty category dropped');
    assert(basis[0].id === '2', 'the populated category survives');
});

test('scoreWeekAgainstBasis: inverse rate stat: a lower weekly value scores higher', () => {
    const pool = [P(1, { '47': 3.0 }), P(2, { '47': 4.0 })];
    const basis = buildCategoryRateBasis(pool, {
        sport: 'flb', relevantStatIds: ['47'], inverseStatIds: new Set(['47']), avgStatIds: new Set(['47']), weeksElapsed: 10
    });
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 2.0 }, basis), 100, 'sub-basis ERA beats everyone');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 3.5 }, basis), 100, 'a better-than-median ERA on a two-member basis: the n-1 scale has only 0 and 100');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 5.0 }, basis), 0, 'blow-up week beats nobody');
    // Inverse + proration. Rates must stay unprorated even when the matchup is half-played
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 3.5 }, basis, 0.5), 100, 'partial week leaves ERA alone - same figure, same percentile');
});

test('scoreWeekByCategory: the rows the explainer draws, and their mean IS the score', () => {
    const pool = [P(1, { '5': 20, '2': 0.300, '47': 3.0 }), P(2, { '5': 10, '2': 0.250, '47': 4.0 })];
    const bctx = { sport: 'flb', sport: 'flb', relevantStatIds: ['5', '2', '47'], inverseStatIds: new Set(['47']), avgStatIds: new Set(['2', '47']), weeksElapsed: 10 };
    const basis = buildCategoryRateBasis(pool, bctx);
    // Every figure here beats one of a two-member basis, and on the season engine's n-1 scale that is 1/(2-1) = 100 for each, so the rows are 100, 100, 100 and the mean is 100. A strictly-worse over n rule would read each as 50. Two peers cannot express an interior percentile; the real basis is hundreds of weeks, where the two denominators differ by a fraction of a point.
    const rows = scoreWeekByCategory(pool[0], { '5': 2.5, '2': 0.280, '47': 3.5 }, basis);
    assert(rows.length === 3, 'one row per scoreable category');
    assertClose(rows.find(r => r.id === '5').percentile, 100, 'HR row');
    assertClose(rows.find(r => r.id === '2').percentile, 100, 'AVG row');
    assertClose(rows.find(r => r.id === '47').percentile, 100, 'ERA row');
    assert(rows.find(r => r.id === '47').inverse === true, 'the inverse flag rides along for the label');
    assertClose(rows.find(r => r.id === '5').value, 2.5, 'value is the compared figure');
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 2.5, '2': 0.280, '47': 3.5 }, basis), 100, 'the score is the mean of the rows');
    assert(scoreWeekByCategory(pool[0], null, basis).length === 0, 'no week -> no rows');
});

test('scoreWeekAgainstBasis: exact percentiles, and null for unscoreable weeks', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const bctx = { sport: 'flb', sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10 };
    const basis = buildCategoryRateBasis(pool, bctx);
    // HR 1.5 beats one of [1,2]; AVG.280 beats one of [.25,.30]. On the n-1 scale each is 100.
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 1.5, '2': 0.280 }, basis), 100, 'full week');
    assert(scoreWeekAgainstBasis(pool[0], {}, basis) === null, 'empty week -> null');
    assert(scoreWeekAgainstBasis(pool[0], undefined, basis) === null, 'missing week -> null');
});

test('scoreWeekAgainstBasis: proration scales counting stats up, never rate stats', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const basis = buildCategoryRateBasis(pool, {
        sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    // Half a week: HR 1.2 -> on pace 2.4, beats both rates -> 100; AVG.280 unprorated beats one of two -> 100 on the n-1 scale. Mean 100. Proration still only touches the counting stat - that is what this test pins, and it is unchanged.
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 1.2, '2': 0.280 }, basis, 0.5), 100, 'prorated average');
});

test('scoreWeekAgainstBasis: opportunity-gated player skips the category', () => {
    const closer = P(1, { '57': 30, '58': 5 });
    const noChance = P(2, { '57': 1, '58': 0 });
    const basis = buildCategoryRateBasis([closer, noChance], {
        sport: 'flb', relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: 10
    });
    assert(scoreWeekAgainstBasis(noChance, { '57': 2 }, basis) === null, 'gated player has no scoreable category');
    assert(scoreWeekAgainstBasis(closer, { '57': 2 }, basis) !== null, 'gated basis still scores the closer');
});

// The real-weekly-value basis (buildWeeklyValueBasis). Its own comment in rank-engine.js carries the full diagnosis of why the season-average basis above read flat for everyday players.

// Weekly-pool player factory: id, seasonTotals (read only for opportunity gating) and a list of real per-matchup-week entries ({ stats, games }), matching what players.js's buildWeeklyRateBasis assembles from AppState.playerWeeklyCache.
const WP = (id, seasonTotals, weeks) => ({ id, seasonTotals, weeks });

test('buildWeeklyValueBasis: counting stats collect raw per-week totals, rate stats collect real per-week rates (no division)', () => {
    const pool = [
        WP(1, {}, [{ stats: { '5': 3, '2': 0.300 }, games: 6 }, { stats: { '5': 1, '2': 0.200 }, games: 5 }]),
        WP(2, {}, [{ stats: { '5': 2, '2': 0.250 }, games: 6 }, { stats: { '5': 0, '2': 0.100 }, games: 4 }])
    ];
    const basis = buildWeeklyValueBasis(pool, { sport: 'flb', sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']) });
    const hr = basis.find(c => c.id === '5');
    const avg = basis.find(c => c.id === '2');
    assert(JSON.stringify(hr.rates) === '[0,1,2,3]', `HR rates are real per-week totals, undivided: ${JSON.stringify(hr.rates)}`);
    assert(JSON.stringify(avg.rates) === '[0.1,0.2,0.25,0.3]', `AVG rates are real per-week rates, undivided: ${JSON.stringify(avg.rates)}`);
});

test('buildWeeklyValueBasis: a zero-games week is excluded from the distribution', () => {
    const pool = [WP(1, {}, [{ stats: { '5': 5 }, games: 0 }, { stats: { '5': 2 }, games: 6 }])];
    const basis = buildWeeklyValueBasis(pool, { sport: 'flb', sport: 'flb', relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    assert(JSON.stringify(basis[0].rates) === '[2]', `zero-games week excluded: ${JSON.stringify(basis[0].rates)}`);
});

test('buildWeeklyValueBasis: inverse category: a lower real week scores higher via scoreWeekAgainstBasis', () => {
    const pool = [WP(1, {}, [{ stats: { '47': 5.00 }, games: 4 }]), WP(2, {}, [{ stats: { '47': 2.00 }, games: 4 }])];
    const basis = buildWeeklyValueBasis(pool, { sport: 'flb', sport: 'flb', relevantStatIds: ['47'], inverseStatIds: new Set(['47']), avgStatIds: new Set(['47']) });
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 1.00 }, basis), 100, 'ERA better than both real weeks scores 100');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 6.00 }, basis), 0, 'ERA worse than both real weeks scores 0');
});

test('buildWeeklyValueBasis: opportunity gate filters the pool using SEASON totals, not any one week', () => {
    const closer = WP(1, { '57': 30, '58': 5 }, [{ stats: { '57': 2 }, games: 6 }]);    // 35 season chances
    const noChance = WP(2, { '57': 1, '58': 0 }, [{ stats: { '57': 0 }, games: 6 }]);   // 1 chance < 15% of 35
    const basis = buildWeeklyValueBasis([closer, noChance], { sport: 'flb', sport: 'flb', relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set() });
    assertClose(basis[0].rates.length, 1, 'no-chance reliever excluded from the SV weekly-value basis');
});

test('buildWeeklyValueBasis: a category nobody has any real week for is dropped entirely', () => {
    const pool = [WP(1, {}, [{ stats: { '2': 0.3 }, games: 4 }])];
    const basis = buildWeeklyValueBasis(pool, { sport: 'flb', sport: 'flb', relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']) });
    assertClose(basis.length, 1, 'the empty category is dropped');
    assert(basis[0].id === '2', 'the populated category survives');
});

// End-to-end proof on a synthetic pool: a full-time slugger with a genuine cold week and a genuine hot week, in a pool that also has part-time bench bats with a game log for only a week or two each. Their other weeks have 0 games and are absent, since buildWeeklySums never creates an entry for a week nobody played any part of. Every rate below is hand-computed from the pool's own numbers.
const b14WeeksElapsed = 4;
// Subject: 1 HR in the cold week, 6 HR in the hot week.
const b14Subject = WP('R1', {}, [
    { stats: { '5': 1 }, games: 6 }, { stats: { '5': 3 }, games: 6 },
    { stats: { '5': 3 }, games: 6 }, { stats: { '5': 6 }, games: 6 }
]);
// Another full-time peer: plays every week, real values spread across the season (season total 14).
const b14RegularPeer = WP('R2', {}, [
    { stats: { '5': 2 }, games: 6 }, { stats: { '5': 3 }, games: 6 },
    { stats: { '5': 4 }, games: 6 }, { stats: { '5': 5 }, games: 6 }
]);
// 8 part-timers, each with exactly ONE real week (2 games that week) and 3 absent weeks.
const b14PartTimers = [
    WP('PT1', {}, [{ stats: { '5': 0 }, games: 2 }]), WP('PT2', {}, [{ stats: { '5': 1 }, games: 2 }]),
    WP('PT3', {}, [{ stats: { '5': 0 }, games: 2 }]), WP('PT4', {}, [{ stats: { '5': 1 }, games: 2 }]),
    WP('PT5', {}, [{ stats: { '5': 1 }, games: 2 }]), WP('PT6', {}, [{ stats: { '5': 0 }, games: 2 }]),
    WP('PT7', {}, [{ stats: { '5': 1 }, games: 2 }]), WP('PT8', {}, [{ stats: { '5': 0 }, games: 2 }])
];

test('Matchup Score bug, reproduced: the OLD season-average basis saturates: a real bad week still scores ~89 against smoothed part-timer averages', () => {
    // Season totals implied by the weekly data above (the OLD basis never sees the real weeks, only each peer's season sum): R2 = 14, PT1..PT8 = 0,1,0,1,1,0,1,0.
    const oldPool = [
        P('R2', { '5': 14 }),
        P('PT1', { '5': 0 }), P('PT2', { '5': 1 }), P('PT3', { '5': 0 }), P('PT4', { '5': 1 }),
        P('PT5', { '5': 1 }), P('PT6', { '5': 0 }), P('PT7', { '5': 1 }), P('PT8', { '5': 0 })
    ];
    const oldBasis = buildCategoryRateBasis(oldPool, {
        sport: 'flb', relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: b14WeeksElapsed
    });
    // Typical weeks sorted: [0,0,0,0, 0.25,0.25,0.25,0.25, 3.5] (9 members).
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, oldBasis);
    const hotScore = scoreWeekAgainstBasis(b14Subject, { '5': 6 }, oldBasis);
    // Under the shared season convention, midrank over n-1, the cold week beats eight of nine and lands exactly at the ceiling: 8/(9-1) = 100. On the season-average basis the bad week and the hot week become literally the same number.
    assertClose(coldScore, 100, 'a genuinely bad 1-HR week saturates the smoothed basis outright');
    assertClose(hotScore, 100, 'the hot week also caps at 100, indistinguishable from the "bad" week at a glance');
    assert(coldScore >= 80, `THE BUG: cold week saturates near the ceiling instead of reading low (got ${coldScore})`);
});

test('Matchup Score fix, verified: the NEW real-weekly-value basis scores the same cold week meaningfully lower than the hot week', () => {
    const pool = [b14RegularPeer, ...b14PartTimers];
    const basis = buildWeeklyValueBasis(pool, { sport: 'flb', sport: 'flb', relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool sorted: [0,0,0,0, 1,1,1,1, 2,3,4,5], twelve real weeks. The cold week's 1 HR ties the four 1-HR weeks: four strictly worse, plus half of the three other ties, is 5.5, over n-1 = 11, which is 50.0. A strictly-worse over n rule would read 33.3 and count a tied week as beaten.
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, basis);
    const hotScore = scoreWeekAgainstBasis(b14Subject, { '5': 6 }, basis);
    assertClose(coldScore, 50, 'the cold week sits exactly at the median of this pool');
    assertClose(hotScore, 100, 'hot week still beats every real peer week');
    // Not below average: against a pool where eight of twelve weeks are one home run or none, a 1-HR week is the median week. A rule that counted the four tied weeks as beating it would call it 33rd. What this test pins is the spread between the cold week and the hot one, which is fifty points.
    assert(coldScore <= 50, `cold week reads no better than the median (got ${coldScore})`);
    // Exactly fifty now rather than sixty-seven: the cold week rose to the median it belongs at, the hot week was already capped, so the spread narrowed by the same amount the tie correction moved the cold week. Half the scale between a bad week and a great one is still the point.
    assert(hotScore - coldScore >= 50, `the fix restores real week-to-week spread (got ${hotScore - coldScore} points)`);
});

test('Matchup Score min-games decision: excluding part-timers from the weekly-value basis sharpens the cold-week score further', () => {
    // Same subject and cold week, but the basis pool is restricted to just the full-time peer - simulating players.js filtering to MIN_PLAYING_TIME_FRACTION of games played (same threshold/measure computeRotoRanks already uses for its own qualified-pool basis) before handing the pool to buildWeeklyValueBasis.
    const basis = buildWeeklyValueBasis([b14RegularPeer], { sport: 'flb', sport: 'flb', relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool: [2,3,4,5] (the full-time peer's real weeks only).
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, basis);
    assertClose(coldScore, 0, 'a 1-HR week beats none of a true regular peer\'s real weeks');
    // Part-timers are excluded (see buildWeeklyRateBasis in players.js). Comparing a regular's week to other regulars' real weeks is the more diagnostic peer group. With part-timers included the same bad week read 33% and not this sharper 0%, since their real but weak weeks acted as a soft floor under the whole distribution.
});

// ==== Roto standings scoring ====

test('rotoPointsForCategory: position points, best gets n and worst gets 1', () => {
    // 4 teams, higher is better. Values 40 > 30 > 20 > 10 -> 4, 3, 2, 1 points.
    const pts = rotoPointsForCategory([
        { id: 'a', value: 20 }, { id: 'b', value: 40 }, { id: 'c', value: 10 }, { id: 'd', value: 30 }
    ], false);
    assertClose(pts.get('b'), 4, 'top value gets n');
    assertClose(pts.get('d'), 3, 'second');
    assertClose(pts.get('a'), 2, 'third');
    assertClose(pts.get('c'), 1, 'worst gets 1');
});

test('rotoPointsForCategory: a two-way tie splits the block average, mirroring ESPN halves', () => {
    // The exact shape validated against a real payload: 5 teams, values 13, 10, 10, 8, 4. Positions (0-based) 0..4 are worth 5, 4, 3, 2, 1. The two 10s sit at positions 1 and 2, so they share (4+3)/2 = 3.5 each, the.5 ESPN's own pointsByStat shows for that tie.
    const pts = rotoPointsForCategory([
        { id: 'a', value: 13 }, { id: 'b', value: 10 }, { id: 'c', value: 10 },
        { id: 'd', value: 8 }, { id: 'e', value: 4 }
    ], false);
    assertClose(pts.get('a'), 5, 'unique top');
    assertClose(pts.get('b'), 3.5, 'tied pair shares the block average');
    assertClose(pts.get('c'), 3.5, 'and its partner');
    assertClose(pts.get('d'), 2, 'below the tie');
    assertClose(pts.get('e'), 1, 'worst');
});

test('rotoPointsForCategory: an inverse category ranks the LOWEST value best', () => {
    // GAA-style: lower is better. 2.35 < 2.40 < 2.84 -> 3, 2, 1 points.
    const pts = rotoPointsForCategory([
        { id: 'a', value: 2.84 }, { id: 'b', value: 2.35 }, { id: 'c', value: 2.40 }
    ], true);
    assertClose(pts.get('b'), 3, 'lowest GAA is best');
    assertClose(pts.get('c'), 2, 'middle');
    assertClose(pts.get('a'), 1, 'highest GAA is worst');
});

test('rotoPointsForCategory: a team with no value parks below every real value', () => {
    // 3 teams, one blank. The two real values rank among the full field of 3 (best 3, next 2), and the blank takes the leftover bottom position (1), never beating a real last-place number.
    const pts = rotoPointsForCategory([
        { id: 'a', value: 5 }, { id: 'b', value: undefined }, { id: 'c', value: 2 }
    ], false);
    assertClose(pts.get('a'), 3, 'best real value');
    assertClose(pts.get('c'), 2, 'the other real value still beats the blank');
    assertClose(pts.get('b'), 1, 'blank is last');
});

test('scoreRotoWeek: sums per-category points, with a tie and an inverse category', () => {
    // Two categories over three teams. HR (higher better): 30, 20, 10 -> 3, 2, 1. ERA (inverse, lower better) with a tie: 3.0, 3.0, 4.0 -> the two 3.0s tie for the top pair (3+2)/2 = 2.5, the 4.0 is worst at 1. Totals: A 3+2.5=5.5, B 2+2.5=4.5, C 1+1=2.
    const teams = [
        { id: 'A', values: { hr: 30, era: 3.0 } },
        { id: 'B', values: { hr: 20, era: 3.0 } },
        { id: 'C', values: { hr: 10, era: 4.0 } }
    ];
    const totals = scoreRotoWeek(teams, [{ id: 'hr', inverse: false }, { id: 'era', inverse: true }]);
    assertClose(totals.get('A'), 5.5, 'A: best HR (3) + tied-best ERA (2.5)');
    assertClose(totals.get('B'), 4.5, 'B: second HR (2) + tied-best ERA (2.5)');
    assertClose(totals.get('C'), 2, 'C: worst in both (1 + 1)');
});

// ==== Roster timeline: transaction-accurate rosters ====

// Item factory (only the fields buildRosterTimeline reads).
const IT = (playerId, type, toTeamId) => ({ playerId, type, toTeamId });
// Transaction factory. proposedDate defaults to the scoring period so tests that don't care about ordering read naturally; the out-of-order test sets it explicitly.
const TX = (scoringPeriodId, items, status = 'EXECUTED', proposedDate = scoringPeriodId) =>
    ({ scoringPeriodId, items, status, proposedDate });

test('buildRosterTimeline: draft-only seeds day-one rosters for the whole season', () => {
    const tl = buildRosterTimeline({ picks: [{ playerId: 10, teamId: 1 }, { playerId: 20, teamId: 2 }] });
    assertClose(teamForPlayerAtPeriod(tl, 10, 1), 1, 'drafted to team 1 from day one');
    assertClose(teamForPlayerAtPeriod(tl, 10, 180), 1, 'still team 1 late in the season');
    assertClose(teamForPlayerAtPeriod(tl, 20, 50), 2, 'the other pick');
    assertClose(teamForPlayerAtPeriod(tl, 999, 50), 0, 'an undrafted, untransacted player is nobody');
});

test('buildRosterTimeline: an ADD credits the picking-up team from its period on', () => {
    const tl = buildRosterTimeline({ transactions: [TX(5, [IT(10, 'ADD', 3)])] });
    assertClose(teamForPlayerAtPeriod(tl, 10, 4), 0, 'unrostered before the add');
    assertClose(teamForPlayerAtPeriod(tl, 10, 5), 3, 'team 3 from the add period');
    assertClose(teamForPlayerAtPeriod(tl, 10, 40), 3, 'and onward');
});

test('buildRosterTimeline: a DROP returns a drafted player to nobody', () => {
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [TX(10, [IT(10, 'DROP', 0)])]
    });
    assertClose(teamForPlayerAtPeriod(tl, 10, 9), 1, 'on team 1 before the drop');
    assertClose(teamForPlayerAtPeriod(tl, 10, 10), 0, 'unrostered from the drop period');
});

test('buildRosterTimeline: add -> drop -> re-add tracks every stint', () => {
    const tl = buildRosterTimeline({
        transactions: [
            TX(5, [IT(10, 'ADD', 2)]),
            TX(10, [IT(10, 'DROP', 0)]),
            TX(15, [IT(10, 'ADD', 2)])
        ]
    });
    assertClose(teamForPlayerAtPeriod(tl, 10, 3), 0, 'before the first add');
    assertClose(teamForPlayerAtPeriod(tl, 10, 7), 2, 'first stint on team 2');
    assertClose(teamForPlayerAtPeriod(tl, 10, 12), 0, 'dropped in between');
    assertClose(teamForPlayerAtPeriod(tl, 10, 20), 2, 're-added to team 2');
});

test('buildRosterTimeline: a TRADE moves a player from one team to the other', () => {
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [TX(8, [IT(10, 'TRADE', 2)])]
    });
    assertClose(teamForPlayerAtPeriod(tl, 10, 7), 1, 'on the drafting team before the trade');
    assertClose(teamForPlayerAtPeriod(tl, 10, 8), 2, 'on the receiving team after');
});

test('buildRosterTimeline: transactions replay in proposedDate order, not array order', () => {
    // Two changes to the SAME player in the SAME period, supplied newest-first in the array. Sorted by proposedDate the ADD (earlier) happens then the DROP (later), so the period ends unrostered. Without the sort the array order would leave the player wrongly on team 4.
    const drop = TX(8, [IT(10, 'DROP', 0)], 'EXECUTED', 200);
    const add = TX(8, [IT(10, 'ADD', 4)], 'EXECUTED', 100);
    const tl = buildRosterTimeline({ transactions: [drop, add] });
    assertClose(teamForPlayerAtPeriod(tl, 10, 8), 0, 'later DROP wins the period despite array order');
});

test('buildRosterTimeline: non-EXECUTED transactions never change a roster', () => {
    // PENDING, CANCELED and FAILED entries all carry real-looking items but never happened, so a player who was only ever the subject of these is unrostered. The lone status-less TRADE_ACCEPT (empty items) is excluded the same way and would be a no-op regardless.
    const tl = buildRosterTimeline({
        transactions: [
            TX(5, [IT(10, 'ADD', 1)], 'PENDING'),
            TX(6, [IT(10, 'ADD', 2)], 'CANCELED'),
            TX(7, [IT(10, 'ADD', 3)], 'FAILED_INVALIDPLAYERSOURCE'),
            { scoringPeriodId: 8, items: [], proposedDate: 8, type: 'TRADE_ACCEPT' } // no status field
        ]
    });
    assertClose(teamForPlayerAtPeriod(tl, 10, 50), 0, 'no executed transaction ever put this player on a team');
});

test('buildRosterTimeline: LINEUP and DRAFT items do not move membership', () => {
    // LINEUP is a move between a bench and a starting slot and is skipped here. A DRAFT item mirrors the pick that already seeded the roster, so it must not double-count or override a later drop.
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [
            TX(3, [IT(10, 'LINEUP', 0)]),
            TX(20, [IT(10, 'DROP', 0)]),
            TX(25, [IT(10, 'DRAFT', 1)]) // stray DRAFT-typed item after a drop must be ignored
        ]
    });
// The careers table asks who ever held this player, not who held the player on one day.
test('ownerTeamIdsByPlayer: every franchise a player was ever on, first-held first', () => {
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [TX(5, [IT(10, 'DROP', 0)]), TX(9, [IT(10, 'ADD', 3)]), TX(12, [IT(10, 'TRADE', 2)])]
    });
    const owners = ownerTeamIdsByPlayer(tl);
    assert(JSON.stringify(owners.get(10)) === '[1,3,2]', 'drafted by 1, picked up by 3, traded to 2');
});

test('ownerTeamIdsByPlayer: a drop is not a franchise, and a re-add is not a second one', () => {
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [TX(5, [IT(10, 'DROP', 0)]), TX(9, [IT(10, 'ADD', 1)])]
    });
    assert(JSON.stringify(ownerTeamIdsByPlayer(tl).get(10)) === '[1]', 'team 0 is nobody, and team 1 is already there');
});

test('ownerTeamIdsByPlayer: a player nobody ever held is absent, not empty', () => {
    const owners = ownerTeamIdsByPlayer(buildRosterTimeline({ transactions: [TX(3, [IT(77, 'DROP', 0)])] }));
    assert(owners.has(77) === false, 'a drop with no prior hold leaves nothing to report');
    assert(ownerTeamIdsByPlayer(null).size === 0, 'and no timeline at all is an empty map, not a throw');
});
    assertClose(teamForPlayerAtPeriod(tl, 10, 10), 1, 'LINEUP did not change the drafted ownership');
    assertClose(teamForPlayerAtPeriod(tl, 10, 30), 0, 'stays dropped, since the DRAFT item is skipped');
});

// buildStartedTimeline and startedTeamForPlayerAtPeriod: started-day crediting from the daily roster snapshots. STARTING is { 3, 4, 5, 6 } here (hockey F/D/G/UTIL), with the bench at 7 and IR at 8.

// needsEveryDay: a starter table is not a pitcher's.
test('needsEveryDay: a listed start or a pitching seat, and never a batter with a table', () => {
    assertEq(needsEveryDay({ starterStatusByProGame: { 401: 'NOTSTARTING' }, pitcherEligible: false }), false,
        'a batter carries a one-entry table and keeps nothing');
    assertEq(needsEveryDay({ starterStatusByProGame: { 401: 'NOTSTARTING', 402: 'PROBABLE' }, pitcherEligible: false }), true,
        'a listed start is a start, whatever the seat says');
    assertEq(needsEveryDay({ starterStatusByProGame: { 401: 'NOTSTARTING' }, pitcherEligible: true }), true,
        'a pitcher between listings is still a pitcher');
});

test('needsEveryDay: no starter table is no start to print, eligible or not', () => {
    assertEq(needsEveryDay({ starterStatusByProGame: {}, pitcherEligible: true }), false, 'an empty table');
    assertEq(needsEveryDay({ pitcherEligible: true }), false, 'no table: a hockey goalie');
    assertEq(needsEveryDay({ starterStatusByProGame: null, pitcherEligible: 'yes' }), false, 'nor a truthy guess');
    assertEq(needsEveryDay({ starterStatusByProGame: { 401: 'NOTSTARTING' }, pitcherEligible: 'yes' }), false, 'eligibility is exactly true');
    assertEq(needsEveryDay(), false, 'nothing in');
});

// dayBucketScope: which of a player's days the weekly harvest keeps.
test('dayBucketScope: a rostered player keeps the matchup days and nobody else keeps any', () => {
    const opts = { everyDayIds: new Set([7]), rosteredIds: new Set([10, 11, 7]), matchupPeriods: [8, 9, 10] };
    assertEq([...dayBucketScope(10, opts)], [8, 9, 10], 'rostered: the three days of the matchup');
    assertEq(dayBucketScope(99, opts), null, 'a free agent keeps nothing');
    assertEq(dayBucketScope(7, opts), 'all', 'a whole-season player stays whole-season, rostered or not');
    assertEq(dayBucketScope(7, { everyDayIds: new Set([7]) }), 'all', 'and needs no roster to be');
});

test('dayBucketScope: no matchup to bound by is NOTHING, never every day', () => {
    const rostered = new Set([10]);
    assertEq(dayBucketScope(10, { rosteredIds: rostered }), null, 'no periods at all');
    assertEq(dayBucketScope(10, { rosteredIds: rostered, matchupPeriods: [] }), null, 'an empty matchup');
    assertEq(dayBucketScope(10, { rosteredIds: rostered, matchupPeriods: [0, null, 'x'] }), null, 'no real period among them');
    assertEq([...dayBucketScope(10, { rosteredIds: rostered, matchupPeriods: ['8', 9, 0] })], [8, 9], 'periods are numbers, and 0 is not one');
    assertEq(dayBucketScope(10), null, 'no tables, no days');
});

/**
 * startedDaySums and weightedTotal. Two teams, three days, hockey's seats: 3 to 6 start and 7 is
 * the bench. Stat 13 is goals, 14 assists, and 20 a third the fixture leaves unweighted.
 *   day 8: team 1 starts p10 (2 G, 1 A) and benches p11 (1 G); team 2 starts p20 (1 G)
 *   day 9: team 1 starts p11 (3 A) and benches p10 (5 G, the benched goals count for nobody);
 *          team 2 starts p20, who has no line that day
 *   day 10: no lineup was fetched at all
 */
const SDS_DAYS = {
    8: [{ id: 1, entries: [{ p: 10, slot: 3 }, { p: 11, slot: 7 }] }, { id: 2, entries: [{ p: 20, slot: 5 }] }],
    9: [{ id: 1, entries: [{ p: 10, slot: 7 }, { p: 11, slot: 4 }] }, { id: 2, entries: [{ p: 20, slot: 5 }] }]
};
const SDS_LINES = {
    10: { 8: { sums: { 13: 2, 14: 1 }, games: 1 }, 9: { sums: { 13: 5 }, games: 1 } },
    11: { 8: { sums: { 13: 1 }, games: 1 }, 9: { sums: { 14: 3 }, games: 1 } },
    20: { 8: { sums: { 13: 1 }, games: 1 } }
};
const sds = (over = {}) => startedDaySums({
    rosterDays: SDS_DAYS, startingSlots: new Set([3, 4, 5, 6]), dailyByPlayer: SDS_LINES, periods: [8, 9, 10], ...over });

test('startedDaySums: a day is credited to the team that STARTED the player, and to nobody when benched', () => {
    const out = sds();
    assertEq(out.byTeam.get(1), { 8: { sums: { 13: 2, 14: 1 }, games: 1 }, 9: { sums: { 14: 3 }, games: 1 } },
        'team 1: p10 on day 8, p11 on day 9; neither benched line');
    assertEq(out.byTeam.get(2), { 8: { sums: { 13: 1 }, games: 1 } }, 'team 2: one goal on day 8, no line on day 9');
});

test('startedDaySums: a day with no lineup is missing, and a day nobody played is still a day', () => {
    const out = sds();
    assertEq([out.periods, out.missing], [[8, 9], [10]], 'day 10 has no lineup; day 9 stays although team 2 scored nothing');
    assertEq(sds({ rosterDays: { 8: SDS_DAYS[8], 9: [] } }).missing, [9, 10], 'an empty snapshot is no lineup');
});

test('startedDaySums: a started player with no table is UNKNOWN, never a silent zero', () => {
    const lines = { 10: SDS_LINES[10], 11: SDS_LINES[11] };           // p20 never handed in
    const out = sds({ dailyByPlayer: lines });
    assertEq(out.unknown, [20], 'named by id');
    assertEq(out.byTeam.get(2), {}, 'and nothing invented for the team');
    assertEq(sds({ dailyByPlayer: { ...lines, 20: {} } }).unknown, [], 'an empty table is a known player who did not play');
    assertEq(sds({ dailyByPlayer: lines, rosterDays: { 8: [{ id: 1, entries: [{ p: 20, slot: 7 }] }] } }).unknown, [],
        'a BENCHED player is never asked about');
});

test('startedDaySums: a Map reads as an object does, and teamIds bounds and seeds the answer', () => {
    const asMap = new Map(Object.entries(SDS_LINES).map(([k, v]) => [Number(k), v]));
    assertEq([...sds({ dailyByPlayer: asMap }).byTeam], [...sds().byTeam], 'the same sums');
    const only = sds({ teamIds: [2, 3] });
    assertEq([...only.byTeam.keys()], [2, 3], 'team 1 left out, team 3 present with nothing');
    assertEq(only.byTeam.get(3), {}, 'a team with no lineup entry has no days');
    assertEq(startedDaySums().periods, [], 'no tables, no days');
});

/**
 * A seat's role. One two-way player, p30, whose day line holds both halves: stat 5 is a home run
 * and stat 48 a strikeout thrown. Seat 12 is a hitter's, 14 a pitcher's, 16 the bench. The rule the
 * caller hands in is baseball's: 48 counts in seat 14 only.
 *   day 8: team 1 starts p30 in the hitter seat (1 HR, 6 K thrown), so the HR counts and the K do not
 *   day 9: team 1 starts p30 in the pitcher seat (2 HR, 9 K thrown), so the K count and the HR do not
 */
const SEAT_DAYS = {
    8: [{ id: 1, entries: [{ p: 30, slot: 12 }] }],
    9: [{ id: 1, entries: [{ p: 30, slot: 14 }] }]
};
const SEAT_LINES = { 30: { 8: { sums: { 5: 1, 48: 6 }, games: 1 }, 9: { sums: { 5: 2, 48: 9 }, games: 1 } } };
const seatRule = (slot, id) => (slot === 14) === (String(id) === '48');

test('startedDaySums: a started player is credited with the stats of the seat, not the whole line', () => {
    const out = startedDaySums({ rosterDays: SEAT_DAYS, startingSlots: new Set([12, 14]), dailyByPlayer: SEAT_LINES,
        periods: [8, 9], countsFor: seatRule });
    assertEq(out.byTeam.get(1), { 8: { sums: { 5: 1 }, games: 1 }, 9: { sums: { 48: 9 }, games: 1 } },
        'the hitter day keeps the home run, the pitcher day the strikeouts; the appearance counts both days');
});

test('startedDaySums: with no rule handed in every stat on the line counts, as it always has', () => {
    const out = startedDaySums({ rosterDays: SEAT_DAYS, startingSlots: new Set([12, 14]), dailyByPlayer: SEAT_LINES, periods: [8, 9] });
    assertEq(out.byTeam.get(1), { 8: { sums: { 5: 1, 48: 6 }, games: 1 }, 9: { sums: { 5: 2, 48: 9 }, games: 1 } }, 'unscoped');
    // Anything that is not a function is no rule, never a rule that refuses everything.
    const junk = startedDaySums({ rosterDays: SEAT_DAYS, startingSlots: new Set([12, 14]), dailyByPlayer: SEAT_LINES, periods: [8], countsFor: 'yes' });
    assertEq(junk.byTeam.get(1), { 8: { sums: { 5: 1, 48: 6 }, games: 1 } }, 'a non-function is ignored');
});

// The roto race's half of the same rule. The race knows who started a player from buildStartedTimeline and reads the seat from buildStartedSeats, then credits the line through creditedStats, the one function the matchup race's startedDaySums also calls. Same player and days as above, plus day 10 on the bench.
test('the roto race: the seat is read beside the team, and one function credits the line', () => {
    const days = { ...SEAT_DAYS, 10: [{ id: 1, entries: [{ p: 30, slot: 16 }] }] };
    const seats = buildStartedSeats({ rosterDays: days, startingSlots: new Set([12, 14]) });
    assertEq([...seats.get(30)], [[8, 12], [9, 14]], 'the hitter seat on day 8, the pitcher seat on day 9, no seat on the bench');
    // Day 8 in the hitter seat: 1 HR and 6 K on the line, the HR counts. Day 9 in the pitcher seat: 2 HR and 9 K, the K count. A season of those two days is 1 HR and 9 K, not 3 HR and 15 K.
    const season = {};
    [8, 9].forEach(d => {
        const credited = creditedStats(SEAT_LINES[30][d].sums, seats.get(30).get(d), seatRule);
        Object.keys(credited).forEach(id => { season[id] = (season[id] || 0) + credited[id]; });
    });
    assertEq(season, { 5: 1, 48: 9 }, 'each day by its seat');
    assertEq(creditedStats({ 5: 2, 48: 9 }, 14, null), { 5: 2, 48: 9 }, 'no rule, the whole line');
    assertEq(creditedStats({ 5: 'x', 48: 3 }, 14, null), { 48: 3 }, 'a value that is not a number is left out, never NaN');
    assertEq(creditedStats(null, 12, seatRule), {}, 'no line, nothing');
});

test('weightedTotal: the sums in points, and what the total left out', () => {
    // Goals 2 each, assists 1.5: day 8 for team 1 is 2*2 + 1*1.5 = 5.5.
    assertEq(weightedTotal({ 13: 2, 14: 1 }, { 13: 2, 14: 1.5 }), { total: 5.5, missing: 0 }, 'day 8');
    assertEq(weightedTotal({ 13: 2, 20: 4 }, { 13: 2, 20: null }), { total: 4, missing: 1 }, 'a figure with no weight is counted, not guessed');
    assertEq(weightedTotal({ 13: 2 }, { 13: 2, 20: null }), { total: 4, missing: 0 }, 'no figure, nothing missing');
    assertEq(weightedTotal({ 13: 2, 99: 7 }, { 13: -1 }), { total: -2, missing: 0 }, 'a stat the league does not score is not a row');
    assertEq(weightedTotal(null, null), { total: 0, missing: 0 }, 'nothing in, nothing out');
});

// Entry + snapshot-day factories (only the fields buildStartedTimeline reads).
const E = (p, slot) => ({ p, slot });
const STARTERS = new Set([3, 4, 5, 6]);

test('buildStartedTimeline: a started day credits the team, a benched day credits nobody', () => {
    // Same two players, slots swapped between two days. Whoever is in a starting slot that day counts.
    const tl = buildStartedTimeline({
        rosterDays: {
            1: [{ id: 1, entries: [E(10, 3), E(11, 7)] }], // p10 starting (F), p11 benched
            2: [{ id: 1, entries: [E(10, 7), E(11, 3)] }]  // swapped
        },
        startingSlots: STARTERS
    });
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 1), 1, 'p10 started day 1');
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 2), 0, 'p10 benched day 2, nobody');
    assertClose(startedTeamForPlayerAtPeriod(tl, 11, 1), 0, 'p11 benched day 1, nobody');
    assertClose(startedTeamForPlayerAtPeriod(tl, 11, 2), 1, 'p11 started day 2');
});

test('buildStartedTimeline: a mid-week benching only drops the benched day', () => {
    // Periods 8,9,10 all fall in week 1 (floor(p/7)=1). Started 8 and 9, benched 10 - the race sums only the two started days into that week, not the benched one.
    const tl = buildStartedTimeline({
        rosterDays: {
            8: [{ id: 2, entries: [E(10, 4)] }],
            9: [{ id: 2, entries: [E(10, 4)] }],
            10: [{ id: 2, entries: [E(10, 7)] }]
        },
        startingSlots: STARTERS
    });
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 8), 2, 'started day 8');
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 9), 2, 'started day 9');
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 10), 0, 'benched day 10, nobody');
});

test('buildStartedTimeline: an IR-slotted player credits nobody that day', () => {
    // Slot 8 (IR) is not a starting slot, so an injured player rostered but on IR does not count - exactly what ESPN's standings do.
    const tl = buildStartedTimeline({
        rosterDays: { 5: [{ id: 3, entries: [E(10, 8)] }] },
        startingSlots: STARTERS
    });
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 5), 0, 'IR slot 8 credits nobody');
});

test('buildStartedTimeline: benched, IR, unrostered, and never-seen all fall through to nobody', () => {
    // The per-day fallback. Any day a player is not in a starting slot on some team credits nobody, so the race skips it (whichever fallback tier is active never invents a crediting team).
    const tl = buildStartedTimeline({
        rosterDays: { 5: [{ id: 3, entries: [E(10, 7), E(11, 8)] }] }, // p10 bench, p11 IR
        startingSlots: STARTERS
    });
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 5), 0, 'benched');
    assertClose(startedTeamForPlayerAtPeriod(tl, 11, 5), 0, 'on IR');
    assertClose(startedTeamForPlayerAtPeriod(tl, 10, 99), 0, 'no snapshot for that period');
    assertClose(startedTeamForPlayerAtPeriod(tl, 555, 5), 0, 'a player never in any snapshot');
});

test('buildStartedTimeline: crediting follows the passed startingSlots set, not any hardcoded ids', () => {
    // The pure module knows nothing about which slot is a starter. The league resolves that from its own rosterSettings and passes the set in. With only slot 3 starting, a slot-4 player is benched.
    const days = { 1: [{ id: 1, entries: [E(10, 3), E(20, 4)] }] };
    const onlyThree = buildStartedTimeline({ rosterDays: days, startingSlots: new Set([3]) });
    assertClose(startedTeamForPlayerAtPeriod(onlyThree, 10, 1), 1, 'slot 3 starts');
    assertClose(startedTeamForPlayerAtPeriod(onlyThree, 20, 1), 0, 'slot 4 not a starter under this set');
    const both = buildStartedTimeline({ rosterDays: days, startingSlots: new Set([3, 4]) });
    assertClose(startedTeamForPlayerAtPeriod(both, 20, 1), 1, 'slot 4 starts once the set includes it');
});

// ==== computePointsRanks: the points-league ranking ====

// Two weights, hand-computable. Goals are worth 2 and assists 1, so the totals below are exact.
const PTS_WEIGHTS = { '13': 2, '14': 1 };
const ptsCtx = { weights: PTS_WEIGHTS, workloadOf: p => p.gp };
const ptsPlayer = (id, g, a, gp = 10) => ({ id, gp, seasonTotals: { '13': g, '14': a } });

test('computePointsRanks: ranks by the league weighted total', () => {
    // 10*2+5 = 25, 8*2+12 = 28, 12*2+0 = 24.
    const r = computePointsRanks([ptsPlayer(1, 10, 5), ptsPlayer(2, 8, 12), ptsPlayer(3, 12, 0)], ptsCtx);
    assertClose(r.scores.get(1), 25, 'player 1 total');
    assertClose(r.scores.get(2), 28, 'player 2 total');
    assertClose(r.scores.get(3), 24, 'player 3 total');
    assert(r.ranks.get(2) === 1 && r.ranks.get(1) === 2 && r.ranks.get(3) === 3, 'most points first');
    assert(r.total === 3, 'everyone ranked');
});

test('computePointsRanks: a stat with no weight contributes nothing', () => {
    const p = { id: 1, gp: 5, seasonTotals: { '13': 3, '99': 1000 } };
    assertClose(computePointsRanks([p], ptsCtx).scores.get(1), 6, 'the unweighted stat is ignored');
});

test('computePointsRanks: negative weights subtract', () => {
    // A real league does this: penalty minutes at -2 in the validated capture.
    const ctx = { weights: { '13': 2, '17': -2 }, workloadOf: p => p.gp };
    const p = { id: 1, gp: 5, seasonTotals: { '13': 4, '17': 3 } };
    assertClose(computePointsRanks([p], ctx).scores.get(1), 2, '8 scored minus 6 conceded');
});

test('computePointsRanks: a player who has not played is unranked, not last', () => {
    // Same floor computeRotoRanks uses, where zero playing time is zero evidence. Ranking them would pile every unplayed player at the bottom on a score that means nothing.
    const r = computePointsRanks([ptsPlayer(1, 10, 5), ptsPlayer(2, 0, 0, 0)], ptsCtx);
    assert(!r.ranks.has(2), 'not ranked');
    assert(!r.scores.has(2), 'and not scored');
    assert(r.total === 1, 'the pool is the players who played');
});

test('computePointsRanks: before anyone has played, everybody still ranks', () => {
    // Preseason, or a freshly created league. Refusing to rank would empty the board instead of ranking on whatever projections the pool carries.
    const r = computePointsRanks([ptsPlayer(1, 3, 1, 0), ptsPlayer(2, 1, 1, 0)], ptsCtx);
    assert(r.total === 2, 'both ranked');
    assert(r.ranks.get(1) === 1, 'still ordered by points');
});

test('computePointsRanks: ties order by id so a re-render does not reshuffle', () => {
    const r = computePointsRanks([ptsPlayer(7, 5, 0), ptsPlayer(3, 5, 0)], ptsCtx);
    assert(r.ranks.get(3) === 1 && r.ranks.get(7) === 2, 'lower id takes the earlier rank');
});

// One tie convention, and T-N wherever a shared rank renders.
test('competitionRanks: a run of ties shares the run first rank, the next distinct value resumes', () => {
    assert(JSON.stringify(competitionRanks([10, 8, 8, 5])) === '[1,2,2,4]', 'not 1,2,2,3 - the next value takes its true place');
    assert(JSON.stringify(competitionRanks([9, 9, 9])) === '[1,1,1]', 'everyone tied is all first');
    assert(JSON.stringify(competitionRanks([5])) === '[1]', 'one entry');
    assert(JSON.stringify(competitionRanks([])) === '[]', 'none');
    assert(JSON.stringify(competitionRanks([3, 2, 1])) === '[1,2,3]', 'no ties, plain ordinals');
    // The callers hand in composite keys, so equality has to be by value not by object identity.
    assert(JSON.stringify(competitionRanks(['4|10', '4|10', '3|9'])) === '[1,1,3]', 'composite keys compare by value');
});

test('formatRank: shared ranks read T-N, unique ranks keep the hash', () => {
    const ranks = [1, 2, 2, 4];
    assert(formatRank(1, ranks) === '#1', 'alone at the top');
    assert(formatRank(2, ranks) === 'T2', 'shared');
    assert(formatRank(4, ranks) === '#4', 'alone again');
    assert(formatRank(3, []) === '#3', 'no rank list is not a tie');
    assert(formatRank(1, [1, 1, 1]) === 'T1', 'everyone tied');
});

// Head-to-head comparison. One pool, two players, hand-computed from computeStatRankInPool's documented percentile ((total-rank)/(total-1)*100) and the competition-ranking tie rule.

// HR higher-is-better, ERA lower-is-better. Five players, with a deliberate tie at 25 HR.
const cmpPool = [
    P(1, { '5': 30, '47': 2.00 }),
    P(2, { '5': 25, '47': 3.00 }),
    P(3, { '5': 25, '47': 4.00 }),
    P(4, { '5': 10, '47': 5.00 }),
    P(5, { '5': 5, '47': 6.00 })
];
const cmpCtx = {
    statIds: ['5', '47'],
    inverseStatIds: new Set(['47']),
    statMap: { '5': 'HR', '47': 'ERA' }
};

test('comparePlayerCategories: both sides read off ONE pool, ranks and percentiles hand-computed', () => {
    const { rows, tally } = comparePlayerCategories(cmpPool, 2, 4, cmpCtx);
    assert(rows.length === 2, 'one row per requested category');

    // HR sorted desc: 30, 25, 25, 10, 5 -> competition ranks 1, 2, 2, 4, 5.
    const hr = rows[0];
    assert(hr.name === 'HR' && hr.inverse === false, 'labelled and not inverse');
    assert(hr.a.rank === 2 && hr.a.total === 5, 'player 2 is second of five on HR');
    assertClose(hr.a.percentile, 75, 'HR percentile for rank 2 of 5');
    assert(hr.b.rank === 4, 'player 4 is fourth on HR');
    assertClose(hr.b.percentile, 25, 'HR percentile for rank 4 of 5');
    assert(hr.edge === 'a', '25 HR beats 10 HR');

    // ERA sorted asc (lower is better): 2, 3, 4, 5, 6 -> ranks 1..5, no ties.
    const era = rows[1];
    assert(era.inverse === true, 'ERA is inverse');
    assert(era.a.rank === 2 && era.b.rank === 4, 'ERA ranks follow the ascending order');
    assertClose(era.a.percentile, 75, 'ERA percentile for rank 2 of 5');
    assert(era.edge === 'a', 'the LOWER ERA takes the edge');

    assert(tally.a === 2 && tally.b === 0 && tally.tie === 0, 'a sweeps both');
});

test('comparePlayerCategories: an equal value is a tie, counted as neither side', () => {
    const { rows, tally } = comparePlayerCategories(cmpPool, 2, 3, cmpCtx);
    const hr = rows[0];
    assert(hr.a.rank === 2 && hr.b.rank === 2, 'both share the run first rank, not 2 and 3');
    assertClose(hr.a.percentile, 75, 'a tie shares the percentile too');
    assertClose(hr.b.percentile, 75, 'both sides of the tie');
    assert(hr.edge === 'tie', '25 against 25');
    // ERA still splits them, so the tally is one edge and one tie.
    assert(rows[1].edge === 'a', 'a 3.00 ERA beats a 4.00');
    assert(tally.a === 1 && tally.b === 0 && tally.tie === 1, 'the tie is its own count');
});

test('comparePlayerCategories: inverse edges do not silently flip', () => {
    const { rows, tally } = comparePlayerCategories(cmpPool, 5, 1, cmpCtx);
    assert(rows[0].edge === 'b', '5 HR loses to 30');
    assert(rows[1].edge === 'b', 'a 6.00 ERA loses to a 2.00 - the higher number is the worse one');
    assert(tally.b === 2 && tally.a === 0, 'b sweeps');
});

test('comparePlayerCategories: a category only one player has keeps its row and scores for nobody', () => {
    const pool = cmpPool.map(p => p.id === 4 ? P(4, { '5': 10 }) : p);
    const { rows, tally } = comparePlayerCategories(pool, 2, 4, cmpCtx);
    const era = rows[1];
    assert(era.b === null, 'the side with no value is absent, not a zero');
    // The ERA pool is now four players: 2.00, 3.00, 4.00, 6.00 -> player 2 is second of four.
    assert(era.a.rank === 2 && era.a.total === 4, 'the category pool shrinks with the missing value');
    assertClose(era.a.percentile, (4 - 2) / (4 - 1) * 100, 'percentile is against the four who have one');
    assert(era.edge === 'none', 'nothing to compare');
    assert(tally.a === 1 && tally.b === 0 && tally.tie === 0, 'only the HR edge counted');
});

test('comparePlayerCategories: a player outside the pool leaves both sides honest', () => {
    const { rows, tally } = comparePlayerCategories(cmpPool, 2, 99, cmpCtx);
    assert(rows.every(r => r.b === null), 'the unknown id has no side');
    assert(rows.every(r => r.a !== null), 'the known one still reports');
    assert(tally.a === 0 && tally.b === 0 && tally.tie === 0, 'no edges without two sides');
});


// The day strip's verdict. Scored against the player's own days, counting categories only. Every expectation below is hand-computed from the numbers in the fixture.

test('perDayAverages: averages over PLAYED days only', () => {
    const days = {
        10: { games: 1, sums: { '1': 2, '5': 1 } },
        11: { games: 1, sums: { '1': 0, '5': 0 } },
        12: { games: 0, sums: {} },          // off day - must not dilute the average
        13: { games: 1, sums: { '1': 4, '5': 2 } }
    };
    const avg = perDayAverages(days, ['1', '5']);
    // Hand-computed: three played days. H 2+0+4 = 6 over 3 = 2. HR 1+0+2 = 3 over 3 = 1.
    assert(avg['1'] === 2, 'H average is 2, got ' + avg['1']);
    assert(avg['5'] === 1, 'HR average is 1, got ' + avg['5']);
    assert(perDayAverages({}, ['1'])['1'] === undefined, 'no played days yields no baseline');
});

test('scoreDayAgainstSelf: a day is a multiple of the average day', () => {
    const avg = { '1': 2, '5': 1 };
    // 4 hits is 2x, 2 homers is 2x -> mean 2.
    assert(scoreDayAgainstSelf({ '1': 4, '5': 2 }, avg, ['1', '5']) === 2, 'twice the usual');
    // 2 hits and 1 homer is exactly the average day.
    assert(scoreDayAgainstSelf({ '1': 2, '5': 1 }, avg, ['1', '5']) === 1, 'an average day scores 1');
    // 1 hit (0.5x) and no homers (0x) -> mean 0.25.
    assert(scoreDayAgainstSelf({ '1': 1, '5': 0 }, avg, ['1', '5']) === 0.25, 'a quiet day');
    // A blank day is 0 and not null: the player played and produced nothing.
    assert(scoreDayAgainstSelf({}, avg, ['1', '5']) === 0, 'played, nothing recorded');
});

test('scoreDayAgainstSelf: a category with no baseline is skipped, not scored as zero', () => {
    // The player has never stolen a base, so SB has no average. Counting it as a zero would drag every day down by a category the player never contributes in.
    const avg = { '1': 2, '23': 0 };
    // Only H is scored: 4/2 = 2, not (2 + 0)/2 = 1.
    assert(scoreDayAgainstSelf({ '1': 4, '23': 0 }, avg, ['1', '23']) === 2, 'SB is not a baseline');
    assert(scoreDayAgainstSelf({ '1': 1 }, {}, ['1']) === null, 'no baselines at all yields null');
});

test('typicalDayScore: the MEDIAN day, which is why the strip is not all red', () => {
    // The shape that broke the first build: four quiet days and one huge one. The MEAN is 1.4, so every quiet day would read below average and the strip would be red with a gold fleck. The median is 1, so the quiet days read ordinary and the big one reads signature.
    const scores = [1, 1, 1, 1, 3];
    assert(typicalDayScore(scores) === 1, 'median 1, where the mean is 1.4');
    assert(typicalDayScore([2, 4]) === 3, 'even count averages the middle pair');
    assert(typicalDayScore([]) === null, 'no days, no baseline');
    assert(typicalDayScore([null, 2, null]) === 2, 'unscoreable days are not zeros');
});

test('dayVerdict: the four tiers land on the named constants, against the typical day', () => {
    assert(DAY_SIGNATURE_RATIO === 1.75 && DAY_ORDINARY_BAND === 0.15, 'the constants are the ruling');
    assert(dayVerdict(2.0, false, 1) === 'signature', '2x the typical day');
    assert(dayVerdict(1.75, false, 1) === 'signature', 'exactly the ratio counts');
    assert(dayVerdict(1.5, false, 1) === 'above', 'over the band but under the ratio');
    assert(dayVerdict(1.16, false, 1) === 'above', 'just outside the band');
    assert(dayVerdict(1.15, false, 1) === 'ordinary', 'the band edge is still ordinary');
    assert(dayVerdict(1.0, false, 1) === 'ordinary', 'the typical day');
    assert(dayVerdict(0.85, false, 1) === 'ordinary', 'the low edge of the band');
    assert(dayVerdict(0.84, false, 1) === 'below', 'under the band');
    assert(dayVerdict(0, false, 1) === 'below', 'a blank day is a bad day');
});

test('presentDayScore: a typical day reads 50, twice typical reads 100, and nothing reads past the cap', () => {
    assert(DAY_SCORE_TYPICAL === 50 && DAY_SCORE_CAP === 100, 'the constants are the ruling (B202 item 1)');
    assert(presentDayScore(1) === 50, 'the typical day: 1 x 50');
    assert(presentDayScore(2) === 100, 'twice typical: 2 x 50');
    assert(presentDayScore(3.1) === 100, '3.1 x 50 = 155, capped at 100');
    assert(presentDayScore(1.3) === 65, '1.3 x 50 = 65');
    assert(presentDayScore(0.37) === 19, '0.37 x 50 = 18.5, rounds to 19');
    assert(presentDayScore(0) === 0, 'a blank day is 0');
    assert(presentDayScore(null) === null, 'no score is no figure, not 0');
});

test('dayVerdict: the ratio is against the TYPICAL day, not against 1', () => {
    // A player whose typical day scores 2: a day at 2 is ordinary there, and 3.5 is a signature one.
    assert(dayVerdict(2, false, 2) === 'ordinary', 'that own typical day is ordinary');
    assert(dayVerdict(3.5, false, 2) === 'signature', '1.75x of 2');
    assert(dayVerdict(1, false, 2) === 'below', 'half the usual is a poor day');
});

test('dayVerdict: a signature day overrules the ratio, in both directions', () => {
    // A two-homer game in a huge season can score under the ratio. The sport's own statement wins.
    assert(dayVerdict(0.9, true, 1) === 'signature', 'the rule beats a middling ratio');
    assert(dayVerdict(null, true, 1) === 'signature', 'and beats an unscoreable day');
    assert(dayVerdict(0.9, false, 1) === 'ordinary', 'no flag, no gold');
});

test('dayVerdict: an unscoreable day, or no baseline, reads ordinary rather than bad', () => {
    // null means nothing could be compared, which is not the same as a poor day, and a red border would be an accusation the data does not support.
    assert(dayVerdict(null, false, 1) === 'ordinary', 'null is not zero');
    assert(dayVerdict(undefined, false, 1) === 'ordinary', 'and neither is undefined');
    assert(dayVerdict(3, false, null) === 'ordinary', 'no typical day yet, no verdict');
    assert(dayVerdict(3, false, 0) === 'ordinary', 'and a zero typical is not a divisor');
});


// Report ---------------------------------------------------------------------------


// ==== Window-projected lines ====

test('windowProjectedLine: counting categories scale with games, rates do NOT', () => {
    // Four games of two home runs a game is eight home runs. Four games of a 3.00 ERA is still a 3.00 ERA. Multiplying it would say a pitcher gets worse the more innings are pitched, which is a unit error and not a projection.
    const line = windowProjectedLine({ 5: 2, 47: 3.0 }, 4, new Set(['47']));
    assertClose(line['5'], 8, 'home runs scale');
    assertClose(line['47'], 3.0, 'ERA rides through untouched');
});

test('windowProjectedLine: a null per-game figure is skipped, never read as zero', () => {
    const line = windowProjectedLine({ 5: null, 20: undefined, 9: 1 }, 3, new Set());
    assert(!('5' in line), 'null is absent, not 0');
    assert(!('20' in line), 'undefined too');
    assertClose(line['9'], 3, 'and the real one scales');
});

// The reported case: two players, two categories, one club playing twice the games. Player A: 1 HR and 1 RBI per game, club plays 2 -> line 2 HR, 2 RBI. Player B: 1 HR and 1 RBI per game, club plays 4 -> line 4 HR, 4 RBI. B is ahead in both, so B is #1 and A is #2 - the whole point of the lens.
test('windowLineRanks: the same player ranks higher when that club plays more', () => {
    const rateIds = new Set();
    const rows = [
        { id: 'A', line: windowProjectedLine({ 5: 1, 21: 1 }, 2, rateIds) },
        { id: 'B', line: windowProjectedLine({ 5: 1, 21: 1 }, 4, rateIds) }
    ];
    const ranks = windowLineRanks(rows, { categoryIds: ['5', '21'], rateIds });
    assert(ranks.get('B').label === 1, 'the club playing twice as often');
    assert(ranks.get('A').label === 2, 'the identical player with half the games');
});

test('windowLineRanks: an inverse category ranks the LOW line first', () => {
    // Two pitchers, ERA only. A projects 2.50, B projects 4.00 - A is better and must rank first.
    const rateIds = new Set(['47']);
    const rows = [
        { id: 'A', line: windowProjectedLine({ 47: 2.5 }, 3, rateIds) },
        { id: 'B', line: windowProjectedLine({ 47: 4.0 }, 6, rateIds) }
    ];
    const ranks = windowLineRanks(rows, { categoryIds: ['47'], inverseIds: new Set(['47']), rateIds });
    assert(ranks.get('A').label === 1, 'the lower ERA leads');
    assert(ranks.get('B').label === 2, 'more games does not rescue a worse rate');
});

test('windowLineRanks: equal lines SHARE a place and are marked tied', () => {
    const rows = [
        { id: 'A', line: { 5: 4 } },
        { id: 'B', line: { 5: 4 } },
        { id: 'C', line: { 5: 1 } }
    ];
    const ranks = windowLineRanks(rows, { categoryIds: ['5'] });
    assert(ranks.get('A').label === 1 && ranks.get('B').label === 1, 'both first');
    assert(ranks.get('A').tied && ranks.get('B').tied, 'and told so');
    assert(ranks.get('C').label === 3 && !ranks.get('C').tied, 'the third is third, not second');
});

test('windowLineRanks: a rate nobody posted ranks nobody; a missing COUNT really is zero of it', () => {
    // Opposite treatments on purpose, the same pivot the engine keeps: not appearing in home runs is zero home runs, but having no ERA is not an ERA of zero, which would be the best possible.
    const rows = [
        { id: 'A', line: { 5: 3 } },
        { id: 'B', line: { 5: 1, 47: 2.0 } }
    ];
    const ranks = windowLineRanks(rows, { categoryIds: ['5', '47'], inverseIds: new Set(['47']), rateIds: new Set(['47']) });
    // Only home runs can be scored across both, so A leads on the one category they share.
    assert(ranks.get('A').label === 1, 'three home runs beats one');
    assert(ranks.get('B').label === 2, 'and the unshared ERA does not rescue it');
});

test('windowLineRanks: one line ranks nobody', () => {
    assert(windowLineRanks([{ id: 'A', line: { 5: 3 } }], { categoryIds: ['5'] }).size === 0, 'no peers');
    assert(windowLineRanks([], { categoryIds: ['5'] }).size === 0, 'nobody at all');
});


// ==== Weekly and season parity ====

// A basis of ten peer weeks in one counting category, six of them zero, which is the shape a sparse category really has (measured: SB is an explicit zero on 92% of real played days).
const SPARSE_BASIS = [{
    id: '23', inverse: false, isRate: false,
    rates: [0, 0, 0, 0, 0, 0, 1, 2, 3, 4]
}];

test('scoreWeekByCategory: a tied zero is MIDRANKED, not counted dead last', () => {
    // Six zeroes and four better weeks. Strictly-worse/n scored this 0 - bottom of the league for a week that half the pool also had. Midrank over n-1: below 0, five others equal, so worseCount = 0 + (6-1)/2 = 2.5 of 9 = 27.8%.
    const rows = scoreWeekByCategory({}, { '23': 0 }, SPARSE_BASIS);
    assertClose(rows[0].percentile, 2.5 / 9 * 100, 'a shared zero is not dead last');
    assert(rows[0].percentile > 20, `the B41 pathology is gone, got ${rows[0].percentile}`);
});

test('scoreWeekByCategory: beating the whole basis is still exactly 100', () => {
    const rows = scoreWeekByCategory({}, { '23': 9 }, SPARSE_BASIS);
    assertClose(rows[0].percentile, 100, 'clamped at the top, same as the season path');
});

test('scoreWeekByCategory: a counting category the week omits is ZERO, not skipped', () => {
    // The week was played and nothing was stolen. The season path zero-fills that, and skipping it here would let the week average over a smaller, kinder set of categories.
    const basis = [
        { id: '5', inverse: false, isRate: false, rates: [0, 1, 2] },
        ...SPARSE_BASIS
    ];
    const rows = scoreWeekByCategory({}, { '5': 2 }, basis);
    assert(rows.length === 2, 'both categories scored');
    assert(rows[1].id === '23', 'including the one never registered');
    assert(rows[1].value === 0, 'as a zero that was earned');
});

test('scoreWeekByCategory: a RATE nobody posted stays absent, never a zero', () => {
    // A week with no innings has no ERA. Zero would be the best in the league in an inverse category, which is the same rule the season engine keeps for rate categories.
    const basis = [{ id: '47', inverse: true, isRate: true, rates: [2.0, 3.0, 4.0] }, ...SPARSE_BASIS];
    const rows = scoreWeekByCategory({}, { '23': 1 }, basis);
    assert(rows.length === 1, 'only the counting category');
    assert(rows[0].id === '23', 'the rate is not invented');
});

test('scoreWeekByCategory: a week with NO figure at all is not a week of zeroes', () => {
    // The guard the zero-fill makes necessary: applied to a week nobody played, zero-filling would score the player worst-possible in every category instead of leaving the week unscored.
    assert(scoreWeekByCategory({}, {}, SPARSE_BASIS).length === 0, 'no data, no rows');
    assert(scoreWeekByCategory({}, { '99': 5 }, SPARSE_BASIS).length === 0, 'nothing the basis scores');
});

test('scoreWeekByCategory: an inverse category still ranks the LOW value best', () => {
    const basis = [{ id: '47', inverse: true, isRate: true, rates: [2.0, 3.0, 4.0] }];
    const good = scoreWeekByCategory({}, { '47': 1.0 }, basis)[0];
    const bad = scoreWeekByCategory({}, { '47': 5.0 }, basis)[0];
    assertClose(good.percentile, 100, 'the lowest ERA beats them all');
    assertClose(bad.percentile, 0, 'the highest beats none');
});

// What the preseason basis exists to prevent. Two behaviours the leaderboard depended on before it ranked on projections, stated here as properties.

// The trap the unknown set closes. In an inverse category a missing value read as zero is the best figure in the league, since nil errors is a perfect fielding record, so a player the projection estimate could not reach would out-rank everyone who posted a number. rotoContext folds those ids into rateStatIds, and a rate is ranked only among the players who posted one, so the gap is skipped and not flattered.
const TRAP_CTX = {
    sport: 'flb',
    relevantStatIds: ['72'],
    inverseStatIds: new Set(['72']),
    isRpPool: false,
    requireMinPlayingTime: false,
    workloadOf: p => p.games,
    thresholdWorkloadOf: p => p.games,
    statMap: { '72': 'E' }
};
const TRAP_POOL = [
    { id: 1, name: 'Two errors', games: 10, seasonTotals: { '72': 2 } },
    { id: 2, name: 'Eight errors', games: 10, seasonTotals: { '72': 8 } },
    { id: 3, name: 'No figure at all', games: 10, seasonTotals: {} }
];

test('an inverse category zero-fills a missing value into the BEST score without the unknown set', () => {
    const { ranks } = computeRotoRanks(TRAP_POOL, { ...TRAP_CTX, rateStatIds: new Set() });
    assert(ranks.get(3) === 1, 'the player with no error figure at all ranks first - the trap');
    assert(ranks.get(1) === 2, 'two errors is only second best behind a nil that was never posted');
});

test('the unknown set skips the missing value instead of scoring it', () => {
    const { ranks, scores } = computeRotoRanks(TRAP_POOL, { ...TRAP_CTX, rateStatIds: new Set(['72']) });
    assert(!ranks.has(3), 'the player with no figure is not ranked in a category never posted');
    assert(ranks.get(1) === 1, 'two errors is now the best posted figure');
    assert(ranks.get(2) === 2, 'eight errors second');
    assert(!scores.has(3), 'and carries no score to be sorted on');
});

// The old leaderboard, stated. A preseason leaderboard that summed seasonTotals, which a league that has not played does not have, scored everyone 0, and computePointsRanks breaks a tie by ascending id by design, for a stable order across re-renders. Together they put a real player at #671: a tie-break asked to carry a ranking it was never meant to decide. The pool order here is not id order, so this pins the id rule.
test('an all-zero score map ranks by ascending player id, which is the #671 the owner saw', () => {
    const pool = [
        { id: 900, seasonTotals: {} },
        { id: 12, seasonTotals: {} },
        { id: 671, seasonTotals: {} }
    ];
    const { ranks, scores } = computePointsRanks(pool, { weights: { '53': 4 }, workloadOf: () => 1 });
    assert(scores.get(671) === 0, 'no stats, no points');
    assert(ranks.get(12) === 1, 'lowest id first');
    assert(ranks.get(671) === 2, 'then 671');
    assert(ranks.get(900) === 3, 'then 900 - arrival order ignored');
});

/**
 * The group comparison. Contract: tests/fixtures/player-group.md
 *
 * Four archetypes, round numbers, no capture. Categories: 5 home runs (higher is better), 72 errors
 * (inverse), 2 batting average, which Glove Gil has no figure for at all, so the null cell is in the
 * fixture and not in a case bolted on afterwards.
 *
 *   id  name          HR   E    AVG
 *   1   Anchor Ann    16   1    .303
 *   2   Slugger Sam   33   3    .267
 *   3   Glove Gil     10   1    (none)
 *   4   Filler Fay    20   5    .250     in the pool for the rankings, not in the group
 */
const GRP_POOL = [
    { id: 1, name: 'Anchor Ann', seasonTotals: { '5': 16, '72': 1, '2': 0.303 } },
    { id: 2, name: 'Slugger Sam', seasonTotals: { '5': 33, '72': 3, '2': 0.267 } },
    { id: 3, name: 'Glove Gil', seasonTotals: { '5': 10, '72': 1 } },
    { id: 4, name: 'Filler Fay', seasonTotals: { '5': 20, '72': 5, '2': 0.250 } }
];
const GRP_CTX = {
    statIds: ['5', '72', '2'],
    inverseStatIds: new Set(['72']),
    statMap: { '5': 'HR', '72': 'E', '2': 'AVG' }
};
const grpRow = (out, id) => out.rows.find(r => r.id === id);
const grpCell = (out, id, pid) => grpRow(out, id).cells.find(c => c.id === pid);

test('comparePlayerGroup: the anchor leads the columns and differs from nobody', () => {
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    assert(out.ids.join(',') === '1,2,3', `column order is anchor first: ${out.ids}`);
    assert(out.rows.every(r => r.cells[0].id === 1), 'cells are aligned with ids, index for index');
    const own = grpCell(out, '5', 1);
    assert(own.delta === null && own.better === null, 'a player does not differ from themselves');
    assert(out.refused === null, 'and nothing was refused');
});

test('comparePlayerGroup: delta is arithmetic, better is direction, hand-computed', () => {
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    // Home runs, higher is better. Sam 33 against the anchor's 16 is +17 and an improvement; Gil 10 is -6 and not.
    assertEq(grpCell(out, '5', 2).delta, 17, 'thirty-three less sixteen');
    assertEq(grpCell(out, '5', 2).better, 'up', 'and more home runs is better');
    assertEq(grpCell(out, '5', 3).delta, -6, 'ten less sixteen');
    assertEq(grpCell(out, '5', 3).better, 'down', 'fewer is worse');
});

test('comparePlayerGroup: an INVERSE category signs the direction, never the delta', () => {
    // Sam allowed two more errors than the anchor: the delta is +2, because the delta is arithmetic, and the direction is down, because more errors is worse. A renderer colouring on the sign of the delta alone would paint two extra errors green.
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    assertEq(grpCell(out, '72', 2).delta, 2, 'three errors less one is plus two');
    assertEq(grpCell(out, '72', 2).better, 'down', 'and that is worse');
    assertEq(grpCell(out, '72', 3).delta, 0, 'Gil matches the anchor');
    assertEq(grpCell(out, '72', 3).better, 'even', 'which is neither');
});

test('comparePlayerGroup: best and worst are ARRAYS, because the frame has a tie', () => {
    // On errors the anchor and Gil both sit at one and the frame draws BOTH green. A singular field cannot say that, and a renderer forced to pick one would mark a tie as a winner.
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    assertEq(grpRow(out, '72').bestIds.join(','), '1,3', 'inverse: the two lowest');
    assertEq(grpRow(out, '72').worstIds.join(','), '2', 'and the highest alone');
    assertEq(grpRow(out, '5').bestIds.join(','), '2', 'home runs: the highest');
    assertEq(grpRow(out, '5').worstIds.join(','), '3', 'and the lowest');
});

test('comparePlayerGroup: a null cell is carried, and takes part in nothing', () => {
    // Gil has no batting average at all. The row stays, since a player having no figure here is information and a shorter table hides it, but Gil is in no delta, no direction, and neither end of the row.
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    const gil = grpCell(out, '2', 3);
    assertEq(gil.value, null, 'no figure');
    assertEq(gil.delta, null, 'so no delta');
    assertEq(gil.better, null, 'and no direction');
    assert(!grpRow(out, '2').bestIds.includes(3) && !grpRow(out, '2').worstIds.includes(3),
        'and neither end of the row');
    assertEq(grpRow(out, '2').bestIds.join(','), '1', 'the anchor takes the average');
});

test('comparePlayerGroup: the tally denominator is what could be COMPARED', () => {
    // Sam has all three and takes home runs alone: errors are worse and the average is lower. Gil has two of the three, takes neither, and reads 0 of 2 and not 0 of 3, since a fraction whose denominator lies is worse than no fraction.
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    const t = (id) => out.tally.find(x => x.id === id);
    assertEq([t(2).takes, t(2).of], [1, 3], 'Sam takes the home runs');
    assertEq([t(3).takes, t(3).of], [0, 2], 'Gil takes nothing, out of the two he has');
    assertEq([t(1).takes, t(1).of], [null, null], 'the anchor is not compared with itself');
});

test("comparePlayerGroup: the ranks are the POOL's, not the group's", () => {
    // Every player is read out of the same per-category ordering, so a rank reads the same beside five others as it does alone. Home runs across all four: Sam 33, Fay 20, Ann 16, Gil 10.
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3], GRP_CTX);
    assertEq([grpCell(out, '5', 2).rank, grpCell(out, '5', 2).total], [1, 4], 'Sam leads the pool');
    assertEq(grpCell(out, '5', 1).rank, 3, 'the anchor is third of four, not first of three');
    // The average is scoped to the three who have one, exactly as the drill-down scopes it.
    assertEq(grpCell(out, '2', 1).total, 3, 'a category only three of them posted');
});

test('comparePlayerGroup: seven others is refused with the reason, not trimmed', () => {
    const out = comparePlayerGroup(GRP_POOL, 1, [2, 3, 4, 5, 6, 7, 8], GRP_CTX);
    assertEq(out.refused, 'Six players at most in a group.', 'said, not silently obeyed');
    assertEq(out.rows, null, 'and no table to mistake for a trimmed one');
    assertEq(comparePlayerGroup(GRP_POOL, 1, [2, 3, 4, 5, 6, 7], GRP_CTX).refused, null, 'six is fine');
});

test('comparePlayerGroup: the anchor cannot also be an other', () => {
    const out = comparePlayerGroup(GRP_POOL, 1, [1, 2], GRP_CTX);
    assertEq(out.ids.join(','), '1,2', 'listed once, as the anchor');
});

test('comparePlayerCategories: the two-player ledger is unchanged by the group rewrite', () => {
    // The adapter's whole job. Sam against Ann: Sam takes the home runs, Ann the errors and the average, so the old tally reads b 1, a 2, tie 0 and the old rows still carry a/b/edge.
    const { rows, tally } = comparePlayerCategories(GRP_POOL, 1, 2, GRP_CTX);
    assertEq([tally.a, tally.b, tally.tie], [2, 1, 0], 'the same counts, in the old shape');
    assertEq(rows.find(r => r.id === '5').edge, 'b', 'home runs to Sam');
    assertEq(rows.find(r => r.id === '72').edge, 'a', 'errors to Ann, inverse-aware');
    assertEq(rows.find(r => r.id === '5').a.value, 16, 'and the old side objects survive');
});

test('comparePlayerCategories: a category only one of them has still reports none', () => {
    const { rows, tally } = comparePlayerCategories(GRP_POOL, 1, 3, GRP_CTX);
    const avg = rows.find(r => r.id === '2');
    assertEq(avg.b, null, 'Gil has no average');
    assertEq(avg.edge, 'none', 'so neither takes it');
    assertEq(tally.a + tally.b + tally.tie, 2, "and it is in nobody's count");
});

// ==== The group's chart series ====

const GRP_WEEKLY = {
    1: { 1: { '5': 2 }, 3: { '5': 4 } },
    2: { 2: { '5': 1 } }
};

test('groupMatchupSeries: one axis for every series, nulls where a player has no line', () => {
    // The union of both players' weeks is 1, 2, 3. Four series the same length is what lets a chart GAP a line; a shorter series would shorten the line instead.
    const s = groupMatchupSeries(GRP_WEEKLY, [1, 2], '5');
    assertEq(s.map(x => x.id).join(','), '1,2', 'in the order given');
    assertEq(s[0].anchor, true, 'the first is the anchor');
    assertEq(s[1].anchor, false, 'and only the first');
    assertEq(s[0].points.map(p => `${p.matchup}:${p.value}`).join(' '), '1:2 2:null 3:4', 'anchor');
    assertEq(s[1].points.map(p => `${p.matchup}:${p.value}`).join(' '), '1:null 2:1 3:null', 'other');
});

test("groupMatchupSeries: the caller's own axis wins where it has one", () => {
    const s = groupMatchupSeries(GRP_WEEKLY, [1], '5', { matchups: [3, 4] });
    assertEq(s[0].points.map(p => `${p.matchup}:${p.value}`).join(' '), '3:4 4:null', 'its list, its order');
});

test('groupMatchupSeries: a synthetic series comes through scoreOf', () => {
    // Score by matchup is not in the weekly line at all, since it is scored per period against a pool, so the caller supplies it and statId is ignored. Inventing a score here would be a second definition of a number that already exists.
    const s = groupMatchupSeries(GRP_WEEKLY, [1, 2], 'score', {
        matchups: [1, 2], scoreOf: (id, m) => (id === 1 ? m * 10 : NaN)
    });
    assertEq(s[0].points.map(p => p.value).join(','), '10,20', "the caller's figures");
    assertEq(s[1].points.map(p => p.value).join(','), ',', 'and an unusable one is null, not NaN');
});

test('groupMatchupSeries: no ids is an empty answer, never a throw', () => {
    assertEq(groupMatchupSeries(GRP_WEEKLY, [], '5').length, 0, 'nothing asked');
    assertEq(groupMatchupSeries(null, [1], '5')[0].points.length, 0, 'no lines, no axis');
});


// What a roster-days file is. Two files carry the harvest's output in two shapes, wrapped and bare. A reader of only the wrapped one stages a bare roster-days.json with zero snapshots. rosterDaysOf detects which, and says 'unrecognised' for anything that is neither. Hand-built days, invented ids.
const DAY = [{ id: 1, entries: [{ p: 90001, slot: 0 }] }];

test('rosterDaysOf: the wrapped shape, which the generated fixture writes', () => {
    const got = rosterDaysOf({ days: { 1: DAY, 2: DAY } });
    assertEq(got.shape, 'wrapped', 'wrapped');
    assertEq(Object.keys(got.days), ['1', '2'], 'its days');
});

test('rosterDaysOf: the BARE shape, which Download All writes', () => {
    const got = rosterDaysOf({ 1: DAY, 3: DAY });
    assertEq(got.shape, 'bare', 'bare');
    assertEq(Object.keys(got.days), ['1', '3'], 'the object is the days itself');
    // And it feeds the timeline exactly as the wrapped one does.
    const started = buildStartedTimeline({ rosterDays: got.days, startingSlots: new Set([0]) });
    assertEq(startedTeamForPlayerAtPeriod(started, 90001, 3), 1, 'the bare days drive the started timeline');
});

test('rosterDaysOf: an empty harvest is an answer, not a malformed file', () => {
    assertEq(rosterDaysOf({}).shape, 'empty', 'bare and empty');
    assertEq(rosterDaysOf({ days: {} }).shape, 'empty', 'wrapped and empty');
    assertEq(rosterDaysOf({}).days, {}, 'no days');
});

test('rosterDaysOf: neither shape is said to be neither, with zero days', () => {
    // The staged run uses a real non-roster fixture; these are the shapes a mistaken file takes.
    const cases = [
        null, undefined, 'text', 42, [DAY],
        { days: [DAY] },                    // a wrapper around an array
        { days: { one: DAY } },             // a wrapper around a non-period key
        { 1: DAY, _synthetic: 'a note' },   // a bare object with one non-period key
        { 0: DAY },                         // period 0 is not a scoring period
        { 1: 'not an array' },
        { teams: [] }                       // a raw mRoster response, not distilled days
    ];
    cases.forEach((c, i) => {
        const got = rosterDaysOf(c);
        assertEq([got.shape, got.days], ['unrecognised', {}], `case ${i}`);
    });
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
