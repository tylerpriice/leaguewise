// Unit tests for the pure leaderboard row/header builder (leaderboard-row.js). Open tests/leaderboard-row.test.html through any static server (file:// won't work for ES modules); green means every assertion held. See tests/fixtures/leaderboard-row.md for the frozen contract these values are computed against.
import { buildLeaderboardRowHtml, buildLeaderboardHeaderHtml, escapeHtmlLocal, nextGameCell, gameDayTime, pinnedColumnWidth, comparePalette, hueDistance } from '../src/views/leaderboard-row.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// A minimal ordinary row with full identity, ranked solo, one tinted cell and a settled dial.
function baseRow(overrides = {}) {
    return Object.assign({
        id: 4429795,
        name: 'Jahmyr Gibbs',
        proAbbrev: 'DET',
        posLabel: 'RB',
        gpLabel: '14 GP',
        injuryStatus: null,
        isFreeAgent: false,
        rank: { label: 3, tied: false, gold: false },
        ptsPerGame: null,
        cells: [{ id: '24', label: 'R', value: '65', pct: 84, estimated: false, inverse: false }],
        rostered: { pct: 97.2, change: 0.4 },
    }, overrides);
}

test('identity: name, meta line joined with the middot separator, no dead segments when gpLabel is null', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    // The name is two spans now (lb-name-first/lb-name-last, never an ellipsis), so "Jahmyr Gibbs" no longer appears as one literal substring.
    assert(html.includes('lb-name-first" data-full="Jahmyr">Jahmyr'), 'first name renders');
    assert(html.includes('lb-name-last">Gibbs'), 'surname renders');
    assert(html.includes('DET · RB · 14 GP'), 'full three-part meta line');
    const noGp = buildLeaderboardRowHtml(baseRow({ gpLabel: null }));
    assert(noGp.includes('DET · RB'), 'two-part meta line with gpLabel omitted');
    assert(!noGp.includes('DET · RB ·'), 'no dangling separator when the third segment is dropped');
});

test('identity: B240 item 6/S141b - no row carries a compare trigger any more', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(!html.includes('lb-compare-trigger'), 'the row-level compare icon (B18 item 2) is gone - "two ways in was the objection" (B240 item 6)');
});

// Preseason has nothing for a drill-down to show, so the row draws no hover cursor for the click that would open one. `interactive` defaults true (every existing test above and below is unaffected); the caller states `false` for the one season state with nothing to open.

test('B221 R1/S49: interactive:false marks the row inert', () => {
    const html = buildLeaderboardRowHtml(baseRow(), { interactive: false });
    assert(html.includes('class="lb-row lb-row-inert"'), 'the row carries its own inert marker for the caller\'s CSS');
});

test('B221 R1/S49: interactive omitted (every real season) renders exactly as before - no inert class', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(!html.includes('lb-row-inert'), 'no inert marker when the caller says nothing');
});

test('identity: a null proAbbrev drops the club entirely, no leading middot and no invented club', () => {
    const html = buildLeaderboardRowHtml(baseRow({ proAbbrev: null }));
    assert(html.includes('RB · 14 GP'), 'meta line opens with the position, not a blank club');
    assert(!html.includes('· RB · 14 GP'), 'no leading separator where the missing club would have been');
    assert(!html.includes('null'), 'the word "null" never leaks into rendered text');
});

test('rank: null renders the existing unranked dash and hover text, never an invented rank', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rank: null }));
    assert(html.includes('lb-rank-unranked'), 'the unranked cell renders');
    assert(html.includes('data-tooltip="No games played, nothing to rank on"'), 'exact hover text, matching players.js\'s own rank-unranked cell');
    assert(html.includes('>-<'), 'a plain dash, not a fabricated number');
    assert(!html.includes('lb-rank-figure'), 'never the ranked figure markup for a null rank');
});

test('tie prefix: tied renders T, solo renders #', () => {
    const solo = buildLeaderboardRowHtml(baseRow({ rank: { label: 3, tied: false, gold: false } }));
    assert(solo.includes('>#3<'), 'solo rank gets the # prefix');
    const tied = buildLeaderboardRowHtml(baseRow({ rank: { label: 3, tied: true, gold: false } }));
    assert(tied.includes('>T3<'), 'tied rank gets the T prefix, not #');
    assert(!tied.includes('>#3<'), 'never both prefixes on the same row');
});

test('gold: the class is present only when the model says gold, regardless of the rank number', () => {
    const gold = buildLeaderboardRowHtml(baseRow({ rank: { label: 1, tied: false, gold: true } }));
    assert(gold.includes('lb-rank-gold'), 'gold class applied');
    const notGold = buildLeaderboardRowHtml(baseRow({ rank: { label: 1, tied: false, gold: false } }));
    assert(!notGold.includes('lb-rank-gold'), 'rank 1 alone does not imply gold - it is a caller decision');
});

test('matchupRank: showMatchupRank false (the default) renders no column at all, even when the model carries one', () => {
    const html = buildLeaderboardRowHtml(baseRow({ matchupRank: { winsPerWeek: 0.681, rank: { label: 5, tied: false } } }));
    assert(!html.includes('lb-mrank'), 'the column is entirely absent without the caller flag');
});

test('matchupRank: showMatchupRank true renders the rank figure and the wins/wk sub-line', () => {
    const html = buildLeaderboardRowHtml(baseRow({ matchupRank: { winsPerWeek: 0.681, rank: { label: 5, tied: false } } }), {}, 'playoff', true);
    assert(html.includes('<div class="lb-mrank"><span class="lb-mrank-figure">#5</span><span class="lb-mrank-sub">0.68/wk</span></div>'), 'exact markup: rank figure then the formatted wins/wk sub-line');
});

test('matchupRank: tied renders T, matching the Overall column\'s own convention', () => {
    const html = buildLeaderboardRowHtml(baseRow({ matchupRank: { winsPerWeek: 0.52, rank: { label: 36, tied: true } } }), {}, 'playoff', true);
    assert(html.includes('>T36<'), 'tied matchup rank gets the T prefix');
});

test('matchupRank: null (this player unmeasured) renders the muted dash, not a fabricated rank', () => {
    const html = buildLeaderboardRowHtml(baseRow({ matchupRank: null }), {}, 'playoff', true);
    assert(html.includes('lb-mrank-unranked'), 'the unranked cell renders');
    assert(html.includes('data-tooltip="Not enough categories measured to rank this player"'), 'exact hover text');
    assert(!html.includes('lb-mrank-figure'), 'never a fabricated figure for a null matchup rank');
});

test('matchupRank: a tiny negative winsPerWeek reads "0.00/wk", never "-0.00/wk"', () => {
    const html = buildLeaderboardRowHtml(baseRow({ matchupRank: { winsPerWeek: -0.0004, rank: { label: 464, tied: false } } }), {}, 'playoff', true);
    assert(html.includes('<span class="lb-mrank-sub">0.00/wk</span>'), 'no confusing negative sign on a value that is zero at this precision');
    assert(!html.includes('-0.00'), 'never the raw toFixed negative-zero string');
});

test('buildLeaderboardHeaderHtml: showMatchupRank renders the Matchup header, sortable, defaulted label', () => {
    const on = buildLeaderboardHeaderHtml({ showMatchupRank: true });
    assert(on.includes('<div class="lb-head-mrank sortable" data-sort="matchupRank">Matchup'), 'default label and sort key');
    const off = buildLeaderboardHeaderHtml({});
    assert(!off.includes('lb-head-mrank'), 'omitted entirely when the flag is off');
});

