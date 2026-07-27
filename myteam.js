// My Team: a roster viewer that defaults to the user's own team and can scout any other. Nothing here forks the engines: ranks come from the leaderboard's own pool ranking, the category profile from the heatmap's aggregation.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, INVERSE_STATS, NON_STARTING_SLOTS, LINEUP_SLOT_ORDER, SLOT_POSITION_MAPS, POSITION_MAPS } from './state.js';
import { escapeHtml, getTimeframeBounds, axisUnit, attachDataTooltips, splitStatIdsByRole } from './utils.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { rosterRankLookup, openPlayerDetail, playerRoleGroups, effectivePlayerPool, loadPlayerTabIfNeeded } from './players.js';
import { fetchRosterForPeriod } from './api.js';
import { teamCategoryProfile } from './graphs.js';

// Which team the tab is showing, remembered per league so scouting another roster survives a tab switch but never leaks into the next league fetched.
let viewedTeamKey = null;
let viewedTeamId = null;
// Per-group sort, one category at a time, kept per role so sorting the batters never disturbs how the pitchers read.
let groupSort = { primary: null, secondary: null };
// Two columns that are not ESPN stat ids: the fantasy points a points league scores its players by, and the rank chip, which sorts like any other column.
const POINTS_COL = '__points__';
const RANK_COL = '__rank__';
// A finished season's last lineup, fetched once per league. The payload carries current rosters only while a matchup is live, and ESPN still serves the final scoring period's rosters, which is the team as it stood for the last matchup.
let finalRosters = { key: null, byTeam: null, state: 'idle' };

// The pool arriving is the other half of a league switch, since this tab renders as soon as the league payload commits, well before the player pool it needs. Guarded on the tab being on screen, because rendering a hidden view measures zero.
document.addEventListener('leaguewise:player-pool-ready', () => {
    const view = document.getElementById('view-myteam');
    if (view && view.style.display !== 'none') renderMyTeamTab();
});

