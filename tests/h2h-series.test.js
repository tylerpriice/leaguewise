// Unit tests for the head-to-head series matrix (h2h-series.js). Open tests/h2h-series.test.html through any static server; green means every assertion held. Every pair is hand-computed in tests/fixtures/h2h-series.md against the fixture's own schedule of five games.
import { h2hSeriesFor, h2hCellFor } from '../src/engines/h2h-series.js';

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

const PAYLOAD = await (await fetch('fixtures/h2h-series.json')).json();
const ROTO_PAYLOAD = await (await fetch('fixtures/h2h-series-roto.json')).json();

const EXPECT_PAIRS = [
    { aTeamId: '1', bTeamId: '2', aWins: 1, bWins: 1, ties: 0 },
    { aTeamId: '3', bTeamId: '4', aWins: 2, bWins: 0, ties: 0 },
    { aTeamId: '1', bTeamId: '3', aWins: 0, bWins: 1, ties: 0 },
    { aTeamId: '2', bTeamId: '4', aWins: 0, bWins: 0, ties: 1 },
    { aTeamId: '1', bTeamId: '4', aWins: 1, bWins: 0, ties: 0 },
    { aTeamId: '2', bTeamId: '3', aWins: 1, bWins: 0, ties: 0 }
];

test('h2hSeriesFor: every hand-computed pair, in headToHead\'s own order', () => {
    assertJson(h2hSeriesFor(PAYLOAD), EXPECT_PAIRS, 'the six pairs');
});

test('h2hSeriesFor: the postseason game is dropped, not folded into the record', () => {
    const pair = h2hSeriesFor(PAYLOAD).find(p => p.aTeamId === '1' && p.bTeamId === '3');
    assertJson(pair, { aTeamId: '1', bTeamId: '3', aWins: 0, bWins: 1, ties: 0 }, 'team 1 also won the playoff game, and it does not show here');
});

test('h2hSeriesFor: a roto league returns nothing, never a walked schedule', () => {
    assertJson(h2hSeriesFor(ROTO_PAYLOAD), [], 'roto has no matchup schedule');
});

test('h2hSeriesFor: no payload, or a payload with no teams, returns nothing', () => {
    assertJson(h2hSeriesFor(null), [], 'no payload');
    assertJson(h2hSeriesFor({ seasonId: 2026 }), [], 'no teams array');
});

test('h2hCellFor: reads from either side, and answers the same series twice', () => {
    const series = h2hSeriesFor(PAYLOAD);
    assertJson(h2hCellFor(series, '1', '3'), { wins: 0, losses: 1, ties: 0 }, 'team 1 against team 3');
    assertJson(h2hCellFor(series, '3', '1'), { wins: 1, losses: 0, ties: 0 }, 'and the same pair from team 3\'s own side');
    assertJson(h2hCellFor(series, '3', '4'), { wins: 2, losses: 0, ties: 0 }, 'the swept pair');
    assertJson(h2hCellFor(series, '2', '4'), { wins: 0, losses: 0, ties: 1 }, 'the tie');
});

test('h2hCellFor: numeric and string ids answer the same cell', () => {
    const series = h2hSeriesFor(PAYLOAD);
    assertJson(h2hCellFor(series, 1, 4), h2hCellFor(series, '1', '4'), 'coerced the same way');
});

test('h2hCellFor: the diagonal and an absent pair are null, never a fabricated record', () => {
    const series = h2hSeriesFor(PAYLOAD);
    assertEq(h2hCellFor(series, '1', '1'), null, 'a team has no record against itself');
    assertEq(h2hCellFor(series, '1', '9'), null, 'a team not in the series');
    assertEq(h2hCellFor([], '1', '2'), null, 'no series at all');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed: results.length - passed, total: results.length, failures: results.filter(r => !r.ok) };
