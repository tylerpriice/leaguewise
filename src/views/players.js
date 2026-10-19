/**
 * The Player Metrics tab and the shared player data layer. It loads the player pool and the weekly
 * harvest, windows the pool to the selected timeframe, ranks it through the pure engines, and
 * renders the leaderboard, the drill-down, the player comparison and the projected draft board. The
 * roto race series and the matchup day race are built here too, because they read the same caches.
 *
 * This is the impure half. It reads application state and the DOM and makes requests, while the
 * ranking, pacing, schedule and odds math stays in the engine modules it imports.
 * @module players
 */
import { buildPlayerAvatarHtml, wirePlayerAvatars, initialsFor, buildProTeamLogoHtml, buildProTeamCrestHtml, buildTeamCrestHtml, proTeamLogoUrl, isAllowedLogoUrl } from './images.js';
import { sampleLogoColour, darkenUntilContrast, parseCssColour, toCssRgb, relativeLuminance, contrastRatio, pickCrestGround } from './logo-colour.js';
import { buildLeaderboardRowHtml, buildLeaderboardHeaderHtml, nextGameCell, gameDayTime, pinnedColumnWidth, comparePalette } from './leaderboard-row.js';
import { buildPlayerRailHtml } from './player-rail.js';
import { AppState, ESPN_STAT_MAPS, POSITION_MAPS, SLOT_POSITION_MAPS, SECONDARY_GROUP_POSITIONS, PITCHING_IDS, GOALIE_IDS, AVERAGE_STATS, CLUB_EDGE_STAT_IDS, leagueInverseIds, RATE_COMPONENTS, NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_LABELS, FLEX_SLOTS, FLEX_SLOT_POSITIONS, categoriesMapped, STAT_DISPLAY_ORDER } from '../data/state.js';
import { playoffMatchups, densityAcrossMatchups, playoffOutlook, matchupWindow, gamesByProTeamForMatchup, offNightsForMatchup, rosterNightCoverage, openSeatNights, nextGameOf } from '../engines/schedule-insight.js';
// The single count of how much season a player has left, shared with the coverage band so both price a remainder on the same rule.
import { expectedAppearances } from '../engines/projected-basis.js';
import { windowProjectedLine, windowLineRanks } from '../engines/rank-engine.js';
import { sparklineSvg } from './sparkline.js';
import { foldClubGames, clubTable, gameEdges } from '../engines/club-edge.js';
import { percentileOf } from '../engines/matchup-difficulty.js';
import { leagueMargins, computeMatchupRanks } from '../engines/matchup-rank.js';
import { MIN_MATCHUPS_FOR_A_LINE, escapeHtml, getNiceMax, setDebugContext, setActiveDebugKind, hasDebugContext, debugContextFor, setDebugLoading, getTimeframeBounds, splitScoredAdvanced, percentileVar, attachDataTooltips, statValue, unwrapStats, axisUnit, buildMatchupPeriodMap, scheduledPeriodsOfMatchup, matchupOfPeriod, weekOfPeriod, midPeriodOfWeek, parseTimeframe, injuryBadgeHtml, injuryLabel, playerPoolErrorText, openingSortDir, wirePushPanel, unmappedCategoriesNote, roleIdSetFor, buildLoadingHtml, resolveMyTeamId, draftedPickParts , draftedPickTeamId, revealDraftPick } from './utils.js';
import { leagueKeyOf, fetchPlayerData, fetchPlayerWeeklyStats, fetchPlayersWeeklyChunk, WEEKLY_CHUNK_SIZE, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchDraftDetail, harvestTransactions, harvestRosters, harvestRosterPeriods, countedCapture, fetchProTeamSchedules, currentProSchedule, proScheduleAttempted, finalScoringPeriodOf, readPreseasonSnapshot, preseasonSnapshotKeys, writePreseasonSnapshot } from '../data/api.js';
import { buildRosterTimeline, teamForPlayerAtPeriod, buildStartedTimeline, startedTeamForPlayerAtPeriod, dayBucketScope, startedDaySums, needsEveryDay, buildStartedSeats, creditedStats } from '../engines/roster-timeline.js';
import { seasonState, isPreseason, seasonIsFinished, SEASON_STATE, draftTabShowsResults } from '../data/season-state.js';
// One pure helper, for the reason it exists: ESPN collapses a whole column to a filler value out of season, and the leaderboard's rostered share needs the same test the draft board's ADP does.
import { degenerateValue, startingSlotsByGroup, replacementLevel, estimateUnprojected, sumOfEdgesAcross, replacementByGroup, replacementScoreOf, replacementWindowFor, pricingGroupFor } from '../engines/draft-engine.js';
import { datesByScoringPeriod, buildProTeamAbbrevs, dayLabelerFor, buildGamePeriodIndex, countProjectedStarts } from '../engines/probables.js';
import { snapshotKey, staleKeys, shouldTake, buildSnapshot, preseasonLineFor, isPreseasonSnapshot } from '../data/preseason-snapshot.js';
// Season history for the drill-down. The call is guarded where it is used and draws nothing until that data exists.
import { buildSeasonsBandHtml } from './seasons-band.js';
import { projectionPacing } from '../engines/projection-pacing.js';
// Supplies the categories-league rank, total, tie and games for a pick, re-ranked with competition ranks so a tie shares one place.
import { seasonRowFrom } from '../engines/retro-basis.js';
// All ranking/percentile MATH lives in the pure, unit-tested rank engine (see its purity contract; tests in tests/rank-engine.test.html). This file owns the impure half. Choosing pools, reading AppState/DOM, and building the ctx objects the engine functions take.
import {
    IP_STAT_ID, GAMES_PLAYED_IDS, MIN_PLAYING_TIME_FRACTION,
    inningsPitchedOf,
    computeRotoRanks as engineComputeRotoRanks,
    computePointsRanks as engineComputePointsRanks,
    computeCategoryBreakdown as engineComputeCategoryBreakdown,
    computeStatRankInPool, buildCategoryRateBasis, buildWeeklyValueBasis, scoreWeekAgainstBasis,
    scoreRotoWeek, rotoPointsForCategory, comparePlayerCategories, scoreWeekByCategory,
    perDayAverages, scoreDayAgainstSelf, dayVerdict, typicalDayScore, presentDayScore,
    comparePlayerGroup, PLAYER_GROUP_MAX_OTHERS, groupMatchupSeries
} from '../engines/rank-engine.js';

const RANK_COLORS = { 1: '#b8860b', 2: '#767676', 3: '#a4581e' }; // gold, silver, bronze
const RANK_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' }; // leaderboard Rank column, top 3 of the current pool

// The reason codes the matchup-rank module returns, worded for this surface.
const MATCHUP_RANK_REASON_TEXT = {
    'too-few-matchups': 'Matchup rank needs 4 decided matchups.'
};
const WEEKLY_RANK_STAT_ID = '__weeklyrank__';
// Not an ESPN stat id and not a stored number. ESPN publishes the applied total for the season only, so a per-matchup figure is computed from that matchup's own stat line.
const WEEKLY_POINTS_STAT_ID = '__weeklypoints__';

// Applies the league's scoring to one bucket of weekly sums. The weights are the player's own, because a scoring id can be worth one thing to a person and another to a team defence. Using the same table as the rank keeps the chart and the rank in agreement.
function pointsForStatBucket(sums, player, sport) {
    const weights = pointsWeightsFor(sport, matchesPlayerGroup(player, sport, true));
    let total = 0;
    Object.keys(weights).forEach(id => { total += (Number((sums || {})[id]) || 0) * weights[id]; });
    return +total.toFixed(1);
}

// Ranks a player against everyone eligible in the stat's own role who has a value for it. The role comes from the stat, not the player's primary position, so a two-way player is compared against pitchers on pitching stats and batters on batting stats.
function computeStatRank(player, sport, statId) {
    const pitchingIds = roleIdSetFor(sport);
    const isPitcherStat = pitchingIds.has(statId);
    const pool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitcherStat) && p.seasonTotals[statId] !== undefined);
    const inverse = leagueInverseIds(sport).has(statId);
    return computeStatRankInPool(pool, player.id, statId, inverse);
}

const GROUP_LABELS = {
    flb: { primary: 'Batters', secondary: 'Pitchers' },
    fhl: { primary: 'Skaters', secondary: 'Goalies' },
    // Football's split is people against team defences, so the primary side needs a word that covers a quarterback and a kicker at once.
    ffl: { primary: 'Players', secondary: 'D/ST' }
};

// Role words for a sport this table has not listed. No baseball default: a new sport would otherwise show batters and a pitchers tab. The singular forms serve sentences, since a plural cannot be trimmed safely.
const GROUP_ROLE_WORDS = {
    flb: { primary: 'Batter', secondary: 'Pitcher' },
    fhl: { primary: 'Skater', secondary: 'Goalie' },
    ffl: { primary: 'Player', secondary: 'D/ST' }
};

// The page's scroll position when the drill-down opened, so Back can return to the row the reader left.
let leaderboardScrollTop = null;

// Identity column width per sport, in pixels. Baseball keeps the stylesheet default, which fits its longest names. The narrower sports were measured against their longest name plus the fixed avatar, logo and chip overhead.
const LB_IDENTITY_W = { fhl: 184, ffl: 184 };

// Replaces a first-name line that is too wide for its column with its initial and leaves the surname alone. It runs after each leaderboard render because only the browser's own layout can say whether a name fits.
function fitLeaderboardNames(container) {
    container.querySelectorAll('.lb-name-first').forEach(el => {
        if (el.scrollWidth > el.clientWidth) {
            const full = el.dataset.full || el.textContent;
            el.textContent = full.charAt(0) + '.';
        }
    });
}

/**
 * Draws and refreshes the phone header bar above the Player Metrics list: one pill naming the group and
 * the club, a search button and a filters button carrying a count. The pill, the search button and the
 * filters button each open the existing controls as a sheet below the bar, so no control is duplicated
 * and every handler stays where it was. The stylesheet hides the bar above 700px.
 *
 * @returns {void}
 */
function renderPhoneBar() {
    const view = document.getElementById('view-player');
    const toolbar = document.getElementById('player-toolbar');
    if (!view || !toolbar) return;
    let bar = document.getElementById('pm-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'pm-bar';
        bar.className = 'pm-bar';
        // One pill: the group and the club, a filter glyph and the count of filters off their defaults; one tap opens the one sheet.
        bar.innerHTML = `<button type="button" class="pm-pick" data-sheet="filters" aria-haspopup="true" aria-label="Filters"><span class="pm-pick-text"></span><span class="pm-pick-glyph" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h14M6 10h8M9 15h2"/></svg><b class="pm-count"></b></span></button>`;
        view.insertBefore(bar, toolbar);
        const SHEETS = ['pick', 'search', 'filters'];
        const closeSheets = () => SHEETS.forEach(n => view.classList.remove('pm-open-' + n));
        bar.querySelectorAll('[data-sheet]').forEach(btn => btn.addEventListener('click', () => {
            const name = btn.dataset.sheet;
            const wasOpen = view.classList.contains('pm-open-' + name);
            closeSheets();
            if (!wasOpen) {
                view.classList.add('pm-open-' + name);
            }
            bar.querySelectorAll('[data-sheet]').forEach(b => b.setAttribute('aria-expanded', view.classList.contains('pm-open-' + b.dataset.sheet) ? 'true' : 'false'));
            fitPhoneGrid();
            // A tall sheet stops under the bar that opens it, so the bar's own control is never covered.
            const room = window.innerHeight - 64 - Math.max(0, bar.getBoundingClientRect().bottom) - 8;
            view.style.setProperty('--pm-sheet-max', Math.max(200, Math.floor(room)) + 'px');
        }));
        // A pick in the group or club sheet is a decision, so the sheet closes behind it.
        const pickClose = (e) => { if (e.target.closest('.group-toggle-btn, .lb-rail-chip, .lb-rail-fteam, .lb-rail-crest')) closeSheets(); };
        const groupEl = document.getElementById('player-group-toggle');
        if (groupEl) groupEl.addEventListener('click', pickClose);
        const rail = document.getElementById('player-breakout-slot');
        if (rail) rail.addEventListener('click', pickClose);
    }
    arrangePhoneToolbar();
    const sport = AppState.loadedSport;
    const group = roleGroupsFor(sport).length > 1 ? groupLabel(sport, AppState.playerGroup === 'secondary') : null;
    const active = document.querySelector('#player-breakout-slot .lb-rail-fteam.active, #player-breakout-slot .lb-rail-crest.active');
    const clubName = active ? (active.getAttribute('title') || '').trim() : '';
    const label = bar.querySelector('.pm-pick-text');
    if (label) label.innerHTML = `<b>${escapeHtml(group || 'Players')}</b> <small>${escapeHtml(clubName || 'All')}</small>`;
    // The count is the filters that differ from their defaults, read from the same state the controls draw.
    const lens = document.querySelector('#lens-toggle-slot input[type="checkbox"]');
    const count = (AppState.playerAvailabilityFilter && AppState.playerAvailabilityFilter !== 'all' ? 1 : 0)
        + (AppState.playerPositionFilter && AppState.playerPositionFilter !== 'ALL' ? 1 : 0)
        + (AppState.requireMinPlayingTime === false ? 1 : 0)
        + (AppState.showAdvancedStats ? 1 : 0)
        + (lens && lens.checked ? 1 : 0);
    const badge = bar.querySelector('.pm-count');
    if (badge) { badge.textContent = count ? String(count) : ''; badge.style.display = count ? '' : 'none'; }
    const searchBtn = bar.querySelector('.pm-search');
    if (searchBtn) searchBtn.classList.toggle('pm-has', !!(AppState.playerSearchQuery || '').trim());
}
// The club and team rail joins the filter controls as one sheet under 700px and goes back where it was above it.
function arrangePhoneToolbar() {
    const toolbar = document.getElementById('player-toolbar');
    const slot = document.getElementById('player-breakout-slot');
    if (!toolbar || !slot) return;
    const phone = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    if (phone && slot.parentElement !== toolbar) toolbar.appendChild(slot);
    else if (!phone && slot.parentElement === toolbar) toolbar.after(slot);
}
window.matchMedia && window.matchMedia('(max-width: 700px)').addEventListener('change', () => {
    try { arrangePhoneToolbar(); fitPhoneGrid(); } catch (e) { /* the tab is not on screen */ }
});

/**
 * Sizes the phone grid of a category league: the pinned identity column to the longest name part on screen, and the
 * list's scroller to the room left under it, so the header and the pinned column stay put while the categories
 * slide. Does nothing above 700px or for a points league, and clears what it set there.
 *
 * @returns {void}
 */
let pointsPhoneView = 'points';

/**
 * Whether a points league's phone list is drawn as the stat grid: the Stats segment is chosen and the screen is a phone.
 *
 * @returns {boolean} True when the rows are the condensed stat grid.
 */
function pointsStatsViewOn() {
    return !!AppState.isPointsLeague && pointsPhoneView === 'stats'
        && !!(window.matchMedia && window.matchMedia('(max-width: 700px)').matches);
}

function fitPhoneGrid() {
    const viewport = document.getElementById('player-leaderboard-container');
    if (!viewport) return;
    const table = viewport.querySelector('.lb-table-grid');
    const phone = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    if (!table || !phone) {
        if (table) table.style.removeProperty('--lb-pin-w');
        viewport.style.removeProperty('height');
        return;
    }
    const widths = [...table.querySelectorAll('.lb-name-first, .lb-name-last')].map(e => e.scrollWidth);
    table.style.setProperty('--lb-pin-w', pinnedColumnWidth(widths, { photo: 36, gap: 8, pad: 13, min: 94, max: 141 }) + 'px');
    const top = viewport.getBoundingClientRect().top;
    const bar = document.querySelector('.px-bottom');
    const barH = bar && bar.offsetHeight ? bar.offsetHeight : 0;
    viewport.style.height = Math.max(260, Math.floor(window.innerHeight - top - 8 - barH)) + 'px';
}
window.addEventListener('resize', () => { try { fitPhoneGrid(); } catch (e) { /* the list is not on screen */ } });

function groupRoleWord(sport, secondary) {
    const words = GROUP_ROLE_WORDS[sport];
    return words ? words[secondary ? 'secondary' : 'primary'] : null;
}

/**
 * Qualifies "Overall" with the role being viewed, but only for a player who counts in both groups.
 * @param {string} poolKey The pool's label, such as "Overall" or a position.
 * @param {string|null} roleWord The singular role word of the group on screen, or null when the
 *   player has one role.
 * @returns {string} "Overall (as <role>)" for the overall pool with a role word, otherwise the pool
 *   key unchanged.
 */
export function rankPoolLabel(poolKey, roleWord) {
    if (poolKey !== 'Overall' || !roleWord) return poolKey;
    return `Overall (as ${roleWord})`;
}

const NEUTRAL_GROUP_LABELS = { primary: 'Players', secondary: null };
function groupLabels(sport) { return GROUP_LABELS[sport] || NEUTRAL_GROUP_LABELS; }
/**
 * Names a role group in a sport, falling back to a neutral word for a sport with no entry.
 * @param {string} sport The sport key ("flb", "fhl" or "ffl").
 * @param {boolean} secondary True for the second group, false for the first.
 * @returns {string} The tab label for that group.
 */
export function groupLabel(sport, secondary) {
    return groupLabels(sport)[secondary ? 'secondary' : 'primary'] || NEUTRAL_GROUP_LABELS.primary;
}

/**
 * Lists the role groups a sport has, so a one-group sport never shows an empty second tab.
 * @param {string} sport The sport key.
 * @returns {string[]} ["primary", "secondary"] when the sport has a second pool, otherwise
 *   ["primary"].
 */
export function roleGroupsFor(sport) {
    const secondary = SECONDARY_GROUP_POSITIONS[sport];
    return secondary && secondary.size ? ['primary', 'secondary'] : ['primary'];
}

// The group actually shown, clamped to one this sport HAS. A league switch from baseball to a one-group sport used to leave 'secondary' selected over an empty pool.
function activeGroupFor(sport) {
    const groups = roleGroupsFor(sport);
    return groups.includes(AppState.playerGroup) ? AppState.playerGroup : groups[0];
}

/**
 * Says whether the Player tab is showing the secondary group, clamped to a group the sport has.
 * Every other function takes the group as an argument; this is the one place that reads tab state.
 * @param {string} sport The sport key.
 * @returns {boolean} True when the secondary group is the one on screen.
 */
export function currentGroupIsSecondary(sport) { return activeGroupFor(sport) === 'secondary'; }

/**
 * Reports which role groups a player belongs to by eligibility, so a two-way player lands in both
 * and the caller decides where to draw the row.
 * @param {Object} player A processed player carrying `eligiblePositions`.
 * @param {string} sport The sport key.
 * @returns {{primary: boolean, secondary: boolean}} Membership in each group.
 */
export function playerRoleGroups(player, sport) {
    return {
        primary: matchesPlayerGroup(player, sport, false),
        secondary: matchesPlayerGroup(player, sport, true)
    };
}

/**
 * Says whether a player belongs to a role group by eligibility, so a two-way player matches both
 * groups. This is separate from the primary position, which still drives the strict reliever
 * filter.
 * @param {Object} player A processed player carrying `eligiblePositions`.
 * @param {string} sport The sport key.
 * @param {boolean} wantPitchers True for the secondary group, false for the primary.
 * @returns {boolean} True when any eligible position falls in the group.
 */
export function matchesPlayerGroup(player, sport, wantPitchers) {
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    return wantPitchers
        ? player.eligiblePositions.some(pos => pitcherPositions.has(pos))
        : player.eligiblePositions.some(pos => !pitcherPositions.has(pos));
}

// Matches a position filter. RP matches the player's primary role, because a swingman piles up starter-shaped counting stats that would otherwise rank ahead of true relievers. SP uses plain eligibility, since eligibility already requires real starts.
function matchesPositionFilter(p, posFilter) {
    if (posFilter === 'RP') return p.positionName === posFilter;
    return p.eligiblePositions.includes(posFilter);
}

// A display-only availability filter. It decides which rows show and never which players a rank is computed against, so a free agent's rank still reflects the whole same-role pool.
function matchesAvailability(p) {
    const mode = AppState.playerAvailabilityFilter || 'all';
    if (mode === 'rostered') return p.teamId != null;
    if (mode === 'fa') return p.teamId == null;
    return true;
}

// A display-only team filter, under the same rule as the availability filter, so narrowing to one team never shrinks a rank's pool.
function matchesBreakout(p) {
    const b = AppState.playerBreakoutFilter;
    if (!b || b.kind === 'all' || b.id == null) return true;
    if (b.kind === 'fantasy') return p.teamId === b.id;
    if (b.kind === 'pro') return Number(p.proTeamId) === b.id;
    return true;
}

// Outfield is the one position represented at two granularities in the slot catalogue, a generic slot and specific left, centre and right slots. Which to show depends on which the league rosters. Every other slot is shown whenever the player is eligible, whether or not the league has a seat for it.
const OF_SPECIFIC_SLOTS = new Set(["8", "9", "10"]);
const OF_GENERIC_SLOT = "5";
// The generic "P" slot (13) is redundant whenever a player also has the more specific SP (14) or RP (15), since any SP or RP is automatically P-eligible too, so showing "P/SP" adds nothing. Only fall back to generic "P" for the rare player with no SP/RP split at all.
const GENERIC_PITCHER_SLOT = "13";
const SPECIFIC_PITCHER_SLOTS = new Set(["14", "15"]);

// What a seat counts as, in the (slot, stat id) form roster-timeline credits by. Baseball credits pitching ids in a pitcher's seat and everything else elsewhere, which matches how ESPN credits a two-way player. Hockey and football need no rule.
function seatRuleFor(sport) {
    if (sport !== 'flb') return null;
    const isPitcherSeat = (slot) => String(slot) === GENERIC_PITCHER_SLOT || SPECIFIC_PITCHER_SLOTS.has(String(slot));
    return (slot, id) => isPitcherSeat(slot) === PITCHING_IDS.has(String(id));
}

// Canonical display order for positions. Unrecognised names sort last. The hockey wings are listed so the same pairing always reads the same way instead of following the payload's array order.
const POSITION_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "DH", "P", "SP", "RP",
    "LW", "RW", "D", "G"];

/**
 * Turns a player's eligible slot ids into position names in the canonical display order. A generic
 * outfield slot shows only when the league has no specific outfield slots, and the generic pitcher
 * slot only when the player has no specific starter or reliever slot.
 * @param {number[]|string[]} eligibleSlots The player's eligible slot ids.
 * @param {Object<string, string>} slotMap Slot id to position name for the sport.
 * @returns {string[]} The position names, sorted by display order.
 */
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

// Dedupes stat names within an already role-filtered list, so a batting id never shadows a pitching one. When a name collides and the league's scored ids are known, the scored id wins over its unscored twin.
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

// Reorders a sport's fixed families of ids into their display order in place. A family sits where its lowest-numbered member already sorted, so unrelated categories do not move.
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

/**
 * Lists the stat ids a role group shows, split into the ones the league scores and the rest, so a
 * board's columns match the leaderboard's.
 * @param {string} sport The sport key.
 * @param {string} group "primary" or "secondary".
 * @param {Object[]} groupPlayers The players of that group, used to drop ids nobody has a value
 *   for.
 * @returns {{scored: string[], advanced: string[]}} The scored ids and the remaining advanced ids,
 *   in display order.
 */
export function statIdsForGroup(sport, group, groupPlayers) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = roleIdSetFor(sport);
    const inGroup = Object.keys(statMap).filter(id => group === 'secondary' ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = applyFixedOrder(preferScoredDedup(inGroup, statMap), sport);
    const withData = deduped.filter(id => groupPlayers.some(p => p.seasonTotals[id] !== undefined));
    return splitScoredAdvanced(withData);
}

// Real baseball fractional-innings notation:.1 is one out into the inning (1/3) and.2 is two outs (2/3), not a true decimal (586 outs is "195.1", not "195.333").
function formatInnings(outs) {
    if (outs === undefined || outs === null) return '-';
    return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Reads the games a player has played for the group being viewed, defaulting to the active tab's group. The draft board ranks both groups in one pass, so it passes the group explicitly. A sport with no games id returns null, which is different from zero games.
function gamesPlayedOf(p, sport, wantPitchers) {
    const ids = GAMES_PLAYED_IDS[sport];
    if (!ids) return null;
    return p.seasonTotals[ids[wantPitchers ? 'secondary' : 'primary']] || 0;
}

// Whether workload can be measured in this sport at all. A rank built without it is not a rougher rank, it is an unshrunk one with no playing-time floor, so a surface asks this and says it has no ranking rather than showing one nobody can defend.
function gamesPlayedKnown(sport) { return !!GAMES_PLAYED_IDS[sport]; }

// The workload measure used for shrinkage. Baseball uses games for batters and innings pitched for pitchers, because appearance counts cannot be compared across pitching roles. Hockey uses games played for every player.
function workloadOf(p, sport, wantPitchers) {
    if (sport === 'fhl') return gamesPlayedOf(p, sport, wantPitchers);
    return wantPitchers ? inningsPitchedOf(p) : gamesPlayedOf(p, sport, wantPitchers);
}

// Adapts the app's state to the engine's roto context. Stat ids are scoped to the group on screen so a two-way player's off-role stats cannot hand them a lone-player percentile. The two workload measures are deliberate. The options let a caller other than the leaderboard name the group.
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
        inverseStatIds: leagueInverseIds(sport),
        // The averaged categories, so the engine can tell a real zero from an absent value. A missing value means unknown for these ids and for estimated categories, because a zero in an inverse category would be the best score.
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

// Finds the denominator ids of a rate category from the rate-component table. A numerator and denominator entry answers directly. A sum entry uses its first addend that carries a denominator.
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

// Adapts the leaderboard's state to the matchup-rank module, reading its scored ids from the roto context so the two never disagree.
function matchupRankCtxFor(groupPlayers, sport, wantPitchers) {
    const roto = rotoContext(groupPlayers, sport, null, { wantPitchers });
    return {
        categoryIds: roto.relevantStatIds,
        rateStatIds: roto.rateStatIds,
        inverseStatIds: roto.inverseStatIds,
        weightIdsFor: (id) => rateWeightIdsFor(sport, id)
    };
}

// Replaces ESPN's raw "FPTS" (a generic points formula unrelated to this league's scoring settings, and batting-only) with a real roto-style rank. All method and math lives on the engine's computeRotoRanks, including the rationale for shrinkage, opportunity gating, the Minimum Games threshold and the RP pool's special cases.
function computeRotoRanks(groupPlayers, sport, posFilter, wantPitchers, opts = {}) {
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, posFilter, {
        wantPitchers,
        // Carried so the leaderboard can say the same thing the board says about a category ESPN does not forecast (see preseasonBasisOf): skip it, never score it as a zero.
        unknownWhenMissingIds: opts.unknownWhenMissingIds
    }));
}

// The points-league ranking, called the same way as the roto one. It ranks exactly the pool it is given, so a position rank is a rank among that position. Weights come from the group's own slots, because a league can score the same stat differently by slot and team defences are scored entirely that way.
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

// Ranks by whichever scoring the league uses. The pitcher flag is required with no default, since a silent default reads pitchers by the batting games id and drops almost all of them. In preseason a points total leaves out the app's own estimates.
function computeLeagueRanks(groupPlayers, sport, posFilter, wantPitchers, opts = {}) {
    if (!AppState.isPointsLeague) return computeRotoRanks(groupPlayers, sport, posFilter, wantPitchers, opts);
    const estimated = opts.unknownWhenMissingIds;
    const scoredPool = estimated && estimated.size
        ? groupPlayers.map(p => {
            const line = { ...(p.seasonTotals || {}) };
            estimated.forEach(id => { delete line[id]; });
            return { ...p, seasonTotals: line };
        })
        : groupPlayers;
    return computePointsRanks(scoredPool, sport, wantPitchers);
}

/**
 * Rebases the leaderboard pool on projections before a game is played, so it ranks the same lines
 * as the draft board. A category ESPN does not forecast is estimated from last season, and ids that
 * cannot be reached are skipped instead of read as zero. A player with no projection keeps the row
 * and loses the numbers.
 * @param {Object[]} pool The processed player pool.
 * @param {Object} [ctx] Basis context.
 * @param {boolean} [ctx.preseason] True when nobody has played; otherwise the pool is returned
 *   unchanged.
 * @param {string[]} [ctx.estimateIds] Stat ids to estimate where ESPN has no projection.
 * @param {Set<string>} [ctx.rateIds] Averaged stat ids.
 * @param {string|null} [ctx.gamesId] The games-played stat id for the group.
 * @returns {Object[]} The pool, with each `seasonTotals` replaced by the projected line, or an
 *   empty line for an unprojected player.
 */
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

/**
 * Ranks one group for the draft board with the same engine and context builder as the leaderboard,
 * so a draft value and a season rank come from one place. The group is passed in, and the
 * minimum-games exclusion is off because a draft board asks who to pick, not who has played enough.
 * @param {Object[]} groupPlayers The players to rank.
 * @param {string} sport The sport key.
 * @param {boolean} wantPitchers True to rank by the secondary group's role.
 * @param {Object} [opts] Options.
 * @param {Set<string>} [opts.unknownWhenMissingIds] Ids whose missing values read as unknown, not
 *   zero.
 * @returns {Object} The engine's ranks, with per-category percentiles added for a points league.
 */
export function computeGroupRanks(groupPlayers, sport, wantPitchers, opts = {}) {
    if (AppState.isPointsLeague) {
        const pointsRanks = engineComputePointsRanks(groupPlayers, {
            weights: AppState.scoringWeights,
            workloadOf: p => gamesPlayedOf(p, sport, wantPitchers)
        });
        // A points ranking has one sum and no per-category percentile, so a roto-style pass supplies the percentiles for cell tinting and its rank is discarded. A stat's percentile in the pool does not depend on how a league sums it.
        const categoryTintRanks = engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, null, {
            wantPitchers,
            requireMinPlayingTime: false,
            unknownWhenMissingIds: opts.unknownWhenMissingIds
        }));
        return { ...pointsRanks, byCategory: categoryTintRanks.byCategory };
    }
    return engineComputeRotoRanks(groupPlayers, rotoContext(groupPlayers, sport, null, {
        wantPitchers,
        requireMinPlayingTime: false,
        unknownWhenMissingIds: opts.unknownWhenMissingIds
    }));
}

// Single-player per-category breakdown of the same math, for the drill-down. See the engine's computeCategoryBreakdown.
function computeCategoryBreakdown(player, groupPlayers, sport, posFilter, wantPitchers) {
    return engineComputeCategoryBreakdown(player, groupPlayers, rotoContext(groupPlayers, sport, posFilter, { wantPitchers }));
}

/**
 * Formats a stat for a table. A fractional value gets three decimals and an integer prints bare. A
 * caller that knows the stat is a counting stat passes false, which rounds away the noise a
 * projected counting stat carries.
 * @param {number|string|null|undefined} val The value.
 * @param {boolean|null} [isRate] True or false when the caller knows the stat's kind; null to infer
 *   from the value.
 * @returns {string|number} The formatted value, or a dash when the value is missing or not finite.
 */
export function formatStatValue(val, isRate = null) {
    if (val === undefined || val === null) return '-';
    const num = Number(val);
    if (!Number.isFinite(num)) return '-';
    if (isRate === false) return Math.round(num);
    return (num % 1 !== 0) ? num.toFixed(3) : num;
}

// Gives the rank breakdown enough precision to tell apart values the grid rounds together. Rates below one get a fourth decimal; the rest already separate at three. It keys off magnitude, so it needs no list of rate ids.
function formatBreakdownValue(val) {
    const num = Number(val);
    if (Number.isFinite(num) && num % 1 !== 0 && Math.abs(num) < 1) return num.toFixed(4);
    return formatStatValue(val);
}

// Labels the chart's x-axis by matchup number, which is what a manager thinks in. Weeks past the league's bracket keep a plain continuing number, and a divider elsewhere marks the end of the league season.
function formatMatchupLabel(w) {
    // The chart's buckets are the league's own timeline unit, matchups in head-to-head and weeks in roto, so the tick follows the league's word.
    return `${axisUnit().short}${w}`;
}

// The season of the league on screen, read from the league and not from the settings form. The form's year is only what the reader has chosen, so reading it let a harvest chunk filter lines against a season the page was not showing. NaN when no league is loaded, which matches no line.
function loadedSeason() {
    const season = Number(AppState.apiData?.seasonId);
    return Number.isFinite(season) && season > 0 ? season : NaN;
}

function processPlayerData(rawData, sport) {
    const rawPlayers = rawData.players || [];
    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });
    const year = loadedSeason();

    // Maps each rostered player to the team that holds them, built only in the window after a draft ends and before ESPN's own record catches up. The pool still reads no team for a drafted player then, so the rosters are the only witness. It is read from the payload and written nowhere.
    let rosterOwner = null;
    if (AppState.apiData?.draftDetail?.drafted !== true && draftTabShowsResults(AppState.apiData)) {
        rosterOwner = new Map();
        (AppState.apiData?.teams || []).forEach(t => {
            ((t && t.roster && t.roster.entries) || []).forEach(e => {
                const id = e.playerId ?? e.playerPoolEntry?.id;
                if (id !== undefined && id !== null && Number(id) > 0) rosterOwner.set(String(id), t.id);
            });
        });
    }

    return rawPlayers.map(entry => {
        const p = entry.player || {};
        const statLines = p.stats || [];

        // Match exact year to prevent historical leakage
        const actualSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year);
        const projSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 1 && s.seasonId === year);
        // Last season's actuals from the same payload. The draft board reads them to estimate categories ESPN does not project. It costs no request.
        const priorSeason = statLines.find(s => s.statSplitTypeId === 0 && s.statSourceId === 0 && s.seasonId === year - 1);

        const teamId = entry.onTeamId > 0
            ? entry.onTeamId
            : (rosterOwner && rosterOwner.get(String(p.id ?? entry.id))) || null;
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
            // ESPN's average draft position, from the same payload. A value of 0 means ESPN has no position for the player, so it reads as absent.
            adp: Number(p.ownership && p.ownership.averageDraftPosition) || null,
            // Same ownership block ADP reads above, no separate request. percentOwned is ESPN's rostered share as of the payload's own snapshot; percentChange is its own 7-day delta, already computed server-side, so nothing here derives it from history.
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

