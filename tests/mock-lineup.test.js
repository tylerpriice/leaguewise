// Unit tests for the pure mock lineup (mock-lineup.js, R6). Open tests/mock-lineup.test.html through any static server - green means every assertion held. THE FIXTURE IS FRAME E'S OWN LEAGUE AND ITS OWN NUMBERS, so a test that passes here is a test that agrees with the acceptance standard rather than with an invented example. Nine seats, four filled, and the card's three figures are 572.7, "#6 of 11" and 1,288.
import {
    seatsFor, emptyState, canSeat, seat, unseat, clear, ceilingFor, placeAmong, summary
} from '../mock-lineup.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function assertClose(actual, expected, tol, msg) {
    if (actual === null || !(Math.abs(actual - expected) <= tol)) {
        throw new Error(`${msg}: got ${actual}, expected ${expected} +-${tol}`);
    }
}

// Football's real tables, copied from state.js rather than invented - the order, the labels, the bench pair and the flex positions are the league's own answer, not this file's.
const ORDER = [0, 2, 4, 6, 23, 16, 17];
const LABELS = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX' };
const NON_STARTING = new Set([20, 21]);
// nonStartingLabels('ffl') answers BE for 20 and IR for 21 - copied here rather than imported, like every other table in this file, so the suite states the league's answer rather than deriving it a second time.
const BENCH_LABELS = { 20: 'BE', 21: 'IR' };
const FLEX_POS = { 23: new Set(['RB', 'TE', 'WR']) };
const CTX = { flexPositions: FLEX_POS };
// Frame E's league: one QB, two RB, two WR, one TE, one FLEX, one D/ST, one K, and seven bench.
const COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 7, 21: 1 };

const P = (id, name, pos, value) => ({ id, name, eligiblePositions: [pos], value });
// Frame E's Projections list, in its own order and with its own figures.
const POOL = [
    P(1, 'Josh Allen', 'QB', 163.7),
    P(2, 'Jahmyr Gibbs', 'RB', 158.8),
    P(3, 'Puka Nacua', 'WR', 146.8),
    P(4, 'Bijan Robinson', 'RB', 146.0),
    P(5, 'Christian McCaffrey', 'RB', 135.1),
    P(6, "Ja'Marr Chase", 'WR', 130.1),
    P(7, 'Jaxon Smith-Njigba', 'WR', 119.8),
    P(8, 'Amon-Ra St. Brown', 'WR', 117.6),
    P(9, 'Lamar Jackson', 'QB', 115.7),
    P(10, 'Drake Maye', 'QB', 113.3),
    P(11, 'Jalen Hurts', 'QB', 113.0),
    P(12, 'Trey McBride', 'TE', 104.2)
];
const SEATS = seatsFor({ order: ORDER, labels: LABELS, counts: COUNTS, nonStarting: NON_STARTING, benchLabels: BENCH_LABELS });
const idx = (label, n = 0) => SEATS.map((s, i) => ({ s, i })).filter(x => x.s.label === label)[n].i;

// Frame E's own arrangement: Allen at QB, Gibbs and Robinson at the two RB seats, McBride at TE.
const FRAME_E = [[1, idx('QB')], [2, idx('RB', 0)], [4, idx('RB', 1)], [12, idx('TE')]]
    .reduce((st, [pid, i]) => seat(st, pid, i, POOL, CTX), emptyState(SEATS));

// ==== The seats ====

test('the seats are the league\'s own, starters then bench, counts repeated', () => {
    assertEq(SEATS.filter(s => !s.bench).length, 9, 'nine seats, which is what frame E\'s bench row says');
    assertEq(SEATS.filter(s => !s.bench).map(s => s.label).join(), 'QB,RB,RB,WR,WR,TE,FLEX,D/ST,K', 'in ground order');
    assert(!SEATS.filter(s => !s.bench).some(s => s.label === 'BE' || s.label === 'IR'), 'no bench seat among the starters');
});

test('a slot with a count of zero contributes no seat at all', () => {
    const s = seatsFor({ order: ORDER, labels: LABELS, nonStarting: NON_STARTING, counts: { 0: 1, 2: 0 } });
    assertEq(s.map(x => x.label).join(), 'QB', 'only the slot the league actually starts');
});

// ==== Eligibility ====

test('a named seat takes its own position and refuses another', () => {
    assertEq(canSeat(POOL[0], SEATS[idx('QB')], CTX), true, 'a quarterback into QB');
    assertEq(canSeat(POOL[0], SEATS[idx('WR')], CTX), false, 'and not into WR');
});

