/**
 * Pacing: how a player's real production per game compares with the rate ESPN's own projection
 * implies.
 *
 * ESPN's projected totals are for the rest of the season, not the whole of it. They equal a full
 * season only before anyone has played. So the comparison is a rate against a rate: what the
 * player has done per game against what ESPN expects per game from here. Whether a player is
 * beating a preseason forecast is a different question, which this data cannot answer once a
 * season is under way.
 *
 * The ratio is taken per category and then combined, since a season total hides a hot stretch and
 * a cold one that cancel.
 *
 * Pure. No DOM, no application state and no network; every table arrives in the context.
 *
 * Contract: tests/fixtures/projection-pacing.md
 * Tests: tests/projection-pacing.test.html
 * @module projection-pacing
 */

// A ratio needs a figure on both sides, so a category ESPN did not forecast is skipped, not scored as zero.
function eligibleComponents(player, ctx) {
    const rateIds = ctx.rateIds || new Set();
    const inverseIds = ctx.inverseIds || new Set();
    const projected = player.projectedTotals || {};
    const actual = player.seasonTotals || {};
    const out = [];
    (ctx.scoredIds || []).forEach(id => {
        // A rate is already per opportunity, so dividing it by games again measures nothing. A lower-is-better category paces the wrong way for the sentence. Both are left out, not averaged in.
        if (rateIds.has(id)) return;
        if (inverseIds.has(id)) return;
        const projVal = projected[id];
        if (projVal === null || projVal === undefined || projVal === 0) return;
        const actualVal = actual[id];
        if (actualVal === null || actualVal === undefined) return;
        out.push({ id, projVal, actualVal });
    });
    return out;
}

// Each category is worth what the league says it is worth. A points league pays a stated number of points per event, so a category's weight is its share of the player's projected points. A category league pays the same for every category, so the weights are equal. Which kind of league it is comes from the context's flag, never from whether weights exist, since a category league carries point values too.
function weightsFor(components, weights, isPointsLeague) {
    const equal = () => components.map(() => 1 / components.length);
    if (!isPointsLeague) return equal();
    const scale = components.map(c => {
        const w = weights && weights[c.id];
        // The absolute value: a negative weight still carries real weight in the total.
        return w === null || w === undefined ? null : Math.abs(Number(w) * c.projVal);
    });
    // A points league missing a weight for one of its own scored categories falls back to equal weights.
    const usable = scale.every(v => v !== null) && scale.some(v => v > 0);
    return usable ? scale.map(v => v / scale.reduce((sum, x) => sum + x, 0)) : equal();
}

// The middle ratio, or the mean of the two middle ones for an even count, sorted here by value.
function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How one player is pacing against ESPN's projection: over or under, by what percentage, and the
 * rate in every category that could be compared.
 *
 * Rates and lower-is-better categories are left out. The headline is the points-weighted mean in
 * a points league and the median in a category league.
 *
 * @param {{seasonTotals: Object<string, number>, projectedTotals: Object<string, number>}} player The player, with the season so far and ESPN's projection.
 * @param {object} [ctx]
 * @param {Array<string>} ctx.scoredIds The scored categories.
 * @param {string|number} ctx.gamesId The stat id that counts games.
 * @param {string|number} [ctx.projectedGamesId] The stat id for projected games, when it differs.
 * @param {Set<string>} [ctx.rateIds] The categories that are rates.
 * @param {Set<string>} [ctx.inverseIds] The categories where lower is better.
 * @param {boolean} [ctx.isPointsLeague] Whether the league scores points.
 * @param {Object<string, number>} [ctx.weights] Points per unit by stat id, for a points league.
 * @param {Object<string, string>} [ctx.statLabels] Labels by stat id.
 * @param {number} [ctx.gamesRemaining] How many games the player is expected to appear in from here.
 * @param {number} [ctx.seasonId] The season the figures are from.
 * @returns {?{pct: number, dir: ('over'|'under'|'even'), gamesPlayed: number, projectedGames: number, espnProjectedGames: number, projectedSeasonGames: number, actualToDate: number, projectedRest: number, projectedSeason: number, components: Array<{id: string, label: string, actualPerGame: number, projPerGame: number, ratio: number, weight: number}>, sourceAsOf: ?number}}
 *   Null when nothing can be said: no projection, no games stat, fewer than 20 games, no projected
 *   games, or no category left to compare.
 */
