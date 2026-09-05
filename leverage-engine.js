import { rosterTotals } from './draft-engine.js';

// PURE. No DOM, no AppState, no fetches - same contract as rank-engine.js and draft-engine.js, and for the same reason: this is the only way the maths gets unit tests (golden rule 5). --------------------------------------------------------------------------------------------- WHAT THIS ANSWERS, AND WHY PERCENTILE EDGES CANNOT --------------------------------------------------------------------------------------------- A head-to-head categories league is won by WINNING CATEGORIES, and a category is won by a margin. Those margins are not alike. Measured on the owner's own league, the median weekly margin runs 15.5 strikeouts and 13.5 assists at one end and ONE caught stealing at the other - two-thirds of that league's caught-stealing categories were decided by a single runner. A percentile edge cannot see any of it: it says a player is in the 90th percentile of a category and stops, as though a 90th-percentile week of assists and a 90th-percentile week of caught stealing were the same asset. One is a drop in deep water. The other decides the category. So the question here is not "how good is this player at the category" but "how often does it in a week DECIDE it". Leverage is that probability. A player's value is the sum of it across the league's categories: expected category flips per week. --------------------------------------------------------------------------------------------- DERIVED, NOT MEASURED - the determinism requirement --------------------------------------------------------------------------------------------- The margins could be read off a league's completed matchups. They are NOT, and that is deliberate (owner's ruling, ): a brand-new league has no matchups, and two identical leagues must produce identical numbers. So the margin distribution is DERIVED from the player pool and the league's own roster shape: a team's weekly category total = the sum of its rostered players' weekly outputs the margin between two teams = the difference of two such sums which needs only per-player weekly production and the number of seats. A league's real matchups then become the VALIDATION rather than the input - see docs/LEVERAGE-VALIDATION.md, which reports this derivation against two real leagues' completed seasons. --------------------------------------------------------------------------------------------- THE ASSUMPTIONS, STATED WHERE THEY ARE MADE --------------------------------------------------------------------------------------------- 1. A roster is an even draw from the DRAFTABLE RANGE. Which players a typical team holds is itself an assumption; the defensible default is that every team fills its seats from the top (roster capacity x teams) players, each equally likely. It is the same range the draft board already draws its photographs and its replacement level from, so the two agree by construction. Its cost is measured: it OVER-states the spread in categories real managers deliberately balance (saves, where every team buys a closer or two) because random assignment spreads scarce production more unevenly than drafting does. 2. Player-weeks are independent of each other. Two batters on one roster do have a common schedule, so this understates a team's week-to-week swing slightly. 3. The margin is normal. It is a sum of nine to fifteen player-weeks minus another such sum, so the central limit theorem is doing honest work here, and the validation bears it out. None of these is tuned to fit. Where the derivation misses, the report says by how much.

// ==== The normal distribution ====

// Abramowitz & Stegun 26.2.17, |error| < 7.5e-8 - far tighter than anything the inputs deserve and no dependency, which matters in a repo with no build step. Not Math.erf: there isn't one.
export function normalCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    // The approximation is not exact at the centre - it returns 0.5000000005 - and the centre is the one point that must be exact, because reach() subtracts it from itself: a player who contributes nothing has to reach exactly nothing, not a billionth of a category.
    if (z === 0) return 0.5;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

// The half-width that holds half the mass of a zero-centred normal: 0.6745 sigma. Quoted so the report can state a predicted MEDIAN margin, which is the form a league's own matchups come in.
export const MEDIAN_Z = 0.6744897501960817;

// ==== Per-player weekly production ====

// ONE CODE PATH, TWO SOURCES. In-season a player's weekly values are known and are used directly; before a season is played there is only a projected season line. Both arrive here as {mean, variance} and nothing downstream can tell them apart, which is what stops the pre-season board and the in-season board from drifting into two different models of the same league.

// Real weekly values. The variance is the UNBIASED (n-1) estimate, because these samples are a sample of that player's weeks and the estimand is the underlying weekly variance - not the spread of the fifteen weeks that happen to have been played.
export function weeklyMoments(samples) {
    const xs = (samples || []).filter(v => Number.isFinite(v));
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (xs.length < 2) return { mean, variance: 0, n: xs.length };
    const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    return { mean, variance: ss / (xs.length - 1), n: xs.length };
}

