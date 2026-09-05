// PURE. THE MOCK LINEUP: put projected players in the starting lineup's seats before a draft and see what the team would look like. No DOM, no AppState, no fetches, no storage - every table arrives as an argument, the rule rank-engine.js, coverage-model.js and team-compare.js follow. The frozen shape is tests/fixtures/mock-lineup.md (v2, bench seats added by R1), and frame E of the mockup page is the acceptance standard for the starters, frame H for the bench. NOTHING IS SAVED TO ESPN and nothing is persisted beyond AppState, which is the caller's business rather than this module's. A mock lineup is a sketch for draft day, and a sketch that wrote itself back to a league would be a different and much more alarming feature. THE FIGURE IS THE CALLER'S, NEVER A SECOND PROJECTION. Every total here is the sum of the number the Projections card itself prints for a player. Computing a projection here would be a second reading of the same question, free to disagree with the card sitting beside it - the same rule that keeps the draft board and the leaderboard on one scorer.

// The seats a league actually starts, in the order the ground draws them. BUILT FROM THE LEAGUE'S OWN SLOTS rather than a list kept here: the slot order, the labels, the non-starting set and the per-slot counts all arrive as arguments, so the ground and this model cannot disagree about how many seats exist. A slot with a count of zero contributes nothing; a count of two contributes TWO SEATS, because the mockup fills one running-back seat and leaves the other empty and the two have to be separately addressable.
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
    // THE BENCH, APPENDED, AND NOT READ OFF `order` - because the non-starting ids are not IN the order array. Football's order is [0, 2, 4, 6, 23, 16, 17] and its bench slots are 20 and 21, so walking `order` for them would find nothing and the bench would silently be empty. ASCENDING SLOT ID is the same convention nonStartingLabels uses to decide which of the two non-starting slots is the bench and which the injury one, and its labels arrive here rather than being inferred a second time - two functions guessing separately is how a seat ends up labelled BE on one surface and IR on another.
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

export function emptyState(seats) {
    return { seats: (seats || []).map(s => ({ ...s, playerId: null })) };
}

// WHETHER A PLAYER CAN HOLD A SEAT. A named slot wants its own label among the player's positions; a flex slot wants any of the positions its own entry lists (FLEX_SLOT_POSITIONS, state.js), which arrives in ctx because this module has no position knowledge of its own and should not grow any.
export function canSeat(player, seat, ctx = {}) {
    if (!player || !seat) return false;
    // A BENCH SEAT TAKES ANY PLAYER, tested first. ESPN's own bench and injury slots accept every player in the pool - the signature NON_STARTING_SLOTS exists to capture - so a kicker may sit on the IR seat and nothing about positions needs asking.
    if (seat.bench) return true;
    const positions = player.eligiblePositions || [];
    const flex = (ctx.flexPositions || {})[seat.slotId];
    if (flex) return positions.some(p => flex.has(p));
    return positions.includes(seat.label);
}

const findPlayer = (pool, playerId) =>
    (pool || []).find(p => p && String(p.id) === String(playerId)) || null;

// SEAT ONE PLAYER, or return the state UNCHANGED. A refusal is not an error: clicking a seat a player cannot fill is a normal thing for a person to do, and the surface's answer is that nothing happens. Throwing would turn a misclick into a broken tab. TWO THINGS HAPPEN AT ONCE and both are deliberate. Seating a player who already holds another seat MOVES them - the old seat empties in the same call, because one player holding two seats would score one projection twice. And seating into an OCCUPIED seat replaces whoever was there; there is no swap and no queue, because "click a seat, then a row" twice means the reader changed their mind.
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

export function unseat(state, seatIndex) {
    if (!state || !Array.isArray(state.seats)) return state;
    const i = Number(seatIndex);
    if (!Number.isInteger(i) || i < 0 || i >= state.seats.length) return state;
    return { ...state, seats: state.seats.map((s, k) => (k === i ? { ...s, playerId: null } : s)) };
}

export function clear(state) {
    if (!state || !Array.isArray(state.seats)) return state;
    return { ...state, seats: state.seats.map(s => ({ ...s, playerId: null })) };
}

const valueOf = (p) => {
    const v = Number(p && p.value);
    return Number.isFinite(v) ? v : 0;
};

