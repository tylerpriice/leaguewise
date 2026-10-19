// Unit tests for League History's math (history.js). Open tests/history.test.html through any static server; green means every assertion held. This suite was split out of features.test.js test for test, so that a module with its own suite is one a single hand can hold. Every expected value here is hand-computed from the fixture beside it.
import {
    franchiseKeyOf, seasonFormat, championKeyOf, summarizeSeason, buildFranchises, allTimeRecords,
    headToHead, categoryUnion, careerRate, buildCareers, teamAbbrev, careerValue, sortCareers,
    seasonFinished, categoryRowHeight, CATEGORY_ROW_MIN, CATEGORY_ROW_MAX, CATEGORY_ROWS_BUDGET,
    rivalryDetail, rivalrySplit, isPostseasonGame, recordText, runSpanText, defaultFranchiseIndex,
    coverageSentence, pennantLines, seasonSummary, matchupExtremes, droughtsOf, seasonOrder,
    seasonCategoryLeaders, seasonPointsFacts, rotoSeasonTable
} from '../src/engines/history.js';
// The reader rotoSeasonTable is handed in the app, imported here for the same reason: history.js imports nothing, so the suite is where the two meet.
import { rotoPointsForCategory } from '../src/engines/rank-engine.js';

// The one fetched fixture in this suite. Its expectations are hand-computed in tests/fixtures/season-order.md; the payloads are the field shapes measured on three captures.
const ORDER_FIX = await (await fetch('fixtures/season-order.json')).json();

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg}: got ${a}, expected ${e}`);
}
function assertClose(actual, expected, tol, msg) {
    if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg}: got ${actual}, expected ${expected} +-${tol}`);
}

// Duplicated from features.test.js on purpose, with its own copy of this note. It is the team shape processCoreData builds, which both suites need and neither owns; importing a fixture across two test files would couple suites that are kept separate. weeklyMatchResult carries the 1/0.5/0 result per week for a points league, whose weeklyMatchWins holds raw points.
const T = (id, name, weeklyMatchWins, weeklyCatWins, weeklyCats = {}, weeklyMatchResult = {}, weeklyBye = {}) => ({
    id, name, abbrev: name.slice(0, 4).toUpperCase(),
    seasonCats: {}, weeklyMatchWins, weeklyMatchResult, weeklyCatWins, weeklyCats, weeklyTier: {}, weeklyBye
});

// League History. The fixtures below mirror what was measured in a real three-season league (docs/DATA-SOURCES.md section 9): the same franchise renames itself every year, a team slot changes hands, franchises come and go, and the league switched from roto to head-to-head partway through. Every expected value is hand-computed.

const SWID_A = '{AAAAAAAA-1111}';
const SWID_B = '{BBBBBBBB-2222}';
const SWID_C = '{CCCCCCCC-3333}';
const SWID_D = '{DDDDDDDD-4444}';

// 2024, ROTO. A wins it (rankCalculatedFinal 1). C plays this season only.
const HIST_2024 = {
    seasonId: 2024,
    settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }, { statId: 2 }] } },
    schedule: [],
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'Old Name A', rankCalculatedFinal: 1, record: { overall: {} } },
        { id: 2, primaryOwner: SWID_B, name: 'Old Name B', rankCalculatedFinal: 2, record: { overall: {} } },
        { id: 3, primaryOwner: SWID_C, name: 'One Season C', rankCalculatedFinal: 3, record: { overall: {} } }
    ]
};

// 2025, roto, and a tie at the top: measured ranks are not unique, so no champion is crowned.
const HIST_2025 = {
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }, { statId: 2 }] } },
    schedule: [],
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'Mid Name A', rankCalculatedFinal: 1, record: { overall: {} } },
        { id: 2, primaryOwner: SWID_B, name: 'Mid Name B', rankCalculatedFinal: 1, record: { overall: {} } }
    ]
};

// 2026, HEAD-TO-HEAD. Slot 2 has changed hands: it is D now, not B. B keeps playing in slot 5.
const HIST_2026 = {
    seasonId: 2026,
    settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 2 }, { statId: 9 }] } },
    teams: [
        { id: 1, primaryOwner: SWID_A, name: 'New Name A', rankCalculatedFinal: 2, record: { overall: { wins: 3, losses: 1, ties: 0 } } },
        { id: 2, primaryOwner: SWID_D, name: 'Newcomer D', rankCalculatedFinal: 3, record: { overall: { wins: 1, losses: 3, ties: 0 } } },
        { id: 5, primaryOwner: SWID_B, name: 'New Name B', rankCalculatedFinal: 1, record: { overall: { wins: 2, losses: 1, ties: 1 } } }
    ],
    schedule: [
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 2 } },
        { matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'AWAY', home: { teamId: 2 }, away: { teamId: 5 } },
        { matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'TIE', home: { teamId: 1 }, away: { teamId: 5 } },
        { matchupPeriodId: 3, playoffTierType: 'NONE', winner: 'UNDECIDED', home: { teamId: 1 }, away: { teamId: 2 } },
        { matchupPeriodId: 4, playoffTierType: 'WINNERS_BRACKET', winner: 'HOME', home: { teamId: 1 }, away: { teamId: 5 } },
        { matchupPeriodId: 5, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 1 }, away: { teamId: 5 } }
    ]
};

test('franchiseKeyOf: the SWID, normalized, and teamId only as the fallback', () => {
    assertEq(franchiseKeyOf({ id: 7, primaryOwner: '{abcd-1}' }), 'ABCD-1', 'braces and case normalized');
    assertEq(franchiseKeyOf({ id: 7, owners: ['{abcd-1}'] }), 'ABCD-1', 'falls to owners[0]');
    assertEq(franchiseKeyOf({ id: 7 }), 'team:7', 'no ownership data, so teamId - prefixed');
    assertEq(franchiseKeyOf({}), null, 'nothing to key on at all');
});

test('seasonFormat and championKeyOf: the rule differs per format', () => {
    assertEq(seasonFormat(HIST_2024), 'roto', 'roto season');
    assertEq(seasonFormat(HIST_2026), 'h2h', 'category head-to-head season');
    assertEq(championKeyOf(HIST_2024), 'AAAAAAAA-1111', '2024 roto champion is A');
    assertEq(championKeyOf(HIST_2025), null, 'a tie at the top crowns nobody');
    assertEq(championKeyOf(HIST_2026), 'BBBBBBBB-2222', '2026 champion is the last bracket winner');
});

test('summarizeSeason: a roto season has no W-L-T, and says so with nulls', () => {
    const roto = summarizeSeason(HIST_2024);
    assertEq(roto.countsTowardRecords, false, 'roto keeps no record');
    assertEq(roto.franchises[0].wins, null, 'null, not a fabricated 0');
    const h2h = summarizeSeason(HIST_2026);
    assertEq(h2h.countsTowardRecords, true, 'head-to-head does keep one');
    assertEq(h2h.franchises[0].wins, 3, 'A won 3');
});

// The card's fact values speak in abbreviations, so a franchise has to carry one.
test('teamAbbrev: the abbreviation the league set, or the derived fallback', () => {
    assertEq(teamAbbrev({ abbrev: 'IW', name: 'Ice Wolves' }), 'IW', 'the one the league set wins');
    assertEq(teamAbbrev({ name: 'Rink Rats' }), 'RINK', 'four characters, uppercased, when none is set');
    assertEq(teamAbbrev({ abbrev: '   ', name: 'Rink Rats' }), 'RINK', 'blank counts as none');
    assertEq(teamAbbrev({ location: 'Ice', nickname: 'Wolves' }), 'ICE ', 'built from location and nickname like the name is');
    assertEq(teamAbbrev({ name: 'AB' }), 'AB', 'a short name is not padded');
    assertEq(teamAbbrev(null), '', 'and nothing is nothing');
});

test('buildFranchises: the abbreviation follows the name, latest season wins', () => {
    const list = buildFranchises([HIST_2024, HIST_2026].map(summarizeSeason));
    const a = list.find(f => f.key === 'AAAAAAAA-1111');
    assertEq(a.name, 'New Name A', 'the latest name, as before');
    assertEq(a.abbrev, teamAbbrev({ name: 'New Name A' }), 'and the abbreviation from that same season');
});

test('buildFranchises: most recent name wins, and the old ones are remembered', () => {
    const seasons = [HIST_2026, HIST_2024, HIST_2025].map(summarizeSeason);
    const all = buildFranchises(seasons);
    assertEq(all.length, 4, 'A, B, C and D across the three seasons');
    const a = all.find(f => f.key === 'AAAAAAAA-1111');
    assertEq(a.name, 'New Name A', 'the 2026 name, because it is the most recent');
    assertEq(a.formerNames, ['Old Name A', 'Mid Name A'], 'the earlier names, current one excluded');
    assertEq(a.seasons, [2024, 2025, 2026], 'played all three');
    const c = all.find(f => f.key === 'CCCCCCCC-3333');
    assertEq(c.seasons, [2024], 'C played once and left');
    const d = all.find(f => f.key === 'DDDDDDDD-4444');
    assertEq(d.seasons, [2026], 'D arrived for 2026 and took the slot B used to hold');
});

test('allTimeRecords: only the seasons that keep a record are summed', () => {
    const { rows, countedYears } = allTimeRecords([HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason));
    assertEq(countedYears, [2026], 'the two roto seasons contribute no games');
    const b = rows.find(r => r.key === 'BBBBBBBB-2222');
    assertEq([b.wins, b.losses, b.ties], [2, 1, 1], 'B summed over the one counted season');
    assertEq(b.winPct, 0.625, 'a tie is half a win: (2 + 0.5) / 4');
    assertEq(b.titles, 1, 'B won 2026');
    assertEq(b.seasonsPlayed, 3, 'played all three even though only one counts for record');
    const a = rows.find(r => r.key === 'AAAAAAAA-1111');
    assertEq(a.titles, 1, 'A won the 2024 roto season');
    const c = rows.find(r => r.key === 'CCCCCCCC-3333');
    assertEq(c.winPct, null, 'C only ever played roto, so it has no win percentage at all');
    assertEq(c.recordSeasons, 0, 'and no seasons that keep one');
});

test('headToHead: head-to-head seasons only, byes and undecided games ignored', () => {
    const seasons = [HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason);
    const pairs = headToHead(seasons, { 2024: HIST_2024, 2025: HIST_2025, 2026: HIST_2026 });
    const ab = pairs.find(p => p.a === 'AAAAAAAA-1111' && p.b === 'BBBBBBBB-2222');
    // A and B meet three times in 2026: a tie in the regular season and two WINNERS_BRACKET games. The record is the regular season, so it is the tie alone, and the two bracket games ride alongside it and not inside it. Counting everything gave [1, 1, 1], which disagreed with the standings.
    assertEq([ab.aWins, ab.bWins, ab.ties], [0, 0, 1], 'the tie is the whole regular-season record');
    assertEq(ab.postseason, 2, 'and both bracket games are counted beside it');
    const ad = pairs.find(p => p.a === 'AAAAAAAA-1111' && p.b === 'DDDDDDDD-4444');
    assertEq([ad.aWins, ad.bWins, ad.ties], [1, 0, 0], 'A beat D once');
    assertEq(ad.postseason, 0, 'that pair never met in the postseason');
    assertEq(pairs.length, 3, 'three pairings, and nothing from the roto seasons');
});

test('categoryUnion: every category ever scored, with the seasons it was scored in', () => {
    const u = categoryUnion([HIST_2024, HIST_2025, HIST_2026].map(summarizeSeason));
    assertEq(u.totalSeasons, 3, 'three seasons in the union');
    const stat1 = u.stats.find(s => s.statId === '1');
    const stat2 = u.stats.find(s => s.statId === '2');
    const stat9 = u.stats.find(s => s.statId === '9');
    assertEq(stat2.scoredIn, [2024, 2025, 2026], 'stat 2 survived the format change');
    assertEq(stat1.scoredIn, [2024, 2025], 'stat 1 was dropped for 2026');
    assertEq(stat9.scoredIn, [2026], 'stat 9 is new in 2026');
    assertEq(u.stats[0].statId, '2', 'most-covered category sorts first');
});

