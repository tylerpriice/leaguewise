// Unit tests for every league at once (league-today.js). Open tests/league-today.test.html through any static server; green means every assertion held. Every expected value is computed by hand in tests/fixtures/league-today.md, never from a run of the module. Every id, name, date and figure in the fixture is invented.
import { activeByLookup, activeLeague, gameStateAt, leagueToday, leaguesToday, leaguesTodayAt } from '../src/engines/league-today.js';

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

const FIX = await (await fetch('fixtures/league-today.json')).json();
const NOW = FIX.now;
const HOUR = 3600000;
const input = (key, sport, extra = {}) => ({
    ...FIX.leagues[key], proSchedule: FIX.schedules[sport], rules: FIX.rules[sport], ...extra
});
const A = leagueToday({ ...input('A', 'fhl'), now: NOW });
const B = leagueToday({ ...input('B', 'ffl'), now: NOW });
const C = leagueToday({ ...input('C', 'fhl'), now: NOW });
const D = leagueToday({ ...input('D', 'fhl'), now: NOW });
const row = (league, id) => league.players.find(p => p.playerId === id);

// ==== which leagues ====

test('the lookup filter: mock, undrafted and out of season are dropped, in that order', () => {
    assertJson(activeByLookup(FIX.lookup.alpha), { keep: true, reason: null }, 'a drafted league in season');
    assertJson(activeByLookup(FIX.lookup.mock), { keep: false, reason: 'mock' }, 'a mock league, which is also undrafted');
    assertJson(activeByLookup(FIX.lookup.undrafted), { keep: false, reason: 'undrafted' }, 'not drafted');
    assertJson(activeByLookup(FIX.lookup.baseball), { keep: false, reason: 'out-of-season' }, 'inSeason false');
});

test('an absent mark is not a refusal', () => {
    assertJson(activeByLookup(FIX.lookup.noflag), { keep: true, reason: null }, 'no inSeason at all');
    assertJson(activeByLookup(null), { keep: true, reason: null }, 'a league entered by hand');
    assertJson(activeByLookup({ ...FIX.lookup.alpha, subType: 'SOMETHING_NEW' }), { keep: true, reason: null }, 'an unseen sub-type is not called a mock');
    assertEq(activeByLookup({ ...FIX.lookup.alpha, drafted: 1 }).reason, 'undrafted', 'truthy is not true');
});

test('the three lives: drafted and unplayed is active, undrafted and finished are not', () => {
    assertJson(activeLeague(null, FIX.leagues.A.payload), { active: true, life: 'underway', reason: null }, 'played');
    assertJson(activeLeague(null, FIX.leagues.C.payload), { active: true, life: 'preseason', reason: null }, 'drafted, not played');
    assertJson(activeLeague(null, FIX.leagues.D.payload), { active: false, life: null, reason: 'undrafted' }, 'not drafted');
    const finished = { ...FIX.leagues.A.payload, status: { ...FIX.leagues.A.payload.status, latestScoringPeriod: 191 } };
    assertJson(activeLeague(null, finished), { active: false, life: null, reason: 'finished' }, 'latest past final');
    assertJson(activeLeague(FIX.lookup.alpha, null), { active: false, life: null, reason: 'no-payload' }, 'kept by the lookup, nothing fetched');
    assertJson(activeLeague(FIX.lookup.mock, FIX.leagues.A.payload), { active: false, life: null, reason: 'mock' }, 'the lookup refuses first');
});

test('the drafted flag ESPN has not flipped yet: the roster view is the witness', () => {
    const payload = { ...FIX.leagues.C.payload, draftDetail: { drafted: false, inProgress: true } };
    assertJson(activeLeague(null, payload, FIX.leagues.C.rosterView), { active: true, life: 'preseason', reason: null }, 'every team in the roster view holds somebody');
    assertJson(activeLeague(null, payload), { active: false, life: null, reason: 'undrafted' }, 'no roster view: the flag stands');
    const oneEmpty = { teams: [...FIX.leagues.C.rosterView.teams, { id: 9, roster: { entries: [] } }] };
    assertEq(activeLeague(null, payload, oneEmpty).reason, 'undrafted', 'one empty team is a draft still running');
    const notRunning = { ...FIX.leagues.C.payload, draftDetail: { drafted: false, inProgress: false } };
    assertEq(activeLeague(null, notRunning, FIX.leagues.C.rosterView).reason, 'undrafted', 'rosters without a draft in progress prove nothing');
    const out = leagueToday({ ...input('C', 'fhl', { payload }), now: NOW });
    assertJson([out.life, out.lineupSource, out.players.length], ['preseason', 'rosterView', 2], 'and the league reads as drafted');
});

