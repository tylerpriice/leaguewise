// Unit tests for the odds runner (odds-runner.js). Open tests/odds-runner.test.html through any static server; green means every assertion held. The pinned values are computed in tests/fixtures/odds-runner.md by an implementation written apart from the module, never from a run of it. Every id and figure is invented.
import {
    oddsSeed, batchFor, batchSeeds, yieldFrom, runInBatches, playedFingerprint,
    oddsCacheKey, oddsCacheRecord, oddsCacheIsFresh, ODDS_RUNS, IDLE_TIMEOUT_MS, BATCH_BUDGET, ODDS_CACHE_SCHEMA
} from '../src/engines/odds-runner.js';
import { rulesFrom, resampleBasis, simulateSeason, rotoBasisFrom, rotoOdds } from '../src/engines/playoff-odds.js';

const results = [];
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
function close(got, want, msg, tol) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

const FIX = await (await fetch('fixtures/odds-runner.json')).json();
const ODDS = await (await fetch('fixtures/playoff-odds.json')).json();
const TOL = 0.03;          // three points, the tolerance playoff-odds.md sets for the single run
const SEED = 20260922;

// playoff-odds.json's four-team league, built the way its own suite builds it.
const divisionByTeam = {};
ODDS.teams.forEach(t => { divisionByTeam[t.id] = t.divisionId; });
const RULES = rulesFrom(ODDS.settings, ODDS.schedule, { scoredStatIds: ODDS.scoredStatIds, inverseStatIds: ODDS.inverseStatIds, divisionByTeam });
const BASIS = resampleBasis(ODDS.teams.map(t => ({ id: t.id, weeklyCats: ODDS.weeklyCats[String(t.id)], weeklyMatchWins: {} })), { through: 2 });
// priorWeeks 0: the fixture's enumeration is the own-week model's, which playoff-odds.md amendment 4 keeps exactly there. What this suite tests is the BATCHING, which is the same at any prior.
const h2h = (seed, runs) => simulateSeason(BASIS, ODDS.schedule, RULES, { seed, runs, minWeeks: 2, priorWeeks: 0 });

const ROTO_RULES = rulesFrom(ODDS.roto.settings, [], { scoredStatIds: ODDS.scoredStatIds, inverseStatIds: ODDS.inverseStatIds });
const ROTO_SERIES = Object.fromEntries(Object.entries(ODDS.roto.perPeriod).map(([id, lines]) =>
    [id, Object.fromEntries(lines.map((cats, i) => [i + 1, { sums: cats, games: 1 }]))]));
const ROTO_BASIS = { ...rotoBasisFrom(ROTO_SERIES, {}), periodsLeft: ODDS.roto.periodsRemaining };
const roto = (seed, runs) => rotoOdds(ROTO_BASIS, ODDS.roto.currentTotals, ROTO_RULES, { seed, runs });

// A stand-in simulation: it records what it was asked and answers a result mergeRuns can weight.
function recorder() {
    const calls = [];
    const simulate = (seed, runs) => {
        calls.push([seed, runs]);
        return { teams: { 1: { odds: 1, seeds: [1], expectedWins: 1, clinched: false, eliminated: false } }, runs, seed, weeksUsed: 3, state: null };
    };
    return { calls, simulate };
}

// ==== the seed ====

await test('oddsSeed: FNV-1a over "<leagueId>:<period>", the four pinned cases', () => {
    FIX.oddsSeed.forEach(c => assertEq(oddsSeed(c.leagueId, c.period), c.seed, `${c.leagueId}:${c.period}`));
});

await test('oddsSeed: a number and its string are the same seed, the next period is not', () => {
    assertEq(oddsSeed(1001, 8), oddsSeed('1001', 8), 'both become the same text');
    assertEq(oddsSeed('1001', 8) === oddsSeed('1001', 9), false, 'a new period is a new draw');
});

// ==== the batch ====

