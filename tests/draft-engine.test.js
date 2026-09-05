// Unit tests for the pure draft engine. Open tests/draft-engine.test.html through any static server (python -m http.server is a zero-dependency option) - green means every assertion held. Every expected value is hand-computed from the rules written on the functions.
import {
    projectedLine, tierBreaks, tierOf, adpVerdict, survivalWord, draftOrder, picksFor,
    scarcityOf, assignBodies, positionDepth, positionDepths, replacementByGroup, pricingGroupFor, seededRandom, botPick, startingSlotsByGroup, replacementLevel,
    estimateUnprojected, sumOfEdges,
    initialDraftState, applyPick, draftComplete, teamOnClock, simToTeam, openNeeds,
    runDetect, coverageOf, holesFrom, threatCount, rosterTotals,
    sumOfEdgesAcross, degenerateValue
} from '../draft-engine.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: got ${a}, expected ${b}`);
}

test('projectedLine: source 1, split 0, the season asked for; nothing else', () => {
    const stats = [
        { statSourceId: 0, statSplitTypeId: 0, seasonId: 2026, stats: { '5': 10 } },
        { statSourceId: 1, statSplitTypeId: 0, seasonId: 2026, stats: { '5': 32 } },
        { statSourceId: 1, statSplitTypeId: 0, seasonId: 2025, stats: { '5': 30 } }
    ];
    assertEq(projectedLine(stats, 2026), { '5': 32 }, 'the 2026 projection');
    assertEq(projectedLine(stats, 2027), null, 'no projection is null, not zero');
    assertEq(projectedLine(null, 2026), null, 'no stats at all');
});

test('tierBreaks: a break opens at a gap of minGap or more', () => {
    const ranked = [98, 94, 93, 86, 85, 80].map(value => ({ value }));
    // gaps: 4, 1, 7, 1, 5 -> breaks before 94 (gap 4), 86 (gap 7), 80 (gap 5)
    assertEq(tierBreaks(ranked, { minGap: 4, maxSize: 12 }), [0, 1, 3, 5], 'three breaks');
    assertEq(tierOf(0, [0, 1, 3, 5]), 1, 'first is tier one');
    assertEq(tierOf(2, [0, 1, 3, 5]), 2, 'index 2 is tier two');
    assertEq(tierOf(5, [0, 1, 3, 5]), 4, 'last is tier four');
});

test('tierBreaks: a flat run is cut at its widest gap once it passes maxSize', () => {
    // 90, 89, 88, 87, 85, 84, 83: no gap reaches 4; maxSize 4 forces a cut at the widest gap inside the first five (87 -> 85, gap 2), so the break lands at index 4.
    const ranked = [90, 89, 88, 87, 85, 84, 83].map(value => ({ value }));
    assertEq(tierBreaks(ranked, { minGap: 4, maxSize: 4 }), [0, 4], 'cut at the widest gap');
    assertEq(tierBreaks([{ value: 1 }], {}), [0], 'one player, one tier');
});

test('adpVerdict: falling and reach inside a band that scales with the rank', () => {
    // rank 10: tolerance max(6, round(2.5)) = 6
    assertEq(adpVerdict(10, 16), 'falling', 'ADP 16 for the tenth-best is falling');
    assertEq(adpVerdict(10, 15), '', 'five is inside the band');
    assertEq(adpVerdict(10, 4), 'reach', 'taken sixth when ranked tenth');
    // rank 100: tolerance max(6, 25) = 25
    assertEq(adpVerdict(100, 120), '', 'twenty is inside a quarter of 100');
    assertEq(adpVerdict(100, 126), 'falling', 'twenty-six is not');
    assertEq(adpVerdict(0, 10), '', 'no rank, no verdict');
});

test('survivalWord: words off the distance between ADP and the next pick', () => {
    assertEq(survivalWord(38, 54, 43), 'no', 'ADP 38 at pick 43 is already gone by the crowd');
    assertEq(survivalWord(45, 54, 43), 'unlikely', 'nine short of the next pick');
    assertEq(survivalWord(57, 54, 43), 'coin flip', 'three past it');
    assertEq(survivalWord(61, 54, 43), 'likely', 'seven past it');
    assertEq(survivalWord(44, 60, 43), 'no', 'sixteen picks of room is a round early');
    assertEq(survivalWord(0, 54, 43), '', 'no ADP, no word');
});

test('draftOrder and picksFor: snake reverses even rounds, linear repeats', () => {
    const order = draftOrder([6, 1, 4], 3, 'SNAKE');
    assertEq(order, [6, 1, 4, 4, 1, 6, 6, 1, 4], 'three rounds of three');
    assertEq(picksFor(order, 4), [3, 4, 9], 'team 4 picks 3, 4 and 9');
    assertEq(draftOrder([6, 1, 4], 2, 'LINEAR'), [6, 1, 4, 6, 1, 4], 'linear');
});

test('scarcityOf: deep, thin and cliff against the starters still to fill', () => {
    assertEq(scarcityOf(30, 12).word, 'deep', '2.5x');
    assertEq(scarcityOf(20, 12).word, '', '1.67x says nothing');
    assertEq(scarcityOf(16, 12).word, 'short', '1.33x');
    assertEq(scarcityOf(10, 12).word, 'cliff', 'fewer than the slots');
    assertEq(scarcityOf(10, 0).word, '', 'no starters, no word');
});

test('seededRandom: deterministic, in [0, 1)', () => {
    const a = seededRandom(7), b = seededRandom(7);
    const xs = [a(), a(), a()], ys = [b(), b(), b()];
    assertEq(xs, ys, 'same seed, same stream');
    assert(xs.every(x => x >= 0 && x < 1), 'unit interval');
    assert(seededRandom(8)() !== xs[0], 'a different seed differs');
});

test('botPick: prefers a need inside the window, never reaches past it', () => {
    const pool = [
        { id: 1, positions: ['G'] }, { id: 2, positions: ['C'] }, { id: 3, positions: ['D'] },
        { id: 4, positions: ['D'] }, { id: 5, positions: ['W'] }, { id: 6, positions: ['C'] },
        { id: 7, positions: ['D'] }
    ];
    // variance 0 -> span 1: the top player, need or not
    assertEq(botPick(pool, { D: 1 }, 0, () => 0.99).id, 1, 'no variance takes the best');
    // variance 0.5 -> span 3: players 1..3, the D need picks player 3
    assertEq(botPick(pool, { D: 1 }, 0.5, () => 0.99).id, 3, 'the need inside the window');
    // variance 1 -> span 6: needs W -> only player 5 fills
    assertEq(botPick(pool, { W: 1 }, 1, () => 0.1).id, 5, 'the lone fill');
    // a need nobody in the window fills falls back to the window itself, rand 0 -> first
    assertEq(botPick(pool, { X: 1 }, 1, () => 0).id, 1, 'no fill, best of the window');
    assertEq(botPick([], { D: 1 }, 1, () => 0), null, 'empty pool');
});

