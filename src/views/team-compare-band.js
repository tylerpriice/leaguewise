/**
 * Renders the team-compare model into My Team's "against" band: a headline, an optional workload
 * header, one row per category and an optional week-by-week strip of probable starts.
 *
 * Pure. Nothing here touches the DOM, application state or the network; everything arrives in the
 * model and the options.
 *
 * Contract: tests/fixtures/team-compare.md
 * @module team-compare-band
 */

// Fills every option with a default so the renderers below never test for an absent one.
function resolveOpts(o = {}) {
    return {
        escapeHtml: o.escapeHtml || (s => s),
        // The matchup chance's finished model (matchup-face.js), or null. The band draws from it and computes nothing.
        face: o.face || null,
        // Read only to explain why a rate cell is empty; the model's rows carry no reason of their own.
        rateComponents: o.rateComponents || [],
        statLabels: o.statLabels || {},
        // The role word on the games tile, which differs by sport; an absent option keeps "Hitter".
        workloadWord: o.workloadWord === undefined ? 'Hitter' : o.workloadWord,
        // The two labels the group divider names, in the words the tabs use.
        groupLabels: o.groupLabels || null
    };
}

function formatCell(value, row) {
    return row.rate ? value.toFixed(3) : String(Math.round(value));
}

// Names the missing components of a rate so a dash can say why it is a dash.
function nullReasonFor(row, o) {
    if (!row.rate) return 'Not carried in this window\'s totals.';
    const comp = o.rateComponents.find(c => String(c.out) === String(row.id));
    if (!comp) return `${row.label} has no formula to rebuild it from in this window.`;
    const partIds = [...new Set(comp.add || [...(comp.num || []), ...(comp.den || [])])];
    const labels = partIds.map(id => o.statLabels[id] || id);
    return `${row.label} needs ${labels.join(' and ')}, which this window does not carry.`;
}

// One decimal, with a whole number printed without the ".0".
function formatPoints(v) {
    return String(Number(Number(v).toFixed(1)));
}

// A side's points sit beside its value; a missing figure prints nothing, never a zero.
function ptsHtml(row, side, o) {
    const pts = side === 'mine' ? row.minePoints : row.theirPoints;
    if (pts === null || pts === undefined) return '';
    return `<small class="tc-pts">${o.escapeHtml(formatPoints(pts))}</small>`;
}

function cellHtml(value, row, side, o, isPts = false) {
    if (value === null) {
        const tip = o.escapeHtml(nullReasonFor(row, o));
        return `<span class="tc-val tc-val-${side} tc-val-none" data-tooltip="${tip}">-</span>`;
    }
    const cls = row.leader === side ? ' tc-win' : (row.leader && row.leader !== 'tied' ? ' tc-lose' : '');
    const shown = o.escapeHtml(formatCell(value, row));
    const pts = isPts ? ptsHtml(row, side, o) : '';
    // Mine reads points then value so the points sit on the spine side; theirs reads the other way round.
    return `<span class="tc-val tc-val-${side}${cls}">${side === 'mine' ? `${pts}${shown}` : `${shown}${pts}`}</span>`;
}

// The swing marker is drawn only for a measured "close", never for an absent measurement.
const SWING_HTML = '<span class="tc-swing">swing</span>';

// The edge chip on the spine, mine minus theirs, with the arrow pointing at the leader.
function edgeHtml(row, o) {
    const swing = row.swing === true ? SWING_HTML : '';
    if (row.edge === null) return '<span class="tc-edge tc-edge-none">&mdash;</span>';
    if (row.leader === 'tied') return '<span class="tc-edge tc-edge-tie">even</span>';
    const shown = formatCell(Math.abs(row.edge), row);
    return row.leader === 'mine'
        ? `<span class="tc-edge tc-edge-mine">&larr;&thinsp;${o.escapeHtml(shown)}${swing}</span>`
        : `<span class="tc-edge tc-edge-theirs">${o.escapeHtml(shown)}&thinsp;&rarr;${swing}</span>`;
}

