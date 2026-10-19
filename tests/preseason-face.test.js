// Unit tests for the pre-draft face's pure data. Open tests/preseason-face.test.html through any static server; green means every assertion held. The card this file cares most about is the one that must not appear: a league in its first season has no last season, and a summary card fails by defaulting to a champion of Unknown or a finish of 0. Half of these tests assert an absence.
import { countdownCard, countdownPhrase, lastSeasonCard, categoryRanks, rankedPoolCard, slotSeatsFor, projectedCategoryRanks, bestValuePick, draftPickRows, draftPickOf, draftedIndexOf } from '../src/engines/preseason-face.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const NOW = new Date(2026, 8, 1, 12, 0, 0);
const draftAt = (d) => ({ settings: { draftSettings: { date: d.getTime(), type: 'SNAKE', pickOrder: [3, 1, 4, 2] } } });

// ==== the countdown ====

test('countdownPhrase: today, tomorrow, and the plural days', () => {
    assertEq(countdownPhrase(0), 'Drafts today', 'today');
    assertEq(countdownPhrase(1), 'Drafts tomorrow', 'tomorrow');
    assertEq(countdownPhrase(6), 'Drafts in 6 days', 'six days');
});

test('countdownPhrase: a date already gone reads in the past, never as a negative countdown', () => {
    // Leagues postpone without moving the date, so this is a real state rather than an error.
    assertEq(countdownPhrase(-1), 'Draft date was yesterday', 'yesterday');
    assertEq(countdownPhrase(-9), 'Draft date passed 9 days ago', 'nine days ago');
});

test('countdownPhrase: no date at all is unscheduled', () => {
    assertEq(countdownPhrase(null), 'Draft not scheduled', 'null');
    assertEq(countdownPhrase(undefined), 'Draft not scheduled', 'undefined');
});

test('countdownCard: carries the type, the slot and the league size', () => {
    const card = countdownCard(draftAt(new Date(2026, 8, 7, 19, 0, 0)), NOW, 4);
    assertEq(card.scheduled, true, 'scheduled');
    assertEq(card.phrase, 'Drafts in 6 days', 'phrase');
    assertEq(card.type, 'SNAKE', 'type');
    assertEq(card.slot, 3, 'team 4 picks third in the order 3,1,4,2');
    assertEq(card.teams, 4, 'league size');
});

test('countdownCard: unscheduled keeps the rest of the card rather than collapsing', () => {
    // The type and the pick order are known even when the date is not, and they are the two things a manager checks first.
    const card = countdownCard({ settings: { draftSettings: { date: 0, type: 'AUCTION', pickOrder: [1, 2] } } }, NOW, 2);
    assertEq(card.scheduled, false, 'not scheduled');
    assertEq(card.phrase, 'Draft not scheduled', 'phrase');
    assertEq(card.type, 'AUCTION', 'type still known');
    assertEq(card.slot, 2, 'slot still known');
    assertEq(card.date, null, 'no date');
});

// ==== category ranks ====

const SEASON = {
    teams: [
        { id: 1, valuesByStat: { '5': 200, '47': 3.10 } },
        { id: 2, valuesByStat: { '5': 250, '47': 4.20 } },
        { id: 3, valuesByStat: { '5': 250, '47': 2.90 } }
    ]
};

test('categoryRanks: an INVERSE category ranks the lowest value first', () => {
    // The failure this guards: naming a manager's worst category as the best one. ERA 2.90 is first.
    const { ranks } = categoryRanks(SEASON, ['5', '47'], new Set(['47']));
    assertEq(ranks.get(3)['47'], 1, 'lowest ERA is first');
    assertEq(ranks.get(2)['47'], 3, 'highest ERA is last');
    assertEq(ranks.get(2)['5'], 1, 'most home runs is first');
});

test('categoryRanks: equal values share a place', () => {
    const { ranks } = categoryRanks(SEASON, ['5'], new Set());
    assertEq(ranks.get(2)['5'], 1, 'tied first');
    assertEq(ranks.get(3)['5'], 1, 'also first, not second by a hair nobody lost by');
    assertEq(ranks.get(1)['5'], 3, 'the third team is third');
});

test('categoryRanks: a category only one team posted ranks nobody', () => {
    const thin = { teams: [{ id: 1, valuesByStat: { '9': 4 } }, { id: 2, valuesByStat: {} }] };
    const { ranks } = categoryRanks(thin, ['9'], new Set());
    assert(!ranks.has(1) || ranks.get(1)['9'] === undefined, 'no rank from a field of one');
});

// ==== the last-season card ====

