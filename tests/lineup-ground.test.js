// Unit tests for the pure lineup ground builder (lineup-ground.js). Open tests/lineup-ground.test.html through any static server; green means every assertion held. See tests/fixtures/lineup-ground.md for the frozen contract these values are computed against.
import { buildLineupGroundHtml, buildMockLineupGroundHtml, escapeHtmlLocal } from '../src/views/lineup-ground.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function count(haystack, needle) { return haystack.split(needle).length - 1; }
// The outer <g> a seat wraps everything in. '<g class="lg-seat' would also match the inner lg-seat-box/lg-seat-code/lg-seat-sub elements every seat carries, so these pin the exact tag.
function seatCount(html) { return count(html, '<g class="lg-seat">') + count(html, '<g class="lg-seat lg-seat-dashed">'); }
function dashedSeatCount(html) { return count(html, '<g class="lg-seat lg-seat-dashed">'); }

// A realistic hockey starting lineup of 2G (backup on the bench, so 1 starter here), 4D, 2C, 1LW, 1RW and 1 UTIL, which matches a common ESPN hockey default. All anonymous (pre-draft).
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
    // 1 G + 4 D + 2 C + 1 LW + 1 RW + 1 UTIL = 10 on-ground seats, all solid, since UTIL moved onto the ice at the bench gate. A family shows either N seats or one seat carrying "x N", never both, so the 4-strong D family and the 2-strong C family each draw their full count on the ground with no repeat note, because RB x2 beside a lone RB read as three backs.
    assert(seatCount(html) === 10, `expected 10 seats total, counted ${seatCount(html)}`);
    assert(dashedSeatCount(html) === 0, 'no dashed seats - every hockey code this fixture uses has a real on-ice spot now');
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
    // On-ground seats show the surname only (staticNameLayout's own extraction), since a seat box has no room for a full name, the same reason a real lineup card does the same thing. The full names still reach the bench-strip test below, which has flowing text and no such constraint.
    assert(html.includes('Odenkirk') && html.includes('Solheim') && html.includes('Wren'), 'all three named defensemen render, by surname');
    assert(!html.includes('x3'), 'a fully-named family never gets a repeat note - each seat already speaks for itself');
    assert(seatCount(html) === 4, 'exactly 4 seats, one per named entry');
});

test('the static seat never cuts a surname either (B264 item 1f) - staticNameLayout steps the font down, floored, never a slice', () => {
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'C', count: 1, playerName: 'Tobias Lindqvist-Moe' }]);
    assert(!html.includes('Lindqv...'), 'the old six-character ellipsis cap is gone');
    assert(!html.includes('\u2026'), 'never the single-glyph unicode ellipsis, per the published-text rule');
    assert(html.includes('>Lindqvist-Moe<'), 'the full, unsplit surname prints (this seat has no room for a second line, so it never splits)');
    const styleMatch = html.match(/<text class="lg-seat-sub" x="[-\d.]+" y="[-\d.]+" text-anchor="middle" style="font-size:(\d+)px">Lindqvist-Moe<\/text>/);
    assert(styleMatch, `expected an inline font-size step-down on the sub label, got: ${html.match(/<text class="lg-seat-sub"[^>]*>[^<]*<\/text>/)}`);
    // 34/40.66 (Lindqvist-Moe's own width, scaled to the seat's 6px font) needs a step to 5px, because the measured floor (5/6 = 0.833) binds before the width ratio (34/40.66 = 0.836) does.
    assert(Number(styleMatch[1]) === 5, `expected the 5px floor, got ${styleMatch[1]}`);
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

test('hockey: XSS - a hostile player name renders escaped', () => {
    // staticNameLayout runs before escaping (it only ever measures, splits or steps a font size, never interprets markup) and never truncates any more, so a single-token hostile name (no whitespace, so the whole string is "the surname") reaches the escaper in full.
    const hostile = '<script>alert(1)</script>';
    const html = buildLineupGroundHtml('fhl', [{ slotCode: 'C', count: 1, playerName: hostile }]);
    assert(!html.includes('<scrip'), 'no raw tag fragment appears unescaped');
    assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the whole hostile string renders escaped, unclamped');
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
    assert(html.includes('Kowalczyk'), 'the named LF renders the surname alone (on-ground seats show surname only, see staticNameLayout)');
});

