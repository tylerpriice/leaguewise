// Unit tests for Download All's runner (capture-all.js). Open tests/capture-all.test.html through any static server; green means every assertion held. Every step here is a stub: the runner knows nothing about ESPN, so nothing here needs a league. Expected values are hand-computed in tests/fixtures/capture-all.md, never from running the code.
import { captureAll, captureEstimate, buildCaptureIndex } from '../src/data/capture-all.js';

const results = [];
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// THE STUB RUN of the contract: six kinds, each a different outcome. team already held draft-detail 1 request, arrives player-weekly 11 requests, reported as they go (3, 7, 11), arrives transactions the breaker trips: 192 asked, 40 got, 5 refused roster-days throws before anything is counted odds skipped: the option is off
const ran = [];
const STEPS = () => [
    { kind: 'team', present: () => true, estimate: () => ({ requests: 1, bytes: 800000 }), run: async () => { ran.push('team'); return {}; } },
    { kind: 'draft-detail', present: () => false, estimate: () => ({ requests: 1, bytes: 60000 }),
        run: async () => { ran.push('draft-detail'); return { requests: 1, asked: 1, got: 1, counts: { picks: 144 } }; } },
    { kind: 'player-weekly', estimate: () => ({ requests: 11, bytes: 30000000 }),
        run: async (report) => { ran.push('player-weekly'); report(3); report(7); report(11); return { asked: 11, got: 11, counts: { players: 802 } }; } },
    { kind: 'transactions', estimate: () => ({ requests: 192, bytes: 1500000 }),
        run: async (report) => { ran.push('transactions'); report(45); return { requests: 45, asked: 192, got: 40, refused: 5, error: 'HTTP 429' }; } },
    { kind: 'roster-days', estimate: () => ({ requests: 192, bytes: null }),
        run: async () => { ran.push('roster-days'); throw new Error('no session'); } },
    { kind: 'odds', skip: () => 'betting lines are off', estimate: () => ({ requests: 1, bytes: 40000 }), run: async () => { ran.push('odds'); return {}; } }
];

// ==== the estimate ====

await test('captureEstimate: what a press will cost, a held and a skipped kind costing nothing', () => {
    const e = captureEstimate(STEPS());
    // To fetch: draft-detail 1, player-weekly 11, transactions 192, roster-days 192 = 396 requests. Bytes: 60,000 + 30,000,000 + 1,500,000 + (roster-days unknown) = 31,560,000.
    assertEq([e.kinds, e.toFetch, e.requests, e.bytes, e.unknown], [6, 4, 396, 31560000, 1], 'the totals, with one kind whose bytes are not known');
    assertEq(e.rows.map(r => `${r.kind}:${r.state}:${r.requests}`),
        ['team:held:0', 'draft-detail:to fetch:1', 'player-weekly:to fetch:11', 'transactions:to fetch:192', 'roster-days:to fetch:192', 'odds:skipped:0'],
        'one row per step, in the order given');
    assertEq(e.rows[5].reason, 'betting lines are off', 'a skip says why');
    assertEq(e.rows[4].bytes, null, 'an unknown figure is null, never 0');
});

await test('captureEstimate: no steps, and a step with no estimate', () => {
    assertEq(captureEstimate([]), { kinds: 0, toFetch: 0, requests: 0, bytes: 0, unknown: 0, rows: [] }, 'nothing to do');
    assertEq(captureEstimate(null).kinds, 0, 'no list at all');
    const e = captureEstimate([{ kind: 'roster', run: async () => ({}) }]);
    assertEq([e.rows[0].requests, e.rows[0].bytes, e.unknown], [null, null, 1], 'no estimate is unknown');
});

// ==== the run ====

const progress = [];
const LEDGER = await captureAll(STEPS(), { onProgress: p => progress.push(p) });

await test('captureAll: the order is kept, and a held or skipped kind is never run', () => {
    assertEq(ran, ['draft-detail', 'player-weekly', 'transactions', 'roster-days'], 'team was held, odds skipped');
    assertEq(LEDGER.kinds.map(k => k.kind), ['team', 'draft-detail', 'player-weekly', 'transactions', 'roster-days', 'odds'], 'every step has a row, in order');
});

await test('captureAll: each outcome by its own name', () => {
    assertEq(LEDGER.kinds.map(k => k.state), ['held', 'fetched', 'fetched', 'partial', 'failed', 'skipped'], 'six outcomes');
    assertEq(LEDGER.kinds[3], { kind: 'transactions', state: 'partial', reason: null, requests: 45, asked: 192, got: 40, refused: 5, error: 'HTTP 429', counts: null },
        'the breaker: what was asked, what arrived, how many refused, the first error');
    assertEq([LEDGER.kinds[4].state, LEDGER.kinds[4].error, LEDGER.kinds[4].requests], ['failed', 'no session', 0], 'a step that threw is a row, with its reason');
    assertEq(LEDGER.kinds[5].reason, 'betting lines are off', 'the skip keeps its reason');
    assertEq(LEDGER.kinds[1].counts, { picks: 144 }, 'a step own counts are carried through');
});

