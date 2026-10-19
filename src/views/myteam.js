/**
 * My Team: a roster viewer that defaults to the signed-in user's own team and can show any other team in the
 * league. It renders the summary band, the role-grouped roster tables, the Schedule and calendar faces, the
 * category coverage band and the comparison against one opponent.
 *
 * Nothing here forks the engines. Ranks come from the Player Metrics pool ranking and the category profile
 * from the Team Metrics heatmap's aggregation.
 *
 * @module myteam
 */

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, leagueInverseIds, RATE_COMPONENTS, NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_ORDER, LINEUP_SLOT_LABELS, SLOT_POSITION_MAPS, POSITION_MAPS, nonStartingLabels } from '../data/state.js';
import { seasonState, SEASON_STATE, isPreseason, seasonIsFinished } from '../data/season-state.js';
import { MIN_MATCHUPS_FOR_A_LINE, escapeHtml, getTimeframeBounds, parseTimeframe, axisUnit, attachDataTooltips, splitStatIdsByRole, injuryBadgeHtml, playerPoolErrorText, registerLeagueView, setDebugContext, readsAsPlayedMatchup, displayTeamName, teamNameTitle, weekOfPeriod, surnameOf, draftedFactText, scheduledOpponentOf } from './utils.js';
import { standingsSeries } from '../engines/standings-movement.js';
import { sparklinePoints } from './sparkline.js';
import { buildPlayerAvatarHtml, buildProTeamCrestHtml, wirePlayerAvatars, isAllowedLogoUrl } from './images.js';
import { rosterRankLookup, openPlayerDetail, playerRoleGroups, matchesPlayerGroup, effectivePlayerPool, loadPlayerTabIfNeeded, matchupPeriodMap, periodsOfMatchup, ensureWeeklyDataForTimeframe, weeklyDataPending, revalidateStalePoolIfDue, groupLabel as roleGroupLabel, formatStatValue, draftPicksFor, ensureDraftPicks, isFullSeasonTimeframe, clubShotVolume, clubEdgesForGame, clubEdgeTable, clubEdgeStatus } from './players.js';
import { fetchRosterForPeriod, fetchProTeamSchedules, fetchScoreboardOdds, invalidateStoredProSchedule, finalScoringPeriodOf } from '../data/api.js';
import { buildGamePeriodIndex, buildProTeamAbbrevs, currentMatchupWindow, countProjectedStarts, buildOddsIndex, moneylineFor, datesByScoringPeriod, dayLabelerFor } from '../engines/probables.js';
// The schedule-insight helpers take the matchup's own days and never the league's matchupPeriods field, which maps to week indices rather than scoring periods. Contract in tests/fixtures/schedule-insight.md.
import { twoStartPitchers, gamesByProTeamForMatchup, matchupWindow, nextGameOf } from '../engines/schedule-insight.js';
import { coverageBand, idsToSum, sumPlayers, rankAdds, dropLedger } from '../engines/coverage-model.js';
// remainderLine is the single derivation of what is still expected, so every forward-looking figure on this tab sums the same base.
import { remainderLine, expectedAppearances, projectedRotoStandings } from '../engines/projected-basis.js';
import { leagueMargins } from '../engines/matchup-rank.js';
import { rosterNightCoverage } from '../engines/schedule-insight.js';
import { buildNightSchedule } from '../engines/night-schedule.js';
import { startingSlotsByGroup } from '../engines/draft-engine.js';
import { buildCoverageStripHtml, buildCoverageDrawerHtml, buildCoverageDrawerHeadHtml } from './coverage-band.js';
import { buildProfileRibbonHtml } from './profile-ribbon.js';
import {
    teamOffence, offenceStrength, offenceBreakdown, startDifficulty, difficultyLabel, daysBetween, isSidelined,
    SHORT_REST_ADJUSTMENT, SHORT_REST_DAYS, MLB_PARK_FACTORS, goalieNightDifficulty
} from '../engines/matchup-difficulty.js';
import { GAMES_PLAYED_IDS, competitionRanks, formatRank, rotoPointsForCategory } from '../engines/rank-engine.js';
import { teamCategoryProfile, buildFormStreakHtml } from './graphs.js';
import { teamCompare, startStrip, categoryWeights } from '../engines/team-compare.js';
import { buildTeamCompareHtml, buildFacePillHtml } from './team-compare-band.js';
import { matchupFace } from '../data/matchup-face.js';

// Which team the tab is showing, remembered per league so scouting another roster survives a tab switch but never leaks into the next league fetched.
let viewedTeamKey = null;
let viewedTeamId = null;
// True while the tab is showing a team it picked for want of a better answer, rather than one the SWID matched or the user chose. Only a stand-in may be replaced automatically.
let viewedTeamIsStandIn = false;
// Per-group sort, one category at a time: { statId, dir } or null for the roster's own slot order. Kept per role so sorting the batters never disturbs how the pitchers read.
let groupSort = { primary: null, secondary: null };
// Which face the pitching group shows, its category table or the matchup laid out by day. Only pitchers have scheduled starts to lay out.
let pitchingView = 'categories';
// One categories-or-schedule state per role group, because hockey and baseball batters each have a calendar face of their own and a group cannot share a switch with another.
let calendarView = { primary: 'categories', secondary: 'categories' };
// The shared page for an index-based calendar, read by whichever of the sport's two role groups is open. One variable serves both because only one sport is active at a time. Baseball's batters page with the pitchers' calendar instead.
let indexCalPage = null;
// The start whose scoring is open below the calendar, as `${playerId}:${period}`. One at a time, the same way the drill-down explains one rank pool at a time rather than all of them at once.
let openStartKey = null;
// Which component of the open start shows its evidence, 'lineup' or 'park', or null for the card itself. It joins the one-at-a-time stack the calendar and the breakdown share.
let openStartDrill = null;
// Two columns that are not ESPN stat ids, the fantasy points a points league scores by and the sortable rank chip.
const POINTS_COL = '__points__';
const RANK_COL = '__rank__';
// Projected starts is a pseudo-column too. It is counted from the probables feed against the pro schedule and exists only for pitchers.
const STARTS_COL = '__starts__';
const GAMES_COL = '__games__';
// Real line breaks in a data-hint, which the hint tooltip renders via white-space: pre-line.
const NEWLINE = String.fromCharCode(10);

// The club edge on a hockey schedule chip uses the thresholds the validation document measured. A club needs a minimum number of games to be ranked, and a bar is tinted only when both clubs have enough games and the gap clears its threshold. An untinted bar is still drawn.
const CLUB_EDGE_MIN_GAMES = 2;
const CLUB_EDGE_TINT_GAMES = 20;
const CLUB_EDGE_FULL = { shots: 6.21, shotsFaced: 6.21, goals: 1.0 };
const CLUB_EDGE_LABEL = { shots: 'Shots', goals: 'Goals', shotsFaced: 'Shots faced' };
function clubEdgeTone(e) {
    if (e.key === 'goals') return Math.abs(e.gap) >= 0.5 ? (e.gap > 0 ? 'good' : 'bad') : null;
    return e.gap >= 1.11 ? 'good' : (e.gap <= -1.28 ? 'bad' : null);
}
function clubEdgeNumber(v, key) { return Number(v).toFixed(key === 'goals' ? 2 : 1); }
function clubEdgeSigned(v, key) { const n = Number(v); return `${n > 0 ? '+' : (n < 0 ? '-' : '')}${Math.abs(n).toFixed(key === 'goals' ? 2 : 1)}`; }

// The Schedule face starts the weekly harvest itself, once per league load, because it opens without a club table. It waits for the pool so the once-only mark cannot swallow a call that would do nothing.
let clubHarvestAskedFor = null;
function startClubHarvestOnce(sport) {
    if (!AppState.playerDataLoaded || clubHarvestAskedFor === AppState.apiData) return;
    clubHarvestAskedFor = AppState.apiData;
    if (clubEdgeTable({ minGames: 1 })) return;
    ensureWeeklyDataForTimeframe(sport);
}
// Half-width of the park bars' scale in run-index points, derived from the shipped park table so a refresh that moves the extreme moves the scale.
const PARK_INDEX_SPAN = Math.max(...Object.values(MLB_PARK_FACTORS).map(p => Math.abs(p[0] - 100)));
// A finished season's last lineup, fetched once per league. The payload carries current rosters only while a matchup is live, so this is what makes the tab work after a season ends. ESPN still serves the final scoring period's rosters, which IS the team as it stood for the last matchup.
let finalRosters = { key: null, byTeam: null, state: 'idle' };
// The pro schedule behind projected starts, fetched once per league and rendered into when it lands. A failure only means the line does not render. proTeams is held beside the derived index because the schedule helpers want the raw array.
let proSchedule = { key: null, index: null, abbrevs: null, proTeams: null, state: 'idle' };
// The day's betting lines, fetched the same fire-and-forget way. Odds exist only for the current slate, so a miss is the ordinary case.
let scoreboardOdds = { key: null, index: null, state: 'idle' };
// The column widths chosen for a roster at a viewport. Deliberately NOT keyed on the timeframe: switching windows changes the VALUES (a full-season 0.947 against a single matchup's dash) and re-measuring those resized the whole table on every pill click. Widths may only ever GROW within a key, so entering a wider window still cannot clip, and the table never shrinks back.
let lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
// Column widths measured with both tables showing, kept with their roster so a render with one group on its Schedule face can replay them instead of measuring half the picture.
let heldColumnFit = null;
// The row-height correction from the last render where both groups' categories tables were on screen. A group on its Schedule face has no table to measure, so the fit is held rather than recomputed, and keyed so a team switch, league switch or resize starts fresh.
let lastRosterFit = { key: null, rowH: null, gap: null, batH: null, pitchH: null };

// One drawer width for all four adds modes, the wide one, so the drawer does not narrow when the render has no adds table to measure. Keyed like the row fit and applied only after a render has measured a real table.
let lastCoverageDrawerWidth = { key: null, width: null };

// The pool arriving is the other half of the league switch. processCoreData renders this tab as soon as the league payload commits, which is well before the player pool it needs. Guarded on the tab being on screen, since rendering a hidden view measures zero and would only be thrown away.
document.addEventListener('leaguewise:player-pool-ready', () => {
    const view = document.getElementById('view-myteam');
    if (view && view.style.display !== 'none') renderMyTeamTab();
});

// The windowed lines need the weekly rows, which arrive well after the pool does. Same guard and same reasoning as the listener above.
document.addEventListener('leaguewise:weekly-data-ready', () => {
    const view = document.getElementById('view-myteam');
    if (view && view.style.display !== 'none') renderMyTeamTab();
});

/**
 * Clears the held column widths, row-height fit and coverage drawer width, so a resize, league swap or hidden
 * tab measures fresh.
 * @returns {void}
 */
export function invalidateMyTeamLayout() {
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    lastRosterFit = { key: null, rowH: null, gap: null, batH: null, pitchH: null };
    lastCoverageDrawerWidth = { key: null, width: null };
}

// Registered rather than called from the fetch path. The scouted team belongs to the league that was on screen, so a new league starts on its own team again.
registerLeagueView('myteam', { reset: resetMyTeamView, revalidate: invalidateProSchedule });

/**
 * Clears everything the tab remembers about the team on screen, so a new league starts on its own team with
 * no carried sort, face, pin or held fit.
 * @returns {void}
 */
export function resetMyTeamView() {
    viewedTeamKey = null;
    viewedTeamId = null;
    viewedTeamIsStandIn = false;
    groupSort = { primary: null, secondary: null };
    pitchingView = 'categories';
    calendarView = { primary: 'categories', secondary: 'categories' };
    indexCalPage = null;
    openStartKey = null;
    openStartDrill = null;
    finalRosters = { key: null, byTeam: null, state: 'idle' };
    proSchedule = { key: null, index: null, abbrevs: null, proTeams: null, state: 'idle' };
    scoreboardOdds = { key: null, index: null, state: 'idle' };
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    lastRosterFit = { key: null, rowH: null, gap: null, batH: null, pitchH: null };
    // The widths live on the container as inline custom properties and the container outlives every render, so clearing the module's memory alone leaves the previous league's widths on screen. A switch has to clear them as a fresh load would.
    const container = document.getElementById('myteam-container');
    if (container) {
        ['--mt-player-w', '--mt-pos-w', '--mt-stat-w'].forEach(n => container.style.removeProperty(n));
    }
}

// The matchup chance's model for the team on screen, kept for the team, matchup, day and harvest size it was asked about. The storage key the model's record lives under is one for the whole extension.
let matchupFaceState = { key: null, model: null };
const MATCHUP_FACE_STORE_KEY = 'matchupOddsRecord';

/**
 * Assembles matchup-face.js's inputs from what the app already holds and asks it for the chance, once per
 * team, matchup, day and harvest size. Returns the model when it is in hand and null while it is asked or when
 * an input is missing; the render that asked is repeated when the answer lands. The model records the day's
 * prediction through the verbs it is handed; this function and the band never touch storage themselves.
 *
 * @param {object} team The team on screen.
 * @returns {?object} The model, or null.
 */
function ensureMatchupFace(team) {
    const payload = AppState.apiData;
    const pool = debugContextFor('player-pool');
    const proTeams = proSchedule.proTeams;
    const map = matchupPeriodMap();
    if (!payload || !payload.status || !team || !pool || !proTeams || !map || !AppState.loadedSport) return null;
    const weekly = debugContextFor('player-weekly');
    const weeklyHeld = ((weekly && weekly.players) || []).length;
    const key = [payload.id, payload.seasonId, team.id, payload.status.currentMatchupPeriod, payload.status.latestScoringPeriod, weeklyHeld].join(':');
    if (matchupFaceState.key === key) return matchupFaceState.model;
    matchupFaceState = { key, model: null };
    let daily = null;
    if (weeklyHeld) {
        daily = new Map();
        weekly.players.forEach(entry => {
            const player = (entry && entry.player) || {};
            const table = daily.get(player.id) || {};
            (player.stats || []).forEach(line => {
                if (line.statSplitTypeId !== 5 || line.statSourceId !== 0 || !line.scoringPeriodId || line.seasonId !== payload.seasonId) return;
                const day = table[line.scoringPeriodId] || (table[line.scoringPeriodId] = {});
                if (AppState.isPointsLeague) {
                    const points = Number(line.appliedTotal);
                    if (Number.isFinite(points)) day.points = (day.points || 0) + points;
                    return;
                }
                Object.keys(line.stats || {}).forEach(id => { const v = Number(line.stats[id]); if (Number.isFinite(v)) day[id] = (day[id] || 0) + v; });
            });
            daily.set(player.id, table);
        });
    }
    const store = typeof browser !== 'undefined' && browser.storage && browser.storage.local ? browser.storage.local : null;
    const verbs = {
        readStore: async () => { if (!store) return null; const got = await store.get(MATCHUP_FACE_STORE_KEY); return got ? got[MATCHUP_FACE_STORE_KEY] : null; },
        writeStore: async (next) => { if (store) await store.set({ [MATCHUP_FACE_STORE_KEY]: next }); }
    };
    matchupFace({
        payload, teamId: team.id, sport: AppState.loadedSport, pool, proSchedule: { settings: { proTeams } },
        dayLinesOf: daily ? (id => daily.get(id) || null) : null, matchupMap: map,
        read: { tallyOf: matchupTally, pointsOf: matchupPoints }, asOf: new Date().toISOString()
    }, verbs).then(model => {
        if (matchupFaceState.key !== key) return;
        matchupFaceState = { key, model };
        renderMyTeamTab();
    }).catch(() => { /* a model that could not be built leaves the band as it was */ });
    return null;
}

// The weekly harvest the face needs, asked for once per league load and only while the compare drawer is open, when a placed player of either team has no weekly lines yet. It is the pipeline Player Metrics runs, at its existing size.
let faceHarvestAskedFor = null;
let faceHarvestPolling = false;

/**
 * Starts the weekly harvest when the two teams' players are not all in it, and re-renders the tab once it lands.
 * Nothing is asked while the drawer is closed, and nothing is asked a second time for the same league load.
 *
 * @param {object} team The team on screen.
 * @param {?(number|string)} opponentId The opponent the drawer shows.
 * @param {boolean} drawerOpen True while the compare drawer is open.
 * @returns {void}
 */
function driveFaceHarvest(team, opponentId, drawerOpen) {
    if (!drawerOpen || !AppState.playerDataLoaded || !AppState.loadedSport || opponentId == null) return;
    if (faceHarvestAskedFor === AppState.apiData) return;
    const teams = (AppState.apiData && AppState.apiData.teams) || [];
    const opponent = teams.find(t => String(t.id) === String(opponentId));
    const ids = [team, opponent].filter(Boolean).flatMap(t => ((t.roster && t.roster.entries) || []).map(e => e.playerId));
    const totals = new Map((AppState.playerData || []).map(p => [p.id, Object.keys(p.seasonTotals || {}).length > 0]));
    const short = ids.some(id => totals.get(id) && !AppState.playerWeeklyCache[id]);
    if (!short) return;
    faceHarvestAskedFor = AppState.apiData;
    ensureWeeklyDataForTimeframe(AppState.loadedSport);
    if (faceHarvestPolling) return;
    faceHarvestPolling = true;
    const poll = setInterval(() => {
        if (weeklyDataPending()) return;
        clearInterval(poll);
        faceHarvestPolling = false;
        renderMyTeamTab();
    }, 1500);
}

// The model, but only when it is about the opponent the drawer is showing: the chance belongs to the matchup being played, and the drawer can compare against any team.
function faceFor(model, opponentId) {
    // While the harvest the face asked for is arriving the chance is not given: a blank pill with its mark, no bars.
    if (faceHarvestPolling) return { refusal: null, odds: null, shows: null, marks: { fallback: [], leftOut: [] }, matchup: { theirs: opponentId } };
    if (!model || model.refusal || !model.matchup) return null;
    return String(model.matchup.theirs) === String(opponentId) ? model : null;
}

// The pro schedule is fetched once per sport and season and held, so dropping the local key is not enough. Both the local copy and the stored copy are dropped, and the index stays on screen until the new one replaces it wholesale.
function invalidateProSchedule() {
    proSchedule = { key: null, index: null, abbrevs: null, proTeams: null, state: 'idle' };
    invalidateStoredProSchedule();
}

// Fire-and-forget, guarded by league key and state so a tab switch or timeframe click never starts a second one. The index is built once here rather than per render, since it is 2456 games.
function ensureProSchedule(key) {
    if (proSchedule.key === key && proSchedule.state !== 'idle') return;
    proSchedule = { key, index: null, dates: null, abbrevs: null, proTeams: null, state: 'loading' };
    fetchProTeamSchedules().then(data => {
        if (proSchedule.key !== key) return;
        proSchedule = {
            key,
            index: data ? buildGamePeriodIndex(data) : null,
            // Kept beside the index so the games column can name a day without walking the payload again.
            dates: data ? datesByScoringPeriod(data) : null,
            abbrevs: data ? buildProTeamAbbrevs(data) : null,
            proTeams: (data && data.settings && data.settings.proTeams) || null,
            state: 'done'
        };
        renderMyTeamTab();
    }).catch(() => {
        if (proSchedule.key === key) { proSchedule = { key, index: null, dates: null, abbrevs: null, proTeams: null, state: 'done' }; }
    });
}

// Same shape as ensureProSchedule, one call per league, rendering again when it lands. A failure means no card carries a line. It stays out of the fit's completeness gate because odds decorate a few cards and the tab should not wait on them.
function ensureScoreboardOdds(key) {
    // The request itself is gated, not just the display. Opting out means the extension never asks ESPN for a betting line in the first place.
    if (!AppState.showBettingOdds) return;
    if (scoreboardOdds.key === key && scoreboardOdds.state !== 'idle') return;
    scoreboardOdds = { key, index: null, state: 'loading' };
    fetchScoreboardOdds().then(data => {
        if (scoreboardOdds.key !== key) return;
        scoreboardOdds = { key, index: data ? buildOddsIndex(data) : null, state: 'done' };
        renderMyTeamTab();
    }).catch(() => {
        if (scoreboardOdds.key === key) { scoreboardOdds = { key, index: null, state: 'done' }; }
    });
}

// The period to ask for when the payload has none: the season's own final scoring period, falling back to the latest one it reports. Both come off the payload's status block, the same fields data.js reads to decide whether a season is over.
function finalPeriodOf(apiData) {
    const st = (apiData || {}).status || {};
    return st.finalScoringPeriod || st.latestScoringPeriod || null;
}

// Fire-and-forget: kicks the one call, then re-renders when it lands. Guarded by league key and by state, so a tab switch or a timeframe click never starts a second one.
function ensureFinalRosters(key, apiData) {
    if (finalRosters.key === key && finalRosters.state !== 'idle') return;
    const period = finalPeriodOf(apiData);
    if (!period) { finalRosters = { key, byTeam: new Map(), state: 'done' }; return; }
    finalRosters = { key, byTeam: null, state: 'loading' };
    fetchRosterForPeriod(period).then(teams => {
        if (finalRosters.key !== key) return;
        const byTeam = new Map();
        (teams || []).forEach(t => byTeam.set(t.id, (t.entries || []).map(e => ({ playerId: e.p, lineupSlotId: e.slot }))));
        finalRosters = { key, byTeam, state: 'done' };
        renderMyTeamTab();
    }).catch(() => {
        if (finalRosters.key === key) { finalRosters = { key, byTeam: new Map(), state: 'done' }; renderMyTeamTab(); }
    });
}

// Re-exported from utils.js, where it moved so other views can use it without an import cycle.
import { findOwnedTeamId, resolveMyTeamId, roleIdSetFor } from './utils.js';
import { matchupTally, matchupPoints, debugContextFor } from './utils.js';
export { findOwnedTeamId };

/**
 * Splits a roster into the starters, bench and injured reserve bands the tab draws. Starters follow the
 * league's own slot order, and a slot with no known order is appended by id so an unfamiliar roster still
 * lists every player.
 *
 * Pure. Slots the league does not roster are skipped, and an entry in a slot the league does not roster at
 * all is returned as an orphan.
 * @param {Array<{playerId: number, lineupSlotId: number}>} entries The roster entries.
 * @param {string} sport The sport key, used to look up slot order and the bench and injury slots.
 * @param {Object<string, number>} [counts] The league's lineupSlotCounts, keyed by slot id.
 * @returns {{starters: Array<{slot: number, playerId: number}>, bench: Array<{slot: number, playerId: number}>, injured: Array<{slot: number, playerId: number}>, orphans: Array<{slot: number, playerId: number}>}} The four bands.
 */
export function buildRosterGroups(entries, sport, counts = {}) {
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const order = LINEUP_SLOT_ORDER[sport] || [];
    const rostered = new Set(Object.keys(counts).filter(k => counts[k] > 0).map(Number));

    const startingSlots = [...new Set([
        ...order.filter(s => rostered.has(s) && !bench.has(s)),
        ...[...rostered].filter(s => !bench.has(s) && !order.includes(s)).sort((a, b) => a - b)
    ])];

    const bySlot = new Map();
    (entries || []).forEach(e => {
        const slot = e.lineupSlotId;
        if (!bySlot.has(slot)) bySlot.set(slot, []);
        bySlot.get(slot).push(e);
    });

    const rows = (slot) => (bySlot.get(slot) || []).map(e => ({ slot, playerId: e.playerId }));
    const starters = startingSlots.flatMap(rows);
    // Bench and IR keep ESPN's own ids apart so an injured player never reads as a healthy scratch.
    const benchIds = [...bench].sort((a, b) => a - b);
    const benched = benchIds.length ? rows(benchIds[0]) : [];
    const injured = benchIds.length > 1 ? benchIds.slice(1).flatMap(rows) : [];
    // Anything in a slot the league does not roster at all still belongs to somebody.
    const placed = new Set([...starters, ...benched, ...injured].map(r => `${r.slot}:${r.playerId}`));
    const orphans = (entries || [])
        .filter(e => !placed.has(`${e.lineupSlotId}:${e.playerId}`))
        .map(e => ({ slot: e.lineupSlotId, playerId: e.playerId }));

    return { starters, bench: benched, injured, orphans };
}

/**
 * Reads the current roster of every team off the league payload itself.
 *
 * Pure. The schedule sides carry the roster for the period being served and win where they exist. Otherwise
 * each team's own roster is used. A league that has not drafted returns nothing, because ESPN carries last
 * season's roster forward until the draft.
 * @param {Object} apiData The league payload.
 * @returns {Map<number, Array<{playerId: number, lineupSlotId: number}>>} Entries by team id, empty when the season is over, the week has no games or the league has not drafted.
 */
export function rostersFromPayload(apiData) {
    const out = new Map();
    if (seasonState(apiData) === SEASON_STATE.PRE_DRAFT) return out;

    ((apiData || {}).schedule || []).forEach(game => {
        ['home', 'away'].forEach(side => {
            const s = game[side];
            const entries = ((s || {}).rosterForCurrentScoringPeriod || {}).entries;
            if (!s || !entries || !entries.length) return;
            // The LAST matchup period wins for a team that appears more than once, which is the current one. ESPN only attaches this to the period it is serving.
            out.set(s.teamId, entries.map(e => ({ playerId: e.playerId, lineupSlotId: e.lineupSlotId })));
        });
    });
    if (out.size) return out;

    ((apiData || {}).teams || []).forEach(team => {
        const entries = ((team || {}).roster || {}).entries;
        if (!team || !entries || !entries.length) return;
        out.set(team.id, entries.map(e => ({ playerId: e.playerId, lineupSlotId: e.lineupSlotId })));
    });
    return out;
}

function slotLabel(sport, slot) {
    // Uses the shared slot-name convention so this tab and the pre-draft ground name a seat the same way.
    const nonStarting = nonStartingLabels(sport);
    if (nonStarting[slot]) return nonStarting[slot];
    // The validated display-label catalog carries every starting slot, hockey's included, plus the roster-status slots the position map leaves out because it decodes eligibility rather than display. The position map stays as a fallback for finer slot granularity.
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    if (labels[slot]) return labels[slot];
    const map = SLOT_POSITION_MAPS[sport] || {};
    return map[slot] || String(slot);
}

