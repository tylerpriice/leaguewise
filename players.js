import { AppState, ESPN_STAT_MAPS, POSITION_MAPS, SLOT_POSITION_MAPS, PITCHER_POSITIONS, PITCHING_IDS, GOALIE_IDS, AVERAGE_STATS, INVERSE_STATS } from './state.js';
import { escapeHtml, getNiceMax, setDebugContext, setActiveDebugKind, getTimeframeBounds, splitScoredAdvanced, percentileColor, attachDataTooltips, statValue, unwrapStats } from './utils.js';
import { fetchPlayerData, fetchPlayerWeeklyStats, fetchPlayersWeeklyStatsBulk } from './api.js';
// All ranking/percentile MATH lives in the pure, unit-tested rank engine (see its purity contract, tests in tests/rank-engine.test.html).
import {
    IP_STAT_ID, GAMES_PLAYED_IDS, MIN_PLAYING_TIME_FRACTION,
    inningsPitchedOf, opportunityGateFor,
    computeRotoRanks as engineComputeRotoRanks,
    computeCategoryBreakdown as engineComputeCategoryBreakdown,
    computeStatRankInPool, buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis
} from './rank-engine.js';

const RANK_COLORS = { 1: '#b8860b', 2: '#767676', 3: '#a4581e' }; // gold, silver, bronze
const RANK_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' }; // leaderboard Rank column, top 3 of the current pool
const WEEKLY_RANK_STAT_ID = '__weeklyrank__';

// Ranks this player against every other player with real eligibility in the STAT's own role (batters vs batters, pitchers vs pitchers) who has a value for this stat. Keyed off which role the stat itself belongs to (PITCHING_IDS), not the player's own primary position, so a two-way player's pitching stats get compared against pitchers and batting stats against batters, both correctly, regardless of which one happens to be their primary role.
function computeStatRank(player, sport, statId) {
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const isPitcherStat = pitchingIds.has(statId);
    const pool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitcherStat) && p.seasonTotals[statId] !== undefined);
    const inverse = (INVERSE_STATS[sport] || new Set()).has(statId);
    return computeStatRankInPool(pool, player.id, statId, inverse);
}

const GROUP_LABELS = {
    flb: { primary: 'Batters', secondary: 'Pitchers' },
    fhl: { primary: 'Skaters', secondary: 'Goalies' }
};

// Group tab membership (Batters vs Pitchers) has to be ELIGIBILITY-based, not based on a player's single PRIMARY role (ESPN's defaultPositionId, still used for the strict RP pool filter below). A genuine two-way player has one primary position but real, meaningful stats and eligibility in BOTH roles, and needs to show up in both tabs.
function matchesPlayerGroup(player, sport, wantPitchers) {
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    return wantPitchers
        ? player.eligiblePositions.some(pos => pitcherPositions.has(pos))
        : player.eligiblePositions.some(pos => !pitcherPositions.has(pos));
}

// Eligibility-based position filtering skews rankings toward dual-role "swingmen" (pitchers who both start and relieve) once the filter is RP specifically. A swingman accumulates SP-shaped counting stats (K, W, QS) far beyond what a true, dedicated reliever ever would, letting them dominate a "best RP" ranking despite not really being a reliever.
function matchesPositionFilter(p, posFilter) {
    if (posFilter === 'RP') return p.positionName === posFilter;
    return p.eligiblePositions.includes(posFilter);
}

// Roster-availability filter (AppState.playerAvailabilityFilter).
function matchesAvailability(p) {
    const mode = AppState.playerAvailabilityFilter || 'all';
    if (mode === 'rostered') return p.teamId != null;
    if (mode === 'fa') return p.teamId == null;
    return true;
}

// Outfield is the one case where the SAME real position is represented at two different granularities in ESPN's slot catalog. A generic OF slot (5) vs specific LF/CF/RF (8/9/10). And which one to show depends on which granularity this league's own roster actually uses.
const OF_SPECIFIC_SLOTS = new Set(["8", "9", "10"]);
const OF_GENERIC_SLOT = "5";
// The generic "P" slot (13) is redundant whenever a player also has the more specific SP (14) or RP (15). Any SP/RP is automatically P-eligible too, so showing "P/SP" doesn't add information.
const GENERIC_PITCHER_SLOT = "13";
const SPECIFIC_PITCHER_SLOTS = new Set(["14", "15"]);

// Canonical display order. Unrecognized names (shouldn't happen given SLOT_POSITION_MAPS) sort after everything else instead of disappearing.
const POSITION_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "DH", "P", "SP", "RP"];

function computeEligiblePositions(eligibleSlots, slotMap) {
    const activeSlots = AppState.leagueActiveSlots;
    const leagueUsesSpecificOF = activeSlots.size > 0 && Array.from(OF_SPECIFIC_SLOTS).some(s => activeSlots.has(s));
    const slotSet = new Set(eligibleSlots.map(s => s.toString()));
    const hasSpecificPitcherRole = Array.from(SPECIFIC_PITCHER_SLOTS).some(s => slotSet.has(s));

    const names = new Set();
    eligibleSlots.forEach(slot => {
        const slotStr = slot.toString();
        if (OF_SPECIFIC_SLOTS.has(slotStr) && !leagueUsesSpecificOF) return;
        if (slotStr === OF_GENERIC_SLOT && leagueUsesSpecificOF) return;
        if (slotStr === GENERIC_PITCHER_SLOT && hasSpecificPitcherRole) return;
        const name = slotMap[slot];
        if (name) names.add(name);
    });
    return Array.from(names).sort((a, b) => {
        const ia = POSITION_ORDER.indexOf(a), ib = POSITION_ORDER.indexOf(b);
        return (ia === -1 ? POSITION_ORDER.length : ia) - (ib === -1 ? POSITION_ORDER.length : ib);
    });
}

// Some names (BB, H, HR, OBP, SLG, K, W, SV, HLD, ERA) are reused between multiple ids in ESPN_STAT_MAPS.flb. Some of that is old/legacy ids ESPN doesn't actually use anymore.
function preferScoredDedup(ids, statMap) {
    const winnerByName = new Map();
    ids.forEach(id => {
        const name = statMap[id];
        const current = winnerByName.get(name);
        if (current === undefined || (!AppState.scoredStatIds.has(current) && AppState.scoredStatIds.has(id))) {
            winnerByName.set(name, id);
        }
    });
    return Array.from(winnerByName.values()).sort((a, b) => Number(a) - Number(b));
}

// Splits a group's stat ids into "scored" (the stats this league's settings actually use) and "advanced" (everything else ESPN happens to track) so the leaderboard can default to just the categories that matter for this league, with the rest tucked behind a toggle.
function statIdsForGroup(sport, group, groupPlayers) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const inGroup = Object.keys(statMap).filter(id => group === 'secondary' ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(inGroup, statMap);
    const withData = deduped.filter(id => groupPlayers.some(p => p.seasonTotals[id] !== undefined));
    return splitScoredAdvanced(withData);
}