// Anchors roto's weekly axis. Stats arrive per game day, and a roto league has no matchup boundaries, so weeks are seven days counted from the league's first scoring period. This is a display axis and is labelled as weeks, never matchups.
function weekOfScoringPeriod(scoringPeriodId) {
    return weekOfPeriod(scoringPeriodId, AppState.apiData?.status?.firstScoringPeriod || 1);
}

// Collapses the real weeks of one playoff round into that round's single matchup number, and caps the number at the league's last completed matchup so none is invented past it. The completed-matchup count comes from the schedule's own matchup ids, which are already real matchup numbers.
let matchupMapCache = { data: null, map: null };
/**
 * Returns the league's day-to-matchup lookup, rebuilt whenever a new payload lands. It is cached on
 * the payload object, so a refetch of the same league picks up days scored since.
 * @returns {Object|null} The matchup period map, or null when no league is loaded.
 */
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

// Recomputes each rate from its raw components, which are summed as ordinary counting stats. Averaging daily rates would weight a one at-bat day like a five at-bat day. The table is keyed by sport, and a rate not in it falls back to the averaged-daily approximation, never a guessed component.
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

/**
 * Builds the cumulative line of one category for one team over a list of weeks. A counting category
 * accumulates. A rate category sums its components across the weeks and divides once at each point,
 * because summing the rate itself is meaningless. With no component rule it falls back to the mean
 * of the weeks that carried a value. Weeks with no value are skipped, not counted as zero.
 * @param {Object} weeklyCatsByWeek Per-week category lines by week number, each an object of stat
 *   id to value.
 * @param {number[]} weeks The weeks to include, in order.
 * @param {string|number} catId The category's stat id.
 * @param {string} sport The sport key.
 * @returns {number[]} One cumulative value per week, in the order given.
 */
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

/**
 * Sums raw per-week components over a week range and runs the totals through the same derivation a
 * single week uses. A single week is a range of one, so rate math happens only here. Summing
 * components first avoids weighting a short week like a long one.
 * @param {Object} weeklySums Per-week sums by matchup number, each `{ sums: {statId: sum}, games
 *   }`.
 * @param {number} startWeek First matchup number, inclusive.
 * @param {number} endWeek Last matchup number, inclusive.
 * @param {string} sport The sport key.
 * @returns {Object} Stat id to value for the range, with averaged stats divided by games and rates
 *   recomputed from components.
 */
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

/**
 * Builds one point per day of a matchup, each carrying the running total to that day. Totals are
 * cumulative, so an off day draws a flat segment instead of a gap. Rates are derived from the
 * components accumulated through that day, never by averaging daily rates.
 * @param {Object} dailyByPeriod Scoring period id to `{ sums, games }`, or null.
 * @param {number[]} periods The matchup's scoring periods in order, from the league's schedule.
 * @param {string} sport The sport key.
 * @returns {{period: number, index: number, totals: Object, games: number, played: boolean}[]} One
 *   entry per period.
 */
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

/**
 * Lists the scoring periods of one matchup in order from the league's own schedule. It is never a
 * calendar assumption, since a matchup can span an all-star break or several playoff weeks. The
 * rule lives beside the map it reads.
 * @param {Object|null} matchupMap The league's day-to-matchup map from matchupPeriodMap.
 * @param {number} matchupNumber The matchup number.
 * @returns {number[]} The matchup's scoring period ids in order.
 */
export function periodsOfMatchup(matchupMap, matchupNumber) {
    return scheduledPeriodsOfMatchup(matchupMap, matchupNumber);
}

// Groups a player's day-level stat lines into per-matchup raw sums. It is shared by the single-player and bulk paths. It also returns per-day sums for roto leagues, whose lineup-aware race credits each day to whoever started the player. Only actual lines count. A per-period line is one with a nonzero scoring period, which needs no sport branch because football's weekly lines carry one too.
function isDayLine(s, year) {
    return s.seasonId === year && s.statSourceId === 0 && !!s.scoringPeriodId;
}

function buildWeeklySums(playerStatLines, year, wantDaily = false, matchupPeriods = null) {
    const dayLines = playerStatLines.filter(s => isDayLine(s, year));

    const weeklySums = {}; // week# -> { sums: {statId: sum}, games }
    // The pitcher case. A completed start has to be read on its own day, and a week holds two of them. Everyone else in a head-to-head league skips the per-day memory.
    const dailyByPeriod = (AppState.isRotoLeague || wantDaily) ? {} : null; // scoringPeriodId -> { sums, games }
    // A second, bounded table for only the scoring periods handed in. It is kept apart from the per-day table because that name means every day of the season, and a cache entry carrying it is never refetched.
    const matchupDays = (!dailyByPeriod && matchupPeriods) ? {} : null;
    dayLines.forEach(s => {
        // Matchup leagues bucket by the league's own matchup number, which accounts for a long opening week, a break week and multi-week playoff rounds. Roto has a single matchup, so it buckets by plain scoring-period week to give its race a time axis.
        const week = AppState.isRotoLeague
            ? weekOfScoringPeriod(s.scoringPeriodId)
            : matchupOfScoringPeriod(s.scoringPeriodId);
        if (!weeklySums[week]) weeklySums[week] = { sums: {}, games: 0 };
        const dayTable = dailyByPeriod || (matchupDays && matchupPeriods.has(Number(s.scoringPeriodId)) ? matchupDays : null);
        const dayBucket = dayTable ? (dayTable[s.scoringPeriodId] = dayTable[s.scoringPeriodId] || { sums: {}, games: 0 }) : null;

        weeklySums[week].games++;
        if (dayBucket) dayBucket.games++;
        Object.keys(s.stats || {}).forEach(statId => {
            const v = statValue(s.stats[statId]) || 0;
            weeklySums[week].sums[statId] = (weeklySums[week].sums[statId] || 0) + v;
            if (dayBucket) dayBucket.sums[statId] = (dayBucket.sums[statId] || 0) + v;
        });
    });
    return { weeklySums, dailyByPeriod, matchupDays };
}

/**
 * Turns one player's weekly-stats response into per-week derived lines. Daily sums are always kept
 * here because this path is one player.
 * @param {Object} rawData The weekly-stats response, with `players`.
 * @param {string} sport The sport key.
 * @returns {{weekly: Object, weeklySums: Object, dailyByPeriod: Object}} Derived lines by matchup
 *   number, the raw sums behind them, and per-day sums.
 */
export function processPlayerWeeklyHistory(rawData, sport) {
    // A player can show up as more than one entry in rawData.players if they changed teams (trade or waiver claim) mid-season, each carrying only its own stint's stat lines. Flatten across every entry instead of assuming index 0 has everything, or a mid-season move silently truncates part of the season.
    const statLines = (rawData.players || []).flatMap(e => (e.player && e.player.stats) || []);
    const year = loadedSeason();
    // Daily sums are always kept on this path because it is one player and the Day axis needs them. The bulk path stays selective on purpose.
    const { weeklySums, dailyByPeriod } = buildWeeklySums(statLines, year, true);

    const weekly = {};
    Object.keys(weeklySums).forEach(week => {
        weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
    });

    return { weekly, weeklySums, dailyByPeriod };
}

// Bulk counterpart of the single-player function. It fills the weekly cache for every player in the response, so a player opened later is a cache hit. The set of players who keep every day is a fact about the pool, so it is found once and held against the pool's identity. The rostered ids and matchup periods are not held, because lineups land while a harvest runs.
let everyDayMemo = { pool: null, sport: null, ids: null };
function everyDayIdsOf(sport) {
    const pool = AppState.playerData || [];
    if (everyDayMemo.pool === pool && everyDayMemo.sport === sport) return everyDayMemo.ids;
    const ids = new Set();
    pool.forEach(p => {
        if (!p) return;
        const pitcherEligible = Array.isArray(p.eligiblePositions) && matchesPlayerGroup(p, sport, true);
        if (needsEveryDay({ starterStatusByProGame: p.starterStatusByProGame, pitcherEligible })) ids.add(p.id);
    });
    everyDayMemo = { pool, sport, ids };
    return ids;
}

function processBulkPlayerWeeklyHistory(rawData, sport) {
    const year = loadedSeason();
    // Pitchers are identified from the pool, not the response, because the starter table rides on the pool payload. They get per-day buckets so a completed start can be read on its own day. Only players with a listed start or a pitching seat pay for it.
    const pitcherIds = everyDayIdsOf(sport);

    const statLinesByPlayerId = new Map();
    const secondaryIdsInResponse = new Set();
    const secondaryPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    (rawData.players || []).forEach(entry => {
        const p = entry.player || {};
        const id = p.id ?? entry.id;
        if (id === undefined || id === null) return;
        if (!statLinesByPlayerId.has(id)) statLinesByPlayerId.set(id, []);
        statLinesByPlayerId.get(id).push(...(p.stats || []));
        if (secondaryPositions.has((POSITION_MAPS[sport] || {})[p.defaultPositionId])) secondaryIdsInResponse.add(id);
    });

    // The club fold runs over the same lines before they are summed away. A line is placed by its own club and game, both of which ride on every day line, so no schedule is needed here. It uses the same day-line test as the weekly sums.
    const clubIds = CLUB_EDGE_STAT_IDS[sport];
    if (clubIds) {
        const lines = [];
        statLinesByPlayerId.forEach((statLines, playerId) => {
            const isGoalie = secondaryIdsInResponse.has(playerId);
            statLines.forEach(s => {
                if (!isDayLine(s, year)) return;
                lines.push({ playerId, isGoalie, proTeamId: s.proTeamId, externalId: s.externalId,
                    period: Number(s.scoringPeriodId), totals: s.stats || {} });
            });
        });
        clubFold = foldClubGames(lines, null, { ids: clubIds, into: clubFold, numberOf: v => statValue(v) || 0 });
    }

    // Keeps the days of the matchup being played for rostered players only, bounded by roster and by the matchup's own periods. This is what a head-to-head race inside a matchup needs. A free agent is never kept and the pool-wide per-day table stays off, since that would hold tens of megabytes. A roto league already keeps every day.
    const rosteredIds = raceRosterIds();
    const matchupPeriods = AppState.isRotoLeague ? null
        : periodsOfMatchup(matchupPeriodMap(), Number(AppState.currentMatchup) || null);

    statLinesByPlayerId.forEach((statLines, playerId) => {
        const scope = dayBucketScope(playerId, { everyDayIds: pitcherIds, rosteredIds, matchupPeriods });
        const { weeklySums, dailyByPeriod, matchupDays } = buildWeeklySums(statLines, year, scope === 'all',
            scope instanceof Set ? scope : null);
        const weekly = {};
        Object.keys(weeklySums).forEach(week => {
            weekly[week] = aggregateStatsForWeekRange(weeklySums, Number(week), Number(week), sport);
        });
        // WHICH matchup the kept days belong to rides with them (item 2c): the cache outlives a matchup, and last week's seven days must never be read as this week's.
        AppState.playerWeeklyCache[playerId] = { weekly, weeklySums, dailyByPeriod, matchupDays,
            matchupDaysOf: matchupDays ? (Number(AppState.currentMatchup) || null) : null };
    });
}

/**
 * Returns the club table as the harvest has filled it so far, or null when the sport has no club
 * table or nothing has landed. Games through the day before the league's latest scoring period
 * count by default, so a night in progress is in nobody's average. The table is partial while the
 * harvest runs. Nothing here starts a harvest.
 * @param {Object} [opts] Options.
 * @param {number|null} [opts.through] Last scoring period to include; null counts every game held.
 * @param {number} [opts.minGames] Minimum games a club needs to be ranked.
 * @returns {Object|null} The club table, or null.
 */
export function clubEdgeTable({ through, minGames = 1 } = {}) {
    if (!clubFold || !clubFold.games.size) return null;
    const latest = AppState.apiData?.status?.latestScoringPeriod;
    const bound = through !== undefined ? through : (Number.isFinite(latest) ? latest - 1 : null);
    const key = `${clubFold.players.size}|${bound}|${minGames}`;
    if (clubTableMemo.fold !== clubFold || clubTableMemo.key !== key) {
        clubTableMemo = { fold: clubFold, key, table: clubTable(clubFold, { through: bound, minGames }) };
    }
    return clubTableMemo.table;
}

/**
 * Returns one game's edges from both sides, or null when there is no table or a club cannot be
 * ranked.
 * @param {Object} game The game, by its clubs.
 * @param {Object} [opts] The same options clubEdgeTable takes.
 * @returns {Object|null} The game's edges, or null.
 */
export function clubEdgesForGame(game, opts) {
    const table = clubEdgeTable(opts);
    return table ? gameEdges(game, table) : null;
}

/**
 * Maps each club to the percentile of its shots for per game, the base term of the goalie night
 * difficulty. It uses the clubs' own games, not the season lines of their current players, so a
 * traded skater's season does not count for the wrong club.
 * @param {Object} [opts] The same options clubEdgeTable takes.
 * @returns {Map<number, number>|null} Club id to percentile, or null until a table exists.
 */
export function clubShotVolume(opts = {}) {
    const table = clubEdgeTable(opts);
    if (!table) return null;
    const ranked = [...table.clubs.values()].filter(c => c.figures.shotsFor.rank !== null);
    const values = ranked.map(c => c.figures.shotsFor.value);
    const volume = new Map();
    ranked.forEach(c => {
        const pct = percentileOf(c.figures.shotsFor.value, values);
        if (pct !== null) volume.set(c.clubId, pct);
    });
    return volume.size ? volume : null;
}

/**
 * Reports how much of the club fold has landed.
 * @returns {{players: number, clubGames: number, loading: boolean, skipped: Object|null}} Players
 *   and games folded, whether a harvest is running, and the lines skipped by reason.
 */
export function clubEdgeStatus() {
    return {
        players: clubFold ? clubFold.players.size : 0,
        clubGames: clubFold ? clubFold.games.size : 0,
        loading: bulkWeeklyFetchInFlight,
        skipped: clubFold ? { ...clubFold.skipped } : null
    };
}

// A player needs real weekly data cached (see AppState.playerWeeklyCache and processBulkPlayerWeeklyHistory) before a windowed timeframe can be applied. It decides whether the leaderboard needs a bulk fetch and who is includable in the windowed pool.
function hasCachedWeeklyData(p) {
    return !!AppState.playerWeeklyCache[p.id];
}

// Returns the player pool unchanged for the full season, otherwise shallow clones whose season totals are the windowed aggregate. Players with no cached weekly data are excluded, not shown with season numbers under a window heading. This is the one place a timeframe changes what season totals means. It is memoized by sport and timeframe.
let poolCache = null;

/**
 * Says whether the selected timeframe covers the whole available season, not only whether it is
 * literally "all". Early in a season the regular-season and all-season options resolve to the same
 * weeks, and treating them alike avoids a bulk fetch that would recompute the season totals.
 * @returns {boolean} True when the window is the whole season.
 */
export function isFullSeasonTimeframe() {
    // Roto has no matchup periods, so the season-versus-window question is which option is picked. The week-range comparison below only applies to matchup leagues.
    if (AppState.isRotoLeague) return parseTimeframe(AppState.timeframe).window === null;
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    return start === 1 && end === AppState.maxCompletedWeek;
}

// Resolves the [start, end] week range the player views aggregate over. Roto windows resolve against the race's own week span, so windowed totals line up with the team standings. It also names the live matchup once, so the chips, the chart's matchup count and the verdicts agree on which is held apart. That is null under a picked matchup and for roto.
function liveMatchupHeldApart() {
    if (AppState.isRotoLeague) return null;
    if (parseTimeframe(AppState.timeframe).matchup) return null;
    const current = Number(AppState.currentMatchup) || 0;
    return current > (Number(AppState.maxCompletedWeek) || 0) ? current : null;
}

function playerTimeframeBounds(sport) {
    if (AppState.isRotoLeague) {
        const maxWeek = rotoWindowMaxWeek(sport);
        if (maxWeek > 0) return getTimeframeBounds(AppState.timeframe, maxWeek, maxWeek);
    }
    return getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
}

/**
 * Returns the pool as the current timeframe sees it, for surfaces outside the leaderboard. It is
 * the function the leaderboard and rank lookup read, so a roster row, its rank and the leaderboard
 * row cannot disagree about which weeks count.
 * @param {string} sport The sport key.
 * @returns {Object[]} The windowed player pool.
 */
export function effectivePlayerPool(sport) {
    return getEffectivePlayerPool(sport);
}