// A points row's edge is in points; a row that earned none has no leader, so it shows a dash.
function pointsEdgeHtml(row, o) {
    if (row.pointsEdge === null || row.pointsEdge === undefined || row.leader === null) return '<span class="tc-edge tc-edge-none">&mdash;</span>';
    if (row.leader === 'tied') return '<span class="tc-edge tc-edge-tie">even</span>';
    const shown = o.escapeHtml(formatPoints(Math.abs(row.pointsEdge)));
    return row.leader === 'mine'
        ? `<span class="tc-edge tc-edge-mine">&larr;&thinsp;${shown}</span>`
        : `<span class="tc-edge tc-edge-theirs">${shown}&thinsp;&rarr;</span>`;
}

// The chance's mark and bar for one row, keyed by the row's stat id off the model. A row with no figure in the model draws neither.
function faceRowHtml(row, o) {
    const face = o.face;
    if (!face || face.refusal || row.id === null || row.id === undefined) return '';
    const id = String(row.id);
    const idOf = x => String(x && typeof x === 'object' ? x.statId : x);
    const fallback = ((face.marks && face.marks.fallback) || []).map(idOf);
    const leftOut = ((face.marks && face.marks.leftOut) || []).map(idOf);
    const figure = ((face.odds && face.odds.perCategory) || []).find(c => String(c.statId) === id);
    let html = '';
    if (fallback.includes(id) || leftOut.includes(id)) {
        const why = leftOut.includes(id) ? 'Left out: too little to measure' : 'Estimated from season rates';
        html += `<i class="mf-info" data-tooltip="${o.escapeHtml(why)}">i</i>`;
    }
    if (figure) {
        const w = Math.max(0, Math.min(1, Number(figure.chanceWin) || 0));
        const t = Math.max(0, Math.min(1 - w, Number(figure.chanceTie) || 0));
        html += `<span class="mf-bar" aria-hidden="true"><i class="w" style="width:${(w * 100).toFixed(1)}%"></i><i class="t" style="width:${(t * 100).toFixed(1)}%"></i></span>`;
    }
    return html;
}

function rowHtml(row, o, isPts = false) {
    return `<div class="tc-row">
        <span class="tc-cat">${o.escapeHtml(row.label)}${row.lowerIsBetter ? '<span class="tc-inv" title="Lower is better">&darr;</span>' : ''}${faceRowHtml(row, o)}</span>
        ${cellHtml(row.mine, row, 'mine', o, isPts)}
        ${isPts ? pointsEdgeHtml(row, o) : edgeHtml(row, o)}
        ${cellHtml(row.theirs, row, 'theirs', o, isPts)}
    </div>`;
}

// Every row prints in its category order, a level row included; a points league's rows carry their full label.
function rowsBlockHtml(rows, o, isPts) {
    return rows.map(r => rowHtml(r, o, isPts)).join('');
}

// Rows are split by player group, primary first, each group keeping its order, with a small divider between.
function tableHtml(compare, o) {
    const isPts = !!compare.points;
    const primary = compare.rows.filter(r => r.group === 'primary');
    const secondary = compare.rows.filter(r => r.group === 'secondary');
    const ungrouped = compare.rows.filter(r => r.group !== 'primary' && r.group !== 'secondary');
    if (!primary.length || !secondary.length) return rowsBlockHtml([...primary, ...secondary, ...ungrouped], o, isPts);
    const head = (key) => {
        const label = o.groupLabels && o.groupLabels[key];
        return `<div class="tc-group-head">${label ? `<span>${o.escapeHtml(label)}</span>` : ''}</div>`;
    };
    return `${head('primary')}${rowsBlockHtml(primary, o, isPts)}${head('secondary')}${rowsBlockHtml(secondary, o, isPts)}${ungrouped.length ? rowsBlockHtml(ungrouped, o, isPts) : ''}`;
}

