// Unit tests for the pure projection-pacing model (projection-pacing.js). Open tests/projection-pacing.test.html through any static server; green means every assertion held. Every expected value is hand-computed from tests/fixtures/projection-pacing.md, never taken from running the code. The arithmetic is written out beside each case, so a failure says which step moved.
import { projectionPacing } from '../src/engines/projection-pacing.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
function assertClose(actual, expected, msg, tol = 1e-9) {
    if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

/**
 * The standing fixture. Baseball ids: 81 games, 5 HR, 20 R, 24 CS (inverse), 2 AVG (rate).
 *
 * 40 games played, and 100 games remaining in ESPN's own forecast, since projectedTotals covers the
 * rest of the season and not the whole of it. The two spans are different sizes on purpose, so that
 * any code confusing them shows up.
 *   HR  24 actual / 40 = 0.6 per game;  40 projected / 100 remaining = 0.4 per game;  ratio 1.5
 *   R   40 actual / 40 = 1.0 per game; 100 projected / 100 remaining = 1.0 per game;  ratio 1.0
 * Round figures on purpose: nothing here lands on a .5 rounding boundary, so a change in the
 * rounding rule cannot pass for a change in the maths.
 */
const PLAYER = {
    seasonTotals: { '81': 40, '5': 24, '20': 40, '24': 9, '2': 0.311 },
    projectedTotals: { '81': 100, '5': 40, '20': 100, '24': 10, '2': 0.290 }
};
const BASE_CTX = {
    scoredIds: ['5', '20'],
    gamesId: '81',
    projectedGamesId: '81',
    rateIds: new Set(['2']),
    inverseIds: new Set(['24']),
    statLabels: { '5': 'HR', '20': 'R', '23': 'SB', '24': 'CS', '2': 'AVG' },
    seasonId: 2026
};
const ctx = (over = {}) => ({ ...BASE_CTX, ...over });

// ==== The two-category case, in both league types ====

test('two categories, roto league: equal weights, because roto pays one point per category', () => {
    // With no points-league flag this is a category league. The shares are equal at 0.5 each, and the headline is the median of the ratios, which with two of them is their mean: median(1.5, 1.0) = 1.25, so pct = 25.
    const out = projectionPacing(PLAYER, ctx());
    assertEq(out.pct, 25, 'a quarter above the projected rate');
    assertEq(out.dir, 'over', 'and the word agrees with the sign');
    assertEq(out.components.map(c => c.weight), [0.5, 0.5], 'equal shares');
    assertEq(out.components.map(c => c.label), ['HR', 'R'], 'labels pre-formatted here, not by the renderer');
    assertClose(out.components[0].ratio, 1.5, 'HR paces half again over');
    assertClose(out.components[1].ratio, 1.0, 'R paces exactly at the projection');
});

test('two categories, points league: weighted by share of projected fantasy points', () => {
    // weights HR 4, R 1: scale HR = |4 * 40| = 160; scale R = |1 * 100| = 100; total 260 share HR = 160/260 = 0.6153846...; share R = 100/260 = 0.3846153... mean = 1.5 * (160/260) + 1.0 * (100/260) = (240 + 100) / 260 = 340/260 = 1.3076923... pct = round(30.769...) = 31
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 4, '20': 1 } }));
    assertEq(out.pct, 31, 'the heavier category pulls the headline toward its own ratio');
    assertClose(out.components[0].weight, 160 / 260, 'HR carries the larger share of projected points');
    assertClose(out.components[1].weight, 100 / 260, 'R the smaller');
    assertClose(out.components[0].weight + out.components[1].weight, 1, 'shares sum to 1');
});

test('the points weighting is what the roto weighting is not - the same player, two answers', () => {
    // The one assertion that pins WHY the rule is split: identical input, different league type.
    const roto = projectionPacing(PLAYER, ctx());
    const points = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 4, '20': 1 } }));
    assertEq([roto.pct, points.pct], [25, 31], 'equal shares against points shares');
});

