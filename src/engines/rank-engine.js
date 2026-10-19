/**
 * Every ranking and percentile computation in the extension, as pure functions.
 *
 * Pure. This module imports nothing and touches no application state, DOM or network. League sets,
 * playing-time measures and players arrive as arguments.
 *
 * Tests: tests/rank-engine.test.html
 * @module rank-engine
 */
/**
 * A player as this module reads one.
 *
 * @typedef {object} RankPlayer
 * @property {number|string} id The player's id.
 * @property {Object<string, number>} seasonTotals The player's totals by stat id, over whatever window
 *   the caller chose.
 */
/**
 * What a pool ranking needs to know about the league and the pool.
 *
 * @typedef {object} RotoContext
 * @property {string[]} relevantStatIds The scored stat ids for this pool's role.
 * @property {Set<string>} inverseStatIds The stat ids won by the lower figure.
 * @property {Set<string>} rateStatIds The stat ids that are rates. A missing rate stays absent, and a
 *   missing count is a zero.
 * @property {boolean} isRpPool Whether the pool is relief pitchers only.
 * @property {boolean} requireMinPlayingTime Whether the minimum games setting is on.
 * @property {function(RankPlayer): number} workloadOf The measure shrinkage scales by.
 * @property {function(RankPlayer): number} thresholdWorkloadOf The games measure the minimum is set on.
 * @property {string} sport The sport code.
 */
/**
 * One scored category's peer distribution, for scoring a week against.
 *
 * @typedef {object} CategoryBasis
 * @property {string} id The stat id.
 * @property {boolean} inverse Whether the lower figure wins.
 * @property {boolean} isRate Whether the category is a rate.
 * @property {?function(RankPlayer): number} opportunityOf The category's opportunity gate, if it has one.
 * @property {number} minOpportunity The chances a player needs to be scored in it.
 * @property {number[]} rates The peer values, ascending.
 */

// ==== Domain constants ====

/**
 * The stat id that counts games played, by sport and by role group. Football has no entry, since
 * its season line carries no games played figure.
 *
 * @type {Object<string, {primary: string, secondary: string}>}
 */
export const GAMES_PLAYED_IDS = {
    flb: { primary: "81", secondary: "32" },
    fhl: { primary: "30", secondary: "30" }
};

/**
 * The stat id that holds innings pitched, recorded as outs.
 *
 * @type {string}
 */
export const IP_STAT_ID = "34";

/**
 * A pitcher's innings pitched.
 *
 * @param {RankPlayer} p The player.
 * @returns {number} Outs divided by three, or 0 when the player has none.
 */
export function inningsPitchedOf(p) {
    const outs = p.seasonTotals[IP_STAT_ID];
    return outs === undefined ? 0 : outs / 3;
}

/**
 * The share of the pool leader's games a player needs to be ranked when the minimum games setting
 * is on.
 *
 * @type {number}
 */
export const MIN_PLAYING_TIME_FRACTION = 0.2;

/**
 * By sport, the categories a player must have had a real chance at before a low total counts
 * against the player, each with the function that measures that chance. A sport with no entry has
 * no such gates.
 *
 * @type {Object<string, Object<string, function(RankPlayer): number>>}
 */
export const CATEGORY_OPPORTUNITY = {
    flb: {
        "57": p => (p.seasonTotals["57"] || 0) + (p.seasonTotals["58"] || 0), // SV needs real save chances (SV+BS)
        "63": p => p.seasonTotals["33"] || 0 // QS needs real starts (GS)
    }
};

/**
 * By sport, the category compared as a rate per nine innings inside a relief pitcher pool.
 *
 * @type {Object<string, string>}
 */
export const RP_PER_NINE_ID = { flb: "48" };
/**
 * The share of the pool leader's chances a player needs in a gated category to be ranked in it.
 *
 * @type {number}
 */
export const MIN_OPPORTUNITY_FRACTION = 0.15;

/**
 * The opportunity gate for a category in this pool, if it has one.
 *
 * @param {string} id The stat id.
 * @param {boolean} isRpPool Whether the pool is relief pitchers only.
 * @param {string} sport The sport code.
 * @returns {(function(RankPlayer): number)|null|undefined} The measure of a player's chances, or
 *   nothing when the category is not gated in this pool.
 */
export function opportunityGateFor(id, isRpPool, sport) {
    const gates = CATEGORY_OPPORTUNITY[sport] || {};
    // The RP exception is baseball's, so it is scoped to the table that defines the gate rather than to the number 57 wherever it appears.
    if (isRpPool && gates === CATEGORY_OPPORTUNITY.flb && id === '57') return null;
    return gates[id];
}

/**
 * A player's value in a category as it is ranked: the raw total, or strikeouts per nine innings
 * inside a relief pitcher pool.
 *
 * @param {RankPlayer} p The player.
 * @param {string} id The stat id.
 * @param {boolean} isRpPool Whether the pool is relief pitchers only.
 * @param {string} sport The sport code.
 * @returns {number|undefined} Undefined when the player has no figure for it.
 */
