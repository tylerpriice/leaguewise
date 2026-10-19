// Unit tests for the playoff-odds engine (playoff-odds.js). Open tests/playoff-odds.test.html through any static server; green means every assertion held. The expected values are enumerated by hand in tests/fixtures/playoff-odds.md, not taken from a run of this code. Every team, category and number is invented, and no capture is involved.
import { rulesFrom, resampleBasis, matchupOutcome, simulateSeason, certainty, rotoOdds, rotoBasisFrom, applyRates, mergeRuns, oddsFigure, remainingSchedule, MIN_WEEKS, PRIOR_WEEKS } from '../src/engines/playoff-odds.js';

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
function close(got, want, msg, tol) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

const FIX = await (await fetch('fixtures/playoff-odds.json')).json();

// The AppState.teamStats shape data.js builds, assembled from the fixture's own table.
const teamStats = FIX.teams.map(t => ({ id: t.id, weeklyCats: FIX.weeklyCats[String(t.id)], weeklyMatchWins: {} }));
const divisionByTeam = {};
FIX.teams.forEach(t => { divisionByTeam[t.id] = t.divisionId; });

const RULES = rulesFrom(FIX.settings, FIX.schedule, {
    scoredStatIds: FIX.scoredStatIds, inverseStatIds: FIX.inverseStatIds, divisionByTeam
});
const BASIS = resampleBasis(teamStats, { through: 2 });

const SEED = 20260922;
const RUNS = 4000;
const TOL = 0.03;          // three points, as the contract sets

// ==== the league's own rules ====

test('rulesFrom reads the scoring type, the seats and the tie rule', () => {
    assertEq(RULES.scoring, 'categories', 'H2H_MOST_CATEGORIES');
    assertEq(RULES.playoffTeamCount, 2, 'two seats');
    assertEq(RULES.seedingRule, 'H2H_RECORD', 'the tiebreak, not the primary order');
    assertJson(RULES.tie, { rule: 'NONE', statId: null }, 'no tie rule in this league');
    assertEq(RULES.teamCount, 4, 'four teams, counted off the schedule');
});

test('a single nominal division is no division', () => {
    assertJson(RULES.divisions, [], 'every team at divisionId 0 is one division, which is none');
    const two = rulesFrom(FIX.settings, FIX.schedule, { divisionByTeam: { 1: 0, 2: 0, 3: 1, 4: 1 } });
    assertJson(two.divisions, ['0', '1'], 'two real divisions are carried');
});

test('the regular season ends where data.js says it does', () => {
    // Nothing tagged: the fallback is matchupPeriodCount, which is every LIVE league (measured on full-nfl-2026-week2, 70 games and not one playoffTierType).
    assertEq(RULES.regSeasonWeeks, 3, 'no tagged playoff period, so matchupPeriodCount');
    const tagged = rulesFrom(FIX.settings, [
        { matchupPeriodId: 1, playoffTierType: 'NONE' },
        { matchupPeriodId: 4, playoffTierType: 'WINNERS_BRACKET' }
    ], {});
    assertEq(tagged.regSeasonWeeks, 3, 'the first tagged period minus one');
});

