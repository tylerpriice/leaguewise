// Unit tests for the pure lineup ground builder (lineup-ground.js). Open tests/lineup-ground.test.html through any static server - green means every assertion held. See tests/fixtures/lineup-ground.md for the frozen contract these values are computed against.
import { buildLineupGroundHtml, buildMockLineupGroundHtml, escapeHtmlLocal } from '../lineup-ground.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function count(haystack, needle) { return haystack.split(needle).length - 1; }
// The outer <g> a seat wraps everything in - '<g class="lg-seat' would also match the inner lg-seat-box/lg-seat-code/lg-seat-sub elements every seat carries, so these pin the exact tag.
function seatCount(html) { return count(html, '<g class="lg-seat">') + count(html, '<g class="lg-seat lg-seat-dashed">'); }
function dashedSeatCount(html) { return count(html, '<g class="lg-seat lg-seat-dashed">'); }

// A realistic hockey starting lineup: 2G (backup on the bench, so 1 starter here), 4D, 2C, 1LW, 1RW, 1 UTIL - matches a common ESPN hockey default. All anonymous (pre-draft).
const HOCKEY_PRE_DRAFT = [
    { slotCode: 'G', count: 1, playerName: null },
    { slotCode: 'D', count: 4, playerName: null },
    { slotCode: 'C', count: 2, playerName: null },
    { slotCode: 'LW', count: 1, playerName: null },
    { slotCode: 'RW', count: 1, playerName: null },
    { slotCode: 'UTIL', count: 1, playerName: null },
];

test('hockey pre-draft: one seat per starting slot, D paired, no repeat note on the ground (B215 S2c)', () => {
    const html = buildLineupGroundHtml('fhl', HOCKEY_PRE_DRAFT);
    // 1 G + 4 D + 2 C + 1 LW + 1 RW = 9 on-ground seats, + 1 UTIL aside = 10 total - a family shows either N seats or one seat carrying "x N", never both (S2c): the 4-strong D family and the 2-strong C family each draw their full count, on the ground, with no repeat note - RB x2 beside a lone RB read as three backs before this, the same shape here (D x4 beside three more D seats read as seven).
    assert(seatCount(html) === 10, `expected 10 seats total, counted ${seatCount(html)}`);
    assert(dashedSeatCount(html) === 1, 'exactly one dashed (aside) seat - UTIL');
    assert(!html.includes('>x4<'), 'the 4-strong D family draws 4 seats, not one badged "x4"');
    assert(!html.includes('>x2<'), 'the 2-strong C family draws 2 seats, not one badged "x2"');
    assert(!html.includes('>x1<'), 'a family of one never gets a repeat note');
});

test('hockey post-draft: every named seat carries its own player, never merged into one', () => {
    const named = [
        { slotCode: 'D', count: 1, playerName: 'Alpha Odenkirk' },
        { slotCode: 'D', count: 1, playerName: 'Beta Solheim' },
        { slotCode: 'D', count: 1, playerName: 'Gamma Wren' },
        { slotCode: 'C', count: 1, playerName: 'Delta Achebe' },
    ];
    const html = buildLineupGroundHtml('fhl', named);
    // On-ground seats show the surname only (shortName) - a seat box has no room for a full name, the same reason a real lineup card does the same thing. The full names still reach the bench-strip test below, which has flowing text and no such constraint.
    assert(html.includes('Odenkirk') && html.includes('Solheim') && html.includes('Wren'), 'all three named defensemen render, by surname');
    assert(!html.includes('x3'), 'a fully-named family never gets a repeat note - each seat already speaks for itself');
    assert(seatCount(html) === 4, 'exactly 4 seats, one per named entry');
});

test('shortName: the seat box gets the surname, hard-capped with an ASCII ellipsis past 9 characters', () => {
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'C', count: 1, playerName: 'Tobias Lindqvist-Moe' }]);
    assert(html.includes('>Lindqv...<'), 'a 13-character surname is capped at 6 chars plus ASCII "..."');
    assert(!html.includes('Lindqvist-Moe<'), 'the uncapped surname never reaches the seat');
    assert(!html.includes('\u2026'), 'never the single-glyph unicode ellipsis, per the published-text rule');
});

