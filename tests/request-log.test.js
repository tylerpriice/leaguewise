// Unit tests for the reader's request log (request-log.js). Open tests/request-log.test.html through any static server; green means every assertion held. Expected values are hand-computed in tests/fixtures/request-log.md, never from running the code. Every url and id below is invented; the origins are the real ones the extension uses.
import { recordRequest, summarizeRequests, describeOrigin, describePurpose } from '../src/data/request-log.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const FIX = await (await fetch('fixtures/request-log.json')).json();
const LOG = FIX.requests.reduce((log, r) => recordRequest(log, r), null);
const ROWS = summarizeRequests(LOG);

// ==== the instance ====

test('the instance: fifteen entries, twelve rows', () => {
    assertEq(LOG.entries.length, 15, 'one entry per request, the unreadable one included');
    assertEq(ROWS.length, 12, 'the hand-computed row count');
});

test('the instance: every row as hand-computed, in first-seen order', () => {
    FIX.rows.forEach((want, i) => assertJson(ROWS[i], want, `row ${i + 1}`));
});

test('the instance: the SWID and the league id appear nowhere in the log', () => {
    // The strings only: a time or a size can contain the digits 1001 by coincidence.
    const text = LOG.entries.map(e => [e.origin, e.name, e.kind].join(' ')).join('\n');
    assertEq(text.includes('11111111-2222'), false, 'the account lookup url carried the SWID');
    assertEq(text.includes('1001'), false, 'every league url carried the league id');
    assertEq(LOG.entries.some(e => 'url' in e), false, 'no entry keeps a url field');
});

test('the instance: a failed request and its retry are two requests on one row', () => {
    const history = ROWS[9];
    assertJson([history.count, history.failed, history.bytes], [2, 1, 8100], '4000 + 4100, one failure');
});

// ==== recordRequest ====

test('recordRequest: a new log every time, the one handed in unchanged', () => {
    const before = recordRequest(null, FIX.requests[0]);
    const after = recordRequest(before, FIX.requests[1]);
    assertEq(before.entries.length, 1, 'the log handed in keeps its one entry');
    assertEq(after.entries.length, 2, 'the new log has both');
    assertEq(after === before || after.entries === before.entries, false, 'nothing shared that could be pushed to');
});

test('recordRequest: a missing request adds nothing and returns a copy', () => {
    const log = recordRequest(null, FIX.requests[0]);
    const same = recordRequest(log, null);
    assertEq(same.entries.length, 1, 'still one entry');
    assertEq(same === log, false, 'a copy, not the same object');
    assertJson(recordRequest(undefined, undefined), { entries: [] }, 'no log and no request: the empty log');
});

test('recordRequest: at, bytes and ok read as null when they are not what they say', () => {
    const e = recordRequest(null, FIX.requests[14]).entries[0];
    assertJson(e, { origin: null, name: 'an unreadable address', known: false, kind: 'pool', at: null, bytes: null, ok: null },
        '"soon", -5 and "yes" are none of a time, a size or an outcome');
    assertEq(recordRequest(null, { url: 'https://fan.api.espn.com/x', bytes: 0, ok: false }).entries[0].bytes, 0,
        'zero bytes is a size');
});

test('recordRequest: a missing or empty kind is other', () => {
    assertEq(recordRequest(null, { url: 'https://fan.api.espn.com/x' }).entries[0].kind, 'other', 'missing');
    assertEq(recordRequest(null, { url: 'https://fan.api.espn.com/x', kind: '' }).entries[0].kind, 'other', 'empty');
});

// ==== describeOrigin ====

test('describeOrigin: the known origins by name', () => {
    assertJson(describeOrigin('https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl'),
        { origin: 'https://lm-api-reads.fantasy.espn.com', name: "ESPN's fantasy API", known: true }, 'the fantasy API');
    assertEq(describeOrigin('https://fan.api.espn.com/apis/v2/fans/x').name, "ESPN's account lookup", 'the account lookup');
    assertEq(describeOrigin('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard').name,
        "ESPN's scoreboard", 'the scoreboard');
    assertEq(describeOrigin('https://g.espncdn.com/lm-static/logos/x.svg').name, "ESPN's image server", 'the logo gallery host');
    assertEq(describeOrigin('https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/x').name,
        "ESPN's uploaded team logos", 'the uploaded logos');
});

