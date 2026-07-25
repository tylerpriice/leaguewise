import { AppState, ESPN_STAT_MAPS, POSITION_MAPS, SLOT_POSITION_MAPS, PITCHER_POSITIONS, PITCHING_IDS, GOALIE_IDS, AVERAGE_STATS, INVERSE_STATS, RATE_COMPONENTS, NON_STARTING_SLOTS } from './state.js';
import { escapeHtml, getNiceMax, setDebugContext, setActiveDebugKind, hasDebugContext, setDebugLoading, getTimeframeBounds, splitScoredAdvanced, percentileColor, attachDataTooltips, statValue, unwrapStats, axisUnit } from './utils.js';
import { fetchPlayerData, fetchPlayerWeeklyStats, fetchPlayersWeeklyChunk, WEEKLY_CHUNK_SIZE, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchDraftDetail, harvestTransactions, harvestRosters } from './api.js';
import { buildRosterTimeline, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod } from './roster-timeline.js';
// All ranking and percentile MATH lives in the pure, unit-tested rank engine. This module owns the impure half: choosing pools, reading AppState, and building the ctx objects it passes over.
import {
    IP_STAT_ID, GAMES_PLAYED_IDS, MIN_PLAYING_TIME_FRACTION,
    inningsPitchedOf, opportunityGateFor,
    computeRotoRanks as engineComputeRotoRanks,
    computeCategoryBreakdown as engineComputeCategoryBreakdown,
    computeStatRankInPool, buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis,
    scoreRotoWeek, rotoPointsForCategory
} from './rank-engine.js';

const RANK_COLORS = { 1: '#b8860b', 2: '#767676', 3: '#a4581e' }; // gold, silver, bronze
const RANK_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' }; // leaderboard Rank column, top 3 of the current pool
const WEEKLY_RANK_STAT_ID = '__weeklyrank__';

// Ranks a player against everyone with real eligibility in the STAT's own role, keyed off which role the stat belongs to rather than the player's primary position, so a two-way player's pitching and batting stats each land in the right pool.
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

// Group tab membership has to be ELIGIBILITY-based rather than based on a single primary role, because a genuine two-way player has real stats and eligibility in both roles and needs to appear, with his own numbers, in both tabs.
function matchesPlayerGroup(player, sport, wantPitchers) {
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    return wantPitchers
        ? player.eligiblePositions.some(pos => pitcherPositions.has(pos))
        : player.eligiblePositions.some(pos => !pitcherPositions.has(pos));
}

// Eligibility-based filtering skews an RP pool toward swingmen, who accumulate starter-shaped counting stats a dedicated reliever never could, so the RP filter matches by primary role instead.
function matchesPositionFilter(p, posFilter) {
    if (posFilter === 'RP') return p.positionName === posFilter;
    return p.eligiblePositions.includes(posFilter);
}

// Roster availability filter. A player's teamId is set only when they are on a fantasy team, so null means free agent.
function matchesAvailability(p) {
    const mode = AppState.playerAvailabilityFilter || 'all';
    if (mode === 'rostered') return p.teamId != null;
    if (mode === 'fa') return p.teamId == null;
    return true;
}

// Outfield is the one case where the same real position exists at two granularities in ESPN's slot catalog, generic OF against specific LF/CF/RF, so which to show depends on the granularity this league's roster actually uses.
const OF_SPECIFIC_SLOTS = new Set(["8", "9", "10"]);
const OF_GENERIC_SLOT = "5";
// The generic P slot is redundant whenever a player also has the more specific SP or RP, since any SP or RP is P-eligible too.
const GENERIC_PITCHER_SLOT = "13";
const SPECIFIC_PITCHER_SLOTS = new Set(["14", "15"]);

// Canonical display order. An unrecognized name sorts after everything else rather than disappearing.
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

// Some names are reused between multiple ids, part of which is legacy ids ESPN no longer uses.
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

// Splits a group's stat ids into the ones this league scores and everything else ESPN tracks, so the leaderboard can default to the categories that matter and tuck the rest behind a toggle.
function statIdsForGroup(sport, group, groupPlayers) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const inGroup = Object.keys(statMap).filter(id => group === 'secondary' ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(inGroup, statMap);
    const withData = deduped.filter(id => groupPlayers.some(p => p.seasonTotals[id] !== undefined));
    return splitScoredAdvanced(withData);
}

// Real fractional-innings notation, where .1 is one out into the inning and .2 is two, NOT a true decimal: 586 outs is 195.1, not 195.333.
function formatInnings(outs) {
    if (outs === undefined || outs === null) return '-';
    return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Reads the active group tab rather than the player's own primary role, since every caller already scopes players to the current group. That way a two-way player's pitching games count is read on the Pitchers tab and his batting games count on the Batters tab.
function gamesPlayedOf(p, sport) {
    const group = AppState.playerGroup === 'secondary' ? 'secondary' : 'primary';
    const ids = GAMES_PLAYED_IDS[sport] || GAMES_PLAYED_IDS.flb;
    return p.seasonTotals[ids[group]] || 0;
}

// The shrinkage measure is a VALUE measure: games for batters, innings for pitchers.
function workloadOf(p, sport) {
    if (sport === 'fhl') return gamesPlayedOf(p, sport);
    return AppState.playerGroup === 'secondary' ? inningsPitchedOf(p) : gamesPlayedOf(p, sport);
}

// The impure-to-pure adapter: everything the engine's roto functions need, read once from AppState. relevantStatIds is scoped to the CURRENT group's role, or a two-way player's off-role stats would leak in as a single-player basis handing him an automatic top percentile.
function rotoContext(groupPlayers, sport, posFilter) {
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    return {
        relevantStatIds: Array.from(AppState.scoredStatIds).filter(id =>
            (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && groupPlayers.some(p => p.seasonTotals[id] !== undefined)),
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        // The averaged categories, so the engine knows which missing values are a real 0 and which are genuinely absent. This module owns that set, and the pure engine takes it through ctx rather than importing state.
        rateStatIds: AVERAGE_STATS[sport] || new Set(),
        isRpPool: posFilter === 'RP',
        requireMinPlayingTime: AppState.requireMinPlayingTime,
        workloadOf: p => workloadOf(p, sport),
        thresholdWorkloadOf: p => gamesPlayedOf(p, sport),
        statMap: ESPN_STAT_MAPS[sport] || {}
    };
}

// Replaces ESPN's raw FPTS, a generic points formula unrelated to this league's scoring settings, with a real roto-style rank.
function computeRotoRanks(groupPlayers, sport, posFilter = null) {
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

// The single-player per-category breakdown of the same math, for the drill-down.
function computeCategoryBreakdown(player, groupPlayers, sport, posFilter = null) {
    return engineComputeCategoryBreakdown(player, groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

function formatStatValue(val) {
    if (val === undefined || val === null) return '-';
    const num = Number(val);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(3) : num;
}

// The breakdown rows exist to JUSTIFY the percentile, so a rate value there carries enough precision to tell apart values the grid rounds together, or two goalies shown at .912 with different percentiles read as a bug.
function formatBreakdownValue(val) {
    const num = Number(val);
    if (Number.isFinite(num) && num % 1 !== 0 && Math.abs(num) < 1) return num.toFixed(4);
    return formatStatValue(val);
}

// The chart's x-axis is labelled by matchup number rather than raw week, since that is the unit a manager actually thinks in.
function formatMatchupLabel(w) {
    // The drill-down chart's buckets ARE the league's own timeline unit: matchups in H2H, real weeks in roto, whose matchup period count is 1.
    return `${axisUnit().short}${w}`;
}

export function processPlayerData(rawData, sport) {
    const rawPlayers = rawData.players || [];
    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });
    const year = parseInt(document.getElementById('year').value, 10);

    return rawPlayers.map(entry => {
        const p = entry.player || {};
        const statLines = p.stats || [];

        // Match the exact year, to prevent historical leakage.
        const actualSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year);
        const projSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === year);

        const teamId = entry.onTeamId > 0 ? entry.onTeamId : null;
        const team = teamId ? teamById[teamId] : null;
        const posMap = POSITION_MAPS[sport] || {};
        const primaryPositionName = posMap[p.defaultPositionId] || `Pos ${p.defaultPositionId}`;

        // eligibleSlots lists every roster slot a player actually qualifies for, not just their one default position.
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

// MLB and NHL report stats per game DAY rather than per fantasy week, so there is no single stat line to read for a given week.
function weekOfScoringPeriod(scoringPeriodId) {
    return Math.max(1, Math.floor(scoringPeriodId / 7));
}

// A regular-season matchup is exactly one real week, but a playoff round can span several, which is what playoffMatchupPeriodLength describes.
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

// Rate stats cannot be aggregated by averaging each day's already-computed rate, which weights a one-at-bat day like a five-at-bat day and inflated weekly averages well above the real season number.
function deriveRateOverrides(sums, sport) {
    const rules = RATE_COMPONENTS[sport] || [];
    const overrides = {};
    const sumOf = ids => ids.reduce((acc, id) => acc + (sums[id] || 0), 0);
    rules.forEach(rule => {
        if (rule.add) {
            // A rate that is the sum of already-derived rates. Only emitted when every part was itself derivable in this range, so an empty window does not invent one.
            if (rule.add.every(id => overrides[id] !== undefined)) {
                overrides[rule.out] = rule.add.reduce((acc, id) => acc + overrides[id], 0);
            }
            return;
        }
        const den = sumOf(rule.den);
        if (den > 0) overrides[rule.out] = sumOf(rule.num) * (rule.scale || 1) / den;
    });
    return overrides;
}

// Sums raw per-week components across a range and runs the combined totals through the same derivation a single week uses. A single week is a range of one, which is what makes this the only place rate-stat math happens.
export function aggregateStatsForWeekRange(weeklySums, startWeek, endWeek, sport) {
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
        ...deriveRateOverrides(sums, sport)
    };
}

// Groups a response's raw day-level stat lines into per-matchup-week raw sums, shared by the single-player and bulk paths, with the caller supplying whichever slice belongs to one player.
function buildWeeklySums(playerStatLines, year) {
    // Only actual per-day lines. ESPN's rest-of-season projections proved unreliable or empty in practice and are not used.
    const dayLines = playerStatLines.filter(s => s.seasonId === year && s.statSplitTypeId === 5 && s.statSourceId === 0 && s.scoringPeriodId);

    const weeklySums = {}; // week# -> { sums: {statId: sum}, games }
    const dailyByPeriod = AppState.isRotoLeague ? {} : null; // scoringPeriodId -> { sums, games }
    dayLines.forEach(s => {
        // Matchup leagues bucket by matchup number, which folds ESPN's multi-week playoff rounds into one.
        const week = AppState.isRotoLeague
            ? weekOfScoringPeriod(s.scoringPeriodId)
            : matchupNumberOfWeek(weekOfScoringPeriod(s.scoringPeriodId));
        if (!weeklySums[week]) weeklySums[week] = { sums: {}, games: 0 };
        const dayBucket = dailyByPeriod ? (dailyByPeriod[s.scoringPeriodId] = dailyByPeriod[s.scoringPeriodId] || { sums: {}, games: 0 }) : null;

        weeklySums[week].games++;
        if (dayBucket) dayBucket.games++;
        Object.keys(s.stats || {}).forEach(statId => {
            const v = statValue(s.stats[statId]) || 0;
            weeklySums[week].sums[statId] = (weeklySums[week].sums[statId] || 0) + v;
            if (dayBucket) dayBucket.sums[statId] = (dayBucket.sums[statId] || 0) + v;
        });
    });
    return { weeklySums, dailyByPeriod };
}

export function processPlayerWeeklyHistory(rawData, sport) {
    // A player can appear as more than one entry when he changed teams mid-season, since each entry carries only its own roster stint.
    const statLines = (rawData.players || []).flatMap(e => (e.player && e.player.stats) || []);
    const year = parseInt(document.getElementById('year').value, 10);
    const { weeklySums, dailyByPeriod } = buildWeeklySums(statLines, year);

    const weekly = {};
    Object.keys(weeklySums).forEach(week => {
        weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
    });

    return { weekly, weeklySums, dailyByPeriod };
}

// The bulk counterpart, which populates the weekly cache directly for every player found rather than returning one player's history.
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
        const { weeklySums, dailyByPeriod } = buildWeeklySums(statLines, year);
        const weekly = {};
        Object.keys(weeklySums).forEach(week => {
            weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
        });
        AppState.playerWeeklyCache[playerId] = { weekly, weeklySums, dailyByPeriod };
    });
}

