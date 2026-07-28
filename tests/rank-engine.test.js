// Unit tests for the pure rank engine. Open tests/rank-engine.test.html through any static server (file:// won't work - browsers block ES module imports without a real origin; .claude/serve.ps1 is a zero-dependency option) - green means every assertion held. Every expected value here is hand-computed from the documented formulas, so a failure means the ENGINE changed behavior, not that a snapshot went stale.
import {
    MIN_PLAYING_TIME_FRACTION, MIN_OPPORTUNITY_FRACTION,
    countLessThan, countGreaterThan, percentileFor,
    inningsPitchedOf, statValueForRanking, opportunityGateFor,
    computeRotoRanks, computePointsRanks, computeCategoryBreakdown, computeStatRankInPool,
    buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis,
    rotoPointsForCategory, scoreRotoWeek
} from '../rank-engine.js';
import { buildRosterTimeline, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod } from '../roster-timeline.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertClose(actual, expected, msg, tol = 1e-9) {
    if (actual === null || actual === undefined || Math.abs(actual - expected) > tol) {
        throw new Error(`${msg}: got ${actual}, expected ${expected}`);
    }
}

// Player factory - the engine only ever needs id + seasonTotals.
const P = (id, totals) => ({ id, seasonTotals: totals });

// Baseline ctx for batter-style pools: one workload measure for both shrinkage and threshold (games played, id '81'), no inverse stats unless a test says so.
const ctx = (over = {}) => ({
    relevantStatIds: ['5'],
    inverseStatIds: new Set(),
    // Empty by default: every scored cat is treated as counting, so a missing value zero-fills. Rate tests opt in a stat (e.g. rateStatIds: new Set(['47'])) to keep the undefined-skip.
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
    assertClose(statValueForRanking(p, '48', false), 80, 'raw K outside RP pool');
    assertClose(statValueForRanking(p, '48', true), 12, 'K/9 inside RP pool (80/60*9)');
    assert(statValueForRanking(P(2, {}), '48', true) === undefined, 'undefined stays undefined');
    assertClose(statValueForRanking(P(3, { '48': 5 }), '48', true), 0, 'zero IP -> 0, not Infinity');
});

test('opportunityGateFor: SV ungated only in RP pools, QS gated everywhere', () => {
    assert(opportunityGateFor('57', false) !== null && opportunityGateFor('57', false) !== undefined, 'SV gated outside RP');
    assert(opportunityGateFor('57', true) === null, 'SV NOT gated inside RP');
    assert(!!opportunityGateFor('63', true), 'QS gated inside RP');
    assert(!!opportunityGateFor('63', false), 'QS gated outside RP');
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
    // Basis stability: qualified players' scores must be IDENTICAL either way
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
    // The regression this pins: unfixed, zero scores 50 and takes this slot, pushing B to 3rd.
    assertClose(r.ranks.get(2), 2, 'B stays second, nothing floats in above it');
});

test('computeRotoRanks: the 0-GP exclusion also holds with the toggle ON', () => {
    const A = P(1, { '5': 30, '81': 100 });
    const B = P(2, { '5': 10, '81': 100 });
    const zero = P(3, { '5': 0 });
    const r = computeRotoRanks([A, B, zero], ctx({ requireMinPlayingTime: true }));
    // Identical outcome to the toggle-off case above: with the toggle on the min-games threshold already excluded the zero, so the floor is a no-op here and this state is unchanged.
    assertClose(r.total, 2, 'same two ranked');
    assert(!r.ranks.has(3), 'the 0-GP player is unranked with the toggle on too');
    assertClose(r.scores.get(1), 100, 'A unchanged');
    assertClose(r.scores.get(2), 0, 'B unchanged');
});

test('computeRotoRanks: the zero floor does not empty a pool where nobody has played', () => {
    // Preseason / brand-new league: every thresholdWorkload is 0, so there is no real cohort for the floor to protect and blanking the board would be worse than ranking on what's there.
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
    // HR percentiles: 0 / 50 / 100. SV: only the closer has real opportunity -> single-member basis -> 100 for him; setup and starter skip the category instead of eating a zero.
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
    const r = computeRotoRanks([A, B], ctx({ relevantStatIds: ['47'], inverseStatIds: new Set(['47']) }));
    assertClose(r.scores.get(1), 100, 'lower ERA scores 100');
    assertClose(r.ranks.get(1), 1, 'lower ERA ranks #1');
});

