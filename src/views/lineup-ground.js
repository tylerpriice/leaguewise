/**
 * Draws a starting lineup as sport-tailored SVG, a hockey rink, a baseball park or a football
 * formation, with the league's roster seats placed on it. It builds markup strings only.
 *
 * Pure. No imports, no application state, no DOM and no network; the HTML escaper arrives through
 * the options.
 *
 * Contract: tests/fixtures/lineup-ground.md
 * @module lineup-ground
 */
/**
 * One entry of the slot seat list. Entries sharing a slotCode form one family, in the order given.
 * @typedef {Object} SlotSeat
 * @property {string} slotCode the slot's display code, such as 'C', 'WR' or 'BE'
 * @property {number} [count] how many identical anonymous seats an unnamed entry stands for
 * @property {string|null} playerName the player's name, or null for an anonymous seat
 */
/**
 * One seat of the mock lineup model, starters and bench in a single array.
 * @typedef {Object} MockSeat
 * @property {string|number} slotId the seat's slot id
 * @property {string} label the display code the ground places by
 * @property {string|number|null} playerId the seated player, or null when empty
 * @property {boolean} bench true for a non-starting seat
 */
/**
 * Escapes a value for use in HTML text and attribute values.
 * @param {*} str the value, converted with String
 * @returns {string} the escaped text
 */
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

// The seat primitive. One roster slot drawn the same way on every ground, a small box with the slot code on top and an optional second line beneath, either a player's name or a muted repeat note, never both.
const SEAT_W = 48;
const SEAT_H = 34;
// Lane spacing follows the seat size, so adjacent seats keep a four unit margin. A lane that no longer fits its zone wraps by the wrap helpers below.
const LANE_ROW_STEP = SEAT_W + 4;
const LANE_COL_STEP = SEAT_H + 4;

// Mock only canvas scale. The card size is fixed apart from this number, which only gives the rink, park and field room for the zone placements to clear the card. Each sport has its own value because football needs more room than hockey.
const MOCK_SCALE = 12;
const MOCK_SCALE_FLB = 20;
// Football's scale, raised whenever the card height grew so its receiver clearance holds.
const MOCK_SCALE_FFL = 69;
// The card's designed size, fixed and independent of the canvas scale. It is taller than wide, the room its four stacked pieces need.
const MOCK_SEAT_W = 576;
// The card height is its content. The photo or silhouette fills what the fixed pieces leave, so no card has a blank band, and the rink's height comes from lane spacing instead.
const MOCK_SEAT_H = 720;
const MOCK_CARD_GAP = 20;
// The rink's vertical reach is lane spacing rather than card height, so a taller rink never means a taller card.
const MOCK_LANE_GAP_V = 540;
const MOCK_LANE_ROW_STEP = MOCK_SEAT_W + MOCK_CARD_GAP;
const MOCK_LANE_COL_STEP = MOCK_SEAT_H + MOCK_LANE_GAP_V;
// The card's fixed pieces. The photo is whatever height they leave, which differs for an empty seat and for a filled seat with or without a club pill.
const MOCK_STRIP_H = 100;
const MOCK_AV_GAP = 20; // strip-to-photo and photo-to-name/caption
const MOCK_NAME_H = 90;
const MOCK_PILL_GAP = 12;
const MOCK_PILL_H = 70;
const MOCK_BOTTOM_MARGIN = 10;
// Width and font of the card's name line, mirrored from the stylesheet because this module stays pure and cannot read the DOM.
const MOCK_NAME_LINE_W = MOCK_SEAT_W - 80;
const MOCK_NAME_FONT = 76;
// The smallest name size that still renders at the legibility floor at the narrowest supported width. The contract file records the measurement.
const MOCK_NAME_STEP_FLOOR = 72;
// Line gap for a two line name, taller than the glyphs so the lines never touch.
const MOCK_NAME_LINE_GAP = 95;

function seatSvg(x, y, code, sub, subMuted, opts, dashed) {
    const cls = dashed ? 'lg-seat lg-seat-dashed' : 'lg-seat';
    const codeY = sub ? y - 3 : y + 4;
    // A plain string is a repeat note or an unknown code. An object carries text and a font size for a named seat.
    const subText = sub && typeof sub === 'object' ? sub.text : sub;
    const subStyleAttr = sub && typeof sub === 'object' && sub.fontSize !== STATIC_NAME_FONT ? ` style="font-size:${sub.fontSize}px"` : '';
    const subHtml = sub
        ? `<text class="${subMuted ? 'lg-seat-sub lg-seat-sub-muted' : 'lg-seat-sub'}" x="${x}" y="${y + 9}" text-anchor="middle"${subStyleAttr}>${opts.escapeHtml(subText)}</text>`
        : '';
    return `<g class="${cls}">
        <rect class="lg-seat-box" x="${x - SEAT_W / 2}" y="${y - SEAT_H / 2}" width="${SEAT_W}" height="${SEAT_H}" rx="4"></rect>
        <text class="lg-seat-code" x="${x}" y="${codeY}" text-anchor="middle">${opts.escapeHtml(code)}</text>
        ${subHtml}
    </g>`;
}

// A neutral, off-ground seat for a slot code the sport's own placement table does not know, drawn exactly like an aside seat (dashed), never guessed onto the ground itself. Same primitive, no special styling of its own, because "we do not know where this goes" and "this deliberately does not go on the ground" (UTIL, DH, the pitching staff) are the same visual statement: dashed, aside.
function neutralSeatSvg(x, y, code, sub, opts) {
    return seatSvg(x, y, code, sub, false, opts, true);
}

// Grouping turns the slot seat list into one family per slot code, in the order given. A named entry is one seat and an anonymous entry is count identical seats.
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

// Spread helpers turn a seat count into points. Every sport shares them.

// N points on one horizontal row, evenly spaced around centerX.
function rowPoints(centerX, y, count, spacing) {
    const pts = [];
    const start = centerX - (spacing * (count - 1)) / 2;
    for (let i = 0; i < count; i++) pts.push({ x: start + i * spacing, y });
    return pts;
}

// N points in one vertical column, evenly spaced around centerY, rowPoints turned 90 degrees, for a group that stacks front-to-back (football's backfield) rather than side-to-side.
function columnPoints(x, centerY, count, spacing) {
    const pts = [];
    const start = centerY - (spacing * (count - 1)) / 2;
    for (let i = 0; i < count; i++) pts.push({ x, y: start + i * spacing });
    return pts;
}

// Lane wrapping. A lane holds as many seats as fit at full size before wrapping to a second row in its zone, and a seat is never shrunk to make more fit.

// A horizontal row that wraps to further rows stacked along Y once `maxPerRow` is exceeded, each wrapped row stepping `rowStep` further in `dir` (+1 or -1) from the first row at `centerY`, e.g. a board lane wraps INWARD (dir toward centre ice), never outward past the boards.
function rowPointsWrap(centerX, centerY, count, spacing, maxPerRow, rowStep, dir) {
    const pts = [];
    let remaining = count;
    let row = 0;
    while (remaining > 0) {
        const n = Math.min(maxPerRow, remaining);
        remaining -= n;
        pts.push(...rowPoints(centerX, centerY + dir * row * rowStep, n, spacing));
        row++;
    }
    return pts;
}

// The column version of the wrapping row, used by the mock rink, which runs in columns along the ice.
function columnPointsWrap(centerX, centerY, count, spacing, maxPerCol, colStep, dir) {
    const pts = [];
    let remaining = count;
    let col = 0;
    while (remaining > 0) {
        const n = Math.min(maxPerCol, remaining);
        remaining -= n;
        pts.push(...columnPoints(centerX + dir * col * colStep, centerY, n, spacing));
        col++;
    }
    return pts;
}

