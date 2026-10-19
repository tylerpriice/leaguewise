/**
 * Category margins and flip leverage: how wide the weekly margin in each category is, and how
 * often one player's week decides it.
 *
 * A head-to-head categories league is won by winning categories, and the margins are not alike:
 * some are decided by a dozen and some by one. A percentile says how good a player is at a
 * category; leverage says how often the player's week turns it.
 *
 * The margins are derived, not read from played matchups, so a new league has them and two
 * identical leagues agree. Three assumptions carry the derivation: a roster is an even draw from
 * the draftable range, player-weeks are independent, and a margin is normal. How far each misses
 * is reported in docs/LEVERAGE-VALIDATION.md.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Tests: tests/leverage-engine.test.html
 * @module leverage-engine
 */
/**
 * A mean and a variance, the form every weekly figure takes here, whether it came from played
 * weeks or from a projection.
 *
 * @typedef {object} Moments
 * @property {number} mean The mean.
 * @property {number} variance The variance.
 * @property {number} [n] How many samples or players it was taken over. 0 for a projection.
 */
import { rosterTotals } from './draft-engine.js';


// ==== The normal distribution ====

/**
 * The standard normal's cumulative distribution, by Abramowitz and Stegun's approximation
 * 26.2.17, with an error under 7.5e-8.
 *
 * @param {number} z The standard score.
 * @returns {number} The mass below z. Exactly 0.5 at zero.
 */
export function normalCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    // The approximation is not exact at the centre, and the centre must be exact: a player who contributes nothing has to reach exactly nothing.
    if (z === 0) return 0.5;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

/**
 * The half-width, in standard deviations, that holds half the mass of a normal centred on zero.
 * It turns a margin's spread into a predicted median margin.
 *
 * @type {number}
 */
export const MEDIAN_Z = 0.6744897501960817;

// ==== Per-player weekly production ====

// One code path, two sources. In season a player's weekly values are known; before one there is only a projected season line. Both arrive as a mean and a variance, so nothing downstream can tell them apart.

/**
 * The mean and variance of a player's real weekly values. The variance is the unbiased estimate,
 * since the weeks played are a sample of the player's weeks.
 *
 * @param {number[]} samples The weekly values.
 * @returns {?Moments} Null for no values. One value gives a variance of 0.
 */
export function weeklyMoments(samples) {
    const xs = (samples || []).filter(v => Number.isFinite(v));
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (xs.length < 2) return { mean, variance: 0, n: xs.length };
    const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    return { mean, variance: ss / (xs.length - 1), n: xs.length };
}

/**
 * A projected season total as a weekly mean and variance, scaled to the league's own matchup
 * count.
 *
 * The variance is taken equal to the mean, as for a Poisson count, since a season total says
 * nothing about spread. That understates the spread of high-volume categories, where a week's
 * count follows the games played. Real weekly values replace it once a season has any.
 *
 * @param {?number} seasonTotal The projected season total.
 * @param {number} matchups How many matchups the league plays.
 * @returns {?Moments} Null for no projection or no matchups.
 */
export function projectedMoments(seasonTotal, matchups) {
    // Number(null) is 0, which is finite, so the missing case is tested first. A player with no projection is unmeasured, not projected to produce nothing.
    if (seasonTotal === null || seasonTotal === undefined || seasonTotal === '') return null;
    const total = Number(seasonTotal);
    const m = Number(matchups);
    if (!Number.isFinite(total) || !Number.isFinite(m) || m <= 0) return null;
    const mean = total / m;
    return { mean, variance: Math.max(mean, 0), n: 0 };
}

// ==== From players to a team, and from a team to a margin ====

/**
 * The distribution of one player-week drawn at random from the draftable range. Its variance has
 * two parts and both belong: how much a player's own weeks vary, averaged, and how much the
 * players' means differ, as a population variance.
 *
 * @param {Moments[]} perPlayer Each player's weekly moments.
 * @returns {?Moments} Null for no players.
 */
export function poolMoments(perPlayer) {
    const list = (perPlayer || []).filter(m => m && Number.isFinite(m.mean));
    if (!list.length) return null;
    const mean = list.reduce((a, m) => a + m.mean, 0) / list.length;
    const within = list.reduce((a, m) => a + (Number.isFinite(m.variance) ? m.variance : 0), 0) / list.length;
    const between = list.reduce((a, m) => a + (m.mean - mean) * (m.mean - mean), 0) / list.length;
    return { mean, variance: within + between, n: list.length };
}

/**
 * A team's weekly total in a category: one independent draw per seat. Count only the seats that
 * can score the category.
 *
 * @param {Moments} pool The pool's moments.
 * @param {number} seats How many seats score the category.
 * @returns {?{mean: number, variance: number}} Null for no pool or no seats.
 */
export function teamTotalMoments(pool, seats) {
    const n = Number(seats);
    if (!pool || !Number.isFinite(n) || n <= 0) return null;
    return { mean: n * pool.mean, variance: n * pool.variance };
}

