import { buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { AppState, ESPN_STAT_MAPS, POSITION_MAPS, SLOT_POSITION_MAPS, PITCHER_POSITIONS, PITCHING_IDS, GOALIE_IDS, AVERAGE_STATS, INVERSE_STATS, RATE_COMPONENTS, NON_STARTING_SLOTS } from './state.js';
import { escapeHtml, getNiceMax, setDebugContext, setActiveDebugKind, hasDebugContext, setDebugLoading, getTimeframeBounds, splitScoredAdvanced, percentileColor, attachDataTooltips, statValue, unwrapStats, axisUnit, buildMatchupPeriodMap, matchupOfPeriod, parseTimeframe, injuryBadgeHtml, injuryLabel, playerPoolErrorText } from './utils.js';
import { fetchPlayerData, fetchPlayerWeeklyStats, fetchPlayersWeeklyChunk, WEEKLY_CHUNK_SIZE, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchDraftDetail, harvestTransactions, harvestRosters } from './api.js';
import { buildRosterTimeline, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod } from './roster-timeline.js';
// All ranking/percentile MATH lives in the pure, unit-tested rank engine (see its purity contract; tests in tests/rank-engine.test.html). This file owns the impure half. Choosing pools, reading AppState/DOM, and building the ctx objects the engine functions take.
import {
    IP_STAT_ID, GAMES_PLAYED_IDS, MIN_PLAYING_TIME_FRACTION,
    inningsPitchedOf, opportunityGateFor,
    computeRotoRanks as engineComputeRotoRanks,
    computePointsRanks as engineComputePointsRanks,
    computeCategoryBreakdown as engineComputeCategoryBreakdown,
    computeStatRankInPool, buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis,
    scoreRotoWeek, rotoPointsForCategory
} from './rank-engine.js';

const RANK_COLORS = { 1: '#b8860b', 2: '#767676', 3: '#a4581e' }; // gold, silver, bronze
const RANK_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' }; // leaderboard Rank column, top 3 of the current pool
const WEEKLY_RANK_STAT_ID = '__weeklyrank__';
// The points-league counterpart is fantasy points scored in each matchup. Not an ESPN stat id, and not a stored number either - ESPN publishes appliedTotal for the SEASON only, so a per-matchup figure has to be computed from that matchup's own stat line.
const WEEKLY_POINTS_STAT_ID = '__weeklypoints__';

// The league's own scoring applied to one bucket of weekly stat sums. Same arithmetic computePointsRanks uses on a season line, which is validated to reproduce ESPN's appliedTotal.
function pointsForStatBucket(sums) {
    const weights = AppState.scoringWeights || {};
    let total = 0;
    Object.keys(weights).forEach(id => { total += (Number((sums || {})[id]) || 0) * weights[id]; });
    return +total.toFixed(1);
}

// Ranks this player against every other player with real eligibility in the STAT's own role (batters vs batters, pitchers vs pitchers) who has a value for this stat - keyed off which role the stat itself belongs to (PITCHING_IDS), not the player's own primary position, so a two-way player's pitching stats get compared against pitchers and batting stats against batters, both correctly, regardless of which one happens to be their primary role. Ranking math (competition ties, percentile) is the engine's computeStatRankInPool.
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

// Group tab membership (Batters vs Pitchers) has to be ELIGIBILITY-based, not based on a player's single PRIMARY role (ESPN's defaultPositionId, still used for the strict RP pool filter - see matchesPositionFilter) - a genuine two-way player (e.g. Shohei Ohtani) has one primary position but real, meaningful stats and eligibility in BOTH roles, and needs to show up - with his own real numbers - in both tabs. The two checks aren't mutually exclusive. A two-way player satisfies both wantPitchers=true and wantPitchers=false, while an ordinary single-role player only satisfies whichever one matches their real role (confirmed against real data. Ohtani was missing from the Pitchers tab entirely, since his primary position - a batting slot - excluded him regardless of his real, substantial pitching stats). Which role group a player belongs to, for surfaces outside the leaderboard that group by role (B90's roster band). Eligibility-based like the group tabs, so a two-way player lands in both and the caller decides which section to draw him in.
export function playerRoleGroups(player, sport) {
    return {
        primary: matchesPlayerGroup(player, sport, false),
        secondary: matchesPlayerGroup(player, sport, true)
    };
}

function matchesPlayerGroup(player, sport, wantPitchers) {
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    return wantPitchers
        ? player.eligiblePositions.some(pos => pitcherPositions.has(pos))
        : player.eligiblePositions.some(pos => !pitcherPositions.has(pos));
}

// Eligibility-based position filtering skews rankings toward dual-role "swingmen" (pitchers who both start and relieve) once the filter is RP specifically - a swingman accumulates SP-shaped counting stats (K, W, QS) far beyond what a true, dedicated reliever ever would, so an eligibility-based RP pool let them dominate a "best RP" ranking despite not really being a reliever (filtering to RP was showing swingmen ranked ahead of genuine shutdown relievers). So RP specifically matches by a player's PRIMARY role instead of raw eligibility. SP does NOT get the same treatment, even though it seems symmetric at first - ESPN eligibility itself already requires real starts to earn SP eligibility, so there's no equivalent "fake SP value" a reliever could rack up, and making SP strict-by-primary-role-too had a real, confirmed cost instead. Real 2026 data (data2.txt) showed several genuine spot starters (68-108 IP, real starts) whose PRIMARY role happened to be 'RP' - Ashcraft, Wrobleski, Cantillo, Lambert, Detmers, Leahy, Latz, Brad Lord - vanishing from the SP view entirely, including from their own "SP" rank chip's comparison pool. SP uses plain eligibility, same as any batting position.
function matchesPositionFilter(p, posFilter) {
    if (posFilter === 'RP') return p.positionName === posFilter;
    return p.eligiblePositions.includes(posFilter);
}

// Roster-availability filter (AppState.playerAvailabilityFilter). A player's teamId is set only when they're on a fantasy team (see processPlayerData: onTeamId > 0), so null = free agent. Deliberately a DISPLAY-only filter, exactly like the search box - it decides which rows show, never which players the Rank is computed against, so a free agent's "#12 of 340" still reflects their standing in the whole same-role pool (the number you actually want when scouting a pickup), not an artificially small "#3 of the free agents" pool.
function matchesAvailability(p) {
    const mode = AppState.playerAvailabilityFilter || 'all';
    if (mode === 'rostered') return p.teamId != null;
    if (mode === 'fa') return p.teamId == null;
    return true;
}

// Outfield is the one case where the SAME real position is represented at two different granularities in ESPN's slot catalog - a generic OF slot (5) vs specific LF/CF/RF (8/9/10) - and which one to show depends on which granularity this league's own roster actually uses. Every other slot (DH, infield positions, pitching roles) describes something real about the player regardless of whether this league happens to roster a dedicated spot for it, so those are always shown when the player is eligible - conflating "no roster slot for this" with "not eligible for this" was the bug (a real DH-capable batter was losing "DH" entirely because these leagues don't have a dedicated DH bench slot).
const OF_SPECIFIC_SLOTS = new Set(["8", "9", "10"]);
const OF_GENERIC_SLOT = "5";
// The generic "P" slot (13) is redundant whenever a player also has the more specific SP (14) or RP (15) - any SP/RP is automatically P-eligible too, so showing "P/SP" doesn't add information. Only fall back to generic "P" for the rare player who has no SP/RP split at all.
const GENERIC_PITCHER_SLOT = "13";
const SPECIFIC_PITCHER_SLOTS = new Set(["14", "15"]);

// Canonical display order - unrecognized names (shouldn't happen given SLOT_POSITION_MAPS) sort after everything else instead of disappearing.
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

// Some names (BB, H, HR, OBP, SLG, K, W, SV, HLD, ERA) are reused between multiple ids in ESPN_STAT_MAPS.flb - some of that is old/legacy ids ESPN doesn't actually use anymore. Dedupe within an already role-filtered id list, not across the whole map, or the batting id (lower number, seen first) silently shadows the pitching one and that column never shows up for pitchers at all. When a name collides AND we know which ids this league's settings actually score (scoredStatIds), prefer the scored id over its unscored twin - confirmed against a real league's scoringItems dump that e.g. "ERA" exists at both 44 and 47, but only 47 is ever actually used, so 44 (being lower/seen first) was winning the dedupe and hiding the real one.
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

// Splits a group's stat ids into "scored" (the stats this league's settings actually use) and "advanced" (everything else ESPN happens to track) so the leaderboard can default to just the categories that matter for this league, with the rest tucked behind a toggle. Role-grouped ordering (orderStatIdsByRole) is deliberately NOT applied here. This list is already filtered to ONE role by the group tab, so every id is in the same group and grouping would be a no-op. Same for statIdsForPlayer below. The mixed-role surfaces that do need it are the heatmap/scoreboard, the category picker, the category-totals export, and the recap.
function statIdsForGroup(sport, group, groupPlayers) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const inGroup = Object.keys(statMap).filter(id => group === 'secondary' ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(inGroup, statMap);
    const withData = deduped.filter(id => groupPlayers.some(p => p.seasonTotals[id] !== undefined));
    return splitScoredAdvanced(withData);
}

// Real baseball fractional-innings notation -.1 means one out into the inning (1/3),.2 means two outs (2/3), NOT a true decimal (586 outs is "195.1", not "195.333").
function formatInnings(outs) {
    if (outs === undefined || outs === null) return '-';
    return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Reads AppState.playerGroup (which tab is currently active) rather than this player's own intrinsic primary role - every caller of this function already only ever processes players scoped to the current group (via matchesPlayerGroup), so this correctly reads a two-way player's PITCHING games count while the Pitchers tab is active and their BATTING games count while the Batters tab is active, instead of always reading whichever role happens to be their primary one.
function gamesPlayedOf(p, sport) {
    const group = AppState.playerGroup === 'secondary' ? 'secondary' : 'primary';
    const ids = GAMES_PLAYED_IDS[sport] || GAMES_PLAYED_IDS.flb;
    return p.seasonTotals[ids[group]] || 0;
}

// The shrinkage (VALUE) workload measure. Baseball: games played for batters, real innings pitched for pitchers - see inningsPitchedOf for why appearances don't work as a workload measure ACROSS pitching roles (a true reliever's 35-45+ appearances dwarf a full-time starter's ~14-20, even though the starter is throwing 2-3x the innings and produces far more fantasy value - confirmed against real 2026 data, twice. The unfiltered "all positions" pool letting true relievers like Aaron Ashby/Louis Varland/Brent Headrick/Dylan Lee dominate the top of the ranking ahead of legitimate aces like Cristopher Sanchez and Jacob Misiorowski, and (less obviously) an eligibility-based SP pool's games-based shrinkage leader turning out to be a swingman - Jacob Latz, 33 appearances but only 42 real innings - which crushed every genuine ace's shrinkFactor and flipped Sanchez behind Misiorowski purely from switching from the Overall view to the SP-filtered one. The one pool that could have safely kept games played - RP, which stays strictly primary-role filtered (see matchesPositionFilter) and so never contains swingmen in the first place - uses innings pitched too now anyway, purely for consistency across every pitcher view (see computeRotoRanks). HOCKEY: games played for BOTH skaters and goalies. That whole innings-pitched apparatus exists only because baseball's pitching role splits into SP and RP with wildly non-comparable appearance counts; hockey has no equivalent (every goalie is the same role, every skater is the same role), so games played IS a comparable workload for everyone and there's no reason to reach for time-on-ice. Note id 34 in hockey happens to be GP, so the old inningsPitchedOf path would have read GP/3 for goalies - relative shrinkage would survive that by coincidence, but this is explicit and correct instead of accidentally-not-broken.
function workloadOf(p, sport) {
    if (sport === 'fhl') return gamesPlayedOf(p, sport);
    return AppState.playerGroup === 'secondary' ? inningsPitchedOf(p) : gamesPlayedOf(p, sport);
}

// Shared impure→pure adapter. Everything the engine's roto functions need, read once from AppState/league config. relevantStatIds is scoped to the CURRENT group's own role (AppState.playerGroup), not just "does anyone in groupPlayers have this stat defined" - a two-way player (e.g. Ohtani) genuinely has both batting AND pitching stats defined on their own record, so without this, their off-role stats would leak into this pool's categories, with them as the lone player carrying a value there - a single-player "basis" that hands them an automatic 100th percentile in a category no actual peer can be compared on. The two different workload measures are deliberate - see the engine's computeRotoRanks comment (shrinkage = VALUE measure, GP/IP by role; hard exclusion = ACTIVITY measure, games played for everyone).
function rotoContext(groupPlayers, sport, posFilter) {
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    return {
        relevantStatIds: Array.from(AppState.scoredStatIds).filter(id =>
            (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && groupPlayers.some(p => p.seasonTotals[id] !== undefined)),
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        // The averaged (rate) categories, so the engine knows which missing values are a real 0 (counting) versus genuinely absent (rate). players.js owns AVERAGE_STATS - the pure engine takes it via ctx rather than importing state.
        rateStatIds: AVERAGE_STATS[sport] || new Set(),
        isRpPool: posFilter === 'RP',
        requireMinPlayingTime: AppState.requireMinPlayingTime,
        workloadOf: p => workloadOf(p, sport),
        thresholdWorkloadOf: p => gamesPlayedOf(p, sport),
        statMap: ESPN_STAT_MAPS[sport] || {}
    };
}

// Replaces ESPN's raw "FPTS" (a generic points formula unrelated to this league's actual scoring settings, and batting-only) with a real Roto-style rank. All method/math lives on the engine's computeRotoRanks - including the full rationale for shrinkage, opportunity gating, the Minimum Games threshold, and the RP pool's special cases.
function computeRotoRanks(groupPlayers, sport, posFilter = null) {
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

// The points-league ranking, same call shape as computeRotoRanks so every surface that shows a rank can ask for one without caring which format the league is. Like roto, it ranks exactly the pool it is handed. The caller has already narrowed that to one position when a position filter is on, which is what makes a position rank a rank AMONG that position rather than an overall rank with the others hidden.
function computePointsRanks(groupPlayers, sport) {
    return engineComputePointsRanks(groupPlayers, {
        weights: AppState.scoringWeights,
        workloadOf: p => gamesPlayedOf(p, sport)
    });
}

// Whichever ranking this league is scored by. One call site instead of an isPointsLeague fork at every surface that wants a rank.
function computeLeagueRanks(groupPlayers, sport, posFilter = null) {
    return AppState.isPointsLeague
        ? computePointsRanks(groupPlayers, sport)
        : computeRotoRanks(groupPlayers, sport, posFilter);
}

// Single-player per-category breakdown of the same math, for the drill-down - see the engine's computeCategoryBreakdown.
function computeCategoryBreakdown(player, groupPlayers, sport, posFilter = null) {
    return engineComputeCategoryBreakdown(player, groupPlayers, rotoContext(groupPlayers, sport, posFilter));
}

function formatStatValue(val) {
    if (val === undefined || val === null) return '-';
    const num = Number(val);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(3) : num;
}

// The rank breakdown rows exist to JUSTIFY the percentile, so a rate value there must carry enough precision to tell apart values the leaderboard grid rounds together - two goalies at.912 SV% with different percentiles read as a bug until you can see.9118 vs.9123. Sub-1.0 rates (SV%, and baseball's AVG/OBP/SLG) cluster tightly against their ceiling and need a 4th decimal; rates at or above 1 (GAA, ERA, WHIP, an RP's K/9) already separate at the 3 decimals formatStatValue gives, so they fall straight through. Counting stats are integers and are untouched. Keyed off magnitude, not a stat-id list, so it needs no rate-set threading and covers the RP K/9 substitution too; a rare sub-1 GAA getting a 4th decimal is harmless over-precision. Only the breakdown uses this - the leaderboard grid keeps the sport's conventional display.
function formatBreakdownValue(val) {
    const num = Number(val);
    if (Number.isFinite(num) && num % 1 !== 0 && Math.abs(num) < 1) return num.toFixed(4);
    return formatStatValue(val);
}

// Chart x-axis is labeled by MATCHUP number (see matchupNumberOfWeek), not raw week number - that's the thing a fantasy manager actually cares about ("how did this player do in each matchup"). Weeks past the league's real bracket structure (the real MLB season runs into October; most fantasy leagues wrap their championship well before that) still get their own plain, continuing matchup number rather than a separate "+N" notation - see matchupNumberOfWeek for why. The "End of league season" divider elsewhere on the chart is what actually marks the real bracket boundary.
function formatMatchupLabel(w) {
    // The drill-down chart's buckets ARE the league's own timeline unit, matchup numbers in H2H, real weeks in roto (buildWeeklySums buckets roto by weekOfScoringPeriod, not by matchup, since roto's matchupPeriodCount is 1). So the tick has to follow the league, not a fixed word.
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

        // Match exact year to prevent historical leakage
        const actualSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year);
        const projSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === year);

        const teamId = entry.onTeamId > 0 ? entry.onTeamId : null;
        const team = teamId ? teamById[teamId] : null;
        const posMap = POSITION_MAPS[sport] || {};
        const primaryPositionName = posMap[p.defaultPositionId] || `Pos ${p.defaultPositionId}`;

        // eligibleSlots lists every roster slot this player actually qualifies for (a real multi-position player like a 2B/SS utility infielder, or a DH-capable corner infielder), not just their one default position. Falls back to the single default position for sports without a confirmed slot map (see SLOT_POSITION_MAPS in state.js), or if nothing decodes to a real position.
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
            // ESPN sends both a boolean and a status token. The token is the one that carries a label, and it is present on healthy players too (as ACTIVE), so the boolean adds nothing the badge needs.
            injuryStatus: p.injuryStatus || null,
            // Kept as ESPN sends it, a game id to PROBABLE or NOTSTARTING map, because the day each game falls on lives in a different payload entirely (see probables.js).
            starterStatusByProGame: p.starterStatusByProGame || null,
            // Which real team he plays for, which is what decides who the opponent is in a game the schedule lists by home and away id.
            proTeamId: p.proTeamId ?? null,
            seasonTotals: unwrapStats(actualSeason && actualSeason.stats),
            projectedTotals: unwrapStats(projSeason && projSeason.stats),
            appliedTotal: (actualSeason && actualSeason.appliedTotal) || 0,
            projectedAppliedTotal: (projSeason && projSeason.appliedTotal) || 0
        };
    });
}

