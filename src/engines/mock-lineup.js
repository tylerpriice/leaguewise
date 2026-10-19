/**
 * The mock lineup: projected players placed on a lineup's seats before a draft, with the total
 * they come to, the best the seats could hold, and where that total would have placed last season.
 *
 * Pure. No DOM, no application state, no network and no storage; every table arrives as an
 * argument. Nothing is written back to ESPN. Every total is a sum of the figure the caller already
 * shows for a player, never a second projection.
 *
 * Contract: tests/fixtures/mock-lineup.md
 * Tests: tests/mock-lineup.test.html
 * @module mock-lineup
 */
/**
 * One seat of a lineup.
 *
 * @typedef {object} Seat
 * @property {number} slotId The lineup slot the seat belongs to.
 * @property {string} label The slot's label.
 * @property {?(number|string)} playerId The player seated, or null.
 * @property {boolean} bench Whether the seat is a bench or injury seat, which takes any player and scores nothing.
 */
/**
 * A mock lineup at one moment. Every operation returns a new state.
 *
 * @typedef {object} LineupState
 * @property {Seat[]} seats The seats, starters first and then the bench.
 */
/**
 * What the seating rules read beyond the player and the seat.
 *
 * @typedef {object} SeatContext
 * @property {Object<number, Set<string>>} [flexPositions] The positions each flex slot accepts.
 * @property {boolean} [isPointsLeague] Whether totals add a player's score in place of the player's value.
 */

/**
 * The seats a league fields, starters in lineup order and then the bench. A slot with a count of
 * two gives two seats, each addressable on its own.
 *
 * @param {object} [args]
 * @param {number[]} [args.order] The slot ids in the order a lineup reads.
 * @param {Object<number, string>} [args.labels] The slot labels.
 * @param {Object<number, number>} [args.counts] How many of each slot the league fields.
 * @param {Set<number>} [args.nonStarting] The bench and injury slot ids.
 * @param {Object<number, string>} [args.benchLabels] Labels for the non-starting slots.
 * @returns {Seat[]} The seats, all empty.
 */
export function seatsFor({
    order = [], labels = {}, counts = {}, nonStarting = new Set(), benchLabels = {}
} = {}) {
    const seats = [];
    (order || []).forEach(slotId => {
        if (nonStarting && nonStarting.has(slotId)) return;
        const n = Number((counts || {})[slotId]) || 0;
        for (let i = 0; i < n; i++) {
            seats.push({ slotId, label: (labels || {})[slotId] || String(slotId), playerId: null, bench: false });
        }
    });
    // The bench is appended and is not read off the order, since the non-starting slot ids are not in the order. It goes in ascending slot id, and its labels arrive from the caller, so one seat is not named two ways.
    [...(nonStarting || new Set())].sort((a, b) => a - b).forEach(slotId => {
        const n = Number((counts || {})[slotId]) || 0;
        for (let i = 0; i < n; i++) {
            seats.push({
                slotId,
                label: (benchLabels || {})[slotId] || (labels || {})[slotId] || String(slotId),
                playerId: null,
                bench: true
            });
        }
    });
    return seats;
}

/**
 * Starts a mock lineup on a set of seats.
 *
 * @param {Seat[]} seats The seats.
 * @returns {LineupState} A state with every seat empty.
 */
export function emptyState(seats) {
    return { seats: (seats || []).map(s => ({ ...s, playerId: null })) };
}

/**
 * Whether a player can hold a seat. A bench seat takes anyone. A flex seat takes any of the
 * positions its slot accepts. Any other seat wants its own label among the player's positions.
 *
 * @param {{eligiblePositions: string[]}} player The player.
 * @param {Seat} seat The seat.
 * @param {SeatContext} [ctx] The flex positions.
 * @returns {boolean} True when the player can sit there.
 */