test('describeOrigin: one CDN origin, three names by path', () => {
    assertEq(describeOrigin('https://a.espncdn.com/i/headshots/nhl/players/full/9001.png').name, "ESPN's headshots", 'headshots');
    assertEq(describeOrigin('https://a.espncdn.com/i/teamlogos/nhl/500/tor.png').name, "ESPN's pro-team logos", 'pro logos');
    assertEq(describeOrigin('https://a.espncdn.com/combiner/i?img=x').name, "ESPN's image server", 'anything else on it');
    assertEq(describeOrigin('https://a.espncdn.com/x?p=/i/headshots/').name, "ESPN's image server", 'the query is never read');
});

test('describeOrigin: the match is exact - scheme, port and host', () => {
    assertJson(describeOrigin('http://lm-api-reads.fantasy.espn.com/x'),
        { origin: 'http://lm-api-reads.fantasy.espn.com', name: 'another host: http://lm-api-reads.fantasy.espn.com', known: false },
        'http is not the origin the extension uses');
    assertEq(describeOrigin('https://lm-api-reads.fantasy.espn.com:8443/x').name,
        'another host: https://lm-api-reads.fantasy.espn.com:8443', 'nor is a non-default port');
    assertEq(describeOrigin('https://A.ESPNCDN.COM/i/headshots/x.png').name, "ESPN's headshots", 'the URL lowercases a host');
    assertEq(describeOrigin('https://stats.example.net/v1/lines').name, 'another host: https://stats.example.net', 'an unknown host');
});

test('describeOrigin: not a url, or not http or https, is an unreadable address', () => {
    const none = { origin: null, name: 'an unreadable address', known: false };
    assertJson(describeOrigin('not a url'), none, 'text');
    assertJson(describeOrigin('/relative/path'), none, 'a path with no base');
    assertJson(describeOrigin('data:text/plain,x'), none, 'a data url');
    assertJson(describeOrigin(undefined), none, 'nothing');
});

test('describeOrigin: an origin that is an object property name is still unknown', () => {
    assertEq(describeOrigin('https://constructor/x').known, false, 'hasOwnProperty, not in');
});

// ==== describePurpose ====

test('describePurpose: every kind the contract lists', () => {
    const want = {
        'league': 'the league: teams, matchups, transactions, and the draft',
        'league list': 'the leagues on your account',
        'history': "the league's past seasons",
        'rosters': "every team's roster",
        'pool': 'the player pool',
        'weekly': 'player lines, period by period',
        'schedule': 'the pro-team schedule',
        'scoreboard': 'the pro scoreboard',
        'headshot': 'a player headshot',
        'pro logo': 'a pro-team logo',
        'team logo': 'a fantasy team logo',
        'logo colour': 'a team logo, read for its colour',
        'other': 'no purpose recorded'
    };
    Object.entries(want).forEach(([k, v]) => assertEq(describePurpose(k), v, k));
});

test('describePurpose: an unknown kind is shown, an absent one is no purpose recorded', () => {
    assertEq(describePurpose('odds'), 'another purpose: odds', 'shown, not hidden');
    assertEq(describePurpose('toString'), 'another purpose: toString', 'hasOwnProperty, not in');
    assertEq(describePurpose(), 'no purpose recorded', 'undefined');
    assertEq(describePurpose(null), 'no purpose recorded', 'null');
    assertEq(describePurpose(''), 'no purpose recorded', 'empty');
});

// ==== summarizeRequests ====

test('summarizeRequests: first and last from the times, not from log order', () => {
    const log = [500, 100].reduce((l, at) => recordRequest(l, { url: 'https://fan.api.espn.com/x', kind: 'league list', at }), null);
    const row = summarizeRequests(log)[0];
    assertJson([row.first, row.last], [100, 500], 'recorded 500 then 100');
});

test('summarizeRequests: bytes is the sum of the sizes known, null when none is', () => {
    const log = [null, 10].reduce((l, bytes) => recordRequest(l, { url: 'https://fan.api.espn.com/x', kind: 'league list', bytes }), null);
    assertEq(summarizeRequests(log)[0].bytes, 10, 'null and 10: a lower bound of 10');
    assertEq(ROWS[3].bytes, null, 'two headshots, no size on either: null, never 0');
});

test('summarizeRequests: an ok of null is not a failure', () => {
    const log = recordRequest(null, { url: 'https://fan.api.espn.com/x', kind: 'league list' });
    assertEq(summarizeRequests(log)[0].failed, 0, 'unknown is not failed');
});

test('summarizeRequests: an empty, null or undefined log gives no rows', () => {
    assertJson(summarizeRequests({ entries: [] }), [], 'empty');
    assertJson(summarizeRequests(null), [], 'null');
    assertJson(summarizeRequests(undefined), [], 'undefined');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed: results.length - passed, total: results.length, failures: results.filter(r => !r.ok) };
