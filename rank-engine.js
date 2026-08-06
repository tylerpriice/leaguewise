// The rank engine: every ranking/percentile computation in the extension, as pure functions. PURITY CONTRACT. This module imports nothing and never touches AppState, the DOM, or the network. Everything it needs arrives as arguments - league-specific sets (scored stat ids, inverse stats), role-aware measures (workload, games played), and player objects that only need a `seasonTotals` map (stat id -> number) plus an `id`. That's what makes it directly unit-testable (see tests/rank-engine.test.html) and reusable for premium features (matchup planner, trade analyzer, custom weights) without dragging UI state along. players.js owns the impure half: choosing pools, reading AppState, and building the ctx objects passed here.

// ==== Domain constants (validated against real ESPN data - see each comment) ====

// Games-played id per sport and role-group, used for the minimum-playing-time threshold (and, in hockey, for shrinkage too - see workloadOf in players.js). Baseball: GP (id 81) turned out to be batting-only - confirmed by real data showing it completely absent (undefined, not zero) for every pitcher, which meant every single pitcher was landing under the threshold. Pitchers use 32 ("G"), confirmed via exact matches against real games-appeared for three validation pitchers (31/67/62). Hockey: both skaters and goalies use GP (id 30) - confirmed present and ~82 for full-season players across the whole 2026 cats pool (see ESPN_STAT_MAPS.fhl validation). Keyed by role-group ('primary'/'secondary') so gamesPlayedOf can look it up by the active tab; hockey uses the same id for both since, unlike baseball's SP-vs-RP appearances, all goalies (and all skaters) are a single comparable role - no swingman problem that would need an innings-style workload instead.
export const GAMES_PLAYED_IDS = {
    flb: { primary: "81", secondary: "32" },
    fhl: { primary: "30", secondary: "30" }
};

// Real innings pitched, recorded as OUTS (34) - CONFIRMED via exact-match validation against three real 2025 season lines spanning very different workload shapes: Tarik Skubal (195.1 IP over 31 starts -> 586 outs), Aroldis Chapman (61.1 IP over 67 one-inning outings -> 184 outs), and Garrett Whitlock (72.0 IP over 62 multi-inning relief outings -> 216 outs) - all three recompute exactly (outs / 3 = real IP). Id 46 was wrongly assumed to be IP before this validation - it's actually HR allowed. IP is the correct workload measure for pitchers because it scales the same way regardless of role, unlike raw appearances (a starter's ~18-31 starts vs a reliever's 60+ one-inning outings aren't comparable "playing time" even though they're superficially similar-looking counts).
export const IP_STAT_ID = "34";

export function inningsPitchedOf(p) {
    const outs = p.seasonTotals[IP_STAT_ID];
    return outs === undefined ? 0 : outs / 3;
}

// A player needs at least this fraction of the pool's most-active player's games to be ranked at all when the qualifier is on - filters out plate-appearance-of-one call-ups whose rate stats are meaningless noise, not real signal. Games played specifically (not innings pitched, even for pitchers) - see computeRotoRanks' own comment for why the hard exclusion threshold needs a role-neutral measure, distinct from the innings-based one shrinkage uses. Kept deliberately low (20%) across every pool - the point of this toggle is filtering out extreme, tiny-sample outliers (a two-game rehab stint), not setting a "regular" bar.
export const MIN_PLAYING_TIME_FRACTION = 0.2;

