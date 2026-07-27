// Unit tests for the pure/testable halves of the export (export.js) and weekly recap (recap.js) features - open tests/features.test.html through any static server (file:// won't work for ES modules; .claude/serve.ps1 is a zero-dependency option). The builders read the AppState singleton, so each test sets up exactly the state it needs first.
import { AppState } from '../state.js';
import {
    delimitedCell, buildDelimitedText, timeframeLabel,
    buildStandingsExport, buildCategoryTotalsExport
} from '../export.js';
import { buildLeaderboardExportModel, aggregateStatsForWeekRange } from '../players.js';
import {
    defaultRecapWeek, buildRecapModel, buildRecapText,
    detectMyTeamId, buildTeamMatchupRecapModel, buildTeamMatchupText
} from '../recap.js';
import { orderStatIdsByRole, splitStatIdsByRole, buildMatchupPeriodMap, matchupOfPeriod, getTimeframeBounds, parseTimeframe } from '../utils.js';
import { buildRosterGroups, rostersFromPayload, findOwnedTeamId } from '../myteam.js';

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

// --------------------------------------------------------------------------- CSV primitives ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- Standings / category totals exports ---------------------------------------------------------------------------

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
    AppState.timeframe = 'last1'; // matchup 3 only: one game cannot make a record
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
    // Week 2 is a bye for Bravos: ESPN gives the resting team a one-sided game with no opponent, so it has points on the board and no winner. Counting that as "not a win" gave the league champion a playoff loss.
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 100.5, 2: 90.25 }, {}, {}, { 1: 0, 2: 1 }),
        T(2, 'Bravos', { 1: 120, 2: 106.7 }, {}, {}, { 1: 1 }, { 2: true })
    ];
    AppState.maxCompletedWeek = 2;
    const { rows } = buildStandingsExport();
    // 1W-0L-0T, not 1W-1L: the bye is in neither column, and its 106.7 still counts for Points For.
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

// --------------------------------------------------------------------------- Leaderboard export model ---------------------------------------------------------------------------

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
    // Rank pool is still the full same-role pool: the FA is #2 of 2, not an isolated #1 of 1.
    assertEq(model.rows[0][3], 2, 'rank stays relative to the whole pool');

    AppState.playerAvailabilityFilter = 'rostered';
    model = buildLeaderboardExportModel();
    assertEq(model.rows.length, 1, 'only the rostered player shows');
    assertEq(model.rows[0][0], 'Rostered Ace', 'rostered row');
    assertEq(model.rows[0][3], 1, 'rostered player is #1');

    AppState.playerAvailabilityFilter = 'all';
    assertEq(buildLeaderboardExportModel().rows.length, 2, 'all shows everyone');
});

// --------------------------------------------------------------------------- Recap model + text ---------------------------------------------------------------------------

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

test('buildRecapModel: a points-league bye counts points but no result (+ )', () => {
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

// --------------------------------------------------------------------------- Team matchup recap ---------------------------------------------------------------------------

// A single head-to-head week: team 8 (me) hosts team 3. I win HR (10>8) and R (5>3); they win ERA (2.5<3.5, lower is better) - so I take the matchup 2-1-0.
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

// --------------------------------------------------------------------------- Role-grouped stat ordering (utils.js) - the one helper every mixed stat list orders through ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- Windowed roto aggregation: the shared range aggregation that re-scores a roto window over ONLY that window's accumulated started-day components. The one thing that must hold for a window to be honest is the rate ground rule - a rate category is reproduced from summed COMPONENTS over the window, never from averaging each day/week's already-computed rate. These hand-computed cases pin that down directly; the end-to-end identity (a full-season window reproducing ESPN's official per-category finals) is validated in-browser on the FGB fixture. ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- --------------------------------------------------------------------------- My Team: roster grouping and payload rosters ---------------------------------------------------------------------------

// Baseball slot ids, VALIDATED against real captures: 16 is bench and 17 is IL for flb, which is what makes a scratch read differently from an injury.
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

// --------------------------------------------------------------------------- Scoring period to matchup, off the league's own schedule ---------------------------------------------------------------------------

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
    // The bug this fixes: floor(124/7) is 17, but ESPN reported currentMatchupPeriod 16 that day.
    assertEq(matchupOfPeriod(m, 124), 16, 'the last day of matchup 16');
    assertEq(matchupOfPeriod(m, 104), 15, 'the first day of the break matchup');
    assertEq(matchupOfPeriod(m, 7), 1, 'mid opening week');
});

test('matchupOfPeriod puts an unscored day in the matchup ESPN reports as current', () => {
    // Morning of matchup 17, nothing scored into the schedule yet: those days are in 17, so "this matchup" reads empty rather than borrowing the previous matchup's production.
    const m = buildMatchupPeriodMap(scheduleFixture(), { currentMatchupPeriod: 17 });
    assertEq(matchupOfPeriod(m, 125), 17, 'today');
    assertEq(matchupOfPeriod(m, 124), 16, 'yesterday still belongs to the matchup that ended');
});

test('matchupOfPeriod keeps the rest of a matchup already under way', () => {
    // The regression the first version of this had: with days 125 and 126 scored, day 127 fell into matchup 18 because it extrapolated seven days from the last SCORED day.
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
    // Only the "last N" family moves: a full-season total must not gain an empty matchup, or isFullSeasonTimeframe stops recognising it and the pool needlessly re-aggregates.
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
