// My Team: a roster viewer that defaults to the user's own team and can scout any other. Nothing here forks the engines: ranks come from the leaderboard's own pool ranking, the category profile from the heatmap's aggregation.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, INVERSE_STATS, NON_STARTING_SLOTS, LINEUP_SLOT_ORDER, SLOT_POSITION_MAPS, POSITION_MAPS } from './state.js';
import { escapeHtml, getTimeframeBounds, axisUnit, attachDataTooltips, splitStatIdsByRole, injuryBadgeHtml, playerPoolErrorText, parseTimeframe } from './utils.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { rosterRankLookup, openPlayerDetail, playerRoleGroups, effectivePlayerPool, loadPlayerTabIfNeeded, matchupPeriodMap, ensureWeeklyDataForTimeframe, weeklyDataPending } from './players.js';
import { fetchRosterForPeriod, fetchProTeamSchedules } from './api.js';
import { buildGamePeriodIndex, buildProTeamAbbrevs, currentMatchupWindow, countProjectedStarts } from './probables.js';
import { teamCategoryProfile } from './graphs.js';

// Which team the tab is showing, remembered per league so scouting another roster survives a tab switch but never leaks into the next league fetched.
let viewedTeamKey = null;
let viewedTeamId = null;
// True while the tab is showing a team it picked for want of a better answer, rather than one the SWID matched or the user chose. Only a stand-in may be replaced automatically.
let viewedTeamIsStandIn = false;
// Per-group sort, one category at a time, kept per role so sorting the batters never disturbs how the pitchers read.
let groupSort = { primary: null, secondary: null };
// Two columns that are not ESPN stat ids: the fantasy points a points league scores its players by, and the rank chip, which sorts like any other column.
const POINTS_COL = '__points__';
const RANK_COL = '__rank__';
// Projected starts. A pseudo-column like the two above, since it is not an ESPN stat id: it is counted from the probables feed against the pro schedule, and it only exists for pitchers.
const STARTS_COL = '__starts__';
// Real line breaks in a data-hint, which the hint tooltip renders via white-space: pre-line.
const NEWLINE = String.fromCharCode(10);
// A finished season's last lineup, fetched once per league. The payload carries current rosters only while a matchup is live, and ESPN still serves the final scoring period's rosters, which is the team as it stood for the last matchup.
let finalRosters = { key: null, byTeam: null, state: 'idle' };
// The pro schedule behind projected starts, fetched once per league and re-rendered into when it lands. Same fire-and-forget shape as finalRosters above, and a failure just means the line does not render.
let proSchedule = { key: null, index: null, abbrevs: null, state: 'idle' };
// Column widths chosen for a roster at a viewport, deliberately NOT keyed on the timeframe, since a window changes only the values inside columns whose job is already decided. Widths may only grow within a key.
let lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };

// The pool arriving is the other half of a league switch, since this tab renders as soon as the league payload commits, well before the pool it needs. Guarded on the tab being on screen, because rendering a hidden view measures zero.
document.addEventListener('leaguewise:player-pool-ready', () => {
    const view = document.getElementById('view-myteam');
    if (view && view.style.display !== 'none') renderMyTeamTab();
});

// The windowed lines need the weekly rows, which arrive well after the pool does. Same guard and same reasoning as the listener above.
document.addEventListener('leaguewise:weekly-data-ready', () => {
    const view = document.getElementById('view-myteam');
    if (view && view.style.display !== 'none') renderMyTeamTab();
});

// Every entry re-measures rather than trusting the last decision. A view that was display:none measures zero, the league may have been swapped underneath it, and the window may have been resized while another tab was up.
export function invalidateMyTeamLayout() {
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    lastFitKey = null;
    lastFitDensity = [];
}

