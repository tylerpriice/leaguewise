// Unit tests for the pure preseason snapshot (preseason-snapshot.js, O21). Open tests/preseason-snapshot.test.html through any static server - green means every assertion held. Every expected value is hand-computed from tests/fixtures/preseason-snapshot.md.
import { snapshotKey, staleKeys, shouldTake, buildSnapshot, preseasonLineFor, isPreseasonSnapshot } from '../preseason-snapshot.js';

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

// ==== The key ====

test('the key carries sport and season, because a league id is unique across neither', () => {
    assertEq(snapshotKey('ffl', 699939233, 2026), 'preseason:ffl:699939233:2026', 'football 2026');
    // The same league id in another sport and another year must not collide - the O2 trap, where one sport's map read as another's and printed a plausible wrong answer.
    assert(snapshotKey('flb', 699939233, 2026) !== snapshotKey('ffl', 699939233, 2026), 'sport separates');
    assert(snapshotKey('ffl', 699939233, 2025) !== snapshotKey('ffl', 699939233, 2026), 'season separates');
});

// ==== When to take one ====

test('shouldTake: only before a game is played', () => {
    assertEq(shouldTake('pre-draft', null), true, 'a league that has not drafted');
    assertEq(shouldTake('post-draft-preseason', null), true, 'drafted, not yet played');
    assertEq(shouldTake('underway', null), false, 'a league in progress has no preseason line left');
});

test('shouldTake: an existing snapshot is NEVER replaced', () => {
    // The whole point. A second write once play has started would store the rest-of-season line under a key that reads as a preseason projection - silently wrong, and worse than absent.
    assertEq(shouldTake('pre-draft', { players: {} }), false, 'even in preseason');
    assertEq(shouldTake('post-draft-preseason', { players: {} }), false, 'even drafted and unplayed');
});

// ==== Retention ====

test('staleKeys: keeps this season and the one before, drops older', () => {
    const keys = [
        'preseason:ffl:1:2023', 'preseason:ffl:1:2024',
        'preseason:ffl:1:2025', 'preseason:ffl:1:2026'
    ];
    assertEq(staleKeys(keys, 'ffl', 1, 2026), ['preseason:ffl:1:2023', 'preseason:ffl:1:2024'],
        '2025 and 2026 survive');
});

test('staleKeys: scoped to THIS league, never another', () => {
    // A retention pass reaching across leagues would delete another league's only snapshot on the day this one happened to be opened - and that one is not replaceable.
    const keys = ['preseason:ffl:1:2020', 'preseason:ffl:2:2020', 'preseason:flb:1:2020'];
    assertEq(staleKeys(keys, 'ffl', 1, 2026), ['preseason:ffl:1:2020'], 'only this league and sport');
});

test('staleKeys: a key it does not understand is left alone', () => {
    // Deleting something unrecognised is how a stray format becomes lost data.
    const keys = ['preseason:ffl:1:notayear', 'sport', 'preseason:ffl:1:2019'];
    assertEq(staleKeys(keys, 'ffl', 1, 2026), ['preseason:ffl:1:2019'], 'only the parseable old one');
});

test('staleKeys: no season to compare against drops nothing', () => {
    assertEq(staleKeys(['preseason:ffl:1:2019'], 'ffl', 1, undefined), [], 'nothing is stale yet');
});

// ==== What is stored ====

const POOL = [
    { id: 11, projectedTotals: { '5': 40.123456, '20': 100, '99': 7 } },   // 99 is not scored
    { id: 12, projectedTotals: { '5': 12.9995, '20': 60 } },
    { id: 13, projectedTotals: { '99': 3 } },                              // nothing scored
    { id: 14, projectedTotals: {} },                                       // no line at all
    { id: 15 }                                                             // no projection field
];
const SCORED = ['5', '20'];

test('buildSnapshot: only the league\'s scored ids, and only players who have one', () => {
    const s = buildSnapshot(POOL, SCORED, { sport: 'flb', leagueId: 7, seasonId: 2026 });
    assertEq(Object.keys(s.players).sort(), ['11', '12'], 'the two players with a scored line');
    assertEq(s.players['11'], { '5': 40.123, '20': 100 }, 'id 99 is dropped - no surface reads it');
    assertEq(s.ids, ['5', '20'], 'the ids are recorded with the snapshot');
});

