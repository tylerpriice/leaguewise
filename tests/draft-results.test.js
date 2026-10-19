// Unit tests for the draft results board (draft-results.js). Open tests/draft-results.test.html through any static server; green means every assertion held. The fixture's grid is hand-computed in tests/fixtures/draft-results.md, never from a run of this module.
import { draftResultsBoard, resultsFeedFor } from '../src/engines/draft-results.js';

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

const FIX = await (await fetch('fixtures/draft-results.json')).json();
const OPTS = { drafted: true, teamIds: FIX.teamIds, myTeamId: FIX.myTeamId };
const BOARD = draftResultsBoard(FIX.picks, OPTS);

test('refuses a league that is not drafted', () => {
    assertEq(draftResultsBoard(FIX.picks, { ...OPTS, drafted: false }), null, 'drafted false');
    assertEq(draftResultsBoard(FIX.picks, { teamIds: FIX.teamIds, myTeamId: FIX.myTeamId }), null, 'drafted omitted, no default');
    assertEq(draftResultsBoard(FIX.picks, { ...OPTS, drafted: 'true' }), null, 'drafted a truthy string is not exactly true');
});

test('refuses no picks, in every shape', () => {
    assertEq(draftResultsBoard(null, OPTS), null, 'null');
    assertEq(draftResultsBoard([], OPTS), null, 'empty array');
    assertEq(draftResultsBoard('nope', OPTS), null, 'not an array at all');
});

test('refuses a grid with nothing real in it', () => {
    const allPlaceholder = [
        { playerId: -1, teamId: 7, roundId: 1, overallPickNumber: 1 },
        { playerId: -1, teamId: 1, roundId: 1, overallPickNumber: 2 }
    ];
    assertEq(draftResultsBoard(allPlaceholder, OPTS), null, 'every pick is the -1 placeholder');
});

test('teamOrder: the reader own team first, the rest in first-seen order, a no-pick team appended', () => {
    assertJson(BOARD.teamOrder, ['7', '1', '3'], 'team 7 both picked first AND is myTeamId');
    assertEq(BOARD.myTeamId, '7', 'stringified');
});

test('teamOrder: a team with no real pick still gets a column, appended from teamIds', () => {
    const board = draftResultsBoard(FIX.picks, { drafted: true, teamIds: [7, 1, 3, 99], myTeamId: 7 });
    assertJson(board.teamOrder, ['7', '1', '3', '99'], 'team 99 made no real pick, appended last');
    board.rounds.forEach(r => assertEq(r.cells[3], null, `round ${r.round}: team 99's column is empty`));
});

test('teamOrder: myTeamId absent, null, or unseen leaves the built order untouched', () => {
    const noMine = draftResultsBoard(FIX.picks, { drafted: true, teamIds: FIX.teamIds });
    assertJson(noMine.teamOrder, ['7', '1', '3'], 'myTeamId omitted - team 7 still leads because it picked first');
    assertEq(noMine.myTeamId, null, 'and reads null itself');
    const unseen = draftResultsBoard(FIX.picks, { drafted: true, teamIds: FIX.teamIds, myTeamId: 404 });
    assertJson(unseen.teamOrder, ['7', '1', '3'], 'a team id that never picked and is not in teamIds does not appear or reorder anything');
});

test('three rounds, three cells each, in teamOrder', () => {
    assertEq(BOARD.rounds.length, 3, 'the highest roundId any real pick carries');
    BOARD.rounds.forEach(r => assertEq(r.cells.length, 3, `round ${r.round} has one cell per team`));
});

test('round 1, hand-computed: 9001/7, 9002/1, 9003/3 keeper, the -1 pick never reaches a round', () => {
    const r1 = BOARD.rounds[0];
    assertJson(r1.cells[0], { playerId: 9001, teamId: 7, round: 1, roundPick: 1, overall: 1, keeper: false }, 'team 7');
    assertJson(r1.cells[1], { playerId: 9002, teamId: 1, round: 1, roundPick: 2, overall: 2, keeper: false }, 'team 1');
    assertJson(r1.cells[2], { playerId: 9003, teamId: 3, round: 1, roundPick: 3, overall: 3, keeper: true }, 'team 3, a keeper');
});

test('round 3: a doubled payload keeps the EARLIEST pick, a negative id survives', () => {
    const r3 = BOARD.rounds[2];
    assertEq(r3.cells[1].playerId, 9008, 'pick 8 (9008) is kept; the later-inserted 9099 at the same overall is not');
    assertJson(r3.cells[2], { playerId: -16033, teamId: 3, round: 3, roundPick: 3, overall: 9, keeper: false }, "a real D/ST pick, kept whole");
});

