// My Team: the third pillar. Team Metrics answers how the LEAGUE is doing, Player Metrics answers who is good, this answers how MY team is doing and why. It is a roster VIEWER that defaults to the user's own team and can scout any other, which is what makes the later lineup features (optimal lineup, keep/drop, the time machine) work for whichever team is on screen. Nothing here forks the engines: ranks come from the leaderboard's own pool ranking, the category profile from the heatmap's aggregation.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, INVERSE_STATS, RATE_COMPONENTS, NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_ORDER, LINEUP_SLOT_LABELS, SLOT_POSITION_MAPS, POSITION_MAPS, nonStartingLabels, lowerIsBetterIds } from './state.js';
import { seasonState, SEASON_STATE, isPreseason, seasonIsFinished } from './season-state.js';
import { escapeHtml, getTimeframeBounds, axisUnit, attachDataTooltips, splitStatIdsByRole, injuryBadgeHtml, playerPoolErrorText, parseTimeframe, registerLeagueView, setDebugContext, readsAsPlayedMatchup } from './utils.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { rosterRankLookup, openPlayerDetail, playerRoleGroups, effectivePlayerPool, loadPlayerTabIfNeeded, matchupPeriodMap, periodsOfMatchup, ensureWeeklyDataForTimeframe, weeklyDataPending, revalidateStalePoolIfDue, groupLabel as roleGroupLabel } from './players.js';
import { fetchRosterForPeriod, fetchProTeamSchedules, fetchScoreboardOdds, invalidateStoredProSchedule, finalScoringPeriodOf } from './api.js';
import { buildGamePeriodIndex, buildProTeamAbbrevs, currentMatchupWindow, countProjectedStarts, buildOddsIndex, moneylineFor, datesByScoringPeriod, dayLabelerFor } from './probables.js';
// Schedule-insight contract v1 (tests/fixtures/schedule-insight.md). Both functions take the matchup's own DAYS, never settings.scheduleSettings.matchupPeriods (that field maps a matchup to week indices, not scoring periods - the contract's own measured trap).
import { twoStartPitchers, gamesByProTeamForMatchup, matchupWindow } from './schedule-insight.js';
import { coverageBand, idsToSum, sumPlayers } from './coverage-model.js';
// remainderLine is the ONE derivation of "what is still expected"; every forward-looking figure on this tab reads it so two cards can never sum different bases.
import { remainderLine } from './projected-basis.js';
import { rosterNightCoverage } from './schedule-insight.js';
import { buildNightsBandHtml } from './off-night-band.js';
import { startingSlotsByGroup } from './draft-engine.js';
import { buildCoverageStripHtml, buildCoverageDrawerHtml, buildCoverageDrawerHeadHtml } from './coverage-band.js';
import {
    teamOffence, offenceStrength, offenceBreakdown, startDifficulty, difficultyLabel, daysBetween, isSidelined,
    SHORT_REST_ADJUSTMENT, SHORT_REST_DAYS, MLB_PARK_FACTORS
} from './matchup-difficulty.js';
import { GAMES_PLAYED_IDS, competitionRanks, formatRank } from './rank-engine.js';
import { teamCategoryProfile } from './graphs.js';
import { teamCompare } from './team-compare.js';
import { buildTeamCompareHtml } from './team-compare-band.js';

// Which team the tab is showing, remembered per league so scouting another roster survives a tab switch but never leaks into the next league fetched.
let viewedTeamKey = null;
let viewedTeamId = null;
// True while the tab is showing a team it picked for want of a better answer, rather than one the SWID matched or the user chose. Only a stand-in may be replaced automatically.
let viewedTeamIsStandIn = false;
// Per-group sort, one category at a time: { statId, dir } or null for the roster's own slot order. Kept per role so sorting the batters never disturbs how the pitchers read.
let groupSort = { primary: null, secondary: null };
// Which face the pitching group shows: its category table, or the matchup laid out by day. Only pitchers get a second view, because only pitchers have scheduled starts to lay out.
let pitchingView = 'categories';
// The start whose scoring is open below the calendar, as `${playerId}:${period}`. One at a time, the same way the drill-down explains one rank pool at a time rather than all of them at once.
let openStartKey = null;
// Which component of the open start is showing its evidence, 'lineup' or 'park', or null for the card itself. A third panel in the same one-at-a-time stack the calendar and the breakdown already share, so reading the lineup behind a score costs the card's own space and nothing else.
let openStartDrill = null;
// Two columns that are not ESPN stat ids: the fantasy points a points league scores its players by, and the rank chip itself, which is sortable like any other column.
const POINTS_COL = '__points__';
const RANK_COL = '__rank__';
// Projected starts. A pseudo-column like the two above, since it is not an ESPN stat id. It is counted from the probables feed against the pro schedule, and it only exists for pitchers.
const STARTS_COL = '__starts__';
const GAMES_COL = '__games__';
// Real line breaks in a data-hint, which the hint tooltip renders via white-space: pre-line.
const NEWLINE = String.fromCharCode(10);
// Half-width of the park bars' scale, in run-index points. Coors is +25 and T-Mobile -17, so 25 puts the widest park at the end of its half and everything else in proportion to it. Derived from the shipped table rather than typed, so a refresh that moves the extreme moves the scale.
const PARK_INDEX_SPAN = Math.max(...Object.values(MLB_PARK_FACTORS).map(p => Math.abs(p[0] - 100)));
// A finished season's last lineup, fetched once per league. The payload carries current rosters only while a matchup is live, so this is what makes the tab work after a season ends. ESPN still serves the final scoring period's rosters, which IS the team as it stood for the last matchup.
let finalRosters = { key: null, byTeam: null, state: 'idle' };
// The pro schedule behind projected starts, fetched once per league and re-rendered into when it lands. Same fire-and-forget shape as finalRosters above, and a failure just means the line does not render. proTeams is the raw settings.proTeams array (schedule-insight's gamesByProTeamForMatchup wants it directly, proGamesByScoringPeriod and all) - held alongside the derived index/abbrevs rather than re-deriving it, since it is the same one fetch.
let proSchedule = { key: null, index: null, abbrevs: null, proTeams: null, state: 'idle' };
// The day's betting lines, same fire-and-forget shape. Odds exist for ESPN's current slate only, so this answers for at most one day of the calendar and a miss is the ordinary case.
let scoreboardOdds = { key: null, index: null, state: 'idle' };
// The column widths chosen for a roster at a viewport. Deliberately NOT keyed on the timeframe: switching windows changes the VALUES (a full-season 0.947 against a single matchup's dash) and re-measuring those resized the whole table on every pill click. Widths may only ever GROW within a key, so entering a wider window still cannot clip, and the table never shrinks back.
let lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };

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

// Only the COLUMN widths have anything to invalidate now. The vertical layout is computed from counts and constants on every render, so there is nothing about it to remember and nothing to go stale - a resize, a league swap or a hidden tab all recompute.
export function invalidateMyTeamLayout() {
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
}

// Registered rather than called from the fetch path. The scouted team belongs to the league that was on screen, so a new league starts on its own owner's team again.
registerLeagueView('myteam', { reset: resetMyTeamView, revalidate: invalidateProSchedule });

export function resetMyTeamView() {
    viewedTeamKey = null;
    viewedTeamId = null;
    viewedTeamIsStandIn = false;
    groupSort = { primary: null, secondary: null };
    pitchingView = 'categories';
    openStartKey = null;
    openStartDrill = null;
    finalRosters = { key: null, byTeam: null, state: 'idle' };
    proSchedule = { key: null, index: null, abbrevs: null, proTeams: null, state: 'idle' };
    scoreboardOdds = { key: null, index: null, state: 'idle' };
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    // The widths live on the CONTAINER as inline custom properties, and the container outlives every render - innerHTML replaces what is inside it, never its own style attribute. Clearing the module's memory while leaving those behind is not a reload, which is what a league switch was getting: sizeRosterColumns returns early when it has no names, no width or no sample, and any of those on the first render after a switch left the previous league's column widths standing on screen. A fresh load starts with nothing set, so a switch has to as well (owner).
    const container = document.getElementById('myteam-container');
    if (container) {
        ['--mt-player-w', '--mt-pos-w', '--mt-stat-w'].forEach(n => container.style.removeProperty(n));
    }
}

// The pro-team schedule is fetched once per sport+season and then held, which is why the Schedule tab never noticed a game finishing. Dropping the local key was NEVER enough on its own: ensureProSchedule refetches through fetchProTeamSchedules, which served its own AppState/storage.session copy - so the "refetch" was a cache read and the tab could run a whole browser session on one body. Both halves drop now, and the next render genuinely asks the network. The INDEX stays on screen until the new one lands, because ensureProSchedule replaces it wholesale rather than clearing it first.
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
            // Kept beside the index so the games column can NAME a day ("Tue") without walking the payload again - the same dates buildGamePeriodIndex already read on the way past.
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

// Same shape as ensureProSchedule: one call per league, re-render when it lands, and a failure just means no card carries a line. Deliberately NOT part of the fit's completeness gate - odds are decoration on a few cards, and making the whole tab wait on them would be the exact mistake that gate was narrowed to avoid.
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

// findOwnedTeamId moved to utils.js when the pre-draft face became its third caller - graphs.js could not import it from here without a cycle. Re-exported so this module stays the name every existing caller already knows it by.
import { findOwnedTeamId, resolveMyTeamId } from './utils.js';
export { findOwnedTeamId };

// PURE. Splits a roster into the three bands the tab draws: starters in the league's own slot order, then bench, then IR. Slots the league does not roster are skipped, and a slot this app has no order for still renders, appended in id order, so an unfamiliar roster construction degrades to a sane list instead of dropping players. entries: [{ playerId, lineupSlotId }] counts: the league's rosterSettings.lineupSlotCounts
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

