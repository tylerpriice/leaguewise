/**
 * The Draft tab: one board of the pool ranked for this league, with three switches layered over it.
 * Plan arms a target for each round, Rehearse runs a mock draft against bots, and Log picks follows
 * the real draft by hand or through the draft room's own page. A draft already past shows its
 * results instead.
 *
 * This file owns the tab's chrome, its per-league state and every event binding. The math is in
 * the draft engines and the plan, strip and results modules, which are pure.
 * @module draft-view
 */
import {
    AppState, ESPN_STAT_MAPS, AVERAGE_STATS, leagueInverseIds, SECONDARY_GROUP_POSITIONS, RATE_COMPONENTS,
    NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_LABELS, LINEUP_SLOT_ORDER, FLEX_SLOTS,
    FLEX_SLOT_POSITIONS, nonStartingLabels
} from '../data/state.js';
import { findOwnedTeamId } from './utils.js';
import {
    currentProSchedule, draftPlanKey, readDraftPlan, writeDraftPlan,
    draftLogKey, readDraftLog, writeDraftLog,
    draftNotesKey, readDraftNotes, writeDraftNotes,
    draftTrayWidthKey, readDraftTrayWidth, writeDraftTrayWidth,
    readRoomState,
    rankingsFileKey, readRankingsFile, writeRankingsFile, removeRankingsFile
} from '../data/api.js';
import {
    buildPlan as buildDraftPlan, setTarget as setPlanTarget, setAlternate as setPlanAlternate,
    removeTarget as removePlanTarget, validate as validatePlan, planRoster,
    emptyLog, applyLoggedPick, undoLastPick, planStatus, nextPick as nextLoggedPick,
    valueOverNext, suggestPlan, loggedPickRefusal, seatAll, logSeats, logCoverage, resolveDraftSwitches,
    emptyNotes, setNote, noteFor,
    setRule as setPlanRule, removeRule as removePlanRule, rulesFor as planRulesFor, resolveRound as resolvePlanRound,
    logNeeds, rostersFromLog, logSurvivesReset, storedLogApplies, roomPicksClearOffer
} from '../engines/draft-plan.js';
import { tierState, nextUp, picksGrid, adpTag, seatAtRisk, companionHeadState, ageWords } from '../engines/draft-strip.js';
import { applyRoomFacts, roomIsStale, ROOM_STALE_MS, roomFrameState, openTransportName, domPickFacts } from '../data/room-feed.js';
import { readRankings, matchRankings, rankingsColumn, poolNameLookup } from '../data/rankings-file.js';
import { seatsFor as planSeatsFor } from '../engines/mock-lineup.js';
import { draftedRostersByTeam, projectedContext } from './graphs.js';
import {
    projectedTeamSums, projectedValues, projectedRotoStandings, projectedPointsStandings, placeOf
} from '../engines/projected-basis.js';
import { registerExportDataset } from './export.js';
import {
    computeGroupRanks, matchesPlayerGroup, positionOptionsFor, formatStatValue,
    buildBoard, leagueStarters, estimateSplit, unprojectedCategoryIds, hasProjection, adpOf, adpFiller,
    playoffDensityRows, boardBasis, seatGroupsFor, ensureBoardBasis, roleGroupsFor, buildSkeletonHtml,
    draftPicksFor, ensureDraftPicks, hindsightValuesFor, hindsightPacingFor
} from './players.js';
import {
    adpVerdict, startingSlotsByGroup, replacementLevel, estimateUnprojected,
    tierBreaks, tierOf, positionDepths, depthTones, sumOfEdges, sumOfEdgesAcross, degenerateValue,
    survivalWord, draftOrder, botPick, seededRandom,
    initialDraftState, applyPick, draftComplete, teamOnClock, simToTeam, openNeeds,
    runDetect, coverageOf, rosterTotals, lineupSeatsOf, draftRoundCount, picksFor
} from '../engines/draft-engine.js';
import { GAMES_PLAYED_IDS, rotoPointsForCategory } from '../engines/rank-engine.js';
import { escapeHtml, percentileVar, injuryBadgeHtml, draftTypeLabel, splitStatIdsByRole, attachDataTooltips, isCoarsePointer, playerPoolErrorText } from './utils.js';
import { buildPlayerAvatarHtml, buildProTeamCrestHtml, wirePlayerAvatars, initialsFor } from './images.js';
import { sampleLogoColour, toCssRgb, parseCssColour, pickCardGround, assignDistinctGrounds, blendToward, separateGrounds } from './logo-colour.js';
import { buildProTeamAbbrevs } from '../engines/probables.js';
import { teamDensity } from '../engines/schedule-insight.js';
import { draftedIndexOf } from '../engines/preseason-face.js';
import { draftTabShowsResults, gamesHaveBeenPlayed } from '../data/season-state.js';
import { resultsFeedFor } from '../engines/draft-results.js';
import { hindsightRows } from '../engines/draft-hindsight.js';
import { renderMarkdownLite } from './markdown-lite.js';

// THE PRO CLUB'S ABBREVIATION, when the app already has it. It rides the pro-team schedule, which My Team and the day-axis chart fetch and cache. The draft tab asks for nothing: when that response is already in hand every row names its club, and when it is not the rows do not. A three-letter label is not worth a request.
function proTeamAbbrevs() {
    // Reads the schedule through the accessor, which returns the body or nothing. The raw store holds a wrapper and is keyed by sport, so reading it directly gives an empty map or another sport's abbreviations.
    const data = currentProSchedule();
    return data ? buildProTeamAbbrevs(data) : new Map();
}

// ==== How busy a player's club is in the league's own playoff matchups ====

// Counts a club's games in each of the league's playoff matchups, so equal-value players can be told apart by schedule. It asks for nothing and uses the cached pro schedule when present. Round lengths are listed whenever they differ, because ESPN folds the tail of the pro season into the final round and a bare count would mislead. A bye reads as none.
function playoffHoverFor(player, clubs) {
    const rows = playoffDensityRows();
    if (!rows || !rows.length || player.proTeamId === undefined || player.proTeamId === null) return '';
    // A FREE AGENT HAS NO CLUB, which is not the same as a club with no games. ESPN gives them proTeamId 0 and the density map deliberately has no row for it, so "FA plays no games in 22" would read as a scheduling fact about a club that does not exist. Say nothing instead.
    if (!rows[0].byTeam.has(Number(player.proTeamId))) return '';
    const line = teamDensity(rows, player.proTeamId);
    if (!line.length) return '';
    // Oxford comma, per VOICE. Two rounds read "a and b", three or more "a, b, and c".
    const oxford = parts => (parts.length > 2
        ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
        : parts.join(' and '));
    const games = oxford(line.map((r, i) => {
        const n = i === 0
            ? (r.games === 0 ? 'no games' : `${r.games} game${r.games === 1 ? '' : 's'}`)
            : (r.games === 0 ? 'none' : String(r.games));
        return `${n} in ${r.matchup}`;
    }));
    const club = clubs.get(Number(player.proTeamId));
    const lengths = rows.map(r => r.periods);
    const uneven = lengths.some(d => d !== lengths[0]);
    const days = uneven ? ` Those rounds run ${oxford(lengths.map(String))} days.` : '';
    return `Playoff matchups. ${club ? `${club} plays ` : ''}${games}.${days}`;
}

// "82nd percentile" reads as a measured fact; "82%" reads as a probability, which it is not.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// A character code rather than an escape. An edit script doubled the backslash on this exact separator once already, which shipped the literal six characters into a label.
const MIDDOT = String.fromCharCode(183);
const DASH = String.fromCharCode(8212);
const STAR_ON = String.fromCharCode(9733);
const STAR_OFF = String.fromCharCode(9734);
const NOTE_ICON = String.fromCharCode(9998);

// The Draft tab. This file owns the tab's chrome, the header line and which face is on screen, and each body is built by its own renderer below. The tab exists for every league, but a pool with no season projections has nothing to rank and says so.

// These three still name the old faces, whose bodies are not rebuilt. The face switcher that chose between them is gone, so there is one board and three switches layered over it.
const CHEAT_SHEET = 'sheet';
const MOCK_DRAFT = 'mock';
const PLANNER = 'plan';

let activeFace = CHEAT_SHEET;
// The phone's results face is a pager of one team per page with the board behind a pill; which of the two is up and which page is showing live here, as the history tab's open state does, so the whole-tab re-render keeps them.
let draftTeamsMode = 'teams';
let draftTeamPage = 0;
// The board is the only view. The three switches are resolved by resolveDraftSwitches in the plan module, which is the one tested place for the exclusivity rules. This module holds what it returns and asks again on every request, never re-deriving a rule locally.
let switches = { plan: false, rehearse: false, log: false };
let switchAutoApplied = false;
let switchRefused = null;
let switchAutoCheckedForKey = null;
let poolSearch = '';
// Every position pill is its own toggle and all are enabled by default. An empty set means nothing is disabled, so showing everyone needs no special case. The set is cleared on every reset or group switch.
let disabledPositions = new Set();
// The two filter pills, Fits a seat and Hide drafted, are off by default and follow the same reset rule as the disabled positions.
let filterFitsSeat = false;
let filterHideDrafted = false;
// Which team's picks the Board at a glance is narrowed to, or null for every team. It is per sitting and never stored, because a filter choice on one draft means nothing on the next.
let glanceTeamFilter = null;
// The sidebar's default for Hide drafted turns on once there is something to hide. It is re-checked every render because the log loads asynchronously, and never once the reader has touched the pill.
let hideDraftedUserSet = false;
// There is no group pill. The board always shows both groups, and which group's columns appear follows the position pills, so unlighting every goalie position removes the goalie columns too.

// Every switch request goes through here, so there is exactly one place that calls resolveDraftSwitches with a real request.
function applySwitchRequest(name, on) {
    const result = resolveDraftSwitches(switches, {
        request: { name, on },
        draftDate: AppState.apiData?.settings?.draftSettings?.date ?? null,
        now: Date.now(),
        loggedPicks: (draftLog?.picks || []).length,
        autoApplied: switchAutoApplied
    });
    switches = { plan: result.plan, rehearse: result.rehearse, log: result.log };
    switchAutoApplied = result.autoApplied;
    switchRefused = result.refused;
}

// The date rule is asked once per league. The resolver's own guard stops the date branch firing twice, but nothing stops this caller asking on every render, so a once-per-league key saves the call. It makes no request and cannot refuse.
function ensureSwitchesAutoOn() {
    const key = planLeagueKeyString();
    if (!key || switchAutoCheckedForKey === key) return;
    switchAutoCheckedForKey = key;
    const result = resolveDraftSwitches(switches, {
        request: null,
        draftDate: AppState.apiData?.settings?.draftSettings?.date ?? null,
        now: Date.now(),
        loggedPicks: (draftLog?.picks || []).length,
        autoApplied: switchAutoApplied
    });
    switches = { plan: result.plan, rehearse: result.rehearse, log: result.log };
    switchAutoApplied = result.autoApplied;
}

// Below 700px the tray stacks under the board and starts collapsed. This is a display preference, not league state, so a reset leaves it alone.
let trayOpenMobile = false;

// Desktop's collapsed or expanded state for the tray. It is a one-line strip at rest and a docked column once opened. It is kept apart from the mobile flag because the two apply at different widths and mean different DOM placements.
let trayOpenDesktop = false;

// Which of the sidebar's three foot tabs is showing, Board, Roster or Picks. A display preference that is never persisted.
let sidebarFootTab = 'board';

// Every column header is a sort control. A third click on the same column returns to the board's own order. Reset with the rest of the per-league state and never persisted.
let boardSort = { col: null, dir: null };

// The plan. The plan module owns the shape and the arithmetic; this module owns which league it belongs to and its storage. It is null until ensurePlan lays one out, since the order and slot are unknown until a league is loaded.
let plan = null;
// The key a load in flight was asked for, so a fast league switch cannot paint the first league's plan over the second.
let planLoadedForKey = null;
// Which round's target or which alternate slot the search picker is filling, or null when closed. One shared picker serves every round, since a picker per row would be a picker nobody could find.
let targetPicker = null;
let pickerQuery = '';
// The same picker, extended with roles for the two rule kinds that need a player choice. A two-player rule needs two picks in sequence, so the first is held while the picker moves to the second. Which round a rule chooser is open for is null when none is.
let ruleChooserRound = null;
let ruleDraft = null;

// The pick log. It is null until ensureLog lays one out, is saved beside the plan under its own key and is loaded the same fire-and-forget way.
let draftLog = null;
let logLoadedForKey = null;

// The room's own snapshot, null until it is read. The key is one fixed key, not per league, and the league id is a field of the value. It is kept apart from the hand log, which stays the hand log from start to finish, and is only merged into a derived view of it.
let roomState = null;
let roomLoaded = false;
// What the last read of the room's own board made of it, as held and unresolved picks, or null when no board applies. Held picks are taken players read beside the log; unresolved slots are unknown rather than taken or free. It is kept with the key of the board it was read from so a second read of the same board changes nothing.
let roomBoardRead = null;
let roomBoardKey = '';
// Whether the reader has opted into a room whose league does not match the one on screen. It is never auto-followed, so it starts false on every load and league switch and flips only from the banner's click.
let roomFollowedAcrossLeague = false;
// Whether the log's room-sourced picks came from a room that did not match the loaded league. It is set on every merge, read when saving and when merging, and only ever true for a followed room of another league. A same-league room's picks are real history and are never touched.
let draftLogHasForeignRoomPicks = false;

// The reader's own notes. The plan module owns the shape, keyed by player so a note outlives any plan. This module loads and saves them under their own storage key, so clearing a plan cannot take a note with it.
let notes = null;
let notesLoadedForKey = null;
// The one row currently showing its note as an editable field, or null. One shared edit state serves every row.
let noteEditing = null;

// The reader's own rankings file. The pure module stays pure and this one owns loading and saving the file's text and name. The parse and match are re-run against the current pool on every load rather than stored. The value is null or an object of name, text, read result and match result.
let rankingsFile = null;
let rankingsLoadedForKey = null;
// The popover's open state. One flag serves the full tab and the sidebar, since only one of the two shows the control in a render.
let rankingsPanelOpen = false;

// The tray's width, which the reader can drag between a floor and about half the board. It is persisted beside the plan. The default and floor are read by both the CSS and the drag clamp so the two agree. The fit function grows it past the default only when a real plan row needs more room.
const TRAY_WIDTH_DEFAULT = 300;
const TRAY_WIDTH_FLOOR = 220;
let trayWidth = TRAY_WIDTH_DEFAULT;
let trayWidthLoadedForKey = null;

// Per-league state, cleared the way the History tab clears its own, so a face or position pill from one league does not decide what the next shows.
/**
 * Clears the tab's per-league view state, so a position pill or tray choice from one league does not
 * decide what the next league opens on. The log, plan and notes are kept when the league is the same
 * one, since a fresh fetch is not a league change.
 * @returns {void}
 */
export function resetDraftView() {
    activeFace = CHEAT_SHEET;
    draftTeamsMode = 'teams';
    draftTeamPage = 0;
    switches = { plan: false, rehearse: false, log: false };
    switchAutoApplied = false;
    switchRefused = null;
    switchAutoCheckedForKey = null;
    poolSearch = '';
    disabledPositions = new Set();
    filterFitsSeat = false;
    filterHideDrafted = false;
    hideDraftedUserSet = false;
    glanceTeamFilter = null;
    // A fetch is not a league change. Every tab's reset fires on any fresh fetch and cannot tell a different league from the same one, so what belongs to the log is kept when the league is the same. View state clears either way.
    const sameLeague = logSurvivesReset(logLoadedForKey, draftLogKey(AppState.loadedSport, AppState.apiData?.id));
    if (!sameLeague) {
        roomFollowedAcrossLeague = false;
        // Whatever log this flag described belonged to the previous league, and the new league's log has not been read yet.
        draftLogHasForeignRoomPicks = false;
    }
    mock = null;
    mockSetup = null;
    planRehearsal = false;
    spotlightId = null;
    roomBoardRead = null;
    roomBoardKey = '';
    // The plan is per league too, so it is re-read under the new league's key.
    plan = null;
    planLoadedForKey = null;
    targetPicker = null;
    pickerQuery = '';
    ruleChooserRound = null;
    ruleDraft = null;
    // The log is per league too, but is only reset when the league actually changed.
    if (!sameLeague) {
        draftLog = null;
        logLoadedForKey = null;
    }
    // Notes are per league too, since a note on a player means nothing once another sport's pool is loaded.
    notes = null;
    notesLoadedForKey = null;
    noteEditing = null;
    // The tray's width is per league too, since a width dragged for a deep roster means nothing against a shallow one.
    trayWidth = TRAY_WIDTH_DEFAULT;
    trayWidthLoadedForKey = null;
    boardSort = { col: null, dir: null };
    // The rankings file is per league too, since a file matched against one pool means nothing joined against another.
    rankingsFile = null;
    rankingsLoadedForKey = null;
    rankingsPanelOpen = false;
}

// ==== The header line ====

// The draft's own date, as local month and day, the same shape the trend chart's day axis uses. A league that has not scheduled its draft says so instead of showing an epoch. The label is a noun once the draft is past.
function draftDateLabel() {
    const at = Number(AppState.apiData?.settings?.draftSettings?.date) || 0;
    if (!at) return 'draft date not set';
    // Uses the same rule the tab's face uses rather than the bare drafted flag, since the tab can already read a finished draft before ESPN flips the flag.
    const verb = draftTabShowsResults(AppState.apiData) ? 'draft' : 'drafts';
    return `${verb} ${mmdd(at)}`;
}

// The same month and day shape without the prefix, for captions that build their own sentence around a bare date.
function mmdd(epochMs) {
    const d = new Date(epochMs);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}`;
}

function poolHasProjections() {
    return (AppState.playerData || []).some(hasProjection);
}

function categoryNames(ids) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    return ids.map(id => map[id] || `Stat ${id}`);
}

// ==== The board ====

// Whether ANY player has a real draft position. When none does the column is all filler and the board drops it rather than printing a blank stripe down the page.
function poolHasAdp() {
    const filler = adpFiller();
    return (AppState.playerData || []).some(p => Number(p.adp) > 0 && Number(p.adp) !== filler);
}

// HOW MANY PLAYERS THIS LEAGUE WILL ACTUALLY TAKE. Every roster seat the league allows, bench and injury slots included, times the number of teams. It is the last pick of the draft.
/**
 * How many players the league will actually take, which is every roster seat it allows, bench and
 * injured reserve included, times the number of teams.
 * @returns {number} The last pick of the draft, or 0 when the league's settings are not loaded.
 */
export function draftableCount() {
    const settings = AppState.apiData?.settings || {};
    const counts = settings.rosterSettings?.lineupSlotCounts || {};
    const perTeam = Object.keys(counts).reduce((sum, id) => sum + Math.max(0, Number(counts[id]) || 0), 0);
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    return perTeam * teams;
}

// Pre-draft, a player already on a roster is a keeper and cannot be taken. AFTER the draft every pooled player is on a roster or a waiver wire and the distinction says nothing, so the mark is only drawn while it means something.
function keptRow(row) {
    return !AppState.apiData?.draftDetail?.drafted && !!row.player.teamId;
}

// Football keeps its player and defense split on the leaderboard, a dynamically discovered set, but the board reads it as one group. Every group-aware read goes through here so that exception lives in one place.
function boardRoleGroups(sport) {
    return sport === 'ffl' ? ['primary'] : roleGroupsFor(sport);
}

// Whether a group still has any position pill lit, which alone decides whether its rows and columns show. A one-group sport's group is always lit.
function groupHasLitPosition(secondary) {
    const sport = AppState.loadedSport;
    const pool = (AppState.playerData || []).filter(hasProjection);
    const opts = positionOptionsFor(pool.filter(p => matchesPlayerGroup(p, sport, secondary)), sport, secondary);
    return opts.length === 0 || opts.some(pos => !disabledPositions.has(pos));
}

// The two filter pills are read against the companion when the caller has one. A caller with none, such as the room's popover, cannot filter by either.
function visibleRows(rows, companion) {
    const needle = poolSearch.trim().toLowerCase();
    const groups = boardRoleGroups(AppState.loadedSport);
    const primaryLit = groups.length < 2 || groupHasLitPosition(false);
    const secondaryLit = groups.length < 2 || groupHasLitPosition(true);
    // Fits a seat. The reader's open named seats are read off their current roster through the same seating rule the strip uses, and a flex seat takes anyone so it is never a reason to keep or drop a row.
    const openSeats = filterFitsSeat && companion ? new Set(openStarterLabels(Array.from(companion.mineIds))) : null;
    return rows.filter(r => {
        // A row whose group has no lit position leaves with it, the same as unlighting one position drops that position's rows.
        if (groups.length > 1) {
            const secondary = matchesPlayerGroup(r.player, AppState.loadedSport, true);
            if (secondary && !secondaryLit) return false;
            if (!secondary && !primaryLit) return false;
        }
        if (disabledPositions.size && !r.player.eligiblePositions.some(p => !disabledPositions.has(p))) return false;
        if (needle && !r.player.name.toLowerCase().includes(needle)) return false;
        if (companion) {
            const id = String(r.player.id);
            const gone = companion.goneIds.has(id) || (companion.draftedById && companion.draftedById.get(id));
            if (filterHideDrafted && gone) return false;
            if (openSeats && !gone && !(r.player.eligiblePositions || []).some(p => openSeats.has(p))) return false;
        }
        return true;
    });
}

// Every position of both groups, always, since there is no group pill to narrow it. It is the same combined list a one-group sport already read.
function positionPills() {
    const sport = AppState.loadedSport;
    const pool = (AppState.playerData || []).filter(hasProjection);
    return positionOptionsFor(pool.filter(p => matchesPlayerGroup(p, sport, false)), sport, false)
        .concat(positionOptionsFor(pool.filter(p => matchesPlayerGroup(p, sport, true)), sport, true));
}

// The board's categories, split the leaderboard's way, batting before pitching and skaters before goalies. The header and the body both read it here so they cannot disagree. Each group's columns follow its own lit positions.
function boardCategoryIds() {
    const all = Array.from(AppState.scoredStatIds);
    if (boardRoleGroups(AppState.loadedSport).length < 2) return all;
    const { primary, secondary } = splitStatIdsByRole(AppState.loadedSport, all);
    const parts = [];
    if (groupHasLitPosition(false)) parts.push(...primary);
    if (groupHasLitPosition(true)) parts.push(...secondary);
    return parts;
}

// The seam is the first category of the secondary group when both groups show, and null when there is nothing to divide. Only the header and cell builders read it.
function boardCategoryDividerId() {
    if (boardRoleGroups(AppState.loadedSport).length < 2) return null;
    if (!groupHasLitPosition(false) || !groupHasLitPosition(true)) return null;
    const { primary, secondary } = splitStatIdsByRole(AppState.loadedSport, Array.from(AppState.scoredStatIds));
    return primary.length && secondary.length ? String(secondary[0]) : null;
}

// ==== Rendering ====

// ==== The rail ====

// Where the user picks, from the league's own first-round order. pickOrder is a list of team ids, so the slot is where this user's team sits in it. A league the user only spectates has no slot, which is a real state and says so rather than showing a 1.
function ownSlot() {
    const order = AppState.apiData?.settings?.draftSettings?.pickOrder || [];
    const teamId = findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid);
    if (!teamId) return null;
    const at = order.indexOf(teamId);
    return at >= 0 ? at + 1 : null;
}

function draftTypeWord() {
    return draftTypeLabel(AppState.apiData?.settings?.draftSettings?.type) || 'draft type not set';
}

// The AppState half of the pre-draft depth read. The math lives in the engine so the preseason face can use it without importing a view. Depths are computed from one flat row per position a player is eligible at, so the board's rows are exploded here. The value is the figure for worth starting at all, never the points score, which is null outside a points league.
function scarcityRows(rows) {
    const sport = AppState.loadedSport;
    const flat = (rows || [])
        .filter(r => r.value !== null && r.value !== undefined && r.value >= 0)
        .flatMap(r => (r.player?.eligiblePositions || []).map(pos => ({ pos, score: r.value })));
    return positionDepths(flat, {
        counts: AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {},
        labels: LINEUP_SLOT_LABELS[sport] || {},
        bench: NON_STARTING_SLOTS[sport] || new Set(),
        flex: FLEX_SLOTS[sport] || new Set(),
        flexPositions: FLEX_SLOT_POSITIONS[sport] || {},
        teams: Number(AppState.apiData?.settings?.size) || (AppState.apiData?.teams || []).length || 0
    });
}

// ==== The mock draft ====

// How far down the consensus a bot will reach. The words are the setup strip's; the numbers are botPick's variance, which scales its window.
const VARIANCE = { Low: 0.25, Medium: 0.5, High: 1 };

// The run of live state. Null until a draft is started, which is also what the setup strip tests.
let mock = null;

// Whether this mock run is the plan's own rehearsal rather than an ordinary manual room. Only the rehearse link sets it, since a manual room should never draft the reader's turns for them.
let planRehearsal = false;

// Every team's id, in the league's own order.
function leagueTeamIds() {
    return (AppState.apiData?.teams || []).map(t => t.id);
}

function teamNameOf(teamId) {
    const team = (AppState.apiData?.teams || []).find(t => t.id === teamId);
    if (!team) return `Team ${teamId}`;
    return team.name || `${team.location || ''} ${team.nickname || ''}`.trim() || `Team ${teamId}`;
}

// Starting slots by position, per team. The card, the bots' needs and the roster panel read it from here so they cannot drift apart. Flex seats are excluded, since no player is eligible at one and nobody is short of it. The seat table is the one place where slot ids and display labels meet.
function startingSlotsByPosition() {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    return lineupSeatsOf(counts, {
        labels: LINEUP_SLOT_LABELS[sport] || {},
        bench: NON_STARTING_SLOTS[sport] || new Set(),
        flexSlots: FLEX_SLOTS[sport] || new Set()
    }).byLabel;
}

// The first round's team order with the user sitting at the slot the setup strip chose. The league's own pickOrder is the starting point, so a league that has set one keeps its shape.
function firstRoundOrder(slot) {
    const declared = AppState.apiData?.settings?.draftSettings?.pickOrder;
    const base = (declared && declared.length ? declared.slice() : leagueTeamIds());
    if (!base.length) return [];
    const me = findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid) || base[0];
    const rest = base.filter(id => id !== me);
    const at = Math.min(Math.max(1, Number(slot) || 1), base.length) - 1;
    rest.splice(at, 0, me);
    return rest;
}

function mockDefaults() {
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const capacity = teams ? Math.max(1, Math.round(draftableCount() / teams)) : 1;
    return {
        slot: ownSlot() || 1,
        rounds: capacity,
        variance: 'Medium',
        // Shown so a draft can be re-run. Any integer does; this one just has to differ per run.
        seed: 1000 + Math.floor(Math.random() * 9000)
    };
}

let mockSetup = null;

function startMock() {
    const setup = mockSetup || mockDefaults();
    const rows = buildBoard().filter(r => r.value !== null);
    const order = draftOrder(firstRoundOrder(setup.slot), setup.rounds,
        AppState.apiData?.settings?.draftSettings?.type || 'SNAKE');
    const byId = new Map(rows.map(r => [r.player.id, r]));
    mock = {
        ...setup,
        order,
        rows,
        byId,
        // Consensus is the crowd's order, ADP where ESPN has one and value behind it. The bots draft this while the board beside them is the reader's own, and the two disagreeing is the point of a sheet.
        consensus: rows.slice().sort((a, b) => {
            const aa = adpOf(a.player), ba = adpOf(b.player);
            if (aa && ba) return aa - ba;
            if (aa) return -1;
            if (ba) return 1;
            return b.value - a.value;
        }).map(r => ({ id: r.player.id, positions: r.player.eligiblePositions || [] })),
        slots: startingSlotsByPosition(),
        userTeamId: firstRoundOrder(setup.slot)[Math.min(Math.max(1, setup.slot), 99) - 1],
        state: initialDraftState(order, setup.seed),
        stack: []
    };
}

function takenSet(state) {
    const taken = new Set();
    Object.keys(state.rosters).forEach(t => state.rosters[t].forEach(id => taken.add(id)));
    return taken;
}

function needsFor(state, teamId) {
    const positions = (state.rosters[teamId] || [])
        .map(id => (mock.byId.get(id)?.player.eligiblePositions) || []);
    return openNeeds(positions, mock.slots);
}

// The bot's randomness is a function of the state, not a generator ticking along beside it. A shared generator would give a different draft after an undo and a repeat of the same choice. Seeded per pick from the draft's seed, any state replays to the same picks however it was reached.
function randFor(state) {
    return seededRandom((mock.seed + state.pickIndex * 7919) >>> 0);
}

function botChoice(state) {
    const taken = takenSet(state);
    const needs = needsFor(state, teamOnClock(state));
    const candidates = mock.consensus.filter(c => !taken.has(c.id));
    const pick = botPick(candidates, needs, VARIANCE[mock.variance] ?? 0.5, randFor(state));
    return pick ? pick.id : null;
}

function draftForUser(playerId) {
    mock.stack.push(mock.state);
    mock.state = applyPick(mock.state, playerId);
    mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
}

function undoMock() {
    if (mock.stack.length) mock.state = mock.stack.pop();
}

// ==== The rehearsal, where the mock draft takes the plan as the reader's own pick list ====

// The round a given overall pick sits in. One definition, so a rehearsal's round, a real draft's round and the strip's Progress cell cannot disagree. Both numbers are 1-based.
function roundOfOverall(overall, teams) {
    return teams ? Math.floor((Number(overall) - 1) / teams) + 1 : 1;
}

// THE ROUND THIS PICK INDEX SITS IN, the one definition the masthead's own round figure is drawn from, so a rehearsal's own picks land in the round the header says they did.
function mockRoundOf(pickIndex) {
    const teams = mock.order.length && mockSetup ? firstRoundOrder(mockSetup.slot).length : leagueTeamIds().length;
    return roundOfOverall(pickIndex + 1, teams);
}

// The evaluator's walk. It takes the round's pick if still usable, else the first usable alternate. The strip's Board says cell runs the same walk against a real log, so there is no second copy of the rule. The usable check is the caller's own, since a rehearsal and a log differ in shape and not in meaning.
function resolvePlanAnswer(round, ctx, isUsable) {
    if (!plan) return { id: null, resolved: null };
    const resolved = resolvePlanRound(plan, round, ctx);
    if (isUsable(resolved.pick)) return { id: resolved.pick, resolved };
    // resolveRound's own candidates already walked the alternates for whatever its own pick was; this only still matters if the ROOM's own taken set (bots this rehearsal has already run, or picks the log has since recorded) disagrees with ctx.goneIds by one pick the caller has not yet folded in.
    const fallback = (resolved.candidates || []).find(isUsable);
    return { id: fallback !== undefined ? fallback : null, resolved };
}

// The plan's answer for this pick, or null. It is the round's target if still on the board, else the first alternate still on the board, read against the room's live taken set because a rehearsal has no log. It uses the same resolver the tray's fired read uses, so what Play out drafts and what the tray says will fire cannot disagree.
function planPickFor(state) {
    const round = mockRoundOf(state.pickIndex);
    const taken = takenSet(state);
    const usable = (id) => id !== null && id !== undefined && !taken.has(id) && mock.byId.has(id);
    const ctx = {
        goneIds: (state.picks || []).map(pk => pk.playerId),
        heldIds: (state.picks || []).filter(pk => pk.teamId === mock.userTeamId).map(pk => pk.playerId)
    };
    return resolvePlanAnswer(round, ctx, usable).id;
}

// The strip's Board says answer, one per mode. It walks like planPickFor but also returns the verdict, so the strip words its reason from the same evaluator the tray fires from.
function planAnswerForRehearse(state) {
    const round = mockRoundOf(state.pickIndex);
    const taken = takenSet(state);
    const usable = (id) => id !== null && id !== undefined && !taken.has(id) && mock.byId.has(id);
    const ctx = {
        goneIds: (state.picks || []).map(pk => pk.playerId),
        heldIds: (state.picks || []).filter(pk => pk.teamId === mock.userTeamId).map(pk => pk.playerId)
    };
    return { ...resolvePlanAnswer(round, ctx, usable), round };
}

// The companion's live rows are already the undrafted pool, so usable only needs the plan's pick to still exist there.
function planAnswerForLog(companion) {
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const round = companion.np ? roundOfOverall(companion.np.overall, teams) : null;
    if (!companion.np) return { id: null, resolved: null, round };
    const usable = (id) => id !== null && id !== undefined && companion.liveById.has(String(id));
    const ctx = {
        goneIds: (draftLog.picks || []).map(pk => pk.playerId),
        heldIds: (draftLog.picks || [])
            .filter(pk => companion.myTeamId !== null && String(pk.teamId) === String(companion.myTeamId))
            .map(pk => pk.playerId)
    };
    return { ...resolvePlanAnswer(round, ctx, usable), round };
}

// Runs the reader's own side of the whole draft, not only the rounds the plan covers, so the result is a finished board to look at. Where the plan has an answer it is drafted, and where it has none the board's own recommendation stands in.
function autoAdvancePlanPicks() {
    while (!draftComplete(mock.state) && teamOnClock(mock.state) === mock.userTeamId) {
        const planned = planPickFor(mock.state);
        if (planned !== null) {
            draftForUser(planned);
            continue;
        }
        const row = spotlightRowFor(mock.state) || availableRows(mock.state)[0];
        if (!row) break;
        draftForUser(row.player.id);
    }
}

// ==== What the mock knows ====

// The reader's next turn after this pick, which is what every question on this face is about. Counting from the pick after the current one matters when the current one is the reader's own.
function myNextPickIndex(state) {
    for (let i = state.pickIndex + 1; i < state.order.length; i++) {
        if (state.order[i] === mock.userTeamId) return i;
    }
    return -1;
}

// Resolves a held player's position from the caller's pool map first, since the mock's map is only filled in Rehearse and the strip also reads held players in Log picks. The mock's map is a fallback only, and a miss is never silently read as an unfilled seat.
function positionsOf(playerId, posById) {
    const fromPool = posById ? posById.get(String(playerId)) : null;
    if (fromPool && fromPool.length) return fromPool;
    return (mock && mock.byId.get(playerId)?.player.eligiblePositions) || [];
}

// Turns a board row's cells into a roster-totals line keyed by category id, the shape rosterTotals wants. A row carries its category figures only as the cells array, so a mock room's rows have no totals field to read.
function cellsToLine(row) {
    const line = {};
    (row?.cells || []).forEach(c => { if (c.value !== null && c.value !== undefined) line[c.id] = c.value; });
    return line;
}

function coverageNow(state) {
    const sport = AppState.loadedSport;
    const cats = Array.from(AppState.scoredStatIds);
    const specs = RATE_COMPONENTS[sport] || [];
    const sums = {};
    leagueTeamIds().forEach(t => {
        const lines = (state.rosters[t] || []).map(id => cellsToLine(mock.byId.get(id)));
        sums[t] = rosterTotals(lines, cats, specs);
    });
    return coverageOf(sums, mock.userTeamId, cats, { inverseIds: leagueInverseIds(sport) });
}

function availableRows(state) {
    const taken = takenSet(state);
    return mock.rows.filter(r => !taken.has(r.player.id));
}

// The same shape the companion context hands the board for a real log, built from the mock's own state. The row builders need not know whether gone and mine came from a real draft or a rehearsal, so there is one board reading a differently sourced companion.
function mockCompanionContext(rows, state) {
    const goneIds = new Set(Array.from(takenSet(state)).map(String));
    const mineIds = new Set((state.rosters[mock.userTeamId] || []).map(String));
    const targetIds = new Set(((plan && plan.rounds) || [])
        .filter(r => r.targetId !== null && r.targetId !== undefined)
        .map(r => String(r.targetId)));
    const liveRows = goneIds.size ? buildBoard(goneIds) : rows;
    const liveById = new Map(liveRows.map(r => [String(r.player.id), r]));
    const mine = myNextPickIndex(state);
    const nextOverall = mine >= 0 ? mine + 1 : 0;
    const currentOverall = state.pickIndex + 1;
    const overNextById = sportHasSeatGroups() ? new Map(valueOverNext(
        liveRows.filter(r => r.value !== null && r.value !== undefined).map(r => ({
            id: r.player.id, value: r.value, group: r.group, adp: adpOf(r.player)
        })),
        nextOverall,
        { groupOf: p => p.group, currentPick: currentOverall, adpOf: p => p.adp }
    ).rows.map(r => [String(r.id), r])) : null;
    return {
        order: state.order, myTeamId: mock.userTeamId, goneIds, mineIds, targetIds, liveRows, liveById,
        overNextById, nextOverall, currentOverall
    };
}

// ==== The face ====


// Who the strip's pick button is about. It is the board's best fit by default, held until the pick is made so a reader is never one stray click from a pick nobody meant.
let spotlightId = null;

// The walk itself. A held pick comes first, then the best fit against the open seat labels, then whatever is best left. The rows are the pool still available and the held ids are the reader's own roster.
function spotlightFallback(rows, heldIds) {
    if (!rows.length) return null;
    if (spotlightId !== null) {
        const held = rows.find(r => r.player.id === spotlightId);
        if (held) return held;
        spotlightId = null;
    }
    const open = new Set(openStarterLabels(heldIds || []));
    return rows.find(r => (r.player.eligiblePositions || []).some(p => open.has(p))) || rows[0];
}

function spotlightRowFor(state) {
    return spotlightFallback(availableRows(state), state.rosters[mock.userTeamId]);
}


// Which named seats a roster still has open. It is answered from the same seating the plan tray uses, so one seating rule serves the plan, the log and a rehearsal. Only a named seat counts, since a flex seat takes anyone.
function openStarterLabels(playerIds) {
    const seats = planLeagueSeats();
    const ctx = planCtx();
    const { state } = seatAll(playerIds, planPool(), seats, ctx);
    return state.seats
        .filter(s => !s.bench && !(ctx.flexPositions || {})[s.slotId] && (s.playerId === null || s.playerId === undefined))
        .map(s => s.label);
}

// The rehearse popover, with slot, rounds, bot reach and seed. The rounds default to the one round figure the whole tab shares. The element ids are unchanged so the mock face's existing handler still wires it.
function rehearsePopoverHtml() {
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    if (!mockSetup) {
        const defaults = mockDefaults();
        mockSetup = { ...defaults, rounds: planRoundCount(teams) || defaults.rounds };
    }
    const d = mockSetup;
    const slots = Array.from({ length: Math.max(1, teams) }, (_, i) => i + 1)
        .map(n => `<option value="${n}"${n === d.slot ? ' selected' : ''}>${n}</option>`).join('');
    const variances = Object.keys(VARIANCE)
        .map(v => `<option value="${v}"${v === d.variance ? ' selected' : ''}>${v}</option>`).join('');
    return `
        <div class="draft-rehearse-popover">
            <div class="draft-tray-head"><span class="dr-card-label lh-block-head">Rehearse</span></div>
            <div class="dm-setup">
                <span class="dm-setup-item">${teams} teams</span>
                <label class="dm-setup-item">Your slot <select id="dm-slot" class="dm-select">${slots}</select></label>
                <label class="dm-setup-item">Rounds <input id="dm-rounds" class="dm-num" type="number" min="1" max="60" value="${d.rounds}"></label>
                <label class="dm-setup-item">Bot reach <select id="dm-variance" class="dm-select">${variances}</select></label>
                <label class="dm-setup-item">Seed<input id="dm-seed" class="dm-num" type="number" value="${d.seed}"></label>
            </div>
            <div class="dr-quiet draft-rehearse-note">Plays your plan through where it has an
                answer; the board's own recommendation stands in the rest of the way.</div>
            <button type="button" id="dm-start" class="dm-primary draft-tray-fill">Start</button>
        </div>
    `;
}

// The tray in status form. Each round reads as landed, gone with what filled the seat instead, or still on the board. On the board is a real third state, because a target not yet landed is not gone, and a hit is only set once the pick has happened.
function rehearseTrayRowHtml(round, state, resolved) {
    const hasTarget = round.targetId !== null && round.targetId !== undefined;
    if (!hasTarget) {
        // An open round with no target is the round, the pick and the empty seat chip and nothing else, to avoid repeating a placeholder for every empty round.
        return `<div class="draft-tray-row">`
            + `<span class="draft-tray-round">R${round.round}<small>pick ${round.pick}</small></span>`
            + `<span class="draft-tray-seat">${String.fromCharCode(8212)}</span>`
            + '<span class="draft-tray-t"></span>'
            + '<span class="draft-tray-verdict"></span></div>';
    }
    const p = mock.byId.get(round.targetId)?.player;
    const name = p ? p.name : `Player ${round.targetId}`;
    const seat = p ? (p.eligiblePositions[0] || '') : '';
    const picks = state.picks || [];
    const hit = picks.find(pk => String(pk.playerId) === String(round.targetId));
    // The fired read, the same supplement the draft-day tray adds. The row's own name, seat and status stay the written target and this is a comment on it.
    const firedText = ruleFiredText(resolved, id => mock.byId.get(id)?.player.name || `Player ${id}`);
    const firedHtml = firedText ? ` <span class="draft-tray-rule-fired">${escapeHtml(firedText)}</span>` : '';

    let cls = '';
    let statusHtml;
    let verdictHtml = '<span class="draft-tray-verdict"></span>';
    if (hit && hit.teamId === mock.userTeamId) {
        cls = ' draft-tray-row-mine';
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">landed, pick ${hit.pick}</span>${firedHtml}`;
    } else if (hit) {
        cls = ' draft-tray-row-gone';
        const seatPick = picks.find(pk => pk.pick === round.pick);
        let seatNote = '';
        if (seatPick && String(seatPick.playerId) !== String(round.targetId)) {
            const wasAlt = (round.alternateIds || []).some(id => id !== null && id !== undefined && String(id) === String(seatPick.playerId));
            const seatName = mock.byId.get(seatPick.playerId)?.player.name || `Player ${seatPick.playerId}`;
            seatNote = ` <span class="draft-tray-alt">${wasAlt ? 'alternate' : 'board pick'}: ${escapeHtml(seatName)}</span>`;
        }
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">GONE, ${escapeHtml(teamNameOf(hit.teamId))} at pick ${hit.pick}</span>${seatNote}${firedHtml}`;
    } else {
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">on the board</span>${firedHtml}`;
        const adp = adpOf(p);
        if (adp) {
            const word = survivalWord(adp, round.pick, state.pickIndex + 1);
            const bad = word === 'unlikely' || word === 'no' ? ' draft-tray-verdict-bad' : '';
            if (word) verdictHtml = `<span class="draft-tray-verdict${bad}">${escapeHtml(word)}</span>`;
        }
    }

    return `<div class="draft-tray-row${cls}">`
        + `<span class="draft-tray-round">R${round.round}<small>pick ${round.pick}</small></span>`
        + `<span class="draft-tray-seat draft-tray-seat-on">${escapeHtml(seat || String.fromCharCode(8212))}</span>`
        + `<span class="draft-tray-t">${statusHtml}</span>`
        + verdictHtml
        + '</div>';
}

