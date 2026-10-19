// Unit tests for the reader's own rankings file (rankings-file.js). Open tests/rankings-file.test.html through any static server; green means every assertion held. The expected values are hand-computed in the fixture's expected block, from the three files and the pool of twelve players in its input. Every player, club and id is invented.
import { readRankings, matchRankings, rankingsColumn, poolNameLookup, ROOM_POSITION_GROUPS } from '../src/data/rankings-file.js';

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

const FIX = await (await fetch('fixtures/rankings-file.json')).json();
const POOL = FIX.pool;
const POSITIONS = id => FIX.positionsOf[String(id)] || [];
const FULL = readRankings(FIX.files.full);
// The caller says what the team column holds. This fixture's full file carries ESPN's own numeric club ids, so the club step needs a clubOf that reads them. There is no default, and the translation is the caller's. Without it the first of the two players sharing a name would still resolve, but by position.
const CLUB_IS_ID = e => String(e.player.proTeamId);
const MATCHED = matchRankings(FULL.rows, POOL, { positionsOf: POSITIONS, clubOf: CLUB_IS_ID });

// ==== reading ====

test('the columns are found under their own names', () => {
    assertJson(FULL.columnsFound, FIX.expected.columnsFound, 'the ACTUAL header each field came from');
});

test('the aliases are matched however they are written', () => {
    const r = readRankings('NAME,rk,espn_id\r\nAlma Rook,1,1001\r\n');
    assertEq(r.columnsFound.name, 'NAME', 'case is ignored');
    assertEq(r.columnsFound.rank, 'rk', 'Rk is a rank');
    assertEq(r.columnsFound.espnId, 'espn_id', 'punctuation is ignored, so espn_id is ESPN ID');
    assertEq(r.columnsFound.tier, null, 'and a column that is not there is null');
});

test('the first matching header wins where a file has two', () => {
    const r = readRankings('Player,Rank,ADP\r\nAlma Rook,1,40\r\n');
    assertEq(r.columnsFound.rank, 'Rank', 'Rank before ADP, so a file with both uses Rank');
    assertEq(r.rows[0].rank, 1, 'and the value comes from that column');
});

test('a file with neither a name nor an id is refused, with a reason', () => {
    const r = readRankings('Rank,Tier\r\n1,1\r\n');
    assertJson(r.rows, [], 'an empty list beats a list of blanks');
    assertEq(r.issues.length, 1, 'one issue');
    assertEq(r.issues[0].why.includes('nothing to match'), true, 'and it says why');
});

test('a rank that is not a number is an issue and a null, never a NaN', () => {
    assertEq(FULL.issues.length, FIX.expected.issueCount, 'one issue in the full file');
    assertEq(FULL.issues[0].why.includes('not a number'), true, 'naming the reason');
    const vale = FULL.rows.find(r => r.name === 'Dara Vale');
    assertEq(vale.rank, null, 'the rank is null');
    assertEq(vale.tier, 3, 'and the tier beside it still reads');
});

test('a blank row is skipped and counted, not carried', () => {
    const r = readRankings('Player,Rank\r\nAlma Rook,1\r\n,\r\nGus Pike,2\r\n');
    assertEq(r.rows.length, 2, 'two players');
    assertEq(r.issues.length, 1, 'and the blank is reported rather than silently dropped');
});

test('the full file reads twelve rows', () => {
    assertEq(FULL.rows.length, FIX.expected.fullRowCount, 'twelve');
});

// ==== matching ====

test('the whole match is the hand-computed one', () => {
    assertJson(MATCHED.byPlayerId, FIX.expected.byPlayerId, 'ten players placed');
});

test('an id beats a name, which is why the fixture misspells one', () => {
    // Row 2 says "Bo Quillian" where the pool says "Bo Quillan", and carries the id 1002.
    const row = FULL.rows.find(r => r.espnId === '1002');
    assertEq(row.name, 'Bo Quillian', 'the file is wrong about the name');
    assertJson(MATCHED.byPlayerId['1002'], { rank: 2, tier: 1 }, 'and it is placed anyway, by id');
    assertEq(MATCHED.unmatched.some(r => r.name === 'Bo Quillian'), false, 'so it is not unmatched');
});

test('a shared name is separated by the club', () => {
    assertJson(MATCHED.byPlayerId['1005'], { rank: 3, tier: 1 }, 'club 5 picks 1005 of the two Sam Twins');
    assertEq(MATCHED.byPlayerId['1006'], undefined, 'and 1006 gets nothing from that row');
});