// A league that has drafted but not played has no season line, so the roster reads its projected line under the same preseason tag Team Metrics wears. The season state alone decides this and no surface re-derives it.
function projectedBasis() {
    return seasonState(AppState.apiData) === SEASON_STATE.PRESEASON;
}

function basisTotalsOf(player) {
    if (!player) return {};
    return (projectedBasis() ? player.projectedTotals : player.seasonTotals) || {};
}

function teamById(id) {
    return AppState.teamStats.find(t => t.id === id) || null;
}

// The team's record or roto total, and where that places it. Same ordering the standings bars use, so the number here and the bar there can never disagree.
function teamStandingLine(team) {
    // No games means no record. Before play every team sums to 0-0-0 and would rank tied for first, asserting a result nobody has. The projected standing belongs to Team Metrics and a view does not import another view, so this says nothing. The check also covers a league that has not drafted yet.
    if (isPreseason(seasonState(AppState.apiData))) return null;
    if (AppState.isRotoLeague) {
        const ranked = [...AppState.teamStats].sort((a, b) => b.rotoPoints - a.rotoPoints);
        // Shared competition ranking, so two teams on the same points read as tied rather than being ordered by sort.
        const ranks = competitionRanks(ranked.map(t => t.rotoPoints));
        const rank = ranks[ranked.findIndex(t => t.id === team.id)];
        return { value: `${team.rotoPoints} pts`, rank, ranks, of: ranked.length, label: 'Roto Points' };
    }
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const summarize = (t) => {
        let w = 0, l = 0, ties = 0, pts = 0;
        for (let wk = start; wk <= end; wk++) {
            const mw = t.weeklyMatchWins[wk];
            if (mw === undefined) continue;
            if (AppState.isPointsLeague) pts += mw;
            // A playoff bye is not a game. Its points count and its non-result does not.
            if (t.weeklyBye?.[wk]) continue;
            // A week with no result is not a loss. In a points league the weekly win value holds points, so the result comes from the separate result field, which is withheld for an unplayed week. Treating that absence as zero read an unplayed league as 0-1-0.
            const result = AppState.isPointsLeague ? t.weeklyMatchResult[wk] : mw;
            if (result === undefined) continue;
            if (result === 1) w++; else if (result === 0.5) ties++; else l++;
        }
        return { w, l, ties, pts, wins: w + ties * 0.5 };
    };
    const rows = AppState.teamStats.map(t => ({ id: t.id, ...summarize(t) }))
        .sort((a, b) => (b.wins - a.wins) || (b.pts - a.pts));
    const mine = rows.find(r => r.id === team.id) || { w: 0, l: 0, ties: 0, pts: 0 };
    // The comparison key is the same pair the sort above uses, so the ranks agree with the order.
    const ranks = competitionRanks(rows.map(r => `${r.wins}|${r.pts}`));
    const rank = ranks[rows.findIndex(r => r.id === team.id)];
    const value = AppState.isPointsLeague
        ? `${mine.w}-${mine.l}-${mine.ties} - ${mine.pts.toFixed(1)} pts`
        : `${mine.w}-${mine.l}-${mine.ties}`;
    return { value, rank, ranks, of: rows.length, label: AppState.isPointsLeague ? 'Record and points' : 'Record' };
}

// "82nd percentile" reads as a measured fact; graphs.js/draft-view.js/leaderboard-row.js/ seasons-band.js each keep this same local copy rather than sharing one export.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// The place-by-matchup sparkline beside the record. It reuses the standings-movement series and the sparkline path helper rather than re-deriving a place or a curve, and only builds the chart's chrome. Roto is excluded because a roto league has no per-matchup schedule to draw.
function buildPlaceSparkHtml(team, teams, scoring) {
    if (scoring === 'roto') return '';
    // The series runs through the last settled matchup, since the one being played has partial points and swapped two teams' places on a points league. Zero or unset means no bound.
    const series = standingsSeries(teams, { scoring, through: AppState.maxCompletedWeek || null });
    const places = series.places[String(team.id)] || [];
    const presentPlaces = places.filter(p => p !== null && p !== undefined);
    // A line needs the minimum number of settled matchups the drill-down and the Team Metrics filters already use. The matchup being played is partial and would draw flat, so under that count the box is drawn grey with its axis and no line, and it lights when the second matchup settles.
    const live = Number(AppState.currentMatchup) || 0;
    const settled = series.matchups.filter(m => live <= 0 || m < live).length;
    if (settled < MIN_MATCHUPS_FOR_A_LINE || presentPlaces.length < 2) {
        const tip = 'The place line starts once two matchups are settled';
        return `
        <span class="mt-place-spark mt-place-spark-idle">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
                <rect x="0.5" y="0.5" width="99" height="39" rx="3" class="mt-spark-idle-box"></rect>
                <text x="2" y="9" class="mt-spark-axis">${escapeHtml(ordinal(1))}</text>
                <text x="2" y="38" class="mt-spark-axis">${escapeHtml(ordinal(Math.max(teams.length, 2)))}</text>
                <rect x="0" y="0" width="100" height="40" class="mt-spark-hit" data-tooltip="${escapeHtml(tip)}"></rect>
            </svg>
        </span>`;
    }
    const everyPlace = Object.values(series.places).flat().filter(p => p !== null && p !== undefined);
    const maxPlace = Math.max(...everyPlace);
    // Inverted so first place reads at the top. The sparkline helper puts the highest value at the top and first place is the lowest number, so it is handed the place subtracted from maxPlace plus one.
    const inverted = places.map(p => (p === null || p === undefined) ? null : (maxPlace + 1 - p));
    const pts = sparklinePoints(inverted);
    if (!pts) return '';

    const n = inverted.length;
    const xAt = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
    const presentIdx = inverted.map((v, i) => ({ i, v })).filter(p => p.v !== null && p.v !== undefined);
    const vs = presentIdx.map(p => p.v);
    const min = Math.min(...vs), max = Math.max(...vs);
    const PAD_Y = 3, H = 40;
    // The SVG stays compact so the summary row does not take height from the roster rows. Only the axis labels get a compensated font size, divided by the viewBox's uniform scale, so they still render at about 9.5 CSS pixels in a small box.
    const yAt = (v) => (max === min ? H / 2 : PAD_Y + (1 - (v - min) / (max - min)) * (H - PAD_Y * 2));

    const last = presentIdx[presentIdx.length - 1];
    const curX = xAt(last.i), curY = yAt(last.v);

    // The recent window comes from the shared timeframe control's own count. With no window pill lit there is nothing to shade, so the rect is omitted.
    const { window: sharedWindow } = parseTimeframe(AppState.timeframe);
    const shadeHtml = (sharedWindow > 0 && sharedWindow < n)
        ? `<rect x="${xAt(n - sharedWindow).toFixed(1)}" y="0" width="${(100 - xAt(n - sharedWindow)).toFixed(1)}" height="${H}" class="mt-spark-window"></rect>`
        : '';

    // The axis ends are the only words the chart carries. They sit over the plot's corners, and a text shadow in the surface colour keeps them legible over the line.
    const bestPlace = Math.min(...presentPlaces), worstPlace = Math.max(...presentPlaces);
    const hasAxis = bestPlace !== worstPlace;
    const bestLabelHtml = hasAxis ? `<text x="2" y="9" class="mt-spark-axis">${escapeHtml(ordinal(bestPlace))}</text>` : '';
    const worstLabelHtml = hasAxis ? `<text x="2" y="${H - 2}" class="mt-spark-axis">${escapeHtml(ordinal(worstPlace))}</text>` : '';

    // Per-matchup hover targets use the same data-tooltip mechanism as the rest of the app and name only the matchup and place.
    const hoversHtml = presentIdx.map(p => {
        const tip = `Matchup ${series.matchups[p.i]}: ${ordinal(maxPlace + 1 - p.v)}`;
        return `<circle cx="${xAt(p.i).toFixed(1)}" cy="${yAt(p.v).toFixed(1)}" r="4" class="mt-spark-hit" data-tooltip="${escapeHtml(tip)}"></circle>`;
    }).join('');

    return `
        <span class="mt-place-spark">
            <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
                ${shadeHtml}
                <path d="${pts.fill}" class="mt-spark-fill"></path>
                <path d="${pts.line}" class="mt-spark-line"></path>
                ${bestLabelHtml}
                ${worstLabelHtml}
                <circle cx="${curX.toFixed(1)}" cy="${curY.toFixed(1)}" r="3" class="mt-spark-now"></circle>
                ${hoversHtml}
            </svg>
        </span>`;
}

// Re-renders the tab when its container changes size, so the layout never keeps an answer that was true for an earlier window. It watches the container and not the roster band, because the band is rebuilt by every render. The container's box is set by its parent and nothing a render writes inside it can change it, so a render cannot retrigger the observer.
let myTeamResizeObserver = null;
function observeMyTeamLayout(container) {
    if (myTeamResizeObserver || typeof ResizeObserver === 'undefined') return;
    let last = '';
    myTeamResizeObserver = new ResizeObserver(() => {
        const view = document.getElementById('view-myteam');
        if (!view || view.style.display === 'none') return;
        // A hidden or unlaid-out container measures zero, and re-rendering for that would throw away a good layout to compute one against nothing. layoutRosterBand declines the same case.
        const size = `${container.clientWidth}x${container.clientHeight}`;
        if (!container.clientWidth || !container.clientHeight || size === last) return;
        last = size;
        // The columns were measured for the old width and the vertical layout for the old height, so both are dropped together, as entering the tab does.
        invalidateMyTeamLayout();
        renderMyTeamTab();
    });
    myTeamResizeObserver.observe(container);
}

// The ids the pool lists as probable starters, and how far ahead ESPN has posted, read once per render by both the coverage band and the day strip.
function probableStarters(pool, index) {
    const starterIds = new Set();
    let horizonEnd = null;
    pool.forEach(p => {
        const listed = p && p.starterStatusByProGame;
        if (!listed) return;
        Object.keys(listed).forEach(gameId => {
            if (listed[gameId] !== 'PROBABLE') return;
            starterIds.add(p.id);
            const game = index && index.get(String(gameId));
            if (game && (horizonEnd === null || game.period > horizonEnd)) horizonEnd = game.period;
        });
    });
    return { starterIds, horizonEnd };
}