test('FLEX takes RB, WR and TE, and refuses a quarterback', () => {
    const f = SEATS[idx('FLEX')];
    assertEq(canSeat(P(90, 'Back', 'RB', 1), f, CTX), true, 'RB');
    assertEq(canSeat(P(91, 'Wide', 'WR', 1), f, CTX), true, 'WR');
    assertEq(canSeat(P(92, 'Tight', 'TE', 1), f, CTX), true, 'TE');
    assertEq(canSeat(P(93, 'Passer', 'QB', 1), f, CTX), false, 'never a QB - football 23 is {RB, TE, WR}');
});

test('a refused seating returns the state UNCHANGED, never an error', () => {
    // Clicking a seat a player cannot fill is a normal thing for a person to do.
    const before = emptyState(SEATS);
    const after = seat(before, 1, idx('WR'), POOL, CTX);
    assertEq(after.seats.every(s => s.playerId === null), true, 'nothing moved');
    assertEq(seat(before, 1, 99, POOL, CTX).seats.length, 17, 'a seat index off the end');
    assertEq(seat(before, 12345, 0, POOL, CTX).seats[0].playerId, null, 'a player the pool does not carry');
});

// ==== Seating ====

test('a player holds ONE seat: seating again MOVES rather than duplicating', () => {
    // The rule that stops one projection being counted twice.
    let st = seat(emptyState(SEATS), 2, idx('RB', 0), POOL, CTX);
    st = seat(st, 2, idx('RB', 1), POOL, CTX);
    assertEq(st.seats[idx('RB', 0)].playerId, null, 'the first seat emptied');
    assertEq(st.seats[idx('RB', 1)].playerId, 2, 'and the second holds them');
    assertEq(st.seats.filter(s => s.playerId === 2).length, 1, 'exactly one seat');
});

test('seating into an OCCUPIED seat replaces whoever was there', () => {
    let st = seat(emptyState(SEATS), 2, idx('RB', 0), POOL, CTX);
    st = seat(st, 4, idx('RB', 0), POOL, CTX);
    assertEq(st.seats[idx('RB', 0)].playerId, 4, 'the new player');
    assertEq(st.seats.some(s => s.playerId === 2), false, 'and the old one is not seated elsewhere');
});

test('unseat empties one seat; clear empties every seat', () => {
    assertEq(unseat(FRAME_E, idx('QB')).seats[idx('QB')].playerId, null, 'the one seat');
    assertEq(unseat(FRAME_E, idx('QB')).seats[idx('TE')].playerId, 12, 'and only that one');
    assertEq(clear(FRAME_E).seats.every(s => s.playerId === null), true, 'Clear all');
    assertEq(clear(FRAME_E).seats.length, 17, 'the seats survive, only the players go');
});

// ==== The summary, against frame E's printed figures ====

test('the total is the sum of the card\'s OWN figures - frame E prints 572.7', () => {
    // 163.7 + 158.8 + 146.0 + 104.2, and the mockup's card says 572.7.
    const s = summary(FRAME_E, POOL, null, CTX);
    assertClose(s.total, 572.7, 1e-9, 'the printed total');
    assertEq(s.filled, 4, 'four seats');
    assertEq(s.of, 9, 'of nine - the bench row\'s "4 of 9 seats filled"');
});

test('byPosition is in ground order and sums each slot\'s seats', () => {
    const s = summary(FRAME_E, POOL, null, CTX);
    assertEq(s.byPosition.map(r => r.label).join(), 'QB,RB,WR,TE,FLEX,D/ST,K', 'ground order, one row per slot');
    const rb = s.byPosition.find(r => r.label === 'RB');
    assertClose(rb.total, 304.8, 1e-9, 'frame E\'s RB row: 158.8 + 146.0');
    assertEq(rb.filled, 2, 'both seats');
    const wr = s.byPosition.find(r => r.label === 'WR');
    assertEq(wr.filled, 0, 'frame E leaves both receiver seats empty');
    assertEq(wr.total, 0, 'so the row totals nothing');
});

test('the ceiling fills fixed seats BEFORE flex, each player once', () => {
    // Best QB 163.7, best two RB 158.8 + 146.0, best two WR 146.8 + 130.1, best TE 104.2, and the FLEX then takes the best RB/WR/TE still unclaimed - McCaffrey at 135.1. D/ST and K have nobody eligible in this pool and contribute nothing.
    const s = summary(FRAME_E, POOL, null, CTX);
    assertClose(s.ceiling, 163.7 + 158.8 + 146.0 + 146.8 + 130.1 + 104.2 + 135.1, 1e-9, 'the best the seats could hold');
    // The ordering is the point: filling FLEX first would have taken Gibbs and left an RB seat holding McCaffrey, which is a worse pair by exactly the gap between them.
    const byIndex = ceilingFor(SEATS, POOL, CTX);
    assertClose(byIndex.get(idx('RB', 0)), 158.8, 1e-9, 'the best back went to a fixed RB seat');
    assertClose(byIndex.get(idx('FLEX')), 135.1, 1e-9, 'and the flex took the best one left');
});

