// Unit tests for the matchup chance as a finished model (matchup-face.js). Open tests/matchup-face.test.html through any static server; green means every assertion held. The league is synthetic and built so the sides it yields are tests/fixtures/matchup-sides.json's own, which that suite works by hand; nothing is worked twice here.
import { matchupFaceModel, matchupFace } from '../src/data/matchup-face.js';
import { matchupOdds } from '../src/engines/matchup-odds.js';
import { recordPrediction } from '../src/data/odds-record.js';

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

const FIX = await (await fetch('fixtures/matchup-face.json')).json();
const SIDES = await (await fetch('fixtures/matchup-sides.json')).json();
const clone = value => JSON.parse(JSON.stringify(value));

// The league as a caller hands it in. The map's days are a Map, as the app builds it, and the two readers of a side are the fixture's own: its board sits on cumulativeScore.
const inputs = (change = {}) => {
    const fix = clone(FIX);
    return {
        payload: fix.payload, teamId: fix.teamId, sport: fix.sport, pool: fix.pool, proSchedule: fix.proSchedule,
        dayLinesOf: id => fix.dayLines[id] || null,
        matchupMap: { ...fix.matchupMap, byPeriod: new Map(fix.matchupMap.byPeriod) },
        read: { tallyOf: side => side.cumulativeScore || null, pointsOf: side => Number(side.totalPoints) || 0 },
        asOf: fix.asOf,
        ...change
    };
};
const GOT = matchupFaceModel(inputs(), null);

// ==== the model ====

test('the league assembles into the sides the sides suite works by hand', () => {
    assertEq(GOT.refusal, null, 'not refused');
    assertJson(GOT.matchup, { period: 2, day: 10, days: [8, 11], periodsLeft: 2, mine: 1, theirs: 2 }, 'the matchup, its days and the two left');
    // A rate's spread is read off a small step, so it is good to one part in a million.
    ['mine', 'theirs'].forEach(side => Object.keys(SIDES.expected[side]).forEach(id => {
        ['current', 'expectedRemaining', 'sd'].forEach(field => close(GOT.sides[side][id][field], SIDES.expected[side][id][field], `${side} ${id} ${field}`, 1e-6));
    }));
    assertJson(GOT.sides.rule, SIDES.expected.rule, 'the rule, rho and all');
    assertJson(GOT.sides.leftOut, SIDES.expected.leftOut, 'ERA left out, theirs having no outs');
    assertJson(GOT.sides.basis, SIDES.expected.basis, 'and built from the same players, seat games and floor');
});

test('each piece of the assembly is the one the contract names', () => {
    /**
     * THE LISTED START REPLACES THE SHARE, by hand. Give theirs outs on the board so ERA is a
     * contest, and project the pitcher at 20 runs in 5 games: 4 runs a game, on 18 outs.
     *
     *   listed    the one probable game is on the matchup's last day, so the listings reach its
     *             end: 1 appearance. Finish 27 x (3 + 4) / (27 + 18) = 4.2
     *   by share  2 season games in the club's 3, times 2 seat games = 4/3 appearances.
     *             Finish 27 x (3 + 16/3) / (27 + 24) = 225/51
     */
    const contest = () => {
        const league = inputs();
        league.payload.schedule[2].away.cumulativeScore.scoreByStat['34'] = { score: 27 };
        league.payload.schedule[2].away.cumulativeScore.scoreByStat['45'] = { score: 3 };
        league.pool.find(e => e.id === 103).player.stats[0].stats['45'] = 20;
        return league;
    };
    close(matchupFaceModel(contest(), null).sides.mine['47'].current, 4.2, 'by the listed start');
    const noListing = contest();
    noListing.pool.find(e => e.id === 103).player.starterStatusByProGame = {};
    const byShare = matchupFaceModel(noListing, null);
    close(byShare.sides.mine['47'].current, 225 / 51, 'by share, with no listing');
    assertEq(byShare.sides.basis.mine.seatGames, 4, 'the seat games do not depend on the listing');
    // A listing that stops short of the matchup's end is not used: the probable game moved to the day before the last, nothing is listed for the last, and the pitcher is placed by share.
    const short = contest();
    short.proSchedule.settings.proTeams[2].proGamesByScoringPeriod['10'] = [{ id: 9003, scoringPeriodId: 10, homeProTeamId: 3, awayProTeamId: 9, statsOfficial: false }];
    short.proSchedule.settings.proTeams[2].proGamesByScoringPeriod['11'] = [{ id: 9004, scoringPeriodId: 11, homeProTeamId: 3, awayProTeamId: 9, statsOfficial: false }];
    // The club now plays once on each day, so two seat games still: 4/3 appearances by share.
    close(matchupFaceModel(short, null).sides.mine['47'].current, 225 / 51, 'a listing short of the end is not trusted');
    // The floor is the league's: player 301 is on another roster of the same matchup and is in it.
    const without301 = inputs();
    without301.payload.schedule[3].home.rosterForCurrentScoringPeriod.entries = [];
    close(matchupFaceModel(without301, null).sides.mine['5'].sd, Math.sqrt(0.375 + (1 / 6) * 0.5), 'three bats left: the floor is 1/6, not 1/4', 1e-12);
    // The tie rule is the league's own.
    const ruled = inputs();
    ruled.payload.settings.scoringSettings.matchupTieRule = 'STAT_POINTS';
    ruled.payload.settings.scoringSettings.matchupTieRuleBy = 5;
    assertJson(matchupFaceModel(ruled, null).sides.rule.tie, { rule: 'STAT_POINTS', statId: '5' }, 'handed on');
});