test('tint mapping: --pct is the clamped number verbatim at 0, 35, 50, 70, 100 - the CSS side does the mixing', () => {
    [0, 35, 50, 70, 100].forEach(pct => {
        const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: 'x', pct, estimated: false, inverse: false }] }));
        assert(html.includes(`--pct:${pct}`), `expected --pct:${pct} for input ${pct}`);
    });
});

test('tint clamp: an out-of-range pct is clamped to [0, 100], never passed through raw', () => {
    const low = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: 'x', pct: -12, estimated: false, inverse: false }] }));
    assert(low.includes('--pct:0'), 'negative pct clamps to 0');
    const high = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: 'x', pct: 140, estimated: false, inverse: false }] }));
    assert(high.includes('--pct:100'), 'over-100 pct clamps to 100');
});

test('null pct: no --pct is set at all, so the CSS fallback-to-50 (untinted) applies', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: 'x', pct: null, estimated: false, inverse: false }] }));
    assert(!html.includes('--pct'), 'no inline --pct for a null percentile');
});

test('null pct drops the tint background entirely (lb-cell-untinted), not just the --pct number', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: 'x', pct: null, estimated: false, inverse: false }] }));
    assert(html.includes('class="lb-cell lb-cell-untinted"'), 'the untinted modifier class is present');
});

test('a real number with no percentile stays untinted but keeps normal (non-faint) text - it is not a dash', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'TD', value: '2', pct: null, estimated: false, inverse: false }] }));
    assert(html.includes('lb-cell-untinted'), 'no background, same as any null-pct cell');
    assert(!html.includes('lb-cell-dash'), 'a real figure is not the no-figure case, even with no percentile');
});

test('cells[].value === "-" (the app-wide no-figure convention) gets the faint dash treatment, always alongside untinted', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'RYDS', value: '-', pct: null, estimated: false, inverse: false }] }));
    assert(html.includes('class="lb-cell lb-cell-untinted lb-cell-dash"'), 'both modifier classes together, in order');
    assert(html.includes('>-<'), 'the dash itself still renders as the cell content');
});

test('a dash cell with a stray non-null pct (should not happen, but defensively) keeps its tint - only value drives lb-cell-dash', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'RYDS', value: '-', pct: 40, estimated: false, inverse: false }] }));
    assert(!html.includes('lb-cell-untinted'), 'a real pct still tints normally');
    assert(html.includes('lb-cell-dash'), 'the dash text colour is independent of whether a pct happens to be present');
});

test('inverse-category tint: a low pct on an inverse stat renders exactly as given, never re-inverted', () => {
    // An inverse category (e.g. ERA) already had its percentile flipped by the rank engine before this model existed, so a low ERA produces a high pct, with any small-sample shrinkage folded in too. A pct of 30 here means 30th percentile, full stop. The builder is a pure pass-through from model to --pct, and one that re-derived it would render --pct:70, which is the bug this test exists to catch.
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: 'era', label: 'ERA', value: '2.10', pct: 30, estimated: false, inverse: true }] }));
    assert(html.includes('--pct:30'), 'inverse cell renders its own pct unchanged, not flipped to 70');
});

test('cell hover text: label, value, ordinal percentile, and "estimated" only when flagged', () => {
    const plain = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: '65', pct: 84, estimated: false, inverse: false }] }));
    assert(plain.includes('data-tooltip="R: 65 · 84th percentile"'), 'exact hover phrase, no estimated clause');
    const est = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: '65', pct: 84, estimated: true, inverse: false }] }));
    assert(est.includes('data-tooltip="R: 65 · 84th percentile, estimated"'), 'estimated clause appended');
    const noPct = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '1', label: 'R', value: '65', pct: null, estimated: false, inverse: false }] }));
    assert(noPct.includes('data-tooltip="R: 65"'), 'no percentile clause when pct is null');
});

test('XSS: a hostile name, meta field and cell label/value all render escaped, never as live markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildLeaderboardRowHtml(baseRow({
        name: hostile,
        proAbbrev: hostile,
        cells: [{ id: '1', label: hostile, value: hostile, pct: 50, estimated: false, inverse: false }],
    }));
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the escaped form is present instead');
});

test('no-ptsPerGame case: null omits the whole column, not a dash or a zero', () => {
    const html = buildLeaderboardRowHtml(baseRow({ ptsPerGame: null }));
    assert(!html.includes('lb-ptsg'), 'no PTS/G markup at all when the model carries none');
});

test('ptsPerGame present: renders to one decimal', () => {
    const html = buildLeaderboardRowHtml(baseRow({ ptsPerGame: 18 }));
    assert(html.includes('<div class="lb-ptsg">18.0</div>'), 'formatted to one decimal even for a whole number');
});

test('total: null is a no-op - the column is exactly what it would be without total ever existing', () => {
    const withPts = buildLeaderboardRowHtml(baseRow({ total: null, ptsPerGame: 18 }));
    assert(withPts.includes('<div class="lb-ptsg">18.0</div>'), 'plain single-number cell, unchanged from before total existed');
    assert(!withPts.includes('lb-total-figure') && !withPts.includes('lb-ptsg-secondary'), 'no slab/secondary markup leaks in from a null total');
    const withNeither = buildLeaderboardRowHtml(baseRow({ total: null, ptsPerGame: null }));
    assert(!withNeither.includes('lb-ptsg'), 'still omitted entirely when neither figure exists');
});

test('total: non-null renders the slab figure with ptsPerGame as its muted secondary', () => {
    const html = buildLeaderboardRowHtml(baseRow({ total: 416.6, ptsPerGame: 29.8 }));
    assert(html.includes('<span class="lb-total-figure">416.6</span>'), 'the total is the slab figure, one decimal');
    assert(html.includes('<span class="lb-ptsg-secondary">29.8</span>'), 'ptsPerGame renders as the muted secondary');
});

test('total: non-null with no ptsPerGame renders the slab alone, no empty secondary markup', () => {
    const html = buildLeaderboardRowHtml(baseRow({ total: 200, ptsPerGame: null }));
    assert(html.includes('<span class="lb-total-figure">200.0</span>'), 'the slab still renders');
    assert(!html.includes('lb-ptsg-secondary'), 'no secondary span when there is no ptsPerGame to put in it');
});

// The playoff-window lens. UNEVEN carries the exact worked example tests/fixtures/schedule-insight.md documents (matchups 22/23 at 7 days, 24 folding the pro season's tail in at 18) so the round-length caveat has a real case to prove itself against.
const PLAYOFF_UNEVEN = {
    games: 14,
    byRound: [
        { matchup: 22, games: 4, days: 7 },
        { matchup: 23, games: 2, days: 7 },
        { matchup: 24, games: 8, days: 18 },
    ],
    projected: 92.4,
    trend: 'up',
};

test('playoff: null omits the whole column, not an empty one', () => {
    const html = buildLeaderboardRowHtml(baseRow({ playoff: null }));
    assert(!html.includes('lb-playoff'), 'no playoff markup at all when the model carries none');
});