function getEffectivePlayerPool(sport) {
    if (isFullSeasonTimeframe()) return AppState.playerData;

    const weeklyCacheSize = Object.keys(AppState.playerWeeklyCache).length;
    const { start, end } = playerTimeframeBounds(sport);
    // The window's bounds belong in the cache key, not only the timeframe string. The same string resolves to different matchups as the season moves, so a string-only key could serve a stale window.
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

/**
 * Lists the positions a role group offers. The leaderboard's dropdown and the comparison picker
 * share it, so they never offer different positions for the same group.
 * @param {Object[]} players The players in view.
 * @param {string} sport The sport key.
 * @param {boolean} wantPitchers True for the secondary group.
 * @returns {string[]} The group's positions in display order.
 */
export function positionOptionsFor(players, sport, wantPitchers) {
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    let positions = Array.from(new Set(players.flatMap(p => p.eligiblePositions)));

    // A two-way player's off-role eligibility has no meaning as a position filter here. matchesPlayerGroup already lets them in through their same-role eligibility, so drop the other role's entries from the dropdown.
    positions = positions.filter(pos => pitcherPositions.has(pos) === wantPitchers);

    if (wantPitchers) {
        // SP comes before RP rather than alphabetical order; anything else falls back to alphabetical after those two.
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

    // A group with one position offers no useful filter, so the dropdown hides and the filter resets to all. This stops a value carried over from a multi-position group from filtering the group to nothing. It keys off the list length, so a future one-position group inherits it.
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

// Draws the team and club picker rail. The availability filter decides which group shows: All gets both fantasy teams and pro clubs, Free Agents gets clubs only, On Teams gets fantasy teams only. Each list is cut to teams that have a player in the players passed in, since a chip with nothing behind it is a dead end.
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
        // Every fantasy team is a crest ringed in its legend colour. The logo lives on the raw payload team, so it is read from there instead of being copied through the team stats pipeline.
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

    // Null, not an empty list, when the pro-team schedule has not been fetched this session. The rail's contract keeps that apart from a real empty row.
    let clubs = null;
    if (showPro) {
        const proSchedule = currentProSchedule();
        const proTeams = proSchedule?.settings?.proTeams;
        if (proTeams) {
            const present = new Set();
            players.forEach(p => { if (p.proTeamId != null) present.add(Number(p.proTeamId)); });
            clubs = proTeams
                // Id 0 is ESPN's placeholder for no pro team, not a club, so it is filtered out.
                .filter(t => t && t.id != null && Number(t.id) !== 0 && present.has(Number(t.id)) && t.abbrev)
                .map(t => ({ id: Number(t.id), abbrev: String(t.abbrev).trim(), name: t.name || null }))
                .sort((a, b) => a.abbrev.localeCompare(b.abbrev));
        }
    }

    if (!fantasyTeams.length && clubs === null) {
        slot.innerHTML = '';
        return;
    }

    // A stale selection, such as a team a search now excludes, falls back to All so the table is never filtered to a team with no visible chip.
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
    applyCrestGrounds(slot, sport);
}

// Picks a backdrop per club logo. A logo that does not clear 3:1 against the page's raised surface takes the inverse ground when that gives more contrast. Colours resolve through a probe element because a custom property read as text can be an unresolved colour-mix. It runs after the render, so until the sample answers a crest keeps its default disc.
function resolveTokenColour(name) {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;background:var(${name})`;
    document.body.appendChild(probe);
    const rgb = parseCssColour(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return rgb;
}
// The one ground rule for every logo drawn on a disc. Each item is `{ el, url }` and the element takes the inverse ground when its logo needs it. Each distinct url is sampled once.
async function applyLogoGrounds(items) {
    if (!items.length) return;
    const base = resolveTokenColour('--surface-3');
    const alt = resolveTokenColour('--crest-ground-alt');
    if (!base || !alt) return;
    const byUrl = new Map();
    items.forEach(it => { if (!byUrl.has(it.url)) byUrl.set(it.url, []); byUrl.get(it.url).push(it.el); });
    await Promise.all([...byUrl.entries()].map(async ([url, els]) => {
        const sampled = await sampleLogoColour(url);
        if (!sampled) return;
        if (pickCrestGround(sampled, base, alt) !== 'alt') return;
        els.forEach(el => { if (el.isConnected) el.style.setProperty('--crest-ground', 'var(--crest-ground-alt)'); });
    }));
}
async function applyCrestGrounds(slot, sport) {
    const items = [];
    slot.querySelectorAll('.lb-rail-crest').forEach(btn => {
        const url = proTeamLogoUrl(sport, btn.dataset.id && btn.querySelector('.avatar-initials')?.textContent);
        if (url) items.push({ el: btn, url });
    });
    await applyLogoGrounds(items);
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

// A compact toggle at the toolbar's right end, on or off by a class like the app's other toggle rows. The full sentence sits in the button's hint, so only the count shows unconditionally.
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

const LOADING_MESSAGES = [
    'Waking up the free agents...',
    'Counting bench warmers...',
    'Untangling stat lines...',
    'Herding roster spots...',
    'Almost there...'
];

/**
 * Builds the loading skeleton for the leaderboard or the draft board. One highlight moves across
 * the whole wrap, which costs far less main-thread time than animating each placeholder. It has no
 * text, since a face does not explain itself, and it respects reduced motion. The markup is static,
 * so repeated calls are safe.
 * @param {string} kind "lb" for the leaderboard shape, otherwise the draft board's.
 * @returns {string} The skeleton markup.
 */
export function buildSkeletonHtml(kind) {
    const bar = (w, h = 10) => `<span class="sk" style="width:${w};height:${h}px"></span>`;
    const disc = (d) => `<span class="sk sk-disc" style="width:${d}px;height:${d}px"></span>`;
    const rows = Array.from({ length: 16 }, () => kind === 'draft'
        ? `<div class="sk-row sk-row-draft">${bar('70%', 12)}${disc(30)}${bar('78%', 12)}${bar('60%')}${bar('70%')}${bar('70%')}<span class="sk sk-pill"></span>${Array.from({ length: 9 }, () => bar('62%')).join('')}</div>`
        : `<div class="sk-row sk-row-lb">${disc(22)}${disc(30)}${bar('80%', 12)}${bar('50%', 12)}${bar('50%')}${bar('50%')}${Array.from({ length: 10 }, () => bar('68%')).join('')}${disc(26)}</div>`).join('');
    const head = `<div class="sk-head">${Array.from({ length: 6 }, () => `<span class="sk" style="width:80px;height:12px"></span>`).join('')}</div>`;
    return `<div class="sk-wrap" aria-hidden="true">${head}${rows}</div>`;
}

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

// One shared in-flight fetch for the full player pool, so the tab's open path can await the request a background prefetch already started. It is keyed to the league it was started for. A response for a different league is discarded, and the league is compared by key and not by object, because a background revalidate replaces the payload object for the same league.
let playerPoolFetch = null;

// The league key lives in api.js so the archive loader can write it without importing this module. It is re-exported so existing importers keep reading it from here.
export { leagueKeyOf };

function ensurePlayerDataLoaded(sport) {
    if (AppState.playerDataLoaded) return Promise.resolve();
    if (!playerPoolFetch || playerPoolFetch.leagueKey !== leagueKeyOf(AppState.apiData)) {
        const leagueKey = leagueKeyOf(AppState.apiData);
        const promise = (async () => {
            const raw = await fetchPlayerData();
            // Superseded only by a DIFFERENT league or season; a revalidated copy of this one is not.
            if (leagueKeyOf(AppState.apiData) !== leagueKey) return;
            setDebugContext('player-pool', raw);
            AppState.playerData = processPlayerData(raw, sport);
            AppState.playerDataLoaded = true;
            // Takes the one number ESPN does not keep, before a game is played. It is not awaited because nothing on screen depends on it.
            maybeTakePreseasonSnapshot();
            AppState.playerDataError = null;
            buildPositionFilterOptions(sport);
            // Announces the pool's arrival with an event. My Team renders before the pool lands after a league switch, and an event avoids importing this module back from there, which would close a cycle.
            document.dispatchEvent(new CustomEvent('leaguewise:player-pool-ready'));
        })();
        // A failed fetch must not poison later attempts with the same rejected promise, so the slot is cleared and the next call starts a fresh request.
        promise.catch((err) => {
            if (playerPoolFetch && playerPoolFetch.promise === promise) playerPoolFetch = null;
            // The error is recorded and not only thrown, because My Team reads the same state and has to explain the absence too. The same league test as the success path applies.
            if (leagueKeyOf(AppState.apiData) === leagueKey) {
                AppState.playerDataError = { authRequired: !!err?.authRequired, message: err?.message || 'Unknown error' };
            }
        });
        // THE SLOT HOLDS A FETCH IN FLIGHT, never a finished one. Keyed on the league rather than the object, a settled promise would now match the same league forever: Fetch Data on the league already loaded resets the pool (processCoreData) and asks again, and would be handed back the old resolved promise with nothing written. Once one lands, playerDataLoaded answers.
        promise.then(() => {
            if (playerPoolFetch && playerPoolFetch.promise === promise) playerPoolFetch = null;
        }, () => { /* the catch above clears it and records the error */ });
        playerPoolFetch = { leagueKey, promise };
    }
    return playerPoolFetch.promise;
}

// Refetches the pool in place for a dashboard left open. The pool on screen stays until the new one has arrived, and a failure changes nothing. It does not use the first-load path, because that path signals absence and would blank the views for as long as the refetch took.
async function revalidatePlayerPool(sport) {
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
        // The leaderboard is hidden while a drill-down is open, so refresh whichever one is actually showing.
        if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        else renderPlayerLeaderboard();
    } catch {
        // Keep what is on screen. Nobody asked for this refresh, so nobody can act on its failure.
    }
}

/**
 * Consumes the stale-pool flag. A revalidate sets the flag instead of refetching, and the first
 * surface that shows pool numbers refetches here, so the pool is at most one render behind the
 * moment somebody looks.
 */
export function revalidateStalePoolIfDue() {
    // The weekly half rides the same trigger, because every caller here has just rendered pool numbers. Keeping the check in this one function avoids wiring it into three modules. It does nothing on the default timeframe or within the same day.
    refreshWeeklyForNewDayIfDue();
    if (!AppState.playerPoolStale) return;
    AppState.playerPoolStale = false;
    revalidatePlayerPool(AppState.loadedSport);
}

// Refreshes the weekly cache when the day has turned. It is silent, and each chunk rewrites its own players as it lands, so rows are never dropped while it runs. It runs only when a window is selected, the cache has content, no harvest is running, and the latest scoring period has moved past the day the cache was built for.
function refreshWeeklyForNewDayIfDue() {
    if (isFullSeasonTimeframe()) return;
    if (bulkWeeklyFetchInFlight) return;
    const key = currentLeagueKey();
    if (!key || weeklyHarvestDay.key !== key) return;
    const today = AppState.apiData?.status?.latestScoringPeriod;
    // Number.isFinite on both, never Number(), because a null period coerces to 0 and would read as the day going backwards.
    if (!Number.isFinite(today) || !Number.isFinite(weeklyHarvestDay.period)) return;
    if (today <= weeklyHarvestDay.period) return;
    const ids = Object.keys(AppState.playerWeeklyCache).map(Number).filter(Number.isFinite);
    if (!ids.length) return;
    refreshWeeklyCache(AppState.loadedSport, ids);
}

async function refreshWeeklyCache(sport, ids) {
    const apiDataRef = AppState.apiData;
    bulkWeeklyFetchInFlight = true;
    // Every cached player re-lands, so the club fold starts over and refills (see clubFold).
    clubFold = null;
    weeklyQueue = prioritizeWeeklyIds(ids, sport);
    weeklyClaimedIds.clear();
    // The debug context is not reset here, because a refresh accumulates into whatever the league already holds. Only a league switch clears it.
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
        // Keep what is on screen. Nobody asked for this refresh, so nobody can act on its failure.
    } finally {
        bulkWeeklyFetchInFlight = false;
    }
}

/**
 * Retries the pool after a login lands mid-session. If the player tab is showing, its own loader
 * runs so the loading and error text appear. Otherwise the pool is warmed quietly and My Team
 * redraws off the pool-ready event.
 */
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

/**
 * Warms the pool as soon as league data lands, so the Player Metrics tab usually opens with the
 * pool already loaded. Errors are swallowed here because the tab's own open path retries and owns
 * the error text.
 */
export function prefetchPlayerData() {
    if (!AppState.apiData || AppState.playerDataLoaded) return;
    // Warms the pool for the league already loaded, so it asks that league's sport and not the form's dropdown. The weekly harvest is not chained behind it. Every surface that reads weekly data has its own demand trigger, and chaining cost every open the whole pool's chunks.
    const sport = AppState.loadedSport;
    ensurePlayerDataLoaded(sport).catch(() => {});
}

/**
 * Opens the Player Metrics tab: shows the loading skeleton, loads the pool if needed and renders
 * the leaderboard, with its own error text on failure.
 * @returns {Promise<void>}
 */
export async function loadPlayerTabIfNeeded() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    if (!AppState.apiData) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }

    // Entering the tab is looking at pool numbers, which is what consumes a deferred revalidate. The current pool renders below and the fresh one swaps in.
    revalidateStalePoolIfDue();

    if (AppState.playerDataLoaded) {
        renderPlayerLeaderboard();
        return;
    }

    const sport = AppState.loadedSport;
    // The skeleton replaces the progress bar on this path. It has nothing to animate from script, so the controller is a pair of no-ops and the rows render the moment the pool is in.
    container.innerHTML = buildSkeletonHtml('lb');
    const progress = { stop() {}, finish: () => Promise.resolve() };
    try {
        await ensurePlayerDataLoaded(sport);
        // The awaited fetch can resolve as a stale no-op if a new league fetch superseded it mid-flight, so one retry covers that window.
        if (!AppState.playerDataLoaded) await ensurePlayerDataLoaded(sport);
        await progress.finish();
        renderPlayerLeaderboard();
    } catch (err) {
        progress.stop();
        container.innerHTML = `<div class="player-loading">${escapeHtml(playerPoolErrorText(err))}</div>`;
    }
}

// The day the weekly cache was built for, kept with the league key. A windowed timeframe reads this cache and it is only cleared on a league switch, so without a stamp a dashboard left open would show frozen figures. Gating on the latest scoring period re-harvests at most once a day and never on the default timeframe.
let weeklyHarvestDay = { key: null, period: null };

// poolCache (getEffectivePlayerPool) keys on how many players have weekly data, which is a fine signal while the cache only ever GROWS and a useless one now that it can be rewritten in place: a refresh replaces 1,699 entries with 1,699 entries and the count never moves. This counter is what makes the memo notice.
let weeklyCacheVersion = 0;

let bulkWeeklyFetchInFlight = false;
// Set once a bulk fetch attempt fails, so a failure shows a stable error and does not retry on every re-render. It resets on a new league or season fetch.
let bulkWeeklyFetchFailed = false;

// True once every real player, meaning one with at least one defined season stat, has cached weekly data, which a windowed timeframe needs to compute anything for them.
function leaderboardWeeklyDataReady() {
    return AppState.playerData.every(p =>
        Object.keys(p.seasonTotals || {}).length === 0 || AppState.playerWeeklyCache[p.id]);
}

// Bulk-fetches weekly data for every real player still missing it, then re-renders the leaderboard. It is called without awaiting and guarded against overlapping runs. This module owns the ordering and concurrency so the queue can be reordered mid-flight. The basis pool is fetched before the inactive tail and what is on screen is cached first. Arrows wait for a full basis, since a partial one would be biased high.

// Ids still to fetch, in priority order. Workers shift chunks off the front and a reprioritize re-sorts what is left, so a scroll or sort changes the next request without cancelling anything in flight.
let weeklyQueue = [];
// Ids handed to a worker but not yet resolved. Held out of a reprioritize pass so two workers can never claim the same id, and released in a finally so a failed chunk doesn't strand them.
let weeklyClaimedIds = new Set();
// The pool debug context accumulates every chunk's players as they land. The envelope, which is everything but the players array, comes from the league's first chunk. It resets only when the weekly cache is cleared for a league switch. Players are keyed by id so a refresh replaces an entry instead of holding it twice.
let weeklyPoolEnvelope = null;
let weeklyPoolPlayers = new Map();

// What is held of one harvested entry. Last season's day lines are dropped, since the request asks for more periods than a season has and nothing reads them. Every line kept is the line as fetched, and an entry with nothing to drop is held as it came, so the response being read is never altered. With no league loaded everything is kept.
function heldWeeklyEntry(entry, season) {
    const stats = entry && entry.player && entry.player.stats;
    if (!Array.isArray(stats) || !Number.isFinite(season)) return entry;
    const kept = stats.filter(s => !(s && s.scoringPeriodId && s.seasonId !== season));
    return kept.length === stats.length ? entry : { ...entry, player: { ...entry.player, stats: kept } };
}

// The club fold sums what every club did in every game out of the harvest's day lines as they land, and keeps club records only. The day lines themselves are not kept for this. The fold is dropped, not patched, wherever the harvest starts over, because a player who lands twice would otherwise be counted twice.
let clubFold = null;
let clubTableMemo = { fold: null, key: null, table: null };

// A burst of chunk completions should repaint once, not once each.
const WEEKLY_RERENDER_DEBOUNCE_MS = 150;
let weeklyRerenderTimer = null;

// An extra observer fired on each debounced weekly-progress repaint, so a consumer outside the Player tab can react as chunks land. The roto race uses it. It is wired in main.js to avoid an import from here to graphs. Null when nobody is listening.
let weeklyProgressHook = null;
/**
 * Registers the observer called on each debounced weekly-progress repaint.
 * @param {function(): void|null} fn The observer, or null to remove it.
 * @returns {void}
 */
export function setWeeklyProgressHook(fn) { weeklyProgressHook = fn; }

function scheduleWeeklyRerender() {
    clearTimeout(weeklyRerenderTimer);
    weeklyRerenderTimer = setTimeout(() => {
        weeklyRerenderTimer = null;
        renderPlayerLeaderboard();
        if (weeklyProgressHook) weeklyProgressHook();
    }, WEEKLY_RERENDER_DEBOUNCE_MS);
}

// The player ids whose rows are inside the leaderboard's scroll viewport, in visual order, read off the rendered rows so sort and filters are already applied. Empty before the tab has rendered, which callers read as no visibility signal and not as nothing visible.
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
    // The tier sizes, published for the test harness, which measures how much of the pool each tier is.
    window.__weeklyTierSizes = { visible: visibleCount, basis: ordered.length - visibleCount, rest: remaining.size };
    remaining.forEach(id => ordered.push(id));
    return ordered;
}

/**
 * Re-tiers whatever is left after the user scrolls or re-sorts. Fetched and in-flight ids drop out,
 * so nothing is requested twice.
 * @returns {void}
 */
export function reprioritizeWeeklyQueue() {
    if (!bulkWeeklyFetchInFlight || weeklyQueue.length === 0) return;
    const sport = AppState.loadedSport;
    const stillNeeded = weeklyQueue.filter(id => !AppState.playerWeeklyCache[id] && !weeklyClaimedIds.has(id));
    weeklyQueue = prioritizeWeeklyIds(stillNeeded, sport);
}

// A fixed pool of workers, each pulling the next chunk off the front of the shared queue, so a reprioritize takes effect mid-run. A chunk rejection propagates and sets the sticky failed flag.
async function runWeeklyQueue(sport, apiDataRef, refresh = false) {
    const workerCount = Math.min(WEEKLY_MAX_CONCURRENT_CHUNKS, Math.ceil(weeklyQueue.length / WEEKLY_CHUNK_SIZE) || 1);
    const worker = async () => {
        for (;;) {
            const chunk = [];
            while (chunk.length < WEEKLY_CHUNK_SIZE && weeklyQueue.length > 0) {
                const id = weeklyQueue.shift();
                // A refresh asks for ids it already holds, so already cached is not a reason to skip. A claimed id still skips, since that concerns two workers and not staleness.
                if ((!refresh && AppState.playerWeeklyCache[id]) || weeklyClaimedIds.has(id)) continue;
                weeklyClaimedIds.add(id);
                chunk.push(id);
            }
            if (chunk.length === 0) return;
            try {
                const raw = await fetchPlayersWeeklyChunk(chunk);
                // Superseded mid-flight (see the discard rule ensurePlayerDataLoaded documents): drop this chunk entirely rather than writing another league's rows into the freshly cleared cache, and stop pulling more work.
                if (AppState.apiData !== apiDataRef) return;
                // The queue's own daily splits have their own debug kind, separate from the pool's. Every chunk's players accumulate across every run this league sees, and a refresh re-landing an id replaces that entry.
                if (!weeklyPoolEnvelope) {
                    const { players: _discard, ...envelope } = raw || {};
                    weeklyPoolEnvelope = envelope;
                }
                const season = loadedSeason();
                (raw.players || []).forEach(entry => {
                    const id = entry?.id ?? entry?.player?.id;
                    if (id != null) weeklyPoolPlayers.set(Number(id), heldWeeklyEntry(entry, season));
                });
                setDebugContext('player-weekly', { ...weeklyPoolEnvelope, players: Array.from(weeklyPoolPlayers.values()) });
                processBulkPlayerWeeklyHistory(raw, sport);
                // A requested player the response did not include gets an empty stub. Without one, the readiness check would stay false and every re-render would repeat the whole fetch.
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

/**
 * Starts the weekly fetch for a windowed timeframe from My Team, which previously relied on the
 * leaderboard having asked. Without it a windowed pill turned roster lines into dashes until Player
 * Metrics was visited.
 * @param {string} sport The sport key.
 * @returns {void}
 */
export function ensureWeeklyDataForTimeframe(sport) {
    if (!AppState.playerDataLoaded || bulkWeeklyFetchInFlight || bulkWeeklyFetchFailed) return;
    ensureLeaderboardWeeklyDataLoaded(sport);
}

/**
 * True while the roster's own weekly rows are still arriving. A player with no cache entry is
 * unknown, which differs from having played no games in the window.
 * @returns {boolean} True when a fetch is in flight and the roster is not fully cached.
 */
export function weeklyDataPending() {
    return bulkWeeklyFetchInFlight;
}

// Fetches weekly data for the scope given. "all" fetches every missing player with season totals. "basis" stops after the visible rows and the qualified basis pool, which is what the trend arrows need. Completion is per-id cache misses, never a flag, so a basis run finishing cannot read as everything fetched.
async function ensureLeaderboardWeeklyDataLoaded(sport, scope = 'all') {
    if (bulkWeeklyFetchInFlight) return;
    let missingIds = AppState.playerData
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id])
        .map(p => p.id);
    if (scope === 'basis') {
        const wanted = new Set([...visibleLeaderboardPlayerIds(), ...weeklyBasisPoolIds(sport)]);
        missingIds = missingIds.filter(id => wanted.has(id));
    }
    // "rostered" is the head-to-head day race's own ask, only players on a fantasy roster. It also re-asks for a rostered player whose entry holds no days for the matchup being played, because for the race that entry is a miss.
    if (scope === 'rostered') {
        // ASKED ONCE PER MATCHUP. A player the response never answers for would otherwise be a miss on every render, and this is called from a render.
        const stamp = `${currentLeagueKey()}:${Number(AppState.currentMatchup) || 0}`;
        if (matchupDaysAsked.stamp !== stamp) matchupDaysAsked = { stamp, ids: new Set() };
        const wanted = raceRosterIds();
        missingIds = AppState.playerData
            .filter(p => wanted.has(p.id) && Object.keys(p.seasonTotals || {}).length > 0
                && !matchupDaysFor(p.id) && !matchupDaysAsked.ids.has(p.id))
            .map(p => p.id);
        missingIds.forEach(id => matchupDaysAsked.ids.add(id));
    }
    if (missingIds.length === 0) return;

    // The same discard rule as the pool fetch. A league fetch mid-flight resets the cache, so these responses would be the wrong league's and could be parsed with another sport's stat map. The check runs per chunk so a superseded run stops early.
    const apiDataRef = AppState.apiData;

    bulkWeeklyFetchInFlight = true;
    weeklyQueue = prioritizeWeeklyIds(missingIds, sport);
    weeklyClaimedIds.clear();
    // Not reset here. Both groups' runs share this entry point, and clearing the context on each call would leave a harvest holding only the last group that ran. Only a league switch clears it.
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

// ==== Roto race, standings over time from weekly roster stats ====

// Byte estimates for Download All's two harvests, per player for the weekly lines and per pool for the player pool. They are compact measurements, used only to show a cost before a press.
const WEEKLY_BYTES_PER_PLAYER = { fhl: 24000, flb: 72000, ffl: 6000 };   // compact, measured
const POOL_BYTES = { fhl: 4700000, flb: 10400000, ffl: 3000000 };
/**
 * Builds Download All's two steps that need the pool, the player pool and every weekly line, so
 * they can start from any tab. It returns the steps and runs nothing, because the capture module
 * decides order and counts. Each step reports whether it is held, what it will cost and how to run
 * it, and joins a harvest already in flight.
 * @param {string} sport The sport key.
 * @returns {{kind: string, present: function(): boolean, estimate: function(): {requests:
 *   number|null, bytes: number|null}, run: function(Object): Promise<Object>}[]} The player-pool
 *   step then the player-weekly step.
 */
export function playerCaptureSteps(sport) {
    const outstanding = () => (AppState.playerData || [])
        .filter(p => Object.keys(p.seasonTotals || {}).length > 0 && !AppState.playerWeeklyCache[p.id]).length;
    const settle = async () => { while (bulkWeeklyFetchInFlight) await new Promise(r => setTimeout(r, 250)); };
    const weeklyHeld = () => (debugContextFor('player-weekly')?.players || []).length;
    return [
        {
            kind: 'player-pool',
            present: () => AppState.playerDataLoaded && hasDebugContext('player-pool'),
            estimate: () => ({ requests: 1, bytes: POOL_BYTES[sport] ?? null }),
            run: (report) => countedCapture(report, async () => {
                await ensurePlayerDataLoaded(sport);
                const players = (AppState.playerData || []).length;
                return AppState.playerDataLoaded
                    ? { asked: 1, got: 1, counts: { players } }
                    : { asked: 1, got: 0, ok: false, error: AppState.playerDataError?.message || 'the pool did not load' };
            })
        },
        {
            kind: 'player-weekly',
            // Held only when the pool is in and no player with a season line is still without days: a harvest that warmed one screenful of rows is not the season's lines.
            present: () => AppState.playerDataLoaded && weeklyHeld() > 0 && outstanding() === 0,
            // Before the pool is in, how many players have a line is not known, and neither is this.
            estimate: () => {
                if (!AppState.playerDataLoaded) return { requests: null, bytes: null };
                const n = outstanding();
                return { requests: Math.ceil(n / WEEKLY_CHUNK_SIZE), bytes: n * (WEEKLY_BYTES_PER_PLAYER[sport] ?? 0) || null };
            },
            run: (report) => countedCapture(report, async () => {
                await ensurePlayerDataLoaded(sport);
                if (!AppState.playerDataLoaded) return { ok: false, error: 'the pool did not load, so there is no list of players to ask for' };
                // A harvest the tab or the prefetch already has in flight is joined, not doubled.
                await settle();
                const asked = outstanding();
                if (asked) {
                    bulkWeeklyFetchFailed = false;
                    await ensureLeaderboardWeeklyDataLoaded(sport, 'all');
                    await settle();
                }
                const left = outstanding();
                return { asked, got: asked - left, refused: bulkWeeklyFetchFailed ? left : 0,
                    error: bulkWeeklyFetchFailed ? 'the weekly harvest failed part-way' : null,
                    counts: { players: weeklyHeld() } };
            })
        }
    ];
}

/**
 * Kicks the bulk weekly fetch for the roto race when it is neither loading nor permanently failed.
 * The trends box calls it because the Team tab can open before the prefetch finished.
 * @param {string} sport The sport key.
 * @returns {void}
 */
export function ensureWeeklyDataForRace(sport) {
    if (!bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport);
}

/**
 * True once the fetch has permanently failed this session, so the race shows an error line instead
 * of a spinner.
 * @returns {boolean} The sticky failed flag.
 */
export function weeklyDataFailed() { return bulkWeeklyFetchFailed; }

// The current league's identity, used to key the one-time transaction harvests so a previous league's log is never served. It is read from the payload and not the form, so it cannot drift, and it uses the same spelling of the key the pool's guard reads.
function currentLeagueKey() {
    return leagueKeyOf(AppState.apiData);
}

// Fetches the pro schedule on demand, when a reader switches the leaderboard to a lens that needs it. It is not fetched on load, because most readers never look at that column. It is the same cached request My Team makes. The leaderboard re-renders when the answer arrives, including on an empty answer, so the header never stays in its pre-fetch state.
let proScheduleReadyKey = null;
let proScheduleFetch = null;
/**
 * Fetches the pro-team schedule once per league, resolving to its body or null. A league with no
 * key resolves to null, and a repeated call reuses the request in flight.
 * @returns {Promise<Object|null>} The pro schedule, or null when it could not be had.
 */
export function ensureProScheduleData() {
    const key = currentLeagueKey();
    if (!key) return Promise.resolve(null);
    // Both guards, and they answer different questions: the ready key says this LEAGUE's fetch has resolved and its render has run, and currentProSchedule says the body in memory belongs to this league's sport and year rather than to whatever was loaded before it.
    const inHand = currentProSchedule();
    if (proScheduleReadyKey === key && inHand) return Promise.resolve(inHand);
    if (proScheduleFetch && proScheduleFetch.key === key) return proScheduleFetch.promise;
    const promise = fetchProTeamSchedules().then(data => {
        // A league switched mid-flight makes this answer the wrong league's, so it is dropped and not drawn against another league's rows.
        if (currentLeagueKey() !== key) return data;
        proScheduleReadyKey = key;
        renderPlayerLeaderboard();
        return data;
    }).catch(() => null);
    proScheduleFetch = { key, promise };
    return promise;
}

// Fetches the draft's own picks, alone, for the preseason face. The picks are not in the league payload and only the roto race asked for them, so the face's third promise could never be kept. In season it does not fire, since the race fetches the same view. The response is cached under the league's key and shared with the harvest below.
let draftPicksCache = { key: null, picks: null };
let draftPicksInFlight = null;

/**
 * Returns the draft picks from whichever source holds them. The harvest's copy wins when it exists,
 * because the race and history view already read it.
 * @returns {Object[]|null} The picks, or null when none are held.
 */
export function draftPicksFor() {
    const key = currentLeagueKey();
    if (AppState.rosterTransactionData && AppState.rosterTransactionData.key === key) {
        return AppState.rosterTransactionData.picks || null;
    }
    return draftPicksCache.key === key ? draftPicksCache.picks : null;
}

/**
 * Fetches the draft's picks for the preseason face, reusing a held copy or an in-flight request for
 * the same league.
 * @param {string} sport The sport key.
 * @returns {Promise<Object[]|null>} The picks, or null when no league is loaded.
 */
export function ensureDraftPicks(sport) {
    const key = currentLeagueKey();
    if (!key) return Promise.resolve(null);
    if (draftPicksFor()) return Promise.resolve(draftPicksFor());
    if (draftPicksInFlight && draftPicksInFlight.key === key) return draftPicksInFlight.promise;

    const leagueId = AppState.apiData?.id;
    const year = AppState.apiData?.seasonId;
    if (leagueId == null || year == null) return Promise.resolve(null);

    const promise = fetchDraftDetail(sport, leagueId, year).then(picks => {
        if (currentLeagueKey() !== key) return null;   // a league switched mid-flight, so drop it
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

// The harvest as a joinable promise. A second reader, such as the careers pane, can wait for a running harvest and not start a second walk of the same periods. It resolves to the raw picks and transactions, so this module knows nothing about attribution.
let rosterHarvestInFlight = null;

/**
 * Returns the running harvest's promise, or null unless a harvest for the league on screen right
 * now is running. The key check stops a promise from a league the reader left from resolving with
 * the wrong season's log.
 * @returns {Promise<Object>|null} The in-flight harvest, resolving to `{ picks, transactions }`.
 */
export function liveHarvestInFlight() {
    const key = currentLeagueKey();
    return rosterHarvestInFlight && key && rosterHarvestInFlight.key === key ? rosterHarvestInFlight : null;
}
let snapshotHarvestInFlightKey = null;
let snapshotHarvestFailedKey = null;

/**
 * Fetches the draft picks and the full transaction log once per league and season, for the
 * transaction-accurate roto race. It is called without awaiting. On completion it fires the
 * weekly-progress hook so the box upgrades from the current-roster fallback. A league switch
 * mid-harvest discards the result, and a failure leaves the data null so the race stays on the
 * fallback.
 * @param {string} sport The sport key.
 * @returns {Promise<void>}
 */
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
        rosterHarvestFailedKey = key; // can't harvest without the period bounds, so stay on the fallback
        return;
    }

    // Staleness is a change of league, not of object. The background revalidate assigns a new payload object for the same league, so comparing the reference threw away a completed harvest. Comparing the key still stops a league or season switch from writing one league's log into another's state.
    rosterHarvestInFlightKey = key;
    // Built as one shared promise so a joiner gets the SAME work rather than a copy of it, and published before the first await so a caller that arrives in the same tick can still find it.
    const work = Promise.all([
        // Already fetched if the preseason face asked for them. One response serves both readers because it is cached under the league's key.
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
        if (currentLeagueKey() !== key) return; // a real league switch, so drop it
        // Both empty means no usable history, so the data stays null and the race keeps the current-roster fallback.
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

/**
 * Harvests the daily roster snapshots once per league and season, for the lineup-aware roto race.
 * It has the same guarantees as the transaction harvest, and fires the weekly-progress hook on
 * completion. A failure leaves the data null and the race steps down its fallback ladder. Force
 * clears only the failed guard, so a person pressing the button gets another attempt, while the
 * in-flight guard still holds.
 * @param {string} sport The sport key.
 * @param {Object} [opts] Options.
 * @param {boolean} [opts.force] Clear the failed guard for a user-initiated retry.
 * @returns {Promise<void>}
 */
export async function ensureRosterSnapshotData(sport, { force = false } = {}) {
    const key = currentLeagueKey();
    if (!key) return;
    if (force && snapshotHarvestFailedKey === key) snapshotHarvestFailedKey = null;
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
        if (currentLeagueKey() !== key) return; // a real league switch, so drop it
        // No days at all means the season predates ESPN's stored daily rosters, or the response was private or empty, so the data stays null and the race falls back to the transaction timeline.
        if (Object.keys(days).length === 0) {
            snapshotHarvestFailedKey = key;
        } else {
            AppState.rosterSnapshotData = { key, days };
            // The harvest's own output, captured once here and not per request, because the per-request kind is a single day by the time anyone downloads it. It is distilled to period, player id and slot, since the raw entries would be far larger for no extra answer.
            setDebugContext('roster-days', days);
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

// The scoring period that stands in for a real week when reading roster ownership. It inverts the week mapping, so both halves live in utils.js. Only the rostered-day fallback tier uses it, and a roster change inside a week credits the whole week to the mid-week holder.
function representativePeriodForWeek(week) {
    return midPeriodOfWeek(week, AppState.apiData?.status?.firstScoringPeriod || 1);
}

// True while the race should hold its loading state, because the best tier still expected has not arrived. The fallback ladder answers failure, not latency, so a tier is skipped only once its harvest has failed for this league. Drawing whichever tier was ready first made a cold load paint three different races in a second. The weekly stats gate it too, since a partly filled cache draws a visibly different chart.
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
    return false; // both harvests failed, so current rosters is the final answer
}

// The league's starting slots are every slot it rosters minus the sport's bench and injured-reserve slots. A player's day credits a team only when that day's snapshot slot is in this set.
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

// Accumulates started-day component sums per team and week, shared by the race and the windowed standings and heatmap, so a window and the race cannot disagree. It returns null unless the started tier is available, because the fallback tiers count benched days ESPN does not. It is memoized by league key and weekly-cache size.
let rotoStartedSumsCache = null;
/**
 * Exposes the started-day component sums per team and week, so a caller outside the race, such as
 * the roto odds, builds on the same figures.
 * @param {string} sport The sport key.
 * @returns {{key: string, cacheSize: number, teamWeeklySums: Map<number, Object>, weeks:
 *   number[]}|null} Each team's `{ week: { sums, games } }` map and the weeks present, or null when
 *   the started tier is not available.
 */
export function rotoStartedSums(sport) {
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
    // The seat beside the team, so a day is credited by the seat's role exactly as the matchup race credits it, with one rule and one function applying it.
    const seats = buildStartedSeats({ rosterDays: snapData.days, startingSlots: startingSlotsForLeague(sport) });
    const countsFor = seatRuleFor(sport);
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
            const credited = creditedStats(daily[periodKey].sums, seats.get(p.id)?.get(period), countsFor);
            Object.keys(credited).forEach(id => { dest[week].sums[id] = (dest[week].sums[id] || 0) + credited[id]; });
        });
    });

    rotoStartedSumsCache = { key, cacheSize, teamWeeklySums, weeks: Array.from(weekSet).sort((a, b) => a - b) };
    return rotoStartedSumsCache;
}

/**
 * Builds the roto race across the days of one week, not across weeks. A day counts for whichever
 * team had the player started that day, with the same walk as the weekly sums. Each team's days run
 * through the same cumulative function the drill-down uses. It returns null when the started tier
 * is not available.
 * @param {string} sport The sport key.
 * @returns {{periods: number[], byTeam: Map<number, Object[]>}|null} The days and each team's
 *   accumulated category values, or null.
 */
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
    const seats = buildStartedSeats({ rosterDays: snapData.days, startingSlots: startingSlotsForLeague(sport) });
    const countsFor = seatRuleFor(sport);
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
            const credited = creditedStats(daily[periodKey].sums, seats.get(p.id)?.get(period), countsFor);
            Object.keys(credited).forEach(id => { dest[period].sums[id] = (dest[period].sums[id] || 0) + credited[id]; });
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

// A head-to-head league gets the roto race's day series for the matchup being played, from each rostered player's days and each team's daily lineup. It costs one request per elapsed day. A past day is fetched once per session and today's lineup is asked for again after a delay. It is held in memory, not storage. Football never reaches the network, because a one-day matchup is a point and not a race.
const MATCHUP_LINEUP_TODAY_MS = 300000;
let matchupLineups = null;          // { key, matchup, days: { period: teams }, fetchedAt: { period: ms } }
let matchupLineupsInFlightKey = null;
let matchupLineupsFailedKey = null;
let matchupDaysAsked = { stamp: null, ids: new Set() };

// Lists who the race needs days for, everyone the pool has on a team and everyone a harvested lineup names. The lineup is the authority, since the pool can be staler than a pickup.
function raceRosterIds() {
    const ids = new Set();
    (AppState.playerData || []).forEach(p => { if (p && p.teamId) ids.add(p.id); });
    if (matchupLineups && matchupLineups.key === currentLeagueKey()) {
        Object.values(matchupLineups.days).forEach(teams => (teams || []).forEach(t =>
            (t.entries || []).forEach(e => { if (e && e.p != null) ids.add(e.p); })));
    }
    return ids;
}

// A player's kept days for the matchup being played, or null when there are none to trust. A whole-season table (a roto league, a pitcher) answers for any matchup; a bounded one only for the matchup it was cut for.
function matchupDaysFor(playerId) {
    const entry = AppState.playerWeeklyCache[playerId];
    if (!entry) return null;
    if (entry.dailyByPeriod) return entry.dailyByPeriod;
    const current = Number(AppState.currentMatchup) || null;
    return (entry.matchupDays && current !== null && entry.matchupDaysOf === current) ? entry.matchupDays : null;
}

// The matchup's days up to today, or [] when there is no race to build: a roto league (which has its own), no matchup being played, or fewer than two days in it.
function matchupLineupPeriods() {
    if (AppState.isRotoLeague) return { matchup: null, periods: [] };
    const matchup = Number(AppState.currentMatchup) || null;
    const today = Number(AppState.apiData?.scoringPeriodId) || null;
    if (!matchup || !today) return { matchup, periods: [] };
    const all = periodsOfMatchup(matchupPeriodMap(), matchup);
    if (all.length < 2) return { matchup, periods: [] };
    return { matchup, periods: all.filter(p => p <= today) };
}

/**
 * Harvests the lineups of the matchup being played. It is called without awaiting, key-guarded and
 * staleness-guarded like the season harvests, and is safe to call on every render because it asks
 * only for days it does not hold, plus today again once its copy is old.
 * @param {string} sport The sport key.
 * @param {Object} [opts] Options.
 * @param {number} [opts.now] The clock in milliseconds, so the freshness rule can be driven from a
 *   test.
 * @returns {Promise<void>}
 */
export async function ensureMatchupLineups(sport, { now = Date.now() } = {}) {
    const key = currentLeagueKey();
    if (!key || matchupLineupsInFlightKey === key || matchupLineupsFailedKey === key) return;
    const { matchup, periods } = matchupLineupPeriods();
    if (!periods.length) return;
    const leagueId = AppState.apiData?.id;
    const year = AppState.apiData?.seasonId;
    if (leagueId == null || year == null) return;

    const held = (matchupLineups && matchupLineups.key === key && matchupLineups.matchup === matchup)
        ? matchupLineups : { key, matchup, days: {}, fetchedAt: {} };
    const today = periods[periods.length - 1];
    const wanted = periods.filter(p => !held.days[p]
        || (p === today && now - (held.fetchedAt[p] || 0) >= MATCHUP_LINEUP_TODAY_MS));
    // Fetches stat lines for rostered players only. It runs again once the lineups land, because a lineup can name a player the pool does not yet show on a team. A second call while the first runs does nothing.
    const kickDays = () => {
        if (AppState.playerDataLoaded && !bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) {
            ensureLeaderboardWeeklyDataLoaded(sport, 'rostered');
        }
    };
    kickDays();
    if (!wanted.length) return;

    matchupLineupsInFlightKey = key;
    try {
        const { days } = await harvestRosterPeriods(sport, leagueId, year, wanted);
        if (currentLeagueKey() !== key) return; // a real league switch, so drop it
        if (!Object.keys(days).length && !Object.keys(held.days).length) { matchupLineupsFailedKey = key; return; }
        Object.keys(days).forEach(p => { held.days[p] = days[p]; held.fetchedAt[p] = now; });
        matchupLineups = held;
        kickDays();
    } catch (err) {
        if (currentLeagueKey() !== key) return;
        console.error('Failed to harvest the lineups for the matchup being played:', err);
        matchupLineupsFailedKey = key;
    } finally {
        if (matchupLineupsInFlightKey === key) matchupLineupsInFlightKey = null;
        if (weeklyProgressHook) weeklyProgressHook();
    }
}

/**
 * Builds the matchup's day series in the roto series' own shape, so the same renderer draws it. It
 * is null until whole: no lineups, fewer than two days with one, or a started player whose days
 * have not arrived each give null, because a race missing one starter is wrong while looking right.
 * @param {string} sport The sport key.
 * @returns {{periods: number[], byTeam: Map<number, Object[]>}|null} The series, or null.
 */
export function matchupCategoryDailySeries(sport) {
    const race = buildMatchupRace(sport);
    return race.state === 'ready' ? race.series : null;
}

/**
 * Says why there is no series, for a caller choosing between waiting and giving the space back. The
 * state is one of none (no day race applies), loading (lineups or days still arriving), failed (the
 * lineup harvest answered nothing), short (fewer than two days have a lineup) or ready.
 * @param {string} sport The sport key.
 * @returns {{state: string, days: number, unknown: number, missing: number[]}} The state and the
 *   counts behind it.
 */
export function matchupRaceStatus(sport) {
    const { state, days = 0, unknown = 0, missing = [] } = buildMatchupRace(sport);
    return { state, days, unknown, missing };
}

function buildMatchupRace(sport) {
    const key = currentLeagueKey();
    const { matchup, periods } = matchupLineupPeriods();
    if (!key || !periods.length) return { state: 'none' };
    if (!matchupLineups || matchupLineups.key !== key || matchupLineups.matchup !== matchup) {
        return { state: matchupLineupsFailedKey === key ? 'failed' : 'loading' };
    }

    const dailyByPlayer = new Map();
    const starting = startingSlotsForLeague(sport);
    Object.values(matchupLineups.days).forEach(teams => (teams || []).forEach(t => (t.entries || []).forEach(e => {
        if (!starting.has(e.slot) || dailyByPlayer.has(e.p)) return;
        const days = matchupDaysFor(e.p);
        if (days) { dailyByPlayer.set(e.p, days); return; }
        // A started player the pool says has NEVER played this season has no line to wait for, and the harvest rightly never asks for one: a known player with no days.
        const inPool = (AppState.playerData || []).find(p => p.id === e.p);
        if (inPool && !Object.keys(inPool.seasonTotals || {}).length) { dailyByPlayer.set(e.p, {}); return; }
        // Asked for, settled, and the response held nothing for the player, so there is no line to wait for. Only once it has settled; while it runs the player is unknown.
        if (matchupDaysAsked.ids.has(e.p) && !bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) dailyByPlayer.set(e.p, {});
    })));

    // The seat's role decides what a started player is credited with: seatRuleFor, above.
    const countsFor = seatRuleFor(sport);
    const sums = startedDaySums({
        rosterDays: matchupLineups.days, startingSlots: starting, dailyByPlayer, periods,
        teamIds: AppState.teamStats.map(t => t.id), countsFor
    });
    const counts = { days: sums.periods.length, unknown: sums.unknown.length, missing: sums.missing };
    if (sums.unknown.length) return { state: bulkWeeklyFetchFailed ? 'failed' : 'loading', ...counts };
    if (sums.periods.length < 2) return { state: 'short', ...counts };

    const byTeam = new Map();
    sums.byTeam.forEach((dailyForTeam, teamId) => {
        byTeam.set(teamId, aggregateDailyCumulative(dailyForTeam, sums.periods, sport).map(d => d.totals));
    });
    return { state: 'ready', ...counts, series: { periods: sums.periods, byTeam, matchup, missing: sums.missing } };
}

/**
 * Says whether roto windows are available at all, meaning the started tier landed and produced
 * weeks. The timeframe row decides once from this, so the options do not appear and disappear while
 * the harvest loads.
 * @param {string} sport The sport key.
 * @returns {boolean} True when windows can be offered.
 */
export function rotoWindowsAvailable(sport) {
    const acc = rotoStartedSums(sport);
    return !!(acc && acc.weeks.length > 0);
}
/**
 * Returns the race's last week, the maximum the "last N weeks" windows count back from. Roto has no
 * matchup periods, so windows are day buckets grouped to weeks.
 * @param {string} sport The sport key.
 * @returns {number} The last week, or 0 when the started tier is not available.
 */
export function rotoWindowMaxWeek(sport) {
    const acc = rotoStartedSums(sport);
    return acc && acc.weeks.length ? acc.weeks[acc.weeks.length - 1] : 0;
}

/**
 * Returns the active roto window as weeks, or null for the full season, which shows ESPN's official
 * standings verbatim, or when the started tier is not available. Only "last N" options resolve to a
 * window.
 * @param {string} sport The sport key.
 * @returns {{start: number, end: number}|null} The window.
 */
export function activeRotoWindow(sport) {
    if (!AppState.isRotoLeague) return null;
    const n = parseTimeframe(AppState.timeframe).window;
    if (!n) return null;
    const acc = rotoStartedSums(sport);
    if (!acc || acc.weeks.length === 0) return null;
    const maxWeek = acc.weeks[acc.weeks.length - 1];
    return { start: Math.max(acc.weeks[0], maxWeek - n + 1), end: maxWeek };
}

// Per-category cumulative weekly values for the category race, off the same started-day sums as the windowed standings, so a race and its ranking bar cannot disagree. Rates are derived from summed components at each step. It is null when there is no honest race, which is when the started tier is missing or the window is one week. It is memoized by league, cache size and window.
let rotoCatSeriesCache = null;
/**
 * Returns the per-category cumulative series for the category race.
 * @param {string} sport The sport key.
 * @returns {{weeks: number[], byTeam: Map<number, Object[]>}|null} The window's weeks and each
 *   team's values accumulated through each week, or null when there is no honest race.
 */
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

// Rescores the categories over only the window's accumulated started-day components, then runs the same scoring the race uses. It yields the points by team, the category values by team for the heatmap and the points by category for the rankings, or null when the started tier is missing. It is memoized by league, cache size and window. The full-season window reproduces the race's final.
let rotoWindowResultCache = {};
/**
 * Scores a roto window, a week range of the started-day sums, with the same pure scoring the race
 * uses.
 * @param {string} sport The sport key.
 * @param {number} startWeek First week of the window.
 * @param {number} endWeek Last week of the window.
 * @returns {{pointsByTeam: Map<number, number>, catValuesByTeam: Map<number, Object>,
 *   pointsByStatByTeam: Map<number, Object>}|null} The window's points and values, or null when the
 *   started tier is not available.
 */
export function computeRotoWindow(sport, startWeek, endWeek) {
    const acc = rotoStartedSums(sport);
    if (!acc) return null;
    const cacheId = `${acc.key}:${acc.cacheSize}:${startWeek}:${endWeek}`;
    if (rotoWindowResultCache[cacheId]) return rotoWindowResultCache[cacheId];

    const inverseSet = leagueInverseIds(sport);
    const categories = Array.from(AppState.scoredStatIds).map(id => ({ id, inverse: inverseSet.has(id) }));
    const catValuesByTeam = new Map();
    const scoreInput = AppState.teamStats.map(t => {
        const values = aggregateStatsForWeekRange(acc.teamWeeklySums.get(t.id), startWeek, endWeek, sport);
        catValuesByTeam.set(t.id, values);
        return { id: t.id, values };
    });

    // Per-category points summed into each team's total. This is the scoring function's own loop that also records the per-category split the category rankings need, so the totals always match.
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
    rotoWindowResultCache = { [cacheId]: result }; // keep only the latest window, since one is displayed at a time
    return result;
}

// Builds the day-by-day roto standing across the current week, or null when there is nothing honest to draw. It returns the weekly race's shape with a smaller bucket, so the renderer only has to label an axis of days.
function buildRotoDailyRace(sport, categories) {
    if (!categories.length) return null;
    // Already cumulative within the week and already rate-corrected, since the daily series derives a rate from summed components at each day.
    const daily = rotoCategoryDailySeries(sport);
    if (!daily) return null;

    const seriesByTeam = new Map(AppState.teamStats.map(t => [t.id, []]));
    daily.periods.forEach((period, i) => {
        // Every team is scored against every other team on that day, which makes this a standing and not a set of running totals. A team can gain points on a day it did not play.
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

/**
 * Builds the roto race, crediting each player's stats to a team over time, accumulating each team's
 * category values, scoring them roto-style across teams and recording each team's running total. It
 * is the one place roto points are computed and not read from ESPN. There are three crediting modes
 * in a fallback ladder. Started credits each day to whoever had the player in a starting slot.
 * Rostered credits each week to whoever rostered the player mid-week. Current credits the player's
 * current team throughout. It reads whatever the caches hold, so a half-loaded pool renders a
 * rougher race that fills in as chunks land.
 * @param {string} sport The sport key.
 * @returns {{weeks: number[], seriesByTeam: Map<number, Object[]>, categoryCount: number, teams:
 *   {id: number, name: string}[], mode: string}} The race, with the crediting mode so the caller
 *   picks the matching subtitle.
 */
export function buildRotoRaceSeries(sport) {
    const inverseSet = leagueInverseIds(sport);
    const categories = Array.from(AppState.scoredStatIds).map(id => ({ id, inverse: inverseSet.has(id) }));
    const teamIdSet = new Set(AppState.teamStats.map(t => t.id));

    const leagueKey = currentLeagueKey();
    // Hold one loading state until the best expected tier is complete, then draw once. Returning early also skips an accumulation that would be thrown away.
    if (rotoRaceDataPending()) {
        return { weeks: [], seriesByTeam: new Map(), categoryCount: categories.length, teams: [], mode: 'loading', loading: true };
    }

    const snapData = AppState.rosterSnapshotData;
    const txData = AppState.rosterTransactionData;
    const useSnapshots = !!(snapData && snapData.key === leagueKey);
    const useTimeline = !useSnapshots && !!(txData && txData.key === leagueKey);
    const mode = useSnapshots ? 'started' : (useTimeline ? 'rostered' : 'current');

    // At the current window the race runs across days. A one-week window would draw every team as a single dot, and days are the honest bucket at that width. The started tier already holds the daily lines, so this costs no request. It uses the same scoring as the weekly race. It falls through to the weekly path when no daily series exists.
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

    // Accumulates into a shared week-to-sums structure per team, so the cumulative scoring is identical for all three modes. They differ only in which team a slice of stats credits.
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
        // Started tier. It folds in the shared per-team week sums that the windowed standings read, so the race's cumulative points and any window's points come off the same components. Each bucket is already aggregated, so crediting it once reproduces the per-day loop.
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

    // A "last N weeks" option re-bases the race onto that window. Only the window's weeks are drawn and each cumulative starts from the window's first week, so the final point is the windowed standings. A full-season window keeps the whole-season race. Windows exist only on the started tier.
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

/**
 * Clears this module's per-league caches and sticky flags on a new league or season fetch. The
 * failed flag goes so a previous failure cannot block the new league. The drill-down diagnostics go
 * because they are keyed by player id alone and a player's payload differs by season.
 * @returns {void}
 */
export function resetLeaderboardWeeklyFetchState() {
    bulkWeeklyFetchFailed = false;
    // The one place this resets now, a genuine league switch. The two bulk-fetch entry points accumulate across runs, so a batter run and a later pitcher run both survive in the same debug context.
    weeklyPoolEnvelope = null;
    weeklyPoolPlayers = new Map();
    clubFold = null;
    Object.keys(playerDetailDiagnostics).forEach(id => delete playerDetailDiagnostics[id]);
    // Both harvests are per league+season; clear the sticky in-flight/failed flags so the new league can harvest its own (the cached data itself is key-guarded, but the flags aren't).
    rosterHarvestInFlightKey = null;
    rosterHarvestFailedKey = null;
    snapshotHarvestInFlightKey = null;
    snapshotHarvestFailedKey = null;
    matchupLineups = null;
    matchupLineupsInFlightKey = null;
    matchupLineupsFailedKey = null;
    matchupDaysAsked = { stamp: null, ids: new Set() };
    AppState.rosterTransactionData = null;
    AppState.rosterSnapshotData = null;
    // Windowed-roto memoization is keyed by league and cache size, but the snapshot data it reads is cleared above, so the derived caches are dropped too.
    rotoStartedSumsCache = null;
    rotoWindowResultCache = {};
    rotoCatSeriesCache = null;
}

/**
 * Resets leaderboard view state that is invalid for a new league. A stat-id sort points at a column
 * another sport lacks, and a position code is sport-specific, so one carried across sports empties
 * the leaderboard. Only what is invalid is reset, so a same-league refresh keeps the user's sort
 * and filter.
 * @returns {void}
 */
export function normalizePlayerViewStateForLeague() {
    // Runs from the data pipeline after the loaded sport is set, so the state is judged against the league that just landed and not the form.
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};

    const sortStat = AppState.playerSortStat;
    // The matchup-rank sort stays valid across a league switch even where the new league cannot support it. The sort degrades to a no-op ordering when the ranks are null, instead of crashing.
    const universalSortKeys = new Set(['name', 'teamName', 'positionName', 'gp', 'ip', 'matchupRank']);
    let sortValid;
    if (universalSortKeys.has(sortStat)) sortValid = true;
    else if (sortStat === 'total') sortValid = AppState.isPointsLeague;
    else if (sortStat === 'rotoScore') sortValid = true; // every league type ranks now
    else sortValid = statMap[sortStat] !== undefined; // a stat-id column this sport actually has
    // Rank is the default for every league type. A points league used to default to the raw total back when it had no ranking.
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

// Sorts the leaderboard in place per the current sort selection. The table render and the export model share it, so an export is ordered exactly like the table.
function sortLeaderboardPlayers(players, rotoRanks, sport, wantPitchers = currentGroupIsSecondary(sport), matchupRanks = null) {
    // Defense in depth. The roto score has no data in a points league, and a null dereference here would empty the whole tab, so a bad combination sorts by the points total instead.
    let sortStat = AppState.playerSortStat;
    if (sortStat === 'rotoScore' && !rotoRanks) sortStat = 'total';
    const dir = AppState.playerSortDir === 'asc' ? 1 : -1;
    const stringSortKeys = { name: 'name', teamName: 'teamName', positionName: 'positionDisplay' };
    players.sort((a, b) => {
        // Unranked rows, the zero-games cohort the engine refuses to score, sit below every ranked row whichever column or direction is sorted. Otherwise an ascending sort would float that group to the top.
        if (rotoRanks) {
            const aRanked = rotoRanks.ranks.has(a.id);
            if (aRanked !== rotoRanks.ranks.has(b.id)) return aRanked ? -1 : 1;
        }
        if (stringSortKeys[sortStat]) return a[stringSortKeys[sortStat]].localeCompare(b[stringSortKeys[sortStat]]) * dir;
        // Sorts by the matchup-rank module's wins per week, never the rank number, since a tie shares a rank but the figures still order. A player it could not measure sinks below every measured one in either direction.
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

/**
 * Builds a structured snapshot of the leaderboard as configured, so what exports is what is on
 * screen. The group, search, position filter, sort, minimum-games toggle and timeframe all apply.
 * Innings pitched is exported as decimal innings so a spreadsheet can sum it.
 * @param {boolean} [includeAdvanced] Whether to carry every tracked stat; defaults to the on-screen
 *   Advanced Stats toggle.
 * @returns {Object|null} The export model, or null when the pool, or the weekly data a window
 *   needs, is not loaded.
 */
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
    // Applies the same default-sort normalization the render does, so an export taken before the first render carries the rank and not the old points total.
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

    // Innings pitched is a baseball pitcher column only. Hockey goalies have no innings concept, and football carries no games-played statistic, so the header goes with the values instead of standing over an empty column.
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

/**
 * Offers the leaderboard's own ranking to surfaces that show a rank outside the table. Both role
 * pools are ranked as the table ranks them, with no position filter, so a roster row and the
 * leaderboard row agree. A player the engine will not rank gets an entry with a null rank and the
 * reason, which is different from a player missing from the pool.
 * @param {string} sport The sport key.
 * @returns {Map<string, {rank: number|null, total: number, poolLabel: string}>} Rank data by player
 *   id.
 */
export function rosterRankLookup(sport) {
    const out = new Map();
    if (!AppState.playerDataLoaded) return out;
    const pool = getEffectivePlayerPool(sport);
    // This ranks both groups in one pass, and the group is an argument and not a global that is moved and restored. A global read in between would measure pitchers by the batting games id.
    roleGroupsFor(sport).forEach(group => {
        const wantPitchers = group === 'secondary';
        // The leaderboard ranks on the preseason basis so a projected face shows projected totals. Reading the pool straight gave zeros before a game, so My Team's rank chip disagreed with its roster table. This applies the same basis and swap.
        const basis = preseasonBasisCtx(sport, wantPitchers);
        const groupPlayers = preseasonBasisOf(pool.filter(p => matchesPlayerGroup(p, sport, wantPitchers)), basis);
        if (!groupPlayers.length) return;
        const label = groupLabel(sport, wantPitchers);
        const ranked = computeLeagueRanks(groupPlayers, sport, null, wantPitchers, unknownIdsFor(basis));
        ranked.ranks.forEach((rank, id) => out.set(id, {
            rank, total: ranked.total, poolLabel: label, score: ranked.scores.get(id)
        }));
        // The pool's most-played figure, found once for the group and not once per unranked player: on a 3,000-player baseball pool two thirds are unranked, and each used to walk the pool.
        const maxGames = poolMaxGames(groupPlayers, sport, wantPitchers);
        groupPlayers.forEach(p => {
            if (out.has(p.id)) return;
            out.set(p.id, { rank: null, poolLabel: label, reason: unrankedReason(p, groupPlayers, sport, wantPitchers, maxGames) });
        });
    });
    return out;
}

/**
 * Builds the hindsight module's value map, using the actual line only and never the preseason
 * basis. A hindsight rank is production, and a projection is not. A categories league's value is
 * the same rank score the leaderboard shows. A points league's value is ESPN's own applied total.
 * Rank, total, ties and games come from the retro-basis row, where the tie convention lives.
 * @param {string} sport The sport key.
 * @returns {Map<string, Object>} Value data by player id, in the shape the hindsight module reads.
 */
export function hindsightValuesFor(sport) {
    const out = new Map();
    if (!AppState.playerDataLoaded) return out;
    // The season pool, never the windowed one. How picks have fared is a question of the season, and the timeframe selector is not shown on the Draft tab.
    const pool = AppState.playerData || [];
    roleGroupsFor(sport).forEach(group => {
        const wantPitchers = group === 'secondary';
        const groupPlayers = pool.filter(p => matchesPlayerGroup(p, sport, wantPitchers));
        if (!groupPlayers.length) return;
        const ranked = computeLeagueRanks(groupPlayers, sport, null, wantPitchers);
        groupPlayers.forEach(p => {
            // NULL where the sport has no games stat, and it has to be said twice: gamesPlayedOf answers null, and seasonRowFrom (retro-basis.js) turns a non-finite games into 0 for its own band. A 0 here read as "has not played" on every football pick.
            const games = gamesPlayedOf(p, sport, wantPitchers);
            const row = seasonRowFrom(ranked, p.id, { seasonId: AppState.apiData?.seasonId ?? null, games });
            if (!row) return;
            // A rank read from zero games is a tie of nothing dressed as a result. With nobody played yet the engine excludes no one and every player ties, so these picks are ungraded. A points league in a sport with no games stat asks the same question of the applied average instead.
            const ungraded = AppState.isPointsLeague && !GAMES_PLAYED_IDS[sport]
                ? !(Number(p.appliedAverage) > 0)
                : !(games > 0);
            const value = ungraded ? null
                : (AppState.isPointsLeague ? (Number(p.appliedTotal) || 0) : (ranked.scores.get(p.id) ?? null));
            out.set(String(p.id), {
                value,
                rank: ungraded ? null : row.rank,
                total: row.total,
                tied: ungraded ? false : row.tied,
                games: (ungraded || games === null) ? null : row.games
            });
        });
    });
    return out;
}

/**
 * Returns the pacing function for the hindsight module. A caller pacing against a preseason
 * snapshot passes that snapshot's line as the projected totals, as the draft board's frozen-basis
 * branch does. With no snapshot the closure always answers null, so no lookup is wasted.
 * @param {string} sport The sport key.
 * @returns {function(string): (Object|null)} Pacing for a player id, or null when there is no
 *   snapshot.
 */
export function hindsightPacingFor(sport) {
    const snapshot = currentPreseasonSnapshot();
    if (!snapshot) return () => null;
    // The season pool, for the same reason as the values map. A pace against the preseason line is a season figure.
    const pool = AppState.playerData || [];
    const byId = new Map(pool.map(p => [String(p.id), p]));
    const statMap = ESPN_STAT_MAPS[sport] || {};
    return (playerId) => {
        const p = byId.get(String(playerId));
        if (!p) return null;
        const preLine = preseasonLineFor(snapshot, playerId);
        if (!preLine) return null;
        const wantPitchers = matchesPlayerGroup(p, sport, true);
        const gpIds = GAMES_PLAYED_IDS[sport];
        const gamesId = gpIds ? gpIds[wantPitchers ? 'secondary' : 'primary'] : null;
        const remaining = remainingAppearancesFor(p, gamesId);
        const scored = Array.from(AppState.scoredStatIds || []);
        return projectionPacing({ ...p, projectedTotals: preLine }, {
            scoredIds: scored,
            gamesId,
            gamesRemaining: remaining === null ? undefined : remaining,
            rateIds: AVERAGE_STATS[sport] || new Set(),
            inverseIds: leagueInverseIds(sport),
            isPointsLeague: AppState.isPointsLeague,
            weights: AppState.scoringWeights,
            statLabels: statMap,
            seasonId: AppState.apiData?.seasonId ?? null
        });
    };
}

// How many rows get a photo. It is every roster seat the league allows times the number of teams, which is the last pick of a draft, and everyone below gets the initials tile with no image request. It applies to displayed position and not rank, so a re-sort does not thrash the cache. The arithmetic is a copy of the draft view's, because importing it would close a cycle.
const PHOTO_ROWS_FLOOR = 50;

function photoRowBudget() {
    const settings = AppState.apiData?.settings || {};
    const counts = settings.rosterSettings?.lineupSlotCounts || {};
    const perTeam = Object.keys(counts).reduce((sum, id) => sum + Math.max(0, Number(counts[id]) || 0), 0);
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    // A league that reports neither still shows photos where the eye is, rather than none at all.
    return Math.max(PHOTO_ROWS_FLOOR, perTeam * teams);
}

// ==== The leaderboard row model ====

// The pro club, from the abbreviation table the app already holds. It is null when the pro-team schedule is not in this session's cache, so the identity line reads without a dangling separator. The club map in the player-id module is the wrong table, since it covers hockey only and exists to join ids.
function proAbbrevOf(p, abbrevs) {
    if (!abbrevs || p.proTeamId == null) return null;
    return abbrevs.get(Number(p.proTeamId)) || null;
}

// Returns the games label, or null to drop the segment. Null is the honest answer for football, which carries no games-played statistic.
function gpLabelFor(p, ctx) {
    if (!ctx.showGames) return null;
    const games = gamesPlayedOf(p, ctx.sport, ctx.wantPitchers);
    if (games === null || games === undefined) return null;
    return `${formatStatValue(games)} GP`;
}

// Fantasy points per game for points leagues only. It is ESPN's own average and not a division done here, which lets football have the column, and it was checked to be per game played. A zero average reads as absent, since it cannot separate never played from scored nothing. The season total prefers the engine's score and falls back to the raw applied total.
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

// One cell per shown category. The percentile comes from the engine's own per-category map and passes through untouched, since it already reads high-is-good for an inverse category. A points league carries a second roto-style pass used for the tint alone. The estimated flag is always false here, because this surface prints real totals, and it is still emitted because the shape is fixed.
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

// Returns the rank, or null for a player the engine will not rank. Unranked is common with Minimum Games off. The tied flag is always false, because the engine assigns strictly sequential positions.
function rankOf(p, ctx) {
    const label = ctx.rotoRanks && ctx.rotoRanks.ranks.get(p.id);
    if (label === undefined || label === null) return null;
    return { label, tied: false, gold: label === 1 };
}

// Returns the matchup rank, or null for a player the module could not measure. Unlike the main rank, a tie is a real state here, since ranks are competition ranks, and the tie counts are computed once per render.
function matchupRankOf(p, ctx) {
    if (!ctx.matchupRanks) return null;
    const entry = ctx.matchupRanks.byId[p.id];
    if (!entry) return null;
    const tied = (ctx.matchupRankTieCounts.get(entry.rank) || 0) > 1;
    return { winsPerWeek: entry.winsPerWeek, rank: { label: entry.rank, tied } };
}

/**
 * Returns the rostered share, or null when the column is filler. ESPN collapses the figure out of
 * season as it does ADP, so the column runs through the draft board's degenerate test. Only rows
 * carrying the filler value go null.
 * @param {Object[]} players The players in view.
 * @returns {number|null} The filler value that more than a third of the pool shares, or null when
 *   there is none.
 */
export function rosteredFillerFor(players) {
    return degenerateValue((players || []).map(p => Number(p.rosterPct)).filter(Number.isFinite));
}

function rosteredOf(p, ctx) {
    const pct = Number(p.rosterPct);
    if (!Number.isFinite(pct)) return null;
    if (ctx.rosteredFiller !== null && ctx.rosteredFiller !== undefined && pct === ctx.rosteredFiller) return null;
    return { pct, change: Number(p.rosterChange) || 0 };
}

// The league's playoff rounds and how many games each club plays in them, memoized on the league payload and cached schedule, because the walk is every club's season. It lives here because the draft board's hover and the leaderboard's playoff lens both read it and a view must not import another view.
let playoffDensityCache = { key: null, rows: null };
/**
 * Returns the league's playoff rounds and how many games each club plays in them, or null when
 * there is no schedule, no bracket or the league has none. The result is memoized on the league
 * payload and cached schedule.
 * @returns {Object[]|null} The per-round density rows, or null.
 */
export function playoffDensityRows() {
    const data = currentProSchedule();
    const league = AppState.apiData;
    if (!data || !league || !league.schedule) return null;
    // The cache key is the league and nothing else. The league id and season pin what the schedule store's own key used to stand for.
    const key = `${league.id}|${league.seasonId}`;
    if (playoffDensityCache.key === key) return playoffDensityCache.rows;

    // The league's OWN playoff matchups, off playoffTierType. A roto league has none, a league whose bracket ESPN has not drawn yet has none, and in both cases the honest board says nothing rather than inventing rounds from the settings.
    const matchups = playoffMatchups(league.schedule);
    let rows = null;
    if (matchups.length) {
        // Days come from the league's own schedule, never the settings' matchup periods, which hold week indices and would be wrong by a factor of seven.
        const map = buildMatchupPeriodMap(league.schedule, league.status, league.settings);
        rows = densityAcrossMatchups((data.settings || {}).proTeams,
            matchups.map(m => ({ matchup: m, periods: periodsOfMatchup(map, m) })));
    }
    playoffDensityCache = { key, rows };
    return rows;
}


// A player's projected line per game. Only counting totals are divided, because a projected rate is already per game. It is null when the projection carries no games, since inventing a denominator lets a partial projection outrank a full one.
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

/**
 * Reports why the tab bar's Next and Rest options are or are not available, before any leaderboard
 * render has happened. It is a lean existence check over the same schedule atoms the time-lens
 * context uses, so the two cannot drift. Next is a structural question a roto league can never
 * answer yes to, so its reason is unconditional there. Rest needs no matchup, so it asks the
 * ordinary schedule question for every league type. The full time-lens context is computed once per
 * render, since every part of it is a whole-pool or whole-league answer.
 * @returns {{next?: string, rest?: string}} A reason for each option that is unavailable; an absent
 *   key means available.
 */
export function aheadReasons() {
    const reasons = {};
    if (AppState.isRotoLeague) reasons.next = 'This league has no matchups.';

    // A season that is over is knowable without the pro schedule, so it is asked first. Asking after the schedule check left both options live on a finished league, where the schedule loads after the row is drawn.
    const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
    const final = finalScoringPeriodOf(AppState.apiData);
    if (todayPeriod && final && final < todayPeriod) {
        const over = 'No games left this season.';
        reasons.next = reasons.next || over;
        reasons.rest = over;
        return reasons;
    }

    const scheduleAttempted = proScheduleAttempted();
    const schedules = currentProSchedule();
    if (scheduleAttempted && !schedules) {
        if (!reasons.next) reasons.next = 'Schedule not loaded.';
        reasons.rest = 'Schedule not loaded.';
        return reasons;
    }
    if (!scheduleAttempted) return reasons;
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    const map = matchupPeriodMap();
    const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
    if (!AppState.isRotoLeague) {
        const hasNext = !!(proTeams && map && current != null && periodsOfMatchup(map, current + 1).length);
        if (!hasNext) reasons.next = 'No matchup after this one.';
    }
    const hasRest = !!(proTeams && todayPeriod && final && final >= todayPeriod);
    if (!hasRest) {
        reasons.rest = 'No games left this season.';
        return reasons;
    }
    // The playoffs are the rest of the season, so offering to project them offers a view the reader already has. It reads the league's own playoff tier for the matchup being played, never the settings, which count weeks and do not name rounds.
    if (!AppState.isRotoLeague && current != null && inPlayoffMatchup(current)) {
        reasons.rest = 'The playoffs are the rest of the season.';
    }
    return reasons;
}

// Whether the matchup being played is a bracket round. PURE-ish: the league payload's own schedule, nothing derived and nothing from settings.
function inPlayoffMatchup(matchup) {
    const schedule = (AppState.apiData && AppState.apiData.schedule) || [];
    return schedule.some(g => g && g.matchupPeriodId === matchup
        && g.playoffTierType && g.playoffTierType !== 'NONE');
}

function timeLensContext(players, sport, wantPitchers, statIds) {
    const schedules = currentProSchedule();
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    const rateIds = new Set([...(AVERAGE_STATS[sport] || new Set())].map(String));
    const gamesId = gamesIdFor(sport, wantPitchers);
    const playoffRows = playoffDensityRows();

    // The window line rank. A points league ranks the window by one number. A category league has none, so each player's projected line over the window is ranked against the others through the engine's percentile. It needs the schedule's games per club, so it is absent with the schedule.
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
            inverseIds: leagueInverseIds(sport),
            rateIds
        });
    }

    // This matchup and the next one. The days come from the league's own schedule through the matchup periods, never the settings' matchup periods, which hold week indices.
    const map = matchupPeriodMap();
    const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
    const labelOf = schedules ? dayLabelerFor(datesByScoringPeriod(schedules)) : null;
    // A club's own game day for a period longer than a day, such as a football week, formatted as the weekday of the game's own timestamp.
    const labelOfDate = (ms) => new Date(Number(ms)).toLocaleDateString(undefined, { weekday: 'short' });

    // Finds who is a starting pitcher and how far ahead ESPN has listed, in one pass over the pool's probable listings so the two cannot drift. A player with a probable anywhere this season is a starter, which separates a rotation from a bullpen without a stat id. The horizon is the furthest day any probable falls on. A window ending past it cannot be counted in starts.
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
    // The density feeds the off-night count, which is the league-wide count of clubs that play each day over the same days the window covers. Each lens carries the starts ESPN has listed inside its own days and the last day it covers, so the row can decide whether the window may be counted in starts.
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
    // Rest of season. It uses no new data, since the games-by-club function takes any list of days and the list is today through the final scoring period. The matchup stays null because a rest window spans every remaining round.
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
        labelOfDate,
        todayPeriod,
        window: windowLens,
        next: buildLens(current === null ? null : current + 1),
        rest: buildRestLens(),
        starterIds,
        probableHorizon,
        // Empty nights is the leaderboard's reading of the free-agent half of the open-seat question. It covers this matchup only, because the question is who fills tonight's hole, so this lens has no choice of span.
        openSeatsCoverage: myOpenSeatsCoverage(sport, wantPitchers, windowLens),
        openSeatsProTeams: proTeams,
        proTeams: proTeams || null
    };
}

// Works out which nights the reader's own lineup is empty, once per render and the same way My Team's nights band does, with the same seat capacity and coverage function. It is hockey only, since only there do clubs play different nights, and covers this matchup's days.
function myOpenSeatsCoverage(sport, wantPitchers, windowLens) {
    if (sport !== 'fhl' || !windowLens) return null;
    const proTeams = currentProSchedule()?.settings?.proTeams;
    if (!proTeams) return null;
    // The lens uses the same team resolution My Team does, including its stand-in when no id matches, so the two cannot disagree about whether a lineup exists.
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

// Gives the playoff window for one player with the rank the category-league lens is ordered by. The projected figure stays null in a category league, which has no single per-game number, and the rank stays null in a points league.
function playoffRowFor(p, ctx) {
    const out = playoffOutlook(ctx.playoffRows, p.proTeamId, {
        perGame: ptsPerGameOf(p, ctx),
        trend: ctx.trendIcons?.get(p.id)?.dir || null
    });
    if (!out) return null;
    out.rank = (ctx.lens && ctx.lens.playoffRanks.get(p.id)) || null;
    return out;
}

// Builds one matchup's window for one player. The starts figure is a role fact, so a pitcher with a probable listing has a count and everyone else has null, not zero. A starting pitcher's window counts starts and not club games, but only when the player is a starter and ESPN has listed every day the window covers. Everyone else keeps games.
function lensRowFor(p, ctx, lens) {
    if (!lens) return null;
    // The start counter keys its entry as starts, remaining and games, and the row contract names the pair total and remaining. The names are adapted here at the seam instead of widening either side.
    const listing = (lens.startsByPlayer && lens.startsByPlayer.get(p.id)) || null;
    const starts = listing ? { total: listing.starts, remaining: listing.remaining } : null;
    const listed = ctx.lens.probableHorizon !== null && ctx.lens.probableHorizon !== undefined
        && Number.isFinite(lens.end) && lens.end <= ctx.lens.probableHorizon;
    return matchupWindow(lens.byTeam, p.proTeamId, {
        matchup: lens.matchup,
        periods: lens.periods,
        labelOf: ctx.lens.labelOf,
        labelOfDate: ctx.lens.labelOfDate,
        fromPeriod: ctx.lens.todayPeriod,
        starts,
        countStarts: !!(starts && listed && ctx.lens.starterIds && ctx.lens.starterIds.has(p.id)),
        density: lens.density
    });
}

// The fantasy team that has this player: its logo, which goes through the image host rule, its legend colour and its full name for the hover. It is null for a free agent, which draws nothing. The team marks are a Map of team id to logo, colour and name, built once per render, and an absent map means no mark.
function teamMarkOf(p, ctx) {
    if (p.teamId == null || !ctx.teamMarks) return null;
    const t = ctx.teamMarks.get(p.teamId);
    if (!t) return null;
    return { name: t.name || null, color: t.color || null, logo: isAllowedLogoUrl(t.logo) ? t.logo : null };
}

/**
 * Builds one leaderboard row to the frozen row contract. Every input arrives through the context
 * and nothing is read from application state here, so the model can be tested against a hand-built
 * context.
 * @param {Object} p The processed player.
 * @param {Object} ctx The render context, carrying the ranks, the basis, the lens, the team marks,
 *   the pro-club abbreviations and the display options.
 * @returns {Object} The row model the leaderboard row builder renders.
 */
export function buildLeaderboardRowModel(p, ctx) {
    const model = {
        id: p.id,
        name: p.name,
        team: teamMarkOf(p, ctx),
        proAbbrev: proAbbrevOf(p, ctx.abbrevs),
        posLabel: p.positionDisplay,
        gpLabel: gpLabelFor(p, ctx),
        injuryStatus: p.injuryStatus || null,
        // Suppressed before the draft, where nobody has been picked and the chip would sit on every row. The caller says so, and this function stays a truthful "no team" otherwise.
        isFreeAgent: ctx.suppressFreeAgentChip ? false : !p.teamId,
        rank: rankOf(p, ctx),
        matchupRank: matchupRankOf(p, ctx),
        total: totalOf(p, ctx),
        ptsPerGame: ptsPerGameOf(p, ctx),
        cells: cellsFor(p, ctx),
        rostered: rosteredOf(p, ctx),
        // The playoff lens. It is null when the league has no bracket drawn, the pro schedule is not in this session, or the player has no club the schedule knows, and never a zero line.
        playoff: playoffRowFor(p, ctx),
        // This matchup and the one after it use the same builder, since they are the same question asked of two windows. A null omits that lens's column.
        window: lensRowFor(p, ctx, ctx.lens?.window),
        next: lensRowFor(p, ctx, ctx.lens?.next),
        // Rest of season, built by the rest lens in the time-lens context.
        rest: lensRowFor(p, ctx, ctx.lens?.rest),
        // The open-seat function itself refuses for a rostered player, so the refusal is exercised here and the rule lives in one place.
        openSeats: openSeatNights(p, ctx.lens?.openSeatsProTeams, ctx.lens?.openSeatsCoverage, {
            isFreeAgent: ctx.suppressFreeAgentChip ? false : !p.teamId
        })
    };
    // Only a points league draws the next game, so a category league's model keeps the shape it had.
    if (ctx.isPointsLeague) model.nextGame = nextGameFor(p, ctx);
    return model;
}

/**
 * The next game a points row prints, from the pro schedule already in memory: the club's earliest game
 * in this matchup's days that has not started, or null for a dash.
 *
 * @param {Object} p The pool player.
 * @param {Object} ctx The render context; reads its lens (window periods, pro teams) and an optional now.
 * @returns {?{opponent: string, away: boolean, when: string}} The cell, or null.
 */
function nextGameFor(p, ctx) {
    const lens = ctx.lens;
    if (!lens || !lens.window || !lens.proTeams) return null;
    const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
    // This matchup's days and then the next matchup's, so a club with no game left today still has a next game.
    const periods = lens.window.periods.concat((lens.next && lens.next.periods) || []);
    return nextGameCell(nextGameOf(p, lens.proTeams, periods, { now, dayLabelOf: gameDayTime }));
}

/**
 * Renders the Player Metrics leaderboard into its container from the current state, which covers
 * the group tab, search, position and availability filters, sort, timeframe, lens and toggles. It
 * starts the pool and weekly fetches that the visible columns need, and paints a static loading
 * line while the pool is absent.
 * @returns {void}
 */
export function renderPlayerLeaderboard() {
    const container = document.getElementById('player-leaderboard-container');
    if (!container) return;

    // The club shows on load. The pro schedule is one cached request per league per session, fetched here because until it arrived there was no club, crest or pro chip on the strip. Calling it on every render is cheap: it dedupes by league key, re-renders the table itself when the answer lands, and remembers a failed fetch so a league ESPN will not answer for is asked once.
    ensureProScheduleData();

    // Every column is a category and the rank is an average over them. Without validated ids the app cannot name a column or tell a rate from a counting stat, so the scoring is hidden. The pool still loads and the capture still downloads.
    if (!categoriesMapped(AppState.loadedSport)) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(unmappedCategoriesNote(AppState.loadedSport))}</div>`;
        const toggle = document.getElementById('player-group-toggle');
        if (toggle) { toggle.innerHTML = ''; toggle.style.display = 'none'; }
        return;
    }

    // Returning silently here left whatever was painted, which after a league switch is the previous league's rows. Painting the loading state means no caller can leave another league's players visible. It is a static line and not the animated bar, because this function runs on every keystroke and repeat calls would stack timers. It yields to a progress bar already running. No fetch starts here.
    if (!AppState.playerDataLoaded) {
        const playerView = document.getElementById('view-player');
        const onScreen = playerView && playerView.style.display !== 'none';
        if (onScreen && !container.querySelector('.player-loading, .player-loading-progress, .sk-wrap')) {
            container.innerHTML = buildSkeletonHtml('lb');
        }
        return;
    }

    // The loaded league's sport, never the dropdown's. Every stat map and role group below keys off it, so reading the form re-rendered the pool under another sport's rules. The dropdown is an input for the next fetch, not state.
    const sport = AppState.loadedSport;
    renderGroupToggle(sport);
    // The identity column is sized to this sport's longest real name. The property is set on the viewport itself, the inheritance root for both the sticky header and every row, so one assignment reaches both.
    if (LB_IDENTITY_W[sport]) container.style.setProperty('--lb-identity-w', `${LB_IDENTITY_W[sport]}px`);
    else container.style.removeProperty('--lb-identity-w');

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
    // Innings pitched is a baseball pitcher column only, since hockey goalies have no innings. Football carries no games-played statistic, so the header goes with the values instead of standing over an empty column.
    const showGames = gamesPlayedKnown(sport);
    const showInnings = wantPitchers && sport === 'flb';
    // Preseason ranks and shows projections. The basis is applied to the pool itself, so the rank and the totals beside it come from one line.
    const basis = preseasonBasisCtx(sport, wantPitchers);
    const groupPlayers = preseasonBasisOf(getEffectivePlayerPool(sport), basis)
        .filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const { scored, advanced } = statIdsForGroup(sport, activeGroupFor(sport), groupPlayers);
    const statIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;

    const query = AppState.playerSearchQuery.trim().toLowerCase();
    const posFilter = AppState.playerPositionFilter;

    // The team tabs read before the breakout filter, so a search or availability filter that leaves three players offers tabs for those players' teams and not the whole league.
    const preBreakoutPlayers = groupPlayers.filter(p => {
        if (query && !p.name.toLowerCase().includes(query)) return false;
        if (posFilter !== 'ALL' && !matchesPositionFilter(p, posFilter)) return false;
        if (!matchesAvailability(p)) return false;
        return true;
    });
    renderBreakoutTabs(preBreakoutPlayers);

    let players = preBreakoutPlayers.filter(p => matchesBreakout(p));

    // The total, ESPN's real applied total, exists only for points leagues. Category leagues get a computed roto-style rank, since ESPN's raw points figure is a generic formula. It ranks against all batters or pitchers by default and against the filtered position when one is selected, because a best-shortstop rank only means something against other shortstops.
    const rankPool = posFilter !== 'ALL' ? groupPlayers.filter(p => matchesPositionFilter(p, posFilter)) : groupPlayers;
    const rotoRanks = computeLeagueRanks(rankPool, sport, posFilter, wantPitchers, unknownIdsFor(basis));
    // A points league's cells are untinted because the points ranking has no per-category percentile. A stat's percentile in the pool is a fact about the pool, so a second roto-style pass supplies it, and only its per-category map is read.
    const categoryTintRanks = AppState.isPointsLeague
        ? computeRotoRanks(rankPool, sport, posFilter, wantPitchers, unknownIdsFor(basis))
        : rotoRanks;

    // The matchup column is computed once per render. Its pool is the one the overall rank is scoped to, narrowed to the players the engine ranked, so a rank of N means the same N in both columns. The league margins refuse cheaply for roto, points and too few matchups, so no format guard is needed here.
    const matchupCtx = matchupRankCtxFor(rankPool, sport, wantPitchers);
    const matchupRefusal = leagueMargins(AppState.apiData, matchupCtx);
    const matchupQualifiedPool = rotoRanks ? rankPool.filter(p => rotoRanks.ranks.has(p.id)) : [];
    const matchupRanks = matchupRefusal.margins
        ? computeMatchupRanks(matchupQualifiedPool, matchupRefusal.margins, matchupCtx)
        : null;
    // Ties genuinely happen here, with competition ranks, unlike the overall column's sequential rank. They are counted once so the row builder never rescans the pool.
    const matchupRankTieCounts = new Map();
    if (matchupRanks) {
        Object.values(matchupRanks.byId).forEach(m => {
            matchupRankTieCounts.set(m.rank, (matchupRankTieCounts.get(m.rank) || 0) + 1);
        });
    }
    const showMatchupRank = !!matchupRanks;

    // With Minimum Games on, only players who cleared the threshold show. With it off, the players the engine still will not rank, which is only the zero-games group, are kept and pushed below every ranked row with a dash.
    if (rotoRanks && AppState.requireMinPlayingTime) players = players.filter(p => rotoRanks.ranks.has(p.id));

    renderAdvancedStatsToggle(advanced.length);
    renderMinPlayingTimeToggle(rankPool, sport);
    if (AppState.playerSortStat === 'total') {
        AppState.playerSortStat = 'rotoScore';
    }

    sortLeaderboardPlayers(players, rotoRanks, sport, wantPitchers, matchupRanks);

    // The pick-to-compare group is looked up from the whole role-group pool, before search, position, availability or team narrow it, so the pinned block survives each of those. It is scoped to the current role group. A pick made on batters is hidden on pitchers and restored when switching back.
    const rawGroupIds = AppState.playerCompareGroupIds || [];
    const anchorPresent = rawGroupIds.length > 0 && groupPlayers.some(p => p.id === rawGroupIds[0]);
    const groupIds = anchorPresent ? rawGroupIds.filter(id => groupPlayers.some(p => p.id === id)) : [];
    const groupIdSet = new Set(groupIds);
    let groupResult = null;
    if (groupIds.length) {
        const anchorId = groupIds[0];
        groupResult = comparePlayerGroup(groupPlayers, anchorId, groupIds.slice(1), {
            statIds, inverseStatIds: leagueInverseIds(sport), statMap
        });
    }
    // Inverted from comparePlayerGroup's own row-per-category shape into playerId -> categoryId -> {delta, better}, which is the direction buildLeaderboardRowModel's per-row cells need it in.
    const deltaLookup = new Map();
    if (groupResult && !groupResult.refused) {
        groupResult.ids.forEach(id => deltaLookup.set(id, new Map()));
        groupResult.rows.forEach(row => {
            row.cells.forEach(cell => {
                const m = deltaLookup.get(cell.id);
                if (m) m.set(row.id, { delta: cell.delta, better: cell.better });
            });
        });
    }
    const capReached = groupIds.length >= 1 + PLAYER_GROUP_MAX_OTHERS;

    if (players.length === 0 && !groupIds.length) {
        container.innerHTML = '<div class="player-loading">No players match your search/filter.</div>';
        return;
    }

    const sortArrow = (key) => AppState.playerSortStat === key ? (AppState.playerSortDir === 'asc' ? ' ▲' : ' ▼') : '';

    // Medals for the pool's top three, scoped to the active position filter, plus weekly-form arrows. Both live in the rank column, which points leagues do not have.
    const trendIcons = AppState.isPointsLeague ? new Map() : buildMatchupTrendIcons(players, sport);
    // The time-lens column's whole-pool answers, once per render. The pro schedule it needs is not fetched here, so on a cold session every lens is null and the column is absent.
    const lens = timeLensContext(players, sport, wantPitchers, statIds);
    // Lenses grey with a reason once the schedule attempt has resolved. Before that every lens stays enabled, because the schedule has not been asked for and a reason would be a guess, and disabling on load would block the click that fetches it. The reasons are computed before the rows and header so a fallback is the same ahead state everywhere. The tab bar and this render read the same reasons.
    const lensReasons = aheadReasons();
    // Empty nights greys for three different reasons, told apart. A sport whose clubs play the same nights has no question. A league with no current matchup has no matchup to check. Only once both clear does a missing roster become the answer. It is unaffected by the ahead window, since it is scoped to this matchup.
    if (sport !== 'fhl') {
        lensReasons.openSeats = 'Hockey only - every other sport plays on the same nights.';
    } else if (!lens.window) {
        lensReasons.openSeats = 'No matchup right now to check nights against.';
    } else if (!lens.openSeatsCoverage) {
        lensReasons.openSeats = 'No lineup to compare against yet.';
    }
    // Each choice falls back independently, so a stale next choice on a finished season does not take the empty-nights state down with it.
    if (lensReasons[AppState.ahead]) AppState.ahead = null;
    if (AppState.showEmptyNights && lensReasons.openSeats) AppState.showEmptyNights = false;
    // The resolved lens column. Empty nights applies only when chosen and no ahead window is active, since both name which window, so only one holds the column at a time. It is a measure toggle and not a fourth window state.
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

    // A move under a point in a week is churn and not a trend, so the figure stays off the surface instead of printing a tiny change.
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
        // Not gated by the photo budget. A small logo is a much smaller request than a headshot, and the abbreviation is already text on the row, so the mark repeats the same fact at negligible cost.
        logoHtml: (proAbbrev) => buildProTeamLogoHtml(sport, proAbbrev),
        // A D/ST row's identity swaps to this crest entirely. It uses the club-crest rail's builder at the avatar's own size.
        proTeamCrestHtml: (proAbbrev) => buildProTeamCrestHtml(sport, proAbbrev),
        injuryBadgeHtml,
        sortArrowHtml: sortArrow,
        // The drill-down and the compare picker need a first game to have anything to show, so preseason rows are inert. The flag is the same preseason condition the basis uses.
        interactive: !basis.preseason,
        // The same fractional-versus-integer rule that formats every cell's value formats its delta. A rate's delta is a non-integer float and a counting stat's is whole, so no rate flag is needed.
        formatDelta: (v) => formatStatValue(v)
    });

    // IP is a baseball-pitcher column with no home in the row model, and needs none: the contract's cell value is a preformatted STRING, so the innings formatting is applied here and the cell travels like any other. It leads the cells because that is where the column sat.
    const ipCellFor = (p) => ({
        id: 'ip', label: 'IP', value: formatInnings(p.seasonTotals[IP_STAT_ID]),
        pct: null, estimated: false, inverse: false
    });

    const rawTeamLogos = new Map((AppState.apiData?.teams || []).map(t => [t.id, t.logo]));
    const teamMarks = new Map((AppState.teamStats || []).map(t => [t.id, { name: t.name, color: AppState.teamColorMap[t.id] || null, logo: rawTeamLogos.get(t.id) }]));
    const modelCtx = {
        teamMarks,
        sport, wantPitchers, showGames, isPointsLeague: AppState.isPointsLeague,
        // Before the draft only. The free-agent chip is meaningful again once rosters are real, so this checks the exact state and not the preseason flag, which also covers that later state.
        suppressFreeAgentChip: seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT,
        statIds, statMap, inverseIds: leagueInverseIds(sport),
        // A category's own precision, counting stats as integers and rates as rates.
        rateIds: AVERAGE_STATS[sport] || new Set(),
        // Null when the pro-team schedule is not in this session, so the identity line drops the club segment. It is never fetched from here, only once per session elsewhere.
        abbrevs: currentProSchedule() ? buildProTeamAbbrevs(currentProSchedule()) : null,
        rotoRanks,
        // The tint's own source. In a points league the roto ranks are the real points-based rank the row sorts by, so the tint comes from a second roto-style pass used only for its per-category map. In a category league the two are the same object.
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

    const statsView = pointsStatsViewOn();
    const budget = photoRowBudget();
    let photoIndex = 0;
    // One row builder for both the pinned block and the ranked table below it, so a delta, the anchor tag and the pick control are never a second code path that could draw a player differently depending on which list they came from. The phone points form's figures of the anchor, so a compared row can print how far it is from it.
    const anchorPlayer = groupIds.length ? groupPlayers.find(gp => gp.id === groupIds[0]) : null;
    const figsOf = (m) => ({
        total: m.total !== null && m.total !== undefined && Number.isFinite(Number(m.total)) ? Number(m.total) : null,
        ptsPerGame: m.ptsPerGame !== null && m.ptsPerGame !== undefined && Number.isFinite(Number(m.ptsPerGame)) ? Number(m.ptsPerGame) : null,
        gp: parseInt(m.gpLabel, 10),
        rank: m.rank && Number.isFinite(Number(m.rank.label)) ? Number(m.rank.label) : null
    });
    const anchorFigs = AppState.isPointsLeague && anchorPlayer ? figsOf(buildLeaderboardRowModel(anchorPlayer, modelCtx)) : null;
    // The sign is who is ahead: more points or games than the anchor is up, and a better (lower) rank is up.
    const figDelta = (mine, theirs, digits, rankLike) => {
        if (mine === null || theirs === null || !Number.isFinite(mine) || !Number.isFinite(theirs)) return null;
        const d = rankLike ? theirs - mine : mine - theirs;
        const eps = digits ? 0.5 * Math.pow(10, -digits) : 0.5;
        if (Math.abs(d) < eps) return { delta: 0, better: 'even', text: '' };
        return { delta: d, better: d > 0 ? 'up' : 'down', text: Math.abs(d).toFixed(digits) };
    };
    const rowHtmlFor = (p, pick) => {
        const model = buildLeaderboardRowModel(p, modelCtx);
        if (statsView) delete model.nextGame;
        if (anchorFigs && pick && pick.state === 'picked' && !statsView) {
            const mine = figsOf(model);
            model.figDeltas = {
                total: figDelta(mine.total, anchorFigs.total, 1, false),
                ptsPerGame: figDelta(mine.ptsPerGame, anchorFigs.ptsPerGame, 1, false),
                gp: figDelta(mine.gp, anchorFigs.gp, 0, false),
                rank: figDelta(mine.rank, anchorFigs.rank, 0, true)
            };
        }
        if (showInnings) model.cells.unshift(ipCellFor(p));
        const own = deltaLookup.get(p.id);
        if (own) model.cells.forEach(c => { const d = own.get(c.id); if (d) { c.delta = d.delta; c.better = d.better; } });
        if (pick && pick.state === 'anchor') model.isAnchor = true;
        const html = buildLeaderboardRowHtml(model, rowOpts(photoIndex < budget), resolvedLens, showMatchupRank, pick);
        photoIndex++;
        return html;
    };

    // The pinned block, the anchor first and then every further pick in the order made, each reading its per-category delta against the anchor. It is excluded from the ranked table so nobody repeats in their rank position.
    const groupBlockHtml = groupIds.length ? `<div class="lb-group">
        <div class="lb-group-bar"><span>Comparing <b>${groupIds.length}</b> against ${escapeHtml((groupPlayers.find(p => p.id === groupIds[0]) || {}).name || '')}</span>
            <button type="button" class="lb-group-clear" id="lb-group-clear">Clear</button>
            <button type="button" class="lb-group-compare" id="lb-group-compare">Compare in full &rsaquo;</button>
        </div>
        ${groupIds.map((id, i) => {
            const p = groupPlayers.find(gp => gp.id === id);
            if (!p) return '';
            return rowHtmlFor(p, { state: i === 0 ? 'anchor' : 'picked', number: i + 1 });
        }).join('')}
    </div>` : '';

    const restPlayers = groupIdSet.size ? players.filter(p => !groupIdSet.has(p.id)) : players;
    const rowsHtml = restPlayers.map(p => rowHtmlFor(p, { state: null, capReached })).join('');

    // The phone points form's view control: Points is the only view in this build and Stats is present and inert. Hidden by the stylesheet above 700px.
    const segTab = (view, label) => `<span class="${statsView === (view === 'stats') ? 'lb-seg-on' : 'lb-seg-off'}" role="tab" data-view="${view}" aria-selected="${statsView === (view === 'stats')}">${label}</span>`;
    const viewSegHtml = AppState.isPointsLeague
        ? `<div class="lb-seg" role="tablist" aria-label="Row view">${segTab('points', 'Points')}${segTab('stats', 'Stats')}</div>`
        : '';
    const html = viewSegHtml + `<div class="lb-table${AppState.isPointsLeague && !statsView ? '' : ' lb-table-grid'}${statsView ? ' lb-pts-stats' : ''}">`
        + buildLeaderboardHeaderHtml({
            identityLabel: 'Player',
            // The label reads "Overall" once the matchup column sits beside it. The plain rank label stays for leagues without that column.
            rankLabel: `${showMatchupRank ? 'Overall' : 'Rank'}${posFilter !== 'ALL' ? ` (${escapeHtml(posFilter)})` : ''}`,
            showMatchupRank,
            // In a points league the slab in this column is the TOTAL, with points-per-game muted beneath it, so the heading names what the eye lands on.
            ptsPerGameLabel: AppState.isPointsLeague ? 'Total' : 'PTS/G',
            showPtsPerGame: AppState.isPointsLeague && !statsView,
            // The header claims the lens column only when the rows can fill it. The row builder omits a lens with no data, so a header emitted against none would slide every stat column one place left of its heading. The condition reads the same league-wide context the rows are built from, so can any row fill this and does the header claim it read one fact.
            timeLens: (resolvedLens === 'openSeats' ? !!lens.openSeatsCoverage : !!lens[resolvedLens]) ? resolvedLens : null,
            showRostered: true,
            showNextGame: AppState.isPointsLeague && !statsView,
            // This is ESPN's global rostered percent and not a figure this league computes, so the header says so in every state.
            rosteredLabel: 'ESPN rostered',
            cells: headerCells,
            showPick: true
        }, rowOpts(false))
        + groupBlockHtml
        + (restPlayers.length ? rowsHtml
            : (groupIds.length ? '<div class="lb-group-rest-empty">No other players match your search/filter.</div>' : ''))
        + `</div>`;
    // Both preseason states rank and show projections, and the tag names that basis so a table of numbers nobody has put up does not read as though they have.
    const tagLineHtml = basis.preseason
        ? `<div class="pd-mast"><span class="pd-tag">PRESEASON &middot; PROJECTED</span>`
        + `<span class="pd-mast-note">Totals are ESPN's season projections.</span></div>`
        : '';
    // The legend is named only on the two states that need a word about it. The column present changes both header labels' meaning. The column absent carries the contract's own reason, never greyed. No other column draws a legend.
    const matchupLegendHtml = showMatchupRank
        ? `<div class="lb-mrank-legend"><span><b>Overall</b> = the mean of ${matchupCtx.categoryIds.length} category percentiles.</span>`
        + `<span><b>Matchup</b> = category wins a week this line is expected to swing against this `
        + `league's own measured margins, all ${matchupCtx.categoryIds.length} categories; the rank `
        + `among ${matchupRanks.of} ${(wantPitchers ? groupLabels(sport).secondary : groupLabels(sport).primary).toLowerCase()}.</span></div>`
        : (matchupRefusal.reason === 'too-few-matchups'
            ? `<div class="lb-mrank-legend lb-mrank-legend-absent">${escapeHtml(MATCHUP_RANK_REASON_TEXT[matchupRefusal.reason] || '')}</div>`
            : '');
    container.innerHTML = tagLineHtml + html + matchupLegendHtml;

    // Empty nights is the one measure toggle left in this slot. The window choice moved to the tab bar's pills and drives the shared ahead state this render reads. A checkbox fits, since there is nothing to choose between.
    const lensSlot = document.getElementById('lens-toggle-slot');
    // Preseason has no "from here" to measure, so the control is absent and not greyed. It is also absent wherever it cannot apply, which covers every non-hockey league and a hockey league with no current matchup or no lineup. A permanently disabled control on almost every league is worse than none.
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
                // The first click shows the best, so a lower-is-better column opens ascending. Sorting by ERA used to lead with the worst pitcher.
                AppState.playerSortDir = openingSortDir(key, leagueInverseIds(sport));
            }
            renderPlayerLeaderboard();
        });
    });

    // Preseason renders every row inert, so no click is wired in that state, which would open a drill-down with nothing to show.
    if (!basis.preseason) {
        // The selector excludes the header, which is itself a row, since binding it would open a drill-down for NaN on a header click.
        container.querySelectorAll('.lb-row[data-player-id]').forEach(row => {
            row.addEventListener('click', () => openPlayerDetail(parseInt(row.dataset.playerId, 10)));
        });
    }
    // Only the rows inside the photo budget carry an <img>; this wires whichever of them exist.
    wirePlayerAvatars(container);
    // The fantasy-team discs take the same ground rule the rail's crests do. A disc with no logo is the ring alone.
    applyLogoGrounds([...container.querySelectorAll('.lb-team-disc[data-team-logo]')]
        .filter(el => el.dataset.teamLogo).map(el => ({ el, url: el.dataset.teamLogo })));
    fitLeaderboardNames(container);
    renderPhoneBar();
    fitPhoneGrid();

    // The pick-to-compare controls stop propagation, because every pick circle sits inside a row whose own click opens the drill-down.
    container.querySelectorAll('.lb-pick').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            const playerId = parseInt(btn.closest('.lb-row[data-player-id]').dataset.playerId, 10);
            const ids = [...(AppState.playerCompareGroupIds || [])];
            const at = ids.indexOf(playerId);
            if (at !== -1) ids.splice(at, 1);
            else if (ids.length < 1 + PLAYER_GROUP_MAX_OTHERS) ids.push(playerId);
            AppState.playerCompareGroupIds = ids;
            renderPlayerLeaderboard();
        });
    });
    container.querySelectorAll('.lb-seg [data-view]').forEach(tab => {
        tab.addEventListener('click', () => {
            const next = tab.dataset.view === 'stats' ? 'stats' : 'points';
            if (next === pointsPhoneView) return;
            pointsPhoneView = next;
            renderPlayerLeaderboard();
        });
    });
    const groupClearBtn = document.getElementById('lb-group-clear');
    if (groupClearBtn) {
        groupClearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            AppState.playerCompareGroupIds = [];
            renderPlayerLeaderboard();
        });
    }
    const groupCompareBtn = document.getElementById('lb-group-compare');
    if (groupCompareBtn) {
        groupCompareBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // The drill-down's own opener sets up the chrome, as for a single player, so the group screen replaces what it renders and does not duplicate that setup.
            const ids = AppState.playerCompareGroupIds || [];
            if (ids.length < 2) return;
            await openPlayerDetail(ids[0]);
            await openPlayerGroupComparison(ids);
        });
    }

    // The rank column's weekly-form arrows fetch quietly in the background and each chunk's completion re-renders. The scope is the basis, the visible rows and the qualified pool, which is what the arrow math needs. A row scrolled into view without weekly data shows no arrow and not a wrong one.
    if (!AppState.isPointsLeague && !leaderboardWeeklyDataReady() && !bulkWeeklyFetchFailed) {
        ensureLeaderboardWeeklyDataLoaded(sport, 'basis');
    }

    // Rows just changed through a sort, filter, search or chunk repaint, so the rest of the queue is re-tiered behind them. It does nothing when no fetch is running.
    reprioritizeWeeklyQueue();
}
// Raw single-player weekly responses kept for the diagnostic panel only, keyed by player id for the session. They are small, unlike the bulk response, which is never retained.
const playerDetailDiagnostics = {};
let detailDiagnosticInFlight = false;