test('startingSlotsByGroup: bench and injury slots never count, pitching splits off', () => {
    // A real baseball construction: 1 C, 1 1B, 1 2B, 1 3B, 1 SS, 3 OF, 1 UTIL = 1+1+1+1+1+3+1 = 9 starting batters; 1 P + 1 SP + 3 RP = 5 starting pitchers; 16 BE and 17 IL are seats, not jobs.
    const counts = { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 3, '12': 1, '13': 1, '14': 1, '15': 3, '16': 5, '17': 2 };
    assertEq(startingSlotsByGroup(counts, { nonStarting: new Set([16, 17]), secondary: new Set([13, 14, 15]) }),
        { primary: 9, secondary: 5 }, 'nine batters, five pitchers');

    // Hockey: 3 F, 4 D, 1 G, 1 UTIL -> the utility slot is a skater seat, the goalie is its own.
    const hockey = { '3': 3, '4': 4, '5': 1, '6': 1, '7': 4, '8': 1 };
    assertEq(startingSlotsByGroup(hockey, { nonStarting: new Set([7, 8]), secondary: new Set([5]) }),
        { primary: 8, secondary: 1 }, 'eight skaters, one goalie');

    // A slot the league does not roster contributes nothing, and neither does a negative.
    assertEq(startingSlotsByGroup({ '0': 0, '5': -1, '14': 2 }, { nonStarting: new Set(), secondary: new Set([14]) }),
        { primary: 0, secondary: 2 }, 'zero and negative counts ignored');
    assertEq(startingSlotsByGroup(null, {}), { primary: 0, secondary: 0 }, 'no settings at all');
});

test('replacementLevel: the starters-th best, 1-based, floored by the pool', () => {
    const scores = [90, 82, 77, 71, 64, 51];
    assertEq(replacementLevel(scores, 1), 90, 'one starter -> the best player is their own replacement');
    assertEq(replacementLevel(scores, 3), 77, 'the third best');
    assertEq(replacementLevel(scores, 6), 51, 'the last one exactly');
    // Shallower than the league starts: the last player stands in rather than dropping to zero.
    assertEq(replacementLevel(scores, 9), 51, 'fewer players than starting slots');
    // Order of the input must not matter.
    assertEq(replacementLevel([51, 90, 71, 77, 64, 82], 3), 77, 'unsorted input');
    assertEq(replacementLevel(scores, 0), 90, 'a zero starter count floors at one');
    assertEq(replacementLevel([], 4), null, 'no players is null, not zero');
    // Non-numbers are not scores.
    assertEq(replacementLevel([90, null, undefined, NaN, 60], 2), 60, 'only finite scores count');
});

test('replacementLevel: value over replacement is signed, and zero means replaceable', () => {
    // Hand-computed: 12 teams x 2 goalies = 24 starters; the 24th best goalie scores 55.0.
    const goalies = Array.from({ length: 40 }, (_, i) => 90 - i * 1.5);
    // index 23 (the 24th) = 90 - 34.5 = 55.5
    assertEq(replacementLevel(goalies, 24), 55.5, 'the 24th best goalie');
    const best = 90 - replacementLevel(goalies, 24);
    assertEq(best, 34.5, 'the best goalie is 34.5 above the player you could have anyway');
    // A player at exactly replacement is worth nothing over it, and one below is worth less.
    assertEq(55.5 - replacementLevel(goalies, 24), 0, 'replacement level itself is zero');
    assertEq(replacementLevel(goalies, 40) - replacementLevel(goalies, 24), -24, 'below replacement is negative');
});

test('estimateUnprojected: last season rate carried over projected games', () => {
    // 300 assists in 150 games is 2 per game; projected for 140 games -> 2 * 140 = 280. 15 errors in 150 games is 0.1 per game; 0.1 * 140 = 14.
    const projected = { '81': 140, '5': 30 };
    const last = { '81': 150, '69': 300, '72': 15 };
    const out = estimateUnprojected(projected, last, ['69', '72'], { gamesId: '81' });
    assertEq(out.line['69'], 280, 'assists carried forward');
    assertEq(out.line['72'], 14, 'errors carried forward');
    assertEq(out.estimated, ['69', '72'], 'both reported as estimated');
    // The projection itself is untouched, and what it already carries is never overwritten.
    assertEq(projected['69'], undefined, 'the input line is not mutated');
    assertEq(out.line['5'], 30, 'a projected category is left exactly as it was');
});

test('estimateUnprojected: a category the projection already carries is never estimated', () => {
    const out = estimateUnprojected({ '81': 100, '69': 42 }, { '81': 150, '69': 300 }, ['69'], { gamesId: '81' });
    assertEq(out.line['69'], 42, 'the real projection wins');
    assertEq(out.estimated, [], 'nothing was estimated');
});

test('estimateUnprojected: no answer means no number, never a zero', () => {
    const ids = ['69'];
    // No prior season at all - a rookie.
    let out = estimateUnprojected({ '81': 140 }, null, ids, { gamesId: '81' });
    assertEq(out.line['69'], undefined, 'a rookie has no estimate, and no zero either');
    assertEq(out.estimated, [], 'and is not reported as estimated');
    // A prior season that was not played.
    out = estimateUnprojected({ '81': 140 }, { '81': 0, '69': 0 }, ids, { gamesId: '81' });
    assertEq(out.line['69'], undefined, 'zero games last season cannot make a rate');
    // Projected for no games at all - there is nothing to scale onto.
    out = estimateUnprojected({ '81': 0 }, { '81': 150, '69': 300 }, ids, { gamesId: '81' });
    assertEq(out.line['69'], undefined, 'no projected games, no estimate');
    // Games missing from the projection entirely.
    out = estimateUnprojected({ '5': 12 }, { '81': 150, '69': 300 }, ids, { gamesId: '81' });
    assertEq(out.line['69'], undefined, 'no games id in the projection');
});