// A player needs real weekly data cached before a windowed timeframe can apply to him, which decides both whether to start a bulk fetch and who is includable in the windowed pool.
function hasCachedWeeklyData(p) {
    return !!AppState.playerWeeklyCache[p.id];
}

// Returns the pool unchanged for a full-season timeframe, since the season totals already are the sum. Otherwise it returns clones with windowed totals, excluding anyone not yet cached rather than showing season numbers under a windowed heading.
let poolCache = null;

// Whether the selected timeframe's resolved range covers the entire available season, not merely whether it is literally the season option.
function isFullSeasonTimeframe() {
    // Roto has no matchup periods, so the season-against-window distinction is purely which pill is picked.
    if (AppState.isRotoLeague) return !String(AppState.timeframe).startsWith('last');
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    return start === 1 && end === AppState.maxCompletedWeek;
}

// The [start, end] week range the player views aggregate over, roto-aware.
function playerTimeframeBounds(sport) {
    if (AppState.isRotoLeague) {
        const maxWeek = rotoWindowMaxWeek(sport);
        if (maxWeek > 0) return getTimeframeBounds(AppState.timeframe, maxWeek, maxWeek);
    }
    return getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
}

function getEffectivePlayerPool(sport) {
    if (isFullSeasonTimeframe()) return AppState.playerData;

    const weeklyCacheSize = Object.keys(AppState.playerWeeklyCache).length;
    if (poolCache && poolCache.sport === sport && poolCache.timeframe === AppState.timeframe &&
        poolCache.playerDataRef === AppState.playerData && poolCache.weeklyCacheSize === weeklyCacheSize) {
        return poolCache.result;
    }

    const { start, end } = playerTimeframeBounds(sport);
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

    // A two-way player's off-role eligibility has no meaning as a position filter here, so the other role's entries are dropped from the dropdown itself.
    positions = positions.filter(pos => pitcherPositions.has(pos) === wantPitchers);

    if (wantPitchers) {
        // SP before RP specifically, with anything else falling back to alphabetical after those two.
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

    // A group with a single position offers no meaningful filter, since that one position IS the whole group.
    if (positions.length <= 1) {
        select.style.display = 'none';
        select.value = 'ALL';
        AppState.playerPositionFilter = 'ALL';
        return;
    }
    select.style.display = '';

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

    // The exclusion threshold is games played for everyone, a role-neutral activity measure.
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

// Built once and appended to the body rather than to the scrolling table, so no column's overflow can clip it.
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
    const roleLabel = (GROUP_LABELS[sport] || GROUP_LABELS.flb)[wantPitchers ? 'secondary' : 'primary'];
    const isFiltered = posFilter && posFilter !== 'ALL';
    // Same-role peers only holds with no position filter: filtering rescopes the comparison pool to that position's players, so the explanation has to say so rather than describe the unfiltered case.
    const isRpPool = posFilter === 'RP';
    const poolLabel = isFiltered ? `${posFilter}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}` : `All ${roleLabel}`;
    // An illustrative example in the copy. Hockey skaters filter by C, LW, RW and D, while goalies are all one position.
    const examplePos = sport === 'fhl' ? (wantPitchers ? 'G' : 'C') : (wantPitchers ? 'SP' : 'SS');

    const categoryIds = preferScoredDedup(
        Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)),
        statMap
    ).filter(id => AppState.scoredStatIds.has(id));

    const categoryChips = categoryIds.map(id => {
        const inverse = inverseSet.has(id);
        const opportunity = opportunityGateFor(id, isRpPool) ? ' *' : '';
        // The same K/9 labelling the breakdown uses, since inside an RP pool K is compared as a rate and the chip should not imply a raw total is what is ranked.
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
    // RP is the one pool where shrinkage is skipped and K is compared as K/9, so the generic pitcher wording would misdescribe it.
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

// A purely cosmetic progress indicator: a single fetch offers no byte-level progress, so this eases toward but never reaches 90% on a fixed curve.
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

// One shared in-flight fetch for the pool, so opening the tab awaits the SAME request a background prefetch already started rather than duplicating it.
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
        // A failed fetch must not poison every later attempt with the same rejected promise, so clear the slot and let the next call start fresh.
        promise.catch(() => {
            if (playerPoolFetch && playerPoolFetch.promise === promise) playerPoolFetch = null;
        });
        playerPoolFetch = { apiDataRef, promise };
    }
    return playerPoolFetch.promise;
}

// Fire-and-forget warm-up as soon as league data lands, so the tab opens near-instantly rather than paying the whole round trip on click.
export function prefetchPlayerData() {
    if (!AppState.apiData || AppState.playerDataLoaded) return;
    const sport = document.getElementById('sport').value;
    ensurePlayerDataLoaded(sport)
        .then(() => {
            // Chain the bulk weekly fetch behind the pool fetch, since the Rank column's trend arrows need it and starting it on first render made the arrows pop in seconds late.
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
        // The awaited fetch can resolve as a stale no-op when a new league fetch superseded it mid-flight, and one retry covers that narrow window.
        if (!AppState.playerDataLoaded) await ensurePlayerDataLoaded(sport);
        await progress.finish();
        renderPlayerLeaderboard();
    } catch (err) {
        progress.stop();
        container.innerHTML = `<div class="player-loading">Couldn't load player data: ${err.message}</div>`;
    }
}

let bulkWeeklyFetchInFlight = false;
// Set once a bulk fetch fails, so a failure shows a stable error instead of silently retrying on every re-render. Reset on a genuine new league fetch.
let bulkWeeklyFetchFailed = false;

// True once every real player has cached weekly data, which a windowed timeframe needs before it can compute anything for them.
function leaderboardWeeklyDataReady() {
    return AppState.playerData.every(p =>
        Object.keys(p.seasonTotals || {}).length === 0 || AppState.playerWeeklyCache[p.id]);
}

// Bulk-fetches weekly data for every real player still missing it, then re-renders the leaderboard.

// Ids still to fetch, in priority order.
let weeklyQueue = [];
// Ids handed to a worker but not yet resolved. Held out of a reprioritize pass so two workers can never claim the same id, and released in a finally so a failed chunk does not strand them.
let weeklyClaimedIds = new Set();
// The pool debug context is set from the FIRST chunk of a run only, since setting it per chunk would thrash the panel while chunks stream.
let weeklyPoolContextCaptured = false;

// A burst of chunk completions should repaint once, not once each.
const WEEKLY_RERENDER_DEBOUNCE_MS = 150;
let weeklyRerenderTimer = null;

// An extra observer on each debounced repaint, so a consumer outside the Player tab can react to chunks landing.
let weeklyProgressHook = null;
export function setWeeklyProgressHook(fn) { weeklyProgressHook = fn; }

function scheduleWeeklyRerender() {
    clearTimeout(weeklyRerenderTimer);
    weeklyRerenderTimer = setTimeout(() => {
        weeklyRerenderTimer = null;
        renderPlayerLeaderboard();
        if (weeklyProgressHook) weeklyProgressHook();
    }, WEEKLY_RERENDER_DEBOUNCE_MS);
}

// The player ids whose rows are inside the leaderboard's scroll viewport right now, in visual order.
function visibleLeaderboardPlayerIds() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return [];
    const rows = container.querySelectorAll('.player-row[data-player-id]');
    if (rows.length === 0) return [];
    const box = container.getBoundingClientRect();
    if (box.height === 0) return [];
    const ids = [];
    rows.forEach(row => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > box.top && rect.top < box.bottom) ids.push(Number(row.getAttribute('data-player-id')));
    });
    return ids;
}

