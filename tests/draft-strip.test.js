// Unit tests for the draft room's strip and tray readings (draft-strip.js). Open tests/draft-strip.test.html through any static server; green means every assertion held. Expected values are hand-computed in tests/fixtures/draft-strip.md, never from running the code. Every player below is invented.
import { tierState, nextUp, picksGrid, adpTag, seatAtRisk, AT_RISK_MARGIN, companionHeadState, ageWords } from '../src/engines/draft-strip.js';
import { tierBreaks, draftOrder, runDetect } from '../src/engines/draft-engine.js';
import { rostersFromLog } from '../src/engines/draft-plan.js';

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

// ==== the board of ten Board-row shape, { player: { id, eligiblePositions }, value }, the Draft tab's own. ====
const row = (id, pos, value) => ({ player: { id, eligiblePositions: [pos] }, value });
const BOARD = [
    row('a1', 'C', 50), row('a2', 'D', 49), row('a3', 'D', 48), row('a4', 'LW', 47),
    row('a5', 'D', 40), row('a6', 'D', 39), row('a7', 'C', 38), row('a8', 'D', 37),
    row('a9', 'D', 30), row('a10', 'G', 29)
];

test('tiers: the board-wide cut and the D cut are different lists', () => {
    // Both pinned so the fixture cannot drift from the contract table. The board cuts at 47 -> 40 and 37 -> 30; the defencemen alone, 49 48 40 39 37 30, cut at 48 -> 40 and 37 -> 30.
    assertJson(tierBreaks(BOARD), [0, 4, 8], 'the board: three tiers, cut at indices 4 and 8');
    const d = BOARD.filter(r => r.player.eligiblePositions.includes('D'));
    assertJson(tierBreaks(d), [0, 2, 5], 'the D alone: a2 a3 | a5 a6 a8 | a9');
});

test('tierState: the best D left sets the tier, cut over the D alone', () => {
    assertJson(tierState(BOARD, ['a2', 'a5'], 'D'),
        { position: 'D', tier: 1, total: 2, taken: 1, left: 1 },
        'a3 is the best D left, in D tier 1 with a2, who is gone');
    assertJson(tierState(BOARD, ['a2', 'a3', 'a5'], 'D'),
        { position: 'D', tier: 2, total: 3, taken: 1, left: 2 },
        'D tier 1 is gone, so D tier 2: 2 D left, 1 of 3 already drafted');
});

test('tierState: the PLAN answer pins the tier, not the best left', () => {
    assertJson(tierState(BOARD, ['a2'], 'D', { playerId: 'a8' }),
        { position: 'D', tier: 2, total: 3, taken: 0, left: 3 },
        'a8 is the recommendation - D tier 2 - although a3 in D tier 1 is the best D still there');
    assertEq(tierState(BOARD, ['a10'], 'G'), null,
        'no G left at all is null, never "0 G left in tier 0"');
    assertEq(tierState(BOARD, [], 'RW'), null, 'and a position nobody plays is null too');
});

test('tierState: a two-position player is in both lists, and scout rows read the same', () => {
    // a7 as C/D joins the D list between a6 (39) and a8 (37): 49 48 40 39 38 37 30 cuts [0, 2, 6].
    const board = BOARD.map(r => (r.player.id === 'a7' ? { ...r, player: { ...r.player, eligiblePositions: ['C', 'D'] } } : r));
    assertEq(tierState(board, ['a2', 'a3', 'a5'], 'D').total, 4, 'D tier 2 now holds four');
    const scout = BOARD.map(r => ({ id: r.player.id, eligiblePositions: r.player.eligiblePositions, value: r.value }));
    assertJson(tierState(scout, ['a2', 'a3', 'a5'], 'D'),
        { position: 'D', tier: 2, total: 3, taken: 1, left: 2 }, 'the scout row shape, the same answer');
    // A row from another board can carry its points as `score` and not `value`, and is read the same way.
    const scored = BOARD.map(r => ({ id: r.player.id, eligiblePositions: r.player.eligiblePositions, score: r.value }));
    assertJson(tierState(scored, ['a2', 'a3', 'a5'], 'D'),
        { position: 'D', tier: 2, total: 3, taken: 1, left: 2 }, 'and a row carrying score, as rankPoints makes it');
});

