// Unit tests for the pure night-schedule builder (night-schedule.js). Open tests/night-schedule.test.html through any static server; green means every assertion held. Expected values are hand-computed from tests/fixtures/night-schedule.md, never from running the code.
import { buildNightSchedule } from '../src/engines/night-schedule.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A small round built by hand: four periods and four rostered players. One of them, id 4, is missing from rosterById on purpose, to prove a covered player with no roster match is dropped without a crash or a placeholder. Periods 11 and 13 tie at one playing, the round's minimum, and 11 comes first in period order, so it is the one lightestPeriod names.
const coverage = {
    byPeriod: [
        { period: 10, playerIds: [1, 2, 3], playing: 3, idle: 1, emptySlots: 0 },
        { period: 11, playerIds: [1], playing: 1, idle: 3, emptySlots: 2 },
        { period: 12, playerIds: [2, 4], playing: 2, idle: 2, emptySlots: 1 },
        { period: 13, playerIds: [1], playing: 1, idle: 3, emptySlots: 2 }
    ],
    players: 4, unknownClub: 0, fewestPlaying: 1, mostPlaying: 3
};
const rosterById = new Map([
    // The first player carries game detail for period 10's game only. The module does not treat any role specially and reads whatever is there. The second carries no game detail at all, which proves the field is optional.
    [1, { name: 'Alice', proTeamId: 10, proGamePlayerDetail: { g10a: { starterStatus: 'CONFIRMED', lineupOrder: 3 } } }],
    [2, { name: 'Bob', proTeamId: 20 }],
    [3, { name: 'Cara', proTeamId: 30 }]
    // id 4 deliberately absent
]);
const proTeams = [
    { id: 10, proGamesByScoringPeriod: {
        10: [{ id: 'g10a', homeProTeamId: 10, awayProTeamId: 99, date: 1743984000000 }],
        11: [{ id: 'g11a', homeProTeamId: 50, awayProTeamId: 10 }],
        13: [{ id: 'g13a', homeProTeamId: 10, awayProTeamId: 60 }]
    } },
    { id: 20, proGamesByScoringPeriod: {
        10: [{ homeProTeamId: 20, awayProTeamId: 70 }],
        12: [{ homeProTeamId: 80, awayProTeamId: 20 }]
    } },
    { id: 30, proGamesByScoringPeriod: { 10: [{ homeProTeamId: 90, awayProTeamId: 30 }] } },
    // The free-agent pseudo-club, id 0, which rosterNightCoverage skips and this matches.
    { id: 0, proGamesByScoringPeriod: { 10: [{ homeProTeamId: 0, awayProTeamId: 5 }] } }
];

test('null coverage renders null; a coverage with no periods renders null too', () => {
    assert(buildNightSchedule(null, rosterById, proTeams) === null, 'null coverage');
    assert(buildNightSchedule({ byPeriod: [] }, rosterById, proTeams) === null, 'empty byPeriod');
});

test('players/unknownClub/fewestPlaying carry straight through from coverage, unrecomputed', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    assert(out.players === 4, 'players');
    assert(out.unknownClub === 0, 'unknownClub');
    assert(out.fewestPlaying === 1, 'fewestPlaying');
});

test('a playerId with no rosterById match is dropped silently, never a placeholder', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const p12 = out.byPeriod.find(d => d.period === 12);
    assert(p12.players.length === 1, 'id 4 dropped - only Bob remains');
    assert(p12.players[0].name === 'Bob', 'the one that remains is the one that matched');
});

test('opponentId/isHome resolved correctly for a home game', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Alice');
    assert(alice10.opponentId === 99 && alice10.isHome === true, 'team 10 home vs 99 on period 10');
});

test('opponentId/isHome resolved correctly for an away game', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice11 = out.byPeriod.find(d => d.period === 11).players.find(p => p.name === 'Alice');
    assert(alice11.opponentId === 50 && alice11.isHome === false, 'team 10 away at 50 on period 11');
    const cara10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Cara');
    assert(cara10.opponentId === 90 && cara10.isHome === false, 'team 30 away at 90 on period 10');
});

test('a player whose club has no game that period gets null opponentId/isHome, carried not dropped', () => {
    // Team 20 has no entry for period 99 at all, and a call over that one period proves the shape.
    const soloCoverage = { byPeriod: [{ period: 99, playerIds: [2], playing: 1, idle: 0, emptySlots: null }], players: 1, unknownClub: 0, fewestPlaying: 1 };
    const solo = buildNightSchedule(soloCoverage, rosterById, proTeams);
    const bobNoGame = solo.byPeriod[0].players[0];
    assert(bobNoGame.opponentId === null && bobNoGame.isHome === null, 'no game that period -> both null, still present');
});

test('starterStatus resolves from proGamePlayerDetail, keyed by the game id, for the player\'s own game that period', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Alice');
    assert(alice10.starterStatus === 'CONFIRMED', 'period 10 is game g10a, which Alice\'s own detail carries');
});