test('a CATEGORY league ignores weights even when ESPN supplies them', () => {
    // The trap the generated fixture caught: full-mlb is a category league whose scoringItems still carry point values, so "weights present means points league" would put every category league on the wrong path. The flag decides, not the presence of the field.
    const withWeights = projectionPacing(PLAYER, ctx({ weights: { '5': 4, '20': 1 } }));
    assertEq(withWeights.pct, 25, 'the roto answer, because the league is not a points league');
    assertEq(withWeights.components.map(c => c.weight), [0.5, 0.5], 'weights on the payload change nothing');
});

test('a points league missing a weight for a scored category falls back to equal', () => {
    // Weighting the rest as though the unweighted category were absent would quietly drop it from the headline. Equal is the honest answer when the league's own table is incomplete.
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 4 } }));
    assertEq(out.components.map(c => c.weight), [0.5, 0.5], 'no partial weighting');
    assertEq(out.pct, 25, 'and the headline is the equal-weighted one');
});

test('a negative scoring weight still carries weight, since its sign is not its importance', () => {
    // |-4 * 40| = 160, exactly as +4 would: a league paying -4 for a category cares about it just as much. Whether it reads better low is the inverse set's question, not the weight's.
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': -4, '20': 1 } }));
    assertClose(out.components[0].weight, 160 / 260, 'the absolute weight decides the share');
    assertEq(out.pct, 31, 'and the headline is the same as the positive-weight league');
});

test('components come back heaviest first, and the headline figures read in that unit', () => {
    // R is weighted heavier here (|1 * 100| = 100 against |1 * 40| = 40), so R leads and the three track figures are R's: banked 40, expected from here 1.0/g * 100 = 100, season 40 + 100 = 140.
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 1, '20': 1 } }));
    assertEq(out.components[0].label, 'R', 'the heavier category leads the list');
    assertClose(out.actualToDate, 40, "banked, in the lead category's own unit");
    assertClose(out.projectedRest, 100, 'what ESPN expects over the remaining games');
    assertClose(out.projectedSeason, 140, 'banked plus expected is where the season ends');
});

test('the track figures are the lead component alone, never a sum across categories', () => {
    // HR leads under these weights: 24 banked, 0.4/g * 100 remaining = 40 expected, 64 season. A sum across HR and R would mix home runs with runs and have no unit at all.
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 4, '20': 1 } }));
    assertEq(out.components[0].label, 'HR', 'HR leads');
    assertClose(out.actualToDate, 24, 'HR banked, not HR + R');
    assertClose(out.projectedRest, 40, 'HR expected over the rest');
    assertClose(out.projectedSeason, 64, 'HR where the season ends');
});

test('the two spans never merge: season games are played plus remaining', () => {
    // The defect this guards: reading projectedGames as the SEASON length. It is the remainder, so the season span is the sum, and a model that confused them would report 100 here.
    const out = projectionPacing(PLAYER, ctx());
    assertEq(out.projectedSeasonGames, 140, '40 played plus 100 remaining');
    assertEq(out.projectedGames, 100, 'projectedGames is the REMAINDER, not the season');
});

test('no projectedToDate is emitted - the payload cannot support one', () => {
    // A rest-of-season projection says nothing about what should have happened already. Running the go-forward rate backwards would invent a forecast ESPN never made and print it as ESPN's.
    const out = projectionPacing(PLAYER, ctx());
    assert(!('projectedToDate' in out), 'the field is absent, not null - it is not a missing value');
    assert(!('projectedFull' in out), 'and nothing claims a full-season figure from a partial span');
});

test('games played and projected games travel with the answer', () => {
    const out = projectionPacing(PLAYER, ctx());
    assertEq([out.gamesPlayed, out.projectedGames], [40, 100], 'both denominators are visible');
    assertEq(out.projectedSeasonGames, 140, 'and the span they add up to');
    assertEq(out.sourceAsOf, 2026, "the season the projection belongs to, so 'preseason' is never implied");
});

