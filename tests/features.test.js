// Unit tests for the pure/testable halves of the export (export.js) and weekly recap (recap.js) features - open tests/features.test.html through any static server (file:// won't work for ES modules;.claude/serve.ps1 is a zero-dependency option). The builders read the AppState singleton, so each test sets up exactly the state it needs first.
import { AppState } from '../state.js';
import {
    delimitedCell, buildDelimitedText, timeframeLabel,
    buildStandingsExport, buildCategoryTotalsExport
} from '../export.js';
import { buildLeaderboardExportModel, aggregateStatsForWeekRange, aggregateDailyCumulative, periodsOfMatchup } from '../players.js';
import {
    defaultRecapWeek, buildRecapModel, buildRecapText,
    detectMyTeamId, buildTeamMatchupRecapModel, buildTeamMatchupText
} from '../recap.js';
import { orderStatIdsByRole, splitStatIdsByRole, buildMatchupPeriodMap, matchupOfPeriod, getTimeframeBounds, parseTimeframe, injuryLabel, injuryBadgeHtml, playerPoolErrorText } from '../utils.js';
import { buildRosterGroups, rostersFromPayload, findOwnedTeamId } from '../myteam.js';
import { buildGamePeriodIndex, buildProTeamAbbrevs, typicalMatchupLength, currentMatchupWindow, countProjectedStarts, buildOddsIndex, moneylineFor } from '../probables.js';
import {
    isSidelined, teamOffence, percentileOf, offenceStrength, offenceBreakdown, pastStartsByOpponent,
    startDifficulty, difficultyLabel, daysBetween, venueTeamIdFor,
    SHORT_REST_ADJUSTMENT, MLB_PARK_FACTORS
} from '../matchup-difficulty.js';
import { numericStat } from '../utils.js';

