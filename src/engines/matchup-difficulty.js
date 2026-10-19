/**
 * How hard a pitcher's next start is, and how hard a goalie's night: the opponent's strength as a
 * percentile, with a small number of measured adjustments, each returned beside the score.
 *
 * Pure. No DOM, no application state and no network. The data is ESPN's own from end to end: the
 * player pool, the pro schedule, and a per-day stat line whose external id is the game's id, so a
 * pitcher's history splits by opponent and by venue without reading anything from dates.
 *
 * Platoon splits are not here. ESPN's fantasy payload carries no handedness for any player.
 *
 * Tests: tests/features.test.html
 * @module matchup-difficulty
 */
/**
 * One club's offence, summed over the bats counted for it.
 *
 * @typedef {object} TeamOffence
 * @property {number} proTeamId The club.
 * @property {number} bats How many bats were counted.
 * @property {number} rostered How many healthy bats the club carries.
 * @property {Object<string, number>} totals The club's figure by stat id. A rate is derived from summed components.
 */
/**
 * One term of a difficulty score.
 *
 * @typedef {object} DifficultyPart
 * @property {string} key Which term this is: 'offence', 'park', 'rest', 'shots' or 'ice'. A page tells the terms apart by this, never by the label.
 * @property {string} label The term in words.
 * @property {number} value The base percentile, or the amount this term added to the score.
 */

// A hitter counts toward the club's offence unless unable to play. Day-to-day stays in, since a day-to-day hitter starts most days.
const SIDELINED = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION', 'SEVEN_DAY_DL', 'TEN_DAY_DL',
                           'FIFTEEN_DAY_DL', 'SIXTY_DAY_DL', 'NON_ROSTER']);

/**
 * Whether an injury status keeps a player out of the game. Day-to-day does not.
 *
 * @param {string} injuryStatus ESPN's injury status.
 * @returns {boolean} True for a status that removes the player.
 */
export function isSidelined(injuryStatus) {
    return SIDELINED.has(String(injuryStatus || '').toUpperCase());
}

// Which categories can be summed, which have to be derived, and which cannot be had at all. A rate summed across players means nothing and grows with the number of bats, so a rate is rebuilt from summed components. An entry that adds other rates pulls in the ratios it names, in table order. A scored rate with no derivation is excluded, not summed.
function planOffenceRates(statIds, options) {
    const specs = options.rateSpecs || [];
    const rateIds = options.rateStatIds || new Set();
    const byOut = new Map(specs.map(s => [s.out, s]));

    const needed = new Map();
    const want = (id) => {
        if (needed.has(id) || !byOut.has(id)) return;
        const spec = byOut.get(id);
        needed.set(id, spec);
        (spec.add || []).forEach(want);
    };
    (statIds || []).forEach(want);

    const plan = specs.filter(s => needed.has(s.out));
    const sums = new Set();
    (statIds || []).forEach(id => { if (!needed.has(id)) sums.add(id); });
    plan.forEach(s => {
        (s.num || []).forEach(i => sums.add(i));
        (s.den || []).forEach(i => sums.add(i));
    });
    plan.forEach(s => sums.delete(s.out));

    const excluded = (statIds || []).filter(id => rateIds.has(id) && !needed.has(id));
    excluded.forEach(id => sums.delete(id));
    return { plan, sums, excluded };
}

// One derived rate from a lineup's summed components. Null when a component is missing or the denominator is zero: a lineup with no at-bats has no batting average, which is not an average of zero.
function deriveRate(totals, spec) {
    const total = (ids) => {
        let sum = 0;
        for (const id of ids) {
            const v = Number(totals[id]);
            if (!Number.isFinite(v)) return null;
            sum += v;
        }
        return sum;
    };
    if (spec.add) return total(spec.add);
    const num = total(spec.num || []);
    const den = total(spec.den || []);
    if (num === null || den === null || den === 0) return null;
    return num * (spec.scale || 1) / den;
}

// The bats that will be in the game, which is a lineup and not a roster. A fixed count, so every club brings the same number of bats and carrying more players brings no more of anything. Chosen by playing time and never by production. Before anyone has played, every bat is kept.
function lineupBats(bats, options) {
    const size = options.lineupSize;
    const playingTimeOf = options.playingTimeOf;
    if (!size || !playingTimeOf || bats.length <= size) return bats;
    const played = bats.map(h => Number(playingTimeOf(h)) || 0);
    if (!played.some(v => v > 0)) return bats;
    return bats
        .map((h, i) => ({ h, t: played[i] }))
        .sort((a, b) => b.t - a.t)
        .slice(0, size)
        .map(x => x.h);
}

