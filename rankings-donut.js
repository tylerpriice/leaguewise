// THE TEAM RANKINGS BOX'S PIE VIEW, REDRAWN. Pure renderer replacing the old four-unlabelled-slices pie (graphs.js's createPieChart, ) with a labelled donut - the leader named and its own line in the centre, a legend-colour ring, and beside it whichever the box has room for: a compact table (record, win %, the last five as dots, games behind; or category wins, per matchup, behind) under eleven teams, the same table in two columns up to twenty, and a plain legend past that - every cell a figure the box already reports, nothing here advises. Full contract: tests/fixtures/ rankings-donut.md. PURITY CONTRACT, same as leaderboard-row.js/coverage-band.js: no imports, no AppState, no DOM, no fetch. escapeHtml arrives via opts for the same reason every other pure renderer in this codebase takes it that way.
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

// Past this many rows the table (one or two columns) gives way to a plain legend - the frame's own donut only ever demonstrated a table through twenty teams, and past that a ring this size has no realistic way to keep every slice legible even unlabelled. TABLE_TWO_COL_AT is exactly the ruling's own words - "two columns past ten teams."
const LEGEND_PAST_ROWS = 20;
const TABLE_TWO_COL_AT = 10;

// A slice narrower than this never carries its own label - "under a twentieth of the ring the legend or table carries the name" (the ruling's own phrase, a twentieth of a circle being 18 degrees, pi/10 radians) - an unreadable sliver of text is worse than no label at all, and every row is named in the table/legend beside the ring regardless.
const MIN_LABEL_ANGLE = Math.PI / 10;

// R6/S52b: the leader's own slice pulls 4px outward along its own mid-angle - the mockup's generating script carries this exact number (`off = 4` for the first slice only), even though the STATIC svg output S52 read had already baked every path down to plain coordinates with nothing left to reveal the offset came from a translate rather than a different radius. Small and easy to miss reading paths alone; real once the script itself was read.
const LEADER_PULL = 4;

function donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
    const full = endAngle - startAngle >= 2 * Math.PI - 0.0001;
    if (full) {
        // A single team holding the entire share (every other row at zero) - two half-circle arcs rather than a degenerate zero-length path.
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

// Every row with a real share, in the caller's own order (already leader-first - this module sorts nothing, so `i === 0` below is always the leader). Angles run clockwise from 12 o'clock, the same convention createPieChart already used, so a reader familiar with the old pie is not relearning which way the ring turns. R6/S52b: the ON-RING label is the team's own ABBREVIATION, never its full name - the same short form the legend and the bars already print, not a long team name overflowing the ring. The full name still names the slice, in a native SVG <title> (a plain hover, the same "no per-slice JS wiring when the browser's own tooltip already answers this" call the club crest rail already makes) - every slice carries one regardless of whether it is wide enough to carry its own on-ring label too.
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
        // The leader's own slice offsets 4px along its own mid-angle - the mockup's generating script's own number (LEADER_PULL, above). Every other slice keeps the shared centre.
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

// The centre also reads the leader's own abbreviation - the same "no name is ever allowed to overflow its own box" rule the ring's own labels follow, and this text sits in the same fixed 132px (or 150px/210px past ten teams) diameter regardless of how long the league's own team names run.
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

// R6/S52b: the name cell shows the team's own ABBREVIATION too, the full name moved to the cell's own `title` attribute (a plain hover) - a long real name was truncating mid-word in a column this narrow ("Bristling B"), where the abbreviation the legend/bars already use always fits.
function tableRowHtml(row, columns, dotsColumnIndex, o) {
    const cellsHtml = columns.map((col, i) => {
        const content = i === dotsColumnIndex ? dotsHtml(row.dots, o) : o.escapeHtml(row.cells[i] ?? '');
        return `<td class="rkd-cell${col.align === 'right' ? ' rkd-cell-r' : ''}">${content}</td>`;
    }).join('');
    return `<tr>`
        + `<td class="rkd-cell rkd-cell-name" title="${o.escapeHtml(row.name)}"><i class="rkd-swatch" style="background:${o.escapeHtml(row.color || '#888')}"></i>${o.escapeHtml(row.abbrev || row.name)}</td>`
        + cellsHtml
        + `</tr>`;
}

// Past ten teams, the dots column is dropped ENTIRELY - not just left unrendered - so its own header ("Last 5") does not sit over a column of nothing. This module owns that drop itself (rather than trusting every caller to remember to pass a shorter `columns`/`cells` at this one scale) precisely because a caller that forgot would not fail loudly - the header would just say "Last 5" over blank cells forever. Cells realign to the shortened column set the same way.
function dropDotsColumn(columns, dotsColumnIndex, rows) {
    if (dotsColumnIndex < 0) return { columns, rows };
    return {
        columns: columns.filter((_, i) => i !== dotsColumnIndex),
        rows: rows.map(r => ({ ...r, cells: r.cells.filter((_, i) => i !== dotsColumnIndex) })),
    };
}

function tableHtml(rows, columns, dotsColumnIndex, o, twoCol) {
    const headHtml = (cols) => `<th class="rkd-cell rkd-cell-name">Team</th>` + cols.map(col =>
        `<th class="rkd-cell${col.align === 'right' ? ' rkd-cell-r' : ''}">${o.escapeHtml(col.label)}</th>`
    ).join('');
    const buildOne = (list, cols, dotsIdx) => `<table class="rkd-table"><thead><tr>${headHtml(cols)}</tr></thead>`
        + `<tbody>${list.map(r => tableRowHtml(r, cols, dotsIdx, o)).join('')}</tbody></table>`;
    if (!twoCol) return `<div class="rkd-side">${buildOne(rows, columns, dotsColumnIndex)}</div>`;
    // Two columns of ten past ten teams (the ruling's own words) - ten rows' worth of five-dot strings does not fit a half-width column at any legible size, so the dots column is dropped outright at this scale (see dropDotsColumn above), never merely left un-rendered.
    const dropped = dropDotsColumn(columns, dotsColumnIndex, rows);
    const half = Math.ceil(dropped.rows.length / 2);
    return `<div class="rkd-side rkd-side-two">`
        + buildOne(dropped.rows.slice(0, half), dropped.columns, -1)
        + buildOne(dropped.rows.slice(half), dropped.columns, -1)
        + `</div>`;
}

function legendHtml(rows, o) {
    return `<div class="rkd-legend">${rows.map(r =>
        `<i class="rkd-swatch" style="background:${o.escapeHtml(r.color || '#888')}"></i>`
        + `<span class="rkd-legend-name" title="${o.escapeHtml(r.name)}">${o.escapeHtml(r.abbrev || r.name)}</span>`
        + `<span class="rkd-legend-figure">${o.escapeHtml(r.cells[0] ?? '')}</span>`
    ).join('')}</div>`;
}

// `rows`: [{ id, name, abbrev, color, share, cells: [string,...], dots: ['w'|'l'|'t',...] | null }], already sorted leader-first by the caller (the same rank the strip/drawer's own losingIds-free order already uses) - this module sorts nothing and does not know what "leads" means for a roto vs H2H league, only that rows[0] is that row. `abbrev` is what actually prints on the ring, the centre and the table/legend - `name` (the full name) survives only as the hover title on each; a caller with no real abbreviation of its own can pass the same string for both, but never omit `abbrev`, since a falsy value there falls back to the (possibly long) `name`. `columns`: [{ label, align: 'left' | 'right' }] - the table/legend's own header cells, in the same order as every row's `cells` array. `dotsColumnIndex` (or -1) names which column renders the last-five dots instead of its row's own `cells` string at that index - -1 when the scale (past ten teams) has already dropped the dots column from `columns` itself. `centerSubtitle`: the donut's own second line under the leader's name ("11-8-1 - leads" / "leads by 0.5" / "leads") - worded by the caller, since a roto/H2H/points league each say it differently and this module carries no scoring-format knowledge of its own.
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
    const twoCol = rowList.length > TABLE_TWO_COL_AT;
    const cols = columns || [];
    return `<div class="rkd">${svg}${tableHtml(rowList, cols, dotsColumnIndex, o, twoCol)}</div>`;
}