// Every id the trend-arrow basis depends on across BOTH group tabs, since the user can switch tabs at any time and that tab's arrows need its own pool covered.
function weeklyBasisPoolIds(sport) {
    const ids = [];
    ['primary', 'secondary'].forEach(group => {
        const samePool = AppState.playerData.filter(p => matchesPlayerGroup(p, sport, group === 'secondary'));
        weeklyBasisQualifiedPool(samePool, sport).forEach(p => ids.push(p.id));
    });
    return ids;
}

// Tier the not-yet-fetched ids: rows on screen first, then the rest of the basis pool, then everyone else.
function prioritizeWeeklyIds(ids, sport) {
    const remaining = new Set(ids);
    const ordered = [];
    const take = (id) => { if (remaining.delete(id)) ordered.push(id); };
    visibleLeaderboardPlayerIds().forEach(take);
    weeklyBasisPoolIds(sport).forEach(take);
    remaining.forEach(id => ordered.push(id));
    return ordered;
}

// Re-tier whatever is left after a scroll or re-sort. Already-fetched and in-flight ids drop out, so nothing is requested twice and nothing in the air is wasted.
export function reprioritizeWeeklyQueue() {
    if (!bulkWeeklyFetchInFlight || weeklyQueue.length === 0) return;
    const sport = document.getElementById('sport').value;
    const stillNeeded = weeklyQueue.filter(id => !AppState.playerWeeklyCache[id] && !weeklyClaimedIds.has(id));
    weeklyQueue = prioritizeWeeklyIds(stillNeeded, sport);
}

// A fixed pool of workers, each pulling the next chunk off the front of the shared queue, which is what lets a reprioritize take effect mid-run.
async function runWeeklyQueue(sport, apiDataRef) {
    const workerCount = Math.min(WEEKLY_MAX_CONCURRENT_CHUNKS, Math.ceil(weeklyQueue.length / WEEKLY_CHUNK_SIZE) || 1);
    const worker = async () => {
        for (;;) {
            const chunk = [];
            while (chunk.length < WEEKLY_CHUNK_SIZE && weeklyQueue.length > 0) {
                const id = weeklyQueue.shift();
                if (AppState.playerWeeklyCache[id] || weeklyClaimedIds.has(id)) continue;
                weeklyClaimedIds.add(id);
                chunk.push(id);
            }
            if (chunk.length === 0) return;
            try {
                const raw = await fetchPlayersWeeklyChunk(chunk);
                // Superseded mid-flight: drop this chunk entirely rather than write another league's rows into the freshly cleared cache, and stop pulling more work.
                if (AppState.apiData !== apiDataRef) return;
                if (!weeklyPoolContextCaptured) {
                    weeklyPoolContextCaptured = true;
                    setDebugContext('player-pool', raw);
                }
                processBulkPlayerWeeklyHistory(raw, sport);
                // A requested player the response did not include gets an empty stub, or the readiness check would stay false forever and every re-render would re-trigger the whole fetch.
                chunk.forEach(id => {
                    if (!AppState.playerWeeklyCache[id]) AppState.playerWeeklyCache[id] = { weekly: {}, weeklySums: {} };
                });
                // Progressive pop-in: repaint as this chunk lands rather than once at the very end.
                scheduleWeeklyRerender();
            } finally {
                chunk.forEach(id => weeklyClaimedIds.delete(id));
            }
        }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
}

async function ensureLeaderboardWeeklyDataLoaded(sport) {
    if (bulkWeeklyFetchInFlight) return;
    const missingIds = AppState.playerData
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id])
        .map(p => p.id);
    if (missingIds.length === 0) return;

    // The same discard rule the pool fetch documents.
    const apiDataRef = AppState.apiData;

    bulkWeeklyFetchInFlight = true;
    weeklyQueue = prioritizeWeeklyIds(missingIds, sport);
    weeklyClaimedIds.clear();
    weeklyPoolContextCaptured = false;
    try {
        await runWeeklyQueue(sport, apiDataRef);
        if (AppState.apiData !== apiDataRef) return;
        bulkWeeklyFetchFailed = false;
    } catch (err) {
        // A failure belonging to a league nobody is looking at any more must not set the sticky failed flag, which would show the new league an error it never hit.
        if (AppState.apiData !== apiDataRef) return;
        console.error('Failed to load weekly stats for the leaderboard timeframe:', err);
        bulkWeeklyFetchFailed = true;
    } finally {
        bulkWeeklyFetchInFlight = false;
        weeklyQueue = [];
        weeklyClaimedIds.clear();
    }
    renderPlayerLeaderboard();
}

// ==== Roto Race: reconstruct the roto standings over time from weekly roster stats ====

// Kick the bulk weekly fetch if it is not already loading or permanently failed, since the Team tab can be opened before the prefetch finished.
export function ensureWeeklyDataForRace(sport) {
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport);
}

// True once the fetch has permanently failed this session, so the race shows an error line instead of hanging on a spinner.
export function weeklyDataFailed() { return bulkWeeklyFetchFailed; }

// The current league's identity, for keying the one-time harvests so a previous league's data is never served. Read from the payload rather than the form fields, so it cannot drift.
function currentLeagueKey() {
    const d = AppState.apiData;
    return d ? `${d.gameId}:${d.id}:${d.seasonId}` : null;
}

let rosterHarvestInFlightKey = null;
let rosterHarvestFailedKey = null;
let snapshotHarvestInFlightKey = null;
let snapshotHarvestFailedKey = null;

// Fetch the draft picks and harvest the transaction log once per league and season, for the transaction-accurate race.
export async function ensureRosterTransactionData(sport) {
    const key = currentLeagueKey();
    if (!key) return;
    if (AppState.rosterTransactionData && AppState.rosterTransactionData.key === key) return;
    if (rosterHarvestInFlightKey === key || rosterHarvestFailedKey === key) return;

    const status = AppState.apiData?.status || {};
    const firstSP = status.firstScoringPeriod;
    const finalSP = status.finalScoringPeriod;
    const leagueId = AppState.apiData?.id;
    const year = AppState.apiData?.seasonId;
    if (!Number.isFinite(firstSP) || !Number.isFinite(finalSP) || leagueId == null || year == null) {
        rosterHarvestFailedKey = key; // can't harvest without the period bounds, stay on the fallback
        return;
    }

    const apiDataRef = AppState.apiData;
    rosterHarvestInFlightKey = key;
    try {
        const [picks, transactions] = await Promise.all([
            fetchDraftDetail(sport, leagueId, year),
            harvestTransactions(sport, leagueId, year, firstSP, finalSP)
        ]);
        if (AppState.apiData !== apiDataRef) return; // superseded by a newer league fetch, drop it
        // Both empty means no usable history, so leave the data null and let the race keep its current-roster fallback.
        if (picks.length === 0 && transactions.length === 0) {
            rosterHarvestFailedKey = key;
        } else {
            AppState.rosterTransactionData = { key, picks, transactions };
        }
    } catch (err) {
        if (AppState.apiData !== apiDataRef) return;
        console.error('Failed to harvest the transaction log for the Roto Race:', err);
        rosterHarvestFailedKey = key;
    } finally {
        if (rosterHarvestInFlightKey === key) rosterHarvestInFlightKey = null;
        if (weeklyProgressHook) weeklyProgressHook(); // re-render the race with whatever we ended up with
    }
}

// Harvest the daily roster snapshots once per league and season, for the lineup-aware race.
export async function ensureRosterSnapshotData(sport) {
    const key = currentLeagueKey();
    if (!key) return;
    if (AppState.rosterSnapshotData && AppState.rosterSnapshotData.key === key) return;
    if (snapshotHarvestInFlightKey === key || snapshotHarvestFailedKey === key) return;

    const status = AppState.apiData?.status || {};
    const firstSP = status.firstScoringPeriod;
    const finalSP = status.finalScoringPeriod;
    const leagueId = AppState.apiData?.id;
    const year = AppState.apiData?.seasonId;
    if (!Number.isFinite(firstSP) || !Number.isFinite(finalSP) || leagueId == null || year == null) {
        snapshotHarvestFailedKey = key;
        return;
    }

    const apiDataRef = AppState.apiData;
    snapshotHarvestInFlightKey = key;
    try {
        const { days } = await harvestRosters(sport, leagueId, year, firstSP, finalSP);
        if (AppState.apiData !== apiDataRef) return; // superseded by a newer league fetch, drop it
        // No days at all means the season predates ESPN's stored daily rosters, so leave it null and fall back to the transaction timeline.
        if (Object.keys(days).length === 0) {
            snapshotHarvestFailedKey = key;
        } else {
            AppState.rosterSnapshotData = { key, days };
        }
    } catch (err) {
        if (AppState.apiData !== apiDataRef) return;
        console.error('Failed to harvest the daily roster snapshots for the Roto Race:', err);
        snapshotHarvestFailedKey = key;
    } finally {
        if (snapshotHarvestInFlightKey === key) snapshotHarvestInFlightKey = null;
        if (weeklyProgressHook) weeklyProgressHook();
    }
}

