// Unit tests for the pure team comparison (team-compare.js). Open tests/team-compare.test.html through any static server; green means every assertion held. Every expected value is hand-computed from tests/fixtures/team-compare.md.
import { teamCompare, startStrip, categoryWeights } from '../src/engines/team-compare.js';

// Amendment 4's instance: hand-built, synthetic, its expectation computed by hand in the contract.
const POINTS_FIX = await (await fetch('./fixtures/team-compare-points.json')).json();

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
function close(a, b, msg, tol = 1e-9) {
    if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// ==== Baseball ids: 0 AB, 1 H, 2 AVG (rate), 5 HR, 20 R, 47 ERA (rate, inverse), 45 ER, 34 outs. ====
const MINE = { teamId: 3, name: 'Fixture Nine' };
const THEIRS = { teamId: 7, name: 'Rival Nine' };
const RATE_COMPONENTS = [
    { out: '2', num: ['1'], den: ['0'] },                 // AVG = H/AB
    { out: '47', num: ['45'], den: ['34'], scale: 27 }    // ERA = ER*9/IP, IP = outs/3
];
const BASE = {
    scoredIds: ['5', '20', '2', '47'],
    statLabels: { '5': 'HR', '20': 'R', '2': 'AVG', '47': 'ERA' },
    lowerIsBetterIds: new Set(['47']),
    rateIds: new Set(['2', '47']),
    rateComponents: RATE_COMPONENTS
};
const ctx = (over = {}) => ({ ...BASE, ...over });
const PLAYED_WINDOW = { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160, 161, 162], asOf: 162 };
const PROJ_WINDOW = { kind: 'projected', label: 'Rest of season', matchup: null, periods: [163, 164, 165], asOf: 162 };
const row = (out, id) => out.rows.find(r => r.id === id);

// ==== A played window ====

test('a played window reads the team totals the payload already carries', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 31, '20': 80, '2': 0.271, '47': 3.10 } },
                  7: { 22: { '5': 24, '20': 92, '2': 0.259, '47': 3.40 } } }
    }));
    assertEq(row(out, '5').mine, 31, 'my home runs');
    assertEq(row(out, '5').theirs, 24, 'theirs');
    assertEq(row(out, '5').edge, 7, 'the edge is mine minus theirs');
    assertEq(out.window.kind, 'played', 'the window says what it is');
    assertEq(row(out, '5').projected, false, 'and so does every row');
});

test('a played rate is ESPN\'s own figure, not a rebuild', () => {
    // The box score carries the team's AVG for that matchup. Rebuilding it would be a second path to a figure the payload hands over, and the components may not even be scored.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '2': 0.271 } }, 7: { 22: { '2': 0.259 } } }
    }));
    close(row(out, '2').mine, 0.271, 'straight from the payload');
    assertEq(row(out, '2').rate, true, 'and marked as a rate, which is never summed');
});

test('DIRECTION is applied once, and only to `leader`', () => {
    // ERA is the category where getting this wrong is guaranteed: 3.10 BEATS 3.40, and the edge still reads mine minus theirs so a reader of the number never has to know the rule.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '47': 3.10, '5': 31 } }, 7: { 22: { '47': 3.40, '5': 24 } } }
    }));
    const era = row(out, '47');
    close(era.edge, -0.30, 'the edge is NOT flipped for direction');
    assertEq(era.leader, 'mine', 'but the lower ERA leads');
    assertEq(era.lowerIsBetter, true, 'and the row carries the fact it was judged on');
    // A normal category, for contrast.
    assertEq(row(out, '5').leader, 'mine', 'more home runs also leads');
    assertEq(row(out, '5').lowerIsBetter, false, 'the other way');
});

test('a tie is its own answer, not a win for either side', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 24 } }, 7: { 22: { '5': 24 } } }
    }));
    assertEq([row(out, '5').edge, row(out, '5').leader], [0, 'tied'], 'zero and tied');
});

test('a category neither side has reads null, and null has no leader', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 10 } }, 7: { 22: { '5': 8 } } }
    }));
    const r = row(out, '20');
    assertEq([r.mine, r.theirs, r.edge, r.leader], [null, null, null, null], 'absent, not zero');
});

test('a MULTI-matchup played window cannot use a per-matchup rate', () => {
    // Averaging two matchups' batting averages is not the batting average of the two, and summing them is nonsense. With components present it rebuilds; here AB and H are not in the totals, so the cell refuses.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Both', matchup: null, periods: [160, 167], asOf: 167 },
        played: { 3: { 21: { '5': 4, '2': 0.300 }, 22: { '5': 6, '2': 0.200 } },
                  7: { 21: { '5': 3, '2': 0.280 }, 22: { '5': 5, '2': 0.240 } } }
    }));
    assertEq(row(out, '5').mine, 10, 'counting stats sum across matchups');
    assertEq(row(out, '2').mine, null, 'the rate refuses rather than averaging two averages');
});