// Real baseball fractional-innings notation. .1 means one out into the inning (1/3), .2 means two outs (2/3), NOT a true decimal (586 outs is "195.1", not "195.333").
function formatInnings(outs) {
    if (outs === undefined || outs === null) return '-';
    return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Reads AppState.playerGroup (which tab is currently active) rather than this player's own intrinsic primary role. Every caller of this function already only ever processes players scoped to the current group (via matchesPlayerGroup), so this correctly reads a two-way player's PITCHING games count while the Pitchers tab is active and their BATTING games count while the Batters tab is active, instead of always reading whichever role happens to be their primary one.
function gamesPlayedOf(p, sport) {
    const idKey = AppState.playerGroup === 'secondary' ? 'pitcher' : 'batter';
    return p.seasonTotals[GAMES_PLAYED_IDS[idKey]] || 0;
}

// Games played for batters, real innings pitched for pitchers. See inningsPitchedOf for why appearances don't work as a workload measure ACROSS pitching roles: a true reliever's 35-45+ appearances dwarf a full-time starter's ~14-20, even though the starter throws 2-3x the innings and produces far more fantasy value, so a games-based shrinkage measure lets high-appearance relievers and swingmen crowd out legitimate workhorse starters.
function workloadOf(p, sport) {
    return AppState.playerGroup === 'secondary' ? inningsPitchedOf(p) : gamesPlayedOf(p, sport);
}

// Shared impure→pure adapter: everything the engine's roto functions need, read once from AppState/league config. relevantStatIds is scoped to the CURRENT group's own role (AppState.playerGroup), not just "does anyone in groupPlayers have this stat defined". A two-way player (e.g.
function rotoContext(groupPlayers, sport, posFilter) {
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    return {
        relevantStatIds: Array.from(AppState.scoredStatIds).filter(id =>
            (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && groupPlayers.some(p => p.seasonTotals[id] !== undefined)),
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        isRpPool: posFilter === 'RP',
        requireMinPlayingTime: AppState.requireMinPlayingTime,
        workloadOf: p => workloadOf(p, sport),
        thresholdWorkloadOf: p => gamesPlayedOf(p, sport),
        statMap: ESPN_STAT_MAPS[sport] || {}
    };
}

// Replaces ESPN's raw "FPTS" (a generic points formula unrelated to this league's actual scoring settings, and batting-only) with a real Roto-style rank.
function computeRotoRanks(groupPlayers, sport, posFilter = null) {
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

// Single-player per-category breakdown of the same math, for the drill-down. See the engine's computeCategoryBreakdown.
function computeCategoryBreakdown(player, groupPlayers, sport, posFilter = null) {
    return engineComputeCategoryBreakdown(player, groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

function formatStatValue(val) {
    if (val === undefined || val === null) return '-';
    const num = Number(val);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(3) : num;
}

// Chart x-axis is labeled by MATCHUP number (see matchupNumberOfWeek), not raw week number. That's the thing a fantasy manager actually cares about ("how did this player do in each matchup").
function formatMatchupLabel(w) {
    return `M${w}`;
}

export function processPlayerData(rawData, sport) {
    const rawPlayers = rawData.players || [];
    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });
    const year = parseInt(document.getElementById('year').value, 10);

    return rawPlayers.map(entry => {
        const p = entry.player || {};
        const statLines = p.stats || [];

        // Match exact year to prevent historical leakage
        const actualSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year);
        const projSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === year);

        const teamId = entry.onTeamId > 0 ? entry.onTeamId : null;
        const team = teamId ? teamById[teamId] : null;
        const posMap = POSITION_MAPS[sport] || {};
        const primaryPositionName = posMap[p.defaultPositionId] || `Pos ${p.defaultPositionId}`;

        // eligibleSlots lists every roster slot this player actually qualifies for (a real multi-position player like a 2B/SS utility infielder, or a DH-capable corner infielder), not just their one default position.
        const slotMap = SLOT_POSITION_MAPS[sport];
        const eligiblePositions = slotMap && Array.isArray(p.eligibleSlots)
            ? computeEligiblePositions(p.eligibleSlots, slotMap)
            : [];
        if (eligiblePositions.length === 0) eligiblePositions.push(primaryPositionName);

        return {
            id: p.id ?? entry.id,
            name: p.fullName || 'Unknown Player',
            positionId: p.defaultPositionId,
            positionName: primaryPositionName,
            eligiblePositions,
            positionDisplay: eligiblePositions.join('/'),
            teamId,
            teamName: team ? team.name : 'Free Agent',
            teamColor: team ? AppState.teamColorMap[team.id] : null,
            seasonTotals: unwrapStats(actualSeason && actualSeason.stats),
            projectedTotals: unwrapStats(projSeason && projSeason.stats),
            appliedTotal: (actualSeason && actualSeason.appliedTotal) || 0,
            projectedAppliedTotal: (projSeason && projSeason.appliedTotal) || 0
        };
    });
}

// MLB/NHL report stats per game DAY (statSplitTypeId 5, one entry per scoringPeriodId), not per fantasy week. There's no single stat line to read for "week 3".
function weekOfScoringPeriod(scoringPeriodId) {
    return Math.max(1, Math.floor(scoringPeriodId / 7));
}

// Regular-season matchups are exactly 1 real week each, but a playoff ROUND can span multiple real weeks (playoffMatchupPeriodLength, e.g, a 2-week Round 1).
function matchupNumberOfWeek(week) {
    const regWeeks = AppState.regSeasonWeeks;
    if (week <= regWeeks) return week;

    const playoffLen = Math.max(1, AppState.apiData?.settings?.scheduleSettings?.playoffMatchupPeriodLength || 1);
    const lastPlayoffMatchup = Math.max(regWeeks, AppState.maxCompletedWeek);
    const computed = regWeeks + Math.ceil((week - regWeeks) / playoffLen);
    return Math.min(computed, lastPlayoffMatchup);
}

function sumStatsByGroup(sums, count, avgStatsForSport) {
    if (count === 0) return sums;
    const result = {};
    Object.keys(sums).forEach(statId => {
        result[statId] = avgStatsForSport.has(statId) ? sums[statId] / count : sums[statId];
    });
    return result;
}

// Rate stats can't be correctly aggregated by averaging each day's already-computed rate and dividing by day count. That weights a 1-AB day exactly the same as a 5-AB day, badly skewing the result.
function deriveBattingRateOverrides(sums) {
    const AB = sums["0"], H = sums["1"], TB = sums["8"];
    const BB = sums["10"] || 0, HBP = sums["12"] || 0, SF = sums["13"] || 0;
    const overrides = {};
    if (AB > 0 && H !== undefined) overrides["2"] = H / AB; // AVG
    if (AB > 0 && TB !== undefined) overrides["9"] = TB / AB; // SLG
    const obpDenom = (AB || 0) + BB + HBP + SF;
    if (obpDenom > 0 && H !== undefined) overrides["17"] = (H + BB + HBP) / obpDenom; // OBP
    if (overrides["17"] !== undefined && overrides["9"] !== undefined) overrides["18"] = overrides["17"] + overrides["9"]; // OPS
    return overrides;
}

// Sums raw per-week components (weeklySums, as built by processPlayerWeeklyHistory/ processBulkPlayerWeeklyHistory, Matchup# -> { sums: {statId: sum}, games }) across an arbitrary [startWeek, endWeek] range and runs the combined totals through the same sumStatsByGroup/deriveBattingRateOverrides derivation a single week does. A single week is just a range of one, so this is the ONLY place rate-stat math happens, shared by the single-player chart (processPlayerWeeklyHistory's own `weekly`, below) and the bulk leaderboard timeframe aggregation (getEffectivePlayerPool).
function aggregateStatsForWeekRange(weeklySums, startWeek, endWeek, sport) {
    const avgStatsForSport = AVERAGE_STATS[sport] || new Set();
    const sums = {};
    let games = 0;
    Object.keys(weeklySums).forEach(week => {
        const w = Number(week);
        if (w < startWeek || w > endWeek) return;
        games += weeklySums[week].games;
        Object.keys(weeklySums[week].sums).forEach(statId => {
            sums[statId] = (sums[statId] || 0) + weeklySums[week].sums[statId];
        });
    });
    return {
        ...sumStatsByGroup(sums, games, avgStatsForSport),
        ...(sport === 'flb' ? deriveBattingRateOverrides(sums) : {})
    };
}

// Groups a kona_player_info response's raw day-level stat lines into per-matchup-week raw sums (weeklySums). Shared building block for both processPlayerWeeklyHistory (one player) and processBulkPlayerWeeklyHistory (many players at once, Phase 2). The caller supplies whichever slice of rawData.players belongs to a single player.
function buildWeeklySums(playerStatLines, year) {
    // Only actual (statSourceId 0) per-day lines. ESPN's rest-of-season projections turned out to be unreliable/empty in practice and aren't used here anymore.
    const dayLines = playerStatLines.filter(s => s.seasonId === year && s.statSplitTypeId === 5 && s.statSourceId === 0 && s.scoringPeriodId);

    const weeklySums = {}; // matchup# -> { sums: {statId: sum}, games }
    dayLines.forEach(s => {
        const week = matchupNumberOfWeek(weekOfScoringPeriod(s.scoringPeriodId));
        if (!weeklySums[week]) weeklySums[week] = { sums: {}, games: 0 };

        weeklySums[week].games++;
        Object.keys(s.stats || {}).forEach(statId => {
            weeklySums[week].sums[statId] = (weeklySums[week].sums[statId] || 0) + (statValue(s.stats[statId]) || 0);
        });
    });
    return weeklySums;
}

export function processPlayerWeeklyHistory(rawData, sport) {
    // A player can show up as more than one entry in rawData.players if they changed teams (trade/waiver claim) mid-season. Each entry only carries the stat lines for its own roster stint.
    const statLines = (rawData.players || []).flatMap(e => (e.player && e.player.stats) || []);
    const year = parseInt(document.getElementById('year').value, 10);
    const weeklySums = buildWeeklySums(statLines, year);

    const weekly = {};
    Object.keys(weeklySums).forEach(week => {
        weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
    });

    return { weekly, weeklySums };
}

// Bulk counterpart to processPlayerWeeklyHistory. Processes a fetchPlayersWeeklyStatsBulk response (many players at once) and populates AppState.playerWeeklyCache directly for every player found, rather than returning one player's { weekly, weeklySums }. Groups by player id first (a bulk response can, same as the single-player one, contain multiple entries for the same player if they changed teams mid-season), then reuses the exact same per-week summing (buildWeeklySums) and derivation (aggregateStatsForWeekRange) processPlayerWeeklyHistory uses. A player fetched here and later opened individually (openPlayerDetail) is a cache hit, no second fetch.
function processBulkPlayerWeeklyHistory(rawData, sport) {
    const year = parseInt(document.getElementById('year').value, 10);
    const statLinesByPlayerId = new Map();
    (rawData.players || []).forEach(entry => {
        const p = entry.player || {};
        const id = p.id ?? entry.id;
        if (id === undefined || id === null) return;
        if (!statLinesByPlayerId.has(id)) statLinesByPlayerId.set(id, []);
        statLinesByPlayerId.get(id).push(...(p.stats || []));
    });

    statLinesByPlayerId.forEach((statLines, playerId) => {
        const weeklySums = buildWeeklySums(statLines, year);
        const weekly = {};
        Object.keys(weeklySums).forEach(week => {
            weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
        });
        AppState.playerWeeklyCache[playerId] = { weekly, weeklySums };
    });
}

// A player needs real weekly data cached (see AppState.playerWeeklyCache/ processBulkPlayerWeeklyHistory) before a windowed timeframe can be applied to them. Used both to decide whether the leaderboard needs to kick off a bulk fetch (renderPlayerLeaderboard) and, here, to decide who's actually excludable-vs-includable in the windowed pool itself.
function hasCachedWeeklyData(p) {
    return !!AppState.playerWeeklyCache[p.id];
}

// Returns AppState.playerData unchanged when the shared timeframe is the full season (no aggregation needed, seasonTotals already IS the season sum). Otherwise returns shallow clones with seasonTotals replaced by the windowed aggregate for every player with cached weekly data, excluding anyone not yet cached (bulk fetch still in flight, or genuinely no weekly data) rather than showing them with misleading season-total numbers under a windowed heading.
let poolCache = null;

// Whether the currently-selected timeframe's resolved week range covers the ENTIRE available season (weeks 1 through maxCompletedWeek), not just whether it's literally 'all'.
function isFullSeasonTimeframe() {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    return start === 1 && end === AppState.maxCompletedWeek;
}

function getEffectivePlayerPool(sport) {
    if (isFullSeasonTimeframe()) return AppState.playerData;

    const weeklyCacheSize = Object.keys(AppState.playerWeeklyCache).length;
    if (poolCache && poolCache.sport === sport && poolCache.timeframe === AppState.timeframe &&
        poolCache.playerDataRef === AppState.playerData && poolCache.weeklyCacheSize === weeklyCacheSize) {
        return poolCache.result;
    }

    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const result = AppState.playerData
        .filter(hasCachedWeeklyData)
        .map(p => ({ ...p, seasonTotals: aggregateStatsForWeekRange(AppState.playerWeeklyCache[p.id].weeklySums, start, end, sport) }));

    poolCache = { sport, timeframe: AppState.timeframe, playerDataRef: AppState.playerData, weeklyCacheSize, result };
    return result;
}

function buildPositionFilterOptions(sport) {
    const select = document.getElementById('player-position-filter');
    if (!select) return;
    const currentVal = select.value;
    const wantPitchers = AppState.playerGroup === 'secondary';
    const groupPlayers = AppState.playerData.filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    let positions = Array.from(new Set(groupPlayers.flatMap(p => p.eligiblePositions)));

    // A two-way player's off-role eligibility (batting positions while viewing Pitchers, or SP/RP while viewing Batters) has no meaning as a position filter here. matchesPlayerGroup already lets them into this list via their real SAME-role eligibility, so just drop the other role's entries from the dropdown itself.
    positions = positions.filter(pos => pitcherPositions.has(pos) === wantPitchers);

    if (wantPitchers) {
        // SP before RP specifically, not alphabetical. Everything else (if any) falls back alphabetically after those two.
        const order = ['SP', 'RP'];
        positions.sort((a, b) => {
            const ai = order.indexOf(a), bi = order.indexOf(b);
            if (ai !== -1 || bi !== -1) return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
            return a.localeCompare(b);
        });
    } else {
        positions.sort();
    }

    select.innerHTML = '<option value="ALL">All Positions</option>' +
        positions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

    if (positions.includes(currentVal)) select.value = currentVal;
    else AppState.playerPositionFilter = 'ALL';
}

function renderGroupToggle(sport) {
    const container = document.getElementById('player-group-toggle');
    if (!container) return;
    const labels = GROUP_LABELS[sport] || GROUP_LABELS.flb;

    container.innerHTML = `
        <button class="group-toggle-btn${AppState.playerGroup === 'primary' ? ' active' : ''}" data-group="primary">${labels.primary}</button>
        <button class="group-toggle-btn${AppState.playerGroup === 'secondary' ? ' active' : ''}" data-group="secondary">${labels.secondary}</button>
    `;

    container.querySelectorAll('.group-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (AppState.playerGroup === btn.dataset.group) return;
            AppState.playerGroup = btn.dataset.group;
            buildPositionFilterOptions(sport);
            renderPlayerLeaderboard();
        });
    });
}