// ==== The headline summary: median in a category league, weighted mean in a points league (contract amendment 1) ====

test('a category league takes the MEDIAN, so one thin category cannot carry the headline', () => {
    /**
     * Three categories, and the third is the thin one the rule exists for.
     *   HR   24 / 40 = 0.6/g  against 40 / 100 = 0.4/g   ratio 1.5
     *   R    40 / 40 = 1.0/g  against 100 / 100 = 1.0/g  ratio 1.0
     *   SB    6 / 40 = 0.15/g against 4 / 100 = 0.04/g   ratio 3.75   (a 4-SB projection, where one
     *                                                                 steal moves it enormously)
     * The mean would be (1.5 + 1.0 + 3.75) / 3 = 2.0833, pct 108, a headline set by the smallest
     * category in the line. The median is the middle ratio, 1.5, pct 50.
     */
    const player = {
        seasonTotals: { '81': 40, '5': 24, '20': 40, '23': 6 },
        projectedTotals: { '81': 100, '5': 40, '20': 100, '23': 4 }
    };
    const out = projectionPacing(player, ctx({ scoredIds: ['5', '20', '23'] }));
    assertEq(out.pct, 50, 'the middle ratio, not the mean the outlier would have set');
    assertEq(out.components.length, 3, 'and every category is still present');
    assertEq(out.components.map(c => c.weight), [1 / 3, 1 / 3, 1 / 3], 'equal worth is untouched');
});

test('the outlier survives in the components, so the renderer can show it', () => {
    // The median must not hide the thin category. It must stop it deciding the headline, and both are asserted.
    const player = {
        seasonTotals: { '81': 40, '5': 24, '20': 40, '23': 6 },
        projectedTotals: { '81': 100, '5': 40, '20': 100, '23': 4 }
    };
    const out = projectionPacing(player, ctx({ scoredIds: ['5', '20', '23'] }));
    const sb = out.components.find(c => c.label === 'SB');
    assertClose(sb.ratio, 3.75, 'the outlier keeps its own real ratio');
});

test('a points league takes the weighted MEAN, not the median', () => {
    // Same three categories, weights HR 4, R 1, SB 1: scale HR = |4 * 40| = 160; R = |1 * 100| = 100; SB = |1 * 4| = 4; total 264 mean = 1.5*(160/264) + 1.0*(100/264) + 3.75*(4/264) = (240 + 100 + 15) / 264 = 355/264 = 1.344696... -> pct 34 The median would have been 1.5 -> 50, so this pins that the two paths really differ.
    const player = {
        seasonTotals: { '81': 40, '5': 24, '20': 40, '23': 6 },
        projectedTotals: { '81': 100, '5': 40, '20': 100, '23': 4 }
    };
    const out = projectionPacing(player, ctx({
        scoredIds: ['5', '20', '23'], isPointsLeague: true, weights: { '5': 4, '20': 1, '23': 1 }
    }));
    assertEq(out.pct, 34, 'the points-weighted mean');
    // And the thin category barely moves it, because the league itself prices it low.
    assertClose(out.components.find(c => c.label === 'SB').weight, 4 / 264, 'SB carries almost no points');
});

test('an even number of categories medians the two middle ratios', () => {
    // The standing fixture: ratios 1.5 and 1.0, median (1.5 + 1.0) / 2 = 1.25 -> pct 25. With two categories the median and the mean agree, which is why the three-category case above is the one that proves the rule.
    const out = projectionPacing(PLAYER, ctx());
    assertEq(out.pct, 25, 'the mean of the two middle ratios');
});

test('a single category medians to itself', () => {
    const player = { seasonTotals: { '81': 40, '5': 24 }, projectedTotals: { '81': 100, '5': 40 } };
    const out = projectionPacing(player, ctx({ scoredIds: ['5'] }));
    assertEq(out.pct, 50, 'one ratio of 1.5 is its own median');
});

