/**
 * Renders My Team's category coverage band: per scored category, where the roster stands, who drives it and, for a category being lost, the best available adds and the cheapest player to spare.
 *
 * Pure. No imports, no application state, no DOM, no fetches. The HTML escaper and the value formatter arrive through the options, because the real formatter lives beside the application state.
 *
 * It reads in words and components, never odds: the coverage bar is a shape with no numeric label, drivers are named rather than numbered, and only an add's gain is a visible number.
 *
 * Contract: tests/fixtures/coverage-band-view.md
 * @module coverage-band
 */
/**
 * @typedef {Object} CoverageRow One category in the band, as the coverage model returns it.
 * @property {(string|number)} id The stat id.
 * @property {?number} value The season total to date.
 * @property {number} [projected] The projected remainder over the band's window.
 * @property {?number} share Where the roster sits in the category as a fraction, null when nothing is measured.
 * @property {boolean} weak True when the model counts the category as a hole.
 * @property {boolean} inverse True when a lower figure is better.
 * @property {boolean} rate True when the category is a rate, not a count.
 * @property {Array<{player: {name: string}, contribution: number}>} drivers The roster players behind the figure.
 * @property {Array<{player: {name: string}, gain: number}>} adds Free agents who would move it, best first.
 * @property {?{player: {name: string}}} swap The cheapest roster player to spare.
 * @property {?{drop: {name: string}, add: {name: string}, saving: number}} [pair] The swap an inverse counting category draws.
 */
/**
 * @typedef {Object} CoverageBand The coverage model's return shape.
 * @property {CoverageRow[]} categories One row per scored category.
 * @property {Array<(string|number)>} [strongIds] The categories held.
 * @property {Array<(string|number)>} [holeIds] The categories lost.
 * @property {{kind: string, label: string, periods: Array}} [window] The span the projections cover.
 */
/**
 * @typedef {Object} CoverageOpts Rendering options; every field is optional.
 * @property {function(*): string} [escapeHtml] HTML escaper, defaulting to escapeHtmlLocal.
 * @property {function((string|number), ?number): string} [formatValue] Sport-aware figure formatter.
 * @property {?Set<string>} [losingIds] The band's own losing categories; the model's weak flag stands in when null.
 * @property {function((string|number)): ?{rank: number}} [rankOf] The band's rank for a category, or null.
 * @property {boolean} [isOpen] True while the drawer is open, which changes the strip's control label.
 * @property {?Object} [modeState] The drawer's mode row state.
 * @property {?Array} [ranked] The ranked adds for the current mode.
 * @property {?function(Object): ?string} [posOf] Position text for a player.
 * @property {?{primary: {label: ?string, ids: Array}, secondary: {label: ?string, ids: Array}}} [roleGroups] The roster's role split.
 * @property {?Object} [drop] The drop-for mode's inputs and ledger.
 * @property {function(*): string} [teamNameOf] Names a rival team by id.
 */