test('computeRotoRanks: hockey goalie pool: inverse GAA, games-played workload, backup shrinkage', () => {
    // Validates the engine handles a hockey-shaped ctx end to end (the fhl stat-id validation and the games-played-for-both-groups workload landed ): W(1) counting, GAA(10) inverse and lower-is-better, games played (id 30) as BOTH the shrinkage and threshold workload. Two full-season starters plus a small-sample backup whose elite 1.00 GAA must be shrunk.
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
    // ESPN omits a zero-valued sparse counting stat entirely: B has no '20' key. Under the zero-fill rule B is ranked in '20' at 0 (not skipped) and enters the '20' basis at 0, so having zero costs a real bottom percentile instead of nothing.
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
    // The real-league case in miniature: one player has the counting stat, three don't (no key). The three zeros form a tie block; midrank puts each at the block's mean, not rock bottom.
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
    // Two players tied at 20 in a non-sparse category both take the block average, not the worse edge - the same midrank rule, nothing to do with zero-fill.
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
    // B lacks '20'. D is unqualified (10 games < 20% of 100), so the qualified basis is {A, B}. B's breakdown must include a '20' row (zero-filled) ranked against that basis, and report the qualified size (2) - not the full 3-player group the score is NOT computed against.
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
    // The drill-down must show the same number the leaderboard shows when Minimum Games Played is off: the call-up scored against the FIXED qualified basis, never inserted into it.
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
    // adds display decimals to rate rows so two SV% that ROUND to .912 (.9118 vs .9123) stop looking like an engine bug. That fix is only sound because the engine already ties by value, not by rounded display: two rates equal at full precision must score the same percentile. If distinct raw values ever collapsed here, extra decimals would expose it - this pins that the tie is on the real value, so the drill-down's precision only reveals differences, never invents them.
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
        relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    const hr = basis.find(c => c.id === '5');
    const avg = basis.find(c => c.id === '2');
    assert(JSON.stringify(hr.rates) === '[1,2]', `HR rates divided by weeks: ${JSON.stringify(hr.rates)}`);
    assert(JSON.stringify(avg.rates) === '[0.25,0.3]', `AVG rates undivided: ${JSON.stringify(avg.rates)}`);
});

test('buildCategoryRateBasis: opportunity gate filters the rate pool', () => {
    const pool = [P(1, { '57': 30, '58': 5 }), P(2, { '57': 1, '58': 0 })]; // chances 35 vs 1; min = 5.25
    const basis = buildCategoryRateBasis(pool, {
        relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: 10
    });
    assertClose(basis[0].rates.length, 1, 'no-chance reliever excluded from the SV basis');
});

test('buildCategoryRateBasis: categories with no data in the pool are dropped entirely', () => {
    const pool = [P(1, { '2': 0.300 }), P(2, { '2': 0.250 })]; // nobody has stat '5'
    const basis = buildCategoryRateBasis(pool, {
        relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    assertClose(basis.length, 1, 'empty category dropped');
    assert(basis[0].id === '2', 'the populated category survives');
});

test('scoreWeekAgainstBasis: inverse rate stat: a lower weekly value scores higher', () => {
    const pool = [P(1, { '47': 3.0 }), P(2, { '47': 4.0 })];
    const basis = buildCategoryRateBasis(pool, {
        relevantStatIds: ['47'], inverseStatIds: new Set(['47']), avgStatIds: new Set(['47']), weeksElapsed: 10
    });
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 2.0 }, basis), 100, 'sub-basis ERA beats everyone');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 3.5 }, basis), 50, 'mid ERA beats one of two');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 5.0 }, basis), 0, 'blow-up week beats nobody');
    // Inverse + proration: rates must stay unprorated even when the matchup is half-played
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 3.5 }, basis, 0.5), 50, 'partial week leaves ERA alone');
});

