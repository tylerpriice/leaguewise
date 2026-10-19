// Unit tests for the pure coverage-band builder (coverage-band.js). Open tests/coverage-band.test.html through any static server; green means every assertion held. Driven by tests/fixtures/coverage-band.json, the model's own frozen contract, a real coverageBand() output rather than a hand-typed approximation, so these tests cannot drift from what the model emits.
import { buildCoverageBandHtml, buildCoverageStripHtml, buildCoverageDrawerHtml, buildCoverageDrawerHeadHtml, escapeHtmlLocal,
    buildAddsModeRowHtml, buildRankedAddsHtml } from '../src/views/coverage-band.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const STAT_MAP = { '5': 'HR', '47': 'ERA', '2': 'AVG' };

async function loadFixture() {
    const res = await fetch('fixtures/coverage-band.json');
    return res.json();
}

const fixture = await loadFixture();

test('empty/missing band renders nothing at all', () => {
    assert(buildCoverageBandHtml(null, STAT_MAP) === '', 'null band');
    assert(buildCoverageBandHtml({ categories: [] }, STAT_MAP) === '', 'empty categories array');
});

test('rows render weak-first, held categories keeping the model\'s own order (fixture has one weak, HR, already first)', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    assert(html.indexOf('>HR<') < html.indexOf('>ERA<') && html.indexOf('>ERA<') < html.indexOf('>AVG<'), 'weak (HR) before held (ERA, AVG); held pair keeps its own 47-then-2 order');
});

test('row order: weak categories sort worst-share-first, ahead of every held category, regardless of the order the model gave them', () => {
    const html = buildCoverageBandHtml({
        categories: [
            { id: '1', value: 1, share: 0.9, weak: false, inverse: false, drivers: [], adds: [], swap: null },
            { id: '2', value: 1, share: 0.4, weak: true, inverse: false, drivers: [], adds: [], swap: null },
            { id: '3', value: 1, share: null, weak: true, inverse: false, drivers: [], adds: [], swap: null },
            { id: '4', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [], swap: null },
        ],
    }, { '1': 'Held', '2': 'MidHole', '3': 'NullHole', '4': 'WorstHole' });
    const posOf = name => html.indexOf(`>${name}<`);
    assert(posOf('WorstHole') < posOf('MidHole'), 'lower share sorts first among weak rows');
    assert(posOf('MidHole') < posOf('NullHole'), 'a null share sorts to the back of the weak group, not the front');
    assert(posOf('NullHole') < posOf('Held'), 'every weak row precedes every held row, even one with no share measured yet');
});

test('a weak category (HR, id 5, counting): drivers carry a real sum against the PROJECTED remainder, the horizon named, the shopping list, the swap and its why', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    // Drivers now read against `row.projected` (3), never `row.value` (16, the season's actuals), which would be a mixed-basis sentence. Corner Bat (2) + Utility Bat (1) = 3, matching the fixture's own row.projected exactly. The fixture's window ({ kind: "rest", label: "the rest of the way" }) names the horizon on both sentences.
    assert(html.includes('Corner Bat and Utility Bat carry 3 of your 3 the rest of the way.'), 'the driver sum against the PROJECTED remainder, horizon named');
    assert(!html.includes('of your 16'), 'never the season actual as the drivers\' own denominator');
    assert(html.includes('Slugging Outfielder (FA) would add 5 the rest of the way.'), 'the add, FA-tagged, projected gain, the horizon named every time');
    assert(html.includes('Cheapest to lose: Utility Bat. Carries the least of what you are projected to produce, and none of what you are losing.'), 'the swap sentence and its why, two sentences, both halves named (B237 item 2)');
    assert(html.includes('cvb-row-weak'), 'the weak row class is applied');
});

test('an add on a weak RATE category reads "would improve it by", never "would add", the horizon named for a MATCHUP window this time', () => {
    const html = buildCoverageBandHtml({
        categories: [{
            id: '47', value: 3.2, projected: 3.0, share: 0.1, weak: true, inverse: true, rate: true,
            drivers: [], adds: [{ player: { id: 9, name: 'Trevor Megill' }, gain: 0.031 }], swap: null,
        }],
        window: { kind: 'matchup', label: 'this matchup', matchup: 24, periods: [160], asOf: 160 },
    }, STAT_MAP);
    assert(html.includes('Trevor Megill (FA) would improve it by 0.03 this matchup.'), 'the rate form of the add sentence, a matchup\'s own label');
    assert(!html.includes('would add 0.03'), 'never the counting phrasing on a rate');
});

test('no band.window at all (an older/hand-built band): renders exactly as it did before the amendment - additive, never a required field', () => {
    const html = buildCoverageBandHtml({
        categories: [{
            id: '5', value: 16, share: 0.2, weak: true, inverse: false, rate: false,
            drivers: [{ player: { id: 3, name: 'Corner Bat' }, contribution: 2 }],
            adds: [{ player: { id: 7, name: 'Slugging Outfielder' }, gain: 5 }], swap: null,
        }],
    }, STAT_MAP);
    // No `projected` on the row either, so the OLD denominator (`value`) is what is left to read.
    assert(html.includes('Corner Bat carries 2 of your 16.'), 'falls back to value with no window and no projected field');
    assert(html.includes('Slugging Outfielder (FA) would add 5.'), 'no horizon clause when there is none to name');
});

test('B217 S28b: the remainder rides beside the season headline, in the same horizon words the drivers/adds sentences use', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    // HR: value 16 (the headline), projected 3 (the fixture's own remainder), said once beside the total it is a piece of, not just in the sentences below it.
    assert(html.includes('<span class="cvb-value">16</span><span class="cvb-value-sub">3 the rest of the way</span>'), 'the sub-figure sits right after the headline value, same horizon wording as the drivers line');
});

test('S28b: no projected on the row (no window, an older/hand-built band) renders no sub-figure at all', () => {
    const html = buildCoverageBandHtml({
        categories: [{
            id: '5', value: 16, share: 0.2, weak: true, inverse: false, rate: false,
            drivers: [], adds: [], swap: null,
        }],
    }, STAT_MAP);
    assert(!html.includes('cvb-value-sub'), 'nothing to add beside a headline with no remainder to report');
});

// The drawer's card no longer has a headline-plus-sub-figure pair. It draws the banked-against-to-come bar, which carries the same two numbers (season, remainder) as bar segments, and its replacement test is "drawer: HR's card draws the banked-against-to-come bar" below.

test('the swap sentence renders exactly once, as the band\'s own footer, not inside any one row', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    assert((html.match(/Cheapest to lose/g) || []).length === 1, 'said once for the whole band, not once per weak row');
    assert((html.match(/cvb-swap-footer/g) || []).length === 1, 'exactly one footer element');
    const footerStart = html.indexOf('cvb-swap-footer');
    const lastRowEnd = html.lastIndexOf('cvb-row');
    assert(footerStart > lastRowEnd, 'the footer markup follows every row, not nested inside one');
});

// A null swap means two different things and the footer must not conflate them. `share` is the model's own measured/unmeasured signal (categoryRowHtml reads the same field), present and real for the vetoed case below and absent everywhere for the nothing-yet case, matching a preseason band before any category has a figure to share.
test('band: a null swap with something measured says nobody is spare, never blank', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '2', value: 1, share: 0.9, weak: false, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(html.includes('Nobody here is spare - everyone is carrying something you are losing.'), 'the real null state gets its own sentence');
    assert(!html.includes('Cheapest to lose'), 'no name to give when nobody is left');
});

test('band: a null swap with nothing measured stays silent, not "nobody is spare"', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '2', value: null, share: null, weak: false, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(!html.includes('cvb-swap-footer'), 'no footer at all before anything is measured');
    assert(!html.includes('Nobody here is spare'), 'the real null-state sentence is reserved for a measured roster');
});