/**
 * Escapes the five HTML-significant characters; the fallback when the caller supplies no escaper.
 *
 * @param {*} str The value to escape, stringified first.
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

const NO_FIGURE = '-';

// The real formatter is sport-aware (ERA to two places, a counting stat as an integer) and arrives through the options. This fallback is generic, correct for a demo or a console check.
function formatValueLocal(id, value) {
    if (value === null || value === undefined) return NO_FIGURE;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        formatValue: o.formatValue || formatValueLocal,
        // The band's own per-category rank is read through the caller, so Losing and Winning on the strip and drawer mean what the chips above them mean. Without it the model's share-based weak flag stands in and every rank is null.
        losingIds: o.losingIds || null,
        rankOf: o.rankOf || (() => null),
        // The strip's control is the toggle, so its label says what pressing it will do.
        isOpen: !!o.isOpen,
        // The drawer's mode row and ranked table belong to the caller. Absent, the drawer draws as it did without them.
        modeState: o.modeState || null,
        ranked: o.ranked || null,
        posOf: o.posOf || null,
        // The roster's role split, such as batters then pitchers, is computed by the caller because the sport is application state this module may not read. Null renders one unbroken list.
        roleGroups: o.roleGroups || null,
        // The drop-for mode's inputs, and how to name a rival in a standing sentence. A caller that does not opt in draws none of it.
        drop: o.drop || null,
        teamNameOf: o.teamNameOf || ((id) => `Team ${id}`),
    };
}

// A stable partition into role sections. Each section keeps the order the caller produced, and a single-role sport renders one list with no headers.
function roleGroupedHtml(items, idOf, roleGroups, o, renderGroup) {
    if (!roleGroups || !roleGroups.secondary || !roleGroups.secondary.ids.length) {
        return renderGroup(items);
    }
    const secondaryIds = new Set(roleGroups.secondary.ids.map(String));
    const primaryItems = items.filter(x => !secondaryIds.has(String(idOf(x))));
    const secondaryItems = items.filter(x => secondaryIds.has(String(idOf(x))));
    const headHtml = (label) => label ? `<div class="cvd-role-head">${o.escapeHtml(label)}</div>` : '';
    return (primaryItems.length ? headHtml(roleGroups.primary && roleGroups.primary.label) + renderGroup(primaryItems) : '')
        + (secondaryItems.length ? headHtml(roleGroups.secondary.label) + renderGroup(secondaryItems) : '');
}

// Whether a row counts as losing for the strip and drawer: the band's own rank when supplied, the model's weak flag otherwise.
function isLosingByRank(row, o) {
    return o.losingIds ? o.losingIds.has(String(row.id)) : row.weak;
}

// Mirrors the model's own search predicate, the union of its holes and the losing set it was asked to search. The rank test alone would drop a weak but well-ranked row the model did search.
function wasSearched(row, o) {
    return row.weak || isLosingByRank(row, o);
}

// Losing categories lead, worst rank first, then held ones, best rank first. A category with no rank sorts to the back of its group rather than being called better or worse.
function orderedByRank(categories, o) {
    const losing = categories.filter(r => isLosingByRank(r, o));
    const held = categories.filter(r => !isLosingByRank(r, o));
    const rankOf = (r) => { const info = o.rankOf(r.id); return info ? info.rank : null; };
    const worstFirst = (a, b) => {
        const ra = rankOf(a), rb = rankOf(b);
        if (ra === null && rb === null) return 0;
        if (ra === null) return 1;
        if (rb === null) return -1;
        return rb - ra;
    };
    const bestFirst = (a, b) => {
        const ra = rankOf(a), rb = rankOf(b);
        if (ra === null && rb === null) return 0;
        if (ra === null) return 1;
        if (rb === null) return -1;
        return ra - rb;
    };
    losing.sort(worstFirst);
    held.sort(bestFirst);
    return losing.concat(held);
}

function oxford(parts) {
    return parts.length > 2
        ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
        : parts.join(' and ');
}

// A counting category's contribution is the player's own total, so a driver sum against the team's value is a real fact. A rate's contributions do not add up, so a rate names its drivers with no sum, and the row's own rate flag decides which.

// Names the drivers and, for a counting category, how much of the projected total they carry. The denominator is the projected remainder, never the season actuals, so one sentence never mixes two bases, and the window label names the horizon.
function driversLine(drivers, denom, isRate, id, windowLabel, o) {
    const horizon = windowLabel ? ` ${o.escapeHtml(windowLabel)}` : '';
    if (!drivers.length) return `No one on the roster drives it${horizon}.`;
    const names = drivers.map(d => o.escapeHtml(d.player.name));
    const verb = drivers.length === 1 ? 'drives' : 'drive';
    if (isRate || denom === null || denom === undefined) return `${oxford(names)} ${verb} it${horizon}.`;
    const sum = drivers.reduce((s, d) => s + d.contribution, 0);
    const carryVerb = drivers.length === 1 ? 'carries' : 'carry';
    return `${oxford(names)} ${carryVerb} ${o.escapeHtml(o.formatValue(id, sum))} of your ${o.escapeHtml(o.formatValue(id, denom))}${horizon}.`;
}

// Every add is a free agent by construction, so the tag is unconditional. A rate says 'would improve it by' because 'add' reads as the number growing, while a counting category keeps 'would add'. The window label says which span the gain covers.
function addsHtml(adds, id, isRate, windowLabel, o) {
    const horizon = windowLabel ? ` ${o.escapeHtml(windowLabel)}` : '';
    if (!adds.length) return `<div class="cvb-add cvb-add-none">No available player would move it${horizon}.</div>`;
    const verb = isRate ? 'would improve it by' : 'would add';
    return adds.map(a =>
        `<div class="cvb-add">${o.escapeHtml(a.player.name)} (FA) ${verb} ${o.escapeHtml(o.formatValue(id, a.gain))}${horizon}.</div>`
    ).join('');
}

// The swap is said once, as the band's footer, because the same swap rides on every weak category. A null swap is a real state when every candidate carries a losing category, so a measured band says nobody is spare and an unmeasured one stays silent.
function swapFooterHtml(swap, hasMeasured, o) {
    if (swap) return `<div class="cvb-swap-footer">Cheapest to lose: ${o.escapeHtml(swap.player.name)}. Carries the least of what you are projected to produce, and none of what you are losing.</div>`;
    if (hasMeasured) return `<div class="cvb-swap-footer">Nobody here is spare - everyone is carrying something you are losing.</div>`;
    return '';
}

// Shares the measured test with the sort, so the footer's null check and the band's order agree on what measured means.
function hasMeasuredCategory(categories) {
    return (categories || []).some(r => r.share !== null && r.share !== undefined);
}

// Weak categories first, smallest share first, then held ones in the league's order, because a manager wants what is being lost before what is held. A null share sorts to the back of the weak group.
function orderedCategories(categories) {
    const weak = categories.filter(r => r.weak);
    const held = categories.filter(r => !r.weak);
    const shareOf = (r) => (r.share === null || r.share === undefined) ? Infinity : r.share;
    weak.sort((a, b) => shareOf(a) - shareOf(b));
    return weak.concat(held);
}

// The value keeps its season-actuals meaning while drivers and adds read the projected remainder. A row with no projected figure falls back to the value.
function projectedDenom(row) {
    return row.projected !== undefined ? row.projected : row.value;
}

// The remainder is shown beside the season total it is a piece of, in the same horizon wording as the sentences below, so the reader does not subtract. It is empty when the row has no projected figure.
function remainderSubHtml(row, windowLabel, o) {
    if (row.projected === null || row.projected === undefined) return '';
    const horizon = windowLabel ? ` ${o.escapeHtml(windowLabel)}` : '';
    return `<span class="cvb-value-sub">${o.escapeHtml(o.formatValue(row.id, row.projected))}${horizon}</span>`;
}

// A null share draws an empty track rather than a zero-width one, because zero would claim the team has none of this category.
function categoryRowHtml(row, statMap, windowLabel, o) {
    const name = (statMap || {})[row.id] || `Stat ${row.id}`;
    const hasShare = row.share !== null && row.share !== undefined;
    const pct = hasShare ? Math.max(0, Math.min(100, row.share * 100)) : 0;
    const toneCls = row.weak ? ' dm-cov-bad' : ' dm-cov-good';
    const trackCls = hasShare ? '' : ' cvb-track-none';
    const fillWidth = hasShare ? Math.max(3, pct) : 0;
    const inverseNote = row.inverse ? `<span class="cvb-inverse-note">lower is better</span>` : '';
    const valueCls = row.value === null ? ' cvb-value-none' : '';
    const rowCls = row.weak ? 'cvb-row cvb-row-weak' : 'cvb-row cvb-row-strong';
    // The swap sentence is not drawn per row, since it is the same fact on every weak row and the footer says it once.
    const bottomHtml = row.weak
        ? `<div class="cvb-adds">${addsHtml(row.adds, row.id, row.rate, windowLabel, o)}</div>`
        : '';
    return `<div class="${rowCls}">
        <div class="cvb-head">
            <span class="cvb-cat-name">${o.escapeHtml(name)}</span>${inverseNote}
            <span class="cvb-value-wrap">
                <span class="cvb-value${valueCls}">${o.escapeHtml(o.formatValue(row.id, row.value))}</span>${remainderSubHtml(row, windowLabel, o)}
            </span>
        </div>
        <div class="dm-cov-track${trackCls}"><div class="dm-cov-fill${toneCls}" style="width:${fillWidth}%"></div></div>
        <div class="cvb-drivers">${driversLine(row.drivers, projectedDenom(row), row.rate, row.id, windowLabel, o)}</div>
        ${bottomHtml}
    </div>`;
}

/**
 * Builds the whole inline band: one row per category, weak ones first, and a single swap footer. The stat map is data, so it is an argument and not an option. An empty or missing band renders nothing rather than an empty card.
 *
 * @param {?CoverageBand} band The coverage model's return value.
 * @param {Object<string, string>} statMap Stat names by id.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The band markup, or an empty string for an empty or missing band.
 */
