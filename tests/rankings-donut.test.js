// Unit tests for the pure Team Rankings donut renderer (rankings-donut.js). Open tests/rankings-donut.test.html through any static server - green means every assertion held. See tests/fixtures/rankings-donut.md for the frozen contract these values are computed against.
import { buildRankingsDonutHtml, escapeHtmlLocal } from '../rankings-donut.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const MATCH_COLUMNS = [
    { label: 'Record', align: 'right' },
    { label: 'Win %', align: 'right' },
    { label: 'Last 5', align: 'left' },
    { label: 'Behind', align: 'right' },
];

// A hand-built 4-team H2H fixture, hand-computed the same way the mockup's own J2 frame was.
const TEAMS_4 = [
    { id: 1, name: 'Alpha', abbrev: 'Alpha', color: '#e63946', share: 0.27, cells: ['11-8-1', '0.575', '', '-'], dots: ['w', 'l', 'w', 'w', 't'] },
    { id: 2, name: 'Bravo', abbrev: 'Bravo', color: '#3a86ff', share: 0.27, cells: ['11-10-0', '0.524', '', '-'], dots: ['w', 'w', 'l', 'w', 'w'] },
    { id: 3, name: 'Charlie', abbrev: 'Charlie', color: '#ffd166', share: 0.24, cells: ['10-10-1', '0.500', '', '1'], dots: ['l', 'w', 'l', 'w', 'l'] },
    { id: 4, name: 'Delta', abbrev: 'Delta', color: '#2ec4b6', share: 0.22, cells: ['9-12-0', '0.429', '', '2'], dots: ['l', 'l', 'w', 'l', 'l'] },
];

function makeTeams(n, prefix = 'Team') {
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: `${prefix}${i + 1}`,
        color: `#${(i * 111111 % 0xffffff).toString(16).padStart(6, '0')}`,
        share: 1 / n,
        cells: [`${n - i}-${i}-0`, (0.6 - i * 0.02).toFixed(3), '', String(i)],
        dots: ['w', 'l', 'w', 'l', 'w'],
    }));
}

test('empty rows render nothing at all', () => {
    assert(buildRankingsDonutHtml({ rows: [] }) === '', 'empty string, not an empty wrapper div');
});

test('4 teams: a single-column table, the dots column rendered as dots, not text', () => {
    const html = buildRankingsDonutHtml({ rows: TEAMS_4, columns: MATCH_COLUMNS, dotsColumnIndex: 2, centerSubtitle: '11-8-1 · leads' }, {});
    assert(!html.includes('rkd-side-two'), 'one column under eleven teams');
    assert((html.match(/class="rkd-table"/g) || []).length === 1, 'exactly one table');
    assert((html.match(/rkd-dot /g) || []).length === 20, '5 dots x 4 teams = 20 dot spans');
    assert(!html.includes('rkd-legend'), 'no legend at this scale');
});

test('4 teams: the centre names the leader (rows[0]) with the caller\'s own subtitle', () => {
    const html = buildRankingsDonutHtml({ rows: TEAMS_4, columns: MATCH_COLUMNS, dotsColumnIndex: 2, centerSubtitle: '11-8-1 · leads' }, {});
    assert(html.includes('class="rkd-center-name"><title>Alpha</title>Alpha<'), 'Alpha (rows[0]) is named in the centre, its own hover title first');
    assert(html.includes('class="rkd-center-sub">11-8-1 · leads<'), 'the caller\'s own subtitle prints verbatim');
});

test('every row draws one slice, coloured with its own row.color, in rows[] order from 12 o\'clock', () => {
    const html = buildRankingsDonutHtml({ rows: TEAMS_4, columns: MATCH_COLUMNS, dotsColumnIndex: 2 }, {});
    const sliceCount = (html.match(/class="rkd-slice"/g) || []).length;
    assert(sliceCount === 4, 'one slice per row');
    assert(html.indexOf('fill="#e63946"') < html.indexOf('fill="#3a86ff"'), 'Alpha\'s slice (rows[0]) is drawn before Bravo\'s');
});

test('a share of 0 draws no slice at all - not a fabricated minimum sliver', () => {
    const rows = [
        { id: 1, name: 'Alpha', color: '#e63946', share: 1, cells: ['1-0-0'], dots: null },
        { id: 2, name: 'Zero', color: '#000000', share: 0, cells: ['0-0-0'], dots: null },
    ];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'Record', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert((html.match(/class="rkd-slice"/g) || []).length === 1, 'only the real share draws a slice');
    assert(html.includes('>Zero<'), 'Zero still gets its own table row, just no slice');
});

test('a single row holding the whole share draws a complete ring, not a degenerate arc', () => {
    const rows = [{ id: 1, name: 'Solo', color: '#e63946', share: 1, cells: ['1-0-0'], dots: null }];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'Record', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert((html.match(/class="rkd-slice"/g) || []).length === 1, 'one slice, the whole ring');
    assert(html.includes('Z'), 'a real closed path, not an empty one');
});