test('a strong category (ERA, id 47, a rate): drivers named only, never a summed figure, no adds/swap markup', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    // ERA's own block: isolate it by slicing between its heading and the next one (AVG).
    const start = html.indexOf('>ERA<');
    const eraBlock = html.slice(start, html.indexOf('>AVG<', start));
    assert(eraBlock.includes('Ace Reliever drives it the rest of the way.'), 'the solo driver, singular verb, no number - a rate delta has no unit a reader trusts, horizon named');
    assert(!eraBlock.includes('of your'), 'never the counting-category "carries N of your M" phrasing for a rate');
    assert(!eraBlock.includes('cvb-add'), 'no adds markup for a category already held');
    assert(!eraBlock.includes('cvb-swap'), 'no swap markup for a category already held');
});

test('a counting category with a single driver uses the singular "carries"', () => {
    const html = buildCoverageBandHtml({
        categories: [{
            id: '9', value: 20, share: 0.3, weak: true, inverse: false, rate: false,
            drivers: [{ player: { id: 1, name: 'Solo' }, contribution: 12 }], adds: [], swap: null,
        }],
    }, STAT_MAP);
    assert(html.includes('Solo carries 12 of your 20.'), 'singular verb, one driver, exact hand-computed figures');
});

test('inverse category (ERA): "lower is better" appears exactly once, never a negative number', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    assert((html.match(/lower is better/g) || []).length === 1, 'the note appears exactly once, on the one inverse category');
    assert(!html.includes('-1.5') && !html.includes('−1.5'), 'the driver contribution is never shown as a negative - the model already sign-flips it');
});

test('a non-inverse category never carries the inverse note', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    const start = html.indexOf('>HR<');
    const hrBlock = html.slice(start, html.indexOf('>ERA<', start));
    assert(!hrBlock.includes('lower is better'), 'HR (inverse: false) carries no note');
});

test('coverage bar: fill width comes from share (a fraction), never printed as a number on the surface', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    assert(html.includes('style="width:50%"'), 'ERA/AVG share 0.5 -> 50% fill width');
    assert(!/\b50%\b<\/(span|div)>/.test(html.replace(/style="[^"]*"/g, '')), 'the percentage is a bar width, not text content anywhere in the rendered labels');
});

test('a null-share category draws an empty (zero-width, marked) track, not a claimed zero', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '9', value: null, share: null, weak: true, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(html.includes('cvb-track-none'), 'the track is marked as having no real share to show');
    assert(html.includes('style="width:0%"'), 'zero-width, not a fabricated minimum bar');
    assert(html.includes('>-<'), 'a null value renders the same dash the rest of the app uses for "no figure"');
});

test('no drivers on the roster: a real, blunt sentence, not a blank line', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '9', value: 4, share: 0.2, weak: true, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(html.includes('No one on the roster drives it.'), 'the empty-drivers state is a real sentence');
});

test('a weak category with no available add: says so rather than an empty shopping list', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '9', value: 4, share: 0.2, weak: true, inverse: false, rate: false, drivers: [{ player: { id: 1, name: 'X' }, contribution: 2 }], adds: [], swap: null }],
    }, STAT_MAP);
    assert(html.includes('No available player would move it.'), 'the empty-adds state is a real sentence');
});

// Superseded by "band: a null swap with something measured says nobody is spare, never blank" above. A null swap on a measured roster is now the real "nobody to spare" state, not a silent omission, so this fixture (share: 0.2, a measured row) draws the footer rather than skipping it.
test('a weak category with no swap available, and nothing measured anywhere: the swap line is omitted outright, not a null placeholder', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '9', value: 4, share: null, weak: true, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(!html.includes('cvb-swap'), 'no swap markup at all when nothing is measured');
});

test('three or more drivers use the Oxford comma, both in the named-only (rate) and the summed (counting) form', () => {
    const rateHtml = buildCoverageBandHtml({
        categories: [{
            id: '9', value: 3.5, share: 0.6, weak: false, inverse: false, rate: true,
            drivers: [
                { player: { id: 1, name: 'Alpha' }, contribution: 10 },
                { player: { id: 2, name: 'Beta' }, contribution: 8 },
                { player: { id: 3, name: 'Gamma' }, contribution: 5 },
            ], adds: [], swap: null,
        }],
    }, STAT_MAP);
    assert(rateHtml.includes('Alpha, Beta, and Gamma drive it.'), 'Oxford comma with three or more names, a rate category so no summed figure');

    const countingHtml = buildCoverageBandHtml({
        categories: [{
            id: '9', value: 30, share: 0.6, weak: false, inverse: false, rate: false,
            drivers: [
                { player: { id: 1, name: 'Alpha' }, contribution: 10 },
                { player: { id: 2, name: 'Beta' }, contribution: 8 },
                { player: { id: 3, name: 'Gamma' }, contribution: 5 },
            ], adds: [], swap: null,
        }],
    }, STAT_MAP);
    assert(countingHtml.includes('Alpha, Beta, and Gamma carry 23 of your 30.'), 'Oxford comma still applies with the summed figure - 10+8+5=23');
});

test('an unknown category id falls back to "Stat <id>" rather than throwing', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '999', value: 1, share: 0.5, weak: false, inverse: false, drivers: [], adds: [], swap: null }],
    }, {});
    assert(html.includes('>Stat 999<'), 'the honest fallback, not an invented name');
});

test('XSS: a hostile player/category name renders escaped, never as live markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildCoverageBandHtml({
        categories: [{
            id: '9', value: 4, share: 0.2, weak: true, inverse: false,
            drivers: [{ player: { id: 1, name: hostile }, contribution: 2 }],
            adds: [{ player: { id: 2, name: hostile }, gain: 3 }],
            swap: { player: { id: 3, name: hostile }, cost: 0.1, measured: 1, indispensable: false },
        }],
    }, { '9': hostile });
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped, anywhere it could have leaked in');
    assert((html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length === 4, 'escaped in all four places it was injected: category name, driver, add, swap');
});

test('escapeHtmlLocal matches the app-wide escaping rules (the fallback when no escapeHtml is passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('caller-supplied opts are used in place of every local fallback', () => {
    let escapeCalls = 0, formatCalls = 0;
    const opts = {
        escapeHtml: s => { escapeCalls++; return String(s).toUpperCase(); },
        formatValue: (id, v) => { formatCalls++; return v === null ? 'n/a' : `${v}!`; },
    };
    const html = buildCoverageBandHtml(fixture, STAT_MAP, opts);
    assert(escapeCalls > 0, 'the supplied escapeHtml was actually called');
    assert(formatCalls > 0, 'the supplied formatValue was actually called');
    assert(html.includes('5!'), 'the supplied formatValue reached the rendered gain');
    assert(html.includes('CORNER BAT'), 'the supplied escapeHtml reached the rendered driver name');
});

// ==== buildCoverageStripHtml / buildCoverageDrawerHtml / buildCoverageDrawerHeadHtml, the My Team strip and drawer. No sentences below this line: every assertion checks a figure, a chip, or a bar segment, never a built sentence. ====

test('strip: empty/missing band renders nothing at all, same rule as the full band', () => {
    assert(buildCoverageStripHtml(null, STAT_MAP) === '', 'null band');
    assert(buildCoverageStripHtml({ categories: [] }, STAT_MAP) === '', 'empty categories array');
});

