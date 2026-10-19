// Unit tests for the team-compare renderer (team-compare-band.js). Built against teamCompare()'s own real output (tests/fixtures/team-compare.md) rather than a hand-typed row shape, so a contract drift breaks these tests too.
import { teamCompare } from '../src/engines/team-compare.js';
import { buildTeamCompareHtml, buildFacePillHtml } from '../src/views/team-compare-band.js';

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
    // A multi-matchup played window loses OPS, since AB/H are not in the totals and it cannot rebuild. OPS's own components (via the add:['17','9'] mapping) name the reason.
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

// The workload header and the swing marker. Built as hand-typed `compare` objects straight into buildTeamCompareHtml, bypassing teamCompare(), because these tests exercise the renderer's own reading of the contract's shape, not the model that produces it (team-compare.js has its own suite for workloadFor/swingOf).
const ROW = (over = {}) => ({ id: '5', label: 'HR', mine: 31, theirs: 24, edge: 7, leader: 'mine', lowerIsBetter: false, rate: false, projected: false, swing: null, ...over });
const WINDOW = { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160, 161, 162], asOf: 162 };

test('no ctx.workload at all: the header is omitted entirely, not drawn empty', () => {
    const compare = { window: WINDOW, mine: { teamId: 3, name: 'Mine', workload: null }, theirs: { teamId: 7, name: 'Theirs', workload: null }, rows: [ROW()] };
    const html = buildTeamCompareHtml(compare, opts);
    assert(!html.includes('tc-work'), 'no workload block when both sides carry null');
});

test('baseball workload: four tiles a side, Starts coloured by which side leads, the probable/estimated caption', () => {
    const compare = {
        window: WINDOW,
        mine: { teamId: 3, name: 'Mine', workload: { starts: { count: 12, probable: 9, estimated: 3, listed: 14 }, hitterGames: 118, offDays: 2, il: 1 } },
        theirs: { teamId: 7, name: 'Theirs', workload: { starts: { count: 9, probable: 6, estimated: 3, listed: 11 }, hitterGames: 121, offDays: 3, il: 2 } },
        rows: [ROW()]
    };
    const html = buildTeamCompareHtml(compare, opts);
    assert(html.includes('tc-work'), 'the workload block renders');
    assert((html.match(/tc-work-tile/g) || []).length === 8, 'four tiles a side, both sides carry starts');
    assert(html.includes('<b class="up">14</b>'), 'the higher Starts (mine, 14 listed) is coloured up');
    assert(html.includes('<b class="dn">11</b>'), 'the lower Starts (theirs, 11 listed) is coloured dn');
    assert(html.includes('118') && html.includes('121'), 'hitter games print for both sides');
    assert(html.includes('9 of yours and 6 of theirs are ESPN probables'), 'the probable count, not the combined starts.count');
    assert(html.includes('data-hint="Starts across the staff, bench included'), 'the fixed seat-rule sentence, as the mark hover');
    assert(html.includes('Matchup 22') && html.includes('3 days'), 'the middle column reads the window\'s own label and day count');
});

test('football/hockey workload: starts is null on both sides, the Starts tile drops to three a side, no probable sentence', () => {
    const compare = {
        window: WINDOW,
        mine: { teamId: 3, name: 'Mine', workload: { starts: null, hitterGames: 40, offDays: 0, il: 1 } },
        theirs: { teamId: 7, name: 'Theirs', workload: { starts: null, hitterGames: 38, offDays: 1, il: 0 } },
        rows: [ROW()]
    };
    const html = buildTeamCompareHtml(compare, opts);
    assert((html.match(/tc-work-tile/g) || []).length === 6, 'three tiles a side when starts is null');
    assert(!html.includes('>Starts<'), 'no Starts tile at all');
    assert(!html.includes('ESPN probables'), 'the probable/estimated sentence is skipped outright, not printed with zeros');
});

test('a swing row carries the tag; a non-swing row (false or null) carries none', () => {
    const compare = {
        window: WINDOW,
        mine: { teamId: 3, name: 'Mine', workload: null }, theirs: { teamId: 7, name: 'Theirs', workload: null },
        rows: [ROW({ id: '5', swing: true }), ROW({ id: '20', label: 'R', swing: false }), ROW({ id: '2', label: 'AVG', swing: null })]
    };
    const html = buildTeamCompareHtml(compare, opts);
    assert((html.match(/tc-swing/g) || []).length === 1, 'exactly one row carries the swing tag');
});

