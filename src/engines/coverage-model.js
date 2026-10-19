/**
 * The data behind My Team's category coverage band: where a roster stands in every scored
 * category, which of its players put it there, who is available that would move a losing category,
 * and who could be spared. Also the ledger that prices one move against the standings.
 *
 * Pure. No DOM, no application state and no network; every table arrives as an argument. Nothing
 * here estimates a probability. Every figure is a real total, a real share of teams beaten, or an
 * exact recomputation of what a figure would be with a player added or removed. A rate is
 * recomputed from its components and never added up.
 *
 * Tests: tests/coverage-model.test.html
 * @module coverage-model
 */
/**
 * The tables every measure here is taken against. A player in these functions is any object
 * carrying its stat line under seasonTotals; the caller decides which line that is.
 *
 * @typedef {object} CoverageContext
 * @property {object[]} components How each rate category is built from components.
 * @property {Set<string>} inverseIds The categories where lower is better.
 * @property {function(object): Set} [slotsOf] The lineup slots a player may fill. swapPair refuses without it.
 * @property {Object<string, object>} [sumsByTeam] Every team's component sums, for rankAdds.
 * @property {?number} [limit] The most rows rankAdds returns.
 */

import { coverageOf, holesFrom } from './draft-engine.js';

/**
 * Finds the rule that builds a rate category. A counting category has none.
 *
 * @param {object[]} components The sport's rate rules.
 * @param {string|number} id The category.
 * @returns {?object} The rule: a numerator, denominator and scale, or a list of rates to add. Null for a counting category.
 */
export function rateSpecFor(components, id) {
    return (components || []).find(c => String(c.out) === String(id)) || null;
}

/**
 * One category's value from a set of component sums. A counting category is its own sum and a
 * rate is recomputed.
 *
 * @param {Object<string, number>} sums The component sums.
 * @param {string|number} id The category.
 * @param {object[]} components The sport's rate rules.
 * @returns {?number} The value. Null when a component is missing or the denominator is zero, since a team with no innings has no ERA.
 */
export function valueFrom(sums, id, components) {
    const spec = rateSpecFor(components, id);
    const raw = (key) => {
        const v = Number((sums || {})[key]);
        return Number.isFinite(v) ? v : null;
    };
    if (!spec) return raw(id);
    if (spec.add) {
        const parts = spec.add.map(p => valueFrom(sums, p, components));
        return parts.some(v => v === null) ? null : parts.reduce((a, b) => a + b, 0);
    }
    const num = (spec.num || []).reduce((sum, k) => sum === null ? null : (raw(k) === null ? null : sum + raw(k)), 0);
    const den = (spec.den || []).reduce((sum, k) => sum === null ? null : (raw(k) === null ? null : sum + raw(k)), 0);
    if (num === null || den === null || den === 0) return null;
    return (num / den) * (spec.scale || 1);
}

/**
 * Sums the given stat ids across a set of players.
 *
 * @param {Array<{seasonTotals: Object<string, number>}>} players The players.
 * @param {string[]} ids The stat ids to sum.
 * @returns {Object<string, number>} The sums. An id no player carries has no key.
 */
export function sumPlayers(players, ids) {
    const out = {};
    (players || []).forEach(p => {
        const totals = (p && p.seasonTotals) || {};
        (ids || []).forEach(id => {
            const v = Number(totals[id]);
            if (Number.isFinite(v)) out[id] = (out[id] || 0) + v;
        });
    });
    return out;
}

/**
 * Every stat id the model has to sum for a set of categories: the categories themselves and the
 * components of any rate among them.
 *
 * @param {Array<string|number>} categoryIds The categories.
 * @param {object[]} components The sport's rate rules.
 * @returns {string[]} The ids.
 */
export function idsToSum(categoryIds, components) {
    const out = new Set();
    const add = (id) => {
        out.add(String(id));
        const spec = rateSpecFor(components, id);
        if (!spec) return;
        (spec.num || []).forEach(k => out.add(String(k)));
        (spec.den || []).forEach(k => out.add(String(k)));
        (spec.add || []).forEach(k => add(k));
    };
    (categoryIds || []).forEach(add);
    return [...out];
}