// ==== The exclusions ====

test('an inverse category is excluded, and excluding it changes the answer', () => {
    // CS is in scoredIds here AND in inverseIds. Were it counted, its ratio would be (9/40) / (10/100) = 0.225 / 0.1 = 2.25 - a player CAUGHT STEALING far more than projected would read as pacing WELL OVER, which is the exact wrong direction for the sentence.
    const out = projectionPacing(PLAYER, ctx({ scoredIds: ['5', '20', '24'] }));
    assertEq(out.components.map(c => c.label), ['HR', 'R'], 'CS never becomes a component');
    assertEq(out.pct, 25, 'and the headline is untouched by it');
});

test('a rate category is excluded - a rate is already normalised per opportunity', () => {
    // AVG's "ratio" would be (0.311/40) / (0.290/100) = 0.007775 / 0.0029 = 2.68, which is not a fact about anything: dividing an average by games measures nothing.
    const out = projectionPacing(PLAYER, ctx({ scoredIds: ['5', '20', '2'] }));
    assertEq(out.components.map(c => c.label), ['HR', 'R'], 'AVG never becomes a component');
    assertEq(out.pct, 25, 'the headline is unchanged');
});

test('an unprojected or zero-projected category is skipped, not scored zero', () => {
    // Id 7 has an actual figure and no projection, and id 8 is projected at zero. Scoring either as 0 would let an absent figure flatter the player.
    const player = {
        seasonTotals: { ...PLAYER.seasonTotals, '7': 30, '8': 5 },
        projectedTotals: { ...PLAYER.projectedTotals, '8': 0 }
    };
    const out = projectionPacing(player, ctx({ scoredIds: ['5', '20', '7', '8'] }));
    assertEq(out.components.map(c => c.label), ['HR', 'R'], 'neither reaches the components');
    assertEq(out.pct, 25, 'and the player still gets an answer from what remains');
});

// ==== The five refusals: null, never a zeroed shape ====

test('refusal 1: no projection at all answers null', () => {
    assertEq(projectionPacing({ seasonTotals: { '81': 40 }, projectedTotals: {} }, ctx()), null, 'empty projection');
    assertEq(projectionPacing({ seasonTotals: { '81': 40 } }, ctx()), null, 'no projection field at all');
    assertEq(projectionPacing(null, ctx()), null, 'no player, no crash');
});

test('refusal 2: under the 20-game floor answers null, and 20 itself does not', () => {
    const at19 = { ...PLAYER, seasonTotals: { ...PLAYER.seasonTotals, '81': 19 } };
    const at20 = { ...PLAYER, seasonTotals: { ...PLAYER.seasonTotals, '81': 20 } };
    assertEq(projectionPacing(at19, ctx()), null, 'nineteen games is noise wearing a percentage sign');
    assert(projectionPacing(at20, ctx()) !== null, 'the floor is 20 and it is inclusive');
});

test('refusal 3: no projected games answers null, because per-game needs a denominator', () => {
    const noProjGames = { ...PLAYER, projectedTotals: { ...PLAYER.projectedTotals, '81': 0 } };
    assertEq(projectionPacing(noProjGames, ctx()), null, 'a projection without games cannot supply a rate');
});

test('refusal 4: a line with no eligible category answers null, not an empty shape', () => {
    // Every scored category is a rate. Nothing paces, so there is nothing to say.
    assertEq(projectionPacing(PLAYER, ctx({ scoredIds: ['2'] })), null, 'rate-only line');
    assertEq(projectionPacing(PLAYER, ctx({ scoredIds: [] })), null, 'no scored categories at all');
});

