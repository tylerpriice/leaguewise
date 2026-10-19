// Unit tests for the Leaguewise archive (archive.js). Open tests/archive.test.html through any static server; green means every assertion held. The expected values are hand-computed in the fixture's expected block from the raw payloads in its input, and nothing is taken from a run of this code. Every league, team and id is invented.
import {
    buildArchive, validateArchive, mergeSeason, csvOf, summarizeSeason,
    delimitedCell, buildDelimitedText, ARCHIVE_SCHEMA
} from '../src/data/archive.js';

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
function close(got, want, msg, tol = 1e-12) {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${msg}: expected ${want} +/- ${tol}, got ${got}`);
}

const FIX = await (await fetch('fixtures/archive.json')).json();
const WRITTEN = '2026-09-23T00:00:00.000Z';
const ARCHIVE = buildArchive({ raw: FIX.input.raw, provenance: FIX.input.provenance, writtenAt: WRITTEN });
const S25 = ARCHIVE.seasons['2025'].summary;

// ==== the file ====

test('the archive names its schema and its seasons', () => {
    assertEq(ARCHIVE.schema, ARCHIVE_SCHEMA, 'one string a reader checks');
    assertEq(ARCHIVE.schema, 'leaguewise-archive/1', 'and it is this one');
    assertEq(ARCHIVE.writtenAt, WRITTEN, 'the instant it was built');
    assertJson(ARCHIVE.provenance.seasons, [2025, 2026], 'filled from what was written');
    assertJson(Object.keys(ARCHIVE.seasons), ['2025', '2026'], 'keyed by year as a string');
});

test('the header cannot disagree with the body', () => {
    // Whatever a caller claims for provenance.seasons is overwritten by what was actually written.
    const lying = buildArchive({
        raw: { 2025: FIX.input.raw['2025'] },
        provenance: { ...FIX.input.provenance, seasons: [1999, 2000, 2001] },
        writtenAt: WRITTEN
    });
    assertJson(lying.provenance.seasons, [2025], 'the claim is replaced, not trusted');
});

test('raw is kept verbatim, and only the slots the schema names', () => {
    const kept = ARCHIVE.seasons['2025'].raw;
    assertJson(Object.keys(kept).sort(), ['draft', 'league', 'rosters'], 'the three this season has');
    assertEq(kept.league, FIX.input.raw['2025'].league, 'the payload itself, not a copy of it');
    assertJson(Object.keys(ARCHIVE.seasons['2026'].raw), ['league'], 'and a season with only a league');
});

test('a season with no league payload is skipped, not half-written', () => {
    const a = buildArchive({ raw: { 2024: { pool: { players: [] } }, 2025: FIX.input.raw['2025'] }, provenance: {}, writtenAt: WRITTEN });
    assertJson(Object.keys(a.seasons), ['2025'], 'a season without a league is not a season');
    assertJson(a.provenance.seasons, [2025], 'and the header agrees');
});

test('a malformed part is an empty summary, never an exception', () => {
    const a = buildArchive({ raw: { 2025: { league: { settings: {}, teams: null, schedule: null } } }, provenance: {}, writtenAt: WRITTEN });
    const s = a.seasons['2025'].summary;
    assertJson(s.teams, [], 'no teams');
    assertJson(s.periods, [], 'no schedule, so no periods');
    assertEq(s.rosters, undefined, 'and nothing invented to fill the gap');
});

// ==== the summary ====

test('the league summary is re-derived from the raw settings', () => {
    assertJson(S25.league, FIX.expected.league2025, 'name, size, type, categories, periods, seats');
});

test('standings recompute, with a tie at half a win', () => {
    assertEq(S25.teams.length, 6, 'six teams');
    FIX.expected.teams2025.forEach((want, i) => {
        const got = S25.teams[i];
        assertEq(got.id, want.id, `team ${want.name} id`);
        assertEq(got.name, want.name, 'name');
        assertEq(got.abbrev, want.abbrev, 'abbrev');
        assertEq(got.record.wins, want.record.wins, `${want.name} wins`);
        assertEq(got.record.ties, want.record.ties, `${want.name} ties`);
        close(got.record.percentage, want.record.percentage, `${want.name} percentage`);
        assertEq(got.seed, want.seed, `${want.name} seed`);
    });
    // Bravo is the case worth naming: 0-1-1 over two games is 0.5 points of 2, which is 0.25.
    const bravo = S25.teams.find(t => t.name === 'Bravo');
    close(bravo.record.percentage, 0.25, 'a tie is half a win and nothing else');
    // Echo played no games at all: no division, and no pretending it went undefeated.
    const echo = S25.teams.find(t => t.name === 'Echo');
    assertEq(echo.record.percentage, 0, 'no games is zero, not NaN and not 1');
});

test('the live block beats the rollup where the two disagree', () => {
    const m = S25.periods[0].matchups.find(x => x.home === 1 && x.away === 2);
    assertEq(m.categories['1'].home, 12, 'the live block says 12 where the rollup says 10');
    assertEq(m.categories['1'].away, 9, 'and the away side agrees either way');
});

test('a bye writes no matchup at all', () => {
    assertEq(S25.periods.length, 1, 'one period');
    assertEq(S25.periods[0].matchups.length, 3, 'three matchups, not four - team 5 had a bye');
    assertEq(S25.periods[0].matchups.some(m => m.home === 5 || m.away === 5), false, 'and it is nowhere');
});

test('the periods are the hand-computed ones, matchup by matchup', () => {
    assertJson(S25.periods, FIX.expected.periods2025, 'every side, winner and category');
});

test('the draft and the rosters are renamed into the archive own words', () => {
    assertJson(S25.draft, FIX.expected.draft2025, 'picks in overall order');
    assertJson(S25.rosters, FIX.expected.rosters2025, 'p and slot become playerId and slot');
    // The slot is the whole reason the roster harvest exists.
    assertEq(S25.rosters['1'][0].entries[0].slot, 3, 'a started slot');
    assertEq(S25.rosters['1'][0].entries[1].slot, 20, 'and a bench one, told apart');
});

test('a season without a draft or a harvest carries neither key', () => {
    const s26 = ARCHIVE.seasons['2026'].summary;
    assertEq(s26.draft, undefined, 'absent rather than empty');
    assertEq(s26.rosters, undefined, 'and likewise');
    assertEq(Array.isArray(s26.teams), true, 'but the teams are still there');
});

// ==== the gate ====

test('the archive this module builds passes its own gate', () => {
    const v = validateArchive(ARCHIVE);
    assertEq(v.ok, true, `it should validate: ${JSON.stringify(v.issues)}`);
    assertJson(v.issues, [], 'with nothing to say');
});

test('every rule refuses, and names a path', () => {
    const bad = (mutate) => {
        const copy = JSON.parse(JSON.stringify(ARCHIVE));
        mutate(copy);
        return validateArchive(copy);
    };
    const paths = v => v.issues.map(i => i.path);

    assertEq(bad(a => { a.schema = 'leaguewise-archive/2'; }).ok, false, 'rule 1: another schema is not this one');
    assertEq(paths(bad(a => { a.schema = 'x'; }))[0], 'schema', 'and it says which field');
    assertEq(bad(a => { a.writtenAt = 'not a date'; }).ok, false, 'rule 2: writtenAt must parse');
    assertEq(bad(a => { delete a.provenance.extensionVersion; }).ok, false, 'rule 3: the version is required');
    assertEq(paths(bad(a => { delete a.provenance.sport; }))[0], 'provenance.sport', 'and names itself');
    assertEq(bad(a => { a.seasons = {}; }).ok, false, 'rule 5: an archive of no seasons is not one');
    assertEq(bad(a => { a.seasons.nineteen = a.seasons['2025']; }).ok, false, 'rule 6: a key must be a year');
    assertEq(bad(a => { delete a.seasons['2025'].raw.league; }).ok, false, 'rule 7: a season needs its league');
    assertEq(bad(a => { delete a.seasons['2025'].summary; }).ok, false, 'rule 7: and its summary');
    assertEq(bad(a => { a.provenance.seasons = [2025]; }).ok, false, 'rule 8: the header must match the body');
});

test('rule 4 refuses a secret at any depth, in any case', () => {
    const withSecret = (prov) => validateArchive({ ...ARCHIVE, provenance: { ...ARCHIVE.provenance, ...prov } });
    assertEq(withSecret({ SWID: '{abc}' }).ok, false, 'a SWID, however it is capitalised');
    assertEq(withSecret({ espn_s2: 'x' }).ok, false, 'the other cookie');
    assertEq(withSecret({ memberId: 'x' }).ok, false, 'a member id');
    assertEq(withSecret({ nested: { deeper: { token: 'x' } } }).ok, false, 'buried two levels down');
    assertEq(withSecret({ list: [{ cookie: 'x' }] }).ok, false, 'and inside an array');
    const v = withSecret({ nested: { deeper: { token: 'x' } } });
    assertEq(v.issues[0].path, 'provenance.nested.deeper.token', 'the path says exactly where');
    // A field that merely mentions one of the words is not a secret.
    assertEq(withSecret({ tokenCount: 3 }).ok, true, 'a key is matched whole, not by substring');
});

// ==== merging ====

test('a re-export replaces one season and keeps the other', () => {
    const replacement = { raw: { league: FIX.input.raw['2026'].league }, summary: { league: { name: 'redone' }, teams: [], periods: [] } };
    const merged = mergeSeason(ARCHIVE, 2026, replacement, WRITTEN);
    assertJson(Object.keys(merged.seasons).sort(), ['2025', '2026'], 'both seasons are still there');
    assertEq(merged.seasons['2026'].summary.league.name, 'redone', '2026 is the new one');
    assertEq(merged.seasons['2025'].summary.league.name, 'Phonetic Six', 'and 2025 is untouched');
    assertJson(merged.provenance.seasons, [2025, 2026], 'the header follows the body');
});

test('a merge appends a season the archive did not have', () => {
    const merged = mergeSeason(ARCHIVE, 2024, { raw: { league: {} }, summary: {} }, WRITTEN);
    assertJson(merged.provenance.seasons, [2024, 2025, 2026], 'three now, in order');
});

test('the input is untouched, so a failed merge cannot corrupt it', () => {
    const before = JSON.stringify(ARCHIVE);
    mergeSeason(ARCHIVE, 2026, { raw: { league: {} }, summary: {} }, WRITTEN);
    assertEq(JSON.stringify(ARCHIVE), before, 'a new object every time');
});

// ==== CSV ====

test('the RFC 4180 rule quotes only what must be quoted', () => {
    assertEq(delimitedCell('plain'), 'plain', 'nothing to quote');
    assertEq(delimitedCell('a,b'), '"a,b"', 'the delimiter');
    assertEq(delimitedCell('say "hi"'), '"say ""hi"""', 'an embedded quote doubles');
    assertEq(delimitedCell('two\nlines'), '"two\nlines"', 'a line break');
    assertEq(delimitedCell(null), '', 'null is an empty cell, not the word');
    assertEq(delimitedCell(undefined), '', 'and so is undefined');
    assertEq(buildDelimitedText(['a', 'b'], [[1, 2]]), 'a,b\r\n1,2', 'CRLF between lines');
});

test('the standings CSV is the hand-written line', () => {
    const lines = csvOf(ARCHIVE, 2025, 'standings').split('\r\n');
    assertEq(lines[0], FIX.expected.csv.standingsHeader, 'the header');
    assertEq(lines[1], FIX.expected.csv.standingsFirst, 'Alpha 1-0-0');
    assertEq(lines.length, 7, 'a header and six teams');
});

test('the draft CSV is the hand-written line', () => {
    const lines = csvOf(ARCHIVE, 2025, 'draft').split('\r\n');
    assertEq(lines[0], FIX.expected.csv.draftHeader, 'the header');
    assertEq(lines[1], FIX.expected.csv.draftFirst, 'the first pick');
});

test('the category CSV is one row a side, with the matchup kept whole', () => {
    const lines = csvOf(ARCHIVE, 2025, 'categories').split('\r\n');
    assertEq(lines[0], 'Period,Team,Opponent,Result,1,3,4', 'the scored ids as columns');
    assertEq(lines.length, 7, 'a header and two rows for each of three matchups');
    assertEq(lines[1], '1,Alpha,Bravo,Win,12,5,2', "Alpha's own side of the live-block matchup");
    assertEq(lines[2], '1,Bravo,Alpha,Loss,9,7,3', 'and Bravo the other way round');
    assertEq(lines.some(l => l.startsWith('1,Foxtrot,Bravo,Tie')), true, 'a tie reads Tie on both sides');
});

test('an unknown table or a missing year is empty, not a header', () => {
    assertEq(csvOf(ARCHIVE, 2025, 'nonsense'), '', 'no such table');
    assertEq(csvOf(ARCHIVE, 1999, 'standings'), '', 'no such year');
    assertEq(csvOf(ARCHIVE, 2026, 'draft'), '', 'that season has no draft, so no file');
});

// ==== standing alone ====

test('summarizeSeason works on raw with no archive around it', () => {
    // The claim the whole module rests on: the normalised half is derivable from a raw payload by itself, with nothing else loaded.
    const s = summarizeSeason(FIX.input.raw['2025']);
    assertJson(s.league, FIX.expected.league2025, 'the same summary, built standalone');
    assertEq(summarizeSeason({}), null, 'and nothing at all is null rather than an empty shell');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
