// Unit tests for the leaderboard ROW MODEL - the data lane's half of items 4-5. The renderer (leaderboard-row.js) has its own suite; this one asserts the facts that reach it. Every input arrives through a hand-built ctx, which is the whole reason buildLeaderboardRowModel takes one instead of reading AppState: the states that matter here - a football league with no games statistic, a points league with no per-category percentiles, a filler-collapsed rostered column, an unranked player - are all awkward to reach on a real capture and trivial to state.
import { buildLeaderboardRowModel, rosteredFillerFor, preseasonBasisOf } from '../players.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// A ranked, rostered baseball outfielder with a percentile in one of two categories.
const PLAYER = {
    id: 41, name: 'Test Batter', proTeamId: 5, positionDisplay: 'OF',
    injuryStatus: null, teamId: 3, appliedTotal: 300,
    rosterPct: 97.2, rosterChange: 0.4, appliedAverage: 21.6,
    seasonTotals: { '5': 31, '20': 88 }
};

function ctxFor(over = {}) {
    return {
        sport: 'flb', wantPitchers: false, showGames: true, isPointsLeague: false,
        statIds: ['5', '20'], statMap: { '5': 'HR', '20': 'R' },
        inverseIds: new Set(['47']),
        abbrevs: new Map([[5, 'DET']]),
        rotoRanks: {
            ranks: new Map([[41, 1]]), total: 10,
            byCategory: new Map([[41, new Map([['5', 84]])]])
        },
        // R4/S34: the tint's own source, separate from rotoRanks - real callers hand cellsFor categoryTintRanks.byCategory here, a roto-style map computed for the tint alone (even in a points league, where rotoRanks itself is computePointsRanks' output and has no byCategory to give). Mirrors rotoRanks.byCategory's shape by default so every existing test above this comment keeps reading the engine's 84 for id '5' unchanged.
        categoryPct: new Map([[41, new Map([['5', 84]])]]),
        rosteredFiller: null,
        ...over
    };
}

// ==== identity ====

test('identity: club from the abbrev map, position and a formatted GP label', () => {
    const m = buildLeaderboardRowModel({ ...PLAYER, seasonTotals: { ...PLAYER.seasonTotals, '42': 14 } },
        ctxFor({ sport: 'fhl' }));
    assertEq(m.proAbbrev, 'DET', 'club');
    assertEq(m.posLabel, 'OF', 'position');
    assertEq(m.id, 41, 'id');
    assertEq(m.name, 'Test Batter', 'name');
});

test('identity: proAbbrev is NULL when the schedule payload is not in session', () => {
    // Ruled: the segment drops rather than a club being guessed from an id.
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor({ abbrevs: null })).proAbbrev, null, 'no map');
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor({ abbrevs: new Map() })).proAbbrev, null, 'map without this club');
    assertEq(buildLeaderboardRowModel({ ...PLAYER, proTeamId: null }, ctxFor()).proAbbrev, null, 'player with no club');
});

test('identity: gpLabel is NULL for a sport with no games statistic', () => {
    // Football. A dash under a GP heading would claim the number is merely missing.
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor({ showGames: false })).gpLabel, null, 'football');
});

test('identity: isFreeAgent is true only with no fantasy team', () => {
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor()).isFreeAgent, false, 'rostered player');
    assertEq(buildLeaderboardRowModel({ ...PLAYER, teamId: null }, ctxFor()).isFreeAgent, true, 'free agent');
});

// ==== rank ====

test('rank: gold on first, and tied is always false from this surface', () => {
    const first = buildLeaderboardRowModel(PLAYER, ctxFor());
    assertEq(first.rank.label, 1, 'label');
    assertEq(first.rank.gold, true, 'gold');
    assertEq(first.rank.tied, false, 'the engine ranks sequentially, so no rank is ever shared');
    const third = buildLeaderboardRowModel(PLAYER, ctxFor({ rotoRanks: { ranks: new Map([[41, 3]]), total: 10, byCategory: new Map() } }));
    assertEq(third.rank.gold, false, 'third is not gold');
});

test('rank: NULL for a player the engine will not rank', () => {
    // The majority state with Minimum Games Played off - 882 of 1,487 rows on the real capture.
    const m = buildLeaderboardRowModel(PLAYER, ctxFor({ rotoRanks: { ranks: new Map(), total: 0, byCategory: new Map() } }));
    assertEq(m.rank, null, 'unranked');
});

// ==== points per game ====