// THE BEST THIS LEAGUE'S SEATS COULD HOLD - the "if every seat matched its best pick" figure. FIXED SEATS BEFORE FLEX, and that ordering is the whole correctness of it. Filling a flex seat first with the best player left can take a running back that a narrower RB seat needed, leaving the pair worse off than filling RB first. Doing the named seats in ground order and the flex seats last is the order that cannot cannibalise a narrower seat. GREEDY, AND SO AN APPROXIMATION RATHER THAN AN OPTIMUM. With several flex slots whose position sets overlap, the true best assignment is a matching problem; this takes the best available at each seat in turn. It is said out loud here and in the contract, and the surface labels the figure as a comparison ("if every seat matched its best pick") rather than as a promise. IT IGNORES WHAT IS CURRENTLY SEATED, deliberately: it is the fixed bar the total is measured against, so it must not move as the reader fills seats.
export function ceilingFor(seats, pool, ctx = {}) {
    const taken = new Set();
    const byIndex = new Map();
    const fill = (wantFlex) => {
        (seats || []).forEach((s, i) => {
            // THE BENCH IS NOT PART OF THE CEILING, and this is the line that matters most in the amendment. A bench seat accepts anyone, so a ceiling that filled eight of them would hand the best players left to seats that score nothing - and take them from the starting seats the ceiling exists to measure. The bar would drop as the bench grew.
            if (s.bench) return;
            const isFlex = !!(ctx.flexPositions || {})[s.slotId];
            if (isFlex !== wantFlex) return;
            let best = null;
            (pool || []).forEach(p => {
                if (!p || taken.has(String(p.id))) return;
                if (!canSeat(p, s, ctx)) return;
                if (!best || valueOf(p) > valueOf(best)) best = p;
            });
            if (best) { taken.add(String(best.id)); byIndex.set(i, valueOf(best)); }
        });
    };
    fill(false);
    fill(true);
    return byIndex;
}

// WHERE A TOTAL WOULD HAVE FINISHED LAST SEASON, against lastSeasonCard's own standings[].points. NULL WHERE THE LEAGUE KEEPS NO POINTS, and the surface then shows no cell at all rather than a dash. Measured: a points league and roto both keep a real standing, while head-to-head categories reports 0 on every team - and placing a projected points total against a column of zeros would rank every mock team first.
export function placeAmong(total, standings) {
    const points = (standings || [])
        .map(r => (r && r.points === null || r === undefined ? null : Number(r.points)))
        .filter(v => Number.isFinite(v));
    if (points.length !== (standings || []).length || !points.length) return null;
    if (!points.some(v => v !== 0)) return null;
    const t = Number(total);
    if (!Number.isFinite(t)) return null;
    // Competition placing: a total equal to a finisher's shares that place rather than being pushed below it, the same convention categoryRanks already uses.
    const better = points.filter(v => v > t).length;
    return { place: better + 1, of: points.length };
}

export function summary(state, pool, lastSeason, ctx = {}) {
    if (!state || !Array.isArray(state.seats) || !state.seats.length) return null;
    const seats = state.seats;
    // NO STARTING SEATS IS STILL NULL, even when a bench exists. The card summarises a lineup, and a league with nothing but bench slots has no lineup to summarise - returning a card of zeros with a bench count beside it would be a box with a heading, which is exactly what this refusal was written to avoid. The bench alone is not a team.
    if (!seats.some(s => !s.bench)) return null;
    const ceilingByIndex = ceilingFor(seats, pool, ctx);

    let total = 0;
    let filled = 0;
    let of = 0;
    let benchFilled = 0;
    let benchOf = 0;
    // One row per DISTINCT slot, kept in the order the seats arrived, which is the ground's order.
    const rows = new Map();
    seats.forEach((s, i) => {
        // THE BENCH IS COUNTED AND NOTHING ELSE. A benched player SCORES NOTHING, so folding one into `total` would inflate every mock team by whatever it stashed; and byPosition is the per-slot breakdown of that same total, so a BE row there would be a row of zeros pretending to be a position. Two counts, answering two questions.
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
        const v = valueOf(p);
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
        // STARTING SEATS, not seats.length - the bench is in the same array and would otherwise be counted into the "N of 9" the header prints.
        of,
        benchFilled,
        benchOf,
        ceiling,
        place: placeAmong(total, lastSeason && lastSeason.standings),
        byPosition: [...rows.values()]
    };
}