test('careerRate: summed components, never averaged season rates', () => {
    const spec = { numerator: ['h'], denominator: ['ab'] };
    assertEq(careerRate({ h: 4 + 18, ab: 10 + 90 }, spec), 0.22, 'weighted by the components, not the seasons');
    assertEq(careerRate({ h: 5 }, spec), null, 'a missing component is null, not a guess');
    assertEq(careerRate({ h: 5, ab: 0 }, spec), null, 'no division by zero');
    assertEq(careerRate({ er: 30, ip: 90 }, { numerator: ['er'], denominator: ['ip'], scale: 9 }), 3,
        'the scale is applied once, after the division');
});

// Careers in this league. The pools below mirror what was measured: a season total sits at statSourceId 0 with statSplitTypeId 0, most of a pool is unrostered, and a player keeps one id while the printed name drifts. Every expected value is hand-computed.

const seasonTotal = (stats) => ({ stats: [{ statSourceId: 0, statSplitTypeId: 0, stats }] });

// 2024 roto: Alpha on team 1, Beta on team 2, and one free agent nobody owned.
const POOL_2024 = { players: [
    { id: 10, onTeamId: 1, player: { fullName: 'Al Alpha', ...seasonTotal({ '1': 40, '0': 100 }) } },
    { id: 20, onTeamId: 2, player: { fullName: 'Bo Beta', ...seasonTotal({ '1': 10, '0': 50 }) } },
    { id: 99, onTeamId: 0, player: { fullName: 'Never Owned', ...seasonTotal({ '1': 99, '0': 99 }) } }
] };
// 2026 head-to-head: Alpha has moved to team 5, and that printed name has changed.
const POOL_2026 = { players: [
    { id: 10, onTeamId: 5, player: { fullName: 'Alan Alpha', ...seasonTotal({ '1': 18, '0': 90 }) } },
    { id: 30, onTeamId: 1, player: { fullName: 'Cy Gamma', ...seasonTotal({ '1': 25, '0': 75 }) } }
] };

// summarizeSeason output is what maps a team slot to a franchise, so the fixtures reuse the real shape rather than a hand-rolled one.
const CAREER_SEASONS = {
    2024: summarizeSeason({
        seasonId: 2024,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 1 }] } },
        schedule: [],
        teams: [
            { id: 1, primaryOwner: SWID_A, name: 'A', rankCalculatedFinal: 1, record: { overall: {} } },
            { id: 2, primaryOwner: SWID_B, name: 'B', rankCalculatedFinal: 2, record: { overall: {} } }
        ]
    }),
    2026: summarizeSeason({
        seasonId: 2026,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 1 }] } },
        schedule: [],
        teams: [
            { id: 1, primaryOwner: SWID_A, name: 'A', rankCalculatedFinal: 1, record: { overall: { wins: 1, losses: 0, ties: 0 } } },
            { id: 5, primaryOwner: SWID_B, name: 'B', rankCalculatedFinal: 2, record: { overall: { wins: 0, losses: 1, ties: 0 } } }
        ]
    })
};

// The franchise a career season belongs to comes from the transaction log, since any stint counts however short. The pool's onTeamId is the roster at the moment of the fetch, so a player dropped before it would belong to nobody and lose the whole year. ownersByYear is { year: Map<playerId, teamId[]> }. franchiseKeyOf strips the braces ESPN wraps a SWID in, so the keys a career row carries are the bare form.
const KEY_A = SWID_A.replace(/[{}]/g, '').toUpperCase();
const KEY_B = SWID_B.replace(/[{}]/g, '').toUpperCase();

const DROPPED_POOL = { players: [
    // Rostered by nobody when the pool was read, but team 1 drafted and held this player that season.
    { id: 40, onTeamId: 0, player: { fullName: 'Drafted Then Dropped', ...seasonTotal({ '1': 7, '0': 30 }) } },
    { id: 20, onTeamId: 2, player: { fullName: 'Bo Beta', ...seasonTotal({ '1': 10, '0': 50 }) } }
] };

test('buildCareers: a player dropped before the fetch still counts, with the franchise', () => {
    const owners = { 2024: new Map([[40, [1]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    const dropped = rows.find(r => r.id === 40);
    assert(!!dropped, 'the player is in the table at all, which the onTeamId gate used to prevent');
    assertEq(dropped.seasons, [2024], 'the season counts');
    assertEq(dropped.totals['1'], 7, 'and so do the numbers for it');
    assertEq(dropped.franchiseKeys, [KEY_A], 'attributed to the franchise that held them');
});

test('buildCareers: without the log, the old onTeamId basis is the fallback', () => {
    // Golden rule 8: an unreadable season degrades to the incomplete answer rather than a blank one.
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS);
    assertEq(rows.some(r => r.id === 40), false, 'the dropped player is missing, as before');
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_B], 'the rostered one is unaffected');
});

test('buildCareers: every franchise that held them that season, in the order they did', () => {
    // Traded mid-season: both franchises count, because any stint counts.
    const owners = { 2024: new Map([[20, [1, 2]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_A, KEY_B],
        'both, first-held first, rather than only the one holding them at the fetch');
});

test('buildCareers: the log wins over onTeamId when they disagree', () => {
    // A player picked up after the last transaction slice would read one team from the snapshot and another from the log. The log is the record of the season, so it decides.
    const owners = { 2024: new Map([[20, [1]]]) };
    const rows = buildCareers({ 2024: DROPPED_POOL }, CAREER_SEASONS, owners);
    assertEq(rows.find(r => r.id === 20).franchiseKeys, [KEY_A], 'the log, not the snapshot');
});

test('buildCareers: components sum across seasons, and only rostered players count', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    assertEq(rows.some(r => r.id === 99), false, 'a player nobody ever rostered is not league history');
    const alpha = rows.find(r => r.id === 10);
    // 40 + 18 hits over 100 + 90 at-bats.
    assertEq(alpha.totals['1'], 58, 'hits summed across both seasons');
    assertEq(alpha.totals['0'], 190, 'at-bats summed across both seasons');
    assertEq(alpha.seasons, [2024, 2026], 'both seasons, in order');
});

test('buildCareers: a roto season counts exactly like a head-to-head one', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    // 2024 was roto and 2026 head-to-head. Components are format-neutral, so both are in the total.
    assertEq(alpha.totals['1'], 40 + 18, 'the roto season is not skipped the way records skip it');
    const beta = rows.find(r => r.id === 20);
    assertEq(beta.seasons, [2024], 'a roto-only player still has a career');
    assertEq(beta.totals['1'], 10, 'and real totals in it');
});

test('buildCareers: a player who changed franchises carries both, newest name wins', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    // Team 1 in 2024 is SWID_A; team 5 in 2026 is SWID_B. Same player, two franchises.
    assertEq(alpha.franchiseKeys, ['AAAAAAAA-1111', 'BBBBBBBB-2222'], 'both franchises, in the order played');
    assertEq(alpha.name, 'Alan Alpha', 'the most recent spelling, since the id is the identity');
});

test('buildCareers: a player present in one season only', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const gamma = rows.find(r => r.id === 30);
    assertEq(gamma.seasons, [2026], 'arrived for the last season');
    assertEq(gamma.totals['1'], 25, 'one season is the whole career');
    assertEq(gamma.franchiseKeys, ['AAAAAAAA-1111'], 'one franchise');
});

test('careerValue: a counting stat sums, a rate is rebuilt from the components', () => {
    const rows = buildCareers({ 2024: POOL_2024, 2026: POOL_2026 }, CAREER_SEASONS);
    const alpha = rows.find(r => r.id === 10);
    const specs = [{ out: '2', num: ['1'], den: ['0'] }];
    assertEq(careerValue(alpha, '1', specs), 58, 'a counting stat is the sum');
    // 58/190 =.30526..., NOT the average of.400 and.200 which would be.300.
    const avg = careerValue(alpha, '2', specs);
    assertEq(Math.round(avg * 100000) / 100000, 0.30526, 'the rate comes from summed components');
    assert(avg !== 0.3, 'and is not the average of the two season averages');
    assertEq(careerValue(alpha, '77', specs), null, 'a stat with no component behind it is null');
});

/**
 * The rivalry card's facts. Two franchises and six meetings, counted by hand from the fixture.
 *
 *   2024 p1   A beat B          2025 p1   A beat B
 *   2024 p2   B beat A          2025 p2   A beat B
 *   2024 p3   tie
 *   2024 p20  A beat B, playoff
 *   2023      roto, so it contributes nothing at all
 *
 * Two bases on one card, which this fixture is built to show:
 *   ratio facts     the record and the season bars count the five regular meetings: A 3, B 1, one
 *                   tie. They have to reconcile with the rivalry row and the standings.
 *   sequence facts  the streak and the longest run count all six, playoff included, because a run
 *                   that survives a playoff loss is not a run.
 * So this fixture prints 3 straight beside a 3-1-1 record, and the playoff-meetings fact is what
 * reconciles them.
 */
const RIV_A = 'KEY-A';
const RIV_B = 'KEY-B';
const rivGame = (period, winner, tier) => ({
    matchupPeriodId: period,
    playoffTierType: tier || 'NONE',
    winner,
    home: { teamId: 1 },
    away: { teamId: 2 }
});
const RIV_SEASONS = [
    { year: 2023, countsTowardRecords: false, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] },
    { year: 2024, countsTowardRecords: true, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] },
    { year: 2025, countsTowardRecords: true, franchises: [{ teamId: 1, key: RIV_A }, { teamId: 2, key: RIV_B }] }
];
const RIV_PAYLOADS = {
    2023: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'HOME')] },
    // Deliberately out of order, since a schedule array's order is not promised to be chronological and every claim below is about order.
    2024: { schedule: [rivGame(20, 'HOME', 'WINNERS_BRACKET'), rivGame(2, 'AWAY'), rivGame(1, 'HOME'), rivGame(3, 'TIE')] },
    2025: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'HOME')] }
};

test('rivalryDetail: the record, per season, from the first franchise point of view', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.meetings.length, 6, 'six counted meetings - the roto season contributes none');
    assertEq(d.total, { w: 3, l: 1, t: 1 }, 'hand-counted over the five regular-season meetings');
    assertEq(d.seasons.map(s => `${s.year} ${s.w}-${s.l}-${s.t}`), ['2024 1-1-1', '2025 2-0-0'],
        'and split by season, oldest first, the playoff game left out of 2024');
});

test('rivalryDetail: meetings are ordered by matchup period, not by array order', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.meetings.map(m => `${m.year}.${m.period}`),
        ['2024.1', '2024.2', '2024.3', '2024.20', '2025.1', '2025.2'],
        '2024 was fed in shuffled and comes back in order');
    assertEq(`${d.last.year}.${d.last.period}`, '2025.2', 'so the last meeting is the real last one');
    assertEq(d.last.result, 'a', 'which the first franchise won');
});

test('rivalryDetail: a tie ends a streak, and the playoff win is inside it (B175)', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    // Backwards over all meetings: 2025 p2 (A), 2025 p1 (A), 2024 p20 (A, playoff), then 2024 p3 is a tie and stops it. Three, hand-counted, where a regular-season-only basis would say two.
    assertEq(d.streak, { side: 'a', count: 3 }, 'three straight, the playoff win among them');
    assertEq(d.longest, {
        side: 'a',
        count: 3,
        meetings: [
            { year: 2024, period: 20, playoff: true },
            { year: 2025, period: 1, playoff: false },
            { year: 2025, period: 2, playoff: false }
        ]
    }, 'and that run is also the longest, carrying every meeting and which kind it was');
    assertEq(runSpanText(d.longest), 'Season 2024 Matchup 20 Playoffs, Season 2025 Matchup 1, and 2',
        'the enumeration marks the playoff coordinate in place');
    // The ratio facts are untouched by any of that: the record is still the regular season.
    assertEq(d.total, { w: 3, l: 1, t: 1 }, 'the record still counts the regular season only');
    assertEq(d.seasons.map(s => `${s.year} ${s.w}-${s.l}-${s.t}`), ['2024 1-1-1', '2025 2-0-0'],
        'and so do the season bars');
});

