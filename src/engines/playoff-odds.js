/**
 * The chance of making the playoffs, and at which seed, by resampling the league's own played
 * weeks.
 *
 * No distribution is fitted. A future matchup is scored by drawing one played week for each side
 * and applying the league's own rule to the pair. The week drawn for a team is its own most of the
 * time and otherwise any team's played week. A season run draws every remaining regular-season
 * matchup that way and seeds the standings by the league's rule; many runs give the odds. A roto
 * league has no matchups, so its remaining periods are drawn from its played periods and added to
 * its current totals.
 *
 * Seeded throughout, so every figure is reproducible. Clinched and eliminated are worked out
 * exactly and never read off a count of runs.
 *
 * Pure. No DOM, no application state, no storage and no network.
 *
 * Contract: tests/fixtures/playoff-odds.md
 * Tests: tests/playoff-odds.test.html
 * @module playoff-odds
 */
/**
 * The league's own rules, as the odds need them.
 *
 * @typedef {object} OddsRules
 * @property {('categories'|'points'|'roto')} scoring How a matchup is scored.
 * @property {{rule: string, statId: ?string}} tie The league's matchup tie rule, and the stat that breaks a tie when it names one.
 * @property {number} playoffTeamCount How many teams make the playoffs.
 * @property {string} seedingRule What breaks a tie in the record when seeding.
 * @property {string[]} divisions The divisions, empty unless the league has more than one.
 * @property {Object<string, *>} divisionByTeam Each team's division.
 * @property {number} regSeasonWeeks The last matchup period of the regular season.
 * @property {number} teamCount How many teams the schedule names.
 * @property {string[]} scoredStatIds The scored categories.
 * @property {string[]} inverseStatIds The categories where lower is better.
 * @property {object[]} rateComponents How each rate category is rebuilt from components.
 */
/**
 * The weeks each team's draws come from.
 *
 * @typedef {object} ResampleBasis
 * @property {Object<string, Array<{week: number, cats: Object<string, number>, points: number}>>} byTeam Each team's played weeks.
 * @property {number} weeksUsed The fewest weeks any team with weeks carries.
 * @property {string[]} tooFew The teams with no week at all.
 */
import { seededRandom } from './draft-engine.js';
import { rotoPointsForCategory } from './rank-engine.js';

/**
 * The fewest played weeks a team needs before a season is simulated. Two weeks give four pairs
 * per matchup, which carries no information. Callers may pass their own floor.
 *
 * @type {number}
 */
export const MIN_WEEKS = 3;

/**
 * The weight of the league-wide pool, in weeks. A team with n played weeks draws its own week
 * with probability n over n plus this, and otherwise a week from every team's pool, so a team is
 * not taken to be exactly its first few weeks. The value is a choice; the seasons on hand cannot
 * tell it from its neighbours.
 *
 * @type {number}
 */
export const PRIOR_WEEKS = 3;

const key = id => String(id);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ==== (a) The league's own rules ====

/**
 * Reads the league's rules out of its settings and schedule. The regular season ends the period
 * before the first game tagged as a playoff, or at the settings' matchup count when none is tagged,
 * which is every league that has not reached its bracket.
 *
 * @param {object} settings The league payload's settings.
 * @param {object[]} schedule The league's schedule.
 * @param {object} [options]
 * @param {Array<string|number>} [options.scoredStatIds] The scored categories.
 * @param {Array<string|number>} [options.inverseStatIds] The categories where lower is better.
 * @param {Object<string, *>} [options.divisionByTeam] Each team's division.
 * @param {object[]} [options.rateComponents] The sport's rate rules.
 * @returns {OddsRules} The rules.
 */
