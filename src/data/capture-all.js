/**
 * Download All as a run of steps: one press fetches every kind of data the extension can gather
 * for the league and season on screen, in a stated order, and reports what happened to each. So
 * what a capture holds never depends on which tabs the reader had opened.
 *
 * Pure. No DOM, no application state, no storage, no network and no clock. It knows nothing about
 * ESPN: each step arrives as an object, built where its request lives, and this module only runs
 * them.
 *
 * Contract: tests/fixtures/capture-all.md
 * Tests: tests/capture-all.test.html
 * @module capture-all
 */
/**
 * One step of a run.
 *
 * @typedef {object} CaptureStep
 * @property {string} kind The kind of capture the step fills, unique in a run within its season.
 * @property {number} [season] A past season the step belongs to. Absent for the season on screen.
 * @property {function(): boolean} [present] True when the kind is already held; the step is then not run.
 * @property {function(): ?string} [skip] A reason, in words, when the step does not apply to this run. A skip is not a failure.
 * @property {function(): {requests: ?number, bytes: ?number}} [estimate] What the step expects to cost.
 * @property {function(function(number)): Promise<object>} run Does the work. It may report its running count of requests, and resolves to the requests made, what was asked for and what arrived, what was refused, any error, and its counts.
 */
/**
 * What a run did: one row per step, and the totals.
 *
 * @typedef {object} CaptureLedger
 * @property {object[]} kinds One row per step, with its state: 'fetched', 'partial', 'refused', 'failed', 'held', 'skipped' or 'cancelled'.
 * @property {number} requests The requests the whole run made.
 * @property {boolean} cancelled Whether the run was cancelled.
 * @property {boolean} complete Whether every kind meant to be fetched was.
 */

// What a step's result says happened, decided in one place. Fetched: it ran and nothing was refused. Partial: something was refused and something arrived. Refused: it ran and nothing arrived. A step that throws is failed, and the run carries on.
function stateOf(result) {
    const refused = Number(result && result.refused) || 0;
    const got = result && result.got;
    if (refused > 0 && Number(got) > 0) return 'partial';
    if (refused > 0) return 'refused';
    if (result && result.ok === false) return 'refused';
    return 'fetched';
}

// A row begins with what it is: the kind, and the season when the step named a past one.
const rowHead = (step) => (step.season === undefined || step.season === null ? { kind: step.kind } : { kind: step.kind, season: step.season });

const numberOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : null);
const errorText = (e) => {
    if (e === null || e === undefined) return null;
    if (typeof e === 'string') return e;
    return e.message ? String(e.message) : String(e);
};

/**
 * What a press will cost, before it is pressed: one row per step, and the totals. A step already
 * held or skipped costs nothing and says why. A step with no estimate adds nothing and is counted
 * as unknown, so a total is never read as complete when it is not.
 *
 * @param {CaptureStep[]} steps The steps.
 * @returns {{kinds: number, toFetch: number, requests: number, bytes: number, unknown: number, rows: object[]}} The estimate.
 */
export function captureEstimate(steps) {
    const rows = (steps || []).filter(s => s && s.kind).map(step => {
        const skip = typeof step.skip === 'function' ? step.skip() : null;
        if (skip) return { ...rowHead(step), state: 'skipped', reason: String(skip), requests: 0, bytes: 0 };
        if (typeof step.present === 'function' && step.present()) return { ...rowHead(step), state: 'held', reason: null, requests: 0, bytes: 0 };
        const est = typeof step.estimate === 'function' ? (step.estimate() || {}) : {};
        return { ...rowHead(step), state: 'to fetch', reason: null, requests: numberOrNull(est.requests), bytes: numberOrNull(est.bytes) };
    });
    const sum = (key) => rows.reduce((total, r) => total + (r[key] || 0), 0);
    return {
        kinds: rows.length,
        toFetch: rows.filter(r => r.state === 'to fetch').length,
        requests: sum('requests'),
        bytes: sum('bytes'),
        unknown: rows.filter(r => r.state === 'to fetch' && (r.requests === null || r.bytes === null)).length,
        rows
    };
}

/**
 * Runs the steps in the order given, one at a time. A step that is held or skipped is not run. A
 * refusal is recorded with what was asked and what arrived. A step that throws becomes a row, and
 * the run carries on.
 *
 * A cancel is asked between steps and never inside one, so a step under way finishes on its own
 * terms and every step not yet started is marked cancelled.
 *
 * @param {CaptureStep[]} steps The steps.
 * @param {object} [options]
 * @param {function({done: number, total: number, kind: string, state: string, requests: number, estimatedRequests: number})} [options.onProgress] Called when a step starts, each time it reports, and when it ends.
 * @param {function(): boolean} [options.shouldCancel] Asked before each step.
 * @returns {Promise<CaptureLedger>} The ledger. The promise never rejects.
 */