// SV is a POSITIVE counting stat (more is better) locked almost entirely behind a role decision a player has no control over - a starting pitcher who's never deployed as a closer structurally can't earn saves no matter how good they are, so their 0 SV is a role/ opportunity artifact, not a deserved outcome, and scoring it like a real 0 unfairly tanks a great starter's average (a #2-of-147 starter had an average score of only 62.7 - the zeroed-out SV category alone was dragging it down). Require real save chances (SV+BS) before a low SV count counts against a player who was never given the chance to earn a high one. QS has the exact same problem, in the opposite direction of the roster. A true relief pitcher who never starts a game structurally cannot record a quality start, so an RP pool's comparison basis is otherwise full of real zeros that aren't a fair reflection of anything - confirmed against real 2025 RP data. An SP/RP swingman making occasional spot starts was landing at #2 overall ahead of several elite-ratio closers purely on the strength of a category true one-inning relievers can never even attempt. Games Started (id 33) is the opportunity signal. CS and E deliberately do NOT get this same treatment, even though they're structurally similar - they're NEGATIVE stats (fewer is better), and a 0 in a "fewer is better" category is a genuinely correct, fully-deserved value regardless of why it's 0: a fantasy Rank score is about actual category contribution, not a separate "how skilled is this player" judgment.
export const CATEGORY_OPPORTUNITY = {
    "57": p => (p.seasonTotals["57"] || 0) + (p.seasonTotals["58"] || 0), // SV needs real save chances (SV+BS)
    "63": p => p.seasonTotals["33"] || 0 // QS needs real starts (GS)
};
export const MIN_OPPORTUNITY_FRACTION = 0.15;

// SV's opportunity gate exists to protect STARTERS from an unearned penalty for a role they structurally can't access - within the RP pool specifically, every player already IS a reliever, so a real (possibly zero) SV total is legitimate signal about their bullpen pecking-order/trust, not a role artifact that needs protecting. Gating it there anyway let a non-closer duck the category entirely instead of being fairly compared against actual closers (confirmed against real 2026 data: Dylan Lee - 0 SV, 0 real save chances - became the top-ranked RP because "Excluded: SV, QS" let him skip both). QS doesn't have this problem in either direction, so QS stays gated everywhere.
export function opportunityGateFor(id, isRpPool) {
    if (id === '57' && isRpPool) return null;
    return CATEGORY_OPPORTUNITY[id];
}

// A player's value for a given scored category, normally just their raw total - except K (id 48) compared as a RATE (K/9) within an RP pool specifically. Same underlying problem as skipping shrinkage there. A true one-inning reliever's raw K total is mechanically capped by innings no swingman is bound by (confirmed against real RP data, a swingman with a 6.56 K/9 - worse than most true relievers in the pool - still out-totaled a true reliever's 12.375 K/9 season on raw K, purely from throwing over twice the innings).
export function statValueForRanking(p, id, isRpPool) {
    const raw = p.seasonTotals[id];
    if (raw === undefined) return undefined;
    if (isRpPool && id === '48') {
        const ip = inningsPitchedOf(p);
        return ip > 0 ? (raw / ip) * 9 : 0;
    }
    return raw;
}

// Whether a scored category aggregates as a RATE (averaged over opportunities) rather than a COUNT (summed). This is the pivot for how a MISSING value is read, and the two directions are opposite: - Counting cats (HR, R, HAT, SHP, W, SV,...): ESPN omits a zero-valued sparse stat entirely - a skater with no hat trick has no id-28 key at all - so a missing key is a real 0. Reading it as 0 (below) ranks every qualified player in every scored counting cat, instead of ranking HAT among only the 77 players who happened to record one and letting a zero cost nothing. - Rate cats (AVG/OPS/OBP/SLG/ERA/WHIP/K9/GAA/SV%, and K compared as K/9 inside an RP pool): a rate you never posted is genuinely absent, not zero. A 0.000 AVG or 0.00 ERA is a real, and wrong, data point that would crater or inflate the average, so these keep the undefined-skip. ctx supplies rateStatIds (players.js owns AVERAGE_STATS) so the pure engine needs no stat knowledge of its own; the RP-K/9 case is the one substitution the engine already knows about.
function isRateCategory(id, isRpPool, rateStatIds) {
    return (rateStatIds && rateStatIds.has(id)) || (isRpPool && id === '48');
}