test('B235 item 3: strip: a REST window names the days left but not itself - the days-left figure already says it', () => {
    const html = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvs-lab">Coverage</span>'), 'the Coverage caption');
    assert(!html.includes('cvs-window'), 'the fixture\'s own window is a REST kind - "the rest of the way" said nothing "18 days left" does not already say');
    // The fixture's own window.periods carries 21 days (163..183). The count is band.window.periods.length, never re-derived from anything else, since the days-left figure is read off the model and not invented in this renderer. It is days, not games, because a games count differs per club, so this reads the league's own day list instead.
    assert(html.includes('<span class="cvs-days">21 days left</span>'), 'the days-left figure, off window.periods.length');
    assert(html.indexOf('cvs-lab') < html.indexOf('cvs-days'), 'label, then days left');
});

test('B235 item 3: strip: a MATCHUP window still names itself - a scope, not a duration the days-left figure already states', () => {
    const matchupBand = { ...fixture, window: { kind: 'matchup', label: 'this matchup', matchup: 24, periods: fixture.window.periods, asOf: fixture.window.asOf } };
    const html = buildCoverageStripHtml(matchupBand, STAT_MAP);
    assert(html.includes('<span class="cvs-window">this matchup</span>'), 'the matchup label, unlike the rest-of-the-way case, still renders');
    assert(html.indexOf('cvs-lab') < html.indexOf('cvs-window') && html.indexOf('cvs-window') < html.indexOf('cvs-days'), 'label, then window, then days left, in that order');
});

test('B222 S54: strip: the fixture\'s one weak category (HR) draws one chip - player, FA tag, gain, category', () => {
    const html = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvs-chip-player">Slugging Outfielder</span>'), 'the best (first) add\'s own player');
    assert(html.includes('<span class="cvs-chip-fa">FA</span>'), 'the FA tag, unconditional (every add is a free agent by construction)');
    assert(html.includes('<span class="cvs-chip-gain">+5</span>'), 'the gain, signed, no horizon repeated on the chip itself');
    assert(html.includes('<span class="cvs-chip-cat">HR</span>'), 'the category, named on the chip since the strip carries several categories at once');
    assert(html.includes('<span class="cvs-more" hidden>+0 more</span>'), 'the more-indicator is always present (this pure module cannot know what fits) but starts hidden - myteam.js\'s fitCoverageStripChips reveals it only on real overflow');
});

test('B240 item 3/S139: strip: the swap clause and the Open control still close the line', () => {
    const html = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvs-swap">Cheapest to lose: Utility Bat</span>'), 'the swap clause, back to a plain fact (B240 item 3/S139 removes the second opener B237 item 3 added), text unchanged by S123');
    assert(html.includes('<button type="button" class="mt-strip-open cvs-open">Open &rsaquo;</button>'), 'the Open control, exact class the caller wires');
});

test('B222 S54: strip: renders EVERY losing category\'s chip, unconditionally - the owner\'s own correction against a fixed count', () => {
    // No DOM in this module, so it cannot know how many chips fit at any real width. Measuring, hiding the overflow and counting it is myteam.js's job (fitCoverageStripChips), not a built-in cutoff here. Four weak categories in, four chips out, every time.
    const band = {
        categories: [
            { id: '5', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [{ player: { name: 'A' }, gain: 1 }], swap: null },
            { id: '47', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [{ player: { name: 'B' }, gain: 1 }], swap: null },
            { id: '2', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [{ player: { name: 'C' }, gain: 1 }], swap: null },
            { id: '9', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [{ player: { name: 'D' }, gain: 1 }], swap: null },
        ],
    };
    const html = buildCoverageStripHtml(band, {});
    assert((html.match(/cvs-chip-player/g) || []).length === 4, 'every weak category gets its own chip, no built-in limit');
    assert(html.includes('<span class="cvs-more" hidden>+0 more</span>'), 'the indicator is present, still hidden - this module never decides an overflow count itself');
});

test('strip: no band.window at all renders no window/days segment, not an empty one', () => {
    const html = buildCoverageStripHtml({ categories: fixture.categories }, STAT_MAP);
    assert(!html.includes('cvs-window'), 'the window span is omitted outright, never present with nothing to say');
    assert(!html.includes('cvs-days'), 'the days-left span too - it depends on the same window');
});

// The strip's own control is the toggle now (the drawer's own X is gone, myteam.js's concern). The label is "Open" when closed and "Close" when open, off the caller's own opts.isOpen rather than a second place tracking drawer state.
test('strip: opts.isOpen flips the control from "Open" to "Close"', () => {
    const closed = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(closed.includes('>Open &rsaquo;</button>'), 'closed by default (no opts.isOpen)');
    const open = buildCoverageStripHtml(fixture, STAT_MAP, { isOpen: true });
    assert(open.includes('<button type="button" class="mt-strip-open cvs-open">Close</button>'), 'the same button, its own label only');
    assert(!open.includes('Open &rsaquo;'), 'never both labels at once');
});

test('B222 S54: strip: a team losing nothing reads a real line, never "Nothing to fix" and never a hidden strip', () => {
    const html = buildCoverageStripHtml({
        categories: [{ id: '2', value: 1, share: 0.9, weak: false, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(html.includes('<span class="cvs-chips-empty">Nothing to add this window</span>'), 'the exact honest line');
    assert(!html.toLowerCase().includes('nothing to fix'), 'the banned phrase never appears');
    assert(!html.includes('Cheapest to lose'), 'no swap clause either - nothing is weak, so nothing is being spared for it');
});

test('B222 S54: strip: a weak category with no available add draws a "no add" chip, not skipped', () => {
    const html = buildCoverageStripHtml({
        categories: [{ id: '5', value: 1, share: 0.1, weak: true, inverse: false, drivers: [], adds: [], swap: { player: { name: 'X' } } }],
    }, STAT_MAP);
    assert(html.includes('<span class="cvs-chip cvs-chip-none">HR: no add</span>'), 'the exact one-chip wording, naming the category');
});

test('drawer: empty/missing band renders nothing', () => {
    assert(buildCoverageDrawerHtml(null, STAT_MAP) === '', 'null band');
    assert(buildCoverageDrawerHtml({ categories: [] }, STAT_MAP) === '', 'empty categories array');
    assert(buildCoverageDrawerHeadHtml(null) === '', 'the header too');
});

test('B222 S54/B235 item 3: drawer head: the same caption the strip carries, plus Close', () => {
    const html = buildCoverageDrawerHeadHtml(fixture, { escapeHtml: (s) => String(s) });
    assert(html.includes('<span class="mt-drawer-title">'), 'wrapped in one span so .mt-drawer-head keeps exactly two flex children');
    assert(html.includes('<span class="cvs-lab">Coverage</span>'), 'same caption label');
    assert(!html.includes('cvs-window'), 'same REST-window omission the strip carries');
    assert(html.includes('<span class="cvs-days">21 days left</span>'), 'same days-left figure');
    assert(html.includes('<button type="button" class="mt-strip-open cvs-open">Close</button>'), 'Close, never Open - the header only ever shows while the drawer is already open');
});

test('drawer: cards render weak-first (danger badge, full strength) then held (success badge, muted); the swap footer closes it', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.indexOf('>HR<') < html.indexOf('>ERA<'), 'weak card (HR) before held cards, same order as the full band');
    const hrCardStart = html.indexOf('cvd-card cvd-card-bad');
    assert(hrCardStart !== -1 && hrCardStart < html.indexOf('>HR<'), 'the weak card carries the bad/danger tone, full strength (no muted class)');
    assert(html.includes('cvd-card-good cvd-card-muted'), 'a held card carries the good/success tone AND the muted class');
    assert(html.includes('<span class="cvd-badge cvd-badge-bad">Losing</span>'), 'the weak card\'s badge reads Losing, danger-toned');
    assert(html.includes('<span class="cvd-badge cvd-badge-good">Winning</span>'), 'a held card\'s badge reads Winning, success-toned');
    assert(html.includes('Cheapest to lose: Utility Bat. Carries the least of what you are projected to produce, and none of what you are losing.'), 'the swap footer, once, at the end - the one sentence K1 leaves untouched (a whole-drawer fact, not a per-card one)');
});

test('B222 S54c: drawer: HR\'s card draws the banked-against-to-come bar (value=16 IS banked, projected=3 is to come, season = their sum = 19)', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvd-bar-banked-fig">16 banked</span>'), 'banked = value(16), verbatim - the model\'s own season-actual figure, never subtracted from');
    assert(html.includes('<span class="cvd-bar-tocome-fig">+3 to come</span>'), 'to come = projected, verbatim off the model');
    assert(html.includes('<span class="cvd-bar-season-fig">19 season</span>'), 'season = banked(16) + to come(3), a forward total this bar computes, not a field the model carries');
    assert(html.includes('cvd-bar-banked" style="width:84.21052631578947%"'), 'the banked segment\'s own share of the (banked+toCome) track');
    assert(html.includes('cvd-bar-tocome" style="width:15.789473684210526%"'), 'the to-come segment fills the rest');
});

test('B222 S54c: drawer: the owner\'s own worked example (276 banked, 42 to come) renders 276 / +42 / 318, never 234 / +42 / 276', () => {
    const band = {
        categories: [
            { id: '5', value: 276, projected: 42, share: 0.2, weak: true, inverse: false, rate: false, drivers: [], adds: [], swap: null },
        ],
    };
    const html = buildCoverageDrawerHtml(band, STAT_MAP);
    assert(html.includes('<span class="cvd-bar-banked-fig">276 banked</span>'), 'banked is the actual season total to date, untouched');
    assert(html.includes('<span class="cvd-bar-tocome-fig">+42 to come</span>'), 'to come is the projected remainder, untouched');
    assert(html.includes('<span class="cvd-bar-season-fig">318 season</span>'), 'season is banked+to come (276+42), not value alone (276) - S54\'s first pass named 276 "season" and subtracted 42 from it to invent a 234 banked figure that was never real');
});

test('B222 S54: drawer: a rate category (ERA) draws its season figure alone, no bar - a rate is not banked-plus-to-come', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.includes('<div class="cvd-bar-figs cvd-bar-figs-plain"><span class="cvd-bar-season-fig">2.10 season</span></div>'), 'season figure only, no banked/to-come split');
});