export function statValueForRanking(p, id, isRpPool, sport) {
    const raw = p.seasonTotals[id];
    if (raw === undefined) return undefined;
    if (isRpPool && id === RP_PER_NINE_ID[sport]) {
        const ip = inningsPitchedOf(p);
        return ip > 0 ? (raw / ip) * 9 : 0;
    }
    return raw;
}

// Whether a category is a rate, averaged over opportunities, or a count, summed. A count a player has no figure for is a real zero, since ESPN omits zero counts. A rate a player never posted is absent and is skipped.
function isRateCategory(id, isRpPool, rateStatIds, sport) {
    return (rateStatIds && rateStatIds.has(id)) || (isRpPool && id === RP_PER_NINE_ID[sport]);
}

// The value used for a player in a category: the raw value, or a real zero for a count the player has no figure for. A missing rate stays undefined so the caller skips it.
function categoryValueFor(p, id, isRpPool, rateStatIds, sport) {
    const v = statValueForRanking(p, id, isRpPool, sport);
    if (v !== undefined) return v;
    return isRateCategory(id, isRpPool, rateStatIds, sport) ? undefined : 0;
}

// ==== Percentile primitives ====

/**
 * How many values in an ascending array are less than a value, by binary search.
 *
 * @param {number[]} sortedArr The values, ascending.
 * @param {number} val The value.
 * @returns {number}
 */
export function countLessThan(sortedArr, val) {
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * How many values in an ascending array are greater than a value, by binary search.
 *
 * @param {number[]} sortedArr The values, ascending.
 * @param {number} val The value.
 * @returns {number}
 */
export function countGreaterThan(sortedArr, val) {
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] <= val) lo = mid + 1; else hi = mid;
    }
    return sortedArr.length - lo;
}

/**
 * Where a value ranks within a basis, as a percentile from 0 to 100. Tied values share the
 * average of the positions they occupy.
 *
 * @param {number[]} sortedBasisValues The basis, ascending.
 * @param {number} val The value to place.
 * @param {boolean} [inverse] Whether the lower figure wins.
 * @returns {number} The percentile, capped at 100. A basis of one value or none gives 100.
 */
export function percentileFor(sortedBasisValues, val, inverse) {
    const n = sortedBasisValues.length;
    if (n <= 1) return 100;
    const below = inverse ? countGreaterThan(sortedBasisValues, val) : countLessThan(sortedBasisValues, val);
    const above = inverse ? countLessThan(sortedBasisValues, val) : countGreaterThan(sortedBasisValues, val);
    const equal = n - below - above; // basis values tied with val (0 when val isn't in the basis)
    const worseCount = equal > 0 ? below + (equal - 1) / 2 : below;
    return Math.min(100, (worseCount / (n - 1)) * 100);
}

// ==== Window-projected lines ====
/**
 * A player's projected line over a window of games. A counting category scales with the games,
 * and a rate does not.
 *
 * @param {Object<string, number>} perGame The per-game projection by stat id.
 * @param {number} games The games in the window.
 * @param {Set<string>} [rateIds] The stat ids that are rates.
 * @returns {Object<string, number>} The projected line by stat id. Empty when there is nothing to scale.
 */
export function windowProjectedLine(perGame, games, rateIds) {
    const out = {};
    const n = Number(games);
    if (!perGame || !Number.isFinite(n)) return out;
    Object.keys(perGame).forEach(id => {
        const v = perGame[id];
        if (v === null || v === undefined) return;     // null before Number: Number(null) is 0
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        out[id] = (rateIds && rateIds.has(String(id))) ? num : num * n;
    });
    return out;
}

/**
 * Ranks projected lines against each other by their mean percentile over the categories named.
 *
 * @param {Array<{id: *, line: Object<string, number>}>} rows The players and their lines.
 * @param {object} [options]
 * @param {string[]} [options.categoryIds] The categories to rank on.
 * @param {Set<string>} [options.inverseIds] The categories won by the lower figure.
 * @param {Set<string>} [options.rateIds] The categories that are rates.
 * @returns {Map<*, {label: number, tied: boolean}>} Each player's place, and whether it is shared.
 *   Empty when fewer than two players have a line.
 */
export function windowLineRanks(rows, { categoryIds = [], inverseIds = new Set(), rateIds = new Set() } = {}) {
    const out = new Map();
    const players = (rows || []).filter(r => r && r.id !== undefined && r.line);
    if (players.length < 2) return out;                // one line ranks nobody, the same rule as everywhere

    const sums = new Map(players.map(r => [r.id, { total: 0, count: 0 }]));
    categoryIds.forEach(rawId => {
        const id = String(rawId);
        const valueOf = (r) => {
            const v = r.line[id];
            if (v === null || v === undefined) return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        };
        // A rate is ranked only among the players who posted one; a counting category is ranked across everyone, because not appearing in it really is zero of it.
        const isRate = rateIds.has(id);
        const basis = players.map(valueOf).filter(v => v !== undefined);
        if (basis.length < 2) return;
        const sorted = [...basis].sort((a, b) => a - b);
        const inverse = inverseIds.has(id);
        players.forEach(r => {
            let v = valueOf(r);
            if (v === undefined) {
                if (isRate) return;                    // no figure, no percentile in this category
                v = 0;
            }
            const bucket = sums.get(r.id);
            bucket.total += percentileFor(sorted, v, inverse);
            bucket.count += 1;
        });
    });

    const scored = players
        .map(r => ({ id: r.id, score: sums.get(r.id).count ? sums.get(r.id).total / sums.get(r.id).count : null }))
        .filter(r => r.score !== null)
        .sort((a, b) => b.score - a.score);
    scored.forEach((r, i) => {
        const label = (i > 0 && scored[i - 1].score === r.score) ? out.get(scored[i - 1].id).label : i + 1;
        out.set(r.id, { label, tied: false });
    });
    // A place shared by more than one player says so, which the row's own rank field also does.
    const counts = new Map();
    out.forEach(v => counts.set(v.label, (counts.get(v.label) || 0) + 1));
    out.forEach(v => { v.tied = (counts.get(v.label) || 0) > 1; });
    return out;
}