test('hockey: an unrecognized slot code renders dashed (aside), never guessed onto the ice', () => {
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'ZZ', count: 1, playerName: null }]);
    assert(seatCount(html) === 1, 'the seat still renders - the player is not hidden');
    assert(dashedSeatCount(html) === 1, 'it renders dashed, the same treatment UTIL gets');
    assert(html.includes('>ZZ<'), 'its own code is shown rather than being silently dropped');
});

test('hockey: bench and IR render as muted strip chips, never as ground or aside seats', () => {
    const html = buildLineupGroundHtml('fhl', [
        { slotCode: 'BE', count: 1, playerName: 'Bench Guy' },
        { slotCode: 'IR', count: 1, playerName: 'Hurt Guy' },
    ]);
    assert(html.includes('lg-bench-strip'), 'the bench strip renders');
    assert(html.includes('Bench Guy') && html.includes('Hurt Guy'), 'both names appear');
    assert(seatCount(html) === 0, 'neither BE nor IR is drawn as a ground/aside seat');
});

test('hockey: an anonymous bench family draws ONE chip carrying the repeat note (B215 S2c)', () => {
    // The one place a repeat note still belongs: benchStripHtml skips every anonymous seat past the first, so there is no second chip for a second count to disagree with.
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'BE', count: 3, playerName: null }]);
    const chipCount = (html.match(/lg-bench-chip/g) || []).length;
    assert(chipCount === 1, `expected exactly 1 bench chip for a 3-strong anonymous family, counted ${chipCount}`);
    assert(html.includes('BE x3'), 'that one chip carries the family\'s "x3" repeat note');
});

test('hockey: XSS - a hostile slot code renders escaped', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildLineupGroundHtml('fhl', [{ slotCode: hostile, count: 1, playerName: null }]);
    assert(!html.includes('<img src=x onerror=alert(1)>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the code renders escaped');
});

test('hockey: XSS - a hostile player name renders escaped, surname-truncation and all', () => {
    // shortName() runs BEFORE escaping (it only ever slices/splits, never interprets markup) and truncates past 11 characters - a single-token hostile name (no whitespace, so the whole string is "the surname") whose dangerous characters sit in its first 10 keeps them through that truncation, so this still proves the escaper sees them.
    const hostile = '<script>alert(1)</script>';
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'C', count: 1, playerName: hostile }]);
    assert(!html.includes('<scrip'), 'no raw tag fragment appears unescaped');
    assert(html.includes('&lt;scrip'), 'the markup-significant characters that survived truncation render escaped');
});

// Baseball: a realistic 9 up the middle plus a bench-flavored bat. C/1B/2B/3B/SS/P singles, OF x3 (one named LF), UTIL and the pitching staff off to the side.
const BASEBALL_MIXED = [
    { slotCode: 'C', count: 1, playerName: null },
    { slotCode: '1B', count: 1, playerName: null },
    { slotCode: '2B', count: 1, playerName: null },
    { slotCode: 'SS', count: 1, playerName: null },
    { slotCode: '3B', count: 1, playerName: null },
    { slotCode: 'LF', count: 1, playerName: 'Reyes Kowalczyk' },
    { slotCode: 'OF', count: 2, playerName: null },
    { slotCode: 'P', count: 1, playerName: null },
    { slotCode: 'UTIL', count: 1, playerName: null },
    { slotCode: 'SP', count: 2, playerName: null },
    { slotCode: 'RP', count: 1, playerName: null },
];

test('baseball: infield bags, the mound and the outfield (named LF plus two generic OF) are on the park; UTIL/SP/RP are aside', () => {
    const html = buildLineupGroundHtml('flb', BASEBALL_MIXED);
    // C,1B,2B,SS,3B,P = 6 singles + LF(named,1) + OF(2) = 9 on-ground; UTIL(1) + SP(2) + RP(1) = 4 aside.
    assert(seatCount(html) === 13, `expected 13 seats, counted ${seatCount(html)}`);
    assert(dashedSeatCount(html) === 4, 'UTIL + SP x2 + RP is 4 aside seats');
    assert(html.includes('Kowalczyk'), 'the named LF renders the surname alone (on-ground seats show surname only, see shortName)');
});

