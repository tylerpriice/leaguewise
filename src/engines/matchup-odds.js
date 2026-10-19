/**
 * Who wins the matchup being played now, computed as a sum and never sampled, so the answer does
 * not move between reloads.
 *
 * Inside one matchup the question is asked per category. A category's chance is a normal tail
 * over the current gap and the spread of what is left to play. The matchup's chance is then the
 * exact sum over the category outcomes, under the league's own tie rule. A points league is one
 * margin. How well the figures hold up against played matchups is reported in
 * docs/MATCHUP-ODDS-VALIDATION.md.
 *
 * Categories of one matchup move together: a team having a good week tends to have it in several
 * at once. Where the caller says how much, the sum is taken given one factor the categories share,
 * and weighted over that factor. It is still a sum, with no draw in it.
 *
 * The caller reads the totals and the spreads and hands them in; this module reads no payload.
 *
 * Pure. No DOM, no application state, no storage, no network and no seed.
 *
 * Contract: tests/fixtures/matchup-odds.md
 * Tests: tests/matchup-odds.test.html
 * @module matchup-odds
 */
/**
 * One category's three chances. They sum to one.
 *
 * @typedef {object} CategoryChances
 * @property {number} chanceWin The chance of winning the category.
 * @property {number} chanceTie The chance it ends level.
 * @property {number} chanceLose The chance of losing it.
 */
import { normalCdf } from './leverage-engine.js';

const key = id => String(id);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ==== (a) One category ====

/**
 * One category's chance, from the gap between the two projected finals and the spread of the
 * margin.
 *
 * The gap is mine less theirs, and a lower-is-better category is turned round here and nowhere
 * else. The spread is the margin's own, not one side's. A category counted in whole units can end
 * level: its tie chance is the normal mass within half a unit of zero, with the win above that
 * band and the loss below. With no step there is no tie.
 *
 * @param {number} gap Mine less theirs, on the projected finals.
 * @param {number} sd The standard deviation of the margin.
 * @param {object} [options]
 * @param {boolean} [options.inverse=false] Whether lower wins the category.
 * @param {number} [options.step=0] The size of one unit for a counted category; 0 for a rate.
 * @returns {CategoryChances} The three chances.
 */
export function categoryChance(gap, sd, { inverse = false, step = 0 } = {}) {
    const effective = inverse ? -num(gap) : num(gap);
    const spread = num(sd);
    const half = num(step) > 0 ? num(step) / 2 : 0;
    if (!(spread > 0)) {
        // With nothing left to play the gap decides. A level gap on a counted category is a tie. With no step it is an even chance, which also avoids dividing by zero.
        if (half > 0) {
            const level = Math.abs(effective) < half;
            return { chanceWin: !level && effective > 0 ? 1 : 0, chanceTie: level ? 1 : 0, chanceLose: !level && effective < 0 ? 1 : 0 };
        }
        const chanceWin = effective > 0 ? 1 : (effective < 0 ? 0 : 0.5);
        return { chanceWin, chanceTie: 0, chanceLose: 1 - chanceWin };
    }
    if (!(half > 0)) {
        const chanceWin = normalCdf(effective / spread);
        return { chanceWin, chanceTie: 0, chanceLose: 1 - chanceWin };
    }
    // Winning and losing are each a tail and the tie is what is left between them, so the three sum to one by construction.
    const chanceWin = normalCdf((effective - half) / spread);
    const chanceLose = normalCdf((-effective - half) / spread);
    return { chanceWin, chanceTie: Math.max(0, 1 - chanceWin - chanceLose), chanceLose };
}

// ==== (b) The categories, summed exactly ====

/**
 * The matchup's chance from the categories' chances, as an exact sum. Only the difference between
 * categories won and lost is carried from one category to the next, so the cost grows with the
 * number of categories and not with the number of their outcomes. The chances handed in are
 * folded as independent of one another; matchupFold calls this once for each value of the factor
 * the categories share, which is where their moving together comes from.
 *
 * Under a tie rule that names a stat, a tied count is decided by that category's own outcome, and
 * stays a tie when that category tied too.
 *
 * @param {Array<{statId: *, chanceWin: number, chanceTie: number, chanceLose: number}>} perCategory Each category's chances.
 * @param {{rule: string, statId: *}} [tieRule] The league's matchup tie rule.
 * @returns {{chance: number, tie: number, lose: number}} The chances of winning, tying and losing the matchup.
 */
