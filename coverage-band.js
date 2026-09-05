// THE CATEGORY COVERAGE BAND. Pure renderer for My Team's coverage band: per scored category, where the roster stands, who drives it, and - for a category being lost - the best available adds and the cheapest roster player to spare. Consumes coverage-model.js's own output verbatim (see tests/fixtures/coverage-band.json, the frozen data contract the data lane already shipped in ad36440); this module owns only how that shape reads. PURITY CONTRACT, same as leaderboard-row.js/lineup-ground.js: no imports, no AppState, no DOM, no fetch. escapeHtml/formatValue arrive via opts for the same reason as every other pure renderer in this codebase - the real formatter lives beside AppState, and this module is not allowed to know AppState exists. WORDS AND COMPONENTS, NEVER ODDS (the owner's own line, coverage-model.js's own header comment). Concretely, in this renderer: - the coverage bar's fill width is the only place `share` (a real, computed fraction) ever shows up, and it carries no numeric label - "beaten of X teams" would need the league's own team count, which this model does not carry, and a bare "50%" is exactly the invented precision the house rule forbids. The bar is a shape, not a stat. - drivers are NAMED, never numbered on the surface (their exact contribution is a hover detail, "detail lives behind the click" per VOICE) - only an add's GAIN is a visible number, because that is the one figure a manager acts on ("would add 9"). - an inverse category says "lower is better" exactly once, beside the category name - never a minus sign, which the model's own sign convention (contributionOf/gainFrom) already spares this module from ever having to print anyway.
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const NO_FIGURE = '-';

// The real formatter (sport-aware: ERA to two places, AVG to three with no leading zero, a counting stat as a bare integer) lives beside AppState and arrives via opts. This fallback is deliberately generic - correct for a demo or a console check, not a claim about any real sport's conventions.
function formatValueLocal(id, value) {
    if (value === null || value === undefined) return NO_FIGURE;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        formatValue: o.formatValue || formatValueLocal,
        // S17b: the BAND's own per-category league rank (teamCategoryProfile, graphs.js), read through the caller rather than recomputed here - "Losing"/"Winning" on the strip and drawer means the same thing the WINS/BLEEDS chips above them already mean, never this model's own share-based `weak` (a different question: is this category a hole worth fixing, not where the team stands in it against the league). `losingIds` null (the caller has no band rank to offer, e.g. these unit tests) falls back to `row.weak` for both functions below, and `rankOf` returning null for every id along with it - a defensible answer with no rank data, not a thrown error.
        losingIds: o.losingIds || null,
        rankOf: o.rankOf || (() => null),
        // R5/S29: the strip's own control IS the toggle now (the drawer's own X is gone, myteam.js's concern) - "Open" when the drawer is closed, "Close" while it is open, so the one button says what clicking it will do rather than only ever inviting a click.
        isOpen: !!o.isOpen,
    };
}

// Whether a row counts as "losing" for the STRIP/DRAWER specifically - the band's own rank when the caller supplied one, `row.weak` (this model's share-based hole) otherwise. See resolveOpts.
function isLosingByRank(row, o) {
    return o.losingIds ? o.losingIds.has(String(row.id)) : row.weak;
}

// R11/S48: whether coverage-model.js actually SEARCHED this row for an add - mirrors that module's own `searched` predicate (coverage-model.js: `holes.has(id) || searchIds.has(id)`) exactly, on the caller's own promise (myteam.js) that `searchIds` and `o.losingIds` are the same set. `row.weak` alone (a model hole) is ALWAYS included, same as the model; `isLosingByRank` alone covers the id `searchIds` added - together this is the union the model computed, not `isLosingByRank` by itself, which drops a weak-but-well-ranked row (present when o.losingIds is set, since that branch ignores `row.weak` entirely) the model unquestionably searched.
function wasSearched(row, o) {
    return row.weak || isLosingByRank(row, o);
}

