// Unit tests for the pure season-state read. Open tests/season-state.test.html through any static server - green means every assertion held. The pre-draft and preseason states have NO capture behind them: every real league in the corpus is drafted with a full season played. So the fixture is hand-built (tests/fixtures/preseason-pre-draft.json, marked synthetic in its own first field) and the shapes that DO exist - a completed roto league, a mid-season head-to-head one - are asserted here from their measured form, because those are the shapes that break a naive rule.
import { SEASON_STATE, seasonState, gamesHaveBeenPlayed, draftHeld, isPreseason, seasonIsFinished, draftSchedule } from '../season-state.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// The fixture is fetched before a single test runs, so no test can read it half-loaded.
(async () => {
    const FIXTURE = await (await fetch('fixtures/preseason-pre-draft.json')).json();

    // ==== games played ====

    test('gamesHaveBeenPlayed: a completed ROTO league counts as played on its statistics alone', () => {
        // The measured trap. Roto keeps no head-to-head record, so every team reports 0-0-0 and the schedule holds one undecided entry - a records-based test calls a finished season preseason.
        const rotoComplete = {
            teams: [{ id: 1, valuesByStat: { '20': 251, '5': 153 }, record: { overall: { wins: 0, losses: 0, ties: 0 } } }],
            schedule: [{ winner: 'UNDECIDED' }]
        };
        assert(gamesHaveBeenPlayed(rotoComplete), 'accumulated statistics are play');
        assertEq(seasonState({ ...rotoComplete, draftDetail: { drafted: true } }), SEASON_STATE.UNDERWAY, 'state');
    });

    test('gamesHaveBeenPlayed: a decided head-to-head game counts even with no statistics', () => {
        assert(gamesHaveBeenPlayed({ teams: [{ id: 1 }], schedule: [{ winner: 'HOME' }] }), 'a winner is play');
    });

    test('gamesHaveBeenPlayed: an all-zero valuesByStat is NOT play', () => {
        // A league can carry the field with nothing in it. Zero accumulated is the preseason shape.
        assert(!gamesHaveBeenPlayed({ teams: [{ id: 1, valuesByStat: { '20': 0, '5': 0 } }], schedule: [{ winner: 'UNDECIDED' }] }), 'zeros are not play');
    });

    test('gamesHaveBeenPlayed: missing teams and schedule do not throw', () => {
        assert(!gamesHaveBeenPlayed({}), 'empty payload');
        assert(!gamesHaveBeenPlayed({ teams: null, schedule: null }), 'nulls');
    });

    // ==== the draft flag ====

    test('draftHeld: true, false, and NULL for a payload that does not say', () => {
        assertEq(draftHeld({ draftDetail: { drafted: true } }), true, 'drafted');
        assertEq(draftHeld({ draftDetail: { drafted: false } }), false, 'not drafted');
        assertEq(draftHeld({}), null, 'no draftDetail at all');
        assertEq(draftHeld({ draftDetail: {} }), null, 'draftDetail without the flag');
    });

    // ==== the three states ====

    test('seasonState: the synthetic pre-draft fixture reads PRE_DRAFT', () => {
        assertEq(seasonState(FIXTURE), SEASON_STATE.PRE_DRAFT, 'fixture');
        assert(isPreseason(seasonState(FIXTURE)), 'and it is a preseason state');
    });

    test('seasonState: drafted with nothing played is POST-DRAFT PRESEASON', () => {
        const drafted = { ...FIXTURE, draftDetail: { drafted: true, picks: [] } };
        assertEq(seasonState(drafted), SEASON_STATE.PRESEASON, 'state');
        assert(isPreseason(SEASON_STATE.PRESEASON), 'preseason');
    });

    test('seasonState: PLAY OUTRANKS the draft flag', () => {
        // A league that autodrafted, or a format this code has not met, must never blank a season that is visibly happening.
        const playedButUndrafted = {
            ...FIXTURE,
            draftDetail: { drafted: false },
            teams: [{ id: 1, valuesByStat: { '20': 44 } }]
        };
        assertEq(seasonState(playedButUndrafted), SEASON_STATE.UNDERWAY, 'play wins');
    });

    test('seasonState: no play and no draft answer falls back to UNDERWAY', () => {
        // The asymmetry: a wrong preseason face replaces the surface with a countdown, a wrong underway face shows real boxes the empty states already handle.
        const noAnswer = { teams: [{ id: 1 }], schedule: [{ winner: 'UNDECIDED' }] };
        assertEq(seasonState(noAnswer), SEASON_STATE.UNDERWAY, 'fallback');
        assertEq(seasonState(null), SEASON_STATE.UNDERWAY, 'no payload at all');
        assert(!isPreseason(SEASON_STATE.UNDERWAY), 'underway is not preseason');
    });

    // ==== the countdown ====

    test('draftSchedule: counts CALENDAR days, so a draft tonight reads today', () => {
        const now = new Date(2026, 8, 1, 18, 0, 0);          // 1 Sept, 6pm
        const payload = { settings: { draftSettings: { date: new Date(2026, 8, 1, 23, 0, 0).getTime(), type: 'SNAKE' } } };
        const s = draftSchedule(payload, now);
        assertEq(s.daysUntil, 0, 'five hours away is still today');
        assertEq(s.hasDate, true, 'has a date');
        assertEq(s.type, 'SNAKE', 'type');
    });

    test('draftSchedule: tomorrow morning is 1 day, not 0', () => {
        const now = new Date(2026, 8, 1, 23, 0, 0);
        const payload = { settings: { draftSettings: { date: new Date(2026, 8, 2, 9, 0, 0).getTime() } } };
        assertEq(draftSchedule(payload, now).daysUntil, 1, 'ten hours across midnight is a day');
    });

    test('draftSchedule: a date already past counts negative rather than pretending', () => {
        const now = new Date(2026, 8, 5, 12, 0, 0);
        const payload = { settings: { draftSettings: { date: new Date(2026, 8, 1, 12, 0, 0).getTime() } } };
        assertEq(draftSchedule(payload, now).daysUntil, -4, 'four days ago');
    });

    test('draftSchedule: no date set reads as unscheduled, never as 1970', () => {
        assertEq(draftSchedule({ settings: { draftSettings: { date: 0 } } }, new Date(2026, 8, 1)).hasDate, false, 'zero');
        assertEq(draftSchedule({ settings: { draftSettings: {} } }, new Date(2026, 8, 1)).hasDate, false, 'absent');
        assertEq(draftSchedule({}, new Date(2026, 8, 1)).daysUntil, null, 'no settings at all');
        assertEq(draftSchedule({}, new Date(2026, 8, 1)).date, null, 'and no Date object');
    });

    test('draftSchedule: the slot is the team position in the league own pick order', () => {
        // The fixture drafts 3, 1, 4, 2 - so team 4 picks third.
        assertEq(draftSchedule(FIXTURE, new Date(2026, 8, 1), 4).slot, 3, 'team 4 picks third');
        assertEq(draftSchedule(FIXTURE, new Date(2026, 8, 1), 3).slot, 1, 'team 3 picks first');
        assertEq(draftSchedule(FIXTURE, new Date(2026, 8, 1), 99).slot, null, 'a team not in the order');
        assertEq(draftSchedule(FIXTURE, new Date(2026, 8, 1)).slot, null, 'no team asked about');
        assertEq(draftSchedule(FIXTURE, new Date(2026, 8, 1)).teams, 4, 'league size from the order');
    });

// ==== A FINISHED SEASON. SEASON_STATE cannot answer this - it says whether a league has STARTED, and a finished one reads UNDERWAY because it did. Every figure below is the measured form from a real capture, named, because the whole value of this predicate is that ESPN's rest-of-season projection freezes on a closed season and a surface reading it prints a forecast of a window that no longer exists. ====

test('seasonIsFinished: latestScoringPeriod past finalScoringPeriod, the measured shape', () => {
    // Every finished capture in the corpus, exactly as ESPN reports them. ESPN advances latest exactly one past final on the day a season closes, in all three sports.
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 196, finalScoringPeriod: 195 } }), true, '2025 baseball');
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 197, finalScoringPeriod: 196 } }), true, '2025 hockey');
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 193, finalScoringPeriod: 192 } }), true, '2026 hockey');
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 19, finalScoringPeriod: 18 } }), true, '2025 football');
});