// MLB/NHL report stats per game DAY (statSplitTypeId 5, one entry per scoringPeriodId), not per fantasy week - there is no single stat line to read for "week 3". H2H leagues get their real matchup boundaries from the schedule itself (see buildMatchupPeriodMap in utils.js), so this function is now only for SEASON-LONG ROTO, which genuinely has none. Its schedule is one degenerate game covering the whole season, matchupPeriodCount is 1, and ESPN never divides it. The Roto Race still needs a time axis, so this defines one, and the only honest way to define it is from something real in the payload. That is status.firstScoringPeriod, the league's own first day: weeks are 7 days counted from there. The previous floor(spid / 7) anchored on nothing at all - it put week boundaries wherever the day number happened to divide by seven, and its max(1,...) clamp silently made week 1 thirteen days long while every other week was seven. This is a display axis, not a league fact, and it is labelled as weeks rather than matchups for exactly that reason (axisUnit reads the league type).
function weekOfScoringPeriod(scoringPeriodId) {
    const first = AppState.apiData?.status?.firstScoringPeriod || 1;
    return Math.max(1, Math.floor((scoringPeriodId - first) / 7) + 1);
}

// Regular-season matchups are exactly 1 real week each, but a playoff ROUND can span multiple real weeks (playoffMatchupPeriodLength, e.g. a 2-week Round 1 - confirmed via a real league's own settings: "Weeks In Round 1 Playoff Matchup: 2"). Leaving playoff weeks un-collapsed showed them as several separate, sparse points trailing past the regular season with no clear end, instead of the real, BOUNDED number of playoff matchups the league actually has. What a fantasy manager cares about is "how did this player do in each real matchup" - collapse every real week belonging to the same playoff round into that round's single matchup number, matching how the league itself counts them. The league's OWN completed-games schedule (AppState.maxCompletedWeek, see data.js) is the authoritative signal for how many real playoff matchups exist - simpler and more reliable than guessing a bracket's round count from playoffTeamCount. maxCompletedWeek comes from the TEAM schedule's own matchupPeriodId field there, which is already a real, displayed matchup number (a league with 22 regular-season matchups and two 2-real-week playoff rounds reports matchupPeriodId 23 and 24 as two SEPARATE playoff matchups, not one) - it does NOT need collapsing through playoffLen the way the day-derived `week` argument above does, since it was never a raw day-count in the first place. Cap the computed matchup number at that real last matchup rather than continuing to invent new ones past it. A previous version of this comment/fix wrongly concluded maxCompletedWeek needed the same playoffLen collapsing as `computed` - that was based on a misreading of one league's schedule dump (which happened to have a single-round playoff bracket, making the distinction invisible) and got corrected after the user clarified their own 2025 league actually had TWO 2-week playoff rounds (matchups 23 and 24, not one combined round). The REAL root cause was one level down, in weekOfScoringPeriod's day-to-week anchor (see that function's own comment) - it was deriving `week` one real week ahead of where it should've been, which gets compounded here into an invented matchup one past the league's real last one. The league's real day-to-matchup lookup, rebuilt whenever a new payload lands. Cached on the payload object itself rather than a league key, so a refetch of the SAME league mid-matchup picks up the days that have since been scored instead of serving yesterday's boundaries.
let matchupMapCache = { data: null, map: null };
export function matchupPeriodMap() {
    const data = AppState.apiData;
    if (!data) return null;
    if (matchupMapCache.data !== data) {
        matchupMapCache = { data, map: buildMatchupPeriodMap(data.schedule, data.status) };
    }
    return matchupMapCache.map;
}

// The matchup a stat day belongs to. The league's own schedule answers this exactly, including its long opening week and any break week it folded in, so the arithmetic below is only a fallback for a payload that carries no per-period scores at all.
function matchupOfScoringPeriod(scoringPeriodId) {
    const real = matchupOfPeriod(matchupPeriodMap(), scoringPeriodId);
    if (real !== null) return real;
    return matchupNumberOfWeek(weekOfScoringPeriod(scoringPeriodId));
}

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