test('a slice narrower than a twentieth of the ring (18 degrees) carries no label of its own', () => {
    const rows = [
        { id: 1, name: 'Giant', color: '#e63946', share: 0.97, cells: ['1'] },
        { id: 2, name: 'Sliver', color: '#3a86ff', share: 0.03, cells: ['2'] },
    ];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert(html.includes('class="rkd-slice-label">Giant<'), 'the wide slice (97% of 360 = 349.2deg) carries its own label');
    assert(!html.includes('class="rkd-slice-label">Sliver<'), '3% of 360 = 10.8deg, under the 18deg floor, carries none - still named in the table below');
    assert(html.includes('>Sliver<'), 'Sliver is still named, just in the table, not on its own sliver');
});

test('a slice at exactly a twentieth of the ring (18 degrees) still carries its own label - "narrower than", not "at or narrower than"', () => {
    const rows = [
        { id: 1, name: 'Giant', color: '#e63946', share: 0.95, cells: ['1'] },
        { id: 2, name: 'Exact', color: '#3a86ff', share: 0.05, cells: ['2'] },
    ];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert(html.includes('class="rkd-slice-label">Exact<'), '5% of 360 = 18deg exactly - not narrower than the floor, so it still gets a label');
});

// ==== R6/S52b (the owner's live measurement on full-mlb): full names overflowed the ring, the centre and the table (truncating "Bristling Badgers" to "Bristling B") - the abbreviation the legend and the bars already print is what actually fits everywhere, the full name moving to a hover. ====

const NAME_VS_ABBREV = [
    { id: 1, name: 'Bristling Badgers', abbrev: 'BRYCE', color: '#e63946', share: 0.6, cells: ['1'] },
    { id: 2, name: 'Wandering Comet Chasers', abbrev: 'TOAST', color: '#3a86ff', share: 0.4, cells: ['2'] },
];

test('B221 R6/S52b: the slice label, the centre and the table/legend all show the ABBREVIATION, never the full name', () => {
    const html = buildRankingsDonutHtml({ rows: NAME_VS_ABBREV, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1, centerSubtitle: 'leads' }, {});
    assert(html.includes('class="rkd-slice-label">BRYCE<'), 'the slice label is the abbreviation');
    assert(!html.includes('class="rkd-slice-label">Bristling Badgers<'), 'never the full name on the ring');
    assert(html.includes('>BRYCE<') && html.includes('class="rkd-center-name">'), 'the centre also shows the abbreviation');
    assert(!html.includes('class="rkd-center-name">') || !html.slice(html.indexOf('rkd-center-name')).startsWith('class="rkd-center-name">Bristling Badgers'), 'the centre never shows the full name as its own text');
    assert(html.includes('>BRYCE</td>') || html.includes('>BRYCE<'), 'the table cell shows the abbreviation');
});

test('B221 R6/S52b: the full name still names every slice and every table row, as a hover title', () => {
    const html = buildRankingsDonutHtml({ rows: NAME_VS_ABBREV, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert(html.includes('<title>Bristling Badgers</title>'), 'the slice carries the full name in a native SVG title');
    assert(html.includes('title="Bristling Badgers"'), 'the table row\'s own name cell carries the full name as its title attribute');
    assert(html.includes('<title>Wandering Comet Chasers</title>') && html.includes('title="Wandering Comet Chasers"'), 'every row, not just the first');
});

test('B221 R6/S52b: a row with no real abbreviation falls back to its full name everywhere, not a blank', () => {
    const rows = [{ id: 1, name: 'No Abbrev Here', color: '#e63946', share: 1, cells: ['1'] }];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1 }, {});
    assert(html.includes('class="rkd-slice-label">No Abbrev Here<'), 'falls back to the full name when abbrev is absent');
});

test('B221 R6/S52b: the leader\'s own slice pulls 4px outward along its own mid-angle; no other slice moves', () => {
    // Two equal-share (half each) rows starting at 12 o'clock: the leader (rows[0]) spans -90deg to 90deg, mid exactly 0deg (due east) - its own pull is (cos(0)*4, sin(0)*4) = (4, 0), a pure horizontal shift with no vertical component at all.
    const rows = [
        { id: 1, name: 'Leader', abbrev: 'LEAD', color: '#e63946', share: 0.5, cells: ['1'] },
        { id: 2, name: 'Second', abbrev: 'SECOND', color: '#3a86ff', share: 0.5, cells: ['2'] },
    ];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: 'X', align: 'right' }], dotsColumnIndex: -1, size: 132 }, {});
    // size=132: shared centre (66, 66), rOuter=64. The leader's own arc starts at angle -90deg (12 o'clock) from its OWN pulled centre (66+4, 66) = (70, 66): x=70+64*cos(-90)=70, y=66+64*sin(-90)=2 - "M 70.0 2.0", not the shared-centre "M 66.0 2.0".
    assert(html.includes('M 70.0 2.0'), `the leader's own arc starts from the pulled centre (70, 66), got: ${html.slice(0, 400)}`);
    assert(!html.includes('M 66.0 2.0'), 'the leader does NOT start from the un-pulled shared centre');
    // The second slice keeps the ORIGINAL, shared centre - its own arc starts at angle 90deg (6 o'clock) from (66, 66): x=66+64*cos(90)=66, y=66+64*sin(90)=130 - "M 66.0 130.0".
    assert(html.includes('M 66.0 130.0'), 'the non-leader slice starts from the shared, un-pulled centre');
});

