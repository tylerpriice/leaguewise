// Unit tests for the pure/testable halves of the export (export.js) and weekly recap (recap.js) features - open tests/features.test.html through any static server (file:// won't work for ES modules; python -m http.server is a zero-dependency option). The builders read the AppState singleton, so each test sets up exactly the state it needs first.
import { AppState } from '../state.js';
import {
    delimitedCell, buildDelimitedText, timeframeLabel,
    buildStandingsExport, buildCategoryTotalsExport
} from '../export.js';
import { buildLeaderboardExportModel, aggregateStatsForWeekRange, aggregateDailyCumulative, periodsOfMatchup, teamCategorySeries } from '../players.js';
import { proScheduleFor, proScheduleAttemptedFor } from '../api.js';
import {
    defaultRecapWeek, buildRecapModel, buildRecapText,
    detectMyTeamId, buildTeamMatchupRecapModel, buildTeamMatchupText
} from '../recap.js';
import { weekOfPeriod, midPeriodOfWeek } from '../utils.js';
import {
    gamesByProTeamForMatchup, densityAcrossMatchups, teamDensity,
    offNightsForMatchup, twoStartPitchers, playoffMatchups, playoffOutlook, matchupWindow,
    rosterNightCoverage, nightsAcrossMatchups, nightsFilledBy, openSeatNights
} from '../schedule-insight.js';
import { orderStatIdsByRole, splitStatIdsByRole, buildMatchupPeriodMap, scheduledPeriodsOfMatchup, matchupOfPeriod, getTimeframeBounds, parseTimeframe, injuryLabel, injuryBadgeHtml, playerPoolErrorText, openingSortDir, leagueSeasonYears } from '../utils.js';
import { buildRosterGroups, rostersFromPayload, findOwnedTeamId } from '../myteam.js';
import { rankPoolLabel, playoffDensityRows } from '../players.js';
import { buildGamePeriodIndex, datesByScoringPeriod, buildProTeamAbbrevs, typicalMatchupLength, currentMatchupWindow, countProjectedStarts, buildOddsIndex, moneylineFor, dayLabelerFor } from '../probables.js';
import {
    isSidelined, teamOffence, percentileOf, offenceStrength, offenceBreakdown, pastStartsByOpponent,
    startDifficulty, difficultyLabel, daysBetween, venueTeamIdFor,
    SHORT_REST_ADJUSTMENT, MLB_PARK_FACTORS
} from '../matchup-difficulty.js';
import { numericStat, matchupTally, matchupPoints, readsAsPlayedMatchup, matchupCatsForSide, matchResultOf, leagueTypeBadge, buildLoadingHtml } from '../utils.js';
import { isAllowedLogoUrl, buildTeamCrestHtml } from '../images.js';
import {
    normalizeName, nameVariantKey, clubOf, matchPlayers, matchSummary,
    PROTEAM_CLUB_MAP, DEAD_ENTRIES
} from '../player-id-map.js';
import {
    externalValue, externalLine, reportsFor,
    EXTERNAL_STAT_FIELDS, UNMAPPED_CATEGORIES, NHL_REPORTS
} from '../stat-crosswalk.js';
import {
    seasonTotalsFrom, carriesAny, retroBasis, eligibleAt, seasonRowFrom, seasonRowsFor
} from '../retro-basis.js';
import { computeRotoRanks } from '../rank-engine.js';
import { computePointsRanks } from '../rank-engine.js';
import { ESPN_STAT_MAPS, ESPN_STAT_FULL_NAMES, DST_POSITION_ID, LINEUP_SLOT_LABELS,
    LINEUP_SLOT_ORDER, NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, POSITION_MAPS,
    SECONDARY_GROUP_POSITIONS, lowerIsBetterIds } from '../state.js';
import { roleGroupsFor } from '../players.js';
import { dominantColour, darkenUntilContrast, contrastRatio, relativeLuminance, parseCssColour, toCssRgb } from '../logo-colour.js';
import { countApiRequest, countImageRequest, getRequestTally } from '../utils.js';
import {
    franchiseKeyOf, teamDisplayName, seasonFormat, championKeyOf, summarizeSeason,
    buildFranchises, allTimeRecords, headToHead, categoryUnion, careerRate, buildCareers, teamAbbrev,
    careerValue, sortCareers, seasonFinished, categoryRowHeight,
    CATEGORY_ROW_MIN, CATEGORY_ROW_MAX, CATEGORY_ROWS_BUDGET,
    rivalryDetail, rivalrySplit, isPostseasonGame, recordText, runSpanText,
    defaultFranchiseIndex, coverageSentence,
    RIVALRY_CARD_SECTIONS, pennantLines
} from '../history.js';

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
    // Beta's HR percentile is 0 at full workload (no shrinkage pull toward 50), so that Rank Score is a true 0.
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

// A result exists only when the winner does: the live matchup's UNDECIDED must answer null - a zero would book a loss for both sides, which is the one-loss-high record the owner measured on every team. Hand-computed against the encoding: HOME win = home 1 / away 0, TIE = 0.5 both, UNDECIDED and a missing side = null.
test('matchResultOf: decided games score 1/0.5/0, a live matchup scores nothing', () => {
    const live = { winner: 'UNDECIDED', home: { teamId: 1, cumulativeScoreLive: { wins: 3, losses: 0, ties: 11 } }, away: { teamId: 2 } };
    assertEq(matchResultOf(live, 'home'), null, 'live home has no result');
    assertEq(matchResultOf(live, 'away'), null, 'live away has no result');
    const done = { winner: 'HOME', home: { teamId: 1 }, away: { teamId: 2 } };
    assertEq(matchResultOf(done, 'home'), 1, 'decided home won');
    assertEq(matchResultOf(done, 'away'), 0, 'decided away lost');
    const tie = { winner: 'TIE', home: { teamId: 1 }, away: { teamId: 2 } };
    assertEq(matchResultOf(tie, 'home'), 0.5, 'tie is half');
    assertEq(matchResultOf(tie, 'away'), 0.5, 'tie is half both ways');
    const bye = { winner: 'UNDECIDED', home: { teamId: 1 } };
    assertEq(matchResultOf(bye, 'away'), null, 'a missing side has no result');
});

test('leagueTypeBadge (B36): every known scoringType maps to its label and tooltip', () => {
    const cats = leagueTypeBadge('H2H_EACH_CATEGORY');
    assertEq(cats.label, 'Weekly H2H · Categories', 'each-category label');
    assert(cats.tooltip.length > 0, 'each-category carries a tooltip');

    const most = leagueTypeBadge('H2H_MOST_CATEGORIES');
    assertEq(most.label, 'Weekly H2H · Most Categories', 'most-categories label (confirmed against the baseball capture)');

    const points = leagueTypeBadge('H2H_POINTS');
    assertEq(points.label, 'Weekly H2H · Points', 'points label (confirmed against the points hockey capture)');

    const roto = leagueTypeBadge('ROTO');
    assertEq(roto.label, 'Roto · Season Categories', 'roto label (confirmed against the 2025 roto capture)');

    const season = leagueTypeBadge('TOTAL_SEASON_POINTS');
    assertEq(season.label, 'Season Points', 'season-points label');
});

test('leagueTypeBadge: an unrecognized scoringType shows the raw value rather than nothing', () => {
    const unknown = leagueTypeBadge('SOME_NEW_FORMAT_ESPN_ADDS_LATER');
    assertEq(unknown.label, 'SOME_NEW_FORMAT_ESPN_ADDS_LATER', 'the raw value, not a guess or a blank');
    assert(unknown.tooltip.includes('SOME_NEW_FORMAT_ESPN_ADDS_LATER'), 'the tooltip names the same raw value');
});

test('leagueTypeBadge: no scoringType at all returns null, not a badge for nothing', () => {
    assertEq(leagueTypeBadge(null), null, 'null input');
    assertEq(leagueTypeBadge(undefined), null, 'undefined input');
    assertEq(leagueTypeBadge(''), null, 'empty string input');
});

test('buildLoadingHtml (B157): the exact blunt word VOICE.md asks for, never a per-site phrase', () => {
    const html = buildLoadingHtml();
    assert(html.includes('>Loading<'), 'the word is "Loading" - no ellipsis, no per-surface narration');
    assert(html.includes('loading-state') && html.includes('loading-icon') && html.includes('loading-text'),
        'the shared component\'s own three hooks are all present for the CSS to theme');
});

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

// ==== The days a matchup covers, including the ones it has not reached ====

// Shaped from a real, live 2026 MLB league, measured: 7-day regular matchups, a playoff round holding TWO week indices, and the round being played having scored only the days already played. The real league's numbers are kept so the expectations below can be read against the capture - matchup 21 ran 153-159, matchup 22 runs 160-173, matchup 23 runs 174-187, final day 187.
function playoffScheduleFixture(scoredThrough = 164) {
    const days = (a, b) => { const o = {}; for (let i = a; i <= b; i++) o[String(i)] = { 0: 1 }; return o; };
    const sched = [
        { matchupPeriodId: 20, home: { teamId: 1, pointsByScoringPeriod: days(146, 152) }, away: { teamId: 2, pointsByScoringPeriod: days(146, 152) } },
        { matchupPeriodId: 21, home: { teamId: 1, pointsByScoringPeriod: days(153, 159) }, away: { teamId: 2, pointsByScoringPeriod: days(153, 159) } }
    ];
    // The open round. scoredThrough below 160 is its first morning, with nothing scored at all.
    if (scoredThrough >= 160) {
        sched.push({ matchupPeriodId: 22, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 1, pointsByScoringPeriod: days(160, scoredThrough) }, away: { teamId: 2, pointsByScoringPeriod: days(160, scoredThrough) } });
    }
    return sched;
}

// matchupPeriods holds WEEK indices; only their COUNT is read. Matchup 22 holding [22, 23] is the league's own statement that the round is two weeks long, and it agrees with playoffMatchupPeriodLength 2 in the same capture.
const PLAYOFF_SETTINGS = {
    scheduleSettings: {
        matchupPeriodCount: 21, matchupPeriodLength: 1, playoffMatchupPeriodLength: 2,
        matchupPeriods: { 20: [20], 21: [21], 22: [22, 23], 23: [24, 25] }
    }
};
const PLAYOFF_STATUS = (current, latest) => ({
    currentMatchupPeriod: current, latestScoringPeriod: latest, finalScoringPeriod: 187, firstScoringPeriod: 1
});

test('the open playoff round covers the whole round, not the days scored so far', () => {
    // The defect, in one assertion. Day 164 is today; the round runs to 173, and the surface asking "how many games are left" was slicing the club schedule with a window that ended on today.
    const m = buildMatchupPeriodMap(playoffScheduleFixture(164), PLAYOFF_STATUS(22, 164), PLAYOFF_SETTINGS);
    const periods = scheduledPeriodsOfMatchup(m, 22);
    assertEq(periods.length, 14, 'two week indices, seven days each');
    assertEq([periods[0], periods[periods.length - 1]], [160, 173], 'the round the league really scheduled');
    assertEq(periods.includes(165), true, 'tomorrow is in the matchup being played');
});

test('a COMPLETED matchup is left exactly as its schedule scored it', () => {
    const m = buildMatchupPeriodMap(playoffScheduleFixture(164), PLAYOFF_STATUS(22, 164), PLAYOFF_SETTINGS);
    assertEq(scheduledPeriodsOfMatchup(m, 21).length, 7, 'a matchup that finished needs no help');
    assertEq([scheduledPeriodsOfMatchup(m, 21)[0], scheduledPeriodsOfMatchup(m, 21)[6]], [153, 159], 'its own days');
});

test('the rule reproduces a REGULAR matchup the league has already played', () => {
    // Validating against the completed record rather than only the open case: matchup 21 really ran 153-159, so the derivation must return that when 21 is the one being played.
    const sched = playoffScheduleFixture(159).filter(g => g.matchupPeriodId !== 21);
    const days = {}; for (let i = 153; i <= 156; i++) days[String(i)] = { 0: 1 };
    sched.push({ matchupPeriodId: 21, home: { teamId: 1, pointsByScoringPeriod: days } });
    const m = buildMatchupPeriodMap(sched, PLAYOFF_STATUS(21, 156), PLAYOFF_SETTINGS);
    const periods = scheduledPeriodsOfMatchup(m, 21);
    assertEq([periods[0], periods[periods.length - 1]], [153, 159], 'the week the league actually ran');
});

test('the LAST matchup ends on the season own final day', () => {
    // The arithmetic checking itself: whatever the shares are, the final round has to land on 187.
    const sched = playoffScheduleFixture(173);
    sched.push({ matchupPeriodId: 23, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 1, pointsByScoringPeriod: { 174: {}, 175: {} } } });
    const m = buildMatchupPeriodMap(sched, PLAYOFF_STATUS(23, 175), PLAYOFF_SETTINGS);
    const periods = scheduledPeriodsOfMatchup(m, 23);
    assertEq([periods[0], periods[periods.length - 1]], [174, 187], 'through the last day there is');
});

test('the first morning of a round is the whole round, not an empty window', () => {
    // Nothing scored for matchup 22 at all. This used to return [], which every caller reads as "no window", so the games column went blank on the morning a manager sets the round's lineup.
    const m = buildMatchupPeriodMap(playoffScheduleFixture(0), PLAYOFF_STATUS(22, 159), PLAYOFF_SETTINGS);
    const periods = scheduledPeriodsOfMatchup(m, 22);
    assertEq([periods[0], periods[periods.length - 1]], [160, 173], 'starting the day after the last scored one');
});

test('the span never reaches into a later matchup own scored days', () => {
    // The guarantee, not a property of the leagues measured so far: whatever the arithmetic says, a day another matchup has scored belongs to that matchup.
    const sched = playoffScheduleFixture(164);
    sched.push({ matchupPeriodId: 23, home: { teamId: 1, pointsByScoringPeriod: { 170: {} } } });
    const m = buildMatchupPeriodMap(sched, PLAYOFF_STATUS(22, 170), PLAYOFF_SETTINGS);
    const periods = scheduledPeriodsOfMatchup(m, 22);
    assertEq(periods[periods.length - 1], 169, 'stops the day before');
});

test('a FUTURE matchup is not widened, so the Next lens keeps its own answer', () => {
    // The fence. Matchup 23 has no games in this league's schedule, and answering for it would ungrey a pill on evidence the bracket has not produced yet.
    const m = buildMatchupPeriodMap(playoffScheduleFixture(164), PLAYOFF_STATUS(22, 164), PLAYOFF_SETTINGS);
    assertEq(scheduledPeriodsOfMatchup(m, 23).length, 0, 'nothing scheduled, nothing claimed');
});

test('without settings the map answers exactly as it always did', () => {
    // Every existing caller passes two arguments. The extension is opt-in and silent.
    const m = buildMatchupPeriodMap(playoffScheduleFixture(164), PLAYOFF_STATUS(22, 164));
    const periods = scheduledPeriodsOfMatchup(m, 22);
    assertEq([periods.length, periods[periods.length - 1]], [5, 164], 'the days scored, and no more');
});

test('a matchup the settings say nothing about is not extended', () => {
    // A payload whose matchupPeriods stops short, and roto, which has no matchups at all. Neither gets an invented day: the caller keeps the empty or short answer it can recognise.
    const short = { scheduleSettings: { matchupPeriods: { 20: [20], 21: [21] } } };
    const m = buildMatchupPeriodMap(playoffScheduleFixture(164), PLAYOFF_STATUS(22, 164), short);
    assertEq(scheduledPeriodsOfMatchup(m, 22).length, 5, 'the scored days alone');
    const roto = buildMatchupPeriodMap([{ id: 1, matchupPeriodId: 1, teams: [{ teamId: 1 }] }], { currentMatchupPeriod: 1 }, PLAYOFF_SETTINGS);
    assertEq(scheduledPeriodsOfMatchup(roto, 1).length, 0, 'roto scores no period at all');
    assertEq(scheduledPeriodsOfMatchup(null, 22).length, 0, 'no map to read');
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

// ===== R7 / O58: a two-week playoff round is not a modal week ============================= The owner's report, measured on the live 2026 league at scoring period 164 of 187. The round being played runs days 160-173 - two weeks, per matchupPeriods[22] = [22, 23] - while twenty of the league's twenty-two completed rounds ran seven days, so the modal length is 7. The window therefore ended on day 166 and a pitcher's listed start on day 167 read as not happening. The pitcher's own listings inside the round, exactly as the capture carries them: 162 PROBABLE (already played) 164 NOTSTARTING (today) 167 PROBABLE 173 PROBABLE

const O58_SCHEDULE = (() => {
    const days = (a, b) => { const o = {}; for (let i = a; i <= b; i++) o[String(i)] = { 0: 1 }; return o; };
    return [
        { matchupPeriodId: 21, home: { teamId: 1, pointsByScoringPeriod: days(153, 159) }, away: { teamId: 2, pointsByScoringPeriod: days(153, 159) } },
        { matchupPeriodId: 22, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 1, pointsByScoringPeriod: days(160, 164) }, away: { teamId: 2, pointsByScoringPeriod: days(160, 164) } }
    ];
})();
const O58_SETTINGS = { scheduleSettings: { matchupPeriods: { 21: [21], 22: [22, 23], 23: [24, 25] } } };
const O58_STATUS = { currentMatchupPeriod: 22, latestScoringPeriod: 164, finalScoringPeriod: 187, firstScoringPeriod: 1 };
const O58_MAP = buildMatchupPeriodMap(O58_SCHEDULE, O58_STATUS, O58_SETTINGS);
// One club, one game a day, so the game ids below are the days they fall on.
const O58_INDEX = buildGamePeriodIndex({
    settings: { proTeams: [{ id: 19, proGamesByScoringPeriod: (() => {
        const o = {}; for (let p = 155; p <= 187; p++) o[String(p)] = [{ id: 400000 + p, date: p, homeProTeamId: 19, awayProTeamId: 20 }]; return o;
    })() }] }
});
const O58_PITCHER = {
    id: 77, proTeamId: 19,
    starterStatusByProGame: {
        '400162': 'PROBABLE', '400164': 'NOTSTARTING', '400167': 'PROBABLE', '400173': 'PROBABLE'
    }
};

test('the map carries the OPEN matchup span, so nothing has to re-derive it', () => {
    assertEq([O58_MAP.currentSpan.start, O58_MAP.currentSpan.end], [160, 173], 'the round the league scheduled');
});

test('currentMatchupWindow uses the league own span, not the modal length', () => {
    // The defect: 7 is genuinely the modal length here (twenty-one of the completed rounds ran a week), and applying it to a fortnight-long playoff round ends the window a week early.
    assertEq(typicalMatchupLength(O58_MAP), 7, 'the modal length really is a week');
    const w = currentMatchupWindow(O58_MAP, 164);
    assertEq([w.start, w.end], [160, 173], 'the whole round, not start plus seven');
    assertEq(w.assumedEnd, false, 'and the end is no longer an assumption');
});

test("the pitcher's Monday start is inside the window again", () => {
    // The owner's own figure. Over the modal-length window he read 1 start and 0 left, his day-167 turn falling outside it; over the real round he has three listed, two still ahead.
    const w = currentMatchupWindow(O58_MAP, 164);
    const got = countProjectedStarts([O58_PITCHER], O58_INDEX, w, 164).byPlayer.get(77);
    assertEq([got.starts, got.remaining], [3, 2], 'three listed, two still to come');
    assertEq(got.games.map(g => g.period).join(','), '162,167,173', 'and the Monday among them');
    // NOTSTARTING on today is still not a start - the count did not gain one by widening.
    assertEq(got.games.some(g => g.period === 164), false, 'a skipped turn stays skipped');
});

test('a one-week window would still report the owner own 1 and 0', () => {
    // The regression guard, stated as the defect rather than the fix: this is what the modal length produced, and it must not come back quietly.
    const got = countProjectedStarts([O58_PITCHER], O58_INDEX, { start: 160, end: 166 }, 164).byPlayer.get(77);
    assertEq([got.starts, got.remaining], [1, 0], 'the figure the owner reported');
});

test('without settings the window keeps the modal-length fallback', () => {
    // A payload with no scheduleSettings, and every caller that still passes two arguments. The fallback is right for a league whose rounds really are its modal length, which is most of the season - it is only the playoff round it cannot see.
    const bare = buildMatchupPeriodMap(O58_SCHEDULE, O58_STATUS);
    assertEq(bare.currentSpan, null, 'nothing to derive a span from');
    const w = currentMatchupWindow(bare, 164);
    assertEq([w.end, w.assumedEnd], [166, true], 'start plus the modal length, and it says it assumed');
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
    assertEq(games.map(g => g.opponentId), [2, 2, 3], 'the other team, whichever side the pitcher is on');
    assertEq(games.map(g => g.played), [true, false, false], 'day 10 is behind us, day 12 is today');
    assertEq(games[0].date, 1000, 'date for the label');
    // The pitcher's own club, which is what a home start's ballpark is looked up by.
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
    assertEq(s.map(d => d.totals['5'] || 0), [0, 0, 4], 'the line sits at zero until the first game');
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
    assertEq(s[0].totals['47'], undefined, 'before a pitch is thrown there is no ERA to show');
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
    // THE STATUSES THE OWNER'S POOL ACTUALLY CARRIES, counted across all 3000 entries: ACTIVE 2594, SIXTY_DAY_DL 176, DAY_TO_DAY 119, FIFTEEN_DAY_DL 47, TEN_DAY_DL 38, OUT 23, SEVEN_DAY_DL 2, SUSPENSION 1. Every one of the eight is asserted here, because this predicate now decides who the coverage band is allowed to recommend.
    assertEq(isSidelined('TEN_DAY_DL'), true, 'the 10-day IL is sidelined');
    assertEq(isSidelined('FIFTEEN_DAY_DL'), true, 'the 15-day IL is sidelined');
    assertEq(isSidelined('SEVEN_DAY_DL'), true, 'the 7-day IL is sidelined');
    // SUSPENSION is the one ESPN's own `injured` boolean does NOT flag. Measured across the 3000 entries, isSidelined and (injured || status === SUSPENSION) agree on every single player - which is why this predicate is the rule rather than the boolean.
    assertEq(isSidelined('SUSPENSION'), true, 'a suspended player cannot play either');
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
    assertEq(venueTeamIdFor({ teamId: 4, opponentId: 7, isHome: true }), 4, 'home is the club\'s own park');
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

// ==== League History. The fixtures below mirror what was MEASURED in a real three-season league (docs/DATA-SOURCES.md section 9): the same franchise renames itself every year, a team slot changes hands between owners, franchises come and go, and the league switched from roto to head-to-head partway through. Every expected value is hand-computed. ====

const SWID_A = '{AAAAAAAA-1111}';
const SWID_B = '{BBBBBBBB-2222}';
const SWID_C = '{CCCCCCCC-3333}';
const SWID_D = '{DDDDDDDD-4444}';

// 2024, ROTO. A wins it (rankCalculatedFinal 1). C plays this season only.
const HIST_2024 = {
    seasonId: 2024,
    settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }, { statId: 2 }] } },
    schedule: [],
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'Old Name A', rankCalculatedFinal: 1, record: { overall: {} } },
        { id: 2, primaryOwner: SWID_B, name: 'Old Name B', rankCalculatedFinal: 2, record: { overall: {} } },
        { id: 3, primaryOwner: SWID_C, name: 'One Season C', rankCalculatedFinal: 3, record: { overall: {} } }
    ]
};

// 2025, ROTO, and a TIE at the top - measured ranks are not unique, so no champion is crowned.
const HIST_2025 = {
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }, { statId: 2 }] } },
    schedule: [],
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'Mid Name A', rankCalculatedFinal: 1, record: { overall: {} } },
        { id: 2, primaryOwner: SWID_B, name: 'Mid Name B', rankCalculatedFinal: 1, record: { overall: {} } }
    ]
};