test('scoreWeekAgainstBasis: exact percentiles, and null for unscoreable weeks', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const bctx = { relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10 };
    const basis = buildCategoryRateBasis(pool, bctx);
    // HR 1.5 beats [1] of [1,2] -> 50; AVG .280 beats [.25] of [.25,.30] -> 50; average 50
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 1.5, '2': 0.280 }, basis), 50, 'full week');
    assert(scoreWeekAgainstBasis(pool[0], {}, basis) === null, 'empty week -> null');
    assert(scoreWeekAgainstBasis(pool[0], undefined, basis) === null, 'missing week -> null');
});

test('scoreWeekAgainstBasis: proration scales counting stats up, never rate stats', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const basis = buildCategoryRateBasis(pool, {
        relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    // Half a week: HR 1.2 -> on pace 2.4, beats both rates -> 100; AVG .280 unprorated -> 50
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 1.2, '2': 0.280 }, basis, 0.5), 75, 'prorated average');
});

test('scoreWeekAgainstBasis: opportunity-gated player skips the category', () => {
    const closer = P(1, { '57': 30, '58': 5 });
    const noChance = P(2, { '57': 1, '58': 0 });
    const basis = buildCategoryRateBasis([closer, noChance], {
        relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: 10
    });
    assert(scoreWeekAgainstBasis(noChance, { '57': 2 }, basis) === null, 'gated player has no scoreable category');
    assert(scoreWeekAgainstBasis(closer, { '57': 2 }, basis) !== null, 'gated basis still scores the closer');
});

// ==== real-weekly-value basis (buildWeeklyValueBasis) ====
// See its own comment in rank-engine.js for the full diagnosis of why the season-average basis above read flat for everyday players.

// Weekly-pool player factory - id + seasonTotals (read only for opportunity gating) + a list of real per-matchup-week entries ({ stats, games }), matching what players.js's buildWeeklyRateBasis assembles from AppState.playerWeeklyCache.
const WP = (id, seasonTotals, weeks) => ({ id, seasonTotals, weeks });

test('buildWeeklyValueBasis: counting stats collect raw per-week totals, rate stats collect real per-week rates (no division)', () => {
    const pool = [
        WP(1, {}, [{ stats: { '5': 3, '2': 0.300 }, games: 6 }, { stats: { '5': 1, '2': 0.200 }, games: 5 }]),
        WP(2, {}, [{ stats: { '5': 2, '2': 0.250 }, games: 6 }, { stats: { '5': 0, '2': 0.100 }, games: 4 }])
    ];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']) });
    const hr = basis.find(c => c.id === '5');
    const avg = basis.find(c => c.id === '2');
    assert(JSON.stringify(hr.rates) === '[0,1,2,3]', `HR rates are real per-week totals, undivided: ${JSON.stringify(hr.rates)}`);
    assert(JSON.stringify(avg.rates) === '[0.1,0.2,0.25,0.3]', `AVG rates are real per-week rates, undivided: ${JSON.stringify(avg.rates)}`);
});

test('buildWeeklyValueBasis: a zero-games week is excluded from the distribution', () => {
    const pool = [WP(1, {}, [{ stats: { '5': 5 }, games: 0 }, { stats: { '5': 2 }, games: 6 }])];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    assert(JSON.stringify(basis[0].rates) === '[2]', `zero-games week excluded: ${JSON.stringify(basis[0].rates)}`);
});

test('buildWeeklyValueBasis: inverse category: a lower real week scores higher via scoreWeekAgainstBasis', () => {
    const pool = [WP(1, {}, [{ stats: { '47': 5.00 }, games: 4 }]), WP(2, {}, [{ stats: { '47': 2.00 }, games: 4 }])];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['47'], inverseStatIds: new Set(['47']), avgStatIds: new Set(['47']) });
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 1.00 }, basis), 100, 'ERA better than both real weeks scores 100');
    assertClose(scoreWeekAgainstBasis(pool[0], { '47': 6.00 }, basis), 0, 'ERA worse than both real weeks scores 0');
});

test('buildWeeklyValueBasis: opportunity gate filters the pool using SEASON totals, not any one week', () => {
    const closer = WP(1, { '57': 30, '58': 5 }, [{ stats: { '57': 2 }, games: 6 }]);    // 35 season chances
    const noChance = WP(2, { '57': 1, '58': 0 }, [{ stats: { '57': 0 }, games: 6 }]);   // 1 chance < 15% of 35
    const basis = buildWeeklyValueBasis([closer, noChance], { relevantStatIds: ['57'], inverseStatIds: new Set(), avgStatIds: new Set() });
    assertClose(basis[0].rates.length, 1, 'no-chance reliever excluded from the SV weekly-value basis');
});

