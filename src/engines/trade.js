/**
 * What a trade does to both teams: per category, in the standings and in the seats, and then in
 * words, never as a percentage or a grade.
 *
 * It owns only what a trade adds: the two sides moving at once, the seats, and the sentences.
 * Every figure per category comes from coverage-model.js's ledgerFor. There is no projection
 * arithmetic here; the caller hands in rosters on the basis it wants priced.
 *
 * Pure. No DOM, no application state, no storage and no network.
 *
 * Contract: tests/fixtures/trade.md
 * Tests: tests/trade.test.html
 * @module trade
 */
/**
 * One side of a trade, after it is priced.
 *
 * @typedef {object} TradeSide
 * @property {Array<{statId: *, before: ?number, after: ?number, delta: ?number, rankBefore: ?number, rankAfter: ?number}>} perCategory The side's figure and rank in each category, before and after. The delta is after less before, with no scoring direction applied.
 * @property {Object<string, {before: number, after: number, slots: number, openBefore: number, openAfter: number}>} seats Per position: how many the roster holds before and after, how many the league starts, and how many seats are open.
 * @property {{categoriesUp: number, categoriesDown: number, netRankPlaces: number}} verdict How many categories rose and fell in rank, and the rank places gained in all. Positive is better.
 */
import { ledgerFor, idsToSum, sumPlayers } from './coverage-model.js';
import { openNeeds } from './draft-engine.js';

const key = v => String(v && v.id !== undefined ? v.id : v);

// The players a side is sending, resolved from its own roster. An id naming nobody on that roster is not in the trade.
function resolve(roster, ids) {
    const want = (ids || []).map(key);
    const out = [];
    want.forEach(id => {
        const hit = (roster || []).find(p => p && String(p.id) === id && out.indexOf(p) === -1);
        if (hit) out.push(hit);
    });
    return out;
}

// The seats: per position, how many the roster holds beside how many the league starts and how many are still open. The open figure comes from draft-engine.js's openNeeds, so the two readings of a seat agree.
function seatsFor(before, after, slots) {
    const shape = slots || {};
    const positionsOf = p => (p && (p.eligiblePositions || p.positions)) || [];
    // Filled is counted directly and open comes from openNeeds, since they are two questions. The open figure stops at zero, so by itself it could not say a roster holds three for two seats.
    const count = roster => {
        const out = {};
        Object.keys(shape).forEach(pos => {
            out[pos] = (roster || []).filter(p => positionsOf(p).indexOf(pos) !== -1).length;
        });
        return out;
    };
    const b = count(before);
    const a = count(after);
    const openB = openNeeds((before || []).map(positionsOf), shape);
    const openA = openNeeds((after || []).map(positionsOf), shape);
    const seats = {};
    Object.keys(shape).forEach(pos => {
        seats[pos] = {
            before: b[pos], after: a[pos], slots: Number(shape[pos]) || 0,
            openBefore: openB[pos], openAfter: openA[pos]
        };
    });
    return seats;
}

// A ledger's categories as the trade's rows, with the verdict the ranks give. The net is rank places gained, so positive is better. A side with nobody going out has no ledger and so no rows; its seats are still reported.
function sideFrom(ledger, before, after, slots) {
    const rows = ((ledger && ledger.categories) || []).map(c => ({
        statId: c.id,
        before: c.before,
        after: c.after,
        // The raw after less before, with the scoring direction not applied. The ranks already account for direction, which is why the verdict counts ranks.
        delta: c.delta,
        rankBefore: c.rankBefore,
        rankAfter: c.rankAfter
    }));
    let up = 0;
    let down = 0;
    let net = 0;
    rows.forEach(r => {
        if (r.rankBefore === null || r.rankAfter === null) return;
        if (r.rankAfter < r.rankBefore) up += 1;
        else if (r.rankAfter > r.rankBefore) down += 1;
        net += r.rankBefore - r.rankAfter;
    });
    return {
        perCategory: rows,
        seats: seatsFor(before, after, slots),
        verdict: { categoriesUp: up, categoriesDown: down, netRankPlaces: net }
    };
}

// ==== The trade ====