// The two custom properties the phone roster's headshots read: the team colour for the ring and the team's logo for the badge.
function rosterVarsAttr(team) {
    const parts = [];
    const color = String((AppState.teamColorMap || {})[team.id] || '');
    if (/^#[0-9a-f]{3,8}$/i.test(color)) parts.push(`--ring:${color}`);
    const logo = ((AppState.apiData?.teams || []).find(t => t.id === team.id) || {}).logo;
    if (isAllowedLogoUrl(logo)) parts.push(`--team-logo:url('${String(logo).replace(/['"\()\s]/g, c => '%' + c.charCodeAt(0).toString(16))}')`);
    return parts.length ? ` style="${escapeHtml(parts.join(';'))}"` : '';
}

/**
 * Renders the My Team tab into its container: the summary band, the roster groups, the coverage and
 * comparison drawers, and the layout fit.
 * Shows a plain empty state when no league has been fetched yet.
 * @returns {void}
 */
export function renderMyTeamTab() {
    const container = document.getElementById('myteam-container');
    if (!container) return;
    observeMyTeamLayout(container);

    if (!AppState.apiData || !AppState.teamStats.length) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }

    // This tab shows pool numbers, so rendering it consumes a deferred pool revalidate. The current pool draws below and the fresh one swaps in through the pool-ready event this tab already listens for.
    revalidateStalePoolIfDue();

    const sport = AppState.loadedSport;
    let probables = null;
    const probablesOnce = () => probables || (probables = probableStarters(AppState.playerData || [], proSchedule.index));
    const key = `${sport}:${AppState.apiData.id}:${AppState.apiData.seasonId}`;
    if (viewedTeamKey !== key) {
        viewedTeamKey = key;
        viewedTeamId = null;
        viewedTeamIsStandIn = false;
        // A chosen opponent belongs to this league. Carrying an id across a league switch would compare against a team that means something else, or nothing, in the new one.
        AppState.myTeamCompareOpponentId = null;
        AppState.myTeamCompareDrawerOpen = false;
        // A pinned schedule page names a period number, which only means something in the matchup it was pinned in. It is cleared on a league switch rather than relied on to fail safely.
        AppState.myTeamScheduleWindowStart = null;
        // The day strip's pin is the same period-number pattern, and a new opponent's window is a different set of days.
        AppState.myTeamCompareStripOpen = false;
        AppState.myTeamCompareWeekIndex = null;
    }
    if (viewedTeamId == null || !teamById(viewedTeamId)) {
        // resolveMyTeamId is the one place this question is answered. A real SWID match wins, and a stand-in fills in otherwise, marked so a SWID arriving later can correct it.
        const resolved = resolveMyTeamId(AppState.apiData.teams, AppState.userSwid, AppState.teamStats);
        viewedTeamId = resolved.id;
        viewedTeamIsStandIn = resolved.isStandIn;
    }
    if (viewedTeamIsStandIn && AppState.userSwid) {
        const owned = findOwnedTeamId(AppState.apiData.teams, AppState.userSwid);
        // Still a stand-in when the user has no team here, which is the scouting case the switcher exists for. Only a real match takes over.
        if (owned != null && teamById(owned)) {
            viewedTeamId = owned;
            viewedTeamIsStandIn = false;
        }
    }
    const team = teamById(viewedTeamId);
    if (!team) {
        container.innerHTML = '<div class="player-loading">This league has no teams to show.</div>';
        return;
    }

    const rosterMap = rostersFromPayload(AppState.apiData);
    // The diagnostic panel's roster capture used to fill only from the timeline snapshot, which this tab's primary path never calls. The capture happens here, in the caller, because rostersFromPayload stays pure, and it is reshaped into the response shape a real roster request has.
    if (rosterMap.size) {
        setDebugContext('roster', {
            teams: [...rosterMap].map(([id, es]) => ({
                id, roster: { entries: es.map(e => ({ playerId: e.playerId, lineupSlotId: e.lineupSlotId })) }
            }))
        });
    }
    let entries = rosterMap.get(team.id) || [];
    // A finished season carries no current roster, so fall back to the final period's lineup, which is the team as it stood for the last matchup.
    let awaitingFinal = false;
    if (!entries.length) {
        ensureFinalRosters(key, AppState.apiData);
        if (finalRosters.key === key && finalRosters.byTeam) entries = finalRosters.byTeam.get(team.id) || [];
        awaitingFinal = finalRosters.state === 'loading';
    }
    const counts = AppState.apiData.settings?.rosterSettings?.lineupSlotCounts || {};
    const groups = buildRosterGroups(entries, sport, counts);
    const ranks = rosterRankLookup(sport);
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgSet = AVERAGE_STATS[sport] || new Set();
    const scoredIds = [...AppState.scoredStatIds].filter(id => statMap[id]);
    // A points league is scored on one number, so that number leads its stat block. The column reads "Starts" and not the GS abbreviation, since GS is a real stat and this column sits among season totals. Football's column reads "Next Game" because a team plays once a week and a count of one game answers nothing.
    const colLabel = (id) => (id === POINTS_COL ? 'PTS' : id === STARTS_COL ? 'Starts' : id === GAMES_COL ? (sport === 'ffl' ? 'Next Game' : 'Games') : statMap[id]);

    const standing = teamStandingLine(team);
    const profile = teamCategoryProfile(team.id);
    // The coverage strip and drawer's Losing and Winning read off the same rank the WINS and BLEEDS chips show, not the model's share-based weak flag. profile.worst is the set below the league's median and profile.all is every scored category's rank, keyed by id for the drawer's badge.
    const coverageLosingIds = new Set((profile.worst || []).map(r => String(r.id)));
    const coverageRankById = new Map((profile.all || []).map(r => [String(r.id), r]));
    const isOwn = AppState.userSwid && findOwnedTeamId(AppState.apiData.teams, AppState.userSwid) === team.id;
    ensureProSchedule(key);
    ensureScoreboardOdds(key);

    // The shared timeframe drives this tab as it drives the other two. The season lines come off the pool as the current window sees it. Nothing else asks for the pool on this tab's behalf, so a league switched while My Team was open would show bare ids; asking here lets the pool-ready listener redraw when it lands.
    if (!AppState.playerDataLoaded && !AppState.playerDataError) loadPlayerTabIfNeeded();
    // Without the pool there are no names, ranks or stats, so the roster would be headshots against blank rows. The summary band stays because it comes off the league payload and is still true.
    const poolFailed = !AppState.playerDataLoaded && !!AppState.playerDataError;
    const windowedPool = effectivePlayerPool(sport);
    const poolById = new Map(windowedPool.map(p => [p.id, p]));
    const rosterIds = new Set(entries.map(e => e.playerId));
    // A timeframe other than the full season reads the weekly rows, so this asks for them here. It used to ask only when a window pill was lit, which left a league past its regular season showing dashes on the Regular Season span alone, and a league opened straight into this tab showing dashes until Player Metrics was visited.
    if (AppState.playerDataLoaded && !isFullSeasonTimeframe()) {
        ensureWeeklyDataForTimeframe(sport);
    }
    // Every roster row's title names where that player was drafted, from the same request the preseason face already fires for its picks column.
    ensureDraftPicks(sport);
    // A rostered player absent from the windowed pool has no weekly row cached, which means one of two very different things: the rows have not arrived yet, or they have and nothing was played in this window. Saying "no games in this timeframe" while the fetch is still running asserts the second when the truth is the first.
    const windowedMissing = AppState.playerDataLoaded
        ? [...rosterIds].filter(id => !poolById.has(id) && AppState.playerData.some(p => p.id === id)).length
        : 0;
    const weeklyStillArriving = windowedMissing > 0 && weeklyDataPending();

    // A dash still means unranked, but it now says why when the lookup knows. Not having pitched in the window is a different state from not being ranked at all.
    const UNRANKED_WHY = {
        'no-games': 'Unranked: no games played in this timeframe',
        'below-minimum': "Unranked: below the leaderboard's minimum games played"
    };
    const chip = (playerId) => {
        const r = ranks.get(playerId);
        if (!r || r.rank == null) {
            const why = r && UNRANKED_WHY[r.reason];
            return `<span class="mt-rank-none"${why ? ` data-tooltip="${escapeHtml(why)}"` : ''}>-</span>`;
        }
        return `<span class="mt-rank" data-tooltip="Rank ${r.rank} of ${r.total} among ${escapeHtml(r.poolLabel)}">#${r.rank}</span>`;
    };
    // Projected starts for the matchup being played, counted once and read by the pitcher column. IR is excluded because those players cannot be started without a roster move. The bench is included because a daily-lineup league routinely slots a benched starter in on the morning of a start.
    const projected = (() => {
        if (!proSchedule.index || !AppState.playerDataLoaded) return null;
        const win = currentMatchupWindow(matchupPeriodMap(), AppState.apiData.scoringPeriodId);
        if (!win) return null;
        const byId = new Map(AppState.playerData.map(p => [p.id, p]));
        const available = [...groups.starters, ...groups.bench, ...groups.orphans]
            .map(r => byId.get(r.playerId))
            .filter(p => p && p.starterStatusByProGame);
        if (!available.length) return null;
        const counts = countProjectedStarts(available, proSchedule.index, win, AppState.apiData.scoringPeriodId);
        return counts.total ? counts : null;
    })();

    // The matchup's own days come from the league's real schedule and never from the matchupPeriods setting, which maps to week indices. The two-start badges and the games-per-team note share them so both read the same days.
    const matchupDays = (() => {
        if (!AppState.playerDataLoaded) return null;
        const win = currentMatchupWindow(matchupPeriodMap(), AppState.apiData.scoringPeriodId);
        if (!win) return null;
        const periods = periodsOfMatchup(matchupPeriodMap(), win.matchup);
        return periods.length ? { matchup: win.matchup, periods } : null;
    })();

    // The next matchup's days, so a player whose club has nothing left this matchup still shows the next game.
    const nextMatchupPeriods = matchupDays ? periodsOfMatchup(matchupPeriodMap(), matchupDays.matchup + 1) : [];

    // Games this matchup, per player, asked of everyone the way the Starts column is asked of pitchers. It is memoised per player because the roster is assembled in four groups in three places. The coverage band normalises every player to the basis the tab already shows, so the pure model is unchanged. The inputs are kept so the drawer's ranked modes ask on exactly the same basis.
    let coverageInputs = null;
    // The drop ledger's ingredients are built once here, where every basis and pool variable already exists, rather than re-derived at render time from a stripped-down band result.
    let dropForInputs = null;
    const coverage = (() => {
        // Hidden in every points league in every season state. A points league's scored stats are every weighted stat rather than the handful a category league counts, and the band has no design for that shape.
        if (AppState.isPointsLeague) return null;
        const sport = AppState.loadedSport;
        const categoryIds = [...(AppState.scoredStatIds || [])];
        if (!AppState.playerDataLoaded || !categoryIds.length) return null;
        const rosters = rostersFromPayload(AppState.apiData);
        if (!rosters.size) return null;

        const components = RATE_COMPONENTS[sport] || [];
        const inverseIds = leagueInverseIds(sport);
        const rateIds = AVERAGE_STATS[sport] || new Set();
        const ids = idsToSum(categoryIds, components);
        const poolById = new Map((AppState.playerData || []).map(p => [p.id, p]));
        const basisPlayer = (p) => ({ id: p.id, name: p.name, seasonTotals: basisTotalsOf(p) });
        const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
        // A finished season's projected totals are a remainder frozen on the day ESPN stopped updating them, not a real rest-of-season figure. The band refuses the projected basis there rather than print a frozen number as a confident forecast for a season with no rest of the way.
        const finished = seasonIsFinished(AppState.apiData);

        // The forward-looking half reads the ahead setting. Rest of season needs no schedule because ESPN's projected totals already are the remainder. The next-matchup choice rebuilds one from a per-game rate times the club's games in the next matchup, pre-multiplied into a totals object because the caller wants a total.
        const nextWindow = (() => {
            if (finished || AppState.ahead !== 'next') return null;
            const map = matchupPeriodMap();
            const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
            if (current == null || !proSchedule.proTeams) return null;
            const periods = periodsOfMatchup(map, current + 1);
            if (!periods.length) return null;
            return { matchup: current + 1, periods, byTeamGames: gamesByProTeamForMatchup(proSchedule.proTeams, periods) };
        })();
        // The rest of the way is a window too, today through the league's last day. Both windows go through the same remainder line, so flipping the Next pill changes the span and never the basis.
        const restWindow = (() => {
            if (finished || nextWindow || !proSchedule.proTeams || !todayPeriod) return null;
            const final = finalScoringPeriodOf(AppState.apiData);
            if (!final || final < todayPeriod) return null;
            const periods = [];
            for (let p = todayPeriod; p <= final; p++) periods.push(p);
            return { matchup: null, periods, byTeamGames: gamesByProTeamForMatchup(proSchedule.proTeams, periods) };
        })();
        const forwardWindow = nextWindow || restWindow;
        // The denominator the remainder is priced on is every game each club has already played. The remainder divides by the club's games rather than the player's, so a starting pitcher is not priced as though he pitched every night.
        const clubGamesPlayed = (() => {
            if (!forwardWindow || !todayPeriod || !proSchedule.proTeams) return null;
            const periods = [];
            for (let p = 1; p < todayPeriod; p++) periods.push(p);
            return periods.length ? gamesByProTeamForMatchup(proSchedule.proTeams, periods) : null;
        })();
        // A starting pitcher is priced over his rotation turn, not his club's schedule. A starter is a probable anywhere this season, and the horizon of posted probables is a second condition, because a window counted in starts beyond that horizon would price him on part of a rotation.
        const startsContext = (() => {
            if (!forwardWindow || !proSchedule.index) return null;
            const periods = forwardWindow.periods || [];
            if (!periods.length) return null;
            const pool = AppState.playerData || [];
            const { starterIds, horizonEnd } = probablesOnce();
            const window = { start: periods[0], end: periods[periods.length - 1] };
            const byPlayer = countProjectedStarts(pool, proSchedule.index, window, todayPeriod).byPlayer;
            return { starterIds, horizonEnd, byPlayer, windowEnd: window.end };
        })();
        // The periods ride on both branches because the strip and drawer caption names how many games are left in the window, and it is the same day list the remainder is priced against. The label reads "Matchup Games" everywhere it prints, from this one string. The rest-of-season label is unchanged.
        const coverageWindow = nextWindow
            ? { kind: 'matchup', label: 'Matchup Games', matchup: nextWindow.matchup, periods: forwardWindow.periods, asOf: todayPeriod }
            : { kind: 'rest', label: 'the rest of the way', matchup: null, periods: forwardWindow ? forwardWindow.periods : null, asOf: todayPeriod };

        const projectedBasisPlayer = (p) => {
            if (!forwardWindow) return { id: p.id, name: p.name, seasonTotals: {} };
            const groups = playerRoleGroups(p, sport);
            // Secondary only for a player who is exclusively a pitcher or goalie, the same simplification the leaderboard's Batters and Pitchers split makes.
            const secondaryOnly = groups.secondary && !groups.primary;
            const gamesId = (GAMES_PLAYED_IDS[sport] || {})[secondaryOnly ? 'secondary' : 'primary'];
            const gamesRemaining = matchupWindow(forwardWindow.byTeamGames, p.proTeamId, {
                matchup: forwardWindow.matchup, periods: forwardWindow.periods, fromPeriod: todayPeriod
            }).games;
            // The remainder refuses a player with no games played, which is a real answer and not a gap. An empty bag reads through sumPlayers as carrying none of every category.
            const clubPlayed = clubGamesPlayed && clubGamesPlayed.get(Number(p.proTeamId));
            // remainderLine reads expectedAppearances itself, so the unit is decided in one place for the band, the pacing card and the leaderboard column alike. `remaining` here is the count of the player's LISTED starts inside this window; without a listing it is undefined and the share answers instead.
            const listing = startsContext && startsContext.byPlayer.get(p.id);
            const line = remainderLine(p, {
                gamesId, rateIds, gamesRemaining, clubGamesPlayed: clubPlayed ? clubPlayed.games : 0,
                projectedStarts: listing ? listing.remaining : null,
                startsScheduled: !!(startsContext && startsContext.starterIds.has(p.id)),
                horizonEnd: startsContext ? startsContext.horizonEnd : null,
                windowEnd: startsContext ? startsContext.windowEnd : null
            });
            return { id: p.id, name: p.name, seasonTotals: line || {} };
        };

        const sumsByTeam = {};
        rosters.forEach((entries, tid) => {
            const players = entries.map(e => poolById.get(e.playerId)).filter(Boolean).map(basisPlayer);
            sumsByTeam[tid] = sumPlayers(players, ids);
        });
        if (!sumsByTeam[team.id]) return null;

        // The free agents worth naming, not all of them. Re-summing the roster once per candidate per losing category over the whole pool would be tens of thousands of sums per render, so they are ordered by how widely owned they are. Sidelined players are not candidates, because ESPN's rest-of-season projection does not discount an injury. The filter runs before the slice so the shortlist is 120 players a manager could add.
        const availableRaw = (AppState.playerData || [])
            .filter(p => !p.teamId && !isSidelined(p.injuryStatus))
            .sort((a, b) => (b.rosterPct || 0) - (a.rosterPct || 0))
            .slice(0, 120);
        const mark = (row, p) => (row ? { ...row, out: isSidelined(p.injuryStatus) } : row);
        const available = availableRaw.map(p => mark(basisPlayer(p), p));
        // No window, no projected basis. Without the pro schedule there are no club games to multiply a rate by, so the band is handed null and falls back to the actuals roster, a refusal rather than an empty bag that would render as a confident zero.
        const forwardBasis = !finished && !!forwardWindow && !!clubGamesPlayed;
        const projectedAvailable = forwardBasis ? availableRaw.map(p => mark(projectedBasisPlayer(p), p)) : null;

        // Who is sitting in an injured-reserve seat. A swap named a player on the IL, and dropping him frees no roster spot. The rule concerns the slot and never the injury status, so an injured player in a bench or active seat stays a candidate. The ids come from the same derivation buildRosterGroups draws its bands from, where the lower id of the bench and injury pair is the bench.
        const reserveSlots = (() => {
            const pair = [...(NON_STARTING_SLOTS[sport] || [])].sort((a, b) => a - b);
            return new Set(pair.slice(1));
        })();
        const reservedIds = new Set((rosters.get(team.id) || [])
            .filter(e => reserveSlots.has(e.lineupSlotId))
            .map(e => e.playerId));
        // The boolean rides on the row the model reads, never on the pool player, because the model is handed rows and knows nothing about ESPN. `out` on the adds side is set the same way.
        const reserved = (row, p) => (row && reservedIds.has(p.id) ? { ...row, irSlot: true } : row);

        const rosterRaw = (rosters.get(team.id) || []).map(e => poolById.get(e.playerId)).filter(Boolean);
        if (!rosterRaw.length) return null;
        const roster = rosterRaw.map(p => reserved(basisPlayer(p), p));
        const projectedRoster = forwardBasis ? rosterRaw.map(p => reserved(projectedBasisPlayer(p), p)) : null;

        coverageInputs = {
            sumsByTeam, components, inverseIds,
            roster: forwardBasis ? projectedRoster : roster,
            available: forwardBasis ? projectedAvailable : available
        };

        // The drop ledger needs a forward sumsByTeam, with every team's roster through the projected basis, so a drop priced on games still to come is measured against rivals on the same basis. The band's own standings stay on the actuals and this is read only by the ledger.
        const forwardSumsByTeam = forwardBasis ? (() => {
            const out = {};
            rosters.forEach((entries, tid) => {
                const players = entries.map(e => poolById.get(e.playerId)).filter(Boolean).map(projectedBasisPlayer);
                out[tid] = sumPlayers(players, ids);
            });
            return out;
        })() : sumsByTeam;

        // A roster's own full-season sum counts what its current players did before they were acquired, on another team, so it can misstate the team's rank in a category. The ribbon's profile answers the real standing off the team stats' season categories, so the ledger's rival figures are built from that source plus each team's forward sum, component by component.
        const bankedByTeam = new Map(AppState.teamStats.map(t => [String(t.id), t.seasonCats || {}]));
        const combineSums = (bankedRow, forwardRow) => {
            const out = { ...forwardRow };
            ids.forEach(k => {
                const v = Number(bankedRow[k]);
                if (!Number.isFinite(v)) return;
                const f = Number(out[k]);
                out[k] = (Number.isFinite(f) ? f : 0) + v;
            });
            return out;
        };
        const combinedSumsByTeam = forwardBasis ? Object.fromEntries(
            Object.keys(forwardSumsByTeam).map(tid => [tid, combineSums(bankedByTeam.get(String(tid)) || {}, forwardSumsByTeam[tid])])
        ) : forwardSumsByTeam;

        dropForInputs = {
            roster: coverageInputs.roster,
            available: coverageInputs.available,
            sumsByTeam: combinedSumsByTeam,
            banked: bankedByTeam.get(String(team.id)) || null,
            components, inverseIds, categoryIds, teamId: team.id
        };
        return coverageBand({
            sumsByTeam, teamId: team.id, roster, available, categoryIds, components, inverseIds,
            projectedRoster, projectedAvailable, window: forwardBasis ? coverageWindow : null,
            // Search for an add in every category this tab will call losing. The strip and the drawer rank by the losing ids and not the model's share-based weak flag, and the two differ, so without this a category could be listed as losing while no add was ever looked for. The model unions this with its own holes.
            searchIds: coverageLosingIds
        });
    })();

    // The drawer's best-add modes are four questions over one table, each a rankAdds call on a different set of ids. This block only says which ids each mode asks about. An inverse counting category is in no mode's set because it has no add, so the picker strikes it through rather than offering a pick that would be ignored.
    const addsMode = (() => {
        if (!coverage || !coverage.categories || !coverage.categories.length) return null;
        const ids = coverage.categories.map(c => String(c.id));
        const unrankableIds = new Set(coverage.categories.filter(c => c.inverse && !c.rate).map(c => String(c.id)));
        const mode = AppState.coverageAddsMode || 'one';
        const picked = AppState.coverageAddsPicked instanceof Set ? AppState.coverageAddsPicked : new Set();
        const rankable = (list) => list.filter(id => !unrankableIds.has(id));
        const rankIds = mode === 'all' ? rankable(ids)
            : mode === 'holes' ? rankable(ids.filter(id => coverageLosingIds.has(id)))
                : mode === 'pick' ? rankable(ids.filter(id => picked.has(id)))
                    : [];
        // The rest of the way never names itself here, since the drawer's header right above already says the days left. A matchup window still names itself, a scope no days-left figure states.
        const windowLabel = coverage.window && coverage.window.kind === 'matchup' ? coverage.window.label : null;
        return {
            mode, ids, picked, unrankableIds,
            losingIds: coverageLosingIds,
            rankIds,
            sourceLabel: windowLabel ? `Free agents · ${windowLabel}` : 'Free agents'
        };
    })();
    // The same basis the strip's own adds use, the projected remainder where there is one and the actuals otherwise, so a chip and a table row never show two numbers for one player.
    const addsRanked = (() => {
        if (!addsMode || !addsMode.rankIds.length || !coverageInputs) return null;
        return rankAdds(coverageInputs.available, coverageInputs.roster, addsMode.rankIds, {
            components: coverageInputs.components,
            inverseIds: coverageInputs.inverseIds,
            sumsByTeam: coverageInputs.sumsByTeam,
            limit: 8
        });
    })();

    // The drop-for mode. dropForInputs carries the combined banked and forward sums and the same roster and available rows every other mode reads, so its figures cannot disagree with the strip's or another mode's.
    const dropForState = (() => {
        if (!dropForInputs) return null;
        const { roster, available, sumsByTeam: combinedSumsByTeam, banked, components, inverseIds, categoryIds, teamId } = dropForInputs;
        const dropId = AppState.coverageDropId;
        const candidateId = AppState.coverageDropCandidateId;
        // Roster meta for display comes off the pool, since the ledger's stripped-down rows carry no team or position for a pair card.
        const withMeta = (id) => {
            const p = poolById.get(id);
            return p ? { id, name: p.name, teamName: p.teamName, positionDisplay: p.positionDisplay } : null;
        };
        const rosterChoices = roster.map(r => withMeta(r.id)).filter(Boolean);
        // The candidate list is every scored category's composite, not one mode's subset. Drop-for is not scoped to a hole the way the other modes are, so it reads the whole roster's need.
        const ranked = rankAdds(available, roster, categoryIds.map(String), { components, inverseIds, sumsByTeam: combinedSumsByTeam, limit: 12 });
        const candidateChoices = ranked.map(r => withMeta(r.player.id)).filter(Boolean);
        // The search reads the whole pool, ranked first. The drawer's default is the top twelve, so a typed name needs this unlimited call. Players rankAdds drops for gaining in no scored category are appended alphabetically, since there is no composite to rank them by.
        const allRanked = rankAdds(available, roster, categoryIds.map(String), { components, inverseIds, sumsByTeam: combinedSumsByTeam });
        const rankedIds = new Set(allRanked.map(r => r.player.id));
        const restOfPool = (available || [])
            .filter(p => p && !p.out && !rankedIds.has(p.id))
            .slice()
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const searchPool = allRanked.map(r => withMeta(r.player.id))
            .concat(restOfPool.map(p => withMeta(p.id)))
            .filter(Boolean);
        const dropRow = dropId !== null && dropId !== undefined ? roster.find(r => r.id === dropId) : null;
        const candidateRow = candidateId !== null && candidateId !== undefined
            ? (available.find(r => r.id === candidateId) || null) : null;
        // A head-to-head league supplies no placeFrom, because a drop cannot recompute a won-lost record, so the summary's Overall clause reads null on both sides and is omitted. Roto's projected standing is answered the way projected-basis and rank-engine answer it elsewhere.
        const placeFrom = AppState.isRotoLeague
            ? (byTeam, tid) => {
                const cats = categoryIds.map(id => ({ id, inverse: !!(inverseIds && inverseIds.has(String(id))) }));
                const standing = projectedRotoStandings(byTeam, cats, rotoPointsForCategory);
                const idx = standing.findIndex(s => String(s.teamId) === String(tid));
                return idx === -1 ? null : idx + 1;
            }
            : null;
        const ledger = (dropRow && candidateRow)
            ? dropLedger(roster, dropRow.id, candidateRow, { components, inverseIds },
                { categoryIds, sumsByTeam: combinedSumsByTeam, teamId, placeFrom, banked })
            : (dropRow
                ? dropLedger(roster, dropRow.id, null, { components, inverseIds },
                    { categoryIds, sumsByTeam: combinedSumsByTeam, teamId, placeFrom, banked })
                : null);
        return {
            dropPlayer: dropRow ? withMeta(dropRow.id) : null,
            candidate: candidateRow ? withMeta(candidateRow.id) : null,
            rosterChoices, candidateChoices, searchPool, ledger
        };
    })();

    // The "against" comparison. The team-compare contract in tests/fixtures/team-compare.md decides every refusal, so this block only assembles the context it asks for. A points league is compared like any other, in points. The close control dismisses a drawer the schedule's own pairing opened, for that pairing only, so it does not reopen on the next render.
    const { compare, dayStrip, scheduledNote, effectiveOpponentId, isScheduledDefault } = (() => {
        const nothing = { compare: null, dayStrip: null, scheduledNote: null };
        const map = matchupPeriodMap();
        const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
        // Under Next, before the reader has picked anyone, the comparison defaults to the schedule's own pairing rather than refusing. The picker still overrides it. Outside Next an opponent is already known or the whole league is the field.
        const scheduledOpponentId = (AppState.ahead === 'next' && current != null)
            ? scheduledOpponentOf(AppState.apiData?.schedule, current + 1, team.id) : null;
        const explicitOpponentId = AppState.myTeamCompareOpponentId;
        const opponentId = explicitOpponentId != null ? explicitOpponentId : scheduledOpponentId;
        if (opponentId == null) {
            // When the bracket has not drawn a pairing yet, say so rather than leaving the picker with nothing beside it. It waits for the schedule to load like every other refusal here, so it never prints a guess while a fetch is in flight.
            if (AppState.ahead === 'next' && AppState.apiData?.schedule) {
                return { compare: null, dayStrip: null, scheduledNote: "The next matchup isn't drawn yet - compare against any team." };
            }
            return nothing;
        }
        const opponent = teamById(opponentId);
        if (!opponent || !AppState.playerDataLoaded) return nothing;
        const sport = AppState.loadedSport;
        // A points league's categories are its weighted stats. The weights come from the payload's scoring items through categoryWeights and never AppState.scoringWeights, which lacks the football items whose worth sits under pointsOverrides. A zero-weight item earns nothing for either side, so it is not a row.
        const pointsWeights = AppState.isPointsLeague
            ? categoryWeights(AppState.apiData?.settings?.scoringSettings?.scoringItems)
            : null;
        const categoryIds = [...(AppState.scoredStatIds || [])]
            .filter(id => !pointsWeights || pointsWeights[String(id)] !== 0);
        if (!categoryIds.length) return nothing;

        // The window. "This matchup" reads as played once it has really started, the same test data.js uses, and a matchup that has not begun takes the projected path rather than a zeroed played one. Next matchup and Rest of season are always projected.
        const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
        // The drawer reads the shared ahead setting, the same field the tab bar's Next and Rest pills and the coverage band read. Null means this matchup.
        const windowKey = AppState.ahead || 'window';
        let win = null;
        if (windowKey === 'window' && current != null) {
            const periods = periodsOfMatchup(map, current);
            if (periods.length) {
                const played = readsAsPlayedMatchup(current, AppState.maxCompletedWeek, AppState.currentMatchup);
                win = { kind: played ? 'played' : 'projected', label: `Matchup ${current}`, matchup: current, periods, asOf: todayPeriod };
            }
        } else if (windowKey === 'next' && current != null) {
            const next = current + 1;
            const periods = periodsOfMatchup(map, next);
            if (periods.length) win = { kind: 'projected', label: `Matchup ${next}`, matchup: next, periods, asOf: todayPeriod };
        } else if (windowKey === 'rest' && todayPeriod != null) {
            const final = finalScoringPeriodOf(AppState.apiData);
            if (final && final >= todayPeriod) {
                const periods = [];
                for (let p = todayPeriod; p <= final; p++) periods.push(p);
                if (periods.length) win = { kind: 'projected', label: 'Rest of Season', matchup: null, periods, asOf: todayPeriod };
            }
        }
        if (!win) return nothing;

        const ctx = {
            window: win,
            scoredIds: categoryIds,
            statLabels: statMap,
            lowerIsBetterIds: leagueInverseIds(sport),
            rateIds: AVERAGE_STATS[sport] || new Set(),
            rateComponents: RATE_COMPONENTS[sport] || [],
            // The sport's own role split, so each row says whether it is a primary or a secondary category.
            secondaryIds: roleIdSetFor(sport),
            ...(pointsWeights ? { isPointsLeague: true, weights: pointsWeights } : {})
        };

        if (win.kind === 'played') {
            // Zero requests, the team totals data.js already built off the league payload, per matchup.
            const played = {};
            (AppState.teamStats || []).forEach(t => { played[t.id] = t.weeklyCats || {}; });
            ctx.played = played;
        } else {
            // Projected is each rostered player's per-game rate times that club's games in the window, the same read the Player Metrics lens columns make for one player, made here for a whole roster.
            if (!proSchedule.proTeams) return nothing;
            const byTeamGames = gamesByProTeamForMatchup(proSchedule.proTeams, win.periods);
            const rostersMap = rostersFromPayload(AppState.apiData);
            const poolById = new Map((AppState.playerData || []).map(p => [p.id, p]));
            const projFor = (teamId) => (rostersMap.get(teamId) || [])
                .map(e => poolById.get(e.playerId))
                .filter(Boolean)
                .map(p => {
                    const groups = playerRoleGroups(p, sport);
                    // Secondary only for a player who is exclusively a pitcher or goalie. A two-way player is read off the primary role, the same simplification the leaderboard's split makes, rather than double-counting the row.
                    const secondaryOnly = groups.secondary && !groups.primary;
                    const gamesId = (GAMES_PLAYED_IDS[sport] || {})[secondaryOnly ? 'secondary' : 'primary'];
                    const totals = p.projectedTotals;
                    if (!totals || !gamesId) return null;
                    const projGames = Number(totals[gamesId]);
                    if (!Number.isFinite(projGames) || projGames <= 0) return null;
                    const rates = {};
                    Object.keys(totals).forEach(id => {
                        const v = totals[id];
                        if (v === null || v === undefined) return;
                        const n = Number(v);
                        if (!Number.isFinite(n)) return;
                        rates[id] = ctx.rateIds.has(String(id)) ? n : n / projGames;
                    });
                    const games = matchupWindow(byTeamGames, p.proTeamId, {
                        matchup: win.matchup, periods: win.periods, fromPeriod: todayPeriod
                    }).games;
                    return { rates, games };
                })
                .filter(Boolean);
            ctx.projected = { [team.id]: projFor(team.id), [opponent.id]: projFor(opponent.id) };
        }

        // The workload rides on the same schedule atoms the coverage band prices the remainder with, so there is no second pass over the pro schedule. Only baseball carries starts, so the model returns null elsewhere and the renderer drops the tile.
        let dayStripResult = null;
        if (proSchedule.proTeams) {
            const byTeamGames = gamesByProTeamForMatchup(proSchedule.proTeams, win.periods);
            const pool = AppState.playerData || [];
            // How far ESPN has actually posted is read on the same pass that finds the starters. The expected appearances helper refuses the starts branch without it, and it cannot be derived from the window.
            const { starterIds, horizonEnd } = probablesOnce();
            const startsWindow = { start: win.periods[0], end: win.periods[win.periods.length - 1] };
            const startsByPlayer = proSchedule.index
                ? countProjectedStarts(pool, proSchedule.index, startsWindow, todayPeriod).byPlayer
                : new Map();
            // The slot the coverage model's own irSlot uses, not the injury status, because a reserved arm frees no seat to activate for.
            const irSlots = (() => {
                const pair = [...(NON_STARTING_SLOTS[sport] || [])].sort((a, b) => a - b);
                return new Set(pair.slice(1));
            })();
            // Which slots are seats. Hitter games and off days are as seated by definition, and the model refuses them without this table rather than counting the bench, so a silent fallback cannot read a bench-heavy side as having more games. Read off the league's slot order minus the bench and injury pair.
            const activeSlots = new Set(
                (LINEUP_SLOT_ORDER[sport] || []).filter(s => !(NON_STARTING_SLOTS[sport] || new Set()).has(s))
            );
            // EVERY GAME EACH CLUB HAS ALREADY PLAYED, the denominator the share is taken over. The same figure the coverage band builds for remainderLine, for the same reason.
            const clubGamesPlayed = (() => {
                if (!todayPeriod) return new Map();
                const before = [];
                for (let p = 1; p < todayPeriod; p++) before.push(p);
                return before.length ? gamesByProTeamForMatchup(proSchedule.proTeams, before) : new Map();
            })();
            const rostersMap = rostersFromPayload(AppState.apiData);
            const poolById = new Map(pool.map(p => [p.id, p]));
            // Eligibility for a pitching slot, not defaultPositionId, because some real starters carry ESPN's relief id while holding probable listings. seasonTotals rides on the row because expectedAppearances reads it to take the share.
            const rosterFor = (teamId) => (rostersMap.get(teamId) || [])
                .map(e => {
                    const p = poolById.get(e.playerId);
                    return p ? {
                        id: p.id, slot: e.lineupSlotId, proTeamId: p.proTeamId,
                        pitcher: matchesPlayerGroup(p, sport, true),
                        seasonTotals: p.seasonTotals || {}
                    } : null;
                })
                .filter(Boolean);
            // The closure the contract asks for, not the bare function. expectedAppearances needs more arguments than the model can know, so the caller closes over the window's tables and hands back a two-argument function.
            const expectedFor = (p, { projectedStarts, startsScheduled }) => {
                const gamesId = (GAMES_PLAYED_IDS[sport] || {})[p.pitcher ? 'secondary' : 'primary'];
                const clubPlayed = clubGamesPlayed.get(Number(p.proTeamId));
                const clubLeft = byTeamGames.get(Number(p.proTeamId));
                return expectedAppearances(p, {
                    gamesId,
                    clubGamesPlayed: clubPlayed ? clubPlayed.games : 0,
                    gamesRemaining: clubLeft ? clubLeft.games : 0,
                    projectedStarts, startsScheduled,
                    horizonEnd, windowEnd: startsWindow.end
                });
            };
            ctx.workload = {
                countsStarts: sport === 'flb',
                byTeamGames, irSlots, startsByPlayer, starterIds, activeSlots,
                expectedAppearances: expectedFor,
                rosters: { [team.id]: rosterFor(team.id), [opponent.id]: rosterFor(opponent.id) }
            };

            // The day strip is baseball only, and only once a pro schedule is in hand, the same gate the workload header takes. It pages a fixed seven-day window through a longer matchup, as the Schedule face's calendar does.
            if (sport === 'flb') {
                const first = win.periods[0], last = win.periods[win.periods.length - 1];
                // Fixed, non-overlapping weeks off the window's own start, so week 1 is days 1 to 7 and week 2 is 8 to 14, never a page that slides to today. A today-anchored page printed with a week number repeated days, so this does not use one.
                const weekCount = Math.max(1, Math.ceil(win.periods.length / 7));
                const paged = weekCount > 1;
                const todayClamped = Math.max(first, Math.min(last, todayPeriod || first));
                const defaultWeekIndex = Math.floor((todayClamped - first) / 7) + 1;
                const stored = AppState.myTeamCompareWeekIndex;
                const weekIndex = paged
                    ? Math.max(1, Math.min(weekCount, stored !== null ? stored : defaultWeekIndex))
                    : 1;
                const pageStart = first + (weekIndex - 1) * 7;
                const pageEnd = Math.min(pageStart + 6, last);
                const weekPeriods = [];
                for (let p = pageStart; p <= pageEnd; p++) weekPeriods.push(p);

                // Pitcher-eligible only, since the strip is a rotation grid and a position player has no games array countProjectedStarts would have filled in.
                const rosterForStrip = (teamId) => (rostersMap.get(teamId) || [])
                    .map(e => poolById.get(e.playerId))
                    .filter(p => p && matchesPlayerGroup(p, sport, true))
                    .map(p => ({ id: p.id, name: p.name, games: (startsByPlayer.get(p.id) || {}).games || [] }));

                // The weekday plus the day of month, which a seven-column strip needs to tell one Monday from the next across a longer matchup.
                const dayHeaderLabel = (period) => {
                    const ms = proSchedule.dates && proSchedule.dates.get(period);
                    if (!Number.isFinite(Number(ms))) return String(period);
                    const d = new Date(Number(ms));
                    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`;
                };
                const abbrevOf = (id) => (proSchedule.abbrevs && proSchedule.abbrevs.get(id)) || null;

                const days = startStrip(weekPeriods, { mine: rosterForStrip(team.id), theirs: rosterForStrip(opponent.id) }, {
                    datesByPeriod: proSchedule.dates, abbrevOf, labelOf: dayHeaderLabel
                });

                const fromMs = proSchedule.dates && proSchedule.dates.get(pageStart);
                const toMs = proSchedule.dates && proSchedule.dates.get(pageEnd);
                const fmt = (ms) => new Date(Number(ms)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                const rangeLabel = (Number.isFinite(Number(fromMs)) && Number.isFinite(Number(toMs)))
                    ? (fromMs === toMs ? fmt(fromMs) : `${fmt(fromMs)} - ${fmt(toMs)}`)
                    : null;

                dayStripResult = {
                    sport, open: !!AppState.myTeamCompareStripOpen,
                    weekIndex, weekCount, rangeLabel,
                    canPrev: weekIndex > 1, canNext: weekIndex < weekCount,
                    // A week entirely past where ESPN has posted probables is unknown, not a week nobody pitches, so the strip states what it knows, that ESPN has not posted it.
                    pastHorizon: horizonEnd !== null && pageStart > horizonEnd,
                    days
                };
            }
        }
        // THE WINDOW'S DATES (contract amendment 3). The tile read "Matchup 22 / 14 days", which is a length rather than a when. A PLAIN HYPHEN, never an en dash: the mirror's tells sweep refuses the dash outright in published text, so a range built with one would fail the release gate rather than the review.
        if (proSchedule.dates) {
            ctx.datesByPeriod = proSchedule.dates;
            ctx.rangeLabelOf = (fromMs, toMs) => {
                const fmt = (ms) => new Date(Number(ms)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                const a = fmt(fromMs), b = fmt(toMs);
                return a === b ? a : `${a} - ${b}`;
            };
        }
        // The swing margin is the league's own measured decided-matchup margins. It is null on a roto or points league or with too few decided matchups, which the model turns into a null swing rather than a guess.
        ctx.margins = leagueMargins(AppState.apiData, { categoryIds, rateStatIds: ctx.rateIds }).margins;

        return {
            compare: teamCompare({ teamId: team.id, name: displayTeamName(team) }, { teamId: opponent.id, name: displayTeamName(opponent) }, ctx),
            dayStrip: dayStripResult,
            scheduledNote: null,
            effectiveOpponentId: opponentId,
            // The reader never clicked anything to reach this comparison, since it is the schedule's pairing defaulted under Next, so the drawer opens on its own rather than sitting behind a picker that already shows a team.
            isScheduledDefault: explicitOpponentId == null && scheduledCompareDismissed !== `${team.id}:${opponentId}`
        };
    })();
    driveFaceHarvest(team, effectiveOpponentId, !!compare && !!(AppState.myTeamCompareDrawerOpen || isScheduledDefault));
    const faceAsked = ensureMatchupFace(team);

    // The nights and days coverage, one per role group, for hockey, baseball and football. Hockey asks which nights the lineup is empty, which matters where clubs play on different nights. Baseball's question inverts, since clubs play almost every day and the idle player is the information. The bench is included because a benched player can be slotted in, and IR is excluded.
    const nights = (() => {
        if ((sport !== 'fhl' && sport !== 'flb' && sport !== 'ffl') || !proSchedule.proTeams || !AppState.playerDataLoaded) return null;
        // A roto league has no head-to-head schedule, so matchupDays is null, but the current scoring week is an honest window there. A matchup league keeps reading its own matchup. Football never reads matchupDays, since a matchup is already one week, and uses the current week through the season's final one as a rolling look-ahead.
        const nightsWindow = sport === 'ffl' ? (() => {
            if (seasonIsFinished(AppState.apiData)) return null;
            const today = Number(AppState.apiData?.scoringPeriodId) || null;
            const final = Number(AppState.apiData?.status?.finalScoringPeriod) || null;
            if (!today || !final || today > final) return null;
            const periods = [];
            for (let p = today; p <= final; p++) periods.push(p);
            return periods.length ? { matchup: null, periods } : null;
        })() : matchupDays || (() => {
            // A roto season has no matchup boundary for the check below to catch, so a finished one is caught here, with the same season-state signal the rest of the tab reads.
            if (seasonIsFinished(AppState.apiData)) return null;
            const first = AppState.apiData?.status?.firstScoringPeriod || 1;
            const today = Number(AppState.apiData?.scoringPeriodId) || null;
            if (!today) return null;
            const weekEnd = first + weekOfPeriod(today, first) * 7 - 1;
            const periods = [];
            for (let p = today; p <= weekEnd; p++) periods.push(p);
            return periods.length ? { matchup: null, periods } : null;
        })();
        if (!nightsWindow) return null;
        // Draws only while the window it names still has a night ahead. The window is the whole matchup with no ahead or behind filter of its own, and a finished season's last matchup still returns a real window, so without this the band drew a grid for nights that had already happened. Today past the window's last period covers both a finished season and a finished matchup.
        const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
        const lastPeriod = nightsWindow.periods[nightsWindow.periods.length - 1];
        if (todayPeriod && lastPeriod !== undefined && todayPeriod > lastPeriod) return null;
        // Capacity per group comes off the league's own slot counts, the same split the draft board's replacement level uses, so how many seats means one thing in both places.
        const slots = startingSlotsByGroup(counts, {
            nonStarting: NON_STARTING_SLOTS[sport],
            secondary: SECONDARY_LINEUP_SLOTS[sport]
        });
        // The bare period number is dayLabelerFor's fallback and is no claim a real schedule reads that way. A period with no date but a later dated period in the round is a gap the schedule fills around, so it is extrapolated from the last dated day, one day at a time. A period with nothing dated after it means the schedule does not reach that far yet, so it is trimmed off the round rather than guessed at.
        const allPeriods = nightsWindow.periods;
        let cutAt = allPeriods.length;
        for (let i = allPeriods.length - 1; i >= 0; i--) {
            if (proSchedule.dates && Number.isFinite(Number(proSchedule.dates.get(allPeriods[i])))) break;
            cutAt = i;
        }
        const periods = allPeriods.slice(0, cutAt);
        const scheduleGapReason = cutAt < allPeriods.length
            ? "The pro schedule hasn't been published this far into the round yet."
            : null;
        const labelOf = (() => {
            if (!proSchedule.dates) return null;
            const base = dayLabelerFor(proSchedule.dates);
            const DAY_MS = 24 * 60 * 60 * 1000;
            let lastDatedPeriod = null, lastDatedMs = null;
            periods.forEach(p => {
                const ms = Number(proSchedule.dates.get(p));
                if (Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())) { lastDatedPeriod = p; lastDatedMs = ms; }
            });
            return (period) => {
                const real = base(period);
                if (real !== String(period) || lastDatedPeriod === null) return real;
                const d = new Date(lastDatedMs + (Number(period) - lastDatedPeriod) * DAY_MS);
                return Number.isNaN(d.getTime()) ? real : d.toLocaleDateString(undefined, { weekday: 'short' });
            };
        })();
        const rows = [...groups.starters, ...groups.bench, ...groups.orphans];
        const forRole = (secondary) => rows
            .map(r => poolById.get(r.playerId))
            .filter(p => p && (secondary ? playerRoleGroups(p, sport).secondary : playerRoleGroups(p, sport).primary))
            .map(p => ({ id: p.id, proTeamId: p.proTeamId }));
        // Computed once per role and fed to both the night coverage and the id list the night schedule wants, so one array is read two ways and the two filters cannot drift.
        const primaryRoster = forRole(false);
        const secondaryRoster = forRole(true);
        const cover = (rosterArr, secondary) => rosterNightCoverage(
            rosterArr, proSchedule.proTeams, periods,
            { slots: secondary ? slots.secondary : slots.primary }
        );
        return {
            labelOf, scheduleGapReason,
            primary: cover(primaryRoster, false), secondary: cover(secondaryRoster, true),
            primaryIds: primaryRoster.map(p => p.id), secondaryIds: secondaryRoster.map(p => p.id)
        };
    })();

    // The night, day and week schedule resolves the night coverage's per-period player ids into named, opponent-tagged players for each role group's calendar face. The coverage stays the count's source and this only names who they are and who they play. Baseball gets only its primary group because the pitchers already have their own Schedule face, and hockey and football get both groups.
    const nightSchedule = ((sport === 'fhl' || sport === 'flb' || sport === 'ffl') && nights) ? {
        primary: buildNightSchedule(nights.primary, poolById, proSchedule.proTeams, nights.primaryIds),
        secondary: (sport === 'fhl' || sport === 'ffl')
            ? buildNightSchedule(nights.secondary, poolById, proSchedule.proTeams, nights.secondaryIds)
            : null
    } : null;

    const hasGamesWindow = !!(proSchedule.proTeams && matchupDays && AppState.playerDataLoaded);
    const windowCache = new Map();
    let windowByTeam = null;
    let windowLabelOf = null;
    const gamesWindowFor = (playerId) => {
        if (windowCache.has(playerId)) return windowCache.get(playerId);
        let out = null;
        if (proSchedule.proTeams && matchupDays && AppState.playerDataLoaded) {
            if (!windowByTeam) {
                windowByTeam = gamesByProTeamForMatchup(proSchedule.proTeams, matchupDays.periods);
                windowLabelOf = proSchedule.dates ? dayLabelerFor(proSchedule.dates) : null;
            }
            const p = poolById.get(playerId);
            if (p && p.proTeamId != null) {
                out = matchupWindow(windowByTeam, p.proTeamId, {
                    matchup: matchupDays.matchup,
                    periods: matchupDays.periods,
                    labelOf: windowLabelOf,
                    fromPeriod: AppState.apiData.scoringPeriodId
                });
            }
        }
        windowCache.set(playerId, out);
        return out;
    };

    // Football's answer to the question gamesWindowFor answers for the other sports, the day and opponent of the player's one game in the matchup, from schedule-insight's nextGameOf. Memoised for the same reason, the roster being drawn in four groups from three places.
    const nextGameCache = new Map();
    const nextGameFor = (playerId) => {
        if (nextGameCache.has(playerId)) return nextGameCache.get(playerId);
        let out = null;
        if (proSchedule.proTeams && matchupDays && AppState.playerDataLoaded) {
            const p = poolById.get(playerId);
            if (p) out = nextGameOf(p, proSchedule.proTeams, matchupDays.periods.concat(nextMatchupPeriods), { now: Date.now() });
        }
        nextGameCache.set(playerId, out);
        return out;
    };

    // Two-start pitchers this matchup, read off the same roster and eligibility filter the projected starts use, so a player counted toward starts still to come is the player who can earn the badge.
    const twoStart = (() => {
        if (!proSchedule.index || !matchupDays) return null;
        const byId = new Map(AppState.playerData.map(p => [p.id, p]));
        const available = [...groups.starters, ...groups.bench, ...groups.orphans]
            .map(r => byId.get(r.playerId))
            .filter(p => p && p.starterStatusByProGame);
        if (!available.length) return null;
        return twoStartPitchers(available, proSchedule.index, matchupDays.periods, { fromPeriod: AppState.apiData.scoringPeriodId });
    })();

    // How hard each projected start looks. The opposing offence is measured over the whole player pool and not the league's rosters, because a pro team's lineup is mostly players nobody in a small league has drafted. Baseball uses a fixed general offence basket, since fielding assists or errors say nothing about facing a lineup, and hockey keeps the league's own skater categories.
    const GENERAL_OFFENCE = { flb: ['20', '5', '17', '9'] };
    const battingIds = GENERAL_OFFENCE[sport] || splitStatIdsByRole(sport, scoredIds).primary || [];
    // The per-team totals BEFORE they collapse into a percentile. offenceStrength throws this away by design; the drill-in needs it to show what the percentile was computed against.
    let offenceRaw = null;
    // The league's lower-is-better ids are handed to the engine so a category scored the other way is ranked the other way. Rates are rebuilt from summed components with the league-agnostic tables the weekly pipeline uses. A club contributes the bats that will be in the game, and the lineup sizes are rules of the sport the payload does not carry.
    const LINEUP_BATS = { flb: 9, fhl: 18 };
    // No baseball fallback: a sport with no games id has no playing-time measure, and borrowing one from another sport reads every player as zero games without saying so.
    const gpId = (GAMES_PLAYED_IDS[sport] || {}).primary;
    const offenceCtx = {
        inverseStatIds: leagueInverseIds(sport),
        rateStatIds: AVERAGE_STATS[sport] || new Set(),
        rateSpecs: RATE_COMPONENTS[sport] || [],
        lineupSize: LINEUP_BATS[sport] || null,
        playingTimeOf: (h) => (h.totals && h.totals[gpId]) || 0
    };
    // Why a score moves between looks. This reads the unwindowed pool with full-season totals, so the timeframe pill is not involved. ESPN refreshes season totals daily, which drifts a lineup a little, and an injury flip moves it a lot because one bat changes every category at once. The drill-in's Not counted list shows the large mover.
    const offence = (() => {
        if (!AppState.playerDataLoaded || !AppState.playerData) return null;
        if (!battingIds.length) return null;
        // Who counts as a bat is playerRoleGroups' question, not this file's. Absence of starterStatusByProGame looked like a cheap proxy for "not a pitcher" and is not one: measured on a real pool it kept 180 of 3000 players and every one of them had an empty stat line, because what it actually selects is players with no pro games at all.
        const hitters = AppState.playerData
            .filter(p => p && p.proTeamId != null && playerRoleGroups(p, sport).primary)
            .map(p => ({ proTeamId: p.proTeamId, injuryStatus: p.injuryStatus, totals: basisTotalsOf(p) }));
        if (!hitters.length) return null;
        const byTeam = teamOffence(hitters, battingIds, offenceCtx);
        const strength = offenceStrength(byTeam, battingIds, offenceCtx);
        if (!strength.size) return null;
        offenceRaw = byTeam;
        return strength;
    })();

    // The opponent's shot volume is the base term goalieNightDifficulty reads, a shots-for percentile map scoped to shots on goal alone and not the league's whole scored-category composite. Only shots and home ice survived measurement. The club table's own per-game figure wins when the weekly harvest has filled one, and the map built below stays beneath it for a league with no table yet.
    const shotVolume = (() => {
        const fromTable = sport === 'fhl' ? clubShotVolume() : null;
        if (fromTable) return fromTable;
        if (sport !== 'fhl' || !AppState.playerDataLoaded || !AppState.playerData) return null;
        const skaters = AppState.playerData
            .filter(p => p && p.proTeamId != null && playerRoleGroups(p, sport).primary)
            .map(p => ({ proTeamId: p.proTeamId, injuryStatus: p.injuryStatus, totals: basisTotalsOf(p) }));
        if (!skaters.length) return null;
        const byTeam = teamOffence(skaters, ['29'], offenceCtx);
        const strength = offenceStrength(byTeam, ['29'], offenceCtx);
        return strength.size ? strength : null;
    })();

    // Park factors are a baseball fact. Hockey gets no table, so the engine never adds the term and the breakdown never names a concept the sport lacks.
    const parkTable = sport === 'flb' ? MLB_PARK_FACTORS : null;

    // "Tue Jun 16", the shortest form that still answers which day. Falls back to the scoring period when a game carries no date, which no captured game does but the parsing rule says to expect.
    const startDay = (g) => (g.date
        ? new Date(g.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        : `Day ${g.period}`);
    const startOpponent = (g) => {
        const abbrev = g.opponentId != null ? proSchedule.abbrevs?.get(g.opponentId) : null;
        if (!abbrev) return '';
        return `${g.isHome ? 'vs' : '@'} ${abbrev}`;
    };

    const sortedIdFor = (role) => (groupSort[role] ? groupSort[role].statId : null);
    // The low and high of every stat column across the group's own rows, set by renderGroup before its rows are drawn. A phone's cell draws its figure over a thin bar, and the bar needs where the figure sits in its column.
    let statSpan = null;
    const pctStyle = (id, v) => {
        const span = statSpan && statSpan.get(String(id));
        if (!span || !(span.max > span.min) || !Number.isFinite(Number(v))) return '';
        let pct = ((Number(v) - span.min) / (span.max - span.min)) * 100;
        if (leagueInverseIds(sport).has(String(id))) pct = 100 - pct;
        return ` style="--pct:${Math.max(0, Math.min(100, pct)).toFixed(0)}"`;
    };
    const statCells = (playerId, ids, sortedId) => {
        const cls = (id) => 'mt-stat' + (id === sortedId ? ' mt-sorted-col' : '');
        const p = poolById.get(playerId);
        if (!p) return ids.map(id => `<td class="${cls(id)}">-</td>`).join('');
        return ids.map(id => {
            if (id === STARTS_COL) {
                const entry = projected && projected.byPlayer.get(playerId);
                if (!entry) return `<td class="${cls(id)}"><span class="mt-starts-none">-</span></td>`;
                // The count is the answer and the hint is the working behind it, one line per start. The days, opponents, difficulty and how a start went all live in the Schedule view, not behind a hover that has to be discovered.
                return `<td class="${cls(id)}"><span class="mt-starts">${entry.remaining}<span class="mt-starts-of">/${entry.starts}</span></span></td>`;
            }
            if (id === GAMES_COL && sport === 'ffl') {
                // Football shows the day and opponent and never a count, since a team plays once a week and a one-of-one answers nothing a bye does not. Four shapes, a bye as "Bye" alone, a TBD kickoff as "TBD" with the opponent named, otherwise the day and vs or at the opponent.
                const g = nextGameFor(playerId);
                if (!g) return `<td class="${cls(id)}"><span class="mt-starts-none">-</span></td>`;
                if (g.bye) return `<td class="${cls(id)}"><span class="mt-next-game mt-next-game-bye">Bye</span></td>`;
                const oppText = g.opponentAbbrev ? `${g.home ? 'vs' : 'at'} ${escapeHtml(g.opponentAbbrev)}` : '';
                // The line names the day only. The next-game label says "Sun night" for a primetime kickoff, and it is trimmed here.
        const dayText = g.tbd ? 'TBD' : escapeHtml(String(g.dayLabel || '').replace(/ night$/, ''));
                const text = [dayText, oppText].filter(Boolean).join(' &middot; ');
                return `<td class="${cls(id)}"><span class="mt-next-game">${text}</span></td>`;
            }
            if (id === GAMES_COL) {
                const w = gamesWindowFor(playerId);
                if (!w) return `<td class="${cls(id)}"><span class="mt-starts-none">-</span></td>`;
                // Left of total, the same shape the Starts column uses, since it is the same question and a manager should not change units between them. A club with no game this matchup reads 0/0 rather than a dash, because it is playing none, which is an answer. It reuses the Starts column's classes, same figure and same treatment.
                const days = w.byPeriod.filter(d => d.count).map(d => d.period).join(', ');
                const tip = days
                    ? `${w.remaining} of ${w.games} games left this ${axisUnit().long.toLowerCase()}. Plays ${escapeHtml(days)}.`
                    : `No games this ${axisUnit().long.toLowerCase()}.`;
                return `<td class="${cls(id)}"><span class="mt-starts" data-tooltip="${escapeHtml(tip)}">${w.remaining}<span class="mt-starts-of">/${w.games}</span></span></td>`;
            }
            if (id === POINTS_COL) {
                // The same windowed points the rank was computed from, so the column and the chip beside it can never tell different stories.
                const score = ranks.get(playerId)?.score;
                return `<td class="${cls(id)}"${score === undefined ? '' : pctStyle(id, score)}>${score === undefined ? '-' : Number(score).toFixed(1)}</td>`;
            }
            const v = basisTotalsOf(p)[id];
            if (v === undefined) return `<td class="${cls(id)}">-</td>`;
            return `<td class="${cls(id)}"${pctStyle(id, v)}>${avgSet.has(id) ? Number(v).toFixed(3) : Math.round(Number(v))}</td>`;
        }).join('');
    };
    const playerRow = (row, kind, ids, sortedId = null) => {
        const p = poolById.get(row.playerId) || AppState.playerData.find(x => x.id === row.playerId);
        // A bare id reads as broken data, so while the pool is on its way the row holds placeholders in the roster's own shape instead of the word "Loading...".
        const poolPending = !p && !AppState.playerDataLoaded;
        const name = p ? p.name : (AppState.playerDataLoaded ? `Player ${row.playerId}` : '');
        const pos = p ? (p.positionDisplay || p.positionName || '') : '';
        // A D/ST row's identity is its club, so it draws the same crest the leaderboard draws, keyed off the position label rather than the sign of the id. The abbreviation comes from the pro-team schedule fetch, which can still be in flight, and buildProTeamCrestHtml draws an empty tile for a falsy abbrev, so a resolved one is required before taking the crest path and the row otherwise keeps its initials tile.
        const dstAbbrev = p ? proSchedule.abbrevs?.get(Number(p.proTeamId)) : null;
        const avatarHtml = poolPending
            ? '<span class="sk sk-disc mt-sk-avatar"></span>'
            : (pos === 'D/ST' && dstAbbrev
                ? buildProTeamCrestHtml(sport, dstAbbrev)
                : buildPlayerAvatarHtml(sport, row.playerId, name));
        const bar = '<span class="sk mt-sk-bar"></span>';
        // The same fact the drill-down carries, on the row's title, since a roster table has no spare column for a sentence and a hover is where every other per-row detail on this tab lives.
        const draftedTitle = draftedFactText(draftPicksFor(), row.playerId, AppState.apiData?.teams);
        return `
            <tr class="mt-row mt-row-${kind}" data-player-id="${row.playerId}" title="${escapeHtml(draftedTitle)}">
                <td class="mt-slot"><span class="mt-slot-badge">${escapeHtml(slotLabel(sport, row.slot))}</span></td>
                <td class="mt-player">${avatarHtml}${poolPending ? '<span class="sk mt-sk-name"></span>' : `<span class="mt-name">${escapeHtml(name)}</span>`}${p ? injuryBadgeHtml(p.injuryStatus) : ''}${coverage ? `<button type="button" class="mt-row-drop" data-drop-entry-id="${row.playerId}" title="Drop ${escapeHtml(name)} for...">&#8646;</button>` : ''}</td>
                <td class="mt-pos">${escapeHtml(pos)}</td>
                <td class="mt-rankcell${sortedId === RANK_COL ? ' mt-sorted-col' : ''}">${poolPending ? bar : chip(row.playerId)}</td>
                ${poolPending ? statCells(row.playerId, ids, sortedId).replace(/(<td class="[^"]*">)-<\/td>/g, `$1${bar}</td>`) : statCells(row.playerId, ids, sortedId)}
                <td class="mt-fill"></td>
            </tr>`;
    };

    // Role-grouped, because a pitcher's line under batting headers says nothing and one header row cannot serve both. splitStatIdsByRole owns which categories belong to which group, the same split the heatmap and the recap already order by, so this adds no third opinion.
    const byRole = splitStatIdsByRole(sport, scoredIds);
    const pitcherSlots = new Set(sport === 'flb' ? [13, 14, 15] : [5]);
    // A two-way player is eligible in both groups, so the SLOT occupied decides which section the row reads in. That is the role the team is actually using this week.
    const sectionFor = (row) => {
        const p = poolById.get(row.playerId) || AppState.playerData.find(x => x.id === row.playerId);
        if (!p) return pitcherSlots.has(row.slot) ? 'secondary' : 'primary';
        const g = playerRoleGroups(p, sport);
        if (g.secondary && !g.primary) return 'secondary';
        if (g.primary && !g.secondary) return 'primary';
        return pitcherSlots.has(row.slot) ? 'secondary' : 'primary';
    };

    // Role labels come from the validated per-sport table in players.js, so a football roster's D/ST group does not inherit hockey's word from a second copy that can drift.
    const groupLabel = { primary: roleGroupLabel(sport, false), secondary: roleGroupLabel(sport, true) };
    const irLabel = sport === 'flb' ? 'Injured list' : 'Injured reserve';

    // What the layout is computed from, how many player rows each group draws and how many band separators sit among them, counted before anything renders so the layout never asks the DOM what it produced. A sorted group draws no band rows. Whether a group can show a Schedule face is static across a face flip, so a floor keyed to it does not jar the other group.
    const canScheduleFor = (role) => (role === 'secondary' && projected)
        || !!(nightSchedule && nightSchedule[role] && nightSchedule[role].byPeriod.length > 0);
    const rowCountsFor = (role) => {
        const pick = (rows) => rows.filter(r => sectionFor(r) === role);
        const starters = pick(groups.starters), bench = pick(groups.bench);
        const injured = pick(groups.injured), orphans = pick(groups.orphans);
        const players = starters.length + bench.length + injured.length + orphans.length;
        if (!players) return null;
        const bands = groupSort[role] ? 0 : [bench, injured, orphans].filter(b => b.length).length;
        return { players, bands, canSchedule: canScheduleFor(role) };
    };
    const rowCounts = { primary: rowCountsFor('primary'), secondary: rowCountsFor('secondary') };

    // The row height is budgeted against the league's roster, not the team on screen. Sized to the team in front of it, the band gave a different row height to every team because occupancy varies. lineupSlotCounts is what every team is allowed, IL slots included, so a height computed from it fits the fullest roster the league permits, and teams under capacity spend the difference as space between the tables.
    const slotCounts = AppState.apiData.settings?.rosterSettings?.lineupSlotCounts || {};
    const benchSlots = NON_STARTING_SLOTS[sport] || new Set();
    const capacity = Object.keys(slotCounts).reduce((sum, id) => sum + (slotCounts[id] > 0 ? slotCounts[id] : 0), 0);
    const rosterBudget = {
        // Never below what is actually on screen. A league whose settings did not parse would otherwise budget zero rows and hand back a row height that fits nothing.
        capacity: Math.max(capacity, (rowCounts.primary?.players || 0) + (rowCounts.secondary?.players || 0)),
        // Bands are budgeted the same way, from what the league rosters and not what this team filled, so the bench and IL headers a group can show are counted, not only the ones it happens to show.
        bands: [...benchSlots].filter(s => slotCounts[s] > 0).length
    };

    // Each group is its own table with its own columns and its own bench, so bench belongs to the role group it plays for rather than to a single pile at the bottom of the roster.
    const renderGroup = (role) => {
        const ids = [
            ...(AppState.isPointsLeague ? [POINTS_COL] : []),
            // Pitchers only, and only when the probables feed actually produced starts for this roster. Hockey publishes none, so the column never appears there.
            ...(role === 'secondary' && projected ? [STARTS_COL] : []),
            // EVERY role, not just pitchers: how many games a club has left this matchup is the question a batter's start/sit turns on too, and it is the one column that never existed.
            ...(hasGamesWindow ? [GAMES_COL] : []),
            ...(role === 'primary' ? byRole.primary : byRole.secondary)
        ];
        const pick = (rows) => rows.filter(r => sectionFor(r) === role);
        const starters = pick(groups.starters);
        const bench = pick(groups.bench);
        const injured = pick(groups.injured);
        const orphans = pick(groups.orphans);
        if (!starters.length && !bench.length && !injured.length && !orphans.length) return '';
        statSpan = new Map();
        for (const r of [...starters, ...bench, ...injured, ...orphans]) {
            const pl = poolById.get(r.playerId);
            if (!pl) continue;
            const totals = basisTotalsOf(pl);
            ids.forEach((id) => {
                const v = id === POINTS_COL ? ranks.get(r.playerId)?.score : totals[id];
                if (v === undefined || v === null || !Number.isFinite(Number(v)) || id === STARTS_COL || id === GAMES_COL) return;
                const cur = statSpan.get(String(id));
                const n = Number(v);
                if (!cur) statSpan.set(String(id), { min: n, max: n });
                else { if (n < cur.min) cur.min = n; if (n > cur.max) cur.max = n; }
            });
        }
        const band = (rows, kind, label) => rows.length
            ? `<tr class="mt-band-head"><td colspan="${5 + ids.length}">${escapeHtml(label)}</td></tr>${rows.map(r => playerRow(r, kind, ids, sortedIdFor(role))).join('')}`
            : '';

        // Sorting a group asks a question about the whole group, so it ranks starters, bench and IL together and the slot bands step aside while it does. Inverse categories sort so that "descending" still means BEST first, which is what a fantasy manager means by it.
        const sort = groupSort[role];
        let body;
        if (sort && (ids.includes(sort.statId) || sort.statId === RANK_COL)) {
            const all = [...starters, ...bench, ...injured, ...orphans];
            const valueOf = (r) => {
                const entry = ranks.get(r.playerId);
                if (sort.statId === RANK_COL) return entry ? entry.rank : null;
                if (sort.statId === POINTS_COL) return entry && entry.score !== undefined ? entry.score : null;
                // Sorted on what is LEFT rather than the total, since that is the number the column leads with and the one a manager is deciding against.
                if (sort.statId === STARTS_COL) {
                    const s = projected && projected.byPlayer.get(r.playerId);
                    return s ? s.remaining : null;
                }
                if (sort.statId === GAMES_COL) {
                    const w = gamesWindowFor(r.playerId);
                    return w ? w.remaining : null;
                }
                const p = poolById.get(r.playerId);
                const v = basisTotalsOf(p)[sort.statId];
                return v === undefined ? null : Number(v);
            };
            // Rank counts UP toward worse, like an inverse category. "Descending" means best first everywhere in this table, which is what a fantasy manager means by it.
            const inverse = sort.statId === RANK_COL || leagueInverseIds(sport).has(String(sort.statId));
            const sorted = all.slice().sort((a, b) => {
                const av = valueOf(a), bv = valueOf(b);
                // A player with no value in the category sits at the bottom either way, rather than reading as the best or the worst at it.
                if (av === null && bv === null) return 0;
                if (av === null) return 1;
                if (bv === null) return -1;
                const better = inverse ? av - bv : bv - av;
                return sort.dir === 'desc' ? better : -better;
            });
            body = sorted.map(r => playerRow(r, 'sorted', ids, sort.statId)).join('');
        } else {
            body = `${starters.map(r => playerRow(r, 'start', ids, sortedIdFor(role))).join('')}
                    ${band(bench, 'bench', 'Bench')}
                    ${band(injured, 'ir', irLabel)}
                    ${band(orphans, 'other', 'Other')}`;
        }

        const head = (id) => {
            const active = sort && sort.statId === id;
            const arrow = active ? (sort.dir === 'desc' ? '▼' : '▲') : '';
            const hint = id === STARTS_COL
                ? ` data-hint="Projected starts this ${escapeHtml(axisUnit().long.toLowerCase())}, still to come out of the total. From ESPN's probable pitchers, so it moves with rotations and injuries. The Schedule view lays out which day each one falls on."`
                : id === GAMES_COL
                    ? (sport === 'ffl'
                        ? ` data-hint="The day and opponent of this player's own game inside the matchup - Bye on a bye week, TBD where the kickoff is not yet set."`
                        : ` data-hint="Games the club plays this ${escapeHtml(axisUnit().long.toLowerCase())}, still to come out of the total. Off the league's own matchup days and the pro schedule. Each figure lists the days."`)
                    : '';
            return `<th class="mt-stat mt-sortable${active ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${id}"${hint}
                        tabindex="0" role="button" title="Sort ${escapeHtml(colLabel(id))}">${escapeHtml(colLabel(id))}<span class="mt-arrow">${arrow}</span></th>`;
        };

        // The pitchers get a second face on baseball only when there are starts to lay out, so the tabs do not appear on a hockey roster and switch to an empty calendar. Every other calendar group's gate is the night schedule itself, so a group with nothing ahead in the window gets no switch to an empty face.
        const isCalendarGroup = nightSchedule && nightSchedule[role];
        const canSchedule = canScheduleFor(role);
        const view = isCalendarGroup ? calendarView[role] : pitchingView;
        const tabs = canSchedule
            ? `<div class="mt-view-tabs" role="tablist">
                   <button class="mt-view-tab${view === 'categories' ? ' active' : ''}" data-role="${role}" data-view="categories" role="tab" aria-selected="${view === 'categories'}">Categories</button>
                   <button class="mt-view-tab${view === 'schedule' ? ' active' : ''}" data-role="${role}" data-view="schedule" role="tab" aria-selected="${view === 'schedule'}">Schedule</button>
               </div>`
            : '';

        const table = `
                <table class="mt-table">
                    <thead><tr>
                        <th class="mt-slot">Slot</th><th class="mt-player">Player</th><th class="mt-pos">Pos</th><th class="mt-rankcell mt-sortable${sort && sort.statId === RANK_COL ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${RANK_COL}"
                            tabindex="0" role="button" title="Sort Overall Rank">Overall Rank<span class="mt-arrow">${sort && sort.statId === RANK_COL ? (sort.dir === 'desc' ? '▼' : '▲') : ''}</span></th>
                        ${ids.map(head).join('')}
                        <th class="mt-fill"></th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                </table>`;

        const face = canSchedule && view === 'schedule'
            ? (isCalendarGroup ? renderNightCalendar(role) : renderSchedule())
            : table;

        return `
            <div class="mt-group" data-role="${role}">
                <div class="mt-group-head">${escapeHtml(groupLabel[role])}${tabs}</div>
                ${face}
            </div>`;
    };

    // The matchup laid out by day, one column per day, each start a card under its day. Days run across because the question is what happens on a given day, and the grid's width stays the same for a roster with two starts or eleven, so the band's height does not chase the roster.
    function renderSchedule() {
        const win = currentMatchupWindow(matchupPeriodMap(), AppState.apiData.scoringPeriodId);
        if (!win) return '<div class="mt-note">No matchup is in progress, so there is nothing to lay out.</div>';
        const today = Number(AppState.apiData.scoringPeriodId) || win.start;
        // The league's own matchup number (never a calendar week, per the schedule-insight contract's own rendering note), named once here and read by every start-count badge below.
        const matchupLabel = win.matchup != null ? `Matchup ${win.matchup}` : '';

        // Seven days at the one-week card size, whatever the matchup's real length, since squeezing a two-week round into one band meant each column scrolling inside itself. pageStart and pageEnd bound only the grid's day columns, while byDay and everything the two-start badges and drawer read still walk the whole matchup.
        const matchupSpan = win.end - win.start + 1;
        const paged = matchupSpan > 7;
        const maxPageStart = win.end - 6;
        const storedStart = AppState.myTeamScheduleWindowStart;
        // The stored start survives only while it still names a real page of this matchup. A fresh matchup or a stale pin from a shorter one falls back to the window that holds today.
        const pinnedStart = (storedStart !== null && storedStart >= win.start && storedStart <= maxPageStart)
            ? storedStart
            : today;
        const pageStart = paged ? Math.max(win.start, Math.min(maxPageStart, pinnedStart)) : win.start;
        const pageEnd = paged ? pageStart + 6 : win.end;

        // period -> [{ playerId, name, game, difficulty }]
        const byDay = new Map();
        for (let p = win.start; p <= win.end; p++) byDay.set(p, []);
        projected.byPlayer.forEach((entry, playerId) => {
            const row = entries.find(e => e.playerId === playerId);
            const pool = poolById.get(playerId);
            entry.games.forEach((g, i) => {
                if (!byDay.has(g.period)) return;
                const prev = i > 0 ? entry.games[i - 1] : null;
                const rest = prev ? daysBetween(prev.date, g.date) : null;
                // Scored whether or not it has happened. A completed start still shows what the matchup rated beforehand, since "this went badly against a lineup we called easy" is the reading a manager actually wants back.
                const scored = offence
                    ? startDifficulty(g, offence, null, { restDays: rest, parkFactors: parkTable })
                    : null;
                byDay.get(g.period).push({
                    playerId,
                    name: (pool && pool.name) || (row && row.name) || 'Unknown',
                    game: g,
                    rest,
                    forecast: scored,
                    difficulty: g.played ? null : scored
                });
            });
        });

        // A day's date comes from the SCHEDULE, not from the starts on it. Reading it off the starts left every day this roster happens not to pitch on labelled "Day 128", which is the label for a day nobody can date rather than a day nothing happens on.
        const dateByPeriod = new Map();
        proSchedule.index?.forEach(g => {
            if (g.date && !dateByPeriod.has(g.period)) dateByPeriod.set(g.period, g.date);
        });
        const dayLabel = (period) => {
            const ms = dateByPeriod.get(period);
            if (!ms) return `Day ${period}`;
            const d = new Date(ms);
            return `${d.toLocaleDateString(undefined, { weekday: 'short' })}<span class="mt-cal-date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
        };

        const cols = [];
        for (let p = pageStart; p <= pageEnd; p++) {
            const starts = byDay.get(p);
            // At a glance: who, against whom, and how hard as a COLOUR rather than a word. The word costs a line of type in every card and says less than the shade does at a glance; it is spelled out in the panel a click away, where there is room to justify it.
            const cards = starts.map(s => {
                const key = `${s.playerId}:${s.game.period}`;
                const abbrev = s.game.opponentId != null ? proSchedule.abbrevs?.get(s.game.opponentId) : null;
                const opp = abbrev ? `${s.game.isHome ? 'vs' : '@'}${abbrev}` : '';
                const label = s.game.played ? 'Complete' : (s.difficulty ? difficultyLabel(s.difficulty.score) : 'No read');
                const tint = (!s.game.played && s.difficulty) ? ` style="--diff: ${s.difficulty.score.toFixed(1)}"` : '';
                const state = s.game.played ? ' mt-cal-done' : (s.difficulty ? ' mt-cal-scored' : ' mt-cal-noread');
                // The market's number, one glance wide, and only when there is one. Odds cover today's slate alone, so most cards carry nothing here and must read as though the line was never part of the design.
                const line = s.game.played ? null : moneylineForStart(s);
                const odds = line ? `<span class="mt-cal-ml">${escapeHtml(line.price)}</span>` : '';
                // The two-start badge rides on every card of a pitcher with two or more starts, not just the second, so a manager looking at either day learns the same fact. The start count names its matchup through the panel's header line, which is the context every card already sits inside.
                const twoStartEntry = twoStart && twoStart.byPlayer.get(s.playerId);
                const twoStartBadge = twoStartEntry && twoStartEntry.starts >= 2
                    ? `<span class="mt-cal-2start" data-tooltip="${escapeHtml(matchupLabel)}">${twoStartEntry.starts} starts</span>`
                    : '';
                return `<button class="mt-cal-start${state}${openStartKey === key ? ' open' : ''}"
                            data-start="${escapeHtml(key)}"${tint}
                            title="${escapeHtml(s.name)}${opp ? ' ' + opp : ''}, ${escapeHtml(label)}">
                            <span class="mt-cal-name">${escapeHtml(s.name)}${twoStartBadge}</span>
                            <span class="mt-cal-opp">${escapeHtml(opp)}${odds}</span>
                        </button>`;
            }).join('');
            cols.push(`<div class="mt-cal-day${p === today ? ' mt-cal-today' : ''}${p < today ? ' mt-cal-past' : ''}">
                           <div class="mt-cal-head">${dayLabel(p)}</div>
                           <div class="mt-cal-body">${cards}</div>
                       </div>`);
        }

        // The open start's arithmetic, laid out the way the drill-down lays out a rank score: what it was compared against, what each column means, then the table that demonstrates it.
        let breakdown = '<div class="mt-cal-hint">Pick a start to see its matchup and exactly how it was scored.</div>';
        // Reading a start replaces the day grid rather than sharing the group with it. The pitching group's height is reserved once, so showing both left the breakdown a sliver of the room it needs, and trading the grid for it spends the same room on whichever is being read.
        let reading = false;
        if (openStartKey) {
            const [pid, per] = openStartKey.split(':');
            const found = (byDay.get(Number(per)) || []).find(s => String(s.playerId) === pid);
            if (found) {
                breakdown = difficultyBreakdownHtml(found);
                reading = true;
            }
        }

        // The way back has to be in the breakdown itself, because the card that toggles it closed is one the grid just gave up room for. The back control lives inside the panel so it costs no extra row of height. The step chevrons move one day at a time and are absent on a one-week matchup rather than disabled.
        const prevArrow = paged
            ? `<button type="button" class="chrome-arrow mt-cal-page-prev" data-cal-page-start="${pageStart}" data-cal-step="-1" aria-label="Earlier in the matchup"${pageStart <= win.start ? ' disabled' : ''}>&#8249;</button>`
            : '';
        const nextArrow = paged
            ? `<button type="button" class="chrome-arrow mt-cal-page-next" data-cal-page-start="${pageStart}" data-cal-step="1" aria-label="Later in the matchup"${pageEnd >= win.end ? ' disabled' : ''}>&#8250;</button>`
            : '';
        return `<div class="mt-cal${reading ? ' mt-cal-reading' : ''}">
                    <div class="mt-cal-row">
                        ${prevArrow}
                        <div class="mt-cal-grid">${cols.join('')}</div>
                        ${nextArrow}
                    </div>
                    ${breakdown}
                </div>`;
    }

    // The Schedule face shared by hockey, baseball and football, the pitchers' calendar generalised to players who play whole games rather than starts, so it has no moneyline, two-start badge or breakdown panel. Hockey asks who plays and baseball and football ask who sits. The column shell is shared and the body and pager are not.
    function renderNightCalendar(role) {
        const sched = nightSchedule && nightSchedule[role];
        if (!sched || !sched.byPeriod.length) return '<div class="mt-note">No nights ahead in this round.</div>';
        const isBatters = sport === 'flb';
        const isFootball = sport === 'ffl';
        const periods = sched.byPeriod.map(d => d.period);
        const todayPeriod = Number(AppState.apiData.scoringPeriodId) || null;

        // The date label is split across two lines, the same shape the pitchers' dayLabel uses. The weekday comes from nights.labelOf, which carries the extrapolation for a period the pro schedule has not dated, and a calendar date is printed only for a period that has one. Football's column names a week, which has no single date, so it reads "Week N".
        const dayLabel = (period) => {
            if (isFootball) return `Week ${escapeHtml(String(period))}`;
            const label = nights.labelOf ? nights.labelOf(period) : String(period);
            const ms = proSchedule.dates?.get(period);
            const dateSpan = Number.isFinite(Number(ms))
                ? `<span class="mt-cal-date">${new Date(Number(ms)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`
                : '';
            return `${escapeHtml(label)}${dateSpan}`;
        };

        // The game day comes from the night schedule's raw gameDate, read in the viewer's local time and never UTC, since a late kickoff crosses midnight in UTC and a Thursday game would print as Friday. "Sun night" is the only slot that needs a second signal, because the early and late Sunday windows are both just Sun to a lineup lock.
        const gameDayLabel = (ms) => {
            if (!Number.isFinite(Number(ms))) return null;
            const d = new Date(Number(ms));
            const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
            // The day only, so a primetime Sunday kickoff is "Sun" here as it is in the next-game cell. The pure label in schedule-insight.js is untouched.
            return weekday;
        };

        let pageDays, paged, prevArrow, nextArrow;
        if (isBatters) {
            const minP = periods[0], maxP = periods[periods.length - 1];
            paged = (maxP - minP + 1) > 7;
            const maxPageStart = maxP - 6;
            const storedStart = AppState.myTeamScheduleWindowStart;
            const pinnedStart = (storedStart !== null && storedStart >= minP && storedStart <= maxPageStart)
                ? storedStart
                : (todayPeriod ?? minP);
            const pageStart = paged ? Math.max(minP, Math.min(maxPageStart, pinnedStart)) : minP;
            const pageEnd = paged ? pageStart + 6 : maxP;
            const byPeriodMap = new Map(sched.byPeriod.map(d => [d.period, d]));
            pageDays = [];
            for (let p = pageStart; p <= pageEnd; p++) {
                pageDays.push(byPeriodMap.get(p) || { period: p, players: [], idlePlayers: [], playing: 0, idle: 0 });
            }
            prevArrow = paged
                ? `<button type="button" class="chrome-arrow mt-cal-page-prev" data-cal-page-start="${pageStart}" data-cal-step="-1" aria-label="Earlier in the matchup"${pageStart <= minP ? ' disabled' : ''}>&#8249;</button>`
                : '';
            nextArrow = paged
                ? `<button type="button" class="chrome-arrow mt-cal-page-next" data-cal-page-start="${pageStart}" data-cal-step="1" aria-label="Later in the matchup"${pageEnd >= maxP ? ' disabled' : ''}>&#8250;</button>`
                : '';
        } else {
            paged = periods.length > 7;
            // Skaters and Goalies, or Players and D/ST, page together on one pager, so indexCalPage is a single module-level period read here rather than kept per role.
            let startIdx = 0;
            if (paged) {
                const maxStartIdx = periods.length - 7;
                const pinIdx = (indexCalPage !== null && periods.includes(indexCalPage))
                    ? periods.indexOf(indexCalPage)
                    : (todayPeriod !== null && periods.includes(todayPeriod) ? periods.indexOf(todayPeriod) : 0);
                startIdx = Math.max(0, Math.min(maxStartIdx, pinIdx));
            }
            pageDays = paged ? sched.byPeriod.slice(startIdx, startIdx + 7) : sched.byPeriod;
            prevArrow = paged
                ? `<button type="button" class="chrome-arrow mt-nc-page-prev" data-nc-step="-1" aria-label="Earlier in the round"${startIdx <= 0 ? ' disabled' : ''}>&#8249;</button>`
                : '';
            nextArrow = paged
                ? `<button type="button" class="chrome-arrow mt-nc-page-next" data-nc-step="1" aria-label="Later in the round"${startIdx + 7 >= periods.length ? ' disabled' : ''}>&#8250;</button>`
                : '';
        }

        // A playing hitter's chip carries the opponent plus, where ESPN posted one, the batting order, and never a difficulty tone, which would read the opposing starter. A football chip carries the game day instead. The club edge is hockey only, read by club and opponent id and never a name match, and the column is reserved only if some chip in the group has an edge.
        const edgesOn = sport === 'fhl';
        if (edgesOn) startClubHarvestOnce(sport);
        const edgesLoading = edgesOn && clubEdgeStatus().loading;
        const clubOfPlayer = edgesOn ? new Map((AppState.playerData || []).map(pl => [pl.id, pl.proTeamId])) : null;
        const edgeFor = (p) => {
            if (!edgesOn || edgesLoading || p.opponentId == null || p.isHome == null) return null;
            const mine = clubOfPlayer.get(p.id);
            if (mine == null) return null;
            const g = clubEdgesForGame(p.isHome ? { home: mine, away: p.opponentId } : { home: p.opponentId, away: mine }, { minGames: CLUB_EDGE_MIN_GAMES });
            if (!g) return null;
            const keys = role === 'secondary' ? ['shotsFaced'] : ['shots', 'goals'];
            const side = p.isHome ? g.home : g.away;
            const edges = keys.map(k => side.find(e => e.key === k)).filter(Boolean);
            if (!edges.length) return null;
            const table = clubEdgeTable({ minGames: CLUB_EDGE_MIN_GAMES });
            const gamesOf = (id) => { const c = table && table.clubs.get(Number(id)); return c ? c.games : 0; };
            return { edges, seasoned: Math.min(gamesOf(mine), gamesOf(p.opponentId)) >= CLUB_EDGE_TINT_GAMES };
        };
        const edgeInfo = new Map();
        if (edgesOn) pageDays.forEach(day => day.players.forEach(p => edgeInfo.set(p, edgeFor(p))));
        const groupHasEdges = [...edgeInfo.values()].some(Boolean);
        const edgeSlotOn = edgesLoading || groupHasEdges;
        const edgeHtml = (p) => {
            if (!edgeSlotOn) return '';
            if (edgesLoading) return `<span class="mt-nc-edge">${(role === 'secondary' ? [0] : [0, 1]).map(() => '<i class="mt-nc-bar sk"></i>').join('')}</span>`;
            const info = edgeInfo.get(p);
            if (!info) return '<span class="mt-nc-edge"></span>';
            const bars = info.edges.map(e => {
                const frac = Math.min(1, Math.abs(e.gap) / CLUB_EDGE_FULL[e.key]);
                const tone = info.seasoned ? clubEdgeTone(e) : null;
                const fill = e.ahead ? `<i class="mt-nc-bar-fill ${e.ahead === 'mine' ? 'to-mine' : 'to-theirs'}" style="--frac:${(frac * 100).toFixed(1)}"></i>` : '';
                return `<i class="mt-nc-bar${tone ? ` is-${tone}` : ''}">${fill}</i>`;
            }).join('');
            return `<span class="mt-nc-edge">${bars}</span>`;
        };
        const edgeTooltip = (p) => {
            const info = edgeInfo.get(p);
            return info ? info.edges.map(e => `${CLUB_EDGE_LABEL[e.key]} ${clubEdgeSigned(e.gap, e.key)}: ${clubEdgeNumber(e.mine.value, e.key)} (#${e.mine.rank}) vs ${clubEdgeNumber(e.theirs.value, e.key)} (#${e.theirs.rank})`).join(NEWLINE) : '';
        };

        const playingChip = (p) => {
            const surname = surnameOf(p.name);
            const abbrev = p.opponentId != null ? proSchedule.abbrevs?.get(p.opponentId) : null;
            const opp = abbrev ? `${p.isHome ? 'vs' : '@'}${abbrev}` : '';
            const orderHtml = isBatters && p.lineupOrder != null
                ? `<span class="mt-nc-chip-order">${escapeHtml(String(p.lineupOrder))}</span>`
                : '';
            const dayHtml = isFootball && p.gameDate != null && gameDayLabel(p.gameDate)
                ? `<span class="mt-nc-chip-day">${escapeHtml(gameDayLabel(p.gameDate))}</span>`
                : '';
            // The expected start is shown the way the pitcher card shows the probable, plain when ESPN has posted nothing. A skater almost never carries the field, so it reads as a goalie-only badge, and baseball's starterStatus values never match so it stays silent there without a sport check.
            const status = p.starterStatus === 'CONFIRMED' ? 'Confirmed'
                : p.starterStatus === 'EXPECTED' ? 'Expected' : null;
            const statusHtml = status ? `<span class="mt-nc-chip-status">${status}</span>` : '';
            // The night difficulty is for goalie chips only, from goalieNightDifficulty's measurement. A skater's night moves by a tenth of a shot, not worth a tone. It uses the same ramp as the pitcher card's tint so a hard night reads the same colour everywhere, and the hover is the model's evidence line, never a verdict.
            const diff = (role === 'secondary' && shotVolume)
                ? goalieNightDifficulty({ opponentId: p.opponentId, isHome: p.isHome }, shotVolume, { starterStatus: p.starterStatus })
                : null;
            const tint = diff ? ` style="--diff: ${diff.score.toFixed(1)}"` : '';
            const toneClass = diff ? ' mt-nc-chip-scored' : '';
            // One line, the word difficultyLabel gives, the opponent's shot volume as the percentile the model reads, and the home or road adjustment when it applies. Never a league rank, because the band is that percentile moved by the ice term and a rank beside it can contradict the word.
            const shotsPart = diff ? diff.parts.find(part => part.key === 'shots') : null;
            const icePart = diff ? diff.parts.find(part => part.key === 'ice') : null;
            const evidence = diff
                ? `${difficultyLabel(diff.score)}: opponent shot volume ${ordinal(shotsPart.value)} percentile${icePart ? `, ${icePart.isHome ? 'home ice' : 'on the road'} ${icePart.value > 0 ? '+' : '-'}${Math.abs(Math.round(icePart.value))}` : ''}`
                : '';
            const tipText = [evidence, edgeTooltip(p)].filter(Boolean).join(NEWLINE);
            const tooltip = tipText ? ` data-tooltip="${escapeHtml(tipText)}"` : '';
            return `<span class="mt-nc-chip${toneClass}"${tint}${tooltip}>
                        <span class="mt-nc-chip-name">${escapeHtml(surname)}${orderHtml}${statusHtml}</span>
                        ${edgeHtml(p)}
                        <span class="mt-nc-chip-opp">${escapeHtml(opp)}${dayHtml}</span>
                    </span>`;
        };

        const cols = pageDays.map(day => {
            const isToday = todayPeriod !== null && day.period === todayPeriod;
            const isLightest = sched.lightestPeriod != null && day.period === sched.lightestPeriod;
            // A column lists only the players playing. Listing every off or bye player first grew the column past its reserved height and read as a roll call of who is not playing, so every sport uses hockey's shape. Every playing player gets a chip and never a "+N more". fitNightCalendars keeps a full week of chips inside the box by compacting and then arranging them two to a row.
            const chips = day.players.map(playingChip).join('');
            const body = day.players.length ? chips : `<span class="mt-nc-empty">No games</span>`;
            // The off players fold to one line, with the names in its title, rather than a wall of their own chips. The count is the fact that matters and the full roster is one hover away.
            const idleWord = isFootball ? 'bye' : (isBatters ? 'off' : 'idle');
            const idleNames = (day.idlePlayers || []).map(p => surnameOf(p.name)).join(', ');
            const foot = day.idle > 0
                ? `<div class="mt-nc-foot" title="${escapeHtml(idleNames)}">${day.idle} ${idleWord}</div>`
                : '';
            // A batters' or football column goes red when two or more sit idle or on bye, since a full lineup is the norm. Hockey's column goes red at zero playing, where a fully empty night is the alert.
            const alert = (isBatters || isFootball) ? (sched.players - day.playing) >= 2 : day.playing === 0;
            return `<div class="mt-nc-col${isToday ? ' mt-nc-col-today' : ''}${isLightest ? ' mt-nc-col-light' : ''}">
                        <div class="mt-nc-head${alert ? ' mt-nc-head-alert' : ''}">
                            <span class="mt-nc-daylabel">${dayLabel(day.period)}</span>
                            <span class="mt-nc-count">${day.playing} of ${sched.players}</span>
                        </div>
                        <div class="mt-nc-body">${body}</div>
                        ${foot}
                    </div>`;
        }).join('');

        // The round's lightest night, most-idle day or most-bye week is ringed on its own column, and named here as well when that column is on a page not showing, since a ring nobody can see teaches nothing. The header repeats the idle or bye count for baseball and football so a reader need not flip pages for the number behind the ring.
        const lightestOffPage = sched.lightestPeriod != null && !pageDays.some(d => d.period === sched.lightestPeriod);
        const lightestNote = lightestOffPage
            ? (() => {
                const day = sched.byPeriod.find(d => d.period === sched.lightestPeriod);
                const when = dayLabel(sched.lightestPeriod).replace(/<[^>]+>/g, ' ').trim();
                if (isFootball && day) return `<div class="mt-nc-header">Most byes: ${when}, ${sched.players - day.playing} of ${sched.players}</div>`;
                if (isBatters && day) return `<div class="mt-nc-header">Most idle: ${when}, ${sched.players - day.playing} of ${sched.players}</div>`;
                return `<div class="mt-nc-header">Lightest night of the round: ${when}</div>`;
            })()
            : '';

        return `<div class="mt-nc${edgeSlotOn ? ' mt-nc-edges' : ''}${edgesLoading ? ' mt-nc-pending' : ''}">
                    ${lightestNote}
                    <div class="mt-nc-row">
                        ${prevArrow}
                        <div class="mt-nc-grid">${cols}</div>
                        ${nextArrow}
                    </div>
                </div>`;
    }

    // A start's own day, from the per-day buckets the bulk fetch keeps for pitchers. Null when the weekly data has not arrived, or when nothing was recorded that day, which is a start that was scratched after ESPN listed it rather than a start with a line of zeroes. The same rule the stat cells use, so a value reads identically wherever it appears.
    const formatStat = (id, v) => (avgSet.has(id) ? Number(v).toFixed(3) : String(Math.round(Number(v))));

    function actualLineFor(playerId, period) {
        const daily = AppState.playerWeeklyCache?.[playerId]?.dailyByPeriod;
        const day = daily && daily[period];
        if (!day || !day.sums) return null;
        const ids = byRole.secondary.filter(id => day.sums[id] !== undefined);
        if (!ids.length) return null;
        return ids.map(id => ({ id, label: statMap[id] || id, value: day.sums[id] }));
    }

    const moneylineForStart = (s) => (AppState.showBettingOdds && scoreboardOdds.index && s.game.id
        ? moneylineFor(scoreboardOdds.index, s.game.id, s.game.isHome)
        : null);

    // The market's read sits next to the model's and never inside it. A moneyline already prices the park, the lineup and the rest, so folding it into the difficulty score would double-count them. It is credited to its provider and only the price is rendered, never the sportsbook links. It is short, the number, which side of the line it is, and the credit, since the card already establishes whose side it is.
    const moneylineFootHtml = (s) => {
        const line = moneylineForStart(s);
        if (!line) return '';
        const sense = line.favored === null ? '' : (line.favored ? ' favoured' : ' underdog');
        const via = line.provider ? ` &middot; ${escapeHtml(line.provider)}` : '';
        return `<span class="mt-diff-credit">Line ${escapeHtml(line.price)}${escapeHtml(sense)}${via}</span>`;
    };

    // Both credits on one line, as data rather than prose. Empty when there is neither, so a hockey card or a start with no line carries no empty rule across its foot.
    const creditFootHtml = (s) => {
        // Never on a start that has already happened. A moneyline is a forecast, and beside a result it is a price on a question already answered.
        const market = s.game.played ? '' : moneylineFootHtml(s);
        const parks = parkTable ? '<span class="mt-diff-credit">Parks &middot; Baseball Savant</span>' : '';
        if (!market && !parks) return '';
        return `<div class="mt-diff-foot">${market}${parks}</div>`;
    };

    // The one line under the verdict names the start rather than describing it, and the venue replaces "at home" and "on the road". The trail is the navigation. Every earlier crumb is a click target and the tail is the panel's title. It replaces stacked back buttons because Schedule returns from any depth, which a one-step control could not do.
    const crumbsHtml = (crumbs) => `
        <div class="mt-diff-crumbs">${crumbs.map((c, i) => `
            ${i ? '<span class="mt-crumb-sep">&rsaquo;</span>' : ''}
            ${c.to
                ? `<button type="button" class="mt-crumb" data-crumb="${c.to}">${escapeHtml(c.label)}</button>`
                : `<span class="mt-crumb-here">${escapeHtml(c.label)}</span>`}`).join('')}
        </div>`;

    // What the card's own crumb says: the pitcher and the opponent faced, which is how a reader names the start they clicked. Shared so the trail reads the same from every panel below it.
    const startCrumb = (s) => {
        const abbrev = s.game.opponentId != null ? proSchedule.abbrevs?.get(s.game.opponentId) : null;
        return `${s.name}${abbrev ? ` ${s.game.isHome ? 'vs' : 'at'} ${abbrev}` : ''}`;
    };

    const startSubline = (s, venue) => {
        const abbrev = s.game.opponentId != null ? proSchedule.abbrevs?.get(s.game.opponentId) : null;
        const when = s.game.date
            ? new Date(s.game.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
            : `Day ${s.game.period}`;
        const versus = abbrev ? `${s.game.isHome ? 'vs' : 'at'} ${abbrev}` : 'opponent unknown';
        const place = venue || (s.game.isHome ? 'at home' : 'on the road');
        return `<div class="mt-diff-sub">${escapeHtml(s.name)} ${escapeHtml(versus)}
                    &middot; ${escapeHtml(when)} &middot; ${escapeHtml(place)}</div>`;
    };

    // Score and label in the difficulty colour the cards already carry, over a 0-100 meter. The sentence this replaces ("Scores 77 of 100, Hard") spent a line saying what the meter shows. The score and the meter share one element, because they share the colour. --diff-hue is computed once here and read by both; on separate siblings the meter would inherit nothing.
    const verdictHtml = (score, label) => `
        <div class="mt-diff-verdict" style="--diff: ${score.toFixed(1)}">
            <div class="mt-diff-vline">
                <span class="mt-diff-score">${score.toFixed(0)}</span>
                <span class="mt-diff-vlabel">${escapeHtml(label)}</span>
            </div>
            <div class="mt-diff-meter"><span style="width: ${Math.max(0, Math.min(100, score)).toFixed(1)}%"></span></div>
        </div>`;

    // A component row has a label, a visual sized to what it measures, and the signed points. The two with evidence behind them are buttons with a chevron, and the explanation lives in the panel the row opens rather than in a tooltip over the row.
    const componentRowHtml = (p) => {
        const signed = `${p.value > 0 ? '+' : ''}${p.value.toFixed(1)}`;
        if (p.key === 'offence') {
            const pct = Math.max(0, Math.min(100, p.value));
            return `<button type="button" class="mt-diff-row" data-drill="lineup">
                        <span class="mt-diff-rlabel">Lineup strength<span class="mt-diff-chev">&rsaquo;</span></span>
                        <span class="mt-diff-track"><span class="mt-diff-fill" style="width: ${pct.toFixed(1)}%"></span></span>
                        <span class="mt-diff-rval">${p.value.toFixed(1)}</span>
                    </button>`;
        }
        if (p.key === 'park') {
            // The bar diverges from a neutral centre so direction reads before the number does. It is scaled against the widest park in the table because the bar is about the venue, and the points are already in the column beside it.
            const dev = p.runIndex === null ? 0 : p.runIndex - 100;
            const half = Math.min(50, Math.abs(dev) / PARK_INDEX_SPAN * 50);
            const caption = p.runIndex === null
                ? 'no factor for this park'
                : `${dev > 0 ? "hitter's park" : dev < 0 ? "pitcher's park" : 'neutral park'}, run index ${p.runIndex}`;
            return `<button type="button" class="mt-diff-row" data-drill="park">
                        <span class="mt-diff-rlabel">Ballpark<span class="mt-diff-chev">&rsaquo;</span>
                            <span class="mt-diff-rnote">${escapeHtml(caption)}</span></span>
                        <span class="mt-diff-track mt-diff-diverge">
                            <span class="mt-diff-dev${dev > 0 ? ' mt-diff-up' : dev < 0 ? ' mt-diff-down' : ''}"
                                  style="width: ${half.toFixed(1)}%"></span></span>
                        <span class="mt-diff-rval">${signed}</span>
                    </button>`;
        }
        // Short rest has no evidence to open, so it keeps one hint and stays a plain row. It is also the only component that appears conditionally.
        return `<div class="mt-diff-row mt-diff-row-flat"
                     data-tooltip="+${SHORT_REST_ADJUSTMENT} when the previous start was under ${SHORT_REST_DAYS} days ago.">
                    <span class="mt-diff-rlabel">Short rest<span class="mt-diff-rnote">${escapeHtml(p.label)}</span></span>
                    <span class="mt-diff-track"></span>
                    <span class="mt-diff-rval">${signed}</span>
                </div>`;
    };

    // How the club's score is built, category by category, against the same pool of lineups the composite ranked it in. offenceBreakdown returns the engine's own arithmetic so these rows cannot disagree with the score above them. The bats this lineup leaves out are named rather than subtracted, because one hitter entering or leaving the healthy set moves the whole composite and the reader could not otherwise see why.
    function sidelinedBatsHtml(proTeamId, detail) {
        if (proTeamId == null || !AppState.playerData) return '';
        const out = AppState.playerData
            .filter(p => p && p.proTeamId === proTeamId && isSidelined(p.injuryStatus)
                && playerRoleGroups(p, sport).primary)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        // The count of healthy bats of those rostered sits beside the players it is about, not in the header sentence where nobody could act on it.
        const counted = (detail && detail.rostered > detail.bats)
            ? `<span class="mt-diff-outn">${detail.bats} of ${detail.rostered} healthy bats counted</span>`
            : '';
        if (!out.length && !counted) return '';
        if (!out.length) return `<div class="mt-diff-out">${counted}</div>`;
        return `<div class="mt-diff-out"><strong>Not counted</strong>
                    ${out.map(p => `<span class="mt-diff-outp">${escapeHtml(p.name)}${injuryBadgeHtml(p.injuryStatus)}</span>`).join('')}
                    ${counted}
                </div>`;
    }

    function lineupDrillHtml(s) {
        const detail = offenceRaw ? offenceBreakdown(offenceRaw, battingIds, s.game.opponentId, offenceCtx) : null;
        const teams = detail && detail.rows.length ? detail.rows[0].of : (offence ? offence.size : 0);
        const score = s.difficulty ? s.difficulty.base : null;
        // The column is headed "Percentile", the word the player drill-down's rank table uses. The composite lands in the table foot, where the drill-down puts its Rank Score, because a total belongs under the table that justifies it.
        const body = (detail && detail.rows.length)
            ? `<table class="mt-diff-table">
                   <thead><tr><th>Category</th><th>Value</th><th>Rank</th><th>Percentile</th></tr></thead>
                   <tbody>${detail.rows.map(r => `
                       <tr>
                           <td>${escapeHtml(statMap[r.id] || r.id)}${r.inverse ? ' <span title="Lower is better for this category">&darr;</span>' : ''}</td>
                           <td>${escapeHtml(formatStat(r.id, r.value))}</td>
                           <td>#${r.rank} of ${r.of}</td>
                           <td>${r.pct.toFixed(1)}</td>
                       </tr>`).join('')}</tbody>
                   ${score !== null ? `<tfoot><tr><td colspan="3">Lineup strength</td><td>${score.toFixed(1)}</td></tr></tfoot>` : ''}
               </table>`
            : '<div class="mt-cal-hint">This lineup cannot be measured from the pool.</div>';
        // A category the pool cannot measure is named, never silently missing from the table.
        const missing = (detail && detail.excluded.length)
            ? `<div class="mt-diff-dnote">Not measured: ${escapeHtml(detail.excluded.map(id => statMap[id] || id).join(', '))} - this pool carries no components to rebuild ${detail.excluded.length === 1 ? 'it' : 'them'} from.</div>`
            : '';
        return `<div class="mt-diff-breakdown mt-diff-drill">
                    ${crumbsHtml([{ label: 'Schedule', to: 'calendar' },
                                  { label: startCrumb(s), to: 'card' },
                                  { label: `Lineup strength${score !== null ? ` · ${score.toFixed(0)}` : ''}` }])}
                    <div class="mt-diff-dnote">All categories are compared against the other ${Math.max(0, teams - 1)} teams,
                        counting only healthy active players.</div>
                    ${body}${missing}${sidelinedBatsHtml(s.game.opponentId, detail)}
                </div>`;
    }

    // Every park the table knows, sorted by run environment, with today's marked in place. Diverging from a 100 centreline so the two families separate at a glance rather than by reading numbers.
    function parkDrillHtml(s) {
        const part = s.difficulty?.parts.find(p => p.key === 'park');
        const here = part ? part.venueTeamId : null;
        const listed = Object.keys(MLB_PARK_FACTORS)
            .map(id => ({ id: Number(id), runs: MLB_PARK_FACTORS[id][0], name: MLB_PARK_FACTORS[id][1] }))
            .sort((a, b) => b.runs - a.runs);
        const rows = listed.map(p => {
            const dev = p.runs - 100;
            const half = Math.min(50, Math.abs(dev) / PARK_INDEX_SPAN * 50);
            return `<div class="mt-park-row${p.id === here ? ' mt-park-here' : ''}">
                        <span class="mt-park-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                        <span class="mt-diff-track mt-diff-diverge">
                            <span class="mt-diff-dev${dev > 0 ? ' mt-diff-up' : dev < 0 ? ' mt-diff-down' : ''}"
                                  style="width: ${half.toFixed(1)}%"></span></span>
                        <span class="mt-park-idx">${p.runs}</span>
                    </div>`;
        }).join('');
        // The two clubs with no published three-year factor are two more rows, greyed and unranked but in the same column language, so a reader counting parks finds all thirty.
        const missing = (proSchedule.abbrevs ? [...proSchedule.abbrevs.keys()] : [])
            .filter(id => id > 0 && !MLB_PARK_FACTORS[id])
            .map(id => ({ id, name: proSchedule.abbrevs.get(id) }));
        const unlisted = missing.map(m => `
            <div class="mt-park-row mt-park-unlisted${m.id === here ? ' mt-park-here' : ''}"
                 title="No three-year factor published for this club's temporary park">
                <span class="mt-park-name">${escapeHtml(m.name)}</span>
                <span class="mt-diff-track mt-diff-diverge"></span>
                <span class="mt-park-idx">&ndash;</span>
            </div>`).join('');
        // Column-major, so the ranking reads DOWN the left column and continues down the right, and the row count per column is the whole list halved. Grid rows share the height the card has, which is what makes the list fit instead of scroll.
        const total = listed.length + missing.length;
        const perColumn = Math.ceil(total / 2);
        return `<div class="mt-diff-breakdown mt-diff-drill">
                    ${crumbsHtml([{ label: 'Schedule', to: 'calendar' },
                                  { label: startCrumb(s), to: 'card' },
                                  { label: 'Ballparks' }])}
                    <div class="mt-diff-dnote">Arenas above 100 favour hitters, below 100 favour pitchers.
                        <span class="mt-diff-credit">Parks &middot; Baseball Savant</span></div>
                    <div class="mt-park-list" style="--park-rows: ${perColumn}">${rows}${unlisted}</div>
                </div>`;
    }

    function difficultyBreakdownHtml(s) {
        const d = s.difficulty;

        // A start that has happened is answered with what happened, and the forecast is kept beside it rather than replaced, since seeing that a hard matchup went well is the reason to show the read at all.
        if (s.game.played) {
            const actual = actualLineFor(s.playerId, s.game.period);
            const forecast = s.forecast;
            const line = actual
                ? `<table class="mt-diff-table">
                       <thead><tr><th>Category</th><th>Actual</th></tr></thead>
                       <tbody>${actual.map(a => `<tr><td>${escapeHtml(a.label)}</td><td>${escapeHtml(formatStat(a.id, a.value))}</td></tr>`).join('')}</tbody>
                   </table>`
                : `<div class="mt-cal-hint">No line recorded for this day.</div>`;
            const chip = forecast
                ? `<span class="mt-diff-chip" style="--diff: ${forecast.score.toFixed(1)}">Forecast ${forecast.score.toFixed(0)} ${escapeHtml(difficultyLabel(forecast.score))}</span>`
                : '';
            // The venue comes off the forecast because a played start carries no live difficulty, and a park name is worth more on a result than "on the road".
            const playedVenue = forecast?.parts.find(p => p.key === 'park')?.venue || null;
            return `<div class="mt-diff-breakdown">
                        ${crumbsHtml([{ label: 'Schedule', to: 'calendar' },
                                      { label: startCrumb(s) }])}
                        <div class="mt-diff-state">Complete${chip}</div>
                        ${startSubline(s, playedVenue)}${line}${creditFootHtml(s)}
                    </div>`;
        }

        if (!d) {
            return `<div class="mt-diff-breakdown">
                        ${crumbsHtml([{ label: 'Schedule', to: 'calendar' },
                                      { label: startCrumb(s) }])}
                        <div class="mt-diff-state">No read</div>
                        ${startSubline(s, null)}
                        <div class="mt-cal-hint">This opponent's offence cannot be measured from the pool.</div>
                        ${creditFootHtml(s)}
                    </div>`;
        }

        if (openStartDrill === 'lineup') return lineupDrillHtml(s);
        if (openStartDrill === 'park') return parkDrillHtml(s);

        const venue = d.parts.find(p => p.key === 'park')?.venue || null;
        return `
            <div class="mt-diff-breakdown">
                ${verdictHtml(d.score, difficultyLabel(d.score))}
                ${crumbsHtml([{ label: 'Schedule', to: 'calendar' },
                              { label: startCrumb(s) }])}
                ${startSubline(s, venue)}
                <div class="mt-diff-rows">${d.parts.map(componentRowHtml).join('')}</div>
                ${creditFootHtml(s)}
            </div>`;
    }

    const rosterBody = entries.length ? `${renderGroup('primary')}${renderGroup('secondary')}` : '';

    // The profile ribbon replaces the wins and bleeds chip row. `of` is the league's real team count and not any one category's, so a category missing data for a team does not narrow the ramp for its cell alone. It is sorted by rank with a stable sort, because the ribbon renders whatever order it is handed.
    const ribbonOf = (AppState.apiData.teams || []).length;
    const ribbonHtml = projectedBasis() ? '' : buildProfileRibbonHtml({
        of: ribbonOf,
        categories: [...(profile.all || [])]
            .map(c => ({ id: c.id, label: c.name, rank: c.rank, value: c.value, median: c.median, inverse: c.inverse }))
            .sort((a, b) => a.rank - b.rank),
    }, { escapeHtml, formatStatValue });

    // The "against" controls, an opponent picker beside the switcher. A points league has one too, comparing per category in points. The drawer's window is driven by the tab bar's shared Current, Next and Rest pills through AppState.ahead.
    const otherTeams = (AppState.apiData.teams || []).filter(t => t.id !== team.id);
    // The select reflects the same default the band itself used, the reader's pick or the scheduled opponent under Next, so the picker never disagrees with the comparison below it.
    const compareControlsHtml = otherTeams.length ? `
        <div class="mt-compare-controls">
            <select id="mt-compare-opponent">
                <option value="">Compare against...</option>
                ${otherTeams.map(t => `<option value="${t.id}"${effectiveOpponentId === t.id ? ' selected' : ''}>${escapeHtml(displayTeamName(t))}</option>`).join('')}
            </select>
        </div>` : '';

    // The form and streak mark and the place sparkline sit beside the record, only with a real standing to plot against, and insert before the Compare control in the same flex row. They use the reader's own timeframe span and window so the form strip and the sparkline's shading agree about what recent means.
    const scoring = AppState.isPointsLeague ? 'points' : (AppState.isRotoLeague ? 'roto' : 'categories');
    const recordResultAt = AppState.isPointsLeague ? (t, w) => t.weeklyMatchResult[w] : (t, w) => t.weeklyMatchWins[w];
    const { start: tfStart, end: tfEnd } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const densityHtml = (standing && !AppState.isRotoLeague) ? `
        <span class="mt-form">${buildFormStreakHtml(team, {
            startWeek: tfStart, endWeek: tfEnd, window: parseTimeframe(AppState.timeframe).window,
            scoring, resultAt: recordResultAt, input: AppState.teamStats
        })}</span>
        ${buildPlaceSparkHtml(team, AppState.teamStats, scoring)}` : '';

    container.innerHTML = `
        ${projectedBasis() ? '<div class="pd-mast"><span class="pd-tag">PRESEASON &middot; PROJECTED</span></div>' : ''}
        <div class="mt-summary">
            <div class="mt-team">
                <button type="button" class="chrome-arrow mt-prev" aria-label="Previous team">&#8249;</button>
                <span class="mt-team-name" title="${escapeHtml(teamNameTitle(team) || team.name)}">${escapeHtml(displayTeamName(team))}</span>
                <button type="button" class="chrome-arrow mt-next" aria-label="Next team">&#8250;</button>
                ${isOwn ? '<span class="mt-own">Your team</span>' : ''}
            </div>
            ${standing ? `<div class="mt-stand">
                <span class="mt-stand-label">${escapeHtml(standing.label)}</span>
                <span class="mt-stand-value">${escapeHtml(standing.value)}</span>
                <span class="mt-stand-rank">${formatRank(standing.rank, standing.ranks)} of ${standing.of}</span>
            </div>` : ''}
            ${densityHtml}
            ${compareControlsHtml}
        </div>
        ${ribbonHtml ? `<div class="mt-profile">${ribbonHtml}</div>` : ''}
        ${coverage ? buildCoverageStripHtml(coverage, statMap, {
            escapeHtml,
            // The same (id, value) formatter the roster tables use, so a figure in the strip/drawer and the same figure in the table below it can never be printed two different ways.
            formatValue: (id, v) => (v === null || v === undefined ? '-' : formatStat(id, v)),
            losingIds: coverageLosingIds,
            rankOf: (id) => coverageRankById.get(String(id)) || null,
            isOpen: AppState.myTeamCoverageDrawerOpen
        }) : ''}
        <div class="mt-roster-wrap">
            <div class="mt-roster${entries.length && !AppState.playerDataLoaded && !poolFailed ? ' mt-roster-pending' : ''}"${rosterVarsAttr(team)}>
                ${poolFailed
                    ? `<div class="player-loading">${escapeHtml(playerPoolErrorText(AppState.playerDataError))}</div>`
                    : `${entries.length && !AppState.playerDataLoaded
                        ? ''
                        : (weeklyStillArriving
                            ? '<div class="mt-note">Loading the numbers for this timeframe...</div>'
                            : (windowedMissing
                                ? `<div class="mt-note">${windowedMissing} rostered ${windowedMissing === 1 ? 'player has' : 'players have'} no games in this timeframe, so their lines and ranks are blank.</div>`
                                : ''))}
                ${entries.length ? rosterBody
                    : (awaitingFinal
                        ? '<div class="player-loading">Loading the final lineup of the season...</div>'
                        // A league that has not drafted has no roster by design, so "No roster available" would read as a gap this tab failed to fill. The honest sentence names the reason there is nothing to show yet.
                        : (seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT
                            ? '<div class="player-loading">No roster until the draft.</div>'
                            : '<div class="player-loading">No roster available for this team.</div>'))}`}
            </div>
            ${coverage ? `<div class="mt-coverage-drawer"${AppState.myTeamCoverageDrawerOpen ? '' : ' hidden'}>
                <div class="mt-drawer-head">${buildCoverageDrawerHeadHtml(coverage, { escapeHtml })}</div>
                <div class="mt-drawer-body">${buildCoverageDrawerHtml(coverage, statMap, {
                    escapeHtml,
                    formatValue: (id, v) => (v === null || v === undefined ? '-' : formatStat(id, v)),
                    losingIds: coverageLosingIds,
                    rankOf: (id) => coverageRankById.get(String(id)) || null,
                    modeState: addsMode,
                    ranked: addsRanked,
                    drop: dropForState,
                    // teamById compares with === against the team stats' numeric ids, but a margin's teamId comes from Object.keys and is always a string, so the lookup missed and printed a fallback name. Number(id) fixes it, and teamById itself is shared and unchanged.
                    teamNameOf: (id) => displayTeamName(teamById(Number(id))) || `Team ${id}`,
                    // Batters then pitchers, or skaters then goalies, from the roster groups' own split in utils.js, so a category never lands on a different side of the split than the player who carries it.
                    roleGroups: (() => {
                        const drawerSport = AppState.loadedSport;
                        const ids = (coverage.categories || []).map(c => c.id);
                        const byRole = splitStatIdsByRole(drawerSport, ids);
                        return {
                            primary: { label: roleGroupLabel(drawerSport, false), ids: byRole.primary },
                            secondary: { label: roleGroupLabel(drawerSport, true), ids: byRole.secondary }
                        };
                    })(),
                    posOf: (p) => {
                        const pooled = (AppState.playerData || []).find(x => x.id === (p && p.id));
                        return pooled ? (pooled.positionDisplay || pooled.positionName || '') : '';
                    }
                })}</div>
            </div>` : ''}
            ${compare ? `<div class="mt-compare-drawer"${(AppState.myTeamCompareDrawerOpen || isScheduledDefault) ? '' : ' hidden'}>
                <div class="mt-drawer-head">
                    <span class="mt-drawer-title">Compare</span>
                    ${faceFor(faceAsked, effectiveOpponentId) ? buildFacePillHtml(faceAsked, { escapeHtml }) : ''}
                    <button type="button" class="mt-drawer-close" title="Close" aria-label="Close the compare">&#10005;</button>
                </div>
                <div class="mt-drawer-body">${buildTeamCompareHtml(compare, {
                    escapeHtml,
                    face: faceFor(faceAsked, effectiveOpponentId),
                    rateComponents: RATE_COMPONENTS[sport] || [],
                    statLabels: statMap,
                    // The games tile's role word, the sport's own.
                    workloadWord: { flb: 'Hitter', fhl: 'Skater', ffl: 'Player' }[sport] || '',
                    groupLabels: { primary: roleGroupLabel(sport, false), secondary: roleGroupLabel(sport, true) },
                    dayStrip
                })}</div>
            </div>` : ''}
            ${scheduledNote ? `<div class="mt-compare-scheduled-note">${escapeHtml(scheduledNote)}</div>` : ''}
        </div>`;

    attachDataTooltips(container);
    wirePlayerAvatars(container);
    wireTeamSwitcher(container);
    wireCoverageDrawer(container, dropForState);
    fitCoverageStripChips(container);
    fitCompareStripWidth(container);
    fitCoverageDrawerWidth(container);
    fitCoveragePickSlotHeight(container);
    wireScheduleCalendar(container);

    // The "against" controls. Choosing an opponent is the open action, with no separate Open button, and both drawers share the roster's right-hand slot, so opening this one closes the coverage drawer if it was showing.
    const compareClose = container.querySelector('.mt-compare-drawer .mt-drawer-close');
    if (compareClose) {
        compareClose.addEventListener('click', () => {
            if (AppState.myTeamCompareOpponentId == null && effectiveOpponentId != null) scheduledCompareDismissed = `${team.id}:${effectiveOpponentId}`;
            AppState.myTeamCompareDrawerOpen = false;
            renderMyTeamTab();
        });
    }
    const opponentSelect = container.querySelector('#mt-compare-opponent');
    if (opponentSelect) {
        opponentSelect.addEventListener('change', (e) => {
            scheduledCompareDismissed = null;
            const v = e.target.value;
            AppState.myTeamCompareOpponentId = v === '' ? null : Number(v);
            AppState.myTeamCompareDrawerOpen = v !== '';
            // The two drawers share the roster's one right-hand slot, so opening this one closes coverage rather than stacking.
            if (AppState.myTeamCompareDrawerOpen) AppState.myTeamCoverageDrawerOpen = false;
            // A new opponent is a different window of days, so the strip closes and its page pin clears, the way a league switch clears it.
            AppState.myTeamCompareStripOpen = false;
            AppState.myTeamCompareWeekIndex = null;
            renderMyTeamTab();
        });
    }
    // The day strip's own control. Clicking the label opens it, the same rule the opponent picker follows, and the two arrows page by week without touching the open state, so stepping through a fortnight never closes the grid.
    const stripToggle = container.querySelector('.tc-strip-toggle');
    if (stripToggle) {
        stripToggle.addEventListener('click', () => {
            AppState.myTeamCompareStripOpen = !AppState.myTeamCompareStripOpen;
            renderMyTeamTab();
        });
    }
    container.querySelectorAll('.tc-strip-prev, .tc-strip-next').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled || !dayStrip) return;
            const step = btn.classList.contains('tc-strip-prev') ? -1 : 1;
            AppState.myTeamCompareWeekIndex = dayStrip.weekIndex + step;
            renderMyTeamTab();
        });
    });
    // Three states per column, the same cycle the heatmap headers use, so slot order is always one more click away rather than something you have to re-render the tab to get back.
    container.querySelectorAll('th.mt-sortable').forEach(th => {
        const cycle = () => {
            const role = th.dataset.role;
            const id = th.dataset.stat;
            const cur = groupSort[role];
            groupSort[role] = (!cur || cur.statId !== id) ? { statId: id, dir: 'desc' }
                : (cur.dir === 'desc' ? { statId: id, dir: 'asc' } : null);
            renderMyTeamTab();
        };
        th.addEventListener('click', cycle);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle(); } });
    });

    // Switching the pitching face, and picking which start explains itself. Both re-render, and both leave the batting group above untouched, which is the point of keeping the view state per group rather than per tab.
    container.querySelectorAll('.mt-view-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const role = btn.dataset.role;
            const next = btn.dataset.view;
            const isCalendarGroup = nightSchedule && nightSchedule[role];
            if (isCalendarGroup) {
                if (next === calendarView[role]) return;
                calendarView[role] = next;
            } else {
                if (next === pitchingView) return;
                pitchingView = next;
            }
            openStartKey = null;
            openStartDrill = null;
            renderMyTeamTab();
        });
    });
    // The index-based calendar's own pager (extended to football's own week unit): one page-worth (seven columns) of period at a time, shared across both of that sport's role groups since they page together. Either group's own byPeriod list names the same periods (both covers are built from the same `periods`, above), so whichever is present is as good a source as the other.
    container.querySelectorAll('.mt-nc-page-prev, .mt-nc-page-next').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            const sched = nightSchedule && (nightSchedule.primary || nightSchedule.secondary);
            if (!sched) return;
            const periods = sched.byPeriod.map(d => d.period);
            const step = btn.classList.contains('mt-nc-page-prev') ? -1 : 1;
            const cur = (indexCalPage !== null && periods.includes(indexCalPage)) ? indexCalPage : periods[0];
            const idx = periods.indexOf(cur);
            const next = Math.max(0, Math.min(periods.length - 7, idx + step * 7));
            indexCalPage = periods[next];
            renderMyTeamTab();
        });
    });
    container.querySelectorAll('.mt-cal-start').forEach(btn => {
        btn.addEventListener('click', () => {
            // Clicking the open one closes it, so the breakdown is never a thing you cannot dismiss.
            openStartKey = (openStartKey === btn.dataset.start) ? null : btn.dataset.start;
            openStartDrill = null;
            renderMyTeamTab();
        });
    });
    // A component row opens its own evidence in the same reserved space, and clicking the row already open closes it, as a start card toggles.
    container.querySelectorAll('.mt-diff-row[data-drill]').forEach(btn => {
        btn.addEventListener('click', () => {
            openStartDrill = (openStartDrill === btn.dataset.drill) ? null : btn.dataset.drill;
            renderMyTeamTab();
        });
    });
    // Every crumb is a destination and not a step back. "Schedule" closes the whole stack from any depth.
    container.querySelectorAll('.mt-crumb[data-crumb]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.crumb === 'calendar') { openStartKey = null; openStartDrill = null; }
            else openStartDrill = null;
            renderMyTeamTab();
        });
    });
    // The league belongs in this key, because the same team id, timeframe, viewport and roster size in a different league would reuse a density decided for a league with other categories. The timeframe is out of the key, since a window changes neither how many rows there are nor their height. Content completeness is in it, so the fit is made at most twice, once for the loading state and once for the real one.
    const needsWeekly = !isFullSeasonTimeframe();
    const contentComplete = AppState.playerDataLoaded
        && (!needsWeekly || !weeklyDataPending())
        && proSchedule.state === 'done';
    // The vertical layout is computed from these counts and not measured off the rendered tables, so the loading and loaded states come out the same size. Both groups are sized off their own categories content in every face, so a Schedule face scrolls inside itself when the calendar needs more. Columns are sized first, then the fit, so the fit measures the table it will actually have.
    sizeRosterColumns(container);
    layoutRosterBand(container, rowCounts, rosterBudget);
    if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
        fitPhoneSchedule(container);
    } else {
        fitNightCalendars(container);
        growNightChips(container);
        fitNightEdgeColumns(container);
    }
    sizeRosterColumns(container);
    container.querySelectorAll('.mt-row').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = Number(tr.dataset.playerId);
            if (!AppState.playerData.some(p => p.id === id)) return;
            // Hand the drill-down the role this row was read under before the tab renders. Every pool the drill-down builds is scoped by AppState.playerGroup, so a pitcher opened while Player Metrics sat on Batters would be ranked over batting categories where every value is 0. The group comes from the group the row sits in, so a two-way player opened from the pitching table is read as a pitcher.
            const rowRole = tr.closest('.mt-group')?.dataset.role;
            if (rowRole === 'primary' || rowRole === 'secondary') AppState.playerGroup = rowRole;
            document.getElementById('tab-btn-player')?.click();
            openPlayerDetail(id);
        });
    });
}