test('playoff: present renders the projected slab and the compact round-by-round figure', () => {
    const html = buildLeaderboardRowHtml(baseRow({ playoff: PLAYOFF_UNEVEN }));
    assert(html.includes('<div class="lb-playoff"'), 'the column renders');
    assert(html.includes('<span class="lb-total-figure">92.4</span>'), 'projected total, one decimal, the same slab class the points-league total uses');
    assert(html.includes('<span class="lb-playoff-rounds">4 · 2 · 8 games</span>'), 'compact figure: counts joined by the middot, one trailing "games"');
});

test('playoff: a total of exactly one game across every round reads "1 game", never "1 games"', () => {
    const oneGame = Object.assign({}, PLAYOFF_UNEVEN, {
        byRound: [{ matchup: 22, games: 1, days: 7 }],
    });
    const html = buildLeaderboardRowHtml(baseRow({ playoff: oneGame }));
    assert(html.includes('<span class="lb-playoff-rounds">1 game</span>'), 'singular, no trailing s');

    const oneAcrossRounds = Object.assign({}, PLAYOFF_UNEVEN, {
        byRound: [{ matchup: 22, games: 1, days: 7 }, { matchup: 23, games: 0, days: 7 }],
    });
    const spreadHtml = buildLeaderboardRowHtml(baseRow({ playoff: oneAcrossRounds }));
    assert(spreadHtml.includes('<span class="lb-playoff-rounds">1 · 0 game</span>'), 'singular still applies when the one game is spread across rounds with a bye');
});

test('playoff hover: names every round and appends the round-length caveat only when the days actually differ', () => {
    const uneven = buildLeaderboardRowHtml(baseRow({ playoff: PLAYOFF_UNEVEN }));
    assert(uneven.includes('data-tooltip="DET plays 4 games in 22, 2 in 23, and 8 in 24. Those rounds run 7, 7, and 18 days. Recent form: rising."'), 'exact hover sentence, all three clauses');

    const even = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, {
        byRound: [{ matchup: 22, games: 4, days: 7 }, { matchup: 23, games: 2, days: 7 }],
        trend: null,
    }) }));
    assert(even.includes('data-tooltip="DET plays 4 games in 22 and 2 in 23."'), 'two rounds join with a bare "and", no Oxford comma needed');
    assert(!even.includes('Those rounds run'), 'the caveat sentence is omitted outright when every round is the same length');
    assert(!even.includes('Recent form'), 'no trend clause when trend is null');
});

test('playoff hover: a bye (0 games) reads "no games" as the first round, "none" as a later one', () => {
    const firstRoundBye = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, {
        byRound: [{ matchup: 22, games: 0, days: 7 }, { matchup: 23, games: 3, days: 7 }],
    }) }));
    assert(firstRoundBye.includes('DET plays no games in 22 and 3 in 23.'), 'the first round spells out "no games"');
    assert(firstRoundBye.includes('<span class="lb-playoff-rounds">0 · 3 games</span>'), 'the compact figure still prints a plain 0, unlike the hover prose');

    const laterRoundBye = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, {
        byRound: [{ matchup: 22, games: 3, days: 7 }, { matchup: 23, games: 0, days: 7 }],
    }) }));
    assert(laterRoundBye.includes('DET plays 3 games in 22 and none in 23.'), 'a later bye round reads the bare "none"');
});

test('playoff trend: up/down/flat get their own glyph and class, null renders no trend icon at all', () => {
    const up = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, { trend: 'up' }) }));
    assert(up.includes('<span class="trend-icon trend-up">↗</span>'), 'up: the same glyph/class the Rank column already uses');
    const down = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, { trend: 'down' }) }));
    assert(down.includes('<span class="trend-icon trend-down">↘</span>'), 'down: same');
    const flat = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, { trend: 'flat' }) }));
    assert(flat.includes('<span class="trend-icon trend-flat">→</span>'), 'flat: the one new state this lens needed, same vocabulary');
    const none = buildLeaderboardRowHtml(baseRow({ playoff: Object.assign({}, PLAYOFF_UNEVEN, { trend: null }) }));
    assert(!none.includes('trend-icon'), 'null trend renders no icon, not an empty one');
});

test('playoff: projected null omits the slab figure, never a fabricated 0.0 - the round counts still print', () => {
    const noProjection = Object.assign({}, PLAYOFF_UNEVEN, { projected: null, trend: null });
    const html = buildLeaderboardRowHtml(baseRow({ playoff: noProjection }));
    assert(html.includes('<div class="lb-playoff"'), 'the column still renders - the schedule counts are real');
    assert(!html.includes('lb-total-figure'), 'no slab figure at all when there is nothing to project');
    assert(!html.includes('0.0'), 'never a fabricated zero standing in for the missing projection');
    assert(html.includes('<span class="lb-playoff-rounds">4 · 2 · 8 games</span>'), 'the round-by-round figure is unaffected - it is real regardless of projection');

    // A trend can still exist without a projection (recent form is a separate fact), so it keeps its own slot rather than disappearing along with the total.
    const withTrend = Object.assign({}, PLAYOFF_UNEVEN, { projected: null, trend: 'up' });
    const trendHtml = buildLeaderboardRowHtml(baseRow({ playoff: withTrend }));
    assert(trendHtml.includes('<span class="trend-icon trend-up">↗</span>'), 'trend renders independently of projected');
    assert(!trendHtml.includes('lb-total-figure'), 'still no slab, even with a trend present');
});

test('playoff: projected null falls back to rank (a category league\'s own answer), row-rank style', () => {
    const soloRank = Object.assign({}, PLAYOFF_UNEVEN, { projected: null, rank: { label: 12, tied: false } });
    const html = buildLeaderboardRowHtml(baseRow({ playoff: soloRank }));
    assert(html.includes('<span class="lb-total-figure">#12</span>'), 'the rank fills the slab, solo prefix');
    assert(html.includes('<span class="lb-playoff-rounds">4 · 2 · 8 games</span>'), 'the round-by-round figure is unaffected');

    const tiedRank = Object.assign({}, PLAYOFF_UNEVEN, { projected: null, rank: { label: 12, tied: true } });
    const tiedHtml = buildLeaderboardRowHtml(baseRow({ playoff: tiedRank }));
    assert(tiedHtml.includes('<span class="lb-total-figure">T12</span>'), 'a tied rank uses T, the same split the Rank column makes');
});

test('playoff: projected takes priority over rank when both are present', () => {
    const both = Object.assign({}, PLAYOFF_UNEVEN, { projected: 92.4, rank: { label: 1, tied: false } });
    const html = buildLeaderboardRowHtml(baseRow({ playoff: both }));
    assert(html.includes('<span class="lb-total-figure">92.4</span>'), 'projected wins - a points league would never carry rank anyway, but the renderer does not have to trust that');
    assert(!html.includes('>#1<'), 'rank never shows once projected has an answer');
});

test('playoff: neither projected nor rank omits the slab entirely, same as before this field existed', () => {
    const neither = Object.assign({}, PLAYOFF_UNEVEN, { projected: null, rank: null, trend: null });
    const html = buildLeaderboardRowHtml(baseRow({ playoff: neither }));
    assert(!html.includes('lb-total-figure'), 'no slab at all - nothing to show and nothing invented');
    assert(html.includes('<span class="lb-playoff-rounds">4 · 2 · 8 games</span>'), 'the counts are still real regardless');
});

