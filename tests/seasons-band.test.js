// Unit tests for the pure Seasons band builder (seasons-band.js). Open tests/seasons-band.test.html through any static server (file:// won't work for ES modules; python -m http.server is a zero-dependency option) - green means every assertion held. Every expected value here is hand-computed, several of them copied straight off real rows in tests/fixtures/retro-seasons.json (the frozen contract this module renders) so a reader can cross-check a test against the fixture file itself rather than trusting this file alone.
import { buildSeasonsBandHtml, escapeHtmlLocal } from '../seasons-band.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function count(haystack, needle) { return haystack.split(needle).length - 1; }

// A slim hockey stat map, ids matching the fixture's skater/goalie categories - not the real ESPN_STAT_MAPS.fhl import (that would drag state.js into a test that has no need of it), just enough names to prove labels reach the rendered title text.
const STAT_MAP = {
    '13': 'G', '14': 'A', '16': 'PTS', '23': 'FOW', '28': 'HAT', '29': 'SOG',
    '31': 'HIT', '32': 'BLK', '38': 'PPP', '39': 'SHP',
    '1': 'W', '7': 'SO', '10': 'GAA', '11': 'SV%'
};
const SKATER_ORDER = ['13', '14', '16', '23', '28', '29', '31', '32', '38', '39'];
const GOALIE_ORDER = ['1', '7', '10', '11'];

// Otto Haugland (id 900000) verbatim from tests/fixtures/retro-seasons.json: an ordinary season (2025), a tied rank (2026, tied with Tobias Lindqvist-Moe at 321), and an era gap where 2024 carries no hits (31) or blocked shots (32) because the realtime report they ride doesn't reach that far back.
const OTTO_2024 = {
    seasonId: 2024, rank: 344, total: 862, tied: false, games: 77,
    percentiles: { '13': 64.5, '14': 64.5, '16': 59.4, '23': 63.5, '28': 55.5, '29': 65.8, '38': 54.8, '39': 56.3 }
};
const OTTO_2025 = {
    seasonId: 2025, rank: 294, total: 891, tied: false, games: 76,
    percentiles: { '13': 59.1, '14': 76.4, '16': 71.5, '23': 62.8, '28': 78.4, '29': 63.3, '31': 58.6, '32': 77.7, '38': 59.5, '39': 65.9 }
};
const OTTO_2026 = {
    seasonId: 2026, rank: 321, total: 874, tied: true, games: 79,
    percentiles: { '13': 67.5, '14': 57.3, '16': 51.5, '23': 74.1, '28': 58.9, '29': 58.1, '31': 68.8, '32': 77.3, '38': 68.9, '39': 54.1 }
};

// Kaspar Hallowell (id 900077), 2025 row verbatim: played 6 games, excluded by the rank engine's minimum-playing-time gate, so rank is null and percentiles is empty - contract case 3.
const HALLOWELL_2025 = { seasonId: 2025, rank: null, total: 891, tied: false, games: 6, percentiles: {} };

// Julien Fennimore (id 900028) verbatim: no 2024 row at all - contract case 2, an absent season is not a row of zeros, it is not in the array.
const FENNIMORE_SEASONS = [
    { seasonId: 2025, rank: 155, total: 891, tied: false, games: 59, percentiles: { '13': 83.1 } },
    { seasonId: 2026, rank: 190, total: 874, tied: false, games: 58, percentiles: { '13': 71.6 } }
];

// Kaspar Nystrom (id 900189), a goalie: "total" is that group's pool (71/74/69), a fraction of the skater seasons' 862/891/874 - the contract requires the denominator never be borrowed from the wrong role group.
const NYSTROM_2024 = {
    seasonId: 2024, rank: 6, total: 71, tied: false, games: 46,
    percentiles: { '1': 99.9, '7': 99.9, '10': 87.8, '11': 81.2 }
};

test('empty/missing seasons render nothing at all - no header, no empty card', () => {
    assert(buildSeasonsBandHtml(null, STAT_MAP, { categoryOrder: SKATER_ORDER }) === '', 'null seasons');
    assert(buildSeasonsBandHtml(undefined, STAT_MAP, { categoryOrder: SKATER_ORDER }) === '', 'undefined seasons');
    assert(buildSeasonsBandHtml([], STAT_MAP, { categoryOrder: SKATER_ORDER }) === '', 'empty array');
});