test('refusal 5: football answers null, because the sport has no games-played statistic', () => {
    // GAMES_PLAYED_IDS holds flb and fhl only (measured, rank-engine.js), so a football ctx carries gamesId null. The surface can never render in football, and that is stated rather than discovered.
    assertEq(projectionPacing(PLAYER, ctx({ gamesId: null })), null, 'null games id');
    assertEq(projectionPacing(PLAYER, ctx({ gamesId: undefined })), null, 'absent games id');
});

// ==== The word and the number cannot disagree ====

test('a player exactly on the projection reads even, not over by nothing', () => {
    // Both categories at ratio 1.0: 20 HR / 40 games = 0.5, against 50 / 100 = 0.5.
    const onPace = {
        seasonTotals: { '81': 40, '5': 20, '20': 40 },
        projectedTotals: { '81': 100, '5': 50, '20': 100 }
    };
    const out = projectionPacing(onPace, ctx());
    assertEq([out.pct, out.dir], [0, 'even'], 'zero is even, and never "over 0%"');
});

test('under the projection reads under', () => {
    // 10 HR / 40 = 0.25 against 0.5 projected -> ratio 0.5; R at 1.0. mean 0.75 -> pct -25.
    const cold = {
        seasonTotals: { '81': 40, '5': 10, '20': 40 },
        projectedTotals: { '81': 100, '5': 50, '20': 100 }
    };
    const out = projectionPacing(cold, ctx());
    assertEq([out.pct, out.dir], [-25, 'under'], 'the sign is kept on pct and spelled in dir');
});

test('dir is derived from the ROUNDED pct, so the word can never contradict the figure', () => {
    // A mean of 1.004 rounds to 0. Were dir taken from the raw mean it would say "over" beside a figure reading 0 - the one disagreement this shape must not allow. HR: 40 games, 20.08 actual -> 0.502/g against 0.5/g projected = ratio 1.004; R exactly 1.0. mean = (1.004 + 1.0) / 2 = 1.002 -> pct = round(0.2) = 0.
    const barely = {
        seasonTotals: { '81': 40, '5': 20.08, '20': 40 },
        projectedTotals: { '81': 100, '5': 50, '20': 100 }
    };
    const out = projectionPacing(barely, ctx());
    assertEq(out.pct, 0, 'rounds to nothing');
    assertEq(out.dir, 'even', 'and says so, rather than "over"');
});

// ==== Invariants the contract promises the renderer ====

test('the contract invariants hold on every non-null answer', () => {
    const out = projectionPacing(PLAYER, ctx({ isPointsLeague: true, weights: { '5': 4, '20': 1 } }));
    const sum = out.components.reduce((t, c) => t + c.weight, 0);
    assertClose(sum, 1, 'weights sum to 1');
    out.components.forEach(c => assertClose(c.ratio, c.actualPerGame / c.projPerGame, `ratio is the quotient for ${c.label}`));
    for (let i = 1; i < out.components.length; i++) {
        assert(out.components[i - 1].weight >= out.components[i].weight, 'sorted by weight, descending');
    }
    assert(out.components.length > 0, 'a non-null answer always carries components');
});

test('the model answers inside the 10% band - the suppression is the renderer\'s', () => {
    // A small lean is still answered, so a page can decide whether to show it. HR 22 / 40 = 0.55 against 0.5, ratio 1.1; R 1.0; mean 1.05, pct 5. With 21 HR the mean would be 1.025, and (1.025 - 1) * 100 is 2.4999999999999996 in floating point, which rounds down to 2. Asserting that would pin an artefact of floating point, so the case sits off the boundary.
    const small = {
        seasonTotals: { '81': 40, '5': 22, '20': 40 },
        projectedTotals: { '81': 100, '5': 50, '20': 100 }
    };
    const out = projectionPacing(small, ctx());
    assertEq(out.pct, 5, 'a five percent swing is still an answer');
    assert(out !== null, 'the model does not apply the old 10% floor');
});