export function matchupTally(perCategory, tieRule) {
    const rows = (perCategory || []).filter(Boolean);
    const rule = tieRule && tieRule.rule === 'STAT_POINTS' && tieRule.statId !== null && tieRule.statId !== undefined
        ? key(tieRule.statId) : null;
    const decider = rule === null ? null : rows.find(r => key(r.statId) === rule) || null;

    // The distribution of wins less losses over every category except the decider.
    let dist = new Map([[0, 1]]);
    rows.forEach(row => {
        if (decider && row === decider) return;
        const w = num(row.chanceWin);
        const t = num(row.chanceTie);
        const l = row.chanceLose === undefined ? Math.max(0, 1 - w - t) : num(row.chanceLose);
        const next = new Map();
        const add = (d, p) => { if (p) next.set(d, (next.get(d) || 0) + p); };
        dist.forEach((p, d) => { add(d + 1, p * w); add(d, p * t); add(d - 1, p * l); });
        dist = next;
    });

    let chance = 0;
    let tie = 0;
    let lose = 0;
    // A tied count with no rule to break it is a tied matchup, which is a real result in these leagues.
    const settle = (d, p, deciderDid) => {
        if (d > 0) { chance += p; return; }
        if (d < 0) { lose += p; return; }
        if (deciderDid === 'win') chance += p;
        else if (deciderDid === 'lose') lose += p;
        else tie += p;
    };

    if (!decider) {
        dist.forEach((p, d) => settle(d, p, null));
    } else {
        const w = num(decider.chanceWin);
        const t = num(decider.chanceTie);
        const l = decider.chanceLose === undefined ? Math.max(0, 1 - w - t) : num(decider.chanceLose);
        dist.forEach((p, d) => {
            settle(d + 1, p * w, 'win');
            settle(d, p * t, 'tie');
            settle(d - 1, p * l, 'lose');
        });
    }
    return { chance, tie, lose };
}

// ==== The categories, sharing one factor ====

/**
 * How much the categories of one matchup move together, by sport, as the correlation between the
 * normals under any two categories. A sport with no entry folds its categories as independent.
 *
 * Measured, never fitted: the replay in docs/MATCHUP-ODDS-VALIDATION.md takes the correlation
 * between the results of every pair of categories against the chances this module gave them,
 * averages it over the pairs, and puts it on the normals' scale as sin(pi r / 2). Each figure
 * rests on one season of one league of six teams, and is measured again when a second season is
 * in hand.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const MATCHUP_RHO = Object.freeze({ fhl: 0.102, flb: 0.144 });

/**
 * How many values of the shared factor the fold is summed over. At twenty the win chance is
 * within one part in a hundred million of the same sum at eighty, on every prediction of the two
 * replayed seasons, which is closer than the normal tail itself is to its exact value.
 *
 * @type {number}
 */
export const FOLD_NODES = 20;

const nodeCache = new Map();

/**
 * The points and weights that turn an average over a standard normal into a short sum: the
 * Gauss-Hermite rule of the given size. The weights sum to one, and the sum is exact for every
 * polynomial of degree up to twice the size less one.
 *
 * The points are the roots of the Hermite polynomial of that degree, found by bisection between
 * the roots of the degree below, which they interlace. Computed once a size and kept.
 *
 * @param {number} count How many points.
 * @returns {Array<{z: number, weight: number}>} The points in rising order, each with its weight.
 */
export function hermiteNodes(count) {
    const n = Math.max(1, Math.floor(num(count)));
    if (nodeCache.has(n)) return nodeCache.get(n);
    const hermite = (degree, z) => {
        if (degree === 0) return 1;
        let before = 1;
        let value = z;
        for (let k = 1; k < degree; k += 1) {
            const next = z * value - k * before;
            before = value;
            value = next;
        }
        return value;
    };
    let roots = [];
    for (let degree = 1; degree <= n; degree += 1) {
        // Every root lies inside twice the root of the degree, so one past that is a safe edge.
        const edge = 2 * Math.sqrt(degree) + 1;
        const brackets = [-edge, ...roots, edge];
        const found = [];
        for (let i = 0; i < degree; i += 1) {
            let low = brackets[i];
            let high = brackets[i + 1];
            const below = hermite(degree, low) < 0;
            for (let step = 0; step < 80; step += 1) {
                const middle = (low + high) / 2;
                if ((hermite(degree, middle) < 0) === below) low = middle; else high = middle;
            }
            found.push((low + high) / 2);
        }
        roots = found;
    }
    let factorial = 1;
    for (let k = 2; k <= n; k += 1) factorial *= k;
    const nodes = roots.map(z => ({ z, weight: factorial / ((n * hermite(n - 1, z)) ** 2) }));
    nodeCache.set(n, nodes);
    return nodes;
}