await test('batchFor: the rule, the eight pinned cases', () => {
    FIX.batchFor.forEach(c => assertEq(batchFor(c.work), c.batch, JSON.stringify(c.work)));
});

await test('batchFor: missing or non-finite counts read as 0, and the batch is never under 1', () => {
    assertEq(batchFor({ path: 'h2h' }), 35000, 'no matchups: the floor of 10');
    assertEq(batchFor({ path: 'roto', periodsLeft: 'soon', teams: NaN }), 35000, 'no roto work either');
    assertEq(batchFor(undefined), 35000, 'no work at all');
    assertEq(batchFor({ path: 'roto', periodsLeft: 100000, teams: 100 }), 1, 'an absurd league still gets a batch of 1');
});

await test('the constants the contract fixes', () => {
    assertJson([ODDS_RUNS, IDLE_TIMEOUT_MS, BATCH_BUDGET], [{ h2h: 100000, roto: 10000 }, 200, 350000], 'runs, timeout, budget');
});

await test('batchSeeds: the pinned draws, and the prefix property', () => {
    FIX.batchSeeds.forEach(c => assertJson(batchSeeds(c.seed, c.batches), c.seeds, `seed ${c.seed}`));
    assertJson(batchSeeds(SEED, 3), batchSeeds(SEED, 4).slice(0, 3), 'three is the first three of four');
    assertJson(batchSeeds(SEED, 0), [], 'no batches, no seeds');
});

// ==== the yield ====

await test('yieldFrom: requestIdleCallback with the 200 ms timeout, and no deadline passed on', () => {
    let options = null;
    let args = null;
    const scope = { requestIdleCallback: (cb, opts) => { options = opts; cb({ timeRemaining: () => 9, didTimeout: false }); } };
    yieldFrom(scope)((...a) => { args = a; });
    assertJson(options, { timeout: 200 }, 'the timeout is part of the contract');
    assertJson(args, [], 'the callback gets no deadline: a batch is never sized by the time left');
});

await test('yieldFrom: setTimeout(0) where requestIdleCallback is missing', () => {
    let delay = null;
    let ran = false;
    const scope = { setTimeout: (cb, ms) => { delay = ms; cb(); } };
    yieldFrom(scope)(() => { ran = true; });
    assertJson([delay, ran], [0, true], 'the fallback');
});

// ==== the runner ====

await test('runInBatches: ten runs in batches of four are 4, 4 and 2, on the batch seeds', async () => {
    const { calls, simulate } = recorder();
    const progress = [];
    let yields = 0;
    const out = await runInBatches({ simulate, runs: 10, batch: 4, seed: 1, yieldTo: cb => { yields += 1; cb(); }, onProgress: p => progress.push(p) });
    const seeds = batchSeeds(1, 3);
    assertJson(calls, [[seeds[0], 4], [seeds[1], 4], [seeds[2], 2]], 'the last batch takes what is left');
    assertJson(progress, [{ done: 4, total: 10 }, { done: 8, total: 10 }, { done: 10, total: 10 }], 'progress after each');
    assertEq(yields, 3, 'a yield before every batch, the first included');
    assertJson([out.runs, out.seed, out.batch], [10, 1, 4], 'runs summed, the BASE seed and the batch carried');
});

await test('runInBatches: cancelled is read after each yield, and stops the work', async () => {
    const first = recorder();
    let batches = 0;
    const out = await runInBatches({ simulate: (s, r) => { batches += 1; return first.simulate(s, r); }, runs: 10, batch: 4, seed: 1, cancelled: () => batches >= 1 });
    assertEq(out, null, 'a cancelled run resolves null');
    assertEq(first.calls.length, 1, 'the batch already run is the only one');
    const never = recorder();
    assertEq(await runInBatches({ simulate: never.simulate, runs: 10, batch: 4, seed: 1, cancelled: () => true }), null, 'cancelled from the start');
    assertEq(never.calls.length, 0, 'and nothing ran, since the check follows the first yield');
});

