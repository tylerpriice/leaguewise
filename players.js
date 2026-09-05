import { buildPlayerAvatarHtml, wirePlayerAvatars, initialsFor, buildProTeamLogoHtml, buildProTeamCrestHtml, buildTeamCrestHtml } from './images.js';
import { buildLeaderboardRowHtml, buildLeaderboardHeaderHtml } from './leaderboard-row.js';
import { buildPlayerRailHtml } from './player-rail.js';
import { AppState, ESPN_STAT_MAPS, POSITION_MAPS, SLOT_POSITION_MAPS, SECONDARY_GROUP_POSITIONS, PITCHING_IDS, GOALIE_IDS, AVERAGE_STATS, INVERSE_STATS, RATE_COMPONENTS, NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_LABELS, FLEX_SLOTS, FLEX_SLOT_POSITIONS, categoriesMapped, lowerIsBetterIds, STAT_DISPLAY_ORDER } from './state.js';
import { playoffMatchups, densityAcrossMatchups, playoffOutlook, matchupWindow, gamesByProTeamForMatchup, offNightsForMatchup, rosterNightCoverage, openSeatNights } from './schedule-insight.js';
// expectedAppearances is the ONE count of how much season a player has left; the coverage band prices its remainder on the same rule, so the two cannot disagree.
import { expectedAppearances } from './projected-basis.js';
import { windowProjectedLine, windowLineRanks } from './rank-engine.js';
import { leagueMargins, computeMatchupRanks } from './matchup-rank.js';
import { escapeHtml, getNiceMax, setDebugContext, setActiveDebugKind, hasDebugContext, setDebugLoading, getTimeframeBounds, splitScoredAdvanced, percentileVar, attachDataTooltips, statValue, unwrapStats, axisUnit, buildMatchupPeriodMap, scheduledPeriodsOfMatchup, matchupOfPeriod, weekOfPeriod, midPeriodOfWeek, parseTimeframe, injuryBadgeHtml, injuryLabel, playerPoolErrorText, openingSortDir, wirePushPanel, unmappedCategoriesNote, roleIdSetFor, buildLoadingHtml, resolveMyTeamId } from './utils.js';
import { fetchPlayerData, fetchPlayerWeeklyStats, fetchPlayersWeeklyChunk, WEEKLY_CHUNK_SIZE, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchDraftDetail, harvestTransactions, harvestRosters, fetchProTeamSchedules, currentProSchedule, proScheduleAttempted, finalScoringPeriodOf, readPreseasonSnapshot, preseasonSnapshotKeys, writePreseasonSnapshot } from './api.js';
import { buildRosterTimeline, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod } from './roster-timeline.js';
import { seasonState, isPreseason, SEASON_STATE } from './season-state.js';
// One pure helper, for the reason it exists: ESPN collapses a whole column to a filler value out of season, and the leaderboard's rostered share needs the same test the draft board's ADP does.
import { degenerateValue, startingSlotsByGroup, replacementLevel, estimateUnprojected, sumOfEdgesAcross, replacementByGroup, pricingGroupFor } from './draft-engine.js';
import { datesByScoringPeriod, buildProTeamAbbrevs, dayLabelerFor, buildGamePeriodIndex, countProjectedStarts } from './probables.js';
import { snapshotKey, staleKeys, shouldTake, buildSnapshot, preseasonLineFor } from './preseason-snapshot.js';
// phase 1. AppState.retroSeasons does not exist yet (the engine lane lands it later), so this call is guarded at its one use below and renders nothing today - see the comment there.
import { buildSeasonsBandHtml } from './seasons-band.js';
import { projectionPacing } from './projection-pacing.js';
// All ranking/percentile MATH lives in the pure, unit-tested rank engine (see its purity contract; tests in tests/rank-engine.test.html). This file owns the impure half. Choosing pools, reading AppState/DOM, and building the ctx objects the engine functions take.
import {
    IP_STAT_ID, GAMES_PLAYED_IDS, MIN_PLAYING_TIME_FRACTION,
    inningsPitchedOf, opportunityGateFor,
    computeRotoRanks as engineComputeRotoRanks,
    computePointsRanks as engineComputePointsRanks,
    computeCategoryBreakdown as engineComputeCategoryBreakdown,
    computeStatRankInPool, buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis,
    scoreRotoWeek, rotoPointsForCategory, comparePlayerCategories, scoreWeekByCategory,
    perDayAverages, scoreDayAgainstSelf, dayVerdict, typicalDayScore, presentDayScore
} from './rank-engine.js';

const RANK_COLORS = { 1: '#b8860b', 2: '#767676', 3: '#a4581e' }; // gold, silver, bronze
const RANK_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' }; // leaderboard Rank column, top 3 of the current pool

// S41/F1: matchup-rank.js's own reason codes, worded for the surface - the contract states "the surface's wording is the caller's; this module returns the reason code" and gives the too-few-matchups wording verbatim ("Matchup rank needs 4 decided matchups"), which is reused here rather than reworded a second time.
const MATCHUP_RANK_REASON_TEXT = {
    roto: 'This league scores roto, with no weekly matchup for a category to swing.',
    points: 'This league scores points, not categories, so there is no category matchup to swing.',
    'too-few-matchups': 'Matchup rank needs 4 decided matchups.'
};
const WEEKLY_RANK_STAT_ID = '__weeklyrank__';
// The points-league counterpart is fantasy points scored in each matchup. Not an ESPN stat id, and not a stored number either - ESPN publishes appliedTotal for the SEASON only, so a per-matchup figure has to be computed from that matchup's own stat line.
const WEEKLY_POINTS_STAT_ID = '__weeklypoints__';

// The league's own scoring applied to one bucket of weekly stat sums. The weights are the ONE PLAYER'S own, not the league's base table, because a scoring id can be worth one thing to a human and another to a team defence (pointsOverrides). Reading the base table here drew the Texans' season as a flat zero with a 6.0 spike on the four weeks they returned a touchdown - the only defensive ids carrying a base value - against real weekly totals of 8, 5, 7, 12, 12. Taking the table from pointsWeightsFor is also what stops the chart and the rank disagreeing, since that is the table computePointsRanks ranks on. Inert for a league with no slot-specific scoring, which is every baseball and hockey capture measured: the merge hands back the base table unchanged.
function pointsForStatBucket(sums, player, sport) {
    const weights = pointsWeightsFor(sport, matchesPlayerGroup(player, sport, true));
    let total = 0;
    Object.keys(weights).forEach(id => { total += (Number((sums || {})[id]) || 0) * weights[id]; });
    return +total.toFixed(1);
}

// Ranks this player against every other player with real eligibility in the STAT's own role (batters vs batters, pitchers vs pitchers) who has a value for this stat - keyed off which role the stat itself belongs to (PITCHING_IDS), not the player's own primary position, so a two-way player's pitching stats get compared against pitchers and batting stats against batters, both correctly, regardless of which one happens to be their primary role. Ranking math (competition ties, percentile) is the engine's computeStatRankInPool.
function computeStatRank(player, sport, statId) {
    const pitchingIds = roleIdSetFor(sport);
    const isPitcherStat = pitchingIds.has(statId);
    const pool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitcherStat) && p.seasonTotals[statId] !== undefined);
    const inverse = (INVERSE_STATS[sport] || new Set()).has(statId);
    return computeStatRankInPool(pool, player.id, statId, inverse);
}

const GROUP_LABELS = {
    flb: { primary: 'Batters', secondary: 'Pitchers' },
    fhl: { primary: 'Skaters', secondary: 'Goalies' },
    // Football's split is people against team defences, so the primary side has no position word that covers a quarterback and a kicker at once. "Players" is the honest one. Without this row the toggle drew TWO BUTTONS BOTH READING "Players", because the neutral fallback answers for a missing secondary label as well - measured on the real league before this landed.
    ffl: { primary: 'Players', secondary: 'D/ST' }
};

// WHAT TO CALL A GROUP IN A SPORT THIS TABLE HAS NEVER HEARD OF. Not baseball's words. Every one of these lookups used to end in `|| GROUP_LABELS.flb`, so a third sport would have labelled its players "Batters" and offered a "Pitchers" tab - the exact silently-wrong failure the house rules forbid, and it would have looked deliberate. A sport with one role group has no role to name, so the neutral word is the honest one. There is no secondary label because a sport that needs one has to earn it by appearing in the table above, validated the way flb and fhl were. The SINGULAR of the same words, for sentences rather than tab headings ("Overall (as Batter)"). A separate table rather than trimming an "s" off the plural: "D/ST" has no plural to trim and nothing guarantees the next sport's word does either.
const GROUP_ROLE_WORDS = {
    flb: { primary: 'Batter', secondary: 'Pitcher' },
    fhl: { primary: 'Skater', secondary: 'Goalie' },
    ffl: { primary: 'Player', secondary: 'D/ST' }
};
function groupRoleWord(sport, secondary) {
    const words = GROUP_ROLE_WORDS[sport];
    return words ? words[secondary ? 'secondary' : 'primary'] : null;
}

// WHAT "OVERALL" ACTUALLY MEANS FOR A TWO-WAY PLAYER. The chip says Overall and means overall WITHIN THE ROLE YOU ARE LOOKING AT: Ohtani's Overall on the Batters tab is the batting rank with the pitching line discarded, and vice versa. For everyone else those are the same sentence, so the label is only qualified when the player genuinely qualifies in both groups. A LABEL, NOT A NUMBER, and that was the finding. The draft board combines the two roles by SUMMING EDGES OVER REPLACEMENT, which adds because edges are additive and a negative group can be dropped. The Rank is a MEAN of percentiles: two means do not add, and averaging a 75.3 batting with a 66.1 pitching would LOWER a two-way player for being two-way - the exact opposite of the "a second skill never subtracts" rule it would be trying to honour. Measured on the real capture before this was written. So the math stays and the word stops overclaiming.
export function rankPoolLabel(poolKey, roleWord) {
    if (poolKey !== 'Overall' || !roleWord) return poolKey;
    return `Overall (as ${roleWord})`;
}

const NEUTRAL_GROUP_LABELS = { primary: 'Players', secondary: null };
function groupLabels(sport) { return GROUP_LABELS[sport] || NEUTRAL_GROUP_LABELS; }
// Exported - myteam.js kept its own copy of this exact table with only a flb/else branch, which is how a football league's roster tables ended up headed SKATERS and GOALIES (with D/ST filed under GOALIES) on the one table this codebase already validated as Players/D/ST. One function now, this file's own GROUP_LABELS, rather than a second table to keep in step.
export function groupLabel(sport, secondary) {
    return groupLabels(sport)[secondary ? 'secondary' : 'primary'] || NEUTRAL_GROUP_LABELS.primary;
}

// WHICH ROLE GROUPS THIS SPORT HAS, rather than an assumption that there are two. The same derivation draft-view.js has used since it was built (its groupsFor), moved here because the Player tab is where the assumption was still hardcoded: renderGroupToggle drew two buttons unconditionally, so a one-group sport would have shown an empty second tab, and AppState.playerGroup could strand on 'secondary' with nothing in it. SECONDARY_GROUP_POSITIONS is the source of truth because it already says, per sport, which positions form a second pool. A sport absent from it - or with an empty set - is one pool.
export function roleGroupsFor(sport) {
    const secondary = SECONDARY_GROUP_POSITIONS[sport];
    return secondary && secondary.size ? ['primary', 'secondary'] : ['primary'];
}

// The group actually shown, clamped to one this sport HAS. A league switch from baseball to a one-group sport used to leave 'secondary' selected over an empty pool.
export function activeGroupFor(sport) {
    const groups = roleGroupsFor(sport);
    return groups.includes(AppState.playerGroup) ? AppState.playerGroup : groups[0];
}

// THE ONE PLACE TAB STATE BECOMES A GROUP. Everything below this line takes the group as an ARGUMENT; this is the only function that asks what the user is looking at. It used to be answered three different ways, which the audit called the standing bug generator a third sport would multiply - and the codebase's own comments already record two bugs it caused. A hidden default (`wantPitchers = AppState.playerGroup === 'secondary'`) meant a helper called from a loop over BOTH groups silently measured whichever tab happened to be open: the draft board's pitcher pass read the batting games id and 791 of 798 pitchers scored nothing. And rosterRankLookup, which ranks both groups in one pass, worked around that by MUTATING the global and restoring it in a finally - a fix that only holds while nothing else reads the global in between, and which left 6 pitcher ranks against 445 batter ranks the day it did not. So the defaults are gone. A measurement helper that cannot see the group is a helper that cannot be called from a two-group loop by mistake, because it will not compile past review.
export function currentGroupIsSecondary(sport) { return activeGroupFor(sport) === 'secondary'; }

// Group tab membership (Batters vs Pitchers) has to be ELIGIBILITY-based, not based on a player's single PRIMARY role (ESPN's defaultPositionId, still used for the strict RP pool filter - see matchesPositionFilter) - a genuine two-way player (e.g. Shohei Ohtani) has one primary position but real, meaningful stats and eligibility in BOTH roles, and needs to show up - with their own real numbers - in both tabs. The two checks aren't mutually exclusive. A two-way player satisfies both wantPitchers=true and wantPitchers=false, while an ordinary single-role player only satisfies whichever one matches their real role (confirmed against real data. Ohtani was missing from the Pitchers tab entirely, since the primary position - a batting slot - excluded the row regardless of real, substantial pitching stats). Which role group a player belongs to, for surfaces outside the leaderboard that group by role. Eligibility-based like the group tabs, so a two-way player lands in both and the caller decides which section to draw the row in.
export function playerRoleGroups(player, sport) {
    return {
        primary: matchesPlayerGroup(player, sport, false),
        secondary: matchesPlayerGroup(player, sport, true)
    };
}

export function matchesPlayerGroup(player, sport, wantPitchers) {
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
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

// Team breakout tabs. Display-only, the same rule matchesAvailability's own comment states - it decides which rows show, never which players the Rank is computed against, so narrowing to one team never shrinks anyone's "#N of the pool" to a false small-pool number.
function matchesBreakout(p) {
    const b = AppState.playerBreakoutFilter;
    if (!b || b.kind === 'all' || b.id == null) return true;
    if (b.kind === 'fantasy') return p.teamId === b.id;
    if (b.kind === 'pro') return Number(p.proTeamId) === b.id;
    return true;
}

// Outfield is the one case where the SAME real position is represented at two different granularities in ESPN's slot catalog - a generic OF slot (5) vs specific LF/CF/RF (8/9/10) - and which one to show depends on which granularity this league's own roster actually uses. Every other slot (DH, infield positions, pitching roles) describes something real about the player regardless of whether this league happens to roster a dedicated spot for it, so those are always shown when the player is eligible - conflating "no roster slot for this" with "not eligible for this" was the bug (a real DH-capable batter was losing "DH" entirely because these leagues don't have a dedicated DH bench slot).
const OF_SPECIFIC_SLOTS = new Set(["8", "9", "10"]);
const OF_GENERIC_SLOT = "5";
// The generic "P" slot (13) is redundant whenever a player also has the more specific SP (14) or RP (15) - any SP/RP is automatically P-eligible too, so showing "P/SP" doesn't add information. Only fall back to generic "P" for the rare player who has no SP/RP split at all.
const GENERIC_PITCHER_SLOT = "13";
const SPECIFIC_PITCHER_SLOTS = new Set(["14", "15"]);

// Canonical display order - unrecognized names (shouldn't happen given SLOT_POSITION_MAPS) sort after everything else instead of disappearing. HOCKEY'S FOUR ADDED WITH ITS SLOT MAP. While hockey had no slot map every player carried one position and the order never mattered; the moment dual eligibility became visible, LW and RW were both unranked here, tied, and fell back to ESPN's own array order - so the SAME pairing rendered as "LW/RW" on 49 players and "RW/LW" on 4. A display order that depends on the order a payload happened to list two slots in is not an order at all. Centre needed no entry: it shares the string with baseball's catcher and was already first.
const POSITION_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "DH", "P", "SP", "RP",
    "LW", "RW", "D", "G"];

export function computeEligiblePositions(eligibleSlots, slotMap) {
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

// Splits a group's stat ids into "scored" (the stats this league's settings actually use) and "advanced" (everything else ESPN happens to track) so the leaderboard can default to just the categories that matter for this league, with the rest tucked behind a toggle. Role-grouped ordering (orderStatIdsByRole) is deliberately NOT applied here. This list is already filtered to ONE role by the group tab, so every id is in the same group and grouping would be a no-op. Same for statIdsForPlayer below. The mixed-role surfaces that do need it are the heatmap/scoreboard, the category picker, the category-totals export, and the recap. S24: reorders a sport's fixed families (today, just football's kicking ladder) into their own DISPLAY order in place, leaving every other id exactly where numeric order already put it. The family clusters at the position its LOWEST-numbered member already sorted to, so this never moves the block relative to unrelated categories - only its own internal order changes.
function applyFixedOrder(ids, sport) {
    const fixed = STAT_DISPLAY_ORDER[sport];
    if (!fixed) return ids;
    const present = fixed.filter(id => ids.includes(id));
    if (present.length < 2) return ids;
    const anchor = Math.min(...present.map(Number));
    const rank = new Map(fixed.map((id, i) => [id, i]));
    return [...ids].sort((a, b) => {
        const ka = rank.has(a) ? anchor + rank.get(a) / 1000 : Number(a);
        const kb = rank.has(b) ? anchor + rank.get(b) / 1000 : Number(b);
        return ka - kb;
    });
}

function statIdsForGroup(sport, group, groupPlayers) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = roleIdSetFor(sport);
    const inGroup = Object.keys(statMap).filter(id => group === 'secondary' ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = applyFixedOrder(preferScoredDedup(inGroup, statMap), sport);
    const withData = deduped.filter(id => groupPlayers.some(p => p.seasonTotals[id] !== undefined));
    return splitScoredAdvanced(withData);
}

// Real baseball fractional-innings notation -.1 means one out into the inning (1/3),.2 means two outs (2/3), NOT a true decimal (586 outs is "195.1", not "195.333").
function formatInnings(outs) {
    if (outs === undefined || outs === null) return '-';
    return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Defaults to AppState.playerGroup (which tab is currently active) rather than this player's own intrinsic primary role - a tab's callers only ever process players scoped to the current group (via matchesPlayerGroup), so this correctly reads a two-way player's PITCHING games count while the Pitchers tab is active and their BATTING games count while the Batters tab is active, instead of always reading whichever role happens to be their primary one. `wantPitchers` exists because that assumption has one caller it does not hold for: the draft board ranks BOTH groups in a single pass, with the Player tab sitting on whichever group it likes. Left to the default, the pitcher pass read the BATTER games id - which only two-way players carry - so the qualified and candidate pools collapsed to the seven position players who also pitch, and 791 of 798 projected pitchers scored nothing at all. Measured; it looked exactly like a pitching-category bug and was not. NO BASEBALL FALLBACK. This read `GAMES_PLAYED_IDS[sport] || GAMES_PLAYED_IDS.flb`, which for a sport with no entry looks up baseball's id 81 in a line that has no such key - every player zero games, so shrinkage neutralises itself (a maximum workload of zero makes every shrink factor 1), the minimum-games threshold stops excluding anyone, and the ranks still render. Wrong, quietly, which is the one failure mode this codebase's rules single out. NULL is the answer when the sport has no games id, and it is deliberately not zero: zero games is a fact about a player, no games ID is the absence of a measurement, and gamesPlayedKnown below is what lets a caller tell them apart before it ranks anything.
function gamesPlayedOf(p, sport, wantPitchers) {
    const ids = GAMES_PLAYED_IDS[sport];
    if (!ids) return null;
    return p.seasonTotals[ids[wantPitchers ? 'secondary' : 'primary']] || 0;
}

// Whether workload can be measured in this sport at all. A rank built without it is not a rougher rank, it is an unshrunk one with no playing-time floor - so a surface asks this and says it has no ranking rather than showing one nobody can defend.
export function gamesPlayedKnown(sport) { return !!GAMES_PLAYED_IDS[sport]; }

// The shrinkage (VALUE) workload measure. Baseball: games played for batters, real innings pitched for pitchers - see inningsPitchedOf for why appearances don't work as a workload measure ACROSS pitching roles (a true reliever's 35-45+ appearances dwarf a full-time starter's ~14-20, even though the starter is throwing 2-3x the innings and produces far more fantasy value - confirmed against real 2026 data, twice. The unfiltered "all positions" pool letting true relievers like Aaron Ashby/Louis Varland/Brent Headrick/Dylan Lee dominate the top of the ranking ahead of legitimate aces like Cristopher Sanchez and Jacob Misiorowski, and (less obviously) an eligibility-based SP pool's games-based shrinkage leader turning out to be a swingman - Jacob Latz, 33 appearances but only 42 real innings - which crushed every genuine ace's shrinkFactor and flipped Sanchez behind Misiorowski purely from switching from the Overall view to the SP-filtered one. The one pool that could have safely kept games played - RP, which stays strictly primary-role filtered (see matchesPositionFilter) and so never contains swingmen in the first place - uses innings pitched too now anyway, purely for consistency across every pitcher view (see computeRotoRanks). HOCKEY: games played for BOTH skaters and goalies. That whole innings-pitched apparatus exists only because baseball's pitching role splits into SP and RP with wildly non-comparable appearance counts; hockey has no equivalent (every goalie is the same role, every skater is the same role), so games played IS a comparable workload for everyone and there's no reason to reach for time-on-ice. Note id 34 in hockey happens to be GP, so the old inningsPitchedOf path would have read GP/3 for goalies - relative shrinkage would survive that by coincidence, but this is explicit and correct instead of accidentally-not-broken.
function workloadOf(p, sport, wantPitchers) {
    if (sport === 'fhl') return gamesPlayedOf(p, sport, wantPitchers);
    return wantPitchers ? inningsPitchedOf(p) : gamesPlayedOf(p, sport, wantPitchers);
}

// Shared impure→pure adapter. Everything the engine's roto functions need, read once from AppState/league config. relevantStatIds is scoped to the CURRENT group's own role (AppState.playerGroup), not just "does anyone in groupPlayers have this stat defined" - a two-way player (e.g. Ohtani) genuinely has both batting AND pitching stats defined on their own record, so without this, their off-role stats would leak into this pool's categories, with them as the lone player carrying a value there - a single-player "basis" that hands them an automatic 100th percentile in a category no actual peer can be compared on. The two different workload measures are deliberate - see the engine's computeRotoRanks comment (shrinkage = VALUE measure, GP/IP by role; hard exclusion = ACTIVITY measure, games played for everyone). `opts` exists so a caller that is not the leaderboard can say which group it means. The default for both is what this function has always done - read the Player tab's own state - so every existing call site is unchanged.
function rotoContext(groupPlayers, sport, posFilter, opts = {}) {
    const pitchingIds = roleIdSetFor(sport);
    // No fallback to the global. Every caller passes it, which is what makes a two-group loop safe.
    const wantPitchers = !!opts.wantPitchers;
    const requireMinPlayingTime = opts.requireMinPlayingTime === undefined
        ? AppState.requireMinPlayingTime : opts.requireMinPlayingTime;
    return {
        // The sport rides along so the engine's per-category gates and the RP per-nine rule stay baseball's rather than being applied to whatever a third sport numbers 57, 63 or 48.
        sport,
        relevantStatIds: Array.from(AppState.scoredStatIds).filter(id =>
            (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && groupPlayers.some(p => p.seasonTotals[id] !== undefined)),
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        // The averaged (rate) categories, so the engine knows which missing values are a real 0 (counting) versus genuinely absent (rate). players.js owns AVERAGE_STATS - the pure engine takes it via ctx rather than importing state. The engine's pivot for how a MISSING value reads: absent means UNKNOWN here, and zero everywhere else. Rates are the original case, and an estimated category is the other - a player the estimate could not reach has no figure rather than a nil one, and a nil in an inverse category like errors would be the best score on the board. See estimateUnprojected.
        rateStatIds: opts.unknownWhenMissingIds && opts.unknownWhenMissingIds.size
            ? new Set([...(AVERAGE_STATS[sport] || new Set()), ...opts.unknownWhenMissingIds])
            : (AVERAGE_STATS[sport] || new Set()),
        isRpPool: posFilter === 'RP',
        requireMinPlayingTime,
        workloadOf: p => workloadOf(p, sport, wantPitchers),
        thresholdWorkloadOf: p => gamesPlayedOf(p, sport, wantPitchers),
        statMap: ESPN_STAT_MAPS[sport] || {}
    };
}

// S41/O38: a rate category's OWN denominator component ids, generalized off RATE_COMPONENTS (state.js) rather than a second, sport-specific table - matchup-rank.js's contract needs exactly this function (its own `weightIdsFor` ctx field) to weigh a rate shift against a real denominator. A `{ num, den }` entry answers directly (AVG -> at-bats, ERA -> innings pitched). An `{ add }` entry (OPS = OBP + SLG) has no denominator of its own; its FIRST addend that carries one is the right answer - OPS's is OBP's (at-bats, walks, HBP, sac flies), never SLG's narrower one, because every sport's table lists the on-base half first. Matches the O36 acceptance page's own worked example exactly (tests/matchup-rank.fixture.gen.html), generalized rather than restated per sport.
function rateWeightIdsFor(sport, id) {
    const comps = RATE_COMPONENTS[sport] || [];
    const entry = comps.find(c => c.out === id);
    if (!entry) return [];
    if (entry.den) return entry.den;
    if (entry.add) {
        for (const partId of entry.add) {
            const part = comps.find(c => c.out === partId);
            if (part && part.den) return part.den;
        }
    }
    return [];
}

// The impure->pure adapter for matchup-rank.js, the same role rotoContext plays for the engine's roto functions. categoryIds is rotoContext's own relevantStatIds - "the scored ids to measure, already filtered to one player group by the caller" is the O38 contract's own phrase for this exact field, so it is read off rotoContext rather than recomputed.
function matchupRankCtxFor(groupPlayers, sport, wantPitchers) {
    const roto = rotoContext(groupPlayers, sport, null, { wantPitchers });
    return {
        categoryIds: roto.relevantStatIds,
        rateStatIds: roto.rateStatIds,
        inverseStatIds: roto.inverseStatIds,
        weightIdsFor: (id) => rateWeightIdsFor(sport, id)
    };
}

// Replaces ESPN's raw "FPTS" (a generic points formula unrelated to this league's actual scoring settings, and batting-only) with a real Roto-style rank. All method/math lives on the engine's computeRotoRanks - including the full rationale for shrinkage, opportunity gating, the Minimum Games threshold, and the RP pool's special cases.
function computeRotoRanks(groupPlayers, sport, posFilter, wantPitchers, opts = {}) {
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, posFilter, {
        wantPitchers,
        // Carried so the leaderboard can say the same thing the board says about a category ESPN does not forecast (see preseasonBasisOf): skip it, never score it as a zero.
        unknownWhenMissingIds: opts.unknownWhenMissingIds
    }));
}

// The points-league ranking, same call shape as computeRotoRanks so every surface that shows a rank can ask for one without caring which format the league is. Like roto, it ranks exactly the pool it is handed. The caller has already narrowed that to one position when a position filter is on, which is what makes a position rank a rank AMONG that position rather than an overall rank with the others hidden. THE WEIGHTS A GROUP IS ACTUALLY SCORED BY. A league can score the same stat differently depending on the slot a player occupies, and football's team defences are scored ENTIRELY that way: 20 of that league's 46 ids have a base of zero and exist only as a slot-16 override. Read with base weights alone every defence in the league scores a fraction of its real total - measured on the real capture, the best defence came out 42.0 against its true 185.0. The group's own slots decide which overrides apply, so this needs no sport branch: a group with no slot-specific scoring gets the base table it always had.
function pointsWeightsFor(sport, wantPitchers) {
    const base = AppState.scoringWeights || {};
    const bySlot = AppState.scoringSlotWeights || {};
    const slots = wantPitchers ? (SECONDARY_LINEUP_SLOTS[sport] || new Set()) : null;
    if (!slots || !slots.size) return base;
    const merged = { ...base };
    slots.forEach(slot => Object.assign(merged, bySlot[String(slot)] || {}));
    return merged;
}

function computePointsRanks(groupPlayers, sport, wantPitchers) {
    return engineComputePointsRanks(groupPlayers, {
        weights: pointsWeightsFor(sport, wantPitchers),
        workloadOf: p => gamesPlayedOf(p, sport, wantPitchers)
    });
}

// Whichever ranking this league is scored by. One call site instead of an isPointsLeague fork at every surface that wants a rank. wantPitchers IS REQUIRED, deliberately undefaulted. A default of false reads pitchers by the BATTING games id, every pitcher then has zero games, the zero floor refuses to rank them, and a 446-pitcher board comes back with 6 - measured, when the first draft of this commit defaulted it. A silent default is the same failure the hidden global was; making it required is the fix.
function computeLeagueRanks(groupPlayers, sport, posFilter, wantPitchers, opts = {}) {
    return AppState.isPointsLeague
        ? computePointsRanks(groupPlayers, sport, wantPitchers)
        : computeRotoRanks(groupPlayers, sport, posFilter, wantPitchers, opts);
}

// THE PRESEASON BASIS. Before a game is played the leaderboard has nothing to rank: seasonTotals is the CURRENT season's actual line, and in preseason there is not one. The draft board has always handled this - buildBoard hands the engine ESPN's projections under the name seasonTotals - and the leaderboard never learned to, so two surfaces ranked the same players off different lines. THE SYMPTOM IS NOT THE OBVIOUS ONE, which is why this is worth the words. On a league whose draft has not been held the pool carries no lines at all, every score is zero, and the tie-break falls through to ascending player id. But on a FINISHED season rewound to preseason - the only way this can be staged, since the rewind empties the league payload and never the pool - seasonTotals is last season's RESULTS, so the table ranks a preseason league on a completed one and looks entirely credible doing it, one tab away from a banner reading "Nobody has played yet". A board showing zeroes announces itself. That one does not, and it is the failure this removes. BOTH HALVES OF THE BOARD'S SWAP, or the two surfaces still disagree. The line comes from estimateUnprojected, which fills a category ESPN does not forecast out of last season; the ids it could not reach travel on as unknownWhenMissingIds so the ranker SKIPS them rather than reading a missing value as zero - which in an inverse category would be the best figure on the board. A PLAYER WITH NO PROJECTION KEEPS THE ROW AND LOSES THE NUMBERS. The board filters those players out before ranking; the leaderboard shows the whole pool and cannot. An empty line ranks nowhere and prints a dash, which the row contract already carries - a zero would sort an empty row above a real one. PURE: every input is an argument, so the states that matter are stated in a test rather than staged. The caller supplies `preseason` because the season state is AppState's to know.
export function preseasonBasisOf(pool, ctx = {}) {
    if (!ctx.preseason) return pool;
    const { estimateIds = [], rateIds = new Set(), gamesId = null } = ctx;
    return (pool || []).map(p => (hasProjection(p)
        ? { ...p, seasonTotals: estimateUnprojected(p.projectedTotals, p.lastSeasonTotals, estimateIds, { gamesId, rateIds }).line }
        : { ...p, seasonTotals: {} }));
}

// The estimator's unreachable ids, in the shape computeLeagueRanks passes on. Empty outside preseason, where the actual line is the basis and nothing is being estimated at all.
function unknownIdsFor(basis) {
    return basis && basis.preseason ? { unknownWhenMissingIds: new Set(basis.estimateIds) } : {};
}

// The basis context for whichever league is loaded. Separate from the pure function above so the AppState reads happen once per render at the call site rather than per player.
function preseasonBasisCtx(sport, wantPitchers) {
    const preseason = isPreseason(seasonState(AppState.apiData));
    if (!preseason) return { preseason: false };
    return {
        preseason: true,
        estimateIds: estimateSplit().estimated,
        rateIds: AVERAGE_STATS[sport] || new Set(),
        gamesId: gamesIdFor(sport, wantPitchers)
    };
}

// THE DRAFT BOARD'S RANKING CALL. Same engine, same context builder, same math the leaderboard runs - a player's draft value and season rank come out of one place, which is the whole reason the draft tab does not carry a scorer of its own. Two differences, both stated here rather than left to global state: - The GROUP is passed in. The board ranks batters and pitchers in the same pass and cannot borrow AppState.playerGroup, which belongs to whatever the Player tab happens to be showing. - The minimum-games exclusion is OFF. That toggle answers "has this player played enough to be judged", which is a question about evidence; a draft board asks who to pick, and a player projected for few games is a worse pick rather than one to hide. Shrinkage already pulls a thin projection toward the middle, so the honest treatment is to rank low, not to omit.
export function computeGroupRanks(groupPlayers, sport, wantPitchers, opts = {}) {
    if (AppState.isPointsLeague) {
        return engineComputePointsRanks(groupPlayers, {
            weights: AppState.scoringWeights,
            workloadOf: p => gamesPlayedOf(p, sport, wantPitchers)
        });
    }
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, null, {
        wantPitchers,
        requireMinPlayingTime: false,
        unknownWhenMissingIds: opts.unknownWhenMissingIds
    }));
}

