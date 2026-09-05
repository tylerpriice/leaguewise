// Unit tests for the projected basis. Open tests/projected-basis.test.html through any static server - green means every assertion held. The roto scorer is the REAL one, imported from rank-engine, because the whole claim of this module is that a projected standing is scored by the same engine a played one is. A stub here would test the stub.
import {
    projectedTeamSums, projectedValues, projectedRotoStandings, projectedPointsStandings, placeOf,
    lineFromCells, remainderLine, expectedAppearances
} from '../projected-basis.js';
import { rotoPointsForCategory } from '../rank-engine.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function assertClose(actual, expected, tol, msg) {
    if (actual === null || !(Math.abs(actual - expected) <= tol)) {
        throw new Error(`${msg}: got ${actual}, expected ${expected} +-${tol}`);
    }
}

const COMPONENTS = [{ out: '47', num: ['45'], den: ['34'], scale: 27 }];   // ERA = ER*9/IP
const CATS = [{ id: '5', inverse: false }, { id: '47', inverse: true }];
const CAT_IDS = ['5', '47'];

// Three rosters of two. Projected lines only - nobody has played.
const ROSTERS = {
    1: [{ projectedTotals: { '5': 30, '45': 60, '34': 900 } },
        { projectedTotals: { '5': 10 } }],
    2: [{ projectedTotals: { '5': 25, '45': 40, '34': 900 } },
        { projectedTotals: { '5': 5 } }],
    3: [{ projectedTotals: { '5': 12, '45': 80, '34': 900 } },
        { projectedTotals: { '5': 8 } }]
};

// ==== sums and values ====

test('projectedTeamSums: sums the PROJECTED line, components included', () => {
    const sums = projectedTeamSums(ROSTERS, { categoryIds: CAT_IDS, components: COMPONENTS });
    assertEq(sums[1]['5'], 40, 'forty home runs');
    assertEq(sums[1]['45'], 60, 'earned runs carried');
    assertEq(sums[1]['34'], 900, 'and outs, because the rate needs them');
});

test('projectedTeamSums: the caller decides what the projected line IS', () => {
    // The board reads its line through estimateUnprojected; this module must use whatever the caller already built rather than a second reading of the same player.
    const sums = projectedTeamSums({ 1: [{ estimated: { '5': 99 } }] },
        { categoryIds: ['5'], components: COMPONENTS, lineOf: (p) => p.estimated });
    assertEq(sums[1]['5'], 99, 'the caller line');
});

test('projectedValues: a rate is recomputed, not summed', () => {
    const sums = projectedTeamSums(ROSTERS, { categoryIds: CAT_IDS, components: COMPONENTS });
    const values = projectedValues(sums, CAT_IDS, COMPONENTS);
    assertClose(values[1]['47'], 60 * 27 / 900, 1e-9, 'team ERA is 1.80');
    assertEq(values[1]['5'], 40, 'home runs are just the sum');
});

// ==== the board's own line ====

test('lineFromCells: reads a board row by its displayed cells, in category order', () => {
    const row = { cells: [{ value: 30 }, { value: null }, { value: 2.5 }] };
    const line = lineFromCells(row, ['5', '47', '2']);
    assertEq(line['5'], 30, 'first category');
    assertEq(line['2'], 2.5, 'third category');
    assert(!('47' in line), 'a cell with no value contributes nothing rather than a zero');
});

test('lineFromCells: a row with no cells yields an empty line, not a throw', () => {
    assertEq(Object.keys(lineFromCells({}, ['5'])).length, 0, 'no cells');
    assertEq(Object.keys(lineFromCells(null, ['5'])).length, 0, 'no row');
});

test('lineFromCells: cells and totals DISAGREE for a two-way player, and cells win', () => {
    // Measured on the real capture: summing row.totals came out 1,696.08 against the board's own 1,699.66 in one category over 24 players, because a two-way player's row carries one group's totals while the CELLS merge the groups - each category drawn by whichever group scores it. Reading totals would have made a projected standing disagree with the board it is built from.
    const twoWay = { totals: { '5': 30, '47': 9.99 }, cells: [{ value: 30 }, { value: 3.10 }] };
    const fromCells = lineFromCells(twoWay, ['5', '47']);
    assertEq(fromCells['47'], 3.10, 'the pitching cell, not the batting line');
    assert(fromCells['47'] !== twoWay.totals['47'], 'and it differs from totals, which is the point');
});

