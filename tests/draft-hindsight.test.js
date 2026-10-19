// Unit tests for how the picks fared (draft-hindsight.js). Open tests/draft-hindsight.test.html through any static server; green means every assertion held. Every row and summary is computed by hand in tests/fixtures/draft-hindsight.md, never from a run of this module. Every id, value and pace is invented.
import { hindsightRows, teamHindsight } from '../src/engines/draft-hindsight.js';

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

const FIX = await (await fetch('fixtures/draft-hindsight.json')).json();
const pacingFor = (playerId) => FIX.pace[String(playerId)] || null;
const OPTS = { values: FIX.values, pacingFor, drafted: FIX.drafted, played: FIX.played };
const ROWS = hindsightRows(FIX.picks, OPTS);

test('the rows are the picks, the placeholder dropped, in overall order', () => {
    assertEq(ROWS.length, 12, 'thirteen picks in, the -1 placeholder out');
    assertJson(ROWS.map(r => r.overall), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'in draft order');
    assertEq(ROWS.some(r => r.playerId === -1), false, 'the grid placeholder is never a pick');
});

test('every row as hand-computed', () => {
    FIX.rows.forEach((want, i) => assertJson(ROWS[i], want, `row ${i + 1} (overall ${want.overall})`));
});

test('the slot gap is the pick number less the rank, positive when the pick is doing better', () => {
    const at = o => ROWS.find(r => r.overall === o);
    assertEq(at(11).slotGap, 5, 'picked 11th, producing like the 6th');
    assertEq(at(2).slotGap, -5, 'picked 2nd, producing like the 7th');
    assertEq(at(1).slotGap, 0, 'the first pick producing like the first');
});

test('a keeper is marked and ungraded, and still carries its value and pace', () => {
    const keeper = ROWS.find(r => r.keeper);
    assertJson([keeper.playerId, keeper.slotGap, keeper.rank, keeper.pace.dir], [9003, null, 2, 'over'],
        'the slot is a league rule, the production is not');
});

test('a player the pool does not carry keeps the row and states it', () => {
    const missing = ROWS.find(r => r.playerId === 9004);
    assertJson([missing.inPool, missing.value, missing.rank, missing.total, missing.games, missing.slotGap],
        [false, null, null, null, null, null], 'the face prints the id rather than shortening the round');
    assertEq(missing.round, 1, 'the pick itself still reads');
});

test('a negative id is a real pick, not a placeholder', () => {
    const dst = ROWS.find(r => r.playerId === -16033);
    assertJson([dst.inPool, dst.rank, dst.slotGap], [true, 9, 0], 'football D/ST carry negative ids');
});

test('an unranked player is ungraded rather than graded at zero', () => {
    const unranked = ROWS.find(r => r.playerId === 9010);
    assertJson([unranked.inPool, unranked.value, unranked.rank, unranked.slotGap], [true, 12, null, null],
        'in the pool, below the minimum-games rule');
});

// The row says ungraded itself. By hand over the twelve rows: 9010 alone is in the pool with no rank and no keeper mark; the keeper (9003, ranked 2) and the pick outside the pool (9004) are each excluded by their own word, and the other nine have a rank.
test('ungraded is in the pool, not a keeper and no rank, and nothing else', () => {
    assertJson(ROWS.filter(r => r.ungraded).map(r => r.playerId), [9010], 'one pick of twelve');
    assertEq(ROWS.find(r => r.playerId === 9003).ungraded, false, 'a keeper is excluded by rule, not ungraded');
    assertEq(ROWS.find(r => r.playerId === 9004).ungraded, false, 'a pick outside the pool says so with inPool');
    assertEq(ROWS.every(r => typeof r.ungraded === 'boolean'), true, 'always a boolean, never absent');
});

// Football: no games stat, so the caller hands games as null. The ranked pick is graded and the unranked one is not, and neither answer rests on the games figure.
test('ungraded reads the rank, never the games: a sport with no games count still grades', () => {
    const picks = [
        { playerId: 1, teamId: 1, roundId: 1, roundPickNumber: 1, overallPickNumber: 1 },
        { playerId: 2, teamId: 2, roundId: 1, roundPickNumber: 2, overallPickNumber: 2 },
        { playerId: 3, teamId: 1, roundId: 2, roundPickNumber: 1, overallPickNumber: 3, keeper: true }
    ];
    const values = {
        1: { value: 30.5, rank: 4, total: 50, tied: false, games: null },
        2: { value: null, rank: null, total: 50, tied: false, games: null },
        3: { value: null, rank: null, total: 50, tied: false, games: null }
    };
    const rows = hindsightRows(picks, { values, drafted: true, played: true });
    assertJson(rows.map(r => [r.games, r.rank, r.slotGap, r.ungraded]),
        [[null, 4, -3, false], [null, null, null, true], [null, null, null, false]],
        'pick 1 at rank 4 is graded 1 - 4; the unranked pick is ungraded; the unranked keeper is a keeper');
});