test('a shared name with nothing to separate it is AMBIGUOUS, and neither is given the rank', () => {
    assertEq(MATCHED.ambiguous.length, 1, 'one ambiguous row');
    const a = MATCHED.ambiguous[0];
    assertEq(a.row.name, FIX.expected.ambiguous[0].name, 'the bare Sam Twin');
    assertEq(a.row.rank, FIX.expected.ambiguous[0].rank, 'carrying rank 4');
    assertJson(a.candidates, FIX.expected.ambiguous[0].candidates, 'both ids are reported');
    // The whole point: rank 4 reached NEITHER of them.
    assertEq(MATCHED.byPlayerId['1005'].rank, 3, '1005 keeps the rank it was actually given');
    assertEq(MATCHED.byPlayerId['1006'], undefined, 'and 1006 is still unplaced');
});

test('the position separates a shared name when the club does not', () => {
    const rows = [{ name: 'Sam Twin', club: '', position: 'D', rank: 1, tier: null, espnId: null }];
    const m = matchRankings(rows, POOL, { positionsOf: POSITIONS });
    assertJson(m.byPlayerId, { 1006: { rank: 1, tier: null } }, 'D picks 1006');
    assertEq(m.ambiguous.length, 0, 'so nothing is ambiguous');
});

test('a name in no pool is unmatched, and carries its row', () => {
    assertJson(MATCHED.unmatched.map(r => r.name), FIX.expected.unmatchedNames, 'Zeb Nobody');
    assertEq(MATCHED.unmatched[0].rank, 6, 'with the rank it had, so a face can show it');
});

test('a later row wins a duplicate', () => {
    const rows = [
        { name: 'Alma Rook', club: '', position: '', rank: 9, tier: 9, espnId: null },
        { name: 'Alma Rook', club: '', position: '', rank: 1, tier: 1, espnId: null }
    ];
    const m = matchRankings(rows, POOL, { positionsOf: POSITIONS });
    assertJson(m.byPlayerId['1001'], { rank: 1, tier: 1 }, 'the reader changed their mind, and meant the last one');
});

test('no clubOf means the club rung is SKIPPED - translating a club is the caller job', () => {
    // There is no default for the club. A default that read the pool's numeric club id would be right only for a file whose team column holds ESPN's own ids. With no clubOf, club '6' separates nothing and the shared name is reported.
    const rows = [{ name: 'Sam Twin', club: '6', position: '', rank: 1, tier: null, espnId: null }];
    const bare = matchRankings(rows, POOL, {});
    assertJson(bare.byPlayerId, {}, 'nothing placed on a club nobody translated');
    assertJson(bare.ambiguous.map(a => a.candidates), [[1005, 1006]], 'reported with both candidates');
    // A caller whose file really does carry ESPN's ids says so, and the rung runs.
    const byId = matchRankings(rows, POOL, { clubOf: e => String(e.player.proTeamId) });
    assertJson(byId.byPlayerId, { 1006: { rank: 1, tier: null } }, 'club 6 is 1006 when the caller reads ids');
});

test('a caller own clubOf is used where the file says TOR and ESPN says 10', () => {
    const CODES = { 10: 'TOR' };
    const rows = [{ name: 'Hana Reed', club: 'TOR', position: '', rank: 1, tier: null, espnId: null }];
    const m = matchRankings(rows, POOL, { clubOf: e => CODES[e.player.proTeamId] || '' });
    assertJson(m.byPlayerId, { 1010: { rank: 1, tier: null } }, 'the caller translates, this module does not');
});

// ==== tier-only and rank-only ====

test('a tier-only file is a real file, not an error', () => {
    const r = readRankings(FIX.files.tierOnly);
    assertEq(r.columnsFound.rank, null, 'no rank column');
    assertEq(r.issues.length, 0, 'and that is not a problem');
    const m = matchRankings(r.rows, POOL, { positionsOf: POSITIONS });
    assertJson(m.byPlayerId, FIX.expected.tierOnlyByPlayerId, 'tiers with null ranks');
});

test('a rank-only file likewise', () => {
    const r = readRankings(FIX.files.rankOnly);
    assertEq(r.columnsFound.tier, null, 'no tier column');
    const m = matchRankings(r.rows, POOL, { positionsOf: POSITIONS });
    assertJson(m.byPlayerId, FIX.expected.rankOnlyByPlayerId, 'ranks with null tiers');
});

// ==== the column ====

test('the column is the hand-computed one, delta and all', () => {
    const board = FIX.board.map(id => ({ player: { id } }));
    assertJson(rankingsColumn(MATCHED.byPlayerId, board), FIX.expected.column, 'five rows');
});