// Single-player per-category breakdown of the same math, for the drill-down - see the engine's computeCategoryBreakdown.
function computeCategoryBreakdown(player, groupPlayers, sport, posFilter, wantPitchers) {
    return engineComputeCategoryBreakdown(player, groupPlayers, rotoContext(groupPlayers, sport, posFilter, { wantPitchers }));
}

// isRate is null for every caller that does not know (unchanged behaviour: a fractional value gets 3 decimals, an integer one prints bare). Callers that DO know a stat's own kind pass it explicitly - false forces a whole number even when the value carries fractional noise, which only a PROJECTED counting stat ever does (a real season total is already an integer, so this is a no-op there): ESPN's rest-of-season projection for a counting stat is built from a per-game rate times games remaining, so it lands on a value like 4112.9 passing yards, and the old unconditional "fractional means 3 decimals" rule printed "4112.900" beside a played table's bare integers.
export function formatStatValue(val, isRate = null) {
    if (val === undefined || val === null) return '-';
    const num = Number(val);
    if (!Number.isFinite(num)) return '-';
    if (isRate === false) return Math.round(num);
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
        // LAST season's actuals, off the same payload - the pool already carries them beside this season's. The draft board reads them to estimate the categories ESPN refuses to project, and nothing else does; it costs no request either way.
        const priorSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year - 1);

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
            // Which real team the player is on, which is what decides who the opponent is in a game the schedule lists by home and away id.
            proTeamId: p.proTeamId ?? null,
            // ESPN's own average draft position, off this same payload - no request exists for it and none is made. 0 means ESPN has no position for the player, which is not pick zero, so it reads as absent.
            adp: Number(p.ownership && p.ownership.averageDraftPosition) || null,
            // Same ownership block ADP reads above, no separate request. percentOwned is ESPN's rostered-share as of the payload's own snapshot; percentChange is its own 7-day delta, already computed server-side - nothing here derives it from history.
            rosterPct: Number(p.ownership && p.ownership.percentOwned) || 0,
            rosterChange: Number(p.ownership && p.ownership.percentChange) || 0,
            seasonTotals: unwrapStats(actualSeason && actualSeason.stats),
            projectedTotals: unwrapStats(projSeason && projSeason.stats),
            lastSeasonTotals: unwrapStats(priorSeason && priorSeason.stats),
            appliedTotal: (actualSeason && actualSeason.appliedTotal) || 0,
            // ESPN's own points-per-game-PLAYED. Kept as it arrives, including its absence: see ptsPerGameOf, which is the only reader and explains why a zero is not a zero.
            appliedAverage: (actualSeason && actualSeason.appliedAverage) ?? null,
            projectedAppliedTotal: (projSeason && projSeason.appliedTotal) || 0
        };
    });
}

// MLB/NHL report stats per game DAY (statSplitTypeId 5, one entry per scoringPeriodId), not per fantasy week - there is no single stat line to read for "week 3". H2H leagues get their real matchup boundaries from the schedule itself (see buildMatchupPeriodMap in utils.js), so this function is now only for SEASON-LONG ROTO, which genuinely has none. Its schedule is one degenerate game covering the whole season, matchupPeriodCount is 1, and ESPN never divides it. The Roto Race still needs a time axis, so this defines one, and the only honest way to define it is from something real in the payload. That is status.firstScoringPeriod, the league's own first day: weeks are 7 days counted from there. The previous floor(spid / 7) anchored on nothing at all - it put week boundaries wherever the day number happened to divide by seven, and its max(1,...) clamp silently made week 1 thirteen days long while every other week was seven. This is a display axis, not a league fact, and it is labelled as weeks rather than matchups for exactly that reason (axisUnit reads the league type).
function weekOfScoringPeriod(scoringPeriodId) {
    return weekOfPeriod(scoringPeriodId, AppState.apiData?.status?.firstScoringPeriod || 1);
}

// Regular-season matchups are exactly 1 real week each, but a playoff ROUND can span multiple real weeks (playoffMatchupPeriodLength, e.g. a 2-week Round 1 - confirmed via a real league's own settings: "Weeks In Round 1 Playoff Matchup: 2"). Leaving playoff weeks un-collapsed showed them as several separate, sparse points trailing past the regular season with no clear end, instead of the real, BOUNDED number of playoff matchups the league actually has. What a fantasy manager cares about is "how did this player do in each real matchup" - collapse every real week belonging to the same playoff round into that round's single matchup number, matching how the league itself counts them. The league's OWN completed-games schedule (AppState.maxCompletedWeek, see data.js) is the authoritative signal for how many real playoff matchups exist - simpler and more reliable than guessing a bracket's round count from playoffTeamCount. maxCompletedWeek comes from the TEAM schedule's own matchupPeriodId field there, which is already a real, displayed matchup number (a league with 22 regular-season matchups and two 2-real-week playoff rounds reports matchupPeriodId 23 and 24 as two SEPARATE playoff matchups, not one) - it does NOT need collapsing through playoffLen the way the day-derived `week` argument above does, since it was never a raw day-count in the first place. Cap the computed matchup number at that real last matchup rather than continuing to invent new ones past it. A previous version of this comment/fix wrongly concluded maxCompletedWeek needed the same playoffLen collapsing as `computed` - that was based on a misreading of one league's schedule dump (which happened to have a single-round playoff bracket, making the distinction invisible) and got corrected after the user clarified their own 2025 league actually had TWO 2-week playoff rounds (matchups 23 and 24, not one combined round). The REAL root cause was one level down, in weekOfScoringPeriod's day-to-week anchor (see that function's own comment) - it was deriving `week` one real week ahead of where it should've been, which gets compounded here into an invented matchup one past the league's real last one. The league's real day-to-matchup lookup, rebuilt whenever a new payload lands. Cached on the payload object itself rather than a league key, so a refetch of the SAME league mid-matchup picks up the days that have since been scored instead of serving yesterday's boundaries.
let matchupMapCache = { data: null, map: null };
export function matchupPeriodMap() {
    const data = AppState.apiData;
    if (!data) return null;
    if (matchupMapCache.data !== data) {
        // settings comes along for the matchup being played, whose last days are not scored yet and so are not in the schedule (scheduledPeriodsOfMatchup).
        matchupMapCache = { data, map: buildMatchupPeriodMap(data.schedule, data.status, data.settings) };
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

// THE CATEGORY RACE'S CUMULATIVE LINE, for ONE team and ONE category. PURE and exported so the suite can hand-compute it. A counting category accumulates: the line at week 3 is weeks 1+2+3. A RATE CATEGORY CANNOT, and that is the bug this replaces - the race summed whatever sat under the category id, so a team's AVG line climbed.245,.491,.736 and the owner read 4.9 off the end of a season. This is the lesson arriving in a new chart: a rate is a ratio, and the only correct cumulative form is to sum its COMPONENTS across the weeks and divide once, at each point. The components are there to sum. A matchup's scoreByStat carries the whole line, not just the scored categories - AB(0) and H(1) sit beside AVG(2), OUTS(34) and ER(45) beside ERA(47) - and data.js keeps every id it finds, so `running` below accumulates the raw material and deriveRateOverrides recomputes the rate from it with the same validated table the drill-down, the windowed standings and the roto race all use. One definition of AVG in the app, not two. A rate with no component rule (nothing in flb today; the fallback exists for whatever is added next) degrades to the MEAN of the weeks that actually carried a value, which is the same approximation AVERAGE_STATS means everywhere else - weaker than components, but never a sum. Weeks with no value at all are skipped rather than counted as zero, so a bye does not drag a rate toward nothing. Inverse categories need no branch here. ERA is a smaller-is-better number and this returns the real ERA; which end of the scale wins is the renderer's and the ranker's question, not the series'.
export function teamCategorySeries(weeklyCatsByWeek, weeks, catId, sport) {
    const id = String(catId);
    const isRate = (AVERAGE_STATS[sport] || new Set()).has(id);
    const running = {};
    let sum = 0;
    let valued = 0;
    return weeks.map(w => {
        const wk = (weeklyCatsByWeek || {})[w];
        if (wk) {
            Object.keys(wk).forEach(k => { running[k] = (running[k] || 0) + (Number(wk[k]) || 0); });
            if (wk[id] !== undefined && wk[id] !== null) { sum += Number(wk[id]) || 0; valued += 1; }
        }
        if (!isRate) return sum;
        const derived = deriveRateOverrides(running, sport)[id];
        if (derived !== undefined) return derived;
        return valued ? sum / valued : 0;
    });
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

// PURE. One point per DAY of a matchup, each carrying the running total to that day. This is the Current timeframe's whole trick. A one-matchup window on a matchup axis is one or two points and reads as a straight line; the same window on a day axis is a real progression. Cumulative, not per-day, so the line answers "where is this up to" rather than flickering between a four-hit Tuesday and an idle Wednesday. An off-day or a DNP contributes nothing and so draws a FLAT segment, which is the honest shape rather than a gap or a drop to zero. Rates follow the same discipline the rest of this file does. Each day's rate is derived from the components accumulated THROUGH that day, never from averaging the daily rates. A pitcher whose first start was a 15.00 ERA and whose second was scoreless has to read as the combined line on day two, and only summing the components first gets that right. periods is the matchup's own scoring periods, in order, from the league's schedule - never a calendar assumption. A playoff matchup spanning three real weeks has more of them. Returns [{ period, index, totals, games, played }], and the caller decides where to stop.
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

// The scoring periods belonging to one matchup, in order, off the league's OWN schedule map. Never a calendar assumption. Matchup 15 of a real MLB league ran 14 days across the All-Star break while ESPN's own matchupPeriods still called it one week (see buildMatchupPeriodMap). A playoff round spanning three weeks is a longer list. The rule itself lives in utils.js beside the map it reads (scheduledPeriodsOfMatchup), because the matchup being played now has scored only the days already played and every caller here wants the days it will cover - R5. This stays as the name the tab and My Team already import, so the one rule reaches both surfaces without either changing.
export function periodsOfMatchup(matchupMap, matchupNumber) {
    return scheduledPeriodsOfMatchup(matchupMap, matchupNumber);
}

// Groups a kona_player_info response's raw day-level stat lines into per-matchup-week raw sums (weeklySums) - shared building block for both processPlayerWeeklyHistory (one player) and processBulkPlayerWeeklyHistory (many players at once, Phase 2) - the caller supplies whichever slice of rawData.players belongs to a single player. Also returns dailyByPeriod (scoringPeriodId -> { sums, games }) for roto leagues only. The lineup-aware Roto Race has to credit each single day to whichever team STARTED the player that day (from the roster snapshots), which the week buckets have already blurred together. Built only when isRotoLeague, so H2H leagues - which never run the race - don't pay the per-day memory. Same raw component sums as a week bucket, just at day granularity.
function buildWeeklySums(playerStatLines, year, wantDaily = false) {
    // Only actual (statSourceId 0) per-day lines - ESPN's rest-of-season projections turned out to be unreliable/empty in practice and aren't used here anymore. A PER-PERIOD LINE IS ONE WITH A PERIOD, whatever ESPN calls its split. This asked for split type 5, which is baseball's and hockey's per-GAME split - and football has none at all: its weekly lines are split type 1, seventeen of them, one per week, because a football scoring period IS the week. Asking for 5 found nothing and the drill-down sat on "Loading player history" forever. The discriminator that needs no sport branch is the scoring period itself. MEASURED across all three sports' captures: every line carrying a nonzero scoringPeriodId is a per-period line, and every season-level line (split 0 and, in baseball and hockey, split 1) carries zero. For those two sports this selects EXACTLY the set the old filter did - 2,711 lines of 2,711 in the baseball capture, 822 of 822 in the hockey one - so it is a widening that adds football and changes nothing else.
    const dayLines = playerStatLines.filter(s => s.seasonId === year && s.statSourceId === 0 && s.scoringPeriodId);

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
    // Daily sums ALWAYS on this path, because this path is one player. The drill-down's Day axis at Current needs them, and the cost is one player's days rather than the pool's. The bulk path stays selective on purpose.
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

// The pool as the CURRENT timeframe sees it, for surfaces outside the leaderboard that must window with it. Same function the leaderboard and the rank lookup read, so a roster row, its rank and the leaderboard row can never disagree about which weeks count.
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
        poolCache.playerDataRef === AppState.playerData && poolCache.weeklyCacheSize === weeklyCacheSize &&
        poolCache.weeklyVersion === weeklyCacheVersion) {
        return poolCache.result;
    }

    const result = AppState.playerData
        .filter(hasCachedWeeklyData)
        .map(p => ({ ...p, seasonTotals: aggregateStatsForWeekRange(AppState.playerWeeklyCache[p.id].weeklySums, start, end, sport) }));

    poolCache = { sport, timeframe: AppState.timeframe, start, end, playerDataRef: AppState.playerData, weeklyCacheSize, weeklyVersion: weeklyCacheVersion, result };
    return result;
}

// The position list a role group offers, shared by the leaderboard's dropdown and the comparison picker's so the two can never offer different positions for the same group - the picker's whole promise is that it offers the anchor's own universe, and a second copy of this ordering would be one edit away from disagreeing about it.
export function positionOptionsFor(players, sport, wantPitchers) {
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    let positions = Array.from(new Set(players.flatMap(p => p.eligiblePositions)));

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
    return positions;
}

function buildPositionFilterOptions(sport) {
    const select = document.getElementById('player-position-filter');
    if (!select) return;
    const currentVal = select.value;
    const wantPitchers = currentGroupIsSecondary(sport);
    const groupPlayers = AppState.playerData.filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const positions = positionOptionsFor(groupPlayers, sport, wantPitchers);

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

// THE TEAM/CLUB PICKER RAIL. Which group shows follows the availability filter, per the original rule: All gets both fantasy teams and pro clubs (a cross-section), Free Agents gets clubs only (an FA has no fantasy team to show), On Teams gets fantasy teams only. Both lists are cut down to teams/clubs that actually have a player in `players` (already filtered by search/position/availability, never by the rail itself - see the caller) - a chip for a team with nothing left to show is a dead end, not a real choice. The FILTER STATE (AppState.playerBreakoutFilter) and this cross-section logic are unchanged from the old breakout tabs; only the markup (player-rail.js) is new.
function renderBreakoutTabs(players) {
    const slot = document.getElementById('player-breakout-slot');
    if (!slot) return;
    const mode = AppState.playerAvailabilityFilter || 'all';
    const showFantasy = mode === 'all' || mode === 'rostered';
    const showPro = mode === 'all' || mode === 'fa';

    const fantasyTeams = [];
    if (showFantasy) {
        const present = new Set();
        players.forEach(p => { if (p.teamId != null) present.add(p.teamId); });
        // R2/S51 (frame I1): every fantasy team is now a crest (buildTeamCrestHtml always renders - the league's own logo over an abbreviation tile, never a bare dot), ringed in the team's own legend colour. teams[].logo lives on the RAW payload team, never copied onto AppState.teamStats, so it is read from apiData directly here rather than added to that pipeline for one caller.
        const rawTeamById = new Map((AppState.apiData?.teams || []).map(t => [t.id, t]));
        (AppState.teamStats || []).forEach(t => {
            if (present.has(t.id)) {
                const label = t.abbrev || t.name;
                fantasyTeams.push({
                    id: t.id, label, color: AppState.teamColorMap[t.id] || null,
                    crestHtml: buildTeamCrestHtml(label, rawTeamById.get(t.id)?.logo)
                });
            }
        });
    }

    // null (not []) when the pro-team schedule has not been fetched this session (My Team's own lazy ensureProSchedule, not asked for here - the own note on the same dependency) - the rail's own contract (tests/fixtures/player-rail.md) keeps that absence apart from a real empty row, same as every other "nothing to say yet" field in this codebase.
    let clubs = null;
    if (showPro) {
        const proSchedule = currentProSchedule();
        const proTeams = proSchedule?.settings?.proTeams;
        if (proTeams) {
            const present = new Set();
            players.forEach(p => { if (p.proTeamId != null) present.add(Number(p.proTeamId)); });
            clubs = proTeams
                // id 0 is ESPN's own "no pro team" placeholder (abbrev "FA"), not a club - filtered here the same way S4b filtered it from the old breakout strip.
                .filter(t => t && t.id != null && Number(t.id) !== 0 && present.has(Number(t.id)) && t.abbrev)
                .map(t => ({ id: Number(t.id), abbrev: String(t.abbrev).trim(), name: t.name || null }))
                .sort((a, b) => a.abbrev.localeCompare(b.abbrev));
        }
    }

    if (!fantasyTeams.length && clubs === null) {
        slot.innerHTML = '';
        return;
    }

    // A stale selection (a team/club that no longer has a chip - a search that now excludes it, say) falls back to All rather than leaving the row showing no active chip at all, or worse, leaving the table silently filtered to a team with no visible chip explaining why.
    const b = AppState.playerBreakoutFilter || { kind: 'all', id: null };
    const stillValid = b.kind === 'all'
        || (b.kind === 'fantasy' && fantasyTeams.some(t => t.id === b.id))
        || (b.kind === 'pro' && (clubs || []).some(c => c.id === b.id));
    if (!stillValid) AppState.playerBreakoutFilter = { kind: 'all', id: null };

    const sport = AppState.loadedSport;
    slot.innerHTML = buildPlayerRailHtml({ active: AppState.playerBreakoutFilter, teams: fantasyTeams, clubs }, {
        escapeHtml,
        crestHtml: (abbrev) => buildProTeamCrestHtml(sport, abbrev)
    });
    wirePlayerAvatars(slot);
}

// ONE BUTTON PER GROUP THE SPORT ACTUALLY HAS. This drew two unconditionally, so a one-group sport would have offered a second tab over an empty pool, labelled with baseball's word for it. A sport with a single group gets no toggle at all rather than a toggle with one button, because a control that cannot change anything is furniture.
function renderGroupToggle(sport) {
    const container = document.getElementById('player-group-toggle');
    if (!container) return;
    const groups = roleGroupsFor(sport);
    // A league switch can leave the old sport's group selected over a pool that does not exist here.
    AppState.playerGroup = activeGroupFor(sport);
    if (groups.length < 2) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }
    container.style.display = '';

    container.innerHTML = groups.map(group =>
        `<button class="group-toggle-btn${AppState.playerGroup === group ? ' active' : ''}" data-group="${group}">${groupLabel(sport, group === 'secondary')}</button>`
    ).join('');

    container.querySelectorAll('.group-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (AppState.playerGroup === btn.dataset.group) return;
            AppState.playerGroup = btn.dataset.group;
            buildPositionFilterOptions(sport);
            renderPlayerLeaderboard();
        });
    });
}

// R3/S49: "compact toggles at the toolbar's right end" (the ruling's own words) - a single pill button, on/off by a class rather than a checkbox, the same idiom this app's other toggle rows already use (.pd-pool-chip.on,.group-toggle-btn). The full sentence a reader needs moves into the button's own data-hint (utils.js's document-delegated tooltip, already wired) rather than sitting beside it as permanent text - the count/short label is the only thing on screen unconditionally, matching the "compact" word in the ruling.
function renderAdvancedStatsToggle(advancedCount) {
    const container = document.getElementById('advanced-stats-toggle');
    if (!container) return;

    if (advancedCount === 0) {
        container.innerHTML = '';
        return;
    }

    const on = AppState.showAdvancedStats;
    const tip = `${on ? 'Hide' : 'Show'} ${advancedCount} advanced categor${advancedCount === 1 ? 'y' : 'ies'}.`;
    container.innerHTML = `
        <button type="button" id="advanced-stats-toggle-btn" class="toolbar-toggle-btn${on ? ' on' : ''}" aria-pressed="${on}" data-hint="${escapeHtml(tip)}">Advanced (${advancedCount})</button>
    `;
    container.querySelector('#advanced-stats-toggle-btn').addEventListener('click', () => {
        AppState.showAdvancedStats = !AppState.showAdvancedStats;
        renderPlayerLeaderboard();
    });
}