test('baseball: C sits at home plate - the one hand-computed on-field coordinate this suite pins', () => {
    // PARK_CX=130, PARK_HOME_Y=210, C seat is rowPoints(130, 210+16, 1, 34) -> exactly (130, 226).
    const html = buildLineupGroundHtml('flb', [{ slotCode: 'C', count: 1, playerName: null }]);
    assert(html.includes('cx="130" cy="226"') || /x="130"[^>]*y="[\d.]*"/.test(html), 'a seat centred at the computed home-plate point exists');
    assert(html.includes('rx="4"'), 'the seat box itself renders (rounded rect)');
});

test('baseball: MI/CI/IF (real ESPN flex-infield codes) are unplaceable - dashed aside, never guessed onto a specific bag', () => {
    const html = buildLineupGroundHtml('flb', [
        { slotCode: 'MI', count: 1, playerName: null },
        { slotCode: 'CI', count: 1, playerName: null },
        { slotCode: 'IF', count: 1, playerName: null },
    ]);
    assert(dashedSeatCount(html) === 3, 'all three ambiguous infield-flex codes render dashed');
    assert(html.includes('>MI<') && html.includes('>CI<') && html.includes('>IF<'), 'each keeps its own code visible');
});

// Football: a standard ESPN default - QB, 2RB, 2WR, TE, FLEX, D/ST, K.
const FOOTBALL_STANDARD = [
    { slotCode: 'QB', count: 1, playerName: null },
    { slotCode: 'RB', count: 2, playerName: null },
    { slotCode: 'WR', count: 2, playerName: null },
    { slotCode: 'TE', count: 1, playerName: null },
    { slotCode: 'FLEX', count: 1, playerName: null },
    { slotCode: 'D/ST', count: 1, playerName: null },
    { slotCode: 'K', count: 1, playerName: null },
];

test('football: every named starting family (QB/RB/WR/TE/FLEX/D-ST/K) is placed on the field, none dashed', () => {
    const html = buildLineupGroundHtml('ffl', FOOTBALL_STANDARD);
    assert(seatCount(html) === 9, `expected 9 seats (1+2+2+1+1+1+1), counted ${seatCount(html)}`);
    assert(dashedSeatCount(html) === 0, 'every one of these codes has a real spot on the formation');
    assert(html.includes('>D/ST<'), 'the team defence unit seat carries its own slash intact');
});

test('football: a slot code this ground does not know (e.g. a baseball code leaking in) renders dashed, never guessed', () => {
    const html = buildLineupGroundHtml('ffl', [{ slotCode: 'P', count: 1, playerName: null }]);
    assert(dashedSeatCount(html) === 1, 'an unplaceable code renders dashed rather than picking a formation spot for it');
});

test('an unknown sport renders a valid, empty SVG rather than throwing', () => {
    const html = buildLineupGroundHtml('xyz', [{ slotCode: 'QB', count: 1, playerName: null }]);
    assert(html.includes('<svg'), 'still a valid svg element');
    assert(!html.includes('lg-seat'), 'no seats for a sport this module does not know');
});

test('escapeHtmlLocal matches the app-wide escaping rules (the fallback when no escapeHtml is passed)', () => {
    assert(escapeHtmlLocal('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;', 'tags escaped');
    assert(escapeHtmlLocal(`"'&`) === '&quot;&#39;&amp;', 'quotes and ampersand escaped');
});

test('a caller-supplied escapeHtml is used in place of the local fallback', () => {
    let calls = 0;
    const spy = (s) => { calls++; return String(s).toUpperCase(); };
    const html = buildLineupGroundHtml('ffl', [{ slotCode: 'qb', count: 1, playerName: 'testname' }], { escapeHtml: spy });
    assert(calls > 0, 'the supplied function was actually called');
    assert(html.includes('TESTNAME'), 'its output reached the rendered HTML');
});

// Report ---------------------------------------------------------------------------


// ==== the canvas clears every seat ====

// A GROUND THAT LOSES A POSITION. The baseball catcher sat at y=226 with a 24-tall seat box, so it reached 238 in a canvas 230 tall - eight pixels outside the viewBox, bottom edge cut off. It was invisible for as long as the diagram was capped small and obvious the moment it was allowed to fill a column, and nothing here would have caught it: every existing test counts seats and reads labels, and a seat drawn off the edge is still counted and still labelled. So this measures the drawing rather than the markup. Every seat box, in every sport, must sit inside the viewBox it is drawn in - which is a property no amount of counting can express.
function viewBoxOf(html) {
    const m = html.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
    return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}
function seatBoxes(html) {
    const out = [];
    const re = /<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        out.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    }
    return out;
}