test('the scoring type decides the path, and roto is its own', () => {
    assertEq(rulesFrom({ scoringSettings: { scoringType: 'H2H_POINTS' } }, [], {}).scoring, 'points', 'points');
    assertEq(rulesFrom({ scoringSettings: { scoringType: 'ROTO' } }, [], {}).scoring, 'roto', 'roto');
    const hockey = rulesFrom({ scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', matchupTieRule: 'STAT_POINTS', matchupTieRuleBy: 28 } }, [], {});
    assertJson(hockey.tie, { rule: 'STAT_POINTS', statId: '28' }, 'full-nhl-fgb breaks a tie on stat 28');
});

// ==== the basis ====

test('a team draws from its own weeks, and the count is the smallest anyone has', () => {
    assertEq(Object.keys(BASIS.byTeam).length, 4, 'four teams');
    assertEq(BASIS.byTeam['1'].length, 2, 'two played weeks');
    assertEq(BASIS.weeksUsed, 2, 'the smallest, not the largest - one team with two limits the answer');
    assertJson(BASIS.byTeam['1'][0].cats, { '10': 10, '20': 4, '30': 9 }, "Alpha's own first week");
    const short = resampleBasis(teamStats, { through: 1 });
    assertEq(short.weeksUsed, 1, 'through cuts the basis to weeks up to W');
    const last = resampleBasis(teamStats, { lastN: 1 });
    assertEq(last.byTeam['1'][0].week, 2, 'lastN keeps the most recent');
});

test('a points league reads weeklyMatchWins as a SCORE, a category league never does', () => {
    const stats = [{ id: 9, weeklyCats: { 1: { '10': 1 } }, weeklyMatchWins: { 1: 112.5 } }];
    assertEq(resampleBasis(stats, { scoring: 'points' }).byTeam['9'][0].points, 112.5, 'the points total');
    assertEq(resampleBasis(stats, { scoring: 'categories' }).byTeam['9'][0].points, 0,
        'in a category league that field is a 1/0.5/0 match result and is not a score');
});

// ==== one drawn pair ====

test('a matchup is won category by category, with the inverse one flipped', () => {
    const a = { cats: { '10': 10, '20': 4, '30': 9 } };
    const b = { cats: { '10': 8, '20': 5, '30': 7 } };
    // Alpha's w1 against Delta's w1, the first row of the contract's own table.
    assertJson(matchupOutcome(a, b, RULES), { winner: 'b', a: 1, b: 2, ties: 0 },
        '"30" is inverse, so 7 beats 9 and Delta takes the matchup 2-1');
});

test('an equal category count is a tie, and STAT_POINTS breaks it where the league has one', () => {
    const a = { cats: { '10': 7, '20': 7, '30': 9 } };
    const b = { cats: { '10': 7, '20': 6, '30': 8 } };
    assertJson(matchupOutcome(a, b, RULES), { winner: 'tie', a: 1, b: 1, ties: 1 },
        'one each and one tied category: a tie, because this league breaks none');
    const withRule = { ...RULES, tie: { rule: 'STAT_POINTS', statId: '10' } };
    assertEq(matchupOutcome(a, b, withRule).winner, 'tie', 'and stays a tie when the deciding stat is equal too');
    const decides = { ...RULES, tie: { rule: 'STAT_POINTS', statId: '20' } };
    assertEq(matchupOutcome(a, b, decides).winner, 'a', 'stat 20 decides it for Alpha');
});

test('a points matchup is the two totals', () => {
    const out = matchupOutcome({ points: 110.12 }, { points: 99.5 }, { scoring: 'points' });
    assertJson(out, { winner: 'a', a: 110.12, b: 99.5, ties: 0 }, 'the totals ride out as a and b');
    assertEq(matchupOutcome({ points: 7 }, { points: 7 }, { scoring: 'points' }).winner, 'tie', 'equal is a tie');
});

// ==== the two refusals ====

test('a roto league is refused by simulateSeason, and says why', () => {
    const roto = simulateSeason(BASIS, FIX.schedule, { ...RULES, scoring: 'roto' }, { seed: SEED, runs: 10 });
    assertEq(roto.state, 'not a head-to-head league', 'there is no matchup to simulate');
    assertEq(Object.keys(roto.teams).length, 0, 'and no teams, rather than a page of zeroes');
});

test('too few weeks is refused rather than answered', () => {
    assertEq(MIN_WEEKS, 3, 'three weeks is the floor the contract sets');
    const thin = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: 10 });
    assertEq(thin.state, 'too few weeks to resample', 'the fixture has two, so the default floor refuses it');
});

// ==== the season against the enumeration ====

const SIM = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: RUNS, minWeeks: 2, priorWeeks: 0 });

test('the seeded run lands on the hand-enumerated odds', () => {
    assertEq(SIM.state, null, 'it ran');
    assertEq(SIM.runs, RUNS, 'the runs asked for');
    Object.keys(FIX.enumerated).forEach(id => {
        close(SIM.teams[id].odds, FIX.enumerated[id].odds, `team ${id} odds`, TOL);
    });
});

test('and on the seed spread, seat by seat', () => {
    Object.keys(FIX.enumerated).forEach(id => {
        FIX.enumerated[id].seeds.forEach((want, i) => {
            close(SIM.teams[id].seeds[i], want, `team ${id} seed ${i + 1}`, TOL);
        });
    });
});

test('the run sums the way the enumeration does', () => {
    const ids = Object.keys(SIM.teams);
    const odds = ids.reduce((s, id) => s + SIM.teams[id].odds, 0);
    close(odds, 2, 'every run fills exactly two seats, so the odds sum to two', 1e-9);
    ids.forEach(id => {
        const row = SIM.teams[id].seeds.reduce((s, v) => s + v, 0);
        close(row, 1, `team ${id} finishes somewhere every run`, 1e-9);
        close(SIM.teams[id].seeds[0] + SIM.teams[id].seeds[1], SIM.teams[id].odds,
            `team ${id}'s odds ARE its top-two seed mass`, 1e-9);
    });
    const wins = ids.reduce((s, id) => s + SIM.teams[id].expectedWins, 0);
    close(wins, 6, 'six matchups at a point each', 1e-9);
});