test('the ceiling does NOT move as seats are filled - it is the fixed bar', () => {
    const empty = summary(emptyState(SEATS), POOL, null, CTX);
    const full = summary(FRAME_E, POOL, null, CTX);
    assertClose(empty.ceiling, full.ceiling, 1e-9, 'the same figure either way');
    assertEq(empty.total, 0, 'while the total is what moves');
});

test('a seat nobody in the pool can fill contributes nothing to the ceiling', () => {
    // Frame E's pool has no kicker and no defence, and the card still reads a real ceiling.
    const byIndex = ceilingFor(SEATS, POOL, CTX);
    assertEq(byIndex.has(idx('K')), false, 'no kicker to seat');
    assertEq(byIndex.has(idx('D/ST')), false, 'and no defence');
});

// ==== place ====

test('place is where the total would have finished - frame E prints #6 of 11', () => {
    // Eleven finishers; five of them scored more than 572.7, so the mock lands sixth.
    const standings = [900, 800, 700, 650, 600, 560, 540, 520, 500, 480, 460]
        .map((points, i) => ({ name: `T${i}`, points }));
    assertEq(JSON.stringify(placeAmong(572.7, standings)), JSON.stringify({ place: 6, of: 11 }), '#6 of 11');
});

test('place is NULL where the league keeps no points, and the cell is then absent', () => {
    // A head-to-head categories league reports 0 on every team (measured, R1). Placing a projected total against a column of zeros would rank every mock team first.
    const zeros = [0, 0, 0, 0, 0, 0].map(points => ({ points }));
    assertEq(placeAmong(572.7, zeros), null, 'a categories league');
    assertEq(placeAmong(572.7, []), null, 'no standings at all');
    assertEq(placeAmong(572.7, null), null, 'no last season');
    assertEq(placeAmong(572.7, [{ points: 900 }, { points: null }]), null, 'a standings row with no figure');
});

test('a total equal to a finisher SHARES the place rather than sitting below it', () => {
    const standings = [900, 600, 500].map(points => ({ points }));
    assertEq(JSON.stringify(placeAmong(600, standings)), JSON.stringify({ place: 2, of: 3 }), 'level is level');
});

test('summary carries place through from last season, or null', () => {
    const last = { standings: [900, 800, 700, 650, 600, 560, 540, 520, 500, 480, 460].map(points => ({ points })) };
    assertEq(summary(FRAME_E, POOL, last, CTX).place.place, 6, 'the card\'s "#6 of 11"');
    assertEq(summary(FRAME_E, POOL, null, CTX).place, null, 'and null with nothing to place against');
});

// ==== Refusals ====

test('a league with no starting seats summarises to NULL, never an empty card', () => {
    const none = emptyState(seatsFor({ order: [20, 21], labels: LABELS, counts: { 20: 7, 21: 1 }, nonStarting: NON_STARTING, benchLabels: BENCH_LABELS }));
    assertEq(summary(none, POOL, null, CTX), null, 'a ground with no seats is a box with a heading');
    assertEq(summary(null, POOL, null, CTX), null, 'no state at all');
});


// ==== The bench (v2, R1 / frame H) ====

const benchIdx = (n = 0) => SEATS.findIndex((s, i) => s.bench && SEATS.slice(0, i).filter(x => x.bench).length === n);

test('the bench is built from the non-starting slots, which are NOT in the order array', () => {
    // Football's order is [0, 2, 4, 6, 23, 16, 17]; its bench slots are 20 and 21. Reading the bench off `order` would find nothing, so a passing count here is the whole point.
    const bench = SEATS.filter(s => s.bench);
    assertEq(bench.length, 8, 'seven BE and one IR');
    assertEq(bench.filter(s => s.label === 'BE').length, 7, 'seven bench');
    assertEq(bench.filter(s => s.label === 'IR').length, 1, 'one injury seat');
    assertEq(bench[0].slotId, 20, 'ascending slot id, so the bench comes before the injury slot');
    assertEq(bench[7].slotId, 21, 'and the injury seat is last');
    assertEq(SEATS.slice(0, 9).every(s => !s.bench), true, 'the starters come first, undisturbed');
});

test('a bench seat accepts ANY player, with no eligibility rule at all', () => {
    const bench = SEATS[benchIdx(0)];
    assertEq(canSeat(POOL[0], bench, CTX), true, 'a quarterback on the bench');
    // The same player against a seat that DOES have a rule, to show the difference is the seat.
    assertEq(canSeat(POOL[0], SEATS[idx('WR')], CTX), false, 'and refused at wide receiver');
    const ir = SEATS[SEATS.length - 1];
    assertEq(ir.label, 'IR', 'the injury seat');
    assertEq(canSeat(POOL[0], ir, CTX), true, 'takes anyone too');
});