const SUMMARY = {
    year: 2025, format: 'h2h', finished: true, championKey: 'k2', statIds: ['5', '47'],
    franchises: [
        { key: 'k1', teamId: 1, name: 'Bunt Force Trauma', abbrev: 'BFT', wins: 4, losses: 8, ties: 0, finalRank: 3 },
        { key: 'k2', teamId: 2, name: 'Rally Caps', abbrev: 'RC', wins: 9, losses: 3, ties: 0, finalRank: 1 },
        { key: 'k3', teamId: 3, name: 'Wild Pitches', abbrev: 'WP', wins: 5, losses: 7, ties: 0, finalRank: 2 }
    ]
};
const OPTS = { statMap: { '5': 'HR', '47': 'ERA' }, inverseIds: new Set(['47']) };

test('lastSeasonCard: champion, your finish, and your best and worst categories', () => {
    const card = lastSeasonCard(SUMMARY, SEASON, 'k1', OPTS);
    assertEq(card.year, 2025, 'year');
    assertEq(card.champion.name, 'Rally Caps', 'champion');
    assertEq(card.champion.isYou, false, 'not you');
    assertEq(card.finish.rank, 3, 'your finish');
    assertEq(card.finish.of, 3, 'of how many');
    assertEq(card.finish.record.wins, 4, 'record');
    // Team 1: HR 200 is third of three, ERA 3.10 is second. Best is the second-place ERA.
    assertEq(card.best.label, 'ERA', 'best category');
    assertEq(card.best.rank, 2, 'its rank');
    assertEq(card.worst.label, 'HR', 'worst category');
    assertEq(card.worst.rank, 3, 'its rank');
});

test('lastSeasonCard: your own championship says so', () => {
    assertEq(lastSeasonCard(SUMMARY, SEASON, 'k2', OPTS).champion.isYou, true, 'isYou');
});

test('lastSeasonCard: NULL for a first-season league, never a hollow card', () => {
    assertEq(lastSeasonCard(null, SEASON, 'k1', OPTS), null, 'no summary at all');
    assertEq(lastSeasonCard({ ...SUMMARY, franchises: [] }, SEASON, 'k1', OPTS), null, 'no franchises');
});

test('lastSeasonCard: NULL for a season nobody finished', () => {
    // An undecided season cannot crown anyone, and the history view already refuses to call it done.
    assertEq(lastSeasonCard({ ...SUMMARY, finished: false }, SEASON, 'k1', OPTS), null, 'unfinished');
});

test('lastSeasonCard: a roto season shows a finish with NO fabricated record', () => {
    const roto = {
        ...SUMMARY, format: 'roto',
        franchises: SUMMARY.franchises.map(f => ({ ...f, wins: null, losses: null, ties: null }))
    };
    const card = lastSeasonCard(roto, SEASON, 'k1', OPTS);
    assertEq(card.finish.rank, 3, 'the finish survives');
    assertEq(card.finish.record, null, 'no 0-0-0 invented');
});

test('lastSeasonCard: a franchise this league cannot find gets champion but no finish', () => {
    const card = lastSeasonCard(SUMMARY, SEASON, 'nobody', OPTS);
    assertEq(card.finish, null, 'no finish claimed for a team that is not there');
    assertEq(card.champion.name, 'Rally Caps', 'the champion is still a fact about the season');
    assertEq(card.best, null, 'and no categories are invented');
});

test('lastSeasonCard: one ranked category yields a best and no worst', () => {
    // The same row twice under two headings would read as two findings.
    const oneCat = { ...SUMMARY, statIds: ['5'] };
    const card = lastSeasonCard(oneCat, SEASON, 'k1', OPTS);
    assertEq(card.best.label, 'HR', 'best');
    assertEq(card.worst, null, 'no worst');
});

test('lastSeasonCard: no champion and no finish is no card', () => {
    const anon = { ...SUMMARY, championKey: null };
    assertEq(lastSeasonCard(anon, SEASON, 'nobody', OPTS), null, 'an empty box wearing a heading');
});


// ==== the ranked pool ====

// The board's order by value and the order by score disagree on purpose. First leads on value (42.5) and Second leads on score (145.2 against 120.4). The card sorts by score, so a fixture where the two orders agreed could not prove it. Unvalued Skater carries no score at all, which is the real state for a player the projections do not reach.
const BOARD = [
    { boardRank: 1, value: 42.5, score: 120.4, player: { id: 1, name: 'First Skater', proTeamId: 5, positionDisplay: 'C' } },
    { boardRank: 2, value: 38.0, score: 145.2, player: { id: 2, name: 'Second Skater', proTeamId: 9, positionDisplay: 'LW' } },
    { boardRank: 3, value: null, score: null, player: { id: 3, name: 'Unvalued Skater', proTeamId: 5, positionDisplay: 'RW' } },
    { boardRank: null, value: null, score: 999, player: { id: 4, name: 'Unranked Skater', proTeamId: 5, positionDisplay: 'D' } }
];
const CLUBS = new Map([[5, 'DET'], [9, 'BOS']]);
const DEPTH = [
    { pos: 'G', starters: 12, available: 6, ratio: 0.5, word: 'cliff' },
    { pos: 'C', starters: 8, available: 10, ratio: 1.25, word: 'short' },
    { pos: 'LW', starters: 8, available: 20, ratio: 2.5, word: 'deep' },
    { pos: 'RW', starters: 8, available: 13, ratio: 1.6, word: '' }
];