// The Player and Pos columns take their width from the roster actually on screen, measured after it renders. A league-wide width would size for the longest name in the whole pool. It is measured and never estimated from character counts because the answer depends on the font the density ladder applied, with one value for both group tables so they stay aligned.
function sizeRosterColumns(container) {
    const names = [...container.querySelectorAll('.mt-name')];
    if (!names.length) return;
    // A group on its Schedule face has no category heads, so measuring the one table still showing gave a different pitch than the two-table measurement and, being grow-only, held it. The fit measured with both tables visible is the true one, so a render with a Schedule face open replays it. Without a held fit it measures as before.
    const fitSig = `${AppState.loadedSport}:${AppState.apiData.id}:${AppState.apiData.seasonId}:${viewedTeamId}:${window.innerWidth}x${window.innerHeight}`;
    if (container.querySelector('.mt-group > .mt-cal, .mt-group > .mt-nc') && heldColumnFit && heldColumnFit.sig === fitSig) {
        container.style.setProperty('--mt-player-w', heldColumnFit.player + 'px');
        container.style.setProperty('--mt-pos-w', heldColumnFit.pos + 'px');
        container.style.setProperty('--mt-stat-w', heldColumnFit.stat + 'px');
        return;
    }
    // A hidden tab measures zero for everything, and writing that answer would leave the roster sized for a container it was never shown in. processCoreData renders this tab on every league fetch whether or not it is on screen, so this guard is load-bearing, the same reason layoutRosterBand declines to compute against a band of zero height.
    if (!container.clientWidth) return;
    const sample = container.querySelector('td.mt-pos');
    if (!sample) return;

    // A probe and not the cells themselves, because measuring a cell's own box asks the column how wide the column is, which is circular. The probes carry the cell's real computed font. It is one read pass, then one write pass, then one read, so the widths come from a single layout and the numbers are unchanged.
    const head = container.querySelector('th.mt-pos');
    const bodyFont = getComputedStyle(sample).font;
    const headFont = head ? getComputedStyle(head).font : bodyFont;
    const headSpacing = getComputedStyle(head || sample).letterSpacing;
    const nameTexts = names.map(n => n.textContent.trim());
    const posTexts = [...container.querySelectorAll('td.mt-pos')].map(n => n.textContent.trim());
    const statHeadTexts = [...container.querySelectorAll('th.mt-stat')].map(th => th.textContent.replace(/[▼▲]/g, '').trim());
    const statValueTexts = [...container.querySelectorAll('td.mt-stat')].map(td => td.textContent.trim());
    // [text, kind]: 'body' is the cell's font as inherited, 'head' the header's (smaller, uppercase), 'value' the cell's font with the header's spacing and case switched off, exactly the three states the one probe was put through.
    const probes = [
        ...nameTexts.map(t => [t, 'body']), ...posTexts.map(t => [t, 'body']),
        ['Player', 'head'], ['Pos', 'head'], ...statHeadTexts.map(t => [t, 'head']),
        ...statValueTexts.map(t => [t, 'value'])
    ];
    const holder = document.createElement('div');
    const probeEls = probes.map(([t, kind]) => {
        const el = document.createElement('span');
        el.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
        if (kind === 'head') {
            el.style.font = headFont;
            el.style.textTransform = 'uppercase';
            el.style.letterSpacing = headSpacing;
        } else {
            el.style.font = bodyFont;
            if (kind === 'value') { el.style.textTransform = 'none'; el.style.letterSpacing = 'normal'; }
        }
        el.textContent = t || '';
        holder.appendChild(el);
        return el;
    });
    container.appendChild(holder);
    const widths = probeEls.map(el => el.getBoundingClientRect().width);
    holder.remove();
    let at = 0;
    const takeMax = (count) => { let m = 0; for (let i = 0; i < count; i++) m = Math.max(m, widths[at + i]); at += count; return m; };
    const nameW = takeMax(nameTexts.length);
    const posW = takeMax(posTexts.length);
    // The headings are a floor, since a column narrower than its own label reads as broken rather than tight. Measured in the HEADER's font, which is smaller and uppercase.
    const playerHeadW = takeMax(1);
    const posHeadW = takeMax(1);
    // Category columns share ONE pitch across both tables, so the Nth category of one group stays above the Nth of the other. The pitch is the widest thing any of them has to hold, which is usually a heading rather than a number. "Starts" and "OPS" are wider than the figures under them. Headings are measured in the header's font.
    const statHeadW = takeMax(statHeadTexts.length);
    const statValueW = takeMax(statValueTexts.length);

    // The avatar and the gap after it share the name's cell, so they are part of what that column has to hold. Read off the real element so a density step counts.
    const avatar = container.querySelector('.player-avatar');
    const avatarW = avatar ? avatar.getBoundingClientRect().width + 6 : 0;
    // Cell padding, plus a couple of pixels so the longest entry is not flush against the next column. Sorting can add an arrow to a header, which the floor already covers.
    const chrome = 14;
    const playerW = Math.ceil(Math.max(nameW + avatarW, playerHeadW) + chrome);
    const posW2 = Math.ceil(Math.max(posW, posHeadW) + chrome);

    // The shared columns are applied and settled before the category pitch is measured, because the pitch divides what is left after them. The category count belongs in the key, since a width measured with fewer columns would be inherited grow-only by a render with more and cause a horizontal scrollbar.
    const statCols = container.querySelectorAll('.mt-group thead th.mt-stat').length;
    const fitKeyBase = `${AppState.loadedSport}:${AppState.apiData.id}:${AppState.apiData.seasonId}:` +
        `${viewedTeamId}:${window.innerWidth}x${window.innerHeight}:${names.length}:${statCols}`;
    if (lastColumnFit.key !== fitKeyBase) lastColumnFit = { key: fitKeyBase, player: 0, pos: 0, stat: 0 };
    lastColumnFit.player = Math.max(lastColumnFit.player, playerW);
    lastColumnFit.pos = Math.max(lastColumnFit.pos, posW2);
    container.style.setProperty('--mt-player-w', lastColumnFit.player + 'px');
    container.style.setProperty('--mt-pos-w', lastColumnFit.pos + 'px');
    // The FLOOR for a category column: what its widest heading or value needs, so a narrow window tightens the columns rather than clipping them.
    const statFloor = Math.ceil(Math.max(statHeadW, statValueW));

    // Categories fill the room the table has and stay aligned between the two groups, so the pitch is sized for the group carrying the most categories and the shorter group's filler absorbs the rest. It is measured after the shared columns have taken their width, since padding and the density step both move the real numbers.
    const groups = [...container.querySelectorAll('.mt-group')];
    let available = Infinity, mostCategories = 0, pad = 0;
    groups.forEach(group => {
        const heads = [...group.querySelectorAll('thead th')];
        const statHeads = heads.filter(th => th.classList.contains('mt-stat'));
        if (!statHeads.length) return;
        const shared = heads
            .filter(th => !th.classList.contains('mt-stat') && !th.classList.contains('mt-fill'))
            .reduce((sum, th) => sum + th.getBoundingClientRect().width, 0);
        // The GROUP's width, not the table's. A fixed-layout table is as wide as its columns say, so measuring the table asks the columns how wide the columns should be and the answer never shrinks. A 14-category league blew the table out to 1661px inside a 1208px band instead of tightening. The group is the room the table is allowed.
        available = Math.min(available, group.clientWidth - shared);
        mostCategories = Math.max(mostCategories, statHeads.length);
        // Padding is part of the pitch but not of the width property, which is content-box here.
        const cs = getComputedStyle(statHeads[0]);
        pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    });
    // One rule, shared with the leaderboard, clamp(available / N, FLOOR, CAP) off the same root constants. The cap stops a short category list on a wide window spreading into islands. Everything is a column advance, width plus padding, to match the other table.
    const rootCs = getComputedStyle(document.documentElement);
    const rootPx = (name, fallback) => {
        const v = parseFloat(rootCs.getPropertyValue(name));
        return Number.isFinite(v) ? v : fallback;
    };
    const cap = rootPx('--cat-pitch-cap', 90);
    // Off the remainder split, never off the floor, so tightening can close the air between columns but can never clip a heading or a value.
    const tighten = rootPx('--cat-pitch-tighten', 5);
    const floorPitch = statFloor + pad;
    const pitch = mostCategories
        ? Math.min(Math.max(Math.floor(available / mostCategories) - tighten, floorPitch), cap)
        : floorPitch;
    // Grow-only within a key, so a window with wider numbers still gets the room it needs and a narrower one never shrinks the table back. The key omits the timeframe on purpose, since re-measuring on every pill click resized the table.
    lastColumnFit.stat = Math.max(lastColumnFit.stat, Math.floor(pitch - pad));
    container.style.setProperty('--mt-stat-w', lastColumnFit.stat + 'px');
    if (!container.querySelector('.mt-group > .mt-cal, .mt-group > .mt-nc')) {
        heldColumnFit = { sig: fitSig, player: lastColumnFit.player, pos: lastColumnFit.pos, stat: lastColumnFit.stat };
    }
}