test('a multi-matchup played window REBUILDS a rate when its components are there', () => {
    // 8 hits in 30 at-bats over two matchups is.2666..., which is NOT the mean of.250 and.278.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Both', matchup: null, periods: [160, 167], asOf: 167 },
        played: { 3: { 21: { '1': 4, '0': 16 }, 22: { '1': 4, '0': 14 } },
                  7: { 21: { '1': 3, '0': 15 }, 22: { '1': 3, '0': 15 } } }
    }));
    close(row(out, '2').mine, 8 / 30, 'rebuilt from the summed components');
    close(row(out, '2').theirs, 6 / 30, 'both sides');
});

// ==== A projected window ====

test('a projected window is per-game rates times the games in it', () => {
    // Mine: one player at 0.5 HR a game over 6 games = 3; another at 0.25 over 4 = 1. Total 4. Theirs: 0.4 over 5 = 2.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        projected: {
            3: [{ rates: { '5': 0.5 }, games: 6 }, { rates: { '5': 0.25 }, games: 4 }],
            7: [{ rates: { '5': 0.4 }, games: 5 }]
        }
    }));
    close(row(out, '5').mine, 4, 'three plus one');
    close(row(out, '5').theirs, 2, 'and theirs');
    assertEq(row(out, '5').projected, true, 'the row says it is projected');
    assertEq(out.window.kind, 'projected', 'and so does the window');
});

test('a projected RATE is rebuilt from components, never summed', () => {
    // Mine: 0.3 H and 1.0 AB per game over 10 games = 3 H, 10 AB ->.300. Theirs: 0.2 H and 1.0 AB over 10 = 2 H, 10 AB ->.200. Summing per-game averages would have given 3.0 and 2.0, which are not batting averages.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        projected: {
            3: [{ rates: { '1': 0.3, '0': 1.0 }, games: 10 }],
            7: [{ rates: { '1': 0.2, '0': 1.0 }, games: 10 }]
        }
    }));
    close(row(out, '2').mine, 0.3, 'H over AB');
    close(row(out, '2').theirs, 0.2, 'both sides');
    assertEq(row(out, '2').leader, 'mine', 'and the higher average leads');
});

test('a projected rate with a SCALE reproduces the real formula', () => {
    // ERA = ER * 9 / IP, and IP is outs/3, so the stored scale is 27. 0.4 ER and 3 outs a game over 10 games = 4 ER, 30 outs = 10 innings -> 3.60.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        projected: {
            3: [{ rates: { '45': 0.4, '34': 3 }, games: 10 }],
            7: [{ rates: { '45': 0.5, '34': 3 }, games: 10 }]
        }
    }));
    close(row(out, '47').mine, 3.6, 'four earned runs in ten innings');
    close(row(out, '47').theirs, 4.5, 'and five');
    assertEq(row(out, '47').leader, 'mine', 'the lower earned-run average leads');
});

test('a projected rate with NO component mapping reads null, never a sum', () => {
    // A summed rate is a confident wrong number rather than a missing one.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        rateComponents: [],                       // nothing can be rebuilt
        projected: { 3: [{ rates: { '2': 0.3 }, games: 10 }], 7: [{ rates: { '2': 0.2 }, games: 10 }] }
    }));
    assertEq(row(out, '2').mine, null, 'unmapped, so unanswerable');
    assertEq(row(out, '2').edge, null, 'and no edge either');
});

test('a zero denominator is no rate at all, not a zero', () => {
    // A pitcher who has thrown no innings has no ERA; printing 0.00 would make that arm the best in the league, and in an inverse category that is the most dangerous possible wrong answer.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        projected: { 3: [{ rates: { '45': 0.4, '34': 0 }, games: 10 }], 7: [{ rates: { '45': 0.5, '34': 3 }, games: 10 }] }
    }));
    assertEq(row(out, '47').mine, null, 'no innings, no ERA');
    assertEq(row(out, '47').leader, null, 'and nothing to lead with');
});

test('a player with no games in the window contributes nothing', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PROJ_WINDOW,
        projected: { 3: [{ rates: { '5': 0.5 }, games: 6 }, { rates: { '5': 9 }, games: 0 }],
                     7: [{ rates: { '5': 0.4 }, games: 5 }] }
    }));
    close(row(out, '5').mine, 3, 'the idle player is not counted');
});

// ==== Refusals ====

test('a POINTS league WITHOUT ITS WEIGHTS answers null (refusal 1, as amendment 4 left it)', () => {
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, isPointsLeague: true, played: {} })),
        null, 'values with no points would be the table of fragments');
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, isPointsLeague: true, weights: 'no',
        played: { 3: { 22: { 5: 1 } }, 7: { 22: { 5: 2 } } } })), null, 'weights that are not a table are no weights');
});