test('rankedPoolCard: ranked by PROJECTED POINTS, not the board\'s own value (B239 item 2.1)', () => {
    const card = rankedPoolCard(BOARD, DEPTH, { clubs: CLUBS, limit: 3 });
    assertEq(card.rows.length, 3, 'limited');
    // Second Skater (145.2) outranks First Skater (120.4) here despite being #2 on the board - the whole point of the fix. rank is this list's own 1-based position, not boardRank.
    assertEq(card.rows[0].rank, 1, 'this list\'s own rank, not the board\'s');
    assertEq(card.rows[0].name, 'Second Skater', 'the higher PROJECTION leads, not the higher board value');
    assertEq(card.rows[0].club, 'BOS', 'club from the map');
    assertEq(card.rows[0].pos, 'LW', 'position');
    assertEq(card.rows[0].value, 145.2, 'the gold figure is the projection, never the board\'s value');
    assertEq(card.rows[1].name, 'First Skater', 'second by points, second row');
    assertEq(card.rows[1].value, 120.4, 'not the board\'s own 42.5');
});

test('rankedPoolCard: an unranked row is not on a ranked board', () => {
    const card = rankedPoolCard(BOARD, DEPTH, { clubs: CLUBS });
    assert(card.rows.every(r => r.rank), 'every row has a rank');
    assert(!card.rows.some(r => r.name === 'Unranked Skater'), 'the unranked one is out');
});

test('rankedPoolCard: no projection is NULL, never a zero value', () => {
    // Zero is a value; "the projections could not reach that player" is not.
    const card = rankedPoolCard(BOARD, DEPTH, { clubs: CLUBS });
    assertEq(card.rows[2].value, null, 'unvalued');
});

test('rankedPoolCard: a club the map cannot name is null rather than guessed', () => {
    assertEq(rankedPoolCard(BOARD, DEPTH, { clubs: new Map() }).rows[0].club, null, 'empty map');
    assertEq(rankedPoolCard(BOARD, DEPTH, {}).rows[0].club, null, 'no map at all');
});

test('rankedPoolCard: only the depth notes that BITE, tightest first', () => {
    const card = rankedPoolCard(BOARD, DEPTH, { clubs: CLUBS });
    assertEq(card.notes.length, 2, 'cliff and thin only');
    assertEq(card.notes[0].text, 'G cliff after #6', 'the depth card own words');
    assertEq(card.notes[1].text, 'C short after #10', 'and the second');
    assert(!card.notes.some(n => n.pos === 'LW'), 'deep says nothing a manager acts on');
    assert(!card.notes.some(n => n.pos === 'RW'), 'nor does the unworded middle');
});

test('rankedPoolCard: NONE above replacement is stated, not written as #0', () => {
    // Measured on the real baseball board: RP came back with nothing above replacement, and the ordinal phrasing read "RP cliff after #0" - a cliff after the zeroth player.
    const none = [{ pos: 'RP', starters: 12, available: 0, ratio: 0, word: 'cliff' }];
    const card = rankedPoolCard(BOARD, none, {});
    assertEq(card.notes[0].text, 'RP cliff, none above replacement', 'the fact, not an ordinal');
    assertEq(card.notes[0].after, 0, 'the count is still carried');
});

test('rankedPoolCard: no board is no card', () => {
    assertEq(rankedPoolCard([], DEPTH, {}), null, 'empty');
    assertEq(rankedPoolCard(null, DEPTH, {}), null, 'nothing at all');
    assertEq(rankedPoolCard([{ boardRank: null, player: {} }], DEPTH, {}), null, 'nothing ranked');
});

test('rankedPoolCard: no depth at all still yields the board', () => {
    const card = rankedPoolCard(BOARD, null, { clubs: CLUBS });
    assertEq(card.notes.length, 0, 'no notes');
    assert(card.rows.length > 0, 'the board survives');
});


// ==== the pre-draft seats ====

