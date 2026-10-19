/**
 * A past season scored again in this league's own terms: the season's pool, grouped and totalled,
 * handed to the unchanged rank engine, and the engine's answer turned into one row per season.
 *
 * How a player would have done in an earlier season in this league has no single number: a
 * categories league ranks against opponents, and it had none then. So this gives where the player
 * ranked, in this league's categories, against everyone who played that season. It returns ranks
 * and percentiles and no value figure.
 *
 * Eligibility is always that season's own. Rates are rebuilt from components. A player belongs to
 * a group by eligibility and by carrying one of its categories, and a two-way player is in both.
 *
 * Pure. No DOM, no application state and no network; the stat tables arrive as arguments.
 *
 * Contract: tests/fixtures/retro-seasons.md
 * Tests: tests/features.test.html
 * @module retro-basis
 */
import { rosterTotals } from './draft-engine.js';
import { competitionRanks } from './rank-engine.js';


// ==== One player's season line ====

/**
 * Turns a historical stat line into the season totals the rank engine reads. Counting stats pass
 * through. Every rate the league scores is recomputed from its components and written over what
 * the source carried. A rate whose components are missing is left absent, not zeroed, since in a
 * lower-is-better category a zero would be the best figure.
 *
 * @param {Object<string, number>} line The season's stat line.
 * @param {object} [options]
 * @param {Array<string|number>} [options.categoryIds] The league's scored categories.
 * @param {object[]} [options.rateSpecs] The sport's rate rules.
 * @returns {?Object<string, number>} The totals, or null for no line.
 */
export function seasonTotalsFrom(line, { categoryIds, rateSpecs } = {}) {
    if (!line) return null;
    const totals = {};
    Object.keys(line).forEach(id => {
        const v = Number(line[id]);
        if (Number.isFinite(v)) totals[id] = v;
    });
    const rateIds = (rateSpecs || []).map(s => String(s.out));
    const wanted = (categoryIds || []).map(String).filter(id => rateIds.includes(id));
    if (wanted.length) {
        const derived = rosterTotals([totals], wanted, rateSpecs);
        wanted.forEach(id => {
            if (derived[id] === null || derived[id] === undefined) delete totals[id];
            else totals[id] = derived[id];
        });
    }
    return totals;
}

/**
 * Whether a player carries any of a set of categories. It asks about absence, not zero: a real
 * zero is evidence and a missing key is not.
 *
 * @param {Object<string, number>} totals The player's totals.
 * @param {Array<string|number>} categoryIds The categories.
 * @returns {boolean} True when any of them is present.
 */
export function carriesAny(totals, categoryIds) {
    return (categoryIds || []).some(id => {
        const v = (totals || {})[String(id)];
        return v !== undefined && v !== null;
    });
}

// ==== The basis ====

/**
 * A whole past season, grouped and totalled, ready for the rank engine. Everyone who could not
 * be placed is returned with a reason.
 *
 * @param {Array<{id: number, name: string, defaultPositionId: number, eligibleSlots: number[], line: object}>} pool That season's own pool.
 * @param {object} [opts]
 * @param {number} [opts.seasonId] The season.
 * @param {Array<string|number>} [opts.categoryIds] The league's scored categories, today's settings applied to that season.
 * @param {Set<string>} [opts.secondaryStatIds] The categories of the secondary group.
 * @param {Set<number>} [opts.secondarySlots] The lineup slots of the secondary group.
 * @param {Set<number>} [opts.nonStartingSlots] The bench and injury slots.
 * @param {object[]} [opts.rateSpecs] The sport's rate rules.
 * @param {{primary: *, secondary: *}} [opts.gamesIds] The games-played stat id per group.
 * @returns {{seasonId: number, categoryIds: {primary: string[], secondary: string[]}, groups: {primary: object[], secondary: object[]}, twoWay: number[], skipped: Array<{id: number, name: string, reason: string}>}}
 *   Both groups, the two-way players, and the players left out.
 */
export function retroBasis(pool, opts = {}) {
    const { categoryIds = [], secondaryStatIds, secondarySlots, nonStartingSlots,
        rateSpecs, gamesIds = {} } = opts;
    const secondary = secondaryStatIds instanceof Set
        ? secondaryStatIds
        : new Set((secondaryStatIds || []).map(String));
    const secSlots = secondarySlots instanceof Set
        ? secondarySlots : new Set((secondarySlots || []).map(Number));
    const benchSlots = nonStartingSlots instanceof Set
        ? nonStartingSlots : new Set((nonStartingSlots || []).map(Number));
    const ids = categoryIds.map(String);
    const catsFor = {
        primary: ids.filter(id => !secondary.has(id)),
        secondary: ids.filter(id => secondary.has(id))
    };

    const groups = { primary: [], secondary: [] };
    const twoWay = [];
    const skipped = [];

    (pool || []).forEach(p => {
        if (!p || p.id === undefined || p.id === null) return;
        const totals = seasonTotalsFrom(p.line, { categoryIds: ids, rateSpecs });
        if (!totals || !Object.keys(totals).length) {
            skipped.push({ id: p.id, name: p.name, reason: 'no stat line for this season' });
            return;
        }
        const entry = {
            id: p.id,
            name: p.name,
            // This season's own eligibility, carried untouched.
            defaultPositionId: p.defaultPositionId,
            eligibleSlots: p.eligibleSlots || [],
            seasonTotals: totals
        };
        // Eligibility for a group's slots, read off this season's pool. Bench and injury slots are left out, since everybody is eligible for them and they say nothing about a player's role.
        const slots = (entry.eligibleSlots || []).map(Number).filter(s => !benchSlots.has(s));
        const eligible = {
            secondary: !secSlots.size || slots.some(s => secSlots.has(s)),
            primary: !secSlots.size || slots.some(s => !secSlots.has(s))
        };

        let placed = 0;
        ['primary', 'secondary'].forEach(g => {
            if (!eligible[g]) return;
            if (!catsFor[g].length || !carriesAny(totals, catsFor[g])) return;
            const gamesId = gamesIds[g] === undefined ? null : String(gamesIds[g]);
            groups[g].push({ ...entry, games: gamesId !== null ? (totals[gamesId] || 0) : 0 });
            placed++;
        });
        if (placed === 2) twoWay.push(p.id);
        if (placed === 0) {
            skipped.push({
                id: p.id, name: p.name,
                reason: (eligible.primary || eligible.secondary)
                    ? 'carries none of the league\'s categories'
                    : 'eligible at no starting slot this season'
            });
        }
    });

    return { seasonId: opts.seasonId, categoryIds: catsFor, groups, twoWay, skipped };
}