function renderAdvancedStatsToggle(advancedCount) {
    const container = document.getElementById('advanced-stats-toggle');
    if (!container) return;

    if (advancedCount === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <label><input type="checkbox" id="advanced-stats-checkbox"${AppState.showAdvancedStats ? ' checked' : ''}> Advanced Stats (${advancedCount})</label>
    `;
    container.querySelector('#advanced-stats-checkbox').addEventListener('change', (e) => {
        AppState.showAdvancedStats = e.target.checked;
        renderPlayerLeaderboard();
    });
}

function renderMinPlayingTimeToggle(groupPlayers, sport) {
    const container = document.getElementById('min-playing-time-toggle');
    if (!container || AppState.isPointsLeague) {
        if (container) container.innerHTML = '';
        return;
    }

    // The exclusion threshold is games played for everyone now (see computeRotoRanks' own comment).
    const fractionPct = Math.round(MIN_PLAYING_TIME_FRACTION * 100);
    const maxGames = Math.max(0, ...groupPlayers.map(p => gamesPlayedOf(p, sport)));
    const tooltipText = `Needs ${Math.round(maxGames * MIN_PLAYING_TIME_FRACTION)}+ games played to be ranked (${fractionPct}% of the leader's games).`;
    container.innerHTML = `
        <label><input type="checkbox" id="min-playing-time-checkbox"${AppState.requireMinPlayingTime ? ' checked' : ''}> Minimum Games Played</label>
        <span class="tooltip tooltip-bottom">ⓘ
            <span class="tooltiptext">${tooltipText}</span>
        </span>
    `;
    container.querySelector('#min-playing-time-checkbox').addEventListener('change', (e) => {
        AppState.requireMinPlayingTime = e.target.checked;
        renderPlayerLeaderboard();
    });
}

// Built once and reused. Appended to <body> (not the scrolling leaderboard table) specifically so it can never get clipped by a table/column's overflow, unlike the old in-header tooltip that was getting cut off mid-sentence.
function ensureRankExplainerModal() {
    let overlay = document.getElementById('rank-modal-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'rank-modal-overlay';
    overlay.className = 'rank-modal-overlay';
    overlay.innerHTML = `
        <div class="rank-modal-content">
            <button type="button" class="rank-modal-close" id="rank-modal-close-btn">&times;</button>
            <h3>How Rank is calculated</h3>
            <div class="rank-modal-subtitle" id="rank-modal-subtitle"></div>

            <div class="rank-modal-step">
                <div class="rank-modal-step-num">1</div>
                <div class="rank-modal-step-body">
                    <h4>Your league's scored categories</h4>
                    <p>Pulled live from your league's own scoring settings.</p>
                    <div class="rank-modal-category-list" id="rank-modal-categories"></div>
                </div>
            </div>

            <div class="rank-modal-step">
                <div class="rank-modal-step-num">2</div>
                <div class="rank-modal-step-body">
                    <h4>Percentile per category</h4>
                    <p id="rank-modal-pool-note"></p>
                </div>
            </div>

            <div class="rank-modal-step">
                <div class="rank-modal-step-num">3</div>
                <div class="rank-modal-step-body">
                    <h4>Adjusted for playing time</h4>
                    <p id="rank-modal-shrinkage-note"></p>
                </div>
            </div>

            <div class="rank-modal-step">
                <div class="rank-modal-step-num">4</div>
                <div class="rank-modal-step-body">
                    <h4>Averaged and ranked</h4>
                    <p>All adjusted percentiles are averaged into one score per player, then everyone is ranked by that score.</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
    });
    overlay.querySelector('#rank-modal-close-btn').addEventListener('click', () => overlay.classList.remove('open'));

    return overlay;
}

function openRankExplainer(sport, rotoRanks, posFilter) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    const inverseSet = INVERSE_STATS[sport] || new Set();
    const roleLabel = wantPitchers ? 'Pitchers' : 'Batters';
    const isFiltered = posFilter && posFilter !== 'ALL';
    // "same-role peers" (all Batters/Pitchers) only holds with no position filter. Filtering to a position rescopes the comparison pool to just that position's players (see rankPool in renderPlayerLeaderboard), so the explanation needs to say so, not describe the unfiltered case while a filtered comparison is what's actually happening.
    const isRpPool = posFilter === 'RP';
    const poolLabel = isFiltered ? `${posFilter}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}` : `All ${roleLabel}`;
    const examplePos = wantPitchers ? 'SP' : 'SS';

    const categoryIds = preferScoredDedup(
        Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)),
        statMap
    ).filter(id => AppState.scoredStatIds.has(id));

    const categoryChips = categoryIds.map(id => {
        const inverse = inverseSet.has(id);
        const opportunity = opportunityGateFor(id, isRpPool) ? ' *' : '';
        // Same "(as K/9)" labeling the drill-down breakdown uses. Within the RP pool, K is compared as a rate, and the chip shouldn't imply a raw total is what's ranked.
        const rateNote = (isRpPool && id === '48') ? ' (as K/9)' : '';
        return `<span class="rank-modal-category-chip${inverse ? ' inverse' : ''}">${escapeHtml(statMap[id])}${rateNote}${inverse ? ' ↓' : ''}${opportunity}</span>`;
    }).join('');
    const hasOpportunityNote = categoryIds.some(id => opportunityGateFor(id, isRpPool));

    const overlay = ensureRankExplainerModal();
    overlay.querySelector('#rank-modal-subtitle').textContent =
        `${poolLabel} • ranked against ${rotoRanks.total} player${rotoRanks.total === 1 ? '' : 's'}${isFullSeasonTimeframe() ? '' : ' • using stats from the selected timeframe'}`;
    overlay.querySelector('#rank-modal-categories').innerHTML =
        (categoryChips || '<em>No scored categories found for this group.</em>') +
        (hasOpportunityNote ? '<div style="width:100%; font-size:11px; color:var(--text-subtle); margin-top:4px;">* Only scored for players with a real chance to earn it (e.g. save chances for SV). Skipped entirely for anyone locked out of the role.</div>' : '');
    overlay.querySelector('#rank-modal-pool-note').textContent = isFiltered
        ? `Filtered to ${posFilter}: ranked only against other ${posFilter}${isRpPool ? ' (primary role, not just eligibility: a swingman who mostly starts isn\'t compared as an RP)' : '-eligible'} ${roleLabel.toLowerCase()}. Percentile is the percentage of that pool each value beats (100 = best, 0 = worst). Every category counts equally.`
        : `No position filter applied. Ranked against all ${roleLabel.toLowerCase()}. Filter to a specific position (e.g. ${examplePos}) to compare only against players eligible there. Percentile is the percentage of the pool each value beats (100 = best, 0 = worst). Every category counts equally.`;
    const thresholdFractionPct = Math.round(MIN_PLAYING_TIME_FRACTION * 100);
    const minGamesNote = `The "Minimum Games Played" toggle, when checked, removes anyone under ${thresholdFractionPct}% of the leader's games played from Rank entirely`;
    // RP is the one pool where shrinkage is skipped and K is compared as K/9 (see computeRotoRanks). The generic pitcher wording would actively misdescribe it.
    overlay.querySelector('#rank-modal-shrinkage-note').textContent = isRpPool
        ? `RP is the one pool where no Playing-Time Factor is applied. Innings pitched isn't a comparable workload measure between true relievers and SP/RP swingmen making spot starts, so every reliever's percentiles count at full value. K is also compared as a rate (K/9) instead of a raw strikeout total, so throwing more innings doesn't win the category by itself. ${minGamesNote}.`
        : wantPitchers
            ? `Percentile is pulled toward 50 (the average) by a Playing-Time Factor based on innings pitched versus the pool leader's. ${minGamesNote} (a separate, role-neutral activity check, not innings-based).`
            : `Percentile is pulled toward 50 (the average) by a Playing-Time Factor based on games played versus the pool leader's. ${minGamesNote}.`;

    overlay.classList.add('open');
}

const LOADING_MESSAGES = [
    'Waking up the free agents...',
    'Counting bench warmers...',
    'Untangling stat lines...',
    'Herding roster spots...',
    'Almost there...'
];

// A purely cosmetic "fake" progress indicator. There's no real byte-level progress signal available from a single fetch() to ESPN's player-pool endpoint (or from the bulk weekly-stats fetch, its other caller), so this eases toward, but never quite reaches, 90% on a fixed curve.
function showPlayerLoadingProgress(container, messages = LOADING_MESSAGES) {
    container.innerHTML = `
        <div class="player-loading-progress">
            <div class="player-loading-progress-icon">📊</div>
            <div class="player-loading-progress-message">${messages[0]}</div>
            <div class="player-loading-progress-track">
                <div class="player-loading-progress-fill"></div>
            </div>
        </div>
    `;

    const fillEl = container.querySelector('.player-loading-progress-fill');
    const messageEl = container.querySelector('.player-loading-progress-message');
    const startTime = performance.now();
    let messageIndex = 0;
    let stopped = false;
    let rafId = null;

    const tick = () => {
        if (stopped) return;
        const elapsedSec = (performance.now() - startTime) / 1000;
        const pct = 90 * (1 - Math.exp(-elapsedSec / 2.2));
        fillEl.style.width = pct + '%';
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const messageTimer = setInterval(() => {
        if (messageIndex >= messages.length - 1) return;
        messageIndex++;
        messageEl.classList.add('fading');
        setTimeout(() => {
            if (stopped) return;
            messageEl.textContent = messages[messageIndex];
            messageEl.classList.remove('fading');
        }, 220);
    }, 1600);

    const stop = () => {
        stopped = true;
        cancelAnimationFrame(rafId);
        clearInterval(messageTimer);
    };

    return {
        stop,
        finish: () => {
            stop();
            fillEl.style.width = '100%';
            messageEl.classList.remove('fading');
            messageEl.textContent = 'Done!';
            return new Promise(resolve => setTimeout(resolve, 350));
        }
    };
}

// One shared in-flight fetch for the full player pool, so the Player Metrics tab's open path can await the SAME request a background prefetch already started (see prefetchPlayerData) instead of duplicating it.
let playerPoolFetch = null;

function ensurePlayerDataLoaded(sport) {
    if (AppState.playerDataLoaded) return Promise.resolve();
    if (!playerPoolFetch || playerPoolFetch.apiDataRef !== AppState.apiData) {
        const apiDataRef = AppState.apiData;
        const promise = (async () => {
            const raw = await fetchPlayerData();
            if (AppState.apiData !== apiDataRef) return; // superseded by a newer league/year fetch
            setDebugContext('player-pool', raw);
            AppState.playerData = processPlayerData(raw, sport);
            AppState.playerDataLoaded = true;
            buildPositionFilterOptions(sport);
        })();
        // A failed fetch must not poison every later attempt with the same rejected promise. Clear the slot so the next call starts a fresh request.
        promise.catch(() => {
            if (playerPoolFetch && playerPoolFetch.promise === promise) playerPoolFetch = null;
        });
        playerPoolFetch = { apiDataRef, promise };
    }
    return playerPoolFetch.promise;
}

// Fire-and-forget warm-up, called as soon as league data lands (see processCoreData in data.js). By the time the Player Metrics tab is first clicked, the ~5s pool fetch is usually already finished (or well underway), so the tab opens near-instantly instead of paying the whole ESPN round-trip on click.
export function prefetchPlayerData() {
    if (!AppState.apiData || AppState.playerDataLoaded) return;
    const sport = document.getElementById('sport').value;
    ensurePlayerDataLoaded(sport)
        .then(() => {
            // Chain the bulk weekly-stats fetch right behind the pool fetch. The Rank column's trend arrows need it, and starting it only on the leaderboard's own first render meant the arrows popped in a few seconds AFTER the tab opened.
            if (AppState.playerDataLoaded) ensureLeaderboardWeeklyDataLoaded(sport);
        })
        .catch(() => {});
}

export async function loadPlayerTabIfNeeded() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    if (!AppState.apiData) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }

    if (AppState.playerDataLoaded) {
        renderPlayerLeaderboard();
        return;
    }

    const sport = document.getElementById('sport').value;
    const progress = showPlayerLoadingProgress(container);
    try {
        await ensurePlayerDataLoaded(sport);
        // The awaited fetch can resolve as a stale no-op if a new league fetch superseded it mid-flight (see ensurePlayerDataLoaded). One retry covers that narrow window.
        if (!AppState.playerDataLoaded) await ensurePlayerDataLoaded(sport);
        await progress.finish();
        renderPlayerLeaderboard();
    } catch (err) {
        progress.stop();
        container.innerHTML = `<div class="player-loading">Couldn't load player data: ${err.message}</div>`;
    }
}

let bulkWeeklyFetchInFlight = false;
// Set once a bulk fetch attempt fails, so a failure shows a stable error instead of silently retrying on every re-render (search keystrokes, filter changes, etc, all call renderPlayerLeaderboard). Reset on a genuine new league/season fetch (see processCoreData).
let bulkWeeklyFetchFailed = false;

// True once every "real" player (has at least one defined season stat, skips the bulk of a raw ESPN player pool that's genuinely inactive/zero-stat, which getEffectivePlayerPool excludes anyway) has cached weekly data, which a windowed timeframe needs to compute anything for them.
function leaderboardWeeklyDataReady() {
    return AppState.playerData.every(p =>
        Object.keys(p.seasonTotals || {}).length === 0 || AppState.playerWeeklyCache[p.id]);
}

// Bulk-fetches weekly data for every real player still missing it, then re-renders the leaderboard.
async function ensureLeaderboardWeeklyDataLoaded(sport) {
    if (bulkWeeklyFetchInFlight) return;
    const missingIds = AppState.playerData
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id])
        .map(p => p.id);
    if (missingIds.length === 0) return;

    bulkWeeklyFetchInFlight = true;
    try {
        const raw = await fetchPlayersWeeklyStatsBulk(missingIds);
        // Still the pool context (a bulk weekly fetch to fill in the leaderboard, not a single player's own drill-down). See setDebugContext's kind note above.
        setDebugContext('player-pool', raw);
        processBulkPlayerWeeklyHistory(raw, sport);
        // Any requested player the response didn't include at all (no game logs this season) gets an empty stub. Without one, leaderboardWeeklyDataReady() would stay false forever, and every re-render would re-trigger this whole bulk fetch in a loop now that renderPlayerLeaderboard also fires it in the background for the trend arrows.
        missingIds.forEach(id => {
            if (!AppState.playerWeeklyCache[id]) AppState.playerWeeklyCache[id] = { weekly: {}, weeklySums: {} };
        });
        bulkWeeklyFetchFailed = false;
    } catch (err) {
        console.error('Failed to load weekly stats for the leaderboard timeframe:', err);
        bulkWeeklyFetchFailed = true;
    } finally {
        bulkWeeklyFetchInFlight = false;
    }
    renderPlayerLeaderboard();
}