export function buildCoverageBandHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    const windowLabel = band.window?.label || null;
    const ordered = orderedCategories(band.categories);
    const rows = ordered.map(row => categoryRowHtml(row, statMap, windowLabel, o)).join('');
    // The same swap rides on every weak row, so the first one found is the band's whole answer.
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;
    return `<div class="cvb-band">${rows}${swapFooterHtml(swap, hasMeasuredCategory(band.categories), o)}</div>`;
}

// ==== The strip and the drawer ====

// The caption shared by the strip and the drawer header, built once so they cannot drift. A matchup window names itself, while a season-end window does not, because the days-left figure already says how much remains. The count is days, not games, since games differ by club, and the word left is used only for a window already under way.
function captionHtml(band, o) {
    const kind = band.window?.kind;
    const windowLabel = kind === 'matchup' ? (band.window.label || null) : null;
    const windowHtml = windowLabel ? `<span class="cvs-window">${o.escapeHtml(windowLabel)}</span>` : '';
    const periods = band.window?.periods;
    const daysHtml = Array.isArray(periods) && periods.length
        ? `<span class="cvs-days">${o.escapeHtml(String(periods.length))} days${kind === 'matchup' ? '' : ' left'}</span>`
        : '';
    return `<span class="cvs-lab">Coverage</span>${windowHtml}${daysHtml}`;
}

/**
 * Builds the drawer header's caption and its Close button. Exported so the caller never hand-builds a second copy of the caption that could drift from the strip's.
 *
 * @param {CoverageBand} band The coverage band.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The header markup, or an empty string when there is no band.
 */
export function buildCoverageDrawerHeadHtml(band, opts) {
    if (!band) return '';
    const o = resolveOpts(opts);
    // Wrapped in one span so the caller's flex header keeps exactly two children, the caption and the button.
    return `<span class="mt-drawer-title">${captionHtml(band, o)}</span><button type="button" class="mt-strip-open cvs-open">Close</button>`;
}

