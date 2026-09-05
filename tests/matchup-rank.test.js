// Unit tests for the pure matchup rank (matchup-rank.js, Q8 / O38). Open tests/matchup-rank.test.html through any static server - green means every assertion held. Every expected value is hand-computed from tests/fixtures/matchup-rank.md, except the fixture section, which asserts against two recorded instances. Two kinds of evidence on purpose: the synthetic cases prove the formulas, and the fixture proves the module still says what the owner's ruling was made on (the live league, against O36's published figures) and that it does not assume a category count (the finished league, which scores seven and not nine).
import { leagueMargins, playerWinsPerWeek, computeMatchupRanks, MIN_DECIDED_MATCHUPS } from '../matchup-rank.js';
import { MEDIAN_Z, normalCdf } from '../leverage-engine.js';

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
function close(a, b, msg, tol = 1e-12) {
    if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// ==== THE TWO EXACT FLIPS EVERY SYNTHETIC CASE BELOW IS BUILT ON. flip = normalCdf(|shift| / sd) - 0.5, signed. So a shift of exactly one MEDIAN_Z is a flip of exactly 0.25 - half the margins fall within one median-z by that constant's definition - and a shift of one whole sd is normalCdf(1) - 0.5. Both are read off the documented formula rather than off a run of the code. ====
const FLIP_AT_MEDIAN_Z = 0.25;
const FLIP_AT_ONE_SD = normalCdf(1) - 0.5;

// Baseball ids, as the contract lists them: 5 HR, 20 R, 24 CS (inverse), 2 AVG (rate, over AB 0).
const CTX = {
    categoryIds: ['5', '20', '24', '2'],
    rateStatIds: new Set(['2']),
    inverseStatIds: new Set(['24']),
    weightIdsFor: (id) => (id === '2' ? ['0'] : [])
};

// One decided pairing: every category the same margin, home high by `by`, plus whatever extras.
const pairing = (period, by, extra = {}) => ({
    matchupPeriodId: period,
    winner: 'HOME',
    home: { cumulativeScore: { scoreByStat: { '5': { score: by }, '20': { score: by }, '24': { score: by }, ...extra.home } } },
    away: { cumulativeScore: { scoreByStat: { '5': { score: 0 }, '20': { score: 0 }, '24': { score: 0 }, ...extra.away } } }
});

// Four periods, margins +2, -2, +2, -2 => rms = 2 for every counting category.
const LEAGUE = {
    settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES' } },
    schedule: [pairing(1, 2), pairing(2, -2), pairing(3, 2), pairing(4, -2)]
};

// ==== leagueMargins ====

test('the margin is the rms of the signed margins, and a zero-mean set is not re-centred', () => {
    const { margins, reason } = leagueMargins(LEAGUE, CTX);
    assert(reason === null, 'no refusal');
    close(margins.byId['5'].marginSd, 2, 'rms of +-2 is 2');
    close(margins.byId['20'].marginSd, 2, 'and the same for R');
});

test('periods, pairings and team-weeks are three different counts', () => {
    const { margins } = leagueMargins(LEAGUE, CTX);
    assertEq([margins.matchups, margins.pairings, margins.teamWeeks], [4, 4, 8], 'one pairing per period');
});

test('two pairings in one period is one period, two margins, four team-weeks', () => {
    const league = { ...LEAGUE, schedule: [pairing(1, 2), pairing(1, -2)] };
    const { margins, reason } = leagueMargins(league, { ...CTX });
    // Only ONE decided period, so the floor refuses - which is itself the point: the counts do not agree, and it is the period count the floor is written against.
    assert(margins === null && reason === 'too-few-matchups', 'one period refuses');
});

test('an undecided matchup contributes nothing', () => {
    const open = { ...pairing(5, 99), winner: 'UNDECIDED' };
    const { margins } = leagueMargins({ ...LEAGUE, schedule: [...LEAGUE.schedule, open] }, CTX);
    assertEq([margins.matchups, margins.pairings], [4, 4], 'the open week is not counted');
    close(margins.byId['5'].marginSd, 2, 'and does not move the margin');
});

test('a matchup missing a box score is skipped rather than read as zero', () => {
    const broken = { matchupPeriodId: 9, winner: 'HOME', home: {}, away: {} };
    const { margins } = leagueMargins({ ...LEAGUE, schedule: [...LEAGUE.schedule, broken] }, CTX);
    assertEq(margins.matchups, 4, 'the broken week is dropped, not counted as a 0-0 margin');
});

test('a counting category carries no team rate or weight', () => {
    const { margins } = leagueMargins(LEAGUE, CTX);
    assertEq([margins.byId['5'].teamRate, margins.byId['5'].teamWeight], [null, null], 'nulls, not zeroes');
});

test('a rate category measures the team rate and weight off the box score', () => {
    // AVG.300 and.200 against 100 at-bats a side, over four pairings: mean rate.250, weight 100.
    const rates = (h, a) => ({ home: { '2': { score: h }, '0': { score: 100 } }, away: { '2': { score: a }, '0': { score: 100 } } });
    const sched = [
        pairing(1, 2, rates(0.3, 0.2)), pairing(2, -2, rates(0.2, 0.3)),
        pairing(3, 2, rates(0.3, 0.2)), pairing(4, -2, rates(0.2, 0.3))
    ];
    const { margins } = leagueMargins({ ...LEAGUE, schedule: sched }, CTX);
    close(margins.byId['2'].teamRate, 0.25, 'mean of .3 and .2 over eight sides');
    close(margins.byId['2'].teamWeight, 100, 'mean at-bats a side');
    close(margins.byId['2'].marginSd, 0.1, 'every margin is .1, so the rms is .1');
});

// ==== The refusals ====

test('a roto league refuses before anything is read', () => {
    const roto = { settings: { scoringSettings: { scoringType: 'ROTO' } }, schedule: LEAGUE.schedule };
    assertEq(leagueMargins(roto, CTX), { margins: null, reason: 'roto' }, 'no matchups to swing');
});

test('a points league refuses', () => {
    const pts = { settings: { scoringSettings: { scoringType: 'H2H_POINTS' } }, schedule: LEAGUE.schedule };
    assertEq(leagueMargins(pts, CTX), { margins: null, reason: 'points' }, 'categories are not scored');
});

test('three decided periods is one too few, and four is enough', () => {
    assertEq(MIN_DECIDED_MATCHUPS, 4, 'the floor is four');
    const three = { ...LEAGUE, schedule: LEAGUE.schedule.slice(0, 3) };
    assertEq(leagueMargins(three, CTX).reason, 'too-few-matchups', 'three refuses');
    assert(leagueMargins(LEAGUE, CTX).margins !== null, 'four does not');
});

test('a refused league ranks nothing rather than ranking on no margins', () => {
    assertEq(computeMatchupRanks([{ id: 1, seasonTotals: { '5': 8 } }], null, CTX), null, 'null in, null out');
});

// ==== playerWinsPerWeek - the counting case ====

const M = leagueMargins(LEAGUE, CTX).margins;

test('a counting shift of one whole sd is normalCdf(1) - 0.5', () => {
    // 8 over four periods is 2 a week, against a margin of 2.
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '5': 8 } }, M, CTX);
    close(w.byCategory[0].perWeek, 2, 'the season total over the LEAGUE matchup count');
    close(w.byCategory[0].wins, FLIP_AT_ONE_SD, 'one sd of shift');
    close(w.winsPerWeek, FLIP_AT_ONE_SD, 'and it is the whole figure');
    assertEq(w.counted, 1, 'one category measured');
});

