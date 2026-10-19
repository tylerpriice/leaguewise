// draft-plan.js unit tests. Every expected value is hand-computed from tests/fixtures/draft-plan.md and the two engines this module calls; nothing here is a snapshot of what the code happened to print.
import {
    buildPlan, setTarget, setAlternate, removeTarget, validate,
    emptyLog, applyLoggedPick, undoLastPick, loggedPickRefusal,
    emptyNotes, setNote, noteFor, notedIds,
    setRule, removeRule, rulesFor, resolveRound,
    remainingPool, rerank, planStatus, nextPick, planRoster, valueOverNext, suggestFor, suggestPlan,
    resolveDraftSwitches, rostersFromLog, logCoverage, logNeeds, seatAll, logSeats, logSurvivesReset, storedLogApplies, roomPicksClearOffer
} from '../src/engines/draft-plan.js';
import { draftOrder, picksFor } from '../src/engines/draft-engine.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg || ''} expected ${expected}, got ${actual}`);
}
function assertJson(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// THE ORDER EVERY TEST BELOW USES: ten teams, three rounds, snake, the reader at slot 8. Round 1 walks 1..10, so pick 8 is team 8. Round 2 walks 10..1, so picks 11, 12, 13 are teams 10, 9, 8 - the reader's second pick is overall 13. Round 3 walks 1..10 again from pick 21, so pick 28 is team 8. Those three numbers are the ones the brief names and they are checked below rather than assumed.
const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ORDER = draftOrder(TEN, 3, 'SNAKE');
const ME = 8;

test('buildPlan: the snake at slot 8 of 10 gives picks 8, 13 and 28', () => {
    assertEq(ORDER.length, 30, 'three rounds of ten');
    assertJson(picksFor(ORDER, ME), [8, 13, 28], 'the engine and the brief agree');
    const plan = buildPlan('flb-1-2026', ORDER, ME, { slot: 8 });
    assertEq(plan.leagueKey, 'flb-1-2026', 'the league it belongs to');
    assertEq(plan.slot, 8, 'the slot is stored, not recomputed later');
    assertJson(plan.rounds.map(r => r.pick), [8, 13, 28], 'one row per owned pick, in pick order');
    assertJson(plan.rounds.map(r => r.round), [1, 2, 3], 'rounds numbered from one');
    assertEq(plan.rounds[0].targetId, null, 'a fresh plan targets nobody');
    assertJson(plan.rounds[0].alternateIds, [], 'and lists no alternates');
    // The slot is derivable when the caller does not pass one.
    assertEq(buildPlan('k', ORDER, ME).slot, 8, 'derived from the first round when not given');
});

test('setTarget, setAlternate and removeTarget: new plans, and the gap closes', () => {
    const plan = buildPlan('k', ORDER, ME, { slot: 8 });
    const a = setTarget(plan, 1, 'p1');
    assertEq(plan.rounds[0].targetId, null, 'the original plan is untouched');
    assertEq(a.rounds[0].targetId, 'p1', 'the new one carries the target');

    const b = setAlternate(setAlternate(a, 1, 0, 'p2'), 1, 1, 'p3');
    assertJson(b.rounds[0].alternateIds, ['p2', 'p3'], 'two alternates, in the order given');
    // Clearing the FIRST alternate must not leave a hole: the second is now the first.
    const c = setAlternate(b, 1, 0, null);
    assertJson(c.rounds[0].alternateIds, ['p3'], 'clearing one closes the gap');

    // removeTarget leaves the alternates alone. Promotion is a fact about the log, not about the reader changing their mind, so clearing a row must not silently refill it.
    const d = removeTarget(b, 1);
    assertEq(d.rounds[0].targetId, null, 'the target is gone');
    assertJson(d.rounds[0].alternateIds, ['p2', 'p3'], 'and the alternates are not promoted');

    // A round the plan does not carry is a no-op rather than an error.
    assertEq(setTarget(b, 9, 'p9'), b, 'an unknown round returns the same plan object');
});

test('validate: the three kinds a reader makes by hand', () => {
    let plan = buildPlan('k', ORDER, ME, { slot: 8 });
    plan = setTarget(plan, 1, 'p1');
    plan = setTarget(plan, 2, 'p2');
    plan = setTarget(plan, 3, 'p1');                       // the same target twice
    plan = setAlternate(plan, 2, 0, 'p2');                 // an alternate that is its own target
    plan = setAlternate(plan, 1, 0, 'p5');
    plan = setAlternate(plan, 1, 1, 'p5');                 // the same alternate twice in one round

    const v = validate(plan);
    assertEq(v.ok, false, 'a plan with problems is not ok');
    assertEq(v.problems.length, 3, 'three problems, one of each kind');

    const dup = v.problems.find(p => p.kind === 'duplicate-target');
    assertEq(dup.playerId, 'p1', 'names the player');
    assertJson(dup.rounds, [1, 3], 'and EVERY round it sits in, not just the later one');

    const eq = v.problems.find(p => p.kind === 'alternate-equals-target');
    assertEq(eq.round, 2, 'the round');
    assertEq(eq.index, 0, 'and which alternate');

    const twice = v.problems.find(p => p.kind === 'duplicate-alternate');
    assertEq(twice.round, 1, 'the round');
    assertJson(twice.indexes, [0, 1], 'and both positions');

    // It reports and never repairs: the plan is unchanged by validating it.
    assertEq(plan.rounds[2].targetId, 'p1', 'the duplicate is still there afterwards');
    assertEq(validate(buildPlan('k', ORDER, ME, { slot: 8 })).ok, true, 'an empty plan is ok');
});

test('the log is an undo stack, and it refuses out of sequence', () => {
    const log0 = emptyLog();
    const log1 = applyLoggedPick(log0, { overall: 1, teamId: 1, playerId: 'a' });
    assertEq(log0.picks.length, 0, 'the original log is never mutated');
    assertJson(log1.picks, [{ overall: 1, teamId: 1, playerId: 'a' }], 'one pick logged');

    // Omitting `overall` means the next one.
    const log2 = applyLoggedPick(log1, { teamId: 2, playerId: 'b' });
    assertEq(log2.picks[1].overall, 2, 'a missing overall is the next in sequence');

    // A REFUSAL RETURNS THE SAME OBJECT, tested by identity, which is what the face must check.
    assertEq(applyLoggedPick(log2, { overall: 3, teamId: 3, playerId: 'a' }), log2,
        'a player already logged is refused');
    assertEq(applyLoggedPick(log2, { overall: 5, teamId: 3, playerId: 'c' }), log2,
        'a pick out of sequence is refused, which is what makes this a draft and not a set');
    assertEq(applyLoggedPick(log2, { overall: 3, teamId: 3 }), log2, 'no player, no pick');

    const back = undoLastPick(log2);
    assertJson(back.picks.map(p => p.playerId), ['a'], 'undo removes the last only');
    assertEq(log2.picks.length, 2, 'and leaves the log it was given alone');
    const nothing = emptyLog();
    assertEq(undoLastPick(nothing), nothing, 'undo on an empty log returns the same object');
    // And the pick undone can be logged again, because the sequence is now free.
    assertEq(applyLoggedPick(back, { overall: 2, teamId: 9, playerId: 'z' }).picks.length, 2,
        'the freed slot accepts a different player');
});

// The pool shrinks and the prices move. Four players at 50, 47, 44 and 40, all one position, with the tier cut's default gap of 4. Whole pool: gaps 3, 3, 4, and only the last reaches the threshold, so the breaks are [0, 3] and the first three share tier 1. With the 47 logged out: gaps 6 and 4, both reach it, the breaks are [0, 1, 2], and the 44 is now tier 2 alone.
const BOARD = [
    { id: 'A', value: 50, eligiblePositions: ['OF'] },
    { id: 'B', value: 47, eligiblePositions: ['OF'] },
    { id: 'C', value: 44, eligiblePositions: ['OF'] },
    { id: 'D', value: 40, eligiblePositions: ['OF'] }
];
const GROUPS = [{ name: 'OF', accepts: new Set(['OF']), seats: 2 }];

test('rerank: a tier boundary moves when the pool does', () => {
    const whole = rerank(BOARD, GROUPS);
    assertJson(whole.breaks, [0, 3], 'one cut, before the last player');
    assertEq(whole.tierById.C, 1, 'the 44 shares tier 1 while the 47 is there');
    assertEq(whole.tierById.D, 2, 'and only the 40 is below the cut');

    const log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 1, playerId: 'B' });
    const left = remainingPool(BOARD, log);
    assertJson(left.map(p => p.id), ['A', 'C', 'D'], 'the logged player is off the board');

    const after = rerank(left, GROUPS);
    assertJson(after.breaks, [0, 1, 2], 'two cuts now, because both gaps reach the threshold');
    assertEq(after.tierById.C, 2, 'the 44 has DROPPED a tier on a smaller pool');
    assertEq(after.tierById.D, 3, 'and the 40 with it');
});