export async function captureAll(steps, { onProgress = null, shouldCancel = null } = {}) {
    const list = (steps || []).filter(s => s && s.kind);
    const estimate = captureEstimate(list);
    const rows = [];
    let requests = 0;
    let cancelled = false;
    const tell = (kind, state, extra = 0) => {
        if (typeof onProgress !== 'function') return;
        onProgress({ done: rows.length, total: list.length, kind, state, requests: requests + extra, estimatedRequests: estimate.requests });
    };

    for (const step of list) {
        if (!cancelled && typeof shouldCancel === 'function' && shouldCancel()) cancelled = true;
        if (cancelled) { rows.push({ ...rowHead(step), state: 'cancelled', reason: 'cancelled before it started', requests: 0 }); continue; }

        const skip = typeof step.skip === 'function' ? step.skip() : null;
        if (skip) { rows.push({ ...rowHead(step), state: 'skipped', reason: String(skip), requests: 0 }); tell(step.kind, 'skipped'); continue; }
        if (typeof step.present === 'function' && step.present()) {
            rows.push({ ...rowHead(step), state: 'held', reason: null, requests: 0 });
            tell(step.kind, 'held');
            continue;
        }

        tell(step.kind, 'running');
        let made = 0;
        const report = (soFar) => { const n = numberOrNull(soFar); if (n !== null && n >= made) { made = n; tell(step.kind, 'running', made); } };
        let row;
        try {
            const result = (await step.run(report)) || {};
            const counted = numberOrNull(result.requests);
            if (counted !== null) made = counted;
            row = {
                ...rowHead(step), state: stateOf(result), reason: null, requests: made,
                asked: numberOrNull(result.asked), got: numberOrNull(result.got),
                refused: Number(result.refused) || 0, error: errorText(result.error),
                counts: result.counts || null
            };
        } catch (e) {
            row = { ...rowHead(step), state: 'failed', reason: null, requests: made, asked: null, got: null, refused: 0, error: errorText(e) || 'failed', counts: null };
        }
        requests += row.requests;
        rows.push(row);
        tell(step.kind, row.state);
    }

    return {
        kinds: rows,
        requests,
        cancelled,
        // Whether every kind meant to be fetched was. Held and fetched both count, a skip is a decision and not a fault, and anything else is something the zip lacks.
        complete: rows.every(r => r.state === 'held' || r.state === 'fetched' || r.state === 'skipped')
    };
}

/**
 * Builds the zip's own index: what the archive holds and what it lacks, so a reader knows what a
 * capture is without opening its files. Every kind the run knew about has a row, present or not,
 * and an absent one says why. A file the run did not know about is listed as it is.
 *
 * @param {object} [args]
 * @param {?object} [args.league] The caller's description of the league on screen.
 * @param {Array<{kind: string, name: string, bytes: number, season: (number|undefined)}>} [args.files] What is going into the zip.
 * @param {?CaptureLedger} [args.ledger] The run's ledger, or null for a zip made without a run.
 * @param {?string} [args.version] The extension's version.
 * @param {*} [args.at] The time, passed in.
 * @returns {{what: string, version: ?string, at: *, league: ?object, requests: number, complete: ?boolean, cancelled: boolean, kinds: object[], seasons: Object<string, object[]>}} The index.
 */
export function buildCaptureIndex({ league = null, files = [], ledger = null, version = null, at = null } = {}) {
    const fileOf = new Map();
    // A file is matched to a row by its kind and its season, so a past season's file never stands in for the season on screen.
    const seasonOf = (x) => (x.season === undefined || x.season === null ? '' : String(x.season));
    const keyOf = (x) => `${seasonOf(x)}|${x.kind}`;
    const onScreen = (f) => f && f.kind && seasonOf(f) === '';
    (files || []).forEach(f => { if (f && f.kind && !fileOf.has(keyOf(f))) fileOf.set(keyOf(f), f); });
    const known = new Set();
    const rows = ((ledger && ledger.kinds) || []).map(r => {
        known.add(keyOf(r));
        const file = fileOf.get(keyOf(r)) || null;
        const why = file ? null
            : r.state === 'skipped' ? r.reason
            : r.state === 'cancelled' ? 'cancelled before it started'
            : r.state === 'failed' ? `failed: ${r.error || 'no reason given'}`
            : r.state === 'refused' ? `refused: ${r.error || 'no reason given'}`
            : 'nothing was captured';
        return {
            ...rowHead(r), present: !!file, file: file ? file.name : null, bytes: file ? file.bytes : null,
            state: r.state, requests: r.requests || 0,
            asked: r.asked === undefined ? null : r.asked, got: r.got === undefined ? null : r.got,
            refused: r.refused || 0, error: r.error || null, counts: r.counts || null, absentBecause: why
        };
    });
    (files || []).forEach(f => {
        if (!onScreen(f) || known.has(keyOf(f))) return;
        known.add(keyOf(f));
        rows.push({ kind: f.kind, present: true, file: f.name, bytes: f.bytes, state: 'held', requests: 0, asked: null, got: null, refused: 0, error: null, counts: null, absentBecause: null });
    });
    // The past seasons' files, listed as they are. The ledger covers the season on screen.
    const seasons = {};
    (files || []).forEach(f => {
        if (!f || f.season === undefined || f.season === null) return;
        (seasons[f.season] = seasons[f.season] || []).push({ kind: f.kind, file: f.name, bytes: f.bytes });
    });
    return {
        what: 'A Leaguewise capture. It holds league data; do not post it.',
        version, at, league: league || null,
        requests: ledger ? ledger.requests : 0,
        complete: ledger ? ledger.complete : null,
        cancelled: ledger ? ledger.cancelled : false,
        kinds: rows,
        seasons
    };
}