test('one row per season, in the order given', () => {
    const html = buildSeasonsBandHtml([OTTO_2024, OTTO_2025, OTTO_2026], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(count(html, 'class="sb-row"') === 3, `expected 3 rows, counted ${count(html, 'class="sb-row"')}`);
    assert(html.includes('Seasons'), 'block head reads Seasons');
    // Rows render in array order, which the contract guarantees is ascending seasonId - the band trusts that rather than re-sorting, so a caller that ever violated it would show up here as 2024 not preceding 2026 in the string.
    assert(html.indexOf('>2024<') < html.indexOf('>2026<'), 'earliest season renders first');
});

test('an absent season is not a row - Fennimore has no 2024, not a zeroed one', () => {
    const html = buildSeasonsBandHtml(FENNIMORE_SEASONS, STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(count(html, 'class="sb-row"') === 2, 'exactly the two seasons present');
    assert(!html.includes('>2024<'), 'no 2024 row exists to render');
    assert(!html.includes('of 862'), '862 was 2024\'s total elsewhere in the fixture - it must not leak in from nowhere');
});

test('ordinary season: rank is the strong figure, "Ranked #N of total"', () => {
    const html = buildSeasonsBandHtml([OTTO_2025], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(html.includes('Ranked <strong class="sb-rank-figure">#294</strong> of 891'), 'exact rank phrase');
    assert(html.includes('76 games'), 'games shown, pluralised');
    assert(!html.includes('T294'), 'not tied, so no T-prefix');
});

test('tied rank renders T-prefix, never the # a solo rank gets', () => {
    const html = buildSeasonsBandHtml([OTTO_2026], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(html.includes('<strong class="sb-rank-figure">T321</strong>'), 'T321, the shared-rank convention');
    assert(!html.includes('>#321<') && !html.includes('#321<'), 'never printed as a solo #321');
});

test('played but not ranked: a dash and why, never an invented rank, never a hidden row', () => {
    const html = buildSeasonsBandHtml([HALLOWELL_2025], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(count(html, 'class="sb-row"') === 1, 'the row exists');
    assert(html.includes('6 games'), 'the games count is why the row is there at all');
    assert(html.includes(String.fromCharCode(8212)), 'a dash stands in for the rank');
    assert(html.includes('not ranked this season'), 'the hover names the reason');
    assert(!/Ranked <strong/.test(html), 'no "Ranked #" phrase - there is no rank to report');
    assert(count(html, 'sb-bar-track') === 0, 'no percentiles means no bars to draw');
});

test('percentile bar width is the rounded percentile, and the title names category + percentile', () => {
    const row = { seasonId: 2026, rank: 50, total: 500, tied: false, games: 70, percentiles: { '13': 82.4 } };
    const html = buildSeasonsBandHtml([row], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(html.includes('style="width:82%"'), 'rounds 82.4 to 82');
    assert(html.includes('title="G: 82nd percentile"'), 'title names the category and an ordinal percentile');
});

test('bars are drawn in categoryOrder, not object insertion or key-sort order', () => {
    // Both keys are numeric strings, so a fallback to plain Object.keys() would ALSO print '13' before '39' (JS reorders integer-like keys ascending regardless of insertion order - the exact gotcha splitStatIdsByRole in utils.js documents). Passing categoryOrder descending is the only way this test can tell "the parameter is honoured" apart from "the browser's default object key order happened to agree".
    const row = { seasonId: 2026, rank: 1, total: 10, tied: false, games: 1, percentiles: { '13': 90, '39': 20 } };
    const html = buildSeasonsBandHtml([row], STAT_MAP, { categoryOrder: ['39', '13'] });
    assert(html.indexOf('width:20%') < html.indexOf('width:90%'), 'category order 39-then-13 is honoured over ascending key order');
});

test('era gap: bars drawn only for the ids present in THAT row, never a fixed set with empties', () => {
    // Otto's 2024 row has 8 categories (no hits/blocks yet); a categoryOrder carrying all 10 must still produce exactly 8 bars, not 10 with two empty ones.
    const html = buildSeasonsBandHtml([OTTO_2024], STAT_MAP, { categoryOrder: SKATER_ORDER });
    assert(count(html, 'sb-bar-track') === 8, `expected 8 bars, counted ${count(html, 'sb-bar-track')}`);
    assert(!html.includes('title="HIT:'), 'hits (31) is absent from 2024, so no HIT bar');
    assert(!html.includes('title="BLK:'), 'blocks (32) is absent from 2024, so no BLK bar');
});

test('total is the row\'s own group pool, not borrowed from another role or season', () => {
    // A goalie's denominator (71) is nowhere near a skater season's (862/891/874) - rendering the wrong one would be silently plausible-looking, which is exactly why this needs its own row.
    const html = buildSeasonsBandHtml([NYSTROM_2024], STAT_MAP, { categoryOrder: GOALIE_ORDER });
    assert(html.includes('of 71'), 'goalie pool size, not a skater one');
    assert(!html.includes('of 862'), 'never the skater total');
});

test('XSS: a category name from statMap renders escaped, never as live markup', () => {
    const hostileMap = { '13': '<script>alert(1)</script>' };
    const row = { seasonId: 2026, rank: 1, total: 10, tied: false, games: 1, percentiles: { '13': 50 } };
    const html = buildSeasonsBandHtml([row], hostileMap, { categoryOrder: ['13'] });
    assert(!html.includes('<script>alert(1)</script>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the escaped form is present instead');
});

test('an id missing from statMap falls back to "Stat <id>" rather than throwing', () => {
    const row = { seasonId: 2026, rank: 1, total: 10, tied: false, games: 1, percentiles: { '999': 60 } };
    const html = buildSeasonsBandHtml([row], {}, { categoryOrder: ['999'] });
    assert(html.includes('title="Stat 999: 60th percentile"'), 'unmapped id names itself');
});

test('escapeHtmlLocal matches the app-wide escaping rules (the fallback when no escapeHtml is passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('a caller-supplied escapeHtml is used in place of the local fallback', () => {
    let calls = 0;
    const spy = (s) => { calls++; return String(s).toUpperCase(); };
    const row = { seasonId: 2026, rank: null, total: 10, tied: false, games: 1, percentiles: {} };
    const html = buildSeasonsBandHtml([row], STAT_MAP, { escapeHtml: spy, categoryOrder: SKATER_ORDER });
    assert(calls > 0, 'the supplied function was actually called');
    assert(html.includes('NOT RANKED THIS SEASON'), 'its output reached the rendered HTML');
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