test('estimateUnprojected: rate categories are never scaled by games', () => {
    // AVG is a rate: 0.300 over 150 games times 140 games is 42, which is nonsense.
    const out = estimateUnprojected({ '81': 140 }, { '81': 150, '2': 0.3, '69': 300 }, ['2', '69'],
        { gamesId: '81', rateIds: new Set(['2']) });
    assertEq(out.line['2'], undefined, 'the rate is left alone');
    assertEq(out.line['69'], 280, 'the counting category beside it still estimates');
    assertEq(out.estimated, ['69'], 'only the counting one is reported');
});

test('sumOfEdges: a wide player beats a narrow one on the same average edge', () => {
    // The whole reason this replaced a mean. Both players are +10 in every category they move. The nine-category player moves nine of them, the five-category player five.
    const repl = new Map();
    const wideP = new Map(), narrowP = new Map();
    for (let i = 0; i < 9; i++) { repl.set('c' + i, 50); wideP.set('c' + i, 60); }
    for (let i = 0; i < 5; i++) narrowP.set('c' + i, 60);
    assertEq(sumOfEdges(wideP, repl), 90, 'nine categories at +10');
    assertEq(sumOfEdges(narrowP, repl), 50, 'five categories at +10');
    assert(sumOfEdges(wideP, repl) > sumOfEdges(narrowP, repl), 'the wider player ranks ahead');
    // A mean would have called them equal, which is the behaviour being replaced.
    assertEq(sumOfEdges(wideP, repl) / wideP.size, sumOfEdges(narrowP, repl) / narrowP.size,
        'their MEANS are identical, which is exactly the information a mean throws away');
});

test('sumOfEdges: below replacement is negative, and mixed edges net out', () => {
    const repl = new Map([['a', 50], ['b', 50], ['c', 50]]);
    assertEq(sumOfEdges(new Map([['a', 40], ['b', 40], ['c', 40]]), repl), -30, 'three categories at -10');
    // +40, -20 and level: 90-50 = +40, 30-50 = -20, 50-50 = 0, which sums to +20.
    assertEq(sumOfEdges(new Map([['a', 90], ['b', 30], ['c', 50]]), repl), 20, 'mixed edges net out');
    // And a genuinely balanced pair really does cancel: +40 against -40.
    assertEq(sumOfEdges(new Map([['a', 90], ['b', 10], ['c', 50]]), repl), 0, 'equal and opposite cancel');
    assertEq(sumOfEdges(new Map([['a', 50]]), repl), 0, 'a player exactly at replacement');
});

test('sumOfEdges: a category the player has no figure in contributes nothing', () => {
    const repl = new Map([['a', 50], ['b', 80], ['c', 50]]);
    // No 'b' at all. The replacement's 80 there must not be charged to this player.
    assertEq(sumOfEdges(new Map([['a', 70], ['c', 60]]), repl), 30, 'only their own categories count');
    assertEq(sumOfEdges(new Map(), repl), null, 'no categories at all is null, not zero');
    assertEq(sumOfEdges(null, repl), null, 'no map at all');
});

test('sumOfEdges: a category the REPLACEMENT cannot be measured in falls back to the middle', () => {
    // A closer against a replacement-level starter who is gated out of saves: the starter has no percentile there at all, and the closer's edge must not evaporate.
    const repl = new Map([['k', 50]]);
    assertEq(sumOfEdges(new Map([['k', 60], ['sv', 95]]), repl), 55, '+10 in K, +45 over a neutral 50 in SV');
    // And the fallback is neutral rather than generous: a player at the middle gains nothing.
    assertEq(sumOfEdges(new Map([['sv', 50]]), repl), 0, 'level with an unmeasurable replacement is zero');
});

test('draft state: a pick is a new state and never a mutation', () => {
    const order = [1, 2, 2, 1];
    const s0 = initialDraftState(order, 7);
    assertEq(teamOnClock(s0), 1, 'team 1 opens');
    const s1 = applyPick(s0, 'a');
    assertEq(s0.pickIndex, 0, 'the original state is untouched');
    assertEq(s0.picks.length, 0, 'and so are its picks');
    assertEq(s1.pickIndex, 1, 'the new state advanced');
    assertEq(s1.rosters[1], ['a'], 'the pick landed on the right roster');
    assertEq(s1.picks, [{ pick: 1, teamId: 1, playerId: 'a' }], 'and is recorded with its number');
    // Undo is just the state you kept.
    assertEq(teamOnClock(s0), 1, 'the earlier state still has team 1 on the clock');
    // A pick with nobody in it changes nothing at all, which is what stops a sim loop spinning.
    assert(applyPick(s1, null) === s1, 'a null pick returns the very same state');
    const done = applyPick(applyPick(applyPick(s1, 'b'), 'c'), 'd');
    assert(draftComplete(done), 'four picks fill a four-pick order');
    assertEq(teamOnClock(done), null, 'nobody is on the clock after the last pick');
    assert(applyPick(done, 'e') === done, 'and a pick past the end changes nothing');
});

test('simToTeam: runs the bots up to your turn and refuses to spin', () => {
    // Snake over two teams, three rounds: 1 2 2 1 1 2
    const order = draftOrder([1, 2], 3, 'SNAKE');
    assertEq(order, [1, 2, 2, 1, 1, 2], 'the snake order this runs on');
    const s0 = initialDraftState(order, 1);
    // Team 1 is already on the clock, so nothing happens.
    assert(simToTeam(s0, 1, () => 'x') === s0, 'already your turn is a no-op');
    // From pick 2, run until team 1 is up again: two bot picks.
    let n = 0;
    const s1 = applyPick(s0, 'p1');
    const s2 = simToTeam(s1, 1, () => 'bot' + (++n));
    assertEq(s2.pickIndex, 3, 'two bot picks were made');
    assertEq(s2.rosters[2], ['bot1', 'bot2'], 'both landed on team 2');
    assertEq(teamOnClock(s2), 1, 'and team 1 is on the clock');
    // A pool with nobody left stops rather than looping forever.
    const stuck = simToTeam(s1, 1, () => null);
    assertEq(stuck.pickIndex, 1, 'no candidate means no progress and no hang');
});

