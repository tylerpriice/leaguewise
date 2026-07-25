// CSV and clipboard export of the standings, category totals and player leaderboard, each written as currently configured rather than as a fixed dump.

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS } from './state.js';
import { getTimeframeBounds, splitScoredAdvanced, escapeHtml, orderStatIdsByRole, axisUnit } from './utils.js';
import { buildLeaderboardExportModel } from './players.js';

// ==== Pure text builders ====

// RFC 4180 quoting generalized to any delimiter: a cell is quoted only when it contains the delimiter, a quote or a line break, and embedded quotes double. Null becomes an empty cell.
export function delimitedCell(value, delimiter) {
    const s = (value === undefined || value === null) ? '' : String(value);
    return (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

// CRLF, the line ending RFC 4180 specifies and every spreadsheet app accepts.
export function buildDelimitedText(headers, rows, delimiter = ',') {
    return [headers, ...rows]
        .map(row => row.map(cell => delimitedCell(cell, delimiter)).join(delimiter))
        .join('\r\n');
}

// Human-readable timeframe label with its resolved range. The unit follows the league type, so a roto export covers weeks rather than matchups.
export function timeframeLabel() {
    const tf = AppState.timeframe;
    const { start, end } = getTimeframeBounds(tf, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const unit = axisUnit();
    const names = { all: 'Regular Season + Playoffs', reg: 'Regular Season', p_all: 'Playoffs' };
    const base = names[tf] || (tf.startsWith('last') ? `Last ${tf.slice(4)} ${unit.plural}` : tf);
    return `${base} (${unit.plural} ${start}-${end})`;
}

// Whole numbers stay whole and fractions show 3 decimals. Numbers stay numbers so spreadsheets treat them as values.
function exportNumber(val) {
    if (val === undefined || val === null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return '';
    return (num % 1 !== 0) ? +num.toFixed(3) : num;
}

// ==== Dataset builders, each returning { title, headers, rows } ====

// weeklyMatchWins holds the 1/0.5/0 result in a category league but raw points in a points one, whose real per-week result lives in weeklyMatchResult, so both league types get a genuine record here.
function summarizeTeam(t, start, end) {
    const isPoints = AppState.isPointsLeague;
    let matchWins = 0, points = 0, cWins = 0, w = 0, l = 0, ties = 0;
    for (let wk = start; wk <= end; wk++) {
        const mw = t.weeklyMatchWins[wk];
        if (mw === undefined) continue;
        const result = isPoints ? (t.weeklyMatchResult[wk] || 0) : mw;
        if (isPoints) points += mw;
        matchWins += result;
        cWins += t.weeklyCatWins[wk] || 0;
        if (result === 1) w++; else if (result === 0.5) ties++; else l++;
    }
    return { matchWins, points, cWins, w, l, ties };
}

// Sorted the way the Rankings standings sort them: match wins, then the secondary section's total as a tiebreaker.
function sortedTeamSummaries(start, end) {
    // Roto has no matchups to summarize, so every weekly total is 0 and the order would collapse to alphabetical. Rank by ESPN's own season roto points instead.
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
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);

    // Two columns per category, because the season value alone does not say what it earned and the points alone do not say what produced them.
    if (AppState.isRotoLeague) {
        const sport = document.getElementById('sport').value;
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

    // A single-matchup window cannot make a record, since one game is 1-0 or 0-1 for everyone. Rank by the one number that is real for a single week.
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

// One column per category, one row per team: sums over the timeframe, except rate stats which average across weeks played. Names are deduped as the category checkboxes are.
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
    // Role-grouped columns, batters and skaters before pitchers and goalies, matching the heatmap. availableStatsSet's own order interleaves the two.
    const visibleStats = allStats.filter(s => visibleIds.has(s.id));
    const statById = new Map(visibleStats.map(s => [String(s.id), s]));
    const stats = orderStatIdsByRole(sport, visibleStats.map(s => s.id)).map(id => statById.get(String(id)));

    const summaries = sortedTeamSummaries(start, end);
    const rows = summaries.map(({ team }) => {
        const cells = [team.name];
        stats.forEach(stat => {
            // A roto total is already season-long, with no weeks to sum and no rate stats to average across.
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

// ==== Delivery: file download and clipboard ====

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

function downloadCsv(text, filenameBase) {
    // BOM so Excel opens the file as UTF-8, since names carry accents and emoji.
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

// Appended to the body so no column's overflow can clip it.
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

    // Leaderboard availability is re-checked on every open, because the pool loads in the background even if the Player tab was never clicked.
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

    // Re-wired on every open with onclick, so reopening never stacks duplicate handlers on the same buttons.
    overlay.querySelector('#export-download-btn').onclick = () => {
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        downloadCsv(buildDelimitedText(data.headers, data.rows, ','),
            `${slugify(leagueName)}-${slugify(data.title)}-${year}-${slugify(AppState.timeframe)}`);
        setExportStatus(`Downloaded ${data.rows.length} rows ✓`);
    };
    // Copies TAB-separated text, the one clipboard format that pastes as real columns into Excel, Sheets and chat apps alike. Download still produces a proper .csv.
    overlay.querySelector('#export-copy-btn').onclick = () => {
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        copyText(buildDelimitedText(data.headers, data.rows, '\t'), `Copied ${data.rows.length} rows. Paste into Excel, Sheets, or chat ✓`);
    };

    overlay.classList.add('open');
}