function renderMinPlayingTimeToggle(groupPlayers, sport, wantPitchers = currentGroupIsSecondary(sport)) {
    const container = document.getElementById('min-playing-time-toggle');
    if (!container || AppState.isPointsLeague) {
        if (container) container.innerHTML = '';
        return;
    }

    // The exclusion threshold is games played for everyone now (see computeRotoRanks' own comment).
    const fractionPct = Math.round(MIN_PLAYING_TIME_FRACTION * 100);
    const maxGames = Math.max(0, ...groupPlayers.map(p => gamesPlayedOf(p, sport, wantPitchers)));
    const on = AppState.requireMinPlayingTime;
    const tooltipText = `Needs ${Math.round(maxGames * MIN_PLAYING_TIME_FRACTION)}+ games played to be ranked (${fractionPct}% of the leader's games).`;
    container.innerHTML = `
        <button type="button" id="min-playing-time-toggle-btn" class="toolbar-toggle-btn${on ? ' on' : ''}" aria-pressed="${on}" data-hint="${escapeHtml(tooltipText)}">Min GP</button>
    `;
    container.querySelector('#min-playing-time-toggle-btn').addEventListener('click', () => {
        AppState.requireMinPlayingTime = !AppState.requireMinPlayingTime;
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
    const pitchingIds = roleIdSetFor(sport);
    const wantPitchers = currentGroupIsSecondary(sport);
    const inverseSet = INVERSE_STATS[sport] || new Set();
    const roleLabel = groupLabel(sport, wantPitchers);
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
            // O21: the one number ESPN will not keep for us, kept once, before a game is played. Not awaited - nothing on screen depends on it.
            maybeTakePreseasonSnapshot();
            AppState.playerDataError = null;
            buildPositionFilterOptions(sport);
            // My Team draws names, ranks and stats out of this pool, and after a league switch it renders BEFORE the pool lands, so every row read "Player 3942335" with dashes until something forced a re-render. Announce the arrival instead. An event rather than a direct call because myteam.js already imports this module, and importing it back would close a cycle for one line.
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

// THE POOL, REFETCHED IN PLACE. The season stat lines - GS among them - are fetched once per dashboard open and then held for the life of the page, so a pitcher who finished a start an hour ago still reads the same GS. Busting the HTTP cache fixed what a fresh open serves; this is the other half, for a dashboard somebody leaves open. STALE-WHILE-REVALIDATE, the same shape the league payload uses: the pool on screen stays on screen, the new one replaces it only once it has arrived, and a failure changes nothing. That is why it does not go through ensurePlayerDataLoaded - that path is for having NO pool, and it signals the absence by clearing playerDataLoaded, which would blank the leaderboard, My Team and an open drill-down for as long as the refetch took.
export async function revalidatePlayerPool(sport) {
    // Nothing loaded yet means the ordinary path is already on its way to fetching it.
    if (!AppState.playerDataLoaded || !AppState.apiData) return;
    const apiDataRef = AppState.apiData;
    try {
        const raw = await fetchPlayerData();
        // Superseded by a real league switch while this was in flight.
        if (AppState.apiData !== apiDataRef) return;
        setDebugContext('player-pool', raw);
        AppState.playerData = processPlayerData(raw, sport);
        maybeTakePreseasonSnapshot();
        buildPositionFilterOptions(sport);
        // The same announcement the first load makes, so My Team redraws off the new lines exactly as it does off the first ones.
        document.dispatchEvent(new CustomEvent('leaguewise:player-pool-ready'));
        // And the Player tab itself. The leaderboard is hidden while a drill-down is open, so rendering it then would be work thrown away - refresh whichever is actually showing.
        if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        else renderPlayerLeaderboard();
    } catch {
        // Keep what is on screen. Nobody asked for this refresh, so nobody can act on its failure.
    }
}

// THE STALE FLAG'S CONSUMER. processCoreData({revalidate}) no longer refetches the pool unconditionally - the ~5s heavyweight was a fixed cost of every dashboard open, paid whether or not anyone looked at a pool number, and a glance at H2H Team Metrics never does. The revalidate sets AppState.playerPoolStale instead; the first pool-showing surface to render consumes it here and refetches stale-while-revalidate. Pool data is therefore at most ONE RENDER behind the moment somebody actually looks, which is the contract applied at the surface instead of at the open - and data.js consumes immediately when a pool surface is already on screen, so nothing visible ever waits for a click.
export function revalidateStalePoolIfDue() {
    // The weekly half rides the same trigger. Every caller of this function is a surface that just rendered pool numbers, which is exactly the moment the windowed cache behind those numbers should be questioned too - so the check lives here rather than being wired into graphs.js, myteam.js and this module's own tab separately, three sites that would then have to be kept in step. It is a no-op on the default timeframe and on the same day.
    refreshWeeklyForNewDayIfDue();
    if (!AppState.playerPoolStale) return;
    AppState.playerPoolStale = false;
    revalidatePlayerPool(AppState.loadedSport);
}

// THE DAY-GATED WEEKLY REFRESH. Fire-and-forget, and deliberately silent: nobody asked for it, the table on screen stays readable while it runs, and each chunk rewrites its own players as it lands rather than the cache being emptied first - a clear-then- refill would drop every windowed row until coverage came back, which is a worse lie than the stale numbers it is fixing. FOUR THINGS HAVE TO BE TRUE, and three of them are what keep this free: - a windowed timeframe is selected, because nothing else reads this cache - the cache has something in it, so this never races the first harvest - no harvest is already running - the payload's latestScoringPeriod has MOVED PAST the day the cache was built for On the default timeframe the first check ends it, which is why a reader who never picks a window pill pays nothing at all for this.
export function refreshWeeklyForNewDayIfDue() {
    if (isFullSeasonTimeframe()) return;
    if (bulkWeeklyFetchInFlight) return;
    const key = currentLeagueKey();
    if (!key || weeklyHarvestDay.key !== key) return;
    const today = AppState.apiData?.status?.latestScoringPeriod;
    // Number.isFinite on both, never Number(): a null latestScoringPeriod coerces to 0 and would read as "the day went backwards", which is the same trap caught four times.
    if (!Number.isFinite(today) || !Number.isFinite(weeklyHarvestDay.period)) return;
    if (today <= weeklyHarvestDay.period) return;
    const ids = Object.keys(AppState.playerWeeklyCache).map(Number).filter(Number.isFinite);
    if (!ids.length) return;
    refreshWeeklyCache(AppState.loadedSport, ids);
}

async function refreshWeeklyCache(sport, ids) {
    const apiDataRef = AppState.apiData;
    bulkWeeklyFetchInFlight = true;
    weeklyQueue = prioritizeWeeklyIds(ids, sport);
    weeklyClaimedIds.clear();
    // S44: NOT reset here - a refresh accumulates into whatever the league already holds (see weeklyPoolPlayers's own comment). Only a genuine league switch clears it, in resetLeaderboardWeeklyFetchState.
    try {
        await runWeeklyQueue(sport, apiDataRef, true);
        if (AppState.apiData !== apiDataRef) return;
        weeklyHarvestDay = { key: currentLeagueKey(), period: AppState.apiData?.status?.latestScoringPeriod ?? null };
        // The memo behind every windowed surface keys on this; without the bump the rewritten entries are computed against and then thrown away for the cached result.
        weeklyCacheVersion += 1;
        if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        else renderPlayerLeaderboard();
        document.dispatchEvent(new CustomEvent('leaguewise:player-pool-ready'));
    } catch {
        // Keep what is on screen. Nobody asked for this refresh, so nobody can act on its failure - the same contract revalidatePlayerPool above holds to.
    } finally {
        bulkWeeklyFetchInFlight = false;
    }
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
    // This warms the pool for the league already in AppState, so it asks that league's sport for its player universe. Reading the form here would fetch one sport's pool for another's league the moment the user browsed the dropdown. The weekly harvest is deliberately NOT chained behind it any more. That chain made every dashboard open cost the full pool's chunks - 18 on the measured fixture - whether or not the user ever looked at a surface that reads weekly data, and every weekly-consuming surface already has its own demand trigger: the leaderboard's arrow fill, the windowed timeframes, My Team's window, the roto race and the basis-coverage kick. The arrows now pop in a few seconds after the tab opens instead of being warm before it - which is the trade the measured 180-requests-a-day-for-nothing was buying, and the wrong way around.
    const sport = AppState.loadedSport;
    ensurePlayerDataLoaded(sport).catch(() => {});
}

export async function loadPlayerTabIfNeeded() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    if (!AppState.apiData) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }

    // Entering the tab is looking at pool numbers, which is what consumes a deferred pool revalidate. Fire-and-forget: the current pool renders below, the fresh one swaps in.
    revalidateStalePoolIfDue();

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

// THE DAY THE WEEKLY CACHE WAS BUILT FOR. found that a WINDOWED timeframe reads its numbers out of playerWeeklyCache rather than out of the pool, and that this cache is cleared only by a league switch - never by a revalidate, and never overwritten, since the harvest is append-only. So a dashboard left open on a Last-4 pill showed figures frozen at whatever the first harvest saw, for the life of the page, and the pool revalidate beside it could not touch them. WHY THE DAY AND NOT THE REVALIDATE. Refreshing on every revalidate costs a full re-harvest - 23 chunks on the measured 1,699-player capture - on every dashboard open past the five-minute gate, which is the cost spent an entry removing. New day lines only exist once the day turns, so between turns a re-harvest buys nothing at all. Gating on latestScoringPeriod spends the same 23 chunks at most once a day, and ZERO on the default timeframe, because 'all' and early-season 'reg' never read this cache - which is why the fault needed a window pill AND a page left open to bite at all. The stamp is the payload's own latestScoringPeriod at the moment a harvest finished, kept with the league key so a switch cannot make one league's day look current for another's.
let weeklyHarvestDay = { key: null, period: null };

// poolCache (getEffectivePlayerPool) keys on how many players have weekly data, which is a fine signal while the cache only ever GROWS and a useless one now that it can be rewritten in place: a refresh replaces 1,699 entries with 1,699 entries and the count never moves. This counter is what makes the memo notice.
let weeklyCacheVersion = 0;

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
// O40/S43/S44: the pool debug context ACCUMULATES every chunk's players as they land, rather than latching onto the first one - a Download All used to hold exactly WEEKLY_CHUNK_SIZE (75) players under 'player-weekly' regardless of how deep the real queue ran, which was the tool's own design (the latch), not a real cap on the response. The envelope (everything but the players array - status, settings, and every other top-level field the response carries) is kept from the FIRST chunk of the LEAGUE, not the first chunk of a run - S44 found that resetting this pair at the start of every bulk fetch wiped Batters' chunks the moment a group switch to Pitchers kicked off its own run, so a real harvest never held more than one group's players at once (463 batters, then the switch, then 4 pitchers - never both). Reset ONLY where playerWeeklyCache itself is cleared for a genuine league switch (resetLeaderboardWeeklyFetchState); the two bulk-fetch sites (ensureLeaderboardWeeklyDataLoaded, refreshWeeklyCache) now accumulate ACROSS RUNS, whichever group or refresh started them. weeklyPoolPlayers is keyed by player id rather than a plain array for exactly that reason: a refresh re-requests ids it already holds (the "already cached" skip does not apply there - see runWeeklyQueue's own comment), and a Map means the newest entry for an id replaces the old one instead of the players array holding it twice.
let weeklyPoolEnvelope = null;
let weeklyPoolPlayers = new Map();

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
    const visibleCount = ordered.length;
    weeklyBasisPoolIds(sport).forEach(take);
    // The tier sizes, published for the harness: the tier-3 cut was gated on measuring how much of the pool tier 3 actually is, and this is where the tiers exist.
    window.__weeklyTierSizes = { visible: visibleCount, basis: ordered.length - visibleCount, rest: remaining.size };
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
async function runWeeklyQueue(sport, apiDataRef, refresh = false) {
    const workerCount = Math.min(WEEKLY_MAX_CONCURRENT_CHUNKS, Math.ceil(weeklyQueue.length / WEEKLY_CHUNK_SIZE) || 1);
    const worker = async () => {
        for (;;) {
            const chunk = [];
            while (chunk.length < WEEKLY_CHUNK_SIZE && weeklyQueue.length > 0) {
                const id = weeklyQueue.shift();
                // A refresh pass is asking for ids it ALREADY holds, so "already cached" stops being a reason to skip - the entry is rewritten when the chunk lands. Claimed still skips, because that is about two workers, not about staleness.
                if ((!refresh && AppState.playerWeeklyCache[id]) || weeklyClaimedIds.has(id)) continue;
                weeklyClaimedIds.add(id);
                chunk.push(id);
            }
            if (chunk.length === 0) return;
            try {
                const raw = await fetchPlayersWeeklyChunk(chunk);
                // Superseded mid-flight (see the discard rule ensurePlayerDataLoaded documents): drop this chunk entirely rather than writing another league's rows into the freshly cleared cache, and stop pulling more work.
                if (AppState.apiData !== apiDataRef) return;
                // Its OWN kind, never the pool's. This is the queue's own daily splits, which is a different thing from the player pool and used to be labeled as it (see DEBUG_LABELS in utils.js). O40/S43/S44: every chunk's players ACCUMULATE across every run this league sees (Batters, Pitchers, a later refresh) rather than the first chunk of any one of them latching it - the envelope (every field but players) is the LEAGUE's first chunk ever, and weeklyPoolPlayers is keyed by id so a refresh re-landing an id already held REPLACES that entry rather than the players array carrying it twice.
                if (!weeklyPoolEnvelope) {
                    const { players: _discard, ...envelope } = raw || {};
                    weeklyPoolEnvelope = envelope;
                }
                (raw.players || []).forEach(entry => {
                    const id = entry?.id ?? entry?.player?.id;
                    if (id != null) weeklyPoolPlayers.set(Number(id), entry);
                });
                setDebugContext('player-weekly', { ...weeklyPoolEnvelope, players: Array.from(weeklyPoolPlayers.values()) });
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

// SCOPE: 'all' fetches every missing player with season totals - the windowed timeframes, My Team's window and the roto race genuinely read the whole pool, so they keep it. 'basis' stops at tiers 1 and 2 - the visible rows and the qualified basis pool - which is everything the trend-arrow math is load-bearing on. Measured on the fixture before the cut: tier 3 was 855 of 1,306 players (65%), 12 of the 18 chunks, all speculative. Completion stays PER-ID cache misses, never a flag: a basis-scope run finishing must not read as "everything fetched", and it cannot, because an 'all' caller recomputes its own missing set from the cache.
async function ensureLeaderboardWeeklyDataLoaded(sport, scope = 'all') {
    if (bulkWeeklyFetchInFlight) return;
    let missingIds = AppState.playerData
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id])
        .map(p => p.id);
    if (scope === 'basis') {
        const wanted = new Set([...visibleLeaderboardPlayerIds(), ...weeklyBasisPoolIds(sport)]);
        missingIds = missingIds.filter(id => wanted.has(id));
    }
    if (missingIds.length === 0) return;

    // Same discard rule ensurePlayerDataLoaded documents. A league/year fetch mid-flight reassigns AppState.apiData and resets playerData/playerWeeklyCache (processCoreData), which makes these responses the WRONG league's. Their rows would be written into the new league's freshly cleared cache, aggregated with the `sport` captured back when this call started (so an NHL response could even be parsed with the MLB stat maps). This fetch takes tens of seconds for a full pool, so the window for that is wide, not theoretical. Checked per chunk now rather than once at the end, so a superseded run stops early instead of finishing.
    const apiDataRef = AppState.apiData;

    bulkWeeklyFetchInFlight = true;
    weeklyQueue = prioritizeWeeklyIds(missingIds, sport);
    weeklyClaimedIds.clear();
    // S44: NOT reset here - this is the entry point BOTH groups' runs share (a switch to Pitchers calls back in with its own missingIds), and wiping the context on every call is exactly what left a real harvest holding only whichever group ran last. Only a genuine league switch clears it, in resetLeaderboardWeeklyFetchState.
    try {
        await runWeeklyQueue(sport, apiDataRef);
        if (AppState.apiData !== apiDataRef) return;
        bulkWeeklyFetchFailed = false;
        // What day this cache now speaks for. Stamped on SUCCESS only: a failed or superseded harvest must not claim a day it never read, or the refresh below would decide there is nothing to do.
        weeklyHarvestDay = { key: currentLeagueKey(), period: AppState.apiData?.status?.latestScoringPeriod ?? null };
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

// THE PRO SCHEDULE, ON DEMAND - the hook the leaderboard's time-lens toggle calls when the reader switches to a lens that needs it. It is NOT called on load, and that is the whole point. Every schedule-derived lens is null without this data, so the tempting thing is to fetch it whenever the leaderboard renders - which would spend a request on every reader for a column most of them never look at. The draft board settled this already: a schedule is not worth a request from a board nobody asked to consult. So the column stays absent until a reader asks for it, and then it is one request, at their own click. Not a new endpoint either: this is the SAME cached fetch My Team already makes, made earlier by a different tab. fetchProTeamSchedules holds it in AppState and in session storage and captures it to the panel's pro-schedule kind, so a reader who has already opened My Team pays nothing here. Returns the promise so a caller can await it; re-renders the leaderboard itself when the answer arrives, because the rows that asked for it were drawn before it existed - and it re-renders on a NULL answer too, not only a successful one. Gating the re-render on `data` left a league with no pro schedule (no pro-schedule.json to fetch, or the fetch genuinely failing) stuck on its pre-fetch render forever: the header had drawn against `scheduleAttempted === false` (nothing asked for yet, every lens enabled and unlabelled by the ruling above), and nothing ever told it the attempt had since resolved to nothing - the playoff header sat over a column of blank cells because the render that would have reset AppState.ahead to null and greyed the pill with "Schedule not loaded" (see the lensReasons block below) never ran.
let proScheduleReadyKey = null;
let proScheduleFetch = null;
export function ensureProScheduleData() {
    const key = currentLeagueKey();
    if (!key) return Promise.resolve(null);
    // Both guards, and they answer different questions: the ready key says this LEAGUE's fetch has resolved and its render has run, and currentProSchedule says the body in memory belongs to this league's sport and year rather than to whatever was loaded before it.
    const inHand = currentProSchedule();
    if (proScheduleReadyKey === key && inHand) return Promise.resolve(inHand);
    if (proScheduleFetch && proScheduleFetch.key === key) return proScheduleFetch.promise;
    const promise = fetchProTeamSchedules().then(data => {
        // A league switched mid-flight makes this answer the wrong league's - drop it rather than redraw one league's rows against another's schedule.
        if (currentLeagueKey() !== key) return data;
        proScheduleReadyKey = key;
        renderPlayerLeaderboard();
        return data;
    }).catch(() => null);
    proScheduleFetch = { key, promise };
    return promise;
}

// THE DRAFT'S OWN PICKS, ALONE - the one request the preseason face makes. The graded card promises three things: where the draft projects the team to finish, its strongest and thinnest categories, and the pick that beat its own position by most. The first two come off the projected basis and cost nothing. The third needs the picks, and the picks are not in the league payload - they come from mDraftDetail, which only ensureRosterTransactionData ever asks for, and that only runs from the ROTO RACE, a box the preseason face never draws. So the third promise could never be kept for any real user: not a staging gap, a feature that could not happen. IN SEASON THIS DOES NOT FIRE. The race already fetches the same view, so asking here would be a second request for an answer the session is about to hold anyway. The response is shared, not duplicated: the harvest below reads this cache instead of fetching again, so a reader who opens the Draft tab or reaches the race later pays nothing more. fetchDraftDetail captures it to the panel's draft-detail kind on the way past, like every other fetch this app makes.
let draftPicksCache = { key: null, picks: null };
let draftPicksInFlight = null;

// Whichever source holds them. The harvest's copy wins when it exists, because it arrived with the transaction log beside it and is the one the race and the history view already read.
export function draftPicksFor() {
    const key = currentLeagueKey();
    if (AppState.rosterTransactionData && AppState.rosterTransactionData.key === key) {
        return AppState.rosterTransactionData.picks || null;
    }
    return draftPicksCache.key === key ? draftPicksCache.picks : null;
}

export function ensureDraftPicks(sport) {
    const key = currentLeagueKey();
    if (!key) return Promise.resolve(null);
    if (draftPicksFor()) return Promise.resolve(draftPicksFor());
    if (draftPicksInFlight && draftPicksInFlight.key === key) return draftPicksInFlight.promise;

    const leagueId = AppState.apiData?.id;
    const year = AppState.apiData?.seasonId;
    if (leagueId == null || year == null) return Promise.resolve(null);

    const promise = fetchDraftDetail(sport, leagueId, year).then(picks => {
        if (currentLeagueKey() !== key) return null;   // a league switched mid-flight - drop it
        draftPicksCache = { key, picks: picks && picks.length ? picks : null };
        // Announced rather than called back into, because the surface that wants this is a VIEW and this module must not import one. Same shape as the pool-ready event My Team already uses.
        if (draftPicksCache.picks) document.dispatchEvent(new CustomEvent('leaguewise:draft-picks-ready'));
        return draftPicksCache.picks;
    }).catch(() => null).finally(() => {
        if (draftPicksInFlight && draftPicksInFlight.key === key) draftPicksInFlight = null;
    });
    draftPicksInFlight = { key, promise };
    return promise;
}

let rosterHarvestInFlightKey = null;
let rosterHarvestFailedKey = null;

// THE HARVEST, JOINABLE. The careers pane wants this season's log too, and until now it could see that a harvest was running and had no way to wait for it - rosterHarvestInFlightKey says "busy" and nothing more - so a reader who reached Player Careers before the race finished started a SECOND walk of the same 196 periods. Measured: the fast reader's careers click cost 392 requests where the slow reader's cost 196. Exposing the promise rather than making the pane wait on the KEY is what keeps the pane's paint unchanged: it still renders draft-only immediately and refines when this settles, exactly as it does for a season it walked itself. It resolves to the raw { picks, transactions } rather than to the ownership map, so the joiner builds its own timeline and this module keeps knowing nothing about attribution.
let rosterHarvestInFlight = null;

// Null unless a harvest for the league on screen RIGHT NOW is running. The key check matters for the same reason it does in the harvest itself: a promise from the league the reader just left would resolve with the wrong season's log.
export function liveHarvestInFlight() {
    const key = currentLeagueKey();
    return rosterHarvestInFlight && key && rosterHarvestInFlight.key === key ? rosterHarvestInFlight : null;
}
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

    // STALENESS IS A CHANGE OF LEAGUE, NOT A CHANGE OF OBJECT. This used to hold `apiDataRef = AppState.apiData` and drop the result if the reference moved. It moves on every dashboard open: revalidateLeagueData assigns AppState.apiData = data unconditionally when the background read succeeds, same league, same key, a new object. So the open's own revalidate superseded the harvest it had just started - ~196 completed requests discarded, the in-flight key cleared in `finally`, the progress hook firing a re-render that started the whole harvest again from zero. Measured on a two-season roto league: 789 requests to open Team Metrics, 396 with the revalidate held until after the harvest. Half the open was work thrown away. Comparing the KEY keeps the guard's real purpose - a league or season switch mid-harvest must not write one league's log into another's state - and drops the accident. The key is gameId:id:seasonId, so a switch still changes it and a revalidate of the same league cannot.
    rosterHarvestInFlightKey = key;
    // Built as one shared promise so a joiner gets the SAME work rather than a copy of it, and published before the first await so a caller that arrives in the same tick can still find it.
    const work = Promise.all([
        // Already fetched if the preseason face asked for them (ensureDraftPicks above). One response, two readers - the point of caching it under the league's own key.
        draftPicksCache.key === key && draftPicksCache.picks
            ? Promise.resolve(draftPicksCache.picks)
            : fetchDraftDetail(sport, leagueId, year),
        harvestTransactions(sport, leagueId, year, firstSP, finalSP)
    ]).then(([picks, transactions]) => ({ picks, transactions }));
    rosterHarvestInFlight = { key, year, promise: work };
    // A joiner owns its own failure handling; without this an unjoined rejection would surface as an unhandled rejection the moment the catch below stopped being the only reader.
    work.catch(() => {});
    try {
        const { picks, transactions } = await work;
        if (currentLeagueKey() !== key) return; // a real league switch - drop it
        // Both empty means no usable history (a season before ESPN kept it, or a draft-less format with no moves) - leave the data null so the race keeps the current-roster fallback.
        if (picks.length === 0 && transactions.length === 0) {
            rosterHarvestFailedKey = key;
        } else {
            AppState.rosterTransactionData = { key, picks, transactions };
        }
    } catch (err) {
        if (currentLeagueKey() !== key) return;
        console.error('Failed to harvest the transaction log for the Roto Race:', err);
        rosterHarvestFailedKey = key;
    } finally {
        if (rosterHarvestInFlightKey === key) rosterHarvestInFlightKey = null;
        if (rosterHarvestInFlight && rosterHarvestInFlight.key === key) rosterHarvestInFlight = null;
        if (weeklyProgressHook) weeklyProgressHook(); // re-render the race with whatever we ended up with
    }
}

// Harvest the daily roster SNAPSHOTS ONCE per league+season, for the lineup-aware Roto Race. Same shape and guarantees as ensureRosterTransactionData: fire-and-forget, key-guarded, staleness- guarded (a league switch mid-harvest discards the result), and it fires the weekly-progress hook on completion so the race re-renders and upgrades from the rostered/current fallback to STARTED- accurate. A failure leaves rosterSnapshotData null and the race steps down the fallback ladder (golden rule 8). This is the ~196-request-per-season cost of started-accurate crediting - the same per-period pattern and concurrency cap as the transaction harvest, run alongside it (the transaction timeline still backs the rostered fallback tier and ).
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

    // Keyed rather than by reference, for the reason spelled out on the transaction harvest above: the open's own revalidate is not a league switch, and treating it as one cost this harvest its own ~196 requests twice over on every roto open.
    snapshotHarvestInFlightKey = key;
    try {
        const { days } = await harvestRosters(sport, leagueId, year, firstSP, finalSP);
        if (currentLeagueKey() !== key) return; // a real league switch - drop it
        // No days at all means the season predates ESPN's stored daily rosters (or a private/empty response) - leave it null so the race falls back to the transaction timeline.
        if (Object.keys(days).length === 0) {
            snapshotHarvestFailedKey = key;
        } else {
            AppState.rosterSnapshotData = { key, days };
        }
    } catch (err) {
        if (currentLeagueKey() !== key) return;
        console.error('Failed to harvest the daily roster snapshots for the Roto Race:', err);
        snapshotHarvestFailedKey = key;
    } finally {
        if (snapshotHarvestInFlightKey === key) snapshotHarvestInFlightKey = null;
        if (weeklyProgressHook) weeklyProgressHook();
    }
}

// The scoring period standing in for a real week when reading roster ownership. It is midPeriodOfWeek's inverse-of-weekOfPeriod guarantee that makes this correct, which is why both halves now live together in utils.js rather than as two independent one-liners here. This one used to return week*7+3 against a mapping that had since been re-anchored, so it read ownership three days into the FOLLOWING week - see the pair's own comment for the whole story. Used only by the rostered-day fallback tier; the started tier reads the per-day snapshots directly and needs no proxy. A roster change inside a week still attributes that whole week to the mid-week owner, which is the documented residual on buildRotoRaceSeries and is coarseness, not the wrong week.
function representativePeriodForWeek(week) {
    return midPeriodOfWeek(week, AppState.apiData?.status?.firstScoringPeriod || 1);
}

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

// The league's STARTING lineup-slot ids are every slot it actually rosters (lineupSlotCounts > 0) minus the bench/IR ids for the sport (NON_STARTING_SLOTS). Adapts to each league's own roster construction while the bench/IR ids stay fixed per sport - see the validation note on NON_STARTING_SLOTS. A player's day credits the team only when that day's snapshot slot is in here.
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

// The started-tier accumulation, factored out of buildRotoRaceSeries so the Roto Race and the windowed roto standings/heatmap share ONE source of truth, per team a { week -> { sums, games } } map of the started-day component sums. Both then aggregate + score off this same map, so the identity holds by construction - the "Full Season" window (weeks[0]..last) is literally the race's final cumulative point, which reproduced ESPN's official finals exactly on FGB 2025 (61.0/56.5/55.0/40.5/27.0). If windowing and the race could ever disagree, they'd have to read different sums, and they can't, because there is only this function. Returns null unless the STARTED tier is actually available - the snapshot harvest landed for THIS league AND the weekly component cache is complete. Windows are only honest on started-day data. The rostered/current fallbacks count benched days ESPN never did, so a "last 4 weeks" off them would be a plausible-looking wrong number. Memoized by league key + weekly-cache size (the cache only grows as chunks land, so its size is a sufficient staleness key), so the per-cell heatmap lookups below don't re-accumulate.
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

// Builds the Roto Race. It credits each player's stats to a team over time, aggregate each team's cumulative category values, score them roto-style across teams (the pure scoreRotoWeek), and record each team's running total. This is the one place roto points are computed rather than read from ESPN (season-end standings stay verbatim - see rotoPoints in data.js). THREE crediting modes, a fallback ladder (golden rule 8) - the race always renders, only its fidelity and subtitle change as more data lands: 'started': AppState.rosterSnapshotData holds every day's full lineup. Credit each single day to whoever had the player in a STARTING slot that day (startedTeamForPlayerAtPeriod). This is exactly what ESPN's roto standings count, so it reproduces each team's valuesByStat and lands on the official finals - VALIDATED on FGB 2025: per-category deltas are zero across all 5 teams, finals 61.0/56.5/55.0/40.5/27.0 exactly. 'rostered': no snapshots, but AppState.rosterTransactionData holds the draft + transaction log. Credit each week to whoever ROSTERED the player mid-week. Faithful to trades and drops but counts benched days ESPN doesn't, so it lands near - not on - the finals. 'current': neither harvested yet. Every week credits the player's CURRENT team - a trade rewrites the whole past. Roughest; the original subtitle names it. Returns `mode` so the caller picks the matching subtitle. The started tier resolves the started-vs-rostered residual the note described; the only thing left between it and ESPN is a mid-DAY lineup edit (a snapshot is one slot per day), which the FGB validation showed nets to zero here. Rate categories reproduce from summed COMPONENTS, not averaged daily rates (deriveRateOverrides) - the same path baseball uses, so this is sport-general. Progressive by construction. It reads whatever the caches hold right now, so a half-loaded pool renders a shorter/rougher race that fills in as weekly chunks and the two harvests land, each re-rendering the box via setWeeklyProgressHook. The day-by-day roto standing across the current week, or null when there is nothing honest to draw. Returns the same shape the weekly race does, one bucket smaller, so the renderer needs to know nothing except how to LABEL an axis of days.
function buildRotoDailyRace(sport, categories) {
    if (!categories.length) return null;
    // Already cumulative WITHIN the week and already rate-corrected - aggregateDailyCumulative derives a rate from summed components at each day rather than averaging daily rates, which is the whole reason the category race reuses it too.
    const daily = rotoCategoryDailySeries(sport);
    if (!daily) return null;

    const seriesByTeam = new Map(AppState.teamStats.map(t => [t.id, []]));
    daily.periods.forEach((period, i) => {
        // Every team is scored against every other team ON THAT DAY, which is what makes this a standing rather than a set of running totals - a team can gain roto points on a day it played nothing, because the teams below it did worse.
        const scoreInput = AppState.teamStats.map(t => ({
            id: t.id,
            values: (daily.byTeam.get(t.id) || [])[i] || {}
        }));
        const totals = scoreRotoWeek(scoreInput, categories);
        AppState.teamStats.forEach(t => seriesByTeam.get(t.id).push(totals.get(t.id) || 0));
    });

    // `weeks` rather than `periods`, because that is the name the renderer's axis reads and the two series are otherwise identical. dayAxis is what tells it to label them Day 1..n.
    return { weeks: daily.periods, seriesByTeam, dayAxis: true };
}

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

    // AT CURRENT, THE RACE RUNS ACROSS DAYS. Roto's Current pill is a one-week window, so the weekly race below filters allWeeks down to exactly one week and draws every team as a single dot on the left edge - the degenerate chart the entry set out to remove. Days are the honest bucket at that width, and roto is the one format that can already afford them: the started tier has the daily snapshots and per-day player lines harvested for the race itself, so this costs no extra request. Same day buckets the CATEGORY race at Current already uses (rotoCategoryDailySeries), scored through the same scoreRotoWeek the weekly race scores with - so the daily race and the weekly one cannot drift apart in how a roto point is earned, and the last day of the daily race is the same standing the one-week race was drawing as its single dot. Falls through to the weekly path when the daily series is not available: the fallback tiers have no started-day crediting, and a week whose first day is the only one played has nothing to race across. A single dot on the first morning of a matchup is honest rather than degenerate.
    if (parseTimeframe(AppState.timeframe).window === 1) {
        const daily = buildRotoDailyRace(sport, categories);
        if (daily) {
            return {
                ...daily,
                categoryCount: categories.length,
                teams: AppState.teamStats.map(t => ({ id: t.id, name: t.name })),
                mode
            };
        }
    }

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
    // S44: the ONE place this resets now - a genuine league switch (processCoreData clears AppState.playerWeeklyCache in the same block that calls this). The two bulk-fetch entry points (ensureLeaderboardWeeklyDataLoaded, refreshWeeklyCache) accumulate across every run instead, which is what lets a Batters run and a later Pitchers run both survive in the same debug context.
    weeklyPoolEnvelope = null;
    weeklyPoolPlayers = new Map();
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
    // S41/F1: matchupRank stays valid across a league switch even where the new league cannot support it (roto, points, too few decided matchups) - sortLeaderboardPlayers degrades to a no-op ordering when matchupRanks itself is null (every row reads unmeasured, so the comparator returns 0 for every pair) rather than crashing, the same defense-in-depth 'rotoScore' already gets for a points league with no rotoRanks.
    const universalSortKeys = new Set(['name', 'teamName', 'positionName', 'gp', 'ip', 'matchupRank']);
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

    // Team breakout: a team id from the PREVIOUS league is never valid in this one (fantasy teamIds and proTeamIds both restart from small integers per sport/league), so rather than re-validate against whichever id space it happened to be, every league switch resets to 'all' the same way a fresh session starts.
    if (AppState.playerBreakoutFilter && AppState.playerBreakoutFilter.kind !== 'all') {
        AppState.playerBreakoutFilter = { kind: 'all', id: null };
    }
}

// The leaderboard's sort, in place, per the current AppState sort selection - shared between the table render and buildLeaderboardExportModel so an export is always ordered exactly like the table it mirrors.
function sortLeaderboardPlayers(players, rotoRanks, sport, wantPitchers = currentGroupIsSecondary(sport), matchupRanks = null) {
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
        // S41/F1: sorts by matchup-rank.js's own winsPerWeek, never the rank NUMBER (a tie shares a rank, but the underlying figures still order them). A player the module could not measure sinks below every measured one regardless of direction - the same "unranked never floats to the top of an ascending sort" rule rotoRanks' own unranked cohort gets above, applied to this column's own absence.
        if (sortStat === 'matchupRank') {
            const wpwOf = (p) => (matchupRanks && matchupRanks.byId[p.id]) ? matchupRanks.byId[p.id].winsPerWeek : null;
            const av = wpwOf(a), bv = wpwOf(b);
            if (av === null || bv === null) return av === null && bv === null ? 0 : (av === null ? 1 : -1);
            return (av - bv) * dir;
        }
        if (sortStat === 'rotoScore') return ((rotoRanks.scores.get(a.id) || 0) - (rotoRanks.scores.get(b.id) || 0)) * dir;
        if (sortStat === 'gp') return (gamesPlayedOf(a, sport, wantPitchers) - gamesPlayedOf(b, sport, wantPitchers)) * dir;
        if (sortStat === 'ip') return ((a.seasonTotals[IP_STAT_ID] || 0) - (b.seasonTotals[IP_STAT_ID] || 0)) * dir;
        if (sortStat === 'rostered') return ((a.rosterPct || 0) - (b.rosterPct || 0)) * dir;
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
    const wantPitchers = currentGroupIsSecondary(sport);
    // The same basis the table renders, so an export taken in preseason carries the projections the reader was looking at rather than the empty (or last-season) lines underneath them.
    const basis = preseasonBasisCtx(sport, wantPitchers);
    const groupPlayers = preseasonBasisOf(getEffectivePlayerPool(sport), basis)
        .filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const { scored, advanced } = statIdsForGroup(sport, activeGroupFor(sport), groupPlayers);
    const statIds = includeAdvanced ? [...scored, ...advanced] : scored;

    const query = AppState.playerSearchQuery.trim().toLowerCase();
    const posFilter = AppState.playerPositionFilter;
    let players = groupPlayers.filter(p => {
        if (query && !p.name.toLowerCase().includes(query)) return false;
        if (posFilter !== 'ALL' && !matchesPositionFilter(p, posFilter)) return false;
        if (!matchesAvailability(p)) return false;
        if (!matchesBreakout(p)) return false;
        return true;
    });

    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = computeLeagueRanks(rankPool, sport, posFilter, wantPitchers, unknownIdsFor(basis));
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

    // Innings pitched is a baseball-pitcher column only. Hockey's secondary group is goalies, who have no innings concept (and id 34, what IP_STAT_ID points at, means GP in hockey) - the GP column already covers their workload. A COLUMN OF DASHES IS NOT A COLUMN. Football carries no games-played statistic at all (measured - see GAMES_PLAYED_IDS), so the header goes with the values rather than standing over an empty strip pretending the number is merely missing for these players.
    const showGames = gamesPlayedKnown(sport);
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
        exportCell(gamesPlayedOf(p, sport, wantPitchers)) || 0,
        ...(showInnings ? [p.seasonTotals[IP_STAT_ID] !== undefined ? +(p.seasonTotals[IP_STAT_ID] / 3).toFixed(2) : ''] : []),
        ...statIds.map(id => exportCell(p.seasonTotals[id]))
    ]);

    return { headers, rows };
}

// The leaderboard's own ranking, offered to surfaces that show a rank outside the table. Both role pools are ranked exactly as the table ranks them, with no position filter, so a roster row and the leaderboard row for the same player always agree. Returns a Map of playerId to { rank, total, poolLabel }. A player the engine will not rank now gets an entry too, with a null rank and the REASON - the dash the caller draws is right, but a dash alone made two different states look identical, and the one the owner hit (no games in the selected window) is the one worth naming. A player missing from the map entirely still means something else, that they are not in the pool at all.
export function rosterRankLookup(sport) {
    const out = new Map();
    if (!AppState.playerDataLoaded) return out;
    const pool = getEffectivePlayerPool(sport);
    // THE MUTATE-AND-RESTORE IS GONE. This ranks BOTH groups in one pass, and the workload measures used to read AppState.playerGroup - so the group had to be moved for the duration of each pass and put back in a finally. It worked, but only while nothing else read the global in between, and the day it did not the pitcher pass measured pitchers by the BATTING games id: 6 pitcher ranks against 445 batter ranks on a pool holding 1520 pitchers. The group is an argument now, so a two-group loop is ordinary code rather than a manoeuvre.
    roleGroupsFor(sport).forEach(group => {
        const wantPitchers = group === 'secondary';
        // S13: the leaderboard ranks on the preseason basis (preseasonBasisOf, above) so a projected face shows projected totals; this reader read the pool straight, off REAL seasonTotals - all zero before a game is played - so My Team's own PTS column and rank chip read 0.0 for every player while the roster table beside it (basisTotalsOf) correctly showed projections. Same basis, same swap, so the two halves of one tab cannot disagree about which numbers a league that has not played yet is even showing.
        const basis = preseasonBasisCtx(sport, wantPitchers);
        const groupPlayers = preseasonBasisOf(pool.filter(p => matchesPlayerGroup(p, sport, wantPitchers)), basis);
        if (!groupPlayers.length) return;
        const label = groupLabel(sport, wantPitchers);
        const ranked = computeLeagueRanks(groupPlayers, sport, null, wantPitchers, unknownIdsFor(basis));
        ranked.ranks.forEach((rank, id) => out.set(id, {
            rank, total: ranked.total, poolLabel: label, score: ranked.scores.get(id)
        }));
        groupPlayers.forEach(p => {
            if (out.has(p.id)) return;
            out.set(p.id, { rank: null, poolLabel: label, reason: unrankedReason(p, groupPlayers, sport, wantPitchers) });
        });
    });
    return out;
}

// HOW MANY ROWS GET A PHOTO. The board's rule, applied to the leaderboard: every roster seat the league allows times the number of teams - the last pick of a draft - and everyone below that gets the initials tile with no <img> and no request. Applied to DISPLAYED position rather than to rank (ruled): this table re-sorts on any column, and a rank-based bound would re-sort out from under the images and thrash the cache for nothing. The cost of getting it wrong is not a slow page - the football pool renders 1,059 rows and baseball 1,487 with Minimum Games off, so an unbounded identity column is a thousand image requests. The same arithmetic as draft-view.js's draftableCount, deliberately NOT imported: draft-view already imports this module, and a cycle to share six lines of addition is a bad trade.
const PHOTO_ROWS_FLOOR = 50;

function photoRowBudget() {
    const settings = AppState.apiData?.settings || {};
    const counts = settings.rosterSettings?.lineupSlotCounts || {};
    const perTeam = Object.keys(counts).reduce((sum, id) => sum + Math.max(0, Number(counts[id]) || 0), 0);
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    // A league that reports neither still shows photos where the eye is, rather than none at all.
    return Math.max(PHOTO_ROWS_FLOOR, perTeam * teams);
}

// ==== The leaderboard row model ==== The frozen contract is tests/fixtures/leaderboard-row.md and the renderer is leaderboard-row.js, which is pure. The split is strict and worth stating once: THIS side owns every FACT a row prints, that side owns every rendering CHOICE. Nothing here picks a colour, a prefix or a threshold; nothing there derives a figure. A field this side cannot answer honestly is null, and null always means "omit", never "zero".

// The pro club, from the abbreviation table the app already holds (buildProTeamAbbrevs, the same source My Team reads). NULL when the pro-team schedule payload is not in this session's cache - the identity line then reads POS - GP with no dangling separator (ruled ). It is NOT taken from PROTEAM_CLUB_MAP in player-id-map.js, which looks like the obvious table and is the wrong one twice over: it holds hockey only, and it exists to join ESPN ids to another league's own club keys rather than to name a club on screen.
function proAbbrevOf(p, abbrevs) {
    if (!abbrevs || p.proTeamId == null) return null;
    return abbrevs.get(Number(p.proTeamId)) || null;
}

// "14 GP", or null to drop the segment. Null is the honest answer for FOOTBALL, which carries no games-played statistic at all (measured - see GAMES_PLAYED_IDS in rank-engine.js), and a dash under a GP heading would claim the number is merely missing for these players.
function gpLabelFor(p, ctx) {
    if (!ctx.showGames) return null;
    const games = gamesPlayedOf(p, ctx.sport, ctx.wantPitchers);
    if (games === null || games === undefined) return null;
    return `${formatStatValue(games)} GP`;
}

// Fantasy points per game, for POINTS leagues only. A category league has no points concept at all - its Rank score already fills exactly this role, "how good per unit of opportunity" - so the column is absent there rather than zero. THIS IS ESPN'S OWN NUMBER, not a division this code performs, which is what lets football have the column at all: football carries no games-played STATISTIC (measured, GAMES_PLAYED_IDS), so there is nothing here to divide by - but ESPN still publishes appliedAverage on the season line. VALIDATED that appliedAverage is per game PLAYED rather than per league week, which is the one assumption the figure rests on: across the football capture, all 1,091 season lines carry the field, and for every one of the 647 with a nonzero average appliedTotal/appliedAverage comes out a clean integer between 1 and 18 - no exceptions. A per-WEEK average would have divided by the league's 16 matchups or the season's 18 periods uniformly, not by a per-player count that ranges across the whole 1..18 span. A zero average reads as ABSENT rather than as a measured zero. It cannot distinguish "never played" from "played and scored nothing", and the app's standing rule is that an unknown is not a zero - the same reason a missing rate category is not treated as 0.00. The season total, for POINTS leagues only - the figure the league is literally scored on, and the headline of a football row. Null for a category league, which has no points concept. It prefers the ENGINE'S score over the raw appliedTotal, matching what the outgoing table printed exactly: computePointsRanks reproduces ESPN's own appliedTotal (validated across 2,033 lines in two pools), so the two agree, and preferring the engine keeps one source of truth for the number the rows are also sorted by. The raw total is the fallback for a player the engine did not score.
function totalOf(p, ctx) {
    if (!ctx.isPointsLeague) return null;
    const scored = ctx.rotoRanks && ctx.rotoRanks.scores ? ctx.rotoRanks.scores.get(p.id) : undefined;
    if (scored !== undefined) return scored;
    const raw = Number(p.appliedTotal);
    return Number.isFinite(raw) ? raw : null;
}

function ptsPerGameOf(p, ctx) {
    if (!ctx.isPointsLeague) return null;
    const avg = Number(p.appliedAverage);
    if (!Number.isFinite(avg) || avg <= 0) return null;
    return avg;
}

// One cell per shown category. The percentile comes from THE ENGINE'S OWN byCategory map - the draft board's precedent - and is passed through untouched: it already reads high-is-good for an inverse category, so re-deriving or flipping it here would undo the engine's work and disagree with every other tinted surface. R4/S34: pct used to be null for every POINTS league, unconditionally - byCategory was read off rotoRanks itself, and a points league's rotoRanks IS computePointsRanks' output, which has no per-category percentile to give. But a stat's percentile within the pool exists in any league type (the pool does not stop having a distribution because the league sums it into points instead of a roto score), so ctx.categoryPct now carries a roto-style byCategory map computed FOR THE TINT ALONE, in every league type - real category-league output reused as-is, a second pass's output in a points league. The row's own rank/score still comes from ctx.rotoRanks, untouched - only the cell tint reads this second source. estimated is always false HERE. The estimator (estimateUnprojected) belongs to the draft board's projected lines; this surface prints real season totals, so nothing on it is estimated. The field is still emitted rather than omitted, because the shape is frozen and a reader of a captured row should see the answer rather than infer it from absence.
function cellsFor(p, ctx) {
    const cats = ctx.categoryPct ? ctx.categoryPct.get(p.id) : null;
    const rateIds = ctx.rateIds || new Set();
    return ctx.statIds.map(id => ({
        id,
        label: ctx.statMap[id] || id,
        value: formatStatValue(p.seasonTotals[id], rateIds.has(id)),
        pct: (cats && cats.has(id)) ? cats.get(id) : null,
        estimated: false,
        inverse: ctx.inverseIds.has(id)
    }));
}

// The rank, or NULL for a player the engine will not rank. Unranked is not a rare state: with Minimum Games Played off - the toggle that makes the leaderboard "show me everyone" - 882 of 1,487 rows were unranked on the real baseball capture, and each shows a dash today. tied is always FALSE from this surface, deliberately rather than dead by accident. The engine assigns strictly sequential positions (rank i+1 by sorted order), so no displayed rank is ever shared even when two scores are equal. Emitting T for equal scores would be a NEW claim this surface has never made, against a rebuild whose bar is that content is identical and only presentation changes.
function rankOf(p, ctx) {
    const label = ctx.rotoRanks && ctx.rotoRanks.ranks.get(p.id);
    if (label === undefined || label === null) return null;
    return { label, tied: false, gold: label === 1 };
}

// S41/F1: the Matchup rank, or null for a player matchup-rank.js could not measure (absent from its byId - too few of the pool's categories had a figure to measure a shift from, per O38's own contract). UNLIKE rankOf's `tied: false`, a tie here is a real, observed state: matchup- rank.js sorts by winsPerWeek through rank-engine's own competitionRanks (1, 1, 3), so two players really can share a rank, and matchupRankTieCounts (computed once per render, not once per row) says whether this one does.
function matchupRankOf(p, ctx) {
    if (!ctx.matchupRanks) return null;
    const entry = ctx.matchupRanks.byId[p.id];
    if (!entry) return null;
    const tied = (ctx.matchupRankTieCounts.get(entry.rank) || 0) > 1;
    return { winsPerWeek: entry.winsPerWeek, rank: { label: entry.rank, tied } };
}

// The rostered share, or null when the column is filler. ESPN collapses percentOwned the same way it collapses ADP out of season, so the column runs through the same degenerate test the draft board already trusts: one value covering more than a third of the pool is not a measurement. Only the rows carrying the filler value go null - a pool where most players share 0% still has real figures for the players who do not.
export function rosteredFillerFor(players) {
    return degenerateValue((players || []).map(p => Number(p.rosterPct)).filter(Number.isFinite));
}

function rosteredOf(p, ctx) {
    const pct = Number(p.rosterPct);
    if (!Number.isFinite(pct)) return null;
    if (ctx.rosteredFiller !== null && ctx.rosteredFiller !== undefined && pct === ctx.rosteredFiller) return null;
    return { pct, change: Number(p.rosterChange) || 0 };
}

// One row, to the frozen contract. Every input arrives through ctx rather than being read from AppState in here, which is what lets the whole model be tested against a hand-built context. THE LEAGUE'S PLAYOFF ROUNDS, and how many games each club plays in them. Memoised on the league payload and the cached schedule together, because the alternative is walking 32 clubs' seasons once per row for three thousand rows. It lives here rather than in draft-view.js, where it was written, because TWO surfaces read it now - the draft board's hover and the leaderboard's playoff lens - and a view must never import another view. players.js already owns the matchup-period map both of them slice by, so this is where the pair of them can share one answer instead of keeping two.
let playoffDensityCache = { key: null, rows: null };
export function playoffDensityRows() {
    const data = currentProSchedule();
    const league = AppState.apiData;
    if (!data || !league || !league.schedule) return null;
    // THE CACHE KEY IS THE LEAGUE, and only the league. This interpolated the schedule STORE's key until 56537d4 replaced the store read with currentProSchedule() and left the name behind - a ReferenceError that could only fire once a schedule was actually in hand, because the guard above returns first when there is none. That killed every leaderboard re-render the moment the lazy fetch landed, in every sport, which is how a missing club abbreviation was really a render that never completed. Restoring the store read would add nothing: that key spelled `proTeamSchedules:<sport>:<year>`, which is constant for a league, while league.id and league.seasonId below pin the same thing more precisely. And it stood for "this body belongs to this league's sport and year" - which is now the condition proScheduleFor ENFORCES before returning a body at all, so the check it was making cannot fail here any more.
    const key = `${league.id}|${league.seasonId}`;
    if (playoffDensityCache.key === key) return playoffDensityCache.rows;

    // The league's OWN playoff matchups, off playoffTierType. A roto league has none, a league whose bracket ESPN has not drawn yet has none, and in both cases the honest board says nothing rather than inventing rounds from the settings.
    const matchups = playoffMatchups(league.schedule);
    let rows = null;
    if (matchups.length) {
        // Days come from the league's own schedule, never settings.matchupPeriods - that field holds WEEK indices, and slicing a pro-team schedule with it is wrong by a factor of seven. See schedule-insight.js.
        const map = buildMatchupPeriodMap(league.schedule, league.status, league.settings);
        rows = densityAcrossMatchups((data.settings || {}).proTeams,
            matchups.map(m => ({ matchup: m, periods: periodsOfMatchup(map, m) })));
    }
    playoffDensityCache = { key, rows };
    return rows;
}


// A PLAYER'S PROJECTED LINE PER GAME. projectedTotals holds counting totals AND rate values side by side, so only the counting ones are divided - a projected.280 average is already per game, and dividing it by 150 would produce a figure with no meaning that still sorts. Null when the projection carries no games: a per-game rate needs a denominator, and inventing one is how a player with a partial projection outranks a full one.
function projectedPerGame(p, gamesId, rateIds) {
    const totals = p && p.projectedTotals;
    if (!totals) return null;
    const games = Number(totals[gamesId]);
    if (!Number.isFinite(games) || games <= 0) return null;
    const out = {};
    Object.keys(totals).forEach(id => {
        const v = totals[id];
        if (v === null || v === undefined) return;      // null before Number
        const n = Number(v);
        if (!Number.isFinite(n)) return;
        out[id] = rateIds.has(String(id)) ? n : n / games;
    });
    return out;
}

// EVERYTHING THE TIME-LENS COLUMN NEEDS, computed ONCE per render rather than per row: the playoff rounds, the current matchup and the one after it, the day labels, and the whole pool's ranking of window-projected lines. Every one of these is a whole-pool or whole-league answer, and the density walk alone is every club's season. Returns nulls rather than throwing when the pro schedule is not in this session - which is the normal case on a cold load, since nothing on this tab fetches it (see the lens note in renderPlayerLeaderboard). O27/S30: the tab bar's own Next/Rest pills need to know whether either is greyable BEFORE a leaderboard render has happened (controls.js builds the tab bar for every tab, not just this one) - a lean existence check over the same schedule atoms timeLensContext uses, rather than that function itself, which also walks the whole player pool for playoff ranks and open-seat coverage neither pill cares about. Kept in lockstep with timeLensContext's own next/rest by construction: both read matchupPeriodMap/periodsOfMatchup/finalScoringPeriodOf, never a second copy of a rule. S30b (owner ruling): Next is a STRUCTURAL question ("is there a matchup after this one") that a roto league can never answer yes to - roto has no matchup periods at all (timeLensContext's own comment), not a schedule gap that might later resolve. So its reason is unconditional and wins over every schedule-state branch below, rather than falling through to "Schedule not loaded" or "No matchup after this one" - both of which would still imply a matchup might exist. Rest needs NO matchup (today through the league's final period off the club schedule alone), so it keeps asking the ordinary schedule-existence question for every league type, roto included.
export function aheadReasons() {
    const reasons = {};
    if (AppState.isRotoLeague) reasons.next = 'This league has no matchups.';
    const scheduleAttempted = proScheduleAttempted();
    const schedules = currentProSchedule();
    if (scheduleAttempted && !schedules) {
        if (!reasons.next) reasons.next = 'Schedule not loaded.';
        reasons.rest = 'Schedule not loaded.';
        return reasons;
    }
    if (!scheduleAttempted) return reasons;
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    if (!AppState.isRotoLeague) {
        const map = matchupPeriodMap();
        const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
        const hasNext = !!(proTeams && map && current != null && periodsOfMatchup(map, current + 1).length);
        if (!hasNext) reasons.next = 'No matchup after this one.';
    }
    const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
    const final = finalScoringPeriodOf(AppState.apiData);
    const hasRest = !!(proTeams && todayPeriod && final && final >= todayPeriod);
    if (!hasRest) reasons.rest = 'No games left this season.';
    return reasons;
}

function timeLensContext(players, sport, wantPitchers, statIds) {
    const schedules = currentProSchedule();
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    const rateIds = new Set([...(AVERAGE_STATS[sport] || new Set())].map(String));
    const gamesId = gamesIdFor(sport, wantPitchers);
    const playoffRows = playoffDensityRows();

    // THE WINDOW LINE RANK. A points league ranks the window by one number; a category league has no such number, so each player's projected line over the window is ranked against the others through the engine's own percentile atom. Only possible once the schedule says how many games each club plays, so it is absent with the schedule rather than faked.
    let playoffRanks = new Map();
    if (playoffRows && gamesId !== undefined && !AppState.isPointsLeague) {
        const lines = [];
        (players || []).forEach(p => {
            const outlook = playoffOutlook(playoffRows, p.proTeamId, {});
            if (!outlook || !outlook.games) return;
            const perGame = projectedPerGame(p, gamesId, rateIds);
            if (!perGame) return;
            lines.push({ id: p.id, line: windowProjectedLine(perGame, outlook.games, rateIds) });
        });
        playoffRanks = windowLineRanks(lines, {
            categoryIds: statIds,
            inverseIds: new Set([...(INVERSE_STATS[sport] || new Set())].map(String)),
            rateIds
        });
    }

    // THIS MATCHUP AND THE NEXT ONE. The days come from the league's own schedule through periodsOfMatchup, never settings.matchupPeriods - that field holds WEEK indices and slicing a pro-team schedule with it is wrong by a factor of seven.
    const map = matchupPeriodMap();
    const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
    const labelOf = schedules ? dayLabelerFor(datesByScoringPeriod(schedules)) : null;

    // WHO IS A STARTING PITCHER, AND HOW FAR AHEAD ESPN HAS LISTED. Both come out of one pass over the pool's own probable listings, because both are properties of the same data and computing them apart is how they drift. A player with a probable ANYWHERE this season is a starter. MEASURED on the live capture: 351 of a 3,000-player pool carry one and every reliever checked carries none, so it separates the rotation from the bullpen without a stat id to validate (golden rule 4). The HORIZON is the furthest day any probable falls on - 174 in that capture, against a season running to 187. A window ending past it cannot be counted in starts: counting would find the eleven days ESPN has posted and report them as the whole of a twenty-four day window.
    const gameIndex = schedules ? buildGamePeriodIndex(schedules) : null;
    const starterIds = new Set();
    let probableHorizon = null;
    if (gameIndex) {
        (players || []).forEach(p => {
            const listed = p && p.starterStatusByProGame;
            if (!listed) return;
            Object.keys(listed).forEach(gameId => {
                if (listed[gameId] !== 'PROBABLE') return;
                starterIds.add(p.id);
                const game = gameIndex.get(String(gameId));
                if (game && (probableHorizon === null || game.period > probableHorizon)) probableHorizon = game.period;
            });
        });
    }
    // Today, so played and remaining can be told apart. A game on today counts as remaining.
    const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
    // density feeds matchupWindow's offNight count - the league-wide "how many clubs play this day" table, over the SAME days the window itself covers, so a game on a three-club night reads as one regardless of which lens is asking. Each lens carries the starts ESPN has listed inside its own days, and the last day it covers - lensRowFor needs both to decide whether this window may be counted in starts at all.
    const startsIn = (periods) => {
        if (!gameIndex || !periods.length) return null;
        const window = { start: periods[0], end: periods[periods.length - 1] };
        return countProjectedStarts(players || [], gameIndex, window, todayPeriod).byPlayer;
    };
    const buildLens = (matchup) => {
        if (!proTeams || !map || !matchup) return null;
        const periods = periodsOfMatchup(map, matchup);
        if (!periods.length) return null;
        return {
            matchup, periods,
            byTeam: gamesByProTeamForMatchup(proTeams, periods),
            density: offNightsForMatchup(proTeams, periods),
            startsByPlayer: startsIn(periods),
            end: periods[periods.length - 1]
        };
    };
    // REST OF SEASON, replacing the old Playoffs lens: no new atom, per the ruling - gamesByProTeamForMatchup takes any list of days, and [today.. finalScoringPeriod] is that list. matchup stays null; a rest window spans every remaining round and belongs to none of them (the same reason playoff.byRound sums instead of naming one matchup).
    const buildRestLens = () => {
        const final = finalScoringPeriodOf(AppState.apiData);
        if (!proTeams || !todayPeriod || !final || final < todayPeriod) return null;
        const periods = [];
        for (let p = todayPeriod; p <= final; p++) periods.push(p);
        if (!periods.length) return null;
        return {
            matchup: null, periods,
            byTeam: gamesByProTeamForMatchup(proTeams, periods),
            density: offNightsForMatchup(proTeams, periods),
            startsByPlayer: startsIn(periods),
            end: periods[periods.length - 1]
        };
    };
    const windowLens = buildLens(current);
    return {
        playoffRows,
        playoffRanks,
        labelOf,
        todayPeriod,
        window: windowLens,
        next: buildLens(current === null ? null : current + 1),
        rest: buildRestLens(),
        starterIds,
        probableHorizon,
        // S14: "Empty nights" - the leaderboard's own reading of item 3's free-agent half (openSeatNights in schedule-insight.js). THIS MATCHUP ONLY: the question a manager is actually asking is "who fills tonight's hole", not a hypothetical two rounds out, so unlike window/next/rest this lens does not offer a choice of span.
        openSeatsCoverage: myOpenSeatsCoverage(sport, wantPitchers, windowLens),
        openSeatsProTeams: proTeams
    };
}

// "Which nights is MY lineup empty", computed once per render the same way myteam.js's own nights band is - the same startingSlotsByGroup capacity, the same rosterNightCoverage atom - so "how many seats" means one thing in both places. HOCKEY ONLY (the question only has a question mark in a sport whose clubs play different nights, the same rule the nights band keeps), and only over THIS MATCHUP's own days (windowLens).
function myOpenSeatsCoverage(sport, wantPitchers, windowLens) {
    if (sport !== 'fhl' || !windowLens) return null;
    const proTeams = currentProSchedule()?.settings?.proTeams;
    if (!proTeams) return null;
    // S14b: resolveMyTeamId, not a strict findOwnedTeamId-only lookup - My Team already answers "which team is mine" with a stand-in when no SWID matches (whoever standings puts first), and this lens asking a STRICTER question than the tab beside it is exactly how it ended up greying "no lineup" in the same session My Team confidently showed one.
    const myTeamId = resolveMyTeamId(AppState.apiData?.teams, AppState.userSwid, AppState.teamStats).id;
    const myTeam = (AppState.apiData?.teams || []).find(t => t.id === myTeamId);
    const entries = myTeam?.roster?.entries;
    if (!entries || !entries.length) return null;
    const poolById = new Map((AppState.playerData || []).map(p => [p.id, p]));
    const counts = AppState.apiData.settings?.rosterSettings?.lineupSlotCounts || {};
    const slots = startingSlotsByGroup(counts, {
        nonStarting: NON_STARTING_SLOTS[sport],
        secondary: SECONDARY_LINEUP_SLOTS[sport]
    });
    const roster = entries
        .map(e => poolById.get(e.playerId))
        .filter(p => p && (wantPitchers ? playerRoleGroups(p, sport).secondary : playerRoleGroups(p, sport).primary))
        .map(p => ({ id: p.id, proTeamId: p.proTeamId }));
    if (!roster.length) return null;
    return rosterNightCoverage(roster, proTeams, windowLens.periods, { slots: wantPitchers ? slots.secondary : slots.primary });
}

// The playoff window for one player, with the rank the category-league lens is ordered by. projected stays null in a category league (there is no single per-game number to multiply) and rank stays null in a points league (which has projected instead) - each format gets the figure that means something in it, and neither gets one invented.
function playoffRowFor(p, ctx) {
    const out = playoffOutlook(ctx.playoffRows, p.proTeamId, {
        perGame: ptsPerGameOf(p, ctx),
        trend: ctx.trendIcons?.get(p.id)?.dir || null
    });
    if (!out) return null;
    out.rank = (ctx.lens && ctx.lens.playoffRanks.get(p.id)) || null;
    return out;
}

// One matchup's window for one player. `starts` is a ROLE fact, not a sport one: a pitcher with a probable listing has a count, and everyone else has null rather than 0 - a skater has no starts to have none of. AND THE UNIT THE WINDOW IS COUNTED IN. A starting pitcher's window is his STARTS, not his club's games: the column told a manager his ace had "9 of 13 games left" in a matchup the ace appears in twice. Both conditions have to hold - he is a starter, and ESPN has listed every day this window covers - or the club's games remain the only honest count available. Everyone else, batters and relievers alike, keeps games; a closer does not pitch every night either, and his share is a figure this row has no way to compute (see projected-basis.js).
function lensRowFor(p, ctx, lens) {
    if (!lens) return null;
    // countProjectedStarts keys its per-player entry { starts, remaining, games }; the row contract (tests/fixtures/leaderboard-row.md) names the same pair { total, remaining }. Adapted HERE, at the seam, rather than by widening either side - the renderer reads `total` and printed "undefined starts" the moment this lens started supplying a count at all.
    const listing = (lens.startsByPlayer && lens.startsByPlayer.get(p.id)) || null;
    const starts = listing ? { total: listing.starts, remaining: listing.remaining } : null;
    const listed = ctx.lens.probableHorizon !== null && ctx.lens.probableHorizon !== undefined
        && Number.isFinite(lens.end) && lens.end <= ctx.lens.probableHorizon;
    return matchupWindow(lens.byTeam, p.proTeamId, {
        matchup: lens.matchup,
        periods: lens.periods,
        labelOf: ctx.lens.labelOf,
        fromPeriod: ctx.lens.todayPeriod,
        starts,
        countStarts: !!(starts && listed && ctx.lens.starterIds && ctx.lens.starterIds.has(p.id)),
        density: lens.density
    });
}

export function buildLeaderboardRowModel(p, ctx) {
    return {
        id: p.id,
        name: p.name,
        proAbbrev: proAbbrevOf(p, ctx.abbrevs),
        posLabel: p.positionDisplay,
        gpLabel: gpLabelFor(p, ctx),
        injuryStatus: p.injuryStatus || null,
        // R7: suppressed pre-draft, where nobody has been picked yet and the chip would sit on every single row - a fact every row wears says nothing, so the caller (never this function - it stays a truthful !p.teamId otherwise) tells it to say nothing instead.
        isFreeAgent: ctx.suppressFreeAgentChip ? false : !p.teamId,
        rank: rankOf(p, ctx),
        matchupRank: matchupRankOf(p, ctx),
        total: totalOf(p, ctx),
        ptsPerGame: ptsPerGameOf(p, ctx),
        cells: cellsFor(p, ctx),
        rostered: rosteredOf(p, ctx),
        // The playoff lens. Null whenever the league has no bracket drawn, the pro schedule is not in this session, or this player has no club the schedule knows - three different absences, one honest answer, and never a zero line.
        playoff: playoffRowFor(p, ctx),
        // This matchup and the one after it. Same builder for both - they are the same question asked of two different windows - and null on either omits that lens's column.
        window: lensRowFor(p, ctx, ctx.lens?.window),
        next: lensRowFor(p, ctx, ctx.lens?.next),
        // item 2/O11, replacing the old Playoffs lens - see timeLensContext's buildRestLens.
        rest: lensRowFor(p, ctx, ctx.lens?.rest),
        // S14: "Empty nights". openSeatNights itself refuses for a rostered player (isFreeAgent false) - that refusal is exercised here rather than gated a second time, so this stays the one place the rule lives.
        openSeats: openSeatNights(p, ctx.lens?.openSeatsProTeams, ctx.lens?.openSeatsCoverage, {
            isFreeAgent: ctx.suppressFreeAgentChip ? false : !p.teamId
        })
    };
}

export function renderPlayerLeaderboard() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    // THE CLUB SHOWS ON LOAD. ruled the pro-team schedule was fetched on lens activation and never on load, and the owner OVERRULED it for this one request: until the click there was no club, no crest and no pro chip on the strip, so the first thing a reader saw was a table missing the one fact that says who these players are. the lever stands everywhere else - this is one cached GET per league per session. Safe to call on every render, and cheap: ensureProScheduleData dedupes by league key, returns the resolved body once it has one, and re-renders this table itself when the answer lands. The re-render calls back in here and the guard short-circuits, so there is no loop - and a FAILED fetch is remembered too (the ready key is set with a null body), so a league ESPN will not answer for is asked once and not on every keystroke. My Team already fetched it unconditionally on its own render, so "never on load" had in truth only ever applied to one tab of the two.
    ensureProScheduleData();

    // EVERY COLUMN HERE IS A CATEGORY, and the Rank beside them is an average over those categories. Without validated ids the app cannot name a column, cannot tell a rate from a counting stat, and cannot tell which way is better - so a table of real numbers under unvalidated headings would be confidently wrong, which golden rule 4 exists to stop. The pool still loads and the capture still downloads: this hides the scoring, not the league.
    if (!categoriesMapped(AppState.loadedSport)) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(unmappedCategoriesNote(AppState.loadedSport))}</div>`;
        const toggle = document.getElementById('player-group-toggle');
        if (toggle) { toggle.innerHTML = ''; toggle.style.display = 'none'; }
        return;
    }

    // Returning silently here used to leave whatever was already painted on screen, which after a league switch is the PREVIOUS league's rows. processCoreData clears playerDataLoaded, and every direct caller (timeframe pills, filters, sorts) then hit this early return and left the stale table sitting there. Painting the loading state instead means no caller can leave another league's players visible, and callers stop needing to know the load state. Deliberately NOT showPlayerLoadingProgress. That starts a rAF loop and an interval, and this function runs on every keystroke/sort/filter, so repeat calls would stack timers. A static line is idempotent. It also yields to a progress bar already running (loadPlayerTabIfNeeded owns that richer indicator) rather than replacing it mid-animation. No fetch is started from here - whoever cleared playerDataLoaded owns reloading the pool.
    if (!AppState.playerDataLoaded) {
        const playerView = document.getElementById('view-player');
        const onScreen = playerView && playerView.style.display !== 'none';
        if (onScreen && !container.querySelector('.player-loading, .player-loading-progress')) {
            container.innerHTML = `<div class="player-loading">${buildLoadingHtml()}</div>`;
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
    const wantPitchers = currentGroupIsSecondary(sport);
    // IP is a baseball-pitcher-only column (hockey's secondary group is goalies - no innings). A COLUMN OF DASHES IS NOT A COLUMN. Football carries no games-played statistic at all (measured - see GAMES_PLAYED_IDS), so the header goes with the values rather than standing over an empty strip pretending the number is merely missing for these players.
    const showGames = gamesPlayedKnown(sport);
    const showInnings = wantPitchers && sport === 'flb';
    // PRESEASON RANKS AND SHOWS PROJECTIONS. Applied to the pool itself rather than to the ranking call alone, so the Rank column and the totals beside it are computed from one line - a table ranked on projections while printing last season's actuals is worse than either half on its own.
    const basis = preseasonBasisCtx(sport, wantPitchers);
    const groupPlayers = preseasonBasisOf(getEffectivePlayerPool(sport), basis)
        .filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const { scored, advanced } = statIdsForGroup(sport, activeGroupFor(sport), groupPlayers);
    const statIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;

    const query = AppState.playerSearchQuery.trim().toLowerCase();
    const posFilter = AppState.playerPositionFilter;

    // Team breakout tabs read PRE-breakout, so a search or availability filter that leaves three players offers tabs for those three players' own teams, not all 30 in the league - computed before matchesBreakout narrows further below, the same "what could I still pick" shape a filter's own options always show.
    const preBreakoutPlayers = groupPlayers.filter(p => {
        if (query && !p.name.toLowerCase().includes(query)) return false;
        if (posFilter !== 'ALL' && !matchesPositionFilter(p, posFilter)) return false;
        if (!matchesAvailability(p)) return false;
        return true;
    });
    renderBreakoutTabs(preBreakoutPlayers);

    let players = preBreakoutPlayers.filter(p => matchesBreakout(p));

    // "Total" (ESPN's real appliedTotal) only exists for points-format leagues. Category leagues get a computed roto-style rank instead - not ESPN's raw "FPTS" stat, which turned out to be some generic points formula unrelated to this league's actual scoring settings (and doesn't exist for pitchers at all). Default sort falls back to this rank rather than all the way back to name. Ranked against ALL batters (or pitchers) by default, but scoped down to just the filtered position when one's selected - "best SS" only means something when compared against other SS-eligible players, not the whole player pool (a corner-infield-only slugger could easily out-rank every real SS overall while being irrelevant to "who's the best shortstop").
    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = computeLeagueRanks(rankPool, sport, posFilter, wantPitchers, unknownIdsFor(basis));
    // R4/S34, MEASURED: the NFL preseason leaderboard's cells were untinted not because of the preseason basis (a category league's preseason rows tint exactly like its played ones) but because it is a POINTS league - computePointsRanks (above, via computeLeagueRanks) has no per-category percentile to give, which cellsFor's own comment already documented as deliberate. But a stat's percentile within the pool is a fact about the POOL, not about which formula sums it into one overall score, so a points league's cells still deserve the same tint every category league's do. A second, roto-style pass supplies exactly that - its own rank/score output is thrown away below, only byCategory is read - rather than reworking cellsFor to understand two different ranking shapes.
    const categoryTintRanks = AppState.isPointsLeague
        ? computeRotoRanks(rankPool, sport, posFilter, wantPitchers, unknownIdsFor(basis))
        : rotoRanks;

    // S41/F1 (O38): the Matchup column, computed ONCE per render like every other whole-pool answer above it. The pool is the same rankPool the Overall Rank is scoped to (position filter included), narrowed to the players IT actually ranked - matchup-rank.js's own contract: "a rank 'of 464' must mean the same 464 in both columns or the two ranks are not comparable". leagueMargins refuses cheaply (before any schedule scan) for roto/points/too-few-matchups, so there is no format guard needed here beyond reading its own reason.
    const matchupCtx = matchupRankCtxFor(rankPool, sport, wantPitchers);
    const matchupRefusal = leagueMargins(AppState.apiData, matchupCtx);
    const matchupQualifiedPool = rotoRanks ? rankPool.filter(p => rotoRanks.ranks.has(p.id)) : [];
    const matchupRanks = matchupRefusal.margins
        ? computeMatchupRanks(matchupQualifiedPool, matchupRefusal.margins, matchupCtx)
        : null;
    // Ties genuinely happen here (competitionRanks' own 1,1,3 convention, unlike the Overall column's strictly-sequential rank - see rankOf's own comment) - counted once so matchupRankOf never re-scans the whole pool per row.
    const matchupRankTieCounts = new Map();
    if (matchupRanks) {
        Object.values(matchupRanks.byId).forEach(m => {
            matchupRankTieCounts.set(m.rank, (matchupRankTieCounts.get(m.rank) || 0) + 1);
        });
    }
    const showMatchupRank = !!matchupRanks;

    // With Minimum Games Played ON, rotoRanks.ranks holds exactly the players who cleared the threshold - hide the rest from the table entirely, rather than showing a row with a "Min GP" placeholder no one asked to see. With it OFF the user has explicitly asked to see the marginal players, so the ones the engine STILL won't rank (only the zero-games cohort now - see computeRotoRanks' zero floor, ) are kept and pushed below every ranked row with a "-" instead of a rank, rather than vanishing from the one view whose job is "show me everyone".
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));

    renderAdvancedStatsToggle(advanced.length);
    renderMinPlayingTimeToggle(rankPool, sport);
    if (AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }

    sortLeaderboardPlayers(players, rotoRanks, sport, wantPitchers, matchupRanks);

    if (players.length === 0) {
        container.innerHTML = '<div class="player-loading">No players match your search/filter.</div>';
        return;
    }

    const sortArrow = (key) => AppState.playerSortStat === key ? (AppState.playerSortDir === 'asc' ? ' ▲' : ' ▼') : '';

    // Medals for the current pool's top 3 (the ranks are already scoped to the active position filter via rankPool, so "top 3 SS" gets medals under an SS filter) plus weekly-form arrows (see buildMatchupTrendIcons) - both live in the Rank column, which points leagues don't have.
    const trendIcons = AppState.isPointsLeague ? new Map() : buildMatchupTrendIcons(players, sport);
    // THE TIME-LENS COLUMN'S WHOLE-POOL ANSWERS, once per render. The pro schedule this needs is NOT fetched here: nothing on this tab asks for it, so on a cold session every lens is null and the column is absent, which is the honest state rather than a blank one. See item 3.2.
    const lens = timeLensContext(players, sport, wantPitchers, statIds);
    // GREYED WITH THE REASON once the schedule attempt has actually resolved (AppState. proTeamSchedules exists) - the same treatment the timeframe chips already give a window the current span is too short for. Before that, every lens stays enabled and unlabelled: the schedule has not been asked for yet, so "no matchup after this one" would be a guess, not an answer - and disabling on load would kill the click that fetches it. A header claiming a column of blank cells (Next matchup with no matchup 23 to show) is the same fault the data lane fixed for the playoff header; the button that would lead there is disabled instead. Computed here, before the lens is read for the rows and the header below, so a fallback (the active lens landing on a reason it did not have when it was picked - a league whose season just ended, say) is the SAME AppState.ahead every part of this render sees, not a toggle showing "This matchup" over a header still claiming "Next Matchup". O27/S30: next/rest reasons are aheadReasons()' own now - the tab bar's pills (controls.js) and this render read the exact same lensReasons.next/lensReasons.rest, so a fallback here can never disagree with the greyed state the pill itself is showing.
    const lensReasons = aheadReasons();
    // S14/S14b: "Empty nights" greys for three DIFFERENT reasons, told apart rather than folded into one catch-all - a sport whose clubs all play the same nights has no question here at all; a league with no current matchup (a finished season, same cause `rest` already names for the schedule's own end) has no "this matchup" to check nights against regardless of whose lineup is being asked about; only once both of those clear does a missing roster become the real answer, and by then resolveMyTeamId's own stand-in has already tried. O27/S30: unaffected by ahead - Empty Nights is scoped to "this matchup" only (lens.window), a deliberate narrowing rather than extending the question across Next/Rest too.
    if (sport !== 'fhl') {
        lensReasons.openSeats = 'Hockey only - every other sport plays on the same nights.';
    } else if (!lens.window) {
        lensReasons.openSeats = 'No matchup right now to check nights against.';
    } else if (!lens.openSeatsCoverage) {
        lensReasons.openSeats = 'No lineup to compare against yet.';
    }
    // A fallback for each independently, never a mutual clobber - a stale 'next' choice on a finished season falls back to null the same way a stale Empty Nights choice unchecks itself, but neither loss should take the other state down with it.
    if (lensReasons[AppState.ahead]) AppState.ahead = null;
    if (AppState.showEmptyNights && lensReasons.openSeats) AppState.showEmptyNights = false;
    // The resolved column: Empty Nights only when chosen AND no ahead window is active (both name "which window", so only one can hold the column at once) - the tab bar's own Current/Next/ Rest pills said as much when the owner ruled it a MEASURE TOGGLE, not a fourth window state.
    const resolvedLens = (AppState.showEmptyNights && AppState.ahead === null) ? 'openSeats' : (AppState.ahead || 'window');
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

    // A move under a point in a week is churn, not a trend - the figure stays off the surface entirely rather than printing a +0.3 nobody asked to read.
    const rosterCellHtml = (p) => {
        const change = p.rosterChange || 0;
        if (Math.abs(change) < 1) return `${p.rosterPct.toFixed(1)}%`;
        const dir = change >= 0 ? 'up' : 'down';
        const sign = change >= 0 ? '+' : '';
        return `${p.rosterPct.toFixed(1)}% <span class="rostered-change rostered-${dir}">${sign}${change.toFixed(1)}</span>`;
    };

    // The row model's own opts, matching the four functions the contract names so the wiring is a direct pass rather than an adapter. sortArrow is this file's existing one, so the header's arrows and the table's sort state cannot disagree.
    const rowOpts = (withPhoto) => ({
        escapeHtml,
        avatarHtml: withPhoto
            ? (id, name) => buildPlayerAvatarHtml(sport, id, name)
            : (id, name) => `<span class="player-avatar"><span class="avatar-initials">${escapeHtml(initialsFor(name))}</span></span>`,
        // Not gated by the photo budget - a 20px logo is a much smaller request than a headshot, and every row already carries the abbreviation as text (the meta line), so the mark beside the name is the same fact drawn twice at negligible extra cost, not a second thing to budget.
        logoHtml: (proAbbrev) => buildProTeamLogoHtml(sport, proAbbrev),
        // R5: a D/ST row's identity swaps to this crest entirely (leaderboard-row.js's own isProTeamUnit gate) - the same builder the club-crest rail already uses, at the avatar's own size (buildProTeamCrestHtml shares.player-avatar/.avatar-img with buildPlayerAvatarHtml).
        proTeamCrestHtml: (proAbbrev) => buildProTeamCrestHtml(sport, proAbbrev),
        injuryBadgeHtml,
        sortArrowHtml: sortArrow,
        // R1/S49: the drill-down and the compare picker both need a first game to have anything to show ("useless like my team during the preseason" - the owner's own words); basis.preseason is isPreseason(seasonState(...)) exactly (preseasonBasisCtx's own field), the same condition the ruling names.
        interactive: !basis.preseason
    });

    // IP is a baseball-pitcher column with no home in the row model, and needs none: the contract's cell value is a preformatted STRING, so the innings formatting is applied here and the cell travels like any other. It leads the cells because that is where the column sat.
    const ipCellFor = (p) => ({
        id: 'ip', label: 'IP', value: formatInnings(p.seasonTotals[IP_STAT_ID]),
        pct: null, estimated: false, inverse: false
    });

    const modelCtx = {
        sport, wantPitchers, showGames, isPointsLeague: AppState.isPointsLeague,
        // R7: pre-draft only - the FA chip is meaningful again the moment rosters are real (the post-draft PRESEASON state), so this checks the exact state rather than reusing basis.preseason, which also covers that later state.
        suppressFreeAgentChip: seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT,
        statIds, statMap, inverseIds: INVERSE_STATS[sport] || new Set(),
        // S6: a category's own precision (counts as integers, rates as rates) - cellsFor's own fix.
        rateIds: AVERAGE_STATS[sport] || new Set(),
        // Null when the pro-team schedule payload is not in this session - the identity line then drops the club segment. Never fetched from here (ruled): one lazy fetch per session elsewhere, never one per render.
        abbrevs: currentProSchedule() ? buildProTeamAbbrevs(currentProSchedule()) : null,
        rotoRanks,
        // R4/S34: the tint's own source, separate from rotoRanks - in a points league rotoRanks IS the real (points-based) rank the row sorts and numbers itself by, and must stay that; categoryTintRanks is a second, roto-style pass computed only for its byCategory map. In a category league the two are the same object - no extra work, no second shape for cellsFor to learn.
        categoryPct: categoryTintRanks.byCategory,
        matchupRanks, matchupRankTieCounts,
        rosteredFiller: rosteredFillerFor(players),
        // Computed ONCE per render, not once per row: both are whole-pool answers, and the density walk in particular is 32 clubs' seasons.
        playoffRows: lens.playoffRows,
        trendIcons,
        lens
    };

    const headerCells = (showInnings ? [{ id: 'ip', label: 'IP' }] : [])
        .concat(statIds.map(id => ({ id, label: statMap[id] })));

    const budget = photoRowBudget();
    const rowsHtml = players.map((p, index) => {
        const model = buildLeaderboardRowModel(p, modelCtx);
        if (showInnings) model.cells.unshift(ipCellFor(p));
        return buildLeaderboardRowHtml(model, rowOpts(index < budget), resolvedLens, showMatchupRank);
    }).join('');

    const html = `<div class="lb-table">`
        + buildLeaderboardHeaderHtml({
            identityLabel: 'Player',
            // "Overall" once Matchup sits beside it (F1's own mockup) - the plain "Rank" default stays for every league this column is absent from, so a roto/points reader never sees a header renamed for a column that never shows up.
            rankLabel: `${showMatchupRank ? 'Overall' : 'Rank'}${posFilter !== 'ALL' ? ` (${escapeHtml(posFilter)})` : ''}`,
            showMatchupRank,
            // In a points league the slab in this column is the TOTAL, with points-per-game muted beneath it, so the heading names what the eye lands on.
            ptsPerGameLabel: AppState.isPointsLeague ? 'Total' : 'PTS/G',
            showPtsPerGame: AppState.isPointsLeague,
            // THE HEADER ONLY CLAIMS THE COLUMN WHEN THE ROWS CAN FILL IT. The row renderer omits the lens outright rather than drawing an empty placeholder, so a header emitted against no data would slide every stat column one place left of its own heading - which is exactly what it did before this line: AVG sat over the playoff figures. resolvedLens, not a hardcoded 'playoff' - the tab bar's real Current/Next/Rest/Empty Nights choice (null resolves to 'window' above, never absent by accident). R3: the guard this comment always DESCRIBED, now actually ENFORCED - resolvedLens was handed to the header unconditionally, so ANY league whose pro-team schedule has not loaded (the owner's report: only the preseason NFL tab, where the schedule genuinely never resolves before a draft; also measured on an in-season capture missing its own pro-schedule.json, the same root cause on a different capture) had lens.window null for every row while the header still claimed "This Matchup" - the exact bug this comment already named, just for a cause the original fix never hit. Measured: every category header sat 84px left of its own column, PYDS over TOTAL's own figures. openSeats reads its own coverage flag (already gated elsewhere); every other lens reads the same league-wide context object the rows are built from, so "can any row fill this" and "does the header claim it" read the identical fact.
            timeLens: (resolvedLens === 'openSeats' ? !!lens.openSeatsCoverage : !!lens[resolvedLens]) ? resolvedLens : null,
            showRostered: true,
            // R7: this was always ESPN's global percentOwned, never a figure this league computed - the dial's own hover already said so ("Rostered in X% of ESPN leagues"); the header now does too, in every state, not only preseason, since the number never changes meaning after a draft.
            rosteredLabel: 'ESPN rostered',
            cells: headerCells
        }, rowOpts(false))
        + rowsHtml
        + `</div>`;
    // R7: both preseason states rank and show projections (basis.preseason, preseasonBasisCtx above) - the tag names that basis so a table full of numbers nobody has actually put up does not read as though they have.
    const tagLineHtml = basis.preseason
        ? `<div class="pd-mast"><span class="pd-tag">PRESEASON &middot; PROJECTED</span>`
        + `<span class="pd-mast-note">Totals are ESPN's season projections.</span></div>`
        : '';
    // S41/F1: named ONLY on the two states that need a word about it - the column present (both header labels change meaning, so the legend says what each now means and that either sorts) or the column ABSENT with the contract's own reason (never greyed, per the brief - a league that cannot support this has no half-column to greet with a lock icon). Neither line shows for every OTHER column this file draws no legend for at all - this is new surface, not an existing habit extended.
    const matchupLegendHtml = showMatchupRank
        ? `<div class="lb-mrank-legend"><span><b>Overall</b> = the mean of ${matchupCtx.categoryIds.length} category percentiles.</span>`
        + `<span><b>Matchup</b> = category wins a week this line is expected to swing against this `
        + `league's own measured margins, all ${matchupCtx.categoryIds.length} categories; the rank `
        + `among ${matchupRanks.of} ${(wantPitchers ? groupLabels(sport).secondary : groupLabels(sport).primary).toLowerCase()}.</span>`
        + `<span>Click either heading to sort by it.</span></div>`
        : (matchupRefusal.reason
            ? `<div class="lb-mrank-legend lb-mrank-legend-absent">${escapeHtml(MATCHUP_RANK_REASON_TEXT[matchupRefusal.reason] || '')}</div>`
            : '');
    container.innerHTML = tagLineHtml + html + matchupLegendHtml;

    // EMPTY NIGHTS, the one MEASURE TOGGLE left in this slot - the Window choice itself moved to the tab bar's own Current/Next/Rest pills (controls.js), driving the shared AppState.ahead every part of this render already reads above. This slot now holds only the one lens that is not a window: a checkbox, not a segmented control, since there is nothing to choose between - it is either asked or it is not.
    const lensSlot = document.getElementById('lens-toggle-slot');
    // S21 (owner ruling): preseason has no "from here" to measure - the league has not started, so ABSENT, not greyed, same as it always was for this lens. R7/S45: the owner OVERRULED R9's own "greyed, with a reason on hover" for every OTHER case this control cannot apply in - every non-hockey league, a hockey league with no current matchup, or one with no lineup to compare against (lensReasons.openSeats' three causes) used to render a permanently-disabled checkbox on every single non-hockey league, which is a control that does nothing on almost every league this app loads. "Remove it" - ABSENT wherever it cannot apply, exactly the preseason branch's own existing rule, now covering every reason rather than only that one.
    if (lensSlot && (isPreseason(seasonState(AppState.apiData)) || lensReasons.openSeats)) {
        lensSlot.innerHTML = '';
    } else if (lensSlot) {
        lensSlot.innerHTML = `<label class="lb-empty-nights-toggle">`
            + `<input type="checkbox" id="lb-empty-nights"${AppState.showEmptyNights ? ' checked' : ''}>`
            + `Empty nights</label>`;
        const cb = lensSlot.querySelector('#lb-empty-nights');
        cb.addEventListener('change', () => {
            AppState.showEmptyNights = cb.checked;
            renderPlayerLeaderboard();
            ensureProScheduleData();
        });
    }

    // The header speaks the row model's own keys; this table's sort has spoken its own since long before. Mapped here rather than renamed on either side: 'rank' IS the roto score the rank is computed from, and in a points league the figure that column leads with is the total.
    const sortKeyFor = (key) => {
        if (key === 'rank') return 'rotoScore';
        if (key === 'ptsPerGame') return AppState.isPointsLeague ? 'total' : 'ptsPerGame';
        return key;
    };

    container.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = sortKeyFor(th.dataset.sort);
            if (AppState.playerSortStat === key) {
                AppState.playerSortDir = AppState.playerSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                AppState.playerSortStat = key;
                // The first click shows the best, so a lower-is-better column opens ascending. Sorting by ERA used to lead with the worst pitcher in the league.
                AppState.playerSortDir = openingSortDir(key, INVERSE_STATS[sport] || new Set());
            }
            renderPlayerLeaderboard();
        });
    });

    // R1/S49: preseason renders every row inert (leaderboard-row.js's own.lb-row-inert, no.lb-compare-trigger at all) - wiring a click here anyway would still open a drill-down on the one state the ruling calls "useless", the row's own missing cursor/hover notwithstanding.
    if (!basis.preseason) {
        // [data-player-id] EXCLUDES THE HEADER, which is itself an.lb-row - binding it would open a drill-down for NaN on a header click.
        container.querySelectorAll('.lb-row[data-player-id]').forEach(row => {
            row.addEventListener('click', () => openPlayerDetail(parseInt(row.dataset.playerId, 10)));
        });
        // item 2's row-level compare affordance (leaderboard-row.js's own.lb-compare-trigger, present on every row). stopPropagation for the same reason the rank explainer needs it below - the trigger sits inside a row whose own click already opens the drill-down. Opens that same drill-down first (the real, well-tested path openPlayerDetail already is - AppState. selectedPlayerId and the rendered container both need to agree, and this is the one place that already guarantees it) and then the picker on top of it, exactly what a manual "click row, then click + Compare" already does, collapsed into the one click this icon promises.
        container.querySelectorAll('.lb-compare-trigger').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const playerId = parseInt(btn.closest('.lb-row[data-player-id]').dataset.playerId, 10);
                await openPlayerDetail(playerId);
                const player = getEffectivePlayerPool(sport).find(p => p.id === playerId);
                if (player) openComparePicker(player);
            });
        });
    }
    // Only the rows inside the photo budget carry an <img>; this wires whichever of them exist.
    wirePlayerAvatars(container);

    // The rank explainer is a caller's affordance rather than part of the row shape, so it is put back into the header's rank cell here instead of being pushed into the contract.
    if (!AppState.isPointsLeague) {
        const rankHead = container.querySelector('.lb-head-rank');
        if (rankHead) {
            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.id = 'rank-explainer-trigger';
            trigger.className = 'rank-explainer-trigger';
            trigger.textContent = 'ⓘ';
            rankHead.appendChild(trigger);
        }
    }

    const explainerTrigger = document.getElementById('rank-explainer-trigger');
    if (explainerTrigger) {
        explainerTrigger.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also trigger the "Rank" column's sort click
            openRankExplainer(sport, rotoRanks, posFilter);
        });
    }

    // The Rank column's weekly-form arrows fetch quietly in the background; each chunk's completion re-render pops more arrows in. BASIS scope: the arrow math is load-bearing on the visible rows and the qualified basis pool, and those two tiers are 35% of the fixture's pool - the rest arrives if a windowed timeframe or the race ever asks for everyone. A row scrolled into view without weekly data shows no arrow rather than a wrong one, and the next render of the tab re-runs this with the new visible set.
    if (!AppState.isPointsLeague && !leaderboardWeeklyDataReady() && !bulkWeeklyFetchFailed) {
        ensureLeaderboardWeeklyDataLoaded(sport, 'basis');
    }

    // Rows just changed (a re-sort, a filter, a search, or a progressive chunk repaint), so what's on screen changed too - re-tier the rest of the queue behind it. A no-op when no fetch is running.
    reprioritizeWeeklyQueue();
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
        AppState.playerDetailMatchupSide = 'overall';
    }
    AppState.selectedPlayerId = playerId;
    // Opening a player is a statement about ONE player, including when the pager walks to the next one with preserveView on - a comparison carried along by the pager would silently re-pair the second player against someone the user never chose.
    AppState.comparePlayerId = null;

    document.getElementById('player-toolbar').style.display = 'none';
    // R7/R9: the teams rail, Minimum Games Played, Advanced Stats and Empty Nights all filter/ measure the leaderboard TABLE, which is not on screen once the drill-down replaces it - chrome for a surface the reader cannot see. R3/S49 folded all four controls into #player-toolbar itself (the old second row, #player-toolbar-row2, is gone), so the one hide above now covers every one of them; this only still needs to hide the rail, its own separate element.
    document.getElementById('player-breakout-slot').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'none';
    const detailContainer = document.getElementById('player-detail-container');
    detailContainer.style.display = 'flex';
    detailContainer.innerHTML = `<div class="player-loading">${buildLoadingHtml()}</div>`;
    // Point the Diagnostic Data panel at THIS player immediately - even before the fetch below resolves (or even if it's skipped entirely because this player's weekly data is already cached), so the panel always matches the drill-down that's actually on screen. Seeding from the diagnostic cache (null when this player was never captured) is what drops the PREVIOUS player's payload. Leaving it would show one player's raw data under another's drill-down, the same right-label-wrong-data mismatch the 3-context split was built to end.
    setDebugContext('player-detail', playerDetailDiagnostics[playerId] || null);
    setActiveDebugKind('player-detail');

    // A bulk-cached entry carries no dailyByPeriod unless the pool path decided this player needed one, so the Day axis has to ask for it. Fetching one player's own history is what this branch already does when nothing is cached; this widens the condition rather than adding a path.
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
        // The season pool has this player (guarded at the top), but the EFFECTIVE pool for the current windowed timeframe does not (no weekly data in range even after the fetch above). Don't leave the half-open "Loading player history" container stranded on screen - fall back to the leaderboard so the tab never sits on a blank drill-down.
        closePlayerDetail();
        return;
    }
    renderPlayerDetail(player);

    // Capture for THIS player right away if the panel is already expanded. main.js's hook only fires on toggle, so without this, someone comparing several players with the panel left open (exactly the stat-checking workflow this diagnostic exists for) would see the empty placeholder on every switch until they collapsed and reopened it. An ordinary drill-down with the panel collapsed still costs nothing.
    if (document.getElementById('debug-panel')?.open) ensurePlayerDetailDiagnostic();
}