export function rulesFrom(settings, schedule, { scoredStatIds = [], inverseStatIds = [], divisionByTeam = {}, rateComponents = [] } = {}) {
    const sched = (settings && settings.scheduleSettings) || {};
    const scoring = (settings && settings.scoringSettings) || {};
    const type = scoring.scoringType;

    let firstPlayoff = null;
    const teamIds = new Set();
    (schedule || []).forEach(game => {
        if (!game) return;
        ['home', 'away'].forEach(side => { if (game[side] && game[side].teamId !== undefined) teamIds.add(key(game[side].teamId)); });
        if (game.playoffTierType && game.playoffTierType !== 'NONE') {
            if (firstPlayoff === null || game.matchupPeriodId < firstPlayoff) firstPlayoff = game.matchupPeriodId;
        }
    });

    // A single nominal division, with every team in it, is no division.
    const divisions = [...new Set(Object.values(divisionByTeam).map(key))];

    return {
        scoring: type === 'ROTO' ? 'roto' : (type === 'H2H_POINTS' ? 'points' : 'categories'),
        tie: {
            rule: scoring.matchupTieRule || 'NONE',
            statId: scoring.matchupTieRule === 'STAT_POINTS' && scoring.matchupTieRuleBy !== undefined
                ? key(scoring.matchupTieRuleBy) : null
        },
        playoffTeamCount: num(sched.playoffTeamCount),
        seedingRule: sched.playoffSeedingRule || 'H2H_RECORD',
        divisions: divisions.length > 1 ? divisions : [],
        divisionByTeam,
        regSeasonWeeks: firstPlayoff !== null ? firstPlayoff - 1 : (num(sched.matchupPeriodCount) || 16),
        teamCount: teamIds.size,
        scoredStatIds: scoredStatIds.map(key),
        inverseStatIds: inverseStatIds.map(key),
        // The sport's rate rules are handed in, not imported, so this module stays free of the application's state. Empty is a league with no rate category.
        rateComponents
    };
}

// ==== (b) The weeks each team draws from ====

/**
 * Gathers the played weeks each team's draws come from. A week's points are read only in a
 * points league, since the application keeps a different figure under the same name in a category
 * league.
 *
 * @param {Array<{id: *, weeklyCats: object, weeklyMatchWins: object}>} teamStats The application's weekly rows per team.
 * @param {object} [options]
 * @param {?number} [options.through] The last week to use.
 * @param {?number} [options.lastN] Use only the most recent weeks, this many.
 * @param {string} [options.scoring='categories'] The league's scoring, from the rules.
 * @returns {ResampleBasis} The basis.
 */
export function resampleBasis(teamStats, { through = null, lastN = null, scoring = 'categories' } = {}) {
    const byTeam = {};
    let weeksUsed = 0;
    const tooFew = [];

    (teamStats || []).forEach(team => {
        if (!team || team.id === undefined) return;
        const weeks = Object.keys(team.weeklyCats || {})
            .map(Number)
            .filter(w => Number.isFinite(w) && (through === null || w <= through))
            .sort((a, b) => a - b);
        const taken = lastN > 0 ? weeks.slice(-lastN) : weeks;
        byTeam[key(team.id)] = taken.map(w => ({
            week: w,
            cats: { ...(team.weeklyCats[w] || {}) },
            points: scoring === 'points' ? num((team.weeklyMatchWins || {})[w]) : 0
        }));
        weeksUsed = Math.max(weeksUsed, taken.length);
        if (!taken.length) tooFew.push(key(team.id));
    });

    // The count reported is the smallest any team carries, since that is the one the answer is limited by.
    const counts = Object.values(byTeam).map(list => list.length).filter(n => n > 0);
    return { byTeam, weeksUsed: counts.length ? Math.min(...counts) : 0, tooFew };
}

// ==== (c) One drawn pair ====

/**
 * Scores one drawn pair of weeks by the league's own rule. Only the league's scored categories
 * count, never every stat a week's line carries.
 *
 * @param {{cats: Object<string, number>, points: number}} a One side's week.
 * @param {{cats: Object<string, number>, points: number}} b The other side's week.
 * @param {OddsRules} rules The league's rules.
 * @returns {{winner: ('a'|'b'|'tie'), a: number, b: number, ties: number}} The winner, and each side's category wins, or its points in a points league.
 */