test('buildWeeklyValueBasis: a category nobody has any real week for is dropped entirely', () => {
    const pool = [WP(1, {}, [{ stats: { '2': 0.3 }, games: 4 }])];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']) });
    assertClose(basis.length, 1, 'the empty category is dropped');
    assert(basis[0].id === '2', 'the populated category survives');
});

// End-to-end proof: a synthetic pool built to mirror the exact shape of the real bug report (a full-time slugger with a genuine cold week and a genuine hot week, sitting in a pool that also has a bunch of part-time bench bats who only have a game log for a week or two each - the other weeks have 0 games and are absent, matching how buildWeeklySums never creates an entry for a week nobody played any part of). Every rate below is hand-computed from the pool's own numbers, not generated by running the code.
const b14WeeksElapsed = 4;
// Subject: 1 HR in the cold week, 6 HR in the hot week.
const b14Subject = WP('R1', {}, [
    { stats: { '5': 1 }, games: 6 }, { stats: { '5': 3 }, games: 6 },
    { stats: { '5': 3 }, games: 6 }, { stats: { '5': 6 }, games: 6 }
]);
// Another full-time peer - plays every week, real values spread across the season (season total 14).
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
        relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: b14WeeksElapsed
    });
    // Typical weeks sorted: [0,0,0,0, 0.25,0.25,0.25,0.25, 3.5] (9 members).
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, oldBasis);
    const hotScore = scoreWeekAgainstBasis(b14Subject, { '5': 6 }, oldBasis);
    assertClose(coldScore, (8 / 9) * 100, 'a genuinely bad 1-HR week still beats 8 of 9 smoothed peer averages');
    assertClose(hotScore, 100, 'the hot week also caps at 100, indistinguishable from the "bad" week at a glance');
    assert(coldScore >= 80, `THE BUG: cold week saturates near the ceiling instead of reading low (got ${coldScore})`);
});

test('Matchup Score fix, verified: the NEW real-weekly-value basis scores the same cold week meaningfully lower than the hot week', () => {
    const pool = [b14RegularPeer, ...b14PartTimers];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool sorted: [0,0,0,0, 1,1,1,1, 2,3,4,5] (12 real weeks).
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, basis);
    const hotScore = scoreWeekAgainstBasis(b14Subject, { '5': 6 }, basis);
    assertClose(coldScore, (4 / 12) * 100, 'cold week beats only the four real 0-HR weeks in the pool');
    assertClose(hotScore, 100, 'hot week still beats every real peer week');
    assert(coldScore < 50, `cold week now reads as genuinely below average (got ${coldScore})`);
    assert(hotScore - coldScore > 50, `the fix restores real week-to-week spread (got ${hotScore - coldScore} points)`);
});

