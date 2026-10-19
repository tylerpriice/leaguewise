/**
 * The projected basis: rosters times projected lines, scored by the engines the app already uses,
 * so a projected standing and the draft board's own value cannot disagree. Also what a player is
 * still expected to produce over a window of the club's games.
 *
 * Pure. No DOM, no application state and no network. The projected line and the roto scorer arrive
 * as arguments.
 *
 * Tests: tests/projected-basis.test.html
 * @module projected-basis
 */
/**
 * What the remainder is worked out from. The same options serve expectedAppearances and
 * remainderLine.
 *
 * @typedef {object} RemainderOptions
 * @property {string|number} gamesId The stat id that counts the player's games.
 * @property {number} clubGamesPlayed How many games the player's club has played.
 * @property {number} gamesRemaining How many games the club has left in the window.
 * @property {number} [projectedStarts] The pitcher's probable starts ESPN lists in the window.
 * @property {boolean} [startsScheduled] Whether ESPN has listed a probable start for the player this season.
 * @property {number} [horizonEnd] The last scoring period ESPN has listed probables for.
 * @property {number} [windowEnd] The last scoring period of the window.
 * @property {Set<string>} [rateIds] The stat ids that are rates, for remainderLine.
 */

import { valueFrom, sumPlayers, idsToSum } from './coverage-model.js';

/**
 * Each team's component sums over its roster's projected lines. Which line is projected is the
 * caller's choice, so the basis agrees with whatever board the caller already built.
 *
 * @param {Object<string, object[]>} rostersByTeam Each team's players.
 * @param {object} [options]
 * @param {Array<string|number>} [options.categoryIds] The scored categories.
 * @param {object[]} [options.components] The sport's rate rules.
 * @param {function(object): object} [options.lineOf] A player's stat line to count. Defaults to the player's raw projected totals.
 * @returns {Object<string, Object<string, number>>} The sums by team.
 */
export function projectedTeamSums(rostersByTeam, { categoryIds, components, lineOf } = {}) {
    const ids = idsToSum(categoryIds || [], components);
    const read = lineOf || ((p) => (p && p.projectedTotals) || {});
    const out = {};
    Object.keys(rostersByTeam || {}).forEach(teamId => {
        // Each player is presented with the projected line under the name the summing code reads, so one summing, one rate rebuild and one coverage path serve both bases.
        const asSeason = (rostersByTeam[teamId] || []).map(p => ({ seasonTotals: read(p) }));
        out[teamId] = sumPlayers(asSeason, ids);
    });
    return out;
}

/**
 * How many times a player is expected to appear over a window of the club's games, and in what
 * unit. The unit is half the answer: a count of starts and a count of club games are different
 * quantities.
 *
 * Starts are counted from ESPN's own probable listings, and only when the player has one listed
 * this season and the window ends inside what ESPN has listed. Otherwise the count is the player's
 * share of the club's games so far, over the games the club has left.
 *
 * @param {{seasonTotals: Object<string, number>}} player The player.
 * @param {RemainderOptions} [options] The window and the club's games.
 * @returns {?{count: number, unit: ('starts'|'games')}} Null when neither can be worked out.
 */
export function expectedAppearances(player, {
    gamesId, clubGamesPlayed, gamesRemaining, projectedStarts, startsScheduled, horizonEnd, windowEnd
} = {}) {
    if (!player) return null;
    // The exact answer first, before the share's refusals. A pitcher called up this week has a listed start and no record to take a share of.
    const starts = Number(projectedStarts);
    const horizon = Number(horizonEnd);
    const end = Number(windowEnd);
    if (startsScheduled && Number.isFinite(starts) && starts >= 0
        && Number.isFinite(horizon) && Number.isFinite(end) && end <= horizon) {
        return { count: starts, unit: 'starts' };
    }
    const actual = player.seasonTotals || null;
    if (!actual || gamesId === null || gamesId === undefined) return null;
    const played = Number(actual[gamesId]);
    if (!Number.isFinite(played) || played <= 0) return null;
    const clubPlayed = Number(clubGamesPlayed);
    if (!Number.isFinite(clubPlayed) || clubPlayed <= 0) return null;
    const games = Number(gamesRemaining);
    if (!Number.isFinite(games) || games < 0) return null;
    return { count: (played / clubPlayed) * games, unit: 'games' };
}

/**
 * What a player is still expected to produce over the window: production per appearance so far,
 * times the appearances expected, in the same unit. It is derived for every player and not read
 * from ESPN's rest-of-season line, which for some players is a full-season projection that was
 * never refreshed, with no flag to tell them apart.
 *
 * A rate carries through unmultiplied. The method prices a player on what the player has done, so
 * an early absence reads as a lasting rate.
 *
 * @param {{seasonTotals: Object<string, number>}} player The player.
 * @param {RemainderOptions} [opts] The window, the club's games and the rate ids.
 * @returns {?Object<string, number>} The line by stat id. Null for a player with no games, since no rate has been realized.
 */