// 2026, HEAD-TO-HEAD. Slot 2 has changed hands: it is D now, not B. B keeps playing in slot 5.
const HIST_2026 = {
    seasonId: 2026,
    settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 2 }, { statId: 9 }] } },
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'New Name A', rankCalculatedFinal: 2, record: { overall: { wins: 3, losses: 1, ties: 0 } } },
        { id: 2, primaryOwner: SWID_D, name: 'Newcomer D', rankCalculatedFinal: 3, record: { overall: { wins: 1, losses: 3, ties: 0 } } },
        { id: 5, primaryOwner: SWID_B, name: 'New Name B', rankCalculatedFinal: 1, record: { overall: { wins: 2, losses: 1, ties: 1 } } }
    ],
    schedule: [
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 2 } },
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'AWAY', home: { teamId: 2 }, away: { teamId: 5 } },
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'TIE', home: { teamId: 1 }, away: { teamId: 5 } },
        { matchupPeriodId: 3, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 1 }, away: { teamId: 2 } },
        { matchupPeriodId: 4, playoffTierType: 'WINNERS_BRACKET', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 5 } },
        { matchupPeriodId: 5, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 1 }, away: { teamId: 5 } }
    ]
};

test('franchiseKeyOf: the SWID, normalized, and teamId only as the fallback', () => {
    assertEq(franchiseKeyOf({ id: 7, primaryOwner: '{abcd-1}' }), 'ABCD-1', 'braces and case normalized');
    assertEq(franchiseKeyOf({ id: 7, owners: ['{abcd-1}'] }), 'ABCD-1', 'falls to owners[0]');
    assertEq(franchiseKeyOf({ id: 7 }), 'team:7', 'no ownership data, so teamId - prefixed');
    assertEq(franchiseKeyOf({}), null, 'nothing to key on at all');
});

test('seasonFormat and championKeyOf: the rule differs per format', () => {
    assertEq(seasonFormat(HIST_2024), 'roto', 'roto season');
    assertEq(seasonFormat(HIST_2026), 'h2h', 'category head-to-head season');
    assertEq(championKeyOf(HIST_2024), 'AAAAAAAA-1111', '2024 roto champion is A');
    assertEq(championKeyOf(HIST_2025), null, 'a tie at the top crowns nobody');
    assertEq(championKeyOf(HIST_2026), 'BBBBBBBB-2222', '2026 champion is the last bracket winner');
});

test('summarizeSeason: a roto season has no W-L-T, and says so with nulls', () => {
    const roto = summarizeSeason(HIST_2024);
    assertEq(roto.countsTowardRecords, false, 'roto keeps no record');
    assertEq(roto.franchises[0].wins, null, 'null, not a fabricated 0');
    const h2h = summarizeSeason(HIST_2026);
    assertEq(h2h.countsTowardRecords, true, 'head-to-head does keep one');
    assertEq(h2h.franchises[0].wins, 3, 'A won 3');
});

// rider: the card's fact values speak in abbreviations, so a franchise has to carry one.
test('teamAbbrev: the abbreviation the league set, or the derived fallback', () => {
    assertEq(teamAbbrev({ abbrev: 'IW', name: 'Ice Wolves' }), 'IW', 'the one the league set wins');
    assertEq(teamAbbrev({ name: 'Rink Rats' }), 'RINK', 'four characters, uppercased, when none is set');
    assertEq(teamAbbrev({ abbrev: '   ', name: 'Rink Rats' }), 'RINK', 'blank counts as none');
    assertEq(teamAbbrev({ location: 'Ice', nickname: 'Wolves' }), 'ICE ', 'built from location and nickname like the name is');
    assertEq(teamAbbrev({ name: 'AB' }), 'AB', 'a short name is not padded');
    assertEq(teamAbbrev(null), '', 'and nothing is nothing');
});

test('buildFranchises: the abbreviation follows the name, latest season wins', () => {
    const list = buildFranchises([HIST_2024, HIST_2026].map(summarizeSeason));
    const a = list.find(f => f.key === 'AAAAAAAA-1111');
    assertEq(a.name, 'New Name A', 'the latest name, as before');
    assertEq(a.abbrev, teamAbbrev({ name: 'New Name A' }), 'and the abbreviation from that same season');
});

test('buildFranchises: most recent name wins, and the old ones are remembered', () => {
    const seasons = [HIST_2026, HIST_2024, HIST_2025].map(summarizeSeason);
    const all = buildFranchises(seasons);
    assertEq(all.length, 4, 'A, B, C and D across the three seasons');
    const a = all.find(f => f.key === 'AAAAAAAA-1111');
    assertEq(a.name, 'New Name A', 'the 2026 name, because it is the most recent');
    assertEq(a.formerNames, ['Old Name A', 'Mid Name A'], 'the earlier names, current one excluded');
    assertEq(a.seasons, [2024, 2025, 2026], 'played all three');
    const c = all.find(f => f.key === 'CCCCCCCC-3333');
    assertEq(c.seasons, [2024], 'C played once and left');
    const d = all.find(f => f.key === 'DDDDDDDD-4444');
    assertEq(d.seasons, [2026], 'D arrived for 2026 and took the slot B used to hold');
});

test('allTimeRecords: only the seasons that keep a record are summed', () => {
    const { rows, countedYears } = allTimeRecords([HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason));
    assertEq(countedYears, [2026], 'the two roto seasons contribute no games');
    const b = rows.find(r => r.key === 'BBBBBBBB-2222');
    assertEq([b.wins, b.losses, b.ties], [2, 1, 1], 'B summed over the one counted season');
    assertEq(b.winPct, 0.625, 'a tie is half a win: (2 + 0.5) / 4');
    assertEq(b.titles, 1, 'B won 2026');
    assertEq(b.seasonsPlayed, 3, 'played all three even though only one counts for record');
    const a = rows.find(r => r.key === 'AAAAAAAA-1111');
    assertEq(a.titles, 1, 'A won the 2024 roto season');
    const c = rows.find(r => r.key === 'CCCCCCCC-3333');
    assertEq(c.winPct, null, 'C only ever played roto, so it has no win percentage at all');
    assertEq(c.recordSeasons, 0, 'and no seasons that keep one');
});

test('headToHead: head-to-head seasons only, byes and undecided games ignored', () => {
    const seasons = [HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason);
    const pairs = headToHead(seasons, { 2024: HIST_2024, 2025: HIST_2025, 2026: HIST_2026 });
    const ab = pairs.find(p => p.a === 'AAAAAAAA-1111' && p.b === 'BBBBBBBB-2222');
    // A and B meet three times in 2026: a tie in the regular season and two WINNERS_BRACKET games. Since item 1 the record is the regular season, so it is the tie alone - and the two bracket games ride alongside it rather than inside it. This expectation was [1, 1, 1] while the record counted everything, which is the disagreement with the standings that entry fixed.
    assertEq([ab.aWins, ab.bWins, ab.ties], [0, 0, 1], 'the tie is the whole regular-season record');
    assertEq(ab.postseason, 2, 'and both bracket games are counted beside it');
    const ad = pairs.find(p => p.a === 'AAAAAAAA-1111' && p.b === 'DDDDDDDD-4444');
    assertEq([ad.aWins, ad.bWins, ad.ties], [1, 0, 0], 'A beat D once');
    assertEq(ad.postseason, 0, 'that pair never met in the postseason');
    assertEq(pairs.length, 3, 'three pairings, and nothing from the roto seasons');
});

test('categoryUnion: every category ever scored, with the seasons it was scored in', () => {
    const u = categoryUnion([HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason));
    assertEq(u.totalSeasons, 3, 'three seasons in the union');
    const stat1 = u.stats.find(s => s.statId === '1');
    const stat2 = u.stats.find(s => s.statId === '2');
    const stat9 = u.stats.find(s => s.statId === '9');
    assertEq(stat2.scoredIn, [2024, 2025, 2026], 'stat 2 survived the format change');
    assertEq(stat1.scoredIn, [2024, 2025], 'stat 1 was dropped for 2026');
    assertEq(stat9.scoredIn, [2026], 'stat 9 is new in 2026');
    assertEq(u.stats[0].statId, '2', 'most-covered category sorts first');
});

test('careerRate: summed components, never averaged season rates', () => {
    const spec = { numerator: ['h'], denominator: ['ab'] };
    assertEq(careerRate({ h: 4 + 18, ab: 10 + 90 }, spec), 0.22, 'weighted by the components, not the seasons');
    assertEq(careerRate({ h: 5 }, spec), null, 'a missing component is null, not a guess');
    assertEq(careerRate({ h: 5, ab: 0 }, spec), null, 'no division by zero');
    assertEq(careerRate({ er: 30, ip: 90 }, { numerator: ['er'], denominator: ['ip'], scale: 9 }), 3,
        'the scale is applied once, after the division');
});

// League History M4: careers in this league. The pools below mirror what was measured - a season total sits at statSourceId 0 with statSplitTypeId 0, most of a pool is unrostered, and a player keeps one id while the printed name drifts. Every expected value is hand-computed.

const seasonTotal = (stats) => ({ stats: [{ statSourceId: 0, statSplitTypeId: 0, stats }] });

// 2024 roto: Alpha on team 1, Beta on team 2, and one free agent nobody owned.
const POOL_2024 = { players: [
    { id: 10, onTeamId: 1, player: { fullName: 'Al Alpha', ...seasonTotal({ '1': 40, '0': 100 }) } },
    { id: 20, onTeamId: 2, player: { fullName: 'Bo Beta', ...seasonTotal({ '1': 10, '0': 50 }) } },
    { id: 99, onTeamId: 0, player: { fullName: 'Never Owned', ...seasonTotal({ '1': 99, '0': 99 }) } }
] };
// 2026 head-to-head: Alpha has moved to team 5, and that printed name has changed.
const POOL_2026 = { players: [
    { id: 10, onTeamId: 5, player: { fullName: 'Alan Alpha', ...seasonTotal({ '1': 18, '0': 90 }) } },
    { id: 30, onTeamId: 1, player: { fullName: 'Cy Gamma', ...seasonTotal({ '1': 25, '0': 75 }) } }
] };

// summarizeSeason output is what maps a team slot to a franchise, so the fixtures reuse the real shape rather than a hand-rolled one.
const CAREER_SEASONS = {
    2024: summarizeSeason({
        seasonId: 2024,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }] } },
        schedule: [],
        teams: [
            { id: 1, primaryOwner: SWID_A, name: 'A', rankCalculatedFinal: 1, record: { overall: {} } },
            { id: 2, primaryOwner: SWID_B, name: 'B', rankCalculatedFinal: 2, record: { overall: {} } }
        ]
    }),
    2026: summarizeSeason({
        seasonId: 2026,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 1 }] } },
        schedule: [],
        teams: [
            { id: 1, primaryOwner: SWID_A, name: 'A', rankCalculatedFinal: 1, record: { overall: { wins: 1, losses: 0, ties: 0 } } },
            { id: 5, primaryOwner: SWID_B, name: 'B', rankCalculatedFinal: 2, record: { overall: { wins: 0, losses: 1, ties: 0 } } }
        ]
    })
};

// item 5. The bug: the franchise column read the pool's onTeamId, which is the roster at the MOMENT OF THE FETCH. A player dropped before it attributed to nobody - and the early return meant the stats and the season itself went too, so a drafted-and-dropped player lost a whole year. Measured on a real capture: 138 of 1039 pool entries were rostered at fetch time. The ruling is that any stint counts however short, so the transaction log decides. ownersByYear is { year: Map<playerId, teamId[]> } - see ownerTeamIdsByPlayer, unit-tested in the rank-engine suite. franchiseKeyOf strips the braces ESPN wraps a SWID in, so the keys a career row carries are the bare form. Named once here rather than re-derived in four expectations.
const KEY_A = SWID_A.replace(/[{}]/g, '').toUpperCase();
const KEY_B = SWID_B.replace(/[{}]/g, '').toUpperCase();

const DROPPED_POOL = { players: [
    // Rostered by nobody when the pool was read, but team 1 drafted and held this player that season.
    { id: 40, onTeamId: 0, player: { fullName: 'Drafted Then Dropped', ...seasonTotal({ '1': 7, '0': 30 }) } },
    { id: 20, onTeamId: 2, player: { fullName: 'Bo Beta', ...seasonTotal({ '1': 10, '0': 50 }) } }
] };

test('buildCareers: a player dropped before the fetch still counts, with the franchise', () => {
    const owners = { 2024: new Map([[40, [1]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    const dropped = rows.find(r => r.id === 40);
    assert(!!dropped, 'the player is in the table at all, which the onTeamId gate used to prevent');
    assertEq(dropped.seasons, [2024], 'the season counts');
    assertEq(dropped.totals['1'], 7, 'and so do the numbers for it');
    assertEq(dropped.franchiseKeys, [KEY_A], 'attributed to the franchise that held them');
});

test('buildCareers: without the log, the old onTeamId basis is the fallback', () => {
    // Golden rule 8: an unreadable season degrades to the incomplete answer rather than a blank one.
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS);
    assertEq(rows.some(r => r.id === 40), false, 'the dropped player is missing, as before');
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_B], 'the rostered one is unaffected');
});

test('buildCareers: every franchise that held them that season, in the order they did', () => {
    // Traded mid-season: both franchises count, because any stint counts.
    const owners = { 2024: new Map([[20, [1, 2]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_A, KEY_B],
        'both, first-held first, rather than only the one holding them at the fetch');
});

test('buildCareers: the log wins over onTeamId when they disagree', () => {
    // A player picked up after the last transaction slice would read one team from the snapshot and another from the log. The log is the record of the season, so it decides.
    const owners = { 2024: new Map([[20, [1]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_A], 'the log, not the snapshot');
});

test('buildCareers: components sum across seasons, and only rostered players count', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    assertEq(rows.some(r => r.id === 99), false, 'a player nobody ever rostered is not league history');
    const alpha = rows.find(r => r.id === 10);
    // 40 + 18 hits over 100 + 90 at-bats.
    assertEq(alpha.totals['1'], 58, 'hits summed across both seasons');
    assertEq(alpha.totals['0'], 190, 'at-bats summed across both seasons');
    assertEq(alpha.seasons, [2024, 2026], 'both seasons, in order');
});

test('buildCareers: a roto season counts exactly like a head-to-head one', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    // 2024 was roto and 2026 head-to-head. Components are format-neutral, so both are in the total.
    assertEq(alpha.totals['1'], 40 + 18, 'the roto season is not skipped the way records skip it');
    const beta = rows.find(r => r.id === 20);
    assertEq(beta.seasons, [2024], 'a roto-only player still has a career');
    assertEq(beta.totals['1'], 10, 'and real totals in it');
});

test('buildCareers: a player who changed franchises carries both, newest name wins', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    // Team 1 in 2024 is SWID_A; team 5 in 2026 is SWID_B. Same player, two franchises.
    assertEq(alpha.franchiseKeys, ['AAAAAAAA-1111', 'BBBBBBBB-2222'], 'both franchises, in the order played');
    assertEq(alpha.name, 'Alan Alpha', 'the most recent spelling, since the id is the identity');
});

test('buildCareers: a player present in one season only', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const gamma = rows.find(r => r.id === 30);
    assertEq(gamma.seasons, [2026], 'arrived for the last season');
    assertEq(gamma.totals['1'], 25, 'one season is the whole career');
    assertEq(gamma.franchiseKeys, ['AAAAAAAA-1111'], 'one franchise');
});

test('careerValue: a counting stat sums, a rate is rebuilt from the components', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    const specs = [{ out: '2', num: ['1'], den: ['0'] }];
    assertEq(careerValue(alpha, '1', specs), 58, 'a counting stat is the sum');
    // 58/190 =.30526..., NOT the average of.400 and.200 which would be.300.
    const avg = careerValue(alpha, '2', specs);
    assertEq(Math.round(avg * 100000) / 100000, 0.30526, 'the rate comes from summed components');
    assert(avg !== 0.3, 'and is not the average of the two season averages');
    assertEq(careerValue(alpha, '77', specs), null, 'a stat with no component behind it is null');
});

// : a team logo loads only when ESPN is serving it. The request itself is the disclosure, so this gate decides whether an <img> is written at all - not whether one is hidden afterwards.
test('isAllowedLogoUrl: ESPN family only, and the host is matched not searched', () => {
    assert(isAllowedLogoUrl('https://g.espncdn.com/lm-static/logo-packs/core/Bears.svg'), 'the measured ESPN gallery host');
    assert(isAllowedLogoUrl('https://a.espncdn.com/i/teamlogos/x.png'), 'any espncdn subdomain');
    assert(isAllowedLogoUrl('https://espn.com/x.png'), 'the bare domain');
    assert(isAllowedLogoUrl('https://fantasy.espn.com/x.png'), 'and its subdomains');
    // The measured third-party case: a manager-pasted YouTube thumbnail.
    assert(!isAllowedLogoUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg'), 'YouTube is not ESPN');
    // A substring test would pass this, which is exactly why the check is host equality.
    assert(!isAllowedLogoUrl('https://g.espncdn.com.evil.example/spoof.png'), 'a lookalike host is refused');
    assert(!isAllowedLogoUrl('https://notespn.com/x.png'), 'and so is a suffix without the dot');
    assert(!isAllowedLogoUrl('http://g.espncdn.com/x.png'), 'plain http is refused even on an allowed host');
    assert(!isAllowedLogoUrl('javascript:alert(1)'), 'not a fetchable scheme');
    assert(!isAllowedLogoUrl('not a url at all'), 'unparseable is refused, not guessed at');
    assert(!isAllowedLogoUrl(''), 'empty');
    assert(!isAllowedLogoUrl(null), 'absent, which is the common case');
});

// R1: the rail's own team icon reuses isAllowedLogoUrl rather than a second host check. R2/S51 (frame I1): ALWAYS a tile now, never '' - the caller's own fallback used to be the legend-colour dot; frame I1 retired the dot in favour of one consistent crest shape, logo or not.
test('buildTeamCrestHtml: an abbreviation tile on a refused host or no logo, the logo laid over it on an allowed one', () => {
    const refused = buildTeamCrestHtml('Fixture Nine', 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
    assert(refused.includes('class="player-avatar"') && !refused.includes('class="avatar-img"'), 'refused host - the tile alone, no image tag at all');
    assert(refused.includes('>Fixture Nine<'), 'the label prints verbatim in the tile, not initials');
    const noLogo = buildTeamCrestHtml('Fixture Nine', null);
    assert(noLogo.includes('class="player-avatar"') && !noLogo.includes('class="avatar-img"'), 'no logo at all - same tile-only shape');
    const html = buildTeamCrestHtml('Fixture Nine', 'https://g.espncdn.com/lm-static/logo-packs/core/Bears.svg');
    assert(html.includes('class="player-avatar"') && html.includes('class="avatar-img"'), 'the same two-layer tile buildProTeamCrestHtml uses');
    assert(html.includes('src="https://g.espncdn.com/lm-static/logo-packs/core/Bears.svg"'), 'the vetted URL passes through');
});

// item 4: the rivalry card's facts. Two franchises, six meetings, hand-counted below - the numbers here are worked out from the fixture by hand and not read off the implementation. 2024 p1 A beat B 2025 p1 A beat B 2024 p2 B beat A 2025 p2 A beat B 2024 p3 tie 2024 p20 A beat B, playoff 2023 roto, so it contributes nothing at all TWO BASES ON ONE CARD, which ruled and this fixture is built to show: RATIO facts - the record and the season bars - count the five REGULAR meetings: A 3, B 1, one tie. They have to reconcile with the rivalry row and the standings. SEQUENCE facts - the streak and the longest run - count all SIX, playoff included, because a run that survives a playoff loss is not a run. So this fixture deliberately prints "3 straight" beside a 3-1-1 record, and the playoff-meetings fact is what reconciles them.
const RIV_A = 'KEY-A';
const RIV_B = 'KEY-B';
const rivGame = (period, winner, tier) => ({
    matchupPeriodId: period,
    playoffTierType: tier || 'NONE',
    winner,
    home: { teamId: 1 },
    away: { teamId: 2 }
});
const RIV_SEASONS = [
    { year: 2023, countsTowardRecords: false, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] },
    { year: 2024, countsTowardRecords: true, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] },
    { year: 2025, countsTowardRecords: true, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] }
];
const RIV_PAYLOADS = {
    2023: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'HOME')] },
    // Deliberately out of order, since a schedule array's order is not promised to be chronological and every claim below is about order.
    2024: { schedule: [rivGame(20, 'HOME', 'WINNERS_BRACKET'), rivGame(2, 'AWAY'), rivGame(1, 'HOME'), rivGame(3, 'TIE')] },
    2025: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'HOME')] }
};

test('rivalryDetail: the record, per season, from the first franchise point of view', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.meetings.length, 6, 'six counted meetings - the roto season contributes none');
    assertEq(d.total, { w: 3, l: 1, t: 1 }, 'hand-counted over the five regular-season meetings');
    assertEq(d.seasons.map(s => `${s.year} ${s.w}-${s.l}-${s.t}`), ['2024 1-1-1', '2025 2-0-0'],
        'and split by season, oldest first, the playoff game left out of 2024');
});

test('rivalryDetail: meetings are ordered by matchup period, not by array order', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.meetings.map(m => `${m.year}.${m.period}`),
        ['2024.1', '2024.2', '2024.3', '2024.20', '2025.1', '2025.2'],
        '2024 was fed in shuffled and comes back in order');
    assertEq(`${d.last.year}.${d.last.period}`, '2025.2', 'so the last meeting is the real last one');
    assertEq(d.last.result, 'a', 'which the first franchise won');
});

test('rivalryDetail: a tie ends a streak, and the playoff win is inside it (B175)', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    // Backwards over ALL meetings: 2025 p2 (A), 2025 p1 (A), 2024 p20 (A, playoff) - then 2024 p3 is a tie and stops it. Three, hand-counted, where the regular-season-only basis said two.
    assertEq(d.streak, { side: 'a', count: 3 }, 'three straight, the playoff win among them');
    assertEq(d.longest, {
        side: 'a',
        count: 3,
        meetings: [
            { year: 2024, period: 20, playoff: true },
            { year: 2025, period: 1, playoff: false },
            { year: 2025, period: 2, playoff: false }
        ]
    }, 'and that run is also the longest, carrying every meeting and which kind it was');
    assertEq(runSpanText(d.longest), 'Season 2024 Matchup 20 Playoffs, Season 2025 Matchup 1, and 2',
        'the enumeration marks the playoff coordinate in place');
    // The ratio facts are untouched by any of that - item 1 still holds.
    assertEq(d.total, { w: 3, l: 1, t: 1 }, 'the record still counts the regular season only');
    assertEq(d.seasons.map(s => `${s.year} ${s.w}-${s.l}-${s.t}`), ['2024 1-1-1', '2025 2-0-0'],
        'and so do the season bars');
});

// The two cases the ruling names, staged rather than reasoned about.
test('rivalryDetail: a playoff WIN extends a run', () => {
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(1, 'HOME'),
        rivGame(2, 'HOME'),
        rivGame(25, 'HOME', 'WINNERS_BRACKET')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.streak, { side: 'a', count: 3 }, 'two regular wins and the playoff win is a run of three');
    assertEq(d.total, { w: 2, l: 0, t: 0 }, 'while the record still shows the two regular wins');
    assertEq(runSpanText(d.longest), 'Season 2025 Matchup 1, 2, and 25 Playoffs', 'the playoff game named as one');
});

test('rivalryDetail: a playoff LOSS breaks a run - the case the owner caught', () => {
    // A wins two, loses the playoff game, wins one more. The old basis skipped the loss entirely and called it a run of three; it is a run of one, and the run of two before it is the longest.
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(1, 'HOME'),
        rivGame(2, 'HOME'),
        rivGame(25, 'AWAY', 'WINNERS_BRACKET'),
        rivGame(26, 'HOME')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.streak, { side: 'a', count: 1 }, 'the current streak is one - the playoff loss stopped it');
    assertEq(d.longest.count, 2, 'and the longest run is the two before that loss, not three');
    assertEq(runSpanText(d.longest), 'Season 2025 Matchup 1 and 2', 'named without the game that ended it');
    assertEq(d.total, { w: 3, l: 0, t: 0 }, 'the record is unmoved - it never counted the playoff loss');
    assertEq(d.playoff, { total: 1, aWins: 0, bWins: 1, ties: 0 }, 'which the playoff fact reports instead');
});

