/**
 * How often a player's week wins a category, measured against the margins this league decides
 * its categories by, and the rank that gives each player in a pool.
 *
 * Pure. No DOM, no application state and no network. Every table arrives as an argument.
 *
 * The margins are measured from matchups that were played. A league with too few of them gets a
 * refusal with a reason, never an estimate from another model.
 *
 * Contract: tests/fixtures/matchup-rank.md
 * @module matchup-rank
 */
import { countingShift, rateShift, categoryFlip, flipsPerWeek } from './leverage-engine.js';
import { competitionRanks } from './rank-engine.js';
import { seasonFormat } from './history.js';

/**
 * The fewest decided matchup periods a league needs before its margins are measured. Below this
 * the spread of a category is noise.
 * @type {number}
 */
export const MIN_DECIDED_MATCHUPS = 4;

const num = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// The root mean square and not a standard deviation. A margin is the difference of two draws from one distribution, so its mean is zero by construction.
const rms = (xs) => (xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : null);

/**
 * Measures each scored category's weekly margin from the league's own decided matchups.
 *
 * @param {object} payload The league payload, with its schedule and each side's box score.
 * @param {object} ctx The sport's knowledge, which a pure module holds none of.
 * @param {string[]} ctx.categoryIds The scored stat ids to measure, already one player group.
 * @param {Set<string>} [ctx.rateStatIds] Which of those are rates.
 * @param {function(string): string[]} [ctx.weightIdsFor] The denominator stat ids of a rate.
 * @returns {{margins: ?{matchups: number, pairings: number, teamWeeks: number, byId: Object<string, {marginSd: number, teamRate: ?number, teamWeight: ?number}>}, reason: ?string}}
 *   The margins, or null with a reason of "roto", "points" or "too-few-matchups".
 */
export function leagueMargins(payload, ctx) {
    const format = seasonFormat(payload);
    // A roto league has no weekly matchup and a points league scores no categories, so both are answered before anything is read.
    if (format === 'roto') return { margins: null, reason: 'roto' };
    if (format === 'points') return { margins: null, reason: 'points' };

    const ids = (ctx && ctx.categoryIds) || [];
    const rates = (ctx && ctx.rateStatIds) || new Set();
    const weightIdsFor = (ctx && ctx.weightIdsFor) || (() => []);

    const byCat = new Map(ids.map((id) => [id, []]));
    const sides = [];
    const periods = new Set();
    let pairings = 0;

    (payload && payload.schedule ? payload.schedule : []).forEach((m) => {
        if (!m || !m.winner || m.winner === 'UNDECIDED') return;
        const h = m.home && m.home.cumulativeScore && m.home.cumulativeScore.scoreByStat;
        const a = m.away && m.away.cumulativeScore && m.away.cumulativeScore.scoreByStat;
        if (!h || !a) return;
        // Periods and pairings are different counts. The period count divides a season total into weeks, and the pairings are the sample of margins.
        periods.add(m.matchupPeriodId);
        pairings += 1;
        sides.push(h, a);
        ids.forEach((id) => {
            const hv = num(h[id] && h[id].score);
            const av = num(a[id] && a[id].score);
            if (hv !== null && av !== null) byCat.get(id).push(hv - av);
        });
    });

    const matchups = periods.size;
    if (matchups < MIN_DECIDED_MATCHUPS) return { margins: null, reason: 'too-few-matchups' };

    const sideValues = (id) => sides.map((s) => num(s[id] && s[id].score)).filter((v) => v !== null);

    const byId = {};
    ids.forEach((id) => {
        const marginSd = rms(byCat.get(id) || []);
        if (marginSd === null) return;
        let teamRate = null;
        let teamWeight = null;
        if (rates.has(id)) {
            // A rate's margin is measured from decided matchups like any count, since the box score carries each rate per team per matchup.
            teamRate = mean(sideValues(id));
            const w = weightIdsFor(id) || [];
            teamWeight = mean(sides.map((s) => w.reduce((t, c) => t + (num(s[c] && s[c].score) || 0), 0)));
        }
        byId[id] = { marginSd, teamRate, teamWeight };
    });

    return { margins: { matchups, pairings, teamWeeks: sides.length, byId }, reason: null };
}