// A projected season line, scaled to the league's own matchup count. POISSON, AND SAID OUT LOUD. A season total gives a mean and says nothing whatever about spread, so the spread has to come from somewhere. Counting stats are counts of independent events, whose natural distribution is Poisson, where the variance IS the mean - it is the assumption that invents the least. It is also the weakest link in the pre-season path and its cost is measured rather than guessed: real weekly variance/mean runs 1.0 for home runs, caught stealing and saves (Poisson is right there) but 2.8 for strikeouts and 6.8 for faceoffs won, because a big weekly count is dominated by how many GAMES the player got that week rather than by the count itself. So the pre-season path understates the spread of high-volume categories. Full table in docs/LEVERAGE-VALIDATION.md. Real weekly data supersedes this the moment a season has any.
export function projectedMoments(seasonTotal, matchups) {
    // Not Number(seasonTotal) alone: Number(null) is 0, which is finite, so a player with NO projection would come back projected to produce nothing rather than being unmeasurable - the unknown-is-not-zero rule, at the one place the type system cannot help.
    if (seasonTotal === null || seasonTotal === undefined || seasonTotal === '') return null;
    const total = Number(seasonTotal);
    const m = Number(matchups);
    if (!Number.isFinite(total) || !Number.isFinite(m) || m <= 0) return null;
    const mean = total / m;
    return { mean, variance: Math.max(mean, 0), n: 0 };
}

// ==== From players to a team, and from a team to a margin ====

// The distribution of ONE randomly drawn player-week from the draftable range. Law of total variance: a random player-week varies both because players differ from each other and because a player differs from himself week to week, and BOTH belong in a team's spread. Dropping the second term (the mistake worth naming, because it looks like the obvious one) would model a league in which every player produces their own average every week, whose margins are far too tight. The within-player term averages each player's own weekly variance. The between-player term is the POPULATION variance of their means - the draftable range is not a sample of anything, it is the whole population a roster is drawn from.
export function poolMoments(perPlayer) {
    const list = (perPlayer || []).filter(m => m && Number.isFinite(m.mean));
    if (!list.length) return null;
    const mean = list.reduce((a, m) => a + m.mean, 0) / list.length;
    const within = list.reduce((a, m) => a + (Number.isFinite(m.variance) ? m.variance : 0), 0) / list.length;
    const between = list.reduce((a, m) => a + (m.mean - mean) * (m.mean - mean), 0) / list.length;
    return { mean, variance: within + between, n: list.length };
}

// A team's weekly total: `seats` independent draws. Only the seats that can SCORE the category count - a league's seven pitching seats contribute nothing to home runs, and counting them would inflate every batting margin by the square root of nearly two.
export function teamTotalMoments(pool, seats) {
    const n = Number(seats);
    if (!pool || !Number.isFinite(n) || n <= 0) return null;
    return { mean: n * pool.mean, variance: n * pool.variance };
}

// Two teams, drawn independently: the margin is centred on zero and carries both teams' variance.
export function marginSd(teamMoments) {
    if (!teamMoments || !Number.isFinite(teamMoments.variance) || teamMoments.variance < 0) return null;
    return Math.sqrt(2 * teamMoments.variance);
}

// The margin a RATE category is decided by. A team batting average is not a sum and cannot be treated as one - adding nine batting averages together produces a number with no meaning. A team rate is its components summed and the formula then applied, so the rate's spread comes from its components' spread, propagated through the formula (the delta method: the variance of f(X) about its mean is grad(f)' COV grad(f)). The gradient is taken NUMERICALLY, by central difference on the team's own component means. Deriving it by hand would mean a hand-written derivative per formula in RATE_COMPONENTS, and those formulas are validated data, not code - OPS alone is a sum of two ratios over six components. A numeric gradient reads whatever the table says and cannot fall out of step with it. The component covariance matters and is not optional: hits and at-bats move together, so treating them as independent overstates a batting-average margin badly.
export function rateMarginSd({ categoryId, rateSpecs, componentIds, componentMeans, componentCov, seats }) {
    const ids = (componentIds || []).map(String);
    const n = Number(seats);
    if (!ids.length || !Number.isFinite(n) || n <= 0) return null;

    const teamMeans = {};
    ids.forEach(id => { teamMeans[id] = n * (Number(componentMeans[id]) || 0); });
    const evaluate = sums => {
        const out = rosterTotals([sums], [String(categoryId)], rateSpecs)[String(categoryId)];
        return Number.isFinite(out) ? out : null;
    };
    if (evaluate(teamMeans) === null) return null;

    const grad = ids.map(id => {
        // Step relative to the value itself, so a component measured in outs and one measured in hits both get a step that means the same thing. The floor keeps a zero component alive.
        const h = Math.max(Math.abs(teamMeans[id]) * 1e-5, 1e-6);
        const up = { ...teamMeans, [id]: teamMeans[id] + h };
        const dn = { ...teamMeans, [id]: teamMeans[id] - h };
        const a = evaluate(up);
        const b = evaluate(dn);
        return (a === null || b === null) ? 0 : (a - b) / (2 * h);
    });

    let variance = 0;
    for (let i = 0; i < ids.length; i++) {
        for (let j = 0; j < ids.length; j++) {
            const cov = (componentCov[ids[i]] && Number(componentCov[ids[i]][ids[j]])) || 0;
            variance += grad[i] * grad[j] * n * cov;
        }
    }
    return variance > 0 ? Math.sqrt(2 * variance) : 0;
}