// ==== Roto-style pool ranking ====
/**
 * Ranks a pool the way a roto league scores it. Each scored category is a percentile against
 * qualified peers of the same role, and a player's score is the mean of those percentiles.
 *
 * @param {RankPlayer[]} groupPlayers The pool.
 * @param {RotoContext} ctx The league's sets and the pool's measures.
 * @returns {{scores: Map<*, number>, ranks: Map<*, number>, ranked: RankPlayer[], total: number,
 *   categoryCount: number, byCategory: Map<*, Map<string, number>>}} The scores, the ranks, the
 *   players in rank order, and each player's percentile in each category.
 */
export function computeRotoRanks(groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, requireMinPlayingTime, workloadOf, thresholdWorkloadOf, sport } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrinkFactor = p => isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(p) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    // A player with no playing time is never ranked, in either state of the minimum games setting. Shrinkage would score such a player exactly 50 in every category, above every real below-average season. A pool where nobody has played yet is ranked as it is.
    const candidateBase = requireMinPlayingTime ? qualifiedPlayers : groupPlayers;
    const candidatePlayers = maxThresholdWorkload > 0
        ? candidateBase.filter(p => thresholdWorkloadOf(p) > 0)
        : candidateBase;

    const percentileSum = new Map();
    const catCount = new Map();
    // The percentiles are kept as well as summed, so a caller that needs every player's category picture does not rebuild the basis. Nothing below reads this map.
    const byCategory = new Map();

    relevantStatIds.forEach(id => {
        const isRate = isRateCategory(id, isRpPool, rateStatIds, sport);
        // The comparison basis is always the qualified pool. A count ranks the whole of it and a rate only the players who posted one.
        let basisPlayers = isRate
            ? qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool, sport) !== undefined)
            : qualifiedPlayers;
        const opportunityOf = opportunityGateFor(id, isRpPool, sport);
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...basisPlayers.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) basisPlayers = basisPlayers.filter(p => opportunityOf(p) >= minOpportunity);
        }
        if (basisPlayers.length === 0) return;

        const inverse = inverseStatIds.has(id);
        const basisValues = basisPlayers.map(p => categoryValueFor(p, id, isRpPool, rateStatIds, sport)).sort((a, b) => a - b);

        candidatePlayers.forEach(p => {
            const val = categoryValueFor(p, id, isRpPool, rateStatIds, sport);
            if (val === undefined) return; // a rate this player never posted
            if (opportunityOf && opportunityOf(p) < minOpportunity) return;

            const rawPct = percentileFor(basisValues, val, inverse);
            const pct = 50 + (rawPct - 50) * shrinkFactor(p);
            percentileSum.set(p.id, (percentileSum.get(p.id) || 0) + pct);
            catCount.set(p.id, (catCount.get(p.id) || 0) + 1);
            let cats = byCategory.get(p.id);
            if (!cats) { cats = new Map(); byCategory.set(p.id, cats); }
            cats.set(id, pct);
        });
    });

    const scores = new Map();
    candidatePlayers.forEach(p => {
        const cnt = catCount.get(p.id) || 0;
        if (cnt > 0) scores.set(p.id, percentileSum.get(p.id) / cnt);
    });

    const ranked = candidatePlayers.filter(p => scores.has(p.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
    const ranks = new Map();
    ranked.forEach((p, i) => ranks.set(p.id, i + 1));

    return { scores, ranks, ranked, total: ranked.length, categoryCount: relevantStatIds.length, byCategory };
}

/**
 * One player's score taken apart by category, with the arithmetic computeRotoRanks uses.
 *
 * @param {RankPlayer} player The player.
 * @param {RankPlayer[]} groupPlayers The pool the player is ranked in.
 * @param {RotoContext} ctx As computeRotoRanks takes it, with statMap added for the row names.
 * @returns {{rows: Array<{id: string, name: string, value: number, inverse: boolean, rawPct: number,
 *   adjPct: number}>, excluded: Array<{id: string, name: string}>, shrink: number, avg: number,
 *   qualifiedCount: number}} The categories scored, those left out for want of opportunity, the
 *   shrinkage applied, the score and the size of the basis.
 */
export function computeCategoryBreakdown(player, groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, workloadOf, thresholdWorkloadOf, statMap, sport } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrink = isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(player) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    const included = [];
    const excluded = [];
    // Every branch mirrors computeRotoRanks, so the rows reconstruct the leaderboard score.
    relevantStatIds.forEach(id => {
        const isRate = isRateCategory(id, isRpPool, rateStatIds, sport);
        const val = categoryValueFor(player, id, isRpPool, rateStatIds, sport);
        if (val === undefined) return; // a rate this player never posted
        // Labeled so a K/9-substituted value doesn't look like a mislabeled raw K count.
        const name = (statMap[id] || `Stat ${id}`) + (isRpPool && id === RP_PER_NINE_ID[sport] ? ' (as K/9)' : '');

        let basisPlayers = isRate
            ? qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool, sport) !== undefined)
            : qualifiedPlayers;
        const opportunityOf = opportunityGateFor(id, isRpPool, sport);
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...basisPlayers.map(opportunityOf));
            const minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) {
                if (opportunityOf(player) < minOpportunity) {
                    excluded.push({ id, name });
                    return;
                }
                basisPlayers = basisPlayers.filter(p => opportunityOf(p) >= minOpportunity);
            }
        }
        if (basisPlayers.length === 0) return;

        const inverse = inverseStatIds.has(id);
        const basisValues = basisPlayers.map(p => categoryValueFor(p, id, isRpPool, rateStatIds, sport)).sort((a, b) => a - b);
        const rawPct = percentileFor(basisValues, val, inverse);
        const adjPct = 50 + (rawPct - 50) * shrink;

        included.push({ id, name, value: val, inverse, rawPct, adjPct });
    });

    const avg = included.length ? included.reduce((s, r) => s + r.adjPct, 0) / included.length : 0;
    // qualifiedCount is the size of the basis the score was computed against, so a view can label it truthfully.
    return { rows: included, excluded, shrink, avg, qualifiedCount: qualifiedPlayers.length };
}