test('playoff: XSS - a hostile proAbbrev renders escaped in the hover sentence', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildLeaderboardRowHtml(baseRow({ proAbbrev: hostile, playoff: PLAYOFF_UNEVEN }));
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt; plays'), 'the escaped club still opens the sentence');
});

// The "games left" lens (this matchup / next matchup), sharing the playoff column's slot.
const WINDOW_MULTI = {
    matchup: 5, games: 6, played: 3, remaining: 3,
    byPeriod: [{ period: 'Tue', count: 1 }, { period: 'Thu', count: 1 }, { period: 'Sat', count: 2 }, { period: 'Sun', count: 2 }],
    starts: null,
};

test('window lens defaults off (playoff stays the default column) - explicit "window" lens renders it', () => {
    const withoutLens = buildLeaderboardRowHtml(baseRow({ window: WINDOW_MULTI }));
    assert(!withoutLens.includes('lb-window'), 'omitting the lens argument keeps the playoff column, never guesses at window');
    const withLens = buildLeaderboardRowHtml(baseRow({ window: WINDOW_MULTI }), {}, 'window');
    assert(withLens.includes('<div class="lb-window"'), 'the lens argument switches the shared column to window');
    assert(!withLens.includes('lb-playoff'), 'never both lenses at once - it is one column, not a fourth');
});

test('lens explicitly null renders no lens column at all - a real caller\'s "nothing chosen yet", distinct from omitting the argument', () => {
    const html = buildLeaderboardRowHtml(baseRow({ playoff: PLAYOFF_UNEVEN, window: WINDOW_MULTI }), {}, null);
    assert(!html.includes('lb-playoff'), 'no playoff column despite the model carrying one');
    assert(!html.includes('lb-window'), 'no window column either - explicit null means no lens, not "guess one"');
});

test('window lens: null on the active lens omits the column, not an empty one', () => {
    const html = buildLeaderboardRowHtml(baseRow({ window: null }), {}, 'window');
    assert(!html.includes('lb-window'), 'no markup at all when the active lens has nothing to show');
});

test('window lens: multi-game figure is "N of games left", never a percentage', () => {
    const html = buildLeaderboardRowHtml(baseRow({ window: WINDOW_MULTI }), {}, 'window');
    assert(html.includes('<span class="lb-window-figure">3 of 6 left</span>'), 'remaining of games, the exact worked figure from the brief');
});

test('window lens hover: names every day with a game, counts a multi-game day, and states games left', () => {
    const html = buildLeaderboardRowHtml(baseRow({ window: WINDOW_MULTI }), {}, 'window');
    assert(html.includes('data-tooltip="6 games this matchup: Tue, Thu, 2 on Sat, and 2 on Sun. 3 left."'), 'Oxford join, a single game named bare, a multi-game day counted');
});

test('next lens: same shape, different field and subject label - "next matchup" in the hover', () => {
    const html = buildLeaderboardRowHtml(baseRow({ next: WINDOW_MULTI }), {}, 'next');
    assert(html.includes('<span class="lb-window-figure">3 of 6 left</span>'), 'the figure is lens-agnostic - same rule, different source field');
    assert(html.includes('this matchup: Tue') === false, 'the subject names next, not this, matchup');
    assert(html.includes('6 games next matchup: Tue'), 'the hover subject follows the active lens');
});

// The rest-of-season lens, replacing Playoffs on the toggle.
const REST_WINDOW = {
    matchup: null, games: 23, played: 0, remaining: 23,
    offNight: 4, twoGameDays: 1,
    byPeriod: [{ period: 'Tue', count: 1 }],
    starts: null,
};

test('rest lens: the compact figure is games alone, never a fraction', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rest: REST_WINDOW }), {}, 'rest');
    assert(html.includes('<span class="lb-window-figure">23</span>'), 'the bare headline count, not "23 of 23 left"');
});

test('rest lens hover: subject names the whole season, not one matchup', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rest: REST_WINDOW }), {}, 'rest');
    assert(html.includes('games the rest of the season:'), 'the rest-specific subject label');
});

test('window/next/rest: offNight and twoGameDays render as suffixes in the mockup colours, joined by a middot', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rest: REST_WINDOW }), {}, 'rest');
    assert(html.includes('<span class="lb-window-suffix"><span class="lb-window-off">4 off</span> &middot; <span class="lb-window-dbl">1 dbl</span></span>'),
        'both suffixes present, off before dbl, matching the mockup order');
});

test('offNight/twoGameDays: a real zero is omitted exactly like null - the renderer cannot and need not tell them apart', () => {
    const zeroed = Object.assign({}, WINDOW_MULTI, { offNight: 0, twoGameDays: 0 });
    const html = buildLeaderboardRowHtml(baseRow({ window: zeroed }), {}, 'window');
    assert(!html.includes('lb-window-suffix'), 'no suffix markup at all, not "0 off"');
    assert(html.includes('<span class="lb-window-figure">3 of 6 left</span>'), 'the figure is unaffected - Burleson\'s own proof from the mockup');
});

// The fourth lens state, a different shape (`{ nights, count }`) than window/next/rest, so it gets its own figure branch.
test('openSeats lens: the figure is the bare count, same class window/next/rest use', () => {
    const html = buildLeaderboardRowHtml(baseRow({ isFreeAgent: true, openSeats: { nights: [12, 14], count: 2 } }), {}, 'openSeats');
    assert(html.includes('<span class="lb-window-figure">2</span>'), 'openSeats renders through the shared .lb-window-figure class');
});

test('openSeats lens: the hover says "an open seat", never "started"', () => {
    const html = buildLeaderboardRowHtml(baseRow({ openSeats: { nights: [12], count: 1 } }), {}, 'openSeats');
    assert(html.includes('1 night with an open seat this matchup.'), 'singular night, singular wording');
    assert(!html.toLowerCase().includes('started'), 'the field never claims a lineup was set');
});

test('openSeats lens: a rostered player (model.openSeats null) renders no lens column at all', () => {
    const html = buildLeaderboardRowHtml(baseRow({ isFreeAgent: false, openSeats: null }), {}, 'openSeats');
    assert(!html.includes('lb-window'), 'no dead band - the column omits itself exactly like every other lens with nothing to say');
});

test('openSeats lens: count 0 is a real answer and still renders (never confused with null)', () => {
    const html = buildLeaderboardRowHtml(baseRow({ openSeats: { nights: [], count: 0 } }), {}, 'openSeats');
    assert(html.includes('<span class="lb-window-figure">0</span>'), 'a real zero prints, unlike the null case above');
});

test('buildLeaderboardHeaderHtml: timeLens "openSeats" defaults to "Empty Nights"', () => {
    const html = buildLeaderboardHeaderHtml({ timeLens: 'openSeats' });
    assert(html.includes('>Empty Nights<'), 'the shared header reads the new lens\'s own default label');
});

// One copy line, the Rank header's own hover, distinct from the click-to-open explainer.
test('buildLeaderboardHeaderHtml: the Rank header carries its own hover naming the pool it ranks against', () => {
    const html = buildLeaderboardHeaderHtml({ cells: [] });
    assert(html.includes('class="lb-head-rank sortable" data-sort="rank" data-tooltip='), 'the tooltip sits on the header cell itself');
    assert(html.includes('Ranks against the whole group'), 'names the default pool');
    assert(html.includes('Choosing a position ranks against that position instead'), 'names what a position filter changes');
});