// PURE. The current roster off the league payload itself, which carries it on each side of an in-progress matchup (VALIDATED: a live 2026 MLB capture covers all four teams at scoringPeriodId 104, while three completed-season captures carry none). Returns a Map of teamId to entries; an empty map means the season is over or the week has no games, and the caller falls back to one mRoster call. TWO SOURCES, IN ORDER, AND A THIRD CASE THAT IS NEITHER. This read the schedule sides only, and MEASURED across the capture set that is a LIVE-SEASON dependency rather than the one-sport bug it was reported as: of four Download All sets, the ONE taken mid-season carries rosterForCurrentScoringPeriod on 4 schedule sides and nothing in teams[].roster, while all three FINISHED leagues - one per sport - carry 181, 113 and 80 entries in teams[].roster and nothing on any side. ESPN attaches the side roster to the period it is serving, and a season that has ended is serving none. So My Team lost its roster on every finished or past season in every sport, which is what "No roster available for this team" was. THE SIDES WIN WHERE THEY EXIST. They are the roster for the period being served, which is the one the tab is describing; teams[].roster is the mRoster view's shape and is a whole-team snapshot. AND A LEAGUE THAT HAS NOT DRAFTED SHOWS NOTHING FROM EITHER, which is the case an entry count cannot decide (R5). ESPN carries LAST season's final roster forward until the draft, in both fields - so a fallback that trusted whichever source had rows would answer a pre-draft league with last year's team and label it this year's. Only the season state can tell that apart, and this tab already reads it. Before a draft, "No roster available" is the correct answer, not a gap to be filled.
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
    // The shared convention (state.js nonStartingLabels), not a second copy of it - this tab and the pre-draft ground must not disagree about what seat 16 is called.
    const nonStarting = nonStartingLabels(sport);
    if (nonStarting[slot]) return nonStarting[slot];
    // The ONE validated display-label catalog (state.js LINEUP_SLOT_LABELS) - it carries every starting slot including hockey's 0/1/2 (C/LW/RW, validated ) and the roster-status slots SLOT_POSITION_MAPS deliberately excludes (that map is an eligibility decoder, not a display table, and has no fhl key at all - the source of bug 2's raw-digit hockey slots). SLOT_POSITION_MAPS stays a fallback for any flb granularity LINEUP_SLOT_LABELS lacks.
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    if (labels[slot]) return labels[slot];
    const map = SLOT_POSITION_MAPS[sport] || {};
    return map[slot] || String(slot);
}

// WHICH FIGURES THIS TAB IS SHOWING. A league that has drafted but not played has no season line to show - every cell would read a dash - so the roster reads its PROJECTED line instead, under the same PRESEASON - PROJECTED tag Team Metrics wears. Every other state stays as it is: seasonState is the only thing that decides, and no surface re-derives it.
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
    // NO GAMES, NO RECORD. This is derived from weekly results, and in preseason there are none - so every team summed to 0-0-0 and competition ranking, correctly, called them all T1 of 4. The band read "RECORD 0-0-0 T1 of 4" under a tag saying nobody has played, which is the surface asserting a result it has just finished denying. ABSENT, not zeroed, and not a projected placing either: the projected standing is computed by the Team Metrics view, and a view must never import another view. The tab that owns that number already prints it. Here the honest answer is to say nothing. isPreseason, not projectedBasis's own === PRESEASON (S5/R5): a league that has not drafted yet reaches this function too, and projectedBasis's narrower check let it fall through to the record math below, which read "0-0-0 T1 of 10" under a mast that had not even named a draft date yet - a result asserted before there was a team to post one.
    if (isPreseason(seasonState(AppState.apiData))) return null;
    if (AppState.isRotoLeague) {
        const ranked = [...AppState.teamStats].sort((a, b) => b.rotoPoints - a.rotoPoints);
        // Through the shared convention, so two teams on the same points read T-N rather than being handed a first and a second by sort order.
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
            // A playoff bye is not a game. Its points count, its non-result does not.
            if (t.weeklyBye?.[wk]) continue;
            // A WEEK WITH NO RESULT IS NOT A LOSS. In a points league weeklyMatchWins holds POINTS, so the undefined check above only skips a week with no points entry at all - the RESULT lives in weeklyMatchResult, and data.js withholds it for a week nobody has played. `|| 0` turned that absence into a 0, and 0 is the loss branch, so an unplayed league read 0-1-0 on its first week. graphs.js has skipped it correctly since (computeRecordByTier), which is why Team Rankings and this disagreed.
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

// Re-renders the tab when its own box changes size, so the layout is never left holding an answer that was true for a window the user has since resized. Entering the tab already recomputes from scratch, and a resize is the same situation - the inputs changed - so it takes the same path rather than a second, subtly different one. Observing the CONTAINER, not the roster band, for two reasons. The band is rebuilt by every render, so an observer on it would have to be re-attached and could be re-triggered by its own output; the container is only ever written INTO. And the band's height changes for a second reason besides the viewport - the summary above it rewrapping to another line, which is what happens at 1229px and again at 809px - and that shows up as a width change on the container while the window listener it would otherwise need fires before the rewrap has been laid out. WHY IT CANNOT FEED ITSELF, which matters more than usual here because THIS CANNOT BE TESTED IN THE HARNESS. The preview page runs with document.hidden true, and rAF, the resize event and ResizeObserver are all driven by the rendering steps a hidden page skips - measured, zero callbacks of any of the three across a viewport change. So the argument has to be structural rather than "it did not loop when tried"..myteam-container is flex:1 1 auto with min-height:0 inside a view whose height the viewport fixes, and the page never scrolls in either axis. Its box is therefore set entirely by its parent, and nothing a render writes INSIDE it - row heights, column widths, the pitching share - can change it. A render cannot move the thing being watched, so it cannot retrigger this. The size guard below is what makes that concrete, and it is only a second line of defence: an in-flight flag would be worse than nothing, since it would have to be cleared before the observer could possibly redeliver and would read as a protection it was not providing.
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
        // The columns were measured for the old width and the vertical layout computed for the old height. Both are stale for the same reason, so both are dropped together - which is exactly what entering the tab does, rather than a second path that could drift from it.
        invalidateMyTeamLayout();
        renderMyTeamTab();
    });
    myTeamResizeObserver.observe(container);
}

