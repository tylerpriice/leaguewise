// Unit tests for the pure/testable halves of the export (export.js) and weekly recap (recap.js) features. Open tests/features.test.html through any static server (file:// won't work for ES modules, python -m http.server works fine).
import { AppState } from '../state.js';
import {
    delimitedCell, buildDelimitedText, timeframeLabel,
    buildStandingsExport, buildCategoryTotalsExport
} from '../export.js';
import { buildLeaderboardExportModel } from '../players.js';
import {
    defaultRecapWeek, buildRecapModel, buildRecapText,
    detectMyTeamId, buildTeamMatchupRecapModel, buildTeamMatchupText
} from '../recap.js';

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

// Team factory matching the shape processCoreData builds (data.js).
const T = (id, name, weeklyMatchWins, weeklyCatWins, weeklyCats = {}) => ({
    id, name, abbrev: name.slice(0, 4).toUpperCase(),
    seasonCats: {}, weeklyMatchWins, weeklyCatWins, weeklyCats, weeklyTier: {}
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
    assertEq(timeframeLabel(), 'Last 1 Matchups (Matchups 9-9)', 'lookback label');
    AppState.timeframe = 'all';
    assertEq(timeframeLabel(), 'Regular Season + Playoffs (Matchups 1-9)', 'full label');
});

// ==== Standings / category totals exports ====

test('buildStandingsExport: category league - records, order, cat-wins tiebreak', () => {
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
    AppState.timeframe = 'last1'; // matchup 3 only
    const { rows } = buildStandingsExport();
    assertEq(rows[0], [1, 'Bravos', 1, 0, 0, 1, 8], 'window winner');
    assertEq(rows[1], [2, 'Alphas', 0, 1, 0, 0, 2], 'window loser');
});

test('buildStandingsExport: points league - points column, no records', () => {
    AppState.isPointsLeague = true;
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 100.5, 2: 90.25 }, {}),
        T(2, 'Bravos', { 1: 120, 2: 95 }, {})
    ];
    AppState.maxCompletedWeek = 2;
    const { headers, rows } = buildStandingsExport();
    assertEq(headers, ['Rank', 'Team', 'Points'], 'points headers');
    assertEq(rows[0], [1, 'Bravos', 215], 'points leader');
    assertEq(rows[1], [2, 'Alphas', 190.75], 'points trailer');
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

test('buildLeaderboardExportModel: mirrors table - rank sort, min-games exclusion, headers', () => {
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
    // Standings thru wk2: Alphas(2 wins,13 cats), Charlies(2,10), Deltas(0,7), Bravos(0,6).
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

// A single head-to-head week: team 8 (me) hosts team 3.
function setupTeamMatchupLeague() {
    AppState.scoredStatIds = new Set(['5', '47', '20']); // HR, ERA(inverse), R
    AppState.teamStats = [
        T(8, 'My Team', { 1: 1 }, { 1: 2 }, { 1: { '5': 10, '47': 3.5, '20': 5 } }),
        T(3, 'Rivals', { 1: 0 }, { 1: 1 }, { 1: { '5': 8, '47': 2.5, '20': 3 } })
    ];
    AppState.teamColorMap = { 8: '#e6194b', 3: '#3cb44b' };
    AppState.maxCompletedWeek = 1;
    AppState.userSwid = '{abc}'; // lower-case on purpose. Detection must be case/brace tolerant
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

// ==== Report ====

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