// A projected edge is never worded as a result, so the headline says "projected to win" or "winning", never "won".
function headlineHtml(compare, o) {
    const { window: win, mine, rows } = compare;
    // A points league shows the two totals, but a total missing a row's figure is partial and is never printed as the score.
    if (compare.points) {
        const pm = compare.points.mine, pt = compare.points.theirs;
        const asOf = (win.kind === 'played' && win.asOf)
            ? ` <span class="tc-asof">as of period ${o.escapeHtml(String(win.asOf))}</span>` : '';
        const prefix = win.kind === 'projected' ? 'projected ' : '';
        if (pm.missing > 0 || pt.missing > 0) {
            return `<div class="tc-headline">${o.escapeHtml(mine.name)} against ${o.escapeHtml(compare.theirs.name)}${asOf}</div>`;
        }
        return `<div class="tc-headline">${o.escapeHtml(mine.name)} ${prefix}<strong>${o.escapeHtml(formatPoints(pm.total))}</strong> to <strong>${o.escapeHtml(formatPoints(pt.total))}</strong> ${o.escapeHtml(compare.theirs.name)}${asOf}</div>`;
    }
    const winning = rows.filter(r => r.leader === 'mine').length;
    const verb = win.kind === 'projected' ? 'projected to win' : 'winning';
    const asOfHtml = (win.kind === 'played' && win.asOf)
        ? ` <span class="tc-asof">as of period ${o.escapeHtml(String(win.asOf))}</span>` : '';
    return `<div class="tc-headline">${o.escapeHtml(mine.name)} ${verb} <strong>${winning}</strong> of ${rows.length}${asOfHtml}</div>`;
}

// One tile of the workload header; an unknown figure prints a dash rather than the word "null".
function workloadTileHtml(label, value, cls) {
    // The model refuses some figures when there is no slot table behind it, so a null must read as "not known".
    const shown = (value === null || value === undefined) ? '-' : value;
    return `<div class="tc-work-tile"><b${cls ? ` class="${cls}"` : ''}>${shown}</b><small>${label}</small></div>`;
}

// Starts exist for baseball only, so a side without them drops that tile; only Starts is coloured by the leader.
function workloadSideHtml(w, mySide, otherStartsListed, o) {
    const tiles = [];
    if (w.starts) {
        const cls = otherStartsListed === null || otherStartsListed === undefined ? ''
            : w.starts.listed > otherStartsListed ? 'up'
                : w.starts.listed < otherStartsListed ? 'dn' : '';
        tiles.push(workloadTileHtml('Starts', w.starts.listed, cls));
    }
    tiles.push(workloadTileHtml(o.workloadWord ? `${o.escapeHtml(o.workloadWord)} games` : 'Games', w.hitterGames));
    tiles.push(workloadTileHtml('Off-days', w.offDays));
    tiles.push(workloadTileHtml('On IL', w.il));
    return `<div class="tc-work-side${mySide ? '' : ' tc-work-side-theirs'}">${tiles.join('')}</div>`;
}

// The middle column names the window and, under it, its dates; the day count is the fallback when it cannot be dated.
function workloadMidHtml(win, o) {
    const days = win.periods.length;
    const under = win.dates || `${days} day${days === 1 ? '' : 's'}`;
    return `<div class="tc-work-mid"><span>Workload</span><b>${o.escapeHtml(win.label)}</b><span>${o.escapeHtml(under)}</span></div>`;
}

// The caption under the header; its second half prints only when a side has starts.
function workloadCaptionHtml(mine, theirs, o) {
    let text = 'Starts across the staff, bench included; games and off-days for the lineup as seated.';
    if (mine.starts || theirs.starts) {
        const mp = mine.starts ? mine.starts.probable : 0;
        const tp = theirs.starts ? theirs.starts.probable : 0;
        text += ` ${mp} of yours and ${tp} of theirs are ESPN probables; the rest are rotation-turn estimates.`;
    }
    // A mark, not a sentence: the fact is a hover on the workload block, since a face never explains itself in a line.
    return `<div class="tc-work-caption"><span class="hint" tabindex="0" role="button" aria-label="About these figures" data-hint="${o.escapeHtml(text)}">&#9432;</span></div>`;
}