export function closePlayerDetail() {
    AppState.selectedPlayerId = null;
    AppState.comparePlayerId = null;
    document.getElementById('player-detail-container').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'flex';
    document.getElementById('player-toolbar').style.display = 'flex';
    // R7/R9: restore the rail to its own rule rather than forcing a display value - it collapses itself via dashboard.css's:empty rule when it has nothing to show (no schedule in hand, preseason), and an inline 'flex' here would override that and draw an empty box on a league where the row was correctly hidden before the drill-down ever opened. R3/S49: the toolbar's own restore above now covers Minimum Games Played, Advanced Stats and Empty Nights too (all four controls live in #player-toolbar itself since the old second row was folded in) - each keeps deciding its own visibility exactly as it did before the drill-down opened (a points league's own toggles, a schedule-less Empty Nights slot) with no second element for this function to know about any more.
    document.getElementById('player-breakout-slot').style.display = '';
    // Back to the leaderboard - the Diagnostic Data panel switches back to the pool context (already fetched/cached, so this just re-shows it - no new fetch needed).
    setActiveDebugKind('player-pool');
}

// Same scored/advanced split used everywhere else, scoped to whichever group tab this player's detail view was opened from (AppState.playerGroup) rather than their own primary role - a two-way player opened from the Pitchers tab should see pitching stat options, even though their primary position may make them a "batter."
function statIdsForPlayer(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = roleIdSetFor(sport);
    const wantPitchers = currentGroupIsSecondary(sport);
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
function buildRankChipHtml(poolKey, roto, player, roleWord = null) {
    if (!roto || !roto.ranks.has(player.id)) return '';
    const rank = roto.ranks.get(player.id);
    const label = rankPoolLabel(poolKey, roleWord);
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
            <span class="rank-chip-label">${escapeHtml(label)}</span>
            <span class="rank-chip-value">#${rank}</span>
            <span class="rank-chip-total">of ${roto.total}</span>
            <div class="rank-chip-dropdown"><table>${rows}</table></div>
        </div>
    `;
}

// S41/G2: signed to 2 (chip/bar) or 3 (table) decimals, "+" on a real positive, no sign at all on a value that rounds to exactly zero at the chosen precision - and never the raw toFixed negative-zero string ("-0.00") a wins/wk figure a hair under zero would otherwise print.
function formatWinsPerWeek(v, decimals = 2) {
    let s = Number(v).toFixed(decimals);
    const zero = (0).toFixed(decimals);
    if (s === `-${zero}`) s = zero;
    return (s !== zero && !s.startsWith('-')) ? `+${s}` : s;
}

// S41/G2: the matchup rank for ONE player - the drill-down's third chip and the G2 bar's Matchup side both read this. Same qualified-pool rule the leaderboard column follows (matchup-rank.js's own contract: "a rank 'of N' must mean the same N in both columns") - qualifiedPool is samePool narrowed to whoever the Overall Rank (buildRankChipsHtml's own overallRoto) actually ranked, with no position filter - the drill-down's Overall chip is always scored against the full same-role pool, never a position-scoped one, so this matches it rather than the leaderboard's own position-filtered rankPool.
function matchupRankForPlayer(player, sport) {
    if (AppState.isPointsLeague) return null;
    const wantPitchers = currentGroupIsSecondary(sport);
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeLeagueRanks(samePool, sport, null, wantPitchers);
    const qualifiedPool = samePool.filter(p => overallRoto.ranks.has(p.id));
    const ctx = matchupRankCtxFor(samePool, sport, wantPitchers);
    const { margins } = leagueMargins(AppState.apiData, ctx);
    if (!margins) return null;
    const ranked = computeMatchupRanks(qualifiedPool, margins, ctx);
    if (!ranked) return null;
    const entry = ranked.byId[player.id];
    if (!entry) return null;
    return { ...entry, of: ranked.of, matchups: margins.matchups };
}

// The third chip (F1/G2): read-only, no pool dropdown - a matchup rank is one number, not a comparison pool to switch between the way the Overall/position chips are. Styled distinctly (rank-chip-matchup) per the mockup's own.chip.new.
function buildMatchupRankChipHtml(matchupEntry) {
    if (!matchupEntry) return '';
    return `<div class="rank-chip rank-chip-matchup">
        <span class="rank-chip-label">Matchup</span>
        <span class="rank-chip-value">#${matchupEntry.rank}</span>
        <span class="rank-chip-total">of ${matchupEntry.of}</span>
        <span class="rank-chip-sub">${formatWinsPerWeek(matchupEntry.winsPerWeek)} wins a week</span>
    </div>`;
}

// The Matchup side of the G2 switch - four bullets plus the Category/Season/Per week/Margin/ Wins-a-week table, every figure read straight off matchupEntry.byCategory (the O38 contract's own per-category breakdown), never re-derived here.
function buildMatchupBreakdownBodyHtml(matchupEntry, player, sport, roleLabel) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const rateIds = AVERAGE_STATS[sport] || new Set();
    const inverseIds = INVERSE_STATS[sport] || new Set();
    const rowsHtml = matchupEntry.byCategory.map(r => {
        const isRate = rateIds.has(r.id);
        const seasonVal = formatStatValue(player.seasonTotals[r.id], isRate);
        const perWeekVal = isRate ? formatStatValue(r.perWeek, true) : r.perWeek.toFixed(2);
        const marginVal = isRate ? r.marginSd.toFixed(4) : r.marginSd.toFixed(1);
        return `<tr>
            <td>${escapeHtml(statMap[r.id] || r.id)}${inverseIds.has(r.id) ? ' <span title="Lower is better for this category">&darr;</span>' : ''}</td>
            <td>${seasonVal}</td>
            <td>${perWeekVal}</td>
            <td>${marginVal}</td>
            <td class="${r.wins >= 0 ? 'pos' : 'neg'}">${formatWinsPerWeek(r.wins, 3)}</td>
        </tr>`;
    }).join('');
    const totalCls = matchupEntry.winsPerWeek >= 0 ? 'pos' : 'neg';
    return `
        <ul class="rank-breakdown-explain">
            <li>Measured on this league's <strong>${matchupEntry.matchups} decided matchups</strong>: in each category, how far apart the two sides finished in a typical week. That spread is the <strong>Margin</strong> column.</li>
            <li><strong>Per week</strong> = this player's season line spread over those matchups. A rate (AVG, OPS) shows the player's own season rate - a player who missed weeks is measured at what those weeks gave, not at a rate for the weeks played.</li>
            <li><strong>Wins a week</strong> = the chance a week of this line turns the category, against that margin (&darr; = counts against).</li>
            <li><strong>Matchup rank</strong> = where the total sits among the same <strong>${matchupEntry.of} qualified ${escapeHtml((roleLabel || 'players').toLowerCase())}</strong> the Overall Rank uses.</li>
        </ul>
        <table class="rank-breakdown-table rank-breakdown-table-matchup">
            <thead><tr><th>Category</th><th>Season</th><th>Per week</th><th>Margin</th><th>Wins a week</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td colspan="4">Wins a week = ${formatWinsPerWeek(matchupEntry.winsPerWeek)} &middot; Matchup rank #${matchupEntry.rank} of ${matchupEntry.of}</td><td class="${totalCls}">${formatWinsPerWeek(matchupEntry.winsPerWeek, 3)}</td></tr></tfoot>
        </table>
    `;
}

// Overall rank (against every same-role player) plus one rank per position this player is eligible for (against only that position's peers, same scoping as the leaderboard's rankPool) - a multi-position player's value can look very different position by position (a different, smaller comparison pool naturally produces different percentiles per category), so showing only one number would hide that. Click a chip to see that exact pool's math in the breakdown.
function buildRankChipsHtml(player, sport) {
    // Points leagues rank too, since, and the drill-down was still the one surface that assumed they did not. The leaderboard showed a rank and opening the same player showed no chips at all. Same chips, same scoping, ranked by fantasy points instead of category percentiles.
    const wantPitchers = currentGroupIsSecondary(sport);
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeLeagueRanks(samePool, sport, null, wantPitchers);
    // Qualified in BOTH groups - the only case where "Overall" needs qualifying. Read off the same eligibility the pools are built from, so a player the tabs disagree about cannot slip through.
    const twoWay = groupsFor(sport).length > 1
        && matchesPlayerGroup(player, sport, false) && matchesPlayerGroup(player, sport, true);
    const chips = [buildRankChipHtml('Overall', overallRoto, player, twoWay ? groupRoleWord(sport, wantPitchers) : null)];
    if (twoWay) {
        const other = groupRoleWord(sport, !wantPitchers);
        // NO PRONOUN, which is the house rule (the coverage band was rewritten for it in 05af248), and the pronoun-free form reads better anyway: the TAB does the ranking, so it can be the subject. "the pitcher line" rather than a possessive - with the article the role word stops sounding like a person who owns the line, which is the trap the possessive form fell into and the reason this sentence has now been written three times.
        chips.push(`<div class="rank-chip-note">Ranked here as a ${escapeHtml((groupRoleWord(sport, wantPitchers) || 'player').toLowerCase())} only.`
            + ` The other tab ranks the ${escapeHtml((other || 'player').toLowerCase())} line, and the draft board is the one`
            + ` place the two are combined into a single value.</div>`);
    }
    // For a two-way player, only show chips for the positions relevant to the CURRENTLY viewed group - a batting-position chip while viewing them as a pitcher (or vice versa) would compare their wrong-role stats against the wrong-role pool.
    const relevantPositions = player.eligiblePositions.filter(pos => pitcherPositions.has(pos) === wantPitchers);
    relevantPositions.forEach(pos => {
        const posPool = samePool.filter(p => matchesPositionFilter(p, pos));
        // Skip a positional chip whose pool IS the group pool - it would just restate Overall. This is hockey goalies today. The Goalies group is the single G position, so ranking goalies "vs G" and "vs the group" compare the same players. Guarding on pool identity, not a hardcoded 'G', keeps the useful cases. A baseball SP pool is a strict subset of the pitcher group (RP-only arms excluded), so it stays, and any future one-position group inherits this. posPool is always a subset of samePool (it's filtered from it), so equal size means equal set.
        if (posPool.length === samePool.length) return;
        chips.push(buildRankChipHtml(pos, computeLeagueRanks(posPool, sport, pos, wantPitchers), player));
    });
    return chips.filter(Boolean).join('');
}

// WHY a player has no rank, in the same terms the engine decided it. Returns 'no-games', 'below-minimum', or null when neither applies and the honest answer is to say nothing. The two are genuinely different states and were being shown as one silence. Zero games in the selected window is an absence of evidence - the timeframe can produce it for anyone, an IL week at Current included - and no score exists. Under the minimum but PLAYED is a leaderboard display filter doing its job, and a real score exists behind it. Measured on games played, not on the shrinkage workload, because games played is what the engine gates on (see computeRotoRanks: the threshold measure is role-neutral, the shrinkage measure is not). Null when nobody in the pool has played at all, which is a preseason board ranking on projections rather than an unranked player.
function unrankedReason(player, poolPlayers, sport, wantPitchers) {
    const maxGames = Math.max(0, ...poolPlayers.map(p => gamesPlayedOf(p, sport, wantPitchers)));
    if (maxGames <= 0) return null;
    const own = gamesPlayedOf(player, sport, wantPitchers);
    if (own === 0) return 'no-games';
    return own < maxGames * MIN_PLAYING_TIME_FRACTION ? 'below-minimum' : null;
}

// Explains exactly how the currently-selected rank chip's score is built, category by category - every number in the table is derived from the two values shown right above it (Raw %ile and the Playing-Time Factor), via the formula spelled out in the caption, so nothing is a mystery number. Open by default since seeing this IS the point of the feature.
function buildRankBreakdownHtml(player, sport, wantPitchers = currentGroupIsSecondary(sport), matchupEntry = null) {
    // A points rank is one sum, not an average of category percentiles, so there is no per-category math to justify. The chips above still carry the ranks and their neighbours.
    if (AppState.isPointsLeague) return '';
    // Which role's breakdown to show - keyed off the currently viewed group tab, not this player's own primary position, so a two-way player opened from the Pitchers tab gets the pitching breakdown even though their primary role may be "batter".
    const isPitching = currentGroupIsSecondary(sport);
    const roleLabel = groupLabel(sport, isPitching);
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitching));

    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    // Only RP matches by primary role instead of eligibility (see matchesPositionFilter) - SP uses plain eligibility, same as every other position filter. SP also does NOT share RP's games-played workload basis (see computeRotoRanks' own comment for why an eligibility-based SP pool can't rely on games played the way a role-pure RP pool can).
    const isRpPool = selectedPool === 'RP';
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;

    // RP skips shrinkage entirely and compares K as K/9 instead of a raw total - see computeRotoRanks' own comment for why. Every other pool (including SP) uses the same innings-pitched/games-played workload measure computeRotoRanks does.
    const { rows, excluded, shrink, avg, qualifiedCount } = computeCategoryBreakdown(player, poolPlayers, sport, selectedPool, wantPitchers);
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
        ? `<div class="rank-breakdown-note">Below the leaderboard's minimum: ${gamesPlayedOf(player, sport, wantPitchers)} games played, under the
           ${Math.round(MIN_PLAYING_TIME_FRACTION * 100)}% of the pool leader's that the list view requires - which is why this player is not in it.
           The score above is built the ordinary way, with the Playing-Time Factor discounting the small sample.</div>`
        : '';

    const summary = noRank
        ? `Why <strong>${escapeHtml(selectedPool)}</strong> has no Rank score`
        : `How the <strong>${escapeHtml(selectedPool)}</strong> Rank score (${avg.toFixed(1)}) is totaled`;

    const overallBodyHtml = `
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
    `;

    // S41/G2 (the owner's own ruling on Q9): the panel becomes ONE bar with an Overall| Matchup switch, rather than two stacked panels, when there is a second, real telling to switch TO - a real matchup rank (matchupEntry), an actual Rank score to pair it against (!noRank), and the SELECTED pool is Overall, since matchup-rank.js v1 has no position-scoped variant to pair against a position chip's own score (the bar would otherwise label a position-pool score "Overall", which is the wrong number under the right one's own name). Absent any of those, this stays byte-identical to the panel before G2 existed.
    const showMatchupSwitch = !!matchupEntry && !noRank && selectedPool === 'Overall';
    if (!showMatchupSwitch) {
        return `
            <details class="rank-breakdown"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
                <summary>${summary}</summary>
                ${overallBodyHtml}
            </details>
        `;
    }

    const matchupSide = AppState.playerDetailMatchupSide === 'matchup' ? 'matchup' : 'overall';
    const matchupBodyHtml = buildMatchupBreakdownBodyHtml(matchupEntry, player, sport, roleLabel);
    return `
        <details class="rank-breakdown rank-breakdown-switchable"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
            <summary class="rank-breakdown-bar">
                <span class="rank-breakdown-bar-title">How the rank is calculated</span>
                <span class="rank-breakdown-switch">
                    <button type="button" class="rank-breakdown-switch-opt${matchupSide === 'overall' ? ' on' : ''}" data-matchup-side="overall">Overall ${avg.toFixed(1)}</button>
                    <button type="button" class="rank-breakdown-switch-opt${matchupSide === 'matchup' ? ' on' : ''}" data-matchup-side="matchup">Matchup #${matchupEntry.rank}</button>
                </span>
                <span class="rank-breakdown-bar-tot">Overall <strong>${avg.toFixed(1)}</strong> &middot; Matchup <strong class="rank-breakdown-bar-tot-m">${formatWinsPerWeek(matchupEntry.winsPerWeek)}</strong> wins a week</span>
            </summary>
            <div class="rank-breakdown-side${matchupSide === 'overall' ? '' : ' hidden'}" data-side="overall">${overallBodyHtml}</div>
            <div class="rank-breakdown-side${matchupSide === 'matchup' ? '' : ' hidden'}" data-side="matchup">${matchupBodyHtml}</div>
        </details>
    `;
}

// Re-renders the currently-open player detail view (chart, rank chips/breakdown) in place - a no-op if no player is open. Called when the shared AppState.timeframe changes (see handleTimeframeChange in controls.js), since the detail view no longer has its own separate timeframe control to trigger this itself. One player as the CURRENT timeframe sees them, or null when they are not in this league at all. The windowed pool only admits players with cached weekly data, because a window has nothing to aggregate for anyone else (see getEffectivePlayerPool). That is the right pool to RANK against, but it is the wrong answer to "who is the view showing" - and the two were the same lookup, which is the whole of item 1. A player outside the windowed pool made the lookup return undefined, the caller below silently did nothing, and the drill-down or comparison stayed on screen still showing the PREVIOUS timeframe's numbers. Nothing said so; it just looked like the pills had stopped working, which is exactly what the owner reported. The fallback is a windowed clone with no totals rather than the season entry, because handing back season numbers under a windowed heading is the misleading answer this pool exists to avoid. Empty totals flow through the surfaces that already handle absence: the ledger prints a dash on that side and the strip says there is nothing to compare, which is true and re-scopes honestly.
function effectivePlayerById(sport, id) {
    const pooled = getEffectivePlayerPool(sport).find(p => p.id === id);
    if (pooled) return pooled;
    const base = AppState.playerData.find(p => p.id === id);
    if (!base) return null;
    return isFullSeasonTimeframe() ? base : { ...base, seasonTotals: {} };
}

export function refreshOpenPlayerDetail() {
    if (!AppState.selectedPlayerId) return;
    const player = effectivePlayerById(AppState.loadedSport, AppState.selectedPlayerId);
    if (player) renderPlayerDetail(player);
}

// What the trend picker offers, and in what order. Lifted out of renderPlayerDetail so the comparison view builds the same list from the same rules instead of keeping a second copy that could drift - both views chart the same stats off the same picker. The first entry is what a freshly opened view shows, which is why the order is a decision rather than a listing.
function buildTrendStatOptions(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const statOptions = visibleIds.map(id => ({ id, name: statMap[id] }));
    // Category leagues get our own computed Weekly Score as a selectable trend, in place of ESPN's removed FPTS - points leagues already have a real per-week points total via appliedTotal, so there's nothing to replace there. Named for the league's own timeline unit. This is our synthetic per-period score, and in roto each period is a real week, so "Matchup Score" put a matchup token on a screen whose axis and tooltips both read WK/Week. S41: "Score by matchup" (S41's own rename, never "Matchup Score" - matchup-rank.js's contract is explicit that the two must never share a word, since Matchup Score is THIS player's rank score inside one matchup and matchup-rank.js's wins/week is a different figure entirely). Still built off axisUnit(), never the bare word "matchup" - a roto league reads "Score by week" here, the same swap the axis's own tick labels already make.
    if (!AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_RANK_STAT_ID, name: `Score by ${axisUnit().long.toLowerCase()}` });
    // A points league's headline number IS its points, so that trend leads the picker and, being first, is what a freshly opened drill-down shows. The individual categories behind it stay selectable underneath.
    if (AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_POINTS_STAT_ID, name: `${axisUnit().long} Points` });

    // At Current the synthetic score leads with the one thing the Day axis cannot draw. Matchup Score and Points are scored per PERIOD against the pool, so a single day has no meaning for them and they keep the matchup axis, which at Current is one point. Leading with one there lands every drill-down on exactly the flat line this work exists to remove, so a real category leads instead. The score stays in the picker, one selection away. The DEFAULT moves, the list does not - reordering the picker under a timeframe change would move an option out from under the cursor for a reason nobody could see.
    const dayLens = parseTimeframe(AppState.timeframe).window === 1;
    const synthetic = new Set([WEEKLY_RANK_STAT_ID, WEEKLY_POINTS_STAT_ID]);
    const preferred = dayLens ? (statOptions.find(s => !synthetic.has(s.id)) || statOptions[0]) : statOptions[0];
    return { options: statOptions, preferred };
}

// ==== THE DAY STRIP. One chip per day under the stat cards, following the timeframe. ====

// THE PRO SCHEDULE, ASKED FOR ONCE AND ONLY WHEN A STRIP WANTS IT. It is the only source that dates a scoring period, it is session-cached and conditional after, and it is already fetched by My Team - so on most sessions this costs nothing at all and at worst one request. The strip draws with Day N labels until it lands and re-renders itself when it does, which is the same shape every other late-arriving thing in this file uses.
let proScheduleDates = null;
let proScheduleAsked = false;

function ensureScheduleDates() {
    if (proScheduleDates || proScheduleAsked) return;
    proScheduleAsked = true;
    fetchProTeamSchedules()
        .then(data => {
            const dates = datesByScoringPeriod(data);
            if (!dates.size) return;
            proScheduleDates = dates;
            // Only redraw if a drill-down is still open on the same player - the answer is useless to a leaderboard and re-rendering one would be work thrown away.
            if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        })
        .catch(() => { /* No dates. The chips keep saying Day N, which is never wrong. */ });
}

// A period's label: the real date when the schedule can supply one, the day's place in its matchup when it cannot. NEVER a computed guess - the finding stands, and no date beats a wrong one. MM-DD as the owner wrote it ("08-21"), zero-padded, hyphen-separated, in LOCAL time - a fantasy day is the day the games were played where the reader is, and toLocaleDateString would introduce a locale the rest of the app does not have. DECISIONS-NEEDED if a non-US reader wants DD-MM: it is one line here and nothing else in the app formats a date.
function dayChipLabel(period, dayNumber) {
    const at = proScheduleDates && proScheduleDates.get(period);
    if (at) {
        const d = new Date(at);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}-${dd}`;
    }
    return dayNumber ? `Day ${dayNumber}` : `P${period}`;
}