test('the chance is matchupOdds over those sides, with its word and what a face shows', () => {
    const want = matchupOdds({ mine: GOT.sides.mine, theirs: GOT.sides.theirs }, GOT.sides.rule);
    assertEq(GOT.odds.chance, want.chance, 'the chance, every digit');
    assertEq(GOT.odds.tie, want.tie, 'the tie');
    assertEq(GOT.oddsReason, null, 'and no reason against it');
    assertEq(GOT.word, GOT.odds.chance + GOT.odds.tie / 2 >= 0.6 ? 'favoured' : (GOT.odds.chance + GOT.odds.tie / 2 < 0.4 ? 'behind' : 'close'), 'the word of that figure');
    assertEq(GOT.shows, 'number', 'baseball shows the number from the first day');
    assertJson(GOT.marks, { fallback: [], leftOut: [{ statId: '47', reason: 'no denominator', side: 'theirs' }] }, 'and the marks are what fell back and what was left out');
});

// ==== the record ====

test('the day is recorded once, under the league and not the reader', () => {
    assertEq(GOT.record.leagueKey, 'flb:4242', 'the sport and the league id');
    assertEq(GOT.record.recorded, true, 'recorded');
    assertEq(GOT.write, true, 'so there is something to write');
    const entry = GOT.store.entries['flb:4242|2027|2|10'];
    assertEq(entry.chance, GOT.odds.chance, 'the chance shown');
    assertEq(entry.day, 10, 'under today');
    assertEq(entry.asOf, FIX.asOf, 'with the caller clock, passed through');
    assertEq(JSON.stringify(GOT.store).includes('teamId'), false, 'and nothing of the reader in it');
});

test('a second look the same day writes nothing and hands the store back unchanged', () => {
    const again = matchupFaceModel(inputs(), GOT.store);
    assertEq(again.record.recorded, false, 'not recorded again');
    assertEq(again.record.reason, 'already recorded', 'and it says why');
    assertEq(again.write, false, 'nothing to write');
    assertEq(again.store, GOT.store, 'the very store handed in');
    // Even when the chance has moved since: the first figure of the day stands.
    const moved = inputs();
    moved.payload.schedule[2].home.cumulativeScore.scoreByStat['5'].score = 9;
    const later = matchupFaceModel(moved, GOT.store);
    assertEq(later.odds.chance > GOT.odds.chance, true, 'six more home runs is a better chance');
    assertEq(later.store.entries['flb:4242|2027|2|10'].chance, GOT.odds.chance, 'and the record keeps the first');
});

test('the finished matchups are read off the league own schedule, from the reader side', () => {
    // Matchup 1 was won at home by team 1. A prediction recorded for it is scored; today's waits.
    const before = recordPrediction(null, { leagueKey: 'flb:4242', season: 2027, matchupPeriod: 1, day: 3, chance: 0.7, tie: 0.1, lose: 0.2, asOf: null }).store;
    const got = matchupFaceModel(inputs(), before);
    assertEq(got.record.scored.scored, 1, 'one scored');
    assertEq(got.record.scored.pending, 1, 'one waiting');
    close(got.record.scored.brier, 0.0625, '0.75 said and it was won: a square of 0.0625');
    // From the other bench the same matchup was lost.
    const theirs = matchupFaceModel(inputs({ teamId: 2 }), before);
    close(theirs.record.scored.brier, 0.5625, '0.75 said and it was lost');
    assertEq(got.earned.earned, false, 'one matchup has earned nothing');
    assertEq(got.earned.reason, 'too few matchups', 'and says which bar');
});