// The vertical layout as arithmetic, with no measurement of what rendered and no memory of earlier layouts, so the same league, window and roster give the same answer on every path. The only DOM read is the band's height. The divisor is the league's roster and not this team's, so every team gets the same row height. A group's box is its categories height in every face.
const MT_FLOOR_YIELD_ROW_H = 24;
// What a yielded second group keeps for its Schedule face, the least height at which the face needs no scroll in the measured cases.
const MT_SCHED_FACE_NEED = 124;

function layoutRosterBand(container, counts, budget) {
    const band = container.querySelector('.mt-roster');
    if (!band) return;
    // Mobile does not run this arithmetic. Below 700px the tab is one scrolling column and CSS gives every group its natural height, so computing a cramped fixed height for a layout CSS is about to override would fight it. The room check below cannot tell not-rendered from genuinely narrow.
    if (window.matchMedia('(max-width: 700px)').matches) return;
    // A hidden tab measures zero for its own box, and writing a layout computed against zero would be worse than writing none. Every path that shows this tab re-renders it. The 4px margin is a cushion against border and line-height rounding across a roster's rows, paid once before anything reads room.
    const room = Math.max(0, band.clientHeight - 4);
    if (!room) return;

    // Every constant lives in the stylesheet, beside the rules that make it true. Read, never measured, so the arithmetic and the rendering cannot disagree about what a header costs.
    const cs = getComputedStyle(band);
    const px = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
    const headH = px('--mt-group-head-h');
    const theadH = px('--mt-thead-h');
    const bandH = px('--mt-band-head-h');
    const gap = px('--mt-group-gap-base');
    const gapMax = px('--mt-group-gap-max') || gap;
    const rowMin = px('--mt-row-min');
    const rowMax = px('--mt-row-max');
    const batMin = px('--mt-bat-min');
    // A group that can show a Schedule face is floored at this height whichever face is showing, which keeps the floor face-independent. A one-row D/ST group's own content height was too small for a day card, so the box never grew to ask for more. It reuses the stylesheet's own day-grid floor rather than a second number.
    const schedMin = px('--mt-sched-min');
    // Every row this band draws carries its own bottom border on top of the row height, which the row-height rule never counted. Borders are charged per row, unlike the head heights charged once per group.
    const rowBorder = px('--mt-row-border');

    const present = [counts.primary, counts.secondary].filter(Boolean);
    if (!present.length) return;
    const chromeOf = (c) => headH + theadH + c.bands * (bandH + rowBorder);
    const gaps = gap * (present.length - 1);
    if (!budget || !budget.capacity) return;

    // The budgeted chrome follows the same principle as the divisor, charging every group present for the bands the league could give it, not the ones this team fills, so a team's empty bench does not enter every other team's row height.
    const budgetChrome = present.length * (headH + theadH + budget.bands * (bandH + rowBorder)) + gaps
        + budget.capacity * rowBorder;

    // WHOLE PIXELS, and that is not fussiness. A fractional row height lays out fine and then each of a dozen boxes rounds its own way, so a group's content came out 2px over the height the arithmetic had given it and both groups wore a 2px scrollbar. Integers make the sum on screen the sum that was computed.
    const clamp = (v) => Math.max(rowMin, Math.min(rowMax, Math.floor(v)));
    const bat = counts.primary;
    const pitch = counts.secondary;
    const chromePitch = pitch ? chromeOf(pitch) : 0;

    // One expression, no cases, and nothing in it belongs to the team on screen. This is still the number that keeps the loading and loaded renders the same size, and the number that keeps two teams in the same league from resizing every word when a user switches between them.
    const budgetedRowH = clamp((room - budgetChrome) / budget.capacity);

    // Taking the larger of the two puts any overflow on the batting group, the standing rule. They differ only at the row floor. The batting minimum caps the split, so pitching may take every pixel batting does not need but never so many that batting drops below about six rows.
    const pitchCap = bat ? Math.max(0, room - gaps - batMin) : room;

    // The second group's Schedule floor yields on a deep roster, since the floor was written for a one-row D/ST group and on a 22-man hockey roster it made the skaters' rows pay for two goalie rows. The test is the row height the roster keeps with the floor in place, so a taller window never gives smaller rows.
    const schedFaceNeed = Math.min(schedMin, MT_SCHED_FACE_NEED);
    const withFloorFits = (h, floor = true) => {
        let sh = pitch ? chromePitch + pitch.players * (h + rowBorder) : 0;
        if (pitch && pitch.canSchedule) sh = Math.max(sh, floor ? schedMin : schedFaceNeed);
        sh = Math.min(sh, pitchCap);
        let bc = bat ? chromeOf(bat) + bat.players * (h + rowBorder) : 0;
        if (bat && bat.canSchedule) bc = Math.max(bc, schedMin);
        return bc + sh + gaps <= room;
    };
    let rowWithFloor = rowMin;
    for (let h = rowMax; h >= rowMin; h--) { if (withFloorFits(h)) { rowWithFloor = h; break; } }
    let rowWithoutFloor = rowMin;
    for (let h = rowMax; h >= rowMin; h--) { if (withFloorFits(h, false)) { rowWithoutFloor = h; break; } }
    // Deciding from the floored height alone still gave a smaller row on a taller window, because the floor costs about five rows at any size. The floor is kept only where it costs the roster nothing, and everywhere else it yields and the face scrolls inside itself.
    const floorYields = !!(pitch && pitch.canSchedule)
        && (rowWithFloor < MT_FLOOR_YIELD_ROW_H || rowWithFloor < rowWithoutFloor);

    // One pass of the split at a candidate row height, shared by the budgeted pass and the grow-to-fill pass so the two cannot compute the split differently.
    const splitAt = (h) => {
        let shareAt = pitch ? chromePitch + pitch.players * (h + rowBorder) : 0;
        if (pitch && pitch.canSchedule) shareAt = Math.max(shareAt, floorYields ? schedFaceNeed : schedMin);
        shareAt = Math.min(shareAt, pitchCap);
        let batContentAt = bat ? chromeOf(bat) + bat.players * (h + rowBorder) : 0;
        if (bat && bat.canSchedule) batContentAt = Math.max(batContentAt, schedMin);
        const freeAt = Math.max(0, room - batContentAt - shareAt - gaps);
        return { share: shareAt, batContent: batContentAt, free: freeAt };
    };

    let rowH = budgetedRowH;
    let split = splitAt(rowH);

    // Grow-to-fill. A team under the league's budgeted capacity left its difference as blank space once the gap cap was spent. It now spends what its roster does not need on bigger rows. A team at capacity is unchanged, and the budgeted height still keeps row height off the team on screen.
    const totalRows = (bat ? bat.players : 0) + (pitch ? pitch.players : 0);
    const gapRoom = Math.max(0, gapMax - gap);
    // One pixel at a time and not a division, since estimating the growth as free over rows and rounding down stalls a step short of a height that fits with room to spare. The split is cheap and the candidate range is small.
    while (totalRows && split.free > gapRoom && rowH < rowMax) {
        split = splitAt(rowH + 1);
        rowH += 1;
    }

    const { share, batContent, free } = split;

    // Whatever is still spare becomes spacing between the two tables, up to the gap maximum, and the cap is the point. Uncapped, the gap became the new jarring thing, varying with the roster differences the budget exists to hide.
    const slack = Math.min(free, gapRoom);

    // Written on the band and not the container..mt-roster declares the defaults for these, and a declaration on the element itself beats one inherited from its parent.
    band.style.setProperty('--mt-row-h', rowH + 'px');
    let curGap = gap + slack;
    band.style.setProperty('--mt-group-gap', curGap + 'px');

    // Both faces are handed the same share, so flipping between them has nothing to re-deal, and both groups get a fixed height off their own categories content.
    let curShare = share;
    if (pitch) band.style.setProperty('--mt-pitch-h', curShare + 'px');
    else band.style.removeProperty('--mt-pitch-h');
    let curBatH = batContent;
    if (bat) band.style.setProperty('--mt-bat-h', curBatH + 'px');
    else band.style.removeProperty('--mt-bat-h');

    // The correction pass. Everything above is arithmetic against stylesheet constants, and a real box's line-height, border and font metrics can round a few pixels past it, which only reading the rendered box closes. There are two sources, spent only as far as needed to zero a group's overflow before touching the next, and the gap source runs again after the row step because a smaller split opens fresh gap slack.
    if (bat || pitch) {
        const primaryEl = bat ? band.querySelector('.mt-group[data-role="primary"]') : null;
        const secondaryEl = pitch ? band.querySelector('.mt-group[data-role="secondary"]') : null;
        // A group showing its Schedule face is never measured here. This pass absorbs a table's rounding drift against the row-height arithmetic, and a calendar's content has nothing to do with the row height, so stepping the shared row height down for it shrank the other group's table too.
        const primaryShowsCal = !!(primaryEl && primaryEl.querySelector(':scope > .mt-cal, :scope > .mt-nc'));
        const secondaryShowsCal = !!(secondaryEl && secondaryEl.querySelector(':scope > .mt-cal, :scope > .mt-nc'));
        const measure = () => ({
            primary: (primaryEl && !primaryShowsCal) ? Math.max(0, primaryEl.scrollHeight - primaryEl.clientHeight) : 0,
            secondary: (secondaryEl && !secondaryShowsCal) ? Math.max(0, secondaryEl.scrollHeight - secondaryEl.clientHeight) : 0
        });

        // Source 1, at whatever row height is current when called, once at the budgeted height and again after source 2 steps it down.
        const spendGap = () => {
            let over = measure();

            // The inter-group gap's slack, shrinkable toward its base, is delivered straight to the short group's own fixed-height variable. The smaller need goes first so the limited slack closes the cheaper side before any is spent on the side that needs the row step regardless.
            if (over.primary > 0 || over.secondary > 0) {
                let gapSlack = curGap - gap;
                const order = over.primary <= over.secondary ? ['primary', 'secondary'] : ['secondary', 'primary'];
                order.forEach(role => {
                    if (over[role] <= 0 || gapSlack <= 0) return;
                    const take = Math.min(over[role], gapSlack);
                    curGap -= take; gapSlack -= take;
                    if (role === 'secondary') { curShare += take; band.style.setProperty('--mt-pitch-h', curShare + 'px'); }
                    else { curBatH += take; band.style.setProperty('--mt-bat-h', curBatH + 'px'); }
                    band.style.setProperty('--mt-group-gap', curGap + 'px');
                    over = measure();
                });
            }
            return over;
        };

        let over = spendGap();

        // Source 2 steps the row height down as the last resort, shared by both groups so a mismatched row height does not trade one group's scrollbar for the other's. Source 1 is re-run after every step, and stepping continues until a step closes it or the minimum is reached, since one step measured short.
        while ((over.primary > 0 || over.secondary > 0) && rowH > rowMin) {
            const beforeTotal = over.primary + over.secondary;
            rowH -= 1;
            const resplit = splitAt(rowH);
            curShare = resplit.share;
            curBatH = resplit.batContent;
            curGap = gap + Math.min(resplit.free, gapRoom);
            band.style.setProperty('--mt-row-h', rowH + 'px');
            band.style.setProperty('--mt-group-gap', curGap + 'px');
            if (pitch) band.style.setProperty('--mt-pitch-h', curShare + 'px');
            if (bat) band.style.setProperty('--mt-bat-h', curBatH + 'px');
            over = spendGap();
            // The guard. A step that does not shrink the total overflow is chasing a fixed cost the arithmetic does not know about, so stopping degrades it to one group's small scroll and not every row ground to the floor.
            if (over.primary + over.secondary >= beforeTotal) break;
        }

        // Held across a face flip. A group on its Schedule face has no table to read, so a render with one side on Schedule could only correct for the visible table and land on a different shared row height. The fit computed with both tables visible is cached and replayed whenever either side is on Schedule.
        const fitKey = `${AppState.loadedSport}:${AppState.apiData.id}:${AppState.apiData.seasonId}:` +
            `${viewedTeamId}:${window.innerWidth}x${window.innerHeight}:` +
            `${bat ? bat.players + '/' + bat.bands : '-'}:${pitch ? pitch.players + '/' + pitch.bands : '-'}:` +
            `${budget.capacity}/${budget.bands}`;
        if (!primaryShowsCal && !secondaryShowsCal) {
            // Both tables visible, so this render's fit is the real one. The final applied numbers are held verbatim, since the split at the row height alone cannot reproduce a gap steal.
            lastRosterFit = { key: fitKey, rowH, gap: curGap, batH: curBatH, pitchH: curShare };
        } else if (lastRosterFit.key === fitKey) {
            // Replay the held fit verbatim instead of this render's own partially-blind one.
            rowH = lastRosterFit.rowH;
            curGap = lastRosterFit.gap;
            curBatH = lastRosterFit.batH;
            curShare = lastRosterFit.pitchH;
            band.style.setProperty('--mt-row-h', rowH + 'px');
            band.style.setProperty('--mt-group-gap', curGap + 'px');
            if (pitch) band.style.setProperty('--mt-pitch-h', curShare + 'px');
            if (bat) band.style.setProperty('--mt-bat-h', curBatH + 'px');
        } else {
            // With no held fit yet for this roster and viewport, such as a tab that opened onto a Schedule face, this render's best-effort fit is held so the next render is at least stable with itself.
            lastRosterFit = { key: fitKey, rowH, gap: curGap, batH: curBatH, pitchH: curShare };
        }
    }
}