// ==== A points league, per category, in points ====
const pointsCtx = (over = {}) => ({ ...POINTS_FIX.ctx, isPointsLeague: true, ...over });
const POINTS_OUT = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx());

test('points: the whole instance, as hand-computed in the contract', () => {
    assertEq(POINTS_OUT, POINTS_FIX.expected, 'team-compare-points.json');
});

test('points: a row is the value, the weight and what each side earned', () => {
    const r = row(POINTS_OUT, '3');
    // 240 * 0.25 = 60; 300 * 0.25 = 75; 60 - 75 = -15; the value edge stays 240 - 300.
    assertEq([r.weight, r.mine, r.theirs, r.minePoints, r.theirPoints, r.pointsEdge, r.edge],
        [0.25, 240, 300, 60, 75, -15, -60], 'passing yards');
    assertEq(r.leader, 'theirs', 'the side that earned more points');
});

test('points: a negative weight leads on fewer, with no direction table', () => {
    const r = row(POINTS_OUT, '20');
    // 1 * -2 = -2 against 2 * -2 = -4: -2 is more.
    assertEq([r.minePoints, r.theirPoints, r.pointsEdge, r.leader, r.lowerIsBetter, r.edge],
        [-2, -4, 2, 'mine', true, -1], 'one interception leads two');
});

test('points: the rows add up to each side, and the total says what it is missing', () => {
    const sum = (key) => POINTS_OUT.rows.reduce((s, r) => s + (r[key] === null ? 0 : r[key]), 0);
    assertEq([sum('minePoints'), sum('theirPoints')], [89.5, 84], '60+18-2+10.5+3 and 75+6-4+7+0');
    assertEq(POINTS_OUT.points, { mine: { total: 89.5, missing: 1 }, theirs: { total: 84, missing: 1 }, edge: 5.5 },
        'the foot is the sum of the rows');
});

test('points: no weight is no points and no leader, and the values stay', () => {
    const r = row(POINTS_OUT, '60');
    assertEq([r.mine, r.theirs, r.edge, r.weight, r.minePoints, r.theirPoints, r.pointsEdge, r.leader],
        [4, 9, -5, null, null, null, null, null], 'nobody knows which way it runs');
});

test('points: a weight of 0 is a weight - both earn nothing, tied, not missing', () => {
    const out = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx({
        scoredIds: ['3'], weights: { 3: 0 } }));
    const r = row(out, '3');
    assertEq([r.minePoints, r.theirPoints, r.pointsEdge, r.leader, r.lowerIsBetter], [0, 0, 0, 'tied', false], 'zero each');
    assertEq(out.points, { mine: { total: 0, missing: 0 }, theirs: { total: 0, missing: 0 }, edge: 0 }, 'counted, worth 0');
});

test('points: a value one side lacks gives that row no points on either side', () => {
    const out = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx({
        scoredIds: ['25'], played: { 3: { 2: { 25: 3 } }, 7: { 2: {} } } }));
    const r = row(out, '25');
    // Mine: 3 * 6 = 18. Theirs has no figure, so no points and no edge; my 18 still counts in mine.
    assertEq([r.minePoints, r.theirPoints, r.pointsEdge, r.leader], [18, null, null, null], 'a missing figure is not a zero');
    assertEq(out.points, { mine: { total: 18, missing: 0 }, theirs: { total: 0, missing: 1 }, edge: 18 }, 'and the total says so');
});

test('points: a rate row is never weighted', () => {
    const out = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx({
        scoredIds: ['3'], rateIds: new Set(['3']) }));
    const r = row(out, '3');
    assertEq([r.mine, r.minePoints, r.theirPoints, r.leader, r.rate], [240, null, null, null, true], 'unmeasured, so unsaid');
});

test('points: a projected window weights the projected value', () => {
    // Mine: 100 yards a game over 2 games = 200, * 0.25 = 50; half a touchdown a game = 1, * 6 = 6. Theirs: 80 a game over 3 games = 240, * 0.25 = 60; no touchdown rate at all.
    const out = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx({
        window: { kind: 'projected', label: 'Matchup 3', matchup: 3, periods: [3], asOf: 2 },
        scoredIds: ['3', '25'],
        projected: { 3: [{ games: 2, rates: { 3: 100, 25: 0.5 } }], 7: [{ games: 3, rates: { 3: 80 } }] }
    }));
    assertEq([row(out, '3').minePoints, row(out, '3').theirPoints, row(out, '3').pointsEdge, row(out, '3').projected],
        [50, 60, -10, true], 'yards');
    assertEq([row(out, '25').minePoints, row(out, '25').theirPoints, row(out, '25').leader], [6, null, null], 'touchdowns');
    assertEq(out.points, { mine: { total: 56, missing: 0 }, theirs: { total: 60, missing: 1 }, edge: -4 }, '50 + 6 against 60');
});

