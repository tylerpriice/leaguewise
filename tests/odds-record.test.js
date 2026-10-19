// Unit tests for the record a matchup chance keeps of itself (odds-record.js). Open tests/odds-record.test.html through any static server; green means every assertion held. The record is synthetic and every expected figure is worked by hand beside the case that asserts it.
import { recordPrediction, scorePredictions, chanceWord, recordEarnsNumber, WORD_EDGES, EARNING } from '../src/data/odds-record.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function close(got, want, msg, tol = 1e-12) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

const FIX = await (await fetch('fixtures/odds-record.json')).json();
const storeOf = predictions => predictions.reduce((store, p) => recordPrediction(store, p).store, null);
const STORE = storeOf(FIX.predictions);

// ==== writing it down ====

test('a prediction is recorded once, under its league, season, matchup and day', () => {
    const first = recordPrediction(null, FIX.predictions[0]);
    assertEq(first.recorded, true, 'recorded');
    assertEq(first.reason, null, 'with nothing to say');
    assertEq(first.store.version, 1, 'the store has a version');
    assertEq(Object.keys(first.store.entries).join(), 'fhl:1|2027|1|1', 'keyed by the four');
    assertEq(first.store.entries['fhl:1|2027|1|1'].chance, 0.5, 'the chance as handed in');
    assertEq(first.store.entries['fhl:1|2027|1|1'].asOf, 'day 1', 'and the time the caller gave, unread');
    assertEq(Object.keys(STORE.entries).length, 6, 'six days, six entries');
});

test('the first figure shown that day is the one kept', () => {
    const again = recordPrediction(STORE, { ...FIX.predictions[0], chance: 0.9, tie: 0, lose: 0.1 });
    assertEq(again.recorded, false, 'not recorded');
    assertEq(again.reason, 'already recorded', 'and it says why');
    assertEq(again.store, STORE, 'the store handed in comes back, the same object');
    assertEq(STORE.entries['fhl:1|2027|1|1'].chance, 0.5, 'and the first figure stands');
});

test('the store handed in is never changed', () => {
    const before = recordPrediction(null, FIX.predictions[0]).store;
    const after = recordPrediction(before, FIX.predictions[1]).store;
    assertEq(Object.keys(before.entries).length, 1, 'the old store still holds one');
    assertEq(Object.keys(after.entries).length, 2, 'the new one holds two');
    assertEq(before.entries === after.entries, false, 'and they do not share their entries');
});

test('three figures that are not three chances are refused', () => {
    const base = FIX.predictions[0];
    const refused = p => recordPrediction(null, { ...base, ...p });
    assertEq(refused({ chance: 0.5, tie: 0.1, lose: 0.5 }).reason, 'not three chances', 'they sum to 1.1');
    assertEq(refused({ chance: 1.2, tie: 0, lose: -0.2 }).reason, 'not three chances', 'each has to be a chance');
    assertEq(refused({ chance: null, tie: 0, lose: 1 }).reason, 'not three chances', 'a side with no chance has none to record');
    assertEq(refused({ chance: 0.5, tie: 0.1, lose: 0.4 }).recorded, true, 'and three that are, are taken');
    assertEq(refused({ chance: 0.5, tie: 0.1, lose: 0.5 }).store, null, 'a refusal hands back what it was given');
});

test('a prediction with no key is refused before anything else', () => {
    const base = FIX.predictions[0];
    assertEq(recordPrediction(null, { ...base, leagueKey: '' }).reason, 'no key', 'no league');
    assertEq(recordPrediction(null, { ...base, day: 1.5 }).reason, 'no key', 'a day is a whole number');
    assertEq(recordPrediction(null, { ...base, matchupPeriod: '1' }).reason, 'no key', 'and so is a matchup, not its string');
    assertEq(recordPrediction(null, undefined).reason, 'no key', 'nothing at all');
});

test('a store of another version is read as empty', () => {
    const got = recordPrediction({ version: 2, entries: { old: {} } }, FIX.predictions[0]);
    assertEq(got.recorded, true, 'recorded into a fresh store');
    assertEq(Object.keys(got.store.entries).length, 1, 'which holds this prediction alone');
    assertEq(scorePredictions({ version: 2, entries: { old: {} } }, FIX.results).scored, 0, 'and nothing is scored out of it');
});

// ==== scoring it ====