// ==== no chance, and why ====

test('a league with no harvest gets its sides and no chance', () => {
    const got = matchupFaceModel(inputs({ dayLinesOf: null }), null);
    assertEq(got.refusal, null, 'not a refusal: the sides stand');
    close(got.sides.mine['5'].expectedRemaining, 0.8, 'the mean half as before');
    assertEq(got.odds, null, 'no chance');
    assertEq(got.oddsReason, 'no harvest', 'and the reason');
    assertEq(got.word, null, 'no word for a chance nobody has');
    assertEq(got.shows, null, 'and nothing to show');
    assertEq(got.record.recorded, false, 'nothing recorded');
    assertEq(got.record.reason, 'no odds', 'for want of a chance');
    assertEq(got.write, false, 'and nothing written');
    // A harvest that answers for nobody is the same thing.
    assertEq(matchupFaceModel(inputs({ dayLinesOf: () => null }), null).oddsReason, 'no harvest', 'a harvest of nobody');
});

test('a harvest that reached the hitters and not the pitchers refuses, and names the pitchers', () => {
    // A session that fetched part of the harvest: every bat has its lines and the one arm, 103, has none. The arm has a listed start still to come, so the pitchers have a game left and nobody measured. Give theirs outs on the board so ERA is a contest and would otherwise go on with a spread of nothing on mine.
    const partial = inputs();
    partial.payload.schedule[2].away.cumulativeScore.scoreByStat['34'] = { score: 27 };
    partial.payload.schedule[2].away.cumulativeScore.scoreByStat['45'] = { score: 3 };
    const lines = clone(FIX.dayLines);
    delete lines['103'];
    const got = matchupFaceModel({ ...partial, dayLinesOf: id => lines[id] || null }, null);
    assertEq(got.odds, null, 'no chance');
    assertEq(got.oddsReason, 'no harvest: pitchers', 'and the group is named');
    assertEq(got.sides.mine['47'].sd, 0, 'the spread that would have read as certain');
    close(got.sides.mine['5'].expectedRemaining, 0.8, 'while the sides stand, hitters and all');
    assertEq(got.record.recorded, false, 'and nothing is recorded');
    // The other way round: the bats unmeasured and the arm measured.
    const arms = { '103': clone(FIX.dayLines)['103'] };
    assertEq(matchupFaceModel({ ...partial, dayLinesOf: id => arms[id] || null }, null).oddsReason, 'no harvest: hitters', 'the hitters, named');
    // A group with no game left is not in the question: with the arm's club idle, the bats decide.
    const idle = inputs();
    delete idle.proSchedule.settings.proTeams[2].proGamesByScoringPeriod['11'];
    assertEq(matchupFaceModel({ ...idle, dayLinesOf: id => lines[id] || null }, null).oddsReason, null, 'no pitcher plays, so no pitcher needs a line');
});

test('hockey shows a word until its own record has earned the number', () => {
    // The same league as hockey would hold it: positions and slots read by the hockey table, no stat split by group. What matters here is the rule, not the figures.
    const hockey = inputs({ sport: 'fhl' });
    hockey.payload.settings.scoringSettings.scoringItems = [{ statId: 13 }];
    hockey.payload.settings.rosterSettings.lineupSlotCounts = { '3': 2, '7': 3, '8': 2 };
    hockey.payload.schedule[2].home.cumulativeScore.scoreByStat = { '13': { score: 4 } };
    hockey.payload.schedule[2].away.cumulativeScore.scoreByStat = { '13': { score: 3 } };
    hockey.pool.forEach(e => e.player.stats.forEach(row => { row.stats['30'] = row.stats['81'] || row.stats['32'] || 4; row.stats['13'] = row.statSourceId === 1 ? 8 : 2; }));
    const lines = clone(FIX.dayLines);
    Object.keys(lines).forEach(id => Object.keys(lines[id]).forEach((p, i) => { lines[id][p] = { '13': i % 2 }; }));
    const got = matchupFaceModel({ ...hockey, dayLinesOf: id => lines[id] || null }, null);
    assertEq(got.refusal, null, 'hockey has a seat table');
    assertEq(got.sides.rule.rho, 0.102, 'and its own rho');
    assertEq(typeof got.odds.chance, 'number', 'a chance is computed');
    assertEq(got.shows, 'word', 'and shown as a word');
    assertEq(got.record.recorded, true, 'while the number is recorded, which is how it is earned');
    assertEq(got.record.leagueKey, 'fhl:4242', 'under the hockey key');
});