test('rivalryDetail: postseason meetings are counted apart from the rest', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.playoff, { total: 1, aWins: 1, bWins: 0, ties: 0 }, 'one, and the first franchise won it');
});

test('rivalryDetail: reversing the pair reverses every answer', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_B, RIV_A);
    assertEq(d.total, { w: 1, l: 3, t: 1 }, 'the same meetings read from the other side');
    assertEq(d.streak, { side: 'b', count: 3 }, 'the streak belongs to the other franchise now');
    assertEq(d.playoff.aWins, 0, 'and so does the playoff win');
});

test('rivalryDetail: two franchises who never met answer with zeroes, not with nulls', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, 'KEY-NOBODY');
    assertEq(d.meetings.length, 0, 'no meetings');
    assertEq(d.total, { w: 0, l: 0, t: 0 }, 'an empty record rather than a missing one');
    assertEq(d.streak, null, 'nothing to have a streak about');
    assertEq(d.last, null, 'and no last meeting');
    assertEq(rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_A).meetings.length, 0,
        'and nobody is their own rival');
});

test('rivalryDetail: an undecided game is not a meeting yet', () => {
    const payloads = { 2025: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'UNDECIDED')] } };
    const seasons = [RIV_SEASONS[2]];
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.meetings.length, 1, 'the week that has not been played does not count');
    assertEq(d.total, { w: 1, l: 0, t: 0 }, 'and cannot be a loss for anybody');
});

// item 1. The bug: the pager summed every decided game and the standings sum ESPN's own record.overall, which counts the regular season only - diagnosed across 11 real captures, where every league with a postseason tier disagreed for every team and every league without one agreed. The owner's case was 11-9-1 against 12-10-1, that franchise's two postseason games.
test('headToHead: the pair record counts the regular season, matching the standings basis', () => {
    const pairs = headToHead(RIV_SEASONS, RIV_PAYLOADS);
    assertEq(pairs.length, 1, 'one pair');
    const p = pairs[0];
    const aFirst = p.a === RIV_A;
    assertEq(aFirst ? p.aWins : p.bWins, 3, 'three regular-season wins, not four');
    assertEq(aFirst ? p.bWins : p.aWins, 1, 'one loss');
    assertEq(p.ties, 1, 'one tie');
    assertEq(p.postseason, 1, 'and the playoff game is carried beside the record, not inside it');
});

test('headToHead: a pair whose only meeting was a playoff game is still a pair', () => {
    // Otherwise the row would read "Never met" about two franchises who met in a final.
    const payloads = { 2025: { schedule: [rivGame(20, 'HOME', 'WINNERS_BRACKET')] } };
    const pairs = headToHead([RIV_SEASONS[2]], payloads);
    assertEq(pairs.length, 1, 'the pair exists');
    assertEq(pairs[0].aWins + pairs[0].bWins + pairs[0].ties, 0, 'with an empty record');
    assertEq(pairs[0].postseason, 1, 'and one postseason meeting to explain it');
});

test('recordText: one W-L-T form, so the same record cannot read as two values', () => {
    assertEq(recordText(54, 9, 0), '54-9', 'a zero tie is dropped');
    assertEq(recordText(33, 27, 3), '33-27-3', 'a real tie is kept');
    assertEq(recordText(0, 0, 0), '0-0', 'and an empty record is still a record');
    assertEq(recordText(null, undefined, NaN), '0-0', 'missing numbers read as none, never as NaN');
});

test('isPostseasonGame: NONE and a missing tier are the regular season, everything else is not', () => {
    assert(!isPostseasonGame({ playoffTierType: 'NONE' }), 'the measured regular-season value');
    assert(!isPostseasonGame({}), 'a game with no tier field at all');
    assert(isPostseasonGame({ playoffTierType: 'WINNERS_BRACKET' }), 'the bracket');
    assert(isPostseasonGame({ playoffTierType: 'WINNERS_CONSOLATION_LADDER' }), 'and both ladders');
    assert(isPostseasonGame({ playoffTierType: 'LOSERS_CONSOLATION_LADDER' }), 'measured in the fixtures');
});

// item 3: the pane opens on the reader's own franchise, the way the other tabs do.
test('defaultFranchiseIndex: the SWID wins, whatever order the franchises came in', () => {
    const list = [{ key: 'AAAA-1' }, { key: 'BBBB-2' }, { key: 'CCCC-3' }];
    assertEq(defaultFranchiseIndex(list, '{bbbb-2}'), 1, 'braces and case are normalized on both sides');
    assertEq(defaultFranchiseIndex(list, 'CCCC-3'), 2, 'a bare SWID matches too');
    assertEq(defaultFranchiseIndex(list, 'ZZZZ-9'), 0, 'a league the reader is not in opens on the first');
    assertEq(defaultFranchiseIndex(list, ''), 0, 'and so does a session with no SWID at all');
    assertEq(defaultFranchiseIndex([], 'AAAA-1'), 0, 'an empty league cannot throw');
});

// item 6: the owner's sentence, with both year lists computed.
test('coverageSentence: names what is covered and what is not, and stays quiet when all of it is', () => {
    assertEq(coverageSentence([2026], [2024, 2025, 2026]),
        'Covers 2026. 2024 and 2025 are not applicable given they are not head to head.',
        "the owner's template, verbatim, with the years filled in");
    assertEq(coverageSentence([2025, 2026], [2024, 2025, 2026]),
        'Covers 2025 and 2026. 2024 is not applicable given it is not head to head.',
        'one leftover year takes the singular verb');
    assertEq(coverageSentence([2026], [2022, 2023, 2024, 2026]),
        'Covers 2026. 2022, 2023, and 2024 are not applicable given they are not head to head.',
        'three or more take the Oxford comma');
    assertEq(coverageSentence([2025, 2026], [2025, 2026]), '',
        'nothing to say when every season is head to head');
    assertEq(coverageSentence([], [2024, 2025]), '',
        'and nothing to say when none of them is - the empty-pane note covers that');
});

// The split and the depth are the two sizing rules the pane computes, and both read counts against constants rather than measuring what was rendered (the rule).
test('rivalrySplit: even while the list is short, list-heavy once it is long', () => {
    assertEq(rivalrySplit(5), 0.5, 'a six-team league splits down the middle');
    assertEq(rivalrySplit(8), 0.5, 'and still does at the top of the even band');
    assertEq(rivalrySplit(19), 0.6, 'a twenty-team league gives the list three fifths');
    assertEq(rivalrySplit(12), 0.55, 'and the middle is interpolated, not stepped');
    assert(rivalrySplit(0) === 0.5 && rivalrySplit(-2) === 0.5, 'a nonsense count still splits evenly');
});

// : the run says WHEN. Same season collapses the second season name. item 2: the meetings are named, not ranged. "Matchup 10 to 20" described eleven matchups when the run was two wins.
const runOf = (...pairs) => ({ meetings: pairs.map(([year, period]) => ({ year, period })) });

test('runSpanText: the run names its meetings, restating the season only when it changes', () => {
    assertEq(runSpanText(runOf([2026, 10])), 'Season 2026 Matchup 10', 'one meeting');
    assertEq(runSpanText(runOf([2026, 10], [2026, 20])), 'Season 2026 Matchup 10 and 20', 'two');
    assertEq(runSpanText(runOf([2026, 10], [2026, 15], [2026, 20])), 'Season 2026 Matchup 10, 15, and 20',
        'three or more take the Oxford comma VOICE.md asks for');
    assertEq(runSpanText(runOf([2023, 20], [2024, 2], [2024, 5])),
        'Season 2023 Matchup 20, Season 2024 Matchup 2, and 5',
        'the season is restated where the year changes, and only there');
    assertEq(runSpanText(runOf([2026, 10], [2026, 20])), 'Season 2026 Matchup 10 and 20',
        'a list of two takes no comma, which is the same rule rather than an exception');
    assertEq(runSpanText(null), '', 'no run, nothing to say');
    assertEq(runSpanText({ count: 3 }), '', 'and a run with no meetings says nothing rather than guessing');
});

test('runSpanText: a playoff meeting is marked where it sits (B175)', () => {
    const withPlayoff = { meetings: [
        { year: 2025, period: 19, playoff: false },
        { year: 2026, period: 2, playoff: true },
        { year: 2026, period: 5, playoff: false }
    ] };
    assertEq(runSpanText(withPlayoff), 'Season 2025 Matchup 19, Season 2026 Matchup 2 Playoffs, and 5',
        'the marker rides without a comma, which inside a list would read as another item');
    assertEq(runSpanText({ meetings: [{ year: 2026, period: 25, playoff: true }] }),
        'Season 2026 Matchup 25 Playoffs', 'a run of one playoff game still says which kind it was');
});

// item 1: the last meeting is about recency, so it is the only fact that counts playoff games.
test('rivalryDetail: the last meeting is the last of ANY kind, playoffs included', () => {
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(2, 'HOME'),
        rivGame(25, 'AWAY', 'WINNERS_BRACKET')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.last.period, 25, 'the playoff game is the most recent meeting, so it is the last one');
    assert(d.last.playoff === true, 'and it is marked, so the card can say so');
    assertEq(d.total, { w: 1, l: 0, t: 0 }, 'while the RECORD still counts the regular season only');
    assertEq(d.playoff.total, 1, 'with the playoff meeting counted in its own fact');
});

// item 3. The bug was a table told to be 100% tall handing its surplus to the row boxes; the replacement is this arithmetic, so the rule that used to live in a stylesheet is testable.
test('categoryRowHeight: a budget divided by a count, clamped at both ends', () => {
    assertEq(categoryRowHeight(2), CATEGORY_ROW_MAX, 'two seasons cannot each take 160px - the cap holds');
    assertEq(categoryRowHeight(4), CATEGORY_ROW_MAX, 'and four still ask for more than the cap allows');
    assertEq(categoryRowHeight(10), Math.floor(CATEGORY_ROWS_BUDGET / 10), 'ten fit under it and take their share');
    assertEq(categoryRowHeight(40), CATEGORY_ROW_MIN, 'a long league stops shrinking and scrolls instead');
    assertEq(categoryRowHeight(1), CATEGORY_ROW_MAX, 'one season is a cap case, not a whole-pane row');
});

test('categoryRowHeight: a nonsense count still returns a usable pitch', () => {
    assertEq(categoryRowHeight(0), CATEGORY_ROW_MAX, 'no seasons cannot divide by zero');
    assertEq(categoryRowHeight(-3), CATEGORY_ROW_MAX, 'nor by a negative one');
    assertEq(categoryRowHeight(2.7), CATEGORY_ROW_MAX, 'a fraction floors to a whole count');
});

// item 8: the session request tally. One live counter, so every assertion is a DELTA - the page under test has already made calls of its own and a test that expected absolute numbers would pass alone and fail in the suite.
test('request tally: two groups that never mix, split by host and kind', () => {
    const t = getRequestTally();
    const before = JSON.parse(JSON.stringify(t));
    countApiRequest('https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/2026/x', 'league');
    countApiRequest('https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons/2026/y', 'weekly');
    countApiRequest('https://fan.api.espn.com/apis/v2/fans/x', 'league list');
    countImageRequest('https://a.espncdn.com/i/headshots/nhl/players/full/1.png');

    assertEq(t.api.total - before.api.total, 3, 'three api calls');
    assertEq(t.images.total - before.images.total, 1, 'and one image, counted apart from them');
    assertEq((t.api.byHost['lm-api-reads.fantasy.espn.com'] || 0) - (before.api.byHost['lm-api-reads.fantasy.espn.com'] || 0), 2,
        'two on the fantasy read host');
    assertEq((t.api.byHost['fan.api.espn.com'] || 0) - (before.api.byHost['fan.api.espn.com'] || 0), 1,
        'one on the discovery host');
    assertEq((t.api.byKind['weekly'] || 0) - (before.api.byKind['weekly'] || 0), 1, 'kinds are counted separately from hosts');
    assertEq((t.images.byHost['a.espncdn.com'] || 0) - (before.images.byHost['a.espncdn.com'] || 0), 1,
        'the image host lives in the image group only');
    assertEq(t.images.byHost['lm-api-reads.fantasy.espn.com'], before.images.byHost['lm-api-reads.fantasy.espn.com'],
        'and an api host never appears in it');
});

test('request tally: a url nobody can parse is counted under a name, not dropped', () => {
    const t = getRequestTally();
    const before = { total: t.api.total, unknown: t.api.byHost['unknown'] || 0, kind: t.api.byKind['other'] || 0 };
    countApiRequest('not a url at all', null);
    assertEq(t.api.total - before.total, 1, 'still one request - it was still made');
    assertEq((t.api.byHost['unknown'] || 0) - before.unknown, 1, 'under an honest host name');
    assertEq((t.api.byKind['other'] || 0) - before.kind, 1, 'and an honest kind');
});

// item 3: the tab's season set is never anchored to the loaded year.
test('leagueSeasonYears: the loaded season cannot shrink the league', () => {
    // The reported bug: the stub omits the unfinished 2026, and 2025 is what is loaded.
    assertEq(leagueSeasonYears([2024, 2025], 2025, 2026), [2024, 2025, 2026],
        'loading a past season still finds the current one');
    assertEq(leagueSeasonYears([2024, 2025], 2026, 2026), [2024, 2025, 2026],
        'and loading the current one gives the identical set');
    assertEq(leagueSeasonYears([2024, 2025], 2024, 2026), [2024, 2025, 2026],
        'from two seasons back, the same again');
    // A league that ended years ago names a year ESPN will refuse, which each season fetch already survives one at a time - the set is allowed to be optimistic, the fetch is not.
    assertEq(leagueSeasonYears([2019, 2020], 2020, 2026), [2019, 2020, 2026], 'the real year is always a candidate');
    assertEq(leagueSeasonYears([], 2026, 2026), [2026], 'no stub at all still gives the loaded season');
    assertEq(leagueSeasonYears(null, null, 2026), [2026], 'and nothing but the year still works');
    assertEq(leagueSeasonYears([2025, 2025], 2025, 2025), [2025], 'duplicates collapse');
});

// item 5: a finished league's careers are settled. The pair below is ESPN's own, measured on four real payloads - two roto seasons, a categories season and a points season - where latest was above final on every one and every one was in fact complete.
test('seasonFinished: the scoring-period pair decides, not the year and not isActive', () => {
    assertEq(seasonFinished({ status: { latestScoringPeriod: 193, finalScoringPeriod: 192 } }), true,
        'past the last period is finished');
    assertEq(seasonFinished({ status: { latestScoringPeriod: 192, finalScoringPeriod: 192 } }), true,
        'on the last period is finished');
    assertEq(seasonFinished({ status: { latestScoringPeriod: 120, finalScoringPeriod: 192 } }), false,
        'short of it is still being played');
    // isActive reads true on seasons two years done, so it is not the signal.
    assertEq(seasonFinished({ status: { isActive: true, latestScoringPeriod: 197, finalScoringPeriod: 196 } }), true,
        'isActive does not override the periods');
    // A season nobody can measure says nothing rather than claiming to be live.
    assertEq(seasonFinished({ status: {} }), true, 'no periods means no live claim');
    assertEq(seasonFinished({}), true, 'no status at all, same');
    assertEq(seasonFinished(null), true, 'no payload, same');
});

// item 0: one opening-direction rule for every sortable table in the app. Tested here rather than in either table, because the whole point of the ruling is that neither owns it.
test('openingSortDir: the first click shows the best value', () => {
    const hockey = new Set(['10', '2', '4']);   // GAA, L, GA - lower is better
    assertEq(openingSortDir('10', hockey), 'asc', 'GAA opens on the lowest, which is the best');
    assertEq(openingSortDir('13', hockey), 'desc', 'goals open on the highest, which is the best');
    const baseball = new Set(['47', '41']);     // ERA, WHIP
    assertEq(openingSortDir('47', baseball), 'asc', 'ERA opens ascending');
    assertEq(openingSortDir('41', baseball), 'asc', 'WHIP too');
    assertEq(openingSortDir('5', baseball), 'desc', 'a counting stat does not');
    // The leaderboard and the career table pass different key spaces through the same rule.
    assertEq(openingSortDir('seasons', baseball), 'desc', 'a non-stat column is not inverse');
    assertEq(openingSortDir('47', null), 'desc', 'no set given means nothing is inverse');
    assertEq(openingSortDir('47', new Set()), 'desc', 'an empty set is the same');
});

// : sorting the career table. The rows below are hand-made rather than built, so the expected order is readable from the fixture. Ivy has no goalie components at all, which is the blank case.
const SORT_ROWS = [
    { id: 1, name: 'Ann', seasons: [2024, 2025], franchiseKeys: ['A'], totals: { g: 30, sv: 90, sa: 100 } },
    { id: 2, name: 'Bob', seasons: [2025], franchiseKeys: ['B'], totals: { g: 50, sv: 180, sa: 200 } },
    { id: 3, name: 'Cal', seasons: [2024], franchiseKeys: ['A'], totals: { g: 30, sv: 270, sa: 300 } },
    { id: 4, name: 'Ivy', seasons: [2024, 2025, 2026], franchiseKeys: ['C'], totals: { g: 10 } }
];
const SORT_SPECS = [{ out: 'svpct', num: ['sv'], den: ['sa'] }];
const order = (spec) => sortCareers(SORT_ROWS, spec).map(r => r.name);

test('sortCareers: a counting column, both directions, ties by name', () => {
    // g: Bob 50, Ann 30, Cal 30, Ivy 10. Ann before Cal on the tie, both ways.
    assertEq(order({ key: 'g', dir: 'desc' }), ['Bob', 'Ann', 'Cal', 'Ivy'], 'highest first');
    assertEq(order({ key: 'g', dir: 'asc' }), ['Ivy', 'Ann', 'Cal', 'Bob'], 'lowest first, tie still A before C');
});

test('sortCareers: a rate column is derived, and a player with no components sorts last both ways', () => {
    // .900,.900,.900 - so it is the blank that this proves. Ivy has no sv or sa at all.
    assertEq(order({ key: 'svpct', dir: 'desc', rateSpecs: SORT_SPECS }), ['Ann', 'Bob', 'Cal', 'Ivy'],
        'blank last when descending');
    assertEq(order({ key: 'svpct', dir: 'asc', rateSpecs: SORT_SPECS }), ['Ann', 'Bob', 'Cal', 'Ivy'],
        'and still last when ascending, since no save percentage is not the lowest one');
});

test('sortCareers: name and seasons columns', () => {
    assertEq(order({ key: 'name', dir: 'asc' }), ['Ann', 'Bob', 'Cal', 'Ivy'], 'A to Z');
    assertEq(order({ key: 'name', dir: 'desc' }), ['Ivy', 'Cal', 'Bob', 'Ann'], 'Z to A');
    assertEq(order({ key: 'seasons', dir: 'desc' }), ['Ivy', 'Ann', 'Bob', 'Cal'], 'longest tenure first');
});

test('sortCareers: no key leaves the order alone, and never mutates the input', () => {
    const before = SORT_ROWS.map(r => r.name);
    assertEq(order({ key: null, dir: 'desc' }), before, 'unsorted is the order it was given');
    sortCareers(SORT_ROWS, { key: 'g', dir: 'asc' });
    assertEq(SORT_ROWS.map(r => r.name), before, 'the caller keeps its array');
});

// P2: the pennant's two lines. The reference is a ballclub pennant, city over nickname, and a fantasy name has no city - so the last word is the nickname and the rest hangs above it. ---------------------------------------------------------------------------

test('pennantLines: the last word is the nickname, the rest is the line above', () => {
    const three = pennantLines('Bunt Force Trauma');
    assert(three.top === 'Bunt Force' && three.nick === 'Trauma', 'BUNT FORCE over Trauma');
    const two = pennantLines('Big Inning');
    assert(two.top === 'Big' && two.nick === 'Inning', 'two words split one and one');
});

test('pennantLines: one word is a nickname with nothing above it', () => {
    const one = pennantLines('Sluggers');
    assert(one.nick === 'Sluggers', 'the one word is the nickname, never the top line');
    assert(one.top === '', 'and nothing hangs above it');
});

test('pennantLines: nothing in, nothing out, and stray spacing does not invent a line', () => {
    const none = pennantLines('');
    assert(none.top === '' && none.nick === '', 'empty name');
    const nul = pennantLines(null);
    assert(nul.top === '' && nul.nick === '', 'no name at all');
    const spaced = pennantLines('  Walk   Off   Warriors  ');
    assert(spaced.top === 'Walk Off' && spaced.nick === 'Warriors', 'runs of spaces collapse');
});


// : the live matchup tally. cumulativeScore counts FINALIZED DAYS ONLY; ESPN attaches cumulativeScoreLive to the in-progress matchup and to no other. Values below are the real shapes from JSON_debug/espn-debug-1785096490224.json, matchup 16 (live) and 15 (completed). ---------------------------------------------------------------------------

test('matchupTally: the live block wins when it is there', () => {
    const side = {
        cumulativeScore: { wins: 6, losses: 5, ties: 3 },
        cumulativeScoreLive: { wins: 6, losses: 6, ties: 2 }
    };
    const t = matchupTally(side);
    assert(t.wins === 6 && t.losses === 6 && t.ties === 2, 'the live 6-6-2, not the frozen 6-5-3');
});

test('matchupTally: a completed matchup has no live block, so the rollup stands', () => {
    // Exactly the shape a finished matchup arrives in - ESPN attaches no live block at all.
    const side = { cumulativeScore: { wins: 9, losses: 4, ties: 1 } };
    const t = matchupTally(side);
    assert(t.wins === 9 && t.losses === 4 && t.ties === 1, 'byte for byte the authoritative number');
});

test('matchupTally: an empty live block does not shadow a real rollup', () => {
    const side = { cumulativeScore: { wins: 3, losses: 2, ties: 0 }, cumulativeScoreLive: {} };
    assert(matchupTally(side).wins === 3, 'presence is not enough - it has to carry a wins count');
});

test('matchupTally: a zeroed live block is still the live one', () => {
    // A matchup that has just opened is genuinely 0-0-0, and that is not the same as absent.
    const side = { cumulativeScore: { wins: 8, losses: 1, ties: 0 }, cumulativeScoreLive: { wins: 0, losses: 0, ties: 0 } };
    assert(matchupTally(side).wins === 0, 'zero is a number');
});

test('matchupTally: nothing at all is null rather than a throw', () => {
    assert(matchupTally(null) === null, 'no side');
    assert(matchupTally({}) === null, 'a side with neither block');
});

test('matchupPoints: the live total is preferred, including a live zero', () => {
    assert(matchupPoints({ totalPoints: 163.1, totalPointsLive: 171.4 }) === 171.4, 'live wins');
    assert(matchupPoints({ totalPoints: 163.1, totalPointsLive: 0 }) === 0, 'a live 0 is a real score');
    assert(matchupPoints({ totalPoints: 163.1 }) === 163.1, 'no live field, use the plain one');
    assert(matchupPoints({}) === 0, 'neither');
    assert(matchupPoints(null) === 0, 'no side');
});

// item 2: DAY ONE OF A MATCHUP. The recurring failure is that the windowed aggregates see no finalized day while the header reads the live block, so Current renders 0-0 against a header that knows better. These stage day one explicitly - a live block present, zero finalized days - and assert the two agree, which they now do by construction because both go through matchupTally. ---------------------------------------------------------------------------