test('slotSeatsFor: every seat is ANONYMOUS before a draft, with the league own counts', () => {
    // A family with a count above one is the pre-draft case, so the ground needs no separate signal.
    const seats = slotSeatsFor({
        counts: { 0: 1, 2: 2, 4: 3, 20: 6 },
        labels: { 0: 'QB', 2: 'RB', 4: 'WR', 20: 'BE' },
        order: [0, 2, 4, 20]
    });
    assertEq(seats.length, 4, 'one entry per slot family');
    assert(seats.every(s => s.playerName === null), 'nobody is drafted yet');
    assertEq(seats[2].slotCode, 'WR', 'code from the catalog');
    assertEq(seats[2].count, 3, 'three anonymous seats');
});

test('slotSeatsFor: reads in lineup-card order, not numeric id order', () => {
    const seats = slotSeatsFor({
        counts: { 20: 6, 0: 1, 4: 3 },
        labels: { 0: 'QB', 4: 'WR', 20: 'BE' },
        order: [0, 4, 20]
    });
    assertEq(seats.map(s => s.slotCode).join(','), 'QB,WR,BE', 'the order the card reads in');
});

test('slotSeatsFor: a slot the order forgot still shows, after the ones it knows', () => {
    const seats = slotSeatsFor({
        counts: { 0: 1, 99: 2 },
        labels: { 0: 'QB', 99: 'XX' },
        order: [0]
    });
    assertEq(seats.map(s => s.slotCode).join(','), 'QB,XX', 'the unknown one follows rather than vanishing');
});

test('slotSeatsFor: a slot the catalog cannot NAME keeps its raw id as its code', () => {
    // The contract draws an unrecognised code in the dashed aside seat, which says "not claimed onto the field" honestly. A seat the league opens is never hidden for want of a name.
    const seats = slotSeatsFor({ counts: { 77: 1 }, labels: {}, order: null });
    assertEq(seats[0].slotCode, '77', 'the id itself');
    assertEq(seats[0].count, 1, 'and it still seats someone');
});

test('slotSeatsFor: a zero-count slot is not a seat', () => {
    const seats = slotSeatsFor({ counts: { 0: 1, 2: 0, 4: 0 }, labels: { 0: 'QB', 2: 'RB', 4: 'WR' } });
    assertEq(seats.length, 1, 'only the slot the league actually opens');
});

test('slotSeatsFor: nothing at all yields no seats rather than throwing', () => {
    assertEq(slotSeatsFor().length, 0, 'no arguments');
    assertEq(slotSeatsFor({}).length, 0, 'empty');
});


// ==== the graded card's model ====

// Four teams, three categories. Every expected rank below is counted by hand off this table. HR (higher better): A 40, B 30, C 30, D 10 ERA (LOWER better): A 4.00, B 3.00, C 3.50, D 5.00 E (nobody but A): A 12
const GRADE_VALUES = {
    A: { '5': 40, '47': 4.00, '12': 12 },
    B: { '5': 30, '47': 3.00 },
    C: { '5': 30, '47': 3.50 },
    D: { '5': 10, '47': 5.00 }
};
const GRADE_INVERSE = new Set(['47']);

test('projectedCategoryRanks: best category first, and an inverse category ranks the LOW value best', () => {
    const ranks = projectedCategoryRanks(GRADE_VALUES, 'A', ['5', '47'], GRADE_INVERSE);
    // A leads home runs outright, with nobody above 40. In ERA only B (3.00) and C (3.50) are better than A's 4.00, and D's 5.00 is worse, so A is third of four. That is the point of the inverse flag: read the other way round, A's 4.00 would rank second and look like a strength.
    assertEq(ranks.length, 2, 'both categories ranked');
    assertEq(ranks[0].id, '5', 'strongest is home runs');
    assertEq(ranks[0].rank, 1, 'first of four');
    assertEq(ranks[ranks.length - 1].id, '47', 'weakest is ERA');
    assertEq(ranks[ranks.length - 1].rank, 3, 'two teams better, one worse');
});

test('projectedCategoryRanks: ties SHARE a place', () => {
    // B and C both have 30 home runs, behind A's 40 - so both are second and neither is told third.
    const b = projectedCategoryRanks(GRADE_VALUES, 'B', ['5'], GRADE_INVERSE)[0];
    const c = projectedCategoryRanks(GRADE_VALUES, 'C', ['5'], GRADE_INVERSE)[0];
    assertEq(b.rank, 2, 'B shares second');
    assertEq(c.rank, 2, 'C shares second');
});

test('projectedCategoryRanks: a category only one team has a figure in ranks NOBODY', () => {
    // ESPN projects no fielding, so a league scoring errors really is in this shape. One team with a figure would rank #1 of 1, which reads as a strength and is actually an absence.
    const ranks = projectedCategoryRanks(GRADE_VALUES, 'A', ['12'], GRADE_INVERSE);
    assertEq(ranks.length, 0, 'no rank for a category nobody can be compared in');
});