export function matchupOutcome(a, b, rules) {
    const left = a || {};
    const right = b || {};

    if (rules && rules.scoring === 'points') {
        const x = num(left.points);
        const y = num(right.points);
        // In a points league the two figures are the totals, not category counts. The winner is what the standings read either way.
        return { winner: x > y ? 'a' : (y > x ? 'b' : 'tie'), a: x, b: y, ties: 0 };
    }

    const inverse = new Set((rules && rules.inverseStatIds) || []);
    let aWins = 0;
    let bWins = 0;
    let ties = 0;
    ((rules && rules.scoredStatIds) || []).forEach(id => {
        const x = num((left.cats || {})[id]);
        const y = num((right.cats || {})[id]);
        if (x === y) { ties += 1; return; }
        const aBetter = inverse.has(id) ? x < y : x > y;
        if (aBetter) aWins += 1; else bWins += 1;
    });

    let winner = aWins > bWins ? 'a' : (bWins > aWins ? 'b' : 'tie');
    // The tie rule is the league's own. Where it names a stat, an equal category count is decided on that stat alone, and the tie stands when that stat is equal too.
    const tie = (rules && rules.tie) || {};
    if (winner === 'tie' && tie.rule === 'STAT_POINTS' && tie.statId) {
        const x = num((left.cats || {})[tie.statId]);
        const y = num((right.cats || {})[tie.statId]);
        if (x !== y) winner = (inverse.has(tie.statId) ? x < y : x > y) ? 'a' : 'b';
    }
    return { winner, a: aWins, b: bWins, ties };
}

// ==== (d) The standings, and the seats they hand out ====

// A matchup counts as played when it carries a real winner. The one in progress has none until it is final, so it is simulated whole.
const isFinal = game => game && (game.winner === 'HOME' || game.winner === 'AWAY' || game.winner === 'TIE');
const inRegularSeason = (game, rules) => game
    && (!game.playoffTierType || game.playoffTierType === 'NONE')
    && num(game.matchupPeriodId) <= rules.regSeasonWeeks;

// A tie weighs half a win, which matches ESPN's own winning percentage on the leagues measured.
const TIE_WEIGHT = 0.5;

function playedFrom(schedule, rules, pointsFor) {
    const rec = {};
    const seat = id => {
        const k = key(id);
        if (!rec[k]) rec[k] = { id: k, points: 0, games: 0, pointsFor: num((pointsFor || {})[k]), h2h: {} };
        return rec[k];
    };
    (schedule || []).forEach(game => {
        if (!inRegularSeason(game, rules)) return;
        if (!game.home || !game.away) return;                 // a bye books no result
        seat(game.home.teamId);
        seat(game.away.teamId);
        if (!isFinal(game)) return;
        const h = seat(game.home.teamId);
        const a = seat(game.away.teamId);
        const hw = game.winner === 'HOME' ? 1 : (game.winner === 'TIE' ? TIE_WEIGHT : 0);
        h.points += hw; a.points += 1 - hw;
        h.games += 1; a.games += 1;
        // The head-to-head record is kept as the games are played. The tiebreak asks about matchups that happened, so a simulated meeting never enters it.
        h.h2h[a.id] = (h.h2h[a.id] || 0) + hw;
        a.h2h[h.id] = (a.h2h[h.id] || 0) + (1 - hw);
    });
    return rec;
}

// The order: the record's percentage first, then the seeding rule as the tiebreak, and what the tiebreak cannot separate stays together. A block of one is a settled seat. A block of several is that many teams sharing the seats it spans, split evenly and never decided by team id.
function orderBlocks(rec, rules, ids) {
    const pct = t => (t.games > 0 ? t.points / t.games : 0);
    const sorted = [...ids].sort((x, y) => pct(rec[y]) - pct(rec[x]));

    const blocks = [];
    let i = 0;
    while (i < sorted.length) {
        let j = i;
        while (j + 1 < sorted.length && pct(rec[sorted[j + 1]]) === pct(rec[sorted[i]])) j++;
        blocks.push(sorted.slice(i, j + 1));
        i = j + 1;
    }

    // Inside a block, the league's own rule: the record among the tied teams only, or points for. Whatever is still level after that is unbroken.
    const broken = [];
    blocks.forEach(block => {
        if (block.length === 1) { broken.push(block); return; }
        const score = {};
        block.forEach(id => {
            if (rules.seedingRule === 'TOTAL_POINTS_SCORED') { score[id] = rec[id].pointsFor; return; }
            let got = 0;
            let played = 0;
            block.forEach(other => {
                if (other === id) return;
                if (rec[id].h2h[other] === undefined) return;
                got += rec[id].h2h[other];
                played += 1;
            });
            score[id] = played > 0 ? got / played : 0;
        });
        const inner = [...block].sort((x, y) => score[y] - score[x]);
        let a = 0;
        while (a < inner.length) {
            let b = a;
            while (b + 1 < inner.length && score[inner[b + 1]] === score[inner[a]]) b++;
            broken.push(inner.slice(a, b + 1));
            a = b + 1;
        }
    });
    return broken;
}