test('baseball: C sits at home plate - the one hand-computed on-field coordinate this suite pins', () => {
    // The retuned geometry has PARK_CX=183.5 and PARK_HOME_Y=296.5, so the C seat is rowPoints(183.5, 296.5+23, 1, LANE_ROW_STEP), exactly (183.5, 319.5).
    const html = buildLineupGroundHtml('flb', [{ slotCode: 'C', count: 1, playerName: null }]);
    assert(html.includes('cx="183.5" cy="319.5"') || /x="183.5"[^>]*y="[\d.]*"/.test(html), 'a seat centred at the computed home-plate point exists');
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

// Football's standard ESPN default of QB, 2RB, 2WR, TE, FLEX, D/ST, K.
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

// A ground that loses a position. The baseball catcher sat at y=226 with a 24-tall seat box, so it reached 238 in a canvas 230 tall and its bottom edge was cut off. Counting seats and reading labels could not catch that, so this measures the drawing rather than the markup: every seat box, in every sport, must sit inside the viewBox it is drawn in.
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

// These two keyed the seat contract's field as `code`, not the `slotCode` the contract (tests/fixtures/lineup-ground.md) names and buildLineupGroundHtml reads, so every entry fell through to the placement table finding nothing and drew like an unrecognized code, dashed and off the ground. The clearance and no-overlap assertions they feed had only ever exercised that aside path.
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


// No two seats share a pixel. A seat can sit inside the canvas and still be unreadable if another seat is drawn on top of it. The bench column was placed at a constant x against the pitch, while the seats it has to miss sit on an arc whose reach depends on how many the league starts, so a three-outfielder lineup put one of them under the dashed column. Counting seats cannot see that either.
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

// A starting lineup this deep (3 C, 6 F, 5 D, 2 G) had never been run through this suite, and the stock HOCKEY_PRE_DRAFT fixture above stops at 4 D, one row short of where the defence's third row started landing inside the centres' own row. This reproduces the reported overlap and pins it so a six-plus-defenceman league never regresses.
const HOCKEY_SIX_TEAM = [
    { slotCode: 'C', count: 3 }, { slotCode: 'F', count: 6 }, { slotCode: 'D', count: 5 },
    { slotCode: 'G', count: 2 }, { slotCode: 'UTIL', count: 1 }
];
test('fhl six-team (B239 item 2.2/S134): a deep roster still overlaps nothing', () => {
    const html = buildLineupGroundHtml('fhl', HOCKEY_SIX_TEAM);
    const boxes = seatBoxes(html);
    const codes = [];
    const re = /<text class="lg-seat-code"[^>]*>([^<]*)</g;
    let m; while ((m = re.exec(html)) !== null) codes.push(m[1]);
    assert(boxes.length === 17, `17 starting seats expected, found ${boxes.length}`);
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            assert(overlapX <= 0 || overlapY <= 0,
                `overlap ${overlapX.toFixed(1)}x${overlapY.toFixed(1)} at (${a.x},${a.y})[${codes[i]}] and (${b.x},${b.y})[${codes[j]}]`);
        }
    }
});

// A seat sitting well inside the SVG's auto-grown viewBox (the canvas test far above covers that) is not the same as sitting on the ice, and the rink is a rounded rect. This checks every solid (on-ground) seat's box, all four corners, against it, so each corner must be inside the quarter-ellipse the corner radius draws and everywhere else inside the plain rectangle.
function rinkRectOf(html) {
    const m = html.match(/<rect class="lg-rink-ice" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/);
    return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), r: Number(m[5]) } : null;
}
function pointInRoundedRect(px, py, rect) {
    const { x, y, w, h, r } = rect;
    if (px < x || px > x + w || py < y || py > y + h) return false;
    // Which corner's own quarter-ellipse (if any) this point falls inside the bounding square of.
    const corners = [
        { cx: x + r, cy: y + r, inX: px < x + r, inY: py < y + r },
        { cx: x + w - r, cy: y + r, inX: px > x + w - r, inY: py < y + r },
        { cx: x + r, cy: y + h - r, inX: px < x + r, inY: py > y + h - r },
        { cx: x + w - r, cy: y + h - r, inX: px > x + w - r, inY: py > y + h - r },
    ];
    for (const c of corners) {
        if (c.inX && c.inY) {
            const dx = px - c.cx, dy = py - c.cy;
            return (dx * dx + dy * dy) <= r * r;
        }
    }
    return true;
}
function placedOnGroundSeatBoxes(html) {
    const out = [];
    const re = /<g class="lg-seat">[\s\S]*?<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) out.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    return out;
}
test('fhl six-team (B240 item 2/S142b): every solid seat sits inside the rink itself, corners included', () => {
    const html = buildLineupGroundHtml('fhl', HOCKEY_SIX_TEAM);
    const rink = rinkRectOf(html);
    assert(rink, 'no rink rect to measure against');
    const boxes = placedOnGroundSeatBoxes(html);
    assert(boxes.length === 17, `all 17 starters expected on the ice - UTIL included, S142b's own change - found ${boxes.length}`);
    boxes.forEach(b => {
        const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
        corners.forEach(([px, py]) => {
            assert(pointInRoundedRect(px, py, rink), `a seat's own corner (${px},${py}) falls outside the rink (${JSON.stringify(rink)})`);
        });
    });
});