// The value used for basis membership and for a player's own ranking in a category: the raw stat value, or - for a COUNTING category the player has no key for - a real 0. Rate categories return undefined for a missing value so the caller skips them (see isRateCategory).
function categoryValueFor(p, id, isRpPool, rateStatIds) {
    const v = statValueForRanking(p, id, isRpPool);
    if (v !== undefined) return v;
    return isRateCategory(id, isRpPool, rateStatIds) ? undefined : 0;
}

// ==== Percentile primitives ====

// Binary-search count helpers - sortedArr must already be sorted ascending.
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

// How far val ranks within sortedBasisValues, as a 0-100 percentile. MIDRANK ties. A tied block scores the AVERAGE percentile of the positions it occupies, not the block's worse edge. This is the percentile analogue of roto's split-the-points convention - two teams tied for 3rd/4th each take 3.5 places - and it matters most now that a sparse counting cat zero-fills a huge cohort at 0 (see categoryValueFor). With the old strictly-worse count all ~654 zero-hat-trick skaters read 0th percentile (dead last for being utterly ordinary), and playing-time shrinkage then pulled the low-workload ones UP toward 50, punishing full-season zeros harder. Midrank puts a value tied with most of the pool near the middle, where "everyone else is here too" belongs. `below` basis values are strictly worse and `equal` tie with val, so the block sits at worse-positions [below, below+equal-1] and its mean position is below+(equal-1)/2. A value NOT in the basis (equal 0) just beats `below`, no tie to split. Clamped at 100: the /(n-1) denominator is exact for a val that's IN the basis (it can beat at most the other n-1 values), but an UNQUALIFIED player scored against the basis (Minimum Games Played toggled off - see candidatePlayers in computeRotoRanks) isn't a basis member and can beat all n values, which would otherwise read as an impossible >100th percentile (confirmed: a 5-game call-up with a basis-beating ERA showed "120.0").
export function percentileFor(sortedBasisValues, val, inverse) {
    const n = sortedBasisValues.length;
    if (n <= 1) return 100;
    const below = inverse ? countGreaterThan(sortedBasisValues, val) : countLessThan(sortedBasisValues, val);
    const above = inverse ? countLessThan(sortedBasisValues, val) : countGreaterThan(sortedBasisValues, val);
    const equal = n - below - above; // basis values tied with val (0 when val isn't in the basis)
    const worseCount = equal > 0 ? below + (equal - 1) / 2 : below;
    return Math.min(100, (worseCount / (n - 1)) * 100);
}