// An arc that wraps to further arcs at a smaller radius once `maxPerRing` is exceeded, the outfield's own overflow, a five-outfield league wrapping the arc rather than crowding the fence.
function arcPointsWrap(cx, cy, r, startDeg, endDeg, count, maxPerRing, rInStep) {
    const pts = [];
    let remaining = count;
    let ring = 0;
    while (remaining > 0) {
        const n = Math.min(maxPerRing, remaining);
        remaining -= n;
        pts.push(...arcPoints(cx, cy, r - ring * rInStep, startDeg, endDeg, n));
        ring++;
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

// Hockey. The rink is drawn landscape with its zones at the same fractions of the length as the published rink diagram. Creases and faceoff circles sit at both ends because the mock has no end of its own.
const RINK_W = 500;
const RINK_H = 350;
const RINK_X = 15;
const RINK_Y = 8;
const RINK_R = 70;
const RINK_CANVAS_W = RINK_X * 2 + RINK_W;
const RINK_CANVAS_H = RINK_Y * 2 + RINK_H;
// Blue lines placed so a centre's seat clears the defence seats on each blue line.
const BLUE_LEFT = 150;
const BLUE_RIGHT = 350;

// The mock rink is sized in card step units for three lanes and nine columns running along the length from centre ice, so it reads wider than the real rink.
const MOCK_RINK_W = MOCK_LANE_ROW_STEP * 9;
const MOCK_RINK_H = MOCK_LANE_COL_STEP * 3;
const MOCK_RINK_X = MOCK_LANE_ROW_STEP * 0.4;
const MOCK_RINK_Y = MOCK_LANE_COL_STEP * 0.4;
const MOCK_RINK_R = MOCK_LANE_COL_STEP * 0.5;
// The blue lines sit two columns in from centre ice, see hockeyMockSeatPoints' own column table.
const MOCK_BLUE_LEFT = MOCK_RINK_W / 2 - MOCK_LANE_ROW_STEP * 2;
const MOCK_BLUE_RIGHT = MOCK_RINK_W / 2 + MOCK_LANE_ROW_STEP * 2;

function rinkX(u, mock) { return (mock ? MOCK_RINK_X : RINK_X) + u; } // u in rink-local units, 0..500 (the long axis)
function rinkY(v, mock) { return (mock ? MOCK_RINK_Y : RINK_Y) + v; } // v in rink-local units, 0..350 (the short axis)

// The red line, goal lines and faceoff spots read off fractions of the rink length. The circle radius is 15 feet on a 200 foot sheet, so an end circle clears its goal line.
const RINK_FACEOFF_R = RINK_W * 0.075;
// The mock rink's markings scale by its width over the real rink's width, so they keep their proportion.
function hockeyGroundSvg(mock) {
    const s = mock ? MOCK_RINK_W / RINK_W : 1;
    const W = mock ? MOCK_RINK_W : RINK_W, H = mock ? MOCK_RINK_H : RINK_H;
    const X = mock ? MOCK_RINK_X : RINK_X, Y = mock ? MOCK_RINK_Y : RINK_Y;
    const R = mock ? MOCK_RINK_R : RINK_R;
    const rX = (u) => rinkX(u, mock), rY = (v) => rinkY(v, mock);
    const blueLeft = rX(mock ? MOCK_BLUE_LEFT : BLUE_LEFT), blueRight = rX(mock ? MOCK_BLUE_RIGHT : BLUE_RIGHT), redX = rX(W * 0.5);
    const goalLeft = rX(W * 0.055), goalRight = rX(W * 0.945);
    const faceoffR = RINK_FACEOFF_R * s;
    const faceoffs = [
        { x: rX(W * 0.155), y: rY(H * 0.2) }, { x: rX(W * 0.155), y: rY(H * 0.8) },
        { x: rX(W * 0.845), y: rY(H * 0.2) }, { x: rX(W * 0.845), y: rY(H * 0.8) },
    ];
    const faceoffCircles = faceoffs.map(p => `<circle class="lg-rink-circle" cx="${p.x}" cy="${p.y}" r="${faceoffR}"></circle>`).join('');
    const dotR = 7.5 * s;
    const faceoffDots = faceoffs.map(p => `<circle class="lg-rink-dot" cx="${p.x}" cy="${p.y}" r="${dotR}"></circle>`).join('');
    const crY = rY(H / 2);
    const goalInset = 15 * s, creaseR = 27.5 * s;
    // A glow on the ice, mock only. The gradient shape lives here and its stop colours come from CSS classes, so this module holds no theme.
    const defsHtml = mock
        ? `<defs><radialGradient id="lg-ice-glow" cx="50%" cy="32%" r="85%">
            <stop offset="0%" class="lg-rink-ice-glow-in"></stop>
            <stop offset="100%" class="lg-rink-ice-glow-out"></stop>
        </radialGradient></defs>`
        : '';
    // The boards band is a second rect outside the ice at a fraction of the rink width, mock only. The ground box helper uses the same fraction, so the viewBox matches what is drawn.
    const boardsPad = mock ? W * 0.03 : 0;
    const boardsHtml = mock
        ? `<rect class="lg-rink-boards" x="${X - boardsPad}" y="${Y - boardsPad}" width="${W + boardsPad * 2}" height="${H + boardsPad * 2}" rx="${R + boardsPad * 0.5}"></rect>`
        : '';
    return `
        ${defsHtml}
        ${boardsHtml}
        <rect class="lg-rink-ice" x="${X}" y="${Y}" width="${W}" height="${H}" rx="${R}"></rect>
        <line class="lg-rink-blue" x1="${blueLeft}" y1="${Y}" x2="${blueLeft}" y2="${Y + H}"></line>
        <line class="lg-rink-blue" x1="${blueRight}" y1="${Y}" x2="${blueRight}" y2="${Y + H}"></line>
        <line class="lg-rink-red" x1="${redX}" y1="${Y}" x2="${redX}" y2="${Y + H}"></line>
        <line class="lg-rink-goal" x1="${goalLeft}" y1="${Y + goalInset}" x2="${goalLeft}" y2="${Y + H - goalInset}"></line>
        <line class="lg-rink-goal" x1="${goalRight}" y1="${Y + goalInset}" x2="${goalRight}" y2="${Y + H - goalInset}"></line>
        ${faceoffCircles}
        <circle class="lg-rink-circle" cx="${redX}" cy="${crY}" r="${faceoffR}"></circle>
        ${faceoffDots}
        <circle class="lg-rink-dot" cx="${redX}" cy="${crY}" r="${dotR}"></circle>
        <path class="lg-rink-crease" d="M ${goalLeft} ${crY - creaseR} A ${creaseR} ${creaseR} 0 0 0 ${goalLeft} ${crY + creaseR} Z"></path>
        <path class="lg-rink-crease" d="M ${goalRight} ${crY - creaseR} A ${creaseR} ${creaseR} 0 0 1 ${goalRight} ${crY + creaseR} Z"></path>`;
}

// Seat placement for each hockey slot family. Every lane wraps once it holds more than its zone fits at full seat size. A code this ground does not place returns null and falls back to the aside seat. The mock flag selects the mock canvas.
function hockeySeatPoints(code, count, mock) {
    // The mock ground reads its own zone table. The real ground below is unchanged.
    if (mock) return hockeyMockSeatPoints(code, count);
    const W = RINK_W;
    const H = RINK_H;
    const bLeft = BLUE_LEFT;
    const bRight = BLUE_RIGHT;
    const rowStep = LANE_ROW_STEP;
    const colStep = LANE_COL_STEP;
    const rX = (u) => rinkX(u, false);
    const rY = (v) => rinkY(v, false);
    const cy = rY(H / 2);
    switch (code) {
        // Goalies alternate ends. A third or later goalie wraps at the same end above and below centre ice, since stepping inward would meet the blue line column.
        case 'G': {
            const pts = [];
            for (let i = 0; i < count; i++) {
                const end = i % 2; // 0 = left crease, 1 = right crease
                const wrapRow = Math.floor(i / 2);
                const step = Math.ceil(wrapRow / 2);
                const dir = wrapRow % 2 === 0 ? 1 : -1;
                const x = end === 0 ? rX(W * 0.12) : rX(W * 0.88);
                pts.push({ x, y: cy + dir * step * colStep });
            }
            return pts;
        }
        // Defence stands in a column at each blue line, split across the two. There is no free lane to wrap into, so a deeper column grows and the viewBox holds it.
        case 'D': {
            const left = Math.ceil(count / 2), right = count - left;
            return columnPoints(rX(bLeft), cy, left, colStep).concat(columnPoints(rX(bRight), cy, right, colStep));
        }
        // Centres stand one to a row at centre ice, wrapping above and below in turn so every row stays within a step of centre ice.
        case 'C': {
            const pts = [];
            for (let i = 0; i < count; i++) {
                const step = Math.ceil(i / 2);
                const dir = i % 2 === 0 ? 1 : -1;
                pts.push({ x: rX(W * 0.5), y: cy + dir * step * colStep });
            }
            return pts;
        }
        // LW/RW share the one end's two faceoff circles (the same "own named circle" the vertical rink used, split by cross-ice side rather than by end), both wingers belong to the same attacking zone, just on opposite boards of it.
        case 'LW':
            return rowPoints(rX(W * 0.155), rY(H * 0.2), count, rowStep);
        case 'RW':
            return rowPoints(rX(W * 0.155), rY(H * 0.8), count, rowStep);
        // Forwards split evenly across both boards and wrap outward past the boards, since inward is the centre ice band. The row wraps at two so a third seat does not land on the UTIL seat.
        case 'F': {
            const top = Math.ceil(count / 2), bottom = count - top;
            const edge = 60;
            const pts = rowPointsWrap(rX(W * 0.5), rY(edge), top, rowStep, 2, colStep, -1);
            return pts.concat(rowPointsWrap(rX(W * 0.5), rY(H - edge), bottom, rowStep, 2, colStep, 1));
        }
        // UTIL sits on the ice in the neutral zone against the top board, clear of the defence column and the forward rows.
        case 'UTIL': {
            const y = 40;
            return rowPoints(rX(bLeft + 20), rY(y), count, rowStep);
        }
        default:
            return null;
    }
}

// The mock zone table. Columns run out from centre ice along the rink's length with at most three lanes per column, wrapping to a further column rather than a fourth lane. UTIL sits at centre, centres one column out, defence at the blue lines, forwards in the attacking zones and goalies at the creases.
function hockeyMockSeatPoints(code, count) {
    const H = MOCK_RINK_H;
    const rowStep = MOCK_LANE_ROW_STEP, colStep = MOCK_LANE_COL_STEP;
    const rX = (u) => rinkX(u, true), rY = (v) => rinkY(v, true);
    const cx = rX(MOCK_RINK_W / 2), cy = rY(H / 2);
    const col = (k) => cx + k * rowStep;
    switch (code) {
        // Column ±4, split left/right, the crease. A fourth-plus goalie (rare) wraps FURTHER out past the crease rather than inward onto the forwards' own column.
        case 'G': {
            const left = Math.ceil(count / 2), right = count - left;
            return columnPointsWrap(col(-4), cy, left, colStep, 3, rowStep, -1)
                .concat(columnPointsWrap(col(4), cy, right, colStep, 3, rowStep, 1));
        }
        // Column ±2, the blue lines, split left/right the same way the real ground's own D pair does. A third-plus pair on one side wraps OUTWARD (toward that side's own crease) rather than inward onto centre ice or a centre's own column.
        case 'D': {
            const left = Math.ceil(count / 2), right = count - left;
            return columnPointsWrap(col(-2), cy, left, colStep, 3, rowStep, -1)
                .concat(columnPointsWrap(col(2), cy, right, colStep, 3, rowStep, 1));
        }
        // Column -1 only, one step into the neutral zone from UTIL's own centre column, wraps FURTHER into the neutral zone (never onto UTIL's own column at 0, never onto D's at -2) past three.
        case 'C':
            return columnPointsWrap(col(-1), cy, count, colStep, 3, rowStep, -1);
        // Column ±3, the attacking zones, split left/right, sharing the SAME columns LW/RW read below (alternatives, never measured together, see this function's own comment).
        case 'F': {
            const left = Math.ceil(count / 2), right = count - left;
            return columnPointsWrap(col(-3), cy, left, colStep, 3, rowStep, -1)
                .concat(columnPointsWrap(col(3), cy, right, colStep, 3, rowStep, 1));
        }
        case 'LW':
            return columnPointsWrap(col(-3), cy, count, colStep, 3, rowStep, -1);
        case 'RW':
            return columnPointsWrap(col(3), cy, count, colStep, 3, rowStep, 1);
        // Column 0, dead centre ice, the one spot every other zone above is laid out to leave clear. A second-plus UTIL (rare) wraps toward the centre's own column past three.
        case 'UTIL':
            return columnPointsWrap(col(0), cy, count, colStep, 3, rowStep, -1);
        default:
            return null;
    }
}
// Hockey now places every one of its own codes somewhere on the ice (UTIL included, above), no code this sport's own catalog uses is aside by design any more, only an unrecognized one falls to that treatment (the shared default in buildLineupGroundHtml/buildMockLineupGroundHtml).
const HOCKEY_ASIDE_CODES = new Set();

// Baseball. The park has foul lines, an outfield fence arc, an infield dirt arc, the diamond, the mound and the bases. UTIL, DH and the pitching staff are listed beside the park because none has one true spot.
const PARK_CX = 183.5;
const PARK_HOME_Y = 296.5;
const PARK_R_OUT = 247; // outfield fence radius from home
const PARK_R_DIRT = 134; // infield dirt arc radius from home
const PARK_BAG_R = 87.5; // distance from home to each base along the diamond
const PARK_CANVAS_W = 423.5;
// The PITCH's own canvas, not the drawing's bounds: the catcher's seat reaches y=238 and other lineups push the aside column further still, and viewBoxFor grows the box to hold whatever is actually drawn. Raising this number instead would be a second mechanism for the same job, and the one that cannot keep up, it is fixed while the seats move with the league's roster shape.
const PARK_CANVAS_H = 325;

// The mock park is sized in card step units for the rows its table holds, with the bag distance one lane and the fence clearing the outfield row's far corner at the deepest allowed roster. The dirt arc sits past the bags so the middle row stands on grass.
const MOCK_PARK_BAG_R = MOCK_LANE_COL_STEP;
const MOCK_PARK_R_OUT = 4550;
const MOCK_PARK_R_DIRT = MOCK_PARK_BAG_R + MOCK_LANE_COL_STEP * 0.4;
// Home sits far enough in from the origin that the whole wedge is positive; viewBoxFor still grows the box past anything that reaches further (the catcher below the plate, the rails in foul territory), so these two are a starting corner rather than a bound.
const MOCK_PARK_CX = MOCK_PARK_R_OUT + 300;
const MOCK_PARK_HOME_Y = MOCK_PARK_R_OUT + 600;

function baseballGroundSvg(mock) {
    const s = mock ? MOCK_SCALE_FLB : 1;
    const cx = mock ? MOCK_PARK_CX : PARK_CX, homeY = mock ? MOCK_PARK_HOME_Y : PARK_HOME_Y;
    const rOut = mock ? MOCK_PARK_R_OUT : PARK_R_OUT, rDirt = mock ? MOCK_PARK_R_DIRT : PARK_R_DIRT, bagR = mock ? MOCK_PARK_BAG_R : PARK_BAG_R;
    // Foul lines run from home at +/-45 degrees off vertical, matching the diamond's own corners.
    const flX1 = cx - rOut * Math.SQRT1_2, flY1 = homeY - rOut * Math.SQRT1_2;
    const flX2 = cx + rOut * Math.SQRT1_2, flY2 = homeY - rOut * Math.SQRT1_2;
    const first = { x: cx + bagR, y: homeY - bagR };
    const second = { x: cx, y: homeY - bagR * 2 };
    const third = { x: cx - bagR, y: homeY - bagR };
    const baseHalf = 5 * s, baseSide = 10 * s, homeHalf = 6 * s, homeSide = 12 * s, moundR = 7 * s;
    // Grass and dirt get the same depth glow as the ice, mock only, with stop colours from CSS classes.
    const defsHtml = mock
        ? `<defs>
            <radialGradient id="lg-grass-glow" cx="50%" cy="25%" r="85%">
                <stop offset="0%" class="lg-park-outfield-glow-in"></stop>
                <stop offset="100%" class="lg-park-outfield-glow-out"></stop>
            </radialGradient>
            <radialGradient id="lg-dirt-glow" cx="50%" cy="35%" r="75%">
                <stop offset="0%" class="lg-park-dirt-glow-in"></stop>
                <stop offset="100%" class="lg-park-dirt-glow-out"></stop>
            </radialGradient>
        </defs>`
        : '';
    return `
        ${defsHtml}
        <path class="lg-park-outfield" d="M ${flX1} ${flY1} A ${rOut} ${rOut} 0 0 1 ${flX2} ${flY2} L ${cx} ${homeY} Z"></path>
        <path class="lg-park-dirt" d="M ${cx - rDirt} ${homeY} A ${rDirt} ${rDirt} 0 0 1 ${cx + rDirt} ${homeY} Z"></path>
        <polygon class="lg-park-diamond" points="${cx},${homeY} ${first.x},${first.y} ${second.x},${second.y} ${third.x},${third.y}"></polygon>
        <line class="lg-park-foul" x1="${cx}" y1="${homeY}" x2="${flX1}" y2="${flY1}"></line>
        <line class="lg-park-foul" x1="${cx}" y1="${homeY}" x2="${flX2}" y2="${flY2}"></line>
        <circle class="lg-park-mound" cx="${cx}" cy="${homeY - bagR}" r="${moundR}"></circle>
        <rect class="lg-park-base" x="${first.x - baseHalf}" y="${first.y - baseHalf}" width="${baseSide}" height="${baseSide}" transform="rotate(45 ${first.x} ${first.y})"></rect>
        <rect class="lg-park-base" x="${second.x - baseHalf}" y="${second.y - baseHalf}" width="${baseSide}" height="${baseSide}" transform="rotate(45 ${second.x} ${second.y})"></rect>
        <rect class="lg-park-base" x="${third.x - baseHalf}" y="${third.y - baseHalf}" width="${baseSide}" height="${baseSide}" transform="rotate(45 ${third.x} ${third.y})"></rect>
        <rect class="lg-park-home" x="${cx - homeHalf}" y="${homeY - homeHalf}" width="${homeSide}" height="${homeSide}"></rect>`;
}

// The mock flag hands off to the mock table, so the offsets below belong to the real park.
function baseballSeatPoints(code, count, mock) {
    if (mock) return baseballMockSeatPoints(code, count);
    const s = 1;
    const cx = mock ? MOCK_PARK_CX : PARK_CX, homeY = mock ? MOCK_PARK_HOME_Y : PARK_HOME_Y;
    const rDirt = mock ? MOCK_PARK_R_DIRT : PARK_R_DIRT, bagR = mock ? MOCK_PARK_BAG_R : PARK_BAG_R;
    const rowStep = mock ? MOCK_LANE_ROW_STEP : LANE_ROW_STEP;
    const colStep = mock ? MOCK_LANE_COL_STEP : LANE_COL_STEP;
    switch (code) {
        case 'C':
            return rowPoints(cx, homeY + 23 * s, count, rowStep);
        case '1B':
            return rowPoints(cx + bagR + 28 * s, homeY - bagR, count, rowStep);
        // 2B sits well clear of a plain OF/CF seat's own dead-centre arc point (a real overlap this suite once caught at the old seat size); 3B/SS scaled the same ratio as everything else here.
        case '2B':
            return rowPoints(cx, homeY - bagR * 2 - 56 * s, count, rowStep);
        case '3B':
            return rowPoints(cx - bagR - 28 * s, homeY - bagR, count, rowStep);
        case 'SS':
            return rowPoints(cx - 54 * s, homeY - bagR - 42 * s, count, rowStep);
        case 'P':
            return rowPoints(cx, homeY - bagR, count, rowStep);
        // LF/CF/RF take their named spot on the arc; a plain OF slot fills the arc generally, both read as "the outfield", the only distinction is whether the league's own catalog happened to name a side.
        case 'LF':
            return arcPoints(cx, homeY, rDirt + 59 * s, -55, -55, count);
        case 'CF':
            return arcPoints(cx, homeY, rDirt + 59 * s, 0, 0, count);
        case 'RF':
            return arcPoints(cx, homeY, rDirt + 59 * s, 55, 55, count);
        // A plain outfield family wraps to a tighter arc past four seats rather than crowding the fence row.
        case 'OF':
            return arcPointsWrap(cx, homeY, rDirt + 59 * s, -50, 50, count, 4, colStep);
        default:
            return null;
    }
}

// The mock park's table lays rows out from home along the park's depth and columns across it. Rows are one lane apart and cards in a row at least one row step apart, so no pair needs a distance worked out by hand. The spacing assumes two a position. Bench side slots stand on rails in foul territory.
function baseballMockSeatPoints(code, count) {
    const cx = MOCK_PARK_CX, homeY = MOCK_PARK_HOME_Y;
    const lane = MOCK_LANE_COL_STEP, step = MOCK_LANE_ROW_STEP;
    const row = (n) => homeY - n * lane;              // n lanes out from home, toward the fence
    const at = (k) => cx + k * step;                  // k row-steps across from the plate
    // A rail is a column level with the bags that wraps toward the fence before stepping out. It stands 3.6 and 4.6 steps out so it clears the widest fielder the table allows.
    const rail = (k, dir) => columnPointsWrap(at(k), row(1), count, lane, 3, step * 2 * dir, 1);
    switch (code) {
        case 'C':
            return rowPoints(cx, row(-0.45), count, step);
        case 'P':
            return rowPoints(cx, row(1), count, step);
        case '1B':
            return rowPoints(at(2), row(1), count, step);
        case '3B':
            return rowPoints(at(-2), row(1), count, step);
        case '2B':
            return rowPoints(at(1.2), row(2), count, step);
        case 'SS':
            return rowPoints(at(-1.2), row(2), count, step);
        // The three named outfield spots, and the generic OF family sharing centre's own column, alternatives in every catalog measured, never drawn together (the same rule hockey's own F/LW/RW share, and disclosed the same way in the contract).
        case 'LF':
            return rowPoints(at(-2), row(2.8), count, step);
        case 'CF':
        case 'OF':
            return rowPoints(cx, row(2.8), count, step);
        case 'RF':
            return rowPoints(at(2), row(2.8), count, step);
        // The rails, the pitchers on the first-base side and the bats on the third.
        case 'SP':
            return rail(3.6, 1);
        case 'RP':
            return rail(4.6, 1);
        case 'DH':
            return rail(-3.6, -1);
        case 'UTIL':
            return rail(-4.6, -1);
        default:
            return null;
    }
}

// The real park still lists these beside it (no true spot on the field); the MOCK places every one of them on its own rails above, so this set is the real ground's alone, the mock path never consults it, reaching aside only for a code no table answers at all.
const BASEBALL_ASIDE_CODES = new Set(['UTIL', 'DH', 'SP', 'RP']);

// Football. Offence lines up left of the scrimmage line. Receivers stand nearest the sidelines, the tight end on the line set back from the edge and FLEX in the slot behind it. The quarterback stands a short depth back with the running backs stacked behind, the kicker in a row of its own and the defence as one seat across the line.
const FIELD_W = 424;
const FIELD_H = 240;
const FIELD_X = 8.5;
const FIELD_Y = 8.5;
const SCRIMMAGE_X = FIELD_X + FIELD_W * 0.42;

// The mock field is sized in card step units for the formation's rows, three lanes across with columns back from the line. The line is centred, so the turf spans the deepest offensive column on one side and the defence's column on the other.
const MOCK_FIELD_W = 6100;
const MOCK_FIELD_H = MOCK_LANE_COL_STEP * 2 + MOCK_SEAT_H + 600;
const MOCK_FIELD_X = 300;
const MOCK_FIELD_Y = 300;
const MOCK_SCRIMMAGE_X = MOCK_FIELD_X + MOCK_FIELD_W * 0.42;

function footballGroundSvg(mock) {
    const W = mock ? MOCK_FIELD_W : FIELD_W, H = mock ? MOCK_FIELD_H : FIELD_H;
    const X = mock ? MOCK_FIELD_X : FIELD_X, Y = mock ? MOCK_FIELD_Y : FIELD_Y;
    const scrimmageX = mock ? MOCK_SCRIMMAGE_X : SCRIMMAGE_X;
    return `
        <rect class="lg-field-turf" x="${X}" y="${Y}" width="${W}" height="${H}"></rect>
        <line class="lg-field-scrimmage" x1="${scrimmageX}" y1="${Y}" x2="${scrimmageX}" y2="${Y + H}"></line>`;
}

// The mock draws the line of scrimmage at the field's horizontal centre. The real ground's 42 percent position is untouched.
function centeredScrimmageSvg(sport, svg) {
    if (sport !== 'ffl') return svg;
    const center = MOCK_FIELD_X + MOCK_FIELD_W / 2;
    return svg
        .replace(/(class="lg-field-scrimmage" x1=")[\d.]+(")/, `$1${center}$2`)
        .replace(/(class="lg-field-scrimmage"[^>]*x2=")[\d.]+(")/, `$1${center}$2`);
}

// Mock seats shift by the amount the line moved, which keeps every seat's distance from the line and changes only where the formation sits on the field.
const FFL_MOCK_LINE_DX = (MOCK_FIELD_X + MOCK_FIELD_W / 2) - MOCK_SCRIMMAGE_X;
function mockShiftPoints(sport, points) {
    if (sport !== 'ffl' || !points) return points;
    return points.map(p => ({ ...p, x: p.x + FFL_MOCK_LINE_DX }));
}

// WR stands on the line at each sideline in turn, top first, a half seat width short of the line. A third receiver on a side steps along the sideline.
const WR_LINE_X = SCRIMMAGE_X - 24;
// The mock reads half the card width directly, because the card no longer grows with the field scale.
const MOCK_WR_LINE_X = MOCK_SCRIMMAGE_X - MOCK_SEAT_W / 2;
// The mock flag reads the mock field and line dimensions and the card height.
function footballWrPoints(count, mock) {
    // Half the seat height is the floor that always clears the field edge, whatever the seat size.
    const seatH = mock ? MOCK_SEAT_H : SEAT_H;
    const fieldY = mock ? MOCK_FIELD_Y : FIELD_Y, fieldH = mock ? MOCK_FIELD_H : FIELD_H;
    const lineX = mock ? MOCK_WR_LINE_X : WR_LINE_X;
    const rowStep = mock ? MOCK_LANE_ROW_STEP : LANE_ROW_STEP;
    const topY = fieldY + seatH / 2;
    const bottomY = fieldY + fieldH - seatH / 2;
    const pts = [];
    let topSeen = 0, bottomSeen = 0;
    for (let i = 0; i < count; i++) {
        if (i % 2 === 0) { pts.push({ x: lineX, y: topY + topSeen * rowStep }); topSeen++; }
        else { pts.push({ x: lineX, y: bottomY - bottomSeen * rowStep }); bottomSeen++; }
    }
    return pts;
}

function footballSeatPoints(code, count, mock) {
    if (mock) return footballMockSeatPoints(code, count);
    const s = 1;
    const fieldY = mock ? MOCK_FIELD_Y : FIELD_Y, fieldH = mock ? MOCK_FIELD_H : FIELD_H;
    const scrimmageX = mock ? MOCK_SCRIMMAGE_X : SCRIMMAGE_X;
    const lineX = mock ? MOCK_WR_LINE_X : WR_LINE_X;
    const seatW = mock ? MOCK_SEAT_W : SEAT_W;
    const rowStep = mock ? MOCK_LANE_ROW_STEP : LANE_ROW_STEP;
    const colStep = mock ? MOCK_LANE_COL_STEP : LANE_COL_STEP;
    const midY = fieldY + fieldH / 2;
    switch (code) {
        // The quarterback stands a short depth behind the line, centred. The backfield file is QB and RB alone.
        case 'QB':
            return rowPoints(scrimmageX - 45 * s, midY, count, rowStep);
        // Stacked BEHIND the QB (further from scrimmage, not spread beside it), a vertical column, so two RBs read as one family one behind the other, the way a real backfield does, rather than as a wide row that could be mistaken for more bodies than the roster carries.
        case 'RB':
            return columnPoints(scrimmageX - 102 * s, midY, count, colStep);
        case 'WR':
            return footballWrPoints(count, mock);
        // On the line, at the bottom edge like the bottom WR, but set back toward the middle of the field (a step off the true sideline, clearing the WR seat there by a full SEAT_H of margin) rather than split as wide as a receiver, the real difference between the two.
        case 'TE':
            return rowPoints(lineX, fieldY + fieldH - 20 * s - seatW, count, rowStep);
        // THE SLOT: off the line (set back toward the QB, clearing WR/TE's own on-the-line column by more than a seat width so neither adjacency needs the two seats' Y values to also clear) and between the bottom WR's depth and the TE's, the receiver spot that is neither split to the sideline nor tight to the formation.
        case 'FLEX':
            return rowPoints(lineX - 54 * s, fieldY + fieldH - 20 * s - seatW / 2, count, rowStep);
        // Centred RIGHT of the line, one unit seat, never spread (a fantasy roster carries a team defense as a single slot, same note as the ground primitive above).
        case 'D/ST':
            return rowPoints(scrimmageX + 71 * s, midY, count, rowStep);
        // The kicker takes a row of its own behind the backfield and under the QB and RB line, near the bottom sideline.
        case 'K':
            return rowPoints(scrimmageX - 136 * s, fieldY + fieldH - 28 * s, count, rowStep);
        default:
            return null;
    }
}

// The mock formation on lanes and columns. A lane is one card height plus a gap and a column one card width plus a gap, so cards in different lanes or columns clear each other by construction. The deepest roster that clears is six receivers, two ends and three backs.
function footballMockSeatPoints(code, count) {
    const lane = MOCK_LANE_COL_STEP, step = MOCK_LANE_ROW_STEP;
    const midY = MOCK_FIELD_Y + MOCK_FIELD_H / 2;
    const y = (j) => midY + j * lane;
    const col = (k) => MOCK_WR_LINE_X - k * step;
    // One card a column, stepping back from the line, a family that reads as one file rather than a row of extra bodies.
    const file = (k0, j, n) => {
        const pts = [];
        for (let i = 0; i < n; i++) pts.push({ x: col(k0 + i), y: y(j) });
        return pts;
    };
    switch (code) {
        // Two a column, the sidelines first, wrapping BACK a column rather than into a third lane, past the spine's own two columns, never through them.
        case 'WR': {
            const pts = [];
            for (let i = 0; i < count; i++) {
                const c = Math.floor(i / 2);
                pts.push({ x: col(c < 2 ? c : c + 2), y: y(i % 2 === 0 ? -1 : 1) });
            }
            return pts;
        }
        case 'TE':
            return file(0, 0, count);
        // A SECOND QUARTERBACK TAKES A LANE, NOT THE NEXT COLUMN, a superflex league starts two, and the column behind the line is the backfield's own (the suite caught the collision at the deep roster). Three is the limit: the lanes are the field's own.
        case 'QB': {
            const lanes = [0, -1, 1];
            const pts = [];
            for (let i = 0; i < count; i++) pts.push({ x: col(2), y: y(lanes[i % lanes.length]) });
            return pts;
        }
        case 'FLEX':
            return file(3, 1, count);
        case 'K':
            return file(3, -1, count);
        case 'RB':
            return file(3, 0, count);
        case 'D/ST':
            return rowPoints(col(-5), y(0), count, step);
        default:
            return null;
    }
}

const FOOTBALL_ASIDE_CODES = new Set();

// Each sport states its ground's full visual extent, which the mock viewBox unions with the seats, so the drawing never sits outside its own box. Hockey's is the boards band.
function hockeyMockGroundBox() {
    const pad = MOCK_RINK_W * 0.03; // hockeyGroundSvg's own boardsPad, restated (see its comment)
    return { x: MOCK_RINK_X - pad, y: MOCK_RINK_Y - pad, w: MOCK_RINK_W + pad * 2, h: MOCK_RINK_H + pad * 2 };
}
// Baseball's extent is the wedge between the foul lines and not the full fence circle, which would pad the box and shrink every card.
function baseballMockGroundBox() {
    const half = MOCK_PARK_R_OUT * Math.SQRT1_2;   // the foul lines, 45 degrees off vertical
    return { x: MOCK_PARK_CX - half, y: MOCK_PARK_HOME_Y - MOCK_PARK_R_OUT, w: half * 2, h: MOCK_PARK_R_OUT };
}
function footballMockGroundBox() {
    return { x: MOCK_FIELD_X, y: MOCK_FIELD_Y, w: MOCK_FIELD_W, h: MOCK_FIELD_H };
}

// ==== PER-SPORT REGISTRY ====
const SPORTS = {
    fhl: {
        canvasW: RINK_CANVAS_W, canvasH: RINK_CANVAS_H,
        groundSvg: hockeyGroundSvg, seatPoints: hockeySeatPoints, asideCodes: HOCKEY_ASIDE_CODES,
        // MOCK_LANE_ROW_STEP, not MOCK_LANE_COL_STEP, this pad is added to BOTH viewBox dimensions uniformly, so basing it on the card's own HEIGHT step let it grow every time MOCK_SEAT_H did (item 3's own card growth), quietly eating into the WIDTH bar that growth was never supposed to touch (cardPxWidth measured 70 against the accepted 72 floor, live, before this was traced and fixed). Rowstep never moves with card height.
        mockGroundBox: hockeyMockGroundBox, mockPad: MOCK_LANE_ROW_STEP * 0.15,
        // Reachable only for a code hockey's own catalog does not carry at all (UTIL, this sport's only aside case before it moved onto the ice), clearOfGroundSeats still grows this past whatever the ground actually drew, same as every other sport.
        asideX: RINK_X + RINK_W + 14, asideTop: RINK_Y, asideStep: LANE_COL_STEP,
        // The mock's aside anchor, scaled by the mock scale.
        mockAsideX: MOCK_RINK_X + MOCK_RINK_W + 14 * MOCK_SCALE, mockAsideTop: MOCK_RINK_Y, mockAsideStep: MOCK_LANE_COL_STEP,
    },
    flb: {
        canvasW: PARK_CANVAS_W, canvasH: PARK_CANVAS_H,
        groundSvg: baseballGroundSvg, seatPoints: baseballSeatPoints, asideCodes: BASEBALL_ASIDE_CODES,
        mockGroundBox: baseballMockGroundBox,
        // Hockey's own small pad, for hockey's own reason (see its comment above): the default is a whole card height on every side, which on a ground this size is a third of the box spent on margin and every card shrunk by it.
        mockPad: MOCK_LANE_ROW_STEP * 0.15,
        asideX: PARK_CX + PARK_R_OUT * Math.SQRT1_2 + 11, asideTop: 30, asideStep: LANE_COL_STEP,
        mockAsideX: MOCK_PARK_CX + MOCK_PARK_R_OUT * Math.SQRT1_2 + 11 * MOCK_SCALE_FLB, mockAsideTop: 30 * MOCK_SCALE_FLB, mockAsideStep: MOCK_LANE_COL_STEP,
    },
    ffl: {
        canvasW: FIELD_W + 12, canvasH: FIELD_H + 12,
        groundSvg: footballGroundSvg, seatPoints: footballSeatPoints, asideCodes: FOOTBALL_ASIDE_CODES,
        mockGroundBox: footballMockGroundBox,
        mockPad: MOCK_LANE_ROW_STEP * 0.15,
        // The aside step must clear the seat height or the strip's seats overlap.
        asideX: FIELD_X + 8, asideTop: FIELD_Y + FIELD_H + 26, asideStep: LANE_COL_STEP,
        mockAsideX: MOCK_FIELD_X + 8 * MOCK_SCALE_FFL, mockAsideTop: MOCK_FIELD_Y + MOCK_FIELD_H + 26 * MOCK_SCALE_FFL, mockAsideStep: MOCK_LANE_COL_STEP,
    },
};

// Bench/IR strip codes are sport-agnostic in shape (always "the slots this league marked non-starting"), so the caller marks them the same way regardless of sport: any entry whose slotCode is 'BE', 'IL' or 'IR' renders in the muted strip below the ground rather than on it or beside it, matching the league's own NON_STARTING_SLOTS split (state.js) the caller reads.
const BENCH_STRIP_CODES = new Set(['BE', 'IL', 'IR']);

// Name labels never cut. Every surface reads the full name and fits it with the same three levers at its own geometry. Glyph advance widths were measured once at 76px and scale linearly with font size, so this module needs no canvas.
const NAME_GLYPH_W_AT_76 = {
    a: 42.3, b: 46.4, c: 42.3, d: 46.4, e: 42.3, f: 25.3, g: 46.4, h: 46.4, i: 21.1, j: 21.1,
    k: 42.3, l: 21.1, m: 67.6, n: 46.4, o: 46.4, p: 46.4, q: 46.4, r: 29.6, s: 42.3, t: 25.3,
    u: 46.4, v: 42.3, w: 59.1, x: 42.3, y: 42.3, z: 38,
    A: 54.9, B: 54.9, C: 54.9, D: 54.9, E: 50.7, F: 46.4, G: 59.1, H: 54.9, I: 21.1, J: 42.3,
    K: 54.9, L: 46.4, M: 63.3, N: 54.9, O: 59.1, P: 50.7, Q: 59.1, R: 54.9, S: 50.7, T: 46.4,
    U: 54.9, V: 50.7, W: 71.7, X: 50.7, Y: 50.7, Z: 46.4,
    "'": 18.1, '-': 25.3, '.': 21.1, ' ': 21.1
};
// An unmeasured glyph (a digit, an accent, rare in ESPN names) falls back to a hair above the table's own real-letter median, so an unmeasured character never UNDERESTIMATES enough to cause a real clip, "when in doubt, refuse rather than guess wrong", player-id-map.js's own rule.
const NAME_GLYPH_FALLBACK_AT_76 = 50;

function nameTextWidth(str, fontPx) {
    const scale = fontPx / MOCK_NAME_FONT;
    let w = 0;
    for (const ch of str) w += (NAME_GLYPH_W_AT_76[ch] ?? NAME_GLYPH_FALLBACK_AT_76) * scale;
    return w;
}

// Every space or hyphen is a candidate break. The one chosen leaves the wider half narrowest, and a hyphen stays on the first half ("Lindqvist-" then "Moe"), as a hyphenated word breaks in prose. Returns null for a single unbreakable token, which fitNameLayout steps down instead.
function nameBestSplit(str, fontPx) {
    let best = null, bestMax = Infinity;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch !== ' ' && ch !== '-') continue;
        const first = ch === '-' ? str.slice(0, i + 1) : str.slice(0, i);
        const second = str.slice(i + 1);
        if (!first || !second) continue;
        const m = Math.max(nameTextWidth(first, fontPx), nameTextWidth(second, fontPx));
        if (m < bestMax) { bestMax = m; best = { first, second }; }
    }
    return best;
}