test('rerank: the replacement level moves with the pool too', () => {
    // Two seats, so the replacement is the second-best player who can fill them.
    assertEq(rerank(BOARD, GROUPS).replacements.OF, 'B', 'the 47 is the replacement at first');
    const log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 1, playerId: 'B' });
    assertEq(rerank(remainingPool(BOARD, log), GROUPS).replacements.OF, 'C',
        'and the 44 takes over once it is gone');
    // A group nobody left can fill has no replacement rather than a fabricated one.
    assertEq(rerank(BOARD, [{ name: 'C', accepts: new Set(['SP']), seats: 1 }]).replacements.C, null,
        'no eligible player, no replacement');
});

test('rerank: the scoring callback is scoreOf, and a plain value works without one', () => {
    const doubled = rerank(BOARD, GROUPS, { scoreOf: p => p.value * 2 });
    assertEq(doubled.ranked[0].value, 100, 'scoreOf decides the value the sort and the cuts use');
    // The name matters: an option called valueOf would bind Object.prototype.valueOf whenever the caller passed none. Passing no callback must fall back to the row's own value.
    assertEq(rerank(BOARD, GROUPS).ranked[0].value, 50, 'no callback reads the row');
});

test('planStatus: mine, taken with a promotion, taken with a reason, and open', () => {
    let plan = buildPlan('k', ORDER, ME, { slot: 8 });
    plan = setTarget(plan, 1, 'X');                       // the reader gets this one
    plan = setTarget(plan, 2, 'Y');
    plan = setAlternate(plan, 2, 0, 'Y2');                // still free, so it promotes
    plan = setTarget(plan, 3, 'Z');
    plan = setAlternate(plan, 3, 0, 'Z2');                // taken too, so nothing promotes

    // A valid sequence: eight picks, with the reader taking X at pick 8 (their own slot).
    let log = emptyLog();
    [['Y', 5], ['Z', 1], ['Z2', 2], ['q1', 3], ['q2', 4], ['q3', 6], ['q4', 7]]
        .forEach(([playerId, teamId]) => { log = applyLoggedPick(log, { teamId, playerId }); });
    log = applyLoggedPick(log, { teamId: 8, playerId: 'X' });
    assertEq(log.picks.length, 8, 'eight picks logged in sequence');
    assertEq(log.picks[7].overall, 8, 'and the reader took theirs at overall 8');

    const rows = planStatus(plan, log, ORDER);
    assertEq(rows.length, 3, 'one row per planned round');

    assertEq(rows[0].status, 'mine', 'the target the reader logged under their own team');
    assertEq(rows[0].takenAt.overall, 8, 'at their own pick');
    assertEq(rows[0].promotedId, null, 'nothing promotes on a row that worked');

    assertEq(rows[1].status, 'taken', 'a target somebody else logged');
    assertEq(rows[1].takenAt.teamId, 5, 'named by team');
    assertEq(rows[1].promotedId, 'Y2', 'and the first alternate still available steps up');
    assertEq(rows[1].reason, null, 'no reason is needed when one promoted');

    assertEq(rows[2].status, 'taken', 'the third target is gone as well');
    assertEq(rows[2].promotedId, null, 'and so is its only alternate');
    assertEq(rows[2].reason, 'Every alternate is gone too.', 'so the row says why it is empty');

    // A row with no target at all is open and says nothing: it is a row the reader has not got to.
    const bare = planStatus(buildPlan('k', ORDER, ME, { slot: 8 }), log, ORDER);
    assertEq(bare[0].status, 'open', 'an unfilled row is open');
    assertEq(bare[0].reason, null, 'and carries no complaint');
});

test('planStatus: the reader team comes from the slot, and opts can override it', () => {
    let plan = buildPlan('k', ORDER, ME, { slot: 8 });
    plan = setTarget(plan, 1, 'X');
    const log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 8, playerId: 'X' });
    // order[slot - 1] is order[7], which is team 8: the reader's own.
    assertEq(planStatus(plan, log, ORDER)[0].status, 'mine', 'derived from the slot');
    assertEq(planStatus(plan, log, ORDER, { myTeamId: 3 })[0].status, 'taken',
        'a caller who knows better can say so');
});

test('nextPick: zero is being on the clock, not a missing value', () => {
    // Ten picks logged: pick 11 is on the clock, which round 2 gives to team 10.
    let log = emptyLog();
    for (let i = 1; i <= 10; i++) log = applyLoggedPick(log, { teamId: i, playerId: `p${i}` });
    const at11 = nextPick(ORDER, log, ME);
    assertEq(at11.overall, 11, 'one past what is logged');
    assertEq(at11.teamId, 10, 'the snake turns, so team 10 picks again');
    assertEq(at11.myNextOverall, 13, 'the reader is next at 13');
    assertEq(at11.untilMine, 2, 'two picks away');

    // Two more, and it is the reader's turn.
    log = applyLoggedPick(log, { teamId: 10, playerId: 'p11' });
    log = applyLoggedPick(log, { teamId: 9, playerId: 'p12' });
    const mine = nextPick(ORDER, log, ME);
    assertEq(mine.overall, 13, 'the reader is on the clock');
    assertEq(mine.teamId, 8, 'and it is their team');
    assertEq(mine.untilMine, 0, 'zero is now, not nothing');
    assertEq(mine.myNextOverall, 13, 'their next pick is this one');

    // Past the last pick there is no next pick at all.
    let full = emptyLog();
    for (let i = 1; i <= 30; i++) full = applyLoggedPick(full, { teamId: ORDER[i - 1], playerId: `f${i}` });
    assertEq(nextPick(ORDER, full, ME), null, 'a finished draft has no clock');
    // A team with no picks left while the draft runs on reports so rather than guessing.
    const none = nextPick(ORDER, at11 && log, 99);
    assertEq(none.myNextOverall, null, 'a team that owns no pick has no next one');
    assertEq(none.untilMine, null, 'and no countdown');
});