// The case the position's own tiers are for. Two forwards sit above every defenceman and two wingers sit between them, so a cut over the whole board puts the best D in tier 3 and four D in one tier, while the defencemen's own gaps (60 | 54 53 | 47 | 40) say something a drafter can use.
const BOARD2 = [
    row('c1', 'C', 80), row('c2', 'C', 70), row('d1', 'D', 60), row('x1', 'LW', 57), row('d2', 'D', 54),
    row('d3', 'D', 53), row('x2', 'LW', 50), row('d4', 'D', 47), row('d5', 'D', 40)
];

test('tierState: PER POSITION, where the board-wide cut would say tier 3 and four of them', () => {
    assertJson(tierBreaks(BOARD2), [0, 1, 2, 8],
        'board-wide: c1 | c2 | d1 x1 d2 d3 x2 d4 | d5 - the best D in tier 3, lumped with three more');
    assertJson(tierBreaks(BOARD2.filter(r => r.player.eligiblePositions.includes('D'))), [0, 1, 3, 4],
        'the D alone: 60 | 54 53 | 47 | 40 - the wingers between them no longer hide the drops');
    assertJson(tierState(BOARD2, [], 'D'),
        { position: 'D', tier: 1, total: 1, taken: 0, left: 1 },
        'd1 is D tier 1, alone - the board-wide cut would have said tier 3, four of them');
    assertJson(tierState(BOARD2, ['d1', 'd2'], 'D'),
        { position: 'D', tier: 2, total: 2, taken: 1, left: 1 },
        '1 D left in tier 2, 1 of 2 already drafted - where board-wide read tier 3, 2 of 4');
});

test('tierState: the pin is doing work where the tiers disagree', () => {
    // Pinned to d4 the answer is D tier 3; unpinned it is d3 in tier 2 - so a pin that silently dropped would show as the wrong tier rather than pass unnoticed.
    assertJson(tierState(BOARD2, ['d1', 'd2'], 'D', { playerId: 'd4' }),
        { position: 'D', tier: 3, total: 1, taken: 0, left: 1 }, 'pinned to d4, the recommendation');
    assertEq(tierState(BOARD2, ['d1', 'd2'], 'D').tier, 2, 'unpinned, d3 in tier 2');
});

test('tierState: the engine own minGap and maxSize pass through', () => {
    // D gaps are 6, 1, 6, 7; at a minimum of 7 only the last clears, so D tier 1 is d1 to d4.
    assertJson(tierState(BOARD2, [], 'D', { minGap: 7 }),
        { position: 'D', tier: 1, total: 4, taken: 0, left: 4 }, 'one cut, at 47 -> 40');
});

// ==== the four-team snake ====
const ORDER = draftOrder([1, 2, 3, 4], 3, 'SNAKE');
const NEEDS = { 1: { F: 2, D: 0 }, 2: { F: 0, D: 1 }, 3: { G: 1 }, 4: { F: 1, D: 1 } };

test('nextUp: the three after the clock, and where then-you falls', () => {
    assertJson(ORDER, [1, 2, 3, 4, 4, 3, 2, 1, 1, 2, 3, 4], 'the snake, pinned');
    const out = nextUp(ORDER, 2, 2, NEEDS, 3);
    assertJson(out.onTheClock, { overall: 3, round: 1, pickInRound: 3, teamId: 3, isUser: false, needs: [{ position: 'G', open: 1 }] },
        'pick 3 on the clock, team 3, one G open');
    assertJson(out.picks.map(p => [p.overall, p.round, p.pickInRound, p.teamId]),
        [[4, 1, 4, 4], [5, 2, 1, 4], [6, 2, 2, 3]], 'picks 4, 5 and 6 - team 4 twice across the turn');
    assertJson(out.picks[0].needs, [{ position: 'F', open: 1 }, { position: 'D', open: 1 }], 'open needs only');
    assertJson([out.thenYou.overall, out.thenYou.picksAway, out.thenYou.listed], [7, 4, false],
        'then you: pick 7, 4 away, past the three listed');
    assertJson(nextUp(ORDER, 2, 1, NEEDS, 3).thenYou.needs, [{ position: 'F', open: 2 }],
        'team 1 D: 0 is not a need, so it is not carried');
});

test('nextUp: the user next, and the end of the draft', () => {
    const soon = nextUp(ORDER, 0, 2, NEEDS, 3);
    assertJson([soon.thenYou.overall, soon.thenYou.picksAway, soon.thenYou.listed], [2, 1, true],
        'the very next pick is yours, and it is listed');
    const end = nextUp(ORDER, 11, 2, NEEDS, 5);
    assertJson(end.picks, [], 'nothing after the last pick');
    assertEq(end.thenYou, null, 'and no then-you - null, not a pick zero');
    assertEq(end.onTheClock.overall, 12, 'the last pick is still on the clock');
});