/**
 * What one player is worth to a category, measured by taking the player out and recomputing.
 * Positive means the team is better with the player, in the direction the category is scored.
 *
 * @param {object} player The player, one of the roster's own objects.
 * @param {string|number} id The category.
 * @param {object[]} roster The roster.
 * @param {CoverageContext} ctx The tables.
 * @returns {?number} The contribution, or null when the category cannot be measured with or without the player.
 */
export function contributionOf(player, id, roster, ctx) {
    const { components, inverseIds } = ctx;
    const ids = idsToSum([id], components);
    const withPlayer = valueFrom(sumPlayers(roster, ids), id, components);
    const without = valueFrom(sumPlayers((roster || []).filter(p => p !== player), ids), id, components);
    if (withPlayer === null && without === null) return null;
    // Removing the last contributor leaves no figure at all. That contribution is the whole of the category and has no number, so it is null.
    if (without === null) return null;
    if (withPlayer === null) return null;
    const delta = withPlayer - without;
    return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
}

/**
 * The players who carry a category, biggest contribution first. Only positive contributors are
 * listed.
 *
 * @param {object[]} roster The roster.
 * @param {string|number} id The category.
 * @param {CoverageContext} ctx The tables.
 * @param {number} [limit=2] The most to return.
 * @returns {Array<{player: object, contribution: number}>} The drivers.
 */
export function driversFor(roster, id, ctx, limit = 2) {
    return (roster || [])
        .map(p => ({ player: p, contribution: contributionOf(p, id, roster, ctx) }))
        .filter(d => d.contribution !== null && d.contribution > 0)
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, limit);
}

/**
 * What a free agent would move a category by, measured by adding the player and recomputing. It
 * is the same measure as a contribution, in the same units.
 *
 * @param {object} candidate The free agent.
 * @param {string|number} id The category.
 * @param {object[]} roster The roster.
 * @param {CoverageContext} ctx The tables.
 * @returns {?number} The gain in the direction the category is scored, or null when it cannot be measured.
 */
export function gainFrom(candidate, id, roster, ctx) {
    const { components, inverseIds } = ctx;
    const ids = idsToSum([id], components);
    const before = valueFrom(sumPlayers(roster, ids), id, components);
    const after = valueFrom(sumPlayers([...(roster || []), candidate], ids), id, components);
    if (after === null) return null;
    // A roster with nothing in a counting category has none of it, so the baseline is zero and the candidate's own line is the whole gain. A rate is left alone: a rate with no denominator on the roster has no zero to fall back to.
    if (before === null) {
        if (rateSpecFor(components, id)) return null;
        const delta = after - 0;
        return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
    }
    const delta = after - before;
    return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
}

/**
 * The roster player who costs least to lose. Cost is the player's share of the team's own figure
 * in each category, summed over every category the league scores.
 *
 * Three kinds of player are never named: one in the injured-reserve slot, since dropping that
 * player frees no roster spot; one who is the only holder of a category; and one who carries a
 * category the team is losing.
 *
 * @param {object[]} roster The roster. A player in the injured-reserve slot carries irSlot.
 * @param {Array<string|number>} categoryIds The scored categories.
 * @param {CoverageContext} ctx The tables.
 * @param {object} [options]
 * @param {Array<string|number>} [options.losingIds] The categories shown as losing.
 * @param {number} [options.driverLimit=2] How many drivers of a losing category are protected.
 * @returns {?{player: object, cost: number, measured: number, indispensable: boolean}} The player, or null when there is nobody to spare.
 */
