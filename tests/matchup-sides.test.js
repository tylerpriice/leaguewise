// Unit tests for the two sides of a matchup (matchup-sides.js). Open tests/matchup-sides.test.html through any static server; green means every assertion held. The instance is synthetic and every expected figure is worked by hand beside the case that asserts it. No capture is involved.
import { matchupSides, poolVariance } from '../src/engines/matchup-sides.js';
import { matchupOdds, MATCHUP_RHO } from '../src/engines/matchup-odds.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function close(got, want, msg, tol = 1e-12) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

// A rate's slope is read off the finish by a small step, so a rate's spread is good to about one part in a million and no better.
const STEP = 1e-6;

const FIX = await (await fetch('fixtures/matchup-sides.json')).json();
const run = (over = {}, sides = {}) => matchupSides({ mine: sides.mine || FIX.mine, theirs: sides.theirs || FIX.theirs }, { ...FIX.ctx, ...over });
const GOT = run();

/**
 * THE SEAT GAMES, by hand. Two periods left, 10 and 11. One seat for bats and one for arms.
 *
 *   club 1 plays 10 and 11        club 2 plays 10        club 3 plays 11 twice
 *
 *   period 10   bats with a game: 101 (club 1) and 102 (club 2). Two for one seat: half each.
 *               104 is on the injured list and 105 has no projection, so neither is counted.
 *   period 11   bats with a game: 101 alone, a whole seat. Arms: 103, twice, a whole seat each.
 *
 *   101: 0.5 + 1 = 1.5      102: 0.5      103: 2      mine: 4
 *   201 (theirs) is the only bat both days: 1 + 1 = 2
 */
test('the seats of a group are shared on a day when more of it play than there are seats', () => {
    assertEq(GOT.basis.periodsLeft, 2, 'two periods left');
    assertEq(GOT.basis.mine.players, 3, 'three of the five can be placed');
    close(GOT.basis.mine.seatGames, 4, '1.5 + 0.5 + 2');
    close(GOT.basis.theirs.seatGames, 2, 'one bat, both days');
    assertJson(GOT.basis.mine.noLine, [105], 'the player with no projection is named, not zeroed');
    assertJson(GOT.basis.mine.noShare, [], 'and nobody else is unplaced');
});

/**
 * THE MEAN, by hand. A line a game is the projected stat over the games of the same row, and
 * appearances are the share times the seat games, or a pitcher's listed starts.
 *
 *   101   10 HR in 20 games = 0.5 a game;  share 1    x 1.5 seat games = 1.5 appearances   0.75 HR
 *   102    2 HR in 10 games = 0.2 a game;  share 0.5  x 0.5 seat games = 0.25 appearances  0.05 HR
 *   mine  0.75 + 0.05 = 0.8 home runs still to come, on 3 already hit
 *   201    5 HR in 10 games = 0.5 a game;  share 1    x 2 = 2 appearances                  1 HR
 */
test('a counted category is the board plus the line a game over the appearances left', () => {
    assertEq(GOT.mine['5'].current, 3, 'three on the board');
    close(GOT.mine['5'].expectedRemaining, 0.8, '0.75 + 0.05');
    assertEq(GOT.theirs['5'].current, 2, 'two on theirs');
    close(GOT.theirs['5'].expectedRemaining, 1, '0.5 a game over two games');
});

/**
 * THE SPREAD, by hand. A player's variance a game is over the day lines, a missed game a zero.
 *
 *   101   home runs 1, 0: mean 0.5, variance 0.25;  x 1.5 seat games = 0.375
 *   102   home runs 0, 0: variance 0, so the pool's 0.25 stands in;  x 0.5 = 0.125   (floored)
 *   mine  0.375 + 0.125 = 0.5, sd the root of a half = 0.7071067811865476
 *   201   home runs 1, 1, 0, 0: variance 0.25;  x 2 = 0.5, the same sd
 */
test('the spread is the player own variance a game, with the pool in place of a zero', () => {
    close(GOT.mine['5'].sd, Math.sqrt(0.5), 'mine');
    close(GOT.theirs['5'].sd, Math.sqrt(0.5), 'theirs');
    assertEq(GOT.basis.mine.floored, 1, 'one player and one counted stat took the floor');
    assertEq(GOT.basis.theirs.floored, 0, 'none on theirs');
    // With no floor handed in, the zero stands: only 101 varies.
    close(run({ poolVariance: undefined }).mine['5'].sd, Math.sqrt(0.375), 'no floor, no lift');
});