// The day strip. `opts.dayStrip` is this renderer's own shape, not part of the frozen team-compare contract. startStrip() (team-compare.js amendment 2) is pure and per-day and paging is the caller's, so these fixtures are hand-built matching startStrip's own row shape exactly rather than fetched from a model instance.
const NO_WORKLOAD_COMPARE = { window: WINDOW, mine: { teamId: 3, name: 'Mine', workload: null }, theirs: { teamId: 7, name: 'Theirs', workload: null }, rows: [ROW()] };

// One week. Monday is off for both, Tuesday is a two-start stack for mine (one played, one still ahead, so both tones get exercised), and Wednesday has one apiece for theirs only.
const WEEK = [
    { period: 1, date: 1, label: 'Mon', mine: [], theirs: [] },
    {
        period: 2, date: 2, label: 'Tue',
        mine: [
            { playerId: 10, name: 'Hiroshi Yamamoto', opponent: 'vsLAA', opponentId: 3, isHome: true, probable: false, period: 2 },
            { playerId: 11, name: 'Casey Burns', opponent: '@SD', opponentId: 4, isHome: false, probable: true, period: 2 }
        ],
        theirs: []
    },
    {
        period: 3, date: 3, label: 'Wed',
        mine: [],
        theirs: [{ playerId: 20, name: 'Paul Skenes', opponent: 'vsCHC', opponentId: 5, isHome: true, probable: true, period: 3 }]
    }
];
const DAY_STRIP = (over = {}) => ({
    sport: 'flb', open: true, weekIndex: 1, weekCount: 2, rangeLabel: 'Jan 1 - Jan 3',
    canPrev: false, canNext: true, days: WEEK, ...over
});

test('no dayStrip in opts draws the headline alone, no control', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, opts);
    assert(html.includes('tc-headline'), 'the headline still renders');
    assert(!html.includes('tc-strip-toggle'), 'no control when the caller never asked for one');
    assert(!html.includes('tc-strip-grid'), 'no grid either');
});

test('the day-strip control sits beside the headline, reading Week X of Y and the range', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    assert(html.includes('tc-head-row'), 'headline and control share one row');
    assert(html.includes('Week 1 of 2'), 'the week count');
    assert(html.includes('Jan 1 - Jan 3'), 'the caller-formatted range');
    assert(html.includes('tc-strip-prev" aria-label="Earlier week" disabled'), 'disabled at the first week (canPrev false)');
    assert(!/tc-strip-next"[^>]*disabled/.test(html), 'not disabled going forward (canNext true)');
});

test('closed (open:false) draws the control but not the grid', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP({ open: false }) });
    assert(html.includes('tc-strip-toggle'), 'the control is always there once dayStrip exists');
    assert(!html.includes('tc-strip-grid'), 'the grid only draws while open');
});

test('every day of the week gets a column, empty ones included - Monday is "off" for both sides', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    const offCount = (html.match(/tc-day-off/g) || []).length;
    // Monday (both sides) + Tuesday theirs + Wednesday mine = 4 empty cells for a 3-day, 2-side grid.
    assert(offCount === 4, `expected 4 off cells, found ${offCount}`);
    assert(html.includes('>Mon<'), 'Monday heads its column');
    assert(html.includes('>Tue<') && html.includes('>Wed<'), 'every day in the window, not only the ones with a start');
});

test('two starters the same day stack, surname and opponent both on one line (owner, S66c)', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    assert(html.includes('>Yamamoto vs LAA<'), 'surname and opponent both visible, no mark - already played');
    assert(!html.includes('>Hiroshi Yamamoto<'), 'the full name never prints in the cell itself');
    assert(html.includes('data-tooltip="Hiroshi Yamamoto vs LAA"'), 'the full name still rides on hover');
    const tueCell = html.slice(html.indexOf('>Yamamoto'), html.indexOf('>Skenes'));
    assert(tueCell.indexOf('Yamamoto') < tueCell.indexOf('Burns'), 'both starters render, roster order preserved');
});

test('"vs" gets a space, "@" stays tight (owner, S66d) - startStrip itself hands both tight', () => {
    // The contract (team-compare.js) builds `opponent` tight either way ("vsLAA", "@SD") and takes no opinion on spacing; this renderer is where the two marks are told apart.
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    assert(html.includes('vs LAA'), 'a home game gets the space back');
    assert(!html.includes('vsLAA'), 'never the tight form for "vs"');
    assert(html.includes('@SD'), 'an away game stays tight');
    assert(!html.includes('@ SD'), 'never a space after "@"');
});