// Losing first, WORST rank first among them (the team's most severe standing leads); held categories after, BEST rank first (closest to a hole reads before a comfortable lead). A category with no rank (`rankOf` returns null) sorts to the back of its own group - not asserted worse or better than one with a real rank, the same "null sorts back, never first" rule `orderedCategories` above already follows for a null `share`.
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

// A counting category's contribution IS the player's own real total (coverage-model.js's own comment: "for a counting category that is exactly their own figure"), so the shown drivers' sum against the team's own value is a real, trustworthy fact - "Clase and Diaz carry 31 of your 38" is exactly the words-and-components register, not invented precision, and hiding it says less than the band actually knows. A rate's contribution is a marginal delta with no such total to sum into - two pitchers' ERA deltas do not add up to the team ERA, because a rate is not linear in its contributors - so a rate stays named-only, the same as before this ruling. isRate now rides on the row itself (coverage-model.js's own rateSpecFor, landed 575d6cc) - the model already knows which categories it recomputes as a rate, so this renderer reads that answer rather than guessing one from the value's shape. The guess it replaces (Number.isInteger) had a known failure mode - a rate that happens to compute to an exact whole number (an ERA of exactly 3.00, say) would have read as counting and printed a sum that does not actually add up.

// "Clase and Diaz carry 31 of your 38 the rest of the way." (counting) or "Clase and Diaz drive it this matchup." (a rate, or a counting category whose own denominator is unmeasurable). A category nobody on the roster drives is a real, renderable state (a total punt), not an empty line - VOICE's blunt-states rule applies to a silence exactly as much as it does to a number. R4/S28: `denom` is `row.projected` now, never `row.value` (the season's actuals) - a projected driver sum against an actual season total was two different questions in one sentence, exactly the mixed-basis bug the amendment (coverage-band-view.md) exists to fix. `windowLabel` (`band.window.label`, pre-formatted - "the rest of the way" or "this matchup") names the horizon every time, per the amendment's own copy rule; empty when the caller has no window to offer (an older/hand-built band), in which case this reads exactly as it did before the amendment - the fields are additive, so their absence must never change old behaviour.
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

// Every entry in `adds` is a free agent by construction (coverageBand's own `available` argument is documented as "the free agents worth ranking"), so the FA tag is unconditional here rather than a field this module has to check for. The gain is the one number this whole band shows on its surface without qualification - "gains in the category's own units" is the explicit rule. "ADD" IS AMBIGUOUS ON A RATE (ruling, ): the model already sign-flips an inverse rate's gain, so a positive number is always good by the time it reaches this renderer - but "would add 0.031" under ERA reads as making the number bigger, which is the wrong direction whether or not the category is inverse. A rate says "would improve it by", which is true regardless of which way the raw figure moves; a counting category keeps "would add", since a bigger number really is more of it there. R4/S28: `a.gain` is already the model's own projected-remainder figure (coverage-model.js); this renderer's own job is only to say WHICH SPAN it covers, every time, per the amendment's copy rule - "would add 5 the rest of the way", never a bare "would add 5" that reads as a season claim. `windowLabel` empty (an older/hand-built band) renders exactly as before.
function addsHtml(adds, id, isRate, windowLabel, o) {
    const horizon = windowLabel ? ` ${o.escapeHtml(windowLabel)}` : '';
    if (!adds.length) return `<div class="cvb-add cvb-add-none">No available player would move it${horizon}.</div>`;
    const verb = isRate ? 'would improve it by' : 'would add';
    return adds.map(a =>
        `<div class="cvb-add">${o.escapeHtml(a.player.name)} (FA) ${verb} ${o.escapeHtml(o.formatValue(id, a.gain))}${horizon}.</div>`
    ).join('');
}