export function cheapestSwap(roster, categoryIds, ctx, { losingIds = null, driverLimit = 2 } = {}) {
    const { components } = ctx;
    const vetoed = new Set();
    (losingIds || []).forEach(id => {
        driversFor(roster, id, ctx, driverLimit).forEach(d => vetoed.add(d.player));
    });
    const costs = (roster || []).map(player => {
        let cost = 0;
        let measured = 0;
        let indispensable = false;
        (categoryIds || []).forEach(id => {
            const ids = idsToSum([id], components);
            const team = valueFrom(sumPlayers(roster, ids), id, components);
            if (team === null) return;
            const without = valueFrom(sumPlayers((roster || []).filter(p => p !== player), ids), id, components);
            // The only one holding it. If dropping a player leaves the category with no figure, that player is the whole of it and is never the cheapest to lose.
            if (without === null) { indispensable = true; return; }
            const contribution = contributionOf(player, id, roster, ctx);
            if (contribution === null || team === 0) return;
            measured += 1;
            cost += Math.abs(contribution / team);
        });
        return { player, cost, measured, indispensable };
    }).filter(c => c.measured > 0 && !c.indispensable
        && !(c.player && c.player.irSlot) && !vetoed.has(c.player));
    if (!costs.length) return null;
    costs.sort((a, b) => a.cost - b.cost);
    return costs[0];
}

// A lower-is-better counting category has no add, since nobody is picked up for errors. It is offered a swap pair. A lower-is-better rate is a real add and keeps its list.
function isInverseCounting(id, ctx) {
    const { components, inverseIds } = ctx;
    if (!inverseIds || !inverseIds.has(String(id))) return false;
    return !rateSpecFor(components, id);
}

// One player's signed contribution to the categories the team is winning, as a share of the team's own figure in each, which is what lets categories on different scales be added. Signed, not absolute: a player charging heavily in a winning lower-is-better category must read as a cost.
function strongShare(player, strongIds, roster, ctx) {
    const { components } = ctx;
    let sum = 0;
    const matched = [];
    (strongIds || []).forEach(id => {
        const team = valueFrom(sumPlayers(roster, idsToSum([id], components)), id, components);
        if (team === null || team === 0) return;
        const c = contributionOf(player, id, roster, ctx);
        if (c === null) return;
        matched.push(String(id));
        sum += c / team;
    });
    return { share: sum, matched };
}

// The same measure for a player not on the roster: what the player would add to the winning set, against the roster being joined.
function strongGain(candidate, strongIds, roster, ctx) {
    const { components } = ctx;
    let sum = 0;
    (strongIds || []).forEach(id => {
        const team = valueFrom(sumPlayers(roster, idsToSum([id], components)), id, components);
        if (team === null || team === 0) return;
        const g = gainFrom(candidate, id, roster, ctx);
        if (g === null) return;
        sum += g / team;
    });
    return sum;
}

/**
 * For a lower-is-better counting category, the roster player charging the most in it and the
 * free agent who does at least as much for the categories the team is winning while charging less.
 *
 * The free agent must be eligible at the dropped player's slot, so the move leaves no hole. A
 * caller that supplies no slot lookup gets null.
 *
 * @param {string|number} id The category.
 * @param {object[]} roster The roster. Each player carries its slot.
 * @param {Array<string|number>} strongIds The categories the team is winning.
 * @param {object[]} available The free agents. One the caller marks as out is skipped.
 * @param {CoverageContext} ctx The tables, with slotsOf.
 * @returns {?{drop: object, add: object, saving: number, ratio: ?number, matched: string[]}} The pair, or null when none exists.
 */
export function swapPair(id, roster, strongIds, available, ctx) {
    const slotsOf = ctx && ctx.slotsOf;
    if (typeof slotsOf !== 'function') return null;
    if (!(strongIds || []).length) return null;
    const chargeOf = (p) => {
        const n = Number((p && p.seasonTotals) ? p.seasonTotals[id] : undefined);
        return Number.isFinite(n) ? n : null;
    };
    const chargers = (roster || [])
        .filter(p => p && !p.irSlot && (chargeOf(p) || 0) > 0)
        .sort((a, b) => chargeOf(b) - chargeOf(a));
    if (!chargers.length) return null;
    const drop = chargers[0];
    const dropCharge = chargeOf(drop);
    const { share, matched } = strongShare(drop, strongIds, roster, ctx);
    if (!matched.length) return null;

    // The candidate is measured against the roster as it would be without the player replaced, the same roster the cost is computed on.
    const rest = (roster || []).filter(p => p !== drop);
    let best = null;
    (available || []).forEach(p => {
        if (!p || p.out) return;
        const charge = chargeOf(p);
        if (charge === null || !(charge < dropCharge)) return;
        const slots = slotsOf(p);
        if (!slots || !slots.has(drop.slot)) return;
        const gain = strongGain(p, strongIds, rest, ctx);
        if (!(gain >= share)) return;
        if (!best || gain > best.gain || (gain === best.gain && charge < best.charge)) {
            best = { player: p, gain, charge };
        }
    });
    if (!best) return null;
    return {
        drop,
        add: best.player,
        // What the move is worth in the category itself, in the category's own unit.
        saving: dropCharge - best.charge,
        // The ratio achieved, not a threshold applied. Null where the dropped player's own contribution is zero or negative.
        ratio: share > 0 ? best.gain / share : null,
        matched
    };
}