export function canSeat(player, seat, ctx = {}) {
    if (!player || !seat) return false;
    // A bench seat takes any player, and is tested first.
    if (seat.bench) return true;
    const positions = player.eligiblePositions || [];
    const flex = (ctx.flexPositions || {})[seat.slotId];
    if (flex) return positions.some(p => flex.has(p));
    return positions.includes(seat.label);
}

const findPlayer = (pool, playerId) =>
    (pool || []).find(p => p && String(p.id) === String(playerId)) || null;

/**
 * Seats one player, or returns the same state when the player cannot hold the seat. A refusal is
 * not an error; the caller tests for it by identity.
 *
 * A player who already holds another seat is moved, so no player is counted twice. Seating into an
 * occupied seat replaces whoever was there.
 *
 * @param {LineupState} state The lineup.
 * @param {number|string} playerId The player.
 * @param {number} seatIndex The seat's index.
 * @param {object[]} pool The players, each with an id and eligible positions.
 * @param {SeatContext} [ctx] The flex positions.
 * @returns {LineupState} A new state, or the same object when refused.
 */
export function seat(state, playerId, seatIndex, pool, ctx = {}) {
    if (!state || !Array.isArray(state.seats)) return state;
    const i = Number(seatIndex);
    if (!Number.isInteger(i) || i < 0 || i >= state.seats.length) return state;
    const player = findPlayer(pool, playerId);
    if (!player) return state;
    if (!canSeat(player, state.seats[i], ctx)) return state;
    const id = player.id;
    return {
        ...state,
        seats: state.seats.map((s, k) => {
            if (k === i) return { ...s, playerId: id };
            // The move: wherever else this player sat, that seat is now empty.
            if (String(s.playerId) === String(id)) return { ...s, playerId: null };
            return s;
        })
    };
}

/**
 * Empties one seat.
 *
 * @param {LineupState} state The lineup.
 * @param {number} seatIndex The seat's index.
 * @returns {LineupState} A new state, or the same object for an index that is not a seat.
 */
export function unseat(state, seatIndex) {
    if (!state || !Array.isArray(state.seats)) return state;
    const i = Number(seatIndex);
    if (!Number.isInteger(i) || i < 0 || i >= state.seats.length) return state;
    return { ...state, seats: state.seats.map((s, k) => (k === i ? { ...s, playerId: null } : s)) };
}

/**
 * Empties every seat.
 *
 * @param {LineupState} state The lineup.
 * @returns {LineupState} A new state.
 */
export function clear(state) {
    if (!state || !Array.isArray(state.seats)) return state;
    return { ...state, seats: state.seats.map(s => ({ ...s, playerId: null })) };
}

const valueOf = (p) => {
    const v = Number(p && p.value);
    return Number.isFinite(v) ? v : 0;
};

// A total is a sum of printed figures. In a points league the printed figure is the player's score, not the value players are ranked by. Ranking for the ceiling stays on the value.
const printedValue = (p, ctx = {}) => {
    if (ctx && ctx.isPointsLeague && p && p.score !== null && p.score !== undefined) {
        const v = Number(p.score);
        return Number.isFinite(v) ? v : 0;
    }
    return valueOf(p);
};

/**
 * The best the starting seats could hold: each seat's best available player, with the named seats
 * filled before the flex seats so a flex seat cannot take a player a narrower seat needed.
 *
 * It takes the best available at each seat in turn, so where flex seats overlap it is an
 * approximation and not the true optimum. It ignores who is seated, since it is the fixed bar a
 * total is measured against.
 *
 * @param {Seat[]} seats The seats.
 * @param {object[]} pool The players.
 * @param {SeatContext} [ctx] The flex positions and the league's scoring.
 * @returns {Map<number, number>} The best figure by seat index. Bench seats are absent.
 */