// ==== Single-stat ranking ====

/**
 * Competition ranks for a list of keys that is already sorted. Equal keys share the rank of the
 * first, and the next distinct key takes its true position: 1, 1, 3.
 *
 * @param {Array<*>} sortedKeys The comparison keys, best first.
 * @returns {number[]} The rank of each.
 */
export function competitionRanks(sortedKeys) {
    const ranks = new Array(sortedKeys.length);
    for (let i = 0; i < sortedKeys.length; i++) {
        ranks[i] = (i > 0 && sortedKeys[i] === sortedKeys[i - 1]) ? ranks[i - 1] : i + 1;
    }
    return ranks;
}

/**
 * A rank as text, marked as shared when more than one entry holds it.
 *
 * @param {number} rank The rank.
 * @param {number[]} ranks Every rank in the list.
 * @returns {string} "#3", or "T3" for a shared rank.
 */
export function formatRank(rank, ranks) {
    const shared = (ranks || []).filter(r => r === rank).length > 1;
    return `${shared ? 'T' : '#'}${rank}`;
}

/**
 * One player's rank within a pool on one stat, with ties sharing a rank.
 *
 * @param {RankPlayer[]} pool The pool, each with a figure for the stat.
 * @param {number|string} playerId The player.
 * @param {string} statId The stat id.
 * @param {boolean} [inverse] Whether the lower figure wins.
 * @returns {?{rank: number, total: number, percentile: number, sorted: RankPlayer[], ranks: number[]}}
 *   Null when the pool is empty or the player is not in it.
 */
export function computeStatRankInPool(pool, playerId, statId, inverse) {
    if (pool.length === 0) return null;

    const sorted = [...pool].sort((a, b) => inverse
        ? a.seasonTotals[statId] - b.seasonTotals[statId]
        : b.seasonTotals[statId] - a.seasonTotals[statId]);

    const ranks = competitionRanks(sorted.map(p => p.seasonTotals[statId]));

    const idx = sorted.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    const rank = ranks[idx];
    const percentile = sorted.length > 1 ? ((sorted.length - rank) / (sorted.length - 1)) * 100 : 100;
    return { rank, total: sorted.length, percentile, sorted, ranks };
}

// ==== Weekly Matchup Score ====

/**
 * A peer basis for scoring a week, built from season rates. It is the fallback for a pool with
 * too little weekly data for buildWeeklyValueBasis.
 *
 * @param {RankPlayer[]} pool The peers.
 * @param {{relevantStatIds: string[], inverseStatIds: Set<string>, avgStatIds: Set<string>,
 *   weeksElapsed: number, sport: string}} ctx The scored ids, the rate ids and the weeks played.
 * @returns {CategoryBasis[]} One basis per category that has any peer value.
 */
export function buildCategoryRateBasis(pool, ctx) {
    const { relevantStatIds, inverseStatIds, avgStatIds, weeksElapsed, sport } = ctx;
    const gates = CATEGORY_OPPORTUNITY[sport] || {};
    return relevantStatIds.map(id => {
        const opportunityOf = gates[id];
        let catPool = pool.filter(p => p.seasonTotals[id] !== undefined);
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...catPool.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) catPool = catPool.filter(p => opportunityOf(p) >= minOpportunity);
        }
        const isRate = avgStatIds.has(id);
        return {
            id,
            inverse: inverseStatIds.has(id),
            isRate,
            opportunityOf,
            minOpportunity,
            rates: catPool.map(p => isRate ? p.seasonTotals[id] : p.seasonTotals[id] / weeksElapsed).sort((a, b) => a - b)
        };
    }).filter(c => c.rates.length > 0);
}