/**
 * One category's three chances given a value of the factor the categories share.
 *
 * The category's margin is its own normal, and a share of that normal's spread is common to every
 * category: the share is rho of the variance. Given the factor, the margin is still normal, moved
 * by the factor and narrower by what the factor explains, so the chances are categoryChance's own
 * at a moved gap and a smaller spread. Averaged over the factor they are categoryChance's exactly.
 * A category with nothing left to play does not move.
 *
 * @param {number} gap Mine less theirs, on the projected finals.
 * @param {number} sd The standard deviation of the margin.
 * @param {object} [options] As categoryChance takes them: inverse and step.
 * @param {number} [rho=0] The correlation between the normals of any two categories, from 0 to 1.
 * @param {number} [z=0] The value of the shared factor, in standard deviations.
 * @returns {CategoryChances} The three chances given that value.
 */
export function categoryChanceGiven(gap, sd, { inverse = false, step = 0 } = {}, rho = 0, z = 0) {
    const spread = num(sd);
    const shared = Math.min(1, Math.max(0, num(rho)));
    if (!(spread > 0) || !(shared > 0)) return categoryChance(gap, sd, { inverse, step });
    const effective = inverse ? -num(gap) : num(gap);
    return categoryChance(effective + spread * Math.sqrt(shared) * num(z), spread * Math.sqrt(1 - shared), { step });
}

/**
 * The matchup's chance from the categories' gaps and spreads, with one factor shared between the
 * categories. Given the factor the categories are independent, so matchupTally's exact sum is
 * taken at each of a short list of values of it and the sums are weighted. No draw and no seed.
 *
 * With rho at zero this is matchupTally over categoryChance, to the digit.
 *
 * @param {Array<{statId: *, gap: number, sd: number, inverse: (boolean|undefined), step: (number|undefined)}>} categories
 *   Each category's gap, mine less theirs, the spread of its margin, whether lower wins it and the size of its unit.
 * @param {{rule: string, statId: *}} [tieRule] The league's matchup tie rule.
 * @param {object} [options]
 * @param {number} [options.rho=0] The correlation between the normals of any two categories.
 * @param {number} [options.nodes] How many values of the factor to sum over; FOLD_NODES when absent.
 * @returns {{chance: number, tie: number, lose: number}} The chances of winning, tying and losing the matchup.
 */
export function matchupFold(categories, tieRule, { rho = 0, nodes = FOLD_NODES } = {}) {
    const rows = (categories || []).filter(Boolean);
    const shared = Math.min(1, Math.max(0, num(rho)));
    const given = z => rows.map(c => ({
        statId: c.statId,
        ...categoryChanceGiven(c.gap, c.sd, { inverse: c.inverse === true, step: num(c.step) }, shared, z)
    }));
    if (!(shared > 0)) return matchupTally(given(0), tieRule);
    let chance = 0;
    let tie = 0;
    let lose = 0;
    hermiteNodes(nodes).forEach(node => {
        const at = matchupTally(given(node.z), tieRule);
        chance += node.weight * at.chance;
        tie += node.weight * at.tie;
        lose += node.weight * at.lose;
    });
    return { chance, tie, lose };
}

// ==== (c) The matchup ====

