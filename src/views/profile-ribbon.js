/**
 * The profile ribbon on My Team: one line of cells with every scored category on it at once, in
 * rank order, so a long category list still fits on a single line at narrow widths.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Contract: tests/fixtures/profile-ribbon.md
 * @module profile-ribbon
 */

function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        formatStatValue: o.formatStatValue || (v => String(v)),
    };
}

function cellHtml(cat, of, o) {
    const t = of > 1 ? (cat.rank - 1) / (of - 1) : 0;
    const tip = `${cat.label} · ${o.formatStatValue(cat.value)} · #${cat.rank} of ${of} · league median ${o.formatStatValue(cat.median)}`;
    return `<span class="pr-cell" style="--pr-t:${t}" data-tooltip="${o.escapeHtml(tip)}">`
        + `<span class="pr-cell-label">${o.escapeHtml(cat.label)}</span>`
        + `<span class="pr-cell-rank">#${cat.rank}</span>`
        + `</span>`;
}

/**
 * Builds the ribbon from categories the caller has already ordered; the order is rendered as given
 * and never re-sorted.
 *
 * @param {Object} model The ribbon's content.
 * @param {number} model.of How many teams the league has.
 * @param {Array<{id: string, label: string, rank: number, value: number, median: number, inverse: boolean}>} model.categories
 *   One per category, rank ascending. The label is printed as given, rank is 1-based with 1 best, and
 *   value and median are formatted for the hover. The inverse flag is carried but not read.
 * @param {Object} [opts] Options.
 * @param {function(*): string} [opts.escapeHtml] The HTML escaper; a built-in one when absent.
 * @param {function(*): string} [opts.formatStatValue] Formats a figure for the hover; String when absent.
 * @returns {string} The markup, or an empty string for an empty category list.
 */
export function buildProfileRibbonHtml(model, opts) {
    const o = resolveOpts(opts);
    const categories = (model && model.categories) || [];
    if (!categories.length) return '';
    const of = model.of;
    const cellsHtml = categories.map(c => cellHtml(c, of, o)).join('');
    return `<div class="pr-ribbon">${cellsHtml}</div>`;
}
