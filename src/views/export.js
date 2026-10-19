/**
 * CSV and clipboard export of the dashboard's core tables. Three datasets, each exported as configured rather than as a fixed dump: league standings and category totals over the shared timeframe, and the player leaderboard exactly as the Player Metrics table shows it (group tab, search, position filter, sort, Minimum Games toggle and timeframe).
 *
 * Formats are a CSV file download, or tab-separated text on the clipboard, which pastes into a spreadsheet as columns. The text builders take application state in and give plain rows out, and are unit tested in tests/features.test.html. The whole-league archive rows are built through the archive module.
 *
 * @module export
 */
/**
 * @typedef {Object} ExportDataset A table ready to be written as delimited text.
 * @property {string} title The dataset's name, used in the file name.
 * @property {string[]} headers The column headers.
 * @property {Array<Array<(string|number)>>} rows One array of cells per row.
 */

import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS } from '../data/state.js';
import { getTimeframeBounds, splitScoredAdvanced, escapeHtml, orderStatIdsByRole, axisUnit, parseTimeframe, debugContextFor } from './utils.js';
import { buildLeaderboardExportModel } from './players.js';
import { buildArchive, csvOf } from '../data/archive.js';
import { buildZip } from '../data/zip.js';

// ==== Pure text builders ====

/**
 * Quotes a cell for any delimiter, RFC 4180 style. A cell is quoted only when it contains the delimiter, a quote or a line break, and embedded quotes double. A null or undefined value becomes an empty cell, never the text null.
 *
 * @param {*} value The cell value.
 * @param {string} delimiter The delimiter in use, such as a comma or a tab.
 * @returns {string} The cell text, quoted when needed.
 */
