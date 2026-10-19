// Unit tests for the pure sparkline builder (sparkline.js). Open tests/sparkline.test.html through any static server; green means every assertion held. Every coordinate here is hand-computed against the module's own documented formula (x = i/(n-1)*100, y = PAD_Y + (1-(v-min)/(max-min)) * (40-PAD_Y*2), PAD_Y = 3), never taken from running the code.
import { sparklinePoints, sparklineSvg } from '../src/views/sparkline.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

test('sparklinePoints: fewer than two real points draws nothing', () => {
    assertEq(sparklinePoints([]), null, 'empty array');
    assertEq(sparklinePoints([5]), null, 'one point');
    assertEq(sparklinePoints([null, 5, null]), null, 'one real point among nulls');
    assertEq(sparklinePoints(null), null, 'not an array at all');
});

test('sparklinePoints: two real points, hand-computed coordinates', () => {
    // values [10, 20]: min=10, max=20, PAD_Y=3, box height 40. x(0) = 0/(2-1)*100 = 0; x(1) = 1/(2-1)*100 = 100. y(10) = 3 + (1-(10-10)/(20-10)) * 34 = 3 + (1-0) * 34 = 37. y(20) = 3 + (1-(20-10)/(20-10)) * 34 = 3 + (1-1) * 34 = 3.
    const pts = sparklinePoints([10, 20]);
    assertEq(pts.line, 'M0.0,37.0 L100.0,3.0', 'rising series draws upward (smaller y at the higher value)');
    assertEq(pts.fill, 'M0.0,37.0 L100.0,3.0 L100.0,40 L0.0,40 Z', 'fill closes down to the axis under the plotted span');
});

test('sparklinePoints: a falling series draws the opposite way', () => {
    const pts = sparklinePoints([20, 10]);
    assertEq(pts.line, 'M0.0,3.0 L100.0,37.0', 'the higher value (first) sits near the top, the lower (last) near the bottom');
});

test('sparklinePoints: a flat series (every value equal) draws a flat mid-line, never NaN', () => {
    // Three equal values: x spreads across the full box (0, 50, 100); y falls back to the exact vertical middle (40/2 = 20) rather than dividing by a zero range.
    const pts = sparklinePoints([7, 7, 7]);
    assertEq(pts.line, 'M0.0,20.0 L50.0,20.0 L100.0,20.0', 'three equal values, midline y, full-width x spread');
    assert(!pts.line.includes('NaN'), 'never a division by zero into NaN');
});

test('sparklinePoints: a missed matchup (null) is skipped, not plotted as zero', () => {
    // [10, null, 30] gives three slots, the middle absent. x is computed against the full n=3 spacing (0, 50, 100) so the two real points keep their true positions, but index 1 never appears in the path, so the line runs straight from index 0 to index 2 and never dips to an invented zero at the missed matchup. min=10, max=30, so y(10) = 3 + 1*34 = 37 and y(30) = 3 + 0*34 = 3.
    const pts = sparklinePoints([10, null, 30]);
    assertEq(pts.line, 'M0.0,37.0 L100.0,3.0', 'connects index 0 directly to index 2, index 1 never appears in the path');
});

test('sparklinePoints: undefined and non-finite values are treated the same as null', () => {
    const withUndefined = sparklinePoints([5, undefined, 15]);
    const withNull = sparklinePoints([5, null, 15]);
    assertEq(withUndefined.line, withNull.line, 'undefined reads exactly like null');
    assertEq(sparklinePoints([5, NaN, 15]).line, withNull.line, 'NaN reads exactly like null too');
});

// ==== The matchup being played is returned apart, never joined to the line. ====
test('liveIndex: the line runs through the settled entries, the live one comes back apart', () => {
    // [10, 20, 5] with index 2 live. n = 3, so x is 0, 50, 100. The scale spans all three, min = 5, max = 20, range 15. y(10) = 3 + (1-5/15) * 34 = 3 + 22.667 = 25.667, which is 25.7. y(20) = 3 + (1-15/15) * 34 = 3. y(5) = 3 + (1-0/15) * 34 = 37.
    const pts = sparklinePoints([10, 20, 5], { liveIndex: 2 });
    assertEq(pts.line, 'M0.0,25.7 L50.0,3.0', 'two settled points, stopping one step short of the live one');
    assertEq(pts.fill, 'M0.0,25.7 L50.0,3.0 L50.0,40 L0.0,40 Z', 'the fill closes under the settled span only');
    assertEq(pts.live, { x: 100, y: 37, value: 5 }, 'the live entry, on the same scale, as numbers');
});

test('liveIndex: one settled entry and a live one is no line and no mark', () => {
    // The capture: matchup 1 at 4.6, matchup 2 being played at 1.4.
    assertEq(sparklinePoints([4.6, 1.4], { liveIndex: 1 }), null, 'one settled point has no trend');
    assertEq(sparklineSvg([4.6, 1.4], { liveIndex: 1 }), '', 'and the markup is empty, not a line');
    assertEq(sparklinePoints([4.6, 1.4]).line, 'M0.0,3.0 L100.0,37.0', 'unmarked, the same two entries are the old falling line');
});

