// Unit tests for the Team Metrics bar columns (graphs.js sizeBarTitles / barColumnWidth), which are arithmetic over two measured widths. The value column once measured itself after it had been sized, so it grew by its own pad on every render.
import { barColumnWidth, sizeBarTitles } from '../src/views/graphs.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ==== the pure rule ====

test('barColumnWidth: the pad is added to the content and the range is honoured', () => {
    assertEq(barColumnWidth(62, { pad: 4, max: 90 }), 66, 'sixty-two of content plus four of pad');
    assertEq(barColumnWidth(120, { pad: 4, max: 90 }), 90, 'clamped up top');
    assertEq(barColumnWidth(10, { pad: 8, min: 34, max: 140 }), 34, 'and at the bottom');
});

test('barColumnWidth: a fractional measurement rounds UP, never down', () => {
    // A column a fraction narrower than its content clips it, and the clip is invisible at 12px until someone reads a truncated figure and believes it.
    assertEq(barColumnWidth(61.2, { pad: 4, max: 90 }), 66, 'ceil, then pad');
});

test('barColumnWidth: nothing measurable is null, never a width', () => {
    // The caller must be able to tell "no rows to measure" from "a column zero wide", because one of those means leave the previous value alone.
    assertEq(barColumnWidth(0, { pad: 4 }), null, 'zero');
    assertEq(barColumnWidth(NaN, { pad: 4 }), null, 'not a number');
    assertEq(barColumnWidth(null, { pad: 4 }), null, 'nothing at all');
});

// ==== the ratchet ====

// One container in the shape sizeBarTitles reads: rows, each with a title carrying the two label spans CSS swaps between, a flexible track, and a value.
function buildBars(values) {
    const host = document.getElementById('sandbox');
    host.innerHTML = values.map(v => `
        <div class="bar-row">
            <div class="bar-title"><span class="bar-title-full">Long Team Name</span><span class="bar-title-abbr">LTN</span></div>
            <div class="bar-track"><div class="bar-fill"></div></div>
            <span class="bar-value">${v}</span>
        </div>`).join('');
    return host;
}
const widthOf = (host, prop) => host.style.getPropertyValue(prop);

test('sizeBarTitles: measuring twice with the same content publishes the same width', () => {
    // THE DEFECT, stated as itself. Measured in the app before the fix: --bar-value-w went 70, 74, 78, 82, 86, 90 over six renders while every W-L-T value on screen stayed identical, and the track fell from 277 to 257. The cause was scrollWidth on an element this function had already given a width to.
    const host = buildBars(['16W-5L-3T', '8W-14L-2T', '10W-13L-1T']);
    sizeBarTitles(host);
    const first = widthOf(host, '--bar-value-w');
    sizeBarTitles(host);
    const second = widthOf(host, '--bar-value-w');
    sizeBarTitles(host);
    const third = widthOf(host, '--bar-value-w');
    assert(first && first !== '0px', `a width was published: ${first}`);
    assertEq(second, first, 'the second render publishes what the first did');
    assertEq(third, first, 'and so does the third');
});

test('sizeBarTitles: twelve renders do not move it by a pixel', () => {
    // Twelve is the count the click sequence reached in the reproduction.
    const host = buildBars(['21W-4L-0T', '3W-1L-0T']);
    sizeBarTitles(host);
    const settled = widthOf(host, '--bar-value-w');
    for (let i = 0; i < 12; i++) sizeBarTitles(host);
    assertEq(widthOf(host, '--bar-value-w'), settled, 'still the width the first measurement found');
});

test('sizeBarTitles: the title column is stable too, and always was', () => {
    // The control. It measures the inner SPAN, which no rule sizes, and never ratcheted, which is how the two columns behaving differently pointed at the cause.
    const host = buildBars(['1W-0L-0T']);
    sizeBarTitles(host);
    const first = widthOf(host, '--bar-title-w');
    sizeBarTitles(host);
    assertEq(widthOf(host, '--bar-title-w'), first, 'unchanged');
});

test('sizeBarTitles: WIDER content still widens the column', () => {
    // The fix must not freeze the column; it must stop it growing without cause. A longer value is a cause.
    const host = buildBars(['1-0-0']);
    sizeBarTitles(host);
    const narrow = parseFloat(widthOf(host, '--bar-value-w'));
    host.querySelector('.bar-value').textContent = '1234W-1234L-1234T';
    sizeBarTitles(host);
    const wide = parseFloat(widthOf(host, '--bar-value-w'));
    assert(wide > narrow, `a longer value widens it: ${narrow} -> ${wide}`);
});

test('sizeBarTitles: a container with no rows publishes nothing and breaks nothing', () => {
    const host = document.getElementById('sandbox');
    host.innerHTML = '';
    host.style.removeProperty('--bar-value-w');
    sizeBarTitles(host);
    assertEq(widthOf(host, '--bar-value-w'), '', 'no rows, no width');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