test('a pick with no usable roundId is dropped rather than guessed into one', () => {
    const noRound = [
        { playerId: 9001, teamId: 7, roundId: 1, overallPickNumber: 1 },
        { playerId: 9002, teamId: 1, roundId: 0, overallPickNumber: 2 },
        { playerId: 9003, teamId: 3, overallPickNumber: 3 }
    ];
    const board = draftResultsBoard(noRound, { drafted: true, teamIds: [7, 1, 3], myTeamId: 7 });
    assertEq(board.rounds.length, 1, 'only the one pick with a real roundId ever reaches a round');
    assertEq(board.rounds[0].cells[1], null, 'team 1 own pick had roundId 0 - dropped, not round 0');
    assertEq(board.rounds[0].cells[2], null, 'team 3 own pick had no roundId at all - dropped');
});

test('roundPick and overall read null rather than guessed when the payload does not carry a finite one', () => {
    const board = draftResultsBoard([
        { playerId: 9001, teamId: 7, roundId: 1, roundPickNumber: null, overallPickNumber: undefined }
    ], { drafted: true, teamIds: [7], myTeamId: 7 });
    assertJson(board.rounds[0].cells[0], { playerId: 9001, teamId: 7, round: 1, roundPick: null, overall: null, keeper: false }, 'both null, never 0 or a position guess');
});


// What feeds the results board. Every expected value below is hand-computed in the contract's section 3 from the fixture's own feed block, never from a run of resultsFeedFor.
const FEED = FIX.feed;
const GRID = FEED.gridPlaceholders;
const feedOpts = (extra) => ({ teams: FIX.teamIds.map(id => ({ id })), myTeamId: FIX.myTeamId, ...extra });

test('espn basis is the existing call, unchanged', () => {
    const got = resultsFeedFor(feedOpts({ draftDetail: { drafted: true, picks: FIX.picks } }));
    assertEq(got.basis, 'espn', 'basis');
    assertEq(got.orderKnown, true, 'order is known');
    assertJson(got.board, BOARD, 'the board is byte for byte section 1\'s own');
    assertJson(got.grid, { count: 9, rounds: 3, teams: 3 }, 'the grid ESPN published');
    assertEq(got.teams, null, 'no rosters shape on an espn basis');
    assertJson(got.teamMismatches, [], 'no mismatches to report');
});

test('a drafted-false league with real ids is not the espn basis', () => {
    // The drafted flag is passed through exactly as the payload gives it, so this falls through to the rosters: the window in which ESPN has not yet marked the draft as over.
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, picks: FIX.picks },
        rosters: FEED.rosterTeams
    }));
    assertEq(got.basis, 'rosters', 'falls through to the rosters');
});

test('log basis: the log supplies the player, the grid the round and the team', () => {
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, inProgress: true, picks: GRID },
        log: FEED.logComplete,
        rosters: FEED.rosterTeams
    }));
    assertEq(got.basis, 'log', 'basis');
    assertEq(got.orderKnown, true, 'the log carries order');
    assertJson(got.grid, { count: 9, rounds: 3, teams: 3 }, 'grid');
    assertJson(got.board.teamOrder, ['7', '1', '3'], 'team order, the reader first');
    assertEq(got.board.rounds.length, 3, 'three rounds');
    assertJson(got.board.rounds[0].cells.map(c => c.playerId), [9101, 9102, 9103], 'round 1');
    assertJson(got.board.rounds[1].cells.map(c => c.playerId), [9106, 9105, 9104], 'round 2');
    assertJson(got.board.rounds[2].cells.map(c => c.playerId), [9107, 9108, 9109], 'round 3');
    assertJson(got.board.rounds[1].cells.map(c => c.overall), [6, 5, 4], 'the overalls follow the grid');
    assertEq(got.board.rounds[0].cells[0].keeper, false, 'a keeper flag is never invented');
    assertEq(got.teams, null, 'no rosters shape on a log basis');
});

test('log basis: a null logged team is filled from the grid, a disagreement is reported', () => {
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, picks: GRID },
        log: FEED.logComplete
    }));
    // Overall 5 was logged with no team at all: filled as team 1 from the grid, and NOT a mismatch.
    const round2 = got.board.rounds[1].cells;
    assertEq(round2[1].playerId, 9105, 'the teamless pick lands in team 1\'s round-2 cell');
    assertEq(String(round2[1].teamId), '1', 'its team comes from the grid slot');
    // Overall 8 was logged as team 7 where the grid says team 1: placed under team 1, reported once.
    assertJson(got.teamMismatches, [{ overall: 8, logged: 7, grid: 1 }], 'one mismatch, reported not resolved');
    assertEq(got.board.rounds[2].cells[1].playerId, 9108, 'and the pick is still on the board');
});

test('log basis refuses a short log and a gapped one', () => {
    const short = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, picks: GRID },
        log: FEED.logShort,
        rosters: FEED.rosterTeams
    }));
    assertEq(short.basis, 'rosters', 'seven of nine is not the whole draft');
    const gap = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, picks: GRID },
        log: FEED.logGap,
        rosters: FEED.rosterTeams
    }));
    assertEq(gap.basis, 'rosters', 'nine picks at 1..8 and 10 is a gap, never placed by position');
});