// Division winners take the top seats. A group can occupy seats that are not next to each other, so this returns seat indices. Teams tied at the head of a division are tied for one division seat: each takes it in an equal share of futures and otherwise falls back among the others, which comes to an equal share of each seat the group would fill.
function seatGroups(rec, rules, ids) {
    const blocks = orderBlocks(rec, rules, ids);
    if (!rules.divisions.length) {
        let at = 0;
        return blocks.map(block => {
            const slots = block.map((_, i) => at + i);
            at += block.length;
            return { teams: block, slots };
        });
    }

    const divOf = id => key((rules.divisionByTeam || {})[id]);
    const taken = new Set();
    const groups = [];
    const divSeats = [];      // group indexes, one per division, in the order each is led
    const restSlots = [];     // group indexes, one per remaining seat, in standings order

    blocks.forEach(block => {
        const leads = {};
        const rest = [];
        block.forEach(id => {
            const d = divOf(id);
            if (taken.has(d)) { rest.push(id); return; }
            if (!leads[d]) leads[d] = [];
            leads[d].push(id);
        });
        Object.keys(leads).forEach(d => {
            taken.add(d);
            const g = groups.push({ teams: leads[d], slots: [] }) - 1;
            divSeats.push(g);
            for (let i = 1; i < leads[d].length; i++) restSlots.push(g);
        });
        if (rest.length) {
            const g = groups.push({ teams: rest, slots: [] }) - 1;
            for (let i = 0; i < rest.length; i++) restSlots.push(g);
        }
    });

    [...divSeats, ...restSlots].forEach((g, seat) => { groups[g].slots.push(seat); });
    return groups;
}

// ==== (e) The season, many times ====

/**
 * Runs the rest of the regular season many times and reports each team's chance of a playoff
 * seat, its share of each seed, and its expected wins. A tie the league's rules cannot break is
 * split evenly among the tied teams.
 *
 * @param {ResampleBasis} basis The weeks to draw from.
 * @param {object[]} schedule The league's schedule.
 * @param {OddsRules} rules The league's rules.
 * @param {object} [options]
 * @param {number} [options.seed=1] The seed the run is reproducible from.
 * @param {number} [options.runs=1000] How many seasons to run.
 * @param {number} [options.minWeeks] The fewest weeks a team needs. Defaults to MIN_WEEKS.
 * @param {?Object<string, number>} [options.pointsFor] Each team's points for so far.
 * @param {number} [options.priorWeeks] The pool's weight. Defaults to PRIOR_WEEKS; 0 draws a team's own weeks only.
 * @returns {{teams: Object<string, {odds: number, seeds: number[], expectedWins: number, clinched: boolean, eliminated: boolean}>, runs: number, seed: number, weeksUsed: number, state: ?string}}
 *   The result. When nothing was simulated, runs is 0 and state says why; a roto league is one
 *   such case.
 */