// Called on a genuine new league/season fetch (see processCoreData in data.js). A fetch failure from a previous league/season shouldn't permanently block the new one from trying again.
export function resetLeaderboardWeeklyFetchState() {
    bulkWeeklyFetchFailed = false;
}

// The leaderboard's sort, in place, per the current AppState sort selection. Shared between the table render and buildLeaderboardExportModel so an export is always ordered exactly like the table it mirrors.
function sortLeaderboardPlayers(players, rotoRanks, sport) {
    const sortStat = AppState.playerSortStat;
    const dir = AppState.playerSortDir === 'asc' ? 1 : -1;
    const stringSortKeys = { name: 'name', teamName: 'teamName', positionName: 'positionDisplay' };
    players.sort((a, b) => {
        if (stringSortKeys[sortStat]) return a[stringSortKeys[sortStat]].localeCompare(b[stringSortKeys[sortStat]]) * dir;
        if (sortStat === 'rotoScore') return ((rotoRanks.scores.get(a.id) || 0) - (rotoRanks.scores.get(b.id) || 0)) * dir;
        if (sortStat === 'gp') return (gamesPlayedOf(a, sport) - gamesPlayedOf(b, sport)) * dir;
        if (sortStat === 'ip') return ((a.seasonTotals[IP_STAT_ID] || 0) - (b.seasonTotals[IP_STAT_ID] || 0)) * dir;
        // Before the season starts (or before a player's first game), appliedTotal is 0 for everyone. Fall back to ESPN's projected total so "highest fantasy points" still produces a meaningful ranking instead of the raw fetch order.
        const av = sortStat === 'total' ? (a.appliedTotal || a.projectedAppliedTotal || 0) : (a.seasonTotals[sortStat] || 0);
        const bv = sortStat === 'total' ? (b.appliedTotal || b.projectedAppliedTotal || 0) : (b.seasonTotals[sortStat] || 0);
        return (av - bv) * dir;
    });
}

// Structured snapshot of the leaderboard exactly as currently configured. Group tab, search, position filter, sort direction/column, Minimum Games toggle, and the shared timeframe all apply, so what exports is what's on screen.
export function buildLeaderboardExportModel(includeAdvanced = AppState.showAdvancedStats) {
    if (!AppState.playerDataLoaded) return null;
    if (!isFullSeasonTimeframe() && !leaderboardWeeklyDataReady()) return null;

    const sport = document.getElementById('sport').value;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const wantPitchers = AppState.playerGroup === 'secondary';
    const groupPlayers = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const { scored, advanced } = statIdsForGroup(sport, AppState.playerGroup, groupPlayers);
    const statIds = includeAdvanced ? [...scored, ...advanced] : scored;

    const query = AppState.playerSearchQuery.trim().toLowerCase();
    const posFilter = AppState.playerPositionFilter;
    let players = groupPlayers.filter(p => {
        if (query && !p.name.toLowerCase().includes(query)) return false;
        if (posFilter !== 'ALL' && !matchesPositionFilter(p, posFilter)) return false;
        if (!matchesAvailability(p)) return false;
        return true;
    });

    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = !AppState.isPointsLeague ? computeRotoRanks(rankPool, sport, posFilter) : null;
    if (rotoRanks) players = players.filter(p => rotoRanks.ranks.has(p.id));
    // Same default-sort normalization renderPlayerLeaderboard applies. An export taken before the leaderboard's first render (the pool prefetches in the background) would otherwise sort a category league by the meaningless points 'total' default instead of Rank.
    if (!AppState.isPointsLeague && AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }
    sortLeaderboardPlayers(players, rotoRanks, sport);

    const exportCell = (val) => {
        if (val === undefined || val === null) return '';
        const num = Number(val);
        if (!Number.isFinite(num)) return '';
        return (num % 1 !== 0) ? +num.toFixed(3) : num;
    };

    const headers = [
        'Player', 'Team', 'Pos',
        ...(AppState.isPointsLeague ? ['Total'] : ['Rank', 'Rank Score']),
        'GP',
        ...(wantPitchers ? ['IP'] : []),
        ...statIds.map(id => statMap[id])
    ];
    const rows = players.map(p => [
        p.name, p.teamName, p.positionDisplay,
        ...(AppState.isPointsLeague
            ? [exportCell(p.appliedTotal)]
            : [rotoRanks.ranks.get(p.id), +(rotoRanks.scores.get(p.id) || 0).toFixed(1)]),
        exportCell(gamesPlayedOf(p, sport)) || 0,
        ...(wantPitchers ? [p.seasonTotals[IP_STAT_ID] !== undefined ? +(p.seasonTotals[IP_STAT_ID] / 3).toFixed(2) : ''] : []),
        ...statIds.map(id => exportCell(p.seasonTotals[id]))
    ]);

    return { headers, rows };
}