test('readsAsPlayedMatchup: the live matchup is readable even though it is not complete', () => {
    // The morning matchup 16 opens: 15 is the last with a result, 16 is being played.
    assert(readsAsPlayedMatchup(15, 15, 16) === true, 'the completed one');
    assert(readsAsPlayedMatchup(16, 15, 16) === true, 'the live one - this is the fix');
    assert(readsAsPlayedMatchup(17, 15, 16) === false, 'a matchup that has not started');
});

test('readsAsPlayedMatchup: a finished season has no live matchup to admit', () => {
    // AppState.currentMatchup is 0 once the season is over, so the max collapses to the last completed matchup with no special case.
    assert(readsAsPlayedMatchup(25, 25, 0) === true, 'the final matchup still reads');
    assert(readsAsPlayedMatchup(26, 25, 0) === false, 'nothing past it');
});

test('day one: Current reads the SAME per-category values the header shows', () => {
    // Zero finalized days: the rollup is all zeros and the live block carries the real standing. This is the owner's 0-0 case - the rollup is exactly what Current used to aggregate.
    const side = {
        cumulativeScore: {
            wins: 0, losses: 0, ties: 0,
            scoreByStat: { '1': { score: 0 }, '5': { score: 0 }, '47': { score: 0 } }
        },
        cumulativeScoreLive: {
            wins: 3, losses: 0, ties: 11,
            scoreByStat: { '1': { score: 14 }, '5': { score: 2 }, '47': { score: 3.5 } }
        }
    };
    const cats = matchupCatsForSide(side);
    // The header's number, straight off matchupTally - the same call the scoreboard makes.
    const header = matchupTally(side);
    assert(header.wins === 3 && header.ties === 11, 'the header reads the live standing');
    assert(cats['1'] === 14 && cats['5'] === 2 && cats['47'] === 3.5,
        'Current must agree with the header, got ' + JSON.stringify(cats));
});

test('day one: a completed matchup still reads its finalized values', () => {
    const side = { cumulativeScore: { wins: 9, losses: 4, ties: 1, scoreByStat: { '1': { score: 61 } } } };
    assert(matchupCatsForSide(side)['1'] === 61, 'no live block, the rollup stands');
});

test('matchupCatsForSide: an entry that names its own statId wins over the key', () => {
    // statBySlot is keyed by slot rather than by stat, and each entry carries the real statId.
    const side = { cumulativeScore: { statBySlot: { '22': { statId: 5, score: 7 } } } };
    assert(matchupCatsForSide(side)['5'] === 7, 'filed under the stat, not the slot');
});


// item 3: RATE CATEGORIES IN THE RACE CHART. A rate can never be summed across weeks. Every expectation below is hand-computed from the components, and each message names the summed value the owner was actually seeing. ---------------------------------------------------------------------------

const closeTo = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('teamCategorySeries: AVG recomputes from cumulative H/AB, never summed', () => {
    // AB is stat 0, H is stat 1, AVG is stat 2.
    const weeklyCats = {
        1: { '0': 30, '1': 9, '2': 0.300 },
        2: { '0': 20, '1': 4, '2': 0.200 },
        3: { '0': 50, '1': 20, '2': 0.400 }
    };
    const got = teamCategorySeries(weeklyCats, [1, 2, 3], '2', 'flb');
    // Hand-computed: 9/30 =.300, 13/50 =.260, 33/100 =.330.
    assert(closeTo(got[0], 0.300), 'week 1 ' + got[0]);
    assert(closeTo(got[1], 0.260), 'week 2 ' + got[1] + ' - summing the weekly rates gives .500');
    assert(closeTo(got[2], 0.330), 'week 3 ' + got[2] + ' - summing gives .900, and a season of that is the reported 4.9');
});

test('teamCategorySeries: ERA recomputes from cumulative ER and outs', () => {
    // OUTS is stat 34, ER is stat 45, ERA is stat 47 with scale 27 (ER * 9 / innings).
    const weeklyCats = {
        1: { '34': 27, '45': 3, '47': 3.00 },
        2: { '34': 27, '45': 6, '47': 6.00 },
        3: { '34': 54, '45': 3, '47': 1.50 }
    };
    const got = teamCategorySeries(weeklyCats, [1, 2, 3], '47', 'flb');
    // Hand-computed: 3*27/27 = 3.00, 9*27/54 = 4.50, 12*27/108 = 3.00.
    assert(closeTo(got[0], 3.00), 'week 1 ' + got[0]);
    assert(closeTo(got[1], 4.50), 'week 2 ' + got[1] + ' - summing gives 9.00');
    assert(closeTo(got[2], 3.00), 'week 3 ' + got[2] + ' - summing gives 10.50');
    // ERA is an inverse category and this returns the REAL era either way - which end of the scale is good belongs to the renderer. A good week pulling the cumulative number DOWN is what proves the direction is not being flipped somewhere in the accumulation.
    assert(got[2] < got[1], 'a good week pulls a cumulative ERA down');
});

test('teamCategorySeries: a counting category still accumulates', () => {
    const weeklyCats = { 1: { '5': 2 }, 2: { '5': 3 }, 3: { '5': 4 } };
    const got = teamCategorySeries(weeklyCats, [1, 2, 3], '5', 'flb');
    assert(got[0] === 2 && got[1] === 5 && got[2] === 9, 'home runs add up: ' + got);
});

test('teamCategorySeries: a rate with no component rule falls back to the mean, not a sum', () => {
    // W-L% (55) is in AVERAGE_STATS with no entry in RATE_COMPONENTS, so it takes the fallback.
    const weeklyCats = { 1: { '55': 0.600 }, 2: { '55': 0.400 }, 3: { '55': 0.800 } };
    const got = teamCategorySeries(weeklyCats, [1, 2, 3], '55', 'flb');
    assert(closeTo(got[0], 0.600) && closeTo(got[1], 0.500) && closeTo(got[2], 0.600),
        'running mean, not a running total: ' + got);
});

test('teamCategorySeries: a week with no value is skipped rather than counted as zero', () => {
    // A bye leaves a gap. Averaging it in as a zero would drag the line toward nothing.
    const weeklyCats = { 1: { '55': 0.600 }, 3: { '55': 0.800 } };
    const got = teamCategorySeries(weeklyCats, [1, 2, 3], '55', 'flb');
    assert(closeTo(got[1], 0.600), 'the empty week holds the line, got ' + got[1]);
    assert(closeTo(got[2], 0.700), 'then two real weeks average, got ' + got[2]);
});

test('teamCategorySeries: an empty rate window is zero rather than NaN', () => {
    const got = teamCategorySeries({}, [1, 2], '2', 'flb');
    assert(got[0] === 0 && got[1] === 0, 'no components, no division by zero');
});

// : DOMINANT-COLOUR SAMPLING. Pure, over synthetic pixel data - a real logo is not needed to prove the histogram picks the right cell, and a hand-built array is the only way to know exactly what the answer should be. ---------------------------------------------------------------------------

// Build an RGBA byte array from [r,g,b,a] tuples, one per pixel.
const px = (...pixels) => new Uint8ClampedArray(pixels.flat());

test('dominantColour: the most common colour wins, not the average of two', () => {
    // Three red pixels and one blue. An average would return a purple the logo does not contain.
    const data = px([200, 30, 40, 255], [200, 30, 40, 255], [200, 30, 40, 255], [30, 40, 200, 255]);
    const got = dominantColour(data);
    assert(got[0] === 200 && got[1] === 30 && got[2] === 40, 'the red, exactly: ' + got);
});

test('dominantColour: a winning bucket averages its OWN pixels, so the answer is a real shade', () => {
    // Two near-identical reds share a bucket and average to the shade between them; the lone blue is a bucket of one and loses. The channel values here are chosen to sit INSIDE one cell rather than to look tidy. Buckets are 256/6 wide, about 42.7, so 40 and 50 straddle a boundary and would land two pixels that look almost identical in different cells - which is exactly what the first version of this test did, and it failed until the fixture was built to the real bucket width rather than to what a reader assumes it is.
    const data = px([200, 30, 40, 255], [208, 36, 40, 255], [30, 40, 200, 255]);
    const got = dominantColour(data);
    assert(got[0] === 204 && got[1] === 33 && got[2] === 40, 'mean of the winning bucket: ' + got);
});

test('dominantColour: two shades either side of a bucket edge stay apart', () => {
    // The other half of the same fact, asserted so a future change to BUCKETS shows up here as a decision rather than as a surprise: 40 and 50 are one cell apart at six buckets per channel, so neither red merges and the first-seen cell wins the tie.
    const data = px([200, 30, 40, 255], [210, 40, 50, 255]);
    const got = dominantColour(data);
    assert(got[0] === 200 && got[2] === 40, 'no merge across the edge: ' + got);
});

test('dominantColour: transparent pixels are background, not colour', () => {
    // ESPN's league logos are SVGs on a transparent field (DATA-SOURCES 13). Counting the cleared canvas would make almost every logo the same colour.
    const data = px([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [200, 30, 40, 255]);
    const got = dominantColour(data);
    assert(got[0] === 200, 'only the opaque pixel counted: ' + got);
});

test('dominantColour: near-white and near-black are paper and outline, not identity', () => {
    // A crest on white with a black outline: both are more numerous than the actual colour, and both would make a nonsense pennant.
    const data = px(
        [255, 255, 255, 255], [250, 250, 250, 255], [255, 255, 255, 255],
        [0, 0, 0, 255], [10, 10, 10, 255],
        [40, 90, 200, 255]
    );
    const got = dominantColour(data);
    assert(got[2] === 200 && got[0] === 40, 'the blue survives the paper and the ink: ' + got);
});

test('dominantColour: GREYS are not an identity either - the purple-pennant case', () => {
    // The real numbers from the flb default_logos/12.svg on g.espncdn, the logo that hung a black pennant. It contains purple AND more grey by area, so a by-area histogram picked the grey: rgb(82,82,82). Four grey pixels against two purple ones reproduces exactly that shape.
    const data = px(
        [210, 211, 211, 255], [163, 165, 165, 255], [73, 73, 73, 255], [204, 204, 205, 255],
        [120, 85, 163, 255], [86, 44, 135, 255]
    );
    const got = dominantColour(data);
    assert(got !== null, 'the purple survives the greys');
    // Hand-computed: the two purples share a bucket and average to (103, 65, 149).
    assert(got[0] === 103 && got[1] === 65 && got[2] === 149, 'the purple, not the grey: ' + got);
    // The saturation of every grey above is at or below 0.012 and of every purple at or above 0.479, so this is not a tuned threshold - it is two orders of magnitude of daylight.
});

test('dominantColour: a logo with nothing but paper and ink yields null', () => {
    // A genuinely monochrome logo has no colour to dye with, and null is what sends that team to theme black rather than to an invented colour.
    const data = px([255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 0]);
    assert(dominantColour(data) === null, 'nothing to sample');
    assert(dominantColour(px()) === null, 'and an empty image is null too');
});

test('contrastRatio and relativeLuminance agree with the known anchors', () => {
    // The two ends of the scale, which every other measurement in this app is calibrated against.
    assert(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-9, 'white is 1');
    assert(Math.abs(relativeLuminance([0, 0, 0]) - 0) < 1e-9, 'black is 0');
    assert(Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 1e-9, 'black on white is 21:1');
    assert(Math.abs(contrastRatio([120, 120, 120], [120, 120, 120]) - 1) < 1e-9, 'a colour on itself is 1:1');
});

test('darkenUntilContrast: a bright colour is darkened until the gold passes', () => {
    const gold = [244, 208, 111];
    // A bright yellow logo: gold on it is unreadable, so it must come down a long way.
    const bright = [250, 220, 60];
    assert(contrastRatio(bright, gold) < 4.5, 'the premise - it starts failing');
    const fixed = darkenUntilContrast(bright, gold, 4.5);
    assert(fixed.passed, 'it got there');
    assert(contrastRatio(fixed.rgb, gold) >= 4.5, 'and the result really measures: ' + contrastRatio(fixed.rgb, gold).toFixed(2));
    assert(fixed.steps > 0, 'it had to move');
    // Darkening only scales down - it never invents a hue the logo did not have.
    assert(fixed.rgb[0] <= bright[0] && fixed.rgb[1] <= bright[1] && fixed.rgb[2] <= bright[2], 'no channel went up');
});

test('darkenUntilContrast: a colour that already passes is left alone', () => {
    const gold = [244, 208, 111];
    const navy = [22, 41, 74];
    assert(contrastRatio(navy, gold) >= 4.5, 'the premise - it already passes');
    const fixed = darkenUntilContrast(navy, gold, 4.5);
    assert(fixed.steps === 0, 'no darkening needed');
    assert(fixed.rgb[0] === 22 && fixed.rgb[1] === 41 && fixed.rgb[2] === 74, 'untouched: ' + fixed.rgb);
});

test('darkenUntilContrast: an impossible floor reports failure rather than lying', () => {
    // Nothing can reach 21:1 against mid-grey, not even black. The caller leaves that flag undyed.
    const impossible = darkenUntilContrast([200, 30, 40], [120, 120, 120], 21);
    assert(impossible.passed === false, 'it says so');
    assert(darkenUntilContrast(null, [0, 0, 0], 4.5) === null, 'and no sample is null, not a crash');
});

test('parseCssColour and toCssRgb round-trip the forms the sheet actually produces', () => {
    assert(parseCssColour('#f4d06f').join() === '244,208,111', 'six-digit hex');
    assert(parseCssColour('#abc').join() === '170,187,204', 'three-digit hex');
    assert(parseCssColour('rgb(12, 34, 56)').join() === '12,34,56', 'rgb()');
    assert(parseCssColour('rgba(12, 34, 56, 0.5)').join() === '12,34,56', 'rgba() drops the alpha');
    assert(parseCssColour('nonsense') === null, 'and anything else is null');
    assert(toCssRgb([1, 2, 3]) === 'rgb(1, 2, 3)', 'and back out again');
});


// item 2: PERIOD -> DATE off the pro schedule, and item 3's promise that the chip's figure IS the chart's. Both pure, both hand-computed. ---------------------------------------------------------------------------

test('datesByScoringPeriod: a period takes its EARLIEST game', () => {
    // Two games on period 5, one of them a late finish. The earlier one is the day.
    const sched = { settings: { proTeams: [
        { id: 1, proGamesByScoringPeriod: { 5: [{ id: 'a', scoringPeriodId: 5, date: 1600000200000 }] } },
        { id: 2, proGamesByScoringPeriod: { 5: [{ id: 'b', scoringPeriodId: 5, date: 1600000000000 }],
                                            6: [{ id: 'c', scoringPeriodId: 6, date: 1600086400000 }] } }
    ] } };
    const map = datesByScoringPeriod(sched);
    assertEq(map.get(5), 1600000000000, 'the earlier of the two');
    assertEq(map.get(6), 1600086400000, 'and the next day');
    assertEq(map.size, 2, 'nothing invented');
});

test('datesByScoringPeriod: a dateless or shapeless schedule yields an empty map', () => {
    // The chips fall back to Day N on an empty map, which is the never-guess rule.
    assertEq(datesByScoringPeriod(null).size, 0, 'null');
    assertEq(datesByScoringPeriod({}).size, 0, 'shapeless');
    assertEq(datesByScoringPeriod({ settings: { proTeams: [
        { id: 1, proGamesByScoringPeriod: { 5: [{ id: 'a', scoringPeriodId: 5 }] } }
    ] } }).size, 0, 'a game with no date contributes nothing');
});

test('the chip figure IS the chart value: one cumulative series, not two', () => {
    // item 3 says the chip shows the same number the chart plots. Both call aggregateDailyCumulative over the same days, so this asserts the property the strip relies on: the value at each day is the running total of that stat through it. Hand-computed on HR (stat 5): 1, then 1+0, then 1+0+2.
    const daily = {
        10: { games: 1, sums: { '5': 1 } },
        11: { games: 1, sums: { '5': 0 } },
        12: { games: 1, sums: { '5': 2 } }
    };
    const series = aggregateDailyCumulative(daily, [10, 11, 12], 'flb');
    assertEq(series[0].totals['5'], 1, 'day one');
    assertEq(series[1].totals['5'], 1, 'day two adds nothing');
    assertEq(series[2].totals['5'], 3, 'day three carries the running total');
    // An off day still holds the running total rather than dropping to zero, which is what lets a dashed chip sit in the strip without breaking the line the chart draws.
    const withGap = aggregateDailyCumulative(
        { 10: { games: 1, sums: { '5': 1 } }, 11: { games: 0, sums: {} } }, [10, 11], 'flb');
    assertEq(withGap[1].totals['5'], 1, 'the gap holds the total');
    assertEq(withGap[1].played, false, 'and still reports itself unplayed');
});



// ==== player-id-map.js - matching an ESPN player to an external one ====

test('normalizeName: accents and punctuation go, the person stays', () => {
    assertEq(normalizeName('Nazem Kadri'), 'nazem kadri', 'a plain name');
    assertEq(normalizeName('Timothy Liljegren'), 'timothy liljegren', 'already plain');
    // The axis that actually differs between two sources spelling one name.
    assertEq(normalizeName('Tomas Hertl'), normalizeName('Tomáš Hertl'), 'accents are the same player');
    assertEq(normalizeName("Ryan O'Reilly"), 'ryan oreilly', 'the apostrophe goes');
    assertEq(normalizeName('Pierre-Luc Dubois'), 'pierreluc dubois', 'the hyphen goes');
    assertEq(normalizeName('P.O Joseph'), 'po joseph', 'initials with stops');
    // Suffixes at the END only. A surname is not a suffix because it looks like one.
    assertEq(normalizeName('Ken Griffey Jr.'), 'ken griffey', 'a generational suffix goes');
    assertEq(normalizeName('Vladimir Guerrero Jr'), 'vladimir guerrero', 'with or without the stop');
    assertEq(normalizeName('Michael Iii Smith'), 'michael iii smith', 'not in the middle of a name');
    assertEq(normalizeName('  Jack   Eichel  '), 'jack eichel', 'whitespace collapses');
    assertEq(normalizeName(null), '', 'nothing normalizes to nothing');
    // AND THE AXIS IT DELIBERATELY DOES NOT TOUCH: a nickname is a different string, so it MISSES. That is the safe failure and the variant tier's whole reason for existing.
    assert(normalizeName('Johnny Beecher') !== normalizeName('John Beecher'), 'nicknames do not collapse here');
});

test('nameVariantKey: last name plus first initial', () => {
    assertEq(nameVariantKey('Johnny Beecher'), 'beecher j', 'the nickname case');
    assertEq(nameVariantKey('John Beecher'), 'beecher j', 'and its long form agree');
    assertEq(nameVariantKey('Alexander Wennberg'), nameVariantKey('Alex Wennberg'), 'Alex and Alexander');
    assertEq(nameVariantKey('Gabriel Perreault'), nameVariantKey('Gabe Perreault'), 'Gabe and Gabriel');
    assertEq(nameVariantKey('Eichel'), '', 'one word is not a variant key');
});

test('clubOf: the club table, and the ids a table earns its keep on', () => {
    // The three ESPN never renumbered, which is the reason this is a table and not arithmetic.
    assertEq(clubOf('fhl', 37), 'VGK', 'Vegas is 37, not 24');
    assertEq(clubOf('fhl', 124292), 'SEA', 'Seattle is a five-digit id');
    assertEq(clubOf('fhl', 129764), 'UTA', 'and Utah a six-digit one');
    // The rows where ESPN's own abbrev would have joined to nothing.
    assertEq(clubOf('fhl', 10), 'MTL', 'ESPN says Mon');
    assertEq(clubOf('fhl', 8), 'LAK', 'ESPN says LA');
    assertEq(clubOf('fhl', 11), 'NJD', 'ESPN says NJ');
    assertEq(clubOf('fhl', 18), 'SJS', 'ESPN says SJ');
    assertEq(clubOf('fhl', 20), 'TBL', 'ESPN says TB');
    // Free agency is not a club anywhere but ESPN.
    assertEq(clubOf('fhl', 0), null, 'proTeamId 0 has no external club');
    assertEq(clubOf('fhl', 999), null, 'an id the table does not carry');
    assertEq(clubOf('flb', 10), null, 'baseball is deliberately empty until the terms check');
    // 32 clubs, no more and no fewer - a row added by accident is caught here.
    assertEq(Object.keys(PROTEAM_CLUB_MAP.fhl).length, 32, 'every NHL club, once');
    const codes = Object.values(PROTEAM_CLUB_MAP.fhl).map(r => r.nhlTriCode);
    assertEq(new Set(codes).size, 32, 'and no triCode claimed twice');
});

// A small external side, hand-built to exercise every tier. Ids are NHL-shaped but invented.
const EXT = [
    { id: 8471675, fullName: 'Sidney Crosby', club: 'PIT', jersey: '87' },
    { id: 8478402, fullName: 'Connor McDavid', club: 'EDM', jersey: '97' },
    { id: 8477220, fullName: 'Tomáš Hertl', club: 'VGK', jersey: '48' },      // accent on one side only
    { id: 8480871, fullName: 'John Beecher', club: 'BOS', jersey: '19' },      // ESPN says Johnny
    { id: 8475158, fullName: 'Nazem Kadri', club: 'CGY', jersey: '91' },       // will arrive club-less
    { id: 8470000, fullName: 'Will Smith', club: 'SJS', jersey: '2' },         // two of this name
    { id: 8470001, fullName: 'Will Smith', club: 'TOR', jersey: '9' },
    { id: 8470002, fullName: 'Alex Newhook', club: 'MTL', jersey: '15' },
    { id: 8470003, fullName: 'Alex Newhook', club: 'MTL', jersey: '48' }       // same name AND club
];

test('matchPlayers: the ladder, tier by tier', () => {
    const espn = [
        { id: 101, fullName: 'Sidney Crosby', proTeamId: 16, jersey: '87' },   // Pit -> PIT
        { id: 102, fullName: 'Tomas Hertl', proTeamId: 37, jersey: '48' },     // accent differs
        { id: 103, fullName: 'Johnny Beecher', proTeamId: 1, jersey: '19' },   // nickname -> variant
        { id: 104, fullName: 'Nazem Kadri', proTeamId: 0, jersey: '91' },      // FA -> unique name
        { id: 105, fullName: 'Will Smith', proTeamId: 18, jersey: '2' },       // name dup, club splits
        { id: 106, fullName: 'Alex Newhook', proTeamId: 10, jersey: '15' },    // name+club dup -> jersey
        { id: 107, fullName: 'Connor McDavid', proTeamId: 6, jersey: '97' }
    ];
    const r = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: EXT });
    const tier = Object.fromEntries(r.matched.map(m => [m.espnId, m.tier]));
    const to = Object.fromEntries(r.matched.map(m => [m.espnId, m.externalId]));

    assertEq(tier[101], 'name+club', 'the ordinary case');
    assertEq(to[101], 8471675, 'and it is the right player');
    assertEq(tier[102], 'name+club', 'an accent is not a difference');
    assertEq(to[102], 8477220, 'Hertl matched through the accent');
    // Club splits a name two players share - which is exactly what the club join is for.
    assertEq(tier[105], 'name+club', 'two Will Smiths, and the club decides');
    assertEq(to[105], 8470000, 'the San Jose one');
    // Same name AND same club: only the jersey can separate them.
    assertEq(tier[106], 'jersey', 'a jersey breaks what the club could not');
    assertEq(to[106], 8470002, 'the one wearing 15');
    // No club to join on, so the name has to be unique in the whole league.
    assertEq(tier[104], 'unique-name', 'a free agent has no club');
    assertEq(to[104], 8475158, 'and the name is unique');
    // The nickname, recovered last and only because the club agrees.
    assertEq(tier[103], 'variant', 'Johnny is John');
    assertEq(to[103], 8480871, 'the Boston one');
    assertEq(r.unmatched.length, 0, 'everyone placed');

    const s = matchSummary(r);
    assertEq(s.matched, 7, 'seven matched');
    assertEq(s.byTier['name+club'], 4, 'four on the ordinary tier');
    assertEq(s.byTier.jersey, 1, 'one on the jersey tier');
    assertEq(s.byTier['unique-name'], 1, 'one league-wide');
    assertEq(s.byTier.variant, 1, 'one variant');
    assertEq(s.rate, 1, 'a clean run');
});