test('log basis refuses a placeholder or a nameless pick inside the log', () => {
    const withPlaceholder = { picks: FEED.logComplete.picks.map((p, i) => (i === 4 ? { ...p, playerId: -1 } : p)) };
    const got = resultsFeedFor(feedOpts({ draftDetail: { drafted: false, picks: GRID }, log: withPlaceholder }));
    assertEq(got.basis, 'none', '-1 is never read as a filled pick');
    const withNull = { picks: FEED.logComplete.picks.map((p, i) => (i === 4 ? { ...p, playerId: null } : p)) };
    assertEq(resultsFeedFor(feedOpts({ draftDetail: { drafted: false, picks: GRID }, log: withNull })).basis, 'none', 'null playerId');
});

test('no usable grid makes the log basis impossible', () => {
    const holed = GRID.filter(p => p.overallPickNumber !== 5);   // overalls 1..4, 6..9: a hole at 5
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, picks: holed },
        log: FEED.logComplete,
        rosters: FEED.rosterTeams
    }));
    assertEq(got.grid, null, 'a holed grid is no grid');
    assertEq(got.basis, 'rosters', 'so the log cannot be checked complete');
    const noRound = GRID.map(p => ({ ...p, roundId: null }));
    assertEq(resultsFeedFor(feedOpts({ draftDetail: { picks: noRound }, log: FEED.logComplete })).grid, null, 'a slot with no round');
});

test('rosters basis: who with no when, the reader first', () => {
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, inProgress: true, picks: GRID },
        rosters: FEED.rosterTeams
    }));
    assertEq(got.basis, 'rosters', 'basis');
    assertEq(got.orderKnown, false, 'the rosters carry no order');
    assertEq(got.board, null, 'no grid to render');
    assertJson(got.teams.map(t => t.teamId), [7, 1, 3], 'the reader\'s own team leads');
    assertJson(got.teams.map(t => t.mine), [true, false, false], 'mine on one team only');
    assertJson(got.teams[0].players, [
        { playerId: 9201, lineupSlotId: 3 },
        { playerId: 9202, lineupSlotId: 4 },
        { playerId: 9203, lineupSlotId: 8 }
    ], 'team 7 whole');
    assertJson(got.teams[1].players, [
        { playerId: 9204, lineupSlotId: 3 },
        { playerId: 9205, lineupSlotId: null }
    ], 'a doubled player once, a null playerId dropped, a missing slot null');
    assertJson(got.teams[2].players, [{ playerId: 9206, lineupSlotId: 7 }], 'the -1 entry dropped');
    assertJson(got.grid, { count: 9, rounds: 3, teams: 3 }, 'ESPN\'s order is still reported');
});

test('rosters basis refuses one empty team, and needs no team list of its own', () => {
    assertEq(resultsFeedFor(feedOpts({ rosters: FEED.rosterTeamsOneEmpty })).basis, 'none', 'one team with nobody');
    // `teams` omitted: the roster list is the team list, and the order still leads with the reader.
    const got = resultsFeedFor({ rosters: FEED.rosterTeams, myTeamId: 7 });
    assertEq(got.basis, 'rosters', 'basis without a team list');
    assertJson(got.teams.map(t => t.teamId), [7, 1, 3], 'order');
    const noMine = resultsFeedFor({ rosters: FEED.rosterTeams });
    assertJson(noMine.teams.map(t => t.mine), [false, false, false], 'no reader, no team marked');
    assertJson(noMine.teams.map(t => t.teamId), [7, 1, 3], 'and the payload\'s own order kept');
});

test('a mid-draft league reads none: empty rosters and nothing but placeholders', () => {
    // Measured on a capture taken mid-draft, past pick 140: every roster read zero while every pick was still the placeholder. This is the case that must not produce a board.
    const empties = FIX.teamIds.map(id => ({ id, roster: { entries: [] } }));
    const got = resultsFeedFor(feedOpts({
        draftDetail: { drafted: false, inProgress: true, picks: GRID },
        log: FEED.logShort,
        rosters: empties
    }));
    assertEq(got.basis, 'none', 'nothing to feed a board with');
    assertEq(got.orderKnown, false, 'and no order either');
});

test('resultsFeedFor with nothing at all', () => {
    assertJson(resultsFeedFor(), { basis: 'none', orderKnown: false, grid: null, board: null, teams: null, teamMismatches: [] }, 'no arguments');
    assertEq(resultsFeedFor({}).basis, 'none', 'an empty options object');
    assertEq(resultsFeedFor({ rosters: [] }).basis, 'none', 'an empty roster list is not every team holding somebody');
    assertEq(resultsFeedFor({ rosters: [{ roster: { entries: [{ playerId: 9201 }] } }] }).basis, 'none', 'a team with no id');
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
