// THE LINEUP GROUND. Pure sport-tailored SVG diagram of a starting lineup: a hockey rink, a baseball park, or a football formation, with the league's own roster seats drawn onto it. See tests/fixtures/lineup-ground.md for the frozen contract this module renders - the data lane builds the slot-seat list to that shape; this module only turns it into markup. PURITY CONTRACT, same as rank-engine.js, seasons-band.js and leaderboard-row.js: no imports, no AppState, no DOM, no fetch. escapeHtml arrives via opts for the same reason it does in those modules - utils.js imports state.js (AppState), which would make this module impure.
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function resolveOpts(opts) {
    const o = opts || {};
    return { escapeHtml: o.escapeHtml || escapeHtmlLocal };
}

// ==== THE SEAT PRIMITIVE - one roster slot, drawn the same way on every ground: a small box with the slot code on top and, when there is one, a second line underneath (a player's name post-draft, or a muted "x N" repeat note pre-draft - never both, see groupIntoSeats below). ====
const SEAT_W = 34;
const SEAT_H = 24;

function seatSvg(x, y, code, sub, subMuted, opts, dashed) {
    const cls = dashed ? 'lg-seat lg-seat-dashed' : 'lg-seat';
    const codeY = sub ? y - 3 : y + 4;
    const subHtml = sub
        ? `<text class="${subMuted ? 'lg-seat-sub lg-seat-sub-muted' : 'lg-seat-sub'}" x="${x}" y="${y + 9}" text-anchor="middle">${opts.escapeHtml(sub)}</text>`
        : '';
    return `<g class="${cls}">
        <rect class="lg-seat-box" x="${x - SEAT_W / 2}" y="${y - SEAT_H / 2}" width="${SEAT_W}" height="${SEAT_H}" rx="4"></rect>
        <text class="lg-seat-code" x="${x}" y="${codeY}" text-anchor="middle">${opts.escapeHtml(code)}</text>
        ${subHtml}
    </g>`;
}

// A neutral, off-ground seat for a slot code the sport's own placement table does not know - drawn exactly like an aside seat (dashed), never guessed onto the ground itself. Same primitive, no special styling of its own, because "we do not know where this goes" and "this deliberately does not go on the ground" (UTIL, DH, the pitching staff) are the same visual statement: dashed, aside.
function neutralSeatSvg(x, y, code, sub, opts) {
    return seatSvg(x, y, code, sub, false, opts, true);
}

// ==== GROUPING - the frozen slotSeats contract in, one expanded seat instance per starter out. See tests/fixtures/lineup-ground.md for the exact rule: entries with the same slotCode are one family, in the order given; a named entry (playerName set) always contributes exactly one seat; an anonymous entry (playerName null) contributes `count` identical anonymous seats. Pre-draft, every entry in a league's slotSeats is anonymous by construction (nobody is drafted yet) - the "carries a count" case IS the pre-draft case, not a separate mode this function has to detect. ====
function groupIntoSeats(slotSeats) {
    const order = [];
    const byCode = new Map();
    (slotSeats || []).forEach(entry => {
        const code = String(entry.slotCode);
        if (!byCode.has(code)) { byCode.set(code, []); order.push(code); }
        const n = entry.playerName ? 1 : Math.max(1, Number(entry.count) || 1);
        for (let i = 0; i < n; i++) byCode.get(code).push(entry.playerName || null);
    });
    return order.map(code => ({ code, names: byCode.get(code) }));
}

// ==== SPREAD HELPERS - turn "N seats need a home in this zone" into N (x, y) points. Shared across sports rather than three copies, since "a row that grows outward from a centre" and "rows that pair up with an odd one left over" are the same two shapes every ground needs. ====

// N points on one horizontal row, evenly spaced around centerX.
function rowPoints(centerX, y, count, spacing) {
    const pts = [];
    const start = centerX - (spacing * (count - 1)) / 2;
    for (let i = 0; i < count; i++) pts.push({ x: start + i * spacing, y });
    return pts;
}

// N points in one vertical column, evenly spaced around centerY - rowPoints turned 90 degrees, for a group that stacks front-to-back (football's backfield) rather than side-to-side.
function columnPoints(x, centerY, count, spacing) {
    const pts = [];
    const start = centerY - (spacing * (count - 1)) / 2;
    for (let i = 0; i < count; i++) pts.push({ x, y: start + i * spacing });
    return pts;
}

// Pairs stacked outward from startY toward the ground's centre (hockey's "D as pairs plus odd player") - two seats a row, an unpaired last seat centred alone.
function pairRows(centerX, startY, rowStep, colSpacing, count) {
    const pts = [];
    let remaining = count;
    let row = 0;
    while (remaining > 0) {
        const y = startY - row * rowStep;
        if (remaining >= 2) {
            pts.push({ x: centerX - colSpacing / 2, y });
            pts.push({ x: centerX + colSpacing / 2, y });
            remaining -= 2;
        } else {
            pts.push({ x: centerX, y });
            remaining -= 1;
        }
        row++;
    }
    return pts;
}

// N points spread along an arc (baseball's outfield, football has no arc use today) between startDeg and endDeg (0 = straight up), at radius r from (cx, cy).
function arcPoints(cx, cy, r, startDeg, endDeg, count) {
    const pts = [];
    for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const deg = startDeg + (endDeg - startDeg) * t;
        const rad = (deg * Math.PI) / 180;
        pts.push({ x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) });
    }
    return pts;
}

// ==== HOCKEY - a true rink, 85:200 (width:height), drawn vertical. Corner radius 28/85 of the width, validated against the NHL's own published rink diagram ratio. This team defends the bottom of the sheet - the crease, the goal line nearest it, and the defensive-zone faceoff circles all sit low; the attacking zone is at the top. ====
const RINK_W = 85;
const RINK_H = 200;
const RINK_X = 15; // left inset inside the wider canvas, leaving room for the UTIL strip
const RINK_Y = 8;
const RINK_R = (28 / 85) * RINK_W; // 28, restated as a ratio so a width change keeps it correct
const RINK_CANVAS_W = RINK_X + RINK_W + 40;
const RINK_CANVAS_H = RINK_Y * 2 + RINK_H;