test('planRoster: the mock lineup seats the targets and reports who fits nowhere', () => {
    const pool = [
        { id: 'A', value: 10, eligiblePositions: ['OF'] },
        { id: 'B', value: 6, eligiblePositions: ['OF'] },
        { id: 'K', value: 3, eligiblePositions: ['K'] }
    ];
    const seats = [
        { slotId: 1, label: 'OF', playerId: null, bench: false },
        { slotId: 1, label: 'OF', playerId: null, bench: false }
    ];
    let plan = buildPlan('k', ORDER, ME, { slot: 8 });
    plan = setTarget(plan, 1, 'A');
    plan = setTarget(plan, 2, 'B');
    plan = setTarget(plan, 3, 'K');                       // no seat accepts a kicker here

    const out = planRoster(plan, pool, seats);
    assertJson(out.state.seats.map(s => s.playerId), ['A', 'B'], 'seated in pick order');
    assertEq(out.summary.filled, 2, 'the mock lineup counts them');
    assertEq(out.summary.of, 2, 'against its own starting seats');
    // The figures are the mock lineup's own: it reads `value` off the pool row, and both OF seats hold the two best outfielders, so the total and the ceiling meet at 10 + 6.
    assertEq(out.summary.total, 16, 'total is the mock lineup figure, not a second computation');
    assertEq(out.summary.ceiling, 16, 'and the plan has reached its own ceiling here');
    assertEq(out.unseated.length, 1, 'the kicker is reported');
    assertEq(out.unseated[0].round, 3, 'by the round it was planned for');
    assertEq(out.unseated[0].playerId, 'K', 'and by player');
    assertEq(out.unseated[0].reason, 'No seat accepts this player.', 'with a stated reason');
});

// Value over the next pick. The reader is on pick 8 and picks again at 20, so survivalWord reads: ADP 26 or later likely, 21 to 25 a coin flip, 9 to 20 unlikely, 8 or earlier no. Every number below is one subtraction.
const VON_POOL = [
    // Outfield: a FALLER still on the board at 8 with an ADP of 5, and one weak outfielder who will still be there at 20.
    { id: 'A', value: 100, adp: 5, group: 'OF' },
    { id: 'C', value: 30, adp: 22, group: 'OF' },
    // Catcher, the scarce seat: a good one the crowd takes before 20, and a poor one who lasts.
    { id: 'F', value: 60, adp: 10, group: 'C' },
    { id: 'G', value: 20, adp: 50, group: 'C' },
    // A pitcher whose only alternative is already gone.
    { id: 'D', value: 90, adp: 6, group: 'SP' },
    { id: 'H', value: 55, adp: 3, group: 'SP' },
    // And a player no seat prices at all.
    { id: 'Z', value: 44, adp: 40, group: null }
];
const VON_OPTS = { groupOf: p => p.group, currentPick: 8 };

test('valueOverNext: the faller beats the scarce seat, which is the whole point', () => {
    const out = valueOverNext(VON_POOL, 20, VON_OPTS);
    const row = id => out.rows.find(r => r.id === id);

    // A is gone by 20 (ADP 5, the crowd took them before now), so taking A costs waiting for C.
    assertEq(row('A').overNext, 70, '100 less the 30 that will still be there');
    assertEq(row('A').bestAtNextId, 'C', 'and names who the reader would get instead');
    assertEq(row('A').survives, 'no', 'A will not last, which is why the number is large');

    // The scarce catcher seat: F is a better player than nothing, but the drop behind them is smaller than the outfield faller's, so the faller is worth more DESPITE the position.
    assertEq(row('F').overNext, 40, '60 less the 20 that lasts');
    assert(row('A').overNext > row('F').overNext, 'quality that falls beats a scarcer seat');

    // C reads NEGATIVE against A, which is honest: A is the better player and C is the one who lasts, so taking C now gives up nothing and gains nothing.
    assertEq(row('C').overNext, null, 'C has no surviving alternative but themself');
    assertEq(row('C').reason, 'Nothing else at this position is likely to last.', 'and says so');
});

test('valueOverNext: a position with nobody left is a fact, never a zero', () => {
    const out = valueOverNext(VON_POOL, 20, VON_OPTS);
    const row = id => out.rows.find(r => r.id === id);
    // Both pitchers have an ADP the crowd passes before pick 20, so waiting gets neither.
    assertEq(row('D').overNext, null, 'no value over a pick that will not exist');
    assertEq(row('D').reason, 'Nothing else at this position is likely to last.', 'the position is the risk');
    assertEq(out.bestAtNext.SP, null, 'and nothing is named as available there');
    // A zero would read as "no better than waiting" when waiting gets nothing at all.
    assert(row('D').overNext !== 0, 'which is not the same as zero');

    // A player no seat prices has no instead to measure against.
    assertEq(row('Z').overNext, null, 'no seat, no comparison');
    assertEq(row('Z').reason, 'No seat prices this player.', 'and a different reason from the above');
});

test('valueOverNext: the best available at the next pick, named per seat', () => {
    const out = valueOverNext(VON_POOL, 20, VON_OPTS);
    assertJson(out.bestAtNext.OF, { id: 'C', value: 30 }, 'the outfielder who lasts');
    assertJson(out.bestAtNext.C, { id: 'G', value: 20 }, 'the catcher who lasts');
    assertEq(out.bestAtNext.SP, null, 'and nobody at all in the third seat');
    // A player is never their own alternative: F is priced against G, not against F.
    assertEq(out.rows.find(r => r.id === 'G').bestAtNextId, null, 'the last one standing has no other');
    assertEq(out.rows.find(r => r.id === 'G').overNext, null, 'so no number, with a reason');
});

// The suggestion. The reader is choosing for pick 3 and the draft is at pick 1, so survivalWord reads: ADP 9 or later likely, 4 to 8 a coin flip, 2 to 3 unlikely, 1 or earlier no. Candidates arrive best first, as the board orders them.
test('suggestFor: a draft position decides it when there is one', () => {
    const best = { id: 'A', value: 100, adp: 2 };      // "unlikely" - the crowd takes A before 3
    const lasts = { id: 'B', value: 80, adp: 30 };     // "likely" - and so the offer
    const out = suggestFor([best, lasts], 3);
    assertEq(out.id, 'B', 'the best player the crowd will leave there');
    assertEq(out.basis, 'survives', 'and it says a draft position decided it');
    assertEq(out.reason, null, 'with nothing to explain');
});