/**
 * Prices a trade for both sides.
 *
 * @param {object} [args]
 * @param {object[]} args.mine My roster.
 * @param {object[]} args.theirs The other team's roster.
 * @param {Array} args.give The players or ids I send.
 * @param {Array} args.get The players or ids I receive.
 * @param {object} [ctx]
 * @param {object[]} [ctx.components] The sport's rate rules.
 * @param {Set<string>} [ctx.inverseIds] The categories where lower is better.
 * @param {Array<string|number>} [ctx.categoryIds] The scored categories.
 * @param {Object<string, object>} [ctx.sumsByTeam] Every team's component sums before the trade.
 * @param {number|string} [ctx.myTeamId] My team.
 * @param {number|string} [ctx.theirTeamId] The other team.
 * @param {Object<string, number>} [ctx.slots] How many of each position the league starts.
 * @param {function} [ctx.placeFrom] Turns every team's category values into a team's place.
 * @param {Object<string, number>} [ctx.banked] The team's component sums so far, passed to the ledger.
 * @returns {?{mine: TradeSide, theirs: TradeSide}} Both sides, or null when nobody named is on either roster.
 */
export function evaluateTrade({ mine, theirs, give, get } = {}, ctx = {}) {
    const {
        components = null, inverseIds = null, categoryIds = [], sumsByTeam = null,
        myTeamId = null, theirTeamId = null, slots = {}, placeFrom = null, banked = null
    } = ctx;
    const giving = resolve(mine, give);
    const getting = resolve(theirs, get);
    if (!giving.length && !getting.length) return null;

    const mineAfter = (mine || []).filter(p => giving.indexOf(p) === -1).concat(getting);
    const theirsAfter = (theirs || []).filter(p => getting.indexOf(p) === -1).concat(giving);

    // Both sides move at once. Each side's ranks after the trade are measured against the other side's roster after the trade, so the second map is built here and handed to both ledgers.
    const ids = idsToSum(categoryIds, components);
    const sumsByTeamAfter = { ...(sumsByTeam || {}) };
    if (myTeamId !== null) sumsByTeamAfter[String(myTeamId)] = sumPlayers(mineAfter, ids);
    if (theirTeamId !== null) sumsByTeamAfter[String(theirTeamId)] = sumPlayers(theirsAfter, ids);

    const engine = { components, inverseIds };
    const standings = { categoryIds, sumsByTeam, sumsByTeamAfter, placeFrom, banked };
    const myLedger = ledgerFor(mine, { out: giving, in: getting }, engine,
        { ...standings, teamId: myTeamId });
    const theirLedger = ledgerFor(theirs, { out: getting, in: giving }, engine,
        { ...standings, teamId: theirTeamId });

    return {
        mine: sideFrom(myLedger, mine, mineAfter, slots),
        theirs: sideFrom(theirLedger, theirs, theirsAfter, slots)
    };
}

// ==== The words ====

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A priced trade in words: what each side gains and loses in categories, how many rank places
 * each is better or worse off, and a warning for any position left below what the league starts.
 * It gives no percentage and no grade.
 *
 * @param {{mine: TradeSide, theirs: TradeSide}} result A result from evaluateTrade.
 * @returns {?{summary: string, places: string, warnings: string[]}} The sentences, or null for no result.
 */
export function fairness(result) {
    if (!result || !result.mine || !result.theirs) return null;
    const m = result.mine.verdict;
    const t = result.theirs.verdict;

    // The unit is named once a sentence, in the first half, and the second half is a bare count.
    const half = (v, who, noun) => `${who} gain ` +
        `${noun ? plural(v.categoriesUp, 'category', 'categories') : v.categoriesUp}` +
        ` and ${v.categoriesDown ? `lose ${v.categoriesDown}` : 'lose none'}`;
    const summary = `${half(m, 'You', true)}; ${half(t, 'they', false)}.`;

    const places = (v, who, are, noun) => {
        if (!v.netRankPlaces) return `${who} ${are} no better or worse off`;
        const n = Math.abs(v.netRankPlaces);
        const count = noun ? plural(n, 'rank place', 'rank places') : String(n);
        return `${who} ${are} ${count} ${v.netRankPlaces > 0 ? 'better' : 'worse off'}`;
    };

    // A position falling below what the league starts is what the category table hides. A warning states the fact and gives no advice.
    const warnings = [];
    [['You', result.mine], ['They', result.theirs]].forEach(([who, side]) => {
        Object.keys(side.seats || {}).forEach(pos => {
            const s = side.seats[pos];
            if (!s.slots || s.after >= s.slots || s.after >= s.before) return;
            warnings.push(s.after === 0
                ? `${who} would have no ${pos}, and your league starts ${s.slots}.`
                : `${who} would have ${s.after} ${pos} for ${s.slots} starting ${plural(s.slots, 'seat', 'seats').split(' ')[1]}.`);
        });
    });

    return {
        summary,
        places: `${places(m, 'You', 'are', true)}; ${places(t, 'they', 'are', false)}.`,
        warnings
    };
}