/**
 * Captures the drill-down's diagnostic payload lazily. The drill-down skips its own fetch when the
 * bulk warm-up cached the player, which left the diagnostic panel empty. The fetch runs only when
 * the panel is opened on a drill-down with nothing captured, and is cached per player for the
 * session.
 * @returns {Promise<void>}
 */
export async function ensurePlayerDetailDiagnostic() {
    const playerId = AppState.selectedPlayerId;
    if (playerId == null || hasDebugContext('player-detail') || detailDiagnosticInFlight) return;

    const cached = playerDetailDiagnostics[playerId];
    if (cached) {
        setDebugContext('player-detail', cached);
        return;
    }

    // Captured for the same discard rule the pool and bulk fetches use. A league or year switch mid-flight means the response describes a season nobody is looking at.
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
        // Still this league, so the payload is this player's and worth caching. It is shown only if that player is still on screen, so one player's raw data is never labelled with another's name.
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

/**
 * Opens the drill-down for one player. The preserve flag is true when the page reopens the same
 * player after a data refresh. Comparing against the selected id does not work, since the refresh
 * has already cleared it, so an explicit flag from the caller is the only reliable signal.
 * @param {string|number} playerId The ESPN player id.
 * @param {boolean} [preserveView] True to keep the selected stat, rank pool and breakdown state.
 * @returns {Promise<void>}
 */
export async function openPlayerDetail(playerId, preserveView = false) {
    if (!AppState.playerData.some(p => p.id === playerId)) return;
    const sport = AppState.loadedSport;

    // View state resets only when switching to a different player. Reopening the same player keeps whatever was selected.
    if (!preserveView) {
        AppState.playerDetailStat = null;
        AppState.playerDetailRankPool = 'Overall';
        AppState.playerDetailRankBreakdownOpen = false;
        AppState.playerDetailMatchupSide = 'overall';
    }
    AppState.selectedPlayerId = playerId;

    const listEl = document.getElementById('player-leaderboard-container');
    if (listEl && listEl.style.display !== 'none') leaderboardScrollTop = document.scrollingElement.scrollTop;
    document.getElementById('player-toolbar').style.display = 'none';
    // The team rail, Minimum Games, Advanced Stats and Empty Nights all filter the leaderboard table, which is not on screen during a drill-down. The toolbar's single hide covers the controls, so only the separate rail element is hidden here.
    document.getElementById('player-breakout-slot').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'none';
    const detailContainer = document.getElementById('player-detail-container');
    detailContainer.style.display = 'flex';
    detailContainer.innerHTML = `<div class="player-loading">${buildLoadingHtml()}</div>`;
    // Points the diagnostic panel at this player immediately, even if the fetch below is skipped. Seeding from the diagnostic cache, null when never captured, drops the previous player's payload so the panel always matches the drill-down on screen.
    setDebugContext('player-detail', playerDetailDiagnostics[playerId] || null);
    setActiveDebugKind('player-detail');

    // A bulk-cached entry carries no per-day sums unless the pool path decided the player needed them, so the Day axis asks for them. The days come on demand, one player at a time, never pool-wide.
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
        // The season pool has this player but the effective pool for the window does not. The tab falls back to the leaderboard so it never sits on a half-open blank drill-down.
        closePlayerDetail();
        return;
    }
    renderPlayerDetail(player);

    // Capture for THIS player right away if the panel is already expanded. main.js's hook only fires on toggle, so without this, someone comparing several players with the panel left open (exactly the stat-checking workflow this diagnostic exists for) would see the empty placeholder on every switch until they collapsed and reopened it. An ordinary drill-down with the panel collapsed still costs nothing.
    if (document.getElementById('debug-panel')?.open) ensurePlayerDetailDiagnostic();
}