test('offNight/twoGameDays: only one present still renders, alone', () => {
    const offOnly = Object.assign({}, WINDOW_MULTI, { offNight: 1, twoGameDays: 0 });
    const html = buildLeaderboardRowHtml(baseRow({ window: offOnly }), {}, 'window');
    assert(html.includes('<span class="lb-window-suffix"><span class="lb-window-off">1 off</span></span>'), 'off alone, no middot, no dbl');
});

test('window lens: a pitcher\'s starts print as a muted secondary line, "N starts, M left" in the hover', () => {
    const withStarts = Object.assign({}, WINDOW_MULTI, { starts: { total: 2, remaining: 1 } });
    const html = buildLeaderboardRowHtml(baseRow({ window: withStarts }), {}, 'window');
    assert(html.includes('<span class="lb-window-secondary">2 starts · 1 left</span>'), 'the exact worked secondary line from the brief');
    assert(html.includes('2 starts, 1 left.'), 'the hover states the same fact in full sentences');
});

test('window lens: no starts field renders no secondary line at all, not an empty one', () => {
    const html = buildLeaderboardRowHtml(baseRow({ window: WINDOW_MULTI }), {}, 'window');
    assert(!html.includes('lb-window-secondary'), 'a hitter (or a football player) has no starts concept to show');
});

test('window lens: a single-game week (football) reads "Upcoming"/"Played", never "0 of 1"/"1 of 1"', () => {
    const upcoming = buildLeaderboardRowHtml(baseRow({
        window: { matchup: 5, games: 1, played: 0, remaining: 1, byPeriod: [{ period: 'Sun', count: 1 }], starts: null },
    }), {}, 'window');
    assert(upcoming.includes('<span class="lb-window-figure">Upcoming</span>'), 'one game, not yet played - named, not counted as a fraction');

    const played = buildLeaderboardRowHtml(baseRow({
        window: { matchup: 5, games: 1, played: 1, remaining: 0, byPeriod: [{ period: 'Sun', count: 1 }], starts: null },
    }), {}, 'window');
    assert(played.includes('<span class="lb-window-figure">Played</span>'), 'the only game already happened');

    assert(upcoming.includes('data-tooltip="1 game this matchup: Sun. 1 left."'), 'the hover still spells out the real game - only the compact figure avoids the silly fraction');
});

test('window lens: a bye day (count 0) never appears in the hover\'s day list', () => {
    const withBye = Object.assign({}, WINDOW_MULTI, {
        byPeriod: [{ period: 'Mon', count: 0 }, { period: 'Tue', count: 1 }],
    });
    const html = buildLeaderboardRowHtml(baseRow({ window: withBye }), {}, 'window');
    assert(!html.includes('Mon'), 'a zero-count day contributes nothing to name');
    assert(html.includes('this matchup: Tue.'), 'the remaining day still reads correctly alone, no dangling comma');
});

test('window lens: XSS - a hostile period label renders escaped in the hover', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildLeaderboardRowHtml(baseRow({
        window: { matchup: 5, games: 1, played: 0, remaining: 1, byPeriod: [{ period: hostile, count: 1 }], starts: null },
    }), {}, 'window');
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped in the hover');
});

test('header: timeLens generalizes the shared column - "playoff" keeps showPlayoff\'s exact old behaviour', () => {
    const legacy = buildLeaderboardHeaderHtml({ cells: [], showPlayoff: true });
    assert(legacy.includes('data-sort="playoff"') && legacy.includes('>Playoff<'), 'unchanged for every caller that never learns about timeLens');
});

test('header: timeLens "window"/"next" render the generic lb-head-window class with their own default label', () => {
    const win = buildLeaderboardHeaderHtml({ cells: [], timeLens: 'window' });
    assert(win.includes('<div class="lb-head-window sortable"') && win.includes('data-sort="window"') && win.includes('>This Matchup<'), 'window default label');
    const next = buildLeaderboardHeaderHtml({ cells: [], timeLens: 'next' });
    assert(next.includes('>Next Matchup<'), 'next default label');
    const overridden = buildLeaderboardHeaderHtml({ cells: [], timeLens: 'next', timeLensLabel: 'Up Next' });
    assert(overridden.includes('>Up Next<'), 'timeLensLabel overrides the default for any lens');
});

test('header: the Playoff column only appears when showPlayoff is true, with its own sort key', () => {
    const without = buildLeaderboardHeaderHtml({ cells: [] });
    assert(!without.includes('lb-head-playoff'), 'omitted by default');
    const withIt = buildLeaderboardHeaderHtml({ cells: [], showPlayoff: true });
    assert(withIt.includes('data-sort="playoff"') && withIt.includes('>Playoff<'), 'rendered with its own data-sort key when requested');
});

test('no-dial case: rostered null omits the dial entirely, not a 0% one', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rostered: null }));
    assert(!html.includes('lb-rostered'), 'no rostered markup at all');
});

test('dial states: amber only inside the 30-70 contested band, inclusive of both edges', () => {
    const green20 = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 20, change: 0 } }));
    assert(green20.includes('lb-dial-green') && !green20.includes('lb-dial-amber'), '20% is green, below the band');
    const amber30 = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 30, change: 0 } }));
    assert(amber30.includes('lb-dial-amber'), '30% is amber, the low edge is inclusive');
    const amber70 = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 70, change: 0 } }));
    assert(amber70.includes('lb-dial-amber'), '70% is amber, the high edge is inclusive');
    const green71 = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 71, change: 0 } }));
    assert(green71.includes('lb-dial-green') && !green71.includes('lb-dial-amber'), '71% is green, just above the band');
    const green97 = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 97.2, change: 0 } }));
    assert(green97.includes('lb-dial-green'), 'a high, settled share is green');
});

test('dial change line: shown only when abs(change) >= 5, with direction and rounded magnitude', () => {
    const quiet = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 50, change: 4.9 } }));
    assert(!quiet.includes('lb-dial-change'), 'under-5 change is not news, no line');
    const up = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 50, change: 6.2 } }));
    assert(up.includes('▲6 this week'), 'a rise of >=5 shows the up arrow, rounded');
    const down = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 50, change: -7.0 } }));
    assert(down.includes('▼7 this week'), 'a drop of >=5 shows the down arrow, magnitude only');
    assert(!down.includes('▲7'), 'a drop never renders the up arrow');
});

test('dial change line: a rise is the success token, a fall the danger token, whatever the dial tone', () => {
    const upAmber = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 50, change: 6.2 } }));
    assert(upAmber.includes('lb-dial-amber') && upAmber.includes('lb-dial-change lb-change-up'), 'a rise on an amber dial is up-coloured, the dial stays amber');
    const downGreen = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 90, change: -6.2 } }));
    assert(downGreen.includes('lb-dial-green') && downGreen.includes('lb-dial-change lb-change-down'), 'a fall on a green dial is down-coloured, the dial stays green');
    assert(!downGreen.includes('lb-change-up'), 'a fall never carries the up class');
    const upGreen = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 90, change: 5 } }));
    assert(upGreen.includes('lb-change-up'), 'the 5-point threshold is inclusive and still holds');
});

