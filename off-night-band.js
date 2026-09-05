// THE NIGHTS BAND. Pure renderer for My Team's off-night surface: hockey only, one band per role group, a cell per night of the current matchup showing how much of the held roster is playing, the thinnest night marked, and a headline sentence naming it. Consumes schedule-insight.js's own rosterNightCoverage() output verbatim (see tests/fixtures/off-night.json, the data lane's own frozen contract); this module owns only how that shape reads. Full rationale: tests/fixtures/off-night-band-view.md. PURITY CONTRACT, same as coverage-band.js/leaderboard-row.js: no imports, no AppState, no DOM, no fetch. escapeHtml/labelOf arrive via opts for the same reason as every other pure renderer in this codebase - the real day-labeller lives beside AppState (dayLabelerFor, probables.js), and this module is not allowed to know AppState exists.
export function escapeHtmlLocal(str) {
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
        labelOf: o.labelOf || (period => String(period)),
    };
}

// The FIRST night in period order whose `playing` equals the round's own minimum. Ties are common on a short round; marking the first keeps the badge singular, matching the headline's own "your lightest night" framing (one night, not a set).
function thinnestPeriod(coverage) {
    const hit = coverage.byPeriod.find(d => d.playing === coverage.thinnest);
    return hit ? hit.period : null;
}

// One night: playing over idle, no other figure on its face - emptySlots is a real, derived fact but a caller-supplied one (null when no slot count was given), so it earns a tone rather than a second number on the cell (see the view contract's own note on this balance).
function dayCellHtml(day, isThinnest, o) {
    const toneCls = (day.emptySlots !== null && day.emptySlots !== undefined && day.emptySlots > 0)
        ? ' nb-day-short' : '';
    const thinCls = isThinnest ? ' nb-day-thinnest' : '';
    return `<div class="nb-day${toneCls}${thinCls}">
        <div class="nb-day-label">${o.escapeHtml(o.labelOf(day.period))}</div>
        <div class="nb-day-count">${day.playing}</div>
        <div class="nb-day-idle">${day.idle} idle</div>
    </div>`;
}

// "Tuesday is your lightest night this round. 2 of 3 are playing." Two sentences, never joined by a colon, dash or semicolon (CONVENTIONS.md's rule, binding on every user-facing string here). The fraction is playing over `players` (the measured roster), not `slots` - stable across bands built with a different capacity, unlike emptySlots. thinnestPeriod always finds a match: it scans the same byPeriod array `coverage.thinnest` was derived from. "Lightest" is the printed word (R4, VOICE.md's ban on "thin"/"thinnest" in sports copy - "no one has ever used thinnest in the context of sports ever"); `thinnest`/`thinnestPeriod`/`nb-day-thinnest` stay as private identifiers, since the ban is on the word a reader sees, not on the name a caller reads.
function headlineHtml(coverage, o) {
    const day = o.escapeHtml(o.labelOf(thinnestPeriod(coverage)));
    const verb = coverage.thinnest === 1 ? 'is' : 'are';
    return `<div class="nb-headline">${day} is your lightest night this round. ${coverage.thinnest} of ${coverage.players} ${verb} playing.</div>`;
}

// Said once, above the nights, only when non-zero - never folded into an idle count. The data contract's own refusal pattern (fills: null over []) applies here too: a fact worth stating exists only when it is true.
function unknownClubHtml(coverage, o) {
    if (!coverage.unknownClub) return '';
    const noun = coverage.unknownClub === 1 ? 'player has' : 'players have';
    return `<div class="nb-note">${coverage.unknownClub} ${noun} no club on this schedule.</div>`;
}

// One role group's band. `coverage` is rosterNightCoverage()'s own return shape verbatim. `roleLabel` names which roster half this call is drawing ("Skaters", "Goalies") - the data contract asks for skaters and goalies separately, so this renderer draws one band per call and the caller places as many side by side as it has groups. Renders nothing at all for a missing coverage, matching coverage-band.js's own rule: a My Team view rendered before the model has anything to say should contribute nothing, not an empty card.
export function buildNightsBandHtml(coverage, roleLabel, opts) {
    if (!coverage || !coverage.byPeriod || !coverage.byPeriod.length) return '';
    const o = resolveOpts(opts);
    // The FIRST tie only (see thinnestPeriod's own comment) - marking every night that shares the round's minimum would turn "your emptiest night" into four badges on a seven-night round.
    const markedPeriod = thinnestPeriod(coverage);
    const days = coverage.byPeriod.map(d => dayCellHtml(d, d.period === markedPeriod, o)).join('');
    return `<div class="nb-band">
        <div class="nb-head">${o.escapeHtml(roleLabel)}</div>
        ${unknownClubHtml(coverage, o)}
        <div class="nb-days">${days}</div>
        ${headlineHtml(coverage, o)}
    </div>`;
}
