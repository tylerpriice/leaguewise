// Unit tests for the pure team/club picker rail (player-rail.js). Open tests/player-rail.test.html through any static server - green means every assertion held. See tests/fixtures/player-rail.md for the frozen contract these values are computed against.
import { buildPlayerRailHtml, escapeHtmlLocal } from '../player-rail.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// R2/S51 (frame I1): a fantasy team is a crest now - crestHtml is pre-built by the caller (buildTeamCrestHtml, images.js), the same way a club's is pre-built by opts.crestHtml. This module never builds one itself; the fixture's own stub stands in for the caller's real markup.
const TEAMS = [
    { id: 1, label: 'ALFA', color: '#e63946', crestHtml: '<span class="fcrest-stub">ALFA</span>' },
    { id: 2, label: 'BRVO', color: '#2ec4b6', crestHtml: '<span class="fcrest-stub">BRVO</span>' },
];
const CLUBS = [
    { id: 113, abbrev: 'CIN', name: 'Reds' },
    { id: 121, abbrev: 'NYM', name: 'Mets' },
];
const crestHtml = (abbrev) => `<span class="crest-stub">${abbrev}</span>`;

test('nothing to show at all: no teams and no schedule renders nothing', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: [], clubs: null }, { crestHtml });
    assert(html === '', 'empty string, not an empty wrapper div');
});

test('a schedule in hand with zero clubs present still draws an empty crest row - a real [] differs from null', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: [], clubs: [] }, { crestHtml });
    assert(html.includes('<div class="lb-rail-crests"></div>'), 'an empty crest row, not omitted');
});

test('B220 R6/Amendment 3: no fantasy teams present (preseason, every player a free agent) still gets an All chip beside real club crests', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'pro', id: 113 }, teams: [], clubs: CLUBS }, { crestHtml });
    assert(html.includes('<div class="lb-rail-fteams"></div>'), 'the fantasy-crest row still renders (empty) with zero real teams');
    assert(html.includes('>All<'), 'the All chip renders even with an empty teams list');
    assert(!html.includes('class="lb-rail-chip active" data-kind="all"'), 'All itself is not active while a club is picked - it is there to clear it');
});

// R2/Amendment 4: BOTH captions are gone now, not only "Clubs" - the divider and each crest's own hover title are what tell the two groups apart.
test('B221 R2/Amendment 4: no caption anywhere in the rail, even with both groups present', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: CLUBS }, { crestHtml });
    assert(!html.includes('>Teams<') && !html.includes('>Clubs<'), 'neither group carries a caption');
    assert(!html.includes('lb-rail-lab'), 'the caption class itself never appears - Amendment 4 retired it entirely');
});

test('teams only (no schedule): the Clubs group is entirely absent, no divider', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: null }, { crestHtml });
    assert(html.includes('lb-rail-fteams'), 'the fantasy-crest row renders');
    assert(!html.includes('lb-rail-crests'), 'no clubs row at all');
    assert(!html.includes('lb-rail-divider'), 'no dangling divider beside an absent group');
});

test('"All" is always the first entry, added by this module - never part of the teams input', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: null }, { crestHtml });
    const allIdx = html.indexOf('>All<');
    const firstTeamIdx = html.indexOf('ALFA');
    assert(allIdx !== -1 && firstTeamIdx !== -1 && allIdx < firstTeamIdx, 'All renders before every real team crest');
    assert(html.includes('class="lb-rail-chip active" data-kind="all" data-id="">All<'), 'All is active when active.kind is all');
});

test('B221 R2/S51: a fantasy team crest is exactly opts-free markup - team.crestHtml verbatim, the caller\'s own build', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: null }, { crestHtml });
    assert(html.includes('<span class="fcrest-stub">ALFA</span>'), 'the pre-built crest renders verbatim, this module does not touch it');
    assert(html.includes('<span class="fcrest-stub">BRVO</span>'), 'every team in the list gets its own crest');
});