test('suggestFor: draft positions that all say no is a fact about the players', () => {
    // Everyone is taken before pick 3, so nobody lasts. That is worth saying, and it is not the same as the league having no draft positions at all.
    const out = suggestFor([{ id: 'A', value: 100, adp: 2 }, { id: 'B', value: 80, adp: 1 }], 3);
    assertEq(out.id, 'A', 'the best remaining is still the honest offer');
    assertEq(out.basis, 'value', 'but no draft position chose it');
    assertEq(out.reason, 'Nothing at this pick is likely to last.', 'and the reason is the players');
});

test('suggestFor: no draft positions in the league is a different fact', () => {
    // ESPN publishes one constant draft position for every player once a season is under way. That reads as no draft position at all, so survival cannot be asked, and saying nothing is likely to last would be false.
    const none = [{ id: 'A', value: 100, adp: null }, { id: 'B', value: 80, adp: null }];
    const out = suggestFor(none, 3);
    assertEq(out.id, 'A', 'the best player left');
    assertEq(out.basis, 'value', 'chosen on value alone');
    assertEq(out.reason, 'No draft positions published for this league.', 'and it says so');
    // A zero ADP is the same absence: ESPN uses it for a player it has no position for.
    assertEq(suggestFor([{ id: 'A', value: 100, adp: 0 }], 3).reason,
        'No draft positions published for this league.', 'zero is absent, not pick zero');
});

/**
 * suggestPlan. The board is best first by value, with each player's ADP. A player lasts to a pick
 * when the crowd takes the player after it, which is an ADP above the pick.
 *
 *   A 164  ADP  1.8     C 112  ADP  4.1     E  92  ADP 20.8     P  59  ADP 90
 *   B 132  ADP  2.3     D  96  ADP 10.9     H  82  ADP 73.1
 */
const SP_POOL = [
    { id: 'A', value: 164, adp: 1.8 }, { id: 'B', value: 132, adp: 2.3 }, { id: 'C', value: 112, adp: 4.1 },
    { id: 'D', value: 96, adp: 10.9 }, { id: 'E', value: 92, adp: 20.8 }, { id: 'H', value: 82, adp: 73.1 },
    { id: 'P', value: 59, adp: 90 }
];
const spRound = (round, pick, targetId = null, alternateIds = []) => ({ round, pick, targetId, alternateIds });
const spIds = (rows) => rows.map(r => r.suggestion ? r.suggestion.id : null);

test('suggestPlan: one round at a time repeats a player; the plan offers each player once', () => {
    // The defect, pinned: asked independently, picks 21 and 28 both offer H, the best player whose ADP (73.1) still lasts. Walked as a plan, pick 28 is offered the next who lasts, P.
    assertEq(suggestFor(SP_POOL, 21).id, 'H', 'pick 21 on its own offers H');
    assertEq(suggestFor(SP_POOL, 28).id, 'H', 'and so does pick 28 on its own');
    const rows = suggestPlan([spRound(1, 4), spRound(2, 9), spRound(3, 16), spRound(4, 21), spRound(5, 28)], SP_POOL);
    assertJson(spIds(rows), ['C', 'D', 'E', 'H', 'P'], 'C at 4, D at 9, E at 16, H at 21, then P - nobody twice');
    assertEq(rows.every(r => r.suggestion.basis === 'survives'), true, 'every one decided by a draft position');
});

test('suggestPlan: a round with a target is offered nobody, and its target is taken everywhere else', () => {
    const rows = suggestPlan([spRound(1, 4), spRound(2, 9, 'D'), spRound(3, 16)], SP_POOL);
    assertJson(spIds(rows), ['C', null, 'E'], 'round 2 has its answer; round 1 and round 3 are offered around its target');
    const early = suggestPlan([spRound(1, 4), spRound(2, 9, null), spRound(3, 16, 'C')], SP_POOL);
    // C is round 3's target, so round 1 cannot be offered C even though C is the one who lasts to 4.
    assertEq(early[0].suggestion.id, 'D', 'a later round\'s target is spoken for in an earlier one too');
});

test('suggestPlan: a round\'s own alternate stays available to that round', () => {
    // Round 1 lists C as an alternate and has no target, so C can still be its suggestion; round 2 cannot have C, because round 1 names it.
    const rows = suggestPlan([spRound(1, 4, null, ['C']), spRound(2, 9)], SP_POOL);
    assertJson(spIds(rows), ['C', 'D'], 'its own alternate for round 1, D for round 2');
});

test('suggestPlan: rounds handed in out of order are walked by pick and returned as given', () => {
    const rows = suggestPlan([spRound(2, 9), spRound(1, 4)], SP_POOL);
    assertJson(rows.map(r => r.round), [2, 1], 'returned in the order given');
    assertJson(spIds(rows), ['D', 'C'], 'but pick 4 chose first, so pick 9 could not have C');
});

test('suggestPlan: when the pool runs out, the round is null rather than a repeat', () => {
    // Two players, three rounds, and neither lasts to pick 4: the value basis offers each once, and the third round has nobody left to offer.
    const pool = [{ id: 'A', value: 164, adp: 1.8 }, { id: 'B', value: 132, adp: 2.3 }];
    const rows = suggestPlan([spRound(1, 4), spRound(2, 9), spRound(3, 16)], pool);
    assertJson(spIds(rows), ['A', 'B', null], 'each once, then nobody');
    assertEq(rows[0].suggestion.basis, 'value', 'offered on value, since nothing lasts');
    assertJson(suggestPlan([], SP_POOL), [], 'no rounds, no rows');
});

test('suggestFor: nothing to offer is null, and the caller filters the plan', () => {
    assertEq(suggestFor([], 3), null, 'an empty board suggests nobody');
    assertEq(suggestFor(null, 3), null, 'and so does no board at all');
    // The order handed in is the order used: this module does not re-sort a list that already has a tie rule.
    const out = suggestFor([{ id: 'Z', value: 1, adp: 99 }, { id: 'A', value: 100, adp: 99 }], 3);
    assertEq(out.id, 'Z', 'the first that qualifies, in the order given');
});

// The round's rules and the one evaluator. The fixture's eight players are referred to below by their ids, 1 to 8.
const rulePlan = () => ({
    leagueKey: 'k', slot: 4,
    rounds: [
        { round: 1, pick: 4, targetId: 1, alternateIds: [2, 3], rules: [] },
        { round: 2, pick: 9, targetId: 4, alternateIds: [5], rules: [{ kind: 'ifIHave', playerId: 1, thenId: 6 }] },
        { round: 3, pick: 16, targetId: 7, alternateIds: [], rules: [{ kind: 'prefer', aId: 7, bId: 8 }] }
    ]
});