export function simulateSeason(basis, schedule, rules, { seed = 1, runs = 1000, minWeeks = MIN_WEEKS, pointsFor = null, priorWeeks = PRIOR_WEEKS } = {}) {
    const empty = (state) => ({ teams: {}, runs: 0, seed, weeksUsed: (basis && basis.weeksUsed) || 0, state });
    if (!rules) return empty('no rules');
    if (rules.scoring === 'roto') return empty('not a head-to-head league');
    if (!basis || (basis.weeksUsed || 0) < minWeeks) return empty('too few weeks to resample');

    const played = playedFrom(schedule, rules, pointsFor);
    const ids = Object.keys(played);
    if (!ids.length) return empty('no schedule');

    const remaining = (schedule || []).filter(game => inRegularSeason(game, rules) && !isFinal(game) && game.home && game.away);
    const seats = Math.min(rules.playoffTeamCount || 0, ids.length);

    const rand = seededRandom(seed);
    // The pool: every team's played weeks, in the basis's own order, so the same seed always walks the same list.
    const prior = Number(priorWeeks) > 0 ? Number(priorWeeks) : 0;
    const pool = prior ? Object.keys(basis.byTeam).flatMap(id => basis.byTeam[id] || []) : [];
    const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
    const drawFor = (id) => {
        const list = basis.byTeam[key(id)] || [];
        // With no prior weight a team draws only its own weeks, with one call to the generator per draw.
        if (!prior || !pool.length) return list.length ? pick(list) : null;
        // A team's own week with probability n over n plus the prior weight. A team with no weeks draws the pool every time.
        if (rand() * (list.length + prior) < list.length) return pick(list);
        return pick(pool);
    };

    const odds = {};
    const seedShare = {};
    const wins = {};
    ids.forEach(id => { odds[id] = 0; wins[id] = 0; seedShare[id] = new Array(ids.length).fill(0); });

    for (let r = 0; r < runs; r++) {
        const rec = {};
        ids.forEach(id => { rec[id] = { ...played[id], h2h: played[id].h2h }; });

        remaining.forEach(game => {
            const h = key(game.home.teamId);
            const a = key(game.away.teamId);
            if (!rec[h] || !rec[a]) return;
            const out = matchupOutcome(drawFor(h), drawFor(a), rules);
            const hw = out.winner === 'a' ? 1 : (out.winner === 'tie' ? TIE_WEIGHT : 0);
            rec[h] = { ...rec[h], points: rec[h].points + hw, games: rec[h].games + 1 };
            rec[a] = { ...rec[a], points: rec[a].points + (1 - hw), games: rec[a].games + 1 };
            if (rules.scoring === 'points') {
                rec[h].pointsFor += out.a;
                rec[a].pointsFor += out.b;
            }
        });

        seatGroups(rec, rules, ids).forEach(group => {
            const share = 1 / group.teams.length;
            const berths = group.slots.filter(s => s < seats).length;
            group.teams.forEach(id => {
                group.slots.forEach(s => { seedShare[id][s] += share; });
                odds[id] += berths * share;
            });
        });
        ids.forEach(id => { wins[id] += rec[id].points; });
    }

    const flags = certainty(ids.map(id => ({ id, points: played[id].points, games: played[id].games })),
        remainingPerTeam(remaining, ids), rules);

    const teams = {};
    ids.forEach(id => {
        teams[id] = {
            odds: odds[id] / runs,
            seeds: seedShare[id].map(v => v / runs),
            expectedWins: wins[id] / runs,
            clinched: flags[id].clinched,
            eliminated: flags[id].eliminated
        };
    });
    return { teams, runs, seed, weeksUsed: basis.weeksUsed, state: null };
}

/**
 * The figure to print for one team. Certainty comes from the clinched and eliminated flags
 * alone: a sampled figure that would round to 100 or 0 reads as a bound, over 99 or under 1.
 *
 * @param {{odds: number, clinched: boolean, eliminated: boolean}} team One team's result.
 * @returns {?{pct: number, bound: ?('over'|'under'), certain: ?('clinched'|'eliminated')}} Null for no team.
 */
export function oddsFigure(team) {
    if (!team) return null;
    if (team.clinched === true) return { pct: 100, bound: null, certain: 'clinched' };
    if (team.eliminated === true) return { pct: 0, bound: null, certain: 'eliminated' };
    const pct = Math.round(num(team.odds) * 100);
    if (pct >= 100) return { pct: 99, bound: 'over', certain: null };
    if (pct <= 0) return { pct: 1, bound: 'under', certain: null };
    return { pct, bound: null, certain: null };
}

/**
 * Each team's regular-season games still to play and the combined record of the opponents in
 * them. They are the same games and the same records simulateSeason works from. The record is
 * combined over games, so an opponent met twice counts twice.
 *
 * @param {object[]} schedule The league's schedule.
 * @param {OddsRules} rules The league's rules.
 * @returns {Object<string, {gamesLeft: number, opponents: Array, wins: number, losses: number, ties: number, pct: ?number}>}
 *   The schedule by team id. The percentage is null when no opponent has played.
 */