test('B221 R2/S51: a team\'s legend colour rides as the --fteam-color custom property, not a dot; a null colour omits the property', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: null }, { crestHtml });
    assert(html.includes('style="--fteam-color:#e63946"'), 'ALFA\'s own colour rides as the custom property');
    assert(html.includes('style="--fteam-color:#2ec4b6"'), 'BRVO\'s own colour, independently');
    const noColor = buildPlayerRailHtml({
        active: { kind: 'all', id: null },
        teams: [{ id: 3, label: 'CHRL', color: null, crestHtml: '<span class="fcrest-stub">CHRL</span>' }],
        clubs: null,
    }, { crestHtml });
    assert(!noColor.includes('--fteam-color'), 'no custom property at all for a null colour - the CSS fallback draws instead');
});

test('every fantasy team carries its own name as a native title attribute', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: null }, { crestHtml });
    assert(html.includes('title="ALFA"') && html.includes('title="BRVO"'), 'each crest hovers its own team\'s label');
});

test('the active fantasy team carries the active modifier, and only that one', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'fantasy', id: 2 }, teams: TEAMS, clubs: null }, { crestHtml });
    assert(html.includes('class="lb-rail-fteam active" data-kind="fantasy" data-id="2"'), 'BRVO (id 2) is active');
    assert(!html.includes('class="lb-rail-fteam active" data-kind="fantasy" data-id="1"'), 'ALFA (id 1) is not');
    assert(!html.includes('class="lb-rail-chip active" data-kind="all"'), 'All is not active while a team is picked');
});

test('clubs render as crests, each via opts.crestHtml, each carrying its own name as a title', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: [], clubs: CLUBS }, { crestHtml });
    assert(html.includes('<span class="crest-stub">CIN</span>'), 'the injected crestHtml builder is used verbatim');
    assert(html.includes('title="Reds"') && html.includes('title="Mets"'), 'every crest carries its own club name as a native title');
});

test('B220 R5/Amendment 2: the active club is ringed, and no name ever prints beside the row', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'pro', id: 113 }, teams: [], clubs: CLUBS }, { crestHtml });
    assert(html.includes('class="lb-rail-crest active" data-kind="pro" data-id="113"'), 'CIN (id 113) carries the active modifier');
    assert(!html.includes('class="lb-rail-crest active" data-kind="pro" data-id="121"'), 'NYM does not');
    assert(!html.includes('lb-rail-active-label'), 'the ring is the whole signal - no inline label, even for the active club');
});

test('no club active: still no active label at all', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: [], clubs: CLUBS }, { crestHtml });
    assert(!html.includes('lb-rail-active-label'), 'the label is omitted outright when nothing is active');
});

test('both groups present: exactly one divider between them', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: TEAMS, clubs: CLUBS }, { crestHtml });
    assert((html.match(/lb-rail-divider/g) || []).length === 1, 'one divider, not zero or two');
    const teamsIdx = html.indexOf('lb-rail-fteams');
    const dividerIdx = html.indexOf('lb-rail-divider');
    const clubsIdx = html.indexOf('lb-rail-crests');
    assert(teamsIdx < dividerIdx && dividerIdx < clubsIdx, 'the divider sits between the two groups, not before or after both');
});

test('XSS: a hostile team label, colour and club name all render escaped, never as live markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildPlayerRailHtml({
        active: { kind: 'pro', id: 9 },
        teams: [{ id: 9, label: hostile, color: hostile, crestHtml: '<span class="fcrest-stub">X</span>' }],
        clubs: [{ id: 9, abbrev: 'XX', name: hostile }],
    }, { crestHtml });
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped anywhere');
    assert((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 3, 'escaped in the crest\'s own title, its --fteam-color style value, and the club\'s active title');
});

test('the local escapeHtml fallback matches the app-wide escaping rules (no opts.escapeHtml passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('no opts.crestHtml passed: the local fallback renders an empty crest rather than throwing', () => {
    const html = buildPlayerRailHtml({ active: { kind: 'all', id: null }, teams: [], clubs: CLUBS });
    assert(html.includes('<div class="lb-rail-crests">'), 'the row still renders around whatever crestHtml returns');
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