// SPORT KNOWLEDGE LIVES HERE, not in rank-engine, which holds none by contract. A signature day is a statement the sport makes rather than a ratio: a quality start is a quality start in a season where the pitcher is otherwise brilliant, and a two-homer game does not stop being one because the batter hits forty. Baseball: 34 is OUTS so six innings is 18, 45 is ER, 5 is HR. Hockey: 28 is HAT and 13 is G (a hat trick either way ESPN files it), 7 is SO.
const DAY_SIGNATURE_RULES = {
    flb: (s, secondary) => secondary
        ? ((s[34] || 0) >= 18 && (s[45] || 0) <= 3)
        : (s[5] || 0) >= 2,
    fhl: (s, secondary) => secondary
        ? (s[7] || 0) >= 1
        : ((s[28] || 0) >= 1 || (s[13] || 0) >= 3)
};

// Innings from outs, in baseball's own notation: 19 outs is 6.1, not 6.33.
function inningsLabel(outs) {
    const o = Math.max(0, Math.round(Number(outs) || 0));
    return `${Math.floor(o / 3)}.${o % 3}`;
}


// The day's notable counting stats, at most three, in the order a box score would read them. Only non-zero entries, so an ordinary day says less and a big one says more without a rule. THE HEADLINE'S OWN STATS COUNT TOWARD THE VERDICT, even when the league does not score them. Found on the first real strip: a 3-for-4 day wore a RED border. The league scores AVG, HR, OPS, R, RBI, SB, CS, AST and E - hits are not among them - so three hits with no runs contributed nothing the standings measure and the day scored zero. Defensible arithmetic, indefensible chip: it shows "3-4" in the headline and then calls it a bad day, and a reader compares those two things because they are two lines of the same object. So the verdict scores the league's counting categories PLUS whatever the headline is made of. ONLY THE GOOD HALF of the headline: earned runs and goals against are in the figure because a pitching line is unreadable without them, but adding them here would reward a pitcher for being hit. Outs are in - they are innings, and innings are the thing a start is measured by.
const DAY_VERDICT_EXTRA = {
    flb: { primary: ['1'], secondary: ['34', '48'] },
    fhl: { primary: ['13', '14'], secondary: ['6'] }
};