// One chip per losing category, from the model's best-first list. An inverse counting category never says no add, since nobody adds a player for errors; it draws the swap pair, or nothing when none exists. An inverse row that is not a rate is the test, because a row without a pair looks the same either way.
function swapChipHtml(pair, name, o) {
    return `<span class="cvs-chip cvs-chip-swap"><span class="cvs-chip-swap-tag">Swap</span> `
        + `<span class="cvs-chip-drop">${o.escapeHtml(pair.drop.name)}</span> `
        + `<span class="cvs-chip-arrow">&rarr;</span> `
        + `<span class="cvs-chip-player">${o.escapeHtml(pair.add.name)}</span>`
        + `<span class="cvs-chip-fa">FA</span>`
        + `<span class="cvs-chip-gain">&minus;${o.escapeHtml(o.formatValue(name.id, pair.saving))}</span>`
        + `<span class="cvs-chip-cat">${o.escapeHtml(name.label)}</span></span>`;
}

function stripChipHtml(row, statMap, o) {
    const name = (statMap || {})[row.id] || `Stat ${row.id}`;
    if (row.inverse && !row.rate) {
        return row.pair ? swapChipHtml(row.pair, { id: row.id, label: name }, o) : '';
    }
    if (!row.adds.length) {
        return `<span class="cvs-chip cvs-chip-none">${o.escapeHtml(name)}: no add</span>`;
    }
    const add = row.adds[0];
    return `<span class="cvs-chip"><span class="cvs-chip-player">${o.escapeHtml(add.player.name)}</span><span class="cvs-chip-fa">FA</span><span class="cvs-chip-gain">+${o.escapeHtml(o.formatValue(row.id, add.gain))}</span><span class="cvs-chip-cat">${o.escapeHtml(name)}</span></span>`;
}

/**
 * Builds the one-line strip: the shared caption, a best-add chip per losing category, who is cheapest to spare and the Open control. Every chip is rendered with one hidden overflow element, because this module cannot measure how many fit and the caller reveals the real count. A team losing nothing still gets a line.
 *
 * @param {CoverageBand} band The coverage band.
 * @param {Object<string, string>} statMap Stat names by id.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The strip markup, or an empty string when there is no band.
 */
export function buildCoverageStripHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    // Losing here is the band's own rank, so a category the model calls a hole but the band ranks well earns no chip. Its adds stay in the drawer.
    const weak = orderedByRank(band.categories, o).filter(r => isLosingByRank(r, o));
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;

    const chipsHtml = weak.length
        ? weak.map(r => stripChipHtml(r, statMap, o)).join('') + '<span class="cvs-more" hidden>+0 more</span>'
        : `<span class="cvs-chips-empty">Nothing to add this window</span>`;

    // Cheapest to lose is a plain fact on the strip and not a button, because opening the drawer is the one way in.
    const swapHtml = swap
        ? `<span class="cvs-swap">Cheapest to lose: ${o.escapeHtml(swap.player.name)}</span>`
        : '';
    const divider = '<span class="cvs-divider" aria-hidden="true"></span>';

    return `<div class="cvs-strip">
        ${captionHtml(band, o)}
        <span class="cvs-chips">${chipsHtml}</span>
        ${swapHtml ? divider + swapHtml : ''}
        <button type="button" class="mt-strip-open cvs-open">${o.isOpen ? 'Close' : 'Open &rsaquo;'}</button>
    </div>`;
}

// One chip per driver, with the player's own remainder contribution for a counting category and the name alone for a rate, whose contribution has no figure worth a chip.
function driverChipsHtml(drivers, isRate, id, o) {
    if (!drivers.length) return `<span class="cvd-chips-empty">No one on the roster</span>`;
    return drivers.map(d => {
        const figHtml = isRate ? '' : `<span class="cvd-chip-fig">${o.escapeHtml(o.formatValue(id, d.contribution))}</span>`;
        return `<span class="cvd-chip"><span class="cvd-chip-player">${o.escapeHtml(d.player.name)}</span>${figHtml}</span>`;
    }).join('');
}

// The model's first candidate as one chip, with the same FA tag as the strip's chip so the two read alike.
function bestAddChipHtml(adds, id, o) {
    if (!adds.length) return `<span class="cvd-chips-empty">No add found</span>`;
    const add = adds[0];
    return `<span class="cvd-chip cvd-chip-add"><span class="cvd-chip-player">${o.escapeHtml(add.player.name)}</span><span class="cvd-chip-fa">FA</span><span class="cvd-chip-gain">+${o.escapeHtml(o.formatValue(id, add.gain))}</span></span>`;
}

