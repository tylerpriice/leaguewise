// Unit tests for the pure profile ribbon builder (profile-ribbon.js). Open tests/profile-ribbon.test.html through any static server; green means every assertion held. Fixtures come from tests/fixtures/profile-ribbon.json, and expected values are hand-computed from tests/fixtures/profile-ribbon.md, never from running the code.
import { buildProfileRibbonHtml } from '../src/views/profile-ribbon.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function loadFixtures() {
    const res = await fetch('fixtures/profile-ribbon.json');
    return res.json();
}
const F = await loadFixtures();

// A stub formatStatValue: one argument, returns a fixed, recognisable string per input so a test can assert both call arguments and call count without depending on real formatting rules.
const fmt = v => `v(${v})`;

test('empty category list renders nothing at all', () => {
    assert(buildProfileRibbonHtml({ of: 8, categories: [] }, {}) === '', 'empty string, not an empty wrapper');
});

test('one cell per category, in the CALLER\'s own array order, never re-sorted', () => {
    const html = buildProfileRibbonHtml(F.outOfOrder, { formatStatValue: fmt });
    const order = [...html.matchAll(/pr-cell-label">([A-Z]+)</g)].map(m => m[1]);
    assert(order.join(',') === 'THIRD,FIRST,SECOND', `renders in input order regardless of rank - got ${order.join(',')}`);
});

test('each cell shows the label over "#rank"', () => {
    const html = buildProfileRibbonHtml(F.small, { formatStatValue: fmt });
    assert(html.includes('<span class="pr-cell-label">HR</span><span class="pr-cell-rank">#1</span>'), 'label then rank, stacked');
});

test('--pr-t is linear: 0 at rank 1, 1 at rank === of, evenly spaced between', () => {
    // F.small has of=10; HR rank 1 -> t=0; ERA rank 10 -> t=1; AVG rank 5 -> t=4/9.
    const html = buildProfileRibbonHtml(F.small, { formatStatValue: fmt });
    assert(html.includes('--pr-t:0"') || html.includes('--pr-t:0 '), 'rank 1 -> t=0');
    assert(html.includes(`--pr-t:${(4 / 9)}`), 'rank 5 of 10 -> t=4/9 (AVG)');
    assert(html.includes('--pr-t:1"'), 'rank === of -> t=1 (ERA)');
});

test('of=1 (a single category, no spread) never divides by zero: t=0', () => {
    const html = buildProfileRibbonHtml(F.single, { formatStatValue: fmt });
    assert(html.includes('--pr-t:0"'), 'of>1 guard keeps t at 0 rather than NaN');
});

test('the frame L2 anchor: DINT rank 7 of 11 -> t = 6/10 = 0.6, hover reads the exact mockup line', () => {
    const html = buildProfileRibbonHtml(F.large, { formatStatValue: fmt });
    assert(html.includes('--pr-t:0.6"'), 'DINT (rank 7 of 11) -> t=0.6');
    assert(html.includes('data-tooltip="DINT &middot; v(12) &middot; #7 of 11 &middot; league median v(14)"')
        || html.includes('data-tooltip="DINT · v(12) · #7 of 11 · league median v(14)"'), 'hover text matches the contract\'s exact template with the mockup\'s own DINT figures');
});

test('formatStatValue is called once for value and once for median, independently, per cell', () => {
    const calls = [];
    const spy = v => { calls.push(v); return `f${v}`; };
    buildProfileRibbonHtml(F.single, { formatStatValue: spy });
    assert(calls.length === 2, 'two calls for one category: value then median');
    assert(calls[0] === 5 && calls[1] === 5, 'called with the raw numeric value and median');
});

test('an inverse category formats identically to a normal one - the flag is carried, not branched on', () => {
    const html = buildProfileRibbonHtml(F.small, { formatStatValue: fmt });
    // E (id "6") is inverse: true, rank 7, value 61, median 54.
    assert(html.includes('#7 of 10 &middot; league median v(54)') || html.includes('#7 of 10 · league median v(54)'), 'inverse category value/median format through the same call as any other');
});

test('the scale line is gone (B228 item 2/S73): no .pr-scale, no "categor" anywhere', () => {
    // "categor" (not "#1 of" alone) is the safe needle, because a per-cell hover legitimately contains "#1 of N" for any category that happens to rank first, which F.tieTop's own name guarantees. Only the retired scale line ever printed the word "category"/"categories".
    const html = buildProfileRibbonHtml(F.tieTop, { formatStatValue: fmt });
    assert(!html.includes('pr-scale'), 'no .pr-scale wrapper at all');
    assert(!/categor/i.test(html), 'no trace of the retired scale line\'s own wording');
});

test('the ribbon still renders, unaffected, for the fixture that used to prove the "none" case', () => {
    const html = buildProfileRibbonHtml(F.noBottom, { formatStatValue: fmt });
    const cellCount = (html.match(/class="pr-cell"/g) || []).length;
    assert(cellCount === F.noBottom.categories.length, 'the ribbon itself does not care whether anyone sits at rank === of');
});

test('never prints the words "Wins" or "Bleeds"', () => {
    const html = buildProfileRibbonHtml(F.large, { formatStatValue: fmt });
    assert(!/Wins|Bleeds/.test(html), 'the ribbon carries no trace of the retired chip-group wording');
});

test('30-ish categories (F.large) still renders exactly one cell per category, no capping', () => {
    const html = buildProfileRibbonHtml(F.large, { formatStatValue: fmt });
    const cellCount = (html.match(/class="pr-cell"/g) || []).length;
    assert(cellCount === F.large.categories.length, `every category gets a cell, got ${cellCount} of ${F.large.categories.length}`);
});

test('XSS: a hostile label is escaped in the cell AND in the hover text', () => {
    const html = buildProfileRibbonHtml(F.xss, { formatStatValue: fmt });
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 2, 'escaped in the cell label and the hover tooltip');
});

test('the local escapeHtml fallback and formatStatValue fallback both work with no opts at all', () => {
    const html = buildProfileRibbonHtml(F.single, {});
    assert(html.includes('>ONLY<'), 'label renders via the default escape path');
    assert(html.includes('data-tooltip="ONLY &middot; 5 &middot; #1 of 1 &middot; league median 5"')
        || html.includes('data-tooltip="ONLY · 5 · #1 of 1 · league median 5"'), 'default formatStatValue is String(v)');
});

// Report ---------------------------------------------------------------------------

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