// ==== roto standings ====

test('projectedRotoStandings: scored by the REAL roto engine, best category first', () => {
    const sums = projectedTeamSums(ROSTERS, { categoryIds: CAT_IDS, components: COMPONENTS });
    const values = projectedValues(sums, CAT_IDS, COMPONENTS);
    const table = projectedRotoStandings(values, CATS, rotoPointsForCategory);
    // Home runs 40 / 30 / 20 gives 3 / 2 / 1. ERA 1.80 / 1.20 / 2.40 - inverse, so team 2 is best: 2 gets 3, 1 gets 2, 3 gets 1. Totals: team 1 = 5, team 2 = 5, team 3 = 2.
    const byId = Object.fromEntries(table.map(r => [r.teamId, r.points]));
    assertEq(byId['1'], 5, 'three for home runs plus two for ERA');
    assertEq(byId['2'], 5, 'two plus three');
    assertEq(byId['3'], 2, 'one plus one');
    assertEq(table[table.length - 1].teamId, '3', 'and the weakest is last');
});

test('projectedRotoStandings: the per-category split sums to the total', () => {
    const sums = projectedTeamSums(ROSTERS, { categoryIds: CAT_IDS, components: COMPONENTS });
    const values = projectedValues(sums, CAT_IDS, COMPONENTS);
    projectedRotoStandings(values, CATS, rotoPointsForCategory).forEach(row => {
        const summed = Object.values(row.byCategory).reduce((a, b) => a + b, 0);
        assertClose(summed, row.points, 1e-9, `team ${row.teamId} split matches its total`);
    });
});

test('projectedRotoStandings: a team with NO figure parks below every real one', () => {
    // The engine's own rule, and the reason it is imported rather than reimplemented: an absent figure is not a zero, which in an inverse category would be the best mark on the board.
    const values = { 1: { '47': 3.5 }, 2: { '47': null }, 3: { '47': 4.5 } };
    const table = projectedRotoStandings(values, [{ id: '47', inverse: true }], rotoPointsForCategory);
    assertEq(table[table.length - 1].teamId, '2', 'the team with no ERA is last, not first');
});

// ==== points standings ====

test('projectedPointsStandings: the sum of the roster projections, highest first', () => {
    const table = projectedPointsStandings({
        1: [{ projectedAppliedTotal: 200 }, { projectedAppliedTotal: 150 }],
        2: [{ projectedAppliedTotal: 400 }]
    });
    assertEq(table[0].teamId, '2', 'four hundred leads');
    assertEq(table[0].points, 400, 'its total');
    assertEq(table[1].points, 350, 'and the other roster sums');
});

test('projectedPointsStandings: the caller owns the figure', () => {
    const table = projectedPointsStandings({ 1: [{ mine: 12 }] }, (p) => p.mine);
    assertEq(table[0].points, 12, 'read through the caller');
});

// ==== placing ====

test('placeOf: ties SHARE a place', () => {
    const table = [{ teamId: 'a', points: 9 }, { teamId: 'b', points: 9 }, { teamId: 'c', points: 4 }];
    assertEq(placeOf(table, 'a').place, 1, 'first');
    assertEq(placeOf(table, 'b').place, 1, 'also first, level on points');
    assertEq(placeOf(table, 'c').place, 3, 'and the next is third, not second');
    assertEq(placeOf(table, 'c').of, 3, 'of three');
});

test('placeOf: a team not in the standing has no place', () => {
    assertEq(placeOf([{ teamId: 'a', points: 1 }], 'zz'), null, 'absent');
    assertEq(placeOf(null, 'a'), null, 'no standing at all');
});

// ==== remainderLine: what a player is still expected to produce Every figure below is MEASURED off a live 2026 baseball league at scoring period 164 of 187, the capture the defect was reported on: the owner's own hitters, his ace, and the free agent whose card read "would add 29 the rest of the way". ====