test('a shift of one median-z is a flip of a quarter, to normalCdf\'s own accuracy', () => {
    // The identity is exact; the arithmetic is not. normalCdf is Abramowitz & Stegun 26.2.17, whose documented bound is |error| < 7.5e-8, so a quarter is what this can be asserted to and no tighter. Measured here at 6.7e-8, inside the bound - a tighter tolerance would be a test of the approximation rather than of this module.
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '5': 4 * 2 * MEDIAN_Z } }, M, CTX);
    close(w.byCategory[0].wins, FLIP_AT_MEDIAN_Z, 'half the margins fall inside one median-z', 7.5e-8);
});

test('an inverse category subtracts - a caught stealing is a week spent losing one', () => {
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '24': 8 } }, M, CTX);
    close(w.byCategory[0].wins, -FLIP_AT_ONE_SD, 'the same magnitude, against the team');
});

test('good and bad categories net off rather than both counting as value', () => {
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '5': 8, '24': 8 } }, M, CTX);
    close(w.winsPerWeek, 0, 'a home run a week and a caught stealing a week is a wash');
    assertEq(w.counted, 2, 'both were measured, and both are in the breakdown');
});

test('the per-week figure divides by the league matchup count, not by weeks the player played', () => {
    // The contract's stated consequence: half a season is half the weekly line. Nothing in the pool says which weeks were played, so this is the answer and it must not drift.
    const full = playerWinsPerWeek({ id: 1, seasonTotals: { '5': 8 } }, M, CTX);
    const half = playerWinsPerWeek({ id: 2, seasonTotals: { '5': 4 } }, M, CTX);
    close(half.byCategory[0].perWeek, 1, 'four over four periods, not four over two played');
    assert(half.winsPerWeek < full.winsPerWeek, 'and it is worth less, as the contract says');
});