test('points: a league that is not a points league carries none of the five keys', () => {
    const out = teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, weights: { 5: 4 },
        played: { 3: { 22: { 5: 1 } }, 7: { 22: { 5: 2 } } } }));
    assertEq('points' in out, false, 'no foot');
    assertEq(['weight', 'minePoints', 'theirPoints', 'pointsEdge'].some(k => k in row(out, '5')), false, 'no row fields');
});

// ==== Each row says its role group, with one hand-computed case per sport ====
const groups = (out) => out.rows.map(r => r.group);

test('group: baseball - a pitching category is secondary, a hitting one primary', () => {
    // The base ctx scores HR(5), R(20), AVG(2), ERA(47); of those only 47 is a pitching id.
    const out = teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, secondaryIds: new Set(['47', '41', '48']),
        played: { 3: { 22: { 5: 1, 20: 4, 2: 0.25, 47: 3.5 } }, 7: { 22: { 5: 2, 20: 4, 2: 0.3, 47: 4 } } } }));
    assertEq(groups(out), ['primary', 'primary', 'primary', 'secondary'], 'HR, R, AVG, then ERA');
    assertEq(Object.keys(out.rows[0]).slice(0, 4), ['id', 'label', 'group', 'mine'], 'after the label');
});

test('group: hockey - interleaved ids keep the caller order; the group rides on the row', () => {
    // W(1) and SV(10) are goalie ids, G(13) and A(14) skaters, in the order a league listed them.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW, scoredIds: ['1', '13', '10', '14'], statLabels: { 1: 'W', 13: 'G', 10: 'SV', 14: 'A' },
        rateIds: new Set(), lowerIsBetterIds: new Set(), secondaryIds: ['1', '10', '11'],
        played: { 3: { 22: { 1: 2, 13: 9, 10: 80, 14: 12 } }, 7: { 22: { 1: 1, 13: 11, 10: 95, 14: 12 } } } }));
    assertEq(out.rows.map(r => r.id), ['1', '13', '10', '14'], 'not reordered here');
    assertEq(groups(out), ['secondary', 'primary', 'secondary', 'primary'], 'an array reads as a Set does');
    assertEq([row(out, '13').edge, row(out, '10').leader], [-2, 'theirs'], 'and nothing else about a row moved');
});

test('group: football - a points league groups too, and its totals are still every row', () => {
    const out = teamCompare(POINTS_FIX.mine, POINTS_FIX.theirs, pointsCtx({ secondaryIds: new Set([91]) }));
    assertEq(groups(out), ['primary', 'primary', 'primary', 'primary', 'secondary', 'primary'], 'only the D/ST item');
    assertEq(out.points, POINTS_FIX.expected.points, '89.5 against 84, across both groups');
});

test('group: no table handed in is null on every row, never a guess', () => {
    const played = { 3: { 22: { 5: 1 } }, 7: { 22: { 5: 2 } } };
    assertEq(groups(teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, played }))), [null, null, null, null], 'no secondaryIds');
    assertEq(groups(teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, played, secondaryIds: new Set() }))),
        ['primary', 'primary', 'primary', 'primary'], 'an EMPTY table is a table: everything is primary');
    assertEq(groups(POINTS_OUT), [null, null, null, null, null, null], 'the points instance passes none');
});

test('categoryWeights: the weight is not always `points`', () => {
    const w = categoryWeights([
        { statId: 3, points: 0.04 },                                    // no overrides
        { statId: 93, points: 6, pointsOverrides: { 16: 6 } },          // every override equal
        { statId: 91, points: 0, pointsOverrides: { 16: 3 } },          // a stat one slot earns
        { statId: 95, points: 0, pointsOverrides: { 16: 2, 17: 2 } },   // one distinct value
        { statId: 4, points: 6, pointsOverrides: { 0: 4 } },            // differs by slot
        { statId: 9, points: 0, pointsOverrides: { 16: 2, 17: 5 } },    // two values and no own
        { statId: 12, points: 0 },                                      // listed, worth nothing
        { points: 3 }, null                                             // not items at all
    ]);
    assertEq(w, { 3: 0.04, 4: null, 9: null, 12: 0, 91: 3, 93: 6, 95: 2 }, 'by the four rules, in order');
    assertEq(categoryWeights(null), {}, 'no items, no weights');
});

test('no opponent, or the same team twice, answers null', () => {
    assertEq(teamCompare(MINE, null, ctx({ window: PLAYED_WINDOW })), null, 'nobody to compare against');
    assertEq(teamCompare(MINE, { teamId: 3, name: 'me again' }, ctx({ window: PLAYED_WINDOW })), null, 'itself');
});