test('a negative delta means the reader rates the player HIGHER than the board', () => {
    const board = FIX.board.map(id => ({ player: { id } }));
    const col = rankingsColumn(MATCHED.byPlayerId, board);
    const alma = col.find(c => c.playerId === 1001);
    assertEq(alma.myRank, 1, 'the reader has Alma first');
    assertEq(alma.boardRank, 2, 'the board has Alma second');
    assertEq(alma.deltaVsBoard, -1, 'so the delta is negative - the sign the contract fixes');
    const gus = col.find(c => c.playerId === 1009);
    assertEq(gus.deltaVsBoard, 6, 'and a player the reader rates lower is positive');
});

test('a board row the file never mentions carries nulls, not zeroes', () => {
    const col = rankingsColumn(MATCHED.byPlayerId, [{ player: { id: 1011 } }]);
    assertJson(col, [{ playerId: 1011, myRank: null, myTier: null, boardRank: 1, deltaVsBoard: null }],
        'no opinion is not agreement, and a zero delta would read as exact agreement');
});

test('a tier-only match has a tier and no delta to compute', () => {
    const r = readRankings(FIX.files.tierOnly);
    const m = matchRankings(r.rows, POOL, { positionsOf: POSITIONS });
    const col = rankingsColumn(m.byPlayerId, [{ player: { id: 1001 } }]);
    assertEq(col[0].myTier, 1, 'the tier is there');
    assertEq(col[0].deltaVsBoard, null, 'and there is nothing to subtract');
});

test('the board row shape is forgiving', () => {
    assertEq(rankingsColumn(MATCHED.byPlayerId, [{ id: 1001 }])[0].myRank, 1, 'a bare id object');
    assertEq(rankingsColumn(MATCHED.byPlayerId, [1001])[0].myRank, 1, 'or the id itself');
});

// The room board's name lookup: the same steps matchRankings takes, over a board's cell in place of a file's row. Expected values are hand-computed in the contract from this fixture's own pool.
const SHARED = [
    { player: { id: 7001, fullName: 'Sam Twin', proTeamId: 21 } },
    { player: { id: 7002, fullName: 'Sam Twin', proTeamId: 22 } },
    { player: { id: 7003, fullName: 'Ada Lovel', proTeamId: 21 } },
    { player: { id: 7004, fullName: 'José Ramírez', proTeamId: 23 } }
];
const clubOf = (entry) => ({ 21: 'AAA', 22: 'BBB', 23: 'CCC' })[entry.player.proTeamId] || '';
const positionsOf = (id) => ({ 7001: ['C'], 7002: ['D'], 7003: ['LW'], 7004: ['RW', 'C'] })[id] || [];

test('a name alone resolves when the pool has one of it', () => {
    const { playerIdOf, unmatched, ambiguous } = poolNameLookup(SHARED, { clubOf, positionsOf });
    assertEq(playerIdOf({ name: 'Ada Lovel', overall: 1 }), 7003, 'one candidate, no rung needed');
    // Normalised on both sides, as delimited.js normalises: accents, case and punctuation are cosmetic.
    assertEq(playerIdOf({ name: 'jose ramirez', overall: 2 }), 7004, 'accents and case are cosmetic');
    assertJson(unmatched, [], 'nothing unmatched');
    assertJson(ambiguous, [], 'nothing ambiguous');
});

test('the club separates a shared name', () => {
    const { playerIdOf, ambiguous } = poolNameLookup(SHARED, { clubOf, positionsOf });
    assertEq(playerIdOf({ name: 'Sam Twin', proTeam: 'BBB', overall: 3 }), 7002, 'the club decides');
    assertEq(playerIdOf({ name: 'Sam Twin', proTeam: 'aaa', overall: 4 }), 7001, 'normalised');
    assertJson(ambiguous, [], 'and neither was reported');
});

test('no clubOf means the club rung is SKIPPED, never run against an id', () => {
    // The pool's club is a number and the room's cell an abbreviation, so a defaulted step would compare 21 with BBB and never narrow while appearing to run. With no clubOf, the shared name stays ambiguous, which a reader can see.
    const { playerIdOf, ambiguous } = poolNameLookup(SHARED, { positionsOf });
    assertEq(playerIdOf({ name: 'Sam Twin', proTeam: 'BBB', overall: 20 }), null, 'no club rung to separate them');
    assertJson(ambiguous, [{ name: 'Sam Twin', overall: 20, candidates: [7001, 7002] }], 'reported, not guessed');
    // And the position rung still runs without it.
    assertEq(playerIdOf({ name: 'Sam Twin', proTeam: 'BBB', position: 'D', overall: 21 }), 7002, 'the pill still decides');
});