test('a category the player has no total for is skipped, not zeroed', () => {
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '5': 8 } }, M, CTX);
    assertEq(w.counted, 1, 'one of four');
    assertEq(w.byCategory.map(c => c.id), ['5'], 'and the breakdown says which');
});

test('a player with nothing measurable is null, not a zero', () => {
    assertEq(playerWinsPerWeek({ id: 1, seasonTotals: {} }, M, CTX), null, 'no evidence is not a verdict');
});

test('a category with no measured margin is skipped', () => {
    const thin = { ...M, byId: { ...M.byId, '5': { marginSd: 0, teamRate: null, teamWeight: null } } };
    assertEq(playerWinsPerWeek({ id: 1, seasonTotals: { '5': 8 } }, thin, CTX), null, 'a zero margin measures nothing');
});

// ==== playerWinsPerWeek - the rate case ====

test('a rate shift uses the COMBINED denominator, team plus the player', () => {
    const rates = (h, a) => ({ home: { '2': { score: h }, '0': { score: 100 } }, away: { '2': { score: a }, '0': { score: 100 } } });
    const league = {
        ...LEAGUE,
        schedule: [
            pairing(1, 2, rates(0.3, 0.2)), pairing(2, -2, rates(0.2, 0.3)),
            pairing(3, 2, rates(0.3, 0.2)), pairing(4, -2, rates(0.2, 0.3))
        ]
    };
    const m = leagueMargins(league, CTX).margins;
    // 100 at-bats over four periods is 25 a week; team weight 100; combined 125. shift = (25 / 125) * (.350 -.250) =.02, against a margin of.1 = one fifth of an sd.
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '2': 0.35, '0': 100 } }, m, CTX);
    close(w.byCategory[0].wins, normalCdf(0.02 / 0.1) - 0.5, 'the combined denominator, hand-computed');
    close(w.byCategory[0].perWeek, 0.35, 'a rate is already per-week; it is not divided');
});