function rinkX(u) { return RINK_X + u; } // u in rink-local units, 0..85
function rinkY(v) { return RINK_Y + v; } // v in rink-local units, 0..200

function hockeyGroundSvg() {
    const blueTop = rinkY(75), blueBottom = rinkY(125), redY = rinkY(100);
    const goalTop = rinkY(11), goalBottom = rinkY(189);
    const faceoffs = [
        { x: rinkX(RINK_W * 0.26), y: rinkY(31) }, { x: rinkX(RINK_W * 0.74), y: rinkY(31) },
        { x: rinkX(RINK_W * 0.26), y: rinkY(169) }, { x: rinkX(RINK_W * 0.74), y: rinkY(169) },
    ];
    const faceoffCircles = faceoffs.map(p => `<circle class="lg-rink-circle" cx="${p.x}" cy="${p.y}" r="22"></circle>`).join('');
    const faceoffDots = faceoffs.map(p => `<circle class="lg-rink-dot" cx="${p.x}" cy="${p.y}" r="3"></circle>`).join('');
    return `
        <rect class="lg-rink-ice" x="${RINK_X}" y="${RINK_Y}" width="${RINK_W}" height="${RINK_H}" rx="${RINK_R}"></rect>
        <line class="lg-rink-blue" x1="${RINK_X}" y1="${blueTop}" x2="${RINK_X + RINK_W}" y2="${blueTop}"></line>
        <line class="lg-rink-blue" x1="${RINK_X}" y1="${blueBottom}" x2="${RINK_X + RINK_W}" y2="${blueBottom}"></line>
        <line class="lg-rink-red" x1="${RINK_X}" y1="${redY}" x2="${RINK_X + RINK_W}" y2="${redY}"></line>
        <line class="lg-rink-goal" x1="${RINK_X + 6}" y1="${goalTop}" x2="${RINK_X + RINK_W - 6}" y2="${goalTop}"></line>
        <line class="lg-rink-goal" x1="${RINK_X + 6}" y1="${goalBottom}" x2="${RINK_X + RINK_W - 6}" y2="${goalBottom}"></line>
        ${faceoffCircles}
        <circle class="lg-rink-circle" cx="${rinkX(RINK_W / 2)}" cy="${redY}" r="22"></circle>
        ${faceoffDots}
        <circle class="lg-rink-dot" cx="${rinkX(RINK_W / 2)}" cy="${redY}" r="3"></circle>
        <path class="lg-rink-crease" d="M ${rinkX(RINK_W / 2) - 11} ${goalBottom} A 11 11 0 0 0 ${rinkX(RINK_W / 2) + 11} ${goalBottom} Z"></path>`;
}

// Where each hockey slot family's seats go. Returns null for a code this ground does not place - the caller falls that code back to the neutral aside seat.
function hockeySeatPoints(code, count) {
    const cx = rinkX(RINK_W / 2);
    switch (code) {
        case 'G':
            return rowPoints(cx, rinkY(178), count, 34);
        // A SEAT IS 24 TALL, so a row step under that puts one box on top of the next. Four defencemen make two rows, and at the old spacing the second row sat 18 below the centres and overlapped them by six. The band between the goal and centre ice is only about 54 units wide, so the rows are stepped to fit inside it rather than widened until they do not: centres move a few units up the ice, still behind the wingers, and the pairs step 28.
        case 'D':
            return pairRows(cx, rinkY(152), 28, 40, count);
        case 'C':
            return rowPoints(cx, rinkY(92), count, 34);
        case 'LW':
            return rowPoints(rinkX(RINK_W * 0.26), rinkY(45), count, 34);
        case 'RW':
            return rowPoints(rinkX(RINK_W * 0.74), rinkY(45), count, 34);
        case 'F':
            return rowPoints(cx, rinkY(45), count, 34);
        default:
            return null;
    }
}

// UTIL is deliberately off the ice, not merely unplaceable - it renders exactly like an unplaceable code (dashed, aside), which is the same visual statement for a different reason (see neutralSeatSvg's own comment).
const HOCKEY_ASIDE_CODES = new Set(['UTIL']);

// ==== BASEBALL - the park: foul lines from the plate, an outfield fence arc, a dirt infield arc, the grass diamond, the mound, and the bases. UTIL/DH and the pitching staff (SP/RP) are listed in a strip beside the park rather than crammed onto it - none of them has one true spot on the field. ====
const PARK_CX = 130;
const PARK_HOME_Y = 210;
const PARK_R_OUT = 175; // outfield fence radius from home
const PARK_R_DIRT = 95; // infield dirt arc radius from home
const PARK_BAG_R = 62; // distance from home to each base along the diamond
const PARK_CANVAS_W = 300;
// The PITCH's own canvas, not the drawing's bounds: the catcher's seat reaches y=238 and other lineups push the aside column further still, and viewBoxFor grows the box to hold whatever is actually drawn. Raising this number instead would be a second mechanism for the same job, and the one that cannot keep up - it is fixed while the seats move with the league's roster shape.
const PARK_CANVAS_H = 230;