// The three levers in order. One line at full size where it fits, then two lines split at a hyphen or space where the caller allows it, then one line stepped down toward the caller's floor. The surname is taken from the full name once, here.
function fitNameLayout(rawFullName, o) {
    const trimmed = String(rawFullName).trim();
    const name = trimmed.split(/\s+/).pop() || trimmed;
    const full = nameTextWidth(name, o.font);
    if (full <= o.lineW) return { lines: [name], fontSize: o.font };
    if (o.allowSplit) {
        const split = nameBestSplit(name, o.font);
        if (split) return { lines: [split.first, split.second], fontSize: o.font };
    }
    const scale = Math.max(o.floor / o.font, Math.min(1, o.lineW / full));
    return { lines: [name], fontSize: Math.round(o.font * scale) };
}

// The mock card's name layout, 576 units wide at 76px.
function mockNameLayout(rawFullName) {
    return fitNameLayout(rawFullName, { lineW: MOCK_NAME_LINE_W, font: MOCK_NAME_FONT, floor: MOCK_NAME_STEP_FLOOR, allowSplit: true });
}

// The mock bench chip's name layout in real CSS pixels, since the chip is plain HTML and a second line costs it no height.
const BENCH_NAME_LINE_W = 66;
const BENCH_NAME_FONT = 10;
const BENCH_NAME_STEP_FLOOR = 8;
function benchNameLayout(rawFullName) {
    return fitNameLayout(rawFullName, { lineW: BENCH_NAME_LINE_W, font: BENCH_NAME_FONT, floor: BENCH_NAME_STEP_FLOOR, allowSplit: true });
}