/**
 * Ranks the available players by what they would add across a set of categories. Each gain is
 * divided by the distance between the best and worst team in that category, so one category
 * cannot swamp the rest. A category with no spread adds nothing. Lower-is-better counting
 * categories are left out of the set.
 *
 * @param {object[]} available The free agents. One the caller marks as out is skipped.
 * @param {object[]} roster The roster.
 * @param {Array<string|number>} ids The categories.
 * @param {CoverageContext} [ctx] The tables, with sumsByTeam and an optional limit.
 * @returns {Array<{player: object, gains: Object<string, number>, composite: number}>} The players, best first.
 */
export function rankAdds(available, roster, ids, ctx = {}) {
    const { components, sumsByTeam, limit = null } = ctx;
    const set = (ids || []).map(String).filter(id => !isInverseCounting(id, ctx));
    if (!set.length) return [];
    const spread = {};
    set.forEach(id => {
        const vals = Object.keys(sumsByTeam || {})
            .map(t => valueFrom(sumsByTeam[t], id, components))
            .filter(v => v !== null && Number.isFinite(v));
        spread[id] = vals.length > 1 ? (Math.max(...vals) - Math.min(...vals)) : 0;
    });
    const rows = (available || [])
        .filter(p => p && !p.out)
        .map(p => {
            const gains = {};
            let composite = 0;
            set.forEach(id => {
                const g = gainFrom(p, id, roster, ctx);
                if (g === null) return;
                gains[id] = g;
                if (spread[id]) composite += g / spread[id];
            });
            return { player: p, gains, composite };
        })
        .filter(r => Object.keys(r.gains).length)
        .sort((a, b) => b.composite - a.composite);
    return limit ? rows.slice(0, limit) : rows;
}

/**
 * Prices one move against the standings: any number of players out and any number in, with what
 * each side is worth in every category, the team's figure before and after, and the rank and
 * margin either side.
 *
 * With a banked line given, the team's figure is what it has banked plus its roster's forward
 * line, and every team's sums must be on that same basis. Only the forward line changes hands. A
 * rate is rebuilt from the combined components and never averaged. The league's place is the
 * caller's rule, passed in.
 *
 * @param {object[]} roster The roster, on the forward basis.
 * @param {{out: Array, in: object[]}} move The ids or players going out, and the players coming in.
 * @param {CoverageContext} ctx The tables.
 * @param {object} [standings]
 * @param {Array<string|number>} [standings.categoryIds] The scored categories.
 * @param {Object<string, object>} [standings.sumsByTeam] Every team's component sums.
 * @param {Object<string, object>} [standings.sumsByTeamAfter] Every team's sums after the move, for a trade.
 * @param {number|string} [standings.teamId] This team.
 * @param {Object<string, number>} [standings.banked] This team's component sums so far.
 * @param {function(Object<string, object>, *): *} [standings.placeFrom] Turns every team's category values into this team's place.
 * @returns {?{categories: Array<{id: *, before: ?number, after: ?number, dropLine: ?number, addLine: ?number, change: ?number, delta: ?number, rankBefore: ?number, rankAfter: ?number, marginBefore: ?number, margin: ?number}>, summary: {gained: Array, lost: Array, unchanged: number, placeBefore: *, placeAfter: *}}}
 *   Null when nobody named is on the roster or no category is given.
 */