test('B222 S54: drawer: ERA\'s own card carries no bar track, isolated from HR\'s', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    const eraStart = html.indexOf('>ERA<');
    const eraCard = html.slice(html.lastIndexOf('cvd-card', eraStart), eraStart + 600);
    assert(!eraCard.includes('cvd-bar-track'), 'no two-segment track on a rate\'s own card');
    assert(eraCard.includes('2.10 season'), 'the plain season figure is still there');
});

test('B222 S54: drawer: "Who carries it" draws one chip per driver, with each player\'s own remainder figure on a counting category', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvd-chip-lab">Who carries it</span>'), 'the label');
    assert(html.includes('<span class="cvd-chip-player">Corner Bat</span><span class="cvd-chip-fig">2</span>'), 'the first driver, its own contribution');
    assert(html.includes('<span class="cvd-chip-player">Utility Bat</span><span class="cvd-chip-fig">1</span>'), 'the second driver, its own contribution - two chips, not a summed sentence');
});

test('B222 S54: drawer: a rate category\'s driver chips carry no figure - a rate\'s contribution is not chip-worthy', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvd-chip-player">Ace Reliever</span></span>'), 'ERA\'s one driver, name only, no cvd-chip-fig sibling');
});

test('B222 S54: drawer: "Best add" draws one chip with the gain, only for a searched category', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvd-chip-lab">Best add</span>'), 'the label');
    assert(html.includes('<span class="cvd-chip cvd-chip-add">'), 'the chip itself');
    assert(html.includes('<span class="cvd-chip-player">Slugging Outfielder</span><span class="cvd-chip-fa">FA</span><span class="cvd-chip-gain">+5</span>'), 'player, FA tag, gain - no horizon repeated on the chip');
});

test('B222 S54: drawer: no "Best add" group at all for a held, non-searched category', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP);
    const eraStart = html.indexOf('>ERA<');
    const eraCard = html.slice(html.lastIndexOf('cvd-card', eraStart), eraStart + 600);
    assert(!eraCard.includes('Best add'), 'ERA is neither a model hole nor band-losing here - no group, not an empty one');
});

// "Losing" reads off the band's own rank (opts.losingIds/rankOf), never the model's share-based `weak`. The fixture's HR (weak: true) and ERA, AVG (weak: false) let both directions of the disagreement be exercised on real fixture data.

test('B222 S54: strip: losingIds overrides row.weak - a model hole the band ranks well gets no chip of its own', () => {
    // HR (id 5) is the fixture's one model-weak category; here the band says it is fine (rank 1 of 4) and ERA (id 47, model-held) is the one actually bleeding (rank 4 of 4). The chip row is now the only signal of what is "losing", and it names ERA, not HR.
    const html = buildCoverageStripHtml(fixture, STAT_MAP, {
        losingIds: new Set(['47']),
        rankOf: (id) => ({ '5': { rank: 1, of: 4 }, 47: { rank: 4, of: 4 }, 2: { rank: 2, of: 4 } }[id] || null),
    });
    // ERA carries no adds in the fixture, so its chip is the "no add" variant (no cvs-chip-cat span of its own), still the one chip the strip draws, which is the fact under test.
    assert(html.includes('<span class="cvs-chip cvs-chip-none">ERA: no add</span>'), 'ERA (band-bleeding) drives the strip\'s one chip');
    assert(!html.includes('Slugging Outfielder'), 'HR (model-weak but band-fine) contributes no chip');
});

test('B220 R11/Amendment 5, B222 S54: strip: a band-losing category with no model adds gets its own "no add" chip, not an omitted one', () => {
    // ERA (id 47) is band-losing here but carries no adds in the fixture (coverage-model never computed any for a held row), so the strip says so rather than omitting the chip.
    const html = buildCoverageStripHtml(fixture, STAT_MAP, {
        losingIds: new Set(['47']),
        rankOf: () => null,
    });
    assert(html.includes('<span class="cvs-chip cvs-chip-none">ERA: no add</span>'), 'ERA gets its own "no add" chip');
});

// An inverse counting category with a pair draws the swap chip, never "no add"; with no pair it draws nothing at all. Rows are hand-built because the fixture has no inverse counting category, and row.inverse && !row.rate is the discriminator, since row.pair alone cannot tell "not inverse" apart from "inverse, no pair found" (both are null).
const PAIR = {
    drop: { name: 'Miguel Vargas' }, add: { name: 'Nolan Jones' },
    saving: 4, ratio: 1.4, matched: ['20', '12']
};
const CS_ROW = (over = {}) => ({ id: '35', value: 8, share: 0.2, weak: true, inverse: true, rate: false, adds: [], swap: null, pair: null, drivers: [], ...over });

test('strip: an inverse counting category with a pair draws the swap chip, never "no add"', () => {
    const html = buildCoverageStripHtml({ categories: [CS_ROW({ pair: PAIR })] }, { '35': 'CS' }, {});
    assert(html.includes('cvs-chip-swap'), 'the swap chip class renders');
    assert(html.includes('Miguel Vargas') && html.includes('cvs-chip-drop'), 'the roster player struck through');
    assert(html.includes('Nolan Jones'), 'the free agent named');
    assert(html.includes('&minus;4') || html.includes('-4'), 'the saving as a reduction');
    assert(!html.includes('no add'), 'never the useless-but-true "no add" text');
});