/**
 * Each club's offence, summed over its healthy hitters. Counting categories are summed, and a
 * rate is derived from its summed components when the rate options are given.
 *
 * @param {Array<{proTeamId: number, injuryStatus: string, totals: Object<string, number>}>} hitters The hitters in the pool.
 * @param {string[]} statIds The categories to measure.
 * @param {object} [options]
 * @param {object[]} [options.rateSpecs] How each rate is built from components.
 * @param {Set<string>} [options.rateStatIds] Which of the ids are rates.
 * @param {number} [options.lineupSize] Count only this many bats per club.
 * @param {function(object): number} [options.playingTimeOf] A hitter's playing time, which chooses the bats counted.
 * @returns {Map<number, TeamOffence>} The offence by pro team id. With no options every healthy bat counts and every id is summed.
 */
export function teamOffence(hitters, statIds, options = {}) {
    const { plan, sums, excluded } = planOffenceRates(statIds, options);
    const byTeam = new Map();
    const sumIds = Array.from(sums);

    // Grouped first, so the lineup is chosen per club from that club's own bats.
    const healthyByTeam = new Map();
    (hitters || []).forEach(h => {
        if (!h || h.proTeamId == null) return;
        // Free agency is not a club. ESPN files unrostered players under pro team id 0, and counting them would add a club that then competes in the percentiles.
        if (Number(h.proTeamId) === 0) return;
        if (isSidelined(h.injuryStatus)) return;
        if (!healthyByTeam.has(h.proTeamId)) healthyByTeam.set(h.proTeamId, []);
        healthyByTeam.get(h.proTeamId).push(h);
    });

    healthyByTeam.forEach((bats, proTeamId) => {
        const lineup = lineupBats(bats, options);
        const team = { proTeamId, bats: lineup.length, rostered: bats.length, totals: {} };
        byTeam.set(proTeamId, team);
        lineup.forEach(h => {
            sumIds.forEach(id => {
                const v = Number(h.totals && h.totals[id]);
                if (Number.isFinite(v)) team.totals[id] = (team.totals[id] || 0) + v;
            });
        });
    });
    byTeam.forEach(team => {
        plan.forEach(spec => {
            const v = deriveRate(team.totals, spec);
            if (v === null) delete team.totals[spec.out];
            else team.totals[spec.out] = v;
        });
        // Deleted, not left summed, so the category drops out of the composite.
        excluded.forEach(id => { delete team.totals[id]; });
    });
    return byTeam;
}

/**
 * Where a value sits in a set, from 0 to 100, by how many values it beats. Ties share the
 * midpoint.
 *
 * @param {number} value The value.
 * @param {number[]} values The set.
 * @returns {?number} The percentile, or null for no value or an empty set.
 */
export function percentileOf(value, values) {
    const list = (values || []).filter(v => Number.isFinite(v));
    if (!list.length || !Number.isFinite(value)) return null;
    let below = 0, equal = 0;
    list.forEach(v => { if (v < value) below++; else if (v === value) equal++; });
    return ((below + equal / 2) / list.length) * 100;
}

// The set of values each category is ranked against, gathered once. The composite and the breakdown share it, so the number a page shows and the number the score was built from cannot differ.
function offenceBasis(byTeam, statIds) {
    const teams = Array.from(byTeam.values());
    const perStat = new Map();
    (statIds || []).forEach(id => {
        perStat.set(id, teams.map(t => Number(t.totals[id])).filter(Number.isFinite));
    });
    return { teams, perStat };
}

// Where one category's value sits, with a lower-is-better category mirrored. The mirror is exact: 100 less the percentile counts the values above, with the same half share of the ties.
function categoryPercentile(value, values, inverse) {
    const p = percentileOf(value, values);
    if (p === null) return null;
    return inverse ? 100 - p : p;
}

/**
 * Each club's offensive strength: its percentile in each category, averaged. Averaging
 * percentiles is what makes unlike categories comparable.
 *
 * @param {Map<number, TeamOffence>} byTeam The offences, from teamOffence.
 * @param {string[]} statIds The categories.
 * @param {object} [options]
 * @param {Set<string>} [options.inverseStatIds] The categories the league scores lower-is-better.
 * @returns {Map<number, number>} The strength by pro team id, 0 to 100. A club with no measurable category is absent.
 */