test('projectedGamesId can differ from gamesId without the two denominators crossing', () => {
    // A sport reporting projected games under a different id must not fall back to games PLAYED - that would make every player pace at exactly 100% by sharing a denominator.
    const player = {
        seasonTotals: { '81': 40, '5': 24 },
        projectedTotals: { '99': 100, '5': 40 }
    };
    const out = projectionPacing(player, ctx({ scoredIds: ['5'], projectedGamesId: '99' }));
    assertEq(out.projectedGames, 100, 'the projected denominator comes from its own id');
    assertEq(out.pct, 50, '0.6/g against 0.4/g is half again over, not level');
});

// The span comes from the schedule. Measured on a live baseball league at scoring period 164 of 187: a free agent's projection was a full-season line never refreshed, which made the season read as 287 games.

const STALE = {
    name: 'the unrefreshed free agent',
    // 20 home runs in 131 games played; ESPN still forecasts 29 more over 156 games.
    seasonTotals: { '5': 20, '81': 131 },
    projectedTotals: { '5': 29, '81': 156 }
};
const FRESH = {
    name: 'a batter ESPN is keeping current',
    seasonTotals: { '5': 37, '81': 140 },
    projectedTotals: { '5': 6, '81': 22 }
};
const STARTER = {
    name: 'a starting pitcher',
    // 159 strikeouts in 22 appearances; ESPN forecasts 29 more over 4 starts.
    seasonTotals: { '48': 159, '32': 22 },
    projectedTotals: { '48': 29, '32': 4 }
};
const SPAN_CTX = (gamesId, ids, gamesRemaining) => ({
    scoredIds: ids, gamesId, rateIds: new Set(), inverseIds: new Set(),
    isPointsLeague: false, weights: null, statLabels: {}, seasonId: 2026,
    ...(gamesRemaining === undefined ? {} : { gamesRemaining })
});

test('the 287-game season is gone: the span is the schedule, not ESPN count', () => {
    // 131 played of his club's 141, over 21 left, is 19.5 appearances.
    const p = projectionPacing(STALE, SPAN_CTX('81', ['5'], 19.5));
    assertClose(p.projectedGames, 19.5, 'the span is what the schedule allows', 0.01);
    assertClose(p.projectedSeasonGames, 150.5, 'a season that can actually happen', 0.01);
    assertEq(p.espnProjectedGames, 156, "ESPN's own count is kept, as provenance");
});

test('and the 29 home runs still to come become 3.6', () => {
    // ESPN's rate is unchanged, 29 over 156 games, and only the span it is applied over moves.
    const p = projectionPacing(STALE, SPAN_CTX('81', ['5'], 19.5));
    assertClose(p.projectedRest, 3.6, 'three weeks of home runs, not a season', 0.05);
    assertClose(p.projectedSeason, 23.6, 'banked 20 plus what is left', 0.05);
});

test('pct does NOT move, because neither rate changed', () => {
    // The whole point of keeping ESPN's count as the denominator: pacing is a rate against a rate, and deriving ESPN's side from the player's own record would make every player pace at 100%.
    const before = projectionPacing(STALE, SPAN_CTX('81', ['5'], undefined));
    const after = projectionPacing(STALE, SPAN_CTX('81', ['5'], 19.5));
    assertEq(after.pct, before.pct, 'the comparison is untouched');
    assertClose(after.components[0].projPerGame, 29 / 156, "ESPN's per-game rate stands", 0.0001);
});

test('a player ESPN is keeping current barely moves', () => {
    // 140 of his club's 142, over 21 left, is 20.7 against ESPN's 22 - the amendment is a correction for the stale minority, not a re-forecast of everybody.
    const p = projectionPacing(FRESH, SPAN_CTX('81', ['5'], 20.7));
    assertClose(p.projectedRest, 5.6, 'against ESPN own 6', 0.05);
    assertClose(p.projectedSeasonGames, 160.7, 'a full season, near enough', 0.05);
});

