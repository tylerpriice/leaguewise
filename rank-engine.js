// The rank engine: every ranking and percentile computation in the app, as pure functions. It imports nothing and never touches AppState, the DOM or the network, which is what makes it unit-testable and reusable.

// ==== Domain constants, validated against real ESPN data ====

// Games-played id per sport and role group. Baseball GP (81) is batting-only and absent entirely for pitchers, who use 32 (G). Hockey uses GP (30) for skaters and goalies alike, since neither has baseball's swingman problem.
export const GAMES_PLAYED_IDS = {
    flb: { primary: "81", secondary: "32" },
    fhl: { primary: "30", secondary: "30" }
};

// Innings pitched are recorded as OUTS (id 34), so outs/3 is real IP. IP is the right workload measure for pitchers because it scales the same way regardless of role, unlike raw appearances.
export const IP_STAT_ID = "34";

export function inningsPitchedOf(p) {
    const outs = p.seasonTotals[IP_STAT_ID];
    return outs === undefined ? 0 : outs / 3;
}

// A player needs this fraction of the pool leader's games to be ranked at all when the qualifier is on. Deliberately low: the point is filtering extreme tiny-sample outliers, not setting a bar for regulars.
export const MIN_PLAYING_TIME_FRACTION = 0.2;

// SV and QS are positive stats locked behind a role the player does not control, so a low value only counts against someone who had real opportunity (save chances for SV, games started for QS). CS and E stay ungated, because a zero in a lower-is-better category is a genuinely deserved value.
export const CATEGORY_OPPORTUNITY = {
    "57": p => (p.seasonTotals["57"] || 0) + (p.seasonTotals["58"] || 0), // SV needs real save chances (SV+BS)
    "63": p => p.seasonTotals["33"] || 0 // QS needs real starts (GS)
};
export const MIN_OPPORTUNITY_FRACTION = 0.15;

// Inside an RP pool every player is already a reliever, so a real SV total is legitimate signal rather than a role artifact, and gating it there let a non-closer skip the category entirely. QS stays gated everywhere.
export function opportunityGateFor(id, isRpPool) {
    if (id === '57' && isRpPool) return null;
    return CATEGORY_OPPORTUNITY[id];
}

// K (id 48) is compared as K/9 inside an RP pool, because a one-inning reliever's raw K total is capped by innings that a spot-starting swingman is not bound by.
export function statValueForRanking(p, id, isRpPool) {
    const raw = p.seasonTotals[id];
    if (raw === undefined) return undefined;
    if (isRpPool && id === '48') {
        const ip = inningsPitchedOf(p);
        return ip > 0 ? (raw / ip) * 9 : 0;
    }
    return raw;
}

// Whether a category aggregates as a RATE rather than a COUNT, which decides how a missing value reads. ESPN omits a zero-valued counting stat entirely, so a missing key is a real 0, while a rate the player never posted is genuinely absent and must stay absent.
function isRateCategory(id, isRpPool, rateStatIds) {
    return (rateStatIds && rateStatIds.has(id)) || (isRpPool && id === '48');
}

// The value used for basis membership and for ranking: the raw value, a real 0 for a counting category with no key, or undefined for a missing rate so the caller skips it.
function categoryValueFor(p, id, isRpPool, rateStatIds) {
    const v = statValueForRanking(p, id, isRpPool);
    if (v !== undefined) return v;
    return isRateCategory(id, isRpPool, rateStatIds) ? undefined : 0;
}

// ==== Percentile primitives ====

// Binary-search count helpers: sortedArr must already be sorted ascending.
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

// How far val ranks within the basis, as a 0-100 percentile. A tied block scores the AVERAGE percentile of the positions it spans, the same split-the-points convention roto uses, which matters most when a sparse counting category zero-fills a large cohort. Clamped at 100, since an unqualified player scored against the basis can beat all n values.
export function percentileFor(sortedBasisValues, val, inverse) {
    const n = sortedBasisValues.length;
    if (n <= 1) return 100;
    const below = inverse ? countGreaterThan(sortedBasisValues, val) : countLessThan(sortedBasisValues, val);
    const above = inverse ? countLessThan(sortedBasisValues, val) : countGreaterThan(sortedBasisValues, val);
    const equal = n - below - above; // basis values tied with val (0 when val isn't in the basis)
    const worseCount = equal > 0 ? below + (equal - 1) / 2 : below;
    return Math.min(100, (worseCount / (n - 1)) * 100);
}