function workloadHtml(compare, o) {
    const { mine, theirs, window: win } = compare;
    if (!mine.workload && !theirs.workload) return '';
    const mw = mine.workload, tw = theirs.workload;
    return `<div class="tc-work">
        ${workloadSideHtml(mw, true, tw.starts ? tw.starts.listed : null, o)}
        ${workloadMidHtml(win, o)}
        ${workloadSideHtml(tw, false, mw.starts ? mw.starts.listed : null, o)}
    </div>
    ${workloadCaptionHtml(mw, tw, o)}`;
}

// The week strip's options are this renderer's own shape, not the model's, because the week on screen is the caller's paging state. Baseball is the only sport with a rotation, so other sports draw nothing here.

// Surname only, since the strip's cells are narrow; full names stay on the headline and the rows.
function surnameOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(name || '');
}

// A start still ahead carries a tilde; "vs" gets its space back and "@" stays tight.
function spacedOpponent(opponent) {
    return opponent ? opponent.replace(/^vs/, 'vs ') : opponent;
}

function dayCellHtml(rows, o) {
    if (!rows || !rows.length) return '<div class="tc-day-cell tc-day-off">off</div>';
    // Surname and opponent share one line; the full name rides on the tooltip for a surname that is not enough.
    const lines = rows.map(r => {
        const ahead = r.probable ? ' tc-day-ahead' : '';
        const mark = r.probable ? ' ~' : '';
        const surname = surnameOf(r.name);
        const opp = spacedOpponent(r.opponent);
        const text = `${surname}${opp ? ` ${opp}` : ''}${mark}`;
        const title = o.escapeHtml(`${r.name || ''}${opp ? ` ${opp}` : ''}`);
        return `<span class="tc-day-start${ahead}" data-tooltip="${title}">${o.escapeHtml(text)}</span>`;
    });
    return `<div class="tc-day-cell">${lines.join('')}</div>`;
}

// The control in the headline's corner: which week, its dates and the two steps. Choosing the week opens the grid.
function dayStripControlHtml(ds, o) {
    if (!ds) return '';
    const range = ds.rangeLabel ? ` &middot; ${o.escapeHtml(ds.rangeLabel)}` : '';
    return `<div class="tc-strip-control">
        <button type="button" class="tc-strip-toggle" aria-expanded="${ds.open ? 'true' : 'false'}">Week ${ds.weekIndex} of ${ds.weekCount}${range}</button>
        <button type="button" class="chrome-arrow tc-strip-prev" aria-label="Earlier week"${ds.canPrev ? '' : ' disabled'}>&#8249;</button>
        <button type="button" class="chrome-arrow tc-strip-next" aria-label="Later week"${ds.canNext ? '' : ' disabled'}>&#8250;</button>
    </div>`;
}

// The grid and its summary line, drawn only while open. Every day of the week has a column, empty ones included.
function dayStripGridHtml(ds, o) {
    if (!ds || !ds.open || !ds.days || !ds.days.length) return '';
    const heads = ds.days.map(d => `<div class="tc-day-head">${o.escapeHtml(d.label || '')}</div>`).join('');
    const sideRow = (label, key) => `<div class="tc-day-who">${o.escapeHtml(label)}</div>`
        + ds.days.map(d => dayCellHtml(d[key], o)).join('');
    // "Played" is every listing that is not still ahead, so the summary counts the two and never keeps a count of its own.
    const ahead = (key) => ds.days.reduce((n, d) => n + (d[key] || []).filter(r => r.probable).length, 0);
    const total = (key) => ds.days.reduce((n, d) => n + (d[key] || []).length, 0);
    const summary = `Week ${ds.weekIndex}: ${total('mine')} start${total('mine') === 1 ? '' : 's'} for you, `
        + `${ahead('mine')} still ahead · ${total('theirs')} for them, ${ahead('theirs')} still ahead`;
    // A week ESPN has not posted reads as every cell "off", so the caller's horizon flag says which it is.
    const horizonNote = ds.pastHorizon
        ? '<div class="tc-strip-note">ESPN has not posted this week\'s starts yet.</div>' : '';
    return `<div class="tc-strip">
        <div class="tc-strip-grid" style="--tc-strip-days:${ds.days.length}">
            <div class="tc-day-who"></div>${heads}
            ${sideRow('Yours', 'mine')}
            ${sideRow('Theirs', 'theirs')}
        </div>
        ${horizonNote}
        <div class="tc-strip-summary">${o.escapeHtml(summary)}</div>
    </div>`;
}