test('liveIndex: a live entry with no figure, and an index outside the array', () => {
    // [10, 20, null], index 2 live: min 10, max 20, x 0, 50. y(10) = 37, y(20) = 3.
    const absent = sparklinePoints([10, 20, null], { liveIndex: 2 });
    assertEq([absent.line, absent.live], ['M0.0,37.0 L50.0,3.0', null], 'nothing played yet: the line, and no mark');
    // An index that names no entry is no live entry: every point is settled, as before.
    ['x', 2.5, -1, 3, null].forEach(bad => {
        const out = sparklinePoints([10, 20, 5], { liveIndex: bad });
        assertEq([out.line, out.live], ['M0.0,25.7 L50.0,3.0 L100.0,37.0', null], `liveIndex ${bad}`);
    });
    assertEq(sparklinePoints([10, 20]).live, null, 'no option at all carries live: null');
});

test('liveIndex: a live figure outside the settled range widens the scale, never clamps', () => {
    // [10, 20, 40] with index 2 live: min 10, max 40, range 30. y(10) = 37; y(20) = 3 + (1-10/30) * 34 = 25.667, which is 25.7; y(40) = 3.
    const pts = sparklinePoints([10, 20, 40], { liveIndex: 2 });
    assertEq(pts.line, 'M0.0,37.0 L50.0,25.7', 'the settled rise is drawn smaller, to scale');
    assertEq(pts.live, { x: 100, y: 3, value: 40 }, 'and the live figure sits above it');
});

test('liveIndex: the live entry need not be last, and a flat series stays on the midline', () => {
    // [7, 7, 7] with index 0 live: settled at x 50 and 100, everything equal so y = 20.
    const pts = sparklinePoints([7, 7, 7], { liveIndex: 0 });
    assertEq([pts.line, pts.live], ['M50.0,20.0 L100.0,20.0', { x: 0, y: 20, value: 7 }], 'midline, no NaN');
    assert(sparklineSvg([10, 20, 5], { liveIndex: 2 }).includes('d="M0.0,25.7 L50.0,3.0"'), 'the markup draws the settled line');
});

test('sparklineSvg: the live mark is one sibling after the svg, placed by two shares', () => {
    // [10, 20, 5], index 2 live: live is { x: 100, y: 37 } (above). --x is x as it is, the box being 100 wide; --y is 37 / 40 * 100 = 92.5.
    const svg = sparklineSvg([10, 20, 5], { liveIndex: 2 });
    assert(svg.endsWith('</svg><i class="stat-chip-spark-live" style="--x:100; --y:92.5"></i>'), `after the svg, not in it: ${svg.slice(-90)}`);
    assertEq(svg.split('stat-chip-spark-live').length - 1, 1, 'exactly one mark');
    // [10, 20, 40], index 2 live: y is 3, so --y is 3 / 40 * 100 = 7.5.
    assert(sparklineSvg([10, 20, 40], { liveIndex: 2 }).endsWith('style="--x:100; --y:7.5"></i>'), 'a live figure above the line');
    // [7, 7, 7], index 0 live: x 0, y 20, so --x:0 and --y:50.0.
    assert(sparklineSvg([7, 7, 7], { liveIndex: 0 }).endsWith('style="--x:0; --y:50.0"></i>'), 'the midline is half the height');
});

test('sparklineSvg: no live figure is no sibling at all', () => {
    assert(sparklineSvg([10, 20]).endsWith('</svg>'), 'no option');
    assert(sparklineSvg([10, 20, null], { liveIndex: 2 }).endsWith('</svg>'), 'a live entry with nothing played');
    assert(!sparklineSvg([10, 20, 5], { liveIndex: 9 }).includes('stat-chip-spark-live'), 'an index naming no entry');
    assertEq(sparklineSvg([4.6, 1.4], { liveIndex: 1 }), '', 'under two settled: neither line nor mark');
});

test('sparklineSvg: empty string when there is nothing to plot, never a broken/empty <svg>', () => {
    assertEq(sparklineSvg([1]), '', 'one point');
    assertEq(sparklineSvg([]), '', 'no points');
});

test('sparklineSvg: the markup shape - viewBox, preserveAspectRatio, both paths present', () => {
    const svg = sparklineSvg([10, 20]);
    assert(svg.includes('viewBox="0 0 100 40"'), 'the frozen 100x40 viewBox');
    assert(svg.includes('preserveAspectRatio="none"'), "stretches to the chip's own box rather than letterboxing");
    assert(svg.includes('class="stat-chip-spark-fill"'), 'the fill path');
    assert(svg.includes('class="stat-chip-spark-line"'), 'the line path, drawn over the fill');
    assert(svg.includes('aria-hidden="true"'), 'decorative only - the figures above it already say the number');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