// Rate stats can't be correctly aggregated by averaging each day's already-computed rate and dividing by day count - that weights a 1-AB day exactly the same as a 5-AB day, badly skewing the result (this was inflating weekly AVG well above a player's real season AVG). Recompute each rate directly from its raw COMPONENTS, which are already summed correctly as ordinary counting stats (AB=0, H=1, TB=8,... for baseball; SA=3, GA=4, SV=6, TOI=8 for hockey - see RATE_COMPONENTS in state.js for the validated formulas). Table-driven and keyed by sport so this stays free of any sport-specific branch. Whatever rate stats the per-sport table lists get recomputed, everything else keeps sumStatsByGroup's value. Rate categories NOT in the table fall back to that averaged-daily-rate approximation - less accurate, but never a guessed component. Baseball ERA, WHIP and K/9 were exactly that fallback until, and it was wrong in a way a user could see. A pitcher who threw once in a matchup for a 15.00 ERA read 5.00 on the Current timeframe, because one real day was averaged against the window's other, empty days. All three are now in the table, validated against a real pool capture (owner report, ).
function deriveRateOverrides(sums, sport) {
    const rules = RATE_COMPONENTS[sport] || [];
    const overrides = {};
    const sumOf = ids => ids.reduce((acc, id) => acc + (sums[id] || 0), 0);
    rules.forEach(rule => {
        if (rule.add) {
            // A rate that's the sum of already-derived rates (OPS = OBP + SLG). Only emit it when every part was itself derivable this range, so a no-AB window doesn't invent an OPS.
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

// Sums raw per-week components (weeklySums, as built by processPlayerWeeklyHistory/ processBulkPlayerWeeklyHistory - matchup# -> { sums: {statId: sum}, games }) across an arbitrary [startWeek, endWeek] range and runs the combined totals through the same sumStatsByGroup/deriveRateOverrides derivation a single week does - a single week is just a range of one, so this is the ONLY place rate-stat math happens, shared by the single-player chart (processPlayerWeeklyHistory's own `weekly`, below) and the bulk leaderboard timeframe aggregation (getEffectivePlayerPool). Summing the RAW per-week components first (rather than averaging each week's already-derived rate) is what avoids the "1-AB week weighted the same as a 5-AB week" skew described on deriveRateOverrides.
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

// PURE. One point per DAY of a matchup, each carrying the running total to that day. This is the Current timeframe's whole trick. A one-matchup window on a matchup axis is one or two points and reads as a straight line; the same window on a day axis is a real progression. Cumulative, not per-day, so the line answers "where is he up to" rather than flickering between a four-hit Tuesday and an idle Wednesday. An off-day or a DNP contributes nothing and so draws a FLAT segment, which is the honest shape rather than a gap or a drop to zero. Rates follow the same discipline the rest of this file does. Each day's rate is derived from the components accumulated THROUGH that day, never from averaging the daily rates. A pitcher whose first start was a 15.00 ERA and whose second was scoreless has to read as the combined line on day two, and only summing the components first gets that right. periods is the matchup's own scoring periods, in order, from the league's schedule - never a calendar assumption. A playoff matchup spanning three real weeks has more of them. Returns [{ period, index, totals, games, played }], and the caller decides where to stop.
export function aggregateDailyCumulative(dailyByPeriod, periods, sport) {
    const avgStatsForSport = AVERAGE_STATS[sport] || new Set();
    const running = {};
    let games = 0;
    return (periods || []).map((period, index) => {
        const day = dailyByPeriod ? dailyByPeriod[period] : null;
        if (day && day.sums) {
            games += day.games || 0;
            Object.keys(day.sums).forEach(statId => {
                running[statId] = (running[statId] || 0) + day.sums[statId];
            });
        }
        return {
            period,
            index,
            played: !!(day && day.games),
            games,
            totals: {
                ...sumStatsByGroup({ ...running }, games, avgStatsForSport),
                ...deriveRateOverrides(running, sport)
            }
        };
    });
}

// The scoring periods belonging to one matchup, in order, off the league's OWN schedule map. Never a calendar assumption. Matchup 15 of a real MLB league ran 14 days across the All-Star break while ESPN's own matchupPeriods still called it one week (see buildMatchupPeriodMap). A playoff round spanning three weeks is a longer list.
export function periodsOfMatchup(matchupMap, matchupNumber) {
    if (!matchupMap || !matchupMap.byPeriod || !matchupNumber) return [];
    const out = [];
    matchupMap.byPeriod.forEach((mp, period) => { if (mp === matchupNumber) out.push(period); });
    return out.sort((a, b) => a - b);
}

// Groups a kona_player_info response's raw day-level stat lines into per-matchup-week raw sums (weeklySums) - shared building block for both processPlayerWeeklyHistory (one player) and processBulkPlayerWeeklyHistory (many players at once, Phase 2) - the caller supplies whichever slice of rawData.players belongs to a single player. Also returns dailyByPeriod (scoringPeriodId -> { sums, games }) for roto leagues only. The lineup-aware Roto Race has to credit each single day to whichever team STARTED the player that day (from the roster snapshots), which the week buckets have already blurred together. Built only when isRotoLeague, so H2H leagues - which never run the race - don't pay the per-day memory. Same raw component sums as a week bucket, just at day granularity.
function buildWeeklySums(playerStatLines, year, wantDaily = false) {
    // Only actual (statSourceId 0) per-day lines - ESPN's rest-of-season projections turned out to be unreliable/empty in practice and aren't used here anymore.
    const dayLines = playerStatLines.filter(s => s.seasonId === year && s.statSplitTypeId === 5 && s.statSourceId === 0 && s.scoringPeriodId);

    const weeklySums = {}; // week# -> { sums: {statId: sum}, games }
    // wantDaily is the pitcher case. A completed start has to be read on its own day, and a week holds two of them. Everyone else in an H2H league still skips the per-day memory.
    const dailyByPeriod = (AppState.isRotoLeague || wantDaily) ? {} : null; // scoringPeriodId -> { sums, games }
    dayLines.forEach(s => {
        // Matchup leagues bucket by the league's OWN matchup number, read off its schedule, which already accounts for a long opening week, a folded break week and multi-week playoff rounds. Roto has no matchups at all - its matchupPeriodCount is 1, which would collapse the ENTIRE season into bucket 1 and leave nothing to plot over time. The Roto Race needs real weeks, so roto buckets by the plain scoring-period week instead.
        const week = AppState.isRotoLeague
            ? weekOfScoringPeriod(s.scoringPeriodId)
            : matchupOfScoringPeriod(s.scoringPeriodId);
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
    // A player can show up as more than one entry in rawData.players if they changed teams (trade/waiver claim) mid-season - each entry only carries the stat lines for its own roster stint. Flatten across every entry instead of assuming index 0 has everything, or a mid-season transaction silently truncates part of the season.
    const statLines = (rawData.players || []).flatMap(e => (e.player && e.player.stats) || []);
    const year = parseInt(document.getElementById('year').value, 10);
    // Daily sums ALWAYS on this path, because this path is one player. The drill-down's Day axis at Current needs them, and the cost is one player's days rather than the pool's. The bulk path stays selective on purpose ( trap: never flip dailyByPeriod on pool-wide).
    const { weeklySums, dailyByPeriod } = buildWeeklySums(statLines, year, true);

    const weekly = {};
    Object.keys(weeklySums).forEach(week => {
        weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
    });

    return { weekly, weeklySums, dailyByPeriod };
}

// Bulk counterpart to processPlayerWeeklyHistory - processes a fetchPlayersWeeklyStatsBulk response (many players at once) and populates AppState.playerWeeklyCache directly for every player found, rather than returning one player's { weekly, weeklySums }. Groups by player id first (a bulk response can, same as the single-player one, contain multiple entries for the same player if they changed teams mid-season), then reuses the exact same per-week summing (buildWeeklySums) and derivation (aggregateStatsForWeekRange) processPlayerWeeklyHistory uses - a player fetched here and later opened individually (openPlayerDetail) is a cache hit, no second fetch.
function processBulkPlayerWeeklyHistory(rawData, sport) {
    const year = parseInt(document.getElementById('year').value, 10);
    // Which players are pitchers comes from the POOL, not from this response. My Team's Schedule view needs a completed start's OWN day rather than the week it fell in, and a week holds two of them, so pitchers get per-day buckets. Reading starterStatusByProGame off rawData here found nothing, because that field rides on the player-pool payload and this is the weekly stats one. Only pitchers pay the per-day memory, which keeps buildWeeklySums' note true for everyone else in an H2H league.
    const pitcherIds = new Set();
    (AppState.playerData || []).forEach(p => {
        if (p && p.starterStatusByProGame && Object.keys(p.starterStatusByProGame).length) pitcherIds.add(p.id);
    });

    const statLinesByPlayerId = new Map();
    (rawData.players || []).forEach(entry => {
        const p = entry.player || {};
        const id = p.id ?? entry.id;
        if (id === undefined || id === null) return;
        if (!statLinesByPlayerId.has(id)) statLinesByPlayerId.set(id, []);
        statLinesByPlayerId.get(id).push(...(p.stats || []));
    });

    statLinesByPlayerId.forEach((statLines, playerId) => {
        const { weeklySums, dailyByPeriod } = buildWeeklySums(statLines, year, pitcherIds.has(playerId));
        const weekly = {};
        Object.keys(weeklySums).forEach(week => {
            weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
        });
        AppState.playerWeeklyCache[playerId] = { weekly, weeklySums, dailyByPeriod };
    });
}

// A player needs real weekly data cached (see AppState.playerWeeklyCache/ processBulkPlayerWeeklyHistory) before a windowed timeframe can be applied to them - used both to decide whether the leaderboard needs to kick off a bulk fetch (renderPlayerLeaderboard) and, here, to decide who's actually excludable-vs-includable in the windowed pool itself.
function hasCachedWeeklyData(p) {
    return !!AppState.playerWeeklyCache[p.id];
}

// Returns AppState.playerData unchanged when the shared timeframe is the full season (no aggregation needed - seasonTotals already IS the season sum); otherwise returns shallow clones with seasonTotals replaced by the windowed aggregate for every player with cached weekly data, excluding anyone not yet cached (bulk fetch still in flight, or genuinely no weekly data) rather than showing them with misleading season-total numbers under a windowed heading. This is the ONE place a timeframe selection actually changes what "seasonTotals" means - every existing consumer (computeRotoRanks, computeCategoryBreakdown, gamesPlayedOf, workloadOf, the engine's statValueForRanking, the leaderboard's stat/GP/IP columns, sort comparators, buildRankChipsHtml, buildRankBreakdownHtml, computeWeeklyRankSeries) needs zero changes to its own logic - they just get called with this instead of AppState.playerData directly, since they already only ever read p.seasonTotals. Memoized by (sport, timeframe) - a single renderPlayerDetail() call invokes this 3+ times (once each from buildRankChipsHtml/buildRankBreakdownHtml, and once PER stat chip via computeStatRank), which would otherwise re-clone and re-aggregate the entire pool from scratch each time. Invalidated via two cheap signals rather than hooking every mutation site: AppState.playerData's own reference (a fresh pool fetch always reassigns this - see data.js and processPlayerData) and how many players have cached weekly data (grows monotonically as bulk/individual weekly fetches resolve - an existing cache entry is never overwritten, only ever newly added).
let poolCache = null;

// Whether the currently-selected timeframe's resolved week range covers the ENTIRE available season (weeks 1 through maxCompletedWeek), not just whether it's literally 'all'. Early in a season with no playoffs reached yet, "Regular Season" ('reg') and "Regular Season + Playoffs" ('all') resolve to the exact same week range (see getTimeframeBounds - 'reg' clamps to Math.min(maxWk, regWks), which equals maxWk whenever there's no playoffs yet). Only literal 'all' used to skip the windowed/per-player-weekly-fetch path, so a mid-season league (no playoffs reached, defaults to 'reg' - see rebuildTimeframeOptions) was needlessly paying for the full bulk weekly-stats fetch on every leaderboard open, just to recompute numbers byte-identical to the season totals already sitting in AppState.playerData.
function isFullSeasonTimeframe() {
    // Roto has no matchup periods (its maxCompletedWeek is 1), so the season-vs-window distinction is purely which pill is picked. 'all' is the full season, a 'last N' pill is a real window. The week-range comparison below only means anything for matchup leagues.
    if (AppState.isRotoLeague) return parseTimeframe(AppState.timeframe).window === null;
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    return start === 1 && end === AppState.maxCompletedWeek;
}

// The [start, end] week range the player views aggregate over for the current timeframe, roto-aware. Matchup leagues resolve 'last N' against AppState.maxCompletedWeek; roto has no matchup periods (maxCompletedWeek is 1, which would collapse every window to a single week), so its windows resolve against the Roto Race's own week span (rotoWindowMaxWeek). Those are the same weekOfScoringPeriod buckets the player weekly cache is keyed by, so a player's windowed totals line up with the windowed TEAM standings by construction. Falls back to the matchup path whenever the started tier isn't available (no 'last N' pill can be active then anyway).
function playerTimeframeBounds(sport) {
    if (AppState.isRotoLeague) {
        const maxWeek = rotoWindowMaxWeek(sport);
        if (maxWeek > 0) return getTimeframeBounds(AppState.timeframe, maxWeek, maxWeek);
    }
    return getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
}

// The pool as the CURRENT timeframe sees it, for surfaces outside the leaderboard that must window with it (B90's roster band). Same function the leaderboard and the rank lookup read, so a roster row, its rank and the leaderboard row can never disagree about which weeks count.
export function effectivePlayerPool(sport) {
    return getEffectivePlayerPool(sport);
}

function getEffectivePlayerPool(sport) {
    if (isFullSeasonTimeframe()) return AppState.playerData;

    const weeklyCacheSize = Object.keys(AppState.playerWeeklyCache).length;
    const { start, end } = playerTimeframeBounds(sport);
    // The BOUNDS belong in the key, not just the timeframe string that produced them. The same string resolves to different matchups as the season moves, because getTimeframeBounds also reads maxCompletedWeek and currentMatchup, so keying on the string alone can hand back a window computed against numbers that have since changed. Caught while reviewing the Current timeframe: rolling the live matchup forward by hand left the cache serving the old window's figures, which is precisely the "the values do not change" symptom.
    if (poolCache && poolCache.sport === sport && poolCache.timeframe === AppState.timeframe &&
        poolCache.start === start && poolCache.end === end &&
        poolCache.playerDataRef === AppState.playerData && poolCache.weeklyCacheSize === weeklyCacheSize) {
        return poolCache.result;
    }

    const result = AppState.playerData
        .filter(hasCachedWeeklyData)
        .map(p => ({ ...p, seasonTotals: aggregateStatsForWeekRange(AppState.playerWeeklyCache[p.id].weeklySums, start, end, sport) }));

    poolCache = { sport, timeframe: AppState.timeframe, start, end, playerDataRef: AppState.playerData, weeklyCacheSize, result };
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

    // A two-way player's off-role eligibility (batting positions while viewing Pitchers, or SP/RP while viewing Batters) has no meaning as a position filter here - matchesPlayerGroup already lets them into this list via their real SAME-role eligibility, so just drop the other role's entries from the dropdown itself.
    positions = positions.filter(pos => pitcherPositions.has(pos) === wantPitchers);

    if (wantPitchers) {
        // SP before RP specifically, not alphabetical - everything else (if any) falls back alphabetically after those two.
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

    // A group with a single position (hockey Goalies today) offers no meaningful filter - that one position IS the whole group, the same pool-identity case handles for the rank chips. Hide the dropdown and force the filter back to ALL so a value carried over from a multi-position group (say 'RW' selected under Skaters) can't silently filter this group down to nothing. Guarding on the computed list length, not a sport or position string, means any future one-position group inherits this, and re-showing on the next group/sport rebuild is automatic.
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

    // The exclusion threshold is games played for everyone now (see computeRotoRanks' own comment).
    const fractionPct = Math.round(MIN_PLAYING_TIME_FRACTION * 100);
    const maxGames = Math.max(0, ...groupPlayers.map(p => gamesPlayedOf(p, sport)));
    const tooltipText = `Needs ${Math.round(maxGames * MIN_PLAYING_TIME_FRACTION)}+ games played to be ranked (${fractionPct}% of the leader's games).`;
    container.innerHTML = `
        <label><input type="checkbox" id="min-playing-time-checkbox"${AppState.requireMinPlayingTime ? ' checked' : ''}> Minimum Games Played</label>
        <span class="hint" tabindex="0" role="button" aria-label="About the games-played minimum" data-hint="${escapeHtml(tooltipText)}">ⓘ</span>
    `;
    container.querySelector('#min-playing-time-checkbox').addEventListener('change', (e) => {
        AppState.requireMinPlayingTime = e.target.checked;
        renderPlayerLeaderboard();
    });
}

// Built once and reused - appended to <body> (not the scrolling leaderboard table) specifically so it can never get clipped by a table/column's overflow, unlike the old in-header tooltip that was getting cut off mid-sentence.
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
    // "same-role peers" (all Batters/Pitchers) only holds with no position filter - filtering to a position rescopes the comparison pool to just that position's players (see rankPool in renderPlayerLeaderboard), so the explanation needs to say so, not describe the unfiltered case while a filtered comparison is what's actually happening. Only RP matches by primary role instead of eligibility (see matchesPositionFilter) - SP uses plain eligibility, same as every other position filter.
    const isRpPool = posFilter === 'RP';
    const poolLabel = isFiltered ? `${posFilter}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}` : `All ${roleLabel}`;
    // Just an illustrative "filter to a position" example in the copy. Hockey skaters filter by C/LW/RW/D (goalies are all G, so there's no meaningful sub-pool there).
    const examplePos = sport === 'fhl' ? (wantPitchers ? 'G' : 'C') : (wantPitchers ? 'SP' : 'SS');

    const categoryIds = preferScoredDedup(
        Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)),
        statMap
    ).filter(id => AppState.scoredStatIds.has(id));

    const categoryChips = categoryIds.map(id => {
        const inverse = inverseSet.has(id);
        const opportunity = opportunityGateFor(id, isRpPool) ? ' *' : '';
        // Same "(as K/9)" labeling the drill-down breakdown uses - within the RP pool, K is compared as a rate, and the chip shouldn't imply a raw total is what's ranked.
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
    // RP is the one pool where shrinkage is skipped and K is compared as K/9 (see computeRotoRanks) - the generic pitcher wording would actively misdescribe it.
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

// A purely cosmetic "fake" progress indicator - there's no real byte-level progress signal available from a single fetch() to ESPN's player-pool endpoint (or from the bulk weekly-stats fetch, its other caller), so this eases toward, but never quite reaches, 90% on a fixed curve. That way it always looks like it's making headway no matter how long the real fetch actually takes; finish() then snaps it to 100% for a satisfying beat once real data is in hand, instead of the bar just vanishing mid-climb. stop() is the silent version for an error path, where there's nothing to celebrate.
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

// One shared in-flight fetch for the full player pool, so the Player Metrics tab's open path can await the SAME request a background prefetch already started (see prefetchPlayerData) instead of duplicating it. Keyed to the apiData object it was started for. A new league/year fetch mid-flight reassigns AppState.apiData and resets the pool (see processCoreData), which makes this response stale - it's discarded rather than written over the new league's state.
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
            AppState.playerDataError = null;
            buildPositionFilterOptions(sport);
            // My Team draws names, ranks and stats out of this pool, and after a league switch it renders BEFORE the pool lands, so every row read "Player 3942335" with dashes until something forced a re-render (, owner: switching tabs and back fixed it). Announce the arrival instead. An event rather than a direct call because myteam.js already imports this module, and importing it back would close a cycle for one line.
            document.dispatchEvent(new CustomEvent('leaguewise:player-pool-ready'));
        })();
        // A failed fetch must not poison every later attempt with the same rejected promise - clear the slot so the next call starts a fresh request.
        promise.catch((err) => {
            if (playerPoolFetch && playerPoolFetch.promise === promise) playerPoolFetch = null;
            // Recorded rather than only thrown, because the tab that ASKED for the pool is not the only tab that has to explain its absence - My Team reads the same state.
            if (AppState.apiData === apiDataRef) {
                AppState.playerDataError = { authRequired: !!err?.authRequired, message: err?.message || 'Unknown error' };
            }
        });
        playerPoolFetch = { apiDataRef, promise };
    }
    return playerPoolFetch.promise;
}

// The pool retry after a login lands mid-session. The user does not have to be on the Player tab for this to matter: My Team needs the same pool for its names, ranks and lines, and it redraws off the pool-ready event once this succeeds. Which path it takes depends on what is on screen, because loadPlayerTabIfNeeded owns the leaderboard's own loading UI and error text. Rendering that into a hidden view would throw the work away, so a background login just warms the pool quietly and lets the tab render on entry exactly as it always has.
export async function retryPlayerPoolAfterLogin() {
    if (!AppState.apiData || AppState.playerDataLoaded || !AppState.playerDataError) return;
    AppState.playerDataError = null;
    const playerView = document.getElementById('view-player');
    if (playerView && playerView.style.display !== 'none') {
        await loadPlayerTabIfNeeded();
        return;
    }
    await ensurePlayerDataLoaded(AppState.loadedSport).catch(() => {});
}

// Fire-and-forget warm-up, called as soon as league data lands (see processCoreData in data.js) - by the time the Player Metrics tab is first clicked, the ~5s pool fetch is usually already finished (or well underway), so the tab opens near-instantly instead of paying the whole ESPN round-trip on click. Errors are swallowed on purpose here. The tab's own open path below retries and owns the error UI.
export function prefetchPlayerData() {
    if (!AppState.apiData || AppState.playerDataLoaded) return;
    // This warms the pool for the league already in AppState, so it asks that league's sport for its player universe. Reading the form here would fetch one sport's pool for another's league the moment the user browsed the dropdown.
    const sport = AppState.loadedSport;
    ensurePlayerDataLoaded(sport)
        .then(() => {
            // Chain the bulk weekly-stats fetch right behind the pool fetch - the Rank column's trend arrows need it, and starting it only on the leaderboard's own first render meant the arrows popped in a few seconds AFTER the tab opened.
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

    const sport = AppState.loadedSport;
    const progress = showPlayerLoadingProgress(container);
    try {
        await ensurePlayerDataLoaded(sport);
        // The awaited fetch can resolve as a stale no-op if a new league fetch superseded it mid-flight (see ensurePlayerDataLoaded) - one retry covers that narrow window.
        if (!AppState.playerDataLoaded) await ensurePlayerDataLoaded(sport);
        await progress.finish();
        renderPlayerLeaderboard();
    } catch (err) {
        progress.stop();
        container.innerHTML = `<div class="player-loading">${escapeHtml(playerPoolErrorText(err))}</div>`;
    }
}

let bulkWeeklyFetchInFlight = false;
// Set once a bulk fetch attempt fails, so a failure shows a stable error instead of silently retrying on every re-render (search keystrokes, filter changes, etc. all call renderPlayerLeaderboard) - reset on a genuine new league/season fetch (see processCoreData).
let bulkWeeklyFetchFailed = false;

// True once every "real" player (has at least one defined season stat - skips the bulk of a raw ESPN player pool that's genuinely inactive/zero-stat, which getEffectivePlayerPool excludes anyway) has cached weekly data, which a windowed timeframe needs to compute anything for them.
function leaderboardWeeklyDataReady() {
    return AppState.playerData.every(p =>
        Object.keys(p.seasonTotals || {}).length === 0 || AppState.playerWeeklyCache[p.id]);
}

// Bulk-fetches weekly data for every real player still missing it, then re-renders the leaderboard. Fire-and-forget from renderPlayerLeaderboard (which stays synchronous) - guarded against overlapping fetches if the timeframe is clicked through quickly, since the underlying weekly data serves ANY windowed selection once cached (only the re-aggregation window changes, see getEffectivePlayerPool). --- Prioritized, progressive weekly loading ------------------------------------------- The bulk weekly fetch used to be one self-chunking call that resolved all-or-nothing. The whole pool was requested in pool order and the leaderboard only learned anything when every chunk was back (tens of seconds). Now players.js owns the ordering and the concurrency, so the queue can be re-ordered mid-flight and each chunk's rows land as they arrive. WHAT ORDERING CAN AND CANNOT BUY, because it shapes the whole design. A trend arrow is a pool-RELATIVE score. buildWeeklyRateBasis only trusts a real weekly basis once WEEKLY_BASIS_COVERAGE_THRESHOLD of the QUALIFIED pool is cached, and below that every row falls back to the season-average basis. So fetching the visible rows first cannot make their arrows appear first - an arrow for row 1 needs most of the pool, not row 1's own data. What the tiers below actually buy: (a) the basis pool is fetched before the inactive tail, so coverage crosses the threshold after a fraction of the work instead of after all of it, which is what moves time-to-arrows; (b) whatever the user is looking at is cached first, so a drill-down lands on warm data. Showing arrows before the threshold was considered and rejected. With visible-first ordering the early cache is exactly the top-ranked players, so a partial basis would be biased high and every row would read "below average" until it flipped.

// Ids still to fetch, in priority order. Mutated in place - workers shift chunks off the front and reprioritizeWeeklyQueue re-sorts what's left - so a scroll or re-sort changes what the NEXT request asks for without cancelling anything already in the air.
let weeklyQueue = [];
// Ids handed to a worker but not yet resolved. Held out of a reprioritize pass so two workers can never claim the same id, and released in a finally so a failed chunk doesn't strand them.
let weeklyClaimedIds = new Set();
// The pool debug context is set from the FIRST chunk of a run only. Setting it per chunk would thrash the panel while chunks stream, and the panel wants one representative response.
let weeklyPoolContextCaptured = false;

// A burst of chunk completions should repaint once, not once each.
const WEEKLY_RERENDER_DEBOUNCE_MS = 150;
let weeklyRerenderTimer = null;

// An extra observer fired on each debounced weekly-progress repaint, so a consumer OUTSIDE the Player tab can react to chunks landing. The Roto Race in the Team Metrics trends box uses it to fill in as its data arrives, the same progressive behavior the leaderboard arrows have; wired in main.js to avoid a players -> graphs import. Null when nobody's listening.
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

// The player ids whose rows are inside the leaderboard's scroll viewport right now, in visual order. Read straight off the RENDERED rows, so it already reflects the active sort, search, position and availability filters - none of that needs re-deriving here. Empty before the tab has ever rendered (the pool prefetch starts the queue earlier than that), which callers treat as "no visibility signal yet" rather than "nothing is visible".
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

// Every id the trend-arrow basis actually depends on, across BOTH group tabs (the user can switch to Pitchers/Goalies at any time, and that tab's arrows need its own qualified pool covered). Computed from the season pool, since this decides what to FETCH and no weekly data exists yet.
function weeklyBasisPoolIds(sport) {
    const ids = [];
    ['primary', 'secondary'].forEach(group => {
        const samePool = AppState.playerData.filter(p => matchesPlayerGroup(p, sport, group === 'secondary'));
        weeklyBasisQualifiedPool(samePool, sport).forEach(p => ids.push(p.id));
    });
    return ids;
}

// Tier the not-yet-fetched ids, rows on screen right now, then the rest of the basis pool, then everyone else. See the block comment above for why the middle tier is the one that moves time-to-arrows and the first tier is what makes a drill-down land warm.
function prioritizeWeeklyIds(ids, sport) {
    const remaining = new Set(ids);
    const ordered = [];
    const take = (id) => { if (remaining.delete(id)) ordered.push(id); };
    visibleLeaderboardPlayerIds().forEach(take);
    weeklyBasisPoolIds(sport).forEach(take);
    remaining.forEach(id => ordered.push(id));
    return ordered;
}

// Re-tier whatever is left after the user scrolls or re-sorts. Already-fetched and in-flight ids drop out, so nothing is requested twice and nothing already in the air is wasted.
export function reprioritizeWeeklyQueue() {
    if (!bulkWeeklyFetchInFlight || weeklyQueue.length === 0) return;
    const sport = AppState.loadedSport;
    const stillNeeded = weeklyQueue.filter(id => !AppState.playerWeeklyCache[id] && !weeklyClaimedIds.has(id));
    weeklyQueue = prioritizeWeeklyIds(stillNeeded, sport);
}

// Fixed pool of workers, each pulling the next chunk off the FRONT of the shared queue when it finishes one - so the queue is re-read between every request, which is what lets a reprioritize take effect mid-run. A chunk rejection propagates (Promise.all), matching the previous all-or-nothing failure semantics that set the sticky failed flag.
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
                // Superseded mid-flight (see the discard rule ensurePlayerDataLoaded documents): drop this chunk entirely rather than writing another league's rows into the freshly cleared cache, and stop pulling more work.
                if (AppState.apiData !== apiDataRef) return;
                // Its OWN kind, never the pool's. This is one chunk of daily splits for the ids that were prioritized, which is a different thing from the player pool and used to be labeled as it (see DEBUG_LABELS in utils.js).
                if (!weeklyPoolContextCaptured) {
                    weeklyPoolContextCaptured = true;
                    setDebugContext('player-weekly', raw);
                }
                processBulkPlayerWeeklyHistory(raw, sport);
                // Any requested player the response didn't include at all (no game logs this season) gets an empty stub - without one, leaderboardWeeklyDataReady() would stay false forever and every re-render would re-trigger the whole fetch in a loop.
                chunk.forEach(id => {
                    if (!AppState.playerWeeklyCache[id]) AppState.playerWeeklyCache[id] = { weekly: {}, weeklySums: {} };
                });
                // Progressive pop-in. Repaint as this chunk lands instead of once at the very end.
                scheduleWeeklyRerender();
            } finally {
                chunk.forEach(id => weeklyClaimedIds.delete(id));
            }
        }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
}

// My Team needs exactly the same weekly data for a windowed timeframe, but nothing on that tab used to ask for it. The bulk fetch was only ever kicked off by the leaderboard. So a user who fetched a league and went straight to My Team saw a windowed pill turn every roster line into a dash, and visiting Player Metrics was what secretly fixed it. That is the same shape of bug fixed for the pool itself. Exported so myteam.js can ask directly.
export function ensureWeeklyDataForTimeframe(sport) {
    if (!AppState.playerDataLoaded || bulkWeeklyFetchInFlight || bulkWeeklyFetchFailed) return;
    ensureLeaderboardWeeklyDataLoaded(sport);
}

// True while the roster's own weekly rows are still arriving. A player with no cache entry at all is UNKNOWN, which is a different statement from "played no games in this window", and telling them apart is what stops the tab claiming an absence that is really a loading state.
export function weeklyDataPending() {
    return bulkWeeklyFetchInFlight;
}

async function ensureLeaderboardWeeklyDataLoaded(sport) {
    if (bulkWeeklyFetchInFlight) return;
    const missingIds = AppState.playerData
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id])
        .map(p => p.id);
    if (missingIds.length === 0) return;

    // Same discard rule ensurePlayerDataLoaded documents. A league/year fetch mid-flight reassigns AppState.apiData and resets playerData/playerWeeklyCache (processCoreData), which makes these responses the WRONG league's. Their rows would be written into the new league's freshly cleared cache, aggregated with the `sport` captured back when this call started (so an NHL response could even be parsed with the MLB stat maps). This fetch takes tens of seconds for a full pool, so the window for that is wide, not theoretical. Checked per chunk now rather than once at the end, so a superseded run stops early instead of finishing.
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
        // A failure that belongs to a league nobody is looking at any more must not set the sticky failed flag, which would show the new league an error it never hit and block its own retry.
        if (AppState.apiData !== apiDataRef) return;
        console.error('Failed to load weekly stats for the leaderboard timeframe:', err);
        bulkWeeklyFetchFailed = true;
    } finally {
        bulkWeeklyFetchInFlight = false;
        weeklyQueue = [];
        weeklyClaimedIds.clear();
    }
    renderPlayerLeaderboard();
    // My Team reads the same windowed pool, so it has to hear about the data landing as well. An event rather than a direct call, for the same reason the pool-ready one is an event.
    document.dispatchEvent(new CustomEvent('leaguewise:weekly-data-ready'));
}

// ==== Roto Race: reconstruct the roto standings over time from weekly roster stats ====