export function renderPlayerLeaderboard() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container || !AppState.playerDataLoaded) return;

    const sport = document.getElementById('sport').value;
    renderGroupToggle(sport);

    if (!isFullSeasonTimeframe() && !leaderboardWeeklyDataReady()) {
        if (bulkWeeklyFetchFailed) {
            container.innerHTML = '<div class="player-loading">Couldn\'t load weekly stats for this timeframe. Try re-fetching league data, or switch back to "Regular Season + Playoffs".</div>';
            return;
        }
        showPlayerLoadingProgress(container, [
            'Fetching weekly splits...',
            'Aggregating by week...',
            'Recalculating ranks...',
            'Almost there...'
        ]);
        ensureLeaderboardWeeklyDataLoaded(sport);
        return;
    }

    const statMap = ESPN_STAT_MAPS[sport] || {};
    const wantPitchers = AppState.playerGroup === 'secondary';
    const groupPlayers = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const { scored, advanced } = statIdsForGroup(sport, AppState.playerGroup, groupPlayers);
    const statIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;

    const query = AppState.playerSearchQuery.trim().toLowerCase();
    const posFilter = AppState.playerPositionFilter;

    let players = groupPlayers.filter(p => {
        if (query && !p.name.toLowerCase().includes(query)) return false;
        if (posFilter !== 'ALL' && !matchesPositionFilter(p, posFilter)) return false;
        if (!matchesAvailability(p)) return false;
        return true;
    });

    // "Total" (ESPN's real appliedTotal) only exists for points-format leagues.
    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = !AppState.isPointsLeague ? computeRotoRanks(rankPool, sport, posFilter) : null;

    // rotoRanks.ranks already only contains players who cleared the minimum-playing-time threshold when that's required (see candidatePlayers in computeRotoRanks). Hide anyone who didn't from the table entirely, rather than showing a row with a "Min GP" placeholder no one asked to see.
    if (rotoRanks) players = players.filter(p => rotoRanks.ranks.has(p.id));

    renderAdvancedStatsToggle(advanced.length);
    renderMinPlayingTimeToggle(rankPool, sport);
    if (!AppState.isPointsLeague && AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }

    sortLeaderboardPlayers(players, rotoRanks, sport);

    if (players.length === 0) {
        container.innerHTML = '<div class="player-loading">No players match your search/filter.</div>';
        return;
    }

    const sortArrow = (key) => AppState.playerSortStat === key ? (AppState.playerSortDir === 'asc' ? ' ▲' : ' ▼') : '';

    // Medals for the current pool's top 3 (the ranks are already scoped to the active position filter via rankPool, so "top 3 SS" gets medals under an SS filter) plus weekly-form arrows (see buildMatchupTrendIcons). Both live in the Rank column, which points leagues don't have.
    const trendIcons = AppState.isPointsLeague ? new Map() : buildMatchupTrendIcons(players, sport);
    const rankExtrasFor = (p) => {
        const medal = RANK_MEDALS[rotoRanks.ranks.get(p.id)] || '';
        const trend = trendIcons.get(p.id);
        const trendHtml = trend
            ? `<span class="trend-icon trend-${trend.dir}" title="${escapeHtml(trend.tip)}">${trend.dir === 'up' ? '↗' : '↘'}</span>`
            : '';
        return (medal || trendHtml) ? ` ${medal}${trendHtml}` : '';
    };

    let html = `
        <table class="player-table">
            <thead>
                <tr>
                    <th class="sortable" data-sort="name">Player${sortArrow('name')}</th>
                    <th class="sortable" data-sort="teamName">Team${sortArrow('teamName')}</th>
                    <th class="sortable" data-sort="positionName">Pos${sortArrow('positionName')}</th>
                    ${AppState.isPointsLeague ? `<th class="sortable" data-sort="total">Total${sortArrow('total')}</th>` : `<th class="sortable" data-sort="rotoScore"><span class="rank-th-label">Rank${posFilter !== 'ALL' ? ` (${escapeHtml(posFilter)})` : ''}${sortArrow('rotoScore')}<button type="button" id="rank-explainer-trigger" class="rank-explainer-trigger">ⓘ</button></span></th>`}
                    <th class="sortable" data-sort="gp">GP${sortArrow('gp')}</th>
                    ${wantPitchers ? `<th class="sortable" data-sort="ip">IP${sortArrow('ip')}</th>` : ''}
                    ${statIds.map(id => `<th class="sortable" data-sort="${id}">${escapeHtml(statMap[id])}${sortArrow(id)}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
    `;

    players.forEach(p => {
        html += `
            <tr class="player-row" data-player-id="${p.id}">
                <td class="player-col-name">${escapeHtml(p.name)}</td>
                <td>${p.teamColor ? `<span class="legend-color" style="background:${p.teamColor};width:10px;height:10px;"></span>` : ''}${escapeHtml(p.teamName)}</td>
                <td>${escapeHtml(p.positionDisplay)}</td>
                ${AppState.isPointsLeague ? `<td>${p.appliedTotal.toFixed(1)}</td>` : `<td>#${rotoRanks.ranks.get(p.id)} of ${rotoRanks.total}${rankExtrasFor(p)}</td>`}
                <td>${formatStatValue(gamesPlayedOf(p, sport))}</td>
                ${wantPitchers ? `<td>${formatInnings(p.seasonTotals[IP_STAT_ID])}</td>` : ''}
                ${statIds.map(id => `<td>${formatStatValue(p.seasonTotals[id])}</td>`).join('')}
            </tr>
        `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;

    container.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (AppState.playerSortStat === key) {
                AppState.playerSortDir = AppState.playerSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                AppState.playerSortStat = key;
                AppState.playerSortDir = 'desc';
            }
            renderPlayerLeaderboard();
        });
    });

    container.querySelectorAll('.player-row').forEach(row => {
        row.addEventListener('click', () => openPlayerDetail(parseInt(row.dataset.playerId, 10)));
    });

    const explainerTrigger = document.getElementById('rank-explainer-trigger');
    if (explainerTrigger) {
        explainerTrigger.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also trigger the "Rank" column's sort click
            openRankExplainer(sport, rotoRanks, posFilter);
        });
    }

    // The Rank column's weekly-form arrows need per-week data for the whole pool. When it isn't cached yet (a full-season timeframe never needed it for the table itself), fetch it quietly in the background. The completion re-render pops the arrows in.
    if (!AppState.isPointsLeague && !leaderboardWeeklyDataReady() && !bulkWeeklyFetchFailed) {
        ensureLeaderboardWeeklyDataLoaded(sport);
    }
}

// preserveView is true when main.js is reopening the SAME player after a "Fetch Data" refresh. Comparing against AppState.selectedPlayerId to detect that doesn't work, since processCoreData() (called by the fetch, before this runs) already wipes it to null, making every reopen look like a switch to a new player.
export async function openPlayerDetail(playerId, preserveView = false) {
    if (!AppState.playerData.some(p => p.id === playerId)) return;
    const sport = document.getElementById('sport').value;

    // Only reset the drill-down's own view state (selected stat, rank pool, breakdown open/ closed) when switching to a genuinely different player. Reopening the SAME player should keep showing whatever the user had selected instead of silently snapping back to the default "Matchup Score" view.
    if (!preserveView) {
        AppState.playerDetailStat = null;
        AppState.playerDetailRankPool = 'Overall';
        AppState.playerDetailRankBreakdownOpen = false;
    }
    AppState.selectedPlayerId = playerId;

    document.getElementById('player-toolbar').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'none';
    const detailContainer = document.getElementById('player-detail-container');
    detailContainer.style.display = 'flex';
    detailContainer.innerHTML = '<div class="player-loading">Loading player history...</div>';
    // Switch the Diagnostic Data panel to this player's context immediately. Even before the fetch below resolves (or even if it's skipped entirely because this player's weekly data is already cached), so the panel always matches the drill-down that's actually on screen.
    setActiveDebugKind('player-detail');

    if (!AppState.playerWeeklyCache[playerId]) {
        try {
            const raw = await fetchPlayerWeeklyStats(playerId);
            setDebugContext('player-detail', raw);
            AppState.playerWeeklyCache[playerId] = processPlayerWeeklyHistory(raw, sport);
        } catch (err) {
            detailContainer.innerHTML = `<div class="player-loading">Couldn't load this player's history: ${err.message}</div>`;
            return;
        }
    }

    // Looked up AFTER the weekly-cache fetch above (rather than at the top of this function) so that if the shared timeframe is a windowed one, getEffectivePlayerPool can already find this player's just-cached weekly data instead of excluding them for not having it yet.
    const player = getEffectivePlayerPool(sport).find(p => p.id === playerId);
    if (!player) return;
    renderPlayerDetail(player);
}

export function closePlayerDetail() {
    AppState.selectedPlayerId = null;
    document.getElementById('player-detail-container').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'flex';
    document.getElementById('player-toolbar').style.display = 'flex';
    // Back to the leaderboard. The Diagnostic Data panel switches back to the pool context (already fetched/cached, so this just re-shows it, no new fetch needed).
    setActiveDebugKind('player-pool');
}

// Same scored/advanced split used everywhere else, scoped to whichever group tab this player's detail view was opened from (AppState.playerGroup) rather than their own primary role. A two-way player opened from the Pitchers tab should see pitching stat options, even though their primary position may make them a "batter.".
function statIdsForPlayer(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    const roleIds = Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(roleIds, statMap);
    // ESPN's raw FPTS (id 19) is a generic/universal points formula unrelated to this league's real scoring settings (see the comment on computeRotoRanks). Excluded entirely rather than offered as a selectable stat. "Weekly Score" (added in renderPlayerDetail) replaces it.
    const withoutFpts = deduped.filter(id => statMap[id] !== 'FPTS');
    const withData = withoutFpts.filter(id => Object.values(weekly).some(w => w[id] !== undefined) || player.seasonTotals[id] !== undefined);

    return splitScoredAdvanced(withData);
}

// A few players immediately above/below this player in a rank list, for the rank chip's hover dropdown. "ranked" is already sorted best-to-worst. `ranks` (aligned with `ranked`) carries tie-aware competition ranks when the caller has them (computeStatRank's stat chips, see its own comment). The Rank chips omit it and fall back to plain positional rank, since averaged Roto scores are continuous and effectively never tie.
function getRankNeighbors(ranked, playerId, ranks = null, windowSize = 3) {
    const idx = ranked.findIndex(p => p.id === playerId);
    if (idx === -1) return [];
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(ranked.length, idx + windowSize + 1);
    return ranked.slice(start, end).map((p, i) => ({ player: p, rank: ranks ? ranks[start + i] : start + i + 1 }));
}

// poolKey identifies which comparison pool this chip represents ('Overall' or a position code). Clicking a chip sets AppState.playerDetailRankPool to it, so the breakdown below can explain THAT pool's math instead of always defaulting to Overall. Answers "why is my position score different from Overall" by letting you see the actual different peer group and percentiles.
function buildRankChipHtml(poolKey, roto, player) {
    if (!roto || !roto.ranks.has(player.id)) return '';
    const rank = roto.ranks.get(player.id);
    const isSelected = (AppState.playerDetailRankPool || 'Overall') === poolKey;
    const rows = getRankNeighbors(roto.ranked, player.id).map(({ player: np, rank: nr }) => `
        <tr class="rank-chip-row${np.id === player.id ? ' rank-chip-row-current' : ''}">
            <td>#${nr}</td>
            <td>${escapeHtml(np.name)}</td>
            <td>${(roto.scores.get(np.id) || 0).toFixed(1)}</td>
        </tr>
    `).join('');
    return `
        <div class="rank-chip${isSelected ? ' rank-chip-selected' : ''}" data-rank-pool="${escapeHtml(poolKey)}">
            <span class="rank-chip-label">${escapeHtml(poolKey)}</span>
            <span class="rank-chip-value">#${rank}</span>
            <span class="rank-chip-total">of ${roto.total}</span>
            <div class="rank-chip-dropdown"><table>${rows}</table></div>
        </div>
    `;
}

// Overall rank (against every same-role player) plus one rank per position this player is eligible for (against only that position's peers, same scoping as the leaderboard's rankPool). A multi-position player's value can look very different position by position (a different, smaller comparison pool naturally produces different percentiles per category), so showing only one number would hide that.
function buildRankChipsHtml(player, sport) {
    if (AppState.isPointsLeague) return '';
    const wantPitchers = AppState.playerGroup === 'secondary';
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeRotoRanks(samePool, sport);
    const chips = [buildRankChipHtml('Overall', overallRoto, player)];
    // For a two-way player, only show chips for the positions relevant to the CURRENTLY viewed group. A batting-position chip while viewing them as a pitcher (or vice versa) would compare their wrong-role stats against the wrong-role pool.
    const relevantPositions = player.eligiblePositions.filter(pos => pitcherPositions.has(pos) === wantPitchers);
    relevantPositions.forEach(pos => {
        const posPool = samePool.filter(p => matchesPositionFilter(p, pos));
        chips.push(buildRankChipHtml(pos, computeRotoRanks(posPool, sport, pos), player));
    });
    return chips.filter(Boolean).join('');
}

// Explains exactly how the currently-selected rank chip's score is built, category by category. Every number in the table is derived from the two values shown right above it (Raw %ile and the Playing-Time Factor), via the formula spelled out in the caption, so nothing is a mystery number.
function buildRankBreakdownHtml(player, sport) {
    if (AppState.isPointsLeague) return '';
    // Which role's breakdown to show. Keyed off the currently viewed group tab, not this player's own primary position, so a two-way player opened from the Pitchers tab gets the pitching breakdown even though their primary role may be "batter".
    const isPitching = AppState.playerGroup === 'secondary';
    const roleLabel = isPitching ? 'Pitchers' : 'Batters';
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitching));

    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    // Only RP matches by primary role instead of eligibility (see matchesPositionFilter). SP uses plain eligibility, same as every other position filter.
    const isRpPool = selectedPool === 'RP';
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;
    const poolCount = poolPlayers.length.toLocaleString();
    const poolDescription = isPositionPool
        ? `${poolCount} ${selectedPool}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}`
        : `all ${poolCount} ${roleLabel}`;

    // RP skips shrinkage entirely and compares K as K/9 instead of a raw total. See computeRotoRanks' own comment for why.
    const { rows, excluded, shrink, avg } = computeCategoryBreakdown(player, poolPlayers, sport, selectedPool);
    if (rows.length === 0) return '';

    const workloadLabel = isPitching ? 'innings pitched' : 'games played';
    const shrinkPct = (shrink * 100).toFixed(0);
    const rowsHtml = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.name)}${r.inverse ? ' <span title="Lower is better for this category">&darr;</span>' : ''}</td>
            <td>${formatStatValue(r.value)}</td>
            <td>${r.rawPct.toFixed(1)}</td>
            <td>${r.adjPct.toFixed(1)}</td>
        </tr>
    `).join('');
    const excludedHtml = excluded.length
        ? `<div class="rank-breakdown-excluded"><strong>Excluded</strong> (no real opportunity): ${excluded.map(e => escapeHtml(e.name)).join(', ')}</div>`
        : '';
    // One tight line per concept, no formula dump. The table right below demonstrates the actual math, these bullets only say what each column means.
    const adjustedExplainer = isRpPool
        ? `<strong>Adjusted</strong> = Percentile: RP skips the Playing-Time Factor (innings aren't comparable between true relievers and spot-starting swingmen), and K is compared as K/9.`
        : `<strong>Adjusted</strong> = Percentile pulled toward 50 by a <strong>${shrinkPct}% Playing-Time Factor</strong> (${workloadLabel} vs the pool leader's).`;

    return `
        <details class="rank-breakdown"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
            <summary>How the <strong>${escapeHtml(selectedPool)}</strong> Rank score (${avg.toFixed(1)}) is totaled</summary>
            <ul class="rank-breakdown-explain">
                <li>Compared against <strong>${escapeHtml(poolDescription)}</strong>${isFullSeasonTimeframe() ? '' : ' (selected timeframe)'}.</li>
                <li><strong>Percentile</strong> = share of that pool this Value beats (&darr; = lower is better).</li>
                <li>${adjustedExplainer}</li>
                <li><strong>Rank Score</strong> = average of the Adjusted column.</li>
            </ul>
            <table class="rank-breakdown-table">
                <thead><tr><th>Category</th><th>Value</th><th>Percentile</th><th>Adjusted</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
                <tfoot><tr><td colspan="4">Rank Score = ${avg.toFixed(1)}</td></tr></tfoot>
            </table>
            ${excludedHtml}
        </details>
    `;
}