test('rules: ifGone is the alternates, listed first and never stored twice', () => {
    const list = rulesFor(rulePlan(), 1);
    assertEq(list[0].kind, 'ifGone', 'the head of the list');
    assertJson(list[0].playerIds, [2, 3], 'the alternates, in order');
    assertEq(list.length, 1, 'and round 1 has no other rule');
    assertJson(rulesFor(rulePlan(), 2).map(r => r.kind), ['ifGone', 'ifIHave'], 'synthesised first, stored after');
    assertJson(rulesFor(rulePlan(), 9), [], 'a round the plan does not carry');
});

test('rules: setRule replaces the same rule restated, prefer either way round', () => {
    let plan = setRule(rulePlan(), 1, { kind: 'ifIHave', playerId: 9, thenId: 5 });
    assertEq(rulesFor(plan, 1).length, 2, 'appended beside the synthesised ifGone');
    plan = setRule(plan, 1, { kind: 'ifIHave', playerId: 9, thenId: 6 });
    assertEq(rulesFor(plan, 1).length, 2, 'the same condition restated replaces it');
    assertEq(rulesFor(plan, 1)[1].thenId, 6, 'with the new answer');
    const three = setRule(rulePlan(), 3, { kind: 'prefer', aId: 8, bId: 7 });
    assertEq(rulesFor(three, 3).filter(r => r.kind === 'prefer').length, 1, 'one prefer, never two halves of a contradiction');
    assertEq(rulesFor(three, 3).find(r => r.kind === 'prefer').aId, 8, 'the later one wins');
    assertEq(rulesFor(setRule(rulePlan(), 1, { kind: 'nonsense', playerId: 1 }), 1).length, 1, 'an unknown kind is a no-op');
    assertEq(rulesFor(setRule(rulePlan(), 1, { kind: 'ifIHave', playerId: 9 }), 1).length, 1, 'a rule missing an id is a no-op');
});

test('rules: removeRule takes the index rulesFor printed, past the synthesised head', () => {
    const plan = removeRule(rulePlan(), 2, 0);
    assertJson(rulesFor(plan, 2).map(r => r.kind), ['ifGone'], 'the stored rule is gone, the alternates remain');
    assertEq(rulesFor(removeRule(rulePlan(), 2, 5), 2).length, 2, 'an index past the end changes nothing');
});

test('resolveRound: the target, when it is there', () => {
    const out = resolveRound(rulePlan(), 1, { goneIds: [], heldIds: [] });
    assertEq(out.pick, 1, 'MacKinnon');
    assertEq(out.reason, 'target', 'no rule needed to fire');
    assertEq(out.firedRule, null, 'and none did');
});

test('resolveRound: the target is gone, so the first alternate still there', () => {
    const out = resolveRound(rulePlan(), 1, { goneIds: [1, 2], heldIds: [] });
    assertEq(out.pick, 3, 'past McDavid, who is also gone, to Celebrini');
    assertEq(out.reason, 'if-gone', 'the alternates answered');
    assertEq(out.firedRule.kind, 'ifGone', 'and say so');
    assertJson(out.candidates, [1, 2, 3], 'the walk, in order, for the tray to show');
    const empty = resolveRound(rulePlan(), 1, { goneIds: [1, 2, 3], heldIds: [] });
    assertEq(empty.pick, null, 'nobody left');
    assertEq(empty.reason, 'nobody', 'and it says so');
});

test('resolveRound: ifIHave fires OVER a target that is still there', () => {
    // Round 2 of the fixture: player 1 was taken in round 1, so this round takes player 6 and not player 4, who is still there.
    const out = resolveRound(rulePlan(), 2, { goneIds: [], heldIds: [1] });
    assertEq(out.pick, 6, 'Werenski');
    assertEq(out.reason, 'if-i-have', 'because I hold MacKinnon');
    assertEq(out.firedRule.playerId, 1, 'and the rule names him');
    assertEq(resolveRound(rulePlan(), 2, { goneIds: [], heldIds: [9] }).pick, 4, 'without him, Makar as planned');
});

test('resolveRound: prefer settles the pair, both there and one gone', () => {
    const both = resolveRound(rulePlan(), 3, { goneIds: [], heldIds: [] });
    assertEq(both.pick, 7, 'the preferred one');
    const aGone = resolveRound(rulePlan(), 3, { goneIds: [7], heldIds: [] });
    assertEq(aGone.pick, 8, 'Wedgewood');
    assertEq(aGone.reason, 'prefer', 'the rule chose him, and round 3 has no alternates');
    const elsewhere = setRule(rulePlan(), 1, { kind: 'prefer', aId: 8, bId: 5 });
    assertEq(resolveRound(elsewhere, 1, { goneIds: [], heldIds: [] }).pick, 1, 'a pair this round is not choosing between says nothing');
});

test('resolveRound: a chain - the rule fires and ITS player is gone too', () => {
    const out = resolveRound(rulePlan(), 2, { goneIds: [6], heldIds: [1] });
    assertEq(out.pick, 5, 'Seider, the alternate');
    assertEq(out.reason, 'if-gone', 'the last rule to fire is the one reported');
    assertJson(out.candidates, [6, 5], 'Werenski considered first, then the alternate');
});

test('validate: a rule that changes nothing, and one that drafts a claimed player', () => {
    let plan = rulePlan();
    plan = setRule(plan, 3, { kind: 'ifIHave', playerId: 2, thenId: 7 });
    plan = setRule(plan, 1, { kind: 'ifIHave', playerId: 9, thenId: 4 });
    const kinds = validate(plan).problems.map(p => p.kind);
    assertEq(kinds.includes('rule-equals-target'), true, 'a rule that would pick this round own target');
    assertEq(kinds.includes('rule-player-targeted'), true, 'and one that would draft round 2 target');
    assertEq(validate(rulePlan()).ok, true, 'prefer naming the target is what the kind is for');
});
// ==== The reader's own notes ====
test('notes: a note is set, read and cleared by the same one verb', () => {
    const empty = emptyNotes('fhl-1234-2027');
    assertEq(empty.leagueKey, 'fhl-1234-2027', 'whose notes these are');
    assertJson(empty.notes, {}, 'and none yet');
    const one = setNote(empty, 4024123, '  sleeper, late ADP  ');
    assertEq(noteFor(one, 4024123), 'sleeper, late ADP', 'trimmed as written');
    assertEq(noteFor(one, '4024123'), 'sleeper, late ADP', 'ids compare as strings, the module own rule');
    assertEq(noteFor(empty, 4024123), null, 'the original is untouched - every operation returns a new object');
    // Clearing the field IS the delete; there is no second verb to keep in step with this one.
    const cleared = setNote(one, 4024123, '   ');
    assertEq(noteFor(cleared, 4024123), null, 'whitespace clears it');
    assertJson(notedIds(cleared), [], 'and it leaves no empty string behind');
});