/**
 * A peer basis for scoring a week, built from the peers' own real weeks. A week with no games is
 * left out.
 *
 * @param {Array<{id: *, seasonTotals: Object<string, number>, weeks: Array<{stats: Object<string, number>,
 *   games: number}>}>} weeklyValuesByPlayer Each peer with the weeks the caller chose.
 * @param {{relevantStatIds: string[], inverseStatIds: Set<string>, avgStatIds: Set<string>,
 *   sport: string}} ctx The scored ids and the rate ids.
 * @returns {CategoryBasis[]} One basis per category that has any peer value.
 */
export function buildWeeklyValueBasis(weeklyValuesByPlayer, ctx) {
    const { relevantStatIds, inverseStatIds, avgStatIds, sport } = ctx;
    const gates = CATEGORY_OPPORTUNITY[sport] || {};
    return relevantStatIds.map(id => {
        const opportunityOf = gates[id];
        let catPool = weeklyValuesByPlayer.filter(p => p.weeks.some(w => w.stats[id] !== undefined));
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...catPool.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) catPool = catPool.filter(p => opportunityOf(p) >= minOpportunity);
        }
        const isRate = avgStatIds.has(id);

        // Real values per week, not per player. One player's five weeks are five points in the distribution.
        const rates = [];
        catPool.forEach(p => {
            p.weeks.forEach(w => {
                if (w.games <= 0) return; // bye/IL week - absence, not a performance to beat
                const val = w.stats[id];
                if (val !== undefined) rates.push(val);
            });
        });
        rates.sort((a, b) => a - b);

        return { id, inverse: inverseStatIds.has(id), isRate, opportunityOf, minOpportunity, rates };
    }).filter(c => c.rates.length > 0);
}

/**
 * One player's score for one week: the mean of the week's percentiles over the scored categories.
 *
 * @param {RankPlayer} player The player.
 * @param {?Object<string, number>} weekStats The week's figures by stat id.
 * @param {CategoryBasis[]} categoryRates The peer basis.
 * @param {number} [partialWeekFraction=1] The share of the matchup played. A count is scaled up to
 *   a full matchup by it, and a rate is not.
 * @returns {?number} The score, or null when no category could be scored.
 */
export function scoreWeekAgainstBasis(player, weekStats, categoryRates, partialWeekFraction = 1) {
    const rows = scoreWeekByCategory(player, weekStats, categoryRates, partialWeekFraction);
    if (!rows.length) return null;
    return rows.reduce((a, r) => a + r.percentile, 0) / rows.length;
}

/**
 * One player's week, one row per scored category, before the rows are averaged.
 *
 * @param {RankPlayer} player The player.
 * @param {?Object<string, number>} weekStats The week's figures by stat id.
 * @param {CategoryBasis[]} categoryRates The peer basis.
 * @param {number} [partialWeekFraction=1] The share of the matchup played.
 * @returns {Array<{id: string, value: number, inverse: boolean, percentile: number}>} The value compared
 *   and its percentile, per category. Empty for a week with no figure at all.
 */
export function scoreWeekByCategory(player, weekStats, categoryRates, partialWeekFraction = 1) {
    if (!weekStats) return [];
    // A week with no figure at all is not a week of zeros. It is left unscored.
    const played = categoryRates.some(c => weekStats[c.id] !== undefined);
    if (!played) return [];

    const rows = [];
    categoryRates.forEach(({ id, inverse, isRate, rates, opportunityOf, minOpportunity }) => {
        const raw = weekStats[id];
        // The season ranking's own rule for a missing value. A count the week does not carry is an earned zero, and a rate nobody posted is absent.
        if (raw === undefined && isRate) return;
        if (opportunityOf && opportunityOf(player) < minOpportunity) return;
        const base = raw === undefined ? 0 : raw;
        const val = (!isRate && partialWeekFraction < 1) ? base / partialWeekFraction : base;
        // The same percentile as the season ranking, with its tie splitting and its ceiling, so a week and a season percentile mean the same thing.
        rows.push({ id, value: val, inverse: !!inverse, percentile: percentileFor(rates, val, inverse) });
    });
    return rows;
}

// ==== Roto standings scoring ====

/**
 * Roto points for one category across a set of teams. The best of n takes n points and the worst
 * takes 1, and tied teams share the average of the places they span.
 *
 * @param {Array<{id: *, value: (number|undefined|null)}>} entries Each team's figure. A team with none
 *   ranks below every team with one.
 * @param {boolean} [inverse] Whether the lower figure wins.
 * @returns {Map<*, number>} The points by team id.
 */