export function resetMyTeamView() {
    viewedTeamKey = null;
    viewedTeamId = null;
    viewedTeamIsStandIn = false;
    groupSort = { primary: null, secondary: null };
    finalRosters = { key: null, byTeam: null, state: 'idle' };
    proSchedule = { key: null, index: null, abbrevs: null, state: 'idle' };
    lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
    lastFitKey = null;
    lastFitDensity = [];
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

// The period to ask for when the payload has none: the season's own final scoring period, falling back to the latest one it reports.
function finalPeriodOf(apiData) {
    const st = (apiData || {}).status || {};
    return st.finalScoringPeriod || st.latestScoringPeriod || null;
}

// Fire and forget: kicks the one call, then re-renders when it lands. Guarded by league key and by state, so a tab switch or a timeframe click never starts a second one.
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

// SWID comparison tolerant of the brace-wrapped and case forms ESPN uses in different places.
function sameSwid(a, b) {
    const norm = (s) => String(s || '').replace(/[{}]/g, '').toUpperCase();
    return !!a && !!b && norm(a) === norm(b);
}

// Validated against real captures: teams[].owners is an array of SWID strings in the brace-wrapped uppercase form the cookie also carries, and teams[].primaryOwner repeats the first of them. A league the user only spectates matches nothing, which is the switcher-only case this tab handles.
export function findOwnedTeamId(teams, swid) {
    if (!swid) return null;
    const owned = (teams || []).find(t =>
        (t.owners || []).some(o => sameSwid(o, swid)) || sameSwid(t.primaryOwner, swid));
    return owned ? owned.id : null;
}

// PURE. Splits a roster into starters in the league's own slot order, then bench, then IR. A slot this app has no order for still renders, appended in id order, so an unfamiliar roster construction degrades to a sane list instead of dropping players.
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

// PURE. The current roster off the league payload, which carries it on each side of an in-progress matchup. An empty map means the season is over or the week has no games, and the caller falls back to one roster call.
export function rostersFromPayload(apiData) {
    const out = new Map();
    ((apiData || {}).schedule || []).forEach(game => {
        ['home', 'away'].forEach(side => {
            const s = game[side];
            const entries = ((s || {}).rosterForCurrentScoringPeriod || {}).entries;
            if (!s || !entries || !entries.length) return;
            // The last matchup period wins for a team that appears more than once, because ESPN only attaches this to the period it is serving.
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
    // SLOT_POSITION_MAPS omits the roster-status slots, which are not real defensive positions. A lineup view is the one place they must read, so they are named here rather than by loosening that map.
    const statusNames = { flb: { 6: 'MI', 7: 'CI', 12: 'UTIL', 19: 'IF' }, fhl: { 3: 'F', 4: 'D', 5: 'G', 6: 'UTIL' } };
    return (statusNames[sport] || {})[slot] || String(slot);
}

function teamById(id) {
    return AppState.teamStats.find(t => t.id === id) || null;
}

// The team's record or roto total, and where that places it. Same ordering the standings bars use, so the number here and the bar there cannot disagree.
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
            // A playoff bye is not a game: its points count, its non-result does not.
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

export function renderMyTeamTab() {
    const container = document.getElementById('myteam-container');
    if (!container) return;

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
        // Whoever is first, because there is no SWID to match yet or it matched nothing. Marked as a stand-in so a SWID arriving later can correct it, since a user who logs in mid-session would otherwise sit on a stranger's roster.
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
    // A finished season carries no current roster, so fall back to the final period's lineup.
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
    // A points league is scored on one number, so that number leads its stat block and the individual stats behind it stay.
    const colLabel = (id) => (id === POINTS_COL ? 'PTS' : id === STARTS_COL ? 'Starts' : statMap[id]);

    const standing = teamStandingLine(team);
    const profile = teamCategoryProfile(team.id);
    const isOwn = AppState.userSwid && findOwnedTeamId(AppState.apiData.teams, AppState.userSwid) === team.id;
    ensureProSchedule(key);

    // The shared timeframe drives this tab like the other two. Nothing else asks for the pool on this tab's behalf, so it asks here and the pool-ready listener redraws when it lands.
    if (!AppState.playerDataLoaded && !AppState.playerDataError) loadPlayerTabIfNeeded();
    // Without the pool there are no names, ranks or stats, so the roster would be a column of headshots against blank rows. The summary band stays, because it comes off the league payload and is still true.
    const poolFailed = !AppState.playerDataLoaded && !!AppState.playerDataError;
    const windowedPool = effectivePlayerPool(sport);
    const poolById = new Map(windowedPool.map(p => [p.id, p]));
    const rosterIds = new Set(entries.map(e => e.playerId));
    // A windowed pill reads the weekly rows, so ask for them here. Nothing on this tab used to, which is why a league opened straight into My Team showed every windowed line as a dash until the user visited Player Metrics.
    if (AppState.playerDataLoaded && parseTimeframe(AppState.timeframe).window !== null) {
        ensureWeeklyDataForTimeframe(sport);
    }
    // A rostered player absent from the windowed pool has no weekly row cached, which means either the rows have not arrived or he did not play in this window. Saying the second while the fetch is running asserts something untrue.
    const windowedMissing = AppState.playerDataLoaded
        ? [...rosterIds].filter(id => !poolById.has(id) && AppState.playerData.some(p => p.id === id)).length
        : 0;
    const weeklyStillArriving = windowedMissing > 0 && weeklyDataPending();

    const chip = (playerId) => {
        const r = ranks.get(playerId);
        if (!r) return '<span class="mt-rank-none">-</span>';
        return `<span class="mt-rank" data-tooltip="Rank ${r.rank} of ${r.total} among ${escapeHtml(r.poolLabel)}">#${r.rank}</span>`;
    };
    // Projected starts for the matchup being played, counted once and read by the pitcher column. IR is excluded because those players cannot be started without a roster move, while the bench is included, since a benched starter is routinely slotted in on the morning he pitches.
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
                // The count is the answer; the hint is the working behind it, one line per start so the day and the opponent are readable rather than run together.
                const lines = entry.games.map(g => {
                    const when = startDay(g);
                    const who = startOpponent(g);
                    return `${when}${who ? ' ' + who : ''}${g.played ? ' (done)' : ''}`;
                }).join(NEWLINE);
                const hint = `${entry.remaining} of ${entry.starts} projected start${entry.starts === 1 ? '' : 's'} left this ${axisUnit().long.toLowerCase()}.${NEWLINE}${NEWLINE}${lines}`;
                return `<td class="${cls(id)}"><span class="mt-starts" data-hint="${escapeHtml(hint)}" tabindex="0" role="button">${entry.remaining}<span class="mt-starts-of">/${entry.starts}</span></span></td>`;
            }
            if (id === POINTS_COL) {
                // The same windowed points the rank was computed from, so the column and the chip beside it cannot tell different stories.
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

    // Role-grouped, because a pitcher's line under batting headers says nothing and one header row cannot serve both. The split is the same one the heatmap and the recap already order by.
    const byRole = splitStatIdsByRole(sport, scoredIds);
    const pitcherSlots = new Set(sport === 'flb' ? [13, 14, 15] : [5]);
    // A two-way player is eligible in both groups, so the slot he occupies decides which section he reads in.
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

    // Each group is its own table with its own columns and its own bench, so bench belongs to the role group it plays for.
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

        // Sorting a group asks about the whole group, so it ranks starters, bench and IL together and the slot bands step aside. Inverse categories sort so that descending still means best first.
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
            // Rank counts up toward worse, like an inverse category, so descending means best first everywhere in this table.
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
                ? ` data-hint="Projected starts this ${escapeHtml(axisUnit().long.toLowerCase())}, still to come out of the total. From ESPN's probable pitchers, so it moves with rotations and injuries. Hover a pitcher for his days and opponents."`
                : '';
            return `<th class="mt-stat mt-sortable${active ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${id}"${hint}
                        tabindex="0" role="button" title="Sort ${escapeHtml(colLabel(id))}">${escapeHtml(colLabel(id))}<span class="mt-arrow">${arrow}</span></th>`;
        };

        return `
            <div class="mt-group" data-role="${role}">
                <div class="mt-group-head">${escapeHtml(groupLabel[role])}</div>
                <table class="mt-table">
                    <thead><tr>
                        <th class="mt-slot">Slot</th><th class="mt-player">Player</th><th class="mt-pos">Pos</th><th class="mt-rankcell mt-sortable${sort && sort.statId === RANK_COL ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${RANK_COL}"
                            tabindex="0" role="button" title="Sort Overall Rank">Overall Rank<span class="mt-arrow">${sort && sort.statId === RANK_COL ? (sort.dir === 'desc' ? '▼' : '▲') : ''}</span></th>
                        ${ids.map(head).join('')}
                        <th class="mt-fill"></th>
                    </tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>`;
    };

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
    // Three states per column, the same cycle the heatmap headers use, so slot order is always one more click away.
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
    // The league belongs in this key, or the same team id and roster size in another league would collide and reuse its density. The timeframe is deliberately absent, since a window changes neither how many rows there are nor how tall they are. What IS present is whether the content has finished arriving, because a roster rendered before its pool lands carries a loading note and no Starts column, and holding that fit would freeze the tab at the wrong size.
    const contentSignature = [
        AppState.playerDataLoaded ? 'pool' : 'nopool',
        weeklyDataPending() ? 'weeklypending' : 'weeklyready',
        projected ? 'starts' : 'nostarts',
        entries.length
    ].join(':');
    fitRosterBand(container, `${key}:${team.id}:${window.innerWidth}x${window.innerHeight}:${contentSignature}`);
    container.querySelectorAll('.mt-row').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = Number(tr.dataset.playerId);
            if (AppState.playerData.some(p => p.id === id)) {
                document.getElementById('tab-btn-player')?.click();
                openPlayerDetail(id);
            }
        });
    });
}