function baseballGroundSvg() {
    // Foul lines run from home at +/-45 degrees off vertical, matching the diamond's own corners.
    const flX1 = PARK_CX - PARK_R_OUT * Math.SQRT1_2, flY1 = PARK_HOME_Y - PARK_R_OUT * Math.SQRT1_2;
    const flX2 = PARK_CX + PARK_R_OUT * Math.SQRT1_2, flY2 = PARK_HOME_Y - PARK_R_OUT * Math.SQRT1_2;
    const first = { x: PARK_CX + PARK_BAG_R, y: PARK_HOME_Y - PARK_BAG_R };
    const second = { x: PARK_CX, y: PARK_HOME_Y - PARK_BAG_R * 2 };
    const third = { x: PARK_CX - PARK_BAG_R, y: PARK_HOME_Y - PARK_BAG_R };
    return `
        <path class="lg-park-outfield" d="M ${flX1} ${flY1} A ${PARK_R_OUT} ${PARK_R_OUT} 0 0 1 ${flX2} ${flY2} L ${PARK_CX} ${PARK_HOME_Y} Z"></path>
        <path class="lg-park-dirt" d="M ${PARK_CX - PARK_R_DIRT} ${PARK_HOME_Y} A ${PARK_R_DIRT} ${PARK_R_DIRT} 0 0 1 ${PARK_CX + PARK_R_DIRT} ${PARK_HOME_Y} Z"></path>
        <polygon class="lg-park-diamond" points="${PARK_CX},${PARK_HOME_Y} ${first.x},${first.y} ${second.x},${second.y} ${third.x},${third.y}"></polygon>
        <line class="lg-park-foul" x1="${PARK_CX}" y1="${PARK_HOME_Y}" x2="${flX1}" y2="${flY1}"></line>
        <line class="lg-park-foul" x1="${PARK_CX}" y1="${PARK_HOME_Y}" x2="${flX2}" y2="${flY2}"></line>
        <circle class="lg-park-mound" cx="${PARK_CX}" cy="${PARK_HOME_Y - PARK_BAG_R}" r="7"></circle>
        <rect class="lg-park-base" x="${first.x - 5}" y="${first.y - 5}" width="10" height="10" transform="rotate(45 ${first.x} ${first.y})"></rect>
        <rect class="lg-park-base" x="${second.x - 5}" y="${second.y - 5}" width="10" height="10" transform="rotate(45 ${second.x} ${second.y})"></rect>
        <rect class="lg-park-base" x="${third.x - 5}" y="${third.y - 5}" width="10" height="10" transform="rotate(45 ${third.x} ${third.y})"></rect>
        <rect class="lg-park-home" x="${PARK_CX - 6}" y="${PARK_HOME_Y - 6}" width="12" height="12"></rect>`;
}

function baseballSeatPoints(code, count) {
    switch (code) {
        case 'C':
            return rowPoints(PARK_CX, PARK_HOME_Y + 16, count, 34);
        case '1B':
            return rowPoints(PARK_CX + PARK_BAG_R + 20, PARK_HOME_Y - PARK_BAG_R, count, 34);
        // -40, not -20: found in passing fixing item 1's test-key bug (below), which finally let this suite exercise real on-field coordinates for baseball and found a real overlap the vacuous version could not - 2B's old spot (y 66) sat only 7px from a plain OF/CF seat's own dead-centre arc point (y 73, PARK_HOME_Y - the arc's own radius), 17px short of the 24px (SEAT_H) two boxes need to clear each other. -40 gives 2B a 27px margin from that same point, comfortably clear, and does not move any other seat.
        case '2B':
            return rowPoints(PARK_CX, PARK_HOME_Y - PARK_BAG_R * 2 - 40, count, 34);
        case '3B':
            return rowPoints(PARK_CX - PARK_BAG_R - 20, PARK_HOME_Y - PARK_BAG_R, count, 34);
        case 'SS':
            return rowPoints(PARK_CX - 38, PARK_HOME_Y - PARK_BAG_R - 30, count, 34);
        case 'P':
            return rowPoints(PARK_CX, PARK_HOME_Y - PARK_BAG_R, count, 34);
        // LF/CF/RF take their named spot on the arc; a plain OF slot fills the arc generally - both read as "the outfield", the only distinction is whether the league's own catalog happened to name a side.
        case 'LF':
            return arcPoints(PARK_CX, PARK_HOME_Y, PARK_R_DIRT + 42, -55, -55, count);
        case 'CF':
            return arcPoints(PARK_CX, PARK_HOME_Y, PARK_R_DIRT + 42, 0, 0, count);
        case 'RF':
            return arcPoints(PARK_CX, PARK_HOME_Y, PARK_R_DIRT + 42, 55, 55, count);
        case 'OF':
            return arcPoints(PARK_CX, PARK_HOME_Y, PARK_R_DIRT + 42, -50, 50, count);
        default:
            return null;
    }
}

const BASEBALL_ASIDE_CODES = new Set(['UTIL', 'DH', 'SP', 'RP']);

// ==== FOOTBALL - the formation. Offence lines up entirely LEFT of the scrimmage line. RECEIVERS BELONG NEAREST THE SIDELINES (the owner's own complaint against the S2b shape, which put the bottom WR, FLEX and TE all on one row - a receiver stacked no closer to the boundary than the tight end beside it): WR now sits directly ON the line at each sideline in turn (top first, then bottom), as close to the true edge as a seat can get and still clear the turf's own boundary. TE is ALSO on the line, at the bottom edge like the bottom WR - but set back from the true sideline toward the middle of the field, tight to the line the way a real tight end lines up beside the tackle rather than split as wide as a receiver. FLEX sits in the SLOT: off the line (behind it, not on it) and between the bottom WR's depth and the TE's, the receiver spot that is neither split to the sideline nor tight to the formation. QB is centred a short depth behind the line, the formation's own anchor. RB is stacked BEHIND the QB in a column (not spread wide, so a repeat "x2" reads as one family, not extra bodies). K IS DEEPEST BEHIND THE QB (the owner's other complaint - the kicker used to sit out on the defence's own side of the field, nowhere near the QB) - same file as QB/RB, one step further back than RB, the deepest seat the line of scrimmage's own 42%-of-field depth budget allows while still clearing both the turf's left edge and RB's own seat (measured: 132px of room behind the line at this SCRIMMAGE_X, only enough for QB/RB/K's three columns at a bare 34px+ apart - tight, but every seat and gap here is a real, checked number, not an assumption). D/ST is one unit seat across the line, on the defence's own side, unchanged from S2b - the owner's words never named a complaint against it. ====
const FIELD_W = 300;
const FIELD_H = 170;
const FIELD_X = 6;
const FIELD_Y = 6;
const SCRIMMAGE_X = FIELD_X + FIELD_W * 0.42;