test('matchPlayers: it REFUSES rather than guessing, and says why', () => {
    const espn = [
        // Same name and club as two external players, and a jersey that matches neither.
        { id: 201, fullName: 'Alex Newhook', proTeamId: 10, jersey: '77' },
        // Same again, with no jersey at all to break it.
        { id: 202, fullName: 'Alex Newhook', proTeamId: 10, jersey: '' },
        // A free agent whose name is not unique on the external side.
        { id: 203, fullName: 'Will Smith', proTeamId: 0, jersey: '2' },
        // Not there at all.
        { id: 204, fullName: 'Nobody Atall', proTeamId: 16, jersey: '3' }
    ];
    const r = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: EXT });
    assertEq(r.matched.length, 0, 'nothing guessed');
    assertEq(r.unmatched.length, 4, 'all four refused');
    const why = Object.fromEntries(r.unmatched.map(u => [u.espnId, u.reason]));
    assert(why[201].includes('jersey 77 does not single one out'), 'the jersey disagreed');
    assert(why[202].includes('no jersey'), 'and here there was none to try');
    assert(why[203].includes('not unique league-wide'), 'a club-less duplicate name');
    assert(why[204].includes('no external player matches'), 'and one who is absent');
});

test('matchPlayers: two ESPN players sharing a name and club claim NOBODY', () => {
    // The failure the external-side check alone would miss. One external Crosby, two ESPN entries here: if only the external side were checked for uniqueness, BOTH would match and one player's season would be served under two ids.
    const espn = [
        { id: 301, fullName: 'Sidney Crosby', proTeamId: 16, jersey: '87' },
        { id: 302, fullName: 'Sidney Crosby', proTeamId: 16, jersey: '87' }
    ];
    const r = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: EXT });
    assertEq(r.matched.length, 0, 'neither claimed the player');
    assertEq(r.unmatched.length, 2, 'both went to the list a human reads');
});

test('matchPlayers: the Agozzino double-entry, which is one player under two ESPN ids', () => {
    // MEASURED in the real 2026 hockey pool: ids 5393 and 2486992, both "Andrew Agozzino", both on Utah (129764), both jersey 36, both position 2. Name, club and jersey all agree, so no tier can separate them - and they must not both match, nor be reported as two mysterious misses every single run.
    const espn = [
        { id: 5393, fullName: 'Andrew Agozzino', proTeamId: 129764, jersey: '36' },
        { id: 2486992, fullName: 'Andrew Agozzino', proTeamId: 129764, jersey: '36' }
    ];
    const ext = [{ id: 8476470, fullName: 'Andrew Agozzino', club: 'UTA', jersey: '36' }];
    const bare = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: ext, dead: {} });
    assertEq(bare.matched.length, 0, 'without the table, neither is matched');
    assertEq(bare.unmatched.length, 2, 'and both look like failures');

    // With the shipped table both are set aside as entries rather than players, and the crosswalk decides which id the pool actually serves.
    assertEq(Object.keys(DEAD_ENTRIES.fhl).length, 2, 'both halves are recorded');
    const known = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: ext });
    assertEq(known.matched.length, 0, 'still nothing guessed');
    assertEq(known.unmatched.length, 0, 'but neither is reported as a miss');
    assertEq(known.dropped.length, 2, 'they are dropped, with a reason each');
    assert(known.dropped[0].reason.includes('two ids'), 'and the reason says what they are');
    assertEq(matchSummary(known).total, 0, 'so they are out of the match rate entirely');

    // A crosswalk row outranks the dead list, which is how the surviving id gets its data.
    const fixed = matchPlayers({
        sport: 'fhl', espnPlayers: espn, externalPlayers: ext, crosswalk: { 2486992: 8476470 }
    });
    assertEq(fixed.matched.length, 1, 'the live id matches');
    assertEq(fixed.matched[0].tier, 'crosswalk', 'through the crosswalk');
    assertEq(fixed.dropped.length, 1, 'and only the stale twin is dropped');
});

test('matchPlayers: the two Elias Petterssons, which no tier can separate', () => {
    // MEASURED in the real pool and the real NHL reports: a forward and a defenceman, same name, same club. The NHL's bulk reports carry no sweater number, so the jersey tier has nothing to work with - which makes this the exact shape that survives every automatic tier.
    const espn = [
        { id: 501, fullName: 'Elias Pettersson', proTeamId: 22, jersey: '40' },
        { id: 502, fullName: 'Elias N. Pettersson', proTeamId: 22, jersey: '25' }
    ];
    const ext = [
        { id: 8480012, fullName: 'Elias Pettersson', club: 'VAN', jersey: null },
        { id: 8483678, fullName: 'Elias Pettersson', club: 'VAN', jersey: null }
    ];
    const r = matchPlayers({ sport: 'fhl', espnPlayers: espn, externalPlayers: ext });
    assertEq(r.matched.length, 0, 'neither is guessed at');
    assertEq(r.unmatched.length, 2, 'and both are reported');
    // ESPN's own disambiguation does not survive normalization against the NHL side, so the second one fails for a DIFFERENT reason than the first, and the report says so.
    const why = Object.fromEntries(r.unmatched.map(u => [u.espnId, u.reason]));
    assert(why[501].includes('2 external players share this name on VAN'), 'the ambiguous one');
    assert(why[502].includes('no external player matches'), 'and the renamed one matches nothing');

    // An override is the only thing that can settle it, and it settles exactly one of them.
    const fixed = matchPlayers({
        sport: 'fhl', espnPlayers: espn, externalPlayers: ext, overrides: { 501: 8480012 }
    });
    assertEq(fixed.matched.length, 1, 'the hand row places one');
    assertEq(fixed.matched[0].externalId, 8480012, 'the one it names');
    assertEq(fixed.unmatched.length, 1, 'and the other still refuses');
});

test('matchPlayers: crosswalk and overrides outrank every name tier', () => {
    const espn = [{ id: 401, fullName: 'Somebody Else Entirely', proTeamId: 16, jersey: '87' }];
    // A name that matches nothing still matches, because a human or a compile step said so.
    const viaCross = matchPlayers({
        sport: 'fhl', espnPlayers: espn, externalPlayers: EXT, crosswalk: { 401: 8471675 }
    });
    assertEq(viaCross.matched[0].tier, 'crosswalk', 'the compiled table wins');
    assertEq(viaCross.matched[0].externalId, 8471675, 'and points where it says');

    const viaOverride = matchPlayers({
        sport: 'fhl', espnPlayers: espn, externalPlayers: EXT, overrides: { 401: 8478402 }
    });
    assertEq(viaOverride.matched[0].tier, 'override', 'a hand row wins too');

    // And the crosswalk outranks the override, because it is the one that was compiled from data.
    const both = matchPlayers({
        sport: 'fhl', espnPlayers: espn, externalPlayers: EXT,
        crosswalk: { 401: 8471675 }, overrides: { 401: 8478402 }
    });
    assertEq(both.matched[0].externalId, 8471675, 'compiled beats hand-written');
});

test('matchPlayers: nothing in, nothing out - and no throw', () => {
    assertEq(matchPlayers({}).matched.length, 0, 'no arguments at all');
    assertEq(matchPlayers({ sport: 'fhl', espnPlayers: [], externalPlayers: [] }).unmatched.length, 0, 'two empty lists');
    assertEq(matchSummary(null).rate, 0, 'a summary of nothing');
    assertEq(matchSummary({ matched: [], unmatched: [] }).rate, 0, 'and of an empty run');
});


// ==== stat-crosswalk.js - an ESPN category read off an external stat line ====

// A real-SHAPED skater row: the field names are the NHL's own, taken from the captured summary report, and the numbers satisfy the identities the table is validated against.
const SKATER = {
    playerId: 8478402, skaterFullName: 'A Skater', teamAbbrevs: 'EDM',
    goals: 30, assists: 70, points: 100, plusMinus: 12, penaltyMinutes: 24,
    ppGoals: 8, ppPoints: 38, shGoals: 2, shPoints: 5, gameWinningGoals: 6, shots: 210,
    evGoals: 20, evPoints: 57
};
const REALTIME = { playerId: 8478402, hits: 44, blockedShots: 31 };
const FACEOFFS = { playerId: 8478402, totalFaceoffWins: 611, totalFaceoffLosses: 559 };
const GOALIE = {
    playerId: 8471679, goalieFullName: 'A Goalie', teamAbbrevs: 'TBL',
    gamesStarted: 55, wins: 32, losses: 18, otLosses: 4, shutouts: 3,
    // Chosen so both derivations come out exact rather than nearly: 55 games of 60 minutes is 198000 seconds, 132 goals against is a 2.40 GAA, and 1188 of 1320 is a.900 save percentage. A fixture whose arithmetic does not close is a fixture that hides a bug.
    saves: 1188, shotsAgainst: 1320, goalsAgainst: 132, timeOnIce: 198000
};

test('externalValue: the straight reads, on the report that carries them', () => {
    assertEq(externalValue(SKATER, 'fhl', 13), 30, 'goals');
    assertEq(externalValue(SKATER, 'fhl', 14), 70, 'assists');
    assertEq(externalValue(SKATER, 'fhl', 16), 100, 'points');
    // The identity this table is validated by, on the row itself.
    assertEq(externalValue(SKATER, 'fhl', 13) + externalValue(SKATER, 'fhl', 14),
        externalValue(SKATER, 'fhl', 16), 'G + A == PTS');
    assertEq(externalValue(SKATER, 'fhl', 29), 210, 'shots on goal');
    assertEq(externalValue(SKATER, 'fhl', 38), 38, 'power-play points');
    assertEq(externalValue(REALTIME, 'fhl', 31), 44, 'hits, from the realtime report');
    assertEq(externalValue(REALTIME, 'fhl', 32), 31, 'blocks, same report');
    // The casing the plan predicted wrong and the capture corrected.
    assertEq(externalValue(FACEOFFS, 'fhl', 23), 611, 'faceoff wins, lowercase o');
    assertEq(externalValue(FACEOFFS, 'fhl', 24), 559, 'and losses');
    assertEq(externalValue(GOALIE, 'fhl', 1), 32, 'wins');
    assertEq(externalValue(GOALIE, 'fhl', 6), 1188, 'saves');
    assertEq(externalValue(GOALIE, 'fhl', 8), 198000, 'time on ice, in seconds');
    // The identity that does NOT hold on 18 of 103 real goalies holds on this fixture, so a failure here is arithmetic rather than shootout accounting.
    assertEq(externalValue(GOALIE, 'fhl', 3) - externalValue(GOALIE, 'fhl', 4),
        externalValue(GOALIE, 'fhl', 6), 'SA - GA == SV, on a clean row');
});

test('externalValue: PPA and SHA are SUBTRACTED, because no source carries them', () => {
    // A power-play point is a power-play goal or a power-play assist and nothing else.
    assertEq(externalValue(SKATER, 'fhl', 19), 30, 'PPA = ppPoints 38 - ppGoals 8');
    assertEq(externalValue(SKATER, 'fhl', 21), 3, 'SHA = shPoints 5 - shGoals 2');
    // And the subtraction is only as good as both halves being present.
    assertEq(externalValue({ ppPoints: 38 }, 'fhl', 19), null, 'one half is not enough');
    assertEq(externalValue({ ppGoals: 8 }, 'fhl', 19), null, 'nor the other');
});

test('externalValue: NULL, never zero, for anything it cannot answer', () => {
    // Zero is a claim. In an inverse category zero is the BEST figure, so a fabricated zero does not lose information, it hands out a win nobody earned.
    assertEq(externalValue(SKATER, 'fhl', 28), null, 'hat tricks are unmapped');
    assertEq(externalValue(SKATER, 'fhl', 999), null, 'an id nothing maps');
    assertEq(externalValue(SKATER, 'fhl', 31), null, 'a field this row does not carry');
    assertEq(externalValue(null, 'fhl', 13), null, 'no row at all');
    assertEq(externalValue({ goals: 'thirty' }, 'fhl', 13), null, 'a value that is not a number');
    assertEq(externalValue({ goals: null }, 'fhl', 13), null, 'an explicit null');
    assertEq(externalValue(SKATER, 'flb', 5), null, 'baseball is empty until the terms check');
    // A real zero still reads as zero - the rule is about ABSENCE, not about the number.
    assertEq(externalValue({ goals: 0 }, 'fhl', 13), 0, 'a genuine none is a none');
});

test('externalValue: a rate is never read from the source', () => {
    // 10 and 11 are in the table, but as components. Asking for the rate itself gets nothing, because RATE_COMPONENTS is the one place that arithmetic lives.
    assertEq(externalValue(GOALIE, 'fhl', 10), null, 'GAA is not read');
    assertEq(externalValue(GOALIE, 'fhl', 11), null, 'nor save percentage');
});

test('externalLine: a stat line the rank engine can eat, components and all', () => {
    // Ask for a rate and the COMPONENTS arrive, which is what the derivation downstream needs.
    const line = externalLine(GOALIE, 'fhl', ['1', '6', '3', '10', '11', '28']);
    assertEq(line['1'], 32, 'wins');
    assertEq(line['6'], 1188, 'saves');
    assertEq(line['3'], 1320, 'shots against');
    assertEq(line['4'], 132, 'goals against arrived for GAA');
    assertEq(line['8'], 198000, 'and the time on ice it divides by');
    assertEq(line['10'], undefined, 'the rate itself is not written');
    assertEq(line['11'], undefined, 'nor the other one');
    assertEq(line['28'], undefined, 'and an unmapped category leaves no key');
    // The components are exactly what the app's own formulas want: GA * 3600 / TOI, and SV / SA.
    assertClose(line['4'] * 3600 / line['8'], 2.4, 'GAA recomputes from the components');
    assertClose(line['6'] / line['3'], 0.9, 'and save percentage');
});

test('reportsFor: how many requests a league actually needs', () => {
    // The reference hockey league's own scored ids. Three separate reports, which is the point of naming the report on every row - nobody should discover this by getting undefined columns.
    const cats = ['38', '7', '39', '11', '13', '14', '16', '10', '23', '28', '29', '31', '32', '1'];
    const r = reportsFor('fhl', cats);
    assertEq(r.reports, ['goalieSummary', 'skaterFaceoffs', 'skaterRealtime', 'skaterSummary'],
        'four reports for fourteen categories');
    assertEq(r.unmapped, ['28'], 'and hat tricks cannot be covered at all');
    assert(UNMAPPED_CATEGORIES.fhl[28].includes('game log'), 'the reason says what it would take');

    // A points-only league needs one report.
    assertEq(reportsFor('fhl', ['13', '14', '16']).reports, ['skaterSummary'], 'one is enough here');
    // A rate pulls in whatever its components need, not itself.
    assertEq(reportsFor('fhl', ['10']).reports, ['goalieSummary'], 'GAA needs the goalie report');
    assertEq(reportsFor('fhl', []).reports, [], 'no categories, no requests');
    assertEq(reportsFor('flb', ['5']).unmapped, ['5'], 'baseball maps nothing yet');
});

test('EXTERNAL_STAT_FIELDS: every row names a report or its components', () => {
    // A row with neither would be a field nobody can fetch - the kind of entry that looks complete and is not.
    Object.entries(EXTERNAL_STAT_FIELDS.fhl).forEach(([id, spec]) => {
        assert(spec.components || spec.report, `id ${id} names where it comes from`);
        assert(spec.components || spec.field || spec.derive, `id ${id} names what to read`);
        if (spec.report) assert(NHL_REPORTS[spec.report], `id ${id} names a real report`);
        if (spec.derive) assertEq(spec.derive.length, 2, `id ${id} subtracts exactly two fields`);
    });
    // And nothing is claimed for both sports at once by accident.
    assertEq(Object.keys(EXTERNAL_STAT_FIELDS.flb).length, 0, 'baseball is empty on purpose');
});


// ==== retro-basis.js - a past season through the unchanged rank engine ====

// The sport's real rate formulas, passed in the way every pure engine here takes its tables.
const FLB_RATES = [
    { out: '2', num: ['1'], den: ['0'] },                    // AVG = H/AB
    { out: '47', num: ['45'], den: ['34'], scale: 27 }       // ERA = ER*9/IP, innings recorded as outs
];

test('seasonTotalsFrom: rates are REBUILT from components, never trusted', () => {
    // The source says.400. Its own components say 50 hits in 200 at-bats, which is.250 - and the components are what every other surface in this app sums. The line wins, not the label.
    const line = { '0': 200, '1': 50, '2': 0.4, '5': 30 };
    const t = seasonTotalsFrom(line, { categoryIds: ['2', '5'], rateSpecs: FLB_RATES });
    assertEq(t['2'], 0.25, 'the average is recomputed from hits over at-bats');
    assertEq(t['5'], 30, 'and a counting stat passes straight through');
    assertEq(t['0'], 200, 'the components stay, for windowed maths later');

    // ERA from outs, with the scale the validated table carries: 60 earned runs over 540 outs (180 innings) is 60 * 27 / 540 = 3.00.
    const arm = seasonTotalsFrom({ '34': 540, '45': 60, '47': 9.99 },
        { categoryIds: ['47'], rateSpecs: FLB_RATES });
    assertEq(arm['47'], 3, 'ERA rebuilt from earned runs and outs');

    // A rate with no denominator is ABSENT, not zero. A pitcher who threw nothing has no ERA, and in an inverse category a zero would be the best figure in the league.
    const none = seasonTotalsFrom({ '34': 0, '45': 0 }, { categoryIds: ['47'], rateSpecs: FLB_RATES });
    assertEq(none['47'], undefined, 'no innings, no earned run average');
    assertEq(seasonTotalsFrom(null, {}), null, 'no line at all');
    // Non-numeric junk is dropped rather than coerced.
    assertEq(seasonTotalsFrom({ '5': 'lots' }, {})['5'], undefined, 'a word is not a total');
});

test('carriesAny: absence is the question, not zero', () => {
    assert(carriesAny({ '5': 0 }, ['5']), 'a real zero IS evidence of play');
    assert(!carriesAny({ '5': 0 }, ['48']), 'a category with no key is not');
    assert(carriesAny({ '5': 12, '20': 40 }, ['48', '20']), 'any one of them is enough');
    assert(!carriesAny({}, ['5']), 'an empty line carries nothing');
    assert(!carriesAny({ '5': 1 }, []), 'and no categories is not a match');
});

// A four-player season: a batter, a pitcher, a two-way player, and a batter with nothing scored.
const POOL = [
    { id: 1, name: 'A Batter', defaultPositionId: 4, eligibleSlots: [2, 12, 16],
      line: { '0': 500, '1': 150, '5': 30, '81': 150 } },
    { id: 2, name: 'A Pitcher', defaultPositionId: 1, eligibleSlots: [13, 14, 16],
      line: { '34': 540, '45': 60, '48': 200, '32': 31 } },
    { id: 3, name: 'A Two-Way Player', defaultPositionId: 10, eligibleSlots: [11, 12, 13, 14, 16],
      line: { '0': 480, '1': 144, '5': 44, '81': 140, '34': 300, '45': 40, '48': 130, '32': 20 } },
    { id: 4, name: 'A Bystander', defaultPositionId: 4, eligibleSlots: [2, 16],
      line: { '67': 90 } },
    // THE CASE THE REAL POOL EXPOSED. A pitcher's line genuinely carries batting keys - pitchers bat, or the source records a zero for it - so a figures-only test would put them in the batting group as well and call them two-way. A pitcher is eligible at no batting slot, and that is what keeps them out. Measured: without this gate all 102 goalies in the 2025 hockey pool landed in the skater group.
    { id: 5, name: 'A Pitcher Who Bats', defaultPositionId: 1, eligibleSlots: [13, 15, 16],
      line: { '0': 4, '1': 0, '5': 0, '32': 40, '34': 210, '45': 30, '48': 90 } }
];
const BASIS_OPTS = {
    seasonId: 2023,
    categoryIds: ['5', '2', '48', '47'],
    secondaryStatIds: new Set(['48', '47']),
    secondarySlots: new Set([13, 14, 15]),   // P, SP, RP
    nonStartingSlots: new Set([16, 17]),     // bench and injury: everyone is eligible for these
    rateSpecs: FLB_RATES,
    gamesIds: { primary: '81', secondary: '32' }
};

test('retroBasis: groups by what a player CARRIES, not by where they are eligible', () => {
    const b = retroBasis(POOL, BASIS_OPTS);
    assertEq(b.groups.primary.map(p => p.id), [1, 3], 'the batter and the two-way player');
    assertEq(b.groups.secondary.map(p => p.id), [2, 3, 5], 'the arms');
    assertEq(b.categoryIds.primary, ['5', '2'], 'the batting categories');
    assertEq(b.categoryIds.secondary, ['48', '47'], 'and the pitching ones');

    // THE TWO-WAY RULING, carried: the player is in both lists, so both skills can be measured against the peers they belong to. Leaving them out of one zeroes half the player.
    assertEq(b.twoWay, [3], 'one player in both groups');
    // And the pitcher who bats is NOT one, being eligible at no batting slot - even though that line carries at-bats and a home-run key.
    assert(!b.groups.primary.some(p => p.id === 5), 'a batting line is not a batting role');

    // The trap this catches: player 3 is ELIGIBLE at pitching slots and so is player 1's neighbour - but eligibility is not evidence. Player 4 is eligible at a batting slot and carries not one scored category, so the row is skipped WITH A REASON rather than ranked last.
    assertEq(b.skipped.length, 1, 'one player placed nowhere');
    assertEq(b.skipped[0].id, 4, 'the bystander');
    assert(b.skipped[0].reason.includes('none of the league'), 'and the reason says why');
});

test('retroBasis: the games count comes from each group\'s OWN id', () => {
    const b = retroBasis(POOL, BASIS_OPTS);
    const bat = b.groups.primary.find(p => p.id === 3);
    const arm = b.groups.secondary.find(p => p.id === 3);
    // The same player, counted the way each group counts. Reading one id for both would give a two-way player a pitcher's appearances as a batting workload.
    assertEq(bat.games, 140, 'games played, as a batter');
    assertEq(arm.games, 20, 'appearances, as a pitcher');
    assertEq(b.groups.primary.find(p => p.id === 1).games, 150, 'and the plain batter');
});

test('retroBasis: eligibility is THAT season\'s, and travels with the player', () => {
    const b = retroBasis(POOL, BASIS_OPTS);
    // Straight from the historical pool, never from a current one - the quiet trap, because nothing on screen would reveal a 2023 season ranked inside 2026's slot map.
    assertEq(b.groups.primary.find(p => p.id === 1).eligibleSlots, [2, 12, 16], 'carried untouched');
    assertEq(eligibleAt(b.groups.primary, 2).map(p => p.id), [1], 'one player at slot 2 that season');
    assertEq(eligibleAt(b.groups.primary, 12).map(p => p.id), [1, 3], 'two at the utility slot');
    assertEq(eligibleAt(b.groups.secondary, 14).map(p => p.id), [2, 3], 'and two starters');
    assertEq(eligibleAt(b.groups.secondary, 15).map(p => p.id), [5], 'one reliever');
    assertEq(eligibleAt(b.groups.primary, 99).length, 0, 'a slot nobody held');
    assertEq(eligibleAt(null, 2).length, 0, 'no group at all');
});

test('retroBasis: rates reach the basis already rebuilt', () => {
    const b = retroBasis(POOL, BASIS_OPTS);
    // 150 of 500 is.300; 60 earned runs over 540 outs is a 3.00 earned-run average.
    assertEq(b.groups.primary.find(p => p.id === 1).seasonTotals['2'], 0.3, 'the batting average');
    assertEq(b.groups.secondary.find(p => p.id === 2).seasonTotals['47'], 3, 'and the ERA');
    assertEq(retroBasis([], BASIS_OPTS).groups.primary.length, 0, 'an empty season');
    assertEq(retroBasis(null, BASIS_OPTS).skipped.length, 0, 'and no season at all');
});