const results = [];
function test(name, fn) {
    try { resetAppState(); fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg}: got ${a}, expected ${e}`);
}

function resetAppState() {
    AppState.apiData = null;
    AppState.teamStats = [];
    AppState.teamColorMap = {};
    AppState.availableStatsSet = new Set();
    AppState.scoredStatIds = new Set();
    AppState.isPointsLeague = false;
    AppState.isRotoLeague = false;
    AppState.timeframe = 'all';
    AppState.maxCompletedWeek = 3;
    AppState.regSeasonWeeks = 16;
    AppState.playerData = [];
    AppState.playerDataLoaded = false;
    AppState.playerWeeklyCache = {};
    AppState.playerSortStat = 'total';
    AppState.playerSortDir = 'desc';
    AppState.playerSearchQuery = '';
    AppState.playerPositionFilter = 'ALL';
    AppState.playerAvailabilityFilter = 'all';
    AppState.playerGroup = 'primary';
    AppState.showAdvancedStats = false;
    AppState.requireMinPlayingTime = true;
    AppState.userSwid = '';
}

// Team factory matching the shape processCoreData builds (data.js). weeklyMatchResult carries the 1/0.5/0 per-week win result for points leagues, whose weeklyMatchWins holds raw points.
const T = (id, name, weeklyMatchWins, weeklyCatWins, weeklyCats = {}, weeklyMatchResult = {}, weeklyBye = {}) => ({
    id, name, abbrev: name.slice(0, 4).toUpperCase(),
    seasonCats: {}, weeklyMatchWins, weeklyMatchResult, weeklyCatWins, weeklyCats, weeklyTier: {}, weeklyBye
});

// Player factory matching processPlayerData's output shape (players.js). teamId null = free agent, a number = rostered on that fantasy team.
const P = (id, name, seasonTotals, positions = ['SS'], teamId = null) => ({
    id, name, positionId: 6, positionName: positions[0],
    eligiblePositions: positions, positionDisplay: positions.join('/'),
    teamId, teamName: teamId == null ? 'Free Agent' : `Team ${teamId}`, teamColor: null,
    seasonTotals, projectedTotals: {}, appliedTotal: 0, projectedAppliedTotal: 0
});

// ==== CSV primitives ====

test('delimitedCell: quoting only when needed, quotes double, blanks for null-ish', () => {
    assertEq(delimitedCell('plain', ','), 'plain', 'plain text unquoted');
    assertEq(delimitedCell(42, ','), '42', 'numbers pass through');
    assertEq(delimitedCell('a,b', ','), '"a,b"', 'embedded delimiter quotes');
    assertEq(delimitedCell('say "hi"', ','), '"say ""hi"""', 'embedded quotes double');
    assertEq(delimitedCell('two\nlines', ','), '"two\nlines"', 'newline quotes');
    assertEq(delimitedCell(undefined, ','), '', 'undefined -> empty cell');
    assertEq(delimitedCell(null, ','), '', 'null -> empty cell');
    assertEq(delimitedCell('a,b', '\t'), 'a,b', 'comma unquoted under TSV');
    assertEq(delimitedCell('a\tb', '\t'), '"a\tb"', 'tab quoted under TSV');
});

test('buildDelimitedText: CRLF rows, headers first, delimiter honored', () => {
    const text = buildDelimitedText(['A', 'B'], [[1, 'x,y'], [2, 'z']], ',');
    assertEq(text, 'A,B\r\n1,"x,y"\r\n2,z', 'CSV output');
    const tsv = buildDelimitedText(['A', 'B'], [[1, 'x,y']], '\t');
    assertEq(tsv, 'A\tB\r\n1\tx,y', 'TSV output');
});

test('timeframeLabel: resolves the shared timeframe to a readable range', () => {
    AppState.timeframe = 'last1';
    AppState.maxCompletedWeek = 9;
    assertEq(timeframeLabel(), 'Current Matchup (Matchups 9-9)', 'lookback label');
    AppState.timeframe = 'all';
    assertEq(timeframeLabel(), 'Regular Season + Playoffs (Matchups 1-9)', 'full label');
});

test('timeframeLabel: a roto league says Weeks, not Matchups', () => {
    // Roto has no matchup periods - its timeframe pills are "Last N Weeks" and its axes read WK, so an export labelled in matchups would contradict the control the user picked it with.
    AppState.isRotoLeague = true;
    AppState.timeframe = 'last4';
    AppState.maxCompletedWeek = 12;
    assertEq(timeframeLabel(), 'Last 4 Weeks (Weeks 9-12)', 'roto lookback label');
    AppState.timeframe = 'all';
    assertEq(timeframeLabel(), 'Regular Season + Playoffs (Weeks 1-12)', 'roto full label');
});

// ==== Standings / category totals exports ====

test('buildStandingsExport: category league: records, order, cat-wins tiebreak', () => {
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 1, 2: 1, 3: 1 }, { 1: 6, 2: 7, 3: 5 }),
        T(2, 'Bravos', { 1: 0, 2: 0.5, 3: 0 }, { 1: 4, 2: 5, 3: 3 }),
        T(3, 'Charlies', { 1: 0, 2: 0.5, 3: 1 }, { 1: 5, 2: 5, 3: 6 })
    ];
    const { headers, rows } = buildStandingsExport();
    assertEq(headers, ['Rank', 'Team', 'W', 'L', 'T', 'Match Wins', 'Cat Wins'], 'headers');
    assertEq(rows[0], [1, 'Alphas', 3, 0, 0, 3, 18], 'leader row');
    assertEq(rows[1], [2, 'Charlies', 1, 1, 1, 1.5, 16], 'second row with tie');
    assertEq(rows[2], [3, 'Bravos', 0, 2, 1, 0.5, 12], 'trailer row');
});

test('buildStandingsExport: timeframe windows the totals', () => {
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 1, 2: 0, 3: 0 }, { 1: 6, 2: 2, 3: 2 }),
        T(2, 'Bravos', { 1: 0, 2: 1, 3: 1 }, { 1: 4, 2: 8, 3: 8 })
    ];
    AppState.timeframe = 'last2'; // matchups 2-3 only, week 1 excluded
    const { rows } = buildStandingsExport();
    assertEq(rows[0], [1, 'Bravos', 2, 0, 0, 2, 16], 'window winner, week 1 not counted');
    assertEq(rows[1], [2, 'Alphas', 0, 2, 0, 0, 4], 'window loser');
});

test('buildStandingsExport: single-matchup window ranks by categories won, no record', () => {
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 1, 2: 0, 3: 0 }, { 1: 6, 2: 2, 3: 2 }),
        T(2, 'Bravos', { 1: 0, 2: 1, 3: 1 }, { 1: 4, 2: 8, 3: 8 })
    ];
    AppState.timeframe = 'last1'; // matchup 3 only, and one game cannot make a record
    const { headers, rows } = buildStandingsExport();
    assertEq(headers, ['Rank', 'Team', 'Categories Won'], 'no W-L columns for a single matchup');
    assertEq(rows[0], [1, 'Bravos', 8], 'ranked by categories won this matchup');
    assertEq(rows[1], [2, 'Alphas', 2], 'trailer by categories won');
});

test('buildStandingsExport: single-matchup points window ranks by points, no record', () => {
    AppState.isPointsLeague = true;
    AppState.teamStats = [
        T(1, 'Alphas', { 3: 100.5 }, {}, {}, { 3: 0 }),
        T(2, 'Bravos', { 3: 120 }, {}, {}, { 3: 1 })
    ];
    AppState.timeframe = 'last1'; // matchup 3 only
    const { headers, rows } = buildStandingsExport();
    assertEq(headers, ['Rank', 'Team', 'Points'], 'points-only column for a single matchup');
    assertEq(rows[0], [1, 'Bravos', 120], 'ranked by points this matchup');
    assertEq(rows[1], [2, 'Alphas', 100.5], 'trailer by points');
});

test('buildStandingsExport: points league: real match record plus points for', () => {
    AppState.isPointsLeague = true;
    // weeklyMatchWins holds points; weeklyMatchResult holds the 1/0.5/0 result (Bravos outscored Alphas both weeks, so Bravos is 2-0 and Alphas 0-2), so the export shows a genuine record AND Points For, not the points total mislabeled as wins.
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 100.5, 2: 90.25 }, {}, {}, { 1: 0, 2: 0 }),
        T(2, 'Bravos', { 1: 120, 2: 95 }, {}, {}, { 1: 1, 2: 1 })
    ];
    AppState.maxCompletedWeek = 2;
    const { headers, rows } = buildStandingsExport();
    assertEq(headers, ['Rank', 'Team', 'W', 'L', 'T', 'Match Wins', 'Points For'], 'points headers');
    assertEq(rows[0], [1, 'Bravos', 2, 0, 0, 2, 215], 'match-wins leader with points-for');
    assertEq(rows[1], [2, 'Alphas', 0, 2, 0, 0, 190.75], 'match-wins trailer with points-for');
    AppState.isPointsLeague = false;
});

test('buildStandingsExport: a playoff bye scores points but no result', () => {
    AppState.isPointsLeague = true;
    // Week 2 is a bye for Bravos. ESPN gives the resting team a one-sided game with no opponent, so it has points on the board and no winner. Counting that as "not a win" gave the league champion a playoff loss.
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 100.5, 2: 90.25 }, {}, {}, { 1: 0, 2: 1 }),
        T(2, 'Bravos', { 1: 120, 2: 106.7 }, {}, {}, { 1: 1 }, { 2: true })
    ];
    AppState.maxCompletedWeek = 2;
    const { rows } = buildStandingsExport();
    // 1W-0L-0T, not 1W-1L. The bye is in neither column, and its 106.7 still counts for Points For.
    assertEq(rows[0], [1, 'Bravos', 1, 0, 0, 1, 226.7], 'the bye week counts points, not a loss');
    assertEq(rows[1], [2, 'Alphas', 1, 1, 0, 1, 190.75], 'the opponent record is untouched');
    AppState.isPointsLeague = false;
});

test('buildCategoryTotalsExport: sums counting stats, averages rate stats, gates advanced', () => {
    AppState.availableStatsSet = new Set(['5', '2', '3']); // HR, AVG, 2B
    AppState.scoredStatIds = new Set(['5', '2']);
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 1, 2: 1 }, { 1: 5, 2: 5 }, {
            1: { '5': 2, '2': 0.3, '3': 4 },
            2: { '5': 1, '2': 0.2, '3': 2 }
        })
    ];
    AppState.maxCompletedWeek = 2;
    const scoredOnly = buildCategoryTotalsExport('flb', false);
    assertEq(scoredOnly.headers, ['Team', 'HR', 'AVG'], 'scored-only headers');
    assertEq(scoredOnly.rows[0], ['Alphas', 3, 0.25], 'HR summed, AVG averaged');
    const withAdvanced = buildCategoryTotalsExport('flb', true);
    assertEq(withAdvanced.headers, ['Team', 'HR', 'AVG', '2B'], 'advanced adds unscored columns');
    assertEq(withAdvanced.rows[0], ['Alphas', 3, 0.25, 6], 'advanced values');
});

// ==== Leaderboard export model ====

test('buildLeaderboardExportModel: mirrors table: rank sort, min-games exclusion, headers', () => {
    AppState.playerDataLoaded = true;
    AppState.scoredStatIds = new Set(['5']);
    AppState.playerData = [
        P(1, 'Alpha Slugger', { '5': 30, '81': 100 }),
        P(2, 'Beta Bat', { '5': 20, '81': 100 }),
        P(3, 'Callup Kid', { '5': 40, '81': 10 }) // under 20% of leader's games
    ];
    const model = buildLeaderboardExportModel();
    assertEq(model.headers, ['Player', 'Team', 'Pos', 'Rank', 'Rank Score', 'GP', 'HR'], 'headers');
    assertEq(model.rows.length, 2, 'call-up excluded like the table');
    assertEq(model.rows[0], ['Alpha Slugger', 'Free Agent', 'SS', 1, 100, 100, 30], 'leader row');
    // Beta's HR percentile is 0 and he's at full workload (no shrinkage pull toward 50), so his Rank Score is a true 0.
    assertEq(model.rows[1], ['Beta Bat', 'Free Agent', 'SS', 2, 0, 100, 20], 'second row');
});

test('buildLeaderboardExportModel: search + position filters apply; null before load', () => {
    assert(buildLeaderboardExportModel() === null, 'null when pool not loaded');
    AppState.playerDataLoaded = true;
    AppState.scoredStatIds = new Set(['5']);
    AppState.playerData = [
        P(1, 'Alpha Slugger', { '5': 30, '81': 100 }, ['SS']),
        P(2, 'Beta Bat', { '5': 20, '81': 100 }, ['1B'])
    ];
    AppState.playerPositionFilter = '1B';
    const model = buildLeaderboardExportModel();
    assertEq(model.rows.length, 1, 'position filter applies');
    assertEq(model.rows[0][0], 'Beta Bat', 'filtered to 1B player');
    assertEq(model.rows[0][3], 1, 'rank is within the filtered pool');
});

test('availability filter: FA/rostered narrow rows but never change the Rank pool', () => {
    AppState.playerDataLoaded = true;
    AppState.scoredStatIds = new Set(['5']);
    AppState.playerData = [
        P(1, 'Rostered Ace', { '5': 30, '81': 100 }, ['SS'], 7),   // on a team
        P(2, 'Free Agent Joe', { '5': 20, '81': 100 }, ['SS'], null) // free agent
    ];

    AppState.playerAvailabilityFilter = 'fa';
    let model = buildLeaderboardExportModel();
    assertEq(model.rows.length, 1, 'only the free agent shows');
    assertEq(model.rows[0][0], 'Free Agent Joe', 'free agent row');
    // Rank pool is still the full same-role pool. The FA is #2 of 2, not an isolated #1 of 1.
    assertEq(model.rows[0][3], 2, 'rank stays relative to the whole pool');

    AppState.playerAvailabilityFilter = 'rostered';
    model = buildLeaderboardExportModel();
    assertEq(model.rows.length, 1, 'only the rostered player shows');
    assertEq(model.rows[0][0], 'Rostered Ace', 'rostered row');
    assertEq(model.rows[0][3], 1, 'rostered player is #1');

    AppState.playerAvailabilityFilter = 'all';
    assertEq(buildLeaderboardExportModel().rows.length, 2, 'all shows everyone');
});

// ==== Recap model + text ====

// Category-league schedule game: cumulativeScore per side, decided winner.
const catGame = (week, homeId, awayId, homeWLT, awayWLT, winner) => ({
    matchupPeriodId: week,
    winner,
    home: { teamId: homeId, cumulativeScore: { wins: homeWLT[0], losses: homeWLT[1], ties: homeWLT[2] } },
    away: { teamId: awayId, cumulativeScore: { wins: awayWLT[0], losses: awayWLT[1], ties: awayWLT[2] } }
});

function setupRecapLeague() {
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 1, 2: 1 }, { 1: 6, 2: 7 }),
        T(2, 'Bravos', { 1: 0, 2: 0 }, { 1: 4, 2: 2 }),
        T(3, 'Charlies', { 1: 1, 2: 1 }, { 1: 5, 2: 5 }),
        T(4, 'Deltas', { 1: 0, 2: 0 }, { 1: 3, 2: 4 })
    ];
    AppState.teamColorMap = { 1: '#e6194b', 2: '#3cb44b', 3: '#ffe119', 4: '#4363d8' };
    AppState.maxCompletedWeek = 2;
    AppState.apiData = {
        seasonId: 2025,
        settings: { name: 'Test League' },
        schedule: [
            catGame(1, 1, 3, [6, 3, 1], [3, 6, 1], 'HOME'),
            catGame(1, 4, 2, [5, 4, 1], [4, 5, 1], 'HOME'),
            catGame(2, 1, 2, [7, 2, 1], [2, 7, 1], 'HOME'),
            catGame(2, 3, 4, [5, 4, 1], [4, 5, 1], 'HOME'),
            catGame(3, 1, 4, [2, 1, 0], [1, 2, 0], 'UNDECIDED')
        ]
    };
}

test('defaultRecapWeek: latest fully-decided week, ignoring the in-progress one', () => {
    setupRecapLeague();
    assertEq(defaultRecapWeek(), 2, 'week 3 is undecided, week 2 is complete');
});

test('buildRecapModel: winners, blowout vs nail-biter, team of the week, movement', () => {
    setupRecapLeague();
    const m = buildRecapModel(2);
    assertEq(m.leagueName, 'Test League', 'league name');
    assertEq(m.week, 2, 'week');
    assert(!m.inProgress, 'completed week not marked in progress');
    assertEq(m.results.length, 2, 'two matchups');
    assertEq(m.results[0].winner.name, 'Alphas', 'winner resolved');
    assertEq(m.results[0].winner.scoreStr, '7-2-1', 'winner score string');
    assertEq(m.blowout.winner.name, 'Alphas', 'blowout is the 5-cat margin');
    assertEq(m.nailbiter.winner.name, 'Charlies', 'nail-biter is the 1-cat margin');
    assertEq(m.teamOfWeek.name, 'Alphas', 'most cat wins this week');
    assertEq(m.teamOfWeek.value, 7, 'team-of-week value');
    // Standings thru wk2: Alphas(2 wins,13 cats), Charlies(2,10), Deltas(0,7), Bravos(0,6). Thru wk1 the 0-win tiebreak went Bravos(4) over Deltas(3) - so Deltas climbed one.
    assertEq(m.standings.map(s => s.name), ['Alphas', 'Charlies', 'Deltas', 'Bravos'], 'standings order');
    assertEq(m.standings[2].move, 1, 'Deltas climbed via cat-wins tiebreak');
    assertEq(m.standings[3].move, -1, 'Bravos dropped');
    assertEq(m.standings[0].record, '2-0-0', 'record string');
});

test('buildRecapModel: in-progress week flagged, no winner claimed', () => {
    setupRecapLeague();
    AppState.maxCompletedWeek = 3;
    const m = buildRecapModel(3);
    assert(m.inProgress, 'undecided game marks the week in progress');
    assert(m.results[0].winner === null, 'no winner for an undecided game');
    assert(m.blowout === null, 'no blowout from undecided games');
});

test('buildRecapModel: a points league ranks by matchups won, not points scored', () => {
    AppState.isPointsLeague = true;
    AppState.apiData = {
        schedule: [
            { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 90 }, away: { teamId: 2, totalPoints: 120 }, winner: 'AWAY' },
            { matchupPeriodId: 2, home: { teamId: 1, totalPoints: 200 }, away: { teamId: 2, totalPoints: 95 }, winner: 'HOME' }
        ]
    };
    // Alphas scored far more overall but split the matchups; Bravos won one too. Ordering by points put Alphas first on a season it did not win more of, and every team read as 0 wins because no weekly points total was exactly 1.00.
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 90, 2: 200 }, {}, {}, { 1: 0, 2: 1 }),
        T(2, 'Bravos', { 1: 120, 2: 95 }, {}, {}, { 1: 1, 2: 0 })
    ];
    AppState.maxCompletedWeek = 2;
    const m = buildRecapModel(2);
    assertEq(m.standings.map(s => s.record), ['1-1-0', '1-1-0'], 'both are 1-1, not 0-2');
    assertEq(m.standings[0].name, 'Alphas', 'points break the tie once records match');
    assertEq(m.standings.map(s => s.detail), ['290 pts', '215 pts'], 'points shown beside the record');
    AppState.isPointsLeague = false;
});

test('buildRecapModel: a points-league bye counts points but no result', () => {
    AppState.isPointsLeague = true;
    AppState.apiData = { schedule: [{ matchupPeriodId: 1, home: { teamId: 1, totalPoints: 90 }, away: { teamId: 2, totalPoints: 120 }, winner: 'AWAY' }] };
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 90, 2: 106.7 }, {}, {}, { 1: 0 }, { 2: true }),
        T(2, 'Bravos', { 1: 120, 2: 100 }, {}, {}, { 1: 1, 2: 1 })
    ];
    AppState.maxCompletedWeek = 2;
    const m = buildRecapModel(1);
    const alphas = m.standings.find(s => s.name === 'Alphas');
    assertEq(alphas.record, '0-1-0', 'the bye is in neither column');
    AppState.isPointsLeague = false;
});

test('buildRecapText: contains results, highlights, movement, branding', () => {
    setupRecapLeague();
    const text = buildRecapText(buildRecapModel(2));
    assert(text.startsWith('🏆 Test League: Matchup 2 Recap'), `title line: ${text.split('\n')[0]}`);
    assert(text.includes('✅ Alphas def. Bravos (7-2-1)'), 'result line');
    assert(text.includes('💥 Blowout: Alphas over Bravos (7-2-1)'), 'blowout line');
    assert(text.includes('😬 Nail-biter: Charlies edged Deltas (5-4-1)'), 'nail-biter line');
    assert(text.includes('⭐ Team of the Week: Alphas (7 category wins)'), 'team of the week line');
    assert(text.includes('3. Deltas (0-2-0) ▲1'), 'climb marked');
    assert(text.includes('4. Bravos (0-2-0) ▼1'), 'drop marked');
    assert(text.includes('Made with Leaguewise'), 'branding footer');
});

// ==== Team matchup recap ====

// A single head-to-head week. Team 8 (me) hosts team 3. I win HR (10>8) and R (5>3); they win ERA (2.5<3.5, lower is better) - so I take the matchup 2-1-0.
function setupTeamMatchupLeague() {
    AppState.scoredStatIds = new Set(['5', '47', '20']); // HR, ERA(inverse), R
    AppState.teamStats = [
        T(8, 'My Team', { 1: 1 }, { 1: 2 }, { 1: { '5': 10, '47': 3.5, '20': 5 } }),
        T(3, 'Rivals', { 1: 0 }, { 1: 1 }, { 1: { '5': 8, '47': 2.5, '20': 3 } })
    ];
    AppState.teamColorMap = { 8: '#e6194b', 3: '#3cb44b' };
    AppState.maxCompletedWeek = 1;
    AppState.userSwid = '{abc}'; // lower-case on purpose - detection must be case/brace tolerant
    AppState.apiData = {
        seasonId: 2025,
        settings: { name: 'H2H League' },
        teams: [
            { id: 8, primaryOwner: '{ABC}', owners: ['{ABC}'] },
            { id: 3, primaryOwner: '{XYZ}', owners: ['{XYZ}'] }
        ],
        schedule: [catGame(1, 8, 3, [2, 1, 0], [1, 2, 0], 'HOME')]
    };
}

test('detectMyTeamId: matches SWID owner case/brace-insensitively; null when unknown', () => {
    setupTeamMatchupLeague();
    assertEq(detectMyTeamId(), 8, 'lower-case {abc} matches owner {ABC}');
    AppState.userSwid = '';
    assert(detectMyTeamId() === null, 'no SWID -> no detection');
    AppState.userSwid = '{NOBODY}';
    assert(detectMyTeamId() === null, 'unknown SWID -> no detection');
});

test('buildTeamMatchupRecapModel: sides, result, per-category winners (inverse-aware)', () => {
    setupTeamMatchupLeague();
    const m = buildTeamMatchupRecapModel(1, 8);
    assertEq(m.me.name, 'My Team', 'my side');
    assertEq(m.opp.name, 'Rivals', 'opponent side');
    assertEq(m.result, 'W', 'I won the matchup');
    assertEq(m.me.scoreStr, '2-1-0', 'category record');
    assertEq([m.catsWon, m.catsLost, m.catsTied], [2, 1, 0], 'category tally');
    const byId = Object.fromEntries(m.categories.map(c => [c.id, c.winnerSide]));
    assertEq(byId['5'], 'me', 'HR: higher wins -> me');
    assertEq(byId['20'], 'me', 'R: higher wins -> me');
    assertEq(byId['47'], 'opp', 'ERA: lower wins -> opponent');
    assert(m.categories.find(c => c.id === '47').inverse === true, 'ERA flagged inverse');
});

test('buildTeamMatchupRecapModel: bye week returns a noGame stub', () => {
    setupTeamMatchupLeague();
    const m = buildTeamMatchupRecapModel(2, 8); // no week-2 game
    assert(m.noGame === true, 'noGame stub');
    assertEq(m.teamName, 'My Team', 'stub still names the team');
});

test('buildTeamMatchupText: H2H headline + category lines + branding', () => {
    setupTeamMatchupLeague();
    const text = buildTeamMatchupText(buildTeamMatchupRecapModel(1, 8));
    assert(text.startsWith('🥊 H2H League: Matchup 1'), `headline: ${text.split('\n')[0]}`);
    assert(text.includes('My Team defeated Rivals, 2-1-0'), 'result line');
    assert(text.includes('✅ HR: 10 vs 8'), 'won category line');
    assert(text.includes('❌ ERA: 3.500 vs 2.500'), 'lost category line');
    assert(text.includes('Made with Leaguewise'), 'branding footer');
});

// ==== Role-grouped stat ordering (utils.js) - the one helper every mixed stat list orders through ====

test('orderStatIdsByRole: baseball puts batting before pitching, keeping order within each group', () => {
    // 5 HR, 20 R, 81 GP are batting; 47 ERA, 53 W are pitching. Interleaved on the way in, so this also covers the real source order (81 sorts after the pitching block numerically).
    assertEq(orderStatIdsByRole('flb', ['5', '47', '20', '53', '81']),
        ['5', '20', '81', '47', '53'], 'batting group first, relative order intact');
});

test('orderStatIdsByRole: hockey puts skaters before goalies (the numeric order is the reverse)', () => {
    // 13 G, 29 SOG, 32 BLK are skater ids; 1 W, 10 GAA are goalie ids. Ascending numeric order would lead with the goalie ids, which is exactly what the heatmap used to do.
    assertEq(orderStatIdsByRole('fhl', ['1', '13', '10', '29', '32']),
        ['13', '29', '32', '1', '10'], 'skater group first, relative order intact');
});

test('orderStatIdsByRole: a single-role list comes back untouched (both directions)', () => {
    assertEq(orderStatIdsByRole('flb', ['20', '5', '81']), ['20', '5', '81'], 'batting only, unsorted input preserved');
    assertEq(orderStatIdsByRole('fhl', ['10', '1', '7']), ['10', '1', '7'], 'goalie only, unsorted input preserved');
    assertEq(orderStatIdsByRole('flb', []), [], 'empty list');
});

test('orderStatIdsByRole: numeric ids and unknown sports are handled', () => {
    // availableStatsSet can hold numbers while the role sets are string-keyed.
    assertEq(orderStatIdsByRole('flb', [5, 47, 20]), [5, 20, 47], 'numeric ids split correctly');
    assertEq(orderStatIdsByRole('fba', ['47', '5']), ['47', '5'], 'sport with no role set is a passthrough');
});

test('splitStatIdsByRole: reports both groups, so the recap knows where to draw its divider', () => {
    const mixed = splitStatIdsByRole('fhl', ['1', '13', '10', '29']);
    assertEq(mixed.primary, ['13', '29'], 'skaters');
    assertEq(mixed.secondary, ['1', '10'], 'goalies');
    // A single-role league leaves one side empty, which is what suppresses the divider.
    const oneRole = splitStatIdsByRole('flb', ['5', '20']);
    assertEq(oneRole.primary, ['5', '20'], 'all batting');
    assertEq(oneRole.secondary, [], 'no pitching group, so no divider');
});

// Category lines read "<mark> <name>: <mine> vs <theirs>", so anchor on the space before the name - a bare includes('R:') would also match the HR line.
const catLineIndex = (lines, name) => lines.findIndex(l => new RegExp(`\\s${name}:`).test(l));

test('buildTeamMatchupText: categories are role-grouped, with a blank-line divider between groups', () => {
    // The fixture scores HR(5) and R(20) (batting) plus ERA(47) (pitching), interleaved in the league's own order as 5, 47, 20. Grouped, that must come out HR, R, then ERA.
    setupTeamMatchupLeague();
    const lines = buildTeamMatchupText(buildTeamMatchupRecapModel(1, 8)).split('\n');
    const hr = catLineIndex(lines, 'HR'), r = catLineIndex(lines, 'R'), era = catLineIndex(lines, 'ERA');
    assert(hr > 0 && r > 0 && era > 0, `all three category lines present (HR ${hr}, R ${r}, ERA ${era})`);
    assert(hr < r && r < era, `batting cats precede the pitching cat (HR ${hr}, R ${r}, ERA ${era})`);
    assertEq(lines[era - 1], '', 'blank line divides the pitching group from the batting group');
});

test('buildTeamMatchupText: a single-role league gets no divider (unchanged output)', () => {
    setupTeamMatchupLeague();
    AppState.scoredStatIds = new Set(['5', '20']); // batting only - no pitching group at all
    const lines = buildTeamMatchupText(buildTeamMatchupRecapModel(1, 8)).split('\n');
    const hr = catLineIndex(lines, 'HR'), r = catLineIndex(lines, 'R');
    assert(hr > 0 && r === hr + 1, `the two batting cats stay adjacent, no divider inserted (HR ${hr}, R ${r})`);
});

// ==== Windowed roto aggregation: the shared range aggregation that re-scores a roto window over ONLY that window's accumulated started-day components. The one thing that must hold for a window to be honest is the rate ground rule - a rate category is reproduced from summed COMPONENTS over the window, never from averaging each day/week's already-computed rate. These hand-computed cases pin that down directly; the end-to-end identity (a full-season window reproducing ESPN's official per-category finals) is validated in-browser on the FGB fixture. ====

function assertClose(actual, expected, msg) {
    if (Math.abs(actual - expected) > 1e-9) throw new Error(`${msg}: got ${actual}, expected ${expected}`);
}

test('aggregateStatsForWeekRange: a rate category is derived from SUMMED components, not averaged rates (fhl SV%)', () => {
    // Two weeks of a goalie's work. SV%(11) = SV(6) / SA(3). Week 1 is a perfect 27/27 (1.000); week 2 is a rough 10/40 (0.250). Averaging the two weekly rates gives 0.625 - wrong, it weights the 27-shot week the same as the 40-shot one. The right answer sums components first: (27+10)/(27+40) = 37/67 = 0.552..., exactly how ESPN's season valuesByStat is computed.
    const weeklySums = {
        1: { sums: { '6': 27, '3': 27, '13': 3 }, games: 1 }, // 13 = goals, a counting stat, summed
        2: { sums: { '6': 10, '3': 40, '13': 2 }, games: 1 }
    };
    const full = aggregateStatsForWeekRange(weeklySums, 1, 2, 'fhl');
    assertClose(full['11'], 37 / 67, 'SV% over the window is summed-SV / summed-SA, not the mean of weekly rates');
    assert(Math.abs(full['11'] - 0.625) > 1e-6, 'and it is NOT the averaged-daily-rate value');
    assertEq(full['13'], 5, 'a counting stat (goals) is summed across the window');
});

test('aggregateStatsForWeekRange: narrowing the window changes the derived rate to that window only', () => {
    // The same two weeks, but a window of only week 2 must report week 2's own rate (10/40 = 0.25), proving the range bounds actually gate which components feed the derivation.
    const weeklySums = {
        1: { sums: { '6': 27, '3': 27 }, games: 1 },
        2: { sums: { '6': 10, '3': 40 }, games: 1 }
    };
    assertClose(aggregateStatsForWeekRange(weeklySums, 2, 2, 'fhl')['11'], 0.25, 'window [2,2] sees only week 2');
    assertClose(aggregateStatsForWeekRange(weeklySums, 1, 1, 'fhl')['11'], 1.0, 'window [1,1] sees only week 1');
});

// ==== My Team: roster grouping and payload rosters ====

// Baseball slot ids, VALIDATED against real captures. 16 is bench and 17 is IL for flb, which is what makes a scratch read differently from an injury.
const FLB_COUNTS = { 0: 1, 1: 1, 2: 1, 4: 1, 16: 3, 17: 2 };

test('buildRosterGroups splits starters, bench and IR by the league own slot counts', () => {
    const entries = [
        { playerId: 1, lineupSlotId: 0 }, { playerId: 2, lineupSlotId: 2 },
        { playerId: 3, lineupSlotId: 16 }, { playerId: 4, lineupSlotId: 16 },
        { playerId: 5, lineupSlotId: 17 }
    ];
    const g = buildRosterGroups(entries, 'flb', FLB_COUNTS);
    assertEq(g.starters.map(r => r.playerId), [1, 2], 'starters');
    assertEq(g.bench.map(r => r.playerId), [3, 4], 'bench');
    assertEq(g.injured.map(r => r.playerId), [5], 'injured');
    assertEq(g.orphans, [], 'orphans');
});

test('buildRosterGroups keeps a player in a slot the league does not roster', () => {
    // An unfamiliar roster construction must degrade to a sane list, never drop a player.
    const g = buildRosterGroups([{ playerId: 9, lineupSlotId: 99 }], 'flb', FLB_COUNTS);
    assertEq(g.orphans.map(r => r.playerId), [9], 'orphan kept');
    assertEq(g.starters.length + g.bench.length + g.injured.length, 0, 'placed nowhere else');
});

test('buildRosterGroups tolerates an empty roster', () => {
    const g = buildRosterGroups([], 'flb', FLB_COUNTS);
    assertEq([g.starters.length, g.bench.length, g.injured.length, g.orphans.length], [0, 0, 0, 0], 'all empty');
});

test('rostersFromPayload reads both sides of a live matchup', () => {
    const payload = { schedule: [{
        home: { teamId: 1, rosterForCurrentScoringPeriod: { entries: [{ playerId: 10, lineupSlotId: 0 }] } },
        away: { teamId: 2, rosterForCurrentScoringPeriod: { entries: [{ playerId: 20, lineupSlotId: 16 }] } }
    }] };
    const map = rostersFromPayload(payload);
    assertEq(map.get(1), [{ playerId: 10, lineupSlotId: 0 }], 'home side');
    assertEq(map.get(2), [{ playerId: 20, lineupSlotId: 16 }], 'away side');
});

test('rostersFromPayload returns an empty map for a finished season', () => {
    // Completed seasons carry no rosterForCurrentScoringPeriod, which is the signal to go fetch the final period instead of showing an empty roster.
    const map = rostersFromPayload({ schedule: [{ home: { teamId: 1 }, away: { teamId: 2, rosterForCurrentScoringPeriod: { entries: [] } } }] });
    assertEq(map.size, 0, 'nothing to show');
    assertEq(rostersFromPayload(null).size, 0, 'no payload at all');
});

test('findOwnedTeamId matches a SWID through the brace and case forms', () => {
    const teams = [{ id: 1, owners: ['{AAAA-BBBB}'] }, { id: 2, primaryOwner: 'cccc-dddd' }];
    assertEq(findOwnedTeamId(teams, 'aaaa-bbbb'), 1, 'owners array, unbraced lowercase');
    assertEq(findOwnedTeamId(teams, '{CCCC-DDDD}'), 2, 'primaryOwner, braced uppercase');
    assertEq(findOwnedTeamId(teams, '{ZZZZ}'), null, 'a league the user only spectates');
});

// ==== Scoring period to matchup, off the league's own schedule ====

// Shaped exactly like the validated 2026 MLB capture: a 12-day opening matchup, ordinary 7-day weeks, and a 14-day matchup where the All-Star break was folded in.
function scheduleFixture() {
    const days = (a, b) => { const o = {}; for (let i = a; i <= b; i++) o[String(i)] = { 0: 1 }; return o; };
    return [
        { matchupPeriodId: 1, home: { teamId: 1, pointsByScoringPeriod: days(1, 12) }, away: { teamId: 2, pointsByScoringPeriod: days(1, 12) } },
        { matchupPeriodId: 2, home: { teamId: 1, pointsByScoringPeriod: days(13, 19) }, away: { teamId: 2, pointsByScoringPeriod: days(13, 19) } },
        { matchupPeriodId: 15, home: { teamId: 1, pointsByScoringPeriod: days(104, 117) }, away: { teamId: 2, pointsByScoringPeriod: days(104, 117) } },
        { matchupPeriodId: 16, home: { teamId: 1, pointsByScoringPeriod: days(118, 124) }, away: { teamId: 2, pointsByScoringPeriod: days(118, 124) } }
    ];
}

test('buildMatchupPeriodMap reads the league own irregular matchup lengths', () => {
    const m = buildMatchupPeriodMap(scheduleFixture(), { currentMatchupPeriod: 16 });
    assertEq(m.byPeriod.get(1), 1, 'opening day');
    assertEq(m.byPeriod.get(12), 1, 'the 12-day opening matchup runs long');
    assertEq(m.byPeriod.get(13), 2, 'the next matchup starts the day after');
    assertEq(m.byPeriod.get(117), 15, 'the 14-day break matchup is one matchup');
    assertEq([m.lastPeriod, m.lastMatchup], [124, 16], 'the last day scored');
});

test('matchupOfPeriod files a day in the matchup that was actually live', () => {
    const m = buildMatchupPeriodMap(scheduleFixture(), { currentMatchupPeriod: 16 });
    // The bug this fixes. floor(124/7) is 17, but ESPN reported currentMatchupPeriod 16 that day.
    assertEq(matchupOfPeriod(m, 124), 16, 'the last day of matchup 16');
    assertEq(matchupOfPeriod(m, 104), 15, 'the first day of the break matchup');
    assertEq(matchupOfPeriod(m, 7), 1, 'mid opening week');
});

test('matchupOfPeriod puts an unscored day in the matchup ESPN reports as current', () => {
    // Morning of matchup 17, nothing scored into the schedule yet. Those days are in 17, so "this matchup" reads empty rather than borrowing the previous matchup's production.
    const m = buildMatchupPeriodMap(scheduleFixture(), { currentMatchupPeriod: 17 });
    assertEq(matchupOfPeriod(m, 125), 17, 'today');
    assertEq(matchupOfPeriod(m, 124), 16, 'yesterday still belongs to the matchup that ended');
});

test('matchupOfPeriod keeps the rest of a matchup already under way', () => {
    // The regression the first version of this had. With days 125 and 126 scored, day 127 fell into matchup 18 because it extrapolated seven days from the last SCORED day.
    const sched = scheduleFixture();
    sched.push({ matchupPeriodId: 17, home: { teamId: 1, pointsByScoringPeriod: { 125: {}, 126: {} } } });
    const m = buildMatchupPeriodMap(sched, { currentMatchupPeriod: 17 });
    assertEq(matchupOfPeriod(m, 126), 17, 'a scored day of the current matchup');
    assertEq(matchupOfPeriod(m, 127), 17, 'and the rest of it');
});

test('matchupOfPeriod falls back to a 7-day cadence with no status to read', () => {
    const m = buildMatchupPeriodMap(scheduleFixture(), null);
    assertEq(matchupOfPeriod(m, 125), 17, 'the day after the last scored one');
    assertEq(matchupOfPeriod(m, 132), 18, 'a week later');
});

test('matchupOfPeriod returns null when there is nothing to read', () => {
    // Roto plays one long matchup and carries no per-period scores, so the caller keeps its own real-week bucketing instead of being handed a confidently wrong matchup number.
    assertEq(matchupOfPeriod(buildMatchupPeriodMap([], {}), 124), null, 'empty schedule');
    assertEq(matchupOfPeriod(buildMatchupPeriodMap(null, {}), 124), null, 'no schedule at all');
    // A real roto payload: one degenerate game with a teams array, no sides, no per-period scores.
    const rotoSchedule = [{ id: 1, matchupPeriodId: 1, teams: [{ teamId: 1 }, { teamId: 2 }] }];
    assertEq(matchupOfPeriod(buildMatchupPeriodMap(rotoSchedule, { currentMatchupPeriod: 1 }), 100), null, 'season-long roto');
});

test('matchupOfPeriod gives a skipped off day the matchup it falls inside', () => {
    const sparse = [
        { matchupPeriodId: 3, home: { teamId: 1, pointsByScoringPeriod: { 20: {}, 21: {} } } },
        { matchupPeriodId: 4, home: { teamId: 1, pointsByScoringPeriod: { 27: {} } } }
    ];
    const m = buildMatchupPeriodMap(sparse, { currentMatchupPeriod: 4 });
    assertEq(matchupOfPeriod(m, 24), 3, 'a day with no games still belongs to its matchup');
});

test('getTimeframeBounds points This Matchup at the matchup being played', () => {
    // The morning of matchup 17: nothing is scored, so maxCompletedWeek is still 16. Without the live anchor "This Matchup" showed matchup 16, which is last week's production.
    assertEq(getTimeframeBounds('last1', 16, 21, 17), { start: 17, end: 17 }, 'this matchup is the live one');
    // Every other window is retrospective: four FINISHED matchups, not three plus this morning.
    assertEq(getTimeframeBounds('last4', 16, 21, 17), { start: 13, end: 16 }, 'last 4 ends at the last completed');
    assertEq(getTimeframeBounds('last8', 16, 21, 17), { start: 9, end: 16 }, 'and so does last 8');
});

test('getTimeframeBounds keeps the completed anchor once a game is scored', () => {
    // By that evening maxCompletedWeek has caught up and the two agree with no special case.
    assertEq(getTimeframeBounds('last1', 17, 21, 17), { start: 17, end: 17 }, 'they agree');
    // A finished season passes 0, and a gap wider than one matchup is a payload this cannot read.
    assertEq(getTimeframeBounds('last1', 16, 21, 0), { start: 16, end: 16 }, 'season over');
    assertEq(getTimeframeBounds('last1', 16, 21, 19), { start: 16, end: 16 }, 'too far apart to trust');
});

test('getTimeframeBounds leaves the season windows alone', () => {
    // Only the "last N" family moves. A full-season total must not gain an empty matchup, or isFullSeasonTimeframe stops recognising it and the pool needlessly re-aggregates.
    assertEq(getTimeframeBounds('all', 16, 21, 17), { start: 1, end: 16 }, 'full season');
    assertEq(getTimeframeBounds('reg', 16, 21, 17), { start: 1, end: 16 }, 'regular season');
});

test('parseTimeframe splits the two axes, and still reads the old flat values', () => {
    assertEq(parseTimeframe('reg'), { span: 'reg', window: null }, 'span only');
    assertEq(parseTimeframe('reg+last4'), { span: 'reg', window: 4 }, 'span and window');
    // A timeframe stored by a session from before this split restores as a full-season lookback rather than being dropped on the floor.
    assertEq(parseTimeframe('last8'), { span: 'all', window: 8 }, 'legacy flat value');
    assertEq(parseTimeframe(null), { span: 'all', window: null }, 'nothing stored');
});

test('getTimeframeBounds windows INSIDE the chosen span', () => {
    // 25 matchups played, regular season is 21. The question that had no answer before: the last four matchups OF THE REGULAR SEASON, which is 18-21, not 22-25.
    assertEq(getTimeframeBounds('reg+last4', 25, 21), { start: 18, end: 21 }, 'last 4 of the regular season');
    assertEq(getTimeframeBounds('all+last4', 25, 21), { start: 22, end: 25 }, 'last 4 of the whole season');
    assertEq(getTimeframeBounds('p_all+last2', 25, 21), { start: 24, end: 25 }, 'last 2 of the playoffs');
    assertEq(getTimeframeBounds('reg', 25, 21), { start: 1, end: 21 }, 'the span alone is unchanged');
});

test('getTimeframeBounds clamps a window to its span rather than reaching past it', () => {
    // Eight matchups back from a four-matchup bracket is the bracket, not four regular-season matchups smuggled in behind it.
    assertEq(getTimeframeBounds('p_all+last8', 25, 21), { start: 22, end: 25 }, 'window wider than the span');
});

test('getTimeframeBounds keeps the live matchup out of a regular-season window', () => {
    // Morning of matchup 22, the first playoff matchup. "Current" inside the regular season must not jump forward to a matchup that is not in it.
    assertEq(getTimeframeBounds('reg+last1', 21, 21, 22), { start: 21, end: 21 }, 'regular season stays put');
    assertEq(getTimeframeBounds('all+last1', 21, 21, 22), { start: 22, end: 22 }, 'the full season follows it');
});

// Injury / availability badge ---------------------------------------------------------------------------

test('injuryLabel says nothing for a healthy player', () => {
    // The badge is interpolated unconditionally at every call site, so an empty string for a healthy player is what keeps those templates simple.
    assertEq(injuryLabel('ACTIVE'), '', 'active');
    assertEq(injuryLabel(null), '', 'null');
    assertEq(injuryLabel(undefined), '', 'undefined');
    assertEq(injuryLabel(''), '', 'empty');
    assertEq(injuryBadgeHtml('ACTIVE'), '', 'no badge markup either');
});

test('injuryLabel covers every status counted in the real captures', () => {
    // Baseball. The key still says DL because ESPN never renamed it; the label says IL because that is what MLB has called it since 2019.
    assertEq(injuryLabel('DAY_TO_DAY'), 'Day to day', 'day to day');
    assertEq(injuryLabel('SEVEN_DAY_DL'), 'On the 7-day IL', '7 day');
    assertEq(injuryLabel('TEN_DAY_DL'), 'On the 10-day IL', '10 day');
    assertEq(injuryLabel('FIFTEEN_DAY_DL'), 'On the 15-day IL', '15 day');
    assertEq(injuryLabel('SIXTY_DAY_DL'), 'On the 60-day IL', '60 day');
    // Hockey.
    assertEq(injuryLabel('OUT'), 'Out', 'out');
    assertEq(injuryLabel('INJURY_RESERVE'), 'On injured reserve', 'ir');
    assertEq(injuryLabel('SUSPENSION'), 'Suspended', 'suspension');
});

test('injuryLabel falls back to ESPN own word for a status never seen', () => {
    // A status we have not catalogued is a reason to show something, not to stay quiet about a player who cannot play. Never invent a meaning for it, just retitle the token.
    assertEq(injuryLabel('QUESTIONABLE'), 'Questionable', 'single word');
    assertEq(injuryLabel('SOME_NEW_STATUS'), 'Some new status', 'underscores become spaces');
});

test('injuryBadgeHtml tiers day to day apart from everything else', () => {
    // Day to day is the one status where the player probably still plays, so it warns in amber rather than reading as unavailable.
    const dtd = injuryBadgeHtml('DAY_TO_DAY');
    const out = injuryBadgeHtml('OUT');
    assertEq(dtd.includes('injury-minor'), true, 'day to day is minor');
    assertEq(out.includes('injury-major'), true, 'out is major');
    assertEq(injuryBadgeHtml('SOME_NEW_STATUS').includes('injury-major'), true, 'unknown is treated as major');
});

test('injuryBadgeHtml gives a suspension its own glyph', () => {
    // A suspension is not an injury, so the medical cross would be a false claim about why the player is unavailable.
    assertEq(injuryBadgeHtml('SUSPENSION').includes('✚'), false, 'no cross on a suspension');
    assertEq(injuryBadgeHtml('OUT').includes('✚'), true, 'cross on an injury');
});

test('injuryBadgeHtml escapes the label it puts in the title attribute', () => {
    // The fallback path titlecases a raw ESPN string into an attribute, so it has to escape.
    const html = injuryBadgeHtml('A"B');
    assertEq(html.includes('&quot;'), true, 'quote escaped');
    assertEq(html.includes('title="A"B"'), false, 'attribute not broken open');
});

// Player pool error text ---------------------------------------------------------------------------

test('playerPoolErrorText turns an auth refusal into an instruction', () => {
    // The status code is useless to the person reading it. What they need is the action.
    const msg = playerPoolErrorText({ authRequired: true, message: 'HTTP 405' });
    assertEq(msg.includes('Log into ESPN'), true, 'says what to do');
    assertEq(msg.includes('405'), false, 'no status code');
    assertEq(msg.includes('HTTP'), false, 'no protocol noise');
});

test('playerPoolErrorText keeps a real failure legible', () => {
    // A 500 is not a login problem, and telling the user to log in would send them off to fix something that is not broken.
    assertEq(playerPoolErrorText({ authRequired: false, message: 'HTTP 500' }),
        "Couldn't load player data: HTTP 500", 'server error');
    assertEq(playerPoolErrorText({ message: 'Failed to fetch' }),
        "Couldn't load player data: Failed to fetch", 'network error, no flag');
});

test('playerPoolErrorText survives being handed nothing', () => {
    // Every call site interpolates this into markup, so it must never render "undefined".
    assertEq(playerPoolErrorText(null), "Couldn't load player data: Unknown error", 'null');
    assertEq(playerPoolErrorText(undefined), "Couldn't load player data: Unknown error", 'undefined');
    assertEq(playerPoolErrorText({}), "Couldn't load player data: Unknown error", 'empty object');
});

// Projected pitching starts ---------------------------------------------------------------------------

const probablesSchedule = {
    settings: {
        proTeams: [
            { id: 1, abbrev: 'AAA', proGamesByScoringPeriod: {
                '10': [{ id: 900, scoringPeriodId: 10, date: 1000, homeProTeamId: 1, awayProTeamId: 2 }],
                '12': [{ id: 902, scoringPeriodId: 12, date: 2000, homeProTeamId: 2, awayProTeamId: 1 }],
                '17': [{ id: 907, scoringPeriodId: 17, date: 3000, homeProTeamId: 1, awayProTeamId: 3 }]
            } },
            { id: 2, abbrev: 'BBB', proGamesByScoringPeriod: {
                '11': [{ id: 901, scoringPeriodId: 11, date: 4000, homeProTeamId: 2, awayProTeamId: 3 }],
                '20': [{ id: 910, scoringPeriodId: 20, date: 5000, homeProTeamId: 1, awayProTeamId: 2 }]
            } },
            { id: 3, abbrev: 'CCC' }
        ]
    }
};

// Days 1-7 matchup 1, 8-14 matchup 2, 15-28 matchup 3 (a long one), current is 4 starting at 29.
const probablesMatchupMap = () => {
    const byPeriod = new Map();
    for (let p = 1; p <= 7; p++) byPeriod.set(p, 1);
    for (let p = 8; p <= 14; p++) byPeriod.set(p, 2);
    for (let p = 15; p <= 28; p++) byPeriod.set(p, 3);
    for (let p = 29; p <= 31; p++) byPeriod.set(p, 4);
    return { byPeriod, lastPeriod: 31, lastMatchup: 4, currentMatchup: 4 };
};

test('buildGamePeriodIndex flattens every team game to its day, opponent and date', () => {
    const idx = buildGamePeriodIndex(probablesSchedule);
    assertEq(idx.size, 5, 'five games');
    assertEq(idx.get('900').period, 10, 'string key');
    assertEq(idx.get('910').period, 20, 'second team');
    // The date and both team ids ride along so a start can name its day and opponent with no second lookup.
    assertEq(idx.get('900').date, 1000, 'date carried');
    assertEq([idx.get('900').home, idx.get('900').away], [1, 2], 'both sides carried');
    // A team with no schedule block must not throw or contribute.
    assertEq(idx.has('999'), false, 'unknown game absent');
    assertEq(buildGamePeriodIndex(null).size, 0, 'null response is empty');
    assertEq(buildGamePeriodIndex({}).size, 0, 'shapeless response is empty');
});

test('typicalMatchupLength takes the league own history, not a 7-day assumption', () => {
    // Two 7-day matchups and one 14-day one, so 7 is modal.
    assertEq(typicalMatchupLength(probablesMatchupMap()), 7, 'modal length');
    // A league whose matchups really are 14 days must not be forced to 7.
    const byPeriod = new Map();
    for (let p = 1; p <= 14; p++) byPeriod.set(p, 1);
    for (let p = 15; p <= 28; p++) byPeriod.set(p, 2);
    for (let p = 29; p <= 30; p++) byPeriod.set(p, 3);
    assertEq(typicalMatchupLength({ byPeriod, lastPeriod: 30, lastMatchup: 3, currentMatchup: 3 }), 14, 'fortnightly league');
    assertEq(typicalMatchupLength(null), 7, 'no map falls back to a week');
});

test('currentMatchupWindow starts on a known day and never ends before today', () => {
    const w = currentMatchupWindow(probablesMatchupMap(), 30);
    assertEq(w.matchup, 4, 'the live matchup');
    assertEq(w.start, 29, 'first day already filed under it');
    assertEq(w.end, 35, 'start plus the modal length');
    // A matchup running longer than usual keeps counting instead of collapsing behind today.
    const late = currentMatchupWindow(probablesMatchupMap(), 40);
    assertEq(late.end, 40, 'never ends before today');
});

// Shaped exactly like the live captures (DATA-SOURCES 6a). odds is an ARRAY of provider entries, the price is a STRING with its sign, and it hangs off moneyline.<side>.close.odds.
const scoreboardCapture = {
    events: [
        {
            id: '401816378',
            competitions: [{
                odds: [{
                    provider: { id: '100', name: 'DraftKings' },
                    details: 'PHI -158',
                    overUnder: 9.0,
                    spread: -1.5,
                    homeTeamOdds: { favorite: true },
                    awayTeamOdds: { favorite: false },
                    moneyline: {
                        home: { close: { odds: '-158' }, open: { odds: '-150' } },
                        away: { close: { odds: '+131' }, open: { odds: '+125' } }
                    }
                }]
            }]
        },
        // A scheduled game with no odds block at all, which is what every game beyond today looks like - the ordinary case, not an error.
        { id: '401816400', competitions: [{}] },
        // An odds entry carrying no moneyline prices is no more useful than no entry.
        { id: '401816401', competitions: [{ odds: [{ provider: { name: 'DraftKings' }, moneyline: {} }] }] }
    ]
};

test('buildOddsIndex keeps only events with a real moneyline', () => {
    const idx = buildOddsIndex(scoreboardCapture);
    assertEq(idx.size, 1, 'the no-odds and no-price events are dropped');
    const line = idx.get('401816378');
    assertEq(line.home, '-158', 'home price kept as the string ESPN sends');
    assertEq(line.away, '+131', 'away price keeps its plus sign');
    assertEq(line.provider, 'DraftKings', 'provider rides along for attribution');
    assertEq(line.homeFavored, true, 'favourite read off homeTeamOdds');
});

test('buildOddsIndex survives the empty and malformed shapes', () => {
    assertEq(buildOddsIndex({ events: [] }).size, 0, 'no games for the date');
    assertEq(buildOddsIndex(null).size, 0, 'no response at all');
    assertEq(buildOddsIndex({ events: [{ competitions: [] }] }).size, 0, 'event with no competition');
});

test('moneylineFor picks the pitcher own side, and favoured flips with it', () => {
    const idx = buildOddsIndex(scoreboardCapture);
    const home = moneylineFor(idx, '401816378', true);
    assertEq(home.price, '-158', 'home pitcher gets the home price');
    assertEq(home.favored, true, 'home is the favourite here');
    const away = moneylineFor(idx, '401816378', false);
    assertEq(away.price, '+131', 'away pitcher gets the away price');
    assertEq(away.favored, false, 'so the away side is the underdog');
    // A number-typed id must still find the string key, since the schedule and the scoreboard disagree about the type even though they agree about the value.
    assertEq(moneylineFor(idx, 401816378, true).price, '-158', 'numeric id joins too');
});

test('moneylineFor returns null rather than a placeholder when there is no line', () => {
    const idx = buildOddsIndex(scoreboardCapture);
    assertEq(moneylineFor(idx, '401816400', true), null, 'game with no odds');
    assertEq(moneylineFor(idx, '999999999', true), null, 'game not on the scoreboard at all');
    assertEq(moneylineFor(null, '401816378', true), null, 'index never built');
});

test('countProjectedStarts counts PROBABLE inside the window only', () => {
    const idx = buildGamePeriodIndex(probablesSchedule);
    // Window covers days 10-17, so game 910 on day 20 is outside it.
    const window = { matchup: 2, start: 10, end: 17 };
    const pitchers = [
        { id: 1, proTeamId: 1, starterStatusByProGame: { '900': 'PROBABLE', '902': 'PROBABLE', '910': 'PROBABLE' } },
        { id: 2, proTeamId: 1, starterStatusByProGame: { '901': 'NOTSTARTING', '907': 'PROBABLE' } },
        { id: 3, proTeamId: 1, starterStatusByProGame: {} },
        { id: 4, proTeamId: 1 }
    ];
    const out = countProjectedStarts(pitchers, idx, window, 12);
    assertEq(out.total, 3, 'two in-window for #1, one for #2');
    assertEq(out.byPlayer.get(1).starts, 2, 'day 20 excluded');
    // NOTSTARTING is ESPN saying a listed turn is being skipped, so it is not a start.
    assertEq(out.byPlayer.get(2).starts, 1, 'skipped turn not counted');
    assertEq(out.byPlayer.has(3), false, 'no games, no row');
    assertEq(out.byPlayer.has(4), false, 'no starter map, no row');
});

test('countProjectedStarts treats today as still to come', () => {
    const idx = buildGamePeriodIndex(probablesSchedule);
    const window = { matchup: 2, start: 10, end: 17 };
    const pitchers = [{ id: 1, proTeamId: 1, starterStatusByProGame: { '900': 'PROBABLE', '902': 'PROBABLE', '907': 'PROBABLE' } }];
    // Day 12 has not finished, so its start still counts as remaining.
    assertEq(countProjectedStarts(pitchers, idx, window, 12).remaining, 2, 'day 12 and day 17');
    assertEq(countProjectedStarts(pitchers, idx, window, 10).remaining, 3, 'nothing played yet');
    assertEq(countProjectedStarts(pitchers, idx, window, 18).remaining, 0, 'window over');
    assertEq(countProjectedStarts(pitchers, idx, window, 18).total, 3, 'total is unaffected');
});

test('countProjectedStarts names the day and the opponent of each start', () => {
    const idx = buildGamePeriodIndex(probablesSchedule);
    const window = { matchup: 2, start: 10, end: 17 };
    // Team 1's pitcher. Game 900 is home against 2, game 902 is away at 2, game 907 home against 3.
    const out = countProjectedStarts(
        [{ id: 1, proTeamId: 1, starterStatusByProGame: { '900': 'PROBABLE', '902': 'PROBABLE', '907': 'PROBABLE' } }],
        idx, window, 12);
    const games = out.byPlayer.get(1).games;
    assertEq(games.length, 3, 'three starts');
    // Sorted by day, because that is the order they happen in.
    assertEq(games.map(g => g.period), [10, 12, 17], 'chronological');
    assertEq(games.map(g => g.isHome), [true, false, true], 'side per game');
    assertEq(games.map(g => g.opponentId), [2, 2, 3], 'the other team, whichever side he is on');
    assertEq(games.map(g => g.played), [true, false, false], 'day 10 is behind us, day 12 is today');
    assertEq(games[0].date, 1000, 'date for the label');
    // His own club, which is what a home start's ballpark is looked up by.
    assertEq(games.map(g => g.teamId), [1, 1, 1], 'the pitcher\'s own team rides along');
});

test('buildProTeamAbbrevs maps every real team id to its abbreviation', () => {
    // This is the map ROADMAP Decision #18 recorded as missing when it ruled out team logos.
    const abbrevs = buildProTeamAbbrevs(probablesSchedule);
    assertEq(abbrevs.get(1), 'AAA', 'first team');
    assertEq(abbrevs.get(3), 'CCC', 'a team with no schedule still has a name');
    assertEq(abbrevs.size, 3, 'all three');
    assertEq(buildProTeamAbbrevs(null).size, 0, 'null response is empty');
});

test('countProjectedStarts degrades rather than throwing', () => {
    const idx = buildGamePeriodIndex(probablesSchedule);
    const window = { matchup: 2, start: 10, end: 17 };
    assertEq(countProjectedStarts(null, idx, window, 10).total, 0, 'no pitchers');
    assertEq(countProjectedStarts([], new Map(), window, 10).total, 0, 'empty index');
    assertEq(countProjectedStarts([], idx, null, 10).total, 0, 'no window');
});

// numericStat: ESPN's stringified Infinity ---------------------------------------------------------------------------

test('numericStat turns ESPN stringified Infinity into a real number', () => {
    // JSON cannot write an infinite number, so ESPN sends the string. A team with earned runs and no innings yet genuinely has an infinite ERA, so the value is kept rather than discarded.
    assertEq(numericStat('Infinity'), Infinity, 'positive');
    assertEq(numericStat('-Infinity'), -Infinity, 'negative');
    assertEq(Number.isFinite(numericStat('Infinity')), false, 'still infinite, not clamped');
});

test('numericStat coerces the ordinary shapes without changing them', () => {
    assertEq(numericStat(5), 5, 'a number passes through');
    assertEq(numericStat('5'), 5, 'a numeric string becomes a number');
    assertEq(numericStat(0), 0, 'zero survives, rather than reading as missing');
    assertEq(numericStat(0.275), 0.275, 'a rate keeps its precision');
    // The {value: X} wrapper statValue already documents.
    assertEq(numericStat({ value: 12 }), 12, 'wrapped value unwrapped then coerced');
});

test('numericStat reports absence as null rather than NaN', () => {
    // NaN poisons arithmetic silently; null already means "no value" everywhere in this app.
    assertEq(numericStat(null), null, 'null');
    assertEq(numericStat(undefined), null, 'undefined');
    assertEq(numericStat(''), null, 'empty string');
    assertEq(numericStat('not a number'), null, 'junk');
});


// ==== Baseball pitching rates rebuild from components ==== The bug these pin. A pitcher who threw one bad start inside a window read a far gentler rate, because an unlisted rate fell back to averaging each day's own already-computed value.

test('aggregateStatsForWeekRange: ERA over a window comes from ER and outs, not an average of days', () => {
    AppState.sport = 'flb';
    // Week 1: 5 ER in 3 innings, a 15.00 day. Week 2: nothing thrown.
    const weeklySums = {
        1: { sums: { '45': 5, '34': 9, '48': 4, '53': 1 }, games: 1 },
        2: { sums: {}, games: 0 }
    };
    const one = aggregateStatsForWeekRange(weeklySums, 1, 1, 'flb');
    assertClose(one['47'], 15, 'one start, 5 ER in 3 IP, is a 15.00 ERA');
    const both = aggregateStatsForWeekRange(weeklySums, 1, 2, 'flb');
    assertClose(both['47'], 15, 'an empty second week cannot dilute it to 7.5 or 5');
    assertEq(both['48'], 4, 'counting stats still sum');
    assertEq(both['53'], 1, 'and so do wins');
});

test('aggregateStatsForWeekRange: ERA across two real starts weights by innings, not by day', () => {
    AppState.sport = 'flb';
    // 5 ER in 3 IP (15.00) then 1 ER in 9 IP (1.00). Averaging the two days gives 8.00. The true combined line is 6 ER in 12 IP, which is 4.50.
    const weeklySums = {
        1: { sums: { '45': 5, '34': 9 }, games: 1 },
        2: { sums: { '45': 1, '34': 27 }, games: 1 }
    };
    const out = aggregateStatsForWeekRange(weeklySums, 1, 2, 'flb');
    assertClose(out['47'], 4.5, '6 earned runs over 12 innings is 4.50, not the 8.00 a day average gives');
});

test('aggregateStatsForWeekRange: WHIP and K/9 rebuild from their own components too', () => {
    AppState.sport = 'flb';
    // 12 outs is 4 innings. 3 hits + 1 walk = 4 baserunners -> WHIP 1.00. 6 K -> K/9 13.50.
    const weeklySums = { 1: { sums: { '37': 3, '39': 1, '48': 6, '34': 12 }, games: 1 } };
    const out = aggregateStatsForWeekRange(weeklySums, 1, 1, 'flb');
    assertClose(out['41'], 1, '4 baserunners over 4 innings is a WHIP of 1.00');
    assertClose(out['49'], 13.5, '6 strikeouts over 4 innings is 13.50 per nine');
});

test('aggregateStatsForWeekRange: no innings means no rate at all, rather than a divide by zero', () => {
    AppState.sport = 'flb';
    const out = aggregateStatsForWeekRange({ 1: { sums: { '45': 0, '34': 0 }, games: 0 } }, 1, 1, 'flb');
    assertEq(out['47'], undefined, 'a pitcher who has not thrown has no ERA');
    assertEq(out['41'], undefined, 'and no WHIP');
});

// ==== Matchup difficulty ====

// ==== The Current timeframe's Day axis ==== A one-matchup window on a matchup axis is one point. These pin the day-by-day series that replaces it: cumulative through each day, rates rebuilt from cumulative components, and an off-day drawing a flat segment rather than a gap or a drop.

test('aggregateDailyCumulative: counting stats accumulate, and an off-day holds the line flat', () => {
    AppState.sport = 'flb';
    const daily = {
        101: { sums: { '5': 2, '20': 1 }, games: 1 },   // 2 runs, 1 HR
        // 102 is an off-day: no entry at all
        103: { sums: { '5': 1, '20': 0 }, games: 1 },   // 1 more run
        104: { sums: { '5': 3, '20': 2 }, games: 1 }
    };
    const s = aggregateDailyCumulative(daily, [101, 102, 103, 104], 'flb');
    assertEq(s.map(d => d.totals['5']), [2, 2, 3, 6], 'runs are the running total, flat across the off-day');
    assertEq(s.map(d => d.totals['20']), [1, 1, 1, 3], 'home runs likewise');
    assertEq(s.map(d => d.played), [true, false, true, true], 'the off-day is marked, not dropped');
    assertEq(s.map(d => d.games), [1, 1, 2, 3], 'games played is cumulative too');
});

test('aggregateDailyCumulative: a day the player did nothing still gets a point', () => {
    AppState.sport = 'flb';
    const s = aggregateDailyCumulative({ 7: { sums: { '5': 4 }, games: 1 } }, [5, 6, 7], 'flb');
    assertEq(s.length, 3, 'every period in the matchup is a point on the axis');
    assertEq(s.map(d => d.totals['5'] || 0), [0, 0, 4], 'the line sits at zero until he plays');
    assertEq(s[0].index, 0, 'index is the position on the day axis');
    assertEq(s[2].period, 7, 'period is the real scoring period behind it');
});

test('aggregateDailyCumulative: a rate is rebuilt from CUMULATIVE components each day', () => {
    AppState.sport = 'flb';
    // Day 1: 5 earned runs in 3 innings (9 outs) is a 15.00 ERA. Day 2: nothing thrown, so the line must HOLD at 15.00, not decay. Day 3: 1 earned run in 9 innings (27 outs). Combined: 6 ER over 12 IP = 4.50.
    const daily = {
        1: { sums: { '45': 5, '34': 9 }, games: 1 },
        3: { sums: { '45': 1, '34': 27 }, games: 1 }
    };
    const s = aggregateDailyCumulative(daily, [1, 2, 3], 'flb');
    assertClose(s[0].totals['47'], 15, 'day one is 5 earned runs over 3 innings');
    assertClose(s[1].totals['47'], 15, 'an idle day holds the rate rather than moving it');
    assertClose(s[2].totals['47'], 4.5, '6 earned runs over 12 innings is 4.50, not the 8.00 an average of days gives');
});

test('aggregateDailyCumulative: no innings yet means no rate at all', () => {
    AppState.sport = 'flb';
    const s = aggregateDailyCumulative({ 2: { sums: { '48': 3 }, games: 1 } }, [1, 2], 'flb');
    assertEq(s[0].totals['47'], undefined, 'before he throws there is no ERA to show');
    assertEq(s[1].totals['48'], 3, 'the counting stat is still there');
});

test('periodsOfMatchup: the matchup owns whatever days its own schedule filed under it', () => {
    const byPeriod = new Map();
    // Matchup 1 opens mid-week, matchup 2 is ordinary, matchup 3 runs long across a break.
    [1, 2, 3].forEach(p => byPeriod.set(p, 1));
    [4, 5, 6, 7, 8, 9, 10].forEach(p => byPeriod.set(p, 2));
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].forEach(p => byPeriod.set(p, 3));
    const map = { byPeriod };
    assertEq(periodsOfMatchup(map, 1), [1, 2, 3], 'a short opening matchup is three days, not seven');
    assertEq(periodsOfMatchup(map, 2), [4, 5, 6, 7, 8, 9, 10], 'an ordinary one is its own seven');
    assertEq(periodsOfMatchup(map, 3).length, 11, 'a long playoff matchup is eleven, never a calendar guess');
    assertEq(periodsOfMatchup(map, 99), [], 'a matchup with no days filed under it has none');
    assertEq(periodsOfMatchup(null, 1), [], 'no map is no days rather than a throw');
});


// Four teams, so a percentile lands on a value that can be checked by hand. With four teams the ranks are 12.5, 37.5, 62.5 and 87.5 (below, plus half the ties, over the count).
const difficultyHitters = () => ([
    { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 100, HR: 40 } },
    { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 100, HR: 40 } },
    { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 60, HR: 20 } },
    { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 60, HR: 20 } },
    { proTeamId: 3, injuryStatus: 'ACTIVE', totals: { R: 30, HR: 10 } },
    { proTeamId: 3, injuryStatus: 'ACTIVE', totals: { R: 30, HR: 10 } },
    { proTeamId: 4, injuryStatus: 'ACTIVE', totals: { R: 10, HR: 2 } },
    { proTeamId: 4, injuryStatus: 'ACTIVE', totals: { R: 10, HR: 2 } }
]);

test('isSidelined: the long absences remove a bat, day to day does not', () => {
    assertEq(isSidelined('OUT'), true, 'OUT is sidelined');
    assertEq(isSidelined('SIXTY_DAY_DL'), true, 'the 60-day IL is sidelined');
    assertEq(isSidelined('INJURY_RESERVE'), true, 'hockey IR is sidelined');
    assertEq(isSidelined('DAY_TO_DAY'), false, 'day to day still plays most days');
    assertEq(isSidelined('ACTIVE'), false, 'active plays');
    assertEq(isSidelined(undefined), false, 'a missing status is not an absence');
});

test('teamOffence: sums healthy bats per team and drops the sidelined ones', () => {
    const byTeam = teamOffence(difficultyHitters(), ['R', 'HR']);
    assertEq(byTeam.get(1).totals.R, 200, 'team 1 runs are both bats summed');
    assertEq(byTeam.get(1).bats, 2, 'team 1 counted two bats');
    assertEq(byTeam.get(4).totals.HR, 4, 'team 4 home runs are both bats summed');
});

test('teamOffence: an injured bat is excluded, which IS the injury adjustment', () => {
    const hitters = difficultyHitters();
    hitters[0].injuryStatus = 'SIXTY_DAY_DL';
    const byTeam = teamOffence(hitters, ['R', 'HR']);
    assertEq(byTeam.get(1).totals.R, 100, 'the injured bat is gone from the total');
    assertEq(byTeam.get(1).bats, 1, 'and from the bat count');
});

test('offenceBreakdown: the composite taken apart, per category, over the same basis', () => {
    const byTeam = teamOffence(difficultyHitters(), ['R', 'HR']);
    const d = offenceBreakdown(byTeam, ['R', 'HR'], 2);
    assertEq(d.proTeamId, 2, 'the lineup asked for');
    assertEq(d.bats, 2, 'and the healthy bats behind it');
    assertEq(d.rows.map(r => r.id), ['R', 'HR'], 'a row per scored category, in the pool order');
    // Team 2 posts 120 runs against [200, 120, 60, 20]: one team beats it, two are below, so the percentile is 62.5 and the rank is 2 of 4. The same arithmetic offenceStrength does.
    assertEq(d.rows[0].value, 120, 'its own summed value');
    assertEq(d.rows[0].pct, 62.5, 'the percentile the composite counted');
    assertEq(d.rows[0].rank, 2, 'second of the four lineups');
    assertEq(d.rows[0].of, 4, 'against a basis of four');
    assertEq(d.rows[1].pct, 62.5, 'home runs land in the same place for this lineup');
});

test('offenceStrength IS the average of the rows, on every pool (B151)', () => {
    // The whole method, and the property the panel depends on: the total under the table is the mean of the column above it. There is no second pass to explain any more.
    const ids = ['R', 'HR'];
    const evenly = teamOffence(difficultyHitters(), ids);
    [1, 2, 3, 4].forEach(teamId => {
        const d = offenceBreakdown(evenly, ids, teamId);
        const mean = d.rows.reduce((a, r) => a + r.pct, 0) / d.rows.length;
        assertEq(d.average, mean, `team ${teamId} reports the mean of its own rows`);
        assertEq(offenceStrength(evenly, ids).get(teamId), mean, `team ${teamId} scores that mean`);
    });

    // And on a pool where the categories DISAGREE, which is where the old second pass used to move the number away from the column. Runs rank 1 > 2 > 3 > 4, home runs rank 3 > 4 > 2 > 1.
    const crossed = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 100, HR: 1 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 80, HR: 2 } },
        { proTeamId: 3, injuryStatus: 'ACTIVE', totals: { R: 60, HR: 4 } },
        { proTeamId: 4, injuryStatus: 'ACTIVE', totals: { R: 40, HR: 3 } }
    ];
    const byTeam = teamOffence(crossed, ids);
    const strength = offenceStrength(byTeam, ids);
    const t3 = offenceBreakdown(byTeam, ids, 3);
    assertEq(t3.rows.map(r => r.pct), [37.5, 87.5], 'third in one category, first in the other');
    assertEq(t3.average, 62.5, 'which averages to 62.5');
    // This is the case that used to read 87.5, twenty-five points above its own column.
    assertEq(strength.get(3), 62.5, 'and the score is that average, not a re-ranking of it');
    assertEq(offenceBreakdown(byTeam, ids, 4).average, offenceStrength(byTeam, ids).get(4),
        'team 4 too, which used to be moved the other way');
});

test('offenceBreakdown: ties share a rank, and an unknown lineup has no breakdown', () => {
    const tied = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 50 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 50 } },
        { proTeamId: 3, injuryStatus: 'ACTIVE', totals: { R: 10 } }
    ];
    const byTeam = teamOffence(tied, ['R']);
    assertEq(offenceBreakdown(byTeam, ['R'], 1).rows[0].rank, 1, 'nobody is above the tied leaders');
    assertEq(offenceBreakdown(byTeam, ['R'], 2).rows[0].rank, 1, 'so both of them rank first');
    assertEq(offenceBreakdown(byTeam, ['R'], 3).rows[0].rank, 3, 'and the third is third, not second');
    assertEq(offenceBreakdown(byTeam, ['R'], 99), null, 'a team with no bats has nothing to show');
});

// One counting category and one lower-is-better category, four lineups, so both directions can be checked by hand against the same four values. E runs the opposite way to R by design.
const inverseHitters = () => ([
    { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 100, E: 10 } },
    { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 60, E: 20 } },
    { proTeamId: 3, injuryStatus: 'ACTIVE', totals: { R: 30, E: 30 } },
    { proTeamId: 4, injuryStatus: 'ACTIVE', totals: { R: 10, E: 40 } }
]);

test('offenceStrength: a lower-is-better category is ranked the other way (B144)', () => {
    const byTeam = teamOffence(inverseHitters(), ['R', 'E']);
    const ids = ['R', 'E'];
    // BEFORE, and it is worse than a misordering. With no inverse set both categories read more-is-stronger, so team 1 scores 87.5 on runs and 12.5 on its ten errors while team 4 scores 12.5 and 87.5. Every lineup averages to exactly 50, the second pass ties them all, and the four offences - one scoring ten times the runs of another - come out INDISTINGUISHABLE. The bug does not just rank a clean lineup low, it can cancel the signal outright.
    const before = offenceStrength(byTeam, ids);
    assertEq([1, 2, 3, 4].map(i => before.get(i)), [50, 50, 50, 50],
        'without the rule the errors column cancels the runs column and nothing is distinguishable');

    // AFTER. Errors mirrored: team 1's 10 now scores 87.5 and team 4's 40 scores 12.5. Every category agrees, so the averages are 87.5 / 62.5 / 37.5 / 12.5 and the second pass leaves them at the ends of the scale where they belong.
    const after = offenceStrength(byTeam, ids, { inverseStatIds: new Set(['E']) });
    assertEq(after.get(1), 87.5, 'the best offence tops the scale once errors count against');
    assertEq(after.get(2), 62.5, 'second is second');
    assertEq(after.get(3), 37.5, 'third is third');
    assertEq(after.get(4), 12.5, 'and the worst is the worst');
});

test('offenceBreakdown: an inverse row percentiles and RANKS the other way (B144)', () => {
    const byTeam = teamOffence(inverseHitters(), ['R', 'E']);
    const ctx = { inverseStatIds: new Set(['E']) };
    const cleanest = offenceBreakdown(byTeam, ['R', 'E'], 1, ctx);
    assertEq(cleanest.rows[1].id, 'E', 'the errors row');
    assertEq(cleanest.rows[1].value, 10, 'ten of them');
    assertEq(cleanest.rows[1].pct, 87.5, 'fewest errors is the top of the scale');
    assertEq(cleanest.rows[1].rank, 1, 'and ranks first, because fewest is best here');
    assertEq(cleanest.rows[1].inverse, true, 'flagged, so the table can mark it');
    const messiest = offenceBreakdown(byTeam, ['R', 'E'], 4, ctx);
    assertEq(messiest.rows[1].pct, 12.5, 'most errors is the bottom');
    assertEq(messiest.rows[1].rank, 4, 'and ranks last of the four');
    // Without the rule the same row reads exactly backwards, which is what shipped.
    const uncorrected = offenceBreakdown(byTeam, ['R', 'E'], 4);
    assertEq(uncorrected.rows[1].rank, 1, 'unflagged, the messiest lineup ranked FIRST in errors');
    assertEq(uncorrected.rows[1].inverse, false, 'and carried no marker to say so');
});

test('startDifficulty: the inverse rule reaches the score a start is given (B144)', () => {
    const ids = ['R', 'E'];
    const byTeam = teamOffence(inverseHitters(), ids);
    const start = { teamId: 9, opponentId: 4, isHome: false };
    // Facing the WEAKEST offence in the pool. Uncorrected the errors cancelled the runs and every lineup scored 50, so this start rated dead average; corrected it rates 12.5, which is what facing the worst lineup in the league should read as.
    assertEq(startDifficulty(start, offenceStrength(byTeam, ids), new Map()).score, 50,
        'the score this shipped with, the same one every other lineup got');
    assertEq(startDifficulty(start, offenceStrength(byTeam, ids, { inverseStatIds: new Set(['E']) }), new Map()).score, 12.5,
        'and the score it should have been');
});

// AVG = H/AB, and OPS = OBP + SLG so the `add` path is covered too. Ids match RATE_COMPONENTS.flb (0 = AB, 1 = H, 8 = TB, 2 = AVG, 9 = SLG, 17 = OBP, 18 = OPS), and only the components are on the players - a rate is never an input here, which is the whole point.
const RATE_SPECS = [
    { out: '2', num: ['1'], den: ['0'] },
    { out: '9', num: ['8'], den: ['0'] },
    { out: '17', num: ['1'], den: ['0'] },
    { out: '18', add: ['17', '9'] }
];
const rateCtx = { rateSpecs: RATE_SPECS, rateStatIds: new Set(['2', '9', '17', '18']) };

test('teamOffence: a lineup rate is derived from components, never summed (B145)', () => {
    const bats = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 30, '2': 0.300 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 20, '2': 0.200 } }
    ];
    // Summed, the way this shipped, team 1's batting average is.300 +.200 =.500.
    assertEq(teamOffence(bats, ['2']).get(1).totals['2'], 0.5, 'summing two rates gives a .500 lineup');
    // Derived, it is 50 hits in 200 at-bats.
    const derived = teamOffence(bats, ['2'], rateCtx).get(1);
    assertEq(derived.totals['2'], 0.25, 'derived from components it is .250, which is a batting average');
    assertEq(derived.totals['1'], 50, 'the components are summed and kept');
    assertEq(derived.totals['0'], 200, 'both of them');
});

test('teamOffence: the `add` path derives OPS from the ratios below it (B145)', () => {
    const bats = [{ proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 30, '8': 50 } }];
    // OBP 30/100 =.300 and SLG 50/100 =.500, so OPS is.800 - and 17 and 9 are derived even though only 18 is scored, because the add entry references them.
    const t = teamOffence(bats, ['18'], rateCtx).get(1);
    assertEq(t.totals['18'], 0.8, 'OPS is the two ratios summed, not sixteen players OPS added up');
    assertEq(t.totals['17'], 0.3, 'the OBP it was built from');
    assertEq(t.totals['9'], 0.5, 'and the SLG');
});

test('teamOffence: summing a rate ranks the DEEPER lineup ahead of the better one (B145)', () => {
    // Three ordinary bats against two good ones. Every A hitter is a.300 hitter, every B hitter a.400 hitter, so B is plainly the better lineup at getting on base.
    const bats = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 30, '2': 0.300 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 30, '2': 0.300 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 30, '2': 0.300 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 40, '2': 0.400 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { '0': 100, '1': 40, '2': 0.400 } }
    ];
    // BEFORE..900 against.800 - the worse lineup wins the category on roster depth alone, and the composite hands the pitcher facing it the harder read.
    const summed = teamOffence(bats, ['2']);
    // Compared rather than pinned: three.300s sum to 0.8999999999999999 and the exact trailing digits are float noise, while the ORDER is the defect.
    assert(summed.get(1).totals['2'] > summed.get(2).totals['2'],
        'three .300 hitters sum past two .400 hitters');
    assertEq(offenceStrength(summed, ['2']).get(1), 75, 'so the weaker offence takes the top of the scale');
    assertEq(offenceStrength(summed, ['2']).get(2), 25, 'and the stronger one the bottom');
    // AFTER..300 against.400, and the order is the right way round however many bats each carries.
    const derived = teamOffence(bats, ['2'], rateCtx);
    assertEq(derived.get(1).totals['2'], 0.3, 'ninety hits in three hundred at-bats');
    assertEq(derived.get(2).totals['2'], 0.4, 'eighty in two hundred');
    assertEq(offenceStrength(derived, ['2']).get(2), 75, 'the better lineup is now the stronger one');
    assertEq(offenceStrength(derived, ['2']).get(1), 25, 'and depth stops paying');
});

test('teamOffence: a scored rate with no derivation is excluded, not summed (B145)', () => {
    const bats = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { R: 40, '55': 0.6 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { R: 20, '55': 0.4 } }
    ];
    // 55 is a rate this league scores and RATE_SPECS has no recipe for. Shipping a summed 1.0 would be exactly the defect this entry is about, so the category is dropped instead.
    const ctx = { rateSpecs: RATE_SPECS, rateStatIds: new Set(['2', '55']) };
    const byTeam = teamOffence(bats, ['R', '55'], ctx);
    assertEq(byTeam.get(1).totals['55'], undefined, 'the unmeasurable rate carries no value at all');
    assertEq(byTeam.get(1).totals.R, 40, 'while the counting category is untouched');
    const d = offenceBreakdown(byTeam, ['R', '55'], 1, ctx);
    assertEq(d.rows.map(r => r.id), ['R'], 'it contributes no row');
    assertEq(d.excluded, ['55'], 'and the drill-in is told which category went missing');
});

// A deep club of ordinary bats against a thin club of good ones. Every team-1 hitter plays 20 games and scores 10 runs; every team-2 hitter plays 150 and scores 40. Lineup size 3 here, so the arithmetic stays checkable - the shipped sizes are 9 and 18.
const depthBats = () => {
    const bats = [];
    for (let i = 0; i < 6; i++) bats.push({ proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 20, R: 10 } });
    for (let i = 0; i < 3; i++) bats.push({ proTeamId: 2, injuryStatus: 'ACTIVE', totals: { GP: 150, R: 40 } });
    return bats;
};
const lineupCtx = { lineupSize: 3, playingTimeOf: h => h.totals.GP };

test('teamOffence: a club brings a LINEUP, so depth stops being offence (B147)', () => {
    // BEFORE. Six part-timers total 60 runs against three regulars' 120... the thin club still wins this one, so make the depth decisive: twelve bats would total 120 and tie, and more would win.
    const before = teamOffence(depthBats(), ['R']);
    assertEq(before.get(1).totals.R, 60, 'six ordinary bats, every one of them counted');
    assertEq(before.get(1).bats, 6, 'and the roster is the bat count');
    // AFTER. Three each, chosen by playing time, so the comparison is lineup against lineup.
    const after = teamOffence(depthBats(), ['R'], lineupCtx);
    assertEq(after.get(1).totals.R, 30, 'only the three most-played of the deep club count');
    assertEq(after.get(1).bats, 3, 'a lineup, not a roster');
    assertEq(after.get(1).rostered, 6, 'with the roster size kept for the panel to report');
    assertEq(after.get(2).totals.R, 120, 'the thin club is untouched, it was already a lineup');
    assertEq(after.get(2).bats, 3, 'three either way');
});

test('teamOffence: the lineup is picked by playing time, not by production (B147)', () => {
    // The question is who is in the game. Picking the best hitters and then measuring how good they are would answer itself, so the bench slugger stays out and the everyday singles hitter is in.
    const bats = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 150, R: 10 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 140, R: 9 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 4, R: 99 } }
    ];
    const t = teamOffence(bats, ['R'], { lineupSize: 2, playingTimeOf: h => h.totals.GP }).get(1);
    assertEq(t.totals.R, 19, 'the two who play, not the one who happens to have the runs');
    assertEq(t.bats, 2, 'two of the three');
});

test('teamOffence: an injured regular is out before the lineup is picked (B147)', () => {
    const bats = [
        { proTeamId: 1, injuryStatus: 'SIXTY_DAY_DL', totals: { GP: 150, R: 90 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 100, R: 40 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 90, R: 30 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 10, R: 5 } }
    ];
    // The 60-day case is the most-played bat on the club and must not take a lineup spot, so the spot falls to the next healthy one down.
    const t = teamOffence(bats, ['R'], { lineupSize: 2, playingTimeOf: h => h.totals.GP }).get(1);
    assertEq(t.totals.R, 70, 'the two healthiest-and-most-played, with the injured leader gone');
    assertEq(t.rostered, 3, 'and the roster count is the healthy three, not four');
});

test('teamOffence: preseason keeps every bat rather than picking an arbitrary nine (B147)', () => {
    const bats = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 0, R: 0 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 0, R: 0 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { GP: 0, R: 0 } }
    ];
    // With nobody having played, "most played" is three arbitrary names. Same guard the rank engine uses for a pool where nobody has a game yet.
    const t = teamOffence(bats, ['R'], { lineupSize: 2, playingTimeOf: h => h.totals.GP }).get(1);
    assertEq(t.bats, 3, 'every bat counts until somebody has played');
});

// The general-offence basket fixed the difficulty on: R(20) and HR(5) as the production, OBP(17) and SLG(9) as how often they get on and how far they go. The rate specs are the real ones from RATE_COMPONENTS.flb, components and all, so this exercises the same path production does.
const BASKET = ['20', '5', '17', '9'];
const basketCtx = {
    rateStatIds: new Set(['17', '9']),
    rateSpecs: [
        { out: '9', num: ['8'], den: ['0'] },
        { out: '17', num: ['1', '10', '12'], den: ['0', '10', '12', '13'] }
    ]
};
// Two bats each, and every component the real OBP spec asks for, so nothing derives to null.
const basketBat = (team, ab, h, tb, r, hr) =>
    ({ proTeamId: team, injuryStatus: 'ACTIVE',
       totals: { '0': ab, '1': h, '8': tb, '10': 0, '12': 0, '13': 0, '20': r, '5': hr } });
const basketHitters = () => ([
    basketBat(1, 100, 30, 50, 50, 10), basketBat(1, 100, 30, 50, 50, 10),
    basketBat(2, 100, 25, 40, 40, 8), basketBat(2, 100, 25, 40, 40, 8),
    basketBat(3, 100, 20, 30, 30, 6), basketBat(3, 100, 20, 30, 30, 6),
    basketBat(4, 100, 15, 20, 20, 4), basketBat(4, 100, 15, 20, 20, 4)
]);

test('the general basket: R and HR summed, OBP and SLG derived (B149)', () => {
    const t1 = teamOffence(basketHitters(), BASKET, basketCtx).get(1);
    assertEq(t1.totals['20'], 100, 'runs are a counting stat and add up');
    assertEq(t1.totals['5'], 20, 'so do home runs');
    // Summed, two.300 on-base bats would read.600. Derived, sixty times on in two hundred trips.
    assertEq(t1.totals['17'], 0.3, 'on-base comes from the components, not from adding rates');
    assertEq(t1.totals['9'], 0.5, 'and so does slugging');
});

test('the general basket: the four categories rank the four lineups (B149)', () => {
    const byTeam = teamOffence(basketHitters(), BASKET, basketCtx);
    const strength = offenceStrength(byTeam, BASKET, basketCtx);
    // Every basket category orders the lineups the same way here, so each contributes 87.5 / 62.5 / 37.5 / 12.5 and the averages carry straight through the second pass.
    assertEq([1, 2, 3, 4].map(t => strength.get(t)), [87.5, 62.5, 37.5, 12.5],
        'best offence to worst, on run production rather than on league trivia');
    const d = offenceBreakdown(byTeam, BASKET, 1, basketCtx);
    assertEq(d.rows.map(r => r.id), BASKET, 'and the drill-in shows the basket, in basket order');
    assertEq(d.rows.length, 4, 'four rows, whatever the league happens to score');
});

test('the general basket: league categories cannot reach the score any more (B149)', () => {
    // The fixture league scores nine batting categories, only about half of them about run production, so the ones that are not carried nearly half the weight. Modelled here as four extra categories the WEAKEST offence happens to lead - fielding assists and the like, which say nothing about facing a lineup.
    const bats = basketHitters().map(b => ({
        ...b, totals: { ...b.totals, L1: b.proTeamId * 10, L2: b.proTeamId * 10, L3: b.proTeamId * 10, L4: b.proTeamId * 10 }
    }));
    // BASKET ONLY, which is what ships now. Run production separates the four cleanly.
    const withBasket = offenceStrength(teamOffence(bats, BASKET, basketCtx), BASKET, basketCtx);
    assertEq([1, 2, 3, 4].map(t => withBasket.get(t)), [87.5, 62.5, 37.5, 12.5],
        'the basket ranks them on run production, and nothing else can get in');
    // The league's full list, which is what shipped. Four categories pulling the other way exactly cancel the four that matter, every lineup averages 50, and the ranking collapses - the same cancellation found, arriving this time through categories that were never relevant.
    const leagueIds = BASKET.concat(['L1', 'L2', 'L3', 'L4']);
    const withLeague = offenceStrength(teamOffence(bats, leagueIds, basketCtx), leagueIds, basketCtx);
    assertEq([1, 2, 3, 4].map(t => withLeague.get(t)), [50, 50, 50, 50],
        'the league list lets irrelevant categories cancel the relevant ones outright');
});

test('startDifficulty: every part names itself with a key, not just a label', () => {
    // The panel renders the three components differently, and used to tell them apart by matching the label text - so a wording change was a rendering bug waiting to happen.
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const parks = { 1: [120, 'Launch Pad'] };
    const d = startDifficulty({ teamId: 1, opponentId: 3, isHome: true }, strength, new Map(),
        { restDays: 3, parkFactors: parks });
    assertEq(d.parts.map(p => p.key), ['offence', 'park', 'rest'], 'one key per component, in order');
    assertEq(d.parts[1].venue, 'Launch Pad', 'the park part carries its venue for the subline');
    assertEq(d.parts[1].runIndex, 120, 'and its index, which the row caption prints');
    assertEq(d.parts[1].venueTeamId, 1, 'and which club park it is, so the ranking can mark it');
    assertEq(d.parts[2].restDays, 3, 'the rest part carries the days it measured');
});

test('percentileOf: ties share the midpoint rather than breaking arbitrarily', () => {
    assertEq(percentileOf(10, [10, 10, 10, 10]), 50, 'four identical values all sit at 50');
    assertEq(percentileOf(40, [10, 20, 30, 40]), 87.5, 'the top of four is 87.5');
    assertEq(percentileOf(10, [10, 20, 30, 40]), 12.5, 'the bottom of four is 12.5');
    assertEq(percentileOf(5, []), null, 'an empty set has no percentile');
});

test('offenceStrength: averages the per-category percentiles, best offence highest', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    assertEq(strength.get(1), 87.5, 'the best offence is the top percentile in both categories');
    assertEq(strength.get(4), 12.5, 'the worst offence is the bottom in both');
    assertEq(strength.get(2), 62.5, 'second best');
    assertEq(strength.get(3), 37.5, 'third');
});

test('pastStartsByOpponent: a stat line joins to its game and lands under the right opponent', () => {
    const index = buildGamePeriodIndex(probablesSchedule);
    // Pitcher on team 1. Game 900 is home against 2, game 902 is away at 2, game 907 is home against 3.
    const lines = [
        { externalId: 900, totals: { K: 8 } },
        { externalId: 902, totals: { K: 6 } },
        { externalId: 907, totals: { K: 10 } }
    ];
    const byOpp = pastStartsByOpponent(lines, index, 1);
    assertEq(byOpp.get(2).outings, 2, 'two outings against team 2');
    assertEq(byOpp.get(2).home, 1, 'one of them at home');
    assertEq(byOpp.get(2).away, 1, 'one of them away');
    assertEq(byOpp.get(2).totals.K, 14, 'strikeouts summed across both');
    assertEq(byOpp.get(3).outings, 1, 'one outing against team 3');
});

test('pastStartsByOpponent: a line whose game is unknown is skipped, not guessed at', () => {
    const index = buildGamePeriodIndex(probablesSchedule);
    const byOpp = pastStartsByOpponent([{ externalId: 99999, totals: { K: 5 } }], index, 1);
    assertEq(byOpp.size, 0, 'an unresolvable game contributes nothing');
});

test('startDifficulty: the opponent offence is the base, and by itself it is the whole score', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const away = startDifficulty({ opponentId: 1, isHome: false }, strength, new Map());
    assertEq(away.base, 87.5, 'the base is the opponent offence percentile');
    assertEq(away.score, 87.5, 'with nothing else to say, the base stands alone');
    const home = startDifficulty({ opponentId: 1, isHome: true }, strength, new Map());
    // retired the invented home/away pair. Which side of the field a start is on now reaches the score only through the BALLPARK, and only when there is a park table to reach it through.
    assertEq(home.score, 87.5, 'the side of the field is not an adjustment of its own');
    assertEq(away.parts.length, 1, 'and it contributes no line to the breakdown');
});

test('startDifficulty: short rest adds its documented penalty, normal rest does not', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const short = startDifficulty({ opponentId: 3, isHome: true }, strength, new Map(), { restDays: 3 });
    assertEq(short.score, 37.5 + SHORT_REST_ADJUSTMENT, 'three days rest is short');
    const normal = startDifficulty({ opponentId: 3, isHome: true }, strength, new Map(), { restDays: 5 });
    assertEq(normal.score, 37.5, 'five days rest is ordinary');
});

test('startDifficulty: no previous start means no rest to measure, not zero rest', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const base = 37.5;
    const start = { opponentId: 3, isHome: true };
    // Number(null) is 0, which is finite and under the threshold. Reading restDays straight gave every first start of a window a penalty it had not earned.
    assertEq(startDifficulty(start, strength, new Map(), { restDays: null }).score, base,
        'null rest earns no penalty');
    assertEq(startDifficulty(start, strength, new Map(), {}).score, base,
        'an absent restDays earns none either');
    assertEq(startDifficulty(start, strength, new Map()).score, base,
        'and neither does an absent options object');
    assertEq(startDifficulty(start, strength, new Map(), { restDays: 0 }).score,
        base + SHORT_REST_ADJUSTMENT, 'a real zero days rest still counts');
});

test('startDifficulty: clamps at 100 so an adjustment cannot push it off the scale', () => {
    const strength = new Map([[1, 99], [2, 1]]);
    const parks = { 1: [120, 'Launch Pad'], 2: [80, 'The Vault'] };
    const hardest = startDifficulty({ teamId: 9, opponentId: 1, isHome: false }, strength, new Map(),
        { restDays: 3, parkFactors: parks });
    // 99, times 1.20 for the park, is 118.8; short rest takes it to 124.8.
    assertEq(hardest.score, 100, 'a hot offence in a launching pad on short rest clamps at 100');
    // The FLOOR is now structural rather than clamped, and that is worth stating. The park is a multiplier and rest only ever adds, so nothing in the engine can drive a non-negative base below zero. Math.max(0,...) survives as a guard on a future term, not as live arithmetic.
    const easiest = startDifficulty({ teamId: 9, opponentId: 2, isHome: false }, strength, new Map(),
        { parkFactors: parks });
    assertEq(easiest.score, 0.8, '1 in a pitcher\'s park is 0.8, which needed no clamping');
});

test('startDifficulty: the ballpark scales the offence, and which park depends on the side', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    // Team 3's offence sits at 37.5. Team 1 plays in a hitter's park, team 3 in a pitcher's.
    const parks = { 1: [120, 'Launch Pad'], 3: [80, 'The Vault'] };
    // AWAY is played in the opponent's park, so facing team 3 at their place: 37.5 x 0.80 = 30.
    const away = startDifficulty({ teamId: 1, opponentId: 3, isHome: false }, strength, new Map(),
        { parkFactors: parks });
    assertEq(away.score, 30, 'a pitcher\'s park makes the same lineup easier to face');
    assertEq(away.parts[1].label, 'The Vault, 80 run index', 'named, with the index it used');
    assertEq(away.parts[1].value, -7.5, 'and shown as the points it moved');
    // HOME is played in the pitcher's own, so the same opponent in team 1's park: 37.5 x 1.20 = 45.
    const home = startDifficulty({ teamId: 1, opponentId: 3, isHome: true }, strength, new Map(),
        { parkFactors: parks });
    assertEq(home.score, 45, 'a hitter\'s park makes the same lineup harder');
    assertEq(home.parts[1].label, 'Launch Pad, 120 run index', 'the pitcher\'s own park, by name');
});

test('startDifficulty: a park nobody has a factor for contributes nothing and says so', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const parks = { 1: [120, 'Launch Pad'] };
    const unknown = startDifficulty({ teamId: 9, opponentId: 3, isHome: true }, strength, new Map(),
        { parkFactors: parks });
    assertEq(unknown.score, 37.5, 'an unlisted park leaves the base exactly where it was');
    assertEq(unknown.parts[1].label, 'Ballpark unknown', 'and the breakdown admits it');
    assertEq(unknown.parts[1].value, 0, 'as a zero, never as a guessed nudge');
    // Without the pitcher's own club there is no side to be on, so the venue is unknown even though the opponent is right there and `isHome` says away.
    const sideless = startDifficulty({ opponentId: 1, isHome: false }, strength, new Map(),
        { parkFactors: parks });
    assertEq(sideless.parts[1].label, 'Ballpark unknown', 'an unknown side is an unknown park');
    assertEq(sideless.score, 87.5, 'and still no guess');
});

test('startDifficulty: a sport with no parks never grows the term (hockey)', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const d = startDifficulty({ teamId: 1, opponentId: 3, isHome: true }, strength, new Map(), { restDays: 5 });
    assertEq(d.parts.length, 1, 'no park table, no park line at all');
    assertEq(d.parts[0].label, 'Opponent offence', 'just the offence');
    assertEq(d.score, 37.5, 'and the score is untouched');
});

test('venueTeamIdFor: home is the pitcher\'s club, away is the opponent\'s, unknown is null', () => {
    assertEq(venueTeamIdFor({ teamId: 4, opponentId: 7, isHome: true }), 4, 'home is his own park');
    assertEq(venueTeamIdFor({ teamId: 4, opponentId: 7, isHome: false }), 7, 'away is theirs');
    assertEq(venueTeamIdFor({ opponentId: 7, isHome: false }), null, 'no club, no known venue');
    assertEq(venueTeamIdFor({ teamId: 4, isHome: false }), null, 'away with no opponent either');
    assertEq(venueTeamIdFor(null), null, 'and no start at all is null, not a throw');
});

test('MLB_PARK_FACTORS: the shipped table still says what it was entered from', () => {
    // A guard on the hand-refresh, not on Savant. These are the two ends of the 2023-2025 window captured on, so a transcription slip or a half-finished update fails here rather than silently re-weighting every start in the app.
    assertEq(MLB_PARK_FACTORS[27][0], 125, 'Coors Field is the extreme, at 125');
    assertEq(MLB_PARK_FACTORS[27][1], 'Coors Field', 'and named');
    assertEq(MLB_PARK_FACTORS[12][0], 83, 'T-Mobile Park is the other end, at 83');
    const indexes = Object.values(MLB_PARK_FACTORS).map(p => p[0]);
    assertEq(Math.max(...indexes), 125, 'nothing plays above Coors');
    assertEq(Math.min(...indexes), 83, 'and nothing below Seattle');
    assertEq(Object.keys(MLB_PARK_FACTORS).length, 28, 'twenty-eight parks');
    // Savant publishes no three-year factor for the temporary parks these two moved into, and a minor-league run environment is not the one they left. They take the unknown path on purpose.
    assertEq(MLB_PARK_FACTORS[11], undefined, 'the Athletics have no listed park');
    assertEq(MLB_PARK_FACTORS[30], undefined, 'nor do the Rays');
});

test('startDifficulty: an unmeasurable opponent reads as no result, never as average', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    assertEq(startDifficulty({ opponentId: 99, isHome: true }, strength, new Map()), null,
        'a team with no healthy hitters has no difficulty read');
    assertEq(startDifficulty({ opponentId: null, isHome: true }, strength, new Map()), null,
        'a start with no opponent has none either');
});

test('startDifficulty: carries the head-to-head record through when there is one', () => {
    const strength = offenceStrength(teamOffence(difficultyHitters(), ['R', 'HR']), ['R', 'HR']);
    const history = new Map([[1, { opponentId: 1, outings: 3, home: 2, away: 1, totals: { K: 21 } }]]);
    const d = startDifficulty({ opponentId: 1, isHome: true }, strength, history);
    assertEq(d.outings, 3, 'three prior outings against this opponent');
    assertEq(d.history.totals.K, 21, 'and their combined line rides along');
    const none = startDifficulty({ opponentId: 2, isHome: true }, strength, history);
    assertEq(none.outings, 0, 'no history reads as zero outings, not as missing');
});

test('difficultyLabel: the five bands, at their boundaries', () => {
    assertEq(difficultyLabel(80), 'Very hard', '80 is the top band');
    assertEq(difficultyLabel(60), 'Hard', '60 opens hard');
    assertEq(difficultyLabel(40), 'Even', '40 opens even');
    assertEq(difficultyLabel(20), 'Favourable', '20 opens favourable');
    assertEq(difficultyLabel(19.9), 'Very favourable', 'below 20 is the bottom band');
    assertEq(difficultyLabel(null), 'No read', 'no score has no label');
});

test('daysBetween: whole days, and null when a date is missing', () => {
    assertEq(daysBetween(0, 86400000 * 4), 4, 'four days');
    assertEq(daysBetween(null, 86400000), null, 'a missing date yields null');
});

// Report ---------------------------------------------------------------------------

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
