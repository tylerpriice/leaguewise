// Unit tests for the pure season-state read. Open tests/season-state.test.html through any static server; green means every assertion held. The states before play have no capture behind them, so their fixture is built by hand and marked synthetic. The shapes that do exist, a completed roto league and a head-to-head one in mid-season, are asserted from their measured form, since those shapes break a naive rule.
import { SEASON_STATE, seasonState, gamesHaveBeenPlayed, draftHeld, isPreseason, seasonIsFinished, draftSchedule, draftLookBackOpen, draftTabShowsResults } from '../src/data/season-state.js';

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
        // The measured trap. Roto keeps no head-to-head record, so every team reports 0-0-0 and the schedule holds one undecided entry, and a test based on records would call a finished season preseason.
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

    // The shape of a football league captured after its opening game: zeros in the team totals, every matchup undecided, and the week's points already on the schedule sides. The two older signs miss it and the third catches it.
    const FIRST_GAME = {
        teams: [{ id: 4, valuesByStat: { '53': 0, '42': 0 } }, { id: 7, valuesByStat: {} }],
        draftDetail: { drafted: true },
        schedule: [
            { matchupPeriodId: 1, winner: 'UNDECIDED',
              home: { teamId: 4, pointsByScoringPeriod: { '1': 10.82 } },
              away: { teamId: 7, pointsByScoringPeriod: { '1': 7 } } },
            { matchupPeriodId: 2, winner: 'UNDECIDED', home: { teamId: 7, pointsByScoringPeriod: null },
              away: { teamId: 4, pointsByScoringPeriod: null } }
        ]
    };

    test('gamesHaveBeenPlayed: a scored period is play, with no statistics and no winner yet', () => {
        assert(gamesHaveBeenPlayed(FIRST_GAME), 'the points are in the payload before the totals are');
        assertEq(seasonState(FIRST_GAME), SEASON_STATE.UNDERWAY, 'so the league is underway, not preseason');
    });

    test('gamesHaveBeenPlayed: an unplayed week scores zero on both sides and is NOT play', () => {
        // The measured capture carries a fifth matchup at zero on both sides, a game that has not started. A key is not a game; a figure above zero is.
        const notStarted = {
            teams: [{ id: 1, valuesByStat: {} }],
            draftDetail: { drafted: true },
            schedule: [{ winner: 'UNDECIDED',
                home: { teamId: 1, pointsByScoringPeriod: { '1': 0 } },
                away: { teamId: 2, pointsByScoringPeriod: { '1': 0 } } }]
        };
        assert(!gamesHaveBeenPlayed(notStarted), 'zeros are not play');
        assertEq(seasonState(notStarted), SEASON_STATE.PRESEASON, 'and it is still preseason');
    });

    test('gamesHaveBeenPlayed: a side with no points key at all is not play', () => {
        // The pre-draft football capture: 140 schedule sides, carry-forward rosters, and not one of them carries pointsByScoringPeriod. This witness must never turn that league underway.
        const preDraft = {
            teams: [{ id: 1, valuesByStat: {} }],
            draftDetail: { drafted: false },
            schedule: [{ winner: 'UNDECIDED', home: { teamId: 1, rosterForCurrentScoringPeriod: {} },
                away: { teamId: 2 } }]
        };
        assert(!gamesHaveBeenPlayed(preDraft), 'no key, no play');
        assertEq(seasonState(preDraft), SEASON_STATE.PRE_DRAFT, 'still before the draft');
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

// A finished season. The season state cannot answer this: it says whether a league has started, and a finished one reads underway because it did. Every figure below is the measured form from a real capture. The predicate matters because ESPN's rest-of-season projection stops updating on a closed season.

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

    // How long the Draft tab lives. Every figure below is a measured capture's own status.
    const played = (matchup) => ({
        teams: [{ id: 1, valuesByStat: { '20': 251 } }],
        schedule: [{ winner: 'HOME' }],
        draftDetail: { drafted: true },
        status: { currentMatchupPeriod: matchup, latestScoringPeriod: 2, finalScoringPeriod: 18 }
    });

    test('draftLookBackOpen: matchup one keeps the tab, matchup two closes it', () => {
        // A league in matchup 2 with matchup 1 final.
        assertEq(draftLookBackOpen(played(2)), false, 'matchup 2 closes the look-back');
        // full-nfl-2026-post-draft-2: currentMatchupPeriod 1, nothing scored yet.
        assertEq(draftLookBackOpen(played(1)), true, 'matchup one is the look-back');
        // full-mlb-2026-2 at matchup 22, full-nhl-fgb at 24.
        assertEq(draftLookBackOpen(played(22)), false, 'mid-season');
        assertEq(draftLookBackOpen(played(24)), false, 'and late');
    });

    test('draftLookBackOpen: both preseason states keep it, whatever the matchup says', () => {
        assertEq(draftLookBackOpen(FIXTURE), true, 'pre-draft');
        const drafted = { ...FIXTURE, draftDetail: { drafted: true, picks: [{ playerId: 1 }] } };
        assertEq(isPreseason(seasonState(drafted)), true, 'the fixture with a draft is post-draft preseason');
        assertEq(draftLookBackOpen(drafted), true, 'and it keeps the tab');
    });

    test('draftLookBackOpen: ROTO is never inside matchup one, so it closes when play starts', () => {
        // THE TRAP, measured on full-nhl-2 (roto): matchupPeriodCount 1 and currentMatchupPeriod 1 at scoring period 197 of 196 - a FINISHED season still reporting matchup 1, because roto has no matchups. A bare 'currentMatchupPeriod <= 1' would keep the tab up all year.
        const roto = {
            teams: [{ id: 1, valuesByStat: { '20': 251 } }],
            schedule: [{ winner: 'UNDECIDED' }],
            draftDetail: { drafted: true },
            settings: { scoringSettings: { scoringType: 'ROTO' } },
            status: { currentMatchupPeriod: 1, latestScoringPeriod: 197, finalScoringPeriod: 196 }
        };
        assertEq(draftLookBackOpen(roto), false, 'roto keeps it through the preseason and no further');
    });

    test('draftLookBackOpen: a finished season is past matchup one however it numbers itself', () => {
        const finished = { ...played(1), status: { currentMatchupPeriod: 1, latestScoringPeriod: 193, finalScoringPeriod: 192 } };
        assertEq(draftLookBackOpen(finished), false, 'the season closed');
        assertEq(draftLookBackOpen(null), false, 'no league loaded');
        assertEq(draftLookBackOpen({ ...played(1), status: {} }), false, 'no matchup number to trust');
    });

    // Which face the Draft tab wears. The face must come from the league's own answer about its draft and not from a log of picks, which is a record of what was seen. This is that answer, and it is asked first.

    test('draftTabShowsResults: the league own drafted flag decides, nothing else', () => {
        assertEq(draftTabShowsResults({ draftDetail: { drafted: true } }), true, 'a finished draft shows its results');
        assertEq(draftTabShowsResults({ draftDetail: { drafted: false } }), false, 'a draft still to come keeps the companion');
    });

    test('draftTabShowsResults: A LIVE DRAFT KEEPS THE COMPANION, which is the whole point', () => {
        // Measured on a capture taken mid-draft: ESPN reports drafted false and in progress true throughout a live room, so the live companion is what a live draft gets.
        assertEq(draftTabShowsResults({ draftDetail: { drafted: false, inProgress: true } }), false,
            'mid-draft is not drafted, whatever else the detail says');
    });

    test('draftTabShowsResults: no answer is NOT drafted, so nothing blanks a draft in progress', () => {
        // draftHeld returns null for a payload with no boolean there, which is a format this code has not met. Keeping the live companion is the safe direction; blanking the page is not.
        assertEq(draftTabShowsResults({ draftDetail: {} }), false, 'no flag at all');
        assertEq(draftTabShowsResults({ draftDetail: { drafted: 'yes' } }), false, 'not a boolean');
        assertEq(draftTabShowsResults({}), false, 'no draftDetail');
        assertEq(draftTabShowsResults(null), false, 'no payload');
    });
    // The window ESPN leaves open. Measured after a room ended: drafted read false and in progress true with all 286 picks still the placeholder, while the rosters held 286 real entries across 13 teams. The flag arrives later; inside that window the rosters are the only sign.
    const rostered = (teams, per) => ({
        draftDetail: { drafted: false, inProgress: true },
        teams: Array.from({ length: teams }, (_, i) => ({
            id: i + 1,
            roster: { entries: Array.from({ length: per }, (_, j) => ({ playerId: 9000 + i * 100 + j })) }
        }))
    });

    test('draftTabShowsResults: full rosters inside the window read as drafted', () => {
        assertEq(draftTabShowsResults(rostered(13, 22)), true, 'every team has its complement');
    });

    test('draftTabShowsResults: a LIVE draft cannot fire it - the rosters are empty', () => {
        // The measurement this rests on: past pick 140 of 286, every one of 13 rosters held ZERO.
        assertEq(draftTabShowsResults(rostered(13, 0)), false, 'no team has anybody');
        const partway = rostered(13, 22);
        partway.teams[7].roster.entries = [];
        assertEq(draftTabShowsResults(partway), false, 'one empty team is enough to refuse');
    });

    test('draftTabShowsResults: a drop after the draft does not flip the tab back', () => {
        // Why the test is everybody-has-somebody and not everybody-has-the-complement: a manager dropping a player would otherwise put a finished draft back into a live face.
        const dropped = rostered(13, 22);
        dropped.teams[3].roster.entries = dropped.teams[3].roster.entries.slice(0, 21);
        assertEq(draftTabShowsResults(dropped), true, 'uneven, and still plainly drafted');
    });

    test('draftTabShowsResults: the window needs inProgress, and needs teams', () => {
        const noFlag = rostered(13, 22);
        noFlag.draftDetail = {};
        assertEq(draftTabShowsResults(noFlag), false, 'no inProgress, no window');
        assertEq(draftTabShowsResults(rostered(0, 0)), false, 'a league with no teams proves nothing');
    });
    const passed = results.filter(r => r.ok).length;
    document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
    document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
    document.getElementById('results').innerHTML = results.map(r =>
        `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
    ).join('');
})();
