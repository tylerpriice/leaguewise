/**
 * A faint line-and-fill sparkline for the chips in the drill-down's merged row: a stat chip's
 * per-matchup value, or a rank chip's per-matchup rank score, over the same timeframe the chip's
 * own figure covers.
 *
 * Pure. No DOM, no application state and no network. The caller builds the ordered values array and
 * this module only turns numbers into a picture. A matchup still being played is not a point on the
 * line, since a partial total joined to finished ones draws a fall that is only the days not yet
 * played. The caller names it with `liveIndex` and it comes back apart, to be drawn as its own mark.
 *
 * @module sparkline
 */

/**
 * @typedef {Object} Sparkline The geometry of one sparkline on a 100x40 viewBox.
 * @property {string} line The SVG path of the line through the settled entries.
 * @property {string} fill The SVG path of the fill, closed down to the axis.
 * @property {?{x: number, y: number, value: number}} live The live entry's position on the same grid, or null.
 */
const SPARK_W = 100;
const SPARK_H = 40;

/**
 * Turns a series into a line path and a fill path, normalised to the series' own minimum and maximum.
 * A missing entry is an absence and not a zero, so the line continues across the gap at the true
 * index spacing. Fewer than two settled points draws nothing, since one point has no trend.
 *
 * @param {Array<?number>} values One entry per matchup; null or non-finite entries are skipped.
 * @param {Object} [opts] Options.
 * @param {?number} [opts.liveIndex] The index of the matchup being played, kept off the line.
 * @returns {?Sparkline} The paths, or null when there is nothing to plot.
 */
export function sparklinePoints(values, { liveIndex = null } = {}) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const liveAt = (Number.isInteger(liveIndex) && liveIndex >= 0 && liveIndex < values.length) ? liveIndex : null;
    const present = [];
    let livePoint = null;
    values.forEach((v, i) => {
        if (v === null || v === undefined || !Number.isFinite(v)) return;
        if (i === liveAt) livePoint = { i, v };
        else present.push({ i, v });
    });
    if (present.length < 2) return null;

    const PAD_Y = 3;
    const vs = present.map(p => p.v);
    if (livePoint) vs.push(livePoint.v);
    const min = Math.min(...vs), max = Math.max(...vs);
    const n = values.length;
    const x = (i) => (n > 1 ? (i / (n - 1)) * SPARK_W : SPARK_W / 2);
    // A flat series draws a line through the middle of the box rather than dividing by zero.
    const y = (v) => (max === min ? SPARK_H / 2 : PAD_Y + (1 - (v - min) / (max - min)) * (SPARK_H - PAD_Y * 2));

    let line = '';
    present.forEach((p, idx) => {
        line += `${idx === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)} `;
    });
    line = line.trim();
    const first = present[0], last = present[present.length - 1];
    // The fill closes down to the axis under only the plotted span (first real point to last), never the chip's own full width when the series does not reach its own edges.
    const fill = `${line} L${x(last.i).toFixed(1)},${SPARK_H} L${x(first.i).toFixed(1)},${SPARK_H} Z`;
    // Numbers, rounded as the path's own are, so the caller's mark lands on the same grid.
    const live = livePoint
        ? { x: Number(x(livePoint.i).toFixed(1)), y: Number(y(livePoint.v).toFixed(1)), value: livePoint.v }
        : null;
    return { line, fill, live };
}

/**
 * The markup for a sparkline, so every caller draws the same two-path shape. The live mark is a
 * sibling of the svg and not a shape in it, because the box is stretched to the chip and a circle
 * inside it would become an ellipse.
 *
 * @param {Array<?number>} values One entry per matchup.
 * @param {Object} [opts] Options, as sparklinePoints takes them.
 * @param {?number} [opts.liveIndex] The index of the matchup being played.
 * @returns {string} The markup, or an empty string when there is nothing to plot.
 */
export function sparklineSvg(values, opts = {}) {
    const pts = sparklinePoints(values, opts);
    if (!pts) return '';
    const liveHtml = pts.live
        ? `<i class="stat-chip-spark-live" style="--x:${pts.live.x}; --y:${(pts.live.y / SPARK_H * 100).toFixed(1)}"></i>`
        : '';
    return `<svg class="stat-chip-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">`
        + `<path class="stat-chip-spark-fill" d="${pts.fill}"></path>`
        + `<path class="stat-chip-spark-line" d="${pts.line}"></path>`
        + `</svg>`
        + liveHtml;
}