// The scoring period standing in for a real week when reading ownership: a mid-week point, the best single-owner proxy available without re-bucketing the cache to per-period granularity.
function representativePeriodForWeek(week) { return week * 7 + 3; }

// True while the race should HOLD its loading state rather than draw, because the best tier still expected has not arrived.
function rotoRaceDataPending() {
    const key = currentLeagueKey();
    if (!key) return false;
    // No weekly stats, no race. A failure here is terminal and surfaces its own error state.
    if (!bulkWeeklyFetchFailed && !leaderboardWeeklyDataReady()) return true;
    // Snapshots, the started tier, are expected until their harvest fails.
    if (snapshotHarvestFailedKey !== key) {
        return !(AppState.rosterSnapshotData && AppState.rosterSnapshotData.key === key);
    }
    // Snapshots are out, so the transaction log is the best tier still expected.
    if (rosterHarvestFailedKey !== key) {
        return !(AppState.rosterTransactionData && AppState.rosterTransactionData.key === key);
    }
    return false; // both harvests failed, so current rosters is the final answer, draw it
}

// The league's STARTING lineup-slot ids: every slot it actually rosters, minus the bench and IR ids for the sport.
function startingSlotsForLeague(sport) {
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const benchIr = NON_STARTING_SLOTS[sport] || new Set();
    const starting = new Set();
    Object.keys(counts).forEach(slotId => {
        const id = Number(slotId);
        if (counts[slotId] > 0 && !benchIr.has(id)) starting.add(id);
    });
    return starting;
}

// The started-tier accumulation, factored out so the race and the windowed standings and heatmap share ONE source of truth: per team, a week to sums map of started-day components.
let rotoStartedSumsCache = null;
function rotoStartedSums(sport) {
    if (!AppState.isRotoLeague) return null;
    const key = currentLeagueKey();
    if (!key) return null;
    const snapData = AppState.rosterSnapshotData;
    if (!snapData || snapData.key !== key) return null;   // started tier not available
    if (!leaderboardWeeklyDataReady()) return null;       // components still streaming in

    const cacheSize = Object.keys(AppState.playerWeeklyCache).length;
    if (rotoStartedSumsCache && rotoStartedSumsCache.key === key && rotoStartedSumsCache.cacheSize === cacheSize) {
        return rotoStartedSumsCache;
    }

    const teamIdSet = new Set(AppState.teamStats.map(t => t.id));
    const startedTL = buildStartedTimeline({ rosterDays: snapData.days, startingSlots: startingSlotsForLeague(sport) });
    const teamWeeklySums = new Map(AppState.teamStats.map(t => [t.id, {}]));
    const weekSet = new Set();
    AppState.playerData.forEach(p => {
        const daily = AppState.playerWeeklyCache[p.id]?.dailyByPeriod;
        if (!daily) return;
        Object.keys(daily).forEach(periodKey => {
            const period = Number(periodKey);
            const teamId = startedTeamForPlayerAtPeriod(startedTL, p.id, period);
            if (!teamId || !teamIdSet.has(teamId)) return;
            const week = weekOfScoringPeriod(period);
            weekSet.add(week);
            const dest = teamWeeklySums.get(teamId);
            if (!dest[week]) dest[week] = { sums: {}, games: 0 };
            dest[week].games += daily[periodKey].games;
            Object.keys(daily[periodKey].sums).forEach(id => {
                dest[week].sums[id] = (dest[week].sums[id] || 0) + daily[periodKey].sums[id];
            });
        });
    });

    rotoStartedSumsCache = { key, cacheSize, teamWeeklySums, weeks: Array.from(weekSet).sort((a, b) => a - b) };
    return rotoStartedSumsCache;
}

// True when roto windows are available at all, meaning the started tier landed and produced weeks.
export function rotoWindowsAvailable(sport) {
    const acc = rotoStartedSums(sport);
    return !!(acc && acc.weeks.length > 0);
}
export function rotoWindowMaxWeek(sport) {
    const acc = rotoStartedSums(sport);
    return acc && acc.weeks.length ? acc.weeks[acc.weeks.length - 1] : 0;
}

// The active roto window, or null on the full season, which always shows ESPN's official standings verbatim rather than a computed window.
export function activeRotoWindow(sport) {
    if (!AppState.isRotoLeague) return null;
    const tf = AppState.timeframe;
    if (typeof tf !== 'string' || !tf.startsWith('last')) return null;
    const acc = rotoStartedSums(sport);
    if (!acc || acc.weeks.length === 0) return null;
    const n = parseInt(tf.slice(4), 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const maxWeek = acc.weeks[acc.weeks.length - 1];
    return { start: Math.max(acc.weeks[0], maxWeek - n + 1), end: maxWeek };
}

// Per-category cumulative weekly values for the category race, off the same started-day sums the windowed standings and heatmap read, so a category's race and its ranking bar can never disagree.
let rotoCatSeriesCache = null;
export function rotoCategorySeries(sport) {
    const acc = rotoStartedSums(sport);
    if (!acc || acc.weeks.length === 0) return null;
    const win = activeRotoWindow(sport);
    const start = win ? win.start : acc.weeks[0];
    const end = win ? win.end : acc.weeks[acc.weeks.length - 1];
    const weeks = acc.weeks.filter(w => w >= start && w <= end);
    if (weeks.length < 2) return null;

    const cacheId = `${acc.key}:${acc.cacheSize}:${start}:${end}`;
    if (rotoCatSeriesCache && rotoCatSeriesCache.id === cacheId) return rotoCatSeriesCache;

    const byTeam = new Map();
    AppState.teamStats.forEach(t => {
        const sums = acc.teamWeeklySums.get(t.id);
        byTeam.set(t.id, weeks.map(w => aggregateStatsForWeekRange(sums, start, w, sport)));
    });
    rotoCatSeriesCache = { id: cacheId, weeks, byTeam };
    return rotoCatSeriesCache;
}

// Re-scores the categories over ONLY the window's accumulated started-day components: sum each team's raw components, derive the rate categories from those sums rather than averaging per-day rates, then run the same pure scoring the race uses.
let rotoWindowResultCache = {};
export function computeRotoWindow(sport, startWeek, endWeek) {
    const acc = rotoStartedSums(sport);
    if (!acc) return null;
    const cacheId = `${acc.key}:${acc.cacheSize}:${startWeek}:${endWeek}`;
    if (rotoWindowResultCache[cacheId]) return rotoWindowResultCache[cacheId];

    const inverseSet = INVERSE_STATS[sport] || new Set();
    const categories = Array.from(AppState.scoredStatIds).map(id => ({ id, inverse: inverseSet.has(id) }));
    const catValuesByTeam = new Map();
    const scoreInput = AppState.teamStats.map(t => {
        const values = aggregateStatsForWeekRange(acc.teamWeeklySums.get(t.id), startWeek, endWeek, sport);
        catValuesByTeam.set(t.id, values);
        return { id: t.id, values };
    });

    // Per-category points, summed into each team's total.
    const pointsByTeam = new Map(scoreInput.map(t => [t.id, 0]));
    const pointsByStatByTeam = new Map(scoreInput.map(t => [t.id, {}]));
    categories.forEach(cat => {
        const entries = scoreInput.map(t => ({ id: t.id, value: t.values[cat.id] }));
        rotoPointsForCategory(entries, cat.inverse).forEach((pts, id) => {
            pointsByTeam.set(id, pointsByTeam.get(id) + pts);
            pointsByStatByTeam.get(id)[cat.id] = pts;
        });
    });

    const result = { pointsByTeam, catValuesByTeam, pointsByStatByTeam };
    rotoWindowResultCache = { [cacheId]: result }; // keep only the latest window, since only one is displayed at a time
    return result;
}

// Builds the race: credit each player's stats to a team over time, aggregate each team's cumulative category values, score them roto-style across teams, and record each running total.
export function buildRotoRaceSeries(sport) {
    const inverseSet = INVERSE_STATS[sport] || new Set();
    const categories = Array.from(AppState.scoredStatIds).map(id => ({ id, inverse: inverseSet.has(id) }));
    const teamIdSet = new Set(AppState.teamStats.map(t => t.id));

    const leagueKey = currentLeagueKey();
    // Hold one loading state until the best tier still expected is COMPLETE, then draw once. Returning early also skips an accumulation that would be thrown away.
    if (rotoRaceDataPending()) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode: 'loading', loading: true };
    }

    const snapData = AppState.rosterSnapshotData;
    const txData = AppState.rosterTransactionData;
    const useSnapshots = !!(snapData && snapData.key === leagueKey);
    const useTimeline = !useSnapshots && !!(txData && txData.key === leagueKey);
    const mode = useSnapshots ? 'started' : (useTimeline ? 'rostered' : 'current');

    // Accumulate into a shared per-team structure, so the cumulative scoring below is identical for all three modes and they differ only in which team a slice of stats credits.
    const teamWeeklySums = new Map(AppState.teamStats.map(t => [t.id, {}]));
    const weekSet = new Set();
    const credit = (teamId, week, bucket) => {
        if (!teamId || !teamIdSet.has(teamId)) return;
        weekSet.add(week);
        const dest = teamWeeklySums.get(teamId);
        if (!dest[week]) dest[week] = { sums: {}, games: 0 };
        dest[week].games += bucket.games;
        Object.keys(bucket.sums).forEach(id => { dest[week].sums[id] = (dest[week].sums[id] || 0) + bucket.sums[id]; });
    };

    if (useSnapshots) {
        // The started tier folds in the same per-team week sums the windowed standings and heatmap read, so the race's points and any window's points come off the very same components.
        const acc = rotoStartedSums(sport);
        if (acc) acc.teamWeeklySums.forEach((weekMap, teamId) => {
            Object.keys(weekMap).forEach(week => credit(teamId, Number(week), weekMap[week]));
        });
    } else if (useTimeline) {
        const timeline = buildRosterTimeline(txData);
        const ownedIds = new Set(timeline.keys());
        AppState.playerData.forEach(p => {
            if (!hasCachedWeeklyData(p) || !ownedIds.has(p.id)) return;
            const weeklySums = AppState.playerWeeklyCache[p.id].weeklySums;
            Object.keys(weeklySums).forEach(week => {
                const w = Number(week);
                credit(teamForPlayerAtPeriod(timeline, p.id, representativePeriodForWeek(w)), w, weeklySums[week]);
            });
        });
    } else {
        AppState.playerData.forEach(p => {
            if (!hasCachedWeeklyData(p) || p.teamId == null || !teamIdSet.has(p.teamId)) return;
            const weeklySums = AppState.playerWeeklyCache[p.id].weeklySums;
            Object.keys(weeklySums).forEach(week => credit(p.teamId, Number(week), weeklySums[week]));
        });
    }

    const allWeeks = Array.from(weekSet).sort((a, b) => a - b);
    if (allWeeks.length === 0 || categories.length === 0) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode };
    }

    // A lookback pill re-bases the race onto that window: draw only the window's weeks and accumulate from the window's FIRST week, so the final point is exactly the windowed standings shown in the Rankings box.
    const win = activeRotoWindow(sport);
    const weeks = win ? allWeeks.filter(w => w >= win.start && w <= win.end) : allWeeks;
    const baseWeek = win ? win.start : allWeeks[0];
    if (weeks.length === 0) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode };
    }

    // Cumulative team category values through each week, scored into a running roto total, through the same aggregation the arrows and drill-down use so rate stats aggregate identically.
    const seriesByTeam = new Map(AppState.teamStats.map(t => [t.id, []]));
    weeks.forEach(week => {
        const scoreInput = AppState.teamStats.map(t => ({
            id: t.id,
            values: aggregateStatsForWeekRange(teamWeeklySums.get(t.id), baseWeek, week, sport)
        }));
        const totals = scoreRotoWeek(scoreInput, categories);
        AppState.teamStats.forEach(t => seriesByTeam.get(t.id).push(totals.get(t.id) || 0));
    });

    return {
        weeks,
        seriesByTeam,
        categoryCount: categories.length,
        teams: AppState.teamStats.map(t => ({ id: t.id, name: t.name })),
        mode
    };
}