test('openNeeds: open starting slots, a multi-position player counting against each', () => {
    const slots = { C: 1, OF: 3, SP: 2 };
    assertEq(openNeeds([], slots), { C: 1, OF: 3, SP: 2 }, 'an empty roster needs everything');
    // One catcher and one outfielder taken.
    assertEq(openNeeds([['C'], ['OF']], slots), { C: 0, OF: 2, SP: 2 }, 'one of each filled');
    // A C/OF counts against BOTH, which is the documented overstatement.
    assertEq(openNeeds([['C', 'OF']], slots), { C: 0, OF: 2, SP: 2 }, 'dual eligibility fills both');
    // Never negative, however many are taken.
    assertEq(openNeeds([['C'], ['C'], ['C']], slots), { C: 0, OF: 3, SP: 2 }, 'over-filled floors at zero');
    assertEq(openNeeds([['C']], null), {}, 'no slot settings, no needs');
});

test('runDetect: four of the last six, and nothing when the run is not there', () => {
    // Six picks, four of them SP -> a run.
    assertEq(runDetect(['C', 'SP', 'SP', 'OF', 'SP', 'SP']),
        { position: 'SP', count: 4, of: 6 }, 'four SP in the window');
    // Three is not a run at the default threshold.
    assertEq(runDetect(['C', 'SP', 'SP', 'OF', 'SP', 'C']), null, 'three does not trip it');
    // Only the WINDOW counts - four SP spread over eight picks is not a run now.
    assertEq(runDetect(['SP', 'SP', 'C', 'C', 'OF', 'SP', 'C', 'SP']), null, 'the window is the last six');
    // A shorter history than the window still works.
    assertEq(runDetect(['D', 'D', 'D', 'D']), { position: 'D', count: 4, of: 4 }, 'a short draft');
    assertEq(runDetect([]), null, 'no picks at all');
    // Two positions both at threshold: the more numerous wins, then the alphabet, so the sentence is stable for the same picks.
    assertEq(runDetect(['SP', 'SP', 'SP', 'SP', 'SP', 'C'], { threshold: 1 }),
        { position: 'SP', count: 5, of: 6 }, 'the more numerous wins');
    assertEq(runDetect(['C', 'C', 'SP', 'SP'], { window: 4, threshold: 2 }),
        { position: 'C', count: 2, of: 4 }, 'a tie breaks alphabetically');
});

test('coverageOf: the share of the other teams you are beating, ties split', () => {
    const sums = {
        me: { hr: 100, era: 3.00 },
        a: { hr: 80, era: 4.00 },
        b: { hr: 120, era: 2.00 },
        c: { hr: 100, era: 3.00 }
    };
    // HR, higher is better: beats a (1), loses to b (0), ties c (0.5) -> 1.5 / 3 = 0.5 ERA is inverse, lower is better: beats a (1), loses to b (0), ties c (0.5) -> 0.5
    const cov = coverageOf(sums, 'me', ['hr', 'era'], { inverseIds: new Set(['era']) });
    assertEq(cov[0], { id: 'hr', share: 0.5, value: 100 }, 'one beaten, one lost, one tied');
    assertEq(cov[1], { id: 'era', share: 0.5, value: 3 }, 'the inverse category reads the same way');
    // Beating everyone and losing to everyone are the ends of the bar.
    assertEq(coverageOf(sums, 'b', ['hr'], {})[0].share, 1, 'the leader beats every other team');
    assertEq(coverageOf(sums, 'a', ['hr'], {})[0].share, 0, 'the last team beats none');
    // A COUNTING category nobody has scored in yet is a real three-way tie at zero - which is what rosterTotals produces for one, a 0 rather than an absence.
    assertEq(coverageOf({ me: { hr: 0 }, a: { hr: 0 }, b: { hr: 0 } }, 'me', ['hr'], {})[0].share,
        0.5, 'all level at zero');
    // A one-team league has nobody to compare against, which is null rather than a made-up figure.
    assertEq(coverageOf({ me: { hr: 5 } }, 'me', ['hr'], {})[0].share, null, 'nobody to beat');

    // A NULL IS AN ABSENCE, NOT A ZERO. rosterTotals returns null for a rate with no denominator, and reading that as zero in an INVERSE category would hand an empty roster the best figure in the league. Both sides are left out of the comparison instead.
    const rates = { me: { era: null }, a: { era: 4.00 }, b: { era: 3.00 } };
    assertEq(coverageOf(rates, 'me', ['era'], { inverseIds: new Set(['era']) })[0],
        { id: 'era', share: null, value: null }, 'no innings pitched is no standing, not first place');
    // A rival with no figure is skipped, and the share is over those who HAVE one.
    const partial = { me: { era: 3.50 }, a: { era: 4.00 }, b: { era: null } };
    assertEq(coverageOf(partial, 'me', ['era'], { inverseIds: new Set(['era']) })[0].share, 1,
        'beating the one team that can be compared is a full share');
});

test('holesFrom: the categories a roster is losing badly enough to act on', () => {
    const cov = [
        { id: 'hr', share: 0.9 }, { id: 'sb', share: 0.35 },
        { id: 'era', share: 0.1 }, { id: 'k', share: 0.36 }, { id: 'r', share: null }
    ];
    assertEq(holesFrom(cov), ['sb', 'era'], 'at or under the threshold, and null is not a hole');
    assertEq(holesFrom(cov, 0.5), ['sb', 'era', 'k'], 'a caller can ask a different question');
    assertEq(holesFrom([]), [], 'nothing drafted yet');
});

test('threatCount: teams before your next pick, counted once each', () => {
    // Order: you are team 1. Picks 2..5 belong to 2, 3, 3, 4.
    const order = [1, 2, 3, 3, 4, 1];
    const needs = { 2: { D: 1 }, 3: { D: 2, G: 1 }, 4: { G: 1 } };
    // Between your pick at index 0 and your next at index 5: teams 2, 3, 3, 4 -> 2 and 3 need D.
    assertEq(threatCount(order, 1, 5, needs, 'D'), 2, 'team 3 picking twice is still one threat');
    assertEq(threatCount(order, 1, 5, needs, 'G'), 2, 'teams 3 and 4 need a goalie');
    assertEq(threatCount(order, 1, 5, needs, 'C'), 0, 'nobody needs a centre');
    assertEq(threatCount(order, 1, 1, needs, 'D'), 0, 'back-to-back picks have nobody in between');
    assertEq(threatCount(order, 1, 99, needs, 'D'), 2, 'past the end of the order is not an error');
});