// The two cases the ruling names, staged rather than reasoned about.
test('rivalryDetail: a playoff WIN extends a run', () => {
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(1, 'HOME'),
        rivGame(2, 'HOME'),
        rivGame(25, 'HOME', 'WINNERS_BRACKET')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.streak, { side: 'a', count: 3 }, 'two regular wins and the playoff win is a run of three');
    assertEq(d.total, { w: 2, l: 0, t: 0 }, 'while the record still shows the two regular wins');
    assertEq(runSpanText(d.longest), 'Season 2025 Matchup 1, 2, and 25 Playoffs', 'the playoff game named as one');
});

test('rivalryDetail: a playoff LOSS breaks a run - the case the owner caught', () => {
    // A wins two, loses the playoff game, wins one more. The old basis skipped the loss entirely and called it a run of three; it is a run of one, and the run of two before it is the longest.
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(1, 'HOME'),
        rivGame(2, 'HOME'),
        rivGame(25, 'AWAY', 'WINNERS_BRACKET'),
        rivGame(26, 'HOME')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.streak, { side: 'a', count: 1 }, 'the current streak is one - the playoff loss stopped it');
    assertEq(d.longest.count, 2, 'and the longest run is the two before that loss, not three');
    assertEq(runSpanText(d.longest), 'Season 2025 Matchup 1 and 2', 'named without the game that ended it');
    assertEq(d.total, { w: 3, l: 0, t: 0 }, 'the record is unmoved - it never counted the playoff loss');
    assertEq(d.playoff, { total: 1, aWins: 0, bWins: 1, ties: 0 }, 'which the playoff fact reports instead');
});

test('rivalryDetail: postseason meetings are counted apart from the rest', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_B);
    assertEq(d.playoff, { total: 1, aWins: 1, bWins: 0, ties: 0 }, 'one, and the first franchise won it');
});

test('rivalryDetail: reversing the pair reverses every answer', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_B, RIV_A);
    assertEq(d.total, { w: 1, l: 3, t: 1 }, 'the same meetings read from the other side');
    assertEq(d.streak, { side: 'b', count: 3 }, 'the streak belongs to the other franchise now');
    assertEq(d.playoff.aWins, 0, 'and so does the playoff win');
});

test('rivalryDetail: two franchises who never met answer with zeroes, not with nulls', () => {
    const d = rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, 'KEY-NOBODY');
    assertEq(d.meetings.length, 0, 'no meetings');
    assertEq(d.total, { w: 0, l: 0, t: 0 }, 'an empty record rather than a missing one');
    assertEq(d.streak, null, 'nothing to have a streak about');
    assertEq(d.last, null, 'and no last meeting');
    assertEq(rivalryDetail(RIV_SEASONS, RIV_PAYLOADS, RIV_A, RIV_A).meetings.length, 0,
        'and nobody is their own rival');
});

test('rivalryDetail: an undecided game is not a meeting yet', () => {
    const payloads = { 2025: { schedule: [rivGame(1, 'HOME'), rivGame(2, 'UNDECIDED')] } };
    const seasons = [RIV_SEASONS[2]];
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.meetings.length, 1, 'the week that has not been played does not count');
    assertEq(d.total, { w: 1, l: 0, t: 0 }, 'and cannot be a loss for anybody');
});

// The record sums the regular season only, as ESPN's own record.overall does. Summing every decided game disagreed with the standings for every team in every league with a postseason tier, and agreed in every league without one. One franchise read 12-10-1 against a standings line of 11-9-1, the difference being its two postseason games.
test('headToHead: the pair record counts the regular season, matching the standings basis', () => {
    const pairs = headToHead(RIV_SEASONS, RIV_PAYLOADS);
    assertEq(pairs.length, 1, 'one pair');
    const p = pairs[0];
    const aFirst = p.a === RIV_A;
    assertEq(aFirst ? p.aWins : p.bWins, 3, 'three regular-season wins, not four');
    assertEq(aFirst ? p.bWins : p.aWins, 1, 'one loss');
    assertEq(p.ties, 1, 'one tie');
    assertEq(p.postseason, 1, 'and the playoff game is carried beside the record, not inside it');
});

test('headToHead: a pair whose only meeting was a playoff game is still a pair', () => {
    // Otherwise the row would read "Never met" about two franchises who met in a final.
    const payloads = { 2025: { schedule: [rivGame(20, 'HOME', 'WINNERS_BRACKET')] } };
    const pairs = headToHead([RIV_SEASONS[2]], payloads);
    assertEq(pairs.length, 1, 'the pair exists');
    assertEq(pairs[0].aWins + pairs[0].bWins + pairs[0].ties, 0, 'with an empty record');
    assertEq(pairs[0].postseason, 1, 'and one postseason meeting to explain it');
});

test('recordText: one W-L-T form, so the same record cannot read as two values', () => {
    assertEq(recordText(54, 9, 0), '54-9', 'a zero tie is dropped');
    assertEq(recordText(33, 27, 3), '33-27-3', 'a real tie is kept');
    assertEq(recordText(0, 0, 0), '0-0', 'and an empty record is still a record');
    assertEq(recordText(null, undefined, NaN), '0-0', 'missing numbers read as none, never as NaN');
});

test('isPostseasonGame: NONE and a missing tier are the regular season, everything else is not', () => {
    assert(!isPostseasonGame({ playoffTierType: 'NONE' }), 'the measured regular-season value');
    assert(!isPostseasonGame({}), 'a game with no tier field at all');
    assert(isPostseasonGame({ playoffTierType: 'WINNERS_BRACKET' }), 'the bracket');
    assert(isPostseasonGame({ playoffTierType: 'WINNERS_CONSOLATION_LADDER' }), 'and both ladders');
    assert(isPostseasonGame({ playoffTierType: 'LOSERS_CONSOLATION_LADDER' }), 'measured in the fixtures');
});

// The pane opens on the reader's own franchise, the way the other tabs do.
test('defaultFranchiseIndex: the SWID wins, whatever order the franchises came in', () => {
    const list = [{ key: 'AAAA-1' }, { key: 'BBBB-2' }, { key: 'CCCC-3' }];
    assertEq(defaultFranchiseIndex(list, '{bbbb-2}'), 1, 'braces and case are normalized on both sides');
    assertEq(defaultFranchiseIndex(list, 'CCCC-3'), 2, 'a bare SWID matches too');
    assertEq(defaultFranchiseIndex(list, 'ZZZZ-9'), 0, 'a league the reader is not in opens on the first');
    assertEq(defaultFranchiseIndex(list, ''), 0, 'and so does a session with no SWID at all');
    assertEq(defaultFranchiseIndex([], 'AAAA-1'), 0, 'an empty league cannot throw');
});

// The sentence, with both year lists computed.
test('coverageSentence: names which seasons the metric applies to, and stays quiet when all of them do (B238 item 6/S127)', () => {
    assertEq(coverageSentence([2026], [2024, 2025, 2026]),
        'Only applicable for head to head seasons (2026).',
        "the owner's template, verbatim, with the counted year filled in");
    assertEq(coverageSentence([2025, 2026], [2024, 2025, 2026]),
        'Only applicable for head to head seasons (2025, 2026).',
        'two or more counted years are a plain comma list, not the prose Oxford-and join');
    assertEq(coverageSentence([2026], [2022, 2023, 2024, 2026]),
        'Only applicable for head to head seasons (2026).',
        'the years left OUT play no part in the sentence any more - only what counts is named');
    assertEq(coverageSentence([2025, 2026], [2025, 2026]), '',
        'nothing to say when every season is head to head');
    assertEq(coverageSentence([], [2024, 2025]), '',
        'and nothing to say when none of them is - the empty-pane note covers that');
});

// The split and the depth are the two sizing rules the pane computes, and both read counts against constants and never measure what was rendered.
test('rivalrySplit: even while the list is short, list-heavy once it is long', () => {
    assertEq(rivalrySplit(5), 0.5, 'a six-team league splits down the middle');
    assertEq(rivalrySplit(8), 0.5, 'and still does at the top of the even band');
    assertEq(rivalrySplit(19), 0.6, 'a twenty-team league gives the list three fifths');
    assertEq(rivalrySplit(12), 0.55, 'and the middle is interpolated, not stepped');
    assert(rivalrySplit(0) === 0.5 && rivalrySplit(-2) === 0.5, 'a nonsense count still splits evenly');
});

// The run says when. The same season collapses the second season name. The meetings are named and not ranged: a range from matchup 10 to 20 would describe eleven matchups when the run was two wins.
const runOf = (...pairs) => ({ meetings: pairs.map(([year, period]) => ({ year, period })) });

test('runSpanText: the run names its meetings, restating the season only when it changes', () => {
    assertEq(runSpanText(runOf([2026, 10])), 'Season 2026 Matchup 10', 'one meeting');
    assertEq(runSpanText(runOf([2026, 10], [2026, 20])), 'Season 2026 Matchup 10 and 20', 'two');
    assertEq(runSpanText(runOf([2026, 10], [2026, 15], [2026, 20])), 'Season 2026 Matchup 10, 15, and 20',
        'three or more take the Oxford comma VOICE.md asks for');
    assertEq(runSpanText(runOf([2023, 20], [2024, 2], [2024, 5])),
        'Season 2023 Matchup 20, Season 2024 Matchup 2, and 5',
        'the season is restated where the year changes, and only there');
    assertEq(runSpanText(runOf([2026, 10], [2026, 20])), 'Season 2026 Matchup 10 and 20',
        'a list of two takes no comma, which is the same rule rather than an exception');
    assertEq(runSpanText(null), '', 'no run, nothing to say');
    assertEq(runSpanText({ count: 3 }), '', 'and a run with no meetings says nothing rather than guessing');
});

test('runSpanText: a playoff meeting is marked where it sits (B175)', () => {
    const withPlayoff = { meetings: [
        { year: 2025, period: 19, playoff: false },
        { year: 2026, period: 2, playoff: true },
        { year: 2026, period: 5, playoff: false }
    ] };
    assertEq(runSpanText(withPlayoff), 'Season 2025 Matchup 19, Season 2026 Matchup 2 Playoffs, and 5',
        'the marker rides without a comma, which inside a list would read as another item');
    assertEq(runSpanText({ meetings: [{ year: 2026, period: 25, playoff: true }] }),
        'Season 2026 Matchup 25 Playoffs', 'a run of one playoff game still says which kind it was');
});

// The last meeting is about recency, so it reads every meeting, playoff games included.
test('rivalryDetail: the last meeting is the last of ANY kind, playoffs included', () => {
    const seasons = [RIV_SEASONS[2]];
    const payloads = { 2025: { schedule: [
        rivGame(2, 'HOME'),
        rivGame(25, 'AWAY', 'WINNERS_BRACKET')
    ] } };
    const d = rivalryDetail(seasons, payloads, RIV_A, RIV_B);
    assertEq(d.last.period, 25, 'the playoff game is the most recent meeting, so it is the last one');
    assert(d.last.playoff === true, 'and it is marked, so the card can say so');
    assertEq(d.total, { w: 1, l: 0, t: 0 }, 'while the RECORD still counts the regular season only');
    assertEq(d.playoff.total, 1, 'with the playoff meeting counted in its own fact');
});