// ==== the refusals ====

test('each refusal is a name and nothing else', () => {
    const refusalOf = change => { const got = matchupFaceModel(inputs(change), null); assertEq(Object.keys(got).join(), 'refusal', 'a refusal carries no model'); return got.refusal; };
    assertEq(refusalOf({ payload: null }), 'no payload', 'no payload');
    assertEq(refusalOf({ payload: { status: {}, settings: {} } }), 'no payload', 'a payload with no schedule');
    assertEq(refusalOf({ sport: 'ffl' }), 'sport not supported', 'football has no seat table');
    assertEq(refusalOf({ pool: [] }), 'no pool', 'an empty pool');
    assertEq(refusalOf({ pool: null }), 'no pool', 'and none');
    assertEq(refusalOf({ proSchedule: null }), 'no schedule', 'no pro schedule');
    assertEq(refusalOf({ matchupMap: null }), 'no schedule', 'and no map of the matchup days');
    assertEq(refusalOf({ teamId: 99 }), 'no matchup', 'a team with no game this matchup');
    const roto = inputs();
    roto.payload.settings.scoringSettings.scoringType = 'ROTO';
    assertEq(matchupFaceModel(roto, null).refusal, 'no matchup', 'a roto league has no matchup');
    const bye = inputs();
    bye.payload.schedule[2].away = undefined;
    assertEq(matchupFaceModel(bye, null).refusal, 'no matchup', 'and a bye is not one');
    assertEq(matchupFaceModel(undefined, null).refusal, 'no payload', 'nothing at all');
});

// ==== the storage verbs ====

// Run here, at module scope, so the cases below stay synchronous.
const verbs = () => { const log = { reads: 0, writes: [] }; return { log, readStore: async () => { log.reads += 1; return log.held || null; }, writeStore: async store => { log.writes.push(store); log.held = store; } }; };
const first = verbs();
const FIRST = await matchupFace(inputs(), first);
const SECOND = await matchupFace(inputs(), first);
const refused = verbs();
const REFUSED = await matchupFace(inputs({ sport: 'ffl' }), refused);
const broken = { log: { writes: [] }, readStore: async () => { throw new Error('storage is gone'); }, writeStore: async store => { broken.log.writes.push(store); } };
const BROKEN = await matchupFace(inputs(), broken);
const noOdds = verbs();
const NO_ODDS = await matchupFace(inputs({ dayLinesOf: null }), noOdds);

test('the store is read once and written once, and only when a prediction was recorded', () => {
    assertEq(first.log.reads, 2, 'read once a call');
    assertEq(first.log.writes.length, 1, 'written by the first call alone');
    assertEq(FIRST.record.recorded, true, 'the first recorded');
    assertEq(SECOND.record.recorded, false, 'the second found its key');
    assertEq(SECOND.record.reason, 'already recorded', 'and said so');
    assertEq('store' in FIRST || 'write' in FIRST, false, 'the model a face gets carries no store');
    assertEq(FIRST.odds.chance, GOT.odds.chance, 'and is otherwise the model');
    assertEq(noOdds.log.writes.length, 0, 'with no chance there is nothing to write');
    assertEq(NO_ODDS.oddsReason, 'no harvest', 'and the reason comes through');
});

test('a refusal writes nothing, and a store nobody could read is not written over', () => {
    assertEq(REFUSED.refusal, 'sport not supported', 'the refusal as it is');
    assertEq(refused.log.writes.length, 0, 'and nothing written');
    assertEq(BROKEN.record.recorded, false, 'not recorded');
    assertEq(BROKEN.record.reason, 'store unreadable', 'because the store could not be read');
    assertEq(broken.log.writes.length, 0, 'so a record nobody could see is not replaced');
    assertEq(BROKEN.odds.chance, GOT.odds.chance, 'while the chance is still given');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