// The banked and to-come bar. The value is the banked total to date and the season figure is banked plus the projected remainder. A rate draws its season figure alone, since a rate has no banked part that adds up to a season value.
function bankedBarHtml(row, o) {
    const hasSeason = row.value !== null && row.value !== undefined;
    const seasonOnlyHtml = `<div class="cvd-bar-figs cvd-bar-figs-plain"><span class="cvd-bar-season-fig">${hasSeason ? o.escapeHtml(o.formatValue(row.id, row.value)) : NO_FIGURE} season</span></div>`;
    if (row.rate || !hasSeason) return seasonOnlyHtml;
    if (row.projected === null || row.projected === undefined) return seasonOnlyHtml;

    // The value is the banked total to date, not a whole the bar splits, so the season figure is banked plus the projection.
    const banked = row.value;
    const season = banked + row.projected;
    const bankedPct = season > 0 ? Math.max(0, Math.min(100, (banked / season) * 100)) : 0;
    const tocomePct = season > 0 ? Math.max(0, Math.min(100 - bankedPct, (row.projected / season) * 100)) : 0;
    return `<div class="cvd-bar-track">
        <div class="cvd-bar-banked" style="width:${bankedPct}%"></div>
        <div class="cvd-bar-tocome" style="width:${tocomePct}%"></div>
    </div>
    <div class="cvd-bar-figs">
        <span class="cvd-bar-banked-fig">${o.escapeHtml(o.formatValue(row.id, banked))} banked</span>
        <span class="cvd-bar-tocome-fig">+${o.escapeHtml(o.formatValue(row.id, row.projected))} to come</span>
        <span class="cvd-bar-season-fig">${o.escapeHtml(o.formatValue(row.id, season))} season</span>
    </div>`;
}

// One card per category: the rank badge, the banked bar, who carries it and, where the model or the band ranks the category as a hole, the best add. No sentences, only figures, bars and chips.
function categoryCardHtml(row, statMap, o) {
    const name = (statMap || {})[row.id] || `Stat ${row.id}`;
    const losing = isLosingByRank(row, o);
    const toneCls = losing ? ' cvd-card-bad' : ' cvd-card-good cvd-card-muted';
    const badgeCls = losing ? 'cvd-badge-bad' : 'cvd-badge-good';
    const rank = o.rankOf(row.id);
    const badgeLabel = (losing ? 'Losing' : 'Winning') + (rank ? ` #${o.escapeHtml(String(rank.rank))}` : '');
    const inverseNote = row.inverse ? `<span class="cvb-inverse-note">lower is better</span>` : '';
    const addsGroupHtml = wasSearched(row, o) ? `<div class="cvd-chip-group">
            <span class="cvd-chip-lab">Best add</span>
            <span class="cvd-chip-row">${bestAddChipHtml(row.adds, row.id, o)}</span>
        </div>` : '';
    return `<div class="cvd-card${toneCls}">
        <div class="cvd-card-head">
            <span class="cvd-card-name">${o.escapeHtml(name)}</span>
            <span class="cvd-badge ${badgeCls}">${badgeLabel}</span>${inverseNote}
        </div>
        ${bankedBarHtml(row, o)}
        <div class="cvd-chip-group">
            <span class="cvd-chip-lab">Who carries it</span>
            <span class="cvd-chip-row">${driverChipsHtml(row.drivers, row.rate, row.id, o)}</span>
        </div>
        ${addsGroupHtml}
    </div>`;
}

// ==== The drawer's mode row and ranked table ====
const COMPOSITE_NOTE = "Composite: each gain as a share of the league's range in that category, summed.";
const MODE_LABELS = [
    ['one', 'One category'],
    ['all', 'All-round'],
    ['holes', 'My holes'],
    ['pick', 'Pick categories'],
    ['drop', 'Drop for']
];

// A signed figure written as the chips write one: a plus on a gain, a plain hyphen on a loss and a bare hyphen when the category has no figure for the player. Dashes and minus signs are avoided because published text refuses them.
function gainCellHtml(value, id, o) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '<span class="cvd-add-none">-</span>';
    }
    // The sign follows what is printed, not the raw number. A gain that rounds to 0 would otherwise read as +0, an improvement the figure beside it does not support.
    const shown = String(o.formatValue(id, Math.abs(value)));
    if (Number(shown) === 0) return '<span class="cvd-add-none">0</span>';
    const cls = value > 0 ? 'cvd-add-up' : 'cvd-add-dn';
    return `<span class="${cls}">${value > 0 ? '+' : '-'}${o.escapeHtml(shown)}</span>`;
}

