// CSV/clipboard export of the dashboard's core tables.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS } from './state.js';
import { getTimeframeBounds, splitScoredAdvanced, escapeHtml } from './utils.js';
import { buildLeaderboardExportModel } from './players.js';

// ==== Pure text builders ====

// RFC-4180-style quoting, generalized to any delimiter: a cell is quoted only when it contains the delimiter, a quote, or a line break. Embedded quotes double. undefined/null become empty cells rather than the strings "undefined"/"null".
export function delimitedCell(value, delimiter) {
    const s = (value === undefined || value === null) ? '' : String(value);
    return (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

// CRLF line endings. The one line-break convention every spreadsheet app on every platform accepts for CSV, and what RFC 4180 specifies.
export function buildDelimitedText(headers, rows, delimiter = ',') {
    return [headers, ...rows]
        .map(row => row.map(cell => delimitedCell(cell, delimiter)).join(delimiter))
        .join('\r\n');
}

// Human-readable name for the current shared timeframe selection, with the resolved matchup range. Goes in the export modal's subtitle and the downloaded file's name.
export function timeframeLabel() {
    const tf = AppState.timeframe;
    const { start, end } = getTimeframeBounds(tf, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const names = { all: 'Regular Season + Playoffs', reg: 'Regular Season', p_all: 'Playoffs' };
    const base = names[tf] || (tf.startsWith('last') ? `Last ${tf.slice(4)} Matchups` : tf);
    return `${base} (Matchups ${start}-${end})`;
}

// Same display convention the dashboard's tables use: whole numbers stay whole, anything fractional shows 3 decimals.
function exportNumber(val) {
    if (val === undefined || val === null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return '';
    return (num % 1 !== 0) ? +num.toFixed(3) : num;
}

// ==== Dataset builders ====

// Sums a team's weekly values over the current timeframe, plus a W-L-T record for category leagues (weeklyMatchWins holds 1/0.5/0 there, points leagues store raw points instead, same distinction the standings bars make in graphs.js).
function summarizeTeam(t, start, end) {
    let mWins = 0, cWins = 0, w = 0, l = 0, ties = 0;
    for (let wk = start; wk <= end; wk++) {
        const val = t.weeklyMatchWins[wk];
        if (val === undefined) continue;
        mWins += val;
        cWins += t.weeklyCatWins[wk] || 0;
        if (val === 1) w++; else if (val === 0.5) ties++; else l++;
    }
    return { mWins, cWins, w, l, ties };
}

// Teams sorted the same way the Rankings standings sort them (match wins, then cat wins as a tiebreaker so equal-record teams don't order arbitrarily).
function sortedTeamSummaries(start, end) {
    return AppState.teamStats
        .map(t => ({ team: t, ...summarizeTeam(t, start, end) }))
        .sort((a, b) => (b.mWins - a.mWins) || (b.cWins - a.cWins) || a.team.name.localeCompare(b.team.name));
}

export function buildStandingsExport() {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const summaries = sortedTeamSummaries(start, end);

    if (AppState.isPointsLeague) {
        return {
            title: 'Standings',
            headers: ['Rank', 'Team', 'Points'],
            rows: summaries.map((s, i) => [i + 1, s.team.name, exportNumber(s.mWins)])
        };
    }
    return {
        title: 'Standings',
        headers: ['Rank', 'Team', 'W', 'L', 'T', 'Match Wins', 'Cat Wins'],
        rows: summaries.map((s, i) => [i + 1, s.team.name, s.w, s.l, s.ties, exportNumber(s.mWins), exportNumber(s.cWins)])
    };
}

// One column per category, one row per team. The same values Category Rankings plots: sums over the timeframe, except rate stats (AVERAGE_STATS) which average across weeks played.
export function buildCategoryTotalsExport(sport, includeAdvanced) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
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
    const stats = allStats.filter(s => visibleIds.has(s.id));

    const summaries = sortedTeamSummaries(start, end);
    const rows = summaries.map(({ team }) => {
        const cells = [team.name];
        stats.forEach(stat => {
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

// ==== Delivery ====

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

// Same overlay pattern as the rank explainer (players.js): built once, appended to <body> so no column's overflow can clip it, shown via the shared .rank-modal-overlay classes.
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
    const sport = document.getElementById('sport').value;
    const year = document.getElementById('year').value;
    const leagueName = AppState.apiData.settings?.name || 'league';

    overlay.querySelector('#export-modal-subtitle').textContent =
        `${leagueName} • ${year} • ${timeframeLabel()}`;

    // Leaderboard availability is re-checked on every open. The pool loads in the background (prefetchPlayerData), so it's usually ready even if the Player tab was never clicked.
    const leaderboardReady = !!buildLeaderboardExportModel();
    const datasets = [
        { key: 'standings', label: 'League Standings', note: 'Records and match/category wins over the selected timeframe.', enabled: true },
        ...(!AppState.isPointsLeague ? [{ key: 'categories', label: 'Category Totals', note: 'Each team\'s production per scored category over the selected timeframe.', enabled: true }] : []),
        {
            key: 'leaderboard', label: 'Player Leaderboard',
            note: leaderboardReady
                ? 'Exactly as currently shown: group tab, search, position filter, sort, and timeframe all apply.'
                : 'Player data is still loading (or unavailable) - open the Player Metrics tab first.',
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
    // One Copy button (was two: "Copy CSV" + "Copy for Excel/Sheets").
    overlay.querySelector('#export-copy-btn').onclick = () => {
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        copyText(buildDelimitedText(data.headers, data.rows, '\t'), `Copied ${data.rows.length} rows - paste into Excel, Sheets, or chat ✓`);
    };

    overlay.classList.add('open');
}