const DAY_NOTABLE = {
    flb: { primary: [[5, 'HR'], [21, 'RBI'], [20, 'R'], [23, 'SB']], secondary: [[53, 'W'], [57, 'SV'], [48, 'K'], [63, 'QS']] },
    fhl: { primary: [[13, 'G'], [14, 'A'], [29, 'SOG'], [31, 'HIT']], secondary: [[1, 'W'], [7, 'SO'], [6, 'SV']] }
};

// A PLAYED DAY ALWAYS SAYS SOMETHING. The ruling's own examples include a bad day - "0-for-4 - 3 K" - so a day with no notable counting stat is not a blank line, it is a quiet one. A pitcher always leads with the innings, because a pitching line without them is unreadable; a batter with nothing to report falls back to at-bats, which is the 0-for-4 of the example. MIDDOT is a character code rather than an escape sequence, and that is deliberate: the separator shipped in as a \u00b7 inside a template literal, survived one edit script as a doubled backslash, and would then have rendered as the literal text rather than a dot.
function dayNotable(sums, sport, secondary) {
    // NO BASEBALL RULES FOR A SPORT THAT HAS NONE. These three tables encode which stats read as notable, which belong in a verdict, and what a signature day looks like - all of them real facts about baseball and hockey, and all of them meaningless applied to a third sport's ids, which number differently. An absent entry means no signature rules, not somebody else's.
    const spec = (DAY_NOTABLE[sport] || {})[secondary ? 'secondary' : 'primary'] || [];
    const parts = spec
        .filter(([id]) => (Number(sums[id]) || 0) > 0)
        .slice(0, 3)
        .map(([id, label]) => `${Number(sums[id])} ${label}`);
    if (sport === 'flb' && secondary) {
        const outs = Number(sums[34]) || 0;
        if (outs > 0) parts.unshift(`${inningsLabel(outs)} IP`);
    } else if (sport === 'flb' && !parts.length) {
        const ab = Number(sums[0]) || 0;
        if (ab > 0) parts.push(`${Number(sums[1]) || 0}-for-${ab}`);
    }
    return parts.slice(0, 3).join(` ${MIDDOT} `);
}

// The em dash a hover shows where it has no figure, and the middot that joins a stat line - named so they survive an edit rather than living as escape sequences inside a template literal.
const DASH = String.fromCharCode(8212);
const MIDDOT = String.fromCharCode(183);
const MIDDOT_SEP = ` ${MIDDOT} `;

// THE DAY LENS. The day strip is gone as a surface - the owner called the stacked band busy - and its replacement lives in the chart itself: day points wear the verdicts, and every matchup point is a door into its own days. This is the strip model's surviving core: per-day verdicts and self-scores for a given set of periods, computed once per draw and read by the point painter and the hover text alike. The typical day is taken over EVERY day the player has, not just the days on screen - a window is too small to be its own yardstick, and the same day would change colour as the timeframe moved if it were (the calibration lesson, kept).
function dayInfoFor(player, sport, periods) {
    const daily = AppState.playerWeeklyCache[player.id]?.dailyByPeriod;
    if (!daily) return null;
    const secondary = currentGroupIsSecondary(sport);
    const { scored } = statIdsForPlayer(player, sport, (AppState.playerWeeklyCache[player.id] || {}).weekly || {});
    // Counting categories only - see the note on scoreDayAgainstSelf for why a rate cannot judge a single day. AVERAGE_STATS is the league-independent list of which ids are rates.
    const rateSet = AVERAGE_STATS[sport] || new Set();
    const scoredCounting = scored.filter(id => !rateSet.has(String(id))).map(String);
    const extra = (DAY_VERDICT_EXTRA[sport] || {})[secondary ? 'secondary' : 'primary'] || [];
    const countingIds = Array.from(new Set([...scoredCounting, ...extra]));
    const averages = perDayAverages(daily, countingIds);
    const signature = DAY_SIGNATURE_RULES[sport] || {};
    const allScores = Object.keys(daily)
        .filter(k => daily[k] && daily[k].games)
        .map(k => scoreDayAgainstSelf(daily[k].sums, averages, countingIds));
    const typical = typicalDayScore(allScores);
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const byPeriod = new Map();
    periods.forEach(period => {
        const day = daily[period];
        const sums = (day && day.sums) || {};
        const played = !!(day && day.games);
        const score = played ? scoreDayAgainstSelf(sums, averages, countingIds) : null;
        const isSig = played && signature(sums, secondary);
        const line = countingIds
            .filter(id => (Number(sums[id]) || 0) !== 0)
            .map(id => `${statMap[id] || id} ${Number(sums[id])}`);
        byPeriod.set(period, {
            played,
            line: line.length ? line.join(MIDDOT_SEP) : '',
            verdict: played ? dayVerdict(score, isSig, typical) : 'off',
            // item 1: the presentable day score, 50 = the player's own typical day, 100 the cap - the register Matchup Score already taught, where 50 is mid-pack.
            score: presentDayScore(score),
            notable: played ? dayNotable(sums, sport, secondary) : ''
        });
    });
    return { byPeriod };
}

// One matchup's days as a chart series - the zoom. Two shapes by picker: - a real stat runs cumulative through the matchup, exactly as Current's day axis always has (aggregateDailyCumulative, the same call, so the zoomed line is the same arithmetic); - the per-pool pair (Matchup Score, Points) has no per-day chart value - the finding - so the zoomed line plots the day SELF-scores on the 0-100 scale instead, which is also the number the hover names. An off day is a gap in the line, not a zero. Every entry carries its PERIOD beside the 0-based index the axis draws from, because the verdicts and the date labels are keyed by period and the x positions are not.
function buildZoomDaySeries(player, stat, matchup, isWeeklyRank, isWeeklyPoints, sport) {
    const daily = AppState.playerWeeklyCache[player.id]?.dailyByPeriod;
    if (!daily) return null;
    const periods = periodsOfMatchup(matchupPeriodMap(), matchup);
    if (periods.length < 2) return null;
    const today = Number(AppState.apiData?.scoringPeriodId) || 0;
    const upTo = today ? periods.filter(p => p <= today) : periods;
    const shown = upTo.length >= 2 ? upTo : periods;
    if (isWeeklyRank || isWeeklyPoints) {
        const info = dayInfoFor(player, sport, shown);
        if (!info) return null;
        const days = shown.map((p, i) => ({ index: i, period: p, played: !!info.byPeriod.get(p)?.played }));
        const values = shown.map(p => {
            const d = info.byPeriod.get(p);
            return d && d.played && d.score !== null ? d.score : null;
        });
        if (!values.some(v => v !== null)) return null;
        return { days, values, matchup };
    }
    const series = aggregateDailyCumulative(daily, shown, sport);
    if (!series.some(d => d.played)) return null;
    return { days: series, values: series.map(d => { const v = d.totals[stat.id]; return v === undefined ? 0 : Number(v); }), matchup };
}

// The matchup-axis verdicts: the same grammar as the days, one level up. Every value is the number the chart plots for that week (the rank series, the points bucket, or the stat), the baseline is the MEDIAN of every week the player has - stable across timeframes for the same reason the day median is - and the best week of the SEASON wears gold, so it is gold wherever the timeframe happens to show it and never "best of what is on screen". Inverse stats read the other way: the best ERA is the lowest.
function matchupVerdictInfo(player, sport, weekly, stat, isWeeklyRank, isWeeklyPoints) {
    const allWeeks = Object.keys(weekly).map(Number).filter(w => weekly[w]).sort((a, b) => a - b);
    if (!allWeeks.length) return null;
    const rankScores = isWeeklyRank ? computeWeeklyRankSeries(player, sport, weekly, allWeeks) : null;
    const valueOf = (w) => {
        if (isWeeklyRank) return rankScores[w] ?? 0;
        if (isWeeklyPoints) return pointsForStatBucket(weekly[w], player, sport);
        return weekly[w][stat.id] || 0;
    };
    const values = allWeeks.map(valueOf);
    const median = typicalDayScore(values);
    const inverse = !isWeeklyRank && !isWeeklyPoints && (INVERSE_STATS[sport] || new Set()).has(stat.id);
    const best = inverse ? Math.min(...values) : Math.max(...values);
    const verdictOf = (v) => {
        if (v === best) return 'best';
        if (median === null || v === median) return 'even';
        return (inverse ? v < median : v > median) ? 'above' : 'below';
    };
    return { verdictOf };
}


// Projection-vs-actual pacing. The MATH lives in projection-pacing.js, pure and unit-tested against tests/fixtures/projection-pacing.md - this only builds the ctx off AppState/the pool and renders the contract's shape. R10's re-ruling: "preseason projection" was the item's own root cause (see the contract's Provenance) - ESPN's projectedTotals is the REST of the season, not the whole of it, so the honest question is a RATE against a RATE, and the honest season figure is banked plus what is still expected, never the expected span alone. HOW MUCH SEASON THIS PLAYER HAS LEFT, in APPEARANCES. ESPN's own projected games is the denominator of its rate and no longer the span: it is a preseason full-season count for the players ESPN has stopped refreshing, which is how this card came to say a season would run 287 games. The schedule answers it instead, through the same expectedAppearances the coverage band prices its remainder on, so the two surfaces cannot disagree about how much is left. Null without a pro schedule, and the module falls back to ESPN's count - the figure this card showed before the amendment, right for every player whose line ESPN is keeping current.
function remainingAppearancesFor(player, gamesId) {
    const schedules = currentProSchedule();
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    const today = Number(AppState.apiData?.scoringPeriodId) || null;
    const final = finalScoringPeriodOf(AppState.apiData);
    if (!proTeams || !today || !final || final < today || !gamesId) return null;
    const ahead = [];
    for (let p = today; p <= final; p++) ahead.push(p);
    const behind = [];
    for (let p = 1; p < today; p++) behind.push(p);
    if (!behind.length) return null;
    const left = gamesByProTeamForMatchup(proTeams, ahead).get(Number(player.proTeamId));
    const done = gamesByProTeamForMatchup(proTeams, behind).get(Number(player.proTeamId));
    if (!left || !done) return null;
    // .count, not the shape: this card's span is a number of appearances whatever unit they are counted in, and pacing multiplies ESPN's per-appearance rate by it. The unit matters to a surface that PRINTS the figure; this one prints a season total.
    const expected = expectedAppearances(player, {
        gamesId, clubGamesPlayed: done.games, gamesRemaining: left.games
    });
    return expected ? expected.count : null;
}

function buildProjectionPacingHtml(player, sport, scored, statMap) {
    const wantPitchers = currentGroupIsSecondary(sport);
    const gpIds = GAMES_PLAYED_IDS[sport];
    const gamesId = gpIds ? gpIds[wantPitchers ? 'secondary' : 'primary'] : null;
    const remaining = remainingAppearancesFor(player, gamesId);
    const pacing = projectionPacing(player, {
        scoredIds: scored,
        gamesId,
        gamesRemaining: remaining === null ? undefined : remaining,
        rateIds: AVERAGE_STATS[sport] || new Set(),
        inverseIds: INVERSE_STATS[sport] || new Set(),
        isPointsLeague: AppState.isPointsLeague,
        weights: AppState.scoringWeights,
        statLabels: statMap,
        seasonId: AppState.apiData?.seasonId ?? null
    });
    if (!pacing) return '';

    const fig = (n) => formatStatValue(n, false);
    // R9/S46 (the owner's fourth pass, superseding R8): ONE compact strip, one chip per scored category reading "HR 16 + 3 = 19" (banked, expected, projected - the projected figure bold), never taller than it needs to be, so the chart below keeps the majority of the drill-down's space. "The headline row reads '16 banked + 3 expected the rest of the way = 19 HR projected this season' and the row under it says the same thing again" was this exact duplication: the old headline/track pair always spoke for `pacing.components[0]` alone, and that SAME category then repeated itself as the first of the per-category rows below - two sentences for one category, and every other category behind a smaller, differently-shaped bar. Every category is an equal chip now; none is a "lead" the others are compared against. S46b: "before the season" returns as a clause on EVERY chip's own tooltip rather than a strip line of its own - a figure folded into the hover a reader already has, costing no height. Same absent-not-zeroed rule as before: no snapshot for this league, a player the snapshot never saw, or a category it does not carry all read as nothing appended, never a zero.
    const preLine = preseasonLineFor(currentPreseasonSnapshot(), player.id);
    const chipsHtml = pacing.components.map(c => {
        const cActual = c.actualPerGame * pacing.gamesPlayed;
        const cExpected = c.projPerGame * pacing.projectedGames;
        const preValue = preLine ? preLine[c.id] : undefined;
        const beforeClause = (preValue === undefined || preValue === null) ? '' : ` · Before the season: ${fig(preValue)}`;
        const tip = `${fig(cActual)} ${c.label} banked + ${fig(cExpected)} expected the rest of the way${beforeClause}`;
        return `
            <span class="pacing-chip" data-tooltip="${escapeHtml(tip)}">
                <span class="pacing-chip-label">${escapeHtml(c.label)}</span>
                <span class="pacing-chip-figs">${fig(cActual)} + ${fig(cExpected)} = <strong>${fig(cActual + cExpected)}</strong></span>
            </span>`;
    }).join('');
    return `
        <div class="player-projection-pacing">
            <div class="pacing-chips">${chipsHtml}</div>
        </div>`;
}