test('projectedCategoryRanks: a team with no figure in a category is not ranked in it', () => {
    const ranks = projectedCategoryRanks(GRADE_VALUES, 'B', ['5', '47', '12'], GRADE_INVERSE);
    assertEq(ranks.length, 2, 'B is ranked in the two it has');
    assertEq(ranks.some(r => r.id === '12'), false, 'and not in the one it does not');
});

test('projectedCategoryRanks: equally-ranked categories keep the order the LEAGUE lists them in', () => {
    // B and C tie on home runs, and A is alone at the top of both categories it leads. Ranking is stable, so a caller listing its categories the way the league lists them gets them back that way. This is not cosmetic: the card names the LAST entry as "weakest", so a tie broken on the stat id silently changes which category a manager is told to worry about.
    const vals = { A: { '5': 1, '47': 1 }, B: { '5': 2, '47': 2 } };
    const forward = projectedCategoryRanks(vals, 'A', ['5', '47'], new Set());
    const reversed = projectedCategoryRanks(vals, 'A', ['47', '5'], new Set());
    assertEq(forward.map(r => r.id).join(','), '5,47', 'listed 5 then 47');
    assertEq(reversed.map(r => r.id).join(','), '47,5', 'listed 47 then 5');
});

test('projectedCategoryRanks: a category that is NULL for everyone ranks nobody', () => {
    // Number(null) is 0, so converting before checking would tie every team at zero and rank every one of them first. A category ESPN does not project is carried as null for every team on purpose, so it keeps its heatmap column, and it must not earn a rank as well.
    const vals = {
        A: { '5': 10, '19': null },
        B: { '5': 20, '19': null },
        C: { '5': 30, '19': null }
    };
    const ranks = projectedCategoryRanks(vals, 'A', ['5', '19'], new Set());
    assertEq(ranks.length, 1, 'only the category anyone has a figure in');
    assertEq(ranks[0].id, '5', 'home runs');
    assertEq(ranks.some(r => r.id === '19'), false, 'the unprojected category ranks nobody');
});

test('bestValuePick: the biggest edge over the board wins', () => {
    // Taken at 30, board says 8 -> edge 22. Taken at 5, board says 3 -> edge 2.
    const picks = [
        { playerId: 1, overallPickNumber: 5 },
        { playerId: 2, overallPickNumber: 30 }
    ];
    const board = new Map([[1, 3], [2, 8]]);
    const best = bestValuePick(picks, board);
    assertEq(best.playerId, 2, 'the 22-pick steal');
    assertEq(best.edge, 22, 'thirty minus eight');
});

test('bestValuePick: nobody ahead of the board is NULL, not a zero-edge pick', () => {
    // Praising a pick that came in exactly where it should have is praising nothing.
    const picks = [{ playerId: 1, overallPickNumber: 4 }, { playerId: 2, overallPickNumber: 9 }];
    const board = new Map([[1, 4], [2, 12]]);
    assertEq(bestValuePick(picks, board), null, 'no steal to name');
});

test('bestValuePick: a player the board does not rank is skipped, never treated as ranked last', () => {
    // Unranked is not 3000th. Counting it as last would make every unranked late pick the "steal".
    const picks = [{ playerId: 9, overallPickNumber: 200 }, { playerId: 1, overallPickNumber: 20 }];
    const board = new Map([[1, 12]]);
    const best = bestValuePick(picks, board);
    assertEq(best.playerId, 1, 'the ranked pick wins');
    assertEq(best.edge, 8, 'twenty minus twelve');
});

// The picks beside the marked one. Team 7 is the reader and team 3 is not. Pick 4 with the board at 12 is eight picks early (edge -8). Pick 13 with the board at 3 is ten picks late (edge +10) and is the best value. The board never ranked pick 20's player.
const W2_PICKS = [
    { playerId: 9, overallPickNumber: 1, roundId: 1, teamId: 3 },
    { playerId: 1, overallPickNumber: 4, roundId: 1, teamId: 7 },
    { playerId: 2, overallPickNumber: 13, roundId: 2, teamId: 7 },
    { playerId: 3, overallPickNumber: 20, roundId: 3, teamId: 7 }
];
const W2_BOARD = new Map([[9, 1], [1, 12], [2, 3]]);

test('draftPickRows: the reader own picks, in draft order, measured against the board', () => {
    const rows = draftPickRows(W2_PICKS, W2_BOARD, 7);
    assertEq(rows.length, 3, 'another team pick is not the reader own');
    assertEq(rows.map(r => r.overallPickNumber).join(','), '4,13,20', 'draft order');
    assertEq(rows.map(r => r.round).join(','), '1,2,3', 'each round as ESPN numbered it');
    assertEq(rows[0].edge, -8, 'four less twelve: taken eight picks early');
    assertEq(rows[1].edge, 10, 'thirteen less three: the steal');
    assertEq(rows[2].rank, null, 'a player the board does not rank has no rank');
    assertEq(rows[2].edge, null, 'and no edge, rather than a last-place one');
});