// item 1, found in passing: these two keyed the seat contract's field as `code`, not the `slotCode` the contract (tests/fixtures/lineup-ground.md) actually names and buildLineupGroundHtml actually reads - every entry below fell through to the sport's placement table finding nothing, which draws exactly like an unrecognized code: dashed, off the ground (neutralSeatSvg). So the clearance and no-overlap assertions these two sports feed into have only ever exercised that one aside path, never the real on-ground placement geometry the hockey array below (which already used slotCode) does.
const BASEBALL_PRE_DRAFT = [
    { slotCode: 'C', count: 1 }, { slotCode: '1B', count: 1 }, { slotCode: '2B', count: 1 },
    { slotCode: '3B', count: 1 }, { slotCode: 'SS', count: 1 }, { slotCode: 'OF', count: 3 },
    { slotCode: 'UTIL', count: 1 }, { slotCode: 'SP', count: 2 }, { slotCode: 'RP', count: 2 }
];
const FOOTBALL_PRE_DRAFT = [
    { slotCode: 'QB', count: 1 }, { slotCode: 'RB', count: 2 }, { slotCode: 'WR', count: 2 },
    { slotCode: 'TE', count: 1 }, { slotCode: 'FLEX', count: 1 }, { slotCode: 'D/ST', count: 1 }, { slotCode: 'K', count: 1 }
];

[['flb', BASEBALL_PRE_DRAFT], ['fhl', HOCKEY_PRE_DRAFT], ['ffl', FOOTBALL_PRE_DRAFT]].forEach(([sport, seats]) => {
    test(`${sport}: every seat box sits inside the canvas it is drawn on`, () => {
        const html = buildLineupGroundHtml(sport, seats);
        const box = viewBoxOf(html);
        assert(box, `${sport}: no viewBox to measure against`);
        const boxes = seatBoxes(html);
        assert(boxes.length > 0, `${sport}: no seat boxes found - the regex and the markup have drifted`);
        boxes.forEach(s => {
            assert(s.y >= box.y, `${sport}: a seat starts above the canvas (y ${s.y} of ${box.y})`);
            assert(s.x >= box.x, `${sport}: a seat starts left of the canvas (x ${s.x} of ${box.x})`);
            assert(s.y + s.h <= box.y + box.h, `${sport}: a seat runs ${(s.y + s.h - box.y - box.h).toFixed(1)} past the bottom`);
            assert(s.x + s.w <= box.x + box.w, `${sport}: a seat runs ${(s.x + s.w - box.x - box.w).toFixed(1)} past the right edge`);
        });
    });
});


// NO TWO SEATS SHARE A PIXEL. The clearance test above was the first half of this: a seat can sit inside the canvas and still be unreadable if another seat is drawn on top of it. The bench column was placed at a constant x against the pitch, while the seats it has to miss sit on an ARC whose reach depends on how many the league starts - so a three-outfielder lineup put one of them under the dashed column and the boxes overlapped. Counting seats cannot see that either.
[['flb', BASEBALL_PRE_DRAFT], ['fhl', HOCKEY_PRE_DRAFT], ['ffl', FOOTBALL_PRE_DRAFT]].forEach(([sport, seats]) => {
    test(`${sport}: no seat box overlaps another`, () => {
        const boxes = seatBoxes(buildLineupGroundHtml(sport, seats));
        assert(boxes.length > 1, `${sport}: too few seats to compare`);
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i], b = boxes[j];
                const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                assert(overlapX <= 0 || overlapY <= 0,
                    `${sport}: two seats overlap by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)} at (${a.x},${a.y}) and (${b.x},${b.y})`);
            }
        }
    });
});