test('the position rung is by GROUP, because the room\'s pill is coarse', () => {
    const { playerIdOf } = poolNameLookup(SHARED, { clubOf, positionsOf });
    // F stands for C, LW and RW: the page's position label reads F, D or G and nothing else. The pool says 7001 is a C and 7002 a D, so the label alone separates them.
    assertEq(playerIdOf({ name: 'Sam Twin', position: 'F', overall: 5 }), 7001, 'F reaches a centre');
    assertEq(playerIdOf({ name: 'Sam Twin', position: 'D', overall: 6 }), 7002, 'D reaches the defence');
    // AND THE RUNG THAT WOULD HAVE LOOKED LIKE IT WORKED: comparing the pill to a pool position string narrows nothing, because no pool position is spelled "F".
    const strict = poolNameLookup(SHARED, { clubOf, positionsOf, groups: {} });
    assertEq(strict.playerIdOf({ name: 'Sam Twin', position: 'F', overall: 7 }), null, 'no groups, no narrowing');
    assertEq(strict.ambiguous.length, 1, 'reported instead');
});

test('a label the group map does not know does not narrow', () => {
    const { playerIdOf, ambiguous } = poolNameLookup(SHARED, { clubOf, positionsOf });
    assertEq(playerIdOf({ name: 'Sam Twin', position: 'UTIL', overall: 8 }), null, 'never narrows wrongly');
    assertJson(ambiguous, [{ name: 'Sam Twin', overall: 8, candidates: [7001, 7002] }], 'reported with both candidates');
});

test('ambiguous and unmatched answer null and are reported beside', () => {
    const { playerIdOf, unmatched, ambiguous } = poolNameLookup(SHARED, { clubOf, positionsOf });
    assertEq(playerIdOf({ name: 'Sam Twin', overall: 9 }), null, 'two of that name, nothing to separate them');
    assertEq(playerIdOf({ name: 'Nobody Here', overall: 10 }), null, 'and a name the pool does not carry');
    assertJson(ambiguous, [{ name: 'Sam Twin', overall: 9, candidates: [7001, 7002] }], 'the candidates named');
    assertJson(unmatched, [{ name: 'Nobody Here', overall: 10 }], 'the miss named');
    assertEq(playerIdOf({ name: '', overall: 11 }), null, 'an empty name is not a miss to report');
    assertEq(unmatched.length, 1, 'so the list is unchanged');
});

test('the lookup feeds domPickFacts as it stands', async () => {
    const { boardDomPicks, domPickFacts } = await import('../src/data/room-feed.js');
    const cells = [
        { round: 1, pickInRound: 1, column: 1, row: 1, mine: true, firstName: 'Ada', lastName: 'Lovel', proTeam: 'AAA', position: 'F' },
        { round: 1, pickInRound: 2, column: 2, row: 1, mine: false, firstName: 'Sam', lastName: 'Twin', proTeam: 'BBB', position: 'D' },
        { round: 1, pickInRound: 3, column: 3, row: 1, mine: false, firstName: 'Nobody', lastName: 'Here', proTeam: 'CCC', position: 'G' }
    ];
    const read = boardDomPicks(cells, { columns: 3 });
    const lookup = poolNameLookup(SHARED, { clubOf, positionsOf });
    const facts = domPickFacts(read.picks, { playerIdOf: lookup.playerIdOf });
    assertJson(facts.facts.map(f => f.playerId), [7003, 7002], 'the prefix, resolved');
    assertJson(facts.unresolved.map(u => u.overall), [3], 'and the hole domPickFacts reports');
    assertJson(lookup.unmatched, [{ name: 'Nobody Here', overall: 3 }], 'while the lookup says WHY');
    assertJson(lookup.ambiguous, [], 'nothing ambiguous here');
});

test('an empty pool and a pool of nobodies', () => {
    assertEq(poolNameLookup([]).playerIdOf({ name: 'Ada Lovel' }), null, 'no pool');
    assertEq(poolNameLookup(null).playerIdOf({ name: 'Ada Lovel' }), null, 'not an array');
    const odd = poolNameLookup([{ player: { fullName: 'No Id' } }, { player: { id: 9, fullName: '' } }, {}]);
    assertEq(odd.playerIdOf({ name: 'No Id' }), null, 'an entry with no id is not in the index');
    assertEq(poolNameLookup(SHARED).playerIdOf(null), null, 'and no throw on no pick');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