// The composite is a sum of shares of a range, so it is a percentage of nothing in particular. The note under the table explains it, and it is never shown without the note.
function compositeText(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const pct = v * 100;
    return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%`;
}

// Every category is drawn and none is clickable outside Pick, so the picker's slot is never hollow. A category the model refuses to rank is struck through rather than hidden, and My holes is inert because the losing set is the caller's. One category never calls this.
function pickerHtml(m, statMap, o) {
    const picked = m.picked || new Set();
    const inert = m.mode !== 'pick';
    const chipFor = (id) => {
        const key = String(id);
        const dead = !!(m.unrankableIds && m.unrankableIds.has(key));
        // On only means something for My holes and Pick categories, since the other modes have no category selection to reflect.
        const on = !dead && (m.mode === 'holes'
            ? !!(m.losingIds && m.losingIds.has(key))
            : m.mode === 'pick' ? picked.has(key) : false);
        const cls = ['cvd-pick-cat', dead ? 'cvd-pick-dead' : '', on ? 'cvd-pick-on' : ''].filter(Boolean).join(' ');
        const label = (statMap || {})[key] || `Stat ${key}`;
        return `<button type="button" class="${cls}" data-pick-cat="${o.escapeHtml(key)}"${dead || inert ? ' disabled' : ''}>${o.escapeHtml(label)}</button>`;
    };
    // Grouped by role like the roster, where the chips ran as one unbroken row before.
    const chips = roleGroupedHtml(m.ids || [], id => id, o.roleGroups, o,
        group => group.map(chipFor).join(''));
    return `<span class="cvd-pick${inert ? ' cvd-pick-inert' : ''}">${chips}</span>`;
}

/**
 * Builds the mode row: the label, the modes, the picker and what the table is drawn from.
 *
 * @param {?Object} modeState The drawer's mode state: mode, picked, unrankableIds, losingIds, ids and sourceLabel.
 * @param {Object<string, string>} statMap Stat names by id.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The row markup, or an empty string when there is no mode state.
 */
export function buildAddsModeRowHtml(modeState, statMap, opts) {
    if (!modeState) return '';
    const o = resolveOpts(opts);
    const m = modeState;
    const segs = MODE_LABELS.map(([key, label]) =>
        `<button type="button" class="cvd-mode${m.mode === key ? ' cvd-mode-on' : ''}" data-adds-mode="${key}">${o.escapeHtml(label)}</button>`
    ).join('');
    const source = m.sourceLabel ? `<span class="cvd-modes-src">${o.escapeHtml(m.sourceLabel)}</span>` : '';
    // The picker's slot is always in the row so the table's top does not move between the ranked modes. Drop for and One category are exempt, since neither has a picker to draw and an empty box nobody reads is not worth the row.
    const pickSlot = (m.mode === 'drop' || m.mode === 'one') ? '' : `<div class="cvd-pick-slot">${pickerHtml(m, statMap, o)}</div>`;
    return `<div class="cvd-modes">
        <span class="cvd-modes-lab">Best add for</span>
        <span class="cvd-seg">${segs}</span>
        ${pickSlot}
        ${source}
    </div>`;
}

// A position list of three or more would wrap and grow its one row past the others, so past two the rest folds to a count. The full list stays in the cell's title.
function abbreviatePositions(pos) {
    const parts = String(pos).split('/').filter(Boolean);
    if (parts.length <= 2) return pos;
    return `${parts.slice(0, 2).join('/')} +${parts.length - 2}`;
}

/**
 * Builds one ranked table over the chosen set: the player with an FA tag, the position, the composite and one raw gain per category. An empty set and an empty result are different answers, since no category picked is a question nobody asked and no candidate is a search that found nobody.
 *
 * @param {?Array} ranked The model's ranked adds, each with player, gains and composite.
 * @param {Array<(string|number)>} ids The categories the table covers.
 * @param {Object<string, string>} statMap Stat names by id.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The table markup, or an empty-state message.
 */
export function buildRankedAddsHtml(ranked, ids, statMap, opts) {
    const o = resolveOpts(opts);
    const set = (ids || []).map(String);
    if (!set.length) return `<div class="cvd-adds-empty">Pick a category to rank free agents by.</div>`;
    const rows = ranked || [];
    if (!rows.length) return `<div class="cvd-adds-empty">No free agent improves this set.</div>
        <div class="cvd-adds-note">${o.escapeHtml(COMPOSITE_NOTE)}</div>`;
    const head = set.map(id => `<th>${o.escapeHtml((statMap || {})[id] || `Stat ${id}`)}</th>`).join('');
    const body = rows.map((r, i) => {
        const p = r.player || {};
        const cells = set.map(id => `<td>${gainCellHtml(r.gains ? r.gains[id] : null, id, o)}</td>`).join('');
        const pos = o.posOf ? o.posOf(p) : null;
        const name = p.name || 'Unknown';
        return `<tr class="cvd-adds-row${i === 0 ? ' cvd-adds-top' : ''}">
            <td class="cvd-adds-name" title="${o.escapeHtml(name)}"><span class="cvd-adds-nm">${o.escapeHtml(name)}</span><span class="cvd-adds-fa">FA</span></td>
            <td class="cvd-adds-pos"${pos ? ` title="${o.escapeHtml(pos)}"` : ''}>${pos ? o.escapeHtml(abbreviatePositions(pos)) : ''}</td>
            <td class="cvd-adds-comp">${o.escapeHtml(compositeText(r.composite))}</td>
            ${cells}
        </tr>`;
    }).join('');
    // A wide set scrolls inside its own box. The composite sits with the name in the sticky left group, so the figure the table is sorted by never scrolls away.
    return `<div class="cvd-adds-scroll"><table class="cvd-adds">
        <thead><tr><th class="cvd-adds-name">Player</th><th class="cvd-adds-pos">Pos</th><th class="cvd-adds-comp">Composite</th>${head}</tr></thead>
        <tbody>${body}</tbody>
    </table></div>
    <div class="cvd-adds-note">${o.escapeHtml(COMPOSITE_NOTE)}</div>`;
}

// A pair card names a player or an empty slot, never nothing, so the two-card shape is never one card short. The select is the fast path and the search is a wider door to the same pick; only its empty results shelf is drawn here, and the caller fills it.
function pairCardHtml(role, changeId, player, choices, o, searchPool) {
    const body = player
        ? `<div class="cvx-card-name">${o.escapeHtml(player.name)}</div>
           <div class="cvx-card-meta">${[player.teamName, player.positionDisplay].filter(Boolean).map(t => o.escapeHtml(t)).join(' &middot; ')}</div>`
        : `<div class="cvx-card-empty">Pick a candidate</div>`;
    const options = (choices || []).map(c =>
        `<option value="${o.escapeHtml(String(c.id))}"${player && String(player.id) === String(c.id) ? ' selected' : ''}>${o.escapeHtml(c.name)}</option>`
    ).join('');
    const searchHtml = searchPool ? `<div class="cvx-search-wrap">
        <input type="text" class="cvx-search" data-drop-search="${changeId}" placeholder="Search free agents&hellip;" autocomplete="off">
        <div class="cvx-search-results" data-drop-results="${changeId}" hidden></div>
    </div>` : '';
    return `<div class="cvx-card">
        <div class="cvx-card-role">${o.escapeHtml(role)}</div>
        ${searchHtml}
        ${body}
        <select class="cvx-change" data-drop-select="${changeId}">
            <option value="">${role === 'Drop' ? 'Choose a player' : 'Pick a candidate'}</option>
            ${options}
        </select>
    </div>`;
}

// The standing sentence names the team just passed or fallen behind when a rank moves, and reads the cushion or deficit alone when it holds. A gap that rounds to 0 would read as a change for no reason, so it gets one more decimal and then under 1.
function marginGapText(gap, id, o) {
    const abs = Math.abs(gap);
    const rounded = o.formatValue(id, abs);
    if (Number(rounded) !== 0 || abs === 0) return o.escapeHtml(String(rounded));
    const finer = abs.toFixed(1);
    return Number(finer) === 0 ? 'under 1' : o.escapeHtml(finer);
}

function standingSentenceFor(cat, teamNameOf, o) {
    const { rankBefore, rankAfter, marginBefore, margin } = cat;
    if (rankBefore === null || rankAfter === null) return null;
    const by = (m) => m ? marginGapText(m.gap, cat.id, o) : null;
    if (rankAfter < rankBefore) {
        const passed = marginBefore && marginBefore.gap < 0 ? marginBefore.teamId : (margin ? margin.teamId : null);
        const gap = by(margin);
        return (passed !== null && gap !== null) ? `passes ${o.escapeHtml(teamNameOf(passed))} by ${gap}` : 'moves up';
    }
    if (rankAfter > rankBefore) {
        const gap = by(margin);
        return (margin && gap !== null) ? `falls behind ${o.escapeHtml(teamNameOf(margin.teamId))} by ${gap}` : 'falls back';
    }
    if (margin && margin.gap > 0) {
        const grows = !marginBefore || margin.gap > marginBefore.gap;
        return `lead ${grows ? 'grows' : 'shrinks'} to ${by(margin)}`;
    }
    if (margin && margin.gap < 0) {
        return `trails ${o.escapeHtml(teamNameOf(margin.teamId))} by ${by(margin)}`;
    }
    return null;
}

// Drop, add and change are rounded independently, so a row could read drop 0, add 12, change +11. A counting figure that formats whole while its real value is not prints one more decimal, and a rate keeps the caller's formatter.
function ledgerLineText(value, id, o) {
    if (value === null || value === undefined) return NO_FIGURE;
    const shown = o.formatValue(id, value);
    const finer = (Number.isInteger(Number(shown)) && !Number.isInteger(value)) ? value.toFixed(1) : shown;
    return o.escapeHtml(String(finer));
}

// The number printed is the raw delta and the colour is the scored change, so this cell keeps the two apart. An error saved shows a minus and reads as good.
function ledgerChangeCellHtml(delta, change, id, o) {
    if (delta === null || delta === undefined || !Number.isFinite(delta)) {
        return '<span class="cvd-add-none">-</span>';
    }
    const shown = ledgerLineText(Math.abs(delta), id, o);
    if (Number(shown) === 0) return '<span class="cvd-add-none">0</span>';
    const cls = change > 0 ? 'cvd-add-up' : (change < 0 ? 'cvd-add-dn' : '');
    return `<span class="${cls}">${delta > 0 ? '+' : '-'}${shown}</span>`;
}

function ledgerRowHtml(cat, statMap, o) {
    const name = (statMap || {})[cat.id] || `Stat ${cat.id}`;
    const rankArrow = (cat.rankBefore !== null && cat.rankAfter !== null)
        ? `#${cat.rankBefore} &rarr; #${cat.rankAfter}` : NO_FIGURE;
    const sentence = standingSentenceFor(cat, o.teamNameOf, o);
    const standing = sentence ? `${rankArrow} &middot; ${sentence}` : rankArrow;
    return `<tr class="cvx-row${cat.inverse ? ' cvx-row-inverse' : ''}">
        <th scope="row" class="cvx-cat">${o.escapeHtml(name)}${cat.inverse ? '<span class="cmpN-inv" title="Lower is better">&darr;</span>' : ''}</th>
        <td class="cvx-cell">${ledgerLineText(cat.dropLine, cat.id, o)}</td>
        <td class="cvx-cell">${ledgerLineText(cat.addLine, cat.id, o)}</td>
        <td class="cvx-cell">${ledgerChangeCellHtml(cat.delta, cat.change, cat.id, o)}</td>
        <td class="cvx-cell cvx-standing">${standing}</td>
    </tr>`;
}