/**
 * Closes the drill-down and returns to the leaderboard, restoring the toolbar and the rail to their
 * own visibility rules.
 * @returns {void}
 */
export function closePlayerDetail() {
    AppState.selectedPlayerId = null;
    document.getElementById('player-detail-container').style.display = 'none';
    document.getElementById('player-leaderboard-container').style.display = 'flex';
    document.getElementById('player-toolbar').style.display = 'flex';
    // The page returns to where the list was left, on this frame and the next since the list's own layout settles after the display change.
    if (leaderboardScrollTop !== null) {
        const y = leaderboardScrollTop;
        leaderboardScrollTop = null;
        document.scrollingElement.scrollTop = y;
        requestAnimationFrame(() => { document.scrollingElement.scrollTop = y; });
    }
    // The rail restores to its own rule and not to a forced display value. It collapses itself when it has nothing to show, and an inline value would draw an empty box. The toolbar's restore covers the other controls, and each keeps deciding its own visibility as before.
    document.getElementById('player-breakout-slot').style.display = '';
    // Back on the leaderboard, the diagnostic panel switches back to the pool context, which is already cached.
    setActiveDebugKind('player-pool');
}

// The scored and advanced split used elsewhere, scoped to the group tab the detail was opened from and not the player's primary role, so a two-way player opened from pitchers sees pitching options.
function statIdsForPlayer(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pitchingIds = roleIdSetFor(sport);
    const wantPitchers = currentGroupIsSecondary(sport);
    const roleIds = Object.keys(statMap).filter(id => wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id));
    const deduped = preferScoredDedup(roleIds, statMap);
    // ESPN's raw points figure is a generic formula unrelated to the league's scoring, so it is excluded and the computed weekly score replaces it.
    const withoutFpts = deduped.filter(id => statMap[id] !== 'FPTS');
    const withData = withoutFpts.filter(id => Object.values(weekly).some(w => w[id] !== undefined) || player.seasonTotals[id] !== undefined);

    return splitScoredAdvanced(withData);
}

// Returns a few players above and below this player in a rank list, for the rank chip's hover. The list is sorted best to worst. Tie-aware competition ranks align with it when the caller has them, and otherwise the positional rank is used, since averaged scores are continuous.
function getRankNeighbors(ranked, playerId, ranks = null, windowSize = 3) {
    const idx = ranked.findIndex(p => p.id === playerId);
    if (idx === -1) return [];
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(ranked.length, idx + windowSize + 1);
    return ranked.slice(start, end).map((p, i) => ({ player: p, rank: ranks ? ranks[start + i] : start + i + 1 }));
}

// A rank chip is a stat chip with an outlined variant, with the same label, value and hover structure, so a reader can tell the app's ranking from a player's own figure. The pool key says which comparison pool the chip represents, and clicking sets the breakdown's pool. The info mark belongs to the overall chip alone, since that is where the breakdown opens.
function buildRankChipHtml(poolKey, roto, player, roleWord = null, showInfo = false, sparkHtml = '') {
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
    const infoHtml = showInfo
        ? `<span class="stat-chip-info" role="button" tabindex="0" title="How the rank is calculated">&#9432;</span>`
        : '';
    return `
        <div class="stat-chip stat-chip-rank stat-chip-rank-pool${isSelected ? ' stat-chip-rank-on' : ''}" data-rank-pool="${escapeHtml(poolKey)}">
            ${sparkHtml}
            <span class="stat-chip-label">${escapeHtml(label)}${infoHtml}</span>
            <span class="stat-chip-value">#${rank}</span>
            <span class="stat-chip-rank">of ${roto.total}</span>
            <div class="rank-chip-dropdown"><table>${rows}</table></div>
        </div>
    `;
}

// Formats a signed win rate to two decimals for a chip or bar and three for a table. A positive value gets a plus sign, and a value that rounds to zero gets no sign and never a negative zero string.
function formatWinsPerWeek(v, decimals = 2) {
    let s = Number(v).toFixed(decimals);
    const zero = (0).toFixed(decimals);
    if (s === `-${zero}`) s = zero;
    return (s !== zero && !s.startsWith('-')) ? `+${s}` : s;
}

// The matchup rank for one player, read by the third chip and the matchup bar. It follows the same qualified-pool rule as the leaderboard column. The pool is the same-role pool narrowed to whoever the overall rank ranked, with no position filter, because the overall chip is always scored against the full same-role pool.
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

// The third chip is read-only with no pool dropdown, since a matchup rank is one number and not a pool to switch between. It has its own style.
function buildMatchupRankChipHtml(matchupEntry, sparkHtml = '') {
    if (!matchupEntry) return '';
    return `<div class="stat-chip stat-chip-rank stat-chip-rank-matchup">
        ${sparkHtml}
        <span class="stat-chip-label">Matchup</span>
        <span class="stat-chip-value">#${matchupEntry.rank}</span>
        <span class="stat-chip-rank">of ${matchupEntry.of}<span class="stat-chip-swing"> &middot; ${formatWinsPerWeek(matchupEntry.winsPerWeek)} wins a week</span></span>
    </div>`;
}

// The matchup side of the breakdown switch, four bullets and a per-category table, every figure read from the matchup entry's own per-category data and never re-derived.
function buildMatchupBreakdownBodyHtml(matchupEntry, player, sport, roleLabel) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const rateIds = AVERAGE_STATS[sport] || new Set();
    const inverseIds = leagueInverseIds(sport);
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
    // The four lines say what each column is. How it was measured sits one level down, on the mark at the end of the first line. The qualified-pool count is the foot row's.
    const matchupNote = `Measured on this league's ${matchupEntry.matchups} decided matchups. A rate shows the season rate, unadjusted for missed weeks.`;
    const matchupNoteHtml = ` <span class="hint" tabindex="0" role="button" aria-label="How the matchup figures are measured" data-hint="${escapeHtml(matchupNote)}">&#9432;</span>`;
    const totalCls = matchupEntry.winsPerWeek >= 0 ? 'pos' : 'neg';
    return `
        <ul class="rank-breakdown-explain">
            <li><strong>Margin</strong> - How far apart the two sides usually finish in this category.${matchupNoteHtml}</li>
            <li><strong>Per week</strong> - The season line, per matchup.</li>
            <li><strong>Wins a week</strong> - How many categories a typical week of this line wins.</li>
            <li><strong>Matchup rank</strong> - Rank by wins a week, among qualified players.</li>
        </ul>
        <table class="rank-breakdown-table rank-breakdown-table-matchup">
            <thead><tr><th>Category</th><th>Season</th><th>Per week</th><th>Margin</th><th>Wins a week</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td colspan="4">Wins a week = ${formatWinsPerWeek(matchupEntry.winsPerWeek)} &middot; Matchup rank #${matchupEntry.rank} of ${matchupEntry.of}</td><td class="${totalCls}">${formatWinsPerWeek(matchupEntry.winsPerWeek, 3)}</td></tr></tfoot>
        </table>
    `;
}

// Builds the overall rank chip plus one chip per position the player is eligible for, each against only that position's peers, since a multi-position player's value differs by position. Clicking a chip shows that pool's math in the breakdown. It returns the chips and the two-way note separately, because the note is a sentence about the chips and the merged row cannot share a line with it.
function buildRankChipsHtml(player, sport, rankSparkHtml = '') {
    // Points leagues rank too, with the same chips and scoping, ranked by fantasy points and not category percentiles.
    const wantPitchers = currentGroupIsSecondary(sport);
    const pitcherPositions = SECONDARY_GROUP_POSITIONS[sport] || new Set();
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const overallRoto = computeLeagueRanks(samePool, sport, null, wantPitchers);
    // Qualified in both groups, the only case where "Overall" needs qualifying. It reads the same eligibility the pools are built from.
    const twoWay = groupsFor(sport).length > 1
        && matchesPlayerGroup(player, sport, false) && matchesPlayerGroup(player, sport, true);
    const chips = [buildRankChipHtml('Overall', overallRoto, player, twoWay ? groupRoleWord(sport, wantPitchers) : null, true, rankSparkHtml)];
    let noteHtml = '';
    if (twoWay) {
        const other = groupRoleWord(sport, !wantPitchers);
        // The note avoids a pronoun and a possessive. The tab does the ranking, so it is the subject, and the role word reads as a label and not as a person who owns a line.
        noteHtml = `<div class="rank-chip-note">Ranked here as a ${escapeHtml((groupRoleWord(sport, wantPitchers) || 'player').toLowerCase())} only.`
            + ` The other tab ranks the ${escapeHtml((other || 'player').toLowerCase())} line, and the draft board is the one`
            + ` place the two are combined into a single value.</div>`;
    }
    // For a two-way player, only the chips for positions of the group being viewed show. A batting chip while viewing pitching would compare the wrong role against the wrong pool.
    const relevantPositions = player.eligiblePositions.filter(pos => pitcherPositions.has(pos) === wantPitchers);
    relevantPositions.forEach(pos => {
        const posPool = samePool.filter(p => matchesPositionFilter(p, pos));
        // Skips a positional chip whose pool is the group pool, since it would restate overall. This is hockey goalies today. The check is on pool identity, not a position string, so a future one-position group inherits it, and a baseball starter pool, which is a strict subset, stays.
        if (posPool.length === samePool.length) return;
        chips.push(buildRankChipHtml(pos, computeLeagueRanks(posPool, sport, pos, wantPitchers), player, null, false, rankSparkHtml));
    });
    return { chipsHtml: chips.filter(Boolean).join(''), noteHtml };
}

// Says why a player has no rank, as no-games, below-minimum, or null when neither applies. Zero games in the window is an absence of evidence. Under the minimum but played is a display filter with a real score behind it. It measures games played because the engine gates on that. The pool's maximum is handed in so it is found once.
function poolMaxGames(poolPlayers, sport, wantPitchers) {
    return Math.max(0, ...poolPlayers.map(p => gamesPlayedOf(p, sport, wantPitchers)));
}