function footballGroundSvg() {
    return `
        <rect class="lg-field-turf" x="${FIELD_X}" y="${FIELD_Y}" width="${FIELD_W}" height="${FIELD_H}"></rect>
        <line class="lg-field-scrimmage" x1="${SCRIMMAGE_X}" y1="${FIELD_Y}" x2="${SCRIMMAGE_X}" y2="${FIELD_Y + FIELD_H}"></line>`;
}

// R1/S47b: "the line of scrimmage is at the field's horizontal centre" - frame H's own request for the MOCK ground alone. SCRIMMAGE_X (42% across) stays exactly where the REAL ground's formation was tuned against - every seat's own (x, y) reads relative to it, and moving the shared constant would re-derive an already-tested layout nobody asked to touch. This redraws only the DECORATIVE line's own x position, string-level, for the mock rendering.
function centeredScrimmageSvg(sport, svg) {
    if (sport !== 'ffl') return svg;
    const center = FIELD_X + FIELD_W / 2;
    return svg
        .replace(/(class="lg-field-scrimmage" x1=")[\d.]+(")/, `$1${center}$2`)
        .replace(/(class="lg-field-scrimmage"[^>]*x2=")[\d.]+(")/, `$1${center}$2`);
}

// Companion to centeredScrimmageSvg: the owner's own follow-up ("the two WR seats" - and by the same formation, TE/FLEX/QB/RB/K/D-ST - "want to sit on the line's x", not the old 42% one the decorative stroke left behind). Every football seat's (x, y) reads relative to SCRIMMAGE_X, so translating the whole family by the SAME delta the line moved keeps every seat's tuned distance FROM the line exactly as measured - only the family's position ON the field changes, never its shape. Mock-only, same reasoning as the line itself: SCRIMMAGE_X is untouched for the real ground.
const FFL_MOCK_LINE_DX = (FIELD_X + FIELD_W / 2) - SCRIMMAGE_X;
function mockShiftPoints(sport, points) {
    if (sport !== 'ffl' || !points) return points;
    return points.map(p => ({ ...p, x: p.x + FFL_MOCK_LINE_DX }));
}

// ON THE LINE (x = SCRIMMAGE_X - 17, the seat's own half-width short of the line itself, so the box's own right edge touches scrimmage without crossing it), alternating the top sideline (even index) and the bottom (odd index) - each as close to its own boundary as SEAT_H/2 plus a 2px margin allows. A third or later WR on the same side steps another SEAT_W further along that same sideline (toward the middle of the field) rather than stacking on the one already there or drifting off the line into the backfield.
const WR_LINE_X = SCRIMMAGE_X - 17;
function footballWrPoints(count) {
    const topY = FIELD_Y + 14;
    const bottomY = FIELD_Y + FIELD_H - 14;
    const pts = [];
    let topSeen = 0, bottomSeen = 0;
    for (let i = 0; i < count; i++) {
        if (i % 2 === 0) { pts.push({ x: WR_LINE_X, y: topY + topSeen * SEAT_W }); topSeen++; }
        else { pts.push({ x: WR_LINE_X, y: bottomY - bottomSeen * SEAT_W }); bottomSeen++; }
    }
    return pts;
}

function footballSeatPoints(code, count) {
    const midY = FIELD_Y + FIELD_H / 2;
    switch (code) {
        // A short depth behind the line, centred - the formation's own anchor point.
        case 'QB':
            return rowPoints(SCRIMMAGE_X - 32, midY, count, 30);
        // Stacked BEHIND the QB (further from scrimmage, not spread beside it) - a vertical column, so two RBs read as one family one behind the other, the way a real backfield does, rather than as a wide row that could be mistaken for more bodies than the roster carries.
        case 'RB':
            return columnPoints(SCRIMMAGE_X - 72, midY, count, 30);
        case 'WR':
            return footballWrPoints(count);
        // On the line, at the bottom edge like the bottom WR - but set back toward the middle of the field (a 34px step off the true sideline, clearing the WR seat there by a full SEAT_H of margin) rather than split as wide as a receiver, the real difference between the two.
        case 'TE':
            return rowPoints(WR_LINE_X, FIELD_Y + FIELD_H - 14 - SEAT_W, count, 34);
        // THE SLOT: off the line (set back toward the QB, clearing WR/TE's own on-the-line column by more than a seat width so neither adjacency needs the two seats' Y values to also clear) and between the bottom WR's depth and the TE's - the receiver spot that is neither split to the sideline nor tight to the formation.
        case 'FLEX':
            return rowPoints(WR_LINE_X - 38, FIELD_Y + FIELD_H - 14 - SEAT_W / 2, count, 38);
        // Centred RIGHT of the line - one unit seat, never spread (a fantasy roster carries a team defense as a single slot, same note as the ground primitive above).
        case 'D/ST':
            return rowPoints(SCRIMMAGE_X + 50, midY, count, 34);
        // DEEPEST BEHIND THE QB (R3): the same file as QB/RB, one step further from the line than RB - the deepest an offensive seat can sit at this SCRIMMAGE_X and still clear the turf's own left edge, measured rather than assumed (SCRIMMAGE_X - 108 leaves the seat's own half-width, 17px, of margin inside FIELD_X, and 36px - more than a SEAT_W - behind RB).
        case 'K':
            return rowPoints(SCRIMMAGE_X - 108, midY, count, 30);
        default:
            return null;
    }
}