/**
 * THE RECORD, by hand. The figure scored is the chance plus half the tie; a win is 1, a tie a
 * half and a loss 0. From the other bench the figure is the loss plus half the tie, against one
 * less what happened.
 *
 *   matchup  day   chance tie lose   said   happened   square     the other bench: said, happened
 *   1        1     0.5    0.1 0.4    0.55   1  (win)   0.2025     0.45, 0
 *   1        2     0.7    0.1 0.2    0.75   1          0.0625     0.25, 0
 *   2        8     0.6    0.2 0.2    0.70   0  (loss)  0.49       0.30, 1
 *   2        9     0.1    0.1 0.8    0.15   0          0.0225     0.85, 1
 *   3        15    0.35   0.2 0.45   0.45   0.5 (tie)  0.0025     0.55, 0.5
 *   4        22    no result yet: pending
 *
 *   Brier = (0.2025 + 0.0625 + 0.49 + 0.0225 + 0.0025) / 5 = 0.78 / 5 = 0.156
 *
 *   bucket     mine: n, said, happened        both sides: n, said, happened
 *   0-0.2      1   0.15         0             1   0.15                 0
 *   0.2-0.4    0                              2   0.25 + 0.30 = 0.55   0 + 1 = 1
 *   0.4-0.6    2   0.55 + 0.45  1 + 0.5       4   1.00 + 0.45 + 0.55   1.5 + 0 + 0.5 = 2
 *   0.6-0.8    2   0.75 + 0.70  1 + 0         2   1.45                 1
 *   0.8-1      0                              1   0.85                 1
 *
 * From both sides the ten cases say 5.0 between them and 5.0 happened: a half each, by
 * construction, which is the point of scoring both.
 */
test('the record is scored by the report rule, from the reader side and from both', () => {
    const got = scorePredictions(STORE, FIX.results);
    assertEq(got.scored, 5, 'five predictions scored');
    assertEq(got.pending, 1, 'one waiting on its matchup');
    assertEq(got.matchups, 3, 'in three matchups');
    close(got.brier, 0.156, 'the Brier score');
    ['mine', 'bothSides'].forEach(table => FIX.expected[table].forEach((want, i) => {
        const b = got[table][i];
        assertEq(b.lo, want.lo, `${table} ${i}: the lower edge`);
        assertEq(b.hi, want.hi, `${table} ${i}: the upper edge`);
        assertEq(b.n, want.n, `${table} ${i}: the cases`);
        close(b.said, want.said, `${table} ${i}: said`);
        close(b.happened, want.happened, `${table} ${i}: happened`);
    }));
    close(got.bothSides.reduce((s, b) => s + b.said, 0), 5, 'both sides say a half each');
    close(got.bothSides.reduce((s, b) => s + b.happened, 0), 5, 'and a half each happened');
});

test('the buckets print as the report table does: cases, said, happened and the gap in points', () => {
    // 0.6 to 0.8 from the reader's side: two cases, said 1.45 / 2 = 72.5%, happened 1 / 2 = 50.0%, so 22.5 points under. The same arithmetic the report prints for every bucket.
    const b = scorePredictions(STORE, FIX.results).mine[3];
    close(b.said / b.n * 100, 72.5, 'said');
    close(b.happened / b.n * 100, 50, 'happened');
    close((b.happened / b.n - b.said / b.n) * 100, -22.5, 'the gap in points');
});

test('an empty record has no Brier score, which is not a score of nothing', () => {
    const none = scorePredictions(null, FIX.results);
    assertEq(none.scored, 0, 'nothing scored');
    assertEq(none.brier, null, 'so no score at all');
    assertEq(none.mine.length, 5, 'and five empty buckets all the same');
    const waiting = scorePredictions(STORE, []);
    assertEq(waiting.pending, 6, 'with no result in, every prediction waits');
    assertEq(waiting.brier, null, 'and none is scored');
});

test('a league is scored on its own record', () => {
    const other = { leagueKey: 'flb:9', season: 2027, matchupPeriod: 1, day: 1, chance: 0.9, tie: 0, lose: 0.1, asOf: null };
    const two = recordPrediction(STORE, other).store;
    const all = [...FIX.results, { leagueKey: 'flb:9', season: 2027, matchupPeriod: 1, result: 'win' }];
    assertEq(scorePredictions(two, all).scored, 6, 'the whole store');
    assertEq(scorePredictions(two, all, { leagueKey: 'fhl:1' }).scored, 5, 'one league');
    close(scorePredictions(two, all, { leagueKey: 'flb:9' }).brier, 0.01, 'the other: 0.9 said and it won, a square of 0.01');
    // A result the store does not know, or one that is not a result, changes nothing.
    assertEq(scorePredictions(STORE, [...FIX.results, { leagueKey: 'fhl:1', season: 2027, matchupPeriod: 4, result: 'abandoned' }]).pending, 1, 'still waiting');
});

test('the top bucket takes a certainty, and every edge belongs to the bucket above it', () => {
    const edge = (chance, lose) => scorePredictions(storeOf([{ leagueKey: 'k', season: 1, matchupPeriod: 1, day: 1, chance, tie: 0, lose }]), [{ leagueKey: 'k', season: 1, matchupPeriod: 1, result: 'win' }]).mine.findIndex(b => b.n === 1);
    assertEq(edge(1, 0), 4, 'a chance of 1 is in the last bucket');
    assertEq(edge(0, 1), 0, 'a chance of 0 in the first');
    assertEq(edge(0.2, 0.8), 1, '0.2 opens the second');
    assertEq(edge(0.8, 0.2), 4, 'and 0.8 the last');
});