// The row heights are this arithmetic. A table told to be 100% tall hands its surplus to the row boxes, so the rule lives here, where it can be tested, and not in a stylesheet.
test('categoryRowHeight: a budget divided by a count, clamped at both ends', () => {
    assertEq(categoryRowHeight(2), CATEGORY_ROW_MAX, 'two seasons cannot each take 160px - the cap holds');
    assertEq(categoryRowHeight(4), CATEGORY_ROW_MAX, 'and four still ask for more than the cap allows');
    assertEq(categoryRowHeight(10), Math.floor(CATEGORY_ROWS_BUDGET / 10), 'ten fit under it and take their share');
    assertEq(categoryRowHeight(40), CATEGORY_ROW_MIN, 'a long league stops shrinking and scrolls instead');
    assertEq(categoryRowHeight(1), CATEGORY_ROW_MAX, 'one season is a cap case, not a whole-pane row');
});

test('categoryRowHeight: a nonsense count still returns a usable pitch', () => {
    assertEq(categoryRowHeight(0), CATEGORY_ROW_MAX, 'no seasons cannot divide by zero');
    assertEq(categoryRowHeight(-3), CATEGORY_ROW_MAX, 'nor by a negative one');
    assertEq(categoryRowHeight(2.7), CATEGORY_ROW_MAX, 'a fraction floors to a whole count');
});

// A finished league's careers are settled. The pair below is ESPN's own, measured on four real payloads, two roto seasons, a categories season and a points season, where latest was above final on every one and every one was in fact complete.
test('seasonFinished: the scoring-period pair decides, not the year and not isActive', () => {
    assertEq(seasonFinished({ status: { latestScoringPeriod: 193, finalScoringPeriod: 192 } }), true,
        'past the last period is finished');
    assertEq(seasonFinished({ status: { latestScoringPeriod: 192, finalScoringPeriod: 192 } }), true,
        'on the last period is finished');
    assertEq(seasonFinished({ status: { latestScoringPeriod: 120, finalScoringPeriod: 192 } }), false,
        'short of it is still being played');
    // isActive reads true on seasons two years done, so it is not the signal.
    assertEq(seasonFinished({ status: { isActive: true, latestScoringPeriod: 197, finalScoringPeriod: 196 } }), true,
        'isActive does not override the periods');
    // A season nobody can measure says nothing rather than claiming to be live.
    assertEq(seasonFinished({ status: {} }), true, 'no periods means no live claim');
    assertEq(seasonFinished({}), true, 'no status at all, same');
    assertEq(seasonFinished(null), true, 'no payload, same');
});


// Sorting the career table. The rows below are hand-made and not built, so the expected order is readable from the fixture. Ivy has no goalie components at all, which is the blank case.
const SORT_ROWS = [
    { id: 1, name: 'Ann', seasons: [2024, 2025], franchiseKeys: ['A'], totals: { g: 30, sv: 90, sa: 100 } },
    { id: 2, name: 'Bob', seasons: [2025], franchiseKeys: ['B'], totals: { g: 50, sv: 180, sa: 200 } },
    { id: 3, name: 'Cal', seasons: [2024], franchiseKeys: ['A'], totals: { g: 30, sv: 270, sa: 300 } },
    { id: 4, name: 'Ivy', seasons: [2024, 2025, 2026], franchiseKeys: ['C'], totals: { g: 10 } }
];
const SORT_SPECS = [{ out: 'svpct', num: ['sv'], den: ['sa'] }];
const order = (spec) => sortCareers(SORT_ROWS, spec).map(r => r.name);

test('sortCareers: a counting column, both directions, ties by name', () => {
    // g: Bob 50, Ann 30, Cal 30, Ivy 10. Ann before Cal on the tie, both ways.
    assertEq(order({ key: 'g', dir: 'desc' }), ['Bob', 'Ann', 'Cal', 'Ivy'], 'highest first');
    assertEq(order({ key: 'g', dir: 'asc' }), ['Ivy', 'Ann', 'Cal', 'Bob'], 'lowest first, tie still A before C');
});

test('sortCareers: a rate column is derived, and a player with no components sorts last both ways', () => {
    // .900,.900,.900 - so it is the blank that this proves. Ivy has no sv or sa at all.
    assertEq(order({ key: 'svpct', dir: 'desc', rateSpecs: SORT_SPECS }), ['Ann', 'Bob', 'Cal', 'Ivy'],
        'blank last when descending');
    assertEq(order({ key: 'svpct', dir: 'asc', rateSpecs: SORT_SPECS }), ['Ann', 'Bob', 'Cal', 'Ivy'],
        'and still last when ascending, since no save percentage is not the lowest one');
});

test('sortCareers: name and seasons columns', () => {
    assertEq(order({ key: 'name', dir: 'asc' }), ['Ann', 'Bob', 'Cal', 'Ivy'], 'A to Z');
    assertEq(order({ key: 'name', dir: 'desc' }), ['Ivy', 'Cal', 'Bob', 'Ann'], 'Z to A');
    assertEq(order({ key: 'seasons', dir: 'desc' }), ['Ivy', 'Ann', 'Bob', 'Cal'], 'longest tenure first');
});

test('sortCareers: no key leaves the order alone, and never mutates the input', () => {
    const before = SORT_ROWS.map(r => r.name);
    assertEq(order({ key: null, dir: 'desc' }), before, 'unsorted is the order it was given');
    sortCareers(SORT_ROWS, { key: 'g', dir: 'asc' });
    assertEq(SORT_ROWS.map(r => r.name), before, 'the caller keeps its array');
});

// The pennant's two lines. The reference is a ballclub pennant, city over nickname, and a fantasy name has no city, so the last word is the nickname and the rest hangs above it.

test('pennantLines: the last word is the nickname, the rest is the line above', () => {
    const three = pennantLines('Bunt Force Trauma');
    assert(three.top === 'Bunt Force' && three.nick === 'Trauma', 'BUNT FORCE over Trauma');
    const two = pennantLines('Big Inning');
    assert(two.top === 'Big' && two.nick === 'Inning', 'two words split one and one');
});

test('pennantLines: one word is a nickname with nothing above it', () => {
    const one = pennantLines('Sluggers');
    assert(one.nick === 'Sluggers', 'the one word is the nickname, never the top line');
    assert(one.top === '', 'and nothing hangs above it');
});

test('pennantLines: nothing in, nothing out, and stray spacing does not invent a line', () => {
    const none = pennantLines('');
    assert(none.top === '' && none.nick === '', 'empty name');
    const nul = pennantLines(null);
    assert(nul.top === '' && nul.nick === '', 'no name at all');
    const spaced = pennantLines('  Walk   Off   Warriors  ');
    assert(spaced.top === 'Walk Off' && spaced.nick === 'Warriors', 'runs of spaces collapse');
});

// The season at a glance. Every figure below is hand-computed from the payload beside it. The shapes are the real ones: cumulativeScore.wins/losses/ties for a category season, totalPoints for a points season, rankCalculatedFinal for the finish and playoffSeed for the seed.

const O65_TALLY = (s) => (s ? (s.cumulativeScoreLive || s.cumulativeScore || null) : null);
const O65_POINTS = (s) => (s ? (typeof s.totalPointsLive === 'number' ? s.totalPointsLive : s.totalPoints) || 0 : 0);
const O65_READERS = { tallyOf: O65_TALLY, pointsOf: O65_POINTS };

const o65Team = (id, swid, name, over, extra = {}) => ({
    id, abbrev: name.slice(0, 3).toUpperCase(),
    location: name, nickname: '', primaryOwner: swid,
    owners: [swid],
    record: { overall: over },
    ...extra
});
const o65Side = (teamId, wins, losses, ties) => ({ teamId, cumulativeScore: { wins, losses, ties } });
const o65Game = (week, home, away, winner, tier = 'NONE') => ({
    matchupPeriodId: week, playoffTierType: tier, winner, home, away
});

// Four teams, a five-week regular season and a two-round bracket. A wins four straight, loses week five, then wins both playoff rounds.
const O65_H2H = {
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
    status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
    teams: [
        o65Team(1, '{A}', 'Alpha', { wins: 4, losses: 1, ties: 0 }, { rankCalculatedFinal: 1, playoffSeed: 1 }),
        o65Team(2, '{B}', 'Bravo', { wins: 3, losses: 2, ties: 0 }, { rankCalculatedFinal: 2, playoffSeed: 2 }),
        o65Team(3, '{C}', 'Charlie', { wins: 2, losses: 3, ties: 0 }, { rankCalculatedFinal: 3, playoffSeed: 3 }),
        o65Team(4, '{D}', 'Delta', { wins: 1, losses: 4, ties: 0 }, { rankCalculatedFinal: 4, playoffSeed: 4 })
    ],
    schedule: [
        o65Game(1, o65Side(1, 6, 2, 0), o65Side(2, 2, 6, 0), 'HOME'),
        o65Game(2, o65Side(1, 5, 3, 0), o65Side(3, 3, 5, 0), 'HOME'),
        o65Game(3, o65Side(1, 8, 0, 0), o65Side(4, 0, 8, 0), 'HOME'),
        o65Game(4, o65Side(1, 5, 3, 0), o65Side(2, 3, 5, 0), 'HOME'),
        o65Game(5, o65Side(3, 5, 3, 0), o65Side(1, 3, 5, 0), 'HOME'),
        o65Game(6, o65Side(1, 5, 3, 0), o65Side(3, 3, 5, 0), 'HOME', 'WINNERS_BRACKET'),
        o65Game(7, o65Side(1, 4, 4, 0), o65Side(2, 4, 4, 0), 'HOME', 'WINNERS_BRACKET')
    ]
};
const O65_FRANCHISES = [
    { key: 'A', name: 'Alpha' }, { key: 'B', name: 'Bravo' },
    { key: 'C', name: 'Charlie' }, { key: 'D', name: 'Delta' }
];

test('seasonSummary: the champion is Champion wherever the table puts them', () => {
    // The diverging shape: the bracket was won from below, so the champion is row two. Taking the title from position crowned row one as well, two champions on one podium, and crowned row one outright in a season with no champion. Alpha finishes first and Bravo wins the final. rankCalculatedFinal is left to put Alpha on top, which is what a payload does when the regular season and the bracket disagree.
    const lower = {
        seasonId: 2026,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 5, losses: 0, ties: 0 }, { rankCalculatedFinal: 1, playoffSeed: 1 }),
            o65Team(2, '{B}', 'Bravo', { wins: 3, losses: 2, ties: 0 }, { rankCalculatedFinal: 2, playoffSeed: 2 }),
            o65Team(3, '{C}', 'Charlie', { wins: 1, losses: 4, ties: 0 }, { rankCalculatedFinal: 3, playoffSeed: 3 })
        ],
        schedule: [o65Game(6, o65Side(1, 3, 5, 0), o65Side(2, 5, 3, 0), 'AWAY', 'WINNERS_BRACKET')]
    };
    const s = seasonSummary(lower, O65_FRANCHISES, O65_READERS);
    assertEq(s.champion, 'B', 'the bracket, not the table');
    assertEq(s.podium.map(p => `${p.name}:${p.note}`).join(' '), 'Alpha:First Bravo:Champion Charlie:Third',
        'one Champion, and the others read their place in the table');
    assertEq(s.podium.filter(p => p.note === 'Champion').length, 1, 'never two');
});

test('seasonSummary: with the champion at the top the other two are the beaten finalists', () => {
    // "Runner-up" is a claim about the CHAMPION, not about row two: it is only true when row two is the team row one beat, which is exactly the case where the champion is at the top.
    const s = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    assertEq(s.podium.map(p => p.note).join(','), 'Champion,Runner-up,Third', 'unchanged where it was right');
});

test('seasonSummary: no champion named means nobody is crowned', () => {
    // A tie at the top of a roto season, or an undecided bracket. championKeyOf answers null and the podium still renders, reading the table's own places and claiming nothing.
    const tied = {
        seasonId: 2022,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', {}, { rankCalculatedFinal: 1, points: 61 }),
            o65Team(2, '{B}', 'Bravo', {}, { rankCalculatedFinal: 1, points: 61 }),
            o65Team(3, '{C}', 'Charlie', {}, { rankCalculatedFinal: 3, points: 27 })
        ],
        schedule: []
    };
    const s = seasonSummary(tied, O65_FRANCHISES, O65_READERS);
    assertEq(s.champion, null, 'two teams ranked first is no champion');
    assertEq(s.podium.map(p => p.note).join(','), 'First,Second,Third', 'and no crown on anybody');
});