export function offenceStrength(byTeam, statIds, options = {}) {
    const { teams, perStat } = offenceBasis(byTeam, statIds);
    const inverse = options.inverseStatIds || new Set();

    const strength = new Map();
    teams.forEach(t => {
        const pcts = [];
        (statIds || []).forEach(id => {
            const p = categoryPercentile(Number(t.totals[id]), perStat.get(id), inverse.has(id));
            if (p !== null) pcts.push(p);
        });
        if (pcts.length) strength.set(t.proTeamId, pcts.reduce((a, b) => a + b, 0) / pcts.length);
    });
    return strength;
}

/**
 * One club's strength taken apart into the category comparisons it was built from, over the same
 * basis as offenceStrength, so the rows average to the composite.
 *
 * A rank counts the clubs that are better in the category, so 1 is the best, and ties share a
 * rank.
 *
 * @param {Map<number, TeamOffence>} byTeam The offences.
 * @param {string[]} statIds The categories.
 * @param {number} proTeamId The club.
 * @param {object} [options] The same options as teamOffence and offenceStrength.
 * @returns {?{proTeamId: number, bats: number, rostered: number, rows: Array<{id: string, value: number, pct: number, rank: number, of: number, inverse: boolean}>, average: ?number, excluded: string[]}}
 *   Null for a club the pool has no bats for.
 */
export function offenceBreakdown(byTeam, statIds, proTeamId, options = {}) {
    const { teams, perStat } = offenceBasis(byTeam, statIds);
    const team = teams.find(t => t.proTeamId === proTeamId);
    if (!team) return null;
    const inverseIds = options.inverseStatIds || new Set();
    const rows = [];
    (statIds || []).forEach(id => {
        const values = perStat.get(id) || [];
        const value = Number(team.totals[id]);
        const inverse = inverseIds.has(id);
        const pct = categoryPercentile(value, values, inverse);
        if (pct === null) return;
        // Better, not bigger. On a lower-is-better category the fewest ranks first, the same direction as the percentile beside it.
        let better = 0;
        values.forEach(v => { if (inverse ? v < value : v > value) better++; });
        rows.push({ id, value, pct, rank: better + 1, of: values.length, inverse });
    });
    // The mean of the rows, which is the mean offenceStrength takes over the same rows.
    const average = rows.length ? rows.reduce((a, r) => a + r.pct, 0) / rows.length : null;
    // The categories the composite could not measure, so a page can name them.
    return { proTeamId: team.proTeamId, bats: team.bats, rostered: team.rostered, rows, average,
             excluded: planOffenceRates(statIds, options).excluded };
}

/**
 * A pitcher's own past outings, split by the opponent faced and where. Each per-day line names
 * its game, and the schedule says who played and which side was home.
 *
 * @param {Array<{externalId: (string|number), totals: Object<string, number>}>} lines One line per day the pitcher recorded a stat.
 * @param {Map<string, {home: number, away: number}>} gameIndex Pro games by id.
 * @param {number} pitcherTeamId The pitcher's club.
 * @returns {Map<number, {opponentId: number, outings: number, home: number, away: number, totals: Object<string, number>}>} The record by opponent.
 */
export function pastStartsByOpponent(lines, gameIndex, pitcherTeamId) {
    const byOpponent = new Map();
    (lines || []).forEach(line => {
        const game = gameIndex && gameIndex.get(String(line && line.externalId));
        if (!game) return;
        const isHome = pitcherTeamId != null && game.home === pitcherTeamId;
        const opponentId = isHome ? game.away : game.home;
        if (opponentId == null) return;
        let rec = byOpponent.get(opponentId);
        if (!rec) { rec = { opponentId, outings: 0, home: 0, away: 0, totals: {} }; byOpponent.set(opponentId, rec); }
        rec.outings++;
        if (isHome) rec.home++; else rec.away++;
        Object.keys(line.totals || {}).forEach(id => {
            const v = Number(line.totals[id]);
            if (Number.isFinite(v)) rec.totals[id] = (rec.totals[id] || 0) + v;
        });
    });
    return byOpponent;
}

/**
 * Fewer days than this between starts is short rest.
 *
 * @type {number}
 */