export function ledgerFor(roster, move, ctx, standings = {}) {
    const { components, inverseIds } = ctx || {};
    const { categoryIds = [], sumsByTeam = null, teamId = null, placeFrom = null, banked = null,
        sumsByTeamAfter = null } = standings;
    const outIds = ((move && move.out) || []).map(v => String(v && v.id !== undefined ? v.id : v));
    const incoming = ((move && move.in) || []).filter(Boolean);

    // Resolved to the roster's own objects and removed by identity, so a roster carrying the same id twice loses the one named and not both. An id naming nobody is not out.
    const goingOut = [];
    outIds.forEach(id => {
        const hit = (roster || []).find(p => p && String(p.id) === id && goingOut.indexOf(p) === -1);
        if (hit) goingOut.push(hit);
    });
    if (!goingOut.length || !(categoryIds || []).length) return null;
    const inverse = (id) => !!(inverseIds && inverseIds.has(String(id)));

    const outSet = new Set(goingOut);
    const after = (roster || []).filter(p => !outSet.has(p));
    // What comes in is optional, so the same ledger answers a plain drop. The added line is then null throughout, not zero.
    incoming.forEach(p => after.push(p));

    const ids = idsToSum(categoryIds, components);
    // Banked plus forward, component by component. A key absent from both stays absent, so an unmeasured category still reads null.
    const withBanked = (forward) => {
        if (!banked) return forward;
        const out = { ...forward };
        ids.forEach(k => {
            const v = Number(banked[k]);
            if (!Number.isFinite(v)) return;
            const f = Number(out[k]);
            out[k] = (Number.isFinite(f) ? f : 0) + v;
        });
        return out;
    };
    const beforeSums = withBanked(sumPlayers(roster, ids));
    const afterSums = withBanked(sumPlayers(after, ids));
    const dropSums = sumPlayers(goingOut, ids);
    const addSums = incoming.length ? sumPlayers(incoming, ids) : null;

    // Every other team's value per category, computed once. This team's own row is never read from here; it is recomputed from the roster.
    const others = Object.keys(sumsByTeam || {}).filter(t => String(t) !== String(teamId));

    // Every other team's row is fixed in a drop and is not in a trade, which moves both sides at once. So the ranks after the move may be measured against a second map. With none given it is the first.
    const afterTeamSums = sumsByTeamAfter || sumsByTeam;
    const rankAndMargin = (id, mine, source) => {
        if (mine === null || !others.length) return { rank: null, margin: null };
        const better = (a, b) => (inverse(id) ? a < b : a > b);
        const rows = others
            .map(t => ({ teamId: t, value: valueFrom((source || sumsByTeam)[t], id, components) }))
            .filter(r => r.value !== null);
        if (!rows.length) return { rank: null, margin: null };
        const ahead = rows.filter(r => better(r.value, mine));
        const rank = ahead.length + 1;
        // The gap that matters is the one that could be closed. With a team ahead, it is the nearest team in front and the number is negative. In first, it is the nearest team behind and the number is positive.
        const pool = ahead.length ? ahead : rows.filter(r => better(mine, r.value));
        if (!pool.length) return { rank, margin: null };
        const nearest = pool.reduce((best, r) =>
            (Math.abs(r.value - mine) < Math.abs(best.value - mine) ? r : best), pool[0]);
        const gap = Math.abs(nearest.value - mine);
        return { rank, margin: { teamId: nearest.teamId, gap: ahead.length ? -gap : gap } };
    };

    const valuesFor = (sums) => {
        const row = {};
        (categoryIds || []).forEach(id => { row[id] = valueFrom(sums, id, components); });
        return row;
    };
    const beforeValues = valuesFor(beforeSums);
    const afterValues = valuesFor(afterSums);

    let gainedCount = 0;
    let lostCount = 0;
    const categories = (categoryIds || []).map(id => {
        const before = beforeValues[id];
        const afterValue = afterValues[id];
        // Signed in the direction the category is scored, so a lower ERA reads as a positive change. Null when either side has no figure.
        const change = (before === null || afterValue === null)
            ? null
            : (inverse(id) ? before - afterValue : afterValue - before);
        const rb = rankAndMargin(id, before, sumsByTeam);
        const ra = rankAndMargin(id, afterValue, afterTeamSums);
        if (rb.rank !== null && ra.rank !== null) {
            if (ra.rank < rb.rank) gainedCount += 1;
            else if (ra.rank > rb.rank) lostCount += 1;
        }
        return {
            id,
            before,
            after: afterValue,
            dropLine: valueFrom(dropSums, id, components),
            addLine: addSums ? valueFrom(addSums, id, components) : null,
            change,
            delta: (before === null || afterValue === null) ? null : afterValue - before,
            rankBefore: rb.rank,
            rankAfter: ra.rank,
            marginBefore: rb.margin,
            margin: ra.margin
        };
    });

    // Gained and lost are about the standing and not the figure: a move that adds to a category without passing anyone has gained nothing to spend. Unchanged counts the rows ranked on both sides that did not move.
    const ranked = categories.filter(c => c.rankBefore !== null && c.rankAfter !== null);
    const place = (values, source) => {
        if (typeof placeFrom !== 'function' || teamId === null) return null;
        const byTeam = {};
        others.forEach(t => { byTeam[t] = valuesFor((source || sumsByTeam)[t]); });
        byTeam[teamId] = values;
        const p = placeFrom(byTeam, teamId);
        return p === undefined ? null : p;
    };
    return {
        categories,
        summary: {
            gained: categories.filter(c => c.rankBefore !== null && c.rankAfter !== null
                && c.rankAfter < c.rankBefore).map(c => c.id),
            lost: categories.filter(c => c.rankBefore !== null && c.rankAfter !== null
                && c.rankAfter > c.rankBefore).map(c => c.id),
            unchanged: ranked.length - gainedCount - lostCount,
            placeBefore: place(beforeValues, sumsByTeam),
            placeAfter: place(afterValues, afterTeamSums)
        }
    };
}