function unrankedReason(player, poolPlayers, sport, wantPitchers, maxGames = poolMaxGames(poolPlayers, sport, wantPitchers)) {
    if (maxGames <= 0) return null;
    const own = gamesPlayedOf(player, sport, wantPitchers);
    if (own === 0) return 'no-games';
    return own < maxGames * MIN_PLAYING_TIME_FRACTION ? 'below-minimum' : null;
}

// Explains how a points rank is built, with figures and no sentence. A points rank is one sum, not an average of category percentiles, so there is no category table. It uses the same details shell as the category breakdown so the info mark and open state work unchanged, around four figures off the same ranking the chip reads, the rank, the player's points, the pool leader's and the pool median.
function buildPointsBreakdownHtml(player, sport, wantPitchers) {
    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;
    const roto = computeLeagueRanks(poolPlayers, sport, isPositionPool ? selectedPool : null, wantPitchers);
    if (!roto || !roto.ranks.has(player.id)) return '';
    const scores = [...roto.ranked].map(p => roto.scores.get(p.id)).filter(v => Number.isFinite(v)).sort((a, b) => b - a);
    if (!scores.length) return '';
    const mine = roto.scores.get(player.id);
    const mid = Math.floor(scores.length / 2);
    const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
    const row = (label, value) => `<tr><td>${escapeHtml(label)}</td><td>${value}</td></tr>`;
    return `
        <details class="rank-breakdown rank-breakdown-points"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
            <summary class="rank-breakdown-summary-hidden"></summary>
            <table class="rank-breakdown-table rank-breakdown-points-table">
                <tbody>
                    ${row(`${selectedPool === 'Overall' ? 'Overall' : selectedPool} rank`, `#${roto.ranks.get(player.id)} of ${roto.total}`)}
                    ${row('Season points', Number.isFinite(mine) ? mine.toFixed(1) : '-')}
                    ${row('Pool leader', scores[0].toFixed(1))}
                    ${row('Pool median', median.toFixed(1))}
                </tbody>
            </table>
        </details>
    `;
}

function buildRankBreakdownHtml(player, sport, wantPitchers = currentGroupIsSecondary(sport), matchupEntry = null) {
    if (AppState.isPointsLeague) return buildPointsBreakdownHtml(player, sport, wantPitchers);
    // The breakdown's role follows the group tab being viewed, not the player's primary position.
    const isPitching = currentGroupIsSecondary(sport);
    const roleLabel = groupLabel(sport, isPitching);
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, isPitching));

    const selectedPool = AppState.playerDetailRankPool || 'Overall';
    const isPositionPool = selectedPool !== 'Overall' && player.eligiblePositions.includes(selectedPool);
    // Only RP matches by primary role and not eligibility. SP uses plain eligibility and does not share the reliever's games-played workload basis.
    const isRpPool = selectedPool === 'RP';
    const poolPlayers = isPositionPool ? samePool.filter(p => matchesPositionFilter(p, selectedPool)) : samePool;

    // RP skips shrinkage and compares strikeouts as K/9. Every other pool, including SP, uses the same workload measure the roto rank does.
    const { rows, excluded, shrink, avg, qualifiedCount } = computeCategoryBreakdown(player, poolPlayers, sport, selectedPool, wantPitchers);
    if (rows.length === 0) return '';

    // The pool is labelled with the qualified count the score was computed against, so the percentiles below reconcile with it.
    const poolCount = qualifiedCount.toLocaleString();
    const poolDescription = isPositionPool
        ? `${poolCount} qualified ${selectedPool}${isRpPool ? '-primary' : '-eligible'} ${roleLabel}`
        : `${poolCount} qualified ${roleLabel}`;

    // No games in this window means no score exists, and the table stops pretending one does. Shrinkage at zero pins every adjusted cell to 50, which averaged to a score that was the pin and not a result. The percentiles stay, because they are real.
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
    // One tight line per concept. The table right below shows the actual math.
    const adjustedExplainer = isRpPool
        ? `<strong>Adjusted</strong> = Percentile: RP skips the Playing-Time Factor (innings aren't comparable between true relievers and spot-starting swingmen), and K is compared as K/9.`
        : `<strong>Adjusted</strong> = Percentile pulled toward 50 by a <strong>${shrinkPct}% Playing-Time Factor</strong> (${workloadLabel} vs the pool leader's).`;

    // The mechanics essay belongs to the ranked case. With no games there is no Playing-Time Factor worth describing (it is zero, and describing what a zero multiplier does to a percentile is the exact sentence that made the old table read as self-contradictory), and no average to define. What replaces both is the one fact the reader came for.
    const timeframeWords = isFullSeasonTimeframe() ? 'this season' : 'this timeframe';
    const mechanicsBullets = noRank
        ? `<li><strong>Unranked</strong>: no games played in ${timeframeWords}, so there is no Rank score to build. The percentiles are still real - they are where a line of no production places against the pool.</li>`
        : `<li>${adjustedExplainer}</li>
           <li><strong>Rank Score</strong> = average of the Adjusted column.</li>`;

    // Under the minimum but played needs the opposite treatment, since the score is real and shown in full. The note explains why the leaderboard's own filter hides the player. It is gated on the toggle as well, since with it off the player is in the list.
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

    // The panel opens from the info mark on the overall chip, so its own summary is hidden and its content, the title and the overall and matchup switch, moves inside as the body's first line. The switch appears only when there is a real second telling, a matchup rank, an actual rank score to pair it with, and the overall pool selected, since the matchup rank has no position-scoped variant.
    const showMatchupSwitch = !!matchupEntry && !noRank && selectedPool === 'Overall';
    const headHtml = `<div class="rank-breakdown-head">
        <span class="rank-breakdown-bar-title">${summary}</span>
        ${showMatchupSwitch ? `<span class="rank-breakdown-switch">
            <button type="button" class="rank-breakdown-switch-opt${(AppState.playerDetailMatchupSide === 'matchup' ? 'matchup' : 'overall') === 'overall' ? ' on' : ''}" data-matchup-side="overall">Overall ${avg.toFixed(1)}</button>
            <button type="button" class="rank-breakdown-switch-opt${(AppState.playerDetailMatchupSide === 'matchup' ? 'matchup' : 'overall') === 'matchup' ? ' on' : ''}" data-matchup-side="matchup">Matchup #${matchupEntry.rank}</button>
        </span>` : ''}
    </div>`;
    if (!showMatchupSwitch) {
        return `
            <details class="rank-breakdown"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
                <summary class="rank-breakdown-summary-hidden"></summary>
                ${headHtml}
                ${overallBodyHtml}
            </details>
        `;
    }

    const matchupSide = AppState.playerDetailMatchupSide === 'matchup' ? 'matchup' : 'overall';
    const matchupBodyHtml = buildMatchupBreakdownBodyHtml(matchupEntry, player, sport, roleLabel);
    return `
        <details class="rank-breakdown rank-breakdown-switchable"${AppState.playerDetailRankBreakdownOpen ? ' open' : ''}>
            <summary class="rank-breakdown-summary-hidden"></summary>
            ${headHtml}
            <div class="rank-breakdown-side${matchupSide === 'overall' ? '' : ' hidden'}" data-side="overall">${overallBodyHtml}</div>
            <div class="rank-breakdown-side${matchupSide === 'matchup' ? '' : ' hidden'}" data-side="matchup">${matchupBodyHtml}</div>
        </details>
    `;
}

// Re-renders the open player detail view in place, doing nothing if none is open. It runs when the shared timeframe changes. It resolves one player as the current timeframe sees them, or null when not in the league. The windowed pool only holds players with cached weekly data, so the fallback is a windowed clone with no totals and never season numbers under a windowed heading.
function effectivePlayerById(sport, id) {
    const pooled = getEffectivePlayerPool(sport).find(p => p.id === id);
    if (pooled) return pooled;
    const base = AppState.playerData.find(p => p.id === id);
    if (!base) return null;
    return isFullSeasonTimeframe() ? base : { ...base, seasonTotals: {} };
}

/**
 * Re-renders whichever detail view is open for the current timeframe. It consults the compare group
 * first, so a timeframe change keeps the whole comparison when every member is still in the new
 * pool. The group renderer's own fewer-than-two fallback still applies when the new pool leaves
 * nobody to compare.
 * @returns {void}
 */
export function refreshOpenPlayerDetail() {
    if (!AppState.selectedPlayerId) return;
    const groupIds = AppState.playerCompareGroupIds || [];
    if (groupIds.length >= 2) { renderPlayerGroupComparison(groupIds); return; }
    const player = effectivePlayerById(AppState.loadedSport, AppState.selectedPlayerId);
    if (player) renderPlayerDetail(player);
}

// What the trend picker offers and in what order. The comparison view builds the same list from the same rules, so both views chart the same stats off the same picker. The first entry is what a freshly opened view shows, so the order is a decision.
function buildTrendStatOptions(player, sport, weekly) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const statOptions = visibleIds.map(id => ({ id, name: statMap[id] }));
    // Category leagues get a computed weekly score as a selectable trend, in place of ESPN's removed points figure. It is named for the league's own timeline unit, "Score by matchup" or "Score by week" in roto, and never shares a word with the matchup-rank figure, which is a different number.
    if (!AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_RANK_STAT_ID, name: `Score by ${axisUnit().long.toLowerCase()}` });
    // A points league's headline number is its points, so that trend leads the picker and a freshly opened drill-down shows it. The individual categories stay selectable beneath.
    if (AppState.isPointsLeague) statOptions.unshift({ id: WEEKLY_POINTS_STAT_ID, name: `${axisUnit().long} Points` });

    // At the current window the synthetic score cannot be drawn on the day axis, since it is scored per period against the pool, so a real category leads instead. The default moves and the list does not, so an option never shifts under the cursor.
    const dayLens = parseTimeframe(AppState.timeframe).window === 1;
    const synthetic = new Set([WEEKLY_RANK_STAT_ID, WEEKLY_POINTS_STAT_ID]);
    const preferred = dayLens ? (statOptions.find(s => !synthetic.has(s.id)) || statOptions[0]) : statOptions[0];
    return { options: statOptions, preferred };
}

// ==== The day lens ====

// The pro schedule is asked for once and only when a day label wants it. It is the only source that dates a scoring period, it is session-cached, and My Team already fetches it. The labels read Day N until it lands and re-render when it does. The slots are keyed by the schedule's own identity, sport and season, so a switch to another sport never keeps another league's dates.
let proScheduleDates = null;
let proScheduleDatesKey = null;
let proScheduleAskedKey = null;

function scheduleDatesKey() {
    const d = AppState.apiData;
    return d ? `${d.gameId}:${d.seasonId}` : null;
}

function ensureScheduleDates() {
    const key = scheduleDatesKey();
    if (!key) return;
    if (proScheduleDatesKey !== key) proScheduleDates = null;   // another sport or season's dates
    if (proScheduleDates || proScheduleAskedKey === key) return;
    proScheduleAskedKey = key;
    fetchProTeamSchedules()
        .then(data => {
            // Answered for a schedule nobody is looking at any more.
            if (scheduleDatesKey() !== key) return;
            const dates = datesByScoringPeriod(data);
            if (!dates.size) return;
            proScheduleDates = dates;
            proScheduleDatesKey = key;
            // Redraws only if a drill-down is still open, since a leaderboard has no use for the answer.
            if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        })
        .catch(() => { /* No dates. The chips keep saying Day N, which is never wrong. */ });
}

// A period's label is the real date when the schedule can supply one and the day's place in its matchup when it cannot. It is never a computed guess. The date is month and day, zero-padded and hyphen-separated, in local time, because a fantasy day is the day the games were played where the reader is.
function dayChipLabel(period, dayNumber) {
    const at = proScheduleDates && proScheduleDatesKey === scheduleDatesKey() && proScheduleDates.get(period);
    if (at) {
        const d = new Date(at);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}-${dd}`;
    }
    return dayNumber ? `Day ${dayNumber}` : `P${period}`;
}

// Sport knowledge lives here, not in the rank engine. A signature day is a statement the sport makes and not a ratio, so a quality start stays one in a brilliant season. Baseball uses outs, earned runs and home runs, and hockey uses hat tricks, goals and shutouts.
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


// The day's notable counting stats, at most three, in box-score order and only the non-zero ones. The headline's own stats count toward the verdict even when the league does not score them, so a three-hit day is not called a bad one. Only the good half of a headline counts, so a pitcher is never rewarded for being hit. Outs count, since innings are what a start is measured by.
const DAY_VERDICT_EXTRA = {
    flb: { primary: ['1'], secondary: ['34', '48'] },
    fhl: { primary: ['13', '14'], secondary: ['6'] }
};

const DAY_NOTABLE = {
    flb: { primary: [[5, 'HR'], [21, 'RBI'], [20, 'R'], [23, 'SB']], secondary: [[53, 'W'], [57, 'SV'], [48, 'K'], [63, 'QS']] },
    fhl: { primary: [[13, 'G'], [14, 'A'], [29, 'SOG'], [31, 'HIT']], secondary: [[1, 'W'], [7, 'SO'], [6, 'SV']] }
};

// A played day always says something. A pitcher leads with innings, since a pitching line without them is unreadable, and a batter with nothing to report falls back to at-bats. The separator is a character code and not an escape inside a template literal, so an edit cannot turn it into literal text.
function dayNotable(sums, sport, secondary) {
    // A sport with no rules gets none. These tables encode facts about baseball and hockey that are meaningless for another sport's ids, so an absent entry means no signature rules.
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

// The middot that joins a stat line, named so it survives an edit.
const MIDDOT = String.fromCharCode(183);
const MIDDOT_SEP = ` ${MIDDOT} `;

// The day lens. Day points wear verdicts and every matchup point opens its own days. This computes per-day verdicts and self-scores for a set of periods once per draw, read by the point painter and the hover text alike. The typical day is taken over every day the player has, so a day does not change colour as the timeframe moves.
function dayInfoFor(player, sport, periods) {
    const daily = AppState.playerWeeklyCache[player.id]?.dailyByPeriod;
    if (!daily) return null;
    const secondary = currentGroupIsSecondary(sport);
    const { scored } = statIdsForPlayer(player, sport, (AppState.playerWeeklyCache[player.id] || {}).weekly || {});
    // Counting categories only, since a rate cannot judge a single day. The average-stat list says which ids are rates.
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
            // The presentable day score, where 50 is the player's own typical day and 100 is the cap, the same register as the matchup score.
            score: presentDayScore(score),
            notable: played ? dayNotable(sums, sport, secondary) : ''
        });
    });
    return { byPeriod };
}

// One matchup's days as a chart series, for the zoom. A real stat runs cumulative through the matchup, with the same arithmetic as the day axis. The per-pool score pair has no per-day chart value, so the zoomed line plots the day self-scores on the 0 to 100 scale. An off day is a gap and not a zero. Every entry carries its period beside the index, since verdicts and date labels are keyed by period.
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

// The matchup-axis verdicts, in the same grammar as the days. The baseline is the median of every week the player has, so it is stable across timeframes, and the best week of the season wears gold. Inverse stats read the other way. The matchup being played is judged by nothing, since its partial total would otherwise leave a pair that always reads gold and red.
function matchupVerdictInfo(player, sport, weekly, stat, isWeeklyRank, isWeeklyPoints) {
    const liveWeek = liveMatchupHeldApart();
    const allWeeks = Object.keys(weekly).map(Number).filter(w => weekly[w] && w !== liveWeek).sort((a, b) => a - b);
    if (!allWeeks.length) return null;
    const rankScores = isWeeklyRank ? computeWeeklyRankSeries(player, sport, weekly, allWeeks) : null;
    const valueOf = (w) => {
        if (isWeeklyRank) return rankScores[w] ?? 0;
        if (isWeeklyPoints) return pointsForStatBucket(weekly[w], player, sport);
        return weekly[w][stat.id] || 0;
    };
    const values = allWeeks.map(valueOf);
    const median = typicalDayScore(values);
    const inverse = !isWeeklyRank && !isWeeklyPoints && leagueInverseIds(sport).has(stat.id);
    const best = inverse ? Math.min(...values) : Math.max(...values);
    const verdictOf = (v, week = null) => {
        if (liveWeek !== null && week === liveWeek) return null;
        if (v === best) return 'best';
        if (median === null || v === median) return 'even';
        return (inverse ? v < median : v > median) ? 'above' : 'below';
    };
    return { verdictOf, liveWeek };
}


// Projection against actual pacing. The math lives in the pacing module and this builds its context and renders its shape. ESPN's projection is the rest of the season, so the question is a rate against a rate, and the season figure is what is banked plus what is expected. How much season is left comes from the schedule, through the function the coverage band uses. Without a schedule it falls back to ESPN's count.
function remainingAppearancesFor(player, gamesId) {
    const schedules = currentProSchedule();
    const proTeams = (schedules && schedules.settings && schedules.settings.proTeams) || null;
    const today = Number(AppState.apiData?.scoringPeriodId) || null;
    const final = finalScoringPeriodOf(AppState.apiData);
    // A finished season has nothing left, and that is an answer and not an absence. Falling back to ESPN's projected games, which it never retires, offered a whole season more after the last one.
    if (seasonIsFinished(AppState.apiData)) return 0;
    if (!proTeams || !today || !final || final < today || !gamesId) return null;
    const ahead = [];
    for (let p = today; p <= final; p++) ahead.push(p);
    const behind = [];
    for (let p = 1; p < today; p++) behind.push(p);
    if (!behind.length) return null;
    const left = gamesByProTeamForMatchup(proTeams, ahead).get(Number(player.proTeamId));
    const done = gamesByProTeamForMatchup(proTeams, behind).get(Number(player.proTeamId));
    if (!left || !done) return null;
    // Only the count is used, since the span is a number of appearances whatever unit they are counted in, and pacing multiplies the per-appearance rate by it.
    const expected = expectedAppearances(player, {
        gamesId, clubGamesPlayed: done.games, gamesRemaining: left.games
    });
    return expected ? expected.count : null;
}

// Returns the pacing facts as a lookup by stat id, for the season chips to fold in. Every chip with a pacing component carries its own projected total and foot-bar, so one chip exists per category and never two. It is null wherever the pacing module refuses, which includes football, where no games-played id exists.
function projectionPacingById(player, sport, scored, statMap) {
    const wantPitchers = currentGroupIsSecondary(sport);
    const gpIds = GAMES_PLAYED_IDS[sport];
    const gamesId = gpIds ? gpIds[wantPitchers ? 'secondary' : 'primary'] : null;
    const remaining = remainingAppearancesFor(player, gamesId);
    const pacing = projectionPacing(player, {
        scoredIds: scored,
        gamesId,
        gamesRemaining: remaining === null ? undefined : remaining,
        rateIds: AVERAGE_STATS[sport] || new Set(),
        inverseIds: leagueInverseIds(sport),
        isPointsLeague: AppState.isPointsLeague,
        weights: AppState.scoringWeights,
        statLabels: statMap,
        seasonId: AppState.apiData?.seasonId ?? null
    });
    if (!pacing) return null;

    const fig = (n) => formatStatValue(n, false);
    // The preseason line stays a clause on the chip's hover and is never printed on its face. A missing snapshot, an unseen player or an uncarried category appends nothing, never a zero.
    const preLine = preseasonLineFor(currentPreseasonSnapshot(), player.id);
    const byId = new Map();
    pacing.components.forEach(c => {
        const cActual = c.actualPerGame * pacing.gamesPlayed;
        const cExpected = c.projPerGame * pacing.projectedGames;
        const total = cActual + cExpected;
        const preValue = preLine ? preLine[c.id] : undefined;
        const beforeClause = (preValue === undefined || preValue === null) ? '' : ` · Before the season: ${fig(preValue)}`;
        const tip = `${fig(cActual)} ${c.label} banked + ${fig(cExpected)} expected the rest of the way${beforeClause}`;
        byId.set(String(c.id), {
            total: fig(total),
            // The foot-bar shows the banked share of the projected total, clamped because a hot stretch can carry a player past ESPN's rest-of-season rate and a bar past its track is a bug.
            bankedPct: total > 0 ? Math.max(0, Math.min(100, Math.round(100 * cActual / total))) : 0,
            tip
        });
    });
    return byId;
}

// The photo's ground takes the club's colour from the logo and is fitted to the page, because a ground the colour of the surface is no ground. The bar is 3:1 against the surface. On a light surface a sample that misses is darkened. On a dark one that cannot help, so it is lightened toward white in the same steps. It runs after the render and the ground keeps the surface colour until it answers.
const PD_GROUND_CONTRAST_FLOOR = 3;
/**
 * Fits a sampled logo colour to the page for use as a photo ground. A sample that clears 3:1
 * against the surface is kept, a light surface darkens the sample, and a dark surface lightens it
 * in small steps.
 * @param {number[]|null} sample The sampled `[r, g, b]` colour.
 * @param {number[]|null} surface The page surface `[r, g, b]`.
 * @returns {number[]|null} The fitted colour, or null when none clears the bar.
 */
export function groundColourFor(sample, surface) {
    if (!sample || !surface) return null;
    if (contrastRatio(sample, surface) >= PD_GROUND_CONTRAST_FLOOR) return sample;
    if (relativeLuminance(surface) > 0.5) {
        const dark = darkenUntilContrast(sample, surface, PD_GROUND_CONTRAST_FLOOR);
        return dark && dark.passed ? dark.rgb : null;
    }
    for (let i = 1; i <= 16; i += 1) {
        const t = i * 0.06;
        const lighter = sample.map(v => Math.round(v + (255 - v) * t));
        if (contrastRatio(lighter, surface) >= PD_GROUND_CONTRAST_FLOOR) return lighter;
    }
    return null;
}
async function applyClubGround(container, sport) {
    const ground = container.querySelector('.idb-ground');
    if (!ground) return;
    const url = proTeamLogoUrl(sport, ground.dataset.proAbbrev);
    if (!url) return;
    const sampled = await sampleLogoColour(url);
    if (!sampled || !ground.isConnected) return;
    const surface = parseCssColour(getComputedStyle(document.documentElement).getPropertyValue('--surface'));
    const fitted = groundColourFor(sampled, surface);
    if (fitted) ground.style.setProperty('--idb-club', toCssRgb(fitted));
}

function renderPlayerDetail(player) {
    // The preseason snapshot, asked for once per league and not awaited. The drill-down renders now and the ensure redraws it if a body lands. A league with no snapshot caches that answer too, so it costs one storage read per league per session.
    ensurePreseasonSnapshot();
    const container = document.getElementById('player-detail-container');
    const sport = AppState.loadedSport;
    // The same abbreviation table the leaderboard row model reads, built here because the drill-down carries only the raw pool player.
    const proAbbrev = currentProSchedule()
        ? proAbbrevOf(player, buildProTeamAbbrevs(currentProSchedule()))
        : null;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const { weekly = {} } = AppState.playerWeeklyCache[player.id] || {};

    // The league's own matchup schedule can end well short of the real season, so the larger of that and the player's own weeks is used. Otherwise the all-season option and the percentage lookbacks would cut off real weeks of the player's data.
    const effectiveMaxWeek = Math.max(AppState.maxCompletedWeek, 0, ...Object.keys(weekly).map(Number));

    const { scored, advanced } = statIdsForPlayer(player, sport, weekly);
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const { options: statOptions, preferred } = buildTrendStatOptions(player, sport, weekly);
    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || preferred;
    if (currentStat) AppState.playerDetailStat = currentStat.id;

    // Computed once and fed to both the third chip and the breakdown switch. It is null when the league or the player has no matchup rank, in which case both stay as they were.
    const matchupEntry = matchupRankForPlayer(player, sport);
    // The sparklines read the same matchup-axis weeks the trend chart reads, for the selected timeframe. Weekly data is empty before the bulk fetch lands, so the lines are skipped and the figures still render. A chip's line runs edge to edge over settled matchups only, since the live matchup would draw a fall that is only unplayed days. Under a picked matchup nothing is held apart and one point draws no line.
    const sparkLiveWeek = liveMatchupHeldApart();
    const { start: sparkTfStart, end: sparkTfEnd } = getTimeframeBounds(AppState.timeframe, effectiveMaxWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const sparkWeeks = Object.keys(weekly).map(Number)
        .filter(w => w !== sparkLiveWeek && w >= sparkTfStart && w <= sparkTfEnd).sort((a, b) => a - b);
    // A rank chip's series is the same weekly rank-form score the leaderboard's trend arrows trust, and not a per-matchup re-ranking per pool. A higher score is a better week, so a rising score draws upward with no axis inversion. The live matchup is left out here too.
    const rankScores = sparkWeeks.length >= 2 ? computeWeeklyRankSeries(player, sport, weekly, sparkWeeks) : {};
    const rankSparkHtml = sparklineSvg(sparkWeeks.map(w => (rankScores[w] !== undefined ? rankScores[w] : null)));
    const { chipsHtml: rankChipsHtml, noteHtml: rankNoteHtml } = buildRankChipsHtml(player, sport, rankSparkHtml);
    const matchupChipHtml = buildMatchupRankChipHtml(matchupEntry, rankSparkHtml);
    const rankBreakdownHtml = buildRankBreakdownHtml(player, sport, currentGroupIsSecondary(sport), matchupEntry);
    // Chips are absent whenever the engine will not rank this player, so a named state answers the question the missing chips raise. It stays silent when no reason can be given.
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

    // The rank pager for the header. Previous walks up the selected pool's ranking and next walks down it, with the same pool scoping as the breakdown so the two agree. It is omitted when the player is not ranked in the selected pool. Points leagues walk it too, since they have a real ranking.
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

    // The same bug as the leaderboard's, one click away: a projected counting stat carries fractional noise (a rest-of-season rate times games remaining), and formatStatValue's old unconditional rule gave it three decimals same as a real rate stat. isRate here is the same AVERAGE_STATS[sport] membership the leaderboard's ctx.rateIds reads.
    const chipRateIds = AVERAGE_STATS[sport] || new Set();
    // Read before the chips so each one can fold its own category's projection in as it builds.
    const pacingById = projectionPacingById(player, sport, scored, statMap);
    const seasonStatsHtml = visibleIds.map(id => {
        const rankInfo = computeStatRank(player, sport, id);
        // No percentile means the player is unranked in this category, so the chip stays on the plain surface and the percentile property is not set.
        const pctStyle = rankInfo ? ` style="--pct:${percentileVar(rankInfo.percentile)};"` : '';
        const rankColor = rankInfo && RANK_COLORS[rankInfo.rank];
        // The same hover dropdown as the rank chips, scoped to this category's own ordering. It passes the tie-aware ranks so a tied neighbour shows the shared rank.
        const neighborsHtml = rankInfo ? getRankNeighbors(rankInfo.sorted, player.id, rankInfo.ranks).map(({ player: np, rank: nr }) => `
            <tr class="rank-chip-row${np.id === player.id ? ' rank-chip-row-current' : ''}">
                <td>#${nr}</td>
                <td>${escapeHtml(np.name)}</td>
                <td>${formatStatValue(np.seasonTotals[id], chipRateIds.has(id))}</td>
            </tr>
        `).join('') : '';
        // A chip whose category has a pacing component gains the projected total beside the banked value and a foot-bar for the banked share. A rate chip never has one, since rates are not paced. The tooltip clause is wired through the same tooltip call as the rest.
        const mainValueText = formatStatValue(player.seasonTotals[id], chipRateIds.has(id));
        const pace = pacingById ? pacingById.get(String(id)) : null;
        // With nothing left to play the projected total lands exactly on the banked figure, so the arrow and foot-bar are dropped and the chip reads as an unpaced one.
        const showPace = !!pace && pace.total !== mainValueText;
        const paceCls = showPace ? ' stat-chip-paced' : '';
        const paceTitle = showPace ? ` data-tooltip="${escapeHtml(pace.tip)}"` : '';
        const arrowHtml = showPace ? `<span class="stat-chip-arrow">&rsaquo; <b>${escapeHtml(pace.total)}</b></span>` : '';
        const barHtml = showPace ? `<span class="stat-chip-bar"><i style="width:${pace.bankedPct}%"></i></span>` : '';
        // The same per-matchup reads the matchup axis already makes. Weekly data is keyed by matchup period with one raw sum per category, so this category's figure at each week in the timeframe is the series.
        const sparkValues = sparkWeeks.map(w => (weekly[w] && weekly[w][id] !== undefined ? Number(weekly[w][id]) : null));
        const sparkHtml = sparklineSvg(sparkValues);
        return `
            <div class="stat-chip${paceCls}"${pctStyle}${paceTitle}>
                ${sparkHtml}
                <span class="stat-chip-label">${escapeHtml(statMap[id])}</span>
                <span class="stat-chip-value"${rankColor ? ` style="color:${rankColor};"` : ''}>${mainValueText}${arrowHtml}</span>
                ${rankInfo ? `<span class="stat-chip-rank">#${rankInfo.rank} of ${rankInfo.total}</span>` : ''}
                ${neighborsHtml ? `<div class="rank-chip-dropdown"><table>${neighborsHtml}</table></div>` : ''}
                ${barHtml}
            </div>
        `;
    }).join('');

    // The season history store does not exist yet, so the optional chain reads undefined, the band renders nothing and the view is unchanged until the store is real.
    const seasonsBandHtml = buildSeasonsBandHtml(AppState.retroSeasons?.[player.id], statMap, { escapeHtml, categoryOrder: scored });

    // A move under five points in a week is noise and not signal, the same floor the leaderboard column uses and set higher here, because a header chip claims the player is worth a second look.
    const rosterChangeHtml = Math.abs(player.rosterChange || 0) >= 5
        ? `<div class="player-rostered-chip">Rostered ${player.rosterPct.toFixed(1)}%, ${player.rosterChange >= 0 ? '+' : ''}${player.rosterChange.toFixed(1)} this week</div>`
        : '';

    // The draft's own facts belong where the reader already is in season, since the Draft tab is hidden once it has nothing else to show. The picks request is the same one the preseason face fires. Undrafted is what a request still in flight reads as, and a listener redraws the drill-down when the answer lands.
    ensureDraftPicks(sport);
    // The identity block is one piece. The photo on a ground in the club's colour anchors the left, the name carries the position beside it, and the fantasy team, injury and pick sit centred beneath as chips on the one existing line. The pick is three whole numbers, round, slot and overall. A free agent reads as undrafted. The ground colour is sampled after the render.
    const pickParts = draftedPickParts(draftPicksFor(), player.id, Number(AppState.apiData?.settings?.size) || (AppState.apiData?.teams || []).length);
    const pickChip = !pickParts ? '<span class="idb-chip">Undrafted</span>'
        : (() => {
            // The drafting team's abbreviation closes the label, and the chip opens the Draft tab's recap on this player's cell. The abbreviation is the league's own, the one Team Metrics prints.
            const takerId = draftedPickTeamId(draftPicksFor(), player.id);
            const taker = takerId == null ? null : (AppState.apiData?.teams || []).find(t => Number(t.id) === takerId);
            const abbrev = taker && taker.abbrev ? String(taker.abbrev).toUpperCase() : null;
            const label = [
                pickParts.round !== null ? `<b>R${pickParts.round}</b>` : null,
                pickParts.slot !== null ? `Pk ${pickParts.slot}` : null,
                pickParts.overall !== null ? `<b>#${pickParts.overall}</b>` : null,
                abbrev ? escapeHtml(abbrev) : null
            ].filter(Boolean).join(' &middot; ');
            const title = taker ? `Drafted by ${taker.name || abbrev} - open the draft recap` : 'Open the draft recap';
            return `<button type="button" class="idb-chip idb-chip-pick idb-chip-link" data-reveal-pick="${escapeHtml(String(player.id))}" title="${escapeHtml(title)}">${label}</button>`;
        })();
    const chipsHtml = [
        player.teamName ? `<span class="idb-chip">${escapeHtml(player.teamName)}</span>` : null,
        injuryLabel(player.injuryStatus) ? `<span class="idb-chip player-detail-injury">${escapeHtml(injuryLabel(player.injuryStatus))}</span>` : null,
        pickChip
    ].filter(Boolean).join('');

    // The rank chips, the matchup chip and the season stat chips are one row. The two-way note cannot join the row and reads as its own line right under it. The fantasy team's colour rides the title as a custom property, which the phone header's headshot ring reads.
    const ringStyle = /^#[0-9a-f]{3,8}$/i.test(String(player.teamColor || '')) ? ` style="--player-ring:${player.teamColor}"` : '';
    container.innerHTML = `
        <div class="player-detail-header">
            <button id="player-back-btn" class="player-back-btn">&larr; Leaderboard</button>
            <div class="player-detail-title"${ringStyle}>
                <span class="idb-ground" data-pro-abbrev="${escapeHtml(proAbbrev || '')}">${buildPlayerAvatarHtml(sport, player.id, player.name)}</span>
                <div class="player-detail-name">
                    <h3>${buildProTeamLogoHtml(sport, proAbbrev)}${escapeHtml(player.name)}${injuryBadgeHtml(player.injuryStatus)}<span class="idb-pos">${escapeHtml(player.positionDisplay)}</span></h3>
                    <span class="player-detail-meta idb-chips">${chipsHtml}</span>
                </div>
            </div>
            <div class="player-detail-tools">
                ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
                ${pagerHtml}
            </div>
        </div>
        ${rosterChangeHtml}
        ${unrankedHtml}
        <div id="player-season-stats" class="player-season-stats">${rankChipsHtml}${matchupChipHtml}${seasonStatsHtml}</div>
        ${rankNoteHtml}
        ${rankBreakdownHtml}
        ${seasonsBandHtml}
        <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:300px; margin-top:8px;"></div>
    `;
    // On a phone the picker and the pager sit in the row directly above the chart, under the cards, not under the photo.
    if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
        const tools = container.querySelector('.player-detail-tools');
        const chartEl = container.querySelector('#player-trend-chart');
        if (tools && chartEl) chartEl.before(tools);
        // The Prev and Next pager rides the back button's row, top right, as two round pills.
        const pager = container.querySelector('.player-pager');
        const back = container.querySelector('#player-back-btn');
        if (pager && back) {
            back.after(pager);
            const [pb, nb] = pager.querySelectorAll('.player-pager-btn');
            if (pb) pb.setAttribute('aria-label', 'Previous player');
            if (nb) nb.setAttribute('aria-label', 'Next player');
        }
    }

    // The headshot uses the same plumbing the roster band does, so a missing or failed image leaves the initials tile rather than a broken glyph.
    wirePlayerAvatars(container);
    applyClubGround(container, sport);
    container.querySelectorAll('[data-reveal-pick]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('tab-btn-draft')?.click();
            revealDraftPick(btn.dataset.revealPick);
        });
    });
    // The day strip answers a hover through the app's one tooltip and not a title attribute, the same machinery the charts and heatmap use.
    attachDataTooltips(container);
    document.getElementById('player-back-btn').addEventListener('click', closePlayerDetail);

    // preserveView keeps the selected rank pool/stat/breakdown state while walking a ranking, so paging through an SS pool stays an SS-pool walk.
    const prevBtn = document.getElementById('player-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', () => openPlayerDetail(pager.prev.player.id, true));
    const nextBtn = document.getElementById('player-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', () => openPlayerDetail(pager.next.player.id, true));

    // Clicking a rank chip picks which pool's math the breakdown explains, overall or a specific position. The re-render is cheap enough to redo the whole view.
    container.querySelectorAll('.stat-chip-rank-pool').forEach(chipEl => {
        chipEl.addEventListener('click', () => {
            // This only switches which pool the breakdown explains and does not force it open. If it is open it updates in place, and if closed it stays closed.
            AppState.playerDetailRankPool = chipEl.dataset.rankPool;
            renderPlayerDetail(player);
        });
    });

    // The overall and matchup switch lives inside the breakdown's body. Its click is stopped from bubbling to the info toggle, so picking a side and opening the panel stay two different clicks.
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
        // The chart is pushed down by the explanation and not squeezed smaller, the same rule as the diagnostic console.
        wirePushPanel(rankBreakdownEl, document.getElementById('player-trend-chart'));

        // The info mark on the overall chip is the breakdown's only trigger. Setting open here still fires the native toggle event, so state stays in sync through the one listener. It is a span with a button role, so Enter and Space need their own handler.
        const infoBtn = container.querySelector('.stat-chip-info');
        if (infoBtn) {
            const toggleBreakdown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                rankBreakdownEl.open = !rankBreakdownEl.open;
            };
            infoBtn.addEventListener('click', toggleBreakdown);
            infoBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') toggleBreakdown(e);
            });
        }
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