// The static ground's named seat has no room for a second line, so it only steps the font down. No caller draws a named static seat today, so its floor is not measured against a picture.
const STATIC_NAME_LINE_W = 34;
const STATIC_NAME_FONT = 6;
const STATIC_NAME_STEP_FLOOR = 5;
function staticNameLayout(rawFullName) {
    return fitNameLayout(rawFullName, { lineW: STATIC_NAME_LINE_W, font: STATIC_NAME_FONT, floor: STATIC_NAME_STEP_FLOOR, allowSplit: false });
}

// A named seat shows its player and an anonymous one shows nothing. Used for the ground and the aside strip, where a family of N draws N positioned seats, so no repeat note is needed.
function namedSeatLabel(fam, i, forSvg) {
    const name = fam.names[i];
    if (!name) return null;
    if (!forSvg) return name;
    const layout = staticNameLayout(name);
    return { text: layout.lines[0], fontSize: layout.fontSize };
}

// The bench strip's OWN idiom (benchStripHtml below): one chip stands for several identical anonymous seats, so THAT chip is the one place a repeat note belongs, "x N" on the family's first (only) chip, never on a second chip beside it (there is no second chip; benchStripHtml skips every anonymous seat past the first for exactly this reason).
function seatSubLabel(fam, i, forSvg) {
    const name = fam.names[i];
    if (name) {
        if (!forSvg) return name;
        const layout = staticNameLayout(name);
        return { text: layout.lines[0], fontSize: layout.fontSize };
    }
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

// The muted bench/IR strip beneath the whole ground, one chip per named seat, and one chip per anonymous family (carrying its own repeat note when it has more than one seat) rather than one blank chip per anonymous seat, a bench slot has no ground position to draw in the first place, so there is no seat shape to fall back on the way an on-ground family's later seats do.
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

// Where the aside column can stand without touching a field seat. It steps clear of the furthest right edge on the ground and never moves left of where the sport put it, so a lineup that fits is drawn as before.
function clearOfGroundSeats(def, onGround, seatW = SEAT_W, asideX = def.asideX) {
    let maxRight = -Infinity;
    onGround.forEach(g => (g.points || []).forEach(pt => {
        if (pt && Number.isFinite(pt.x)) maxRight = Math.max(maxRight, pt.x + seatW / 2);
    }));
    if (!Number.isFinite(maxRight)) return asideX;
    const GAP = 10;
    return Math.max(asideX, maxRight + GAP + seatW / 2);
}

// The viewBox is measured off the emitted seat boxes and only ever grows past the sport's canvas, so no seat is clipped and a lineup that fits is drawn as before.
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

/**
 * Draws the starting lineup ground for one sport, with bench slots as a chip strip beneath it. A
 * sport this module does not know gives an empty valid svg rather than throwing.
 * @param {string} sport 'fhl', 'flb' or 'ffl'
 * @param {SlotSeat[]} slotSeats the slot seat list, in the contract's shape
 * @param {Object} [opts]
 * @param {function(*): string} [opts.escapeHtml] HTML escaper, defaulting to a local one
 * @returns {string} an HTML string, a wrapper div holding the svg and the bench strip
 */
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
    // The aside column starts to the right of whatever the field actually drew, because outfield seats sit on an arc whose reach depends on how many the league starts. The viewBox grows to hold the result.
    const asideX = clearOfGroundSeats(def, onGround);
    const asideHtml = asideStripHtml(def, aside, o, asideX);
    const svg = `<svg class="lg-ground" viewBox="${viewBoxFor(def, groundSeatsHtml + asideHtml)}" xmlns="http://www.w3.org/2000/svg">
        ${def.groundSvg()}
        ${groundSeatsHtml}
        ${asideHtml}
    </svg>`;
    return `<div class="lg-ground-wrap">${svg}${benchStripHtml(bench, o)}</div>`;
}

