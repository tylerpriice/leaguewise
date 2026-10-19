// Unit tests for quality and blown quality starts (pitching-starts.js). Open tests/pitching-starts.test.html through any static server; green means every assertion held. Every start is invented, one per boundary of the definition, and every answer is computed by hand in tests/fixtures/pitching-starts.md, never from a run of the module.
import { qualityStart, blownQualityStart, startsSummary } from '../src/engines/pitching-starts.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const FIX = await (await fetch('fixtures/pitching-starts.json')).json();
// JSON cannot carry NaN, so the sixth unreadable line is built here, as the contract says.
const UNREADABLE = [...FIX.unreadable, { outs: NaN, earnedRuns: 1 }];
const label = s => `${s.outs} outs, ${s.earnedRuns} ER`;

test('qualityStart: every boundary start as hand-computed', () => {
    FIX.starts.forEach(s => assertEq(qualityStart(s), s.quality, label(s)));
});

test('blownQualityStart: every boundary start as hand-computed', () => {
    FIX.starts.forEach(s => assertEq(blownQualityStart(s), s.blown, label(s)));
});

test('the two readings: 18 outs is the line, and 15 to 17 is the blown band', () => {
    assertEq(qualityStart({ outs: 18, earnedRuns: 3 }), true, 'the least a quality start can be');
    assertEq(qualityStart({ outs: 17, earnedRuns: 0 }), false, 'one out short is not one');
    assertEq(blownQualityStart({ outs: 14, earnedRuns: 0 }), null, '4.2 innings was never in reach');
    assertEq(blownQualityStart({ outs: 18, earnedRuns: 4 }), null, 'six banked with four runs is neither, not blown');
    assertEq(blownQualityStart({ outs: 15, earnedRuns: 5 }), null, 'five runs is further than one run short');
});

test('no start is both a quality start and a blown one', () => {
    for (let outs = 0; outs <= 27; outs++) {
        for (let er = 0; er <= 8; er++) {
            const line = { outs, earnedRuns: er };
            if (qualityStart(line) && blownQualityStart(line) !== null) throw new Error(`${outs}/${er} is both`);
        }
    }
});

test('an unreadable line is null from both, never a guessed zero', () => {
    UNREADABLE.forEach((line, i) => {
        assertEq(qualityStart(line), null, `unreadable ${i} quality`);
        assertEq(blownQualityStart(line), null, `unreadable ${i} blown`);
    });
    assertEq(qualityStart({ outs: 0, earnedRuns: 4 }), false, 'zero outs with runs is a real start, read');
});

test('startsSummary: the fourteen boundary starts', () => {
    assertJson(startsSummary(FIX.starts), FIX.summary, 'quality 3, hook 3, runs 3, neither 2');
});

test('startsSummary: the unreadable lines are counted, not dropped', () => {
    assertJson(startsSummary([...FIX.starts, ...UNREADABLE]), FIX.summaryWithUnreadable, 'starts 20, unread 6');
});

test('startsSummary: the counts are disjoint and nothing falls between them', () => {
    const s = startsSummary([...FIX.starts, ...UNREADABLE]);
    assertEq(s.blown, s.blownHook + s.blownRuns, 'blown is hook plus runs');
    // Rows 7, 8 and 11 are none of the named buckets, so the named ones fall three short of starts.
    assertEq(s.starts - (s.quality + s.blown + s.neither + s.unread), 3, 'the three starts that were none of them');
});

test('startsSummary: no list, an empty one or null gives every count 0', () => {
    const zero = { starts: 0, quality: 0, blown: 0, blownHook: 0, blownRuns: 0, neither: 0, unread: 0 };
    assertJson(startsSummary([]), zero, 'empty');
    assertJson(startsSummary(null), zero, 'null');
    assertJson(startsSummary(undefined), zero, 'undefined');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed: results.length - passed, total: results.length, failures: results.filter(r => !r.ok) };