/**
 * The ledger for one player out and, optionally, one in.
 *
 * @param {object[]} roster The roster.
 * @param {number|string} dropId The player going out.
 * @param {?object} candidate The player coming in, or null for a plain drop.
 * @param {CoverageContext} ctx The tables.
 * @param {object} [standings] The same standings ledgerFor takes.
 * @returns {?object} ledgerFor's result.
 */
export function dropLedger(roster, dropId, candidate, ctx, standings = {}) {
    return ledgerFor(roster, { out: [dropId], in: candidate ? [candidate] : [] }, ctx, standings);
}

/**
 * The whole band: one row per scored category. The actuals decide where the team stands. The
 * forward basis, when given, decides what to do next: the drivers, the adds and the swap.
 *
 * @param {object} args
 * @param {Object<string, object>} args.sumsByTeam Every team's component sums.
 * @param {number|string} args.teamId This team.
 * @param {object[]} args.roster This team's players, on the actuals.
 * @param {object[]} [args.available] The free agents worth ranking.
 * @param {Array<string|number>} args.categoryIds The scored categories.
 * @param {object[]} args.components The sport's rate rules.
 * @param {Set<string>} args.inverseIds The categories where lower is better.
 * @param {number} [args.holeThreshold] The share below which a category is a hole.
 * @param {number} [args.driverLimit=2] The most drivers per category.
 * @param {number} [args.addLimit=3] The most adds per category.
 * @param {object[]} [args.projectedRoster] The same players carrying their forward line.
 * @param {object[]} [args.projectedAvailable] The free agents carrying their forward line.
 * @param {object} [args.window] The horizon the forward basis covers.
 * @param {Set<string>} [args.searchIds] More categories to find adds for, beyond the holes.
 * @param {function(object): Set} [args.slotsOf] The lineup slots a player may fill.
 * @returns {{categories: Array<{id: *, value: ?number, share: ?number, weak: boolean, inverse: boolean, rate: boolean, projected: ?number, drivers: object[], adds: object[], swap: ?object, pair: ?object}>, strongIds: Array, holeIds: Array, window: ?object}}
 *   The band. A category with no figure keeps its row, with nulls.
 */
