/**
 * How a team's place has moved over a window of matchups: the place now and at the window's
 * start, the best and worst inside it, the current run, and the gaps to the teams above and below.
 *
 * The figure per matchup is not the same in every league. The app's weekly rows hold a result of
 * 1, 0.5 or 0 for a category league and a points total for a points league, under one name. A roto
 * league has no schedule of matchups, so its figures are handed in.
 *
 * Pure, and it imports nothing. No DOM, no application state, no network, no stat ids and no
 * sport.
 *
 * Contract: tests/fixtures/standings-movement.md
 * Tests: tests/standings-movement.test.html
 * @module standings-movement
 */

const key = id => String(id);
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const round2 = n => Math.round(n * 100) / 100;

const UNITS = { categories: 'wins', points: 'points', roto: 'roto points' };

// The figure per matchup per team, either handed in or read off the app's weekly rows. A roto league's figures are always handed in, since its schedule holds no decided matchup.
function figuresFrom(input, scoring, figures) {
    const out = {};
    if (figures) {
        const entries = figures instanceof Map ? [...figures.entries()] : Object.entries(figures);
        entries.forEach(([id, byMatchup]) => {
            const row = {};
            Object.keys(byMatchup || {}).forEach(m => {
                const v = num(byMatchup[m]);
                if (v !== null && Number.isFinite(Number(m))) row[Number(m)] = v;
            });
            out[key(id)] = row;
        });
        return out;
    }
    (Array.isArray(input) ? input : []).forEach(team => {
        if (!team || team.id === undefined || team.id === null) return;
        const src = team.weeklyMatchWins || {};
        const row = {};
        Object.keys(src).forEach(m => {
            const v = num(src[m]);
            if (v !== null && Number.isFinite(Number(m))) row[Number(m)] = v;
        });
        out[key(team.id)] = row;
    });
    return out;
}

// Competition ranks over the figures at one matchup: the highest is first, and teams level on a figure share the better place.
function placesAt(ids, cum, index) {
    const sorted = ids.map(id => ({ id, v: cum[id][index] })).sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
    const places = {};
    sorted.forEach((row, i) => {
        const first = sorted.findIndex(r => r.v === row.v);
        places[row.id] = first + 1;
    });
    return places;
}

/**
 * Every team's running figure and its place after each matchup.
 *
 * @param {Array<{id: *, weeklyMatchWins: Object<number, number>}>} input The app's weekly rows per team.
 * @param {object} [options]
 * @param {('categories'|'points'|'roto')} [options.scoring='categories'] The league's scoring, which names the unit.
 * @param {?(Map|Object<string, Object<number, number>>)} [options.figures] The figure per team and matchup, used in place of the weekly rows.
 * @param {?number} [options.through] The last matchup to count.
 * @returns {{matchups: number[], places: Object<string, number[]>, figures: Object<string, number[]>, unit: string}} The matchups in order, and per team its place and running figure after each.
 */
export function standingsSeries(input, { scoring = 'categories', figures = null, through = null } = {}) {
    const byTeam = figuresFrom(input, scoring, figures);
    const ids = Object.keys(byTeam);
    const matchups = [...new Set(ids.flatMap(id => Object.keys(byTeam[id]).map(Number)))]
        .filter(m => through === null || m <= through)
        .sort((a, b) => a - b);

    const cum = {};
    const running = {};
    ids.forEach(id => { cum[id] = []; running[id] = 0; });
    matchups.forEach(m => {
        ids.forEach(id => {
            // A matchup a team did not play does not move its figure. No entry is not a zero, so a bye holds a team's place.
            const v = byTeam[id][m];
            if (v !== undefined) running[id] += v;
            cum[id].push(running[id]);
        });
    });

    const places = {};
    ids.forEach(id => { places[id] = []; });
    matchups.forEach((m, i) => {
        const at = placesAt(ids, cum, i);
        ids.forEach(id => { places[id].push(at[id]); });
    });
    return { matchups, places, figures: cum, unit: UNITS[scoring] || UNITS.categories };
}