test('ptsPerGame: null for a CATEGORY league - the Rank score already fills that role', () => {
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor()).ptsPerGame, null, 'roto');
});

test('ptsPerGame: ESPN own appliedAverage, not a division this code performs', () => {
    const m = buildLeaderboardRowModel(PLAYER, ctxFor({ isPointsLeague: true }));
    assertEq(m.ptsPerGame, 21.6, 'the published average, passed through');
});

test('ptsPerGame: present for FOOTBALL, which has no games statistic to divide by', () => {
    // The whole reason the figure is ESPN's rather than derived: showGames is false here and the column still fills, because appliedAverage is published on the season line regardless.
    const m = buildLeaderboardRowModel(PLAYER, ctxFor({ isPointsLeague: true, showGames: false, sport: 'ffl' }));
    assertEq(m.ptsPerGame, 21.6, 'football keeps its per-game figure');
});

test('ptsPerGame: a zero average reads as ABSENT, never as a measured zero', () => {
    // It cannot tell "never played" from "played and scored nothing", and an unknown is not a zero.
    assertEq(buildLeaderboardRowModel({ ...PLAYER, appliedAverage: 0 }, ctxFor({ isPointsLeague: true })).ptsPerGame, null, 'zero');
    assertEq(buildLeaderboardRowModel({ ...PLAYER, appliedAverage: null }, ctxFor({ isPointsLeague: true })).ptsPerGame, null, 'absent');
    assertEq(buildLeaderboardRowModel({ ...PLAYER, appliedAverage: undefined }, ctxFor({ isPointsLeague: true })).ptsPerGame, null, 'missing');
});

// ==== the season total ====

test('total: null for a CATEGORY league, which has no points concept', () => {
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor()).total, null, 'roto');
});

test('total: the ENGINE score when it has one - the same figure the rows sort by', () => {
    const ctx = ctxFor({
        isPointsLeague: true,
        rotoRanks: { ranks: new Map([[41, 1]]), total: 10, scores: new Map([[41, 416.6]]), byCategory: new Map() }
    });
    assertEq(buildLeaderboardRowModel(PLAYER, ctx).total, 416.6, 'the engine own score');
});

test('total: falls back to ESPN appliedTotal for a player the engine did not score', () => {
    // computePointsRanks reproduces appliedTotal, so the two agree; the fallback covers the player the engine skipped rather than inventing a zero for it.
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor({ isPointsLeague: true })).total, 300, 'appliedTotal');
    assertEq(buildLeaderboardRowModel({ ...PLAYER, appliedTotal: undefined }, ctxFor({ isPointsLeague: true })).total, null, 'and null when there is none');
});

// ==== cells ====

test('cells: percentiles come from the engine map and are passed through untouched', () => {
    const m = buildLeaderboardRowModel(PLAYER, ctxFor());
    assertEq(m.cells.length, 2, 'one per shown category');
    assertEq(m.cells[0].id, '5', 'id');
    assertEq(m.cells[0].label, 'HR', 'label from the stat map');
    assertEq(m.cells[0].pct, 84, 'the engine own percentile, not re-derived');
    assertEq(m.cells[1].pct, null, 'a category the engine had no percentile for is untinted');
    assertEq(m.cells[0].estimated, false, 'nothing on this surface is estimated');
});

test('cells: B218 R4/S34 - a POINTS league tints too, off categoryPct rather than rotoRanks', () => {
    // rotoRanks here is bare computePointsRanks-shaped output (no byCategory at all) - the row's own rank/score reads that, unaffected; the tint reads the SEPARATE categoryPct map the real caller computes with a second, roto-style pass just for this. Both are real facts about the same points league at once.
    const m = buildLeaderboardRowModel(PLAYER, ctxFor({
        isPointsLeague: true,
        rotoRanks: { ranks: new Map([[41, 1]]), total: 10 }
    }));
    assertEq(m.cells[0].pct, 84, 'a points league\'s cells tint off the engine\'s own percentile too');
});

test('cells: no categoryPct at all (an older/hand-built ctx) renders untinted rather than throwing', () => {
    const m = buildLeaderboardRowModel(PLAYER, ctxFor({ categoryPct: undefined }));
    assert(m.cells.every(c => c.pct === null), 'additive - absence is the pre-S34 behaviour, not a crash');
});