// Called on a genuine new league or season fetch: this module's per-league caches and sticky flags all have to go with it.
export function resetLeaderboardWeeklyFetchState() {
    bulkWeeklyFetchFailed = false;
    Object.keys(playerDetailDiagnostics).forEach(id => delete playerDetailDiagnostics[id]);
    // Both harvests are per league and season, so clear the sticky in-flight and failed flags too. The cached data is key-guarded, but the flags are not.
    rosterHarvestInFlightKey = null;
    rosterHarvestFailedKey = null;
    snapshotHarvestInFlightKey = null;
    snapshotHarvestFailedKey = null;
    AppState.rosterTransactionData = null;
    AppState.rosterSnapshotData = null;
    // The windowed-roto memoization is keyed by league and cache size, but the snapshot data it reads is cleared above, so drop the derived caches rather than serve a stale league's sums.
    rotoStartedSumsCache = null;
    rotoWindowResultCache = {};
    rotoCatSeriesCache = null;
}

// Called on every league, season or sport switch, before the player tab reloads.
export function normalizePlayerViewStateForLeague() {
    const sport = document.getElementById('sport').value;
    const statMap = ESPN_STAT_MAPS[sport] || {};

    const sortStat = AppState.playerSortStat;
    const universalSortKeys = new Set(['name', 'teamName', 'positionName', 'gp', 'ip']);
    let sortValid;
    if (universalSortKeys.has(sortStat)) sortValid = true;
    else if (sortStat === 'total') sortValid = AppState.isPointsLeague;
    else if (sortStat === 'rotoScore') sortValid = !AppState.isPointsLeague;
    else sortValid = statMap[sortStat] !== undefined; // a stat-id column this sport actually has
    if (!sortValid) AppState.playerSortStat = AppState.isPointsLeague ? 'total' : 'rotoScore';

    const posFilter = AppState.playerPositionFilter;
    if (posFilter && posFilter !== 'ALL') {
        // Every position this sport can show: primary-role names plus the specific slot names. The render-time builder handles the within-sport case, and this catches cross-sport carryover earlier.
        const validPositions = new Set([
            ...Object.values(POSITION_MAPS[sport] || {}),
            ...Object.values(SLOT_POSITION_MAPS[sport] || {})
        ]);
        if (!validPositions.has(posFilter)) AppState.playerPositionFilter = 'ALL';
    }
}

// Sorts the leaderboard in place per the current selection, shared with the export builder so an export is always ordered exactly like the table it mirrors.
function sortLeaderboardPlayers(players, rotoRanks, sport) {
    // Defense in depth: a roto sort has no data in a points league, and although the league switch already converts it, a null dereference here would empty the whole tab.
    let sortStat = AppState.playerSortStat;
    if (sortStat === 'rotoScore' && !rotoRanks) sortStat = 'total';
    const dir = AppState.playerSortDir === 'asc' ? 1 : -1;
    const stringSortKeys = { name: 'name', teamName: 'teamName', positionName: 'positionDisplay' };
    players.sort((a, b) => {
        // Unranked rows, the zero-games cohort the engine's floor refuses to score, sit below every ranked row whichever column is sorted and in whichever direction.
        if (rotoRanks) {
            const aRanked = rotoRanks.ranks.has(a.id);
            if (aRanked !== rotoRanks.ranks.has(b.id)) return aRanked ? -1 : 1;
        }
        if (stringSortKeys[sortStat]) return a[stringSortKeys[sortStat]].localeCompare(b[stringSortKeys[sortStat]]) * dir;
        if (sortStat === 'rotoScore') return ((rotoRanks.scores.get(a.id) || 0) - (rotoRanks.scores.get(b.id) || 0)) * dir;
        if (sortStat === 'gp') return (gamesPlayedOf(a, sport) - gamesPlayedOf(b, sport)) * dir;
        if (sortStat === 'ip') return ((a.seasonTotals[IP_STAT_ID] || 0) - (b.seasonTotals[IP_STAT_ID] || 0)) * dir;
        // Before the season starts the applied total is 0 for everyone, so fall back to ESPN's projection and keep a meaningful ranking rather than raw fetch order.
        const av = sortStat === 'total' ? (a.appliedTotal || a.projectedAppliedTotal || 0) : (a.seasonTotals[sortStat] || 0);
        const bv = sortStat === 'total' ? (b.appliedTotal || b.projectedAppliedTotal || 0) : (b.seasonTotals[sortStat] || 0);
        return (av - bv) * dir;
    });
}

// A structured snapshot of the leaderboard exactly as configured, so what exports is what is on screen.
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
    // Mirrors the leaderboard's own rule: unranked rows are hidden with the minimum-games toggle on and kept, sorted last, with it off.
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));
    // The same default-sort normalization the leaderboard applies, since an export taken before its first render would otherwise sort a category league by the points default instead of Rank.
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

    // Innings pitched is a baseball-pitcher column only.
    const showInnings = wantPitchers && sport === 'flb';
    const headers = [
        'Player', 'Team', 'Pos',
        ...(AppState.isPointsLeague ? ['Total'] : ['Rank', 'Rank Score']),
        'GP',
        ...(showInnings ? ['IP'] : []),
        ...statIds.map(id => statMap[id])
    ];
    const rows = players.map(p => [
        p.name, p.teamName, p.positionDisplay,
        ...(AppState.isPointsLeague
            ? [exportCell(p.appliedTotal)]
            // An unranked row exports the same placeholder the table shows, with a blank score rather than a fabricated 0.
            : rotoRanks.ranks.has(p.id)
                ? [rotoRanks.ranks.get(p.id), +(rotoRanks.scores.get(p.id) || 0).toFixed(1)]
                : ['-', '']),
        exportCell(gamesPlayedOf(p, sport)) || 0,
        ...(showInnings ? [p.seasonTotals[IP_STAT_ID] !== undefined ? +(p.seasonTotals[IP_STAT_ID] / 3).toFixed(2) : ''] : []),
        ...statIds.map(id => exportCell(p.seasonTotals[id]))
    ]);

    return { headers, rows };
}