// ==== Roto-style pool ranking ====
// Every scored category is percentile-ranked against qualified same-role peers and averaged with equal weight. Sample size is handled by playing-time shrinkage, per-category opportunity gating, an optional hard exclusion, and a zero-games floor that always applies.
// The comparison basis is ALWAYS the qualified pool: toggling the exclusion off scores marginal players against that same fixed basis rather than growing it, so an established player's score never moves.
// ctx: { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, requireMinPlayingTime, workloadOf, thresholdWorkloadOf }
export function computeRotoRanks(groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, requireMinPlayingTime, workloadOf, thresholdWorkloadOf } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrinkFactor = p => isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(p) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    // Zero playing time is zero evidence, not average: shrinkage pulls a percentile toward 50 by workload share, so a player who never played would score exactly 50 in every category. Exact zero only, and guarded on the pool leader so a preseason pool where nobody has played still ranks.
    const candidateBase = requireMinPlayingTime ? qualifiedPlayers : groupPlayers;
    const candidatePlayers = maxThresholdWorkload > 0
        ? candidateBase.filter(p => thresholdWorkloadOf(p) > 0)
        : candidateBase;

    const percentileSum = new Map();
    const catCount = new Map();

    relevantStatIds.forEach(id => {
        const isRate = isRateCategory(id, isRpPool, rateStatIds);
        // The basis is always drawn from the qualified pool, never from the candidate list. A counting category ranks the whole qualified pool, a rate category only the players who posted one.
        let basisPlayers = isRate
            ? qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool) !== undefined)
            : qualifiedPlayers;
        const opportunityOf = opportunityGateFor(id, isRpPool);
        let minOpportunity = 0;
        if (opportunityOf) {
            const maxOpportunity = Math.max(0, ...basisPlayers.map(opportunityOf));
            minOpportunity = maxOpportunity * MIN_OPPORTUNITY_FRACTION;
            if (maxOpportunity > 0) basisPlayers = basisPlayers.filter(p => opportunityOf(p) >= minOpportunity);
        }
        if (basisPlayers.length === 0) return;

        const inverse = inverseStatIds.has(id);
        const basisValues = basisPlayers.map(p => categoryValueFor(p, id, isRpPool, rateStatIds)).sort((a, b) => a - b);

        candidatePlayers.forEach(p => {
            const val = categoryValueFor(p, id, isRpPool, rateStatIds);
            if (val === undefined) return; // a rate this player never posted
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

// The same math as computeRotoRanks for one player, returning the per-category breakdown that averages into the Rank score. Categories with no real opportunity are reported as excluded rather than dropped silently.
export function computeCategoryBreakdown(player, groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, workloadOf, thresholdWorkloadOf, statMap } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrink = isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(player) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    const included = [];
    const excluded = [];
    // Every branch below mirrors computeRotoRanks exactly, so these rows reconstruct the leaderboard score.
    relevantStatIds.forEach(id => {
        const isRate = isRateCategory(id, isRpPool, rateStatIds);
        const val = categoryValueFor(player, id, isRpPool, rateStatIds);
        if (val === undefined) return; // a rate this player never posted
        // Labeled so a K/9-substituted value doesn't look like a mislabeled raw K count.
        const name = (statMap[id] || `Stat ${id}`) + (isRpPool && id === '48' ? ' (as K/9)' : '');

        let basisPlayers = isRate
            ? qualifiedPlayers.filter(p => statValueForRanking(p, id, isRpPool) !== undefined)
            : qualifiedPlayers;
        const opportunityOf = opportunityGateFor(id, isRpPool);
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
        const basisValues = basisPlayers.map(p => categoryValueFor(p, id, isRpPool, rateStatIds)).sort((a, b) => a - b);
        const rawPct = percentileFor(basisValues, val, inverse);
        const adjPct = 50 + (rawPct - 50) * shrink;

        included.push({ id, name, value: val, inverse, rawPct, adjPct });
    });

    const avg = included.length ? included.reduce((s, r) => s + r.adjPct, 0) / included.length : 0;
    // qualifiedCount is the basis the score was actually computed against, so the drill-down cites that rather than the full group pool it does not rank against.
    return { rows: included, excluded, shrink, avg, qualifiedCount: qualifiedPlayers.length };
}

// ==== Single-stat ranking for the drill-down chips ====

// Competition ranking: every value in a run of ties shares the run's first rank, and the next distinct value resumes at its true position. Rank 1 is always best, and inverse handles lower-is-better stats.
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

// ==== Weekly matchup score ====

// Fallback basis, peers' typical week built from season-average rates, used only when there is not enough real weekly data cached for the preferred basis. Rate stats are already per-opportunity and are never divided by the week count, which produced a basis every real weekly value trivially beat.
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

// Preferred basis: peers' REAL weekly values per category, so a cold week lands against other players' actual cold weeks. Comparing a real, noisy week against season averages read flat and high for everyday players, because an average has far less variance than any single week. A week with zero games is excluded, since an absence is not a performance to be beaten.
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

        // Real per-WEEK values rather than per-player: one busy player's five weeks are five independent points in the distribution, which is exactly the variance the typical-week basis flattened away.
        const rates = [];
        catPool.forEach(p => {
            p.weeks.forEach(w => {
                if (w.games <= 0) return; // bye or IL week, an absence rather than a performance to beat
                const val = w.stats[id];
                if (val !== undefined) rates.push(val);
            });
        });
        rates.sort((a, b) => a - b);

        return { id, inverse: inverseStatIds.has(id), isRate, opportunityOf, minOpportunity, rates };
    }).filter(c => c.rates.length > 0);
}