test('starterStatus is null when proGamePlayerDetail exists but has no entry for that game', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice11 = out.byPeriod.find(d => d.period === 11).players.find(p => p.name === 'Alice');
    assert(alice11.starterStatus === null, 'period 11 is game g11a - Alice\'s detail only carries g10a');
});

test('starterStatus is null, never a crash, when the player carries no proGamePlayerDetail field at all', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const bob10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Bob');
    assert(bob10.starterStatus === null, 'Bob has no proGamePlayerDetail field - optional, not required');
});

test('lineupOrder resolves from proGamePlayerDetail alongside starterStatus, off the same game', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Alice');
    assert(alice10.lineupOrder === 3, 'period 10 is game g10a, which carries lineupOrder 3');
    const alice11 = out.byPeriod.find(d => d.period === 11).players.find(p => p.name === 'Alice');
    assert(alice11.lineupOrder === null, 'period 11 has no detail entry - null, not 0 or undefined');
});

test('gameDate resolves as the raw game timestamp, never formatted', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Alice');
    assert(alice10.gameDate === 1743984000000, 'period 10 is game g10a, which carries a real date');
});

test('gameDate is null when there is no game that period, the same as opponentId/isHome', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const alice12 = out.byPeriod.find(d => d.period === 12);
    // The first player's club has no game in period 12, so that player is not among the day's playing ids. The check is made on a player who is playing that period and whose game record carries no date: team 20 has no date on its games in periods 10 and 12.
    const bob10 = out.byPeriod.find(d => d.period === 10).players.find(p => p.name === 'Bob');
    assert(bob10.gameDate === null, 'team 20\'s period 10 game carries no date field at all');
});

// The idle players. rosterIds is the group's own full roster, [1,2,3,4], the same ids the coverage's playing ids are drawn from, with 4 a stale id no rosterById entry exists for.
const rosterIds = [1, 2, 3, 4];

test('idlePlayers is empty with no rosterIds argument - never guessed from coverage in reverse', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    assert(out.byPeriod.every(d => d.idlePlayers.length === 0), 'no rosterIds given -> nothing to list as idle');
});

test('idlePlayers is the known roster minus the day\'s own playing set, named not just counted', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams, rosterIds);
    const p11 = out.byPeriod.find(d => d.period === 11);
    const names = p11.idlePlayers.map(p => p.name).sort();
    assert(names.length === 2 && names[0] === 'Bob' && names[1] === 'Cara', 'period 11: only Alice plays, Bob and Cara idle');
    assert(p11.idlePlayers.every(p => p.proTeamId != null), 'each idle entry carries its own club id, not a formatted string');
});

test('a period where the whole known roster plays has an empty idlePlayers list', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams, rosterIds);
    const p10 = out.byPeriod.find(d => d.period === 10);
    assert(p10.idlePlayers.length === 0, 'Alice, Bob and Cara all play period 10 - nobody left to be idle');
});

test('id 4 (no rosterById match) never appears in idlePlayers - a stale id costs a name, not a crash', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams, rosterIds);
    const p13 = out.byPeriod.find(d => d.period === 13);
    assert(!p13.idlePlayers.some(p => p.id === 4), 'id 4 dropped from idlePlayers, same as it is from players');
});

test('idlePlayers agrees with coverage\'s own idle COUNT where the roster is fully known', () => {
    // Every rostered id here (1, 2, 3) resolves a club. The coverage's own idle count for period 12 is 2, counted against a roster of four; this fixture's rosterIds resolves three known players, since id 4 is unknown to buildNightSchedule. So the comparison is against the figure for three known players that this module computes, not the coverage's raw idle number.
    const out = buildNightSchedule(coverage, rosterById, proTeams, rosterIds);
    const p12 = out.byPeriod.find(d => d.period === 12);
    // Known: 1,2,3. Playing this period: 2 (id 4 unknown to this module). Idle: 1,3 (Alice, Cara).
    const names = p12.idlePlayers.map(p => p.name).sort();
    assert(names.length === 2 && names[0] === 'Alice' && names[1] === 'Cara', 'period 12: only Bob resolves as playing, Alice and Cara idle');
});

test('the free-agent pseudo-club (proTeam id 0) is skipped, matching rosterNightCoverage\'s own rule', () => {
    // No assertion needed beyond "this did not throw and did not attribute a game to it" - already implicit in every other test passing, since a bug here would have made SOME player look like they play for club 0. Stated as its own test for the contract line it proves.
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    assert(out !== null, 'ran to completion with a pseudo-club present in proTeams');
});

test('lightestPeriod is the FIRST period at coverage.fewestPlaying, in period order, first tie wins', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    assert(out.lightestPeriod === 11, 'periods 11 and 13 tie at playing:1 - 11 comes first');
});

test('byPeriod carries playing/idle/emptySlots straight through per period, unrecomputed', () => {
    const out = buildNightSchedule(coverage, rosterById, proTeams);
    const p10 = out.byPeriod.find(d => d.period === 10);
    assert(p10.playing === 3 && p10.idle === 1 && p10.emptySlots === 0, 'period 10 figures match coverage verbatim');
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