export function renderPlayerLeaderboard() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    // Returning silently here used to leave the PREVIOUS league's rows painted on screen, because every direct caller hit the early return after the league switch cleared the loaded flag.
    if (!AppState.playerDataLoaded) {
        const playerView = document.getElementById('view-player');
        const onScreen = playerView && playerView.style.display !== 'none';
        if (onScreen && !container.querySelector('.player-loading, .player-loading-progress')) {
            container.innerHTML = '<div class="player-loading">Loading players...</div>';
        }
        return;
    }

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
    // Innings pitched is baseball-pitcher-only, since hockey's secondary group is goalies.
    const showInnings = wantPitchers && sport === 'flb';
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

    // A real applied total only exists for points-format leagues.
    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = !AppState.isPointsLeague ? computeRotoRanks(rankPool, sport, posFilter) : null;

    // With the minimum-games toggle on, the ranks hold exactly the players who cleared the threshold, so the rest are hidden entirely rather than shown with a placeholder nobody asked for.
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));

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

    // Medals for the current pool's top three, already scoped to the active position filter, plus weekly-form arrows. Both live in the Rank column, which points leagues do not have.
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
                    ${showInnings ? `<th class="sortable" data-sort="ip">IP${sortArrow('ip')}</th>` : ''}
                    ${statIds.map(id => `<th class="sortable player-col-stat" data-sort="${id}">${escapeHtml(statMap[id])}${sortArrow(id)}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
    `;

    players.forEach(p => {
        html += `
            <tr class="player-row" data-player-id="${p.id}">
                <td class="player-col-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                <td class="player-col-team" title="${escapeHtml(p.teamName)}">${p.teamColor ? `<span class="legend-color" style="background:${p.teamColor};width:10px;height:10px;"></span>` : ''}${escapeHtml(p.teamName)}</td>
                <td class="player-col-pos" title="${escapeHtml(p.positionDisplay)}">${escapeHtml(p.positionDisplay)}</td>
                ${AppState.isPointsLeague ? `<td>${p.appliedTotal.toFixed(1)}</td>` : `<td>${rotoRanks.ranks.has(p.id) ? `#${rotoRanks.ranks.get(p.id)} of ${rotoRanks.total}${rankExtrasFor(p)}` : '<span class="rank-unranked" title="No games played, nothing to rank on">-</span>'}</td>`}
                <td>${formatStatValue(gamesPlayedOf(p, sport))}</td>
                ${showInnings ? `<td>${formatInnings(p.seasonTotals[IP_STAT_ID])}</td>` : ''}
                ${statIds.map(id => `<td class="player-col-stat">${formatStatValue(p.seasonTotals[id])}</td>`).join('')}
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

    // The arrows need per-week data for the whole pool, so when it is not cached the fetch runs quietly in the background and each chunk's re-render pops more arrows in.
    if (!AppState.isPointsLeague && !leaderboardWeeklyDataReady() && !bulkWeeklyFetchFailed) {
        ensureLeaderboardWeeklyDataLoaded(sport);
    }

    // The rows just changed, so what is on screen changed too and the rest of the queue is re-tiered behind it. A no-op when no fetch is running.
    reprioritizeWeeklyQueue();
}

// Raw single-player weekly responses kept for the diagnostic panel only, keyed by player id for the session.
const playerDetailDiagnostics = {};
let detailDiagnosticInFlight = false;

// The drill-down's own weekly fetch is skipped whenever the bulk warm-up already cached that player, which is virtually always.
export async function ensurePlayerDetailDiagnostic() {
    const playerId = AppState.selectedPlayerId;
    if (playerId == null || hasDebugContext('player-detail') || detailDiagnosticInFlight) return;

    const cached = playerDetailDiagnostics[playerId];
    if (cached) {
        setDebugContext('player-detail', cached);
        return;
    }

    // Captured for the same discard rule the pool and bulk fetches use, since this fetch has the same hole.
    const apiDataRef = AppState.apiData;

    detailDiagnosticInFlight = true;
    setDebugLoading('player-detail', true);
    try {
        const raw = await fetchPlayerWeeklyStats(playerId);
        if (AppState.apiData !== apiDataRef) {
            // Wrong league or season now, so neither cache it (the cache is keyed by player id, and a payload differs per season) nor show it.
            setDebugLoading('player-detail', false);
            return;
        }
        // Still this league, so the payload is genuinely this player's and worth caching even if the user has moved on. Only show it while he is still on screen, or the panel would label one player's data with another's name.
        playerDetailDiagnostics[playerId] = raw;
        if (AppState.selectedPlayerId === playerId) setDebugContext('player-detail', raw);
        else setDebugLoading('player-detail', false);
    } catch (err) {
        // Diagnostics are best-effort: fall back to the placeholder rather than disturb the drill-down, which is already rendered and fine.
        setDebugLoading('player-detail', false);
        console.error('Failed to capture the player detail diagnostic:', err);
    } finally {
        detailDiagnosticInFlight = false;
    }
}

// preserveView marks a reopen of the SAME player after a refresh. Comparing ids cannot detect that, because the fetch already wiped the selected id before this runs.
export async function openPlayerDetail(playerId, preserveView = false) {
    if (!AppState.playerData.some(p => p.id === playerId)) return;
    const sport = document.getElementById('sport').value;

    // Only reset the drill-down's own view state when switching to a genuinely different player, so reopening the same one keeps whatever was selected.
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
    // Point the diagnostic panel at THIS player immediately, even before the fetch resolves or when it is skipped entirely, so the panel always matches the drill-down on screen.
    setDebugContext('player-detail', playerDetailDiagnostics[playerId] || null);
    setActiveDebugKind('player-detail');

    if (!AppState.playerWeeklyCache[playerId]) {
        try {
            const raw = await fetchPlayerWeeklyStats(playerId);
            playerDetailDiagnostics[playerId] = raw;
            setDebugContext('player-detail', raw);
            AppState.playerWeeklyCache[playerId] = processPlayerWeeklyHistory(raw, sport);
        } catch (err) {
            detailContainer.innerHTML = `<div class="player-loading">Couldn't load this player's history: ${err.message}</div>`;
            return;
        }
    }

    // Looked up AFTER the weekly-cache fetch, so a windowed timeframe can find this player's just-cached data instead of excluding him for not having it yet.
    const player = getEffectivePlayerPool(sport).find(p => p.id === playerId);
    if (!player) {
        // The season pool has this player, but the effective pool for the current window does not, even after the fetch above.
        closePlayerDetail();
        return;
    }
    renderPlayerDetail(player);

    // Capture for this player right away when the panel is already expanded, since the toggle hook only fires on open and comparing several players would otherwise show an empty placeholder each time.
    if (document.getElementById('debug-panel')?.open) ensurePlayerDetailDiagnostic();
}

export function closePlayerDetail() {
    AppState.selectedPlayerId = null;
    document.getElementById('player-detail-container').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'flex';
    document.getElementById('player-toolbar').style.display = 'flex';
    // Back to the leaderboard, so the panel switches to the pool context it already has cached.
    setActiveDebugKind('player-pool');
}

// The same scored and advanced split used everywhere else, scoped to the group tab this detail view was opened from rather than the player's own primary role.
function statIdsForPlayer(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    const roleIds = Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(roleIds, statMap);
    // ESPN's raw FPTS is a generic points formula unrelated to this league's scoring settings, so it is excluded entirely rather than offered as a selectable stat.
    const withoutFpts = deduped.filter(id => statMap[id] !== 'FPTS');
    const withData = withoutFpts.filter(id => Object.values(weekly).some(w => w[id] !== undefined) || player.seasonTotals[id] !== undefined);

    return splitScoredAdvanced(withData);
}

// A few players either side of this one in a rank list, for the chip's hover dropdown. The list is already sorted best to worst.
function getRankNeighbors(ranked, playerId, ranks = null, windowSize = 3) {
    const idx = ranked.findIndex(p => p.id === playerId);
    if (idx === -1) return [];
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(ranked.length, idx + windowSize + 1);
    return ranked.slice(start, end).map((p, i) => ({ player: p, rank: ranks ? ranks[start + i] : start + i + 1 }));
}

// poolKey identifies which comparison pool a chip represents, and clicking it points the breakdown at THAT pool's math, which is what answers why a position score differs from Overall.
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

// Overall rank plus one rank per eligible position, since a smaller comparison pool naturally produces different percentiles and showing one number would hide that.
function buildRankChipsHtml(player, sport) {
    if (AppState.isPointsLeague) return '';
    const wantPitchers = AppState.playerGroup === 'secondary';
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeRotoRanks(samePool, sport);
    const chips = [buildRankChipHtml('Overall', overallRoto, player)];
    // For a two-way player, only show chips for the positions relevant to the CURRENT group, or the wrong-role stats would be compared against the wrong-role pool.
    const relevantPositions = player.eligiblePositions.filter(pos => pitcherPositions.has(pos) === wantPitchers);
    relevantPositions.forEach(pos => {
        const posPool = samePool.filter(p => matchesPositionFilter(p, pos));
        // Skip a positional chip whose pool IS the group pool, since it would only restate Overall.
        if (posPool.length === samePool.length) return;
        chips.push(buildRankChipHtml(pos, computeRotoRanks(posPool, sport, pos), player));
    });
    return chips.filter(Boolean).join('');
}

// Explains how the selected chip's score is built, category by category. Every number in the table derives from the two values above it via the formula in the caption, so nothing is a mystery number.
function buildRankBreakdownHtml(player, sport) {
    if (AppState.isPointsLeague) return '';
    // Which role's breakdown to show, keyed off the current group tab rather than the player's primary position, so a two-way player opened from the Pitchers tab gets the pitching breakdown.
    const isPitching = AppState.playerGroup === 'secondary';
    const roleLabel = (GROUP_LABELS[sport] || GROUP_LABELS.flb)[isPitching ? 'secondary' : 'primary'];
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitching));

    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    // Only RP matches by primary role instead of eligibility. SP uses plain eligibility, like every other position filter.
    const isRpPool = selectedPool === 'RP';
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;

    // RP skips shrinkage entirely and compares K as K/9 rather than a raw total.
    const { rows, excluded, shrink, avg, qualifiedCount } = computeCategoryBreakdown(player, poolPlayers, sport, selectedPool);
    if (rows.length === 0) return '';

    // Label the pool with the QUALIFIED count the score was computed against, not the full eligible pool, since the percentiles are of that pool and citing the larger group made them irreconcilable.
    const poolCount = qualifiedCount.toLocaleString();
    const poolDescription = isPositionPool
        ? `${poolCount} qualified ${selectedPool}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}`
        : `${poolCount} qualified ${roleLabel}`;

    const workloadLabel = (sport === 'flb' && isPitching) ? 'innings pitched' : 'games played';
    const shrinkPct = (shrink * 100).toFixed(0);
    const rowsHtml = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.name)}${r.inverse ? ' <span title="Lower is better for this category">&darr;</span>' : ''}</td>
            <td>${formatBreakdownValue(r.value)}</td>
            <td>${r.rawPct.toFixed(1)}</td>
            <td>${r.adjPct.toFixed(1)}</td>
        </tr>
    `).join('');
    const excludedHtml = excluded.length
        ? `<div class="rank-breakdown-excluded"><strong>Excluded</strong> (no real opportunity): ${excluded.map(e => escapeHtml(e.name)).join(', ')}</div>`
        : '';
    // One tight line per concept and no formula dump: the table below demonstrates the actual math, and these only say what each column means.
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

// Re-renders the open player detail view in place, and a no-op when no player is open.
export function refreshOpenPlayerDetail() {
    if (!AppState.selectedPlayerId) return;
    const sport = document.getElementById('sport').value;
    // The drill-down always caches weekly data for whoever it opens, so an open player is guaranteed to be found here.
    const player = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    if (player) renderPlayerDetail(player);
}

function renderPlayerDetail(player) {
    const container = document.getElementById('player-detail-container');
    const sport = document.getElementById('sport').value;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { weekly = {} } = AppState.playerWeeklyCache[player.id] || {};

    // The league's own matchup schedule can end well short of the real season, so take whichever range is larger and avoid cutting off real weeks of a player's data just because the league stopped defining matchups.
    const effectiveMaxWeek = Math.max(AppState.maxCompletedWeek, 0, ...Object.keys(weekly).map(Number));

    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const statOptions = visibleIds.map(id => ({ id, name: statMap[id] }));
    // Category leagues get the computed weekly score as a selectable trend in place of ESPN's removed FPTS. Points leagues already have a real per-week points total, so there is nothing to replace.
    if (!AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_RANK_STAT_ID, name: `${axisUnit().long} Score` });

    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || statOptions[0];
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    const rankChipsHtml = buildRankChipsHtml(player, sport);
    const rankBreakdownHtml = buildRankBreakdownHtml(player, sport);

    // Rank pager for the header: Prev walks up the selected pool's ranking and Next walks down it, so a position chip pages through that position's own ranking.
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
        // The same neighbours hover as the rank chips, scoped to this one category's ordering, passing the tie-aware ranks so a tied neighbour shows the same shared rank.
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

    // preserveView keeps the selected pool, stat and breakdown state while walking a ranking, so paging through a position pool stays that pool's walk.
    const prevBtn = document.getElementById('player-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', () => openPlayerDetail(pager.prev.player.id, true));
    const nextBtn = document.getElementById('player-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', () => openPlayerDetail(pager.next.player.id, true));

    // Clicking a chip picks which pool's math the breakdown explains, and re-rendering the whole detail view is cheap enough.
    container.querySelectorAll('.rank-chip').forEach(chipEl => {
        chipEl.addEventListener('click', () => {
            // Only switches which pool the breakdown explains, without forcing it open: open updates in place, closed stays closed until the user opens it.
            AppState.playerDetailRankPool = chipEl.dataset.rankPool;
            renderPlayerDetail(player);
        });
    });

    // Track manual open and close, so re-rendering does not keep resetting the panel back to collapsed under the user.
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

// A ranking per week, replacing ESPN's raw per-week FPTS with a roto-style score computed week by week. Each real week is scored against the pool's OTHER REAL weeks rather than an implied typical week, which was pinning an everyday player's chart near the top all season regardless of a real slump.
function weeklyBasisQualifiedPool(samePool, sport) {
    const maxGames = Math.max(0, ...samePool.map(p => gamesPlayedOf(p, sport)));
    if (maxGames === 0) return samePool;
    const threshold = maxGames * MIN_PLAYING_TIME_FRACTION;
    return samePool.filter(p => gamesPlayedOf(p, sport) >= threshold);
}

// COVERAGE RULE: the weekly cache only holds real data once the leaderboard's bulk fetch has run, so on a fresh load or right after a league switch it can be empty or partly filled.
const WEEKLY_BASIS_COVERAGE_THRESHOLD = 0.9;

// Converts a derived per-week stat map to per-GAME rates for its counting stats, leaving rate stats and a zero-games week unchanged.
function perGameCountingStats(weekStatMap, games, avgStatIds) {
    if (!weekStatMap || !(games > 0)) return weekStatMap;
    const out = {};
    for (const id in weekStatMap) {
        const v = weekStatMap[id];
        out[id] = (v !== undefined && !avgStatIds.has(id)) ? v / games : v;
    }
    return out;
}

function buildWeeklyRateBasis(sport) {
    const wantPitchers = AppState.playerGroup === 'secondary';
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    // Scoped to the current group's role so a two-way player's off-role stats do not leak into this pool's category list.
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const relevantStatIds = Array.from(AppState.scoredStatIds).filter(id =>
        (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && samePool.some(p => p.seasonTotals[id] !== undefined));
    const { start: windowStart, end: windowEnd } = playerTimeframeBounds(sport);
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
                .map(w => {
                    const games = (cache.weeklySums[w] && cache.weeklySums[w].games) || 0;
                    // Per-game, so a long final-matchup bucket does not dominate the distribution.
                    return { stats: perGameCountingStats(cache.weekly[w], games, avgStatIds), games };
                });
            return { id: p.id, seasonTotals: p.seasonTotals, weeks };
        });
        const categoryRates = buildWeeklyValueBasis(weeklyValuesByPlayer, { relevantStatIds, inverseStatIds, avgStatIds });
        // Every category came back empty, for instance a fresh single-matchup window with no completed weeks in anyone's cache to build a distribution from.
        if (categoryRates.length > 0) return { categoryRates, windowStart, windowEnd, perGame: true };
    }

    // Coverage is too thin, or the real-value basis came back empty, to trust yet.
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport);

    const categoryRates = buildCategoryRateBasis(samePool, {
        relevantStatIds, inverseStatIds, avgStatIds,
        weeksElapsed: Math.max(1, windowEnd - windowStart + 1)
    });
    return { categoryRates, windowStart, windowEnd, perGame: false };
}