const BAT_GAMES = '81';                               // MLB batter games played
const PIT_GAMES = '32';                               // MLB pitcher appearances
const MLB_RATES = new Set(['47']);                    // one rate id, to prove a rate is not scaled

// seasonTotals, the games their CLUB has played, and the games it has left after period 164.
const ALVAREZ = { seasonTotals: { '5': 37, [BAT_GAMES]: 140 }, clubPlayed: 142, left: 21 };
const RICE = { seasonTotals: { '5': 35, [BAT_GAMES]: 135 }, clubPlayed: 144, left: 22 };
const SCHWARBER = { seasonTotals: { '5': 40, [BAT_GAMES]: 135 }, clubPlayed: 141, left: 22 };
const FREEMAN = { seasonTotals: { '5': 16, [BAT_GAMES]: 136 }, clubPlayed: 141, left: 22 };
// The reported defect: ESPN's line says 29 home runs off 629 at-bats - a full season, never refreshed. He has actually hit 20 in 131 games; his club has played 141 and has 21 left.
const RODRIGUEZ = { seasonTotals: { '5': 20, [BAT_GAMES]: 131 }, clubPlayed: 141, left: 21 };
// A STARTING PITCHER, the case that falsified the first version of this rule. 159 strikeouts in 22 appearances while his club played 141 games; ESPN expects 29 more.
const SKUBAL = { seasonTotals: { '48': 159, [PIT_GAMES]: 22 }, clubPlayed: 141, left: 22 };
const ALCANTARA = { seasonTotals: { '48': 142, [PIT_GAMES]: 30 }, clubPlayed: 141, left: 21 };

const stat = (p, id, gamesId) => remainderLine(p, {
    gamesId, rateIds: MLB_RATES, gamesRemaining: p.left, clubGamesPlayed: p.clubPlayed
})[id];
const hr = (p) => stat(p, '5', BAT_GAMES);
const ks = (p) => stat(p, '48', PIT_GAMES);

test('the free agent whose card read 29 the rest of the way comes back to 3.2', () => {
    // 20 home runs over his club's 141 games is 0.1418 a club game; 21 left is 3.0. ESPN said 29.
    assertClose(hr(RODRIGUEZ), 3.0, 0.1, 'the number the owner called impossible');
});

test('A STARTING PITCHER IS NOT PRICED AS IF HE PITCHED EVERY NIGHT', () => {
    // The falsification. Per APPEARANCE, Skubal's 159 strikeouts over 22 outings times his club's 22 remaining games is 159 - his entire season, printed as three weeks, which is the very class of defect this amendment exists to remove. Per CLUB game it is 24.8, against ESPN's 29.
    assertClose(ks(SKUBAL), 24.8, 0.1, 'three weeks of a starter, not a season');
    assertClose(ks(ALCANTARA), 21.1, 0.1, 'and a second starter against ESPN 20');
    assert(ks(SKUBAL) < 40, 'nothing near a season total can survive this window');
});

test('the derivation reproduces ESPN where ESPN is keeping the line current', () => {
    // The evidence the rule is right rather than merely safe. ESPN's own figures were 6, 6, 6, 3.
    assertClose(hr(ALVAREZ), 5.5, 0.1, 'Alvarez against ESPN 6');
    assertClose(hr(RICE), 5.3, 0.1, 'Rice against ESPN 6');
    assertClose(hr(SCHWARBER), 6.2, 0.1, 'Schwarber against ESPN 6');
    assertClose(hr(FREEMAN), 2.5, 0.1, 'Freeman against ESPN 3');
});

test('a BATTER is nearly unmoved by the club denominator, which is why he hid the defect', () => {
    // Alvarez played 140 of his club's 142, so per-game-played and per-club-game differ by 1%. A measurement taken on home runs alone can never see the error the pitcher above makes obvious.
    const perGamePlayed = (37 / 140) * 21;
    assertClose(hr(ALVAREZ), perGamePlayed, 0.1, 'the two readings agree on a healthy batter');
});