test('team disc: a rostered player draws the fantasy team logo ringed in its colour, a free agent draws nothing (B283 1.1)', () => {
    const on = buildLeaderboardRowHtml(baseRow({ team: { name: 'Walk Off Warriors', color: '#e6194b', logo: 'https://g.espncdn.com/x.png' } }));
    assert(on.includes('lb-team-disc') && on.includes('--fteam-color:#e6194b'), 'the disc carries the legend colour');
    assert(on.includes('src="https://g.espncdn.com/x.png"') && on.includes('data-team-logo="https://g.espncdn.com/x.png"'), 'and the logo');
    assert(on.includes('title="Walk Off Warriors"'), 'and the full team name as its hover');
    const ring = buildLeaderboardRowHtml(baseRow({ team: { name: 'Walk Off Warriors', color: '#e6194b', logo: null } }));
    assert(ring.includes('lb-team-disc') && !ring.includes('<img class="avatar-img" loading="lazy" alt="" src="https://'), 'a logo the host rule refused draws the ring alone');
    const none = buildLeaderboardRowHtml(baseRow({ team: null }));
    assert(!none.includes('lb-team-disc'), 'a free agent has no disc, and no dash');
    assert(!buildLeaderboardRowHtml(baseRow()).includes('lb-team-disc'), 'a caller with no team field draws none');
});

test('dial hover text: exact phrase and one-decimal signed change, independent of the change line threshold', () => {
    const html = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 97.2, change: 0.4 } }));
    assert(html.includes('data-tooltip="Rostered in 97% of ESPN leagues, +0.4 this week"'), 'exact hover phrase, rounded percent, signed one-decimal change');
    const negHtml = buildLeaderboardRowHtml(baseRow({ rostered: { pct: 12, change: -3.25 } }));
    assert(negHtml.includes('Rostered in 12% of ESPN leagues, -3.3 this week'), 'a negative change needs no extra sign, toFixed already carries the minus');
});

test('escapeHtmlLocal matches the app-wide escaping rules (the fallback when no escapeHtml is passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('caller-supplied opts are used in place of every local fallback', () => {
    let avatarCalls = 0, badgeCalls = 0, arrowCalls = 0, logoCalls = 0;
    const opts = {
        escapeHtml: s => String(s).toUpperCase(),
        avatarHtml: (id, name) => { avatarCalls++; return `<i data-id="${id}">${name}</i>`; },
        logoHtml: (proAbbrev) => { logoCalls++; return `<i data-logo="${proAbbrev}"></i>`; },
        injuryBadgeHtml: status => { badgeCalls++; return status ? '<b>hurt</b>' : ''; },
        sortArrowHtml: key => { arrowCalls++; return key === 'name' ? ' UP' : ''; },
    };
    const rowHtml = buildLeaderboardRowHtml(baseRow({ injuryStatus: 'OUT' }), opts);
    assert(avatarCalls === 1, 'avatarHtml was called');
    assert(logoCalls === 1, 'logoHtml was called');
    assert(badgeCalls === 1, 'injuryBadgeHtml was called');
    // The name is two spans now (lb-name-first/lb-name-last).
    assert(rowHtml.includes('JAHMYR') && rowHtml.includes('GIBBS'), 'the supplied escapeHtml reached the rendered HTML');
    assert(rowHtml.includes('<b>hurt</b>'), 'the supplied injuryBadgeHtml reached the rendered HTML');
    assert(rowHtml.includes('data-logo="DET"'), 'the supplied logoHtml reached the rendered HTML, called with proAbbrev');
    const headHtml = buildLeaderboardHeaderHtml({ cells: [{ id: '1', label: 'R' }] }, opts);
    assert(arrowCalls > 0, 'sortArrowHtml was called for the header');
    assert(headHtml.includes(' UP'), 'the supplied sortArrowHtml reached the rendered header');
});

test('logoHtml (B8): the local fallback renders nothing, matching the "no logo, exactly today\'s layout" rule', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(!html.includes('pro-team-logo'), 'no wiring supplied - the unwired fallback draws no logo at all, not a placeholder');
});

test('B222 R5: identity: a D/ST row draws the crest, not the avatar-plus-logo pair', () => {
    let avatarCalls = 0, logoCalls = 0, crestCalls = 0;
    const opts = {
        avatarHtml: (id, name) => { avatarCalls++; return `<i data-avatar="${id}">${name}</i>`; },
        logoHtml: (proAbbrev) => { logoCalls++; return `<i data-logo="${proAbbrev}"></i>`; },
        proTeamCrestHtml: (proAbbrev) => { crestCalls++; return `<i data-crest="${proAbbrev}"></i>`; },
    };
    const html = buildLeaderboardRowHtml(baseRow({ name: '49ers D/ST', posLabel: 'D/ST', proAbbrev: 'SF' }), opts);
    assert(crestCalls === 1 && html.includes('data-crest="SF"'), 'proTeamCrestHtml drew the identity, called with the row\'s own proAbbrev');
    assert(avatarCalls === 0, 'avatarHtml (the greyed player tile) never runs for a D/ST row');
    assert(logoCalls === 0, 'logoHtml (the second small club mark) never runs for a D/ST row');
    // Every other posLabel is untouched by this branch, D/ST spelled differently included.
    const human = buildLeaderboardRowHtml(baseRow(), opts);
    assert(human.includes('data-avatar='), 'an ordinary row still draws the avatar');
    assert(human.includes('data-logo='), 'an ordinary row still draws its logo');
});

test('B222 R5: identity: the crest fallback is an initials tile, matching the avatar fallback\'s own shape', () => {
    const html = buildLeaderboardRowHtml(baseRow({ posLabel: 'D/ST', proAbbrev: 'SF' }));
    assert(html.includes('lb-avatar-fallback'), 'no wiring supplied - the unwired crest fallback draws the same tile class avatarHtmlLocal uses');
    assert(html.includes('>SF<'), 'the fallback prints the club abbreviation, not initials of the D/ST unit\'s own name');
});

test('header: PTS/G column only appears when showPtsPerGame is true', () => {
    const without = buildLeaderboardHeaderHtml({ cells: [] });
    assert(!without.includes('lb-head-ptsg'), 'omitted by default');
    const withIt = buildLeaderboardHeaderHtml({ cells: [], showPtsPerGame: true });
    assert(withIt.includes('lb-head-ptsg'), 'rendered when requested');
});

test('header: one header cell per category, in the order given, each sortable by its own id', () => {
    const html = buildLeaderboardHeaderHtml({ cells: [{ id: '24', label: 'R' }, { id: '25', label: 'HR' }] });
    assert(html.indexOf('data-sort="24"') < html.indexOf('data-sort="25"'), 'category order preserved');
    assert(html.includes('>R<') || html.includes('>R '), 'R label present');
    assert(html.includes('>HR<') || html.includes('>HR '), 'HR label present');
});

test('header: Rostered column omits with showRostered: false', () => {
    const html = buildLeaderboardHeaderHtml({ cells: [], showRostered: false });
    assert(!html.includes('lb-head-rostered'), 'no rostered header cell');
});

// The pick control and the group's per-cell delta. ---------------------------------------------------------------------------

test('pick control: null (no caller wiring) draws nothing at all', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(!html.includes('lb-pick'), 'not even an unpicked "+" for a caller that never asked');
});