test('Matchup Score min-games decision: excluding part-timers from the weekly-value basis sharpens the cold-week score further', () => {
    // Same subject and cold week, but the basis pool is restricted to just the full-time peer - simulating players.js filtering to MIN_PLAYING_TIME_FRACTION of games played (same threshold/measure computeRotoRanks already uses for its own qualified-pool basis) before handing the pool to buildWeeklyValueBasis.
    const basis = buildWeeklyValueBasis([b14RegularPeer], { relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool: [2,3,4,5] (the full-time peer's real weeks only).
    const coldScore = scoreWeekAgainstBasis(b14Subject, { '5': 1 }, basis);
    assertClose(coldScore, 0, 'a 1-HR week beats none of a true regular peer\'s real weeks');
    // DECISION (see buildWeeklyRateBasis in players.js): exclude part-timers. Comparing a regular's week to OTHER REGULARS' real weeks is the more diagnostic peer group - the previous test (part-timers included) still let the same bad week read 33% instead of this sharper 0%, because the part-timers' real-but-weak weeks acted as a soft floor under the whole distribution - a milder version of the exact problem this basis exists to fix.
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
    // The exact shape validated against the FGB payload: 5 teams, values 13, 10, 10, 8, 4. Positions (0-based) 0..4 are worth 5,4,3,2,1. The two 10s sit at positions 1 and 2, so they share (4+3)/2 = 3.5 each - the .5 ESPN's own pointsByStat shows for that tie.
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

// ==== Roster timeline ====

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
    // LINEUP is a bench/start slot move (skipped - that history is /); a DRAFT item mirrors the pick that already seeded the roster, so it must not double-count or override a later drop.
    const tl = buildRosterTimeline({
        picks: [{ playerId: 10, teamId: 1 }],
        transactions: [
            TX(3, [IT(10, 'LINEUP', 0)]),
            TX(20, [IT(10, 'DROP', 0)]),
            TX(25, [IT(10, 'DRAFT', 1)]) // stray DRAFT-typed item after a drop must be ignored
        ]
    });
    assertClose(teamForPlayerAtPeriod(tl, 10, 10), 1, 'LINEUP did not change the drafted ownership');
    assertClose(teamForPlayerAtPeriod(tl, 10, 30), 0, 'stays dropped, since the DRAFT item is skipped');
});

// ==== buildStartedTimeline / startedTeamForPlayerAtPeriod ====
// Started-day crediting from the daily roster snapshots. STARTING = { 3,4,5,6 } here (hockey F/D/G/UTIL), bench 7, IR 8.

// Entry + snapshot-day factories (only the fields buildStartedTimeline reads).
const E = (p, slot) => ({ p, slot });
const STARTERS = new Set([3, 4, 5, 6]);

test('buildStartedTimeline: a started day credits the team, a benched day credits nobody', () => {
    // Same two players, slots swapped between two days: whoever is in a starting slot that day counts.
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
    // The per-day fallback: any day a player is not in a starting slot on some team credits nobody, so the race skips it (whichever fallback tier is active never invents a crediting team).
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
    // The pure module knows nothing about which slot is a starter - the league resolves that from its own rosterSettings and passes the set in. With only slot 3 starting, a slot-4 player is benched.
    const days = { 1: [{ id: 1, entries: [E(10, 3), E(20, 4)] }] };
    const onlyThree = buildStartedTimeline({ rosterDays: days, startingSlots: new Set([3]) });
    assertClose(startedTeamForPlayerAtPeriod(onlyThree, 10, 1), 1, 'slot 3 starts');
    assertClose(startedTeamForPlayerAtPeriod(onlyThree, 20, 1), 0, 'slot 4 not a starter under this set');
    const both = buildStartedTimeline({ rosterDays: days, startingSlots: new Set([3, 4]) });
    assertClose(startedTeamForPlayerAtPeriod(both, 20, 1), 1, 'slot 4 starts once the set includes it');
});

// ==== computePointsRanks, the points-league ranking ====

// Two weights, hand-computable: goals are worth 2 and assists 1, so the totals below are exact.
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
    // Same floor computeRotoRanks uses: zero playing time is zero evidence. Ranking them would pile every unplayed player at the bottom on a score that means nothing.
    const r = computePointsRanks([ptsPlayer(1, 10, 5), ptsPlayer(2, 0, 0, 0)], ptsCtx);
    assert(!r.ranks.has(2), 'not ranked');
    assert(!r.scores.has(2), 'and not scored');
    assert(r.total === 1, 'the pool is the players who played');
});

test('computePointsRanks: before anyone has played, everybody still ranks', () => {
    // Preseason, or a freshly created league: refusing to rank would empty the board instead of ranking on whatever projections the pool carries.
    const r = computePointsRanks([ptsPlayer(1, 3, 1, 0), ptsPlayer(2, 1, 1, 0)], ptsCtx);
    assert(r.total === 2, 'both ranked');
    assert(r.ranks.get(1) === 1, 'still ordered by points');
});

test('computePointsRanks: ties order by id so a re-render does not reshuffle', () => {
    const r = computePointsRanks([ptsPlayer(7, 5, 0), ptsPlayer(3, 5, 0)], ptsCtx);
    assert(r.ranks.get(3) === 1 && r.ranks.get(7) === 2, 'lower id takes the earlier rank');
});

// Report ---------------------------------------------------------------------------

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