// A hand-built stand-in for computeRotoRanks' return, so the row builder is tested on arithmetic rather than on the rank engine's own behaviour.
function fakeResult(pairs, byCat) {
    return {
        scores: new Map(pairs),
        ranked: pairs.map(([id]) => ({ id })),
        byCategory: new Map(Object.entries(byCat || {}).map(([id, m]) => [Number(id), new Map(Object.entries(m))]))
    };
}

test('seasonRowFrom: competition ranks, so a tie reads as a tie', () => {
    // Four scores, two of them identical. By sort order they are 1st, 2nd, 3rd, 4th; by the app's own rule the two equal ones are BOTH second and nobody is third.
    const r = fakeResult([[10, 90], [11, 80], [12, 80], [13, 70]], { 10: { '5': 99.1, '2': 88.0 } });
    const first = seasonRowFrom(r, 10, { seasonId: 2023, games: 150 });
    assertEq(first.rank, 1, 'the best score is first');
    assertEq(first.total, 4, 'of four ranked');
    assertEq(first.tied, false, 'and alone there');
    assertEq(first.percentiles, { '5': 99.1, '2': 88.0 }, 'the percentiles come across');
    assertEq(first.games, 150, 'and the games');
    assertEq(first.seasonId, 2023, 'and the season');

    const tiedA = seasonRowFrom(r, 11, { seasonId: 2023, games: 140 });
    const tiedB = seasonRowFrom(r, 12, { seasonId: 2023, games: 130 });
    assertEq(tiedA.rank, 2, 'the tie is second');
    assertEq(tiedB.rank, 2, 'both of them');
    assertEq(tiedA.tied, true, 'and both know it');
    assertEq(tiedB.tied, true, 'so the band can render T2');
    // The rank AFTER a two-way tie is fourth, not third - which is what competition ranking means.
    assertEq(seasonRowFrom(r, 13, { seasonId: 2023, games: 120 }).rank, 4, 'the next player is fourth');
});

test('seasonRowFrom: the three outcomes the contract keeps apart', () => {
    const r = fakeResult([[10, 90]], { 10: { '5': 99.1 } });
    // Ranked.
    assertEq(seasonRowFrom(r, 10, { seasonId: 2023, games: 150 }).rank, 1, 'a standing');
    // In the pool, gated out by playing time: a season, and no standing in it. NOT a rank of last.
    const unranked = { scores: new Map([[10, 90]]), ranked: [{ id: 10 }, { id: 99 }], byCategory: new Map() };
    const row = seasonRowFrom(unranked, 99, { seasonId: 2023, games: 6 });
    assertEq(row.rank, null, 'no rank');
    assertEq(row.percentiles, {}, 'and no percentiles');
    assertEq(row.games, 6, 'but the games are why the row exists');
    assertEq(row.total, 1, 'and the denominator is still the ranked pool');
    // Not in that season at all -> null, so the caller leaves the season OUT rather than inventing a row of zeros for a player who had not debuted.
    assertEq(seasonRowFrom(r, 404, { seasonId: 2023, games: 0 }), null, 'a season that never happened');
    assertEq(seasonRowFrom(null, 10, {}), null, 'and no result at all');
});

test('seasonRowsFor: ascending, and gaps stay gaps', () => {
    const y23 = fakeResult([[10, 90], [11, 50]], { 10: { '5': 99 } });
    const y25 = fakeResult([[10, 70], [11, 60]], { 10: { '5': 80 } });
    const y24 = fakeResult([[11, 55]], {});                      // no play in 2024
    // Deliberately handed over out of order: the contract promises ascending, and a promise nothing enforces is a bug waiting for the first caller who iterates a Map.
    const rows = seasonRowsFor(10, [
        { seasonId: 2025, result: y25, games: 140 },
        { seasonId: 2023, result: y23, games: 150 },
        { seasonId: 2024, result: y24, games: 0 }
    ]);
    assertEq(rows.map(r => r.seasonId), [2023, 2025], 'sorted, and 2024 is not there');
    assertEq(rows.map(r => r.rank), [1, 1], 'best in the pool both years');
    assertEq(rows[0].percentiles['5'], 99, 'and each season keeps its own percentiles');
    assertEq(seasonRowsFor(10, []).length, 0, 'no seasons');
    assertEq(seasonRowsFor(10, null).length, 0, 'no list at all');
});


test('retro-basis end to end: the basis feeds the UNCHANGED rank engine', () => {
    // The point of the whole file. Not a parallel scorer - the same engine the season tab uses, handed a past season's pool, so the two can never disagree about a player.
    const b = retroBasis(POOL, BASIS_OPTS);
    const result = computeRotoRanks(b.groups.primary, {
        sport: 'flb',
        relevantStatIds: b.categoryIds.primary,
        inverseStatIds: new Set(),
        rateStatIds: new Set(['2']),
        isRpPool: false,
        requireMinPlayingTime: true,
        workloadOf: p => p.games,
        thresholdWorkloadOf: p => p.games
    });
    assertEq(result.ranked.length, 2, 'both batters ranked');

    const row = seasonRowFrom(result, 3, { seasonId: 2023, games: 140 });
    assertEq(row.seasonId, 2023, 'the season');
    assertEq(row.total, 2, 'against the pool that season');
    assert(row.rank >= 1 && row.rank <= 2, 'a real standing');
    assertEq(typeof row.tied, 'boolean', 'and whether it is shared');
    // The percentiles that come back are the LEAGUE'S categories and nothing else - the engine was handed this group's ids, so a batting row can never carry a pitching key.
    assertEq(Object.keys(row.percentiles).sort(), ['2', '5'], 'the batting categories, both of them');
    Object.values(row.percentiles).forEach(v =>
        assert(v >= 0 && v <= 100, 'a percentile is a percentile'));
    // 44 home runs against 30 is the better season, and the engine agrees without being told.
    const other = seasonRowFrom(result, 1, { seasonId: 2023, games: 150 });
    assert(row.percentiles['5'] > other.percentiles['5'], 'the bigger power season ranks higher');
});


// ==== utils.js - the week/period pair the roto race's rostered tier depends on ====

test('weekOfPeriod: week w spans first+7(w-1) .. first+7w-1', () => {
    // The ordinary league: every payload in JSON_debug carries firstScoringPeriod 1 (52 of 52).
    assertEq(weekOfPeriod(1, 1), 1, 'the first day is week one');
    assertEq(weekOfPeriod(7, 1), 1, 'and so is the seventh');
    assertEq(weekOfPeriod(8, 1), 2, 'the eighth opens week two');
    assertEq(weekOfPeriod(14, 1), 2, 'which runs to the fourteenth');
    assertEq(weekOfPeriod(15, 1), 3, 'and then week three');
    // A league whose season opens later. This is the case the old helper was accidentally right for, at first between 4 and 10, which is why nobody caught it by trying one league.
    assertEq(weekOfPeriod(11, 11), 1, 'a late first day is still week one');
    assertEq(weekOfPeriod(17, 11), 1, 'seven days of it');
    assertEq(weekOfPeriod(18, 11), 2, 'then week two');
    // Nothing before the first day exists, and it must not come back as week zero or negative.
    assertEq(weekOfPeriod(1, 11), 1, 'a period before the season clamps to week one');
    assertEq(weekOfPeriod(-5, 1), 1, 'and so does nonsense');
});

test('midPeriodOfWeek: the fourth day of the week\'s OWN span', () => {
    assertEq(midPeriodOfWeek(1, 1), 4, 'week one, day four');
    assertEq(midPeriodOfWeek(2, 1), 11, 'week two');
    assertEq(midPeriodOfWeek(3, 1), 18, 'week three');
    // THE REGRESSION THIS PAIR EXISTS FOR. The old helper returned week*7+3 - 10, 17, 24 - each of which is day 3 of the NEXT week, so the roto race read ownership a week late.
    assert(midPeriodOfWeek(1, 1) !== 1 * 7 + 3, 'not the old formula');
    assertEq(weekOfPeriod(1 * 7 + 3, 1), 2, 'and the old formula really did land in week two');
    assertEq(midPeriodOfWeek(1, 11), 14, 'a late-starting league, week one');
    assertEq(midPeriodOfWeek(2, 11), 21, 'and week two');
});

test('the pair are exact inverses - the invariant the drift broke', () => {
    // If this ever fails, the two helpers have been re-anchored independently again, which is precisely the failure that shipped for a month.
    [1, 4, 8, 11, 30].forEach(first => {
        for (let w = 1; w <= 26; w++) {
            assertEq(weekOfPeriod(midPeriodOfWeek(w, first), first), w,
                `week ${w} round-trips with first ${first}`);
        }
    });
});

test('the boundary case: a trade on the week\'s LAST day', () => {
    // Week 2 is periods 8..14 with a first of 1. A trade landing on day 14 must not move the proxy out of week 2 - the whole bug was the proxy sitting past the boundary.
    const first = 1;
    const proxy = midPeriodOfWeek(2, first);
    assertEq(proxy, 11, 'the proxy is mid-week');
    assert(proxy >= 8 && proxy <= 14, 'and inside week two, not past its last day');
    assertEq(weekOfPeriod(14, first), 2, 'day 14 is still week two');
    assertEq(weekOfPeriod(15, first), 3, 'day 15 is not');
    // So a player traded on day 14 is credited to whoever held them on day 11 - the documented mid-week-owner residual, which is coarseness inside the right week. The old proxy read day 17, which is week THREE: a different week's owner entirely.
    assertEq(weekOfPeriod(2 * 7 + 3, first), 3, 'the old proxy read a week-three owner');
    // The first week is the sharpest case, because there is no earlier week to bleed from.
    assert(midPeriodOfWeek(1, first) <= 7, 'week one\'s proxy is inside week one');
});


// ==== schedule-insight.js - playoff density, off nights, two-start weeks ====

// Three clubs over six days, hand-built so every count is countable by eye. club 1: days 1, 2, 4, 5, 6 (five games, none on day 3) club 2: days 1, 3, 5 (three, every other day) club 3: day 6 only (one - the bye case a manager is hunting for) club 0: ESPN's free-agent pseudo-club, which is not a club
const PRO_TEAMS = [
    { id: 0, proGamesByScoringPeriod: { '1': [{ id: 'x' }] } },
    { id: 1, proGamesByScoringPeriod: {
        '1': [{ id: 'a1' }], '2': [{ id: 'a2' }], '4': [{ id: 'a4' }], '5': [{ id: 'a5' }], '6': [{ id: 'a6' }] } },
    { id: 2, proGamesByScoringPeriod: { '1': [{ id: 'b1' }], '3': [{ id: 'b3' }], '5': [{ id: 'b5' }] } },
    { id: 3, proGamesByScoringPeriod: { '6': [{ id: 'c6' }] } }
];

test('gamesByProTeamForMatchup: counts inside the days it is given, and no others', () => {
    const m1 = gamesByProTeamForMatchup(PRO_TEAMS, [1, 2, 3]);
    assertEq(m1.get(1).games, 2, 'club 1 plays days 1 and 2');
    assertEq(m1.get(2).games, 2, 'club 2 plays days 1 and 3');
    // A BYE IS A ZERO, NOT AN ABSENCE. It is the answer a manager is looking for, so it has to be in the result rather than left out of it.
    assertEq(m1.get(3).games, 0, 'club 3 plays nothing in this stretch');
    assert(m1.has(3), 'and says so rather than vanishing');
    // The pseudo-club is not a club.
    assert(!m1.has(0), 'free agency has no schedule');

    const m2 = gamesByProTeamForMatchup(PRO_TEAMS, [4, 5, 6]);
    assertEq(m2.get(1).games, 3, 'club 1 across the second stretch');
    assertEq(m2.get(2).games, 1, 'club 2');
    assertEq(m2.get(3).games, 1, 'and club 3 finally plays');
    // The per-day breakdown survives, because "four games but three of them on one day" is a different week from "four games spread out".
    assertEq([...m2.get(1).byPeriod.entries()].sort(), [[4, 1], [5, 1], [6, 1]], 'day by day');

    assertEq(gamesByProTeamForMatchup(PRO_TEAMS, []).get(1).games, 0, 'no days, no games');
    assertEq(gamesByProTeamForMatchup(null, [1]).size, 0, 'no teams at all');
});

test('densityAcrossMatchups and teamDensity: one club\'s line across the rounds', () => {
    const rows = densityAcrossMatchups(PRO_TEAMS, [
        { matchup: 24, periods: [4, 5, 6] },     // deliberately out of order
        { matchup: 23, periods: [1, 2, 3] }
    ]);
    assertEq(rows.map(r => r.matchup), [23, 24], 'sorted, so a read runs left to right');
    assertEq(rows[0].periods, 3, 'and each round knows how long it was');
    assertEq(teamDensity(rows, 1), [{ matchup: 23, games: 2 }, { matchup: 24, games: 3 }], 'club 1');
    assertEq(teamDensity(rows, 3), [{ matchup: 23, games: 0 }, { matchup: 24, games: 1 }], 'club 3 sits out a round');
    assertEq(teamDensity(rows, 99), [{ matchup: 23, games: 0 }, { matchup: 24, games: 0 }], 'a club that does not exist');
    assertEq(densityAcrossMatchups(PRO_TEAMS, []).length, 0, 'no rounds');
});

test('offNightsForMatchup: clubs playing per day, as a COUNT', () => {
    const o = offNightsForMatchup(PRO_TEAMS, [1, 2, 3, 4, 5, 6]);
    assertEq(o.byPeriod.map(d => d.teamsPlaying), [2, 1, 1, 1, 2, 2], 'two, one, one, one, two, two');
    assertEq(o.clubCount, 3, 'three real clubs');
    assertEq(o.lightest, 1, 'the quietest night');
    assertEq(o.heaviest, 2, 'and the busiest');
    // The clubs themselves ride along, because "is MY club playing" cannot be recovered from a count.
    assertEq(o.byPeriod[0].clubs, [1, 2], 'day one');
    assertEq(o.byPeriod[2].clubs, [2], 'day three is club 2 alone');
    // Days arrive sorted even when they are handed over jumbled.
    assertEq(offNightsForMatchup(PRO_TEAMS, [3, 1, 2]).byPeriod.map(d => d.period), [1, 2, 3], 'sorted');
    assertEq(offNightsForMatchup(PRO_TEAMS, []).byPeriod.length, 0, 'no days');
});

test('twoStartPitchers: extends the probables machinery, filtered to the matchup\'s own days', () => {
    // The game index shape buildGamePeriodIndex produces.
    const gameIndex = new Map([
        ['g1', { period: 1, home: 1, away: 2 }],
        ['g4', { period: 4, home: 2, away: 1 }],
        ['g5', { period: 5, home: 1, away: 3 }],
        ['g9', { period: 9, home: 1, away: 2 }]   // outside every matchup below
    ]);
    const pitchers = [
        // Two starts inside days 1-6: the whole point of the feature.
        { id: 10, proTeamId: 1, starterStatusByProGame: { g1: 'PROBABLE', g5: 'PROBABLE', g9: 'PROBABLE' } },
        // One start.
        { id: 11, proTeamId: 2, starterStatusByProGame: { g4: 'PROBABLE' } },
        // Named on a game but NOT probable - not a start.
        { id: 12, proTeamId: 1, starterStatusByProGame: { g1: 'NOT_PROBABLE' } },
        // No probables at all, which is silence rather than a zero.
        { id: 13, proTeamId: 3, starterStatusByProGame: {} }
    ];
    const r = twoStartPitchers(pitchers, gameIndex, [1, 2, 3, 4, 5, 6]);
    assertEq(r.byPlayer.get(10).starts, 2, 'two starts in the stretch');
    assertEq(r.byPlayer.get(11).starts, 1, 'and one for the other');
    assertEq(r.twoPlus, [10], 'only one player has two');
    assertEq(r.total, 3, 'three starts across the stretch');
    // The day-9 start is outside the matchup and must not be counted, even though the window that countProjectedStarts takes is a range rather than a set.
    assert(r.byPlayer.get(10).games.every(g => g.period <= 6), 'nothing from outside the days');
    // SILENCE IS NOT A ZERO. ESPN publishes probables a few days out, so "no starts" and "not announced yet" look identical - reporting the first would invent news out of the second.
    assert(!r.byPlayer.has(13), 'a pitcher with no probables is absent');
    assert(!r.byPlayer.has(12), 'and so is one who is not probable');
    assertEq(twoStartPitchers(pitchers, gameIndex, []).twoPlus, [], 'no days, nothing to say');
    assertEq(twoStartPitchers(null, gameIndex, [1]).total, 0, 'no pitchers');
});

test('playoffMatchups: read off the schedule, never computed from the counts', () => {
    const schedule = [
        { matchupPeriodId: 21, playoffTierType: 'NONE' },
        { matchupPeriodId: 22, playoffTierType: 'WINNERS_BRACKET' },
        { matchupPeriodId: 23, playoffTierType: 'WINNERS_BRACKET' },
        { matchupPeriodId: 23, playoffTierType: 'WINNERS_CONSOLATION_LADDER' },
        { matchupPeriodId: 24, playoffTierType: 'LOSERS_CONSOLATION_LADDER' },
        { matchupPeriodId: 20 }
    ];
    // A consolation ladder is played by teams already eliminated, so it answers a different question than the one a manager planning a title run is asking.
    assertEq(playoffMatchups(schedule), [22, 23], 'the bracket only');
    assertEq(playoffMatchups(schedule, { includeConsolation: true }), [22, 23, 24], 'and with the ladders');
    // AN EMPTY RESULT IS A REAL ANSWER: mid-season ESPN has not drawn the bracket yet, and the owner's live league marks no playoff matchup at all. "Not scheduled yet" is the honest surface; guessing the rounds from playoffMatchupPeriodLength would be a confident number about a bracket that does not exist.
    assertEq(playoffMatchups([{ matchupPeriodId: 1, playoffTierType: 'NONE' }]), [], 'nothing drawn yet');
    assertEq(playoffMatchups([]), [], 'no schedule');
    assertEq(playoffMatchups(null), [], 'no league');
});


test('teamOffence: free agency is not a club, in either sport', () => {
    // ESPN files unrostered players under proTeamId 0. Aggregating them builds a team that does not exist and then lets it compete in the percentile basis against the ones that do.
    const hitters = [
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '20': 90, '5': 30 } },
        { proTeamId: 1, injuryStatus: 'ACTIVE', totals: { '20': 80, '5': 25 } },
        { proTeamId: 2, injuryStatus: 'ACTIVE', totals: { '20': 60, '5': 15 } },
        { proTeamId: 0, injuryStatus: 'ACTIVE', totals: { '20': 70, '5': 20 } },
        { proTeamId: 0, injuryStatus: 'ACTIVE', totals: { '20': 65, '5': 18 } }
    ];
    const byTeam = teamOffence(hitters, ['20', '5']);
    assertEq([...byTeam.keys()].sort(), [1, 2], 'two clubs, not three');
    assert(!byTeam.has(0), 'and no phantom');
    assertEq(byTeam.get(1).totals['20'], 170, 'the real club still sums its own bats');
    assertEq(byTeam.get(1).bats, 2, 'and counts them');

    // A club id that is genuinely absent is still dropped, as before.
    assertEq(teamOffence([{ proTeamId: null, totals: { '20': 5 } }], ['20']).size, 0, 'no club at all');
    // The percentile basis is what the phantom was distorting: with it gone, two clubs share the whole scale instead of three splitting it.
    const strength = offenceStrength(byTeam, ['20', '5']);
    assertEq(strength.size, 2, 'two clubs ranked');
});


// ==== Football: slot-scoped scoring weights, and the map's own discipline ====

test('points scoring: a slot override is the only weight some ids ever have', () => {
    // The football shape, reduced to arithmetic. Two ids score for everyone; a third scores ONLY when the entity sits in the D/ST slot, which is how 20 of that league's 46 ids work. Under base weights alone those 20 contribute nothing and every team defence scores zero.
    const P = (id, totals) => ({ id, seasonTotals: totals });
    const human = P(1, { '3': 4000, '4': 30, '95': 5 });   // 95 is a D/ST id no human can have
    const dst = P(-16, { '95': 20, '97': 4 });

    const baseWeights = { '3': 0.04, '4': 4 };             // what the league scores for everyone
    const dstWeights = { ...baseWeights, '95': 2, '97': 2 }; // plus the slot-16 overrides

    // 4000 * 0.04 + 30 * 4 = 160 + 120 = 280. The 5 in id 95 is not scored for a human.
    const humans = computePointsRanks([human], { weights: baseWeights, workloadOf: () => 1 });
    assertClose(humans.scores.get(1), 280, 'the human scores only what that slot scores');

    // 20 * 2 + 4 * 2 = 48.
    const defences = computePointsRanks([dst], { weights: dstWeights, workloadOf: () => 1 });
    assertClose(defences.scores.get(-16), 48, 'the defence scores through its overrides');

    // And the point of the whole fix: with base weights only, the defence scores NOTHING.
    const broken = computePointsRanks([dst], { weights: baseWeights, workloadOf: () => 1 });
    assertClose(broken.scores.get(-16), 0, 'which is what it did before the overrides were read');
});

test('ESPN_STAT_MAPS.ffl: only the ids that earned a name', () => {
    const ffl = ESPN_STAT_MAPS.ffl;
    // The reproduction sweep validated all 46 scored ids' arithmetic. Naming is a separate claim, and these are the ones with decisive evidence.
    assertEq(ffl[3], 'PYDS', 'passing yards');
    assertEq(ffl[53], 'REC', 'receptions, the PPR id');
    assertEq(ffl[19], '2PTP', 'and 19 is NOT the generic FPTS in this sport');
    // The kicker buckets are in distance order, which is what their own counts proved.
    assertEq([ffl[80], ffl[77], ffl[198], ffl[201]],
        ['FG0-39', 'FG40-49', 'FG50-59', 'FG60+'], 'four buckets, ascending');
    // THE OMISSIONS ARE THE POINT, and the line MOVED once the per-game log arrived: ids the season totals could not decide are named now, and the ones still listed here are the ones a single club's 17 weeks genuinely could not reach. An unmapped id renders no column, which beats a column headed by a guess - see the D/ST test below for what the log did settle. 63, 206 and 209 JOINED THE LIST LAST, and the reason they were missing matters more than the reason they are dark: this league scores them and neither the map nor this test mentioned them, so a guess arriving at one of them would have met nothing. The profiler counting 46 scored ids against 29 named is what found them. 63 is a sixth six-point route (see the D/ST test); 206 is a two-point play credited to a defence; 209 is carried by NOBODY in the pool, so the capture holds no evidence about it at all - which is still a reason to name it here rather than leave it unwatched.
    [63, 90, 97, 124, 125, 128, 133, 134, 135, 136, 206, 209].forEach(id =>
        assertEq(ffl[id], undefined, `id ${id} is deliberately unnamed`));
    // Every named id has a spelled-out name too, or a header would read a bare abbreviation.
    Object.keys(ffl).forEach(id =>
        assert(!!ESPN_STAT_FULL_NAMES.ffl[id], `id ${id} has a full name`));
    assertEq(DST_POSITION_ID, 16, 'the validated D/ST membership test');
});

test('football id 19 collides with baseball\'s FPTS, which is why ids are keyed by sport', () => {
    // The exact hazard the socket commit re-keyed the engine for, arriving for real. In baseball 19 is the generic fantasy-points total, excluded from category work; in football it is a two-point conversion worth 2 points, and skipping it costs a quarterback the real total.
    assertEq(ESPN_STAT_MAPS.flb[19], 'FPTS', 'baseball');
    assertEq(ESPN_STAT_MAPS.ffl[19], '2PTP', 'football');
    assert(ESPN_STAT_MAPS.flb[19] !== ESPN_STAT_MAPS.ffl[19], 'same number, different statistic');
});


