// Unit tests for the category spread (category-spread.js). Open tests/category-spread.test.html through any static server; green means every assertion held. Every expected value is hand-computed in tests/fixtures/category-spread.md, never from a run of the module.
import { categorySpread } from '../src/engines/category-spread.js';

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

const FIX = await (await fetch('fixtures/category-spread.json')).json();
const SPREAD = categorySpread({ categories: FIX.categories, teams: FIX.teams, readerTeamId: FIX.readerTeamId });
const track = (id) => SPREAD.find(c => c.id === id);
const byTeam = (t) => Object.fromEntries(t.dots.map(d => [d.teamId, d]));

test('one entry per category, in the categories\' own order', () => {
    assertJson(SPREAD.map(c => c.id), ['G', 'GAA', 'PIM', 'SV', 'A'], 'order');
    assertJson(SPREAD.map(c => c.label), ['G', 'GAA', 'PIM', 'SV', 'A'], 'labels');
});

test('a normal track: best at 1, and a tie above the reader names both', () => {
    const g = track('G');
    assertEq(g.low, 0, 'low');
    assertEq(g.high, 8, 'high');
    assertEq(g.level, false, 'not level');
    assertJson(g.dots.map(d => d.at), [0.75, 1, 0.25, 1, 0], 'at is value / 8, in the teams\' order');
    assertJson(g.dots.map(d => d.role), ['reader', 'above', 'below', 'above', 'other'], 'roles');
    assertEq(byTeam(g)[104].value, 8, 'the value rides with the dot, for the tooltip');
    assertJson(g.missing, [], 'nobody missing');
});

test('an inverse track: flipped once here, the best end is LOW', () => {
    const gaa = track('GAA');
    assertEq(gaa.inverse, true, 'inverse carried');
    assertEq(gaa.low, 2, 'low stays the raw smallest');
    assertEq(gaa.high, 4, 'high the raw largest');
    const d = byTeam(gaa);
    assertEq(d[102].at, 1, 'the lowest value is at the best end');
    assertEq(d[103].at, 0, 'the highest at the worst');
    assertEq(d[101].at, 0.5, 'the reader in the middle');
});

test('a team level WITH the reader is its own role, level', () => {
    // A team level with the reader is the closest race on the track, so it has a role of its own.
    const d = byTeam(track('GAA'));
    assertEq(d[105].at, d[101].at, '105 sits exactly on the reader');
    assertEq(d[105].role, 'level', 'so it is level, not above, below or other');
    assertEq(d[102].role, 'above', 'the nearest better');
    assertEq(d[103].role, 'below', 'the nearest worse');
});

test('a missing figure is off the track and counted, never drawn at zero', () => {
    const gaa = track('GAA');
    assertJson(gaa.missing, [104], '104\'s null is missing');
    assertEq(gaa.dots.some(d => d.teamId === 104), false, 'and has no dot');
    assertEq(gaa.dots.length, 4, 'four dots');
});

test('a level track says so: every dot in the middle, every team level with the reader', () => {
    const pim = track('PIM');
    assertEq(pim.level, true, 'level');
    assertJson(pim.dots.map(d => d.at), [0.5, 0.5, 0.5, 0.5, 0.5], 'all at 0.5');
    assertJson(pim.dots.map(d => d.role), ['reader', 'level', 'level', 'level', 'level'], 'the reader ringed, everyone level with it');
    assertEq(pim.low, 5, 'low');
    assertEq(pim.high, 5, 'and high the same');
});

test('the reader missing from ONE track leaves that track all other, and no other track', () => {
    const sv = track('SV');
    assertJson(sv.missing, [101], 'the reader is the missing one');
    assertJson(sv.dots.map(d => d.at), [0, 0.25, 0.5, 1], 'at is value / 4');
    assertJson(sv.dots.map(d => d.role), ['other', 'other', 'other', 'other'], 'nobody is above a reader who is not there');
    assertEq(byTeam(track('G'))[101].role, 'reader', 'while the reader is still ringed on G');
});

test('the reader tied with one team while two more are tied just above', () => {
    // A: 101 and 102 on 4, 103 and 104 on 6, 105 on 2. low 2, high 6, at = (value - 2) / 4.
    const a = track('A');
    assertJson(a.dots.map(d => d.at), [0.5, 0.5, 1, 1, 0], 'at');
    assertJson(a.dots.map(d => d.role), ['reader', 'level', 'above', 'above', 'below'], 'level beside, both tied above named, below');
    // The level team does not stop the neighbours being found: above is still the nearest BETTER value.
});

test('no reader, or a reader not in the league, makes every dot other', () => {
    const none = categorySpread({ categories: FIX.categories, teams: FIX.teams });
    assertEq(none.every(c => c.dots.every(d => d.role === 'other')), true, 'no reader given, and nobody is level with nobody');
    const stranger = categorySpread({ categories: FIX.categories, teams: FIX.teams, readerTeamId: 999 });
    assertEq(stranger.every(c => c.dots.every(d => d.role === 'other')), true, 'a reader not on any track');
    const asString = categorySpread({ categories: FIX.categories, teams: FIX.teams, readerTeamId: '101' });
    assertEq(byTeam(asString[0])[101].role, 'reader', 'an id as a string still finds the reader');
});

test('a figure is a finite number and nothing else', () => {
    const got = categorySpread({
        categories: [{ id: 'X', label: 'X' }],
        teams: [
            { id: 1, totals: { X: NaN } },
            { id: 2, totals: { X: '5' } },
            { id: 3, totals: { X: 1 } },
            { id: 4, totals: { X: 3 } },
            { id: 5, totals: { X: null } },
            { id: 6 }
        ],
        readerTeamId: 3
    })[0];
    assertJson(got.missing, [1, 2, 5, 6], 'NaN, a string, null and no totals at all are all missing');
    assertJson(got.dots.map(d => [d.teamId, d.at, d.role]), [[3, 0, 'reader'], [4, 1, 'above']], 'the two figures');
    assertEq(got.inverse, false, 'no inverse flag reads as not inverse');
});

test('the empty and broken shapes', () => {
    assertJson(categorySpread(), [], 'no arguments');
    assertJson(categorySpread({ categories: 'nope', teams: FIX.teams }), [], 'categories not an array');
    assertJson(categorySpread({ categories: [{ label: 'no id' }], teams: FIX.teams }), [], 'a category with no id is dropped');
    const empty = categorySpread({ categories: [{ id: 'G' }], teams: [{ id: 1, totals: {} }] })[0];
    assertEq(empty.low, null, 'no figures: low is null');
    assertEq(empty.high, null, 'and high');
    assertEq(empty.level, false, 'and it is not level - there is nothing to be level');
    assertJson(empty.dots, [], 'no dots');
    assertJson(empty.missing, [1], 'the team counted as missing');
    assertEq(empty.label, 'G', 'the label falls back to the id');
    const skipped = categorySpread({ categories: [{ id: 'G' }], teams: [{ totals: { G: 1 } }, null] })[0];
    assertJson([skipped.dots, skipped.missing], [[], []], 'a team with no id, and a null team, are skipped entirely');
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