function computeWeeklyRankSeries(player, sport, weekly, weeks) {
    const { categoryRates, perGame } = buildWeeklyRateBasis(sport);
    const avgStatIds = AVERAGE_STATS[sport] || new Set();
    const weeklySums = (AppState.playerWeeklyCache[player.id] || {}).weeklySums || {};
    const scores = {};
    weeks.forEach(w => {
        // Score against the same units the basis was built in: per-game for the value basis, raw per-week for the season-average fallback.
        const games = (weeklySums[w] && weeklySums[w].games) || 0;
        const stats = perGame ? perGameCountingStats(weekly[w], games, avgStatIds) : weekly[w];
        const score = scoreWeekAgainstBasis(player, stats, categoryRates);
        if (score !== null) scores[w] = score;
    });
    return scores;
}

// How far a weekly score has to move off the player's own average, in percentile points, before it counts as a trend rather than ordinary noise.
const TREND_THRESHOLD = 10;

// Below this fraction of the current matchup elapsed no arrows show at all, since a single hot or cold day prorates into a wild pace that is not a trend yet.
const MIN_TREND_FRACTION = 0.25;

// Weekly-form arrows for the Rank column: each player's score in the window's final matchup against their own average across the window, with anything inside the threshold showing nothing.
function buildMatchupTrendIcons(players, sport) {
    const icons = new Map();
    if (Object.keys(AppState.playerWeeklyCache).length === 0) return icons;

    const { categoryRates, windowStart, windowEnd, perGame } = buildWeeklyRateBasis(sport);
    if (categoryRates.length === 0) return icons;
    const avgStatIds = AVERAGE_STATS[sport] || new Set();

    let fullWeekGames = 0, finalWeekGames = 0;
    Object.values(AppState.playerWeeklyCache).forEach(cache => {
        Object.keys(cache.weeklySums).forEach(w => {
            const wk = Number(w);
            const games = cache.weeklySums[w].games;
            if (wk >= windowStart && wk < windowEnd) fullWeekGames = Math.max(fullWeekGames, games);
            else if (wk === windowEnd) finalWeekGames = Math.max(finalWeekGames, games);
        });
    });
    // Suppress arrows only when the final matchup is barely underway. A completed season's final bucket has as many game-days as a normal week, so it passes.
    const finalFraction = fullWeekGames > 0 ? finalWeekGames / fullWeekGames : 1;
    if (finalFraction < MIN_TREND_FRACTION) return icons;

    const scoreWeek = (p, cache, w) => {
        const stats = perGame
            ? perGameCountingStats(cache.weekly[w], (cache.weeklySums[w] && cache.weeklySums[w].games) || 0, avgStatIds)
            : cache.weekly[w];
        return scoreWeekAgainstBasis(p, stats, categoryRates);
    };

    players.forEach(p => {
        const cache = AppState.playerWeeklyCache[p.id];
        if (!cache) return;
        const weeks = Object.keys(cache.weekly).map(Number)
            .filter(w => w >= windowStart && w <= windowEnd)
            .sort((a, b) => a - b);
        if (weeks.length < 2 || weeks[weeks.length - 1] !== windowEnd) return;

        const scores = weeks.map(w => scoreWeek(p, cache, w)).filter(s => s !== null);
        if (scores.length < 2) return;

        const latest = scores[scores.length - 1];
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const delta = latest - avg;
        if (Math.abs(delta) < TREND_THRESHOLD) return;
        icons.set(p.id, {
            dir: delta > 0 ? 'up' : 'down',
            // One line sharing the legend's vocabulary, so the arrow, the legend and the colour read as one system.
            tip: `${delta > 0 ? 'Above' : 'Below'} average in matchup ${windowEnd} (${latest.toFixed(1)} vs ${avg.toFixed(1)})`
        });
    });
    return icons;
}

