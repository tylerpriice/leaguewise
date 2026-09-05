// PURE. The data behind My Team's CATEGORY COVERAGE band: where a roster stands in every scored category, which of its own players put it there, and - for the categories it is losing - who is available that would move it and who could be spared. No DOM, no AppState, no fetches; every table arrives as an argument, the rule rank-engine.js and preseason-face.js follow. WORDS AND COMPONENTS, NEVER ODDS (the owner's line). Nothing here estimates a probability. Every figure is either a real total, a real share of teams beaten, or an exact recomputation of what a figure WOULD be with one player added or removed - which for a rate means recomputing it from its components rather than pretending rates add up.

import { coverageOf, holesFrom } from './draft-engine.js';

// A rate is not a number you can add to. ERA is earned runs over innings, so a pitcher's effect on a team's ERA depends on both of its components and on the team's existing denominator - there is no single ERA to add in. RATE_COMPONENTS (state.js) carries the formula for every rate the sport scores, and it arrives here as an argument like every other table. Three shapes, all of them real entries in that table: a plain counting id with no spec at all, a num/den/scale rate (ERA = ER*9/IP), and an `add` rate assembled from other rates (OPS = OBP+SLG).
export function rateSpecFor(components, id) {
    return (components || []).find(c => String(c.out) === String(id)) || null;
}

// One category's value from a bag of component sums. A counting category is just its own sum; a rate is recomputed. Null rather than zero when the denominator is missing or empty, because a team with no innings has no ERA - and reading that as 0.00 would hand it the best in the league.
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

// Component sums across a set of players. Every id any category needs - the category itself for a counting stat, and both sides of the formula for a rate - so one pass answers everything.
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

// Every id the model has to sum: the categories themselves plus the components of any rate among them. Missing one component silently turns a rate into null, which reads as "no figure" when the truth is "we forgot to add it up".
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

// WHAT ONE PLAYER IS WORTH TO A CATEGORY, measured by taking that player out and recomputing. For a counting category that is exactly their own figure; for a rate it is the honest answer and the only one available, since a rate cannot be apportioned. Positive means the team is better WITH them, in the direction the category is scored - so an inverse category flips the sign, and a pitcher who lowers the team's ERA reads as a positive contribution rather than a negative one.
export function contributionOf(player, id, roster, ctx) {
    const { components, inverseIds } = ctx;
    const ids = idsToSum([id], components);
    const withHim = valueFrom(sumPlayers(roster, ids), id, components);
    const without = valueFrom(sumPlayers((roster || []).filter(p => p !== player), ids), id, components);
    if (withHim === null && without === null) return null;
    // Removing the last contributor leaves no figure at all - that contribution is the whole of it, which has no number, so it is reported as null rather than as the team total pretending to be a delta.
    if (without === null) return null;
    if (withHim === null) return null;
    const delta = withHim - without;
    return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
}

// The players who DRIVE a category, biggest contribution first. Only real, positive contributors - a bench bat who adds nothing to saves is not a driver of saves, and listing that row would pad the sentence the band is trying to write.
export function driversFor(roster, id, ctx, limit = 2) {
    return (roster || [])
        .map(p => ({ player: p, contribution: contributionOf(p, id, roster, ctx) }))
        .filter(d => d.contribution !== null && d.contribution > 0)
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, limit);
}

// WHAT A FREE AGENT WOULD MOVE, by adding the player and recomputing. Same measure as a contribution and deliberately so: "would add 9 saves" and "Witt is worth 14 of your steals" are then the same kind of statement, in the same units, and can be read against each other.
export function gainFrom(candidate, id, roster, ctx) {
    const { components, inverseIds } = ctx;
    const ids = idsToSum([id], components);
    const before = valueFrom(sumPlayers(roster, ids), id, components);
    const after = valueFrom(sumPlayers([...(roster || []), candidate], ids), id, components);
    if (after === null) return null;
    // A ROSTER THAT CANNOT MEASURE A CATEGORY HAS NONE OF IT, WHICH IS NOT THE SAME AS NO ANSWER. sumPlayers only creates a key for an id some roster player carries, so a team with no starting pitcher at all has no wins key, valueFrom returns null, and this returned null for EVERY candidate - the shopping list came back empty exactly when the first starting pitcher would have been the most valuable add a manager could make. The band then said nothing about the category it should have shouted about. Measured: a two-reliever roster carrying strikeouts and saves but no wins or quality starts scored a starter at K +33 and W null, QS null. The whole of his wins line was invisible. This is the same mistake cheapestSwap fixed on its own side and wrote down at length: an unmeasurable contribution is not a small one. There the answer was "that player is the whole of it"; here it is the mirror image - the roster holds NOTHING of it, so the baseline is zero and the candidate's own line is the entire gain. Zero is the right answer for a bag that is genuinely empty; it was only ever wrong as a stand-in for "cannot measure". A RATE IS LEFT ALONE. `after === null` above already refused the case where the candidate cannot be measured either, and a rate with no denominator on the roster has no zero to fall back to - "your team's ERA is 0.00 before this pitcher" is a worse lie than saying nothing. So this only rescues a COUNTING category, where an absent bag really does mean none.
    if (before === null) {
        if (rateSpecFor(components, id)) return null;
        const delta = after - 0;
        return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
    }
    const delta = after - before;
    return (inverseIds && inverseIds.has(String(id))) ? -delta : delta;
}