/**
 * The odds of one matchup, with the working beside the answer: every category carries both
 * projected finals, its gap and its spread, so a reader can check the figure.
 *
 * @param {object} [sides]
 * @param {object} sides.mine My side: per stat id, what is on the board, what the rest is expected to bring, and the spread of that remainder. In a points league, one such figure for the side.
 * @param {object} sides.theirs The other side, in the same shape.
 * @param {object} [rule]
 * @param {string} [rule.scoring] 'points' for a points league, 'category-record' for a format that scores each category as its own win; otherwise the categories are counted.
 * @param {Array<string|number>} [rule.scoredStatIds] The scored categories.
 * @param {Array<string|number>} [rule.inverseStatIds] The categories where lower wins.
 * @param {Array<string|number>} [rule.countingStatIds] The categories counted in whole units, which can end level.
 * @param {{rule: string, statId: *}} [rule.tie] The league's matchup tie rule.
 * @param {number} [rule.rho] How much the categories move together, read by the caller from MATCHUP_RHO for the league's sport. Absent or zero, the categories are folded as independent.
 * @param {number} [rule.nodes] How many values of the shared factor to sum over; FOLD_NODES when absent.
 * @returns {{chance: number, tie: number, lose: number, perCategory: object[], gap: (number|undefined), sd: (number|undefined), projectedMine: (number|undefined), projectedTheirs: (number|undefined)}}
 *   The matchup's chances and the categories' own. A points league has no categories and carries
 *   its one gap and spread on the result. A category's own chances are the same whatever rho is;
 *   rho changes only how they combine.
 */
export function matchupOdds({ mine, theirs } = {}, rule = {}) {
    const projected = side => num(side && side.current) + num(side && side.expectedRemaining);
    const combinedSd = (a, b) => Math.sqrt(num(a && a.sd) ** 2 + num(b && b.sd) ** 2);

    // A points league is one figure: one normal margin over the two projected totals, with no categories listed.
    if (rule.scoring === 'points') {
        const gap = projected(mine) - projected(theirs);
        const sd = combinedSd(mine, theirs);
        const { chanceWin } = categoryChance(gap, sd);
        return {
            chance: chanceWin,
            tie: 0,
            lose: 1 - chanceWin,
            perCategory: [],
            gap,
            sd,
            projectedMine: projected(mine),
            projectedTheirs: projected(theirs)
        };
    }

    const inverse = new Set((rule.inverseStatIds || []).map(key));
    // The caller says which categories are counted in whole units, since this module knows no stat id. A league that names none has a tie chance of zero throughout.
    const counting = new Set((rule.countingStatIds || []).map(key));
    const perCategory = (rule.scoredStatIds || []).map(key).map(statId => {
        const a = (mine || {})[statId];
        const b = (theirs || {})[statId];
        const projectedMine = projected(a);
        const projectedTheirs = projected(b);
        const isInverse = inverse.has(statId);
        const raw = projectedMine - projectedTheirs;
        const sd = combinedSd(a, b);
        const { chanceWin, chanceTie, chanceLose } = categoryChance(raw, sd,
            { inverse: isInverse, step: counting.has(statId) ? 1 : 0 });
        return {
            statId,
            // The gap is reported in the direction that wins, which for a lower-is-better category is theirs less mine.
            gap: isInverse ? -raw : raw,
            sd,
            projectedMine,
            projectedTheirs,
            inverse: isInverse,
            chanceWin,
            chanceTie,
            chanceLose
        };
    });

    // A format that scores each category as its own win has no count to tie, so the matchup figure is the mean of the category chances, and its tie is the mean of theirs.
    if (rule.scoring === 'category-record') {
        const meanOf = field => (perCategory.length
            ? perCategory.reduce((s, c) => s + c[field], 0) / perCategory.length : 0);
        const mean = meanOf('chanceWin');
        const tie = meanOf('chanceTie');
        return { chance: mean, tie, lose: 1 - mean - tie, perCategory };
    }

    // With no rho the fold is the independent one, by the same call as ever and so to the digit.
    if (!(num(rule.rho) > 0)) {
        const { chance, tie, lose } = matchupTally(perCategory, rule.tie);
        return { chance, tie, lose, perCategory };
    }
    // The gap on a category is already in the direction that wins, so nothing is turned round twice.
    const shared = matchupFold(
        perCategory.map(c => ({ statId: c.statId, gap: c.gap, sd: c.sd, step: counting.has(c.statId) ? 1 : 0 })),
        rule.tie, { rho: num(rule.rho), nodes: rule.nodes });
    return { chance: shared.chance, tie: shared.tie, lose: shared.lose, perCategory };
}