// ==== Roto-style pool ranking For every scored category, percentile-rank each player against qualified same-role peers, average the percentiles (every category counts equally - standard Roto behavior), rank by that average. Sample size is handled three ways; only #3 is a leniency setting, #1 and #2 always apply because they correct what the numbers MEAN: 1. Playing-time shrinkage. Percentiles get pulled toward 50 proportional to how much less the player has played than the pool's leader (ctx.workloadOf; skipped entirely for RP pools - see ctx.isRpPool - because innings aren't comparable between true relievers and spot-starting swingmen, confirmed by Rasmussen/Holmes/Martinez outranking Chapman's 0.701-WHIP season on shrinkage alone). 2. Per-category opportunity gating (CATEGORY_OPPORTUNITY, via opportunityGateFor). 3. Hard exclusion (ctx.requireMinPlayingTime). Players under MIN_PLAYING_TIME_FRACTION of the pool leader's games (ctx.thresholdWorkloadOf - a role-neutral ACTIVITY measure, deliberately different from shrinkage's innings-based VALUE measure. No true reliever can clear 20% of a workhorse ace's innings, but any active reliever clears 20% of his games) don't get ranked at all. 4. Zero floor (NOT toggleable). A player with zero games is never ranked in either toggle state - see the candidatePlayers comment below for why shrinkage makes a zero score exactly 50 and why that has to be excluded rather than ranked. Critically, the COMPARISON BASIS is ALWAYS the qualified pool, regardless of #3 - a well-established player's score must never shift just because more or fewer marginal bench players are also being shown a rank. Toggling #3 off scores those marginal players by inserting them into that same fixed basis, it doesn't grow the basis itself. ctx: { relevantStatIds: string[] - scored ids for this pool's role, already data-filtered inverseStatIds: Set<string> - "lower is better" ids (ERA, WHIP, CS, E,...) rateStatIds: Set<string> - averaged (not summed) ids; a missing value stays absent, counting cats zero-fill instead (see isRateCategory) isRpPool: boolean - primary-role RP pool (no shrinkage, K as K/9, SV ungated) requireMinPlayingTime: boolean - the Minimum Games Played toggle workloadOf: p => number - shrinkage measure (GP for batters, IP for pitchers) thresholdWorkloadOf: p => number - hard-exclusion measure (games played for everyone) } ====
export function computeRotoRanks(groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, requireMinPlayingTime, workloadOf, thresholdWorkloadOf } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrinkFactor = p => isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(p) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    // Zero playing time is zero EVIDENCE, not average. Shrinkage pulls a percentile toward 50 by workload share, so a player who never played has shrinkFactor 0 and therefore scores EXACTLY 50 in every category no matter what - which floated the whole never-played cohort above every real player having a below-average season the moment the toggle came off. The toggle relaxes the THRESHOLD (a fraction of the leader's games); it never lets a zero through, so this floor applies in BOTH toggle states. With the toggle on it's already a no-op, since a nonzero threshold excludes zeros anyway. Deliberately EXACT zero only. 1-2 games is thin evidence but still evidence, and heavy shrinkage already blunts it - the owner can judge those cases with the toggle off. Guarded on maxThresholdWorkload, so a pool where NOBODY has played yet (preseason, or a freshly created league) still ranks on season projections instead of emptying the board.
    const candidateBase = requireMinPlayingTime ? qualifiedPlayers : groupPlayers;
    const candidatePlayers = maxThresholdWorkload > 0
        ? candidateBase.filter(p => thresholdWorkloadOf(p) > 0)
        : candidateBase;

    const percentileSum = new Map();
    const catCount = new Map();

    relevantStatIds.forEach(id => {
        const isRate = isRateCategory(id, isRpPool, rateStatIds);
        // The comparison basis is always drawn from the qualified pool only, never from candidatePlayers - see the function comment above. A counting cat ranks the WHOLE qualified pool (missing values read as 0); a rate cat only the players who posted one.
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

// Same math as computeRotoRanks, but for a single player - returns the full per-category breakdown (raw percentile, shrink-adjusted percentile) that gets averaged into their Rank score, so a drill-down can show exactly how the number was built. Categories the player has no real opportunity in are reported separately as "excluded" rather than silently dropped. ctx: computeRotoRanks' ctx plus statMap (id -> display name) for row labels.
export function computeCategoryBreakdown(player, groupPlayers, ctx) {
    const { relevantStatIds, inverseStatIds, rateStatIds, isRpPool, workloadOf, thresholdWorkloadOf, statMap } = ctx;

    const maxWorkload = Math.max(0, ...groupPlayers.map(workloadOf));
    const shrink = isRpPool ? 1 : (maxWorkload > 0 ? Math.min(1, workloadOf(player) / maxWorkload) : 1);

    const maxThresholdWorkload = Math.max(0, ...groupPlayers.map(thresholdWorkloadOf));
    const qualifyThreshold = maxThresholdWorkload * MIN_PLAYING_TIME_FRACTION;
    const qualifiedPlayers = maxThresholdWorkload > 0 ? groupPlayers.filter(p => thresholdWorkloadOf(p) >= qualifyThreshold) : groupPlayers;

    const included = [];
    const excluded = [];
    // Every branch below mirrors computeRotoRanks exactly (same basis, same value resolution, same gate) so the row percentiles reconstruct the leaderboard score - the avg returned here IS that score. A counting cat the player has no key for is now a real 0 row, not a skip.
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
    // qualifiedCount is the basis size the score was actually computed against (the pool that clears the min-games threshold), so the drill-down can label it honestly instead of citing the full group pool it does NOT rank against (: no more "of 942" when the basis was 731).
    return { rows: included, excluded, shrink, avg, qualifiedCount: qualifiedPlayers.length };
}

// ==== Single-stat ranking (drill-down stat chips) ====

// Rank playerId within pool on one stat. Competition ranking ("1-2-2-4") - ties in a raw stat total are common (two players with 30 HR each), and breaking them by sort-array position handed tied players different ranks (and different percentile tints) purely by luck of the sort order. Every value in a run of ties shares the rank of the run's first member; the next distinct value picks back up at its true positional rank. Rank 1 is always "best" - pass inverse=true for lower-is-better stats.
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

// FALLBACK basis (see buildWeeklyValueBasis above for the preferred one): peer "typical week" rate distributions per scored category, built from SEASON-AVERAGE rates rather than real weeks. Used only when the pool doesn't have enough real weekly data cached yet to build the preferred basis (players.js' buildWeeklyRateBasis decides which one to use, and why) - an averaged week has far less variance than a real one, which is exactly what made this basis read flat for everyday players (a real full week from a regular beat almost every peer's smoothed average, slump or not - see buildWeeklyValueBasis's comment for the full diagnosis). Rates are sorted ascending so scoring a week is a binary search rather than a linear scan. Rate stats (AVG, ERA, WHIP,... - ctx.avgStatIds) are already per-opportunity rates. A peer's "typical week" for those IS their timeframe rate, unchanged. Dividing a rate by the week count (as counting stats need) produced a nonsense basis (a 0.280 AVG became 0.028) that every real weekly value trivially beat, pinning rate categories at ~100 (or ~0 for lower-is-better ones) instead of measuring anything. ctx: { relevantStatIds, inverseStatIds, avgStatIds: Set, weeksElapsed: number }
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

// Peer REAL weekly-value distributions per scored category - the PREFERRED basis for scoreWeekAgainstBasis (see buildCategoryRateBasis's own comment for the superseded "typical week" approach). That approach compared a player's real, noisy week against peers' season averages, which have far less variance than any single real week - almost any full week from an everyday player beat almost every part-timer's smoothed average, slump or not, so only the rate categories (a minority of most scoring formats) still moved. Confirmed by a real report. A regular's Matchup Score chart read flat and high all season despite a real early slump. Scoring a week against the pool's OTHER REAL WEEKS instead keeps the comparison apples-to-apples - a cold week lands against other players' actual cold weeks and reads genuinely low. weeklyValuesByPlayer: [{ id, seasonTotals, weeks: [{ stats: {statId: value}, games },...] }] - seasonTotals is read ONLY for CATEGORY_OPPORTUNITY gating, which is deliberately a SEASON-level role signal (real save chances, real starts) - one spot-relief outing shouldn't count as "real bullpen opportunity" for that single week. - weeks is whatever real per-matchup-week entries the caller (players.js) has already selected for its window; this function doesn't know or care what the window is. - stats carries each week's own derived value per category - the real per-week RATE for rate categories (AVG, ERA,... - already computed by summing that single week's raw components, not by averaging a smoothed number) and the real per-week total for counting categories. Both are used exactly as given, unlike buildCategoryRateBasis's season-total / weeksElapsed division. A week with zero games played is excluded from the distribution entirely (per-player, at the call site below) - a bye/IL week is an absence, not a performance to be beaten, and letting a pile of literal zeros sit at the bottom of every counting category's distribution would make almost any real week look artificially great by comparison, reintroducing a milder version of the exact problem this basis exists to fix. ctx: { relevantStatIds, inverseStatIds, avgStatIds: Set }
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

        // Real per-WEEK values, not per-player - one busy player's five real weeks are five independent points in the distribution, not a single player-level average. That's exactly the variance the old typical-week basis was flattening away.
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

// One week's Matchup Score for one player: percentile of each scored category's real weekly value against a peer basis's rates, averaged with equal weight (same convention as computeRotoRanks). Basis-agnostic on purpose - categoryRates can come from either buildWeeklyValueBasis (preferred: real peer weeks) or buildCategoryRateBasis (fallback: typical peer weeks), since both produce the exact same { id, inverse, isRate, rates, opportunityOf, minOpportunity } shape. null when the week has no scoreable categories at all. partialWeekFraction (0..1] handles an IN-PROGRESS matchup. A counting stat from a half-played matchup would otherwise be compared against full-matchup peer rates and lose almost automatically, so it's compared "on pace" instead - the value scaled up by the elapsed fraction (equivalent to scaling every peer rate down by it). Rate stats are never prorated: a batting average from 3 days is already a rate.
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

// ==== Roto standings scoring (: the Roto Race) The ONLY place in the app that computes roto points rather than displaying ESPN's own - the season-end standings stay verbatim from the payload (see rotoPoints in data.js). Used to reconstruct the standings race over time from weekly roster stats, where ESPN gives no snapshot. Pure: no DOM, no AppState, no fetches. ====

// Roto points for ONE category across a set of teams. entries: [{ id, value }], value possibly undefined when a team posted nothing in this category. inverse = true when a LOWER value wins (GAA, losses,...). With n entries the best gets n points and the worst 1; a run of tied values shares the average of the positions it spans - which is exactly how ESPN's own pointsByStat reports halves (validated against the FGB captures, where a two-way tie for 2nd of 5 shows 3.5 each). A team with no value ranks below every team that has one, and several such teams tie at the bottom and split, so "didn't compete" never accidentally beats a real last-place value.
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
        // Positions i..j are 0-based; position k is worth (n - k) points. Average across the run.
        let pointSum = 0;
        for (let k = i; k <= j; k++) pointSum += (n - k);
        const shared = pointSum / (j - i + 1);
        for (let k = i; k <= j; k++) points.set(sorted[k].id, shared);
        i = j + 1;
    }
    return points;
}