const FOOTBALL_ASIDE_CODES = new Set();

// ==== PER-SPORT REGISTRY ====
const SPORTS = {
    fhl: {
        canvasW: RINK_CANVAS_W, canvasH: RINK_CANVAS_H,
        groundSvg: hockeyGroundSvg, seatPoints: hockeySeatPoints, asideCodes: HOCKEY_ASIDE_CODES,
        asideX: RINK_X + RINK_W + 22, asideTop: RINK_Y + 20, asideStep: 30,
    },
    flb: {
        canvasW: PARK_CANVAS_W, canvasH: PARK_CANVAS_H,
        groundSvg: baseballGroundSvg, seatPoints: baseballSeatPoints, asideCodes: BASEBALL_ASIDE_CODES,
        asideX: PARK_CX + PARK_R_OUT * Math.SQRT1_2 + 8, asideTop: 30, asideStep: 26,
    },
    ffl: {
        canvasW: FIELD_W + 12, canvasH: FIELD_H + 12,
        groundSvg: footballGroundSvg, seatPoints: footballSeatPoints, asideCodes: FOOTBALL_ASIDE_CODES,
        // asideStep must clear SEAT_H (24) or the strip's own seats overlap each other; it was 20, so a football bench of two stacked boxes was drawn four pixels into the one above it.
        asideX: FIELD_X + 8, asideTop: FIELD_Y + FIELD_H + 26, asideStep: 28,
    },
};

// Bench/IR strip codes are sport-agnostic in shape (always "the slots this league marked non-starting"), so the caller marks them the same way regardless of sport: any entry whose slotCode is 'BE', 'IL' or 'IR' renders in the muted strip below the ground rather than on it or beside it, matching the league's own NON_STARTING_SLOTS split (state.js) the data lane reads.
const BENCH_STRIP_CODES = new Set(['BE', 'IL', 'IR']);

// A seat box is ~34 units wide, nowhere near room for a full name at legible size - real lineup cards solve this the same way, showing the surname alone. `Lindqvist-Moe` (13 chars) still clears most boxes; anything longer is hard-capped with an ASCII ellipsis (never the single-glyph "..." unicode form - see docs/CONVENTIONS.md's published-text rules, which this codebase applies to every user-facing string, not only published ones).
function shortName(name) {
    const str = String(name).trim();
    const last = str.split(/\s+/).pop() || str;
    // The truncated form (6 letters + "...") is deliberately the same total length as the untruncated ceiling (9) - both are sized to what the seat box can hold, measured at the seat's own font size, not an arbitrary round number.
    return last.length <= 9 ? last : `${last.slice(0, 6)}...`;
}

// A named seat shows its player - the SVG paths get the space-constrained surname via shortName, the bench strip's flowing text does not need it and keeps the full name - and an anonymous one shows nothing. Used for the ground and the aside strip, where an anonymous family draws N separately-POSITIONED seats: the count is already legible as N boxes, so nothing here also carries a repeat note the way seatSubLabel below does for the bench strip's own, different idiom.
function namedSeatLabel(fam, i, forSvg) {
    const name = fam.names[i];
    return name ? (forSvg ? shortName(name) : name) : null;
}

// The bench strip's OWN idiom (benchStripHtml below): one chip stands for several identical anonymous seats, so THAT chip is the one place a repeat note belongs - "x N" on the family's first (only) chip, never on a second chip beside it (there is no second chip; benchStripHtml skips every anonymous seat past the first for exactly this reason).
function seatSubLabel(fam, i, forSvg) {
    const name = fam.names[i];
    if (name) return forSvg ? shortName(name) : name;
    return i === 0 && fam.names.length > 1 ? `x${fam.names.length}` : null;
}

// One family's seats placed on the ground, at the points its sport's own placement table gave it.
function familyGroundHtml(points, fam, opts) {
    return points.map((p, i) => seatSvg(p.x, p.y, fam.code, namedSeatLabel(fam, i, true), !fam.names[i], opts, false)).join('');
}

// One aside-strip row per seat: a seat drawn at a fixed (x, y) rather than placed on the ground, used for both the sport's own named aside families (UTIL, DH, SP/RP) and any code the ground's placement table does not recognize at all.
function asideStripHtml(sportDef, families, opts, asideX) {
    const x = Number.isFinite(asideX) ? asideX : sportDef.asideX;
    let y = sportDef.asideTop;
    const parts = [];
    families.forEach(fam => {
        fam.names.forEach((_, i) => {
            parts.push(neutralSeatSvg(x, y, fam.code, namedSeatLabel(fam, i, true), opts));
            y += sportDef.asideStep;
        });
    });
    return parts.join('');
}

// The muted bench/IR strip beneath the whole ground - one chip per named seat, and one chip per anonymous family (carrying its own repeat note when it has more than one seat) rather than one blank chip per anonymous seat - a bench slot has no ground position to draw in the first place, so there is no seat shape to fall back on the way an on-ground family's later seats do.
function benchStripHtml(families, opts) {
    if (!families.length) return '';
    const chips = [];
    families.forEach(fam => {
        fam.names.forEach((name, i) => {
            if (!name && i > 0) return; // already counted in seat 0's repeat note
            const sub = seatSubLabel(fam, i);
            chips.push(`<span class="lg-bench-chip">${opts.escapeHtml(`${fam.code}${sub ? ' ' + sub : ''}`)}</span>`);
        });
    });
    return `<div class="lg-bench-strip">${chips.join('')}</div>`;
}