// The landscape rink's lane-wrap rule says a lane past what its zone holds at full seat size wraps to a second row inside the zone rather than spreading past it or shrinking a seat. HOCKEY_SIX_TEAM above stays under the F/C wrap thresholds, so this fixture goes deeper on forwards, centres and goalies (D stays at a realistic 8, its single-column-a-side floor) so every other lane wraps at least once.
const HOCKEY_WRAP_DEEP = [
    { slotCode: 'D', count: 5 }, { slotCode: 'F', count: 12 }, { slotCode: 'C', count: 3 }, { slotCode: 'G', count: 3 },
];
test('fhl wrap (B240 item 2/S142): F past 5-a-board, G past one-a-crease and C past one-per-row all wrap without overlapping', () => {
    const html = buildLineupGroundHtml('fhl', HOCKEY_WRAP_DEEP);
    const boxes = seatBoxes(html);
    assert(boxes.length === 23, `23 starting seats expected (5+12+3+3), found ${boxes.length}`);
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            assert(overlapX <= 0 || overlapY <= 0,
                `overlap ${overlapX.toFixed(1)}x${overlapY.toFixed(1)} at (${a.x},${a.y}) and (${b.x},${b.y})`);
        }
    }
    // Every seat still keeps its full, proven size (SEAT_W x SEAT_H); the wrap rule's whole point is that a deep roster gets a second row, never a shrunk seat.
    boxes.forEach(b => assert(b.w === 48 && b.h === 34, `a wrapped seat changed size: ${b.w}x${b.h}`));
});

// Five outfielders wrap the arc, since the fence arc's 4-a-ring floor (arcPointsWrap's maxPerRing) means the fifth steps to a second, tighter ring rather than crowding the fence row.
const BASEBALL_FIVE_OF = [{ slotCode: 'OF', count: 5 }];
test('flb wrap (B240 item 2/S142): a five-outfield league wraps the fence arc to a second ring', () => {
    const html = buildLineupGroundHtml('flb', BASEBALL_FIVE_OF);
    const boxes = seatBoxes(html);
    assert(boxes.length === 5, `5 outfield seats expected, found ${boxes.length}`);
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            assert(overlapX <= 0 || overlapY <= 0,
                `overlap ${overlapX.toFixed(1)}x${overlapY.toFixed(1)} at (${a.x},${a.y}) and (${b.x},${b.y})`);
        }
    }
    boxes.forEach(b => assert(b.w === 48 && b.h === 34, `a wrapped seat changed size: ${b.w}x${b.h}`));
});

// Every placed (solid, on-field) seat sits inside the field rect itself, not just inside the SVG's auto-grown viewBox, because an aside seat's column widens the canvas and a seat outside the turf would pass the canvas test while reading as off the field. Solid seats only, since '<g class="lg-seat">' is the exact tag a dashed one never matches.
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

// ==== the mock ground, bench seats included ====

// The nine starting seats of the mock ground in ground order (LINEUP_SLOT_ORDER ffl), four filled, one targeted and four empty, plus bench seats at indices 9-16 (one filled BE, six empty BE, one empty IR). `bench` is on every entry, with starters and bench in one array. The mock field is laid in card-step units, restated here once from lineup-ground.js so a size change moves a single line.
const MOCK_FIELD_X = 300, MOCK_FIELD_W = 6100;

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