test('seasonSummary: the podium is the season order, and the champion is the bracket', () => {
    const s = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    assertEq([s.year, s.format, s.teams], [2025, 'h2h', 4], 'the season it is');
    assertEq(s.podium.map(p => `${p.note}:${p.name}`).join(' '), 'Champion:Alpha Runner-up:Bravo Third:Charlie', 'three deep');
    assertEq(s.podium[0].record, '4-1', 'with the record beside it');
    assertEq(s.podium[0].seed, 1, 'and the seed');
});

test('seasonSummary: the path is the champion own postseason games, in order', () => {
    const s = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    assertEq(s.path.map(g => `M${g.round} ${g.opponentName} ${g.score} ${g.won}`).join(' | '),
        'M6 Charlie 5-3 true | M7 Bravo 4-4 true', 'two rounds, both won');
});

test('seasonSummary: the superlatives, each hand-computed', () => {
    const s = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    // Alpha's category wins across seven games: 6+5+8+5+3+5+4 = 36, more than anyone.
    assertEq([s.facts.mostCatWins.key, s.facts.mostCatWins.value], ['A', 36], 'the season total');
    assertEq(s.facts.mostCatWins.when, null, 'a season total points at no single week');
    // The best single week is Alpha's 8-0 in week three.
    assertEq([s.facts.bestWeek.key, s.facts.bestWeek.value, s.facts.bestWeek.when], ['A', 8, 'M3'], 'week three');
    // Alpha wins weeks 1-4, loses 5, wins 6 and 7: the longest run is four, not six.
    assertEq([s.facts.longestStreak.key, s.facts.longestStreak.value, s.facts.longestStreak.when],
        ['A', 4, 'M1-M4'], 'a loss breaks the run');
    // Widest margin is 8-0 in week three; narrowest DECIDED is the 4-4 final, a margin of zero.
    assertEq([s.facts.biggestBlowout.value, s.facts.biggestBlowout.when], [8, 'M3'], 'the blowout');
    assertEq([s.facts.closest.value, s.facts.closest.when], [0, 'M7'], 'a decided game can have a zero margin');
});

test('seasonSummary: a tie or an undecided game ends a run of wins', () => {
    // Two teams, by hand. The contract: a tie or an undecided game breaks a run, and a run of one is not reported.
    const season = (games) => ({
        seasonId: 2025,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 2, losses: 0, ties: 1 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 2, ties: 1 })
        ],
        schedule: games
    });
    const win = (week) => o65Game(week, o65Side(1, 5, 3, 0), o65Side(2, 3, 5, 0), 'HOME');
    const level = (week) => o65Game(week, o65Side(1, 4, 4, 0), o65Side(2, 4, 4, 0), 'TIE');
    const open = (week) => o65Game(week, o65Side(1, 2, 1, 0), o65Side(2, 1, 2, 0), 'UNDECIDED');
    const streakOf = (games) => seasonSummary(season(games), O65_FRANCHISES, O65_READERS).facts.longestStreak;

    // Win, tie, win: two runs of one. Neither is reported, so there is no streak at all.
    assertEq(streakOf([win(1), level(2), win(3)]), null, 'a tie between two wins leaves two runs of one');
    // Win, undecided, win: the same two runs of one.
    assertEq(streakOf([win(1), open(2), win(3)]), null, 'an undecided game ends the run too');
    // Win, win, tie, win: the first two are the run, and week four starts another of one.
    const two = streakOf([win(1), win(2), level(3), win(4)]);
    assertEq([two.key, two.value, two.when], ['A', 2, 'M1-M2'], 'the run before the tie stands');
    // Win, tie, win, win: the run starts after the tie.
    const late = streakOf([win(1), level(2), win(3), win(4)]);
    assertEq([late.key, late.value, late.when], ['A', 2, 'M3-M4'], 'and a run after it starts fresh');
});

test('seasonSummary: standings carry the finish, the record and the season category wins', () => {
    const s = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    assertEq(s.standings.map(r => `${r.finish}.${r.name} ${r.record} cw${r.catWins}`).join(' | '),
        '1.Alpha 4-1 cw36 | 2.Bravo 3-2 cw9 | 3.Charlie 2-3 cw11 | 4.Delta 1-4 cw0', 'ordered by finish');
});

test('seasonSummary: a ROTO season answers less, and says so with nulls', () => {
    // No schedule at all, so nothing built on matchups can be answered. The podium is the points table, which is the standing a roto season is actually decided by.
    const roto = {
        seasonId: 2024,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', {}, { rankCalculatedFinal: 2, points: 40 }),
            o65Team(2, '{B}', 'Bravo', {}, { rankCalculatedFinal: 1, points: 61 }),
            o65Team(3, '{C}', 'Charlie', {}, { rankCalculatedFinal: 3, points: 27 })
        ],
        schedule: []
    };
    const s = seasonSummary(roto, O65_FRANCHISES, O65_READERS);
    assertEq(s.format, 'roto', 'read off the payload');
    assertEq(s.champion, 'B', 'rankCalculatedFinal of one');
    assertEq(s.podium.map(p => p.name).join(','), 'Bravo,Alpha,Charlie', 'ordered by POINTS, not by rank');
    assertEq(s.podium[0].record, null, 'a roto season has no W-L-T to show');
    assertEq(s.path, null, 'and no bracket to walk');
    assertEq([s.facts.bestWeek, s.facts.longestStreak, s.facts.biggestBlowout, s.facts.closest].join(','),
        ',,,', 'every fact that needs weeks is null');
});

test('seasonSummary: a POINTS season has no category wins to report', () => {
    const pts = {
        seasonId: 2023,
        settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 1, losses: 0, ties: 0 }, { rankCalculatedFinal: 1 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 1, ties: 0 }, { rankCalculatedFinal: 2 })
        ],
        schedule: [o65Game(1, { teamId: 1, totalPoints: 120.5 }, { teamId: 2, totalPoints: 99.5 }, 'HOME')]
    };
    const s = seasonSummary(pts, O65_FRANCHISES, O65_READERS);
    assertEq(s.facts.mostCatWins, null, 'a points league counts no categories');
    assertEq(s.standings[0].catWins, null, 'nor in the standings');
    assertEq([s.facts.bestWeek.key, s.facts.bestWeek.value], ['A', 120.5], 'the best week is the points');
    assertClose(s.facts.biggestBlowout.value, 21, 1e-9, 'and the margin is in points');
});

// A drafted season nobody has played: every matchup on the schedule, none decided. A hockey league read a best week of 0 points off exactly this shape.
test('seasonSummary: an UNPLAYED points season has no best week', () => {
    const unplayed = {
        seasonId: 2027,
        settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 1, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 0, losses: 0, ties: 0 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 0, ties: 0 })
        ],
        schedule: [
            o65Game(1, { teamId: 1, totalPoints: 0 }, { teamId: 2, totalPoints: 0 }, 'UNDECIDED'),
            o65Game(2, { teamId: 2, totalPoints: 0 }, { teamId: 1, totalPoints: 0 }, 'UNDECIDED')
        ]
    };
    const f = seasonSummary(unplayed, O65_FRANCHISES, O65_READERS).facts;
    assertEq(f.bestWeek, null, 'no week has been played, so none is the best - never team A at 0');
    assertEq([f.mostCatWins, f.longestStreak, f.biggestBlowout, f.closest, f.ties].join(','), ',,,,',
        'and every other fact is null with it');
});

test('seasonSummary: an UNPLAYED category season has no most category wins either', () => {
    const unplayed = {
        seasonId: 2027,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 1, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 0, losses: 0, ties: 0 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 0, ties: 0 })
        ],
        schedule: [o65Game(1, o65Side(1, 0, 0, 0), o65Side(2, 0, 0, 0), 'UNDECIDED')]
    };
    const f = seasonSummary(unplayed, O65_FRANCHISES, O65_READERS).facts;
    assertEq([f.mostCatWins, f.bestWeek].join(','), ',', 'a maximum over zeros is not a leader');
});

// An unplayed season has no order. Three teams, one matchup scheduled and not decided; ids and names chosen so the payload's own order (3, 1, 2) is not the id order.
test('seasonSummary: an UNPLAYED season has no podium, no places and no basis', () => {
    const unplayed = (scoringType, home, away) => ({
        seasonId: 2027,
        settings: { scoringSettings: { scoringType, scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 1, finalScoringPeriod: 30 },
        teams: [
            o65Team(3, '{C}', 'Charlie', { wins: 0, losses: 0, ties: 0 }),
            o65Team(1, '{A}', 'Alpha', { wins: 0, losses: 0, ties: 0 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 0, ties: 0 })
        ],
        schedule: [o65Game(1, home, away, 'UNDECIDED')]
    });
    const cats = seasonSummary(unplayed('H2H_MOST_CATEGORIES', o65Side(1, 0, 0, 0), o65Side(2, 0, 0, 0)), O65_FRANCHISES, O65_READERS);
    assertEq(cats.podium.length, 0, 'no podium: nobody has finished anywhere');
    assertEq(cats.standingsBasis, null, 'nothing ordered them');
    assertEq(cats.standings.map(r => r.place).join(','), ',,', 'no place for any team');
    assertEq(cats.standings.map(r => r.catWins).join(','), ',,', 'category wins are null, not 0');
    assertEq(cats.standings.map(r => r.name).join(','), 'Charlie,Alpha,Bravo', 'the rows stay, in the payload order');
    assertEq(cats.standings.map(r => r.record).join(','), '0-0,0-0,0-0', 'the record is a true figure and stays');
    assertEq(cats.standings.map(r => r.wins).join(','), '0,0,0', 'and so are the wins');
    assertEq(cats.champion, null, 'no champion');

    const pts = seasonSummary(unplayed('H2H_POINTS', { teamId: 1, totalPoints: 0 }, { teamId: 2, totalPoints: 0 }), O65_FRANCHISES, O65_READERS);
    assertEq([pts.podium.length, pts.standingsBasis, pts.standings.map(r => r.place).join(',')].join('|'), '0||,,', 'a points season the same');
});

test('seasonSummary: one decided matchup is an order, and a roto season always has one', () => {
    const played = {
        seasonId: 2027,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 8, finalScoringPeriod: 30 },
        teams: [
            o65Team(3, '{C}', 'Charlie', { wins: 0, losses: 0, ties: 0 }),
            o65Team(1, '{A}', 'Alpha', { wins: 0, losses: 1, ties: 0 }),
            o65Team(2, '{B}', 'Bravo', { wins: 1, losses: 0, ties: 0 })
        ],
        schedule: [o65Game(1, o65Side(1, 2, 5, 0), o65Side(2, 5, 2, 0), 'AWAY')]
    };
    const s = seasonSummary(played, O65_FRANCHISES, O65_READERS);
    assertEq(s.standingsBasis, 'record', 'ordered by the record');
    assertEq(s.podium.length, 3, 'and a podium of three');
    assertEq(s.standings[0].name + ':' + s.standings[0].place, 'Bravo:1', 'the 1-0 team first');
    assertEq(s.standings.find(r => r.name === 'Bravo').catWins, 5, 'category wins read again');
    // A ROTO season has no matchups at all and is not "unplayed" for it.
    const roto = {
        seasonId: 2025,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', {}, { rankCalculatedFinal: 2, points: 40 }),
            o65Team(2, '{B}', 'Bravo', {}, { rankCalculatedFinal: 1, points: 61 })
        ],
        schedule: []
    };
    const r = seasonSummary(roto, O65_FRANCHISES, O65_READERS);
    assertEq([r.podium.length, r.standingsBasis, r.standings[0].place].join(','), '2,points,1', 'a roto season keeps its order');
});