test('notes: over length is CUT, never refused', () => {
    // Cutting an over-long note keeps what was typed, where a refusal would lose it in the middle of a pick. The cap is 1,000 characters, since a note runs to several lines.
    const long = 'x'.repeat(1400);
    const notes = setNote(emptyNotes('k'), 7, long);
    assertEq(noteFor(notes, 7).length, 1000, 'cut to the limit');
    assertEq(noteFor(notes, 7), 'x'.repeat(1000), 'from the front, so the first words survive');
    assertEq(noteFor(setNote(emptyNotes('k'), 7, 'x'.repeat(400)), 7).length, 400,
        'and what the old 280 refused now fits whole');
});

test('notes: they are about a PLAYER, so a rehearsal and a log leave them alone', () => {
    // Nothing in the model names a round, a pick or a draft state, which is why a note survives all three. Logging the player and re-ranking the board around the player changes nothing.
    let notes = setNote(emptyNotes('k'), 'a', 'never again');
    notes = setNote(notes, 'b', 'take at 12');
    let log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 1, playerId: 'a' });
    log = applyLoggedPick(log, { overall: 2, teamId: 2, playerId: 'b' });
    assertEq(noteFor(notes, 'a'), 'never again', 'the drafted player keeps their note');
    assertJson(notedIds(notes).sort(), ['a', 'b'], 'and so does everyone else');
    assertJson(remainingPool([{ id: 'a' }, { id: 'b' }, { id: 'c' }], log).map(p => p.id), ['c'],
        'the board shrank; the notes did not');
});

test('notes: nothing to write on, and nothing to write', () => {
    assertJson(setNote(null, 5, 'hi').notes, { 5: 'hi' }, 'no notes object yet is an empty one');
    const notes = setNote(emptyNotes('k'), 5, 'hi');
    assertEq(setNote(notes, null, 'hi'), notes, 'no player, no write - the same object back');
    assertEq(noteFor(null, 5), null, 'nothing stored');
    assertEq(noteFor(notes, null), null, 'nobody asked about');
    assertJson(notedIds(null), [], 'no notes at all');
});

// ==== what a refused pick can SAY, and the team (item (h)) ====
test('loggedPickRefusal: null when the pick would be accepted, including any team', () => {
    const log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 1, playerId: 'a' });
    assertEq(loggedPickRefusal(log, { overall: 2, teamId: 4, playerId: 'b' }), null, 'the next pick, another team');
    assertEq(loggedPickRefusal(log, { teamId: 4, playerId: 'b' }), null, 'overall omitted means the next one');
    // The team is never checked: a keeper or an out-of-order pick belonging to someone else is exactly what the strip own select is for, and a pick with no team at all is still true.
    assertEq(loggedPickRefusal(log, { overall: 2, teamId: 999, playerId: 'b' }), null, 'a team this league may not have');
    assertEq(loggedPickRefusal(log, { overall: 2, playerId: 'b' }), null, 'no team named at all');
    assertEq(applyLoggedPick(log, { overall: 2, teamId: 999, playerId: 'b' }).picks.length, 2, 'and it logs');
});

test('loggedPickRefusal: the four refusals, each with its own words', () => {
    let log = applyLoggedPick(emptyLog(), { overall: 1, teamId: 1, playerId: 'a' });
    log = applyLoggedPick(log, { overall: 2, teamId: 2, playerId: 'b' });

    const dup = loggedPickRefusal(log, { overall: 3, teamId: 3, playerId: 'a' });
    assertEq(dup.kind, 'already-logged', 'the same player twice');
    assertEq(dup.reason, 'Already logged at pick 1.', 'and where they went');

    const skip = loggedPickRefusal(log, { overall: 5, teamId: 3, playerId: 'c' });
    assertEq(skip.kind, 'out-of-sequence', 'a pick out of order');
    assertEq(skip.reason, 'Pick 3 is next. Undo back to 5 to change it.', 'what is next, and what to do');

    assertEq(loggedPickRefusal(log, { overall: 3, teamId: 3 }).kind, 'no-player', 'nobody named');
    assertEq(loggedPickRefusal(log, null).reason, 'Pick a player to log.', 'and no pick at all reads the same');
    assertEq(loggedPickRefusal(null, { playerId: 'x' }).kind, 'no-log', 'no log to add to');

    // Every one of those is a refusal applyLoggedPick makes by returning the same object. This only says why.
    assertEq(applyLoggedPick(log, { overall: 3, teamId: 3, playerId: 'a' }), log, 'identity, unchanged');
    assertEq(applyLoggedPick(log, { overall: 5, teamId: 3, playerId: 'c' }), log, 'identity, unchanged');
});

// ==== one seating rule for all three (item (f)) ====
const SEAT_POOL = [
    { id: 'A', value: 10, eligiblePositions: ['OF'] },
    { id: 'B', value: 6, eligiblePositions: ['OF'] },
    { id: 'K', value: 3, eligiblePositions: ['K'] }
];
const TWO_OF = [
    { slotId: 1, label: 'OF', playerId: null, bench: false },
    { slotId: 1, label: 'OF', playerId: null, bench: false }
];

test('seatAll: a plain list of players seated by the plan own rule', () => {
    const out = seatAll(['A', 'B', 'K'], SEAT_POOL, TWO_OF);
    assertJson(out.state.seats.map(s => s.playerId), ['A', 'B'], 'first empty seat that accepts them, in order');
    assertEq(out.summary.total, 16, 'the mock lineup own figure, not a second computation');
    assertEq(out.unseated.length, 1, 'the kicker fits nowhere');
    assertEq(out.unseated[0].playerId, 'K', 'and is named');
    assertEq(out.unseated[0].round, undefined, 'a list has no round to report, unlike a plan');
    assertJson(seatAll([], SEAT_POOL, TWO_OF).state.seats.map(s => s.playerId), [null, null], 'nobody seats nobody');
});

test('seatAll: the order players arrive in decides who takes the seat', () => {
    // Two outfield seats and three outfielders: the two that arrive first hold them, whatever they are worth. A log arrives in draft order and a plan in plan order, and neither re-sorts.
    const three = [...SEAT_POOL, { id: 'C', value: 99, eligiblePositions: ['OF'] }];
    const out = seatAll(['A', 'B', 'C'], three, TWO_OF);
    assertJson(out.state.seats.map(s => s.playerId), ['A', 'B'], 'the first two, not the best two');
    assertEq(out.unseated[0].playerId, 'C', 'the late arrival is reported rather than swapped in');
});

test('logSeats: a logged team roster, seated the same way', () => {
    const log = { picks: [
        { overall: 1, teamId: 1, playerId: 'A' },
        { overall: 2, teamId: 2, playerId: 'B' },
        { overall: 3, teamId: 1, playerId: 'K' }
    ] };
    const mine = logSeats(log, 1, SEAT_POOL, TWO_OF);
    assertJson(mine.state.seats.map(s => s.playerId), ['A', null], 'only my own picks are seated');
    assertEq(mine.unseated[0].playerId, 'K', 'and my kicker still fits nowhere');
    const theirs = logSeats(log, 2, SEAT_POOL, TWO_OF);
    assertJson(theirs.state.seats.map(s => s.playerId), ['B', null], 'another team own roster');
    assertJson(logSeats(log, 9, SEAT_POOL, TWO_OF).state.seats.map(s => s.playerId), [null, null],
        'a team that has not picked seats nobody');
});