// Player and Pos take their width from the roster on screen, measured after it renders. A fixed-layout table sizes a column for its worst case, and a league-wide width makes that the longest name in the whole pool, which is where the dead space came from. Measured, never estimated from character counts, because the answer depends on the font the density ladder has applied.
function sizeRosterColumns(container) {
    const names = [...container.querySelectorAll('.mt-name')];
    if (!names.length) return;
    // A hidden tab measures zero for everything, and writing that answer would size the roster for a container it was never shown in.
    if (!container.clientWidth) return;
    const sample = container.querySelector('td.mt-pos');
    if (!sample) return;

    // A PROBE, not the cells themselves. Measuring a cell's own box asks the column how wide the column is, which is circular and collapsed Pos far enough to clip it. The probe carries the cell's computed font, so the answer follows whatever density step is applied.
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
    // Category columns share ONE pitch across both tables, so the Nth category of one group stays above the Nth of the other. The pitch is the widest thing any of them must hold, which is usually a heading rather than a number.
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

    // The shared columns are applied and settled BEFORE the category pitch is measured, because the pitch divides what is left after them. Reading clientWidth below forces the layout.
    const fitKeyBase = `${AppState.loadedSport}:${AppState.apiData.id}:${AppState.apiData.seasonId}:` +
        `${viewedTeamId}:${window.innerWidth}x${window.innerHeight}:${names.length}`;
    if (lastColumnFit.key !== fitKeyBase) lastColumnFit = { key: fitKeyBase, player: 0, pos: 0, stat: 0 };
    lastColumnFit.player = Math.max(lastColumnFit.player, playerW);
    lastColumnFit.pos = Math.max(lastColumnFit.pos, posW2);
    container.style.setProperty('--mt-player-w', lastColumnFit.player + 'px');
    container.style.setProperty('--mt-pos-w', lastColumnFit.pos + 'px');
    // The FLOOR for a category column: what its widest heading or value needs, so a narrow window tightens the columns rather than clipping them.
    const statFloor = Math.ceil(Math.max(statHeadW, statValueW));

    // Categories fill the room the table has and stay aligned between the groups. Both hold at once only if both share one pitch, so it is sized for the group carrying the MOST categories and the shorter group's filler absorbs the columns it does not have.
    const groups = [...container.querySelectorAll('.mt-group')];
    let available = Infinity, mostCategories = 0, pad = 0;
    groups.forEach(group => {
        const heads = [...group.querySelectorAll('thead th')];
        const statHeads = heads.filter(th => th.classList.contains('mt-stat'));
        if (!statHeads.length) return;
        const shared = heads
            .filter(th => !th.classList.contains('mt-stat') && !th.classList.contains('mt-fill'))
            .reduce((sum, th) => sum + th.getBoundingClientRect().width, 0);
        // The GROUP's width, not the table's. A fixed-layout table is as wide as its columns say, so measuring the table asks the columns how wide the columns should be and the answer never shrinks. The group is the room the table is allowed.
        available = Math.min(available, group.clientWidth - shared);
        mostCategories = Math.max(mostCategories, statHeads.length);
        // Padding is part of the pitch but not of the width property, which is content-box here.
        const cs = getComputedStyle(statHeads[0]);
        pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    });
    const pitch = mostCategories ? Math.floor(available / mostCategories) - pad : statFloor;
    // Grow-only within a key, so a window whose numbers are wider still gets the room it needs and a narrower one never shrinks the table back.
    lastColumnFit.stat = Math.max(lastColumnFit.stat, Math.max(statFloor, Math.floor(pitch)));
    container.style.setProperty('--mt-stat-w', lastColumnFit.stat + 'px');
}

