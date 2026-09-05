// Unit tests for the team-compare renderer (team-compare-band.js, the team half / S22). Built against teamCompare()'s own real output (tests/fixtures/team-compare.md) rather than a hand-typed row shape, so a contract drift breaks these tests too.
import { teamCompare } from '../team-compare.js';
import { buildTeamCompareHtml } from '../team-compare-band.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Baseball ids: 5 HR, 20 R, 2 AVG (rate), 1 H, 0 AB, 9 SLG, 17 OBP, 18 OPS (rate, add).
const MINE = { teamId: 3, name: 'Fixture Nine' };
const THEIRS = { teamId: 7, name: 'Rival Nine' };
const RATE_COMPONENTS = [
    { out: '2', num: ['1'], den: ['0'] },
    { out: '18', add: ['17', '9'] }
];
const BASE = {
    scoredIds: ['5', '20', '2', '18'],
    statLabels: { '5': 'HR', '20': 'R', '2': 'AVG', '18': 'OPS', '17': 'OBP', '9': 'SLG' },
    lowerIsBetterIds: new Set(),
    rateIds: new Set(['2', '18']),
    rateComponents: RATE_COMPONENTS
};
const ctx = (over = {}) => ({ ...BASE, ...over });
const opts = { escapeHtml: s => String(s), rateComponents: RATE_COMPONENTS, statLabels: BASE.statLabels };

test('null compare renders nothing', () => {
    assert(buildTeamCompareHtml(null, opts) === '', 'the band is absent when the model refused');
});

test('a played window: headline says "winning", not "won", with asOf', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160], asOf: 162 },
        played: { 3: { 22: { '5': 31, '20': 80 } }, 7: { 22: { '5': 24, '20': 92 } } }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('Fixture Nine'), 'the team is the subject, no pronoun');
    assert(html.includes('winning'), 'a played window says winning');
    assert(!html.includes('>won<') && !html.includes(' won '), 'never "won" - the contract reserves that certainty');
    assert(html.includes('as of period 162'), 'asOf makes "winning" sayable');
    assert(!html.includes('tc-caveat'), 'no roster caveat on a played window');
});

test('a projected window: "projected to win", never a bare "win", plus the roster caveat', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'projected', label: 'Rest of season', matchup: null, periods: [163, 164], asOf: 162 },
        projected: {
            3: [{ rates: { '5': 0.5 }, games: 6 }],
            7: [{ rates: { '5': 0.4 }, games: 5 }]
        }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('projected to win'), 'the projected verb, never a claimed result');
    assert(!html.includes('>Fixture Nine winning'), 'never the played verb on a projected window');
    assert(html.includes('tc-caveat'), 'the roster caveat is the surface\'s, not a footnote\'s');
    assert(html.includes('today'), 'and it says the projection is off TODAY\'S roster');
});

test('the winning side is colour-marked, the losing side dimmed, direction never re-derived by the renderer', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160], asOf: 162 },
        played: { 3: { 22: { '5': 31 } }, 7: { 22: { '5': 24 } } }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('tc-val tc-val-mine tc-win'), 'mine leads HR');
    assert(html.includes('tc-val tc-val-theirs tc-lose'), 'theirs is dimmed, not just uncoloured');
    assert(html.includes('tc-edge-mine'), 'the edge chip points at the winner too');
    assert(html.includes('&larr;'), 'the arrow points left when mine wins');
});

test('a tie reads "even", not a win for either side', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160], asOf: 162 },
        played: { 3: { 22: { '5': 24 } }, 7: { 22: { '5': 24 } } }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('tc-edge-tie'), 'tied gets its own chip class');
    assert(html.includes('>even<'), 'and its own word');
    assert(!html.includes('tc-win'), 'nobody is marked a winner');
});

test('a null cell is muted, not a dash meaning zero, with a hover naming the reason', () => {
    // A multi-matchup played window loses OPS - AB/H are not in the totals, so it cannot rebuild; OPS's own components (via the add:['17','9'] mapping) name the reason.
    const out = teamCompare(MINE, THEIRS, ctx({
        window: { kind: 'played', label: 'Both', matchup: null, periods: [160, 167], asOf: 167 },
        played: { 3: { 21: { '18': 0.8 }, 22: { '18': 0.75 } }, 7: { 21: { '18': 0.7 } } }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('tc-val-none'), 'the null cell carries its own muted class');
    assert(html.includes('OPS needs OBP and SLG, which this window does not carry'), 'the contract\'s own example reproduced generically');
    assert(html.includes('tc-edge-none'), 'no edge either');
});

test('lowerIsBetter carries the inverse mark, the same convention the 1v1 view uses', () => {
    const out = teamCompare(MINE, THEIRS, ctx({
        scoredIds: ['47'],
        statLabels: { '47': 'ERA' },
        lowerIsBetterIds: new Set(['47']),
        rateIds: new Set(['47']),
        rateComponents: [{ out: '47', num: ['45'], den: ['34'], scale: 27 }],
        window: { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160], asOf: 162 },
        played: { 3: { 22: { '47': 3.10 } }, 7: { 22: { '47': 3.40 } } }
    }));
    const html = buildTeamCompareHtml(out, opts);
    assert(html.includes('tc-inv'), 'the down-arrow mark renders');
    assert(html.includes('tc-val tc-val-mine tc-win'), 'the LOWER era leads, direction applied once by the model');
});

// Report ---------------------------------------------------------------------------
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
