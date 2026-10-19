// Unit tests for how a team's place has moved (standings-movement.js). Open tests/standings-movement.test.html through any static server; green means every assertion held. Every figure is computed by hand in tests/fixtures/standings-movement.md, never from a run of the module. Every team and result is invented.
import { standingsSeries, movementFor } from '../src/engines/standings-movement.js';

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

const FIX = await (await fetch('fixtures/standings-movement.json')).json();
const TEAMS = FIX.teamStats;

test('standingsSeries: the cumulative figures, matchup by matchup', () => {
    const s = standingsSeries(TEAMS, { scoring: 'categories' });
    assertJson(s.matchups, [1, 2, 3, 4, 5, 6], 'every matchup, in order');
    Object.keys(FIX.cumulative).forEach(id => assertJson(s.figures[id], FIX.cumulative[id], `team ${id}`));
    assertEq(s.unit, 'wins', 'a category league counts wins');
});

test('standingsSeries: the places, with a tie sharing the better one', () => {
    const s = standingsSeries(TEAMS, { scoring: 'categories' });
    Object.keys(FIX.places).forEach(id => assertJson(s.places[id], FIX.places[id], `team ${id}`));
    // After matchup 1 teams 1 and 3 are level on one win, so both are first and the next is third.
    assertJson([s.places['1'][0], s.places['3'][0], s.places['2'][0], s.places['4'][0]], [1, 1, 3, 3], 'a shared first');
});

test('standingsSeries: through cuts the series, and an empty input gives empty arrays', () => {
    const s = standingsSeries(TEAMS, { scoring: 'categories', through: 3 });
    assertJson(s.matchups, [1, 2, 3], 'cut at three');
    assertJson(s.figures['1'], [1, 2, 2], 'team 1 to matchup 3');
    assertJson(standingsSeries([], {}).matchups, [], 'no teams');
    assertJson(standingsSeries(null, {}).matchups, [], 'no input');
});

test('movementFor: every hand-computed case in the instance', () => {
    FIX.movement.forEach(c => {
        const got = movementFor(TEAMS, { teamId: c.teamId, window: c.window, scoring: 'categories' });
        assertJson(got, c.expect, `team ${c.teamId} over ${c.window}`);
    });
});

test('movementFor: a positive delta is a climb, a negative one a fall', () => {
    const up = movementFor(TEAMS, { teamId: 2, window: 4, scoring: 'categories' });
    const down = movementFor(TEAMS, { teamId: 4, window: 4, scoring: 'categories' });
    assertJson([up.placeThen, up.placeNow, up.delta], [4, 3, 1], 'fourth to third is up one');
    assertJson([down.placeThen, down.placeNow, down.delta], [2, 4, -2], 'second to fourth is down two');
});

test('movementFor: a window covering the whole season has no earlier place', () => {
    const m = movementFor(TEAMS, { teamId: 1, window: 6, scoring: 'categories' });
    assertJson([m.placeThen, m.delta, m.figureThen], [null, null, null], 'nothing to compare with');
    assertEq(m.placeNow, 2, 'and the rest still reads');
    assertJson(m.run, { dir: 'lost', length: 1 }, 'the run too');
});

test('movementFor: a window longer than the season is null, never a zero', () => {
    assertEq(movementFor(TEAMS, { teamId: 1, window: 7, scoring: 'categories' }), null, 'seven over six');
    assertEq(movementFor(TEAMS, { teamId: 1, window: 0, scoring: 'categories' }), null, 'no window');
    assertEq(movementFor(TEAMS, { teamId: 9, window: 4, scoring: 'categories' }), null, 'a team not in the league');
    assertEq(movementFor([], { teamId: 1, window: 1, scoring: 'categories' }), null, 'no teams at all');
});

test('movementFor: the run is the season\'s tail, the same whichever window is picked', () => {
    const lengths = [1, 2, 4, 6].map(w => movementFor(TEAMS, { teamId: 3, window: w, scoring: 'categories' }).run.length);
    assertJson(lengths, [4, 4, 4, 4], 'four in a row, whatever the control says');
    assertJson(movementFor(TEAMS, { teamId: 4, window: 2, scoring: 'categories' }).run, { dir: 'lost', length: 4 }, 'and a losing run reads the same way');
});

test('movementFor: a tie ends a run', () => {
    // Team 1's matchup 4 is a tie, so its run at that point is one tie and stops there.
    const m = movementFor(TEAMS, { teamId: 1, window: 2, scoring: 'categories', through: 4 });
    assertJson(m.run, { dir: 'tied', length: 1 }, 'a tie is its own direction and no run past it');
});

test('movementFor: the leader has no gap above and the last team none below', () => {
    const leader = movementFor(TEAMS, { teamId: 3, window: 4, scoring: 'categories' });
    const bottom = movementFor(TEAMS, { teamId: 4, window: 4, scoring: 'categories' });
    assertEq(leader.gapAbove, null, 'nobody above the leader');
    assertJson(leader.gapBelow, { teamId: '1', amount: 1.5 }, 'and the gap below is in wins');
    assertEq(bottom.gapBelow, null, 'nobody below the last team');
});

test('movementFor: a points league reads its own two fields, not the same one twice', () => {
    const m = movementFor(FIX.pointsTeamStats, { teamId: FIX.pointsExpect.teamId, window: FIX.pointsExpect.window, scoring: 'points' });
    const e = FIX.pointsExpect;
    assertJson([m.unit, m.placeNow, m.placeThen, m.delta], [e.unit, e.placeNow, e.placeThen, e.delta], 'the table is by points');
    assertJson([m.figureNow, m.figureThen], [e.figureNow, e.figureThen], 'the figures are points');
    assertJson(m.run, e.run, 'and the run comes from the RESULT, which is a separate field here');
    assertJson([m.gapAbove, m.gapBelow], [e.gapAbove, e.gapBelow], 'the gaps in points');
});

test('movementFor: handed-in figures override the format, which is the roto path', () => {
    // A roto league has no per-matchup schedule at all, so its caller passes roto points per period.
    const figures = { 11: { 1: 30, 2: 28, 3: 35 }, 12: { 1: 20, 2: 33, 3: 31 } };
    const s = standingsSeries(null, { scoring: 'roto', figures });
    assertEq(s.unit, 'roto points', 'the unit says so');
    assertJson(s.figures['11'], [30, 58, 93], 'summed per period');
    assertJson(s.figures['12'], [20, 53, 84], 'and the other team');
    const m = movementFor(null, { teamId: 11, window: 2, scoring: 'roto', figures });
    assertJson([m.placeNow, m.placeThen, m.delta, m.unit], [1, 1, 0, 'roto points'], 'ahead throughout');
    assertEq(m.run, null, 'a roto league records no match result, so there is no run to report');
});

test('movementFor: a matchup a team did not play holds its place rather than dropping it', () => {
    const withBye = [
        { id: 1, weeklyMatchWins: { 1: 1, 2: 1, 3: 1 } },
        { id: 2, weeklyMatchWins: { 1: 0, 3: 0 } }       // no matchup 2 at all
    ];
    const s = standingsSeries(withBye, { scoring: 'categories' });
    assertJson(s.figures['2'], [0, 0, 0], 'the bye adds nothing and subtracts nothing');
    assertJson(s.places['2'], [2, 2, 2], 'and the place is unchanged by it');
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
