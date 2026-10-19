/**
 * The playoff odds run the way a page can afford them: which seed, how many runs to a batch, when
 * to yield to the page, how the batches become one answer, and whether a stored answer still
 * stands.
 *
 * Pure. No DOM, no application state, no storage, no network and no clock. The simulation is
 * playoff-odds.js's, handed in as a function, and the scheduler is built from a global the caller
 * hands in. The batches are fixed by the league's own state and never by the machine's speed, so
 * the same league gives the same answer on every load.
 *
 * Contract: tests/fixtures/odds-runner.md
 * Tests: tests/odds-runner.test.html
 * @module odds-runner
 */
import { seededRandom } from './draft-engine.js';
import { mergeRuns } from './playoff-odds.js';

/**
 * How many seasons are run for a head-to-head league and for a roto league.
 *
 * @type {{h2h: number, roto: number}}
 */
export const ODDS_RUNS = { h2h: 100000, roto: 10000 };
/**
 * The longest the page's idle callback may wait before a batch runs, in milliseconds. Without a
 * timeout a hidden page's idle callback may never fire.
 *
 * @type {number}
 */
export const IDLE_TIMEOUT_MS = 200;
/**
 * The cost a batch is sized to, in tenths of a microsecond: 35 milliseconds at the measured
 * rates.
 *
 * @type {number}
 */
export const BATCH_BUDGET = 350000;
/**
 * The version of the stored odds record. It changes when the model changes what a run draws, so
 * an answer computed under an earlier model is not served.
 *
 * @type {string}
 */
export const ODDS_CACHE_SCHEMA = 'playoff-odds-cache/2';