test('seasonSummary: final ranks are ESPN\'s word that a season was decided, whatever its schedule shows', () => {
    const ranked = {
        seasonId: 2024,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 30, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 4, losses: 6, ties: 0 }, { rankCalculatedFinal: 2 }),
            o65Team(2, '{B}', 'Bravo', { wins: 6, losses: 4, ties: 0 }, { rankCalculatedFinal: 1 })
        ],
        schedule: []
    };
    const s = seasonSummary(ranked, O65_FRANCHISES, O65_READERS);
    assertEq([s.standingsBasis, s.podium.length, s.standings[0].name, s.standings[0].place].join(','), 'finish,2,Bravo,1',
        'a payload with no schedule and final ranks is not an unplayed season');
});

test('seasonSummary: a first matchup in progress has figures and still no best, until one is decided', () => {
    const season = (winner) => ({
        seasonId: 2027,
        settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 5 }] } },
        status: { latestScoringPeriod: 3, finalScoringPeriod: 30 },
        teams: [
            o65Team(1, '{A}', 'Alpha', { wins: 0, losses: 0, ties: 0 }),
            o65Team(2, '{B}', 'Bravo', { wins: 0, losses: 0, ties: 0 })
        ],
        schedule: [
            o65Game(1, { teamId: 1, totalPoints: 41.5 }, { teamId: 2, totalPoints: 30 }, winner),
            o65Game(2, { teamId: 2, totalPoints: 0 }, { teamId: 1, totalPoints: 0 }, 'UNDECIDED')
        ]
    });
    assertEq(seasonSummary(season('UNDECIDED'), O65_FRANCHISES, O65_READERS).facts.bestWeek, null,
        'Alpha leads 41.5 to 30 and the matchup is not over');
    const decided = seasonSummary(season('HOME'), O65_FRANCHISES, O65_READERS).facts.bestWeek;
    assertEq([decided.key, decided.value, decided.when].join(','), 'A,41.5,M1', 'decided, it is the best week');
    const tied = seasonSummary(season('TIE'), O65_FRANCHISES, O65_READERS).facts.bestWeek;
    assertEq([tied.key, tied.value].join(','), 'A,41.5', 'a tie is a decided matchup too');
});

test('matchupExtremes: the rule recap.js has always used, now in one place', () => {
    // A one-game set has no meaningful closest distinct from its biggest, and neither does a set where the same game is both. An undecided game is in none of the three; a tied one is in ties, which the tests below cover.
    const one = [{ margin: 5, decided: true, tie: false }];
    assertEq(matchupExtremes(one).blowout.margin, 5, 'the only game is the blowout');
    assertEq(matchupExtremes(one).closest, null, 'and there is no closest');
    const none = [{ margin: 9, decided: false, tie: false }, { margin: 0, decided: true, tie: true }];
    assertEq([matchupExtremes(none).blowout, matchupExtremes(none).closest].join(','), ',', 'nothing decided');
    const three = [
        { margin: 1, decided: true, tie: false },
        { margin: 9, decided: true, tie: false },
        { margin: 4, decided: true, tie: false }
    ];
    assertEq([matchupExtremes(three).blowout.margin, matchupExtremes(three).closest.margin], [9, 1], 'widest and narrowest');
});

test('seasonSummary: a payload with no teams is refused rather than half-answered', () => {
    assertEq(seasonSummary({ teams: [] }, O65_FRANCHISES, O65_READERS), null, 'nothing to summarize');
    assertEq(seasonSummary(null, O65_FRANCHISES, O65_READERS), null, 'nor here');
});

// Championship droughts. The rule cases use hand-built season summaries, the shape summarizeSeason returns cut to the three fields droughtsOf reads, so each case isolates one rule; the last case runs the three-season league above through summarizeSeason end to end.

const DS = (year, championKey, keys, finished = true) =>
    ({ year, finished, championKey, franchises: keys.map(key => ({ key })) });
const dryRow = (rows, key) => rows.find(r => r.franchiseKey === key);

test('droughtsOf: titles counted, the last one dated, the reigning champion at zero', () => {
    const rows = droughtsOf([
        DS(2021, 'A', ['A', 'B']), DS(2022, 'B', ['A', 'B']), DS(2023, 'A', ['A', 'B']), DS(2024, 'B', ['A', 'B'])
    ]);
    // A won 2021 and 2023, then played 2024 without winning: two titles, last 2023, one since.
    assertEq(dryRow(rows, 'A'), { franchiseKey: 'A', titles: 2, lastTitleYear: 2023, seasonsSince: 1 }, 'A');
    // B won 2022 and 2024, the newest season: zero since.
    assertEq(dryRow(rows, 'B'), { franchiseKey: 'B', titles: 2, lastTitleYear: 2024, seasonsSince: 0 }, 'B');
});

test('droughtsOf: a franchise that never won reads null, with the seasons it has played', () => {
    const rows = droughtsOf([DS(2022, 'A', ['A', 'C']), DS(2023, 'A', ['A', 'C']), DS(2024, 'A', ['A', 'C'])]);
    assertEq(dryRow(rows, 'C'), { franchiseKey: 'C', titles: 0, lastTitleYear: null, seasonsSince: 3 }, 'three seasons, no title');
});

test('droughtsOf: an unfinished season counts for nothing - not a dry year, not a title', () => {
    // 2025 is live: B's lead there is not a title, and A still playing it has not failed to win it.
    const rows = droughtsOf([DS(2024, 'A', ['A', 'B']), DS(2025, 'B', ['A', 'B', 'E'], false)]);
    assertEq(dryRow(rows, 'A'), { franchiseKey: 'A', titles: 1, lastTitleYear: 2024, seasonsSince: 0 }, 'A still reigns');
    assertEq(dryRow(rows, 'B'), { franchiseKey: 'B', titles: 0, lastTitleYear: null, seasonsSince: 1 }, 'B: 2024 only');
    // E has played nothing finished: listed, and every figure is the empty one.
    assertEq(dryRow(rows, 'E'), { franchiseKey: 'E', titles: 0, lastTitleYear: null, seasonsSince: 0 }, 'E: nothing yet');
});

test('droughtsOf: a finished season with no champion counts for nothing either', () => {
    // 2024 ended in a tie at the top (championKey null): nobody is told they did not win it.
    const rows = droughtsOf([DS(2023, 'A', ['A', 'B']), DS(2024, null, ['A', 'B']), DS(2025, 'B', ['A', 'B'])]);
    assertEq(dryRow(rows, 'A'), { franchiseKey: 'A', titles: 1, lastTitleYear: 2023, seasonsSince: 1 }, 'A: 2025 only, not 2024');
    assertEq(dryRow(rows, 'B'), { franchiseKey: 'B', titles: 1, lastTitleYear: 2025, seasonsSince: 0 }, 'B');
});

test('droughtsOf: a season the franchise sat out is not a season it failed to win', () => {
    // A won 2022, sat out 2023, came back for 2024 and 2025: two seasons since, not three.
    const rows = droughtsOf([
        DS(2022, 'A', ['A', 'B']), DS(2023, 'B', ['B', 'C']), DS(2024, 'B', ['A', 'B']), DS(2025, 'C', ['A', 'C'])
    ]);
    assertEq(dryRow(rows, 'A').seasonsSince, 2, 'A: 2024 and 2025');
    assertEq(dryRow(rows, 'C'), { franchiseKey: 'C', titles: 1, lastTitleYear: 2025, seasonsSince: 0 }, 'C');
});

test('droughtsOf: seasons in any order, first-seen rows, a franchise with no key skipped', () => {
    const rows = droughtsOf([DS(2025, 'B', ['B', 'A']), null, DS(2024, 'A', ['A', null, 'B'])]);
    assertEq(rows.map(r => r.franchiseKey), ['A', 'B'], '2024 is read first, whatever the input order');
    assertEq(dryRow(rows, 'A'), { franchiseKey: 'A', titles: 1, lastTitleYear: 2024, seasonsSince: 1 }, 'A');
    assertEq(droughtsOf([]), [], 'no seasons, no rows');
});

test('droughtsOf: the three-season league above, through summarizeSeason', () => {
    // 2024 roto, A crowned; 2025 roto tied at 1, no champion; 2026 head-to-head, B crowned in slot 5. None carries a status, so seasonFinished's settled fallback calls all three finished.
    const rows = droughtsOf([HIST_2026, HIST_2024, HIST_2025].map(summarizeSeason));
    assertEq(rows, [
        { franchiseKey: 'AAAAAAAA-1111', titles: 1, lastTitleYear: 2024, seasonsSince: 1 },
        { franchiseKey: 'BBBBBBBB-2222', titles: 1, lastTitleYear: 2026, seasonsSince: 0 },
        { franchiseKey: 'CCCCCCCC-3333', titles: 0, lastTitleYear: null, seasonsSince: 1 },
        { franchiseKey: 'DDDDDDDD-4444', titles: 0, lastTitleYear: null, seasonsSince: 1 }
    ], 'A dry through 2026 only, the tied 2025 uncounted; D took slot 2 and is keyed by its owner');
});

// ==== A tie is the closest matchup ====

const TIE_FIX = await (await fetch('fixtures/matchup-extremes.json')).json();
const tieLine = (ties) => `${ties.length} tie${ties.length === 1 ? '' : 's'}: `
    + ties.map(r => `${r.home.name} v ${r.away.name} (matchup ${r.week})`).join(', ');

test('matchupExtremes: with no tie in the set, nothing changed', () => {
    const c = TIE_FIX.noTies;
    const got = matchupExtremes(c.rows);
    assertEq(got.blowout.week, c.expect.blowoutWeek, 'the widest');
    assertEq(got.closest.week, c.expect.closestWeek, 'the narrowest');
    assertEq(got.closest.margin, c.expect.closestMargin, 'and its margin');
    assertEq(got.ties, [], 'an empty array, never null, so a caller reads length without asking');
});

test('matchupExtremes: one tie takes the closest line - the owner\'s case', () => {
    const c = TIE_FIX.oneTie;
    const got = matchupExtremes(c.rows);
    // The margin-1 game at M2 is still in this set. Reporting it as the closest matchup of a season that contained a tie was the fault this guards against.
    assertEq(got.closest, null, 'the margin-1 game is not the closest thing that happened');
    assertEq(got.ties.map(r => r.week), c.expect.tieWeeks, 'the tie is');
    assertEq(got.blowout.week, c.expect.blowoutWeek, 'the blowout is untouched');
    assertEq(tieLine(got.ties), c.expect.seasonLine, 'how many and who, which is what was asked for');
});

test('matchupExtremes: four ties, in schedule order, one of them in the narrowest game\'s week', () => {
    const c = TIE_FIX.fourTies;
    const got = matchupExtremes(c.rows);
    assertEq(got.ties.map(r => r.week), c.expect.tieWeeks, 'all four, in the order they were played');
    // The sharp case from the hockey capture: the margin-1 game is itself in week 1, and week 1 contains a tie, so "closest: margin 1 at M1" was wrong about its own week.
    assertEq(got.closest, null, 'no closest game left to name');
    assertEq(got.blowout.margin, c.expect.blowoutMargin, 'the widest still reads');
    assertEq(tieLine(got.ties), c.expect.seasonLine, 'the line');
});

test('matchupExtremes: a set of nothing but ties has no widest either', () => {
    const c = TIE_FIX.onlyTies;
    const got = matchupExtremes(c.rows);
    assertEq(got.ties.map(r => r.week), c.expect.tieWeeks, 'both ties');
    // Null rather than a 0-margin row: a set with no won game in it had no rout.
    assertEq([got.blowout, got.closest], [null, null], 'no game was widest');
});

test('matchupExtremes: an undecided row is not a tie however it is flagged', () => {
    const got = matchupExtremes(TIE_FIX.undecidedTie.rows);
    assertEq(got.ties, [], 'a matchup still being played has not finished level');
    assertEq([got.blowout, got.closest], [null, null], 'and it is in neither of the others');
});