// ==== words, and when the number is earned ====

test('a word is a bucket: behind under 0.4, favoured from 0.6, close between', () => {
    assertEq(WORD_EDGES.behind, 0.4, 'the lower edge');
    assertEq(WORD_EDGES.favoured, 0.6, 'the upper edge');
    assertEq(chanceWord(0.41, 0.06), 'close', '0.41 + 0.03 = 0.44');
    assertEq(chanceWord(0.66, 0.04), 'favoured', '0.68');
    assertEq(chanceWord(0.30, 0.08), 'behind', '0.34');
    assertEq(chanceWord(0.6), 'favoured', 'the edge itself is favoured');
    assertEq(chanceWord(0.39), 'behind', 'and just under 0.4 is behind');
    assertEq(chanceWord(0.5, 0.5), 'favoured', 'the tie counts for half: 0.75');
    assertEq(chanceWord(null), null, 'no chance, no word');
    assertEq(chanceWord(NaN, 0.2), null, 'and not a number is not a chance');
});

/**
 * THE THREE BARS, each crossed alone. A season of matchups, every one predicted on ten days:
 * five days at 0.7 to win and 0.3 to lose, and five at an even 0.5, no tie anywhere.
 *
 *   the 0.7 days    said 0.7 in the 0.6-0.8 bucket; the other bench 0.3 in the 0.2-0.4 bucket
 *   the 0.5 days    said 0.5 in the 0.4-0.6 bucket from both benches, half of them winning
 *
 * With 20 matchups, 14 of them won: 100 cases at 0.7, said 70, happened 5 x 14 = 70, a gap of 0.
 * With 13 won: happened 65, the bucket is 5 points out, inside 6.3. With 12 won: 60, 10 points
 * out. The other bench mirrors it, and the middle bucket is level by construction.
 */
const SEASON = (matchups, wins, evenDays = true) => {
    const predictions = [];
    const results = [];
    for (let m = 1; m <= matchups; m += 1) {
        for (let d = 1; d <= 5; d += 1) predictions.push({ leagueKey: 'fhl:2', season: 2027, matchupPeriod: m, day: m * 10 + d, chance: 0.7, tie: 0, lose: 0.3 });
        if (evenDays) for (let d = 6; d <= 10; d += 1) predictions.push({ leagueKey: 'fhl:2', season: 2027, matchupPeriod: m, day: m * 10 + d, chance: 0.5, tie: 0, lose: 0.5 });
        results.push({ leagueKey: 'fhl:2', season: 2027, matchupPeriod: m, result: m <= wins ? 'win' : 'loss' });
    }
    return scorePredictions(storeOf(predictions), results);
};

test('a record as good as the one baseball was accepted on earns the number', () => {
    assertEq(EARNING.matchups, 20, 'twenty matchups');
    assertEq(EARNING.cases, 10, 'ten cases to judge a bucket');
    assertEq(EARNING.buckets, 3, 'three buckets judged');
    assertEq(EARNING.points, 6.3, 'within 6.3 points');
    const level = recordEarnsNumber(SEASON(20, 14));
    assertEq(level.earned, true, 'twenty matchups, three buckets, nothing out');
    assertEq(level.reason, null, 'and nothing to say');
    assertEq(level.matchups, 20, 'on twenty matchups');
    assertEq(level.judged, 3, 'and three judged buckets');
    close(level.worst, 0, 'the widest gap', 1e-9);
    const inside = recordEarnsNumber(SEASON(20, 13));
    assertEq(inside.earned, true, 'five points out is inside the bound');
    close(inside.worst, 5, '65 happened where 70 was said', 1e-9);
});

test('each bar refuses by itself, and says which', () => {
    const short = recordEarnsNumber(SEASON(19, 13));
    assertEq(short.earned, false, 'nineteen matchups');
    assertEq(short.reason, 'too few matchups', 'is one short');
    const thin = recordEarnsNumber(SEASON(20, 14, false));
    assertEq(thin.reason, 'too few buckets', 'twenty matchups in two buckets only');
    assertEq(thin.judged, 2, 'the two the 0.7 days fill');
    const out = recordEarnsNumber(SEASON(20, 12));
    assertEq(out.reason, 'out by more than the bound', 'ten points out');
    close(out.worst, 10, '60 happened where 70 was said', 1e-9);
    // A bucket under ten cases is not judged, however far out it is.
    assertEq(recordEarnsNumber(scorePredictions(STORE, FIX.results)).judged, 0, 'the small record has no bucket of ten');
    assertEq(recordEarnsNumber(scorePredictions(STORE, FIX.results)).worst, null, 'so no widest gap');
    assertEq(recordEarnsNumber(null).reason, 'too few matchups', 'and no record at all has earned nothing');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