// Re-renders the currently-open player detail view (chart, rank chips/breakdown) in place. A no-op if no player is open.
export function refreshOpenPlayerDetail() {
    if (!AppState.selectedPlayerId) return;
    const sport = document.getElementById('sport').value;
    // openPlayerDetail always caches weekly data for whoever it opens (regardless of which timeframe was active then), so a currently-open player is guaranteed to be found here.
    const player = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    if (player) renderPlayerDetail(player);
}

function renderPlayerDetail(player) {
    const container = document.getElementById('player-detail-container');
    const sport = document.getElementById('sport').value;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { weekly = {} } = AppState.playerWeeklyCache[player.id] || {};

    // AppState.maxCompletedWeek reflects the LEAGUE's own matchup schedule, which can end before a player's own game logs do. Use whichever is actually larger so "Regular Season + Playoffs" and the percentage lookbacks below don't silently cut off real weeks of this player's data just because the league stopped defining matchups.
    const effectiveMaxWeek = Math.max(AppState.maxCompletedWeek, 0, ...Object.keys(weekly).map(Number));

    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const statOptions = visibleIds.map(id => ({ id, name: statMap[id] }));
    // Category leagues get our own computed Weekly Score as a selectable trend, in place of ESPN's removed FPTS. Points leagues already have a real per-week points total via appliedTotal, so there's nothing to replace there.
    if (!AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_RANK_STAT_ID, name: 'Matchup Score' });

    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || statOptions[0];
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    const rankChipsHtml = buildRankChipsHtml(player, sport);
    const rankBreakdownHtml = buildRankBreakdownHtml(player, sport);

    // Rank pager for the header: Prev walks UP the currently selected rank pool's ranking (toward #1), Next walks DOWN it. With Overall selected that's the Overall ranking, with a position chip selected it's that position's own ranking.
    let pager = null;
    if (!AppState.isPointsLeague) {
        const wantPitchersNav = AppState.playerGroup === 'secondary';
        const navPool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchersNav));
        const selectedPool = AppState.playerDetailRankPool || 'Overall';
        const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
        const poolPlayers = isPositionPool ? navPool.filter(p => matchesPositionFilter(p, selectedPool)) : navPool;
        const roto = computeRotoRanks(poolPlayers, sport, isPositionPool ? selectedPool : null);
        const idx = roto.ranked.findIndex(p => p.id === player.id);
        if (idx !== -1) {
            pager = {
                pool: selectedPool,
                prev: idx > 0 ? { player: roto.ranked[idx - 1], rank: idx } : null,
                next: idx + 1 < roto.ranked.length ? { player: roto.ranked[idx + 1], rank: idx + 2 } : null
            };
        }
    }
    const pagerBtnHtml = (dir, target, label) => target
        ? `<button id="player-${dir}-btn" class="player-pager-btn" title="#${target.rank} ${escapeHtml(pager.pool)}: ${escapeHtml(target.player.name)}">${label}</button>`
        : `<button class="player-pager-btn" disabled>${label}</button>`;
    const pagerHtml = pager
        ? `<div class="player-pager">${pagerBtnHtml('prev', pager.prev, '&larr; Prev')}${pagerBtnHtml('next', pager.next, 'Next &rarr;')}</div>`
        : '';

    const seasonStatsHtml = visibleIds.map(id => {
        const rankInfo = computeStatRank(player, sport, id);
        const bgColor = rankInfo ? percentileColor(rankInfo.percentile) : '#f8f9fa';
        const rankColor = rankInfo && RANK_COLORS[rankInfo.rank];
        // Same "a few players above/below" hover dropdown as the rank chips, just scoped to this one category's own ordering instead of the averaged Rank score. Passing the tie-aware ranks so a tied neighbor shows the same shared rank the chip itself does.
        const neighborsHtml = rankInfo ? getRankNeighbors(rankInfo.sorted, player.id, rankInfo.ranks).map(({ player: np, rank: nr }) => `
            <tr class="rank-chip-row${np.id === player.id ? ' rank-chip-row-current' : ''}">
                <td>#${nr}</td>
                <td>${escapeHtml(np.name)}</td>
                <td>${formatStatValue(np.seasonTotals[id])}</td>
            </tr>
        `).join('') : '';
        return `
            <div class="stat-chip" style="background:${bgColor};">
                <span class="stat-chip-label">${escapeHtml(statMap[id])}</span>
                <span class="stat-chip-value"${rankColor ? ` style="color:${rankColor};"` : ''}>${formatStatValue(player.seasonTotals[id])}</span>
                ${rankInfo ? `<span class="stat-chip-rank">#${rankInfo.rank} of ${rankInfo.total}</span>` : ''}
                ${neighborsHtml ? `<div class="rank-chip-dropdown"><table>${neighborsHtml}</table></div>` : ''}
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="player-detail-header">
            <button id="player-back-btn" class="player-back-btn">&larr; Leaderboard</button>
            <div class="player-detail-title">
                <h3>${escapeHtml(player.name)}</h3>
                <span class="player-detail-meta">${escapeHtml(player.teamName)} &middot; ${escapeHtml(player.positionDisplay)}</span>
            </div>
            ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
            ${pagerHtml}
        </div>
        ${rankChipsHtml ? `<div id="player-rank-chips" class="player-rank-chips">${rankChipsHtml}</div>` : ''}
        ${rankBreakdownHtml}
        <div id="player-season-stats" class="player-season-stats">${seasonStatsHtml}</div>
        <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:300px; margin-top:8px;"></div>
    `;

    document.getElementById('player-back-btn').addEventListener('click', closePlayerDetail);

    // preserveView keeps the selected rank pool/stat/breakdown state while walking a ranking, so paging through an SS pool stays an SS-pool walk.
    const prevBtn = document.getElementById('player-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', () => openPlayerDetail(pager.prev.player.id, true));
    const nextBtn = document.getElementById('player-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', () => openPlayerDetail(pager.next.player.id, true));

    // Clicking a rank chip picks which pool's math the breakdown below explains (Overall vs a specific position). Re-render is cheap enough to just redo the whole detail view.
    container.querySelectorAll('.rank-chip').forEach(chipEl => {
        chipEl.addEventListener('click', () => {
            // Only switches which pool the breakdown explains. Doesn't force it open.
            AppState.playerDetailRankPool = chipEl.dataset.rankPool;
            renderPlayerDetail(player);
        });
    });

    // Track manual open/close so re-rendering (switching pools, stats, timeframe) doesn't keep resetting the panel back to collapsed out from under the user.
    const rankBreakdownEl = container.querySelector('.rank-breakdown');
    if (rankBreakdownEl) {
        rankBreakdownEl.addEventListener('toggle', () => {
            AppState.playerDetailRankBreakdownOpen = rankBreakdownEl.open;
        });
    }

    const picker = document.getElementById('player-stat-picker');
    if (picker) {
        picker.addEventListener('change', (e) => {
            AppState.playerDetailStat = e.target.value;
            renderPlayerDetail(player);
        });
    }

    if (currentStat) {
        drawPlayerTrendChart(player, currentStat, weekly, effectiveMaxWeek);
    } else {
        document.getElementById('player-trend-chart').innerHTML = '<div class="player-loading">No stat history available for this player.</div>';
    }
}

// "Ranking per week". Replaces ESPN's raw per-week FPTS (removed entirely, see statIdsForPlayer) with our own Roto-style score computed week by week: this player's real week, percentile- ranked against same-role peers' real weeks (or, when that data isn't cached yet, an implied "typical week" fallback, see buildWeeklyRateBasis below), category by category, then averaged (equal weight, same as computeRotoRanks).
function weeklyBasisQualifiedPool(samePool, sport) {
    const maxGames = Math.max(0, ...samePool.map(p => gamesPlayedOf(p, sport)));
    if (maxGames === 0) return samePool;
    const threshold = maxGames * MIN_PLAYING_TIME_FRACTION;
    return samePool.filter(p => gamesPlayedOf(p, sport) >= threshold);
}

// AppState.playerWeeklyCache only holds real weekly data once the leaderboard's bulk fetch has actually run, so it can be empty or partial early in a session.
const WEEKLY_BASIS_COVERAGE_THRESHOLD = 0.9;

function buildWeeklyRateBasis(sport) {
    const wantPitchers = AppState.playerGroup === 'secondary';
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    // Scoped to the current group's role so a two-way player's off-role stats don't leak into this pool's category list. Same reasoning as rotoContext.
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const relevantStatIds = Array.from(AppState.scoredStatIds).filter(id =>
        (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && samePool.some(p => p.seasonTotals[id] !== undefined));
    const { start: windowStart, end: windowEnd } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const inverseStatIds = INVERSE_STATS[sport] || new Set();
    const avgStatIds = AVERAGE_STATS[sport] || new Set();

    const qualifiedPool = weeklyBasisQualifiedPool(samePool, sport);
    const cachedQualified = qualifiedPool.filter(hasCachedWeeklyData);
    const coverage = qualifiedPool.length > 0 ? cachedQualified.length / qualifiedPool.length : 0;

    if (coverage >= WEEKLY_BASIS_COVERAGE_THRESHOLD) {
        const weeklyValuesByPlayer = cachedQualified.map(p => {
            const cache = AppState.playerWeeklyCache[p.id];
            const weeks = Object.keys(cache.weekly)
                .map(Number)
                .filter(w => w >= windowStart && w <= windowEnd)
                .map(w => ({ stats: cache.weekly[w], games: (cache.weeklySums[w] && cache.weeklySums[w].games) || 0 }));
            return { id: p.id, seasonTotals: p.seasonTotals, weeks };
        });
        const categoryRates = buildWeeklyValueBasis(weeklyValuesByPlayer, { relevantStatIds, inverseStatIds, avgStatIds });
        // Every category came back empty. e.g. a brand-new window with no completed real weeks yet. Fall through to the season-average basis instead of an unusable empty result.
        if (categoryRates.length > 0) return { categoryRates, windowStart, windowEnd };
    }

    // Coverage too thin (or the real-value basis came back empty).
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport);

    const categoryRates = buildCategoryRateBasis(samePool, {
        relevantStatIds, inverseStatIds, avgStatIds,
        weeksElapsed: Math.max(1, windowEnd - windowStart + 1)
    });
    return { categoryRates, windowStart, windowEnd };
}

function computeWeeklyRankSeries(player, sport, weekly, weeks) {
    const { categoryRates } = buildWeeklyRateBasis(sport);
    const scores = {};
    weeks.forEach(w => {
        const score = scoreWeekAgainstBasis(player, weekly[w], categoryRates);
        if (score !== null) scores[w] = score;
    });
    return scores;
}

// How much a weekly Matchup Score has to move off the player's own average (in percentile points) before it counts as a real trend rather than ordinary week-to-week noise.
const TREND_THRESHOLD = 10;

// Below this fraction of the current matchup elapsed, no arrows are shown at all. A single hot or cold day prorates into a wild full-matchup pace that isn't a trend yet. 0.25 is roughly "two days into a normal 7-day matchup.".
const MIN_TREND_FRACTION = 0.25;

// Weekly-form arrows for the leaderboard's Rank column: compares each player's Matchup Score in the window's final matchup against their own average score across the window. Clearly above average trends up (green), clearly below trends down (red), anything within TREND_THRESHOLD shows nothing.
function buildMatchupTrendIcons(players, sport) {
    const icons = new Map();
    if (Object.keys(AppState.playerWeeklyCache).length === 0) return icons;

    const { categoryRates, windowStart, windowEnd } = buildWeeklyRateBasis(sport);
    if (categoryRates.length === 0) return icons;

    let fullWeekGames = 0, finalWeekGames = 0;
    Object.values(AppState.playerWeeklyCache).forEach(cache => {
        Object.keys(cache.weeklySums).forEach(w => {
            const wk = Number(w);
            const games = cache.weeklySums[w].games;
            if (wk >= windowStart && wk < windowEnd) fullWeekGames = Math.max(fullWeekGames, games);
            else if (wk === windowEnd) finalWeekGames = Math.max(finalWeekGames, games);
        });
    });
    const fraction = fullWeekGames > 0 ? Math.min(1, finalWeekGames / fullWeekGames) : 1;
    if (fraction < MIN_TREND_FRACTION) return icons;

    players.forEach(p => {
        const cache = AppState.playerWeeklyCache[p.id];
        if (!cache) return;
        const weeks = Object.keys(cache.weekly).map(Number)
            .filter(w => w >= windowStart && w <= windowEnd)
            .sort((a, b) => a - b);
        if (weeks.length < 2 || weeks[weeks.length - 1] !== windowEnd) return;

        const scores = weeks
            .map(w => scoreWeekAgainstBasis(p, cache.weekly[w], categoryRates, w === windowEnd ? fraction : 1))
            .filter(s => s !== null);
        if (scores.length < 2) return;

        const latest = scores[scores.length - 1];
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const delta = latest - avg;
        if (Math.abs(delta) < TREND_THRESHOLD) return;
        icons.set(p.id, {
            dir: delta > 0 ? 'up' : 'down',
            tip: `Matchup Pace: ${latest.toFixed(1)} vs ${avg.toFixed(1)} average`
        });
    });
    return icons;
}

function drawPlayerTrendChart(player, stat, weekly, maxWk) {
    const container = document.getElementById('player-trend-chart');
    const sport = document.getElementById('sport').value;

    // weekly is already keyed by fantasy week (matchupPeriodId) and summed/averaged per stat. The day-to-week rollup happened once in processPlayerWeeklyHistory, using the league's own schedule mapping. maxWk is the EFFECTIVE max week (see renderPlayerDetail), not AppState.maxCompletedWeek directly. A league whose own matchup schedule ends well before the real season does would otherwise cut "Regular Season + Playoffs" off early and hide real weeks of this player's own data.
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, maxWk, AppState.regSeasonWeeks);
    const weeks = Object.keys(weekly).map(Number)
        .filter(w => w >= tfStart && w <= tfEnd)
        .sort((a, b) => a - b);
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const weeklyRankScores = isWeeklyRank ? computeWeeklyRankSeries(player, sport, weekly, weeks) : null;
    const actualValues = weeks.map(w => isWeeklyRank ? (weeklyRankScores[w] ?? 0) : ((weekly[w] && weekly[w][stat.id]) || 0));

    const isRateStat = (AVERAGE_STATS[sport] || new Set()).has(stat.id);

    // Per-week gap notes (missing weeks at the edges or in the middle of the range) were removed. They were mostly noise once the day-to-week mapping bug was fixed (a real bye/IL week with zero games played would still trigger one, which isn't actually a data problem).
    const gapNotes = [];
    if (!isWeeklyRank && !isRateStat) {
        const plottedSum = actualValues.reduce((a, b) => a + b, 0);
        const seasonValue = player.seasonTotals[stat.id] || 0;
        if (Math.round(plottedSum) !== Math.round(seasonValue)) {
            gapNotes.push(`Season Total is ${formatStatValue(seasonValue)}, but the weeks shown only add up to ${formatStatValue(plottedSum)} - some of this season's real production is missing from the weekly data above, not just from the average.`);
        }
    }
    const gapNoteHtml = gapNotes.length
        ? `<div style="font-size:11px; color:var(--warning); font-style:italic; margin-bottom:8px;">${gapNotes.map(escapeHtml).join(' ')}</div>`
        : '';

    let avgVal, actualTotal, avgLabel, totalLabel;
    if (isWeeklyRank) {
        // Reference line is the mean of the exact weekly scores being plotted. NOT the season Rank score shown on the leaderboard, which is computed by a completely different formula (full-season totals with shrinkage applied) and has no consistent mathematical relationship to a single week's value.
        avgVal = actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0;
        actualTotal = avgVal;
        avgLabel = 'Avg Matchup Score';
        totalLabel = 'Avg Matchup Score';
    } else {
        // Rate stats (AVG, ERA, etc.) use ESPN's own verified season rate directly for the reference line. No risk of an "average of rates" computation error creeping back in.
        const seasonValue = player.seasonTotals[stat.id] || 0;
        avgVal = isRateStat ? seasonValue : (actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0);
        actualTotal = seasonValue;
        avgLabel = isRateStat ? 'Season Avg' : 'Avg/Matchup';
        totalLabel = 'Season Total';
    }
    const avgDisplay = isWeeklyRank ? avgVal.toFixed(1) : formatStatValue(avgVal);
    // Matchup Score's "total" and "average" are the same single number (the mean of the matchup scores). Showing both labels back to back just duplicated the same value, so only the one reference-line stat is shown for it, matching the single dashed line actually drawn.
    const totalStatHtml = isWeeklyRank ? '' : `<div>${totalLabel}: <strong>${formatStatValue(actualTotal)}</strong></div>`;
    // Matchup Score is our own computed stat (not an ESPN number), so it's the one chart that needs to explain itself.
    const matchupScoreInfo = isWeeklyRank
        ? `<span class="tooltip tooltip-bottom" style="margin-left:4px;">ⓘ<span class="tooltiptext">Scores each matchup from 0 to 100. The player's weekly numbers in every scored category are compared against other ranked players' real weeks from the same stretch, and those category percentiles are averaged. 50 is the middle of the pack.</span></span>`
        : '';
    const summary = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
            <h4 style="margin:0; font-size:14px; color:var(--text-body); display:flex; align-items:center;">${escapeHtml(stat.name)} - Matchup Trend${matchupScoreInfo}</h4>
            <div style="font-size:12px; color:var(--text-muted); display:flex; gap:15px; align-items:center;">
                ${totalStatHtml}
                <div style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:var(--chart-avg); border-top:2px dashed var(--chart-avg);"></span> ${avgLabel}: <strong>${avgDisplay}</strong></div>
            </div>
        </div>
        ${gapNoteHtml}
    `;

    // Render the summary first (and a placeholder for the chart) so the chart's wrapper div gets its real, final flex-computed size before we measure it. A fixed 800x300 viewBox was getting letterboxed (blank margins, data drawn smaller than it needed to be) whenever the container's actual aspect ratio didn't match 800:300.
    container.innerHTML = summary + '<div id="player-trend-svg-wrap" style="flex:1; min-height:0;"></div>';
    const svgWrap = document.getElementById('player-trend-svg-wrap');

    if (weeks.length === 0) {
        svgWrap.innerHTML = '<div class="player-loading">No weekly history for this stat yet.</div>';
        return;
    }

    const svgWidth = Math.max(300, svgWrap.clientWidth || 800);
    const svgHeight = Math.max(180, svgWrap.clientHeight || 300);
    const padding = 45;
    // Include avgVal so the reference line is always guaranteed to land inside the plotted range, never above the top gridline (possible if the weekly-fetched data is missing some games ESPN's season-total endpoint does have, see the day-level history caveats elsewhere in this file).
    const maxVal = getNiceMax(Math.max(...actualValues, avgVal, 0));
    const numWeeks = weeks.length - 1;

    let svgStr = `<svg width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display:block;">`;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        // formatStatValue (not toFixed(1)). A fixed 1-decimal label was rounding rate stats like AVG down to the point of unreadability (a gridline at .328 displayed as "0.3", making a correctly-plotted .274 point look like it was sitting on/above "0.3").
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatStatValue(maxVal - (i / 4) * maxVal)}</text>`;
    }

    // Same dashed playoff-start marker as the team Season Trends graph (see renderTrendGraph in graphs.js), adapted for this chart's x-axis: weeks here are spaced by ARRAY INDEX, not by week number, since a real bye/IL week can leave a gap in the displayed weeks. So the boundary is placed between whichever two adjacent DISPLAYED weeks straddle the real regular-season/playoffs split, rather than by interpolating raw week numbers.
    if (numWeeks > 0 && AppState.regSeasonWeeks >= tfStart && AppState.regSeasonWeeks < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.regSeasonWeeks);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
        }
    }

    // Second boundary marking where the league's LAST real matchup (championship) concluded (see formatMatchupLabel). The real MLB season keeps producing stats well after that, so the "+N" labels past it read as "extra season" rather than looking like an unexplained change in numbering.
    if (numWeeks > 0 && AppState.maxCompletedWeek >= tfStart && AppState.maxCompletedWeek < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.maxCompletedWeek);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="2,2" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${svgHeight - padding + 16}" font-size="10" text-anchor="start" style="fill:var(--text-subtle)">End of league season</text>`;
        }
    }

    // Cap x-axis labels to a fixed max. A label per point crowds together once a full season's worth of matchups is plotted.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil((numWeeks + 1) / maxLabels));
    const labelIndices = new Set();
    for (let i = 0; i <= numWeeks; i += labelStep) labelIndices.add(i);
    labelIndices.add(numWeeks);

    const actualPts = [];
    weeks.forEach((w, i) => {
        const x = padding + (numWeeks === 0 ? 0 : (i / numWeeks) * (svgWidth - padding * 2));
        const yAct = svgHeight - padding - (actualValues[i] / maxVal) * (svgHeight - padding * 2);

        actualPts.push({ x, y: yAct, week: w, value: actualValues[i] });
        if (labelIndices.has(i)) {
            svgStr += `<text x="${x}" y="${svgHeight - 10}" font-size="11" text-anchor="middle" style="fill:var(--chart-axis)">${formatMatchupLabel(w)}</text>`;
        }
    });

    // Weekly average reference line, drawn under the data line so individual points still stand out clearly above/below it.
    const avgY = svgHeight - padding - (avgVal / maxVal) * (svgHeight - padding * 2);
    svgStr += `<line x1="${padding}" y1="${avgY}" x2="${svgWidth - padding}" y2="${avgY}" stroke-width="1.5" stroke-dasharray="6,4" style="stroke:var(--chart-avg)" />`;

    svgStr += `<polyline points="${actualPts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="2.5" style="stroke:var(--accent)" />`;
    actualPts.forEach(p => {
        // No opponent/matchup info here. A player may have been picked up by this fantasy team partway through the season, so a real matchup that week doesn't necessarily mean the player was actually rostered for it.
        const displayValue = isWeeklyRank ? p.value.toFixed(1) : formatStatValue(p.value);
        const tooltipText = `Matchup ${p.week}: ${escapeHtml(displayValue)} ${escapeHtml(stat.name)}`;
        // A bigger transparent hit target on top of the small visible dot. R="4" alone is a tiny, hard-to-hover target, especially with many weeks crowded into a narrow chart.
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="4" style="fill:var(--accent); pointer-events:none;" />`;
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent" style="cursor:pointer;" data-tooltip="${tooltipText}" />`;
    });
    svgStr += `</svg>`;

    svgWrap.innerHTML = svgStr;
    attachDataTooltips(svgWrap);
}