test('A STARTING PITCHER KEEPS HIS PER-START RATE over his own appearances', () => {
    // 22 appearances in the club's 141 games is 3.4 over the next 22, not 22. A rate per start times the club's games would be 159 strikeouts in three weeks, a whole season.
    const p = projectionPacing(STARTER, SPAN_CTX('32', ['48'], 3.4));
    assertClose(p.components[0].projPerGame, 29 / 4, 'ESPN per START, unchanged', 0.0001);
    assertClose(p.projectedRest, 24.7, 'three weeks of a starter', 0.1);
    assertClose(p.projectedSeasonGames, 25.4, 'a starter season is counted in starts', 0.05);
    assert(p.projectedRest < 40, 'nothing near a season total survives this window');
});

test('omitting gamesRemaining is the behaviour before the amendment', () => {
    // A caller with no pro schedule loaded gets ESPN's count as the span, which is right for every player whose line ESPN keeps current, and not a blank card.
    const p = projectionPacing(FRESH, SPAN_CTX('81', ['5'], undefined));
    assertEq(p.projectedGames, 22, "ESPN own count stands in");
    assertEq(p.projectedGames, p.espnProjectedGames, 'and the two fields agree');
    assertClose(p.projectedSeasonGames, 162, 'exactly as before', 0.01);
});

test('a zero span is a real zero, and refusal 3 still keys on ESPN count', () => {
    // A club with nothing left expects nothing more; that is a figure, not a refusal. But a projection with no games of its own has no RATE, and that is still refusal 3.
    const none = projectionPacing(FRESH, SPAN_CTX('81', ['5'], 0));
    assertEq(none.projectedRest, 0, 'nothing left to play, nothing left to expect');
    assertClose(none.projectedSeason, 37, 'the season ends where it stands', 0.01);
    const noRate = projectionPacing({ seasonTotals: { '5': 37, '81': 140 }, projectedTotals: { '5': 6 } },
        SPAN_CTX('81', ['5'], 20.7));
    assertEq(noRate, null, 'no denominator for ESPN rate');
});

test('A FINISHED SEASON PROJECTS NOTHING: the banked figure IS the season', () => {
    // Measured on a hockey season that had ended: ESPN never retires the projection, so its lines still carried 77 to 82 projected games beside 82 played. A finished season passes 0 games remaining, and the shape below is what 0 produces. The line used is one skater's from that season: 48 goals in 82 games, with 37 projected over 77.
    const mcdavid = { seasonTotals: { '13': 48, '30': 82 }, projectedTotals: { '13': 37, '30': 77 } };
    const done = projectionPacing(mcdavid, SPAN_CTX('30', ['13'], 0));
    assertEq(done.projectedGames, 0, 'no games left in a season that is over');
    assertEq(done.projectedRest, 0, 'so nothing is still to come');
    assertClose(done.actualToDate, 48, 'the banked goals', 0.01);
    assertClose(done.projectedSeason, 48, 'and the season total is exactly what was banked', 0.01);
    assertEq(done.projectedSeasonGames, 82, 'the games he actually played, not 159');
    assertEq(done.espnProjectedGames, 77, "ESPN's own count survives as the rate's denominator");
    // The pacing sentence still means something once the season is over: it is the rate ESPN expected per game against the rate he managed, which is a fair retrospective.
    assertEq(done.pct, 22, '0.5854 a game against ESPN 0.4805 is 22% over');
    // The defect, pinned: the same player with ESPN's count as the span invents another season.
    const stale = projectionPacing(mcdavid, SPAN_CTX('30', ['13'], undefined));
    assertClose(stale.projectedSeason, 85, 'what the card printed before - 48 banked plus 37 more', 0.5);
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
document.getElementById('summary').textContent = `${passed}/${results.length} passed${failed ? `: ${failed} FAILED` : ' ✓'}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` - ${r.err}`}</div>`)
    .join('');
window.__TEST_RESULTS = { passed, failed, total: results.length, failures: results.filter(r => !r.ok) };