// Kick the bulk weekly fetch for the Roto Race if it isn't already loading or permanently failed. prefetchPlayerData starts it on league load, but the Team tab can be opened before that finished (or the race re-rendered by a legend toggle), so the trends box makes sure the request is in flight. Same guard the leaderboard's own lazy trigger uses.
export function ensureWeeklyDataForRace(sport) {
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport);
}

// True once the fetch has permanently failed this session (the race shows an error line instead of hanging on a spinner).
export function weeklyDataFailed() { return bulkWeeklyFetchFailed; }

// The current league's identity, for keying the one-time transaction harvest so a previous league's log is never served. From apiData itself (not the form fields) so it can't drift.
function currentLeagueKey() {
    const d = AppState.apiData;
    return d ? `${d.gameId}:${d.id}:${d.seasonId}` : null;
}

let rosterHarvestInFlightKey = null;
let rosterHarvestFailedKey = null;
let snapshotHarvestInFlightKey = null;
let snapshotHarvestFailedKey = null;

// Fetch the draft picks and harvest the full transaction log ONCE per league+season, for the transaction-accurate Roto Race. Fire-and-forget. On completion it fires the weekly-progress hook so the trends box re-renders and upgrades from the current-roster fallback to the transaction-accurate race. Staleness-guarded like every other fetch - a league switch mid-harvest (apiData reassigned by processCoreData) discards the result rather than caching another league's log. A failure just leaves rosterTransactionData null, so the race stays on the current-roster fallback (golden rule 8); it never blocks or breaks the box.
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
        rosterHarvestFailedKey = key; // can't harvest without the period bounds - stay on the fallback
        return;
    }

    const apiDataRef = AppState.apiData;
    rosterHarvestInFlightKey = key;
    try {
        const [picks, transactions] = await Promise.all([
            fetchDraftDetail(sport, leagueId, year),
            harvestTransactions(sport, leagueId, year, firstSP, finalSP)
        ]);
        if (AppState.apiData !== apiDataRef) return; // superseded by a newer league fetch - drop it
        // Both empty means no usable history (a season before ESPN kept it, or a draft-less format with no moves) - leave the data null so the race keeps the current-roster fallback.
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

// Harvest the daily roster SNAPSHOTS ONCE per league+season, for the lineup-aware Roto Race. Same shape and guarantees as ensureRosterTransactionData: fire-and-forget, key-guarded, staleness- guarded (a league switch mid-harvest discards the result), and it fires the weekly-progress hook on completion so the race re-renders and upgrades from the rostered/current fallback to STARTED- accurate. A failure leaves rosterSnapshotData null and the race steps down the fallback ladder (golden rule 8). This is the ~196-request-per-season cost of started-accurate crediting - the same per-period pattern and concurrency cap as the transaction harvest, run alongside it (the transaction timeline still backs the rostered fallback tier and B66/).
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
        if (AppState.apiData !== apiDataRef) return; // superseded by a newer league fetch - drop it
        // No days at all means the season predates ESPN's stored daily rosters (or a private/empty response) - leave it null so the race falls back to the transaction timeline.
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

// The scoring period standing in for a real week when reading roster ownership. weekOfScoringPeriod (players.js) maps period -> max(1, floor(period/7)), so 7*week+3 lands squarely inside week's own span - a mid-week point, the best single-owner proxy available without re-bucketing the cache to per-period granularity. Used only by the rostered-day fallback tier (the started tier reads the per-day snapshots directly, no proxy needed). A roster change that falls inside a week therefore attributes that whole week to the mid-week owner; see the residual note on buildRotoRaceSeries.
function representativePeriodForWeek(week) { return week * 7 + 3; }

// True while the race should HOLD its loading state rather than draw, because the best tier we still expect hasn't arrived. The fallback ladder is a response to FAILURE, not to latency. Drawing whatever tier happens to be ready first made a cold load paint the current-roster race, then the rostered one, then the started one - three different racings of the same season in under a second, which is what "it changes layout a few times before settling" was. So a tier is only skipped once its harvest has actually FAILED for this league; while one is merely in flight (or hasn't started yet - the render kicks it) we wait. The weekly stats gate the whole thing. A chart built from a partially-filled cache is a real, visibly different chart (measured: the first paint used 450 of 1013 players), not just a rougher one.
function rotoRaceDataPending() {
    const key = currentLeagueKey();
    if (!key) return false;
    // No weekly stats, no race. A failure here is terminal and surfaces its own error state.
    if (!bulkWeeklyFetchFailed && !leaderboardWeeklyDataReady()) return true;
    // Snapshots (the started tier) are expected until their harvest fails.
    if (snapshotHarvestFailedKey !== key) {
        return !(AppState.rosterSnapshotData && AppState.rosterSnapshotData.key === key);
    }
    // Snapshots are out, so the transaction log (the rostered tier) is the best tier still expected.
    if (rosterHarvestFailedKey !== key) {
        return !(AppState.rosterTransactionData && AppState.rosterTransactionData.key === key);
    }
    return false; // both harvests failed - current rosters is the final answer, draw it
}

// The league's STARTING lineup-slot ids are every slot it actually rosters (lineupSlotCounts > 0) minus the bench/IR ids for the sport (NON_STARTING_SLOTS). Adapts to each league's own roster construction while the bench/IR ids stay fixed per sport - see the validation note on NON_STARTING_SLOTS. A player's day credits his team only when that day's snapshot slot is in here.
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

// The started-tier accumulation, factored out of buildRotoRaceSeries so the Roto Race and the windowed roto standings/heatmap share ONE source of truth, per team a { week -> { sums, games } } map of the started-day component sums. Both then aggregate + score off this same map, so the identity holds by construction - the "Full Season" window (weeks[0]..last) is literally the race's final cumulative point, which reproduced ESPN's official finals exactly on FGB 2025 (61.0/56.5/55.0/40.5/27.0). If windowing and the race could ever disagree, they'd have to read different sums, and they can't, because there is only this function. Returns null unless the STARTED tier is actually available - the snapshot harvest landed for THIS league AND the weekly component cache is complete. Windows are only honest on started-day data (B71's ladder is for failure, not latency). The rostered/current fallbacks count benched days ESPN never did, so a "last 4 weeks" off them would be a plausible-looking wrong number. Memoized by league key + weekly-cache size (the cache only grows as chunks land, so its size is a sufficient staleness key), so the per-cell heatmap lookups below don't re-accumulate.
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

// The roto race across the DAYS of one week rather than across weeks. Same started-day crediting as rotoStartedSums above, and deliberately the same walk. A day counts for whichever team had the player STARTED that day, so the daily race and the weekly one cannot disagree about who owns what. The only difference is the bucket, period instead of week. Each team's days are then run through aggregateDailyCumulative, which is the same pure function the drill-down uses, so cumulative counting stats and component-derived rates behave identically on both surfaces rather than being implemented twice. Returns null when roto's own preconditions are not met, which is what keeps this off the fallback tiers where per-day shape would be wrong because they count benched days ESPN never did.
export function rotoCategoryDailySeries(sport) {
    const acc = rotoStartedSums(sport);
    if (!acc || !acc.weeks.length) return null;
    const snapData = AppState.rosterSnapshotData;
    if (!snapData) return null;

    // Current in roto is the latest week the race has, or the active window's end when one is set.
    const win = activeRotoWindow(sport);
    const week = win ? win.end : acc.weeks[acc.weeks.length - 1];

    const teamIdSet = new Set(AppState.teamStats.map(t => t.id));
    const startedTL = buildStartedTimeline({ rosterDays: snapData.days, startingSlots: startingSlotsForLeague(sport) });
    const byTeamDaily = new Map(AppState.teamStats.map(t => [t.id, {}]));
    const periodSet = new Set();

    AppState.playerData.forEach(p => {
        const daily = AppState.playerWeeklyCache[p.id]?.dailyByPeriod;
        if (!daily) return;
        Object.keys(daily).forEach(periodKey => {
            const period = Number(periodKey);
            if (weekOfScoringPeriod(period) !== week) return;
            const teamId = startedTeamForPlayerAtPeriod(startedTL, p.id, period);
            if (!teamId || !teamIdSet.has(teamId)) return;
            periodSet.add(period);
            const dest = byTeamDaily.get(teamId);
            if (!dest[period]) dest[period] = { sums: {}, games: 0 };
            dest[period].games += daily[periodKey].games;
            Object.keys(daily[periodKey].sums).forEach(id => {
                dest[period].sums[id] = (dest[period].sums[id] || 0) + daily[periodKey].sums[id];
            });
        });
    });

    const periods = Array.from(periodSet).sort((a, b) => a - b);
    // One day is a point, not a race. The block gives the height back to its bars instead.
    if (periods.length < 2) return null;

    const byTeam = new Map();
    byTeamDaily.forEach((dailyForTeam, teamId) => {
        byTeam.set(teamId, aggregateDailyCumulative(dailyForTeam, periods, sport).map(d => d.totals));
    });
    return { periods, byTeam, week };
}

// True when roto windows are available at all. The started tier landed and produced weeks. The timeframe pill row (controls.js) uses this to decide ONCE - shown only for started-tier leagues, never appearing/disappearing while the harvest loads. rotoWindowMaxWeek is the race's last week, the max the "last N weeks" windows count back from (roto has no matchup periods - windows are day-buckets grouped to weeks, labelled by week like the race's x-axis).
export function rotoWindowsAvailable(sport) {
    const acc = rotoStartedSums(sport);
    return !!(acc && acc.weeks.length > 0);
}
export function rotoWindowMaxWeek(sport) {
    const acc = rotoStartedSums(sport);
    return acc && acc.weeks.length ? acc.weeks[acc.weeks.length - 1] : 0;
}

// The active roto window as { start, end } weeks, or null when the current timeframe is the full season (Season/Full shows ESPN's OFFICIAL standings verbatim - never a computed window) or when the started tier isn't available. Only 'last N' pills resolve to a real window here.
export function activeRotoWindow(sport) {
    if (!AppState.isRotoLeague) return null;
    const n = parseTimeframe(AppState.timeframe).window;
    if (!n) return null;
    const acc = rotoStartedSums(sport);
    if (!acc || acc.weeks.length === 0) return null;
    const maxWeek = acc.weeks[acc.weeks.length - 1];
    return { start: Math.max(acc.weeks[0], maxWeek - n + 1), end: maxWeek };
}

// Per-category CUMULATIVE weekly values for the Category Rankings race, off the same started-day sums the windowed standings and heatmap read - so a category's race and its ranking bar can never disagree. Returns { weeks, byTeam } where byTeam.get(teamId)[i] is that team's derived category values accumulated from the window's first week through weeks[i] (rate categories derived from summed components at each step, never averaged - deriveRateOverrides). Returns null when there is no honest race to draw. The started tier isn't available (the rostered/current fallbacks count benched days ESPN never did, so their per-week shape would be wrong), or the window is a single week (nothing races across one point). Memoized per league + cache size + window, since every visible category block asks for it on every render.
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

// Re-scores the categories over ONLY the window's accumulated started-day components. It sums each team's raw components across the window's weeks, derive the rate categories from those sums (never average per-day rates - deriveRateOverrides), then run the SAME pure scoreRotoWeek the race uses. Returns { pointsByTeam, catValuesByTeam, pointsByStatByTeam } for the windowed standings, heatmap, and per-category rankings, or null when the started tier isn't available. Memoized per (league, cache size, window) so the heatmap's per-cell value lookups are O(1) after the first. The result is exact-by-identity. The full-season window reproduces the race final, which reproduced ESPN's official points AND pointsByStat. - pointsByTeam: Map<teamId, total roto points over the window> (Team Rankings) - catValuesByTeam: Map<teamId, { statId: windowed value }> (heatmap cells) - pointsByStatByTeam: Map<teamId, { statId: roto points that category gave }> (Category Rankings)
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

    // Per-category points, summed into each team's total. This is exactly scoreRotoWeek's own loop (the same pure rotoPointsForCategory), just also recording the per-category split the Category Rankings view needs - so totals here always equal scoreRotoWeek(scoreInput, categories).
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
    rotoWindowResultCache = { [cacheId]: result }; // keep only the latest window - one is ever displayed at a time
    return result;
}

// Builds the Roto Race. It credits each player's stats to a team over time, aggregate each team's cumulative category values, score them roto-style across teams (the pure scoreRotoWeek), and record each team's running total. This is the one place roto points are computed rather than read from ESPN (season-end standings stay verbatim - see rotoPoints in data.js). THREE crediting modes, a fallback ladder (golden rule 8) - the race always renders, only its fidelity and subtitle change as more data lands: 'started': AppState.rosterSnapshotData holds every day's full lineup. Credit each single day to whoever had the player in a STARTING slot that day (startedTeamForPlayerAtPeriod). This is exactly what ESPN's roto standings count, so it reproduces each team's valuesByStat and lands on the official finals - VALIDATED on FGB 2025: per-category deltas are zero across all 5 teams, finals 61.0/56.5/55.0/40.5/27.0 exactly. 'rostered': no snapshots, but AppState.rosterTransactionData holds the draft + transaction log. Credit each week to whoever ROSTERED the player mid-week. Faithful to trades and drops but counts benched days ESPN doesn't, so it lands near - not on - the finals. 'current': neither harvested yet. Every week credits the player's CURRENT team - a trade rewrites the whole past. Roughest; the original subtitle names it. Returns `mode` so the caller picks the matching subtitle. The started tier resolves the started-vs-rostered residual the note described; the only thing left between it and ESPN is a mid-DAY lineup edit (a snapshot is one slot per day), which the FGB validation showed nets to zero here. Rate categories reproduce from summed COMPONENTS, not averaged daily rates (deriveRateOverrides) - the same path baseball uses, so this is sport-general. Progressive by construction. It reads whatever the caches hold right now, so a half-loaded pool renders a shorter/rougher race that fills in as weekly chunks and the two harvests land, each re-rendering the box via setWeeklyProgressHook.
export function buildRotoRaceSeries(sport) {
    const inverseSet = INVERSE_STATS[sport] || new Set();
    const categories = Array.from(AppState.scoredStatIds).map(id => ({ id, inverse: inverseSet.has(id) }));
    const teamIdSet = new Set(AppState.teamStats.map(t => t.id));

    const leagueKey = currentLeagueKey();
    // Hold one loading state until the best tier we still expect is COMPLETE, then draw once. Returning early also skips the whole accumulation, which would be thrown away anyway.
    if (rotoRaceDataPending()) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode: 'loading', loading: true };
    }

    const snapData = AppState.rosterSnapshotData;
    const txData = AppState.rosterTransactionData;
    const useSnapshots = !!(snapData && snapData.key === leagueKey);
    const useTimeline = !useSnapshots && !!(txData && txData.key === leagueKey);
    const mode = useSnapshots ? 'started' : (useTimeline ? 'rostered' : 'current');

    // Accumulate into a shared week -> { sums, games } structure per team, so the cumulative scoring below is identical for all three modes - they differ only in which team a slice of stats credits.
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
        // Started tier. Fold in the shared per-team week sums (rotoStartedSums) that the windowed standings/heatmap read too, so the race's cumulative points and any window's points come off the very same components - the identity is structural, not a coincidence to test for. Each (team, week) bucket is already aggregated, so crediting it once reproduces the old per-day loop exactly (validated: finals unchanged on FGB 2025).
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

    // A "last N weeks" pill re-bases the race onto that window. Draw only the window's weeks, and accumulate each week's cumulative from the window's FIRST week rather than the season's - so the race shows how the last-N-weeks standing evolved and its final point is exactly the windowed standings in the Rankings box (same aggregate + score). Full Season (window null) keeps the whole-season race, whose final point reproduces ESPN's official finals. Windows only exist on the started tier, so this never engages on the rostered/current fallbacks.
    const win = activeRotoWindow(sport);
    const weeks = win ? allWeeks.filter(w => w >= win.start && w <= win.end) : allWeeks;
    const baseWeek = win ? win.start : allWeeks[0];
    if (weeks.length === 0) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode };
    }

    // Cumulative team category values through each week, scored into a running roto total. Same aggregateStatsForWeekRange the arrows and drill-down use, so rate stats aggregate identically.
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

// Called on a genuine new league/season fetch (see processCoreData in data.js) - this module's per-league caches and sticky flags all have to go with it. The failed flag, because a failure from a previous league/season shouldn't permanently block the new one from trying again. The drill-down diagnostics, because they're keyed by player id alone. The SAME player has a different payload in a different season, so a cached one would otherwise be served for the new league's drill-down and quietly show the wrong season's numbers in the panel.
export function resetLeaderboardWeeklyFetchState() {
    bulkWeeklyFetchFailed = false;
    Object.keys(playerDetailDiagnostics).forEach(id => delete playerDetailDiagnostics[id]);
    // Both harvests are per league+season; clear the sticky in-flight/failed flags so the new league can harvest its own (the cached data itself is key-guarded, but the flags aren't).
    rosterHarvestInFlightKey = null;
    rosterHarvestFailedKey = null;
    snapshotHarvestInFlightKey = null;
    snapshotHarvestFailedKey = null;
    AppState.rosterTransactionData = null;
    AppState.rosterSnapshotData = null;
    // Windowed-roto memoization is keyed by league + cache size, but the snapshot data it reads is cleared above, so drop the derived caches too rather than serve a stale league's sums.
    rotoStartedSumsCache = null;
    rotoWindowResultCache = {};
    rotoCatSeriesCache = null;
}