// The same swap object rides on every weak category in the band (coverageBand computes it once against strongIds, not per category) - shown per row anyway, because the advice is scoped to "if you want to fix THIS category, here is who to spare", which is what the owner's own example sentence does. Two sentences, not one joined by a dash or colon (CONVENTIONS.md's rule against both applies to every user-facing string in this codebase, not only published ones) - the second carries the WHY. A neutral pronoun, since the swap can be anyone on the roster and this codebase defaults to a gender-neutral pronoun when one is not otherwise established. Said ONCE, as a footer under the whole band, not per row. The same swap object rides on every weak category by design (coverageBand computes it once against strongIds, not per category - coverage-band-view.md's own note) - rendering it per row repeated the identical sentence once for every hole the band had, which read as the band stuttering rather than answering. One fact, said where the band ends.
function swapFooterHtml(swap, o) {
    if (!swap) return '';
    return `<div class="cvb-swap-footer">Cheapest to lose: ${o.escapeHtml(swap.player.name)}. They carry the least of what you are winning.</div>`;
}

// WEAK FIRST, WORST SHARE FIRST, then the held categories in the league's own order. A manager opening the band wants what is being lost before what is already held - `coverageBand`'s own order (strongIds first, in the current shipped shape) put two winning categories at the top and the actual holes below the band's internal scroll, which is backwards for the question this band exists to answer. `share === null` (nothing measured yet) sorts to the back of the weak group - not clearly worse than a real, small share, so it is not asserted to be.
function orderedCategories(categories) {
    const weak = categories.filter(r => r.weak);
    const held = categories.filter(r => !r.weak);
    const shareOf = (r) => (r.share === null || r.share === undefined) ? Infinity : r.share;
    weak.sort((a, b) => shareOf(a) - shareOf(b));
    return weak.concat(held);
}

// R4/S28: `value` KEEPS its meaning (the season's actuals - the headline figure and the bar's own share are both unchanged by the amendment), while drivers/adds read `projected` instead - the two bases live side by side in one row, never mixed into one sentence. Falls back to `value` when a row carries no `projected` at all (an older/hand-built row), so the amendment is additive exactly as documented: absent, this renders precisely as it did before it existed.
function projectedDenom(row) {
    return row.projected !== undefined ? row.projected : row.value;
}

// S28b: the headline is the SEASON total (row.value, unchanged by the R4/S28 amendment above) while every sentence under it - drivers, adds - already talks about the remainder (row.projected). A card reading "248" above "carries 12 of your 41 the rest of the way" made the reader do the subtraction themselves to see the two figures agree at all. This sub-figure says the remainder once, right beside the total it is a piece of, in the same horizon language driversLine/addsHtml already use - never a second phrase for the same fact. Empty whenever `projected` itself is absent (no window on the band, or an older/hand-built row): the same additive-not-required rule the amendment's other fields follow.
function remainderSubHtml(row, windowLabel, o) {
    if (row.projected === null || row.projected === undefined) return '';
    const horizon = windowLabel ? ` ${o.escapeHtml(windowLabel)}` : '';
    return `<span class="cvb-value-sub">${o.escapeHtml(o.formatValue(row.id, row.projected))}${horizon}</span>`;
}

// One category row. `share === null` ("a category with no share is carried with its nulls rather than dropped", coverage-model.js's own rule) draws an empty track rather than a zero-width one - zero would claim "you have none of this", where null means "there is nothing to measure yet".
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
    // The swap sentence no longer rides here - it is the same fact on every weak row, said once as the band's own footer instead (see swapFooterHtml, buildCoverageBandHtml below).
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

// The whole band. `band` is coverageBand()'s own return shape verbatim: { categories, strongIds, holeIds }. `statMap` is an id -> display-name map (ESPN_STAT_MAPS[sport]'s own shape), taken as an argument rather than an opt because it is data, not a rendering behaviour - the same split seasons-band.js's statMap argument makes. Renders nothing at all for an empty/missing band, matching seasons-band.js's own rule: a My Team view rendered before the coverage model has anything to say should contribute nothing, not an empty card.
export function buildCoverageBandHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    const windowLabel = band.window?.label || null;
    const ordered = orderedCategories(band.categories);
    const rows = ordered.map(row => categoryRowHtml(row, statMap, windowLabel, o)).join('');
    // The swap object rides on every weak row alike (see orderedCategories' own comment) - any one of them carries the band's whole answer, so the first is as good as any to read it off.
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;
    return `<div class="cvb-band">${rows}${swapFooterHtml(swap, o)}</div>`;
}