export function renderMyTeamTab() {
    const container = document.getElementById('myteam-container');
    if (!container) return;
    observeMyTeamLayout(container);

    if (!AppState.apiData || !AppState.teamStats.length) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }

    // This tab shows pool numbers (ranks, category lines), so rendering it consumes a deferred pool revalidate. The current pool draws below; the fresh one swaps in via the pool-ready event this tab already listens for.
    revalidateStalePoolIfDue();

    const sport = AppState.loadedSport;
    const key = `${sport}:${AppState.apiData.id}:${AppState.apiData.seasonId}`;
    if (viewedTeamKey !== key) {
        viewedTeamKey = key;
        viewedTeamId = null;
        viewedTeamIsStandIn = false;
        // A chosen opponent belongs to THIS league (S22) - carrying an id across a league switch would compare against a team id that means something else, or nothing, in the new one.
        AppState.myTeamCompareOpponentId = null;
        AppState.myTeamCompareDrawerOpen = false;
        // R9/S57: a pinned schedule page names a period NUMBER, which is only ever meaningful against the matchup it was pinned in - carried into a new league it would either land on an unrelated week or miss every clamp outright and fall back to today anyway. Cleared here rather than relied on to fail safely, so the pin never has a chance to name the wrong days.
        AppState.myTeamScheduleWindowStart = null;
    }
    if (viewedTeamId == null || !teamById(viewedTeamId)) {
        // resolveMyTeamId (utils.js, S14b) is now the ONE place this question is answered - a real SWID match wins, and a stand-in (whoever standings puts first) fills in otherwise, marked so a SWID arriving later can correct it. A user who logs in mid-session otherwise sits on a stranger's roster on the tab called My Team, and never learns it is not theirs.
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
    // The diagnostic panel's 'roster' kind used to fill only from the timeline snapshot (fetchRosterPeriod), which this tab's PRIMARY path never calls - a live season reads its roster straight off the league payload's own rosterForCurrentScoringPeriod, no separate request at all, so a capture running Download All on exactly that path got team.json (the whole payload) but no roster.json, because nothing had ever told the panel this tab was reading a roster out of it. rostersFromPayload stays pure (no side effects belong in a function documented as pure), so the capture happens here, in the caller, reshaped into the same {teams:[{id, roster:{entries}}]} shape a real mRoster response has, so roster.json reads the same way regardless of which path actually supplied the data.
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
    // A points league is scored on one number, so that number leads its stat block. The individual stats behind it stay, but the column the league actually cares about reads first. "Starts" rather than the GS abbreviation (owner). GS is a real stat, and this column sits in a row of actual season totals (W, SV, K, ERA, QS), so the abbreviation would read as one.
    const colLabel = (id) => (id === POINTS_COL ? 'PTS' : id === STARTS_COL ? 'Starts' : id === GAMES_COL ? 'Games' : statMap[id]);

    const standing = teamStandingLine(team);
    const profile = teamCategoryProfile(team.id);
    // S17b: the coverage strip/drawer's own "Losing"/"Winning" reads off the SAME rank the WINS/BLEEDS chips above them already show, not coverage-model.js's own share-based `weak` - the owner reads both as the same word, and only one of them is the band's actual position in the league. profile.worst IS the bleeding set (below the league's median); profile.all is every scored category's rank, keyed here by id for the drawer's per-card badge.
    const coverageLosingIds = new Set((profile.worst || []).map(r => String(r.id)));
    const coverageRankById = new Map((profile.all || []).map(r => [String(r.id), r]));
    const isOwn = AppState.userSwid && findOwnedTeamId(AppState.apiData.teams, AppState.userSwid) === team.id;
    ensureProSchedule(key);
    ensureScoreboardOdds(key);

    // The shared timeframe drives this tab like it drives the other two. The season lines come off the pool as the CURRENT window sees it, and the ranks already do, since rosterRankLookup reads the same pool. On Full Season this is the season totals unchanged, so nothing about today's rendering moves. A windowed pill needs weekly data, and a player it has not landed for is absent from the effective pool, which the note below owns rather than a silent dash. Nothing else asks for the pool on this tab's behalf. main.js only loads it when the PLAYER tab is entered, so a league switched while My Team was on screen left the roster showing bare ids forever, and visiting Player Metrics was what secretly fixed it. Ask here, and the pool-ready listener above redraws when it lands.
    if (!AppState.playerDataLoaded && !AppState.playerDataError) loadPlayerTabIfNeeded();
    // Without the pool there are no names, ranks or stats, so the roster would be a column of headshots against blank rows - which is what a logged-out user actually saw. The summary band above stays, because it comes off the league payload and is still true.
    const poolFailed = !AppState.playerDataLoaded && !!AppState.playerDataError;
    const windowedPool = effectivePlayerPool(sport);
    const poolById = new Map(windowedPool.map(p => [p.id, p]));
    const rosterIds = new Set(entries.map(e => e.playerId));
    // A windowed pill reads the weekly rows, so ASK for them here. Nothing on this tab used to, which is why a league opened straight into My Team showed every windowed line as a dash until the user happened to visit Player Metrics, the only tab that requested them. Same shape as, where the POOL had this problem.
    if (AppState.playerDataLoaded && parseTimeframe(AppState.timeframe).window !== null) {
        ensureWeeklyDataForTimeframe(sport);
    }
    // A rostered player absent from the windowed pool has no weekly row cached, which means one of two very different things: the rows have not arrived yet, or they have and nothing was played in this window. Saying "no games in this timeframe" while the fetch is still running asserts the second when the truth is the first.
    const windowedMissing = AppState.playerDataLoaded
        ? [...rosterIds].filter(id => !poolById.has(id) && AppState.playerData.some(p => p.id === id)).length
        : 0;
    const weeklyStillArriving = windowedMissing > 0 && weeklyDataPending();

    // A dash still means unranked, but it now says WHY when the lookup knows. The two states it used to flatten together are not the same thing. Nobody clicked a dash and learned that their pitcher had not pitched in the window they were looking at.
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
    // Projected starts for the matchup being played, counted once and read by the pitcher column below. IR is excluded because those players cannot be started without a roster move, while the bench is INCLUDED. In a daily-lineup league a benched starter is routinely slotted in on the morning of a start, so those turns are ones this roster can actually take.
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

    // The matchup's own days, off the league's real schedule (buildMatchupPeriodMap/periodsOfMatchup) and never off settings.scheduleSettings.matchupPeriods - that field maps a matchup to WEEK indices, not scoring periods, which is the schedule-insight contract's own measured trap (a factor-of-seven miscount). Shared by the two-start badges and the games-per-team note below, so both read the same days currentMatchupWindow itself pointed at.
    const matchupDays = (() => {
        if (!AppState.playerDataLoaded) return null;
        const win = currentMatchupWindow(matchupPeriodMap(), AppState.apiData.scoringPeriodId);
        if (!win) return null;
        const periods = periodsOfMatchup(matchupPeriodMap(), win.matchup);
        return periods.length ? { matchup: win.matchup, periods } : null;
    })();

    // GAMES THIS MATCHUP, per player. The same question the Starts column answers for pitchers, asked of everyone: how many of the club's games are still ahead in the matchup being played. A batter never had a column saying whether there is even a game this week, which is the first thing a start/sit decision needs. Memoised per player rather than precomputed for the roster, because the roster is assembled in four groups in three different places and a second list of who is on it is a second thing to keep in step. THE CATEGORY COVERAGE BAND. What this team is winning and losing against the rest of the league, who on the roster is carrying each category, and what a swap would cost. THE MODEL READS seasonTotals BY NAME, so every player handed to it is normalised to the basis this tab is already showing - season lines mid-season, projected lines before a game is played (basisTotalsOf, the same seasonState switch the roster tables make). Adapting the caller keeps coverage-model pure and unchanged; giving the model a value-accessor knob would have put the basis question inside the arithmetic, where every future reader has to answer it again.
    const coverage = (() => {
        // R6: hidden in every points league in every season state, not just pre-draft. A points league's scoredStatIds is every weighted stat (46 in the owner's own league, item 5) rather than the handful a category league counts standings by, and the band has no design for that shape - it has never shipped in a release, so nothing here is a regression.
        if (AppState.isPointsLeague) return null;
        const sport = AppState.loadedSport;
        const categoryIds = [...(AppState.scoredStatIds || [])];
        if (!AppState.playerDataLoaded || !categoryIds.length) return null;
        const rosters = rostersFromPayload(AppState.apiData);
        if (!rosters.size) return null;

        const components = RATE_COMPONENTS[sport] || [];
        const inverseIds = lowerIsBetterIds(INVERSE_STATS[sport], AppState.scoringWeights);
        const rateIds = AVERAGE_STATS[sport] || new Set();
        const ids = idsToSum(categoryIds, components);
        const poolById = new Map((AppState.playerData || []).map(p => [p.id, p]));
        const basisPlayer = (p) => ({ id: p.id, name: p.name, seasonTotals: basisTotalsOf(p) });
        const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
        // O28/S28c: a FINISHED season's projectedTotals is a remainder frozen at whatever day ESPN stopped updating it, not a real rest-of-season figure (seasonIsFinished's own comment measures it: 254 actual+projected against ~162 real games on a closed 2025 pool). The band refuses the projected basis entirely here rather than let a frozen number print as a confident "would add 135 the rest of the way" on a season with no rest of the way - the same refusal team-compare's own window-building already reaches naturally (no live/next matchup and no todayPeriod-to-final span survive a finished season's own numbers).
        const finished = seasonIsFinished(AppState.apiData);

        // R4/S28/O27-S30: the forward-looking half reads AppState.ahead now - REST OF SEASON AT REST (ahead null or 'rest', Q1's own ruling) costs nothing and needs no schedule, ESPN's projectedTotals (statSourceId 1) already IS the remainder; ahead:'next' rebuilds one from a per-game rate x the club's games in the NEXT matchup, the same O11 atoms team-compare's own projected branch reads (below), just pre-multiplied into a totals object here rather than kept as {rate, games} - this caller wants a total, not a rate.
        const nextWindow = (() => {
            if (finished || AppState.ahead !== 'next') return null;
            const map = matchupPeriodMap();
            const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
            if (current == null || !proSchedule.proTeams) return null;
            const periods = periodsOfMatchup(map, current + 1);
            if (!periods.length) return null;
            return { matchup: current + 1, periods, byTeamGames: gamesByProTeamForMatchup(proSchedule.proTeams, periods) };
        })();
        // THE REST OF THE WAY IS A WINDOW TOO, today through the league's last day. It never was one: the forward basis handed ESPN's rest-of-season line straight to the model, which is how a free agent came to "add 29 home runs" over three weeks off a full-season projection ESPN had stopped refreshing. Both windows now go through the same remainderLine, so flipping the Next pill changes the SPAN and never the basis.
        const restWindow = (() => {
            if (finished || nextWindow || !proSchedule.proTeams || !todayPeriod) return null;
            const final = finalScoringPeriodOf(AppState.apiData);
            if (!final || final < todayPeriod) return null;
            const periods = [];
            for (let p = todayPeriod; p <= final; p++) periods.push(p);
            return { matchup: null, periods, byTeamGames: gamesByProTeamForMatchup(proSchedule.proTeams, periods) };
        })();
        const forwardWindow = nextWindow || restWindow;
        // THE DENOMINATOR THE REMAINDER IS PRICED ON: every game each club has already played this season. remainderLine divides by the CLUB's games rather than the player's, so a starting pitcher is not priced as though he pitched every night (see its own comment - the first version of this printed a starter's whole season as three weeks).
        const clubGamesPlayed = (() => {
            if (!forwardWindow || !todayPeriod || !proSchedule.proTeams) return null;
            const periods = [];
            for (let p = 1; p < todayPeriod; p++) periods.push(p);
            return periods.length ? gamesByProTeamForMatchup(proSchedule.proTeams, periods) : null;
        })();
        // A STARTING PITCHER IS PRICED OVER HIS ROTATION TURN, not his club's schedule. Both facts come out of the pool's own probable listings: who is a starter (a probable anywhere this season - 351 of a 3,000-player pool, every reliever checked carrying none) and how far ahead ESPN has posted. The horizon is the second condition and it is not optional: the furthest probable in the live capture is scoring period 174 against a season running to 187, so a rest-of-the-way window counted in starts would find eleven days of twenty-four and price him on half a rotation.
        const startsContext = (() => {
            if (!forwardWindow || !proSchedule.index) return null;
            const periods = forwardWindow.periods || [];
            if (!periods.length) return null;
            const pool = AppState.playerData || [];
            const starterIds = new Set();
            let horizonEnd = null;
            pool.forEach(p => {
                const listed = p && p.starterStatusByProGame;
                if (!listed) return;
                Object.keys(listed).forEach(gameId => {
                    if (listed[gameId] !== 'PROBABLE') return;
                    starterIds.add(p.id);
                    const game = proSchedule.index.get(String(gameId));
                    if (game && (horizonEnd === null || game.period > horizonEnd)) horizonEnd = game.period;
                });
            });
            const window = { start: periods[0], end: periods[periods.length - 1] };
            const byPlayer = countProjectedStarts(pool, proSchedule.index, window, todayPeriod).byPlayer;
            return { starterIds, horizonEnd, byPlayer, windowEnd: window.end };
        })();
        // S54: `periods` rides on BOTH branches now (it used to be dropped outright on the rest-of-way one) - coverage-band.js's new strip/drawer caption names how many games are left in the window, and forwardWindow.periods (nextWindow's or restWindow's, whichever this branch is) is the same day list gamesByProTeamForMatchup already prices the remainder against, not a second figure computed here.
        const coverageWindow = nextWindow
            ? { kind: 'matchup', label: 'this matchup', matchup: nextWindow.matchup, periods: forwardWindow.periods, asOf: todayPeriod }
            : { kind: 'rest', label: 'the rest of the way', matchup: null, periods: forwardWindow ? forwardWindow.periods : null, asOf: todayPeriod };

        const projectedBasisPlayer = (p) => {
            if (!forwardWindow) return { id: p.id, name: p.name, seasonTotals: {} };
            const groups = playerRoleGroups(p, sport);
            // Secondary ONLY for a player who is exclusively a pitcher/goalie - the same simplification the leaderboard's own Batters/Pitchers split already makes.
            const secondaryOnly = groups.secondary && !groups.primary;
            const gamesId = (GAMES_PLAYED_IDS[sport] || {})[secondaryOnly ? 'secondary' : 'primary'];
            const gamesRemaining = matchupWindow(forwardWindow.byTeamGames, p.proTeamId, {
                matchup: forwardWindow.matchup, periods: forwardWindow.periods, fromPeriod: todayPeriod
            }).games;
            // remainderLine refuses a player with no games played, which is a real answer and not a gap - an empty bag here reads through sumPlayers as "carries none of every category", exactly as a player who has produced nothing should.
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

        // THE FREE AGENTS WORTH NAMING, not all of them. gainFrom re-sums the whole roster once per candidate per losing category, so the full pool would be tens of thousands of sums on every render of this tab. Ordered by how widely owned they are, because the shopping list exists to name someone a manager could plausibly add - nobody adds the two-thousandth best free agent, and a list that ranked them would still only ever show three. SIDELINED PLAYERS ARE NOT CANDIDATES. The owner's band named a closer on the fifteen-day list as the best add for saves, and it was not a modelling error: ESPN's rest-of-season projection does not discount an injured player at all - measured, that closer projects the same six saves over ten innings as four healthy ones, and the highest projected save-getter in the pool is on the SIXTY-day list. The remainder is untrue for them and no arithmetic here can recover it, so they are not named at all. isSidelined is matchup-difficulty.js's, not a second list written here: it already answers "can this player play" for the offence model, it covers OUT, SUSPENSION and every DL tier, and it deliberately keeps DAY_TO_DAY IN because a day-to-day player starts most days. Checked against ESPN's own `injured` boolean across all 3000 pool entries: they agree on every one, and isSidelined additionally catches the suspended, which that boolean does not. FILTERED BEFORE THE SLICE so the shortlist is 120 players a manager could actually add, rather than 120 minus however many are hurt. The rows are ALSO marked `out`, which is the rule coverage-model.js's contract states and enforces for any caller that marks instead.
        const availableRaw = (AppState.playerData || [])
            .filter(p => !p.teamId && !isSidelined(p.injuryStatus))
            .sort((a, b) => (b.rosterPct || 0) - (a.rosterPct || 0))
            .slice(0, 120);
        const mark = (row, p) => (row ? { ...row, out: isSidelined(p.injuryStatus) } : row);
        const available = availableRaw.map(p => mark(basisPlayer(p), p));
        // NO WINDOW, NO PROJECTED BASIS. Without the pro schedule there are no club games to multiply a rate by, so the band is handed null and falls back to the actuals roster it already falls back to on a finished season - a real refusal rather than an empty bag that would render as a confident zero.
        const forwardBasis = !finished && !!forwardWindow && !!clubGamesPlayed;
        const projectedAvailable = forwardBasis ? availableRaw.map(p => mark(projectedBasisPlayer(p), p)) : null;

        const rosterRaw = (rosters.get(team.id) || []).map(e => poolById.get(e.playerId)).filter(Boolean);
        if (!rosterRaw.length) return null;
        const roster = rosterRaw.map(basisPlayer);
        const projectedRoster = forwardBasis ? rosterRaw.map(projectedBasisPlayer) : null;

        return coverageBand({
            sumsByTeam, teamId: team.id, roster, available, categoryIds, components, inverseIds,
            projectedRoster, projectedAvailable, window: forwardBasis ? coverageWindow : null,
            // SEARCH FOR AN ADD IN EVERY CATEGORY THIS TAB WILL CALL LOSING. The strip and the drawer both rank by coverageLosingIds, not by the model's share-based `weak`, and the two differ - so a category could be listed as losing while no add had ever been looked for, and the renderer would report a search that never ran. The model unions this with its own holes; it is not a replacement for them.
            searchIds: coverageLosingIds
        });
    })();

    // THE "AGAINST" COMPARISON. teamCompare's own frozen contract (tests/fixtures/team-compare.md) - this block only ASSEMBLES the ctx it asks for; every refusal (a points league, no opponent, a window with no days, a projected window with no roster) is the model's own to make, not re-derived here.
    const compare = (() => {
        if (AppState.isPointsLeague) return null;
        const opponentId = AppState.myTeamCompareOpponentId;
        if (opponentId == null) return null;
        const opponent = teamById(opponentId);
        if (!opponent || !AppState.playerDataLoaded) return null;
        const sport = AppState.loadedSport;
        const categoryIds = [...(AppState.scoredStatIds || [])];
        if (!categoryIds.length) return null;

        // THE WINDOW. "This matchup" reads as played once it has really started (readsAsPlayedMatchup, the same test data.js itself uses to decide whether weeklyCats gets a row at all) - a matchup that has not begun takes the projected path rather than a zeroed played one, same as the contract's own honest-limits section rules. "Next matchup" and "Rest of season" are ALWAYS projected.
        const map = matchupPeriodMap();
        const current = Number(AppState.currentMatchup) || (map && map.currentMatchup) || null;
        const todayPeriod = Number(AppState.apiData?.scoringPeriodId) || null;
        // O27/S30: the drawer's own window is gone - it reads the shared AppState.ahead now, the same field the tab bar's Next/Rest pills and the coverage band above both read. null means "this matchup" (windowKey 'window', unchanged meaning from the old default chip).
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
        if (!win) return null;

        const ctx = {
            window: win,
            scoredIds: categoryIds,
            statLabels: statMap,
            lowerIsBetterIds: lowerIsBetterIds(INVERSE_STATS[sport], AppState.scoringWeights),
            rateIds: AVERAGE_STATS[sport] || new Set(),
            rateComponents: RATE_COMPONENTS[sport] || []
        };

        if (win.kind === 'played') {
            // Zero requests: the team totals data.js already built off the league payload, per matchup - the exact atom the contract measures this window against.
            const played = {};
            (AppState.teamStats || []).forEach(t => { played[t.id] = t.weeklyCats || {}; });
            ctx.played = played;
        } else {
            // PROJECTED: each rostered player's per-game rate times that club's games in the window, the same read the Player Metrics lens columns make for one player at a time, made here for a whole roster.
            if (!proSchedule.proTeams) return null;
            const byTeamGames = gamesByProTeamForMatchup(proSchedule.proTeams, win.periods);
            const rostersMap = rostersFromPayload(AppState.apiData);
            const poolById = new Map((AppState.playerData || []).map(p => [p.id, p]));
            const projFor = (teamId) => (rostersMap.get(teamId) || [])
                .map(e => poolById.get(e.playerId))
                .filter(Boolean)
                .map(p => {
                    const groups = playerRoleGroups(p, sport);
                    // Secondary ONLY for a player who is exclusively a pitcher/goalie - a two-way player is read off the primary role, the same simplification the leaderboard's own Batters/Pitchers split already makes rather than double-counting the row.
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

        return teamCompare({ teamId: team.id, name: team.name }, { teamId: opponent.id, name: opponent.name }, ctx);
    })();

    // THE NIGHTS BAND, one coverage per role group. HOCKEY ONLY, and not as a stylistic choice: the question is "which nights is my lineup empty", and it only has a question mark behind it in a sport whose clubs play on different nights. Baseball plays nearly every day and football once a week, so the band would draw a flat row of full nights in one and a single cell in the other. The same roster set the projected-starts block uses, and for the same reason: the bench is INCLUDED because a benched skater can be slotted in on the morning of a game, and IR is EXCLUDED because that seat cannot be filled without a roster move. A band that counted an injured player as covering a night would be describing a lineup nobody can field.
    const nights = (() => {
        if (sport !== 'fhl' || !proSchedule.proTeams || !matchupDays || !AppState.playerDataLoaded) return null;
        // Capacity per group, off the league's own slot counts - the same split the draft board's replacement level is built from, so "how many seats" means one thing in both places.
        const slots = startingSlotsByGroup(counts, {
            nonStarting: NON_STARTING_SLOTS[sport],
            secondary: SECONDARY_LINEUP_SLOTS[sport]
        });
        const labelOf = proSchedule.dates ? dayLabelerFor(proSchedule.dates) : null;
        const rows = [...groups.starters, ...groups.bench, ...groups.orphans];
        const forRole = (secondary) => rows
            .map(r => poolById.get(r.playerId))
            .filter(p => p && (secondary ? playerRoleGroups(p, sport).secondary : playerRoleGroups(p, sport).primary))
            .map(p => ({ id: p.id, proTeamId: p.proTeamId }));
        const cover = (secondary) => rosterNightCoverage(
            forRole(secondary), proSchedule.proTeams, matchupDays.periods,
            { slots: secondary ? slots.secondary : slots.primary }
        );
        return { labelOf, primary: cover(false), secondary: cover(true) };
    })();

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

    // Two-start pitchers this matchup. Read off the same roster/eligibility filter projected above uses, so a player counted toward "starts still to come" is the same player who can earn the badge.
    const twoStart = (() => {
        if (!proSchedule.index || !matchupDays) return null;
        const byId = new Map(AppState.playerData.map(p => [p.id, p]));
        const available = [...groups.starters, ...groups.bench, ...groups.orphans]
            .map(r => byId.get(r.playerId))
            .filter(p => p && p.starterStatusByProGame);
        if (!available.length) return null;
        return twoStartPitchers(available, proSchedule.index, matchupDays.periods, { fromPeriod: AppState.apiData.scoringPeriodId });
    })();

    // How hard each projected start looks. The opposing offence is measured over the WHOLE player pool rather than the league's rosters, because a pro team's lineup is mostly players nobody in a 10-team league has drafted, and grading an offence off the drafted half of it would say more about the league than about the opponent. Batting categories only, and the league's own. A difficulty read for a league that counts steals should move when the opponent steals bases, and one that does not should not. The categories the composite is built over, kept beside it so the lineup drill-in can rank the same ones in the same order rather than deriving its own list. A FIXED general-offence basket, not the league's own categories. The difficulty score answers "how hard will this real game be for my pitcher", and what hurts a pitcher is run production - not skill at whatever a fantasy league happens to count. This league scores fielding assists, errors and caught stealing among its batting categories, and the composite was weighting each of them equally with runs: a lineup's assists say nothing about facing it, and the quirkier the league the further the score drifted from the question it claims to answer. A start's difficulty now means the same thing in every league. Runs and home runs are the production; OBP and SLG are how often they get on and how far they go, rebuilt from the components validated. All four confirmed present on 400 of 400 sampled batters in a real pool, so no new data and no new call. Hockey keeps the league's own skater categories, because no general basket has been validated for it - the basket lives where the evidence does, not everywhere by analogy.
    const GENERAL_OFFENCE = { flb: ['20', '5', '17', '9'] };
    const battingIds = GENERAL_OFFENCE[sport] || splitStatIdsByRole(sport, scoredIds).primary || [];
    // The per-team totals BEFORE they collapse into a percentile. offenceStrength throws this away by design; the drill-in needs it to show what the percentile was computed against.
    let offenceRaw = null;
    // The league's own lower-is-better ids, handed to the engine so a category it scores the other way is ranked the other way. One object, built once, shared by the composite and the drill-in so the two cannot be given different rules. rateSpecs/rateStatIds turn on the rule that a lineup rate is rebuilt from summed components. The tables are the league-agnostic ones the weekly pipeline already uses, so this adds no new knowledge - it stops the offence being the one place that ignored them. lineupSize/playingTimeOf are: a club contributes the bats that will be in the game, not every bat it has rights to. The sizes are rules of the sport rather than league settings - a baseball order is nine, a hockey club dresses eighteen skaters - so they live here beside the roles rather than being read from the payload, which does not carry them.
    const LINEUP_BATS = { flb: 9, fhl: 18 };
    // No baseball fallback: a sport with no games id has no playing-time measure, and borrowing one from another sport reads every player as zero games without saying so.
    const gpId = (GAMES_PLAYED_IDS[sport] || {}).primary;
    const offenceCtx = {
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        rateStatIds: AVERAGE_STATS[sport] || new Set(),
        rateSpecs: RATE_COMPONENTS[sport] || [],
        lineupSize: LINEUP_BATS[sport] || null,
        playingTimeOf: (h) => (h.totals && h.totals[gpId]) || 0
    };
    // WHY A SCORE MOVES BETWEEN LOOKS, since the question comes up and the wrong answer is the obvious one. This reads AppState.playerData, the UNWINDOWED pool, with full-season totals - so the timeframe pill is NOT involved and nothing here follows it. What does move it: ESPN refreshes season totals daily, which drifts a lineup a little, and an injury flip moves it a lot, because one bat entering or leaving the healthy set changes every category at once and offenceStrength's second pass stretches mid-scale differences by design. The drill-in's Not counted list is where a reader can see the large mover for themselves.
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

    // Park factors are a baseball fact and nothing else. Hockey gets no table, so the engine never adds the term and the breakdown never mentions a concept the sport does not have - the same shape as every other baseball-only piece of this chain.
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
    const statCells = (playerId, ids, sortedId) => {
        const cls = (id) => 'mt-stat' + (id === sortedId ? ' mt-sorted-col' : '');
        const p = poolById.get(playerId);
        if (!p) return ids.map(id => `<td class="${cls(id)}">-</td>`).join('');
        return ids.map(id => {
            if (id === STARTS_COL) {
                const entry = projected && projected.byPlayer.get(playerId);
                if (!entry) return `<td class="${cls(id)}"><span class="mt-starts-none">-</span></td>`;
                // The count is the answer; the hint is the working behind it, one line per start so the day and the opponent are readable rather than run together. Left of total, and nothing else. 2/2 with both still to come, 1/2 once one is thrown. The days, the opponents, the difficulty and how a completed start actually went all live in the Schedule view, where they can be read rather than hidden behind a hover that has to be discovered first.
                return `<td class="${cls(id)}"><span class="mt-starts">${entry.remaining}<span class="mt-starts-of">/${entry.starts}</span></span></td>`;
            }
            if (id === GAMES_COL) {
                const w = gamesWindowFor(playerId);
                if (!w) return `<td class="${cls(id)}"><span class="mt-starts-none">-</span></td>`;
                // LEFT OF TOTAL, the same shape the Starts column uses, because it is the same question and a manager reading both should not have to change units between them. A club with no game this matchup reads 0/0 rather than a dash: it is playing none, which is an answer, where a dash means nobody knows. Reuses the Starts column's own classes deliberately - same figure, same treatment, and inventing a parallel set would be two things to restyle instead of one.
                const days = w.byPeriod.filter(d => d.count).map(d => d.period).join(', ');
                const tip = days
                    ? `${w.remaining} of ${w.games} games left this ${axisUnit().long.toLowerCase()}. Plays ${escapeHtml(days)}.`
                    : `No games this ${axisUnit().long.toLowerCase()}.`;
                return `<td class="${cls(id)}"><span class="mt-starts" data-tooltip="${escapeHtml(tip)}">${w.remaining}<span class="mt-starts-of">/${w.games}</span></span></td>`;
            }
            if (id === POINTS_COL) {
                // The same windowed points the rank was computed from, so the column and the chip beside it can never tell different stories.
                const score = ranks.get(playerId)?.score;
                return `<td class="${cls(id)}">${score === undefined ? '-' : Number(score).toFixed(1)}</td>`;
            }
            const v = basisTotalsOf(p)[id];
            if (v === undefined) return `<td class="${cls(id)}">-</td>`;
            return `<td class="${cls(id)}">${avgSet.has(id) ? Number(v).toFixed(3) : Math.round(Number(v))}</td>`;
        }).join('');
    };
    const playerRow = (row, kind, ids, sortedId = null) => {
        const p = poolById.get(row.playerId) || AppState.playerData.find(x => x.id === row.playerId);
        // A bare id reads as broken data. While the pool is on its way, say so instead.
        const name = p ? p.name : (AppState.playerDataLoaded ? `Player ${row.playerId}` : 'Loading...');
        const pos = p ? (p.positionDisplay || p.positionName || '') : '';
        return `
            <tr class="mt-row mt-row-${kind}" data-player-id="${row.playerId}">
                <td class="mt-slot">${escapeHtml(slotLabel(sport, row.slot))}</td>
                <td class="mt-player">${buildPlayerAvatarHtml(sport, row.playerId, name)}<span class="mt-name">${escapeHtml(name)}</span>${p ? injuryBadgeHtml(p.injuryStatus) : ''}</td>
                <td class="mt-pos">${escapeHtml(pos)}</td>
                <td class="mt-rankcell${sortedId === RANK_COL ? ' mt-sorted-col' : ''}">${chip(row.playerId)}</td>
                ${statCells(row.playerId, ids, sortedId)}
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

    // S13: this used to be its own flb/else table (Batters/Pitchers or Skaters/Goalies, nothing else), so a football roster's D/ST group inherited hockey's word - players.js's own GROUP_LABELS is the validated per-sport table, read through here rather than kept in a second copy that can drift from it.
    const groupLabel = { primary: roleGroupLabel(sport, false), secondary: roleGroupLabel(sport, true) };
    const irLabel = sport === 'flb' ? 'Injured list' : 'Injured reserve';

    // What the layout is computed FROM: how many player rows each group draws, and how many band separators sit among them. Counted from the roster the same way renderGroup selects it, and counted BEFORE anything renders, because the whole point is that the layout never asks the DOM what it produced. A sorted group draws no band rows at all, which renderGroup decides and this has to agree with. It is the one place the two could drift, so the rule is stated once here and once there, and both read the same groupSort.
    const rowCountsFor = (role) => {
        const pick = (rows) => rows.filter(r => sectionFor(r) === role);
        const starters = pick(groups.starters), bench = pick(groups.bench);
        const injured = pick(groups.injured), orphans = pick(groups.orphans);
        const players = starters.length + bench.length + injured.length + orphans.length;
        if (!players) return null;
        const bands = groupSort[role] ? 0 : [bench, injured, orphans].filter(b => b.length).length;
        return { players, bands };
    };
    const rowCounts = { primary: rowCountsFor('primary'), secondary: rowCountsFor('secondary') };

    // What the ROW HEIGHT is budgeted against, and it is deliberately not the team on screen. Sized to the roster in front of it, the band gave a different row height to every team - measured 14, 15 and 16px across four teams at one window - because occupancy varies even though the league's roster does not: a team carrying two players on the IL draws two more rows than one carrying none, and a team with nobody benched draws one fewer band. Switching teams then resized every word on the page, which is the jarring the owner named. The league's own roster is the honest budget. lineupSlotCounts is what every team is allowed, IL slots included, so a height computed from it fits the fullest roster the league permits and does not move when one team happens to use fewer of its slots. Teams under capacity spend the difference as space between the two tables rather than as bigger type.
    const slotCounts = AppState.apiData.settings?.rosterSettings?.lineupSlotCounts || {};
    const benchSlots = NON_STARTING_SLOTS[sport] || new Set();
    const capacity = Object.keys(slotCounts).reduce((sum, id) => sum + (slotCounts[id] > 0 ? slotCounts[id] : 0), 0);
    const rosterBudget = {
        // Never below what is actually on screen. A league whose settings did not parse would otherwise budget zero rows and hand back a row height that fits nothing.
        capacity: Math.max(capacity, (rowCounts.primary?.players || 0) + (rowCounts.secondary?.players || 0)),
        // Bands are budgeted the same way, from what the league rosters rather than what this team filled - the bench and IL headers a group CAN show, not the ones it happens to show.
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
            const inverse = sort.statId === RANK_COL || (INVERSE_STATS[sport] || new Set()).has(String(sort.statId));
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
                    ? ` data-hint="Games the club plays this ${escapeHtml(axisUnit().long.toLowerCase())}, still to come out of the total. Off the league's own matchup days and the pro schedule. Hover a figure for the days."`
                    : '';
            return `<th class="mt-stat mt-sortable${active ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${id}"${hint}
                        tabindex="0" role="button" title="Sort ${escapeHtml(colLabel(id))}">${escapeHtml(colLabel(id))}<span class="mt-arrow">${arrow}</span></th>`;
        };

        // Only the pitchers get a second face, and only when there are starts to lay out. Without that guard the tabs would appear on a hockey roster and switch to an empty calendar.
        const canSchedule = role === 'secondary' && projected;
        const tabs = canSchedule
            ? `<div class="mt-view-tabs" role="tablist">
                   <button class="mt-view-tab${pitchingView === 'categories' ? ' active' : ''}" data-view="categories" role="tab" aria-selected="${pitchingView === 'categories'}">Categories</button>
                   <button class="mt-view-tab${pitchingView === 'schedule' ? ' active' : ''}" data-view="schedule" role="tab" aria-selected="${pitchingView === 'schedule'}">Schedule</button>
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

        const face = (canSchedule && pitchingView === 'schedule') ? renderSchedule() : table;

        return `
            <div class="mt-group" data-role="${role}">
                <div class="mt-group-head">${escapeHtml(groupLabel[role])}${tabs}</div>
                ${face}
            </div>`;
    };

    // The matchup laid out by day, one column per day, each start a card under the day it falls on. Days ACROSS rather than pitchers across, because the question this view answers is "what is happening on Thursday", and a manager setting a daily lineup reads it a day at a time. It also degrades better. A roster with two starts and a roster with eleven produce the same number of columns, so the band's height does not chase the roster.
    function renderSchedule() {
        const win = currentMatchupWindow(matchupPeriodMap(), AppState.apiData.scoringPeriodId);
        if (!win) return '<div class="mt-note">No matchup is in progress, so there is nothing to lay out.</div>';
        const today = Number(AppState.apiData.scoringPeriodId) || win.start;
        // The league's own matchup number (never a calendar week, per the schedule-insight contract's own rendering note), named once here and read by every start-count badge below.
        const matchupLabel = win.matchup != null ? `Matchup ${win.matchup}` : '';

        // R9/S57: SEVEN DAYS AT THE ONE-WEEK CARD SIZE, whatever the matchup's real length - a two-week playoff round used to squeeze fourteen columns into the same band, each scrolling inside itself to stay readable, which answered "what happens on Thursday" with a second scrollbar. `pageStart`/`pageEnd` bound only the GRID's own day columns; `byDay` and everything the two-start badges/drawer read (below, and the twoStart/matchupDays consts above this function) still walk the WHOLE matchup, per the ruling's own words.
        const matchupSpan = win.end - win.start + 1;
        const paged = matchupSpan > 7;
        const maxPageStart = win.end - 6;
        const storedStart = AppState.myTeamScheduleWindowStart;
        // The stored start survives only while it still names a real page of THIS matchup - a fresh matchup (or a stale pin left over from a shorter one) falls back to the window that holds today, never a page that no longer exists.
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
                // The market's number, one glance wide, and only when there IS one. Odds cover today's slate alone, so most cards on a matchup week carry nothing here and must read as though the line was never part of the design.
                const line = s.game.played ? null : moneylineForStart(s);
                const odds = line ? `<span class="mt-cal-ml">${escapeHtml(line.price)}</span>` : '';
                // The two-start badge (schedule-insight contract, shortlist item 2). Every card belonging to a 2+ start pitcher carries it, not just the second one, since a manager looking at either day should learn the same fact. The contract requires a start count to name its matchup - matchupLabel below puts "Matchup N" on this same panel's header line, which is the context every card on this grid already sits inside.
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
        // Reading a start REPLACES the day grid rather than sharing the group with it (owner, ). The pitching group's height is reserved once and never renegotiated, so the two together left the breakdown 34px to show 230px of arithmetic - a sliver of the thing the view exists to be transparent about. Trading the grid for it while reading spends the same reserved room on whichever of the two is being looked at, and moves nothing outside the group.
        let reading = false;
        if (openStartKey) {
            const [pid, per] = openStartKey.split(':');
            const found = (byDay.get(Number(per)) || []).find(s => String(s.playerId) === pid);
            if (found) {
                breakdown = difficultyBreakdownHtml(found);
                reading = true;
            }
        }

        // The way back has to be in the breakdown itself. The card that toggles it closed is one of the ones the grid just gave up its room for. The back control lives INSIDE the panel now. Three panels each stacking a button row of their own cost three rows of height to say one word; inline with the title it costs none, and the panel that owns it is the panel that knows where back leads. R9/S57: the step chevrons - the same.chrome-arrow the Category Rankings/H2H paging and the team switcher already use, one day at a time rather than a whole week, so the window can settle exactly on the matchup's own last day instead of overshooting it. Absent outright on a one-week matchup (the ruling's own words) - `paged` is false there, and an absent control is the honest answer, not one disabled and unable to ever do anything.
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

    // The market's read, next to ours and never inside it. A moneyline already prices the park, the lineup and the rest, so folding it into the difficulty score would double-count every component the table above it just showed - it stands beside the engine as an independent second opinion, which is also the only honest way to show a number we did not compute. Credited to its provider per DATA-SOURCES rule 4, and the price ONLY. The response carries sportsbook bet-slip links and none of them are rendered. Six words now, not a sentence. "Market moneyline +104 - underdog for Chase Burns's side, via DraftKings on ESPN's scoreboard" said in twelve words what the card's own context already establishes: whose side, and that it came from the scoreboard. What is left is the number, which side of the line it is, and the credit rule 4 requires.
    const moneylineFootHtml = (s) => {
        const line = moneylineForStart(s);
        if (!line) return '';
        const sense = line.favored === null ? '' : (line.favored ? ' favoured' : ' underdog');
        const via = line.provider ? ` &middot; ${escapeHtml(line.provider)}` : '';
        return `<span class="mt-diff-credit">Line ${escapeHtml(line.price)}${escapeHtml(sense)}${via}</span>`;
    };

    // Both credits on one line, as data rather than prose. Empty when there is neither, so a hockey card or a start with no line does not carry an empty rule across its foot.
    const creditFootHtml = (s) => {
        // Never on a start that has already happened. A moneyline is a forecast, and beside a result it is a price on a question already answered - the same rule the card itself applies when it declines to print one on a completed start.
        const market = s.game.played ? '' : moneylineFootHtml(s);
        const parks = parkTable ? '<span class="mt-diff-credit">Parks &middot; Baseball Savant</span>' : '';
        if (!market && !parks) return '';
        return `<div class="mt-diff-foot">${market}${parks}</div>`;
    };

    // The one line under the verdict, naming the start rather than describing it. The VENUE replaces "at home" and "on the road", which says the same thing and one thing more. The trail IS the navigation. Every earlier crumb is a click target, the tail is where you are and is the panel's title, and there is no button anywhere. It replaces the stacked back buttons for a reason those could not solve: "Schedule" returns from ANY depth. A one-step control could only ever undo the last click, so leaving a drill-in for the calendar took two, and nothing on screen said how far in you were. crumbs: [{ label, to }] - `to` absent marks the tail, which is not clickable
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

    // A component row: label, a visual sized to the thing it measures, and the signed points. The two that have evidence behind them are BUTTONS carrying a chevron, which is the whole of the affordance - the approved mock has no per-row hint icons, because the explanation belongs in the panel the row opens rather than in a tooltip over the row.
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
            // The bar diverges from a neutral centre, so direction reads before the number does. Scaled against the widest park in the table rather than against the points, because what this bar is about is the VENUE - the points are already in the column beside it.
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
        // Short rest has no evidence to open, so it keeps one hint and stays a plain row. It is also the only component that appears CONDITIONALLY - explaining it on every start that did not earn it was most of what made the old panel long.
        return `<div class="mt-diff-row mt-diff-row-flat"
                     data-tooltip="+${SHORT_REST_ADJUSTMENT} when the previous start was under ${SHORT_REST_DAYS} days ago.">
                    <span class="mt-diff-rlabel">Short rest<span class="mt-diff-rnote">${escapeHtml(p.label)}</span></span>
                    <span class="mt-diff-track"></span>
                    <span class="mt-diff-rval">${signed}</span>
                </div>`;
    };

    // How LAD's 82 is built, category by category, against the same pool of lineups the composite ranked it in. The engine already did this arithmetic to reach the percentile; offenceBreakdown returns it rather than recomputing it, so these rows cannot disagree with the score above them. The bats this lineup's numbers leave out, named rather than merely subtracted. One hitter entering or leaving the healthy set moves the whole composite, and the second percentile pass stretches mid-scale differences by design, so a score can jump between looks for a reason the reader could not otherwise see. This list IS that reason.
    function sidelinedBatsHtml(proTeamId, detail) {
        if (proTeamId == null || !AppState.playerData) return '';
        const out = AppState.playerData
            .filter(p => p && p.proTeamId === proTeamId && isSidelined(p.injuryStatus)
                && playerRoleGroups(p, sport).primary)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        // The bats-of-rostered fact belongs HERE, beside the players it is about, rather than in the header sentence where it was a parenthetical nobody could act on.
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
        // "Percentile", the word the player drill-down's own rank table uses. "%ile" was ruled out there once already for being unreadable, so this reuses the ruling rather than inventing a third spelling of the same column. The composite lands in the TFOOT, exactly where the player drill-down puts its Rank Score and wearing the rule that already styles it. It was an eq span on the title row before, and `margin-left: auto` threw it 1018px from its own label to the far right edge of the panel - rendered, and nowhere a reader looks. A total belongs under the table that justifies it.
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
        // The two clubs Savant publishes no three-year factor for, as two more ROWS rather than a sentence under the grid. Greyed and unranked, but in the same column language, so thirty parks are on screen at once and the reader counting them finds all thirty.
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

        // A start that has happened is answered with what happened, and the forecast is kept beside it rather than quietly replaced. Being able to see that a Hard matchup went well is the whole reason for showing the read at all - as a chip now, not a sentence.
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
            // The venue comes off the FORECAST here, because a played start carries no live difficulty to read it from - and "Comerica Park" is worth more on a result than the "on the road" it would otherwise fall back to.
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

    const profileChips = (list, cls) => list.length
        ? list.map(c => `<span class="mt-cat ${cls}">${escapeHtml(c.name)}<span class="mt-cat-rank">#${c.rank}</span></span>`).join('')
        : '<span class="mt-cat-none">-</span>';

    // THE "AGAINST" CONTROLS: an opponent picker, beside the switcher - absent entirely in a points league, which has no per-category standing to offer one against (teamCompare's own refusal 1; asking the question at all would be the lie). O27/S30: the drawer's own Window chips are gone - the tab bar's shared Current/Next/Rest pills drive it now (AppState.ahead), same as the leaderboard column and the coverage band above.
    const otherTeams = AppState.isPointsLeague ? [] : (AppState.apiData.teams || []).filter(t => t.id !== team.id);
    const compareControlsHtml = otherTeams.length ? `
        <div class="mt-compare-controls">
            <select id="mt-compare-opponent">
                <option value="">Compare against...</option>
                ${otherTeams.map(t => `<option value="${t.id}"${AppState.myTeamCompareOpponentId === t.id ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
            </select>
        </div>` : '';

    container.innerHTML = `
        ${projectedBasis() ? '<div class="pd-mast"><span class="pd-tag">PRESEASON &middot; PROJECTED</span>'
            + '<span class="pd-mast-note">No games yet. Every figure below is a projection.</span></div>' : ''}
        <div class="mt-summary">
            <div class="mt-team">
                <button type="button" class="chrome-arrow mt-prev" aria-label="Previous team">&#8249;</button>
                <span class="mt-team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
                <button type="button" class="chrome-arrow mt-next" aria-label="Next team">&#8250;</button>
                ${isOwn ? '<span class="mt-own">Your team</span>' : ''}
            </div>
            ${standing ? `<div class="mt-stand">
                <span class="mt-stand-label">${escapeHtml(standing.label)}</span>
                <span class="mt-stand-value">${escapeHtml(standing.value)}</span>
                <span class="mt-stand-rank">${formatRank(standing.rank, standing.ranks)} of ${standing.of}</span>
            </div>` : ''}
            <div class="mt-profile">
                <span class="mt-profile-label">Wins</span>${profileChips(profile.best, 'mt-cat-best')}
                <span class="mt-profile-label">Bleeds</span>${profileChips(profile.worst, 'mt-cat-worst')}
            </div>
            ${compareControlsHtml}
        </div>
        ${coverage ? buildCoverageStripHtml(coverage, statMap, {
            escapeHtml,
            // The same (id, value) formatter the roster tables use, so a figure in the strip/drawer and the same figure in the table below it can never be printed two different ways.
            formatValue: (id, v) => (v === null || v === undefined ? '-' : formatStat(id, v)),
            losingIds: coverageLosingIds,
            rankOf: (id) => coverageRankById.get(String(id)) || null,
            isOpen: AppState.myTeamCoverageDrawerOpen
        }) : ''}
        ${nights ? `<div class="mt-nights">`
            + buildNightsBandHtml(nights.primary, groupLabel.primary, { escapeHtml, labelOf: nights.labelOf })
            + buildNightsBandHtml(nights.secondary, groupLabel.secondary, { escapeHtml, labelOf: nights.labelOf })
            + `</div>` : ''}
        <div class="mt-roster-wrap">
            <div class="mt-roster">
                ${poolFailed
                    ? `<div class="player-loading">${escapeHtml(playerPoolErrorText(AppState.playerDataError))}</div>`
                    : `${entries.length && !AppState.playerDataLoaded
                        ? '<div class="mt-note">Player names, ranks and season lines fill in when the player pool finishes loading.</div>'
                        : (weeklyStillArriving
                            ? '<div class="mt-note">Loading the numbers for this timeframe...</div>'
                            : (windowedMissing
                                ? `<div class="mt-note">${windowedMissing} rostered ${windowedMissing === 1 ? 'player has' : 'players have'} no games in this timeframe, so their lines and ranks are blank.</div>`
                                : ''))}
                ${entries.length ? rosterBody
                    : (awaitingFinal
                        ? '<div class="player-loading">Loading the final lineup of the season...</div>'
                        // R5: a league that has not drafted has no roster BY DESIGN (rostersFromPayload's own refusal, above) - "No roster available" reads as a gap this tab failed to fill, where the honest sentence names the reason there is nothing to show yet.
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
                    rankOf: (id) => coverageRankById.get(String(id)) || null
                })}</div>
            </div>` : ''}
            ${compare ? `<div class="mt-compare-drawer"${AppState.myTeamCompareDrawerOpen ? '' : ' hidden'}>
                <div class="mt-drawer-head">
                    <span class="mt-drawer-title">Compare</span>
                </div>
                <div class="mt-drawer-body">${buildTeamCompareHtml(compare, {
                    escapeHtml,
                    rateComponents: RATE_COMPONENTS[sport] || [],
                    statLabels: statMap
                })}</div>
            </div>` : ''}
        </div>`;

    attachDataTooltips(container);
    wirePlayerAvatars(container);
    wireTeamSwitcher(container);
    wireCoverageDrawer(container);
    fitCoverageStripChips(container);
    wireScheduleCalendar(container);

    // THE "AGAINST" CONTROLS. Choosing an opponent IS the open action - there is no separate "Open" button, since picking one is already one click, and both drawers share the roster's own right-hand slot, so opening this one closes the coverage drawer if it was showing (same rule in reverse, wireCoverageDrawer below).
    const opponentSelect = container.querySelector('#mt-compare-opponent');
    if (opponentSelect) {
        opponentSelect.addEventListener('change', (e) => {
            const v = e.target.value;
            AppState.myTeamCompareOpponentId = v === '' ? null : Number(v);
            AppState.myTeamCompareDrawerOpen = v !== '';
            // The two drawers share the roster's one right-hand slot (same rule in reverse, wireCoverageDrawer above) - opening this one closes coverage rather than stacking.
            if (AppState.myTeamCompareDrawerOpen) AppState.myTeamCoverageDrawerOpen = false;
            renderMyTeamTab();
        });
    }
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
            const next = btn.dataset.view;
            if (next === pitchingView) return;
            pitchingView = next;
            openStartKey = null;
            openStartDrill = null;
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
    // A component row opens its own evidence in the same reserved space. Clicking the row already open closes it, matching how a start card toggles.
    container.querySelectorAll('.mt-diff-row[data-drill]').forEach(btn => {
        btn.addEventListener('click', () => {
            openStartDrill = (openStartDrill === btn.dataset.drill) ? null : btn.dataset.drill;
            renderMyTeamTab();
        });
    });
    // Every crumb is a destination, not a step back. "Schedule" closes the whole stack from any depth, which is the thing the one-step buttons could never do.
    container.querySelectorAll('.mt-crumb[data-crumb]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.crumb === 'calendar') { openStartKey = null; openStartDrill = null; }
            else openStartDrill = null;
            renderMyTeamTab();
        });
    });
    // The league belongs in this key. Without it, the same team id, timeframe, viewport and roster size in a DIFFERENT league collide, and the density decided for a league with more categories gets reused for one with fewer, which leaves the roster reading smaller than it did when that league was first opened. The timeframe is out of this key. Density answers "do these rows fit", and a window changes neither how many rows there are nor how tall they are, so re-deciding on a pill click could only ever make the table jump. What IS in it is whether the content is finished arriving. A roster rendered before its pool lands is a different thing to measure. It carries the "names fill in when the pool finishes loading" note, and it has no Starts column yet. Fitting that and then holding it, which is what the cached path now does, froze a league at whatever size its LOADING state needed and never corrected it once the real content arrived. That is what switching leagues and back does, since the pool is reset and refetched every time. Including the signature means the fit is made twice at most: once for the loading state, once for the real one, and never again. The second is the size that lasts, and it lands at the moment the roster visibly fills in, which is when the user expects it to move. TWO states, which is what that promise always said. The signature used to carry four - pool, weekly and starts each flipping separately - and every transition re-measured in front of the user. Completeness reads the pro schedule's FETCH STATE, not whether it produced any starts: a rotation with none would otherwise never count as complete and the tab would re-measure for the rest of the session. Weekly rows are only waited on when this tab actually READS them, which is the same condition that requests them above: a windowed timeframe. weeklyDataPending is the global bulk-fetch flag, raised by the leaderboard's own warm-up whatever My Team is showing, so gating on it unconditionally made the common Full Season entry wait on a fetch whose rows it never touches - at full season the lines come from the unwindowed pool.
    const needsWeekly = parseTimeframe(AppState.timeframe).window !== null;
    const contentComplete = AppState.playerDataLoaded
        && (!needsWeekly || !weeklyDataPending())
        && proSchedule.state === 'done';
    // The vertical layout is COMPUTED from these counts, not measured off the rendered tables. Both are known the moment the roster payload is in hand, which is why the loading state and the loaded state come out the same size.
    layoutRosterBand(container, rowCounts, rosterBudget, !!projected);
    sizeRosterColumns(container);
    container.querySelectorAll('.mt-row').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = Number(tr.dataset.playerId);
            if (!AppState.playerData.some(p => p.id === id)) return;
            // Hand the drill-down the role this row was read under, BEFORE the tab renders. Every pool the drill-down builds - rank chips, the breakdown's peer group, its categories, its workload measure - is scoped by AppState.playerGroup, and arriving from a roster row that state belongs to whichever tab the Player Metrics view happened to be left on. Clicking a closer while it sat on Batters ranked that pitcher against 454 batters over BATTING categories, where every value is 0 and the batting games played are 0 too: seven real percentiles off an empty line, a 0% Playing-Time Factor, and a "Rank Score" of exactly 50 - which is the whole of the owner's report. The group is taken from the GROUP the row sits in rather than the player's primary role, so a two-way player opened from the pitching table is read as a pitcher.
            const rowRole = tr.closest('.mt-group')?.dataset.role;
            if (rowRole === 'primary' || rowRole === 'secondary') AppState.playerGroup = rowRole;
            document.getElementById('tab-btn-player')?.click();
            openPlayerDetail(id);
        });
    });
}

// The Player and Pos columns take their width from the roster actually on screen, measured after it renders rather than assumed. A fixed-layout table has to size a column for its worst case, and with a league-wide width that worst case is the longest name in the whole pool: 118px against a 55px median on a real 1302-player pool, which is where the dead space between a name and the Pos column came from. The roster in front of the user is a much smaller sample and usually a much narrower one. Measured, never estimated from character counts, because the answer depends on the font the density ladder has currently applied. One value for BOTH group tables, since the two staying aligned is the entire reason the layout is fixed.
function sizeRosterColumns(container) {
    const names = [...container.querySelectorAll('.mt-name')];
    if (!names.length) return;
    // A hidden tab measures zero for everything, and writing that answer would leave the roster sized for a container it was never shown in. processCoreData renders this tab on every league fetch whether or not it is on screen, so this guard is load-bearing, the same reason layoutRosterBand declines to compute against a band of zero height.
    if (!container.clientWidth) return;
    const sample = container.querySelector('td.mt-pos');
    if (!sample) return;

    // A PROBE, not the cells themselves. Measuring a cell's own box asks the column how wide the column is, which is circular. The first attempt at this sized Pos from its rendered width and collapsed it to 32px, clipping "1B/OF/DH". The probe carries the cell's real computed font, so the answer also follows whatever step the density ladder has applied.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
    probe.style.font = getComputedStyle(sample).font;
    container.appendChild(probe);
    const textW = (t) => { probe.textContent = t || ''; return probe.getBoundingClientRect().width; };
    const widestText = (nodes) => Math.max(0, ...nodes.map(n => textW(n.textContent.trim())));

    const nameW = widestText(names);
    const posW = widestText([...container.querySelectorAll('td.mt-pos')]);
    // The headings are a floor, since a column narrower than its own label reads as broken rather than tight. Measured in the HEADER's font, which is smaller and uppercase.
    const head = container.querySelector('th.mt-pos');
    if (head) probe.style.font = getComputedStyle(head).font;
    probe.style.textTransform = 'uppercase';
    probe.style.letterSpacing = getComputedStyle(head || sample).letterSpacing;
    const playerHeadW = textW('Player');
    const posHeadW = textW('Pos');
    // Category columns share ONE pitch across both tables, so the Nth category of one group stays above the Nth of the other. The pitch is the widest thing any of them has to hold, which is usually a heading rather than a number. "Starts" and "OPS" are wider than the figures under them. Headings are measured in the header's font, still set on the probe here.
    const statHeadW = Math.max(0, ...[...container.querySelectorAll('th.mt-stat')]
        .map(th => textW(th.textContent.replace(/[▼▲]/g, '').trim())));
    probe.style.font = getComputedStyle(sample).font;
    probe.style.textTransform = 'none';
    probe.style.letterSpacing = 'normal';
    const statValueW = Math.max(0, ...[...container.querySelectorAll('td.mt-stat')]
        .map(td => textW(td.textContent.trim())));
    probe.remove();

    // The avatar and the gap after it share the name's cell, so they are part of what that column has to hold. Read off the real element so a density step counts.
    const avatar = container.querySelector('.player-avatar');
    const avatarW = avatar ? avatar.getBoundingClientRect().width + 6 : 0;
    // Cell padding, plus a couple of pixels so the longest entry is not flush against the next column. Sorting can add an arrow to a header, which the floor already covers.
    const chrome = 14;
    const playerW = Math.ceil(Math.max(nameW + avatarW, playerHeadW) + chrome);
    const posW2 = Math.ceil(Math.max(posW, posHeadW) + chrome);

    // The shared columns are applied and settled BEFORE the category pitch is measured, because the pitch divides what is left after them. Measuring while those columns still carried their stylesheet fallbacks made the first pass compute a narrower pitch than the second, which is a visible step the moment a timeframe is clicked. Reading clientWidth below forces the layout. The CATEGORY COUNT belongs in the key, because the pitch is the room divided by it. Without it a width measured while N columns were on screen was grow-only inherited by a render carrying more of them, and N wider columns than the table has room for is a horizontal scrollbar - the one a league switch left behind, since the league being switched to is exactly what changes this number.
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

    // Categories fill the room the table has, AND stay aligned between the two groups. Both hold at once only if both groups share ONE pitch, so the pitch is sized for the group carrying the MOST categories. That table fills its row exactly, and the shorter group uses the same pitch and lets its filler absorb the columns it does not have. The Nth category of one still sits directly above the Nth of the other, which is what the fixed layout is there to protect. Measured after the shared columns have taken their width, never computed from the CSS values, because padding and the density step both move the real numbers.
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
    // root constants. The CAP is what this gains - the remainder split alone had nothing to stop
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
    // Grow-only within a key. A window whose numbers are wider than the one first measured still gets the room it needs, and a narrower one never shrinks the table back. The key omits the TIMEFRAME on purpose, since a window only changes the values inside columns whose job is already decided, and re-measuring on every pill click resized the table.
    lastColumnFit.stat = Math.max(lastColumnFit.stat, Math.floor(pitch - pad));
    container.style.setProperty('--mt-stat-w', lastColumnFit.stat + 'px');
}

// The vertical layout, as arithmetic. No measurement of what rendered, no rAF, no caches, no memory of earlier layouts. Same league, same window, same roster gives the same answer on every path, because the answer is a function of numbers that are all known before a row exists. WHY THE MEASURED VERSION KEPT FAILING, after five rounds of fixing which measurement wins: every one of them was measure-and-remember. Density ladders, reserved shares, provisional fits, generation guards. Each round settled a different race and the layout still depended on WHAT WAS ON SCREEN WHEN A MEASUREMENT RAN, which is why the same roster at the same viewport rendered one size on load and another after cycling through teams. Deleting the machinery is the fix; there is no measurement left to race. The one thing read from the DOM is the band's own height, which is not a measurement of content but the room the viewport and the summary above it leave. It cannot depend on history. rowHeight = clamp((room - budgetedChrome) / rosterCapacity, ROW_MIN, ROW_MAX) THE DIVISOR IS THE LEAGUE'S ROSTER, NOT THIS TEAM'S. Dividing by the rows in front of it made the row height a property of the team on screen: occupancy varies even where the league's roster does not, since a team carrying two players on the IL draws two more rows than one carrying none, and a team with nobody benched draws one band fewer. Measured 14, 15 and 16px across four teams at one window, so switching teams resized every word on the page. Budgeting the fullest roster the league allows makes the answer the same for all of them, and a team under capacity spends the difference as space between the tables rather than as bigger type. It also retires the two-case Schedule solve that used to live here. That existed to re-divide the leftover among THIS team's batting rows, which is precisely the team-dependence being removed; with a budgeted divisor the leftover is slack, and slack has somewhere to go. Rows still shrink toward ROW_MIN before anything scrolls, and still stop at ROW_MAX so a shallow league on a tall window reads as a roster rather than a menu.
function layoutRosterBand(container, counts, budget, hasSchedule) {
    const band = container.querySelector('.mt-roster');
    if (!band) return;
    // MOBILE DOES NOT RUN THIS ARITHMETIC AT ALL. Below 700px the tab inverts to one vertically-scrolling column (dashboard.css's own mobile block), so there is no fixed band height to divide among rows - the CSS gives every group its natural, full height instead. A real reason to skip, not the room===0 guard below: that guard cannot tell "not rendered yet" from "genuinely narrow", and on a phone viewport `room` is a real, small, non-zero number that the arithmetic would have divided anyway, computing a cramped fixed height for a layout CSS was about to override - the two fights being exactly what a Firefox-for-Android user actually saw ("BATTERS" over nothing,.mt-roster's own overflow:hidden clipping the rest).
    if (window.matchMedia('(max-width: 700px)').matches) return;
    // A hidden tab measures zero for its own box too, and writing a layout computed against zero would be worse than writing none. Every path that shows this tab re-renders it, so the next render computes the real answer. Nothing is cached, so nothing stale can survive the wait.
    const room = band.clientHeight;
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
    const schedMin = px('--mt-sched-min');
    const schedWant = Math.max(px('--mt-sched-want'), schedMin);
    const batMin = px('--mt-bat-min');

    const present = [counts.primary, counts.secondary].filter(Boolean);
    if (!present.length) return;
    const chromeOf = (c) => headH + theadH + c.bands * bandH;
    const gaps = gap * (present.length - 1);
    if (!budget || !budget.capacity) return;

    // The BUDGETED chrome, on the same principle as the divisor: every group present is charged for the bands the league could give it, not the ones this team happens to fill. Charging the real ones put a team's empty bench into the row height of every other team's rows.
    const budgetChrome = present.length * (headH + theadH + budget.bands * bandH) + gaps;

    // WHOLE PIXELS, and that is not fussiness. A fractional row height lays out fine and then each of a dozen boxes rounds its own way, so a group's content came out 2px over the height the arithmetic had given it and both groups wore a 2px scrollbar. Integers make the sum on screen the sum that was computed.
    const clamp = (v) => Math.max(rowMin, Math.min(rowMax, Math.floor(v)));
    const bat = counts.primary;
    const pitch = counts.secondary;
    const chromePitch = pitch ? chromeOf(pitch) : 0;

    // One expression, no cases, and nothing in it belongs to the team on screen.
    const rowH = clamp((room - budgetChrome) / budget.capacity);

    // Taking the larger of the two is what puts any overflow on the BATTING group, which is the standing rule - below --mt-row-min it scrolls and nothing else does. They differ only at that floor, since a row is never allowed under it however little room is left. --mt-bat-min is the owner's ONE cap on the split: pitching may take every pixel batting does not need, but never so many that batting drops below it, about six rows, the point where a roster stops reading as a roster. It is the only case where the pitching group scrolls - on a phone-height band the 230px Schedule floor was otherwise taking everything and leaving batting 57px, which is not a tight fit but that rule broken.
    const pitchCap = bat ? Math.max(0, room - gaps - batMin) : room;
    let share = pitch ? chromePitch + pitch.players * rowH : 0;
    if (hasSchedule && pitch) share = Math.max(share, schedMin);
    share = Math.min(share, pitchCap);

    // What the budget did not spend: the floor division's remainder, the slots a team below capacity is not using, and at a tall window whatever ROW_MAX refuses to grow into.
    const batContent = bat ? chromeOf(bat) + bat.players * rowH : 0;
    let free = Math.max(0, room - batContent - share - gaps);

    // THE SCHEDULE FACE IS FED BEFORE THE GAP IS. Sitting at its floor, the lineup drill-in overflowed its box by 29px while 28px of the same band went into holding the two tables apart - the owner's point exactly, that the space between the groups should go to the panel that needs it. It grows toward --mt-sched-want out of genuinely free space only, so this never costs a batting row, and it stops there rather than swallowing a tall window and leaving the Categories face acres of nothing under its last pitcher.
    if (hasSchedule && pitch && free > 0 && share < schedWant) {
        const extra = Math.min(free, schedWant - share, Math.max(0, pitchCap - share));
        share += extra;
        free -= extra;
    }

    // Whatever is still spare becomes SPACING between the two tables, up to --mt-group-gap-max, and the cap is the point. Given the lot, the gap became the new jarring thing - 144px between the tables on one team and 84px on the next, because slack varies with exactly the roster differences the budget exists to hide. Capped, both tables land in the same place for every team and the difference shows only as empty band under the last one.
    const slack = Math.min(free, Math.max(0, gapMax - gap));

    // Written on the BAND, not the container..mt-roster declares the defaults for these, and a declaration on the element itself beats one inherited from its parent - set on the container the computed value was silently losing to the stylesheet's own fallback.
    band.style.setProperty('--mt-row-h', rowH + 'px');
    band.style.setProperty('--mt-group-gap', (gap + slack) + 'px');

    // Both faces are handed the same share, so flipping between them has nothing to re-deal.
    if (pitch) band.style.setProperty('--mt-pitch-h', share + 'px');
    else band.style.removeProperty('--mt-pitch-h');
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

// R9/S57: the Schedule calendar's own seven-day step, one day at a time - each button carries the page it was rendered against (data-cal-page-start), so the click reads where it actually is rather than recomputing the whole window a second time in here. renderSchedule's own clamp (win. start..win.end-6) is what actually keeps a repeated click from stepping the window past either end - a disabled button already stops the click at the two true edges, this is the same guard for a change of matchup between one render and the next.
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

// Q13/S54 (the owner's own correction): "the strip's chips sit on one line and '+N more' replaces whatever does not fit at the strip's width - measure, hide the overflow, count it." coverage-band.js has no DOM, so it renders EVERY chip plus one `.cvs-more` element (present, `hidden`) and leaves the real measurement to this function - re-run after every render, the same "re-wired on every render" idiom wireCoverageDrawer already follows below. The drawer's own chip rows are never touched here - the ruling's own words are "the drawer shows all".
function fitCoverageStripChips(container) {
    const row = container.querySelector('.cvs-chips');
    if (!row) return;
    const more = row.querySelector('.cvs-more');
    const chips = Array.from(row.querySelectorAll('.cvs-chip'));
    if (!more || !chips.length) return;

    // MOBILE (golden rule 2's own breakpoint) wraps the whole chip row instead of truncating it (dashboard.css's own @media block) - every chip shows there, so this function's one-line math would only hide chips a wrapped row has real room for. Read off the row's own computed flex-wrap rather than a window-width literal, so this stays correct however the breakpoint itself is ever expressed.
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
    if (totalWidth <= available) return; // every chip already fits - the indicator stays hidden

    more.hidden = false;
    const moreWidth = more.offsetWidth;
    let used = 0;
    let shown = 0;
    for (; shown < chips.length; shown++) {
        const next = used + widths[shown] + (shown > 0 ? gapPx : 0);
        // The LAST chip needs no room reserved for the indicator beside it - only a chip with real overflow behind it does. Every earlier chip has to leave room for "+N more" in case this is where the row actually runs out.
        const reserve = (shown === chips.length - 1) ? 0 : moreWidth + gapPx;
        if (next + reserve > available) break;
        used = next;
    }
    for (let i = shown; i < chips.length; i++) chips[i].hidden = true;
    const hiddenCount = chips.length - shown;
    if (hiddenCount > 0) more.textContent = `+${hiddenCount} more`;
    else more.hidden = true;
}

// THE COVERAGE DRAWER. The open/close buttons are re-wired on every render, the same as every other control here - the drawer element itself is rebuilt each time, so there is nothing stale on THOSE to unwire. Escape is different: it has to reach a drawer no matter where focus sits, so it is bound on the DOCUMENT rather than the container - and bound ONCE EVER (the module-level flag setupHintTooltips/attachDataTooltips already use for the identical reason), querying the live DOM fresh on every keystroke rather than closing over one render's element, so a stacked listener per render was never a risk to begin with. R5/S29: the strip's OWN control is the toggle now - "Open" closed, "Close" open - and the drawer's own X is gone from both drawers. That label lives in the rendered HTML (buildCoverageStripHtml's own opts.isOpen), not just a DOM attribute, so both the click and Escape re-render the tab rather than only flipping `hidden` - the same reason the compare drawer's own open state already had to live in AppState instead of on the element alone.
let coverageDrawerEscapeWired = false;
function wireCoverageDrawer(container) {
    // S54: TWO buttons now carry this class - the strip's own Open/Close toggle AND the drawer's own header Close (buildCoverageDrawerHeadHtml, coverage-band.js), added so the open drawer's caption row reads "the same caption with Close" per the ruling. Both flip the identical state the same way, so every match is wired rather than only the first querySelector would have found.
    container.querySelectorAll('.mt-strip-open').forEach(openBtn => {
        openBtn.addEventListener('click', () => {
            AppState.myTeamCoverageDrawerOpen = !AppState.myTeamCoverageDrawerOpen;
            // The two drawers share the roster's one right-hand slot - opening this one closes the other rather than stacking on top of it.
            if (AppState.myTeamCoverageDrawerOpen) AppState.myTeamCompareDrawerOpen = false;
            renderMyTeamTab();
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
