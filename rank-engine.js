// The rank engine: every ranking/percentile computation in the extension, as pure functions.

// ==== Domain constants (validated against real ESPN data) ====

// GP (id 81) is batting-only. Absent (undefined, not zero) for every pitcher.
export const GAMES_PLAYED_IDS = { batter: "81", pitcher: "32" };

// Real innings pitched, recorded as OUTS (id 34, not 46, 46 is HR allowed).
export const IP_STAT_ID = "34";

export function inningsPitchedOf(p) {
    const outs = p.seasonTotals[IP_STAT_ID];
    return outs === undefined ? 0 : outs / 3;
}

// A player needs at least this fraction of the pool's most-active player's games to be ranked at all when the qualifier is on. Filters out plate-appearance-of-one call-ups whose rate stats are meaningless noise.
export const MIN_PLAYING_TIME_FRACTION = 0.2;

// SV is a positive counting stat locked almost entirely behind a role decision a player has no control over. A starter who's never deployed as a closer structurally can't earn saves, so their 0 SV is a role artifact, not a deserved outcome, and scoring it like a real 0 unfairly tanks their average.
export const CATEGORY_OPPORTUNITY = {
    "57": p => (p.seasonTotals["57"] || 0) + (p.seasonTotals["58"] || 0), // SV needs real save chances (SV+BS)
    "63": p => p.seasonTotals["33"] || 0 // QS needs real starts (GS)
};
export const MIN_OPPORTUNITY_FRACTION = 0.15;

// SV's opportunity gate exists to protect STARTERS from an unearned penalty for a role they structurally can't access. Within the RP pool specifically, every player already IS a reliever, so a real (possibly zero) SV total is legitimate signal about bullpen pecking order, not a role artifact.
export function opportunityGateFor(id, isRpPool) {
    if (id === '57' && isRpPool) return null;
    return CATEGORY_OPPORTUNITY[id];
}

// A player's value for a given scored category, normally just their raw total. Except K (id 48) compared as a RATE (K/9) within an RP pool specifically.
export function statValueForRanking(p, id, isRpPool) {
    const raw = p.seasonTotals[id];
    if (raw === undefined) return undefined;
    if (isRpPool && id === '48') {
        const ip = inningsPitchedOf(p);
        return ip > 0 ? (raw / ip) * 9 : 0;
    }
    return raw;
}

// ==== Percentile primitives ====

// Binary-search count helpers. sortedArr must already be sorted ascending.
export function countLessThan(sortedArr, val) {
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo;
}

export function countGreaterThan(sortedArr, val) {
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] <= val) lo = mid + 1; else hi = mid;
    }
    return sortedArr.length - lo;
}

// How far val ranks within sortedBasisValues, as a 0-100 percentile. Counting rather than sort-order rank so exact ties get exactly the same percentile instead of an arbitrary split.
export function percentileFor(sortedBasisValues, val, inverse) {
    const n = sortedBasisValues.length;
    const worseCount = inverse ? countGreaterThan(sortedBasisValues, val) : countLessThan(sortedBasisValues, val);
    return n > 1 ? Math.min(100, (worseCount / (n - 1)) * 100) : 100;
}

// ==== Roto-style pool ranking For every scored category, percentile-rank each player against qualified same-role peers, average the percentiles (every category counts equally ====
export function computeRotoRanks(groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, isRpPool, requireMinPlayingTime, workloadOf, thresholdWorkloadOf } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrinkFactor = p => isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(p) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;
    const candidatePlayers = requireMinPlayingTime ? qualifiedPlayers : groupPlayers;

    const percentileSum = new Map();
    const catCount = new Map();

    relevantStatIds.forEach(id => {
        // The comparison basis is always drawn from the qualified pool only, never from candidatePlayers. See the function comment above.
        let basis = qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool) !== undefined);
        const opportunityOf = opportunityGateFor(id, isRpPool);
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...basis.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) basis = basis.filter(p => opportunityOf(p) >= minOpportunity);
        }
        if (basis.length === 0) return;

        const inverse = inverseStatIds.has(id);
        const basisValues = basis.map(p => statValueForRanking(p, id, isRpPool)).sort((a, b) => a - b);

        candidatePlayers.forEach(p => {
            const val = statValueForRanking(p, id, isRpPool);
            if (val === undefined) return;
            if (opportunityOf && opportunityOf(p) < minOpportunity) return;

            const rawPct = percentileFor(basisValues, val, inverse);
            const pct = 50 + (rawPct - 50) * shrinkFactor(p);
            percentileSum.set(p.id, (percentileSum.get(p.id) || 0) + pct);
            catCount.set(p.id, (catCount.get(p.id) || 0) + 1);
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

    return { scores, ranks, ranked, total: ranked.length, categoryCount: relevantStatIds.length };
}

// Same math as computeRotoRanks, but for a single player. Returns the full per-category breakdown (raw percentile, shrink-adjusted percentile) that gets averaged into their Rank score, so a drill-down can show exactly how the number was built.
export function computeCategoryBreakdown(player, groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, isRpPool, workloadOf, thresholdWorkloadOf, statMap } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrink = isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(player) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    const included = [];
    const excluded = [];
    relevantStatIds.forEach(id => {
        if (player.seasonTotals[id] === undefined) return;
        // Labeled so a K/9-substituted value doesn't look like a mislabeled raw K count.
        const name = (statMap[id] || `Stat ${id}`) + (isRpPool && id === '48' ? ' (as K/9)' : '');

        let basis = qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool) !== undefined);
        const opportunityOf = opportunityGateFor(id, isRpPool);
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...basis.map(opportunityOf));
            const minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) {
                if (opportunityOf(player) < minOpportunity) {
                    excluded.push({ id, name });
                    return;
                }
                basis = basis.filter(p => opportunityOf(p) >= minOpportunity);
            }
        }
        if (basis.length === 0) return;

        const inverse = inverseStatIds.has(id);
        const basisValues = basis.map(p => statValueForRanking(p, id, isRpPool)).sort((a, b) => a - b);
        const val = statValueForRanking(player, id, isRpPool);
        const rawPct = percentileFor(basisValues, val, inverse);
        const adjPct = 50 + (rawPct - 50) * shrink;

        included.push({ id, name, value: val, inverse, rawPct, adjPct });
    });

    const avg = included.length ? included.reduce((s, r) => s + r.adjPct, 0) / included.length : 0;
    return { rows: included, excluded, shrink, avg };
}