export function remainingSchedule(schedule, rules) {
    if (!rules) return {};
    const wlt = {};
    const seat = id => (wlt[key(id)] || (wlt[key(id)] = { wins: 0, losses: 0, ties: 0 }));
    const left = [];
    (schedule || []).forEach(game => {
        if (!inRegularSeason(game, rules) || !game.home || !game.away) return;
        const h = seat(game.home.teamId);
        const a = seat(game.away.teamId);
        if (!isFinal(game)) { left.push([key(game.home.teamId), key(game.away.teamId), num(game.matchupPeriodId)]); return; }
        if (game.winner === 'TIE') { h.ties += 1; a.ties += 1; }
        else if (game.winner === 'HOME') { h.wins += 1; a.losses += 1; }
        else { a.wins += 1; h.losses += 1; }
    });

    const out = {};
    Object.keys(wlt).forEach(id => { out[id] = { gamesLeft: 0, opponents: [], wins: 0, losses: 0, ties: 0, pct: null }; });
    left.sort((x, y) => x[2] - y[2]).forEach(([h, a]) => {
        [[h, a], [a, h]].forEach(([me, them]) => {
            const row = out[me];
            row.gamesLeft += 1;
            row.opponents.push(them);
            row.wins += wlt[them].wins;
            row.losses += wlt[them].losses;
            row.ties += wlt[them].ties;
        });
    });
    Object.keys(out).forEach(id => {
        const r = out[id];
        const games = r.wins + r.losses + r.ties;
        // Null, never 0: opponents who have not played have no record, and a zero would read as the easiest schedule in the league.
        r.pct = games > 0 ? (r.wins + TIE_WEIGHT * r.ties) / games : null;
    });
    return out;
}

function remainingPerTeam(remaining, ids) {
    const left = {};
    ids.forEach(id => { left[id] = 0; });
    remaining.forEach(game => {
        const h = key(game.home.teamId);
        const a = key(game.away.teamId);
        if (left[h] !== undefined) left[h] += 1;
        if (left[a] !== undefined) left[a] += 1;
    });
    return left;
}

// ==== (f) Clinched and eliminated, which are not counts of runs ====

/**
 * Whether each team has clinched a playoff seat or been eliminated, from the bounds of what it
 * and every other team can still reach. A team that can only draw level with another is not
 * behind it.
 *
 * @param {Array<{id: *, points: number, games: number}>} standings Each team's standings points so far.
 * @param {Object<string, number>} remaining Each team's games left.
 * @param {OddsRules} rules The league's rules.
 * @returns {Object<string, {clinched: boolean, eliminated: boolean}>} The flags by team id.
 */
export function certainty(standings, remaining, rules) {
    const seats = (rules && rules.playoffTeamCount) || 0;
    const rows = (standings || []).map(t => ({
        id: key(t.id),
        min: num(t.points),
        max: num(t.points) + num((remaining || {})[key(t.id)])
    }));
    const out = {};
    rows.forEach(me => {
        let certainlyAbove = 0;
        let possiblyAbove = 0;
        rows.forEach(other => {
            if (other.id === me.id) return;
            if (other.min > me.max) certainlyAbove += 1;
            if (other.max > me.min) possiblyAbove += 1;
        });
        out[me.id] = {
            clinched: seats > 0 && possiblyAbove < seats,
            eliminated: seats > 0 && certainlyAbove >= seats
        };
    });
    return out;
}

// ==== (g) The roto league ====

/**
 * Gathers the played periods a roto league's draws come from, out of the per-period sums each
 * team's roster produced. The sums are raw, which is what lets a rate be rebuilt after periods are
 * added together.
 *
 * @param {Map|Object<string, Object<number, {sums: Object<string, number>, games: number}>>} series Each team's sums by scoring period.
 * @param {object} [options]
 * @param {?number} [options.through] The last period to use.
 * @param {?number} [options.lastN] Use only the most recent periods, this many.
 * @returns {{byTeam: Object<string, Array<{period: number, cats: Object<string, number>, games: number}>>, periodsUsed: number, tooFew: string[]}}
 *   The basis.
 */
export function rotoBasisFrom(series, { through = null, lastN = null } = {}) {
    const byTeam = {};
    const tooFew = [];
    const entries = series instanceof Map ? [...series.entries()] : Object.entries(series || {});
    entries.forEach(([id, weeks]) => {
        const list = Object.keys(weeks || {})
            .map(Number)
            .filter(p => Number.isFinite(p) && (through === null || p <= through))
            .sort((a, b) => a - b);
        const taken = lastN > 0 ? list.slice(-lastN) : list;
        byTeam[key(id)] = taken.map(p => ({
            period: p,
            cats: { ...((weeks[p] || {}).sums || {}) },
            games: num((weeks[p] || {}).games)
        }));
        if (!taken.length) tooFew.push(key(id));
    });
    const counts = Object.values(byTeam).map(l => l.length).filter(n => n > 0);
    return { byTeam, periodsUsed: counts.length ? Math.min(...counts) : 0, tooFew };
}