/**
 * A player's expected category wins per week against the league's margins, with the breakdown by
 * category behind it.
 *
 * @param {{id: *, seasonTotals: Object<string, number>}} player The player's season totals by stat id.
 * @param {object} margins The margins leagueMargins measured.
 * @param {object} ctx The sport's knowledge.
 * @param {string[]} ctx.categoryIds The scored stat ids.
 * @param {Set<string>} [ctx.rateStatIds] Which of those are rates.
 * @param {Set<string>} [ctx.inverseStatIds] Which are won by the lower figure.
 * @param {function(string): string[]} [ctx.weightIdsFor] The denominator stat ids of a rate.
 * @returns {?{winsPerWeek: number, counted: number, byCategory: Array<{id: string, perWeek: number, marginSd: number, wins: number}>}}
 *   Null when no category could be measured.
 */
export function playerWinsPerWeek(player, margins, ctx) {
    if (!player || !margins || !margins.byId) return null;
    const totals = player.seasonTotals || {};
    const ids = (ctx && ctx.categoryIds) || [];
    const rates = (ctx && ctx.rateStatIds) || new Set();
    const inverse = (ctx && ctx.inverseStatIds) || new Set();
    const weightIdsFor = (ctx && ctx.weightIdsFor) || (() => []);
    const { matchups } = margins;
    if (!(matchups > 0)) return null;

    const entries = [];
    const byCategory = [];

    ids.forEach((id) => {
        const m = margins.byId[id];
        if (!m || !(m.marginSd > 0)) return;

        let shift = null;
        let perWeek = null;

        if (rates.has(id)) {
            // A player does not add to a team rate. The player's rate pulls it, by the player's share of the combined denominator, the team's plus the player's own.
            const playerRate = num(totals[id]);
            const w = weightIdsFor(id) || [];
            const playerWeight = w.reduce((t, c) => t + (num(totals[c]) || 0), 0) / matchups;
            if (playerRate === null || !(playerWeight > 0) || m.teamRate === null || m.teamWeight === null) return;
            perWeek = playerRate;
            shift = rateShift({
                playerRate,
                teamRate: m.teamRate,
                playerWeight,
                teamWeight: m.teamWeight + playerWeight
            });
        } else {
            // The season total over the league's matchup count, since a player's own weeks played are not in the data. A player who missed half the season is measured at half the weekly line.
            const total = num(totals[id]);
            if (total === null) return;
            perWeek = total / matchups;
            // The baseline is zero and not a replacement player. The question is what this week is worth against the margin.
            shift = countingShift(perWeek, 0);
        }

        if (shift === null) return;
        const f = categoryFlip(shift, m.marginSd, { inverse: inverse.has(id) });
        if (!f) return;
        entries.push({ categoryId: id, flip: f.flip });
        byCategory.push({ id, perWeek, marginSd: m.marginSd, wins: f.flip });
    });

    const summed = flipsPerWeek(entries);
    if (!summed) return null;
    // A skipped category is not a zero, so the count of categories measured travels with the figure.
    return { winsPerWeek: summed.total, counted: summed.counted, byCategory };
}

/**
 * Ranks an already qualified pool by expected category wins per week.
 *
 * @param {Array<{id: *, seasonTotals: Object<string, number>}>} pool The players to rank. The caller decides who qualifies.
 * @param {object} margins The margins leagueMargins measured.
 * @param {object} ctx The sport's knowledge, as playerWinsPerWeek takes it.
 * @returns {?{of: number, byId: Object<string, {winsPerWeek: number, rank: number, of: number, byCategory: Array<object>}>}}
 *   Null when there are no margins. A player who could not be measured is absent from byId.
 */
export function computeMatchupRanks(pool, margins, ctx) {
    if (!margins || !margins.byId) return null;

    // The pool arrives already qualified and nothing is filtered here, so this rank and any other rank over the same pool count the same players.
    const measured = [];
    (pool || []).forEach((p) => {
        const w = playerWinsPerWeek(p, margins, ctx);
        // A player the model could not measure is absent and not last. A rank on no evidence would read as a verdict.
        if (w) measured.push({ id: p.id, ...w });
    });

    measured.sort((a, b) => b.winsPerWeek - a.winsPerWeek);
    const ranks = competitionRanks(measured.map((m) => m.winsPerWeek));

    const byId = {};
    measured.forEach((m, i) => {
        byId[m.id] = {
            winsPerWeek: m.winsPerWeek,
            rank: ranks[i],
            of: measured.length,
            byCategory: m.byCategory
        };
    });
    return { of: measured.length, byId };
}