test('cells: inverse is documentation and follows the sport own set', () => {
    const m = buildLeaderboardRowModel({ ...PLAYER, seasonTotals: { '47': 3.1 } },
        ctxFor({ statIds: ['47'], statMap: { '47': 'ERA' } }));
    assertEq(m.cells[0].inverse, true, 'ERA is inverse');
    assertEq(buildLeaderboardRowModel(PLAYER, ctxFor()).cells[0].inverse, false, 'HR is not');
});

// ==== rostered ====

test('rostered: the figure and its change, when the column is honest', () => {
    const r = buildLeaderboardRowModel(PLAYER, ctxFor()).rostered;
    assertEq(r.pct, 97.2, 'pct');
    assertEq(r.change, 0.4, 'change');
});

test('rostered: NULL for a row carrying the filler value, real figures kept', () => {
    // ESPN collapses percentOwned out of season exactly as it collapses ADP.
    const filler = ctxFor({ rosteredFiller: 0 });
    assertEq(buildLeaderboardRowModel({ ...PLAYER, rosterPct: 0 }, filler).rostered, null, 'the filler row');
    assertEq(buildLeaderboardRowModel(PLAYER, filler).rostered.pct, 97.2, 'a real row survives');
});

test('rosteredFillerFor: fires only when one value dominates the column', () => {
    const collapsed = Array.from({ length: 30 }, (_, i) => ({ rosterPct: i < 20 ? 0 : i }));
    assertEq(rosteredFillerFor(collapsed), 0, 'two thirds share a value');
    const honest = Array.from({ length: 30 }, (_, i) => ({ rosterPct: i }));
    assertEq(rosteredFillerFor(honest), null, 'a spread column is honest');
    assertEq(rosteredFillerFor([]), null, 'no players');
});

test('rostered: a non-numeric share is null, never zero', () => {
    assertEq(buildLeaderboardRowModel({ ...PLAYER, rosterPct: undefined }, ctxFor()).rostered, null, 'absent');
});

// THE PRESEASON BASIS. The states that matter are a projected player, an unprojected one, and a league that is not in preseason at all - each trivial to state here and awkward to reach on a capture, which is why the function takes a ctx instead of reading AppState. The numbers are hand-computed: estimateUnprojected leaves an id ESPN forecasts alone, so a projected line passes through unchanged when nothing needs estimating.
const PROJECTED = { id: 7, name: 'Projected', projectedTotals: { '5': 30, '20': 90 }, lastSeasonTotals: { '5': 22 }, seasonTotals: { '5': 31, '20': 88 } };
const UNPROJECTED = { id: 8, name: 'No projection', projectedTotals: {}, lastSeasonTotals: { '5': 12 }, seasonTotals: { '5': 40, '20': 99 } };

test('preseasonBasisOf outside preseason returns the pool untouched', () => {
    const pool = [PROJECTED, UNPROJECTED];
    assertEq(preseasonBasisOf(pool, { preseason: false }), pool, 'same array, not a copy');
});

test('preseasonBasisOf with no ctx at all returns the pool untouched', () => {
    const pool = [PROJECTED];
    assertEq(preseasonBasisOf(pool), pool, 'a missing ctx is not preseason');
});

test('preseasonBasisOf swaps a projected line in for the actual one', () => {
    const [row] = preseasonBasisOf([PROJECTED], { preseason: true, estimateIds: [], rateIds: new Set() });
    assertEq(row.seasonTotals['5'], 30, 'HR comes from the projection, not the 31 actual');
    assertEq(row.seasonTotals['20'], 90, 'R comes from the projection, not the 88 actual');
});

// The board FILTERS these players out before ranking; the leaderboard shows the whole pool and cannot, so the row survives with nothing in it. A zero here would sort it above a real player.
test('preseasonBasisOf empties an unprojected line rather than zeroing or keeping it', () => {
    const [row] = preseasonBasisOf([UNPROJECTED], { preseason: true, estimateIds: [], rateIds: new Set() });
    assertEq(Object.keys(row.seasonTotals).length, 0, 'no stats at all');
    assertEq(row.seasonTotals['5'], undefined, 'not a zero - undefined, so the cell prints a dash');
    assertEq(row.name, 'No projection', 'the row itself survives');
});

test('preseasonBasisOf does not mutate the pool it was handed', () => {
    const source = { ...PROJECTED, seasonTotals: { ...PROJECTED.seasonTotals } };
    preseasonBasisOf([source], { preseason: true, estimateIds: [], rateIds: new Set() });
    assertEq(source.seasonTotals['5'], 31, 'the original still carries its actual line');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
