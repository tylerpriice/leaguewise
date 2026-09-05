// PURE. Projection-vs-actual PACING: how a player's real per-game production compares with the rate ESPN's own season projection implies. No DOM, no AppState, no fetches - every table arrives in ctx, the rule rank-engine.js, preseason-face.js and coverage-model.js follow. The frozen shape and the reasoning behind every refusal live in tests/fixtures/projection-pacing.md; this file implements that contract and nothing else. THE PROJECTION IS THE REST OF THE SEASON, NOT THE WHOLE OF IT - measured, and it is the fact this whole module turns on. projectedTotals is statSourceId 1, statSplitTypeId 0, the league's own season, refetched every session; on the live 2026 baseball capture at scoring period 162, EVERY player carries 20-25 projected games beside 89-140 played, and played + projected lands near a full season. It is what ESPN expects from here, which equals a full season only before anyone has played - which is why the same field looks like a full-season line on a preseason football capture and like three weeks of baseball in September. The shipped surface called it "their preseason projection" and compared it to season-to-date totals as though the two were the same span. They are not the same span in either direction: the projection has absorbed the production already banked, and its denominator is the games REMAINING. So the comparison here is deliberately a RATE against a RATE - what a player has actually done per game against what ESPN expects per game from here. That is a real question ("is ESPN pricing in regression?") and it is not the same question as "is this beating the preseason forecast", which this data cannot answer at all once a season is under way. The field names say which span each figure belongs to, because a figure whose span is ambiguous is how the original defect was written in the first place. PER-CATEGORY RATIOS, NOT ONE SEASON-TOTAL RATIO. A hot two months and a cold two months average to the same total a steady pace would, and "pacing" means the rate, not the sum.

