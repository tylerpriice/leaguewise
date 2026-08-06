// My Team: the third pillar. Team Metrics answers how the LEAGUE is doing, Player Metrics answers who is good, this answers how MY team is doing and why. It is a roster VIEWER that defaults to the user's own team and can scout any other, which is what makes the later lineup features (optimal lineup, keep/drop, the time machine) work for whichever team is on screen. Nothing here forks the engines: ranks come from the leaderboard's own pool ranking, the category profile from the heatmap's aggregation.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, INVERSE_STATS, RATE_COMPONENTS, NON_STARTING_SLOTS, LINEUP_SLOT_ORDER, SLOT_POSITION_MAPS, POSITION_MAPS } from './state.js';
import { escapeHtml, getTimeframeBounds, axisUnit, attachDataTooltips, splitStatIdsByRole, injuryBadgeHtml, playerPoolErrorText, parseTimeframe } from './utils.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { rosterRankLookup, openPlayerDetail, playerRoleGroups, effectivePlayerPool, loadPlayerTabIfNeeded, matchupPeriodMap, ensureWeeklyDataForTimeframe, weeklyDataPending } from './players.js';
import { fetchRosterForPeriod, fetchProTeamSchedules, fetchScoreboardOdds } from './api.js';
import { buildGamePeriodIndex, buildProTeamAbbrevs, currentMatchupWindow, countProjectedStarts, buildOddsIndex, moneylineFor } from './probables.js';
import {
    teamOffence, offenceStrength, offenceBreakdown, startDifficulty, difficultyLabel, daysBetween, isSidelined,
    SHORT_REST_ADJUSTMENT, SHORT_REST_DAYS, MLB_PARK_FACTORS
} from './matchup-difficulty.js';
import { GAMES_PLAYED_IDS } from './rank-engine.js';
import { teamCategoryProfile } from './graphs.js';

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
// Real line breaks in a data-hint, which the hint tooltip renders via white-space: pre-line.
const NEWLINE = String.fromCharCode(10);
// Half-width of the park bars' scale, in run-index points. Coors is +25 and T-Mobile -17, so 25 puts the widest park at the end of its half and everything else in proportion to it. Derived from the shipped table rather than typed, so a refresh that moves the extreme moves the scale.
const PARK_INDEX_SPAN = Math.max(...Object.values(MLB_PARK_FACTORS).map(p => Math.abs(p[0] - 100)));
// A finished season's last lineup, fetched once per league. The payload carries current rosters only while a matchup is live, so this is what makes the tab work after a season ends. ESPN still serves the final scoring period's rosters, which IS the team as it stood for the last matchup.
let finalRosters = { key: null, byTeam: null, state: 'idle' };
// The pro schedule behind projected starts, fetched once per league and re-rendered into when it lands. Same fire-and-forget shape as finalRosters above, and a failure just means the line does not render.
let proSchedule = { key: null, index: null, abbrevs: null, state: 'idle' };
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

export function resetMyTeamView() {
    viewedTeamKey = null;
    viewedTeamId = null;
    viewedTeamIsStandIn = false;
    groupSort = { primary: null, secondary: null };
    pitchingView = 'categories';
    openStartKey = null;
    openStartDrill = null;
    finalRosters = { key: null, byTeam: null, state: 'idle' };
    proSchedule = { key: null, index: null, abbrevs: null, state: 'idle' };
    scoreboardOdds = { key: null, index: null, state: 'idle' };
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    // The widths live on the CONTAINER as inline custom properties, and the container outlives every render - innerHTML replaces what is inside it, never its own style attribute. Clearing the module's memory while leaving those behind is not a reload, which is what a league switch was getting: sizeRosterColumns returns early when it has no names, no width or no sample, and any of those on the first render after a switch left the previous league's column widths standing on screen. A fresh load starts with nothing set, so a switch has to as well (owner).
    const container = document.getElementById('myteam-container');
    if (container) {
        ['--mt-player-w', '--mt-pos-w', '--mt-stat-w'].forEach(n => container.style.removeProperty(n));
    }
}