export function coverageBand({
    sumsByTeam, teamId, roster, available = [], categoryIds, components, inverseIds,
    holeThreshold, driverLimit = 2, addLimit = 3,
    projectedRoster = null, projectedAvailable = null, window = null, searchIds = null,
    slotsOf = null
} = {}) {
    // The slot lookup travels in the context. Without it the pair refuses, and a lower-is-better counting row carries no pair.
    const ctx = { components, inverseIds, slotsOf };
    // The basis every forward-looking figure is computed from. It falls back to the actuals, so a caller with one basis works unchanged.
    const forwardRoster = projectedRoster || roster;
    const forwardAvailable = projectedAvailable || available;
    // Every team's category values, computed before the comparison. The sums are components, and a rate has no stored total, so they are turned into values here.
    const valuesByTeam = {};
    Object.keys(sumsByTeam || {}).forEach(t => {
        const row = {};
        (categoryIds || []).forEach(id => { row[id] = valueFrom(sumsByTeam[t], id, components); });
        valuesByTeam[t] = row;
    });
    const coverage = coverageOf(valuesByTeam, teamId, categoryIds, { inverseIds });
    const holes = new Set(holeThreshold === undefined
        ? holesFrom(coverage)
        : holesFrom(coverage, holeThreshold));
    const strongIds = coverage.filter(c => c.share !== null && !holes.has(c.id)).map(c => c.id);
    // Which rows this band will call losing: this model's own holes by share, plus whatever the caller says it will show as losing. A player carrying any of them is never offered as the one to spare.
    const losingIds = [...new Set([...holes, ...[...(searchIds || [])].map(String)])];
    // One swap for the whole band, since it depends on nothing per category. It is costed on the forward basis and across every scored category.
    const swap = (categoryIds || []).length
        ? cheapestSwap(forwardRoster, categoryIds, ctx, { losingIds, driverLimit })
        : null;

    // The roster's forward component sums, computed once. Null throughout when no forward basis was supplied.
    const forwardSums = projectedRoster
        ? sumPlayers(forwardRoster, idsToSum(categoryIds || [], components))
        : null;

    // Which rows get a list of adds: the holes, plus the ids the caller passes. The caller's ids add to the set, since the holes are computed here and the caller cannot know them in advance.
    const searched = (id) => holes.has(id) || !!(searchIds && searchIds.has(String(id)));

    const categories = coverage.map(c => {
        const weak = holes.has(c.id);
        const row = {
            id: c.id,
            value: c.value,
            share: c.share,
            weak,
            inverse: !!(inverseIds && inverseIds.has(String(c.id))),
            // Rate or counting, stated and not guessed from the number. The test is whether the league's table gives the category components.
            rate: !!rateSpecFor(components, c.id),
            // The forward figure, beside the actual one and not in place of it. A rate is rebuilt from its components.
            projected: forwardSums ? valueFrom(forwardSums, c.id, components) : null,
            drivers: driversFor(forwardRoster, c.id, ctx, driverLimit),
            adds: [],
            swap: null,
            // The pair is its own field and never shares the swap's. It is null on every row but a lower-is-better counting one, and null there too when no pair exists.
            pair: null
        };
        // Only a category shown as losing gets a list of adds. The swap stays on the weak rows alone.
        if (searched(c.id)) {
            // Gains are measured on the forward basis, since what a player would add is a claim about games not yet played. A player the caller marks as out is never named as an add: ESPN's projection for the rest of the season does not discount an injured player. A lower-is-better counting row takes the pair in place of a list.
            if (isInverseCounting(c.id, ctx)) {
                row.pair = swapPair(c.id, forwardRoster, strongIds, forwardAvailable, ctx);
                if (weak) row.swap = swap;
                return row;
            }
            row.adds = (forwardAvailable || [])
                .filter(p => !(p && p.out))
                .map(p => ({ player: p, gain: gainFrom(p, c.id, forwardRoster, ctx) }))
                .filter(a => a.gain !== null && a.gain > 0)
                .sort((a, b) => b.gain - a.gain)
                .slice(0, addLimit);
            if (weak) row.swap = swap;
        }
        return row;
    });

    // The window travels with the band, so a page words the horizon from a field. Null when no forward basis was supplied.
    return {
        categories,
        strongIds,
        holeIds: [...holes],
        window: window ? {
            kind: window.kind === 'matchup' ? 'matchup' : 'rest',
            label: window.label ?? null,
            matchup: window.matchup ?? null,
            periods: Array.isArray(window.periods) ? window.periods.slice() : null,
            asOf: window.asOf ?? null
        } : null
    };
}