test('matchupExtremes: the one-row and same-game rules survive the change', () => {
    const one = matchupExtremes(TIE_FIX.oneGame.rows);
    assertEq([one.blowout.week, one.closest, one.ties.length], [4, null, 0], 'one game is only the widest');
    const both = matchupExtremes(TIE_FIX.sameGameBoth.rows);
    assertEq([both.blowout.week, both.closest, both.ties.length], [2, null, 0], 'the same game is not reported twice');
});

test('matchupExtremes: an empty set and a null one answer the same way', () => {
    assertEq(matchupExtremes([]), { blowout: null, closest: null, ties: [] }, 'nothing');
    assertEq(matchupExtremes(null), { blowout: null, closest: null, ties: [] }, 'nothing at all');
});

test('seasonSummary: facts.ties carries how many and who, and nulls the closest with it', () => {
    // A season built from the tie fixture's own shape, so the card's facts are checked against the same hand-computed expectations the reduction is.
    const payload = {
        seasonId: 2026,
        settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [{ statId: 13 }] } },
        teams: [
            { id: 1, name: 'Alphas', playoffSeed: 1, rankCalculatedFinal: 0, points: 0, owners: ['{A}'], record: { overall: { wins: 2, losses: 0, ties: 1 } } },
            { id: 2, name: 'Bravos', playoffSeed: 2, rankCalculatedFinal: 0, points: 0, owners: ['{B}'], record: { overall: { wins: 0, losses: 2, ties: 1 } } }
        ],
        schedule: [
            { matchupPeriodId: 2, winner: 'HOME', playoffTierType: 'NONE', home: { teamId: 1 }, away: { teamId: 2 } },
            { matchupPeriodId: 9, winner: 'TIE', playoffTierType: 'NONE', home: { teamId: 1 }, away: { teamId: 2 } },
            { matchupPeriodId: 14, winner: 'HOME', playoffTierType: 'NONE', home: { teamId: 1 }, away: { teamId: 2 } }
        ]
    };
    const readers = { tallyOf: (s) => (s.teamId === 1 ? { wins: 5, losses: 1, ties: 0 } : { wins: 1, losses: 5, ties: 0 }), pointsOf: () => 0 };
    const s = seasonSummary(payload, [], readers);
    assertEq(s.facts.ties.count, 1, 'one tie');
    // franchiseKeyOf strips the braces off a SWID, which is why the keys read A and B rather than the {A} and {B} the payload carries.
    assertEq(s.facts.ties.games, [{ keys: ['A', 'B'], when: 'M9' }], 'home first, and the matchup with it');
    // Both surfaces get the same answer because there is one reduction: the closest line has nothing left to say on a season whose closest game was level.
    assertEq(s.facts.closest, null, 'no closest beside the ties');
    assertEq(s.facts.biggestBlowout.when, 'M2', 'the blowout still reads');
});

test('seasonSummary: a season with no tie reports the closest and no ties at all', () => {
    const payload = {
        seasonId: 2026,
        settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 0 }] } },
        teams: [
            { id: 1, name: 'Alphas', playoffSeed: 1, rankCalculatedFinal: 0, points: 10, owners: ['{A}'], record: { overall: { wins: 1, losses: 1, ties: 0 } } },
            { id: 2, name: 'Bravos', playoffSeed: 2, rankCalculatedFinal: 0, points: 10, owners: ['{B}'], record: { overall: { wins: 1, losses: 1, ties: 0 } } }
        ],
        schedule: [
            { matchupPeriodId: 3, winner: 'HOME', playoffTierType: 'NONE', home: { teamId: 1, totalPoints: 100 }, away: { teamId: 2, totalPoints: 99 } },
            { matchupPeriodId: 5, winner: 'AWAY', playoffTierType: 'NONE', home: { teamId: 1, totalPoints: 80 }, away: { teamId: 2, totalPoints: 120 } }
        ]
    };
    const s = seasonSummary(payload, [], { tallyOf: () => null, pointsOf: (side) => side.totalPoints });
    assertEq(s.facts.ties, null, 'null, not a shape of zeros, so the face shows the closest instead');
    assertEq(s.facts.closest.when, 'M3', 'the one-point game');
    assertEq(s.facts.biggestBlowout.when, 'M5', 'and the forty-point one');
    assert(s.facts.biggestBlowout.against && s.facts.biggestBlowout.against !== s.facts.biggestBlowout.key, 'the blowout names the side it was over');
    assert(s.facts.closest.against && s.facts.closest.against !== s.facts.closest.key, 'the closest game names the other side');
});

// ==== The order a season's teams are in ====

test('seasonOrder: the owner\'s case - 11-9-1 stands above 11-10-0, because a tie is half a win', () => {
    const c = ORDER_FIX.unfinishedCategories;
    const got = seasonOrder(c);
    assertEq(got.basis, c.expect.basis, 'no final rank filed, so the records decide');
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'the order');
    // The bug this replaces: the 11-10-0 team is FIRST in the payload and has the same eleven wins, so a sort on raw wins left it where it lay and the half-win went unread.
    assertEq([got.rows[0].teamId, got.rows[1].teamId], [8, 1], 'Alphas at 11-9-1 over Bravos at 11-10-0');
    c.teams.forEach(t => assertEq(got.rows.find(r => r.teamId === t.id).place,
        c.expect.places[String(t.id)], `place of team ${t.id}`));
    c.teams.forEach(t => assertEq(got.rows.find(r => r.teamId === t.id).percentage,
        c.expect.percentages[String(t.id)], `percentage of team ${t.id}`));
});

test('seasonOrder: the order agrees with ESPN\'s own seed, which it never read', () => {
    // The seed is carried in the fixture and is not an input to the chain until teams are level, so this is a check against ESPN rather than a restatement of the code.
    const got = seasonOrder(ORDER_FIX.unfinishedCategories);
    assertEq(got.rows.map(r => r.seed), [1, 2, 3, 4], 'the standing and the seed agree end to end');
});

test('seasonOrder: points break a level pair, and the rate beats the raw count', () => {
    const c = ORDER_FIX.unfinishedPoints;
    const got = seasonOrder(c);
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'the order');
    // Two things: pointsFor separates the two 8-5 teams, and 5-7 outranks 5-8 on the rate even though the 5-8 team scored more. Step 2 is only ever reached by teams level on step 1.
    assertEq([got.rows[0].teamId, got.rows[1].teamId], [2, 4], 'Echoes over Foxes on points');
    assertEq([got.rows[2].teamId, got.rows[3].teamId], [6, 7], 'Golfs at 5-7 over Hotels at 5-8');
});

test('seasonOrder: a finished season keeps its bracket order, however odd the records look', () => {
    const c = ORDER_FIX.finished;
    const got = seasonOrder(c);
    assertEq(got.basis, 'finish', 'every rank filed');
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'the order');
    // The point of this case: the worst record in the league finished fourth and the second best finished fifth. A bracket is not a table, and an order that "fixed" this would tell the reader their champion came second.
    assertEq(got.rows.find(r => r.teamId === 7).place, 4, 'November, 4-16-1, fourth');
    assertEq(got.rows.find(r => r.teamId === 5).place, 5, 'Limas, 13-6-2, fifth');
});

test('seasonOrder: one rank filed is not a finished season', () => {
    const c = ORDER_FIX.partlyFinished;
    const got = seasonOrder(c);
    assertEq(got.basis, 'record', 'a rank cannot order the teams it was not filed for');
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'by the records instead');
});

test('seasonOrder: a roto season is decided by its own points', () => {
    const c = ORDER_FIX.roto;
    const got = seasonOrder(c);
    assertEq(got.basis, 'points', 'roto');
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'the order');
    assertEq(got.rows.map(r => r.points).reduce((a, b) => a + b, 0), 96,
        'sixteen categories times 1+2+3, the check a roto total has to pass');
});

test('seasonOrder: a missing percentage is computed, and an unplayed team sorts last on a null', () => {
    const c = ORDER_FIX.missingPercentage;
    const got = seasonOrder(c);
    assertEq(got.rows.map(r => r.teamId), c.expect.order, 'the order');
    c.teams.forEach(t => assertEq(got.rows.find(r => r.teamId === t.id).percentage,
        c.expect.percentages[String(t.id)], `percentage of team ${t.id}`));
    // Null and not 0: a team that has not played has not lost either, and a zero would seat it among the teams that have.
    assertEq(got.rows[2].percentage, null, 'Uniforms has no percentage at all');
});

test('seasonOrder: an empty season is an empty order and a malformed one is null', () => {
    assertEq(seasonOrder(ORDER_FIX.empty), { basis: 'record', rows: [] }, 'nobody in the league');
    assertEq(seasonOrder(null), null, 'no season here');
    assertEq(seasonOrder({}), null, 'no teams array');
    assertEq(seasonOrder({ teams: 'nope' }), null, 'not an array');
});

test('seasonSummary: the standings and the podium read seasonOrder, not a sort of their own', () => {
    const c = ORDER_FIX.unfinishedCategories;
    const s = seasonSummary(c, [], {});
    // No schedule rows in this payload and records of 11-9-1: played, by the record.
    assertEq(s.standingsBasis, 'record', 'the basis is carried out');
    assertEq(s.standings.map(r => r.name), ['Alphas', 'Bravos', 'Charlies', 'Deltas'], 'the table');
    assertEq(s.standings.map(r => r.place), [1, 2, 3, 4], 'each row knows its place');
    // Ordered wrongly, the 11-10 team reads First and the 11-9-1 team Second, which is the podium reading the first rows of the table. The two cannot diverge: it is one order.
    assertEq(s.podium.map(p => `${p.name}:${p.note}`), ['Alphas:First', 'Bravos:Second', 'Charlies:Third'],
        'the 11-9-1 team is First');
    assertEq(s.standings.map(r => r.record), ['11-9-1', '11-10', '10-10-1', '9-12'], 'the records beside it');
});

// The season box per format. Contract: tests/fixtures/season-facts.md. Every figure is hand-computed from the payload beside it; the shapes are the measured ones (valuesByStat and pointsByStat on a team, isReverseItem on a scoring item, totalPoints on a schedule side, pointsFor and pointsAgainst in record.overall).

const b293Team = (id, swid, extra = {}) => ({ id, primaryOwner: swid, owners: [swid], location: `T${id}`, nickname: '', ...extra });

// Three teams. HR (5): 30, 30, 12 - two level at the top. ERA (47, lower wins): 3.5, 3.1, 4.0. Runs (20): 100, 90 and one team with no figure filed.
const B293_CATS = {
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [
        { statId: 5 }, { statId: 47, isReverseItem: true }, { statId: 20 }] } },
    teams: [
        b293Team(1, '{A}', { valuesByStat: { 5: 30, 47: 3.5, 20: 100 } }),
        b293Team(2, '{B}', { valuesByStat: { 5: 30, 47: 3.1, 20: 90 } }),
        b293Team(3, '{C}', { valuesByStat: { 5: 12, 47: 4.0 } })
    ]
};

test('seasonCategoryLeaders: the leader per category, a lower-is-better one flipped', () => {
    const l = seasonCategoryLeaders(B293_CATS);
    assertEq(l.categories.map(c => `${c.statId}:${c.value}:${c.leaders.map(x => x.key).join('+')}`),
        ['5:30:A+B', '47:3.1:B', '20:100:A'], 'HR shared at 30, ERA to the LOWEST, runs to the highest');
    assertEq(l.categories.map(c => c.inverse), [false, true, false], 'the flag is carried out');
});

test('seasonCategoryLeaders: a shared lead is counted apart from one held alone', () => {
    const l = seasonCategoryLeaders(B293_CATS);
    // A leads runs alone and shares HR; B leads ERA alone and shares HR; C leads nothing.
    assertEq(l.byTeam.map(t => `${t.key}:${t.led}+${t.shared}`), ['A:1+1', 'B:1+1', 'C:0+0'], 'led and shared');
});

