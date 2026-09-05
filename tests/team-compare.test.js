// Unit tests for the pure team comparison (team-compare.js, the team half / O22). Open tests/team-compare.test.html through any static server - green means every assertion held. Every expected value is hand-computed from tests/fixtures/team-compare.md.
import { teamCompare } from '../team-compare.js';

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
    // The box score carries the team's AVG for that matchup. Rebuilding it would be a second path to a number the payload hands over - and the components may not even be scored.
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

test('a POINTS league answers null - it has no per-category standing', () => {
    assertEq(teamCompare(MINE, THEIRS, ctx({ window: PLAYED_WINDOW, isPointsLeague: true, played: {} })),
        null, 'a table of weighted fragments answers nothing');
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

// Report ---------------------------------------------------------------------------
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