// ==== a game, off the clock ====

test('a game is later, started or over by its start time', () => {
    const g = { date: NOW - HOUR, statsOfficial: false };
    assertEq(gameStateAt({ date: NOW + 1 }, NOW, 9900000), 'later', 'a millisecond before the start');
    assertEq(gameStateAt({ date: NOW }, NOW, 9900000), 'started', 'at the start');
    assertEq(gameStateAt(g, NOW, 9900000), 'started', 'an hour in, under the length');
    assertEq(gameStateAt({ date: NOW - 9900000 }, NOW, 9900000), 'over', 'exactly the length');
    assertEq(gameStateAt({ date: NOW - 5 * HOUR }, NOW, 9900000), 'over', 'five hours on');
});

test('official is over at once, and no length never guesses an end', () => {
    assertEq(gameStateAt({ date: NOW - HOUR, statsOfficial: true }, NOW, 9900000), 'over', 'official inside the length');
    assertEq(gameStateAt({ date: NOW - 50 * HOUR }, NOW, null), 'started', 'no length: started until official');
    assertEq(gameStateAt({ date: NOW - 50 * HOUR, statsOfficial: true }, NOW), 'over', 'no length, official');
    assertEq(gameStateAt({ date: NOW + HOUR, statsOfficial: true }, NOW, 9900000), 'later', 'the clock comes first');
});

test('a game with no start, or no clock, has no state', () => {
    assertEq(gameStateAt({}, NOW, 9900000), null, 'no date');
    assertEq(gameStateAt(null, NOW, 9900000), null, 'no game');
    assertEq(gameStateAt({ date: NOW }, undefined, 9900000), null, 'no now');
});

// ==== league A, the header and rows ====

test('the header is the payload\'s own', () => {
    assertJson([A.leagueId, A.gameId, A.seasonId, A.name, A.scoringType, A.life, A.period, A.teamId, A.teamName],
        [101, 4, 2027, 'Alpha', 'H2H_POINTS', 'underway', 10, 3, 'Reader'], 'league A');
    assertEq(A.lineupSource, 'side', 'the lineup is on the payload\'s side');
    assertEq(A.gameLengthMs, 9900000, 'the length its games were judged over, carried on the model');
    assertEq(leagueToday({ ...input('A', 'fhl', { rules: { ...FIX.rules.fhl, gameLengthMs: undefined } }), now: NOW }).gameLengthMs, null, 'no length is null, never zero');
    assertJson(A.missing, [], 'nothing missing');
});

test('the rows are the reader\'s own side, in the lineup\'s order', () => {
    assertJson(A.players.map(p => p.playerId), [9001, 9002, 9003, 9004, 9007, 9005], 'the reader\'s side, not the rival\'s');
    assertJson(A.players.map(p => p.slotId), [0, 5, 7, 7, 7, 8], 'seats');
    assertJson(A.players.map(p => p.starting), [true, true, false, false, false, false], 'starting');
    assertJson(A.players.map(p => p.bench), [false, false, true, true, true, false], 'the injury seat is neither');
    assertEq(row(A, 9005).injuryStatus, 'OUT', 'the player\'s own status');
    assertJson(row(A, 9001).eligibleSlots, [0, 7, 8], 'ESPN\'s own eligibility');
});

test('each player\'s game and its state', () => {
    assertJson(row(A, 9001).game, { state: 'started', startsAt: NOW - HOUR, gameId: 501, home: true, opponentProTeamId: 5, count: 1 }, 'started, at home');
    assertJson(row(A, 9002).game, { state: 'none', startsAt: null, gameId: null, home: null, opponentProTeamId: null, count: 0 }, 'an idle club');
    assertJson(row(A, 9003).game, { state: 'later', startsAt: NOW + 2 * HOUR, gameId: 502, home: true, opponentProTeamId: 6, count: 1 }, 'later');
    assertEq(row(A, 9007).game.state, 'over', 'five hours on');
});

test('today\'s line: points, an empty line, and no line', () => {
    assertJson(row(A, 9001).line, { points: 4.5, stats: { 13: 1, 14: 2 }, empty: false }, 'a line with figures');
    assertJson(row(A, 9003).line, { points: null, stats: {}, empty: true }, 'a line that exists and is empty');
    assertEq(row(A, 9002).line, null, 'no line at all');
    assertJson(row(A, 9007).line, { points: 2, stats: { 13: 1 }, empty: false }, 'period 10\'s line, not period 9\'s');
    assertEq(row(A, 9001).projected, null, 'hockey carries no projected line for the day');
});