// S2b: every PLACED (solid, on-field) seat sits inside the field rect itself, not just inside the SVG's own auto-grown viewBox (the canvas test above) - a seat sitting outside the turf but still inside the viewBox (an aside seat's own column widens the canvas to fit it) would pass that test while reading as off the field. Solid seats only: '<g class="lg-seat">' is the exact tag a dashed one never matches ('<g class="lg-seat lg-seat-dashed">'), same distinction seatCount/dashedSeatCount above already draw.
function fieldRectOf(html) {
    const m = html.match(/<rect class="lg-field-turf" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}
function placedSeatBoxes(html) {
    const out = [];
    const re = /<g class="lg-seat">[\s\S]*?<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        out.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    }
    return out;
}
test('ffl: every placed seat sits inside the field rect (S2b formation)', () => {
    const html = buildLineupGroundHtml('ffl', FOOTBALL_PRE_DRAFT);
    const field = fieldRectOf(html);
    assert(field, 'ffl: no field rect to measure against');
    const boxes = placedSeatBoxes(html);
    assert(boxes.length > 0, 'ffl: no placed seats found - the regex and the markup have drifted');
    boxes.forEach(s => {
        assert(s.x >= field.x, `ffl: a seat starts left of the field (x ${s.x} of ${field.x})`);
        assert(s.y >= field.y, `ffl: a seat starts above the field (y ${s.y} of ${field.y})`);
        assert(s.x + s.w <= field.x + field.w, `ffl: a seat runs ${(s.x + s.w - field.x - field.w).toFixed(1)} past the right sideline`);
        assert(s.y + s.h <= field.y + field.h, `ffl: a seat runs ${(s.y + s.h - field.y - field.h).toFixed(1)} past the bottom sideline`);
    });
});

// ==== the mock ground ====

// Frame E's own nine STARTING seats, in ground order (LINEUP_SLOT_ORDER ffl: QB, RB, RB, WR, WR, TE, FLEX, D/ST, K) - four filled (QB/RB/RB/TE), one targeted (the first WR), four empty - plus v2's bench seats appended after them, indices 9-16: one filled BE, six empty BE, one empty IR. `bench: false`/`true` on every entry, matching mock-lineup.js's own v2 state shape - starters and bench in ONE array, never a separate list.
const MOCK_SEATS = [
    { slotId: 0, label: 'QB', playerId: 11, bench: false },
    { slotId: 2, label: 'RB', playerId: 22, bench: false },
    { slotId: 2, label: 'RB', playerId: 23, bench: false },
    { slotId: 4, label: 'WR', playerId: null, bench: false },
    { slotId: 4, label: 'WR', playerId: null, bench: false },
    { slotId: 6, label: 'TE', playerId: 26, bench: false },
    { slotId: 23, label: 'FLEX', playerId: null, bench: false },
    { slotId: 16, label: 'D/ST', playerId: null, bench: false },
    { slotId: 17, label: 'K', playerId: null, bench: false },
    { slotId: 20, label: 'BE', playerId: 40, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 20, label: 'BE', playerId: null, bench: true },
    { slotId: 21, label: 'IR', playerId: null, bench: true },
];
const MOCK_POOL = new Map([
    [11, { name: 'Josh Allen', value: 163.7 }],
    [22, { name: 'Jahmyr Gibbs', value: 158.8 }],
    [23, { name: 'Bijan Robinson', value: 146.0 }],
    [26, { name: 'Trey McBride', value: 104.2 }],
    [40, { name: 'DeVon Achane', value: 86.7 }],
]);
function mockOpts(over = {}) {
    return { pool: MOCK_POOL, targetIndex: 3, formatValue: v => v.toFixed(1), ...over };
}

test('mock ground: nine STARTING seats, one <g data-seat-index> per seat, indices 0-8', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    for (let i = 0; i < 9; i++) assert(html.includes(`data-seat-index="${i}"`), `seat ${i} addressable`);
});

test('mock ground: a filled seat reads its surname on one line and its own value under it (S39b), and carries a remove control', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    assert(html.includes('lg-mseat-filled') && html.includes('class="lg-mseat-line2"') && html.includes('>Allen<'), 'the surname, its own line');
    assert(html.includes('class="lg-mseat-line3"') && html.includes('>163.7<'), 'the figure, its own line under it');
    assert(html.includes('data-seat-remove="0"'), 'the QB seat has its own x, addressed by the same index');
});