/**
 * Rebuilds every rate in a line of summed stats from its components. A rate cannot be summed
 * across periods, so the components are summed and the rate derived last. A rate that adds other
 * rates is derived after them.
 *
 * @param {Object<string, number>} line The summed stats by id.
 * @param {object[]} rateComponents How each rate is built.
 * @returns {Object<string, number>} A new line with the rates rebuilt. A rate with a zero denominator reads 0.
 */
export function applyRates(line, rateComponents) {
    const out = { ...line };
    const sum = ids => (ids || []).reduce((t, id) => t + num(out[key(id)]), 0);
    (rateComponents || []).forEach(rule => {
        if (rule.add) return;
        const den = sum(rule.den);
        out[key(rule.out)] = den === 0 ? 0 : (sum(rule.num) * (rule.scale || 1)) / den;
    });
    (rateComponents || []).forEach(rule => {
        if (!rule.add) return;
        out[key(rule.out)] = rule.add.reduce((t, id) => t + num(out[key(id)]), 0);
    });
    return out;
}

/**
 * A roto league's odds: each team's chance of winning the league, its expected roto points, and
 * per category its chance of finishing above the team that leads now.
 *
 * @param {{byTeam: Object<string, Array<{cats: Object<string, number>}>>, periodsLeft: number, periodsUsed: number}} basis The periods to draw from.
 * @param {Object<string, Object<string, number>>} standings Each team's current totals by stat id.
 * @param {OddsRules} rules The league's rules.
 * @param {object} [options]
 * @param {number} [options.seed=1] The seed the run is reproducible from.
 * @param {number} [options.runs=1000] How many seasons to run.
 * @param {?number} [options.periodsLeft] The periods still to play. Defaults to the basis's own.
 * @returns {{teams: Object<string, {titleOdds: number, expectedPoints: number, perCategory: object[]}>, runs: number, seed: number, periodsLeft: number, periodsUsed: number, state: ?string}}
 *   The result. A shared best total splits the title evenly.
 */