export function remainderLine(player, opts = {}) {
    const { gamesId, rateIds } = opts;
    const actual = (player && player.seasonTotals) || null;
    if (!actual || gamesId === null || gamesId === undefined) return null;
    const played = Number(actual[gamesId]);
    // A line needs a denominator. A player with no games has produced nothing to scale, so the line is null and not zero.
    if (!Number.isFinite(played) || played <= 0) return null;
    const expected = expectedAppearances(player, opts);
    if (!expected) return null;
    const rates = rateIds || new Set();
    const out = {};
    Object.keys(actual).forEach(id => {
        const raw = actual[id];
        if (raw === null || raw === undefined) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        out[id] = rates.has(String(id)) ? n : (n / played) * expected.count;
    });
    return out;
}

/**
 * A board row's displayed cells as a stat line, for projectedTeamSums. For a two-way player the
 * cells and the row's totals differ: the totals hold one group's line and the cells merge the
 * groups. The cells are what the board shows and what its value is built from.
 *
 * @param {{cells: Array<{value: number}>}} row A board row.
 * @param {Array<string|number>} categoryIds The categories, in the cells' order.
 * @returns {Object<string, number>} The line by stat id.
 */
export function lineFromCells(row, categoryIds) {
    const out = {};
    (categoryIds || []).forEach((id, i) => {
        const cell = row && row.cells && row.cells[i];
        const v = cell && cell.value;
        if (Number.isFinite(v)) out[id] = v;
    });
    return out;
}

/**
 * Each team's projected value in every category, with rates recomputed from components and never
 * summed.
 *
 * @param {Object<string, Object<string, number>>} sumsByTeam The sums from projectedTeamSums.
 * @param {Array<string|number>} categoryIds The scored categories.
 * @param {object[]} components The sport's rate rules.
 * @returns {Object<string, Object<string, ?number>>} The values by team and category.
 */
export function projectedValues(sumsByTeam, categoryIds, components) {
    const out = {};
    Object.keys(sumsByTeam || {}).forEach(teamId => {
        const row = {};
        (categoryIds || []).forEach(id => { row[id] = valueFrom(sumsByTeam[teamId], id, components); });
        out[teamId] = row;
    });
    return out;
}

/**
 * Projected roto standings, scored by the league's own roto scorer, which is passed in. It owns
 * how level teams split points and where a team with no figure sits.
 *
 * @param {Object<string, Object<string, ?number>>} valuesByTeam The values from projectedValues.
 * @param {Array<{id: (string|number), inverse: boolean}>} categories The scored categories.
 * @param {function(Array<{id: string, value: ?number}>, boolean): Map<string, number>} scoreCategory Roto points for one category; rank-engine.js's rotoPointsForCategory.
 * @returns {Array<{teamId: string, points: number, byCategory: Object<string, number>}>} The teams in standing order, each with its points per category.
 */
export function projectedRotoStandings(valuesByTeam, categories, scoreCategory) {
    const teamIds = Object.keys(valuesByTeam || {});
    const points = new Map(teamIds.map(t => [t, 0]));
    const byCategory = new Map(teamIds.map(t => [t, {}]));

    (categories || []).forEach(cat => {
        const entries = teamIds.map(t => ({ id: t, value: (valuesByTeam[t] || {})[cat.id] }));
        scoreCategory(entries, cat.inverse).forEach((pts, id) => {
            points.set(id, points.get(id) + pts);
            byCategory.get(id)[cat.id] = pts;
        });
    });

    return teamIds
        .map(id => ({ teamId: id, points: points.get(id), byCategory: byCategory.get(id) }))
        .sort((a, b) => b.points - a.points || String(a.teamId).localeCompare(String(b.teamId)));
}

/**
 * Projected points standings: each roster's projected totals, summed. In a points league the
 * projection is the standing.
 *
 * @param {Object<string, object[]>} rostersByTeam Each team's players.
 * @param {function(object): number} [totalOf] A player's projected points. Defaults to the player's projected applied total.
 * @returns {Array<{teamId: string, points: number}>} The teams in standing order.
 */
export function projectedPointsStandings(rostersByTeam, totalOf) {
    const read = totalOf || ((p) => Number(p && p.projectedAppliedTotal) || 0);
    return Object.keys(rostersByTeam || {})
        .map(teamId => ({
            teamId,
            points: (rostersByTeam[teamId] || []).reduce((sum, p) => {
                const v = Number(read(p));
                return Number.isFinite(v) ? sum + v : sum;
            }, 0)
        }))
        .sort((a, b) => b.points - a.points || String(a.teamId).localeCompare(String(b.teamId)));
}

/**
 * Where one team sits in a standing. Level teams share a place.
 *
 * @param {Array<{teamId: *, points: number}>} standings The standing, in order.
 * @param {number|string} teamId The team.
 * @returns {?{place: number, of: number, points: number}} The place from one, or null when the team is not in the standing.
 */
export function placeOf(standings, teamId) {
    const rows = standings || [];
    const at = rows.findIndex(r => String(r.teamId) === String(teamId));
    if (at === -1) return null;
    let place = 1;
    for (let i = 0; i < at; i++) {
        if (rows[i].points !== rows[at].points) place += 1;
    }
    return { place, of: rows.length, points: rows[at].points };
}