export function rotoPointsForCategory(entries, inverse) {
    const n = entries.length;
    const points = new Map();
    if (n === 0) return points;

    const isBlank = v => v === undefined || v === null;
    const sorted = [...entries].sort((a, b) => {
        const au = isBlank(a.value), bu = isBlank(b.value);
        if (au && bu) return 0;
        if (au) return 1;   // a is worse (parks below any real value)
        if (bu) return -1;  // b is worse
        return inverse ? (a.value - b.value) : (b.value - a.value); // best first
    });

    const tie = (a, b) => {
        const au = isBlank(a.value), bu = isBlank(b.value);
        if (au || bu) return au && bu; // two blanks tie; a blank never ties a real value
        return a.value === b.value;
    };

    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && tie(sorted[i], sorted[j + 1])) j++;
        // Positions i to j are zero-based, and position k is worth n minus k points. The run shares their average.
        let pointSum = 0;
        for (let k = i; k <= j; k++) pointSum += (n - k);
        const shared = pointSum / (j - i + 1);
        for (let k = i; k <= j; k++) points.set(sorted[k].id, shared);
        i = j + 1;
    }
    return points;
}

/**
 * Roto points across teams over every category, each scored by itself and summed.
 *
 * @param {Array<{id: *, values: Object<string, (number|undefined)>}>} teams Each team's figures.
 * @param {Array<{id: string, inverse: boolean}>} categories The scored categories.
 * @returns {Map<*, number>} The total points by team id.
 */
export function scoreRotoWeek(teams, categories) {
    const totals = new Map(teams.map(t => [t.id, 0]));
    categories.forEach(cat => {
        const entries = teams.map(t => ({ id: t.id, value: t.values[cat.id] }));
        rotoPointsForCategory(entries, cat.inverse).forEach((pts, id) => {
            totals.set(id, totals.get(id) + pts);
        });
    });
    return totals;
}

/**
 * Ranks a pool of a points league by fantasy points, each stat times the league's weight for it.
 *
 * @param {RankPlayer[]} groupPlayers The pool.
 * @param {{weights: Object<string, number>, workloadOf: function(RankPlayer): number}} ctx The points
 *   per unit of each stat, and the measure of whether a player has played.
 * @returns {{scores: Map<*, number>, ranks: Map<*, number>, ranked: RankPlayer[], total: number}} The
 *   points, the ranks and the players in rank order. A player who has not played is left out.
 */
export function computePointsRanks(groupPlayers, ctx) {
    const { weights, workloadOf } = ctx;
    const ids = Object.keys(weights || {}).filter(id => weights[id]);

    const scores = new Map();
    const anyPlayed = groupPlayers.some(p => workloadOf(p) > 0);
    groupPlayers.forEach(p => {
        if (anyPlayed && !(workloadOf(p) > 0)) return;
        const totals = p.seasonTotals || {};
        let sum = 0;
        ids.forEach(id => { sum += (Number(totals[id]) || 0) * weights[id]; });
        scores.set(p.id, sum);
    });

    // A tie on points is broken by id, so the order is stable across redraws.
    const ranked = groupPlayers.filter(p => scores.has(p.id))
        .sort((a, b) => (scores.get(b.id) - scores.get(a.id)) || (a.id - b.id));
    const ranks = new Map();
    ranked.forEach((p, i) => ranks.set(p.id, i + 1));

    return { scores, ranks, ranked, total: ranked.length };
}

// ==== Head-to-head comparison ====

/**
 * The most players that can be compared against an anchor.
 *
 * @type {number}
 */
export const PLAYER_GROUP_MAX_OTHERS = 6;

/**
 * Compares a group of players one category at a time against one pool, each beside an anchor.
 *
 * Contract: tests/fixtures/player-group.md
 *
 * @param {RankPlayer[]} pool The pool every player is measured in.
 * @param {number|string} anchorId The player the others are compared with.
 * @param {Array<number|string>|number|string} otherIds The other players.
 * @param {{statIds: string[], inverseStatIds: Set<string>, statMap: Object<string, string>}} ctx The
 *   categories, which of them the lower figure wins, and their names.
 * @returns {{anchorId: *, ids: Array<*>, rows: ?object[], tally: ?object[], refused: ?string}} One row
 *   per category with a cell per player, and per player the categories taken from the anchor. Past
 *   the cap, rows and tally are null and refused says why.
 */
