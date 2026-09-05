// Unit tests for the pure coverage-band builder (coverage-band.js). Open tests/coverage-band.test.html through any static server - green means every assertion held. Driven by tests/fixtures/coverage-band.json, the data lane's own frozen contract (ad36440) - a real coverageBand() output, not a hand-typed approximation, so these tests can never drift from what the model actually emits.
import { buildCoverageBandHtml, buildCoverageStripHtml, buildCoverageDrawerHtml, buildCoverageDrawerHeadHtml, escapeHtmlLocal } from '../coverage-band.js';

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
    // S28: drivers now read against `row.projected` (3), never `row.value` (16, the season's actuals) - the mixed-basis sentence the amendment named as a bug. Corner Bat (2) + Utility Bat (1) = 3, matching the fixture's own row.projected exactly. The fixture's window ({ kind: "rest", label: "the rest of the way" }) names the horizon on both sentences.
    assert(html.includes('Corner Bat and Utility Bat carry 3 of your 3 the rest of the way.'), 'the driver sum against the PROJECTED remainder, horizon named');
    assert(!html.includes('of your 16'), 'never the season actual as the drivers\' own denominator');
    assert(html.includes('Slugging Outfielder (FA) would add 5 the rest of the way.'), 'the add, FA-tagged, projected gain, the horizon named every time');
    assert(html.includes('Cheapest to lose: Utility Bat. They carry the least of what you are winning.'), 'the swap sentence and its why, two sentences, gender-neutral');
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
    // HR: value 16 (the headline), projected 3 (the fixture's own remainder) - said once beside the total it is a piece of, not just in the sentences below it.
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

// S28b's own "the drawer's card gets the same sub-figure" assertion (the season headline plus a remainder sub-figure) no longer applies to the drawer as of S54 - the drawer's card dropped its headline figure entirely in favor of the banked-against-to-come bar, which carries the same two numbers (season, remainder) as bar segments instead of a headline-plus-sub-figure pair. See " S54: drawer: HR's card draws the banked-against-to-come bar" below for its replacement.

