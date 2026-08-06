// CSV/clipboard export of the dashboard's core tables - the Phase 1 "small delighters" item from ROADMAP.md. Three datasets, each exported as-configured rather than as a fixed dump: - League Standings: records/match wins/cat wins over the CURRENT shared timeframe - Category Totals: per-team category production over that same timeframe - Player Leaderboard: exactly what the Player Metrics table currently shows (group tab, search, position filter, sort, Minimum Games toggle, timeframe) - see buildLeaderboardExportModel in players.js Formats: CSV file download, CSV to clipboard, or TSV to clipboard (pastes straight into Excel/Google Sheets as columns). The builders are pure-ish (AppState in, plain rows out) and unit-tested in tests/features.test.html.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS } from './state.js';
import { getTimeframeBounds, splitScoredAdvanced, escapeHtml, orderStatIdsByRole, axisUnit, parseTimeframe } from './utils.js';
import { buildLeaderboardExportModel } from './players.js';

// ==== Pure text builders ====

// RFC-4180-style quoting, generalized to any delimiter. A cell is quoted only when it contains the delimiter, a quote, or a line break; embedded quotes double. undefined/null become empty cells rather than the strings "undefined"/"null".
export function delimitedCell(value, delimiter) {
    const s = (value === undefined || value === null) ? '' : String(value);
    return (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

// CRLF line endings - the one line-break convention every spreadsheet app on every platform accepts for CSV, and what RFC 4180 specifies.
export function buildDelimitedText(headers, rows, delimiter = ',') {
    return [headers, ...rows]
        .map(row => row.map(cell => delimitedCell(cell, delimiter)).join(delimiter))
        .join('\r\n');
}

// Human-readable name for the current shared timeframe selection, with the resolved range - goes in the export modal's subtitle and the downloaded file's name. The unit follows the league type like every graph axis does. A roto export covers WEEKS, and calling them matchups in the file name would contradict the pills the user picked them with.
export function timeframeLabel() {
    const tf = AppState.timeframe;
    const { start, end } = getTimeframeBounds(tf, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const unit = axisUnit();
    const names = { all: 'Regular Season + Playoffs', reg: 'Regular Season', p_all: 'Playoffs' };
    // Both halves get named, so an export of "the last 4 of the regular season" says exactly that rather than picking one of the two and hiding the other.
    const { span, window: n } = parseTimeframe(tf);
    const spanName = names[span] || span;
    // The span is named only when it narrows things. "Last 4 Matchups" already means the last four of the season, and repeating "Regular Season + Playoffs" after it says nothing.
    const qualifier = span === 'all' ? '' : `, ${spanName}`;
    const base = n === 1 ? `Current ${unit.long}${qualifier}`
        : n ? `Last ${n} ${unit.plural}${qualifier}`
        : spanName;
    return `${base} (${unit.plural} ${start}-${end})`;
}

// Same display convention the dashboard's tables use. Whole numbers stay whole, anything fractional shows 3 decimals. Numbers stay numbers (not strings) so spreadsheets treat them as values; only undefined becomes an empty cell.
function exportNumber(val) {
    if (val === undefined || val === null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return '';
    return (num % 1 !== 0) ? +num.toFixed(3) : num;
}

// ==== Dataset builders - each returns { title, headers, rows } ====

// Sums a team's weekly values over the current timeframe: a real W-L-T match record and match-win count for every league, plus points-for (points leagues) or category wins (category leagues). weeklyMatchWins holds the 1/0.5/0 result in a category league but raw points in a points one, whose real per-week result lives in weeklyMatchResult - so both league types get a genuine record here instead of the points total being mistaken for a win count.
function summarizeTeam(t, start, end) {
    const isPoints = AppState.isPointsLeague;
    let matchWins = 0, points = 0, cWins = 0, w = 0, l = 0, ties = 0;
    for (let wk = start; wk <= end; wk++) {
        const mw = t.weeklyMatchWins[wk];
        if (mw === undefined) continue;
        if (isPoints) points += mw;
        // A playoff bye scored points but played nobody, so it counts toward Points For and toward no record at all.
        if (t.weeklyBye?.[wk]) continue;
        const result = isPoints ? (t.weeklyMatchResult[wk] || 0) : mw;
        matchWins += result;
        cWins += t.weeklyCatWins[wk] || 0;
        if (result === 1) w++; else if (result === 0.5) ties++; else l++;
    }
    return { matchWins, points, cWins, w, l, ties };
}

// Teams sorted the same way the Rankings standings sort them (match wins, then the secondary section's total - points for a points league, cat wins otherwise - as a tiebreaker so equal-record teams don't order arbitrarily).
function sortedTeamSummaries(start, end) {
    // Roto has no matchups to summarize, so every weekly total is 0 and the order would collapse to alphabetical - rank by ESPN's own season roto points instead, matching the standings view.
    if (AppState.isRotoLeague) {
        return AppState.teamStats
            .map(t => ({ team: t, matchWins: 0, points: 0, cWins: 0, w: 0, l: 0, ties: 0 }))
            .sort((a, b) => (b.team.rotoPoints - a.team.rotoPoints) || a.team.name.localeCompare(b.team.name));
    }
    return AppState.teamStats
        .map(t => ({ team: t, ...summarizeTeam(t, start, end) }))
        .sort((a, b) => (b.matchWins - a.matchWins)
            || ((AppState.isPointsLeague ? b.points - a.points : b.cWins - a.cWins))
            || a.team.name.localeCompare(b.team.name));
}

export function buildStandingsExport() {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // Roto standings are ESPN's own numbers rendered as-is (B31-FULL): the season total, then each scored category's season value alongside the roto points it awarded. Two columns per category rather than one, because the value alone doesn't say what it earned and the points alone don't say what produced them.
    if (AppState.isRotoLeague) {
        const sport = AppState.loadedSport;
        const statMap = ESPN_STAT_MAPS[sport] || {};
        const catIds = orderStatIdsByRole(sport, Object.keys(statMap).filter(id => AppState.scoredStatIds.has(id)));
        const ranked = [...AppState.teamStats].sort((a, b) =>
            (b.rotoPoints - a.rotoPoints) || a.name.localeCompare(b.name));
        return {
            title: 'Standings',
            headers: ['Rank', 'Team', 'Roto Points', ...catIds.flatMap(id => [statMap[id], `${statMap[id]} Pts`])],
            rows: ranked.map((t, i) => [
                i + 1, t.name, exportNumber(t.rotoPoints),
                ...catIds.flatMap(id => [exportNumber(t.seasonCats[id]), exportNumber(t.rotoPointsByStat[id])])
            ])
        };
    }

    // A single-matchup window can't make a record - one game is 1-0 or 0-1 for everyone, the same substitution the standings bars make. Rank by the one number that's real for a single week: categories won (category leagues) or points scored (points leagues), no W-L columns.
    if (start === end) {
        const week = start;
        const isPoints = AppState.isPointsLeague;
        const ranked = AppState.teamStats
            .map(t => ({ name: t.name, val: (isPoints ? t.weeklyMatchWins[week] : t.weeklyCatWins[week]) || 0 }))
            .sort((a, b) => (b.val - a.val) || a.name.localeCompare(b.name));
        return {
            title: 'Standings',
            headers: ['Rank', 'Team', isPoints ? 'Points' : 'Categories Won'],
            rows: ranked.map((r, i) => [i + 1, r.name, exportNumber(r.val)])
        };
    }

    const summaries = sortedTeamSummaries(start, end);

    if (AppState.isPointsLeague) {
        return {
            title: 'Standings',
            headers: ['Rank', 'Team', 'W', 'L', 'T', 'Match Wins', 'Points For'],
            rows: summaries.map((s, i) => [i + 1, s.team.name, s.w, s.l, s.ties, exportNumber(s.matchWins), exportNumber(s.points)])
        };
    }
    return {
        title: 'Standings',
        headers: ['Rank', 'Team', 'W', 'L', 'T', 'Match Wins', 'Cat Wins'],
        rows: summaries.map((s, i) => [i + 1, s.team.name, s.w, s.l, s.ties, exportNumber(s.matchWins), exportNumber(s.cWins)])
    };
}

// One column per category, one row per team - the same values Category Rankings plots: sums over the timeframe, except rate stats (AVERAGE_STATS) which average across weeks played. Same name-dedup as the Team Metrics category checkboxes (controls.js), so a name reused across ids (see ESPN_STAT_MAPS) doesn't become two identical columns.
export function buildCategoryTotalsExport(sport, includeAdvanced) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgStats = AVERAGE_STATS[sport] || new Set();

    const seen = new Set();
    const allStats = [];
    Array.from(AppState.availableStatsSet).forEach(statId => {
        const name = statMap[statId] || `Stat [${statId}]`;
        if (seen.has(name)) return;
        seen.add(name);
        allStats.push({ id: statId, name });
    });
    const { scored, advanced } = splitScoredAdvanced(allStats.map(s => s.id));
    const visibleIds = new Set(includeAdvanced ? [...scored, ...advanced] : scored);
    // Role-grouped columns (batting/skaters before pitching/goalies), matching the heatmap and every other surface - availableStatsSet's own order interleaves the two.
    const visibleStats = allStats.filter(s => visibleIds.has(s.id));
    const statById = new Map(visibleStats.map(s => [String(s.id), s]));
    const stats = orderStatIdsByRole(sport, visibleStats.map(s => s.id)).map(id => statById.get(String(id)));

    const summaries = sortedTeamSummaries(start, end);
    const rows = summaries.map(({ team }) => {
        const cells = [team.name];
        stats.forEach(stat => {
            // A roto total is already season-long (valuesByStat -> seasonCats), with no weeks to sum or rate stats to average across - it IS the number ESPN ranks the category on.
            if (AppState.isRotoLeague) {
                cells.push(exportNumber(team.seasonCats[stat.id]));
                return;
            }
            let sum = 0, weeksPlayed = 0;
            for (let wk = start; wk <= end; wk++) {
                if (team.weeklyCats[wk] && team.weeklyCats[wk][stat.id] !== undefined) {
                    sum += team.weeklyCats[wk][stat.id];
                    weeksPlayed++;
                }
            }
            cells.push(exportNumber(avgStats.has(stat.id.toString()) && weeksPlayed > 0 ? sum / weeksPlayed : sum));
        });
        return cells;
    });

    return { title: 'Category Totals', headers: ['Team', ...stats.map(s => s.name)], rows };
}

export function buildLeaderboardExport(includeAdvanced) {
    const model = buildLeaderboardExportModel(includeAdvanced);
    if (!model) return null;
    return { title: 'Player Leaderboard', headers: model.headers, rows: model.rows };
}

// ==== Delivery: file download / clipboard ====

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

function downloadCsv(text, filenameBase) {
    // BOM so Excel opens the file as UTF-8 (team/player names carry accents and emoji).
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenameBase}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ==== Modal UI ====

// Same overlay pattern as the rank explainer (players.js). Built once, appended to <body> so no column's overflow can clip it, shown via the shared.rank-modal-overlay classes.
function ensureExportModal() {
    let overlay = document.getElementById('export-modal-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'export-modal-overlay';
    overlay.className = 'rank-modal-overlay';
    overlay.innerHTML = `
        <div class="rank-modal-content export-modal-content">
            <button type="button" class="rank-modal-close" id="export-modal-close-btn">&times;</button>
            <h3>Export data</h3>
            <div class="rank-modal-subtitle" id="export-modal-subtitle"></div>
            <div id="export-dataset-options" class="export-option-group"></div>
            <label class="export-advanced-toggle"><input type="checkbox" id="export-include-advanced"> Include advanced (unscored) stats</label>
            <div class="export-actions">
                <button type="button" class="export-action-btn export-action-primary" id="export-download-btn">⬇ Download CSV</button>
                <button type="button" class="export-action-btn" id="export-copy-btn">📋 Copy</button>
            </div>
            <div id="export-status" class="export-status"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
    });
    overlay.querySelector('#export-modal-close-btn').addEventListener('click', () => overlay.classList.remove('open'));
    return overlay;
}

function setExportStatus(text, isError = false) {
    const el = document.getElementById('export-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'export-status' + (isError ? ' export-status-error' : text ? ' export-status-ok' : '');
}

export function openExportModal() {
    if (!AppState.apiData) return;
    const overlay = ensureExportModal();
    // Both describe the league being exported, so both come off the loaded payload rather than the form. A dropdown the user has moved since would otherwise label this export, and the file it downloads, with a sport and season the rows do not belong to.
    const sport = AppState.loadedSport;
    const year = String(AppState.apiData.seasonId || document.getElementById('year').value);
    const leagueName = AppState.apiData.settings?.name || 'league';

    overlay.querySelector('#export-modal-subtitle').textContent =
        `${leagueName} • ${year} • ${timeframeLabel()}`;

    // Leaderboard availability is re-checked on every open - the pool loads in the background (prefetchPlayerData), so it's usually ready even if the Player tab was never clicked.
    const leaderboardReady = !!buildLeaderboardExportModel();
    const datasets = [
        { key: 'standings', label: 'League Standings', note: 'Records and match/category wins over the selected timeframe.', enabled: true },
        ...(!AppState.isPointsLeague ? [{ key: 'categories', label: 'Category Totals', note: 'Each team\'s production per scored category over the selected timeframe.', enabled: true }] : []),
        {
            key: 'leaderboard', label: 'Player Leaderboard',
            note: leaderboardReady
                ? 'Exactly as currently shown: group tab, search, position filter, sort, and timeframe all apply.'
                : 'Player data is still loading (or unavailable). Open the Player Metrics tab first.',
            enabled: leaderboardReady
        }
    ];

    const optionsEl = overlay.querySelector('#export-dataset-options');
    optionsEl.innerHTML = datasets.map((d, i) => `
        <label class="export-dataset-option${d.enabled ? '' : ' disabled'}">
            <input type="radio" name="export-dataset" value="${d.key}"${d.enabled ? '' : ' disabled'}${i === 0 ? ' checked' : ''}>
            <span class="export-dataset-label">${escapeHtml(d.label)}</span>
            <span class="export-dataset-note">${escapeHtml(d.note)}</span>
        </label>
    `).join('');

    setExportStatus('');

    const buildSelected = () => {
        const key = overlay.querySelector('input[name="export-dataset"]:checked')?.value;
        const includeAdvanced = overlay.querySelector('#export-include-advanced').checked;
        if (key === 'categories') return buildCategoryTotalsExport(sport, includeAdvanced);
        if (key === 'leaderboard') return buildLeaderboardExport(includeAdvanced);
        return buildStandingsExport();
    };

    const copyText = async (text, doneMsg) => {
        try {
            await navigator.clipboard.writeText(text);
            setExportStatus(doneMsg);
        } catch (err) {
            setExportStatus(`Couldn't copy: ${err.message}`, true);
        }
    };

    // Re-wired on every open via onclick (not addEventListener) so reopening the modal never stacks duplicate handlers on the same buttons.
    overlay.querySelector('#export-download-btn').onclick = () => {
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        downloadCsv(buildDelimitedText(data.headers, data.rows, ','),
            `${slugify(leagueName)}-${slugify(data.title)}-${year}-${slugify(AppState.timeframe)}`);
        setExportStatus(`Downloaded ${data.rows.length} rows ✓`);
    };
    // One Copy button (was two: "Copy CSV" + "Copy for Excel/Sheets"). Copies TAB-separated text, which is the one clipboard format that pastes cleanly as real columns into Excel, Google Sheets, and chat apps alike - comma-separated text pastes into a single column there. The Download button still produces a proper.csv file for anyone who wants the file.
    overlay.querySelector('#export-copy-btn').onclick = () => {
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        copyText(buildDelimitedText(data.headers, data.rows, '\t'), `Copied ${data.rows.length} rows. Paste into Excel, Sheets, or chat ✓`);
    };

    overlay.classList.add('open');
}