test('expected wins land on the enumeration too', () => {
    Object.keys(FIX.enumerated).forEach(id => {
        close(SIM.teams[id].expectedWins, FIX.enumerated[id].expectedWins, `team ${id} expected wins`, TOL);
    });
});

test('every team qualifying makes the seed spread the whole answer', () => {
    const all = simulateSeason(BASIS, FIX.schedule, { ...RULES, playoffTeamCount: 4 }, { seed: SEED, runs: RUNS, minWeeks: 2, priorWeeks: 0 });
    Object.keys(FIX.enumeratedAllIn).forEach(id => {
        assertEq(all.teams[id].odds, 1, `team ${id} cannot miss a four-seat playoff in a four-team league`);
        FIX.enumeratedAllIn[id].seeds.forEach((want, i) => {
            close(all.teams[id].seeds[i], want, `team ${id} seed ${i + 1} is unchanged by the seat count`, TOL);
        });
    });
});

test('the same seed gives the same answer, a different one does not', () => {
    const again = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: 500, minWeeks: 2, priorWeeks: 0 });
    const same = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: 500, minWeeks: 2, priorWeeks: 0 });
    assertJson(again.teams['1'], same.teams['1'], 'seeded, so reproducible');
    const other = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED + 1, runs: 500, minWeeks: 2, priorWeeks: 0 });
    assertEq(other.teams['1'].odds === again.teams['1'].odds, false, 'another seed is another sample');
});

// ==== clinched and eliminated ====

test('Charlie is eliminated by the bound, and the odds agree by another route', () => {
    assertEq(SIM.teams['3'].eliminated, true, "Charlie's best case is 1.0 against two floors of 1.5");
    assertEq(SIM.teams['3'].odds, 0, 'and no run put Charlie in - two answers, one conclusion');
    ['1', '2', '4'].forEach(id => assertEq(SIM.teams[id].eliminated, false, `team ${id} can still make it`));
});

test('nobody is clinched in this fixture, and the flag says so', () => {
    Object.keys(SIM.teams).forEach(id => assertEq(SIM.teams[id].clinched, false, `team ${id}`));
});

test('the clinched flag fires on a standings that has one', () => {
    // Hand-built, because the fixture has no clinch in it: two seats, one game left each, and the leader is four clear of the third-placed team's best case.
    const rules = { playoffTeamCount: 2 };
    const flags = certainty(
        [{ id: 1, points: 8, games: 8 }, { id: 2, points: 7, games: 8 }, { id: 3, points: 2, games: 8 }, { id: 4, points: 1, games: 8 }],
        { 1: 1, 2: 1, 3: 1, 4: 1 }, rules);
    assertEq(flags['1'].clinched, true, 'only Bravo can pass Alpha, and one team above is not two');
    assertEq(flags['2'].clinched, true, 'and only Alpha can pass Bravo');
    assertEq(flags['3'].eliminated, true, 'Charlie tops out at 3 against two floors of 7');
    assertEq(flags['4'].eliminated, true, 'and Delta at 2');
    assertEq(flags['1'].eliminated, false, 'the leader is not eliminated');
});

test('drawing level is not being passed', () => {
    // Charlie's best case EQUALS both floors: a shared seat, not a loss, so not eliminated.
    const flags = certainty(
        [{ id: 1, points: 3, games: 3 }, { id: 2, points: 3, games: 3 }, { id: 3, points: 2, games: 3 }],
        { 1: 0, 2: 0, 3: 1 }, { playoffTeamCount: 2 });
    assertEq(flags['3'].eliminated, false, 'levelling with both is a three-way tie for two seats');
});

// ==== divisions ====

test('division winners take the top seats, which is why a .548 can seed above a .667', () => {
    // The full-nhl-fgb shape in miniature: two divisions, and the East's best is third by record.
    const schedule = [
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 3 } },
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 2 }, away: { teamId: 4 } },
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 4 } },
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'AWAY', home: { teamId: 3 }, away: { teamId: 2 } }
    ];
    // Records: 1 is 2-0 (West), 2 is 2-0 (West), 3 is 0-2 (East), 4 is 0-2 (East).
    const rules = rulesFrom(
        { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES' }, scheduleSettings: { matchupPeriodCount: 2, playoffTeamCount: 2 } },
        schedule, { scoredStatIds: ['10'], divisionByTeam: { 1: 'W', 2: 'W', 3: 'E', 4: 'E' } });
    assertJson(rules.divisions, ['W', 'E'], 'two real divisions');
    const basis = resampleBasis([1, 2, 3, 4].map(id => ({ id, weeklyCats: { 1: { '10': id }, 2: { '10': id } } })), {});
    const sim = simulateSeason(basis, schedule, rules, { seed: SEED, runs: 1, minWeeks: 2, priorWeeks: 0 });
    // Nothing is left to play, so the seeding is the played record alone: without divisions the seats would go to teams 1 and 2, both 2-0. With them, the East's best takes a top seat.
    assertEq(sim.teams['1'].seeds[0] + sim.teams['2'].seeds[0], 1, 'a West team seeds first');
    assertEq(sim.teams['3'].odds + sim.teams['4'].odds, 1, "the East's own winner takes the second seat");
    assertEq(sim.teams['1'].odds + sim.teams['2'].odds, 1, 'and one West team takes the first');
});