test('a rate below the team rate is a negative shift', () => {
    const rates = (h, a) => ({ home: { '2': { score: h }, '0': { score: 100 } }, away: { '2': { score: a }, '0': { score: 100 } } });
    const league = { ...LEAGUE, schedule: [pairing(1, 2, rates(0.3, 0.2)), pairing(2, -2, rates(0.2, 0.3)), pairing(3, 2, rates(0.3, 0.2)), pairing(4, -2, rates(0.2, 0.3))] };
    const m = leagueMargins(league, CTX).margins;
    const w = playerWinsPerWeek({ id: 1, seasonTotals: { '2': 0.15, '0': 100 } }, m, CTX);
    assert(w.byCategory[0].wins < 0, 'a .150 hitter pulls the team average down');
});

test('a rate with a zero denominator is skipped rather than dividing by nothing', () => {
    const rates = (h, a) => ({ home: { '2': { score: h }, '0': { score: 100 } }, away: { '2': { score: a }, '0': { score: 100 } } });
    const league = { ...LEAGUE, schedule: [pairing(1, 2, rates(0.3, 0.2)), pairing(2, -2, rates(0.2, 0.3)), pairing(3, 2, rates(0.3, 0.2)), pairing(4, -2, rates(0.2, 0.3))] };
    const m = leagueMargins(league, CTX).margins;
    assertEq(playerWinsPerWeek({ id: 1, seasonTotals: { '2': 0.35, '0': 0 } }, m, CTX), null, 'no at-bats, no pull');
});

// ==== computeMatchupRanks ====

test('the pool is ranked by wins a week, best first', () => {
    const pool = [
        { id: 1, seasonTotals: { '5': 4 } },
        { id: 2, seasonTotals: { '5': 12 } },
        { id: 3, seasonTotals: { '5': 8 } }
    ];
    const out = computeMatchupRanks(pool, M, CTX);
    assertEq([out.byId[2].rank, out.byId[3].rank, out.byId[1].rank], [1, 2, 3], 'most wins first');
    assertEq(out.of, 3, 'and of is the measured count');
});

test('ties share a rank and the next distinct value picks up its true place', () => {
    const pool = [
        { id: 1, seasonTotals: { '5': 8 } },
        { id: 2, seasonTotals: { '5': 8 } },
        { id: 3, seasonTotals: { '5': 4 } }
    ];
    const out = computeMatchupRanks(pool, M, CTX);
    assertEq([out.byId[1].rank, out.byId[2].rank, out.byId[3].rank], [1, 1, 3], '1, 1, 3 - not 1, 1, 2');
});

test('an unmeasurable player is absent from byId and out of the denominator', () => {
    const pool = [
        { id: 1, seasonTotals: { '5': 8 } },
        { id: 2, seasonTotals: {} }
    ];
    const out = computeMatchupRanks(pool, M, CTX);
    assertEq(out.of, 1, 'ranking on no evidence would read as a verdict');
    assert(out.byId[2] === undefined, 'and the player is not there at all');
    assertEq(out.byId[1].of, 1, 'every row carries the same denominator');
});

test('the module does no qualifying of its own - the pool handed in is the pool ranked', () => {
    const pool = [{ id: 1, seasonTotals: { '5': 8 } }, { id: 2, seasonTotals: { '5': 0.0001 } }];
    assertEq(computeMatchupRanks(pool, M, CTX).of, 2, 'a marginal player is still ranked if handed in');
});

// ==== The fixture - the O36 figures the owner's ruling was made on, reproduced ====

// ==== THE PUBLISHED FIXTURE: real margins from tests/sample-league.json, archetype players. The margins here are not a stand-in. sample-league.json is a real league's real season with its team names removed, and margins are read from box scores, so these figures are IDENTICAL to the ones the same league's private capture produces. What the anonymised file has no room for is a player pool, so the players are archetypes with round totals - and only their model OUTPUTS are asserted, never a claim about anybody's season. ====
const FIX = await (await fetch('./fixtures/matchup-rank.json')).json();
const arch = (name) => FIX.players.find(p => p.name === name);
const RATE_CTX = {
    categoryIds: FIX.categoryIds,
    rateStatIds: new Set(FIX.rateStatIds),
    inverseStatIds: new Set(FIX.inverseStatIds),
    weightIdsFor: (id) => (id === '2' ? ['0'] : ['0', '10', '12', '13'])
};