test('the swap sentence renders exactly once, as the band\'s own footer, not inside any one row', () => {
    const html = buildCoverageBandHtml(fixture, STAT_MAP);
    assert((html.match(/Cheapest to lose/g) || []).length === 1, 'said once for the whole band, not once per weak row');
    assert((html.match(/cvb-swap-footer/g) || []).length === 1, 'exactly one footer element');
    const footerStart = html.indexOf('cvb-swap-footer');
    const lastRowEnd = html.lastIndexOf('cvb-row');
    assert(footerStart > lastRowEnd, 'the footer markup follows every row, not nested inside one');
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

test('a weak category with no swap available: the swap line is omitted outright, not a null placeholder', () => {
    const html = buildCoverageBandHtml({
        categories: [{ id: '9', value: 4, share: 0.2, weak: true, inverse: false, drivers: [], adds: [], swap: null }],
    }, STAT_MAP);
    assert(!html.includes('cvb-swap'), 'no swap markup at all when swap is null');
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

// ==== buildCoverageStripHtml / buildCoverageDrawerHtml / buildCoverageDrawerHeadHtml. No sentences below this line - every assertion checks a figure, a chip, or a bar segment, never a built sentence. ====

test('strip: empty/missing band renders nothing at all, same rule as the full band', () => {
    assert(buildCoverageStripHtml(null, STAT_MAP) === '', 'null band');
    assert(buildCoverageStripHtml({ categories: [] }, STAT_MAP) === '', 'empty categories array');
});

test('B222 S54: strip: the caption names the window and the days left, in that order', () => {
    const html = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvs-lab">Coverage</span>'), 'the Coverage caption');
    assert(html.includes('<span class="cvs-window">the rest of the way</span>'), 'the fixture\'s own window label');
    // The fixture's own window.periods carries 21 days (163..183) - band.window.periods.length, never re-derived from anything else (the days-left figure is read off the model, not invented in this renderer). DAYS, not games (the owner's own correction) - a games count differs per club, so this reads the league's own day list instead.
    assert(html.includes('<span class="cvs-days">21 days left</span>'), 'the days-left figure, off window.periods.length');
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

test('B222 S54: strip: the swap clause and the Open control still close the line', () => {
    const html = buildCoverageStripHtml(fixture, STAT_MAP);
    assert(html.includes('<span class="cvs-swap">Cheapest to lose: Utility Bat</span>'), 'the swap clause, unchanged by the K1 rebuild - one footer fact, not a per-category sentence');
    assert(html.includes('<button type="button" class="mt-strip-open cvs-open">Open &rsaquo;</button>'), 'the Open control, exact class the caller wires');
});

test('B222 S54: strip: renders EVERY losing category\'s chip, unconditionally - the owner\'s own correction against a fixed count', () => {
    // No DOM in this module, so it cannot know how many chips fit at any real width - "measure, hide the overflow, count it" is myteam.js's own job (fitCoverageStripChips), not a built-in cutoff here. Four weak categories in, four chips out, every time.
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

// R5/S29: the strip's own control is the toggle now (the drawer's own X is gone, myteam.js's concern) - "Open" closed, "Close" open, off the caller's own opts.isOpen rather than a second place tracking drawer state.
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

test('B222 S54: drawer head: the same caption the strip carries, plus Close', () => {
    const html = buildCoverageDrawerHeadHtml(fixture, { escapeHtml: (s) => String(s) });
    assert(html.includes('<span class="mt-drawer-title">'), 'wrapped in one span so .mt-drawer-head keeps exactly two flex children');
    assert(html.includes('<span class="cvs-lab">Coverage</span>'), 'same caption label');
    assert(html.includes('<span class="cvs-window">the rest of the way</span>'), 'same window');
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
    assert(html.includes('Cheapest to lose: Utility Bat. They carry the least of what you are winning.'), 'the swap footer, once, at the end - the one sentence K1 leaves untouched (a whole-drawer fact, not a per-card one)');
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

// ==== S17b: "Losing" reads off the BAND's own rank (opts.losingIds/rankOf), never this model's own share-based `weak` - the ruling that answered the rank-badge scope question the strip/ drawer shipped without. The fixture's own HR (weak:true) / ERA,AVG (weak:false) let both directions of the disagreement be exercised on real fixture data. ====

test('B222 S54: strip: losingIds overrides row.weak - a model hole the band ranks well gets no chip of its own', () => {
    // HR (id 5) is the fixture's one model-weak category; here the BAND says it is fine (rank 1 of 4) and ERA (id 47, model-held) is the one actually bleeding (rank 4 of 4). The chip row is now the only signal of what is "losing" - it names ERA, not HR.
    const html = buildCoverageStripHtml(fixture, STAT_MAP, {
        losingIds: new Set(['47']),
        rankOf: (id) => ({ '5': { rank: 1, of: 4 }, 47: { rank: 4, of: 4 }, 2: { rank: 2, of: 4 } }[id] || null),
    });
    // ERA carries no adds in the fixture, so its chip is the "no add" variant (no cvs-chip-cat span of its own) - still the ONE chip the strip draws, which is the fact under test.
    assert(html.includes('<span class="cvs-chip cvs-chip-none">ERA: no add</span>'), 'ERA (band-bleeding) drives the strip\'s one chip');
    assert(!html.includes('Slugging Outfielder'), 'HR (model-weak but band-fine) contributes no chip');
});

test('B220 R11/Amendment 5, B222 S54: strip: a band-losing category with no model adds gets its own "no add" chip, not an omitted one', () => {
    // ERA (id 47) is band-losing here but carries no adds in the fixture (coverage-model never computed any for a held row) - the strip now says so rather than omitting the chip.
    const html = buildCoverageStripHtml(fixture, STAT_MAP, {
        losingIds: new Set(['47']),
        rankOf: () => null,
    });
    assert(html.includes('<span class="cvs-chip cvs-chip-none">ERA: no add</span>'), 'ERA gets its own "no add" chip');
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
    // HR's own card still carries its Best add group, read off row.weak (the model), unaffected by the badge above it having flipped to Winning. The next card's own opening tag (or the end of the string, for the last card) is the real boundary - a fixed character offset drifted out of sync with the card's own real length once K1's bar/chip markup replaced one sentence. 'class="cvd-card ' (a trailing space) matches only a CARD's own opening tag - "cvd-card- head"/"cvd-card-name"/etc within that same card never have a space right after "cvd-card".
    const nextCardStart = html.indexOf('class="cvd-card ', hrCardStart + 1);
    const hrCardHtml = html.slice(hrCardStart, nextCardStart === -1 ? undefined : nextCardStart);
    assert(hrCardHtml.includes('Slugging Outfielder'), 'HR\'s best add still shows in its own card despite the Winning badge');
});

// ==== R11/S48: the strip already gated its "no add found" chip on the band's own losing set (isLosingByRank), which happens to equal what the model searched (myteam.js passes the same set as both o.losingIds and the model's own searchIds) - no bug there. The DRAWER gated on row.weak ALONE, which is a real gap: a row losing by RANK but not a model hole (measured on the owner's team - wins and quality starts) is searched too, and used to have its whole "Best add" group skipped outright - not a false "no add found", but the opposite fault, a real add silently dropped. ====

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