// The bottom line reads gained, lost and unchanged, plus the place either side of the move when the caller supplied one. The place is null in a head-to-head league, where a drop cannot move a record.
function ledgerSummaryHtml(summary, o) {
    const { gained, lost, unchanged, placeBefore, placeAfter } = summary;
    const parts = [`Gained ${gained.length}`, `lost ${lost.length}`, `unchanged ${unchanged}`];
    let placeText = '';
    if (placeBefore !== null && placeAfter !== null) {
        placeText = placeBefore === placeAfter
            ? ` Overall stays #${placeAfter}.`
            : ` Overall #${placeBefore} &rarr; #${placeAfter}.`;
    }
    return `<div class="cvx-summary">${parts.join(', ')}.${placeText}</div>`;
}

function buildDropForHtml(drop, statMap, o) {
    if (!drop) return `<div class="cmp-pick-empty">Pick a roster player to drop.</div>`;
    const cards = `<div class="cvx-pair">
        ${pairCardHtml('Drop', 'drop', drop.dropPlayer, drop.rosterChoices, o)}
        <span class="cvx-arrow" aria-hidden="true">&rarr;</span>
        ${pairCardHtml('Add', 'candidate', drop.candidate, drop.candidateChoices, o, drop.searchPool)}
    </div>`;
    if (!drop.dropPlayer) return `${cards}<div class="cmp-pick-empty">Pick a roster player to drop.</div>`;
    if (!drop.ledger) return `${cards}<div class="cmp-pick-empty">Pick a candidate to see the ledger.</div>`;
    // Every scored category, grouped under the roster's own role labels as in the card list and the ranked table, rewritten for a table body where a group heading is a row.
    const rg = o.roleGroups;
    const cats = drop.ledger.categories;
    const rowsOf = (list) => list.map(cat => ledgerRowHtml(cat, statMap, o)).join('');
    const headRow = (label) => label ? `<tr class="cvx-role-head"><td colspan="5">${o.escapeHtml(label)}</td></tr>` : '';
    let rows;
    if (rg && rg.secondary && rg.secondary.ids.length) {
        const secondaryIds = new Set(rg.secondary.ids.map(String));
        const primary = cats.filter(c => !secondaryIds.has(String(c.id)));
        const secondary = cats.filter(c => secondaryIds.has(String(c.id)));
        rows = (primary.length ? headRow(rg.primary && rg.primary.label) + rowsOf(primary) : '')
            + (secondary.length ? headRow(rg.secondary.label) + rowsOf(secondary) : '');
    } else {
        rows = rowsOf(cats);
    }
    return `${cards}
    <div class="cvx-ledger-scroll"><table class="cvx-ledger">
        <thead><tr><th class="cvx-cat">Category</th><th class="cvx-cell">Drop</th><th class="cvx-cell">Add</th><th class="cvx-cell">Change</th><th class="cvx-standing">Standing</th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>
    ${ledgerSummaryHtml(drop.ledger.summary, o)}`;
}