// THE SWAP IS DELIBERATELY NOT FILTERED FOR INJURY, and the reason is the whole difference between this function and the adds beside it. `adds` answers "who should you pick up", where naming an injured player is bad advice. This answers "who can you spare" - and an injured player is very often the right answer. Measured on the owner's league: one team's swap names a player on the ten-day list, which is correct counsel and would have been suppressed by a blanket filter. If anything the inflated remainder ESPN gives an injured player makes them look MORE expensive to drop than they are, so this function already under-names them. THE CHEAPEST PLAYER TO LOSE: the roster player who contributes least to the categories this team is WINNING. Not "the worst player" - a specialist who wins one category outright is expensive to drop even when doing nothing else, and a well-rounded player who is second-best at everything is cheap by this measure and would be a mistake to name. Cost is summed as SHARE of the team's own figure in each strong category, so categories on different scales can be added at all.
export function cheapestSwap(roster, strongIds, ctx) {
    const { components } = ctx;
    const costs = (roster || []).map(player => {
        let cost = 0;
        let measured = 0;
        let indispensable = false;
        (strongIds || []).forEach(id => {
            const ids = idsToSum([id], components);
            const team = valueFrom(sumPlayers(roster, ids), id, components);
            if (team === null) return;
            const without = valueFrom(sumPlayers((roster || []).filter(p => p !== player), ids), id, components);
            // THE ONLY ONE HOLDING IT. An unmeasurable contribution is not a small one: if dropping a player leaves the category with no figure at all, that player is the whole of it. Skipping them here - which is what "contribution is null, move on" did - made the sole hitter on a roster read as free to drop while alone carrying the batting average. The instrument said zero because it could not measure, and zero is the one answer that cannot be right.
            if (without === null) { indispensable = true; return; }
            const contribution = contributionOf(player, id, roster, ctx);
            if (contribution === null || team === 0) return;
            measured += 1;
            cost += Math.abs(contribution / team);
        });
        return { player, cost, measured, indispensable };
    }).filter(c => c.measured > 0 && !c.indispensable);
    if (!costs.length) return null;
    costs.sort((a, b) => a.cost - b.cost);
    return costs[0];
}