// Density is measured rather than guessed, in a frame so the tables have really laid out, and each step is re-measured because a tighter row changes the height the next decision is made against. The steps only shrink chrome, and no player is ever dropped.
const ROSTER_DENSITY_STEPS = ['mt-dense', 'mt-denser', 'mt-densest'];
// The density is decided for a roster at a size, not for a particular arrangement of it, so a sort only ever re-orders rows.
let lastFitKey = null;
let lastFitDensity = [];
function fitRosterBand(container, fitKey) {
    const band = container.querySelector('.mt-roster');
    if (!band) return;

    // Run the ladder for real: strip density, then add steps until nothing overflows.
    const measure = () => {
        ROSTER_DENSITY_STEPS.forEach(cls => band.classList.remove(cls));
        const applied = [];
        for (const cls of ROSTER_DENSITY_STEPS) {
            if (band.scrollHeight - band.clientHeight <= 0) break;
            band.classList.add(cls);
            applied.push(cls);
        }
        // A band with no layout measures zero overflow whatever it holds, so caching that answer would teach the fit that this roster needs no density and every later render would trust it.
        if (band.clientHeight > 0) {
            lastFitKey = fitKey || null;
            lastFitDensity = applied;
        }
        // A fresh measurement is the authoritative one, so the remembered widths start from nothing here. Carrying them across left a wider measurement behind for good, and the category pitch divides what is left after those columns.
        lastColumnFit = { key: null, player: 0, pos: 0, stat: 0 };
        // Widths are measured in whatever font the ladder just settled on, so they are sized here rather than before it. Width never feeds back into the height decision, since every cell is nowrap.
        sizeRosterColumns(container);
    };

    if (fitKey && fitKey === lastFitKey) {
        // The cache exists to avoid a visible re-flow on every re-render, so apply it immediately, then check it. A cached answer that no longer fits is corrected on the next frame rather than believed.
        lastFitDensity.forEach(cls => band.classList.add(cls));
        requestAnimationFrame(() => sizeRosterColumns(container));
        return;
    }
    requestAnimationFrame(measure);
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