function drawPlayerTrendChart(player, stat, weekly, maxWk) {
    const container = document.getElementById('player-trend-chart');
    const sport = document.getElementById('sport').value;

    // weekly is already keyed by fantasy week and summed per stat, the day-to-week rollup having happened once against the league's own schedule mapping. maxWk is the EFFECTIVE max week, so a league whose schedule ends early does not hide real weeks of a player's data.
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, maxWk, AppState.regSeasonWeeks);
    const weeks = Object.keys(weekly).map(Number)
        .filter(w => w >= tfStart && w <= tfEnd)
        .sort((a, b) => a - b);
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const weeklyRankScores = isWeeklyRank ? computeWeeklyRankSeries(player, sport, weekly, weeks) : null;
    const actualValues = weeks.map(w => isWeeklyRank ? (weeklyRankScores[w] ?? 0) : ((weekly[w] && weekly[w][stat.id]) || 0));

    const isRateStat = (AVERAGE_STATS[sport] || new Set()).has(stat.id);

    // Per-week gap notes were removed: they were mostly noise once the day-to-week mapping was fixed, and a real bye or IL week with no games would still trigger one.
    const gapNotes = [];
    if (!isWeeklyRank && !isRateStat) {
        const plottedSum = actualValues.reduce((a, b) => a + b, 0);
        const seasonValue = player.seasonTotals[stat.id] || 0;
        if (Math.round(plottedSum) !== Math.round(seasonValue)) {
            gapNotes.push(`Season Total is ${formatStatValue(seasonValue)}, but the weeks shown only add up to ${formatStatValue(plottedSum)}. Some of this season's real production is missing from the weekly data above, not just from the average.`);
        }
    }
    const gapNoteHtml = gapNotes.length
        ? `<div style="font-size:11px; color:var(--warning); font-style:italic; margin-bottom:8px;">${gapNotes.map(escapeHtml).join(' ')}</div>`
        : '';

    let avgVal, actualTotal, avgLabel, totalLabel;
    if (isWeeklyRank) {
        // The reference line is the mean of the exact weekly scores plotted, NOT the season Rank score, which is a different formula with no consistent relationship to a single week's value.
        avgVal = actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0;
        actualTotal = avgVal;
        avgLabel = `Avg ${axisUnit().long} Score`;
        totalLabel = `Avg ${axisUnit().long} Score`;
    } else {
        // Rate stats use ESPN's own verified season rate for the reference line, so an average-of-rates error cannot creep back in.
        const seasonValue = player.seasonTotals[stat.id] || 0;
        avgVal = isRateStat ? seasonValue : (actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0);
        actualTotal = seasonValue;
        avgLabel = isRateStat ? 'Season Avg' : 'Avg/Matchup';
        totalLabel = 'Season Total';
    }
    const avgDisplay = isWeeklyRank ? avgVal.toFixed(1) : formatStatValue(avgVal);
    // For the weekly score the total and the average are the same number, so only the one reference-line stat is shown, matching the single dashed line drawn.
    const totalStatHtml = isWeeklyRank ? '' : `<div>${totalLabel}: <strong>${formatStatValue(actualTotal)}</strong></div>`;
    // The weekly score is a computed stat rather than an ESPN number, so it is the one chart that has to explain itself.
    const matchupScoreInfo = isWeeklyRank
        ? `<span class="tooltip tooltip-bottom" style="margin-left:4px;">ⓘ<span class="tooltiptext">Scores each ${axisUnit().long.toLowerCase()} from 0 to 100. The player's numbers in every scored category are compared against other ranked players' real ${axisUnit().plural.toLowerCase()} from the same stretch, and those category percentiles are averaged. 50 is the middle of the pack.</span></span>`
        : '';
    const summary = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
            <h4 style="margin:0; font-size:14px; color:var(--text-body); display:flex; align-items:center;">${escapeHtml(stat.name)} - ${axisUnit().long} Trend${matchupScoreInfo}</h4>
            <div style="font-size:12px; color:var(--text-muted); display:flex; gap:15px; align-items:center;">
                ${totalStatHtml}
                <div style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:var(--chart-avg); border-top:2px dashed var(--chart-avg);"></span> ${avgLabel}: <strong>${avgDisplay}</strong></div>
            </div>
        </div>
        ${gapNoteHtml}
    `;

    // Render the summary and a chart placeholder first, so the wrapper gets its real flex-computed size before it is measured. A fixed viewBox was letterboxed whenever the container's aspect ratio did not match.
    container.innerHTML = summary + '<div id="player-trend-svg-wrap" style="flex:1; min-height:0;"></div>';
    const svgWrap = document.getElementById('player-trend-svg-wrap');

    if (weeks.length === 0) {
        svgWrap.innerHTML = '<div class="player-loading">No weekly history for this stat yet.</div>';
        return;
    }

    const svgWidth = Math.max(300, svgWrap.clientWidth || 800);
    const svgHeight = Math.max(180, svgWrap.clientHeight || 300);
    const padding = 45;
    // Include the average so the reference line always lands inside the plotted range, never above the top gridline.
    const maxVal = getNiceMax(Math.max(...actualValues, avgVal, 0));
    const numWeeks = weeks.length - 1;

    let svgStr = `<svg width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display:block;">`;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        // formatStatValue rather than a fixed decimal, since a one-decimal label rounded rate stats to the point of unreadability.
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatStatValue(maxVal - (i / 4) * maxVal)}</text>`;
    }

    // The same dashed playoff-start marker the team trends chart uses, adapted for an axis spaced by ARRAY INDEX: a bye or IL week can leave a gap, so the boundary is placed between the two displayed weeks that straddle the split rather than interpolated from week numbers.
    if (numWeeks > 0 && AppState.regSeasonWeeks >= tfStart && AppState.regSeasonWeeks < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.regSeasonWeeks);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
        }
    }

    // A second boundary marks where the league's last real matchup concluded, since the real season keeps producing stats past it and the later labels should read as extra season.
    if (AppState.isSeasonOver && numWeeks > 0 && AppState.maxCompletedWeek >= tfStart && AppState.maxCompletedWeek < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.maxCompletedWeek);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="2,2" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${svgHeight - padding + 16}" font-size="10" text-anchor="start" style="fill:var(--text-subtle)">End of league season</text>`;
        }
    }

    // Cap x-axis labels to a fixed maximum, since a label per point crowds once a full season is plotted.
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

    // The weekly average reference line, drawn under the data line so individual points still stand out against it.
    const avgY = svgHeight - padding - (avgVal / maxVal) * (svgHeight - padding * 2);
    svgStr += `<line x1="${padding}" y1="${avgY}" x2="${svgWidth - padding}" y2="${avgY}" stroke-width="1.5" stroke-dasharray="6,4" style="stroke:var(--chart-avg)" />`;

    svgStr += `<polyline points="${actualPts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="2.5" style="stroke:var(--accent)" />`;
    actualPts.forEach(p => {
        // No opponent or matchup info here, because a player may have been picked up partway through the season and a real matchup that week does not mean he was rostered for it.
        const displayValue = isWeeklyRank ? p.value.toFixed(1) : formatStatValue(p.value);
        const tooltipText = `${axisUnit().long} ${p.week}: ${escapeHtml(displayValue)} ${escapeHtml(stat.name)}`;
        // A larger transparent hit target over the small visible dot, which alone is hard to hover once many weeks are crowded into a narrow chart.
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="4" style="fill:var(--accent); pointer-events:none;" />`;
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent" style="cursor:pointer;" data-tooltip="${tooltipText}" />`;
    });
    svgStr += `</svg>`;

    svgWrap.innerHTML = svgStr;
    attachDataTooltips(svgWrap);
}