// Called from processCoreData (data.js) on every league/season/sport switch, before the player tab reloads. Leaderboard view-state that made sense for the previous league can dangle into the next one and either crash or silently show nothing: - Sort column. A stat-id sort ('5' = HR) points at a column a different sport doesn't have. 'rotoScore' used to be invalid in a points league and caused the null dereference; since every league type ranks, so it is valid everywhere and is the default. - Position filter. Codes are sport-specific ('SP'/'SS' baseball, 'C'/'D'/'G' hockey), so one carried across sports matches no player and empties the leaderboard. This resets only what's genuinely invalid for the new league, so a same-league refresh keeps the user's chosen sort/filter. The category-league 'total' -> 'rotoScore' direction is also applied here (the render/export paths do it too, kept as belt-and-suspenders).
export function normalizePlayerViewStateForLeague() {
    // Runs from processCoreData, which sets AppState.loadedSport before calling this, so the state being normalized is judged against the league that just landed rather than the form.
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};

    const sortStat = AppState.playerSortStat;
    const universalSortKeys = new Set(['name', 'teamName', 'positionName', 'gp', 'ip']);
    let sortValid;
    if (universalSortKeys.has(sortStat)) sortValid = true;
    else if (sortStat === 'total') sortValid = AppState.isPointsLeague;
    else if (sortStat === 'rotoScore') sortValid = true; // every league type ranks now
    else sortValid = statMap[sortStat] !== undefined; // a stat-id column this sport actually has
    // Rank for every league type. A points league defaulted to the raw points total back when it had no ranking; it has one now, and the rank is what the other two formats open on.
    if (!sortValid) AppState.playerSortStat = 'rotoScore';

    const posFilter = AppState.playerPositionFilter;
    if (posFilter && posFilter !== 'ALL') {
        // Every position this sport can show, primary-role names (POSITION_MAPS) plus the specific slot names (SLOT_POSITION_MAPS gives baseball LF/CF/RF). buildPositionFilterOptions handles the within-sport case on render; this catches the cross-sport carryover earlier.
        const validPositions = new Set([
            ...Object.values(POSITION_MAPS[sport] || {}),
            ...Object.values(SLOT_POSITION_MAPS[sport] || {})
        ]);
        if (!validPositions.has(posFilter)) AppState.playerPositionFilter = 'ALL';
    }
}

// The leaderboard's sort, in place, per the current AppState sort selection - shared between the table render and buildLeaderboardExportModel so an export is always ordered exactly like the table it mirrors.
function sortLeaderboardPlayers(players, rotoRanks, sport) {
    // Defense in depth for the crash. 'rotoScore' has no data in a points league (rotoRanks is null there). normalizePlayerViewStateForLeague already converts it on every league switch, but a null dereference here is a hard crash that empties the whole tab, so this belt keeps any future path that reaches here with the bad combo from ever crashing - it just sorts by the points 'total' instead.
    let sortStat = AppState.playerSortStat;
    if (sortStat === 'rotoScore' && !rotoRanks) sortStat = 'total';
    const dir = AppState.playerSortDir === 'asc' ? 1 : -1;
    const stringSortKeys = { name: 'name', teamName: 'teamName', positionName: 'positionDisplay' };
    players.sort((a, b) => {
        // Unranked rows (the zero-games cohort computeRotoRanks' zero floor refuses to score, ) sit below every ranked row no matter which column is being sorted or in which direction. Without this, an ascending sort on any stat would float that whole pile back to the top, which is the exact thing the floor exists to stop.
        if (rotoRanks) {
            const aRanked = rotoRanks.ranks.has(a.id);
            if (aRanked !== rotoRanks.ranks.has(b.id)) return aRanked ? -1 : 1;
        }
        if (stringSortKeys[sortStat]) return a[stringSortKeys[sortStat]].localeCompare(b[stringSortKeys[sortStat]]) * dir;
        if (sortStat === 'rotoScore') return ((rotoRanks.scores.get(a.id) || 0) - (rotoRanks.scores.get(b.id) || 0)) * dir;
        if (sortStat === 'gp') return (gamesPlayedOf(a, sport) - gamesPlayedOf(b, sport)) * dir;
        if (sortStat === 'ip') return ((a.seasonTotals[IP_STAT_ID] || 0) - (b.seasonTotals[IP_STAT_ID] || 0)) * dir;
        // Total prefers the points computed from THIS window's stat line, so a "last 4 matchups" view sorts by points scored in those four rather than by the season figure ESPN publishes once. Before the season starts (or before a player's first game) nothing has been scored, so fall back to appliedTotal and then to ESPN's projection, which keeps "highest fantasy points" meaningful instead of falling back to raw fetch order.
        const totalOf = (p) => {
            const scored = rotoRanks && rotoRanks.scores.get(p.id);
            return scored !== undefined ? scored : (p.appliedTotal || p.projectedAppliedTotal || 0);
        };
        const av = sortStat === 'total' ? totalOf(a) : (a.seasonTotals[sortStat] || 0);
        const bv = sortStat === 'total' ? totalOf(b) : (b.seasonTotals[sortStat] || 0);
        return (av - bv) * dir;
    });
}

// Structured snapshot of the leaderboard exactly as currently configured - group tab, search, position filter, sort direction/column, Minimum Games toggle, and the shared timeframe all apply, so what exports is what's on screen. Built for export.js (CSV/clipboard). Returns null when the pool (or, for a windowed timeframe, the weekly data it needs) isn't loaded yet. includeAdvanced overrides the on-screen Advanced Stats toggle so an export can carry every tracked stat without flipping UI state; IP is exported as decimal innings (outs/3, spreadsheet-summable) rather than the display's baseball ".1/.2 outs" notation.
export function buildLeaderboardExportModel(includeAdvanced = AppState.showAdvancedStats) {
    if (!AppState.playerDataLoaded) return null;
    if (!isFullSeasonTimeframe() && !leaderboardWeeklyDataReady()) return null;

    const sport = AppState.loadedSport;
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
    const rotoRanks = computeLeagueRanks(rankPool, sport, posFilter);
    // Mirrors the leaderboard's own rule (see renderPlayerLeaderboard). Unranked rows are hidden with Minimum Games Played on, and kept (sorted last, rank "-") with it off, so the export carries exactly the rows that are on screen.
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));
    // Same default-sort normalization renderPlayerLeaderboard applies - an export taken before the leaderboard's first render (the pool prefetches in the background) would otherwise carry the old points 'total' default instead of Rank.
    if (AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }
    sortLeaderboardPlayers(players, rotoRanks, sport);

    const exportCell = (val) => {
        if (val === undefined || val === null) return '';
        const num = Number(val);
        if (!Number.isFinite(num)) return '';
        return (num % 1 !== 0) ? +num.toFixed(3) : num;
    };

    // Innings pitched is a baseball-pitcher column only. Hockey's secondary group is goalies, who have no innings concept (and id 34, what IP_STAT_ID points at, means GP in hockey) - the GP column already covers their workload.
    const showInnings = wantPitchers && sport === 'flb';
    const headers = [
        'Player', 'Team', 'Pos',
        ...(AppState.isPointsLeague ? ['Rank', 'Total'] : ['Rank', 'Rank Score']),
        'GP',
        ...(showInnings ? ['IP'] : []),
        ...statIds.map(id => statMap[id])
    ];
    const rows = players.map(p => [
        p.name, p.teamName, p.positionDisplay,
        ...(AppState.isPointsLeague
            ? [rotoRanks.ranks.has(p.id) ? rotoRanks.ranks.get(p.id) : '-',
               exportCell(rotoRanks.scores.get(p.id) !== undefined ? +rotoRanks.scores.get(p.id).toFixed(1) : p.appliedTotal)]
            // An unranked row (zero games, kept only when Minimum Games Played is off) exports the same "-" the table shows, with a blank score rather than a fabricated 0.
            : rotoRanks.ranks.has(p.id)
                ? [rotoRanks.ranks.get(p.id), +(rotoRanks.scores.get(p.id) || 0).toFixed(1)]
                : ['-', '']),
        exportCell(gamesPlayedOf(p, sport)) || 0,
        ...(showInnings ? [p.seasonTotals[IP_STAT_ID] !== undefined ? +(p.seasonTotals[IP_STAT_ID] / 3).toFixed(2) : ''] : []),
        ...statIds.map(id => exportCell(p.seasonTotals[id]))
    ]);

    return { headers, rows };
}

// The leaderboard's own ranking, offered to surfaces that show a rank outside the table (B90's roster band). Both role pools are ranked exactly as the table ranks them, with no position filter, so a roster row and the leaderboard row for the same player always agree. Returns a Map of playerId to { rank, total, poolLabel }. A player the engine will not rank now gets an entry too, with a null rank and the REASON - the dash the caller draws is right, but a dash alone made two different states look identical, and the one the owner hit (no games in the selected window) is the one worth naming. A player missing from the map entirely still means something else, that they are not in the pool at all.
export function rosterRankLookup(sport) {
    const out = new Map();
    if (!AppState.playerDataLoaded) return out;
    const pool = getEffectivePlayerPool(sport);
    // computeRotoRanks' ctx reads AppState.playerGroup for its workload measures, because every other caller ranks exactly one group - the one whose tab is open. This ranks BOTH in one pass, so the group has to be moved for the duration of each, then put back. Without that, the pitcher pass measured pitchers by GP (a batting stat 8 of 1520 pitchers carry), so nearly every pitcher read as zero games and the zero floor refused to rank them, 6 pitcher ranks against 445 batter ranks on a pool holding 1520 pitchers.
    const activeGroup = AppState.playerGroup;
    try {
        [['primary', false], ['secondary', true]].forEach(([group, wantPitchers]) => {
            AppState.playerGroup = group;
            const groupPlayers = pool.filter(p => matchesPlayerGroup(p, sport, wantPitchers));
            if (!groupPlayers.length) return;
            const label = (GROUP_LABELS[sport] || {})[group] || group;
            const ranked = computeLeagueRanks(groupPlayers, sport);
            ranked.ranks.forEach((rank, id) => out.set(id, {
                rank, total: ranked.total, poolLabel: label, score: ranked.scores.get(id)
            }));
            groupPlayers.forEach(p => {
                if (out.has(p.id)) return;
                out.set(p.id, { rank: null, poolLabel: label, reason: unrankedReason(p, groupPlayers, sport) });
            });
        });
    } finally {
        AppState.playerGroup = activeGroup;
    }
    return out;
}

export function renderPlayerLeaderboard() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    // Returning silently here used to leave whatever was already painted on screen, which after a league switch is the PREVIOUS league's rows. processCoreData clears playerDataLoaded, and every direct caller (timeframe pills, filters, sorts) then hit this early return and left the stale table sitting there. Painting the loading state instead means no caller can leave another league's players visible, and callers stop needing to know the load state. Deliberately NOT showPlayerLoadingProgress. That starts a rAF loop and an interval, and this function runs on every keystroke/sort/filter, so repeat calls would stack timers. A static line is idempotent. It also yields to a progress bar already running (loadPlayerTabIfNeeded owns that richer indicator) rather than replacing it mid-animation. No fetch is started from here - whoever cleared playerDataLoaded owns reloading the pool.
    if (!AppState.playerDataLoaded) {
        const playerView = document.getElementById('view-player');
        const onScreen = playerView && playerView.style.display !== 'none';
        if (onScreen && !container.querySelector('.player-loading, .player-loading-progress')) {
            container.innerHTML = '<div class="player-loading">Loading players...</div>';
        }
        return;
    }

    // The LOADED league's sport, never the dropdown's. Every stat map, position map and role group below keys off it, so reading the form re-rendered this pool under the other sport's rules the next time anything repainted - a background weekly chunk was enough - and left a handful of accidental survivors. The dropdown is an input for the next fetch, not state.
    const sport = AppState.loadedSport;
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
    // IP is a baseball-pitcher-only column (hockey's secondary group is goalies - no innings).
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

    // "Total" (ESPN's real appliedTotal) only exists for points-format leagues. Category leagues get a computed roto-style rank instead - not ESPN's raw "FPTS" stat, which turned out to be some generic points formula unrelated to this league's actual scoring settings (and doesn't exist for pitchers at all). Default sort falls back to this rank rather than all the way back to name. Ranked against ALL batters (or pitchers) by default, but scoped down to just the filtered position when one's selected - "best SS" only means something when compared against other SS-eligible players, not the whole player pool (a corner-infield-only slugger could easily out-rank every real SS overall while being irrelevant to "who's the best shortstop").
    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = computeLeagueRanks(rankPool, sport, posFilter);

    // With Minimum Games Played ON, rotoRanks.ranks holds exactly the players who cleared the threshold - hide the rest from the table entirely, rather than showing a row with a "Min GP" placeholder no one asked to see. With it OFF the user has explicitly asked to see the marginal players, so the ones the engine STILL won't rank (only the zero-games cohort now - see computeRotoRanks' zero floor, ) are kept and pushed below every ranked row with a "-" instead of a rank, rather than vanishing from the one view whose job is "show me everyone".
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));

    renderAdvancedStatsToggle(advanced.length);
    renderMinPlayingTimeToggle(rankPool, sport);
    if (AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }

    sortLeaderboardPlayers(players, rotoRanks, sport);

    if (players.length === 0) {
        container.innerHTML = '<div class="player-loading">No players match your search/filter.</div>';
        return;
    }

    const sortArrow = (key) => AppState.playerSortStat === key ? (AppState.playerSortDir === 'asc' ? ' ▲' : ' ▼') : '';

    // Medals for the current pool's top 3 (the ranks are already scoped to the active position filter via rankPool, so "top 3 SS" gets medals under an SS filter) plus weekly-form arrows (see buildMatchupTrendIcons) - both live in the Rank column, which points leagues don't have.
    const trendIcons = AppState.isPointsLeague ? new Map() : buildMatchupTrendIcons(players, sport);
    const rankExtrasFor = (p) => {
        const medal = RANK_MEDALS[rotoRanks.ranks.get(p.id)] || '';
        const trend = trendIcons.get(p.id);
        const trendHtml = trend
            ? `<span class="trend-icon trend-${trend.dir}" title="${escapeHtml(trend.tip)}">${trend.dir === 'up' ? '↗' : '↘'}</span>`
            : '';
        // Availability sits last in the group, after the earned icons, because a rank is what the row is sorted by and an injury is the caveat on it.
        const injuryHtml = injuryBadgeHtml(p.injuryStatus);
        return (medal || trendHtml || injuryHtml) ? ` ${medal}${trendHtml}${injuryHtml}` : '';
    };

    // A player the engine won't rank still gets the availability badge, and is the player most likely to need it, since an unranked row and a long IL stint are usually the same fact.
    const rankCellHtml = (p) => rotoRanks.ranks.has(p.id)
        ? `#${rotoRanks.ranks.get(p.id)} of ${rotoRanks.total}${rankExtrasFor(p)}`
        : `<span class="rank-unranked" title="No games played, nothing to rank on">-</span>${injuryBadgeHtml(p.injuryStatus)}`;

    let html = `
        <table class="player-table">
            <thead>
                <tr>
                    <th class="sortable" data-sort="name">Player${sortArrow('name')}</th>
                    <th class="sortable" data-sort="teamName">Team${sortArrow('teamName')}</th>
                    <th class="sortable" data-sort="positionName">Pos${sortArrow('positionName')}</th>
                    ${AppState.isPointsLeague ? `<th class="sortable" data-sort="rotoScore"><span class="rank-th-label">Rank${posFilter !== 'ALL' ? ` (${escapeHtml(posFilter)})` : ''}${sortArrow('rotoScore')}</span></th><th class="sortable" data-sort="total">Total${sortArrow('total')}</th>` : `<th class="sortable" data-sort="rotoScore"><span class="rank-th-label">Rank${posFilter !== 'ALL' ? ` (${escapeHtml(posFilter)})` : ''}${sortArrow('rotoScore')}<button type="button" id="rank-explainer-trigger" class="rank-explainer-trigger">ⓘ</button></span></th>`}
                    <th class="sortable" data-sort="gp">GP${sortArrow('gp')}</th>
                    ${showInnings ? `<th class="sortable" data-sort="ip">IP${sortArrow('ip')}</th>` : ''}
                    ${statIds.map(id => `<th class="sortable player-col-stat" data-sort="${id}">${escapeHtml(statMap[id])}${sortArrow(id)}</th>`).join('')}
                    <th class="player-col-fill"></th>
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
                ${AppState.isPointsLeague ? `<td>${rankCellHtml(p)}</td><td>${(rotoRanks.scores.get(p.id) !== undefined ? rotoRanks.scores.get(p.id) : p.appliedTotal).toFixed(1)}</td>` : `<td>${rankCellHtml(p)}</td>`}
                <td>${formatStatValue(gamesPlayedOf(p, sport))}</td>
                ${showInnings ? `<td>${formatInnings(p.seasonTotals[IP_STAT_ID])}</td>` : ''}
                ${statIds.map(id => `<td class="player-col-stat">${formatStatValue(p.seasonTotals[id])}</td>`).join('')}
                <td class="player-col-fill"></td>
            </tr>
        `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
    sizeLeaderboardColumns(container);

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

    // The Rank column's weekly-form arrows need per-week data for the whole pool - when it isn't cached yet (a full-season timeframe never needed it for the table itself), fetch it quietly in the background; each chunk's completion re-render pops more arrows in. Windowed timeframes still force this same fetch up front (with the progress UI above), since their table can't render at all without it.
    if (!AppState.isPointsLeague && !leaderboardWeeklyDataReady() && !bulkWeeklyFetchFailed) {
        ensureLeaderboardWeeklyDataLoaded(sport);
    }

    // Rows just changed (a re-sort, a filter, a search, or a progressive chunk repaint), so what's on screen changed too - re-tier the rest of the queue behind it. A no-op when no fetch is running.
    reprioritizeWeeklyQueue();
}