// Builds the peer weekly-value basis for the selected timeframe. Each real week is scored against the pool's other real weeks and not an implied typical week, since a season average has far less variance. It skips shrinkage and keeps the category opportunity gating. The pool is restricted to players clearing the roto rank's minimum-games threshold, since part-timers' weeks would soften the distribution.
function weeklyBasisQualifiedPool(samePool, sport, wantPitchers = currentGroupIsSecondary(sport)) {
    const maxGames = Math.max(0, ...samePool.map(p => gamesPlayedOf(p, sport, wantPitchers)));
    if (maxGames === 0) return samePool;
    const threshold = maxGames * MIN_PLAYING_TIME_FRACTION;
    return samePool.filter(p => gamesPlayedOf(p, sport, wantPitchers) >= threshold);
}

// Coverage rule. The weekly cache only holds real data once the bulk fetch has run, so scoring against whichever few players are cached would bias the distribution. 0.9 sits above the one player a drill-down fetched individually and below a full 100 percent, which would not tolerate ESPN returning no log for a few players.
const WEEKLY_BASIS_COVERAGE_THRESHOLD = 0.9;

// Converts a derived week to per-game rates for counting stats, leaving rates and a zero-games week unchanged. This makes matchups of different length comparable, since the season's last bucket can fold several weeks and would otherwise push most arrows up at once. An in-progress week is handled by its own game count.
function perGameCountingStats(weekStatMap, games, avgStatIds) {
    if (!weekStatMap || !(games > 0)) return weekStatMap;
    const out = {};
    for (const id in weekStatMap) {
        const v = weekStatMap[id];
        out[id] = (v !== undefined && !avgStatIds.has(id)) ? v / games : v;
    }
    return out;
}

// The basis is built once per state of its inputs and not once per caller, since the chips, the chart, the verdicts and the leaderboard each asked and each build walks every qualified player's weeks. The key is the pool memo's own with the group, league and scored ids added. The harvest kick stays outside, so a thin basis still asks for the data on every call.
let weeklyBasisMemo = null;
function buildWeeklyRateBasis(sport) {
    const wantPitchers = currentGroupIsSecondary(sport);
    const { start, end } = playerTimeframeBounds(sport);
    const key = [sport, wantPitchers, AppState.timeframe, start, end, AppState.playerData, AppState.apiData,
        AppState.scoredStatIds, Object.keys(AppState.playerWeeklyCache).length, weeklyCacheVersion];
    const hit = weeklyBasisMemo && weeklyBasisMemo.key.length === key.length && weeklyBasisMemo.key.every((v, i) => v === key[i]);
    if (!hit) weeklyBasisMemo = { key, ...computeWeeklyRateBasis(sport, wantPitchers) };
    if (weeklyBasisMemo.thin && !bulkWeeklyFetchInFlight && !bulkWeeklyFetchFailed) ensureLeaderboardWeeklyDataLoaded(sport, 'basis');
    return weeklyBasisMemo.basis;
}

// The build itself. A thin result says the real-value basis could not be used, so the caller knows to ask for weekly data.
function computeWeeklyRateBasis(sport, wantPitchers) {
    const samePool = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    // Scoped to the current group's role so a two-way player's off-role stats do not leak into this pool's categories.
    const pitchingIds = roleIdSetFor(sport);
    const relevantStatIds = Array.from(AppState.scoredStatIds).filter(id =>
        (wantPitchers ? pitchingIds.has(id) : !pitchingIds.has(id)) && samePool.some(p => p.seasonTotals[id] !== undefined));
    const { start: windowStart, end: windowEnd } = playerTimeframeBounds(sport);
    const inverseStatIds = leagueInverseIds(sport);
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
                    // Per game, so a long final bucket does not dominate the distribution.
                    return { stats: perGameCountingStats(cache.weekly[w], games, avgStatIds), games };
                });
            return { id: p.id, seasonTotals: p.seasonTotals, weeks };
        });
        const categoryRates = buildWeeklyValueBasis(weeklyValuesByPlayer, { sport, relevantStatIds, inverseStatIds, avgStatIds });
        // Every category came back empty, such as a new single-matchup window with no completed weeks. It falls through to the season-average basis. The per-game flag tells the score callers to normalize the scored week the same way.
        if (categoryRates.length > 0) return { thin: false, basis: { categoryRates, windowStart, windowEnd, perGame: true } };
    }

    // When coverage is too thin the answer is marked thin and the caller starts the leaderboard's existing bulk fetch, reusing its lazy trigger. It is not awaited and re-renders the leaderboard, so a chart opened meanwhile keeps the fallback basis until reopened.
    const categoryRates = buildCategoryRateBasis(samePool, {
        sport, relevantStatIds, inverseStatIds, avgStatIds,
        weeksElapsed: Math.max(1, windowEnd - windowStart + 1)
    });
    return { thin: true, basis: { categoryRates, windowStart, windowEnd, perGame: false } };
}

function computeWeeklyRankSeries(player, sport, weekly, weeks) {
    const { categoryRates, perGame } = buildWeeklyRateBasis(sport);
    const avgStatIds = AVERAGE_STATS[sport] || new Set();
    const weeklySums = (AppState.playerWeeklyCache[player.id] || {}).weeklySums || {};
    const scores = {};
    weeks.forEach(w => {
        // Scores in the units the basis was built in, per game for the value basis and per week for the season-average fallback.
        const games = (weeklySums[w] && weeklySums[w].games) || 0;
        const stats = perGame ? perGameCountingStats(weekly[w], games, avgStatIds) : weekly[w];
        const score = scoreWeekAgainstBasis(player, stats, categoryRates);
        if (score !== null) scores[w] = score;
    });
    return scores;
}

// How much a weekly Matchup Score has to move off the player's own average (in percentile points) before it counts as a real trend rather than ordinary week-to-week noise.
const TREND_THRESHOLD = 10;

// Below this fraction of the current matchup, no arrows show, since one hot or cold day prorates into a wild pace. A quarter is roughly two days into a seven-day matchup.
const MIN_TREND_FRACTION = 0.25;

// Weekly-form arrows for the rank column. Each player's matchup score in the window's final matchup is compared against their own average across the window. Clearly above trends up and clearly below trends down. It uses the drill-down chart's basis. Players without cached data, a score in the final matchup or another scored week get no arrow.
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
            // One line in the legend row's vocabulary, so the arrow, legend and colour read as one system. It names the matchup the arrow describes and appends the figures that set the direction.
            tip: `${delta > 0 ? 'Above' : 'Below'} average in matchup ${windowEnd} (${latest.toFixed(1)} vs ${avg.toFixed(1)})`
        });
    });
    return icons;
}

// Builds the day-axis series for the drill-down, or null when this is not the current window. Null leaves everything else alone, and a current window with no resolvable days falls back to the matchup axis. The line stops at today and does not extend flat to the matchup's last day.
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


// ==== Player comparison, one anchor, one opponent, one view ====

// Loads weekly history for a player who is not the drill-down's subject. It makes the same request and fills the same cache, so a comparison adds no new request shape. It does not touch the diagnostic panel, which names the anchor, since repointing it would put one player's raw data under another's name.
async function ensureComparisonWeekly(playerId, sport) {
    // The same condition the drill-down uses, not merely whether anything is cached. A bulk entry has no per-day sums and an empty harness entry would leave the opponent unable to draw a day-axis line while the anchor drew one.
    const cached = AppState.playerWeeklyCache[playerId];
    if (cached && cached.dailyByPeriod) return true;
    try {
        const raw = await fetchPlayerWeeklyStats(playerId);
        AppState.playerWeeklyCache[playerId] = processPlayerWeeklyHistory(raw, sport);
        return true;
    } catch {
        // Whatever was cached stays, since a matchup-axis line beats none. A comparison that cannot draw the second line is still worth showing, and the chart says so itself.
        return false;
    }
}

function ensureComparePickerModal() {
    let overlay = document.getElementById('compare-modal-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'compare-modal-overlay';
    // The rank explainer's chrome is reused, with the same overlay, panel and close control, so the two modals cannot drift into two dialogs.
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

// Opens the picker for another player to compare. It is scoped to the anchor's role group, so every pair is ranked against the same pool. It is ordered by the league ranking, has a search box and is not capped, since a truncated list would make a missing player look unrostered. The options exclude more than the anchor so a pick cannot collide with the group. The pick handler is required.
function openComparePicker(anchor, opts = {}) {
    const { excludeIds = null, onPick } = opts;
    const sport = AppState.loadedSport;
    const wantPitchers = currentGroupIsSecondary(sport);
    // Ranked against the whole group and filtered afterwards. Ranking the anchor out first renumbers everyone below, so the second best would show as number one. The position filter hides rows and never renumbers them, so a shortstop's rank is the rank among batters.
    const group = getEffectivePlayerPool(sport).filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const ranks = computeLeagueRanks(group, sport, null, wantPitchers).ranks;
    const hidden = excludeIds ? new Set(excludeIds) : new Set([anchor.id]);
    const ordered = group.filter(p => !hidden.has(p.id))
        .sort((a, b) => (ranks.get(a.id) || Infinity) - (ranks.get(b.id) || Infinity) || a.name.localeCompare(b.name));

    const overlay = ensureComparePickerModal();

    // The picker only offers the anchor's own group, so the scoping needs no sentence.
    const posSel = overlay.querySelector('#compare-modal-position');
    const positions = positionOptionsFor(ordered, sport, wantPitchers);
    posSel.innerHTML = '<option value="ALL">All Positions</option>' +
        positions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    // One position is the whole group, so the filter would have nothing to do. It is the same call the leaderboard makes.
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
                onPick(Number(row.dataset.playerId));
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

// Drops the group entirely and keeps the anchor. The group screen falls back to this once fewer than two players would be left, and a group of one is not a comparison.
function closePlayerComparison() {
    const sport = AppState.loadedSport;
    const anchor = getEffectivePlayerPool(sport).find(p => p.id === AppState.selectedPlayerId);
    AppState.playerCompareGroupIds = [];
    if (anchor) renderPlayerDetail(anchor);
    else closePlayerDetail();
}

// Fetches whatever of the group's weekly history is missing and then renders. Every entry into the group screen goes through here, so none can draw a chart missing a line because a player's history never arrived. A single other player is this group's one-other case.
async function openPlayerGroupComparison(ids) {
    const sport = AppState.loadedSport;
    const container = document.getElementById('player-detail-container');
    if (container) container.innerHTML = '<div class="player-loading">Loading the comparison...</div>';
    await Promise.all(ids.map(id => ensureComparisonWeekly(id, sport)));
    renderPlayerGroupComparison(ids);
}

// The group screen. A group of one other is the two-player ledger, so two picks draw this same screen with two columns and two lines and no second renderer. The look's accent as a hue, a saturation and a lightness, read off the resolved token so every look and theme has its own.
function accentHsl() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    let r = 77, g = 155, b = 255;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(raw);
    if (hex) {
        const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else if (rgb) {
        r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
    }
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: sat, l };
}

function renderPlayerGroupComparison(ids) {
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const pool = getEffectivePlayerPool(sport);
    const byId = new Map(pool.map(p => [p.id, p]));
    const anchor = byId.get(ids[0]);
    // The anchor is the one player this screen cannot run without. Any other id missing from the pool, after a timeframe change or league switch, is dropped and not drawn as a blank column.
    if (!anchor) { AppState.playerCompareGroupIds = []; closePlayerDetail(); return; }
    const liveIds = [anchor.id, ...ids.slice(1).filter(id => byId.has(id) && id !== anchor.id)];
    AppState.playerCompareGroupIds = liveIds;
    if (liveIds.length < 2) { renderPlayerDetail(anchor); return; }

    const wantPitchers = currentGroupIsSecondary(sport);
    const groupPool = pool.filter(p => matchesPlayerGroup(p, sport, wantPitchers));
    const weeklyOf = (id) => (AppState.playerWeeklyCache[id] || {}).weekly || {};
    // The anchor decides which categories the table shows, since the anchor decided which group tab the pick came from.
    const { scored, advanced } = statIdsForPlayer(anchor, sport, weeklyOf(anchor.id));
    const visibleIds = AppState.showAdvancedStats ? [...scored, ...advanced] : scored;
    const result = comparePlayerGroup(groupPool, anchor.id, liveIds.slice(1), {
        statIds: visibleIds, inverseStatIds: leagueInverseIds(sport), statMap
    });
    // This cannot happen through the screen's own controls, which stop at the maximum, but a group carried in from elsewhere could hand it more, so it trims and does not show nothing.
    if (result.refused) return renderPlayerGroupComparison(liveIds.slice(0, 1 + PLAYER_GROUP_MAX_OTHERS));

    const leagueRanks = computeLeagueRanks(groupPool, sport, null, wantPitchers);
    const label = groupLabels(sport)[wantPitchers ? 'secondary' : 'primary'];
    // Each compared player's colour, by pick order, from the look's accent rotated round the wheel; never a team colour.
    const palette = comparePalette(accentHsl(), liveIds.length);
    const colorOf = (id) => (palette[liveIds.indexOf(id)] || palette[0]).css;

    // A real table with one row per scored category and one column per player. The head cell keeps its content and only its container moves.
    const headCellHtml = (id) => {
        const p = byId.get(id);
        const isAnchor = id === anchor.id;
        const rank = leagueRanks.ranks.get(id);
        const games = gamesPlayedOf(p, sport, wantPitchers);
        const starHtml = isAnchor
            ? '<span class="ph-star ph-star-on">&#9733;</span>'
            : `<button type="button" class="ph-star" data-anchor-id="${p.id}" title="Make ${escapeHtml(p.name)} the anchor">&#9734;</button>`;
        const metaBits = [escapeHtml(p.teamName), escapeHtml(p.positionDisplay),
            rank ? `#${rank} of ${leagueRanks.total}` : 'Unranked', `${games} GP`];
        if (isAnchor) metaBits.push('anchor');
        return `<th class="cmpn-head-cell" style="--cmp-color:${colorOf(id)}">
            <div class="ph${isAnchor ? ' ph-anchor' : ''}">
                ${buildPlayerAvatarHtml(sport, p.id, p.name)}
                <div class="ph-text">
                    <div class="ph-name">${starHtml}<span class="ph-name-text">${escapeHtml(p.name)}</span>${injuryBadgeHtml(p.injuryStatus)}</div>
                    <div class="ph-meta">${metaBits.join(' &middot; ')}</div>
                </div>
                ${isAnchor ? '' : `<button type="button" class="ph-x" data-remove-id="${p.id}" title="Remove ${escapeHtml(p.name)}">&times;</button>`}
            </div>
        </th>`;
    };
    const canAdd = liveIds.length < 1 + PLAYER_GROUP_MAX_OTHERS;
    const headHtml = `<div class="cmpN-h">
        <span class="cmpN-h-label">${escapeHtml(label)}</span>
        ${canAdd ? '<button type="button" class="ph ph-add" id="group-add-player">+ Add player</button>' : ''}
    </div>`;

    const rows = result.rows || [];
    // Every figure carries its own league rank and not a delta against the anchor, so moving the star changes no number. The rank is the one the drill-down's own stat chips read, so a figure here matches the one a reader finds alone.
    const cellHtml = (row, id) => {
        const cell = (row.cells || []).find(c => c.id === id);
        if (!cell || cell.value === null) return '<td class="cmpn-cell"><span class="v v-none">-</span></td>';
        const cls = row.bestIds.includes(id) ? ' best' : (row.worstIds.includes(id) ? ' worst' : '');
        const rankHtml = cell.rank ? `<small>#${cell.rank} of ${cell.total}</small>` : '';
        return `<td class="cmpn-cell" style="--cmp-color:${colorOf(id)}"><span class="v${cls}">${escapeHtml(formatStatValue(cell.value))}${rankHtml}</span></td>`;
    };
    const rowLineHtml = (row) => `<tr class="cmpn-row">
        <th scope="row" class="cmpn-cat">${escapeHtml(row.name)}${row.inverse ? '<span class="cmpN-inv" title="Lower is better">&darr;</span>' : ''}</th>
        ${liveIds.map(id => cellHtml(row, id)).join('')}
    </tr>`;
    // Rows won counts how many categories each player leads. The leader lookup is inverse-aware and tie-aware, so a level row counts for everyone tied at the top.
    const wonCount = (id) => rows.filter(row => row.bestIds.includes(id)).length;
    const footRowHtml = rows.length ? `<tr class="cmpn-row cmpn-foot">
        <th scope="row" class="cmpn-cat">Rows won</th>
        ${liveIds.map(id => `<td class="cmpn-cell" style="--cmp-color:${colorOf(id)}"><span class="v"><b>${wonCount(id)}</b> of ${rows.length}</span></td>`).join('')}
    </tr>` : '';
    const tableHtml = rows.length
        ? `<div class="cmpn-table-wrap"><table class="cmpn-table">
            <colgroup><col class="cmpn-col-cat">${liveIds.map(() => '<col>').join('')}</colgroup>
            <thead><tr class="cmpn-head-row"><th class="cmpn-corner"></th>${liveIds.map(headCellHtml).join('')}${canAdd ? '<th class="cmpn-add-cell"><button type="button" class="ph ph-add ph-add-cell">+ Add player</button></th>' : ''}</tr></thead>
            <tbody>${rows.map(rowLineHtml).join('')}</tbody>
            <tfoot>${footRowHtml}</tfoot>
        </table></div>`
        : `<div class="cmp-pick-empty">No scored categories to compare in this timeframe.</div>`;

    // The same stat picker the single drill-down carries, driving the same kind of chart with one line per player, never a second charting surface.
    const { options: statOptions, preferred } = buildTrendStatOptions(anchor, sport, weeklyOf(anchor.id));
    const currentStat = statOptions.find(s => s.id === AppState.playerDetailStat) || preferred;
    if (currentStat) AppState.playerDetailStat = currentStat.id;
    const legendHtml = liveIds.map((id, i) => {
        const p = byId.get(id);
        const color = colorOf(id);
        return `<span class="cmpN-legend-chip"><i style="background:${color}"></i><span class="cmpN-legend-name" style="color:${color}">${escapeHtml(p.name)}</span>${id === anchor.id ? ' <small>&#9733;</small>' : ''}</span>`;
    }).join('');

    const container = document.getElementById('player-detail-container');
    container.innerHTML = `
        <div class="dd-head">
            <button type="button" class="mt-crumb" id="group-back">&lsaquo; Leaderboard</button>
            <span class="dd-title">Comparing <b>${liveIds.length} players</b></span>
        </div>
        <div class="cmpN">
            ${headHtml}
            ${tableHtml}
        </div>
        <div class="cmpN-chart-card">
            <div class="cmpN-chart-tools">
                ${statOptions.length ? `<select id="player-stat-picker">${statOptions.map(s => `<option value="${s.id}"${currentStat && s.id === currentStat.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
                <span class="cmpN-legend">${legendHtml}</span>
            </div>
            <div id="player-trend-chart" class="graph-viewport" style="flex:1; min-height:220px;"></div>
        </div>
    `;

    wirePlayerAvatars(container);
    document.getElementById('group-back').addEventListener('click', closePlayerDetail);
    container.querySelectorAll('.ph-star[data-anchor-id]').forEach(el => {
        el.addEventListener('click', () => {
            const id = Number(el.dataset.anchorId);
            renderPlayerGroupComparison([id, ...liveIds.filter(x => x !== id)]);
        });
    });
    container.querySelectorAll('.ph-x[data-remove-id]').forEach(el => {
        el.addEventListener('click', () => {
            const id = Number(el.dataset.removeId);
            const remaining = liveIds.filter(x => x !== id);
            if (remaining.length < 2) closePlayerComparison();
            else renderPlayerGroupComparison(remaining);
        });
    });
    container.querySelectorAll('#group-add-player, .ph-add-cell').forEach(addBtn => addBtn.addEventListener('click', () => openComparePicker(anchor, {
        excludeIds: liveIds,
        onPick: (id) => openPlayerGroupComparison([...liveIds, id])
    })));

    const picker = document.getElementById('player-stat-picker');
    if (picker) picker.addEventListener('change', (e) => {
        AppState.playerDetailStat = e.target.value;
        renderPlayerGroupComparison(liveIds);
    });

    // Fitted in the same task as the swap, so the screen's first painted frame is already the settled one.
    if (window.leaguewiseFitNow) window.leaguewiseFitNow();
    if (currentStat) drawGroupTrendChart(liveIds, currentStat, byId, palette.map(c => c.css));
    else document.getElementById('player-trend-chart').innerHTML = '<div class="player-loading">No stat history available to chart.</div>';
}

// The group chart. It is matchup axis only, with one series call for every line so they cannot disagree. It does not use the single-player day-axis and zoom machinery, which is built around one comparison line. That richness stays on the single-player view.
function drawGroupTrendChart(ids, stat, byId, colors) {
    const container = document.getElementById('player-trend-chart');
    const sport = AppState.loadedSport;
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const isWeeklyPoints = stat.id === WEEKLY_POINTS_STAT_ID;
    const weeklyById = {};
    ids.forEach(id => { weeklyById[id] = (AppState.playerWeeklyCache[id] || {}).weekly || {}; });

    // The score by matchup and points series are synthetic, scored per period against a pool or bucket, so both go through the series function's one scoring hook. An ordinary stat needs no options, since the function reads it from the weekly data itself.
    const seriesOpts = isWeeklyRank
        ? { scoreOf: (id, matchup) => {
            const p = byId.get(id);
            if (!p) return null;
            const scores = computeWeeklyRankSeries(p, sport, weeklyById[id], [matchup]);
            return scores[matchup] ?? null;
        } }
        : isWeeklyPoints
            ? { scoreOf: (id, matchup) => {
                const bucket = weeklyById[id][matchup];
                return bucket ? pointsForStatBucket(bucket, byId.get(id), sport) : null;
            } }
            : {};
    const drawn = groupMatchupSeries(weeklyById, ids, stat.id, seriesOpts);

    const axis = [...new Set(drawn.flatMap(s => s.points.map(p => p.matchup)))].sort((a, b) => a - b);
    if (!axis.length) { container.innerHTML = '<div class="player-loading"><span class="stat-chip-info" role="button" tabindex="0" data-tooltip="No weekly history for this stat yet." title="No weekly history for this stat yet.">&#9432;</span></div>'; return; }

    const svgWidth = Math.max(300, container.clientWidth || 800);
    const svgHeight = Math.max(180, container.clientHeight || 300);
    const padding = 45;
    const allValues = drawn.flatMap(s => s.points.map(p => p.value)).filter(v => v !== null);
    const maxVal = getNiceMax(Math.max(...allValues, 0));
    const numPts = axis.length - 1;
    const xOf = (i) => padding + (numPts === 0 ? 0 : (i / numPts) * (svgWidth - padding * 2));
    const yOf = (v) => svgHeight - padding - (v / (maxVal || 1)) * (svgHeight - padding * 2);

    let svgStr = `<svg width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display:block;">`;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        const tickVal = maxVal - (i / 4) * maxVal;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${isWeeklyPoints ? tickVal.toFixed(1) : formatStatValue(tickVal)}</text>`;
    }
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil((numPts + 1) / maxLabels));
    axis.forEach((matchup, i) => {
        if (i % labelStep === 0 || i === numPts) {
            svgStr += `<text x="${xOf(i)}" y="${svgHeight - 10}" font-size="11" text-anchor="middle" style="fill:var(--chart-axis)">${formatMatchupLabel(matchup)}</text>`;
        }
    });

    const colorFor = (i) => (colors && colors[i]) || (i === 0 ? 'var(--accent)' : `var(--group-line-${i})`);
    // One hover tip names every player's figure. A wide invisible hit column sits at each axis point and not per dot, since a group's dots at one matchup can be a few pixels apart and a per-dot hover would miss between them.
    const colW = numPts === 0 ? (svgWidth - padding * 2) : (svgWidth - padding * 2) / numPts;
    axis.forEach((matchup, i) => {
        const names = drawn.map((s, si) => {
            const pt = s.points.find(p => p.matchup === matchup);
            if (!pt || pt.value === null) return null;
            const p = byId.get(s.id);
            // The score by matchup keeps one decimal, matching the single-player chart's dot tooltip. A category stat needs no case, since the formatter prints an integer bare and only a rate gets decimals.
            const shown = (isWeeklyPoints || isWeeklyRank) ? pt.value.toFixed(1) : formatStatValue(pt.value);
            return `${p ? p.name : s.id}${MIDDOT_SEP}${shown}`;
        }).filter(Boolean).join(MIDDOT_SEP);
        if (!names) return;
        const tip = `${formatMatchupLabel(matchup)}${MIDDOT_SEP}${names}`;
        svgStr += `<rect x="${xOf(i) - colW / 2}" y="${padding}" width="${colW}" height="${svgHeight - padding * 2}" fill="transparent" data-tooltip="${escapeHtml(tip)}" />`;
    });

    drawn.forEach((s, i) => {
        const pts = s.points.map(p => ({ x: xOf(axis.indexOf(p.matchup)), y: p.value === null ? null : yOf(p.value) })).filter(p => p.y !== null);
        const color = colorFor(i);
        svgStr += `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="${i === 0 ? 3 : 1.8}" style="stroke:${color}" opacity="${i === 0 ? 1 : 0.85}" />`;
        // The anchor draws bold with its points and the others as a thin line alone, the hierarchy the two-player chart used.
        if (i === 0) pts.forEach(p => { svgStr += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}" />`; });
    });
    svgStr += '</svg>';
    container.innerHTML = svgStr;
    attachDataTooltips(container);
}

// The zoom. A matchup point is a door, and clicking it redraws the chart over that matchup's own days. The state is one record keyed to the player, stat and timeframe it was opened under, so a different drill-down, picker change or timeframe move closes it, since a zoom has no meaning under another stat. The last chart arguments are how a click redraws with the same call.
let chartZoom = null;
let lastTrendArgs = null;

// The minimum-matchups rule lives in utils.js, so the Team Metrics filters line reads the same rule.

