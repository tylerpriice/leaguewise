/**
 * The Seasons band for Player Metrics' drill-down: one row per historical season for the open
 * player, ranked through the unchanged rank engine against that season's own qualified pool and
 * never against this league's rosters.
 *
 * Pure. This module imports nothing and never touches application state, the DOM or the network.
 * The seasons, the stat-name map and the options all arrive as arguments, and the escaper is an
 * option so the module stays unit-testable without a DOM.
 *
 * Contract: tests/fixtures/retro-seasons.md
 * @module seasons-band
 */
/**
 * @typedef {Object} SeasonRow One retro-scored season of one player.
 * @property {number} seasonId The season's year.
 * @property {?number} rank The rank in that season's pool, or null when the player played but was not ranked.
 * @property {boolean} [tied] Whether the rank is shared.
 * @property {number} total The size of the pool the rank is out of.
 * @property {number} games Games played.
 * @property {Object<string, number>} [percentiles] Percentile by stat id, already inverse-aware, 0 to 100.
 */
/**
 * Escapes a value for use in HTML text and attributes.
 *
 * @param {*} str The value.
 * @returns {string} The escaped text.
 */
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// An ordinal reads as a measured fact where a percent reads as a probability; this is a small copy of the draft view's own, to stay out of application state.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// A dash rather than a blank cell for a played-but-unranked season, so the row has a reason for having no figure.
const DASH = String.fromCharCode(8212);

// Percentiles are already inverse-aware, so no sign flipping happens here; the thresholds match the draft view's coverage bars on a 0 to 100 scale.
const GOOD_PERCENTILE = 70;
const BAD_PERCENTILE = 35;

// Bars are drawn only for ids present in this row's percentiles, filtered from the league-order list, because an older season can lack a category and a fixed set would draw an empty bar for it.
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
        // Divs, not spans, because an inline span ignores the width and height that make the fill readable.
        return `<div class="sb-bar-track" title="${title}"><div class="sb-bar-fill${tone}" style="width:${Math.max(3, pct)}%"></div></div>`;
    }).join('');

    return `<div class="sb-row">
        <span class="sb-year">${row.seasonId}</span>
        ${rankHtml}
        <span class="sb-games">${row.games} game${row.games === 1 ? '' : 's'}</span>
        <div class="sb-bars">${barsHtml}</div>
    </div>`;
}

/**
 * Builds the band. Nothing at all is rendered, no header and no empty card, when there are no seasons.
 *
 * @param {?SeasonRow[]} seasons The rows, ascending by season.
 * @param {?Object<string, string>} statMap Display names by stat id.
 * @param {Object} [opts] Options.
 * @param {function(*): string} [opts.escapeHtml] The HTML escaper; a built-in one when absent.
 * @param {string[]} [opts.categoryOrder] This player's role group's scored stat ids in league order; the row's own key order when absent.
 * @returns {string} The markup, or an empty string when there are no seasons.
 */
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