test('a window with no days answers null', () => {
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: { kind: 'played', periods: [] } })), null, 'no days');
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: null })), null, 'no window at all');
});

test('a projected window with no roster answers null', () => {
    // A pre-draft league has no team to project.
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: PROJ_WINDOW, projected: { 3: [], 7: [] } })),
        null, 'nobody on either side');
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: PROJ_WINDOW, projected: { 3: [{ rates: {}, games: 1 }] } })),
        null, 'and one side is not enough');
});

test('the window and both teams travel with the answer', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW, played: { 3: { 22: { '5': 1 } }, 7: { 22: { '5': 0 } } }
    }));
    assertEq(out.window.label, 'Matchup 22', 'the label is pre-formatted here');
    assertEq(out.window.asOf, 162, 'and the period the figures are current to');
    assertEq([out.mine.name, out.theirs.name], ['Fixture Nine', 'Rival Nine'], 'both names');
});

/**
 * The opponent's workload. Every figure below is hand-computed from the two tables above it, which
 * are the shapes gamesByProTeamForMatchup and countProjectedStarts return.
 *
 * The window is periods 163 to 167, five days. Three clubs:
 *   club 10  plays 163, 164, 165           3 games
 *   club 20  plays 165, 166                2 games
 *   club 30  plays 163, 164, 165, 166, 167 5 games
 */
const W_PERIODS = [163, 164, 165, 166, 167];
const CLUB_GAMES = new Map([
    [10, { games: 3, byPeriod: new Map([[163, 1], [164, 1], [165, 1]]) }],
    [20, { games: 2, byPeriod: new Map([[165, 1], [166, 1]]) }],
    [30, { games: 5, byPeriod: new Map([[163, 1], [164, 1], [165, 1], [166, 1], [167, 1]]) }]
]);
// Slots 4 and 5 start, 16 is the bench and 17 the injured list. They are baseball's own ids, and the model is told which are which.
const ACTIVE = new Set([4, 5]);
const IR = new Set([17]);

// mine: two active bats (clubs 10 and 20), one BENCHED bat on club 30, one bat on the IL, two active starters and one active reliever.
const MY_ROSTER = [
    { id: 1, slot: 4, proTeamId: 10, pitcher: false },
    { id: 2, slot: 5, proTeamId: 20, pitcher: false },
    { id: 3, slot: 16, proTeamId: 30, pitcher: false },
    { id: 4, slot: 17, proTeamId: 30, pitcher: false },
    { id: 5, slot: 4, proTeamId: 10, pitcher: true },
    { id: 6, slot: 5, proTeamId: 20, pitcher: true },
    { id: 7, slot: 4, proTeamId: 10, pitcher: true },
    // A BENCHED starter and a RESERVED one. Baseball lineups are set daily, so the bench arm's listed turn is a move away and counts; the reserved arm cannot be activated at all.
    { id: 8, slot: 16, proTeamId: 30, pitcher: true },
    { id: 9, slot: 17, proTeamId: 30, pitcher: true }
];
const THEIR_ROSTER = [
    { id: 11, slot: 4, proTeamId: 30, pitcher: false },
    { id: 12, slot: 17, proTeamId: 10, pitcher: false },
    { id: 13, slot: 17, proTeamId: 20, pitcher: false }
];
// Player 5 has two listed turns left inside ESPN's horizon; player 6 is a starter the horizon does not reach, so his count is the rotation-turn estimate; player 7 is a reliever and is in neither.
const STARTS = new Map([
    [5, { starts: 3, remaining: 2, games: [] }],
    [8, { starts: 2, remaining: 1, games: [] }],
    [9, { starts: 2, remaining: 2, games: [] }]
]);
const STARTERS = new Set([5, 6, 8, 9]);
const EXPECTED = (p, { projectedStarts, startsScheduled }) => {
    if (startsScheduled && projectedStarts !== null && p.id !== 6) return { count: projectedStarts, unit: 'starts' };
    if (p.id === 6) return { count: 0.4, unit: 'games' };
    return null;
};
const WORKLOAD = (over = {}) => ({
    byTeamGames: CLUB_GAMES, activeSlots: ACTIVE, irSlots: IR,
    startsByPlayer: STARTS, starterIds: STARTERS, expectedAppearances: EXPECTED,
    countsStarts: true,
    rosters: { 3: MY_ROSTER, 7: THEIR_ROSTER },
    ...over
});
const W_WINDOW = { kind: 'projected', label: 'Rest of season', matchup: null, periods: W_PERIODS, asOf: 162 };
const PROJ_ROSTERS = { 3: [{ seasonTotals: { '5': 6, '0': 100, '1': 30 } }], 7: [{ seasonTotals: { '5': 4, '0': 80, '1': 20 } }] };