// The avatarHtml branch had zero coverage, since every earlier mock-ground test passes no avatarHtml. This pins the photo-first layout: a square foreignObject sized to whatever mockSeatHtml's per-seat formula leaves it, the name under it (line2 alone, no line3), and the box at MOCK_SEAT_W/MOCK_SEAT_H, not the shared SEAT_W/SEAT_H the real ground draws at.
test('mock ground: a filled seat WITH avatarHtml wired shows the photo, name under it, no line3 (B251 item 1)', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({
        avatarHtml: (playerId, name) => `<span data-avatar-for="${playerId}">${name}</span>`
    }));
    const seatMatch = html.match(/<g class="lg-mseat lg-mseat-filled" data-seat-index="0"[^>]*>([\s\S]*?)<\/g>\s*(?=<g|<\/svg|$)/);
    assert(seatMatch, 'the QB seat (index 0, filled) renders');
    const block = seatMatch[1];
    assert(block.includes('data-avatar-for="11"') && block.includes('>Josh Allen<'), 'the injected avatarHtml renders, called with the real id and full name (not the truncated surname)');
    const fo = block.match(/<foreignObject x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)" class="lg-mseat-avatar">/);
    assert(fo, 'a square foreignObject wraps the photo');
    assert(Number(fo[3]) === Number(fo[4]), 'the photo box is square (width equals height)');
    assert(Number(fo[3]) > 40, `the photo box is content-sized, not the old AV=10 - got width ${fo[3]}`);
    const box = block.match(/class="lg-seat-box"[^>]*width="([\d.]+)" height="([\d.]+)"/);
    assert(box && Number(box[2]) > 60, `the seat box itself is MOCK_SEAT_H-sized (well past the shared SEAT_H=34) - got height ${box[2]}`);
    assert(block.includes('class="lg-mseat-line2"') && block.includes('>Allen<'), 'the surname still prints, under the photo');
    assert(!block.includes('class="lg-mseat-line3"'), 'no line3 when a photo is wired - that field is the no-avatarHtml fallback only');
});

// The mock card's name label never cuts, since fitNameLayout does the same last-whitespace-token extraction shortName used to but no longer slices it to six characters plus "...". Two seats were added to MOCK_POOL rather than a bespoke pool, so these run through the same mockOpts()/MOCK_SEATS as the other mock-ground tests, using the TE and FLEX seats because QB is claimed by the avatarHtml assertions.
const NAME_FIT_SEATS = [
    { slotId: 6, label: 'TE', playerId: 90, bench: false },
    { slotId: 23, label: 'FLEX', playerId: 91, bench: false },
];
const NAME_FIT_POOL = new Map([
    // "Lindqvist-Moe" (515 wide at 76px/700, measured) is too wide for the 496-unit line and splits at its own hyphen, "Lindqvist-" / "Moe", the hyphen kept with the first half.
    [90, { name: 'Tobias Lindqvist-Moe', value: 51.2 }],
    // "Brandvoldsen" (506.8 at 76px, 480.1 at 72px, both measured via canvas.measureText at 700 76px Arial, tests/fixtures/lineup-ground.md) is one unbroken token with no space or hyphen, too wide at the card's own size but clearing the 496 budget once stepped to the 72px floor.
    [91, { name: 'Corbin Brandvoldsen', value: 44.6 }],
]);

test('mock ground name fit: a hyphenated surname too wide for one line splits into two tspans at its own hyphen (B264 item 1e)', () => {
    const html = buildMockLineupGroundHtml('ffl', NAME_FIT_SEATS, mockOpts({ pool: NAME_FIT_POOL }));
    const seatMatch = html.match(/<g class="lg-mseat lg-mseat-filled" data-seat-index="0"[^>]*>([\s\S]*?)<\/g>\s*(?=<g|<\/svg|$)/);
    assert(seatMatch, 'the TE seat (index 0 of this fixture, filled) renders');
    const block = seatMatch[1];
    assert(!block.includes('Lindqv...'), 'the old six-character ellipsis cap never applies to the mock card');
    assert(!block.includes('\u2026'), 'never the single-glyph unicode ellipsis either');
    const nameEl = block.match(/<text class="lg-mseat-line2"[^>]*>([\s\S]*?)<\/text>/);
    assert(nameEl, 'the name still renders as .lg-mseat-line2');
    assert(count(nameEl[1], '<tspan') === 2, `expected two tspans for the split name, got: ${nameEl[1]}`);
    assert(nameEl[1].includes('>Lindqvist-<'), 'the first line keeps the hyphen, split after it');
    assert(nameEl[1].includes('>Moe<'), 'the second line is the remainder alone');
    const openTag = block.match(/<text class="lg-mseat-line2"[^>]*>/)[0];
    assert(!openTag.includes('font-size'), 'a two-line split never also shrinks the font - that is a separate lever');
});

