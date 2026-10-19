/**
 * The record a matchup chance keeps of itself. Each day's chance is written down beside its
 * matchup and never overwritten; when the matchup ends, what was said is scored against what
 * happened. A league's chance is shown as a word until its own record has earned the number.
 *
 * The store is a plain object the caller persists. This module is handed a store and hands back
 * the next one; it writes nothing and reads no clock.
 *
 * Pure. No DOM, no application state, no storage, no network. Imports nothing.
 *
 * Contract: tests/fixtures/odds-record.md
 * Tests: tests/odds-record.test.html
 * @module odds-record
 */
/**
 * One day's prediction, as recorded.
 *
 * @typedef {object} RecordedPrediction
 * @property {string} leagueKey The caller's own key for the league, the same every time.
 * @property {number} season The season.
 * @property {number} matchupPeriod The matchup.
 * @property {number} day The scoring period the chance was shown on.
 * @property {number} chance The reader's side's chance of winning.
 * @property {number} tie Its chance of a tie.
 * @property {number} lose Its chance of losing.
 * @property {?string} asOf When the caller says it was shown.
 */
/**
 * The store: every prediction recorded, by key.
 *
 * @typedef {object} OddsStore
 * @property {number} version The shape's version, 1.
 * @property {Object<string, RecordedPrediction>} entries The predictions, keyed by league, season, matchup and day.
 */
/**
 * One calibration bucket: the cases whose stated figure fell in it. Said and happened are sums,
 * so a reader divides each by the count.
 *
 * @typedef {object} CalibrationBucket
 * @property {number} lo The bucket's lower edge, included.
 * @property {number} hi Its upper edge, excluded, except that the last bucket takes 1.
 * @property {number} n How many cases.
 * @property {number} said The sum of what was said.
 * @property {number} happened The sum of what happened: 1 a win, a half a tie, 0 a loss.
 */
/**
 * A record scored.
 *
 * @typedef {object} ScoredRecord
 * @property {number} scored Predictions scored.
 * @property {number} pending Predictions whose matchup has no result yet.
 * @property {number} matchups The matchups the scored predictions belong to.
 * @property {?number} brier The mean square of said less happened; null with nothing scored.
 * @property {CalibrationBucket[]} mine The five buckets from the reader's side.
 * @property {CalibrationBucket[]} bothSides The five buckets with each prediction scored from both benches.
 */

const VERSION = 1;
const EDGES = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1]];
const TRUTH = { win: 1, tie: 0.5, loss: 0 };

/**
 * Where a word changes: under the first a side is behind, from the second it is favoured, and
 * between them the matchup is close. They are two of the five bucket edges, so a word is a bucket.
 *
 * @type {Readonly<{behind: number, favoured: number}>}
 */
export const WORD_EDGES = Object.freeze({ behind: 0.4, favoured: 0.6 });

/**
 * What a league's own record has to show before its chance is given as a number: how many
 * matchups scored, how many cases a bucket needs to be judged, how many buckets have to be
 * judged, and how many points said may be from happened in each of them.
 *
 * @type {Readonly<{matchups: number, cases: number, buckets: number, points: number}>}
 */
export const EARNING = Object.freeze({ matchups: 20, cases: 10, buckets: 3, points: 6.3 });

const whole = v => typeof v === 'number' && Number.isInteger(v);
const unit = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const entriesOf = store => (store && store.version === VERSION && store.entries && typeof store.entries === 'object' ? store.entries : {});
const keyOf = p => `${p.leagueKey}|${p.season}|${p.matchupPeriod}|${p.day}`;
const newBuckets = () => EDGES.map(([lo, hi]) => ({ lo, hi, n: 0, said: 0, happened: 0 }));
// The last bucket takes 1 itself; every other is closed below and open above.
const bucketOf = p => EDGES.findIndex(([lo, hi], i) => p >= lo && (p < hi || (i === EDGES.length - 1 && p <= hi)));

/**
 * Writes one day's prediction into the store, once. A key the store already holds is left as it
 * is: the first figure a reader was shown that day is the one that gets scored.
 *
 * @param {?OddsStore} store The store as the caller holds it. Absent, or of another version, it is read as empty.
 * @param {RecordedPrediction} prediction The day's prediction, from the reader's side.
 * @returns {{store: ?OddsStore, recorded: boolean, reason: ?string}} The next store when recorded.
 *   Otherwise the store handed in, untouched, with the reason: 'no key', 'not three chances' or
 *   'already recorded'.
 */