// ==== the alert ====

test('open seats are the starting seats left over', () => {
    assertJson(A.openSeats, [{ slotId: 4, count: 1 }], 'C and G are taken, D is open, the bench and a zero-count slot are not seats');
});

test('a benched player who plays and fits an open seat is the alert', () => {
    assertJson(A.alerts, [
        { playerId: 9003, fromSlotId: 7, openSlotIds: [4], tooLate: false },
        { playerId: 9007, fromSlotId: 7, openSlotIds: [4], tooLate: true }
    ], 'two, both naming the D seat');
});

test('who is not alerted', () => {
    const ids = A.alerts.map(a => a.playerId);
    assertEq(ids.includes(9004), false, 'benched and playing, but its only starting seat is taken');
    assertEq(ids.includes(9005), false, 'the injury seat, though it plays and fits');
    assertEq(ids.includes(9002), false, 'a starter whose club is idle is a swap, not an open seat');
});

test('no schedule, no alert, and it is said', () => {
    const blind = leagueToday({ ...input('A', 'fhl', { proSchedule: null }), now: NOW });
    assertJson(blind.alerts, [], 'nobody can be said to play');
    assertEq(blind.players.every(p => p.game === null), true, 'every game is unknown');
    assertJson(blind.missing, ['schedule'], 'named');
    assertJson(blind.openSeats, [{ slotId: 4, count: 1 }], 'the open seat still reads');
});

test('a club the schedule does not know is unknown, not idle', () => {
    const payload = JSON.parse(JSON.stringify(FIX.leagues.A.payload));
    payload.schedule[0].away.rosterForCurrentScoringPeriod.entries[2].playerPoolEntry.player.proTeamId = 0;
    const out = leagueToday({ ...input('A', 'fhl', { payload }), now: NOW });
    assertEq(row(out, 9003).game, null, 'club 0 is the free-agent pseudo-club');
    assertJson(out.alerts.map(a => a.playerId), [9007], 'and an unknown is never alerted');
});

test('no slot counts: no open seats, and it is said', () => {
    const payload = JSON.parse(JSON.stringify(FIX.leagues.A.payload));
    delete payload.settings.rosterSettings;
    const out = leagueToday({ ...input('A', 'fhl', { payload }), now: NOW });
    assertEq(out.openSeats, null, 'unknown, not none');
    assertJson(out.alerts, [], 'no alert on an unknown');
    assertJson(out.missing, ['slotCounts'], 'named');
});

// ==== the trend ====

test('the recent window against the season, in points a game', () => {
    assertJson(row(A, 9001).trend, {
        basis: 'points',
        season: { games: 40, perGame: 2.5 },
        windows: {
            7: { games: 4, total: 14, perGame: 3.5, delta: 1 },
            15: { games: 8, total: 20, perGame: 2.5, delta: 0 },
            30: { games: 16, total: 32, perGame: 2, delta: -0.5 }
        }
    }, '9001');
});

test('no games in the window is no rate, and an absent window is null', () => {
    assertJson(row(A, 9002).trend, {
        basis: 'points',
        season: { games: 20, perGame: 2.5 },
        windows: { 7: { games: 0, total: 0, perGame: null, delta: null }, 15: null, 30: null }
    }, 'this season\'s line, not 2026\'s');
});

test('a player off the roster view has no trend', () => {
    assertEq(row(A, 9003).trend, null, 'not on the roster view\'s team');
    const bare = leagueToday({ ...input('A', 'fhl', { rosterView: null }), now: NOW });
    assertEq(bare.players.every(p => p.trend === null), true, 'no roster view at all');
    assertJson(bare.missing, ['rosterView'], 'named');
    assertEq(bare.lineupSource, 'side', 'the lineup never needed it');
});

test('a categories league gets its rates side by side and nothing summed', () => {
    const view = { teams: [{ id: 3, roster: { entries: [{ lineupSlotId: 0, playerId: 9001, playerPoolEntry: { player: { stats: [
        { statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, seasonId: 2027, stats: { 30: 40, 13: 20, 11: 0.91 } },
        { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 0, seasonId: 2027, stats: { 30: 4, 13: 3, 11: 0.95 } }
    ] } } }] } }] };
    const rules = { ...FIX.rules.fhl, categoryIds: ['13', '11', '99'], rateIds: ['11'] };
    const out = leagueToday({ ...input('A', 'fhl', { rosterView: view, rules }), now: NOW });
    assertJson(row(out, 9001).trend, {
        basis: 'categories',
        season: { games: 40 },
        windows: {
            7: { games: 4, categories: [
                { id: '13', recent: 0.75, season: 0.5 },      // 3 in 4 games against 20 in 40
                { id: '11', recent: 0.95, season: 0.91 },     // a rate, undivided
                { id: '99', recent: null, season: null }      // a category neither line carries
            ] },
            15: null, 30: null
        }
    }, 'no direction and no single figure');
    const none = leagueToday({ ...input('A', 'fhl', { rosterView: view }), now: NOW });
    assertEq(row(none, 9001).trend, null, 'no category list, no trend');
});