// The mock ground reuses the sport's pitch and seat placement but draws a different seat, since each mock seat carries its own index and reads as filled, targeted or empty. It is a separate function so the frozen path keeps its behaviour.
function resolveMockOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        pool: o.pool || new Map(),
        targetIndex: (o.targetIndex === null || o.targetIndex === undefined) ? null : Number(o.targetIndex),
        formatValue: o.formatValue || (v => String(v)),
        // The contract's own recorded copy ("pick a receiver", not "pick a WR"), a noun, not the slot code, which this module has no sport vocabulary of its own to supply. Falls back to the bare label so a caller that never passes one still gets a real sentence.
        nounFor: o.nounFor || (label => label),
        // A filled seat shows the player's photo through an injected builder, so this module stays pure. Without it the seat is text only.
        avatarHtml: o.avatarHtml || null,
        // The club pill takes only a name. The caller samples the colour after render, so this module fetches nothing.
        clubOf: o.clubOf || null,
    };
}

// The card is four pieces stacked from the seat's top edge, a position strip then either a silhouette and plus when empty or a photo, name and club pill when filled.
function mockSeatHtml(point, index, seats, o) {
    const s = seats[index];
    const filled = s.playerId !== null && s.playerId !== undefined;
    const targeted = index === o.targetIndex;
    const cls = filled ? 'lg-mseat-filled' : (targeted ? 'lg-mseat-target' : 'lg-mseat-empty');
    const x = point.x, y = point.y;
    const left = x - MOCK_SEAT_W / 2, top = y - MOCK_SEAT_H / 2;

    // ---- The strip, every seat, filled or not, the code is the seat's own identity. ----
    const stripHtml = `
        <rect class="lg-mseat-strip" x="${left}" y="${top}" width="${MOCK_SEAT_W}" height="${MOCK_STRIP_H}" rx="6"></rect>
        <text class="lg-seat-code" x="${x}" y="${top + MOCK_STRIP_H / 2 + 28}" text-anchor="middle">${o.escapeHtml(s.label)}</text>`;

    // The photo fills whatever the fixed pieces leave, so every card uses its height down to one small margin.
    const stackH = MOCK_SEAT_H - MOCK_STRIP_H - MOCK_BOTTOM_MARGIN;
    const photoTop = top + MOCK_STRIP_H + MOCK_AV_GAP;

    let bodyHtml = '', tooltip = '', clubHtml = '', clubAttr = '';
    if (filled) {
        // The caller's pool may key by either the raw id or its string form, tried both rather than mandating one, since the Map's own construction is the caller's business.
        const p = o.pool.get(s.playerId) || o.pool.get(String(s.playerId));
        if (p) {
            tooltip = `${p.name}, ${o.formatValue(p.value)} projected. Click to remove.`;
            // Computed BEFORE the photo, since whether a pill will draw is what decides the photo's own height.
            const club = o.clubOf ? o.clubOf(s.playerId) : null;
            const hasPill = !!(club && club.name);
            // The full name goes to the layout, which extracts the surname itself. A two line name reserves extra height and the photo shrinks by the same amount, so the card footprint never moves.
            const nameLayout = mockNameLayout(p.name);
            const nameExtra = nameLayout.lines.length > 1 ? MOCK_NAME_LINE_GAP : 0;
            const av = hasPill
                ? stackH - MOCK_AV_GAP * 2 - MOCK_NAME_H - nameExtra - MOCK_PILL_GAP - MOCK_PILL_H
                : stackH - MOCK_AV_GAP * 2 - MOCK_NAME_H - nameExtra;
            const photoBottom = photoTop + av;
            const nameY = photoBottom + MOCK_AV_GAP + MOCK_NAME_H * 0.7;
            const nameLastY = nameLayout.lines.length > 1 ? nameY + MOCK_NAME_LINE_GAP : nameY;
            const photoHtml = o.avatarHtml
                ? `<foreignObject x="${x - av / 2}" y="${photoTop}" width="${av}" height="${av}" class="lg-mseat-avatar">
                    <div xmlns="http://www.w3.org/1999/xhtml" class="lg-mseat-avatar-body">${o.avatarHtml(s.playerId, p.name)}</div>
                </foreignObject>`
                : '';
            const nameStyleAttr = nameLayout.fontSize !== MOCK_NAME_FONT ? ` style="font-size:${nameLayout.fontSize}px"` : '';
            const nameHtml = nameLayout.lines.length > 1
                ? `<text class="lg-mseat-line2" x="${x}" y="${nameY}" text-anchor="middle"${nameStyleAttr}><tspan x="${x}" y="${nameY}">${o.escapeHtml(nameLayout.lines[0])}</tspan><tspan x="${x}" y="${nameLastY}">${o.escapeHtml(nameLayout.lines[1])}</tspan></text>`
                : `<text class="lg-mseat-line2" x="${x}" y="${nameY}" text-anchor="middle"${nameStyleAttr}>${o.escapeHtml(nameLayout.lines[0])}</text>`;
            // No avatarHtml wired: the contract's own fallback, the figure prints as a plain line under the name rather than vanishing, the only reader of this branch today is the fixture/tests, since every live caller wires a photo, but the fallback still has to hold its own promise.
            const valueY = nameLastY + MOCK_NAME_H * 0.9;
            const valueHtml = !o.avatarHtml
                ? `<text class="lg-mseat-line3" x="${x}" y="${valueY}" text-anchor="middle">${o.escapeHtml(o.formatValue(p.value))}</text>`
                : '';
            // The club pill and the colour edge (below, on.lg-mseat-filled itself), "where it exists" per the brief: clubOf is optional and a club with no name prints neither.
            if (hasPill) {
                const pillTop = (o.avatarHtml ? nameLastY : valueY) + MOCK_PILL_GAP;
                const pillW = MOCK_SEAT_W - 80;
                clubHtml = `
                    <rect class="lg-mseat-pill" x="${x - pillW / 2}" y="${pillTop}" width="${pillW}" height="${MOCK_PILL_H}" rx="${MOCK_PILL_H / 2}"></rect>
                    <text class="lg-mseat-pill-text" x="${x}" y="${pillTop + MOCK_PILL_H / 2 + 16}" text-anchor="middle">${o.escapeHtml(club.name)}</text>`;
                // Read by graphs.js's own async dye step after render (history-view.js's dyeChampionFlags pattern), this module never fetches the logo itself.
                clubAttr = ` data-club="${o.escapeHtml(club.name)}"`;
            }
            bodyHtml = photoHtml + nameHtml + valueHtml + clubHtml;
        }
    } else {
        // EMPTY (and TARGETED, which is an empty seat armed to receive the next click), a silhouette where the photo would sit, plain SVG shapes rather than a foreignObject (nothing here is real content, so there is nothing an HTML layout buys). Never a pill (nobody is seated to have a club), so it reads the SAME "no pill" height the filled- without-a-club branch above does, one formula, not two, for the two cases that agree.
        const av = stackH - MOCK_AV_GAP * 2 - MOCK_NAME_H;
        const photoBottom = photoTop + av;
        const headR = av * 0.16, headCy = photoTop + av * 0.32;
        const shR = av * 0.34;
        const silhouetteHtml = `
            <circle class="lg-mseat-silhouette" cx="${x}" cy="${headCy}" r="${headR}"></circle>
            <path class="lg-mseat-silhouette" d="M ${x - shR} ${photoBottom} C ${x - shR} ${headCy + headR * 1.6}, ${x - shR * 0.6} ${headCy + headR * 1.3}, ${x} ${headCy + headR * 1.3} C ${x + shR * 0.6} ${headCy + headR * 1.3}, ${x + shR} ${headCy + headR * 1.6}, ${x + shR} ${photoBottom} Z"></path>
            <circle class="lg-mseat-plus-ring" cx="${x + av * 0.32}" cy="${photoBottom - av * 0.12}" r="${av * 0.14}"></circle>
            <text class="lg-mseat-plus-glyph" x="${x + av * 0.32}" y="${photoBottom - av * 0.12}" text-anchor="middle" dominant-baseline="central">+</text>`;
        const labelY = photoBottom + MOCK_AV_GAP + MOCK_NAME_H * 0.7;
        if (targeted) {
            bodyHtml = `${silhouetteHtml}<text class="lg-mseat-line2" x="${x}" y="${labelY}" text-anchor="middle">pick a ${o.escapeHtml(o.nounFor(s.label))}</text>`;
            tooltip = `Pick a ${o.nounFor(s.label)} from the Projections list.`;
        } else {
            bodyHtml = `${silhouetteHtml}<text class="lg-mseat-line2" x="${x}" y="${labelY}" text-anchor="middle">add a ${o.escapeHtml(o.nounFor(s.label))}</text>`;
            tooltip = 'Empty seat';
        }
    }

    const ringHtml = targeted
        ? `<rect class="lg-mseat-ring" x="${left - 3}" y="${top - 3}" width="${MOCK_SEAT_W + 6}" height="${MOCK_SEAT_H + 6}" rx="10"></rect>`
        : '';
    // The x, its own click target (data-seat-remove), separate from the seat's own data-seat-index click (which targets it, same as any empty seat), a filled seat still needs to be re-targetable to swap its occupant without clearing it first. The circle is the click target too (both live inside one <g data-seat-remove>), not a bare glyph nobody could see.
    const removeX = x + MOCK_SEAT_W / 2 - 14, removeY = top + 14;
    const removeHtml = filled
        ? `<g class="lg-mseat-remove" data-seat-remove="${index}">
            <circle cx="${removeX}" cy="${removeY}" r="14"></circle>
            <text x="${removeX}" y="${removeY}" text-anchor="middle" dominant-baseline="central">&#215;</text>
        </g>`
        : '';
    const tipAttr = tooltip ? ` data-tooltip="${o.escapeHtml(tooltip)}"` : '';
    // The club-colour edge, a thin bar down the card's own left side, filled from --card-dye (set by graphs.js's async sampleLogoColour step, the same pattern history-view.js's dyeChampionFlags already uses) with the plain accent as its fallback before that lands, so the card never shows a blank bar while the sample is still in flight.
    const edgeHtml = clubHtml
        ? `<rect class="lg-mseat-edge" x="${left}" y="${top}" width="7" height="${MOCK_SEAT_H}" rx="3.5"></rect>`
        : '';
    return `<g class="lg-mseat ${cls}" data-seat-index="${index}"${tipAttr}${clubAttr}>
        ${ringHtml}
        <rect class="lg-seat-box" x="${left}" y="${top}" width="${MOCK_SEAT_W}" height="${MOCK_SEAT_H}" rx="10"></rect>
        ${edgeHtml}
        ${stripHtml}
        ${bodyHtml}
        ${removeHtml}
    </g>`;
}