// The starting-lineup ground for one sport. slotSeats is the frozen contract shape (see tests/fixtures/lineup-ground.md): [{slotCode, count, playerName}]. A sport this registry does not know renders an empty, valid SVG rather than throwing - the caller decides whether that is reachable (today it is not: every AppState sport is fhl/flb/ffl). THE VIEWBOX CONTAINS WHAT IS ACTUALLY DRAWN, rather than trusting a constant to have kept up with the seats. A canvas is chosen once for a sport's pitch; the seats around it move with the league's own roster shape, and a lineup with a deeper bench pushes the aside column further down than whoever picked the number could see. Three seats were being clipped by their own viewBox when this was written - a catcher eight pixels below a baseball canvas, the bottom of a five-deep aside column, and a football seat three pixels left of the field - and every one of them was invisible while the diagram was drawn small. So the box is measured off the emitted seat rectangles and grown to hold them, never shrunk: the sport's own canvas stays the floor, so a lineup that fits changes nothing and the pitch keeps the proportions it was drawn with. Where the aside column can stand without touching a field seat. Only the seats to its own side matter, so this takes the furthest right edge of anything drawn on the ground and steps clear of it - and never moves the column LEFT of where the sport put it, so a lineup that already fits is drawn exactly as it was.
function clearOfGroundSeats(def, onGround) {
    let maxRight = -Infinity;
    onGround.forEach(g => (g.points || []).forEach(pt => {
        if (pt && Number.isFinite(pt.x)) maxRight = Math.max(maxRight, pt.x + SEAT_W / 2);
    }));
    if (!Number.isFinite(maxRight)) return def.asideX;
    const GAP = 10;
    return Math.max(def.asideX, maxRight + GAP + SEAT_W / 2);
}

function viewBoxFor(def, seatsHtml) {
    let minX = 0, minY = 0, maxX = def.canvasW, maxY = def.canvasH;
    const re = /<rect class="lg-seat-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    let m;
    while ((m = re.exec(seatsHtml)) !== null) {
        const x = Number(m[1]), y = Number(m[2]), w = Number(m[3]), h = Number(m[4]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        // A seat's own label sits inside its box, so the box is the whole of its extent. PAD is the stroke's outer half plus a hair, so a border is not shaved by the edge it sits against.
        const PAD = 2;
        minX = Math.min(minX, x - PAD);
        minY = Math.min(minY, y - PAD);
        maxX = Math.max(maxX, x + w + PAD);
        maxY = Math.max(maxY, y + h + PAD);
    }
    return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

export function buildLineupGroundHtml(sport, slotSeats, opts) {
    const o = resolveOpts(opts);
    const def = SPORTS[sport];
    if (!def) return '<svg viewBox="0 0 1 1" class="lg-ground"></svg>';

    const families = groupIntoSeats(slotSeats);
    const onGround = [];
    const aside = [];
    const bench = [];
    families.forEach(fam => {
        if (BENCH_STRIP_CODES.has(fam.code)) { bench.push(fam); return; }
        if (def.asideCodes.has(fam.code)) { aside.push(fam); return; }
        const points = def.seatPoints(fam.code, fam.names.length);
        if (!points) { aside.push(fam); return; }
        onGround.push({ points, fam });
    });

    const groundSeatsHtml = onGround.map(g => familyGroundHtml(g.points, g.fam, o)).join('');
    // THE BENCH COLUMN CLEARS THE FIELD, measured rather than assumed. Its x was a constant chosen against the pitch, and the seats it has to miss are placed on an ARC whose reach depends on how many the league starts - so a league with three outfielders pushed one of them under the dashed column and the two boxes overlapped. The column now starts to the right of whatever the field actually put there, and the viewBox above grows to hold the result.
    const asideX = clearOfGroundSeats(def, onGround);
    const asideHtml = asideStripHtml(def, aside, o, asideX);
    const svg = `<svg class="lg-ground" viewBox="${viewBoxFor(def, groundSeatsHtml + asideHtml)}" xmlns="http://www.w3.org/2000/svg">
        ${def.groundSvg()}
        ${groundSeatsHtml}
        ${asideHtml}
    </svg>`;
    return `<div class="lg-ground-wrap">${svg}${benchStripHtml(bench, o)}</div>`;
}

// ==== THE MOCK GROUND. Reuses the sport's own pitch and seat-PLACEMENT (SPORTS[sport], def.seatPoints) so the mock ground is the exact same diagram buildLineupGroundHtml already draws - only the SEAT shape differs, because mock-lineup.js's own state.seats is already one entry per seat (never grouped by count, see the contract), so each seat needs to carry its own global index for a click to address it, and a filled/targeted/empty seat all read differently. Kept as a SEPARATE function rather than a mode flag threaded through groupIntoSeats/ familyGroundHtml/asideStripHtml (the ordinary, frozen path everything else calls) - those three exist for the count-grouped {slotCode,count,playerName} shape and nothing here changes what they do or how the 23 tests already pinned to them read. THE SEAT BOX GEOMETRY STAYS THE GROUND'S OWN SIZE (SEAT_W/SEAT_H) AND EVERY SEAT'S OWN (x, y) - S39b's own overrule kept the READING at frame E's level without touching either. Growing the box (and so the seatPoints spacing every sport's formation was tuned against) was the S39 deviation the owner rejected; the fix that survives review is smaller text INSIDE the same box, at the same centres, plus the CARD'S OWN CONTAINER drawn larger (mockGroundRegionHtml/.pd-ground-mock, graphs.js/dashboard.css) - the SVG's viewBox is unchanged, so a bigger container is a bigger on-screen render of the exact same, already-proven-non-overlapping geometry, not a new layout to re-verify. Three short local-unit text lines (code, then a name, then its figure - "surname on one line, figure under it", the owner's own words) fit inside the existing 24-unit height with margin to spare; the targeted seat's full "pick a receiver" splits the same way rather than abbreviating to "<- pick" behind a tooltip. ====
function resolveMockOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        pool: o.pool || new Map(),
        targetIndex: (o.targetIndex === null || o.targetIndex === undefined) ? null : Number(o.targetIndex),
        formatValue: o.formatValue || (v => String(v)),
        // The contract's own recorded copy ("pick a receiver", not "pick a WR") - a noun, not the slot code, which this module has no sport vocabulary of its own to supply. Falls back to the bare label so a caller that never passes one still gets a real sentence.
        nounFor: o.nounFor || (label => label),
    };
}