function renderPlayerDetail(player) {
    // The preseason snapshot, asked for once per league. Not awaited: the drill-down renders now with whatever is held, and the ensure redraws it if a body lands - the same shape ensureProScheduleData uses, and for the same reason. A league with no snapshot caches that answer too, so this costs one storage read per league per session.
    ensurePreseasonSnapshot();
    // The comparison is a VIEW STATE of the drill-down rather than a separate screen, so the fork lives at the single entry every re-render already passes through - a timeframe change, an advanced-stats toggle and a stat switch all keep the pair up instead of dropping one of them without being asked to.
    if (AppState.comparePlayerId != null) {
        // THE PAIR SURVIVES THE FLIP, including into a window the opponent has no data in. This used to drop the second player rather than "draw a comparison against an absence" - but the promise is that a timeframe change re-scopes the pair, and silently becoming a one-player view is a stranger answer than a column of dashes that says the window holds nothing for that player. effectivePlayerById gives the same honest empty totals the anchor gets, so both sides are read off one basis whatever the window contains.
        const other = effectivePlayerById(AppState.loadedSport, AppState.comparePlayerId);
        if (other) return renderPlayerComparison(player, other);
        AppState.comparePlayerId = null;
    }
    const container = document.getElementById('player-detail-container');
    const sport = AppState.loadedSport;
    // The same abbreviation table the leaderboard row model reads (proAbbrevOf, above) - built fresh here since the drill-down does not carry a row model, only the raw pool player.
    const proAbbrev = currentProSchedule()
        ? proAbbrevOf(player, buildProTeamAbbrevs(currentProSchedule()))
        : null;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { weekly = {} } = AppState.playerWeeklyCache[player.id] || {};

    // AppState.maxCompletedWeek reflects the LEAGUE's own matchup schedule, which can end well short of the real season (a league whose matchupPeriods only covered the first 25 real days while a player's own game logs ran past day 100) - use whichever is actually larger so "Regular Season + Playoffs" and the percentage lookbacks below don't silently cut off real weeks of this player's data just because the league stopped defining matchups.
    const effectiveMaxWeek = Math.max(AppState.maxCompletedWeek, 0, ...Object.keys(weekly).map(Number));

    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const { options: statOptions, preferred } = buildTrendStatOptions(player, sport, weekly);
    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || preferred;
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    // S41/F1/G2: computed once, fed to both the third chip and the breakdown bar's switch - null whenever the league or this specific player has no matchup rank to show (matchup- rank.js's own refusal, or a player it could not measure), in which case both stay exactly as they were before this feature existed.
    const matchupEntry = matchupRankForPlayer(player, sport);
    const rankChipsHtml = buildRankChipsHtml(player, sport) + buildMatchupRankChipHtml(matchupEntry);
    const rankBreakdownHtml = buildRankBreakdownHtml(player, sport, currentGroupIsSecondary(sport), matchupEntry);
    // Chips are absent whenever the engine will not rank this player, and absence was the whole of what the header said about it. The owner clicked through from My Team and found the rank row gone, with a breakdown below it totalling 50. A named state costs one line and answers the question the missing chips raised. Silent when no reason can be given, since "unranked for reasons we cannot name" is worse than the space it would take.
    const unrankedHtml = (() => {
        if (rankChipsHtml || AppState.isPointsLeague) return '';
        const wantPitchers = currentGroupIsSecondary(sport);
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
        const wantPitchersNav = currentGroupIsSecondary(sport);
        const navPool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchersNav));
        const selectedPool = AppState.playerDetailRankPool || 'Overall';
        const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
        const poolPlayers = isPositionPool ? navPool.filter(p => matchesPositionFilter(p, selectedPool)) : navPool;
        const ranked = computeLeagueRanks(poolPlayers, sport, isPositionPool ? selectedPool : null, wantPitchersNav);
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

    // S13 follow-up (the same bug one click away from the leaderboard's own S6 fix): a projected counting stat carries fractional noise (a rest-of-season rate times games remaining), and formatStatValue's old unconditional rule gave it three decimals same as a real rate stat. isRate here is the same AVERAGE_STATS[sport] membership the leaderboard's ctx.rateIds reads.
    const chipRateIds = AVERAGE_STATS[sport] || new Set();
    const seasonStatsHtml = visibleIds.map(id => {
        const rankInfo = computeStatRank(player, sport, id);
        // No percentile means the player is unranked in this category, and the chip stays on the plain surface rather than claiming an average one - --pct is not set.
        const pctStyle = rankInfo ? ` style="--pct:${percentileVar(rankInfo.percentile)};"` : '';
        const rankColor = rankInfo && RANK_COLORS[rankInfo.rank];
        // Same "a few players above/below" hover dropdown as the rank chips, just scoped to this one category's own ordering instead of the averaged Rank score - passing the tie-aware ranks so a tied neighbor shows the same shared rank the chip itself does.
        const neighborsHtml = rankInfo ? getRankNeighbors(rankInfo.sorted, player.id, rankInfo.ranks).map(({ player: np, rank: nr }) => `
            <tr class="rank-chip-row${np.id === player.id ? ' rank-chip-row-current' : ''}">
                <td>#${nr}</td>
                <td>${escapeHtml(np.name)}</td>
                <td>${formatStatValue(np.seasonTotals[id], chipRateIds.has(id))}</td>
            </tr>
        `).join('') : '';
        return `
            <div class="stat-chip"${pctStyle}>
                <span class="stat-chip-label">${escapeHtml(statMap[id])}</span>
                <span class="stat-chip-value"${rankColor ? ` style="color:${rankColor};"` : ''}>${formatStatValue(player.seasonTotals[id], chipRateIds.has(id))}</span>
                ${rankInfo ? `<span class="stat-chip-rank">#${rankInfo.rank} of ${rankInfo.total}</span>` : ''}
                ${neighborsHtml ? `<div class="rank-chip-dropdown"><table>${neighborsHtml}</table></div>` : ''}
            </div>
        `;
    }).join('');

    // AppState.retroSeasons is the engine lane's future store; it does not exist yet, so the optional-chain reads undefined, buildSeasonsBandHtml renders nothing, and this view stays byte-identical to before until that store is real.
    const seasonsBandHtml = buildSeasonsBandHtml(AppState.retroSeasons?.[player.id], statMap, { escapeHtml, categoryOrder: scored });

    // Trending pickups. A move under 5 points in a week is the same "noise, not signal" floor the leaderboard column uses, just set higher here because a header chip is claiming the player is worth a second look, not just reporting a number.
    const rosterChangeHtml = Math.abs(player.rosterChange || 0) >= 5
        ? `<div class="player-rostered-chip">Rostered ${player.rosterPct.toFixed(1)}%, ${player.rosterChange >= 0 ? '+' : ''}${player.rosterChange.toFixed(1)} this week</div>`
        : '';

    // Projection-vs-actual pacing. Compares actual per-game production against ESPN's own preseason projection (draft-engine's projectedLine read: statSourceId 1, split 0, this season) across the league's SCORED counting categories only - rate stats (AVERAGE_STATS) do not pace the way a counted total does, so they are excluded rather than averaged in and diluting the read.
    const pacingHtml = buildProjectionPacingHtml(player, sport, scored, statMap);

    container.innerHTML = `
        <div class="player-detail-header">
            <button id="player-back-btn" class="player-back-btn">&larr; Leaderboard</button>
            <div class="player-detail-title">
                ${buildPlayerAvatarHtml(sport, player.id, player.name)}
                <div class="player-detail-name">
                    <h3>${buildProTeamLogoHtml(sport, proAbbrev)}${escapeHtml(player.name)}${injuryBadgeHtml(player.injuryStatus)}</h3>
                    <span class="player-detail-meta">${escapeHtml(player.teamName)} &middot; ${escapeHtml(player.positionDisplay)}${injuryLabel(player.injuryStatus) ? ` &middot; <span class="player-detail-injury">${escapeHtml(injuryLabel(player.injuryStatus))}</span>` : ''}</span>
                </div>
            </div>
            <div class="player-detail-tools">
                ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
                <button type="button" id="player-compare-btn" class="player-compare-btn">+ Compare</button>
                ${pagerHtml}
            </div>
        </div>
        ${rankChipsHtml ? `<div id="player-rank-chips" class="player-rank-chips">${rankChipsHtml}</div>` : ''}
        ${rosterChangeHtml}
        ${unrankedHtml}
        ${rankBreakdownHtml}
        <div id="player-season-stats" class="player-season-stats">${seasonStatsHtml}</div>
        ${pacingHtml}
        ${seasonsBandHtml}
        <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:300px; margin-top:8px;"></div>
    `;

    // The headshot uses the same plumbing the roster band does, so a missing or failed image leaves the initials tile rather than a broken glyph.
    wirePlayerAvatars(container);
    // The day strip answers a hover through the app's ONE tooltip, not a title attribute - same machinery the charts and the heatmap use, so the strip cannot drift into a second hover language.
    attachDataTooltips(container);
    document.getElementById('player-back-btn').addEventListener('click', closePlayerDetail);
    // The one way into a comparison. A leaderboard-row affordance may follow, which is why openPlayerComparison takes an id and asks nothing about where the click came from.
    document.getElementById('player-compare-btn').addEventListener('click', () => openComparePicker(player));

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

    // S41/G2: the Overall|Matchup switch inside the breakdown bar's own <summary> - stopped from bubbling to the <summary> element itself, which would otherwise ALSO fire the browser's native open/close toggle on every switch click (the two are visually stacked in one bar, but "pick a side" and "open/close the panel" have to stay two different clicks).
    container.querySelectorAll('.rank-breakdown-switch-opt').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            AppState.playerDetailMatchupSide = btn.dataset.matchupSide;
            renderPlayerDetail(player);
        });
    });

    // Track manual open/close so re-rendering (switching pools, stats, timeframe) doesn't keep resetting the panel back to collapsed out from under the user.
    const rankBreakdownEl = container.querySelector('.rank-breakdown');
    if (rankBreakdownEl) {
        rankBreakdownEl.addEventListener('toggle', () => {
            AppState.playerDetailRankBreakdownOpen = rankBreakdownEl.open;
        });
        // Same ruling as the diagnostic console. The chart below kept being squeezed smaller to make room for the explanation of the number above it, which is the wrong trade: the explanation pushes the chart down and the view scrolls while it is open.
        wirePushPanel(rankBreakdownEl, document.getElementById('player-trend-chart'));
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
function weeklyBasisQualifiedPool(samePool, sport, wantPitchers = currentGroupIsSecondary(sport)) {
    const maxGames = Math.max(0, ...samePool.map(p => gamesPlayedOf(p, sport, wantPitchers)));
    if (maxGames === 0) return samePool;
    const threshold = maxGames * MIN_PLAYING_TIME_FRACTION;
    return samePool.filter(p => gamesPlayedOf(p, sport, wantPitchers) >= threshold);
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
    const wantPitchers = currentGroupIsSecondary(sport);
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    // Scoped to the current group's role so a two-way player's off-role stats don't leak into this pool's category list - same reasoning as rotoContext.
    const pitchingIds = roleIdSetFor(sport);
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
        const categoryRates = buildWeeklyValueBasis(weeklyValuesByPlayer, { sport, relevantStatIds, inverseStatIds, avgStatIds });
        // Every category came back empty - e.g. a brand-new, single-matchup window with no completed real weeks yet in anyone's cache to build a distribution from. Fall through to the season-average basis below instead of returning an unusable empty result. perGame: true tells the score callers to normalize the scored week the same way; the fallback below stays per-week (season-average), so it reports perGame: false.
        if (categoryRates.length > 0) return { categoryRates, windowStart, windowEnd, perGame: true };
    }

    // Coverage too thin (or the real-value basis came back empty) to trust yet. Kick off the leaderboard's existing bulk weekly-stats fetch if one isn't already running or permanently failed this session - reuses ensureLeaderboardWeeklyDataLoaded/renderPlayerLeaderboard's own lazy trigger and loading state rather than standing up a second fetch path here. This is fire-and-forget: its own completion re-renders the LEADERBOARD (not an open drill-down), so a chart opened while coverage is still thin keeps showing the fallback basis below until the user reopens it - acceptable degradation for what should be a rare, early-session window.
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport, 'basis');

    const categoryRates = buildCategoryRateBasis(samePool, {
        sport, relevantStatIds, inverseStatIds, avgStatIds,
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


// ==== Player comparison, the free half of: one anchor, one opponent, one view. ====

// Weekly history for a player who is NOT the drill-down's subject. Same request the drill-down makes (fetchPlayerWeeklyStats, one player at a time) and the same cache it fills, so adding a comparison never introduces a request shape the pool path does not already make. What it deliberately does NOT do is touch the Diagnostic Data panel. That panel names the player whose payload it is showing, and the comparison's subject is still the anchor - repointing it at the second player would put one player's raw data under another player's name, which is the exact mismatch the panel's three-context split exists to prevent.
async function ensureComparisonWeekly(playerId, sport) {
    // The SAME condition openPlayerDetail uses, not merely "is anything cached". Two entries can exist without being enough: the bulk pool path caches a weekly-only entry with no dailyByPeriod, and the offline harness caches an empty one - either would have left the opponent unable to draw a Day-axis line while the anchor drew one, which is the axis mismatch guarded against in drawPlayerTrendChart.
    const cached = AppState.playerWeeklyCache[playerId];
    if (cached && cached.dailyByPeriod) return true;
    try {
        const raw = await fetchPlayerWeeklyStats(playerId);
        AppState.playerWeeklyCache[playerId] = processPlayerWeeklyHistory(raw, sport);
        return true;
    } catch {
        // Whatever was already cached stays - a matchup-axis line off the bulk data beats no line. A comparison that cannot draw the second line is still worth showing - the season table reads off the pool, which is already loaded. The chart says so itself rather than the whole view failing.
        return false;
    }
}

function ensureComparePickerModal() {
    let overlay = document.getElementById('compare-modal-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'compare-modal-overlay';
    // The rank explainer's chrome, reused rather than reproduced - same overlay, same panel, same close affordance, so the two modals in this tab cannot drift into two different dialogs.
    overlay.className = 'rank-modal-overlay';
    overlay.innerHTML = `
        <div class="rank-modal-content">
            <button type="button" class="rank-modal-close" id="compare-modal-close-btn">&times;</button>
            <h3>Compare with</h3>
            <div class="cmp-pick-filters">
                <input type="text" id="compare-modal-search" class="cmp-pick-search" placeholder="Search by name">
                <select id="compare-modal-position" class="cmp-pick-position"></select>
            </div>
            <div class="cmp-pick-list" id="compare-modal-list"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    overlay.querySelector('#compare-modal-close-btn').addEventListener('click', () => overlay.classList.remove('open'));
    return overlay;
}

// The picker is scoped to the ANCHOR'S ROLE GROUP, which is what makes every pair same-basis: two batters are ranked against the same batters, two pitchers against the same pitchers. A two-way player pairs inside whichever group the drill-down was opened from, the same rule statIdsForPlayer already follows for which categories are shown. Ordered by the league ranking rather than alphabetically, so the top of the list is the comparison most people are reaching for; the search box is there for the one they are not. No cap on the list - it scrolls, and a silently truncated pool would make a missing player look unrostered.
function openComparePicker(anchor) {
    const sport = AppState.loadedSport;
    const wantPitchers = currentGroupIsSecondary(sport);
    // Ranked against the WHOLE group and filtered afterwards. Ranking the anchor out of the pool first renumbers everyone below, so the league's number two would have been offered as "#1" - a rank that is true of no list the user has ever seen. The position filter below is the same story one level down: it hides rows, it never renumbers them, so a shortstop's #14 is the rank among BATTERS rather than among shortstops - the number the rest of the tab already shows.
    const group = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const ranks = computeLeagueRanks(group, sport, null, wantPitchers).ranks;
    const ordered = group.filter(p => p.id !== anchor.id)
        .sort((a, b) => (ranks.get(a.id) || Infinity) - (ranks.get(b.id) || Infinity) || a.name.localeCompare(b.name));

    const overlay = ensureComparePickerModal();

    // The scoping used to be narrated here ("Batters only, so both players are measured against the same pool"). It is deleted rather than reworded: the picker only ever offers the anchor's own group, so the sentence described the list the reader was already looking at.
    const posSel = overlay.querySelector('#compare-modal-position');
    const positions = positionOptionsFor(ordered, sport, wantPitchers);
    posSel.innerHTML = '<option value="ALL">All Positions</option>' +
        positions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    // One position IS the whole group (hockey Goalies today), so the filter would be a control with nothing to do - the same call buildPositionFilterOptions makes on the leaderboard.
    posSel.style.display = positions.length <= 1 ? 'none' : '';
    posSel.value = 'ALL';

    const listEl = overlay.querySelector('#compare-modal-list');
    const rowHtml = (p) => {
        const rank = ranks.get(p.id);
        return `<button type="button" class="cmp-pick-row" data-player-id="${p.id}">
            <span class="cmp-pick-name">${escapeHtml(p.name)}</span>
            <span class="cmp-pick-meta">${escapeHtml(p.positionDisplay)} &middot; ${escapeHtml(p.teamName)}</span>
            <span class="cmp-pick-rank">${rank ? `#${rank}` : ''}</span>
        </button>`;
    };
    const draw = () => {
        const q = search.value.trim().toLowerCase();
        const pos = posSel.value;
        const shown = ordered.filter(p =>
            (!q || p.name.toLowerCase().includes(q)) &&
            (pos === 'ALL' || p.eligiblePositions.includes(pos)));
        listEl.innerHTML = shown.length
            ? shown.map(rowHtml).join('')
            : '<div class="cmp-pick-empty">No one in this group matches that.</div>';
        listEl.querySelectorAll('.cmp-pick-row').forEach(row => {
            row.addEventListener('click', () => {
                overlay.classList.remove('open');
                openPlayerComparison(Number(row.dataset.playerId));
            });
        });
    };

    const search = overlay.querySelector('#compare-modal-search');
    search.value = '';
    // Assigned rather than added, on both controls, so re-opening the picker replaces the handler instead of stacking another copy of it on the same long-lived modal element.
    search.oninput = draw;
    posSel.onchange = draw;
    draw();
    overlay.classList.add('open');
    search.focus();
}

// Enter the comparison. The anchor is whoever the drill-down was already showing, so this only has to fetch the opponent's history and flip the view-state flag - renderPlayerDetail forks on it, so every existing re-render path (timeframe change, stat switch, the advanced-stats toggle) keeps the comparison up rather than dropping back to one player.
export async function openPlayerComparison(otherId) {
    const sport = AppState.loadedSport;
    const anchor = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    if (!anchor || otherId === anchor.id) return;

    const container = document.getElementById('player-detail-container');
    container.innerHTML = '<div class="player-loading">Loading the comparison...</div>';
    await ensureComparisonWeekly(otherId, sport);

    // Looked up after the fetch for the same reason openPlayerDetail does it: at a windowed timeframe the effective pool only admits a player once their weekly data is cached.
    const other = getEffectivePlayerPool(sport).find(p => p.id === otherId);
    if (!other) {
        // Nothing to compare against in this window. Back to the anchor's own page rather than a half-built comparison, and the drill-down is where the user was one click ago anyway.
        AppState.comparePlayerId = null;
        renderPlayerDetail(anchor);
        return;
    }
    AppState.comparePlayerId = otherId;
    renderPlayerDetail(anchor);
}

// Leave the comparison, keep the anchor. This is what the crumb and the removable legend chip both do, and it is the reason the second player is state rather than a separate screen.
function closePlayerComparison() {
    const sport = AppState.loadedSport;
    const anchor = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    AppState.comparePlayerId = null;
    if (anchor) renderPlayerDetail(anchor);
    else closePlayerDetail();
}

// The 1v1. Season table on top, shared-basis trend chart underneath, and the trail across the top that says where you are - the same breadcrumb pattern My Team's drill-ins use: every earlier crumb is a destination, the tail is the title, and there is no back button.
function renderPlayerComparison(anchor, other) {
    const container = document.getElementById('player-detail-container');
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const weeklyA = (AppState.playerWeeklyCache[anchor.id] || {}).weekly || {};
    const weeklyB = (AppState.playerWeeklyCache[other.id] || {}).weekly || {};
    // Both players' own histories can run past the league's last defined matchup, so the effective max is the larger of all three - same reasoning as the single-player view, one more series.
    const effectiveMaxWeek = Math.max(
        AppState.maxCompletedWeek, 0,
        ...Object.keys(weeklyA).map(Number), ...Object.keys(weeklyB).map(Number)
    );

    // The anchor decides which categories the table shows, because the anchor decided which group tab this pair came from. Same call the drill-down makes, so the two views never disagree about what a batter's or a pitcher's categories are.
    const { scored, advanced } = statIdsForPlayer(anchor, sport, weeklyA);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;

    const wantPitchers = currentGroupIsSecondary(sport);
    const pool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    // lowerIsBetterIds, not INVERSE_STATS alone: a points league can score a category negatively without it ever being in the hardcoded inverse table - football has no ffl entry there at all, so a raw INVERSE_STATS read named leading the league in fumbles lost as an edge for whoever had more of them. pointsWeightsFor is the same slot-aware weight table computePointsRanks already scores this pool by, so the two agree on what "negative" means for a D/ST row exactly as they agree on rank.
    const { rows, tally } = comparePlayerCategories(pool, anchor.id, other.id, {
        statIds: visibleIds,
        inverseStatIds: lowerIsBetterIds(INVERSE_STATS[sport], pointsWeightsFor(sport, wantPitchers)),
        statMap
    });

    const leagueRanks = computeLeagueRanks(pool, sport, null, wantPitchers);
    const headHtml = (p, side) => {
        const rank = leagueRanks.ranks.get(p.id);
        const games = gamesPlayedOf(p, sport, currentGroupIsSecondary(sport));
        return `
            <div class="cmp-head cmp-head-${side}">
                ${buildPlayerAvatarHtml(sport, p.id, p.name)}
                <div class="cmp-head-text">
                    <div class="cmp-head-name">${escapeHtml(p.name)}${injuryBadgeHtml(p.injuryStatus)}</div>
                    <div class="cmp-head-meta">${escapeHtml(p.teamName)} &middot; ${escapeHtml(p.positionDisplay)}</div>
                    <div class="cmp-head-chips">
                        ${rank ? `<span class="cmp-chip">#${rank} of ${leagueRanks.total}</span>` : '<span class="cmp-chip cmp-chip-quiet">Unranked</span>'}
                        <span class="cmp-chip cmp-chip-quiet">${games} GP</span>
                    </div>
                </div>
            </div>`;
    };

    // THE LEDGER. The mirrored percentile bars are gone. They answered a question nobody was asking - where each player sits in the pool, which the rank chip in that head already says - while burying the one being asked, which is who won this category and by how much. So the row now reads as a ledger line: the two values side by side against a centre spine, and on the spine the EDGE, arrow pointing at the winner.
    const valHtml = (side, row, which) => {
        if (!side) return `<span class="cmp-val cmp-val-${which} cmp-val-none" title="No value in this category for the selected timeframe">-</span>`;
        // The loser is dimmed rather than the winner merely coloured, so the eye lands on the winning column down the whole table without every row shouting.
        const cls = row.edge === which ? ' cmp-win' : (row.edge === 'none' ? '' : ' cmp-lose');
        const tip = `#${side.rank} of ${side.total} - beats ${Math.round(side.percentile)}% of the pool`;
        return `<span class="cmp-val cmp-val-${which}${cls}" title="${escapeHtml(tip)}">${formatStatValue(side.value)}</span>`;
    };

    // The signed gap, in the category's own units, formatted by the SAME formatStatValue the value columns either side of it use. It was written +.050 first, dropping the leading zero the way a batting average is written in the sport. That is correct baseball and it read wrong here anyway, because the chip sits BETWEEN two numbers that keep theirs - "0.299 +.050 0.249" puts three figures on one line in two notations, which reads as a formatting slip rather than as a convention. Two ways to make the row agree, and this is the cheaper one. The other is to drop the leading zero in the ledger's own value columns, which fixes the row but makes the ledger disagree with the leaderboard one click away - a new inconsistency in exchange for the old one. Dropping it EVERYWHERE for sub-1 rates is the coherent version and is a decision about every table in the tab, so it is filed rather than taken here.
    const gapHtml = (row) => {
        if (row.edge === 'none') return '<span class="cmp-edge cmp-edge-none">&mdash;</span>';
        if (row.edge === 'tie') return '<span class="cmp-edge cmp-edge-tie">even</span>';
        const shown = `+${formatStatValue(Math.abs(row.a.value - row.b.value))}`;
        // The arrow points AT the winner, which means it points left when the left player won. The chip's own colour matches, so the direction and the hue say the same thing twice - the arrow alone is four pixels of meaning at this size.
        return row.edge === 'a'
            ? `<span class="cmp-edge cmp-edge-a">&larr;&thinsp;${escapeHtml(shown)}</span>`
            : `<span class="cmp-edge cmp-edge-b">${escapeHtml(shown)}&thinsp;&rarr;</span>`;
    };

    const rowsHtml = rows.map(row => `
        <div class="cmp-row">
            <span class="cmp-cat">${escapeHtml(row.name)}${row.inverse ? '<span class="cmp-inv" title="Lower is better">&darr;</span>' : ''}</span>
            ${valHtml(row.a, row, 'a')}
            ${gapHtml(row)}
            ${valHtml(row.b, row, 'b')}
        </div>`).join('');

    // THE STRIP. The tally sentence is gone - "Freddie Freeman leads 4 categories, Pete Alonso 4, and 1 is even" spelled out a shape, and a shape is what a strip is for. Counts sit at the ends beside their own player's head, so neither number has to be labelled. Segments carry no width of their own: flex-grow is set from the counts, the same trick League History's head-to-head bar uses, so the split IS the tally and nothing computes a percentage. A zero count grows to nothing and does not appear. The empty case keeps a sentence, and deliberately: it is not a tally with nothing in it, it is the absence of one, and a strip with no segments would read as a rendering failure. It happens for real - a narrow window one of them did not play in leaves every row one-sided.
    const compared = tally.a + tally.b + tally.tie;
    const stripTip = `${tally.a} to ${tally.b}${tally.tie ? `, ${tally.tie} even` : ''}`;
    const tallyHtml = compared === 0
        ? `<div class="cmp-tally">No category has a value for both players in this timeframe, so there is nothing to compare yet. A wider timeframe usually fixes it.</div>`
        : `<div class="cmp-strip" title="${escapeHtml(stripTip)}">
            <span class="cmp-strip-count cmp-strip-count-a">${tally.a}</span>
            <span class="cmp-strip-track">
                <span class="cmp-seg cmp-seg-a" style="flex-grow:${tally.a};"></span>
                <span class="cmp-seg cmp-seg-tie" style="flex-grow:${tally.tie};"></span>
                <span class="cmp-seg cmp-seg-b" style="flex-grow:${tally.b};"></span>
            </span>
            <span class="cmp-strip-count cmp-strip-count-b">${tally.b}</span>
        </div>`;

    // Same stat picker the drill-down carries, and it drives the same chart - the comparison is the drill-down with a second line, not a second charting surface.
    const { options: statOptions, preferred } = buildTrendStatOptions(anchor, sport, weeklyA);
    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || preferred;
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    container.innerHTML = `
        <div class="cmp-crumbs">
            <button type="button" class="mt-crumb" id="cmp-crumb-board">Leaderboard</button>
            <span class="mt-crumb-sep">&rsaquo;</span>
            <button type="button" class="mt-crumb" id="cmp-crumb-anchor">${escapeHtml(anchor.name)}</button>
            <span class="mt-crumb-sep">&rsaquo;</span>
            <span class="mt-crumb-here">vs ${escapeHtml(other.name)}</span>
        </div>
        <div class="cmp-heads">
            ${headHtml(anchor, 'a')}
            <div class="cmp-heads-sep">vs</div>
            ${headHtml(other, 'b')}
        </div>
        ${tallyHtml}
        <div class="cmp-table">${rowsHtml || '<div class="cmp-pick-empty">No scored categories to compare in this timeframe.</div>'}</div>
        <div class="cmp-chart-tools">
            ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
        </div>
        <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:220px;"></div>
    `;

    wirePlayerAvatars(container);
    document.getElementById('cmp-crumb-board').addEventListener('click', closePlayerDetail);
    document.getElementById('cmp-crumb-anchor').addEventListener('click', closePlayerComparison);

    const picker = document.getElementById('player-stat-picker');
    if (picker) picker.addEventListener('change', (e) => {
        AppState.playerDetailStat = e.target.value;
        renderPlayerComparison(anchor, other);
    });

    if (currentStat) {
        drawPlayerTrendChart(anchor, currentStat, weeklyA, effectiveMaxWeek, { player: other, weekly: weeklyB });
        // The legend chip is drawn by the chart (it belongs beside the lines it names), and removing it is the same exit the anchor crumb is.
        const removeBtn = document.getElementById('cmp-legend-remove');
        if (removeBtn) removeBtn.addEventListener('click', closePlayerComparison);
    } else {
        document.getElementById('player-trend-chart').innerHTML = '<div class="player-loading">No stat history available to chart.</div>';
    }
}

// THE ZOOM. A matchup point is a door: clicking it redraws the chart over that matchup's own days, and the crumb in the header comes back out. The state is one record, keyed to the player, the stat and the timeframe it was opened under, so a different drill-down, a picker change or a timeframe move all silently close it - a zoom into matchup 9 has no meaning once the picker shows a different stat, and carrying it over would be a surprise, not a convenience. lastTrendArgs is how a click redraws: the same call renderPlayerDetail made, repeated.
let chartZoom = null;
let lastTrendArgs = null;

function drawPlayerTrendChart(player, stat, weekly, maxWk, other = null) {
    const container = document.getElementById('player-trend-chart');
    const sport = AppState.loadedSport;
    lastTrendArgs = { player, stat, weekly, maxWk, other };
    if (chartZoom && (other || chartZoom.playerId !== player.id || chartZoom.statId !== stat.id || chartZoom.timeframe !== AppState.timeframe)) chartZoom = null;

    // weekly is already keyed by fantasy week (matchupPeriodId) and summed/averaged per stat - the day-to-week rollup happened once in processPlayerWeeklyHistory, using the league's own schedule mapping. maxWk is the EFFECTIVE max week (see renderPlayerDetail), not AppState.maxCompletedWeek directly - a league whose own matchup schedule ends well before the real season does would otherwise cut "Regular Season + Playoffs" off early and hide real weeks of this player's own data.
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, maxWk, AppState.regSeasonWeeks, AppState.currentMatchup);
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const isWeeklyPoints = stat.id === WEEKLY_POINTS_STAT_ID;

    // At Current, and only at Current, the axis becomes DAYS of the matchup being played. One matchup on a matchup axis is a single point, which is the "mostly straight lines" the owner reported; the same window across its own scoring periods is a real progression. BOTH OR NEITHER. buildDayAxisSeries answers per player, not just per timeframe - it returns null for anyone with no day-level history cached, and for anyone who played none of the matchup's days. One player on days (x = 0, 1, 2...) beside one on matchups (x = 24) is not a shared axis at all, it is two rulers in one frame, so a comparison that cannot put both on days puts both on matchups instead. Alone, this is exactly the old behaviour. The zoom is the other way onto a day axis: any matchup, on any timeframe, once clicked. It is never offered in a comparison - two players zoomed into one matchup is a view nobody asked for, and the shared-axis rule below already has enough to reconcile.
    const zoomDays = chartZoom ? buildZoomDaySeries(player, stat, chartZoom.matchup, isWeeklyRank, isWeeklyPoints, sport) : null;
    if (chartZoom && !zoomDays) chartZoom = null;
    const anchorDays = zoomDays || buildDayAxisSeries(player, stat, tfStart, tfEnd, isWeeklyRank, isWeeklyPoints);
    const otherDays = other ? buildDayAxisSeries(other.player, stat, tfStart, tfEnd, isWeeklyRank, isWeeklyPoints) : null;
    const useDays = other ? !!(anchorDays && otherDays) : !!anchorDays;
    const dayAxis = useDays ? anchorDays : null;
    const otherDayAxis = useDays ? otherDays : null;
    const zoomed = !!(chartZoom && dayAxis);
    // A zoomed per-pool picker plots the day SELF-scores, which are a 0-100 figure of their own and not a cumulative run of the stat - the header arithmetic below has to know.
    const zoomSelfScore = zoomed && (isWeeklyRank || isWeeklyPoints);

    // Which x positions exist. Alone that is just the weeks this player has data for, exactly as before. In a comparison it is the UNION, so a matchup one of them missed still holds its place on the axis instead of the two lines being drawn on two different rulers.
    const weeksOf = (p, weeklyP, axis) => axis
        ? axis.days.map(d => d.index)
        : Object.keys(weeklyP).map(Number).filter(w => w >= tfStart && w <= tfEnd).sort((a, b) => a - b);
    const ownWeeks = weeksOf(player, weekly, dayAxis);
    const weeks = other
        ? [...new Set([...ownWeeks, ...weeksOf(other.player, other.weekly, otherDayAxis)])].sort((a, b) => a - b)
        : ownWeeks;

    // One player's values ON the shared axis. A position that player has no data for is null rather than 0 - a missed matchup is an absence, and drawing it as a zero would invent a bad week. A week they DID play but posted nothing in is still a real 0, which is why the check is on the week's presence in the cache rather than on the value.
    const valuesOn = (p, weeklyP, axis, list) => {
        if (axis) {
            const byIndex = new Map(axis.days.map((d, i) => [d.index, axis.values[i]]));
            return list.map(w => (byIndex.has(w) ? byIndex.get(w) : null));
        }
        const rankScores = isWeeklyRank ? computeWeeklyRankSeries(p, sport, weeklyP, list.filter(w => weeklyP[w])) : null;
        return list.map(w => {
            if (!weeklyP[w]) return null;
            if (isWeeklyRank) return rankScores[w] ?? 0;
            // The weekly cache keys raw stat sums by matchup, so this is the same weighted sum the rank uses, evaluated one matchup at a time.
            if (isWeeklyPoints) return pointsForStatBucket(weeklyP[w], p, sport);
            return weeklyP[w][stat.id] || 0;
        });
    };
    const actualValues = valuesOn(player, weekly, dayAxis, weeks);
    const otherValues = other ? valuesOn(other.player, other.weekly, otherDayAxis, weeks) : null;
    // Every figure below - the totals, the average line, the integrity check - describes the ANCHOR, so they read the anchor's real points and ignore the holes the union may have opened. Alone there are none, which is why the numbers are unchanged for a single player.
    const plotted = actualValues.filter(v => v !== null);
    // Day N, the vocabulary the race cards already use. axisUnit stays untouched. It names matchup and week axes, and this is neither. On a day axis the tick is the real date when the pro schedule can supply one (MM-DD, the owner's format - item 2) and Day N until it lands; ensureScheduleDates redraws this chart itself when the answer arrives. The period behind each index is what the verdicts are keyed by.
    const periodOfIndex = dayAxis ? new Map(dayAxis.days.map(d => [d.index, d.period])) : null;
    if (dayAxis) ensureScheduleDates();
    const labelFor = dayAxis ? (i) => dayChipLabel(periodOfIndex.get(i), i + 1) : formatMatchupLabel;

    const isRateStat = (AVERAGE_STATS[sport] || new Set()).has(stat.id);
    // At any non-full-season timeframe the drilled player comes from getEffectivePlayerPool, whose seasonTotals are the WINDOWED aggregate - so a header reading "Season Total" over them is a number wearing the wrong label. On the matchup axis the lie was self-consistent, since the matchups shown summed to exactly that windowed figure and nothing ever contradicted it; the Day axis broke the coincidence and made it visible.
    const windowed = !isFullSeasonTimeframe();

    // Per-week gap notes (missing weeks at the edges or in the middle of the range) were removed - they were mostly noise once the day-to-week mapping bug was fixed (a real bye/IL week with zero games played would still trigger one, which isn't actually a data problem). The season-total mismatch check below is kept as a real safety net. It only fires when the weeks actually shown don't add up to ESPN's own verified season total, which is a genuine sign something's missing rather than just "this player didn't play that week." The note has no meaning on the Day axis and printed three wrong numbers there. It SUMMED a cumulative series, so an HR hit once and carried forward across four days "added up to" 4, and it compared that against a windowed total labelled Season. The valid integrity check for a day series is that its last value equals the windowed aggregate - both come off the same weeklySums - but that is a different assertion needing different wording, not this.
    const gapNotes = [];
    if (!dayAxis && !isWeeklyRank && !isWeeklyPoints && !isRateStat) {
        const plottedSum = plotted.reduce((a, b) => a + b, 0);
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
        avgVal = plotted.length ? plotted.reduce((a, b) => a + b, 0) / plotted.length : 0;
        actualTotal = avgVal;
        // S41: matches the stat option's own rename ("Score by matchup") - sentence-case here since this reads inline ("Avg score by matchup: 0.5"), not as a picker option label.
        avgLabel = `Avg score by ${axisUnit().long.toLowerCase()}`;
        totalLabel = avgLabel;
    } else {
        // Rate stats (AVG, ERA, etc.) use ESPN's own verified season rate directly for the reference line - no risk of an "average of rates" computation error creeping back in. Counting stats (HR, RBI, etc.) used to divide ESPN's real season TOTAL by weeks.length (the number of weeks with cached data) - but weeks.length can undercount real weeks played when ESPN's own weekly history has a data gap (see the gap-note logic above), while the season total is still the TRUE full-season count. That mismatch inflated the average line well above the actual plotted points for any player with a gap (confirmed: HR/R/RBI reference lines sitting above literally every week's bar). Averaging the exact values being plotted instead guarantees the line can never be inconsistent with the chart it's drawn on, at the cost of not reflecting weeks missing from the cache. Points have no seasonTotals entry to read. The total is what the plotted matchups add up to, which is also the honest figure for a windowed timeframe, where a season number would contradict the chart under it. A cumulative series' LAST point is the window's total already - for a derived rate exactly as much as for a count, since aggregateDailyCumulative rebuilds each day's rate from the components accumulated through it. It equals the windowed seasonTotals by construction; reading the endpoint rather than that field keeps the figure and the line it labels provably the same number.
        let seasonValue;
        if (isWeeklyPoints) seasonValue = +plotted.reduce((a, b) => a + b, 0).toFixed(1);
        else if (dayAxis) seasonValue = plotted.length ? plotted[plotted.length - 1] : 0;
        else seasonValue = player.seasonTotals[stat.id] || 0;

        actualTotal = seasonValue;
        avgVal = (isRateStat && !isWeeklyPoints) ? seasonValue : (plotted.length ? plotted.reduce((a, b) => a + b, 0) / plotted.length : 0);
        avgLabel = (isRateStat && !isWeeklyPoints)
            ? (windowed ? `Avg, ${axisUnit().plural.toLowerCase()} shown` : 'Season Avg')
            : 'Avg/Matchup';
        if (isWeeklyPoints) totalLabel = `Points, ${axisUnit().plural.toLowerCase()} shown`;
        else if (dayAxis) totalLabel = 'Matchup Total';
        else if (windowed) totalLabel = `Total, ${axisUnit().plural.toLowerCase()} shown`;
        else totalLabel = 'Season Total';
    }
    // A horizontal mean of a monotone cumulative series is noise, and "Avg/Matchup" names an axis this chart no longer has. The Matchup Total alone is the honest header for a day series, so the reference line goes away with its figure rather than being restated as a per-day pace - which would be a fourth number to reconcile against three that are already on screen. The self-score zoom has no total to speak of - a mean of day scores is the one figure that reads, and 50 is the player's own typical day by construction (presentDayScore).
    if (zoomSelfScore) {
        actualTotal = plotted.length ? plotted.reduce((a, b) => a + b, 0) / plotted.length : 0;
        totalLabel = 'Avg Day Score';
    }
    const showAvgLine = !dayAxis && !other;
    if (!showAvgLine) avgVal = 0;
    const avgDisplay = (isWeeklyRank || isWeeklyPoints) ? avgVal.toFixed(1) : formatStatValue(avgVal);
    // Matchup Score's "total" and "average" are the same single number (the mean of the matchup scores) - showing both labels back to back just duplicated the same value, so only the one reference-line stat is shown for it, matching the single dashed line actually drawn.
    const totalStatHtml = (isWeeklyRank && !zoomSelfScore) ? '' : `<div>${totalLabel}: <strong>${zoomSelfScore ? Math.round(actualTotal) : (isWeeklyPoints ? Number(actualTotal).toFixed(1) : formatStatValue(actualTotal))}</strong></div>`;
    // Matchup Score is our own computed stat (not an ESPN number), so it's the one chart that needs to explain itself - every other selectable stat is a familiar box-score category. A click, not a hover sentence (owner,: "I honestly still do not get it"). The explainer is a worked example off this player's own latest plotted week, so the reader sees the number being made rather than reads a description of it. S41: names the renamed stat, not the old "Matchup Score" wording - matchup-rank.js's own contract says the two figures must never share a word, and a stale name on this button beside the freshly-renamed heading would do exactly that.
    const matchupScoreInfo = (isWeeklyRank && !other)
        ? `<button type="button" id="matchup-score-explainer" class="rank-explainer-trigger" aria-label="How ${escapeHtml(stat.name)} is calculated">ⓘ</button>`
        : '';
    // The heading names the axis under it, so it follows the same swap the tick labels do.
    const trendLabel = dayAxis ? 'Day' : axisUnit().long;
    // Zoomed, the heading names the matchup it is inside and the crumb is the way out. The crumb is a button because it does something; it reads as a crumb because that is what it is.
    const zoomCrumbHtml = zoomed
        ? `<button type="button" id="trend-zoom-back" class="trend-zoom-back">&lsaquo; All ${escapeHtml(axisUnit().plural.toLowerCase())}</button>`
        : '';
    const headingText = zoomed
        ? `${escapeHtml(stat.name)} - ${escapeHtml(axisUnit().long)} ${chartZoom.matchup}, Day By Day`
        : `${escapeHtml(stat.name)} - ${trendLabel} Trend`;
    const avgStatHtml = showAvgLine
        ? `<div style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:var(--chart-avg); border-top:2px dashed var(--chart-avg);"></span> ${avgLabel}: <strong>${avgDisplay}</strong></div>`
        : '';
    // In a comparison the two names ARE the reading key, so they replace the anchor's own totals in the header row: a Season Total with no name on it beside two lines would belong to whichever player the reader assumed. The second chip carries the exit, because the place you remove a player from is the place you can see them.
    const legendHtml = other ? `
        <div class="cmp-legend">
            <span class="cmp-legend-chip"><span class="cmp-swatch cmp-swatch-a"></span>${escapeHtml(player.name)}</span>
            <span class="cmp-legend-chip"><span class="cmp-swatch cmp-swatch-b"></span>${escapeHtml(other.player.name)}<button type="button" id="cmp-legend-remove" class="cmp-legend-remove" title="Remove ${escapeHtml(other.player.name)} from the comparison">&times;</button></span>
        </div>` : '';
    const summary = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
            <h4 style="margin:0; font-size:14px; color:var(--text-body); display:flex; align-items:center; gap:8px;">${zoomCrumbHtml}<span>${headingText}</span>${matchupScoreInfo}</h4>
            <div style="font-size:12px; color:var(--text-muted); display:flex; gap:15px; align-items:center;">
                ${other ? legendHtml : `${totalStatHtml}${avgStatHtml}`}
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
    const maxVal = getNiceMax(Math.max(...plotted, ...(otherValues || []).filter(v => v !== null), avgVal, 0));
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
    const otherPts = [];
    weeks.forEach((w, i) => {
        const x = padding + (numWeeks === 0 ? 0 : (i / numWeeks) * (svgWidth - padding * 2));
        const yFor = (v) => svgHeight - padding - (v / maxVal) * (svgHeight - padding * 2);

        // A null is skipped rather than plotted, so the line joins the points either side of a gap. That is the same thing the single-player chart has always done with a week it has no data for - it left the week off the axis entirely - said on a shared axis instead.
        if (actualValues[i] !== null) actualPts.push({ x, y: yFor(actualValues[i]), week: w, value: actualValues[i] });
        if (otherValues && otherValues[i] !== null) otherPts.push({ x, y: yFor(otherValues[i]), week: w, value: otherValues[i] });
        if (labelIndices.has(i)) {
            svgStr += `<text x="${x}" y="${svgHeight - 10}" font-size="11" text-anchor="middle" style="fill:var(--chart-axis)">${labelFor(w)}</text>`;
        }
    });

    // Weekly average reference line, drawn under the data line so individual points still stand out clearly above/below it.
    if (showAvgLine) {
        const avgY = svgHeight - padding - (avgVal / maxVal) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${avgY}" x2="${svgWidth - padding}" y2="${avgY}" stroke-width="1.5" stroke-dasharray="6,4" style="stroke:var(--chart-avg)" />`;
    }

    // ONE drawing routine, called once alone and twice in a comparison, so the two series cannot drift into different dot sizes, hit targets or tooltip wording. The colours are tokens (--compare-a / --compare-b), which is what lets each style choose its own pair; --compare-a is the accent both styles already drew this line in, so a single-player chart is unchanged. THE VERDICTS. Alone, every point wears a colour: on the matchup axis the season-best week of the plotted stat is gold, a week over the player's own median is green, under it red, at it grey (matchupVerdictInfo); on a day axis the day grammar built does the same job (dayInfoFor), with a signature day the gold. The line itself stays the accent, so the colour is a reading of each point and not a fourth series. A comparison paints nothing - two sets of verdicts in one frame would be unreadable, and the names are the key there.
    const dayInfo = (!other && dayAxis) ? dayInfoFor(player, sport, dayAxis.days.map(d => d.period)) : null;
    const matchupVerdicts = (!other && !dayAxis) ? matchupVerdictInfo(player, sport, weekly, stat, isWeeklyRank, isWeeklyPoints) : null;
    const verdictOf = (p) => {
        if (dayInfo) {
            const v = dayInfo.byPeriod.get(periodOfIndex.get(p.week))?.verdict;
            return v === 'signature' ? 'best' : (v === 'ordinary' ? 'even' : (v || 'even'));
        }
        if (matchupVerdicts) return matchupVerdicts.verdictOf(p.value);
        return null;
    };
    const verdictColour = { best: 'var(--medal-gold)', above: 'var(--success)', below: 'var(--danger)', even: 'var(--text-faint)', off: 'var(--text-faint)' };
    const drawSeries = (pts, color, name) => {
        svgStr += `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="2.5" style="stroke:${color}" />`;
        pts.forEach(p => {
            const verdict = verdictOf(p);
            const dotColour = verdict ? verdictColour[verdict] : color;
            // The hover on a zoomed or Current day carries what the chips used to say (C-B): the day's self-score and its notable line, after the chart's own number for the day.
            const day = dayInfo ? dayInfo.byPeriod.get(periodOfIndex.get(p.week)) : null;
            const dayExtra = day && day.played
                ? [day.score !== null ? `Day score ${day.score}` : '', day.notable || day.line].filter(Boolean).join(MIDDOT_SEP)
                : '';
            // No opponent/matchup info here - a player may have been picked up by this fantasy team partway through the season, so a real matchup that week doesn't necessarily mean the player was actually rostered for it. Showing it without checking real transaction history would be misleading. Points are a scored total, not a rate. One decimal is the precision the league itself shows, and formatStatValue's three would print 26.400 for a 26.4-point matchup. A day self-score is already an integer by presentDayScore; one decimal on it would be the false precision that function exists to remove.
            const displayValue = zoomSelfScore ? String(Math.round(p.value)) : ((isWeeklyRank || isWeeklyPoints) ? p.value.toFixed(1) : formatStatValue(p.value));
            // labelFor, not axisUnit plus the raw x-value. On the Day axis those x-values are 0-BASED indexes, so the old line read "Matchup 2" over the third day - wrong noun AND off by one. labelFor is what the tick under the point already renders, so the two cannot disagree.
            const pointLabel = dayAxis ? labelFor(p.week) : `${axisUnit().long} ${p.week}`;
            // The name leads in a comparison, because two dots at the same x have to say whose they are before they say what they are. Alone there is nobody to confuse it with. A zoomed per-pool picker's value IS the day score, so the hover does not say it twice.
            const figure = zoomSelfScore ? `Day score ${escapeHtml(displayValue)}` : `${escapeHtml(displayValue)} ${escapeHtml(stat.name)}`;
            const extra = zoomSelfScore ? (day && day.played ? (day.notable || day.line) : '') : dayExtra;
            const bestNote = verdict === 'best' && !dayInfo ? `${MIDDOT_SEP}Season best` : '';
            const clickNote = (matchupVerdicts && !dayAxis) ? `${MIDDOT_SEP}Click for the days` : '';
            const tooltipText = `${name ? `${escapeHtml(name)} - ` : ''}${pointLabel}: ${figure}${extra ? MIDDOT_SEP + escapeHtml(extra) : ''}${bestNote}${clickNote}`;
            // A bigger transparent hit target on top of the small visible dot - r="4" alone is a tiny, hard-to-hover target, especially with many weeks crowded into a narrow chart. The season best wears a ring with a SURFACE halo under it. In Boxscore the line itself is gold, and a gold dot on a gold line is invisible; the halo cuts the line around the point, so the ring reads in both styles as the one point the line does not pass through.
            if (verdict === 'best') {
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="8.5" style="fill:var(--surface); pointer-events:none;" />`;
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="7" fill="none" stroke-width="2" style="stroke:${dotColour}; pointer-events:none;" />`;
            }
            svgStr += `<circle cx="${p.x}" cy="${p.y}" r="${verdict === 'best' ? 3.5 : 4}" style="fill:${dotColour}; pointer-events:none;" />`;
            const zoomAttr = (matchupVerdicts && !dayAxis) ? ` data-zoom-week="${p.week}"` : '';
            svgStr += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent" style="cursor:pointer;" data-tooltip="${tooltipText}"${zoomAttr} />`;
        });
    };
    drawSeries(actualPts, 'var(--compare-a)', other ? player.name : null);
    if (other) drawSeries(otherPts, 'var(--compare-b)', other.player.name);
    svgStr += `</svg>`;

    svgWrap.innerHTML = svgStr;
    attachDataTooltips(svgWrap);

    // The door in and the crumb out. Both redraw through the arguments this call was made with, so the zoomed chart is the same chart, not a second renderer.
    const redraw = () => { if (lastTrendArgs) drawPlayerTrendChart(lastTrendArgs.player, lastTrendArgs.stat, lastTrendArgs.weekly, lastTrendArgs.maxWk, lastTrendArgs.other); };
    svgWrap.querySelectorAll('[data-zoom-week]').forEach(el => {
        el.addEventListener('click', () => {
            chartZoom = { playerId: player.id, statId: stat.id, timeframe: AppState.timeframe, matchup: Number(el.dataset.zoomWeek) };
            redraw();
        });
    });
    const back = document.getElementById('trend-zoom-back');
    if (back) back.addEventListener('click', () => { chartZoom = null; redraw(); });
    const explain = document.getElementById('matchup-score-explainer');
    if (explain) {
        // The example week is the last one the chart actually plotted, so the figure in the modal is a point the reader can find on the line behind it.
        const exampleWeek = zoomed ? chartZoom.matchup : (actualPts.length ? actualPts[actualPts.length - 1].week : null);
        explain.addEventListener('click', () => openMatchupScoreExplainer(player, sport, weekly, exampleWeek));
    }
}

// ==== THE MATCHUP SCORE EXPLAINER. Three steps, drawn rather than described, from one real week of the player on screen: the week's line, one percentile bar per scored category against the pool's other real weeks, and the average of those bars - which IS the score, off scoreWeekByCategory, the same rows scoreWeekAgainstBasis averages for the chart. ====
function ensureMatchupScoreModal() {
    let overlay = document.getElementById('matchup-modal-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'matchup-modal-overlay';
    overlay.className = 'rank-modal-overlay';
    overlay.innerHTML = `
        <div class="rank-modal-content">
            <button type="button" class="rank-modal-close" id="matchup-modal-close-btn">&times;</button>
            <h3>How Score by matchup works</h3>
            <div class="rank-modal-subtitle" id="matchup-modal-subtitle"></div>
            <div class="rank-modal-step">
                <div class="rank-modal-step-num">1</div>
                <div class="rank-modal-step-body">
                    <h4>Take the week</h4>
                    <p>The player's line in every category the league scores.</p>
                    <div class="rank-modal-category-list" id="matchup-modal-line"></div>
                </div>
            </div>
            <div class="rank-modal-step">
                <div class="rank-modal-step-num">2</div>
                <div class="rank-modal-step-body">
                    <h4>Compare each category to every other week</h4>
                    <p id="matchup-modal-pool-note"></p>
                    <p class="ms-bar-key">&darr; lower is better</p>
                    <div class="ms-bars" id="matchup-modal-bars"></div>
                </div>
            </div>
            <div class="rank-modal-step">
                <div class="rank-modal-step-num">3</div>
                <div class="rank-modal-step-body">
                    <h4>Average the bars</h4>
                    <div class="ms-total" id="matchup-modal-total"></div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    overlay.querySelector('#matchup-modal-close-btn').addEventListener('click', () => overlay.classList.remove('open'));
    return overlay;
}

function openMatchupScoreExplainer(player, sport, weekly, week) {
    const overlay = ensureMatchupScoreModal();
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const unit = axisUnit().long;
    const wantPitchers = currentGroupIsSecondary(sport);
    const roleLabel = groupLabel(sport, wantPitchers);
    const avgStatIds = AVERAGE_STATS[sport] || new Set();
    const { categoryRates, perGame } = buildWeeklyRateBasis(sport);
    const weekStats = week !== null && weekly[week] ? weekly[week] : null;
    const games = (((AppState.playerWeeklyCache[player.id] || {}).weeklySums || {})[week] || {}).games || 0;
    const stats = weekStats ? (perGame ? perGameCountingStats(weekStats, games, avgStatIds) : weekStats) : null;
    const rows = stats ? scoreWeekByCategory(player, stats, categoryRates) : [];

    overlay.querySelector('#matchup-modal-subtitle').textContent = weekStats
        ? `${player.name}, ${unit} ${week}${games ? ` (${games} game${games === 1 ? '' : 's'})` : ''} - a worked example`
        : `${player.name} - no ${unit.toLowerCase()} to work from yet`;

    // Step 1: the raw line, as the box score would print it - not the per-game figure step 2 compares.
    const lineIds = categoryRates.map(c => c.id).filter(id => weekStats && weekStats[id] !== undefined);
    overlay.querySelector('#matchup-modal-line').innerHTML = lineIds.length
        ? lineIds.map(id => `<span class="rank-modal-category-chip">${escapeHtml(statMap[id] || id)} ${escapeHtml(formatStatValue(weekStats[id]))}</span>`).join('')
        : '<em>Nothing recorded.</em>';

    // Step 2: one bar per category. The bar is how much of the pool's weeks this one beat; an inverse category (ERA, GAA) says so, because a small number filling a big bar needs the why.
    const poolWeeks = categoryRates.length ? Math.max(...categoryRates.map(c => c.rates.length)) : 0;
    overlay.querySelector('#matchup-modal-pool-note').textContent = perGame
        ? `Against the real weeks every other ranked ${roleLabel.toLowerCase().replace(/s$/, '')} had in this timeframe (${poolWeeks} of them), per game played, so a long week and a short one are judged fairly. The bar is the share of those weeks this one beat.`
        : `Against every other ranked ${roleLabel.toLowerCase().replace(/s$/, '')}'s typical week in this timeframe. The bar is the share of those this one beat.`;
    overlay.querySelector('#matchup-modal-bars').innerHTML = rows.length
        ? rows.map(r => {
            const pct = Math.round(r.percentile);
            const shown = perGame && !avgStatIds.has(r.id) ? `${formatStatValue(r.value)}/g` : formatStatValue(r.value);
            return `<div class="ms-bar-row">
                <span class="ms-bar-label">${escapeHtml(statMap[r.id] || r.id)}${r.inverse ? ' ↓' : ''}</span>
                <span class="ms-bar-value">${escapeHtml(shown)}</span>
                <span class="ms-bar-track"><span class="ms-bar-fill" style="width:${pct}%"></span></span>
                <span class="ms-bar-pct">beat ${pct}%</span>
            </div>`;
        }).join('')
        : '<em>No categories could be scored for this week.</em>';

    // Step 3: the mean of the bars, and the fact that it is the chart's number.
    const score = rows.length ? rows.reduce((a, r) => a + r.percentile, 0) / rows.length : null;
    overlay.querySelector('#matchup-modal-total').innerHTML = score === null
        ? ''
        : `<span class="ms-total-sum">(${rows.map(r => Math.round(r.percentile)).join(' + ')}) &divide; ${rows.length}</span>
           <span class="ms-total-eq">=</span>
           <span class="ms-total-figure">${score.toFixed(1)}</span>
           <span class="ms-total-note">the point on the chart. 50 is a mid-pack week; 100 beat every week in the pool.</span>`;
    overlay.classList.add('open');
}


// ==== THE PROJECTED BOARD ==== Moved here from draft-view.js, and the destination was argued rather than assumed. The obvious home looked like draft-engine.js, where positionDepth went - but that lift worked because positionDepth is genuinely pure once its four TABLES are arguments. buildBoard is not: it reads AppState's sport, pool, league type and scored ids directly, and calls six helpers that are themselves AppState readers. Making it "pure" would have meant injecting six functions and seven values through an opts bag, several of them closures over AppState - impurity passed in through the door, and a thirteen-entry contract to satisfy before calling a function that used to just work. The rule that actually applies is that a VIEW must never import another view. players.js is the shared impure data layer both faces already import - computeGroupRanks and matchesPlayerGroup live here and draft-view takes them from here today - so the board sits beside the machinery it calls, the injection bag disappears, and the pre-draft face can build the same board the Draft tab does. ONE BOARD, so the two can never disagree about a player's value.

let adpFillerCache = { ref: null, value: null };

// THE BOARD. One row per player, ranked by what that player is worth OVER REPLACEMENT. The engine ranks a player against their OWN group - batters against batters, pitchers against pitchers - which is what makes the leaderboard's "#11 of 70" mean seventy batters. A draft board has to be one list, and the raw scores cannot be merged: the two groups share a centre and not a spread. Measured on a real pool, the batters topped out at 84.3 and the pitchers at 98.4 while their medians sat a point apart, so a merged board put fifteen starting pitchers first and the best batter sixteenth. That is not a quality judgement, it is an artifact of averaging percentiles over five categories instead of seven - fewer categories, less averaging out, a higher top end. Any league with an uneven category split gets it. So each group's score is measured against the LAST PLAYER AT THAT GROUP THE LEAGUE STILL STARTS, and the board is ordered on the difference. It answers "how much better than the player I could have anyway", which is the question a pick actually asks, and it is comparable across groups because every group's replacement is defined the same way. Below replacement is negative, and shown, because it is real. A TWO-WAY PLAYER matches both groups and would otherwise appear twice, which is wrong on a board where a player can only be drafted once. The better value is kept - the role worth more is the reason to spend the pick.
export function buildBoard() {
    const sport = AppState.loadedSport;
    const pool = AppState.playerData || [];
    const byId = new Map();

    const starters = leagueStarters();
    const pointsLeague = !!AppState.isPointsLeague;
    const { estimated: estimateIds } = estimateSplit();
    const rateIds = AVERAGE_STATS[sport] || new Set();
    const estimateSet = new Set(estimateIds);
    // Every scored category gets a cell, in the league's own order, on every row - so the strips line up down the page and a column can be read as a column. A pitcher's batting cells sit dim, which is true of the row.
    const catIds = Array.from(AppState.scoredStatIds);
    // A category nobody is projected for is estimated INTO the line before the engine sees it, so Value ranks on the league's whole scoring rather than on the part ESPN happens to forecast. Still one engine call. A player the estimate cannot reach keeps the id absent, and the ids travel to the engine as "unknown when missing" so that gap is skipped instead of counting as a zero - which in an inverse category like errors would be the best figure on the board.
    const unknownWhenMissingIds = new Set(estimateIds);

    groupsFor(sport).forEach(wantPitchers => {
        const group = pool.filter(p => hasProjection(p) && matchesPlayerGroup(p, sport, wantPitchers));
        if (!group.length) return;
        const gamesId = gamesIdFor(sport, wantPitchers);
        // The engine reads seasonTotals, so the line is handed over under that name - the same objects otherwise, so names, positions and eligibility all survive for the table.
        const projected = group.map(p => ({
            ...p,
            seasonTotals: estimateUnprojected(p.projectedTotals, p.lastSeasonTotals, estimateIds,
                { gamesId, rateIds }).line
        }));
        const ranks = computeGroupRanks(projected, sport, wantPitchers, { unknownWhenMissingIds });
        const { scores } = ranks;
        const want = wantPitchers ? starters.secondary : starters.primary;

        // THE REPLACEMENT IS A PLAYER, NOT A LINE PER CATEGORY. The last starter the league still fields at this group, found by that overall score, and those OWN category percentiles are the baseline. Taking each category's Nth best separately would assemble a replacement nobody could draft - best-available in every category at once, which no real player is. A points league has no categories to add up, so it keeps the single-number subtraction.
        const orderedByScore = ranks.ranked || [];
        const replacementPlayer = orderedByScore.length
            ? orderedByScore[Math.min(Math.max(1, want || 1), orderedByScore.length) - 1]
            : null;
        const replacementPcts = !pointsLeague && replacementPlayer && ranks.byCategory
            ? ranks.byCategory.get(replacementPlayer.id) : null;
        const replacementScore = replacementLevel(Array.from(scores.values()), want);

        // PER-SEAT-GROUP REPLACEMENT, for the sports where it has been measured and approved. Empty for every other sport, and then everything below reads the single group's replacement exactly as before.
        const seatGroups = seatGroupsFor(sport, wantPitchers);
        const seatReplacements = seatGroups.length
            ? replacementByGroup(orderedByScore, seatGroups)
            : null;

        // WHICH CATEGORIES THIS GROUP ACTUALLY SCORES, derived rather than re-split: the replacement is a real member of the group, so the categories percentiled in are the group's.
        const groupCats = replacementPcts ? Array.from(replacementPcts.keys()) : [];


        projected.forEach(p => {
            const score = scores.get(p.id);
            if (score === undefined) return;
            const cats = !pointsLeague && ranks.byCategory ? ranks.byCategory.get(p.id) : null;
            // A player only belongs to a group with real figures in it. A batter sitting in the pitcher pool on eligibility alone reads as zeros in every pitching category, which would score that batter at the bottom of the pitchers and SUBTRACT value never lost.
            const carries = groupCats.some(id => {
                const v = p.seasonTotals[id];
                return v !== undefined && v !== null;
            });
            if (cats && !carries) return;
            // THE PROJECTED LINE ITSELF, which is the board's evidence and used to be shown nowhere. The percentile is the engine's own - the very number that made the Value - rather than a second one computed beside it, so a tinted cell and the figure it sits under are the same statement.
            const cells = catIds.map(id => {
                const raw = p.seasonTotals[id];
                const has = raw !== undefined && raw !== null;
                const pct = cats ? cats.get(id) : undefined;
                return {
                    id,
                    value: has ? Number(raw) : null,
                    pct: pct === undefined ? null : pct,
                    estimated: estimateSet.has(id)
                };
            });

            const held = byId.get(p.id) || { player: p, totals: p.seasonTotals, entries: [] };
            held.player = p;
            held.totals = p.seasonTotals;
            // The seat's own replacement when the sport has them, the group's when it does not. Both branches carry a PLAYER's percentile line, so sumOfEdges downstream cannot tell which branch produced it - the only thing that changes is which player it is.
            let entryPcts = replacementPcts, entryScore = replacementScore;
            if (seatReplacements) {
                const g = pricingGroupFor(p, seatGroups, seatReplacements, (r) => scores.get(r.id));
                const rep = g ? seatReplacements.get(g.name) : null;
                if (rep) {
                    entryScore = scores.get(rep.id);
                    entryPcts = !pointsLeague && ranks.byCategory ? ranks.byCategory.get(rep.id) : null;
                }
            }
            held.entries.push({
                wantPitchers, score, cells,
                percentiles: cats,
                replacement: entryPcts,
                replacementScore: entryScore
            });
            byId.set(p.id, held);
        });
    });

    // A PLAYER IS THE SUM OF THE GROUPS THEY PLAY IN. For almost everyone that is one group and this changes nothing. For a two-way player it is the whole point: the pitching edges were being discarded because the engine ranked them among batters, so a player winning four pitching categories was valued as though they never took the mound.
    byId.forEach(held => {
        const entries = held.entries;
        const edges = sumOfEdgesAcross(entries.map(e => ({ percentiles: e.percentiles, replacement: e.replacement })));
        // The single-number fallback, for a points league and for a league whose settings leave nobody starting: the best of the groups played in, rather than a sum of scores that are not on one scale.
        const fallback = entries.reduce((best, e) => {
            const v = e.replacementScore === null ? e.score : e.score - e.replacementScore;
            return best === null || v > best ? v : best;
        }, null);
        held.value = edges !== null && edges !== undefined ? edges : fallback;
        held.score = entries.reduce((best, e) => (best === null || e.score > best ? e.score : best), null);
        held.wantPitchers = entries.length === 1 ? entries[0].wantPitchers : null;
        // The row shows every group's cells: a category is drawn by whichever group scores it, so a two-way player's row carries a real percentile on both halves of that line.
        held.cells = catIds.map((id, i) => {
            const scored = entries.find(e => e.cells[i] && e.cells[i].pct !== null);
            const anyValue = entries.find(e => e.cells[i] && e.cells[i].value !== null);
            return (scored || anyValue || entries[0]).cells[i];
        });
        delete held.entries;
    });

    const rows = Array.from(byId.values()).sort(compareRows);
    rows.forEach((r, i) => { r.boardRank = i + 1; });

    // Everyone the projections cannot rank still belongs on a board of who is draftable - they sit after the ranked players, in the crowd's own order, saying plainly that there is no number.
    const unranked = pool
        .filter(p => !byId.has(p.id))
        .sort((a, b) => ((adpOf(a) || 9999) - (adpOf(b) || 9999)) || a.name.localeCompare(b.name))
        .map(p => ({ player: p, score: null, value: null, boardRank: null, cells: null }));

    return rows.concat(unranked);
}

// THE SEAT GROUPS A RANKING GROUP CONTAINS. leagueStarters below answers "how many does this league start", which is the right question when a group's members are interchangeable. They are not in hockey: a league fielding five defencemen a team has a 25th-best defenceman, and pricing against the 75th-best SKATER buried the position - 4 of 317 above replacement, the best of them 21st among skaters, first against that own seat. Each position slot becomes a group of its own; each FLEX slot becomes a group over the positions it accepts (FLEX_SLOT_POSITIONS, validated per sport). A slot whose flex positions have not been measured is skipped rather than guessed at - it would otherwise price players against a pool nobody has checked. SPORT BY SPORT, DELIBERATELY. Football's board is unchanged: its per-position work is the pre-draft SENTENCE (O12), not its value. BASEBALL JOINED AT O17, once its blocker turned out not to be one. It was held because a third of batters are multi-eligible and the assignment rule looked like it moved a baseline by a quarter of the spread between positions - a rule that decides the answer is not a baseline. That measurement was wrong: assignBodies walks its list ONCE and is order-dependent, and the probe had fed it unsorted. On the app's own best-first input the greedy is EXACT - identical to three decimals at every position against a best-first augmenting-path matching, with 607 of 639 players seated differently and no baseline moving, because a baseline reads only the top `jobs` of each position and the rules diverge only in the tail. The naive first-eligible rule is still unreliable, which is the half of that finding that stood. An empty answer here means "keep the single group", which is what football gets.
const PER_POSITION_VALUE_SPORTS = new Set(['fhl', 'flb']);

export function seatGroupsFor(sport, wantPitchers) {
    if (!PER_POSITION_VALUE_SPORTS.has(sport)) return [];
    const settings = AppState.apiData?.settings || {};
    const counts = settings.rosterSettings?.lineupSlotCounts || {};
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    if (!teams) return [];
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const flex = FLEX_SLOTS[sport] || new Set();
    const secondary = SECONDARY_LINEUP_SLOTS[sport] || new Set();
    const flexPositions = FLEX_SLOT_POSITIONS[sport] || {};
    const groups = [];
    Object.keys(counts).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        // SECONDARY_LINEUP_SLOTS is what says which ranking pool a seat belongs to - the same tag the flex positions are recorded against, and the reason a pitcher flex is never measured against batters.
        if (n <= 0 || bench.has(slot) || secondary.has(slot) !== !!wantPitchers) return;
        if (flex.has(slot)) {
            const accepts = flexPositions[slot];
            if (accepts && accepts.size) groups.push({ name: labels[slot] || `slot${slot}`, seats: n * teams, accepts });
            return;
        }
        if (labels[slot]) groups.push({ name: labels[slot], seats: n * teams, accepts: new Set([labels[slot]]) });
    });
    // One group is the single-baseline case wearing a different hat, so say so by answering none.
    return groups.length > 1 ? groups : [];
}