// The bench is a row of interactive seat outlines under the field. They carry the same data attributes as the SVG seats, so the click and drag wiring reaches them. BE is the bench and any other non-starting label is the injury seat.
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
            // The bench chip uses the same three lever fit as the card, in real pixels.
            const nameLayout = benchNameLayout(p.name);
            const nameStyleAttr = nameLayout.fontSize !== BENCH_NAME_FONT ? ` style="font-size:${nameLayout.fontSize}px"` : '';
            const nameHtml = nameLayout.lines.length > 1
                ? `<span class="lg-bseat-name"${nameStyleAttr}>${o.escapeHtml(nameLayout.lines[0])}<br>${o.escapeHtml(nameLayout.lines[1])}</span>`
                : `<span class="lg-bseat-name"${nameStyleAttr}>${o.escapeHtml(nameLayout.lines[0])}</span>`;
            bodyHtml = `${nameHtml} <span class="lg-bseat-figure">${o.escapeHtml(o.formatValue(p.value))}</span>`;
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

/**
 * Draws the mock lineup ground, one interactive card per starter on the sport's pitch and a row of
 * bench seats beneath it. Seats are addressed by their index in the model's one seats array.
 * @param {string} sport 'fhl', 'flb' or 'ffl'; any other value gives an empty valid svg
 * @param {MockSeat[]} seats the mock lineup model's seats, starters and bench together
 * @param {Object} [opts]
 * @param {Map} [opts.pool] player id to an object with name and value, the value the projections list prints
 * @param {number|null} [opts.targetIndex] the one seat armed to receive the next pick, or null
 * @param {function(*): string} [opts.escapeHtml] HTML escaper
 * @param {function(*): string} [opts.formatValue] formats a projected value for display
 * @param {function(string): string} [opts.nounFor] the noun printed for a slot label, such as "receiver"
 * @param {function(*, string): string} [opts.avatarHtml] builds the photo markup for a player id and name
 * @param {function(*): ({name: string}|null)} [opts.clubOf] the club name printed on a filled card
 * @returns {string} an HTML string, a wrapper div holding the svg and the bench row
 */
