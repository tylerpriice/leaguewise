/**
 * Which of three lives a league is living, read off the league's own payload: before its draft,
 * drafted but not yet playing, or underway. Also whether the season has finished, when the draft
 * is scheduled, and which face the Draft tab wears.
 *
 * Pure. No DOM, no application state and no network. The payload is an argument, so every state
 * can be tested against a fixture.
 *
 * Tests: tests/season-state.test.html
 * @module season-state
 */

/**
 * The three states a league can be in.
 *
 * @type {{PRE_DRAFT: string, PRESEASON: string, UNDERWAY: string}}
 */
export const SEASON_STATE = {
    PRE_DRAFT: 'pre-draft',
    PRESEASON: 'post-draft-preseason',
    UNDERWAY: 'underway'
};

/**
 * Whether the league has played yet. It reads accumulated team totals, since records cannot be
 * trusted: a finished roto league reports no wins and no losses for every team. A decided game and
 * a scored period on a schedule side are further signs.
 *
 * @param {object} payload The league payload.
 * @returns {boolean} True once any sign of play is present.
 */
export function gamesHaveBeenPlayed(payload) {
    const teams = (payload && payload.teams) || [];
    const anyStats = teams.some(t => {
        const vals = t && t.valuesByStat;
        return !!vals && Object.values(vals).some(v => Number(v) > 0);
    });
    if (anyStats) return true;
    const schedule = (payload && payload.schedule) || [];
    // A decided game is play. A roto schedule carries one undecided entry, so this never fires there.
    if (schedule.some(g => g && g.winner && g.winner !== 'UNDECIDED')) return true;

    // A third sign: a scored period on any side of the schedule. In the first days of a season the team totals are still zero and every matchup is undecided, while the sides already carry points for the period. It is a sign for points leagues only, since a league that scores categories has no points per period to report.
    return schedule.some(g => g && ['home', 'away'].some(side => {
        const points = g[side] && g[side].pointsByScoringPeriod;
        return !!points && typeof points === 'object'
            && Object.values(points).some(v => Number(v) > 0);
    }));
}

/**
 * Whether the draft has happened, by the league's own flag.
 *
 * @param {object} payload The league payload.
 * @returns {?boolean} True or false, or null when the payload does not say. Null is not false.
 */
export function draftHeld(payload) {
    const detail = payload && payload.draftDetail;
    if (!detail || typeof detail.drafted !== 'boolean') return null;
    return detail.drafted;
}

/**
 * The league's state. Play outranks everything: a league with games on the board is underway
 * whatever its draft flag says. With no play and no answer on the draft, it reads underway, since
 * a wrong preseason face replaces the whole page and a wrong underway face shows boxes that are
 * empty.
 *
 * @param {object} payload The league payload.
 * @returns {string} One of SEASON_STATE's values.
 */
export function seasonState(payload) {
    if (!payload) return SEASON_STATE.UNDERWAY;
    if (gamesHaveBeenPlayed(payload)) return SEASON_STATE.UNDERWAY;
    const drafted = draftHeld(payload);
    if (drafted === false) return SEASON_STATE.PRE_DRAFT;
    if (drafted === true) return SEASON_STATE.PRESEASON;
    return SEASON_STATE.UNDERWAY;
}

/**
 * Whether a state is one of the two before play begins.
 *
 * @param {string} state A SEASON_STATE value.
 * @returns {boolean} True for pre-draft and for drafted but not playing.
 */
export function isPreseason(state) {
    return state === SEASON_STATE.PRE_DRAFT || state === SEASON_STATE.PRESEASON;
}

/**
 * Whether the season has ended: the latest scoring period is past the final one. A finished
 * season still reads underway in seasonState, since it did start. ESPN's projection for the rest
 * of a season stops updating once the season closes, so a caller refuses that projection here.
 *
 * seasonFinished in history.js asks the same of a past season, and the two differ in two places:
 * when the latest period equals the final one this is false and that is true, and when a field is
 * missing this is false and that is true. Every finished season measured reads latest one past
 * final, where the two agree.
 *
 * @param {object} payload The league payload.
 * @returns {boolean} False when either figure is missing, since an unknown season is not a finished one.
 */
export function seasonIsFinished(payload) {
    const status = payload && payload.status;
    const latest = Number(status && status.latestScoringPeriod);
    const final = Number(status && status.finalScoringPeriod);
    if (!Number.isFinite(latest) || !Number.isFinite(final)) return false;
    return latest > final;
}

/**
 * When the draft is scheduled, from the league's own draft settings. The days count calendar
 * days from the start of the present day, so a draft later tonight reads 0 and one tomorrow
 * morning reads 1.
 *
 * @param {object} payload The league payload.
 * @param {Date} now The present, passed in so the answer can be tested for any day.
 * @param {?number} [teamId] The reader's team, for its place in the pick order.
 * @returns {{date: ?Date, hasDate: boolean, daysUntil: ?number, type: ?string, slot: ?number, teams: ?number}} The schedule. The date is null when none is set.
 */
export function draftSchedule(payload, now, teamId = null) {
    const settings = (payload && payload.settings && payload.settings.draftSettings) || {};
    const raw = settings.date;
    // ESPN sends epoch milliseconds. Zero and null both mean no date is set, which is a real state and must not read as a date in 1970.
    const date = (typeof raw === 'number' && raw > 0) ? new Date(raw) : null;
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const daysUntil = (date && now) ? Math.round((startOfDay(date) - startOfDay(now)) / 86400000) : null;
    const order = Array.isArray(settings.pickOrder) ? settings.pickOrder : [];
    const slotIndex = teamId == null ? -1 : order.indexOf(teamId);
    return {
        date,
        hasDate: !!date,
        daysUntil,
        type: settings.type || null,
        slot: slotIndex >= 0 ? slotIndex + 1 : null,
        teams: order.length || null
    };
}

/**
 * Whether the Draft tab is still shown: through both preseason states and through the first
 * matchup. A roto league has no matchups, so it keeps the tab through the preseason only. A
 * finished season is past its first matchup whatever its status says.
 *
 * @param {object} payload The league payload.
 * @returns {boolean} True while the tab stands.
 */
export function draftLookBackOpen(payload) {
    if (!payload) return false;
    if (isPreseason(seasonState(payload))) return true;
    const scoring = payload.settings && payload.settings.scoringSettings;
    if (scoring && scoring.scoringType === 'ROTO') return false;
    if (seasonIsFinished(payload)) return false;
    const current = Number(payload.status && payload.status.currentMatchupPeriod);
    return Number.isFinite(current) && current <= 1;
}

/**
 * Whether the Draft tab shows the finished draft's results and not the live companion. It is the
 * league's own answer, asked before any log of picks: the drafted flag, or, while ESPN still marks
 * the draft in progress, a roster with somebody on it for every team.
 *
 * @param {object} payload The league payload.
 * @returns {boolean} True when the draft is over. A payload that does not say reads false.
 */
export function draftTabShowsResults(payload) {
    if (draftHeld(payload) === true) return true;
    // ESPN does not set the drafted flag the moment a draft ends. In that window the rosters are the test: every team has somebody. ESPN does not fill rosters as picks land, so this cannot fire mid-draft, and a player dropped afterwards leaves the team non-empty.
    if (!payload || payload.draftDetail?.inProgress !== true) return false;
    const teams = Array.isArray(payload.teams) ? payload.teams : [];
    if (!teams.length) return false;
    return teams.every(team => ((team && team.roster && team.roster.entries) || []).length > 0);
}