// ==== the roto path ====

const ROTO_RULES = rulesFrom(FIX.roto.settings, [], { scoredStatIds: FIX.scoredStatIds, inverseStatIds: FIX.inverseStatIds });
// Through the real builder, in the race's own measured shape, so the fixture exercises the path a league will: team -> period -> { sums, games }.
const ROTO_SERIES = Object.fromEntries(Object.entries(FIX.roto.perPeriod).map(([id, lines]) =>
    [id, Object.fromEntries(lines.map((cats, i) => [i + 1, { sums: cats, games: 1 }]))]));
const ROTO_BASIS = { ...rotoBasisFrom(ROTO_SERIES, {}), periodsLeft: FIX.roto.periodsRemaining };
const ROTO = rotoOdds(ROTO_BASIS, FIX.roto.currentTotals, ROTO_RULES, { seed: SEED, runs: RUNS });

test('the roto title odds land on the enumeration', () => {
    assertEq(ROTO.state, null, 'it ran');
    Object.keys(FIX.roto.enumerated).forEach(id => {
        close(ROTO.teams[id].titleOdds, FIX.roto.enumerated[id].titleOdds, `team ${id} title odds`, TOL);
    });
    const sum = Object.keys(ROTO.teams).reduce((s, id) => s + ROTO.teams[id].titleOdds, 0);
    close(sum, 1, 'one title, split on a tie', 1e-9);
});

test('and on the expected roto points, which sum to the field', () => {
    Object.keys(FIX.roto.enumerated).forEach(id => {
        close(ROTO.teams[id].expectedPoints, FIX.roto.enumerated[id].expectedPoints, `team ${id} points`, 0.1);
    });
    const sum = Object.keys(ROTO.teams).reduce((s, id) => s + ROTO.teams[id].expectedPoints, 0);
    close(sum, 30, 'three categories at ten points a four-team field', 1e-9);
});

test('the chance of finishing above the leader, and null for the leader itself', () => {
    const pick = (id, statId) => ROTO.teams[id].perCategory.find(c => c.statId === statId);
    assertEq(pick('2', '10').chanceAboveLeader, null, 'Bravo leads "10" and cannot finish above itself');
    assertEq(pick('1', '20').chanceAboveLeader, null, 'nor Alpha in "20"');
    assertEq(pick('3', '30').chanceAboveLeader, null, 'nor Charlie in "30", which is inverse');
    close(pick('1', '10').chanceAboveLeader, 0.0625, 'Alpha passes Bravo in "10" on one pair in sixteen', TOL);
    close(pick('2', '20').chanceAboveLeader, 0.0625, 'and Bravo passes Alpha in "20" on one', TOL);
    assertEq(pick('4', '10').chanceAboveLeader, 0, 'Delta cannot move and cannot pass anyone');
});

test('the working travels with the percentage', () => {
    const c = ROTO.teams['1'].perCategory.find(x => x.statId === '10');
    assertEq(c.current, 8, "Alpha's current total");
    assertEq(c.perPeriod, 4, 'its own rate, (5 + 3) / 2');
    assertEq(c.periodsLeft, 2, 'two periods left');
    assertEq(c.projected, 16, '8 + 4 x 2');
    assertEq(c.leaderId, '2', 'Bravo leads');
    assertEq(c.leaderProjected, 18, '9 + 4.5 x 2 - ahead in expectation, which is why the chance is small');
});

// ==== the window, and rates ====