test('buildSnapshot: three decimals, because no surface prints more', () => {
    const s = buildSnapshot(POOL, SCORED, { state: 'pre-draft' });
    assertEq(s.players['11']['5'], 40.123, 'truncated from 40.123456');
    assertEq(s.players['12']['5'], 13, 'and 12.9995 rounds up rather than truncating');
});

test('buildSnapshot: nothing to store answers NULL, never an empty shape', () => {
    // A stored {} reads as "we took one and the league had nobody", which does not happen - and it would stop a later attempt that could have succeeded.
    assertEq(buildSnapshot([], SCORED, {}), null, 'an empty pool');
    assertEq(buildSnapshot([{ id: 13, projectedTotals: { '99': 3 } }], SCORED, {}), null, 'nobody scored');
    assertEq(buildSnapshot(POOL, [], {}), null, 'a league that scores nothing');
    assertEq(buildSnapshot(null, SCORED, {}), null, 'no pool at all');
});

test('buildSnapshot: the period it was taken at travels with it', () => {
    // So a reader can tell a genuine preseason capture from one a future bug took after play began.
    const s = buildSnapshot(POOL, SCORED, { sport: 'ffl', leagueId: 9, seasonId: 2026, scoringPeriodId: 0, takenAt: 1234 });
    assertEq([s.sport, s.leagueId, s.seasonId, s.scoringPeriodId, s.takenAt], ['ffl', 9, 2026, 0, 1234], 'the provenance');
});

test('buildSnapshot: a zero is a real projection and is kept', () => {
    // Distinct from absent. A kicker projected for no 50-yard field goals is a fact; dropping it would make the row indistinguishable from a player the snapshot never saw.
    const s = buildSnapshot([{ id: 21, projectedTotals: { '5': 0, '20': 3 } }], SCORED, {});
    assertEq(s.players['21'], { '5': 0, '20': 3 }, 'the zero survives');
});

// ==== The read guard - refusing a snapshot that is not one ====

test('isPreseasonSnapshot: only a snapshot taken before play counts', () => {
    assertEq(isPreseasonSnapshot({ takenInState: 'pre-draft' }), true, 'taken before the draft');
    assertEq(isPreseasonSnapshot({ takenInState: 'post-draft-preseason' }), true, 'drafted, unplayed');
    assertEq(isPreseasonSnapshot({ takenInState: 'underway' }), false, 'taken mid-season is not one');
});

test('isPreseasonSnapshot: a snapshot that cannot prove when it was taken FAILS CLOSED', () => {
    // Written by an older build, or restored from elsewhere. shouldTake refuses to WRITE one late; nothing can un-write one that is already there, so the reader refuses it instead.
    assertEq(isPreseasonSnapshot({ players: {} }), false, 'no state recorded');
    assertEq(isPreseasonSnapshot({ takenInState: 'something-else' }), false, 'an unrecognised state');
    assertEq(isPreseasonSnapshot(null), false, 'no snapshot');
});

test('preseasonLineFor: a mid-season snapshot yields NOTHING, however complete it looks', () => {
    // This is the case staging the read path exposed: a snapshot built from a played pool carries the REST-OF-SEASON line, and printing it as "before the season" is a confident wrong answer rather than a missing one. The line is refused whole, not per player.
    const late = buildSnapshot(POOL, SCORED, { state: 'underway' });
    assert(Object.keys(late.players).length > 0, 'it does carry players');
    assertEq(preseasonLineFor(late, 11), null, 'and not one of them is readable');
    const good = buildSnapshot(POOL, SCORED, { state: 'pre-draft' });
    assert(preseasonLineFor(good, 11) !== null, 'while a real one reads back');
});

// ==== Reading one back ====

test('preseasonLineFor: a player the snapshot never saw is null, not empty', () => {
    const s = buildSnapshot(POOL, SCORED, { state: 'pre-draft' });
    assertEq(preseasonLineFor(s, 11), { '5': 40.123, '20': 100 }, 'a player it carries');
    // A mid-season pickup who was not in the pool when it was taken. Real and common, not an error.
    assertEq(preseasonLineFor(s, 999), null, 'a player it does not');
    assertEq(preseasonLineFor(null, 11), null, 'no snapshot at all');
    assertEq(preseasonLineFor(s, null), null, 'no player');
});

test('preseasonLineFor: the id is read as a string, whichever way it arrives', () => {
    const s = buildSnapshot(POOL, SCORED, { state: 'pre-draft' });
    assertEq(preseasonLineFor(s, '11'), preseasonLineFor(s, 11), 'a string and a number agree');
});

// Report ---------------------------------------------------------------------------
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