// Roto points for a WHOLE WEEK across teams: each category scored independently, summed per team. teams: [{ id, values: { catId: number|undefined } }]. categories: [{ id, inverse }]. Returns Map id -> total roto points. Pure.
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

// PURE. The points-league equivalent of computeRotoRanks. It ranks by fantasy points scored. A points league needs no percentile machinery, because it already agrees on one number. Every stat carries a weight in the league's own scoringSettings.scoringItems, and the weighted sum IS the player's fantasy total. VALIDATED against a real 2026 NHL points league, summing stat x weight reproduced ESPN's own appliedTotal for all 1039 players in the pool, to the tenth. Computing it rather than reading appliedTotal is what lets the rank follow the timeframe pills. appliedTotal is a season figure ESPN publishes once; the same arithmetic over a windowed stat line gives the points scored in that window, so "Last 4 Matchups" ranks by the last four matchups instead of quietly re-showing the season. The minimum-playing-time machinery deliberately does NOT apply here. It exists because a rate category rewards a tiny sample, and points do the opposite. A player with three games has fewer points and already sits where he belongs. Only true zero evidence is withheld, matching computeRotoRanks' own floor, so a player who has not played reads as unranked rather than as tied last with everyone else who has not played. ctx: { weights, workloadOf } where weights maps statId to points per unit.
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

    // Descending points, and a tie is broken by id so the order is stable across re-renders rather than depending on whatever order the pool happened to arrive in.
    const ranked = groupPlayers.filter(p => scores.has(p.id))
        .sort((a, b) => (scores.get(b.id) - scores.get(a.id)) || (a.id - b.id));
    const ranks = new Map();
    ranked.forEach((p, i) => ranks.set(p.id, i + 1));

    return { scores, ranks, ranked, total: ranked.length };
}