await test('captureAll: a throwing step does not stop the run, and the totals say what happened', () => {
    // 1 + 11 + 45 + 0 = 57 requests made. Not complete: one partial and one failed.
    assertEq([LEDGER.requests, LEDGER.complete, LEDGER.cancelled], [57, false, false], 'the run carried on past the failure');
    assertEq(LEDGER.kinds[2].requests, 11, 'a step that returned no count keeps the last one it reported');
});

await test('captureAll: the progress line, step by step', () => {
    // done counts steps FINISHED when the line is sent; requests is the whole run so far.
    assertEq(progress.map(p => `${p.done}/${p.total} ${p.kind} ${p.state} ${p.requests}`), [
        '1/6 team held 0',
        '1/6 draft-detail running 0', '2/6 draft-detail fetched 1',
        '2/6 player-weekly running 1', '2/6 player-weekly running 4', '2/6 player-weekly running 8', '2/6 player-weekly running 12', '3/6 player-weekly fetched 12',
        '3/6 transactions running 12', '3/6 transactions running 57', '4/6 transactions partial 57',
        '4/6 roster-days running 57', '5/6 roster-days failed 57',
        '6/6 odds skipped 57'
    ], 'every line the face would draw');
    assertEq(progress[0].estimatedRequests, 396, 'the estimate rides on every line');
});

await test('captureAll: a refusal with nothing arrived is refused, not partial', async () => {
    const out = await captureAll([
        { kind: 'roster-days', run: async () => ({ requests: 5, asked: 192, got: 0, refused: 5, error: 'HTTP 403' }) },
        { kind: 'roster', run: async () => ({ ok: false, error: 'HTTP 500' }) },
        { kind: 'team', run: async () => ({ requests: 1 }) }
    ]);
    assertEq(out.kinds.map(k => `${k.kind}:${k.state}:${k.error}`), ['roster-days:refused:HTTP 403', 'roster:refused:HTTP 500', 'team:fetched:null'], 'and the next kind still ran');
});

await test('captureAll: a cancel takes effect between steps, never inside one', async () => {
    let finished = 0;
    const out = await captureAll([
        { kind: 'team', run: async () => { finished += 1; return { requests: 1 }; } },
        { kind: 'player-pool', run: async () => { finished += 1; return { requests: 1 }; } },
        { kind: 'player-weekly', run: async () => { finished += 1; return { requests: 11 }; } }
    ], { shouldCancel: () => finished >= 2 });
    // Asked before each step: 0 done, 1 done, then 2 done, so the run is cancelled before the third starts.
    assertEq(out.kinds.map(k => k.state), ['fetched', 'fetched', 'cancelled'], 'the second step finished; the third never started');
    assertEq([out.requests, out.cancelled, out.complete], [2, true, false], 'and the run says it was cancelled');
});

await test('captureAll: everything held or fetched is complete; nothing to do is complete', async () => {
    const out = await captureAll([{ kind: 'team', present: () => true, run: async () => ({}) }, { kind: 'roster', run: async () => ({ requests: 1 }) },
        { kind: 'odds', skip: () => 'betting lines are off', run: async () => ({}) }]);
    assertEq([out.complete, out.requests], [true, 1], 'held, fetched and a skip');
    const none = await captureAll([]);
    assertEq(none, { kinds: [], requests: 0, cancelled: false, complete: true }, 'no steps');
    const junk = await captureAll([null, { run: async () => ({}) }, { kind: 'team', run: async () => null }]);
    assertEq(junk.kinds.map(k => `${k.kind}:${k.state}`), ['team:fetched'], 'a step with no kind is not a step; a step that returns nothing fetched');
});

// ==== the index ====