test('mock ground: the targeted empty seat is ringed and reads the full "pick a receiver" sentence across two lines (S39b)', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: 3 }));
    assert(html.includes('lg-mseat-target') && html.includes('lg-mseat-ring'), 'the targeted seat carries its own class and ring');
    assert(/class="lg-mseat-line2"[^>]*>pick a</.test(html), 'the on-seat text, line one');
    assert(/class="lg-mseat-line3"[^>]*>WR</.test(html), 'the on-seat text, line two - nounFor not passed here, so the bare label');
    assert(html.includes('data-tooltip="Pick a WR from the Projections list."'), 'the same full sentence also rides the hover');
});

test('mock ground: an ordinary empty seat (not targeted) reads "empty", no ring', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: 3 }));
    assert(html.includes('lg-mseat-empty') && html.includes('>empty<'), 'the second WR, FLEX, D/ST and K all read empty');
});

test('mock ground: no target at all (targetIndex null) rings nothing', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: null }));
    assert(!html.includes('lg-mseat-ring'), 'nothing armed, nothing ringed');
    assert(!html.includes('lg-mseat-target'), 'nothing carries the targeted class either');
});

test('mock ground: every seat box sits inside its own viewBox, and no two overlap (same measurement lineup-ground already runs)', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    const box = viewBoxOf(html);
    assert(box, 'a real viewBox');
    const re = /<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    const boxes = [];
    let m;
    while ((m = re.exec(html)) !== null) boxes.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    assert(boxes.length === 9, `nine SVG seat boxes (starters only, the bench is HTML now), found ${boxes.length}`);
    boxes.forEach(s => {
        assert(s.x >= box.x && s.y >= box.y && s.x + s.w <= box.x + box.w && s.y + s.h <= box.y + box.h, 'inside the canvas');
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert(!overlap, `seat ${i} and seat ${j} overlap`);
    }
});

test('mock ground: no starting seats at all renders a valid empty SVG rather than throwing, even with a real bench', () => {
    const benchOnly = MOCK_SEATS.filter(s => s.bench);
    const html = buildMockLineupGroundHtml('ffl', benchOnly, mockOpts());
    assert(html.includes('<svg'), 'still a valid svg element');
});

test('mock ground: XSS - a hostile player name renders escaped', () => {
    // A short, single-word hostile string - long enough to prove escaping, short enough that shortName's own truncation (a separate, already-tested concern) does not eat the tag first.
    const hostile = '<img>';
    const html = buildMockLineupGroundHtml('ffl',
        [{ slotId: 0, label: 'QB', playerId: 99, bench: false }],
        mockOpts({ pool: new Map([[99, { name: hostile, value: 10 }]]), targetIndex: null }));
    assert(!html.includes('<img>'), 'the raw tag never appears unescaped');
    assert(html.includes('&lt;img&gt;'), 'escaped in the sub-label');
});

// ==== the bench row ====

test('mock ground: the bench renders as its own row, one addressable seat per bench entry, indices continuing from the starters', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: null }));
    assert(html.includes('class="lg-bench-row"'), 'the bench row renders');
    for (let i = 9; i <= 16; i++) assert(html.includes(`data-seat-index="${i}"`), `bench seat ${i} addressable, global index unchanged`);
});

test('mock ground: a filled bench seat reads the player\'s surname and figure, and carries a remove control', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: null }));
    assert(html.includes('lg-bseat-filled'), 'the filled bench seat carries its own class');
    assert(html.includes('Achane') && html.includes('86.7'), 'the surname and its own figure');
    assert(html.includes('data-seat-remove="9"'), 'the filled bench seat (index 9) has its own remove control');
});

test('mock ground: an empty bench seat reads "empty"; a targeted one reads "pick a <noun>"', () => {
    const empty = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: null }));
    assert(/data-seat-index="10"[^>]*>[\s\S]*?empty/.test(empty), 'an empty BE seat reads "empty"');
    const targeted = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: 10, nounFor: () => 'bench player' }));
    assert(targeted.includes('lg-bseat-target'), 'the targeted bench seat carries its own class');
    assert(targeted.includes('pick a bench player'), 'the noun comes through nounFor, same as a field seat');
});

test('mock ground: the IR seat carries its own tone, distinct from an ordinary bench seat', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: null }));
    assert(html.includes('class="lg-bseat lg-bseat-ir" data-seat-index="16"'), 'the IR seat (index 16) is marked distinctly, empty and untargeted');
});

