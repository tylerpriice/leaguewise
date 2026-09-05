// matchup-rank.js - how often a player's week WINS a category, against the margins this league actually decides them by. PURE, the rank-engine rule: no DOM, no AppState, no fetches. Every table arrives as an argument. The contract is tests/fixtures/matchup-rank.md and it is frozen; this file implements it and adds nothing the contract does not describe. TWO MODELS OF A MARGIN EXIST IN THIS REPOSITORY AND THEY ARE NOT INTERCHANGEABLE. leverage-engine.js DERIVES a margin distribution from a pool, because a league that has not played cannot measure one. This module MEASURES it from matchups that were played. Where both are available the measured one wins - it carries the league's real streaming, injuries and off-nights, none of which a two-moment model has a term for - so this module REFUSES rather than quietly falling back to the derived one when there are too few matchups to measure. The shift and flip math is leverage-engine's; this file holds no probability formula of its own.
import { countingShift, rateShift, categoryFlip, flipsPerWeek } from './leverage-engine.js';
import { competitionRanks } from './rank-engine.js';
import { seasonFormat } from './history.js';

// Fewer margins than this and the spread is noise: three numbers cannot say what a category is usually decided by. The surface's wording ("Matchup rank needs 4 decided matchups") is the caller's; this module returns the reason code.
export const MIN_DECIDED_MATCHUPS = 4;

const num = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// THE ROOT MEAN SQUARE, NOT A STANDARD DEVIATION, and the difference is not pedantry. A margin is the difference of two draws from the same distribution, so its mean is zero BY CONSTRUCTION. Taking a deviation about the sample mean would subtract an estimate of a quantity already known to be zero, throwing away a degree of freedom to remove noise that is not there.
const rms = (xs) => (xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : null);

// Measure each scored category's weekly margin from the league's own DECIDED matchups. Returns null with a reason when the league cannot support the measurement.
export function leagueMargins(payload, ctx) {
    const format = seasonFormat(payload);
    // A roto league accumulates over a season with no weekly matchup to swing, and a points league does not score categories at all. Neither is a small-sample problem, so neither is worth a count: they are answered before anything is read.
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
        // PERIODS AND PAIRINGS ARE DIFFERENT COUNTS and both are needed. A four-team league plays TWO pairings in one period, so 21 periods give 42 margins and 84 team-weeks. The per-week divisor is the period count (a season total is spread over weeks, not over pairings); the margin sample is the pairings; the team rate averages over the sides.
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
            // THE RATES ARE MEASURED, NOT MODELLED. The box score carries AVG, OPS and ERA per team per matchup with their own WIN/LOSS results, so their margins come from real decided matchups exactly as the counting ones do. leverage-engine's rateMarginSd exists for the pre-season case where there is nothing to measure; it has no business here.
            teamRate = mean(sideValues(id));
            const w = weightIdsFor(id) || [];
            teamWeight = mean(sides.map((s) => w.reduce((t, c) => t + (num(s[c] && s[c].score) || 0), 0)));
        }
        byId[id] = { marginSd, teamRate, teamWeight };
    });

    return { margins: { matchups, pairings, teamWeeks: sides.length, byId }, reason: null };
}

// The player's expected category wins per week, and the per-category breakdown behind it.
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
            // A PLAYER DOES NOT ADD TO A TEAM RATE, THEY PULL IT toward their own by their share of the denominator - and the share is over the COMBINED denominator, team plus their own, because joining the team enlarges the denominator they are diluting. With that weight rateShift is not an approximation at all: it is algebraically identical to adding the components and recomputing (worst disagreement 6.07e-17 over 300 batters, O36). The team's own denominator, which this once used, overstates every rate shift by 9-13% for a twenty-to-thirty at-bat week (O37).
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
            // THE SEASON TOTAL OVER THE LEAGUE'S MATCHUP COUNT, not over the player's own weeks played, because that number DOES NOT EXIST: every line in the pool is a season total, and the only per-week capture holds the rostered handful. rank-engine.js's GAMES_PLAYED_IDS comment already records this. The consequence is real and is written in the contract - a player who missed half the season is measured at half the weekly line - and it is the right answer for "what does rostering this player do to a week".
            const total = num(totals[id]);
            if (total === null) return;
            perWeek = total / matchups;
            // The baseline is ZERO, not a replacement player: the question is what this week is worth against the margin, not what it adds over the player it displaces. A raw reach is not a value, which leverage-engine's own note on the two numbers says at length.
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
    // A SKIPPED CATEGORY IS NOT A ZERO. counted travels with the figure so a player measured on six categories is never silently compared with one measured on nine.
    return { winsPerWeek: summed.total, counted: summed.counted, byCategory };
}

// Rank an ALREADY-QUALIFIED pool by expected category wins per week.
export function computeMatchupRanks(pool, margins, ctx) {
    if (!margins || !margins.byId) return null;

    // THE POOL IS HANDED IN, ALREADY QUALIFIED, and this module does no filtering of its own. A matchup rank "of 464" and an Overall Rank "of 464" have to mean the same 464 or the two columns cannot be read side by side, and the only way to guarantee that is for one caller to decide the list once.
    const measured = [];
    (pool || []).forEach((p) => {
        const w = playerWinsPerWeek(p, margins, ctx);
        // A player the model could not measure is ABSENT rather than last. Ranking them on no evidence would read as a verdict.
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