// ==== Single-stat ranking (drill-down stat chips) ====

// Rank playerId within pool on one stat.
export function computeStatRankInPool(pool, playerId, statId, inverse) {
    if (pool.length === 0) return null;

    const sorted = [...pool].sort((a, b) => inverse
        ? a.seasonTotals[statId] - b.seasonTotals[statId]
        : b.seasonTotals[statId] - a.seasonTotals[statId]);

    const ranks = new Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
        ranks[i] = (i > 0 && sorted[i].seasonTotals[statId] === sorted[i - 1].seasonTotals[statId]) ? ranks[i - 1] : i + 1;
    }

    const idx = sorted.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    const rank = ranks[idx];
    const percentile = sorted.length > 1 ? ((sorted.length - rank) / (sorted.length - 1)) * 100 : 100;
    return { rank, total: sorted.length, percentile, sorted, ranks };
}

// ==== Weekly Matchup Score ====

// FALLBACK basis (see buildWeeklyValueBasis below for the preferred one). Peer "typical week" rate distributions per scored category, built from season-average rates rather than real weeks.
export function buildCategoryRateBasis(pool, ctx) {
    const { relevantStatIds, inverseStatIds, avgStatIds, weeksElapsed } = ctx;
    return relevantStatIds.map(id => {
        const opportunityOf = CATEGORY_OPPORTUNITY[id];
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

// Peer REAL weekly-value distributions per scored category. The PREFERRED basis (see buildCategoryRateBasis above for the fallback and why it can saturate).
export function buildWeeklyValueBasis(weeklyValuesByPlayer, ctx) {
    const { relevantStatIds, inverseStatIds, avgStatIds } = ctx;
    return relevantStatIds.map(id => {
        const opportunityOf = CATEGORY_OPPORTUNITY[id];
        let catPool = weeklyValuesByPlayer.filter(p => p.weeks.some(w => w.stats[id] !== undefined));
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...catPool.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) catPool = catPool.filter(p => opportunityOf(p) >= minOpportunity);
        }
        const isRate = avgStatIds.has(id);

        const rates = [];
        catPool.forEach(p => {
            p.weeks.forEach(w => {
                if (w.games <= 0) return;
                const val = w.stats[id];
                if (val !== undefined) rates.push(val);
            });
        });
        rates.sort((a, b) => a - b);

        return { id, inverse: inverseStatIds.has(id), isRate, opportunityOf, minOpportunity, rates };
    }).filter(c => c.rates.length > 0);
}

// One week's Matchup Score for one player: percentile of each scored category's real weekly value against a peer basis's rates, averaged with equal weight (same convention as computeRotoRanks).
export function scoreWeekAgainstBasis(player, weekStats, categoryRates, partialWeekFraction = 1) {
    if (!weekStats) return null;
    let sum = 0, count = 0;
    categoryRates.forEach(({ id, inverse, isRate, rates, opportunityOf, minOpportunity }) => {
        if (weekStats[id] === undefined) return;
        if (opportunityOf && opportunityOf(player) < minOpportunity) return;
        const val = (!isRate && partialWeekFraction < 1) ? weekStats[id] / partialWeekFraction : weekStats[id];
        const worseCount = inverse ? countGreaterThan(rates, val) : countLessThan(rates, val);
        sum += (worseCount / rates.length) * 100;
        count++;
    });
    return count > 0 ? sum / count : null;
}