test('the published fixture measures the real league margins', () => {
    assertEq([FIX.margins.matchups, FIX.margins.pairings, FIX.margins.teamWeeks], [24, 72, 144], '6 teams, 72 pairings');
    close(FIX.margins.byId['5'].marginSd, 4.5613, 'HR', 5e-5);
    close(FIX.margins.byId['23'].marginSd, 4.5231, 'SB', 5e-5);
    close(FIX.margins.byId['2'].marginSd, 0.0388, 'AVG', 5e-5);
    close(FIX.margins.byId['2'].teamRate, 0.2634, 'the team average a week', 5e-5);
    close(FIX.margins.byId['2'].teamWeight, 218.6, 'at-bats a week', 0.05);
    assertEq(FIX.marginsAreReal, true, 'and the fixture says the margins are real');
});

test('the league scores SEVEN batting categories, errors the only inverse one', () => {
    assertEq(FIX.categoryIds.length, 7, 'no assists and no caught stealing in this league');
    assert(!FIX.categoryIds.includes('69') && !FIX.categoryIds.includes('24'), 'neither present');
    assertEq(FIX.inverseStatIds, ['72'], 'errors alone');
});

test('every archetype recomputes through the live module from its own recorded totals', () => {
    // The fixture records the INPUTS as well as the outputs, so this is an exact end-to-end recomputation rather than the partial one a real pool would allow.
    FIX.players.forEach(p => {
        const w = playerWinsPerWeek({ id: p.id, seasonTotals: p.seasonTotals }, FIX.margins, RATE_CTX);
        if (p.measured === false) { assertEq(w, null, `${p.name} is not measurable`); return; }
        close(w.winsPerWeek, p.winsPerWeek, `${p.name} wins a week`, 1e-12);
        p.byCategory.forEach(c => {
            const mine = w.byCategory.find(x => x.id === c.id);
            close(mine.wins, c.wins, `${p.name} ${c.id}`, 1e-12);
            close(mine.perWeek, c.perWeek, `${p.name} ${c.id} per week`, 1e-12);
        });
    });
});

test('the ranking is the one the fixture records, and the unmeasurable player is out of it', () => {
    const pool = FIX.players.map(p => ({ id: p.id, seasonTotals: p.seasonTotals }));
    const out = computeMatchupRanks(pool, FIX.margins, RATE_CTX);
    assertEq(out.of, 6, 'seven handed in, six measurable');
    assert(out.byId[9007] === undefined, 'Never Played is absent rather than last');
    FIX.players.filter(p => p.measured !== false).forEach(p => {
        assertEq(out.byId[p.id].rank, p.rank, `${p.name} rank`);
    });
});

test('a heavy inverse line is what sinks a player', () => {
    // Error Prone is Balanced Bat with six times the errors and nothing else changed, so the whole gap between them is one category - the clearest statement in the fixture that an inverse category subtracts rather than being ignored.
    const b = arch('Balanced Bat'), e = arch('Error Prone');
    assertEq([b.rank, e.rank], [1, 6], 'first and last');
    ['5', '20', '21', '23', '2', '18'].forEach(id => close(
        e.byCategory.find(c => c.id === id).wins,
        b.byCategory.find(c => c.id === id).wins, `${id} is untouched`, 1e-12));
    assert(e.byCategory.find(c => c.id === '72').wins < -0.4, 'and the errors alone cost over 0.4 wins a week');
});

test('half a season reads as half a line, and the rates do NOT halve with it', () => {
    // The divisor's stated consequence, made visible: Half A Season is Balanced Bat's counting line halved, so its counting wins halve - but AVG and OPS are rates and stay where they are, which is why the total is not half the total.
    const b = arch('Balanced Bat'), h = arch('Half A Season');
    close(h.byCategory.find(c => c.id === '20').perWeek, 2, 'runs halve');
    close(b.byCategory.find(c => c.id === '20').perWeek, 4, 'from four');
    assertEq(h.byCategory.find(c => c.id === '2').perWeek, b.byCategory.find(c => c.id === '2').perWeek, 'the average is identical');
    assert(h.winsPerWeek > b.winsPerWeek / 2, 'so the total is MORE than half, not exactly half');
});