// Fire-and-forget, guarded by league key and state so a tab switch or timeframe click never starts a second one. The index is built once here rather than per render, since it is 2456 games.
function ensureProSchedule(key) {
    if (proSchedule.key === key && proSchedule.state !== 'idle') return;
    proSchedule = { key, index: null, abbrevs: null, state: 'loading' };
    fetchProTeamSchedules().then(data => {
        if (proSchedule.key !== key) return;
        proSchedule = {
            key,
            index: data ? buildGamePeriodIndex(data) : null,
            abbrevs: data ? buildProTeamAbbrevs(data) : null,
            state: 'done'
        };
        renderMyTeamTab();
    }).catch(() => {
        if (proSchedule.key === key) { proSchedule = { key, index: null, abbrevs: null, state: 'done' }; }
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

// SWID comparison tolerant of the brace-wrapped and case forms ESPN uses in different places, the same rule recap.js matches on.
function sameSwid(a, b) {
    const norm = (s) => String(s || '').replace(/[{}]/g, '').toUpperCase();
    return !!a && !!b && norm(a) === norm(b);
}

// VALIDATED against real captures. teams[].owners is an ARRAY of SWID strings in the brace-wrapped uppercase form the cookie also carries, and teams[].primaryOwner repeats the first of them. members[].id uses the same form. Matching the cookie against owners identifies the user's team; a league the user only spectates matches nothing, which is the switcher-only case the tab is built to handle.
export function findOwnedTeamId(teams, swid) {
    if (!swid) return null;
    const owned = (teams || []).find(t =>
        (t.owners || []).some(o => sameSwid(o, swid)) || sameSwid(t.primaryOwner, swid));
    return owned ? owned.id : null;
}

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

// PURE. The current roster off the league payload itself, which carries it on each side of an in-progress matchup (VALIDATED: a live 2026 MLB capture covers all four teams at scoringPeriodId 104, while three completed-season captures carry none). Returns a Map of teamId to entries; an empty map means the season is over or the week has no games, and the caller falls back to one mRoster call.
export function rostersFromPayload(apiData) {
    const out = new Map();
    ((apiData || {}).schedule || []).forEach(game => {
        ['home', 'away'].forEach(side => {
            const s = game[side];
            const entries = ((s || {}).rosterForCurrentScoringPeriod || {}).entries;
            if (!s || !entries || !entries.length) return;
            // The LAST matchup period wins for a team that appears more than once, which is the current one. ESPN only attaches this to the period it is serving.
            out.set(s.teamId, entries.map(e => ({ playerId: e.playerId, lineupSlotId: e.lineupSlotId })));
        });
    });
    return out;
}

function slotLabel(sport, slot) {
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const benchIds = [...bench].sort((a, b) => a - b);
    if (slot === benchIds[0]) return 'BE';
    if (benchIds.slice(1).includes(slot)) return sport === 'flb' ? 'IL' : 'IR';
    const map = SLOT_POSITION_MAPS[sport] || {};
    if (map[slot]) return map[slot];
    // SLOT_POSITION_MAPS deliberately omits the roster-status slots, because they are not real defensive positions and have no business in a player's eligibility list. A lineup VIEW is the one place they must read, so they are named here rather than by loosening that map.
    const statusNames = { flb: { 6: 'MI', 7: 'CI', 12: 'UTIL', 19: 'IF' }, fhl: { 3: 'F', 4: 'D', 5: 'G', 6: 'UTIL' } };
    return (statusNames[sport] || {})[slot] || String(slot);
}

function teamById(id) {
    return AppState.teamStats.find(t => t.id === id) || null;
}

// The team's record or roto total, and where that places it. Same ordering the standings bars use, so the number here and the bar there can never disagree.
function teamStandingLine(team) {
    if (AppState.isRotoLeague) {
        const ranked = [...AppState.teamStats].sort((a, b) => b.rotoPoints - a.rotoPoints);
        const rank = ranked.findIndex(t => t.id === team.id) + 1;
        return { value: `${team.rotoPoints} pts`, rank, of: ranked.length, label: 'Roto Points' };
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
            const result = AppState.isPointsLeague ? (t.weeklyMatchResult[wk] || 0) : mw;
            if (result === 1) w++; else if (result === 0.5) ties++; else l++;
        }
        return { w, l, ties, pts, wins: w + ties * 0.5 };
    };
    const rows = AppState.teamStats.map(t => ({ id: t.id, ...summarize(t) }))
        .sort((a, b) => (b.wins - a.wins) || (b.pts - a.pts));
    const mine = rows.find(r => r.id === team.id) || { w: 0, l: 0, ties: 0, pts: 0 };
    const rank = rows.findIndex(r => r.id === team.id) + 1;
    const value = AppState.isPointsLeague
        ? `${mine.w}-${mine.l}-${mine.ties} - ${mine.pts.toFixed(1)} pts`
        : `${mine.w}-${mine.l}-${mine.ties}`;
    return { value, rank, of: rows.length, label: AppState.isPointsLeague ? 'Record and points' : 'Record' };
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

    const sport = AppState.loadedSport;
    const key = `${sport}:${AppState.apiData.id}:${AppState.apiData.seasonId}`;
    if (viewedTeamKey !== key) {
        viewedTeamKey = key;
        viewedTeamId = findOwnedTeamId(AppState.apiData.teams, AppState.userSwid);
    }
    if (viewedTeamId == null || !teamById(viewedTeamId)) {
        // Whoever is first, because there is no SWID to match yet or it matched nothing. Marked as a stand-in so a SWID arriving later can correct it - a user who logs in mid-session otherwise sits on a stranger's roster on the tab called My Team, and never learns it is not theirs ( follow-up).
        viewedTeamId = AppState.teamStats.length ? AppState.teamStats[0].id : null;
        viewedTeamIsStandIn = true;
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
    const colLabel = (id) => (id === POINTS_COL ? 'PTS' : id === STARTS_COL ? 'Starts' : statMap[id]);

    const standing = teamStandingLine(team);
    const profile = teamCategoryProfile(team.id);
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
    // A rostered player absent from the windowed pool has no weekly row cached, which means one of two very different things: his rows have not arrived yet, or they have and he did not play in this window. Saying "no games in this timeframe" while the fetch is still running asserts the second when the truth is the first.
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
    // Projected starts for the matchup being played, counted once and read by the pitcher column below. IR is excluded because those players cannot be started without a roster move, while the bench is INCLUDED. In a daily-lineup league a benched starter is routinely slotted in on the morning he pitches, so his turns are starts this roster can actually take.
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

    // How hard each projected start looks. The opposing offence is measured over the WHOLE player pool rather than the league's rosters, because a pro team's lineup is mostly players nobody in a 10-team league has drafted, and grading an offence off the drafted half of it would say more about the league than about the opponent. Batting categories only, and the league's own. A difficulty read for a league that counts steals should move when the opponent steals bases, and one that does not should not. The categories the composite is built over, kept beside it so the lineup drill-in can rank the same ones in the same order rather than deriving its own list. A FIXED general-offence basket, not the league's own categories (, owner ruled). The difficulty score answers "how hard will this real game be for my pitcher", and what hurts a pitcher is run production - not skill at whatever a fantasy league happens to count. This league scores fielding assists, errors and caught stealing among its batting categories, and the composite was weighting each of them equally with runs: a lineup's assists say nothing about facing it, and the quirkier the league the further the score drifted from the question it claims to answer. A start's difficulty now means the same thing in every league. Runs and home runs are the production; OBP and SLG are how often they get on and how far they go, rebuilt from the components validated. All four confirmed present on 400 of 400 sampled batters in a real pool, so no new data and no new call. Hockey keeps the league's own skater categories, because no general basket has been validated for it - the basket lives where the evidence does, not everywhere by analogy.
    const GENERAL_OFFENCE = { flb: ['20', '5', '17', '9'] };
    const battingIds = GENERAL_OFFENCE[sport] || splitStatIdsByRole(sport, scoredIds).primary || [];
    // The per-team totals BEFORE they collapse into a percentile. offenceStrength throws this away by design; the drill-in needs it to show what the percentile was computed against.
    let offenceRaw = null;
    // The league's own lower-is-better ids, handed to the engine so a category it scores the other way is ranked the other way. One object, built once, shared by the composite and the drill-in so the two cannot be given different rules. rateSpecs/rateStatIds turn on B145's rule that a lineup rate is rebuilt from summed components. The tables are the league-agnostic ones the weekly pipeline already uses, so this adds no new knowledge - it stops the offence being the one place that ignored them. lineupSize/playingTimeOf are: a club contributes the bats that will be in the game, not every bat it has rights to. The sizes are rules of the sport rather than league settings - a baseball order is nine, a hockey club dresses eighteen skaters - so they live here beside the roles rather than being read from the payload, which does not carry them.
    const LINEUP_BATS = { flb: 9, fhl: 18 };
    const gpId = (GAMES_PLAYED_IDS[sport] || GAMES_PLAYED_IDS.flb).primary;
    const offenceCtx = {
        inverseStatIds: INVERSE_STATS[sport] || new Set(),
        rateStatIds: AVERAGE_STATS[sport] || new Set(),
        rateSpecs: RATE_COMPONENTS[sport] || [],
        lineupSize: LINEUP_BATS[sport] || null,
        playingTimeOf: (h) => (h.totals && h.totals[gpId]) || 0
    };
    // WHY A SCORE MOVES BETWEEN LOOKS, since the question comes up and the wrong answer is the obvious one (, verified ). This reads AppState.playerData, the UNWINDOWED pool, with full-season totals - so the timeframe pill is NOT involved and nothing here follows it. What does move it: ESPN refreshes season totals daily, which drifts a lineup a little, and an injury flip moves it a lot, because one bat entering or leaving the healthy set changes every category at once and offenceStrength's second pass stretches mid-scale differences by design. The drill-in's Not counted list is where a reader can see the large mover for themselves.
    const offence = (() => {
        if (!AppState.playerDataLoaded || !AppState.playerData) return null;
        if (!battingIds.length) return null;
        // Who counts as a bat is playerRoleGroups' question, not this file's. Absence of starterStatusByProGame looked like a cheap proxy for "not a pitcher" and is not one: measured on a real pool it kept 180 of 3000 players and every one of them had an empty stat line, because what it actually selects is players with no pro games at all.
        const hitters = AppState.playerData
            .filter(p => p && p.proTeamId != null && playerRoleGroups(p, sport).primary)
            .map(p => ({ proTeamId: p.proTeamId, injuryStatus: p.injuryStatus, totals: p.seasonTotals || {} }));
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
            if (id === POINTS_COL) {
                // The same windowed points the rank was computed from, so the column and the chip beside it can never tell different stories.
                const score = ranks.get(playerId)?.score;
                return `<td class="${cls(id)}">${score === undefined ? '-' : Number(score).toFixed(1)}</td>`;
            }
            const v = p.seasonTotals?.[id];
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
    // A two-way player is eligible in both groups, so the SLOT he occupies decides which section he reads in. That is the role his team is actually using him in this week.
    const sectionFor = (row) => {
        const p = poolById.get(row.playerId) || AppState.playerData.find(x => x.id === row.playerId);
        if (!p) return pitcherSlots.has(row.slot) ? 'secondary' : 'primary';
        const g = playerRoleGroups(p, sport);
        if (g.secondary && !g.primary) return 'secondary';
        if (g.primary && !g.secondary) return 'primary';
        return pitcherSlots.has(row.slot) ? 'secondary' : 'primary';
    };

    const groupLabel = { primary: sport === 'flb' ? 'Batters' : 'Skaters', secondary: sport === 'flb' ? 'Pitchers' : 'Goalies' };
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
                const p = poolById.get(r.playerId);
                const v = p && p.seasonTotals ? p.seasonTotals[sort.statId] : undefined;
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
        for (let p = win.start; p <= win.end; p++) {
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
                return `<button class="mt-cal-start${state}${openStartKey === key ? ' open' : ''}"
                            data-start="${escapeHtml(key)}"${tint}
                            title="${escapeHtml(s.name)}${opp ? ' ' + opp : ''}, ${escapeHtml(label)}">
                            <span class="mt-cal-name">${escapeHtml(s.name)}</span>
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

        const totals = projected
            ? `${projected.remaining} of ${projected.total} start${projected.total === 1 ? '' : 's'} still to come`
            : '';
        // The way back has to be in the breakdown itself. The card that toggles it closed is one of the ones the grid just gave up its room for. The back control lives INSIDE the panel now. Three panels each stacking a button row of their own cost three rows of height to say one word; inline with the title it costs none, and the panel that owns it is the panel that knows where back leads.
        return `<div class="mt-cal${reading ? ' mt-cal-reading' : ''}">
                    <div class="mt-cal-grid">${cols.join('')}</div>
                    <div class="mt-cal-total">${escapeHtml(totals)}</div>
                    ${breakdown}
                </div>`;
    }

    // A start's own day, from the per-day buckets the bulk fetch keeps for pitchers. Null when the weekly data has not arrived, or when he recorded nothing that day, which is a start that was scratched after ESPN listed it rather than a start with a line of zeroes. The same rule the stat cells use, so a value reads identically wherever it appears.
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

    // The one line under the verdict, naming the start rather than describing it. The VENUE replaces "at home" and "on the road", which says the same thing and one thing more. The trail IS the navigation (, owner ruled option A). Every earlier crumb is a click target, the tail is where you are and is the panel's title, and there is no button anywhere. It replaces the stacked back buttons for a reason those could not solve: "Schedule" returns from ANY depth. A one-step control could only ever undo the last click, so leaving a drill-in for the calendar took two, and nothing on screen said how far in you were. crumbs: [{ label, to }] - `to` absent marks the tail, which is not clickable
    const crumbsHtml = (crumbs) => `
        <div class="mt-diff-crumbs">${crumbs.map((c, i) => `
            ${i ? '<span class="mt-crumb-sep">&rsaquo;</span>' : ''}
            ${c.to
                ? `<button type="button" class="mt-crumb" data-crumb="${c.to}">${escapeHtml(c.label)}</button>`
                : `<span class="mt-crumb-here">${escapeHtml(c.label)}</span>`}`).join('')}
        </div>`;

    // What the card's own crumb says: the pitcher and who he faces, which is how a reader names the start they clicked. Shared so the trail reads the same from every panel below it.
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
        // The bats-of-rostered fact belongs HERE, beside the players it is about, rather than in the header sentence where it was a parenthetical nobody could act on ( item 4).
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
        // "Percentile", the word the player drill-down's own rank table uses. "%ile" was ruled out there once already for being unreadable, so this reuses the ruling rather than inventing a third spelling of the same column. The composite lands in the TFOOT, exactly where the player drill-down puts its Rank Score and wearing the rule that already styles it ( item 3). It was an eq span on the title row before, and `margin-left: auto` threw it 1018px from its own label to the far right edge of the panel - rendered, and nowhere a reader looks. A total belongs under the table that justifies it.
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
            : '<div class="mt-cal-hint">This lineup cannot be measured from the pool, so there is nothing to break down.</div>';
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
                    <div class="mt-diff-dnote">Arenas above 100 favor hitters, below 100 favor pitchers.
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
                : `<div class="mt-cal-hint">No line recorded for this day. Either the numbers have not arrived yet, or the start was scratched after ESPN listed it.</div>`;
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
                        <div class="mt-cal-hint">This opponent's offence cannot be measured from the pool, so scoring the matchup would be a guess.</div>
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

    container.innerHTML = `
        <div class="mt-summary">
            <div class="mt-team">
                <button type="button" class="chrome-arrow mt-prev" aria-label="Previous team">&#8249;</button>
                <span class="mt-team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
                <button type="button" class="chrome-arrow mt-next" aria-label="Next team">&#8250;</button>
                ${isOwn ? '<span class="mt-own">Your team</span>' : ''}
            </div>
            <div class="mt-stand">
                <span class="mt-stand-label">${escapeHtml(standing.label)}</span>
                <span class="mt-stand-value">${escapeHtml(standing.value)}</span>
                <span class="mt-stand-rank">#${standing.rank} of ${standing.of}</span>
            </div>
            <div class="mt-profile">
                <span class="mt-profile-label">Wins</span>${profileChips(profile.best, 'mt-cat-best')}
                <span class="mt-profile-label">Bleeds</span>${profileChips(profile.worst, 'mt-cat-worst')}
            </div>
        </div>
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
                    : '<div class="player-loading">No roster available for this team.</div>')}`}
        </div>`;

    attachDataTooltips(container);
    wirePlayerAvatars(container);
    wireTeamSwitcher(container);
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
            // Hand the drill-down the role this row was read under, BEFORE the tab renders. Every pool the drill-down builds - rank chips, the breakdown's peer group, its categories, its workload measure - is scoped by AppState.playerGroup, and arriving from a roster row that state belongs to whichever tab the Player Metrics view happened to be left on. Clicking a closer while it sat on Batters ranked him against 454 batters over BATTING categories, where his every value is 0 and his batting games played are 0 too: seven real percentiles off an empty line, a 0% Playing-Time Factor, and a "Rank Score" of exactly 50 - which is the whole of the owner's report. The group is taken from the GROUP the row sits in rather than the player's primary role, so a two-way player opened from the pitching table is read as a pitcher.
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

// The vertical layout, as arithmetic. No measurement of what rendered, no rAF, no caches, no memory of earlier layouts. Same league, same window, same roster gives the same answer on every path, because the answer is a function of numbers that are all known before a row exists. WHY THE MEASURED VERSION KEPT FAILING, after five rounds of fixing which measurement wins (,, and the follow-ups): every one of them was measure-and-remember. Density ladders, reserved shares, provisional fits, generation guards. Each round settled a different race and the layout still depended on WHAT WAS ON SCREEN WHEN A MEASUREMENT RAN, which is why the same roster at the same viewport rendered one size on load and another after cycling through teams. Deleting the machinery is the fix; there is no measurement left to race. The one thing read from the DOM is the band's own height, which is not a measurement of content but the room the viewport and the summary above it leave. It cannot depend on history. rowHeight = clamp((room - budgetedChrome) / rosterCapacity, ROW_MIN, ROW_MAX) THE DIVISOR IS THE LEAGUE'S ROSTER, NOT THIS TEAM'S. Dividing by the rows in front of it made the row height a property of the team on screen: occupancy varies even where the league's roster does not, since a team carrying two players on the IL draws two more rows than one carrying none, and a team with nobody benched draws one band fewer. Measured 14, 15 and 16px across four teams at one window, so switching teams resized every word on the page. Budgeting the fullest roster the league allows makes the answer the same for all of them, and a team under capacity spends the difference as space between the tables rather than as bigger type. It also retires the two-case Schedule solve that used to live here. That existed to re-divide the leftover among THIS team's batting rows, which is precisely the team-dependence being removed; with a budgeted divisor the leftover is slack, and slack has somewhere to go. Rows still shrink toward ROW_MIN before anything scrolls, and still stop at ROW_MAX so a shallow league on a tall window reads as a roster rather than a menu.
function layoutRosterBand(container, counts, budget, hasSchedule) {
    const band = container.querySelector('.mt-roster');
    if (!band) return;
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