/**
 * A RATE, by hand. Batting average is hits over at-bats, rebuilt from the finished components.
 *
 *   at-bats   101: 80/20 = 4 a game x 1.5 = 6      102: 40/10 = 4 x 0.25 = 1      7 to come, 20 on the board
 *   hits      101: 20/20 = 1 a game x 1.5 = 1.5    102: 12/10 = 1.2 x 0.25 = 0.3  1.8 to come, 5 on the board
 *   finish    6.8 / 27 = 0.2518518518518518
 *
 * Its spread, first order. The slope in hits is 1/27 and in at-bats -6.8/729.
 *
 *   101   hits 2, 0 about a mean of 1, at-bats level: the rate moves +1/27 and -1/27, variance
 *         (1/27)^2 = 0.001371742;  x 1.5 = 0.002057613
 *   102   never moved it, so the pool: (1/27)^2 x 0.5 + (6.8/729)^2 x 1 = 0.000772880;  x 0.5
 *   total 0.002444053, sd 0.049437364975779476
 */
test('a rate is the rate of its finished components, with the first-order spread', () => {
    close(GOT.mine['2'].current, 6.8 / 27, 'the finish goes in whole');
    assertEq(GOT.mine['2'].expectedRemaining, 0, 'with nothing beside it to add');
    close(GOT.mine['2'].sd, 0.049437364975779476, 'the spread', STEP);
    // Theirs: (4 + 2) / (16 + 8) = 0.25. 201 has a hit a game every game and never moved the rate, so the pool: ((1/24)^2 x 0.5 + (6/576)^2 x 1) x 2 = 1/512, sd 0.04419417382415922.
    close(GOT.theirs['2'].current, 0.25, 'six for twenty-four');
    close(GOT.theirs['2'].sd, Math.sqrt(1 / 512), 'the root of 1/512', STEP);
});

/**
 * THE RATE NOBODY CAN FORM. ERA is 27 times earned runs over outs. Mine: 3 runs and 27 outs on
 * the board, and one pitcher with a listed start at 90/5 = 18 outs and 10/5 = 2 runs a game, so
 * the finish is 27 x 5 / 45 = 3.00. The slopes are 27/45 = 0.6 a run and -5 x 27 / 45^2 = -1/15 an
 * out. The pitcher's three club games, one of them missed, are outs 18, 0, 15 about 11 and runs
 * 2, 0, 4 about 2, which move the rate by -7/15, -7/15 and +14/15: variance 98/225, times two
 * seat games, sd 14/15.
 *
 * Theirs has no pitcher and no outs, so there is nothing to divide by. That is not a contest:
 * ERA leaves both sides and the rule, and is listed with the side that could not form it.
 */
test('a rate with nothing to divide by on one side is left out of both, and said', () => {
    assertJson(GOT.leftOut, [{ statId: '47', reason: 'no denominator', side: 'theirs' }], 'named, with the side');
    assertEq(GOT.mine['47'], undefined, 'gone from the side that could form it');
    assertEq(GOT.theirs['47'], undefined, 'and from the one that could not');
    assertJson(GOT.rule.scoredStatIds, ['5', '2'], 'and from the rule, the order kept');
    assertJson(GOT.rule.inverseStatIds, [], 'its inverse flag goes with it');
    // With a pitcher on theirs it is a contest, and mine reads as worked above. The listed start replaces the share: one appearance, not 0.2 of two seat games.
    const arm = { ...FIX.mine.players[2], playerId: 203 };
    const both = run({}, { theirs: { board: { ...FIX.theirs.board, '34': 27, '45': 3 }, players: [...FIX.theirs.players, arm] } });
    assertJson(both.leftOut, [], 'nothing left out');
    close(both.mine['47'].current, 3, '27 x 5 / 45');
    close(both.mine['47'].sd, 14 / 15, 'the root of 2 x 98/225', STEP);
    assertJson(both.rule.inverseStatIds, ['47'], 'and lower still wins it');
});

test('the rule handed on is the whole fixture, and matchupOdds takes it as it stands', () => {
    assertJson(GOT.rule, FIX.expected.rule, 'the rule');
    assertJson(GOT.basis, FIX.expected.basis, 'what it was built from');
    ['mine', 'theirs'].forEach(side => Object.keys(FIX.expected[side]).forEach(id => {
        ['current', 'expectedRemaining', 'sd'].forEach(field => close(GOT[side][id][field], FIX.expected[side][id][field], `${side} ${id} ${field}`, STEP));
    }));
    const odds = matchupOdds({ mine: GOT.mine, theirs: GOT.theirs }, GOT.rule);
    assertEq(odds.perCategory.length, 2, 'two categories contested');
    close(odds.chance + odds.tie + odds.lose, 1, 'and the three chances are everything');
    assertEq(odds.perCategory[0].chanceTie > 0, true, 'the counted one can end level');
    assertEq(odds.perCategory[1].chanceTie, 0, 'the rate cannot');
});