test('the roto basis takes the race\'s own series, and lastN cuts it', () => {
    // The shape measured in players.js: team -> period -> { sums, games }.
    const series = new Map([
        [7, { 1: { sums: { '10': 1 }, games: 3 }, 2: { sums: { '10': 2 }, games: 4 }, 3: { sums: { '10': 3 }, games: 5 } }],
        [8, { 1: { sums: { '10': 9 }, games: 2 }, 2: { sums: { '10': 8 }, games: 2 } }]
    ]);
    const whole = rotoBasisFrom(series, {});
    assertEq(whole.byTeam['7'].length, 3, 'three periods for team 7');
    assertEq(whole.periodsUsed, 2, 'the smallest anyone carries, which is what limits the answer');
    assertEq(whole.byTeam['7'][0].games, 3, 'the games ride along');

    const last2 = rotoBasisFrom(series, { lastN: 2 });
    assertJson(last2.byTeam['7'].map(p => p.period), [2, 3], 'the last two periods, not the first');
    const upTo2 = rotoBasisFrom(series, { through: 2 });
    assertJson(upTo2.byTeam['7'].map(p => p.period), [1, 2], 'through cuts at W, which is what the validation replays');
    assertJson(rotoBasisFrom({ 9: { 1: { sums: { '10': 1 } } } }, {}).byTeam['9'].map(p => p.period), [1],
        'a plain object is read the same as a Map');
});

test('a rate is rebuilt from its components, never summed', () => {
    // The hockey pair, verbatim from state.js's RATE_COMPONENTS: SV% = SV/SA and GAA = GA * 3600 / TOI(seconds).
    const fhl = [{ out: '11', num: ['6'], den: ['3'] }, { out: '10', num: ['4'], den: ['8'], scale: 3600 }];
    // Two periods: 20 of 22 saves then 25 of 28, and 2 goals in 3600s then 3 in 3600s.
    const summed = { '6': 45, '3': 50, '4': 5, '8': 7200 };
    const out = applyRates(summed, fhl);
    close(out['11'], 0.9, 'SV% is 45/50, not the mean of two period rates', 1e-12);
    close(out['10'], 2.5, 'GAA is 5 goals over two hours', 1e-12);
    assertEq(applyRates({ '3': 0, '6': 0 }, fhl)['11'], 0, 'no shots faced is zero, not a division by zero');
});

test('an add rule runs after the ratios it adds', () => {
    // OPS = OBP + SLG, and both of those are themselves rebuilt first.
    const flb = [
        { out: '9', num: ['8'], den: ['0'] },
        { out: '17', num: ['1'], den: ['0'] },
        { out: '18', add: ['17', '9'] }
    ];
    const out = applyRates({ '8': 30, '1': 15, '0': 60 }, flb);
    close(out['9'], 0.5, 'SLG', 1e-12);
    close(out['17'], 0.25, 'OBP', 1e-12);
    close(out['18'], 0.75, 'OPS is the sum of the two REBUILT rates', 1e-12);
});

test('a counting category is unchanged by the rate pass', () => {
    assertJson(applyRates({ '10': 7, '20': 3 }, []), { '10': 7, '20': 3 }, 'no rules, nothing touched');
    assertEq(applyRates({ '10': 7, '6': 1, '3': 2 }, [{ out: '11', num: ['6'], den: ['3'] }])['10'], 7,
        'and a league with rates leaves its counting categories alone');
});

test('the roto answer names the window it was computed on', () => {
    assertEq(ROTO.periodsUsed, 2, 'the fixture carries two periods, and the face prints that');
});

// ==== two results into one (amendment 3) ====

// Hand-computed in playoff-odds.md amendment 3: a at 1 run, b at 3, every figure a binary fraction so the comparison is exact.
const H2H_A = { teams: {
    1: { odds: 1, seeds: [1, 0], expectedWins: 2, clinched: true, eliminated: false },
    2: { odds: 0, seeds: [0, 1], expectedWins: 0, clinched: false, eliminated: true }
}, runs: 1, seed: 7, weeksUsed: 3, state: null };
const H2H_B = { teams: {
    1: { odds: 0.5, seeds: [0.5, 0.5], expectedWins: 1, clinched: true, eliminated: false },
    2: { odds: 0.5, seeds: [0.5, 0.5], expectedWins: 1, clinched: false, eliminated: true }
}, runs: 3, seed: 9, weeksUsed: 3, state: null };

test('mergeRuns: head-to-head odds, seeds and wins weighted by runs, the flags from the first', () => {
    const m = mergeRuns(H2H_A, H2H_B);
    assertJson(m.teams[1], { odds: 0.625, seeds: [0.625, 0.375], expectedWins: 1.25, clinched: true, eliminated: false }, 'team 1');
    assertJson(m.teams[2], { odds: 0.375, seeds: [0.375, 0.625], expectedWins: 0.75, clinched: false, eliminated: true }, 'team 2');
    assertJson([m.runs, m.seed, m.weeksUsed, m.state], [4, 7, 3, null], 'runs summed, the rest from a');
    assertEq(H2H_A.teams[1].odds, 1, 'neither side is changed');
});