/**
 * Builds the drawer body: every category as a card, losing first, then held ones muted, plus the swap footer. The caller wraps it in the drawer header.
 *
 * @param {CoverageBand} band The coverage band.
 * @param {Object<string, string>} statMap Stat names by id.
 * @param {CoverageOpts} [opts] Rendering options.
 * @returns {string} The body markup, or an empty string when there is no band.
 */
export function buildCoverageDrawerHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    const m = o.modeState;
    // The mode row appears only for a caller that opted in, so earlier callers get the drawer they had. One category is that old drawer, with the cards as what the mode means.
    const modes = m ? buildAddsModeRowHtml(m, statMap, o) : '';
    if (m && m.mode === 'drop') {
        // The mode row stays put while the ledger scrolls under it, so they are wrapped together and the stylesheet hands scrolling to the ledger for this mode alone.
        return `<div class="cvx-drop-wrap">${modes}${buildDropForHtml(o.drop, statMap, o)}</div>`;
    }
    if (m && m.mode && m.mode !== 'one') {
        return `${modes}${buildRankedAddsHtml(o.ranked, m.rankIds, statMap, o)}`;
    }
    const ordered = orderedByRank(band.categories, o);
    const cards = roleGroupedHtml(ordered, r => r.id, o.roleGroups, o,
        group => group.map(row => categoryCardHtml(row, statMap, o)).join(''));
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;
    return `${modes}${cards}${swapFooterHtml(swap, hasMeasuredCategory(band.categories), o)}`;
}