test('draftPickRows: the starred row is the one bestValuePick names, by construction', () => {
    const rows = draftPickRows(W2_PICKS, W2_BOARD, 7);
    const starred = rows.filter(r => r.best);
    assertEq(starred.length, 1, 'exactly one');
    // The same call the card headline makes, on the same filtered picks.
    const mine = W2_PICKS.filter(p => p.teamId === 7);
    assertEq(starred[0].playerId, bestValuePick(mine, W2_BOARD).playerId, 'the same pick as the headline');
    assertEq(starred[0].edge, bestValuePick(mine, W2_BOARD).edge, 'and the same edge');
});

test('draftPickRows: no steal stars nothing, and every row still draws', () => {
    // Both picks came in at or ahead of the board, so bestValuePick returns null, and the rows are still the reader's own picks with none marked.
    const picks = [
        { playerId: 1, overallPickNumber: 4, roundId: 1, teamId: 7 },
        { playerId: 2, overallPickNumber: 9, roundId: 2, teamId: 7 }
    ];
    const rows = draftPickRows(picks, new Map([[1, 4], [2, 12]]), 7);
    assertEq(rows.length, 2, 'both rows');
    assertEq(rows.some(r => r.best), false, 'and nothing starred');
    assertEq(rows[0].edge, 0, 'exactly where the board had them');
});

test('draftPickRows: a keeper keeps its round, and a missing pick number is left out', () => {
    const picks = [
        { playerId: 5, overallPickNumber: 2, roundId: 1, teamId: 7, keeper: true },
        { playerId: 1, overallPickNumber: 13, roundId: 2, teamId: 7 },
        { playerId: 6, roundId: 3, teamId: 7 }
    ];
    const rows = draftPickRows(picks, new Map([[5, 40], [1, 3]]), 7);
    assertEq(rows.length, 2, 'the pick with no pick number has nothing to order or compare');
    assertEq(rows[0].round, 1, 'the keeper keeps the round ESPN gave it');
    assertEq(rows[0].edge, -38, 'two less forty: a keeper held far above the board');
    assertEq(rows[1].best, true, 'and the later pick is still the steal');
});

test('draftPickRows: no team, no rows', () => {
    assertEq(draftPickRows(W2_PICKS, W2_BOARD, null).length, 0, 'a card of somebody else picks is worse than none');
    assertEq(draftPickRows(null, W2_BOARD, 7).length, 0, 'no picks');
    // No board at all: the rows still list the picks, with nothing to measure them against.
    const rows = draftPickRows(W2_PICKS, null, 7);
    assertEq(rows.length, 3, 'the picks are still the picks');
    assertEq(rows.every(r => r.rank === null && r.edge === null && !r.best), true, 'and nothing is ranked');
});

// Where one player came from. The drill-down says the round, the pick and the team in season, or that the player was undrafted.
test('draftPickOf: the round, the pick and the team that made it', () => {
    const got = draftPickOf(W2_PICKS, 2);
    assertEq(got.round, 2, 'the round ESPN numbered');
    assertEq(got.overallPickNumber, 13, 'the overall pick');
    assertEq(got.teamId, 7, 'and whose pick it was, as an id for the caller to name');
});

// ==== The board's Drafted column ====

test('draftedIndexOf: one pass, the compact label, and the reader own picks marked MINE', () => {
    const index = draftedIndexOf(W2_PICKS, { myTeamId: 7, drafted: true });
    assertEq(index.size, 4, 'every pick, keyed by player');
    const second = index.get('2');
    assertEq(second.round, 2, 'the round ESPN numbered');
    assertEq(second.pick, 13, 'the overall pick');
    assertEq(second.label, '2.13', 'the drill-down own compact form');
    assertEq(second.mine, true, 'the reader own pick');
    assertEq(second.teamId, 7, 'whose pick it was');
    assertEq(index.get('9').mine, false, 'another team pick is not MINE');
    assertEq(index.get('404'), undefined, 'an undrafted player is absent, for the caller to read as undrafted');
});

test('draftedIndexOf: drafted !== true is not a real log, whatever the picks say', () => {
    // No default: a caller that omits the drafted flag, or that knows the league has not drafted, gets nothing back. The picks are never read anyway on the assumption that absence means false.
    assertEq(draftedIndexOf(W2_PICKS).size, 0, 'omitted defaults to not-a-log, not to true');
    assertEq(draftedIndexOf(W2_PICKS, { drafted: false }).size, 0, 'known false: nothing, even with real picks');
});