function drawPlayerTrendChart(player, stat, weekly, maxWk) {
    const container = document.getElementById('player-trend-chart');
    const sport = AppState.loadedSport;
    lastTrendArgs = { player, stat, weekly, maxWk };
    if (chartZoom && (chartZoom.playerId !== player.id || chartZoom.statId !== stat.id || chartZoom.timeframe !== AppState.timeframe)) chartZoom = null;

    // Weekly data is already keyed by fantasy week and summed or averaged per stat, since the day-to-week rollup happened once using the league's own schedule. The max week is the effective one, so a league whose schedule ends before the real season does not cut off the all-season option.
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, maxWk, AppState.regSeasonWeeks, AppState.currentMatchup);
    const isWeeklyRank = stat.id === WEEKLY_RANK_STAT_ID;
    const isWeeklyPoints = stat.id === WEEKLY_POINTS_STAT_ID;

    // At the current window, and only there, the axis becomes the days of the matchup being played, because one matchup on a matchup axis is a single point. The day series is null for anyone with no day-level history or who played none of the days, which leaves the old behaviour. The zoom is the other way onto a day axis.
    const zoomDays = chartZoom ? buildZoomDaySeries(player, stat, chartZoom.matchup, isWeeklyRank, isWeeklyPoints, sport) : null;
    if (chartZoom && !zoomDays) chartZoom = null;
    // A season span with one matchup plots a single point, which reads as a flat line. A line needs the minimum number of matchups, so a window holding fewer opens on the days of its matchup for every picker. A window with enough matchups is untouched. Only settled matchups count, so one finished matchup and a live one still open on the live matchup's days.
    const liveWeek = liveMatchupHeldApart();
    const matchupsInWindow = Object.keys(weekly).map(Number).filter(w => weekly[w] && w !== liveWeek && w >= tfStart && w <= tfEnd).length;
    const sparseDays = (!chartZoom && !zoomDays && matchupsInWindow < MIN_MATCHUPS_FOR_A_LINE)
        ? buildZoomDaySeries(player, stat, tfEnd || tfStart, isWeeklyRank, isWeeklyPoints, sport) : null;
    const dayAxis = zoomDays || sparseDays || buildDayAxisSeries(player, stat, tfStart, tfEnd, isWeeklyRank, isWeeklyPoints);
    const zoomed = !!(chartZoom && dayAxis);
    // A zoomed per-pool picker plots day self-scores, a 0 to 100 figure of their own and not a cumulative run of the stat, which the header arithmetic needs to know.
    const zoomSelfScore = !!dayAxis && (isWeeklyRank || isWeeklyPoints);

    // The x positions that exist, the weeks this player has data for.
    const weeksOf = (p, weeklyP, axis) => axis
        ? axis.days.map(d => d.index)
        : Object.keys(weeklyP).map(Number).filter(w => w >= tfStart && w <= tfEnd).sort((a, b) => a - b);
    const weeks = weeksOf(player, weekly, dayAxis);

    // One player's values on the shared axis. A position with no data is null and not zero, since a missed matchup is an absence. A week played with nothing posted is a real zero, so the check is on the week's presence in the cache.
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
    // The matchup being played is drawn apart from the line as a hollow point, and its partial total is in neither the header's average nor the verdict baseline. The full list keeps it for the scale and the gap note.
    const liveWk = dayAxis ? null : liveMatchupHeldApart();
    const plottedAll = actualValues.filter(v => v !== null);
    const plotted = liveWk === null ? plottedAll : actualValues.filter((v, i) => v !== null && weeks[i] !== liveWk);
    // Day N is the vocabulary the race cards use, and the axis unit stays untouched. On a day axis the tick is the real date when the schedule can supply one and Day N until then. The period behind each index is what the verdicts are keyed by.
    const periodOfIndex = dayAxis ? new Map(dayAxis.days.map(d => [d.index, d.period])) : null;
    if (dayAxis) ensureScheduleDates();
    const labelFor = dayAxis ? (i) => dayChipLabel(periodOfIndex.get(i), i + 1) : formatMatchupLabel;

    const isRateStat = (AVERAGE_STATS[sport] || new Set()).has(stat.id);
    // At a windowed timeframe the drilled player's totals are the windowed aggregate, so a header reading "Season Total" over them would wear the wrong label.
    const windowed = !isFullSeasonTimeframe();

    // Per-week gap notes were removed as mostly noise. The season-total mismatch check stays as a real safety net, firing only when the weeks shown do not add up to ESPN's verified total. The note has no meaning on the day axis, where it summed a cumulative series. The valid check there is that the last value equals the windowed aggregate, which needs different wording.
    const gapNotes = [];
    if (!dayAxis && !isWeeklyRank && !isWeeklyPoints && !isRateStat) {
        const plottedSum = plottedAll.reduce((a, b) => a + b, 0);
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
        // The reference line is the mean of the exact weekly scores plotted. It is not the season rank score, which comes from a different formula and made the line look arbitrary.
        avgVal = plotted.length ? plotted.reduce((a, b) => a + b, 0) / plotted.length : 0;
        actualTotal = avgVal;
        // Matches the stat option's own rename, in sentence case because it reads inline.
        avgLabel = `Avg score by ${axisUnit().long.toLowerCase()}`;
        totalLabel = avgLabel;
    } else {
        // Rate stats use ESPN's verified season rate for the reference line. Counting stats average the exact plotted values, because dividing the season total by the weeks cached inflated the line wherever ESPN's history had a gap. Points have no season entry, so the total is what the plotted matchups add up to, which is also the honest figure for a window. A cumulative series' last point is the window's total already.
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
    // A mean of a cumulative series is noise, and the per-matchup average names an axis this chart no longer has. The total alone is the honest header for a day series. The self-score zoom has no total, and the mean of day scores is the one figure that reads.
    if (zoomSelfScore) {
        actualTotal = plotted.length ? plotted.reduce((a, b) => a + b, 0) / plotted.length : 0;
        totalLabel = 'Avg Day Score';
    }
    const showAvgLine = !dayAxis;
    if (!showAvgLine) avgVal = 0;
    const avgDisplay = (isWeeklyRank || isWeeklyPoints) ? avgVal.toFixed(1) : formatStatValue(avgVal);
    // The matchup score's total and average are one number, so only the one reference-line stat is shown, matching the single dashed line.
    const totalStatHtml = (isWeeklyRank && !zoomSelfScore) ? '' : `<div class="trend-fig" title="${escapeHtml(totalLabel)}"><span class="fig-full">${totalLabel}: </span><span class="fig-short">Total </span><strong>${zoomSelfScore ? Math.round(actualTotal) : (isWeeklyPoints ? Number(actualTotal).toFixed(1) : formatStatValue(actualTotal))}</strong></div>`;
    // The matchup score is the app's own computed stat, so it is the one chart that explains itself. It opens from a click and not a hover sentence, with a worked example from the player's own latest plotted week so the reader sees the number being made. It names the renamed stat, since the two figures must not share a word.
    const matchupScoreInfo = isWeeklyRank
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
        : `<span class="trend-name">${escapeHtml(stat.name)}</span><span class="trend-rest"> - ${trendLabel} Trend</span>`;
    const avgStatHtml = showAvgLine
        ? `<div class="trend-fig" title="${escapeHtml(avgLabel)}" style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:var(--chart-avg); border-top:2px dashed var(--chart-avg);"></span><span class="fig-full"> ${avgLabel}: </span><span class="fig-short">Avg </span><strong>${avgDisplay}</strong></div>`
        : '';
    const summary = `
        <div class="trend-head" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
            <h4 style="margin:0; font-size:14px; color:var(--text-body); display:flex; align-items:center; gap:8px;">${zoomCrumbHtml}<span>${headingText}</span>${matchupScoreInfo}</h4>
            <div class="trend-figs" style="font-size:12px; color:var(--text-muted); display:flex; gap:15px; align-items:center;">
                ${totalStatHtml}${avgStatHtml}
            </div>
        </div>
        ${gapNoteHtml}
    `;

    // The summary renders first with a placeholder, so the chart's wrapper gets its final flex size before it is measured. A fixed viewBox was letterboxed when the aspect ratio did not match.
    container.innerHTML = summary + '<div id="player-trend-svg-wrap" style="flex:1; min-height:0;"></div>';
    const svgWrap = document.getElementById('player-trend-svg-wrap');

    // What is absent is the player's own weekly lines in this window, not the stat's. Every stat id in a season line is present in the weekly lines, so no stat lacks a weekly form. What varies is the player, and many pool players carry no weekly line. The line says whose lines are missing, over what window and whether any exist elsewhere, as a fact and not advice.
    if (weeks.length === 0) {
        const cached = Object.keys(weekly || {}).map(Number).filter(Number.isFinite);
        const name = escapeHtml(player.name || 'this player');
        const line = cached.length
            ? `No weekly lines for ${name} in this timeframe. ${cached.length} in other matchups.`
            : `No weekly lines for ${name} this season.`;
        // An empty chart area with a mark whose hover holds the fact, not a sentence on the face.
        svgWrap.innerHTML = `<div class="player-loading player-loading-mark"><span class="hint" tabindex="0" role="button" aria-label="No weekly lines" data-hint="${line}">&#9432;</span></div>`;
        return;
    }

    const svgWidth = Math.max(300, svgWrap.clientWidth || 800);
    const svgHeight = Math.max(180, svgWrap.clientHeight || 300);
    const padding = 45;
    // The average is included so the reference line always lands inside the plotted range, even if the weekly data misses games the season total has.
    const maxVal = getNiceMax(Math.max(...plottedAll, avgVal, 0));
    const numWeeks = weeks.length - 1;

    let svgStr = `<svg width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display:block;">`;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        // The shared value formatter is used and not a fixed one-decimal label, which rounded rates so a point looked as if it sat above a gridline.
        const tickVal = maxVal - (i / 4) * maxVal;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${isWeeklyPoints ? tickVal.toFixed(1) : formatStatValue(tickVal)}</text>`;
    }

    // The same dashed playoff-start marker as the team trend graph, adapted for this x-axis. Weeks are spaced by array index, so the boundary sits between the two adjacent displayed weeks that straddle the regular-season split.
    if (numWeeks > 0 && AppState.regSeasonWeeks >= tfStart && AppState.regSeasonWeeks < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.regSeasonWeeks);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
        }
    }

    // A second boundary marks where the league's last matchup concluded, since the real season keeps producing stats after it. It shows only once the season is over, because mid-season the last completed matchup is not an end. The playoff separator keys off the regular-season weeks and is unaffected.
    if (AppState.isSeasonOver && numWeeks > 0 && AppState.maxCompletedWeek >= tfStart && AppState.maxCompletedWeek < tfEnd) {
        const splitIdx = weeks.findIndex(w => w > AppState.maxCompletedWeek);
        if (splitIdx > 0) {
            const boundaryX = padding + ((splitIdx - 0.5) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="2,2" style="stroke:var(--chart-boundary)" />`;
            svgStr += `<text x="${boundaryX + 4}" y="${svgHeight - padding + 16}" font-size="10" text-anchor="start" style="fill:var(--text-subtle)">End of league season</text>`;
        }
    }

    // Caps x-axis labels at a fixed number. A constant integer step keeps every gap the same size, and the last point is forced in, so only one gap, the last, differs. Rounding label positions to hit both ends alternated two gap sizes across the whole chart. It is the same approach as the team-level trend chart.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil((numWeeks + 1) / maxLabels));
    const labelIndices = new Set();
    for (let i = 0; i <= numWeeks; i += labelStep) labelIndices.add(i);
    labelIndices.add(numWeeks);

    const actualPts = [];
    weeks.forEach((w, i) => {
        const x = padding + (numWeeks === 0 ? 0 : (i / numWeeks) * (svgWidth - padding * 2));
        const yFor = (v) => svgHeight - padding - (v / maxVal) * (svgHeight - padding * 2);

        // A null is skipped and not plotted, so the line joins the points either side of a gap and the week is left off the axis.
        if (actualValues[i] !== null) actualPts.push({ x, y: yFor(actualValues[i]), week: w, value: actualValues[i] });
        if (labelIndices.has(i)) {
            svgStr += `<text x="${x}" y="${svgHeight - 10}" font-size="11" text-anchor="middle" style="fill:var(--chart-axis)">${labelFor(w)}</text>`;
        }
    });

    // Weekly average reference line, drawn under the data line so individual points still stand out clearly above/below it.
    if (showAvgLine) {
        const avgY = svgHeight - padding - (avgVal / maxVal) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${avgY}" x2="${svgWidth - padding}" y2="${avgY}" stroke-width="1.5" stroke-dasharray="6,4" style="stroke:var(--chart-avg)" />`;
    }

    // The colours are tokens, so each style chooses its own. Every point wears a verdict. On the matchup axis the season-best week is gold, a week over the player's own median is green, under it is red and at it is grey. On a day axis the day grammar does the same job. The line stays the accent, so colour reads each point and is not a fourth series.
    const dayInfo = dayAxis ? dayInfoFor(player, sport, dayAxis.days.map(d => d.period)) : null;
    const matchupVerdicts = !dayAxis ? matchupVerdictInfo(player, sport, weekly, stat, isWeeklyRank, isWeeklyPoints) : null;
    const verdictOf = (p) => {
        if (dayInfo) {
            const v = dayInfo.byPeriod.get(periodOfIndex.get(p.week))?.verdict;
            return v === 'signature' ? 'best' : (v === 'ordinary' ? 'even' : (v || 'even'));
        }
        if (matchupVerdicts) return matchupVerdicts.verdictOf(p.value, p.week);
        return null;
    };
    const verdictColour = { best: 'var(--medal-gold)', above: 'var(--success)', below: 'var(--danger)', even: 'var(--text-faint)', off: 'var(--text-faint)' };
    const drawSeries = (allPts, color) => {
        // The live matchup's point is left off the line and drawn apart as a hollow point in the line's colour.
        const pts = liveWk === null ? allPts : allPts.filter(p => p.week !== liveWk);
        svgStr += `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="2.5" style="stroke:${color}" />`;
        allPts.forEach(p => {
            const isLive = liveWk !== null && p.week === liveWk;
            const verdict = isLive ? null : verdictOf(p);
            const dotColour = verdict ? verdictColour[verdict] : color;
            // The hover on a zoomed or Current day carries what the chips used to say (C-B): the day's self-score and its notable line, after the chart's own number for the day.
            const day = dayInfo ? dayInfo.byPeriod.get(periodOfIndex.get(p.week)) : null;
            // A stat chart's day hover names that stat and no other, the day's own count after the running figure the chart plots. The day score and notable line belong to the two per-pool charts, where every stat factors in. A rate has no count of its own in a day's sums, so it names nothing extra.
            const ownCount = day && day.played && !(AVERAGE_STATS[sport] || new Set()).has(String(stat.id))
                ? Number(AppState.playerWeeklyCache[player.id]?.dailyByPeriod?.[periodOfIndex.get(p.week)]?.sums?.[stat.id]) || 0
                : 0;
            const dayExtra = ownCount ? `+${ownCount} ${stat.name}` : '';
            // No opponent or matchup info shows here, since a player may have been picked up partway through the season and a matchup that week does not mean they were rostered for it. Points are a scored total and not a rate, with one decimal, the precision the league shows. A day self-score is already an integer.
            const displayValue = zoomSelfScore ? String(Math.round(p.value)) : ((isWeeklyRank || isWeeklyPoints) ? p.value.toFixed(1) : formatStatValue(p.value));
            // The label comes from the axis label function and not the unit plus the raw x-value. On the day axis those values are zero-based indexes, which read as the wrong noun and off by one.
            const pointLabel = dayAxis ? labelFor(p.week) : `${axisUnit().long} ${p.week}`;
            // A zoomed per-pool picker's value IS the day score, so the hover does not say it twice.
            const figure = zoomSelfScore ? `Day score ${escapeHtml(displayValue)}` : `${escapeHtml(displayValue)} ${escapeHtml(stat.name)}`;
            const extra = zoomSelfScore ? (day && day.played ? (day.notable || day.line) : '') : dayExtra;
            const bestNote = verdict === 'best' && !dayInfo ? `${MIDDOT_SEP}Season best` : '';
            // A football matchup point is not a control, since a football matchup is one game and the days have nothing to open. It has no hint line, no pointer and no handler.
            const zoomable = !!matchupVerdicts && !dayAxis && sport !== 'ffl';
            const clickNote = zoomable ? `${MIDDOT_SEP}Opens the days` : '';
            const liveNote = isLive ? `${MIDDOT_SEP}In progress` : '';
            const tooltipText = `${pointLabel}: ${figure}${extra ? MIDDOT_SEP + escapeHtml(extra) : ''}${bestNote}${liveNote}${clickNote}`;
            // A larger transparent hit target sits over the small visible dot, since a small radius alone is hard to hover with many weeks crowded in. The season best wears a ring with a surface halo, because a gold dot on a gold line is invisible, and the halo cuts the line around the point.
            if (verdict === 'best') {
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="8.5" style="fill:var(--surface); pointer-events:none;" />`;
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="7" fill="none" stroke-width="2" style="stroke:${dotColour}; pointer-events:none;" />`;
            }
            if (isLive) {
                // Hollow, with the surface inside and the line's colour as the ring, for a matchup not yet settled and apart from the line.
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="4" stroke-width="2" style="fill:var(--surface); stroke:${color}; pointer-events:none;" />`;
            } else {
                svgStr += `<circle cx="${p.x}" cy="${p.y}" r="${verdict === 'best' ? 3.5 : 4}" style="fill:${dotColour}; pointer-events:none;" />`;
            }
            const zoomAttr = zoomable ? ` data-zoom-week="${p.week}"` : '';
            svgStr += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent"${sport === 'ffl' ? '' : ' style="cursor:pointer;"'} data-tooltip="${tooltipText}"${zoomAttr} />`;
        });
    };
    drawSeries(actualPts, 'var(--compare-a)');
    svgStr += `</svg>`;

    svgWrap.innerHTML = svgStr;
    attachDataTooltips(svgWrap);

    // The door in and the crumb out. Both redraw through the arguments this call was made with, so the zoomed chart is the same chart, not a second renderer.
    const redraw = () => { if (lastTrendArgs) drawPlayerTrendChart(lastTrendArgs.player, lastTrendArgs.stat, lastTrendArgs.weekly, lastTrendArgs.maxWk); };
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

// ==== The matchup score explainer ==== Three steps drawn from one real week of the player on screen. The week's line, one percentile bar per scored category against the pool's other real weeks, and the average of those bars, which is the score.
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

    // Step one is the raw line as the box score would print it, not the per-game figure step two compares.
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


// ==== The projected board ==== The board lives here and not in the draft engine, because it reads the application's sport, pool, league type and scored ids directly, and making it pure would mean injecting six functions and seven values. A view must never import another view, and this module is the shared data layer both faces already import. One board means the two faces cannot disagree about a player's value.

let adpFillerCache = { ref: null, value: null };

/**
 * Says which projections the board may rank, in three states. The cheat sheet is a draft
 * instrument, so its basis is the projections closest to the draft and it stops moving once the
 * draft has happened. A live pool mixes stale full-season lines with rest-of-season lines, and
 * nothing separates them, so the fix is to stop reading a live pool at all. The state is live
 * before the draft, frozen when a preseason snapshot was taken before it, and none when nobody was
 * here before the draft, which is not a failure and needs no storage.
 * @returns {{state: string, takenAt: (number|null), seasonState: (string|null)}} The basis state,
 *   when its snapshot was taken, and the league's season state.
 */
export function boardBasis() {
    const league = AppState.apiData;
    if (!league) return { state: 'none', takenAt: null, seasonState: null };
    const state = seasonState(league);
    if (state === SEASON_STATE.PRE_DRAFT || state === SEASON_STATE.PRESEASON) {
        return { state: 'live', takenAt: null, seasonState: state };
    }
    const snapshot = currentPreseasonSnapshot();
    // isPreseasonSnapshot, not merely "a snapshot exists": one written by an older build after play started would read as a preseason line and is exactly what that guard was added for.
    if (snapshot && isPreseasonSnapshot(snapshot)) {
        return { state: 'frozen', takenAt: snapshot.takenAt ?? null, seasonState: state };
    }
    return { state: 'none', takenAt: null, seasonState: state };
}

/**
 * Builds the board, one row per player ranked by what the player is worth over replacement. Raw
 * scores of two groups cannot be merged, since they share a centre and not a spread, so each
 * group's score is measured against the last player at that group the league still starts. A
 * two-way player matches both groups and keeps the better value, because a player can be drafted
 * once. Players in the exclusion set are left out of the pool before anything runs, which changes
 * the replacement and so every remaining edge. Below replacement is negative and shown.
 * @param {Set<string>} [excludeIds] Player ids, string-compared, to leave out of the pool.
 * @returns {Object[]} The ranked rows by value over replacement, followed by the players with no
 *   value.
 */
export function buildBoard(excludeIds) {
    const sport = AppState.loadedSport;
    const basis = boardBasis();
    const live = (AppState.playerData || []).filter(p => !excludeIds || !excludeIds.has(String(p.id)));
    // No basis ranks nobody. Every player still belongs on a board of who is draftable, so rows arrive without a value and the face says why once.
    if (basis.state === 'none') {
        return live
            .slice()
            .sort((a, b) => ((adpOf(a) || 9999) - (adpOf(b) || 9999)) || a.name.localeCompare(b.name))
            .map(p => ({ player: p, score: null, value: null, boardRank: null, cells: null }));
    }
    // Frozen reads the snapshot and nothing else. The line is swapped at the top once, so every path below is the same code reading whichever basis this league is entitled to.
    const snapshot = basis.state === 'frozen' ? currentPreseasonSnapshot() : null;
    const pool = snapshot
        ? live.map(p => ({ ...p, projectedTotals: preseasonLineFor(snapshot, p.id) || undefined }))
        : live;
    const byId = new Map();

    const starters = leagueStarters();
    const pointsLeague = !!AppState.isPointsLeague;
    const { estimated: estimateIds } = estimateSplit();
    const rateIds = AVERAGE_STATS[sport] || new Set();
    const estimateSet = new Set(estimateIds);
    // Every scored category gets a cell on every row, in the league's own order, so the strips line up. A pitcher's batting cells sit dim, which is true of the row.
    const catIds = Array.from(AppState.scoredStatIds);
    // A category nobody is projected for is estimated into the line before the engine sees it, so value ranks on the league's whole scoring in one engine call. A player the estimate cannot reach keeps the id absent, and the ids travel as unknown when missing, so the gap is skipped and not counted as a zero, which in an inverse category would be the best figure.
    const unknownWhenMissingIds = new Set(estimateIds);

    groupsFor(sport).forEach(wantPitchers => {
        const group = pool.filter(p => hasProjection(p) && matchesPlayerGroup(p, sport, wantPitchers));
        if (!group.length) return;
        const gamesId = gamesIdFor(sport, wantPitchers);
        // The engine reads season totals, so the line is handed over under that name, with the same objects otherwise so names, positions and eligibility survive for the table.
        const projected = group.map(p => ({
            ...p,
            seasonTotals: estimateUnprojected(p.projectedTotals, p.lastSeasonTotals, estimateIds,
                { gamesId, rateIds }).line
        }));
        // A points league is scored on ESPN's own line with the estimates left out. The estimates stay on the row and out of value. A points score is one weighted sum over the whole line, which let estimated categories lift the score above ESPN's projected total. With the estimated ids out, the score is the projected points Player Metrics shows, and the cells still carry the estimates.
        const rankInput = pointsLeague && estimateSet.size
            ? projected.map(p => {
                const line = { ...p.seasonTotals };
                estimateSet.forEach(id => { delete line[id]; });
                return { ...p, seasonTotals: line };
            })
            : projected;
        const ranks = computeGroupRanks(rankInput, sport, wantPitchers, { unknownWhenMissingIds });
        const { scores } = ranks;
        const want = wantPitchers ? starters.secondary : starters.primary;

        // The replacement is a player and not a line per category. It is the last starter the league still fields at this group by overall score, and that player's own category percentiles are the baseline. Taking each category's Nth best would assemble a replacement nobody could draft. A points league has no categories, so it keeps the single-number subtraction.
        const orderedByScore = ranks.ranked || [];
        const replacementPlayer = orderedByScore.length
            ? orderedByScore[Math.min(Math.max(1, want || 1), orderedByScore.length) - 1]
            : null;
        const replacementPcts = !pointsLeague && replacementPlayer && ranks.byCategory
            ? ranks.byCategory.get(replacementPlayer.id) : null;
        const replacementScore = replacementLevel(Array.from(scores.values()), want);

        // Per-seat-group replacement, for the sports where it has been measured and approved. It is empty for every other sport, and then everything below reads the single group's replacement as before.
        const seatGroups = seatGroupsFor(sport, wantPitchers);
        const seatReplacements = seatGroups.length
            ? replacementByGroup(orderedByScore, seatGroups)
            : null;
        // When this pool has exactly one seat label, as hockey goalies do, the windowed per-seat math is skipped because it is unvalidated for a group this small. The label itself is real, so it is kept for the name only and never for pricing.
        const singleSeatGroup = seatGroups.length ? [] : seatGroupsFor(sport, wantPitchers, { keepSingle: true });

        // The seat's level and its line are both the mean of the window the engine picked out. The engine names the players and the averaging happens here, because only this scope holds the per-category percentiles. A category is averaged over the players that have it, so a missing category cannot drag a baseline toward zero, which in an inverse category would read as the best figure.
        const seatLevelOf = (entry) => replacementScoreOf(entry, (r) => scores.get(r.id));
        const seatPctsOf = (entry) => {
            if (pointsLeague || !ranks.byCategory) return null;
            const sums = new Map(), counts = new Map();
            ((entry && entry.players) || []).forEach(r => {
                const line = ranks.byCategory.get(r.id);
                if (!line) return;
                line.forEach((v, id) => {
                    if (!Number.isFinite(v)) return;
                    sums.set(id, (sums.get(id) || 0) + v);
                    counts.set(id, (counts.get(id) || 0) + 1);
                });
            });
            if (!sums.size) return null;
            const out = new Map();
            sums.forEach((s, id) => out.set(id, s / counts.get(id)));
            return out;
        };

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
            // The cell tint's own source, separate from the value's categories. A points league's value categories stay null on purpose, and the per-category map exists for it too through the second roto-style pass, so the tint reads it directly.
            const tintCats = pointsLeague && ranks.byCategory ? ranks.byCategory.get(p.id) : cats;
            // The projected line itself is the board's evidence. The percentile is the engine's own, the number that made the value in a category league, so a tinted cell and the figure under it are never two opinions.
            const cells = catIds.map(id => {
                const raw = p.seasonTotals[id];
                const has = raw !== undefined && raw !== null;
                const pct = tintCats ? tintCats.get(id) : undefined;
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
            // The seat's own replacement when the sport has seat groups, the group's when it does not. Both carry a player's percentile line, so the downstream sum cannot tell which branch produced it.
            let entryPcts = replacementPcts, entryScore = replacementScore, entryGroup = null;
            if (seatReplacements) {
                // Self-excluded, and the same level decides both things. The window a player is priced against never contains them, and the cheapest-seat choice is made on that same level, so a player is not assigned by one baseline and priced by another.
                const ownLevel = (e) => seatLevelOf(replacementWindowFor(e, p.id));
                const g = pricingGroupFor(p, seatGroups, seatReplacements, ownLevel);
                entryGroup = g ? g.name : null;
                const rep = g ? replacementWindowFor(seatReplacements.get(g.name), p.id) : null;
                if (rep) {
                    // The window's mean and not one player's line. The load board and the exclusion re-rank both arrive here, so there is one place the seat's level is built.
                    entryScore = seatLevelOf(rep);
                    entryPcts = seatPctsOf(rep);
                }
            } else if (singleSeatGroup.length === 1) {
                // Only the group name. The score and percentiles stay the whole-pool fallback already set above.
                entryGroup = singleSeatGroup[0].name;
            }
            held.entries.push({
                wantPitchers, score, cells,
                percentiles: cats,
                replacement: entryPcts,
                replacementScore: entryScore,
                // Carries out which seat priced this player, so the next-value function is handed it and not left to work it out again. Two opinions about which seat prices a player is the disagreement the pricing group function exists to settle.
                group: entryGroup
            });
            byId.set(p.id, held);
        });
    });

    // A player is the sum of the groups they play in. For a two-way player the pitching edges would otherwise be discarded because the engine ranked them among batters. The app's own estimates are out of value and stay on the row, since a category ESPN projects for nobody is filled in to show a line and not to price a pick. The set is the estimator's own, so it cannot drift from what was estimated.
    byId.forEach(held => {
        const entries = held.entries;
        const edges = sumOfEdgesAcross(
            entries.map(e => ({ percentiles: e.percentiles, replacement: e.replacement })),
            { exclude: estimateSet }
        );
        // The single-number fallback, for a points league and for a league whose settings leave nobody starting: the best of the groups played in, rather than a sum of scores that are not on one scale.
        const fallback = entries.reduce((best, e) => {
            const v = e.replacementScore === null ? e.score : e.score - e.replacementScore;
            return best === null || v > best ? v : best;
        }, null);
        held.value = edges !== null && edges !== undefined ? edges : fallback;
        held.score = entries.reduce((best, e) => (best === null || e.score > best ? e.score : best), null);
        held.wantPitchers = entries.length === 1 ? entries[0].wantPitchers : null;
        // The seat that priced the player, from the group whose edges the value actually came from.
        const pricedBy = entries.find(e => e.group) || null;
        held.group = pricedBy ? pricedBy.group : null;
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

    // Everyone the projections cannot rank still belongs on a board of who is draftable. They sit after the ranked players in the crowd's own order, saying plainly that there is no number.
    const unranked = pool
        .filter(p => !byId.has(p.id))
        .sort((a, b) => ((adpOf(a) || 9999) - (adpOf(b) || 9999)) || a.name.localeCompare(b.name))
        .map(p => ({ player: p, score: null, value: null, boardRank: null, cells: null }));

    return rows.concat(unranked);
}

// The seat groups a ranking group contains. Hockey's members are not interchangeable, and pricing against the 75th best skater buried a position, so each position slot becomes a group and each flex slot a group over the positions it accepts. A slot whose flex positions have not been measured is skipped. It is per sport, so football's board is unchanged. An empty answer means keep the single group.
const PER_POSITION_VALUE_SPORTS = new Set(['fhl', 'flb']);

/**
 * Lists the seat groups of a role group, each with a name and seat count, flex groups carrying the
 * positions they accept. The single-group collapse discards a real group name along with the
 * windowed pricing it exists to skip, which is wrong for a caller that only wants the name, so the
 * keep flag retains it.
 * @param {string} sport The sport key.
 * @param {boolean} wantPitchers True for the secondary group.
 * @param {Object} [opts] Options.
 * @param {boolean} [opts.keepSingle] Keep a single group instead of collapsing to none.
 * @returns {Object[]} The seat groups, or an empty array to keep the single group.
 */
export function seatGroupsFor(sport, wantPitchers, { keepSingle = false } = {}) {
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
        // The secondary lineup slots say which ranking pool a seat belongs to, the same tag the flex positions are recorded against, so a pitcher flex is never measured against batters.
        if (n <= 0 || bench.has(slot) || secondary.has(slot) !== !!wantPitchers) return;
        if (flex.has(slot)) {
            const accepts = flexPositions[slot];
            // Flagged as flex so the replacement prices it last, from whoever the fixed seats did not take. Pricing a flex seat against the whole pool made it the most expensive seat in the league and not the cheapest.
            if (accepts && accepts.size) groups.push({ name: labels[slot] || `slot${slot}`, seats: n * teams, accepts, flex: true });
            return;
        }
        if (labels[slot]) groups.push({ name: labels[slot], seats: n * teams, accepts: new Set([labels[slot]]) });
    });
    // One group is the single-baseline case, so it answers none unless the caller asked to keep it.
    return (keepSingle || groups.length > 1) ? groups : [];
}

// Takes the preseason snapshot. It is orchestration only, since the decisions are pure and storage is the API module's. It is called without awaiting from wherever the pool lands, and must not delay a render, because a failure leaves the feature absent and not broken. A snapshot exists only for a league opened in its preseason, and no fetch can recover one, since ESPN overwrites the line.
async function maybeTakePreseasonSnapshot() {
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
        // Recorded so the reader can refuse a snapshot that was not taken in a preseason state. The write path already refuses a late one, and this protects against a stored one a later build cannot un-write.
        state: seasonState(league)
    });
    // Nothing worth keeping, a league whose pool carries no projection yet. It is not an error and not recorded as an attempt, so a later load can still succeed.
    if (!snapshot) return false;

    const stale = staleKeys(await preseasonSnapshotKeys(), sport, leagueId, seasonId);
    return writePreseasonSnapshot(key, snapshot, stale);
}

// The snapshot held for the surface that draws it. The drill-down renders synchronously and storage is async, so the body is fetched once per league and kept, the same pattern as the pro schedule. It is key-checked, since a read without asking whose it is showed one league's data under another's name.
let preseasonSnap = { key: null, data: null };

function currentSnapshotKey() {
    const sport = AppState.loadedSport, league = AppState.apiData;
    if (!sport || !league || league.id === undefined || !league.seasonId) return null;
    return snapshotKey(sport, league.id, league.seasonId);
}

// The body for the league on screen, or null both when there is no snapshot and when the one held belongs to another league, which the reader treats alike.
function currentPreseasonSnapshot() {
    const key = currentSnapshotKey();
    return (key && preseasonSnap.key === key) ? preseasonSnap.data : null;
}

// Loads it once per league and redraws the open drill-down when it lands, because the surface that wants it has already rendered by then. A null answer is CACHED under the key too: most leagues have no snapshot and never will, and re-reading storage on every drill-down to be told so again is work for an answer that cannot change within a session.
async function ensurePreseasonSnapshot() {
    const key = currentSnapshotKey();
    if (!key || preseasonSnap.key === key) return preseasonSnap.data;
    const data = await readPreseasonSnapshot(key);
    if (currentSnapshotKey() !== key) return null;   // a league switch overtook it
    preseasonSnap = { key, data };
    if (data && AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
    return data;
}

// The basis a surface reads must not depend on another surface having rendered. The frozen state is only reachable once the snapshot body is in hand, which used to happen only when the drill-down asked, so the draft tab could report nobody ranked. It runs once per league and only when the read went to storage. The redraw callback runs after the cache fills, for every waiting caller.
let basisEnsure = { key: null, pending: null };
/**
 * Makes sure the preseason snapshot has been read from storage, once per league, and calls the
 * redraw callback afterwards. A caller that re-enters it on every render is safe, since the key
 * gates the read, and every waiting caller is called.
 * @param {function(): void} [redraw] A re-render to run once the snapshot has landed.
 * @returns {void}
 */
export function ensureBoardBasis(redraw) {
    const key = currentSnapshotKey();
    if (!key) return;
    if (basisEnsure.key === key) {
        // Still in flight: join the queue. Already resolved (pending null): nothing to wait for.
        if (basisEnsure.pending && typeof redraw === 'function') basisEnsure.pending.push(redraw);
        return;
    }
    basisEnsure = { key, pending: typeof redraw === 'function' ? [redraw] : [] };
    ensurePreseasonSnapshot().then(() => {
        // The league may have been switched while storage was answering; the key says so.
        if (currentSnapshotKey() !== key || basisEnsure.key !== key) return;
        const waiting = basisEnsure.pending || [];
        basisEnsure = { key, pending: null };
        waiting.forEach(fn => { try { fn(); } catch { /* one caller's redraw cannot stop another's */ } });
    }).catch(() => {});
}

/**
 * Counts how many of each group this league starts in total, per team from its own lineup settings
 * times the number of teams. Replacement level is taken at this number, and the scarcity card reads
 * the same helper, so the board and the card tell one story.
 * @returns {{primary: number, secondary: number}} Starters for the primary and secondary groups.
 */
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

/**
 * Splits the unprojected categories by what can be done about them. A counting category is
 * estimated from the player's own last season. A rate cannot be, since it does not scale by games,
 * so it stays unavailable and is named as such.
 * @returns {{estimated: string[], unavailable: string[]}} The stat ids that can be estimated and
 *   the ones that cannot.
 */
export function estimateSplit() {
    const rates = AVERAGE_STATS[AppState.loadedSport] || new Set();
    const ids = unprojectedCategoryIds();
    return {
        estimated: ids.filter(id => !rates.has(id)),
        unavailable: ids.filter(id => rates.has(id))
    };
}

/**
 * Lists which categories the projections cannot speak to. A category is unprojected when no
 * projected player in the pool carries it, which is computed and never listed. A league scoring a
 * category ESPN projects for nobody is drafting blind there, and the sheet says so. A merely sparse
 * category, such as saves, is the projection working.
 * @returns {string[]} The unprojected stat ids.
 */
/**
 * Lists the scored categories no projected player carries. Each is estimated from the player's own
 * last season when it is a counting category.
 * @returns {string[]} The stat ids, in the league's category order.
 */
export function unprojectedCategoryIds() {
    const projected = (AppState.playerData || []).filter(hasProjection);
    if (!projected.length) return [];
    const missing = [];
    // The scored ids are built from the league's own scoring items in order, and a Set keeps insertion order, so this comes out in the order the league lists its categories.
    AppState.scoredStatIds.forEach(id => {
        if (!projected.some(p => p.projectedTotals[id] !== undefined)) missing.push(id);
    });
    return missing;
}

// Says which role groups this sport has and does not assume two. A sport whose second group is empty, or that never had one, is ranked as a single pool.
function groupsFor(sport) {
    const secondary = SECONDARY_GROUP_POSITIONS[sport];
    return secondary && secondary.size ? [false, true] : [false];
}

// The games-played id for a group, which an estimate is scaled onto. A sport with no entry gets nothing and not baseball's ids, so the estimate cannot be made, which the estimator already handles.
function gamesIdFor(sport, wantPitchers) {
    const ids = GAMES_PLAYED_IDS[sport];
    return ids ? ids[wantPitchers ? 'secondary' : 'primary'] : undefined;
}

// ==== Projections ====

/**
 * Says whether a player carries a projected line. It is read off the pool the player tab already
 * processed, which parsed the projection with the same predicate the draft engine uses, so a second
 * extraction cannot disagree. An unprojected player unwraps to an empty object and not zeros, which
 * is the distinction the sheet needs.
 * @param {Object} player A processed player.
 * @returns {boolean} True when the player has a projected line.
 */
export function hasProjection(player) {
    return !!player && Object.keys(player.projectedTotals || {}).length > 0;
}

/**
 * Returns ESPN's average draft position for a player, or null when it is absent or is the filler
 * value ESPN uses out of season.
 * @param {Object} p A processed player.
 * @returns {number|null} The draft position.
 */
export function adpOf(p) {
    const raw = Number(p.adp) > 0 ? Number(p.adp) : null;
    if (raw === null) return null;
    const filler = adpFiller();
    return filler !== null && raw === filler ? null : raw;
}

/**
 * Finds the value ESPN collapses the draft position column to out of season, so it can be treated
 * as absent. The result is cached against the pool's identity.
 * @returns {number|null} The filler value, or null when there is none.
 */
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
