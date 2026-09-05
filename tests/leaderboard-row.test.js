// Unit tests for the pure leaderboard row/header builder (leaderboard-row.js). Open tests/leaderboard-row.test.html through any static server (file:// won't work for ES modules) - green means every assertion held. See tests/fixtures/leaderboard-row.md for the frozen contract these values are computed against.
import { buildLeaderboardRowHtml, buildLeaderboardHeaderHtml, escapeHtmlLocal } from '../leaderboard-row.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A minimal ordinary row - full identity, ranked solo, one tinted cell, a settled dial.
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
    assert(html.includes('Jahmyr Gibbs'), 'name renders');
    assert(html.includes('DET · RB · 14 GP'), 'full three-part meta line');
    const noGp = buildLeaderboardRowHtml(baseRow({ gpLabel: null }));
    assert(noGp.includes('DET · RB'), 'two-part meta line with gpLabel omitted');
    assert(!noGp.includes('DET · RB ·'), 'no dangling separator when the third segment is dropped');
});

test('identity: every row carries the compare trigger (B18 item 2, the row-level affordance)', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(html.includes('<button type="button" class="lb-compare-trigger"'), 'the row-hover compare icon renders');
    assert(html.includes('data-tooltip="Compare Jahmyr Gibbs with another player"'), 'the tooltip names the player');
    const hostile = buildLeaderboardRowHtml(baseRow({ name: '<img src=x onerror=alert(1)>' }));
    assert(hostile.includes('&lt;img src=x onerror=alert(1)&gt; with another player'), 'a hostile name is escaped in the trigger\'s own tooltip too');
});

// ==== R1/S49: preseason has nothing for a drill-down to show ("useless" - the owner's own word), so the row draws no affordance for the click that would open one - no compare trigger, no hover cursor. `interactive` defaults true (every existing test above and below is unaffected); the caller states `false` for the one season state with nothing to open. ====

test('B221 R1/S49: interactive:false drops the compare trigger and marks the row inert', () => {
    const html = buildLeaderboardRowHtml(baseRow(), { interactive: false });
    assert(!html.includes('lb-compare-trigger'), 'no compare trigger when the row cannot open anything');
    assert(html.includes('class="lb-row lb-row-inert"'), 'the row carries its own inert marker for the caller\'s CSS');
});

test('B221 R1/S49: interactive omitted (every real season) renders exactly as before - the compare trigger, no inert class', () => {
    const html = buildLeaderboardRowHtml(baseRow());
    assert(html.includes('lb-compare-trigger'), 'the compare trigger still renders with no opt supplied');
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
    // An inverse category (e.g. ERA) already had its percentile flipped by the rank engine before this model existed - a LOW ERA produces a HIGH pct, and any shrinkage for a small sample is already folded in too. A pct of 30 here means "30th percentile", full stop; the builder is pure pass-through from model to --pct, and a builder that re-derived it would render --pct:70 instead, which is the bug this test exists to catch.
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

// item 3.2 - the playoff-window lens. UNEVEN carries the exact worked example tests/fixtures/schedule-insight.md documents (matchups 22/23 at 7 days, 24 folding the pro season's tail in at 18) so the round-length caveat has a real case to prove itself against.
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

// - the "games left" lens (this matchup / next matchup), sharing the playoff column's slot.
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

// item 2/O11 - the rest-of-season lens, replacing Playoffs on the toggle.
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

// S14 - the fourth lens state, a different SHAPE (`{ nights, count }`) than window/next/rest, so it gets its own figure branch.
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

// S18: one copy line, the Rank header's own hover, distinct from the click-to-open explainer.
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
    assert(rowHtml.includes('JAHMYR GIBBS'), 'the supplied escapeHtml reached the rendered HTML');
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