test('draftedIndexOf: an UNFILLED pick is not a pick, and a real negative id survives', () => {
    // A league whose draft has not happened still carries its whole grid of picks, every player id at -1, since ESPN publishes the grid before the results. A board that read those would show every seat drafted by nobody. A negative id that is not -1 is a real pick, since a football team defence has one, so the test is exactly -1 and never anything at or below zero.
    const grid = [
        { playerId: -1, overallPickNumber: 1, roundId: 1, teamId: 5 },
        { playerId: -1, overallPickNumber: 2, roundId: 1, teamId: 7 },
        { playerId: -16033, overallPickNumber: 3, roundId: 1, teamId: 4 }
    ];
    const index = draftedIndexOf(grid, { drafted: true });
    assertEq(index.size, 1, 'the two placeholder seats are dropped, the real D/ST pick is not');
    assertEq(index.get('-16033').pick, 3, 'the surviving pick keeps its own overall number');
    assertEq(draftedIndexOf(null, { drafted: true }).size, 0, 'no draft view fetched');
    assertEq(draftedIndexOf([], { drafted: true }).size, 0, 'no picks at all');
});

test('draftedIndexOf: sortKey puts the column in draft order and the undrafted last', () => {
    const index = draftedIndexOf([
        { playerId: 5, overallPickNumber: 40, roundId: 4, teamId: 1 },
        { playerId: 6, overallPickNumber: 7, roundId: 1, teamId: 2 },
        // ESPN gave this one a round and no overall number: it sorts at the head of round 3.
        { playerId: 7, roundId: 3, teamId: 2 },
        { playerId: 8, teamId: 2 }
    ], { drafted: true });
    const keyOf = (id) => index.get(String(id)).sortKey;
    assertEq(keyOf(6), 7, 'the overall number is the order');
    assertEq(keyOf(5), 40, 'and the later pick sorts after it');
    assertEq(keyOf(7), 3000, 'a round with no overall sorts at that round own head');
    assertEq(keyOf(8), Infinity, 'a pick with neither sorts last, in either direction');
    assertEq(index.get('7').label, 'R3', 'a round with no overall says the round');
    assertEq(index.get('8').label, 'Drafted', 'and one with neither says only that');
});

test('draftedIndexOf: a doubled payload keeps the earliest pick, and a keeper says so', () => {
    const index = draftedIndexOf([
        { playerId: 4, overallPickNumber: 30, roundId: 3, teamId: 2 },
        { playerId: 4, overallPickNumber: 12, roundId: 2, teamId: 2, keeper: true }
    ], { drafted: true });
    assertEq(index.get('4').pick, 12, 'the earliest, the rule draftPickOf already follows');
    assertEq(index.get('4').keeper, true, "ESPN's own keeper flag, carried for the column to mark");
});

test('draftPickOf: undrafted is null, which is a real answer', () => {
    assertEq(draftPickOf(W2_PICKS, 404), null, 'a free agent was never picked');
    assertEq(draftPickOf([], 1), null, 'no picks at all');
    assertEq(draftPickOf(null, 1), null, 'no draft view fetched');
    assertEq(draftPickOf(W2_PICKS, null), null, 'nobody asked about');
});

test('draftPickOf: a string id finds the same pick as a numeric one', () => {
    // ESPN mixes the two across payloads; losing the pick on that would call a drafted player undrafted in the one place a reader goes to check.
    assertEq(draftPickOf(W2_PICKS, '2').overallPickNumber, 13, 'matched as a string');
    assertEq(draftPickOf([{ playerId: '55', roundId: 4, overallPickNumber: 40, teamId: 3 }], 55).round, 4,
        'and the other way round');
});

test('draftPickOf: a pick with no pick number still says where the player came from', () => {
    // draftPickRows leaves such a pick out because it orders and grades them; this only reports where a player came from, and the round and the team are most of that answer.
    const got = draftPickOf([{ playerId: 6, roundId: 3, teamId: 7 }], 6);
    assertEq(got.round, 3, 'the round survives');
    assertEq(got.overallPickNumber, null, 'the missing number reads as missing');
    assertEq(got.teamId, 7, 'and the team is still known');
});

test('bestValuePick: no picks and no board are both just null', () => {
    assertEq(bestValuePick(null, new Map()), null, 'no picks');
    assertEq(bestValuePick([{ playerId: 1, overallPickNumber: 3 }], null), null, 'no board');
});

// Last season's standings. The fixture above is deliberately not in order of place (3, 1, 2), so a test that passes cannot pass by accident of input order.