test('rosterTotals: counts sum, rates rebuild from their own components', () => {
    // Two batters. AVG = H/AB over the PAIR, never the average of their averages. player one: 60 H in 200 AB (.300), player two: 40 H in 200 AB (.200) roster AVG = 100/400 =.250, which is also their mean here by construction HR = 20 + 10 = 30
    const lines = [
        { '0': 200, '1': 60, '5': 20, '2': 0.3 },
        { '0': 200, '1': 40, '5': 10, '2': 0.2 }
    ];
    const specs = [{ out: '2', num: ['1'], den: ['0'] }];
    const out = rosterTotals(lines, ['5', '2'], specs);
    assertEq(out['5'], 30, 'home runs sum');
    assertEq(out['2'], 0.25, 'the rate is rebuilt, not summed - .5 would be the wrong answer');

    // A lopsided pair proves it is not just the mean: 90 H in 100 AB and 10 H in 300 AB.
    const lopsided = rosterTotals(
        [{ '0': 100, '1': 90 }, { '0': 300, '1': 10 }], ['2'], specs);
    assertEq(lopsided['2'], 0.25, '100 hits in 400 at-bats, not the .600 their averages average to');

    // A scale, the way ERA carries one: ER * 9 / IP, with 34 as outs.
    const era = rosterTotals([{ '45': 10, '34': 90 }, { '45': 5, '34': 90 }],
        ['47'], [{ out: '47', num: ['45'], den: ['34'], scale: 27 }]);
    assertEq(era['47'], 2.25, '15 earned runs over 180 outs at a scale of 27');

    // A rate built from other rates.
    const ops = rosterTotals([{ '1': 30, '0': 100, '8': 50 }],
        ['18'], [
            { out: '17', num: ['1'], den: ['0'] },
            { out: '9', num: ['8'], den: ['0'] },
            { out: '18', add: ['17', '9'] }
        ]);
    assertEq(ops['18'], 0.8, 'OBP .300 plus SLG .500');

    // No denominator is no rate, which is not a rate of zero.
    assertEq(rosterTotals([{ '1': 5, '0': 0 }], ['2'], specs)['2'], null, 'no at-bats, no average');
    assertEq(rosterTotals([], ['5', '2'], specs), { '5': 0, '2': null }, 'an empty roster');
});

test('sumOfEdgesAcross: a two-way player keeps the edges of both groups', () => {
    // A batter-only peer and a two-way player with the SAME batting line. The two-way player also pitches, and must finish ahead by exactly the pitching edges and not a point more.
    const batRepl = new Map([['hr', 50], ['r', 50], ['avg', 50]]);
    const batting = new Map([['hr', 70], ['r', 60], ['avg', 55]]);
    // batting edges: +20 +10 +5 = +35
    const peer = sumOfEdgesAcross([{ percentiles: batting, replacement: batRepl }]);
    assertEq(peer, 35, 'the batter-only peer');

    const pitchRepl = new Map([['w', 50], ['k', 50], ['era', 50]]);
    const pitching = new Map([['w', 80], ['k', 90], ['era', 60]]);
    // pitching edges: +30 +40 +10 = +80
    const twoWay = sumOfEdgesAcross([
        { percentiles: batting, replacement: batRepl },
        { percentiles: pitching, replacement: pitchRepl }
    ]);
    assertEq(twoWay, 115, '35 batting plus 80 pitching');
    assertEq(twoWay - peer, 80, 'ahead of the peer by exactly the pitching edges');

    // A part with nothing in it contributes nothing rather than dragging the total down.
    assertEq(sumOfEdgesAcross([
        { percentiles: batting, replacement: batRepl },
        { percentiles: new Map(), replacement: pitchRepl }
    ]), 35, 'an empty group is not a penalty');
    assertEq(sumOfEdgesAcross([]), null, 'nothing to measure anywhere');
    assertEq(sumOfEdgesAcross([{ percentiles: new Map(), replacement: pitchRepl }]), null, 'still nothing');

    // A SECOND SKILL THAT IS BELOW REPLACEMENT COSTS NOTHING. Nobody has to start a player there.
    const weakPitching = new Map([['w', 40], ['k', 45], ['era', 48]]);   // -10 -5 -2 = -17
    assertEq(sumOfEdgesAcross([{ percentiles: weakPitching, replacement: pitchRepl }]), -17,
        'on its own, below replacement is below replacement');
    assertEq(sumOfEdgesAcross([
        { percentiles: batting, replacement: batRepl },
        { percentiles: weakPitching, replacement: pitchRepl }
    ]), 35, 'beside real batting it is not used - the batter is unchanged');

    // Below replacement EVERYWHERE: the least-bad group stands, because the player has to be played somewhere and that is the seat it costs least to play them in.
    const weakBatting = new Map([['hr', 20], ['r', 30], ['avg', 40]]);   // -30 -20 -10 = -60
    assertEq(sumOfEdgesAcross([
        { percentiles: weakBatting, replacement: batRepl },
        { percentiles: weakPitching, replacement: pitchRepl }
    ]), -17, 'the least bad of the two, not their sum');
});

test('degenerateValue: one number covering most of a column is a filler', () => {
    // The shape measured on a live mid-season pool: a spike at the cap amid a real spread.
    const spike = [];
    for (let i = 0; i < 68; i++) spike.push(260.0);
    for (let i = 1; i <= 32; i++) spike.push(i * 3.1);
    assertEq(degenerateValue(spike), 260.0, '68 of 100 at one value is a filler');

    // A real column has ties and is not degenerate.
    const honest = [1, 2, 2, 3, 4, 5, 5, 5, 6, 7, 8, 9];
    assertEq(degenerateValue(honest), null, 'three of twelve sharing a value is a real tie');

    // Exactly at the threshold is not over it.
    const edge = [7, 7, 7, 1, 2, 3, 4, 5, 6];
    assertEq(degenerateValue(edge), null, 'a third exactly is not more than a third');
    assertEq(degenerateValue([7, 7, 7, 7, 1, 2, 3, 4, 5]), 7, 'four of nine is');

    assertEq(degenerateValue([]), null, 'no column at all');
    assertEq(degenerateValue([5, 5, 5]), 5, 'a column that is nothing but one value');
});

// ---- lifted out of draft-view.js: pure maths belongs in the engine ----