export const SHORT_REST_DAYS = 4;
/**
 * What short rest adds to a start's difficulty, in points of the score. An order of magnitude,
 * not a fitted number.
 *
 * @type {number}
 */
export const SHORT_REST_ADJUSTMENT = 6;

/**
 * What each ballpark does to run scoring, by ESPN's pro team id for the club whose park it is:
 * a run index, where 100 is neutral and 125 means a quarter more runs, and the park's name.
 *
 * The values are the runs index of Baseball Savant's Statcast Park Factors on its three-year
 * window, held as constants and refreshed per release, so nothing is requested at run time. A club
 * playing in a temporary park has no entry.
 *
 * @type {Object<number, Array<number|string>>}
 */
export const MLB_PARK_FACTORS = {
    1:  [100, 'Oriole Park at Camden Yards'],
    2:  [110, 'Fenway Park'],
    3:  [102, 'Angel Stadium'],
    4:  [98,  'Rate Field'],
    5:  [94,  'Progressive Field'],
    6:  [102, 'Comerica Park'],
    7:  [102, 'Kauffman Stadium'],
    8:  [94,  'American Family Field'],
    9:  [106, 'Target Field'],
    10: [100, 'Yankee Stadium'],
    12: [83,  'T-Mobile Park'],
    13: [94,  'Globe Life Field'],
    14: [100, 'Rogers Centre'],
    15: [102, 'Truist Park'],
    16: [94,  'Wrigley Field'],
    17: [106, 'Great American Ball Park'],
    18: [100, 'Daikin Park'],
    19: [102, 'Dodger Stadium'],
    20: [102, 'Nationals Park'],
    21: [96,  'Citi Field'],
    22: [102, 'Citizens Bank Park'],
    23: [98,  'PNC Park'],
    24: [100, 'Busch Stadium'],
    25: [94,  'Petco Park'],
    26: [94,  'Oracle Park'],
    27: [125, 'Coors Field'],
    28: [102, 'loanDepot park'],
    29: [106, 'Chase Field']
};

/**
 * Which club's park a start is played in: the pitcher's own at home, the opponent's away.
 *
 * @param {{teamId: number, opponentId: number, isHome: boolean}} start The start.
 * @returns {?number} The club, or null when the pitcher's own club is unknown.
 */
export function venueTeamIdFor(start) {
    if (!start || start.teamId === null || start.teamId === undefined) return null;
    return start.isHome ? start.teamId : (start.opponentId ?? null);
}

/**
 * The difficulty of one projected start, 0 to 100, where higher is harder. The base is the
 * opponent's offensive strength. The park scales it, and short rest adds a fixed amount. Each term
 * is returned, so a reader can weigh them differently.
 *
 * @param {{opponentId: number, teamId: number, isHome: boolean}} start The start.
 * @param {Map<number, number>} offence The strengths from offenceStrength.
 * @param {Map<number, object>} [opponentHistory] The record from pastStartsByOpponent.
 * @param {object} [options]
 * @param {Object<number, Array>} [options.parkFactors] The park table. Absent for a sport with none.
 * @param {?number} [options.restDays] Days since the pitcher's last start.
 * @returns {?{score: number, base: number, parts: DifficultyPart[], outings: number, history: ?object}}
 *   Null when the opponent's offence cannot be measured, so a page shows no read and not an
 *   average one.
 */