test('standings: every team, ordered by place, whatever order the summary arrived in', () => {
    const s = lastSeasonCard(SUMMARY, SEASON, 'k1', OPTS).standings;
    assertEq(s.length, 3, 'every team, not just yours');
    assertEq(s.map(r => r.place).join(), '1,2,3', 'sorted by place');
    assertEq(s.map(r => r.name).join(), 'Rally Caps,Wild Pitches,Bunt Force Trauma', 'and the names follow it');
});

test('standings: the champion is MARKED, never moved', () => {
    // The whole ordering rule in one case. Rally Caps is both champion and first here, so the mark and the place agree, and the test that matters is the one below, where they do not.
    const s = lastSeasonCard(SUMMARY, SEASON, 'k1', OPTS).standings;
    assertEq(s[0].isChampion, true, 'the champion');
    assertEq(s.filter(r => r.isChampion).length, 1, 'exactly one');
});

test('standings: a champion who did NOT finish first stays in place order', () => {
    // Never measured, but possible in head-to-head, where the champion wins a bracket and the place is a standing. A champion-first reorder would put a team above rank 1 in a table headed by place, which is a table contradicting its own column.
    const upset = { ...SUMMARY, championKey: 'k1' };   // k1 finished THIRD
    const s = lastSeasonCard(upset, SEASON, 'k2', OPTS).standings;
    assertEq(s.map(r => r.place).join(), '1,2,3', 'still place order');
    assertEq(s[0].isChampion, false, 'the first row is not the champion');
    assertEq(s[2].isChampion, true, 'the third-place team is');
});

test('standings: your row is marked, and only yours', () => {
    const s = lastSeasonCard(SUMMARY, SEASON, 'k3', OPTS).standings;
    assertEq(s.filter(r => r.isYou).length, 1, 'one row');
    assertEq(s.find(r => r.isYou).name, 'Wild Pitches', 'the right one');
    // A spectator with no franchise in this league marks nobody rather than guessing.
    const none = lastSeasonCard(SUMMARY, SEASON, null, OPTS).standings;
    assertEq(none.filter(r => r.isYou).length, 0, 'nobody is you when you are not in it');
});

test('standings: the record rides along, and is NULL in roto rather than 0-0-0', () => {
    const s = lastSeasonCard(SUMMARY, SEASON, 'k1', OPTS).standings;
    const rec = s.find(r => r.key === 'k2').record;
    assertEq(`${rec.wins}-${rec.losses}-${rec.ties}`, '9-3-0', 'a real record');
    const roto = {
        ...SUMMARY, format: 'roto',
        franchises: SUMMARY.franchises.map(f => ({ ...f, wins: null, losses: null, ties: null }))
    };
    assertEq(lastSeasonCard(roto, SEASON, 'k1', OPTS).standings[0].record, null,
        'a roto season keeps no W-L-T, so the row says nothing rather than 0-0-0');
});

test('standings: points ride along where the format keeps them, null where it does not', () => {
    // The measured rule: a points league and ROTO both keep a real standing; head-to-head categories reports 0 on every team, which is the absence of a measurement.
    const withPoints = {
        ...SUMMARY,
        franchises: SUMMARY.franchises.map((f, i) => ({ ...f, points: [1361.2, 1693.2, 1456.4][i] }))
    };
    const s = lastSeasonCard(withPoints, SEASON, 'k1', OPTS).standings;
    assertEq(s[0].points, 1693.2, 'the first-place team carries its points');
    // A summary whose franchises carry no points field at all, which is every head-to-head categories season, reads null and never 0.
    assertEq(lastSeasonCard(SUMMARY, SEASON, 'k1', OPTS).standings[0].points, null, 'null, not zero');
});

test('standings: a team the season never ranked sorts to the BACK, not the front', () => {
    // A null place is not a claim to have finished first.
    const gap = {
        ...SUMMARY,
        franchises: [
            { key: 'k9', teamId: 9, name: 'Unranked', abbrev: 'UNR', wins: 0, losses: 0, ties: 0, finalRank: null },
            ...SUMMARY.franchises
        ]
    };
    const s = lastSeasonCard(gap, SEASON, 'k1', OPTS).standings;
    assertEq(s[s.length - 1].name, 'Unranked', 'last');
    assertEq(s[0].place, 1, 'and the real first place still leads');
});

test('standings does not resurrect a card that would have been absent', () => {
    // Fields are added and none removed, and the refusal is unchanged too. A first season, or one this league cannot be found in and that has no champion either, is still null.
    assertEq(lastSeasonCard(null, SEASON, 'k1', OPTS), null, 'no summary');
    assertEq(lastSeasonCard({ ...SUMMARY, franchises: [] }, SEASON, 'k1', OPTS), null, 'no franchises');
    assertEq(lastSeasonCard({ ...SUMMARY, finished: false }, SEASON, 'k1', OPTS), null, 'an unfinished season');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