test('strip: an inverse counting category with NO pair draws nothing at all - not "no add", not an empty chip', () => {
    const html = buildCoverageStripHtml({ categories: [CS_ROW({ pair: null })] }, { '35': 'CS' }, {});
    assert(!html.includes('cvs-chip-swap') && !html.includes('cvs-chip-none') && !html.includes('cvs-chip-player'), 'none of the three concrete chip shapes render for this category');
    assert(!html.includes('no add'), 'and never the "no add" text either');
});

test('strip: an inverse RATE category is unaffected - it still gets a normal add chip, never a swap', () => {
    const html = buildCoverageStripHtml({
        categories: [{ id: '47', value: 4.5, share: 0.2, weak: true, inverse: true, rate: true, adds: [{ player: { name: 'Ace Reliever' }, gain: 0.3 }], swap: null, pair: null, drivers: [] }]
    }, { '47': 'ERA' }, { formatValue: (id, v) => String(v) });
    assert(html.includes('cvs-chip-player">Ace Reliever'), 'a real add chip, the normal shape');
    assert(!html.includes('cvs-chip-swap'), 'never the swap shape for an inverse RATE');
});

test('drawer: a model hole the band ranks well gets a Winning badge but STILL shows its best add - the two questions can disagree, both get answered', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, {
        losingIds: new Set(['47']), // ERA losing per band; HR (the model's own hole) is not
        rankOf: (id) => ({ '5': { rank: 1, of: 4 }, 47: { rank: 4, of: 4 } }[id] || null),
    });
    const hrCardStart = html.indexOf('cvd-card cvd-card-good cvd-card-muted');
    const hrNameIdx = html.indexOf('>HR<');
    assert(hrCardStart !== -1 && hrCardStart < hrNameIdx, 'HR carries the Winning (good/muted) tone now, not Losing');
    assert(html.includes('<span class="cvd-badge cvd-badge-good">Winning #1</span>'), 'the rank prints on the badge, band-sourced');
    // HR's own card still carries its Best add group, read off row.weak (the model), unaffected by the badge above it having flipped to Winning. The card boundary is the next card's opening tag (or the end of the string), since a fixed offset drifted out of sync. 'class="cvd-card ' with its trailing space matches only a card's own opening tag.
    const nextCardStart = html.indexOf('class="cvd-card ', hrCardStart + 1);
    const hrCardHtml = html.slice(hrCardStart, nextCardStart === -1 ? undefined : nextCardStart);
    assert(hrCardHtml.includes('Slugging Outfielder'), 'HR\'s best add still shows in its own card despite the Winning badge');
});

// The strip gates its "no add found" chip on the band's losing set, which equals what the model searched. The drawer gated on row.weak alone, so a row losing by rank but not a model hole was searched yet had its whole "Best add" group skipped, a real add silently dropped. The test pins the drawer to the same set.

test('B220 R11/S48: drawer shows "Best add" for a row losing by RANK but not a model hole - previously dropped outright', () => {
    const band = {
        categories: [
            {
                id: '9', value: 40, share: 0.6, weak: false, inverse: false, rate: false,
                drivers: [], adds: [{ player: { id: 11, name: 'Depth Starter' }, gain: 4 }], swap: null,
            },
        ],
    };
    const html = buildCoverageDrawerHtml(band, { '9': 'W' }, {
        losingIds: new Set(['9']), // losing by rank; row.weak is false, so the model never called this a hole
        rankOf: () => null,
    });
    assert(html.includes('Depth Starter'), 'the add shows - the band told the model to search this row even though it is not a share-based hole');
});

test('B220 R11/S48: drawer omits the "Best add" group for a row that is neither a model hole nor losing by rank', () => {
    const band = {
        categories: [
            { id: '9', value: 40, share: 0.9, weak: false, inverse: false, rate: false, drivers: [], adds: [], swap: null },
        ],
    };
    const html = buildCoverageDrawerHtml(band, { '9': 'W' }, {
        losingIds: new Set(['47']), // '9' is not in the losing set and is not a model hole either
        rankOf: () => null,
    });
    assert(!html.includes('Best add'), 'no add group at all for a row the model never searched');
});

test('drawer: order is worst BAND rank first among losing, best rank first among held - not the model\'s own share order', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, {
        losingIds: new Set(['5', '47']), // both HR and ERA read as losing here
        rankOf: (id) => ({ '5': { rank: 2, of: 4 }, 47: { rank: 4, of: 4 }, 2: { rank: 1, of: 4 } }[id] || null),
    });
    // ERA (rank 4, worse) should lead HR (rank 2) among the losing pair; AVG (rank 1, held, best) trails both since it is not losing at all.
    const eraIdx = html.indexOf('>ERA<'), hrIdx = html.indexOf('>HR<'), avgIdx = html.indexOf('>AVG<');
    assert(eraIdx < hrIdx, 'ERA (worse band rank, #4) leads HR (#2) among losing cards');
    assert(hrIdx < avgIdx, 'both losing cards lead the one held card');
});

test('no losingIds/rankOf supplied: both functions fall back to row.weak with no rank suffix - the original behaviour, unbroken', () => {
    const strip = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(strip.includes('cvs-chip-cat">HR<'), 'falls back to the model\'s own weak flag, naming HR via its one chip');
    const drawer = buildCoverageDrawerHtml(fixture, STAT_MAP);
    assert(drawer.includes('<span class="cvd-badge cvd-badge-bad">Losing</span>'), 'no rank suffix when rankOf has nothing to offer');
});

// ==== The drawer's mode row and ranked table. ====

const MODE_STATE = (over = {}) => ({
    mode: 'pick',
    ids: ['5', '47', '2'],
    picked: new Set(['5']),
    unrankableIds: new Set(['72']),
    losingIds: new Set(['47']),
    rankIds: ['5'],
    sourceLabel: 'Free agents · the rest of the way',
    ...over
});
const RANKED = [
    { player: { id: 1, name: 'Best Bat' }, gains: { '5': 6 }, composite: 0.091 },
    { player: { id: 2, name: 'Next Bat' }, gains: { '5': -2 }, composite: -0.014 },
    { player: { id: 3, name: 'No Figure' }, gains: {}, composite: 0 }
];
const MODE_OPTS = (over = {}) => ({
    escapeHtml: escapeHtmlLocal,
    posOf: (p) => (p.id === 1 ? 'C/1B' : null),
    ...over
});

test('the note under the table is the frozen sentence, exactly', () => {
    // It is not the frame's wording. The frame was drawn before the composite was measured and share-of-team proposed; the measurement rejected that unit and the league range replaced it, so the sentence says the unit that shipped rather than the one that was mocked.
    const html = buildRankedAddsHtml(RANKED, ['5'], STAT_MAP, MODE_OPTS());
    assert(html.includes("Composite: each gain as a share of the league&#39;s range in that category, summed."),
        'the sentence, escaped as the renderer escapes it');
});

test('the ranked table draws the player, the FA tag, the position and the composite', () => {
    const html = buildRankedAddsHtml(RANKED, ['5'], STAT_MAP, MODE_OPTS());
    assert(html.includes('Best Bat'), 'the name');
    assert(html.includes('cvd-adds-fa">FA<'), 'every row is a free agent by construction');
    assert(html.includes('C/1B'), 'the position the caller supplied');
    assert(html.includes('+9.1%'), 'the composite as a percentage');
    assert(html.includes('cvd-adds-top'), 'and the best row is marked');
});

test('B236 item 4/S112: a third eligible position abbreviates rather than wrapping the row', () => {
    const html = buildRankedAddsHtml(RANKED, ['5'], STAT_MAP, MODE_OPTS({
        posOf: (p) => (p.id === 1 ? 'DH/1B/3B' : null)
    }));
    assert(html.includes('>DH/1B +1<'), 'the cell shows the first two plus a count');
    assert(html.includes('title="DH/1B/3B"'), 'the full list survives on the cell\'s own title');
    assert(!html.includes('>DH/1B/3B<'), 'the raw three-position string never renders as the cell text');
});