// The current run is read at the end of the season so far and never at the window's end, so it does not change when the window does. A tie ends a run. A points league's results are kept under their own name.
function runFor(input, teamId, scoring, through) {
    const team = (Array.isArray(input) ? input : []).find(t => t && key(t.id) === key(teamId));
    if (!team) return null;
    const src = scoring === 'points' ? (team.weeklyMatchResult || {}) : (team.weeklyMatchWins || {});
    const matchups = Object.keys(src).map(Number).filter(m => Number.isFinite(m) && (through === null || m <= through))
        .sort((a, b) => a - b);
    let dir = null;
    let length = 0;
    for (let i = matchups.length - 1; i >= 0; i--) {
        const v = num(src[matchups[i]]);
        if (v === null) break;
        const word = v === 1 ? 'won' : (v === 0 ? 'lost' : 'tied');
        if (dir === null) {
            dir = word;
            length = 1;
            if (word === 'tied') break;
        } else if (word === dir) {
            length += 1;
        } else break;
    }
    return dir ? { dir, length } : null;
}

/**
 * How one team's place has moved over the last so many matchups. The change is positive for a
 * climb, since a place falling in number is a team rising.
 *
 * @param {Array<{id: *, weeklyMatchWins: object, weeklyMatchResult: object}>} input The app's weekly rows per team.
 * @param {object} [options]
 * @param {number|string} options.teamId The team.
 * @param {number} options.window How many matchups back.
 * @param {('categories'|'points'|'roto')} [options.scoring='categories'] The league's scoring.
 * @param {?(Map|object)} [options.figures] The figure per team and matchup, used in place of the weekly rows.
 * @param {?number} [options.through] The last matchup to count.
 * @returns {?{window: number, matchupsUsed: number, unit: string, placeNow: number, placeThen: ?number, delta: ?number, best: {place: number, matchup: number}, worst: {place: number, matchup: number}, run: ?{dir: ('won'|'lost'|'tied'), length: number}, gapAbove: ?{teamId: string, amount: number}, gapBelow: ?{teamId: string, amount: number}, figureNow: number, figureThen: ?number}}
 *   Null for a team not in the standings and for a window longer than the matchups played.
 */
export function movementFor(input, { teamId, window, scoring = 'categories', figures = null, through = null } = {}) {
    const series = standingsSeries(input, { scoring, figures, through });
    const ids = Object.keys(series.places);
    const me = key(teamId);
    if (!ids.includes(me) || !series.matchups.length) return null;
    const w = Math.floor(num(window) || 0);
    // A window longer than the matchups played gives null for the whole result, never a zero.
    if (w < 1 || w > series.matchups.length) return null;

    const last = series.matchups.length - 1;
    const start = last - w;
    const placeNow = series.places[me][last];
    // The place after the matchup before the window is what makes the change the window's own. A window covering every matchup played has no such matchup, so that place and the change are null.
    const placeThen = start >= 0 ? series.places[me][start] : null;

    let best = null;
    let worst = null;
    for (let i = last - w + 1; i <= last; i++) {
        const place = series.places[me][i];
        if (best === null || place < best.place) best = { place, matchup: series.matchups[i] };
        if (worst === null || place > worst.place) worst = { place, matchup: series.matchups[i] };
    }

    const order = ids.slice().sort((a, b) => series.figures[b][last] - series.figures[a][last] || (a < b ? -1 : 1));
    const at = order.indexOf(me);
    const gapTo = (otherIndex, sign) => {
        const other = order[otherIndex];
        if (!other) return null;
        return { teamId: other, amount: round2(sign * (series.figures[other][last] - series.figures[me][last])) };
    };
    return {
        window: w,
        matchupsUsed: w,
        unit: series.unit,
        placeNow,
        placeThen,
        delta: placeThen === null ? null : placeThen - placeNow,
        best,
        worst,
        run: runFor(input, teamId, scoring, through),
        // The leader has no gap above and the last team none below. Null, never 0, which would read as level with another team.
        gapAbove: at > 0 ? gapTo(at - 1, 1) : null,
        gapBelow: at + 1 < order.length ? gapTo(at + 1, -1) : null,
        figureNow: round2(series.figures[me][last]),
        figureThen: start >= 0 ? round2(series.figures[me][start]) : null
    };
}