// The category pitch, under the rule My Team's roster follows: clamp(available / N, FLOOR, CAP), with the constants read from:root so the two tables cannot answer the same question differently. Before this the stat columns split whatever the fixed text columns left, with nothing to stop them - nine categories on a wide table came out at 130px a column for figures needing a third of that, and at a narrow window the same generous gaps survived while the table scrolled sideways instead. NOTHING HERE MAY DEPEND ON THE POOL, which is B59's rule and the reason the floor is built from the HEADINGS plus a constant allowance rather than from the values on screen. Measuring the widest value would put the Minimum Games toggle, the search box and every filter back in charge of the column geometry, which is exactly the sliding removed. Headings change with the league, not with what is being shown of it. Deterministic, so it is recomputed on every render rather than cached. A cache here would buy nothing and could go stale across a league switch, which is the trap B152's follow-up spent its time getting out of.
function sizeLeaderboardColumns(container) {
    const table = container.querySelector('.player-table');
    if (!table || !container.clientWidth) return;
    const statHeads = [...table.querySelectorAll('th.player-col-stat')];
    if (!statHeads.length) return;

    const rootCs = getComputedStyle(document.documentElement);
    const px = (name, fallback) => {
        const v = parseFloat(rootCs.getPropertyValue(name));
        return Number.isFinite(v) ? v : fallback;
    };
    const cap = px('--cat-pitch-cap', 90);
    const tighten = px('--cat-pitch-tighten', 5);
    const valueMin = px('--cat-value-min', 34);
    const nameMin = px('--cat-name-min', 120);
    const teamMin = px('--cat-team-min', 96);

    // The text columns go back to full width before anything is measured, so the room the categories are dividing is never last render's answer to the same question.
    const nameHead = table.querySelector('th[data-sort="name"]');
    const teamHead = table.querySelector('th[data-sort="teamName"]');
    table.style.removeProperty('--pl-name-w');
    table.style.removeProperty('--pl-team-w');

    // The fixed columns are TOTALLED FROM THEIR DECLARED WIDTHS, never measured. A fixed-layout table hands any surplus back to its columns, so the rendered header is wider than the width it was given - the name column read 195px against the 175px it was set to - and totalling those measurements would feed the previous answer straight back into the next one.
    const tableCs = getComputedStyle(table);
    const declared = (name, fallback) => {
        const v = parseFloat(tableCs.getPropertyValue(name));
        return Number.isFinite(v) ? v : fallback;
    };
    const nameFull = declared('--pl-name-base', 175);
    const teamFull = declared('--pl-team-base', 160);
    // Every declared width is CONTENT box, and this table sets border-collapse: separate, so a column's advance is its width plus its own padding. Totalling the widths alone understated the text columns by 20px each and handed the categories 100px that was never theirs, which put the table back outside its viewport.
    const textHead = table.querySelector('th[data-sort="name"]') || table.querySelector('thead th');
    const textCs = getComputedStyle(textHead);
    const textPad = parseFloat(textCs.paddingLeft) + parseFloat(textCs.paddingRight);
    const widthIf = (selector, value) => (table.querySelector(selector) ? value + textPad : 0);
    const shared = widthIf('th[data-sort="name"]', nameFull)
        + widthIf('th[data-sort="teamName"]', teamFull)
        + widthIf('th[data-sort="positionName"]', declared('--pl-pos-w', 75))
        + widthIf('th[data-sort="rotoScore"]', declared('--pl-rank-w', 140))
        + widthIf('th[data-sort="total"]', declared('--pl-rank-w', 140))
        + widthIf('th[data-sort="gp"]', declared('--pl-gp-w', 50))
        + widthIf('th[data-sort="ip"]', declared('--pl-ip-w', 65));

    // A probe in the header's own font, never the header cells themselves - measuring a cell asks the column how wide the column is, which is circular.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
    probe.style.font = getComputedStyle(statHeads[0]).font;
    table.appendChild(probe);
    const headW = Math.max(0, ...statHeads.map(th => {
        probe.textContent = th.textContent.replace(/[▼▲]/g, '').trim();
        return probe.getBoundingClientRect().width;
    }));
    probe.remove();

    const statCs = getComputedStyle(statHeads[0]);
    const statPad = parseFloat(statCs.paddingLeft) + parseFloat(statCs.paddingRight);
    const n = statHeads.length;
    // Every number from here is a COLUMN ADVANCE, width plus padding, which is what --cat-pitch-cap means and what makes it comparable with My Team's.
    const floorPitch = Math.ceil(Math.max(headW, valueMin)) + statPad;

    // The VIEWPORT's width, not the table's. The table is exactly as wide as its columns say, so asking it for the room is asking the columns how wide the columns should be - and once the sum exceeds the viewport it stops shrinking and starts overflowing, which is how a 1267px table came to sit in a 1143px box with its own width reported as the room it had.
    const viewport = table.closest('.graph-viewport') || container;
    // clientWidth INCLUDES the viewport's own padding, and the table is laid out inside it - sizing to the former left the table 24px wider than the box it sits in, which is a scrollbar for exactly the padding.
    const viewportCs = getComputedStyle(viewport);
    const room = viewport.clientWidth
        - parseFloat(viewportCs.paddingLeft) - parseFloat(viewportCs.paddingRight);
    const pitch = Math.min(Math.max(Math.floor((room - shared) / n) - tighten, floorPitch), cap);

    // Below the floor the TEXT columns yield, and only then does anything scroll. Name first, since it has the most to give and already truncates with the full value on hover; then Team. The deficit is what the row is over by once the categories are at a width that will not clip.
    let deficit = Math.max(0, shared + n * pitch - room);
    if (deficit > 0 && nameHead && nameFull > nameMin) {
        const give = Math.min(deficit, nameFull - nameMin);
        table.style.setProperty('--pl-name-w', (nameFull - give) + 'px');
        deficit -= give;
    }
    if (deficit > 0 && teamHead && teamFull > teamMin) {
        const give = Math.min(deficit, teamFull - teamMin);
        table.style.setProperty('--pl-team-w', (teamFull - give) + 'px');
    }

    table.style.setProperty('--pl-stat-w', (pitch - statPad) + 'px');
}

// Raw single-player weekly responses kept for the Diagnostic Data panel only, keyed by player id for the session. Small (one player's game logs), unlike the bulk warm-up's full-pool response, which is 50MB+ and deliberately never retained - that size difference is the whole reason the drill-down diagnostic has to be captured per player rather than sliced out of the bulk payload.
const playerDetailDiagnostics = {};
let detailDiagnosticInFlight = false;

// The drill-down's own weekly fetch (openPlayerDetail below) is skipped whenever the leaderboard's bulk warm-up already cached that player - which, since the warm-up runs on load, is virtually always. Its setDebugContext call went with it, so the Player Detail Schema panel sat permanently empty and the download button (the tool for checking rendered stats against real published stat lines) had nothing to save. Rather than make every drill-down pay for a redundant fetch, capture lazily: only when someone actually OPENS the panel on a drill-down that has nothing captured. One on-demand call, cached per player for the session, so reopening is free.
export async function ensurePlayerDetailDiagnostic() {
    const playerId = AppState.selectedPlayerId;
    if (playerId == null || hasDebugContext('player-detail') || detailDiagnosticInFlight) return;

    const cached = playerDetailDiagnostics[playerId];
    if (cached) {
        setDebugContext('player-detail', cached);
        return;
    }

    // Captured for the same discard rule the pool and bulk fetches use - this fetch has the same hole. A league/year switch mid-flight means the response describes a season nobody is looking at any more, and processCoreData has already closed the drill-down it was for.
    const apiDataRef = AppState.apiData;

    detailDiagnosticInFlight = true;
    setDebugLoading('player-detail', true);
    try {
        const raw = await fetchPlayerWeeklyStats(playerId);
        if (AppState.apiData !== apiDataRef) {
            // Wrong league/season now, so don't cache it (the cache is keyed by player id, and the same player's payload differs per season) and don't show it.
            setDebugLoading('player-detail', false);
            return;
        }
        // Still this league, so the payload is genuinely this player's and worth caching even if the user has since moved to a different player - but only show it if it's still the player on screen, or the panel would label one player's raw data with another's name.
        playerDetailDiagnostics[playerId] = raw;
        if (AppState.selectedPlayerId === playerId) setDebugContext('player-detail', raw);
        else setDebugLoading('player-detail', false);
    } catch (err) {
        // Diagnostics are best-effort. Fall back to the existing "nothing captured" placeholder rather than disturbing the drill-down itself, which is already rendered and fine.
        setDebugLoading('player-detail', false);
        console.error('Failed to capture the player detail diagnostic:', err);
    } finally {
        detailDiagnosticInFlight = false;
    }
}

// preserveView is true when main.js is reopening the SAME player after a "Fetch Data" refresh - comparing against AppState.selectedPlayerId to detect that doesn't work, since processCoreData() (called by the fetch, before this runs) already wipes it to null, making every reopen look like a switch to a new player. An explicit flag from the caller, which still remembers the pre-fetch player id, is the only reliable signal.
export async function openPlayerDetail(playerId, preserveView = false) {
    if (!AppState.playerData.some(p => p.id === playerId)) return;
    const sport = AppState.loadedSport;

    // Only reset the drill-down's own view state (selected stat, rank pool, breakdown open/ closed) when switching to a genuinely different player - reopening the SAME player should keep showing whatever the user had selected instead of silently snapping back to the default "Matchup Score" view.
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
    // Point the Diagnostic Data panel at THIS player immediately - even before the fetch below resolves (or even if it's skipped entirely because this player's weekly data is already cached), so the panel always matches the drill-down that's actually on screen. Seeding from the diagnostic cache (null when this player was never captured) is what drops the PREVIOUS player's payload. Leaving it would show one player's raw data under another's drill-down, the same right-label-wrong-data mismatch the 3-context split was built to end.
    setDebugContext('player-detail', playerDetailDiagnostics[playerId] || null);
    setActiveDebugKind('player-detail');

    // A bulk-cached entry carries no dailyByPeriod unless the pool path decided this player needed one, so the Day axis has to ask for it. Fetching one player's own history is what this branch already does when nothing is cached; this widens the condition rather than adding a path ( trap: the days come on demand, one player at a time, never pool-wide).
    const cached = AppState.playerWeeklyCache[playerId];
    if (!cached || !cached.dailyByPeriod) {
        try {
            const raw = await fetchPlayerWeeklyStats(playerId);
            playerDetailDiagnostics[playerId] = raw;
            setDebugContext('player-detail', raw);
            AppState.playerWeeklyCache[playerId] = processPlayerWeeklyHistory(raw, sport);
        } catch (err) {
            // Only fatal when there was nothing cached to fall back on. A player who already has weekly data keeps their chart on a matchup axis rather than losing the drill-down because the day-level refetch failed.
            if (!cached) {
                detailContainer.innerHTML = `<div class="player-loading">Couldn't load this player's history: ${err.message}</div>`;
                return;
            }
        }
    }

    // Looked up AFTER the weekly-cache fetch above (rather than at the top of this function) so that if the shared timeframe is a windowed one, getEffectivePlayerPool can already find this player's just-cached weekly data instead of excluding them for not having it yet.
    const player = getEffectivePlayerPool(sport).find(p => p.id === playerId);
    if (!player) {
        // The season pool has this player (guarded at the top), but the EFFECTIVE pool for the current windowed timeframe does not (no weekly data in range even after the fetch above). Don't leave the half-open "Loading player history" container stranded on screen - fall back to the leaderboard so the tab never sits on a blank drill-down ( audit: no caller, including the post-fetch reopen, can strand a stale detail view through this exit).
        closePlayerDetail();
        return;
    }
    renderPlayerDetail(player);

    // Capture for THIS player right away if the panel is already expanded. main.js's hook only fires on toggle, so without this, someone comparing several players with the panel left open (exactly the stat-checking workflow this diagnostic exists for) would see the empty placeholder on every switch until they collapsed and reopened it. An ordinary drill-down with the panel collapsed still costs nothing.
    if (document.getElementById('debug-panel')?.open) ensurePlayerDetailDiagnostic();
}

export function closePlayerDetail() {
    AppState.selectedPlayerId = null;
    document.getElementById('player-detail-container').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'flex';
    document.getElementById('player-toolbar').style.display = 'flex';
    // Back to the leaderboard - the Diagnostic Data panel switches back to the pool context (already fetched/cached, so this just re-shows it - no new fetch needed).
    setActiveDebugKind('player-pool');
}

// Same scored/advanced split used everywhere else, scoped to whichever group tab this player's detail view was opened from (AppState.playerGroup) rather than their own primary role - a two-way player opened from the Pitchers tab should see pitching stat options, even though their primary position may make them a "batter."
function statIdsForPlayer(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = sport === 'flb' ? PITCHING_IDS : (sport === 'fhl' ? GOALIE_IDS : new Set());
    const wantPitchers = AppState.playerGroup === 'secondary';
    const roleIds = Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(roleIds, statMap);
    // ESPN's raw FPTS (id 19) is a generic/universal points formula unrelated to this league's real scoring settings (see the comment on computeRotoRanks) - excluded entirely rather than offered as a selectable stat. "Weekly Score" (added in renderPlayerDetail) replaces it.
    const withoutFpts = deduped.filter(id => statMap[id] !== 'FPTS');
    const withData = withoutFpts.filter(id => Object.values(weekly).some(w => w[id] !== undefined) || player.seasonTotals[id] !== undefined);

    return splitScoredAdvanced(withData);
}

// A few players immediately above/below this player in a rank list, for the rank chip's hover dropdown - "ranked" is already sorted best-to-worst. `ranks` (aligned with `ranked`) carries tie-aware competition ranks when the caller has them (computeStatRank's stat chips - see its own comment); the Rank chips omit it and fall back to plain positional rank, since averaged Roto scores are continuous and effectively never tie.
function getRankNeighbors(ranked, playerId, ranks = null, windowSize = 3) {
    const idx = ranked.findIndex(p => p.id === playerId);
    if (idx === -1) return [];
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(ranked.length, idx + windowSize + 1);
    return ranked.slice(start, end).map((p, i) => ({ player: p, rank: ranks ? ranks[start + i] : start + i + 1 }));
}

// poolKey identifies which comparison pool this chip represents ('Overall' or a position code) - clicking a chip sets AppState.playerDetailRankPool to it, so the breakdown below can explain THAT pool's math instead of always defaulting to Overall - answers "why is my position score different from Overall" by letting you see the actual different peer group and percentiles.
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

// Overall rank (against every same-role player) plus one rank per position this player is eligible for (against only that position's peers, same scoping as the leaderboard's rankPool) - a multi-position player's value can look very different position by position (a different, smaller comparison pool naturally produces different percentiles per category), so showing only one number would hide that. Click a chip to see that exact pool's math in the breakdown.
function buildRankChipsHtml(player, sport) {
    // Points leagues rank too, since, and the drill-down was still the one surface that assumed they did not. The leaderboard showed a rank and opening the same player showed no chips at all. Same chips, same scoping, ranked by fantasy points instead of category percentiles.
    const wantPitchers = AppState.playerGroup === 'secondary';
    const pitcherPositions = PITCHER_POSITIONS[sport] || new Set();
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeLeagueRanks(samePool, sport);
    const chips = [buildRankChipHtml('Overall', overallRoto, player)];
    // For a two-way player, only show chips for the positions relevant to the CURRENTLY viewed group - a batting-position chip while viewing them as a pitcher (or vice versa) would compare their wrong-role stats against the wrong-role pool.
    const relevantPositions = player.eligiblePositions.filter(pos => pitcherPositions.has(pos) === wantPitchers);
    relevantPositions.forEach(pos => {
        const posPool = samePool.filter(p => matchesPositionFilter(p, pos));
        // Skip a positional chip whose pool IS the group pool - it would just restate Overall. This is hockey goalies today. The Goalies group is the single G position, so ranking goalies "vs G" and "vs the group" compare the same players. Guarding on pool identity, not a hardcoded 'G', keeps the useful cases. A baseball SP pool is a strict subset of the pitcher group (RP-only arms excluded), so it stays, and any future one-position group inherits this. posPool is always a subset of samePool (it's filtered from it), so equal size means equal set.
        if (posPool.length === samePool.length) return;
        chips.push(buildRankChipHtml(pos, computeLeagueRanks(posPool, sport, pos), player));
    });
    return chips.filter(Boolean).join('');
}

// WHY a player has no rank, in the same terms the engine decided it. Returns 'no-games', 'below-minimum', or null when neither applies and the honest answer is to say nothing. The two are genuinely different states and were being shown as one silence. Zero games in the selected window is an absence of evidence - the timeframe can produce it for anyone, an IL week at Current included - and no score exists. Under the minimum but PLAYED is a leaderboard display filter doing its job, and a real score exists behind it. Measured on games played, not on the shrinkage workload, because games played is what the engine gates on (see computeRotoRanks: the threshold measure is role-neutral, the shrinkage measure is not). Null when nobody in the pool has played at all, which is a preseason board ranking on projections rather than an unranked player.
function unrankedReason(player, poolPlayers, sport) {
    const maxGames = Math.max(0, ...poolPlayers.map(p => gamesPlayedOf(p, sport)));
    if (maxGames <= 0) return null;
    const own = gamesPlayedOf(player, sport);
    if (own === 0) return 'no-games';
    return own < maxGames * MIN_PLAYING_TIME_FRACTION ? 'below-minimum' : null;
}