export function comparePlayerGroup(pool, anchorId, otherIds, ctx) {
    const { statIds, inverseStatIds, statMap = {} } = ctx || {};
    const others = (Array.isArray(otherIds) ? otherIds : [otherIds])
        .filter(id => id !== undefined && id !== null && id !== anchorId);
    // The cap is enforced here and not left to the caller, since the table is built before its width is known.
    if (others.length > PLAYER_GROUP_MAX_OTHERS) {
        return {
            anchorId, ids: [anchorId, ...others], rows: null, tally: null,
            refused: `Six players at most in a group.`
        };
    }
    const ids = [anchorId, ...others];
    const takes = new Map(ids.map(id => [id, { takes: 0, of: 0 }]));

    const rows = (statIds || []).map(id => {
        const inverse = !!(inverseStatIds && inverseStatIds.has(id));
        // A player with no value for this category is not part of its ordering.
        const catPool = (pool || []).filter(p => p.seasonTotals[id] !== undefined);
        const anchorSide = sideOf(catPool, anchorId, id, inverse);
        const anchorValue = anchorSide ? anchorSide.value : null;

        const cells = ids.map(pid => {
            const side = pid === anchorId ? anchorSide : sideOf(catPool, pid, id, inverse);
            const base = {
                id: pid,
                value: side ? side.value : null,
                rank: side ? side.rank : null,
                total: side ? side.total : null,
                percentile: side ? side.percentile : null,
                delta: null,
                better: null
            };
            if (pid === anchorId || !side || anchorValue === null) return base;
            // The delta is arithmetic and better is direction, kept apart on purpose. On a category where lower wins, a positive delta is worse.
            base.delta = side.value - anchorValue;
            base.better = side.value === anchorValue ? 'even'
                : (inverse ? (side.value < anchorValue ? 'up' : 'down')
                    : (side.value > anchorValue ? 'up' : 'down'));
            const t = takes.get(pid);
            if (t) { t.of += 1; if (base.better === 'up') t.takes += 1; }
            return base;
        });

        // Best and worst are lists, since a tie is two players and a single field would name one of them the winner.
        const measured = cells.filter(c => c.value !== null);
        let bestIds = [], worstIds = [];
        if (measured.length) {
            const values = measured.map(c => c.value);
            const best = inverse ? Math.min(...values) : Math.max(...values);
            const worst = inverse ? Math.max(...values) : Math.min(...values);
            bestIds = measured.filter(c => c.value === best).map(c => c.id);
            worstIds = measured.filter(c => c.value === worst).map(c => c.id);
        }
        return { id, name: statMap[id] || `Stat ${id}`, inverse, cells, bestIds, worstIds };
    });

    // The denominator is the categories that could be compared, so a player missing four of nine reads as a count out of five.
    const tally = ids.map(id => (id === anchorId
        ? { id, takes: null, of: null }
        : { id, takes: takes.get(id).takes, of: takes.get(id).of }));

    return { anchorId, ids, rows, tally, refused: null };
}

/**
 * Compares two players one category at a time against one pool.
 *
 * @param {RankPlayer[]} pool The pool both are measured in.
 * @param {number|string} idA The first player.
 * @param {number|string} idB The second player.
 * @param {{statIds: string[], inverseStatIds: Set<string>, statMap: Object<string, string>}} ctx As
 *   comparePlayerGroup takes it.
 * @returns {{rows: Array<{id: string, name: string, inverse: boolean, a: ?object, b: ?object, edge: string}>,
 *   tally: {a: number, b: number, tie: number}}} Each category with both sides and who has the edge,
 *   and the count of each.
 */
export function comparePlayerCategories(pool, idA, idB, ctx) {
    const group = comparePlayerGroup(pool, idA, [idB], ctx);
    const tally = { a: 0, b: 0, tie: 0 };
    const rows = (group.rows || []).map(r => {
        const a = cellSide(r.cells[0]);
        const b = cellSide(r.cells[1]);
        let edge = 'none';
        if (a && b) {
            edge = r.cells[1].better === 'even' ? 'tie' : (r.cells[1].better === 'up' ? 'b' : 'a');
            tally[edge] += 1;
        }
        return { id: r.id, name: r.name, inverse: r.inverse, a, b, edge };
    });
    return { rows, tally };
}

// A group cell back to the four numbers the two-player view draws, or null where it had no figure.
function cellSide(cell) {
    if (!cell || cell.value === null) return null;
    return { value: cell.value, rank: cell.rank, total: cell.total, percentile: cell.percentile };
}

/**
 * One series per player over the matchups, all on one axis.
 *
 * @param {Object<string, Object<string, Object<string, number>>>} weeklyById Each player's figures by
 *   matchup and stat id.
 * @param {Array<number|string>} ids The players, anchor first.
 * @param {string} statId The stat to chart. Ignored when scoreOf is given.
 * @param {object} [opts]
 * @param {number[]} [opts.matchups] The axis. Defaults to every matchup any of the players has.
 * @param {function(*, number): number} [opts.scoreOf] A value per player and matchup, for a series
 *   that is not in the weekly figures.
 * @returns {Array<{id: *, anchor: boolean, points: Array<{matchup: number, value: ?number}>}>} The
 *   series, each the same length, with null where a player has no figure.
 */
export function groupMatchupSeries(weeklyById, ids, statId, opts = {}) {
    const by = weeklyById || {};
    const list = (ids || []).filter(id => id !== undefined && id !== null);
    if (!list.length) return [];
    // Not named valueOf. Every object inherits a method of that name, so a default for an option called valueOf would never apply.
    const { scoreOf = null } = opts;

    let axis = opts.matchups;
    if (!Array.isArray(axis) || !axis.length) {
        const seen = new Set();
        list.forEach(id => Object.keys(by[id] || {}).forEach(w => {
            const n = Number(w);
            if (Number.isFinite(n)) seen.add(n);
        }));
        axis = [...seen].sort((a, b) => a - b);
    } else {
        axis = axis.map(Number).filter(Number.isFinite);
    }

    return list.map((id, i) => ({
        id,
        anchor: i === 0,
        points: axis.map(matchup => {
            if (scoreOf) {
                const v = scoreOf(id, matchup);
                return { matchup, value: Number.isFinite(v) ? v : null };
            }
            const line = (by[id] || {})[matchup] || (by[id] || {})[String(matchup)];
            const raw = line ? line[statId] : undefined;
            const n = Number(raw);
            return { matchup, value: (raw === undefined || raw === null || !Number.isFinite(n)) ? null : n };
        })
    }));
}