test('no pace is null, never a zero and never a grade', () => {
    const noSnapshot = ROWS.find(r => r.playerId === 9005);
    const underFloor = ROWS.find(r => r.playerId === 9007);
    const football = ROWS.find(r => r.playerId === -16033);
    assertJson([noSnapshot.pace, underFloor.pace, football.pace], [null, null, null], 'three ways to have no pace');
    assertEq(ROWS.find(r => r.playerId === 9008).pace.dir, 'even', 'and even is a word, not a zero');
});

test('picks in any order come back in draft order', () => {
    const shuffled = [...FIX.picks].reverse();
    assertJson(hindsightRows(shuffled, OPTS), ROWS, 'the order in is not the order out');
});

test('a pick with no overall number sorts last, keeping its round', () => {
    const rows = hindsightRows([...FIX.picks, { playerId: 9020, teamId: 1, roundId: 4, roundPickNumber: 2 }], OPTS);
    const last = rows[rows.length - 1];
    assertJson([last.playerId, last.overall, last.round, last.roundPick, last.slotGap], [9020, null, 4, 2, null],
        'no figure is not the first pick of the draft');
});

test('an undrafted league has no results, whatever its grid holds', () => {
    assertJson(hindsightRows(FIX.picks, { ...OPTS, drafted: false }), [], 'the grid is not results');
    assertJson(hindsightRows(FIX.picks, { ...OPTS, drafted: undefined }), [], 'nor is an absent flag');
});

// A league that has drafted and not played has nothing to grade a slot against.
test('a drafted league that has not played has no rows, whatever its values say', () => {
    assertJson(hindsightRows(FIX.picks, { ...OPTS, played: false }), [], 'drafted, not played');
    assertJson(hindsightRows(FIX.picks, { ...OPTS, played: undefined }), [], 'an absent flag is not a yes');
    assertJson(hindsightRows(FIX.picks, { values: FIX.values, pacingFor, drafted: true }), [], 'omitted entirely');
    assertJson(hindsightRows(FIX.picks, { ...OPTS, played: 1 }), [], 'truthy is not true');
    assertJson(hindsightRows(FIX.picks, { ...OPTS, drafted: false, played: true }), [], 'played cannot stand in for drafted');
});

test('no picks, or none of the shape, gives no rows', () => {
    assertJson(hindsightRows([], OPTS), [], 'empty');
    assertJson(hindsightRows(null, OPTS), [], 'null');
    assertJson(hindsightRows(undefined, OPTS), [], 'undefined');
    assertJson(hindsightRows([{ playerId: -1, overallPickNumber: 1 }], OPTS), [], 'a grid of placeholders');
});

test('values as a Map reads the same as an object', () => {
    const asMap = new Map(Object.entries(FIX.values));
    assertJson(hindsightRows(FIX.picks, { ...OPTS, values: asMap }), ROWS, 'either shape');
});

test('no values at all leaves every row ungraded rather than wrong', () => {
    const rows = hindsightRows(FIX.picks, { pacingFor, drafted: true, played: true });
    assertEq(rows.length, 12, 'the picks still read');
    assertEq(rows.every(r => r.inPool === false && r.slotGap === null), true, 'nothing is graded on nothing');
});

// ==== per team ====

const TEAMS = teamHindsight(ROWS, { teams: FIX.teams });

test('the team summaries as hand-computed', () => {
    assertJson(TEAMS, FIX.teamRows, 'four teams, three picks each');
});

test('graded says what the total covers, and it is not every pick', () => {
    const t = id => TEAMS.find(r => r.teamId === id);
    assertJson([t(2).picks, t(2).graded], [3, 2], 'the unranked pick is not in the total');
    assertJson([t(3).picks, t(3).graded], [3, 2], 'nor is the keeper');
    assertJson([t(4).picks, t(4).graded], [3, 2], 'nor is the player outside the pool');
});

test('a tie for best or worst takes the earlier pick', () => {
    // Team 1 holds two rows at a slot gap of 0: the first pick and the D/ST at ninth.
    assertJson(TEAMS.find(r => r.teamId === 1).worst, { playerId: 9001, slotGap: 0 }, 'the earlier of the two');
});

test('a team whose picks are none of them graded has no best or worst', () => {
    const rows = hindsightRows([
        { playerId: 9004, teamId: 7, roundId: 1, roundPickNumber: 1, overallPickNumber: 1 },
        { playerId: 9010, teamId: 7, roundId: 2, roundPickNumber: 1, overallPickNumber: 2 }
    ], OPTS);
    assertJson(teamHindsight(rows, { teams: FIX.teams }), [{
        teamId: 7, name: null, picks: 2, graded: 0, slotGapTotal: 0, best: null, worst: null, over: 0, under: 0, even: 0
    }], 'a team the list does not name, with nothing to grade');
});

test('teams appear in the order their first pick did, and none is invented', () => {
    assertJson(TEAMS.map(t => t.teamId), [1, 2, 3, 4], 'first-seen order');
    assertJson(teamHindsight([], { teams: FIX.teams }), [], 'no rows, no teams');
    assertJson(teamHindsight(null, {}), [], 'nothing at all');
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