await test('runInBatches: no runs, a batch under 1 or no simulation resolve null', async () => {
    const r = recorder();
    assertEq(await runInBatches({ simulate: r.simulate, runs: 0, batch: 4, seed: 1 }), null, 'no runs');
    assertEq(await runInBatches({ simulate: r.simulate, runs: 10, batch: 0, seed: 1 }), null, 'a batch of 0');
    assertEq(await runInBatches({ runs: 10, batch: 4, seed: 1 }), null, 'no simulation');
    assertEq(r.calls.length, 0, 'nothing ran');
});

await test('runInBatches: an error in a batch rejects the promise', async () => {
    let caught = null;
    try { await runInBatches({ simulate: () => { throw new Error('boom'); }, runs: 10, batch: 4, seed: 1 }); }
    catch (e) { caught = e.message; }
    assertEq(caught, 'boom', 'the error is the caller\'s to see');
});

// ==== determinism, the contract ====

await test('DETERMINISM: the same seed and batch give the same result, field for field', async () => {
    const a = await runInBatches({ simulate: h2h, runs: 4000, batch: 250, seed: SEED });
    const b = await runInBatches({ simulate: h2h, runs: 4000, batch: 250, seed: SEED });
    assertJson(a, b, 'two runs, one answer');
    const c = await runInBatches({ simulate: h2h, runs: 4000, batch: 1000, seed: SEED });
    assertEq(JSON.stringify(a.teams) === JSON.stringify(c.teams), false, 'a different batch is a different set of seeds');
});

for (const batch of [250, 1000]) {
    await test(`DETERMINISM: 4,000 runs in batches of ${batch} land within three points of the enumeration`, async () => {
        const out = await runInBatches({ simulate: h2h, runs: 4000, batch, seed: SEED });
        assertEq(out.runs, 4000, 'every run made');
        Object.keys(ODDS.enumerated).forEach(id => close(out.teams[id].odds, ODDS.enumerated[id].odds, `team ${id} odds`, TOL));
        const sum = Object.keys(out.teams).reduce((s, id) => s + out.teams[id].odds, 0);
        close(sum, 2, 'the odds sum to the two seats', 1e-9);
        assertEq(out.teams[3].eliminated, true, 'Charlie eliminated, deterministically, in the merged answer too');
    });
}

await test('DETERMINISM: the roto title odds, batched, land within three points too', async () => {
    const out = await runInBatches({ simulate: roto, runs: 4000, batch: 250, seed: SEED });
    Object.keys(ODDS.roto.enumerated).forEach(id => close(out.teams[id].titleOdds, ODDS.roto.enumerated[id].titleOdds, `team ${id} title odds`, TOL));
    assertEq(out.teams[1].perCategory[1].chanceAboveLeader, null, 'the leader\'s own chance stays null through the merge');
});

await test('the real scheduler of this page finishes the work', async () => {
    const out = await runInBatches({ simulate: h2h, runs: 1000, batch: 250, seed: SEED, yieldTo: yieldFrom(globalThis) });
    assertEq(out.runs, 1000, 'four batches through requestIdleCallback or its fallback');
});

// ==== what has been played ====

await test('playedFingerprint: data.js teamStats, the five pinned cases', () => {
    FIX.teamStatsFingerprints.forEach(c => assertEq(playedFingerprint(FIX.teamStats, { through: c.through }), c.fingerprint, `through ${c.through}`));
});

await test('playedFingerprint: the roto series, as an object and as a Map', () => {
    FIX.seriesFingerprints.forEach(c => assertEq(playedFingerprint(FIX.series, { through: c.through }), c.fingerprint, `through ${c.through}`));
    const asMap = new Map(Object.entries(FIX.series));
    assertEq(playedFingerprint(asMap, { through: 1 }), '1@1#2e5b773c', 'a Map reads the same');
});