test('seating on the bench leaves the starters and every figure alone', () => {
    const after = seat(FRAME_E, 5, benchIdx(0), POOL, CTX);
    const before = summary(FRAME_E, POOL, null, CTX);
    const now = summary(after, POOL, null, CTX);
    assertClose(now.total, before.total, 1e-9, 'the total does not move');
    assertEq(now.filled, before.filled, 'nor the starters filled');
    assertEq(now.of, 9, 'nine starting seats, never seventeen');
    assertClose(now.ceiling, before.ceiling, 1e-9, 'nor the ceiling');
    assertEq(now.benchFilled, 1, 'the bench is counted');
    assertEq(now.benchOf, 8, 'out of eight');
    assertEq(before.benchFilled, 0, 'and was empty before');
});

test('ONE SEAT PER PLAYER holds ACROSS starters and bench', () => {
    // The move is the reason the bench lives in the same array: seating a starter onto the bench has to empty their starting seat, and nothing here was written twice to make that happen.
    const q = idx('QB');
    assertEq(FRAME_E.seats[q].playerId, 1, 'Allen starts');
    const moved = seat(FRAME_E, 1, benchIdx(0), POOL, CTX);
    assertEq(moved.seats[q].playerId, null, 'his starting seat empties');
    assertEq(moved.seats[benchIdx(0)].playerId, 1, 'and he is on the bench');
    const s2 = summary(moved, POOL, null, CTX);
    assertEq(s2.filled, 3, 'three starters left');
    assertEq(s2.benchFilled, 1, 'one benched');
    assertClose(s2.total, 572.7 - 163.7, 0.05, 'and the total loses exactly his projection');
});

test('moving a player BENCH TO STARTER empties the bench seat', () => {
    const benched = seat(emptyState(SEATS), 1, benchIdx(0), POOL, CTX);
    assertEq(summary(benched, POOL, null, CTX).benchFilled, 1, 'on the bench first');
    const started = seat(benched, 1, idx('QB'), POOL, CTX);
    assertEq(started.seats[benchIdx(0)].playerId, null, 'the bench seat empties');
    assertEq(started.seats[idx('QB')].playerId, 1, 'and he starts');
    const s3 = summary(started, POOL, null, CTX);
    assertEq(s3.filled, 1, 'counted as a starter now');
    assertEq(s3.benchFilled, 0, 'and not also on the bench');
});

test('the ceiling never fills a bench seat', () => {
    // A bench seat takes anyone, so a ceiling that filled eight of them would hand the best players left to seats that score nothing - and take them from the starting seats it is measuring.
    const byIndex = ceilingFor(SEATS, POOL, CTX);
    const benchIndexes = SEATS.map((s, i) => (s.bench ? i : -1)).filter(i => i >= 0);
    assertEq(benchIndexes.some(i => byIndex.has(i)), false, 'no bench seat has a ceiling value');
    assertClose(summary(FRAME_E, POOL, null, CTX).ceiling, 984.7, 1e-9, 'so the bar is unchanged');
});

test('a bench player is never in byPosition', () => {
    const after = seat(FRAME_E, 5, benchIdx(0), POOL, CTX);
    const rows = summary(after, POOL, null, CTX).byPosition;
    assertEq(rows.some(r => r.label === 'BE' || r.label === 'IR'), false, 'no bench row');
    assertEq(rows.length, 7, 'seven distinct starting slots, as before');
});

test('a league with a bench but NO starting seats is still NULL', () => {
    const benchOnly = emptyState(seatsFor({
        order: [], labels: LABELS, counts: { 20: 7, 21: 1 },
        nonStarting: NON_STARTING, benchLabels: BENCH_LABELS
    }));
    assertEq(benchOnly.seats.length, 8, 'the bench seats exist');
    assertEq(summary(benchOnly, POOL, null, CTX), null, 'and the card still refuses: a bench is not a team');
});

test('a league with no bench slots has no bench seats and zero counts', () => {
    const noBench = seatsFor({ order: ORDER, labels: LABELS, counts: { 0: 1, 2: 1 }, nonStarting: NON_STARTING, benchLabels: BENCH_LABELS });
    assertEq(noBench.length, 2, 'two starting seats and nothing else');
    const s4 = summary(emptyState(noBench), POOL, null, CTX);
    assertEq(s4.benchFilled, 0, 'zero, never null');
    assertEq(s4.benchOf, 0, 'and no bench seats to count');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