test('assignBodies: one player is ONE body, not one per eligible position', () => {
    // The bug the greedy assignment exists to prevent: a hockey forward eligible at C, LW and RW filling a C job AND an LW job AND an RW job at once, so every position read deeper than it is.
    const players = [{ player: { eligiblePositions: ['C', 'LW', 'RW'] } }];
    const bodies = assignBodies(players, { C: 2, LW: 2, RW: 2 });
    const total = Object.values(bodies).reduce((a, b) => a + b, 0);
    assertEq(total, 1, 'one player fills exactly one seat');
});

test('assignBodies: fills the position the league is furthest from filling', () => {
    const players = [{ player: { eligiblePositions: ['C', 'LW'] } }];
    assertEq(assignBodies(players, { C: 1, LW: 5 }).LW, 1, 'the deeper deficit takes them');
});

test('assignBodies: a player eligible only where there are no jobs fills nothing', () => {
    const bodies = assignBodies([{ player: { eligiblePositions: ['G'] } }], { C: 2 });
    assertEq(bodies.C, 0, 'no seat taken');
});

test('positionDepth: bodies against jobs, worst ratio first', () => {
    // Two centres worth starting against four centre jobs is a cliff; five wingers against two is deep. The order is by ratio so the tightest position leads.
    const rows = [
        { value: 5, player: { eligiblePositions: ['C'] } },
        { value: 4, player: { eligiblePositions: ['C'] } },
        { value: 3, player: { eligiblePositions: ['LW'] } },
        { value: 2, player: { eligiblePositions: ['LW'] } },
        { value: 1, player: { eligiblePositions: ['LW'] } },
        { value: 0, player: { eligiblePositions: ['LW'] } },
        { value: 0, player: { eligiblePositions: ['LW'] } }
    ];
    const out = positionDepth(rows, {
        counts: { 0: 2, 1: 1 }, labels: { 0: 'C', 1: 'LW' }, bench: new Set(), teams: 2
    });
    const byPos = Object.fromEntries(out.map(r => [r.pos, r]));
    assertEq(byPos.C.starters, 4, 'two seats across two teams');
    assertEq(byPos.C.available, 2, 'two bodies');
    assertEq(byPos.C.word, 'cliff', 'fewer bodies than jobs');
    assertEq(byPos.LW.word, 'deep', 'five bodies for two jobs');
    assertEq(out[0].pos, 'C', 'tightest first');
});

test('positionDepth: a player below replacement is not worth starting and is not counted', () => {
    const rows = [
        { value: 1, player: { eligiblePositions: ['C'] } },
        { value: -3, player: { eligiblePositions: ['C'] } },
        { value: null, player: { eligiblePositions: ['C'] } }
    ];
    const out = positionDepth(rows, { counts: { 0: 1 }, labels: { 0: 'C' }, bench: new Set(), teams: 1 });
    assertEq(out[0].available, 1, 'only the one at or above replacement');
});

test('positionDepth: flex and bench seats are not positions anyone is scarce at', () => {
    const rows = [{ value: 1, player: { eligiblePositions: ['C'] } }];
    const out = positionDepth(rows, {
        counts: { 0: 1, 5: 3, 9: 4 },
        labels: { 0: 'C', 5: 'UTIL', 9: 'BE' },
        bench: new Set([9]),
        // The flex seats arrive as DATA now (FLEX_SLOTS in state.js) rather than being a list of labels the engine carries - this test used to rely on 'UTIL' being hardcoded here.
        flex: new Set([5]),
        teams: 1
    });
    assertEq(out.length, 1, 'UTIL takes whoever is left over and the bench is not a job');
    assertEq(out[0].pos, 'C', 'only the real position');
});

test('positionDepth: no league tables at all yields nothing rather than throwing', () => {
    assertEq(positionDepth([], {}).length, 0, 'empty');
    assertEq(positionDepth([]).length, 0, 'no opts object at all');
});

// ===== item 4: flex seats are data, and the note is one sentence ==========================

// A FLEX SEAT IS A JOB NOBODY CAN HOLD. Football's slot 23 is labelled FLEX and no player carries FLEX as a position, so counting it prints a shortage that cannot be filled by definition - which is why every football league read "FLEX cliff, none above replacement", always.
const FFL_LABELS = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX' };
const FFL_COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 };
const ROW = (id, pos, value) => ({ value, player: { id, eligiblePositions: [pos] } });

test('positionDepth: a flex slot passed in the flex set is not a position', () => {
    const rows = [ROW(1, 'QB', 10), ROW(2, 'RB', 9), ROW(3, 'RB', 8), ROW(4, 'WR', 7)];
    const out = positionDepth(rows, {
        counts: FFL_COUNTS, labels: FFL_LABELS,
        bench: new Set([20, 21]), flex: new Set([23]), teams: 1
    });
    assertEq(out.some(d => d.pos === 'FLEX'), false, 'FLEX is not reported as a position');
    assertEq(out.some(d => d.pos === 'BE' || d.pos === 'IR'), false, 'nor are the bench seats');
});

// THE TRANSITIONAL DEFAULT IS GONE. While one caller still hardcoded nothing, the engine kept a list of LABELS - UTIL, IF, MI, CI, P - as the default for a caller passing no flex set, and two tests pinned that. Both production callers now pass FLEX_SLOTS[sport], so the list is deleted and its tests with it; what replaces them states the inverse, because it is the behaviour a future caller will actually meet. A caller that names no flex seats has NONE. That is deliberately not the old kindness: inferring flex from a label would put the engine back in the business of knowing three sports' vocabulary, which is exactly the bug - football's FLEX was missing from that vocabulary, so every football league read "FLEX cliff, none above replacement" forever. Silence now means silence.
test("positionDepth: with no flex set, nothing is a flex seat - naming them is the caller's job", () => {
    const rows = [ROW(1, 'QB', 10)];
    const out = positionDepth(rows, {
        counts: FFL_COUNTS, labels: FFL_LABELS, bench: new Set([20, 21]), teams: 1
    });
    const flexRow = out.find(d => d.pos === 'FLEX');
    assert(flexRow, 'FLEX counts as a position when the caller names no seats');
    assertEq(flexRow.available, 0, 'a job with no body, which is what naming the seat prevents');
    // The old label list would have excluded UTIL here on its own; nothing does now.
    const util = positionDepth([{ value: 1, player: { eligiblePositions: ['C'] } }], {
        counts: { 0: 1, 5: 3, 9: 4 },
        labels: { 0: 'C', 5: 'UTIL', 9: 'BE' },
        bench: new Set([9]),
        teams: 1
    });
    assertEq(util.map(d => d.pos).sort(), ['C', 'UTIL'], 'UTIL is a position until a caller says it is a seat');
});

