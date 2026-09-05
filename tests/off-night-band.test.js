// Unit tests for the pure NIGHTS band builder (off-night-band.js). Open tests/off-night-band.test.html through any static server - green means every assertion held. State 1 is driven by tests/fixtures/off-night-band-states.json's own withHoleAndUnknown entry, which mirrors tests/fixtures/off-night.json (the data lane's own frozen real-week instance, ad36440-style, off tests/off-night.fixture.gen.html) - so the coverage shape these tests exercise cannot drift from what rosterNightCoverage() actually emits.
import { buildNightsBandHtml, escapeHtmlLocal } from '../off-night-band.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function loadStates() {
    const res = await fetch('fixtures/off-night-band-states.json');
    return res.json();
}
const states = await loadStates();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const labelOf = period => DAY_NAMES[period % 7];

test('missing coverage renders nothing at all', () => {
    assert(buildNightsBandHtml(null, 'Skaters', { labelOf }) === '', 'null coverage');
});

test('the role label appears, escaped, as the band heading', () => {
    const html = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    assert(html.includes('>Skaters<'), 'the role label reaches the rendered heading');
});

test('one cell per night, in period order, each showing playing over idle', () => {
    const html = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    assert((html.match(/<div class="nb-day(?:"| )/g) || []).length === 7, 'one nb-day cell per byPeriod entry (161..167)');
    // Period 161 is a Sunday (161 % 7 === 0), 2 playing, 1 idle.
    const firstCellStart = html.indexOf('<div class="nb-days">') + '<div class="nb-days">'.length;
    const firstCellEnd = html.indexOf('</div>', html.indexOf('nb-day-idle', firstCellStart));
    const firstCell = html.slice(firstCellStart, firstCellEnd);
    assert(firstCell.includes('>Sun<'), 'the first night carries its own day label, via labelOf');
    assert(firstCell.includes('>2<'), 'playing count on the cell face');
    assert(firstCell.includes('1 idle'), 'idle count on the cell face');
});

test('a night the given slots cannot fill carries the short tone class; a night with no slot count carries neither', () => {
    const withSlots = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    assert((withSlots.match(/nb-day-short/g) || []).length === 7, 'all seven nights have emptySlots > 0 (2 or 3 against 4 slots)');
    const noSlots = buildNightsBandHtml(states.fullyKnownNoSlots.coverage, 'Goalies', { labelOf });
    assert(!noSlots.includes('nb-day-short'), 'emptySlots === null asserts no shortfall - no tone at all');
});

test('the thinnest night, and only the first tie, carries the thinnest marker', () => {
    const html = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    // Four of the seven nights (162, 163, 165, 167) tie at playing:1, the round's own minimum.
    assert((html.match(/nb-day-thinnest/g) || []).length === 1, 'exactly one night marked, even with four-way tie');
    const idx = html.indexOf('nb-day-thinnest');
    const cellStart = html.lastIndexOf('<div class="nb-day', idx);
    const cellText = html.slice(cellStart, html.indexOf('</div>', html.indexOf('nb-day-idle', cellStart)));
    assert(cellText.includes(`>${labelOf(162)}<`), 'period 162 is the FIRST of the four-way tie in period order, so it wins the marker');
});

test('the headline names the first-tied thinnest night and the playing/players fraction, two sentences, no colon-dash-semicolon connector', () => {
    const html = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    const period162Label = labelOf(162);
    assert(html.includes(`${period162Label} is your lightest night this round. 1 of 3 is playing.`),
        'exact headline sentence: period 162 is the first night at the round minimum (playing:1), singular "is"');
    assert(!html.includes(' - 1 of 3') && !html.includes(': 1 of 3'), 'no dash or colon standing in for the sentence break');
});

test('the headline pluralises "is"/"are" correctly around the thinnest count', () => {
    const html = buildNightsBandHtml(states.oneNightRound.coverage, 'Skaters', { labelOf });
    assert(html.includes('3 are playing.'), 'thinnest 3 (plural) uses "are"');
});

test('the headline prints "lightest", never the banned "thinnest" (R4, VOICE.md)', () => {
    const html = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    assert(html.includes('lightest night'), 'the printed word is lightest');
    assert(!html.includes('thinnest night'), 'thinnest never reaches the rendered sentence, only the private nb-day-thinnest class');
});

test('unknownClub is said once, above the nights, only when non-zero', () => {
    const withUnknown = buildNightsBandHtml(states.withHoleAndUnknown.coverage, 'Skaters', { labelOf });
    assert(withUnknown.includes('1 player has no club on this schedule.'), 'singular phrasing at 1');
    const noneUnknown = buildNightsBandHtml(states.fullyKnownNoSlots.coverage, 'Goalies', { labelOf });
    assert(!noneUnknown.includes('no club on this schedule'), 'omitted outright at zero, not a "0 players" placeholder');
});

test('a one-night round still renders: one cell, and the headline still names it', () => {
    const html = buildNightsBandHtml(states.oneNightRound.coverage, 'Skaters', { labelOf });
    assert((html.match(/<div class="nb-day(?:"| )/g) || []).length === 1, 'a single cell for a single-night round');
    assert(html.includes('nb-day-thinnest'), 'the lone night is trivially the thinnest');
    const period200Label = labelOf(200);
    assert(html.includes(`${period200Label} is your lightest night this round. 3 of 3 are playing.`), 'headline still names it');
});

test('escapeHtmlLocal matches the app-wide escaping rules (the fallback when no escapeHtml is passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('XSS: a hostile role label renders escaped, never as live markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildNightsBandHtml(states.oneNightRound.coverage, hostile, { labelOf });
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped in the rendered heading');
});

test('a hostile labelOf return value renders escaped too', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildNightsBandHtml(states.oneNightRound.coverage, 'Skaters', { labelOf: () => hostile });
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 1, 'escaped wherever labelOf\'s return value lands');
});

test('the local labelOf fallback prints the bare period number when no opts.labelOf is passed', () => {
    const html = buildNightsBandHtml(states.oneNightRound.coverage, 'Skaters');
    assert(html.includes('>200<'), 'the local fallback is String(period), a stand-in only');
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