export function rotoOdds(basis, standings, rules, { seed = 1, runs = 1000, periodsLeft = null } = {}) {
    const cats = (rules && rules.scoredStatIds) || [];
    const inverse = new Set((rules && rules.inverseStatIds) || []);
    const ids = Object.keys(standings || {}).map(key);
    const left = periodsLeft === null ? num(basis && basis.periodsLeft) : num(periodsLeft);
    if (!ids.length || !cats.length) return { teams: {}, runs: 0, seed, periodsLeft: left, state: 'nothing to rank' };

    // The leader is read off the current totals. A lower-is-better category's leader is its lowest total.
    const leaderOf = {};
    cats.forEach(c => {
        let best = null;
        ids.forEach(id => {
            const v = num((standings[id] || {})[c]);
            if (best === null) { best = { id, v }; return; }
            if (inverse.has(c) ? v < best.v : v > best.v) best = { id, v };
        });
        leaderOf[c] = best ? best.id : null;
    });

    const rand = seededRandom(seed);
    const title = {};
    const points = {};
    const above = {};
    ids.forEach(id => {
        title[id] = 0; points[id] = 0;
        above[id] = {};
        cats.forEach(c => { above[id][c] = 0; });
    });

    for (let r = 0; r < runs; r++) {
        const final = {};
        ids.forEach(id => {
            const line = {};
            cats.forEach(c => { line[c] = num((standings[id] || {})[c]); });
            const list = (basis.byTeam || {})[id] || [];
            const raw = { ...(standings[id] || {}) };
            for (let p = 0; p < left && list.length; p++) {
                const drawn = list[Math.floor(rand() * list.length) % list.length];
                Object.keys(drawn.cats || {}).forEach(statId => {
                    raw[statId] = num(raw[statId]) + num(drawn.cats[statId]);
                });
            }
            // Every stat the periods carried is summed, components included, and the rates are then rebuilt from those sums.
            const rebuilt = applyRates(raw, (rules && rules.rateComponents) || []);
            cats.forEach(c => { line[c] = num(rebuilt[c]); });
            final[id] = line;
        });

        // Roto points come from rank-engine.js's own function, tie splits included, so there is one roto ranking in the app.
        const got = {};
        ids.forEach(id => { got[id] = 0; });
        cats.forEach(c => {
            const entries = ids.map(id => ({ id, value: final[id][c] }));
            rotoPointsForCategory(entries, inverse.has(c)).forEach((pts, id) => { got[key(id)] += pts; });
            const L = leaderOf[c];
            if (L === null) return;
            ids.forEach(id => {
                if (id === L) return;
                const better = inverse.has(c) ? final[id][c] < final[L][c] : final[id][c] > final[L][c];
                if (better) above[id][c] += 1;
            });
        });

        const best = Math.max(...ids.map(id => got[id]));
        const winners = ids.filter(id => got[id] === best);
        winners.forEach(id => { title[id] += 1 / winners.length; });
        ids.forEach(id => { points[id] += got[id]; });
    }

    const teams = {};
    ids.forEach(id => {
        teams[id] = {
            titleOdds: title[id] / runs,
            expectedPoints: points[id] / runs,
            perCategory: cats.map(c => {
                const list = (basis.byTeam || {})[id] || [];
                const rate = list.length ? list.reduce((s, w) => s + num((w.cats || {})[c]), 0) / list.length : 0;
                const L = leaderOf[c];
                const lList = (basis.byTeam || {})[L] || [];
                const lRate = lList.length ? lList.reduce((s, w) => s + num((w.cats || {})[c]), 0) / lList.length : 0;
                return {
                    statId: c,
                    // Null for the leader itself. A team cannot finish above itself.
                    chanceAboveLeader: id === L ? null : above[id][c] / runs,
                    current: num((standings[id] || {})[c]),
                    perPeriod: rate,
                    periodsLeft: left,
                    projected: num((standings[id] || {})[c]) + rate * left,
                    leaderId: L,
                    leaderProjected: L === null ? null : num((standings[L] || {})[c]) + lRate * left
                };
            })
        };
    });
    return { teams, runs, seed, periodsLeft: left, periodsUsed: num(basis && basis.periodsUsed), state: null };
}

// ==== (h) Two results into one ====

/**
 * Merges two results of the same simulation into one. Sampled fields are averaged by how many
 * runs each side made. Fields worked out exactly are the same in every batch and come from the
 * first.
 *
 * @param {?object} a One result of simulateSeason or rotoOdds.
 * @param {?object} b Another, from the same inputs.
 * @returns {?object} The merged result, with the runs added.
 */
export function mergeRuns(a, b) {
    // An empty side is no side. Every batch sees the same inputs, so two empties give the first.
    if (!a) return b;
    if (!b || !(b.runs > 0)) return a;
    if (!(a.runs > 0)) return b;
    const runs = a.runs + b.runs;
    const w = (x, y) => (num(x) * a.runs + num(y) * b.runs) / runs;

    const teams = {};
    Object.keys(a.teams || {}).forEach(id => {
        const ta = a.teams[id];
        const tb = (b.teams || {})[id];
        if (!tb) { teams[id] = ta; return; }
        if ('titleOdds' in ta) {
            teams[id] = {
                ...ta,
                titleOdds: w(ta.titleOdds, tb.titleOdds),
                expectedPoints: w(ta.expectedPoints, tb.expectedPoints),
                perCategory: (ta.perCategory || []).map((c, i) => {
                    const cb = (tb.perCategory || [])[i] || {};
                    // The leader's own row is null in every batch.
                    return {
                        ...c,
                        chanceAboveLeader: c.chanceAboveLeader === null ? null : w(c.chanceAboveLeader, cb.chanceAboveLeader)
                    };
                })
            };
            return;
        }
        teams[id] = {
            ...ta,
            odds: w(ta.odds, tb.odds),
            seeds: (ta.seeds || []).map((v, i) => w(v, (tb.seeds || [])[i])),
            expectedWins: w(ta.expectedWins, tb.expectedWins)
        };
    });
    return { ...a, teams, runs };
}