// ==== Leverage ====

// TWO NUMBERS, BECAUSE THEY ANSWER TWO QUESTIONS AND DIFFER BY A FACTOR OF TWO. REACH is P(|margin| < the player's week): the chance the category is decided by less than that, which is the honest way to say "this category is within reach". It is the form the owner's hand measurement took - a 1.68-steals-a-week player against a league whose steal margins are one or nothing a third of the time. FLIP is P(-that week < margin <= 0): the chance the player's presence turns a loss into a win. It is what the player is actually WORTH, because a category the team wins anyway is worth nothing extra and only half of the reachable margins were going the wrong way. For a symmetric margin it is exactly half the reach, so the two rank players identically; they differ only in what they mean, and value must be built on the one that means something.
export function reach(shift, sd) {
    const x = Math.abs(Number(shift));
    const s = Number(sd);
    if (!Number.isFinite(x) || !Number.isFinite(s) || s <= 0) return null;
    return 2 * normalCdf(x / s) - 1;
}

export function flipChance(shift, sd) {
    const r = reach(shift, sd);
    return r === null ? null : r / 2;
}

// One category's signed contribution to a player's value. THE SIGN IS NOT THE CATEGORY'S POLARITY, IT IS THE DIRECTION THE PLAYER MOVES IT. A counting category only ever goes up when a player contributes to it, so in an inverse one - caught stealing, errors - that contribution flips it AGAINST the team and the sign is negative. A rate is different: a pitcher pulls the team's earned-run average toward their own, so a good pitcher moves an inverse category the GOOD way. Both cases fall out of one rule: the shift's own sign, flipped when the category is inverse.
export function categoryFlip(shift, sd, { inverse = false } = {}) {
    const magnitude = flipChance(shift, sd);
    if (magnitude === null) return null;
    const direction = (Number(shift) < 0 ? -1 : 1) * (inverse ? -1 : 1);
    return { flip: direction * magnitude, reach: reach(shift, sd), shift: Number(shift), sd, direction };
}

// A player's value: the categories they are expected to flip in a week, summed. A category a player cannot be measured in contributes NOTHING - not zero, which would be a claim of being exactly replacement level there, and not a penalty. This is the same unknown-is-not-zero rule the rank engine and the draft board already hold to, and it is why a pitcher does not lose value for having no fielding line.
export function flipsPerWeek(entries) {
    let total = 0;
    let counted = 0;
    const byCategory = {};
    (entries || []).forEach(e => {
        if (!e || !Number.isFinite(e.flip)) return;
        byCategory[e.categoryId] = e.flip;
        total += e.flip;
        counted++;
    });
    return counted ? { total, counted, byCategory } : null;
}

// ==== What a player actually shifts ====

// ONE PLAYER'S WEEK MINUS THE WEEK OF THE PLAYER DISPLACED. A roster spot is not empty before it is filled. Rostering a batter who steals two bases a week in place of one who steals one is worth one base, not two, and reading the raw total as the shift would value every draftable player as though the alternative were a corpse. The baseline is the same replacement level the draft board already ranks against, so the two value models answer the same question and can be compared directly. Pass baseline 0 to get the raw contribution instead. That is the form the owner's hand measurement took and the form the validation report reconciles against; it is not a value.
export function countingShift(playerMean, baselineMean = 0) {
    if (playerMean === null || playerMean === undefined || playerMean === '') return null;
    const x = Number(playerMean);
    if (!Number.isFinite(x)) return null;
    const b = Number(baselineMean);
    return x - (Number.isFinite(b) ? b : 0);
}

// A rate is already marginal, so there is nothing to subtract. A player does not ADD to a team rate but PULLS it toward their own, by as much of it as they own: a batter taking a fifth of the team's at-bats moves its average a fifth of the way toward theirs. That is a shift relative to the team joined, which is what the counting case has to build by subtraction. Weight is that share of the denominator - the at-bats, the outs, the shots faced - so a part-time player with a spectacular rate correctly moves almost nothing.
export function rateShift({ playerRate, teamRate, playerWeight, teamWeight }) {
    const given = [playerRate, teamRate, playerWeight, teamWeight];
    if (given.some(v => v === null || v === undefined || v === '')) return null;
    const pr = Number(playerRate);
    const tr = Number(teamRate);
    const pw = Number(playerWeight);
    const tw = Number(teamWeight);
    if (![pr, tr, pw, tw].every(Number.isFinite) || tw <= 0) return null;
    return (pw / tw) * (pr - tr);
}