export function ceilingFor(seats, pool, ctx = {}) {
    const taken = new Set();
    const byIndex = new Map();
    const fill = (wantFlex) => {
        (seats || []).forEach((s, i) => {
            // The bench is not part of the ceiling. A bench seat accepts anyone, so filling it would take the best players left from the starting seats the ceiling measures.
            if (s.bench) return;
            const isFlex = !!(ctx.flexPositions || {})[s.slotId];
            if (isFlex !== wantFlex) return;
            let best = null;
            (pool || []).forEach(p => {
                if (!p || taken.has(String(p.id))) return;
                if (!canSeat(p, s, ctx)) return;
                if (!best || valueOf(p) > valueOf(best)) best = p;
            });
            if (best) { taken.add(String(best.id)); byIndex.set(i, printedValue(best, ctx)); }
        });
    };
    fill(false);
    fill(true);
    return byIndex;
}

/**
 * Where a total would have finished last season, against last season's points. A total equal to
 * a finisher's shares that place.
 *
 * @param {number} total The total.
 * @param {Array<{points: ?number}>} standings Last season's standings.
 * @returns {?{place: number, of: number}} Null where the league keeps no points: a missing figure on any team, or zero on every team.
 */
export function placeAmong(total, standings) {
    const points = (standings || [])
        .map(r => (r && r.points === null || r === undefined ? null : Number(r.points)))
        .filter(v => Number.isFinite(v));
    if (points.length !== (standings || []).length || !points.length) return null;
    if (!points.some(v => v !== 0)) return null;
    const t = Number(total);
    if (!Number.isFinite(t)) return null;
    // Competition placing: a total equal to a finisher's shares that place.
    const better = points.filter(v => v > t).length;
    return { place: better + 1, of: points.length };
}

/**
 * Summarises a mock lineup: its total, how many starting seats are filled, the bench count, the
 * ceiling, the place the total would have taken last season, and a row per slot.
 *
 * @param {LineupState} state The lineup.
 * @param {object[]} pool The players.
 * @param {?{standings: object[]}} lastSeason Last season's card, for the place.
 * @param {SeatContext} [ctx] The flex positions and the league's scoring.
 * @returns {?{total: number, filled: number, of: number, benchFilled: number, benchOf: number, ceiling: number, place: ?object, byPosition: Array<{label: string, filled: number, total: number, ceiling: number}>}}
 *   Null for a lineup with no starting seat.
 */
export function summary(state, pool, lastSeason, ctx = {}) {
    if (!state || !Array.isArray(state.seats) || !state.seats.length) return null;
    const seats = state.seats;
    // No starting seats is still null, even with a bench. A bench alone is not a lineup to summarise.
    if (!seats.some(s => !s.bench)) return null;
    const ceilingByIndex = ceilingFor(seats, pool, ctx);

    let total = 0;
    let filled = 0;
    let of = 0;
    let benchFilled = 0;
    let benchOf = 0;
    // One row per distinct slot, in the order the seats arrived.
    const rows = new Map();
    seats.forEach((s, i) => {
        // The bench is counted and nothing else. A benched player scores nothing, so none is added to the total or to the rows per position.
        if (s.bench) {
            benchOf += 1;
            if (s.playerId !== null && s.playerId !== undefined && findPlayer(pool, s.playerId)) {
                benchFilled += 1;
            }
            return;
        }
        of += 1;
        if (!rows.has(s.slotId)) rows.set(s.slotId, { label: s.label, filled: 0, total: 0, ceiling: 0 });
        const row = rows.get(s.slotId);
        row.ceiling += ceilingByIndex.get(i) || 0;
        if (s.playerId === null || s.playerId === undefined) return;
        const p = findPlayer(pool, s.playerId);
        if (!p) return;
        const v = printedValue(p, ctx);
        total += v;
        filled += 1;
        row.filled += 1;
        row.total += v;
    });

    let ceiling = 0;
    ceilingByIndex.forEach(v => { ceiling += v; });

    return {
        total,
        filled,
        // Starting seats only. The bench is in the same list and is counted apart.
        of,
        benchFilled,
        benchOf,
        ceiling,
        place: placeAmong(total, lastSeason && lastSeason.standings),
        byPosition: [...rows.values()]
    };
}