test('B236 item 4/S112: two eligible positions render exactly as given, no title added', () => {
    const html = buildRankedAddsHtml(RANKED, ['5'], STAT_MAP, MODE_OPTS());
    assert(html.includes('title="C/1B"'), 'even the untouched two-position case carries a title, for the same hover the abbreviated case gets');
});

test('a gain that ROUNDS to zero is not printed as an improvement', () => {
    // "+0" is a claim the figure beside it does not support. The sign is decided by what is printed, not by the raw number, because the caller's formatter rounds a counting category.
    const rounded = [{ player: { id: 9, name: 'Marginal' }, gains: { '5': 0.3 }, composite: 0.001 }];
    const html = buildRankedAddsHtml(rounded, ['5'], STAT_MAP, MODE_OPTS({
        formatValue: (id, v) => Math.round(Number(v))
    }));
    assert(!html.includes('+0<'), 'no plus on a rounded zero');
    assert(html.includes('cvd-add-none">0<'), 'it reads as the zero it looks like');
});

test('a negative gain reads as a loss, and a missing one as no figure', () => {
    const html = buildRankedAddsHtml(RANKED, ['5'], STAT_MAP, MODE_OPTS());
    assert(html.includes('cvd-add-dn">-2<'), 'a plain hyphen, never a minus sign or an en dash');
    assert(html.includes('cvd-add-none">-<'), 'and no figure at all is a bare hyphen');
});

test('an empty SET and an empty RESULT are different answers', () => {
    const noSet = buildRankedAddsHtml(RANKED, [], STAT_MAP, MODE_OPTS());
    assert(noSet.includes('Pick a category'), 'nobody asked anything yet');
    assert(!noSet.includes('Composite:'), 'and the note explains a table that is not there');
    const noRows = buildRankedAddsHtml([], ['5'], STAT_MAP, MODE_OPTS());
    assert(noRows.includes('No free agent improves this set.'), 'a real search that found nobody');
    assert(noRows.includes('Composite:'), 'which the note still qualifies');
});

// The drop mode: buildCoverageDrawerHtml with mode 'drop'. The ledger shape is hand-built to the frozen contract (coverage-model.js's dropLedger header and the LED_ fixtures in tests/coverage-model.test.js), the same way RANKED above stands in for rankAdds, since this file tests only how the shape reads.
const DROP_PLAYER = { id: 102, name: 'Utility', teamName: 'My Team', positionDisplay: '1B' };
const DROP_CANDIDATE = { id: 201, name: 'Candidate', teamName: 'Free Agent', positionDisplay: '1B' };
const DROP_LEDGER = {
    categories: [
        {
            id: '5', before: 25, after: 32, dropLine: 5, addLine: 12, change: 7, delta: 7,
            rankBefore: 2, rankAfter: 1, marginBefore: { teamId: '2', gap: -5 }, margin: { teamId: '2', gap: 2 }
        },
        {
            id: '72', before: 11, after: 9, change: 2, delta: -2, dropLine: 3, addLine: 1,
            rankBefore: 2, rankAfter: 3, marginBefore: { teamId: '2', gap: -5 }, margin: { teamId: '2', gap: -3 }
        }
    ],
    summary: { gained: ['5'], lost: [], unchanged: 0, placeBefore: 2, placeAfter: 1 }
};
const DROP_OPTS = (over = {}) => ({
    escapeHtml: escapeHtmlLocal,
    modeState: { mode: 'drop' },
    teamNameOf: (id) => (id === '2' ? 'Big League Chew' : `Team ${id}`),
    ...over
});

test('drop for: nobody picked yet prompts for the roster player, no cards, no ledger', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({ drop: null }));
    assert(html.includes('Pick a roster player to drop.'), 'the honest empty state');
    assert(!html.includes('cvx-pair'), 'no pair cards before anybody is picked');
});

test('drop for: a roster player picked, no candidate yet - both cards, the empty slot named, no ledger', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: null, rosterChoices: [DROP_PLAYER], candidateChoices: [], ledger: null }
    }));
    assert(html.includes('cvx-pair'), 'the pair renders');
    assert(html.includes('Utility'), 'the drop card names the player');
    assert(html.includes('Pick a candidate'), 'the empty candidate slot is a real state, not a blank card');
    assert(html.includes('Pick a candidate to see the ledger.'), 'the ledger itself waits on both halves');
});

// The search shelf. Its filtering runs in myteam.js (this module stays a pure renderer, "searchPool never gets serialised into the page" per pairCardHtml's own comment), so the only thing to prove here is that the Add card draws the input when a searchPool arrives and stays exactly as it was when it does not.
test('drop for: a search field draws over the Add card only, when the caller hands one in', () => {
    const withSearch = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: {
            dropPlayer: DROP_PLAYER, candidate: null, rosterChoices: [DROP_PLAYER], candidateChoices: [],
            searchPool: [DROP_CANDIDATE]
        }
    }));
    assert(withSearch.includes('data-drop-search="candidate"'), 'the Add card carries the search input');
    assert(!withSearch.includes('data-drop-search="drop"'), 'never the Drop side - its own choices are the whole roster, nothing to search');
    assert(withSearch.includes('data-drop-results="candidate"'), 'and its own empty, hidden results shelf');

    const withoutSearch = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: null, rosterChoices: [DROP_PLAYER], candidateChoices: [] }
    }));
    assert(!withoutSearch.includes('data-drop-search'), 'a caller with no searchPool draws exactly the old card, byte for byte in this respect');
});

test('drop for: both picked draws the ledger - the rank arrow, the standing sentence, coloured change', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: DROP_LEDGER }
    }));
    assert(html.includes('#2 &rarr; #1'), 'HR: the rank arrow, before then after');
    assert(html.includes('passes Big League Chew by 2'), 'HR: rank improved, so the team just passed is named off marginBefore, the AFTER gap as the distance');
    assert(html.includes('cvd-add-up">+7'), 'HR: the raw delta printed with its own sign, coloured by change');
    assert(html.includes('falls behind Big League Chew by 3'), 'E (inverse): rank worsened even though the change itself improved, the team just fallen behind named off the AFTER margin');
    assert(html.includes('cvd-add-up">-2'), 'E: the raw delta is negative (the error count fell) but change is positive for an inverse category, so it prints "-2" and colours it as good - dropLedger\'s own worked example');
    assert(html.includes('Gained 1, lost 0, unchanged 0.'), 'the bottom line reads summary verbatim');
    assert(html.includes('Overall #2 &rarr; #1.'), 'and the place either side, when the caller supplied placeFrom');
});