// ==== football ====

test('football: the line appears at kickoff, the projection is there all week', () => {
    assertJson(row(B, 8001).line, { points: 12.5, stats: { 3: 180 }, empty: false }, 'the game has started');
    assertEq(row(B, 8001).projected, 18, 'beside its projection');
    assertEq(row(B, 8002).line, null, 'no line before kickoff');
    assertEq(row(B, 8002).projected, 9.5, 'the projection alone');
    assertJson(row(B, 8002).game, { state: 'later', startsAt: NOW + 26 * HOUR, gameId: 602, home: true, opponentProTeamId: 14, count: 1 }, 'later in the week');
    assertEq(row(B, 8003).game.state, 'none', 'a bye');
});

test('football has no trend yet, and says why', () => {
    assertEq(B.players.every(p => p.trend === null), true, 'no games-played stat');
    assertJson(B.missing, ['gamesId'], 'named');
    assertJson(B.openSeats, [], 'every starting seat taken');
    assertJson(B.alerts, [], 'nothing open');
    assertEq(B.period, 2, 'the week');
});

// ==== drafted, not played ====

test('a drafted league that has not played shows its lineup and no figures', () => {
    assertEq(C.life, 'preseason', 'drafted, unplayed');
    assertEq(C.lineupSource, 'rosterView', 'its sides carry no roster');
    assertJson(C.players.map(p => [p.playerId, p.slotId, p.bench]), [[7001, 0, false], [7002, 7, true]], 'the lineup');
    assertEq(C.players.every(p => p.line === null && p.projected === null && p.trend === null), true, 'no figure, though 7001\'s lines carry 82 games');
    assertEq(row(C, 7001).game.state, 'none', 'club 1 is idle in period 1');
    assertEq(row(C, 7002).game.state, 'later', 'a game still reads');
    assertJson(C.openSeats, [], 'no open seat');
    assertJson(C.missing, [], 'nothing missing: no figures is the rule, not a gap');
});

test('a league with no lineup anywhere says so', () => {
    const out = leagueToday({ ...input('C', 'fhl', { rosterView: null }), now: NOW });
    assertEq(out.players, null, 'no rows');
    assertEq(out.lineupSource, null, 'no source');
    assertEq(out.openSeats, null, 'no seats without a lineup');
    assertJson(out.missing, ['lineup'], 'named');
});

test('an inactive league is a header and nothing else', () => {
    assertJson([D.life, D.players, D.openSeats, D.lineupSource], [null, null, null, null], 'not drafted');
    assertJson(D.alerts, [], 'no alert');
    assertJson(D.missing, ['inactive'], 'named');
    assertEq(D.name, 'Delta', 'the header still reads');
    const mock = leagueToday({ ...input('A', 'fhl', { record: FIX.lookup.mock }), now: NOW });
    assertJson([mock.life, mock.players, mock.missing], [null, null, ['inactive']], 'the lookup\'s refusal is honoured');
});

// ==== every league ====

test('every league, in the order given, with the totals', () => {
    const all = leaguesToday([input('A', 'fhl'), input('B', 'ffl'), input('C', 'fhl'), input('D', 'fhl')], { now: NOW });
    assertJson(all.leagues.map(l => l.name), ['Alpha', 'Bravo', 'Charlie', 'Delta'], 'input order, the inactive one kept');
    assertJson(all.totals, { leagues: 3, players: 11, started: 3, alerts: 1 }, '6 + 3 + 2 rows; 9001, 9004 and 8001 started; 9003 alone not too late');
    assertJson(all.leagues[0], A, 'the same model one league at a time');
});

test('nothing in is nothing out, never a throw', () => {
    assertJson(leaguesToday([], { now: NOW }), { leagues: [], totals: { leagues: 0, players: 0, started: 0, alerts: 0 } }, 'no leagues');
    assertJson(leaguesToday(null), { leagues: [], totals: { leagues: 0, players: 0, started: 0, alerts: 0 } }, 'null');
    const empty = leagueToday({});
    assertJson([empty.life, empty.players, empty.missing], [null, null, ['inactive']], 'no payload');
});