await test('buildCaptureIndex: every kind present or absent, and an absent one says why', () => {
    const files = [
        { kind: 'team', name: 'team.json', bytes: 810095 },
        { kind: 'draft-detail', name: 'draft-detail.json', bytes: 63732 },
        { kind: 'player-weekly', name: 'player-weekly.json', bytes: 18700000 },
        { kind: 'transactions', name: 'transactions.json', bytes: 310000 },
        { kind: 'room', name: 'room.json', bytes: 2048 },
        { kind: 'player-pool', name: '2025/player-pool.json', bytes: 5679506, season: 2025 }
    ];
    const index = buildCaptureIndex({ league: { sport: 'fhl', season: 2026, format: 'H2H_MOST_CATEGORIES', teams: 6, state: 'finished' },
        files, ledger: LEDGER, version: '1.7.0', at: '2026-10-09T12:00:00Z' });
    assertEq(index.kinds.map(k => `${k.kind}:${k.present ? 'in' : 'out'}`),
        ['team:in', 'draft-detail:in', 'player-weekly:in', 'transactions:in', 'roster-days:out', 'odds:out', 'room:in'],
        'the run kinds in order, then a file the run never knew about');
    assertEq(index.kinds[4].absentBecause, 'failed: no session', 'a failed kind');
    assertEq(index.kinds[5].absentBecause, 'betting lines are off', 'a skipped kind, in its own words');
    assertEq([index.kinds[3].state, index.kinds[3].asked, index.kinds[3].got, index.kinds[3].refused, index.kinds[3].absentBecause], ['partial', 192, 40, 5, null],
        'a partial kind is present, with what it lacks beside it');
    assertEq(index.seasons, { 2025: [{ kind: 'player-pool', file: '2025/player-pool.json', bytes: 5679506 }] }, 'a past season in its own folder');
    assertEq([index.version, index.at, index.requests, index.complete, index.league.season], ['1.7.0', '2026-10-09T12:00:00Z', 57, false, 2026], 'the header');
});

await test('buildCaptureIndex: a past season file never stands in for the kind on screen', () => {
    const ledger = { kinds: [{ kind: 'player-pool', state: 'refused', requests: 1, refused: 1, error: 'HTTP 403' }], requests: 1, complete: false, cancelled: false };
    const index = buildCaptureIndex({ files: [{ kind: 'player-pool', name: '2025/player-pool.json', bytes: 9, season: 2025 }], ledger });
    assertEq([index.kinds[0].present, index.kinds[0].absentBecause], [false, 'refused: HTTP 403'], 'the on-screen pool is absent');
    assertEq(index.kinds.length, 1, 'and the past season one is not listed as a kind of this season');
});

await test('buildCaptureIndex: a zip made without a run lists what it holds', () => {
    const index = buildCaptureIndex({ files: [{ kind: 'team', name: 'team.json', bytes: 5 }] });
    assertEq([index.kinds.length, index.kinds[0].state, index.complete, index.requests], [1, 'held', null, 0], 'no ledger, no claim about completeness');
    assertEq(buildCaptureIndex().kinds, [], 'nothing at all');
});

// ==== every season ====

// "Every season": the cheap set for a past season. Two steps for 2025, one of them refused, beside this season's own pool. A step with a `season` carries it onto its row; one without has none.
await test('a step for a past season carries its season, and is matched to that season file', async () => {
    const steps = [
        { kind: 'player-pool', run: async () => ({ requests: 1, asked: 1, got: 1 }) },
        { kind: 'team', season: 2025, estimate: () => ({ requests: 1, bytes: 1200000 }), run: async () => ({ requests: 1, asked: 1, got: 1 }) },
        { kind: 'player-pool', season: 2025, estimate: () => ({ requests: 1, bytes: 5700000 }), run: async () => ({ requests: 1, asked: 1, got: 0, ok: false, error: 'HTTP 403' }) }
    ];
    assertEq(captureEstimate(steps).rows.map(r => `${r.season ?? '-'} ${r.kind} ${r.requests}`), ['- player-pool null', '2025 team 1', '2025 player-pool 1'],
        'the estimate names the season; this season has none');
    const ledger = await captureAll(steps);
    assertEq(ledger.kinds.map(k => `${k.season ?? '-'} ${k.kind} ${k.state}`), ['- player-pool fetched', '2025 team fetched', '2025 player-pool refused'], 'three rows, two of them 2025');
    assertEq(Object.keys(ledger.kinds[0]).includes('season'), false, 'a row for the season on screen has no season key at all');
    const index = buildCaptureIndex({ ledger, files: [
        { kind: 'player-pool', name: 'player-pool.json', bytes: 100 },
        { kind: 'team', season: 2025, name: '2025/team.json', bytes: 200 }
    ] });
    // This season's pool is in. 2025's league payload is in its folder. 2025's pool was refused, and this season's pool does not make it present.
    assertEq(index.kinds.map(k => `${k.season ?? '-'} ${k.kind} ${k.present ? k.file : 'absent: ' + k.absentBecause}`),
        ['- player-pool player-pool.json', '2025 team 2025/team.json', '2025 player-pool absent: refused: HTTP 403'], 'each row against its own season');
    assertEq(index.seasons, { 2025: [{ kind: 'team', file: '2025/team.json', bytes: 200 }] }, 'and the folder lists what it holds');
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