export function projectionPacing(player, ctx = {}) {
    if (!player) return null;
    const projected = player.projectedTotals;
    // Refusal 1: nothing to pace against.
    if (!projected || !Object.keys(projected).length) return null;

    // Refusal 5: a sport with no games-played stat. Football has none, so this never answers for football.
    const gamesId = ctx.gamesId;
    if (gamesId === null || gamesId === undefined) return null;

    const gamesPlayed = Number((player.seasonTotals || {})[gamesId]) || 0;
    // Refusal 2: fewer than 20 games. A rate over a handful of games is noise.
    if (gamesPlayed < 20) return null;

    // ESPN's own count of projected games is the denominator of the projected rate and nothing else. It is not a reliable span, since for some players ESPN leaves a full-season projection in place and never refreshes it.
    const espnProjectedGames = Number(projected[ctx.projectedGamesId ?? gamesId]) || 0;
    // Refusal 3: the projection needs a denominator of its own. Dividing it by games played would make every player pace at exactly even.
    if (!espnProjectedGames) return null;

    // The span comes from the schedule: how many games the player is expected to appear in from here, as the caller works it out. Without it the span falls back to ESPN's own count.
    const remaining = Number(ctx.gamesRemaining);
    const projectedGames = Number.isFinite(remaining) && remaining >= 0 ? remaining : espnProjectedGames;

    const eligible = eligibleComponents(player, ctx);
    // Refusal 4: every scored category was excluded, so nothing paces.
    if (!eligible.length) return null;

    const shares = weightsFor(eligible, ctx.weights, !!ctx.isPointsLeague);
    const labels = ctx.statLabels || {};
    const components = eligible.map((c, i) => {
        const actualPerGame = c.actualVal / gamesPlayed;
        const projPerGame = c.projVal / espnProjectedGames;
        return {
            id: c.id,
            label: labels[c.id] || String(c.id),
            actualPerGame,
            projPerGame,
            ratio: actualPerGame / projPerGame,
            weight: shares[i]
        };
    // Heaviest first, since the headline figures are read in the top component's units.
    }).sort((a, b) => b.weight - a.weight);

    // The headline follows the league's own arithmetic. A points league sums points, so the headline is the mean weighted by points. A category league pays each category the same, so the headline is the median, which counts every category equally and lets no thin category carry the figure. The components still carry every ratio.
    const headlineRatio = ctx.isPointsLeague
        ? components.reduce((sum, c) => sum + c.ratio * c.weight, 0)
        : medianOf(components.map(c => c.ratio));
    // A whole number, since a projection is a round guess. The direction is taken from the rounded figure, so the word and the number cannot disagree at the boundary.
    const pct = Math.round((headlineRatio - 1) * 100);

    // The figures are in the units of the heaviest component, not a sum across categories. There is no figure for what a player should have done by now, since a rest-of-season projection cannot say. What the data supports is where the season ends: what is banked plus what is expected.
    const lead = components[0];
    const actualToDate = lead.actualPerGame * gamesPlayed;
    const projectedRest = lead.projPerGame * projectedGames;

    return {
        pct,
        dir: pct === 0 ? 'even' : (pct > 0 ? 'over' : 'under'),
        gamesPlayed,
        projectedGames,
        // ESPN's own forecast count, kept as the source of every projected rate above.
        espnProjectedGames,
        projectedSeasonGames: gamesPlayed + projectedGames,
        actualToDate,
        projectedRest,
        projectedSeason: actualToDate + projectedRest,
        components,
        sourceAsOf: ctx.seasonId ?? null
    };
}