// ==== THE STRIP AND THE DRAWER. buildCoverageBandHtml above still exists (a caller may still want the full band inline, and its own sentence builders - driversLine/addsHtml - stay as they were for it); these two read the SAME band, ordered the SAME way, through their OWN chip-based renderers instead - a one-line summary under the roster's own summary band, and a full-detail panel that opens over the roster. tests/fixtures/coverage-band-view.md's own "Strip and drawer" section documents both. K1's whole point (the owner's own words filing item 2): "less confusing... more visual." Every sentence coverage-band.js used to build for these two views is gone - a figure and a bar, or a chip, reads faster than a clause naming the same fact in words. NO SENTENCE ANYWHERE in either view below; the horizon (the window's own label) is named exactly ONCE, in the shared caption, never repeated per figure the way S53 already stopped repeating it per add. ====

// The caption both the strip and the drawer's own header read verbatim - "Coverage · <window> · <N> days left" - built once so the two can never drift into two different readings of the same band. `window.periods` is the SAME day list myteam.js already prices the O55b remainder against (gamesByProTeamForMatchup) - not a second figure computed here, per the "figures from the model as they are" rule - so a band whose window carries no `periods` at all (an older/hand-built one, from before this file's own myteam.js fix) omits the days-left segment rather than inventing one. DAYS, NOT GAMES (the owner's own correction to this pass's first reading): a games count differs per club (a doubleheader, an off day), so "N games left" was never one true number for a whole roster - `periods` is the league's own scoring-period list, one entry per DAY the window spans, which is the figure this caption actually names.
function captionHtml(band, o) {
    const windowLabel = band.window?.label || null;
    const windowHtml = windowLabel ? `<span class="cvs-window">${o.escapeHtml(windowLabel)}</span>` : '';
    const periods = band.window?.periods;
    const daysHtml = Array.isArray(periods) && periods.length
        ? `<span class="cvs-days">${o.escapeHtml(String(periods.length))} days left</span>`
        : '';
    return `<span class="cvs-lab">Coverage</span>${windowHtml}${daysHtml}`;
}

// The drawer's own header caption (myteam.js's `.mt-drawer-head`) - the exact same reading the strip carries, plus "Close" rather than "Open ›" since a caller only shows this header while the drawer is already open. Exported so myteam.js never hand-builds a second copy of the caption text that could drift from the strip's own.
export function buildCoverageDrawerHeadHtml(band, opts) {
    if (!band) return '';
    const o = resolveOpts(opts);
    // Wrapped in one span, not left as sibling spans, so myteam.js's own `.mt-drawer-head` (display:flex; justify-content:space-between, shared with the compare drawer's plain-title header) keeps exactly two children - the caption and the button - rather than spreading each caption segment apart individually.
    return `<span class="mt-drawer-title">${captionHtml(band, o)}</span><button type="button" class="mt-strip-open cvs-open">Close</button>`;
}