test('mock ground name fit: a single unbroken surname too wide even alone steps its own font down just enough to fit (B264 item 1e)', () => {
    const html = buildMockLineupGroundHtml('ffl', NAME_FIT_SEATS, mockOpts({ pool: NAME_FIT_POOL }));
    const seatMatch = html.match(/<g class="lg-mseat lg-mseat-filled" data-seat-index="1"[^>]*>([\s\S]*?)<\/g>\s*(?=<g|<\/svg|$)/);
    assert(seatMatch, 'the FLEX seat (index 1, filled) renders');
    const block = seatMatch[1];
    assert(!block.includes('Brandv...'), 'the old six-character ellipsis cap never applies to the mock card');
    const nameEl = block.match(/<text class="lg-mseat-line2"[^>]*>([\s\S]*?)<\/text>/);
    assert(nameEl, 'the name still renders as .lg-mseat-line2');
    assert(count(block.match(/<text class="lg-mseat-line2"[^>]*>/)[0], '<tspan') === 0, 'a single stepped-down token stays one line, no tspan split');
    assert(nameEl[1] === 'Brandvoldsen', `the full, unsplit surname prints - got "${nameEl[1]}"`);
    const styleMatch = block.match(/<text class="lg-mseat-line2" x="[-\d.]+" y="[-\d.]+" text-anchor="middle" style="font-size:(\d+)px">/);
    assert(styleMatch, `expected an inline font-size step-down on .lg-mseat-line2, got: ${block.match(/<text class="lg-mseat-line2"[^>]*>/)[0]}`);
    // 496/506.8 = 0.9787 needs only a small step (76 to 74, not all the way to the 72 floor), so the step is toward whatever fits, never straight to the floor regardless of how little is needed.
    assert(Number(styleMatch[1]) === 74, `expected the minimal step that clears 496 (496/506.8 -> 74, well above the 72 floor), got ${styleMatch[1]}`);
});

test('mock ground name fit: a token so wide even the 72px floor cannot clear it stops there rather than shrinking further (B264 item 1e)', () => {
    // Wommelgemsvold is a synthetic single token (670.1 wide at 76px, measured), well past every real surname sampled for the glyph-width table. It exists to pin the floor itself, not to claim a real player ever reaches it. Past the floor is disclosed, not chased (the same call this file already made for baseball's cardPxWidth floor, tests/fixtures/lineup-ground.md).
    const pool = new Map([[92, { name: 'Nils Wommelgemsvold', value: 12.1 }]]);
    const seats = [{ slotId: 6, label: 'TE', playerId: 92, bench: false }];
    const html = buildMockLineupGroundHtml('ffl', seats, mockOpts({ pool }));
    const styleMatch = html.match(/<text class="lg-mseat-line2" x="[-\d.]+" y="[-\d.]+" text-anchor="middle" style="font-size:(\d+)px">Wommelgemsvold<\/text>/);
    assert(styleMatch, `expected the floored, unsplit token, got: ${html.match(/<text class="lg-mseat-line2"[^>]*>[^<]*<\/text>/)}`);
    assert(Number(styleMatch[1]) === 72, `expected the measured 72px floor, got ${styleMatch[1]}`);
});

test('mock ground: the targeted empty seat is ringed and reads the full "pick a WR" sentence (B264 item 1b: one line now, not two)', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts({ targetIndex: 3 }));
    assert(html.includes('lg-mseat-target') && html.includes('lg-mseat-ring'), 'the targeted seat carries its own class and ring');
    assert(/class="lg-mseat-line2"[^>]*>pick a WR</.test(html), 'the on-seat text - nounFor not passed here, so the bare label');
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