test('STILL AHEAD (probable:true) carries the tilde and the accent class; a played start carries neither', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    // Burns (probable:true) is still ahead; Yamamoto (probable:false) already played.
    const burns = html.slice(html.indexOf('Burns') - 60, html.indexOf('Burns') + 40);
    assert(burns.includes('tc-day-ahead') && burns.includes('~'), 'the still-ahead starter gets the class and the mark');
    const yamamoto = html.slice(html.indexOf('Yamamoto') - 60, html.indexOf('Yamamoto') + 40);
    assert(!yamamoto.includes('tc-day-ahead') && !/Yamamoto vs LAA ?~/.test(yamamoto), 'a played start gets neither');
});

test('the summary line counts totals and "still ahead" separately, per side, never inventing an estimate', () => {
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP() });
    // Mine has Yamamoto (played) and Burns (ahead), 2 total with 1 still ahead. Theirs has Skenes (ahead), 1 of 1. The wording is a comma before the count and a middle dot between the two sides, never a parenthetical.
    assert(html.includes('Week 1: 2 starts for you, 1 still ahead · 1 for them, 1 still ahead'), 'the exact sentence, both sides');
});

test('a week entirely past ESPN\'s posted horizon says so, rather than reading as a real week nobody pitches', () => {
    const allOff = [
        { period: 1, date: 1, label: 'Mon', mine: [], theirs: [] },
        { period: 2, date: 2, label: 'Tue', mine: [], theirs: [] }
    ];
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP({ days: allOff, pastHorizon: true }) });
    assert(html.includes('ESPN has not posted this week\'s starts yet'), 'the note prints');
    assert(html.indexOf('tc-strip-note') < html.indexOf('tc-strip-summary'), 'between the grid and the summary, not after it');
});

test('a week within the posted horizon carries no note, even with every cell off', () => {
    const allOff = [
        { period: 1, date: 1, label: 'Mon', mine: [], theirs: [] },
        { period: 2, date: 2, label: 'Tue', mine: [], theirs: [] }
    ];
    const html = buildTeamCompareHtml(NO_WORKLOAD_COMPARE, { ...opts, dayStrip: DAY_STRIP({ days: allOff, pastHorizon: false }) });
    assert(!html.includes('has not posted'), 'a real off week (within the horizon) says nothing extra');
});

// ==== A points league's band, over team-compare-points.json's hand-built week (contract amendment 4). ====
const PTS_CTX = {
    window: { kind: 'played', label: 'Matchup 2', matchup: 2, periods: [2], asOf: 2 },
    scoredIds: ['3', '25', '20', '53', '91', '60', '77'],
    statLabels: { '3': 'PYDS', '25': 'RTD', '20': 'INT', '53': 'REC', '91': 'DPA0', '60': 'X', '77': 'ZERO' },
    isPointsLeague: true,
    weights: { '3': 0.25, '25': 6, '20': -2, '53': 0.5, '91': 3, '60': null, '77': 1 },
    played: {
        3: { 2: { '3': 240, '25': 3, '20': 1, '53': 21, '91': 1, '60': 4, '77': 0 } },
        7: { 2: { '3': 300, '25': 1, '20': 2, '53': 14, '91': 0, '60': 9, '77': 0 } }
    }
};
const PTS = () => teamCompare({ teamId: 3, name: 'Fixture Eleven' }, { teamId: 7, name: 'Rival Eleven' }, PTS_CTX);

test('a points band prints the points edge, not the stat edge', () => {
    const html = buildTeamCompareHtml(PTS(), opts);
    assert(html.includes('tc-band-points'), 'the band is marked as a points band');
    // PYDS: stat edge is 60 (240 v 300) but the POINTS edge is 15, theirs lead.
    const pyds = html.slice(html.indexOf('PYDS'), html.indexOf('RTD'));
    assert(pyds.includes('15') && !pyds.includes('60&thinsp;'), 'PYDS reads the 15-point edge');
});

test('a row with no leader is a dash and never an arrow', () => {
    const html = buildTeamCompareHtml(PTS(), opts);
    const x = html.slice(html.indexOf('>X<'), html.indexOf('ZERO') > 0 ? html.indexOf('ZERO') : html.length);
    assert(x.includes('tc-edge-none'), 'the unweighted row has a dash');
    assert(!/tc-edge-(mine|theirs)/.test(x.split('tc-row')[0]), 'and no arrow');
});

