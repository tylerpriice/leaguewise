// PURE. Renders the team-compare contract (tests/fixtures/team-compare.md, the team half / S22) into My Team's "against" band. No DOM, no AppState, no fetches - everything arrives in `compare` (teamCompare()'s own return, or null) and `opts`, the pattern coverage-band.js and leaderboard-row.js already use.

function resolveOpts(o = {}) {
    return {
        escapeHtml: o.escapeHtml || (s => s),
        // The rate-component table (state.js RATE_COMPONENTS[sport]) and stat labels, read ONLY to build a null cell's hover reason - the contract's own row shape carries no reason field (see the contract's Field notes), so naming WHY a cell is empty is this module's job, off the same table the model itself rebuilds rates from.
        rateComponents: o.rateComponents || [],
        statLabels: o.statLabels || {}
    };
}

function formatCell(value, row) {
    return row.rate ? value.toFixed(3) : String(Math.round(value));
}

// "OPS needs OBP and SLG, which this window does not carry" - the contract's own example, reproduced generically off the rate's component list rather than hand-written per category.
function nullReasonFor(row, o) {
    if (!row.rate) return 'Not carried in this window\'s totals.';
    const comp = o.rateComponents.find(c => String(c.out) === String(row.id));
    if (!comp) return `${row.label} has no formula to rebuild it from in this window.`;
    const partIds = [...new Set(comp.add || [...(comp.num || []), ...(comp.den || [])])];
    const labels = partIds.map(id => o.statLabels[id] || id);
    return `${row.label} needs ${labels.join(' and ')}, which this window does not carry.`;
}

function cellHtml(value, row, side, o) {
    if (value === null) {
        const tip = o.escapeHtml(nullReasonFor(row, o));
        return `<span class="tc-val tc-val-${side} tc-val-none" data-tooltip="${tip}">-</span>`;
    }
    const cls = row.leader === side ? ' tc-win' : (row.leader && row.leader !== 'tied' ? ' tc-lose' : '');
    return `<span class="tc-val tc-val-${side}${cls}">${o.escapeHtml(formatCell(value, row))}</span>`;
}

// The edge chip on the spine, mine minus theirs, arrow pointing at the winner - the same ledger shape the 1v1 player comparison uses (.cmp-edge), so the two read as one convention.
function edgeHtml(row, o) {
    if (row.edge === null) return '<span class="tc-edge tc-edge-none">&mdash;</span>';
    if (row.leader === 'tied') return '<span class="tc-edge tc-edge-tie">even</span>';
    const shown = formatCell(Math.abs(row.edge), row);
    return row.leader === 'mine'
        ? `<span class="tc-edge tc-edge-mine">&larr;&thinsp;${o.escapeHtml(shown)}</span>`
        : `<span class="tc-edge tc-edge-theirs">${o.escapeHtml(shown)}&thinsp;&rarr;</span>`;
}

function rowHtml(row, o) {
    return `<div class="tc-row">
        <span class="tc-cat">${o.escapeHtml(row.label)}${row.lowerIsBetter ? '<span class="tc-inv" title="Lower is better">&darr;</span>' : ''}</span>
        ${cellHtml(row.mine, row, 'mine', o)}
        ${edgeHtml(row, o)}
        ${cellHtml(row.theirs, row, 'theirs', o)}
    </div>`;
}

// COPY CONSEQUENCES (VOICE, the contract's own rule): a projected edge is never printed as a result - "You win HR" claims something that has not happened, so the headline says what it is, "projected to win", never "win". A played window says "winning", which stays true whether the matchup is live or has closed (this module has no way to tell those apart from the contract's own shape, and "winning" never overclaims either way) - never "won", which the contract reserves for a certainty this table cannot promise from `asOf` alone.
function headlineHtml(compare, o) {
    const { window: win, mine, rows } = compare;
    const winning = rows.filter(r => r.leader === 'mine').length;
    const verb = win.kind === 'projected' ? 'projected to win' : 'winning';
    const asOfHtml = (win.kind === 'played' && win.asOf)
        ? ` <span class="tc-asof">as of period ${o.escapeHtml(String(win.asOf))}</span>` : '';
    return `<div class="tc-headline">${o.escapeHtml(mine.name)} ${verb} <strong>${winning}</strong> of ${rows.length}${asOfHtml}</div>`;
}

export function buildTeamCompareHtml(compare, opts) {
    const o = resolveOpts(opts);
    if (!compare) return '';
    // The roster caveat is the surface's, not a footnote's (the contract's own words) - a reader planning three weeks out is exactly the reader who will change the roster this was built from, so it sits right under the headline rather than buried in a tooltip.
    const caveat = compare.window.kind === 'projected'
        ? '<div class="tc-caveat">Projected from today\'s roster - adds, drops and waivers before then are not counted.</div>'
        : '';
    return `<div class="tc-band">
        ${headlineHtml(compare, o)}
        ${caveat}
        <div class="tc-table">${compare.rows.map(r => rowHtml(r, o)).join('')}</div>
    </div>`;
}