// One week's Matchup Score for one player: each scored category's percentile against the basis, averaged with equal weight. Basis-agnostic, since both builders produce the same shape. partialWeekFraction scores an in-progress matchup on pace, and rate stats are never prorated.
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

// ==== Roto standings scoring ====
// The only place the app computes roto points rather than displaying ESPN's own, used to reconstruct the standings race over time where ESPN gives no snapshot. Pure: no DOM, no AppState, no fetches.

// Roto points for one category across teams: with n entries the best takes n points and the worst 1, and a run of ties shares the average of the positions it spans, which is how ESPN's own reporting produces halves. A team with no value ranks below every team that has one.
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
        // Positions i..j are 0-based, and position k is worth (n - k) points. Average across the run.
        let pointSum = 0;
        for (let k = i; k <= j; k++) pointSum += (n - k);
        const shared = pointSum / (j - i + 1);
        for (let k = i; k <= j; k++) points.set(sorted[k].id, shared);
        i = j + 1;
    }
    return points;
}

// Roto points for a whole week: each category scored independently and summed per team. Pure.
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

// ==== Points-league pool ranking ====
// PURE. Rank by fantasy points scored, since a points league already agrees on one number: every stat carries a weight in the league's own scoringSettings and the weighted sum is the player's fantasy total. Validated against a real points league, where summing stat times weight reproduced ESPN's own appliedTotal for every player in the pool, to the tenth. Computing it rather than reading appliedTotal is what lets the rank follow the timeframe pills, and the minimum-playing-time machinery deliberately does not apply because it exists for rate categories, which points are not. Only true zero evidence is withheld, matching computeRotoRanks' own floor.
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

    // Descending points, with a tie broken by id so the order is stable across re-renders rather than depending on whatever order the pool arrived in.
    const ranked = groupPlayers.filter(p => scores.has(p.id))
        .sort((a, b) => (scores.get(b.id) - scores.get(a.id)) || (a.id - b.id));
    const ranks = new Map();
    ranked.forEach((p, i) => ranks.set(p.id, i + 1));

    return { scores, ranks, ranked, total: ranked.length };
}