// Rows are sized so the tallest day fits the column with no internal scroll. Two density steps are tried in order and kept only as far as needed, the chip collapsing to one line and then the chips arranged two to a row, and no step drops a playing player. It runs after the layout so there is a real reserved height to measure against.
function fitNightEdgeColumns(container) {
    container.querySelectorAll('.mt-nc.mt-nc-edges').forEach(nc => edgeColumnsFor(nc));
}

/**
 * Sizes the phone Schedule face's day columns: a whole number of them fills the panel, the scroller snaps by day and today is
 * scrolled to the first column in view.
 *
 * @param {HTMLElement} container The My Team tab's container.
 * @returns {void}
 */
function fitPhoneSchedule(container) {
    const grid = container.querySelector('.mt-nc-grid');
    const scroller = container.querySelector('.mt-roster');
    if (!grid || !scroller) return;
    // The panel's width is what the scroller shows less the room the group keeps on both sides of the grid.
    const wasLeft = scroller.scrollLeft;
    scroller.scrollLeft = 0;
    const left = grid.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    const panel = scroller.clientWidth - 2 * Math.max(0, left);
    const GAP = 4, MIN_DAY = 76;
    const whole = Math.max(1, Math.floor((panel + GAP) / (MIN_DAY + GAP)));
    const dayW = (panel - GAP * (whole - 1)) / whole;
    grid.style.setProperty('--nc-day-w', `${dayW.toFixed(2)}px`);
    // Room after the last day, so every day, the last included, can be the first one in view and the strip never rests on a sliver of the one before.
    grid.parentElement.style.setProperty('--nc-tail', `${Math.max(0, panel - dayW).toFixed(2)}px`);
    scroller.style.setProperty('--nc-pad', `${Math.max(0, left)}px`);
    const today = grid.querySelector('.mt-nc-col-today');
    if (today) scroller.scrollLeft = Math.max(0, today.getBoundingClientRect().left - scroller.getBoundingClientRect().left - Math.max(0, left) + wasLeft * 0);
    else scroller.scrollLeft = wasLeft;
}