test('rho is read from the table by sport, and absent where the table has no entry', () => {
    assertEq(GOT.rule.rho, MATCHUP_RHO.flb, 'baseball');
    assertEq(run({ sport: 'fhl' }).rule.rho, MATCHUP_RHO.fhl, 'hockey');
    assertEq('rho' in run({ sport: 'ffl' }).rule, false, 'football: no key at all, so the fold is the independent one');
});

test('an id no group lists is brought by everyone', () => {
    // Hockey's shape: no seat rule by stat. With the lists gone the arm brings home runs too, and has none projected, so the mean is unmoved; but the arm's two seat games now carry the bats' floor only if a floor is listed for arms, and none is.
    const open = run({ groupStatIds: undefined });
    close(open.mine['5'].expectedRemaining, 0.8, 'nothing projected, nothing added');
    close(open.mine['5'].sd, Math.sqrt(0.5), 'and no spread from a group with no floor for it');
});

/**
 * THE STAT NO ROW PROJECTS, by hand. "72" is scored and on nobody's projected row, as a real
 * league scores things ESPN does not project. No group lists it, so everyone brings it. Each
 * player's line a game is then the player's own season rate, over the same appearances as before.
 *
 *   101   5 in 10 games = 0.5 a game    x 1.5 appearances  = 0.75
 *   102   2 in 20 games = 0.1 a game    x 0.25             = 0.025
 *   103   1 in  4 games = 0.25 a game   x 1 listed start   = 0.25
 *   mine  1.025 to come, on 2 on the board
 *   201   2 in  4 games = 0.5 a game    x 2                = 1
 */
const SEASONS = { 101: { '81': 10, '72': 5 }, 102: { '81': 20, '72': 2 }, 103: { '32': 4, '72': 1 }, 201: { '81': 4, '72': 2 } };
const withSeasons = (side, ids) => ({ ...side, board: { ...side.board, '72': 2 }, players: side.players.map(p => (ids.includes(p.playerId) ? { ...p, season: SEASONS[p.playerId] } : p)) });

test('a category no projected row carries takes the player own season rate, and is named', () => {
    const got = run({ scoredStatIds: ['5', '72'] }, { mine: withSeasons(FIX.mine, [101, 102, 103]), theirs: withSeasons(FIX.theirs, [201]) });
    assertEq(got.mine['72'].current, 2, 'the board');
    close(got.mine['72'].expectedRemaining, 1.025, '0.75 + 0.025 + 0.25');
    close(got.theirs['72'].expectedRemaining, 1, '0.5 a game, twice');
    assertJson(got.basis.mine.unprojected, ['72'], 'named as unprojected');
    assertJson(got.basis.mine.fallback, ['72'], 'and as given the season rate, so a face can mark it');
    assertJson(got.leftOut, [], 'a contest, so nothing is left out');
    assertJson(GOT.basis.mine.unprojected, [], 'where every stat is projected there is nothing to name');
    assertJson(GOT.basis.mine.fallback, [], 'and nothing falls back');
});

test('with no season line either there is no mean to give, and the category leaves the fold', () => {
    // Theirs has no season line for "72": nothing projected and nothing done. Not a contest.
    const got = run({ scoredStatIds: ['5', '72'] }, { mine: withSeasons(FIX.mine, [101, 102, 103]), theirs: withSeasons(FIX.theirs, []) });
    assertJson(got.leftOut, [{ statId: '72', reason: 'no line', side: 'theirs' }], 'named, with its reason and its side');
    assertEq(got.mine['72'], undefined, 'gone from mine, which could have formed it');
    assertJson(got.rule.scoredStatIds, ['5'], 'and from the rule');
    assertJson(got.basis.theirs.fallback, [], 'nothing fell back on theirs');
    assertJson(got.basis.mine.fallback, ['72'], 'while mine did');
});

test('a player nobody can place is named and takes no seat', () => {
    // 102 with no share and no listed start: left out, so 101 has period 10 to itself.
    const players = FIX.mine.players.map(p => (p.playerId === 102 ? { ...p, share: null } : p));
    const got = run({}, { mine: { ...FIX.mine, players } });
    assertJson(got.basis.mine.noShare, [102], 'named');
    close(got.basis.mine.seatGames, 4, '101 takes 2, the arm 2');
    close(got.mine['5'].expectedRemaining, 1, '0.5 a game over two whole seats');
});