test('a RATE carries through unmultiplied', () => {
    // An ERA over the rest of the way is still an ERA. Multiplying it by the games would produce a number with no unit that still sorts, which is the whole reason the caller names its rates.
    const line = remainderLine({ seasonTotals: { '5': 20, '47': 3.25, [BAT_GAMES]: 131 } },
        { gamesId: BAT_GAMES, rateIds: MLB_RATES, gamesRemaining: 21, clubGamesPlayed: 141 });
    assertClose(line['47'], 3.25, 0.0001, 'the rate is untouched');
    assertClose(line['5'], 3.0, 0.1, 'the counting stat beside it is scaled');
});

test('no games played is NULL, never zero', () => {
    // Zero would say "expected to produce nothing", a forecast this data cannot make. The same refusal gainFrom makes for a rate with no denominator.
    const ctx = { gamesId: BAT_GAMES, rateIds: MLB_RATES, gamesRemaining: 21, clubGamesPlayed: 141 };
    assertEq(remainderLine({ seasonTotals: { '5': 0, [BAT_GAMES]: 0 } }, ctx), null, 'a player who has not played');
    assertEq(remainderLine({ seasonTotals: { '5': 12 } }, ctx), null, 'no games figure at all');
    assertEq(remainderLine(null, ctx), null, 'no player');
    assertEq(remainderLine(ALVAREZ, { rateIds: MLB_RATES, gamesRemaining: 21, clubGamesPlayed: 141 }), null, 'no games id to read');
});

test('no club schedule to price against is NULL too', () => {
    // Without the club's games so far there is no denominator at all, and the caller falls back to the actuals basis rather than being handed a bag built on a guess.
    const ctx = { gamesId: BAT_GAMES, rateIds: MLB_RATES, gamesRemaining: 21 };
    assertEq(remainderLine(ALVAREZ, ctx), null, 'no club games played');
    assertEq(remainderLine(ALVAREZ, { ...ctx, clubGamesPlayed: 0 }), null, 'a club that has played none');
});

test('a club with no games left has a real zero, not a refusal', () => {
    // Different from the cases above and deliberately so: the rate exists, the window is empty. He is expected to produce nothing because there is nothing left to play.
    const line = remainderLine(ALVAREZ, {
        gamesId: BAT_GAMES, rateIds: MLB_RATES, gamesRemaining: 0, clubGamesPlayed: 142
    });
    assertEq(line['5'], 0, 'no games, no home runs');
    assertEq(line[BAT_GAMES], 0, 'and no games either');
});

test('the line is scaled from the ACTUAL record, so a stale projection cannot reach it', () => {
    // The point of the whole amendment: nothing in the input is ESPN's projected line. Two players with identical records get identical remainders however different their projections are.
    const ctx = { gamesId: BAT_GAMES, rateIds: MLB_RATES, gamesRemaining: 21, clubGamesPlayed: 141 };
    const a = remainderLine({ seasonTotals: { '5': 20, [BAT_GAMES]: 131 }, projectedTotals: { '5': 29 } }, ctx);
    const b = remainderLine({ seasonTotals: { '5': 20, [BAT_GAMES]: 131 }, projectedTotals: { '5': 3 } }, ctx);
    assertEq(a['5'], b['5'], 'the projection is not read at all');
});

// ==== expectedAppearances: a count AND its unit Measured on a live 2026 baseball league at scoring period 164 of 187. The matchup being played runs to 173 and ESPN's probable listings reach 174, so THIS MATCHUP is inside the horizon and the rest of the season is not - which is the whole of the rule below. ====

const HORIZON = 174;                 // the furthest day ESPN has listed a probable for
const MATCHUP_END = 173;             // inside it
const SEASON_END = 187;              // past it

// A starter: 22 appearances while his club played 141, 1 probable start left in the matchup.
const ACE = { seasonTotals: { '32': 22 } };
// A closer: 55 appearances in his club's 140 games, and no probable anywhere - he does not start.
const CLOSER = { seasonTotals: { '32': 55 } };
const BAT = { seasonTotals: { '81': 140 } };

test('a STARTER inside the horizon is counted in STARTS, exactly', () => {
    // The owner's complaint in one assertion: the column said "9 of 13 games left" for a pitcher who appears once. The share would have said 1.4; ESPN's own listing says 1.
    const out = expectedAppearances(ACE, {
        gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9,
        projectedStarts: 1, startsScheduled: true, horizonEnd: HORIZON, windowEnd: MATCHUP_END
    });
    assertEq(out.unit, 'starts', 'the unit says what was counted');
    assertEq(out.count, 1, 'ESPN own listing, not an estimate');
});