test('drop for: fractional forward lines print one more decimal rather than three independent whole-number roundings that no longer sum', () => {
    // The measured example: AST drop 0.4375, add 11.7639, delta/change 11.3264 exactly (11.7639 minus 0.4375). Whole-unit rounding alone prints "drop 0, add 12, change +11", each individually honest but not summing, since Math.round(0.4375)=0, Math.round(11.7639)=12 and Math.round(11.3264)=11 disagree once every number is whole.
    const AST_ROW = {
        id: '5', before: 1416.52, after: 1427.85, dropLine: 0.4375, addLine: 11.763888888889,
        change: 11.326388888889, delta: 11.326388888889, rankBefore: 1, rankAfter: 1,
        marginBefore: { teamId: '2', gap: 140.7 }, margin: { teamId: '2', gap: 152.1 }
    };
    // The inverse case has errors rising (worse), so change is negative even though delta (the raw figure) is positive. A first reading expected "+1"/"-1" off the rounded add/drop cells, but the real unrounded delta is 0.3264, which honestly prints "+0.3", not a guessed "+1".
    const E_ROW = {
        id: '72', before: 57.15, after: 57.48, dropLine: 0.4375, addLine: 0.763888888889,
        change: -0.326388888889, delta: 0.326388888889, rankBefore: 2, rankAfter: 2,
        marginBefore: { teamId: '2', gap: -3.78 }, margin: { teamId: '2', gap: -4.11 }
    };
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: {
            dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE],
            ledger: { categories: [AST_ROW, E_ROW], summary: { gained: ['5'], lost: [], unchanged: 1, placeBefore: null, placeAfter: null } }
        },
        // formatValueLocal already gives a rate its own decimals; this stands in for the real app's counting-stat formatter, which rounds to a whole unit, the case this fix is for.
        formatValue: (id, v) => Math.round(Number(v))
    }));
    assert(html.includes('>0.4<') && html.includes('>11.8<'), 'AST: drop and add both keep the one decimal their whole-unit rounding would have dropped');
    assert(html.includes('cvd-add-up">+11.3<'), 'AST: change and delta agree with the finer drop/add cells now (11.8 - 0.4 = 11.3-ish), not a bare "+11"');
    assert(html.includes('cvd-add-dn">+0.3<'), 'E: the honest unrounded delta (+0.3, an error added) coloured by the correctly-negative change, never the guessed "+1"/"-1" a whole-unit read suggested');
});

test('drop for: the category picker is dropped entirely, not just emptied - the ledger gets its own room back', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: DROP_LEDGER }
    }));
    assert(!html.includes('cvd-pick-slot'), 'no reserved picker slot in Drop for - there is no category subset to pick, every category is always in the ledger');
    assert(html.includes('cvd-modes-lab'), 'the mode row itself is still there, unaffected');
});

test('drop for: every scored category renders, grouped Batters then Pitchers under the roster\'s own labels', () => {
    const ledgerWithPitching = {
        categories: [...DROP_LEDGER.categories, {
            id: '47', before: 3.2, after: 3.1, change: 0.1, delta: -0.1, dropLine: null, addLine: null,
            rankBefore: 3, rankAfter: 3, marginBefore: { teamId: '2', gap: -0.4 }, margin: { teamId: '2', gap: -0.3 }
        }],
        summary: DROP_LEDGER.summary
    };
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: ledgerWithPitching },
        // Inlined rather than the shared ROLE_GROUPS const below, because this test runs before that const's declaration in file order and `const` is not hoisted usably.
        roleGroups: { primary: { label: 'Batters', ids: ['5', '2'] }, secondary: { label: 'Pitchers', ids: ['47'] } }
    }));
    assert((html.match(/scope="row" class="cvx-cat"/g) || []).length === 3, 'HR, E and ERA all render, none stopped short');
    assert(html.indexOf('>Batters<') < html.indexOf('>HR<'), 'the Batters heading precedes its own categories');
    assert(html.indexOf('>HR<') < html.indexOf('>Pitchers<') && html.indexOf('>Pitchers<') < html.indexOf('>ERA<'),
        'Pitchers follows Batters and precedes ERA, the roster\'s own group order');
});

test('drop for: the mode row and the pair cards sit outside the scrolling ledger, wrapped so dashboard.css can pin them', () => {
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: DROP_LEDGER }
    }));
    assert(html.startsWith('<div class="cvx-drop-wrap">'), 'the mode row and the drop body share one wrapper, the hook dashboard.css\'s :has() reads');
    assert(html.indexOf('cvd-modes') < html.indexOf('cvx-pair') && html.indexOf('cvx-pair') < html.indexOf('cvx-ledger-scroll'),
        'mode row, then the pair cards, then the ledger - the only child meant to scroll comes last');
});

test('drop for: a margin that rounds to 0 prints a decimal, and one that still rounds to 0.0 says "under 1"', () => {
    const closeCall = {
        categories: [
            // Rank moved, gap rounds to 0 at whole units but is real at one decimal.
            { id: '5', before: 25, after: 32, change: 7, delta: 7, dropLine: 12, addLine: 12,
              rankBefore: 2, rankAfter: 1, marginBefore: { teamId: '2', gap: -0.4 }, margin: { teamId: '2', gap: 0.4 } },
            // Rank moved and the gap is under a tenth even, so it reads "under 1" rather than a false "0.0".
            { id: '72', before: 11, after: 9, change: 2, delta: -2, dropLine: 3, addLine: 1,
              rankBefore: 2, rankAfter: 3, marginBefore: { teamId: '2', gap: -0.4 }, margin: { teamId: '2', gap: -0.04 } }
        ],
        summary: { gained: ['5'], lost: ['72'], unchanged: 0, placeBefore: null, placeAfter: null }
    };
    // A counting category's real formatter rounds to whole units (formatStat, myteam.js). The fallback formatValueLocal shows two decimals for anything non-integer and never hits the rounds-to-zero case this test exists for, so a whole-unit rounder stands in for it here.
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: closeCall },
        formatValue: (id, v) => Math.round(Number(v))
    }));
    assert(html.includes('passes Big League Chew by 0.4'), 'a whole-unit zero gets one more decimal instead');
    assert(html.includes('falls behind Big League Chew by under 1'), 'a gap under even a tenth says so honestly rather than printing 0.0');
});

test('drop for: a head-to-head league supplies no placeFrom - the Overall clause is omitted, not printed as null', () => {
    const noPlace = { ...DROP_LEDGER, summary: { ...DROP_LEDGER.summary, placeBefore: null, placeAfter: null } };
    const html = buildCoverageDrawerHtml(fixture, STAT_MAP, DROP_OPTS({
        drop: { dropPlayer: DROP_PLAYER, candidate: DROP_CANDIDATE, rosterChoices: [DROP_PLAYER], candidateChoices: [DROP_CANDIDATE], ledger: noPlace }
    }));
    assert(html.includes('Gained 1, lost 0, unchanged 0.'), 'the category tally still prints');
    assert(!html.includes('Overall'), 'no record clause a drop cannot back up');
});

test('the mode row marks the active mode and nothing else', () => {
    const html = buildAddsModeRowHtml(MODE_STATE({ mode: 'all' }), STAT_MAP, MODE_OPTS());
    assert(html.includes('data-adds-mode="all" class') || html.includes('cvd-mode cvd-mode-on" data-adds-mode="all"'),
        'the active one carries the class');
    assert((html.match(/cvd-mode-on/g) || []).length === 1, 'exactly one');
    assert(html.includes('One category') && html.includes('Pick categories') && html.includes('Drop for'), 'all five are offered (B237 item 3 added the fifth)');
});

test('the picker draws in All-round/My holes/Pick categories, but is only ever clickable in Pick categories (B235 item 5/S109b)', () => {
    // An empty slot in One category and All-round read as a surface that forgot to render, worse than the jar it cured. The same grouped picker draws (every real chip present, cvd-pick-cat) in these three, inert everywhere but Pick categories.
    const all = buildAddsModeRowHtml(MODE_STATE({ mode: 'all' }), STAT_MAP, MODE_OPTS());
    const pick = buildAddsModeRowHtml(MODE_STATE({ mode: 'pick' }), STAT_MAP, MODE_OPTS());
    const holes = buildAddsModeRowHtml(MODE_STATE({ mode: 'holes' }), STAT_MAP, MODE_OPTS());
    assert(all.includes('cvd-pick-cat') && all.includes('cvd-pick-inert'), 'All-round draws it, greyed');
    assert(pick.includes('cvd-pick-cat') && !pick.includes('cvd-pick-inert'), 'Pick categories draws it live');
    assert(holes.includes('cvd-pick-cat') && holes.includes('cvd-pick-inert'), 'My holes stays greyed, as it always was');
});