test('pick control: unpicked draws a plain "+", not disabled', () => {
    const html = buildLeaderboardRowHtml(baseRow(), {}, 'playoff', false, { state: null, capReached: false });
    assert(html.includes('class="lb-pick"'), 'the base class, no -on');
    assert(html.includes('>+<'), 'the plus');
    assert(!html.includes('disabled'), 'not disabled below the cap');
});

test('pick control: capped and unpicked is disabled, still a "+"', () => {
    const html = buildLeaderboardRowHtml(baseRow(), {}, 'playoff', false, { state: null, capReached: true });
    assert(html.includes('lb-pick" disabled') || html.includes('lb-pick"disabled'), 'disabled attribute present');
    assert(html.includes('>+<'), 'still reads as the same control, not hidden');
});

test('pick control: anchor draws pick number 1, gold class, and the row itself carries lb-row-anchor', () => {
    const html = buildLeaderboardRowHtml(baseRow(), {}, 'playoff', false, { state: 'anchor', number: 1 });
    assert(html.includes('lb-pick lb-pick-on'), 'the on class');
    assert(html.includes('>1<'), 'pick order, not rank');
    assert(html.includes('lb-row-anchor'), 'the row itself is marked, for the caller\'s own styling');
});

test('pick control: a further pick draws its own pick number, no anchor row class', () => {
    const html = buildLeaderboardRowHtml(baseRow(), {}, 'playoff', false, { state: 'picked', number: 3 });
    assert(html.includes('>3<'), 'the third pick reads 3, never the row\'s rank');
    assert(!html.includes('lb-row-anchor'), 'only the anchor\'s own row carries that class');
});

test('header: an empty pick column cell appears only when cols.showPick is set', () => {
    const without = buildLeaderboardHeaderHtml({ cells: [] });
    assert(!without.includes('lb-head-pick'), 'omitted by default, every existing caller unaffected');
    const withIt = buildLeaderboardHeaderHtml({ cells: [], showPick: true });
    assert(withIt.includes('lb-head-pick'), 'rendered when the group feature is wired in');
});

test('cell delta: null delta (not in a group, or the anchor\'s own cell) draws no sub-line', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '24', label: 'R', value: '65', pct: 84, estimated: false, inverse: false, delta: null, better: null }] }));
    assert(!html.includes('lb-cell-delta'), 'no delta markup at all');
});

test('cell delta: a positive delta on a normal category is signed and "up"', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '24', label: 'R', value: '65', pct: 84, estimated: false, inverse: false, delta: 17, better: 'up' }] }));
    assert(html.includes('lb-cell-delta up'), 'the up tone');
    assert(html.includes('>+17<'), 'signed positive');
});

test('cell delta: an INVERSE category with more than the anchor reads "down" even though delta is positive - the bug this split exists to prevent', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '9', label: 'CS', value: '4', pct: 10, estimated: false, inverse: true, delta: 3, better: 'down' }] }));
    assert(html.includes('lb-cell-delta dn'), 'coloured by better, not by the sign of delta');
    assert(html.includes('>+3<'), 'delta is still plain arithmetic, value minus anchor, signed positive');
});

test('cell delta: even reads the word, no sign', () => {
    const html = buildLeaderboardRowHtml(baseRow({ cells: [{ id: '24', label: 'R', value: '65', pct: 84, estimated: false, inverse: false, delta: 0, better: 'even' }] }));
    assert(html.includes('lb-cell-delta ev'), 'the even tone');
    assert(html.includes('>even<'), 'the word, not "+0" or "0"');
});

test('model.isAnchor prints the Anchor tag on the name line; false/absent prints nothing', () => {
    const html = buildLeaderboardRowHtml(baseRow({ isAnchor: true }));
    assert(html.includes('lb-anchor-tag'), 'the tag renders');
    assert(html.includes('>Anchor<'), 'the word');
    const without = buildLeaderboardRowHtml(baseRow());
    assert(!without.includes('lb-anchor-tag'), 'omitted when the model does not say so');
});

test('cell delta: formatDelta, when supplied, formats the number the same way the value itself was formatted', () => {
    const html = buildLeaderboardRowHtml(
        baseRow({ cells: [{ id: '2', label: 'AVG', value: '.267', pct: 40, estimated: false, inverse: false, delta: -0.036, better: 'down' }] }),
        { formatDelta: (v) => Math.abs(v).toFixed(3) }
    );
    assert(html.includes('>-0.036<'), 'the sign this function adds, plus the caller\'s own precision');
});

test('cell delta: formatDelta reaches cellDeltaHtml through resolveOpts, not just a direct call', () => {
    // -0.036 above prints the same whether formatDelta runs or the raw-number fallback does, so it could not have caught resolveOpts silently dropping the option, which it once did, because every other opt is allowlisted there by hand and formatDelta was added to cellDeltaHtml without being added to that list. This value's floating-point tail only the caller's own formatter removes.
    const html = buildLeaderboardRowHtml(
        baseRow({ cells: [{ id: '2', label: 'AVG', value: '.267', pct: 40, estimated: false, inverse: false, delta: 0.033900149000000004, better: 'up' }] }),
        { formatDelta: (v) => v.toFixed(3) }
    );
    assert(html.includes('>+0.034<'), 'the formatter\'s rounded figure, not the raw float');
    assert(!html.includes('0.0339001'), 'the fallback\'s unrounded string must not leak through');
});

// The phone points form: the next game and the games played, a dash when there is none The phone grid: the ring on the headshot and the pinned column's width ---------------------------------------------------------------------------

test('the headshot slot carries the team colour as its ring, only for a hex', () => {
    const withTeam = buildLeaderboardRowHtml(baseRow({ team: { name: 'Fixture Nine', color: '#4363d8', logo: null } }), {}, null);
    assert(withTeam.includes('<span class="lb-avatar-slot" style="--ring:#4363d8">'), 'the ring property on the slot');
    const bad = buildLeaderboardRowHtml(baseRow({ team: { name: 'X', color: 'red; background:url(x)', logo: null } }), {}, null);
    assert(!bad.includes('--ring'), 'a string that is not a hex never reaches the style attribute');
    const none = buildLeaderboardRowHtml(baseRow({ team: null }), {}, null);
    assert(none.includes('<span class="lb-avatar-slot">'), 'a free agent has no ring property');
});

test('the headshot slot carries the rank as a badge, T for a tie, gold for the leader, none for an unranked row', () => {
    const ranked = buildLeaderboardRowHtml(baseRow({ rank: { label: 3, tied: false, gold: false } }), {}, null);
    assert(ranked.includes('<em class="lb-rankbadge">3</em>'), 'the rank on the slot');
    const tied = buildLeaderboardRowHtml(baseRow({ rank: { label: 7, tied: true, gold: false } }), {}, null);
    assert(tied.includes('<em class="lb-rankbadge">T7</em>'), 'a tie reads T7');
    const gold = buildLeaderboardRowHtml(baseRow({ rank: { label: 1, tied: false, gold: true } }), {}, null);
    assert(gold.includes('lb-rankbadge lb-rankbadge-gold'), 'the leader is gold');
    const none = buildLeaderboardRowHtml(baseRow({ rank: null }), {}, null);
    assert(!none.includes('lb-rankbadge'), 'an unranked row has no badge');
});