// ==== the log's own rosters, coverage and needs (e) Four teams, two categories (HR '5' and, inverted, ERA '47'), and a log of six picks. Every figure below is worked by hand from these lines. ====
const LOG_LINES = {
    a1: { '5': 30, '47': 3.0 }, a2: { '5': 10, '47': 1.0 },
    b1: { '5': 20, '47': 2.0 }, b2: { '5': 5, '47': 2.0 },
    c1: { '5': 12, '47': 4.0 }, d1: { '5': 1, '47': 9.0 }
};
const LOG_POS = { a1: ['C'], a2: ['SS'], b1: ['C'], b2: ['OF'], c1: ['C'], d1: ['OF'] };
const SIX = { picks: [
    { overall: 1, teamId: 1, playerId: 'a1' }, { overall: 2, teamId: 2, playerId: 'b1' },
    { overall: 3, teamId: 3, playerId: 'c1' }, { overall: 4, teamId: 4, playerId: 'd1' },
    { overall: 5, teamId: 2, playerId: 'b2' }, { overall: 6, teamId: 1, playerId: 'a2' }
] };

test('rostersFromLog: the picks grouped by team, in draft order', () => {
    const { byTeam, unassigned } = rostersFromLog(SIX);
    assertJson(byTeam['1'], ['a1', 'a2'], 'team 1 own two, in the order they were taken');
    assertJson(byTeam['2'], ['b1', 'b2'], 'team 2 own two');
    assertJson(Object.keys(byTeam).sort(), ['1', '2', '3', '4'], 'every team that has picked');
    assertJson(unassigned, [], 'nothing unattributed here');
});

test('rostersFromLog: a pick with no team is KEPT, not dropped', () => {
    // applyLoggedPick accepts a pick whose teamId is null, which is a reader logging what came off the board without saying whose it was, and the taken list must still agree with the log.
    const mixed = { picks: [{ overall: 1, teamId: null, playerId: 'x' }, { overall: 2, teamId: 3, playerId: 'y' }] };
    const { byTeam, unassigned } = rostersFromLog(mixed);
    assertJson(unassigned, ['x'], 'held, for the caller to cross off the board');
    assertJson(byTeam['3'], ['y'], 'and the attributed pick is where it belongs');
    assertJson(rostersFromLog(null), { byTeam: {}, unassigned: [] }, 'no log at all');
});

test('logCoverage: the same calls the rehearsal makes, over the log own picks', () => {
    // Team 1 holds a1 + a2: HR 40, ERA 4.0 summed (rosterTotals sums a raw category). HR 40 beats team 2's 25, team 3's 12 and team 4's 1 - three of three. ERA is inverse and coverageOf gives a TIE half a team: team 1's 4.0 ties team 2's 4.0 and team 3's 4.0 and beats team 4's 9.0, which is (0.5 + 0.5 + 1) / 3 = 0.667.
    const cov = logCoverage(SIX, {
        teamId: 1, teamIds: [1, 2, 3, 4], categoryIds: ['5', '47'],
        lineOf: (id) => LOG_LINES[id], inverseIds: new Set(['47'])
    });
    const byId = new Map(cov.map(c => [c.id, c]));
    assertEq(byId.get('5').value, 40, 'the summed home runs');
    assertEq(byId.get('5').share, 1, 'ahead of all three');
    assertEq(byId.get('47').value, 4, 'the summed ERA, as rosterTotals sums it');
    assertEq(Math.round(byId.get('47').share * 1000) / 1000, 0.667, 'two ties and a win, inverse');
});

test('logCoverage: a team that has not picked still counts as a team', () => {
    // Only team 1 has picked. Its one category beats the three empty teams, which is a real answer: an empty roster has nothing in that category, which is not an unknown.
    const one = { picks: [{ overall: 1, teamId: 1, playerId: 'a1' }] };
    const cov = logCoverage(one, {
        teamId: 1, teamIds: [1, 2, 3, 4], categoryIds: ['5'], lineOf: (id) => LOG_LINES[id]
    });
    assertEq(cov[0].share, 1, 'ahead of the three who have not picked');
    // Without the league own team list it can only compare the teams in the log.
    const alone = logCoverage(one, { teamId: 1, categoryIds: ['5'], lineOf: (id) => LOG_LINES[id] });
    assertEq(alone[0].share, null, 'nobody to compare with says nothing, never 100%');
});

test('logNeeds: what a team still needs, off the log', () => {
    // The league starts 2 C, 1 SS, 2 OF. Team 1 has taken a C and an SS.
    const slots = { C: 2, SS: 1, OF: 2 };
    const need = logNeeds(SIX, 1, { positionsOf: (id) => LOG_POS[id], slots });
    assertJson(need, { C: 1, SS: 0, OF: 2 }, 'one more catcher, the shortstop done, both outfielders open');
    assertJson(logNeeds(SIX, 9, { positionsOf: (id) => LOG_POS[id], slots }), { C: 2, SS: 1, OF: 2 },
        'a team that has not picked needs everything');
});

// The three switches. Contract: tests/fixtures/draft-plan.md Amendment 6. The day cases below use a draft set for 14:00 local time on one day.
const DRAFT_DAY = new Date(2026, 8, 26, 14, 0).getTime();
const OFF = { plan: false, rehearse: false, log: false };
const click = (name, on) => ({ name, on });

test('resolveDraftSwitches: Log picks turns itself on when the draft is TODAY, once', () => {
    const morning = new Date(2026, 8, 26, 8, 30).getTime();
    const first = resolveDraftSwitches(OFF, { draftDate: DRAFT_DAY, now: morning });
    assertEq(first.log, true, 'draft day: the log is on before anyone clicks');
    assertEq(first.autoApplied, true, 'and the caller carries that back');
    // The reader turns it off; the rule does not fire a second time and turn it back on.
    const off = resolveDraftSwitches(first, { draftDate: DRAFT_DAY, now: morning, autoApplied: true, request: click('log', false) });
    assertEq(off.log, false, 'the reader wins');
    const later = resolveDraftSwitches(off, { draftDate: DRAFT_DAY, now: new Date(2026, 8, 26, 21, 0).getTime(), autoApplied: true });
    assertEq(later.log, false, 'and it stays off all evening');
});

test('resolveDraftSwitches: today is a calendar DAY, not a 24-hour window', () => {
    const justBefore = new Date(2026, 8, 26, 0, 5).getTime();
    assertEq(resolveDraftSwitches(OFF, { draftDate: DRAFT_DAY, now: justBefore }).log, true,
        'fourteen hours before the pick, still draft day');
    const nightBefore = new Date(2026, 8, 25, 23, 55).getTime();
    assertEq(resolveDraftSwitches(OFF, { draftDate: DRAFT_DAY, now: nightBefore }).log, false, 'five minutes earlier is not');
    const dayAfter = new Date(2026, 8, 27, 9, 0).getTime();
    assertEq(resolveDraftSwitches(OFF, { draftDate: DRAFT_DAY, now: dayAfter }).log, false, 'and the morning after is not');
});