test('each side shows its points beside its value', () => {
    const html = buildTeamCompareHtml(PTS(), opts);
    assert(html.includes('<small class="tc-pts">60</small>240') && html.includes('300<small class="tc-pts">75</small>'), 'mine: points then value; theirs: value then points');
});

test('a total with a missing row is never printed as the score', () => {
    const html = buildTeamCompareHtml(PTS(), opts);      // the unweighted row X leaves each total partial
    assert(!html.includes('89.5') && !html.includes('84'), 'the partial totals are not in the headline');
    const full = teamCompare({ teamId: 3, name: 'Fixture Eleven' }, { teamId: 7, name: 'Rival Eleven' }, { ...PTS_CTX, scoredIds: ['3', '25', '20', '53', '91'] });
    const fullHtml = buildTeamCompareHtml(full, opts);
    assert(fullHtml.includes('<strong>89.5</strong> to <strong>84</strong>'), 'a complete total is the score');
});

test('rows both sides have at 0 stay inline in their category order, no fold (B10 M5 revision 5 item 5)', () => {
    const html = buildTeamCompareHtml(PTS(), opts);
    assert(!html.includes('tc-zero') && !html.includes('at 0 for both'), 'no disclosure and no count of folded rows');
    assert(html.includes('ZERO'), 'the zero row is printed');
    const rowsHtml = html.slice(html.indexOf('ZERO') - 400, html.indexOf('ZERO') + 400);
    assert(rowsHtml.includes('tc-edge-tie'), 'it carries the even mark a tied row always carries');
});

test('the games tile names its own sport role, never the baseball word on another sport (B280 5.2c)', () => {
    const compare = {
        window: WINDOW,
        mine: { teamId: 3, name: 'Mine', workload: { starts: null, hitterGames: 40, offDays: 0, il: 1 } },
        theirs: { teamId: 7, name: 'Theirs', workload: { starts: null, hitterGames: 38, offDays: 1, il: 0 } },
        rows: [ROW()]
    };
    const html = (word) => buildTeamCompareHtml(compare, word === undefined ? opts : { ...opts, workloadWord: word });
    assert(html().includes('Hitter games'), 'unset keeps the original word');
    assert(html('Skater').includes('Skater games') && !html('Skater').includes('Hitter'), 'hockey says Skater');
    assert(html('Player').includes('Player games') && !html('Player').includes('Hitter'), 'football says Player');
    assert(html('').includes('>Games<') && !html('').includes('Hitter'), 'no word at all reads Games');
});

test('the rows group by role, primary first, a labelled divider between and each order kept (B282 2.1)', () => {
    const r = (label, group) => ({ ...ROW(), id: label, label, group });
    const compare = {
        window: WINDOW,
        mine: { teamId: 3, name: 'Mine', workload: null }, theirs: { teamId: 7, name: 'Theirs', workload: null },
        // interleaved, as a league's scoring items are
        rows: [r('W', 'secondary'), r('HR', 'primary'), r('SV', 'secondary'), r('R', 'primary'), r('K', 'secondary')]
    };
    const html = buildTeamCompareHtml(compare, { ...opts, groupLabels: { primary: 'Batters', secondary: 'Pitchers' } });
    assert((html.match(/tc-group-head/g) || []).length === 2, 'two group heads');
    const at = (t) => html.indexOf('>' + t + '<');
    assert(html.indexOf('>Batters<') < at('HR') && at('HR') < at('R') && at('R') < html.indexOf('>Pitchers<'), 'batters, in their own order, first');
    assert(html.indexOf('>Pitchers<') < at('W') && at('W') < at('SV') && at('SV') < at('K'), 'pitchers after, in their own order');
});

test('no group, or one group only, is one list and no divider (B282 2.1)', () => {
    const rowsOf = (g) => [{ ...ROW(), label: 'HR', group: g }, { ...ROW(), id: '2', label: 'R', group: g }];
    const compareOf = (rows) => ({ window: WINDOW, mine: { teamId: 3, name: 'Mine', workload: null }, theirs: { teamId: 7, name: 'Theirs', workload: null }, rows });
    assert(!buildTeamCompareHtml(compareOf(rowsOf(null)), opts).includes('tc-group-head'), 'null group: no divider');
    assert(!buildTeamCompareHtml(compareOf(rowsOf('primary')), opts).includes('tc-group-head'), 'a single group: no divider');
});