test('pinnedColumnWidth: the longest name part plus the headshot, the gap and the padding, between a floor and a ceiling', () => {
    // 46 headshot + 8 gap + 16 padding = 70, plus the widest part.
    assertEq(pinnedColumnWidth([60, 72.4, 55]), 143, '70 + 72.4 = 142.4, rounded up');
    assertEq(pinnedColumnWidth([]), 120, 'no names: the floor');
    assertEq(pinnedColumnWidth([30]), 120, '70 + 30 = 100, under the floor');
    assertEq(pinnedColumnWidth([200]), 210, '70 + 200 = 270, held at the ceiling');
    assertEq(pinnedColumnWidth([NaN, 80, null]), 150, 'a part that did not measure is ignored: 70 + 80');
    assertEq(pinnedColumnWidth([80], { photo: 40, gap: 6, pad: 10, min: 100, max: 300 }), 136, 'the drawn defaults are options: 40 + 6 + 10 + 80');
});


test('nextGameCell: a game not yet played is the opponent, the side and the label', () => {
    const away = nextGameCell({ date: 1, dayLabel: 'Sat 4:00PM', opponentAbbrev: 'SJ', home: false, played: false, bye: false });
    assertEq(away, { opponent: 'SJ', away: true, when: 'Sat 4:00PM' }, 'an away game');
    const home = nextGameCell({ date: 1, dayLabel: 'Sun 7:00PM', opponentAbbrev: 'LA', home: true, played: false, bye: false });
    assertEq(home, { opponent: 'LA', away: false, when: 'Sun 7:00PM' }, 'a home game');
});

test('nextGameCell: played, a bye, no date, no opponent and no answer are all a dash', () => {
    const ok = { date: 1, dayLabel: 'Sat 4:00PM', opponentAbbrev: 'SJ', home: true, played: false, bye: false };
    assertEq(nextGameCell(null), null, 'no answer');
    assertEq(nextGameCell({ ...ok, played: true }), null, 'a game already played');
    assertEq(nextGameCell({ ...ok, bye: true }), null, 'a club with no game in the matchup');
    assertEq(nextGameCell({ ...ok, date: null }), null, 'no date');
    assertEq(nextGameCell({ ...ok, opponentAbbrev: null }), null, 'no opponent');
    assertEq(nextGameCell({ ...ok, dayLabel: null }), null, 'no label');
});

test('gameDayTime: a short weekday and the time with no space before the meridiem, in the named zone', () => {
    // T20:00:00Z is 16:00 in New York (EDT, UTC-4) and 13:00 in Los Angeles (PDT, UTC-7).
    const ms = Date.UTC(2026, 9, 10, 20, 0);
    assertEq(gameDayTime(ms, { locale: 'en-US', timeZone: 'America/New_York' }), 'Sat 4:00PM', 'New York');
    assertEq(gameDayTime(ms, { locale: 'en-US', timeZone: 'America/Los_Angeles' }), 'Sat 1:00PM', 'Los Angeles');
    // T00:30:00Z is 20:30 on Saturday in New York: the local weekday, not the UTC one.
    assertEq(gameDayTime(Date.UTC(2026, 9, 11, 0, 30), { locale: 'en-US', timeZone: 'America/New_York' }), 'Sat 8:30PM', 'across UTC midnight');
    assertEq(gameDayTime(null), null, 'no value');
});

test('the row: a model with nextGame draws the badge, the split games figure and the next-game cells', () => {
    const html = buildLeaderboardRowHtml(
        baseRow({ posLabel: 'RW', gpLabel: '4 GP', proAbbrev: 'EDM', nextGame: { opponent: 'SJ', away: true, when: 'Sat 4:00PM' }, total: 21.4, ptsPerGame: 5.35 }),
        {}, null);
    assert(html.includes('<span class="lb-posbadge">RW</span>'), 'the position badge');
    assert(html.includes('EDM &middot; RW') || html.includes('EDM · RW'), 'the club and position lead the meta line');
    assert(html.includes('<span class="lb-meta-gp"> · 4 GP</span>'), 'the games figure is its own span');
    assert(html.includes('<span class="lb-next-opp">@SJ</span><span class="lb-next-when">Sat 4:00PM</span>'), 'the away prefix and the label');
    assert(html.includes('<div class="lb-gp">4</div>'), 'the games played as its own cell');
});

test('the row: nextGame null is a dash, never a sentence', () => {
    const html = buildLeaderboardRowHtml(baseRow({ gpLabel: '12 GP', nextGame: null }), {}, null);
    assert(html.includes('<div class="lb-next lb-next-none">-</div>'), 'a dash');
    assert(html.includes('<div class="lb-gp">12</div>'), 'the games played still print');
    assert(!/no game|none left|not scheduled/i.test(html), 'no sentence about it');
});

test('the row: nextGame absent leaves the row exactly as it was', () => {
    const html = buildLeaderboardRowHtml(baseRow({ gpLabel: '12 GP' }), {}, null);
    assert(!html.includes('lb-next') && !html.includes('lb-gp') && !html.includes('lb-posbadge') && !html.includes('lb-meta-gp'), 'no phone-form element');
    assert(html.includes('12 GP'), 'the games figure stays in the meta line as before');
});

test('the header: showNextGame adds the five phone labels and only then', () => {
    const on = buildLeaderboardHeaderHtml({ showNextGame: true, showPtsPerGame: true }, {});
    assert(on.includes('lb-head-phone'), 'the phone group');
    ['Opp', 'FPts', 'FP/G', 'GP', 'Rank'].forEach(l => assert(on.includes('>' + l), 'the label ' + l));
    assert(on.includes('data-sort="ptsPerGame"') && on.includes('data-sort="rank"'), 'FPts and Rank sort on the keys the desktop header uses');
    assert(!buildLeaderboardHeaderHtml({ showPtsPerGame: true }, {}).includes('lb-head-phone'), 'absent without the flag');
});

// The compare palette. Hand-computed from the offsets 0, 180, 90, 270, 45, 225 on an accent hue of 212.
test('the compare palette is the accent rotated, in pick order', () => {
    const pal = comparePalette({ h: 212, s: 0.9, l: 0.65 }, 6);
    assertEq(pal.map(c => c.h), [212, 32, 302, 122, 257, 77], 'hues in pick order');
    assertEq(pal[0].css, 'hsl(212 90% 65%)', 'the first is the accent itself');
});

test('three players are at least 90 degrees apart and six at least 45', () => {
    const minDist = (n, accent) => {
        const hs = comparePalette({ h: accent, s: 0.7, l: 0.6 }, n).map(c => c.h);
        let m = 360;
        for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) m = Math.min(m, hueDistance(hs[i], hs[j]));
        return m;
    };
    [212, 45, 340, 0].forEach(a => {
        assertEq(minDist(3, a), 90, 'three apart, accent ' + a);
        assertEq(minDist(6, a), 45, 'six apart, accent ' + a);
    });
    assertEq(hueDistance(350, 10), 20, 'the short way round the wheel');
});

test('the palette holds its saturation and lightness inside a legible range', () => {
    const pal = comparePalette({ h: 40, s: 0.1, l: 0.95 }, 2);
    assert(pal.every(c => c.s >= 0.5 && c.s <= 0.9 && c.l >= 0.45 && c.l <= 0.7), 'clamped');
    assertEq(comparePalette({ h: 0, s: 0.7, l: 0.6 }, 0), [], 'no players, no colours');
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