test('resolveDraftSwitches: a league with no draft date never auto-fires', () => {
    const r = resolveDraftSwitches(OFF, { draftDate: null, now: DRAFT_DAY });
    assertEq(r.log, false, 'one click instead');
    assertEq(r.autoApplied, false, 'and nothing was applied to remember');
    assertEq(resolveDraftSwitches(OFF, { draftDate: 0, now: DRAFT_DAY }).log, false, 'ESPN own unscheduled zero is not a date');
});

test('resolveDraftSwitches: Rehearse and Log picks are exclusive, Plan is independent', () => {
    const planOn = resolveDraftSwitches(OFF, { request: click('plan', true) });
    assertEq(planOn.plan, true, 'Plan on');
    const both = resolveDraftSwitches(planOn, { request: click('log', true) });
    assertEq(both.plan && both.log, true, 'Plan and Log picks together - the ruled draft-day face');
    const rehearsing = resolveDraftSwitches(both, { request: click('rehearse', true), loggedPicks: 0 });
    assertEq(rehearsing.rehearse, true, 'Rehearse on');
    assertEq(rehearsing.log, false, 'turned the log off - one board cannot hold two drafts');
    assertEq(rehearsing.plan, true, 'and Plan is untouched by either');
    const backToLog = resolveDraftSwitches(rehearsing, { request: click('log', true) });
    assertEq(backToLog.log && !backToLog.rehearse, true, 'and the other way round');
});

test('resolveDraftSwitches: Rehearse is REFUSED once the log holds a pick, with the reason', () => {
    const logging = { plan: false, rehearse: false, log: true };
    const r = resolveDraftSwitches(logging, { request: click('rehearse', true), loggedPicks: 12 });
    assertEq(r.rehearse, false, 'not turned on');
    assertEq(r.log, true, 'and the log is left exactly as it was');
    assertEq(r.refused.name, 'rehearse', 'the strip is told which switch');
    assertEq(r.refused.reason, 'Log picks holds 12 picks. Undo them to rehearse.', 'and what to do about it');
    assertEq(resolveDraftSwitches(logging, { request: click('rehearse', true), loggedPicks: 1 }).refused.reason,
        'Log picks holds 1 pick. Undo them to rehearse.', 'one pick reads as one pick');
    // Undone back to empty, it is available again. The refusal is about the state and is not a latch.
    assertEq(resolveDraftSwitches(logging, { request: click('rehearse', true), loggedPicks: 0 }).rehearse, true, 'available again');
});

test('resolveDraftSwitches: turning a switch OFF is never refused', () => {
    const rehearsing = { plan: true, rehearse: true, log: false };
    const r = resolveDraftSwitches(rehearsing, { request: click('rehearse', false), loggedPicks: 30 });
    assertEq(r.rehearse, false, 'off, whatever the log holds');
    assertEq(r.refused, null, 'and nothing to print');
    assertEq(resolveDraftSwitches(null, {}).plan, false, 'no state at all is all off');
    assertEq(resolveDraftSwitches(OFF, { request: { name: 'nonsense', on: true } }).log, false, 'an unknown switch changes nothing');
});

// ==== The log does not vanish under a live room ====

test('logSurvivesReset: the same league fetched again keeps its log', () => {
    // The failure this ends: data.js resets every tab on ANY non-revalidate fetch and cannot tell a new league from the same one again, so a board could empty itself under a reader mid-draft.
    assertEq(logSurvivesReset('flb:12345', 'flb:12345'), true, 'the same key is the same log');
    assertEq(logSurvivesReset('flb:12345', 'flb:99999'), false, 'a different league');
    assertEq(logSurvivesReset('flb:12345', 'fhl:12345'), false, 'the same id in another sport is another league');
});

test('logSurvivesReset: nothing to keep, or nowhere to keep it, is false', () => {
    assertEq(logSurvivesReset(null, 'flb:12345'), false, 'no log loaded yet');
    assertEq(logSurvivesReset(undefined, 'flb:12345'), false, 'nor undefined');
    assertEq(logSurvivesReset('flb:12345', null), false, 'no key to keep it for');
    assertEq(logSurvivesReset(null, null), false, 'neither');
});

test('storedLogApplies: the stored log wins only at the start', () => {
    const stored = { picks: [{ overall: 1, playerId: 9001 }, { overall: 2, playerId: 9002 }] };
    assertEq(storedLogApplies(emptyLog(), stored), true, 'an empty memory is what the read is for');
    assertEq(storedLogApplies(null, stored), true, 'and no log at all yet');
});

test('storedLogApplies: a read may not discard what landed while it was in flight', () => {
    // The race: a read begun at page open resolving AFTER a room merge had already landed used to replace the merged log with the older one, which is a board emptying itself.
    const merged = { picks: [{ overall: 1, playerId: 9001 }] };
    assertEq(storedLogApplies(merged, { picks: [] }), false, 'an older, emptier read is refused');
    assertEq(storedLogApplies(merged, { picks: [{ overall: 1, playerId: 9001 }] }), false,
        'and an equal one too - memory is never staler than storage, so there is nothing to gain');
});

test('storedLogApplies: a missing or malformed stored log is never applied', () => {
    assertEq(storedLogApplies(emptyLog(), null), false, 'nothing stored');
    assertEq(storedLogApplies(emptyLog(), {}), false, 'no picks array');
    assertEq(storedLogApplies(emptyLog(), { picks: 'nope' }), false, 'not an array');
});

test('roomPicksClearOffer: only a room of ANOTHER league is ever offered for clearing', () => {
    // The chain this guards against: another connection closes, the room reads as not active, and the offer to clear fires over a live draft's own picks, because no room open at this moment was its whole trigger.
    const base = { isRehearse: false, roomActive: false, foreign: true, hasRoomPicks: true };
    assertEq(roomPicksClearOffer(base), true, 'another league room, gone, with picks in the log');
    assertEq(roomPicksClearOffer({ ...base, foreign: false }), false,
        'THIS league own picks are its real draft history, whatever the socket is doing');
    assertEq(roomPicksClearOffer({ ...base, roomActive: true }), false, 'a live room picks stay off limits');
    assertEq(roomPicksClearOffer({ ...base, hasRoomPicks: false }), false, 'nothing to clear');
    assertEq(roomPicksClearOffer({ ...base, isRehearse: true }), false, 'a rehearsal is its own world');
});

test('roomPicksClearOffer: unknown provenance never offers - keeping is the safe direction', () => {
    // A restarted extension cannot know which league a stored log room picks came from; nothing in a pick records it. The failure this replaces deleted a real draft on exactly that uncertainty.
    assertEq(roomPicksClearOffer({ roomActive: false, hasRoomPicks: true }), false, 'foreign defaults false');
    assertEq(roomPicksClearOffer({}), false, 'and an empty ask offers nothing');
    assertEq(roomPicksClearOffer(), false, 'as does no ask at all');
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