test('mergeRuns: roto title odds, points and chances weighted, the leader\'s null kept', () => {
    const cat = (chance, current) => ({ statId: '10', chanceAboveLeader: chance, current, perPeriod: 1, periodsLeft: 2, projected: current + 2, leaderId: '1', leaderProjected: 7 });
    const a = { teams: {
        1: { titleOdds: 1, expectedPoints: 8, perCategory: [cat(null, 5)] },
        2: { titleOdds: 0, expectedPoints: 4, perCategory: [cat(0, 3)] }
    }, runs: 1, seed: 7, periodsLeft: 2, periodsUsed: 2, state: null };
    const b = { teams: {
        1: { titleOdds: 0.5, expectedPoints: 6, perCategory: [cat(null, 99)] },
        2: { titleOdds: 0.5, expectedPoints: 6, perCategory: [cat(0.5, 99)] }
    }, runs: 3, seed: 9, periodsLeft: 2, periodsUsed: 2, state: null };
    const m = mergeRuns(a, b);
    assertJson([m.teams[1].titleOdds, m.teams[1].expectedPoints, m.teams[1].perCategory[0].chanceAboveLeader], [0.625, 6.5, null], 'team 1');
    assertJson([m.teams[2].titleOdds, m.teams[2].expectedPoints, m.teams[2].perCategory[0].chanceAboveLeader], [0.375, 5.5, 0.375], 'team 2');
    assertEq(m.teams[2].perCategory[0].current, 3, 'a deterministic field comes from a, not a weighted 99');
    assertEq(m.runs, 4, 'runs summed');
});

test('mergeRuns: an empty or missing side is no side', () => {
    const empty = { teams: {}, runs: 0, seed: 7, weeksUsed: 1, state: 'too few weeks to resample' };
    assertEq(mergeRuns(empty, H2H_B), H2H_B, 'empty first gives the second');
    assertEq(mergeRuns(H2H_A, empty), H2H_A, 'empty second gives the first');
    assertEq(mergeRuns(empty, { ...empty }), empty, 'two empties give the first');
    assertEq(mergeRuns(null, H2H_B), H2H_B, 'a null first');
    assertEq(mergeRuns(H2H_A, undefined), H2H_A, 'an undefined second');
});

test('mergeRuns: two seeded halves are the same answer as far as the enumeration can tell', () => {
    const halves = mergeRuns(
        simulateSeason(BASIS, FIX.schedule, RULES, { seed: 101, runs: 2000, minWeeks: 2, priorWeeks: 0 }),
        simulateSeason(BASIS, FIX.schedule, RULES, { seed: 202, runs: 2000, minWeeks: 2, priorWeeks: 0 }));
    assertEq(halves.runs, 4000, 'runs summed');
    Object.keys(FIX.enumerated).forEach(id => {
        close(halves.teams[id].odds, FIX.enumerated[id].odds, `team ${id} odds`, TOL);
    });
    const sum = Object.keys(halves.teams).reduce((s, id) => s + halves.teams[id].odds, 0);
    close(sum, 2, 'the merged odds still sum to the two seats', 1e-9);
});

// ==== amendment 4: the flags and the pooled prior ====

const PRIOR = FIX.prior;
const PRIOR_RULES = rulesFrom(PRIOR.settings, PRIOR.schedule, {});
const PRIOR_BASIS = resampleBasis(PRIOR.teamStats, { through: 1, scoring: PRIOR_RULES.scoring });
const priorSim = (priorWeeks, runs = 20000) => simulateSeason(PRIOR_BASIS, PRIOR.schedule, PRIOR_RULES,
    { seed: SEED, runs, minWeeks: 1, pointsFor: PRIOR.pointsFor, priorWeeks });

test('the prior is three weeks, and it is the default', () => {
    assertEq(PRIOR_WEEKS, 3, 'the named constant');
    const byDefault = simulateSeason(PRIOR_BASIS, PRIOR.schedule, PRIOR_RULES, { seed: SEED, runs: 500, minWeeks: 1, pointsFor: PRIOR.pointsFor });
    assertJson(byDefault.teams, priorSim(3, 500).teams, 'no option is the constant');
});