await test('playedFingerprint: the matchup in progress is kept out by through, and nothing else moves it', () => {
    const live = FIX.teamStats.map(t => ({ ...t, weeklyCats: { ...t.weeklyCats, 3: { 10: 99, 20: 99 } } }));
    assertEq(playedFingerprint(live, { through: 2 }), '2@2#98710fd6', 'period 3 moved and the fingerprint did not');
    const decided = FIX.teamStats.map(t => (t.id === 1 ? { ...t, weeklyMatchWins: { ...t.weeklyMatchWins, 2: 1 } } : t));
    assertEq(playedFingerprint(decided, { through: 2 }) === '2@2#98710fd6', false, 'a corrected last period moves it');
    const reordered = [...FIX.teamStats].reverse();
    assertEq(playedFingerprint(reordered, { through: 2 }), '2@2#98710fd6', 'the order the teams arrive in does not');
});

await test('playedFingerprint: nothing played, or nothing at all, is the empty fingerprint', () => {
    assertEq(playedFingerprint([], {}), '0@0#811c9dc5', 'no teams');
    assertEq(playedFingerprint(null), '0@0#811c9dc5', 'no input');
    assertEq(playedFingerprint({}, { through: 5 }), '0@0#811c9dc5', 'an empty series');
});

// ==== the cache ====

const FRESH = { sport: 'fhl', leagueId: '1001', period: 8, fingerprint: '7@7#0badcafe', runs: 100000, batch: 1794 };
const RECORD = oddsCacheRecord({ ...FRESH, seed: 3481858173, computedAt: 1790445600000, result: { teams: {}, runs: 100000 } });

await test('oddsCacheKey and oddsCacheRecord: the key, the schema and the default variant', () => {
    assertEq(oddsCacheKey('fhl', 1001), 'playoffOdds:fhl:1001', 'one record a league');
    assertEq(ODDS_CACHE_SCHEMA, 'playoff-odds-cache/2', 'the schema');
    assertJson(Object.keys(RECORD), ['schema', 'sport', 'leagueId', 'period', 'variant', 'fingerprint', 'runs', 'batch', 'seed', 'computedAt', 'result'], 'the fields, in the contract order');
    assertJson([RECORD.schema, RECORD.variant], ['playoff-odds-cache/2', 'season'], 'schema set, variant defaults');
    assertJson(oddsCacheRecord({}).result, null, 'a missing field is null');
});

await test('oddsCacheIsFresh: fresh when every input matches, leagueId as text and period as a number', () => {
    assertEq(oddsCacheIsFresh(RECORD, FRESH), true, 'the same inputs');
    assertEq(oddsCacheIsFresh(RECORD, { ...FRESH, leagueId: 1001, period: '8' }), true, 'a number id and a text period');
    assertEq(oddsCacheIsFresh(RECORD, { ...FRESH, variant: 'season' }), true, 'season is the default on both sides');
});

await test('oddsCacheIsFresh: any input that decides the answer, changed, is stale', () => {
    const changes = { sport: 'flb', leagueId: '2002', period: 9, fingerprint: '8@8#0badcafe', runs: 10000, batch: 1166, variant: 'last8' };
    Object.entries(changes).forEach(([k, v]) => assertEq(oddsCacheIsFresh(RECORD, { ...FRESH, [k]: v }), false, `${k} changed`));
    assertEq(oddsCacheIsFresh({ ...RECORD, computedAt: 1 }, FRESH), true, 'computedAt is never compared');
});

await test('oddsCacheIsFresh: no record, another schema or no result is never fresh', () => {
    assertEq(oddsCacheIsFresh(null, FRESH), false, 'null');
    assertEq(oddsCacheIsFresh(undefined, FRESH), false, 'undefined');
    assertEq(oddsCacheIsFresh({ ...RECORD, schema: 'playoff-odds-cache/1' }, FRESH), false, 'the schema before the pooled prior');
    assertEq(oddsCacheIsFresh({ ...RECORD, result: null }, FRESH), false, 'no result');
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