export function resetMyTeamView() {
    viewedTeamKey = null;
    viewedTeamId = null;
    groupSort = { primary: null, secondary: null };
    finalRosters = { key: null, byTeam: null, state: 'idle' };
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

// PURE. The current roster off the league payload, which carries it on each side of an in-progress matchup. Returns a Map of teamId to entries, and an empty map means the season is over or the week has no games, so the caller falls back to one mRoster call.
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
        viewedTeamId = AppState.teamStats.length ? AppState.teamStats[0].id : null;
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
    const colLabel = (id) => (id === POINTS_COL ? 'PTS' : statMap[id]);

    const standing = teamStandingLine(team);
    const profile = teamCategoryProfile(team.id);
    const isOwn = AppState.userSwid && findOwnedTeamId(AppState.apiData.teams, AppState.userSwid) === team.id;

    // The shared timeframe drives this tab like it drives the other two: the lines come off the pool as the current window sees it, and the ranks already do, since rosterRankLookup reads the same pool. Nothing else asks for the pool on this tab's behalf, so ask here and let the pool-ready listener above redraw when it lands.
    if (!AppState.playerDataLoaded) loadPlayerTabIfNeeded();
    const windowedPool = effectivePlayerPool(sport);
    const poolById = new Map(windowedPool.map(p => [p.id, p]));
    const rosterIds = new Set(entries.map(e => e.playerId));
    const windowedMissing = AppState.playerDataLoaded
        ? [...rosterIds].filter(id => !poolById.has(id) && AppState.playerData.some(p => p.id === id)).length
        : 0;

    const chip = (playerId) => {
        const r = ranks.get(playerId);
        if (!r) return '<span class="mt-rank-none">-</span>';
        return `<span class="mt-rank" data-tooltip="Rank ${r.rank} of ${r.total} among ${escapeHtml(r.poolLabel)}">#${r.rank}</span>`;
    };
    const sortedIdFor = (role) => (groupSort[role] ? groupSort[role].statId : null);
    const statCells = (playerId, ids, sortedId) => {
        const cls = (id) => 'mt-stat' + (id === sortedId ? ' mt-sorted-col' : '');
        const p = poolById.get(playerId);
        if (!p) return ids.map(id => `<td class="${cls(id)}">-</td>`).join('');
        return ids.map(id => {
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
                <td class="mt-player">${buildPlayerAvatarHtml(sport, row.playerId, name)}<span class="mt-name">${escapeHtml(name)}</span></td>
                <td class="mt-pos">${escapeHtml(pos)}</td>
                <td class="mt-rankcell${sortedId === RANK_COL ? ' mt-sorted-col' : ''}">${chip(row.playerId)}</td>
                ${statCells(row.playerId, ids, sortedId)}
                <td class="mt-fill"></td>
            </tr>`;
    };

    // Role-grouped, because a pitcher's line under batting headers says nothing and one header row cannot serve both. splitStatIdsByRole owns which categories belong to which group, the same split the heatmap and the recap order by.
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

        // Sorting a group asks a question about the whole group, so it ranks starters, bench and IL together and the slot bands step aside. Inverse categories sort so that descending still means best first.
        const sort = groupSort[role];
        let body;
        if (sort && (ids.includes(sort.statId) || sort.statId === RANK_COL)) {
            const all = [...starters, ...bench, ...injured, ...orphans];
            const valueOf = (r) => {
                const entry = ranks.get(r.playerId);
                if (sort.statId === RANK_COL) return entry ? entry.rank : null;
                if (sort.statId === POINTS_COL) return entry && entry.score !== undefined ? entry.score : null;
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
            return `<th class="mt-stat mt-sortable${active ? ' mt-sorted mt-sorted-col' : ''}" data-role="${role}" data-stat="${id}"
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
            ${entries.length && !AppState.playerDataLoaded
                ? '<div class="mt-note">Player names, ranks and season lines fill in when the player pool finishes loading.</div>'
                : (windowedMissing
                    ? `<div class="mt-note">${windowedMissing} rostered ${windowedMissing === 1 ? 'player has' : 'players have'} no games in this timeframe, so their lines and ranks are blank.</div>`
                    : '')}
            ${entries.length ? rosterBody
            : (awaitingFinal
                ? '<div class="player-loading">Loading the final lineup of the season...</div>'
                : '<div class="player-loading">No roster available for this team.</div>')}
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
    fitRosterBand(container, `${team.id}:${AppState.timeframe}:${window.innerWidth}x${window.innerHeight}:${entries.length}`);
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

// Every rostered player stays visible: the row density yields before anything goes behind a scrollbar, the same ruling the standings and category ladders follow. Measured in a frame so the tables have really laid out, and each step is re-measured because a tighter row changes the height the next decision is made against.
const ROSTER_DENSITY_STEPS = ['mt-dense', 'mt-denser', 'mt-densest'];
// The density is decided for a roster at a size, not for a particular arrangement of it. Sorting drops the band header rows, which was enough to let the ladder relax a step and grow the whole table on a click, so the chosen density is remembered against team, timeframe and viewport and reused for everything else.
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
        // A band with no layout measures zero overflow whatever it holds, so caching that answer would teach the fit that this roster needs no density and every later render with the same key would trust it.
        if (band.clientHeight > 0) {
            lastFitKey = fitKey || null;
            lastFitDensity = applied;
        }
    };

    if (fitKey && fitKey === lastFitKey) {
        // The cache exists to avoid a visible re-flow on every re-render, so apply it immediately, then check it. A cached answer that no longer fits is corrected on the next frame rather than believed.
        lastFitDensity.forEach(cls => band.classList.add(cls));
        requestAnimationFrame(() => {
            if (band.scrollHeight - band.clientHeight > 0) measure();
        });
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
        renderMyTeamTab();
    };
    container.querySelector('.mt-prev')?.addEventListener('click', () => step(-1));
    container.querySelector('.mt-next')?.addEventListener('click', () => step(1));
}