const POS = { p1: 'C', p2: 'D', p3: 'G', p4: 'LW', p5: 'D' };
const positionOf = (id) => POS[id] ?? null;

test('picksGrid: rounds down, teams across, the snake walking back', () => {
    const mockPicks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((playerId, i) => ({ pick: i + 1, teamId: ORDER[i], playerId }));
    const out = picksGrid(mockPicks, ORDER, 3, 4, { userTeamId: 2, positionOf });
    assertJson(out.teams, [1, 2, 3, 4], 'columns are teams in the first round order');
    assertEq(out.userColumn, 1, 'the user column is team 2');
    assertEq(out.onTheClock, 6, 'the first pick not made');
    assertJson(out.grid[0].cells.map(c => c.position), ['C', 'D', 'G', 'LW'], 'round 1');
    assertJson(out.grid[1].cells.map(c => c.overall), [8, 7, 6, 5],
        'round 2 reads 8, 7, 6, 5 across - the columns stay put and the snake walks back');
    assertJson([out.grid[1].cells[3].filled, out.grid[1].cells[3].position], [true, 'D'], 'pick 5 is team 4, a D');
    assertEq(out.grid[1].cells[2].onTheClock, true, 'pick 6 is outlined');
    assertEq(out.grid[1].cells.filter(c => c.onTheClock).length, 1, 'and only pick 6');
    assertJson(out.grid[2].cells.map(c => c.filled), [false, false, false, false], 'round 3 untouched');
});

test('picksGrid: the log is the same shape, and a pick nobody attributed keeps its slot', () => {
    // The log's own shape: { overall, teamId, playerId }, with p2's team left null.
    const log = { picks: ['p1', 'p2', 'p3', 'p4', 'p5'].map((playerId, i) => ({ overall: i + 1, teamId: i === 1 ? null : ORDER[i], playerId })) };
    const out = picksGrid(log.picks, ORDER, 3, 4, { userTeamId: 2, positionOf });
    assertJson([out.grid[0].cells[1].playerId, out.grid[0].cells[1].position], ['p2', 'D'],
        'p2 sits in team 2 slot, where it was taken');
    assertJson(rostersFromLog(log).unassigned, ['p2'],
        'where the grouping the brief named would have lifted it out of the draft entirely');
    const mock = picksGrid(['p1', 'p2', 'p3', 'p4', 'p5'].map((playerId, i) => ({ pick: i + 1, teamId: ORDER[i], playerId })),
        ORDER, 3, 4, { userTeamId: 2, positionOf });
    assertJson(out.grid.map(r => r.cells.map(c => c.position)), mock.grid.map(r => r.cells.map(c => c.position)),
        'one function, both drafts, the same board');
    assertEq(picksGrid(log.picks, ORDER, 3, 4, {}).grid[0].cells[0].position, null,
        'no lookup: the cell is filled with no position, never dropped');
});

test('picksGrid: a finished draft has nothing on the clock', () => {
    const all = ORDER.map((teamId, i) => ({ pick: i + 1, teamId, playerId: `x${i}` }));
    const out = picksGrid(all, ORDER, 3, 4, { userTeamId: 2 });
    assertEq(out.onTheClock, null, 'past the end, no pick is outlined');
    assertEq(out.grid.flatMap(r => r.cells).filter(c => c.onTheClock).length, 0, 'anywhere');
});

// ==== the run alert ====
test('runAlert is runDetect as it stands: the count and the window it looked at', () => {
    // "3 of the last 8 picks were G" - but only five picks exist yet, so the honest window is 5.
    assertJson(runDetect(['G', 'F', 'G', 'D', 'G'], { window: 8, threshold: 3 }),
        { position: 'G', count: 3, of: 5 }, 'of is the window actually examined, fewer than 8 early on');
    assertEq(runDetect(['G', 'F', 'D'], { window: 8, threshold: 3 }), null, 'no run, no alert');
});

// ==== the ADP tag ====
test('adpTag: Value and Reach, worded once, the ADP printed whole', () => {
    assertJson(adpTag(5, 24), { verdict: 'falling', word: 'Value', text: 'Value · rank 5 vs ADP 24' },
        'falling is printed Value - the same fact read from the drafter side');
    assertEq(adpTag(12, 4).text, 'Reach · rank 12 vs ADP 4', 'a reach');
    assertEq(adpTag(5, 24.6).text, 'Value · rank 5 vs ADP 25', 'the board short form, whole');
    assertEq(adpTag(30, 31), null, 'no verdict is no tag - rank 30 vs ADP 31 says nothing');
    assertEq(adpTag(0, 10), null, 'and no rank is no verdict');
});