export function recordPrediction(store, prediction) {
    const p = prediction || {};
    if (typeof p.leagueKey !== 'string' || !p.leagueKey || !whole(p.season) || !whole(p.matchupPeriod) || !whole(p.day)) {
        return { store, recorded: false, reason: 'no key' };
    }
    // Three chances that are each a chance and are everything between them. A side whose spread nobody measured has no chance to record, and this is where that lands.
    if (!unit(p.chance) || !unit(p.tie) || !unit(p.lose) || Math.abs(p.chance + p.tie + p.lose - 1) > 1e-6) {
        return { store, recorded: false, reason: 'not three chances' };
    }
    const entries = entriesOf(store);
    const key = keyOf(p);
    if (Object.prototype.hasOwnProperty.call(entries, key)) return { store, recorded: false, reason: 'already recorded' };
    const entry = {
        leagueKey: p.leagueKey, season: p.season, matchupPeriod: p.matchupPeriod, day: p.day,
        chance: p.chance, tie: p.tie, lose: p.lose, asOf: p.asOf === undefined ? null : p.asOf
    };
    return { store: { version: VERSION, entries: { ...entries, [key]: entry } }, recorded: true, reason: null };
}

/**
 * Scores the recorded predictions whose matchups have ended. The figure scored is the chance plus
 * half the tie, against 1 for a win, a half for a tie and 0 for a loss. Each prediction is also
 * scored from the other bench, its loss plus half the tie against the other side's result, which
 * takes a season's lean toward one side out of the buckets.
 *
 * @param {?OddsStore} store The store.
 * @param {Array<{leagueKey: string, season: number, matchupPeriod: number, result: string}>} results The finished matchups from the reader's side: 'win', 'tie' or 'loss'.
 * @param {object} [options]
 * @param {string} [options.leagueKey] Score this league alone; absent, the whole store.
 * @returns {ScoredRecord} The record scored. An empty one has a Brier score of null, since nothing scored is not a perfect score.
 */
export function scorePredictions(store, results, { leagueKey } = {}) {
    const truthOf = new Map();
    (results || []).forEach(r => {
        if (r && Object.prototype.hasOwnProperty.call(TRUTH, r.result)) truthOf.set(`${r.leagueKey}|${r.season}|${r.matchupPeriod}`, TRUTH[r.result]);
    });
    const entries = entriesOf(store);
    const mine = newBuckets();
    const bothSides = newBuckets();
    const seen = new Set();
    let scored = 0;
    let pending = 0;
    let squares = 0;
    const add = (table, said, happened) => {
        const i = bucketOf(said);
        if (i < 0) return;
        table[i].n += 1; table[i].said += said; table[i].happened += happened;
    };
    Object.keys(entries).sort().forEach(key => {
        const e = entries[key];
        if (!e || (leagueKey !== undefined && e.leagueKey !== leagueKey)) return;
        const matchup = `${e.leagueKey}|${e.season}|${e.matchupPeriod}`;
        if (!truthOf.has(matchup)) { pending += 1; return; }
        const truth = truthOf.get(matchup);
        const said = e.chance + e.tie / 2;
        const other = e.lose + e.tie / 2;
        scored += 1;
        seen.add(matchup);
        squares += (said - truth) ** 2;
        add(mine, said, truth);
        add(bothSides, said, truth);
        add(bothSides, other, 1 - truth);
    });
    return { scored, pending, matchups: seen.size, brier: scored ? squares / scored : null, mine, bothSides };
}

/**
 * The word for a chance: favoured, close or behind. The figure is the chance plus half the tie,
 * the one that is scored, and the edges are WORD_EDGES.
 *
 * @param {number} chance The chance of winning.
 * @param {number} [tie=0] The chance of a tie.
 * @returns {?string} 'favoured', 'close' or 'behind'; null for a chance that is not a number.
 */
export function chanceWord(chance, tie = 0) {
    if (typeof chance !== 'number' || !Number.isFinite(chance)) return null;
    const figure = chance + (typeof tie === 'number' && Number.isFinite(tie) ? tie : 0) / 2;
    if (figure >= WORD_EDGES.favoured) return 'favoured';
    if (figure < WORD_EDGES.behind) return 'behind';
    return 'close';
}

/**
 * Whether a league's own record has earned its chance as a number: enough matchups scored, enough
 * buckets with enough cases to be judged, and every judged bucket within the bound, from both
 * sides. It is asked of the record as it stands, so a record that later strays stops earning it.
 *
 * @param {?ScoredRecord} scored The league's record, scored.
 * @returns {{earned: boolean, matchups: number, judged: number, worst: ?number, reason: ?string}}
 *   The verdict, the matchups and judged buckets it rests on, the widest gap among them in
 *   points, and the first bar that failed: 'too few matchups', 'too few buckets' or 'out by more
 *   than the bound'.
 */
export function recordEarnsNumber(scored) {
    const matchups = scored && Number.isFinite(scored.matchups) ? scored.matchups : 0;
    const judged = ((scored && scored.bothSides) || []).filter(b => b && b.n >= EARNING.cases);
    const worst = judged.length ? Math.max(...judged.map(b => Math.abs(b.happened / b.n - b.said / b.n) * 100)) : null;
    let reason = null;
    if (matchups < EARNING.matchups) reason = 'too few matchups';
    else if (judged.length < EARNING.buckets) reason = 'too few buckets';
    else if (worst > EARNING.points + 1e-9) reason = 'out by more than the bound';
    return { earned: reason === null, matchups, judged: judged.length, worst, reason };
}