// ===== O9: replacement level per position ================================================ A 2-team league, so the arithmetic is small enough to do by hand: QB1 RB2 WR1 TE1 FLEX1 per team means QB 2 seats, RB 4, WR 2, TE 2, and 2 flex seats contested by RB/WR/TE.
const O9_COUNTS = { 0: 1, 2: 2, 4: 1, 6: 1, 20: 5, 23: 1 };
const O9_LABELS = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 20: 'BE', 23: 'FLEX' };
const O9_OPTS = {
    counts: O9_COUNTS, labels: O9_LABELS, bench: new Set([20]),
    flex: new Set([23]), flexPositions: { 23: new Set(['RB', 'TE', 'WR']) }, teams: 2
};
const scoreRows = (spec) => Object.entries(spec)
    .flatMap(([pos, list]) => list.map(score => ({ pos, score })));

test('positionDepths: each position is priced against its OWN last starter', () => {
    // QB 2 seats: baseline is the 2nd QB, 90. RB 4 seats + whatever flex it wins.
    const rows = scoreRows({
        QB: [100, 90, 80, 70],
        RB: [60, 55, 50, 45, 40, 35],
        WR: [58, 52, 30],
        TE: [20, 15]
    });
    const out = positionDepths(rows, O9_OPTS);
    const by = Object.fromEntries(out.map(d => [d.pos, d]));
    assertEq(by.QB.depth, 2, 'two quarterbacks are started');
    assertEq(by.QB.baseline, 90, 'the second best is the replacement');
    assertEq(by.QB.above, 1, 'and exactly one is above');
    // The whole point: a quarterback is not measured against a receiver.
    assert(by.QB.baseline !== by.WR.baseline, 'two positions, two baselines');
});

test('positionDepths: the flex goes to the best players left over, not to a fixed share', () => {
    // Locked first: RB 4 (60,55,50,45), WR 2 (58,52), TE 2 (20,15). The leftovers are RB 40 and 35, WR 38, TE nothing - so the two flex seats go to RB 40 and then WR 38, since 38 beats the second spare running back. The split is decided by the SCORES, which is the whole claim.
    const rows = scoreRows({
        QB: [100, 90],
        RB: [60, 55, 50, 45, 40, 35],
        WR: [58, 52, 38],
        TE: [20, 15]
    });
    const out = positionDepths(rows, O9_OPTS);
    const by = Object.fromEntries(out.map(d => [d.pos, d]));
    assertEq([by.RB.flexWon, by.WR.flexWon, by.TE.flexWon], [1, 1, 0], 'measured, not assumed');
    assertEq([by.RB.depth, by.WR.depth, by.TE.depth], [5, 3, 2], 'seats plus what each actually won');
    assertEq(by.RB.baseline, 40, 'the fifth running back');
    assertEq(by.WR.baseline, 38, 'the third receiver');
});

test('positionDepths: when one position holds the best leftovers it takes every flex seat', () => {
    // The same league with the spare receiver a point WORSE than the spare back: both flex seats go to running backs. Nothing splits them evenly, and nothing is owed a seat.
    const rows = scoreRows({
        QB: [100, 90],
        RB: [60, 55, 50, 45, 40, 35],
        WR: [58, 52, 30],
        TE: [20, 15]
    });
    const out = positionDepths(rows, O9_OPTS);
    const by = Object.fromEntries(out.map(d => [d.pos, d]));
    assertEq([by.RB.flexWon, by.WR.flexWon], [2, 0], 'both seats, because 35 beats 30');
    assertEq(by.RB.baseline, 35, 'the sixth running back is the replacement');
});

test('positionDepths: a mandatory seat is never traded away to a better player elsewhere', () => {
    // THE METHODOLOGY BUG THIS PINS: pooling RB/WR/TE and taking the best (4+2+2+2) together lets receivers take TIGHT END seats and hands back a TE depth below its own seat count. A league that starts two tight ends has a second-best tight end whatever that player scores.
    const rows = scoreRows({
        QB: [100, 90],
        RB: [99, 98, 97, 96, 95, 94],
        WR: [93, 92, 91],
        TE: [2, 1]
    });
    const out = positionDepths(rows, O9_OPTS);
    const by = Object.fromEntries(out.map(d => [d.pos, d]));
    assertEq(by.TE.depth, 2, 'its own two seats survive, however bad the tight ends are');
    assertEq(by.TE.baseline, 1, 'and the second one is the replacement');
    assertEq(by.TE.flexWon, 0, 'it wins no flex seat');
});

test('positionDepths: a position shallower than its seats keeps the last-player floor', () => {
    // One tight end for two seats. The floor is that player, not a zero that would flatter the pick.
    const rows = scoreRows({ QB: [100, 90], RB: [60, 55, 50, 45], WR: [58, 52], TE: [20] });
    const out = positionDepths(rows, O9_OPTS);
    const te = out.find(d => d.pos === 'TE');
    assertEq([te.depth, te.baseline, te.above], [2, 20, 0], 'that own score is the floor');
});

test('positionDepths: a flex slot with no measured positions takes nobody, not everybody', () => {
    // Guessing a flex slot's eligibility moves every baseline it touches, so an unmeasured slot is skipped. Without flexPositions the depths are the mandatory seats alone.
    const rows = scoreRows({ QB: [100, 90], RB: [60, 55, 50, 45, 40], WR: [58, 52, 30], TE: [20, 15] });
    const out = positionDepths(rows, { ...O9_OPTS, flexPositions: {} });
    const by = Object.fromEntries(out.map(d => [d.pos, d]));
    assertEq([by.RB.depth, by.WR.depth, by.TE.depth], [4, 2, 2], 'seats only');
    assertEq(by.RB.flexWon, 0, 'nothing was handed out');
});

test('positionDepths: bench and flex slots are never positions of their own', () => {
    const rows = scoreRows({ QB: [100, 90], RB: [60, 55, 50, 45], WR: [58, 52], TE: [20, 15] });
    const out = positionDepths(rows, O9_OPTS);
    assertEq(out.some(d => d.pos === 'BE' || d.pos === 'FLEX'), false, 'neither is a position');
});