test('the SAME starter past the horizon falls back to the share, in GAMES', () => {
    // The constraint that makes this a rule. Probables reach day 174 and the season runs to 187, so counting them over the rest of the season would find 2 of his remaining turns and call it all of them. 22 of his club's 141 games, over 22 left, is 3.4.
    const out = expectedAppearances(ACE, {
        gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 22,
        projectedStarts: 2, startsScheduled: true, horizonEnd: HORIZON, windowEnd: SEASON_END
    });
    assertEq(out.unit, 'games', 'an estimate, and it says so');
    assertClose(out.count, 3.43, 0.01, 'his rotation turn, not two listed starts');
});

test('a RELIEVER is the share too, and NOT his club games', () => {
    // The correction the measurement forced: a closer does not pitch every night either. 55 appearances in his club's 140 games is 39%, so over nine club games he appears in 3.5 - and showing him nine would be the same over-claim as showing a starter nine, only quieter.
    const out = expectedAppearances(CLOSER, {
        gamesId: '32', clubGamesPlayed: 140, gamesRemaining: 9,
        projectedStarts: 0, startsScheduled: false, horizonEnd: HORIZON, windowEnd: MATCHUP_END
    });
    assertEq(out.unit, 'games', 'nothing exact exists for a bullpen arm');
    assertClose(out.count, 3.54, 0.01, 'not the nine his club plays');
});

test('a starter with ZERO listed starts in the window is still starts, not a fallback', () => {
    // He pitched yesterday and his next turn falls after this window. Zero is the true answer, and the share would invent 1.4 appearances he will not make.
    const out = expectedAppearances(ACE, {
        gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9,
        projectedStarts: 0, startsScheduled: true, horizonEnd: HORIZON, windowEnd: MATCHUP_END
    });
    assertEq(out.count, 0, 'no turn in this window');
    assertEq(out.unit, 'starts', 'and it is still a count of starts, not a fallback');
});

test('a BATTER is always games, and near his club own count', () => {
    // He plays 94-99% of them, which is why the two readings agree for him and why measuring this on batters alone hid the pitcher defect for as long as it did.
    const out = expectedAppearances(BAT, {
        gamesId: '81', clubGamesPlayed: 142, gamesRemaining: 21
    });
    assertEq(out.unit, 'games', 'a batter has no starts to count');
    assertClose(out.count, 20.7, 0.05, 'nearly every game his club plays');
});

test('a pitcher called up this week has a listing and no record to share', () => {
    // The starts branch is answered BEFORE the share's refusals for exactly this player: no games played, so no rate, but ESPN has posted his start and that is a fact.
    const rookie = { seasonTotals: { '32': 0 } };
    const out = expectedAppearances(rookie, {
        gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9,
        projectedStarts: 1, startsScheduled: true, horizonEnd: HORIZON, windowEnd: MATCHUP_END
    });
    assertEq(out.count, 1, 'the listing stands on its own');
    assertEq(out.unit, 'starts', 'counted in starts');
    // Without the listing he is a refusal, exactly as before.
    assertEq(expectedAppearances(rookie, { gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9 }), null,
        'no record and no listing is null, never zero');
});

test('an unknown horizon never claims starts', () => {
    // A caller with no probables loaded at all must not be read as "the window is inside the horizon" - both figures have to be present for the exact branch to fire.
    const out = expectedAppearances(ACE, {
        gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9,
        projectedStarts: 1, startsScheduled: true
    });
    assertEq(out.unit, 'games', 'no horizon to check against');
});

test('the refusals are unchanged', () => {
    const ctx = { gamesId: '32', clubGamesPlayed: 141, gamesRemaining: 9 };
    assertEq(expectedAppearances(null, ctx), null, 'no player');
    assertEq(expectedAppearances({ seasonTotals: {} }, ctx), null, 'no games played');
    assertEq(expectedAppearances(ACE, { gamesId: '32', gamesRemaining: 9 }), null, 'no club games');
});

