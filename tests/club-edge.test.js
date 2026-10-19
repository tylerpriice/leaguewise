// Unit tests for club-edge.js. Open tests/club-edge.test.html through any static server; green means every assertion held. Every expected value is hand-computed in tests/fixtures/club-edge.md from the instance's own lines, never taken from running the code.
import { foldClubGames, clubGameRows, clubTable, gameEdges } from '../src/engines/club-edge.js';

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

const FIX = await (await fetch('fixtures/club-edge.json')).json();
const INDEX = new Map(Object.entries(FIX.games));
const fold = () => foldClubGames(FIX.lines, INDEX, { ids: FIX.ids });
const figuresOf = (table, clubId) => {
    const c = table.clubs.get(clubId);
    const out = { games: c.games };
    Object.keys(c.figures).forEach(k => { out[k] = [c.figures[k].value, c.figures[k].rank]; });
    return out;
};

test('foldClubGames: one record per club per game, a scratch adds nothing', () => {
    const f = fold();
    assertEq(f.games.size, 8, 'four games, two clubs each');
    assertEq(f.skipped, { noGame: 0, notInGame: 0, refolded: 0, idle: 1 }, 'player 13 did not play');
    assertEq([...f.players].sort((a, b) => a - b), [11, 12, 13, 21, 31, 77, 91, 92, 93], 'every player seen, the scratch too');
});

test('clubGameRows: a club in the order it played, against read off the other club', () => {
    assertEq(clubGameRows(fold()).get(1), FIX.expected.rowsClub1, 'club 1, three games');
});

test('clubGameRows: goals against are the other skaters, not the goalie (the empty-net goal)', () => {
    const row = clubGameRows(fold()).get(2).find(r => r.gameId === '101');
    assertEq([row.goalsAgainst, row.goalsAllowed, row.shotsAgainst, row.shotsFaced], [2, 1, 8, 8], 'two scored, one charged');
    assertEq(row.won, false, 'the win sits with the other goalie');
});

test('clubGameRows: a traded player is placed by the line, game by game', () => {
    const rows = clubGameRows(fold());
    assertEq(rows.get(2).find(r => r.gameId === '101').shotsFor, 7, 'player 77 shot three for club 2');
    assertEq(rows.get(3).find(r => r.gameId === '103').shotsFor, 8, 'and four for club 3');
    assertEq(rows.get(3).find(r => r.gameId === '103').goalsFor, 1, 'his goal is club 3 own');
});

test('clubTable: per-game figures and ranks through period 3, ties sharing a rank', () => {
    const t = clubTable(fold(), { through: 3 });
    assertEq(t.league, FIX.expected.tableThrough3.league, '42 shots and 8 goals over 6 club-games');
    [1, 2, 3].forEach(id => assertEq(figuresOf(t, id), FIX.expected.tableThrough3[id], `club ${id}`));
    assertEq(t.through, 3, 'the bound rides on the answer');
});

test('clubTable: without a bound the night in progress counts', () => {
    const t = clubTable(fold());
    // Club 1 over three games: shots 8 + 8 + 2 = 18, against 7 + 8 + 1 = 16; goals 3, against 2.
    assertEq([t.clubs.get(1).games, t.clubs.get(1).figures.shotsFor.value, t.clubs.get(1).figures.goalDiff.value], [3, 6, 1 / 3], 'three games');
    assertEq(t.clubs.get(3).games, 2, 'club 3 did not play game 104');
});

test('clubTable: it reads rows as well as a fold', () => {
    const a = clubTable(fold(), { through: 3 }), b = clubTable(clubGameRows(fold()), { through: 3 });
    assertEq(figuresOf(b, 2), figuresOf(a, 2), 'the same table either way');
});