// Explains exactly how the currently-selected rank chip's score is built, category by category - every number in the table is derived from the two values shown right above it (Raw %ile and the Playing-Time Factor), via the formula spelled out in the caption, so nothing is a mystery number. Open by default since seeing this IS the point of the feature.
function buildRankBreakdownHtml(player, sport) {
    // A points rank is one sum, not an average of category percentiles, so there is no per-category math to justify. The chips above still carry the ranks and their neighbours.
    if (AppState.isPointsLeague) return '';
    // Which role's breakdown to show - keyed off the currently viewed group tab, not this player's own primary position, so a two-way player opened from the Pitchers tab gets the pitching breakdown even though their primary role may be "batter".
    const isPitching = AppState.playerGroup === 'secondary';
    const roleLabel = (GROUP_LABELS[sport] || GROUP_LABELS.flb)[isPitching ? 'secondary' : 'primary'];
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitching));

    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    // Only RP matches by primary role instead of eligibility (see matchesPositionFilter) - SP uses plain eligibility, same as every other position filter. SP also does NOT share RP's games-played workload basis (see computeRotoRanks' own comment for why an eligibility-based SP pool can't rely on games played the way a role-pure RP pool can).
    const isRpPool = selectedPool === 'RP';
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;

    // RP skips shrinkage entirely and compares K as K/9 instead of a raw total - see computeRotoRanks' own comment for why. Every other pool (including SP) uses the same innings-pitched/games-played workload measure computeRotoRanks does.
    const { rows, excluded, shrink, avg, qualifiedCount } = computeCategoryBreakdown(player, poolPlayers, sport, selectedPool);
    if (rows.length === 0) return '';

    // Label the pool with the QUALIFIED count the score was actually computed against (players clearing the min-games threshold), not the full eligible pool - the percentiles below are "of" this pool, so citing the larger group made them irreconcilable.
    const poolCount = qualifiedCount.toLocaleString();
    const poolDescription = isPositionPool
        ? `${poolCount} qualified ${selectedPool}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}`
        : `${poolCount} qualified ${roleLabel}`;

    // No games in this window means no score exists, and the table below stops pretending one does. Shrinkage at a 0% factor pins every Adjusted cell to exactly 50, so what shipped was a column of identical constants averaging to a "Rank Score = 50.0" that was the pin, not a result - a number the leaderboard itself refuses to rank the player by. The PERCENTILES stay, because they are real and worth reading, since no errors genuinely does beat most of the pool.
    const reason = unrankedReason(player, poolPlayers, sport);
    const noRank = reason === 'no-games';

    const workloadLabel = (sport === 'flb' && isPitching) ? 'innings pitched' : 'games played';
    const shrinkPct = (shrink * 100).toFixed(0);
    const rowsHtml = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.name)}${r.inverse ? ' <span title="Lower is better for this category">&darr;</span>' : ''}</td>
            <td>${formatBreakdownValue(r.value)}</td>
            <td>${r.rawPct.toFixed(1)}</td>
            ${noRank ? '' : `<td>${r.adjPct.toFixed(1)}</td>`}
        </tr>
    `).join('');
    const excludedHtml = excluded.length
        ? `<div class="rank-breakdown-excluded"><strong>Excluded</strong> (no real opportunity): ${excluded.map(e => escapeHtml(e.name)).join(', ')}</div>`
        : '';
    // One tight line per concept, no formula dump - the table right below demonstrates the actual math, these bullets only say what each column means.
    const adjustedExplainer = isRpPool
        ? `<strong>Adjusted</strong> = Percentile: RP skips the Playing-Time Factor (innings aren't comparable between true relievers and spot-starting swingmen), and K is compared as K/9.`
        : `<strong>Adjusted</strong> = Percentile pulled toward 50 by a <strong>${shrinkPct}% Playing-Time Factor</strong> (${workloadLabel} vs the pool leader's).`;

    // The mechanics essay belongs to the ranked case. With no games there is no Playing-Time Factor worth describing (it is zero, and describing what a zero multiplier does to a percentile is the exact sentence that made the old table read as self-contradictory), and no average to define. What replaces both is the one fact the reader came for.
    const timeframeWords = isFullSeasonTimeframe() ? 'this season' : 'this timeframe';
    const mechanicsBullets = noRank
        ? `<li><strong>Unranked</strong>: no games played in ${timeframeWords}, so there is no Rank score to build. The percentiles are still real - they are where a line of no production places against the pool.</li>`
        : `<li>${adjustedExplainer}</li>
           <li><strong>Rank Score</strong> = average of the Adjusted column.</li>`;

    // Under the minimum but PLAYED is the opposite case and needs the opposite treatment. The score is real, shrinkage having already discounted the small sample, so it is shown in full. The note exists because the leaderboard's own filter hides this player from the list view, and arriving here from My Team without that explanation reads as a bug. Gated on the toggle as well as the reason. With Minimum Games Played off, a thin-sample player IS in the list view, and a note saying otherwise would be the new wrong sentence.
    const belowMinimumNote = (reason === 'below-minimum' && AppState.requireMinPlayingTime)
        ? `<div class="rank-breakdown-note">Below the leaderboard's minimum: ${gamesPlayedOf(player, sport)} games played, under the
           ${Math.round(MIN_PLAYING_TIME_FRACTION * 100)}% of the pool leader's that the list view requires - which is why this player is not in it.
           The score above is built the ordinary way, with the Playing-Time Factor discounting the small sample.</div>`
        : '';

    const summary = noRank
        ? `Why <strong>${escapeHtml(selectedPool)}</strong> has no Rank score`
        : `How the <strong>${escapeHtml(selectedPool)}</strong> Rank score (${avg.toFixed(1)}) is totaled`;

    return `
        <details class="rank-breakdown"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
            <summary>${summary}</summary>
            <ul class="rank-breakdown-explain">
                <li>Compared against <strong>${escapeHtml(poolDescription)}</strong>${isFullSeasonTimeframe() ? '' : ' (selected timeframe)'}.</li>
                <li><strong>Percentile</strong> = share of that pool this Value beats (&darr; = lower is better).</li>
                ${mechanicsBullets}
            </ul>
            <table class="rank-breakdown-table">
                <thead><tr><th>Category</th><th>Value</th><th>Percentile</th>${noRank ? '' : '<th>Adjusted</th>'}</tr></thead>
                <tbody>${rowsHtml}</tbody>
                ${noRank ? '' : `<tfoot><tr><td colspan="4">Rank Score = ${avg.toFixed(1)}</td></tr></tfoot>`}
            </table>
            ${belowMinimumNote}
            ${excludedHtml}
        </details>
    `;
}

// Re-renders the currently-open player detail view (chart, rank chips/breakdown) in place - a no-op if no player is open. Called when the shared AppState.timeframe changes (see handleTimeframeChange in controls.js), since the detail view no longer has its own separate timeframe control to trigger this itself.
export function refreshOpenPlayerDetail() {
    if (!AppState.selectedPlayerId) return;
    const sport = AppState.loadedSport;
    // openPlayerDetail always caches weekly data for whoever it opens (regardless of which timeframe was active then), so a currently-open player is guaranteed to be found here.
    const player = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    if (player) renderPlayerDetail(player);
}

