/**
 * The Team Rankings pie view: a labelled donut with the leader named and a caller-worded line in
 * the centre, and beside it whichever fits the box. That is a compact table (record, win percent,
 * the last five as dots, games behind) for a small league, the same table without its dots column
 * up to twenty teams, and a plain legend past that. Every cell is a figure the caller already
 * computed and nothing here advises.
 *
 * Pure. No imports, no application state, no DOM and no network; the HTML escaper arrives in the options.
 *
 * Contract: tests/fixtures/rankings-donut.md
 * @module rankings-donut
 */
/**
 * @typedef {Object} DonutRow One team in the ring and the table beside it.
 * @property {*} id The team id.
 * @property {string} name The full name, shown as the hover title.
 * @property {string} [abbrev] The short form printed on the ring, in the centre and in the table.
 * @property {string} [color] The team's legend colour.
 * @property {number} share The team's fraction of the whole ring; zero or less draws no slice.
 * @property {string[]} cells Formatted strings, in the order of the columns.
 * @property {?Array<'w'|'l'|'t'>} [dots] The last results, for the dots column.
 */
/**
 * @typedef {Object} DonutColumn One header cell of the table or legend.
 * @property {string} label The header text.
 * @property {'left'|'right'} [align] The cell alignment.
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

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
    };
}

// Past this many rows the table gives way to a plain legend, since a ring this size cannot keep every slice legible. DROP_DOTS_PAST is where the five-dot column goes, because it is the one column that cannot share the box with the others.
const LEGEND_PAST_ROWS = 20;
const DROP_DOTS_PAST = 10;

// A slice under a twentieth of the ring carries no label of its own, since an unreadable sliver is worse than none.
const MIN_LABEL_ANGLE = Math.PI / 10;

// The leader's slice is pulled out 4px along its own mid-angle.
const LEADER_PULL = 4;

function donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
    const full = endAngle - startAngle >= 2 * Math.PI - 0.0001;
    if (full) {
        // A single team holding the whole share is drawn as two half-circle arcs rather than a zero-length path.
        return `M ${cx - rOuter} ${cy} A ${rOuter} ${rOuter} 0 1 1 ${cx + rOuter} ${cy} `
            + `A ${rOuter} ${rOuter} 0 1 1 ${cx - rOuter} ${cy} `
            + `M ${cx - rInner} ${cy} A ${rInner} ${rInner} 0 1 0 ${cx + rInner} ${cy} `
            + `A ${rInner} ${rInner} 0 1 0 ${cx - rInner} ${cy} Z`;
    }
    const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
    const x1o = cx + rOuter * Math.cos(startAngle), y1o = cy + rOuter * Math.sin(startAngle);
    const x2o = cx + rOuter * Math.cos(endAngle), y2o = cy + rOuter * Math.sin(endAngle);
    const x2i = cx + rInner * Math.cos(endAngle), y2i = cy + rInner * Math.sin(endAngle);
    const x1i = cx + rInner * Math.cos(startAngle), y1i = cy + rInner * Math.sin(startAngle);
    return `M ${x1o.toFixed(1)} ${y1o.toFixed(1)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2o.toFixed(1)} ${y2o.toFixed(1)} `
        + `L ${x2i.toFixed(1)} ${y2i.toFixed(1)} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i.toFixed(1)} ${y1i.toFixed(1)} Z`;
}

// Rows with a real share, in the caller's order, which is already leader-first; angles run clockwise from 12 o'clock. The ring label is the team's abbreviation so a long name cannot overflow, and the full name rides on a native title.
function donutSlicesSvg(rows, size, o) {
    const cx = size / 2, cy = size / 2;
    const rOuter = size / 2 - 2, rInner = rOuter * 0.6;
    const total = rows.reduce((sum, r) => sum + Math.max(0, r.share || 0), 0);
    if (total <= 0) return '';
    let angle = -Math.PI / 2;
    const labelR = (rOuter + rInner) / 2;
    let i = 0;
    return rows.filter(r => (r.share || 0) > 0).map(r => {
        const isLeader = i === 0;
        i++;
        const sliceAngle = (r.share / total) * 2 * Math.PI;
        const end = angle + sliceAngle;
        const mid = (angle + end) / 2;
        // The leader's slice is offset along its mid-angle; every other slice keeps the shared centre.
        const sx = isLeader ? cx + LEADER_PULL * Math.cos(mid) : cx;
        const sy = isLeader ? cy + LEADER_PULL * Math.sin(mid) : cy;
        const path = donutSlicePath(sx, sy, rOuter, rInner, angle, end);
        const label = r.abbrev || r.name;
        const labelHtml = sliceAngle >= MIN_LABEL_ANGLE
            ? `<text x="${(sx + labelR * Math.cos(mid)).toFixed(1)}" y="${(sy + labelR * Math.sin(mid)).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" class="rkd-slice-label">${o.escapeHtml(label)}</text>`
            : '';
        angle = end;
        return `<g class="rkd-slice-group"><path d="${path}" fill="${o.escapeHtml(r.color || '#888')}" class="rkd-slice"><title>${o.escapeHtml(r.name)}</title></path>${labelHtml}</g>`;
    }).join('');
}

// The centre prints the abbreviation too, so no name can overflow the fixed diameter.
function centerTextSvg(size, leader, centerSubtitle, o) {
    if (!leader) return '';
    const cy = size / 2;
    return `<text x="${size / 2}" y="${cy - 6}" text-anchor="middle" class="rkd-center-name"><title>${o.escapeHtml(leader.name)}</title>${o.escapeHtml(leader.abbrev || leader.name)}</text>`
        + `<text x="${size / 2}" y="${cy + 10}" text-anchor="middle" class="rkd-center-sub">${o.escapeHtml(centerSubtitle || '')}</text>`;
}

function dotsHtml(dots, o) {
    if (!dots || !dots.length) return '';
    const cls = { w: 'rkd-dot-w', l: 'rkd-dot-l', t: 'rkd-dot-t' };
    return dots.map(d => `<span class="rkd-dot ${cls[d] || ''}"></span>`).join('');
}

// The name cell shows the abbreviation, since a full name truncated mid-word in a column this narrow; the name moves to the title.
function tableRowHtml(row, columns, dotsColumnIndex, o) {
    const cellsHtml = columns.map((col, i) => {
        const content = i === dotsColumnIndex ? dotsHtml(row.dots, o) : o.escapeHtml(row.cells[i] ?? '');
        return `<td class="rkd-cell${col.align === 'right' ? ' rkd-cell-r' : ''}${i === dotsColumnIndex ? ' rkd-cell-dots' : ''}">${content}</td>`;
    }).join('');
    return `<tr>`
        + `<td class="rkd-cell rkd-cell-name" title="${o.escapeHtml(row.name)}"><i class="rkd-swatch" style="background:${o.escapeHtml(row.color || '#888')}"></i>${o.escapeHtml(row.abbrev || row.name)}</td>`
        + cellsHtml
        + `</tr>`;
}

// The dots column is dropped entirely so its header does not sit over blank cells; doing it here means a caller cannot forget.
function dropDotsColumn(columns, dotsColumnIndex, rows) {
    if (dotsColumnIndex < 0) return { columns, rows };
    return {
        columns: columns.filter((_, i) => i !== dotsColumnIndex),
        rows: rows.map(r => ({ ...r, cells: r.cells.filter((_, i) => i !== dotsColumnIndex) })),
    };
}

function tableHtml(rows, columns, dotsColumnIndex, o, dropDots) {
    // The dots column carries its own class so the caller can hide it when the box has no room beside the ring.
    const headHtml = (cols, dotsIdx) => `<th class="rkd-cell rkd-cell-name">Team</th>` + cols.map((col, i) =>
        `<th class="rkd-cell${col.align === 'right' ? ' rkd-cell-r' : ''}${i === dotsIdx ? ' rkd-cell-dots' : ''}">${o.escapeHtml(col.label)}</th>`
    ).join('');
    const buildOne = (list, cols, dotsIdx) => `<table class="rkd-table"><thead><tr>${headHtml(cols, dotsIdx)}</tr></thead>`
        + `<tbody>${list.map(r => tableRowHtml(r, cols, dotsIdx, o)).join('')}</tbody></table>`;
    if (!dropDots) return `<div class="rkd-side">${buildOne(rows, columns, dotsColumnIndex)}</div>`;
    // Past ten teams the dots column is dropped outright, not left unrendered.
    const dropped = dropDotsColumn(columns, dotsColumnIndex, rows);
    return `<div class="rkd-side">${buildOne(dropped.rows, dropped.columns, -1)}</div>`;
}

function legendHtml(rows, o) {
    return `<div class="rkd-legend">${rows.map(r =>
        `<i class="rkd-swatch" style="background:${o.escapeHtml(r.color || '#888')}"></i>`
        + `<span class="rkd-legend-name" title="${o.escapeHtml(r.name)}">${o.escapeHtml(r.abbrev || r.name)}</span>`
        + `<span class="rkd-legend-figure">${o.escapeHtml(r.cells[0] ?? '')}</span>`
    ).join('')}</div>`;
}

/**
 * Builds the donut and its table or legend as an HTML string. Rows arrive leader-first and nothing
 * is sorted or ranked here.
 *
 * @param {Object} model The view's content.
 * @param {DonutRow[]} model.rows One per team, leader first.
 * @param {DonutColumn[]} model.columns The table or legend header cells, in the order of each row's cells.
 * @param {number} [model.dotsColumnIndex] Which column renders the dots instead of its cell string, or -1.
 * @param {string} [model.centerSubtitle] The centre's second line, worded by the caller.
 * @param {number} [model.size] The ring's pixel diameter (132).
 * @param {Object} [opts] Options.
 * @param {function(*): string} [opts.escapeHtml] The HTML escaper; a built-in one when absent.
 * @returns {string} The markup, or an empty string when there are no rows.
 */
export function buildRankingsDonutHtml({ rows, columns, dotsColumnIndex = -1, centerSubtitle, size = 132 }, opts) {
    const o = resolveOpts(opts);
    const rowList = rows || [];
    if (!rowList.length) return '';
    const leader = rowList[0];
    const svg = `<svg class="rkd-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
        + donutSlicesSvg(rowList, size, o)
        + centerTextSvg(size, leader, centerSubtitle, o)
        + `</svg>`;

    if (rowList.length > LEGEND_PAST_ROWS) {
        return `<div class="rkd">${svg}${legendHtml(rowList, o)}</div>`;
    }
    const dropDots = rowList.length > DROP_DOTS_PAST;
    const cols = columns || [];
    return `<div class="rkd">${svg}${tableHtml(rowList, cols, dotsColumnIndex, o, dropDots)}</div>`;
}