// TAKING THE PRESEASON SNAPSHOT. Orchestration only: the decisions are pure (preseason-snapshot.js) and the storage is api.js's, so what is left here is knowing which league is loaded - the part that was never pure. FIRE AND FORGET, from wherever the pool lands. It must not delay a render: nothing on screen waits for it, a failure leaves the feature absent rather than broken, and the answer it stores is read back weeks later, not now. The honest limit, repeated here because this is where someone will look for it: a snapshot exists only for a league opened during its preseason. A reader who installs in October has none for that season, ever, and no fetch can recover it - ESPN overwrites the line rather than archiving it.
export async function maybeTakePreseasonSnapshot() {
    const sport = AppState.loadedSport;
    const league = AppState.apiData;
    const pool = AppState.playerData;
    if (!sport || !league || !pool || !pool.length) return false;
    const leagueId = league.id, seasonId = league.seasonId;
    if (leagueId === undefined || leagueId === null || !seasonId) return false;

    const key = snapshotKey(sport, leagueId, seasonId);
    const existing = await readPreseasonSnapshot(key);
    if (!shouldTake(seasonState(league), existing)) return false;

    const snapshot = buildSnapshot(pool, Array.from(AppState.scoredStatIds || []), {
        takenAt: Date.now(),
        sport, leagueId, seasonId,
        scoringPeriodId: league.scoringPeriodId ?? null,
        // Recorded so the READER can refuse a snapshot that was not taken in a preseason state - see isPreseasonSnapshot. The write path already refuses to take one late; this is what protects against a stored one that a later build cannot un-write.
        state: seasonState(league)
    });
    // Nothing worth keeping - a league whose pool carries no projection yet. Not an error, and not recorded as an attempt: a later load can still succeed while the league is still preseason.
    if (!snapshot) return false;

    const stale = staleKeys(await preseasonSnapshotKeys(), sport, leagueId, seasonId);
    return writePreseasonSnapshot(key, snapshot, stale);
}

// The snapshot for the league on screen, or null.
export async function loadPreseasonSnapshot() {
    const sport = AppState.loadedSport, league = AppState.apiData;
    if (!sport || !league || league.id === undefined || !league.seasonId) return null;
    return readPreseasonSnapshot(snapshotKey(sport, league.id, league.seasonId));
}

// THE SNAPSHOT HELD FOR THE SURFACE THAT DRAWS IT. The drill-down renders synchronously and storage is async, so the body is fetched once per league and kept - the ensureProScheduleData pattern, and deliberately so, because that hook already solved this exact shape. KEY-CHECKED, and this is not defensive habit but O2's own lesson paid for once already: a store read without asking whose it is showed one league's data under another league's name and looked entirely plausible doing it. A snapshot from another league would be worse - it would print a preseason projection for a player who has one, from a season they were not in.
let preseasonSnap = { key: null, data: null };

function currentSnapshotKey() {
    const sport = AppState.loadedSport, league = AppState.apiData;
    if (!sport || !league || league.id === undefined || !league.seasonId) return null;
    return snapshotKey(sport, league.id, league.seasonId);
}

// The body for the league on screen, or null - null both when there is no snapshot and when the one held belongs to a different league, which the reader treats identically and should.
export function currentPreseasonSnapshot() {
    const key = currentSnapshotKey();
    return (key && preseasonSnap.key === key) ? preseasonSnap.data : null;
}

// Loads it once per league and redraws the open drill-down when it lands, because the surface that wants it has already rendered by then. A null answer is CACHED under the key too: most leagues have no snapshot and never will, and re-reading storage on every drill-down to be told so again is work for an answer that cannot change within a session.
export async function ensurePreseasonSnapshot() {
    const key = currentSnapshotKey();
    if (!key || preseasonSnap.key === key) return preseasonSnap.data;
    const data = await readPreseasonSnapshot(key);
    if (currentSnapshotKey() !== key) return null;   // a league switch overtook it
    preseasonSnap = { key, data };
    if (data && AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
    return data;
}

// How many of each group this league starts in total - per team from its own lineup settings, times the number of teams. This is the number replacement level is taken at, and the scarcity card reads the same helper, so the board and the card can never tell different stories.
export function leagueStarters() {
    const sport = AppState.loadedSport;
    const settings = AppState.apiData?.settings || {};
    const perTeam = startingSlotsByGroup(settings.rosterSettings?.lineupSlotCounts, {
        nonStarting: NON_STARTING_SLOTS[sport],
        secondary: SECONDARY_LINEUP_SLOTS[sport]
    });
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    return { primary: perTeam.primary * teams, secondary: perTeam.secondary * teams };
}

// Split by what can be done about it. A counting category is estimated from the player's own last season; a RATE cannot be - it does not scale by games - so it stays unavailable and is named as such rather than quietly dropped.
export function estimateSplit() {
    const rates = AVERAGE_STATS[AppState.loadedSport] || new Set();
    const ids = unprojectedCategoryIds();
    return {
        estimated: ids.filter(id => !rates.has(id)),
        unavailable: ids.filter(id => rates.has(id))
    };
}

// WHICH OF THE LEAGUE'S CATEGORIES THE PROJECTIONS CANNOT SPEAK TO. Computed, never listed: a category counts as unprojected when NO projected player in the pool carries it. Measured on the live baseball pool, that is exactly the two fielding categories - ESPN projects no fielding at all, so a league scoring assists and errors is drafting half blind and the sheet has to say so rather than quietly rank on what is left. A hockey league scoring something ESPN does not project gets the same treatment for free. Note the difference from a category that is merely SPARSE: saves sit on 111 of 1473 because only closers get them, which is the projection working, not failing.
export function unprojectedCategoryIds() {
    const projected = (AppState.playerData || []).filter(hasProjection);
    if (!projected.length) return [];
    const missing = [];
    // scoredStatIds is built from the league's own scoringItems in order, and a Set keeps its insertion order - so this comes out in the order the league lists its categories.
    AppState.scoredStatIds.forEach(id => {
        if (!projected.some(p => p.projectedTotals[id] !== undefined)) missing.push(id);
    });
    return missing;
}

// WHICH ROLE GROUPS THIS SPORT HAS, rather than an assumption that there are two. Baseball splits batters from pitchers and hockey skaters from goalies; a sport whose second group is empty - or which has never had one - is ranked as a single pool. Nothing here is allowed to assume the count, because the next sport may not have two.
function groupsFor(sport) {
    const secondary = SECONDARY_GROUP_POSITIONS[sport];
    return secondary && secondary.size ? [false, true] : [false];
}

// The games-played id for a group, which is what an estimate is scaled onto. A sport with no entry gets nothing rather than baseball's ids - the estimate then cannot be made, which is the honest outcome and the one estimateUnprojected already handles.
function gamesIdFor(sport, wantPitchers) {
    const ids = GAMES_PLAYED_IDS[sport];
    return ids ? ids[wantPitchers ? 'secondary' : 'primary'] : undefined;
}

// ==== Projections ====

// Read off the POOL THE PLAYER TAB ALREADY PROCESSED, not off the raw payload a second time. processPlayerData pulls the projection with the same predicate draft-engine's projectedLine uses - statSourceId 1, split 0, matched to the season's own year - and unwraps it into projectedTotals, so parsing it again here would be a second extraction of the same numbers with a second chance to disagree. projectedLine stays the reader for anything holding raw payload. An unprojected player unwraps to an empty object rather than to zeros, which is the distinction the sheet needs: unranked, not worthless. MEASURED on the live baseball pool: 1473 of 3000 pooled players resolve a projected line, which sounds thin and is not - coverage is 100% of everyone with a draft position inside 200, and the first player without one sits at ADP 239, past the end of a real draft. The hockey captures carry none at all, which is what the empty state is for.
export function hasProjection(player) {
    return !!player && Object.keys(player.projectedTotals || {}).length > 0;
}

export function adpOf(p) {
    const raw = Number(p.adp) > 0 ? Number(p.adp) : null;
    if (raw === null) return null;
    const filler = adpFiller();
    return filler !== null && raw === filler ? null : raw;
}

export function adpFiller() {
    const pool = AppState.playerData || [];
    if (adpFillerCache.ref !== pool) {
        adpFillerCache = {
            ref: pool,
            value: degenerateValue(pool.map(p => Number(p.adp)).filter(a => a > 0))
        };
    }
    return adpFillerCache.value;
}

// Best first, and every tie broken the same way everywhere on this face: a real tie in value goes to whoever the crowd takes first, then to the name so the order never wobbles between renders.
function compareRows(a, b) {
    return (b.value - a.value)
        || ((adpOf(a.player) || 9999) - (adpOf(b.player) || 9999))
        || a.player.name.localeCompare(b.player.name);
}