// ==== The remainder follows the unit remainderLine is production PER APPEARANCE times the appearances expected, and expectedAppearances decides what an appearance is. So a starting pitcher inside ESPN's listed horizon is priced over his ROTATION TURN and everyone else over the club's schedule, with no branch in remainderLine. ====

// The ace: 159 strikeouts in 22 appearances while his club played 141 and has 9 left in the window.
const ACE_LINE = { seasonTotals: { '48': 159, '32': 22 } };
const ACE_CTX = (extra) => ({
    gamesId: '32', rateIds: new Set(['47']), clubGamesPlayed: 141, gamesRemaining: 9, ...extra
});

test('a starter INSIDE the horizon is priced over his listed starts', () => {
    // One listed start left: 159 over 22 appearances is 7.2 a start, so 7.2 strikeouts.
    const line = remainderLine(ACE_LINE, ACE_CTX({
        projectedStarts: 1, startsScheduled: true, horizonEnd: 174, windowEnd: 173
    }));
    assertClose(line['48'], 7.2, 0.1, 'one turn of his rotation');
});

test('the SAME starter past the horizon is priced over the club share instead', () => {
    // Nothing listed that far out, so the estimate takes over: 22 of his club's 141 games over 9 left is 1.40 appearances, and 7.2 a start makes 10.1.
    const line = remainderLine(ACE_LINE, ACE_CTX({
        projectedStarts: 1, startsScheduled: true, horizonEnd: 174, windowEnd: 187
    }));
    assertClose(line['48'], 10.1, 0.1, 'the share, because ESPN has not posted that far');
});

test('the club-game figures are UNCHANGED by this amendment', () => {
    // The algebra that lets one expression serve both units: (n/played) x share reduces to n/clubPlayed x clubRemaining, which is exactly what this function computed before.
    const line = remainderLine(ACE_LINE, ACE_CTX({}));
    assertClose(line['48'], (159 / 141) * 9, 0.001, 'per club game, over the club games left');
});

test('a reliever is never priced over starts, whatever the horizon says', () => {
    // 55 appearances in his club's 140 games: he has no listing and the share is the only estimate.
    const closer = { seasonTotals: { '53': 32, '32': 55 } };
    const line = remainderLine(closer, {
        gamesId: '32', rateIds: new Set(), clubGamesPlayed: 140, gamesRemaining: 9,
        projectedStarts: 0, startsScheduled: false, horizonEnd: 174, windowEnd: 173
    });
    assertClose(line['53'], (32 / 140) * 9, 0.001, 'his saves over the club games, not over zero starts');
});

test('a starter with no turn in the window adds nothing, and that is a real zero', () => {
    // He pitched yesterday and his next start falls after this window. Zero strikeouts is the honest answer; the share would have invented 10.
    const line = remainderLine(ACE_LINE, ACE_CTX({
        projectedStarts: 0, startsScheduled: true, horizonEnd: 174, windowEnd: 173
    }));
    assertEq(line['48'], 0, 'no turn, no strikeouts');
});

test('a RATE still carries through under either unit', () => {
    const withRate = { seasonTotals: { '48': 159, '47': 2.85, '32': 22 } };
    const starts = remainderLine(withRate, ACE_CTX({
        projectedStarts: 1, startsScheduled: true, horizonEnd: 174, windowEnd: 173
    }));
    const games = remainderLine(withRate, ACE_CTX({}));
    assertClose(starts['47'], 2.85, 0.0001, 'an ERA over one start is still an ERA');
    assertClose(games['47'], 2.85, 0.0001, 'and over nine club games too');
});

test('a line still refuses a player with no games played, listing or not', () => {
    // expectedAppearances can answer for a call-up off his listing alone; a LINE cannot, because he has produced nothing to scale. This is the one place the two deliberately disagree.
    const rookie = { seasonTotals: { '32': 0 } };
    assertEq(remainderLine(rookie, ACE_CTX({
        projectedStarts: 1, startsScheduled: true, horizonEnd: 174, windowEnd: 173
    })), null, 'nothing to scale');
    assert(expectedAppearances(rookie, ACE_CTX({
        projectedStarts: 1, startsScheduled: true, horizonEnd: 174, windowEnd: 173
    })) !== null, 'while the COUNT is still knowable');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