// Same grouping rule as groupIntoSeats (same code, one family, in the order given) but keeping each entry's own GLOBAL index into `seats` - the identity seat()/unseat() address by - rather than expanding counts into anonymous names. Mock seats never carry a count; there is always exactly one entry per seat already. GROUPED BY LABEL, NOT slotId. mock-lineup.js's own seats carry both: `slotId` is LINEUP_SLOT_ORDER's raw numeric code (0 for QB, 4 for WR...), the id the league's own settings use; `label` is the display string ('QB', 'WR'...) - and every sport's own seatPoints table (hockeySeatPoints/baseballSeatPoints/footballSeatPoints, this same file) switches on THAT string, the same one groupIntoSeats' `slotCode` field has always carried for every other caller. Grouping by slotId here placed every mock seat in the aside column, matching nothing.
function groupMockSeats(seats) {
    const order = [];
    const byCode = new Map();
    (seats || []).forEach((s, i) => {
        const code = String(s.label);
        if (!byCode.has(code)) { byCode.set(code, []); order.push(code); }
        byCode.get(code).push(i);
    });
    return order.map(code => ({ code, indices: byCode.get(code) }));
}

function mockSeatHtml(point, index, seats, o) {
    const s = seats[index];
    const filled = s.playerId !== null && s.playerId !== undefined;
    const targeted = index === o.targetIndex;
    const cls = filled ? 'lg-mseat-filled' : (targeted ? 'lg-mseat-target' : 'lg-mseat-empty');
    const x = point.x, y = point.y;
    // line2/line3: the box's own second and third lines, both optional - a filled seat is the surname then its figure ("Allen" / "163.7", the owner's own "one line, the other under it"); a targeted empty seat is "pick a" then the noun ("receiver"), the same split for the same room reason; an ordinary empty seat is "empty" alone, line3 unused.
    let line2 = '', line3 = '', tooltip = '';
    if (filled) {
        // The caller's pool may key by either the raw id or its string form - tried both rather than mandating one, since the Map's own construction is the caller's business.
        const p = o.pool.get(s.playerId) || o.pool.get(String(s.playerId));
        if (p) {
            line2 = shortName(p.name);
            line3 = o.formatValue(p.value);
            tooltip = `${p.name}, ${o.formatValue(p.value)} projected. Click to remove.`;
        }
    } else if (targeted) {
        line2 = 'pick a';
        line3 = o.nounFor(s.label);
        tooltip = `Pick a ${o.nounFor(s.label)} from the Projections list.`;
    } else {
        line2 = 'empty';
    }
    const ringHtml = targeted
        ? `<rect class="lg-mseat-ring" x="${x - SEAT_W / 2 - 3}" y="${y - SEAT_H / 2 - 3}" width="${SEAT_W + 6}" height="${SEAT_H + 6}" rx="6"></rect>`
        : '';
    // The x, its own click target (data-seat-remove), separate from the seat's own data-seat-index click (which targets it, same as any empty seat) - a filled seat still needs to be re-targetable to swap its occupant without clearing it first. S39c: a bare glyph at the corner was in the DOM (data-seat-remove, the click target) but not actually SEEN against a small, busy box - a circle backing it is what makes "there is a button here" legible at a glance, the same reason a real close button is never just a character with no chip behind it. The circle is the click target too (both live inside one <g data-seat-remove>, so a click on either finds the same seat index).
    const removeX = x + SEAT_W / 2 - 4;
    const removeY = y - SEAT_H / 2 + 5;
    const removeHtml = filled
        ? `<g class="lg-mseat-remove" data-seat-remove="${index}">
            <circle cx="${removeX}" cy="${removeY}" r="4.5"></circle>
            <text x="${removeX}" y="${removeY}" text-anchor="middle" dominant-baseline="central">&#215;</text>
        </g>`
        : '';
    const tipAttr = tooltip ? ` data-tooltip="${o.escapeHtml(tooltip)}"` : '';
    return `<g class="lg-mseat ${cls}" data-seat-index="${index}"${tipAttr}>
        ${ringHtml}
        <rect class="lg-seat-box" x="${x - SEAT_W / 2}" y="${y - SEAT_H / 2}" width="${SEAT_W}" height="${SEAT_H}" rx="4"></rect>
        <text class="lg-seat-code" x="${x}" y="${y - 8}" text-anchor="middle">${o.escapeHtml(s.label)}</text>
        ${line2 ? `<text class="lg-mseat-line2" x="${x}" y="${y + 1.5}" text-anchor="middle">${o.escapeHtml(line2)}</text>` : ''}
        ${line3 ? `<text class="lg-mseat-line3" x="${x}" y="${y + 9}" text-anchor="middle">${o.escapeHtml(line3)}</text>` : ''}
        ${removeHtml}
    </g>`;
}