test('the pooled prior lands on the hand-enumerated odds', () => {
    const sim = priorSim(3);
    assertEq(PRIOR_RULES.scoring, 'points', 'a points league');
    close(sim.teams['1'].odds, PRIOR.enumerated['1'].odds, 'team 1: 3745/4096', 0.01);
    close(sim.teams['2'].odds, PRIOR.enumerated['2'].odds, 'team 2: 351/4096', 0.01);
    close(sim.teams['1'].odds + sim.teams['2'].odds, 1, 'one seat', 1e-9);
    close(sim.teams['1'].expectedWins, 2.25, 'team 1: 1 + 2 x 5/8', 0.02);
    close(sim.teams['2'].expectedWins, 0.75, 'team 2: 2 x 3/8', 0.02);
    close(sim.teams['1'].expectedWins + sim.teams['2'].expectedWins, 3, 'three matchups', 1e-9);
});

test('at no prior a team is exactly its weeks: one always wins, and neither flag is set', () => {
    const sim = priorSim(0, 2000);
    assertEq(sim.teams['1'].odds, 1, 'team 1 draws 100 every time');
    assertEq(sim.teams['2'].odds, 0, 'team 2 draws 90 every time');
    assertJson([sim.teams['1'].clinched, sim.teams['2'].eliminated], [false, false], 'team 2 at 2 points would pass team 1 at 1');
    assertJson(oddsFigure(sim.teams['1']), { pct: 99, bound: 'over', certain: null }, 'a sampled 100 without the flag is a bound');
    assertJson(oddsFigure(sim.teams['2']), { pct: 1, bound: 'under', certain: null }, 'and a sampled 0 likewise');
});

test('the flags are the prior\'s too: the draw changes nothing certainty reads', () => {
    const a = priorSim(0, 200), b = priorSim(3, 200);
    ['1', '2'].forEach(id => assertJson([b.teams[id].clinched, b.teams[id].eliminated], [a.teams[id].clinched, a.teams[id].eliminated], `team ${id}`));
    // The first instance's eliminated team stays at exactly 0 under the prior: no pooled week can lift a team past a bound that is about records, not scores.
    const first = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: 2000, minWeeks: 2 });
    assertEq(first.teams['3'].eliminated, true, 'Charlie is still eliminated');
    assertEq(first.teams['3'].odds, 0, 'and still never seated');
});

test('the same seed gives the same answer under the prior, and the prior moves the answer', () => {
    assertJson(priorSim(3, 1000).teams, priorSim(3, 1000).teams, 'seeded');
    const own = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: RUNS, minWeeks: 2, priorWeeks: 0 });
    const pooled = simulateSeason(BASIS, FIX.schedule, RULES, { seed: SEED, runs: RUNS, minWeeks: 2 });
    assertEq(JSON.stringify(own.teams) === JSON.stringify(pooled.teams), false, 'a different model, a different answer');
    close(Object.keys(pooled.teams).reduce((s, id) => s + pooled.teams[id].odds, 0), 2, 'and still two seats', 1e-9);
});

test('a team with no weeks of its own draws the pool', () => {
    const basis = { byTeam: { 1: PRIOR_BASIS.byTeam['1'], 2: [] }, weeksUsed: 1, tooFew: ['2'] };
    const sim = simulateSeason(basis, PRIOR.schedule, PRIOR_RULES, { seed: SEED, runs: 4000, minWeeks: 1, pointsFor: PRIOR.pointsFor });
    // The pool is team 1's one week, so both teams always draw 100: both games are ties, and team 1 finishes on 2 to team 2's 1.
    assertJson([sim.teams['1'].odds, sim.teams['2'].odds], [1, 0], 'every draw is the same score');
    assertJson([sim.teams['1'].expectedWins, sim.teams['2'].expectedWins], [2, 1], 'two ties');
});

test('what the face prints: the flag first, then the bound, then the figure', () => {
    assertJson(oddsFigure({ odds: 1, clinched: true, eliminated: false }), { pct: 100, bound: null, certain: 'clinched' }, 'clinched');
    assertJson(oddsFigure({ odds: 0, clinched: false, eliminated: true }), { pct: 0, bound: null, certain: 'eliminated' }, 'eliminated');
    assertJson(oddsFigure({ odds: 0.62, clinched: true }), { pct: 100, bound: null, certain: 'clinched' }, 'the flag outranks the sample');
    assertJson(oddsFigure({ odds: 0.999, clinched: false, eliminated: false }), { pct: 99, bound: 'over', certain: null }, '99.9 rounds to 100: a bound');
    assertJson(oddsFigure({ odds: 0.995 }), { pct: 99, bound: 'over', certain: null }, '99.5 rounds up');
    assertJson(oddsFigure({ odds: 0.994 }), { pct: 99, bound: null, certain: null }, '99.4 is 99, said plainly');
    assertJson(oddsFigure({ odds: 0.004 }), { pct: 1, bound: 'under', certain: null }, '0.4 rounds to 0: a bound');
    assertJson(oddsFigure({ odds: 0.005 }), { pct: 1, bound: null, certain: null }, '0.5 rounds to 1');
    assertJson(oddsFigure({ odds: 0.625 }), { pct: 63, bound: null, certain: null }, 'a middling figure');
    assertJson(oddsFigure({ clinched: 'yes', odds: 1 }), { pct: 99, bound: 'over', certain: null }, 'truthy is not true');
    assertEq(oddsFigure(null), null, 'no team');
});