// One best-add CHIP per losing category (worst rank first) - `row.adds` is already the model's own best-first list (coverage-model.js), so the first entry IS the best one; the old three-deep shopping list was always a drawer-only concern even before K1, and stays that way (one chip, same simplification the drawer's own bestAddChipHtml below makes). "+", counting or rate: contributionOf/gainFrom (coverage-model.js) already sign-flip an inverse rate's gain, so a positive number is always an improvement by the time it reaches here.
function stripChipHtml(row, statMap, o) {
    const name = (statMap || {})[row.id] || `Stat ${row.id}`;
    if (!row.adds.length) {
        return `<span class="cvs-chip cvs-chip-none">${o.escapeHtml(name)}: no add</span>`;
    }
    const add = row.adds[0];
    return `<span class="cvs-chip"><span class="cvs-chip-player">${o.escapeHtml(add.player.name)}</span><span class="cvs-chip-fa">FA</span><span class="cvs-chip-gain">+${o.escapeHtml(o.formatValue(row.id, add.gain))}</span><span class="cvs-chip-cat">${o.escapeHtml(name)}</span></span>`;
}

// The strip: the shared caption · every best-add chip (worst-ranked losing category first) · a "+N more" indicator, real overflow only · who is cheapest to spare · "Open". A team losing nothing still gets a real line ("Nothing to add this window"), never a hidden strip and never the banned "Nothing to fix." - VOICE's blunt-states rule applies to a team with no holes exactly as it does to one with five. Q13/S54: rebuilt to frame K1 - the caption now names the window's own days-left figure (never shown before this pass), and every add reads as a CHIP (player, FA tag, gain, category) rather than the S53 text clause it replaces. No count of losing categories anywhere on the strip (the owner's own words filing Q13: "we don't need to explain this again") - a reader sees the chips themselves, never a number of how many there are. THE OVERFLOW IS MEASURED, NOT COUNTED HERE (the owner's own correction to this pass's first try, which guessed a fixed chip-count cutoff). This module renders EVERY chip - it has no DOM, so it cannot know how many fit at the caller's own real width - plus one `.cvs-more` element, present but `hidden`, for the caller to reveal with a real count once it has measured which chips actually fit on the strip's one line (myteam.js's `fitCoverageStripChips`, run after every render the same way `wireCoverageDrawer` already re-wires per render). The drawer shows every chip unconditionally - only the strip, with its one-line budget, ever hides one.
export function buildCoverageStripHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    // S17b: "losing" here is the BAND's own rank (o.losingIds), not this model's share-based `weak` - a category the model marks a hole but the band ranks well does not earn a chip on the strip (its adds, if any, are still reachable in the drawer's own card).
    const weak = orderedByRank(band.categories, o).filter(r => isLosingByRank(r, o));
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;

    const chipsHtml = weak.length
        ? weak.map(r => stripChipHtml(r, statMap, o)).join('') + '<span class="cvs-more" hidden>+0 more</span>'
        : `<span class="cvs-chips-empty">Nothing to add this window</span>`;

    const swapHtml = swap ? `<span class="cvs-swap">Cheapest to lose: ${o.escapeHtml(swap.player.name)}</span>` : '';
    const divider = '<span class="cvs-divider" aria-hidden="true"></span>';

    return `<div class="cvs-strip">
        ${captionHtml(band, o)}
        <span class="cvs-chips">${chipsHtml}</span>
        ${swapHtml ? divider + swapHtml : ''}
        <button type="button" class="mt-strip-open cvs-open">${o.isOpen ? 'Close' : 'Open &rsaquo;'}</button>
    </div>`;
}

// "Who carries it": one chip per driver, carrying their OWN remainder contribution when the category is counting - the same figures driversLine used to sum into one sentence, now one chip per player instead of a total. Name-only for a rate (or a category with no denominator to sum into): a rate's contribution has no chip-worthy figure, the same "named only, never numbered" rule this file's own header comment states for drivers generally - unchanged by K1, only its markup is.
function driverChipsHtml(drivers, isRate, id, o) {
    if (!drivers.length) return `<span class="cvd-chips-empty">No one on the roster</span>`;
    return drivers.map(d => {
        const figHtml = isRate ? '' : `<span class="cvd-chip-fig">${o.escapeHtml(o.formatValue(id, d.contribution))}</span>`;
        return `<span class="cvd-chip"><span class="cvd-chip-player">${o.escapeHtml(d.player.name)}</span>${figHtml}</span>`;
    }).join('');
}