/**
 * The players of a group who were eligible at a slot that season. A position filter asks this and
 * never the current pool.
 *
 * @param {object[]} basisGroup One group from retroBasis.
 * @param {number} slotId The lineup slot.
 * @returns {object[]} The eligible players.
 */
export function eligibleAt(basisGroup, slotId) {
    const slot = Number(slotId);
    return (basisGroup || []).filter(p => (p.eligibleSlots || []).includes(slot));
}

// ==== From the engine's answer to the contract's row ====

// One result is sorted and ranked once, however many of its players are asked about. The index is held against the result object, so it goes when the result does, and it is rebuilt if the result's scores or ranked list have changed.
const resultIndexes = new WeakMap();
function indexOfResult(result) {
    const scores = result.scores instanceof Map ? result.scores : null;
    const held = resultIndexes.get(result);
    if (held && held.scores === scores && held.size === (scores ? scores.size : 0) && held.ranked === result.ranked) return held;
    const sorted = scores ? [...scores.entries()].sort((a, b) => b[1] - a[1]) : [];
    const ranks = competitionRanks(sorted.map(e => e[1]));
    const rankOf = new Map();
    const sharing = new Map();
    sorted.forEach((e, i) => {
        // The first position a player id holds.
        if (!rankOf.has(e[0])) rankOf.set(e[0], ranks[i]);
        sharing.set(ranks[i], (sharing.get(ranks[i]) || 0) + 1);
    });
    const built = {
        scores, size: scores ? scores.size : 0, ranked: result.ranked,
        total: sorted.length, rankOf, sharing,
        pooled: new Set((result.ranked || []).map(p => p.id))
    };
    resultIndexes.set(result, built);
    return built;
}

/**
 * One season's row for one player, from what the rank engine returned for the player's group.
 * Three outcomes are kept apart: a player not in the pool gets no row; one in the pool and not
 * ranked gets a null rank and a real games count; a ranked one gets everything.
 *
 * The rank is a competition rank, so players on equal scores share it, and the row says when it is
 * shared.
 *
 * @param {object} result The rank engine's result for the group that season.
 * @param {number} playerId The player.
 * @param {object} [options]
 * @param {number} [options.seasonId] The season.
 * @param {number} [options.games] The player's games that season.
 * @returns {?{seasonId: number, rank: ?number, total: number, tied: boolean, games: number, percentiles: Object<string, number>}} The row, or null for a player not in that season's pool.
 */
export function seasonRowFrom(result, playerId, { seasonId, games } = {}) {
    if (!result) return null;
    const index = indexOfResult(result);
    const inPool = index.pooled.has(playerId) || (index.scores !== null && index.scores.has(playerId));
    if (!inPool) return null;
    const total = index.total;

    if (!index.rankOf.has(playerId)) {
        return {
            seasonId, rank: null, total, tied: false,
            games: Number.isFinite(games) ? games : 0, percentiles: {}
        };
    }
    const rank = index.rankOf.get(playerId);
    const pcts = result.byCategory instanceof Map ? result.byCategory.get(playerId) : null;
    const percentiles = {};
    if (pcts) pcts.forEach((v, id) => { percentiles[id] = v; });
    return {
        seasonId,
        rank,
        total,
        tied: index.sharing.get(rank) > 1,
        games: Number.isFinite(games) ? games : 0,
        percentiles
    };
}

/**
 * Several seasons' rows for one player, in ascending order of season, with the seasons that carry
 * no data left out.
 *
 * @param {number} playerId The player.
 * @param {Array<{seasonId: number, result: object, games: number}>} seasons One entry per season already ranked.
 * @returns {object[]} The rows, from seasonRowFrom.
 */
export function seasonRowsFor(playerId, seasons) {
    return (seasons || [])
        .map(s => seasonRowFrom(s && s.result, playerId, { seasonId: s && s.seasonId, games: s && s.games }))
        .filter(Boolean)
        .sort((a, b) => a.seasonId - b.seasonId);
}