export function delimitedCell(value, delimiter) {
    const s = (value === undefined || value === null) ? '' : String(value);
    return (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

/**
 * Joins a header row and data rows into delimited text with CRLF line endings, the one line break every spreadsheet application accepts for CSV and what RFC 4180 specifies.
 *
 * @param {string[]} headers The column headers.
 * @param {Array<Array<*>>} rows The data rows.
 * @param {string} [delimiter] The delimiter; a comma by default.
 * @returns {string} The delimited text.
 */
export function buildDelimitedText(headers, rows, delimiter = ',') {
    return [headers, ...rows]
        .map(row => row.map(cell => delimitedCell(cell, delimiter)).join(delimiter))
        .join('\r\n');
}

/**
 * Names the current shared timeframe with its resolved range, for the export modal's subtitle and the file name. The unit follows the league type like every graph axis, so a roto export says weeks and never matchups.
 *
 * @returns {string} The label, such as 'Last 4 Matchups (Matchups 5-8)'.
 */
export function timeframeLabel() {
    const tf = AppState.timeframe;
    const { start, end } = getTimeframeBounds(tf, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const unit = axisUnit();
    const names = { all: 'Regular Season + Playoffs', reg: 'Regular Season', p_all: 'Playoffs' };
    // Both halves are named, so an export of the last 4 of the regular season says exactly that and does not hide one of the two.
    const { span, window: n, matchup } = parseTimeframe(tf);
    const spanName = names[span] || span;
    // The span is named only when it narrows things. "Last 4 Matchups" already means the last four of the season, and repeating "Regular Season + Playoffs" after it says nothing.
    const qualifier = span === 'all' ? '' : `, ${spanName}`;
    // A picked matchup is named by its own number, not called current. It parses as a one-matchup window, which day-by-day surfaces want, but a file name wants the number, and start is where it landed after the span clamped it.
    const base = matchup ? `${unit.long} ${start}${qualifier}`
        : n === 1 ? `Current ${unit.long}${qualifier}`
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

// Dataset builders, each returning { title, headers, rows }.

// Sums a team's weekly values over the timeframe into a match record and match wins for every league, plus points for or category wins. A points league keeps its real per-week result in weeklyMatchResult, so both league types get a genuine record and the points total is not mistaken for a win count.
function summarizeTeam(t, start, end) {
    const isPoints = AppState.isPointsLeague;
    let matchWins = 0, points = 0, cWins = 0, w = 0, l = 0, ties = 0;
    for (let wk = start; wk <= end; wk++) {
        const mw = t.weeklyMatchWins[wk];
        if (mw === undefined) continue;
        if (isPoints) points += mw;
        // A playoff bye scored points but played nobody, so it counts toward points for and toward no record.
        if (t.weeklyBye?.[wk]) continue;
        // A week with no result is not a loss. In a points league the result lives in weeklyMatchResult and is withheld for an unplayed week, and treating that absence as 0 would take the loss branch and read an unplayed league as 0-1-0.
        const result = isPoints ? t.weeklyMatchResult[wk] : mw;
        if (result === undefined) continue;
        matchWins += result;
        cWins += t.weeklyCatWins[wk] || 0;
        if (result === 1) w++; else if (result === 0.5) ties++; else l++;
    }
    return { matchWins, points, cWins, w, l, ties };
}

// Teams sort the way the Rankings standings sort them: match wins first, then points for in a points league or category wins otherwise, so equal records do not order arbitrarily.
function sortedTeamSummaries(start, end) {
    // Roto has no matchups to summarize, so every weekly total is 0 and the order would collapse to alphabetical. Ranking by ESPN's own season roto points matches the standings view.
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

/**
 * Builds the League Standings dataset over the shared timeframe: a roto league's season points and per-category values, a single matchup's one real number, or a record with match wins and points or category wins.
 *
 * @returns {ExportDataset} The Standings dataset.
 */
export function buildStandingsExport() {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // Roto standings are ESPN's own numbers: the season total, then each scored category's season value beside the roto points it awarded. Two columns per category, because the value alone does not say what it earned.
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

    // A single-matchup window cannot make a record, since one game is 1-0 or 0-1 for everyone, so teams rank by the one real number for a week and there are no W-L columns.
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

/**
 * Builds one column per category and one row per team, the same values Category Rankings plots: sums over the timeframe, except rate stats, which average across weeks played. Names are de-duplicated as the category checkboxes do, so a name reused across ids does not become two identical columns.
 *
 * @param {string} sport The loaded sport.
 * @param {boolean} includeAdvanced True to include the unscored stats.
 * @returns {ExportDataset} The Category Totals dataset.
 */
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
    // Role-grouped columns, batting or skaters before pitching or goalies, as on the heatmap and every other surface, since the available stats' own order interleaves them.
    const visibleStats = allStats.filter(s => visibleIds.has(s.id));
    const statById = new Map(visibleStats.map(s => [String(s.id), s]));
    const stats = orderStatIdsByRole(sport, visibleStats.map(s => s.id)).map(id => statById.get(String(id)));

    const summaries = sortedTeamSummaries(start, end);
    const rows = summaries.map(({ team }) => {
        const cells = [team.name];
        stats.forEach(stat => {
            // A roto total is already season-long, with no weeks to sum or rate stats to average, and it is the number ESPN ranks the category on.
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

/**
 * Builds the Player Leaderboard dataset from the Player Metrics table's current configuration.
 *
 * @param {boolean} includeAdvanced True to include the unscored stats.
 * @returns {?ExportDataset} The dataset, or null while the player data is unavailable.
 */
export function buildLeaderboardExport(includeAdvanced) {
    const model = buildLeaderboardExportModel(includeAdvanced);
    if (!model) return null;
    return { title: 'Player Leaderboard', headers: model.headers, rows: model.rows };
}

// The league archive: the raw kinds Download All already zips, read through the debug context with no second fetch and repackaged through the archive module into a portable file.

// The archive's five raw slots, and the debug kind each maps to (archive.md's own table).
const ARCHIVE_RAW_KINDS = { league: 'team', pool: 'player-pool', weekly: 'player-weekly', draft: 'draft-detail', rosters: 'roster-days' };
// The ESPN view each slot came from (api.js's own fetch URLs), named in provenance.sources so a reader can tell what a payload IS without recognising its shape (archive.md).
const ARCHIVE_SOURCES = { league: 'mTeam+mMatchupScore+mSettings+mBoxscore', pool: 'kona_player_info', weekly: 'kona_player_info', draft: 'mDraftDetail', rosters: 'mRoster' };

function currentRawArchiveParts() {
    const raw = {};
    Object.entries(ARCHIVE_RAW_KINDS).forEach(([slot, kind]) => {
        const payload = debugContextFor(kind);
        if (payload) raw[slot] = payload;
    });
    return raw;
}

// The extension's manifest version is passed by the caller, because the archive module never reads a file. getURL reads the same manifest in the installed add-on and in the dev stub, and the result is cached since it never changes within a session.
let manifestVersionPromise = null;
function extensionVersion() {
    if (!manifestVersionPromise) {
        manifestVersionPromise = fetch(browser.runtime.getURL('manifest.json'))
            .then(r => r.json()).then(m => m.version || '0.0.0').catch(() => '0.0.0');
    }
    return manifestVersionPromise;
}

// Building the archive costs about 150 to 200 ms against the largest weekly capture measured, so it is built eagerly when the modal opens and reused by both rows.
async function buildCurrentArchive() {
    const version = await extensionVersion();
    const year = AppState.apiData.seasonId;
    const raw = currentRawArchiveParts();
    const sources = Array.from(new Set(Object.keys(raw).map(slot => ARCHIVE_SOURCES[slot]).filter(Boolean)));
    return buildArchive({
        raw: { [year]: raw },
        provenance: { extensionVersion: version, sport: AppState.loadedSport, leagueId: AppState.apiData.id, sources }
    });
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The three CSVs plus the normalised summary, zipped, for a spreadsheet. It holds everything a reader can open without this extension and none of the raw payloads a spreadsheet cannot read.
function buildSummaryZip(archive, year) {
    const encoder = new TextEncoder();
    const season = archive.seasons[String(year)];
    const files = [
        { name: 'summary.json', bytes: encoder.encode(JSON.stringify(season ? season.summary : {}, null, 2)) },
        { name: 'standings.csv', bytes: encoder.encode(csvOf(archive, year, 'standings')) },
        { name: 'categories.csv', bytes: encoder.encode(csvOf(archive, year, 'categories')) },
        { name: 'draft.csv', bytes: encoder.encode(csvOf(archive, year, 'draft')) }
    ];
    return buildZip(files, new Date());
}

function downloadBytes(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
                <button type="button" class="export-action-btn export-action-primary" id="export-download-btn">⬇ Download</button>
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

// Datasets registered from elsewhere. A tab that owns its own model registers here instead of being imported, so the dependency points one way, since importing the builder would close a cycle between the two files. The merge, not replace, shape matches registerLeagueView in utils.js.
const extraDatasets = new Map();

/**
 * Registers or updates a dataset the export modal offers beyond the three built-in ones.
 *
 * @param {string} key The dataset's key; an existing key is merged into.
 * @param {{label: string, note: string, emptyNote: string, available: function(): boolean, build: function(): ExportDataset}} dataset The dataset's fields.
 * @returns {void}
 */
export function registerExportDataset(key, dataset) {
    extraDatasets.set(key, { ...(extraDatasets.get(key) || {}), ...dataset });
}

/**
 * Opens the export modal for the loaded league, building the archive once so each archive row can show its size.
 *
 * @returns {Promise<void>} Resolves once the modal is populated; does nothing when no league is loaded.
 */
export async function openExportModal() {
    if (!AppState.apiData) return;
    const overlay = ensureExportModal();
    // Both describe the league being exported, so both come off the loaded payload and not the form. A dropdown the user has since moved would otherwise label the export and its file with a sport and season the rows do not belong to.
    const sport = AppState.loadedSport;
    const year = String(AppState.apiData.seasonId || document.getElementById('year').value);
    const leagueName = AppState.apiData.settings?.name || 'league';

    overlay.querySelector('#export-modal-subtitle').textContent =
        `${leagueName} • ${year} • ${timeframeLabel()}`;

    // The archive is built once per open, before either archive row is drawn, so each row can print its real size before the click. A failure disables the two archive rows with a plain reason and leaves the other datasets working.
    let fullArchive = null, fullBytes = 0, summaryZipBytes = null, summaryBytes = 0, archiveError = null;
    try {
        fullArchive = await buildCurrentArchive();
        fullBytes = new TextEncoder().encode(JSON.stringify(fullArchive)).length;
        summaryZipBytes = buildSummaryZip(fullArchive, year);
        summaryBytes = summaryZipBytes.length;
    } catch (err) {
        archiveError = err;
        console.error('Failed to build the league archive for export:', err);
    }

    // Leaderboard availability is re-checked on every open, since the pool loads in the background and is usually ready even if the Player tab was never clicked.
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
        },
        // Each registered dataset decides for itself whether it has anything to offer this league.
        ...Array.from(extraDatasets.entries()).map(([key, d]) => ({
            key,
            label: d.label,
            note: d.available && d.available() ? d.note : d.emptyNote,
            enabled: !!(d.available && d.available())
        })),
        // The whole-league exports come last and apart from the per-view rows, because they carry the league itself and follow neither the timeframe nor any filter.
        {
            key: 'archive-summary', label: 'Summary for a spreadsheet',
            note: archiveError
                ? 'Could not be built for this league right now.'
                : `Standings, category totals and the draft as CSVs, plus a JSON summary - opens in a spreadsheet, not back in Leaguewise. ~${formatBytes(summaryBytes)}.`,
            enabled: !archiveError
        },
        {
            key: 'archive-full', label: 'Full archive',
            note: archiveError
                ? 'Could not be built for this league right now.'
                : `Everything fetched for this league, for a league you are about to lose - opens back in Leaguewise later, no ESPN needed. ~${formatBytes(fullBytes)}.`,
            enabled: !archiveError
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
        const extra = extraDatasets.get(key);
        if (extra) return extra.build();
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
        const key = overlay.querySelector('input[name="export-dataset"]:checked')?.value;
        // The two archive rows are a file already built when the modal opened, not the headers and rows shape, so they download whole and skip the delimited-text builder, which is for a table.
        if (key === 'archive-full') {
            downloadBytes(new TextEncoder().encode(JSON.stringify(fullArchive)),
                `leaguewise-${slugify(leagueName)}-${year}.json`, 'application/json');
            return setExportStatus(`Downloaded the full archive (${formatBytes(fullBytes)}) ✓`);
        }
        if (key === 'archive-summary') {
            downloadBytes(summaryZipBytes, `leaguewise-${slugify(leagueName)}-${year}-summary.zip`, 'application/zip');
            return setExportStatus(`Downloaded the summary archive (${formatBytes(summaryBytes)}) ✓`);
        }
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        downloadCsv(buildDelimitedText(data.headers, data.rows, ','),
            `${slugify(leagueName)}-${slugify(data.title)}-${year}-${slugify(AppState.timeframe)}`);
        setExportStatus(`Downloaded ${data.rows.length} rows ✓`);
    };
    // One Copy button copies tab-separated text, the one clipboard format that pastes as real columns into Excel, Sheets and chat apps, since comma-separated text lands in a single column. Download still produces a proper.csv file. The archive rows are files, so Copy says so and does not do nothing silently.
    overlay.querySelector('#export-copy-btn').onclick = () => {
        const key = overlay.querySelector('input[name="export-dataset"]:checked')?.value;
        if (key === 'archive-full' || key === 'archive-summary') {
            return setExportStatus('This one is a file, not clipboard text - use Download.', true);
        }
        const data = buildSelected();
        if (!data) return setExportStatus('That dataset isn\'t available yet.', true);
        copyText(buildDelimitedText(data.headers, data.rows, '\t'), `Copied ${data.rows.length} rows. Paste into Excel, Sheets, or chat ✓`);
    };

    overlay.classList.add('open');
}