// One category asks nothing of the picker (the same "no category selection to reflect" as All-round) and the chips bought it nothing but height, so they are gone outright, never drawn, live or inert, greyed or struck. The empty slot that held their height is gone too, as Drop for already has.
test('One category drops the picker slot entirely - no chips and no reserved height either', () => {
    const one = buildAddsModeRowHtml(MODE_STATE({ mode: 'one' }), STAT_MAP, MODE_OPTS());
    assert(!one.includes('cvd-pick-slot'), 'no reserved picker slot in One category any more - nothing there to reserve room for');
    assert(!one.includes('cvd-pick-cat'), 'and it still carries no chips - not greyed, not struck, none at all');
    assert(!one.includes('cvd-pick-inert'), 'so there is no inert picker to speak of either');
});

test('the picker\'s own slot is reserved for the ranked-adds modes it was pinned for, and no others', () => {
    // One category's table sat 102px below the mode row, All-round's 47px and My holes/Pick categories' 190px, purely because the picker only rendered in the last two, so switching jarred the table up and down. The slot now reserves that height across the four ranked-adds modes; One category and Drop for are not ranked-adds tables and skip the slot outright.
    assert(!buildAddsModeRowHtml(MODE_STATE({ mode: 'one' }), STAT_MAP, MODE_OPTS()).includes('cvd-pick-slot'), 'no slot in One category');
    assert(buildAddsModeRowHtml(MODE_STATE({ mode: 'all' }), STAT_MAP, MODE_OPTS()).includes('cvd-pick-slot'), 'but the slot exists in All-round');
});

test('an unrankable category is struck through and cannot be picked', () => {
    const html = buildAddsModeRowHtml(MODE_STATE({ ids: ['5', '72'] }), STAT_MAP, MODE_OPTS());
    assert(html.includes('cvd-pick-dead'), 'struck rather than hidden, so a reader is answered');
    assert(/data-pick-cat="72"[^>]*disabled/.test(html), 'and it refuses the click');
});

test('My holes greys the picker and marks the band own losing set', () => {
    const html = buildAddsModeRowHtml(MODE_STATE({ mode: 'holes' }), STAT_MAP, MODE_OPTS());
    assert(html.includes('cvd-pick-inert'), 'inert, because the set is not a choice');
    assert(/data-pick-cat="47"[^>]*disabled/.test(html), 'every chip refuses the click');
    assert(html.includes('cvd-pick-on'), "and the losing category still reads as in the set");
});

// A caller-supplied roleGroups (batters then pitchers, skaters then goalies) splits the picker's chip row into a heading per group, a stable partition of the caller's own ids (never a re-sort), and does nothing at all when the caller never opted in.
const ROLE_GROUPS = { primary: { label: 'Batters', ids: ['5', '2'] }, secondary: { label: 'Pitchers', ids: ['47'] } };

test('the picker groups its own chips by role when the caller supplies roleGroups', () => {
    const html = buildAddsModeRowHtml(MODE_STATE({ mode: 'pick', ids: ['5', '47', '2'] }), STAT_MAP, MODE_OPTS({ roleGroups: ROLE_GROUPS }));
    assert(html.includes('<div class="cvd-role-head">Batters</div>'), 'the primary group is named');
    assert(html.includes('<div class="cvd-role-head">Pitchers</div>'), 'the secondary group is named');
    assert(html.indexOf('Batters') < html.indexOf('data-pick-cat="5"'), 'Batters heads the primary chips');
    assert(html.indexOf('data-pick-cat="5"') < html.indexOf('data-pick-cat="2"'), 'HR then AVG - the caller\'s own order survives inside the group');
    assert(html.indexOf('data-pick-cat="2"') < html.indexOf('Pitchers'), 'every primary chip before the secondary heading');
    assert(html.indexOf('Pitchers') < html.indexOf('data-pick-cat="47"'), 'Pitchers heads the secondary chips');
});

test('the picker renders one unbroken row when the caller never supplies roleGroups', () => {
    const html = buildAddsModeRowHtml(MODE_STATE({ mode: 'pick', ids: ['5', '47', '2'] }), STAT_MAP, MODE_OPTS());
    assert(!html.includes('cvd-role-head'), 'no headings at all - the same picker this test file already covered');
});

test('One category groups its own cards by role the same way, losing-first order intact within each group', async () => {
    const band = await loadFixture();
    const html = buildCoverageDrawerHtml(band, STAT_MAP, {
        escapeHtml: escapeHtmlLocal, modeState: MODE_STATE({ mode: 'one' }), roleGroups: ROLE_GROUPS
    });
    assert(html.includes('<div class="cvd-role-head">Batters</div>'), 'the primary group heads the card list');
    assert(html.includes('<div class="cvd-role-head">Pitchers</div>'), 'the secondary group follows it');
    assert(html.indexOf('cvd-role-head">Batters') < html.indexOf('cvd-role-head">Pitchers'), 'batters before pitchers');
});

test('the drawer keeps its cards in One category and swaps to the table otherwise', async () => {
    const band = await loadFixture();
    const cards = buildCoverageDrawerHtml(band, STAT_MAP, {
        escapeHtml: escapeHtmlLocal, modeState: MODE_STATE({ mode: 'one' })
    });
    assert(cards.includes('cvd-card'), 'One category IS the old drawer, not a fallback');
    assert(cards.includes('cvd-modes'), 'with the mode row above it');
    const table = buildCoverageDrawerHtml(band, STAT_MAP, {
        escapeHtml: escapeHtmlLocal, modeState: MODE_STATE({ mode: 'all', rankIds: ['5'] }), ranked: RANKED
    });
    assert(!table.includes('cvd-card'), 'and the other three replace the cards outright');
    assert(table.includes('cvd-adds'), 'with the one ranked table');
});

test('a caller that passes no mode state gets the drawer it already had', async () => {
    const band = await loadFixture();
    const before = buildCoverageDrawerHtml(band, STAT_MAP, { escapeHtml: escapeHtmlLocal });
    assert(!before.includes('cvd-modes'), 'no mode row at all');
    assert(before.includes('cvd-card'), 'and the cards, unchanged');
});

test('the composite sits with the columns that NAME the row, not after the categories', () => {
    // On "My holes" at ten columns the composite, the one figure the mode exists for and the one the table is sorted by, sat off the right edge and had to be scrolled to. Column order is the fix; the sticky left group is the CSS half of it.
    const html = buildRankedAddsHtml(RANKED, ['5', '47'], STAT_MAP, MODE_OPTS());
    const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    const iComp = head.indexOf('Composite');
    const iHR = head.indexOf('>HR<');
    assert(iComp > 0 && iHR > 0, 'both columns are there');
    assert(iComp < iHR, 'and the composite comes first');
    const start = html.indexOf('<tr class="cvd-adds-row');
    const row = html.slice(start, html.indexOf('</tr>', start));
    assert(row.indexOf('cvd-adds-comp') < row.indexOf('cvd-add-up'), 'the body follows the head');
});

test('a long name is one line with the whole of it on hover', () => {
    // Wrapping doubled a row's height and pushed the figures apart. A name is an identifier in this table, not prose, so it ellipses, and the title carries what the ellipsis drops.
    const long = [{ player: { id: 4, name: 'Bartolomeo Quintanilla-Featherstonehaugh' }, gains: { '5': 1 }, composite: 0.02 }];
    const html = buildRankedAddsHtml(long, ['5'], STAT_MAP, MODE_OPTS());
    assert(html.includes('title="Bartolomeo Quintanilla-Featherstonehaugh"'), 'the full name on hover');
    assert(html.includes('cvd-adds-nm'), 'and the span the ellipsis is applied to');
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