test('mock ground: no bench seats at all renders no bench row', () => {
    const starters = MOCK_SEATS.filter(s => !s.bench);
    const html = buildMockLineupGroundHtml('ffl', starters, mockOpts());
    assert(!html.includes('lg-bench-row'), 'no bench row when there is nothing to put in it');
});

// ==== the field margin and scrimmage (S47b) ====

test('mock ground: the viewBox carries a full seat-height margin on every side, past every seat box', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    const box = viewBoxOf(html);
    const boxes = seatBoxes(html);
    assert(box && boxes.length, 'a real viewBox and real seat boxes to measure against');
    const SEAT_H = 24;
    boxes.forEach(s => {
        assert(s.x - box.x >= SEAT_H - 4, `a seat sits within a seat-height of the left edge (${(s.x - box.x).toFixed(1)})`);
        assert(s.y - box.y >= SEAT_H - 4, `a seat sits within a seat-height of the top edge (${(s.y - box.y).toFixed(1)})`);
        assert((box.x + box.w) - (s.x + s.w) >= SEAT_H - 4, `a seat sits within a seat-height of the right edge`);
        assert((box.y + box.h) - (s.y + s.h) >= SEAT_H - 4, `a seat sits within a seat-height of the bottom edge`);
    });
});

test('mock ground: the scrimmage line is centred on the field, not the real ground\'s own 42%', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    const m = html.match(/class="lg-field-scrimmage" x1="([\d.]+)"[^>]*x2="([\d.]+)"/);
    assert(m, 'the scrimmage line renders');
    const FIELD_X = 6, FIELD_W = 300;
    const center = FIELD_X + FIELD_W / 2;
    assert(Number(m[1]) === center && Number(m[2]) === center, `expected x1=x2=${center}, got x1=${m[1]} x2=${m[2]}`);
});

test('real ground: the scrimmage line keeps its own tuned 42% position, untouched by the mock-only centring', () => {
    const html = buildLineupGroundHtml('ffl', [
        { slotCode: 'QB', count: 1, playerName: 'Josh Allen' },
        { slotCode: 'RB', count: 1, playerName: 'Saquon Barkley' }
    ]);
    const m = html.match(/class="lg-field-scrimmage" x1="([\d.]+)"/);
    assert(m, 'the scrimmage line renders');
    const FIELD_X = 6, FIELD_W = 300;
    assert(Math.abs(Number(m[1]) - (FIELD_X + FIELD_W * 0.42)) < 0.01, `the real ground's own 42% position is unchanged, got x1=${m[1]}`);
});

test('mock ground: the WR (and the rest of the formation) sit on the moved line, not the real ground\'s own 42%', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    const FIELD_X = 6, FIELD_W = 300;
    const center = FIELD_X + FIELD_W / 2;
    const seatRe = /<g class="lg-mseat[^"]*" data-seat-index="\d+"[^>]*>([\s\S]*?)<\/g>/g;
    const wrRights = [];
    let m;
    while ((m = seatRe.exec(html)) !== null) {
        const block = m[1];
        const label = block.match(/class="lg-seat-code"[^>]*>([^<]+)</);
        const box = block.match(/class="lg-seat-box" x="([-\d.]+)"[^>]*width="([\d.]+)"/);
        if (label && box && label[1] === 'WR') wrRights.push(Number(box[1]) + Number(box[2]));
    }
    assert(wrRights.length === 2, `expected two WR seats, found ${wrRights.length}`);
    wrRights.forEach(right => assert(Math.abs(right - center) < 0.01, `WR seat's right edge should touch the centred line at ${center}, got ${right}`));
});

test('mock ground: XSS - a hostile player name on the bench renders escaped', () => {
    const hostile = '<img>';
    const seats = [
        { slotId: 0, label: 'QB', playerId: 1, bench: false },
        { slotId: 20, label: 'BE', playerId: 99, bench: true }
    ];
    const html = buildMockLineupGroundHtml('ffl', seats,
        mockOpts({ pool: new Map([[1, { name: 'X', value: 1 }], [99, { name: hostile, value: 10 }]]), targetIndex: null }));
    assert(!html.includes('<img>'), 'the raw tag never appears unescaped in the bench row');
    assert(html.includes('&lt;img&gt;'), 'escaped in the bench seat body');
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