// R1/S47 (v2 contract, frame H): the bench is a row of REAL, interactive seat outlines under the field now, not the old read-only chip strip - "the same style dimmed, accepting a player the same way so a full mock roster can be built". Plain HTML `<div>`s, not SVG (the bench sits outside the pitch entirely in frame H's own layout), but carrying the EXACT SAME data-seat-index/data-seat-remove attributes the SVG seats use - wireMockLineup's click/drag wiring is scoped to `.pd-ground` as a whole, not to the SVG specifically, so it reaches these with no new code of its own. BE is always the bench proper; any OTHER non-starting label (IL, IR) is the injury seat - state.js's nonStartingLabels own convention, read here rather than re-guessed a second time.
function mockBenchSeatHtml(seat, index, o) {
    const filled = seat.playerId !== null && seat.playerId !== undefined;
    const targeted = index === o.targetIndex;
    const isInjury = seat.label !== 'BE';
    const cls = ['lg-bseat'];
    if (filled) cls.push('lg-bseat-filled');
    else if (targeted) cls.push('lg-bseat-target');
    if (isInjury) cls.push('lg-bseat-ir');

    let bodyHtml = 'empty';
    let tooltip = '';
    if (filled) {
        const p = o.pool.get(seat.playerId) || o.pool.get(String(seat.playerId));
        if (p) {
            bodyHtml = `${o.escapeHtml(shortName(p.name))} <span class="lg-bseat-figure">${o.escapeHtml(o.formatValue(p.value))}</span>`;
            tooltip = `${p.name}, ${o.formatValue(p.value)} projected. Click to remove.`;
        }
    } else if (targeted) {
        bodyHtml = `pick a ${o.escapeHtml(o.nounFor(seat.label))}`;
        tooltip = `Pick a ${o.nounFor(seat.label)} from the Projections list.`;
    }
    const removeHtml = filled
        ? `<button type="button" class="lg-bseat-remove" data-seat-remove="${index}" aria-label="Remove">&times;</button>`
        : '';
    const tipAttr = tooltip ? ` data-tooltip="${o.escapeHtml(tooltip)}"` : '';
    return `<div class="${cls.join(' ')}" data-seat-index="${index}"${tipAttr}>
        <b class="lg-bseat-label">${o.escapeHtml(seat.label)}</b>${removeHtml}
        <div class="lg-bseat-body">${bodyHtml}</div>
    </div>`;
}

function mockBenchRowHtml(benchEntries, o) {
    if (!benchEntries.length) return '';
    const seatsHtml = benchEntries.map(({ seat, index }) => mockBenchSeatHtml(seat, index, o)).join('');
    return `<div class="lg-bench-row"><span class="lg-bench-row-label">Bench</span>${seatsHtml}</div>`;
}

// `seats`: mock-lineup.js's own state.seats (v2), [{slotId, label, playerId, bench}], starters and bench in ONE array - the model's own design (see the contract's own note: every seat operation already walks `seats`, so splitting starters from bench here is a RENDER-TIME partition, never a second state). `opts.pool`: Map(playerId -> {name, value}), the SAME `value` the Projections card itself prints (never a second projection - mock-lineup.js's own rule, carried through here rather than re-earned). `opts.targetIndex`: the one seat currently armed to receive the next row click, or null - shared between the field and the bench, since only one seat is ever targeted at once regardless of which row it is in.
export function buildMockLineupGroundHtml(sport, seats, opts) {
    const o = resolveMockOpts(opts);
    const def = SPORTS[sport];
    if (!def || !seats || !seats.length) return '<svg viewBox="0 0 1 1" class="lg-ground"></svg>';

    // SPLIT ONCE, indices kept as positions into the ORIGINAL `seats` array throughout - seat()/ unseat() address by that global index, so a bench entry's own index must stay what it was before the split, never renumbered to its position within just the bench.
    const starterIndices = [];
    const benchEntries = [];
    seats.forEach((s, i) => (s.bench ? benchEntries : starterIndices).push(s.bench ? { seat: s, index: i } : i));
    if (!starterIndices.length) return '<svg viewBox="0 0 1 1" class="lg-ground"></svg>';

    // The same label-keyed grouping groupMockSeats does, scoped to starters only - a bench label ("BE", "IL", "IR") never collides with a real position code, but excluding it here rather than relying on that non-collision keeps this function's own contract explicit rather than incidental.
    const order = [];
    const byLabel = new Map();
    starterIndices.forEach(i => {
        const code = String(seats[i].label);
        if (!byLabel.has(code)) { byLabel.set(code, []); order.push(code); }
        byLabel.get(code).push(i);
    });
    const families = order.map(code => ({ code, indices: byLabel.get(code) }));

    const onGround = [];
    const aside = [];
    families.forEach(fam => {
        const points = def.seatPoints(fam.code, fam.indices.length);
        if (!points) { aside.push(fam); return; }
        onGround.push({ points: mockShiftPoints(sport, points), fam });
    });

    const groundSeatsHtml = onGround
        .map(g => g.points.map((p, i) => mockSeatHtml(p, g.fam.indices[i], seats, o)).join(''))
        .join('');
    const asideX = clearOfGroundSeats(def, onGround);
    let y = def.asideTop;
    const asideHtml = aside.map(fam => fam.indices.map(i => {
        const html = mockSeatHtml({ x: asideX, y }, i, seats, o);
        y += def.asideStep;
        return html;
    }).join('')).join('');

    // R1/S47b (frame H, the owner's own report - "the top WR's text is cut off"): the mock ground pads its OWN viewBox by one seat's height on every side, so a seat near the sport's own boundary always has room for its full text - the real ground's viewBoxFor call (shared, above) is untouched, and this padding never moves a single seat's (x, y). Mock-only, because the complaint and the fix are both about this ground alone.
    const [vx, vy, vw, vh] = viewBoxFor(def, groundSeatsHtml + asideHtml).split(' ').map(Number);
    const pad = SEAT_H;
    const viewBox = `${vx - pad} ${vy - pad} ${vw + pad * 2} ${vh + pad * 2}`;

    const svg = `<svg class="lg-ground" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
        ${centeredScrimmageSvg(sport, def.groundSvg())}
        ${groundSeatsHtml}
        ${asideHtml}
    </svg>`;

    return `<div class="lg-ground-wrap">${svg}${mockBenchRowHtml(benchEntries, o)}</div>`;
}