test('workload: hitter games count ACTIVE seats only', () => {
    // Club 10's three plus club 20's two. The benched bat on club 30 would have added five, which is the whole point: his games are not games this lineup gets.
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    assertEq(out.mine.workload.hitterGames, 5, 'three plus two');
    assertEq(out.theirs.workload.hitterGames, 5, "their one active bat's club plays every day");
});

test('workload: an off day is a day the LINEUP has nobody playing', () => {
    // My active bats cover 163, 164, 165 (club 10) and 165, 166 (club 20), so 167 is empty: one off day out of five. Their single active bat is on club 30, which plays all five.
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    assertEq(out.mine.workload.offDays, 1, 'period 167');
    assertEq(out.theirs.workload.offDays, 0, 'club 30 plays every day of the window');
});

test('workload: the IL count is the reserve SLOT, never the injury', () => {
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    assertEq(out.mine.workload.il, 2, 'two reserved seats');
    assertEq(out.theirs.workload.il, 2, 'two');
});

test('workload: probable and estimated starts are kept apart', () => {
    // Two listed turns for player 5 and a 0.4 rotation-turn estimate for player 6, whose window runs past the day ESPN has posted to. Summing them into one number would claim ESPN had listed 2.4 starts.
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    const s = out.mine.workload.starts;
    close(s.probable, 3, 'two turns left for the active arm and one for the benched one');
    close(s.estimated, 0.4, 'and the rule estimates four tenths of one more');
    close(s.count, 3.4, 'the total says so');
});

test('workload: starts count the WHOLE STAFF, bench included, reserve excluded', () => {
    // The one place this band does not use the seat rule, and it is ruled rather than assumed: a baseball lineup is set daily, so a bench arm's listed turn is a move away rather than a hypothetical. The reserved arm cannot be activated without the move the IL slot prevents. Player 8 is benched with one turn left of two listed; player 9 is on the IL with two of two.
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    close(out.mine.workload.starts.probable, 3, "the bench arm's turn is in");
    close(out.mine.workload.starts.listed, 5, 'three listed for the active arm and two for the benched one');
    // The reserved arm's two turns are in neither figure, which is the assertion that matters.
    assert(out.mine.workload.starts.listed < 7, 'the IL arm is not counted');
});

test('workload: listed is every posted turn, played or not, and probable only what is left', () => {
    // They are different claims, and a header must not swap one for the other. Listed is what the staff has lined up across the window. Probable is what is still to come, which is the figure that pairs with estimated and with every other forward-looking number here.
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD() }));
    const s = out.mine.workload.starts;
    close(s.listed, 5, 'five turns posted');
    close(s.probable, 3, 'three of them still ahead');
});

test('workload: a reliever is not a start', () => {
    // Player 7 is an active pitcher on a club with three games and is in neither figure, because an appearance is not a rotation turn. Removing the two real starters must leave nothing.
    const only = { ...WORKLOAD(), rosters: { 3: [MY_ROSTER[6]], 7: THEIR_ROSTER } };
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: only }));
    assertEq(out.mine.workload.starts, { count: 0, probable: 0, estimated: 0, listed: 0 }, 'no rotation turns at all');
});

test('workload: a sport that does not count starts says null, not zero', () => {
    // Hockey and football. Zero would read as "they have no starts left", which is a claim about the schedule; null is the truth, which is that the question does not apply.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS, workload: WORKLOAD({ countsStarts: false })
    }));
    assertEq(out.mine.workload.starts, null, 'not a baseball question');
    assertEq(out.mine.workload.hitterGames, 5, 'and the games still count');
});

test('workload: no slot table means no SEATED answer, and it says so', () => {
    // The seated figures cannot be answered without knowing which slots are seats. A fallback that counted anyone not on the injured list would count the bench: this fixture's five would read ten with the bench bat's club included. The starts and the injured count are unaffected, since neither asks about seats.
    const { activeSlots, ...noSlots } = WORKLOAD();
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, workload: noSlots }));
    assertEq(out.mine.workload.hitterGames, null, 'blank, not a bench-inclusive number');
    assertEq(out.mine.workload.offDays, null, 'and no off-day count either');
    assertEq(out.mine.workload.il, 2, 'the IL count still stands');
    close(out.mine.workload.starts.probable, 3, 'and so do the starts');
});

test('workload: a caller that passes none gets exactly what it got before', () => {
    const out = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS }));
    assertEq(out.mine.workload, null, 'null, and no other field moves');
    assertEq(out.theirs.workload, null, 'on both sides');
});

// ==== THE SWING MARKER ====

const MARGINS = { byId: { '5': { marginSd: 3 }, '20': { marginSd: 8 }, '2': { marginSd: 0 } } };