test('football slot catalog: what the eligibility crossing proved', () => {
    const s = LINEUP_SLOT_LABELS.ffl;
    // Single-position slots, each taking ALL of one position and nobody else.
    assertEq([s[0], s[2], s[4], s[6], s[17], s[16]], ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'],
        'the six that take exactly one position');
    // FLEX is defined by what it EXCLUDES: no quarterback, no kicker, no defence.
    assertEq(s[23], 'FLEX', 'backs, receivers and tight ends only');
    // Both everyone-slots are non-starting, which is the fact that actually matters.
    assert(NON_STARTING_SLOTS.ffl.has(20) && NON_STARTING_SLOTS.ffl.has(21), 'bench and injury');
    assertEq(NON_STARTING_SLOTS.ffl.size, 2, 'and nothing else is non-starting');
    // The unrostered flexes stay unnamed rather than being given ESPN's word from a guess.
    [3, 5, 7, 25].forEach(id => assertEq(s[id], undefined, `slot ${id} is deliberately unnamed`));
    // Order is a starting lineup read top to bottom, and carries no bench.
    assertEq(LINEUP_SLOT_ORDER.ffl, [0, 2, 4, 6, 23, 17, 16], 'lineup card order');
    LINEUP_SLOT_ORDER.ffl.forEach(id =>
        assert(!NON_STARTING_SLOTS.ffl.has(id), `slot ${id} starts`));
    // The second group starts in exactly one place.
    assertEq([...SECONDARY_LINEUP_SLOTS.ffl], [16], 'D/ST has one slot');
});

test('football groups: Players and D/ST, through the socket that already existed', () => {
    // The one-group/two-group socket reads SECONDARY_GROUP_POSITIONS, so football gets two groups by adding its second pool to that table rather than by any football-specific branch.
    assertEq(roleGroupsFor('ffl'), ['primary', 'secondary'], 'two groups');
    assertEq([...SECONDARY_GROUP_POSITIONS.ffl], ['D/ST'], 'and the second one is the defences');
    assertEq(POSITION_MAPS.ffl[16], 'D/ST', 'which is how a defence gets that position name');
    // The IDP oddities are unnamed - one player each, in a league rostering neither slot.
    assertEq(POSITION_MAPS.ffl[9], undefined, 'position 9 unnamed');
    assertEq(POSITION_MAPS.ffl[12], undefined, 'position 12 unnamed');
    // And the sports that had one group still have what they had.
    assertEq(roleGroupsFor('flb'), ['primary', 'secondary'], 'baseball unchanged');
    assertEq(roleGroupsFor('fhl'), ['primary', 'secondary'], 'hockey unchanged');
    assertEq(roleGroupsFor('nba'), ['primary'], 'a sport with no second pool is one pool');
});


test('football roster band: the lineup card in its own order', () => {
    // The real capture carries no rosters (its download used mTeam/mSettings, not mRoster), so the band is proven here on the league's OWN slot counts with a hand-built lineup instead.
    const counts = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 };
    const entries = [
        { lineupSlotId: 20, playerId: 901 }, { lineupSlotId: 16, playerId: -16 },
        { lineupSlotId: 0, playerId: 902 }, { lineupSlotId: 23, playerId: 903 },
        { lineupSlotId: 4, playerId: 904 }, { lineupSlotId: 21, playerId: 905 },
        { lineupSlotId: 2, playerId: 906 }, { lineupSlotId: 17, playerId: 907 },
        { lineupSlotId: 6, playerId: 908 }
    ];
    const g = buildRosterGroups(entries, 'ffl', counts);
    // Deliberately handed over jumbled: the band reads QB, RB, WR, TE, FLEX, K, D/ST regardless.
    assertEq(g.starters.map(r => LINEUP_SLOT_LABELS.ffl[r.slot]),
        ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'D/ST'], 'the lineup card order');
    // Bench and injury are SEPARATE arrays by design, so an injured player never reads as a healthy scratch. Which of slots 20 and 21 is which is the one thing the eligibility crossing could not settle - both take every player - so this asserts the SPLIT rather than the labels, and the split is what anything downstream depends on.
    assertEq(g.bench.map(r => r.playerId), [901], 'the bench slot, alone');
    assertEq(g.injured.map(r => r.playerId), [905], 'and the injury slot, apart from it');
    assertEq(g.orphans.length, 0, 'every entry placed somewhere');
    // The defence is a starter in its own slot, not a bench oddity.
    assertEq(g.starters.find(r => r.slot === 16).playerId, -16, 'the D/ST starts at slot 16');
});


test('D/ST ids: named from the per-game log, dark ones left dark', () => {
    const f = ESPN_STAT_MAPS.ffl;
    // The counting plays, each settled by a league-wide identity rather than a guess.
    assertEq(f[95], 'DINT', 'interceptions - 380 caught against 380 thrown');
    assertEq(f[96], 'FR', 'fumbles recovered - 242 against 241 lost');
    assertEq(f[99], 'SACK', 'sacks - 1,285 across 32 clubs');
    assertEq(f[98], 'SFTY', 'safeties - 12 league-wide, never more than one a club');
    // The bracket rows the one club's 17 weeks actually landed in.
    assertEq([f[89], f[91], f[92], f[123]], ['PA0', 'PA7-13', 'PA14-17', 'PA28-34'], 'points allowed');
    assertEq([f[129], f[130], f[132]], ['YA100-199', 'YA200-299', 'YA350-399'], 'yards allowed');
    // STILL DARK: brackets this club never landed in, and plays no identity settles. A defence that never allowed 1-6 points teaches nothing about that row.
    [90, 124, 125, 128, 133, 134, 135, 136].forEach(id =>
        assertEq(f[id], undefined, `bracket ${id} never fired`));
    assertEq(f[97], undefined, '97 matches no offensive identity');
    // SIX routes, not five: 63 is carried by one running back, value 1, worth six - every property the other five have, so the evidence splits it from them no better than it splits them from each other.
    [63, 93, 101, 102, 103, 104].forEach(id =>
        assertEq(f[id], undefined, `id ${id} is one of six indistinguishable 6-point routes`));
    // 206 is a defence's own row, dark for the ordinary reason: two team defences carry it, one each, worth TWO through a slot override. A two-point play credited to a defence has more than one spelling and two instances in a club-season choose none of them.
    assertEq(f[206], undefined, '206 is a two-point defensive play no identity settles');
    // Every named id still carries a spelled-out name.
    Object.keys(f).forEach(id => assert(!!ESPN_STAT_FULL_NAMES.ffl[id], `id ${id} has a full name`));
});

// Report ---------------------------------------------------------------------------


// ==== playoffOutlook ====

// The real hockey bracket out of tests/fixtures/schedule-insight.json: matchups 22, 23 and 24, running 7, 7 and EIGHTEEN days. Club 11 plays 3, 4 and 9; club 19 plays 2, 3 and 10. Every expectation below is those numbers added up by hand.
const PLAYOFF_ROWS = [
    { matchup: 22, periods: 7, byTeam: { 11: 3, 19: 2 } },
    { matchup: 23, periods: 7, byTeam: { 11: 4, 19: 3 } },
    { matchup: 24, periods: 18, byTeam: { 11: 9, 19: 10 } }
];

test('playoffOutlook: games sum across the rounds, and every round carries its own length', () => {
    const out = playoffOutlook(PLAYOFF_ROWS, 11, { perGame: 2.5 });
    assertEq(out.games, 16, '3 + 4 + 9');
    assertEq(out.byRound.length, 3, 'one entry per round');
    assertEq(out.byRound.map(r => r.matchup).join(','), '22,23,24', 'the matchup ids the league uses');
    assertEq(out.byRound.map(r => r.games).join(','), '3,4,9', 'per round');
    // Required on EVERY round, not only the one that differs - 9 games in an 18-day round is less busy per day than 3 in a 7-day one, and a renderer can only see that if it can compare.
    assertEq(out.byRound.map(r => r.days).join(','), '7,7,18', 'every round says how long it is');
});

test('playoffOutlook: projected is the per-game projection times the games in the window', () => {
    assertEq(playoffOutlook(PLAYOFF_ROWS, 11, { perGame: 2.5 }).projected, 40, '2.5 x 16');
    assertEq(playoffOutlook(PLAYOFF_ROWS, 19, { perGame: 2 }).projected, 30, '2 x 15');
});

test('playoffOutlook: no projection keeps the real counts and reports projected null', () => {
    // The counts are still true; only the projection is unknown. Surrendering the whole column would throw away the half that is measured.
    const out = playoffOutlook(PLAYOFF_ROWS, 11, {});
    assertEq(out.games, 16, 'the games are still counted');
    assertEq(out.projected, null, 'and the projection says it does not know');
});

test('playoffOutlook: no bracket is null, not an empty window', () => {
    assertEq(playoffOutlook([], 11, { perGame: 2 }), null, 'no rounds');
    assertEq(playoffOutlook(null, 11, { perGame: 2 }), null, 'no rows at all');
});

test('playoffOutlook: a club the schedule has never heard of is NULL, never a zero line', () => {
    // A zero line looks measured and is not. This is the same rule the coverage band follows for a category with no figure: unknown and none are different answers.
    assertEq(playoffOutlook(PLAYOFF_ROWS, 999, { perGame: 2 }), null, 'unknown club');
    assertEq(playoffOutlook(PLAYOFF_ROWS, null, { perGame: 2 }), null, 'no club at all');
});

test('playoffOutlook: a known club with no game in a round really does read 0 there', () => {
    const rows = [
        { matchup: 22, periods: 7, byTeam: { 11: 3 } },
        { matchup: 23, periods: 7, byTeam: { 12: 4 } }   // club 11 is idle this round
    ];
    const out = playoffOutlook(rows, 11, { perGame: 1 });
    assertEq(out.byRound.map(r => r.games).join(','), '3,0', 'idle is zero, absent is null');
    assertEq(out.games, 3, 'and the total is just the round played');
});

test('playoffOutlook: reads the live Map shape as well as the serialized fixture shape', () => {
    const rows = [{ matchup: 22, periods: 7, byTeam: new Map([[11, { games: 3, byPeriod: new Map() }]]) }];
    assertEq(playoffOutlook(rows, 11, { perGame: 2 }).games, 3, 'densityAcrossMatchups output');
});

test('playoffOutlook: trend passes through, and defaults to null rather than a direction', () => {
    assertEq(playoffOutlook(PLAYOFF_ROWS, 11, { perGame: 1, trend: 'up' }).trend, 'up', 'given');
    assertEq(playoffOutlook(PLAYOFF_ROWS, 11, { perGame: 1 }).trend, null, 'not enough to call');
});


// ==== matchupWindow ====

// Built through the REAL gamesByProTeamForMatchup so the shape cannot drift from what the app hands this function. Club 5 plays days 10, 11 and 13; club 6 plays twice on day 10 and not again; club 9 is not in the schedule at all. The matchup runs days 10-13.
const WIN_PRO_TEAMS = [
    { id: 5, proGamesByScoringPeriod: { 10: [{}], 11: [{}], 13: [{}], 14: [{}] } },
    { id: 6, proGamesByScoringPeriod: { 10: [{}, {}] } },
    { id: 7, proGamesByScoringPeriod: { 20: [{}] } }
];
const WIN_BY_TEAM = gamesByProTeamForMatchup(WIN_PRO_TEAMS, [10, 11, 12, 13]);
const WIN_PERIODS = [10, 11, 12, 13];
// A stub labeler, so these assertions do not depend on the machine's locale or timezone. The real one is dayLabelerFor, tested separately below against a known date.
const WIN_LABEL = (p) => `D${p}`;

// ===== item 2: the games that win a week ================================================== Three clubs of nine play on day 10, one of nine on day 11: with a third of nine being 3, day 11 is an off night and day 10 is not. Club 5 plays once on each, club 6 plays TWICE on day 10. Built through the real offNightsForMatchup so the density shape cannot drift either.
const WIN_DENSITY_TEAMS = [
    ...WIN_PRO_TEAMS,
    { id: 11, proGamesByScoringPeriod: { 10: [{}] } },
    { id: 12, proGamesByScoringPeriod: { 10: [{}] } },
    { id: 13, proGamesByScoringPeriod: { 13: [{}] } },
    { id: 14, proGamesByScoringPeriod: { 13: [{}] } },
    { id: 15, proGamesByScoringPeriod: { 13: [{}] } },
    { id: 16, proGamesByScoringPeriod: { 13: [{}] } }
];
const WIN_DENSITY = offNightsForMatchup(WIN_DENSITY_TEAMS, WIN_PERIODS);
const WIN_BY_TEAM_D = gamesByProTeamForMatchup(WIN_DENSITY_TEAMS, WIN_PERIODS);

// ===== R6 / O57: the window says what unit it counted in ================================== The owner's report: a starting pitcher read "9 of 13 games left" in a matchup he appears in twice. The club's games are the wrong quantity for him by roughly five to one, and the right one is already published - ESPN's probable listings, the same count My Team's two-start badges show.

// Club 5 plays days 10, 11 and 13 inside this window; the pitcher is listed for one of them, still to come. countProjectedStarts' own shape: { starts, remaining, games }.
const ACE_STARTS = { total: 2, remaining: 1 };

test('matchupWindow: countStarts switches the unit, and the counts with it', () => {
    const w = matchupWindow(WIN_BY_TEAM, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 11, starts: ACE_STARTS, countStarts: true
    });
    assertEq([w.games, w.played, w.remaining], [2, 1, 1], 'his starts, not his club three games');
    assertEq(w.unit, 'starts', 'and the figure says which it is');
});

test('matchupWindow: the same window without countStarts is unchanged', () => {
    // Every existing caller. The club plays three games in days 10-13, one of them before day 11.
    const w = matchupWindow(WIN_BY_TEAM, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 11, starts: ACE_STARTS
    });
    assertEq([w.games, w.played, w.remaining], [3, 1, 2], 'the club own games');
    assertEq(w.unit, 'games', 'the unit is stated either way, never left to be guessed');
});

test('matchupWindow: counting starts drops offNight and twoGameDays rather than carrying them', () => {
    // Both count the CLUB's games. A start on a quiet night, or a club's doubleheader, says nothing about a pitcher taking one turn in the window - and a figure meaning something else under the same name is the whole defect this option exists to fix.
    const w = matchupWindow(WIN_BY_TEAM_D, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, density: WIN_DENSITY, starts: ACE_STARTS, countStarts: true
    });
    assertEq([w.offNight, w.twoGameDays], [null, null], 'not the club figures under a starts count');
    const games = matchupWindow(WIN_BY_TEAM_D, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, density: WIN_DENSITY, starts: ACE_STARTS
    });
    assertEq(games.offNight, 1, 'and they are still there when the unit is games');
});

test('matchupWindow: countStarts without a starts count is ignored, not a zero', () => {
    // A batter, or a pitcher this window has no listing for. Asking to count starts when there are none to count must leave the club games alone rather than reporting nothing at all.
    const w = matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL, countStarts: true });
    assertEq([w.games, w.unit], [3, 'games'], 'the honest count that does exist');
});

test('matchupWindow: byPeriod stays the CLUB days under either unit', () => {
    // Which nights the club plays is true whatever is being counted, and it is the half of the answer a manager choosing between two pitchers actually reads.
    const w = matchupWindow(WIN_BY_TEAM, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, starts: ACE_STARTS, countStarts: true
    });
    assertEq(w.byPeriod.length, 4, 'every day the window covers, idle ones included');
    assertEq(w.byPeriod.map(d => d.count).join(','), '1,1,0,1', 'the club own game days');
});

test('matchupWindow: offNight counts GAMES on nights fewer than a third of clubs play', () => {
    // Nine clubs, so the threshold is 3. Day 10 has clubs 5, 6, 11 and 12 playing = 4, not an off night. Day 11 has club 5 alone = 1, an off night. Day 13 has 5, 13, 14, 15, 16 = 5.
    assertEq(WIN_DENSITY.clubCount, 9, 'nine clubs in this schedule');
    assertEq(WIN_DENSITY.byPeriod.map(d => d.teamsPlaying), [4, 1, 0, 5], 'clubs on each day');
    const w = matchupWindow(WIN_BY_TEAM_D, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL, density: WIN_DENSITY });
    assertEq(w.offNight, 1, 'the day-11 game alone; day 10 and day 13 are busy nights');
});

test('matchupWindow: offNight counts a doubleheader on a quiet night TWICE', () => {
    // The owner's legend says GAMES, not nights, so a club playing twice on an off night gets two. Club 6 plays twice on day 10; make day 10 quiet by measuring density over club 6 alone.
    const soloDensity = offNightsForMatchup([{ id: 6, proGamesByScoringPeriod: { 10: [{}, {}] } },
        { id: 21, proGamesByScoringPeriod: { 13: [{}] } }, { id: 22, proGamesByScoringPeriod: { 13: [{}] } },
        { id: 23, proGamesByScoringPeriod: { 13: [{}] } }, { id: 24, proGamesByScoringPeriod: { 13: [{}] } }], WIN_PERIODS);
    const byTeam = gamesByProTeamForMatchup([{ id: 6, proGamesByScoringPeriod: { 10: [{}, {}] } }], WIN_PERIODS);
    // Five clubs, threshold 5/3 = 1.67; day 10 has one club playing, so it is an off night.
    assertEq(soloDensity.clubCount, 5, 'five clubs');
    const w = matchupWindow(byTeam, 6, { periods: WIN_PERIODS, labelOf: WIN_LABEL, density: soloDensity });
    assertEq(w.offNight, 2, 'two games on one quiet night is two games');
});

test('matchupWindow: twoGameDays counts DAYS, not games', () => {
    // Club 6 plays twice on day 10 and never again: one two-game day, two games.
    const w = matchupWindow(WIN_BY_TEAM, 6, { periods: WIN_PERIODS, labelOf: WIN_LABEL });
    assertEq(w.games, 2, 'two games');
    assertEq(w.twoGameDays, 1, 'on one day');
    // Club 5 plays one game a day, so it has none - a real zero, which the renderer omits.
    assertEq(matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL }).twoGameDays, 0, 'a real zero');
});

test('matchupWindow: offNight is NULL without density, and a real 0 with it', () => {
    // The emptySlots rule again. A zero would say "none of these games are on a quiet night"; the truth without density is that nobody said which nights are quiet, and those differ.
    const noDensity = matchupWindow(WIN_BY_TEAM_D, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL });
    assertEq(noDensity.offNight, null, 'nobody said which nights are quiet');
    // Club 13 plays only on day 13, a five-club night above the threshold - a genuine none.
    const busy = matchupWindow(WIN_BY_TEAM_D, 13, { periods: WIN_PERIODS, labelOf: WIN_LABEL, density: WIN_DENSITY });
    assertEq(busy.offNight, 0, 'no off-night is played, which is an answer');
    assert(busy.offNight !== null, 'and it is not the same as not knowing');
});

test('matchupWindow: the off-night share is a share, never a hardcoded club count', () => {
    // 32 clubs and 30 clubs are different leagues; a magic number would silently mean a different thing in each. Raising the share turns day 10 (4 of 9) into an off night too.
    const w = matchupWindow(WIN_BY_TEAM_D, 5, {
        periods: WIN_PERIODS, labelOf: WIN_LABEL, density: WIN_DENSITY, offNightShare: 0.5
    });
    assertEq(w.offNight, 2, 'at half the league, day 10 and day 11 both count');
});

test('matchupWindow: counts only the days inside the matchup, and splits played from remaining', () => {
    // Day 14 is outside the window, so club 5 has THREE games here, not four.
    const w = matchupWindow(WIN_BY_TEAM, 5, { matchup: 7, periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 12 });
    assertEq(w.matchup, 7, 'the matchup id the league uses');
    assertEq(w.games, 3, 'days 10, 11 and 13');
    assertEq(w.played, 2, 'days 10 and 11 are behind us');
    assertEq(w.remaining, 1, 'only day 13 is left');
    assertEq(w.played + w.remaining, w.games, 'the invariant this lane keeps');
    // EVERY day the window covers, idle ones included: day 12 is a real entry reading zero, because "off on the 12th" is half the answer a reader is choosing on.
    assertEq(w.byPeriod.map(r => `${r.period}:${r.count}`).join(','), 'D10:1,D11:1,D12:0,D13:1', 'every day, labelled');
});

test('matchupWindow: a game on TODAY is remaining, because the day is not over', () => {
    // Same rule countProjectedStarts uses, so the two halves of the column agree about today.
    const w = matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 13 });
    assertEq(w.played, 2, 'the two before today');
    assertEq(w.remaining, 1, 'today still counts as left to play');
});

test('matchupWindow: two games on one day are two games', () => {
    const w = matchupWindow(WIN_BY_TEAM, 6, { periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 11 });
    assertEq(w.games, 2, 'a doubleheader is not one game');
    assertEq(w.byPeriod.map(r => r.count).join(','), '2,0,0,0', 'both on the same day, the rest idle');
    assertEq(w.remaining, 0, 'and both already played');
});

test('matchupWindow: no fromPeriod means nothing is assumed played', () => {
    // Number(null) is 0, and day zero would put every game in the past.
    const w = matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, labelOf: WIN_LABEL });
    assertEq(w.played, 0, 'nothing assumed');
    assertEq(w.remaining, 3, 'all of them still ahead');
});

test('matchupWindow: a club the schedule does not carry is NULL; one that is idle is games 0', () => {
    // The football case: one game a matchup is normal, and a bye is a real answer worth showing.
    assertEq(matchupWindow(WIN_BY_TEAM, 9, { periods: WIN_PERIODS, fromPeriod: 12 }), null, 'unknown club');
    const bye = matchupWindow(WIN_BY_TEAM, 7, { periods: WIN_PERIODS, labelOf: WIN_LABEL, fromPeriod: 12 });
    assertEq(bye.games, 0, 'known club, no game in this matchup');
    assertEq(bye.remaining, 0, 'nothing left either');
    // The bye keeps its days rather than losing the column - the same way a playoff bye round keeps its byRound entry and reads "none".
    assertEq(bye.byPeriod.map(r => r.count).join(','), '0,0,0,0', 'four idle days, all present');
});

test('matchupWindow: starts pass through, and null is not zero', () => {
    // Hockey and football have no probable starts at all; a pitcher with none listed has zero. A column that printed 0 for a skater would be answering a question nobody asked of it.
    const withStarts = matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, fromPeriod: 12, starts: { total: 2, remaining: 1 } });
    assertEq(withStarts.starts.remaining, 1, 'a pitcher with a listing');
    assertEq(matchupWindow(WIN_BY_TEAM, 5, { periods: WIN_PERIODS, fromPeriod: 12 }).starts, null, 'a skater has none to count');
});


test('dayLabelerFor: a period prints as its weekday, and an undated one falls back to its number', () => {
    // is a Tuesday. Built from a Map so the test does not depend on a capture.
    const label = dayLabelerFor(new Map([[10, Date.UTC(2026, 0, 6, 18, 0, 0)]]));
    assert(/^[A-Za-z]{2,4}$/.test(label(10)), `a weekday name, got ${label(10)}`);
    assertEq(label(11), '11', 'no date, so the number rather than an empty column');
});


// ==== off nights, roster-relative ====

// Three clubs over four nights. Club 5 plays nights 10 and 12; club 6 plays 10, 11 and 13; club 7 plays nothing in this window at all. A roster of four: two on club 5, one on 6, one on a club the schedule has never heard of.
const NIGHT_TEAMS = [
    { id: 5, proGamesByScoringPeriod: { 10: [{}], 12: [{}] } },
    { id: 6, proGamesByScoringPeriod: { 10: [{}], 11: [{}], 13: [{}] } },
    { id: 7, proGamesByScoringPeriod: { 20: [{}] } },
    { id: 0, proGamesByScoringPeriod: { 10: [{}] } }   // ESPN's free-agent pseudo-club, never counted
];
const NIGHT_ROSTER = [
    { id: 'a', proTeamId: 5 }, { id: 'b', proTeamId: 5 },
    { id: 'c', proTeamId: 6 }, { id: 'd', proTeamId: 999 }
];