export function startDifficulty(start, offence, opponentHistory, options = {}) {
    if (!start || start.opponentId == null) return null;
    const base = offence && offence.get(start.opponentId);
    if (!Number.isFinite(base)) return null;

    // Each part carries a key as well as a label, since a page draws the terms differently and must not tell them apart by their wording.
    const parts = [{ key: 'offence', label: 'Opponent offence', value: base }];
    let score = base;

    // The park scales the opponent's offence and is not added to it, which is what a run index is: 125 means a quarter more runs. It applies to the base alone, never to the running score. With no park table the term does not appear at all. A park the table does not know appears with a zero.
    if (options.parkFactors) {
        const venueTeamId = venueTeamIdFor(start);
        const park = venueTeamId === null ? null : options.parkFactors[venueTeamId];
        if (park) {
            // Rounded to the tenth a page prints at, so the part shown is the part the total was built from.
            const adjustment = Math.round(base * (park[0] / 100 - 1) * 10) / 10;
            score += adjustment;
            parts.push({
                key: 'park', label: `${park[1]}, ${park[0]} run index`, value: adjustment,
                venue: park[1], runIndex: park[0], venueTeamId
            });
        } else {
            parts.push({ key: 'park', label: 'Ballpark unknown', value: 0, venue: null, runIndex: null, venueTeamId });
        }
    }

    // Absent rest is not zero rest. Number(null) is 0, which would give every first start of a window a short-rest penalty.
    const hasRest = options.restDays !== null && options.restDays !== undefined && options.restDays !== '';
    const rest = hasRest ? Number(options.restDays) : NaN;
    if (Number.isFinite(rest) && rest < SHORT_REST_DAYS) {
        score += SHORT_REST_ADJUSTMENT;
        parts.push({ key: 'rest', label: `${rest} days rest`, value: SHORT_REST_ADJUSTMENT, restDays: rest });
    }

    const history = opponentHistory && opponentHistory.get(start.opponentId);
    return {
        score: Math.max(0, Math.min(100, score)),
        base,
        parts,
        outings: history ? history.outings : 0,
        history: history || null
    };
}

/**
 * A difficulty score in plain words, in five bands.
 *
 * @param {number} score The score.
 * @returns {string} From 'Very favourable' to 'Very hard', or 'No read' for no score.
 */
export function difficultyLabel(score) {
    if (!Number.isFinite(score)) return 'No read';
    if (score >= 80) return 'Very hard';
    if (score >= 60) return 'Hard';
    if (score >= 40) return 'Even';
    if (score >= 20) return 'Favourable';
    return 'Very favourable';
}

/**
 * How much home ice moves a goalie's night, in points of the score: taken off at home and added
 * on the road. Derived from the gap in goalie win rate between home and away against the gap
 * across opponents' shot volume.
 *
 * @type {number}
 */
export const HOME_ICE_ADJUSTMENT = 15;

/**
 * The categories a goalie's night difficulty says something about. Save percentage and shutouts
 * are absent because the opponent did not move either when measured.
 *
 * @type {string[]}
 */
export const GOALIE_NIGHT_PREDICTS = ['W', 'GAA', 'SA'];

/**
 * The difficulty of one goalie's night, 0 to 100, where higher is harder. Two terms: the
 * opponent's shot volume as a percentile, and home ice.
 *
 * Whether the goalie is expected to start is passed through and changes no number.
 *
 * @param {{opponentId: number, isHome: (boolean|undefined)}} start The night.
 * @param {Map<number, number>} shotVolume Each club's shots for per game, as a percentile.
 * @param {object} [options]
 * @param {string} [options.starterStatus] ESPN's word on whether the goalie starts.
 * @returns {?{score: number, base: number, parts: DifficultyPart[], starterStatus: ?string, predicts: string[]}}
 *   Null when there is no opponent or no shot volume for it.
 */
export function goalieNightDifficulty(start, shotVolume, options = {}) {
    if (!start || start.opponentId === null || start.opponentId === undefined) return null;
    const base = shotVolume && shotVolume.get(start.opponentId);
    if (!Number.isFinite(base)) return null;

    // Keys, not labels, for the reason startDifficulty carries them.
    const parts = [{ key: 'shots', label: 'Opponent shot volume', value: base }];
    let score = base;

    // The side is read strictly. An unknown side is not away, and gets no ice term at all.
    if (start.isHome === true || start.isHome === false) {
        const adjustment = start.isHome ? -HOME_ICE_ADJUSTMENT : HOME_ICE_ADJUSTMENT;
        score += adjustment;
        parts.push({
            key: 'ice', label: start.isHome ? 'Home ice' : 'On the road',
            value: adjustment, isHome: start.isHome
        });
    }

    return {
        score: Math.max(0, Math.min(100, score)),
        base,
        parts,
        starterStatus: options.starterStatus ?? null,
        predicts: GOALIE_NIGHT_PREDICTS
    };
}

/**
 * Whole days between two game times.
 *
 * @param {?number} earlierMs The earlier time, in epoch milliseconds.
 * @param {?number} laterMs The later time.
 * @returns {?number} The days, or null when either time is missing.
 */
export function daysBetween(earlierMs, laterMs) {
    if (earlierMs === null || earlierMs === undefined || earlierMs === '') return null;
    if (laterMs === null || laterMs === undefined || laterMs === '') return null;
    const a = Number(earlierMs), b = Number(laterMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
}