test('swing: a row inside the league own margin is marked, outside it is not', () => {
    // Mine 8 home runs to their 6 is an edge of 2 against a measured margin of 3 - a swing. Runs 40 to 25 is 15 against 8, and no marker.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 8, '20': 40 } }, 7: { 22: { '5': 6, '20': 25 } } },
        margins: MARGINS
    }));
    assertEq(row(out, '5').swing, true, 'two home runs is inside three');
    assertEq(row(out, '20').swing, false, 'fifteen runs is not inside eight');
});

test('swing: exactly ON the margin is a swing', () => {
    // The boundary stated rather than left to a reader of the code: a category decided by three is a category a three-run lead can lose.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 9 } }, 7: { 22: { '5': 6 } } },
        margins: MARGINS
    }));
    assertEq(row(out, '5').swing, true, 'three against three');
});

test('swing: no margins at all is null on every row, never false', () => {
    // A roto league, a points league, or a season with too few decided matchups. "We did not measure" and "it is not close" are different answers and the renderer draws them differently.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 8 } }, 7: { 22: { '5': 6 } } }
    }));
    assertEq(row(out, '5').swing, null, 'nothing measured');
    assertEq(row(out, '20').swing, null, 'nor here');
});

test('swing: a category with no measurable margin of its own is null', () => {
    // marginSd 0 is not "decided by nothing"; it is a category the decided matchups could not measure, and dividing the league into swings on it would mark every row.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '1': 30, '0': 100 } }, 7: { 22: { '1': 20, '0': 100 } } },
        margins: MARGINS
    }));
    assertEq(row(out, '2').swing, null, 'AVG carries a zero margin');
});

test('swing: a row with no edge cannot swing', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: PLAYED_WINDOW,
        played: { 3: { 22: { '5': 8 } }, 7: { 22: {} } },
        margins: MARGINS
    }));
    assertEq(row(out, '20').swing, null, 'no figure on either side');
});

// The day strip. The listings are in countProjectedStarts' own shape per player: starts, remaining and games, where each game carries its period, opponent, side and whether it was played. Days 163 to 167 again, five of them.

const S_DATES = new Map([[163, 1000], [164, 2000], [166, 3000]]);
const S_ABBREV = (id) => ({ 20: 'LAA', 30: 'SEA' }[id] || null);
const S_MINE = [
    { id: 5, name: 'Ace', games: [
        { period: 163, opponentId: 20, isHome: true, played: true },
        { period: 167, opponentId: 30, isHome: false, played: false }
    ] },
    { id: 6, name: 'Second Arm', games: [{ period: 163, opponentId: 30, isHome: false, played: true }] }
];
const S_THEIRS = [
    { id: 11, name: 'Their Ace', games: [{ period: 166, opponentId: 20, isHome: true, played: false }] }
];

test('startStrip: every day of the window gets a row, including the empty ones', () => {
    // A caller pages this by week and a grid with holes in it is not a grid. Nobody pitches on 164 or 165 and both still appear, with empty lists rather than absent rows.
    const strip = startStrip(W_PERIODS, { mine: S_MINE, theirs: S_THEIRS }, {});
    assertEq(strip.length, 5, 'five days in, five rows out');
    assertEq(strip.map(r => r.period).join(','), '163,164,165,166,167', 'in window order');
    assertEq(strip[1].mine.length + strip[1].theirs.length, 0, 'day 164 is empty on both sides');
});

test('startStrip: both sides land on the same day and neither is privileged', () => {
    const strip = startStrip(W_PERIODS, { mine: S_MINE, theirs: S_THEIRS }, {});
    assertEq(strip[0].mine.map(s => s.name).join(','), 'Ace,Second Arm', 'two of mine on 163');
    assertEq(strip[0].theirs.length, 0, 'and none of theirs');
    assertEq(strip[3].theirs.map(s => s.name).join(','), 'Their Ace', 'day 166 is theirs alone');
    assertEq(strip[3].mine.length, 0, 'with nothing of mine');
});

test('startStrip: probable means STILL AHEAD, not "ESPN listed it"', () => {
    // Every listing countProjectedStarts collects is already a probable one, so the flag has to mean something else, and what a reader needs is forecast against result.
    const strip = startStrip(W_PERIODS, { mine: S_MINE, theirs: S_THEIRS }, {});
    assertEq(strip[0].mine[0].probable, false, 'day 163 has been thrown');
    assertEq(strip[4].mine[0].probable, true, 'day 167 has not');
});