// Report --------------------------------------------------------------------------- The matchup chance (matchup-face.js's model): a bar and a mark per row keyed by stat id, and the pill ---------------------------------------------------------------------------

const FACE_WIN = {
    played: { 3: { 22: { '5': 31, '20': 80 } }, 7: { 22: { '5': 24, '20': 92 } } },
    window: { kind: 'played', label: 'Matchup 22', matchup: 22, periods: [160], asOf: 162 }
};
const faceModel = (over = {}) => ({
    refusal: null,
    shows: 'number', word: 'close',
    odds: {
        chance: 0.394, tie: 0.095, lose: 0.511,
        perCategory: [
            { statId: '5', chanceWin: 0.75, chanceTie: 0.125, chanceLose: 0.125 },
            { statId: '20', chanceWin: 0.25, chanceTie: 0, chanceLose: 0.75 }
        ]
    },
    marks: { fallback: ['20'], leftOut: [] },
    ...over
});

test('a bar per row keyed by stat id, widths from the model and nothing else', () => {
    const out = teamCompare(MINE, THEIRS, ctx(FACE_WIN));
    const html = buildTeamCompareHtml(out, { ...opts, face: faceModel() });
    const bars = html.match(/<span class="mf-bar"[^>]*><i class="w" style="width:[\d.]+%"><\/i><i class="t" style="width:[\d.]+%"><\/i><\/span>/g) || [];
    assert(bars.length === 2, 'one bar for each of the two rows the model has a figure for, got ' + bars.length);
    assert(html.includes('style="width:75.0%"></i><i class="t" style="width:12.5%"'), 'the HR bar is 75 win and 12.5 tie, read to the digit');
    assert(html.includes('style="width:25.0%"></i><i class="t" style="width:0.0%"'), 'the R bar is 25 win and no tie');
});

test('the mark rides a row whose stat is in marks, with a plain reason, and no other row', () => {
    const out = teamCompare(MINE, THEIRS, ctx(FACE_WIN));
    const html = buildTeamCompareHtml(out, { ...opts, face: faceModel() });
    const marks = html.match(/<i class="mf-info" data-tooltip="[^"]*">i<\/i>/g) || [];
    assert(marks.length === 1, 'exactly one mark, got ' + marks.length);
    assert(marks[0].includes('Estimated from season rates'), 'the fallback reason in words');
    const left = buildTeamCompareHtml(out, { ...opts, face: faceModel({ marks: { fallback: [], leftOut: [{ statId: '5', reason: 'no spread', side: 'mine' }] } }) });
    assert(left.includes('Left out: too little to measure'), 'a left-out stat carries its own reason');
});

test('no face, a refusal and a null chance leave the rows as they were', () => {
    const out = teamCompare(MINE, THEIRS, ctx(FACE_WIN));
    const plain = buildTeamCompareHtml(out, opts);
    assert(buildTeamCompareHtml(out, { ...opts, face: null }) === plain, 'no face, no change');
    assert(buildTeamCompareHtml(out, { ...opts, face: { refusal: 'no matchup' } }) === plain, 'a refusal draws nothing');
    const none = buildTeamCompareHtml(out, { ...opts, face: faceModel({ odds: null, marks: { fallback: [], leftOut: [] } }) });
    assert(none === plain, 'odds null: the rows draw no bar and no mark');
});

test('the pill: a number with its tie, a word alone, a blank with its mark, nothing for a refusal', () => {
    assert(buildFacePillHtml(faceModel(), {}) === '<span class="mf-chance"><b>39%</b><small>10% tie</small></span>', 'the number and the tie, rounded');
    assert(buildFacePillHtml(faceModel({ odds: { chance: 0.62, tie: 0, lose: 0.38, perCategory: [] } }), {}) === '<span class="mf-chance"><b>62%</b></span>', 'no tie, no tie text');
    const word = buildFacePillHtml(faceModel({ shows: 'word', word: 'favoured' }), {});
    assert(word === '<span class="mf-chance mf-word"><b>favoured</b></span>', 'the word alone');
    assert(!/\d/.test(word), 'the hidden number never prints in a word pill');
    const blank = buildFacePillHtml(faceModel({ odds: null, shows: null, word: null }), {});
    assert(blank.includes('mf-blank') && blank.includes('mf-info'), 'a blank pill with its mark');
    assert(buildFacePillHtml(null, {}) === '' && buildFacePillHtml({ refusal: 'no payload' }, {}) === '', 'nothing for no model or a refusal');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