test('clubTable: under minGames a club keeps its values and is ranked null, out of the others', () => {
    // Through period 2: club 1 has one game (101), club 2 two (101, 102), club 3 one (102).
    const t = clubTable(fold(), { through: 2, minGames: 2 });
    assertEq(figuresOf(t, 1).shotsFor, [8, null], 'a value, no rank');
    assertEq(figuresOf(t, 2).shotsFor, [6.5, 1], 'the one ranked club is first of one');
    assertEq(t.league, { ranked: 1, shots: 6.5, goals: 2 }, 'the league is the ranked clubs alone');
    assertEq(gameEdges({ home: 1, away: 2 }, t), null, 'and a game with an unranked club has no read');
});

test('clubTable: a game one club has no lines for is incomplete, never a zero against', () => {
    const half = foldClubGames(FIX.lines.filter(l => !(l.externalId === '103' && l.proTeamId === 1)), INDEX, { ids: FIX.ids });
    const row = clubGameRows(half).get(3).find(r => r.gameId === '103');
    assertEq([row.goalsAgainst, row.shotsAgainst, row.ppGoalsAgainst, row.won], [null, null, null, true], 'nothing against; its own goalie holds the win');
    const t = clubTable(half, { through: 3 });
    assertEq([t.clubs.get(3).games, t.clubs.get(3).incomplete], [1, 1], 'one counted, one set aside');
    assertEq(t.clubs.get(3).figures.shotsFor.value, 5, 'game 102 alone');
});

test('gameEdges: both sides of game 104, by hand', () => {
    assertEq(gameEdges({ home: 1, away: 2 }, clubTable(fold(), { through: 3 })), FIX.expected.edgesGame104Through3, 'six edges');
});

test('gameEdges: a goalie edge is the other side shots edge turned over', () => {
    const e = gameEdges({ home: 3, away: 2 }, clubTable(fold(), { through: 3 }));
    // Club 3 at home to club 2: shots 6.5 + 6.5 - 14 = -1; club 2's shotsFaced 14 - 6.5 - 6.5 = 1.
    const by = (side, key) => e[side].find(x => x.key === key);
    assertEq([by('home', 'shots').gap, by('away', 'shotsFaced').gap], [-1, 1], 'the same pairing from each end');
    assertEq([by('home', 'shots').ahead, by('away', 'shotsFaced').ahead], ['theirs', 'mine'], 'and its sign');
    assertEq(by('away', 'shots').gap, -by('home', 'shotsFaced').gap, 'both ways round');
});

test('gameEdges: a club id as a string finds a numeric club, and a missing one is no read', () => {
    const t = clubTable(fold(), { through: 3 });
    assertEq(gameEdges({ home: '1', away: '2' }, t), FIX.expected.edgesGame104Through3, 'ids compare as text');
    assertEq(gameEdges({ home: 1, away: 9 }, t), null, 'a club the table does not hold');
    assertEq(gameEdges(null, t), null, 'no game');
    assertEq(gameEdges({ home: 1, away: 2 }, null), null, 'no table');
    assertEq(gameEdges({ home: 1, away: 2 }, clubTable(foldClubGames([], INDEX, { ids: FIX.ids }))), null, 'an empty table');
});

test('foldClubGames: chunks add up, and a player landing twice is skipped whole', () => {
    const first = FIX.lines.filter(l => l.playerId < 50), second = FIX.lines.filter(l => l.playerId >= 50);
    const f = foldClubGames(first, INDEX, { ids: FIX.ids });
    foldClubGames(second, INDEX, { ids: FIX.ids, into: f });
    assertEq(figuresOf(clubTable(f, { through: 3 }), 1), FIX.expected.tableThrough3[1], 'two chunks, one table');
    // Player 11 has three lines. Landing again, all three are skipped and nothing moves.
    foldClubGames(FIX.lines.filter(l => l.playerId === 11), INDEX, { ids: FIX.ids, into: f });
    assertEq(f.skipped.refolded, 3, 'three lines, counted');
    assertEq(clubGameRows(f).get(1), FIX.expected.rowsClub1, 'club 1 is what it was');
});