// One group's columns. Returns the bar's room BEFORE the floor and cap are applied, which is what growNightChips reads to know whether a larger chip still leaves the bar a column to stand in (the clamp hides an overrun: a 20px bar in 12px of room still draws 20px).
function edgeColumnsFor(nc) {
    const chips = [...nc.querySelectorAll('.mt-nc-chip')];
    if (!chips.length) return null;
    nc.style.removeProperty('--nc-name-w');
    nc.style.removeProperty('--nc-bar-w');
    const textW = (el) => { const r = document.createRange(); r.selectNodeContents(el); return Math.ceil(r.getBoundingClientRect().width); };
    let nameW = 0, oppW = 0;
    chips.forEach(c => {
        nameW = Math.max(nameW, textW(c.querySelector('.mt-nc-chip-name')));
        oppW = Math.max(oppW, textW(c.querySelector('.mt-nc-chip-opp')));
    });
    const cs = getComputedStyle(chips[0]);
    const inner = chips[0].getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth || 0);
    const gap = parseFloat(cs.columnGap) || 4;
    const room = Math.floor(inner - nameW - oppW - gap * 2);
    nc.style.setProperty('--nc-name-w', `${nameW}px`);
    nc.style.setProperty('--nc-bar-w', `${Math.max(20, Math.min(66, room))}px`);
    return room;
}