/**
 * The standard deviation of the margin between two teams drawn independently. The margin is
 * centred on zero and carries both teams' variance.
 *
 * @param {{variance: number}} teamMoments One team's moments.
 * @returns {?number} The standard deviation, or null for no usable variance.
 */
export function marginSd(teamMoments) {
    if (!teamMoments || !Number.isFinite(teamMoments.variance) || teamMoments.variance < 0) return null;
    return Math.sqrt(2 * teamMoments.variance);
}

/**
 * The standard deviation of the margin in a rate category. A team's rate is its components summed
 * and the formula then applied, so its spread is the components' spread carried through the
 * formula by the delta method.
 *
 * The gradient is taken numerically, by central difference, so it reads whatever formula the rate
 * table holds. The covariance between components is required: hits and at-bats move together.
 *
 * @param {object} args
 * @param {string|number} args.categoryId The rate category.
 * @param {object[]} args.rateSpecs How each rate is built from components.
 * @param {Array<string|number>} args.componentIds The components the rate needs.
 * @param {Object<string, number>} args.componentMeans One player-week's mean in each component.
 * @param {Object<string, Object<string, number>>} args.componentCov One player-week's covariance between components.
 * @param {number} args.seats How many seats score the category.
 * @returns {?number} The standard deviation. Null when the rate cannot be evaluated, and 0 when there is no spread.
 */
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
        // The step is relative to the value itself, so components on different scales get a comparable step. The floor keeps a zero component alive.
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

/**
 * The chance a category is decided by less than a player's week: the mass of the margin within
 * that distance of zero.
 *
 * @param {number} shift What the player moves the category by in a week.
 * @param {number} sd The margin's standard deviation.
 * @returns {?number} The chance, 0 to 1, or null without a positive spread.
 */
export function reach(shift, sd) {
    const x = Math.abs(Number(shift));
    const s = Number(sd);
    if (!Number.isFinite(x) || !Number.isFinite(s) || s <= 0) return null;
    return 2 * normalCdf(x / s) - 1;
}

/**
 * The chance a player's week turns a loss in a category into a win: the mass of the margin between
 * that week below zero and zero. For a symmetric margin it is half the reach, and it is the figure
 * value is built on.
 *
 * @param {number} shift What the player moves the category by in a week.
 * @param {number} sd The margin's standard deviation.
 * @returns {?number} The chance, or null without a positive spread.
 */
export function flipChance(shift, sd) {
    const r = reach(shift, sd);
    return r === null ? null : r / 2;
}

/**
 * One category's signed contribution to a player's value. The sign is the direction the player
 * moves the category for the team: the shift's own sign, reversed when the category is
 * lower-is-better.
 *
 * @param {number} shift What the player moves the category by in a week.
 * @param {number} sd The margin's standard deviation.
 * @param {object} [options]
 * @param {boolean} [options.inverse=false] Whether lower is better in the category.
 * @returns {?{flip: number, reach: number, shift: number, sd: number, direction: number}} Null without a positive spread.
 */
export function categoryFlip(shift, sd, { inverse = false } = {}) {
    const magnitude = flipChance(shift, sd);
    if (magnitude === null) return null;
    const direction = (Number(shift) < 0 ? -1 : 1) * (inverse ? -1 : 1);
    return { flip: direction * magnitude, reach: reach(shift, sd), shift: Number(shift), sd, direction };
}

/**
 * A player's value: the categories the player is expected to flip in a week, summed. A category
 * the player cannot be measured in adds nothing and is not counted.
 *
 * @param {Array<{categoryId: (string|number), flip: number}>} entries One entry per category.
 * @returns {?{total: number, counted: number, byCategory: Object<string, number>}} Null when no category could be measured.
 */
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

// ==== What a player shifts ====

/**
 * What a player moves a counting category by: the player's week less the week of the player
 * displaced. With a baseline of 0 it is the raw contribution, which is not a value.
 *
 * @param {?number} playerMean The player's weekly mean.
 * @param {number} [baselineMean=0] The displaced player's weekly mean.
 * @returns {?number} The shift, or null for an unmeasured player.
 */
export function countingShift(playerMean, baselineMean = 0) {
    if (playerMean === null || playerMean === undefined || playerMean === '') return null;
    const x = Number(playerMean);
    if (!Number.isFinite(x)) return null;
    const b = Number(baselineMean);
    return x - (Number.isFinite(b) ? b : 0);
}

/**
 * What a player moves a team's rate by. A player pulls the rate toward the player's own, by the
 * share of the denominator the player holds.
 *
 * @param {object} args
 * @param {number} args.playerRate The player's rate.
 * @param {number} args.teamRate The team's rate.
 * @param {number} args.playerWeight The player's part of the denominator.
 * @param {number} args.teamWeight The denominator the share is taken of.
 * @returns {?number} The shift, or null when a figure is missing or the denominator is not positive.
 */
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