test('foldClubGames: a line with no game, or a club not in its game, is counted and left out', () => {
    const f = foldClubGames([
        { playerId: 1, isGoalie: false, proTeamId: 1, externalId: '999', totals: { 30: 1, 29: 4 } },
        { playerId: 2, isGoalie: false, proTeamId: 3, externalId: '101', totals: { 30: 1, 29: 4 } },
        { playerId: 3, isGoalie: false, proTeamId: 1, externalId: '101', totals: { 30: 1, 29: 4 } },
        null,
        { isGoalie: false, proTeamId: 1, externalId: '101', totals: { 30: 1, 29: 9 } }
    ], INDEX, { ids: FIX.ids });
    assertEq(f.skipped, { noGame: 1, notInGame: 1, refolded: 0, idle: 0 }, 'one of each; no id and no line are passed over');
    assertEq([f.games.size, f.games.get('101|1').shots], [1, 4], 'the one good line');
});

test('foldClubGames: without a played id every line is an appearance; two starters name nobody', () => {
    const lines = [
        { playerId: 13, isGoalie: false, proTeamId: 1, externalId: '101', totals: { 30: 0 } },
        { playerId: 91, isGoalie: true, proTeamId: 1, externalId: '101', totals: { 0: 1 } },
        { playerId: 94, isGoalie: true, proTeamId: 1, externalId: '101', totals: { 0: 1 } }
    ];
    const { played, ...noPlayed } = FIX.ids;
    const row = clubGameRows(foldClubGames(lines, INDEX, { ids: noPlayed })).get(1)[0];
    assertEq([row.dressed, row.starterId, row.won, row.goalsAgainst], [1, null, null, null], 'counted; no one starter; no win; no opponent');
    assert(played === '30', 'the instance names the played id');
});

// ==== Amendment 1: the fold does not wait for the schedule. ====
const LINES_WITH_PERIOD = FIX.lines.map(l => ({ ...l, period: FIX.games[l.externalId].period }));
const blindFold = () => foldClubGames(LINES_WITH_PERIOD, null, { ids: FIX.ids });

test('no schedule at the fold: the same table, the period read off the line', () => {
    const t = clubTable(blindFold(), { through: 3 });
    assertEq(t.league, FIX.expected.tableThrough3.league, 'the league');
    [1, 2, 3].forEach(id => assertEq(figuresOf(t, id), FIX.expected.tableThrough3[id], `club ${id}`));
    assertEq(gameEdges({ home: 1, away: 2 }, t), FIX.expected.edgesGame104Through3, 'and the same edges');
});

test('no schedule at the fold: the rows are finished when the index arrives', () => {
    assertEq(clubGameRows(blindFold(), INDEX).get(1), FIX.expected.rowsClub1, 'opponent, side and date from the game');
});

test('no schedule anywhere: the opponent is the one other club in the game; side and date are null', () => {
    const row = clubGameRows(blindFold()).get(1)[0];
    assertEq([row.gameId, row.opponentId, row.isHome, row.date, row.period], ['101', 2, null, null, 1], 'game 101');
    assertEq([row.goalsAgainst, row.shotsAgainst, row.won], [1, 7, true], 'against still read off club 2');
    const f = foldClubGames([{ playerId: 5, isGoalie: false, externalId: '101', totals: { 30: 1 } },
        { playerId: 6, isGoalie: false, proTeamId: 1, totals: { 30: 1 } }], null, { ids: FIX.ids });
    assertEq(f.skipped, { noGame: 1, notInGame: 1, refolded: 0, idle: 0 }, 'a line naming no club, and one naming no game');
});

test('clubTable and clubGameRows: nothing in is nothing out', () => {
    assertEq(clubGameRows(null).size, 0, 'no fold');
    const t = clubTable(foldClubGames(null, null));
    assertEq([t.clubs.size, t.league], [0, { ranked: 0, shots: null, goals: null }], 'an empty league has no mean');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