test('nothing left to play is the board, decided', () => {
    const got = run({ periodsLeft: [] });
    assertEq(got.mine['5'].expectedRemaining, 0, 'nothing to come');
    assertEq(got.mine['5'].sd, 0, 'and nothing uncertain');
    close(got.mine['2'].current, 0.25, 'the rate is the board own: 5 for 20');
    const odds = matchupOdds({ mine: got.mine, theirs: got.theirs }, got.rule);
    close(odds.perCategory[0].chanceWin, 1, 'three home runs to two, finished');
});

test('the refusals are null, never a hollow shape', () => {
    assertEq(matchupSides({ mine: FIX.mine }, FIX.ctx), null, 'one side');
    assertEq(matchupSides({ mine: FIX.mine, theirs: FIX.theirs }, { ...FIX.ctx, periodsLeft: undefined }), null, 'no days left given');
    assertEq(run({ scoredStatIds: [] }), null, 'no category');
    assertEq(run({ scoredStatIds: ['47'] }), null, 'every category left out');
    assertEq(matchupSides(), null, 'nothing at all');
});

/**
 * A POINTS LEAGUE, by hand. One seat a group, the same two periods and clubs.
 *
 *   mine    one skater on club 1 at 2.5 points a game, share 1, both days: 2 appearances, 5 to come
 *           on 30. Day lines 4, 0, 2 points: mean 2, variance (4 + 4 + 0) / 3 = 8/3; x 2 = 16/3.
 *   theirs  one skater on club 2 at 3 a game, share 1, period 10 only: 3 to come on 31. No day
 *           line, so the pool's 2 stands in: x 1 = 2.
 */
const SKATER = (id, club, perGame, dayLines) => ({ playerId: id, lineupSlotId: 3, proTeamId: club, group: 'skater', projected: null, gamesId: null, pointsPerGame: perGame, share: 1, dayLines });
const POINTS_CTX = { sport: 'fhl', scoring: 'points', periodsLeft: [10, 11], clubGames: FIX.ctx.clubGames, seats: { skater: 1 }, poolVariance: { skater: { points: 2 } } };
const POINTS = { mine: { points: 30, players: [SKATER(1, 1, 2.5, [{ points: 4 }, {}, { points: 2 }])] }, theirs: { points: 31, players: [SKATER(2, 2, 3, [])] } };

test('a points league is one figure a side and a rule with nothing to fold', () => {
    const got = matchupSides(POINTS, POINTS_CTX);
    assertJson(got.rule, { scoring: 'points' }, 'no categories and no rho');
    assertEq(got.mine.current, 30, 'the total so far');
    close(got.mine.expectedRemaining, 5, '2.5 a game, twice');
    close(got.mine.sd, Math.sqrt(16 / 3), 'the root of 16/3');
    close(got.theirs.expectedRemaining, 3, 'once');
    close(got.theirs.sd, Math.sqrt(2), 'the pool, for a player with no day line');
    assertEq(got.basis.theirs.floored, 1, 'and counted as floored');
    const odds = matchupOdds({ mine: got.mine, theirs: got.theirs }, got.rule);
    close(odds.gap, 1, '35 against 34');
    close(odds.sd, Math.sqrt(16 / 3 + 2), 'the two spreads combined');
});

test('a spread nobody measured is null, which is not zero', () => {
    // No day line on theirs and no floor: there is a game left and nothing to take a spread from.
    const got = matchupSides(POINTS, { ...POINTS_CTX, poolVariance: undefined });
    assertEq(got.theirs.sd, null, 'unknown');
    close(got.theirs.expectedRemaining, 3, 'the mean half still stands');
    close(got.mine.sd, Math.sqrt(16 / 3), 'and the measured side is untouched');
    // With nothing left to play there is nothing to be unsure of, measured or not.
    assertEq(matchupSides(POINTS, { ...POINTS_CTX, poolVariance: undefined, periodsLeft: [] }).theirs.sd, 0, 'decided');
});

test('the floor is the mean of every measured player own variance, a zero counted', () => {
    // Bats: 101 home runs 1, 0 is 0.25; 102 is 0; 201 is 0.25. The mean of the three is 1/6. 104 and 105 have no day line, so they are not measured and not in it. One arm: outs 18, 0, 15 about 11 is (49 + 121 + 16) / 3 = 62.
    const pool = poolVariance([...FIX.mine.players, ...FIX.theirs.players], ['5', '34']);
    close(pool.bat['5'], 1 / 6, 'the bats in home runs');
    close(pool.arm['34'], 62, 'the one arm in outs');
    close(pool.arm['5'], 0, 'an arm has never hit one');
    assertJson(Object.keys(poolVariance([{ group: 'bat', dayLines: [] }], ['5'])), [], 'nobody measured, no entry');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