test('seasonIsFinished: a season still being played is NOT finished', () => {
    // The live 2026 baseball league, mid-season: period 162 of a season running to 187.
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 162, finalScoringPeriod: 187 } }), false, 'underway');
    // The last day is not past the last day.
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 187, finalScoringPeriod: 187 } }), false, 'the final day itself is still the season');
});

test('seasonIsFinished: a league that has not started is not finished either', () => {
    // A pre-draft football league reads latest 0 against a final of 18.
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 0, finalScoringPeriod: 18 } }), false, 'pre-draft');
});

test('seasonIsFinished: an unreadable status FAILS CLOSED to not-finished', () => {
    // The two errors do not cost the same. Refusing the projected basis on a live league loses a feature; allowing it on a dead one prints a confident forecast of a vanished window. But an UNKNOWN season is not a finished one, so the missing-data answer is false and the caller keeps today's behaviour rather than losing a feature on a payload nobody can read.
    assertEq(seasonIsFinished(null), false, 'no payload');
    assertEq(seasonIsFinished({}), false, 'no status');
    assertEq(seasonIsFinished({ status: {} }), false, 'no periods');
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 196 } }), false, 'no final period');
    assertEq(seasonIsFinished({ status: { finalScoringPeriod: 195 } }), false, 'no latest period');
    assertEq(seasonIsFinished({ status: { latestScoringPeriod: 'x', finalScoringPeriod: 'y' } }), false, 'unparseable');
});

test('seasonIsFinished is independent of seasonState, which still reads UNDERWAY', () => {
    // Stated as a test because it is the trap: a finished season is not a fourth SEASON_STATE and must not be read as one. The two questions are "has it started" and "has it ended", and a closed season answers yes to both.
    const finished = {
        status: { latestScoringPeriod: 196, finalScoringPeriod: 195 },
        teams: [{ valuesByStat: { '5': 40 } }]
    };
    assertEq(seasonState(finished), SEASON_STATE.UNDERWAY, 'still underway by the state machine');
    assertEq(seasonIsFinished(finished), true, 'and finished by this one');
    assertEq(isPreseason(seasonState(finished)), false, 'and not preseason by either');
});

    const passed = results.filter(r => r.ok).length;
    document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
    document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
    document.getElementById('results').innerHTML = results.map(r =>
        `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
    ).join('');
})();