test('positionDepths: nothing to measure answers an empty list rather than throwing', () => {
    assertEq(positionDepths([], O9_OPTS).length, 0, 'no rows');
    assertEq(positionDepths(null).length, 0, 'no rows and no options');
    // A row with no score is not a body - it cannot be ranked against a baseline.
    assertEq(positionDepths([{ pos: 'QB', score: null }], O9_OPTS).length, 0, 'unscored rows are not counted');
});

// ===== O14: replacement per seat-group ==================================================== A 2-team hockey-shaped league: D has 3 seats a team (6), F is a flex over the forwards with 4 seats a team (8), UTIL takes any skater with 1 seat a team (2).
const O14_GROUPS = [
    { name: 'D', seats: 6, accepts: new Set(['D']) },
    { name: 'F', seats: 8, accepts: new Set(['C', 'LW', 'RW']) },
    { name: 'UTIL', seats: 2, accepts: new Set(['C', 'LW', 'RW', 'D']) }
];
const skater = (id, pos, score) => ({ id, eligiblePositions: pos.split('/'), score });
const O14_SCORE = p => p.score;

test('replacementByGroup: each group is priced at ITS OWN last seat', () => {
    // Nine forwards and eight defencemen, best first. F has 8 seats, so the 8th forward; D has 6, so the 6th defenceman; UTIL has 2, so the 2nd best skater of any kind.
    const ranked = [
        skater(1, 'C', 100), skater(2, 'LW', 96), skater(3, 'D', 94), skater(4, 'RW', 92),
        skater(5, 'C', 90), skater(6, 'D', 88), skater(7, 'LW', 86), skater(8, 'RW', 84),
        skater(9, 'C', 82), skater(10, 'D', 80), skater(11, 'LW', 78), skater(12, 'D', 76),
        skater(13, 'D', 74), skater(14, 'D', 72), skater(15, 'RW', 70), skater(16, 'C', 68),
        skater(17, 'D', 66)
    ];
    const rep = replacementByGroup(ranked, O14_GROUPS);
    // Forwards in order: 100, 96, 92, 90, 86, 84, 82, 78, 70, 68 -> the 8th is 78.
    assertEq(rep.get('F').score, 78, 'the eighth forward');
    // Defencemen: 94, 88, 80, 76, 74, 72, 66 -> the 6th is 72.
    assertEq(rep.get('D').score, 72, 'the sixth defenceman');
    // Any skater: the 2nd is 96.
    assertEq(rep.get('UTIL').score, 96, 'the second skater of any kind');
});

test('replacementByGroup: a group nobody can fill has no replacement, not a fabricated one', () => {
    const ranked = [skater(1, 'C', 100), skater(2, 'LW', 90)];
    const rep = replacementByGroup(ranked, O14_GROUPS);
    assertEq(rep.get('D'), null, 'no defencemen, no defence baseline');
    assert(rep.get('F') !== null, 'the forwards still have one');
});

test('replacementByGroup: a group shallower than its seats keeps its last player', () => {
    // Three defencemen for six seats: the floor is the third, not a zero that would flatter valuable - the same rule replacementLevel keeps.
    const ranked = [skater(1, 'D', 90), skater(2, 'D', 80), skater(3, 'D', 70), skater(4, 'C', 60)];
    assertEq(replacementByGroup(ranked, O14_GROUPS).get('D').score, 70, 'the last player stands in');
});

test('pricingGroupFor: a player is priced against the CHEAPEST seat they could hold', () => {
    const ranked = [
        skater(1, 'C', 100), skater(2, 'LW', 96), skater(3, 'D', 94), skater(4, 'RW', 92),
        skater(5, 'C', 90), skater(6, 'D', 88), skater(7, 'LW', 86), skater(8, 'RW', 84),
        skater(9, 'C', 82), skater(10, 'D', 80), skater(11, 'LW', 78), skater(12, 'D', 76),
        skater(13, 'D', 74), skater(14, 'D', 72), skater(15, 'RW', 70), skater(16, 'C', 68),
        skater(17, 'D', 66)
    ];
    const rep = replacementByGroup(ranked, O14_GROUPS);
    // D 72, F 78, UTIL 96. A defenceman can hold D or UTIL and is priced at 72, the cheaper.
    assertEq(pricingGroupFor(skater(99, 'D', 85), O14_GROUPS, rep, O14_SCORE).name, 'D', 'the defence seat');
    // A forward can hold F or UTIL and is priced at 78.
    assertEq(pricingGroupFor(skater(98, 'C', 85), O14_GROUPS, rep, O14_SCORE).name, 'F', 'the forward seat');
});

test('pricingGroupFor: UTIL never prices anybody, and that falls out of the minimum', () => {
    // Its baseline is the 2nd best skater, above every other group's, so no player can ever be cheaper there. It is not special-cased - taking the minimum never chooses it.
    const ranked = [
        skater(1, 'C', 100), skater(2, 'LW', 96), skater(3, 'D', 94), skater(4, 'RW', 92),
        skater(5, 'C', 90), skater(6, 'D', 88), skater(7, 'LW', 86), skater(8, 'RW', 84),
        skater(9, 'C', 82), skater(10, 'D', 80), skater(11, 'LW', 78), skater(12, 'D', 76),
        skater(13, 'D', 74), skater(14, 'D', 72), skater(15, 'RW', 70), skater(16, 'C', 68),
        skater(17, 'D', 66)
    ];
    const rep = replacementByGroup(ranked, O14_GROUPS);
    const chosen = ranked.map(p => pricingGroupFor(p, O14_GROUPS, rep, O14_SCORE).name);
    assertEq(chosen.includes('UTIL'), false, 'never the pricing group for anyone');
    assert(rep.get('UTIL') !== null, 'though it still HAS a replacement, and still counts as a seat');
});

test('pricingGroupFor: a player no group accepts is priced by none', () => {
    const ranked = [skater(1, 'C', 100), skater(2, 'D', 90)];
    const rep = replacementByGroup(ranked, O14_GROUPS);
    assertEq(pricingGroupFor(skater(97, 'G', 80), O14_GROUPS, rep, O14_SCORE), null, 'a goalie holds no skater seat');
});

// ===== O12: the drop-off ================================================================== The 2-team league again, so k = teams = 2. QB has 2 seats; the player TWO picks past the last starter is the 4th quarterback.

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;

document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