// FNV-1a, 32 bits, over the text one character code at a time. It is not a cryptographic hash. It spreads a league id and a period into a seed, and the same text always gives the same number.
function fnv1a(text) {
    let h = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * The seed for one league in one period. Two loads in the same period draw the same futures and
 * agree to the digit; the next period is a new draw.
 *
 * @param {number|string} leagueId The league.
 * @param {number} period The current period.
 * @returns {number} A 32-bit seed.
 */
export function oddsSeed(leagueId, period) {
    return fnv1a(`${leagueId}:${period}`);
}

const count = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * How many runs go in one batch, from the league's remaining work alone. A run's cost grows with
 * the work left, so a fixed count would be wasteful late in a season or too long early in one. The
 * estimate is in whole tenths of a microsecond, so the same league state gives the same batch on
 * every machine.
 *
 * @param {{path: ('h2h'|'roto'), matchups: number, teams: number, periodsLeft: number}} work The matchups left for a head-to-head league, or the teams and periods left for a roto league.
 * @returns {number} The runs to a batch, at least 1.
 */
export function batchFor(work) {
    const w = work || {};
    const cost = w.path === 'roto'
        ? 120 * count(w.teams) + 8 * count(w.periodsLeft) * count(w.teams)
        : 5 * count(w.matchups);
    return Math.max(1, Math.floor(BATCH_BUDGET / Math.max(cost, 10)));
}

/**
 * One seed per batch, taken as the first draws of the base seed's own stream, so the list for
 * four batches starts with the list for three.
 *
 * @param {number} seed The base seed.
 * @param {number} batches How many batches.
 * @returns {number[]} The seeds, each a 32-bit number.
 */
export function batchSeeds(seed, batches) {
    const rand = seededRandom(seed);
    const out = [];
    for (let i = 0; i < batches; i++) out.push(Math.floor(rand() * 4294967296) >>> 0);
    return out;
}

/**
 * Builds the function that yields to the page between batches, from the global handed in. It
 * uses the idle callback with a timeout where there is one, and a zero timer otherwise. The
 * callback is given no deadline, since a batch sized by the time remaining would be sized by the
 * machine.
 *
 * @param {{requestIdleCallback: (function|undefined), setTimeout: function}} scope The page's global.
 * @returns {function(function): *} Schedules a callback for the page's next idle moment.
 */
export function yieldFrom(scope) {
    if (scope && typeof scope.requestIdleCallback === 'function') {
        return cb => scope.requestIdleCallback(() => cb(), { timeout: IDLE_TIMEOUT_MS });
    }
    return cb => scope.setTimeout(cb, 0);
}

/**
 * Runs a simulation in batches, yielding to the page before each, and merges the batches into
 * one result.
 *
 * @param {object} args
 * @param {function(number, number): object} args.simulate Runs one batch, given its seed and its run count.
 * @param {number} args.runs The runs wanted in all.
 * @param {number} args.batch The runs to a batch.
 * @param {number} args.seed The base seed.
 * @param {function(function): *} [args.yieldTo] The scheduler from yieldFrom.
 * @param {function({done: number, total: number})} [args.onProgress] Called after each batch.
 * @param {function(): boolean} [args.cancelled] Read before each batch; true abandons the run.
 * @returns {Promise<?object>} The merged result with its seed and batch size, or null when cancelled or given nothing to run.
 */
export async function runInBatches({ simulate, runs, batch, seed, yieldTo, onProgress, cancelled } = {}) {
    if (!(runs > 0) || !(batch >= 1) || typeof simulate !== 'function') return null;
    const size = Math.floor(batch);
    const total = Math.floor(runs);
    const seeds = batchSeeds(seed, Math.ceil(total / size));
    // Running with no scheduler is for tests only, since the page then gets no frame between batches.
    const wait = () => new Promise(resolve => (yieldTo ? yieldTo(resolve) : resolve()));

    let merged = null;
    let done = 0;
    for (let i = 0; i < seeds.length; i++) {
        // Before every batch, the first included, so a page that starts this during a render paints before any work. Cancellation is read after the wait, which is when a league switch lands.
        await wait();
        if (cancelled && cancelled()) return null;
        const n = Math.min(size, total - done);
        merged = mergeRuns(merged, simulate(seeds[i], n));
        done += n;
        if (onProgress) onProgress({ done, total });
    }
    return { ...merged, seed, batch: size };
}

// ==== What has been played, and whether a stored answer still stands ====

/**
 * A cheap fingerprint of what the odds were computed from: how many periods have been played, and
 * each team's line in the last of them. It moves when a matchup is decided and when the last
 * period is corrected. A correction to an earlier period does not move it.
 *
 * @param {object[]|Map|object} input The application's weekly rows per team, or a roto league's per-period sums by team.
 * @param {object} [options]
 * @param {?number} [options.through] The last period to read, so a matchup in progress is left out.
 * @returns {string} The count of periods, the last period and a hash, as one string.
 */
export function playedFingerprint(input, { through = null } = {}) {
    const byTeam = {};
    const keep = p => Number.isFinite(p) && (through === null || p <= through);
    if (Array.isArray(input)) {
        input.forEach(team => {
            if (!team || team.id === undefined || team.id === null) return;
            const lines = {};
            const cats = team.weeklyCats || {};
            const wins = team.weeklyMatchWins || {};
            new Set([...Object.keys(cats), ...Object.keys(wins)]).forEach(p => {
                if (!keep(Number(p))) return;
                const line = { ...(cats[p] || {}) };
                if (p in wins) line.w = wins[p];
                lines[Number(p)] = line;
            });
            byTeam[String(team.id)] = lines;
        });
    } else {
        const entries = input instanceof Map ? [...input.entries()] : Object.entries(input || {});
        entries.forEach(([id, periods]) => {
            const lines = {};
            Object.keys(periods || {}).forEach(p => {
                if (!keep(Number(p))) return;
                const bucket = periods[p] || {};
                lines[Number(p)] = { ...(bucket.sums || {}), g: bucket.games };
            });
            byTeam[String(id)] = lines;
        });
    }

    const played = new Set();
    Object.values(byTeam).forEach(lines => Object.keys(lines).forEach(p => played.add(Number(p))));
    if (!played.size) return `0@0#${fnv1a('').toString(16).padStart(8, '0')}`;
    const last = Math.max(...played);
    // String order for the ids and the keys, which is one order every engine agrees on.
    const text = Object.keys(byTeam).sort()
        .filter(id => byTeam[id][last])
        .map(id => {
            const line = byTeam[id][last];
            return `${id}:${Object.keys(line).sort().map(k => `${k}=${line[k]}`).join(',')}`;
        })
        .join(';');
    return `${played.size}@${last}#${fnv1a(text).toString(16).padStart(8, '0')}`;
}

/**
 * The storage key for a league's odds record. There is one record a league.
 *
 * @param {string} sport The sport key.
 * @param {number|string} leagueId The league.
 * @returns {string} The key.
 */
export function oddsCacheKey(sport, leagueId) {
    return `playoffOdds:${sport}:${leagueId}`;
}

const orNull = v => (v === undefined ? null : v);

/**
 * Builds the record that is stored beside a computed result. A field not given is null.
 *
 * @param {object} args
 * @param {string} args.sport The sport key.
 * @param {number|string} args.leagueId The league.
 * @param {number} args.period The period the result was computed in.
 * @param {string} [args.variant='season'] The window the result covers.
 * @param {string} args.fingerprint The fingerprint of what was played.
 * @param {number} args.runs How many runs were made.
 * @param {number} args.batch The runs to a batch.
 * @param {number} args.seed The base seed.
 * @param {number} args.computedAt When it was computed.
 * @param {object} args.result The result.
 * @returns {object} The record, with the schema version on it.
 */
export function oddsCacheRecord({ sport, leagueId, period, variant, fingerprint, runs, batch, seed, computedAt, result } = {}) {
    return {
        schema: ODDS_CACHE_SCHEMA,
        sport: orNull(sport),
        leagueId: orNull(leagueId),
        period: orNull(period),
        // The window is part of the record, so a stored whole-season answer cannot satisfy a request for a recent window.
        variant: variant || 'season',
        fingerprint: orNull(fingerprint),
        runs: orNull(runs),
        batch: orNull(batch),
        seed: orNull(seed),
        computedAt: orNull(computedAt),
        result: orNull(result)
    };
}

/**
 * Whether a stored record still answers the request: only when every input that decides the
 * answer is the same. The batch size is compared, since it is part of what reproduces a result.
 * The time it was computed is not.
 *
 * @param {?object} record The stored record.
 * @param {object} [request] The same fields oddsCacheRecord takes, for the answer wanted now.
 * @returns {boolean} True when the record may be used.
 */
export function oddsCacheIsFresh(record, { sport, leagueId, period, fingerprint, runs, batch, variant } = {}) {
    if (!record || typeof record !== 'object' || record.schema !== ODDS_CACHE_SCHEMA) return false;
    if (!record.result || typeof record.result !== 'object') return false;
    return record.sport === sport
        && String(record.leagueId) === String(leagueId)
        && Number(record.period) === Number(period)
        && record.fingerprint === fingerprint
        && record.runs === runs
        && record.batch === batch
        && (record.variant || 'season') === (variant || 'season');
}