/**
 * Draws the matchup chance's pill for the compare drawer's title row: a percentage with the tie beside it
 * for a number, the word alone for a word, a blank pill with an info mark when the chance was refused.
 * Returns an empty string for no model or a refusal, so the drawer stays as it was.
 *
 * @param {?object} face The model matchup-face.js returns, or null.
 * @param {object} [opts] Rendering options.
 * @param {function(string): string} [opts.escapeHtml] HTML escaper; the identity when absent.
 * @returns {string} The pill's markup, or an empty string.
 */
export function buildFacePillHtml(face, opts) {
    if (!face || face.refusal) return '';
    const esc = (opts && opts.escapeHtml) || (x => x);
    if (!face.odds) {
        return `<span class="mf-chance mf-blank"><b>&ndash;</b><i class="mf-info" data-tooltip="${esc('No chance is given for this matchup yet')}">i</i></span>`;
    }
    if (face.shows === 'number') {
        const pct = Math.round(Number(face.odds.chance) * 100);
        const tie = Math.round(Number(face.odds.tie) * 100);
        return `<span class="mf-chance"><b>${pct}%</b>${tie >= 1 ? `<small>${tie}% tie</small>` : ''}</span>`;
    }
    return `<span class="mf-chance mf-word"><b>${esc(face.word || '')}</b></span>`;
}

/**
 * Builds the "against" band for one opponent as an HTML string.
 *
 * @param {object|null} compare The model teamCompare() returns, or null when there is nothing to compare.
 *   Carries `window` ({kind: 'played'|'projected', label, dates, periods, asOf}), `mine` and `theirs`
 *   ({name, workload}), `rows` (one per category: label, mine, theirs, edge, leader, rate, swing,
 *   lowerIsBetter, group, minePoints, theirPoints, pointsEdge) and, in a points league, `points`
 *   ({mine, theirs}, each with total and missing).
 * @param {object} [opts] Rendering options.
 * @param {function(string): string} [opts.escapeHtml] HTML escaper; the identity when absent.
 * @param {object[]} [opts.rateComponents] The sport's rate-component table, used to explain an empty rate cell.
 * @param {Object<string, string>} [opts.statLabels] Stat labels by id, used in the same explanation.
 * @param {string|null} [opts.workloadWord] The role word on the games tile ("Hitter", "Skater", "Player");
 *   null gives the bare "Games", and an absent option keeps "Hitter".
 * @param {{primary: string, secondary: string}|null} [opts.groupLabels] The labels of the two group dividers.
 * @param {object|null} [opts.dayStrip] The week strip's state: sport, open, weekIndex, weekCount,
 *   rangeLabel, canPrev, canNext, pastHorizon and days (the current week's per-day rows).
 * @returns {string} The band's markup, or an empty string when `compare` is null.
 */
export function buildTeamCompareHtml(compare, opts) {
    const o = resolveOpts(opts);
    if (!compare) return '';
    const ds = (opts && opts.dayStrip) || null;
    // The roster caveat sits right under the headline because a reader planning ahead is the one who will change the roster.
    const caveat = compare.window.kind === 'projected'
        ? '<div class="tc-caveat">Projected from today\'s roster - adds, drops and waivers before then are not counted.</div>'
        : '';
    return `<div class="tc-band${compare.points ? ' tc-band-points' : ''}">
        <div class="tc-head-row">${headlineHtml(compare, o)}${dayStripControlHtml(ds, o)}</div>
        ${caveat}
        ${workloadHtml(compare, o)}
        <div class="tc-table">${tableHtml(compare, o)}</div>
        ${dayStripGridHtml(ds, o)}
    </div>`;
}