// ==== amendment 5: the remaining schedule ====

test('the remaining schedule: who is left, and their combined record', () => {
    assertJson(remainingSchedule(FIX.schedule, RULES), {
        1: { gamesLeft: 1, opponents: ['4'], wins: 1, losses: 1, ties: 0, pct: 0.5 },     // Delta, 1-1-0
        2: { gamesLeft: 1, opponents: ['3'], wins: 0, losses: 2, ties: 0, pct: 0 },       // Charlie, 0-2-0
        3: { gamesLeft: 1, opponents: ['2'], wins: 1, losses: 0, ties: 1, pct: 0.75 },    // Bravo, 1-0-1
        4: { gamesLeft: 1, opponents: ['1'], wins: 1, losses: 0, ties: 1, pct: 0.75 }     // Alpha, 1-0-1
    }, 'the first instance');
});

test('an opponent met twice is counted twice', () => {
    assertJson(remainingSchedule(PRIOR.schedule, PRIOR_RULES), {
        1: { gamesLeft: 2, opponents: ['2', '2'], wins: 0, losses: 2, ties: 0, pct: 0 },
        2: { gamesLeft: 2, opponents: ['1', '1'], wins: 2, losses: 0, ties: 0, pct: 1 }
    }, 'two games of that record');
});

test('it reads the games simulateSeason draws, and no others', () => {
    const rules = { regSeasonWeeks: 2, scoring: 'points' };
    const schedule = [
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 2 } },
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 3 } },                         // a bye
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 2 }, away: { teamId: 3 } },    // left
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 1 } },                         // a bye
        { matchupPeriodId: 3, playoffTierType: 'WINNERS_BRACKET', winner: 'UNDECIDED', home: { teamId: 1 }, away: { teamId: 2 } },   // a playoff game
        { matchupPeriodId: 3, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 1 }, away: { teamId: 3 } }     // past the regular season
    ];
    assertJson(remainingSchedule(schedule, rules), {
        1: { gamesLeft: 0, opponents: [], wins: 0, losses: 0, ties: 0, pct: null },
        2: { gamesLeft: 1, opponents: ['3'], wins: 0, losses: 0, ties: 0, pct: null },    // team 3 has played nothing: null, never 0
        3: { gamesLeft: 1, opponents: ['2'], wins: 0, losses: 1, ties: 0, pct: 0 }        // team 2 is 0-1
    }, 'a bye is not a game; a playoff game and one past the boundary are not the regular season');
});

test('the opponents come in matchup order, whatever order the schedule lists them', () => {
    const rules = { regSeasonWeeks: 3 };
    const schedule = [
        { matchupPeriodId: 3, winner: 'UNDECIDED', home: { teamId: 1 }, away: { teamId: 3 } },
        { matchupPeriodId: 2, winner: 'UNDECIDED', home: { teamId: 2 }, away: { teamId: 1 } },
        { matchupPeriodId: 1, winner: 'TIE', home: { teamId: 2 }, away: { teamId: 3 } }
    ];
    const out = remainingSchedule(schedule, rules);
    assertJson(out['1'], { gamesLeft: 2, opponents: ['2', '3'], wins: 0, losses: 0, ties: 2, pct: 0.5 }, 'period 2 then period 3; two 0-0-1 opponents');
});

test('no rules, no schedule, a roto league: nothing', () => {
    assertJson(remainingSchedule(FIX.schedule, null), {}, 'no rules');
    assertJson(remainingSchedule([], RULES), {}, 'no schedule');
    assertJson(remainingSchedule(null, RULES), {}, 'null');
});

test('the games left agree with what the simulation plays', () => {
    const sched = remainingSchedule(FIX.schedule, RULES);
    const total = Object.keys(sched).reduce((sum, id) => sum + sched[id].gamesLeft, 0);
    assertEq(total, 4, 'two matchups, two sides each');
    // Expected wins sum to 6 = 4 played points + 2 remaining matchups: the same two games.
    close(Object.keys(SIM.teams).reduce((sum, id) => sum + SIM.teams[id].expectedWins, 0), 4 + total / 2, 'one schedule, read twice', 1e-9);
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