// ==== the seat group most at risk The hand-computed case from the contract: three open groups over a board of nine, with the replacement line given per group. D is 4 above and 3 teams need it (margin 1); G is 2 above and 2 need it (margin 0); C is 5 above and 1 needs it (margin 4). ====
const atRiskBoard = [
    row('d1', 'D', 90), row('d2', 'D', 80), row('d3', 'D', 70), row('d4', 'D', 60), row('d5', 'D', 40),
    row('g1', 'G', 88), row('g2', 'G', 77), row('g3', 'G', 30),
    row('c1', 'C', 99), row('c2', 'C', 95), row('c3', 'C', 91), row('c4', 'C', 87), row('c5', 'C', 83),
    row('c6', 'C', 20)
];
// A line each: four D above 50, two G above 50, five C above 50.
const atRiskLines = { D: 50, G: 50, C: 50 };
const needs = (...positions) => ({ needs: positions.map(p => ({ position: p, open: 1 })) });
// Six turns before the reader: three need D, two need G, one needs C.
const atRiskPicks = [needs('D'), needs('D'), needs('D', 'G'), needs('G'), needs('C'), needs('F')];

test('the smallest margin is the group at risk, and it says so in the strip voice', () => {
    const got = seatAtRisk({ openSeats: { D: 1, G: 1, C: 2 }, remaining: atRiskBoard,
        replacement: atRiskLines, picksBefore: atRiskPicks });
    assertJson({ group: got.group, left: got.left, needing: got.needing, margin: got.margin },
        { group: 'G', left: 2, needing: 2, margin: 0 }, 'G is 2 above the line with 2 teams needing it');
    assertEq(got.word, 'G · 2 above the line, 2 teams before you need one', 'the sentence');
});

test('a group at zero open is not open, and is not considered', () => {
    // The same board with G closed: D at margin 1 becomes the worst.
    const got = seatAtRisk({ openSeats: { D: 1, G: 0, C: 2 }, remaining: atRiskBoard,
        replacement: atRiskLines, picksBefore: atRiskPicks });
    assertEq(got.group, 'D', 'G is filled, so D is the worst left');
    assertEq(got.margin, 1, 'four above the line against three teams');
    assertEq(got.word.startsWith('D'), true, 'and a margin of one still reads as at risk');
});

test('every margin clearing is a sentence, not a blank', () => {
    const got = seatAtRisk({ openSeats: { C: 2 }, remaining: atRiskBoard,
        replacement: atRiskLines, picksBefore: atRiskPicks });
    assertEq(got.group, 'C', 'the only open group');
    assertEq(got.margin, 4, 'five above the line against one team');
    assertEq(got.word, 'no seat at risk before your pick', 'a cell that empties reads as one that broke');
});

test('the bar is one, and it is a named constant rather than a buried comparison', () => {
    assertEq(AT_RISK_MARGIN, 1, 'one bad run and the seat is gone');
    const atTwo = seatAtRisk({ openSeats: { C: 1 }, remaining: atRiskBoard,
        replacement: { C: 50 }, picksBefore: [needs('C'), needs('C'), needs('C')] });
    assertEq(atTwo.margin, 2, 'five above the line against three teams');
    assertEq(atTwo.word, 'no seat at risk before your pick', 'two clears');
});

test('one team reads as a team, not as 1 teams', () => {
    const got = seatAtRisk({ openSeats: { G: 1 }, remaining: atRiskBoard,
        replacement: { G: 80 }, picksBefore: [needs('G')] });
    assertEq(got.left, 1, 'only g1 is above 80');
    assertEq(got.word, 'G · 1 above the line, 1 team before you need one', 'singular');
});

test('replacementByGroup own entry is read as well as a bare number', () => {
    // The Map that function actually returns, whose player.value IS the line.
    const asMap = new Map([['G', { player: { value: 80 }, players: [], ids: [], window: 2, index: 0, eligible: [] }]]);
    const got = seatAtRisk({ openSeats: { G: 1 }, remaining: atRiskBoard,
        replacement: asMap, picksBefore: [needs('G')] });
    assertEq(got.left, 1, 'the same answer without the caller unwrapping the Map');
});

test('a group with no line counts every one of its players', () => {
    const got = seatAtRisk({ openSeats: { G: 1 }, remaining: atRiskBoard,
        replacement: { G: null }, picksBefore: [] });
    assertEq(got.left, 3, 'all three G, rather than a fabricated zero');
});