test('seasonCategoryLeaders: a team with no figure is left out and counted, never read as zero', () => {
    const l = seasonCategoryLeaders(B293_CATS);
    assertEq(l.categories.map(c => c.missing), [0, 0, 1], 'one team filed no runs');
    // Were the missing figure a zero, a lower-is-better category would hand that team the lead.
    const inv = { ...B293_CATS, settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 20, isReverseItem: true }] } } };
    assertEq(seasonCategoryLeaders(inv).categories[0].leaders.map(x => x.key), ['B'], '90 is the lowest FILED figure');
});

test('seasonCategoryLeaders: null for a points season and for a season with nothing posted', () => {
    const asPoints = { ...B293_CATS, settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 5 }] } } };
    assertEq(seasonCategoryLeaders(asPoints), null, 'a points season has no category to lead');
    const bare = { ...B293_CATS, teams: [b293Team(1, '{A}'), b293Team(2, '{B}')] };
    assertEq(seasonCategoryLeaders(bare), null, 'no valuesByStat on any team - the unplayed shape');
    const zeros = { ...B293_CATS, teams: [b293Team(1, '{A}', { valuesByStat: { 5: 0, 47: 0, 20: 0 } }), b293Team(2, '{B}', { valuesByStat: { 5: 0 } })] };
    assertEq(seasonCategoryLeaders(zeros), null, 'all zeros is nothing posted, not a six-way tie');
    assertEq(seasonCategoryLeaders(null), null, 'no season');
    assertEq(seasonCategoryLeaders({ teams: [] }), null, 'no teams');
});

// Four teams, a points season. Regular season: M1 A 100-90 B, D 120-80 C; M2 C 95-70 A, B 110-110 D (a tie). M3 is a playoff game, A 130-60 D. M4 has not been played.
const b293Pts = (teamId, totalPoints) => ({ teamId, totalPoints });
const B293_POINTS = {
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 5 }] } },
    teams: [
        b293Team(1, '{A}', { record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 170, pointsAgainst: 185 } } }),
        b293Team(2, '{B}', { record: { overall: { wins: 0, losses: 1, ties: 1, pointsFor: 200, pointsAgainst: 210 } } }),
        b293Team(3, '{C}', { record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 175, pointsAgainst: 190 } } }),
        b293Team(4, '{D}', { record: { overall: { wins: 1, losses: 0, ties: 1, pointsFor: 230, pointsAgainst: 190 } } })
    ],
    schedule: [
        o65Game(1, b293Pts(1, 100), b293Pts(2, 90), 'HOME'),
        o65Game(1, b293Pts(3, 80), b293Pts(4, 120), 'AWAY'),
        o65Game(2, b293Pts(1, 70), b293Pts(3, 95), 'AWAY'),
        o65Game(2, b293Pts(2, 110), b293Pts(4, 110), 'TIE'),
        o65Game(3, b293Pts(4, 60), b293Pts(1, 130), 'AWAY', 'WINNERS_BRACKET'),
        o65Game(4, b293Pts(1, 0), b293Pts(2, 0), 'UNDECIDED')
    ]
};

test('seasonPointsFacts: the lowest score and the highest that still lost, over every decided game', () => {
    const f = seasonSummary(B293_POINTS, [], O65_READERS).pointsFacts;
    // The lowest is D's 60 in the playoff game, since a playoff game is a game. The undecided 0-0 is not.
    assertEq([f.lowestWeek.key, f.lowestWeek.value, f.lowestWeek.when], ['D', 60, 'M3'], 'the lowest decided score');
    // Losing scores: B 90 and C 80 (M1), A 70 (M2), D 60 (M3). The 110-110 tie has no loser.
    assertEq([f.highestLoss.key, f.highestLoss.value, f.highestLoss.when], ['B', 90, 'M1'], 'the best score that lost');
});

test('seasonPointsFacts: the average and the points against are the regular season, as ESPN counts them', () => {
    const s = seasonSummary(B293_POINTS, [], O65_READERS);
    // A 100+70 over 2; B 90+110; C 80+95; D 120+110. The playoff 130 and 60 are NOT in the line.
    assertEq(s.pointsFacts.averages.map(a => `${a.key}:${a.games}:${a.average}`),
        ['D:2:115', 'B:2:100', 'C:2:87.5', 'A:2:85'], 'ordered by average, highest first');
    // Against: A 90+95 = 185, B 100+110 = 210, C 120+70 = 190, D 80+110 = 190.
    assertEq(s.pointsFacts.mostAgainst, { key: 'B', value: 210 }, 'the most scored against');
    // The same figures ESPN files in the record, which the standings now carry beside it.
    assertEq(s.standings.map(r => `${r.key}:${r.pointsFor}:${r.pointsAgainst}`).sort(),
        ['A:170:185', 'B:200:210', 'C:175:190', 'D:230:190'], 'the two agree');
});

test('seasonPointsFacts: nothing until a matchup is decided, and nothing on another format', () => {
    const unplayed = { ...B293_POINTS, teams: B293_POINTS.teams.map(t => ({ ...t, record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 } } })),
        schedule: [o65Game(1, b293Pts(1, 0), b293Pts(2, 0), 'UNDECIDED')] };
    const s = seasonSummary(unplayed, [], O65_READERS);
    assertEq(s.pointsFacts, null, 'a minimum over an unplayed season is a zero with a name on it');
    assertEq(s.standings.map(r => [r.pointsFor, r.pointsAgainst]), [[null, null], [null, null], [null, null], [null, null]],
        'and the unplayed standings carry no points either, not 0');
    assertEq(seasonPointsFacts([]), null, 'no rows');
    assertEq(seasonPointsFacts(null), null, 'no rows at all');
    const h2h = seasonSummary(O65_H2H, O65_FRANCHISES, O65_READERS);
    assertEq(h2h.pointsFacts, null, 'a category season scores no points');
    assertEq(h2h.standings.map(r => r.pointsFor), [null, null, null, null], 'and its standings say null, not the 0 ESPN files');
});

test('seasonPointsFacts: a season of ties has a lowest score and no losing one', () => {
    const tied = { ...B293_POINTS, schedule: [o65Game(1, b293Pts(1, 88), b293Pts(2, 88), 'TIE')] };
    const f = seasonSummary(tied, [], O65_READERS).pointsFacts;
    assertEq([f.lowestWeek.key, f.lowestWeek.value], ['A', 88], 'the first row met, on a level figure');
    assertEq(f.highestLoss, null, 'a tie has no loser');
    assertEq(f.mostAgainst, { key: 'A', value: 88 }, 'and the line still counts it');
});

// Three teams, two categories. HR (5): 50, 40, 40. ERA (47, lower wins): 3.0, 3.0, 4.5. Roto points with three teams are 3, 2, 1, a tie sharing the average of the places it spans: HR T1 3 T2 and T3 share (2+1)/2 = 1.5 ERA T1 and T2 share (3+2)/2 = 2.5 T3 1 totals 5.5, 4, 2.5
const b293Roto = (filed) => ({
    seasonId: 2025,
    settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 5 }, { statId: 47, isReverseItem: true }] } },
    teams: [
        b293Team(1, '{A}', { valuesByStat: { 5: 50, 47: 3.0 }, ...(filed ? { points: 5.5, pointsByStat: { 5: 3, 47: 2.5 } } : {}) }),
        b293Team(2, '{B}', { valuesByStat: { 5: 40, 47: 3.0 }, ...(filed ? { points: 4, pointsByStat: { 5: 1.5, 47: 2.5 } } : {}) }),
        b293Team(3, '{C}', { valuesByStat: { 5: 40, 47: 4.5 }, ...(filed ? { points: 2.5, pointsByStat: { 5: 1.5, 47: 1 } } : {}) })
    ]
});
const b293Cells = (t) => t.rows.map(r => `${r.key} ${t.categories.map(c => { const x = r.categories[c.statId]; return `${x.value}/${x.points}/${x.place}`; }).join(' ')}`);

test('rotoSeasonTable: every cell is the figure, the roto points and the place', () => {
    const t = rotoSeasonTable(b293Roto(true));
    assertEq(b293Cells(t), ['A 50/3/1 3/2.5/1', 'B 40/1.5/2 3/2.5/1', 'C 40/1.5/2 4.5/1/3'], 'level teams share a place');
    assertEq(t.categories, [{ statId: '5', inverse: false }, { statId: '47', inverse: true }], 'the categories, in the league order');
    assertEq(t.pointsBasis, 'espn', "ESPN's own points, with no reader handed in at all");
});

test('rotoSeasonTable: the total, the place, the margin to the next and the categories won alone', () => {
    const t = rotoSeasonTable(b293Roto(true));
    assertEq(t.rows.map(r => [r.key, r.total, r.place, r.marginToNext]),
        [['A', 5.5, 1, 1.5], ['B', 4, 2, 1.5], ['C', 2.5, 3, null]], 'the last place has nobody below it');
    // A leads HR alone. ERA is shared by A and B, so nobody WON it.
    assertEq(t.rows.map(r => r.won), [1, 0, 0], 'a shared first place is not a win');
});

test('rotoSeasonTable: the rank-engine rebuild gives the same table where ESPN filed nothing', () => {
    const filed = rotoSeasonTable(b293Roto(true));
    const rebuilt = rotoSeasonTable(b293Roto(false), { rotoPointsOf: rotoPointsForCategory });
    assertEq(rebuilt.pointsBasis, 'rebuilt', 'named as a rebuild');
    assertEq(b293Cells(rebuilt), b293Cells(filed), 'cell for cell');
    assertEq(rebuilt.rows.map(r => r.total), [5.5, 4, 2.5], 'and the totals are the sum of the cells');
    const mixed = b293Roto(true);
    delete mixed.teams[2].pointsByStat;
    assertEq(rotoSeasonTable(mixed, { rotoPointsOf: rotoPointsForCategory }).pointsBasis, 'mixed', 'one team rebuilt says so');
});

test('rotoSeasonTable: with neither source the points are null, never zero, and the figures stay', () => {
    const t = rotoSeasonTable(b293Roto(false));
    assertEq(t.pointsBasis, null, 'nothing to build points from');
    assertEq(b293Cells(t), ['A 50/null/1 3/null/1', 'B 40/null/2 3/null/1', 'C 40/null/2 4.5/null/3'], 'the values and their places are still facts');
    assertEq(t.rows.map(r => [r.total, r.place, r.marginToNext]), [[null, null, null], [null, null, null], [null, null, null]], 'no total, so no place');
});

test('rotoSeasonTable: level totals share a place with a margin of zero', () => {
    // Two teams, HR 10 and 5, ERA 5 and 3 with the lower winning: 2+1 against 1+2.
    const level = {
        seasonId: 2025,
        settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [{ statId: 5 }, { statId: 47, isReverseItem: true }] } },
        teams: [b293Team(1, '{A}', { valuesByStat: { 5: 10, 47: 5 } }), b293Team(2, '{B}', { valuesByStat: { 5: 5, 47: 3 } })]
    };
    const t = rotoSeasonTable(level, { rotoPointsOf: rotoPointsForCategory });
    assertEq(t.rows.map(r => [r.key, r.total, r.place, r.marginToNext, r.won]), [['A', 3, 1, 0, 1], ['B', 3, 1, null, 1]], 'both first');
});

test('rotoSeasonTable: null for any season that is not roto', () => {
    assertEq(rotoSeasonTable(B293_CATS, { rotoPointsOf: rotoPointsForCategory }), null, 'a category season');
    assertEq(rotoSeasonTable(B293_POINTS), null, 'a points season');
    assertEq(rotoSeasonTable(null), null, 'no season');
    const noCats = { ...b293Roto(true), settings: { scoringSettings: { scoringType: 'ROTO', scoringItems: [] } } };
    assertEq(rotoSeasonTable(noCats), null, 'a roto season with no categories has no table');
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `: ${r.err}`}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