// The day columns use the room the group gives them, so the chips grow on two unitless scales, one for the text and one for the chip's height and gap. They are two because the height is bounded by the group and the text by the column's width. The height is linear in the second scale, so two measurements give the answer and a third confirms it. The day header, count and idle foot are not scaled.
const NC_CHIP_BASE_H = 14;
const NC_CHIP_MAX_H = 20;
const NC_BAR_MIN = 26;
function growNightChips(container) {
    // Hockey's face only. Baseball's and football's day cards were not measured for this, and football's chip is two lines with a base of 28px.
    if (AppState.loadedSport !== 'fhl') return;
    const capV = NC_CHIP_MAX_H / NC_CHIP_BASE_H;
    container.querySelectorAll('.mt-nc').forEach(nc => {
        ['--nc-s', '--nc-v', 'min-height'].forEach(k => nc.style.removeProperty(k));
        // Only the one-line chip (the bars' and the compact step's): the two-line chip is already 28px and the 20px cap is a one-line chip's.
        if (!nc.classList.contains('mt-nc-edges') && !nc.classList.contains('mt-nc-compact')) return;
        const group = nc.closest('.mt-group');
        // The room is read off the group's own content box below the face's top (its padding and the head's margins included), not clientHeight less the head, which left the group a pixel over and its scrollbar up.
        const gcs = group ? getComputedStyle(group) : null;
        const avail = group ? Math.floor(group.getBoundingClientRect().bottom - parseFloat(gcs.borderBottomWidth || 0) - parseFloat(gcs.paddingBottom || 0) - nc.getBoundingClientRect().top) - 1 : 0;
        if (avail <= 0) return;
        // A group that already overflows (both density steps spent) has nothing to give.
        if (nc.scrollHeight >= avail) return;
        let s = 1;
        if (nc.classList.contains('mt-nc-edges')) {
            const room1 = edgeColumnsFor(nc);
            if (room1 !== null) {
                const chip = nc.querySelector('.mt-nc-chip');
                const cs = getComputedStyle(chip);
                const textW1 = parseFloat(nc.style.getPropertyValue('--nc-name-w')) + oppWidth(nc);
                const inner = chip.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth || 0);
                const gaps = (parseFloat(cs.columnGap) || 4) * 2;
                const keep = Math.min(NC_BAR_MIN, room1);
                if (textW1 > 0) s = Math.max(1, Math.min(capV, (inner - gaps - keep) / textW1));
            }
        } else {
            s = capV;
        }
        const set = (sv, vv) => { nc.style.setProperty('--nc-s', sv.toFixed(3)); nc.style.setProperty('--nc-v', vv.toFixed(3)); };
        // The text cannot outgrow the chip: --nc-v never falls below --nc-s, so the height at v = s bounds s as well as the width does.
        set(1, 1);
        const hOne = nc.scrollHeight;
        set(capV, capV);
        const hBoth = nc.scrollHeight;
        if (hBoth > avail) s = Math.max(1, Math.min(s, 1 + ((avail - hOne) * (capV - 1)) / Math.max(1, hBoth - hOne)));
        set(s, s);
        const h1 = nc.scrollHeight;
        set(s, capV);
        const hc = nc.scrollHeight;
        let v = hc <= avail ? capV : s + ((avail - h1) * (capV - s)) / Math.max(1, hc - h1);
        v = Math.max(s, Math.min(capV, v));
        set(s, v);
        for (let guard = 0; guard < 12 && v > s && nc.scrollHeight > avail; guard++) { v = Math.max(s, v - 0.02); set(s, v); }
        if (nc.scrollHeight > avail && s > 1) { s = 1; v = 1; set(s, v); }
        if (s <= 1.001 && v <= 1.001) ['--nc-s', '--nc-v'].forEach(k => nc.style.removeProperty(k));
        nc.style.minHeight = `${avail}px`;
    });
}
function oppWidth(nc) {
    const r = document.createRange();
    let w = 0;
    nc.querySelectorAll('.mt-nc-chip-opp').forEach(el => { r.selectNodeContents(el); w = Math.max(w, Math.ceil(r.getBoundingClientRect().width)); });
    return w;
}

function fitNightCalendars(container) {
    container.querySelectorAll('.mt-nc').forEach(nc => {
        nc.classList.remove('mt-nc-compact', 'mt-nc-2col');
        const group = nc.closest('.mt-group');
        const head = group ? group.querySelector(':scope > .mt-group-head') : null;
        const avail = group ? group.clientHeight - (head ? head.getBoundingClientRect().height : 0) : 0;
        if (!avail) return;
        if (nc.scrollHeight <= avail) return;
        nc.classList.add('mt-nc-compact');
        if (nc.scrollHeight <= avail) return;
        nc.classList.add('mt-nc-2col');
    });
}

// The Category Rankings arrow language, so the two cycles read as one control. Wraps, so it never dead-ends and never needs a disabled state.
function wireTeamSwitcher(container) {
    const ids = AppState.teamStats.map(t => t.id);
    const step = (delta) => {
        const i = ids.indexOf(viewedTeamId);
        viewedTeamId = ids[(i + delta + ids.length) % ids.length];
        // A deliberate choice, so a later login must not silently pull the view back.
        viewedTeamIsStandIn = false;
        renderMyTeamTab();
    };
    container.querySelector('.mt-prev')?.addEventListener('click', () => step(-1));
    container.querySelector('.mt-next')?.addEventListener('click', () => step(1));
}

// The Schedule calendar's seven-day step moves one day at a time. Each button carries the page it was rendered against, so the click reads where it is rather than recomputing the window. renderSchedule's clamp keeps a repeated click from stepping past either end, which covers a change of matchup between renders.
function wireScheduleCalendar(container) {
    container.querySelectorAll('.mt-cal-page-prev, .mt-cal-page-next').forEach(btn => {
        btn.addEventListener('click', () => {
            const from = Number(btn.dataset.calPageStart);
            const step = Number(btn.dataset.calStep);
            AppState.myTeamScheduleWindowStart = from + step;
            renderMyTeamTab();
        });
    });
}

// The strip's chips sit on one line and "+N more" replaces whatever does not fit. coverage-band.js has no DOM, so it renders every chip plus a hidden more element and leaves the measurement to this function, re-run after every render like the drawer wiring. The drawer's own chip rows are never touched, since the drawer shows all.
function fitCoverageStripChips(container) {
    const row = container.querySelector('.cvs-chips');
    if (!row) return;
    const more = row.querySelector('.cvs-more');
    const chips = Array.from(row.querySelectorAll('.cvs-chip'));
    if (!more || !chips.length) return;

    // Mobile wraps the whole chip row instead of truncating it, so every chip shows and this one-line math would only hide chips a wrapped row has room for. It reads the row's computed flex-wrap rather than a window-width literal.
    if (getComputedStyle(row).flexWrap === 'wrap') {
        chips.forEach(c => { c.hidden = false; });
        more.hidden = true;
        return;
    }

    // Each chip's own natural width, unaffected by the still-hidden indicator or by its siblings (flex-nowrap items keep their own content size regardless of what else is in the row).
    more.hidden = true;
    const gapPx = parseFloat(getComputedStyle(row).gap) || 0;
    const available = row.clientWidth;
    const widths = chips.map(c => c.offsetWidth);
    const totalWidth = widths.reduce((s, w) => s + w, 0) + gapPx * Math.max(0, chips.length - 1);
    if (totalWidth <= available) return; // every chip already fits, so the indicator stays hidden

    more.hidden = false;
    const moreWidth = more.offsetWidth;
    let used = 0;
    let shown = 0;
    for (; shown < chips.length; shown++) {
        const next = used + widths[shown] + (shown > 0 ? gapPx : 0);
        // The last chip needs no room reserved for the indicator beside it, only a chip with real overflow behind it does, and every earlier chip leaves room in case this is where the row runs out.
        const reserve = (shown === chips.length - 1) ? 0 : moreWidth + gapPx;
        if (next + reserve > available) break;
        used = next;
    }
    for (let i = shown; i < chips.length; i++) chips[i].hidden = true;
    const hiddenCount = chips.length - shown;
    if (hiddenCount > 0) more.textContent = `+${hiddenCount} more`;
    else more.hidden = true;
}

// The compare drawer widens for the open day strip. Seven day columns in the normal drawer width truncated every name to three letters. The width comes from canvas.measureText at the cell's own computed font over the actual rendered text, since a character-unit CSS estimate would be wrong for a proportional font.
function fitCompareStripWidth(container) {
    const drawer = container.querySelector('.mt-compare-drawer');
    const strip = container.querySelector('.tc-strip');
    if (!drawer) return;
    // Closed, or no baseball day strip at all, returns to the drawer's default width. The class does the sizing in CSS so one place says what narrow means.
    if (!strip) { drawer.classList.remove('tc-drawer-wide'); drawer.style.removeProperty('--tc-drawer-w'); return; }

    const starts = Array.from(strip.querySelectorAll('.tc-day-start'));
    const dayCols = strip.querySelectorAll('.tc-day-head').length || 7;
    const labelCol = strip.querySelector('.tc-day-who');
    const labelWidth = labelCol ? labelCol.getBoundingClientRect().width : 46;

    let widest = 0;
    if (starts.length) {
        const probe = starts[0];
        const cs = getComputedStyle(probe);
        const cellStyle = getComputedStyle(probe.parentElement);
        const canvas = fitCompareStripWidth.canvas || (fitCompareStripWidth.canvas = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        starts.forEach(el => { widest = Math.max(widest, ctx.measureText(el.textContent).width); });
        // The cell's horizontal padding and border ride on top of the text itself, and canvas measures neither.
        widest += (parseFloat(cellStyle.paddingLeft) || 0) + (parseFloat(cellStyle.paddingRight) || 0)
            + (parseFloat(cellStyle.borderLeftWidth) || 0) + (parseFloat(cellStyle.borderRightWidth) || 0);
    }
    const gridStyle = getComputedStyle(strip.querySelector('.tc-strip-grid') || strip);
    const gap = parseFloat(gridStyle.columnGap || gridStyle.gap) || 3;
    const drawerPad = parseFloat(getComputedStyle(drawer).paddingLeft) * 2 || 28;
    // A few extra pixels of slack, since canvas font metrics can round a hair differently than the DOM's layout, which is cheaper than a truncated name reappearing.
    const needed = Math.ceil(labelWidth + dayCols * (widest + gap) + drawerPad + 12);
    drawer.classList.add('tc-drawer-wide');
    drawer.style.setProperty('--tc-drawer-w', `${Math.max(600, needed)}px`);
}

// The coverage drawer is one width across all four adds modes. Modes with no adds table to measure replay the last real measurement instead of narrowing the drawer. It measures by canvas and not by rect, because the table is full width of a scrolling box, so a few gain columns stretch to fill the narrow drawer and a rect would report that stretched width as the content's need.
function fitCoverageDrawerWidth(container) {
    const drawer = container.querySelector('.mt-coverage-drawer');
    if (!drawer) return;
    const widthKey = `${AppState.loadedSport}:${AppState.apiData.id}:${AppState.apiData.seasonId}:${viewedTeamId}`;
    // Drop for builds no ranked-adds table, but its pair cards and ledger need the same room a ranked table does, and five mode buttons no longer fit the narrow width. It is unconditional and not cached, since the pair cards' width does not depend on any roster's content.
    if (AppState.coverageAddsMode === 'drop') {
        drawer.classList.add('cvd-drawer-wide');
        drawer.style.setProperty('--cvd-drawer-w', '600px');
        return;
    }
    const table = drawer.querySelector('.cvd-adds');
    if (!table) {
        // The five mode buttons do not fit the plain narrow shell either, so there is a floor. Removing the wide class when no width was cached yet made the first open on a fresh load overflow. The floor is the same one drop mode uses, and a wider cached width measured from a real ranked table still wins.
        const w = (lastCoverageDrawerWidth.key === widthKey && lastCoverageDrawerWidth.width)
            ? Math.max(600, lastCoverageDrawerWidth.width) : 600;
        drawer.classList.add('cvd-drawer-wide');
        drawer.style.setProperty('--cvd-drawer-w', `${w}px`);
        return;
    }

    // The sticky group's widths are fixed by the stylesheet and declared in pixels, so they are not measured. Reading them back off the same rule would only risk drifting from it.
    const stickyWidth = 124 + 62 + 68;

    // Gain columns hold the header label and the widest sample body value in one column, canvas-measured at the table's own font. At least three columns' worth is a floor on what the drawer guarantees visible and not a cap on how many can show.
    const heads = Array.from(table.querySelectorAll('thead th')).slice(3);
    if (!heads.length) {
        // The same fresh-load gap as the no-table branch, for a table shell with nothing picked yet. The mode row above the shell still needs the floor even though this table has nothing to measure.
        const w = (lastCoverageDrawerWidth.key === widthKey && lastCoverageDrawerWidth.width)
            ? Math.max(600, lastCoverageDrawerWidth.width) : 600;
        drawer.classList.add('cvd-drawer-wide');
        drawer.style.setProperty('--cvd-drawer-w', `${w}px`);
        return;
    }
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 8);
    const cs = getComputedStyle(table);
    const canvas = fitCoverageDrawerWidth.canvas || (fitCoverageDrawerWidth.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const cellPad = 16; // dashboard.css.cvd-adds td/th: padding 4px 8px, both sides.
    const colWidths = heads.map((th, i) => {
        let w = ctx.measureText(th.textContent).width;
        bodyRows.forEach(row => {
            const td = row.children[3 + i];
            if (td) w = Math.max(w, ctx.measureText(td.textContent).width);
        });
        return w + cellPad;
    });
    const sample = colWidths.slice(0, 3);
    const perCol = sample.length ? sample.reduce((s, w) => s + w, 0) / sample.length : 0;
    const gainWidth = perCol * 3;
    const drawerPad = parseFloat(getComputedStyle(drawer).paddingLeft) * 2 || 28;
    const needed = Math.ceil(stickyWidth + gainWidth + drawerPad + 4);
    const width = Math.max(600, needed);
    drawer.classList.add('cvd-drawer-wide');
    drawer.style.setProperty('--cvd-drawer-w', `${width}px`);
    lastCoverageDrawerWidth = { key: widthKey, width };
}

// The pin only has to hold across modes within one league and not across every sport sharing one number, since one sport's worst case forced onto every league left another sport's groups sitting in visible dark. It is measured once per render off the same grouped picker every mode draws, so the number is identical whichever mode triggered it.
function fitCoveragePickSlotHeight(container) {
    const drawer = container.querySelector('.mt-coverage-drawer');
    if (!drawer) return;
    const slot = drawer.querySelector('.cvd-pick-slot');
    const pick = slot && slot.querySelector('.cvd-pick');
    if (!pick) return;
    // Measured at the drawer's own narrow width and not whichever width this render carries. Some modes wrap the same chips into fewer columns than the wide drawer, so the narrow width is always the taller reading and the one the fixed slot must clear. The wide class is toggled off for one synchronous measurement, and reading scrollHeight forces the layout before the class goes back, so nothing paints in between.
    const wasWide = drawer.classList.contains('cvd-drawer-wide');
    const savedVar = drawer.style.getPropertyValue('--cvd-drawer-w');
    if (wasWide) {
        drawer.classList.remove('cvd-drawer-wide');
        drawer.style.removeProperty('--cvd-drawer-w');
    }
    const contentHeight = pick.scrollHeight;
    if (wasWide) {
        drawer.classList.add('cvd-drawer-wide');
        if (savedVar) drawer.style.setProperty('--cvd-drawer-w', savedVar);
    }
    // One chip row's own gap on top, no more slack than the gap itself.
    drawer.style.setProperty('--cvd-pick-slot-h', `${contentHeight + 3}px`);
}

// The coverage drawer's open and close buttons are re-wired on every render, since the drawer element is rebuilt each time. Escape is bound once on the document and queries the live DOM on each keystroke. The strip's own control is the toggle, and its label lives in the rendered HTML, so both the click and Escape re-render the tab rather than flipping a hidden attribute.
let coverageDrawerEscapeWired = false;
let scheduledCompareDismissed = null;
function wireCoverageDrawer(container, dropForState) {
    // Two buttons carry this class, the strip's Open and Close toggle and the drawer's header Close. Both flip the same state the same way, so every match is wired rather than only the first.
    container.querySelectorAll('.mt-strip-open').forEach(openBtn => {
        openBtn.addEventListener('click', () => {
            AppState.myTeamCoverageDrawerOpen = !AppState.myTeamCoverageDrawerOpen;
            // The two drawers share the roster's one right-hand slot, so opening this one closes the other rather than stacking.
            if (AppState.myTeamCoverageDrawerOpen) AppState.myTeamCompareDrawerOpen = false;
            renderMyTeamTab();
        });
    });
    // The mode row's controls write session state and re-render. Neither touches storage.
    container.querySelectorAll('[data-adds-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.coverageAddsMode = btn.getAttribute('data-adds-mode') || 'one';
            renderMyTeamTab();
        });
    });
    container.querySelectorAll('[data-pick-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-pick-cat');
            if (!id) return;
            const set = AppState.coverageAddsPicked instanceof Set ? AppState.coverageAddsPicked : new Set();
            if (set.has(id)) set.delete(id); else set.add(id);
            AppState.coverageAddsPicked = set;
            renderMyTeamTab();
        });
    });
    // The strip's "Cheapest to lose" chip and a roster row's "Drop for" entry both carry this attribute. They open the drawer, closing Compare, on the fifth mode with this player already picked.
    container.querySelectorAll('[data-drop-entry-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Both the strip's chip and a roster row's hover button sit inside an element with its own click handler, since a roster row opens the drill-down, so without this "Drop for" would open the drawer and the drill-down at once.
            e.stopPropagation();
            const id = Number(btn.getAttribute('data-drop-entry-id'));
            if (!Number.isFinite(id)) return;
            AppState.coverageDropId = id;
            AppState.coverageDropCandidateId = null;
            AppState.coverageAddsMode = 'drop';
            AppState.myTeamCoverageDrawerOpen = true;
            AppState.myTeamCompareDrawerOpen = false;
            renderMyTeamTab();
        });
    });
    // The drop-for mode's pair of pickers. Each select carries its roster or candidate id, or the empty string for nothing chosen, written straight to the ids the ledger reads as a plain number or null and never a Set.
    container.querySelectorAll('[data-drop-select]').forEach(sel => {
        sel.addEventListener('change', () => {
            const which = sel.getAttribute('data-drop-select');
            const id = sel.value ? Number(sel.value) : null;
            if (which === 'drop') AppState.coverageDropId = id;
            else AppState.coverageDropCandidateId = id;
            renderMyTeamTab();
        });
    });
    // The search shelf filters in memory on every keystroke, because a full render per character would blow the input's focus away mid-word. The pool is already ranked and this only narrows it by a substring match on name, club or position, never re-ordering it.
    container.querySelectorAll('[data-drop-search]').forEach(input => {
        const pool = (dropForState && dropForState.searchPool) || [];
        const results = container.querySelector(`[data-drop-results="${input.getAttribute('data-drop-search')}"]`);
        if (!results) return;
        const rowHtml = (p) => `<button type="button" class="cvx-search-row" data-search-pick-id="${p.id}">
            <span class="cvx-search-name">${escapeHtml(p.name)}</span>
            <span class="cvx-search-meta">${[p.teamName, p.positionDisplay].filter(Boolean).map(t => escapeHtml(t)).join(' · ')}</span>
        </button>`;
        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            if (!q) { results.hidden = true; results.innerHTML = ''; return; }
            const matches = pool.filter(p => p && (
                (p.name || '').toLowerCase().includes(q) ||
                (p.teamName || '').toLowerCase().includes(q) ||
                (p.positionDisplay || '').toLowerCase().includes(q)
            )).slice(0, 40);
            results.innerHTML = matches.length ? matches.map(rowHtml).join('')
                : '<div class="cvx-search-empty">No free agent matches that.</div>';
            results.hidden = false;
            results.querySelectorAll('[data-search-pick-id]').forEach(btn => {
                btn.addEventListener('click', () => {
                    AppState.coverageDropCandidateId = Number(btn.getAttribute('data-search-pick-id'));
                    renderMyTeamTab();
                });
            });
        });
    });
    if (coverageDrawerEscapeWired) return;
    coverageDrawerEscapeWired = true;
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!AppState.myTeamCoverageDrawerOpen && !AppState.myTeamCompareDrawerOpen) return;
        AppState.myTeamCoverageDrawerOpen = false;
        AppState.myTeamCompareDrawerOpen = false;
        renderMyTeamTab();
    });
}