// A drag handle on the tray's left edge. One markup fragment is inserted into all three tray variants, since the resize behaviour is the same whichever tray is showing.
function trayHandleHtml() {
    return '<div class="draft-tray-handle" data-tray-handle title="Drag to resize"></div>';
}

// ==== The tray's prelude, Board at a glance then My roster, shared by all three tray variants ====

// Board at a glance draws the whole draft, rounds down and teams across, with the reader's column and the pick on the clock marked. It shows real picks only and returns an empty string with none. A position's hue is one of eight tokens addressed by the position's name, and an unmapped code falls back to the neutral grey.
function posColorVar(pos) {
    const token = String(pos || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return token ? `var(--dr-pos-${token}, var(--surface-3))` : 'var(--surface-3)';
}

// The team row above the grid, All plus one chip per team with the reader's own marked. A chosen team dims every other column and adds the picks list below. The filter is resolved against this grid's teams, so a stale id dims nothing instead of matching another team's column.
function glanceTeamChipsHtml(teams, chosenTeam) {
    const allChip = `<button type="button" class="dr-filter-pill${chosenTeam === null ? ' dr-filter-pill-on' : ''}" data-glance-team="">All</button>`;
    const teamChips = teams.map(t => `<button type="button" class="dr-filter-pill${sameGlanceTeam(t, chosenTeam) ? ' dr-filter-pill-on' : ''}" data-glance-team="${escapeHtml(String(t))}" title="${escapeHtml(teamNameOf(t))}">${escapeHtml(teamNameOf(t).slice(0, 3))}</button>`).join('');
    return `<div class="ds-glance-teams">${allChip}${teamChips}</div>`;
}

function sameGlanceTeam(a, b) {
    return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

// The chosen team's picks, under the grid, from the roster builder's own rows. The overall pick number is the entry's position in the picks array, since the log and the mock room name it differently. That keeps this list's round in agreement with the grid's.
function glanceTeamListHtml(chosenTeam, picks, order, posById, teams) {
    const { byTeam } = rostersFromLog({ picks });
    const ids = byTeam[String(chosenTeam)] || [];
    const overallByPlayer = new Map(picks.map((p, i) => [String(p.playerId), i + 1]));
    const byId = new Map((AppState.playerData || []).map(p => [String(p.id), p]));
    const rowsHtml = ids.map(pid => {
        const overall = overallByPlayer.get(String(pid));
        const round = overall ? Math.ceil(overall / teams) : null;
        const name = byId.get(String(pid))?.name || `Player ${pid}`;
        const pos = posById.get(String(pid)) || '';
        return `<div class="ds-glance-teamrow">`
            + `<span class="ds-glance-teamrow-round">${round ? `R${round}` : String.fromCharCode(8212)}</span>`
            + `<span class="ds-glance-teamrow-name">${escapeHtml(name)}</span>`
            + `<span class="ds-glance-teamrow-pos">${escapeHtml(pos)}</span>`
            + `<span class="ds-glance-teamrow-pick">${overall ? `pick ${overall}` : ''}</span>`
            + `</div>`;
    }).join('');
    const resolvedOrderTeam = order.find(t => sameGlanceTeam(t, chosenTeam));
    const nextOverall = resolvedOrderTeam === undefined ? undefined
        : picksFor(order, resolvedOrderTeam).find(n => n > picks.length);
    const nextHtml = nextOverall
        ? `Next pick: overall ${nextOverall} (round ${Math.ceil(nextOverall / teams)})`
        : 'No picks left';
    return `
        <div class="ds-glance-teamlist">
            <div class="ds-glance-teamlist-rows">${rowsHtml || '<span class="dr-quiet">No picks yet</span>'}</div>
            <div class="ds-glance-teamlist-next">${escapeHtml(nextHtml)}</div>
        </div>`;
}

function trayGlanceHtml(rows, picks, order, userTeamId) {
    if (!order.length) return '';
    const teams = new Set(order.map(String)).size || 1;
    const rounds = Math.ceil(order.length / teams);
    const posById = new Map(rows.map(r => [String(r.player.id), (r.player.eligiblePositions || [])[0] || '']));
    const grid = picksGrid(picks, order, rounds, teams, { userTeamId, positionOf: id => posById.get(String(id)) || null });
    // Resolved against this grid's own teams and never trusted as typed, so a filter chosen on an abandoned league dims nothing.
    const chosenTeam = glanceTeamFilter !== null && grid.teams.some(t => sameGlanceTeam(t, glanceTeamFilter))
        ? glanceTeamFilter : null;
    const headHtml = grid.teams.map((t, col) => `<span class="ds-glance-cell ds-glance-head${col === grid.userColumn ? ' ds-glance-mine' : ''}${chosenTeam !== null && !sameGlanceTeam(t, chosenTeam) ? ' ds-glance-dim' : ''}" title="${escapeHtml(teamNameOf(t))}">${escapeHtml(teamNameOf(t).slice(0, 3))}</span>`).join('');
    // Status is outline and inset, and colour is position. A cell's background is the position's hue when a pick has landed there, and mine and on the clock are drawn over it as a ring and an outline. The position code moves to the hover title because the colour carries it.
    const rowsHtml = grid.grid.map(round => '<div class="ds-glance-row">'
        + round.cells.map((c, col) => {
            const cls = ['ds-glance-cell'];
            if (col === grid.userColumn) cls.push('ds-glance-mine');
            if (c.onTheClock) cls.push('ds-glance-clock');
            if (chosenTeam !== null && !sameGlanceTeam(grid.teams[col], chosenTeam)) cls.push('ds-glance-dim');
            const title = `${teamNameOf(c.teamId)}${c.overall ? ` ${MIDDOT} pick ${c.overall}` : ''}${c.position ? ` ${MIDDOT} ${c.position}` : ''}`;
            const style = c.filled ? ` style="background:${posColorVar(c.position)}"` : '';
            return `<span class="${cls.join(' ')}"${style} title="${escapeHtml(title)}"></span>`;
        }).join('') + '</div>').join('');
    return `
        <div class="draft-tray-glance">
            <span class="dr-card-label lh-block-head">Board at a glance</span>
            ${glanceTeamChipsHtml(grid.teams, chosenTeam)}
            <div class="ds-glance-grid">
                <div class="ds-glance-row ds-glance-headrow">${headHtml}</div>
                ${rowsHtml}
            </div>
            <div class="ds-glance-legend">
                <span><i class="ds-glance-swatch ds-glance-mine"></i>You</span>
                <span><i class="ds-glance-swatch ds-glance-clock"></i>On the clock</span>
            </div>
            ${chosenTeam !== null ? glanceTeamListHtml(chosenTeam, picks, order, posById, teams) : ''}
        </div>`;
}

// My roster. The starting seats, two to a row, each with its player and the pick or round that landed them, and empty for what is open. The seat state is the caller's own read of the one seating rule all three modes share. The label under the name is the caller's, since a real pick and a planned round are different facts.
function trayRosterHtml(seatState, labelFor) {
    if (!seatState || !seatState.seats.length) return '';
    const starters = seatState.seats.filter(s => !s.bench);
    if (!starters.length) return '';
    const byId = new Map((AppState.playerData || []).map(p => [String(p.id), p]));
    const cellsHtml = starters.map(s => {
        const filled = s.playerId !== null && s.playerId !== undefined;
        const name = filled ? (byId.get(String(s.playerId))?.name || `Player ${s.playerId}`) : '';
        const label = filled ? labelFor(s.playerId) : '';
        return `<div class="ds-roster-seat${filled ? '' : ' ds-roster-empty'}">`
            + `<span class="ds-roster-label">${escapeHtml(s.label)}</span>`
            + (filled
                ? `<span class="ds-roster-name">${escapeHtml(name)}</span><span class="ds-roster-pick">${escapeHtml(label)}</span>`
                : '<span class="ds-roster-name dr-quiet">empty</span>')
            + '</div>';
    }).join('');
    return `
        <div class="draft-tray-roster">
            <span class="dr-card-label lh-block-head">My roster</span>
            <div class="ds-roster-grid">${cellsHtml}</div>
        </div>`;
}

function rehearseTrayHtml(rows, state) {
    // The strip head's own companion state. Draft moved here from the row as the one-click shortcut for the plan's next open target. It is computed before the empty-plan return, so a rehearsal with no plan still says whose clock it is.
    const onTheClock = teamOnClock(state) === mock.userTeamId;
    if (!plan || !plan.rounds || !plan.rounds.length) {
        const head = companionHeadHtml(companionHeadState({ isRehearse: true, isFollowingRoom: false, onTheClock, nextTarget: null }));
        return `<div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">${trayHandleHtml()}<div class="draft-tray-head">`
            + `<span class="dr-card-label lh-block-head">Plan</span>${head}</div>`
            + '<div class="dr-quiet draft-rehearse-note">No plan to rehearse - the board recommends every pick instead.</div></div>';
    }
    // The fired read against the mock's own state, with who is gone and who this team already holds, in the resolver's usual context shape.
    const ruleCtx = {
        goneIds: (state.picks || []).map(pk => pk.playerId),
        heldIds: (state.picks || []).filter(pk => pk.teamId === mock.userTeamId).map(pk => pk.playerId)
    };
    const rowsHtml = plan.rounds.map(r => rehearseTrayRowHtml(r, state, resolvePlanRound(plan, r.round, ruleCtx))).join('');
    const targeted = plan.rounds.filter(r => r.targetId !== null && r.targetId !== undefined);
    const landed = targeted.filter(r => (state.picks || [])
        .some(p => String(p.playerId) === String(r.targetId) && p.teamId === mock.userTeamId)).length;
    // The glance grid comes from the mock room's picks and order, and the roster from its own rosters. The pick number that landed each seated player is read off the state's picks.
    const glance = trayGlanceHtml(rows, state.picks, state.order, mock.userTeamId);
    const seatState = seatAll(state.rosters[mock.userTeamId] || [], planPool(), planLeagueSeats(), planCtx()).state;
    const pickOf = (playerId) => {
        const pk = (state.picks || []).find(p => String(p.playerId) === String(playerId));
        return pk ? `pick ${pk.pick}` : '';
    };
    const nextTarget = planNextOpenTarget(mockCompanionContext(rows, state), state.picks);
    const head = companionHeadHtml(companionHeadState({ isRehearse: true, isFollowingRoom: false, onTheClock, nextTarget }));
    return `
        <div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">
            ${trayHandleHtml()}
            <div class="draft-tray-head">
                <span class="dr-card-label lh-block-head">Plan</span>
                <span class="draft-tray-count">${landed} of ${targeted.length} landed</span>
                ${head}
            </div>
            ${glance}
            ${trayRosterHtml(seatState, pickOf)}
            <div class="draft-tray-ledger">${rowsHtml}</div>
        </div>
    `;
}

// The log picks row in status form, with the same three states the rehearse tray reads but taken from the plan's status. Open is answered for a round not yet reached, never a false gone. The fired read is shown beside the row's existing target-based status and does not replace it. The row's identity stays the written target, and a rule is a comment on it.
function ruleFiredText(resolved, nameOf) {
    if (!resolved || !resolved.firedRule || resolved.reason === 'target' || resolved.reason === 'nobody') return '';
    if (resolved.pick === null || resolved.pick === undefined) return '';
    const pickName = nameOf(resolved.pick);
    if (resolved.reason === 'if-i-have') {
        const condRound = planRoundOf(resolved.firedRule.playerId);
        const condName = nameOf(resolved.firedRule.playerId);
        return `rule fires: ${pickName}${condRound ? ` (${condName} landed in R${condRound})` : ''}`;
    }
    if (resolved.reason === 'prefer') return `rule fires: ${pickName} (preferred)`;
    if (resolved.reason === 'if-gone') return `rule fires: ${pickName} (target gone)`;
    return '';
}

function logTrayRowHtml(r, byId, seatLabelByPlayer, resolved) {
    if (r.targetId === null || r.targetId === undefined) {
        return `<div class="draft-tray-row">`
            + `<span class="draft-tray-round">R${r.round}<small>pick ${r.pick}</small></span>`
            + `<span class="draft-tray-seat">${String.fromCharCode(8212)}</span>`
            + '<span class="draft-tray-t"></span>'
            + '<span class="draft-tray-verdict"></span></div>';
    }
    const p = byId.get(String(r.targetId));
    const name = p ? p.name : `Player ${r.targetId}`;
    // A landed pick's seat is the one it actually holds through the seating, never the first eligible position, which a round still open or gone to someone else has to fall back to.
    const seatedLabel = r.status === 'mine' ? seatLabelByPlayer.get(String(r.targetId)) : null;
    const seat = seatedLabel || (p ? (p.eligiblePositions?.[0] || '') : '');
    const firedText = ruleFiredText(resolved, id => byId.get(String(id))?.name || `Player ${id}`);
    const firedHtml = firedText ? ` <span class="draft-tray-rule-fired">${escapeHtml(firedText)}</span>` : '';
    let cls = '';
    let statusHtml;
    if (r.status === 'mine') {
        cls = ' draft-tray-row-mine';
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">landed, pick ${r.takenAt ? r.takenAt.overall : ''}</span>${firedHtml}`;
    } else if (r.status === 'taken') {
        cls = ' draft-tray-row-gone';
        const teamName = r.takenAt ? teamNameOf(r.takenAt.teamId) : '';
        const promoted = r.promotedId !== null && r.promotedId !== undefined
            ? (byId.get(String(r.promotedId))?.name || `Player ${r.promotedId}`) : null;
        const seatNote = promoted
            ? ` <span class="draft-tray-alt">next: ${escapeHtml(promoted)}</span>`
            : (r.reason ? ` <span class="draft-tray-alt">${escapeHtml(r.reason)}</span>` : '');
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">GONE, ${escapeHtml(teamName)} at pick ${r.takenAt ? r.takenAt.overall : ''}</span>${seatNote}${firedHtml}`;
    } else {
        statusHtml = `<b>${escapeHtml(name)}</b><span class="draft-tray-status">on the board</span>${firedHtml}`;
    }
    return `<div class="draft-tray-row${cls}">`
        + `<span class="draft-tray-round">R${r.round}<small>pick ${r.pick}</small></span>`
        + `<span class="draft-tray-seat draft-tray-seat-on">${escapeHtml(seat || String.fromCharCode(8212))}</span>`
        + `<span class="draft-tray-t">${statusHtml}</span>`
        + '<span class="draft-tray-verdict"></span></div>';
}

// The log defaults to the real pick log. The frozen board's Plan tray passes the real draft's log instead, for the same status-form reading off what the draft actually did.
function logTrayHtml(boardRows, companion, log = draftLog, emptyNote = 'No plan on file - log picks against the board alone.') {
    // The strip head's companion state, shown here only while a real room is being followed. Taken moved here from the row for that case. It is computed before the empty-plan return so a followed room with no plan still says so.
    const emptyHead = companionHeadHtml(companionHeadState({ isRehearse: false, isFollowingRoom: !!companion.room, nextTarget: null }));
    if (!plan || !plan.rounds || !plan.rounds.length) {
        return `<div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">${trayHandleHtml()}<div class="draft-tray-head">`
            + `<span class="dr-card-label lh-block-head">Plan</span>${emptyHead}</div>`
            + `<div class="dr-quiet draft-rehearse-note">${escapeHtml(emptyNote)}</div></div>`;
    }
    const statusRows = planStatus(plan, log, companion.order, { myTeamId: companion.myTeamId });
    const byId = new Map((AppState.playerData || []).map(p => [String(p.id), p]));
    const targeted = statusRows.filter(r => r.targetId !== null && r.targetId !== undefined);
    const landed = targeted.filter(r => r.status === 'mine').length;
    // The log's picks are seated for real rather than guessing each landed row's seat off its first eligible position, since an actual seat can differ once the roster already has it filled.
    const seatState = companion.myTeamId !== null && companion.myTeamId !== undefined
        ? logSeats(log, companion.myTeamId, planPool(), planLeagueSeats(), planCtx())
        : null;
    const seatLabelByPlayer = new Map((seatState?.state.seats || [])
        .filter(s => s.playerId !== null && s.playerId !== undefined)
        .map(s => [String(s.playerId), s.label]));
    // The fired read against the log, with who is gone and who this team holds, built off the log because this tray reads real picks.
    const ruleCtx = {
        goneIds: (log?.picks || []).map(pk => pk.playerId),
        heldIds: (log?.picks || []).filter(pk => String(pk.teamId) === String(companion.myTeamId)).map(pk => pk.playerId)
    };
    // The glance grid comes from the log's picks and the companion's order. My roster uses the same seat state the ledger's seat labels use, with the pick that landed each seated player read straight off the log.
    const glance = trayGlanceHtml(boardRows, log?.picks || [], companion.order, companion.myTeamId);
    const pickOf = (playerId) => {
        const pk = (log?.picks || []).find(p => String(p.playerId) === String(playerId));
        return pk ? `pick ${pk.overall}` : '';
    };
    const ledgerRowsHtml = statusRows.map(r => logTrayRowHtml(r, byId, seatLabelByPlayer, resolvePlanRound(plan, r.round, ruleCtx))).join('');
    // In the sidebar the ledger folds behind a native details element, with no script toggle to wire. The glance grid stays the default view, and opening the ledger is the reader's choice, which is the one case where this tray scrolls internally. The full-tab markup is unchanged.
    const isSidebarSurface = document.documentElement.getAttribute('data-surface') === 'sidebar';
    const ledgerBlock = isSidebarSurface
        ? `<details class="draft-tray-ledger-fold"><summary class="draft-tray-ledger-summary">Picks - ${statusRows.length}</summary><div class="draft-tray-ledger">${ledgerRowsHtml}</div></details>`
        : `<div class="draft-tray-ledger">${ledgerRowsHtml}</div>`;
    const nextTarget = planNextOpenTarget(companion, log?.picks || []);
    const head = companionHeadHtml(companionHeadState({ isRehearse: false, isFollowingRoom: !!companion.room, nextTarget }));
    return `
        <div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">
            ${trayHandleHtml()}
            <div class="draft-tray-head">
                <span class="dr-card-label lh-block-head">Plan</span>
                <span class="draft-tray-count">${landed} of ${targeted.length} landed</span>
                ${head}
            </div>
            ${glance}
            ${trayRosterHtml(seatState?.state, pickOf)}
            ${ledgerBlock}
        </div>
    `;
}

// ==== The status strip, one strip for both modes ==== Five cells over whichever companion the board built, plus one alert line. Nothing here is a second source of truth, and the strip module adds no math. The seat group at risk from the position cliff is not part of the alert, since the cliff is a fact about the whole remaining pool.

// What every team still needs, built once per strip render rather than once per next-up entry. It reads the full board, the pool as the draft found it, so a team holding a player long since taken still resolves their seat.
function stripNeedsByTeam(mode, positionsOf) {
    const slots = startingSlotsByPosition();
    const result = {};
    leagueTeamIds().forEach(t => {
        result[t] = mode === 'rehearse' ? needsFor(mock.state, t) : logNeeds(draftLog, t, { positionsOf, slots });
    });
    return result;
}

// The pick the strip's Board says cell names. The plan's answer comes first, through the same resolver the Draft button and Play out use, and the board's own recommendation stands in where the plan is silent. It is one fallback rule over whichever mode's live rows and roster.
function boardSaysRow(companion, mode) {
    if (mode === 'rehearse') {
        const state = mock.state;
        const answer = planAnswerForRehearse(state);
        const row = answer.id !== null ? mock.byId.get(answer.id) : null;
        return row ? { row, answer, viaPlan: true } : { row: spotlightRowFor(state), answer, viaPlan: false };
    }
    const answer = planAnswerForLog(companion);
    const row = answer.id !== null ? companion.liveById.get(String(answer.id)) : null;
    return row ? { row, answer, viaPlan: true }
        : { row: spotlightFallback(companion.liveRows, Array.from(companion.mineIds)), answer, viaPlan: false };
}

// The reason line. It is the plan's rule when one fired, else the round's target for a plain target, else the open named seat the pick fills, and Best available when it fills none.
function boardSaysReason(picked, openLabels) {
    const { row, answer, viaPlan } = picked;
    if (!row) return '';
    if (viaPlan) {
        const fired = ruleFiredText(answer.resolved, id => (String(id) === String(row.player.id))
            ? row.player.name : `Player ${id}`);
        if (fired) return fired.replace(/^rule fires: /, 'Plan: ');
        return `Round ${answer.round} target`;
    }
    const seat = (row.player.eligiblePositions || []).find(p => openLabels.has(p));
    return seat ? `Fills ${seat}` : 'Best available';
}

// The mode is rehearse or log. The rows are the full board, unaffected by who has been drafted, and the companion is the one the board already built for the table beneath the strip.
function draftStripHtml(rows, companion, mode) {
    const isRehearse = mode === 'rehearse';
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const state = isRehearse ? mock.state : null;
    const complete = isRehearse ? draftComplete(state) : !companion.np;

    // Undo reads as a real pick that does not exist when it says Undo pick 0, so a plain Undo is the label until something is logged. It is disabled with a room label when the log's last pick came from the room, the same guard undoLog applies, so the button never invites a click it will refuse.
    const lastPick = !isRehearse ? draftLog.picks[draftLog.picks.length - 1] : null;
    const lastIsRoom = !!(lastPick && lastPick.source === 'room');
    const undoBtn = isRehearse
        ? `<button type="button" id="dm-undo" class="dm-flat"${mock.stack.length ? '' : ' disabled'}>Undo</button>`
        : `<button type="button" id="dr-log-undo" class="dm-flat"${(draftLog.picks.length && !lastIsRoom) ? '' : ' disabled'}${lastIsRoom ? ' title="From the room - Undo covers hand picks only"' : ''}>${draftLog.picks.length ? `Undo pick ${draftLog.picks.length}` : 'Undo'}</button>`;
    // On the sidebar's Picks and Roster foot tabs the strip shows only its clock cell, since the other cells answer what to do now and belong to the Board tab. The cells are still built but not joined into the markup, so the strip module's contract does not move.
    const clockOnly = document.documentElement.getAttribute('data-surface') === 'sidebar'
        && (sidebarFootTab === 'picks' || sidebarFootTab === 'roster');
    if (complete) {
        return `
            <div class="ds-strip-wrap">
                <div class="ds-strip">
                    <div class="ds-cell ds-cell-clock"><span class="ds-clock-pk">Draft complete</span></div>
                    ${clockOnly ? '' : `<div class="ds-cell ds-cell-progress"><span class="ds-cell-label">Progress</span>${undoBtn}</div>`}
                </div>
            </div>
        `;
    }

    const overall = isRehearse ? state.pickIndex + 1 : companion.np.overall;
    const round = isRehearse ? mockRoundOf(state.pickIndex) : roundOfOverall(overall, teams);
    const onClockId = isRehearse ? teamOnClock(state) : companion.np.teamId;
    const yours = isRehearse ? onClockId === mock.userTeamId
        : (companion.myTeamId !== null && String(onClockId) === String(companion.myTeamId));
    const order = isRehearse ? state.order : companion.order;
    const total = order.length;
    const pct = total ? Math.round(((overall - 1) / total) * 100) : 0;
    const userTeamId = isRehearse ? mock.userTeamId : companion.myTeamId;
    const heldIds = isRehearse ? (state.rosters[mock.userTeamId] || []) : Array.from(companion.mineIds);

    // ---- On the clock ----
    const clockCell = `
        <div class="ds-cell ds-cell-clock">
            <span class="ds-cell-label">On the clock</span>
            <span class="ds-clock-pk">Rd ${round} ${MIDDOT} Pk ${overall}</span>
            <span class="ds-clock-who">${escapeHtml(yours ? 'You are on the clock' : `${teamNameOf(onClockId)} on the clock`)}</span>
            <div class="ds-bar"><div class="ds-bar-fill" style="width:${pct}%"></div></div>
        </div>`;

    // ---- Next up ----
    const posById = new Map(rows.map(r => [String(r.player.id), r.player.eligiblePositions || []]));
    const primaryOf = (id) => (posById.get(String(id)) || [])[0] || '';
    const needsByTeam = stripNeedsByTeam(mode, primaryOf);
    const next = nextUp(order, overall - 1, userTeamId, needsByTeam, 5);
    // (you) is text and not only the accent tint, because nothing on a tinted row says in words that the team is the reader's own. Every listed pick that is the reader's says so in the same three characters used below.
    const pickChip = (p) => `<div class="ds-next-pick${p.isUser ? ' ds-next-pick-user' : ''}">`
        + `<span class="ds-next-pk">${p.overall}</span><span class="ds-next-team">${escapeHtml(teamNameOf(p.teamId))}${p.isUser ? ' <b>(you)</b>' : ''}</span>`
        + (p.needs.length ? `<span class="ds-next-needs">${escapeHtml(p.needs.map(n => n.position).join(', '))}</span>` : '')
        + '</div>';
    const thenYouHtml = next.thenYou && !next.thenYou.listed
        ? `<div class="ds-next-pick ds-next-thenyou"><span class="ds-next-pk">${next.thenYou.overall}</span>`
            + '<span class="ds-next-team">then you</span></div>'
        : '';
    const nextCell = `
        <div class="ds-cell ds-cell-next">
            <span class="ds-cell-label">Next up</span>
            <div class="ds-next-list">${next.picks.map(pickChip).join('')}${thenYouHtml}</div>
        </div>`;

    // ---- Board says ---- The tier is the recommended position's own, since the tier function filters and cuts internally. This only restricts to the draftable range, which the pure engine has no reason to know, because no draft happens after the last pick.
    const openLabels = new Set(openStarterLabels(heldIds));
    const picked = boardSaysRow(companion, mode);
    const row = picked.row;
    const draftableRows = rows.filter(r => r.value !== null).slice(0, draftableCount() || rows.length);
    const takenIds = isRehearse ? Array.from(takenSet(state)) : Array.from(companion.goneIds);
    const tier = row ? tierState(draftableRows, takenIds, (row.player.eligiblePositions || [])[0] || '',
        { playerId: row.player.id }) : null;

    let boardCell;
    if (!row) {
        boardCell = `
            <div class="ds-cell ds-cell-board">
                <span class="ds-cell-label">Board says</span>
                <span class="dr-quiet">Nothing left to recommend.</span>
            </div>`;
    } else {
        const p = row.player;
        const adp = adpOf(p);
        const word = survivalWord(adp, companion.nextOverall, companion.currentOverall);
        const reason = boardSaysReason(picked, openLabels);
        const facts = [p.positionDisplay || (p.eligiblePositions || [])[0] || '',
            tier ? `T${tier.tier}` : '', word ? `${word} to survive` : ''].filter(Boolean).join(` ${MIDDOT} `);
        // The card is information only. Its Draft and Add to plan actions are reached elsewhere on the same tab through the same handlers, by the row's revealed Draft and the row's star.
        boardCell = `
            <div class="ds-cell ds-cell-board">
                <span class="ds-cell-label">Board says</span>
                <div class="ds-board-row">
                    <div class="ds-board-avatar">${buildPlayerAvatarHtml(AppState.loadedSport, p.id, p.name)}</div>
                    <div class="ds-board-info">
                        <span class="ds-board-name">${escapeHtml(p.name)}</span>
                        <span class="draft-clock-facts">${escapeHtml(facts)}</span>
                        <span class="ds-board-reason">${escapeHtml(reason)}</span>
                    </div>
                </div>
            </div>`;
    }

    // ---- Tier break ---- The same reading Board says used.
    let tierCell;
    if (tier) {
        const bars = Array.from({ length: tier.total }, (_, i) =>
            `<span class="ds-tier-bar${i < tier.taken ? ' ds-tier-bar-gone' : ''}"></span>`).join('');
        tierCell = `
            <div class="ds-cell ds-cell-tier">
                <span class="ds-cell-label">Tier break</span>
                <span class="ds-tier-line">${tier.left} ${escapeHtml(tier.position)} left in tier ${tier.tier}</span>
                <div class="ds-tier-bars">${bars}</div>
                <span class="ds-tier-sub">${tier.taken} of ${tier.total} already drafted</span>
            </div>`;
    } else {
        const pos = row ? (row.player.eligiblePositions || [])[0] || '' : '';
        tierCell = `
            <div class="ds-cell ds-cell-tier">
                <span class="ds-cell-label">Tier break</span>
                <span class="dr-quiet">${pos ? `No ${escapeHtml(pos)} left.` : String.fromCharCode(8212)}</span>
            </div>`;
    }

    // ---- Progress ----
    const totalRounds = teams ? Math.ceil(total / teams) : 0;
    // A room being followed replaces both lines rather than adding a third. Who is picking is already answered by On the clock, so the room's two facts, how far in and how long since the last pick, take the line.
    const room = !isRehearse ? companion.room : null;
    const roundBit = totalRounds ? ` ${MIDDOT} round ${round} of ${totalRounds}` : '';
    const ageSecs = room && Number.isFinite(room.lastPickAt) ? Math.max(0, Math.round((Date.now() - room.lastPickAt) / 1000)) : null;
    const progressLine = room
        ? `Following the room ${MIDDOT} ${overall - 1} of ${total} picks`
        : `${yours ? 'Your pick' : `${teamNameOf(onClockId)} picking`} ${MIDDOT} ${pct}% complete`;
    const progressSub = room
        ? `${ageWords(ageSecs) !== null ? `last pick ${ageWords(ageSecs)}` : 'no pick reported yet'}${roundBit}`
        : `${overall - 1} of ${total} picks${roundBit}`;
    // The ticker reads these attributes back rather than re-rendering the tab each second, since a full render would cost the search box its focus and any open note editor its draft. An undefined last pick time leaves the attribute off, which tells the ticker to do nothing.
    const subAttrs = room && Number.isFinite(room.lastPickAt)
        ? ` data-last-pick-at="${room.lastPickAt}" data-round-bit="${escapeHtml(roundBit)}"` : '';
    let trackHtml = '';
    let progressActs;
    if (isRehearse) {
        // Restart and Stop live here with the run's other controls, Play out and Undo, rather than being split across two cells.
        const restartStop = mock ? `<button type="button" id="dm-restart" class="dm-flat">Restart</button><button type="button" id="dm-stop" class="dm-flat">Stop</button>` : '';
        progressActs = `<button type="button" id="dm-playout" class="dm-flat">Play out</button>${undoBtn}${restartStop}`;
    } else {
        const teamSelect = `<select id="dr-log-team" class="dm-select draft-tally-team" title="Log the next pick against this team">`
            + leagueTeamIds().map(t => `<option value="${t}"${String(t) === String(onClockId) ? ' selected' : ''}>${escapeHtml(teamNameOf(t))}</option>`).join('')
            + '</select>';
        // The log's tick track. A pick not yet made is unlit, the reader's own is marked, anyone else's is lit and the clock pick has its own mark. The log is already the merged log by now, so there is no second picks array to choose between.
        const track = order.map((teamId, i) => {
            const overallAt = i + 1;
            const logged = draftLog.picks[i];
            let cls = '';
            if (logged) {
                cls = companion.myTeamId !== null && String(logged.teamId) === String(companion.myTeamId)
                    ? 'dr-tally-mine' : 'dr-tally-done';
            } else if (overallAt === overall) cls = 'dr-tally-now';
            return `<span class="dr-tally-tick${cls ? ` ${cls}` : ''}"></span>`;
        }).join('');
        trackHtml = `<span class="dr-tally-track ds-progress-track">${track}</span>`;
        // Stop following appears only while the cross-league opt-in is live. A same-league room needs no such control. It is the reader's way out, beside the automatic one that runs when the room closes.
        const stopFollowingBtn = roomFollowedAcrossLeague
            ? `<button type="button" id="dr-stop-following" class="dm-flat">Stop following</button>` : '';
        progressActs = `${teamSelect}${undoBtn}${stopFollowingBtn}`;
    }
    const refusal = !isRehearse && logRefusalMsg
        ? `<span class="draft-clock-facts draft-tray-verdict-bad">${escapeHtml(logRefusalMsg)}</span>` : '';
    // On load with room-sourced picks in the log and no live room, the strip says so once with the clear beside it. The offer is about a room of another league, never about whether this league's room is open this second, since no active room also looks like a dropped connection or a restarted extension. A same-league room's picks are real draft history and are resumed.
    const staleRoomPicks = roomPicksClearOffer({
        isRehearse,
        roomActive: !!room,
        foreign: draftLogHasForeignRoomPicks,
        hasRoomPicks: draftLog.picks.some(p => p.source === 'room')
    });
    const staleRoomNote = staleRoomPicks
        ? `<span class="draft-clock-facts">Some picks came from another league's room.`
        + ` <button type="button" id="dr-clear-room-picks" class="draft-room-offer-btn">Clear the room's picks</button></span>`
        : '';
    // Corrected and dropped picks are named once here rather than per row. The line says only that the room and the hand log disagreed, and the row itself says which player.
    const roomNoteParts = [];
    {
        const c = companion.roomCorrected || [];
        const d = companion.roomDropped || [];
        if (c.length === 1) roomNoteParts.push(`pick ${c[0].overall} corrected by the room`);
        else if (c.length > 1) roomNoteParts.push(`${c.length} picks corrected by the room`);
        if (d.length === 1) roomNoteParts.push(`pick ${d[0].overall} dropped`);
        else if (d.length > 1) roomNoteParts.push(`${d.length} picks dropped`);
    }
    const roomNote = roomNoteParts.length
        ? `<span class="draft-clock-facts">${escapeHtml(roomNoteParts.join(` ${MIDDOT} `))}</span>` : '';
    // Slots on the room's board that the pool could not name are unknown, neither taken nor free. They are counted on an info mark and never a sentence on the face.
    const unknownSlots = !isRehearse && roomBoardRead ? roomBoardRead.unresolved.length : 0;
    const unknownMark = unknownSlots
        ? `<span class="stat-chip-info ds-unknown-slots" role="button" tabindex="0" data-tooltip="${escapeHtml(`${unknownSlots} ${unknownSlots === 1 ? 'pick' : 'picks'} on the room's board could not be matched to one player, so ${unknownSlots === 1 ? 'it is' : 'they are'} not counted as taken.`)}">&#9432; ${unknownSlots}</span>` : '';
    // The sidebar's masthead already says how far in the draft is and how long since the last pick, so its Progress cell keeps only what can be pressed, the team selector and Undo. The line, sub-line and tick track are not built there. The full tab is unchanged.
    const isSidebarStrip = document.documentElement.getAttribute('data-surface') === 'sidebar';
    const progressCell = isSidebarStrip ? `
        <div class="ds-cell ds-cell-progress">
            ${refusal}
            ${roomNote}
            ${unknownMark}
            ${staleRoomNote}
            <div class="ds-progress-acts">${progressActs}</div>
        </div>` : `
        <div class="ds-cell ds-cell-progress">
            <span class="ds-cell-label">Progress</span>
            <span class="ds-progress-line">${escapeHtml(progressLine)}</span>
            <span class="ds-progress-sub"${subAttrs}>${escapeHtml(progressSub)}</span>
            ${trackHtml}
            ${refusal}
            ${roomNote}
            ${unknownMark}
            ${staleRoomNote}
            <div class="ds-progress-acts">${progressActs}</div>
        </div>`;

    // ---- The run alert, from runDetect ---- The log is already merged when a room applies, so a plain read is a run over the room's recent picks and not only the ones also logged by hand.
    const recentPositions = (isRehearse ? state.picks : draftLog.picks).map(pk => primaryOf(pk.playerId));
    const run = runDetect(recentPositions);
    // The alert's second clause names the seat group most at risk of running out before the reader's next turn. It has no math of its own. The remaining pool is the board as it stands, and the replacement is a flat zero per open group because a row's value is already the edge over replacement, so a row is above the line exactly when its value is positive.
    const openSeats = openNeeds(heldIds.map(id => positionsOf(id, posById)), startingSlotsByPosition());
    const risk = seatAtRisk({
        openSeats,
        remaining: rows,
        replacement: Object.fromEntries(Object.keys(openSeats).map(g => [g, 0])),
        picksBefore: next.picks
    });
    const alertHtml = [
        run ? `${run.position} run: ${run.count} of the last ${run.of} picks were ${run.position}` : '',
        risk ? risk.word : ''
    ].filter(Boolean).map(t => `<div class="ds-alert">${escapeHtml(t)}</div>`).join('');

    return `
        <div class="ds-strip-wrap">
            <div class="ds-strip">${clockCell}${clockOnly ? '' : `${nextCell}${boardCell}${tierCell}${progressCell}`}</div>
            ${clockOnly ? '' : alertHtml}
        </div>
    `;
}

function wireMockFace(container) {
    const start = container.querySelector('#dm-start');
    if (start) {
        start.addEventListener('click', () => {
            // A manual start, never a rehearsal. A room the reader started by hand drafts by hand.
            planRehearsal = false;
            mockSetup = {
                slot: Number(container.querySelector('#dm-slot').value) || 1,
                rounds: Math.max(1, Number(container.querySelector('#dm-rounds').value) || 1),
                variance: container.querySelector('#dm-variance').value,
                seed: Number(container.querySelector('#dm-seed').value) || 1
            };
            startMock();
            // The bots ahead of you pick before you ever see the board.
            mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
            renderDraftTab();
        });
    }
    const restart = container.querySelector('#dm-restart');
    if (restart) restart.addEventListener('click', () => {
        planRehearsal = false;
        mock = null;
        // Rounds default from the shared round count, the same default the popover's first build uses, so a restart does not hand back a different count.
        const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
        const defaults = mockDefaults();
        mockSetup = { ...defaults, rounds: planRoundCount(teams) || defaults.rounds };
        renderDraftTab();
    });
    const stop = container.querySelector('#dm-stop');
    if (stop) stop.addEventListener('click', () => {
        // Stop leaves the run standing, since Restart is what clears it. It only steps back to the plain board.
        applySwitchRequest('rehearse', false);
        renderDraftTab();
    });
    const playOut = container.querySelector('#dm-playout');
    if (playOut) playOut.addEventListener('click', () => {
        // autoAdvancePlanPicks already runs to the end on its own: draftForUser calls simToTeam after every pick, so "not the user's turn" only ever means the draft is over.
        autoAdvancePlanPicks();
        renderDraftTab();
    });

    const undo = container.querySelector('#dm-undo');
    if (undo) undo.addEventListener('click', () => { spotlightId = null; undoMock(); renderDraftTab(); });
}

// ==== Export ====

// The sheet as rows, exactly what is on screen with the filters included, the way the leaderboard's export works. The strong categories are written out by name rather than as squares, since a spreadsheet is something you sort.
function buildDraftSheetExport() {
    if (!poolHasProjections()) return null;
    const rows = buildBoard();
    const shown = visibleRows(rows);
    const { estimated } = estimateSplit();
    const catIds = Array.from(AppState.scoredStatIds);
    const draftable = draftableCount();

    // The figures the board shows, one column per scored category and not the tints, because a spreadsheet wants the number.
    const headers = ['#', 'Player', 'Pos', 'Value', 'ADP', 'Verdict', 'Kept']
        .concat(categoryNames(catIds));
    const out = shown.map(r => {
        const adp = adpOf(r.player);
        const byId = new Map((r.cells || []).map(c => [c.id, c]));
        return [
            r.boardRank || '',
            r.player.name,
            r.player.positionDisplay || '',
            r.value !== null ? r.value.toFixed(1) : (hasProjection(r.player) ? 'unranked' : 'no projection'),
            adp ? adp.toFixed(1) : '',
            r.boardRank && (!draftable || r.boardRank <= draftable) ? adpVerdict(r.boardRank, adp) : '',
            keptRow(r) ? 'kept' : ''
        ].concat(catIds.map(id => {
            const c = byId.get(id);
            return c && c.value !== null ? formatCellValue(c.value, id, c.estimated) : '';
        }));
    });

    // The estimate belongs to the whole sheet, not a row, so it rides the title, which also names the downloaded file.
    const note = estimated.length ? ` (${categoryNames(estimated).join(' and ')} estimated)` : '';
    return { title: `Draft Cheat Sheet${note}`, headers, rows: out };
}

registerExportDataset('draft-sheet', {
    label: 'Draft Cheat Sheet',
    note: 'Exactly as currently shown: search and position filter apply.',
    emptyNote: 'This league\'s pool carries no projections to rank.',
    available: () => poolHasProjections(),
    build: () => buildDraftSheetExport()
});

// The offer found by roomForOtherLeague, a room open for a league that is not the one on screen. It is plain text plus one real button in its own small class, wired in wireDraftTab. The click is the whole opt-in.
function roomOtherLeagueBannerHtml() {
    return `<div class="draft-room-offer">`
        + `<span>A draft room is open for another league.</span>`
        + `<button type="button" class="draft-room-offer-btn" data-follow-other-room>Follow it here</button>`
        + `</div>`;
}

// The league's facts, once, never per face. They are the same figures as before plus the reader's slot and the round count, which the whole tab shares.
function mastFactsParts() {
    const s = AppState.apiData?.settings || {};
    const teams = Number(s.size) || (AppState.apiData?.teams || []).length;
    const slot = ownSlot();
    const rounds = planRoundCount(teams);
    const parts = [s.name || 'This league', `${teams} teams`, draftTypeWord()];
    // Slot is the app's word for a roster position, not a place in the draft order, so the label reads Pick 4 of 6. The slot is a fact about a draft still to come, so it leaves every recap, using the same two questions the board asks to show results. The pre-draft board keeps it.
    const recapShown = draftTabShowsResults(AppState.apiData) || boardBasis().state === 'none';
    if (slot && !recapShown) parts.push(`Pick ${slot} of ${teams}`);
    if (rounds) parts.push(`${rounds} rounds`);
    parts.push(draftDateLabel());
    // The one fact a reader following a live room needs first. It is checked directly because this renders before the companion exists, and roomActive reads module state.
    if (roomActive()) parts.push('Following the room');
    // The run's own facts, seed and bots, live here rather than on the switches row.
    const rehearseNote = mastRehearseNoteText();
    if (rehearseNote) parts.push(rehearseNote);
    return parts;
}

function mastFactsHtml() {
    const parts = mastFactsParts();
    return `<span class="draft-mast-facts">${parts.map(p => `<span>${escapeHtml(p)}</span>`)
        .join(`<span class="draft-mast-sep">${MIDDOT}</span>`)}</span>`;
}

// This replaces the whole masthead in the sidebar with one line, since that surface only ever shows the Log picks board. The count reuses the shared round count so the two never compute the number of picks two ways.
function sidebarMastHtml() {
    ensureLog();
    const s = AppState.apiData?.settings || {};
    const teams = Number(s.size) || (AppState.apiData?.teams || []).length;
    const rounds = planRoundCount(teams);
    const total = teams && rounds ? teams * rounds : null;
    const logged = (draftLog?.picks || []).length;
    // The room's age replaces the count while it applies, because the strip's Progress line already shows the count and the masthead has room for one fact. It uses the same relative wording as the strip. The timestamp attribute is what the ticker reads back each second.
    const room = roomActive();
    let state;
    let subAttrs = '';
    if (room) {
        const ageSecs = Number.isFinite(room.lastPickAt) ? Math.max(0, Math.round((Date.now() - room.lastPickAt) / 1000)) : null;
        // Three states, not two. A room can be open and have delivered nothing, which reads identically to no room at all. The transport is named because it is the fact that made the difference. roomFrameState decides and these words only print it.
        if (roomFrameState(room) === 'open-no-frames') {
            const via = openTransportName(room);
            state = via ? `Room open on ${via} ${MIDDOT} no frames yet` : `Room open ${MIDDOT} no frames yet`;
        } else {
            // The pick count lives here once, since the strip's Progress cell no longer prints it. It is a number, so it is never cut, and the ticker repaints the age around it.
            const countBit = total ? ` ${MIDDOT} ${logged} of ${total} picks` : ` ${MIDDOT} ${logged} picks`;
            state = ageWords(ageSecs) !== null ? `Following the room${countBit} ${MIDDOT} ${ageWords(ageSecs)}` : `Following the room${countBit}`;
            subAttrs = ` data-count-bit="${escapeHtml(countBit)}"`;
        }
        if (Number.isFinite(room.lastPickAt)) subAttrs += ` data-last-pick-at="${room.lastPickAt}"`;
    } else {
        state = total ? `${logged} of ${total} picks` : `${logged} picks logged`;
        // A snapshot exists but does not apply, because it is stale or closed. Saying so is different from reading as though no room had reported, which roomActive's null cannot tell apart. A closed room is a hard fact read from the mirrored close event and reads as one, while a stale room is only an inference from silence and keeps the hedge.
        if (roomState && (roomIsStale(roomState) || roomState.status !== 'open')) {
            const ago = Number.isFinite(roomState.at) ? Math.max(0, Math.round((Date.now() - roomState.at) / 1000)) : null;
            const closedWord = roomState.status !== 'open' ? 'closed' : 'stopped reporting';
            state += ` ${MIDDOT} the room ${closedWord}${ageWords(ago) !== null ? ` ${ageWords(ago)}` : ''}`;
        }
    }
    // A plain target=_blank link needs no extension API and no permission, since a sidebar context already opens it in a real tab. A drafted league's masthead says the league and not the companion's progress, because a draft marked finished has no progress left to report. It is asked through the same rule the board's face branch uses. This is a gate on the existing spans and not markup of its own.
    const mastSaysProgress = !draftTabShowsResults(AppState.apiData);
    return `<span class="dr-sidebar-mast-name">${escapeHtml(s.name || 'This league')}</span>`
        + (mastSaysProgress
            ? `<span class="draft-mast-sep">${MIDDOT}</span>`
              + `<span class="dr-sidebar-mast-state"${subAttrs}>${escapeHtml(state)}</span>`
            : '')
        + `<a class="dr-sidebar-full-link" href="dashboard.html" target="_blank" rel="noopener">Full page</a>`;
}

// The face switcher is gone, so these three each layer a tray or strip over the same board. Rehearse is exclusive with the other two, while Plan and Log picks combine. The state and refusal rules live in resolveDraftSwitches. Once a mock is running, Rehearse becomes Restart and Stop. The sidebar button is offered only on the full tab and only when the browser exposes a sidebar API.
function sidebarOpenBtnHtml() {
    if (document.documentElement.getAttribute('data-surface') === 'sidebar') return '';
    const hasSidebar = typeof browser !== 'undefined' && (browser.sidebarAction?.open || browser.sidePanel?.open);
    if (!hasSidebar) return '';
    // A simple guide to opening the side view, naming both the button beside it and the browser's own native entry point. It does not explain why the button exists, which is the tooltip's job.
    return `<button type="button" id="dm-open-sidebar" class="dm-flat" title="Open Leaguewise in the browser's sidebar, beside the draft room">Open beside the room</button>`
        + `<span class="dm-sidebar-guide">Or the browser's own sidebar menu, listed as Leaguewise.</span>`;
}

// The click is the user action the sidebar API requires, so this only runs from that handler. Opening a side panel needs the window, while opening a sidebar takes none. Either call can reject, and the button is the only feedback, so a rejection is swallowed.
async function openBesideRoom() {
    try {
        if (browser.sidebarAction?.open) { await browser.sidebarAction.open(); return; }
        if (browser.sidePanel?.open) {
            const win = await browser.windows.getCurrent();
            await browser.sidePanel.open({ windowId: win.id });
        }
    } catch { /* swallowed - see above */ }
}

// My rankings is one control in the mast's tools, opening the same anchored popover shape the Rehearse switch uses. The empty state is the file input alone. Once a file is chosen the panel reads its name, the matched count, the unmatched folded behind a plain details element and any ambiguous name on its own line.
function rankingsPanelBodyHtml() {
    if (!rankingsFile) {
        // Choose a file, in the panel's own flat form. The label is the styled trigger and a native label click activates the input it names. The input stays real and in the tab order, visually hidden by the standard clip, so Tab and Enter still reach it. Drag and drop is not built.
        return `
            <div class="dr-quiet draft-rankings-note">Matched by ESPN id where your file has one, else by name and team.</div>
            <label for="dm-rankings-file" class="dm-flat draft-rankings-choose">Choose a file</label>
            <input type="file" id="dm-rankings-file" class="draft-rankings-input-visually-hidden" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain">
        `;
    }
    // Matched fresh here, off the board as it stands this render, never from the loaded file's cached field.
    const { readResult, matchResult } = currentRankingsMatch(buildBoard());
    const { name } = rankingsFile;
    const total = readResult.rows.length;
    const matchedCount = Object.keys(matchResult.byPlayerId).length;
    const unmatchedHtml = matchResult.unmatched.length
        ? `<details class="draft-rankings-fold">
            <summary>${matchResult.unmatched.length} not found</summary>
            ${matchResult.unmatched.map(r => `<div class="dr-quiet draft-rankings-unmatched-row">${escapeHtml(r.name || '(no name)')}</div>`).join('')}
        </details>`
        : '';
    // The wording names the fix even where the file has no club column. Adding the team is the shorter and more often true fix a reader can act on without a second sentence.
    const ambiguousHtml = matchResult.ambiguous.map(a =>
        `<div class="draft-rankings-ambiguous">${escapeHtml(a.row.name)} could be either - add the team</div>`
    ).join('');
    return `
        <div class="draft-rankings-loaded">
            <span class="draft-rankings-filename">${escapeHtml(name)}</span>
            <span class="dr-quiet">${matchedCount} of ${total} matched</span>
        </div>
        ${unmatchedHtml}
        ${ambiguousHtml}
        <button type="button" id="dm-rankings-clear" class="dm-flat draft-rankings-clear">Clear</button>
    `;
}

function rankingsPanelHtml() {
    if (!rankingsPanelOpen) return '';
    return `<div class="draft-rankings-popover">
        <div class="draft-tray-head"><span class="dr-card-label lh-block-head">My rankings</span></div>
        ${rankingsPanelBodyHtml()}
    </div>`;
}

function rankingsBtnHtml() {
    return `<span class="draft-switch-anchor"><button type="button" id="dm-rankings-toggle"`
        + ` class="dm-flat${rankingsFile ? ' dm-rankings-on' : ''}"`
        + ` title="Match a file of your own rankings or tiers onto the board">My rankings</button>${rankingsPanelHtml()}</span>`;
}

function switchesHtml() {
    const btn = (id, label, on) => `<button type="button" class="mt-view-tab draft-switch${on ? ' active' : ''}" data-switch="${id}">${escapeHtml(label)}</button>`;
    // Restart and Stop moved to the strip's Progress cell, so this row keeps the plain Rehearse toggle at every state. The popover still offers itself only before a run starts, since reconfiguring mid-run is not offered.
    const rehearseBtn = `${btn('rehearse', 'Rehearse', switches.rehearse)}${(switches.rehearse && !mock) ? rehearsePopoverHtml() : ''}`;
    // The resolver's refusal reason prints where the refused switch sits, rather than in a strip that may not be showing.
    const refusalHtml = switchRefused
        ? `<span class="draft-mast-rehearse-note draft-tray-verdict-bad">${escapeHtml(switchRefused.reason)}</span>` : '';
    return `<div class="draft-mast-switches">${refusalHtml}${btn('plan', 'Plan', switches.plan)}<span class="draft-switch-anchor">${rehearseBtn}</span>${btn('log', 'Log picks', switches.log)}</div>`;
}

// The seed and bots, a fact about the run that exists nowhere else on the face. It sits in the mast's fact run because the switches row holds controls, not facts.
function mastRehearseNoteText() {
    if (!(switches.rehearse && mock)) return '';
    const prefix = planRehearsal ? 'Rehearsing your plan ' + MIDDOT + ' ' : '';
    return `${prefix}Seed ${mock.seed} ${MIDDOT} bots: consensus, ${String(mock.variance).toLowerCase()}`;
}

function poolPendingHtml() {
    if (AppState.playerDataError) {
        return `<div class="empty-state draft-empty"><div class="player-loading">${escapeHtml(playerPoolErrorText(AppState.playerDataError))}</div></div>`;
    }
    // The board's skeleton shape, built by the shared skeleton builder and shared with the leaderboard. It replaces a copy of the Player tab's progress markup that drew a static icon and a bar fixed at 45%.
    return buildSkeletonHtml('draft');
}

// Nothing to rank. Blunt, then the one fact that explains what the face needs, with no guess about why ESPN has not filed projections.
function noProjectionsHtml() {
    // The same state on every face, in each one's own terms. A reader on the mock draft is not asking about the cheat sheet, and bots that cannot draft say what they cannot do.
    const why = activeFace === MOCK_DRAFT
        ? "Bots draft off ESPN's season projections. This league's pool doesn't carry them."
        : activeFace === PLANNER
            ? "The planner picks targets off ESPN's season projections. This league's pool doesn't carry them."
            : "The cheat sheet ranks the pool off ESPN's season projections. This league's pool doesn't carry them.";
    return `
        <div class="empty-state draft-empty">
            <div>
                <div class="draft-empty-title">No projections yet.</div>
                <div class="draft-empty-note">${escapeHtml(why)}</div>
            </div>
        </div>
    `;
}

// The empty state for a board basis of none. The pool may carry live projections, but the draft has passed and no preseason snapshot exists, and ranking a live mixture is not done. The text gives the mechanism, that ESPN keeps no copy of the projections a draft was made on. A past draft with no basis gets the draft as it happened, shown all season.
const DR_CARD_CONTRAST_FLOOR = 4.5;

function hindsightIsUngraded(row) {
    // The row says so itself. It used to test the games figure, which football lacks, so every pick read ungraded and the note hid the whole layer.
    return row.ungraded === true;
}
// Shared by the words and the grid tile's arrow badge, one direction computation off the slot gap, so a sentence and a badge cannot disagree about which way a pick is trending.
function hindsightDirection(row) {
    if (row.slotGap === null || row.rank === null) return null;
    const dir = row.slotGap > 0 ? 'over' : (row.slotGap < 0 ? 'under' : 'even');
    const arrow = dir === 'over' ? '▲' : (dir === 'under' ? '▼' : '●');
    return { dir, arrow };
}
function hindsightWordsHtml(row) {
    if (!row) return '';
    if (row.keeper) return '<span class="dr-hind dr-hind-even">Keeper, not graded</span>';
    // A pick in the pool but unranked prints no line. A pick truly missing from the pool prints its id as the player's name. A cell with no line is a complete cell.
    if (!row.inPool) return '';
    if (hindsightIsUngraded(row)) return '<span class="dr-hind dr-hind-even">No games yet</span>';
    const d = hindsightDirection(row);
    if (!d) return '';
    const text = d.dir === 'even' ? `producing right at the ${ordinal(row.rank)}` : `producing like the ${ordinal(row.rank)}`;
    return `<span class="dr-hind dr-hind-${d.dir}">${d.arrow} ${escapeHtml(text)}</span>`;
}

// The grid tile's hindsight. A keeper or an ungraded pick gets the same words and a pick outside the pool gets nothing, since there is no number for a badge. A graded pick gets a compact arrow-and-slot badge in place of the sentence. It shares the direction helper with the sentence so the two cannot point opposite ways.
function hindsightBadgeHtml(row) {
    if (!row) return '';
    if (row.keeper || !row.inPool || hindsightIsUngraded(row)) return hindsightWordsHtml(row);
    const d = hindsightDirection(row);
    if (!d) return '';
    return `<span class="dr-hind-badge dr-hind-badge-${d.dir}">${d.arrow} ${escapeHtml(String(ordinal(row.rank)))}</span>`;
}

// The cell carries the club logo and the player's photo. At the grid's tightest readable tier both fit, the logo drawn small beside the pick number. A name wraps before it shrinks and is never cut. Line one is the first token alone and line two is every remaining token kept as one unit, so a multi-word surname stays together. A one-token name stays on a single line.
function draftResultsNameParts(fullName) {
    const tokens = (fullName || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return { first: fullName || '', last: '' };
    return { first: tokens[0], last: tokens.slice(1).join(' ') };
}
function draftResultsNameHtml(fullName) {
    const { first, last } = draftResultsNameParts(fullName);
    if (!last) return `<span class="dr-results-name" title="${escapeHtml(fullName)}"><span class="dr-results-name-first">${escapeHtml(first)}</span></span>`;
    // The data-full attribute carries the untouched first token, so the fit pass can fall back to an initial without re-deriving it from text that may already be the initial.
    return `<span class="dr-results-name" title="${escapeHtml(fullName)}">
        <span class="dr-results-name-first" data-full="${escapeHtml(first)}">${escapeHtml(first)}</span>
        <span class="dr-results-name-last">${escapeHtml(last)}</span>
    </span>`;
}

// The drafting team's colour is the tile's ground, with the lettering picked to read on it. It is computed synchronously from the team colour map so the tile never paints unstyled, and the dye pass refines it once the team's logo is sampled. The inks are the two fixed printed inks, read once per render.
function readCardInks() {
    const css = getComputedStyle(document.documentElement);
    return {
        light: parseCssColour(css.getPropertyValue('--card-ink')),
        dark: parseCssColour(css.getPropertyValue('--card-ink-dark')),
        surface: parseCssColour(css.getPropertyValue('--surface'))
    };
}

// A card's ground is the palette colour a quarter of the way toward the theme's surface, so bright colours stop reading loud. The lettering is re-picked on the blended colour by the same contrast rule, and the distinctness pass moves any pair that ended up too close. It is settled for the whole league at once because distinctness is a fact about the set, and it is memoised on what it reads.
const DR_CARD_SURFACE_SHARE = 0.25;
let cardGroundMemo = { key: null, grounds: null };
function settledCardGrounds(inks) {
    const ids = Object.keys(AppState.teamColorMap || {});
    const key = `${ids.map(id => `${id}:${AppState.teamColorMap[id]}`).join('|')}#${(inks.surface || []).join(',')}#${(inks.light || []).join(',')}#${(inks.dark || []).join(',')}`;
    if (cardGroundMemo.key === key) return cardGroundMemo.grounds;
    const entries = ids.map(id => {
        const raw = parseCssColour(AppState.teamColorMap[id]);
        return { id, rgb: raw && inks.surface ? blendToward(raw, inks.surface, DR_CARD_SURFACE_SHARE) : raw };
    }).filter(e => e.rgb);
    const grounds = separateGrounds(entries, (rgb) => pickCardGround(rgb, inks.light, inks.dark, DR_CARD_CONTRAST_FLOOR));
    cardGroundMemo = { key, grounds };
    return grounds;
}

// A logo's sampled colour takes the same quarter before it is judged, so a logo ground is not louder than the palette ground beside it.
function logoGroundFor(sampled, inks) {
    return sampled ? pickCardGround(inks.surface ? blendToward(sampled, inks.surface, DR_CARD_SURFACE_SHARE) : sampled, inks.light, inks.dark, DR_CARD_CONTRAST_FLOOR) : null;
}

function cardGroundFor(teamId, inks) {
    if (teamId == null || !inks || !inks.light || !inks.dark) return null;
    return settledCardGrounds(inks).get(String(teamId)) || null;
}

// The card's custom properties for a ground: the dye, and the dark lettering and its inverse badge tint only when the ground takes dark ink.
function cardGroundStyle(ground) {
    return ground ? `--dr-card-dye:${toCssRgb(ground.rgb)};${ground.ink === 'dark' ? '--card-ink:var(--card-ink-dark);--card-ink-inv:#ffffff;' : ''}` : '';
}

function draftCardDyeStyle(teamId, inks) {
    if (teamId == null || !inks) return '';
    const style = cardGroundStyle(cardGroundFor(teamId, inks));
    return style ? ` style="${style}"` : '';
}

function draftResultsCellHtml(cell, byId, clubs, sport, mine, hindsightByPlayer, teamId, cardInk) {
    if (!cell) return '<td class="dr-results-cell dr-results-empty"></td>';
    const pickLabel = cell.overall !== null ? `${cell.overall}` : (cell.roundPick !== null ? `R${cell.round}.${cell.roundPick}` : '');
    const keeperHtml = cell.keeper ? '<span class="dr-results-keeper" title="A kept player, not drafted this year">Keeper</span>' : '';
    const p = byId.get(String(cell.playerId));
    const hind = hindsightByPlayer ? hindsightByPlayer.get(String(cell.playerId)) : null;
    // A miss prints its id rather than hiding the row. The pool is the top 3000 by ownership, so a long-dropped pick can fall outside it though it was a real pick. It is never a card, since there is no player to put a photo or name to.
    if (!p) {
        return `<td class="dr-results-cell dr-results-miss${mine ? ' dr-results-mine' : ''}" data-player-id="${escapeHtml(String(cell.playerId))}"><div class="dr-results-cell-inner">
            <span class="dr-results-pick">${escapeHtml(pickLabel)}</span>
            <span class="dr-results-name">Player ${escapeHtml(String(cell.playerId))}</span>
            ${keeperHtml}
        </div></td>`;
    }
    const club = clubs && p.proTeamId != null ? clubs.get(Number(p.proTeamId)) : null;
    const pos = (p.eligiblePositions && p.eligiblePositions[0]) || '';
    const metaText = [pos, club].filter(Boolean).join(' · ');
    const teamAttr = teamId != null ? ` data-team-id="${teamId}"` : '';
    const dyeStyle = draftCardDyeStyle(teamId, cardInk);
    // The photo stays at every grid width. Pick and position share one small badge, since the card has no room for both as their own rows, and the club's abbreviation is folded into the badge text in place of the crest graphic.
    return `<td class="dr-results-cell dr-results-card${mine ? ' dr-results-mine' : ''}"${teamAttr} data-player-id="${escapeHtml(String(p.id))}"${dyeStyle}><div class="dr-results-cell-inner">
        <span class="dr-results-pick-badge">${escapeHtml(pickLabel)}${metaText ? `<br><span class="dr-results-badge-meta">${escapeHtml(metaText)}</span>` : ''}</span>
        ${recapAvatarHtml(sport, p, clubs)}
        ${draftResultsNameHtml(p.name)}
        ${metaText ? `<span class="dr-results-meta dr-results-meta-dense">${escapeHtml(metaText)}</span>` : ''}
        ${hindsightBadgeHtml(hind)}
        ${keeperHtml}
    </div></td>`;
}

// The displayed column order: each team's round-one pick, a team with none after the others. The grid and the phone's team pages read it from here, so the two cannot order the league two ways.
function draftBoardColumnOrder(board) {
    const firstRound = board.rounds[0] ? board.rounds[0].cells : [];
    const pickKey = (i) => {
        const c = firstRound[i];
        if (!c) return Infinity;
        if (c.overall !== null && c.overall !== undefined) return c.overall;
        return c.roundPick !== null && c.roundPick !== undefined ? c.roundPick : Infinity;
    };
    return board.teamOrder.map((_, i) => i).sort((a, b) => (pickKey(a) - pickKey(b)) || (a - b));
}

// One face at every team count. The grid is the face and a column too narrow for its player is answered by width, never a different shape. The fit function gives the table the width its widest surname needs, and the results box scrolls sideways inside itself when a league is too wide for the tab. The rule is that a name is never cut.
function draftResultsGridHtml(board, byId, clubs, sport, hindsightByPlayer, teamCounts) {
    // Read once per render rather than once per cell, the same fixed ink every card darkens its team colour against.
    const cardInk = readCardInks();
    // The columns are in draft order. The board puts the reader's team first, so a snake round's pick numbers would jump across the row. Columns are re-sequenced by each team's round-one pick, and a map takes a displayed column back to the board's index so every per-team lookup reads the cell it always read. A column with no round-one pick keeps its place after the others. The reader's column is marked, not moved.
    const colAt = draftBoardColumnOrder(board);
    const headHtml = colAt.map(i => board.teamOrder[i]).map(id => {
        // teamNameOf (this file's own helper, used the same way in logTrayRowHtml above) takes the raw numeric id, not draftResultsBoard's own stringified team-order entry.
        const name = teamNameOf(Number(id));
        const mine = id === board.myTeamId;
        // Counts only, never a grade. A team with no graded pick at all is omitted, since zero of both reads as noise.
        const counts = teamCounts ? teamCounts.get(String(id)) : null;
        const countsHtml = counts && (counts.over || counts.under)
            ? `<span class="dr-results-team-hind">${counts.over} &#9650; &middot; ${counts.under} &#9660;</span>`
            : '';
        // The column head carries the team's own dye (the grid's per-team value, dyeDraftResultCards refines it) for the phone's band across its top; above 700px nothing reads it.
        return `<th class="dr-results-team${mine ? ' dr-results-mine' : ''}" data-team-id="${escapeHtml(String(id))}" title="${escapeHtml(name)}"${draftCardDyeStyle(id, cardInk)}>${escapeHtml(name)}${countsHtml}</th>`;
    }).join('');

    // THE READING DIRECTION rides the round label, in BOTH directions: an arrow only on the even rounds would say "this one is odd" and leave the odd rounds' left-to-right to be assumed, and a column of alternating arrows reads as a pattern at a glance (odd rounds right, even rounds left).
    const bodyHtml = board.rounds.map(r => `
        <tr>
            <th class="dr-results-round">R${r.round}<span class="dr-results-dir" aria-hidden="true">${r.round % 2 === 1 ? '&rarr;' : '&larr;'}</span></th>
            ${colAt.map(i => draftResultsCellHtml(r.cells[i], byId, clubs, sport, board.teamOrder[i] === board.myTeamId, hindsightByPlayer, board.teamOrder[i], cardInk)).join('')}
        </tr>
    `).join('');

    return `
        <div class="dr-scroll dr-results-scroll">
            <table class="dr-results-table">
                <colgroup><col class="dr-results-round-col">${board.teamOrder.map(() => '<col>').join('')}</colgroup>
                <thead><tr><th class="dr-results-round"></th>${headHtml}</tr></thead>
                <tbody>${bodyHtml}</tbody>
            </table>
        </div>
    `;
}

// The hindsight engine is pure, and this is the one impure call each render makes. The drafted flag is read the same way the results board reads it, off the same picks, so the two cannot disagree. The per-team summary is not called here, because its pace counts are null on a league with no preseason snapshot.
function draftResultsHindsight(picks, drafted, sport) {
    if (drafted !== true) return { byPlayer: new Map(), byTeam: new Map() };
    const values = hindsightValuesFor(sport);
    const pacingFor = hindsightPacingFor(sport);
    // Hindsight grades nothing unless played is exactly true, since a league that has drafted and not played has no production to set a slot against. It is the same season-state answer every other surface asks.
    const rows = hindsightRows(picks, { values, pacingFor, drafted, played: gamesHaveBeenPlayed(AppState.apiData) });
    const byPlayer = new Map(rows.map(r => [String(r.playerId), r]));
    // The header's count is the slot gap direction that every cell's arrow already shows, never the pace direction, which needs a preseason snapshot and reads zero for a league that opened the app after its preseason. It is counted here from the contract's own rows, as counts and not a total.
    const bySlotGap = new Map();
    rows.forEach(r => {
        if (r.slotGap === null) return;
        const k = String(r.teamId);
        if (!bySlotGap.has(k)) bySlotGap.set(k, { over: 0, under: 0 });
        if (r.slotGap > 0) bySlotGap.get(k).over += 1;
        else if (r.slotGap < 0) bySlotGap.get(k).under += 1;
    });
    // A league where every real pick is ungraded shows the board one caption instead of a grid of ties dressed as results. Gradeable excludes a keeper and a miss outside the pool, so only a real pick counts toward the question.
    const gradeable = rows.filter(r => r.inPool && !r.keeper);
    const allUngraded = gradeable.length > 0 && gradeable.every(hindsightIsUngraded);
    return { byPlayer, byTeam: bySlotGap, allUngraded };
}

// Everything the initial render and the fit pass's corrective re-render need, built once as a function. A correction that computed the board or hindsight even slightly differently from the render it corrects would be its own bug. It returns null exactly when the results view would.
function draftResultsContext() {
    const picks = draftPicksFor();
    // One call decides what the results face is made of, ESPN's picks, the companion's log placed on ESPN's published order, the rosters or nothing. The drafted flag goes in exactly as the payload gives it, since the results module owns the discriminator. The log is loaded first because this path returns before the board's own call. Nothing is written to the log from here.
    ensureLogLoad();
    const teams = AppState.apiData?.teams || [];
    const feed = resultsFeedFor({
        draftDetail: { drafted: AppState.apiData?.draftDetail?.drafted, picks },
        log: draftLog,
        rosters: teams,
        teams,
        myTeamId: myTeamId()
    });
    if (feed.basis === 'none') return null;
    if (feed.basis === 'rosters') {
        return {
            basis: 'rosters', feed,
            sport: AppState.loadedSport,
            byId: new Map((AppState.playerData || []).map(p => [String(p.id), p])),
            clubs: proTeamAbbrevs()
        };
    }
    const board = feed.board;
    const sport = AppState.loadedSport;
    const byId = new Map((AppState.playerData || []).map(p => [String(p.id), p]));
    const clubs = proTeamAbbrevs();
    const { byPlayer: hindsightByPlayer, byTeam: hindsightByTeam, allUngraded } = draftResultsHindsight(
        picks, AppState.apiData?.draftDetail?.drafted === true, sport
    );
    // The board is never replaced. Only the hindsight layer goes dark when every real pick is ungraded, and a null hindsight map makes the words and the team counts print nothing without a second code path. The per-pick no games branch stays for the mixed case where some picks are graded.
    return {
        basis: feed.basis, board, sport, byId, clubs,
        shownByPlayer: allUngraded ? null : hindsightByPlayer,
        shownByTeam: allUngraded ? null : hindsightByTeam,
        allUngraded
    };
}

// One card of a team's page: round, pick, the headshot ringed in the team's colour, the name whole, position and club, and the hindsight badge. The team's colour is the card's edge and ring, never its ground.
function draftTeamCardHtml(cell, round, byId, clubs, sport, hindsightByPlayer, teamId, cardInk) {
    if (!cell) return '';
    const pickLabel = cell.overall !== null && cell.overall !== undefined
        ? `${cell.overall}` : (cell.roundPick !== null && cell.roundPick !== undefined ? `R${cell.round}.${cell.roundPick}` : '');
    const keeperHtml = cell.keeper ? '<span class="dt-keeper" title="A kept player, not drafted this year">Keeper</span>' : '';
    const p = byId.get(String(cell.playerId));
    const dye = draftCardDyeStyle(teamId, cardInk);
    if (!p) {
        return `<div class="dt-card dt-miss" data-team-id="${teamId}" data-player-id="${escapeHtml(String(cell.playerId))}"${dye}>
            <span class="dt-round">R${round}</span><span class="dt-pick">${escapeHtml(pickLabel)}</span>
            <span class="dt-who"><span class="dt-name">Player ${escapeHtml(String(cell.playerId))}</span></span>${keeperHtml}
        </div>`;
    }
    const club = clubs && p.proTeamId != null ? clubs.get(Number(p.proTeamId)) : null;
    const pos = (p.eligiblePositions && p.eligiblePositions[0]) || '';
    const metaText = [pos, club].filter(Boolean).join(' \u00b7 ');
    const hind = hindsightByPlayer ? hindsightByPlayer.get(String(cell.playerId)) : null;
    return `<div class="dt-card" data-team-id="${teamId}" data-player-id="${escapeHtml(String(p.id))}"${dye}>
        <span class="dt-round">R${round}</span><span class="dt-pick">${escapeHtml(pickLabel)}</span>
        ${recapAvatarHtml(sport, p, clubs)}
        <span class="dt-who"><span class="dt-name">${escapeHtml(p.name)}</span>${metaText ? `<span class="dt-meta">${escapeHtml(metaText)}</span>` : ''}</span>
        ${hindsightBadgeHtml(hind)}${keeperHtml}
    </div>`;
}

// The pager: one page a team, the reader's team first and the rest in draft order, each headed by the league and the team's name between two arrows.
function draftTeamPagesHtml(ctx) {
    const board = ctx.board;
    const cardInk = readCardInks();
    const colAt = draftBoardColumnOrder(board);
    const mineAt = colAt.find(i => board.teamOrder[i] === board.myTeamId);
    const order = mineAt === undefined ? colAt : [mineAt, ...colAt.filter(i => i !== mineAt)];
    const parts = mastFactsParts();
    const league = parts[0] || '';
    const facts = parts.slice(1).map(x => `<span>${escapeHtml(x)}</span>`).join('');
    return order.map((i, n) => {
        const id = board.teamOrder[i];
        const name = teamNameOf(Number(id));
        const cards = board.rounds.map(r => draftTeamCardHtml(r.cells[i], r.round, ctx.byId, ctx.clubs, ctx.sport, ctx.shownByPlayer, id, cardInk)).join('');
        const place = `${n === 0 && id === board.myTeamId ? 'Your team &middot; ' : ''}${n + 1} of ${order.length}`;
        return `<section class="dt-page" data-team-id="${id}">
            <div class="dt-head">
                <div class="dt-league">${escapeHtml(league)}</div>
                <div class="dt-title">
                    <button type="button" class="dt-arrow dt-prev" aria-label="Previous team">&#8249;</button>
                    <div class="dt-team">${escapeHtml(name)}</div>
                    <button type="button" class="dt-arrow dt-next" aria-label="Next team">&#8250;</button>
                </div>
                <div class="dt-facts">${facts}</div>
                <div class="dt-of">${place}</div>
            </div>
            ${cards}
        </section>`;
    }).join('');
}

function draftResultsFaceHtml(ctx) {
    return draftResultsGridHtml(ctx.board, ctx.byId, ctx.clubs, ctx.sport, ctx.shownByPlayer, ctx.shownByTeam);
}

// The rosters face. ESPN has ended a draft and published its order but not who went where, so the only witness is who each team holds now. One column per team in the feed's order, the reader first, with the same card tile and no pick badge or hindsight. No round label, since a roster has no rounds. A football defense uses the club's logo.
function recapAvatarHtml(sport, p, clubs) {
    const abbrev = clubs && p.proTeamId != null ? clubs.get(Number(p.proTeamId)) : null;
    const isUnit = p.positionDisplay === 'D/ST' || (p.eligiblePositions && p.eligiblePositions[0] === 'D/ST');
    return isUnit && abbrev ? buildProTeamCrestHtml(sport, abbrev) : buildPlayerAvatarHtml(sport, p.id, p.name);
}

// THE ORDER inside a column is the lineup slot first (a slot id groups a roster's own seats together, and the bench and IR fall last by their own high ids), then the pool's own value, then the name, so two loads of the same roster never shuffle.
function draftRosterCardHtml(entry, byId, clubs, sport, mine, teamId, cardInk) {
    const p = byId.get(String(entry.playerId));
    const teamAttr = ` data-team-id="${teamId}"`;
    if (!p) {
        return `<td class="dr-results-cell dr-results-miss${mine ? ' dr-results-mine' : ''}"><div class="dr-results-cell-inner">
            <span class="dr-results-name">Player ${escapeHtml(String(entry.playerId))}</span>
        </div></td>`;
    }
    // Position and club as one small line under the name, never the corner badge, which clipped to a single letter at this column width.
    const club = clubs && p.proTeamId != null ? clubs.get(Number(p.proTeamId)) : null;
    const pos = (p.eligiblePositions && p.eligiblePositions[0]) || '';
    const metaText = [pos, club].filter(Boolean).join(' · ');
    return `<td class="dr-results-cell dr-results-card${mine ? ' dr-results-mine' : ''}"${teamAttr}${draftCardDyeStyle(teamId, cardInk)}><div class="dr-results-cell-inner">
        ${recapAvatarHtml(sport, p, clubs)}
        ${draftResultsNameHtml(p.name)}
        ${metaText ? `<span class="dr-results-meta">${escapeHtml(metaText)}</span>` : ''}
    </div></td>`;
}

function draftRostersHtml(ctx) {
    const cardInk = readCardInks();
    const values = hindsightValuesFor(ctx.sport);
    const valueOf = (id) => {
        const v = values.get(String(id));
        const n = v && Number.isFinite(v.value) ? v.value : null;
        return n === null ? -Infinity : n;
    };
    const nameOf = (id) => (ctx.byId.get(String(id)) || {}).name || '';
    const cols = ctx.feed.teams.map(team => ({
        team,
        players: [...team.players].sort((a, b) =>
            ((a.lineupSlotId ?? 999) - (b.lineupSlotId ?? 999))
            || (valueOf(b.playerId) - valueOf(a.playerId))
            || nameOf(a.playerId).localeCompare(nameOf(b.playerId)))
    }));
    const depth = Math.max(0, ...cols.map(c => c.players.length));
    const info = 'Who each team holds now. ESPN has not published who was picked when, so there are no rounds or pick numbers here.';
    const headHtml = cols.map(({ team }) => {
        const name = teamNameOf(Number(team.teamId));
        return `<th class="dr-results-team${team.mine ? ' dr-results-mine' : ''}" title="${escapeHtml(name)}">${escapeHtml(name)}</th>`;
    }).join('');
    let bodyHtml = '';
    for (let i = 0; i < depth; i++) {
        bodyHtml += `<tr>${cols.map(({ team, players }) => players[i]
            ? draftRosterCardHtml(players[i], ctx.byId, ctx.clubs, ctx.sport, team.mine, team.teamId, cardInk)
            : '<td class="dr-results-cell dr-results-empty"></td>').join('')}</tr>`;
    }
    return `
        <div class="dr-results dr-results-rosters">
            <div class="dr-results-rosters-head"><span class="stat-chip-info" role="button" tabindex="0" data-tooltip="${escapeHtml(info)}">&#9432;</span></div>
            <div class="dr-scroll dr-results-scroll">
                <table class="dr-results-table">
                    <thead><tr>${headHtml}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
        </div>
    `;
}

// A name is never cut on this face either. Equal columns cannot all hold a long name on a laptop, so the table takes the width its widest name needs and the box scrolls sideways inside itself. It is read once per render from the laid-out name spans, which are inline-block and unwrapped.
function fitRostersFace(container) {
    const table = container.querySelector('.dr-results-rosters .dr-results-table');
    if (!table) return;
    const cols = table.querySelectorAll('thead th').length;
    if (!cols) return;
    // Names may break at a space or after a hyphen, so a column has to hold the widest unbreakable piece. It is measured on a canvas in each span's computed font, not read from its box, which a wrapped name would report at the width it was squeezed to.
    const ctx = (fitRostersFace.canvas || (fitRostersFace.canvas = document.createElement('canvas'))).getContext('2d');
    let widest = 0;
    table.querySelectorAll('.dr-results-name-first, .dr-results-name-last, .dr-results-miss .dr-results-name').forEach(el => {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        el.textContent.split(/(?<=-)|\s+/).forEach(piece => {
            if (piece) widest = Math.max(widest, ctx.measureText(piece).width);
        });
    });
    const cell = table.querySelector('tbody td');
    const cs = cell ? getComputedStyle(cell) : null;
    const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) : 0;
    table.style.minWidth = `${Math.ceil((widest + pad + 2) * cols)}px`;
    fitTeamHeads(table, Math.max(table.getBoundingClientRect().width / cols, widest + pad + 2));
}

function draftResultsHtml() {
    const ctx = draftResultsContext();
    if (!ctx) return noBoardBasisHtml();
    if (ctx.basis === 'rosters') return draftRostersHtml(ctx);
    const faceHtml = draftResultsFaceHtml(ctx);
    const ungradedNoteHtml = ctx.allUngraded
        ? '<p class="dr-results-note">Nothing to say about the picks until a game is played.</p>'
        : '';

    // The projections caption is gone, not reworded. A face never explains what it lacks by blaming the reader's timing. The empty-state sentence for the no-results case states an absence and does not assign a cause. The pager and its two pills are drawn at every width and hidden above 700px by the stylesheet, so the desktop's board is the markup it was; the mode is a class on the box and the pills switch it.
    const modes = `<div class="dt-modes" role="tablist" aria-label="Draft view">
                <button type="button" class="dt-mode${draftTeamsMode === 'teams' ? ' on' : ''}" data-mode="teams" role="tab" aria-selected="${draftTeamsMode === 'teams'}">Teams</button>
                <button type="button" class="dt-mode${draftTeamsMode === 'board' ? ' on' : ''}" data-mode="board" role="tab" aria-selected="${draftTeamsMode === 'board'}">Board</button>
            </div>`;
    return `
        <div class="dr-results dr-results-board dt-mode-${draftTeamsMode}">
            ${modes}
            <div class="dt-pages">${draftTeamPagesHtml(ctx)}</div>
            ${faceHtml}
            ${ungradedNoteHtml}
        </div>
    `;
}

// Keeps the pager's page and the mode across the whole-tab re-render, turns a page on an arrow, and switches the two modes on the pills. A swipe is CSS scroll-snap; the scroll handler only records the page it landed on.
function wireDraftTeamPages(container) {
    const box = container.querySelector('.dr-results.dr-results-board');
    const pages = box && box.querySelector('.dt-pages');
    if (!pages) return;
    const width = () => pages.clientWidth || 0;
    const count = pages.children.length;
    if (draftTeamPage >= count) draftTeamPage = 0;
    const restore = () => { if (width()) pages.scrollLeft = draftTeamPage * width(); };
    restore();
    pages.addEventListener('scroll', () => {
        if (!width()) return;
        draftTeamPage = Math.max(0, Math.min(count - 1, Math.round(pages.scrollLeft / width())));
    }, { passive: true });
    pages.addEventListener('click', (e) => {
        const dir = e.target.closest('.dt-next') ? 1 : e.target.closest('.dt-prev') ? -1 : 0;
        if (!dir) return;
        draftTeamPage = Math.max(0, Math.min(count - 1, draftTeamPage + dir));
        pages.scrollTo({ left: draftTeamPage * width(), behavior: 'instant' });
    });
    box.querySelectorAll('.dt-mode').forEach(btn => {
        btn.addEventListener('click', () => {
            draftTeamsMode = btn.dataset.mode === 'board' ? 'board' : 'teams';
            box.classList.toggle('dt-mode-teams', draftTeamsMode === 'teams');
            box.classList.toggle('dt-mode-board', draftTeamsMode === 'board');
            box.querySelectorAll('.dt-mode').forEach(b => {
                const on = b.dataset.mode === draftTeamsMode;
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            // Coming back to the pager lands on the page that was showing.
            if (draftTeamsMode === 'teams') restore();
        });
    });
}

// Called after every render that could show the results board. Two levers, neither of which cuts or ellipsizes a name. The two-line wrap is already in the markup, and the table takes the width its widest surname needs while the box scrolls sideways. Widths are measured on a canvas in the span's font. A first name wider than its column falls back to its initial. The club-colour edge is sampled after render.
async function dyeDraftResultCards(container) {
    const cards = [...container.querySelectorAll('.dr-results-card[data-team-id], .dt-card[data-team-id], .dr-results-team[data-team-id]')];
    if (!cards.length) return;
    const inks = readCardInks();
    if (!inks.light || !inks.dark) return;
    const rawTeamById = new Map((AppState.apiData?.teams || []).map(t => [t.id, t]));
    const byTeam = new Map();
    cards.forEach(card => {
        const id = Number(card.dataset.teamId);
        if (!byTeam.has(id)) byTeam.set(id, []);
        byTeam.get(id).push(card);
    });
    // Every team's logo is sampled first and the grounds are then settled together, so two teams on one default logo cannot repeat a ground. A logo's ground is taken only when it sits clear of every other team's, and otherwise the team keeps its palette colour.
    const entries = await Promise.all([...byTeam.keys()].map(async (teamId) => {
        const logoUrl = rawTeamById.get(teamId)?.logo;
        const sampled = logoUrl ? await sampleLogoColour(logoUrl) : null;
        return { id: teamId, own: cardGroundFor(teamId, inks), logo: logoGroundFor(sampled, inks) };
    }));
    const grounds = assignDistinctGrounds(entries);
    byTeam.forEach((teamCards, teamId) => {
        const ground = grounds.get(teamId);
        if (!ground) return;
        const dark = ground.ink === 'dark';
        teamCards.forEach(card => {
            if (!card.isConnected) return;
            card.style.setProperty('--dr-card-dye', toCssRgb(ground.rgb));
            if (dark) { card.style.setProperty('--card-ink', 'var(--card-ink-dark)'); card.style.setProperty('--card-ink-inv', '#ffffff'); }
            else { card.style.removeProperty('--card-ink'); card.style.removeProperty('--card-ink-inv'); }
        });
    });
}

function fitDraftResultsBoard(container) {
    const root = container.querySelector('.dr-results-board');
    if (!root) return;
    const table = root.querySelector('.dr-results-table');
    if (!table) return;
    const teamHeads = table.querySelectorAll('thead th.dr-results-team');
    if (!teamHeads.length) return;
    // Read the NATURAL column width first, with nothing this pass added on a previous render.
    table.style.minWidth = '';
    // A column under 180px cannot hold the corner badge's position and club beside a 52px photo, so the board goes dense. The badge keeps the pick number and the position and club take their own line under the name in smaller type. Width decides this, not team count, and it is decided before the names are measured, since the dense type is what they are measured in.
    root.classList.remove('dr-results-dense');
    const natural = teamHeads[0].getBoundingClientRect().width;
    root.classList.toggle('dr-results-dense', natural < 180);
    const ctx = (fitDraftResultsBoard.canvas || (fitDraftResultsBoard.canvas = document.createElement('canvas'))).getContext('2d');
    const widthOf = (el) => {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return ctx.measureText(el.textContent).width;
    };
    // What a column has to hold is the widest UNBREAKABLE piece of a surname: a dense card lets it break at a space or after a hyphen ("Nugent-" / "Hopkins", "Eriksson" / "Ek"), the rosters face's own rule, so a column is not sized to the longest whole surname in the league.
    const piecesWidth = (el) => {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return Math.max(0, ...el.textContent.split(/(?<=-)|\s+/).filter(Boolean).map(t => ctx.measureText(t).width));
    };
    let widestLast = 0;
    table.querySelectorAll('.dr-results-name-last').forEach(el => { widestLast = Math.max(widestLast, piecesWidth(el)); });
    // A one-token name has only a first span, and it is a surname for this purpose.
    table.querySelectorAll('.dr-results-name > .dr-results-name-first:only-child, .dr-results-miss .dr-results-name').forEach(el => {
        widestLast = Math.max(widestLast, piecesWidth(el));
    });
    const cell = table.querySelector('tbody td.dr-results-cell');
    const cs = cell ? getComputedStyle(cell) : null;
    const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) : 0;
    // 84px is the floor a card needs for its 44px dense photo beside the pick number's badge.
    const needed = Math.max(widestLast + pad + 2, 84);
    const column = Math.max(natural, needed);
    // After the min-width below is set (the table's real column is then `column`), the headers.
    if (needed > natural) {
        const roundCol = table.querySelector('col.dr-results-round-col');
        const roundW = roundCol ? roundCol.getBoundingClientRect().width : 0;
        table.style.minWidth = `${Math.ceil(roundW + needed * teamHeads.length)}px`;
    }
    table.querySelectorAll('.dr-results-name-first').forEach(el => {
        const full = el.dataset.full || el.textContent;
        el.textContent = full;
        if (widthOf(el) > column - pad - 2) el.textContent = full.charAt(0) + '.';
    });
    if (root.classList.contains('dr-results-dense')) fitTeamHeads(table, column);
    else table.style.removeProperty('--dr-head-size');
}

// A team name stays whole where the column can hold it. A header may wrap at its spaces, but a single word cannot, so the header type steps down until the widest word of every name fits, and only a name still too wide at the smallest size may break mid-word. One size serves every header so the row reads as one line of type. It is measured on a canvas in the header's font.
const DR_HEAD_SIZES = [13, 12, 11];
function fitTeamHeads(table, columnWidth) {
    const heads = [...table.querySelectorAll('thead th.dr-results-team')];
    if (!heads.length) return;
    table.style.removeProperty('--dr-head-size');
    const cs = getComputedStyle(heads[0]);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + 1;
    const ctx = (fitTeamHeads.canvas || (fitTeamHeads.canvas = document.createElement('canvas'))).getContext('2d');
    const words = heads.flatMap(th => (th.getAttribute('title') || '').split(/\s+/).filter(Boolean));
    if (!words.length) return;
    // A size is taken only if it MAKES the widest word fit. Shrinking every header to 11px for a name that would break anyway costs the other twelve their legibility for nothing, so when no size fits, the type stays at its normal size and the one name breaks (the last lever).
    for (const size of DR_HEAD_SIZES) {
        ctx.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
        if (Math.max(...words.map(w => ctx.measureText(w).width)) <= columnWidth - pad) {
            table.style.setProperty('--dr-head-size', `${size}px`);
            return;
        }
    }
}

// The results box fades only while there is more to scroll to. The fade hints that a column is off screen, and drawn over a box that fits, or over the last column once scrolled to it, it would only dim real cards. It is read at render and again as the box scrolls.
function syncResultsFade(container) {
    container.querySelectorAll('.dr-results-scroll').forEach(box => {
        const sync = () => box.classList.toggle('dr-results-overflows',
            box.scrollWidth > box.clientWidth + 1 && box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
        sync();
        if (!box.dataset.fadeWired) {
            box.dataset.fadeWired = '1';
            box.addEventListener('scroll', sync, { passive: true });
        }
    });
}

// The compacted badge takes the widest badge this league actually renders, measured on a canvas, rather than a fixed guess, so the freed width goes back to the category columns. Two widths serve the whole board in the sidebar, the widest rank as the grid's first column and the widest position label as where the ADP starts, so rows align down the list even when a label has two positions.
function fitSidebarPosColumn(container) {
    if (document.documentElement.getAttribute('data-surface') !== 'sidebar') return;
    const table = container.querySelector('.dr-table');
    if (!table) return;
    const ctx = (fitSidebarPosColumn.canvas || (fitSidebarPosColumn.canvas = document.createElement('canvas'))).getContext('2d');
    const widest = (sel, suffix) => {
        let w = 0;
        table.querySelectorAll(sel).forEach(td => {
            const cs = getComputedStyle(td);
            ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            w = Math.max(w, ctx.measureText(td.textContent + suffix).width);
        });
        return w;
    };
    const rankW = widest('tbody td.dr-rank', '');
    const posW = widest('tbody td.dr-pos', ' ·');
    if (rankW) table.style.setProperty('--dr-side-rank-w', `${Math.ceil(rankW) + 2}px`);
    if (posW) table.style.setProperty('--dr-side-pos-w', `${Math.ceil(posW) + 4}px`);
}

function fitOverNextColumn(container) {
    const table = container.querySelector('.dr-table');
    if (!table) return;
    const badges = [...table.querySelectorAll('.dm-pill-combo')];
    if (!badges.length) return;
    const cs = getComputedStyle(badges[0]);
    const canvas = fitOverNextColumn.canvas || (fitOverNextColumn.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let widest = 0;
    badges.forEach(el => { widest = Math.max(widest, ctx.measureText(el.textContent).width); });
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    // Slack matches fitDraftResultsBoard's own +4 for the same reason: canvas metrics round a hair differently than the DOM's real layout. The cell itself keeps a few px of its own padding (dashboard.css.dr-overnext), so the column only needs to fit the badge, not the whole cell.
    const needed = Math.ceil(widest + padX + borderX + 8);
    table.style.setProperty('--dr-overnext-width', `${needed}px`);
}

// Every fixed column is sized to what its widest rendered content measures, before any column pushes the board into a scroll. The widths declared in the stylesheet were guesses and clipped several columns. It reads once from every row in one write pass and one read pass, and runs before the two category fits.
function fitFixedBoardColumns(container) {
    const table = container.querySelector('.dr-table');
    if (!table || document.documentElement.dataset.surface === 'sidebar') return;
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    // One pass sizing every fixed column is simpler than the earlier per-column figure for the Take or wait badge.
    const KEYS = ['dr-col-rank', 'dr-col-name', 'dr-col-pos', 'dr-col-value', 'dr-col-myrank', 'dr-col-adp', 'dr-col-overnext'];
    const cols = [];
    [...headRow.children].forEach((th, i) => {
        const key = KEYS.find(k => th.classList.contains(k));
        if (key) cols.push({ th, i, key, widest: 0 });
    });
    if (!cols.length) return;
    const rows = [...table.querySelectorAll('tbody tr')].filter(tr => !tr.classList.contains('dr-section'));
    const inners = table.querySelectorAll('tbody td.dr-name .dr-name-inner');
    inners.forEach(el => { el.style.width = 'max-content'; });
    // A sortable header is a button and the base sheet locks every button to full width, so read as it stands it would report the column's current width as its content and no column could shrink.
    const headBtns = cols.flatMap(col => [...col.th.querySelectorAll('button')]);
    headBtns.forEach(el => { el.style.width = 'auto'; });
    const range = document.createRange();
    const contentWidth = (node) => { range.selectNodeContents(node); return range.getBoundingClientRect().width; };
    cols.forEach(col => {
        col.widest = contentWidth(col.th);
        rows.forEach(tr => {
            const td = tr.children[col.i];
            if (!td || td.colSpan > 1) return;
            const w = col.key === 'dr-col-name'
                ? (td.querySelector('.dr-name-inner') || td).getBoundingClientRect().width
                : contentWidth(td);
            if (w > col.widest) col.widest = w;
        });
    });
    inners.forEach(el => { el.style.width = ''; });
    headBtns.forEach(el => { el.style.width = ''; });
    cols.forEach(col => {
        const cs = getComputedStyle(col.th);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        // +1: text runs measured through a Range round a hair differently from the laid-out cell (fitOverNextColumn's and fitDraftResultsBoard's own slack, for the same reason).
        const content = Math.ceil(col.widest) + 1;
        col.th.style.width = `${cs.boxSizing === 'border-box' ? content + pad : content}px`;
        if (col.key === 'dr-col-rank') {
            table.style.setProperty('--dr-rank-w', `${content + (cs.boxSizing === 'border-box' ? 0 : pad)}px`);
        }
    });
}

// The tray's rest width is the default. This grows it past that only when a real plan row needs more to lay out on one line. It temporarily lifts each row's wrap to read what it would need unwrapped, because a row mixes icons, buttons and chips and a canvas text run cannot stand in. A width the reader already dragged away from the default is an explicit choice and stands.
function fitPlanTrayWidth(container) {
    if (trayWidth !== TRAY_WIDTH_DEFAULT) return;
    const grid = container.querySelector('.draft-grid-tray');
    if (!grid) return;
    const ledger = grid.querySelector('.draft-tray-ledger');
    if (!ledger) return;
    const rows = [...ledger.querySelectorAll('.draft-tray-row')];
    if (!rows.length) return;
    rows.forEach(r => { r.style.flexWrap = 'nowrap'; });
    let widest = 0;
    rows.forEach(r => { widest = Math.max(widest, r.scrollWidth); });
    rows.forEach(r => { r.style.flexWrap = ''; });
    // The row's own 10px horizontal padding (.draft-tray-row, dashboard.css), both sides, plus a few px of the same slack every canvas-measured column here already carries.
    const needed = Math.ceil(widest) + 24;
    if (needed > TRAY_WIDTH_DEFAULT) {
        grid.style.setProperty('--dr-tray-w', `${Math.min(needed, 600)}px`);
    }
}

// The board's table, its category heads and their scroll box, which both category fits start from, or null when any of the three is missing.
function boardCategoryParts(container) {
    const table = container.querySelector('.dr-table');
    if (!table) return null;
    const heads = [...table.querySelectorAll('th.dr-col-cat')];
    if (!heads.length) return null;
    const scrollEl = table.closest('.dr-scroll');
    if (!scrollEl) return null;
    return { table, heads, scrollEl };
}

// With the plan tray docked beside the board, the category columns cannot be left to the scroll box's own horizontal scroll, so columns that do not fit are measured and removed. They are removed from the DOM rather than hidden, because fixed table layout sets its column model from the first row and a hidden column still reserves its width. It is a no-op with the tray closed.
function fitLiveBoardCategories(container) {
    const grid = container.querySelector('.draft-grid');
    if (!grid || !grid.classList.contains('draft-grid-tray')) return;
    const parts = boardCategoryParts(container);
    if (!parts) return;
    const { table, heads, scrollEl } = parts;

    const canvas = fitLiveBoardCategories.canvas || (fitLiveBoardCategories.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    const cs = getComputedStyle(heads[0]);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let widest = 0;
    heads.forEach(h => { widest = Math.max(widest, ctx.measureText(h.textContent.trim()).width); });
    const gap = 6; // a real gap between columns, matching the mockup's own reasoning - never zero,
    // or adjacent short abbreviations (hockey's FOW/SHA) run together as one word.
    const colWidth = Math.ceil(widest) + 10;
    // Measured, not a guessed reservation. Every other header cell's rendered width is summed, after the Take or wait fit runs, so the compacted badge's real width is what gets counted.
    const otherHeads = [...table.querySelectorAll('thead th')].filter(h => !h.classList.contains('dr-col-cat'));
    const reserved = otherHeads.reduce((sum, h) => sum + h.getBoundingClientRect().width, 0);
    const fitFor = (avail) => Math.max(0, Math.min(heads.length, Math.floor(avail / (colWidth + gap))));
    let fitting = fitFor(scrollEl.clientWidth - reserved);
    // Everything already fits at its natural width, so the table's default sizing is left alone rather than forcing a uniform pitch nothing needed.
    if (fitting >= heads.length) return;
    // The marker is its own column. Without reserving room for it the plus-N-more header rendered past the scroll box's visible edge and was clipped by the container. 60px is a conservative upper bound for its text, so re-fitting against it costs at most one category column and never an overflow.
    fitting = fitFor(scrollEl.clientWidth - reserved - 60);

    heads.forEach((h, i) => {
        if (i >= fitting) { h.remove(); return; }
        h.style.width = colWidth + 'px';
    });
    table.querySelectorAll('tbody tr').forEach(row => {
        [...row.querySelectorAll('td.dr-cat')].forEach((cell, i) => {
            if (i >= fitting) cell.remove();
            else cell.style.width = colWidth + 'px';
        });
    });
    const actionsHead = table.querySelector('th.dr-col-actions');
    if (actionsHead) {
        const more = document.createElement('th');
        more.className = 'dr-cat-more';
        const hiddenCount = heads.length - fitting;
        const label = `+${hiddenCount} more`;
        more.textContent = label;
        more.title = `${hiddenCount} more categories - close the tray or widen the window to see them.`;
        // Fixed table layout clips a header cell to the width the column model gives it, and a two-digit hidden count needs more than an unset width left it. It re-reads its computed style after insertion, since the font is set by class, and reuses the canvas context the category heads were measured with.
        actionsHead.parentElement.insertBefore(more, actionsHead);
        const mcs = getComputedStyle(more);
        ctx.font = `${mcs.fontWeight} ${mcs.fontSize} ${mcs.fontFamily}`;
        const padX = (parseFloat(mcs.paddingLeft) || 0) + (parseFloat(mcs.paddingRight) || 0);
        more.style.width = Math.ceil(ctx.measureText(label).width + padX + 4) + 'px';
    }
}

// The compact pitch fits every value it was measured against but not every league's, and a value is never cut. Each category is measured against what this render's rows carry, and the column grows past the compact floor only when a real value needs it. The scroll box's horizontal scroll takes whatever does not fit at once. It is a no-op with the tray open, where the live board fit truncates categories instead.
function fitCollapsedBoardCategories(container) {
    const grid = container.querySelector('.draft-grid');
    if (!grid || grid.classList.contains('draft-grid-tray')) return;
    const parts = boardCategoryParts(container);
    if (!parts) return;
    const { table, heads, scrollEl } = parts;
    // The widest value in view is read literally and not as anywhere in the pool. The pool table is not paginated, and scanning every row across every column forced a reflow per column. Bounding the scan to rows whose rect intersects the scroll box keeps it to the rows a reader can see, and a value scrolled off cannot be the one cut on this screen.
    const scrollRect = scrollEl.getBoundingClientRect();
    const allRows = [...table.querySelectorAll('tbody tr')];
    const visibleRows = allRows.filter(row => {
        const r = row.getBoundingClientRect();
        return r.bottom > scrollRect.top && r.top < scrollRect.bottom;
    });
    const rowsToMeasure = visibleRows.length ? visibleRows : allRows.slice(0, 30);
    const cellsPerRow = rowsToMeasure.map(row => [...row.querySelectorAll('td.dr-cat')]);
    const canvas = fitCollapsedBoardCategories.canvas || (fitCollapsedBoardCategories.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    // Fixed table layout takes a column's width from its header cell alone, so the body cells never need a width set to match, unlike the truncation pass above, which removes cells outright.
    heads.forEach((h, i) => {
        const cs = getComputedStyle(h);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        let widest = ctx.measureText(h.textContent.trim()).width;
        cellsPerRow.forEach(cells => {
            const text = cells[i] ? cells[i].textContent.trim() : '';
            if (text) widest = Math.max(widest, ctx.measureText(text).width);
        });
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        h.style.width = Math.ceil(widest + padX + 4) + 'px';
    });
}

function noBoardBasisHtml() {
    // One line stating the fact this state is. The only caller reaches it on missing picks or an undrafted flag, never on a missing preseason snapshot, so a paragraph about projections was never the reason.
    return `
        <div class="empty-state draft-empty draft-empty-compact">
            <div class="draft-empty-title">No draft picks for this league yet.</div>
        </div>
    `;
}

// Three states matter to a drafter. A figure, a player ESPN never projected, and a player with a projection the engine could not score, who is unranked rather than unprojected. The figure is signed only when negative. A dash stands in for a sentence because the column is narrow, and the reason moves to the hover. A points league prints projected points, the league-scored total. The board's order is unchanged.
function valueCell(row) {
    if (row.value !== null) {
        if (AppState.isPointsLeague && row.score !== null && row.score !== undefined) {
            const cls = row.score < 0 ? 'dr-value dr-below' : 'dr-value';
            const seat = row.group ? ` over the next ${row.group}` : ' over replacement';
            const sign = row.value < 0 ? '' : '+';
            const title = `${sign}${row.value.toFixed(1)}${seat}`;
            return `<td class="dr-num ${cls}" title="${escapeHtml(title)}">${row.score.toFixed(1)}</td>`;
        }
        const cls = row.value < 0 ? 'dr-value dr-below' : 'dr-value';
        return `<td class="dr-num ${cls}">${row.value.toFixed(1)}</td>`;
    }
    const why = hasProjection(row.player)
        ? 'Unranked - too little projected to compare'
        : 'No projection for this player';
    return `<td class="dr-num dr-noproj" title="${escapeHtml(why)}">${DASH}</td>`;
}

// One cell per scored category, the projected figure tinted by the percentile that produced it, with the Team Metrics heatmap's tint. An estimated category wears a dotted border, an estimate that could not be made prints a dash, and a category outside the player's role prints nothing. Every category column declares a real width, because fixed layout spends declared widths first and splits only what is left.
function rateCatIds(sport) {
    return AVERAGE_STATS[sport] || new Set();
}

// A column that lost its per-cell dotted border, because every row is wholly estimated, still owes the reader the reason, said once on the header. Coverage under the category headers is for category leagues only, since a points league has no per-category ahead-of count. The divider id marks the first category of the secondary group when both groups show, so the two halves keep a visible seam.
function categoryHeadsHtml(catIds, alwaysEstimatedIds, coverageById, dividerId) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const rates = rateCatIds(AppState.loadedSport);
    return catIds.map(id => {
        const cls = (rates.has(id) ? 'dr-col-cat dr-cat-wide dr-cat-rate' : 'dr-col-cat dr-cat-wide')
            + (dividerId && String(id) === dividerId ? ' dr-cat-divider' : '');
        const label = map[id] || `Stat ${id}`;
        const cov = coverageById ? coverageById.get(String(id)) : null;
        const covHtml = cov && cov.text
            ? `<span class="dr-col-cov${cov.good ? ' dr-col-cov-good' : ' dr-col-cov-bad'}">${escapeHtml(cov.text)}</span>`
            : '';
        // The title moves onto the sort button itself, since a header cell and its child button cannot usefully carry the same tooltip twice. The coverage span stays outside it, unclickable.
        const titleText = (alwaysEstimatedIds && alwaysEstimatedIds.has(id))
            ? `${label}: estimated for every player - carried from last season; ESPN projects none`
            : '';
        return `<th class="${cls}">${sortHeadHtml(`cat:${id}`, label, titleText)}${covHtml}</th>`;
    }).join('');
}

// Coverage for the header, one map lookup per category, using the same coverage read as the removed rail card but only the ahead-of figure. Known issue seen while wiring, left for its own fix. The coverage read looks for a totals field that a mock room's board rows never carried, so the header computed off empty rosters, unnoticed because points leagues suppress it.
function coverageHeadMap(state) {
    const rivals = Math.max(0, leagueTeamIds().length - 1);
    const map = new Map();
    coverageNow(state).forEach(c => {
        if (c.share === null) { map.set(String(c.id), { text: '', good: false }); return; }
        const beaten = Math.round(c.share * rivals);
        map.set(String(c.id), { text: `${beaten} of ${rivals}`, good: rivals > 0 && beaten >= rivals / 2 });
    });
    return map;
}

// The log's coverage header, the same N of M line the rehearse header prints, taken from the plan module's log coverage so the real picks go through the roster builder and no second summing rule is kept here. The line reads the full board, since a drafted player has no entry in the live re-rank, so a gone player still contributes the line they had when logged.
function logCoverageHeadMap(companion, rows) {
    const rivals = Math.max(0, leagueTeamIds().length - 1);
    const sport = AppState.loadedSport;
    const cats = Array.from(AppState.scoredStatIds);
    const rowsById = new Map(rows.map(r => [String(r.player.id), r]));
    const lineOf = (playerId) => cellsToLine(rowsById.get(String(playerId)));
    const map = new Map();
    logCoverage(draftLog, {
        teamId: companion.myTeamId, teamIds: leagueTeamIds(), categoryIds: cats,
        lineOf, rateSpecs: RATE_COMPONENTS[sport] || [], inverseIds: leagueInverseIds(sport)
    }).forEach(c => {
        if (c.share === null) { map.set(String(c.id), { text: '', good: false }); return; }
        const beaten = Math.round(c.share * rivals);
        map.set(String(c.id), { text: `${beaten} of ${rivals}`, good: rivals > 0 && beaten >= rivals / 2 });
    });
    return map;
}

// An estimate does not get a projection's precision. Real projections are counts or true rates, but an estimate is a rate carried over games and lands fractional on a counted category. Counted categories round and rates keep their decimals.
function formatCellValue(value, id, estimated) {
    const rates = AVERAGE_STATS[AppState.loadedSport] || new Set();
    if (estimated && !rates.has(id) && !Number.isInteger(value)) return value.toFixed(1);
    return formatStatValue(value);
}

// Walks the header's own category list in the header's order and looks each row's cell up by id. The board scores every category regardless of group while the header carries only the active group's ids, so walking the row's cells directly put the wrong cells under the wrong headers.
function categoryCellsHtml(row, catIds, alwaysEstimatedIds, dividerId) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const rates = rateCatIds(AppState.loadedSport);
    const baseCls = (id) => {
        const cls = rates.has(id) ? ['dr-cat', 'dr-cat-wide', 'dr-cat-rate'] : ['dr-cat', 'dr-cat-wide'];
        if (dividerId && String(id) === dividerId) cls.push('dr-cat-divider');
        return cls;
    };
    const cellById = row.cells ? new Map(row.cells.map(c => [String(c.id), c])) : null;
    return catIds.map(rawId => {
        const c = cellById ? cellById.get(String(rawId)) : null;
        if (!c) return `<td class="${baseCls(rawId).join(' ')}"></td>`;
        const name = map[c.id] || `Stat ${c.id}`;
        const cls = baseCls(c.id);
        // The dotted border means carried over rather than forecast, which says nothing on a column where every row is estimated. The set of wholly unprojected columns is read from the estimate split, which the export note also reads, rather than hardcoding an id. Only the border goes, and the value, the dash-versus-blank distinction and the hover tail are unchanged.
        if (c.estimated && !(alwaysEstimatedIds && alwaysEstimatedIds.has(c.id))) cls.push('dr-cat-est');
        if (c.value === null) {
            // Estimated but unreachable is a known blank; off-role is not a blank at all, it is not that column.
            if (!c.estimated) return `<td class="${cls.join(' ')}"></td>`;
            return `<td class="${cls.join(' ')} dr-cat-none" title="${escapeHtml(`${name}: no last season to estimate from`)}">${DASH}</td>`;
        }
        const why = c.pct === null
            ? `${name}: ${formatCellValue(c.value, c.id, c.estimated)}`
            : `${name}: ${formatCellValue(c.value, c.id, c.estimated)}, ${ordinal(c.pct)} percentile`;
        const tail = c.estimated ? ' - estimated from last season' : '';
        const tint = c.pct === null ? '' : ` style="--pct:${percentileVar(c.pct)}"`;
        return `<td class="${cls.join(' ')}"${tint} title="${escapeHtml(why + tail)}">${escapeHtml(String(formatCellValue(c.value, c.id, c.estimated)))}</td>`;
    }).join('');
}

// A note icon per row, dimmed when empty and lit when a note exists, opening a field in place rather than a modal. Editing is one shared slot, since only one row is typed into at a time. The field is a textarea. Ctrl+Enter or blur saves, Escape cancels and a bare Enter is a new line. The rendered note is a block sibling placed outside the name row.
function noteIconHtml(playerId) {
    const text = noteFor(ensureNotes(), playerId);
    if (noteEditing === playerId) {
        const rows = Math.min(8, Math.max(2, (text || '').split('\n').length));
        return `<span class="dr-note-edit-wrap"><textarea class="dr-note-input" data-note-input="${playerId}" rows="${rows}" maxlength="1000" placeholder="Note on this player&hellip;" autofocus>${escapeHtml(text || '')}</textarea></span>`;
    }
    const on = !!text;
    return `<button type="button" class="dr-note-btn${on ? ' dr-note-lit' : ''}" data-note-toggle="${playerId}"`
        + ` title="${escapeHtml(on ? text : 'Add a note')}" aria-pressed="${on ? 'true' : 'false'}">${NOTE_ICON}</button>`;
}

function noteRenderedHtml(playerId) {
    if (noteEditing === playerId) return '';
    const text = noteFor(ensureNotes(), playerId);
    return text ? `<div class="dr-note-rendered">${renderMarkdownLite(text)}</div>` : '';
}

// A verdict only where a verdict means something. The ADP verdict compares a board position against a draft position, and past the last pick neither is real, so it is blank below the drafted range. The identity cell holds an initials tile, the name, the club and the injury flag, with a photograph only for players the league can actually take, since lazy loading alone still put over a thousand tags on the board.
function identityCellHtml(p, kept, clubs, action, withPhoto, isTarget, noteRendered, tagHtml, starHtml) {
    const club = clubs.get(Number(p.proTeamId));
    const badge = injuryBadgeHtml(p.injuryStatus);
    const playoffs = playoffHoverFor(p, clubs);
    // The flex layout lives on an inner div, never the cell itself. A table cell whose display is flex stops taking part in the row's height algorithm, and sat short of the row, so its border drew higher than the others. The cell keeps its table-cell display and the div carries the avatar and name row.
    return `<td class="dr-name${kept ? ' dr-kept' : ''}"${playoffs ? ` title="${escapeHtml(playoffs)}"` : ''}>`
        + '<div class="dr-name-inner">'
        + (starHtml || '')
        + (withPhoto
            ? buildPlayerAvatarHtml(AppState.loadedSport, p.id, p.name)
            : `<span class="player-avatar"><span class="avatar-initials">${escapeHtml(initialsFor(p.name))}</span></span>`)
        // The name's line and the tag line stack in one column beside the avatar, so the single-line flex row stays as it was and the tag line is its own sibling underneath.
        + '<div class="dr-ident-col">'
        + `<span class="dr-ident"><span class="dr-ident-name">${escapeHtml(p.name)}</span>`
        + (club ? `<span class="dr-club">${escapeHtml(club)}</span>` : '')
        + (badge ? ` ${badge}` : '')
        + (kept ? ' <span class="dr-kept-tag">kept</span>' : '')
        + (isTarget ? ' <span class="dr-target-tag">target</span>' : '')
        + '</span>'
        + (tagHtml || '')
        + '</div>'
        + (action || '')
        + '</div>'
        + (noteRendered || '')
        + '</td>';
}

// The ADP cell carries the distance, not a word. It prints a plus where the board likes a player more than the room does, a minus where it likes them less, and nothing inside the band where the two agree. The verdict still decides which of the three it is, and its word moves to the hover.
function adpCellHtml(row, adp, verdict) {
    if (!adp) return '<td class="dr-num dr-adp"></td>';
    const gap = Math.round(adp - row.boardRank);
    const delta = verdict === 'falling' ? `+${gap}` : (verdict === 'reach' ? String(gap) : '');
    const why = verdict
        ? `${verdict} - ADP ${adp.toFixed(1)}, board #${row.boardRank}`
        : `ADP ${adp.toFixed(1)}, board #${row.boardRank || '-'}`;
    return `<td class="dr-num dr-adp" title="${escapeHtml(why)}">${adp.toFixed(1)}`
        + (delta ? `<span class="dr-delta dr-${verdict}">${escapeHtml(delta)}</span>` : '')
        + '</td>';
}

// My rank, the reader's own file, in the same number-plus-tinted-delta shape the ADP cell draws. A row the file does not mention reads a plain dash, the same token every other nothing-to-show cell uses. The delta is the file's rank minus the board's, so negative means the reader ranks the player higher and reads as falling, the same green the ADP cell uses. Positive reads as a reach.
function myRankCellHtml(playerId, myRankColumnById) {
    if (!myRankColumnById) return '<td class="dr-num dr-myrank"></td>';
    const entry = myRankColumnById.get(String(playerId));
    if (!entry || entry.myRank === null || entry.myRank === undefined) {
        return `<td class="dr-num dr-myrank dr-quiet" title="Not in your file">${String.fromCharCode(8212)}</td>`;
    }
    const delta = entry.deltaVsBoard;
    const verdict = (delta === null || delta === undefined || delta === 0) ? null : (delta < 0 ? 'falling' : 'reach');
    const deltaText = verdict === 'falling' ? String(delta) : (verdict === 'reach' ? `+${delta}` : '');
    const why = verdict
        ? `Your file ranks this player ${entry.myRank} - board #${entry.boardRank}`
        : `Your file ranks this player ${entry.myRank}, the same as the board`;
    return `<td class="dr-num dr-myrank" title="${escapeHtml(why)}">${entry.myRank}`
        + (verdict ? `<span class="dr-delta dr-${verdict}">${escapeHtml(deltaText)}</span>` : '')
        + '</td>';
}

// The star is the plan and nothing else. It is on when the player holds a plan slot. Clicking it on files the player into the next open round, and clicking it off clears whichever slot they hold. The wiring is in the click delegation in wireDraftTab.
function starButtonHtml(playerId) {
    const on = !!planSlotOf(playerId);
    return `<button type="button" class="dr-star dr-act-icon${on ? ' dr-star-on' : ''}"`
        + ` data-plan-star="${playerId}" title="${on ? 'On your plan - click to clear it' : 'Add to your plan'}"`
        + ` aria-pressed="${on ? 'true' : 'false'}">${on ? STAR_ON : STAR_OFF}</button>`;
}

// The pill uses the short survival word, since Gone reads the same for unlikely and no, and a reader deciding whether to wait does not need the engine's fourth word.
function survivalPillWord(word) {
    if (word === 'likely') return 'There';
    if (word === 'coin flip') return 'Coin flip';
    if (word === 'unlikely' || word === 'no') return 'Gone';
    return '';
}

// The verdict is a four-line rule over the two facts the cell already has. Worth more and likely gone is the clearest case to act on now. Worth more on a coin flip still leans that way. Worth more but likely there can wait. Not worth more waits regardless, since nothing is lost by doing so.
function nowOrWaitVerdict(overNext, survives) {
    if (overNext <= 0) return 'Wait';
    if (survives === 'unlikely' || survives === 'no') return 'Take now';
    if (survives === 'coin flip') return 'Lean now';
    if (survives === 'likely') return 'Can wait';
    return '';
}

// Now or wait. The survival pill sits with a verdict word and a figure as the caption. The figure is what the player is worth over the best of the same seat group likely to be there at the reader's next pick, computed once per render and looked up by id. It is shown only where a seat can price a player. A player with no seat group collapses to a dash with the reason on hover. The reasoning lives in the badge's tooltip.
function overNextCellHtml(playerId, overNextById, positionLabel) {
    const entry = overNextById.get(String(playerId));
    if (!entry) return '<td class="dr-num dr-overnext"></td>';
    if (entry.overNext === null || entry.overNext === undefined) {
        if (entry.group === null || entry.group === undefined) {
            const who = positionLabel ? `a ${positionLabel}` : 'this player';
            const tip = `No seat group prices ${who} against your next pick.`;
            return `<td class="dr-num dr-overnext dr-overnext-reason" data-tooltip="${escapeHtml(tip)}">&mdash;</td>`;
        }
        return `<td class="dr-num dr-overnext dr-overnext-reason" data-tooltip="${escapeHtml(entry.reason || '')}">${escapeHtml(entry.reason || '')}</td>`;
    }
    const tone = entry.survives === 'likely' ? ' dm-likely' : (entry.survives === 'coin flip' ? ' dm-coin' : ' dm-gone');
    const pillWord = survivalPillWord(entry.survives);
    const verdict = nowOrWaitVerdict(entry.overNext, entry.survives);
    const sign = entry.overNext > 0 ? '+' : '';
    // The figure carries its unit and its comparison, in the tooltip rather than a second line on the face. Zero reads as no better than what is left, since nothing is lost by waiting.
    const figure = entry.overNext > 0
        ? `${sign}${entry.overNext.toFixed(0)} Value over the best ${entry.group} likely left`
        : "no better than what's left";
    const tooltip = `${figure} - what this player is worth, in the board's own Value, over the best of the same seat likely still there at your next pick.`;
    return `<td class="dr-num dr-overnext"><span class="dm-pill dm-pill-combo${tone}" data-tooltip="${escapeHtml(tooltip)}">${escapeHtml(pillWord)} ${escapeHtml(verdict)}</span></td>`;
}

// Survives to N is asked against the reader's own next pick from wherever the log says the draft is, the same pair the mock room reads off its next pick, so the word means the same on both faces. It is the cheat sheet's column wherever there are no seat groups, since survival is still a per-row fact there and Over next has nothing to price.
function survivesCellHtml(p, nextOverall, currentOverall) {
    const adp = adpOf(p);
    const word = survivalWord(adp, nextOverall, currentOverall);
    if (!word) return '<td class="dr-num dm-survive"></td>';
    const tone = word === 'likely' ? ' dm-likely' : (word === 'coin flip' ? ' dm-coin' : ' dm-gone');
    const says = word === 'likely' ? `likely, ADP ${adp.toFixed(0)}` : (word === 'no' ? `no, ADP ${adp ? adp.toFixed(0) : '-'}` : word);
    return `<td class="dr-num dm-survive${tone}">${escapeHtml(says)}</td>`;
}

// The drafted cell. On a frozen board, a finished draft ranked by the snapshot taken before it, the honest column is what happened instead of Over next and Survives. It reads the drafted index's cell shape verbatim, and an undrafted player gets a blank cell and not a guess.
function draftedCellHtml(playerId, draftedById) {
    const cell = draftedById.get(String(playerId));
    if (!cell) return '<td class="dr-col-drafted"></td>';
    return `<td class="dr-col-drafted${cell.mine ? ' dr-taken-mine' : ''}">${escapeHtml(cell.label)}</td>`;
}

// Reads the board basis itself rather than taking it as a parameter, since both callers already read their own and a frozen board is cheap to re-detect. The picks come from the draft picks accessor, the one place that view lands, fetched once at the top of renderDraftTab, with a listener in main.js redrawing the tab when it resolves. The league request alone never carries the picks.
function frozenDraftedById() {
    const basis = boardBasis();
    if (basis.state !== 'frozen') return null;
    return draftedIndexOf(draftPicksFor(), { myTeamId: myTeamId(), drafted: AppState.apiData?.draftDetail?.drafted === true });
}

// The frozen board's plan status. The draft already happened, so the plan is a status report against what was actually drafted, never against the reader's own manual log. Unfilled placeholder picks, with player id exactly -1, are dropped, never ids of zero or below, because football defenses carry negative real ids.
function realDraftLog() {
    if (AppState.apiData?.draftDetail?.drafted !== true) return { picks: [] };
    const picks = draftPicksFor() || [];
    return {
        picks: picks
            .filter(p => Number.isFinite(Number(p?.playerId)) && Number(p.playerId) !== -1)
            .map(p => ({ playerId: p.playerId, overall: p.overallPickNumber ?? null, teamId: p.teamId ?? null }))
    };
}

// Every column header sorts. A numeric column sorts descending first and a name ascending first. An absent value always sorts last in either direction, so an unranked player never floats up.
function sortCaret(col) {
    if (boardSort.col !== col) return '';
    return boardSort.dir === 'desc' ? ' ▾' : ' ▴';
}

function sortHeadHtml(col, label, title) {
    return `<button type="button" class="dr-col-sort" data-sort-col="${col}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}${sortCaret(col)}</button>`;
}

// A click cycles three states, off, the column's best-first direction, flipped, and off again, which is the board's own order. It is never persisted and never touches rank, value or the tray. Best first differs by column. Name and ADP read low to high as better, and so does a scored category when the league's weight makes it an inverse stat. Everything else opens high to low.
function firstSortDir(col) {
    // My rank is a rank like ADP, where 1 is best, so low to high reads as better for the same reason.
    if (col === 'name' || col === 'adp' || col === 'myrank') return 'asc';
    if (col.indexOf('cat:') === 0 && leagueInverseIds(AppState.loadedSport).has(col.slice(4))) return 'asc';
    return 'desc';
}

function cycleBoardSort(col) {
    const firstDir = firstSortDir(col);
    if (boardSort.col !== col) { boardSort = { col, dir: firstDir }; return; }
    if (boardSort.dir === firstDir) { boardSort = { col, dir: firstDir === 'asc' ? 'desc' : 'asc' }; return; }
    boardSort = { col: null, dir: null };
}

function sortValueFor(row, col, ctx) {
    const p = row.player;
    if (col === 'rank') return Number.isFinite(row.boardRank) ? row.boardRank : null;
    if (col === 'name') return (p.name || '').toLowerCase();
    if (col === 'pos') return (p.positionDisplay || '').toLowerCase();
    if (col === 'value') {
        const v = (AppState.isPointsLeague && row.score !== null && row.score !== undefined) ? row.score : row.value;
        return (v === null || v === undefined) ? null : v;
    }
    if (col === 'adp') { const a = adpOf(p); return (a === null || a === undefined) ? null : a; }
    // The two newer sort columns. Next pick reads the same figure the column shows, from the companion and never recomputed. Tier reads a per-position cut built once per sort rather than once per row.
    if (col === 'overnext') {
        const entry = ctx && ctx.overNextById && ctx.overNextById.get(String(p.id));
        return entry && Number.isFinite(entry.overNext) ? entry.overNext : null;
    }
    if (col === 'tier') {
        const t = ctx && ctx.tierById && ctx.tierById.get(String(p.id));
        return t === undefined ? null : t;
    }
    // The file's own rank, never the delta against the board, which depends on the board's order and would make sorting by it circular.
    if (col === 'myrank') {
        const m = ctx && ctx.myRankById && ctx.myRankById.get(String(p.id));
        return (m === undefined || m === null) ? null : m;
    }
    if (col.indexOf('cat:') === 0) {
        const catId = col.slice(4);
        const c = row.cells && row.cells.find(cell => String(cell.id) === catId);
        return (c && c.value !== null && c.value !== undefined) ? c.value : null;
    }
    return null;
}

// Tier for every row at once. The strip's tier function answers for one recommendation, but a table sort needs every row, so this bulks the same per-position cut. A player eligible at more than one position takes the best tier among them.
function tierByPlayerId(list) {
    const byPosition = new Map();
    list.forEach(r => {
        (r.player.eligiblePositions || []).forEach(pos => {
            if (!byPosition.has(pos)) byPosition.set(pos, []);
            byPosition.get(pos).push(r);
        });
    });
    const tierById = new Map();
    byPosition.forEach(posList => {
        const valued = posList.map(r => ({ value: Number.isFinite(r.value) ? r.value : 0 }));
        const breaks = tierBreaks(valued);
        posList.forEach((r, i) => {
            const t = tierOf(i, breaks);
            const id = String(r.player.id);
            const existing = tierById.get(id);
            if (existing === undefined || t < existing) tierById.set(id, t);
        });
    });
    return tierById;
}

// The reorder is applied to whatever the caller decided to show, never to the ranked list, which every other column still reads. The companion feeds the two new columns' context and is built once per sort.
function applyBoardSort(list, draftedById, companion) {
    // The frozen board's Drafted sort mixes drafted and undrafted on purpose, since draft order is the point of that column, so the sink for struck rows does not apply. The undrafted float to whichever end the sort key's infinity puts them.
    if (boardSort.col === 'drafted') {
        const sorted = sortByDraftOrder(list, draftedById);
        return boardSort.dir === 'desc' ? sorted : sorted.slice().reverse();
    }
    let ordered = list;
    if (boardSort.col) {
        const isName = boardSort.col === 'name';
        const ctx = {
            overNextById: companion && companion.overNextById,
            tierById: boardSort.col === 'tier' ? tierByPlayerId(list) : null,
            myRankById: companion && companion.myRankById
        };
        ordered = list.slice().sort((a, b) => {
            const av = sortValueFor(a, boardSort.col, ctx);
            const bv = sortValueFor(b, boardSort.col, ctx);
            if (isName) {
                if (av === bv) return 0;
                const cmp = av < bv ? -1 : 1;
                return boardSort.dir === 'desc' ? -cmp : cmp;
            }
            const an = av === null, bn = bv === null;
            if (an && bn) return 0;
            if (an) return 1;
            if (bn) return -1;
            return boardSort.dir === 'desc' ? (bv - av) : (av - bv);
        });
    }
    return sinkTaken(ordered, companion);
}

// Struck rows sink to the bottom regardless of the active sort, ordered by rank among themselves, since a column such as ADP answers nothing among players already gone. Open rows keep the chosen order.
function sinkTaken(list, companion) {
    if (!companion) return list;
    const goneOf = (r) => companion.goneIds.has(String(r.player.id))
        || !!(companion.draftedById && companion.draftedById.get(String(r.player.id)));
    const open = [];
    const gone = [];
    list.forEach(r => (goneOf(r) ? gone : open).push(r));
    gone.sort((a, b) => (a.boardRank ?? Infinity) - (b.boardRank ?? Infinity));
    return open.concat(gone);
}

// Pick order, the Drafted column's natural order. It only reorders the displayed rows and never touches rank or anything scored. Undrafted rows sort after every drafted one in either direction.
function sortByDraftOrder(shown, draftedById) {
    if (!draftedById) return shown;
    return shown.slice().sort((a, b) => {
        const ak = draftedById.get(String(a.player.id))?.sortKey ?? Infinity;
        const bk = draftedById.get(String(b.player.id))?.sortKey ?? Infinity;
        return ak - bk;
    });
}

// Whether the reader's sport prices a seat at all. Football has none, so Over next read that no seat prices the player on every row, a structural fact printed as if it were per player. Both halves of a sport's pool are checked, since groups can differ by which half is asked.
function sportHasSeatGroups() {
    const sport = AppState.loadedSport;
    return seatGroupsFor(sport, false).length > 0 || seatGroupsFor(sport, true).length > 0;
}

// The actions cell. The star is the plan's one add and remove control, so this cell no longer draws Add or the compact plus. What is left are the companion's own controls, Draft during Rehearse and Taken while a room is followed. The plain Taken button for a manual log has no row-level home yet.
function actionsCellHtml(playerId, playerName, opts) {
    const { showTaken, showDraft, gone, mine, yours, room } = opts;
    let primary = '';
    if (showDraft) {
        // Yours was true on every row while the reader was on the clock. The button was hidden by the stylesheet's quiet-until-hovered rule, so the wrong layer was suspected. The button now always renders, disabled with a title when it is not the reader's turn.
        primary = `<button type="button" class="dm-rowdraft dr-act-primary"${yours ? '' : ' disabled'} data-draft="${playerId}"`
            + ` title="${escapeHtml(yours ? 'Draft ' + playerName : 'Only the team on the clock can draft')}">Draft</button>`;
    } else if (showTaken) {
        if (gone) {
            primary = `<span class="dr-taken-label dr-act-icon${mine ? ' dr-taken-mine' : ''}">${mine ? 'MINE' : 'Taken'}</span>`;
        } else if (room) {
            // Draft, the room's own push, takes the primary slot while a room applies, and Taken demotes to a small outline button beside it as the override.
            primary = roomDraftBtnHtml(playerId, playerName, 'dr-act-primary')
                + `<button type="button" class="dr-taken-btn dr-taken-outline dr-act-icon" data-log="${playerId}" title="Log this pick by hand instead">Taken</button>`;
        }
    }
    // The flex layout lives on an inner div, never the cell. A goalie's row, one line taller from a wrapped category value, left this cell's background short of the real row height and the column behind it showed through.
    return `<td class="dr-act-cell dr-act-reveal"><div class="dr-act-inner">${primary}</div></td>`;
}

// The default board carries none of the three actions. Taken returns with Log picks, Add with Plan and Draft with Rehearse, reusing this same row rather than a second builder. Yours only matters with the Draft action. The display rank is undefined for a row in the top plan section, and for a board row is its position in the open-rows-only sequence, or null for a struck row, which prints a dash.
function rowHtml(row, draftable, catIds, clubs, showAdp, companion, alwaysEstimatedIds, showTaken, showAdd, showDraft, yours, tierById, displayRank) {
    const p = row.player;
    const id = String(p.id);
    const gone = companion.goneIds.has(id);
    const mine = companion.mineIds.has(id);
    // The live row. A gone player keeps the row as the board last said it, since the live re-rank excludes every logged id and re-scoring a player who cannot be drafted answers nothing.
    const live = companion.liveById.get(id) || row;
    const adp = adpOf(p);
    const inRange = !!live.boardRank && (!draftable || live.boardRank <= draftable);
    const verdict = inRange ? adpVerdict(live.boardRank, adp) : '';
    // The frozen board's gone state. A drafted player reads the same dimmed, struck row the log's Taken does, so a reader scanning the board reads already spoken for the same way.
    const drafted = companion.draftedById ? companion.draftedById.get(id) : null;
    // The tag line shows the tier from the bulk per-position cut and the ADP verdict as the tag's pill, a second line under the name. It is the same number the rank cell's hover keeps, printed where a reader scanning names sees it.
    const tier = tierById ? tierById.get(id) : undefined;
    const tag = inRange ? adpTag(live.boardRank, adp) : null;
    const tagParts = [];
    if (tier !== undefined && tier !== null) tagParts.push(`<span class="dr-tag-tier">T${tier}</span>`);
    if (tag) tagParts.push(`<span class="dr-tag-pill dr-tag-${tag.verdict}" title="${escapeHtml(tag.text)}">${escapeHtml(tag.word)}</span>`);
    const tagHtml = tagParts.length ? `<div class="dr-tag-line">${tagParts.join('')}</div>` : '';
    const rankCell = displayRank === undefined
        ? (live.boardRank || '')
        : (displayRank === null ? '<span class="dr-quiet">&mdash;</span>' : String(displayRank));
    return `<tr${gone || drafted ? ' class="dr-taken-row"' : ''}>
        <td class="dr-num dr-rank">${rankCell}</td>
        ${identityCellHtml(p, keptRow(row), clubs, noteIconHtml(p.id), !!live.boardRank && (!draftable || live.boardRank <= draftable), !showAdd && companion.targetIds.has(id), noteRenderedHtml(p.id), tagHtml, starButtonHtml(p.id))}
        <td class="dr-num dr-pos" title="${escapeHtml(p.positionDisplay || '')}">${escapeHtml(p.positionDisplay || '')}</td>
        ${valueCell(live)}
        ${companion.myRankColumnById ? myRankCellHtml(p.id, companion.myRankColumnById) : ''}
        ${showAdp ? adpCellHtml(live, adp, verdict) : ''}
        ${companion.draftedById ? draftedCellHtml(p.id, companion.draftedById)
            : (companion.overNextById ? overNextCellHtml(p.id, companion.overNextById, p.positionDisplay) : survivesCellHtml(p, companion.nextOverall, companion.currentOverall))}
        ${categoryCellsHtml(live, catIds, alwaysEstimatedIds, boardCategoryDividerId())}
        ${actionsCellHtml(p.id, p.name, { showTaken, showDraft, gone, mine, yours: !gone && yours, room: companion.room })}
    </tr>`;
}

// The body. The plan first, then the board. There are no tier dividers or tier hovers, though tiers stay real in the model. A starred player is pinned above whatever the reader is looking at and taken out of the run below, so the list the reader built stays together under any search or pill.
function tableBodyHtml(rows, shown, columns, companion, showTaken, showAdd, showDraft, yours) {
    const draftable = draftableCount();
    const catIds = boardCategoryIds();
    const clubs = proTeamAbbrevs();
    const showAdp = poolHasAdp();
    // Computed once per table build, never per row or cell, since the estimate split scans the whole pool.
    const alwaysEstimatedIds = new Set(estimateSplit().estimated);
    // The tag line's tier over the draftable range of the full board, not the shown rows, so a search or position pill never re-cuts anyone's tier. It is built once per table.
    const draftableRows = rows.filter(r => r.value !== null).slice(0, draftable || rows.length);
    const tierById = tierByPlayerId(draftableRows);

    // A starred player pulls to the top of the pool, the same way a queued one used to, because the star now means plan membership.
    const queued = rows.filter(r => planSlotOf(r.player.id));
    const queuedIdSet = new Set(queued.map(r => r.player.id));
    let out = '';
    // Sorted by My rank with a file that carries tiers, the board's dividers become the file's own tiers in place of the flat Board label. Every other sort keeps the plain Plan and Board split. It is gated on at least one shown row carrying a tier, so a rank-only file sorts with no dividers.
    const myTierDividers = boardSort.col === 'myrank' && !!companion.myRankColumnById
        && Array.from(companion.myRankColumnById.values()).some(e => e && e.myTier !== null && e.myTier !== undefined);
    if (queued.length) {
        out += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">`
            + `Plan ${MIDDOT} ${queued.length}</td></tr>`;
        out += queued.map(r => rowHtml(r, draftable, catIds, clubs, showAdp, companion, alwaysEstimatedIds, showTaken, showAdd, showDraft, yours, tierById)).join('');
        if (!myTierDividers) out += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">Board</td></tr>`;
    }

    // One sequence, counted here rather than read off the board rank. A struck row takes no number, so the open rows are 1, 2, 3 with nothing skipped and nothing repeated.
    let openIdx = 0;
    let lastMyTier;
    out += shown.map(r => {
        if (queuedIdSet.has(r.player.id)) return '';
        const id = String(r.player.id);
        const struck = companion.goneIds.has(id) || !!(companion.draftedById && companion.draftedById.get(id));
        const displayRank = struck ? null : ++openIdx;
        let divider = '';
        if (myTierDividers) {
            const entry = companion.myRankColumnById.get(id);
            const t = entry ? entry.myTier : null;
            if (t !== null && t !== undefined && t !== lastMyTier) {
                divider = `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">Tier ${t} (yours)</td></tr>`;
                lastMyTier = t;
            }
        }
        return divider + rowHtml(r, draftable, catIds, clubs, showAdp, companion, alwaysEstimatedIds, showTaken, showAdd, showDraft, yours, tierById, displayRank);
    }).join('');
    return out;
}

// A pill carries the position's depth, how many bodies are worth starting there. A position that lives entirely through a flex seat fell out of the old single-position answer, so the plural form credits the seats a position wins at a flex slot. Tones are decided within the league and not against a fixed ratio. A cliff appears only where bodies are fewer than the seats to fill, one amber at most, and plain otherwise.
function pillDepthInfo(rows) {
    const depthRows = scarcityRows(rows);
    const tones = new Map(depthTones(depthRows).map(t => [t.pos, t.tone]));
    const map = new Map();
    depthRows.forEach(d => {
        map.set(d.pos, { ...d, available: d.above, word: tones.get(d.pos) || '' });
    });
    return map;
}

// The search and pills, shared by both faces, so a reader who filters then switches face keeps the filter. Rows are optional, since the room's call has no board rows to price depth against yet. The sort-chip row is gone because the header click already sorts. The two filter pills are not sorts, so they stay at this row's right end.
function poolControlsHtml(rows) {
    const depthByPos = rows ? pillDepthInfo(rows) : null;
    const pills = positionPills().map(pos => {
        const d = depthByPos ? depthByPos.get(pos) : null;
        // Every position is its own toggle, on by default, and a disabled one reads dimmed by opacity alone, not the old bordered active look.
        const cls = ['dr-pill', disabledPositions.has(pos) ? 'dr-pill-off' : '', d && d.word === 'short' ? 'dr-pill-short' : '', d && d.word === 'cliff' ? 'dr-pill-cliff' : '']
            .filter(Boolean).join(' ');
        const depthHtml = d ? `<span class="dr-pill-depth">${d.available}</span>` : '';
        // A narrow pool drops the visible count first and moves it to the title, so a reader who wants it can still get it. A position with no seat of its own, such as the wings through the F seat, says so rather than reusing the ordinary seat-owning sentence.
        const seatWord = d && d.seats === 0
            ? `${d.depth} seat${d.depth === 1 ? '' : 's'} won at flex`
            : (d ? `${d.seats} seat${d.seats === 1 ? '' : 's'}${d.flexWon ? ` + ${d.flexWon} won at flex` : ''}` : '');
        const title = d ? ` title="${escapeHtml(`${d.available} above replacement, ${seatWord}`)}"` : '';
        return `<button type="button" class="${cls}"${title} data-pos="${escapeHtml(pos)}">${escapeHtml(pos)}${depthHtml}</button>`;
    }).join('');
    // Position pills are the only control now, every one lit by default. There is no export button here, since it duplicated the tab bar's Export icon, which opens the same modal over the same registered dataset.
    return `
        <div class="dr-controls">
            <input type="search" id="draft-search" class="dr-search" placeholder="Search" value="${escapeHtml(poolSearch)}">
            <div class="dr-pills">${pills}</div>
            <div class="dr-filter-pills">
                <button type="button" class="dr-filter-pill${filterFitsSeat ? ' dr-filter-pill-on' : ''}" data-filter="fits" title="Only players who fill one of your own still-open starting seats">Fits a seat</button>
                <button type="button" class="dr-filter-pill${filterHideDrafted ? ' dr-filter-pill-on' : ''}" data-filter="hide" title="Hide players already taken">Hide drafted</button>
            </div>
        </div>
    `;
}

// ==== The plan builder ====

// The plan's order, the full snake order across every round the league drafts, built as the mock room builds its own, so pick numbers never disagree. The round count prefers the picks, which carry a round id and are authoritative when they exist. The draftable count is the fallback, since it sums starters, bench and injured reserve and can overshoot the real draft by a round.
function planRoundCount(teams) {
    return draftRoundCount({ picks: draftPicksFor(), slotsPerTeam: teams ? draftableCount() / teams : 0, teams });
}

function planFullOrder(slot) {
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const rounds = planRoundCount(teams);
    return draftOrder(firstRoundOrder(slot), rounds, AppState.apiData?.settings?.draftSettings?.type || 'SNAKE');
}

// One string per loaded league, season included, since a plan built against last year's order means nothing once the league redraws it.
function planLeagueKeyString() {
    return `${AppState.loadedSport}-${AppState.apiData?.id}-${AppState.apiData?.seasonId}`;
}

// Lazy, not at module scope. Nothing about a plan's shape is known until a league is loaded, so building one earlier would build it wrong and rebuild it right on the next render.
function ensurePlan() {
    if (plan) return plan;
    const slot = ownSlot() || 1;
    const order = planFullOrder(slot);
    const teamId = firstRoundOrder(slot)[Math.min(Math.max(1, slot), 99) - 1];
    plan = buildDraftPlan(planLeagueKeyString(), order, teamId, { slot });
    return plan;
}

// Fire and forget, the same shape as the nickname loader. A plan already in memory paints at once, and a saved one swaps in and redraws once storage answers. It runs once per league, guarded by the key it was asked for.
function ensurePlanLoad() {
    const key = draftPlanKey(AppState.loadedSport, AppState.apiData?.id);
    if (planLoadedForKey === key) return;
    planLoadedForKey = key;
    readDraftPlan(key).then(stored => {
        if (draftPlanKey(AppState.loadedSport, AppState.apiData?.id) !== key) return;
        if (stored && Array.isArray(stored.rounds) && stored.rounds.length) {
            plan = stored;
            if (activeFace === PLANNER) renderDraftTab();
        }
    });
}

function savePlan() {
    if (!plan) return;
    writeDraftPlan(draftPlanKey(AppState.loadedSport, AppState.apiData?.id), plan);
}

// The pool comes from the real board, by the same rule the mock lineup pool follows. The board's value is the figure the sheet already shows, handed through and not recomputed, so a target chip's number cannot disagree with the board.
function planPool() {
    return buildBoard()
        .filter(r => r && r.player)
        .map(r => ({
            id: r.player.id, name: r.player.name, eligiblePositions: r.player.eligiblePositions || [],
            positionDisplay: r.player.positionDisplay || '', value: r.value, score: r.score, boardRank: r.boardRank,
            adp: adpOf(r.player), proTeamId: r.player.proTeamId
        }));
}

// The tray used to print the ordering figure, the edge over replacement, where the board prints the score for a points league. This applies the board's rule off the same two fields the plan pool carries.
function planValueDisplay(p) {
    if (p.value === null || p.value === undefined) return '';
    if (AppState.isPointsLeague && p.score !== null && p.score !== undefined) return p.score.toFixed(1);
    return p.value.toFixed(1);
}

// The board's suggestions for every empty round at once. The current pick is fixed at 1, since a planner has no live pick. It is one call, not one per round, because asking per round let a player whose draft position kept surviving be offered in every round. The plan module's walk excludes every player an earlier round was offered. The suggestion's basis says whether a draft position decided it or value did.
function planSuggestions(pool) {
    const candidates = pool.filter(p => p.value !== null && p.value !== undefined && p.boardRank);
    const rows = suggestPlan((plan && plan.rounds) || [], candidates, { currentPick: 1 });
    return new Map(rows.map(r => [r.round, r.suggestion]));
}

function boardSuggestionFor(round, pool, suggestions) {
    const result = suggestions ? suggestions.get(round.round) : null;
    if (!result) return null;
    const player = pool.find(p => String(p.id) === String(result.id));
    if (!player) return null;
    return { id: player.id, name: player.name, value: player.value, score: player.score, basis: result.basis, reason: result.reason };
}

function planLeagueSeats() {
    const sport = AppState.loadedSport;
    return planSeatsFor({
        order: LINEUP_SLOT_ORDER[sport] || [],
        labels: LINEUP_SLOT_LABELS[sport] || {},
        counts: AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {},
        nonStarting: NON_STARTING_SLOTS[sport] || new Set(),
        benchLabels: nonStartingLabels(sport)
    });
}

function planCtx() {
    return { flexPositions: FLEX_SLOT_POSITIONS[AppState.loadedSport] || {}, isPointsLeague: AppState.isPointsLeague };
}

// Puts a player in the plan's next open round's target. The first round with no target is a plain find over rounds in hand, and the setter answers the rest. It is shared by the star and the cheat sheet's File button, and returns true when it placed the player and false when no open round was left.
function fileIntoNextOpenRound(playerId) {
    ensurePlan();
    if (!plan) return false;
    const empty = (plan.rounds || []).find(r => r.targetId === null || r.targetId === undefined);
    if (!empty) return false;
    plan = setPlanTarget(plan, empty.round, playerId);
    savePlan();
    return true;
}

// The star's on job, the same next-open-round write the row's plus used to make, with the guard against a player already on the plan unchanged.
function fillNextEmptyRoundFromStar(playerId) {
    fileIntoNextOpenRound(playerId);
}

// The star's off side clears whichever plan slot the player holds, target or alternate, through the same two mutations the tray's own clear controls run, reached by player id since the star has no round context. No plan-level undo exists, so this mutates synchronously and without a stack, as the tray's x already does.
function clearPlanSlotFor(playerId) {
    const slot = planSlotOf(playerId);
    if (!slot) return;
    if (slot.isTarget) {
        plan = removePlanTarget(plan, slot.round);
    } else {
        const round = (plan?.rounds || []).find(r => r.round === slot.round);
        const idx = round ? (round.alternateIds || []).findIndex(id => id !== null && id !== undefined && String(id) === String(playerId)) : -1;
        if (idx < 0) return;
        plan = setPlanAlternate(plan, slot.round, idx, null);
    }
    savePlan();
}

// The plan's next open target, the first round the status function still reads as open, never a guess at who the reader wants. The order, team and live map come from whichever companion built this render, and the log picks are the followed room's or the rehearsal's own, which the status function reads interchangeably by shape.
function planNextOpenTarget(companion, logPicks) {
    if (!plan || !plan.rounds || !plan.rounds.length) return null;
    const statusRows = planStatus(plan, { picks: logPicks || [] }, companion.order, { myTeamId: companion.myTeamId });
    const open = statusRows.find(r => r.status === 'open' && r.targetId !== null && r.targetId !== undefined);
    if (!open) return null;
    const row = companion.liveById.get(String(open.targetId));
    return row ? { id: open.targetId, name: row.player.name } : null;
}

// The strip head's markup from the companion head state, which picks the word and verb. It is the state as plain text and, when there is an action, the same button shapes the row would show. It is empty when neither companion is running, and callers splice it into a head that has other content.
function companionHeadHtml(state) {
    if (!state) return '';
    let actionHtml = '';
    if (state.action) {
        const { kind, id, name } = state.action;
        actionHtml = kind === 'draft'
            ? `<button type="button" class="dm-rowdraft dr-companion-act" data-draft="${id}" title="${escapeHtml('Draft ' + name)}">Draft ${escapeHtml(name)}</button>`
            : roomDraftBtnHtml(id, name, 'dr-act-primary dr-companion-act');
    }
    return `<span class="dr-companion-state">${escapeHtml(state.word)}</span>${actionHtml}`;
}

function planProblemText(p) {
    if (p.kind === 'duplicate-target') return `the same player is targeted in rounds ${p.rounds.join(' and ')}`;
    if (p.kind === 'alternate-equals-target') return `round ${p.round}'s alternate is also its target`;
    if (p.kind === 'duplicate-alternate') return `round ${p.round} lists the same alternate twice`;
    return p.kind;
}

// Which round a player already sits in anywhere on the plan, target or either alternate, for the picker to show in place of choose. It is null when the player is not on the plan.
function planRoundOf(playerId) {
    const r = ((plan && plan.rounds) || []).find(rr => sameIdInPlan(rr, playerId));
    return r ? r.round : null;
}

function sameIdInPlan(round, playerId) {
    if (String(round.targetId) === String(playerId)) return true;
    return (round.alternateIds || []).some(id => id !== null && id !== undefined && String(id) === String(playerId));
}

// Which round and as what, target or alternate, so the File column can read R3 against a target and R1 alt against an alternate.
function planSlotOf(playerId) {
    const r = ((plan && plan.rounds) || []).find(rr => sameIdInPlan(rr, playerId));
    if (!r) return null;
    return { round: r.round, isTarget: String(r.targetId) === String(playerId) };
}

// Every id used anywhere on the plan except the one slot being set, so re-opening a slot does not grey out its own player, while every other slot, even in the same round, rules them out. One player, one round, anywhere on the plan.
function planUsedIdsExceptSlot(round, role) {
    const used = new Set();
    ((plan && plan.rounds) || []).forEach(r => {
        if (r.targetId !== null && r.targetId !== undefined && !(r.round === round && role === 'target')) {
            used.add(String(r.targetId));
        }
        (r.alternateIds || []).forEach((id, i) => {
            if (id === null || id === undefined) return;
            if (r.round === round && role === `alt${i}`) return;
            used.add(String(id));
        });
    });
    return used;
}

// The tray's alternates chip, with the plus and clear affordances that wireDraftTab reads through the open-picker and clear-alt attributes. The tray's compact row reuses it verbatim.
function ledgerAltsCellHtml(round, pool) {
    const target = round.targetId;
    const alts = round.alternateIds || [];
    if (target === null || target === undefined) return '<span class="dr-lg-alts"></span>';
    const parts = [];
    const filled = alts.filter(a => a !== null && a !== undefined).length;
    for (let i = 0; i < 2; i++) {
        if (alts[i] !== undefined && alts[i] !== null) {
            const ap = pool.find(x => String(x.id) === String(alts[i]));
            parts.push(`<span class="dr-lg-chip">${escapeHtml(ap ? ap.name : '')} <i>${escapeHtml(ap ? ap.positionDisplay || '' : '')}</i>`
                + `<button type="button" class="dr-lg-x" data-clear-alt="${round.round}" data-idx="${i}" title="Clear this alternate">&times;</button></span>`);
        } else if (i === filled) {
            parts.push(`<button type="button" class="dr-lg-plus" data-open-picker="${round.round}" data-role="alt${i}" title="Add an alternate">+ alt</button>`);
        }
    }
    return `<span class="dr-lg-alts">${parts.join('')}</span>`;
}

// The picker opens inside the row it is setting, so the reader never looks away from the round being filled. It lists two matches, the count a row this narrow can hold without running past its container, and every match row stays whole. A player already elsewhere on the plan is greyed with the round that holds them in place of choose, and cannot be chosen.
function ledgerPickerResultsHtml(pool) {
    if (!targetPicker) return '';
    const needle = pickerQuery.trim().toLowerCase();
    // The picker opens on the search box alone, since two players nobody asked for are only the pool's head repeated on every armed round. Results appear once the reader has typed.
    if (!needle) return '';
    // A rule pick is exempt from the already-elsewhere block, because the point of if I have X is that X is very likely already a round-one target, and prefer A over B naming this round's own target is correct. Only the target and alternate roles still refuse a player already on the sheet.
    const used = targetPicker.role.startsWith('rule-') ? new Set() : planUsedIdsExceptSlot(targetPicker.round, targetPicker.role);
    return pool
        .filter(p => p.name.toLowerCase().includes(needle))
        .slice(0, 2)
        .map(p => {
            const usedRound = used.has(String(p.id)) ? planRoundOf(p.id) : null;
            const val = planValueDisplay(p);
            if (usedRound !== null) {
                return `<div class="dr-lg-pr dr-lg-pr-taken">`
                    + `<span>${escapeHtml(p.name)}</span><i>${escapeHtml(p.positionDisplay || '')}</i>`
                    + `<span class="dr-lg-pr-val">${val}</span>`
                    + `<span class="dr-lg-pr-tag">in round ${usedRound}</span></div>`;
            }
            return `<button type="button" class="dr-lg-pr" data-pick-player="${p.id}">`
                + `<span>${escapeHtml(p.name)}</span><i>${escapeHtml(p.positionDisplay || '')}</i>`
                + `<span class="dr-lg-pr-val">${val}</span>`
                + `<span class="dr-lg-pr-tag dr-lg-pr-choose">choose</span></button>`;
        }).join('');
}

// A rule needing two players reuses this picker for both halves in sequence. The rule draft holds the first pick while the picker's role moves to the second, so only one picker is ever shown, and it says which half the reader is on.
function rulePickerPromptFor(role) {
    switch (role) {
        case 'rule-have-cond': return 'If you have&hellip;';
        case 'rule-have-then': return '&hellip;take this instead';
        case 'rule-prefer-a': return 'Prefer this player&hellip;';
        case 'rule-prefer-b': return '&hellip;over this one';
        default: return '';
    }
}

function ledgerPickerHtml(pool) {
    const prompt = targetPicker ? rulePickerPromptFor(targetPicker.role) : '';
    return `<div class="dr-lg-picker">`
        + (prompt ? `<div class="dr-lg-picker-prompt">${prompt}</div>` : '')
        + `<input type="search" id="dr-plan-picker-input" class="dr-search dr-lg-picker-input" `
        + `placeholder="Search players" value="${escapeHtml(pickerQuery)}" autofocus>`
        + `<div id="dr-plan-picker-results" class="dr-lg-picker-results">${ledgerPickerResultsHtml(pool)}</div>`
        + '</div>';
}

// The rule line, one line under a planned round listing every rule that applies. If gone comes first and is synthesised from the alternates, never stored twice, then the written rules, each with its own remove. The chooser offers three kinds, and if gone is a shortcut into the same alternate picker, since there is no second way to write one.
function ruleLineHtml(round, pool) {
    const rules = planRulesFor(plan, round.round);
    const nameOf = (id) => {
        const p = pool.find(x => String(x.id) === String(id));
        return p ? p.name : `player ${id}`;
    };
    let storedIndex = 0; // rulesFor's own head (ifGone) is never stored, so this counts ONLY the
    // The index into the stored rules that follow it, which is what the rule remover addresses by.
    const partsHtml = rules.map(rule => {
        if (rule.kind === 'ifGone') {
            const chain = rule.playerIds.map(id => escapeHtml(nameOf(id))).join(' &rarr; ');
            return `<span class="draft-rule">if gone &rarr; ${chain}</span>`;
        }
        const idx = storedIndex++;
        if (rule.kind === 'ifIHave') {
            return `<span class="draft-rule">if I have ${escapeHtml(nameOf(rule.playerId))} &rarr; take ${escapeHtml(nameOf(rule.thenId))} instead`
                + `<button type="button" class="draft-rule-x" data-remove-rule="${round.round}" data-rule-idx="${idx}" title="Remove this rule">&times;</button></span>`;
        }
        if (rule.kind === 'prefer') {
            return `<span class="draft-rule">prefer ${escapeHtml(nameOf(rule.aId))} over ${escapeHtml(nameOf(rule.bId))}`
                + `<button type="button" class="draft-rule-x" data-remove-rule="${round.round}" data-rule-idx="${idx}" title="Remove this rule">&times;</button></span>`;
        }
        return '';
    }).join('');

    const choosing = ruleChooserRound === round.round;
    const chooserHtml = choosing
        ? `<span class="draft-rule-chooser">`
            + `<button type="button" data-rule-kind="ifGone" data-rule-round="${round.round}">if gone</button>`
            + `<button type="button" data-rule-kind="ifIHave" data-rule-round="${round.round}">if I have</button>`
            + `<button type="button" data-rule-kind="prefer" data-rule-round="${round.round}">prefer</button>`
            + `<button type="button" class="draft-rule-x" data-close-rule-chooser="1" title="Cancel">&times;</button></span>`
        : `<button type="button" class="draft-rule-plus" data-open-rule-chooser="${round.round}">+ rule</button>`;

    return `<div class="draft-tray-rules">${partsHtml}${chooserHtml}</div>`;
}

// The tray's row. One compact line per round, with seat, target and verdict. The plan data and every data attribute are unchanged. Armed is a click and not the first empty round. Clicking an empty row's arm zone opens the in-row picker and shows the ghost suggestion, and a quiet empty round prints only its round, pick and empty seat chip. Clicking again, or Escape, closes it.
function trayRowHtml(round, pool, suggestions) {
    // Editing covers both pickers the row can open, the target's and an alternate's, and either needs the picker rendered and the row's close. Armed narrows to the target picker, since only it shows the ghost suggestion and the arm styling, an alternate being set under an already-filled round.
    const editingThisRound = !!targetPicker && targetPicker.round === round.round;
    const armed = editingThisRound && targetPicker.role === 'target';
    const target = round.targetId;
    const hasTarget = target !== null && target !== undefined;
    const p = hasTarget ? pool.find(x => String(x.id) === String(target)) : null;
    // The seat's positions come from the plan pool's own player shape, since the mock's map is null outside a mock run and the tray has no room running.
    const seat = p ? (p.eligiblePositions[0] || '') : '';
    // The suggestion is read only for the armed round, since an unarmed empty round shows nothing and has nothing to compute.
    const suggestion = armed && !hasTarget ? boardSuggestionFor(round, pool, suggestions) : null;

    let targetHtml;
    if (hasTarget && p) {
        targetHtml = `<span class="draft-tray-t"><b>${escapeHtml(p.name)}</b>`
            + `<span class="draft-tray-pos">${escapeHtml(p.positionDisplay || '')}</span>`
            + `<span class="draft-tray-value">${planValueDisplay(p)}</span>`
            + ledgerAltsCellHtml(round, pool)
            // The note beside a target in the tray uses the same icon and field the board's row uses, with one shared edit slot and no second note surface.
            + noteIconHtml(p.id)
            + `<button type="button" class="draft-tray-x" data-clear-target="${round.round}" title="Clear target">&times;</button></span>`;
    } else if (hasTarget) {
        targetHtml = '<span class="draft-tray-t draft-tray-none">no target</span>';
    } else if (suggestion) {
        // The figure and use never shrink. Only the name gives up room, and only once there is none left.
        targetHtml = `<span class="draft-tray-t draft-tray-ghost">suggests `
            + `<b>${escapeHtml(suggestion.name)}</b>`
            + `<span class="draft-tray-value">${planValueDisplay(suggestion)}</span>`
            + `<button type="button" class="draft-tray-use" data-use-suggest="${round.round}" data-player="${suggestion.id}">use</button></span>`;
    } else if (armed) {
        targetHtml = `<span class="draft-tray-t draft-tray-none">nothing likely to reach pick ${round.pick}</span>`;
    } else {
        // QUIET: round, pick and the empty seat chip are the whole of an un-armed open round.
        targetHtml = '<span class="draft-tray-t"></span>';
    }

    const verdictHtml = editingThisRound
        ? `<span class="draft-tray-verdict"><button type="button" class="draft-tray-close" data-close-picker="1">Close</button></span>`
        : (() => {
            if (!hasTarget) return '<span class="draft-tray-verdict"></span>';
            const adp = p ? p.adp : null;
            if (!adp) return '<span class="draft-tray-verdict"></span>';
            const word = survivalWord(adp, round.pick, 1);
            const bad = word === 'unlikely' || word === 'no' ? ' draft-tray-verdict-bad' : '';
            return `<span class="draft-tray-verdict${bad}">${escapeHtml(word)}</span>`;
        })();

    // The arm zone is the row itself, but only an empty round can be armed. A filled round's click surface is its target and alternates. The arm attribute sits on the outer div, and the click handler checks every more specific attribute first, so a click on a control reaches its own handler before falling through to arm or disarm.
    const armAttr = hasTarget ? '' : ` data-arm-round="${round.round}"`;
    // The rule line sits under the row as a block sibling, never inside the row's flex line, since a rule sentence is not one more chip. It is shown only for a round that has a target, the same gate the alternates chip uses, since a rule with nothing to fire over reads as noise.
    return `<div class="draft-tray-row${armed ? ' draft-tray-row-armed' : ''}${editingThisRound ? ' draft-tray-row-open' : ''}"${armAttr}>`
        + `<span class="draft-tray-round">R${round.round}<small>pick ${round.pick}</small></span>`
        + `<span class="draft-tray-seat${p ? ' draft-tray-seat-on' : ''}">${escapeHtml(seat || String.fromCharCode(8212))}</span>`
        + targetHtml
        + verdictHtml
        + (editingThisRound ? ledgerPickerHtml(pool) : '')
        + '</div>'
        + (hasTarget && p ? noteRenderedHtml(p.id) : '')
        + (hasTarget ? ruleLineHtml(round, pool) : '');
}

// Every empty round takes the same suggestion its ghost row offers, from one whole-plan call. A per-round ask would offer the same player round after round.
function fillOpenRounds() {
    ensurePlan();
    const pool = planPool();
    const suggestions = planSuggestions(pool);
    (plan.rounds || []).forEach(r => {
        if (r.targetId !== null && r.targetId !== undefined) return;
        const suggestion = boardSuggestionFor(r, pool, suggestions);
        if (suggestion) plan = setPlanTarget(plan, r.round, suggestion.id);
    });
    savePlan();
}

// Clear plan empties every target and alternate behind one confirm. The plan is per league and persisted, so an accidental click would erase the whole sheet with no undo. Round, pick and slot are untouched, since this empties a plan and does not rebuild one.
function clearPlan() {
    ensurePlan();
    if (!plan.rounds || !plan.rounds.some(r => r.targetId !== null && r.targetId !== undefined
        || (r.alternateIds || []).length)) return;
    if (!window.confirm('Clear every target and alternate from this plan?')) return;
    plan = { ...plan, rounds: plan.rounds.map(r => ({ ...r, targetId: null, alternateIds: [] })) };
    savePlan();
}

// The tray's foot. The plan's roster is priced by the lineup module's seat and summary through the plan roster helper, not a second computation. Total, ceiling, place and the Rehearse entry point stay here, and the seat-by-seat count lives in the My roster list above.
function planTrayFootHtml(summary) {
    const empty = '<div class="draft-tray-foot"><span class="dr-quiet">No starting seats to fill.</span></div>';
    if (!summary) return empty;
    const place = planStandingsPlace(findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid));
    return `<div class="draft-tray-foot">`
        + `<span>Total <b>${summary.total.toFixed(1)}</b></span>`
        + `<span>Ceiling <b>${summary.ceiling.toFixed(1)}</b></span>`
        + (place ? `<span><b>${ordinal(place.place)}</b> of ${place.of}</span>` : '')
        + `<button type="button" id="dr-plan-rehearse" class="dm-flat draft-tray-rehearse">Rehearse this plan &rsaquo;</button>`
        + '</div>';
}

// The tray itself. It holds one quiet row per round, Fill open rounds above and the plan's priced roster below. The pool and suggestions are the same reads the old planner face made, and only the row shape and housing are new.
function planTrayHtml() {
    const pool = planPool();
    const suggestions = planSuggestions(pool);
    const rounds = plan.rounds || [];
    const targetsSet = rounds.filter(r => r.targetId !== null && r.targetId !== undefined).length;
    // An empty plan used to draw every round's row, a wall of dash buttons before anything was targeted. This uses the same empty-note shape the log and rehearse trays use, worded for what this tray asks, since their wording would say something untrue here.
    if (!targetsSet) {
        return `<div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">${trayHandleHtml()}<div class="draft-tray-head">`
            + '<span class="dr-card-label lh-block-head">Plan</span></div>'
            + '<div class="dr-quiet draft-rehearse-note">No plan on file - target a round to get started.</div></div>';
    }
    const rowsHtml = rounds.map(r => trayRowHtml(r, pool, suggestions)).join('');
    const problems = validatePlan(plan).problems;
    const warn = problems.length
        ? `<div class="dr-quiet draft-tray-warn">To check: ${escapeHtml(problems.map(planProblemText).join('; '))}.</div>`
        : '';
    // No real picks exist yet in Plan alone, so there is no glance grid. Only My roster is drawn, from the plan's targets, with the round that targets each seat as small print and never a pick number that does not exist.
    const seats = planLeagueSeats();
    const { state: seatState, summary } = seats.length ? planRoster(plan, pool, seats, planCtx()) : { state: null, summary: null };
    const roundOf = (playerId) => {
        const r = (plan.rounds || []).find(rr => String(rr.targetId) === String(playerId));
        return r ? `round ${r.round}` : '';
    };
    return `
        <div class="draft-tray${trayOpenMobile ? ' draft-tray-open' : ''}">
            ${trayHandleHtml()}
            <div class="draft-tray-head">
                <span class="dr-card-label lh-block-head">Plan</span>
                <span class="draft-tray-count">${targetsSet} of ${rounds.length} targets</span>
                <span class="draft-tray-actions">
                    <button type="button" id="dr-plan-fill" class="dm-flat draft-tray-fill">Fill open rounds</button>
                    <button type="button" id="dr-plan-clear" class="dm-flat draft-tray-fill">Clear plan</button>
                </span>
            </div>
            ${warn}
            ${trayRosterHtml(seatState, roundOf)}
            <div class="draft-tray-ledger">${rowsHtml}</div>
            ${planTrayFootHtml(summary)}
        </div>
    `;
}

// This plan's roster. The lineup module's seat, total and ceiling over the plan's targets, not a second computation. Place is left off deliberately, since the roster helper hands the summary no standings, and an absent figure is truer than a borrowed one. Every target's real player object is used, since the projected sums read a field the trimmed pool never carried.
function planRosterPlayers() {
    const byId = new Map((AppState.playerData || []).map(p => [p.id, p]));
    return ((plan && plan.rounds) || [])
        .map(r => r.targetId)
        .filter(id => id !== null && id !== undefined)
        .map(id => byId.get(id))
        .filter(Boolean);
}

// Place is read against the same projected standings the pre-draft face computes, the app's one way of turning rosters into a projected finish. Every other team's roster is whatever the payload carries, which is nothing before any team has drafted, and the reader's own row is the plan's targets in place of their real roster.
function planStandingsPlace(myTeamId) {
    if (!myTeamId) return null;
    const mine = planRosterPlayers();
    if (!mine.length) return null;
    const rosters = { ...draftedRostersByTeam() };
    rosters[myTeamId] = mine;
    // With nobody else to be placed among, the plan cannot say where it would stand, and 1st of 1 would mean nothing.
    if (Object.keys(rosters).length < 2) return null;
    const { categoryIds, components, inverseIds } = projectedContext();
    if (!categoryIds.length) return null;
    if (AppState.isPointsLeague) return placeOf(projectedPointsStandings(rosters), myTeamId);
    const sums = projectedTeamSums(rosters, { categoryIds, components });
    const values = projectedValues(sums, categoryIds, components);
    const standings = projectedRotoStandings(
        values, categoryIds.map(id => ({ id, inverse: inverseIds.has(String(id)) })), rotoPointsForCategory
    );
    return placeOf(standings, myTeamId);
}

// ==== The companion ====

// LAZY, same reason ensurePlan() is: nothing about a log needs the league loaded, but there is nothing to build one FROM until then either, so it waits for the first ask rather than sitting at module scope.
function ensureLog() {
    if (!draftLog) draftLog = emptyLog();
    return draftLog;
}

// Fire and forget, the same shape as the plan's load. A log in memory paints at once and a saved one swaps in and redraws once storage answers, guarded by the key it was asked for.
function ensureLogLoad() {
    const key = draftLogKey(AppState.loadedSport, AppState.apiData?.id);
    if (logLoadedForKey === key) return;
    logLoadedForKey = key;
    readDraftLog(key).then(stored => {
        if (draftLogKey(AppState.loadedSport, AppState.apiData?.id) !== key) return;
        // A stored read may never discard what arrived while it was in flight. A read begun at page open and resolving after a room merge had landed replaced the merged log with the older one. Memory is never staler than storage, since every change is saved as it happens, and is only ever empty at the start, which is when the stored log should win.
        if (storedLogApplies(draftLog, stored)) {
            draftLog = stored;
            if (activeFace === CHEAT_SHEET) renderDraftTab();
        }
    });
}

// A room followed across leagues never writes the loaded league's log. Its picks are filtered out before every write whatever caused the save, while the in-memory log stays the merged view that every other reader reads. Only what reaches storage under the loaded league's key changes.
function saveLog() {
    if (!draftLog) return;
    const toSave = draftLogHasForeignRoomPicks
        ? { ...draftLog, picks: draftLog.picks.filter(p => p.source !== 'room') }
        : draftLog;
    writeDraftLog(draftLogKey(AppState.loadedSport, AppState.apiData?.id), toSave);
}

// Fire and forget, with one fixed key rather than a per-league one, loaded once for the life of the page, since whether a room is open does not change with the league. The listener is bound in the same call. A broadcast schedules at most one render on the next animation frame, while the room state itself updates synchronously so a render always reads the latest.
let roomRenderScheduled = false;
// The signature of the room state the last real render drew, which is the picks list, the status and the league id, because nothing downstream reads other fields. A broadcast that changes only what nobody displays is skipped here, as the page's own backstop to the reader's coalescing.
let lastRenderedRoomSignature = null;
function roomRenderSignature(state) {
    if (!state) return 'null';
    return JSON.stringify({
        status: state.status,
        leagueId: state.leagueId,
        picks: (state.picks || []).map(p => `${p.overall}:${p.teamId}:${p.playerId}`)
    });
}
function scheduleRoomRender() {
    if (activeFace !== CHEAT_SHEET) return;
    if (roomRenderScheduled) return;
    roomRenderScheduled = true;
    requestAnimationFrame(() => {
        roomRenderScheduled = false;
        const sig = roomRenderSignature(roomState);
        if (sig === lastRenderedRoomSignature) return;
        lastRenderedRoomSignature = sig;
        if (activeFace === CHEAT_SHEET) renderDraftTab();
    });
}

// Fire and forget, with one fixed key rather than a per-league one, loaded once for the life of the page, since whether a room is open does not change with the league on screen. The listener is bound in the same call, guarded by the same flag.
function ensureRoomLoad() {
    if (roomLoaded) return;
    roomLoaded = true;
    readRoomState().then(stored => {
        roomState = stored;
        // The first read of the page's life is never coalesced, since there is nothing to coalesce with and a reader opening the tab should not wait a frame.
        lastRenderedRoomSignature = roomRenderSignature(stored);
        if (activeFace === CHEAT_SHEET) renderDraftTab();
    });
    if (browser.runtime?.onMessage?.addListener) {
        browser.runtime.onMessage.addListener((message) => {
            if (!message || message.kind !== 'lw-room') return;
            roomState = message.roomState || null;
            scheduleRoomRender();
        });
    }
}

// A snapshot applies only to the league on screen when it is open and fresh. Freshness is checked here and not cached, since staleness is a function of the current clock. A closed room or one for a different league means the same thing to every caller, which is to read the hand log alone.
function roomActive() {
    if (!roomState || roomIsStale(roomState) || roomState.status !== 'open') return null;
    // A mismatched league id still applies once the reader has opted in through the follow banner. It is the same snapshot and the same merge by player id, and only the league id this function accepts differs.
    if (roomState.leagueId !== undefined && roomState.leagueId !== null
        && String(roomState.leagueId) !== String(AppState.apiData?.id)
        && !roomFollowedAcrossLeague) return null;
    return roomState;
}

// The offer roomActive refuses, a fresh open room whose league does not match the league on screen when the reader has not yet said to follow it. Once the follow flag is true this returns null, so the banner does not linger beside a board already following the room.
function roomForOtherLeague() {
    if (roomFollowedAcrossLeague) return null;
    if (!roomState || roomIsStale(roomState) || roomState.status !== 'open') return null;
    if (roomState.leagueId === undefined || roomState.leagueId === null) return null;
    if (String(roomState.leagueId) === String(AppState.apiData?.id)) return null;
    return roomState;
}

// The room's picks are already a reduced shape and are turned into synthetic selected facts, with their overall number dropped since the merge derives it from array position. The result is null when no room applies. The draft log is the merged log, so the tray, count, coverage, needs and board all follow the room. It is called once per render, because the merge is idempotent.
function mergeRoomIntoLog() {
    ensureLog();
    // Before the frames, and whether or not a room is open: the board is what a closed transport leaves behind (mergeRoomBoardIntoLog, above).
    mergeRoomBoardIntoLog();
    const room = roomActive();
    if (!room) {
        // When the room that put foreign picks into the log is no longer active, because it closed, went stale or the reader switched leagues, they never belonged to this league's draft and are stripped from the live view as well as the next save. A same-league room's picks are real history and are never touched.
        if (draftLogHasForeignRoomPicks && draftLog) {
            draftLog = { ...draftLog, picks: draftLog.picks.filter(p => p.source !== 'room') };
            draftLogHasForeignRoomPicks = false;
            // The standing follow decision goes with the room that earned it, so a reopened room offers the banner fresh and is never silently resumed.
            roomFollowedAcrossLeague = false;
            saveLog();
        }
        return null;
    }
    const isForeign = roomFollowedAcrossLeague;
    const facts = (room.picks || []).map(p => ({ kind: 'selected', teamId: p.teamId, playerId: p.playerId, at: p.at }));
    const result = applyRoomFacts(draftLog, facts, { teams: leagueTeamIds().length });
    if (result.added.length || result.corrected.length || result.dropped.length) {
        draftLog = result.log;
        // Only one room is ever active, so this merge's foreign-ness is the whole room-sourced content's foreign-ness and is never stale from a different room.
        draftLogHasForeignRoomPicks = isForeign;
        saveLog();
    }
    // A new room fact, added and not merely corrected or dropped, switches the reader onto Log picks so a pick that just landed is what they see. The merge is idempotent, so added is non-empty only on the render where it is new. Rehearse is turned off, since a room fact and a mock run are not shown at once, and Plan is left alone, since it combines with Log picks.
    if (result.added.length) {
        switches = { ...switches, log: true, rehearse: false };
    }
    return result;
}

// The room's own board, read into the log's prefix and the taken set. When frames stop, the board is the only source left, and it carries names and no ids. The name lookup is built fresh for each read. The prefix is merged only where the log holds fewer picks. Held and unresolved picks are never written anywhere. Held is read beside the log into the taken set, and unresolved is counted on an info mark.
function roomBoardSource() {
    const board = roomState && roomState.board;
    if (!board || !Array.isArray(board.picks) || !board.picks.length) return null;
    if (roomState.leagueId !== undefined && roomState.leagueId !== null
        && String(roomState.leagueId) !== String(AppState.apiData?.id)
        && !roomFollowedAcrossLeague) return null;
    return board;
}

function mergeRoomBoardIntoLog() {
    const board = roomBoardSource();
    if (!board) { roomBoardRead = null; roomBoardKey = ''; return; }
    const pool = AppState.playerData || [];
    // A signature of what was read, so the same board on the next render is a no-op: overall and name for every pick, plus the pool's size (the lookup's other input) and the log's length (what the merge rule compares against).
    let sig = 0;
    board.picks.forEach(pk => {
        const t = `${pk.overall}|${pk.name || ''}`;
        for (let i = 0; i < t.length; i++) sig = (sig * 31 + t.charCodeAt(i)) | 0;
    });
    const keyOf = () => `${sig}:${board.picks.length}:${pool.length}:${(draftLog?.picks || []).length}`;
    if (roomBoardRead && keyOf() === roomBoardKey) return;
    const clubs = proTeamAbbrevs();
    const entries = pool.map(p => ({ player: { id: p.id, fullName: p.name, proTeamId: p.proTeamId } }));
    const positionsById = new Map(pool.map(p => [p.id, p.eligiblePositions || []]));
    const lookup = poolNameLookup(entries, {
        clubOf: entry => (entry.player.proTeamId != null ? clubs.get(Number(entry.player.proTeamId)) : '') || '',
        positionsOf: id => positionsById.get(id) || []
    });
    const me = myTeamId();
    const read = domPickFacts(board.picks, {
        playerIdOf: lookup.playerIdOf,
        teamIdOf: pk => (pk.mine && me !== null ? me : null),
        grid: draftPicksFor()
    });
    if (read.facts.length > (draftLog?.picks || []).length) {
        const result = applyRoomFacts(draftLog, read.facts, { teams: leagueTeamIds().length });
        if (result.added.length || result.corrected.length || result.dropped.length) {
            draftLog = result.log;
            draftLogHasForeignRoomPicks = roomFollowedAcrossLeague;
            saveLog();
            // The same switch a NEW frame throws (mergeRoomIntoLog's own note): picks that just landed are what the reader should see, and the frames merge that follows finds them already in the log and so would never throw it.
            if (result.added.length) switches = { ...switches, log: true, rehearse: false };
        }
    }
    roomBoardRead = { held: read.held, unresolved: read.unresolved };
    roomBoardKey = keyOf();
}

// Stop following is the reader's way back out of a cross-league follow, the manual half of the rule the room closing applies. It is offered only while the cross-league flag is true, so every room-sourced pick in the log at that moment came from that one foreign room.
function stopFollowingRoom() {
    roomFollowedAcrossLeague = false;
    if (draftLog) {
        draftLog = { ...draftLog, picks: draftLog.picks.filter(p => p.source !== 'room') };
    }
    draftLogHasForeignRoomPicks = false;
    saveLog();
    renderDraftTab();
}

// Clear the room's picks is the manual way out for picks that had no way to clear. It is broader than stop following, offered whenever the log holds any room-sourced picks, same-league included, and that room is no longer active. A live room's picks stay off limits, as Undo already does.
function clearRoomPicks() {
    if (!draftLog) return;
    draftLog = { ...draftLog, picks: draftLog.picks.filter(p => p.source !== 'room') };
    draftLogHasForeignRoomPicks = false;
    saveLog();
    renderDraftTab();
}

// The age ticks without a new snapshot arriving. It is not a full render each second, which would rebuild the container and cost the search box its focus and any open note editor its text. The ticker rewrites the one span's text from the attributes the strip stamped on it, and the next real render replaces the cell with them, so the ticker is never the source of truth.
let roomTickTimer = null;
function ensureRoomTicking() {
    if (roomTickTimer) return;
    roomTickTimer = setInterval(() => {
        if (activeFace !== CHEAT_SHEET || !roomActive()) {
            clearInterval(roomTickTimer);
            roomTickTimer = null;
            return;
        }
        const sub = document.querySelector('.ds-cell-progress .ds-progress-sub');
        const lastPickAt = sub ? Number(sub.dataset.lastPickAt) : NaN;
        if (sub && Number.isFinite(lastPickAt)) {
            const ageSecs = Math.max(0, Math.round((Date.now() - lastPickAt) / 1000));
            sub.textContent = `last pick ${ageWords(ageSecs)}${sub.dataset.roundBit || ''}`;
        }
        // The sidebar's masthead reads the same last-pick attribute, so one ticker serves both spans rather than a second interval.
        const mastState = document.querySelector('.dr-sidebar-mast-state');
        const mastLastPickAt = mastState ? Number(mastState.dataset.lastPickAt) : NaN;
        if (mastState && Number.isFinite(mastLastPickAt)) {
            const ageSecs = Math.max(0, Math.round((Date.now() - mastLastPickAt) / 1000));
            mastState.textContent = `Following the room${mastState.dataset.countBit || ''} ${MIDDOT} ${ageWords(ageSecs)}`;
        }
    }, 1000);
}

// ==== The Draft push ==== Draft asks the room to press ESPN's own button and never sends a selection frame of its own. The click sends one runtime message and nothing else, with no local write to the log and no optimistic pick, only the pending mark below. The room's next fact, or the ten-second refusal, is the only thing that changes what the row says happened.

// Player id as a string, mapped to the time the Draft press went out. A reload loses it, like other in-sitting state here, since a pending press that outlives the tab is not worth persisting and the room's next snapshot settles it either way.
const roomPending = new Map();
// The reader's immediate reply that it is not on the clock flips a press to refused without waiting out the ten seconds. This is the set of ids that reply named, checked ahead of the elapsed-time fallback for a room the reply never reaches.
const roomRefusedNow = new Set();
const ROOM_DRAFT_TIMEOUT_MS = 10000;

function roomPendingStatus(playerId) {
    const id = String(playerId);
    const sentAt = roomPending.get(id);
    if (sentAt === undefined) return null;
    if (roomRefusedNow.has(id)) return 'refused';
    return (Date.now() - sentAt) >= ROOM_DRAFT_TIMEOUT_MS ? 'refused' : 'pending';
}

// Cleared the moment the room's facts place the player. The log is already merged by now, so a plain membership check is enough, and it runs once per render right after the merge so a press that landed is never shown pending.
function reconcileRoomPending() {
    if (!roomPending.size) return;
    const placed = new Set((draftLog.picks || []).map(p => String(p.playerId)));
    roomPending.forEach((sentAt, id) => {
        if (placed.has(id)) { roomPending.delete(id); roomRefusedNow.delete(id); }
    });
}

// The transport is a tab query and a tab message, since a runtime message sent from the page never reaches a content script. The name rides along because the room's table carries no player id, so the reader finds the row by name.
function draftToRoom(playerId) {
    const id = String(playerId);
    if (roomPendingStatus(id) === 'pending') return;   // already sent, waiting
    roomPending.set(id, Date.now());
    roomRefusedNow.delete(id);
    const name = (AppState.playerData || []).find(p => String(p.id) === id)?.name || '';
    const leagueId = AppState.apiData?.id;
    browser.tabs.query({ url: '*://fantasy.espn.com/*/draft*' }).then(tabs => {
        (tabs || []).forEach(tab => {
            const sent = browser.tabs.sendMessage(tab.id, { kind: 'lw-draft', leagueId, playerId, name });
            // The reply lets a refusal show before the ten seconds do. The reader answers not on the clock the moment it cannot find an enabled Draft button. A missing or errored reply falls through to the timer.
            if (sent && typeof sent.then === 'function') {
                sent.then(response => {
                    if (response && response.ok === false) {
                        roomRefusedNow.add(id);
                        if (activeFace === CHEAT_SHEET) renderDraftTab();
                    }
                }).catch(() => { /* no reply is not a refusal - the ten-second timer still applies */ });
            }
        });
    }).catch(() => { /* no room tab open; the pending mark already shows, the timer settles it */ });
    // The one thing that flips Sent to the room to the refusal when nothing else arrives. A room message or a tick re-renders for other reasons, but ten seconds of silence needs its own timer.
    setTimeout(() => {
        if (roomPendingStatus(id) === 'refused' && activeFace === CHEAT_SHEET) renderDraftTab();
    }, ROOM_DRAFT_TIMEOUT_MS);
}

// One button serves two call sites, the Actions cell and the strip head, and the primary flag picks which existing button look it borrows. The long refusal sentence overflowed the narrower of the two cells and was clipped mid-word, so both cells print the short word with the sentence as the title.
function roomDraftBtnHtml(playerId, playerName, primaryClass) {
    const status = roomPendingStatus(playerId);
    if (status === 'pending') {
        return `<span class="${primaryClass} dr-room-pending" title="Sent to the room - waiting for it to confirm">Sent to the room</span>`;
    }
    if (status === 'refused') {
        return `<span class="${primaryClass} dr-room-refused" title="The room did not take it; draft it in the room">Not taken</span>`;
    }
    return `<button type="button" class="dr-room-draft-btn ${primaryClass}" data-room-draft="${playerId}"`
        + ` title="${escapeHtml(`Send ${playerName} to the room's own Draft button`)}">Draft</button>`;
}

// The same three-piece shape as the plan and the log. Ensure builds an empty one so a reader can write before storage answers, load swaps in a stored one under the same stale-response guard, and save writes on every change.
function ensureNotes() {
    if (!notes) notes = emptyNotes(planLeagueKeyString());
    return notes;
}

function ensureNotesLoad() {
    const key = draftNotesKey(AppState.loadedSport, AppState.apiData?.id);
    if (notesLoadedForKey === key) return;
    notesLoadedForKey = key;
    readDraftNotes(key).then(stored => {
        if (draftNotesKey(AppState.loadedSport, AppState.apiData?.id) !== key) return;
        if (stored && stored.notes) {
            notes = stored;
            redrawRows();
        }
    });
}

function saveNoteText(playerId, text) {
    notes = setNote(ensureNotes(), playerId, text);
    writeDraftNotes(draftNotesKey(AppState.loadedSport, AppState.apiData?.id), notes);
}

// The tray's width, in the same load and save shape. There is nothing to ensure beyond the module default, since a number needs no empty-state builder.
function ensureTrayWidthLoad() {
    const key = draftTrayWidthKey(AppState.loadedSport, AppState.apiData?.id);
    if (trayWidthLoadedForKey === key) return;
    trayWidthLoadedForKey = key;
    readDraftTrayWidth(key).then(stored => {
        if (draftTrayWidthKey(AppState.loadedSport, AppState.apiData?.id) !== key) return;
        const n = Number(stored);
        if (Number.isFinite(n) && n > 0) {
            trayWidth = n;
            renderDraftTab();
        }
    });
}

// The same three-piece shape once more. The load re-reads storage under the new league's key and loads only the text and name, never a match, since the match is never cached.
function ensureRankingsLoad() {
    const key = rankingsFileKey(AppState.loadedSport, AppState.apiData?.id);
    if (rankingsLoadedForKey === key) return;
    rankingsLoadedForKey = key;
    readRankingsFile(key).then(stored => {
        if (rankingsFileKey(AppState.loadedSport, AppState.apiData?.id) !== key) return;
        if (stored && typeof stored.text === 'string') {
            rankingsFile = { name: stored.name || '', text: stored.text };
            renderDraftTab();
        }
    });
}

// Parse and match fresh against the board's rows passed in by the caller. It is never cached, because the file loads from local storage and can resolve before the player pool has finished loading, and a match built then stayed partial. A reader's own file is small, so re-matching costs nothing. The board's player rows carry a name field where the matching contract names fullName, so the adapter re-shapes them.
function currentRankingsMatch(rows) {
    if (!rankingsFile) return null;
    const readResult = readRankings(rankingsFile.text);
    const posById = new Map(rows.map(r => [String(r.player.id), r.player.eligiblePositions || []]));
    const clubs = proTeamAbbrevs();
    const matchPool = rows.map(r => ({ player: { id: r.player.id, fullName: r.player.name, proTeamId: r.player.proTeamId } }));
    const matchResult = matchRankings(readResult.rows, matchPool, {
        positionsOf: id => posById.get(String(id)) || [],
        clubOf: entry => clubs.get(Number(entry?.player?.proTeamId)) || ''
    });
    return { readResult, matchResult };
}

// Stashes the rank by id, the sort's key, and once the shown rows are in final order the cell's read of rank, board rank and delta, onto the companion. It is the one place the full render and the row redraw both build it. It is called twice per render on purpose, before and after the sort, since the board rank is the row's position in the order shown.
function attachRankingsSortKey(companion, rows) {
    const rankingsMatch = rankingsFile ? currentRankingsMatch(rows) : null;
    companion.myRankById = rankingsMatch
        ? new Map(Object.entries(rankingsMatch.matchResult.byPlayerId).map(([id, v]) => [id, v.rank ?? null]))
        : null;
    return rankingsMatch;
}

function attachRankingsColumn(companion, rankingsMatch, shown) {
    companion.myRankColumnById = rankingsMatch
        ? new Map(rankingsColumn(rankingsMatch.matchResult.byPlayerId, shown).map(e => [String(e.playerId), e]))
        : null;
}

function readRankingsTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

function applyRankingsFile(name, text) {
    rankingsFile = { name, text };
    writeRankingsFile(rankingsFileKey(AppState.loadedSport, AppState.apiData?.id), { name, text });
    renderDraftTab();
}

function clearRankingsFile() {
    rankingsFile = null;
    removeRankingsFile(rankingsFileKey(AppState.loadedSport, AppState.apiData?.id));
    renderDraftTab();
}

function saveTrayWidth(px) {
    trayWidth = px;
    writeDraftTrayWidth(draftTrayWidthKey(AppState.loadedSport, AppState.apiData?.id), trayWidth);
}

// THE READER'S OWN TEAM. Named separately from teamNameOf's own teamId lookups because every companion helper below needs it and none of them should re-derive it its own way.
function myTeamId() {
    return findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid);
}

// The companion's order is the plan's full order, called directly and not through ensurePlan, since the cheat sheet can be opened without visiting the plan builder and the order needs no plan object.
function companionOrder() {
    return planFullOrder(ownSlot() || 1);
}

// The refusal of applyLoggedPick, surfaced. It returns an identity-equal log when the log had already moved past this slot or this player is already in it. One line in the strip is better than silence, since the team select makes an out-of-order log a deliberate action.
let logRefusalMsg = null;

// A pick lands against whoever is on the clock by default, but the strip's team select can name any team. The apply function never required the snake-order team, only the next overall slot, which is what makes a keeper or out-of-order pick loggable. The refusal helper names why a pick would be refused before it is attempted, so the strip says the actual reason.
function logPick(playerId, teamId) {
    ensureLog();
    const order = companionOrder();
    const np = nextLoggedPick(order, draftLog, myTeamId());
    if (!np) return;
    const forTeam = teamId !== null && teamId !== undefined && !Number.isNaN(teamId) ? teamId : np.teamId;
    const refusal = loggedPickRefusal(draftLog, { overall: np.overall, playerId });
    if (refusal) {
        logRefusalMsg = refusal.reason;
        return;
    }
    draftLog = applyLoggedPick(draftLog, { overall: np.overall, teamId: forTeam, playerId });
    logRefusalMsg = null;
    saveLog();
}

function undoLog() {
    ensureLog();
    // Undo covers hand picks only. A room pick is what happened and not something the reader logged. The guard checks the last pick's source rather than scanning the log, since undo only removes the tail, and the button's disabled state is the same check, so the guard stands on its own whatever drew the button.
    const last = draftLog.picks[draftLog.picks.length - 1];
    if (last && last.source === 'room') return;
    draftLog = undoLastPick(draftLog);
    saveLog();
    logRefusalMsg = null;
    // An emptied log un-refuses Rehearse, so the old refusal is stale the moment the pick it complained about is gone.
    switchRefused = null;
}

// Every fact a row or the strip needs, built once per render rather than per row, since the board runs to thousands of rows. The live re-rank follows from a pick changing who the replacement is at that player's group, and so every remaining player's edge over it. A gone player keeps what the full board said of them. The board builder was timed at under the threshold for memoising, so none is built.
function companionContext(rows) {
    ensureLog();
    ensurePlan();
    // The draft log is the merged log by the time this runs, since the board merges the room before building the companion. Every read below is the plain log read, and a room's picks flow through gone, mine, the live re-rank and the strip as a hand pick does, with no second effective log.
    const order = companionOrder();
    const mine = myTeamId();
    const np = nextLoggedPick(order, draftLog, mine);
    const goneIds = new Set((draftLog.picks || []).map(p => String(p.playerId)));
    const mineIds = new Set((draftLog.picks || [])
        .filter(p => mine !== null && String(p.teamId) === String(mine))
        .map(p => String(p.playerId)));
    // A held pick, on the room's board past the log's prefix, is still a taken player, so a drafted player is never offered as available. It is read beside the log and never into it, since the log is an ordered draft and a held pick has no place in that order yet.
    (roomBoardRead?.held || []).forEach(h => {
        goneIds.add(String(h.playerId));
        if (mine !== null && h.teamId !== null && h.teamId !== undefined && String(h.teamId) === String(mine)) mineIds.add(String(h.playerId));
    });
    const targetIds = new Set((plan.rounds || [])
        .filter(r => r.targetId !== null && r.targetId !== undefined)
        .map(r => String(r.targetId)));
    const liveRows = goneIds.size ? buildBoard(goneIds) : rows;
    const liveById = new Map(liveRows.map(r => [String(r.player.id), r]));
    const nextOverall = np && np.myNextOverall !== null && np.myNextOverall !== undefined ? np.myNextOverall : 0;
    const currentOverall = np ? np.overall : 1;
    // Fed the same live pool the value column reads, never the frozen pre-draft rows, since waiting a pick changes who the replacement is at a gone player's seat. It is never run where the sport has no seat groups, since every row would read the same structural answer. The map stays null and the row falls back to the survival cell.
    const overNextById = sportHasSeatGroups() ? new Map(valueOverNext(
        liveRows.filter(r => r.value !== null && r.value !== undefined).map(r => ({
            id: r.player.id, value: r.value, group: r.group, adp: adpOf(r.player)
        })),
        nextOverall,
        { groupOf: p => p.group, currentPick: currentOverall, adpOf: p => p.adp }
    ).rows.map(r => [String(r.id), r])) : null;
    return {
        order, np, myTeamId: mine, goneIds, mineIds, targetIds, liveRows, liveById,
        overNextById,
        picksLogged: draftLog.picks.length,
        nextOverall, currentOverall
    };
}

// The default board, with no switch active, has no strip, rail or action columns. The plan, rehearse and log modes add a tray and a strip over this same table when their own switch is on, and nothing here forks for them.
function boardHtml() {
    // None used to mean one blank page. It now also covers a league whose draft is past with no snapshot taken, which gets the real results instead. The league's own answer comes first, since the basis reads live for a league that has drafted and not played. It is asked before the log, because the log records what was seen and this asks what happened.
    if (draftTabShowsResults(AppState.apiData)) return draftResultsHtml();
    if (boardBasis().state === 'none') return draftResultsHtml();
    // Three states, not one. The no-projections text used to print for an unloaded pool as well as one with none, so it showed on every open and for good when the pool failed. The pool's two flags tell them apart, still loading, failed, and only then a loaded pool without projections.
    if (!AppState.playerDataLoaded) return poolPendingHtml();
    if (!poolHasProjections()) return noProjectionsHtml();
    // Read directly rather than passed in, since the sidebar masthead and open button read the same attribute the same way, which keeps one spelling of the surface check.
    const isSidebar = document.documentElement.getAttribute('data-surface') === 'sidebar';
    ensurePlanLoad();
    ensureLogLoad();
    ensureNotesLoad();
    ensureTrayWidthLoad();
    ensureRoomLoad();
    ensureRankingsLoad();

    // Plan pins an Add column, Rehearse a Draft one and Log picks a Taken one, all onto this same board with a tray beside it. Rehearse changes the board only once a mock is running. The switches guarantee log and rehearse are never both true, so the log flag needs no extra guard.
    const showPlan = switches.plan;
    // PRE-MERGE READ, on purpose: this decides whether mergeRoomIntoLog runs AT ALL (a mock's own state must never gain room picks), so it has to read `switches.rehearse` as it stood BEFORE this render's own merge could touch it.
    const showRehearsePre = switches.rehearse && !!mock;
    if (showPlan || switches.log) ensurePlan();
    if (switches.rehearse) ensurePlan();
    // Merged into the draft log itself before the companion reads it, so every reader downstream sees the room's picks with no second path. It is not run for Rehearse, since a mock has its own state and this only touches the real log.
    const roomMerge = showRehearsePre ? null : mergeRoomIntoLog();
    reconcileRoomPending();
    if (roomActive()) ensureRoomTicking();
    // Read fresh, only after the merge. The merge can flip the log switch on and the rehearse switch off on the very render a new room fact arrives, and reading them earlier left every downstream use one render late, including the strip that should first appear with the room.
    const showLog = switches.log;
    const showRehearse = switches.rehearse && !!mock;
    // The sidebar's default is re-checked every render. The log is already current after the merge, so a room's picks count the same render they land.
    if (isSidebar && !hideDraftedUserSet && ((draftLog?.picks || []).length > 0 || !!roomActive())) {
        filterHideDrafted = true;
    }

    const rows = buildBoard();
    // A frozen board says so once, where the caption already names the basis, since a reader comparing it to a live one needs to know it is dated and not moving.
    const basis = boardBasis();
    // The frozen board's Drafted column and its header-click sort. Pick order only reorders what is displayed, so it is applied to the shown rows and never the ranked rows, which stay as the board builder ranked them.
    const draftedById = frozenDraftedById();
    const frozen = basis.state === 'frozen';
    // A frozen plan has nothing left to arm. The draft already happened, so Plan becomes a read-only status report with no Add column and no Fill open rounds, reading yours, gone and open against the real picks. The Drafted column is frozen-only and independent of the Plan switch.
    const showAdd = showPlan && !frozen;
    const catIds = boardCategoryIds();
    const alwaysEstimatedIds = new Set(estimateSplit().estimated);
    // One companion shape, two sources, a real draft's log or the mock's state. The mock's context hands back identical fields, so nothing downstream needs to know which it got. It is built before the shown rows because the two filter pills read its mine and gone ids.
    const companion = showRehearse ? mockCompanionContext(rows, mock.state) : companionContext(rows);
    companion.draftedById = draftedById;
    // The one thing the Progress cell needs that a plain log read cannot give it, whether a room applies at all and what the merge just corrected or dropped. It is not stashed by the companion context itself, which was the wrong place for it.
    companion.room = roomActive();
    companion.roomCorrected = roomMerge?.corrected || [];
    companion.roomDropped = roomMerge?.dropped || [];
    const rankingsMatch = attachRankingsSortKey(companion, rows);
    const shown = applyBoardSort(visibleRows(rows, companion), draftedById, companion);
    attachRankingsColumn(companion, rankingsMatch, shown);
    const yours = showRehearse && teamOnClock(mock.state) === mock.userTeamId;
    const valueColTitle = AppState.isPointsLeague
        ? "Projected points, your league's own scoring - the same figure Player Metrics shows. The board is still ORDERED by the edge over the last starter at that seat's replacement; each figure shows that edge."
        : "The edge over the last starter at that position group, added up across every category your league scores. 0 is a player you could have anyway.";

    // Coverage under the category headers, for category leagues only, since a points league has no per-category ahead-of figure. The same coverage header serves Log picks, from the log coverage reading the real log and not a mock's rosters.
    const coverageById = AppState.isPointsLeague ? null
        : (showRehearse ? coverageHeadMap(mock.state) : (showLog ? logCoverageHeadMap(companion, rows) : null));
    // The popover is its own floating overlay, never a tray occupant. The tray flag means only that a mock is actually running for Rehearse, so Plan's tray does not lose its slot to a Rehearse that has merely been switched on.
    const showTray = showPlan || showLog || showRehearse;
    // Log picks' tray wins the slot when both it and Plan are on, since its status-form rows already fold the plan's state in and the Plan tray would add nothing.
    let trayHtml = '';
    if (showLog) trayHtml = logTrayHtml(rows, companion);
    else if (showPlan) trayHtml = frozen ? logTrayHtml(rows, companion, realDraftLog(), 'No plan on file.') : planTrayHtml();
    else if (showRehearse) trayHtml = rehearseTrayHtml(rows, mock.state);
    // Pill depth is read off the remaining pool while Log picks is on, the same shrinking re-rank the Value column reads, so a position with every eligible player drafted does not read as deep.
    const poolRows = showLog ? companion.liveRows : rows;
    // Below 700px and on the sidebar surface the tray keeps its stacked placement. The media query is read fresh, for the same reason the pointer check reads its own fresh. At desktop width the tray is a strip above the grid until opened, then takes a real column in the grid rather than floating over it, and the grid reserves the width only while it is shown.
    const foldsToStrip = showTray && !isSidebar
        && typeof window !== 'undefined' && !window.matchMedia('(max-width: 700px)').matches;
    const trayInGrid = showTray && (!foldsToStrip || trayOpenDesktop);

    return `
        <div class="draft-pool-wrap">
            ${foldsToStrip && !trayOpenDesktop ? `<div class="dr-tray-strip">${trayHtml}</div>` : ''}
            ${showRehearse ? draftStripHtml(rows, companion, 'rehearse') : (showLog ? draftStripHtml(rows, companion, 'log') : '')}
            <div class="draft-grid ${trayInGrid ? 'draft-grid-tray' : 'draft-grid-solo'}"${trayInGrid ? ` style="--dr-tray-w: ${trayWidth}px"` : ''}>
                <div class="draft-pool">
                    ${poolControlsHtml(poolRows)}
                    <div class="dr-scroll">
                        <table class="dr-table">
                            <thead><tr>
                                <th class="dr-col-rank">${sortHeadHtml('rank', '#')}</th>
                                <th class="dr-col-name">${sortHeadHtml('name', 'Player')}</th>
                                <th class="dr-col-pos">${sortHeadHtml('pos', 'Pos')}</th>
                                <th class="dr-col-value">${sortHeadHtml('value', 'Value', valueColTitle)}</th>
                                ${companion.myRankColumnById ? `<th class="dr-col-myrank">${sortHeadHtml('myrank', 'My rank', "Your own file's rank, and how far that sits from this board's.")}</th>` : ''}
                                ${poolHasAdp() ? `<th class="dr-col-adp">${sortHeadHtml('adp', 'ADP', 'Where the crowd drafts this player, and how far that sits from this board.')}</th>` : ''}
                                ${draftedById
                                    ? `<th class="dr-col-drafted">${sortHeadHtml('drafted', 'Drafted', "Click to sort by pick order instead of the board's own order.")}</th>`
                                    : (companion.overNextById
                                        ? '<th class="dr-col-overnext" title="What this player is worth over the best of the same seat group likely to be there at your next pick, and whether this player lasts.">Take or wait</th>'
                                        : `<th class="dm-col-survive">Survives to ${companion.nextOverall || '-'}?</th>`)}
                                ${categoryHeadsHtml(catIds, alwaysEstimatedIds, coverageById, boardCategoryDividerId())}
                                <th class="dr-col-actions dr-col-actions-reveal${!showLog && !showRehearse ? ' dr-col-actions-narrow' : ''}"></th>
                            </tr></thead>
                            <tbody>${tableBodyHtml(rows, shown, 5 + (companion.myRankColumnById ? 1 : 0) + (poolHasAdp() ? 1 : 0) + catIds.length + 1, companion, showLog, showAdd, showRehearse, yours)}</tbody>
                        </table>
                    </div>
                </div>
                ${trayInGrid ? trayHtml : ''}
            </div>
            ${isSidebar ? sidebarFootTabsHtml() : ''}
        </div>
    `;
}

// Three buttons with no content of their own. Board is the card pool already there, and Roster and Picks are the tray's children, already built for the desktop tray. The stylesheet keyed on the body's foot-tab attribute shows one and hides the rest. It is the last flex child of the pool wrapper, so it stays out of the scroll region and visible with no fixed overlay.
function sidebarFootTabsHtml() {
    const tabs = [['board', 'Board'], ['roster', 'Roster'], ['picks', 'Picks']];
    return `<div class="dr-foot-tabs">${tabs.map(([id, label]) =>
        `<button type="button" class="dr-foot-tab-btn${sidebarFootTab === id ? ' dr-foot-tab-on' : ''}" data-foot-tab-btn="${id}">${escapeHtml(label)}</button>`
    ).join('')}</div>`;
}

/**
 * Renders the Draft tab into its container from the loaded league, and wires its events. It shows
 * the empty, loading and error states when there is no league or no projections, the results when
 * the draft is past, and otherwise the board with whichever switches are on.
 * @returns {void}
 */
export function renderDraftTab() {
    const container = document.getElementById('draft-container');
    if (!container) return;

    if (!AppState.apiData) {
        container.innerHTML = '';
        return;
    }

    ensureSwitchesAutoOn();

    // The sidebar always follows the room in Log picks, since nobody opens the app beside the draft room to see Plan or Rehearse. It is forced every render, which is cheap and idempotent, so a league switch or a Rehearse started earlier cannot leave the wrong face. Plan is left alone, since it combines with Log picks.
    const isSidebar = document.documentElement.getAttribute('data-surface') === 'sidebar';
    if (isSidebar) {
        switches = { ...switches, log: true, rehearse: false };
        // The sidebar's foot tabs reuse the mobile tray's markup. That markup collapses to its head line below 700px unless it carries the open class, and forcing it on makes the children exist to be shown or hidden by the foot tab styles.
        trayOpenMobile = true;
    }

    // The board basis stays a synchronous read, and this only makes sure the snapshot it reads has been asked for. Before this the frozen basis was reachable only after the player detail had run, so opening the Draft tab first read a league with a snapshot as none. It is keyed once per league.
    ensureBoardBasis(renderDraftTab);
    // The same fire-and-forget shape for the picks themselves, with the loader deduping and caching by league. The round count reads them on every board, since a pre-draft grid carries a round id per seat, so this fires here once and not only from the frozen readers, which left a live board's round count on the fallback.
    ensureDraftPicks(AppState.loadedSport);

    // One board and one masthead, the facts once and the three switches beside them. The sidebar's masthead is a different line entirely and not the full mast hidden by styles, since a live button is better never built than hidden. The offer is read before the board runs the merge, and the two never disagree in a render, since the offer answers only for a room not yet accepted, which only the banner's click can change.
    const otherLeagueRoom = roomForOtherLeague();
    // The board is computed first, into a variable, rather than inline in the template. A template literal evaluates left to right and the switches row sits earlier in the string, so inline it would stringify the switches off the old state before the merge inside the board flipped one, a render too late.
    const boardBodyHtml = boardHtml();
    // Once a league's draft is over, the open-beside-the-room, My rankings, Plan, Rehearse and Log picks controls are removed. It reads the one flag the file already uses everywhere for the draft being over, so there is no second guess. A league whose draft has not finished is unaffected.
    const draftIsPast = draftTabShowsResults(AppState.apiData);
    container.innerHTML = `
        <div class="draft-mast">
            ${isSidebar ? sidebarMastHtml() : `${mastFactsHtml()}${draftIsPast ? '' : `${sidebarOpenBtnHtml()}${rankingsBtnHtml()}${switchesHtml()}`}`}
        </div>
        ${isSidebar && !draftIsPast ? `<div class="draft-mast-tools-row">${rankingsBtnHtml()}</div>` : ''}
        ${otherLeagueRoom ? roomOtherLeagueBannerHtml() : ''}
        <div id="draft-face-body" class="draft-face-body"${isSidebar ? ` data-foot-tab="${sidebarFootTab}"` : ''}>${boardBodyHtml}</div>
    `;

    wireDraftTab(container);
}

// Re-rendering the whole face on every keystroke would lose focus and the caret, so the search box redraws only the rows beneath it and leaves itself alone.
function redrawRows() {
    if (activeFace !== CHEAT_SHEET) return;
    const body = document.querySelector('.dr-table tbody');
    if (!body) return;
    const rows = buildBoard();
    // The same drafted-column read as the board's, so a search on the frozen board keeps the column and its sort and does not fall back to Over next and Survives.
    const draftedById = frozenDraftedById();
    // The same mode read as the board's, so a search typed mid-rehearsal or mid-log keeps the right columns and companion.
    const showPlan = switches.plan;
    const showRehearse = switches.rehearse && !!mock;
    const showLog = switches.log;
    // A frozen Plan has no Add column, and a search redraw must agree. The drafted map is non-null only on a frozen board.
    const showAdd = showPlan && !draftedById;
    const companion = showRehearse ? mockCompanionContext(rows, mock.state) : companionContext(rows);
    companion.draftedById = draftedById;
    // A search keystroke replaces the tbody alone and never the thead, so the My rank header built once survives and its cells have to as well, or the column would be headed but empty.
    const rankingsMatch = attachRankingsSortKey(companion, rows);
    const shown = applyBoardSort(visibleRows(rows, companion), draftedById, companion);
    attachRankingsColumn(companion, rankingsMatch, shown);
    const yours = showRehearse && teamOnClock(mock.state) === mock.userTeamId;
    body.innerHTML = tableBodyHtml(rows, shown, 5 + (companion.myRankColumnById ? 1 : 0) + (poolHasAdp() ? 1 : 0) + boardCategoryIds().length + 1, companion, showLog, showAdd, showRehearse, yours);
    // A search keystroke replaces the tbody wholesale with new image tags that have no wiring, so every row lost its hide-on-load and showed initials behind the headshot. The avatar wiring is idempotent per image, so calling it here costs nothing for images already settled.
    wirePlayerAvatars(body);
    // The same gap as for avatars. A search swaps in rows whose widest badge or value can differ from what the last full render measured, so the fits run again here and not only from the tail of wireDraftTab.
    const container = body.closest('#draft-container');
    if (container) {
        fitOverNextColumn(container);
        fitLiveBoardCategories(container);
        fitCollapsedBoardCategories(container);
    }
}

function wireDraftTab(container) {
    // Absent from the DOM entirely whenever there is no API to call, so this is a plain optional chain and not a feature check.
    container.querySelector('#dm-open-sidebar')?.addEventListener('click', openBesideRoom);

    // The banner's opt-in, the only place the follow flag is set. It is absent from the DOM whenever there is no other-league room, so it is a plain optional chain.
    container.querySelector('[data-follow-other-room]')?.addEventListener('click', () => {
        roomFollowedAcrossLeague = true;
        renderDraftTab();
    });

    // The two ways out are absent unless the strip offered them, so both are plain optional chains.
    container.querySelector('#dr-stop-following')?.addEventListener('click', stopFollowingRoom);
    container.querySelector('#dr-clear-room-picks')?.addEventListener('click', () => {
        if (!window.confirm("Clear this log's room picks? Your own hand-logged picks are kept.")) return;
        clearRoomPicks();
    });

    // The My rankings popover, with toggle, the file input's change and Clear. It is bound fresh every render like the sidebar button and switches, not the bound-once delegated pattern, since its markup is replaced on every render.
    container.querySelector('#dm-rankings-toggle')?.addEventListener('click', () => {
        rankingsPanelOpen = !rankingsPanelOpen;
        renderDraftTab();
    });
    container.querySelector('#dm-rankings-file')?.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        readRankingsTextFile(file).then(text => applyRankingsFile(file.name, text));
    });
    container.querySelector('#dm-rankings-clear')?.addEventListener('click', clearRankingsFile);

    // The foot tabs are present only in the sidebar surface, so this is a no-op everywhere else.
    container.querySelectorAll('[data-foot-tab-btn]').forEach(btn => {
        btn.addEventListener('click', () => {
            sidebarFootTab = btn.dataset.footTabBtn;
            renderDraftTab();
        });
    });

    // A click is one request to resolveDraftSwitches, with on or off decided by the switch's current state. The exclusivity, the refusal and the date rule live there, and this handler asks and redraws.
    container.querySelectorAll('.draft-switch').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.switch;
            applySwitchRequest(id, !switches[id]);
            renderDraftTab();
        });
    });

    wireMockFace(container);

    // Delegated, because the rows are replaced wholesale on every search keystroke. It is bound once, since every other handler hangs off an element a render replaces but this one hangs off the container, which survives, and rebinding stacked handlers so a click toggled the star several times. The note field is delegated for the same reason. Enter saves directly and not through a blur.
    if (!container.dataset.noteWired) {
        container.dataset.noteWired = '1';
        let noteSuppressFocusout = false;
        container.addEventListener('focusout', (e) => {
            const input = e.target.closest('[data-note-input]');
            if (!input) return;
            if (noteSuppressFocusout) { noteSuppressFocusout = false; return; }
            saveNoteText(Number(input.dataset.noteInput), input.value);
            noteEditing = null;
            renderDraftTab();
        });
        container.addEventListener('keydown', (e) => {
            const input = e.target.closest('[data-note-input]');
            if (!input) return;
            // Ctrl+Enter, or Cmd on a Mac, saves. A bare Enter is a new line in the textarea and is never intercepted.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                noteSuppressFocusout = true;
                saveNoteText(Number(input.dataset.noteInput), input.value);
                noteEditing = null;
                renderDraftTab();
            } else if (e.key === 'Escape') {
                noteSuppressFocusout = true;
                noteEditing = null;
                renderDraftTab();
            }
        });
    }

    // The tray's drag handle. Dragging writes the custom property directly rather than re-rendering per pixel, and the tray's width and the board's scroll inset both follow that one property, so a live drag never touches the DOM tree until release, when the width is saved and the module's value catches up.
    if (!container.dataset.trayHandleWired) {
        container.dataset.trayHandleWired = '1';
        container.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('[data-tray-handle]');
            if (!handle) return;
            const grid = handle.closest('.draft-grid');
            const pool = grid?.querySelector('.draft-pool');
            if (!grid || !pool) return;
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = trayWidth;
            // Half the board's current width, not the whole grid, since the board is what the tray sits beside.
            const ceiling = Math.round(pool.getBoundingClientRect().width * 0.5);
            const onMove = (ev) => {
                // The handle sits on the tray's left edge, so dragging left widens the tray and the delta is the start x minus the pointer's x.
                const next = Math.max(TRAY_WIDTH_FLOOR, Math.min(ceiling, startWidth + (startX - ev.clientX)));
                grid.style.setProperty('--dr-tray-w', `${next}px`);
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                const written = Number.parseFloat(grid.style.getPropertyValue('--dr-tray-w'));
                saveTrayWidth(Number.isFinite(written) ? Math.round(written) : trayWidth);
                // The live category fit only removes category nodes, so a drag that widens the board again needs the full category set back, which only a fresh render gives. One render on drag end, not per move, the same settle-then-render shape the persistence uses.
                renderDraftTab();
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    // The row's companion control is revealed on hover or focus and never resident. A coarse pointer has no hover, so tapping the row reveals it there, since mobile is a priority. A row with nothing to reveal never gets the class, since a tap that reveals nothing would read as a bug.
    if (!container.dataset.tapRevealWired) {
        container.dataset.tapRevealWired = '1';
        container.addEventListener('click', (e) => {
            if (!isCoarsePointer()) return;
            if (e.target.closest('button, a, input, select')) return;
            const row = e.target.closest('.dr-table tbody tr');
            const hasCompanionControl = row && row.querySelector(
                '.dr-act-cell .dm-rowdraft, .dr-act-cell .dr-room-draft-btn, .dr-act-cell .dr-taken-btn.dr-taken-outline');
            if (!hasCompanionControl) return;
            const alreadyRevealed = row.classList.contains('dr-row-revealed');
            container.querySelectorAll('.dr-row-revealed').forEach(r => r.classList.remove('dr-row-revealed'));
            if (!alreadyRevealed) row.classList.add('dr-row-revealed');
        });
    }

    if (!container.dataset.queueWired) {
        container.dataset.queueWired = '1';
        container.addEventListener('click', (e) => {
            // The mobile tap to expand. The head line is the tap target, but some of its children are real controls with their own handlers, so only the head's own background or label toggles the tray. Below 700px there is no re-render, since the flag and class only need to agree. At desktop width the head is the fold's strip and toggling moves the tray between two places in the template, so that branch re-renders.
            const trayHead = e.target.closest('.draft-tray-head');
            if (trayHead && !e.target.closest('button, select, a, input')) {
                if (window.matchMedia('(max-width: 700px)').matches) {
                    trayOpenMobile = !trayOpenMobile;
                    const tray = trayHead.closest('.draft-tray');
                    if (tray) tray.classList.toggle('draft-tray-open', trayOpenMobile);
                } else {
                    trayOpenDesktop = !trayOpenDesktop;
                    renderDraftTab();
                }
                return;
            }

            // Every column header, folding in the Drafted click. It is a full render, since this changes the row order itself and not a display-only flag.
            const sortHead = e.target.closest('[data-sort-col]');
            if (sortHead) {
                cycleBoardSort(sortHead.dataset.sortCol);
                renderDraftTab();
                return;
            }

            // The two filter pills use the rows-only redraw the search box uses, since neither changes which columns show.
            const filterPill = e.target.closest('[data-filter]');
            if (filterPill) {
                if (filterPill.dataset.filter === 'fits') filterFitsSeat = !filterFitsSeat;
                else if (filterPill.dataset.filter === 'hide') { filterHideDrafted = !filterHideDrafted; hideDraftedUserSet = true; }
                redrawRows();
                filterPill.classList.toggle('dr-filter-pill-on');
                return;
            }

            // Board at a glance's team filter is a full render and not the rows-only redraw, since it changes the grid's dimming and adds or removes the picks list inside the tray, which the table redraw never touches.
            const glanceTeam = e.target.closest('[data-glance-team]');
            if (glanceTeam) {
                glanceTeamFilter = glanceTeam.dataset.glanceTeam === '' ? null : glanceTeam.dataset.glanceTeam;
                renderDraftTab();
                return;
            }

            const star = e.target.closest('.dr-star');
            if (star) {
                // The star is the plan. On files the player into the next open round and off clears whichever plan slot they hold, the same mutation the tray's x runs. The old caution never to clear a round some other way was written when the queue and the plan were different things, and a toggle that only ever set would lie about what its off state means.
                const id = Number(star.dataset.planStar);
                if (planSlotOf(id)) {
                    clearPlanSlotFor(id);
                } else {
                    fillNextEmptyRoundFromStar(id);
                }
                renderDraftTab();
                return;
            }

            const noteToggle = e.target.closest('[data-note-toggle]');
            if (noteToggle) {
                noteEditing = Number(noteToggle.dataset.noteToggle);
                renderDraftTab();
                return;
            }

            const clearTarget = e.target.closest('[data-clear-target]');
            if (clearTarget) {
                plan = removePlanTarget(plan, Number(clearTarget.dataset.clearTarget));
                savePlan();
                renderDraftTab();
                return;
            }

            const clearAlt = e.target.closest('[data-clear-alt]');
            if (clearAlt) {
                plan = setPlanAlternate(plan, Number(clearAlt.dataset.clearAlt), Number(clearAlt.dataset.idx), null);
                savePlan();
                renderDraftTab();
                return;
            }

            const suggest = e.target.closest('[data-use-suggest]');
            if (suggest) {
                plan = setPlanTarget(plan, Number(suggest.dataset.useSuggest), Number(suggest.dataset.player));
                savePlan();
                renderDraftTab();
                return;
            }

            const openPicker = e.target.closest('[data-open-picker]');
            if (openPicker) {
                const round = Number(openPicker.dataset.openPicker);
                const role = openPicker.dataset.role;
                // A second click on the same slot's opener closes it, since the row's set target or alternate control is also its toggle, the picker living in the row.
                targetPicker = (targetPicker && targetPicker.round === round && targetPicker.role === role)
                    ? null : { round, role };
                pickerQuery = '';
                ruleChooserRound = null;
                renderDraftTab();
                return;
            }

            // Plus rule opens the three-way chooser, and a second click or Cancel closes it. Any other picker opener clears the chooser round, so the two cannot both be open on one round.
            const openRuleChooser = e.target.closest('[data-open-rule-chooser]');
            if (openRuleChooser) {
                const round = Number(openRuleChooser.dataset.openRuleChooser);
                ruleChooserRound = ruleChooserRound === round ? null : round;
                renderDraftTab();
                return;
            }
            const closeRuleChooser = e.target.closest('[data-close-rule-chooser]');
            if (closeRuleChooser) {
                ruleChooserRound = null;
                renderDraftTab();
                return;
            }

            // The chooser's three buttons. If gone is a shortcut into the existing alternate picker, since it is the alternates, and opens the next open alternate slot the row's plus alt would. The other two open this row's picker for a two-player build, starting at the first half.
            const ruleKindBtn = e.target.closest('[data-rule-kind]');
            if (ruleKindBtn) {
                const round = Number(ruleKindBtn.dataset.ruleRound);
                const kind = ruleKindBtn.dataset.ruleKind;
                ruleChooserRound = null;
                if (kind === 'ifGone') {
                    const row = ((plan && plan.rounds) || []).find(r => r.round === round);
                    const filled = ((row && row.alternateIds) || []).filter(id => id !== null && id !== undefined).length;
                    targetPicker = { round, role: `alt${Math.min(filled, 1)}` };
                } else if (kind === 'ifIHave') {
                    targetPicker = { round, role: 'rule-have-cond' };
                } else if (kind === 'prefer') {
                    targetPicker = { round, role: 'rule-prefer-a' };
                }
                pickerQuery = '';
                ruleDraft = null;
                renderDraftTab();
                return;
            }

            const removeRuleBtn = e.target.closest('[data-remove-rule]');
            if (removeRuleBtn) {
                plan = removePlanRule(plan, Number(removeRuleBtn.dataset.removeRule), Number(removeRuleBtn.dataset.ruleIdx));
                savePlan();
                renderDraftTab();
                return;
            }

            const pickRow = e.target.closest('[data-pick-player]');
            if (pickRow && targetPicker) {
                const playerId = Number(pickRow.dataset.pickPlayer);
                // The two-player rule roles stage the first pick in the rule draft and move the same picker to the second half rather than closing. The rule is set only once both halves are in hand.
                if (targetPicker.role === 'rule-have-cond') {
                    ruleDraft = playerId;
                    targetPicker = { round: targetPicker.round, role: 'rule-have-then' };
                    pickerQuery = '';
                    renderDraftTab();
                    return;
                }
                if (targetPicker.role === 'rule-have-then') {
                    plan = setPlanRule(plan, targetPicker.round, { kind: 'ifIHave', playerId: ruleDraft, thenId: playerId });
                    savePlan();
                    targetPicker = null;
                    ruleDraft = null;
                    renderDraftTab();
                    return;
                }
                if (targetPicker.role === 'rule-prefer-a') {
                    ruleDraft = playerId;
                    targetPicker = { round: targetPicker.round, role: 'rule-prefer-b' };
                    pickerQuery = '';
                    renderDraftTab();
                    return;
                }
                if (targetPicker.role === 'rule-prefer-b') {
                    plan = setPlanRule(plan, targetPicker.round, { kind: 'prefer', aId: ruleDraft, bId: playerId });
                    savePlan();
                    targetPicker = null;
                    ruleDraft = null;
                    renderDraftTab();
                    return;
                }
                plan = targetPicker.role === 'target'
                    ? setPlanTarget(plan, targetPicker.round, playerId)
                    : setPlanAlternate(plan, targetPicker.round, Number(targetPicker.role.slice(3)), playerId);
                savePlan();
                targetPicker = null;
                renderDraftTab();
                return;
            }

            const pickerClose = e.target.closest('[data-close-picker]');
            if (pickerClose) {
                targetPicker = null;
                ruleDraft = null;
                renderDraftTab();
                return;
            }

            // Arming is a click on the row itself. It opens the same target picker or closes it on a second click. It is checked last of the plan's handlers, so a click on a control above has already returned.
            const armRound = e.target.closest('[data-arm-round]');
            if (armRound) {
                const round = Number(armRound.dataset.armRound);
                targetPicker = (targetPicker && targetPicker.round === round && targetPicker.role === 'target')
                    ? null : { round, role: 'target' };
                pickerQuery = '';
                renderDraftTab();
                return;
            }

            const rehearse = e.target.closest('#dr-plan-rehearse');
            if (rehearse) {
                // The same request a Rehearse click makes, so Rehearse this plan is refused the identical way when Log picks holds a pick, two doors into one state with one rule between them.
                applySwitchRequest('rehearse', true);
                if (switchRefused) { renderDraftTab(); return; }
                ensurePlan();
                planRehearsal = true;
                const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
                const d = mockDefaults();
                mockSetup = {
                    slot: plan.slot || ownSlot() || 1,
                    rounds: planRoundCount(teams) || d.rounds,
                    variance: d.variance,
                    seed: d.seed
                };
                startMock();
                mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
                autoAdvancePlanPicks();
                activeFace = MOCK_DRAFT;
                renderDraftTab();
                return;
            }

            // Every empty round takes the same suggestion the ghost row offered, from one whole-plan call rather than one per round, which offered the same player twice.
            const fillOpen = e.target.closest('#dr-plan-fill');
            if (fillOpen) {
                fillOpenRounds();
                renderDraftTab();
                return;
            }

            const clearBtn = e.target.closest('#dr-plan-clear');
            if (clearBtn) {
                clearPlan();
                renderDraftTab();
                return;
            }

            // The room's Draft push, one button reached from the Actions cell or Board says. It sends the one message and nothing else, and the render only paints the pending mark already set.
            const roomDraft = e.target.closest('[data-room-draft]');
            if (roomDraft) {
                draftToRoom(Number(roomDraft.dataset.roomDraft));
                renderDraftTab();
                return;
            }

            // A row's Taken button logs the pick against whichever team the strip's select names, read live and not held as separate state.
            const taken = e.target.closest('[data-log]');
            if (taken) {
                const teamSelect = container.querySelector('#dr-log-team');
                logPick(Number(taken.dataset.log), teamSelect ? Number(teamSelect.value) : null);
                renderDraftTab();
                return;
            }

            const undo = e.target.closest('#dr-log-undo');
            if (undo) {
                undoLog();
                renderDraftTab();
                return;
            }

            // The File and Add to plan button handled here is gone. The star files a player through the next-open-round function directly.
        });

        // The picker's search redraws only its result list, as the board's search redraws only its rows, since a full render mid-keystroke would throw away the input and its caret.
        container.addEventListener('input', (e) => {
            if (e.target.id === 'dr-plan-picker-input' && targetPicker) {
                pickerQuery = e.target.value;
                const results = container.querySelector('#dr-plan-picker-results');
                if (results) results.innerHTML = ledgerPickerResultsHtml(planPool());
            }
        });

        // Escape disarms, the same close a second click on the row or its Close button does, from the keyboard anywhere focus is inside the tray, the picker's search included. It is bound once, inside the same guard as the click and input listeners.
        container.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && (targetPicker || ruleChooserRound !== null)) {
                targetPicker = null;
                ruleDraft = null;
                ruleChooserRound = null;
                renderDraftTab();
            }
        });
    }

    // A row's Draft control goes through the same path the banner's does, so undo covers it as it covers a spotlight pick, with one stack and one history.
    container.querySelectorAll('.dm-rowdraft').forEach(btn => {
        btn.addEventListener('click', () => {
            draftForUser(Number(btn.dataset.draft));
            spotlightId = null;
            renderDraftTab();
        });
    });

    // The headshots are lazy, so this only wires what is drawn.
    wirePlayerAvatars(container);

    // A no-op on every face but the results board, and cheap enough to call unconditionally rather than thread a flag through the render just to skip it.
    fitDraftResultsBoard(container);
    fitRostersFace(container);
    syncResultsFade(container);
    wireDraftTeamPages(container);
    // A no-op wherever there is no results card, and fire and forget so the synchronously coloured cards already on screen are never held up by however long the logos take to load.
    dyeDraftResultCards(container);
    // The Take or wait badge carries its reasoning as a tooltip and not a face caption. The fit measures the widest badge actually drawn before the tooltip listeners are attached, so the column never reserves more than the real content needs.
    fitOverNextColumn(container);
    fitSidebarPosColumn(container);
    fitFixedBoardColumns(container);
    // BEFORE fitLiveBoardCategories: the tray's own final width (grown or left at rest) is part of what the board has left to fit categories INTO, so the category pass has to read it after this one settles, never before.
    fitPlanTrayWidth(container);
    // Runs AFTER fitOverNextColumn (its own comment) so the reserved-width sum below counts the Take-or-wait column's real, already-compacted width.
    fitLiveBoardCategories(container);
    // The tray-open pass truncates, while solo width widens each category to its widest rendered value and never cuts a number.
    fitCollapsedBoardCategories(container);
    // The scroll hint is a hint only while there is something to scroll to.
    const scrollBox = container.querySelector('.dr-scroll');
    if (scrollBox) scrollBox.classList.toggle('dr-scroll-fits', scrollBox.scrollWidth <= scrollBox.clientWidth + 1);
    attachDataTooltips(container);

    const search = container.querySelector('#draft-search');
    if (search) search.addEventListener('input', () => { poolSearch = search.value; redrawRows(); });

    // A position pill can unlight the last lit position of its group, which drops that group's columns as well as its rows. That needs a full render, the old group pill's path, and the rows-only redraw would leave a stale header over the redrawn body.
    container.querySelectorAll('.dr-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const pos = pill.dataset.pos;
            if (disabledPositions.has(pos)) disabledPositions.delete(pos); else disabledPositions.add(pos);
            renderDraftTab();
        });
    });
}
