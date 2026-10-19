/**
 * The reader's request log: every request a session made, by origin and purpose, as a list the
 * reader can check.
 *
 * A request's url is read and never kept. The account lookup's url carries the reader's ESPN id
 * and every league url carries the league id, so an entry stores only what describeOrigin made of
 * the url. Nothing built on the log can print either value.
 *
 * Pure. No DOM, no application state, no storage, no network and no clock. The log is a value
 * passed in and returned; where it is held while the page is open is the caller's choice.
 *
 * Contract: tests/fixtures/request-log.md
 * Tests: tests/request-log.test.html
 * @module request-log
 */
/**
 * The log: one entry per request, in the order recorded.
 *
 * @typedef {object} RequestLog
 * @property {Array<{origin: ?string, name: string, known: boolean, kind: string, at: ?number, bytes: ?number, ok: ?boolean}>} entries The entries. None holds a url.
 */

// The origins the extension uses, as exact https origins. The whole origin is matched: scheme, host and port. A request over http or to another port of a familiar host is then shown as another host, which is what a reader should see. The image server at a.espncdn.com serves both headshots and pro-team logos and is told apart by path.
const KNOWN_ORIGINS = {
    'https://lm-api-reads.fantasy.espn.com': "ESPN's fantasy API",
    'https://fan.api.espn.com': "ESPN's account lookup",
    'https://site.api.espn.com': "ESPN's scoreboard",
    'https://g.espncdn.com': "ESPN's image server",
    'https://mystique-api.fantasy.espn.com': "ESPN's uploaded team logos"
};
const CDN_ORIGIN = 'https://a.espncdn.com';

// Each kind of request and what it is for, as lower-case noun phrases a page can set in a column or a sentence.
const PURPOSES = {
    'league': 'the league: teams, matchups, transactions, and the draft',
    'league list': 'the leagues on your account',
    'history': "the league's past seasons",
    'rosters': "every team's roster",
    'pool': 'the player pool',
    // Not one week: the request covers a run of scoring periods, and a period is a day in hockey and baseball.
    'weekly': 'player lines, period by period',
    'schedule': 'the pro-team schedule',
    'scoreboard': 'the pro scoreboard',
    'headshot': 'a player headshot',
    'pro logo': 'a pro-team logo',
    'team logo': 'a fantasy team logo',
    'logo colour': 'a team logo, read for its colour',
    'other': 'no purpose recorded'
};

/**
 * What to call the host a request went to. The url is used only to work this out. A host the
 * extension does not use is named as another host with its origin, not folded into a familiar
 * name.
 *
 * @param {string} url The request's url.
 * @returns {{origin: ?string, name: string, known: boolean}} The origin, a name for it, and whether it is one the extension uses. An address that cannot be read has a null origin.
 */
export function describeOrigin(url) {
    let parsed = null;
    try { parsed = new URL(String(url)); } catch (e) { parsed = null; }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        return { origin: null, name: 'an unreadable address', known: false };
    }
    const origin = parsed.origin;
    if (origin === CDN_ORIGIN) {
        const path = parsed.pathname;
        const name = path.startsWith('/i/headshots/') ? "ESPN's headshots"
            : path.startsWith('/i/teamlogos/') ? "ESPN's pro-team logos"
            : "ESPN's image server";
        return { origin, name, known: true };
    }
    // The lookup uses hasOwnProperty and not the in operator: an origin is text from outside, and every object has a constructor.
    if (Object.prototype.hasOwnProperty.call(KNOWN_ORIGINS, origin)) {
        return { origin, name: KNOWN_ORIGINS[origin], known: true };
    }
    return { origin, name: `another host: ${origin}`, known: false };
}

/**
 * What a kind of request is for, in words. A kind that is not recognised is shown as it is, not
 * renamed.
 *
 * @param {string} kind The request's kind.
 * @returns {string} The purpose.
 */
export function describePurpose(kind) {
    const k = kind || 'other';
    return Object.prototype.hasOwnProperty.call(PURPOSES, k) ? PURPOSES[k] : `another purpose: ${k}`;
}

/**
 * Adds one request to the log, keeping what describeOrigin made of its url and not the url.
 *
 * @param {?RequestLog} log The log so far.
 * @param {{url: string, kind: string, at: number, bytes: number, ok: boolean}} request The request: its url, its kind, when it was made, its size, and whether it succeeded.
 * @returns {RequestLog} A new log. A size or time that is not a number is stored as null.
 */
export function recordRequest(log, request) {
    const entries = (log && Array.isArray(log.entries)) ? log.entries.slice() : [];
    if (!request) return { entries };
    const { origin, name, known } = describeOrigin(request.url);
    const at = Number.isFinite(request.at) ? request.at : null;
    const bytes = Number.isFinite(request.bytes) && request.bytes >= 0 ? request.bytes : null;
    const ok = request.ok === true || request.ok === false ? request.ok : null;
    entries.push({ origin, name, known, kind: request.kind || 'other', at, bytes, ok });
    return { entries };
}

/**
 * One row per origin, name and kind, in the order the log first saw each, with the count, the
 * bytes, the failures and the first and last times.
 *
 * @param {?RequestLog} log The log.
 * @returns {Array<{origin: ?string, name: string, known: boolean, purpose: string, count: number, bytes: ?number, failed: number, first: ?number, last: ?number}>} The rows.
 */
export function summarizeRequests(log) {
    const rows = new Map();
    ((log && Array.isArray(log.entries)) ? log.entries : []).forEach(e => {
        const key = JSON.stringify([e.origin, e.name, e.kind]);
        if (!rows.has(key)) {
            rows.set(key, {
                origin: e.origin, name: e.name, known: e.known, purpose: describePurpose(e.kind),
                count: 0, bytes: null, failed: 0, first: null, last: null
            });
        }
        const row = rows.get(key);
        row.count += 1;
        // A lower bound when some sizes are missing, as an image load has none. Null only when no size is known, so a row of images never reads as zero bytes.
        if (e.bytes !== null) row.bytes = (row.bytes || 0) + e.bytes;
        if (e.ok === false) row.failed += 1;
        // The first and last come from the times and not the log's order, since two requests can be recorded in a different order from the one they were made in.
        if (e.at !== null) {
            if (row.first === null || e.at < row.first) row.first = e.at;
            if (row.last === null || e.at > row.last) row.last = e.at;
        }
    });
    return [...rows.values()];
}
