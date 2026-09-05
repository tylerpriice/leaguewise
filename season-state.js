// PURE. Which of three lives a league is currently living, read off the league's own payload: before its draft, drafted but not yet playing, or underway. Team Metrics and My Team both change face on this answer, so it is one function with one rule rather than each surface guessing from whatever field is nearest. No DOM, no AppState, no fetches - the payload is an argument, which is what lets the states be tested against fixtures nobody has to capture at the right week of the year.

export const SEASON_STATE = {
    PRE_DRAFT: 'pre-draft',
    PRESEASON: 'post-draft-preseason',
    UNDERWAY: 'underway'
};

// Whether the league has actually PLAYED yet, which is the harder half of the question and the one where the obvious fields lie. MEASURED across the captured corpus, which is why this reads accumulated statistics rather than records: a completed ROTO league reports wins 0, losses 0, ties 0 for every team and a schedule of length 1, because roto has no head-to-head record to keep. Testing records would have called a finished hockey season "preseason" - the exact mistake this function exists to avoid. Two roto captures sit in the corpus in precisely that shape. valuesByStat is the signal that survives every format: it carries a team's accumulated category totals, and all three formats measured (roto, H2H categories, H2H points) fill it once play starts - 21, 24 and 29 nonzero entries respectively. A league that has not played has nothing to accumulate. The completed-game check is a second, independent witness for head-to-head formats, kept because one signal that can be absent is not a rule.
export function gamesHaveBeenPlayed(payload) {
    const teams = (payload && payload.teams) || [];
    const anyStats = teams.some(t => {
        const vals = t && t.valuesByStat;
        return !!vals && Object.values(vals).some(v => Number(v) > 0);
    });
    if (anyStats) return true;
    // A decided game is play by definition. Roto schedules carry a single undecided entry, so this never fires there and never contradicts the check above.
    return ((payload && payload.schedule) || []).some(g => g && g.winner && g.winner !== 'UNDECIDED');
}

// Whether the draft has happened. Returns true, false, or NULL for "the payload does not say" - a league fetched without the draft view has no draftDetail at all, and one synthetic fixture in the corpus omits it. Null is not false: claiming a league is pre-draft because a field is missing would put the countdown face in front of someone mid-season.
export function draftHeld(payload) {
    const detail = payload && payload.draftDetail;
    if (!detail || typeof detail.drafted !== 'boolean') return null;
    return detail.drafted;
}

// The league's state. Play outranks everything: a league with games on the board is underway whatever its draft flag says, because a drafted flag left false by a league that autodrafted (or by a format this code has not met) must never blank a season that is visibly happening. With no play and no answer on the draft, the honest fallback is UNDERWAY - the tab exactly as it is today. A wrong preseason face replaces the whole surface with a countdown; a wrong underway face shows real boxes that happen to be empty, which the empty states already handle. The asymmetry is the whole reason the fallback leans this way.
export function seasonState(payload) {
    if (!payload) return SEASON_STATE.UNDERWAY;
    if (gamesHaveBeenPlayed(payload)) return SEASON_STATE.UNDERWAY;
    const drafted = draftHeld(payload);
    if (drafted === false) return SEASON_STATE.PRE_DRAFT;
    if (drafted === true) return SEASON_STATE.PRESEASON;
    return SEASON_STATE.UNDERWAY;
}

// True when the tab should wear a preseason tag at all - both preseason states do, and the two want different words, which the caller supplies. Kept here so no surface re-derives "is this one of the two" from the string.
export function isPreseason(state) {
    return state === SEASON_STATE.PRE_DRAFT || state === SEASON_STATE.PRESEASON;
}

// WHETHER THE SEASON HAS ENDED, which SEASON_STATE deliberately cannot say. Those three states answer "has this league started", and a finished season reads UNDERWAY - correctly, because it did start. Nothing above distinguishes a league in its last week from one whose season closed six months ago, and until O28 nothing needed to. WHY IT SUDDENLY MATTERS: ESPN's rest-of-season projection FREEZES rather than decrementing to zero. On a finished 2025 baseball pool the source-1 lines are a remainder from roughly mid-June - measured, an everyday player carrying 92 to 101 projected games against 162 already played, so actual plus projected sums to 254 where a current remainder would sum to about 162. Any surface reading that line prints a large, confident forecast of a window that closed months ago ("would add 135 the rest of the way", on a season with no rest of the way). The projected basis has to be refused there, and this is the question that refuses it. THE RULE IS latestScoringPeriod PAST finalScoringPeriod, and ESPN advances it exactly one past on the day a season closes. Measured across the whole corpus - seven captures, three sports: finished: 2025 baseball 196>195, 2025 hockey 197>196, 2026 hockey 193>192, 2025 football 19>18 not: the live 2026 baseball league 162<187, a pre-draft football league 0<18 Five of the seven captures in this tree are finished seasons, which is worth knowing on its own: the fixture corpus is mostly PAST leagues, so a bug that only shows on a closed season shows on most of what anyone stages. FALSE when either figure is missing, rather than throwing or guessing. An unknown season is not a finished one, and the cost of the two errors is not symmetric: refusing the projected basis on a live league loses a feature, while allowing it on a dead one prints a confident wrong number.
export function seasonIsFinished(payload) {
    const status = payload && payload.status;
    const latest = Number(status && status.latestScoringPeriod);
    const final = Number(status && status.finalScoringPeriod);
    if (!Number.isFinite(latest) || !Number.isFinite(final)) return false;
    return latest > final;
}

// The draft's scheduled moment, in the shape the countdown card needs, from the league's own draftSettings. Returns { date, hasDate, daysUntil, type, slot } where date is a Date or null. `now` IS AN ARGUMENT, deliberately: a function that read the clock itself could not be tested for what it says three days before a draft, and this whole module's value is that its answers can be staged. daysUntil counts CALENDAR days from the start of now's day, so a draft later tonight reads "today" rather than "in 0.4 days", and one tomorrow morning reads "1" even if it is fifteen hours away.
export function draftSchedule(payload, now, teamId = null) {
    const settings = (payload && payload.settings && payload.settings.draftSettings) || {};
    const raw = settings.date;
    // ESPN sends epoch milliseconds. Zero and null both mean "no date set", which is a real state - a league can exist for weeks before anyone picks a time - and it must read as unscheduled rather than as midnight in 1970.
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