test('11 teams: the table splits into two columns of up to ten, the dots column dropped', () => {
    const rows = makeTeams(11);
    const html = buildRankingsDonutHtml({ rows, columns: MATCH_COLUMNS, dotsColumnIndex: 2, centerSubtitle: 'leads' }, {});
    assert(html.includes('rkd-side-two'), 'the two-column wrapper renders past ten teams');
    assert((html.match(/class="rkd-table"/g) || []).length === 2, 'exactly two tables');
    assert(!html.includes('rkd-dot '), 'no dots column at this scale, even though dotsColumnIndex was passed - the caller\'s own contract note');
    assert(!html.includes('rkd-legend'), 'still a table, not a legend, at eleven teams');
});

test('11 teams: the dropped dots column takes its own header with it, not just its cell content', () => {
    const rows = makeTeams(11);
    const html = buildRankingsDonutHtml({ rows, columns: MATCH_COLUMNS, dotsColumnIndex: 2 }, {});
    assert(!html.includes('>Last 5<'), 'the "Last 5" header itself is gone at this scale, not sitting over blank cells - real bug measured on full-nfl-2025 (11 teams) before this fix');
    assert(html.includes('>Record<') && html.includes('>Win %<') && html.includes('>Behind<'), 'the other three headers still render');
});

test('11 teams: the first column holds ceil(n/2), the second the rest', () => {
    const rows = makeTeams(11);
    const html = buildRankingsDonutHtml({ rows, columns: MATCH_COLUMNS, dotsColumnIndex: 2 }, {});
    const tableStarts = [];
    let idx = html.indexOf('<table');
    while (idx !== -1) { tableStarts.push(idx); idx = html.indexOf('<table', idx + 1); }
    assert(tableStarts.length === 2, 'two <table> elements');
    const firstTableHtml = html.slice(tableStarts[0], tableStarts[1]);
    const secondTableHtml = html.slice(tableStarts[1]);
    const rowCount = (h) => (h.match(/<tr>/g) || []).length - 1; // minus the header row
    assert(rowCount(firstTableHtml) === 6, 'ceil(11/2) = 6 teams in the first column');
    assert(rowCount(secondTableHtml) === 5, 'the remaining 5 in the second');
});

test('20 teams: still a table (two columns), not yet a legend', () => {
    const rows = makeTeams(20);
    const html = buildRankingsDonutHtml({ rows, columns: MATCH_COLUMNS, dotsColumnIndex: 2 }, {});
    assert(html.includes('rkd-side-two'), 'two columns at twenty');
    assert(!html.includes('rkd-legend'), 'twenty teams is still inside the table\'s own range');
    assert((html.match(/<tr>/g) || []).length === 22, '20 body rows + 2 header rows (one per column)');
});

test('21 teams: past the table\'s own range, a plain legend instead', () => {
    const rows = makeTeams(21);
    const html = buildRankingsDonutHtml({ rows, columns: MATCH_COLUMNS, dotsColumnIndex: 2 }, {});
    assert(html.includes('rkd-legend'), 'the legend renders past twenty teams');
    assert(!html.includes('rkd-table'), 'no table at all at this scale');
    assert((html.match(/rkd-legend-name/g) || []).length === 21, 'every team still named, in the legend');
});

test('category-wins shape: a different column set, no dots column at all, works the same way', () => {
    const columns = [
        { label: 'Category wins', align: 'right' },
        { label: 'Per matchup', align: 'right' },
        { label: 'Behind', align: 'right' },
    ];
    const rows = [
        { id: 1, name: 'Mercury', color: '#3a86ff', share: 0.28, cells: ['181.5', '8.2', '0.0'] },
        { id: 2, name: 'Alpha', color: '#e63946', share: 0.28, cells: ['181.0', '8.2', '0.5'] },
    ];
    const html = buildRankingsDonutHtml({ rows, columns, dotsColumnIndex: -1, centerSubtitle: 'leads by 0.5' }, {});
    assert(html.includes('>Category wins<') && html.includes('>Per matchup<'), 'the category-wins header set renders');
    assert(!html.includes('rkd-dot '), 'no dots column for category wins, ever');
    assert(html.includes('>181.5<') && html.includes('>8.2<'), 'the pre-formatted figures print verbatim');
});

test('XSS: a hostile team name, colour, column label and cell value all render escaped', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const rows = [{ id: 1, name: hostile, color: hostile, share: 1, cells: [hostile], dots: [] }];
    const html = buildRankingsDonutHtml({ rows, columns: [{ label: hostile, align: 'right' }], dotsColumnIndex: -1, centerSubtitle: hostile }, {});
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped anywhere');
    assert((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 5, 'escaped in the slice label, the centre name, the centre subtitle, the column header, and the cell');
});

test('the local escapeHtml fallback matches the app-wide escaping rules (no opts.escapeHtml passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
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