test("rosterNightCoverage: counts MY players on each night, not the league's clubs", () => {
    const c = rosterNightCoverage(NIGHT_ROSTER, NIGHT_TEAMS, [10, 11, 12, 13]);
    // night 10: a, b (club 5) and c (club 6) = 3. 11: c only. 12: a, b. 13: c.
    assertEq(c.byPeriod.map(d => d.playing).join(','), '3,1,2,1', 'players on each night');
    assertEq(c.byPeriod.map(d => d.period).join(','), '10,11,12,13', 'in schedule order');
    assertEq(c.thinnest, 1, 'the emptiest night');
    assertEq(c.fullest, 3, 'the fullest');
});

test('rosterNightCoverage: a player whose club the schedule does not carry is UNKNOWN, not idle', () => {
    // Idle is a hole to fill; unknown is a fact nobody has. Counting the second as the first would report a lineup gap that may not exist.
    const c = rosterNightCoverage(NIGHT_ROSTER, NIGHT_TEAMS, [10, 11, 12, 13]);
    assertEq(c.players, 3, 'three players the schedule can speak to');
    assertEq(c.unknownClub, 1, 'and one it cannot');
    // night 11: only c plays, so two of the three KNOWN players are idle - not three of four.
    assertEq(c.byPeriod[1].idle, 2, 'idle counts against the known players only');
});

test('rosterNightCoverage: a night nobody plays is 0, and the free-agent club never counts', () => {
    const c = rosterNightCoverage([{ id: 'a', proTeamId: 5 }], NIGHT_TEAMS, [11]);
    assertEq(c.byPeriod[0].playing, 0, 'club 5 is idle on 11');
    assertEq(c.thinnest, 0, 'an empty night is a real answer');
    // club 0 plays on night 10 and must never be counted as a club at all
    const c2 = rosterNightCoverage([{ id: 'z', proTeamId: 0 }], NIGHT_TEAMS, [10]);
    assertEq(c2.players, 0, 'the pseudo-club is not a club');
    assertEq(c2.unknownClub, 1, 'so a player on it has no club the schedule knows');
});

test('rosterNightCoverage: no days is null rather than an empty shape', () => {
    assertEq(rosterNightCoverage(NIGHT_ROSTER, NIGHT_TEAMS, []), null, 'no window');
    assertEq(rosterNightCoverage(NIGHT_ROSTER, NIGHT_TEAMS, null), null, 'no window at all');
});

test("nightsAcrossMatchups: one row per round, in the league's own order", () => {
    const rows = nightsAcrossMatchups(NIGHT_ROSTER, NIGHT_TEAMS, [
        { matchup: 23, periods: [12, 13] }, { matchup: 22, periods: [10, 11] }
    ]);
    assertEq(rows.map(r => r.matchup).join(','), '22,23', 'sorted by matchup');
    assertEq(rows[0].byPeriod.map(d => d.playing).join(','), '3,1', 'round 22 nights');
    assertEq(rows[1].byPeriod.map(d => d.playing).join(','), '2,1', 'round 23 nights');
    assertEq(rows[0].thinnest, 1, 'the emptiest night of round 22');
});


// ==== off nights against the real bracket ====

// Rebuilt from tests/fixtures/schedule-insight.json's own offNights block - a REAL captured hockey week, matchup 22, seven nights (161-167) with 10, 18, 12, 22, 10, 22 and 18 clubs on. The fixture stores the ANSWER (which clubs played each night), so the clubs are turned back into schedules here and the coverage is recomputed from them: the test is driven by captured facts rather than numbers chosen to make it pass. Fetched ONCE at module scope with top-level await, so the tests below stay synchronous. This harness's test() catches only synchronous throws - an async test body would resolve its rejection somewhere nobody is looking and report a PASS, which is the one failure mode a test file must not have. A fetch that fails registers a failing test rather than taking the module down silently.
let OFF_NIGHTS = null;
try {
    OFF_NIGHTS = await fetch('fixtures/schedule-insight.json').then(r => r.json()).then(d => d.offNights);
} catch (e) {
    test('schedule-insight fixture loads', () => { throw new Error(`could not read the fixture: ${e.message}`); });
}

function hockeyProTeamsFromFixture(off) {
    const byClub = new Map();
    off.byPeriod.forEach(day => (day.clubs || []).forEach(id => {
        if (!byClub.has(id)) byClub.set(id, {});
        byClub.get(id)[day.period] = [{}];
    }));
    return [...byClub.entries()].map(([id, sched]) => ({ id, proGamesByScoringPeriod: sched }));
}

test('rosterNightCoverage: a real hockey week, counted off the captured club lists', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    // Clubs 11, 5 and 20 out of the capture. From the fixture's own lists: 11 plays 161, 163, 165 5 plays 161, 164, 166 20 plays 162, 164, 166, 167 so the nightly counts are 161:2 162:1 163:1 164:2 165:1 166:2 167:1
    const roster = [{ id: 'a', proTeamId: 11 }, { id: 'b', proTeamId: 5 }, { id: 'c', proTeamId: 20 }];
    const c = rosterNightCoverage(roster, proTeams, days);
    assertEq(c.byPeriod.map(d => d.playing).join(','), '2,1,1,2,1,2,1', 'three real clubs across the week');
    assertEq(c.players, 3, 'all three clubs are in the capture');
    assertEq(c.unknownClub, 0, 'none of them unknown');
    assertEq(c.thinnest, 1, 'the emptiest night');
});

test('rosterNightCoverage: empty SLOTS is what a manager acts on, and is null when nobody said', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    const roster = [{ id: 'a', proTeamId: 11 }, { id: 'b', proTeamId: 5 }, { id: 'c', proTeamId: 20 }];
    // Four skater slots against nightly counts 2,1,1,2,1,2,1 leaves 2,3,3,2,3,2,3 unfilled.
    const withSlots = rosterNightCoverage(roster, proTeams, days, { slots: 4 });
    assertEq(withSlots.byPeriod.map(d => d.emptySlots).join(','), '2,3,3,2,3,2,3', 'slots minus who plays');
    // Two slots and two players on means a full lineup, never a negative hole.
    const tight = rosterNightCoverage(roster, proTeams, days, { slots: 2 });
    assertEq(tight.byPeriod.map(d => d.emptySlots).join(','), '0,1,1,0,1,0,1', 'floored at zero');
    // An unstated capacity is UNKNOWN, not full.
    assertEq(rosterNightCoverage(roster, proTeams, days).byPeriod[0].emptySlots, null, 'no slots, no answer');
});

test('nightsFilledBy: a free agent is worth the nights filled, not the nights played', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    const roster = [{ id: 'a', proTeamId: 11 }, { id: 'b', proTeamId: 5 }, { id: 'c', proTeamId: 20 }];
    // Two slots: full on 161, 164 and 166. A club-20 free agent plays 162, 164, 166, 167 - four nights, but only 162 and 167 are nights this lineup could actually use the add.
    const tight = rosterNightCoverage(roster, proTeams, days, { slots: 2 });
    const fa = nightsFilledBy({ proTeamId: 20 }, proTeams, tight);
    assertEq(fa.plays.join(','), '162,164,166,167', 'the nights that club is on');
    assertEq(fa.fills.join(','), '162,167', 'the nights that were not already full');
    assertEq(fa.fillCount, 2, 'and the count a shopping list would sort by');
});

// ===== item 3, the leaderboard row's openSeats field (contract amendment 1) =============== The refusal layer over nightsFilledBy. Its whole job is deciding WHEN the question is answerable, so every case here is about the boundary rather than the arithmetic - the counts are the atom's and are already pinned above.
test('openSeats: a free agent gets the nights that club plays into an open seat', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    const roster = [{ id: 'a', proTeamId: 11 }, { id: 'b', proTeamId: 5 }, { id: 'c', proTeamId: 20 }];
    // Same two-slot lineup as the atom's own case above: full on 161, 164 and 166, so a club-20 free agent is worth 162 and 167.
    const tight = rosterNightCoverage(roster, proTeams, days, { slots: 2 });
    const seats = openSeatNights({ proTeamId: 20 }, proTeams, tight, { isFreeAgent: true });
    assertEq(seats.nights.join(','), '162,167', 'the nights that were not already full');
    assertEq(seats.count, 2, 'and the count the row sorts by');
});

test('openSeats: a ROSTERED player is null - the move it describes is not available', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    const cover = rosterNightCoverage([{ id: 'a', proTeamId: 11 }], proTeams, days, { slots: 2 });
    assertEq(openSeatNights({ proTeamId: 20 }, proTeams, cover, { isFreeAgent: false }), null, 'held already');
    assertEq(openSeatNights({ proTeamId: 20 }, proTeams, cover), null, 'and no flag at all is not a free agent');
});

test('openSeats: a club the schedule does not know is null, never zero', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    const cover = rosterNightCoverage([{ id: 'a', proTeamId: 11 }], proTeams, days, { slots: 2 });
    // Zero would claim the add fills nothing. The truth is that nothing is known about that club.
    assertEq(openSeatNights({ proTeamId: 99999 }, proTeams, cover, { isFreeAgent: true }), null, 'unknown club');
    assertEq(openSeatNights(null, proTeams, cover, { isFreeAgent: true }), null, 'no candidate at all');
});

test('openSeats: no coverage and no slot capacity are both null', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    assertEq(openSeatNights({ proTeamId: 20 }, proTeams, null, { isFreeAgent: true }), null, 'nothing to intersect');
    // The distinction the atom keeps and this must not flatten: an unstated capacity is not a full lineup. "Fills nothing" and "nobody said how many seats there are" are different answers.
    const noCap = rosterNightCoverage([{ id: 'a', proTeamId: 11 }], proTeams, days);
    assertEq(openSeatNights({ proTeamId: 20 }, proTeams, noCap, { isFreeAgent: true }), null, 'no capacity, no notion of a hole');
});

test('openSeats: count 0 is a REAL answer and is not null', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    // One slot against three held skaters: somebody is on every night, so no night has a hole and a candidate fills nothing. That is an answer - "plays no night you are short" - and the renderer must be able to tell it from "the question could not be asked".
    const full = rosterNightCoverage(
        [{ id: 'a', proTeamId: 11 }, { id: 'b', proTeamId: 5 }, { id: 'c', proTeamId: 20 }],
        proTeams, days, { slots: 1 });
    const seats = openSeatNights({ proTeamId: 20 }, proTeams, full, { isFreeAgent: true });
    assert(seats !== null, 'an answer, not a refusal');
    assertEq([seats.count, seats.nights.length], [0, 0], 'and the answer is none');
});

test('nightsFilledBy: no slot count means fills is NULL, never an empty list', () => {
    const off = OFF_NIGHTS;
    const proTeams = hockeyProTeamsFromFixture(off);
    const days = off.byPeriod.map(d => d.period);
    // "Fills nothing" and "nobody said how many slots there are" are different answers.
    const cover = rosterNightCoverage([{ id: 'a', proTeamId: 11 }], proTeams, days);
    const fa = nightsFilledBy({ proTeamId: 20 }, proTeams, cover);
    assertEq(fa.fills, null, 'no capacity, no notion of a hole');
    assertEq(fa.fillCount, null, 'and no count either');
    assertEq(nightsFilledBy({ proTeamId: 999 }, proTeams, cover), null, 'a club the schedule lacks');
});

// ==== lower is better Moved here with state.js when lowerIsBetterIds did. The assertions are unchanged from where they were written against preseason-face.js - only the rule's home moved, and a test that follows its subject is the point of moving it. ====

test('lowerIsBetterIds: a negative league weight means lower is better', () => {
    // The football case, and the bug that put this function here: with no ffl entry in INVERSE_STATS, leading the league in fumbles lost read as a manager's BEST category.
    const s = lowerIsBetterIds(new Set(), { '3': 0.04, '4': 4, '20': -2, '72': -2, '85': -1 });
    assert(s.has('20') && s.has('72') && s.has('85'), 'the three negatively weighted ids');
    assert(!s.has('3') && !s.has('4'), 'positively weighted ids are untouched');
});

test('lowerIsBetterIds: the sport validated table survives alongside the weights', () => {
    const s = lowerIsBetterIds(new Set(['47']), { '72': -2 });
    assert(s.has('47'), 'ERA from the table');
    assert(s.has('72'), 'and the negatively weighted id');
});

test('lowerIsBetterIds: no weights at all leaves the table exactly as it was', () => {
    const base = new Set(['47', '50']);
    const s = lowerIsBetterIds(base, null);
    assertEq(s.size, 2, 'unchanged');
    assert(s !== base, 'a copy, so a caller cannot mutate the sport table by accident');
});


// ==== the two-way rank label ====

test('rankPoolLabel: Overall says which role it is overall IN, but only for a two-way player', () => {
    // The chip has always meant "overall within the role you are looking at". For everyone who plays one role those are the same sentence, so the qualifier would be noise.
    assertEq(rankPoolLabel('Overall', 'Batter'), 'Overall (as Batter)', 'qualified when two-way');
    assertEq(rankPoolLabel('Overall', null), 'Overall', 'plain for a one-role player');
    assertEq(rankPoolLabel('Overall', 'Goalie'), 'Overall (as Goalie)', 'the sport supplies the word');
});

test('rankPoolLabel: a POSITION chip is never re-labelled', () => {
    // "SP" already names its own pool; "SP (as Pitcher)" would say the same thing twice.
    assertEq(rankPoolLabel('SP', 'Pitcher'), 'SP', 'position chips are left alone');
    assertEq(rankPoolLabel('OF', 'Batter'), 'OF', 'even for a two-way player');
});

// ===== item 9: the pro-team schedule is read through a key-checked accessor ================ The abbreviations on every row come from this one response and nothing else, and the club ids are per-sport: MLB 17 is CIN, NFL 17 is NE. Read without checking whose schedule is in memory, a football payload left over from the previous league printed NE over a Cincinnati player - and then asked the crest host for mlb/500/NE.png, which 404s, so the row lost its badge too.
const NFL_SCHEDULE = { key: 'proTeamSchedules:ffl:2025', data: { settings: { proTeams: [{ id: 17, abbrev: 'NE' }] } } };

test('a schedule from another sport reads as absent, never as a plausible wrong club', () => {
    assertEq(proScheduleFor(NFL_SCHEDULE, 'flb', '2025'), null, 'MLB asking with an NFL store gets nothing');
    assert(proScheduleFor(NFL_SCHEDULE, 'ffl', '2025') !== null, 'and the league it belongs to still gets it');
});

test('a schedule from another YEAR of the same sport also reads as absent', () => {
    assertEq(proScheduleFor(NFL_SCHEDULE, 'ffl', '2026'), null, 'the key carries the year for a reason');
});

test('no schedule at all reads as absent rather than throwing', () => {
    assertEq(proScheduleFor(null, 'flb', '2026'), null, 'nothing stored');
    assertEq(proScheduleFor(undefined, 'flb', '2026'), null, 'nothing stored, the other way');
});

// A FAILED FETCH IS NOT A FETCH NOBODY MADE, and the leaderboard's lens reasons turn on the difference: fetchProTeamSchedules stores { key, data: null } when it fails, so collapsing the two into one data-or-null answer would leave a failed schedule reading as still loading, forever.
test('a failed fetch for THIS league is attempted, and still has no body', () => {
    const failed = { key: 'proTeamSchedules:flb:2026', data: null };
    assertEq(proScheduleAttemptedFor(failed, 'flb', '2026'), true, 'it was asked for');
    assertEq(proScheduleFor(failed, 'flb', '2026'), null, 'and it brought nothing back');
});

test('a fetch nobody has made is not attempted', () => {
    assertEq(proScheduleAttemptedFor(null, 'flb', '2026'), false, 'never asked');
    assertEq(proScheduleAttemptedFor(NFL_SCHEDULE, 'flb', '2026'), false, 'another league asking does not count as this one asking');
});

// THE ACCESSOR'S OTHER HALF: what happens once a schedule IS in hand. Every test above this line exercises the ABSENT case, and absence is exactly what playoffDensityRows returns early on - so the whole block above could stay green while the with-schedule path threw on its first line. It did: 56537d4 left a `schedules.key` reference behind when it replaced the store read, a ReferenceError unreachable until a real schedule arrived, and it killed every leaderboard re-render the moment the lazy fetch landed. The proof capture at the time staged a league with no pro-schedule.json, which is the branch that returns early. So this test's whole job is to REACH the line. It needs the form fields getLeagueParams reads (features.test.html carries them) and a store key spelling the same sport and year, or currentProSchedule answers null and we are back to testing absence by accident.
test('playoffDensityRows runs to an answer with a schedule in hand, rather than throwing', () => {
    const savedSchedule = AppState.proTeamSchedules;
    const savedApi = AppState.apiData;
    try {
        AppState.proTeamSchedules = {
            key: 'proTeamSchedules:flb:2025',
            data: { settings: { proTeams: [{ id: 17, abbrev: 'CIN' }] } }
        };
        // A roto league has no playoff matchups, so the answer is null - reached by RETURNING it, which is the point. The old code could not get as far as deciding that.
        AppState.apiData = { id: 12345, seasonId: 2025, schedule: [] };
        assertEq(playoffDensityRows(), null, 'a league with no playoff bracket answers null');
        assertEq(playoffDensityRows(), null, 'and answers the same on the cached second call');
    } finally {
        AppState.proTeamSchedules = savedSchedule;
        AppState.apiData = savedApi;
    }
});

test('playoffDensityRows still answers null when no schedule is in hand', () => {
    const savedSchedule = AppState.proTeamSchedules;
    const savedApi = AppState.apiData;
    try {
        // The guard's own case, kept beside the one above so the pair says which branch is which.
        AppState.proTeamSchedules = null;
        AppState.apiData = { id: 12345, seasonId: 2025, schedule: [] };
        assertEq(playoffDensityRows(), null, 'no schedule, no rows, no throw');
    } finally {
        AppState.proTeamSchedules = savedSchedule;
        AppState.apiData = savedApi;
    }
});

// ===== item 6: a week with no result is not a loss ======================================== The points branch stores POINTS in weeklyMatchWins and the 1/0.5/0 RESULT in weeklyMatchResult, and data.js withholds the result for a week nobody has played. Reading it with `|| 0` turned that absence into the loss branch, so an unplayed week counted as a defeat - while Team Rankings, which has skipped an undefined result since, read the same week as no game at all. Two surfaces, one league, two records. Two weeks in one row is the whole test: week 1 played and lost, week 2 posting points with no result yet. A correct reader records the first and skips the second.

function setupPointsWeeks(weeklyMatchWins, weeklyMatchResult) {
    AppState.isPointsLeague = true;
    AppState.timeframe = 'all';
    AppState.maxCompletedWeek = 2;
    AppState.regSeasonWeeks = 14;
    AppState.currentMatchup = 2;
    AppState.teamStats = [T(1, 'Alphas', weeklyMatchWins, {}, {}, weeklyMatchResult)];
}

test('buildStandingsExport: a points week with points but no result adds no loss', () => {
    setupPointsWeeks({ 1: 90, 2: 100 }, { 1: 0 });
    const { rows } = buildStandingsExport();
    assertEq(rows[0], [1, 'Alphas', 0, 1, 0, 0, 190], 'one real loss from week 1, week 2 skipped');
});

test('buildStandingsExport: the same week WITH a result is recorded', () => {
    setupPointsWeeks({ 1: 90, 2: 100 }, { 1: 0, 2: 1 });
    const { rows } = buildStandingsExport();
    assertEq(rows[0], [1, 'Alphas', 1, 1, 0, 1, 190], 'week 2 now counts as the win it is');
});

// A ZERO RESULT IS NOT AN ABSENT ONE, which is the distinction `|| 0` destroyed.
test('buildStandingsExport: a genuine 0 result is still a loss', () => {
    setupPointsWeeks({ 1: 0 }, { 1: 0 });
    AppState.maxCompletedWeek = 2;
    const { rows } = buildStandingsExport();
    assertEq(rows[0], [1, 'Alphas', 0, 1, 0, 0, 0], 'zero points, zero result, one loss');
});

test('buildRecapModel: a points week with no result adds no loss to the record', () => {
    setupRecapLeague();
    AppState.isPointsLeague = true;
    // Week 1 played and won, week 2 posting points with no result yet.
    AppState.teamStats = [
        T(1, 'Alphas', { 1: 100, 2: 110 }, {}, {}, { 1: 1 }),
        T(2, 'Bravos', { 1: 90, 2: 95 }, {}, {}, { 1: 0 })
    ];
    const m = buildRecapModel(2);
    const alphas = m.standings.find(r => r.name === 'Alphas');
    assertEq(alphas.record, '1-0-0', 'the unplayed week is not a loss');
    assertEq(alphas.points, 210, 'and its points still count');
});

// ===== item 13: two roster sources, and a third case that is neither ===================== Measured across the capture set: the ONE live Download All carries rosterForCurrentScoringPeriod on its schedule sides and nothing in teams[].roster; all three FINISHED leagues - one per sport - carry their roster ONLY in teams[].roster. ESPN attaches the side roster to the period it is serving, and an ended season serves none. Reading the sides alone therefore lost the roster on every finished season in every sport, which is what "No roster available for this team" was.
const SIDE_ROSTER = { entries: [{ playerId: 11, lineupSlotId: 0 }] };
const TEAM_ROSTER = { entries: [{ playerId: 99, lineupSlotId: 20 }] };

test('rostersFromPayload: a live payload reads the schedule sides', () => {
    const out = rostersFromPayload({
        draftDetail: { drafted: true },
        teams: [{ id: 1, valuesByStat: { 3: 100 } }],
        schedule: [{ home: { teamId: 1, rosterForCurrentScoringPeriod: SIDE_ROSTER }, away: { teamId: 2 } }]
    });
    assertEq(out.get(1), [{ playerId: 11, lineupSlotId: 0 }], 'the side roster');
});

test('rostersFromPayload: the sides WIN when both sources carry entries', () => {
    const out = rostersFromPayload({
        draftDetail: { drafted: true },
        teams: [{ id: 1, valuesByStat: { 3: 100 }, roster: TEAM_ROSTER }],
        schedule: [{ home: { teamId: 1, rosterForCurrentScoringPeriod: SIDE_ROSTER }, away: { teamId: 2 } }]
    });
    assertEq(out.get(1), [{ playerId: 11, lineupSlotId: 0 }], 'the period being served beats the snapshot');
});

test('rostersFromPayload: a finished payload falls back to teams[].roster', () => {
    const out = rostersFromPayload({
        draftDetail: { drafted: true },
        teams: [{ id: 1, valuesByStat: { 3: 100 }, roster: TEAM_ROSTER }],
        schedule: [{ home: { teamId: 1 }, away: { teamId: 2 }, winner: 'HOME' }]
    });
    assertEq(out.get(1), [{ playerId: 99, lineupSlotId: 20 }], 'the whole-team snapshot');
});

// THE CASE AN ENTRY COUNT CANNOT DECIDE. ESPN carries LAST season's final roster forward until the draft, in both fields - so a fallback that trusted whichever source had rows would answer a pre-draft league with last year's team and label it this year's (R5). Only the season state tells them apart, and before a draft the honest answer is no roster at all.
test('rostersFromPayload: a pre-draft league shows no roster from either source', () => {
    const out = rostersFromPayload({
        draftDetail: { drafted: false },
        teams: [{ id: 1, roster: TEAM_ROSTER }],
        schedule: [{ home: { teamId: 1, rosterForCurrentScoringPeriod: SIDE_ROSTER }, away: { teamId: 2 } }]
    });
    assertEq(out.size, 0, 'the carry-forward is last season and is not shown as this one');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