test('the arguments are not changed', () => {
    const before = JSON.stringify(FIX.leagues.A);
    leagueToday({ ...input('A', 'fhl'), now: NOW });
    assertEq(JSON.stringify(FIX.leagues.A), before, 'the payload and the roster view are read, never written');
});

// ==== a model, read later ====

// Hand-built, in the model's own shape: a hockey league whose games run 9,900,000 ms, built at T.
const T = 1790000000000;
const KEPT = {
    leagues: [
        { name: 'Alpha', life: 'underway', gameLengthMs: 9900000,
          players: [
              { playerId: 1, game: { state: 'later', startsAt: T + 120000 } },      // starts in two minutes
              { playerId: 2, game: { state: 'started', startsAt: T - 9840000 } },   // one minute short of the length
              { playerId: 3, game: { state: 'over', startsAt: T + 600000 } },       // built as over: stays over
              { playerId: 4, game: { state: 'none', startsAt: null } },
              { playerId: 5, game: null },
              { playerId: 6, game: { state: 'later', startsAt: T + 3600000 } }
          ],
          alerts: [{ playerId: 1, fromSlotId: 7, openSlotIds: [4], tooLate: false }, { playerId: 6, fromSlotId: 7, openSlotIds: [4], tooLate: false }] },
        { name: 'Delta', life: null, gameLengthMs: 9900000, players: null, alerts: [] }
    ]
};

test('a model read at the moment it was built is unchanged', () => {
    const out = leaguesTodayAt(KEPT, T);
    assertJson(out.leagues, KEPT.leagues, 'the leagues as kept');
    assertJson(out.totals, { leagues: 1, players: 6, started: 1, alerts: 2 }, 'one active league, six rows, one started, two alerts in time');
});

test('three minutes on: a game has started, another has run its length, the alert is too late', () => {
    const out = leaguesTodayAt(KEPT, T + 180000);
    assertJson(out.leagues[0].players.map(p => p.game && p.game.state), ['started', 'over', 'over', 'none', null, 'later'],
        'the clock moves the states; over stays over; an idle club and an unknown are left');
    assertJson(out.leagues[0].alerts.map(a => a.tooLate), [true, false], 'the player whose game began is too late now');
    assertJson(out.totals, { leagues: 1, players: 6, started: 1, alerts: 1 }, 'the totals follow');
    assertEq(KEPT.leagues[0].players[0].game.state, 'later', 'the model handed in is not written');
    assertJson(out.leagues[1], KEPT.leagues[1], 'an inactive league passes through');
});

test('a model with no length never guesses an end', () => {
    const noLength = { leagues: [{ ...KEPT.leagues[0], gameLengthMs: null }] };
    const out = leaguesTodayAt(noLength, T + 180000);
    assertJson(out.leagues[0].players.map(p => p.game && p.game.state), ['started', 'started', 'over', 'none', null, 'later'],
        'a started game stays started; a model kept before the length was carried reads the same way');
});

test('the built model and the model read later agree', () => {
    const built = leaguesToday([input('A', 'fhl'), input('B', 'ffl'), input('C', 'fhl'), input('D', 'fhl')], { now: NOW });
    assertJson(leaguesTodayAt(built, NOW), built, 'read at its own moment, the model is itself');
    // Three hours on: hockey's started game (501, an hour in) has run 2 h 45; its later game (502, two hours off) has started. Football's started game (601) is four hours in, past 3 h 30.
    const later = leaguesTodayAt(built, NOW + 3 * HOUR);
    assertJson(later.leagues[0].players.map(p => p.game.state), ['over', 'none', 'started', 'over', 'over', 'started'], 'league A');
    assertJson(later.leagues[0].alerts.map(a => [a.playerId, a.tooLate]), [[9003, true], [9007, true]], '9003\'s game has begun');
    assertJson(later.leagues[1].players.map(p => p.game.state), ['over', 'later', 'none'], 'league B: 602 is still 23 hours off');
    assertJson(later.leagues[2].players.map(p => p.game.state), ['none', 'started'], 'league C: 504 began at three hours');
    assertJson(later.totals, { leagues: 3, players: 11, started: 3, alerts: 0 }, '9003, 9005 and 7002 started; no alert left in time');
});

test('nothing kept is an empty model, never a throw', () => {
    assertJson(leaguesTodayAt(null, T), { leagues: [], totals: { leagues: 0, players: 0, started: 0, alerts: 0 } }, 'null');
    assertJson(leaguesTodayAt({}, T), { leagues: [], totals: { leagues: 0, players: 0, started: 0, alerts: 0 } }, 'no leagues');
});

// ==== report ====

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