// A ratio needs a denominator on both sides, so a category ESPN did not forecast is SKIPPED rather than scored zero. That is the roto trap rank-engine.js names from the other direction: an absent figure treated as 0 ranks a player first for having no data.
function eligibleComponents(player, ctx) {
    const rateIds = ctx.rateIds || new Set();
    const inverseIds = ctx.inverseIds || new Set();
    const projected = player.projectedTotals || {};
    const actual = player.seasonTotals || {};
    const out = [];
    (ctx.scoredIds || []).forEach(id => {
        // A rate is already normalised per opportunity; dividing it by games again measures nothing. An inverse category paces the wrong way for the sentence - being UNDER a caught-stealing projection is good. Both are excluded rather than diluted into the mean.
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

// EACH CATEGORY IS WORTH WHAT THAT LEAGUE SAYS IT IS WORTH - one principle, two expressions, because the two league types define worth differently. A POINTS league pays a stated number of points per event, so |projected total x that weight| is the category's share of the player's projected VALUE, and points are the only common unit across categories - the one thing that makes home runs and strikeouts comparable at all. A CATEGORY league gets EQUAL weighting, which is not a fallback and not the old defect: roto pays exactly one point per category whatever its scale, so a 2-HR category and a 200-SO category genuinely are worth the same. Weighting by volume there would overrule the league's own scoring with an opinion about which categories matter. The shipped code used an unweighted mean in BOTH, which is right for roto and wrong for points; this fixes that half. WHICH LEAGUE IT IS COMES FROM ctx.isPointsLeague, NEVER FROM WHETHER WEIGHTS EXIST. That shortcut was in the first draft of this module and the generated fixture caught it: full-mlb is a CATEGORY league and its scoringItems still carry point values, so "no weights means roto" would have put every category league on the points path. data.js decides the question once, from scoringSettings.scoringType === 'H2H_POINTS', and this module reads that answer rather than re-deriving one from a field that is populated either way.
function weightsFor(components, weights, isPointsLeague) {
    const equal = () => components.map(() => 1 / components.length);
    if (!isPointsLeague) return equal();
    const scale = components.map(c => {
        const w = weights && weights[c.id];
        // Absolute value: a NEGATIVE weight (an interception, a missed field goal) still carries real weight in the total. Its sign says the category is bad to accumulate, which the inverse exclusion has already dealt with - it does not say the category is unimportant.
        return w === null || w === undefined ? null : Math.abs(Number(w) * c.projVal);
    });
    // A points league missing a weight for one of its own scored categories is not a league type this can guess at, so it falls back to equal rather than silently weighting the rest as if the unweighted category did not exist.
    const usable = scale.every(v => v !== null) && scale.some(v => v > 0);
    return usable ? scale.map(v => v / scale.reduce((sum, x) => sum + x, 0)) : equal();
}

// The middle ratio, or the mean of the two middle ones for an even count. Sorted numerically here rather than relying on the component order, which is by WEIGHT and says nothing about ratio.
function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function projectionPacing(player, ctx = {}) {
    if (!player) return null;
    const projected = player.projectedTotals;
    // Refusal 1: nothing to pace against.
    if (!projected || !Object.keys(projected).length) return null;

    // Refusal 5: FOOTBALL, which carries no games-played statistic at all (measured - GAMES_PLAYED_IDS in rank-engine.js holds flb and fhl only). It is refusal 3's missing denominator applying to a whole sport, and it means this surface can never render in football. Named here so it stops being rediscovered as a bug.
    const gamesId = ctx.gamesId;
    if (gamesId === null || gamesId === undefined) return null;

    const gamesPlayed = Number((player.seasonTotals || {})[gamesId]) || 0;
    // Refusal 2: the games floor, kept at the 20 players.js has always used rather than re-guessed. A rate over a handful of games is noise wearing a percentage sign.
    if (gamesPlayed < 20) return null;

    // ESPN'S OWN COUNT IS THE RATE'S DENOMINATOR AND NOTHING ELSE NOW (contract amendment 2, R2 / O55c). It is what makes projPerGame ESPN's expectation per appearance, which is the question this module asks; it is NOT a trustworthy span, because ESPN stops refreshing the line for some players and leaves a preseason full-season one in place. Measured on a live 2026 baseball league at period 164 of 187: a free agent carried 156 projected games beside 131 played, so this surface said his season would run 287 games and that 29 home runs were still to come with three weeks left.
    const espnProjectedGames = Number(projected[ctx.projectedGamesId ?? gamesId]) || 0;
    // Refusal 3: per-game arithmetic needs a denominator on the projection's side too. Dividing the projection by games PLAYED instead would make every player pace at exactly 100%, since both sides would then share a denominator.
    if (!espnProjectedGames) return null;

    // THE SPAN COMES FROM THE SCHEDULE. `ctx.gamesRemaining` is how many games this player is expected to APPEAR in from here - projected-basis.js's expectedAppearances, the same figure the coverage band prices its remainder on, so the two surfaces cannot disagree about how much season is left. Appearances, never club games: multiplying a per-START rate by a club's remaining games is what printed a starter's whole season as three weeks. Absent, the span falls back to ESPN's own count, which is this module's behaviour before the amendment and stays right for every player whose line ESPN is keeping current. A caller with no pro schedule loaded gets the old figure rather than a blank chip.
    const remaining = Number(ctx.gamesRemaining);
    const projectedGames = Number.isFinite(remaining) && remaining >= 0 ? remaining : espnProjectedGames;

    const eligible = eligibleComponents(player, ctx);
    // Refusal 4: every scored category was excluded. A player whose whole line is rate stats has nothing that paces, and an empty component list is a refusal rather than a hollow shape.
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
    // Heaviest first, because the headline figures below are read in the top component's units and the renderer shows the list in the order it is given.
    }).sort((a, b) => b.weight - a.weight);

    // THE HEADLINE IS THE LEAGUE'S OWN ARITHMETIC (contract amendment 1). A POINTS league sums points, so the headline sums too: the points-weighted mean, each category pulling in proportion to the points it is projected to bring. A CATEGORY league pays one point per category whatever its scale, so no category may be down-weighted - but an equally-weighted MEAN lets a tiny category drag the sentence on its own (a 2-HR projection moves its ratio 50% on one home run, and that reaches the headline undiluted). The MEDIAN answers exactly that: every category still counts the same, and no single outlier can carry the number. It is the one summary that respects equal worth and resists a thin category at the same time, which is why the choice is not a weighting at all. components still carry every ratio either way, so the renderer's per-category rows show an outlier for what it is rather than hiding it behind the headline.
    const headlineRatio = ctx.isPointsLeague
        ? components.reduce((sum, c) => sum + c.ratio * c.weight, 0)
        : medianOf(components.map(c => c.ratio));
    // A whole number: a projection is a round guess, and "11.6% over" claims a precision nobody has (VOICE - no invented precision). dir is derived from the ROUNDED figure so the word and the number cannot disagree at the boundary.
    const pct = Math.round((headlineRatio - 1) * 100);

    // The track's figures, in the units of the heaviest component - the one category the headline most reflects. Not a sum across categories, which would have no unit at all. THE THREE SPANS ARE NAMED, and none of them is "projected to date". A rest-of-season projection cannot say what a player SHOULD have done by now - that number does not exist in this payload, and computing one by running the go-forward rate backwards over games already played would invent a forecast ESPN never made. What the data does support is where the season ENDS: banked plus expected.
    const lead = components[0];
    const actualToDate = lead.actualPerGame * gamesPlayed;
    const projectedRest = lead.projPerGame * projectedGames;

    return {
        pct,
        dir: pct === 0 ? 'even' : (pct > 0 ? 'over' : 'under'),
        gamesPlayed,
        projectedGames,
        // ESPN's own forecast count, kept because it is the provenance of every projPerGame above and the only way a reader of this shape can tell the two spans apart.
        espnProjectedGames,
        projectedSeasonGames: gamesPlayed + projectedGames,
        actualToDate,
        projectedRest,
        projectedSeason: actualToDate + projectedRest,
        components,
        sourceAsOf: ctx.seasonId ?? null
    };
}
