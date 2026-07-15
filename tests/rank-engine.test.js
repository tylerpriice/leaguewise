// Unit tests for the pure rank engine.
import {
    MIN_PLAYING_TIME_FRACTION, MIN_OPPORTUNITY_FRACTION,
    countLessThan, countGreaterThan, percentileFor,
    inningsPitchedOf, statValueForRanking, opportunityGateFor,
    computeRotoRanks, computeCategoryBreakdown, computeStatRankInPool,
    buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis
} from '../rank-engine.js';

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

// Player factory. The engine only ever needs id + seasonTotals.
const P = (id, totals) => ({ id, seasonTotals: totals });

// Baseline ctx for batter-style pools: one workload measure for both shrinkage and threshold (games played, id '81'), no inverse stats unless a test says so.
const ctx = (over = {}) => ({
    relevantStatIds: ['5'],
    inverseStatIds: new Set(),
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

test('percentileFor: basic, ties share, inverse, clamp at 100', () => {
    const basis = [10, 20, 30, 40];
    assertClose(percentileFor(basis, 25, false), (2 / 3) * 100, 'mid value');
    assertClose(percentileFor(basis, 10, false), 0, 'worst basis member');
    assertClose(percentileFor(basis, 40, false), 100, 'best basis member');
    assertClose(percentileFor(basis, 50, false), 100, 'outsider beating all clamps to 100 (raw 133)');
    assertClose(percentileFor(basis, 25, true), (2 / 3) * 100, 'inverse mid (beats 30,40)');
    const tied = [10, 20, 20, 40];
    assertClose(percentileFor(tied, 20, false), (1 / 3) * 100, 'tied values share the same percentile');
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
    // B's raw percentile in basis [29,30] is 0. Shrink 50/100 -> 50 + (0-50)*0.5 = 25
    assertClose(r.scores.get(2), 25, 'shrunk score');
    assertClose(r.scores.get(1), 100, 'full-workload leader untouched');
});

test('computeRotoRanks: min-games toggle - exclusion when on, stable basis when off', () => {
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

test('computeRotoRanks: SV opportunity gate protects zero-chance players outside RP', () => {
    const closer = P(1, { '5': 10, '57': 30, '58': 5, '81': 60 });   // 35 chances
    const setup = P(2, { '5': 20, '57': 2, '58': 3, '81': 60 });     // 5 chances < 15% of 35
    const starter = P(3, { '5': 30, '57': 0, '58': 0, '81': 60 });   // 0 chances
    const r = computeRotoRanks([closer, setup, starter], ctx({ relevantStatIds: ['5', '57'] }));
    // HR percentiles: 0 / 50 / 100.
    assertClose(r.scores.get(1), 50, 'closer averages HR 0 + SV 100');
    assertClose(r.scores.get(2), 50, 'setup scored on HR only');
    assertClose(r.scores.get(3), 100, 'starter scored on HR only, tops the pool');
    assertClose(r.ranks.get(3), 1, 'starter #1');
});

test('computeRotoRanks: RP pool - no shrinkage, K as K/9, SV ungated', () => {
    // K/9: R1 = 80K/60IP = 12.0, R2 = 90K/100IP = 8.1 -> raw K would rank R2 first, K/9 ranks R1 first
    const R1 = P(1, { '48': 80, '34': 180, '57': 0, '58': 0, '81': 60 });
    const R2 = P(2, { '48': 90, '34': 300, '57': 30, '58': 4, '81': 40 });
    const rpCtx = ctx({ relevantStatIds: ['48', '57'], isRpPool: true, workloadOf: p => (p.seasonTotals['34'] || 0) / 3 });
    const r = computeRotoRanks([R1, R2], rpCtx);
    // K/9: R1 100, R2 0.
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

test('computeRotoRanks: a player missing a stat skips that category, not the whole rank', () => {
    // A two-way/partial-data shape: B has no stat '20' at all (undefined, not zero), so B is scored on '5' only while A averages both. And B never enters the '20' basis.
    const A = P(1, { '5': 10, '20': 5, '81': 100 });
    const B = P(2, { '5': 20, '81': 100 });
    const r = computeRotoRanks([A, B], ctx({ relevantStatIds: ['5', '20'] }));
    // '5': A 0, B 100. '20': single-member basis -> A 100.
    assertClose(r.scores.get(1), 50, 'A averages both categories');
    assertClose(r.scores.get(2), 100, 'B averaged over its one real category');
    assertClose(r.ranks.get(2), 1, 'B ranks first');
    assertClose(r.categoryCount, 2, 'categoryCount reports the pool-wide category count');
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
    const pool = [P(1, { '57': 30, '58': 5 }), P(2, { '57': 1, '58': 0 })]; // chances 35 vs 1. Min = 5.25
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

test('scoreWeekAgainstBasis: inverse rate stat - lower weekly value scores higher', () => {
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
    // HR 1.5 beats [1] of [1,2] -> 50. AVG .280 beats [.25] of [.25,.30] -> 50. Average 50
    assertClose(scoreWeekAgainstBasis(pool[0], { '5': 1.5, '2': 0.280 }, basis), 50, 'full week');
    assert(scoreWeekAgainstBasis(pool[0], {}, basis) === null, 'empty week -> null');
    assert(scoreWeekAgainstBasis(pool[0], undefined, basis) === null, 'missing week -> null');
});

test('scoreWeekAgainstBasis: proration scales counting stats up, never rate stats', () => {
    const pool = [P(1, { '5': 20, '2': 0.300 }), P(2, { '5': 10, '2': 0.250 })];
    const basis = buildCategoryRateBasis(pool, {
        relevantStatIds: ['5', '2'], inverseStatIds: new Set(), avgStatIds: new Set(['2']), weeksElapsed: 10
    });
    // Half a week: HR 1.2 -> on pace 2.4, beats both rates -> 100. AVG .280 unprorated -> 50
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

// ==== Real-weekly-value basis (buildWeeklyValueBasis) ====

// Weekly-pool player factory. Id + seasonTotals (read only for opportunity gating) + a list of real per-matchup-week entries ({ stats, games }), matching what players.js's buildWeeklyRateBasis assembles from AppState.playerWeeklyCache.
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

test('buildWeeklyValueBasis: inverse category - a lower real week scores higher via scoreWeekAgainstBasis', () => {
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

// End-to-end proof: a synthetic pool with a full-time slugger who has a genuine cold week and a genuine hot week, sitting alongside a pool that also has a bunch of part-time bench bats who only have a game log for a week or two each. The other weeks have 0 games and are absent, matching how the real pipeline never creates an entry for a week nobody played any part of.
const demoWeeksElapsed = 4;
// Subject: 1 HR in the cold week, 6 HR in the hot week.
const demoSubject = WP('R1', {}, [
    { stats: { '5': 1 }, games: 6 }, { stats: { '5': 3 }, games: 6 },
    { stats: { '5': 3 }, games: 6 }, { stats: { '5': 6 }, games: 6 }
]);
// Another full-time peer. Plays every week, real values spread across the season (season total 14).
const demoRegularPeer = WP('R2', {}, [
    { stats: { '5': 2 }, games: 6 }, { stats: { '5': 3 }, games: 6 },
    { stats: { '5': 4 }, games: 6 }, { stats: { '5': 5 }, games: 6 }
]);
// 8 part-timers, each with exactly ONE real week (2 games that week) and 3 absent weeks.
const demoPartTimers = [
    WP('PT1', {}, [{ stats: { '5': 0 }, games: 2 }]), WP('PT2', {}, [{ stats: { '5': 1 }, games: 2 }]),
    WP('PT3', {}, [{ stats: { '5': 0 }, games: 2 }]), WP('PT4', {}, [{ stats: { '5': 1 }, games: 2 }]),
    WP('PT5', {}, [{ stats: { '5': 1 }, games: 2 }]), WP('PT6', {}, [{ stats: { '5': 0 }, games: 2 }]),
    WP('PT7', {}, [{ stats: { '5': 1 }, games: 2 }]), WP('PT8', {}, [{ stats: { '5': 0 }, games: 2 }])
];

test('regression: the OLD season-average basis saturates - a real bad week still scores ~89 against smoothed part-timer averages', () => {
    // Season totals implied by the weekly data above (the OLD basis never sees the real weeks, only each peer's season sum): R2 = 14, PT1..PT8 = 0,1,0,1,1,0,1,0.
    const oldPool = [
        P('R2', { '5': 14 }),
        P('PT1', { '5': 0 }), P('PT2', { '5': 1 }), P('PT3', { '5': 0 }), P('PT4', { '5': 1 }),
        P('PT5', { '5': 1 }), P('PT6', { '5': 0 }), P('PT7', { '5': 1 }), P('PT8', { '5': 0 })
    ];
    const oldBasis = buildCategoryRateBasis(oldPool, {
        relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set(), weeksElapsed: demoWeeksElapsed
    });
    // Typical weeks sorted: [0,0,0,0, 0.25,0.25,0.25,0.25, 3.5] (9 members).
    const coldScore = scoreWeekAgainstBasis(demoSubject, { '5': 1 }, oldBasis);
    const hotScore = scoreWeekAgainstBasis(demoSubject, { '5': 6 }, oldBasis);
    assertClose(coldScore, (8 / 9) * 100, 'a genuinely bad 1-HR week still beats 8 of 9 smoothed peer averages');
    assertClose(hotScore, 100, 'the hot week also caps at 100 - indistinguishable from the "bad" week at a glance');
    assert(coldScore >= 80, `saturation: cold week caps near the ceiling instead of reading low (got ${coldScore})`);
});

test('fix verified: the NEW real-weekly-value basis scores the same cold week meaningfully lower than the hot week', () => {
    const pool = [demoRegularPeer, ...demoPartTimers];
    const basis = buildWeeklyValueBasis(pool, { relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool sorted: [0,0,0,0, 1,1,1,1, 2,3,4,5] (12 real weeks).
    const coldScore = scoreWeekAgainstBasis(demoSubject, { '5': 1 }, basis);
    const hotScore = scoreWeekAgainstBasis(demoSubject, { '5': 6 }, basis);
    assertClose(coldScore, (4 / 12) * 100, 'cold week beats only the four real 0-HR weeks in the pool');
    assertClose(hotScore, 100, 'hot week still beats every real peer week');
    assert(coldScore < 50, `cold week now reads as genuinely below average (got ${coldScore})`);
    assert(hotScore - coldScore > 50, `the fix restores real week-to-week spread (got ${hotScore - coldScore} points)`);
});

test('min-games decision: excluding part-timers from the weekly-value basis sharpens the cold-week score further', () => {
    // Same subject and cold week, but the basis pool is restricted to just the full-time peer. Simulating players.js filtering to MIN_PLAYING_TIME_FRACTION of games played (same threshold/measure computeRotoRanks already uses for its own qualified-pool basis) before handing the pool to buildWeeklyValueBasis.
    const basis = buildWeeklyValueBasis([demoRegularPeer], { relevantStatIds: ['5'], inverseStatIds: new Set(), avgStatIds: new Set() });
    // Real weekly pool: [2,3,4,5] (the full-time peer's real weeks only).
    const coldScore = scoreWeekAgainstBasis(demoSubject, { '5': 1 }, basis);
    assertClose(coldScore, 0, 'a 1-HR week beats none of a true regular peer\'s real weeks');
    // DECISION (see buildWeeklyRateBasis in players.js): exclude part-timers.
});

// ==== Report ====

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