export function buildMockLineupGroundHtml(sport, seats, opts) {
    const o = resolveMockOpts(opts);
    const def = SPORTS[sport];
    if (!def || !seats || !seats.length) return '<svg viewBox="0 0 1 1" class="lg-ground"></svg>';

    // SPLIT ONCE, indices kept as positions into the ORIGINAL `seats` array throughout, seat()/ unseat() address by that global index, so a bench entry's own index must stay what it was before the split, never renumbered to its position within just the bench.
    const starterIndices = [];
    const benchEntries = [];
    seats.forEach((s, i) => (s.bench ? benchEntries : starterIndices).push(s.bench ? { seat: s, index: i } : i));
    if (!starterIndices.length) return '<svg viewBox="0 0 1 1" class="lg-ground"></svg>';

    // A grouping keyed by the seat's display LABEL (what every seatPoints table switches on), scoped to starters only, a bench label ("BE", "IL", "IR") never collides with a real position code, but excluding it here rather than relying on that non-collision keeps this function's own contract explicit rather than incidental.
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
        // The mock flag selects the mock canvas and steps.
        const points = def.seatPoints(fam.code, fam.indices.length, true);
        if (!points) { aside.push(fam); return; }
        onGround.push({ points: mockShiftPoints(sport, points), fam });
    });

    const groundSeatsHtml = onGround
        .map(g => g.points.map((p, i) => mockSeatHtml(p, g.fam.indices[i], seats, o)).join(''))
        .join('');
    const asideX = clearOfGroundSeats(def, onGround, MOCK_SEAT_W, def.mockAsideX);
    let y = def.mockAsideTop;
    const asideHtml = aside.map(fam => fam.indices.map(i => {
        const html = mockSeatHtml({ x: asideX, y }, i, seats, o);
        y += def.mockAsideStep;
        return html;
    }).join('')).join('');

    // The mock pads its own viewBox by one seat height so a seat near the boundary has room for its text. The real ground's box is untouched.
    let [vx, vy, vw, vh] = viewBoxFor(def, groundSeatsHtml + asideHtml).split(' ').map(Number);
    // The ground drawing's bounds are unioned in with the seats, so boards or fence that reach past any seat are not clipped.
    if (def.mockGroundBox) {
        const gb = def.mockGroundBox();
        const right = Math.max(vx + vw, gb.x + gb.w), bottom = Math.max(vy + vh, gb.y + gb.h);
        vx = Math.min(vx, gb.x); vy = Math.min(vy, gb.y);
        vw = right - vx; vh = bottom - vy;
    }
    // Hockey uses a smaller pad and baseball and football keep a card height. The column rink keeps its seats and boards inside its drawn extent, so the larger margin was waste.
    const pad = def.mockPad || MOCK_SEAT_H;
    const viewBox = `${vx - pad} ${vy - pad} ${vw + pad * 2} ${vh + pad * 2}`;

    const svg = `<svg class="lg-ground" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
        ${centeredScrimmageSvg(sport, def.groundSvg(true))}
        ${groundSeatsHtml}
        ${asideHtml}
    </svg>`;

    return `<div class="lg-ground-wrap">${svg}${mockBenchRowHtml(benchEntries, o)}</div>`;
}