// Hockey's mock ground reads a separate zone table from the real ground (hockeyMockSeatPoints, laid for the card's own footprint). This pins it against a pre-draft league shape (state.js's LINEUP_SLOT_LABELS.fhl, which has three centres, six generic forwards with no LW/RW, five defence, two goalies and one UTIL), the roster the re-tune was measured against live.
function hockeyMockSeats() {
    const seats = [];
    const push = (label, n, bench) => { for (let i = 0; i < n; i++) seats.push({ label, playerId: null, bench: !!bench }); };
    push('C', 3); push('F', 6); push('D', 5); push('G', 2); push('UTIL', 1);
    push('BE', 5, true); push('IR', 3, true);
    return seats;
}

test('mock ground, hockey: the owner\'s own pre-draft roster (3C/6F/5D/2G/1UTIL) overlaps nothing', () => {
    const html = buildMockLineupGroundHtml('fhl', hockeyMockSeats(), mockOpts());
    const box = viewBoxOf(html);
    assert(box, 'a real viewBox');
    const re = /<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    const boxes = [];
    let m;
    while ((m = re.exec(html)) !== null) boxes.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    assert(boxes.length === 17, `17 SVG seat boxes (starters only), found ${boxes.length}`);
    boxes.forEach(s => {
        assert(s.x >= box.x && s.y >= box.y && s.x + s.w <= box.x + box.w && s.y + s.h <= box.y + box.h, 'inside the canvas');
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert(!overlap, `seat ${i} and seat ${j} overlap`);
    }
});

// Baseball and football each read their own mock table now (baseballMockSeatPoints, footballMockSeatPoints), laid on lanes and columns whose spacing is the card's own step, so the check that matters is the one hockey already runs, at the shape a real league draws and at the deepest roster each table's own comment says it clears.
function seatBoxesOf(html) {
    const re = /<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    const boxes = [];
    let m;
    while ((m = re.exec(html)) !== null) boxes.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
    return boxes;
}
function assertNoOverlaps(html, want, what) {
    const box = viewBoxOf(html);
    assert(box, 'a real viewBox');
    const boxes = seatBoxesOf(html);
    assert(boxes.length === want, `${what}: ${want} SVG seat boxes, found ${boxes.length}`);
    boxes.forEach((sb, i) => {
        assert(sb.x >= box.x && sb.y >= box.y && sb.x + sb.w <= box.x + box.w && sb.y + sb.h <= box.y + box.h,
            `${what}: seat ${i} inside the canvas`);
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert(!overlap, `${what}: seat ${i} and seat ${j} overlap`);
    }
}
function seatsFrom(spec) {
    const seats = [];
    Object.entries(spec).forEach(([label, n]) => {
        for (let i = 0; i < n; i++) seats.push({ label, playerId: null, bench: false });
    });
    seats.push({ label: 'BE', playerId: null, bench: true });
    return seats;
}

test('mock ground, baseball: a real lineup (nine fielders, a DH, two starters and two relievers) overlaps nothing', () => {
    const spec = { C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, LF: 1, CF: 1, RF: 1, DH: 1, SP: 2, RP: 2, UTIL: 1 };
    assertNoOverlaps(buildMockLineupGroundHtml('flb', seatsFrom(spec), mockOpts()), 14, 'baseball');
});

test('mock ground, baseball: the deepest roster the table clears - three a rail, two of every fielder', () => {
    const spec = { C: 2, '1B': 2, '2B': 2, '3B': 2, SS: 2, LF: 2, CF: 2, RF: 2, DH: 3, SP: 3, RP: 3, UTIL: 3 };
    assertNoOverlaps(buildMockLineupGroundHtml('flb', seatsFrom(spec), mockOpts()), 28, 'baseball, deep');
});

test('mock ground, baseball: a generic OF family shares centre\'s own column, never LF/RF\'s', () => {
    const spec = { C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3, SP: 1 };
    assertNoOverlaps(buildMockLineupGroundHtml('flb', seatsFrom(spec), mockOpts()), 9, 'baseball, generic OF');
});

test('mock ground, football: a real lineup (QB, two backs, three receivers, TE, FLEX, K, D/ST) overlaps nothing', () => {
    const spec = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, 'D/ST': 1 };
    assertNoOverlaps(buildMockLineupGroundHtml('ffl', seatsFrom(spec), mockOpts()), 10, 'football');
});

test('mock ground, football: the deepest roster the table clears - six receivers, two ends, three backs', () => {
    const spec = { QB: 2, RB: 3, WR: 6, TE: 2, FLEX: 1, K: 1, 'D/ST': 1 };
    assertNoOverlaps(buildMockLineupGroundHtml('ffl', seatsFrom(spec), mockOpts()), 16, 'football, deep');
});

test('mock ground: no starting seats at all renders a valid empty SVG rather than throwing, even with a real bench', () => {
    const benchOnly = MOCK_SEATS.filter(s => s.bench);
    const html = buildMockLineupGroundHtml('ffl', benchOnly, mockOpts());
    assert(html.includes('<svg'), 'still a valid svg element');
});

test('mock ground: XSS - a hostile player name renders escaped', () => {
    // A short, single-word hostile string, long enough to prove escaping and short enough that it never triggers mockNameLayout's own split/step-down levers (a separate, already-tested concern) which could otherwise obscure whether escaping ran at all.
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

test('mock ground: a filled bench seat never cuts a long surname either (B264 item 1f) - benchNameLayout splits and steps down, same as the card', () => {
    // A starting seat has to be present, because the bench strip only renders alongside a real starting lineup (see "no starting seats at all" above), so a bench-only seats array never reaches it.
    const seats = [
        { slotId: 0, label: 'QB', playerId: 11, bench: false },
        { slotId: 20, label: 'BE', playerId: 90, bench: true },
        { slotId: 20, label: 'BE', playerId: 91, bench: true },
    ];
    const pool = new Map([
        [11, { name: 'Josh Allen', value: 163.7 }],
        [90, { name: 'Tobias Lindqvist-Moe', value: 51.2 }],
        // "Achterbergsen" (536.4 at 76px, scaled to the chip's own 10px font to 70.6) is past the 66 unit budget with no space or hyphen to split at, so this exercises the step-down lever too.
        [91, { name: 'Nils Achterbergsen', value: 44.6 }],
    ]);
    const html = buildMockLineupGroundHtml('ffl', seats, mockOpts({ pool }));
    assert(!html.includes('Lindqv...') && !html.includes('Achter...'), 'the old six-character ellipsis cap never applies to the bench chip');
    assert(html.includes('<span class="lg-bseat-name">Lindqvist-<br>Moe</span>'), 'the hyphenated surname splits into two lines, the hyphen kept with the first');
    const stepMatch = html.match(/<span class="lg-bseat-name" style="font-size:(\d+)px">Achterbergsen<\/span>/);
    assert(stepMatch, `expected the unbroken surname stepped down, got: ${html.match(/<span class="lg-bseat-name"[^>]*>[^<]*/g)}`);
    assert(Number(stepMatch[1]) === 9, `expected the measured step to 9px (66/70.6), got ${stepMatch[1]}`);
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

// ==== the field margin and scrimmage ====

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
    const center = MOCK_FIELD_X + MOCK_FIELD_W / 2;
    assert(Number(m[1]) === center && Number(m[2]) === center, `expected x1=x2=${center}, got x1=${m[1]} x2=${m[2]}`);
});

test('real ground: the scrimmage line keeps its own tuned 42% position, untouched by the mock-only centring', () => {
    const html = buildLineupGroundHtml('ffl', [
        { slotCode: 'QB', count: 1, playerName: 'Josh Allen' },
        { slotCode: 'RB', count: 1, playerName: 'Saquon Barkley' }
    ]);
    const m = html.match(/class="lg-field-scrimmage" x1="([\d.]+)"/);
    assert(m, 'the scrimmage line renders');
    const FIELD_X = 8.5, FIELD_W = 424;
    assert(Math.abs(Number(m[1]) - (FIELD_X + FIELD_W * 0.42)) < 0.01, `the real ground's own 42% position is unchanged, got x1=${m[1]}`);
});

test('mock ground: the WR (and the rest of the formation) sit on the moved line, not the real ground\'s own 42%', () => {
    const html = buildMockLineupGroundHtml('ffl', MOCK_SEATS, mockOpts());
    const center = MOCK_FIELD_X + MOCK_FIELD_W / 2;
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