function renderPlayerDetail(player) {
    const container = document.getElementById('player-detail-container');
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { weekly = {} } = AppState.playerWeeklyCache[player.id] || {};

    // AppState.maxCompletedWeek reflects the LEAGUE's own matchup schedule, which can end well short of the real season (a league whose matchupPeriods only covered the first 25 real days while a player's own game logs ran past day 100) - use whichever is actually larger so "Regular Season + Playoffs" and the percentage lookbacks below don't silently cut off real weeks of this player's data just because the league stopped defining matchups.
    const effectiveMaxWeek = Math.max(AppState.maxCompletedWeek, 0, ...Object.keys(weekly).map(Number));

    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const statOptions = visibleIds.map(id => ({ id, name: statMap[id] }));
    // Category leagues get our own computed Weekly Score as a selectable trend, in place of ESPN's removed FPTS - points leagues already have a real per-week points total via appliedTotal, so there's nothing to replace there. Named for the league's own timeline unit. This is our synthetic per-period score, and in roto each period is a real week, so "Matchup Score" put a matchup token on a screen whose axis and tooltips both read WK/Week.
    if (!AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_RANK_STAT_ID, name: `${axisUnit().long} Score` });
    // A points league's headline number IS its points, so that trend leads the picker and, being first, is what a freshly opened drill-down shows. The individual categories behind it stay selectable underneath.
    if (AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_POINTS_STAT_ID, name: `${axisUnit().long} Points` });

    // At Current the synthetic score leads with the one thing the Day axis cannot draw. Matchup Score and Points are scored per PERIOD against the pool, so a single day has no meaning for them and they keep the matchup axis, which at Current is one point. Leading with one there lands every drill-down on exactly the flat line this work exists to remove, so a real category leads instead. The score stays in the picker, one selection away.
    const dayLens = parseTimeframe(AppState.timeframe).window === 1;
    const synthetic = new Set([WEEKLY_RANK_STAT_ID, WEEKLY_POINTS_STAT_ID]);
    const preferred = dayLens ? (statOptions.find(s => !synthetic.has(s.id)) || statOptions[0]) : statOptions[0];
    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || preferred;
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    const rankChipsHtml = buildRankChipsHtml(player, sport);
    const rankBreakdownHtml = buildRankBreakdownHtml(player, sport);
    // Chips are absent whenever the engine will not rank this player, and absence was the whole of what the header said about it. The owner clicked through from My Team and found the rank row gone, with a breakdown below it totalling 50. A named state costs one line and answers the question the missing chips raised. Silent when no reason can be given, since "unranked for reasons we cannot name" is worse than the space it would take.
    const unrankedHtml = (() => {
        if (rankChipsHtml || AppState.isPointsLeague) return '';
        const wantPitchers = AppState.playerGroup === 'secondary';
        const groupPool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
        const reason = unrankedReason(player, groupPool, sport);
        if (!reason) return '';
        // Two labels, because they are two states. No games means no score exists. Below the minimum means one does and the list view filters it out, so calling that "unranked" over a breakdown that totals a real number would be the next contradiction.
        const [label, words] = reason === 'no-games'
            ? ['Unranked', `No games played in ${isFullSeasonTimeframe() ? 'this season' : 'this timeframe'}, so there is no Rank score to build.`]
            : ['Not on the leaderboard', 'Below the minimum games played, which filters the list view rather than this player - the score below is real.'];
        return `<div class="player-rank-unranked"><strong>${escapeHtml(label)}</strong> &middot; ${escapeHtml(words)}</div>`;
    })();

    // Rank pager for the header. Prev walks UP the currently selected rank pool's ranking (toward #1), Next walks DOWN it - with Overall selected that's the Overall ranking, with a position chip selected it's that position's own ranking. Same pool scoping as buildRankBreakdownHtml, so the pager always agrees with the breakdown shown below it. Omitted entirely (null) when the player isn't ranked in the selected pool. Points leagues walk it too, since gave them a real ranking. The pager needs an ORDER, and "ranked by fantasy points" is as walkable as a percentile average. It was gated off back when they had no ranking to walk, and stayed gated after they got one.
    let pager = null;
    {
        const wantPitchersNav = AppState.playerGroup === 'secondary';
        const navPool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchersNav));
        const selectedPool = AppState.playerDetailRankPool || 'Overall';
        const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
        const poolPlayers = isPositionPool ? navPool.filter(p => matchesPositionFilter(p, selectedPool)) : navPool;
        const ranked = computeLeagueRanks(poolPlayers, sport, isPositionPool ? selectedPool : null);
        const idx = ranked.ranked.findIndex(p => p.id === player.id);
        if (idx !== -1) {
            pager = {
                pool: selectedPool,
                prev: idx > 0 ? { player: ranked.ranked[idx - 1], rank: idx } : null,
                next: idx + 1 < ranked.ranked.length ? { player: ranked.ranked[idx + 1], rank: idx + 2 } : null
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
        // Same "a few players above/below" hover dropdown as the rank chips, just scoped to this one category's own ordering instead of the averaged Rank score - passing the tie-aware ranks so a tied neighbor shows the same shared rank the chip itself does.
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
                ${buildPlayerAvatarHtml(sport, player.id, player.name)}
                <div class="player-detail-name">
                    <h3>${escapeHtml(player.name)}${injuryBadgeHtml(player.injuryStatus)}</h3>
                    <span class="player-detail-meta">${escapeHtml(player.teamName)} &middot; ${escapeHtml(player.positionDisplay)}${injuryLabel(player.injuryStatus) ? ` &middot; <span class="player-detail-injury">${escapeHtml(injuryLabel(player.injuryStatus))}</span>` : ''}</span>
                </div>
            </div>
            <div class="player-detail-tools">
                ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
                ${pagerHtml}
            </div>
        </div>
        ${rankChipsHtml ? `<div id="player-rank-chips" class="player-rank-chips">${rankChipsHtml}</div>` : ''}
        ${unrankedHtml}
        ${rankBreakdownHtml}
        <div id="player-season-stats" class="player-season-stats">${seasonStatsHtml}</div>
        <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:300px; margin-top:8px;"></div>
    `;

    // The headshot uses the same plumbing the roster band does, so a missing or failed image leaves the initials tile rather than a broken glyph ( rollout continues here).
    wirePlayerAvatars(container);
    document.getElementById('player-back-btn').addEventListener('click', closePlayerDetail);

    // preserveView keeps the selected rank pool/stat/breakdown state while walking a ranking, so paging through an SS pool stays an SS-pool walk.
    const prevBtn = document.getElementById('player-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', () => openPlayerDetail(pager.prev.player.id, true));
    const nextBtn = document.getElementById('player-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', () => openPlayerDetail(pager.next.player.id, true));

    // Clicking a rank chip picks which pool's math the breakdown below explains (Overall vs a specific position) - re-render is cheap enough to just redo the whole detail view.
    container.querySelectorAll('.rank-chip').forEach(chipEl => {
        chipEl.addEventListener('click', () => {
            // Only switches which pool the breakdown explains - doesn't force it open. If it's already open it updates in place; if it's closed it stays closed until the user opens it themselves.
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

// "Ranking per week" - replaces ESPN's raw per-week FPTS (removed entirely, see statIdsForPlayer) with our own Roto-style score computed week by week, scoring each real week against the pool's OTHER REAL weeks (see buildWeeklyValueBasis in rank-engine.js) rather than an implied "typical week" - a season-average rate has far less variance than any one real week, which was pinning an everyday player's chart near-100 all season regardless of a real slump (confirmed against a real report, where a known slow starter's chart read flat despite a genuine early-season dip). Skips shrinkage - that corrects for a full SEASON's worth of sample-size noise and doesn't have a sensible single-week equivalent - but DOES apply the same CATEGORY_OPPORTUNITY gating as computeRotoRanks (skip a category entirely for a player with no real opportunity in it, e.g. SV for a starter), since that's a correction for what the category means, not a leniency setting. Peer weekly-value basis for the currently selected timeframe - pool/window selection (the impure part) lives here; the basis math is the engine's buildWeeklyValueBasis. Shared by the drill-down's Matchup Score chart (computeWeeklyRankSeries) and the leaderboard's trend arrows (buildMatchupTrendIcons), so both speak the same math. MIN-GAMES DECISION (see the " min-games decision" test in tests/rank-engine.test.js for the hand-computed evidence). The basis pool is restricted to players clearing the SAME MIN_PLAYING_TIME_FRACTION-of-games threshold computeRotoRanks already uses for its own qualified pool. Real weekly values restore variance, but a part-timer's real weeks are still usually weak ones (limited playing time even on an active day) - leaving them in the pool still put a soft floor under the distribution and blunted a genuinely bad regular's week (the synthetic test pool scored a bad week at 33% with part-timers included vs. a sharper, more diagnostic 0% with them excluded). Comparing a regular's week to OTHER REGULARS' real weeks is the correct peer group for "was this actually a bad week for a player like this."
function weeklyBasisQualifiedPool(samePool, sport) {
    const maxGames = Math.max(0, ...samePool.map(p => gamesPlayedOf(p, sport)));
    if (maxGames === 0) return samePool;
    const threshold = maxGames * MIN_PLAYING_TIME_FRACTION;
    return samePool.filter(p => gamesPlayedOf(p, sport) >= threshold);
}

// COVERAGE RULE. AppState.playerWeeklyCache only holds real weekly data once the leaderboard's bulk fetch (ensureLeaderboardWeeklyDataLoaded) has actually run - on a fresh page load, or right after switching sport/league, it can be empty or only partially filled. Scoring against whatever handful of players happen to be cached so far (rather than the real qualified pool) would silently bias the distribution toward an arbitrary subset instead of falling back cleanly. In practice this fetch is one request covering every missing player at once (not incremental), so coverage is closer to a binary "resolved or not" than a true sliding scale - 0.9 sits comfortably above "just the one player a drill-down happened to fetch individually" and comfortably below "literally 100%, which would never tolerate ESPN legitimately returning no game log for a small handful of the qualified pool."
const WEEKLY_BASIS_COVERAGE_THRESHOLD = 0.9;

// Convert a derived per-week stat map to per-GAME rates for its COUNTING stats, leaving rate stats (already per-opportunity) and a zero-games week unchanged. This is what makes matchup periods of very different length comparable. The day-to-matchup mapping folds every scoring period past the last matchup into that final bucket, so the season's final matchup can carry ~4x the game-days of a normal week (confirmed: ~196 vs ~60 in the NHL cats league). On raw weekly totals that inflated every player's final-period counting stats and pushed ~77% of the pool's trend arrows "up" at once (556 up / 41 down, avg delta +21.7). Per game, a long finals bucket and a normal week compare on the same footing, and a genuinely hot or cold finish still reads hot or cold. This also naturally handles an in-progress week (its per-game rate is over however many games have been played), so the per-game path needs no separate proration.
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
    // Scoped to the current group's role so a two-way player's off-role stats don't leak into this pool's category list - same reasoning as rotoContext.
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
                    // Per-game so a long final-matchup bucket doesn't dominate the distribution.
                    return { stats: perGameCountingStats(cache.weekly[w], games, avgStatIds), games };
                });
            return { id: p.id, seasonTotals: p.seasonTotals, weeks };
        });
        const categoryRates = buildWeeklyValueBasis(weeklyValuesByPlayer, { relevantStatIds, inverseStatIds, avgStatIds });
        // Every category came back empty - e.g. a brand-new, single-matchup window with no completed real weeks yet in anyone's cache to build a distribution from. Fall through to the season-average basis below instead of returning an unusable empty result. perGame: true tells the score callers to normalize the scored week the same way; the fallback below stays per-week (season-average), so it reports perGame: false.
        if (categoryRates.length > 0) return { categoryRates, windowStart, windowEnd, perGame: true };
    }

    // Coverage too thin (or the real-value basis came back empty) to trust yet. Kick off the leaderboard's existing bulk weekly-stats fetch if one isn't already running or permanently failed this session - reuses ensureLeaderboardWeeklyDataLoaded/renderPlayerLeaderboard's own lazy trigger and loading state rather than standing up a second fetch path here. This is fire-and-forget: its own completion re-renders the LEADERBOARD (not an open drill-down), so a chart opened while coverage is still thin keeps showing the fallback basis below until the user reopens it - acceptable degradation for what should be a rare, early-session window.
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
        // Score against the same units the basis was built in, per-game for the value basis, raw per-week for the season-average fallback.
        const games = (weeklySums[w] && weeklySums[w].games) || 0;
        const stats = perGame ? perGameCountingStats(weekly[w], games, avgStatIds) : weekly[w];
        const score = scoreWeekAgainstBasis(player, stats, categoryRates);
        if (score !== null) scores[w] = score;
    });
    return scores;
}

// How much a weekly Matchup Score has to move off the player's own average (in percentile points) before it counts as a real trend rather than ordinary week-to-week noise.
const TREND_THRESHOLD = 10;

// Below this fraction of the current matchup elapsed, no arrows are shown at all - a single hot or cold day prorates into a wild full-matchup pace that isn't a trend yet. 0.25 is roughly "two days into a normal 7-day matchup."
const MIN_TREND_FRACTION = 0.25;

// Weekly-form arrows for the leaderboard's Rank column. It compares each player's Matchup Score in the window's final matchup against their own average score across the window - clearly above average trends up (green), clearly below trends down (red), anything within TREND_THRESHOLD shows nothing. Uses the exact same scoring basis as the drill-down's Matchup Score chart (buildWeeklyRateBasis). Players without cached weekly data (the background fetch in renderPlayerLeaderboard hasn't finished yet), without a score in the final matchup (didn't play), or without at least one other scored week to average, get no arrow. Every week's score is per-GAME (see perGameCountingStats / buildWeeklyRateBasis), so a matchup that spans more real days than a normal week - the season's final bucket especially, which folds several calendar weeks of scoring periods into it - no longer inflates the latest score against the window average. The busiest-day-count guard below still runs, but now only to suppress a barely-started IN-PROGRESS final matchup (too small a sample for a reliable per-game rate); per-game handles the scaling itself, so there's no proration fraction fed into the score.
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
    // Suppress arrows only when the final matchup is barely underway (a live day-1/2). A completed season's final bucket has as many or more game-days than a normal week, so this passes.
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
            // One line sharing the legend row's vocabulary ("above/below average") so the arrow, the legend, and the color read as one system. It names the matchup the arrow describes and appends the latest-vs-window-average numbers that set the direction, nothing else. The old copy ("... vs your 8.1 average (matchups 1-15)") leaned on a matchup range and a unitless score the viewer was never introduced to.
            tip: `${delta > 0 ? 'Above' : 'Below'} average in matchup ${windowEnd} (${latest.toFixed(1)} vs ${avg.toFixed(1)})`
        });
    });
    return icons;
}

// The Day-axis series for the drill-down, or null when this is not the Current pill. Null is the signal to leave everything else alone. Every other timeframe keeps its matchup axis, and a Current window that cannot be resolved to real days (no schedule map, no daily sums, a season that has not started) falls back to the matchup axis rather than drawing nothing. The line stops at TODAY, not at the matchup's last day. Extending it flat to the right would claim a week is over when it is Wednesday, and the race cards already end where the data ends.
function buildDayAxisSeries(player, stat, tfStart, tfEnd, isWeeklyRank, isWeeklyPoints) {
    // Current is the one-wide WINDOW, not a span of its own. The pill's value is `<span>+last1` and it reads "Current" only because n is 1 (see rebuildTimeframeOptions). Testing for a span named "current" matches nothing and silently leaves the whole feature off.
    if (parseTimeframe(AppState.timeframe).window !== 1) return null;
    // Neither of these is a per-day quantity. The rank score is computed against a pool over a whole period, and points are a weighted sum of a bucket; both keep the matchup axis.
    if (isWeeklyRank || isWeeklyPoints) return null;

    const sport = AppState.loadedSport;
    const daily = AppState.playerWeeklyCache[player.id]?.dailyByPeriod;
    if (!daily) return null;

    // The matchup being shown is whatever the Current bounds resolved to, so a completed season correctly lands on its final matchup rather than on nothing.
    const matchup = tfEnd || tfStart;
    const periods = periodsOfMatchup(matchupPeriodMap(), matchup);
    if (periods.length < 2) return null;

    const today = Number(AppState.apiData?.scoringPeriodId) || 0;
    const upTo = today ? periods.filter(p => p <= today) : periods;
    const shown = upTo.length >= 2 ? upTo : periods;

    const series = aggregateDailyCumulative(daily, shown, sport);
    const values = series.map(d => {
        const v = d.totals[stat.id];
        return v === undefined ? 0 : Number(v);
    });
    // Every day empty means this player did nothing in the matchup. A flat zero line is honest but useless, and the matchup axis at least shows the surrounding weeks.
    if (!series.some(d => d.played)) return null;
    return { days: series, values, matchup };
}

function drawPlayerTrendChart(player, stat, weekly, maxWk) {
    const container = document.getElementById('player-trend-chart');
    const sport = AppState.loadedSport;

    // weekly is already keyed by fantasy week (matchupPeriodId) and summed/averaged per stat - the day-to-week rollup happened once in processPlayerWeeklyHistory, using the league's own schedule mapping. maxWk is the EFFECTIVE max week (see renderPlayerDetail), not AppState.maxCompletedWeek directly - a league whose own matchup schedule ends well before the real season does would otherwise cut "Regular Season + Playoffs" off early and hide real weeks of this player's own data.
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, maxWk, AppState.regSeasonWeeks, AppState.currentMatchup);
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const isWeeklyPoints = stat.id === WEEKLY_POINTS_STAT_ID;

    // At Current, and only at Current, the axis becomes DAYS of the matchup being played. One matchup on a matchup axis is a single point, which is the "mostly straight lines" the owner reported; the same window across its own scoring periods is a real progression.
    const dayAxis = buildDayAxisSeries(player, stat, tfStart, tfEnd, isWeeklyRank, isWeeklyPoints);

    const weeks = dayAxis
        ? dayAxis.days.map(d => d.index)
        : Object.keys(weekly).map(Number).filter(w => w >= tfStart && w <= tfEnd).sort((a, b) => a - b);
    const weeklyRankScores = (!dayAxis && isWeeklyRank) ? computeWeeklyRankSeries(player, sport, weekly, weeks) : null;
    const actualValues = dayAxis ? dayAxis.values : weeks.map(w => {
        if (isWeeklyRank) return weeklyRankScores[w] ?? 0;
        // The weekly cache keys raw stat sums by matchup, so this is the same weighted sum the rank uses, evaluated one matchup at a time.
        if (isWeeklyPoints) return pointsForStatBucket(weekly[w]);
        return (weekly[w] && weekly[w][stat.id]) || 0;
    });
    // Day N, the vocabulary the race cards already use. axisUnit stays untouched. It names matchup and week axes, and this is neither.
    const labelFor = dayAxis ? (i) => `Day ${i + 1}` : formatMatchupLabel;

    const isRateStat = (AVERAGE_STATS[sport] || new Set()).has(stat.id);
    // At any non-full-season timeframe the drilled player comes from getEffectivePlayerPool, whose seasonTotals are the WINDOWED aggregate - so a header reading "Season Total" over them is a number wearing the wrong label. On the matchup axis the lie was self-consistent, since the matchups shown summed to exactly that windowed figure and nothing ever contradicted it; the Day axis broke the coincidence and made it visible.
    const windowed = !isFullSeasonTimeframe();

    // Per-week gap notes (missing weeks at the edges or in the middle of the range) were removed - they were mostly noise once the day-to-week mapping bug was fixed (a real bye/IL week with zero games played would still trigger one, which isn't actually a data problem). The season-total mismatch check below is kept as a real safety net. It only fires when the weeks actually shown don't add up to ESPN's own verified season total, which is a genuine sign something's missing rather than just "this player didn't play that week." The note has no meaning on the Day axis and printed three wrong numbers there. It SUMMED a cumulative series, so an HR hit once and carried forward across four days "added up to" 4, and it compared that against a windowed total labelled Season. The valid integrity check for a day series is that its last value equals the windowed aggregate - both come off the same weeklySums - but that is a different assertion needing different wording, not this.
    const gapNotes = [];
    if (!dayAxis && !isWeeklyRank && !isWeeklyPoints && !isRateStat) {
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
        // Reference line is the mean of the exact weekly scores being plotted - NOT the season Rank score shown on the leaderboard, which is computed by a completely different formula (full-season totals with shrinkage applied) and has no consistent mathematical relationship to a single week's value. Using it here made the reference line look arbitrary and, for some players, sit above literally every plotted week with no explanation. Averaging the same numbers actually on the chart is self-consistent and matches how every other stat's reference line already works in this function.
        avgVal = actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0;
        actualTotal = avgVal;
        avgLabel = `Avg ${axisUnit().long} Score`;
        totalLabel = `Avg ${axisUnit().long} Score`;
    } else {
        // Rate stats (AVG, ERA, etc.) use ESPN's own verified season rate directly for the reference line - no risk of an "average of rates" computation error creeping back in. Counting stats (HR, RBI, etc.) used to divide ESPN's real season TOTAL by weeks.length (the number of weeks with cached data) - but weeks.length can undercount real weeks played when ESPN's own weekly history has a data gap (see the gap-note logic above), while the season total is still the TRUE full-season count. That mismatch inflated the average line well above the actual plotted points for any player with a gap (confirmed: HR/R/RBI reference lines sitting above literally every week's bar). Averaging the exact values being plotted instead guarantees the line can never be inconsistent with the chart it's drawn on, at the cost of not reflecting weeks missing from the cache. Points have no seasonTotals entry to read. The total is what the plotted matchups add up to, which is also the honest figure for a windowed timeframe, where a season number would contradict the chart under it. A cumulative series' LAST point is the window's total already - for a derived rate exactly as much as for a count, since aggregateDailyCumulative rebuilds each day's rate from the components accumulated through it. It equals the windowed seasonTotals by construction; reading the endpoint rather than that field keeps the figure and the line it labels provably the same number.
        let seasonValue;
        if (isWeeklyPoints) seasonValue = +actualValues.reduce((a, b) => a + b, 0).toFixed(1);
        else if (dayAxis) seasonValue = actualValues.length ? actualValues[actualValues.length - 1] : 0;
        else seasonValue = player.seasonTotals[stat.id] || 0;

        actualTotal = seasonValue;
        avgVal = (isRateStat && !isWeeklyPoints) ? seasonValue : (actualValues.length ? actualValues.reduce((a, b) => a + b, 0) / actualValues.length : 0);
        avgLabel = (isRateStat && !isWeeklyPoints)
            ? (windowed ? `Avg, ${axisUnit().plural.toLowerCase()} shown` : 'Season Avg')
            : 'Avg/Matchup';
        if (isWeeklyPoints) totalLabel = `Points, ${axisUnit().plural.toLowerCase()} shown`;
        else if (dayAxis) totalLabel = 'Matchup Total';
        else if (windowed) totalLabel = `Total, ${axisUnit().plural.toLowerCase()} shown`;
        else totalLabel = 'Season Total';
    }
    // A horizontal mean of a monotone cumulative series is noise, and "Avg/Matchup" names an axis this chart no longer has. The Matchup Total alone is the honest header for a day series, so the reference line goes away with its figure rather than being restated as a per-day pace - which would be a fourth number to reconcile against three that are already on screen.
    const showAvgLine = !dayAxis;
    if (!showAvgLine) avgVal = 0;
    const avgDisplay = (isWeeklyRank || isWeeklyPoints) ? avgVal.toFixed(1) : formatStatValue(avgVal);
    // Matchup Score's "total" and "average" are the same single number (the mean of the matchup scores) - showing both labels back to back just duplicated the same value, so only the one reference-line stat is shown for it, matching the single dashed line actually drawn.
    const totalStatHtml = isWeeklyRank ? '' : `<div>${totalLabel}: <strong>${isWeeklyPoints ? Number(actualTotal).toFixed(1) : formatStatValue(actualTotal)}</strong></div>`;
    // Matchup Score is our own computed stat (not an ESPN number), so it's the one chart that needs to explain itself - every other selectable stat is a familiar box-score category.
    const matchupScoreInfo = isWeeklyRank
        ? `<span class="hint" style="margin-left:4px;" tabindex="0" role="button" aria-label="About Matchup Score" data-hint="${escapeHtml(`Scores each ${axisUnit().long.toLowerCase()} from 0 to 100. The player's numbers in every scored category are compared against other ranked players over the same stretch, and those percentiles are averaged. 50 is mid-pack.`)}">ⓘ</span>`
        : '';
    // The heading names the axis under it, so it follows the same swap the tick labels do.
    const trendLabel = dayAxis ? 'Day' : axisUnit().long;
    const avgStatHtml = showAvgLine
        ? `<div style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:var(--chart-avg); border-top:2px dashed var(--chart-avg);"></span> ${avgLabel}: <strong>${avgDisplay}</strong></div>`
        : '';
    const summary = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
            <h4 style="margin:0; font-size:14px; color:var(--text-body); display:flex; align-items:center;">${escapeHtml(stat.name)} - ${trendLabel} Trend${matchupScoreInfo}</h4>
            <div style="font-size:12px; color:var(--text-muted); display:flex; gap:15px; align-items:center;">
                ${totalStatHtml}
                ${avgStatHtml}
            </div>
        </div>
        ${gapNoteHtml}
    `;

    // Render the summary first (and a placeholder for the chart) so the chart's wrapper div gets its real, final flex-computed size before we measure it - a fixed 800x300 viewBox was getting letterboxed (blank margins, data drawn smaller than it needed to be) whenever the container's actual aspect ratio didn't match 800:300.
    container.innerHTML = summary + '<div id="player-trend-svg-wrap" style="flex:1; min-height:0;"></div>';
    const svgWrap = document.getElementById('player-trend-svg-wrap');

    if (weeks.length === 0) {
        svgWrap.innerHTML = '<div class="player-loading">No weekly history for this stat yet.</div>';
        return;
    }

    const svgWidth = Math.max(300, svgWrap.clientWidth || 800);
    const svgHeight = Math.max(180, svgWrap.clientHeight || 300);
    const padding = 45;
    // Include avgVal so the reference line is always guaranteed to land inside the plotted range, never above the top gridline (possible if the weekly-fetched data is missing some games ESPN's season-total endpoint does have - see the day-level history caveats elsewhere in this file).
    const maxVal = getNiceMax(Math.max(...actualValues, avgVal, 0));
    const numWeeks = weeks.length - 1;

    let svgStr = `<svg width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display:block;">`;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        // formatStatValue (not toFixed(1)) - a fixed 1-decimal label was rounding rate stats like AVG down to the point of unreadability (a gridline at.328 displayed as "0.3", making a correctly-plotted.274 point look like it was sitting on/above "0.3").
        const tickVal = maxVal - (i / 4) * maxVal;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${isWeeklyPoints ? tickVal.toFixed(1) : formatStatValue(tickVal)}</text>`;
    }

    // Same dashed playoff-start marker as the team Season Trends graph (see renderTrendGraph in graphs.js), adapted for this chart's x-axis. Weeks here are spaced by ARRAY INDEX, not by week number, since a real bye/IL week can leave a gap in the displayed weeks - so the boundary is placed between whichever two adjacent DISPLAYED weeks straddle the real regular-season/playoffs split, rather than by interpolating raw week numbers.
    if (numWeeks > 0 && AppState.regSeasonWeeks >= tfStart && AppState.regSeasonWeeks < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.regSeasonWeeks);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
        }
    }

    // Second boundary marking where the league's LAST real matchup (championship) concluded (see formatMatchupLabel) - the real MLB season keeps producing stats well after that, so the "+N" labels past it read as "extra season" rather than looking like an unexplained change in numbering. Gated on the season actually being over. maxCompletedWeek alone is the RIGHT boundary once a season has finished, but mid-season it only means "last completed matchup", so this drew a hard divider labelled "End of league season" immediately before the matchup currently being played. While the season runs there is no end to mark, so no divider and no label. The playoff separator above is unaffected - it keys off regSeasonWeeks, a real schedule fact that's true whether or not the season has finished.
    if (AppState.isSeasonOver && numWeeks > 0 && AppState.maxCompletedWeek >= tfStart && AppState.maxCompletedWeek < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.maxCompletedWeek);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="2,2" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${svgHeight - padding + 16}" font-size="10" text-anchor="start" style="fill:var(--text-subtle)">End of league season</text>`;
        }
    }

    // Cap x-axis labels to a fixed max - a label per point crowds together once a full season's worth of matchups is plotted. A constant integer step keeps every gap the same size (a prior version of this rounded label positions to always land exactly on both endpoints, but rounding to the nearest index distributes any leftover as evenly as possible ACROSS every gap instead of concentrating it in one place - which means the gap size itself keeps alternating between two different values for the whole chart, and that reads as inconsistent even though it's the mathematically most-even distribution). Same fixed-step approach as the team-level trend chart (renderTrendGraph in graphs.js) - the last point is force-included even when it doesn't land on the step grid, same as there, so only ONE gap (the very last one) is ever a different size instead of the irregularity being spread throughout.
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
            svgStr += `<text x="${x}" y="${svgHeight - 10}" font-size="11" text-anchor="middle" style="fill:var(--chart-axis)">${labelFor(w)}</text>`;
        }
    });

    // Weekly average reference line, drawn under the data line so individual points still stand out clearly above/below it.
    if (showAvgLine) {
        const avgY = svgHeight - padding - (avgVal / maxVal) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${avgY}" x2="${svgWidth - padding}" y2="${avgY}" stroke-width="1.5" stroke-dasharray="6,4" style="stroke:var(--chart-avg)" />`;
    }

    svgStr += `<polyline points="${actualPts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="2.5" style="stroke:var(--accent)" />`;
    actualPts.forEach(p => {
        // No opponent/matchup info here - a player may have been picked up by this fantasy team partway through the season, so a real matchup that week doesn't necessarily mean the player was actually rostered for it. Showing it without checking real transaction history would be misleading. Points are a scored total, not a rate. One decimal is the precision the league itself shows, and formatStatValue's three would print 26.400 for a 26.4-point matchup.
        const displayValue = (isWeeklyRank || isWeeklyPoints) ? p.value.toFixed(1) : formatStatValue(p.value);
        // labelFor, not axisUnit plus the raw x-value. On the Day axis those x-values are 0-BASED indexes, so the old line read "Matchup 2" over the third day - wrong noun AND off by one. labelFor is what the tick under the point already renders, so the two cannot disagree.
        const pointLabel = dayAxis ? labelFor(p.week) : `${axisUnit().long} ${p.week}`;
        const tooltipText = `${pointLabel}: ${escapeHtml(displayValue)} ${escapeHtml(stat.name)}`;
        // A bigger transparent hit target on top of the small visible dot - r="4" alone is a tiny, hard-to-hover target, especially with many weeks crowded into a narrow chart.
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="4" style="fill:var(--accent); pointer-events:none;" />`;
        svgStr += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent" style="cursor:pointer;" data-tooltip="${tooltipText}" />`;
    });
    svgStr += `</svg>`;

    svgWrap.innerHTML = svgStr;
    attachDataTooltips(svgWrap);
}
