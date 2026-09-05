// THE SEASONS BAND. One row per historical season for the player open in the Player Metrics drill-down, retro-ranked through the UNCHANGED rank engine against that season's own qualified pool - never against this league's rosters, which for a season before the league existed did not exist yet (see tests/fixtures/retro-seasons.md, the frozen contract this module renders). PURITY CONTRACT, same as rank-engine.js: this module imports nothing and never touches AppState, the DOM, or the network. Everything it needs arrives as arguments - the seasons array, a stat-id -> display-name map, and an options bag. escapeHtml is taken as an option rather than imported from utils.js, because utils.js imports state.js (the AppState singleton), which would drag an impure dependency into a module whose whole reason to exist is being directly unit-testable without a DOM or a league loaded (tests/seasons-band.test.js). A local fallback is defined below so a caller that doesn't care about that distinction (the fixture staging page, a quick console check) doesn't have to supply one.
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// "82nd percentile" reads as a measured fact; "82%" reads as a probability, which it is not. Matches draft-view.js's own ordinal() exactly - kept as a second small copy rather than an import, for the same reason escapeHtml is taken as a parameter above (draft-view.js is deep in AppState and the DOM).
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// A dash rather than a blank cell, via character code rather than a typed glyph - matches draft-view.js's DASH constant and its dr-noproj/dr-cat-none cells exactly. The "played but not ranked" case (rank engine excluded the player below its minimum-playing-time gate, contract case 3) needs the same "here's a real row, here's why it has no figure" treatment those cells give a missing projection, not an invented rank and not a hidden row.
const DASH = String.fromCharCode(8212);

// Percentile-bar tone thresholds. Percentiles from the rank engine are already inverse-aware (a low GAA scores a HIGH percentile), so no per-category sign-flipping happens here - matches the share thresholds the Draft tab's dm-cov coverage bars use (0.7/0.35 of the comparison pool), restated on the 0-100 percentile scale the retro contract already hands us.
const GOOD_PERCENTILE = 70;
const BAD_PERCENTILE = 35;

// One season row: year, rank (or the not-ranked dash), games, then the mini percentile bars. categoryOrder is the caller's league-order list of stat ids for this player's role group (skater or goalie) - needed because `percentiles` is a plain object, and this codebase already knows Object.keys reorders integer-like keys to ascending numeric order regardless of insertion order (see splitStatIdsByRole in utils.js), which would silently scramble "league order" for any league whose scoring-item order isn't already numeric. Bars are drawn ONLY for the ids actually present in THIS row's percentiles, filtered from categoryOrder rather than iterated from it - an era gap (contract case 5) means some categories are not in an older season's row, and a fixed set would draw an empty bar for each one instead of omitting it.
function seasonRowHtml(row, statMap, escape, categoryOrder) {
    const percentiles = row.percentiles || {};
    const ids = (categoryOrder || Object.keys(percentiles)).filter(id => percentiles[id] !== undefined && percentiles[id] !== null);

    const rankHtml = row.rank === null
        ? `<span class="sb-rank sb-rank-none" title="${escape('not ranked this season')}">${DASH}</span>`
        : `<span class="sb-rank">Ranked <strong class="sb-rank-figure">${row.tied ? 'T' : '#'}${row.rank}</strong> of ${row.total}</span>`;

    const barsHtml = ids.map(id => {
        const pct = Math.round(percentiles[id]);
        const name = statMap[id] || `Stat ${id}`;
        const tone = pct >= GOOD_PERCENTILE ? ' sb-bar-fill-good' : (pct <= BAD_PERCENTILE ? ' sb-bar-fill-bad' : '');
        const title = escape(`${name}: ${ordinal(pct)} percentile`);
        // Divs, not spans - a span is display:inline, which ignores the width/height that make the fill readable at all (matches dm-cov-track/dm-cov-fill, both divs for the same reason).
        return `<div class="sb-bar-track" title="${title}"><div class="sb-bar-fill${tone}" style="width:${Math.max(3, pct)}%"></div></div>`;
    }).join('');

    return `<div class="sb-row">
        <span class="sb-year">${row.seasonId}</span>
        ${rankHtml}
        <span class="sb-games">${row.games} game${row.games === 1 ? '' : 's'}</span>
        <div class="sb-bars">${barsHtml}</div>
    </div>`;
}

// The band itself. Renders nothing at all - no header, no empty card - when there are no seasons to show, which today is ALWAYS (AppState.retroSeasons doesn't exist until the engine lane lands it), so a guarded call in players.js contributes nothing to the drill-down and the existing view stays byte-identical. opts: escapeHtml - escape function for interpolated strings (default: the local copy above) categoryOrder - this player's role group's scored stat ids, in league order (see seasonRowHtml's comment). Falls back to each row's own object-key order, which is fine for a sport whose stat ids already sort numerically but is NOT a substitute for the real league order - pass it once it's available.
export function buildSeasonsBandHtml(seasons, statMap, opts = {}) {
    if (!seasons || !seasons.length) return '';
    const escape = opts.escapeHtml || escapeHtmlLocal;
    const map = statMap || {};
    const rows = seasons.map(row => seasonRowHtml(row, map, escape, opts.categoryOrder)).join('');
    return `<div class="sb-band lh-block">
        <div class="lh-block-head">Seasons</div>
        <div class="sb-rows">${rows}</div>
    </div>`;
}