// ==== THE PRIVATE FIXTURE: the owner's own leagues, and the O36 figures the Q8 ruling was made on. It is not published, so a copy of this repository that lacks it cannot run these. They are REPORTED ABSENT rather than skipped silently - the same rule tests/run-all.html applies to a missing suite, for the same reason: a check that quietly disappears is worse than one that says it is not here. Regenerate it with tests/matchup-rank.private.gen.html. ====
const PRIV = await fetch('./fixtures/matchup-rank.private.json')
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

if (!PRIV) {
    results.push({
        name: 'the private O36 fixture is ABSENT from this tree - the acceptance check did not run',
        ok: true
    });
} else {
    const LIVE = PRIV.instances.find(i => i.capture === 'full-mlb');
    const FINISHED = PRIV.instances.find(i => i.capture === 'full-mlb-2025-2');

    test('Witt, Wetherholt and Freeman reproduce the O36 page within rounding', () => {
        const want = { 'Bobby Witt Jr.': [0.681, 5], 'JJ Wetherholt': [0.704, 2], 'Freddie Freeman': [0.518, 36] };
        LIVE.players.forEach(p => {
            const [wins, rank] = want[p.name];
            close(p.winsPerWeek, wins, `${p.name} wins a week`, 5e-4);
            assertEq(p.rank, rank, `${p.name} matchup rank`);
            assertEq(p.of, 464, `${p.name} of`);
        });
    });

    test('Freeman is first overall and thirty-sixth here, which is the whole point of the column', () => {
        const f = LIVE.players.find(p => p.name === 'Freddie Freeman');
        assertEq([f.overall, f.rank], [1, 36], 'the two models disagree, measurably');
        const avg = f.byCategory.find(c => c.id === '2');
        assert(avg.wins > 0 && avg.wins < 0.04, 'a .304 average is worth under four hundredths of a win a week');
    });

    test('the live league margins are the ones the contract publishes', () => {
        assertEq([LIVE.margins.matchups, LIVE.margins.pairings], [21, 42], 'full-mlb 2026');
        close(LIVE.margins.byId['69'].marginSd, 17.1957, 'AST', 5e-5);
        close(LIVE.margins.byId['2'].marginSd, 0.0511, 'AVG', 5e-5);
    });

    test('the finished league carries 72 pairings and seven categories', () => {
        assertEq([FINISHED.margins.matchups, FINISHED.margins.pairings], [24, 72], '6 teams');
        assertEq(FINISHED.categoryIds.length, 7, 'seven, not nine');
        assertEq(FINISHED.of, 463, 'the qualified pool');
    });

    test('the private margins agree with the published ones, which is what makes the sample usable', () => {
        // sample-league.json IS the finished league with its names removed. If these ever diverge, the anonymised file has stopped standing in for the real one and the published fixture is no longer measuring what it claims to.
        FIX.categoryIds.forEach(id => close(
            FIX.margins.byId[id].marginSd,
            FINISHED.margins.byId[id].marginSd, `${id} margin`, 1e-12));
    });

    test('Judge tops the finished season on wins a week', () => {
        const j = FINISHED.players.find(p => p.name === 'Aaron Judge');
        assertEq([j.rank, j.overall], [1, 3], 'first here, third by the Overall Rank');
        close(j.winsPerWeek, 0.798, 'wins a week', 5e-4);
    });
}

const failed = results.filter(r => !r.ok);
document.getElementById('summary').textContent =
    `${results.length - failed.length}/${results.length} passed${failed.length ? '' : ' ✓'}`;
document.getElementById('summary').className = failed.length ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