// "Best add": the model's own first (best) candidate, one chip - not the pre-K1 up-to-three shopping list; a reader wants the ONE best name, not a ranked menu, per the owner's own "less confusing" complaint that filed this item. FA tag carried the same way the strip's own chip carries it (stripChipHtml, above) - the two chip vocabularies read identically on purpose.
function bestAddChipHtml(adds, id, o) {
    if (!adds.length) return `<span class="cvd-chips-empty">No add found</span>`;
    const add = adds[0];
    return `<span class="cvd-chip cvd-chip-add"><span class="cvd-chip-player">${o.escapeHtml(add.player.name)}</span><span class="cvd-chip-fa">FA</span><span class="cvd-chip-gain">+${o.escapeHtml(o.formatValue(id, add.gain))}</span></span>`;
}

// The banked-against-to-come bar: "276 banked", "+42 to come", "318 season" (the ruling's own example figures) under a two-segment track. `value` IS the banked figure - the season's real ACTUAL total to date (coverage-model.js's own header comment) - read off the model verbatim, never re-derived. `season` is the forward total this bar actually describes: banked plus the O55b remainder (`projected`), what the category is ON PACE for through the window's end, not a number the model carries directly. RATE CATEGORIES DRAW NO BAR. ERA is not banked-plus-to-come the way a sum is - this file's own header comment on drivers already states a rate is not linear in its contributors, and the same fact makes "banked" meaningless for one: there is no partial ERA that adds to the season ERA the way partial home runs add to a season total. A rate (or a row with no projected remainder at all - an older/hand-built band) draws its season figure alone, no bar, no banked/to-come split.
function bankedBarHtml(row, o) {
    const hasSeason = row.value !== null && row.value !== undefined;
    const seasonOnlyHtml = `<div class="cvd-bar-figs cvd-bar-figs-plain"><span class="cvd-bar-season-fig">${hasSeason ? o.escapeHtml(o.formatValue(row.id, row.value)) : NO_FIGURE} season</span></div>`;
    if (row.rate || !hasSeason) return seasonOnlyHtml;
    if (row.projected === null || row.projected === undefined) return seasonOnlyHtml;

    // S54c (the owner's own correction): `value` IS the banked figure - the actual season total to date (coverage-model.js's own header comment: "value... is the season ACTUAL") - not a whole this bar splits INTO banked-plus-to-come. `season` is the FORWARD total this bar actually describes: what has already happened plus what is still projected to, banked + projected. S54's first pass read `value` as that forward total and subtracted the remainder out of it, which double-counted nothing but named the wrong number "season".
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

// One drawer card: the category and its BAND rank badge (danger/success - same source as buildCoverageStripHtml's "losing" set, S17b), the banked-against-to-come bar, "who carries it" and - for a category the MODEL considers a hole, or the band ranks losing (wasSearched, R11/S48's own union) - "best add". No sentence anywhere: every fact from here down is a figure, a bar, or a chip.
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

// The drawer's body: every category as a card, losing first (worst BAND RANK first, S17b) then the held categories muted (best rank first), plus the same swap footer the pre-K1 drawer carried (untouched by this rebuild - it is one footer for the whole drawer, not a per-category sentence, and the ruling's "no sentence anywhere" scopes to what a card itself says). The caller (myteam.js) wraps this in the drawer's own header (buildCoverageDrawerHeadHtml, above), which is layout, not this module's concern.
export function buildCoverageDrawerHtml(band, statMap, opts) {
    if (!band || !band.categories || !band.categories.length) return '';
    const o = resolveOpts(opts);
    const ordered = orderedByRank(band.categories, o);
    const cards = ordered.map(row => categoryCardHtml(row, statMap, o)).join('');
    const swap = (band.categories.find(r => r.swap) || {}).swap || null;
    return `${cards}${swapFooterHtml(swap, o)}`;
}