// The whole band. `sumsByTeam` is every team's own component sums (the caller builds it once from the league's rosters), `roster` this team's players, `available` the free agents worth ranking. A category with no share is carried with its nulls rather than dropped: "you have no figure here" is a fact about the roster the band should be able to say, and dropping the row would hide it. TWO BASES, AND WHICH SIDE EACH FIELD READS. The band used to answer with the season's actuals throughout, which made a player added today read as having produced a season's worth for this roster - the owner's own words about Schwarber, who on that league's capture has 40 home runs banked and 6 projected, over 134 games played and 21 to come. Both numbers were always in the payload; the band was reading the one that had already happened. THE ACTUALS decide WHERE THE TEAM STANDS: share, weak, value. That is a fact about the season so far and it is what the WINS/BLEEDS chips show, so it must not move. THE REMAINDER decides WHAT TO DO NEXT: projected, drivers, adds, swap. "Who would add the most home runs" is a question about games not yet played, and answering it with banked totals named a free agent for saves already recorded. `projectedRoster` and `projectedAvailable` are the SAME players carrying their projected remainder under `seasonTotals` - the caller normalises, exactly as it already does for the actuals basis, which is what keeps this module free of any opinion about where a line comes from. ONE BASIS IN, TODAY'S BEHAVIOUR OUT: omit them and every figure is computed from the actuals as before, with `projected` null. A null `projected` is the renderer's signal to fall back to `value`, which is what a caller that has not been updated will get.
export function coverageBand({
    sumsByTeam, teamId, roster, available = [], categoryIds, components, inverseIds,
    holeThreshold, driverLimit = 2, addLimit = 3,
    projectedRoster = null, projectedAvailable = null, window = null, searchIds = null
} = {}) {
    const ctx = { components, inverseIds };
    // The basis every FORWARD-LOOKING figure is computed from. Falling back to the actuals roster rather than to nothing keeps the single-basis caller working unchanged.
    const forwardRoster = projectedRoster || roster;
    const forwardAvailable = projectedAvailable || available;
    // EVERY TEAM'S CATEGORY VALUES, computed before the comparison. coverageOf reads a category straight off the bag it is handed, so handing it raw component sums made every RATE read as "no figure" for every team - a whole class of category silently absent from the band. The sums are components (a rate has no stored total), so they are turned into values here.
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
    // ONE swap for the whole band. It depends only on strongIds, so computing it per weak category returned the identical object every time at N-times the cost - roster x strong recomputations repeated for each hole, on a surface that already walks every player against every category. COSTED ON THE REMAINDER against the categories the actuals say are STRONG: "what you are winning" is a fact about the season so far, but "who can you spare" is about the games left, and a player whose production is already behind them is exactly the one to spare.
    const swap = strongIds.length ? cheapestSwap(forwardRoster, strongIds, ctx) : null;

    // The roster's projected component sums, computed ONCE rather than per category - every rate needs both its components, and idsToSum has already gathered every id any category will ask for. Null throughout when no projected basis was supplied.
    const forwardSums = projectedRoster
        ? sumPlayers(forwardRoster, idsToSum(categoryIds || [], components))
        : null;

    // WHICH ROWS GET A SHOPPING LIST. By default the holes, which is what this model has always done. `searchIds` ADDS to that set rather than replacing it, and the difference matters: a caller cannot pass "weak plus my own list", because `weak` is computed in here and does not exist until this function runs. Passing only its own ids and getting the union is the only shape a caller can actually use. WHY A CALLER WOULD ASK. The strip's "losing" is the BAND's rank (coverage-band.js's own `losingIds`), not this model's share-based `weak`, and the two genuinely differ - measured on the owner's league, wins and quality starts are losing by rank and not holes by share. The strip listed them as losing while this model had never looked for an add, and the renderer then said "no add found", naming a search that never happened. A manager wants an add for every category they are told they are losing, so the caller says which those are.
    const searched = (id) => holes.has(id) || !!(searchIds && searchIds.has(String(id)));

    const categories = coverage.map(c => {
        const weak = holes.has(c.id);
        const row = {
            id: c.id,
            value: c.value,
            share: c.share,
            weak,
            inverse: !!(inverseIds && inverseIds.has(String(c.id))),
            // RATE OR COUNTING, said rather than guessed. A surface has to know which to format and how to word a driver ("carries 13 of your 16" is nonsense for an average), and the only honest test is whether the league gave the category components - integer-ness is not it, since a team can sit on exactly 3.00 earned runs and 16 home runs is an integer either way. The model already asked this question to compute the value at all.
            rate: !!rateSpecFor(components, c.id),
            // THE REMAINDER, beside the actuals rather than instead of them. `value` still means what it always meant - the total the standing is computed from - so a renderer that has not read the amendment draws exactly what it drew before. A rate is REBUILT from its components here, never summed, by the same valueFrom the actuals side uses.
            projected: forwardSums ? valueFrom(forwardSums, c.id, components) : null,
            drivers: driversFor(forwardRoster, c.id, ctx, driverLimit),
            adds: [],
            swap: null
        };
        // Only a category the caller is going to SHOW as losing earns a shopping list. Naming adds for a category already won is noise, and the band's job is to say what to do next. `swap` stays on the WEAK rows alone, deliberately: it is one band-level fact repeated on every hole for the renderer's convenience, and broadening which rows carry it would change what `.find(r => r.swap)` picks up for no gain. Only the shopping list widens.
        if (searched(c.id)) {
            // MEASURED AGAINST THE REMAINDER, which is the correction this whole amendment exists for: a gain computed against banked totals named a reliever for saves already recorded. "Would add" is a claim about games not yet played, so it is measured on the roster and the candidate as they will be, not as they have been. A PLAYER MARKED `out` IS NEVER NAMED AS AN ADD. ESPN's rest-of-season projection does NOT discount an injured player - measured: a closer on the fifteen-day list projects the same six saves over ten innings as four healthy closers, and the single highest projected save-getter in the whole pool is on the SIXTY-day list, credited with 69 innings he cannot throw. So the remainder this model is handed is untrue for those players, and nothing here can compute its way out of that. What it can do is decline to name them. THE CALLER DECIDES WHAT `out` MEANS, because this module has no ESPN knowledge and must not grow any; myteam.js sets it from matchup-difficulty.js's own isSidelined, which already answers this question for the offence model and keeps DAY_TO_DAY IN. The remainder itself is untouched - still ESPN's own figure, unscaled. This is a filter on WHO IS NAMED, never an adjustment to what they are worth.
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

    // The window travels with the band so the renderer says "the rest of the way" or "this matchup" from a field rather than inferring a horizon from the size of the numbers. Null when the caller supplied no projected basis, which is the same state `projected: null` reports.
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