test('startStrip: a day is dated from the SCHEDULE, never from the starts on it', () => {
    // The Schedule face's own hard-won rule. Day 165 has no start on it and is still dated null rather than missing; day 166 carries a date from the schedule though only the opponent pitches on it.
    const strip = startStrip(W_PERIODS, { mine: S_MINE, theirs: S_THEIRS }, { datesByPeriod: S_DATES });
    assertEq(strip.map(r => r.date).join(','), '1000,2000,,3000,', 'the schedule decides, not the roster');
});

test('startStrip: the opponent is formatted once, with its pieces beside it', () => {
    const strip = startStrip(W_PERIODS, { mine: S_MINE, theirs: S_THEIRS }, { abbrevOf: S_ABBREV });
    assertEq(strip[0].mine[0].opponent, 'vsLAA', 'home reads vs');
    assertEq(strip[4].mine[0].opponent, '@SEA', 'away reads at');
    assertEq([strip[4].mine[0].opponentId, strip[4].mine[0].isHome], [30, false], 'and the raw pieces survive');
});

test('startStrip: without the caller tables a row still says everything a renderer needs', () => {
    // No abbrevOf and no labelOf. A date's presentation depends on locale and a club's abbreviation is a table this module does not hold, so both are left null, and period, date, opponentId and isHome are all still there.
    const strip = startStrip(W_PERIODS, { mine: S_MINE }, {});
    assertEq([strip[0].label, strip[0].mine[0].opponent].join('|'), '|', 'null, not invented');
    assertEq(strip[0].mine[0].opponentId, 20, 'the id is the fact');
});

test('startStrip: labelOf is the callers own, and is handed the period and the date', () => {
    const strip = startStrip(W_PERIODS, { mine: S_MINE }, {
        datesByPeriod: S_DATES, labelOf: (p, d) => `${p}:${d ?? 'nodate'}`
    });
    assertEq(strip.map(r => r.label).join(','), '163:1000,164:2000,165:nodate,166:3000,167:nodate', 'both arguments');
});

test('startStrip: a start outside the window is dropped, and no window means no strip', () => {
    const outside = [{ id: 9, name: 'Elsewhere', games: [{ period: 999, opponentId: 20, isHome: true, played: false }] }];
    const strip = startStrip(W_PERIODS, { mine: outside }, {});
    assertEq(strip.reduce((n, r) => n + r.mine.length, 0), 0, 'nothing lands');
    assertEq(startStrip([], { mine: S_MINE }, {}).length, 0, 'and an empty window is an empty strip');
});

test('startStrip: a side the caller does not pass is an empty list, never a crash', () => {
    const strip = startStrip(W_PERIODS, { mine: S_MINE }, {});
    assertEq(strip[0].theirs.length, 0, 'no opponent supplied');
    assertEq(startStrip(W_PERIODS, {}, {}).every(r => !r.mine.length && !r.theirs.length), true, 'nor either');
});

// ==== The window's date range ====

const D_DATES = new Map([[164, 2000], [166, 3000]]);
const D_LABEL = (a, b, pa, pb) => `${a}-${b} (${pa}..${pb})`;

test('window.dates: the caller formats it, and it rides on the window', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS,
        datesByPeriod: D_DATES, rangeLabelOf: D_LABEL
    }));
    assertEq(out.window.dates, '2000-3000 (164..166)', 'both ends and both periods reach the caller');
});

test('window.dates: the ends are the DATED days, not the window edges', () => {
    // The window runs 163-167 and only 164 and 166 carry a date. Reading the label off the window's own first and last period would have lost the range entirely rather than shortening it.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS,
        datesByPeriod: D_DATES, rangeLabelOf: (a, b) => `${a}|${b}`
    }));
    assertEq(out.window.dates, '2000|3000', 'earliest and latest dated day');
});

test('window.dates: one dated day is a range of that day to itself', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS,
        datesByPeriod: new Map([[165, 42]]), rangeLabelOf: (a, b) => `${a}|${b}`
    }));
    assertEq(out.window.dates, '42|42', 'which is what a one-day window means');
});

test('window.dates: null whenever it cannot be said, never a guess', () => {
    const noTable = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, rangeLabelOf: D_LABEL }));
    assertEq(noTable.window.dates, null, 'no dates to read');
    const noLabel = teamCompare(MINE, THEIRS, ctx({ window: W_WINDOW, projected: PROJ_ROSTERS, datesByPeriod: D_DATES }));
    assertEq(noLabel.window.dates, null, 'no formatter, and this module will not invent one');
    const noneDated = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS, datesByPeriod: new Map([[999, 1]]), rangeLabelOf: D_LABEL
    }));
    assertEq(noneDated.window.dates, null, 'no day of this window is dated');
});

test('window.dates: a caller that formats nothing usable gets null, not an empty string', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: W_WINDOW, projected: PROJ_ROSTERS, datesByPeriod: D_DATES, rangeLabelOf: () => ''
    }));
    assertEq(out.window.dates, null, 'an empty label is no label');
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