// One side of a row, reduced to the four numbers a view draws, so the sorted pool is not kept alive per category.
function sideOf(catPool, playerId, statId, inverse) {
    const r = computeStatRankInPool(catPool, playerId, statId, inverse);
    if (!r) return null;
    return { value: catPool.find(p => p.id === playerId).seasonTotals[statId], rank: r.rank, total: r.total, percentile: r.percentile };
}

// ==== The day strip's verdict ====

// A day is judged on its counting line against the same player's other days. A rate on one day is noise or undefined, so rate categories are left out by the caller. Whether a day is a signature one arrives as an argument, since that is sport knowledge.

/**
 * How many times a player's own typical day a day must reach to be a signature day.
 *
 * @type {number}
 */
export const DAY_SIGNATURE_RATIO = 1.75;
/**
 * How far either side of a player's own typical day still reads as an ordinary day.
 *
 * @type {number}
 */
export const DAY_ORDINARY_BAND = 0.15;

/**
 * A player's own average per played day for each stat.
 *
 * @param {Object<string, {games: number, sums: Object<string, number>}>} daysByPeriod The player's days.
 * @param {string[]} statIds The stats to average.
 * @returns {Object<string, number>} The averages by stat id. Empty when no day was played.
 */
export function perDayAverages(daysByPeriod, statIds) {
    const totals = {};
    let played = 0;
    Object.keys(daysByPeriod || {}).forEach(period => {
        const day = daysByPeriod[period];
        if (!day || !day.games) return;
        played += 1;
        statIds.forEach(id => { totals[id] = (totals[id] || 0) + (Number((day.sums || {})[id]) || 0); });
    });
    const avg = {};
    if (!played) return avg;
    statIds.forEach(id => { avg[id] = (totals[id] || 0) / played; });
    return avg;
}

/**
 * One day's score as a multiple of the player's own average day, where 1 is a typical day.
 *
 * @param {Object<string, number>} daySums The day's figures by stat id.
 * @param {Object<string, number>} avgByStat The player's averages, from perDayAverages.
 * @param {string[]} statIds The stats to score on.
 * @returns {?number} The score, or null when no stat has a baseline.
 */
export function scoreDayAgainstSelf(daySums, avgByStat, statIds) {
    let sum = 0;
    let counted = 0;
    statIds.forEach(id => {
        const avg = avgByStat[id];
        // A category the player has never produced in has no baseline, so it is skipped.
        if (!avg || avg <= 0) return;
        sum += (Number((daySums || {})[id]) || 0) / avg;
        counted += 1;
    });
    return counted ? sum / counted : null;
}

/**
 * A player's typical day: the median of the player's day scores.
 *
 * @param {Array<?number>} scores The day scores.
 * @returns {?number} The median, or null when there are none.
 */
export function typicalDayScore(scores) {
    const real = (scores || []).filter(s => s !== null && s !== undefined).sort((a, b) => a - b);
    if (!real.length) return null;
    const mid = Math.floor(real.length / 2);
    return real.length % 2 ? real[mid] : (real[mid - 1] + real[mid]) / 2;
}

/**
 * Which of four verdicts a day earns against the player's own typical day.
 *
 * @param {?number} score The day's score.
 * @param {boolean} signature Whether the sport's own rules call the day remarkable.
 * @param {?number} typical The player's typical day score.
 * @returns {'signature'|'above'|'below'|'ordinary'}
 */
export function dayVerdict(score, signature, typical) {
    if (signature) return 'signature';
    if (score === null || score === undefined) return 'ordinary';
    // A typical day of zero is no baseline, so every day reads ordinary until there is one.
    if (!typical || typical <= 0) return 'ordinary';
    const ratio = score / typical;
    if (ratio >= DAY_SIGNATURE_RATIO) return 'signature';
    if (ratio > 1 + DAY_ORDINARY_BAND) return 'above';
    if (ratio < 1 - DAY_ORDINARY_BAND) return 'below';
    return 'ordinary';
}

/**
 * The figure a typical day is shown as.
 *
 * @type {number}
 */
export const DAY_SCORE_TYPICAL = 50;
/**
 * The most a day's shown figure can be.
 *
 * @type {number}
 */
export const DAY_SCORE_CAP = 100;
/**
 * A day score as the whole number a reader sees, where 50 is the player's typical day.
 *
 * @param {?number} score The day's score.
 * @returns {?number} The figure, capped, or null for no score.
 */
export function presentDayScore(score) {
    if (score === null || score === undefined || !isFinite(score)) return null;
    return Math.min(DAY_SCORE_CAP, Math.round(score * DAY_SCORE_TYPICAL));
}