test('nothing open is null, because there is no worst group', () => {
    assertEq(seatAtRisk({ openSeats: {}, remaining: atRiskBoard, replacement: atRiskLines, picksBefore: [] }), null,
        'no group');
    assertEq(seatAtRisk({ openSeats: { D: 0 }, remaining: atRiskBoard, replacement: atRiskLines, picksBefore: [] }), null,
        'and a group at zero is no group either');
    assertEq(seatAtRisk({}), null, 'nor is nothing at all');
});

test('a tie on margin goes to the group with fewer left', () => {
    // D: 4 above, 4 needing -> margin 0. G: 2 above, 2 needing -> margin 0. G has fewer behind it.
    const picks = [needs('D'), needs('D'), needs('D'), needs('D'), needs('G'), needs('G')];
    const got = seatAtRisk({ openSeats: { D: 1, G: 1 }, remaining: atRiskBoard,
        replacement: atRiskLines, picksBefore: picks });
    assertEq(got.margin, 0, 'both at zero');
    assertEq(got.group, 'G', 'the same margin is worse when there is less behind it');
});

test('companionHeadState: neither companion running says nothing', () => {
    assertEq(companionHeadState({ isRehearse: false, isFollowingRoom: false }), null, 'no companion, no state');
});

test('companionHeadState: rehearsing, not the reader\'s turn, no target', () => {
    const got = companionHeadState({ isRehearse: true, isFollowingRoom: false, onTheClock: false });
    assertEq(got.word, 'Rehearsing', 'rehearsing but not on the clock');
    assertEq(got.action, null, 'no plan target to act on');
});

test('companionHeadState: rehearsing off-turn WITH a target still offers no action', () => {
    const got = companionHeadState({ isRehearse: true, isFollowingRoom: false, onTheClock: false, nextTarget: { id: 9, name: 'Someone Else\'s Turn' } });
    assertEq(got.word, 'Rehearsing', 'off-turn word');
    assertEq(got.action, null, 'the shortcut only fires on the reader\'s own turn - a target existing is not enough');
});

test('companionHeadState: rehearsing and on the clock, with a target - Draft', () => {
    const got = companionHeadState({ isRehearse: true, isFollowingRoom: false, onTheClock: true, nextTarget: { id: 7, name: 'Nathan MacKinnon' } });
    assertEq(got.word, 'On the clock', 'on the clock overrides the plain rehearsing word');
    assertEq(got.action.kind, 'draft', 'rehearse verb is Draft');
    assertEq(got.action.id, 7, 'the plan\'s own next open target');
    assertEq(got.action.name, 'Nathan MacKinnon', 'and its name');
});

test('companionHeadState: following a room, with a target - Taken', () => {
    const got = companionHeadState({ isRehearse: false, isFollowingRoom: true, nextTarget: { id: 3, name: 'Connor McDavid' } });
    assertEq(got.word, 'Following the room', 'the room word, never onTheClock\'s');
    assertEq(got.action.kind, 'taken', 'room verb is Taken (roomDraftBtnHtml\'s own push)');
    assertEq(got.action.id, 3, 'the target');
});

test('companionHeadState: following a room, no open target on the plan', () => {
    const got = companionHeadState({ isRehearse: false, isFollowingRoom: true, nextTarget: null });
    assertEq(got.word, 'Following the room', 'the state still shows');
    assertEq(got.action, null, 'nothing to act on - every row stays reachable via its own reveal');
});

test('ageWords: the seven hand-computed edges', () => {
    assertEq(ageWords(0), '0s ago', 'zero');
    assertEq(ageWords(59), '59s ago', 'last second under a minute');
    assertEq(ageWords(60), '1 min ago', 'the minute');
    assertEq(ageWords(3599), '59 min ago', 'floored, never rounded up to an hour');
    assertEq(ageWords(3600), '1 h ago', 'the hour');
    assertEq(ageWords(86399), '23 h ago', 'floored');
    assertEq(ageWords(86400), '1 d ago', 'the day');
    assertEq(ageWords(125508), '1 d ago', 'the replay fixture own age');
});

test('ageWords: an age nobody could measure is null', () => {
    assertEq(ageWords(null), null, 'null');
    assertEq(ageWords(undefined), null, 'undefined');
    assertEq(ageWords(-1), null, 'negative');
    assertEq(ageWords(NaN), null, 'NaN');
    assertEq(ageWords(Infinity), null, 'infinite');
    assertEq(ageWords('5'), null, 'a string is not an age');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
